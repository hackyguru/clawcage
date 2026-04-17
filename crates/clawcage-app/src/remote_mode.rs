//! Remote mode: per-venv state for "venv runs on a Hetzner VPS".
//!
//! Transfer: rsync over SSH (delta, resume, progress, E2E encrypted by SSH).
//!
//! Lifecycle (driven by Tauri commands):
//!
//!   Local ──detach_venv──▶ Detaching ──┐
//!                                       │  1. provision blank VPS via cloud API
//!                                       │  2. rsync scratch.img → VPS
//!                                       │  3. SSH: mount + tmux
//!                                       ▼
//!                                     Remote ──reattach_venv──▶ Reattaching ──┐
//!                                                                              │
//!     ┌─────────────────────────────────────────────────────────────── Local ◀┘
//!     1. SSH: umount scratch.img on VPS
//!     2. rsync scratch.img ← VPS (delta — only changed blocks)
//!     3. destroy VPS + SSH key via cloud API
//!
//! Per-venv remote state is persisted to `~/.clawcage/venvs/<venv_id>/remote.json`
//! so a desktop app restart while a venv is remote doesn't lose the SSH key
//! path / VPS IP / session id needed to reattach.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::Emitter;

use crate::cloud;

/// Progress event emitted during detach/reattach for the frontend modal.
#[derive(Clone, Serialize)]
pub struct RemoteModeProgress {
    pub venv_id: String,
    pub operation: String,       // "detach" | "reattach"
    pub step: String,            // machine-readable step id
    pub step_label: String,      // human-readable label
    pub step_index: u32,         // 0-based
    pub total_steps: u32,
    pub done: bool,
    pub error: Option<String>,
}

fn emit_step(
    handle: &tauri::AppHandle,
    venv_id: &str,
    operation: &str,
    step: &str,
    label: &str,
    index: u32,
    total: u32,
) {
    let _ = handle.emit("remote-mode-progress", RemoteModeProgress {
        venv_id: venv_id.to_string(),
        operation: operation.to_string(),
        step: step.to_string(),
        step_label: label.to_string(),
        step_index: index,
        total_steps: total,
        done: false,
        error: None,
    });
}

fn emit_done(handle: &tauri::AppHandle, venv_id: &str, operation: &str, total: u32) {
    let _ = handle.emit("remote-mode-progress", RemoteModeProgress {
        venv_id: venv_id.to_string(),
        operation: operation.to_string(),
        step: "done".to_string(),
        step_label: "Done".to_string(),
        step_index: total,
        total_steps: total,
        done: true,
        error: None,
    });
}

fn emit_error(handle: &tauri::AppHandle, venv_id: &str, operation: &str, error: &str) {
    let _ = handle.emit("remote-mode-progress", RemoteModeProgress {
        venv_id: venv_id.to_string(),
        operation: operation.to_string(),
        step: "error".to_string(),
        step_label: "Failed".to_string(),
        step_index: 0,
        total_steps: 0,
        done: true,
        error: Some(error.to_string()),
    });
}

/// Connection mode for a venv. Persisted to ~/.clawcage/venvs/<id>/remote.json.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case", tag = "type")]
pub enum ConnectionMode {
    Local,
    Detaching,
    Remote(RemoteVenvInfo),
    Reattaching(RemoteVenvInfo),
}

impl Default for ConnectionMode {
    fn default() -> Self { Self::Local }
}

/// Per-venv remote-session metadata.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RemoteVenvInfo {
    pub session_id: String,
    pub vps_ip: String,
    pub ssh_fingerprint: String,
    pub ssh_key_path: String,
    pub detached_at: String,
    /// Legacy fields kept for serde backward compat (default to empty).
    #[serde(default)] pub session_key_b64: String,
    #[serde(default)] pub snapshot_path: String,
}

// ── On-disk persistence ─────────────────────────────────────────────────

fn venv_dir(venv_id: &str) -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    let dir = PathBuf::from(home).join(".clawcage").join("venvs").join(venv_id);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create venv dir: {e}"))?;
    Ok(dir)
}

fn remote_state_path(venv_id: &str) -> Result<PathBuf, String> {
    Ok(venv_dir(venv_id)?.join("remote.json"))
}

