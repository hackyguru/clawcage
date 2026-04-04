//! Clone, export, and import operations for venvs.
//!
//! Export creates a `.clawcage` archive (zstd-compressed tar) containing the
//! scratch disk + config files. Import extracts one and creates a new venv.
//! Clone duplicates a venv using APFS copy-on-write.

use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, State};
use tracing::info;

use crate::state::AppState;
use crate::venvs::{self, VenvInfo, VenvInfoResponse};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotManifest {
    pub version: u32,
    pub name: String,
    pub template: String,
    pub ephemeral: bool,
    pub created_at: String,
    pub snapshot_at: String,
    pub scratch_disk_logical_size_gb: u32,
    pub disk_used_kb: u64,
    pub icon: Option<String>,
    pub clawcage_version: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SnapshotProgress {
    pub operation: String,
    pub venv_id: String,
    pub phase: String,
    pub bytes_processed: u64,
    pub total_bytes: u64,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn venv_data_dir(venv_id: &str) -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    Ok(PathBuf::from(home).join(".clawcage").join("venvs").join(venv_id))
}

fn ensure_stopped(state: &AppState, venv_id: &str) -> Result<(), String> {
    if state.running_venvs.lock().unwrap().contains_key(venv_id) {
        return Err("stop the environment before this operation".to_string());
    }
    Ok(())
}

fn get_venv_info(venv_id: &str) -> Result<VenvInfo, String> {
    let venvs = venvs::load_venvs()?;
    venvs.into_iter().find(|v| v.id == venv_id)
        .ok_or_else(|| format!("environment not found: {venv_id}"))
}

fn read_disk_used_kb(venv_dir: &Path) -> u64 {
    std::fs::read_to_string(venv_dir.join("disk_used_kb"))
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0)
}

/// Re-create a file as sparse using dd + selective block writes.
fn sparsify_file(src: &Path, dst: &Path) -> std::io::Result<()> {
    let mut reader = std::fs::File::open(src)?;
    let file_size = reader.metadata()?.len();

    let status = std::process::Command::new("dd")
        .args(["if=/dev/null", &format!("of={}", dst.to_string_lossy()), "bs=1", "count=0", &format!("seek={file_size}")])
        .stderr(std::process::Stdio::null())
        .status()?;
    if !status.success() {
        std::fs::copy(src, dst)?;
        return Ok(());
    }

    let mut writer = std::fs::OpenOptions::new().write(true).open(dst)?;
    const BLOCK_SIZE: usize = 1024 * 1024;
    let mut buf = vec![0u8; BLOCK_SIZE];
    let mut offset: u64 = 0;

    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 { break; }
        if !buf[..n].iter().all(|&b| b == 0) {
            writer.seek(SeekFrom::Start(offset))?;
            writer.write_all(&buf[..n])?;
        }
        offset += n as u64;
    }

    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(dst, std::fs::Permissions::from_mode(0o600))?;
    Ok(())
}

/// Copy a file using macOS APFS copy-on-write (`cp -c`).
fn cow_copy(src: &Path, dst: &Path) -> std::io::Result<()> {
    let status = std::process::Command::new("cp")
        .args(["-c", &src.to_string_lossy(), &dst.to_string_lossy()])
        .status()?;
    if status.success() {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dst, std::fs::Permissions::from_mode(0o600))?;
        return Ok(());
    }
    std::fs::copy(src, dst)?;
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(dst, std::fs::Permissions::from_mode(0o600))?;
    Ok(())
}

/// Create a tar.zst archive from a venv data directory.
/// Public wrapper for cloud.rs to use.
pub fn create_archive_pub(
    venv_dir: &Path,
    manifest: &SnapshotManifest,
    output: &Path,
    emit_progress: &dyn Fn(u64, u64),
) -> Result<(), String> {
    create_archive(venv_dir, manifest, output, emit_progress)
}

