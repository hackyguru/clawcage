// Processes store -- tracks all running guest VM processes
import { useSyncExternalStore } from 'react';
import { getProcesses, killProcess as apiKill, forwardPort as apiForward, stopForward as apiStop } from '../api';
import { showToast } from './toast';
import type { GuestProcess, ForwardedPort } from '../types';

let processes: GuestProcess[] = [];
let forwarded: ForwardedPort[] = [];
let loading = false;
let error: string | null = null;
let interval: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

let snapshot = buildSnapshot();

function buildSnapshot() {
  return { processes, forwarded, loading, error };
}

function emit() {
  snapshot = buildSnapshot();
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function poll() {
  try {
    const res = await getProcesses();
    processes = res.processes;
    forwarded = res.forwarded;
    error = null;
    emit();
  } catch (e) {
    console.error('Processes poll failed:', e);
    error = String(e);
    emit();
  }
}

export function startProcesses() {
  if (interval) return; // already running
  loading = true;
  emit();
  poll().finally(() => {
    loading = false;
    emit();
  });
  interval = setInterval(poll, 3000);
}

export function stopProcesses() {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
  processes = [];
  forwarded = [];
  error = null;
  emit();
}

export async function killProcessAction(pid: number) {
  try {
    await apiKill(pid);
    processes = processes.filter((p) => p.pid !== pid);
    emit();
    showToast(`Process ${pid} killed`, 'success', 2000);
  } catch (e) {
    console.error('Kill process failed:', e);
    showToast('Failed to kill process: ' + String(e), 'error');
  }
}

export async function forwardPortAction(guestPort: number, hostPort?: number) {
  try {
    const hp = await apiForward(guestPort, hostPort);
    forwarded = [...forwarded, { guest_port: guestPort, host_port: hp }];
    emit();
  } catch (e) {
    console.error('Forward port failed:', e);
    showToast('Failed to forward port: ' + String(e), 'error');
  }
}

export async function stopForwardAction(guestPort: number) {
  try {
    await apiStop(guestPort);
    forwarded = forwarded.filter((f) => f.guest_port !== guestPort);
    emit();
  } catch (e) {
    console.error('Stop forward failed:', e);
    showToast('Failed to stop port forward: ' + String(e), 'error');
  }
}

/** Clear cached data and re-poll immediately. Call when switching venvs. */
export function refreshProcesses() {
  processes = [];
  forwarded = [];
  emit();
  poll();
}

export function useProcesses() {
  return useSyncExternalStore(subscribe, () => snapshot);
}
