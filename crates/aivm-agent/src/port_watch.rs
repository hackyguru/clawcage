#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

// aivm-port-watch: In-VM port watcher daemon.
//
// Polls /proc/net/tcp and /proc/net/tcp6 for listening TCP sockets and streams
// port-open/port-close events to the host over vsock port 5006 as GuestToHost
// messages. Also acts as a port-forwarding relay: listens on vsock port 5007
// for incoming host connections that request forwarding to a guest-local port.
//
// This binary runs inside the guest VM, launched by aivm-init.

#[path = "vsock_io.rs"]
mod vsock_io;

use std::collections::HashMap;

/// vsock port for port-watch events on the host.
#[cfg(target_os = "linux")]
const VSOCK_PORT_PORT_WATCH: u32 = 5006;

/// vsock port for port-forwarding relay (host connects to guest).
#[cfg(target_os = "linux")]
const VSOCK_PORT_PORT_FORWARD: u32 = 5007;

/// Polling interval for /proc/net/tcp scanning.
const POLL_INTERVAL_MS: u64 = 1000;

/// Ports that are internal infrastructure and should be hidden from the user.
const HIDDEN_PORTS: &[u16] = &[10443]; // aivm-net-proxy listen port

// ── Pure helpers (testable on macOS) ─────────────────────────────────

/// A parsed listening socket entry from /proc/net/tcp.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ListeningPort {
    port: u16,
    inode: u64,
}

/// Parse a single line from /proc/net/tcp or /proc/net/tcp6.
/// Returns Some(ListeningPort) if the socket is in LISTEN state (0A).
fn parse_proc_net_tcp_line(line: &str) -> Option<ListeningPort> {
    let fields: Vec<&str> = line.split_whitespace().collect();
    if fields.len() < 10 {
        return None;
    }

    // Field 3 (0-indexed) is the state: "0A" = LISTEN
    let state = fields[3];
    if state != "0A" {
        return None;
    }

    // Field 1 is local_address: "XXXXXXXX:PORT" (hex)
    let local_addr = fields[1];
    let port_hex = local_addr.rsplit(':').next()?;
    let port = u16::from_str_radix(port_hex, 16).ok()?;

    // Field 9 is the inode
    let inode = fields[9].parse::<u64>().ok()?;

    if HIDDEN_PORTS.contains(&port) {
        return None;
    }

    Some(ListeningPort { port, inode })
}

/// Parse all listening ports from /proc/net/tcp content.
fn parse_proc_net_tcp(content: &str) -> Vec<ListeningPort> {
    content
        .lines()
        .skip(1) // skip header
        .filter_map(parse_proc_net_tcp_line)
        .collect()
}

/// Deduplicate by port (tcp and tcp6 may both report the same port).
fn dedup_ports(ports: Vec<ListeningPort>) -> Vec<ListeningPort> {
    let mut seen = HashMap::new();
    for p in ports {
        seen.entry(p.port).or_insert(p);
    }
    seen.into_values().collect()
}

/// Resolve PID for a socket inode by scanning /proc/<pid>/fd/.
#[cfg(target_os = "linux")]
fn resolve_pid_for_inode(inode: u64) -> Option<(u32, String)> {
    let target = format!("socket:[{inode}]");
    let proc_dir = match std::fs::read_dir("/proc") {
        Ok(d) => d,
        Err(_) => return None,
    };

    for entry in proc_dir.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        let pid: u32 = match name_str.parse() {
            Ok(p) => p,
            Err(_) => continue,
        };

        let fd_dir = format!("/proc/{pid}/fd");
        if let Ok(fds) = std::fs::read_dir(&fd_dir) {
            for fd_entry in fds.flatten() {
                if let Ok(link) = std::fs::read_link(fd_entry.path()) {
                    if link.to_string_lossy() == target {
                        // Read the process name from /proc/<pid>/comm
                        let comm = std::fs::read_to_string(format!("/proc/{pid}/comm"))
                            .unwrap_or_default()
                            .trim()
                            .to_string();
                        return Some((pid, comm));
                    }
                }
            }
        }
    }
    None
}

