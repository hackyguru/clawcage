//! Virtual environment management.
//!
//! Stores venv metadata in `~/.clawcage/venvs.json`. Each venv is a named
//! reference to a VM session that can be started/stopped independently.
//! `start_venv` boots a real VM; `stop_venv` shuts it down.
//!
//! **Threading**: VM create/start/stop must run on the main thread (Apple
//! Virtualization.framework requirement). We use `run_on_main_thread` to
//! dispatch these calls from async Tauri command handlers.

use std::path::PathBuf;

use clawcage_core::session;
use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::state::AppState;

/// Venv metadata persisted to disk.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VenvInfo {
    pub id: String,
    pub name: String,
    pub status: String,
    pub created_at: String,
    pub last_used: Option<String>,
    /// If true, scratch disk is wiped on every boot (no file persistence).
    #[serde(default)]
    pub ephemeral: bool,
    /// Template ID used when this venv was created (e.g. "blank").
    #[serde(default = "default_template")]
    pub template: String,
    /// Custom icon path (relative to venv data dir, e.g. "icon.png").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
}

fn default_template() -> String {
    "blank".to_string()
}

/// Venv info enriched with computed fields for the frontend.
#[derive(Debug, Clone, Serialize)]
pub struct VenvInfoResponse {
    #[serde(flatten)]
    pub info: VenvInfo,
    /// Total disk usage of the venv directory in bytes (scratch.img + session DBs + config).
    pub disk_usage_bytes: u64,
    /// Base64 data URL for the custom icon (if set). Read from disk on each list call.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon_url: Option<String>,
}

/// Get the guest-reported disk usage for a venv (saved on stop).
/// Returns bytes. Falls back to 0 if no data available yet.
fn venv_disk_usage(venv_id: &str) -> u64 {
    let home = match std::env::var("HOME") {
        Ok(h) => h,
        Err(_) => return 0,
    };
    let path = std::path::PathBuf::from(home)
        .join(".clawcage")
        .join("venvs")
        .join(venv_id)
        .join("disk_used_kb");
    match std::fs::read_to_string(&path) {
        Ok(s) => s.trim().parse::<u64>().unwrap_or(0) * 1024,
        Err(_) => 0,
    }
}

/// Returns the path to `~/.clawcage/venvs.json`.
fn venvs_path() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    let dir = PathBuf::from(home).join(".clawcage");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create dir: {e}"))?;
    Ok(dir.join("venvs.json"))
}

/// Load all venvs from disk.
pub(crate) fn load_venvs() -> Result<Vec<VenvInfo>, String> {
    let path = venvs_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let data = std::fs::read_to_string(&path).map_err(|e| format!("read venvs: {e}"))?;
    serde_json::from_str(&data).map_err(|e| format!("parse venvs: {e}"))
}

/// Save all venvs to disk.
pub(crate) fn save_venvs(venvs: &[VenvInfo]) -> Result<(), String> {
    let path = venvs_path()?;
    let data = serde_json::to_string_pretty(venvs).map_err(|e| format!("serialize venvs: {e}"))?;
    std::fs::write(&path, data).map_err(|e| format!("write venvs: {e}"))
}

/// Update the status of a venv by ID.
fn update_venv_status(id: &str, status: &str) -> Result<(), String> {
    let mut venvs = load_venvs()?;
    let venv = venvs.iter_mut().find(|v| v.id == id)
        .ok_or_else(|| format!("venv not found: {id}"))?;
    venv.status = status.to_string();
    if status == "running" || status == "booting" {
        venv.last_used = Some(session::now_iso());
    }
    save_venvs(&venvs)
}

