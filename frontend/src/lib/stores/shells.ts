// Shell session store for multi-terminal tab management.
import { useSyncExternalStore, useCallback, useRef, useEffect } from 'react';
import * as api from '../api';

export interface ShellTab {
  sessionId: number;
  label: string;
}

let tabs: ShellTab[] = [{ sessionId: 0, label: 'Shell 1' }];
let activeSessionId = 0;
let nextSessionId = 1;
// Cached snapshot objects for useSyncExternalStore (must be referentially stable).
let tabsSnapshot = tabs;
let activeSnapshot = activeSessionId;
const listeners = new Set<() => void>();

function emit() {
  tabsSnapshot = [...tabs];
  activeSnapshot = activeSessionId;
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useShells() {
  const currentTabs = useSyncExternalStore(subscribe, () => tabsSnapshot);
  const currentActive = useSyncExternalStore(subscribe, () => activeSnapshot);
  const eventCleanups = useRef<Array<() => void>>([]);

  // Listen for shell-ready and shell-closed events from the backend.
  useEffect(() => {
    let mounted = true;
    (async () => {
      const unlistenReady = await api.onShellReady(({ session_id }) => {
        if (!mounted) return;
        // Tab was already added optimistically in spawnShell, but confirm it exists.
        if (!tabs.find((t) => t.sessionId === session_id)) {
          tabs = [...tabs, { sessionId: session_id, label: `Shell ${session_id + 1}` }];
        }
        activeSessionId = session_id;
        emit();
      });
      const unlistenClosed = await api.onShellClosed(({ session_id }) => {
        if (!mounted) return;
        tabs = tabs.filter((t) => t.sessionId !== session_id);
        if (activeSessionId === session_id) {
          activeSessionId = tabs.length > 0 ? tabs[tabs.length - 1].sessionId : 0;
        }
        emit();
      });
      eventCleanups.current = [unlistenReady, unlistenClosed];
    })();
    return () => {
      mounted = false;
      eventCleanups.current.forEach((fn) => fn());
    };
  }, []);

  const spawnShell = useCallback(async () => {
    const sid = nextSessionId++;
    // Optimistically add the tab.
    tabs = [...tabs, { sessionId: sid, label: `Shell ${sid + 1}` }];
    activeSessionId = sid;
    emit();
    try {
      await api.spawnShell(sid);
    } catch {
      // Revert if backend rejects.
      tabs = tabs.filter((t) => t.sessionId !== sid);
      if (activeSessionId === sid) {
        activeSessionId = tabs.length > 0 ? tabs[tabs.length - 1].sessionId : 0;
      }
      emit();
    }
  }, []);

  const closeShell = useCallback(async (sessionId: number) => {
    if (sessionId === 0) return; // Can't close default shell.
    try {
      await api.closeShell(sessionId);
    } catch {
      // Ignore -- event handler will clean up.
    }
  }, []);

  const setActiveSession = useCallback((sessionId: number) => {
    activeSessionId = sessionId;
    emit();
  }, []);

  return {
    tabs: currentTabs,
    activeSessionId: currentActive,
    spawnShell,
    closeShell,
    setActiveSession,
  };
}

/** Reset shells store to initial state (called on VM stop/restart). */
export function resetShells() {
  tabs = [{ sessionId: 0, label: 'Shell 1' }];
  activeSessionId = 0;
  nextSessionId = 1;
  emit();
}
