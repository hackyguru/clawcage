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
}

fn default_template() -> String {
    "blank".to_string()
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
pub async fn list_venvs() -> Result<Vec<VenvInfo>, String> {
    tokio::task::spawn_blocking(load_venvs)
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

#[tauri::command]
pub async fn delete_venv(id: String, app_handle: tauri::AppHandle) -> Result<(), String> {
    // If this venv is currently running, stop it on the main thread first.
    {
        let app_state = app_handle.state::<AppState>();
        let active = app_state.active_venv_id.lock().unwrap().clone();
        if active.as_deref() == Some(&id) {
            let h = app_handle.clone();
            app_handle.run_on_main_thread(move || {
                if let Err(e) = crate::stop_active_vm(&h) {
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
    // If this venv is already the active one, just return success (no reboot).
    {
        let app_state = app_handle.state::<AppState>();
        let active = app_state.active_venv_id.lock().unwrap().clone();
        if active.as_deref() == Some(&id) {
            return Ok(());
        }
    }

    // Mark any previously-running venv as stopped in metadata.
    {
        let app_state = app_handle.state::<AppState>();
        let prev = app_state.active_venv_id.lock().unwrap().clone();
        if let Some(prev_id) = prev {
            let _ = tokio::task::spawn_blocking(move || update_venv_status(&prev_id, "stopped")).await;
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
    // Verify this venv is actually active.
    {
        let app_state = app_handle.state::<AppState>();
        let active = app_state.active_venv_id.lock().unwrap().clone();
        if active.as_deref() != Some(&id) {
            return Err("this venv is not running".to_string());
        }
    }

    // Stop the VM on the main thread.
    let h = app_handle.clone();
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<(), String>>();

    app_handle.run_on_main_thread(move || {
        let result = crate::stop_active_vm(&h);
        let _ = tx.send(result);
    }).map_err(|e| format!("main thread dispatch: {e}"))?;

    rx.await.map_err(|_| "stop channel closed".to_string())??;

    // Update metadata.
    tokio::task::spawn_blocking(move || update_venv_status(&id, "stopped"))
        .await
        .map_err(|e| format!("spawn_blocking: {e}"))?
}
