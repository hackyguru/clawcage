#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod state;
mod venvs;

use std::io::{Read, Write};
use std::mem::ManuallyDrop;
use std::os::unix::io::{FromRawFd, RawFd};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use clawcage_core::{
    GuestToHost, HostState, HostStateMachine, HostToGuest, VirtualMachine,
    VmConfig, VsockManager, VSOCK_PORT_CONTROL, VSOCK_PORT_FS_WATCH, VSOCK_PORT_MCP_GATEWAY,
    VSOCK_PORT_PORT_FORWARD, VSOCK_PORT_PORT_WATCH, VSOCK_PORT_SNI_PROXY, VSOCK_PORT_SYS_WATCH,
    VSOCK_PORT_TERMINAL,
    create_scratch_disk, decode_guest_msg, encode_host_msg, validate_guest_msg, MAX_FRAME_SIZE,
};
use clawcage_core::asset_manager::{self, AssetManager};
use clawcage_core::mcp::gateway::{self, McpGatewayConfig};
use clawcage_core::mcp::policy::McpPolicy;
use clawcage_core::mcp::server_manager::McpServerManager;
use clawcage_core::net::cert_authority::CertAuthority;
use clawcage_core::net::mitm_proxy::{self, MitmProxyConfig, ProxyLimits, RateLimiterMap, CredentialKind};
use clawcage_core::net::policy_config;
use clawcage_logger::DbWriter;
use clawcage_core::session::{self, SessionIndex, SessionRecord};
use state::{AppState, AssetConfig, VmInstance, VmNetworkState};
use tauri::{Emitter, Manager};
use tokio::sync::broadcast;
use tracing::{debug_span, error, info, info_span, warn};
use tracing_subscriber::fmt::format::FmtSpan;
use tracing_subscriber::EnvFilter;

/// Clone a raw fd into an independently-owned File.
/// The original fd remains open and unaffected.
pub(crate) fn clone_fd(fd: RawFd) -> std::io::Result<std::fs::File> {
    // Safety: fd is valid (checked by caller context)
    let file = ManuallyDrop::new(unsafe { std::fs::File::from_raw_fd(fd) });
    file.try_clone() // creates a dup'd fd owned by the returned File
}

/// Find the assets directory containing kernel, initrd, and rootfs.
///
/// Checks (in order):
/// 1. `CLAWCAGE_ASSETS_DIR` env var (development override)
/// 2. macOS .app bundle: `Contents/Resources/` (sibling of `Contents/MacOS/`)
/// 3. `./assets` (workspace root, for `cargo run`)
/// 4. `../../assets` (when CWD is `crates/clawcage-app/`)
fn resolve_assets_dir() -> Result<PathBuf> {
    let _span = debug_span!("resolve_assets").entered();
    // 1. Explicit env var (development override)
    if let Ok(dir) = std::env::var("CLAWCAGE_ASSETS_DIR") {
        let p = PathBuf::from(dir);
        if p.join("vmlinuz").exists() {
            return Ok(p);
        }
    }

    // 2. macOS .app bundle: Contents/Resources/ (sibling of Contents/MacOS/)
    if let Ok(exe) = std::env::current_exe() {
        if let Some(macos_dir) = exe.parent() {
            if let Some(resources) = macos_dir.parent().map(|p| p.join("Resources")) {
                let search_paths = [
                    resources.clone(),
                    resources.join("assets"),
                    // Tauri v2 relative structure fallback
                    resources.join("_up_/_up_/assets"),
                ];
                for path in search_paths {
                    if path.join("vmlinuz").exists() {
                        info!(path = %path.display(), "found bundled assets");
                        return Ok(path);
                    }
                }
            }
        }
    }

    // 3. ./assets (workspace root, for `cargo run`)
    let cwd_assets = PathBuf::from("assets");
    if cwd_assets.join("vmlinuz").exists() {
        return Ok(cwd_assets);
    }

    // 4. ../../assets (when CWD is crates/clawcage-app/)
    let parent_assets = PathBuf::from("../../assets");
    if parent_assets.join("vmlinuz").exists() {
        return Ok(parent_assets);
    }

    Err(anyhow::anyhow!(
        "VM assets not found. Set CLAWCAGE_ASSETS_DIR or run from workspace root."
    ))
}

/// Resolve rootfs path, checking bundled assets first, then ~/.clawcage/assets/.
fn resolve_rootfs(bundled_assets: &Path) -> Option<PathBuf> {
    let bundled = bundled_assets.join("rootfs.squashfs");
    if bundled.exists() {
        return Some(bundled);
    }
    if let Some(download_dir) = asset_manager::default_assets_dir() {
        let downloaded = download_dir.join("rootfs.squashfs");
        if downloaded.exists() {
            return Some(downloaded);
        }
    }
    None
}

/// Load B3SUMS manifest from bundled assets and create an AssetManager.
fn create_asset_manager(bundled_assets: &Path) -> Result<AssetManager> {
    let b3sums_path = bundled_assets.join("B3SUMS");
    let b3sums_content = std::fs::read_to_string(&b3sums_path)
        .context("B3SUMS not found in app bundle")?;
    let version = env!("CARGO_PKG_VERSION");
    let download_dir = asset_manager::default_assets_dir()
        .context("cannot determine home directory")?;
    let base_url = asset_manager::release_url(version);
    AssetManager::new(download_dir, base_url, &b3sums_content)
}

/// Find the rootfs filename in the manifest.
fn rootfs_manifest_name(mgr: &AssetManager) -> Result<String> {
    mgr.manifest_filenames()
        .into_iter()
        .find(|f| f.starts_with("rootfs"))
        .map(String::from)
        .context("no rootfs entry in B3SUMS manifest")
}

/// Write boot performance data from the state machine to ~/.clawcage/perf/<timestamp>.log
fn write_perf_log(sm: &HostStateMachine) {
    let log = sm.format_perf_log();
    if log.is_empty() {
        return;
    }
    eprint!("{log}");
    let home = match std::env::var("HOME") {
        Ok(h) => PathBuf::from(h),
        Err(_) => return,
    };
    let dir = home.join(".clawcage").join("perf");
    let _ = std::fs::create_dir_all(&dir);
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let path = dir.join(format!("{ts}.log"));
    let _ = std::fs::write(&path, &log);
    eprintln!("perf log: {}", path.display());
}

/// Get the sessions base directory: ~/.clawcage/sessions/
fn sessions_dir() -> Option<PathBuf> {
    std::env::var("HOME").ok().map(|h| {
        PathBuf::from(h).join(".clawcage").join("sessions")
    })
}

/// Get the session directory for a specific VM: ~/.clawcage/sessions/<vm_id>/
fn session_dir_for(vm_id: &str) -> Option<PathBuf> {
    sessions_dir().map(|d| d.join(vm_id))
}

/// Clean up stale sessions on app startup using SessionIndex.
///
/// Deletes any leftover scratch.img files (always ephemeral) and marks
/// any "running" sessions as "crashed" (stale from ungraceful exit).
/// Also runs vacuum recovery, age/count/disk-based culling, and terminated purging.
fn cleanup_stale_sessions(index: &SessionIndex) {
    let base = match sessions_dir() {
        Some(d) => d,
        None => return,
    };

    // Delete leftover scratch.img files from all session dirs.
    if let Ok(entries) = std::fs::read_dir(&base) {
        for entry in entries.flatten() {
            let dir = entry.path();
            if !dir.is_dir() {
                continue;
            }
            let scratch = dir.join("scratch.img");
            if scratch.exists() {
                info!(path = %scratch.display(), "deleting stale scratch.img");
                let _ = std::fs::remove_file(&scratch);
            }
        }
    }

    // Mark stale "running" sessions as "crashed" in main.db.
    match index.mark_running_as_crashed() {
        Ok(0) => {}
        Ok(n) => info!(count = n, "marked stale sessions as crashed"),
        Err(e) => warn!("failed to mark stale sessions: {e}"),
    }

    // Backfill: for crashed sessions with zero stats but a session.db on disk,
    // retroactively populate the summary tables.
    if let Ok(sessions) = index.recent(1000) {
        for rec in &sessions {
            if rec.status != "crashed" && rec.status != "stopped" {
                continue;
            }
            // Skip sessions that already have data.
            if rec.total_input_tokens > 0 || rec.total_tool_calls > 0 {
                continue;
            }
            let db_path = base.join(&rec.id).join("session.db");
            if !db_path.exists() {
                continue;
            }
            if let Ok(reader) = clawcage_logger::DbReader::open(&db_path) {
                flush_session_summary(&rec.id, index, &reader);
                // Also backfill request counts if zero.
                if rec.total_requests == 0 {
                    if let Ok((total, allowed, denied)) = reader.net_event_counts() {
                        let _ = index.update_request_counts(
                            &rec.id,
                            total as u64,
                            allowed as u64,
                            denied as u64,
                        );
                    }
                }
                info!(id = %rec.id, "backfilled session summary");
            }
        }
    }

    // Vacuum recovery: compress any stopped/crashed sessions not yet vacuumed.
    if let Ok(unvacuumed) = index.unvacuumed_sessions() {
        for rec in &unvacuumed {
            let session_dir = base.join(&rec.id);
            vacuum_session(&rec.id, index, &session_dir);
        }
    }

    // Age-based culling (terminate, not delete).
    let settings = policy_config::load_merged_settings();
    let retention_days = settings.iter()
        .find(|s| s.id == "vm.retention_days")
        .and_then(|s| s.effective_value.as_number())
        .unwrap_or(30) as u32;
    let max_sessions = settings.iter()
        .find(|s| s.id == "vm.max_sessions")
        .and_then(|s| s.effective_value.as_number())
        .unwrap_or(100) as usize;
    let max_disk_gb = settings.iter()
        .find(|s| s.id == "vm.max_disk_gb")
        .and_then(|s| s.effective_value.as_number())
        .unwrap_or(100) as u64;
    let terminated_retention_days = settings.iter()
        .find(|s| s.id == "vm.terminated_retention_days")
        .and_then(|s| s.effective_value.as_number())
        .unwrap_or(365) as u32;

    if let Ok(n) = index.terminate_older_than_days(retention_days) {
        if n > 0 {
            info!(count = n, "terminated old sessions (>{retention_days} days)");
        }
    }
    if let Ok(n) = index.terminate_excess_sessions(max_sessions) {
        if n > 0 {
            info!(count = n, "terminated sessions over cap ({max_sessions})");
        }
    }

    // Disk-based culling.
    let max_disk_bytes = max_disk_gb * 1024 * 1024 * 1024;
    let mut usage = session::disk_usage_bytes(&base);
    if usage > max_disk_bytes {
        if let Ok(stopped) = index.stopped_sessions_oldest_first() {
            for rec in stopped {
                if usage <= max_disk_bytes {
                    break;
                }
                let dir = base.join(&rec.id);
                if dir.is_dir() {
                    let dir_bytes = session::disk_usage_bytes(&dir);
                    if let Err(e) = std::fs::remove_dir_all(&dir) {
                        warn!(id = %rec.id, "failed to remove session dir: {e}");
                        continue;
                    }
                    usage = usage.saturating_sub(dir_bytes);
                    let _ = index.mark_terminated(&rec.id);
                    info!(id = %rec.id, "culled session dir for disk budget");
                }
            }
        }
    }

    // Delete disk artifacts for terminated sessions that still have directories.
    if let Ok(terminated) = index.sessions_by_status("terminated") {
        for rec in &terminated {
            let dir = base.join(&rec.id);
            if dir.is_dir() {
                let _ = std::fs::remove_dir_all(&dir);
            }
        }
    }

    // Purge old terminated records from main.db.
    if let Ok(n) = index.purge_terminated_older_than_days(terminated_retention_days) {
        if n > 0 {
            info!(count = n, "purged terminated records (>{terminated_retention_days} days)");
        }
    }

    // Remove orphan session dirs that no longer have a DB record.
    if let Ok(entries) = std::fs::read_dir(&base) {
        let known_ids: std::collections::HashSet<String> = index
            .recent(10_000)
            .unwrap_or_default()
            .into_iter()
            .map(|r| r.id)
            .collect();
        for entry in entries.flatten() {
            let dir = entry.path();
            if !dir.is_dir() {
                continue;
            }
            let name = match dir.file_name().and_then(|n| n.to_str()) {
                Some(n) => n.to_string(),
                None => continue,
            };
            if !session::is_valid_session_id(&name) {
                continue;
            }
            if !known_ids.contains(&name) {
                if let Err(e) = std::fs::remove_dir_all(&dir) {
                    warn!(id = %name, "failed to remove orphan session dir: {e}");
                } else {
                    info!(id = %name, "removed orphan session dir");
                }
            }
        }
    }

    // Checkpoint main.db after all cleanup.
    let _ = index.checkpoint();
}

/// Vacuum and compress a session DB, updating the index on success.
fn vacuum_session(session_id: &str, index: &SessionIndex, session_dir: &std::path::Path) {
    match session::vacuum_and_compress_session_db(session_dir) {
        Ok(compressed_size) => {
            let _ = index.mark_vacuumed(session_id, compressed_size, &session::now_iso());
            info!(id = %session_id, compressed_size, "vacuumed session DB");
        }
        Err(e) => {
            warn!(id = %session_id, "failed to vacuum session DB: {e:#}");
        }
    }
}

/// Clean up a VM session: delete scratch.img, snapshot request counts, update status.
fn cleanup_session(
    _session_dir: &Path,
    scratch_path: Option<&Path>,
    session_id: &str,
    index: &SessionIndex,
    db: Option<&DbWriter>,
) {
    if let Some(scratch) = scratch_path {
        if scratch.exists() {
            info!(path = %scratch.display(), "deleting scratch.img");
            if let Err(e) = std::fs::remove_file(scratch) {
                warn!("failed to delete scratch.img: {e}");
            }
        }
    }

    // Snapshot request counts + summary data.
    if let Some(writer) = db {
        if let Ok(reader) = writer.reader() {
            if let Ok((total, allowed, denied)) = reader.net_event_counts() {
                let _ = index.update_request_counts(
                    session_id,
                    total as u64,
                    allowed as u64,
                    denied as u64,
                );
            }
            flush_session_summary(session_id, index, &reader);
        }
    }

    let _ = index.update_status(session_id, "stopped", Some(&session::now_iso()));
}

