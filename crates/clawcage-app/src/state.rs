use std::collections::{HashMap, VecDeque};
use std::os::unix::io::RawFd;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use clawcage_core::VirtualMachine;
use clawcage_core::HostStateMachine;
use clawcage_core::mcp::gateway::McpGatewayConfig;
use clawcage_core::net::cert_authority::CertAuthority;
use clawcage_core::net::policy::NetworkPolicy;
use clawcage_core::session::SessionIndex;
use clawcage_core::clawcage_proto::DEFAULT_SHELL_SESSION_ID;
use clawcage_logger::DbWriter;

/// Per-VM network state: policy, telemetry DB, and connection tracking.
///
/// Each VM gets its own `VmNetworkState` that is dropped when the VM stops,
/// which prevents cross-VM interference.
pub struct VmNetworkState {
    /// Live network policy. Wrapped in RwLock so `update_setting` can hot-reload
    /// it without restarting the VM. Readers (MITM proxy connections) clone the
    /// inner Arc cheaply; writers swap the entire Arc on policy change.
    pub policy: Arc<RwLock<Arc<NetworkPolicy>>>,
    pub db: Arc<DbWriter>,
    pub ca: Arc<CertAuthority>,
    /// Cached upstream TLS config, created once via `mitm_proxy::make_upstream_tls_config()`.
    pub upstream_tls: Arc<clawcage_core::net::mitm_proxy::UpstreamTlsConfig>,
}

/// A detected listening port in the guest VM.
#[derive(Debug, Clone, serde::Serialize)]
pub struct DetectedPort {
    pub port: u16,
    pub pid: u32,
    pub process: String,
    pub detected_at: u64,
}

/// A forwarded port (guest -> host localhost).
#[derive(Debug, Clone, serde::Serialize)]
pub struct ForwardedPort {
    pub guest_port: u16,
    pub host_port: u16,
}

/// Port state for a running VM.
pub struct PortState {
    pub detected: RwLock<Vec<DetectedPort>>,
    pub forwarded: RwLock<Vec<ForwardedPort>>,
    /// Channel sender for guest relay vsock connections (port 5007).
    pub relay_tx: tokio::sync::mpsc::UnboundedSender<RawFd>,
    /// Channel receiver for guest relay vsock connections (shared across forward tasks).
    pub relay_rx: tokio::sync::Mutex<tokio::sync::mpsc::UnboundedReceiver<RawFd>>,
    /// Abort handles for per-port forwarding background tasks.
    pub forward_tasks: Mutex<HashMap<u16, tokio::task::AbortHandle>>,
}

impl PortState {
    pub fn new() -> Self {
        let (relay_tx, relay_rx) = tokio::sync::mpsc::unbounded_channel();
        Self {
            detected: RwLock::new(Vec::new()),
            forwarded: RwLock::new(Vec::new()),
            relay_tx,
            relay_rx: tokio::sync::Mutex::new(relay_rx),
            forward_tasks: Mutex::new(HashMap::new()),
        }
    }
}

/// Latest system metrics snapshot from the guest VM.
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct SystemMetrics {
    pub cpu_percent: f32,
    pub mem_total_kb: u64,
    pub mem_used_kb: u64,
    pub disk_total_kb: u64,
    pub disk_used_kb: u64,
    /// Unix timestamp (ms) of last update.
    pub updated_at: u64,
}

/// Shared system metrics state for a running VM.
pub struct SystemMetricsState {
    pub latest: RwLock<SystemMetrics>,
}

impl SystemMetricsState {
    pub fn new() -> Self {
        Self {
            latest: RwLock::new(SystemMetrics::default()),
        }
    }
}

/// Per-VM instance state.
pub struct VmInstance {
    pub _vm: VirtualMachine,
    pub serial_input_fd: RawFd,
    pub vsock_terminal_fd: Option<RawFd>,
    pub vsock_control_fd: Option<RawFd>,
    pub net_state: Option<VmNetworkState>,
    pub mcp_state: Option<Arc<McpGatewayConfig>>,
    pub state_machine: HostStateMachine,
    pub _scratch_disk_path: Option<PathBuf>,
    pub port_state: Arc<PortState>,
    /// Per-venv VPN manager. Routes upstream MITM connections through a
    /// WireGuard tunnel when enabled.
    pub vpn_state: Option<Arc<clawcage_core::net::vpn::VpnManager>>,
    /// System metrics from guest (CPU/RAM/disk).
    pub sys_metrics: Arc<SystemMetricsState>,
}