// ── Port watcher (Linux only) ────────────────────────────────────────

#[cfg(target_os = "linux")]
fn run_watcher() {
    use aivm_proto::{GuestToHost, encode_guest_msg};
    use vsock_io::{VSOCK_HOST_CID, vsock_connect_retry, write_all_fd};
    use std::os::unix::io::RawFd;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    eprintln!("[aivm-port-watch] starting (pid {})", std::process::id());

    let vsock_fd = vsock_connect_retry(VSOCK_HOST_CID, VSOCK_PORT_PORT_WATCH, "port-watch");

    // Track known listening ports: port -> (pid, process_name)
    let mut known: HashMap<u16, (u32, String)> = HashMap::new();

    // Set up signal handler for graceful shutdown
    let term_now = Arc::new(AtomicBool::new(false));
    for sig in &[
        signal_hook::consts::SIGTERM,
        signal_hook::consts::SIGINT,
        signal_hook::consts::SIGQUIT,
    ] {
        signal_hook::flag::register(*sig, Arc::clone(&term_now)).expect("register signal");
    }

    fn send_event(fd: RawFd, msg: &GuestToHost) {
        match encode_guest_msg(msg) {
            Ok(frame) => {
                if let Err(e) = write_all_fd(fd, &frame) {
                    eprintln!("[aivm-port-watch] write failed: {e}");
                }
            }
            Err(e) => {
                eprintln!("[aivm-port-watch] encode failed: {e}");
            }
        }
    }

    loop {
        if term_now.load(Ordering::Relaxed) {
            eprintln!("[aivm-port-watch] received termination signal, exiting");
            break;
        }

        // Read /proc/net/tcp and /proc/net/tcp6
        let tcp = std::fs::read_to_string("/proc/net/tcp").unwrap_or_default();
        let tcp6 = std::fs::read_to_string("/proc/net/tcp6").unwrap_or_default();

        let mut current_ports = parse_proc_net_tcp(&tcp);
        current_ports.extend(parse_proc_net_tcp(&tcp6));
        let current_ports = dedup_ports(current_ports);

        let current_set: HashMap<u16, &ListeningPort> =
            current_ports.iter().map(|p| (p.port, p)).collect();

        // Detect new ports
        for lp in &current_ports {
            if !known.contains_key(&lp.port) {
                let (pid, process) = resolve_pid_for_inode(lp.inode)
                    .unwrap_or((0, "unknown".to_string()));
                eprintln!("[aivm-port-watch] port opened: {} (pid={pid}, process={process})", lp.port);
                send_event(vsock_fd, &GuestToHost::PortOpened {
                    port: lp.port,
                    pid,
                    process: process.clone(),
                });
                known.insert(lp.port, (pid, process));
            }
        }

        // Detect closed ports
        let closed: Vec<u16> = known
            .keys()
            .filter(|p| !current_set.contains_key(p))
            .copied()
            .collect();
        for port in closed {
            eprintln!("[aivm-port-watch] port closed: {port}");
            send_event(vsock_fd, &GuestToHost::PortClosed { port });
            known.remove(&port);
        }

        std::thread::sleep(std::time::Duration::from_millis(POLL_INTERVAL_MS));
    }
}

// ── Port-forwarding relay (Linux only) ────────────────────────────────

/// Number of relay threads that continuously offer bridge connections.
#[cfg(target_os = "linux")]
const RELAY_THREAD_COUNT: usize = 4;