/// User-level SSH key for remote mode (shared across all venvs/sessions).
fn user_ssh_key_path() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    let dir = PathBuf::from(home).join(".clawcage");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create .clawcage dir: {e}"))?;
    Ok(dir.join("remote_ssh_key"))
}

fn scratch_img_path(venv_id: &str) -> Result<PathBuf, String> {
    Ok(venv_dir(venv_id)?.join("scratch.img"))
}

pub fn load_mode(venv_id: &str) -> ConnectionMode {
    let Ok(path) = remote_state_path(venv_id) else { return ConnectionMode::Local };
    let Ok(data) = std::fs::read_to_string(&path) else { return ConnectionMode::Local };
    serde_json::from_str(&data).unwrap_or(ConnectionMode::Local)
}

fn save_mode(venv_id: &str, mode: &ConnectionMode) -> Result<(), String> {
    let path = remote_state_path(venv_id)?;
    if matches!(mode, ConnectionMode::Local) {
        let _ = std::fs::remove_file(&path);
        return Ok(());
    }
    let data = serde_json::to_string_pretty(mode).map_err(|e| format!("serialize mode: {e}"))?;
    std::fs::write(&path, data).map_err(|e| format!("write remote.json: {e}"))
}

// ── SSH helpers ─────────────────────────────────────────────────────────

fn ssh_opts(key_path: &str) -> Vec<String> {
    vec![
        "-i".into(), key_path.into(),
        "-o".into(), "StrictHostKeyChecking=no".into(),
        "-o".into(), "UserKnownHostsFile=/dev/null".into(),
        "-o".into(), "LogLevel=ERROR".into(),
        "-o".into(), "ConnectTimeout=30".into(),
        "-o".into(), "ServerAliveInterval=15".into(),
        "-o".into(), "ServerAliveCountMax=3".into(),
    ]
}

/// Wait until the VPS accepts SSH connections (up to `timeout_secs`).
async fn wait_for_ssh(ip: &str, key_path: &str, timeout_secs: u64) -> Result<(), String> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);
    loop {
        let out = tokio::process::Command::new("ssh")
            .args(ssh_opts(key_path))
            .arg(format!("root@{ip}"))
            .arg("echo ready")
            .output()
            .await
            .map_err(|e| format!("ssh spawn: {e}"))?;
        if out.status.success() {
            return Ok(());
        }
        if std::time::Instant::now() > deadline {
            return Err("SSH never came up".into());
        }
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    }
}

/// Run an SSH command, return (stdout, stderr) on success or error with stderr.
async fn ssh_run(ip: &str, key_path: &str, cmd: &str) -> Result<String, String> {
    let out = tokio::process::Command::new("ssh")
        .args(ssh_opts(key_path))
        .arg(format!("root@{ip}"))
        .arg(cmd)
        .output()
        .await
        .map_err(|e| format!("ssh spawn: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("ssh command failed: {stderr}"));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Transfer scratch.img between local and VPS.
///
/// Instead of rsync-ing the raw 16 GB sparse ext4 image (which takes
/// forever even with SSH compression because zlib is CPU-bound on 16 GB),
/// we pipe through zstd which handles sparse data ~100x faster:
///
///   UP:   zstd < local scratch.img | ssh VPS "zstd -d > /root/archive/scratch.img"
///   DOWN: ssh VPS "zstd < /root/archive/scratch.img" | zstd -d > local scratch.img
///
/// zstd compresses 16 GB of zeros to ~1 MB in seconds. The pipe streams
/// so memory stays bounded. Resume is handled by retrying the whole
/// transfer (it's fast enough that partial-resume isn't needed).
async fn transfer_scratch(
    key_path: &str,
    ip: &str,
    local_path: &str,
    direction: &str,
) -> Result<(), String> {
    let ssh_base = format!(
        "ssh -i {key} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
         -o LogLevel=ERROR -o ServerAliveInterval=15 -o ServerAliveCountMax=3 root@{ip}",
        key = key_path, ip = ip
    );

    let cmd = if direction == "up" {
        // Local → VPS: zstd compress locally, pipe through SSH, decompress on VPS.
        format!(
            "zstd -T0 -1 --sparse < '{local}' | {ssh} 'zstd -d --sparse -o /root/archive/scratch.img -f'",
            local = local_path, ssh = ssh_base
        )
    } else {
        // VPS → Local: zstd compress on VPS, pipe through SSH, decompress locally.
        format!(
            "{ssh} 'zstd -T0 -1 < /root/archive/scratch.img' | zstd -d --sparse -o '{local}' -f",
            ssh = ssh_base, local = local_path
        )
    };

    let out = tokio::process::Command::new("sh")
        .arg("-c")
        .arg(&cmd)
        .output()
        .await
        .map_err(|e| format!("transfer spawn: {e}"))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("transfer failed: {stderr}"));
    }
    Ok(())
}

// ── Tauri commands ──────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct VenvConnectionStatus {
    pub venv_id: String,
    pub mode: ConnectionMode,
}

