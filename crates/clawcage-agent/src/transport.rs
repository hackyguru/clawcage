// Transport layer for guest-side Clawcage agents.
//
// Supports two modes, both returning a plain RawFd so downstream agent code
// works unchanged (read/write syscalls are identical across socket families):
//
//   - Vsock: connects to host CID over AF_VSOCK (local mode, the Mac's
//     Virtualization.framework VM). Default.
//   - Tcp: connects to a TCP host (remote mode, when the agents run on a
//     Hetzner CAX11 or equivalent bare-host environment).
//
// Mode selection via env, read once per process by TransportMode::from_env():
//   CLAWCAGE_TRANSPORT = "vsock" (default) | "tcp"
//   CLAWCAGE_HOST      = <host>  (used when transport=tcp; defaults to 127.0.0.1)
//
// TLS is planned as a future wrapper on top of Tcp. It will require replacing
// RawFd with a Connection enum because rustls holds per-session state that
// cannot be represented as a raw fd.
//
// Included into each binary crate via `#[path = "transport.rs"] mod transport;`.
#![allow(dead_code)]

use std::io;
use std::net::{TcpStream, ToSocketAddrs};
use std::os::unix::io::{IntoRawFd, RawFd};
use std::thread;
use std::time::Duration;

use nix::libc;

/// Host CID (always 2 for the hypervisor).
pub const VSOCK_HOST_CID: u32 = 2;
/// AF_VSOCK address family.
pub const AF_VSOCK: i32 = 40;

#[repr(C)]
pub struct SockaddrVm {
    pub svm_family: libc::sa_family_t,
    pub svm_reserved1: u16,
    pub svm_port: u32,
    pub svm_cid: u32,
    pub svm_flags: u8,
    pub svm_zero: [u8; 3],
}

/// Transport mode for connecting to the host.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TransportMode {
    /// Local mode: vsock to the macOS Virtualization.framework host.
    Vsock { host_cid: u32 },
    /// Remote mode: plain TCP to a bare Linux host (e.g. Hetzner CAX11).
    /// TLS wrapping will be added later; this is the raw-fd stepping stone.
    Tcp { host: String },
}

impl TransportMode {
    /// Parse a mode from explicit strings. Pure helper, used by from_env and tests.
    /// Unknown transport values fall back to Vsock (fail-safe for local).
    pub fn parse(transport: Option<&str>, host: Option<&str>) -> Self {
        match transport.map(str::trim) {
            Some("tcp") => Self::Tcp {
                host: host.map(str::trim).filter(|s| !s.is_empty())
                    .unwrap_or("127.0.0.1").to_string(),
            },
            _ => Self::Vsock { host_cid: VSOCK_HOST_CID },
        }
    }

    /// Read mode from CLAWCAGE_TRANSPORT and CLAWCAGE_HOST env vars.
    pub fn from_env() -> Self {
        let transport = std::env::var("CLAWCAGE_TRANSPORT").ok();
        let host = std::env::var("CLAWCAGE_HOST").ok();
        Self::parse(transport.as_deref(), host.as_deref())
    }

    /// Human-readable label for logging.
    pub fn label(&self) -> String {
        match self {
            Self::Vsock { host_cid } => format!("vsock(cid={host_cid})"),
            Self::Tcp { host } => format!("tcp({host})"),
        }
    }
}

/// Connect to `port` using the configured transport. Returns a RawFd that is
/// indistinguishable from a vsock fd for the purposes of read/write syscalls.
pub fn connect(mode: &TransportMode, port: u32) -> io::Result<RawFd> {
    match mode {
        TransportMode::Vsock { host_cid } => vsock_connect(*host_cid, port),
        TransportMode::Tcp { host } => tcp_connect(host, port as u16),
    }
}

/// Connect with exponential backoff retry (100ms -> 2000ms cap). Blocks forever.
pub fn connect_retry(mode: &TransportMode, port: u32, label: &str) -> RawFd {
    let mut delay_ms = 100u64;
    loop {
        match connect(mode, port) {
            Ok(fd) => {
                eprintln!(
                    "[clawcage-agent] {label} connected (port {port}, {})",
                    mode.label()
                );
                return fd;
            }
            Err(e) => {
                eprintln!(
                    "[clawcage-agent] {label} connect failed: {e}, retrying in {delay_ms}ms"
                );
                thread::sleep(Duration::from_millis(delay_ms));
                delay_ms = (delay_ms * 2).min(2000);
            }
        }
    }
}

