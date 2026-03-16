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
export async function initVm() {
  try {
    vmState = (await vmStatus()).toLowerCase();
  } catch {
    // No active VM is normal on startup (user picks a venv first).
    vmState = 'idle';
  }
  emit();
  onVmStateChanged((state) => {
    vmState = state.toLowerCase();
    emit();
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
