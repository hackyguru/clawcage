// System metrics store -- tracks CPU, memory, and disk usage from the guest VM
import { useSyncExternalStore } from 'react';
import { getSystemMetrics, onSystemMetrics } from '../api';
import type { SystemMetrics } from '../types';

/** A timestamped metrics sample for charting. */
export interface MetricsSample {
  time: number; // unix ms
  cpu: number;
  memUsedPct: number;
  diskUsedPct: number;
}

const MAX_HISTORY = 60; // ~2 minutes at 2s intervals

let latest: SystemMetrics | null = null;
let history: MetricsSample[] = [];
let unlisten: (() => void) | null = null;
const listeners = new Set<() => void>();

let snapshot = buildSnapshot();

function buildSnapshot() {
  return { latest, history };
}

function emit() {
  snapshot = buildSnapshot();
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function pushSample(m: SystemMetrics) {
  latest = m;
  const sample: MetricsSample = {
    time: m.updated_at || Date.now(),
    cpu: m.cpu_percent,
    memUsedPct: m.mem_total_kb > 0 ? (m.mem_used_kb / m.mem_total_kb) * 100 : 0,
    diskUsedPct: m.disk_total_kb > 0 ? (m.disk_used_kb / m.disk_total_kb) * 100 : 0,
  };
  history = [...history.slice(-(MAX_HISTORY - 1)), sample];
  emit();
}

export function startSystemMetrics() {
  // Fetch initial snapshot.
  getSystemMetrics()
    .then((m) => { if (m.updated_at > 0) pushSample(m); })
    .catch(() => {});

  // Subscribe to real-time updates.
  onSystemMetrics((m) => pushSample(m))
    .then((fn) => { unlisten = fn; });
}

export function stopSystemMetrics() {
  if (unlisten) { unlisten(); unlisten = null; }
  latest = null;
  history = [];
  emit();
}

export function useSystemMetrics() {
  return useSyncExternalStore(subscribe, () => snapshot);
}