/// Flush per-session summary data from info.db into main.db.
fn flush_session_summary(
    session_id: &str,
    index: &SessionIndex,
    reader: &clawcage_logger::DbReader,
) {
    use clawcage_core::session::{McpToolSummary, ProviderSummary, ToolSummary};

    // Session-level summary.
    if let Ok(stats) = reader.session_stats() {
        let file_events = reader.file_event_count().unwrap_or(0);
        let mcp_calls = reader.mcp_call_stats().map(|s| s.total).unwrap_or(0);
        let _ = index.update_session_summary(
            session_id,
            stats.total_input_tokens,
            stats.total_output_tokens,
            stats.total_estimated_cost_usd,
            stats.total_tool_calls,
            mcp_calls,
            file_events,
        );
    }

    // Provider usage.
    if let Ok(providers) = reader.token_usage_by_provider() {
        let summaries: Vec<ProviderSummary> = providers
            .into_iter()
            .map(|p| ProviderSummary {
                provider: p.provider,
                call_count: p.call_count,
                input_tokens: p.total_input_tokens,
                output_tokens: p.total_output_tokens,
                estimated_cost: p.total_estimated_cost_usd,
                total_duration_ms: p.total_duration_ms,
            })
            .collect();
        let _ = index.replace_ai_usage(session_id, &summaries);
    }

    // Tool usage.
    if let Ok(tools) = reader.tool_usage_with_stats(50) {
        let summaries: Vec<ToolSummary> = tools
            .into_iter()
            .map(|t| ToolSummary {
                tool_name: t.tool_name,
                call_count: t.count,
                total_bytes: t.total_bytes,
                total_duration_ms: t.total_duration_ms,
            })
            .collect();
        let _ = index.replace_tool_usage(session_id, &summaries);
    }

    // MCP tool usage.
    if let Ok(mcp_tools) = reader.mcp_tool_usage(50) {
        let summaries: Vec<McpToolSummary> = mcp_tools
            .into_iter()
            .map(|m| McpToolSummary {
                tool_name: m.tool_name,
                server_name: m.server_name,
                call_count: m.count,
                total_bytes: m.total_bytes,
                total_duration_ms: m.total_duration_ms,
            })
            .collect();
        let _ = index.replace_mcp_usage(session_id, &summaries);
    }
}

/// Static CA keypair embedded at compile time.
const CA_KEY_PEM: &str = include_str!("../../../config/clawcage-ca.key");
const CA_CERT_PEM: &str = include_str!("../../../config/clawcage-ca.crt");

/// Create per-VM network state: load CA, network policy, and open session DB.
fn create_net_state(vm_id: &str) -> Result<VmNetworkState> {
    create_net_state_for_venv(vm_id, None)
}

fn create_net_state_for_venv(vm_id: &str, venv_id: Option<&str>) -> Result<VmNetworkState> {
    let ca = CertAuthority::load(CA_KEY_PEM, CA_CERT_PEM)
        .context("failed to load MITM CA")?;
    info!(vm_id, "loaded MITM CA");

    let policy = policy_config::load_merged_network_policy_for_venv(venv_id);
    info!(
        vm_id,
        "loaded network policy ({} rules)",
        policy.rules.len()
    );

    // Session directory: ~/.clawcage/sessions/<vm_id>/
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    let session_dir = PathBuf::from(home)
        .join(".clawcage")
        .join("sessions")
        .join(vm_id);
    let db_path = session_dir.join("session.db");
    let db = DbWriter::open(&db_path, 4096).context("failed to open session db")?;
    info!(path = %db_path.display(), "opened session db");

    Ok(VmNetworkState {
        policy: Arc::new(std::sync::RwLock::new(Arc::new(policy))),
        db: Arc::new(db),
        ca: Arc::new(ca),
        upstream_tls: mitm_proxy::make_upstream_tls_config(),
    })
}

/// Build config, create VM, start it, and return the VM + serial receiver + input fd + state machine.
///
/// If `scratch_disk_path` is provided, the scratch disk is attached as a second
/// block device (read-write) for the guest `/root` workspace.
fn boot_vm(
    assets: &Path,
    rootfs_override: Option<&Path>,
    cmdline: &str,
    scratch_disk_path: Option<&Path>,
    cpu_count: u32,
    ram_bytes: u64,
) -> Result<(VirtualMachine, broadcast::Receiver<Vec<u8>>, RawFd, HostStateMachine)> {
    let _span = info_span!("boot_vm").entered();
    let mut sm = HostStateMachine::new_host();

    let config = {
        let _span = debug_span!("config_build").entered();
        let mut builder = VmConfig::builder()
            .cpu_count(cpu_count)
            .ram_bytes(ram_bytes)
            .kernel_path(assets.join("vmlinuz"))
            .kernel_cmdline(cmdline);

        if let Some(hash) = option_env!("VMLINUZ_HASH") {
            builder = builder.expected_kernel_hash(hash);
        }

        if assets.join("initrd.img").exists() {
            builder = builder.initrd_path(assets.join("initrd.img"));
            if let Some(hash) = option_env!("INITRD_HASH") {
                builder = builder.expected_initrd_hash(hash);
            }
        }

        // Use explicit rootfs override if provided (e.g. from ~/.clawcage/assets/),
        // otherwise check bundled assets dir for both squashfs and legacy img.
        let rootfs_path = rootfs_override
            .map(|p| p.to_path_buf())
            .or_else(|| {
                Some(assets.join("rootfs.squashfs"))
                    .filter(|p| p.exists())
            });

        if let Some(ref rootfs) = rootfs_path {
            builder = builder.disk_path(rootfs);
            if let Some(hash) = option_env!("ROOTFS_HASH") {
                builder = builder.expected_disk_hash(hash);
            }
        }

        if let Some(scratch) = scratch_disk_path {
            builder = builder.scratch_disk_path(scratch);
        }

        builder.build().context("failed to build VmConfig")?
    };

    let (mut vm, rx, input_fd) = {
        let _span = debug_span!("vm_create").entered();
        VirtualMachine::create(&config).context("failed to create VM")?
    };

    {
        let _span = debug_span!("vm_start").entered();
        vm.start().context("failed to start VM")?;
    }

    sm.transition(HostState::Booting, "vm_started")?;

    Ok((vm, rx, input_fd, sm))
}

/// Forward serial console bytes to the default terminal output queue.
async fn serial_to_events(
    terminal_output: Arc<state::TerminalOutputMap>,
    mut rx: broadcast::Receiver<Vec<u8>>,
) {
    let queue = terminal_output.get_or_create(clawcage_core::clawcage_proto::DEFAULT_SHELL_SESSION_ID);
    loop {
        match rx.recv().await {
            Ok(bytes) => {
                queue.push(bytes);
            }
            Err(broadcast::error::RecvError::Closed) => {
                info!("serial broadcast channel closed");
                break;
            }
            Err(broadcast::error::RecvError::Lagged(n)) => {
                info!("serial receiver lagged by {n} messages");
            }
        }
    }
}

/// Forward framed vsock terminal data to per-session output queues.
///
/// Reads framed data [4B len][4B session_id][data] from the vsock fd in a
/// blocking thread, parses frames, and routes each to the correct session's
/// TerminalOutputQueue. Per-session coalescing is applied.
async fn vsock_terminal_to_events(
    terminal_output: Arc<state::TerminalOutputMap>,
    vsock_fd: RawFd,
) {
    // Channel carries parsed (session_id, data) tuples.
    let (tx, mut rx) = tokio::sync::mpsc::channel::<(u32, Vec<u8>)>(128);

    // Blocking reader thread: vsock fd -> parse frames -> channel
    std::thread::spawn(move || {
        let mut file = match clone_fd(vsock_fd) {
            Ok(f) => f,
            Err(e) => {
                error!("vsock terminal: failed to clone fd: {e}");
                return;
            }
        };
        let mut header = [0u8; clawcage_core::clawcage_proto::TERMINAL_FRAME_HEADER_SIZE];
        loop {
            // Read frame header: [4B len][4B session_id]
            if file.read_exact(&mut header).is_err() {
                break;
            }
            let len = u32::from_be_bytes([header[0], header[1], header[2], header[3]]) as usize;
            let session_id = u32::from_be_bytes([header[4], header[5], header[6], header[7]]);

            if len < 4 {
                warn!("vsock terminal: invalid frame len={len}");
                break;
            }
            let data_len = len - 4;
            if data_len == 0 {
                continue;
            }
            let mut data = vec![0u8; data_len];
            if file.read_exact(&mut data).is_err() {
                break;
            }
            if tx.blocking_send((session_id, data)).is_err() {
                break;
            }
        }
    });

    // Collect incoming frames into a batch, then flush per-session.
    let mut pending: Vec<(u32, Vec<u8>)> = Vec::new();

    loop {
        match rx.recv().await {
            Some(first) => {
                pending.push(first);

                // Coalesce additional frames within a short time window.
                let deadline = tokio::time::Instant::now() + Duration::from_millis(5);
                loop {
                    match tokio::time::timeout_at(deadline, rx.recv()).await {
                        Ok(Some(item)) => pending.push(item),
                        _ => break,
                    }
                }

                // Group by session_id and push to appropriate queues.
                // Sort so same-session chunks are adjacent.
                pending.sort_by_key(|(sid, _)| *sid);
                let mut i = 0;
                while i < pending.len() {
                    let sid = pending[i].0;
                    let queue = terminal_output.get_or_create(sid);
                    // Collect all contiguous chunks for this session.
                    let mut combined = Vec::new();
                    while i < pending.len() && pending[i].0 == sid {
                        combined.extend_from_slice(&pending[i].1);
                        i += 1;
                    }
                    queue.push(combined);
                }
                pending.clear();
            }
            None => break,
        }
    }
}

/// Handle vsock control channel: read incoming messages, handle heartbeat.
/// Called AFTER the boot handshake (Ready/BootConfig/BootReady already consumed).
/// Validates each incoming message against the host state machine before processing.
async fn vsock_control_handler(app_handle: tauri::AppHandle, control_fd: RawFd, session_id: String, venv_id: String) {
    let (tx, mut rx) = tokio::sync::mpsc::channel::<GuestToHost>(32);

    // Blocking reader thread for control messages.
    std::thread::spawn(move || {
        let mut file = match clone_fd(control_fd) {
            Ok(f) => f,
            Err(e) => {
                warn!("vsock control: failed to clone fd: {e}");
                return;
            }
        };
        loop {
            // Read length prefix.
            let mut len_buf = [0u8; 4];
            if file.read_exact(&mut len_buf).is_err() {
                break;
            }
            let len = u32::from_be_bytes(len_buf) as usize;
            if len > MAX_FRAME_SIZE as usize {
                warn!("vsock control: frame too large ({len} bytes), dropping connection");
                break;
            }
            let mut payload = vec![0u8; len];
            if file.read_exact(&mut payload).is_err() {
                break;
            }
            match decode_guest_msg(&payload) {
                Ok(msg) => {
                    if tx.blocking_send(msg).is_err() {
                        break;
                    }
                }
                Err(e) => {
                    warn!("vsock control: decode error: {e}");
                }
            }
        }
    });

    while let Some(msg) = rx.recv().await {
        // Validate incoming guest message against host state machine.
        {
            let state = app_handle.state::<AppState>();
            let vms = state.vms.lock().unwrap();
            if let Some(instance) = vms.get(&session_id) {
                if let Err(e) = validate_guest_msg(&msg, instance.state_machine.state()) {
                    warn!("vsock: rejected control message: {e}");
                    continue;
                }
            }
        }
        match msg {
            GuestToHost::Pong => {
                info!("vsock: heartbeat pong received");
            }
            GuestToHost::ExecDone { id, exit_code } => {
                info!("vsock: exec done (id={id}, exit_code={exit_code})");
            }
            GuestToHost::ShellReady { session_id: shell_sid } => {
                info!("vsock: shell {shell_sid} ready");
                // Ensure output queue exists for the new session.
                let state = app_handle.state::<AppState>();
                if let Some(terminal_output) = state.terminal_output_for(&venv_id) {
                    terminal_output.get_or_create(shell_sid);
                }
                let _ = app_handle.emit("shell-ready", serde_json::json!({
                    "session_id": shell_sid,
                }));
            }
            GuestToHost::ShellClosed { session_id: shell_sid, exit_code } => {
                info!("vsock: shell {shell_sid} closed (exit_code={exit_code})");
                let state = app_handle.state::<AppState>();
                if let Some(terminal_output) = state.terminal_output_for(&venv_id) {
                    terminal_output.remove(shell_sid);
                }
                let _ = app_handle.emit("shell-closed", serde_json::json!({
                    "session_id": shell_sid,
                    "exit_code": exit_code,
                }));
            }
            GuestToHost::FileContent { id, path, data } => {
                info!("vsock: file content received (id={id}, path={path}, {} bytes)", data.len());
                let state = app_handle.state::<AppState>();
                let tx = state.pending_downloads.lock().unwrap().remove(&id);
                if let Some(tx) = tx {
                    let _ = tx.send(Ok(data));
                }
            }
            GuestToHost::DirListing { id, path, entries } => {
                info!("vsock: dir listing (id={id}, path={path}, {} entries)", entries.len());
                let state = app_handle.state::<AppState>();
                let tx = state.pending_downloads.lock().unwrap().remove(&id);
                if let Some(tx) = tx {
                    // Serialize entries as JSON and send through the download channel.
                    let json = serde_json::to_vec(&entries).unwrap_or_default();
                    let _ = tx.send(Ok(json));
                }
            }
            GuestToHost::FileError { id, error } => {
                info!("vsock: file error (id={id}): {error}");
                let state = app_handle.state::<AppState>();
                // Clean up partial download if any.
                state.partial_downloads.lock().unwrap().remove(&id);
                let tx = state.pending_downloads.lock().unwrap().remove(&id);
                if let Some(tx) = tx {
                    let _ = tx.send(Err(error));
                }
            }
            GuestToHost::FileSaved { id } => {
                info!("vsock: file saved (id={id})");
                let state = app_handle.state::<AppState>();
                let tx = state.pending_downloads.lock().unwrap().remove(&id);
                if let Some(tx) = tx {
                    // Send empty vec to signal success.
                    let _ = tx.send(Ok(vec![]));
                }
            }
            GuestToHost::FileChunk { id, offset, data, total_size } => {
                let state = app_handle.state::<AppState>();
                let chunk_len = data.len() as u64;

                // Accumulate chunk data.
                {
                    let mut partials = state.partial_downloads.lock().unwrap();
                    let partial = partials.entry(id).or_insert_with(|| {
                        crate::state::PartialDownload {
                            total_size,
                            data: Vec::with_capacity(total_size as usize),
                        }
                    });
                    partial.data.extend_from_slice(&data);
                }

                // Emit progress event to frontend.
                let received = offset + chunk_len;
                let _ = app_handle.emit("file-download-progress", serde_json::json!({
                    "id": id,
                    "received": received,
                    "total": total_size,
                }));

                // Check if transfer is complete.
                if received >= total_size {
                    let partial = state.partial_downloads.lock().unwrap().remove(&id);
                    if let Some(partial) = partial {
                        info!("vsock: chunked download complete (id={id}, {} bytes)", partial.data.len());
                        let tx = state.pending_downloads.lock().unwrap().remove(&id);
                        if let Some(tx) = tx {
                            let _ = tx.send(Ok(partial.data));
                        }
                    }
                }
            }
            other => {
                info!("vsock: unhandled control message: {other:?}");
            }
        }
    }
}

