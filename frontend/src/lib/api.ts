// Typed Tauri IPC wrappers with automatic mock fallback for browser dev.
let invoke: typeof import('@tauri-apps/api/core').invoke;
let listen: typeof import('@tauri-apps/api/event').listen;
let isMock: boolean;
let mockApi: any;

async function ensureDeps() {
  if (!invoke) invoke = (await import('@tauri-apps/api/core')).invoke;
  if (!listen) listen = (await import('@tauri-apps/api/event')).listen;
  if (isMock === undefined || mockApi === undefined) {
    const mock = await import('./mock');
    isMock = mock.isMock;
    mockApi = mock.mockApi;
  }
}
import type {
  ConfigIssue,
  DetectedPort,
  DirEntry,
  DownloadProgress,
  FileDownloadProgress,
  ForwardedPort,
  GuestConfigResponse,
  NetworkPolicyResponse,
  PortsResponse,
  ProcessesResponse,
  ResolvedSetting,
  SessionInfo,
  SettingsNode,
  SettingValue,
  QueryResult,
  SystemMetrics,
  VenvInfo,
  VenvConnectionStatus,
  CreateRemoteSessionResponse,
  VmStateResponse,
} from './types';


type UnlistenFn = () => void;


async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  await ensureDeps();
  return invoke<T>(cmd, args);
}


async function tauriListen<T>(
  event: string,
  callback: (payload: T) => void,
): Promise<UnlistenFn> {
  await ensureDeps();
  return listen<T>(event, (e) => callback(e.payload));
}

// ---------------------------------------------------------------------------
// Invoke wrappers (non-SQL commands only)
// ---------------------------------------------------------------------------


export function vmStatus(): Promise<string> {
  return ensureDeps().then(() => isMock ? mockApi.vmStatus() : tauriInvoke<string>('vm_status'));
}


export function serialInput(input: string, sessionId?: number): Promise<void> {
  return ensureDeps().then(() => isMock ? mockApi.serialInput(input) : tauriInvoke('serial_input', { input, sessionId }));
}


export function terminalResize(cols: number, rows: number, sessionId?: number): Promise<void> {
  return ensureDeps().then(() => isMock ? mockApi.terminalResize(cols, rows) : tauriInvoke('terminal_resize', { cols, rows, sessionId }));
}


/** Poll for terminal output for a specific shell session. Returns bytes as a number array. */
export function terminalPoll(sessionId?: number): Promise<number[]> {
  return ensureDeps().then(() => tauriInvoke<number[]>('terminal_poll', { sessionId }));
}


/** Spawn a new shell session in the VM. */
export function spawnShell(sessionId: number): Promise<void> {
  return ensureDeps().then(() => isMock ? mockApi.spawnShell(sessionId) : tauriInvoke('spawn_shell', { sessionId }));
}

/** Close a shell session in the VM. */
export function closeShell(sessionId: number): Promise<void> {
  return ensureDeps().then(() => isMock ? mockApi.closeShell(sessionId) : tauriInvoke('close_shell', { sessionId }));
}

/** List active shell session IDs. */
export function listShells(): Promise<number[]> {
  return ensureDeps().then(() => isMock ? mockApi.listShells() : tauriInvoke<number[]>('list_shells'));
}


export function getGuestConfig(): Promise<GuestConfigResponse> {
  return ensureDeps().then(() => isMock ? mockApi.getGuestConfig() : tauriInvoke<GuestConfigResponse>('get_guest_config'));
}


export function getNetworkPolicy(): Promise<NetworkPolicyResponse> {
  return ensureDeps().then(() => isMock ? mockApi.getNetworkPolicy() : tauriInvoke<NetworkPolicyResponse>('get_network_policy'));
}


export function setGuestEnv(key: string, value: string): Promise<void> {
  return ensureDeps().then(() => isMock ? mockApi.setGuestEnv(key, value) : tauriInvoke('set_guest_env', { key, value }));
}


export function removeGuestEnv(key: string): Promise<void> {
  return ensureDeps().then(() => isMock ? mockApi.removeGuestEnv(key) : tauriInvoke('remove_guest_env', { key }));
}


