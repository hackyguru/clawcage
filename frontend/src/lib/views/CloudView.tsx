// CloudView — cloud sync settings and status
import { useState, useEffect, useCallback } from 'react';
import { cloudLogin, cloudDisconnect, cloudStatus, cloudSyncVenv, cloudBackupKey, cloudExportKey, openExternal, onSnapshotProgress } from '../api';
import { useVenvs } from '../stores/venvs';
import { showToast } from '../stores/toast';

interface SyncProgress {
  phase: string;
  bytes_processed: number;
  total_bytes: number;
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const phaseLabels: Record<string, string> = {
  compressing: 'Compressing',
  encrypting: 'Encrypting',
  uploading: 'Uploading',
  done: 'Done',
};

export default function CloudView() {
  const [status, setStatus] = useState<{ connected: boolean; email: string | null; plan: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [exportedKey, setExportedKey] = useState<string | null>(null);
  const { venvs } = useVenvs();

  const refresh = useCallback(async () => {
    try {
      const s = await cloudStatus();
      setStatus(s);
    } catch {
      setStatus({ connected: false, email: null, plan: 'free' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Listen for snapshot progress events
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    onSnapshotProgress((p) => {
      if (p.operation === 'sync') {
        setProgress({ phase: p.phase, bytes_processed: p.bytes_processed, total_bytes: p.total_bytes });
        if (p.phase === 'done') {
          setTimeout(() => setProgress(null), 1000);
        }
      }
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, []);

  const handleLogin = useCallback(async () => {
    setConnecting(true);
    try {
      const s = await cloudLogin();
      setStatus(s);
      showToast('Connected to Clawcage Cloud', 'success', 3000);
    } catch (e) {
      showToast('Login failed: ' + String(e), 'error');
    } finally {
      setConnecting(false);
    }
  }, []);

  const handleDisconnect = useCallback(async () => {
    await cloudDisconnect();
    showToast('Disconnected from cloud', 'info', 3000);
    refresh();
  }, [refresh]);

  const handleSync = useCallback(async (venvId: string) => {
    setSyncing(venvId);
    setProgress(null);
    try {
      await cloudSyncVenv(venvId);
      showToast('Environment synced to cloud', 'success', 3000);
    } catch (e) {
      showToast('Sync failed: ' + String(e), 'error');
    } finally {
      setSyncing(null);
    }
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <span className="spinner w-5 h-5 text-content/30" />
      </div>
    );
  }

  const stoppedVenvs = venvs.filter(v => v.status === 'stopped');
  const pct = progress && progress.total_bytes > 0
    ? Math.round((progress.bytes_processed / progress.total_bytes) * 100)
    : 0;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-edge shrink-0">
        <div>
          <h2 className="text-sm font-semibold">Cloud Sync</h2>
          <p className="text-xs text-content/50 mt-0.5">
            End-to-end encrypted sync to Clawcage Cloud
          </p>
        </div>
        {status?.connected && (
          <div className="flex items-center gap-2">
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${status.plan === 'pro' ? 'bg-allowed/10 text-allowed' : 'bg-content/5 text-content/50'}`}>
              {status.plan === 'pro' ? 'Pro' : 'Free'}
            </span>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-auto p-4 space-y-6">
        {/* Connection status */}
        {status?.connected ? (
          <div className="rounded-xl border border-allowed/20 bg-allowed/5 p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-allowed/10 flex items-center justify-center">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 text-allowed"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg>
                </div>
                <div>
                  <p className="text-sm font-medium">Connected</p>
                  <p className="text-xs text-content/50">{status.email}</p>
                </div>
              </div>
              <button
                className="px-3 py-1.5 text-xs rounded-lg border border-edge hover:bg-surface-alt transition"
                onClick={handleDisconnect}
              >
                Disconnect
              </button>
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-edge p-4 space-y-4">
            <div>
              <p className="text-sm font-medium">Connect to Clawcage Cloud</p>
              <p className="text-xs text-content/50 mt-1">
                Sign in with your browser to link this app with Clawcage Cloud.
              </p>
            </div>
            <button
              className="w-full px-4 py-2.5 text-sm rounded-lg bg-interactive text-on-interactive hover:opacity-90 transition font-medium flex items-center justify-center gap-2 disabled:opacity-50"
              onClick={handleLogin}
              disabled={connecting}
            >
              {connecting ? (
                <>
                  <span className="spinner w-3.5 h-3.5" />
                  Waiting for browser sign-in...
                </>
              ) : (
                <>
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
                    <circle cx="12" cy="12" r="10" />
                    <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
                    <path d="M2 12h20" />
                  </svg>
                  Sign in with Browser
                </>
              )}
            </button>
            {connecting && (
              <p className="text-[11px] text-content/40 text-center">
                A browser window has been opened. Complete sign-in there to continue.
              </p>
            )}
          </div>
        )}

        {/* Sync progress */}
        {syncing && progress && progress.phase !== 'done' && (
          <div className="rounded-xl border border-interactive/20 bg-interactive/5 p-4 space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium">
                {phaseLabels[progress.phase] ?? progress.phase}...
              </span>
              {progress.total_bytes > 0 && (
                <span className="text-content/50">
                  {formatSize(progress.bytes_processed)} / {formatSize(progress.total_bytes)} ({pct}%)
                </span>
              )}
            </div>
            <div className="w-full h-1.5 rounded-full bg-content/10 overflow-hidden">
              <div
                className="h-full bg-interactive rounded-full transition-all duration-300"
                style={{ width: `${progress.total_bytes > 0 ? pct : 100}%` }}
              />
            </div>
          </div>
        )}

        {/* Sync environments — Pro only */}
        {status?.connected && status.plan === 'pro' && (
          <div className="space-y-3">
            <h3 className="text-xs font-semibold text-content/60">Environments</h3>
            {stoppedVenvs.length === 0 ? (
              <p className="text-xs text-content/40">Stop an environment to sync it to the cloud.</p>
            ) : (
              <div className="space-y-2">
                {stoppedVenvs.map((v) => (
                  <div key={v.id} className="flex items-center justify-between p-3 rounded-xl border border-edge bg-surface-alt/30">
                    <div>
                      <p className="text-sm font-medium">{v.name}</p>
                      <p className="text-xs text-content/40">{v.template}</p>
                    </div>
                    <button
                      className="px-3 py-1.5 text-xs rounded-lg border border-edge hover:bg-surface-alt transition font-medium disabled:opacity-40"
                      onClick={() => handleSync(v.id)}
                      disabled={syncing !== null}
                    >
                      {syncing === v.id ? (
                        <span className="flex items-center gap-1.5">
                          <span className="spinner w-3 h-3" />
                          {phaseLabels[progress?.phase ?? ''] ?? 'Syncing'}...
                        </span>
                      ) : 'Sync'}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Upgrade prompt — free users */}
        {status?.connected && status.plan !== 'pro' && (
          <div className="rounded-xl border border-edge p-4 space-y-3">
            <div>
              <p className="text-sm font-medium">Upgrade to Pro</p>
              <p className="text-xs text-content/50 mt-1">
                Cloud sync requires a Pro subscription. Back up your environments with end-to-end encryption.
              </p>
            </div>
            <button
              className="px-4 py-2 text-xs rounded-lg bg-interactive text-on-interactive hover:opacity-90 transition font-medium"
              onClick={() => openExternal('https://buy.polar.sh/polar_cl_ixyw7tfQ3ffYwLX282w0KTMCUcOu9moqAISvG3JjubI')}
            >
              Upgrade
            </button>
          </div>
        )}

        {/* Encryption key backup — Pro only */}
        {status?.connected && status.plan === 'pro' && (
          <div className="space-y-3">
            <h3 className="text-xs font-semibold text-content/60">Encryption Key</h3>
            <div className="rounded-xl border border-edge p-4 space-y-3">
              <p className="text-xs text-content/50">
                Your snapshots are end-to-end encrypted. The key is stored locally on this device.
                Back it up to recover your data if you reinstall or switch machines.
              </p>
              <div className="flex items-center gap-2">
                <button
                  className="px-3 py-1.5 text-xs rounded-lg border border-edge hover:bg-surface-alt transition font-medium"
                  onClick={async () => {
                    try {
                      await cloudBackupKey();
                      showToast('Key saved to macOS Keychain', 'success', 3000);
                    } catch (e) {
                      showToast('Backup failed: ' + String(e), 'error');
                    }
                  }}
                >
                  Save to Keychain
                </button>
                <button
                  className="px-3 py-1.5 text-xs rounded-lg border border-edge hover:bg-surface-alt transition font-medium"
                  onClick={async () => {
                    try {
                      const key = await cloudExportKey();
                      setExportedKey(exportedKey ? null : key);
                    } catch (e) {
                      showToast('Export failed: ' + String(e), 'error');
                    }
                  }}
                >
                  {exportedKey ? 'Hide Key' : 'Show Key'}
                </button>
              </div>
              {exportedKey && (
                <div className="space-y-1.5">
                  <input
                    type="text"
                    readOnly
                    value={exportedKey}
                    className="w-full px-3 py-1.5 text-[11px] font-mono border border-edge rounded-lg bg-surface focus:outline-none select-all"
                    onFocus={(e) => e.target.select()}
                  />
                  <p className="text-[10px] text-content/40">
                    Save this key in a password manager. It's the only way to decrypt your cloud snapshots.
                  </p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