/// Generate a short unique ID.
fn gen_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("venv-{ts:x}")
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn list_venvs(app_handle: tauri::AppHandle) -> Result<Vec<VenvInfoResponse>, String> {
    // Snapshot which venvs are actually running right now.
    let running: std::collections::HashSet<String> = {
        let app_state: tauri::State<'_, AppState> = app_handle.state();
        let guard = app_state.running_venvs.lock().unwrap();
        guard.keys().cloned().collect()
    };

    tokio::task::spawn_blocking(move || {
        let venvs = load_venvs()?;
        Ok(venvs.into_iter().map(|v| {
            let disk = venv_disk_usage(&v.id);
            // Override persisted status with live running state.
            let mut info = v;
            if running.contains(&info.id) {
                info.status = "running".to_string();
            } else if info.status == "running" || info.status == "booting" {
                // JSON says running but it's not — stale status.
                info.status = "stopped".to_string();
            }
            // Read custom icon as data URL if present.
            let icon_url = info.icon.as_ref().and_then(|filename| {
                let home = std::env::var("HOME").ok()?;
                let path = std::path::PathBuf::from(home)
                    .join(".clawcage")
                    .join("venvs")
                    .join(&info.id)
                    .join(filename);
                let bytes = std::fs::read(&path).ok()?;
                // Detect MIME type from file magic bytes.
                let mime = if bytes.starts_with(b"\x89PNG") {
                    "image/png"
                } else if bytes.starts_with(b"\xff\xd8\xff") {
                    "image/jpeg"
                } else if bytes.starts_with(b"GIF8") {
                    "image/gif"
                } else if bytes.starts_with(b"RIFF") && bytes.len() > 12 && &bytes[8..12] == b"WEBP" {
                    "image/webp"
                } else {
                    "image/png" // fallback
                };
                use std::fmt::Write;
                let mut b64 = String::new();
                for chunk in bytes.chunks(3) {
                    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
                    match chunk.len() {
                        3 => {
                            let _ = write!(b64, "{}{}{}{}",
                                TABLE[(chunk[0] >> 2) as usize] as char,
                                TABLE[((chunk[0] & 0x03) << 4 | chunk[1] >> 4) as usize] as char,
                                TABLE[((chunk[1] & 0x0f) << 2 | chunk[2] >> 6) as usize] as char,
                                TABLE[(chunk[2] & 0x3f) as usize] as char);
                        }
                        2 => {
                            let _ = write!(b64, "{}{}{}=",
                                TABLE[(chunk[0] >> 2) as usize] as char,
                                TABLE[((chunk[0] & 0x03) << 4 | chunk[1] >> 4) as usize] as char,
                                TABLE[((chunk[1] & 0x0f) << 2) as usize] as char);
                        }
                        1 => {
                            let _ = write!(b64, "{}{}==",
                                TABLE[(chunk[0] >> 2) as usize] as char,
                                TABLE[((chunk[0] & 0x03) << 4) as usize] as char);
                        }
                        _ => {}
                    }
                }
                Some(format!("data:{mime};base64,{b64}"))
            });
            VenvInfoResponse { info, disk_usage_bytes: disk, icon_url }
        }).collect())
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))?
}

#[tauri::command]
pub async fn create_venv(name: String, ephemeral: bool, template: Option<String>) -> Result<VenvInfo, String> {
    tokio::task::spawn_blocking(move || {
        let mut venvs = load_venvs()?;
        let venv = VenvInfo {
            id: gen_id(),
            name,
            status: "stopped".to_string(),
            created_at: session::now_iso(),
            last_used: None,
            ephemeral,
            template: template.unwrap_or_else(default_template),
            icon: None,
        };
        venvs.push(venv.clone());
        save_venvs(&venvs)?;
        Ok(venv)
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))?
}

/// Save a file into a venv's host-side data directory (~/.clawcage/venvs/<id>/).
#[tauri::command]
pub async fn save_venv_file(id: String, filename: String, content: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
        let dir = std::path::PathBuf::from(home)
            .join(".clawcage")
            .join("venvs")
            .join(&id);
        std::fs::create_dir_all(&dir).map_err(|e| format!("create dir: {e}"))?;
        std::fs::write(dir.join(filename), content).map_err(|e| format!("write file: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))?
}

/// Rename a venv.
#[tauri::command]
pub async fn rename_venv(id: String, name: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let mut venvs = load_venvs()?;
        let venv = venvs.iter_mut().find(|v| v.id == id)
            .ok_or_else(|| format!("venv not found: {id}"))?;
        venv.name = name;
        save_venvs(&venvs)
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))?
}

/// Set a custom icon for a venv (base64-encoded PNG saved to disk).
#[tauri::command]
pub async fn set_venv_icon(id: String, icon_data: Option<String>) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let mut venvs = load_venvs()?;
        let venv = venvs.iter_mut().find(|v| v.id == id)
            .ok_or_else(|| format!("venv not found: {id}"))?;

        if let Some(data) = icon_data {
            // Decode base64 and save as icon.png in venv dir.
            let bytes = base64_decode(&data)?;
            let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
            let dir = std::path::PathBuf::from(home)
                .join(".clawcage")
                .join("venvs")
                .join(&id);
            std::fs::create_dir_all(&dir).map_err(|e| format!("create dir: {e}"))?;
            std::fs::write(dir.join("icon.png"), bytes).map_err(|e| format!("write icon: {e}"))?;
            venv.icon = Some("icon.png".to_string());
        } else {
            // Remove custom icon.
            venv.icon = None;
            let home = std::env::var("HOME").unwrap_or_default();
            let icon_path = std::path::PathBuf::from(home)
                .join(".clawcage")
                .join("venvs")
                .join(&id)
                .join("icon.png");
            let _ = std::fs::remove_file(icon_path);
        }

        save_venvs(&venvs)
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))?
}