#[tauri::command]
pub async fn get_venv_connection(venv_id: String) -> Result<VenvConnectionStatus, String> {
    let mode = tokio::task::spawn_blocking({
        let id = venv_id.clone();
        move || load_mode(&id)
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))?;
    Ok(VenvConnectionStatus { venv_id, mode })
}

#[tauri::command]
pub async fn list_venv_connections(venv_ids: Vec<String>) -> Result<Vec<VenvConnectionStatus>, String> {
    tokio::task::spawn_blocking(move || {
        Ok(venv_ids.into_iter().map(|id| {
            let mode = load_mode(&id);
            VenvConnectionStatus { venv_id: id, mode }
        }).collect())
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))?
}

/// Detach a venv to remote mode via rsync over SSH.
///
/// Flow:
///   1. Ensure user-level SSH key exists (reuses across sessions).
///   2. Provision or reuse idle VPS via the cloud API.
///   3. Wait for SSH (skipped if VPS was reused — already running).
///   4. Transfer scratch.img from local → VPS.
///   5. Mount scratch.img + start tmux session.
///   6. Persist ConnectionMode::Remote.
#[tauri::command]
pub async fn detach_venv(
    venv_id: String,
    venv_name: String,
    location: Option<String>,
    server_type: Option<String>,
    app_handle: tauri::AppHandle,
) -> Result<VenvConnectionStatus, String> {
    const TOTAL: u32 = 5;
    let h = &app_handle;
    let vid = venv_id.as_str();

    save_mode(&venv_id, &ConnectionMode::Detaching)?;

    // Session ID captured after cloud provisioning so rollback can destroy it.
    let session_id_slot: std::sync::Arc<std::sync::Mutex<Option<String>>> =
        std::sync::Arc::new(std::sync::Mutex::new(None));

    // Rollback helper: cleans up local state. Does NOT destroy VPS or delete
    // the user-level SSH key (both are reusable resources).
    let do_rollback = |vid_owned: String, _sid_slot: std::sync::Arc<std::sync::Mutex<Option<String>>>, err: String| -> Result<VenvConnectionStatus, String> {
        let _ = save_mode(&vid_owned, &ConnectionMode::Local);
        Err(err)
    };

    macro_rules! rollback {
        ($err:expr) => {{
            let e = $err;
            emit_error(h, vid, "detach", &e);
            return do_rollback(venv_id.clone(), session_id_slot.clone(), e);
        }};
    }

    // Step 1: Ensure SSH key.
    emit_step(h, vid, "detach", "ssh_key", "Preparing SSH key...", 0, TOTAL);
    let kp = match ensure_user_ssh_key().await {
        Ok(kp) => kp,
        Err(e) => rollback!(format!("ssh key: {e}")),
    };

    // Step 2: Provision or reuse idle VPS.
    emit_step(h, vid, "detach", "provision", "Connecting to cloud server...", 1, TOTAL);
    let resp = match cloud::create_remote_session(
        venv_name.clone(),
        kp.public_openssh.clone(),
        location.clone(),
        server_type.clone(),
    ).await {
        Ok(r) => r,
        Err(e) if e.contains("409") => {
            // Stale session — force-cleanup and retry once.
            eprintln!("[remote_mode] 409 conflict — cleaning up stale sessions and retrying");
            emit_step(h, vid, "detach", "cleanup_stale", "Cleaning up stale cloud session...", 1, TOTAL);
            if let Err(ce) = cloud::force_cleanup_remote_sessions().await {
                rollback!(format!("cleanup stale sessions failed: {ce}"));
            }
            emit_step(h, vid, "detach", "provision", "Provisioning cloud server...", 1, TOTAL);
            match cloud::create_remote_session(
                venv_name.clone(),
                kp.public_openssh,
                location,
                server_type,
            ).await {
                Ok(r) => r,
                Err(e2) => rollback!(format!("create remote session (after cleanup): {e2}")),
            }
        }
        Err(e) => rollback!(format!("create remote session: {e}")),
    };

    let reused = resp.reused;
    *session_id_slot.lock().unwrap() = Some(resp.session.id.clone());

    let mut vps_ip = resp.session.vps_ip.clone().unwrap_or_default();
    if vps_ip.is_empty() {
        // Fresh VPS still booting — poll until ready.
        for _ in 0..30 {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            if let Ok(status) = cloud::get_remote_session(resp.session.id.clone()).await {
                if let Some(ref got_ip) = status.session.vps_ip {
                    if status.session.state == "ready" {
                        vps_ip = got_ip.clone();
                        break;
                    }
                }
            }
        }
        if vps_ip.is_empty() {
            rollback!("VPS never became ready".to_string());
        }
    }

    // Step 3: Wait for SSH + create dirs.
    if reused {
        // Reused VPS is already running — quick connectivity check.
        emit_step(h, vid, "detach", "wait_ssh", "Reconnecting to server...", 2, TOTAL);
        if let Err(e) = wait_for_ssh(&vps_ip, &kp.private_path, 15).await {
            rollback!(format!("reused VPS unreachable: {e}"));
        }
    } else {
        emit_step(h, vid, "detach", "wait_ssh", "Waiting for server to boot...", 2, TOTAL);
        if let Err(e) = wait_for_ssh(&vps_ip, &kp.private_path, 120).await {
            rollback!(format!("wait for SSH: {e}"));
        }
    }
    if let Err(e) = ssh_run(&vps_ip, &kp.private_path, "mkdir -p /root/archive /root/venv").await {
        rollback!(format!("create dirs: {e}"));
    }

    // Step 4: Transfer venv data.
    emit_step(h, vid, "detach", "transfer", "Transferring venv data...", 3, TOTAL);
    let scratch = match scratch_img_path(&venv_id) {
        Ok(p) if p.exists() => p.to_string_lossy().to_string(),
        _ => rollback!("scratch.img not found locally".to_string()),
    };
    if let Err(e) = transfer_scratch(&kp.private_path, &vps_ip, &scratch, "up").await {
        rollback!(format!("transfer up: {e}"));
    }

    // Step 5: Start remote session.
    emit_step(h, vid, "detach", "start", "Starting remote session...", 4, TOTAL);
    // Ensure clean state: kill any leftover tmux, unmount any stale mount.
    let _ = ssh_run(&vps_ip, &kp.private_path,
        "tmux kill-server 2>/dev/null; umount /root/venv 2>/dev/null; true").await;
    let tmux_name = shell_escape(&venv_name);
    let mount_cmd = format!(
        "mount -o loop,rw /root/archive/scratch.img /root/venv && \
         tmux new-session -d -s {tmux_name} -x 200 -y 50 'cd /root/venv; exec bash -l'"
    );
    if let Err(e) = ssh_run(&vps_ip, &kp.private_path, &mount_cmd).await {
        rollback!(format!("mount + tmux: {e}"));
    }

    // Done: persist state.
    let info = RemoteVenvInfo {
        session_id: resp.session.id.clone(),
        vps_ip,
        ssh_fingerprint: resp.session.ssh_fingerprint.clone().unwrap_or_default(),
        ssh_key_path: kp.private_path,
        detached_at: clawcage_core::session::now_iso(),
        session_key_b64: String::new(),
        snapshot_path: String::new(),
    };
    let mode = ConnectionMode::Remote(info);
    save_mode(&venv_id, &mode)?;
    emit_done(h, vid, "detach", TOTAL);

    Ok(VenvConnectionStatus { venv_id, mode })
}

