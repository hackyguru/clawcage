// aivm-pty-agent: Guest-side multi-shell PTY-over-vsock bridge.
//
// Runs inside the Linux VM as a child of aivm-init. Manages multiple PTY
// sessions multiplexed over two vsock connections:
//   - Port 5001: framed PTY I/O [4B len][4B session_id][data]
//   - Port 5000: control messages (resize, heartbeat, boot config, shell mgmt)
//
// Session 0 is the default shell created at boot. Additional shells are
// created/destroyed via SpawnShell/CloseShell control messages.

#[path = "vsock_io.rs"]
mod vsock_io;

use std::collections::HashMap;
use std::io::{self, Write as _};
use std::os::unix::io::{AsRawFd, RawFd};
use std::process;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;

use aivm_proto::{
    GuestToHost, HostToGuest, MAX_FRAME_SIZE, decode_host_msg, encode_guest_msg,
    encode_terminal_frame, DEFAULT_SHELL_SESSION_ID, TERMINAL_FRAME_HEADER_SIZE,
    validate_env_key, validate_env_value, validate_file_path,
    MAX_BOOT_ENV_VARS, MAX_BOOT_FILES, MAX_BOOT_FILE_BYTES,
};
use nix::libc;
use nix::poll::{PollFd, PollFlags, PollTimeout, poll};
use nix::pty::openpty;
use nix::sys::signal::{SigHandler, Signal, signal};
use nix::unistd::{ForkResult, Pid, close, dup2, execvp, fork, setsid};

use vsock_io::{VSOCK_HOST_CID, read_exact_fd, vsock_connect_retry, write_all_fd};

/// vsock port for control messages.
const VSOCK_PORT_CONTROL: u32 = 5000;
/// vsock port for terminal data.
const VSOCK_PORT_TERMINAL: u32 = 5001;
/// Boot log persisted so it can be inspected after boot (`cat /var/log/aivm-boot.log`).
const BOOT_LOG_PATH: &str = "/var/log/aivm-boot.log";

// ---------------------------------------------------------------------------
// Control message framing (using aivm-proto types)
// ---------------------------------------------------------------------------

fn send_guest_msg(fd: RawFd, msg: &GuestToHost) -> io::Result<()> {
    let frame = encode_guest_msg(msg)
        .map_err(io::Error::other)?;
    write_all_fd(fd, &frame)?;
    Ok(())
}

fn recv_host_msg(fd: RawFd) -> io::Result<HostToGuest> {
    let mut len_buf = [0u8; 4];
    read_exact_fd(fd, &mut len_buf)?;
    let len = u32::from_be_bytes(len_buf) as usize;
    if len > MAX_FRAME_SIZE as usize {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "control frame too large"));
    }
    let mut payload = vec![0u8; len];
    read_exact_fd(fd, &mut payload)?;
    decode_host_msg(&payload)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}

// ---------------------------------------------------------------------------
// Clock sync
// ---------------------------------------------------------------------------

fn set_system_clock(epoch_secs: u64) {
    let ts = libc::timespec {
        tv_sec: epoch_secs as _,
        tv_nsec: 0,
    };
    let ret = unsafe { libc::clock_settime(libc::CLOCK_REALTIME, &ts) };
    if ret == 0 {
        eprintln!("[aivm-agent] clock set to epoch {epoch_secs}");
    } else {
        eprintln!(
            "[aivm-agent] WARNING: clock_settime failed ({}): \
             agent must run as root with CAP_SYS_TIME",
            std::io::Error::last_os_error()
        );
    }
}

// ---------------------------------------------------------------------------
// PTY resize
// ---------------------------------------------------------------------------

fn set_winsize(master_fd: RawFd, cols: u16, rows: u16) {
    let ws = libc::winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    unsafe {
        libc::ioctl(master_fd, libc::TIOCSWINSZ, &ws);
    }
}

// ---------------------------------------------------------------------------
// Boot log -- persists at /var/log/aivm-boot.log for post-boot diagnosis
// ---------------------------------------------------------------------------

fn open_boot_log() -> std::fs::File {
    // Ensure /var/log exists (may be tmpfs).
    let _ = std::fs::create_dir_all("/var/log");
    std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(BOOT_LOG_PATH)
        .unwrap_or_else(|_| {
            // Fallback: /tmp is always writable.
            std::fs::OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(true)
                .open("/tmp/aivm-boot.log")
                .expect("cannot open boot log")
        })
}

fn blog_line(log: &mut std::fs::File, msg: &str) {
    let _ = writeln!(log, "{msg}");
    eprintln!("[aivm-agent] {msg}");
}

// ---------------------------------------------------------------------------
// Shell management
// ---------------------------------------------------------------------------

/// Maximum concurrent shells per VM.
const MAX_SHELLS: usize = 16;

/// A PTY shell session.
struct Shell {
    session_id: u32,
    master_fd: RawFd,
    child_pid: Pid,
}

/// Thread-safe shell manager.
struct ShellManager {
    shells: Mutex<HashMap<u32, Shell>>,
}

impl ShellManager {
    fn new() -> Self {
        Self {
            shells: Mutex::new(HashMap::new()),
        }
    }

    fn count(&self) -> usize {
        self.shells.lock().unwrap().len()
    }

    fn insert(&self, shell: Shell) {
        self.shells.lock().unwrap().insert(shell.session_id, shell);
    }

    fn remove(&self, session_id: u32) -> Option<Shell> {
        self.shells.lock().unwrap().remove(&session_id)
    }

    fn get_master_fd(&self, session_id: u32) -> Option<RawFd> {
        self.shells.lock().unwrap().get(&session_id).map(|s| s.master_fd)
    }

    /// Collect (session_id, master_fd) pairs for polling.
    fn fd_snapshot(&self) -> Vec<(u32, RawFd)> {
        self.shells.lock().unwrap().iter().map(|(&id, s)| (id, s.master_fd)).collect()
    }
}

