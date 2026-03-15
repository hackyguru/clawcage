// Toast notification store
import { useSyncExternalStore } from 'react';

export type ToastLevel = 'info' | 'success' | 'warning' | 'error';

export interface Toast {
  id: number;
  message: string;
  level: ToastLevel;
}

let nextId = 0;
let toasts: Toast[] = [];
let snapshot: Toast[] = toasts;

const listeners = new Set<() => void>();
function emit() {
  snapshot = [...toasts];
  listeners.forEach((l) => l());
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Show a toast. Auto-dismisses after `ms` (default 4000). */
export function showToast(message: string, level: ToastLevel = 'error', ms = 4000) {
  const id = ++nextId;
  toasts = [...toasts, { id, message, level }];
  emit();
  setTimeout(() => dismissToast(id), ms);
}

export function dismissToast(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

export function useToasts() {
  return useSyncExternalStore(subscribe, () => snapshot);
}