/// Set up vsock listeners and handle connections after VM boot.
///
/// Once vsock connects, the serial forwarding task is aborted since all
/// terminal I/O now flows through the vsock PTY bridge. After terminal
/// and control are established, continues accepting port 5002 (SNI proxy)
/// connections indefinitely, spawning each into a blocking thread.
async fn setup_vsock(
    app_handle: tauri::AppHandle,
    mut vsock_manager: VsockManager,
    serial_task: tauri::async_runtime::JoinHandle<()>,
    session_id: String,
    venv_id: String,
) {
    // Wait for both terminal and control connections from the guest agent.
    let mut terminal_conn = None;
    let mut control_conn = None;
    let mut deferred_conns = Vec::new();

    while terminal_conn.is_none() || control_conn.is_none() {
        match vsock_manager.accept().await {
            Some(conn) => {
                info!(port = conn.port, fd = conn.fd, "vsock: accepted connection");
                match conn.port {
                    VSOCK_PORT_TERMINAL => terminal_conn = Some(conn),
                    VSOCK_PORT_CONTROL => control_conn = Some(conn),
                    VSOCK_PORT_SNI_PROXY | VSOCK_PORT_FS_WATCH | VSOCK_PORT_MCP_GATEWAY | VSOCK_PORT_PORT_WATCH | VSOCK_PORT_PORT_FORWARD | VSOCK_PORT_SYS_WATCH => {
                        info!("vsock: port {} connection before terminal/control ready, deferring", conn.port);
                        deferred_conns.push(conn);
                    }
                    other => warn!("vsock: unexpected port {other}, ignoring"),
                }
            }
            None => {
                warn!("vsock: manager channel closed before all connections established");
                return;
            }
        }
    }

    let terminal = terminal_conn.unwrap();
    let control = control_conn.unwrap();

    // Transition: Booting -> VsockConnected
    {
        let state = app_handle.state::<AppState>();
        let mut vms = state.vms.lock().unwrap();
        if let Some(instance) = vms.get_mut(&session_id) {
            if let Err(e) = instance.state_machine.transition(HostState::VsockConnected, "vsock_ports_connected") {
                warn!("state machine: {e}");
            }
        }
    }

    info!("vsock: both channels connected, performing boot handshake");

    let mut ctrl_file = match clone_fd(control.fd) {
        Ok(f) => f,
        Err(e) => {
            warn!("vsock: failed to clone control fd: {e}");
            return;
        }
    };

    // Boot handshake: wait for Ready, send BootConfig, wait for BootReady.
    // Read first control message -- expect GuestToHost::Ready.
    match read_control_msg(&mut ctrl_file) {
        Ok(GuestToHost::Ready { version }) => {
            info!("vsock: guest agent ready (version {version})");
            // Transition: VsockConnected -> Handshaking
            let state = app_handle.state::<AppState>();
            let mut vms = state.vms.lock().unwrap();
            if let Some(instance) = vms.get_mut(&session_id) {
                if let Err(e) = instance.state_machine.transition(HostState::Handshaking, "ready_received") {
                    warn!("state machine: {e}");
                }
            }
        }
        Ok(other) => {
            warn!("vsock: expected Ready, got {other:?}");
        }
        Err(e) => {
            warn!("vsock: failed to read Ready: {e}");
        }
    }

    // Send boot config as individual messages (with venv overrides if active).
    let active_venv = if venv_id.is_empty() { None } else { Some(venv_id.as_str()) };
    if let Err(e) = send_boot_config_for_venv(&mut ctrl_file, &[], active_venv) {
        warn!("vsock: failed to send boot config: {e}");
    }

    // Wait for BootReady.
    let boot_ready_deadline = Instant::now() + Duration::from_secs(5);
    let mut boot_ready_received = false;
    while Instant::now() < boot_ready_deadline {
        match read_control_msg(&mut ctrl_file) {
            Ok(GuestToHost::BootReady) => {
                info!("vsock: guest boot ready");
                boot_ready_received = true;
                break;
            }
            Ok(other) => {
                info!("vsock: control message during boot handshake: {other:?}");
            }
            Err(e) => {
                warn!("vsock: control channel error during boot handshake: {e}");
                break;
            }
        }
    }
    if !boot_ready_received {
        warn!("vsock: BootReady not received within 5s, proceeding anyway");
    }

    serial_task.abort();
    info!("vsock: boot handshake complete, stopping serial forwarding");

    // Store vsock fds and transition to Running.
    let (mitm_config, mcp_config, session_db) = {
        let state = app_handle.state::<AppState>();
        let mut vms = state.vms.lock().unwrap();
        if let Some(instance) = vms.get_mut(&session_id) {
            instance.vsock_terminal_fd = Some(terminal.fd);
            instance.vsock_control_fd = Some(control.fd);
            if let Err(e) = instance.state_machine.transition(HostState::Running, "boot_ready_received") {
                warn!("state machine: {e}");
            }
            write_perf_log(&instance.state_machine);
            let vpn_manager = instance.vpn_state.clone();
            let mitm = instance.net_state.as_ref().map(|ns| {
                let active_venv = if venv_id.is_empty() { None } else { Some(venv_id.as_str()) };
                build_mitm_config(ns, vpn_manager, active_venv)
            });
            let mcp = instance.mcp_state.clone();
            // Extract session DB independently of MITM config so fs-watch/port-watch
            // work even when the MITM proxy is disabled.
            let db = instance.net_state.as_ref().map(|ns| Arc::clone(&ns.db));
            (mitm, mcp, db)
        } else {
            (None, None, None)
        }
    };

    // Emit structured state change to frontend.
    let _ = app_handle.emit("vm-state-changed", serde_json::json!({
        "state": "Running",
        "trigger": "boot_ready_received",
    }));
    let _ = app_handle.emit("terminal-source-changed", "vsock");

    // Spawn forwarding tasks.
    let terminal_output = {
        let state = app_handle.state::<AppState>();
        match state.terminal_output_for(&venv_id) {
            Some(to) => to,
            None => {
                warn!("vsock: no terminal output map for venv {venv_id}, creating one");
                let to = Arc::new(crate::state::TerminalOutputMap::new());
                state.terminal_outputs.lock().unwrap().insert(venv_id.clone(), Arc::clone(&to));
                to
            }
        }
    };
    tokio::spawn(vsock_terminal_to_events(terminal_output, terminal.fd));
    let _app_handle_for_accept = app_handle.clone();
    tokio::spawn(vsock_control_handler(app_handle.clone(), control.fd, session_id.clone(), venv_id.clone()));

    // Spawn periodic flush task: every 30s, sync session summary from info.db to main.db.
    {
        let flush_handle = app_handle.clone();
        let state = app_handle.state::<AppState>();
        let flush_session_id = session_id.clone();
        let db = {
            let vms = state.vms.lock().unwrap();
            vms.get(&flush_session_id)
                .and_then(|i| i.net_state.as_ref())
                .map(|ns| Arc::clone(&ns.db))
        };
        if let Some(db) = db {
            let sid = flush_session_id;
            tokio::spawn(async move {
                let mut interval = tokio::time::interval(Duration::from_secs(30));
                interval.tick().await; // skip immediate first tick
                let mut tick_count: u64 = 0;
                loop {
                    interval.tick().await;
                    tick_count += 1;
                    let sid = sid.clone();
                    let db = Arc::clone(&db);
                    let flush_handle = flush_handle.clone();
                    let checkpoint_main = tick_count % 10 == 0; // every 5 minutes
                    let _ = tokio::task::spawn_blocking(move || {
                        use tauri::Manager;
                        let reader = match db.reader() {
                            Ok(r) => r,
                            Err(_) => return,
                        };
                        let state = flush_handle.state::<AppState>();
                        let idx = match state.session_index.lock() {
                            Ok(g) => g,
                            Err(_) => return,
                        };
                        // Update request counts.
                        if let Ok((total, allowed, denied)) = reader.net_event_counts() {
                            let _ = idx.update_request_counts(
                                &sid,
                                total as u64,
                                allowed as u64,
                                denied as u64,
                            );
                        }
                        flush_session_summary(&sid, &idx, &reader);
                        // Periodically checkpoint main.db WAL.
                        if checkpoint_main {
                            let _ = idx.checkpoint();
                        }
                    }).await;
                }
            });
        }
    }

    // Keep terminal/control connections alive.
    let _keep_terminal = terminal;
    let _keep_control = control;

    // Get port_state, process_state, and sys_metrics for watch handlers.
    let (port_state, process_state, sys_metrics) = {
        let state = app_handle.state::<AppState>();
        let vms = state.vms.lock().unwrap();
        vms.get(&session_id).map(|inst| (
            Some(Arc::clone(&inst.port_state)),
            Some(Arc::clone(&inst.process_state)),
            Some(Arc::clone(&inst.sys_metrics)),
        )).unwrap_or((None, None, None))
    };

    // Process any connections that arrived during the handshake phase.
    for conn in deferred_conns {
        match conn.port {
            VSOCK_PORT_SNI_PROXY => {
                if let Some(ref config) = mitm_config {
                    let fd = conn.fd;
                    let config = Arc::clone(config);
                    tokio::spawn(async move {
                        let _conn = conn;
                        mitm_proxy::handle_connection(fd, config).await;
                    });
                }
            }
            VSOCK_PORT_FS_WATCH => {
                if let Some(ref config) = mitm_config {
                    let db = Arc::clone(&config.db);
                    let fd = conn.fd;
                    tokio::spawn(async move {
                        let _conn = conn;
                        handle_fs_watch(fd, db).await;
                    });
                }
            }
            VSOCK_PORT_MCP_GATEWAY => {
                if let Some(ref mcp) = mcp_config {
                    let fd = conn.fd;
                    let mcp = Arc::clone(mcp);
                    tokio::spawn(async move {
                        let _conn = conn;
                        gateway::serve_mcp_session(fd, mcp).await;
                    });
                }
            }
            VSOCK_PORT_PORT_WATCH => {
                if let (Some(ref ps), Some(ref proc_s)) = (&port_state, &process_state) {
                    let fd = conn.fd;
                    let ps = Arc::clone(ps);
                    let proc_s = Arc::clone(proc_s);
                    tokio::spawn(async move {
                        let _conn = conn;
                        handle_port_watch(fd, ps, proc_s).await;
                    });
                }
            }
            VSOCK_PORT_PORT_FORWARD => {
                if let Some(ref ps) = port_state {
                    // Dup the fd so it stays valid after conn is dropped.
                    if let Ok(file) = clone_fd(conn.fd) {
                        use std::os::unix::io::IntoRawFd;
                        let _ = ps.relay_tx.send(file.into_raw_fd());
                    }
                    drop(conn);
                }
            }
            VSOCK_PORT_SYS_WATCH => {
                if let Some(ref sm) = sys_metrics {
                    let fd = conn.fd;
                    let sm = Arc::clone(sm);
                    let ah = app_handle.clone();
                    tokio::spawn(async move {
                        let _conn = conn;
                        handle_sys_watch(fd, sm, ah).await;
                    });
                }
            }
            _ => {}
        }
    }

    // Accept MITM proxy + fs-watch + MCP gateway + port-watch + port-forward connections indefinitely.
    info!("vsock: listening for proxy connections on ports 5002/5003/5005/5006/5007/5008");
    loop {
        match vsock_manager.accept().await {
            Some(conn) if conn.port == VSOCK_PORT_SNI_PROXY => {
                if let Some(ref config) = mitm_config {
                    let fd = conn.fd;
                    let config = Arc::clone(config);
                    tokio::spawn(async move {
                        let _conn = conn; // keep VsockConnection alive
                        mitm_proxy::handle_connection(fd, config).await;
                    });
                } else {
                    warn!("vsock: SNI proxy connection rejected (no config)");
                }
            }
            Some(conn) if conn.port == VSOCK_PORT_FS_WATCH => {
                info!("vsock: fs-watch connected (fd={})", conn.fd);
                if let Some(ref db) = session_db {
                    let db = Arc::clone(db);
                    let fd = conn.fd;
                    tokio::spawn(async move {
                        let _conn = conn;
                        handle_fs_watch(fd, db).await;
                    });
                } else {
                    warn!("vsock: fs-watch connection rejected (no session db)");
                }
            }
            Some(conn) if conn.port == VSOCK_PORT_MCP_GATEWAY => {
                if let Some(ref mcp) = mcp_config {
                    let fd = conn.fd;
                    let mcp = Arc::clone(mcp);
                    tokio::spawn(async move {
                        let _conn = conn;
                        gateway::serve_mcp_session(fd, mcp).await;
                    });
                } else {
                    warn!("vsock: MCP connection rejected (no config)");
                }
            }
            Some(conn) if conn.port == VSOCK_PORT_PORT_WATCH => {
                info!("vsock: port-watch connected (fd={})", conn.fd);
                if let (Some(ref ps), Some(ref proc_s)) = (&port_state, &process_state) {
                    let fd = conn.fd;
                    let ps = Arc::clone(ps);
                    let proc_s = Arc::clone(proc_s);
                    tokio::spawn(async move {
                        let _conn = conn;
                        handle_port_watch(fd, ps, proc_s).await;
                    });
                } else {
                    warn!("vsock: port-watch connection rejected (no port state)");
                }
            }
            Some(conn) if conn.port == VSOCK_PORT_PORT_FORWARD => {
                if let Some(ref ps) = port_state {
                    if let Ok(file) = clone_fd(conn.fd) {
                        use std::os::unix::io::IntoRawFd;
                        let _ = ps.relay_tx.send(file.into_raw_fd());
                    }
                    drop(conn);
                }
            }
            Some(conn) if conn.port == VSOCK_PORT_SYS_WATCH => {
                info!("vsock: sys-watch connected (fd={})", conn.fd);
                if let Some(ref sm) = sys_metrics {
                    let fd = conn.fd;
                    let sm = Arc::clone(sm);
                    let ah = app_handle.clone();
                    tokio::spawn(async move {
                        let _conn = conn;
                        handle_sys_watch(fd, sm, ah).await;
                    });
                } else {
                    warn!("vsock: sys-watch connection rejected (no metrics state)");
                }
            }
            Some(conn) => {
                warn!(port = conn.port, "vsock: unexpected port after setup, ignoring");
            }
            None => {
                info!("vsock: manager channel closed, stopping accept loop");
                break;
            }
        }
    }
}