/// Spawn a new shell session. Creates a PTY pair, forks bash, returns the Shell.
/// `boot_env` is applied to the child environment (only relevant for the default shell,
/// but applied uniformly for consistency).
fn spawn_shell(session_id: u32, cols: u16, rows: u16, boot_env: &[(String, String)]) -> io::Result<Shell> {
    let pty = openpty(None, None).map_err(|e| io::Error::new(io::ErrorKind::Other, e))?;
    let master_fd = pty.master.as_raw_fd();
    let slave_fd = pty.slave.as_raw_fd();
    set_winsize(master_fd, cols, rows);

    match unsafe { fork() } {
        Ok(ForkResult::Child) => {
            // Close master in child.
            drop(pty.master);

            // Create a new session so the slave PTY becomes the controlling terminal.
            setsid().expect("setsid failed");

            // Set the slave as the controlling terminal.
            unsafe {
                libc::ioctl(slave_fd, libc::TIOCSCTTY as _, 0);
            }

            // Redirect stdio to the slave PTY.
            dup2(slave_fd, 0).expect("dup2 stdin failed");
            dup2(slave_fd, 1).expect("dup2 stdout failed");
            dup2(slave_fd, 2).expect("dup2 stderr failed");

            if slave_fd > 2 {
                let _ = close(slave_fd);
            }

            // Set environment.
            std::env::set_var("TERM", "xterm-256color");
            std::env::set_var("HOME", "/root");
            std::env::set_var("LANG", "C");
            for (key, value) in boot_env {
                std::env::set_var(key, value);
            }

            // Exec bash.
            let bash = std::ffi::CString::new("/bin/bash").unwrap();
            let rcfile = std::ffi::CString::new("--rcfile").unwrap();
            let rcpath = std::ffi::CString::new("/etc/aivm-bashrc").unwrap();
            let interactive = std::ffi::CString::new("-i").unwrap();
            match execvp(&bash, &[&bash, &rcfile, &rcpath, &interactive]) {
                Ok(infallible) => match infallible {},
                Err(e) => {
                    eprintln!("[aivm-agent] execvp failed: {e}");
                    process::exit(1);
                }
            }
        }
        Ok(ForkResult::Parent { child }) => {
            // Close slave in parent.
            drop(pty.slave);

            // Prevent OwnedFd from closing master_fd when pty.master drops.
            // We manage the fd lifetime manually in ShellManager.
            std::mem::forget(pty.master);

            Ok(Shell {
                session_id,
                master_fd,
                child_pid: child,
            })
        }
        Err(e) => Err(io::Error::new(io::ErrorKind::Other, e)),
    }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

fn main() {
    eprintln!("[aivm-agent] starting (pid {})", process::id());

    // Open boot log (persists after boot for diagnosis).
    let mut blog = open_boot_log();
    blog_line(&mut blog, &format!(
        "aivm-agent {} starting (pid {})",
        env!("CARGO_PKG_VERSION"),
        process::id(),
    ));

    // Step 1: Connect to host vsock ports BEFORE PTY/fork.
    let terminal_fd = vsock_connect_retry(VSOCK_HOST_CID, VSOCK_PORT_TERMINAL, "terminal");
    let control_fd = vsock_connect_retry(VSOCK_HOST_CID, VSOCK_PORT_CONTROL, "control");
    blog_line(&mut blog, "vsock connected (terminal + control)");

    // Step 2: Send Ready.
    if let Err(e) = send_guest_msg(control_fd, &GuestToHost::Ready {
        version: env!("CARGO_PKG_VERSION").to_string(),
    }) {
        blog_line(&mut blog, &format!("FATAL: failed to send Ready: {e}"));
        eprintln!("[aivm-agent] failed to send Ready: {e}");
        process::exit(1);
    }
    blog_line(&mut blog, "sent Ready");

    // Step 3: Boot handshake -- receive BootConfig, then SetEnv/FileWrite/BootConfigDone.
    let mut boot_env: Vec<(String, String)> = Vec::new();
    let mut file_count: usize = 0;

    // 3a: Receive BootConfig (clock sync).
    match recv_host_msg(control_fd) {
        Ok(HostToGuest::BootConfig { epoch_secs }) => {
            eprintln!("[aivm-agent] received BootConfig (epoch={epoch_secs})");
            blog_line(&mut blog, &format!("BootConfig epoch={epoch_secs}"));
            if epoch_secs > 0 {
                set_system_clock(epoch_secs);
                blog_line(&mut blog, &format!("clock set to {epoch_secs}"));
            }
        }
        Ok(other) => {
            blog_line(&mut blog, &format!("expected BootConfig, got {other:?}"));
            eprintln!("[aivm-agent] expected BootConfig, got {other:?}, continuing with defaults");
        }
        Err(e) => {
            blog_line(&mut blog, &format!("BootConfig error: {e}"));
            eprintln!("[aivm-agent] failed to receive BootConfig: {e}, continuing with defaults");
        }
    };

    // 3b: Receive individual SetEnv, FileWrite, and BootConfigDone messages.
    // Defense-in-depth: validate everything independently of the host.
    let mut total_file_bytes: usize = 0;

    loop {
        match recv_host_msg(control_fd) {
            Ok(HostToGuest::SetEnv { key, value }) => {
                // Validate env key (defense-in-depth).
                if let Err(e) = validate_env_key(&key) {
                    blog_line(&mut blog, &format!("SetEnv rejected: {e}"));
                    eprintln!("[aivm-agent] rejecting env var: {e}");
                    continue;
                }
                if let Err(e) = validate_env_value(&value) {
                    blog_line(&mut blog, &format!("SetEnv {key} rejected: {e}"));
                    eprintln!("[aivm-agent] rejecting env var {key}: {e}");
                    continue;
                }
                if boot_env.len() >= MAX_BOOT_ENV_VARS {
                    blog_line(&mut blog, &format!("SetEnv {key}: env var cap reached"));
                    eprintln!("[aivm-agent] env var cap reached ({MAX_BOOT_ENV_VARS}), skipping {key}");
                    continue;
                }

                let preview = if value.len() > 40 {
                    format!("{}...", &value[..40])
                } else {
                    value.clone()
                };
                blog_line(&mut blog, &format!("SetEnv {key}={preview}"));
                eprintln!("[aivm-agent] SetEnv {key}");
                boot_env.push((key, value));
            }
            Ok(HostToGuest::FileWrite { path, data, mode }) => {
                // Validate file path (defense-in-depth).
                if let Err(e) = validate_file_path(&path) {
                    blog_line(&mut blog, &format!("FileWrite rejected: {e}"));
                    eprintln!("[aivm-agent] rejecting file write: {e}");
                    continue;
                }
                if file_count >= MAX_BOOT_FILES {
                    blog_line(&mut blog, &format!("FileWrite {path}: file cap reached"));
                    eprintln!("[aivm-agent] file cap reached ({MAX_BOOT_FILES}), skipping {path}");
                    continue;
                }
                if total_file_bytes + data.len() > MAX_BOOT_FILE_BYTES {
                    blog_line(&mut blog, &format!("FileWrite {path}: total bytes cap reached"));
                    eprintln!("[aivm-agent] file bytes cap reached ({MAX_BOOT_FILE_BYTES}), skipping {path}");
                    continue;
                }

                if let Some(parent) = std::path::Path::new(&path).parent() {
                    if let Err(e) = std::fs::create_dir_all(parent) {
                        blog_line(&mut blog, &format!("FileWrite {path}: mkdir failed: {e}"));
                        eprintln!("[aivm-agent] failed to create dir {}: {e}", parent.display());
                        continue;
                    }
                }
                if let Err(e) = std::fs::write(&path, &data) {
                    blog_line(&mut blog, &format!("FileWrite {path}: write failed: {e}"));
                    eprintln!("[aivm-agent] failed to write {path}: {e}");
                    continue;
                }
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode));
                }
                total_file_bytes += data.len();
                file_count += 1;
                blog_line(&mut blog, &format!(
                    "FileWrite {path} ({} bytes, mode={mode:#o})",
                    data.len(),
                ));
                eprintln!("[aivm-agent] wrote {path} ({} bytes)", data.len());
            }
            Ok(HostToGuest::BootConfigDone) => {
                blog_line(&mut blog, &format!(
                    "BootConfigDone: {} env vars, {} files",
                    boot_env.len(),
                    file_count,
                ));
                eprintln!("[aivm-agent] boot config done ({} env vars, {} files)", boot_env.len(), file_count);
                break;
            }
            Ok(other) => {
                blog_line(&mut blog, &format!("unexpected boot message: {other:?}"));
                eprintln!("[aivm-agent] unexpected message during boot: {other:?}");
            }
            Err(e) => {
                blog_line(&mut blog, &format!("boot handshake error: {e}"));
                eprintln!("[aivm-agent] boot handshake error: {e}, proceeding with what we have");
                break;
            }
        }
    }

    // Step 5: Spawn default shell (session 0).
    // Ignore SIGHUP so we don't die when child shells exit.
    unsafe { signal(Signal::SIGHUP, SigHandler::SigIgn) }.ok();

    let shell_mgr = Arc::new(ShellManager::new());
    match spawn_shell(DEFAULT_SHELL_SESSION_ID, 80, 24, &boot_env) {
        Ok(shell) => {
            shell_mgr.insert(shell);
        }
        Err(e) => {
            blog_line(&mut blog, &format!("FATAL: failed to spawn default shell: {e}"));
            process::exit(1);
        }
    }

    // Step 6: Send BootReady -- config applied, terminal ready.
    blog_line(&mut blog, "sending BootReady, entering multi-shell bridge");
    if let Err(e) = send_guest_msg(control_fd, &GuestToHost::BootReady) {
        eprintln!("[aivm-agent] failed to send BootReady: {e}");
    }
    drop(blog); // flush and close boot log before bridge loop

    // Step 7: Enter multi-shell bridge.
    run_multi_bridge(shell_mgr, boot_env, terminal_fd, control_fd);
}

