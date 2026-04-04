//! Cloud integration: auth, sync, and subscription management.
//!
//! The desktop app stores a cloud auth token in `~/.clawcage/cloud.json`.
//! This token is obtained by signing in via the web dashboard and is used
//! to authenticate API calls for snapshot sync and subscription checks.
//!
//! **End-to-end encryption**: All uploads are encrypted client-side with
//! AES-256-GCM before leaving the machine. The encryption key is generated
//! once and stored locally — it never leaves the user's device. Not even
//! the cloud operator can read the uploaded data.

use std::path::PathBuf;
use serde::{Deserialize, Serialize};
use tracing::info;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CloudConfig {
    pub token: Option<String>,
    pub refresh_token: Option<String>,
    pub email: Option<String>,
    pub cloud_url: Option<String>,
    /// Base64-encoded 256-bit encryption key (generated on first sync).
    pub encryption_key: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CloudStatus {
    pub connected: bool,
    pub email: Option<String>,
    pub plan: String,
}

fn config_path() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    Ok(PathBuf::from(home).join(".clawcage").join("cloud.json"))
}

fn load_config() -> CloudConfig {
    let mut config: CloudConfig = config_path()
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();

    // Load sensitive tokens from Keychain (cloud.json only stores non-secret fields)
    if config.token.is_none() {
        config.token = keychain_get("access-token");
    }
    if config.refresh_token.is_none() {
        config.refresh_token = keychain_get("refresh-token");
    }
    config
}

fn save_config(config: &CloudConfig) -> Result<(), String> {
    // Save tokens to Keychain
    if let Some(ref t) = config.token {
        let _ = keychain_set("access-token", t);
    }
    if let Some(ref rt) = config.refresh_token {
        let _ = keychain_set("refresh-token", rt);
    }

    // Write cloud.json without sensitive tokens
    let safe = CloudConfig {
        token: None,
        refresh_token: None,
        email: config.email.clone(),
        cloud_url: config.cloud_url.clone(),
        encryption_key: config.encryption_key.clone(),
    };
    let path = config_path()?;
    let data = serde_json::to_string_pretty(&safe).map_err(|e| format!("serialize: {e}"))?;
    std::fs::write(&path, data).map_err(|e| format!("write cloud config: {e}"))
}

// ---------------------------------------------------------------------------
// Token refresh
// ---------------------------------------------------------------------------

/// Check if a JWT is expired by decoding the payload (no network call).
fn is_token_expired(token: &str) -> bool {
    // JWT format: header.payload.signature — decode the payload
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 {
        return true;
    }
    // JWT uses base64url (no padding)
    let payload = match base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(parts[1]) {
        Ok(b) => b,
        Err(_) => return true,
    };
    let json: serde_json::Value = match serde_json::from_slice(&payload) {
        Ok(v) => v,
        Err(_) => return true,
    };
    let exp = json["exp"].as_i64().unwrap_or(0);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    // Refresh 60 seconds before actual expiry to avoid edge cases
    now >= exp - 60
}

/// Get a valid access token, refreshing via the cloud API if expired.
async fn get_valid_token(config: &mut CloudConfig) -> Result<String, String> {
    let token = config.token.as_deref().ok_or("not connected to cloud")?;

    if !is_token_expired(token) {
        return Ok(token.to_string());
    }

    // Token expired — refresh it
    let cloud_url = config.cloud_url.as_deref().unwrap_or("http://localhost:3000");
    let refresh_token = config.refresh_token.as_deref()
        .ok_or("session expired — please sign in again")?;

    info!("access token expired, refreshing");

    let refresh_resp = reqwest::Client::new()
        .post(format!("{cloud_url}/api/token"))
        .json(&serde_json::json!({ "refresh_token": refresh_token }))
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("refresh request failed: {e}"))?;

    if !refresh_resp.status().is_success() {
        return Err("session expired — please sign in again".to_string());
    }

    let body: serde_json::Value = refresh_resp.json().await
        .map_err(|e| format!("parse refresh response: {e}"))?;

    let new_token = body["access_token"].as_str()
        .ok_or("missing access_token in refresh response")?;
    let new_refresh = body["refresh_token"].as_str();

    config.token = Some(new_token.to_string());
    if let Some(rt) = new_refresh {
        config.refresh_token = Some(rt.to_string());
    }
    save_config(config)?;
    info!("token refreshed successfully");

    Ok(new_token.to_string())
}

