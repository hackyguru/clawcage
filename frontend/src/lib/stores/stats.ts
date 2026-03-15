// Stats store for React
import { useSyncExternalStore } from 'react';
import { queryDb, queryOne } from '../db';
import { MODEL_STATS_SQL, TOOL_COUNT_SQL } from '../sql';
import type { ModelStatsRow, StatsTab } from '../types';

let modelStats: ModelStatsRow | null = null;
let toolCount = 0;
let activeTab: StatsTab = 'ai';
let interval: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

// Cached snapshot – only replaced on emit()
let snapshot = buildSnapshot();

function buildSnapshot() {
  return {
    modelStats,
    toolCount,
    activeTab,
    totalTokens: modelStats
      ? formatTokens(modelStats.total_input_tokens + modelStats.total_output_tokens)
      : '--',
    totalCost: modelStats ? formatCost(modelStats.total_cost) : '--',
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

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

function formatCost(n: number): string {
  if (n < 0.01 && n > 0) return '<$0.01';
  return '$' + n.toFixed(2);
}

async function poll() {
  try {
    const [statsResult, toolResult] = await Promise.all([
      queryDb(MODEL_STATS_SQL),
      queryDb(TOOL_COUNT_SQL),
    ]);
    modelStats = queryOne<ModelStatsRow>(statsResult);
    const toolRow = queryOne<{ cnt: number }>(toolResult);
    toolCount = toolRow?.cnt ?? 0;
    emit();
  } catch (e) {
    console.error('Stats poll failed:', e);
  }
}

export function startStats() {
  poll();
  interval = setInterval(poll, 2000);
}

export function stopStats() {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}

export function setStatsTab(tab: StatsTab) {
  activeTab = tab;
  emit();
}

export function useStats() {
  return useSyncExternalStore(subscribe, () => snapshot);
}