/// Max queued output chunks before dropping to prevent OOM when the frontend
/// stops polling (tab backgrounded, JS hung). Each chunk is typically a few KB
/// from the coalesce buffer.
const TERMINAL_QUEUE_CAPACITY: usize = 64;

/// Lock-free-ish queue for terminal output data.
///
/// The vsock reader pushes raw byte chunks via `push()`. The frontend polls
/// via the `terminal_poll` IPC command which calls `poll()`. When the VM stops,
/// `close()` unblocks any pending poll. On new VM boot, `reset()` reopens the
/// queue for fresh data.
pub struct TerminalOutputQueue {
    data: Mutex<VecDeque<Vec<u8>>>,
    notify: tokio::sync::Notify,
    closed: AtomicBool,
}

impl TerminalOutputQueue {
    pub fn new() -> Self {
        Self {
            data: Mutex::new(VecDeque::new()),
            notify: tokio::sync::Notify::new(),
            closed: AtomicBool::new(false),
        }
    }

    /// Push a chunk of terminal output. Drops the chunk if the queue is at
    /// capacity (backpressure) or closed.
    pub fn push(&self, bytes: Vec<u8>) {
        if self.closed.load(Ordering::Acquire) {
            return;
        }
        let mut queue = self.data.lock().unwrap();
        if queue.len() >= TERMINAL_QUEUE_CAPACITY {
            // Backpressure: drop oldest to make room.
            queue.pop_front();
        }
        queue.push_back(bytes);
        drop(queue);
        self.notify.notify_one();
    }

    /// Async poll for the next chunk. Returns `None` when the queue is closed
    /// and drained.
    pub async fn poll(&self) -> Option<Vec<u8>> {
        loop {
            // Try to pop a chunk under the lock.
            {
                let mut queue = self.data.lock().unwrap();
                if let Some(chunk) = queue.pop_front() {
                    return Some(chunk);
                }
                // Queue is empty. If closed, we're done.
                if self.closed.load(Ordering::Acquire) {
                    return None;
                }
            }
            // Wait for a notification (push or close).
            self.notify.notified().await;
        }
    }


    /// Mark the queue as closed. Wakes any pending `poll()` which will return
    /// `None` once the remaining data is drained.
    pub fn close(&self) {
        self.closed.store(true, Ordering::Release);
        self.notify.notify_one();
    }

    /// Reset the queue for a new VM session. Clears data and reopens.
    pub fn reset(&self) {
        let mut queue = self.data.lock().unwrap();
        queue.clear();
        self.closed.store(false, Ordering::Release);
    }
}

/// Per-session terminal output queues. Each shell session gets its own queue.
/// The default shell (session 0) is always present.
pub struct TerminalOutputMap {
    queues: Mutex<HashMap<u32, Arc<TerminalOutputQueue>>>,
}

impl TerminalOutputMap {
    pub fn new() -> Self {
        let mut map = HashMap::new();
        map.insert(DEFAULT_SHELL_SESSION_ID, Arc::new(TerminalOutputQueue::new()));
        Self {
            queues: Mutex::new(map),
        }
    }

    /// Get or create a queue for a session.
    pub fn get_or_create(&self, session_id: u32) -> Arc<TerminalOutputQueue> {
        let mut queues = self.queues.lock().unwrap();
        queues.entry(session_id)
            .or_insert_with(|| Arc::new(TerminalOutputQueue::new()))
            .clone()
    }

    /// Get a queue for a session (returns None if not found).
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn get(&self, session_id: u32) -> Option<Arc<TerminalOutputQueue>> {
        self.queues.lock().unwrap().get(&session_id).cloned()
    }

    /// Remove and close a session's queue.
    pub fn remove(&self, session_id: u32) {
        if let Some(q) = self.queues.lock().unwrap().remove(&session_id) {
            q.close();
        }
    }

