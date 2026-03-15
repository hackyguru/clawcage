// Theme store for React
import { useSyncExternalStore, useCallback } from 'react';

const STORAGE_KEY = 'capsem-theme';
type Theme = 'light' | 'dark';

let theme: Theme = 'dark';
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function apply() {
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-theme', theme);
  }
}

export function initTheme() {
  const stored = localStorage.getItem(STORAGE_KEY) as Theme | null;
  if (stored === 'light' || stored === 'dark') {
    theme = stored;
  } else if (
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-color-scheme: light)').matches
  ) {
    theme = 'light';
  }
  apply();
  emit();
}

export function useTheme() {
  const current = useSyncExternalStore(subscribe, () => theme);

  const toggle = useCallback(() => {
    theme = theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem(STORAGE_KEY, theme);
    apply();
    emit();
  }, []);

  return { theme: current, toggle };
}

export function getTheme(): Theme {
  return theme;
}