export function getSettings(venvId?: string): Promise<ResolvedSetting[]> {
  return ensureDeps().then(() => isMock ? mockApi.getSettings() : tauriInvoke<ResolvedSetting[]>('get_settings', { venvId }));
}


export function getSettingsTree(venvId?: string): Promise<SettingsNode[]> {
  return ensureDeps().then(() => isMock ? mockApi.getSettingsTree() : tauriInvoke<SettingsNode[]>('get_settings_tree', { venvId }));
}


export function lintConfig(venvId?: string): Promise<ConfigIssue[]> {
  return ensureDeps().then(() => isMock ? mockApi.lintConfig() : tauriInvoke<ConfigIssue[]>('lint_config', { venvId }));
}


export function updateSetting(id: string, value: SettingValue, venvId?: string): Promise<void> {
  return ensureDeps().then(() => isMock ? mockApi.updateSetting(id, value) : tauriInvoke('update_setting', { id, value, venvId }));
}


export function resetVenvSetting(venvId: string, id: string): Promise<void> {
  return ensureDeps().then(() => isMock ? mockApi.resetVenvSetting(venvId, id) : tauriInvoke('reset_venv_setting', { venvId, id }));
}


export function getVmState(): Promise<VmStateResponse> {
  return ensureDeps().then(() => isMock ? mockApi.getVmState() : tauriInvoke<VmStateResponse>('get_vm_state'));
}


export function getSessionInfo(): Promise<SessionInfo> {
  return ensureDeps().then(() => isMock ? mockApi.getSessionInfo() : tauriInvoke<SessionInfo>('get_session_info'));
}

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------

/** vm-state-changed payload is { state: string, trigger: string, venv_id?: string }. */
export interface VmStateChangedPayload {
  state: string;
  trigger: string;
  venv_id?: string;
}


export function onSerialOutput(
  callback: (data: number[]) => void,
): Promise<UnlistenFn> {
  return ensureDeps().then(() => isMock ? mockApi.onSerialOutput(callback) : tauriListen<number[]>('serial-output', callback));
}


export function onVmStateChanged(
  callback: (payload: VmStateChangedPayload) => void,
): Promise<UnlistenFn> {
  return ensureDeps().then(() => isMock ? mockApi.onVmStateChanged(callback) : tauriListen<VmStateChangedPayload>('vm-state-changed', callback));
}


export function onTerminalSourceChanged(
  callback: (source: string) => void,
): Promise<UnlistenFn> {
  return ensureDeps().then(() => isMock ? mockApi.onTerminalSourceChanged(callback) : tauriListen<string>('terminal-source-changed', callback));
}


export function onDownloadProgress(
  callback: (progress: DownloadProgress) => void,
): Promise<UnlistenFn> {
  return ensureDeps().then(() => isMock ? mockApi.onDownloadProgress(callback) : tauriListen<DownloadProgress>('download-progress', callback));
}


export function onFileDownloadProgress(
  callback: (progress: FileDownloadProgress) => void,
): Promise<UnlistenFn> {
  return ensureDeps().then(() => isMock ? mockApi.onFileDownloadProgress(callback) : tauriListen<FileDownloadProgress>('file-download-progress', callback));
}


export function onShellReady(
  callback: (data: { session_id: number }) => void,
): Promise<UnlistenFn> {
  return ensureDeps().then(() => isMock ? mockApi.onShellReady(callback) : tauriListen<{ session_id: number }>('shell-ready', callback));
}

export function onShellClosed(
  callback: (data: { session_id: number; exit_code: number }) => void,
): Promise<UnlistenFn> {
  return ensureDeps().then(() => isMock ? mockApi.onShellClosed(callback) : tauriListen<{ session_id: number; exit_code: number }>('shell-closed', callback));
}

// ---------------------------------------------------------------------------
// Venv (virtual environment) management
// ---------------------------------------------------------------------------

/** Tell the backend which venv the user is currently viewing. */
export function focusVenv(id: string | null): Promise<void> {
  return ensureDeps().then(() => isMock ? Promise.resolve() : tauriInvoke<void>('focus_venv', { id }));
}

