// Shell session store for multi-terminal tab management.
// Uses a simple model: tabs are only added AFTER the backend confirms
// the shell is ready (via shell-ready event). No optimistic updates.
import { useSyncExternalStore, useCallback } from 'react';
import * as api from '../api';
import { showToast } from './toast';

export interface ShellTab {
  sessionId: number;
  label: string;
}

let tabs: ShellTab[] = [{ sessionId: 0, label: 'Shell 1' }];
let activeSessionId = 0;
let nextSessionId = 1;
let spawning = false; // prevents double-spawn
let tabsSnapshot = tabs;
let activeSnapshot = activeSessionId;
const listeners = new Set<() => void>();
let eventsInitialized = false;

function emit() {
  tabsSnapshot = [...tabs];
  activeSnapshot = activeSessionId;
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function nextLabel(): string {
  const usedNums = new Set(tabs.map((t) => {
    const m = t.label.match(/^Shell (\d+)$/);
    return m ? parseInt(m[1], 10) : 0;
  }));
  let num = 1;
  while (usedNums.has(num)) num++;
  return `Shell ${num}`;
}

/** Set up global event listeners once. */
function initShellEvents() {
  if (eventsInitialized) return;
  eventsInitialized = true;

  api.onShellReady(({ session_id }) => {
    spawning = false;
    // Only add if not already present.
    if (!tabs.find((t) => t.sessionId === session_id)) {
      tabs = [...tabs, { sessionId: session_id, label: nextLabel() }];
    }
    activeSessionId = session_id;
    emit();
  }).catch(() => {});

  api.onShellClosed(({ session_id }) => {
    tabs = tabs.filter((t) => t.sessionId !== session_id);
    if (activeSessionId === session_id) {
      activeSessionId = tabs.length > 0 ? tabs[tabs.length - 1].sessionId : 0;
    }
    emit();
  }).catch(() => {});
}

export function useShells() {
  initShellEvents();

  const currentTabs = useSyncExternalStore(subscribe, () => tabsSnapshot);
  const currentActive = useSyncExternalStore(subscribe, () => activeSnapshot);

  const spawnShell = useCallback(async () => {
    if (spawning) return;
    spawning = true;
    const sid = nextSessionId++;
    try {
      await api.spawnShell(sid);
      // Don't add tab here — wait for shell-ready event.
    } catch (e) {
      spawning = false;
      console.error('[shells] spawnShell failed:', e);
      showToast('Failed to create shell: ' + String(e), 'error');
    }
  }, []);

  const closeShell = useCallback(async (sessionId: number) => {
    // Remove tab immediately for responsive UI.
    tabs = tabs.filter((t) => t.sessionId !== sessionId);
    if (activeSessionId === sessionId) {
      activeSessionId = tabs.length > 0 ? tabs[tabs.length - 1].sessionId : 0;
    }
    emit();
    try {
      await api.closeShell(sessionId);
    } catch {
      // Backend cleanup happens via shell-closed event.
    }
  }, []);

  const setActiveSession = useCallback((sessionId: number) => {
    activeSessionId = sessionId;
    emit();
  }, []);

  const renameShell = useCallback((sessionId: number, label: string) => {
    const tab = tabs.find((t) => t.sessionId === sessionId);
    if (tab && label.trim()) {
      tab.label = label.trim();
      emit();
    }
  }, []);

  return {
    tabs: currentTabs,
    activeSessionId: currentActive,
    spawnShell,
    closeShell,
    setActiveSession,
    renameShell,
  };
}

/** Reset shells store to initial state (called on VM stop/restart). */
export function resetShells() {
  tabs = [{ sessionId: 0, label: 'Shell 1' }];
  activeSessionId = 0;
  nextSessionId = 1;
  spawning = false;
  emit();
}