fn create_archive(
    venv_dir: &Path,
    manifest: &SnapshotManifest,
    output: &Path,
    emit_progress: &dyn Fn(u64, u64),
) -> Result<(), String> {
    let tmp_path = output.with_extension("tar.zst.tmp");
    let file = std::fs::File::create(&tmp_path)
        .map_err(|e| format!("create archive: {e}"))?;
    let encoder = zstd::Encoder::new(file, 3)
        .map_err(|e| format!("zstd encoder: {e}"))?;
    let mut tar = tar::Builder::new(encoder);

    // Add manifest.json
    let manifest_json = serde_json::to_vec_pretty(manifest)
        .map_err(|e| format!("serialize manifest: {e}"))?;
    let mut header = tar::Header::new_gnu();
    header.set_size(manifest_json.len() as u64);
    header.set_mode(0o644);
    header.set_cksum();
    tar.append_data(&mut header, "manifest.json", &manifest_json[..])
        .map_err(|e| format!("add manifest: {e}"))?;

    // Add scratch.img with progress
    let scratch = venv_dir.join("scratch.img");
    if scratch.exists() {
        let meta = std::fs::metadata(&scratch).map_err(|e| format!("scratch metadata: {e}"))?;
        let total = meta.len();
        let mut header = tar::Header::new_gnu();
        header.set_size(total);
        header.set_mode(0o600);
        header.set_cksum();
        let mut reader = std::fs::File::open(&scratch)
            .map_err(|e| format!("open scratch: {e}"))?;
        let progress_reader = ProgressReader { inner: &mut reader, read_so_far: 0, total, callback: emit_progress };
        tar.append_data(&mut header, "scratch.img", progress_reader)
            .map_err(|e| format!("add scratch.img: {e}"))?;
    }

    // Add config files
    for name in &["settings.toml", "setup.sh", "setup.env", "icon.png", "disk_used_kb"] {
        let path = venv_dir.join(name);
        if path.exists() {
            tar.append_path_with_name(&path, name)
                .map_err(|e| format!("add {name}: {e}"))?;
        }
    }

    let encoder = tar.into_inner().map_err(|e| format!("finalize tar: {e}"))?;
    encoder.finish().map_err(|e| format!("finalize zstd: {e}"))?;
    std::fs::rename(&tmp_path, output).map_err(|e| format!("rename archive: {e}"))?;
    Ok(())
}

/// Extract a tar.zst archive into a venv data directory (sparse-aware).
fn extract_archive(
    archive_path: &Path,
    dest_dir: &Path,
    emit_progress: &dyn Fn(u64, u64),
) -> Result<SnapshotManifest, String> {
    emit_progress(0, 1);

    let file = std::fs::File::open(archive_path)
        .map_err(|e| format!("open archive: {e}"))?;
    let decoder = zstd::Decoder::new(file)
        .map_err(|e| format!("zstd decoder: {e}"))?;
    let mut tar = tar::Archive::new(decoder);

    std::fs::create_dir_all(dest_dir).map_err(|e| format!("create dir: {e}"))?;

    let mut manifest: Option<SnapshotManifest> = None;
    let mut bytes_written: u64 = 0;
    let mut total_estimate: u64 = 0;

    for entry in tar.entries().map_err(|e| format!("tar entries: {e}"))? {
        let mut entry = entry.map_err(|e| format!("tar entry: {e}"))?;
        let path = entry.path().map_err(|e| format!("entry path: {e}"))?.into_owned();
        let name = path.to_string_lossy().to_string();

        if name == "manifest.json" {
            let mut data = Vec::new();
            entry.read_to_end(&mut data).map_err(|e| format!("read manifest: {e}"))?;
            let m: SnapshotManifest = serde_json::from_slice(&data)
                .map_err(|e| format!("parse manifest: {e}"))?;
            total_estimate = m.scratch_disk_logical_size_gb as u64 * 1024 * 1024 * 1024;
            manifest = Some(m);
        } else {
            let dest = dest_dir.join(&name);
            let entry_size = entry.size();

            // Large files: extract to temp then sparsify.
            if entry_size > 10 * 1024 * 1024 {
                let tmp = dest.with_extension("img.tmp");
                {
                    let mut out = std::fs::File::create(&tmp)
                        .map_err(|e| format!("create tmp {name}: {e}"))?;
                    let mut buf = vec![0u8; 4 * 1024 * 1024];
                    loop {
                        let n = entry.read(&mut buf).map_err(|e| format!("read {name}: {e}"))?;
                        if n == 0 { break; }
                        out.write_all(&buf[..n]).map_err(|e| format!("write tmp {name}: {e}"))?;
                        bytes_written += n as u64;
                        if total_estimate > 0 {
                            emit_progress(bytes_written, total_estimate);
                        }
                    }
                }
                sparsify_file(&tmp, &dest)
                    .map_err(|e| format!("sparsify {name}: {e}"))?;
                let _ = std::fs::remove_file(&tmp);
            } else {
                let mut out = std::fs::File::create(&dest)
                    .map_err(|e| format!("create {name}: {e}"))?;
                std::io::copy(&mut entry, &mut out)
                    .map_err(|e| format!("extract {name}: {e}"))?;
                bytes_written += entry_size;
            }
        }
    }

    manifest.ok_or_else(|| "archive missing manifest.json".to_string())
}