export function listVenvs(): Promise<VenvInfo[]> {
  return ensureDeps().then(() => isMock ? mockApi.listVenvs() : tauriInvoke<VenvInfo[]>('list_venvs'));
}

// ─── Remote mode ──────────────────────────────────────────────────────────

/** Get the connection mode (Local / Detaching / Remote / Reattaching) for a venv. */
export function getVenvConnection(venvId: string): Promise<VenvConnectionStatus> {
  return ensureDeps().then(() =>
    isMock
      ? Promise.resolve({ venv_id: venvId, mode: { type: 'local' as const } })
      : tauriInvoke<VenvConnectionStatus>('get_venv_connection', { venvId }),
  );
}

/** Bulk lookup of connection modes for many venvs (used for sidebar badges). */
export function listVenvConnections(venvIds: string[]): Promise<VenvConnectionStatus[]> {
  return ensureDeps().then(() =>
    isMock
      ? Promise.resolve(venvIds.map((id) => ({ venv_id: id, mode: { type: 'local' as const } })))
      : tauriInvoke<VenvConnectionStatus[]>('list_venv_connections', { venvIds }),
  );
}

/**
 * Detach a venv to remote mode.
 *
 * The desktop handles the full E2E flow internally: mints a per-session
 * AES key, encrypts the venv archive, uploads to R2, provisions the VPS.
 * Returns the new connection status (mode will be Remote on success,
 * Local on rollback).
 */
export function detachVenv(args: {
  venvId: string;
  venvName: string;
  location?: string;
  serverType?: string;
}): Promise<VenvConnectionStatus> {
  return ensureDeps().then(() =>
    tauriInvoke<VenvConnectionStatus>('detach_venv', {
      venvId: args.venvId,
      venvName: args.venvName,
      location: args.location,
      serverType: args.serverType,
    }),
  );
}

/** Reattach a venv from remote back to local. Tears down the VPS + SSH key. */
export function reattachVenv(venvId: string): Promise<VenvConnectionStatus> {
  return ensureDeps().then(() => tauriInvoke<VenvConnectionStatus>('reattach_venv', { venvId }));
}

/**
 * Open a Terminal.app window with `ssh -t root@<vps> "tmux attach -t <venv>"`.
 * V1 UX: external Terminal.app rather than embedded xterm.js.
 */
export function openRemoteTerminal(venvId: string, venvName: string): Promise<void> {
  return ensureDeps().then(() => tauriInvoke<void>('open_remote_terminal', { venvId, venvName }));
}

/**
 * Provision a remote session via the cloud API (low-level; normal callers
 * use `detachVenv`, which handles keypair, encryption, and upload).
 */
export function createRemoteSession(args: {
  venvName: string;
  snapshotPath: string;
  publicKey: string;
  sessionKeyB64: string;
  location?: string;
  serverType?: string;
}): Promise<CreateRemoteSessionResponse> {
  return ensureDeps().then(() =>
    tauriInvoke<CreateRemoteSessionResponse>('create_remote_session', {
      venvName: args.venvName,
      snapshotPath: args.snapshotPath,
      publicKey: args.publicKey,
      sessionKeyB64: args.sessionKeyB64,
      location: args.location,
      serverType: args.serverType,
    }),
  );
}

export function createVenv(name: string, ephemeral: boolean, template: string = 'blank'): Promise<VenvInfo> {
  return ensureDeps().then(() => isMock ? mockApi.createVenv(name, ephemeral, template) : tauriInvoke<VenvInfo>('create_venv', { name, ephemeral, template }));
}

export function saveVenvFile(id: string, filename: string, content: string): Promise<void> {
  return ensureDeps().then(() => isMock ? Promise.resolve() : tauriInvoke<void>('save_venv_file', { id, filename, content }));
}

export function renameVenv(id: string, name: string): Promise<void> {
  return ensureDeps().then(() => isMock ? Promise.resolve() : tauriInvoke<void>('rename_venv', { id, name }));
}

export function setVenvIcon(id: string, iconData: string | null): Promise<void> {
  return ensureDeps().then(() => isMock ? Promise.resolve() : tauriInvoke<void>('set_venv_icon', { id, iconData }));
}

