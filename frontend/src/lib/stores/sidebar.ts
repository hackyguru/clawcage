// Sidebar state store for React
import { useSyncExternalStore, useCallback } from 'react';
import type { ViewName } from '../types';

type SettingsSection = string;

let activeView: ViewName = 'home';
let settingsSection: SettingsSection = '';
let pendingBrowserPort: number | null = null;
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

/** Navigate to the browser view and open a specific guest port. */
export function openInBrowser(port: number) {
  pendingBrowserPort = port;
  activeView = 'browser';
  emit();
}

/** Consume the pending browser port (called by BrowserView on mount). */
export function consumePendingBrowserPort(): number | null {
  const p = pendingBrowserPort;
  pendingBrowserPort = null;
  return p;
}
