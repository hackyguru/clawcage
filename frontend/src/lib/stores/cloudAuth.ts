// Global cloud auth state — shared between TitleBar, CloudView, and HomeView.
import { useSyncExternalStore } from 'react';
import { cloudStatus } from '../api';

interface CloudAuthState {
  connected: boolean;
  email: string | null;
  plan: string;
}

let state: CloudAuthState = { connected: false, email: null, plan: 'free' };
let listeners = new Set<() => void>();

function notify() {
  state = { ...state };
  listeners.forEach((l) => l());
}

export function setCloudAuth(s: CloudAuthState) {
  state = { ...s };
  notify();
}

export function useCloudAuth(): CloudAuthState {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => state,
  );
}

/** Fetch cloud status and update the global store. */
export async function refreshCloudAuth() {
  try {
    const s = await cloudStatus();
    setCloudAuth({ connected: s.connected, email: s.connected ? s.email : null, plan: s.plan });
  } catch {
    setCloudAuth({ connected: false, email: null, plan: 'free' });
  }
}

// Initial fetch on import
refreshCloudAuth();
