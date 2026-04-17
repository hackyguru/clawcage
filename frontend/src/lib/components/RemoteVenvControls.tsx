// Remote-mode controls: toggle switch + multi-step progress modal.

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import {
  detachVenv,
  getVenvConnection,
  openRemoteTerminal,
  reattachVenv,
} from '../api';
import { CloudIcon } from '../icons/Icons';
import { showToast } from '../stores/toast';
import type { ConnectionMode, RemoteModeProgress, VenvInfo } from '../types';

// Tauri event listener (lazy-loaded so mock mode doesn't crash).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let listenFn: ((event: string, cb: (e: { payload: RemoteModeProgress }) => void) => Promise<() => void>) | null = null;
async function ensureListen() {
  if (!listenFn) {
    try {
      const mod = await import('@tauri-apps/api/event');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      listenFn = mod.listen as any;
    } catch {
      // Mock mode — no Tauri.
    }
  }
}

interface Props {
  venv: VenvInfo;
  onChanged?: () => void;
  /** When true, render just the toggle inline (no wrapper, no status text). */
  compact?: boolean;
}

export function RemoteVenvControls({ venv, onChanged, compact }: Props) {
  const [mode, setMode] = useState<ConnectionMode>({ type: 'local' });
  const [progress, setProgress] = useState<RemoteModeProgress | null>(null);
  const [busy, setBusy] = useState(false);
  // Accumulate actual step labels from backend events (so reused VPS shows
  // "Reconnecting to server" instead of the generic "Waiting for boot").
  const liveLabels = useRef<Map<number, string>>(new Map());

  // Poll connection status.
  useEffect(() => {
    let alive = true;
    const fetch = async () => {
      try {
        const status = await getVenvConnection(venv.id);
        if (alive) setMode(status.mode);
      } catch { /* swallow */ }
    };
    fetch();
    const id = setInterval(fetch, 3000);
    return () => { alive = false; clearInterval(id); };
  }, [venv.id]);

  // Listen to progress events.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    (async () => {
      await ensureListen();
      if (!listenFn) return;
      unlisten = await listenFn('remote-mode-progress', (e) => {
        if (e.payload.venv_id === venv.id) {
          // Track actual backend labels per step index.
          if (!e.payload.done) {
            liveLabels.current.set(e.payload.step_index, e.payload.step_label);
          }
          setProgress(e.payload);
          if (e.payload.done) {
            // Clear after a brief delay so user sees the final step.
            setTimeout(() => {
              setProgress(null);
              setBusy(false);
              liveLabels.current.clear();
              onChanged?.();
            }, 1500);
          }
        }
      });
    })();
    return () => { unlisten?.(); };
  }, [venv.id, onChanged]);

  const isRemote = mode.type === 'remote' || mode.type === 'reattaching';
  const isTransitioning = mode.type === 'detaching' || mode.type === 'reattaching' || busy;

  const handleToggle = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setProgress(null);
    try {
      if (isRemote) {
        await reattachVenv(venv.id);
        // Auto-start the local VM after bringing back from cloud.
        try {
          const { startVenvAction } = await import('../stores/venvs');
          startVenvAction(venv.id);
        } catch { /* swallow — UI will recover on next poll */ }
      } else {
        await detachVenv({ venvId: venv.id, venvName: venv.name });
      }
    } catch (e) {
      showToast(String(e), 'error', 6000);
      setProgress(null);
      setBusy(false);
    }
  }, [venv.id, venv.name, isRemote, busy]);

  const handleOpenTerminal = useCallback(async () => {
    try {
      await openRemoteTerminal(venv.id, venv.name);
    } catch (e) {
      showToast('Open terminal failed: ' + String(e), 'error', 5000);
    }
  }, [venv.id, venv.name]);

  // Compact: toggle inline in the footer + full steps in bottom-right toast.
  if (compact) {
    const showPopover = (progress && !progress.done) || (progress?.done && !progress.error);
    return (
      <>
        {/* Progress toast portaled to document.body so ancestor overflow/transform can't clip it */}
        {showPopover && createPortal(
          <div className="fixed bottom-4 right-4 w-56 p-3 bg-surface border border-edge/40 rounded-xl shadow-2xl z-9999 animate-[slideUp_0.25s_ease-out]">
            {progress && !progress.done ? (
              <>
                <div className="text-[9px] text-content/30 uppercase tracking-wider mb-2">
                  {progress.operation === 'detach' ? 'Moving to Cloud' : 'Bringing Back Local'}
                </div>
                <div className="space-y-1.5">
                  {Array.from({ length: progress.total_steps }, (_, i) => {
                    const isCurrent = i === progress.step_index;
                    const isDone = i < progress.step_index;
                    // Use actual backend label if we've seen this step, otherwise static fallback.
                    const label = liveLabels.current.get(i) ?? stepLabels(progress.operation, i);
                    return (
                      <div key={i} className="flex items-center gap-2">
                        <div className={`size-1.5 rounded-full shrink-0 transition-colors duration-300 ${
                          isDone ? 'bg-allowed' : isCurrent ? 'bg-sky-400 animate-pulse' : 'bg-content/10'
                        }`} />
                        <span className={`text-[11px] transition-colors duration-300 ${
                          isCurrent ? 'text-content/80' : isDone ? 'text-content/35' : 'text-content/15'
                        }`}>
                          {label}
                        </span>
                      </div>
                    );
                  })}
                </div>
                {progress.error && (
                  <div className="mt-2 text-[10px] text-denied bg-denied/5 rounded p-1.5">{progress.error}</div>
                )}
              </>
            ) : progress?.done && !progress.error ? (
              <div className="text-[11px] text-allowed text-center py-1">
                {progress.operation === 'detach' ? 'Running on cloud' : 'Back on local'}
              </div>
            ) : null}
          </div>,
          document.body,
        )}
        <div onClick={(e) => e.stopPropagation()}>
          <CloudLocalToggle
            isCloud={isRemote}
            disabled={isTransitioning}
            onToggle={() => handleToggle()}
          />
        </div>
      </>
    );
  }

  return (
    <div className="border-t border-edge/50 pt-2">
      {/* Toggle + single-line status — fixed height, no card resize */}
      <div className="flex items-center justify-between px-3 h-9">
        {/* Left: current step or action (single line, animated text swap) */}
        <div className="relative h-4 flex-1 min-w-0 overflow-hidden mr-3">
          {progress && !progress.done ? (
            <div key={progress.step} className="absolute inset-0 flex items-center gap-1.5 animate-[slideUp_0.25s_ease-out]">
              <span className="size-1.5 rounded-full bg-sky-400 animate-pulse shrink-0" />
              <span className="text-[11px] text-content/60 truncate">{progress.step_label}</span>
            </div>
          ) : progress?.done && !progress.error ? (
            <div key="done" className="absolute inset-0 flex items-center animate-[slideUp_0.25s_ease-out]">
              <span className="text-[11px] text-allowed">
                {progress.operation === 'detach' ? 'Running on cloud' : 'Back on local'}
              </span>
            </div>
          ) : isRemote && !busy ? (
            <div className="absolute inset-0 flex items-center">
              <button
                className="text-[11px] hover:text-content/80 text-content/50 transition-colors flex items-center gap-1"
                onClick={(e) => { e.stopPropagation(); handleOpenTerminal(); }}
              >
                <span className="text-xs">→</span>
                SSH Terminal
              </button>
            </div>
          ) : null}
        </div>

        {/* Right: toggle */}
        <CloudLocalToggle
          isCloud={isRemote}
          disabled={isTransitioning}
          onToggle={() => handleToggle()}
        />
      </div>
    </div>
  );
}

