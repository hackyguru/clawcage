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
          const usedNums = new Set(tabs.map((t) => {
            const m = t.label.match(/^Shell (\d+)$/);
            return m ? parseInt(m[1], 10) : 0;
          }));
          let num = 1;
          while (usedNums.has(num)) num++;
          tabs = [...tabs, { sessionId: session_id, label: `Shell ${num}` }];
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
        // If all shells are gone, spawn a fresh one.
        if (tabs.length === 0) {
          const sid = nextSessionId++;
          tabs = [{ sessionId: sid, label: 'Shell 1' }];
          activeSessionId = sid;
          emit();
          api.spawnShell(sid).catch(() => {});
        }
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
    // Find the next available label number (fill gaps).
    const usedNums = new Set(tabs.map((t) => {
      const m = t.label.match(/^Shell (\d+)$/);
      return m ? parseInt(m[1], 10) : 0;
    }));
    let num = 1;
    while (usedNums.has(num)) num++;
    // Optimistically add the tab.
    tabs = [...tabs, { sessionId: sid, label: `Shell ${num}` }];
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
    try {
      await api.closeShell(sessionId);
    } catch {
      // Ignore -- event handler will clean up.
    }
    // If we closed the last shell, spawn a fresh one.
    if (tabs.length <= 1) {
      const sid = nextSessionId++;
      tabs = [{ sessionId: sid, label: 'Shell 1' }];
      activeSessionId = sid;
      emit();
      try {
        await api.spawnShell(sid);
      } catch {
        tabs = [];
        emit();
      }
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
  emit();
}
