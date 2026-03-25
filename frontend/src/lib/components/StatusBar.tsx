// StatusBar component
import { useState, useEffect, useCallback } from 'react';
import { useVm } from '../stores/vm';
import { useVenvs } from '../stores/venvs';
import { useTheme } from '../stores/theme';
import { SunIcon, MoonIcon, DownloadIcon } from '../icons/Icons';
import VmStateIndicator from './VmStateIndicator';
import Dialog from './Dialog';
import { onUpdateAvailable, onUpdateProgress, installUpdate } from '../api';
import type { UpdateInfo, UpdateProgress } from '../api';

const isTauri = typeof window !== 'undefined' && !!(window as any).__TAURI_INTERNALS__;

export default function StatusBar() {
  const { terminalRenderer } = useVm();
  const { activeVenv } = useVenvs();
  const { theme, toggle } = useTheme();
  const [version, setVersion] = useState<string | null>(null);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isTauri) {
      import('@tauri-apps/api/app').then(({ getVersion }) => getVersion()).then(setVersion).catch(() => {});
    } else {
      setVersion('dev');
    }
  }, []);

  // Listen for update-available from backend
  useEffect(() => {
    let unsub: (() => void) | undefined;
    onUpdateAvailable((info) => setUpdateInfo(info)).then((fn) => { unsub = fn; });
    return () => unsub?.();
  }, []);

  // Listen for download progress
  useEffect(() => {
    if (!installing) return;
    let unsub: (() => void) | undefined;
    onUpdateProgress((p) => setProgress(p)).then((fn) => { unsub = fn; });
    return () => unsub?.();
  }, [installing]);

  const handleInstall = useCallback(async () => {
    setInstalling(true);
    setError(null);
    setProgress(null);
    try {
      await installUpdate();
      // App will restart — this line won't be reached
    } catch (e: any) {
      setError(e?.toString() ?? 'Update failed');
      setInstalling(false);
    }
  }, []);

  const percent = progress?.total
    ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
    : null;

  return (
    <>
      <footer className="flex shrink-0 items-center justify-between border-t border-edge bg-surface px-3 py-1 text-xs text-content/50">
        <div className="flex items-center gap-3">
          {activeVenv && (
            <span className="font-medium text-content/70">{activeVenv.name}</span>
          )}
          <VmStateIndicator />
          {terminalRenderer && (
            <span className="text-content/30">
              {terminalRenderer === 'webgl' ? 'WebGL' : 'Canvas'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {updateInfo && (
            <button
              className="flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-interactive/15 text-interactive text-[10px] font-medium hover:bg-interactive/25 transition-colors"
              onClick={() => setShowModal(true)}
            >
              <DownloadIcon className="size-2.5" />
              v{updateInfo.version} available
            </button>
          )}
          {version && (
            <span className="text-content/25 text-[10px]">v{version}</span>
          )}
          <button
            className="flex items-center justify-center w-5 h-5 rounded hover:bg-surface-alt text-content/40 hover:text-content/70 transition-colors"
            onClick={toggle}
            aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
          >
            {theme === 'dark' ? <SunIcon className="size-3.5" /> : <MoonIcon className="size-3.5" />}
          </button>
        </div>
      </footer>

      {/* Update modal */}
      <Dialog open={showModal} onClose={() => !installing && setShowModal(false)} title="Update Available" width="max-w-sm">
        <div className="space-y-4">
          <div className="flex items-baseline justify-between">
            <span className="text-2xl font-bold text-content">v{updateInfo?.version}</span>
            {version && <span className="text-xs text-content/40">current: v{version}</span>}
          </div>

          {updateInfo?.notes && (
            <p className="text-xs text-content/60 leading-relaxed">{updateInfo.notes}</p>
          )}

          {/* Progress bar */}
          {installing && (
            <div className="space-y-1.5">
              <div className="w-full h-2 rounded-full bg-surface-alt overflow-hidden">
                <div
                  className="h-full bg-interactive rounded-full transition-all duration-300"
                  style={{ width: `${percent ?? 0}%` }}
                />
              </div>
              <p className="text-[10px] text-content/40 text-center">
                {percent != null ? `Downloading... ${percent}%` : 'Preparing download...'}
              </p>
            </div>
          )}

          {error && (
            <p className="text-xs text-denied">{error}</p>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            {!installing && (
              <button
                className="px-3 py-1.5 text-sm rounded-lg hover:bg-surface-alt transition-colors"
                onClick={() => setShowModal(false)}
              >
                Later
              </button>
            )}
            <button
              className="px-3 py-1.5 text-sm rounded-lg font-medium bg-interactive text-white hover:opacity-90 transition disabled:opacity-50"
              onClick={handleInstall}
              disabled={installing}
            >
              {installing ? 'Installing...' : 'Download & Install'}
            </button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