struct ProgressReader<'a> {
    inner: &'a mut std::fs::File,
    read_so_far: u64,
    total: u64,
    callback: &'a dyn Fn(u64, u64),
}

impl<'a> Read for ProgressReader<'a> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.read_so_far += n as u64;
        if self.read_so_far % (4 * 1024 * 1024) < buf.len() as u64 {
            (self.callback)(self.read_so_far, self.total);
        }
        Ok(n)
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn clone_venv(
    source_venv_id: String,
    new_name: String,
    app_handle: tauri::AppHandle,
) -> Result<VenvInfoResponse, String> {
    {
        let state: State<'_, AppState> = app_handle.state();
        ensure_stopped(&state, &source_venv_id)?;
    }

    let h = app_handle.clone();
    let svid = source_venv_id.clone();

    tokio::task::spawn_blocking(move || {
        let source = get_venv_info(&svid)?;
        let source_dir = venv_data_dir(&svid)?;

        let new_id = format!("venv-{:x}", std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis());
        let new_dir = venv_data_dir(&new_id)?;
        std::fs::create_dir_all(&new_dir).map_err(|e| format!("create dir: {e}"))?;

        info!(source = %svid, new = %new_id, "cloning venv");

        let _ = h.emit("snapshot-progress", SnapshotProgress {
            operation: "clone".into(), venv_id: new_id.clone(), phase: "copying".into(),
            bytes_processed: 0, total_bytes: 1,
        });

        // CoW copy scratch.img
        let scratch_src = source_dir.join("scratch.img");
        if scratch_src.exists() {
            cow_copy(&scratch_src, &new_dir.join("scratch.img"))
                .map_err(|e| format!("copy scratch: {e}"))?;
        }

        // Copy config files
        for name in &["settings.toml", "setup.sh", "setup.env", "icon.png", "disk_used_kb"] {
            let src = source_dir.join(name);
            if src.exists() { let _ = std::fs::copy(&src, new_dir.join(name)); }
        }

        let new_venv = VenvInfo {
            id: new_id.clone(),
            name: new_name,
            status: "stopped".to_string(),
            created_at: clawcage_core::session::now_iso(),
            last_used: None,
            ephemeral: source.ephemeral,
            template: source.template,
            icon: source.icon,
        };

        let mut venvs = venvs::load_venvs()?;
        venvs.push(new_venv.clone());
        venvs::save_venvs(&venvs)?;

        let disk = crate::venvs::venv_disk_used(&new_id);
        let allocated = crate::venvs::venv_disk_allocated(&new_id);
        info!(id = %new_id, "venv cloned");

        let _ = h.emit("snapshot-progress", SnapshotProgress {
            operation: "clone".into(), venv_id: new_id.clone(), phase: "done".into(),
            bytes_processed: 0, total_bytes: 0,
        });

        Ok(VenvInfoResponse { info: new_venv, disk_used_bytes: disk, disk_allocated_bytes: allocated, icon_url: None })
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))?
}

