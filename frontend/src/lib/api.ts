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

/** vm-state-changed payload is { state: string, trigger: string }. */
interface VmStateChangedPayload {
  state: string;
  trigger: string;
}


export function onSerialOutput(
  callback: (data: number[]) => void,
): Promise<UnlistenFn> {
  return ensureDeps().then(() => isMock ? mockApi.onSerialOutput(callback) : tauriListen<number[]>('serial-output', callback));
}


export function onVmStateChanged(
  callback: (state: string) => void,
): Promise<UnlistenFn> {
  return ensureDeps().then(() => isMock ? mockApi.onVmStateChanged(callback) : tauriListen<VmStateChangedPayload>('vm-state-changed', (payload) => callback(payload.state)));
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

export function listVenvs(): Promise<VenvInfo[]> {
  return ensureDeps().then(() => isMock ? mockApi.listVenvs() : tauriInvoke<VenvInfo[]>('list_venvs'));
}

export function createVenv(name: string, ephemeral: boolean, template: string = 'blank'): Promise<VenvInfo> {
  return ensureDeps().then(() => isMock ? mockApi.createVenv(name, ephemeral, template) : tauriInvoke<VenvInfo>('create_venv', { name, ephemeral, template }));
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