/**
 * Custom toggle switch with cloud/laptop icons inside the knob.
 *
 * OFF (local): gray track, knob on the left with a laptop icon.
 * ON (cloud):  sky-blue track, knob on the right with a cloud icon.
 *
 * The icon lives INSIDE the sliding knob so it travels with the toggle.
 * Track shows the opposite icon (faded) as a hint of what toggling does.
 */
function CloudLocalToggle({ isCloud, disabled, onToggle }: {
  isCloud: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onToggle(); }}
      disabled={disabled}
      className={`relative inline-flex h-7 w-[52px] items-center rounded-full transition-all duration-300 ${
        isCloud ? 'bg-sky-400' : 'bg-content/15'
      } ${disabled ? 'opacity-50 cursor-wait' : 'cursor-pointer hover:shadow-md'}`}
      title={isCloud ? 'Switch back to local' : 'Move to cloud'}
      aria-label={isCloud ? 'Switch to local mode' : 'Switch to cloud mode'}
    >
      {/* Track hint icons (faded, opposite of current state) */}
      {/* When local: show faded cloud on the right (where knob will go) */}
      {!isCloud && (
        <svg className="absolute right-1.5 size-4 text-content/15" viewBox="0 0 24 24" fill="currentColor">
          <path d="M19.35 10.04A7.49 7.49 0 0 0 12 4C9.11 4 6.6 5.64 5.35 8.04A5.994 5.994 0 0 0 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z" />
        </svg>
      )}
      {/* When cloud: show faded laptop on the left */}
      {isCloud && (
        <svg className="absolute left-1.5 size-4 text-white/25" viewBox="0 0 24 24" fill="currentColor">
          <path d="M4 6h16v10H4V6zm-2 12h20v2H2v-2zm3-1h14V7H5v10z" />
        </svg>
      )}

      {/* Sliding knob with active icon */}
      <span className={`inline-flex items-center justify-center size-5 rounded-full bg-white shadow-md transition-transform duration-300 ease-in-out ${
        isCloud ? 'translate-x-[27px]' : 'translate-x-[3px]'
      }`}>
        {isCloud ? (
          /* Cloud icon inside knob */
          <svg className="size-3 text-sky-500" viewBox="0 0 24 24" fill="currentColor">
            <path d="M19.35 10.04A7.49 7.49 0 0 0 12 4C9.11 4 6.6 5.64 5.35 8.04A5.994 5.994 0 0 0 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z" />
          </svg>
        ) : (
          /* Laptop icon inside knob */
          <svg className="size-3 text-content/50" viewBox="0 0 24 24" fill="currentColor">
            <path d="M4 6h16v10H4V6zm-2 12h20v2H2v-2zm3-1h14V7H5v10z" />
          </svg>
        )}
      </span>
    </button>
  );
}

