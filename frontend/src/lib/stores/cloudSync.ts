// Global cloud sync state — persists across view switches.
import { useSyncExternalStore } from 'react';
import { onSnapshotProgress } from '../api';

interface CloudSyncState {
  /** ID of the venv currently syncing, or null. */
  syncingVenvId: string | null;
  /** Current sync phase. */
  phase: string;
  /** Bytes processed so far. */
  bytesProcessed: number;
  /** Total bytes. */
  totalBytes: number;
}

let state: CloudSyncState = {
  syncingVenvId: null,
  phase: '',
  bytesProcessed: 0,
  totalBytes: 0,
};

let listeners = new Set<() => void>();

function notify() {
  state = { ...state }; // new reference for useSyncExternalStore
  listeners.forEach((l) => l());
}

export function setSyncing(venvId: string | null) {
  state.syncingVenvId = venvId;
  if (!venvId) {
    state.phase = '';
    state.bytesProcessed = 0;
    state.totalBytes = 0;
  }
  notify();
}

export function useCloudSync(): CloudSyncState {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => state,
  );
}

// Start global listener once — survives view switches.
let started = false;
export function startCloudSyncListener() {
  if (started) return;
  started = true;

  onSnapshotProgress((p) => {
    if (p.operation === 'sync') {
      // Ensure syncingVenvId is set even if the caller forgot to call setSyncing()
      if (!state.syncingVenvId && p.venv_id) {
        state.syncingVenvId = p.venv_id;
      }
      state.phase = p.phase;
      state.bytesProcessed = p.bytes_processed;
      state.totalBytes = p.total_bytes;

      if (p.phase === 'done') {
        // Clear after a short delay so UI can show "done"
        setTimeout(() => setSyncing(null), 1500);
      }
      notify();
    }
  });
}
