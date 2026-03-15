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
  DownloadProgress,
  GuestConfigResponse,
  NetworkPolicyResponse,
  ResolvedSetting,
  SessionInfo,
  SettingsNode,
  SettingValue,
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


export function serialInput(input: string): Promise<void> {
  return ensureDeps().then(() => isMock ? mockApi.serialInput(input) : tauriInvoke('serial_input', { input }));
}


export function terminalResize(cols: number, rows: number): Promise<void> {
  return ensureDeps().then(() => isMock ? mockApi.terminalResize(cols, rows) : tauriInvoke('terminal_resize', { cols, rows }));
}


/** Poll for terminal output. Returns bytes as a number array. */
export function terminalPoll(): Promise<number[]> {
  return ensureDeps().then(() => tauriInvoke<number[]>('terminal_poll'));
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


export function getSettings(): Promise<ResolvedSetting[]> {
  return ensureDeps().then(() => isMock ? mockApi.getSettings() : tauriInvoke<ResolvedSetting[]>('get_settings'));
}


export function getSettingsTree(): Promise<SettingsNode[]> {
  return ensureDeps().then(() => isMock ? mockApi.getSettingsTree() : tauriInvoke<SettingsNode[]>('get_settings_tree'));
}


export function lintConfig(): Promise<ConfigIssue[]> {
  return ensureDeps().then(() => isMock ? mockApi.lintConfig() : tauriInvoke<ConfigIssue[]>('lint_config'));
}


export function updateSetting(id: string, value: SettingValue): Promise<void> {
  return ensureDeps().then(() => isMock ? mockApi.updateSetting(id, value) : tauriInvoke('update_setting', { id, value }));
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