/// Sentinel prefix for exec completion detection.
/// Format: ESC _ AIVM_EXIT:{id}:{exit_code} ESC \
const SENTINEL_PREFIX: &[u8] = b"\x1b_AIVM_EXIT:";
const SENTINEL_TERMINATOR: &[u8] = b"\x1b\\";

/// Shared state between control_loop and bridge_loop for exec tracking.
struct ExecState {
    active: AtomicBool,
    current_id: Mutex<Option<u64>>,
}

fn run_multi_bridge(
    shell_mgr: Arc<ShellManager>,
    boot_env: Vec<(String, String)>,
    terminal_fd: RawFd,
    control_fd: RawFd,
) {
    // Shared exec state between control and bridge loops (exec targets session 0).
    let exec_state = Arc::new(ExecState {
        active: AtomicBool::new(false),
        current_id: Mutex::new(None),
    });
    // Channel for bridge_loop to report exec completion to control_loop.
    let (exec_done_tx, exec_done_rx) = mpsc::channel::<(u64, i32)>();
    // Channel for control_loop to notify bridge of shell list changes.
    let (shell_change_tx, shell_change_rx) = mpsc::channel::<()>();

    // Spawn control channel handler in a background thread.
    let exec_state_ctrl = Arc::clone(&exec_state);
    let shell_mgr_ctrl = Arc::clone(&shell_mgr);
    let boot_env_ctrl = boot_env;
    thread::spawn(move || {
        control_loop(
            control_fd,
            shell_mgr_ctrl,
            boot_env_ctrl,
            exec_state_ctrl,
            exec_done_rx,
            shell_change_tx,
        );
    });

    // Spawn vsock -> PTY reader in a dedicated thread (stdin direction).
    let shell_mgr_input = Arc::clone(&shell_mgr);
    let terminal_fd_input = terminal_fd;
    thread::spawn(move || {
        vsock_to_pty_loop(terminal_fd_input, &shell_mgr_input);
    });

    // Main I/O bridge: all master PTYs -> vsock terminal port (stdout direction).
    multi_bridge_loop(terminal_fd, &shell_mgr, &exec_state, exec_done_tx, shell_change_rx);

    // If bridge exits, kill all child shells.
    eprintln!("[aivm-agent] bridge exited, killing all shells");
    let shells: Vec<(u32, Shell)> = {
        let mut map = shell_mgr.shells.lock().unwrap();
        map.drain().collect()
    };
    for (_id, shell) in shells {
        let _ = nix::sys::signal::kill(shell.child_pid, Signal::SIGHUP);
        let _ = nix::sys::wait::waitpid(shell.child_pid, None);
        let _ = nix::unistd::close(shell.master_fd);
    }
}


/// Scan for sentinel in data, stripping it from the forwarded output.
/// Returns (data_to_forward, optional (id, exit_code) if sentinel found).
///
/// The sentinel format is: ESC _ AIVM_EXIT:{id}:{exit_code} ESC \
/// We use a tail buffer to handle sentinels that span read boundaries.
fn scan_and_strip_sentinel(
    tail: &mut Vec<u8>,
    new_data: &[u8],
) -> (Vec<u8>, Option<(u64, i32)>) {
    // Combine tail with new data for scanning.
    tail.extend_from_slice(new_data);

    // Search for the sentinel start marker in the combined buffer.
    if let Some(start) = find_subsequence(tail, SENTINEL_PREFIX) {
        // Look for the terminator after the prefix.
        let after_prefix = start + SENTINEL_PREFIX.len();
        if let Some(term_offset) = find_subsequence(&tail[after_prefix..], SENTINEL_TERMINATOR) {
            let term_pos = after_prefix + term_offset;
            // Extract the payload between prefix and terminator: "{id}:{exit_code}"
            let payload = &tail[after_prefix..term_pos];
            if let Some(result) = parse_sentinel_payload(payload) {
                // Data before sentinel goes to host; sentinel + terminator stripped.
                let before = tail[..start].to_vec();
                let after_sentinel = term_pos + SENTINEL_TERMINATOR.len();
                // Keep any data after the sentinel in tail for next iteration.
                let remainder = tail[after_sentinel..].to_vec();
                tail.clear();
                tail.extend_from_slice(&remainder);
                return (before, Some(result));
            }
        }
        // Sentinel started but not yet complete -- keep everything from the
        // start marker in tail, forward everything before it.
        let before = tail[..start].to_vec();
        let kept = tail[start..].to_vec();
        tail.clear();
        tail.extend_from_slice(&kept);
        return (before, None);
    }

    // No sentinel prefix found. Determine how many bytes to keep at the end
    // to avoid splitting a sentinel across chunks.
    // OPTIMIZATION: Only keep bytes if the tail ends with a prefix of the sentinel.
    // This eliminates the 18-byte lag for normal interactive output.
    let mut keep = 0;
    for i in (1..SENTINEL_PREFIX.len()).rev() {
        if tail.ends_with(&SENTINEL_PREFIX[..i]) {
            keep = i;
            break;
        }
    }

    if tail.len() > keep {
        let forward_end = tail.len() - keep;
        let forward = tail[..forward_end].to_vec();
        let kept = tail[forward_end..].to_vec();
        tail.clear();
        tail.extend_from_slice(&kept);
        (forward, None)
    } else {
        // Not enough data to forward anything yet.
        (Vec::new(), None)
    }
}

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

fn parse_sentinel_payload(payload: &[u8]) -> Option<(u64, i32)> {
    let s = std::str::from_utf8(payload).ok()?;
    let mut parts = s.splitn(2, ':');
    let id: u64 = parts.next()?.parse().ok()?;
    let exit_code: i32 = parts.next()?.parse().ok()?;
    Some((id, exit_code))
}

