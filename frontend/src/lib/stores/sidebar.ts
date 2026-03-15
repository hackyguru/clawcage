// Sidebar state store for React
import { useSyncExternalStore, useCallback } from 'react';
import type { ViewName } from '../types';

type SettingsSection = string;

let activeView: ViewName = 'terminal';
let settingsSection: SettingsSection = '';
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSidebar() {
  const view = useSyncExternalStore(subscribe, () => activeView);
  const section = useSyncExternalStore(subscribe, () => settingsSection);

  const setView = useCallback((v: ViewName) => {
    activeView = v;
    emit();
  }, []);

  const setSettingsSection = useCallback((s: string) => {
    settingsSection = s;
    emit();
  }, []);

  return { activeView: view, settingsSection: section, setView, setSettingsSection };
}