/// Simple base64 decoder (no padding required).
fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    // Strip data URL prefix if present (e.g. "data:image/png;base64,...")
    let b64 = input.strip_prefix("data:")
        .and_then(|s| s.split_once(','))
        .map(|(_, data)| data)
        .unwrap_or(input);

    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::new();
    let mut buf: u32 = 0;
    let mut bits = 0;
    for &ch in b64.as_bytes() {
        if ch == b'=' || ch == b'\n' || ch == b'\r' || ch == b' ' { continue; }
        let val = TABLE.iter().position(|&c| c == ch)
            .ok_or_else(|| format!("invalid base64 char: {}", ch as char))? as u32;
        buf = (buf << 6) | val;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
            buf &= (1 << bits) - 1;
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn delete_venv(id: String, app_handle: tauri::AppHandle) -> Result<(), String> {
    // If this venv is currently running, stop it on the main thread first.
    {
        let app_state = app_handle.state::<AppState>();
        let is_running = app_state.running_venvs.lock().unwrap().contains_key(&id);
        if is_running {
            let h = app_handle.clone();
            let vid = id.clone();
            app_handle.run_on_main_thread(move || {
                if let Err(e) = crate::stop_vm(&h, &vid) {
                    tracing::error!("stop VM for delete failed: {e}");
                }
            }).map_err(|e| format!("main thread dispatch: {e}"))?;
        }
    }

    tokio::task::spawn_blocking(move || {
        let mut venvs = load_venvs()?;
        let before = venvs.len();
        venvs.retain(|v| v.id != id);
        if venvs.len() == before {
            return Err(format!("venv not found: {id}"));
        }
        save_venvs(&venvs)?;

        // Clean up per-venv data directory (scratch disk, etc.).
        if let Ok(home) = std::env::var("HOME") {
            let venv_dir = std::path::PathBuf::from(home)
                .join(".clawcage").join("venvs").join(&id);
            if venv_dir.exists() {
                let _ = std::fs::remove_dir_all(&venv_dir);
                tracing::info!("deleted venv data directory: {}", venv_dir.display());
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))?
}

#[tauri::command]
pub async fn start_venv(id: String, app_handle: tauri::AppHandle) -> Result<(), String> {
    // If this venv is already running, just return success (no reboot).
    {
        let app_state = app_handle.state::<AppState>();
        if app_state.running_venvs.lock().unwrap().contains_key(&id) {
            return Ok(());
        }
    }

    // Mark as booting in metadata.
    tokio::task::spawn_blocking({
        let id = id.clone();
        move || update_venv_status(&id, "booting")
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))??;

    // Boot a real VM on the main thread (VZ framework requirement).
    let h = app_handle.clone();
    let venv_id = id.clone();
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<(), String>>();

    app_handle.run_on_main_thread(move || {
        let result = crate::boot_venv(&h, &venv_id);
        let _ = tx.send(result);
    }).map_err(|e| format!("main thread dispatch: {e}"))?;

    match rx.await {
        Ok(Ok(())) => {
            // Mark as running.
            let id2 = id.clone();
            tokio::task::spawn_blocking(move || update_venv_status(&id2, "running"))
                .await
                .map_err(|e| format!("spawn_blocking: {e}"))??;
            Ok(())
        }
        Ok(Err(e)) => {
            // Mark as error.
            let id2 = id.clone();
            let _ = tokio::task::spawn_blocking(move || update_venv_status(&id2, "error")).await;
            Err(e)
        }
        Err(_) => {
            let id2 = id.clone();
            let _ = tokio::task::spawn_blocking(move || update_venv_status(&id2, "error")).await;
            Err("boot_venv channel closed".to_string())
        }
    }
}

#[tauri::command]
pub async fn stop_venv(id: String, app_handle: tauri::AppHandle) -> Result<(), String> {
    // Verify this venv is actually running and snapshot disk usage before stopping.
    let disk_used_kb = {
        let app_state = app_handle.state::<AppState>();
        let session_id = app_state.running_venvs.lock().unwrap().get(&id).cloned();
        if session_id.is_none() {
            return Err("this venv is not running".to_string());
        }
        // Read last known guest disk usage from system metrics.
        session_id.and_then(|sid| {
            let vms = app_state.vms.lock().unwrap();
            vms.get(&sid).map(|i| {
                let m = i.sys_metrics.latest.read().unwrap();
                m.disk_used_kb
            })
        }).unwrap_or(0)
    };

    // Stop the VM on the main thread.
    let h = app_handle.clone();
    let vid = id.clone();
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<(), String>>();

    app_handle.run_on_main_thread(move || {
        let result = crate::stop_vm(&h, &vid);
        let _ = tx.send(result);
    }).map_err(|e| format!("main thread dispatch: {e}"))?;

    rx.await.map_err(|_| "stop channel closed".to_string())??;

    // Save last known disk usage and update status.
    let id_clone = id.clone();
    tokio::task::spawn_blocking(move || {
        // Persist guest disk usage for display when stopped.
        if disk_used_kb > 0 {
            if let Some(dir) = crate::venv_scratch_dir(&id_clone) {
                let _ = std::fs::write(dir.join("disk_used_kb"), disk_used_kb.to_string());
            }
        }
        update_venv_status(&id_clone, "stopped")
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))?
}
