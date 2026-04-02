// Ports store for React -- tracks detected and forwarded guest VM ports
import { useSyncExternalStore } from 'react';
import { getPorts, forwardPort as apiForward, stopForward as apiStop, onPortDetected, onPortClosed } from '../api';
import { showToast } from './toast';
import type { DetectedPort, ForwardedPort } from '../types';

let detected: DetectedPort[] = [];
let forwarded: ForwardedPort[] = [];
let loading = false;
let error: string | null = null;
let interval: ReturnType<typeof setInterval> | null = null;
let unlistenDetected: (() => void) | null = null;
let unlistenClosed: (() => void) | null = null;
const listeners = new Set<() => void>();

let snapshot = buildSnapshot();

function buildSnapshot() {
  return { detected, forwarded, loading, error };
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
    const res = await getPorts();
    detected = res.detected;
    forwarded = res.forwarded;
    error = null;
    emit();
  } catch (e) {
    console.error('Ports poll failed:', e);
    error = String(e);
    emit();
  }
}

export function startPorts() {
  loading = true;
  emit();
  poll().finally(() => {
    loading = false;
    emit();
  });
  interval = setInterval(poll, 2000);

  // Listen for real-time events
  onPortDetected((port) => {
    if (!detected.find((d) => d.port === port.port)) {
      detected = [...detected, port];
      emit();
    }
  }).then((fn) => { unlistenDetected = fn; });

  onPortClosed(({ port }) => {
    detected = detected.filter((d) => d.port !== port);
    forwarded = forwarded.filter((f) => f.guest_port !== port);
    emit();
  }).then((fn) => { unlistenClosed = fn; });
}

export function stopPorts() {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
  if (unlistenDetected) { unlistenDetected(); unlistenDetected = null; }
  if (unlistenClosed) { unlistenClosed(); unlistenClosed = null; }
  detected = [];
  forwarded = [];
  error = null;
  emit();
}

export async function forwardPortAction(guestPort: number, hostPort?: number) {
  try {
    const hp = await apiForward(guestPort, hostPort);
    forwarded = [...forwarded, { guest_port: guestPort, host_port: hp }];
    emit();
  } catch (e) {
    console.error('Forward port failed:', e);
    showToast('Failed to forward port: ' + String(e), 'error');
    error = String(e);
    emit();
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
    error = String(e);
    emit();
  }
}

/** Clear cached data and re-poll immediately. Call when switching venvs. */
export function refreshPorts() {
  detected = [];
  forwarded = [];
  emit();
  poll();
}

export function usePorts() {
  return useSyncExternalStore(subscribe, () => snapshot);
}