const CLI_TIMEOUT: Duration = Duration::from_secs(120);

/// Handle the fs-watch vsock connection: read framed GuestToHost messages
/// and write FileEvents to the session DB.
async fn handle_fs_watch(fd: RawFd, db: Arc<DbWriter>) {
    use clawcage_logger::{FileAction, FileEvent, WriteOp};
    use std::os::unix::io::{FromRawFd, IntoRawFd};
    use std::time::SystemTime;
    use tokio::io::AsyncReadExt;

    let std_file = match clone_fd(fd) {
        Ok(f) => f,
        Err(e) => {
            warn!("fs-watch: failed to clone fd: {e}");
            return;
        }
    };
    
    let std_stream = unsafe { std::os::unix::net::UnixStream::from_raw_fd(std_file.into_raw_fd()) };
    if let Err(e) = std_stream.set_nonblocking(true) {
        warn!("fs-watch: failed to set nonblocking: {e}");
        return;
    }
    
    let mut stream = match tokio::net::UnixStream::from_std(std_stream) {
        Ok(s) => s,
        Err(e) => {
            warn!("fs-watch: failed to create async stream: {e}");
            return;
        }
    };

    info!("fs-watch: handler started");
    loop {
        let mut len_buf = [0u8; 4];
        match stream.read_exact(&mut len_buf).await {
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                info!("fs-watch: connection closed");
                break;
            }
            Err(e) => {
                warn!("fs-watch: read error: {e}");
                break;
            }
        }
        let len = u32::from_be_bytes(len_buf) as usize;
        if len > MAX_FRAME_SIZE as usize {
            warn!("fs-watch: frame too large ({len} bytes), skipping");
            break;
        }
        let mut payload = vec![0u8; len];
        if let Err(e) = stream.read_exact(&mut payload).await {
            warn!("fs-watch: payload read error: {e}");
            break;
        }
        let msg = match decode_guest_msg(&payload) {
            Ok(m) => m,
            Err(e) => {
                warn!("fs-watch: decode error: {e}");
                continue;
            }
        };
        let event = match msg {
            GuestToHost::FileCreated { path, size } => FileEvent {
                timestamp: SystemTime::now(),
                action: FileAction::Created,
                path,
                size: Some(size),
            },
            GuestToHost::FileModified { path, size } => FileEvent {
                timestamp: SystemTime::now(),
                action: FileAction::Modified,
                path,
                size: Some(size),
            },
            GuestToHost::FileDeleted { path } => FileEvent {
                timestamp: SystemTime::now(),
                action: FileAction::Deleted,
                path,
                size: None,
            },
            other => {
                warn!("fs-watch: unexpected message type: {other:?}");
                continue;
            }
        };
        db.write(WriteOp::FileEvent(event)).await;
    }
    info!("fs-watch: handler exiting");
}

/// Handle the port-watch vsock connection: read framed GuestToHost messages
/// and update the port state and process state for the active VM.
async fn handle_port_watch(fd: RawFd, port_state: Arc<crate::state::PortState>, process_state: Arc<crate::state::ProcessState>) {
    use std::os::unix::io::{FromRawFd, IntoRawFd};
    use tokio::io::AsyncReadExt;

    let std_file = match clone_fd(fd) {
        Ok(f) => f,
        Err(e) => {
            warn!("port-watch: failed to clone fd: {e}");
            return;
        }
    };

    let std_stream = unsafe { std::os::unix::net::UnixStream::from_raw_fd(std_file.into_raw_fd()) };
    if let Err(e) = std_stream.set_nonblocking(true) {
        warn!("port-watch: failed to set nonblocking: {e}");
        return;
    }

    let mut stream = match tokio::net::UnixStream::from_std(std_stream) {
        Ok(s) => s,
        Err(e) => {
            warn!("port-watch: failed to create async stream: {e}");
            return;
        }
    };

    info!("port-watch: handler started");
    loop {
        let mut len_buf = [0u8; 4];
        match stream.read_exact(&mut len_buf).await {
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                info!("port-watch: connection closed");
                break;
            }
            Err(e) => {
                warn!("port-watch: read error: {e}");
                break;
            }
        }
        let len = u32::from_be_bytes(len_buf) as usize;
        if len > MAX_FRAME_SIZE as usize {
            warn!("port-watch: frame too large ({len} bytes), skipping");
            break;
        }
        let mut payload = vec![0u8; len];
        if let Err(e) = stream.read_exact(&mut payload).await {
            warn!("port-watch: payload read error: {e}");
            break;
        }
        let msg = match decode_guest_msg(&payload) {
            Ok(m) => m,
            Err(e) => {
                warn!("port-watch: decode error: {e}");
                continue;
            }
        };
        match msg {
            GuestToHost::PortOpened { port, pid, process } => {
                info!("port-watch: port opened {port} (pid={pid}, process={process})");
                let mut detected = port_state.detected.write().unwrap();
                if !detected.iter().any(|d| d.port == port) {
                    let now_ms = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64;
                    detected.push(crate::state::DetectedPort {
                        port,
                        pid,
                        process,
                        detected_at: now_ms,
                    });
                }
            }
            GuestToHost::PortClosed { port } => {
                info!("port-watch: port closed {port}");
                let mut detected = port_state.detected.write().unwrap();
                detected.retain(|d| d.port != port);
                // Also remove any forwarding for this port and abort the bridge task
                let mut forwarded = port_state.forwarded.write().unwrap();
                forwarded.retain(|f| f.guest_port != port);
                let mut tasks = port_state.forward_tasks.lock().unwrap();
                if let Some(handle) = tasks.remove(&port) {
                    handle.abort();
                }
            }
            GuestToHost::ProcessSnapshot { processes } => {
                let guest_procs: Vec<crate::state::GuestProcess> = processes.into_iter().map(|p| {
                    crate::state::GuestProcess {
                        pid: p.pid,
                        ppid: p.ppid,
                        name: p.name,
                        cpu_percent: p.cpu_percent,
                        mem_kb: p.mem_kb,
                        runtime_secs: p.runtime_secs,
                        port: p.port,
                    }
                }).collect();
                *process_state.processes.write().unwrap() = guest_procs;
            }
            GuestToHost::ProcessKilled { pid, success } => {
                if success {
                    info!("port-watch: process {pid} killed successfully");
                } else {
                    warn!("port-watch: failed to kill process {pid}");
                }
            }
            other => {
                warn!("port-watch: unexpected message type: {other:?}");
            }
        }
    }
    info!("port-watch: handler exiting");
}

/// Handle the sys-watch vsock connection: read framed GuestToHost::SystemMetrics
/// messages and update the shared SystemMetricsState + emit Tauri event.
async fn handle_sys_watch(
    fd: RawFd,
    state: Arc<crate::state::SystemMetricsState>,
    app_handle: tauri::AppHandle,
) {
    use std::os::unix::io::{FromRawFd, IntoRawFd};
    use tokio::io::AsyncReadExt;

    let std_file = match clone_fd(fd) {
        Ok(f) => f,
        Err(e) => {
            warn!("sys-watch: failed to clone fd: {e}");
            return;
        }
    };

    let std_stream = unsafe { std::os::unix::net::UnixStream::from_raw_fd(std_file.into_raw_fd()) };
    if let Err(e) = std_stream.set_nonblocking(true) {
        warn!("sys-watch: failed to set nonblocking: {e}");
        return;
    }

    let mut stream = match tokio::net::UnixStream::from_std(std_stream) {
        Ok(s) => s,
        Err(e) => {
            warn!("sys-watch: failed to create async stream: {e}");
            return;
        }
    };

    info!("sys-watch: handler started");
    loop {
        let mut len_buf = [0u8; 4];
        match stream.read_exact(&mut len_buf).await {
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                info!("sys-watch: connection closed");
                break;
            }
            Err(e) => {
                warn!("sys-watch: read error: {e}");
                break;
            }
        }
        let len = u32::from_be_bytes(len_buf) as usize;
        if len > MAX_FRAME_SIZE as usize {
            warn!("sys-watch: frame too large ({len} bytes), skipping");
            break;
        }
        let mut payload = vec![0u8; len];
        if let Err(e) = stream.read_exact(&mut payload).await {
            warn!("sys-watch: payload read error: {e}");
            break;
        }
        let msg = match decode_guest_msg(&payload) {
            Ok(m) => m,
            Err(e) => {
                warn!("sys-watch: decode error: {e}");
                continue;
            }
        };
        match msg {
            GuestToHost::SystemMetrics {
                cpu_percent,
                mem_total_kb,
                mem_used_kb,
                disk_total_kb,
                disk_used_kb,
            } => {
                let now_ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64;
                let metrics = crate::state::SystemMetrics {
                    cpu_percent,
                    mem_total_kb,
                    mem_used_kb,
                    disk_total_kb,
                    disk_used_kb,
                    updated_at: now_ms,
                };
                // Update shared state.
                *state.latest.write().unwrap() = metrics.clone();
                // Emit event for frontend.
                let _ = app_handle.emit("system-metrics", &metrics);
            }
            other => {
                warn!("sys-watch: unexpected message type: {other:?}");
            }
        }
    }
    info!("sys-watch: handler exiting");
}

/// Read one guest-to-host control message from an fd (blocking).
fn read_control_msg(file: &mut std::fs::File) -> Result<GuestToHost> {
    let mut len_buf = [0u8; 4];
    file.read_exact(&mut len_buf)?;
    let len = u32::from_be_bytes(len_buf) as usize;
    if len > MAX_FRAME_SIZE as usize {
        anyhow::bail!("control frame too large ({len} bytes)");
    }
    let mut payload = vec![0u8; len];
    file.read_exact(&mut payload)?;
    decode_guest_msg(&payload)
}

/// Write one host-to-guest control message to an fd.
fn write_control_msg(file: &mut std::fs::File, msg: &HostToGuest) -> Result<()> {
    let frame = encode_host_msg(msg)?;
    file.write_all(&frame)?;
    Ok(())
}

/// Build the credential map for the MITM proxy's host-side credential injection.
///
/// Reads API keys from the settings registry and maps AI provider domains to
/// the appropriate credential type. Keys never enter the guest VM.
fn build_credentials(venv_id: Option<&str>) -> std::collections::HashMap<String, CredentialKind> {
    let settings = policy_config::load_merged_settings_for_venv(venv_id);
    let get_val = |id: &str| -> String {
        settings.iter()
            .find(|s| s.id == id)
            .and_then(|s| match &s.effective_value {
                clawcage_core::net::policy_config::SettingValue::Text(t) => Some(t.clone()),
                _ => None,
            })
            .unwrap_or_default()
    };

    let mut creds = std::collections::HashMap::new();

    // Anthropic: x-api-key header
    let anthropic_key = get_val("ai.anthropic.api_key");
    if !anthropic_key.is_empty() {
        creds.insert("api.anthropic.com".to_string(), CredentialKind::Header {
            name: "x-api-key".to_string(),
            value: anthropic_key,
        });
    }

    // OpenAI: Authorization: Bearer header
    let openai_key = get_val("ai.openai.api_key");
    if !openai_key.is_empty() {
        creds.insert("api.openai.com".to_string(), CredentialKind::Header {
            name: "authorization".to_string(),
            value: format!("Bearer {openai_key}"),
        });
    }

    // Google: query parameter ?key=
    let google_key = get_val("ai.google.api_key");
    if !google_key.is_empty() {
        creds.insert("generativelanguage.googleapis.com".to_string(), CredentialKind::QueryParam {
            key: "key".to_string(),
            value: google_key,
        });
    }

    creds
}

