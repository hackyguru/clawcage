// Central notification hooks — only notify for things that need user attention.
// Call `startNotificationHooks()` once on app mount.
import { onVmStateChanged, type VmStateChangedPayload } from '../api';
import { notify } from './notifications';

let initialized = false;

export function startNotificationHooks() {
  if (initialized) return;
  initialized = true;

  // Only notify on errors — everything else is visible in the UI already.
  onVmStateChanged((payload: VmStateChangedPayload) => {
    if (payload.state.toLowerCase() === 'error') {
      notify('Environment Error', `Something went wrong: ${payload.trigger}`, 'warning');
    }
  }).catch(() => {});
}
