//! Tauri IPC Commands
//!
//! **CRITICAL SAFETY RULE: Never perform blocking I/O in synchronous Tauri commands.**
//! 
//! Tauri processes synchronous commands in a limited thread pool. If a synchronous command
//! performs a blocking operation (e.g., `file.write_all()` to a vsock descriptor whose buffer
//! might be full, or a `rusqlite` database query), it can exhaust this pool. This causes the
//! entire application UI and IPC channel to completely freeze ("barf" or lag on rapid input).
//! 
//! **Always** define commands that do I/O as `async fn` and wrap the blocking portions inside
//! `tokio::task::spawn_blocking`. This offloads the work to Tokio's dedicated background
//! thread pool, keeping the Tauri IPC channels responsive.

use std::collections::HashMap;
use std::io::Write;
use std::sync::Arc;

use clawcage_core::net::policy_config::{self, ConfigIssue, ResolvedSetting, SettingEntry, SettingsNode, SettingValue};
use clawcage_core::session;
use clawcage_core::{HostToGuest, encode_host_msg, validate_host_msg};
use clawcage_logger::validate_select_only;
use serde::Serialize;
use tauri::State;

use crate::clone_fd;
use crate::state::AppState;

/// Get the active VM ID from app state, or return an error.
fn active_vm_id(state: &AppState) -> Result<String, String> {
    state
        .active_session_id
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "no active session".to_string())
}

#[tauri::command]
pub fn vm_status(state: State<'_, AppState>) -> String {
    let vm_id = match active_vm_id(&state) {
        Ok(id) => id,
        Err(_) => return "not created".to_string(),
    };
    let vms = state.vms.lock().unwrap();
    match vms.get(&vm_id) {
        Some(instance) => format!("{}", instance.state_machine.state()),
        None => "not created".to_string(),
    }
}

#[tauri::command]
pub async fn serial_input(
    input: String,
    session_id: Option<u32>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let sid = session_id.unwrap_or(clawcage_core::clawcage_proto::DEFAULT_SHELL_SESSION_ID);
    tracing::debug!("Received serial input (session {sid}): {:?}", input.as_bytes());
    let vm_id = active_vm_id(&state)?;

    let tx = state.terminal_input_tx.clone();

    // Extract fd while holding the lock
    let fd = {
        let vms = state.vms.lock().unwrap();
        let instance = vms.get(&vm_id).ok_or("no VM running")?;
        instance.vsock_terminal_fd.unwrap_or(instance.serial_input_fd)
    };

    // Send the input to the dedicated background thread (now with session_id).
    tx.send((fd, sid, input))
        .map_err(|e| format!("send to input queue failed: {e}"))
}

/// Poll for terminal output data for a specific shell session. Blocks until
/// data is available or the terminal is closed.
#[tauri::command]
pub async fn terminal_poll(
    session_id: Option<u32>,
    state: State<'_, AppState>,
) -> Result<Vec<u8>, String> {
    let sid = session_id.unwrap_or(clawcage_core::clawcage_proto::DEFAULT_SHELL_SESSION_ID);
    let queue = state.terminal_output.get_or_create(sid);
    queue.poll().await
        .ok_or_else(|| "terminal closed".to_string())
}

