// Theme store for React
import { useSyncExternalStore, useCallback } from 'react';

export function initTheme() {}
export function useTheme() { return { theme: 'light', toggle: () => {} }; }
export function getTheme() { return 'light'; }