/// Reattach a venv from remote back to local via rsync over SSH.
///
/// The VPS is released to idle (not destroyed) so it can be reused on the
/// next detach — avoids Hetzner's per-server minimum billing charge.
///
/// Flow:
///   1. SSH: kill tmux, sync, umount scratch.img.
///   2. Transfer scratch.img VPS → local.
///   3. Release session to idle (VPS stays alive for reuse).
#[tauri::command]
pub async fn reattach_venv(
    venv_id: String,
    app_handle: tauri::AppHandle,
) -> Result<VenvConnectionStatus, String> {
    const TOTAL: u32 = 3;
    let h = &app_handle;
    let vid = venv_id.as_str();

    let current = load_mode(&venv_id);
    let info = match current {
        ConnectionMode::Remote(info) => info,
        ConnectionMode::Reattaching(info) => info,
        _ => return Err("venv is not in remote mode".into()),
    };

    save_mode(&venv_id, &ConnectionMode::Reattaching(info.clone()))?;

    // Step 1: Stop remote session.
    emit_step(h, vid, "reattach", "stop", "Stopping remote session...", 0, TOTAL);
    let _ = ssh_run(&info.vps_ip, &info.ssh_key_path,
        "tmux kill-server 2>/dev/null; sync; umount /root/venv 2>/dev/null; sync").await;

    // Step 2: Transfer data back.
    emit_step(h, vid, "reattach", "transfer", "Transferring venv data back...", 1, TOTAL);
    let scratch = scratch_img_path(&venv_id)?.to_string_lossy().to_string();
    if let Err(e) = transfer_scratch(&info.ssh_key_path, &info.vps_ip, &scratch, "down").await {
        emit_error(h, vid, "reattach", &format!("transfer down: {e}"));
        return Err(format!("transfer down: {e}"));
    }

    // Step 3: Finalize (release VPS to idle internally — kept alive for reuse).
    emit_step(h, vid, "reattach", "release", "Finalizing...", 2, TOTAL);
    if let Err(e) = cloud::release_remote_session(info.session_id.clone()).await {
        // Don't destroy on failure — the VPS should stay alive for reuse.
        // The next detach will find it via the cloud API regardless of state.
        eprintln!("[remote_mode] release failed (VPS kept alive): {e}");
    }

    // Done: clear local remote state. SSH key is user-level and persists.
    save_mode(&venv_id, &ConnectionMode::Local)?;
    emit_done(h, vid, "reattach", TOTAL);

    Ok(VenvConnectionStatus { venv_id, mode: ConnectionMode::Local })
}