/// Connect to a vsock port on the given CID. Low-level primitive.
pub fn vsock_connect(cid: u32, port: u32) -> io::Result<RawFd> {
    let fd = unsafe { libc::socket(AF_VSOCK, libc::SOCK_STREAM, 0) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }

    let addr = SockaddrVm {
        svm_family: AF_VSOCK as libc::sa_family_t,
        svm_reserved1: 0,
        svm_port: port,
        svm_cid: cid,
        svm_flags: 0,
        svm_zero: [0; 3],
    };

    let ret = unsafe {
        libc::connect(
            fd,
            &addr as *const SockaddrVm as *const libc::sockaddr,
            std::mem::size_of::<SockaddrVm>() as libc::socklen_t,
        )
    };
    if ret < 0 {
        let err = io::Error::last_os_error();
        unsafe { libc::close(fd); }
        return Err(err);
    }

    Ok(fd)
}

/// Connect to a vsock port with exponential backoff retry. Legacy wrapper
/// kept so existing call sites compile unchanged; prefer `connect_retry`.
pub fn vsock_connect_retry(cid: u32, port: u32, label: &str) -> RawFd {
    connect_retry(&TransportMode::Vsock { host_cid: cid }, port, label)
}

/// Connect to a TCP host:port. 5s connect timeout, TCP_NODELAY set.
/// The returned fd is owned by the caller (use libc::close or read_exact_fd's
/// UnexpectedEof path to clean up).
pub fn tcp_connect(host: &str, port: u16) -> io::Result<RawFd> {
    let addr = (host, port)
        .to_socket_addrs()?
        .next()
        .ok_or_else(|| io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("no address resolved for {host}:{port}"),
        ))?;
    let stream = TcpStream::connect_timeout(&addr, Duration::from_secs(5))?;
    stream.set_nodelay(true)?;
    Ok(stream.into_raw_fd())
}

