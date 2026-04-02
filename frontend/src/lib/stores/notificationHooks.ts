// Central notification hooks — listens to backend events and triggers notifications.
// Call `startNotificationHooks()` once on app mount.
import { onVmStateChanged, onPortDetected, onPortClosed, onShellReady, type VmStateChangedPayload } from '../api';
import { notify } from './notifications';

const HIDDEN_PORTS = new Set([53, 10443]);
let initialized = false;

export function startNotificationHooks() {
  if (initialized) return;
  initialized = true;

  // Port detected — notify when a new user service starts listening.
  onPortDetected((port) => {
    if (HIDDEN_PORTS.has(port.port)) return;
    notify('Port Detected', `Port ${port.port} is now listening (${port.process})`, 'info');
  }).catch(() => {});

  // Port closed.
  onPortClosed(({ port }) => {
    if (HIDDEN_PORTS.has(port)) return;
    notify('Port Closed', `Port ${port} stopped listening`, 'info');
  }).catch(() => {});

  // VM state changes.
  onVmStateChanged((payload: VmStateChangedPayload) => {
    const state = payload.state.toLowerCase();
    if (state === 'running' && payload.trigger === 'boot_ready_received') {
      notify('Environment Ready', 'Your environment is now running', 'success');
    } else if (state === 'idle' && payload.trigger === 'vm_stopped') {
      notify('Environment Stopped', 'The environment has been stopped', 'info');
    } else if (state === 'error') {
      notify('Environment Error', `Environment encountered an error: ${payload.trigger}`, 'warning');
    }
  }).catch(() => {});

  // Shell ready — notify for non-default shells (new tabs).
  onShellReady(({ session_id }) => {
    if (session_id === 0) return; // Default shell, no notification needed.
    notify('Shell Ready', `Shell session ${session_id} is ready`, 'info');
  }).catch(() => {});
}