/// Open a Terminal.app window with SSH + tmux attach.
#[tauri::command]
pub async fn open_remote_terminal(venv_id: String, venv_name: String) -> Result<(), String> {
    let mode = load_mode(&venv_id);
    let info = match mode {
        ConnectionMode::Remote(i) | ConnectionMode::Reattaching(i) => i,
        _ => return Err("venv is not in remote mode".to_string()),
    };
    let cmd = format!(
        "ssh -i {key} -t -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
         -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
         root@{ip} 'tmux new-session -A -s {tmux}'",
        key = shell_escape(&info.ssh_key_path),
        ip = info.vps_ip,
        tmux = shell_escape(&venv_name),
    );
    let applescript = format!(
        "tell application \"Terminal\" to do script \"{}\"\n\
         tell application \"Terminal\" to activate",
        cmd.replace('\\', "\\\\").replace('"', "\\\""),
    );
    let status = tokio::process::Command::new("osascript")
        .arg("-e").arg(&applescript)
        .status().await
        .map_err(|e| format!("spawn osascript: {e}"))?;
    if !status.success() {
        return Err(format!("osascript exited non-zero: {status}"));
    }
    Ok(())
}

// ── Helpers ─────────────────────────────────────────────────────────────

struct LocalSshKey {
    public_openssh: String,
    private_path: String,
}