/// Run a single relay worker: connect to host vsock port 5007, read
/// a 2-byte BE target port, connect to localhost:port in the guest,
/// and bridge bidirectionally. Loops forever.
#[cfg(target_os = "linux")]
fn relay_worker(id: usize) {
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use vsock_io::{VSOCK_HOST_CID, vsock_connect, read_exact_fd, write_all_fd};

    loop {
        // Connect to host port-forward relay port.
        let vsock_fd = match vsock_connect(VSOCK_HOST_CID, VSOCK_PORT_PORT_FORWARD) {
            Ok(fd) => fd,
            Err(e) => {
                eprintln!("[relay-{id}] vsock connect failed: {e}, retrying in 1s");
                std::thread::sleep(std::time::Duration::from_secs(1));
                continue;
            }
        };

        // Read 2-byte BE target port from host.
        let mut port_buf = [0u8; 2];
        if let Err(e) = read_exact_fd(vsock_fd, &mut port_buf) {
            eprintln!("[relay-{id}] failed to read target port: {e}");
            unsafe { nix::libc::close(vsock_fd); }
            continue;
        }
        let target_port = u16::from_be_bytes(port_buf);
        eprintln!("[relay-{id}] forwarding to localhost:{target_port}");

        // Connect to the target port inside the guest.
        let mut tcp_stream = match TcpStream::connect(("127.0.0.1", target_port)) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[relay-{id}] TCP connect to localhost:{target_port} failed: {e}");
                unsafe { nix::libc::close(vsock_fd); }
                continue;
            }
        };
        let _ = tcp_stream.set_nodelay(true);

        // Bidirectional bridge: vsock <-> TCP.
        // Use two threads: one for each direction.
        let tcp_clone = match tcp_stream.try_clone() {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[relay-{id}] TCP clone failed: {e}");
                unsafe { nix::libc::close(vsock_fd); }
                continue;
            }
        };

        // vsock -> TCP direction
        let vsock_fd_copy = vsock_fd;
        let join_v2t = std::thread::spawn(move || {
            let mut tcp = tcp_clone;
            let mut buf = [0u8; 65536];
            loop {
                match nix::unistd::read(vsock_fd_copy, &mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if tcp.write_all(&buf[..n]).is_err() {
                            break;
                        }
                    }
                    Err(nix::errno::Errno::EINTR) => continue,
                    Err(_) => break,
                }
            }
            let _ = tcp.shutdown(std::net::Shutdown::Write);
        });

        // TCP -> vsock direction (this thread)
        {
            let mut buf = [0u8; 65536];
            loop {
                match tcp_stream.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if write_all_fd(vsock_fd, &buf[..n]).is_err() {
                            break;
                        }
                    }
                    Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
        }

        let _ = join_v2t.join();
        unsafe { nix::libc::close(vsock_fd); }
    }
}

/// Spawn relay worker threads for port forwarding.
#[cfg(target_os = "linux")]
fn start_relay_workers() {
    for i in 0..RELAY_THREAD_COUNT {
        std::thread::spawn(move || relay_worker(i));
    }
    eprintln!("[aivm-port-watch] started {RELAY_THREAD_COUNT} relay workers");
}

#[cfg(not(target_os = "linux"))]
fn run_watcher() {
    eprintln!("[aivm-port-watch] /proc/net/tcp not available on this platform");
    std::process::exit(1);
}