/// Write all bytes to an fd, retrying on partial writes.
pub fn write_all_fd(fd: RawFd, data: &[u8]) -> io::Result<()> {
    let mut written = 0;
    while written < data.len() {
        match nix::unistd::write(
            unsafe { std::os::unix::io::BorrowedFd::borrow_raw(fd) },
            &data[written..],
        ) {
            Ok(n) => written += n,
            Err(nix::errno::Errno::EINTR) => continue,
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}

/// Read exactly `buf.len()` bytes from an fd, retrying on partial reads.
pub fn read_exact_fd(fd: RawFd, buf: &mut [u8]) -> io::Result<()> {
    let mut pos = 0;
    while pos < buf.len() {
        match nix::unistd::read(fd, &mut buf[pos..]) {
            Ok(0) => {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "unexpected EOF",
                ))
            }
            Ok(n) => pos += n,
            Err(nix::errno::Errno::EINTR) => continue,
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::os::unix::io::IntoRawFd;
    use std::os::unix::net::UnixStream;

    // --- TransportMode::parse ---

    #[test]
    fn parse_defaults_to_vsock_when_transport_unset() {
        let mode = TransportMode::parse(None, None);
        assert_eq!(mode, TransportMode::Vsock { host_cid: VSOCK_HOST_CID });
    }

    #[test]
    fn parse_returns_vsock_for_unknown_transport() {
        // Fail-safe: unrecognized values shouldn't accidentally flip remote mode.
        let mode = TransportMode::parse(Some("udp"), None);
        assert_eq!(mode, TransportMode::Vsock { host_cid: VSOCK_HOST_CID });
    }

    #[test]
    fn parse_returns_vsock_for_explicit_vsock() {
        let mode = TransportMode::parse(Some("vsock"), None);
        assert_eq!(mode, TransportMode::Vsock { host_cid: VSOCK_HOST_CID });
    }

    #[test]
    fn parse_returns_tcp_with_default_host() {
        let mode = TransportMode::parse(Some("tcp"), None);
        assert_eq!(mode, TransportMode::Tcp { host: "127.0.0.1".into() });
    }

    #[test]
    fn parse_returns_tcp_with_explicit_host() {
        let mode = TransportMode::parse(Some("tcp"), Some("10.0.0.5"));
        assert_eq!(mode, TransportMode::Tcp { host: "10.0.0.5".into() });
    }

    #[test]
    fn parse_trims_whitespace_on_transport_and_host() {
        let mode = TransportMode::parse(Some(" tcp "), Some(" example.internal "));
        assert_eq!(mode, TransportMode::Tcp { host: "example.internal".into() });
    }

    #[test]
    fn parse_empty_host_falls_back_to_localhost() {
        // Empty string shouldn't silently become ":<port>" which resolves oddly.
        let mode = TransportMode::parse(Some("tcp"), Some(""));
        assert_eq!(mode, TransportMode::Tcp { host: "127.0.0.1".into() });
    }

    #[test]
    fn label_includes_useful_diagnostics() {
        assert!(TransportMode::Vsock { host_cid: 2 }.label().contains("vsock"));
        assert!(TransportMode::Tcp { host: "h".into() }.label().contains("tcp"));
        assert!(TransportMode::Tcp { host: "h".into() }.label().contains('h'));
    }

    // --- tcp_connect ---

    #[test]
    fn tcp_connect_succeeds_against_local_listener_and_transfers_bytes() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();

        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket.write_all(b"pong").unwrap();
            let mut buf = [0u8; 4];
            socket.read_exact(&mut buf).unwrap();
            assert_eq!(&buf, b"ping");
        });

        let fd = tcp_connect("127.0.0.1", port).expect("tcp_connect should succeed");
        let mut pong = [0u8; 4];
        read_exact_fd(fd, &mut pong).unwrap();
        assert_eq!(&pong, b"pong");
        write_all_fd(fd, b"ping").unwrap();
        unsafe { libc::close(fd); }
        server.join().unwrap();
    }

    #[test]
    fn tcp_connect_fails_fast_on_refused_port() {
        // bind then immediately drop to get a guaranteed-refused port.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let result = tcp_connect("127.0.0.1", port);
        assert!(result.is_err(), "connect to closed port should fail");
    }

    #[test]
    fn tcp_connect_returns_invalid_input_for_unresolvable_host() {
        let result = tcp_connect("", 443);
        assert!(result.is_err());
    }

    // --- connect dispatches correctly ---

    #[test]
    fn connect_tcp_mode_dispatches_to_tcp() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let mode = TransportMode::Tcp { host: "127.0.0.1".into() };

        let server = thread::spawn(move || {
            let _ = listener.accept().unwrap();
        });
        let fd = connect(&mode, port as u32).unwrap();
        unsafe { libc::close(fd); }
        server.join().unwrap();
    }

    // --- existing vsock tests (preserved) ---

    #[test]
    fn test_vsock_connect_fails_gracefully_on_host() {
        // AF_VSOCK is likely not supported or no device exists on the test host.
        let result = vsock_connect(VSOCK_HOST_CID, 9999);
        assert!(result.is_err(), "vsock connect should fail on macOS/host machines gracefully");
    }

    #[test]
    fn test_read_write_exact_fd() {
        let (client, server) = UnixStream::pair().unwrap();
        let client_fd = client.into_raw_fd();
        let server_fd = server.into_raw_fd();

        let data = b"hello vsock_io world";
        write_all_fd(client_fd, data).expect("failed to write_all_fd");

        let mut buf = vec![0u8; data.len()];
        read_exact_fd(server_fd, &mut buf).expect("failed to read_exact_fd");
        assert_eq!(&buf, data);

        unsafe { libc::close(client_fd); }
        let mut small_buf = [0u8; 1];
        let eof_res = read_exact_fd(server_fd, &mut small_buf);
        assert!(eof_res.is_err());
        assert_eq!(eof_res.unwrap_err().kind(), std::io::ErrorKind::UnexpectedEof);

        unsafe { libc::close(server_fd); }
    }
}