/// Get or create the user-level SSH key for remote mode.
/// Reuses an existing key if present; only mints a new one on first use
/// (or if the key was manually deleted).
async fn ensure_user_ssh_key() -> Result<LocalSshKey, String> {
    let priv_path = user_ssh_key_path()?;
    let pub_path_buf = priv_path.with_extension("pub");

    // Reuse existing key if both halves exist.
    if priv_path.exists() && pub_path_buf.exists() {
        let public_openssh = std::fs::read_to_string(&pub_path_buf)
            .map_err(|e| format!("read pub key: {e}"))?
            .trim().to_string();
        if !public_openssh.is_empty() {
            return Ok(LocalSshKey {
                public_openssh,
                private_path: priv_path.to_string_lossy().to_string(),
            });
        }
    }

    // Mint a new key.
    let _ = std::fs::remove_file(&priv_path);
    let _ = std::fs::remove_file(&pub_path_buf);

    let status = tokio::process::Command::new("ssh-keygen")
        .arg("-t").arg("ed25519")
        .arg("-f").arg(&priv_path)
        .arg("-N").arg("")
        .arg("-C").arg("clawcage-remote")
        .arg("-q")
        .status().await
        .map_err(|e| format!("spawn ssh-keygen: {e}"))?;
    if !status.success() {
        return Err(format!("ssh-keygen exited {status}"));
    }

    let public_openssh = std::fs::read_to_string(&pub_path_buf)
        .map_err(|e| format!("read pub key: {e}"))?
        .trim().to_string();

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&priv_path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("chmod private key: {e}"))?;
    }

    Ok(LocalSshKey {
        public_openssh,
        private_path: priv_path.to_string_lossy().to_string(),
    })
}

fn shell_escape(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '/' | ':'))
        .collect()
}

// ── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_mode_serializes_compactly() {
        let json = serde_json::to_string(&ConnectionMode::Local).unwrap();
        assert_eq!(json, r#"{"type":"local"}"#);
    }

    #[test]
    fn remote_mode_round_trips() {
        let info = RemoteVenvInfo {
            session_id: "s".into(), vps_ip: "1.2.3.4".into(),
            ssh_fingerprint: "SHA256:x".into(), ssh_key_path: "/tmp/k".into(),
            detached_at: "2026-04-16T10:00:00Z".into(),
            session_key_b64: String::new(), snapshot_path: String::new(),
        };
        let mode = ConnectionMode::Remote(info);
        let json = serde_json::to_string(&mode).unwrap();
        let parsed: ConnectionMode = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, mode);
    }

    #[test]
    fn reattaching_preserves_info() {
        let info = RemoteVenvInfo {
            session_id: "s".into(), vps_ip: "1.1.1.1".into(),
            ssh_fingerprint: "SHA256:y".into(), ssh_key_path: "/k".into(),
            detached_at: "2026-04-16T00:00:00Z".into(),
            session_key_b64: String::new(), snapshot_path: String::new(),
        };
        let mode = ConnectionMode::Reattaching(info.clone());
        let json = serde_json::to_string(&mode).unwrap();
        let parsed: ConnectionMode = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, mode);
        match parsed {
            ConnectionMode::Reattaching(i) => assert_eq!(i.session_id, "s"),
            _ => panic!("expected Reattaching"),
        }
    }

    #[test]
    fn legacy_remote_json_without_new_fields() {
        let json = r#"{"type":"remote","session_id":"s","vps_ip":"1.1.1.1","ssh_fingerprint":"SHA256:x","ssh_key_path":"/k","detached_at":"2026-04-16T10:00:00Z"}"#;
        let mode: ConnectionMode = serde_json::from_str(json).unwrap();
        match mode {
            ConnectionMode::Remote(i) => {
                assert_eq!(i.session_key_b64, "");
                assert_eq!(i.snapshot_path, "");
            }
            _ => panic!("expected Remote"),
        }
    }

    #[test]
    fn shell_escape_strips_dangerous_chars() {
        assert_eq!(shell_escape("foo;bar"), "foobar");
        assert_eq!(shell_escape("a$(b)c"), "abc");
        assert_eq!(shell_escape("/tmp/key.pem"), "/tmp/key.pem");
    }

    #[test]
    fn shell_escape_preserves_safe_chars() {
        let s = "abc-XYZ_123./:";
        assert_eq!(shell_escape(s), s);
    }
}