    /// Close all queues (VM shutting down).
    pub fn close_all(&self) {
        let queues = self.queues.lock().unwrap();
        for q in queues.values() {
            q.close();
        }
    }

    /// Reset all queues for a new VM session. Removes non-default sessions
    /// and resets the default queue.
    pub fn reset(&self) {
        let mut queues = self.queues.lock().unwrap();
        // Close and remove all non-default sessions.
        let non_default: Vec<u32> = queues.keys().filter(|&&id| id != DEFAULT_SHELL_SESSION_ID).cloned().collect();
        for id in non_default {
            if let Some(q) = queues.remove(&id) {
                q.close();
            }
        }
        // Reset default queue.
        if let Some(q) = queues.get(&DEFAULT_SHELL_SESSION_ID) {
            q.reset();
        }
    }

    /// List active session IDs.
    pub fn session_ids(&self) -> Vec<u32> {
        self.queues.lock().unwrap().keys().cloned().collect()
    }
}

/// Resolved asset paths, computed once during setup and reused for each VM boot.
pub struct AssetConfig {
    pub assets_dir: PathBuf,
    pub rootfs_path: std::sync::RwLock<Option<PathBuf>>,
}

/// Terminal input message: (vsock_fd, session_id, data).
type TerminalInputMsg = (RawFd, u32, String);

/// Result type for pending file downloads from the guest VM.
pub type DownloadResult = Result<Vec<u8>, String>;

/// Tracks a chunked file download in progress.
pub struct PartialDownload {
    pub total_size: u64,
    pub data: Vec<u8>,
}

pub struct AppState {
    pub vms: Mutex<HashMap<String, VmInstance>>,
    pub session_index: Mutex<SessionIndex>,
    pub active_session_id: Mutex<Option<String>>,
    pub active_venv_id: Mutex<Option<String>>,
    pub terminal_output: Arc<TerminalOutputMap>,
    pub terminal_input_tx: std::sync::mpsc::Sender<TerminalInputMsg>,
    /// Monotonic counter for file download request IDs.
    pub download_id_counter: AtomicU64,
    /// Pending file download requests awaiting guest response.
    pub pending_downloads: Mutex<HashMap<u64, tokio::sync::oneshot::Sender<DownloadResult>>>,
    /// In-progress chunked file downloads accumulating data.
    pub partial_downloads: Mutex<HashMap<u64, PartialDownload>>,
}