#[tauri::command]
pub async fn export_venv(
    venv_id: String,
    dest_path: String,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    {
        let state: State<'_, AppState> = app_handle.state();
        ensure_stopped(&state, &venv_id)?;
    }

    let h = app_handle.clone();
    let vid = venv_id.clone();

    tokio::task::spawn_blocking(move || {
        let venv = get_venv_info(&vid)?;
        let venv_dir = venv_data_dir(&vid)?;
        let disk_used = read_disk_used_kb(&venv_dir);

        let manifest = SnapshotManifest {
            version: 1,
            name: venv.name,
            template: venv.template,
            ephemeral: venv.ephemeral,
            created_at: venv.created_at,
            snapshot_at: clawcage_core::session::now_iso(),
            scratch_disk_logical_size_gb: 16,
            disk_used_kb: disk_used,
            icon: venv.icon,
            clawcage_version: env!("CARGO_PKG_VERSION").to_string(),
        };

        info!(venv_id = %vid, dest = %dest_path, "exporting venv");

        let h2 = h.clone();
        let vid2 = vid.clone();
        create_archive(&venv_dir, &manifest, Path::new(&dest_path), &|processed, total| {
            let _ = h2.emit("snapshot-progress", SnapshotProgress {
                operation: "export".into(), venv_id: vid2.clone(), phase: "compressing".into(),
                bytes_processed: processed, total_bytes: total,
            });
        })?;

        info!(venv_id = %vid, "export complete");
        let _ = h.emit("snapshot-progress", SnapshotProgress {
            operation: "export".into(), venv_id: vid.clone(), phase: "done".into(),
            bytes_processed: 0, total_bytes: 0,
        });
        Ok(())
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))?
}

#[tauri::command]
pub async fn import_venv(
    source_path: String,
    new_name: Option<String>,
    app_handle: tauri::AppHandle,
) -> Result<VenvInfoResponse, String> {
    let h = app_handle.clone();

    tokio::task::spawn_blocking(move || {
        let new_id = format!("venv-{:x}", std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis());
        let new_dir = venv_data_dir(&new_id)?;

        info!(path = %source_path, new_id = %new_id, "importing venv");

        let h2 = h.clone();
        let nid = new_id.clone();
        let manifest = extract_archive(Path::new(&source_path), &new_dir, &|processed, total| {
            let _ = h2.emit("snapshot-progress", SnapshotProgress {
                operation: "import".into(), venv_id: nid.clone(), phase: "decompressing".into(),
                bytes_processed: processed, total_bytes: total,
            });
        })?;

        let name = new_name.unwrap_or(manifest.name.clone());
        let new_venv = VenvInfo {
            id: new_id.clone(),
            name,
            status: "stopped".to_string(),
            created_at: clawcage_core::session::now_iso(),
            last_used: None,
            ephemeral: manifest.ephemeral,
            template: manifest.template,
            icon: manifest.icon,
        };

        let mut venvs = venvs::load_venvs()?;
        venvs.push(new_venv.clone());
        venvs::save_venvs(&venvs)?;

        info!(id = %new_id, "venv imported");
        let _ = h.emit("snapshot-progress", SnapshotProgress {
            operation: "import".into(), venv_id: new_id.clone(), phase: "done".into(),
            bytes_processed: 0, total_bytes: 0,
        });

        Ok(VenvInfoResponse {
            info: new_venv,
            disk_used_bytes: manifest.disk_used_kb * 1024,
            disk_allocated_bytes: manifest.scratch_disk_logical_size_gb as u64 * 1024 * 1024 * 1024,
            icon_url: None,
        })
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))?
}