/// Build a `MitmProxyConfig` from network state + venv settings.
fn build_mitm_config(
    ns: &VmNetworkState,
    vpn: Option<Arc<clawcage_core::net::vpn::VpnManager>>,
    venv_id: Option<&str>,
) -> Arc<MitmProxyConfig> {
    let settings = policy_config::load_merged_settings_for_venv(venv_id);
    let get_bool = |id: &str, default: bool| -> bool {
        settings.iter()
            .find(|s| s.id == id)
            .and_then(|s| match &s.effective_value {
                clawcage_core::net::policy_config::SettingValue::Bool(b) => Some(*b),
                _ => None,
            })
            .unwrap_or(default)
    };
    let get_num = |id: &str, default: u64| -> u64 {
        settings.iter()
            .find(|s| s.id == id)
            .and_then(|s| match &s.effective_value {
                clawcage_core::net::policy_config::SettingValue::Number(n) => Some(*n as u64),
                _ => None,
            })
            .unwrap_or(default)
    };

    let enabled = get_bool("network.proxy_enabled", true);
    let credential_isolation = get_bool("network.credential_isolation", true);
    let max_connections = get_num("network.proxy_max_connections", 100) as usize;
    let rate_limit = get_num("network.proxy_rate_limit", 50) as f64;
    let max_body_mb = get_num("network.proxy_max_body_mb", 100);
    let idle_timeout_secs = get_num("network.proxy_idle_timeout", 60);

    let limits = ProxyLimits {
        max_concurrent_connections: max_connections,
        per_domain_rate_limit: rate_limit,
        max_response_body_bytes: max_body_mb * 1024 * 1024,
        connection_idle_timeout: std::time::Duration::from_secs(idle_timeout_secs),
        connect_timeout: std::time::Duration::from_secs(10),
    };
    let semaphore = Arc::new(tokio::sync::Semaphore::new(limits.max_concurrent_connections));
    let rate_limiter = Arc::new(RateLimiterMap::new(limits.per_domain_rate_limit));

    let credentials = if credential_isolation {
        build_credentials(venv_id)
    } else {
        std::collections::HashMap::new()
    };

    Arc::new(MitmProxyConfig {
        ca: Arc::clone(&ns.ca),
        policy: Arc::clone(&ns.policy),
        db: Arc::clone(&ns.db),
        upstream_tls: Arc::clone(&ns.upstream_tls),
        pricing: clawcage_core::gateway::pricing::PricingTable::load(),
        trace_state: std::sync::Mutex::new(clawcage_core::gateway::TraceState::new()),
        tunnel_non_ai: true,
        vpn,
        limits,
        connection_semaphore: semaphore,
        rate_limiter,
        enabled,
        credentials: Arc::new(credentials),
    })
}

/// Send the boot configuration as individual vsock messages.
///
/// Sends BootConfig (clock), then SetEnv for each env var, FileWrite for each
/// boot file, and BootConfigDone to signal completion. Each message is its own
/// frame, eliminating the old single-frame size constraint.
///
/// Validates all env vars and file paths before sending. Invalid entries are
/// logged and skipped. Enforces allocation caps (MAX_BOOT_ENV_VARS,
/// MAX_BOOT_FILES, MAX_BOOT_FILE_BYTES) to prevent unbounded allocations.
///
/// Env var priority: settings registry defaults < user.toml overrides < CLI --env flags.
fn send_boot_config(file: &mut std::fs::File, cli_env: &[(String, String)]) -> Result<()> {
    send_boot_config_for_venv(file, cli_env, None)
}

fn send_boot_config_for_venv(file: &mut std::fs::File, cli_env: &[(String, String)], venv_id: Option<&str>) -> Result<()> {
    use clawcage_core::clawcage_proto::{
        validate_env_key, validate_env_value, validate_file_path,
        MAX_BOOT_ENV_VARS, MAX_BOOT_FILES, MAX_BOOT_FILE_BYTES,
    };

    let epoch_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    // 1. Send BootConfig with clock.
    write_control_msg(file, &HostToGuest::BootConfig { epoch_secs })?;

    // 2. Send metadata-driven env vars from settings registry (venv overrides applied).
    let guest_config = policy_config::load_merged_guest_config_for_venv(venv_id);
    let mut env_count: usize = 0;

    // Check credential isolation setting -- when enabled, API keys are replaced
    // with placeholders so the guest never sees real keys.
    let settings = policy_config::load_merged_settings_for_venv(venv_id);
    let credential_isolation = settings.iter()
        .find(|s| s.id == "network.credential_isolation")
        .and_then(|s| match &s.effective_value {
            policy_config::SettingValue::Bool(b) => Some(*b),
            _ => None,
        })
        .unwrap_or(true);

    /// Env var names that contain API keys -- replaced with placeholders when
    /// credential isolation is enabled.
    const API_KEY_ENV_VARS: &[&str] = &[
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "GEMINI_API_KEY",
    ];

    if let Some(env) = guest_config.env {
        for (key, value) in env {
            if env_count >= MAX_BOOT_ENV_VARS {
                warn!("boot env var cap reached ({MAX_BOOT_ENV_VARS}), skipping remaining");
                break;
            }
            if let Err(e) = validate_env_key(&key) {
                warn!("skipping invalid boot env var key: {e}");
                continue;
            }
            // Credential isolation: send a placeholder instead of the real key.
            // The MITM proxy injects the real key into upstream requests.
            let value = if credential_isolation && API_KEY_ENV_VARS.contains(&key.as_str()) && !value.is_empty() {
                info!("credential isolation: replacing {key} with proxy-managed placeholder");
                "clawcage-proxy-managed".to_string()
            } else {
                value
            };
            if let Err(e) = validate_env_value(&value) {
                warn!("skipping boot env var {key}: {e}");
                continue;
            }
            write_control_msg(file, &HostToGuest::SetEnv { key, value })?;
            env_count += 1;
        }
    }

    // 3. CLI --env overrides (last wins).
    for (key, value) in cli_env {
        if env_count >= MAX_BOOT_ENV_VARS {
            warn!("boot env var cap reached ({MAX_BOOT_ENV_VARS}), skipping remaining CLI --env");
            break;
        }
        if let Err(e) = validate_env_key(key) {
            warn!("skipping invalid CLI --env key: {e}");
            continue;
        }
        if let Err(e) = validate_env_value(value) {
            warn!("skipping CLI --env {key}: {e}");
            continue;
        }
        write_control_msg(
            file,
            &HostToGuest::SetEnv {
                key: key.clone(),
                value: value.clone(),
            },
        )?;
        env_count += 1;
    }

    // 4. Send each boot file (with caps).
    let mut file_count: usize = 0;
    let mut total_file_bytes: usize = 0;

    for f in guest_config.files.unwrap_or_default() {
        if file_count >= MAX_BOOT_FILES {
            warn!("boot file cap reached ({MAX_BOOT_FILES}), skipping remaining");
            break;
        }
        let data = f.content.into_bytes();
        if total_file_bytes + data.len() > MAX_BOOT_FILE_BYTES {
            warn!(
                "boot file bytes cap reached ({MAX_BOOT_FILE_BYTES}), skipping {}",
                f.path
            );
            continue;
        }
        if let Err(e) = validate_file_path(&f.path) {
            warn!("skipping invalid boot file path: {e}");
            continue;
        }
        total_file_bytes += data.len();
        file_count += 1;
        write_control_msg(
            file,
            &HostToGuest::FileWrite {
                path: f.path,
                data,
                mode: f.mode,
            },
        )?;
    }

    // 5. Deliver template setup script + env file (if the venv has them).
    if let Some(vid) = venv_id {
        if let Some(dir) = venv_scratch_dir(vid) {
            let setup_path = dir.join("setup.sh");
            if setup_path.exists() {
                if let Ok(script) = std::fs::read_to_string(&setup_path) {
                    let data = script.into_bytes();
                    info!(venv_id = vid, bytes = data.len(), "delivering template setup script");
                    write_control_msg(
                        file,
                        &HostToGuest::FileWrite {
                            path: "/tmp/.clawcage-template-setup.sh".to_string(),
                            data,
                            mode: 0o755,
                        },
                    )?;
                }
            }
            let env_path = dir.join("setup.env");
            if env_path.exists() {
                if let Ok(env_data) = std::fs::read_to_string(&env_path) {
                    info!(venv_id = vid, "delivering template setup env");
                    write_control_msg(
                        file,
                        &HostToGuest::FileWrite {
                            path: "/tmp/.clawcage-template-setup.env".to_string(),
                            data: env_data.into_bytes(),
                            mode: 0o600,
                        },
                    )?;
                }
            }
        }
    }

    // 6. Signal done.
    write_control_msg(file, &HostToGuest::BootConfigDone)?;

    Ok(())
}

/// Parse `--env KEY=VALUE` pairs from CLI args, returning env pairs and remaining args.
///
/// CLI --env args are validated strictly: invalid keys or values cause an error
/// message and the pair is skipped (stricter than config file handling).
fn parse_env_args(args: &[String]) -> (Vec<(String, String)>, Vec<String>) {
    use clawcage_core::clawcage_proto::{validate_env_key, validate_env_value};

    let mut env_pairs = Vec::new();
    let mut remaining = Vec::new();
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        if arg == "--env" {
            if let Some(val) = iter.next() {
                if let Some((key, value)) = val.split_once('=') {
                    if let Err(e) = validate_env_key(key) {
                        eprintln!("clawcage: --env rejected: {e}");
                        continue;
                    }
                    if let Err(e) = validate_env_value(value) {
                        eprintln!("clawcage: --env {key} rejected: {e}");
                        continue;
                    }
                    env_pairs.push((key.to_string(), value.to_string()));
                } else {
                    eprintln!("clawcage: --env value must be KEY=VALUE, got: {val}");
                }
            } else {
                eprintln!("clawcage: --env requires a KEY=VALUE argument");
            }
        } else if let Some(rest) = arg.strip_prefix("--env=") {
            if let Some((key, value)) = rest.split_once('=') {
                if let Err(e) = validate_env_key(key) {
                    eprintln!("clawcage: --env rejected: {e}");
                    continue;
                }
                if let Err(e) = validate_env_value(value) {
                    eprintln!("clawcage: --env {key} rejected: {e}");
                    continue;
                }
                env_pairs.push((key.to_string(), value.to_string()));
            } else {
                eprintln!("clawcage: --env value must be KEY=VALUE, got: {rest}");
            }
        } else {
            remaining.push(arg.clone());
        }
    }
    (env_pairs, remaining)
}