impl AppState {
    pub fn new(session_index: SessionIndex) -> Self {
        let (tx, rx) = std::sync::mpsc::channel::<TerminalInputMsg>();

        // Spawn a dedicated global thread for batching terminal input writes.
        // Now sends framed data: [4B len][4B session_id][data] per the multi-shell protocol.
        std::thread::spawn(move || {
            use std::io::Write;
            let mut current_fd: Option<RawFd> = None;
            let mut current_file: Option<std::fs::File> = None;

            /// Max bytes to coalesce before flushing. Prevents unbounded memory
            /// growth if the channel is flooded faster than the inner try_recv
            /// loop can drain.
            const MAX_BATCH_SIZE: usize = 64 * 1024;

            while let Ok((fd, session_id, data)) = rx.recv() {
                let mut buf = data.into_bytes();
                // Coalesce rapid sequential inputs for the same fd + session.
                while buf.len() < MAX_BATCH_SIZE {
                    match rx.try_recv() {
                        Ok((next_fd, next_sid, next_data)) if next_fd == fd && next_sid == session_id => {
                            buf.extend(next_data.into_bytes());
                        }
                        Ok(_) => break,
                        Err(_) => break,
                    }
                }

                // Reuse the file handle if it's the same FD.
                if current_fd != Some(fd) {
                    current_fd = Some(fd);
                    current_file = crate::clone_fd(fd).ok();
                }

                if let Some(mut file) = current_file.as_ref() {
                    // Write framed terminal data.
                    let frame = clawcage_core::clawcage_proto::encode_terminal_frame(session_id, &buf);
                    let _ = file.write_all(&frame);
                    let _ = file.flush();
                }
            }
        });

        Self {
            vms: Mutex::new(HashMap::new()),
            session_index: Mutex::new(session_index),
            active_session_id: Mutex::new(None),
            active_venv_id: Mutex::new(None),
            terminal_output: Arc::new(TerminalOutputMap::new()),
            terminal_input_tx: tx,
            download_id_counter: AtomicU64::new(1),
            pending_downloads: Mutex::new(HashMap::new()),
            partial_downloads: Mutex::new(HashMap::new()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_state_has_no_vms() {
        let idx = SessionIndex::open_in_memory().unwrap();
        let state = AppState::new(idx);
        let vms = state.vms.lock().unwrap();
        assert!(vms.is_empty());
    }

    #[test]
    fn mutex_is_not_poisoned_on_creation() {
        let idx = SessionIndex::open_in_memory().unwrap();
        let state = AppState::new(idx);
        assert!(!state.vms.is_poisoned());
        assert!(!state.session_index.is_poisoned());
        assert!(!state.active_session_id.is_poisoned());
    }

    #[test]
    fn active_session_starts_none() {
        let idx = SessionIndex::open_in_memory().unwrap();
        let state = AppState::new(idx);
        assert!(state.active_session_id.lock().unwrap().is_none());
    }

    // -----------------------------------------------------------------------
    // TerminalOutputQueue
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn queue_push_poll_roundtrip() {
        let q = TerminalOutputQueue::new();
        q.push(b"hello".to_vec());
        let chunk = q.poll().await;
        assert_eq!(chunk.unwrap(), b"hello");
    }

    #[tokio::test]
    async fn queue_poll_returns_none_when_closed() {
        let q = TerminalOutputQueue::new();
        q.close();
        assert!(q.poll().await.is_none());
    }

    #[tokio::test]
    async fn queue_drains_before_returning_none() {
        let q = TerminalOutputQueue::new();
        q.push(b"a".to_vec());
        q.push(b"b".to_vec());
        q.close();
        assert_eq!(q.poll().await.unwrap(), b"a");
        assert_eq!(q.poll().await.unwrap(), b"b");
        assert!(q.poll().await.is_none());
    }

    #[tokio::test]
    async fn queue_reset_reopens() {
        let q = TerminalOutputQueue::new();
        q.push(b"old".to_vec());
        q.close();
        q.reset();
        q.push(b"new".to_vec());
        assert_eq!(q.poll().await.unwrap(), b"new");
    }

    #[tokio::test]
    async fn queue_multiple_pushes_drain_fifo() {
        let q = TerminalOutputQueue::new();
        q.push(b"1".to_vec());
        q.push(b"2".to_vec());
        q.push(b"3".to_vec());
        assert_eq!(q.poll().await.unwrap(), b"1");
        assert_eq!(q.poll().await.unwrap(), b"2");
        assert_eq!(q.poll().await.unwrap(), b"3");
    }

    #[test]
    fn queue_backpressure_drops_oldest() {
        let q = TerminalOutputQueue::new();
        // Fill to capacity.
        for i in 0..TERMINAL_QUEUE_CAPACITY {
            q.push(vec![i as u8]);
        }
        // One more push should drop the oldest (0).
        q.push(vec![99]);
        let queue = q.data.lock().unwrap();
        assert_eq!(queue.len(), TERMINAL_QUEUE_CAPACITY);
        assert_eq!(queue[0], vec![1]); // oldest is now 1, not 0
        assert_eq!(queue[TERMINAL_QUEUE_CAPACITY - 1], vec![99]);
    }

    #[test]
    fn queue_push_ignored_when_closed() {
        let q = TerminalOutputQueue::new();
        q.close();
        q.push(b"nope".to_vec());
        let queue = q.data.lock().unwrap();
        assert!(queue.is_empty());
    }

    #[tokio::test]
    async fn queue_poll_wakes_on_push() {
        let q = Arc::new(TerminalOutputQueue::new());
        let q2 = Arc::clone(&q);
        let handle = tokio::spawn(async move {
            q2.poll().await
        });
        // Give the poll a moment to park.
        tokio::task::yield_now().await;
        q.push(b"wake".to_vec());
        let result = handle.await.unwrap();
        assert_eq!(result.unwrap(), b"wake");
    }

    #[tokio::test]
    async fn queue_poll_wakes_on_close() {
        let q = Arc::new(TerminalOutputQueue::new());
        let q2 = Arc::clone(&q);
        let handle = tokio::spawn(async move {
            q2.poll().await
        });
        tokio::task::yield_now().await;
        q.close();
        let result = handle.await.unwrap();
        assert!(result.is_none());
    }

    /// Verify that the terminal input batching thread flushes within bounded
    /// time even when the channel is flooded. Data is now framed, so we check
    /// total bytes received (framing adds 8 bytes per batch).
    #[test]
    fn terminal_input_batch_caps_at_max_size() {
        use std::io::Read;
        use std::os::unix::io::{FromRawFd, IntoRawFd};

        let idx = SessionIndex::open_in_memory().unwrap();
        let state = AppState::new(idx);

        let (read_end, write_end) = std::os::unix::net::UnixStream::pair().unwrap();
        let fd = write_end.into_raw_fd();

        let msg_count = 200;
        let msg = "x".repeat(1024); // 1 KB each
        for _ in 0..msg_count {
            state.terminal_input_tx.send((fd, DEFAULT_SHELL_SESSION_ID, msg.clone())).unwrap();
        }

        // The batching thread now writes framed data. Each batch gets an 8-byte
        // header. Total bytes > msg_count * msg.len() due to framing.
        let mut total_read = 0usize;
        let min_expected = msg_count * msg.len(); // at least this much payload
        let mut read_end = read_end;
        read_end.set_read_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
        let mut buf = [0u8; 8192];
        loop {
            match read_end.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    total_read += n;
                    if total_read >= min_expected { break; }
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock
                       || e.kind() == std::io::ErrorKind::TimedOut => {
                    break;
                }
                Err(e) => panic!("unexpected read error: {e}"),
            }
        }
        assert!(total_read >= min_expected, "all data should arrive (got {total_read}, expected >= {min_expected})");

        drop(unsafe { std::fs::File::from_raw_fd(fd) });
    }

    #[test]
    fn app_state_has_terminal_output_map() {
        let idx = SessionIndex::open_in_memory().unwrap();
        let state = AppState::new(idx);
        // Default queue should exist and be open.
        let q = state.terminal_output.get(DEFAULT_SHELL_SESSION_ID).unwrap();
        let queue = q.data.lock().unwrap();
        assert!(queue.is_empty());
        assert!(!q.closed.load(Ordering::Acquire));
    }

    // -----------------------------------------------------------------------
    // TerminalOutputMap
    // -----------------------------------------------------------------------

    #[test]
    fn output_map_default_session_exists() {
        let map = TerminalOutputMap::new();
        assert!(map.get(DEFAULT_SHELL_SESSION_ID).is_some());
        assert!(map.get(999).is_none());
    }

    #[test]
    fn output_map_get_or_create() {
        let map = TerminalOutputMap::new();
        let q = map.get_or_create(5);
        q.push(b"hello".to_vec());
        let q2 = map.get(5).unwrap();
        let queue = q2.data.lock().unwrap();
        assert_eq!(queue.len(), 1);
    }

    #[test]
    fn output_map_remove_closes_queue() {
        let map = TerminalOutputMap::new();
        let q = map.get_or_create(3);
        map.remove(3);
        assert!(q.closed.load(Ordering::Acquire));
        assert!(map.get(3).is_none());
    }

    #[test]
    fn output_map_reset_keeps_only_default() {
        let map = TerminalOutputMap::new();
        map.get_or_create(1);
        map.get_or_create(2);
        assert_eq!(map.session_ids().len(), 3);
        map.reset();
        assert_eq!(map.session_ids(), vec![DEFAULT_SHELL_SESSION_ID]);
    }

    #[test]
    fn output_map_close_all() {
        let map = TerminalOutputMap::new();
        let q0 = map.get(DEFAULT_SHELL_SESSION_ID).unwrap();
        let q1 = map.get_or_create(1);
        map.close_all();
        assert!(q0.closed.load(Ordering::Acquire));
        assert!(q1.closed.load(Ordering::Acquire));
    }
}
