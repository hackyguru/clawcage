// Notification system: in-app toasts + native OS notifications when window is hidden.
// Uses the existing toast system for foreground, Tauri notification plugin for background.
import { showToast } from './toast';

let nativeAvailable = false;
let sendNotification: ((opts: { title: string; body: string }) => void) | null = null;

// Lazy-init the native notification API (only in Tauri, not browser mock mode).
async function initNative() {
  if (nativeAvailable || sendNotification) return;
  try {
    const mod = await import('@tauri-apps/plugin-notification');
    const perm = await mod.isPermissionGranted();
    if (!perm) {
      await mod.requestPermission();
    }
    sendNotification = (opts) => mod.sendNotification(opts);
    nativeAvailable = true;
  } catch {
    // Not in Tauri (browser dev mode) — native notifications unavailable.
  }
}

// Initialize on first import.
initNative();

/**
 * Show a notification. In-app toast always shown.
 * Native OS notification sent when the app window is likely hidden (tray mode).
 */
export function notify(title: string, body: string, level: 'info' | 'success' | 'warning' = 'info') {
  // Always show in-app toast.
  showToast(body, level, 5000);

  // Also send native notification if available (reaches user even when window is hidden).
  if (sendNotification && document.hidden) {
    sendNotification({ title: `Clawcage: ${title}`, body });
  }
}