/// Start the VM in CLI mode and execute a command.
///
/// **Architecture & CFRunLoop:**
/// This function runs entirely on the main thread and uses synchronous blocking I/O
/// combined with manual `CFRunLoop` pumping. The Virtualization.framework (VZ) heavily
/// relies on GCD and the main thread's run loop to dispatch events, handle vsock
/// connections, and manage VM state transitions. If we block the main thread
/// (e.g., by waiting on a channel or reading from a socket without pumping the run loop),
/// VZ will deadlock and vsock connections will never arrive.
///
/// To solve this, `run_cli` uses `CFRunLoopRunInMode` with a short timeout (50ms)
/// to yield control back to VZ, allowing it to process events. We then check for
/// incoming messages or vsock connections using non-blocking/try_recv methods.
///
/// **Limitations:**
/// - Cannot use `tokio::main` or `async` on the main thread because tokio's reactor
///   does not pump `CFRunLoop`.
/// - Requires manual polling loops for control messages.
fn run_cli(command: &str, cli_env: &[(String, String)], session_index: &SessionIndex) -> Result<()> {
    // Tokio runtime for async MITM proxy handlers.
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .context("failed to create tokio runtime")?;

    let assets = resolve_assets_dir()?;

    // Resolve rootfs: check bundled assets first, then ~/.clawcage/assets/.
    // If missing, download it before booting.
    let rootfs_path = match resolve_rootfs(&assets) {
        Some(path) => Some(path),
        None => {
            eprintln!("[clawcage] rootfs not found, downloading...");
            let mgr = create_asset_manager(&assets)?;
            let name = rootfs_manifest_name(&mgr)?;
            let _ = mgr.cleanup_unrecognized();
            let client = reqwest::Client::new();
            let downloaded = rt.block_on(mgr.download_asset(&name, &client, |p| {
                if p.total_bytes > 0 {
                    let pct = (p.bytes_downloaded as f64 / p.total_bytes as f64 * 100.0) as u32;
                    eprint!("\r[clawcage] {}: {}% ({}/{} bytes)   ",
                        p.phase, pct, p.bytes_downloaded, p.total_bytes);
                } else {
                    eprint!("\r[clawcage] {}: {} bytes   ", p.phase, p.bytes_downloaded);
                }
            }))?;
            eprintln!();
            Some(downloaded)
        }
    };

    // Generate unique session ID.
    let cli_session_id = session::generate_session_id();
    eprintln!("[clawcage] session: {cli_session_id}");

    // Create session directory and scratch disk for CLI mode.
    let vm_settings = policy_config::load_merged_vm_settings();
    let scratch_size = vm_settings.scratch_disk_size_gb.unwrap_or(16);
    let cpu_count = vm_settings.cpu_count.unwrap_or(4);
    let ram_gb = vm_settings.ram_gb.unwrap_or(4);
    let ram_bytes: u64 = ram_gb as u64 * 1024 * 1024 * 1024;
    let cli_session_dir = session_dir_for(&cli_session_id);
    let scratch_path = cli_session_dir.as_ref().and_then(|d| {
        std::fs::create_dir_all(d).ok();
        let path = d.join("scratch.img");
        if let Err(e) = create_scratch_disk(&path, scratch_size) {
            warn!("failed to create scratch disk: {e}");
            return None;
        }
        info!(size_gb = scratch_size, "created scratch disk");
        Some(path)
    });

    // Record session in main.db.
    let record = SessionRecord {
        id: cli_session_id.clone(),
        mode: "cli".to_string(),
        command: Some(command.to_string()),
        status: "running".to_string(),
        created_at: session::now_iso(),
        stopped_at: None,
        scratch_disk_size_gb: scratch_size,
        ram_bytes,
        total_requests: 0,
        allowed_requests: 0,
        denied_requests: 0,
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_estimated_cost: 0.0,
        total_tool_calls: 0,
        total_mcp_calls: 0,
        total_file_events: 0,
        compressed_size_bytes: None,
        vacuumed_at: None,
    };
    if let Err(e) = session_index.create_session(&record) {
        warn!("failed to record session: {e}");
    }

    let (vm, mut rx, _serial_input_fd, _sm) = boot_vm(
        &assets,
        rootfs_path.as_deref(),
        "console=hvc0 ro loglevel=1",
        scratch_path.as_deref(),
        cpu_count,
        ram_bytes,
    )?;

    // Set up vsock listeners (including SNI proxy and MCP gateway ports).
    let socket_devices = vm.socket_devices();
    let mut mgr = VsockManager::new(
        &socket_devices,
        &[VSOCK_PORT_CONTROL, VSOCK_PORT_TERMINAL, VSOCK_PORT_SNI_PROXY, VSOCK_PORT_FS_WATCH, VSOCK_PORT_MCP_GATEWAY, VSOCK_PORT_PORT_WATCH, VSOCK_PORT_PORT_FORWARD, VSOCK_PORT_SYS_WATCH],
    ).context("failed to set up vsock")?;

    // Port and process state for CLI mode.
    let cli_port_state = Arc::new(crate::state::PortState::new());
    let cli_process_state = Arc::new(crate::state::ProcessState::new());

    // Create per-VM network state for MITM proxy.
    let net_state = create_net_state(&cli_session_id).ok();
    let mitm_config: Option<Arc<MitmProxyConfig>> = net_state.as_ref().map(|ns| {
        build_mitm_config(ns, None, None)
    });

    // Create MCP gateway config for vsock:5003.
    let mcp_config: Option<Arc<McpGatewayConfig>> = net_state.as_ref().map(|ns| {
        let domain_policy = policy_config::load_merged_domain_policy();
        Arc::new(McpGatewayConfig {
            server_manager: tokio::sync::Mutex::new(McpServerManager::new(vec![])),
            db: Arc::clone(&ns.db),
            policy: tokio::sync::RwLock::new(Arc::new(McpPolicy::new())),
            domain_policy: std::sync::RwLock::new(Arc::new(domain_policy)),
            http_client: reqwest::Client::builder()
                .user_agent("clawcage-mcp/0.8")
                .timeout(std::time::Duration::from_secs(30))
                .redirect(reqwest::redirect::Policy::limited(10))
                .build()
                .expect("reqwest client"),
        })
    });

    // Print serial boot logs to stderr in a background thread.
    std::thread::spawn(move || {
        loop {
            match rx.blocking_recv() {
                Ok(bytes) => {
                    let _ = std::io::stderr().write_all(&bytes);
                    let _ = std::io::stderr().flush();
                }
                Err(broadcast::error::RecvError::Closed) => break,
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
            }
        }
    });

    // Accept vsock connections with CFRunLoop pumping.
    // The VZ framework delivers connections via ObjC callbacks that require
    // CFRunLoop to be running on the main thread.
    let deadline = Instant::now() + CLI_TIMEOUT;
    let mut terminal_fd: Option<RawFd> = None;
    let mut control_fd: Option<RawFd> = None;
    let mut _conns = Vec::new(); // Keep connections alive.

    let setup_start = Instant::now();
    let mut warned_setup = false;

    while terminal_fd.is_none() || control_fd.is_none() {
        if Instant::now() >= deadline {
            anyhow::bail!("timed out waiting for vsock connections from guest agent");
        }
        if !warned_setup && setup_start.elapsed() > Duration::from_secs(30) {
            eprintln!("[clawcage] warning: no vsock connections after 30s. Is the guest agent running?");
            warned_setup = true;
        }
        // Pump CFRunLoop to deliver ObjC callbacks.
        unsafe {
            core_foundation_sys::runloop::CFRunLoopRunInMode(
                core_foundation_sys::runloop::kCFRunLoopDefaultMode,
                0.05,
                0,
            );
        }
        // Check for accepted connections (non-blocking via try_recv on the channel).
        while let Ok(conn) = mgr.try_accept() {
            match conn.port {
                VSOCK_PORT_TERMINAL => terminal_fd = Some(conn.fd),
                VSOCK_PORT_CONTROL => control_fd = Some(conn.fd),
                VSOCK_PORT_SNI_PROXY => {
                    // Spawn MITM proxy handler on the tokio runtime.
                    if let Some(ref config) = mitm_config {
                        let fd = conn.fd;
                        let config = Arc::clone(config);
                        rt.spawn(async move {
                            let _conn = conn;
                            mitm_proxy::handle_connection(fd, config).await;
                        });
                        continue; // conn moved, don't push to _conns
                    }
                }
                VSOCK_PORT_FS_WATCH => {
                    if let Some(ref net_state) = net_state {
                        let db = Arc::clone(&net_state.db);
                        let fd = conn.fd;
                        rt.spawn(async move {
                            let _conn = conn;
                            handle_fs_watch(fd, db).await;
                        });
                        continue;
                    }
                }
                VSOCK_PORT_MCP_GATEWAY => {
                    if let Some(ref config) = mcp_config {
                        let fd = conn.fd;
                        let config = Arc::clone(config);
                        rt.spawn(async move {
                            let _conn = conn;
                            gateway::serve_mcp_session(fd, config).await;
                        });
                        continue;
                    }
                }
                VSOCK_PORT_PORT_WATCH => {
                    let fd = conn.fd;
                    let ps = Arc::clone(&cli_port_state);
                    let proc_s = Arc::clone(&cli_process_state);
                    rt.spawn(async move {
                        let _conn = conn;
                        handle_port_watch(fd, ps, proc_s).await;
                    });
                    continue;
                }
                VSOCK_PORT_PORT_FORWARD => {
                    if let Ok(file) = clone_fd(conn.fd) {
                        use std::os::unix::io::IntoRawFd;
                        let _ = cli_port_state.relay_tx.send(file.into_raw_fd());
                    }
                    drop(conn);
                    continue;
                }
                _ => {}
            }
            _conns.push(conn);
        }
    }

    let terminal_fd = terminal_fd.unwrap();
    let control_fd = control_fd.unwrap();

    // Wait for Ready message from guest agent.
    let (ctrl_msg_tx, ctrl_msg_rx) = std::sync::mpsc::channel::<GuestToHost>();
    let mut ctrl_fd_reader = match clone_fd(control_fd) {
        Ok(f) => f,
        Err(e) => anyhow::bail!("failed to clone control fd: {e}"),
    };
    std::thread::spawn(move || {
        loop {
            match read_control_msg(&mut ctrl_fd_reader) {
                Ok(msg) => {
                    if ctrl_msg_tx.send(msg).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    // Wait for Ready, pumping CFRunLoop.
    loop {
        if Instant::now() >= deadline {
            anyhow::bail!("timed out waiting for guest agent Ready");
        }
        unsafe {
            core_foundation_sys::runloop::CFRunLoopRunInMode(
                core_foundation_sys::runloop::kCFRunLoopDefaultMode,
                0.05,
                0,
            );
        }
        match ctrl_msg_rx.try_recv() {
            Ok(GuestToHost::Ready { version }) => {
                eprintln!("[clawcage] guest agent ready (v{version})");
                break;
            }
            Ok(other) => {
                eprintln!("[clawcage] unexpected control message before Ready: {other:?}");
            }
            Err(std::sync::mpsc::TryRecvError::Empty) => continue,
            Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                anyhow::bail!("control channel closed before Ready");
            }
        }
    }

    let mut ctrl_fd_writer = clone_fd(control_fd)?;
    // Send boot config as individual messages.
    send_boot_config(&mut ctrl_fd_writer, cli_env)?;

    // Wait for BootReady.
    let boot_ready_deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if Instant::now() >= boot_ready_deadline {
            eprintln!("[clawcage] BootReady not received within 5s, proceeding");
            break;
        }
        unsafe {
            core_foundation_sys::runloop::CFRunLoopRunInMode(
                core_foundation_sys::runloop::kCFRunLoopDefaultMode,
                0.05,
                0,
            );
        }
        match ctrl_msg_rx.try_recv() {
            Ok(GuestToHost::BootReady) => {
                eprintln!("[clawcage] guest boot ready");
                break;
            }
            Ok(other) => {
                eprintln!("[clawcage] control message during boot: {other:?}");
            }
            Err(std::sync::mpsc::TryRecvError::Empty) => continue,
            Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                anyhow::bail!("guest agent disconnected during boot handshake");
            }
        }
    }

    // Send Exec command.
    let exec_id: u64 = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos() as u64;
    let mut exec_file = clone_fd(control_fd)?;
    write_control_msg(&mut exec_file, &HostToGuest::Exec {
        id: exec_id,
        command: command.to_string(),
    })?;

    // Stream terminal output from vsock to stdout in a background thread.
    // Track whether the last byte written was a newline so we can add one
    // before exiting if needed.
    let last_was_newline = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
    let lwn = last_was_newline.clone();
    let terminal_reader = std::thread::spawn(move || {
        let mut file = match clone_fd(terminal_fd) {
            Ok(f) => f,
            Err(e) => {
                eprintln!("[clawcage] terminal reader failed to clone fd: {e}");
                return;
            }
        };
        let mut buf = [0u8; 8192];
        loop {
            match file.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let _ = std::io::stdout().write_all(&buf[..n]);
                    let _ = std::io::stdout().flush();
                    lwn.store(buf[n - 1] == b'\n', std::sync::atomic::Ordering::Relaxed);
                }
                Err(_) => break,
            }
        }
    });

    // Wait for ExecDone, pumping CFRunLoop and accepting SNI proxy connections.
    let exit_code;
    let mut last_msg_time = Instant::now();
    let mut warned_exec = false;
    loop {
        if Instant::now() >= deadline {
            eprintln!("[clawcage] timed out waiting for command completion");
            exit_code = 124; // Same as `timeout` command.
            break;
        }
        if !warned_exec && last_msg_time.elapsed() > Duration::from_secs(30) {
            eprintln!("[clawcage] warning: no control messages (heartbeats) for 30s. Guest may be hung.");
            warned_exec = true;
        }
        unsafe {
            core_foundation_sys::runloop::CFRunLoopRunInMode(
                core_foundation_sys::runloop::kCFRunLoopDefaultMode,
                0.05,
                0,
            );
        }
        // Accept any incoming proxy connections during exec.
        while let Ok(conn) = mgr.try_accept() {
            if conn.port == VSOCK_PORT_SNI_PROXY {
                if let Some(ref config) = mitm_config {
                    let fd = conn.fd;
                    let config = Arc::clone(config);
                    rt.spawn(async move {
                        let _conn = conn;
                        mitm_proxy::handle_connection(fd, config).await;
                    });
                }
            } else if conn.port == VSOCK_PORT_FS_WATCH {
                if let Some(ref net_state) = net_state {
                    let db = Arc::clone(&net_state.db);
                    let fd = conn.fd;
                    rt.spawn(async move {
                        let _conn = conn;
                        handle_fs_watch(fd, db).await;
                    });
                }
            } else if conn.port == VSOCK_PORT_MCP_GATEWAY {
                if let Some(ref config) = mcp_config {
                    let fd = conn.fd;
                    let config = Arc::clone(config);
                    rt.spawn(async move {
                        let _conn = conn;
                        gateway::serve_mcp_session(fd, config).await;
                    });
                }
            } else if conn.port == VSOCK_PORT_PORT_WATCH {
                let fd = conn.fd;
                let ps = Arc::clone(&cli_port_state);
                let proc_s = Arc::clone(&cli_process_state);
                rt.spawn(async move {
                    let _conn = conn;
                    handle_port_watch(fd, ps, proc_s).await;
                });
            } else if conn.port == VSOCK_PORT_PORT_FORWARD {
                if let Ok(file) = clone_fd(conn.fd) {
                    use std::os::unix::io::IntoRawFd;
                    let _ = cli_port_state.relay_tx.send(file.into_raw_fd());
                }
                drop(conn);
            } else {
                _conns.push(conn);
            }
        }
        match ctrl_msg_rx.try_recv() {
            Ok(GuestToHost::ExecDone { id, exit_code: code }) if id == exec_id => {
                exit_code = code;
                break;
            }
            Ok(GuestToHost::Pong) => {
                last_msg_time = Instant::now();
                warned_exec = false;
            }
            Ok(other) => {
                last_msg_time = Instant::now();
                warned_exec = false;
                eprintln!("[clawcage] control message during exec: {other:?}");
            }
            Err(std::sync::mpsc::TryRecvError::Empty) => continue,
            Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                eprintln!("[clawcage] control channel closed during exec");
                exit_code = 1;
                break;
            }
        }
    }

    // Stop VM and drop connections (closes vsock fds, unblocks the reader).
    let _ = vm.stop();
    drop(_conns);
    // Wait for terminal reader to drain remaining output.
    let _ = terminal_reader.join();

    // Clean up session: delete scratch.img, snapshot counts, update status.
    if let Some(ref dir) = cli_session_dir {
        let db_ref = net_state.as_ref().map(|ns| ns.db.as_ref());
        cleanup_session(dir, scratch_path.as_deref(), &cli_session_id, session_index, db_ref);
    }

    // Drop network state to close DbWriter (flushes WAL via checkpoint on drop).
    drop(net_state);

    // Vacuum and compress the session DB.
    if let Some(ref dir) = cli_session_dir {
        vacuum_session(&cli_session_id, session_index, dir);
    }

    // Ensure the host shell prompt starts on a fresh line.
    if !last_was_newline.load(std::sync::atomic::Ordering::Relaxed) {
        let _ = std::io::stdout().write_all(b"\n");
        let _ = std::io::stdout().flush();
    }
    std::process::exit(exit_code);
}

/// Holds a pending update so the frontend can trigger download+install on demand.
struct PendingUpdate(std::sync::Mutex<Option<tauri_plugin_updater::Update>>);