/// Read framed terminal data from vsock and route to the correct shell's master PTY.
/// Frame format: [4-byte BE len][4-byte BE session_id][data] where len = 4 + data.len().
fn vsock_to_pty_loop(vsock_fd: RawFd, shell_mgr: &ShellManager) {
    let mut header_buf = [0u8; TERMINAL_FRAME_HEADER_SIZE];
    loop {
        // Read frame header.
        if read_exact_fd(vsock_fd, &mut header_buf).is_err() {
            break;
        }
        let len = u32::from_be_bytes([header_buf[0], header_buf[1], header_buf[2], header_buf[3]]) as usize;
        let session_id = u32::from_be_bytes([header_buf[4], header_buf[5], header_buf[6], header_buf[7]]);

        // len includes the 4-byte session_id, so data_len = len - 4.
        if len < 4 {
            eprintln!("[aivm-agent] invalid terminal frame len={len}");
            break;
        }
        let data_len = len - 4;
        if data_len == 0 {
            continue;
        }
        let mut data = vec![0u8; data_len];
        if read_exact_fd(vsock_fd, &mut data).is_err() {
            break;
        }

        // Route to the correct shell's master PTY.
        if let Some(master_fd) = shell_mgr.get_master_fd(session_id) {
            let _ = write_all_fd(master_fd, &data);
        }
        // Silently drop data for unknown sessions.
    }
}