#[tauri::command]
pub async fn terminal_resize(
    cols: u16,
    rows: u16,
    session_id: Option<u32>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let sid = session_id.unwrap_or(clawcage_core::clawcage_proto::DEFAULT_SHELL_SESSION_ID);
    let vm_id = active_vm_id(&state)?;

    let (control_fd, host_state) = {
        let vms = state.vms.lock().unwrap();
        let instance = vms.get(&vm_id).ok_or("no VM running")?;
        let fd = instance.vsock_control_fd.ok_or("vsock control not connected")?;
        (fd, instance.state_machine.state())
    };

    // Use ShellResize for non-default sessions, legacy Resize for session 0.
    let msg = if sid == clawcage_core::clawcage_proto::DEFAULT_SHELL_SESSION_ID {
        HostToGuest::Resize { cols, rows }
    } else {
        HostToGuest::ShellResize { session_id: sid, cols, rows }
    };
    validate_host_msg(&msg, host_state)
        .map_err(|e| format!("{e}"))?;
    let frame = encode_host_msg(&msg).map_err(|e| format!("{e}"))?;

    let mut file = clone_fd(control_fd)
        .map_err(|e| format!("clone control fd failed: {e}"))?;
    tokio::task::spawn_blocking(move || {
        file.write_all(&frame)
            .map_err(|e| format!("control write failed: {e}"))
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {e}"))?
}

/// Spawn a new shell session in the VM.
#[tauri::command]
pub async fn spawn_shell(
    session_id: u32,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let vm_id = active_vm_id(&state)?;

    let (control_fd, host_state) = {
        let vms = state.vms.lock().unwrap();
        let instance = vms.get(&vm_id).ok_or("no VM running")?;
        let fd = instance.vsock_control_fd.ok_or("vsock control not connected")?;
        (fd, instance.state_machine.state())
    };

    // Create the output queue for this session ahead of time.
    state.terminal_output.get_or_create(session_id);

    let msg = HostToGuest::SpawnShell { session_id };
    validate_host_msg(&msg, host_state)
        .map_err(|e| format!("{e}"))?;
    let frame = encode_host_msg(&msg).map_err(|e| format!("{e}"))?;

    let mut file = clone_fd(control_fd)
        .map_err(|e| format!("clone control fd failed: {e}"))?;
    tokio::task::spawn_blocking(move || {
        file.write_all(&frame)
            .map_err(|e| format!("control write failed: {e}"))
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {e}"))?
}

/// Close a shell session in the VM.
#[tauri::command]
pub async fn close_shell(
    session_id: u32,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let vm_id = active_vm_id(&state)?;

    let (control_fd, host_state) = {
        let vms = state.vms.lock().unwrap();
        let instance = vms.get(&vm_id).ok_or("no VM running")?;
        let fd = instance.vsock_control_fd.ok_or("vsock control not connected")?;
        (fd, instance.state_machine.state())
    };

    let msg = HostToGuest::CloseShell { session_id };
    validate_host_msg(&msg, host_state)
        .map_err(|e| format!("{e}"))?;
    let frame = encode_host_msg(&msg).map_err(|e| format!("{e}"))?;

    let mut file = clone_fd(control_fd)
        .map_err(|e| format!("clone control fd failed: {e}"))?;
    tokio::task::spawn_blocking(move || {
        file.write_all(&frame)
            .map_err(|e| format!("control write failed: {e}"))
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {e}"))?
}

/// List active shell session IDs.
#[tauri::command]
pub async fn list_shells(state: State<'_, AppState>) -> Result<Vec<u32>, String> {
    Ok(state.terminal_output.session_ids())
}

// ---------------------------------------------------------------------------
// IPC commands for Svelte UI
// ---------------------------------------------------------------------------

/// Response for get_guest_config.
#[derive(Serialize)]
pub struct GuestConfigResponse {
    pub env: HashMap<String, String>,
}

/// Returns merged guest config (env vars from user.toml + corp.toml). No VM required.
#[tauri::command]
pub async fn get_guest_config() -> Result<GuestConfigResponse, String> {
    tokio::task::spawn_blocking(|| {
        let config = policy_config::load_merged_guest_config();
        GuestConfigResponse {
            env: config.env.unwrap_or_default(),
        }
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {e}"))
}

/// Response for get_network_policy.
#[derive(Serialize)]
pub struct NetworkPolicyResponse {
    pub allow: Vec<String>,
    pub block: Vec<String>,
    pub default_action: String,
    pub corp_managed: bool,
    pub conflicts: Vec<String>,
}

/// Returns the merged network policy. No VM required.
#[tauri::command]
pub async fn get_network_policy() -> Result<NetworkPolicyResponse, String> {
    tokio::task::spawn_blocking(|| {
        let (_user, corp) = policy_config::load_settings_files();
        let corp_managed = !corp.settings.is_empty();
        let policy = policy_config::load_merged_policy();
        let dp = policy.domain_policy();
        // Probe the default action by evaluating a domain that won't match any rule.
        let (default_act, _) = dp.evaluate("__clawcage_probe_nonexistent__.invalid");
        let allow_set = dp.allowed_patterns();
        let block_set = dp.blocked_patterns();
        let conflicts: Vec<String> = allow_set.iter()
            .filter(|d| block_set.contains(d))
            .cloned()
            .collect();
        NetworkPolicyResponse {
            allow: allow_set,
            block: block_set,
            default_action: if default_act == clawcage_core::net::domain_policy::Action::Allow {
                "allow".to_string()
            } else {
                "deny".to_string()
            },
            corp_managed,
            conflicts,
        }
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {e}"))
}

/// Set a guest env var in ~/.clawcage/user.toml via settings system.
#[tauri::command]
pub async fn set_guest_env(key: String, value: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let path = policy_config::user_config_path()
            .ok_or("HOME not set")?;
        let mut file = policy_config::load_settings_file(&path)?;
        let setting_id = format!("guest.env.{key}");
        file.settings.insert(setting_id, SettingEntry {
            value: SettingValue::Text(value),
            modified: session::now_iso(),
        });
        policy_config::write_settings_file(&path, &file)
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {e}"))?
}

/// Remove a guest env var from ~/.clawcage/user.toml via settings system.
#[tauri::command]
pub async fn remove_guest_env(key: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let path = policy_config::user_config_path()
            .ok_or("HOME not set")?;
        let mut file = policy_config::load_settings_file(&path)?;
        let setting_id = format!("guest.env.{key}");
        file.settings.remove(&setting_id);
        policy_config::write_settings_file(&path, &file)
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {e}"))?
}

/// Returns all resolved settings for the UI.
/// If `venv_id` is provided, includes venv-level overrides.
#[tauri::command]
pub async fn get_settings(venv_id: Option<String>) -> Result<Vec<ResolvedSetting>, String> {
    tokio::task::spawn_blocking(move || {
        policy_config::load_merged_settings_for_venv(venv_id.as_deref())
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {e}"))
}

/// Returns the settings tree (nested groups + leaves) for the UI.
/// If `venv_id` is provided, includes venv-level overrides.
#[tauri::command]
pub async fn get_settings_tree(venv_id: Option<String>) -> Result<Vec<SettingsNode>, String> {
    tokio::task::spawn_blocking(move || {
        policy_config::load_settings_tree_for_venv(venv_id.as_deref())
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {e}"))
}

/// Validate all settings and return a list of issues.
/// If `venv_id` is provided, validates with venv-level overrides.
#[tauri::command]
pub async fn lint_config(venv_id: Option<String>) -> Result<Vec<ConfigIssue>, String> {
    tokio::task::spawn_blocking(move || {
        policy_config::load_merged_lint_for_venv(venv_id.as_deref())
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {e}"))
}

/// Update a single setting by ID. If `venv_id` is provided, writes to the
/// venv settings file; otherwise writes to the global user settings.
/// Hot-reloads the network policy so changes take effect immediately.
#[tauri::command]
pub async fn update_setting(id: String, value: SettingValue, venv_id: Option<String>, app_handle: tauri::AppHandle) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        use tauri::Manager;
        // Validate before persisting (e.g. JSON check for File-type settings).
        policy_config::validate_setting_value(&id, &value)?;

        if let Some(ref vid) = venv_id {
            // Write to venv settings file.
            let path = policy_config::venv_config_path(vid)
                .ok_or("HOME not set")?;
            let mut file = policy_config::load_settings_file(&path)?;
            file.settings.insert(id, SettingEntry {
                value,
                modified: session::now_iso(),
            });
            policy_config::write_settings_file(&path, &file)?;
        } else {
            // Write to global user settings file.
            let path = policy_config::user_config_path()
                .ok_or("HOME not set")?;
            let mut file = policy_config::load_settings_file(&path)?;
            file.settings.insert(id, SettingEntry {
                value,
                modified: session::now_iso(),
            });
            policy_config::write_settings_file(&path, &file)?;
        }

        // Hot-reload: rebuild the network policy from disk and swap it into the
        // running MITM proxy. New connections will use the updated policy.
        let new_policy = std::sync::Arc::new(
            policy_config::load_merged_network_policy_for_venv(venv_id.as_deref())
        );
        let new_domain_policy = std::sync::Arc::new(
            policy_config::load_merged_domain_policy_for_venv(venv_id.as_deref())
        );
        let state = app_handle.state::<AppState>();
        if let Ok(vm_id) = active_vm_id(&state) {
            let vms = state.vms.lock().unwrap();
            if let Some(instance) = vms.get(&vm_id) {
                if let Some(ns) = &instance.net_state {
                    *ns.policy.write().unwrap() = new_policy;
                    tracing::info!("hot-reloaded network policy");
                }
                // Hot-reload MCP domain policy.
                if let Some(mcp) = &instance.mcp_state {
                    *mcp.domain_policy.write().unwrap() = new_domain_policy;
                    tracing::info!("hot-reloaded MCP domain policy");
                }
            }
        }

        Ok(())
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {e}"))?
}

/// Reset a venv-level setting override (removes it from the venv settings file
/// so the setting falls back to the global user/default value).
#[tauri::command]
pub async fn reset_venv_setting(venv_id: String, id: String, app_handle: tauri::AppHandle) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        use tauri::Manager;
        policy_config::remove_venv_setting(&venv_id, &id)?;

        // Hot-reload policy after removing the override.
        let new_policy = std::sync::Arc::new(
            policy_config::load_merged_network_policy_for_venv(Some(&venv_id))
        );
        let new_domain_policy = std::sync::Arc::new(
            policy_config::load_merged_domain_policy_for_venv(Some(&venv_id))
        );
        let state = app_handle.state::<AppState>();
        if let Ok(vm_id) = active_vm_id(&state) {
            let vms = state.vms.lock().unwrap();
            if let Some(instance) = vms.get(&vm_id) {
                if let Some(ns) = &instance.net_state {
                    *ns.policy.write().unwrap() = new_policy;
                    tracing::info!("hot-reloaded network policy after venv setting reset");
                }
                if let Some(mcp) = &instance.mcp_state {
                    *mcp.domain_policy.write().unwrap() = new_domain_policy;
                    tracing::info!("hot-reloaded MCP domain policy after venv setting reset");
                }
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {e}"))?
}

/// Response for get_vm_state.
#[derive(Serialize)]
pub struct VmStateResponse {
    pub state: String,
    pub elapsed_ms: u64,
    pub history: Vec<TransitionEntry>,
}

/// A single transition in the state machine history.
#[derive(Serialize)]
pub struct TransitionEntry {
    pub from: String,
    pub to: String,
    pub trigger: String,
    pub duration_ms: f64,
}

/// Returns full state machine info for the active VM.
#[tauri::command]
pub fn get_vm_state(state: State<'_, AppState>) -> Result<VmStateResponse, String> {
    let vm_id = active_vm_id(&state)?;
    let vms = state.vms.lock().unwrap();
    let instance = vms.get(&vm_id).ok_or("no VM running")?;
    let sm = &instance.state_machine;
    Ok(VmStateResponse {
        state: format!("{}", sm.state()),
        elapsed_ms: sm.elapsed().as_millis() as u64,
        history: sm.history().iter().map(|t| TransitionEntry {
            from: format!("{:?}", t.from),
            to: format!("{:?}", t.to),
            trigger: t.trigger.to_string(),
            duration_ms: t.duration_in_from.as_secs_f64() * 1000.0,
        }).collect(),
    })
}

// ---------------------------------------------------------------------------
// Session info commands
// ---------------------------------------------------------------------------

/// Response for get_session_info.
#[derive(Serialize)]
pub struct SessionInfoResponse {
    pub session_id: String,
    pub mode: String,
    pub uptime_ms: u64,
    pub scratch_disk_size_gb: u32,
    pub ram_bytes: u64,
    pub total_requests: u64,
    pub allowed_requests: u64,
    pub denied_requests: u64,
    pub error_requests: u64,
    pub bytes_sent: u64,
    pub bytes_received: u64,
    pub model_call_count: u64,
    pub total_input_tokens: u64,
    pub total_output_tokens: u64,
    pub total_usage_details: std::collections::BTreeMap<String, u64>,
    pub total_tool_calls: u64,
    pub total_estimated_cost_usd: f64,
}

/// Returns info about the current active session.
#[tauri::command]
pub async fn get_session_info(state: State<'_, AppState>) -> Result<SessionInfoResponse, String> {
    let vm_id = active_vm_id(&state)?;

    // Get uptime from state machine.
    let uptime_ms = {
        let vms = state.vms.lock().unwrap();
        match vms.get(&vm_id) {
            Some(instance) => instance.state_machine.elapsed().as_millis() as u64,
            None => 0,
        }
    };

    // Get session record from index.
    let (mode, disk_gb, ram) = {
        let idx = state.session_index.lock().map_err(|e| format!("session index lock: {e}"))?;
        let records = idx.recent(50).map_err(|e| format!("session index query: {e}"))?;
        let record = records.iter().find(|r| r.id == vm_id);
        (
            record.map(|r| r.mode.clone()).unwrap_or_else(|| "gui".to_string()),
            record.map(|r| r.scratch_disk_size_gb).unwrap_or(16),
            record.map(|r| r.ram_bytes).unwrap_or(4 * 1024 * 1024 * 1024),
        )
    };

    // Get live stats from session DB via spawn_blocking.
    let db = {
        let vms = state.vms.lock().unwrap();
        vms.get(&vm_id)
            .and_then(|i| i.net_state.as_ref())
            .map(|ns| Arc::clone(&ns.db))
    };

    let stats = if let Some(db) = db {
        tokio::task::spawn_blocking(move || {
            db.reader()
                .ok()
                .and_then(|r| r.session_stats().ok())
        })
        .await
        .map_err(|e| format!("spawn_blocking failed: {e}"))?
    } else {
        None
    };

    let vm_id_out = vm_id;
    Ok(SessionInfoResponse {
        session_id: vm_id_out,
        mode,
        uptime_ms,
        scratch_disk_size_gb: disk_gb,
        ram_bytes: ram,
        total_requests: stats.as_ref().map(|s| s.net_total).unwrap_or(0),
        allowed_requests: stats.as_ref().map(|s| s.net_allowed).unwrap_or(0),
        denied_requests: stats.as_ref().map(|s| s.net_denied).unwrap_or(0),
        error_requests: stats.as_ref().map(|s| s.net_error).unwrap_or(0),
        bytes_sent: stats.as_ref().map(|s| s.net_bytes_sent).unwrap_or(0),
        bytes_received: stats.as_ref().map(|s| s.net_bytes_received).unwrap_or(0),
        model_call_count: stats.as_ref().map(|s| s.model_call_count).unwrap_or(0),
        total_input_tokens: stats.as_ref().map(|s| s.total_input_tokens).unwrap_or(0),
        total_output_tokens: stats.as_ref().map(|s| s.total_output_tokens).unwrap_or(0),
        total_usage_details: stats.as_ref().map(|s| s.total_usage_details.clone()).unwrap_or_default(),
        total_tool_calls: stats.as_ref().map(|s| s.total_tool_calls).unwrap_or(0),
        total_estimated_cost_usd: stats.as_ref().map(|s| s.total_estimated_cost_usd).unwrap_or(0.0),
    })
}

// ---------------------------------------------------------------------------
// Raw SQL query
// ---------------------------------------------------------------------------

/// Execute a raw SELECT query against the session DB or main.db.
/// Returns a JSON string: `{"columns":[...],"rows":[[...],...]}`
///
/// - `db`: `"session"` (default) or `"main"` -- which database to query
/// - `params`: optional bind parameter values (`?` positional placeholders)
#[tauri::command]
pub async fn query_db(
    sql: String,
    db: Option<String>,
    params: Option<Vec<serde_json::Value>>,
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let params = params.unwrap_or_default();
    let target = db.unwrap_or_else(|| "session".to_string());

    match target.as_str() {
        "main" => {
            tokio::task::spawn_blocking(move || {
                use tauri::Manager;
                validate_select_only(&sql)?;
                let state = app_handle.state::<AppState>();
                let idx = state.session_index.lock().map_err(|e| format!("lock: {e}"))?;
                idx.query_raw(&sql, &params)
            })
            .await
            .map_err(|e| format!("spawn_blocking failed: {e}"))?
        }
        _ => {
            let vm_id = active_vm_id(&state)?;
            let db_writer = {
                let vms = state.vms.lock().unwrap();
                let instance = vms.get(&vm_id).ok_or("no VM running")?;
                let net_state = instance.net_state.as_ref().ok_or("network not initialized")?;
                Arc::clone(&net_state.db)
            };

            tokio::task::spawn_blocking(move || {
                validate_select_only(&sql)?;
                let reader = db_writer.reader().map_err(|e| format!("db reader: {e}"))?;
                if params.is_empty() {
                    reader.query_raw(&sql)
                } else {
                    reader.query_raw_with_params(&sql, &params)
                }
            })
            .await
            .map_err(|e| format!("spawn_blocking failed: {e}"))?
        }
    }
}

// ---------------------------------------------------------------------------
// Port forwarding commands
// ---------------------------------------------------------------------------

/// Response for get_ports.
#[derive(Serialize)]
pub struct PortsResponse {
    pub detected: Vec<crate::state::DetectedPort>,
    pub forwarded: Vec<crate::state::ForwardedPort>,
}

#[tauri::command]
pub fn get_ports(state: State<'_, AppState>) -> Result<PortsResponse, String> {
    let vm_id = active_vm_id(&state)?;
    let vms = state.vms.lock().unwrap();
    let instance = vms.get(&vm_id).ok_or("VM not found")?;
    let detected = instance.port_state.detected.read().unwrap().clone();
    let forwarded = instance.port_state.forwarded.read().unwrap().clone();
    Ok(PortsResponse { detected, forwarded })
}

#[tauri::command]
pub async fn forward_port(
    guest_port: u16,
    host_port: Option<u16>,
    state: State<'_, AppState>,
) -> Result<u16, String> {
    let hp = host_port.unwrap_or(guest_port);
    let vm_id = active_vm_id(&state)?;
    let vms = state.vms.lock().unwrap();
    let instance = vms.get(&vm_id).ok_or("VM not found")?;
    let port_state = Arc::clone(&instance.port_state);
    drop(vms);

    // Check if already forwarded
    {
        let fwd = port_state.forwarded.read().unwrap();
        if fwd.iter().any(|f| f.guest_port == guest_port) {
            return Err(format!("port {guest_port} is already forwarded"));
        }
    }

    // Bind a TCP listener on the host
    let std_listener = std::net::TcpListener::bind(format!("127.0.0.1:{hp}"))
        .map_err(|e| format!("failed to bind localhost:{hp}: {e}"))?;
    let actual_port = std_listener.local_addr()
        .map_err(|e| format!("failed to get local addr: {e}"))?
        .port();

    // Convert to tokio listener for async accept
    std_listener.set_nonblocking(true)
        .map_err(|e| format!("failed to set nonblocking: {e}"))?;
    let tokio_listener = tokio::net::TcpListener::from_std(std_listener)
        .map_err(|e| format!("failed to create async listener: {e}"))?;

    // Store the forwarded port entry
    {
        let mut fwd = port_state.forwarded.write().unwrap();
        fwd.push(crate::state::ForwardedPort {
            guest_port,
            host_port: actual_port,
        });
    }

    // Spawn a background task that accepts TCP clients and bridges them
    // via vsock relay connections from the guest.
    let ps = Arc::clone(&port_state);
    let task = tokio::spawn(async move {
        port_forward_accept_loop(tokio_listener, guest_port, ps).await;
    });
    {
        let mut tasks = port_state.forward_tasks.lock().unwrap();
        tasks.insert(guest_port, task.abort_handle());
    }

    tracing::info!("port forward: guest:{guest_port} -> localhost:{actual_port}");
    Ok(actual_port)
}

/// Background loop: accept TCP clients on the host and bridge each to a guest
/// relay vsock connection. The guest port-watch daemon continuously offers relay
/// connections on vsock port 5007; each relay reads a 2-byte BE target port,
/// then opens a local TCP connection inside the guest and bridges bidirectionally.
async fn port_forward_accept_loop(
    listener: tokio::net::TcpListener,
    guest_port: u16,
    port_state: Arc<crate::state::PortState>,
) {
    loop {
        let (mut tcp_stream, peer) = match listener.accept().await {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!("port-forward({guest_port}): accept error: {e}");
                break;
            }
        };
        let _ = tcp_stream.set_nodelay(true);
        tracing::debug!("port-forward({guest_port}): client from {peer}");

        // Take a relay vsock fd from the guest (wait up to 10s).
        let relay_fd = {
            let mut rx = port_state.relay_rx.lock().await;
            match tokio::time::timeout(std::time::Duration::from_secs(10), rx.recv()).await {
                Ok(Some(fd)) => fd,
                Ok(None) => {
                    tracing::warn!("port-forward({guest_port}): relay channel closed");
                    break;
                }
                Err(_) => {
                    tracing::warn!("port-forward({guest_port}): no relay connection available (timeout)");
                    continue;
                }
            }
        };

        // Spawn a bridge task for this client.
        tokio::spawn(async move {
            if let Err(e) = port_forward_bridge(relay_fd, guest_port, &mut tcp_stream).await {
                let is_normal = matches!(
                    e.kind(),
                    std::io::ErrorKind::ConnectionReset
                        | std::io::ErrorKind::UnexpectedEof
                        | std::io::ErrorKind::BrokenPipe
                );
                if !is_normal {
                    tracing::warn!("port-forward({guest_port}): bridge error: {e}");
                }
            }
        });
    }
}

/// Bridge a single TCP client to the guest via a vsock relay fd.
/// Sends the 2-byte BE target port, then copies bidirectionally.
/// The relay_fd is already dup'd (owned by us), so we wrap it directly.
async fn port_forward_bridge(
    relay_fd: std::os::unix::io::RawFd,
    guest_port: u16,
    tcp_stream: &mut tokio::net::TcpStream,
) -> std::io::Result<()> {
    use std::os::unix::io::FromRawFd;
    use tokio::io::AsyncWriteExt;

    // Wrap the dup'd vsock fd in an async stream (takes ownership).
    let std_stream = unsafe {
        std::os::unix::net::UnixStream::from_raw_fd(relay_fd)
    };
    std_stream.set_nonblocking(true)?;
    let mut vsock_stream = tokio::net::UnixStream::from_std(std_stream)?;

    // Tell the guest relay which port to connect to.
    vsock_stream.write_all(&guest_port.to_be_bytes()).await?;

    // Bidirectional bridge.
    tokio::io::copy_bidirectional(tcp_stream, &mut vsock_stream).await?;
    Ok(())
}

#[tauri::command]
pub async fn stop_forward(
    guest_port: u16,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let vm_id = active_vm_id(&state)?;
    let vms = state.vms.lock().unwrap();
    let instance = vms.get(&vm_id).ok_or("VM not found")?;
    let port_state = Arc::clone(&instance.port_state);
    drop(vms);

    // Abort the background forwarding task
    {
        let mut tasks = port_state.forward_tasks.lock().unwrap();
        if let Some(handle) = tasks.remove(&guest_port) {
            handle.abort();
        }
    }

    // Remove forwarded entry
    {
        let mut fwd = port_state.forwarded.write().unwrap();
        fwd.retain(|f| f.guest_port != guest_port);
    }

    tracing::info!("port forward stopped: guest:{guest_port}");
    Ok(())
}

// ---------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------

/// Response for get_processes.
#[derive(Serialize)]
pub struct ProcessesResponse {
    pub processes: Vec<crate::state::GuestProcess>,
    pub forwarded: Vec<crate::state::ForwardedPort>,
}

#[tauri::command]
pub fn get_processes(state: State<'_, AppState>) -> Result<ProcessesResponse, String> {
    let vm_id = active_vm_id(&state)?;
    let vms = state.vms.lock().unwrap();
    let instance = vms.get(&vm_id).ok_or("VM not found")?;
    let processes = instance.process_state.processes.read().unwrap().clone();
    let forwarded = instance.port_state.forwarded.read().unwrap().clone();
    Ok(ProcessesResponse { processes, forwarded })
}

#[tauri::command]
pub async fn kill_process(
    pid: u32,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let vm_id = active_vm_id(&state)?;
    let vms = state.vms.lock().unwrap();
    let instance = vms.get(&vm_id).ok_or("VM not found")?;
    let control_fd = instance.vsock_control_fd.ok_or("no control channel")?;
    drop(vms);

    // Send KillProcess via control channel
    let msg = clawcage_core::clawcage_proto::HostToGuest::KillProcess { pid };
    let frame = clawcage_core::clawcage_proto::encode_host_msg(&msg)
        .map_err(|e| format!("encode KillProcess: {e}"))?;
    {
        use std::io::Write;
        let mut file = crate::clone_fd(control_fd).map_err(|e| format!("clone fd: {e}"))?;
        file.write_all(&frame).map_err(|e| format!("write KillProcess: {e}"))?;
    }
    tracing::info!("sent KillProcess for pid {pid}");
    Ok(())
}

// ---------------------------------------------------------------------------
// System metrics
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn system_metrics(state: State<'_, AppState>) -> Result<crate::state::SystemMetrics, String> {
    let vm_id = active_vm_id(&state)?;
    let vms = state.vms.lock().unwrap();
    let instance = vms.get(&vm_id).ok_or("VM not found")?;
    let metrics = instance.sys_metrics.latest.read().unwrap().clone();
    Ok(metrics)
}

/// Returns available disk space on the host in bytes.
#[tauri::command]
pub fn host_disk_free() -> Result<u64, String> {
    // Use `df` to get available space on the home partition (no libc dep needed).
    let home = std::env::var("HOME").unwrap_or_else(|_| "/".to_string());
    let output = std::process::Command::new("df")
        .args(["-k", &home])
        .output()
        .map_err(|e| format!("df failed: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    // Parse second line: Filesystem 1K-blocks Used Available Use% Mounted
    let line = stdout.lines().nth(1).ok_or("df: no output")?;
    let avail_kb: u64 = line.split_whitespace()
        .nth(3)
        .ok_or("df: missing available field")?
        .parse()
        .map_err(|e| format!("df: parse error: {e}"))?;
    Ok(avail_kb * 1024)
}

// ---------------------------------------------------------------------------
// File download from guest VM
// ---------------------------------------------------------------------------

/// Download a file from the guest VM to the host filesystem.
///
/// Sends a FileRead request over the vsock control channel, waits for the
/// guest agent to respond with FileContent (or FileError), then saves the
/// file to `host_path`.
#[tauri::command]
pub async fn download_file(
    guest_path: String,
    host_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    use std::sync::atomic::Ordering;

    let vm_id = active_vm_id(&state)?;

    let (control_fd, host_state) = {
        let vms = state.vms.lock().unwrap();
        let instance = vms.get(&vm_id).ok_or("no VM running")?;
        let fd = instance.vsock_control_fd.ok_or("vsock control not connected")?;
        (fd, instance.state_machine.state())
    };

    // Allocate a unique download ID and register a oneshot channel.
    let id = state.download_id_counter.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.pending_downloads.lock().unwrap().insert(id, tx);

    // Send FileRead to the guest.
    let msg = HostToGuest::FileRead { id, path: guest_path.clone() };
    validate_host_msg(&msg, host_state)
        .map_err(|e| format!("{e}"))?;
    let frame = encode_host_msg(&msg).map_err(|e| format!("{e}"))?;

    let mut file = clone_fd(control_fd)
        .map_err(|e| format!("clone control fd failed: {e}"))?;
    tokio::task::spawn_blocking(move || {
        file.write_all(&frame)
            .map_err(|e| format!("write FileRead failed: {e}"))
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))??;

    // Wait for the guest response with a generous timeout (5 minutes for large files).
    let data = tokio::time::timeout(std::time::Duration::from_secs(300), rx)
        .await
        .map_err(|_| {
            // Clean up on timeout.
            state.pending_downloads.lock().unwrap().remove(&id);
            "file download timed out".to_string()
        })?
        .map_err(|_| "download channel closed".to_string())?
        .map_err(|e| e)?;

    // Save to host filesystem.
    tokio::task::spawn_blocking(move || {
        // Ensure parent directory exists.
        if let Some(parent) = std::path::Path::new(&host_path).parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("create dir failed: {e}"))?;
        }
        std::fs::write(&host_path, &data)
            .map_err(|e| format!("write file failed: {e}"))
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))?
}

// ---------------------------------------------------------------------------
// File read/save for inline editor
// ---------------------------------------------------------------------------

/// List directory contents in the guest VM.
#[tauri::command]
pub async fn list_dir(
    guest_path: String,
    state: State<'_, AppState>,
) -> Result<Vec<clawcage_core::clawcage_proto::DirEntry>, String> {
    use std::sync::atomic::Ordering;

    let vm_id = active_vm_id(&state)?;

    let (control_fd, host_state) = {
        let vms = state.vms.lock().unwrap();
        let instance = vms.get(&vm_id).ok_or("no VM running")?;
        let fd = instance.vsock_control_fd.ok_or("vsock control not connected")?;
        (fd, instance.state_machine.state())
    };

    let id = state.download_id_counter.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.pending_downloads.lock().unwrap().insert(id, tx);

    let msg = HostToGuest::ListDir { id, path: guest_path.clone() };
    validate_host_msg(&msg, host_state)
        .map_err(|e| format!("{e}"))?;
    let frame = encode_host_msg(&msg).map_err(|e| format!("{e}"))?;

    let mut file = clone_fd(control_fd)
        .map_err(|e| format!("clone control fd failed: {e}"))?;
    tokio::task::spawn_blocking(move || {
        file.write_all(&frame)
            .map_err(|e| format!("write ListDir failed: {e}"))
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))??;

    let data = tokio::time::timeout(std::time::Duration::from_secs(10), rx)
        .await
        .map_err(|_| {
            state.pending_downloads.lock().unwrap().remove(&id);
            "directory listing timed out".to_string()
        })?
        .map_err(|_| "list_dir channel closed".to_string())?
        .map_err(|e| e)?;

    serde_json::from_slice(&data)
        .map_err(|e| format!("failed to parse dir listing: {e}"))
}

/// Read a file from the guest VM and return its content as a UTF-8 string.
///
/// Returns the file content for display/editing in the frontend. Limited to
/// 1MB to avoid overwhelming the UI textarea.
#[tauri::command]
pub async fn read_file(
    guest_path: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    use std::sync::atomic::Ordering;

    const MAX_EDIT_SIZE: usize = 1_048_576; // 1MB

    let vm_id = active_vm_id(&state)?;

    let (control_fd, host_state) = {
        let vms = state.vms.lock().unwrap();
        let instance = vms.get(&vm_id).ok_or("no VM running")?;
        let fd = instance.vsock_control_fd.ok_or("vsock control not connected")?;
        (fd, instance.state_machine.state())
    };

    let id = state.download_id_counter.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.pending_downloads.lock().unwrap().insert(id, tx);

    let msg = HostToGuest::FileRead { id, path: guest_path.clone() };
    validate_host_msg(&msg, host_state)
        .map_err(|e| format!("{e}"))?;
    let frame = encode_host_msg(&msg).map_err(|e| format!("{e}"))?;

    let mut file = clone_fd(control_fd)
        .map_err(|e| format!("clone control fd failed: {e}"))?;
    tokio::task::spawn_blocking(move || {
        file.write_all(&frame)
            .map_err(|e| format!("write FileRead failed: {e}"))
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))??;

    let data = tokio::time::timeout(std::time::Duration::from_secs(30), rx)
        .await
        .map_err(|_| {
            state.pending_downloads.lock().unwrap().remove(&id);
            "file read timed out".to_string()
        })?
        .map_err(|_| "read channel closed".to_string())?
        .map_err(|e| e)?;

    if data.len() > MAX_EDIT_SIZE {
        return Err(format!("file too large to edit ({} bytes, max {})", data.len(), MAX_EDIT_SIZE));
    }

    String::from_utf8(data)
        .map_err(|_| "file contains binary content and cannot be edited as text".to_string())
}

/// Save file content back to the guest VM.
#[tauri::command]
pub async fn save_file(
    guest_path: String,
    content: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    use std::sync::atomic::Ordering;

    let vm_id = active_vm_id(&state)?;

    let (control_fd, host_state) = {
        let vms = state.vms.lock().unwrap();
        let instance = vms.get(&vm_id).ok_or("no VM running")?;
        let fd = instance.vsock_control_fd.ok_or("vsock control not connected")?;
        (fd, instance.state_machine.state())
    };

    let id = state.download_id_counter.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.pending_downloads.lock().unwrap().insert(id, tx);

    let msg = HostToGuest::FileSave { id, path: guest_path.clone(), data: content.into_bytes() };
    validate_host_msg(&msg, host_state)
        .map_err(|e| format!("{e}"))?;
    let frame = encode_host_msg(&msg).map_err(|e| format!("{e}"))?;

    let mut file = clone_fd(control_fd)
        .map_err(|e| format!("clone control fd failed: {e}"))?;
    tokio::task::spawn_blocking(move || {
        file.write_all(&frame)
            .map_err(|e| format!("write FileSave failed: {e}"))
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))??;

    let _data = tokio::time::timeout(std::time::Duration::from_secs(30), rx)
        .await
        .map_err(|_| {
            state.pending_downloads.lock().unwrap().remove(&id);
            "file save timed out".to_string()
        })?
        .map_err(|_| "save channel closed".to_string())?
        .map_err(|e| e)?;

    Ok(())
}


// ---------------------------------------------------------------------------
// VPN commands
// ---------------------------------------------------------------------------

/// Connect the active venv's VPN using the given WireGuard configuration.
#[tauri::command]
pub async fn vpn_connect(
    config: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let vm_id = active_vm_id(&state)?;
    let vpn = {
        let vms = state.vms.lock().unwrap();
        let instance = vms.get(&vm_id).ok_or("no VM running")?;
        instance.vpn_state.clone().ok_or("VPN manager not initialized")?
    };
    vpn.connect(&config).await
}

/// Disconnect the active venv's VPN.
#[tauri::command]
pub async fn vpn_disconnect(state: State<'_, AppState>) -> Result<(), String> {
    let vm_id = active_vm_id(&state)?;
    let vpn = {
        let vms = state.vms.lock().unwrap();
        let instance = vms.get(&vm_id).ok_or("no VM running")?;
        instance.vpn_state.clone()
    };
    if let Some(vpn) = vpn {
        vpn.disconnect().await;
    }
    Ok(())
}

/// Get the VPN status for the active venv.
#[tauri::command]
pub async fn vpn_status(state: State<'_, AppState>) -> Result<clawcage_core::net::vpn::VpnState, String> {
    let vm_id = active_vm_id(&state)?;
    let vpn = {
        let vms = state.vms.lock().unwrap();
        let instance = vms.get(&vm_id).ok_or("no VM running")?;
        instance.vpn_state.clone()
    };
    match vpn {
        Some(vpn) => Ok(vpn.get_state().await),
        None => Ok(clawcage_core::net::vpn::VpnState::default()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AppState;
    use clawcage_core::session::SessionIndex;

    #[test]
    fn active_vm_id_returns_error_when_none() {
        let idx = SessionIndex::open_in_memory().unwrap();
        let state = AppState::new(idx);
        let result = active_vm_id(&state);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), "no active session");
    }

    #[test]
    fn active_vm_id_returns_id_when_set() {
        let idx = SessionIndex::open_in_memory().unwrap();
        let state = AppState::new(idx);
        *state.active_session_id.lock().unwrap() = Some("20260225-143052-a7f3".to_string());
        let result = active_vm_id(&state);
        assert_eq!(result.unwrap(), "20260225-143052-a7f3");
    }
}