/// Check for app updates using Tauri's updater plugin.
/// Emits `update-available` to the frontend instead of showing a native dialog.
/// Retries up to 3 times with exponential backoff to handle transient network
/// failures (GitHub CDN hiccups, rate limits, slow DNS on cold start).
async fn check_for_update(app: tauri::AppHandle) {
    use tauri_plugin_updater::UpdaterExt;

    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => {
            info!("updater not available: {e:#}");
            return;
        }
    };

    let mut update_result = None;
    for attempt in 0..3u32 {
        if attempt > 0 {
            let delay = std::time::Duration::from_secs(2u64.pow(attempt)); // 2s, 4s
            info!("retrying update check in {}s (attempt {})", delay.as_secs(), attempt + 1);
            tokio::time::sleep(delay).await;
        }
        match updater.check().await {
            Ok(Some(update)) => {
                update_result = Some(update);
                break;
            }
            Ok(None) => {
                info!("no update available");
                return;
            }
            Err(e) => {
                info!("update check attempt {} failed: {e:#}", attempt + 1);
                if attempt == 2 {
                    return;
                }
            }
        }
    }
    let update = match update_result {
        Some(u) => u,
        None => return,
    };

    let version = update.version.clone();
    let body = update.body.clone().unwrap_or_default();
    info!("update available: v{version}");

    // Store for later download.
    if let Some(state) = app.try_state::<PendingUpdate>() {
        *state.0.lock().unwrap() = Some(update);
    }

    // Notify frontend.
    let _ = app.emit("update-available", serde_json::json!({
        "version": version,
        "notes": body,
    }));
}

/// Frontend-triggered: download and install the pending update with progress events.
#[tauri::command]
async fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    let update = app
        .try_state::<PendingUpdate>()
        .and_then(|s| s.0.lock().unwrap().take())
        .ok_or_else(|| "no pending update".to_string())?;

    let handle = app.clone();
    let mut downloaded: usize = 0;
    update
        .download_and_install(
            move |chunk_len, total| {
                downloaded += chunk_len;
                let _ = handle.emit(
                    "update-progress",
                    serde_json::json!({
                        "downloaded": downloaded,
                        "total": total,
                    }),
                );
            },
            || {},
        )
        .await
        .map_err(|e| format!("{e:#}"))?;

    app.restart();
    #[allow(unreachable_code)]
    Ok(())
}

// ---------------------------------------------------------------------------
// Venv lifecycle: boot and stop VMs on demand
// ---------------------------------------------------------------------------

/// Rebuild the system tray menu with current venv list and status.
fn update_tray_status(handle: &tauri::AppHandle, _venv_name: Option<&str>) {
    use tauri::menu::{MenuBuilder, MenuItemBuilder, IconMenuItemBuilder};

    let app_state = handle.state::<AppState>();
    let version = app_state.tray_info.lock().unwrap()
        .as_ref()
        .map(|i| i.version.clone())
        .unwrap_or_default();

    let running_venvs = app_state.running_venvs.lock().unwrap().clone();

    let venvs = venvs::load_venvs().unwrap_or_default();
    // Sort by last_used descending, take top 5.
    let mut recent: Vec<_> = venvs.into_iter().collect();
    recent.sort_by(|a, b| b.last_used.cmp(&a.last_used));
    let show_more = recent.len() > 5;
    recent.truncate(5);

    let Ok(menu) = (|| -> Result<tauri::menu::Menu<tauri::Wry>, Box<dyn std::error::Error>> {
        let mut builder = MenuBuilder::new(handle);

        // Header
        builder = builder.item(
            &MenuItemBuilder::with_id("header", format!("Clawcage v{version}"))
                .enabled(false)
                .build(handle)?
        );
        builder = builder.separator();

        // Venv list — use live running_venvs, not persisted status
        if recent.is_empty() {
            builder = builder.item(
                &MenuItemBuilder::with_id("no-envs", "No environments")
                    .enabled(false)
                    .build(handle)?
            );
        } else {
            let green = tauri::image::Image::from_bytes(include_bytes!("../icons/tray-venv-active.png")).unwrap();
            let gray = tauri::image::Image::from_bytes(include_bytes!("../icons/tray-venv-inactive.png")).unwrap();

            for v in &recent {
                let is_running = running_venvs.contains_key(&v.id);
                let label = v.name.clone();
                let action_id = if is_running {
                    format!("stop:{}", v.id)
                } else {
                    format!("start:{}", v.id)
                };
                let icon = if is_running { green.clone() } else { gray.clone() };
                builder = builder.item(
                    &IconMenuItemBuilder::with_id(action_id, label)
                        .icon(icon)
                        .build(handle)?
                );
            }
        }

        if show_more {
            builder = builder.item(
                &MenuItemBuilder::with_id("show-more", "View all...").build(handle)?
            );
        }

        builder = builder.separator();
        builder = builder.item(&MenuItemBuilder::with_id("show", "Open Dashboard").build(handle)?);
        builder = builder.separator();
        builder = builder.item(&MenuItemBuilder::with_id("quit", "Quit Clawcage").build(handle)?);

        Ok(builder.build()?)
    })() else {
        return;
    };

    // Update the tray icon's menu.
    if let Some(tray) = handle.tray_by_id("main") {
        let _ = tray.set_menu(Some(menu));
    }
}

/// Per-venv data directory: ~/.clawcage/venvs/<venv_id>/
fn venv_scratch_dir(venv_id: &str) -> Option<PathBuf> {
    std::env::var("HOME").ok().map(|h| {
        PathBuf::from(h).join(".clawcage").join("venvs").join(venv_id)
    })
}

/// Stop a specific VM by venv_id. Cleans up session, terminal output, and VM instance.
pub(crate) fn stop_vm(handle: &tauri::AppHandle, venv_id: &str) -> Result<(), String> {
    let app_state = handle.state::<AppState>();

    // Remove from running_venvs and get the session_id.
    let session_id = {
        let mut running = app_state.running_venvs.lock().unwrap();
        running.remove(venv_id)
    };

    let Some(session_id) = session_id else {
        return Ok(()); // Not running
    };

    info!(session_id = %session_id, venv_id = %venv_id, "stopping VM");

    // Remove VmInstance from the map (takes ownership).
    let instance = {
        let mut vms = app_state.vms.lock().unwrap();
        vms.remove(&session_id)
    };

    if let Some(instance) = instance {
        // Flush guest filesystems before stopping.
        {
            let term_fd = instance.vsock_terminal_fd.unwrap_or(instance.serial_input_fd);
            if let Ok(mut file) = clone_fd(term_fd) {
                let payload = b"\x03\nsync\n";
                let frame = clawcage_core::clawcage_proto::encode_terminal_frame(
                    clawcage_core::clawcage_proto::DEFAULT_SHELL_SESSION_ID,
                    payload,
                );
                let _ = file.write_all(&frame);
                let _ = file.flush();
            }
            std::thread::sleep(Duration::from_millis(1500));
        }

        // Stop the VM.
        let _ = instance._vm.stop();

        // Clean up session.
        let session_dir = session_dir_for(&session_id);
        if let Some(ref dir) = session_dir {
            let db_ref = instance.net_state.as_ref().map(|ns| ns.db.as_ref());
            let idx = app_state.session_index.lock().unwrap();
            cleanup_session(dir, None, &session_id, &idx, db_ref);
        }

        drop(instance);

        if let Some(ref dir) = session_dir {
            let idx = app_state.session_index.lock().unwrap();
            vacuum_session(&session_id, &idx, dir);
        }
    }

    // Close this venv's terminal output queues.
    if let Some(output) = app_state.terminal_outputs.lock().unwrap().remove(venv_id) {
        output.close_all();
    }

    let _ = handle.emit("vm-state-changed", serde_json::json!({
        "state": "Idle",
        "trigger": "vm_stopped",
        "venv_id": venv_id,
    }));

    update_tray_status(handle, None);

    Ok(())
}

/// Stop all running VMs. Used on app quit.
pub(crate) fn stop_all_vms(handle: &tauri::AppHandle) -> Result<(), String> {
    let app_state = handle.state::<AppState>();
    let venv_ids: Vec<String> = app_state.running_venvs.lock().unwrap().keys().cloned().collect();
    for vid in venv_ids {
        stop_vm(handle, &vid)?;
    }
    Ok(())
}

/// Backward-compatible: stop the focused VM (or all if quitting).
pub(crate) fn stop_active_vm(handle: &tauri::AppHandle) -> Result<(), String> {
    stop_all_vms(handle)
}

/// Boot a new VM for the given venv. Multiple VMs can run in parallel.
/// Downloads rootfs if necessary.
pub(crate) fn boot_venv(handle: &tauri::AppHandle, venv_id: &str) -> Result<(), String> {
    // If this specific venv is already running, do nothing.
    {
        let app_state = handle.state::<AppState>();
        if app_state.running_venvs.lock().unwrap().contains_key(venv_id) {
            return Ok(());
        }
    }

    let app_state = handle.state::<AppState>();
    let asset_config = handle.state::<AssetConfig>();

    let assets = asset_config.assets_dir.clone();
    let rootfs = asset_config.rootfs_path.read().unwrap().clone();

    // Load VM settings (per-venv overrides applied).
    let vm_settings = policy_config::load_merged_vm_settings_for_venv(Some(venv_id));
    let scratch_size = vm_settings.scratch_disk_size_gb.unwrap_or(16);
    let cpu_count = vm_settings.cpu_count.unwrap_or(4);
    let ram_gb = vm_settings.ram_gb.unwrap_or(4);
    let ram_bytes: u64 = ram_gb as u64 * 1024 * 1024 * 1024;

    // Generate a new session ID for this venv boot.
    let session_id = session::generate_session_id();
    info!(session_id = %session_id, venv_id = %venv_id, "booting venv");

    // Create session directory (for telemetry DB).
    let session_dir = session_dir_for(&session_id);
    if let Some(ref d) = session_dir {
        let _ = std::fs::create_dir_all(d);
    }

    // Per-venv scratch disk: ~/.clawcage/venvs/<venv_id>/scratch.img
    // Persistent venvs: only created on first boot; preserved across reboots.
    // Ephemeral venvs: scratch disk is recreated fresh on every boot.
    let is_ephemeral = venvs::load_venvs()
        .ok()
        .and_then(|vs| vs.into_iter().find(|v| v.id == venv_id).map(|v| v.ephemeral))
        .unwrap_or(false);

    let scratch_path = venv_scratch_dir(venv_id).and_then(|d| {
        std::fs::create_dir_all(&d).ok();
        let path = d.join("scratch.img");
        if is_ephemeral && path.exists() {
            // Ephemeral: remove old scratch disk so it's fresh each boot.
            let _ = std::fs::remove_file(&path);
            info!("ephemeral venv: removed old scratch disk for {venv_id}");
        }
        if !path.exists() {
            if let Err(e) = create_scratch_disk(&path, scratch_size) {
                warn!("failed to create scratch disk: {e}");
                return None;
            }
            info!(size_gb = scratch_size, "created new scratch disk for venv {venv_id}");
        } else {
            info!("reusing existing scratch disk for venv {venv_id}");
        }
        Some(path)
    });

    // Record session in main.db.
    {
        let idx = app_state.session_index.lock().unwrap();
        let record = SessionRecord {
            id: session_id.clone(),
            mode: "gui".to_string(),
            command: None,
            status: "running".to_string(),
            created_at: session::now_iso(),
            stopped_at: None,
            scratch_disk_size_gb: scratch_size,
            ram_bytes,
            total_requests: 0,
            allowed_requests: 0,
            denied_requests: 0,
            total_input_tokens: 0,
            total_output_tokens: 0,
            total_estimated_cost: 0.0,
            total_tool_calls: 0,
            total_mcp_calls: 0,
            total_file_events: 0,
            compressed_size_bytes: None,
            vacuumed_at: None,
        };
        if let Err(e) = idx.create_session(&record) {
            warn!("failed to record session: {e}");
        }
    }

    // Register this VM as running and create its terminal output map.
    app_state.running_venvs.lock().unwrap().insert(venv_id.to_string(), session_id.clone());
    *app_state.focused_venv_id.lock().unwrap() = Some(venv_id.to_string());
    let terminal_output = Arc::new(state::TerminalOutputMap::new());
    app_state.terminal_outputs.lock().unwrap().insert(venv_id.to_string(), Arc::clone(&terminal_output));

    if rootfs.is_some() {
        // Rootfs available -- boot immediately.
        gui_boot_vm(
            handle, &assets, rootfs.as_deref(),
            &session_id, scratch_path, cpu_count, ram_bytes,
            Some(venv_id),
        );
    } else {
        // Rootfs not found -- download it first.
        info!("rootfs not found, initiating download");
        let _ = handle.emit("vm-state-changed", serde_json::json!({
            "state": "Downloading",
            "trigger": "rootfs_missing",
        }));

        let h = handle.clone();
        let assets_clone = assets.clone();
        let sid = session_id.clone();
        let vid = venv_id.to_string();
        tauri::async_runtime::spawn(async move {
            let mgr = match create_asset_manager(&assets_clone) {
                Ok(m) => m,
                Err(e) => {
                    error!("asset manager init failed: {e:#}");
                    let _ = h.emit("vm-state-changed", serde_json::json!({
                        "state": "Error",
                        "trigger": "asset_init_failed",
                    }));
                    return;
                }
            };

            let name = match rootfs_manifest_name(&mgr) {
                Ok(n) => n,
                Err(e) => {
                    error!("rootfs not in manifest: {e:#}");
                    let _ = h.emit("vm-state-changed", serde_json::json!({
                        "state": "Error",
                        "trigger": "manifest_error",
                    }));
                    return;
                }
            };

            let _ = mgr.cleanup_unrecognized();

            let h2 = h.clone();
            let client = reqwest::Client::new();
            match mgr.download_asset(&name, &client, move |progress| {
                let _ = h2.emit("download-progress", &progress);
            }).await {
                Ok(rootfs) => {
                    info!("rootfs downloaded to {}", rootfs.display());
                    // Cache the rootfs path for future boots.
                    let ac = h.state::<AssetConfig>();
                    *ac.rootfs_path.write().unwrap() = Some(rootfs.clone());
                    gui_boot_vm(
                        &h, &assets_clone, Some(&rootfs),
                        &sid, scratch_path, cpu_count, ram_bytes,
                        Some(&vid),
                    );
                }
                Err(e) => {
                    error!("rootfs download failed: {e:#}");
                    let _ = h.emit("vm-state-changed", serde_json::json!({
                        "state": "Error",
                        "trigger": "download_failed",
                    }));
                }
            }
        });
    }

    // Update tray menu with venv name.
    let venv_name = venvs::load_venvs()
        .ok()
        .and_then(|vs| vs.into_iter().find(|v| v.id == venv_id).map(|v| v.name));
    update_tray_status(handle, venv_name.as_deref());

    Ok(())
}