export function deleteVenv(id: string): Promise<void> {
  return ensureDeps().then(() => isMock ? mockApi.deleteVenv(id) : tauriInvoke<void>('delete_venv', { id }));
}

export function startVenv(id: string): Promise<void> {
  return ensureDeps().then(() => isMock ? mockApi.startVenv(id) : tauriInvoke<void>('start_venv', { id }));
}

export function stopVenv(id: string): Promise<void> {
  return ensureDeps().then(() => isMock ? mockApi.stopVenv(id) : tauriInvoke<void>('stop_venv', { id }));
}

// ---------------------------------------------------------------------------
// Port forwarding
// ---------------------------------------------------------------------------

export function getPorts(): Promise<PortsResponse> {
  return ensureDeps().then(() => isMock ? mockApi.getPorts() : tauriInvoke<PortsResponse>('get_ports'));
}

export function forwardPort(guestPort: number, hostPort?: number): Promise<number> {
  return ensureDeps().then(() => isMock ? mockApi.forwardPort(guestPort, hostPort) : tauriInvoke<number>('forward_port', { guestPort, hostPort }));
}

export function startBrowserProxy(guestPort: number): Promise<number> {
  return ensureDeps().then(() => isMock ? Promise.resolve(guestPort) : tauriInvoke<number>('start_browser_proxy', { guestPort }));
}

export function stopBrowserProxy(guestPort: number): Promise<void> {
  return ensureDeps().then(() => isMock ? Promise.resolve() : tauriInvoke<void>('stop_browser_proxy', { guestPort }));
}

export function stopForward(guestPort: number): Promise<void> {
  return ensureDeps().then(() => isMock ? mockApi.stopForward(guestPort) : tauriInvoke<void>('stop_forward', { guestPort }));
}

// ---------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------

export function getProcesses(): Promise<ProcessesResponse> {
  return ensureDeps().then(() => isMock ? mockApi.getProcesses() : tauriInvoke<ProcessesResponse>('get_processes'));
}

export function killProcess(pid: number): Promise<void> {
  return ensureDeps().then(() => isMock ? mockApi.killProcess(pid) : tauriInvoke<void>('kill_process', { pid }));
}

export function onPortDetected(callback: (port: DetectedPort) => void): Promise<UnlistenFn> {
  return ensureDeps().then(() => isMock ? mockApi.onPortDetected(callback) : tauriListen<DetectedPort>('port-detected', callback));
}

export function onPortClosed(callback: (data: { port: number }) => void): Promise<UnlistenFn> {
  return ensureDeps().then(() => isMock ? mockApi.onPortClosed(callback) : tauriListen<{ port: number }>('port-closed', callback));
}

// ---------------------------------------------------------------------------
// System metrics
// ---------------------------------------------------------------------------

export function getSystemMetrics(): Promise<SystemMetrics> {
  return ensureDeps().then(() => isMock ? mockApi.getSystemMetrics() : tauriInvoke<SystemMetrics>('system_metrics'));
}

export function getVenvMetrics(venvId: string): Promise<SystemMetrics> {
  return ensureDeps().then(() => isMock ? mockApi.getSystemMetrics() : tauriInvoke<SystemMetrics>('venv_metrics', { venvId }));
}

export function onSystemMetrics(callback: (metrics: SystemMetrics) => void): Promise<UnlistenFn> {
  return ensureDeps().then(() => isMock ? mockApi.onSystemMetrics(callback) : tauriListen<SystemMetrics>('system-metrics', callback));
}

// ---------------------------------------------------------------------------
// File operations (guest VM)
// ---------------------------------------------------------------------------

/** Download a file from the guest VM to a host path. */
export function downloadFile(guestPath: string, hostPath: string): Promise<void> {
  return ensureDeps().then(() => isMock ? mockApi.downloadFile(guestPath, hostPath) : tauriInvoke('download_file', { guestPath, hostPath }));
}

export interface SnapshotProgress {
  operation: string;
  venv_id: string;
  phase: string;
  bytes_processed: number;
  total_bytes: number;
}

