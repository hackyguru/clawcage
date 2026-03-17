// Virtual environment store for React
import { useSyncExternalStore } from 'react';
import { listVenvs, createVenv as apiCreateVenv, deleteVenv as apiDeleteVenv, startVenv as apiStartVenv, stopVenv as apiStopVenv } from '../api';
import { showToast } from './toast';
import type { VenvInfo } from '../types';

let venvs: VenvInfo[] = [];
let activeVenvId: string | null = null;
let loading = false;
const listeners = new Set<() => void>();

let snapshot = buildSnapshot();

function buildSnapshot() {
  const active = activeVenvId ? venvs.find((v) => v.id === activeVenvId) ?? null : null;
  return { venvs, activeVenvId, activeVenv: active, loading };
}

function emit() {
  snapshot = buildSnapshot();
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function loadVenvs() {
  loading = true;
  emit();
  try {
    venvs = await listVenvs();
  } catch (e) {
    console.error('Failed to load venvs:', e);
    showToast('Failed to load environments: ' + String(e), 'error');
  }
  loading = false;
  emit();
}

export async function createVenvAction(name: string, ephemeral: boolean = false, template: string = 'blank'): Promise<VenvInfo | null> {
  try {
    const v = await apiCreateVenv(name, ephemeral, template);
    venvs = [...venvs, v];
    emit();
    return v;
  } catch (e) {
    console.error('Failed to create venv:', e);
    showToast('Failed to create environment: ' + String(e), 'error');
    return null;
  }
}

export async function deleteVenvAction(id: string) {
  try {
    await apiDeleteVenv(id);
    venvs = venvs.filter((v) => v.id !== id);
    if (activeVenvId === id) activeVenvId = null;
    emit();
  } catch (e) {
    console.error('Failed to delete venv:', e);
    showToast('Failed to delete environment: ' + String(e), 'error');
  }
}

export async function startVenvAction(id: string) {
  // Mark any currently-running venv as stopped (only one VM can run at a time).
  for (const v of venvs) {
    if (v.id !== id && (v.status === 'running' || v.status === 'booting')) {
      v.status = 'stopped';
    }
  }

  const target = venvs.find((v) => v.id === id);
  if (target) {
    target.status = 'booting';
  }
  activeVenvId = id;
  emit();

  try {
    await apiStartVenv(id);
    if (target) {
      target.status = 'running';
      target.last_used = new Date().toISOString();
    }
    emit();
  } catch (e) {
    if (target) {
      target.status = 'error';
    }
    emit();
    console.error('Failed to start venv:', e);
    showToast('Failed to start environment: ' + String(e), 'error');
  }

  // Reload from backend to get authoritative state for all venvs.
  try {
    venvs = await listVenvs();
    emit();
  } catch { /* ignore */ }
}

export async function stopVenvAction(id: string) {
  // Optimistic update.
  const v = venvs.find((v) => v.id === id);
  if (v) {
    v.status = 'stopped';
    emit();
  }

  try {
    await apiStopVenv(id);
  } catch (e) {
    console.error('Failed to stop venv:', e);
    showToast('Failed to stop environment: ' + String(e), 'error');
  }

  // Reload from backend.
  try {
    venvs = await listVenvs();
    emit();
  } catch { /* ignore */ }
}

export function openVenv(id: string) {
  activeVenvId = id;
  emit();
}

export function closeVenv() {
  activeVenvId = null;
  emit();
}

export function useVenvs() {
  return useSyncExternalStore(subscribe, () => snapshot);
}