/** Static step labels for the progress display (used for past/future steps). */
function stepLabels(operation: string, index: number): string {
  if (operation === 'detach') {
    return ['Preparing SSH key', 'Connecting to cloud server', 'Waiting for boot', 'Transferring venv data', 'Starting remote session'][index] ?? '';
  }
  return ['Stopping remote session', 'Transferring venv data', 'Finalizing'][index] ?? '';
}

/**
 * Inline current-step label for venv cards. Shows above the footer line
 * during detach/reattach operations, hidden otherwise.
 */
export function RemoteStepLabel({ venvId }: { venvId: string }) {
  const [progress, setProgress] = useState<RemoteModeProgress | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    (async () => {
      await ensureListen();
      if (!listenFn) return;
      unlisten = await listenFn('remote-mode-progress', (e) => {
        if (e.payload.venv_id === venvId) {
          setProgress(e.payload);
          if (e.payload.done) {
            setTimeout(() => setProgress(null), 2000);
          }
        }
      });
    })();
    return () => { unlisten?.(); };
  }, [venvId]);

  if (!progress) return null;

  const label = !progress.done
    ? progress.step_label
    : progress.error
      ? progress.error
      : progress.operation === 'detach' ? 'Running on cloud' : 'Back on local';

  return (
    <div className="flex items-center gap-1.5 px-1 py-1 animate-[slideUp_0.2s_ease-out]">
      {progress.error ? (
        <span className="size-1.5 rounded-full bg-denied shrink-0" />
      ) : !progress.done ? (
        <span className="size-1.5 rounded-full bg-sky-400 animate-pulse shrink-0" />
      ) : (
        <span className="size-1.5 rounded-full bg-allowed shrink-0" />
      )}
      <span className={`text-[10px] truncate ${
        progress.error ? 'text-denied' : progress.done ? 'text-allowed' : 'text-content/50'
      }`}>
        {label}
      </span>
    </div>
  );
}

/**
 * Compact cloud badge for the venv card status row.
 */
export function RemoteVenvBadge({ venvId }: { venvId: string }) {
  const [mode, setMode] = useState<ConnectionMode>({ type: 'local' });

  useEffect(() => {
    let alive = true;
    const fetch = async () => {
      try {
        const status = await getVenvConnection(venvId);
        if (alive) setMode(status.mode);
      } catch { /* swallow */ }
    };
    fetch();
    const id = setInterval(fetch, 3000);
    return () => { alive = false; clearInterval(id); };
  }, [venvId]);

  if (mode.type === 'local') return null;

  const label =
    mode.type === 'detaching' ? 'detaching'
      : mode.type === 'reattaching' ? 'reattaching'
      : 'cloud';
  const color =
    mode.type === 'remote'
      ? 'bg-allowed/10 text-allowed'
      : 'bg-interactive/10 text-interactive';

  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium flex items-center gap-1 ${color}`}>
      <CloudIcon className="size-2.5" />
      {label}
    </span>
  );
}