export function onSnapshotProgress(callback: (progress: SnapshotProgress) => void): Promise<UnlistenFn> {
  return ensureDeps().then(() => isMock ? Promise.resolve(() => {}) : tauriListen<SnapshotProgress>('snapshot-progress', callback));
}

// ---------------------------------------------------------------------------
// Snapshots, Clone, Export/Import
// ---------------------------------------------------------------------------

export function cloneVenv(sourceVenvId: string, newName: string): Promise<VenvInfo> {
  return ensureDeps().then(() => isMock ? Promise.reject('not in mock') : tauriInvoke<VenvInfo>('clone_venv', { sourceVenvId, newName }));
}

export function exportVenv(venvId: string, destPath: string): Promise<void> {
  return ensureDeps().then(() => isMock ? Promise.resolve() : tauriInvoke<void>('export_venv', { venvId, destPath }));
}

export function importVenv(sourcePath: string, newName?: string): Promise<VenvInfo> {
  return ensureDeps().then(() => isMock ? Promise.reject('not in mock') : tauriInvoke<VenvInfo>('import_venv', { sourcePath, newName: newName ?? null }));
}

// ---------------------------------------------------------------------------
// Cloud
// ---------------------------------------------------------------------------

export function cloudConnect(token: string, email?: string, cloudUrl?: string): Promise<void> {
  return ensureDeps().then(() => isMock ? Promise.resolve() : tauriInvoke('cloud_connect', { token, email: email ?? null, cloudUrl: cloudUrl ?? null }));
}

export function cloudLogin(cloudUrl?: string): Promise<{ connected: boolean; email: string | null; plan: string }> {
  return ensureDeps().then(() => isMock ? Promise.resolve({ connected: true, email: 'test@example.com', plan: 'free' }) : tauriInvoke('cloud_login', { cloudUrl: cloudUrl ?? null }));
}

export function cloudDisconnect(): Promise<void> {
  return ensureDeps().then(() => isMock ? Promise.resolve() : tauriInvoke('cloud_disconnect'));
}

export function cloudStatus(): Promise<{ connected: boolean; email: string | null; plan: string }> {
  return ensureDeps().then(() => isMock ? Promise.resolve({ connected: false, email: null, plan: 'free' }) : tauriInvoke('cloud_status'));
}

export function cloudSyncVenv(venvId: string): Promise<void> {
  return ensureDeps().then(() => isMock ? Promise.resolve() : tauriInvoke('cloud_sync_venv', { venvId }));
}

export function cloudBackupKey(): Promise<void> {
  return ensureDeps().then(() => isMock ? Promise.resolve() : tauriInvoke('cloud_backup_key'));
}

export function cloudExportKey(): Promise<string> {
  return ensureDeps().then(() => isMock ? Promise.resolve('mock-key') : tauriInvoke('cloud_export_key'));
}

export function cloudListSnapshots(): Promise<{
  venv_name: string;
  synced_at: string;
  file_size_bytes: number;
  /** R2 object key; needed by detach_venv to locate the snapshot. */
  file_path?: string;
  id?: string;
}[]> {
  return ensureDeps().then(() => isMock ? Promise.resolve([]) : tauriInvoke('cloud_list_snapshots'));
}

export function cloudRestoreSnapshot(snapshotId: string): Promise<unknown> {
  return ensureDeps().then(() => isMock ? Promise.resolve({}) : tauriInvoke('cloud_restore_snapshot', { snapshotId }));
}

export function cloudSetAutoSync(enabled: boolean): Promise<void> {
  return ensureDeps().then(() => isMock ? Promise.resolve() : tauriInvoke('cloud_set_auto_sync', { enabled }));
}

export function cloudGetAutoSync(): Promise<{ enabled: boolean; last_sync: string | null }> {
  return ensureDeps().then(() => isMock ? Promise.resolve({ enabled: false, last_sync: null }) : tauriInvoke('cloud_get_auto_sync'));
}