/// Boot the VM and set up all subsystems (vsock, serial, MITM proxy, MCP gateway).
/// Called either immediately from the setup hook (rootfs available in bundle) or
/// after async rootfs download completes.
fn gui_boot_vm(
    handle: &tauri::AppHandle,
    assets: &Path,
    rootfs: Option<&Path>,
    session_id: &str,
    scratch_path: Option<PathBuf>,
    cpu_count: u32,
    ram_bytes: u64,
    venv_id: Option<&str>,
) {
    match boot_vm(assets, rootfs, "console=hvc0 ro loglevel=1", scratch_path.as_deref(), cpu_count, ram_bytes) {
        Ok((vm, rx, input_fd, sm)) => {
            info!("VM booted successfully");

            // Register vsock listeners on the socket device.
            let vsock_manager = {
                let socket_devices = vm.socket_devices();
                match VsockManager::new(
                    &socket_devices,
                    &[VSOCK_PORT_CONTROL, VSOCK_PORT_TERMINAL, VSOCK_PORT_SNI_PROXY, VSOCK_PORT_FS_WATCH, VSOCK_PORT_MCP_GATEWAY, VSOCK_PORT_PORT_WATCH, VSOCK_PORT_PORT_FORWARD, VSOCK_PORT_SYS_WATCH],
                ) {
                    Ok(mgr) => Some(mgr),
                    Err(e) => {
                        warn!("vsock setup failed: {e:#}, using serial-only mode");
                        None
                    }
                }
            };

            // Create per-VM network state (policy + info.db) with venv overrides.
            let net_state = match create_net_state_for_venv(session_id, venv_id) {
                Ok(ns) => Some(ns),
                Err(e) => {
                    warn!("network state init failed: {e:#}, SNI proxy disabled");
                    None
                }
            };

            // Create MCP gateway config for vsock:5003 (venv overrides applied).
            let mcp_config: Option<Arc<McpGatewayConfig>> = net_state.as_ref().map(|ns| {
                let domain_policy = policy_config::load_merged_domain_policy_for_venv(venv_id);
                Arc::new(McpGatewayConfig {
                    server_manager: tokio::sync::Mutex::new(McpServerManager::new(vec![])),
                    db: Arc::clone(&ns.db),
                    policy: tokio::sync::RwLock::new(Arc::new(McpPolicy::new())),
                    domain_policy: std::sync::RwLock::new(Arc::new(domain_policy)),
                    http_client: reqwest::Client::builder()
                        .user_agent("clawcage-mcp/0.8")
                        .timeout(std::time::Duration::from_secs(30))
                        .redirect(reqwest::redirect::Policy::limited(10))
                        .build()
                        .expect("reqwest client"),
                })
            });

            // Store VM state.
            {
                let app_state = handle.state::<AppState>();
                let mut vms = app_state.vms.lock().unwrap();
                vms.insert(session_id.to_string(), VmInstance {
                    _vm: vm,
                    serial_input_fd: input_fd,
                    vsock_terminal_fd: None,
                    vsock_control_fd: None,
                    net_state,
                    mcp_state: mcp_config.clone(),
                    state_machine: sm,
                    _scratch_disk_path: scratch_path,
                    port_state: std::sync::Arc::new(crate::state::PortState::new()),
                    process_state: std::sync::Arc::new(crate::state::ProcessState::new()),
                    vpn_state: Some(std::sync::Arc::new(clawcage_core::net::vpn::VpnManager::new())),
                    sys_metrics: std::sync::Arc::new(crate::state::SystemMetricsState::new()),
                });
            }

            // Reset the terminal output queue for the new session.
            {
                let app_state = handle.state::<AppState>();
                if let Some(vid) = venv_id {
                    if let Some(to) = app_state.terminal_output_for(vid) {
                        to.reset();
                    }
                }
            }

            // Serial forwarding for boot logs (aborted once vsock connects).
            let serial_output = {
                let app_state = handle.state::<AppState>();
                let vid = venv_id.unwrap_or("");
                match app_state.terminal_output_for(vid) {
                    Some(to) => to,
                    None => {
                        let to = Arc::new(crate::state::TerminalOutputMap::new());
                        app_state.terminal_outputs.lock().unwrap().insert(vid.to_string(), Arc::clone(&to));
                        to
                    }
                }
            };
            let serial_task = tauri::async_runtime::spawn(
                serial_to_events(serial_output, rx),
            );

            // Spawn vsock connection handler if available.
            let h = handle.clone();
            if let Some(mgr) = vsock_manager {
                let vsock_session_id = session_id.to_string();
                let vsock_venv_id = venv_id.unwrap_or("").to_string();
                tauri::async_runtime::spawn(
                    setup_vsock(h.clone(), mgr, serial_task, vsock_session_id, vsock_venv_id),
                );
            }

            // Push initial state to frontend (Booting, not yet Running).
            let _ = h.emit("vm-state-changed", serde_json::json!({
                "state": "Booting",
                "trigger": "vm_started",
            }));
        }
        Err(e) => {
            error!("VM boot failed: {e:#}");
            info!("continuing without VM (unsigned binary or missing entitlement)");
            let _ = handle.emit("vm-state-changed", serde_json::json!({
                "state": "Error",
                "trigger": "boot_failed",
            }));
        }
    }
}

fn main() {
    let cli_args: Vec<String> = std::env::args().skip(1).collect();

    let filter = match std::env::var("RUST_LOG") {
        Ok(_) => EnvFilter::from_default_env(),
        Err(_) => {
            let level = if cli_args.is_empty() { "debug" } else { "warn" };
            EnvFilter::new(format!("clawcage={level},clawcage_core={level}"))
        }
    };
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_span_events(FmtSpan::CLOSE)
        .init();

    // Open session index early (shared by CLI and GUI paths).
    let session_index = match sessions_dir() {
        Some(d) => {
            let _ = std::fs::create_dir_all(&d);
            match SessionIndex::open(&d.join("main.db")) {
                Ok(idx) => idx,
                Err(e) => {
                    eprintln!("clawcage: failed to open session index: {e}");
                    std::process::exit(1);
                }
            }
        }
        None => {
            eprintln!("clawcage: HOME not set, cannot create session index");
            std::process::exit(1);
        }
    };

    if !cli_args.is_empty() {
        cleanup_stale_sessions(&session_index);
        let (cli_env, remaining_args) = parse_env_args(&cli_args);
        if remaining_args.is_empty() {
            eprintln!("clawcage: no command specified");
            std::process::exit(1);
        }
        let command = remaining_args.join(" ");
        if let Err(e) = run_cli(&command, &cli_env, &session_index) {
            eprintln!("clawcage: {e:#}");
            std::process::exit(1);
        }
        return;
    }

    info!("starting clawcage");

    // Clean up stale sessions from previous runs.
    cleanup_stale_sessions(&session_index);

    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(AppState::new(session_index))
        .manage(PendingUpdate(std::sync::Mutex::new(None)))
        .setup(|app| {
            info!("tauri setup hook running");

            // Configure native macOS window for transparent frameless appearance.
            // The `macos-private-api` Tauri feature enables wry's `transparent` path
            // which disables WKWebView's drawsBackground. We still need to configure
            // the NSWindow itself: clear background + non-opaque so the CSS
            // border-radius on the app root creates clean rounded corners.
            #[cfg(target_os = "macos")]
            if let Some(win) = app.get_webview_window("main") {
                win.with_webview(|webview| {
                    unsafe {
                        use objc2_app_kit::{NSColor, NSWindow};
                        let ns_window: &NSWindow = &*webview.ns_window().cast();
                        ns_window.setOpaque(false);
                        ns_window.setBackgroundColor(Some(&NSColor::clearColor()));
                        ns_window.setHasShadow(true);

                        // Round the content view's layer so macOS clips all four
                        // corners natively (CSS overflow-hidden alone doesn't clip
                        // at the compositing level on the bottom corners).
                        if let Some(content_view) = ns_window.contentView() {
                            content_view.setWantsLayer(true);
                            if let Some(layer) = content_view.layer() {
                                let layer: &objc2::runtime::AnyObject = &*layer;
                                let _: () = objc2::msg_send![layer, setCornerRadius: 10.0_f64];
                                let _: () = objc2::msg_send![layer, setMasksToBounds: true];
                            }
                        }
                    }
                }).ok();
            }

            // Check for updates after a short delay to ensure network is ready.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                check_for_update(handle).await;
            });

            // Resolve assets directory and rootfs path once, store for reuse.
            let (assets, rootfs) = match resolve_assets_dir() {
                Ok(a) => {
                    let r = resolve_rootfs(&a);
                    info!("assets directory: {}", a.display());
                    (a, r)
                }
                Err(e) => {
                    error!("asset resolution failed: {e:#}");
                    info!("continuing without VM (frontend-only mode)");
                    let _ = app.handle().emit("vm-state-changed", serde_json::json!({
                        "state": "Error",
                        "trigger": "assets_not_found",
                    }));
                    return Ok(());
                }
            };

            app.manage(AssetConfig {
                assets_dir: assets,
                rootfs_path: std::sync::RwLock::new(rootfs),
            });

            // No auto-boot. User picks a venv from HomeView which triggers start_venv.
            let _ = app.handle().emit("vm-state-changed", serde_json::json!({
                "state": "Idle",
                "trigger": "app_started",
            }));

            // System tray: VMs keep running when the window is closed.
            use tauri::tray::{TrayIconBuilder, MouseButton, TrayIconEvent};

            let version = app.package_info().version.to_string();
            {
                let state: tauri::State<'_, AppState> = app.state();
                *state.tray_info.lock().unwrap() = Some(crate::state::TrayInfo {
                    version: version.clone(),
                });
            }

            let tray_icon = {
                let bytes = include_bytes!("../icons/tray-icon.png");
                tauri::image::Image::from_bytes(bytes).unwrap()
            };
            TrayIconBuilder::with_id("main")
                .icon(tray_icon)
                .icon_as_template(true)
                .tooltip(&format!("Clawcage v{version}"))
                .on_menu_event(|app, event| {
                    let id = event.id().as_ref().to_string();
                    if id == "show" || id == "show-more" {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    } else if id == "quit" {
                        let _ = crate::stop_active_vm(app);
                        app.exit(0);
                    } else if let Some(venv_id) = id.strip_prefix("start:") {
                        let h = app.clone();
                        let vid = venv_id.to_string();
                        app.run_on_main_thread(move || {
                            let _ = crate::boot_venv(&h, &vid);
                        }).ok();
                    } else if let Some(venv_id) = id.strip_prefix("stop:") {
                        let h = app.clone();
                        let vid = venv_id.to_string();
                        app.run_on_main_thread(move || {
                            let _ = crate::stop_vm(&h, &vid);
                        }).ok();
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::DoubleClick { button: MouseButton::Left, .. } = event {
                        if let Some(win) = tray.app_handle().get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                })
                .build(app)?;

            // Build initial tray menu.
            update_tray_status(app.handle(), None);

            Ok(())
        })
        // Hide window instead of quitting when a VM is running.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let has_vm = {
                    let state: tauri::State<'_, AppState> = window.app_handle().state();
                    state.has_running_vms()
                };
                if has_vm {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::focus_venv,
            commands::vm_status,
            commands::serial_input,
            commands::terminal_poll,
            commands::terminal_resize,
            commands::spawn_shell,
            commands::close_shell,
            commands::list_shells,
            commands::get_guest_config,
            commands::get_network_policy,
            commands::set_guest_env,
            commands::remove_guest_env,
            commands::get_vm_state,
            commands::get_settings,
            commands::get_settings_tree,
            commands::lint_config,
            commands::update_setting,
            commands::reset_venv_setting,
            commands::get_ports,
            commands::forward_port,
            commands::stop_forward,
            commands::start_browser_proxy,
            commands::stop_browser_proxy,
            commands::get_processes,
            commands::kill_process,
            commands::system_metrics,
            commands::venv_metrics,
            commands::host_disk_free,
            commands::download_file,
            commands::list_dir,
            commands::read_file,
            commands::save_file,
            commands::get_session_info,
            commands::query_db,
            commands::vpn_connect,
            commands::vpn_disconnect,
            commands::vpn_status,
            venvs::list_venvs,
            venvs::create_venv,
            venvs::save_venv_file,
            venvs::rename_venv,
            venvs::set_venv_icon,
            venvs::delete_venv,
            venvs::start_venv,
            venvs::stop_venv,
            install_update,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            match event {
                // Re-show window when Dock icon is clicked with no visible windows.
                tauri::RunEvent::Reopen { .. } => {
                    if let Some(win) = app_handle.get_webview_window("main") {
                        let _ = win.show();
                        let _ = win.set_focus();
                    }
                }
                // Graceful shutdown: stop all VMs before the process exits.
                tauri::RunEvent::ExitRequested { api, .. } => {
                    let has_vms = {
                        let state: tauri::State<'_, AppState> = app_handle.state();
                        state.has_running_vms()
                    };
                    if has_vms {
                        api.prevent_exit();
                        info!("graceful shutdown: stopping all VMs before exit");
                        let _ = stop_all_vms(app_handle);
                        app_handle.exit(0);
                    }
                }
                _ => {}
            }
        });
}
