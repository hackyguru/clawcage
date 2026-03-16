// Settings store for React
import { useSyncExternalStore } from 'react';
import { getSettingsTree, lintConfig, updateSetting, resetVenvSetting } from '../api';
import { showToast } from './toast';
import type { ConfigIssue, SettingsNode, SettingsLeaf, SettingValue } from '../types';

let tree: SettingsNode[] = [];
let issues: ConfigIssue[] = [];
let loading = false;
let error: string | null = null;
/** When set, settings are scoped to this venv (per-venv overrides). */
let venvId: string | null = null;
const listeners = new Set<() => void>();

// Cached snapshot – only replaced on emit()
let snapshot = buildSnapshot();

function buildSnapshot() {
  return {
    tree,
    issues,
    loading,
    error,
    venvId,
    sections: getSections(),
    needsSetup: getNeedsSetup(),
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

function flattenLeaves(nodes: SettingsNode[]): SettingsLeaf[] {
  const leaves: SettingsLeaf[] = [];
  for (const node of nodes) {
    if (node.kind === 'leaf') {
      leaves.push(node);
    } else {
      leaves.push(...flattenLeaves(node.children));
    }
  }
  return leaves;
}

function getSections(): string[] {
  return tree
    .filter((n): n is Extract<SettingsNode, { kind: 'group' }> => n.kind === 'group')
    .map((g) => g.name);
}

function getNeedsSetup(): boolean {
  const leaves = flattenLeaves(tree);
  return (
    leaves.length > 0 &&
    !leaves.some(
      (s) => s.setting_type === 'apikey' && s.enabled && String(s.effective_value).trim().length > 0,
    )
  );
}

export async function loadSettings() {
  loading = true;
  error = null;
  emit();
  try {
    tree = await getSettingsTree(venvId ?? undefined);
    issues = await lintConfig(venvId ?? undefined);
  } catch (e) {
    console.error('Failed to load settings:', e);
    error = String(e);
    showToast('Failed to load settings: ' + String(e), 'error');
  } finally {
    loading = false;
    emit();
  }
}

export async function updateSettingValue(id: string, value: SettingValue) {
  await updateSetting(id, value, venvId ?? undefined);
  await loadSettings();
}

/** Reset a venv-level override so the setting inherits from global/default. */
export async function resetVenvSettingValue(id: string) {
  if (!venvId) return;
  await resetVenvSetting(venvId, id);
  await loadSettings();
}

/** Set the venv scope for settings. Pass null for global settings. */
export function setSettingsScope(id: string | null) {
  if (id === venvId) return;
  venvId = id;
  loadSettings();
}

export function useSettings() {
  const snap = useSyncExternalStore(subscribe, () => snapshot);

  return {
    ...snap,
    section: (name: string) => tree.find((n) => n.kind === 'group' && n.name === name),
    issuesFor: (id: string) => issues.filter((i) => i.id === id),
    update: updateSettingValue,
    resetVenv: resetVenvSettingValue,
    setScope: setSettingsScope,
    load: loadSettings,
  };
}
