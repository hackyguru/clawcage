// Theme store for React
import { useSyncExternalStore } from 'react';

type Theme = 'light' | 'dark';

let theme: Theme = 'light';
let listeners: (() => void)[] = [];

function applyTheme(t: Theme) {
  document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem('aivm-theme', t); } catch { /* ignore */ }
}

export function initTheme() {
  let stored: Theme = 'light';
  try {
    const s = localStorage.getItem('aivm-theme');
    if (s === 'dark' || s === 'light') stored = s;
  } catch { /* ignore */ }
  theme = stored;
  applyTheme(theme);
}

function toggleTheme() {
  theme = theme === 'light' ? 'dark' : 'light';
  applyTheme(theme);
  listeners.forEach((l) => l());
}

function getSnapshot(): Theme {
  return theme;
}

function subscribe(listener: () => void) {
  listeners.push(listener);
  return () => { listeners = listeners.filter((l) => l !== listener); };
}

export function useTheme() {
  const t = useSyncExternalStore(subscribe, getSnapshot);
  return { theme: t, toggle: toggleTheme };
}

export function getTheme(): Theme {
  return theme;
}