export function cloudOpenPortal(): Promise<void> {
  return ensureDeps().then(() => isMock ? Promise.resolve() : tauriInvoke('cloud_open_portal'));
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

export function openExternal(url: string): Promise<void> {
  return ensureDeps().then(() => isMock ? Promise.resolve(void window.open(url, '_blank')) : tauriInvoke('open_external', { url }));
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/** List all Clawcage storage entries with sizes. */
export function listStorage(): Promise<{ path: string; name: string; size_bytes: number; actual_bytes: number; kind: string; deletable: boolean }[]> {
  return ensureDeps().then(() => isMock ? Promise.resolve([]) : tauriInvoke('list_storage'));
}

/** Delete a storage entry by path. */
export function deleteStorage(path: string): Promise<void> {
  return ensureDeps().then(() => isMock ? Promise.resolve() : tauriInvoke('delete_storage', { path }));
}

/** Returns available host disk space in bytes. */
export function hostDiskFree(): Promise<number> {
  return ensureDeps().then(() => isMock ? Promise.resolve(100 * 1024 * 1024 * 1024) : tauriInvoke<number>('host_disk_free'));
}

/** List directory contents in the guest VM. */
export function listDir(guestPath: string): Promise<DirEntry[]> {
  return ensureDeps().then(() => isMock ? mockApi.listDir(guestPath) : tauriInvoke<DirEntry[]>('list_dir', { guestPath }));
}

/** Read a file from the guest VM and return its content as a string. */
export function readFile(guestPath: string): Promise<string> {
  return ensureDeps().then(() => isMock ? mockApi.readFile(guestPath) : tauriInvoke<string>('read_file', { guestPath }));
}

/** Save file content back to the guest VM. */
export function saveFile(guestPath: string, content: string): Promise<void> {
  return ensureDeps().then(() => isMock ? mockApi.saveFile(guestPath, content) : tauriInvoke('save_file', { guestPath, content }));
}

// ---------------------------------------------------------------------------
// VPN
// ---------------------------------------------------------------------------

export interface VpnState {
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  error: string | null;
  endpoint: string | null;
  tunnel_ip: string | null;
}

/** Connect the active venv's VPN with a WireGuard config. */
export function vpnConnect(config: string): Promise<void> {
  return ensureDeps().then(() => isMock ? mockApi.vpnConnect(config) : tauriInvoke('vpn_connect', { config }));
}

/** Disconnect the active venv's VPN. */
export function vpnDisconnect(): Promise<void> {
  return ensureDeps().then(() => isMock ? mockApi.vpnDisconnect() : tauriInvoke('vpn_disconnect'));
}

/** Get the VPN status for the active venv. */
export function vpnStatus(): Promise<VpnState> {
  return ensureDeps().then(() => isMock ? mockApi.vpnStatus() : tauriInvoke<VpnState>('vpn_status'));
}

// ---------------------------------------------------------------------------
// App updates
// ---------------------------------------------------------------------------

export interface UpdateInfo {
  version: string;
  notes: string;
}

export interface UpdateProgress {
  downloaded: number;
  total: number | null;
}

export function onUpdateAvailable(callback: (info: UpdateInfo) => void): Promise<UnlistenFn> {
  return ensureDeps().then(() => isMock ? mockApi.onUpdateAvailable(callback) : tauriListen<UpdateInfo>('update-available', callback));
}

export function onUpdateProgress(callback: (progress: UpdateProgress) => void): Promise<UnlistenFn> {
  return ensureDeps().then(() => isMock ? mockApi.onUpdateProgress(callback) : tauriListen<UpdateProgress>('update-progress', callback));
}

export function installUpdate(): Promise<void> {
  return ensureDeps().then(() => isMock ? mockApi.installUpdate() : tauriInvoke('install_update'));
}

// ---------------------------------------------------------------------------
// Session DB queries
// ---------------------------------------------------------------------------

/** Run a SELECT query against the session DB (or fixture in mock mode). */
export async function queryDb(sql: string, db?: string, params?: unknown[]): Promise<QueryResult> {
  await ensureDeps();
  if (isMock) {
    const { queryFixture, queryFixtureMain } = await import('./mock');
    return db === 'main' ? queryFixtureMain(sql, params) : queryFixture(sql, params);
  }
  const raw = await tauriInvoke<string>('query_db', { sql, db, params });
  return JSON.parse(raw);
}