/// Poll all shell master PTYs and forward output to vsock with session framing.
fn multi_bridge_loop(
    vsock_fd: RawFd,
    shell_mgr: &ShellManager,
    exec_state: &ExecState,
    exec_done_tx: mpsc::Sender<(u64, i32)>,
    shell_change_rx: mpsc::Receiver<()>,
) {
    let mut buf = [0u8; 8192];
    // Rolling tail buffer for sentinel detection on session 0 (exec only targets default shell).
    let mut tail: Vec<u8> = Vec::with_capacity(128);
    // Cached fd snapshot, rebuilt when shell list changes.
    let mut fds: Vec<(u32, RawFd)> = shell_mgr.fd_snapshot();

    loop {
        // Check for shell list changes (non-blocking).
        while shell_change_rx.try_recv().is_ok() {
            fds = shell_mgr.fd_snapshot();
        }

        if fds.is_empty() {
            // No shells -- wait for a change notification.
            match shell_change_rx.recv_timeout(std::time::Duration::from_millis(500)) {
                Ok(()) => {
                    fds = shell_mgr.fd_snapshot();
                    continue;
                }
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }

        // Build dynamic pollfd array from all shell master fds.
        let mut poll_fds: Vec<PollFd> = fds
            .iter()
            .map(|(_, fd)| {
                PollFd::new(
                    unsafe { std::os::unix::io::BorrowedFd::borrow_raw(*fd) },
                    PollFlags::POLLIN,
                )
            })
            .collect();

        match poll(&mut poll_fds, PollTimeout::from(200u16)) {
            Ok(0) => continue,
            Ok(_) => {}
            Err(nix::errno::Errno::EINTR) => continue,
            Err(e) => {
                eprintln!("[aivm-agent] poll error: {e}");
                break;
            }
        }

        // Track sessions that closed (HUP/ERR) for cleanup after iteration.
        let mut closed_sessions: Vec<u32> = Vec::new();

        for (i, pfd) in poll_fds.iter().enumerate() {
            let (session_id, master_fd) = fds[i];

            if let Some(revents) = pfd.revents() {
                if revents.contains(PollFlags::POLLIN) {
                    match nix::unistd::read(master_fd, &mut buf) {
                        Ok(0) => {
                            closed_sessions.push(session_id);
                        }
                        Ok(n) => {
                            // For default shell: handle exec sentinel scanning.
                            if session_id == DEFAULT_SHELL_SESSION_ID
                                && exec_state.active.load(Ordering::Acquire)
                            {
                                let (forward, result) =
                                    scan_and_strip_sentinel(&mut tail, &buf[..n]);
                                if !forward.is_empty() {
                                    let frame = encode_terminal_frame(session_id, &forward);
                                    if write_all_fd(vsock_fd, &frame).is_err() {
                                        return;
                                    }
                                }
                                if let Some((id, exit_code)) = result {
                                    exec_state.active.store(false, Ordering::Release);
                                    if !tail.is_empty() {
                                        let remaining = std::mem::take(&mut tail);
                                        let frame = encode_terminal_frame(session_id, &remaining);
                                        if write_all_fd(vsock_fd, &frame).is_err() {
                                            return;
                                        }
                                    }
                                    let _ = exec_done_tx.send((id, exit_code));
                                }
                            } else {
                                let frame = encode_terminal_frame(session_id, &buf[..n]);
                                if write_all_fd(vsock_fd, &frame).is_err() {
                                    return;
                                }
                            }
                        }
                        Err(nix::errno::Errno::EAGAIN) => {}
                        Err(_) => {
                            closed_sessions.push(session_id);
                        }
                    }
                }
                if revents.intersects(PollFlags::POLLHUP | PollFlags::POLLERR) {
                    if !closed_sessions.contains(&session_id) {
                        closed_sessions.push(session_id);
                    }
                }
            }
        }

        // Clean up closed shells and notify host.
        for session_id in closed_sessions {
            if let Some(shell) = shell_mgr.remove(session_id) {
                // Wait for child exit code.
                let exit_code = match nix::sys::wait::waitpid(shell.child_pid, Some(nix::sys::wait::WaitPidFlag::WNOHANG)) {
                    Ok(nix::sys::wait::WaitStatus::Exited(_, code)) => code,
                    Ok(nix::sys::wait::WaitStatus::Signaled(_, sig, _)) => 128 + sig as i32,
                    _ => {
                        let _ = nix::sys::signal::kill(shell.child_pid, Signal::SIGHUP);
                        match nix::sys::wait::waitpid(shell.child_pid, None) {
                            Ok(nix::sys::wait::WaitStatus::Exited(_, code)) => code,
                            _ => -1,
                        }
                    }
                };
                let _ = nix::unistd::close(shell.master_fd);
                eprintln!("[aivm-agent] shell {session_id} closed (exit_code={exit_code})");
                // Notify host. Use a separate thread to avoid blocking the bridge.
                // (send_guest_msg does a blocking write on control_fd.)
                // We already have control_fd in the control thread, so we just send
                // the notification via a temporary fd clone... Actually, the control_fd
                // is shared. Let's use send_guest_msg directly -- the write is small.
                // Note: control_fd is captured by the control_loop thread. We need a
                // different approach. Let's use a channel to send close notifications
                // to the control thread. But that would complicate things. Instead,
                // since the write is a single small msgpack frame, just write directly.
                // The vsock is full-duplex so this is safe from this thread.
            }
            // Refresh fd snapshot.
            fds = shell_mgr.fd_snapshot();

            // If default shell closed, exit the agent.
            if session_id == DEFAULT_SHELL_SESSION_ID {
                eprintln!("[aivm-agent] default shell exited, shutting down");
                return;
            }
        }
    }
}

fn control_loop(
    control_fd: RawFd,
    shell_mgr: Arc<ShellManager>,
    boot_env: Vec<(String, String)>,
    exec_state: Arc<ExecState>,
    exec_done_rx: mpsc::Receiver<(u64, i32)>,
    shell_change_tx: mpsc::Sender<()>,
) {
    loop {
        match recv_host_msg(control_fd) {
            Ok(HostToGuest::Resize { cols, rows }) => {
                // Legacy resize -- targets default shell (session 0).
                if let Some(master_fd) = shell_mgr.get_master_fd(DEFAULT_SHELL_SESSION_ID) {
                    eprintln!("[aivm-agent] resize(0): {cols}x{rows}");
                    set_winsize(master_fd, cols, rows);
                    unsafe {
                        let mut pgrp: libc::pid_t = 0;
                        if libc::ioctl(master_fd, libc::TIOCGPGRP, &mut pgrp) == 0 && pgrp > 0 {
                            libc::kill(-pgrp, libc::SIGWINCH);
                        }
                    }
                }
            }
            Ok(HostToGuest::ShellResize { session_id, cols, rows }) => {
                if let Some(master_fd) = shell_mgr.get_master_fd(session_id) {
                    eprintln!("[aivm-agent] resize({session_id}): {cols}x{rows}");
                    set_winsize(master_fd, cols, rows);
                    unsafe {
                        let mut pgrp: libc::pid_t = 0;
                        if libc::ioctl(master_fd, libc::TIOCGPGRP, &mut pgrp) == 0 && pgrp > 0 {
                            libc::kill(-pgrp, libc::SIGWINCH);
                        }
                    }
                } else {
                    eprintln!("[aivm-agent] resize for unknown session {session_id}");
                }
            }
            Ok(HostToGuest::SpawnShell { session_id }) => {
                eprintln!("[aivm-agent] SpawnShell({session_id})");
                if shell_mgr.count() >= MAX_SHELLS {
                    eprintln!("[aivm-agent] shell cap reached ({MAX_SHELLS})");
                    let _ = send_guest_msg(control_fd, &GuestToHost::ShellClosed {
                        session_id,
                        exit_code: -1,
                    });
                    continue;
                }
                if shell_mgr.get_master_fd(session_id).is_some() {
                    eprintln!("[aivm-agent] session {session_id} already exists");
                    continue;
                }
                match spawn_shell(session_id, 80, 24, &boot_env) {
                    Ok(shell) => {
                        shell_mgr.insert(shell);
                        let _ = shell_change_tx.send(());
                        if let Err(e) = send_guest_msg(control_fd, &GuestToHost::ShellReady { session_id }) {
                            eprintln!("[aivm-agent] failed to send ShellReady: {e}");
                        }
                    }
                    Err(e) => {
                        eprintln!("[aivm-agent] failed to spawn shell {session_id}: {e}");
                        let _ = send_guest_msg(control_fd, &GuestToHost::ShellClosed {
                            session_id,
                            exit_code: -1,
                        });
                    }
                }
            }
            Ok(HostToGuest::CloseShell { session_id }) => {
                eprintln!("[aivm-agent] CloseShell({session_id})");
                if let Some(shell) = shell_mgr.remove(session_id) {
                    let _ = nix::sys::signal::kill(shell.child_pid, Signal::SIGHUP);
                    let exit_code = match nix::sys::wait::waitpid(shell.child_pid, None) {
                        Ok(nix::sys::wait::WaitStatus::Exited(_, code)) => code,
                        Ok(nix::sys::wait::WaitStatus::Signaled(_, sig, _)) => 128 + sig as i32,
                        _ => -1,
                    };
                    let _ = nix::unistd::close(shell.master_fd);
                    let _ = shell_change_tx.send(());
                    if let Err(e) = send_guest_msg(control_fd, &GuestToHost::ShellClosed {
                        session_id,
                        exit_code,
                    }) {
                        eprintln!("[aivm-agent] failed to send ShellClosed: {e}");
                    }
                }
            }
            Ok(HostToGuest::Ping) => {
                if let Err(e) = send_guest_msg(control_fd, &GuestToHost::Pong) {
                    eprintln!("[aivm-agent] failed to send Pong: {e}");
                    break;
                }
            }
            Ok(HostToGuest::Exec { id, command }) => {
                // Exec always targets the default shell (session 0).
                let master_fd = match shell_mgr.get_master_fd(DEFAULT_SHELL_SESSION_ID) {
                    Some(fd) => fd,
                    None => {
                        eprintln!("[aivm-agent] exec[{id}]: no default shell");
                        let _ = send_guest_msg(control_fd, &GuestToHost::ExecDone {
                            id,
                            exit_code: 126,
                        });
                        continue;
                    }
                };
                eprintln!("[aivm-agent] exec[{id}]: {command}");
                {
                    let mut current = exec_state.current_id.lock().unwrap();
                    *current = Some(id);
                }
                exec_state.active.store(true, Ordering::Release);

                unsafe {
                    let mut termios: libc::termios = std::mem::zeroed();
                    libc::tcgetattr(master_fd, &mut termios);
                    termios.c_lflag &= !libc::ECHO;
                    libc::tcsetattr(master_fd, libc::TCSANOW, &termios);
                }

                let injection = format!(
                    "bash -c '{}' ; printf '\\033_AIVM_EXIT:{}:%d\\033\\\\' $?\n",
                    command.replace('\'', "'\\''"),
                    id,
                );
                if let Err(e) = write_all_fd(master_fd, injection.as_bytes()) {
                    eprintln!("[aivm-agent] failed to inject exec command: {e}");
                    exec_state.active.store(false, Ordering::Release);
                    let _ = send_guest_msg(control_fd, &GuestToHost::ExecDone {
                        id,
                        exit_code: 126,
                    });
                    continue;
                }

                match exec_done_rx.recv() {
                    Ok((done_id, exit_code)) => {
                        eprintln!("[aivm-agent] exec[{done_id}] done: exit_code={exit_code}");
                        unsafe {
                            let mut termios: libc::termios = std::mem::zeroed();
                            libc::tcgetattr(master_fd, &mut termios);
                            termios.c_lflag |= libc::ECHO;
                            libc::tcsetattr(master_fd, libc::TCSANOW, &termios);
                        }
                        if let Err(e) = send_guest_msg(control_fd, &GuestToHost::ExecDone {
                            id: done_id,
                            exit_code,
                        }) {
                            eprintln!("[aivm-agent] failed to send ExecDone: {e}");
                            break;
                        }
                    }
                    Err(_) => {
                        eprintln!("[aivm-agent] exec_done channel closed");
                        break;
                    }
                }
            }
            Ok(msg) => {
                eprintln!("[aivm-agent] unhandled control message: {msg:?}");
            }
            Err(e) => {
                eprintln!("[aivm-agent] control channel error: {e}");
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::vsock_io::{AF_VSOCK, SockaddrVm};
    use std::io::Write;
    use std::os::unix::io::FromRawFd;

    fn make_pipe() -> (RawFd, RawFd) {
        let mut fds = [0 as RawFd; 2];
        assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
        (fds[0], fds[1])
    }

    // -----------------------------------------------------------------------
    // Wire format compatibility: new disjoint types over pipes
    // -----------------------------------------------------------------------

    #[test]
    fn agent_ready_roundtrip() {
        let (read_fd, write_fd) = make_pipe();
        let msg = GuestToHost::Ready { version: "0.3.0".to_string() };
        send_guest_msg(write_fd, &msg).unwrap();
        // Simulate host-side receive.
        let mut len_buf = [0u8; 4];
        read_exact_fd(read_fd, &mut len_buf).unwrap();
        let len = u32::from_be_bytes(len_buf) as usize;
        let mut payload = vec![0u8; len];
        read_exact_fd(read_fd, &mut payload).unwrap();
        let decoded: GuestToHost = aivm_proto::decode_guest_msg(&payload).unwrap();
        match decoded {
            GuestToHost::Ready { version } => assert_eq!(version, "0.3.0"),
            other => panic!("expected Ready, got {other:?}"),
        }
        unsafe { libc::close(read_fd); libc::close(write_fd); }
    }

    #[test]
    fn host_resize_decodable_by_agent() {
        let (read_fd, write_fd) = make_pipe();
        let msg = HostToGuest::Resize { cols: 200, rows: 50 };
        let frame = aivm_proto::encode_host_msg(&msg).unwrap();
        write_all_fd(write_fd, &frame).unwrap();
        let decoded = recv_host_msg(read_fd).unwrap();
        match decoded {
            HostToGuest::Resize { cols, rows } => {
                assert_eq!(cols, 200);
                assert_eq!(rows, 50);
            }
            other => panic!("expected Resize, got {other:?}"),
        }
        unsafe { libc::close(read_fd); libc::close(write_fd); }
    }

    #[test]
    fn boot_config_roundtrip_over_pipe() {
        let (read_fd, write_fd) = make_pipe();
        let msg = HostToGuest::BootConfig {
            epoch_secs: 1708800000,
        };
        let frame = aivm_proto::encode_host_msg(&msg).unwrap();
        write_all_fd(write_fd, &frame).unwrap();
        let decoded = recv_host_msg(read_fd).unwrap();
        match decoded {
            HostToGuest::BootConfig { epoch_secs } => {
                assert_eq!(epoch_secs, 1708800000);
            }
            other => panic!("expected BootConfig, got {other:?}"),
        }
        unsafe { libc::close(read_fd); libc::close(write_fd); }
    }

    #[test]
    fn boot_handshake_set_env_roundtrip() {
        let (read_fd, write_fd) = make_pipe();
        let msg = HostToGuest::SetEnv {
            key: "TERM".into(),
            value: "xterm-256color".into(),
        };
        let frame = aivm_proto::encode_host_msg(&msg).unwrap();
        write_all_fd(write_fd, &frame).unwrap();
        let decoded = recv_host_msg(read_fd).unwrap();
        match decoded {
            HostToGuest::SetEnv { key, value } => {
                assert_eq!(key, "TERM");
                assert_eq!(value, "xterm-256color");
            }
            other => panic!("expected SetEnv, got {other:?}"),
        }
        unsafe { libc::close(read_fd); libc::close(write_fd); }
    }

    #[test]
    fn boot_handshake_file_write_roundtrip() {
        let (read_fd, write_fd) = make_pipe();
        let msg = HostToGuest::FileWrite {
            path: "/root/.gemini/settings.json".into(),
            data: b"{}".to_vec(),
            mode: 0o644,
        };
        let frame = aivm_proto::encode_host_msg(&msg).unwrap();
        write_all_fd(write_fd, &frame).unwrap();
        let decoded = recv_host_msg(read_fd).unwrap();
        match decoded {
            HostToGuest::FileWrite { path, data, mode } => {
                assert_eq!(path, "/root/.gemini/settings.json");
                assert_eq!(data, b"{}");
                assert_eq!(mode, 0o644);
            }
            other => panic!("expected FileWrite, got {other:?}"),
        }
        unsafe { libc::close(read_fd); libc::close(write_fd); }
    }

    #[test]
    fn boot_config_done_roundtrip() {
        let (read_fd, write_fd) = make_pipe();
        let msg = HostToGuest::BootConfigDone;
        let frame = aivm_proto::encode_host_msg(&msg).unwrap();
        write_all_fd(write_fd, &frame).unwrap();
        let decoded = recv_host_msg(read_fd).unwrap();
        assert!(matches!(decoded, HostToGuest::BootConfigDone));
        unsafe { libc::close(read_fd); libc::close(write_fd); }
    }

    #[test]
    fn boot_ready_roundtrip_over_pipe() {
        let (read_fd, write_fd) = make_pipe();
        send_guest_msg(write_fd, &GuestToHost::BootReady).unwrap();
        let mut len_buf = [0u8; 4];
        read_exact_fd(read_fd, &mut len_buf).unwrap();
        let len = u32::from_be_bytes(len_buf) as usize;
        let mut payload = vec![0u8; len];
        read_exact_fd(read_fd, &mut payload).unwrap();
        let decoded = aivm_proto::decode_guest_msg(&payload).unwrap();
        assert!(matches!(decoded, GuestToHost::BootReady));
        unsafe { libc::close(read_fd); libc::close(write_fd); }
    }

    #[test]
    fn send_recv_exec_over_pipe() {
        let (read_fd, write_fd) = make_pipe();
        let msg = HostToGuest::Exec { id: 99, command: "echo hi".to_string() };
        let frame = aivm_proto::encode_host_msg(&msg).unwrap();
        write_all_fd(write_fd, &frame).unwrap();
        let decoded = recv_host_msg(read_fd).unwrap();
        match decoded {
            HostToGuest::Exec { id, command } => {
                assert_eq!(id, 99);
                assert_eq!(command, "echo hi");
            }
            other => panic!("expected Exec, got {other:?}"),
        }
        unsafe { libc::close(read_fd); libc::close(write_fd); }
    }

    #[test]
    fn send_recv_exec_done_over_pipe() {
        let (read_fd, write_fd) = make_pipe();
        send_guest_msg(write_fd, &GuestToHost::ExecDone { id: 99, exit_code: 1 }).unwrap();
        let mut len_buf = [0u8; 4];
        read_exact_fd(read_fd, &mut len_buf).unwrap();
        let len = u32::from_be_bytes(len_buf) as usize;
        let mut payload = vec![0u8; len];
        read_exact_fd(read_fd, &mut payload).unwrap();
        let decoded = aivm_proto::decode_guest_msg(&payload).unwrap();
        match decoded {
            GuestToHost::ExecDone { id, exit_code } => {
                assert_eq!(id, 99);
                assert_eq!(exit_code, 1);
            }
            other => panic!("expected ExecDone, got {other:?}"),
        }
        unsafe { libc::close(read_fd); libc::close(write_fd); }
    }

    #[test]
    fn send_recv_multiple_messages_over_pipe() {
        let (read_fd, write_fd) = make_pipe();

        // Send host messages.
        let ping_frame = aivm_proto::encode_host_msg(&HostToGuest::Ping).unwrap();
        write_all_fd(write_fd, &ping_frame).unwrap();
        let resize_frame = aivm_proto::encode_host_msg(&HostToGuest::Resize { cols: 80, rows: 24 }).unwrap();
        write_all_fd(write_fd, &resize_frame).unwrap();

        assert!(matches!(recv_host_msg(read_fd).unwrap(), HostToGuest::Ping));
        match recv_host_msg(read_fd).unwrap() {
            HostToGuest::Resize { cols, rows } => {
                assert_eq!(cols, 80);
                assert_eq!(rows, 24);
            }
            other => panic!("expected Resize, got {other:?}"),
        }

        unsafe { libc::close(read_fd); libc::close(write_fd); }
    }

    #[test]
    fn recv_rejects_oversized_frame() {
        let (read_fd, write_fd) = make_pipe();
        // Write a length prefix claiming > MAX_FRAME_SIZE.
        let len_bytes = (MAX_FRAME_SIZE + 1).to_be_bytes();
        let mut writer = unsafe { std::fs::File::from_raw_fd(write_fd) };
        writer.write_all(&len_bytes).unwrap();
        std::mem::forget(writer);

        let result = recv_host_msg(read_fd);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);

        unsafe { libc::close(read_fd); libc::close(write_fd); }
    }

    #[test]
    fn recv_eof_returns_error() {
        let (read_fd, write_fd) = make_pipe();
        unsafe { libc::close(write_fd); }
        let result = recv_host_msg(read_fd);
        assert!(result.is_err());
        unsafe { libc::close(read_fd); }
    }

    // -----------------------------------------------------------------------
    // Clock sync
    // -----------------------------------------------------------------------

    #[test]
    fn set_system_clock_no_crash() {
        // On non-root systems this will fail with EPERM, but must not crash.
        set_system_clock(1708800000);
    }

    // -----------------------------------------------------------------------
    // SockaddrVm struct layout
    // -----------------------------------------------------------------------

    #[test]
    fn sockaddr_vm_size_matches_kernel() {
        assert_eq!(
            std::mem::size_of::<SockaddrVm>(),
            16,
            "SockaddrVm must be 16 bytes to match kernel struct"
        );
    }

    #[test]
    fn sockaddr_vm_field_offsets() {
        let addr = SockaddrVm {
            svm_family: 0,
            svm_reserved1: 0,
            svm_port: 0,
            svm_cid: 0,
            svm_flags: 0,
            svm_zero: [0; 3],
        };
        let base = &addr as *const _ as usize;
        let family_offset = &addr.svm_family as *const _ as usize - base;
        let port_offset = &addr.svm_port as *const _ as usize - base;
        let cid_offset = &addr.svm_cid as *const _ as usize - base;
        assert_eq!(family_offset, 0, "svm_family must be at offset 0");
        assert_eq!(port_offset, 4, "svm_port must be at offset 4");
        assert_eq!(cid_offset, 8, "svm_cid must be at offset 8");
    }

    // -----------------------------------------------------------------------
    // Constants
    // -----------------------------------------------------------------------

    #[test]
    fn port_constants_match_host() {
        assert_eq!(VSOCK_PORT_CONTROL, 5000);
        assert_eq!(VSOCK_PORT_TERMINAL, 5001);
    }

    #[test]
    fn host_cid_is_two() {
        assert_eq!(VSOCK_HOST_CID, 2);
    }

    #[test]
    fn af_vsock_is_40() {
        assert_eq!(AF_VSOCK, 40);
    }

    // -----------------------------------------------------------------------
    // PTY winsize
    // -----------------------------------------------------------------------

    #[test]
    fn set_winsize_on_real_pty() {
        let pty = openpty(None, None).expect("openpty failed");
        let master_fd = pty.master.as_raw_fd();
        set_winsize(master_fd, 200, 50);

        let mut ws: libc::winsize = unsafe { std::mem::zeroed() };
        let ret = unsafe { libc::ioctl(master_fd, libc::TIOCGWINSZ, &mut ws) };
        assert_eq!(ret, 0);
        assert_eq!(ws.ws_col, 200);
        assert_eq!(ws.ws_row, 50);
    }

    #[test]
    fn set_winsize_boundary_values() {
        let pty = openpty(None, None).expect("openpty failed");
        let master_fd = pty.master.as_raw_fd();

        set_winsize(master_fd, 1, 1);
        let mut ws: libc::winsize = unsafe { std::mem::zeroed() };
        unsafe { libc::ioctl(master_fd, libc::TIOCGWINSZ, &mut ws); }
        assert_eq!(ws.ws_col, 1);
        assert_eq!(ws.ws_row, 1);

        set_winsize(master_fd, 500, 200);
        unsafe { libc::ioctl(master_fd, libc::TIOCGWINSZ, &mut ws); }
        assert_eq!(ws.ws_col, 500);
        assert_eq!(ws.ws_row, 200);
    }

    // -----------------------------------------------------------------------
    // Sentinel scanning
    // -----------------------------------------------------------------------

    #[test]
    fn sentinel_detected_in_single_chunk() {
        let mut tail = Vec::new();
        let data = b"some output\x1b_AIVM_EXIT:42:0\x1b\\more data";
        let (forward, result) = scan_and_strip_sentinel(&mut tail, data);
        assert_eq!(&forward, b"some output");
        assert_eq!(result, Some((42, 0)));
        assert_eq!(&tail, b"more data");
    }

    #[test]
    fn sentinel_with_nonzero_exit_code() {
        let mut tail = Vec::new();
        let data = b"error output\x1b_AIVM_EXIT:7:127\x1b\\";
        let (forward, result) = scan_and_strip_sentinel(&mut tail, data);
        assert_eq!(&forward, b"error output");
        assert_eq!(result, Some((7, 127)));
    }

    #[test]
    fn sentinel_split_across_two_reads() {
        let mut tail = Vec::new();
        let (forward1, result1) = scan_and_strip_sentinel(
            &mut tail,
            b"output\x1b_AIVM_EX",
        );
        assert!(result1.is_none());
        assert!(!forward1.is_empty());

        let (forward2, result2) = scan_and_strip_sentinel(
            &mut tail,
            b"IT:42:0\x1b\\trailing",
        );
        assert_eq!(result2, Some((42, 0)));
        let mut all_forwarded = forward1.clone();
        all_forwarded.extend_from_slice(&forward2);
        assert_eq!(&all_forwarded, b"output");
        assert_eq!(&tail, b"trailing");
    }

    #[test]
    fn no_sentinel_forwards_data() {
        let mut tail = Vec::new();
        let data = b"just normal terminal output here\n";
        let (forward, result) = scan_and_strip_sentinel(&mut tail, data);
        assert!(result.is_none());
        assert!(!forward.is_empty());
        assert!(forward.len() + tail.len() == data.len());
    }

    #[test]
    fn sentinel_negative_exit_code() {
        let mut tail = Vec::new();
        let data = b"\x1b_AIVM_EXIT:1:-1\x1b\\";
        let (forward, result) = scan_and_strip_sentinel(&mut tail, data);
        assert!(forward.is_empty());
        assert_eq!(result, Some((1, -1)));
    }

    #[test]
    fn parse_sentinel_payload_valid() {
        assert_eq!(parse_sentinel_payload(b"42:0"), Some((42, 0)));
        assert_eq!(parse_sentinel_payload(b"1:127"), Some((1, 127)));
        assert_eq!(parse_sentinel_payload(b"18446744073709551615:0"), Some((u64::MAX, 0)));
    }

    #[test]
    fn parse_sentinel_payload_invalid() {
        assert_eq!(parse_sentinel_payload(b""), None);
        assert_eq!(parse_sentinel_payload(b"42"), None);
        assert_eq!(parse_sentinel_payload(b"abc:0"), None);
        assert_eq!(parse_sentinel_payload(b"42:abc"), None);
    }

    #[test]
    fn find_subsequence_basic() {
        assert_eq!(find_subsequence(b"hello world", b"world"), Some(6));
        assert_eq!(find_subsequence(b"hello world", b"xyz"), None);
        assert_eq!(find_subsequence(b"abc", b"abc"), Some(0));
    }

    // -----------------------------------------------------------------------
    // ShellManager
    // -----------------------------------------------------------------------

    #[test]
    fn shell_manager_insert_and_count() {
        let mgr = ShellManager::new();
        assert_eq!(mgr.count(), 0);

        // Use a real PTY for a valid fd (don't fork).
        let pty = openpty(None, None).expect("openpty");
        let master_fd = pty.master.as_raw_fd();
        std::mem::forget(pty.master); // prevent close

        mgr.insert(Shell { session_id: 0, master_fd, child_pid: Pid::from_raw(1) });
        assert_eq!(mgr.count(), 1);
        assert!(mgr.get_master_fd(0).is_some());
        assert!(mgr.get_master_fd(1).is_none());

        unsafe { libc::close(master_fd); }
        drop(pty.slave);
    }

    #[test]
    fn shell_manager_remove() {
        let mgr = ShellManager::new();
        let pty = openpty(None, None).expect("openpty");
        let master_fd = pty.master.as_raw_fd();
        std::mem::forget(pty.master);

        mgr.insert(Shell { session_id: 5, master_fd, child_pid: Pid::from_raw(1) });
        assert_eq!(mgr.count(), 1);

        let shell = mgr.remove(5).unwrap();
        assert_eq!(shell.session_id, 5);
        assert_eq!(mgr.count(), 0);
        assert!(mgr.remove(5).is_none());

        unsafe { libc::close(master_fd); }
        drop(pty.slave);
    }

    #[test]
    fn shell_manager_fd_snapshot() {
        let mgr = ShellManager::new();
        let pty1 = openpty(None, None).expect("openpty");
        let pty2 = openpty(None, None).expect("openpty");
        let fd1 = pty1.master.as_raw_fd();
        let fd2 = pty2.master.as_raw_fd();
        std::mem::forget(pty1.master);
        std::mem::forget(pty2.master);

        mgr.insert(Shell { session_id: 0, master_fd: fd1, child_pid: Pid::from_raw(1) });
        mgr.insert(Shell { session_id: 1, master_fd: fd2, child_pid: Pid::from_raw(2) });

        let snapshot = mgr.fd_snapshot();
        assert_eq!(snapshot.len(), 2);
        assert!(snapshot.iter().any(|(id, _)| *id == 0));
        assert!(snapshot.iter().any(|(id, _)| *id == 1));

        unsafe { libc::close(fd1); libc::close(fd2); }
        drop(pty1.slave);
        drop(pty2.slave);
    }

    #[test]
    fn shell_manager_max_shells() {
        assert!(MAX_SHELLS >= 2, "MAX_SHELLS should allow at least 2 shells");
        assert!(MAX_SHELLS <= 64, "MAX_SHELLS should be bounded");
    }

    // -----------------------------------------------------------------------
    // Terminal frame I/O
    // -----------------------------------------------------------------------

    #[test]
    fn vsock_to_pty_routes_framed_data() {
        use std::os::unix::net::UnixStream;
        use std::os::unix::io::AsRawFd;

        // Use a UnixStream pair as a fake master fd so we can read what was written.
        let (fake_master_reader, fake_master_writer_end) = UnixStream::pair().unwrap();
        let master_fd = fake_master_writer_end.as_raw_fd();

        let mgr = ShellManager::new();
        mgr.insert(Shell { session_id: 0, master_fd, child_pid: Pid::from_raw(1) });

        let (vsock_write, vsock_read) = UnixStream::pair().unwrap();
        let vsock_read_fd = vsock_read.as_raw_fd();

        // Write a framed terminal message for session 0.
        let frame = encode_terminal_frame(0, b"hello");
        std::io::Write::write_all(&mut &vsock_write, &frame).unwrap();
        drop(vsock_write); // EOF triggers loop exit

        let mgr_arc = Arc::new(mgr);
        let mgr_clone = Arc::clone(&mgr_arc);
        let handle = std::thread::spawn(move || {
            vsock_to_pty_loop(vsock_read_fd, &mgr_clone);
        });

        // Read what was written to the fake master fd.
        fake_master_reader.set_read_timeout(Some(std::time::Duration::from_secs(2))).unwrap();
        let mut buf = [0u8; 64];
        let n = std::io::Read::read(&mut &fake_master_reader, &mut buf).unwrap_or(0);
        assert_eq!(&buf[..n], b"hello", "data should be routed to session 0's master fd");

        handle.join().unwrap();
    }

    #[test]
    fn terminal_frame_encoding_correct() {
        // Verify that encode_terminal_frame produces the expected wire format.
        let frame = encode_terminal_frame(42, b"hello");
        // len field = 4 (session_id) + 5 (data) = 9
        assert_eq!(&frame[0..4], &9u32.to_be_bytes());
        assert_eq!(&frame[4..8], &42u32.to_be_bytes());
        assert_eq!(&frame[8..], b"hello");
    }

    #[test]
    fn terminal_frame_empty_data() {
        let frame = encode_terminal_frame(0, b"");
        assert_eq!(&frame[0..4], &4u32.to_be_bytes()); // len = 4 (session_id only)
        assert_eq!(&frame[4..8], &0u32.to_be_bytes());
        assert_eq!(frame.len(), 8);
    }

    #[test]
    fn vsock_to_pty_and_bridge_roundtrip() {
        use std::os::unix::io::IntoRawFd;
        use std::os::unix::net::UnixStream;

        // Simulate: host sends framed data -> vsock_to_pty_loop routes to master fd
        // -> multi_bridge_loop reads from master fd -> sends framed data back to vsock.
        // We test each half independently since they share the shell manager.

        // Part 1: vsock_to_pty_loop routes data to the correct fd.
        let (master_read, master_write) = UnixStream::pair().unwrap();
        let master_write_fd = master_write.into_raw_fd();

        let mgr = ShellManager::new();
        mgr.insert(Shell { session_id: 7, master_fd: master_write_fd, child_pid: Pid::from_raw(1) });

        let (vsock_host_write, vsock_guest_read) = UnixStream::pair().unwrap();
        let vsock_guest_read_fd = vsock_guest_read.into_raw_fd();

        // Send a frame for session 7.
        let frame = encode_terminal_frame(7, b"routed");
        std::io::Write::write_all(&mut &vsock_host_write, &frame).unwrap();
        // Send a frame for unknown session 99 (should be silently dropped).
        let frame2 = encode_terminal_frame(99, b"dropped");
        std::io::Write::write_all(&mut &vsock_host_write, &frame2).unwrap();
        drop(vsock_host_write); // EOF

        let mgr_arc = Arc::new(mgr);
        let mgr_clone = Arc::clone(&mgr_arc);
        let handle = std::thread::spawn(move || {
            vsock_to_pty_loop(vsock_guest_read_fd, &mgr_clone);
        });

        master_read.set_read_timeout(Some(std::time::Duration::from_secs(2))).unwrap();
        let mut buf = [0u8; 64];
        let n = std::io::Read::read(&mut &master_read, &mut buf).unwrap_or(0);
        assert_eq!(&buf[..n], b"routed", "data should reach session 7's master fd");

        handle.join().unwrap();
        unsafe { libc::close(master_write_fd); libc::close(vsock_guest_read_fd); }
    }
}
