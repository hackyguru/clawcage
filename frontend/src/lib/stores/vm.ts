// VM state store for React
import { useSyncExternalStore } from 'react';
import { vmStatus, onVmStateChanged, onDownloadProgress } from '../api';
import type { DownloadProgress } from '../types';

let vmState = 'not created';
let downloadProgress: DownloadProgress | null = null;
let terminalRenderer: 'webgl' | 'canvas' | '' = '';
const listeners = new Set<() => void>();

// Cached snapshot – only replaced on emit()
let snapshot = buildSnapshot();

function buildSnapshot() {
  return {
    vmState,
    downloadProgress,
    terminalRenderer,
    isRunning: vmState === 'running',
    isDownloading: vmState === 'downloading',
  };
}

function emit() {
  snapshot = buildSnapshot();
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

import { showToast } from './toast';
import { resetShells } from './shells';
import { getActiveVenv } from './venvs';
export async function initVm() {
  try {
    vmState = (await vmStatus()).toLowerCase();
  } catch (e) {
    // No active VM is normal on startup (user picks a venv first).
    console.warn('vmStatus() init failed (falling back to idle):', e);
    vmState = 'idle';
  }
  emit();
  onVmStateChanged((payload) => {
    const s = payload.state.toLowerCase();
    // For idle (vm stopped), only reset if it's the focused venv.
    // Other venvs stopping shouldn't affect the current view.
    if (s === 'idle' || s === 'not created') {
      const focused = getActiveVenv();
      if (!payload.venv_id || !focused || payload.venv_id === focused.id) {
        vmState = s;
        resetShells();
        emit();
      }
    } else {
      vmState = s;
      emit();
    }
  });
  onDownloadProgress((progress) => {
    downloadProgress = progress;
    emit();
  });
}

export function setTerminalRenderer(r: 'webgl' | 'canvas' | '') {
  terminalRenderer = r;
  emit();
}

export function useVm() {
  return useSyncExternalStore(subscribe, () => snapshot);
}