fn main() {
    #[cfg(target_os = "linux")]
    start_relay_workers();

    run_watcher();
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_PROC_NET_TCP: &str = "\
  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12345 1 0000000000000000 100 0 0 10 0
   1: 0100007F:28C3 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12346 1 0000000000000000 100 0 0 10 0
   2: 0100007F:1F90 0100007F:C350 01 00000000:00000000 00:00000000 00000000     0        0 12347 1 0000000000000000 100 0 0 10 0
   3: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12348 1 0000000000000000 100 0 0 10 0
   4: 00000000:28C3 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12349 1 0000000000000000 100 0 0 10 0";

    #[test]
    fn parse_proc_net_tcp_finds_listeners() {
        let ports = parse_proc_net_tcp(SAMPLE_PROC_NET_TCP);
        // Lines 0, 1, 3, 4 are LISTEN (0A). Line 2 is ESTABLISHED (01).
        assert_eq!(ports.len(), 4);
        let port_nums: Vec<u16> = ports.iter().map(|p| p.port).collect();
        assert!(port_nums.contains(&0x0BB8)); // 3000
        assert!(port_nums.contains(&0x28C3)); // 10435
        assert!(port_nums.contains(&0x1F90)); // 8080
    }

    #[test]
    fn parse_proc_net_tcp_skips_established() {
        let ports = parse_proc_net_tcp(SAMPLE_PROC_NET_TCP);
        // Line 2 has state 01 (ESTABLISHED), port 8080 -- but there's also
        // a LISTEN entry for 8080 on line 3.
        let established_only = ports.iter().filter(|p| p.port == 0x1F90).count();
        assert_eq!(established_only, 1); // only the LISTEN entry
    }

    #[test]
    fn parse_proc_net_tcp_empty_input() {
        assert!(parse_proc_net_tcp("").is_empty());
    }

    #[test]
    fn parse_proc_net_tcp_header_only() {
        let header = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
        assert!(parse_proc_net_tcp(header).is_empty());
    }

    #[test]
    fn parse_proc_net_tcp_malformed_line() {
        let content = "header\ngarbage data here";
        assert!(parse_proc_net_tcp(content).is_empty());
    }

    #[test]
    fn parse_proc_net_tcp_line_extracts_port_and_inode() {
        let line = "   0: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12345 1 0000000000000000 100 0 0 10 0";
        let lp = parse_proc_net_tcp_line(line).unwrap();
        assert_eq!(lp.port, 3000); // 0x0BB8
        assert_eq!(lp.inode, 12345);
    }

    #[test]
    fn parse_proc_net_tcp_line_rejects_non_listen() {
        let line = "   2: 0100007F:1F90 0100007F:C350 01 00000000:00000000 00:00000000 00000000     0        0 12347 1 0000000000000000 100 0 0 10 0";
        assert!(parse_proc_net_tcp_line(line).is_none());
    }

    #[test]
    fn hidden_port_10443_is_filtered() {
        let line = "   0: 00000000:28C3 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 99999 1 0000000000000000 100 0 0 10 0";
        // 0x28C3 = 10435, not hidden
        assert!(parse_proc_net_tcp_line(line).is_some());

        // 10443 = 0x28CB
        let line_hidden = "   0: 00000000:28CB 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 99999 1 0000000000000000 100 0 0 10 0";
        assert!(parse_proc_net_tcp_line(line_hidden).is_none());
    }

    #[test]
    fn dedup_ports_removes_duplicates() {
        let ports = vec![
            ListeningPort { port: 3000, inode: 100 },
            ListeningPort { port: 3000, inode: 200 }, // duplicate port, different inode (tcp6)
            ListeningPort { port: 8080, inode: 300 },
        ];
        let deduped = dedup_ports(ports);
        assert_eq!(deduped.len(), 2);
        let port_nums: Vec<u16> = deduped.iter().map(|p| p.port).collect();
        assert!(port_nums.contains(&3000));
        assert!(port_nums.contains(&8080));
    }

    #[test]
    fn dedup_ports_empty() {
        assert!(dedup_ports(vec![]).is_empty());
    }

    #[test]
    fn parse_proc_net_tcp6_line() {
        // tcp6 has longer addresses but same field layout
        let line = "   0: 00000000000000000000000000000000:0CEA 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 55555 1 0000000000000000 100 0 0 10 0";
        let lp = parse_proc_net_tcp_line(line).unwrap();
        assert_eq!(lp.port, 0x0CEA); // 3306 (MySQL)
        assert_eq!(lp.inode, 55555);
    }

    #[test]
    fn parse_port_zero_is_valid() {
        let line = "   0: 00000000:0000 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 11111 1 0000000000000000 100 0 0 10 0";
        let lp = parse_proc_net_tcp_line(line).unwrap();
        assert_eq!(lp.port, 0);
    }

    #[test]
    fn parse_high_port() {
        // Port 65535 = 0xFFFF
        let line = "   0: 00000000:FFFF 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 22222 1 0000000000000000 100 0 0 10 0";
        let lp = parse_proc_net_tcp_line(line).unwrap();
        assert_eq!(lp.port, 65535);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn port_constants() {
        assert_eq!(VSOCK_PORT_PORT_WATCH, 5006);
        assert_eq!(VSOCK_PORT_PORT_FORWARD, 5007);
    }
}