// ---------------------------------------------------------------------------
// Encryption (AES-256-GCM, client-side)
// ---------------------------------------------------------------------------

use aes_gcm::{Aes256Gcm, KeyInit, aead::Aead};
use base64::{Engine as _, engine::general_purpose::STANDARD as B64};

const KEYCHAIN_SERVICE: &str = "com.clawcage.cloud";

/// Save a value to macOS Keychain under the given account name.
fn keychain_set(account: &str, value: &str) -> Result<(), String> {
    let _ = std::process::Command::new("security")
        .args(["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account])
        .output();

    let output = std::process::Command::new("security")
        .args(["add-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w", value, "-U"])
        .output()
        .map_err(|e| format!("keychain write: {e}"))?;

    if !output.status.success() {
        return Err(format!("keychain save failed: {}", String::from_utf8_lossy(&output.stderr)));
    }
    Ok(())
}

/// Read a value from macOS Keychain by account name.
fn keychain_get(account: &str) -> Option<String> {
    let output = std::process::Command::new("security")
        .args(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Delete a value from macOS Keychain.
fn keychain_delete(account: &str) {
    let _ = std::process::Command::new("security")
        .args(["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account])
        .output();
}

/// Get or generate the encryption key, persisting it in cloud.json + Keychain.
fn get_or_create_key(config: &mut CloudConfig) -> Result<[u8; 32], String> {
    // 1. Try cloud.json first
    if let Some(ref b64) = config.encryption_key {
        let bytes = B64.decode(b64).map_err(|e| format!("decode key: {e}"))?;
        if bytes.len() == 32 {
            let mut key = [0u8; 32];
            key.copy_from_slice(&bytes);
            return Ok(key);
        }
    }

    // 2. Try recovering from Keychain (e.g. after reinstall or cloud.json lost)
    if let Some(b64) = keychain_get("encryption-key") {
        if let Ok(bytes) = B64.decode(&b64) {
            if bytes.len() == 32 {
                info!("recovered encryption key from Keychain");
                config.encryption_key = Some(b64);
                save_config(config)?;
                let mut key = [0u8; 32];
                key.copy_from_slice(&bytes);
                return Ok(key);
            }
        }
    }

    // 3. Generate new key and save to both locations
    use rand::RngCore;
    let mut key = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut key);
    let b64 = B64.encode(key);
    config.encryption_key = Some(b64.clone());
    save_config(config)?;
    let _ = keychain_set("encryption-key", &b64); // best-effort Keychain backup
    info!("generated new cloud encryption key (backed up to Keychain)");
    Ok(key)
}

/// Encrypt bytes with AES-256-GCM. Returns: [12-byte nonce || ciphertext+tag].
fn encrypt_bytes(plaintext: &[u8], key: &[u8; 32]) -> Result<Vec<u8>, String> {
    use aes_gcm::aead::OsRng;
    use aes_gcm::AeadCore;

    let cipher = Aes256Gcm::new(key.into());
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let ciphertext = cipher.encrypt(&nonce, plaintext)
        .map_err(|e| format!("encrypt: {e}"))?;

    let mut out = Vec::with_capacity(12 + ciphertext.len());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

/// Decrypt bytes produced by `encrypt_bytes`.
#[allow(dead_code)]
fn decrypt_bytes(data: &[u8], key: &[u8; 32]) -> Result<Vec<u8>, String> {
    if data.len() < 12 {
        return Err("encrypted data too short".into());
    }
    let (nonce_bytes, ciphertext) = data.split_at(12);
    let nonce = aes_gcm::Nonce::from_slice(nonce_bytes);
    let cipher = Aes256Gcm::new(key.into());
    cipher.decrypt(nonce, ciphertext)
        .map_err(|e| format!("decrypt: {e}"))
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Connect to Clawcage Cloud by saving the auth token.
#[tauri::command]
pub async fn cloud_connect(token: String, email: Option<String>, cloud_url: Option<String>) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let mut existing = load_config();
        existing.token = Some(token);
        existing.email = email;
        existing.cloud_url = cloud_url;
        save_config(&existing)?;
        info!("cloud connected");
        Ok(())
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))?
}

/// One-click cloud login: starts a localhost callback server, opens browser,
/// waits for the token redirect, saves it, and returns.
#[tauri::command]
pub async fn cloud_login(cloud_url: Option<String>) -> Result<CloudStatus, String> {
    let base_url = cloud_url.unwrap_or_else(|| "http://localhost:3000".to_string());

    // Bind a temporary listener on a random port
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await
        .map_err(|e| format!("bind failed: {e}"))?;
    let port = listener.local_addr()
        .map_err(|e| format!("local addr: {e}"))?.port();

    let callback_url = format!("http://localhost:{port}/callback");
    let browser_url = format!("{base_url}/connect?callback={}", urlencoding::encode(&callback_url));

    // Open browser
    info!(url = %browser_url, "opening browser for cloud login");
    if let Err(e) = open::that(&browser_url) {
        return Err(format!("failed to open browser: {e}"));
    }

    // Wait for the callback (timeout 120 seconds)
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(120),
        wait_for_callback(listener),
    ).await;

    match result {
        Ok(Ok((token, refresh_token, email))) => {
            let mut config = load_config();
            config.token = Some(token.clone());
            if !refresh_token.is_empty() {
                config.refresh_token = Some(refresh_token);
            }
            config.email = Some(email.clone());
            config.cloud_url = Some(base_url.clone());
            save_config(&config).map_err(|e| format!("save config: {e}"))?;
            info!(email = %email, "cloud login successful");

            let plan = check_plan(&base_url, &token).await;

            Ok(CloudStatus {
                connected: true,
                email: Some(email),
                plan,
            })
        }
        Ok(Err(e)) => Err(format!("auth callback failed: {e}")),
        Err(_) => Err("login timed out — try again".to_string()),
    }
}

/// Wait for the browser to redirect to our localhost callback with the token.
/// Returns (access_token, refresh_token, email).
async fn wait_for_callback(listener: tokio::net::TcpListener) -> Result<(String, String, String), String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let (mut stream, _) = listener.accept().await
        .map_err(|e| format!("accept: {e}"))?;

    let mut buf = vec![0u8; 8192];
    let n = stream.read(&mut buf).await
        .map_err(|e| format!("read: {e}"))?;
    let request = String::from_utf8_lossy(&buf[..n]);

    let first_line = request.lines().next().unwrap_or("");
    let path = first_line.split_whitespace().nth(1).unwrap_or("");

    let token = extract_param(path, "token").ok_or("missing token")?;
    let refresh_token = extract_param(path, "refresh_token").unwrap_or_default();
    let email = extract_param(path, "email").unwrap_or_default();

    let html = r#"<!DOCTYPE html><html><head><title>Connected</title></head>
<body style="background:#0a0a0a;color:#e5e5e5;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div style="text-align:center">
<h1 style="font-size:24px">Connected!</h1>
<p style="color:#71717a">You can close this tab and return to Clawcage.</p>
<script>setTimeout(()=>window.close(),2000)</script>
</div></body></html>"#;

    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        html.len(), html
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.flush().await;

    Ok((token, refresh_token, email))
}

fn extract_param(path: &str, key: &str) -> Option<String> {
    let query = path.split('?').nth(1)?;
    for pair in query.split('&') {
        let mut kv = pair.splitn(2, '=');
        if kv.next()? == key {
            return kv.next().map(|v| urlencoding::decode(v).unwrap_or_default().to_string());
        }
    }
    None
}

async fn check_plan(cloud_url: &str, token: &str) -> String {
    let resp = reqwest::Client::new()
        .get(format!("{cloud_url}/api/subscription"))
        .header("Authorization", format!("Bearer {token}"))
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await;

    let Ok(r) = resp else { return "free".to_string() };
    if !r.status().is_success() { return "free".to_string(); }

    r.json::<serde_json::Value>()
        .await
        .ok()
        .and_then(|v| v["status"].as_str().map(|s| s.to_string()))
        .unwrap_or_else(|| "free".to_string())
}

/// Save encryption key to macOS Keychain (iCloud Keychain backup).
#[tauri::command]
pub async fn cloud_backup_key() -> Result<(), String> {
    tokio::task::spawn_blocking(|| {
        let config = load_config();
        let key = config.encryption_key.ok_or("no encryption key — sync an environment first")?;
        keychain_set("encryption-key", &key)?;
        info!("encryption key backed up to Keychain");
        Ok(())
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))?
}

/// Export the encryption key as a base64 string (for manual backup).
#[tauri::command]
pub async fn cloud_export_key() -> Result<String, String> {
    let config = load_config();
    config.encryption_key.ok_or("no encryption key — sync an environment first".to_string())
}

/// Open a URL in the user's default browser.
#[tauri::command]
pub async fn open_external(url: String) -> Result<(), String> {
    open::that(&url).map_err(|e| format!("failed to open URL: {e}"))
}

/// Disconnect from Clawcage Cloud.
#[tauri::command]
pub async fn cloud_disconnect() -> Result<(), String> {
    tokio::task::spawn_blocking(|| {
        keychain_delete("access-token");
        keychain_delete("refresh-token");
        save_config(&CloudConfig::default())?;
        info!("cloud disconnected");
        Ok(())
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))?
}

/// Get cloud connection status and subscription plan.
#[tauri::command]
pub async fn cloud_status() -> Result<CloudStatus, String> {
    let mut config = load_config();
    if config.token.as_ref().map_or(true, |t| t.is_empty()) {
        return Ok(CloudStatus { connected: false, email: None, plan: "free".into() });
    }

    let token = match get_valid_token(&mut config).await {
        Ok(t) => t,
        Err(_) => return Ok(CloudStatus { connected: false, email: config.email, plan: "free".into() }),
    };

    let cloud_url = config.cloud_url.as_deref().unwrap_or("http://localhost:3000").to_string();
    let plan = check_plan(&cloud_url, &token).await;

    Ok(CloudStatus {
        connected: true,
        email: config.email,
        plan,
    })
}

/// Sync a venv to the cloud.
/// Flow: compress → encrypt → get upload URL → upload → confirm record.
#[tauri::command]
pub async fn cloud_sync_venv(
    venv_id: String,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    use tauri::{Emitter, Manager};

    // Ensure venv is stopped
    {
        let state: tauri::State<'_, crate::state::AppState> = app_handle.state();
        if state.running_venvs.lock().unwrap().contains_key(&venv_id) {
            return Err("stop the environment before syncing to cloud".to_string());
        }
    }

    let mut config = load_config();
    let token = get_valid_token(&mut config).await?;
    let cloud_url = config.cloud_url.as_deref().unwrap_or("http://localhost:3000").to_string();
    let enc_key = get_or_create_key(&mut config)?;

    // Phase 1: Compress to temp archive (blocking I/O)
    let h = app_handle.clone();
    let vid = venv_id.clone();
    let tmp = std::env::temp_dir().join(format!("clawcage-sync-{venv_id}.clawcage"));
    let tmp2 = tmp.clone();

    let (venv_name, venv_template, _archive_size) = tokio::task::spawn_blocking(move || {
        let venv = crate::venvs::load_venvs()?
            .into_iter()
            .find(|v| v.id == vid)
            .ok_or("venv not found".to_string())?;

        let venv_dir = std::env::var("HOME")
            .map(|h| std::path::PathBuf::from(h).join(".clawcage").join("venvs").join(&vid))
            .map_err(|_| "HOME not set".to_string())?;

        let manifest = crate::snapshots::SnapshotManifest {
            version: 1,
            name: venv.name.clone(),
            template: venv.template.clone(),
            ephemeral: venv.ephemeral,
            created_at: venv.created_at.clone(),
            snapshot_at: clawcage_core::session::now_iso(),
            scratch_disk_logical_size_gb: 16,
            disk_used_kb: 0,
            icon: venv.icon.clone(),
            clawcage_version: env!("CARGO_PKG_VERSION").to_string(),
        };

        let h2 = h.clone();
        let vid2 = vid.clone();
        crate::snapshots::create_archive_pub(&venv_dir, &manifest, &tmp2, &|processed, total| {
            let _ = h2.emit("snapshot-progress", crate::snapshots::SnapshotProgress {
                operation: "sync".into(),
                venv_id: vid2.clone(),
                phase: "compressing".into(),
                bytes_processed: processed,
                total_bytes: total,
            });
        })?;

        let file_size = std::fs::metadata(&tmp2).map(|m| m.len()).unwrap_or(0);
        Ok::<_, String>((venv.name, venv.template, file_size))
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))??;

    // Phase 2: Read + encrypt (blocking CPU work)
    let _ = app_handle.emit("snapshot-progress", crate::snapshots::SnapshotProgress {
        operation: "sync".into(),
        venv_id: venv_id.clone(),
        phase: "encrypting".into(),
        bytes_processed: 0,
        total_bytes: 0,
    });

    let plaintext = tokio::fs::read(&tmp).await
        .map_err(|e| format!("read archive: {e}"))?;
    let _ = tokio::fs::remove_file(&tmp).await;

    let encrypted = tokio::task::spawn_blocking(move || {
        encrypt_bytes(&plaintext, &enc_key)
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))??;

    let encrypted_size = encrypted.len() as u64;
    info!(encrypted_bytes = encrypted_size, "archive encrypted");

    // Phase 3: Get upload URL (no DB record created yet)
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{cloud_url}/api/snapshots"))
        .header("Authorization", format!("Bearer {token}"))
        .json(&serde_json::json!({
            "action": "prepare",
            "venv_name": venv_name,
            "venv_template": venv_template,
            "file_size_bytes": encrypted_size,
            "encrypted": true,
        }))
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| format!("cloud API error: {e}"))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("cloud API error: {body}"));
    }

    let upload_info: serde_json::Value = resp.json().await
        .map_err(|e| format!("parse response: {e}"))?;
    let upload_url = upload_info["upload_url"].as_str()
        .ok_or("missing upload_url in response")?.to_string();

    // Phase 4: Upload encrypted data with progress
    let _ = app_handle.emit("snapshot-progress", crate::snapshots::SnapshotProgress {
        operation: "sync".into(),
        venv_id: venv_id.clone(),
        phase: "uploading".into(),
        bytes_processed: 0,
        total_bytes: encrypted_size,
    });

    info!(url = %upload_url, bytes = encrypted_size, "uploading encrypted archive");

    // Stream upload in chunks to report progress
    const CHUNK_SIZE: usize = 256 * 1024; // 256 KB chunks
    let total = encrypted.len();
    let ah = app_handle.clone();
    let vid2 = venv_id.clone();

    let stream = futures::stream::unfold(
        (encrypted, 0usize),
        move |(data, offset)| {
            let ah = ah.clone();
            let vid2 = vid2.clone();
            async move {
                if offset >= data.len() {
                    return None;
                }
                let end = (offset + CHUNK_SIZE).min(data.len());
                let chunk = bytes::Bytes::copy_from_slice(&data[offset..end]);
                let sent = end as u64;

                let _ = ah.emit("snapshot-progress", crate::snapshots::SnapshotProgress {
                    operation: "sync".into(),
                    venv_id: vid2,
                    phase: "uploading".into(),
                    bytes_processed: sent,
                    total_bytes: total as u64,
                });

                Some((Ok::<_, std::io::Error>(chunk), (data, end)))
            }
        },
    );

    let body = reqwest::Body::wrap_stream(stream);

    let upload_resp = client
        .put(&upload_url)
        .header("Content-Type", "application/octet-stream")
        .header("Content-Length", total.to_string())
        .body(body)
        .timeout(std::time::Duration::from_secs(600))
        .send()
        .await
        .map_err(|e| format!("upload error: {e}"))?;

    if !upload_resp.status().is_success() {
        let body = upload_resp.text().await.unwrap_or_default();
        return Err(format!("upload failed: {body}"));
    }

    // Phase 5: Confirm upload — NOW create the DB record
    let confirm_resp = client
        .post(format!("{cloud_url}/api/snapshots"))
        .header("Authorization", format!("Bearer {token}"))
        .json(&serde_json::json!({
            "action": "confirm",
            "venv_name": venv_name,
            "venv_template": venv_template,
            "file_size_bytes": encrypted_size,
            "encrypted": true,
        }))
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| format!("confirm error: {e}"))?;

    if !confirm_resp.status().is_success() {
        let body = confirm_resp.text().await.unwrap_or_default();
        return Err(format!("confirm failed: {body}"));
    }

    let _ = app_handle.emit("snapshot-progress", crate::snapshots::SnapshotProgress {
        operation: "sync".into(),
        venv_id: venv_id.clone(),
        phase: "done".into(),
        bytes_processed: encrypted_size,
        total_bytes: encrypted_size,
    });

    info!(venv_id = %venv_id, "cloud sync complete (encrypted)");
    Ok(())
}
