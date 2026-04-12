// CloudView — cloud sync settings and status
import { useState, useEffect, useCallback } from 'react';
import { cloudLogin, cloudDisconnect, cloudStatus, cloudSyncVenv, cloudBackupKey, cloudExportKey, cloudListSnapshots, cloudRestoreSnapshot, cloudSetAutoSync, cloudGetAutoSync, cloudOpenPortal, openExternal } from '../api';
import { useVenvs } from '../stores/venvs';
import { showToast } from '../stores/toast';
import { useCloudSync, setSyncing } from '../stores/cloudSync';
import { setCloudAuth } from '../stores/cloudAuth';

function formatSize(bytes: number): string {
  if (bytes < 1e6) return `${(bytes / 1e3).toFixed(0)} KB`;
  if (bytes < 1e9) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e9).toFixed(2)} GB`;
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

const phaseLabels: Record<string, string> = {
  compressing: 'Compressing',
  encrypting: 'Encrypting',
  uploading: 'Uploading',
  done: 'Done',
};

function RestoreButton({ id, name, restoring, setRestoring }: {
  id?: string; name: string;
  restoring: string | null; setRestoring: (v: string | null) => void;
}) {
  return (
    <button
      className="px-3 py-1.5 text-xs rounded-lg border border-edge hover:bg-surface-alt transition font-medium disabled:opacity-40"
      onClick={async () => {
        if (!id) return;
        setRestoring(id);
        try {
          await cloudRestoreSnapshot(id);
          showToast(`Restored "${name}" from cloud`, 'success', 3000);
        } catch (e) {
          showToast('Restore failed: ' + String(e), 'error');
        } finally {
          setRestoring(null);
        }
      }}
      disabled={restoring !== null || !id}
    >
      {restoring === id ? (
        <span className="flex items-center gap-1.5">
          <span className="spinner w-3 h-3" />
          Restoring...
        </span>
      ) : 'Restore'}
    </button>
  );
}

function VersionGroup({ venvName, versions, restoring, setRestoring }: {
  venvName: string;
  versions: { venv_name: string; synced_at: string; file_size_bytes: number; id?: string }[];
  restoring: string | null; setRestoring: (v: string | null) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const latest = versions[0];
  const older = versions.slice(1);

  return (
    <div className="rounded-xl border border-edge bg-surface-alt/30 overflow-hidden">
      {/* Latest version header */}
      <div className="flex items-center justify-between p-3">
        <div className="flex items-center gap-2 min-w-0">
          {older.length > 0 && (
            <button
              className="shrink-0 w-5 h-5 flex items-center justify-center rounded text-content/40 hover:text-content/70 transition"
              onClick={() => setExpanded(!expanded)}
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`w-3 h-3 transition-transform ${expanded ? 'rotate-90' : ''}`}>
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>
          )}
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">{venvName}</p>
            <p className="text-xs text-content/40">
              {formatSize(latest.file_size_bytes)} · {timeAgo(latest.synced_at)}
              {older.length > 0 && <span className="text-content/30"> · {older.length} older version{older.length > 1 ? 's' : ''}</span>}
            </p>
          </div>
        </div>
        <RestoreButton id={latest.id} name={venvName} restoring={restoring} setRestoring={setRestoring} />
      </div>

      {/* Expanded version timeline */}
      {expanded && older.length > 0 && (
        <div className="border-t border-edge">
          {older.map((v) => (
            <div key={v.id ?? v.synced_at} className="flex items-center justify-between px-3 py-2 border-b border-edge/50 last:border-b-0 bg-surface/50">
              <div className="flex items-center gap-2 pl-7">
                <div className="w-1.5 h-1.5 rounded-full bg-content/20 shrink-0" />
                <p className="text-xs text-content/50">
                  {timeAgo(v.synced_at)} · {formatSize(v.file_size_bytes)}
                </p>
              </div>
              <RestoreButton id={v.id} name={`${venvName} (${timeAgo(v.synced_at)})`} restoring={restoring} setRestoring={setRestoring} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function CloudView() {
  const [status, setStatus] = useState<{ connected: boolean; email: string | null; plan: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [exportedKey, setExportedKey] = useState<string | null>(null);
  const [snapshots, setSnapshots] = useState<{ venv_name: string; synced_at: string; file_size_bytes: number; id?: string }[]>([]);
  const [autoSync, setAutoSync] = useState(false);
  const [lastAutoSync, setLastAutoSync] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  const cloudSync = useCloudSync();
  const syncing = cloudSync.syncingVenvId;
  const progress = cloudSync.phase ? { phase: cloudSync.phase, bytes_processed: cloudSync.bytesProcessed, total_bytes: cloudSync.totalBytes } : null;
  const { venvs } = useVenvs();

  const refresh = useCallback(async () => {
    try {
      const s = await cloudStatus();
      setStatus(s);
      setCloudAuth({ connected: s.connected, email: s.connected ? s.email : null, plan: s.plan });
      if (s.connected && s.plan !== 'free') {
        const [snaps, autoSyncInfo] = await Promise.all([
          cloudListSnapshots().catch(() => []),
          cloudGetAutoSync().catch(() => ({ enabled: false, last_sync: null })),
        ]);
        setSnapshots(snaps);
        setAutoSync(autoSyncInfo.enabled);
        setLastAutoSync(autoSyncInfo.last_sync);
      }
    } catch {
      setStatus({ connected: false, email: null, plan: 'free' });
      setCloudAuth({ connected: false, email: null, plan: 'free' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Poll plan status every 30s (picks up upgrades/downgrades within the 5-min cache TTL)
  useEffect(() => {
    const iv = setInterval(refresh, 30_000);
    return () => clearInterval(iv);
  }, [refresh]);


  const handleLogin = useCallback(async () => {
    setConnecting(true);
    try {
      const s = await cloudLogin();
      setStatus(s);
      setCloudAuth({ connected: s.connected, email: s.connected ? s.email : null, plan: s.plan });
      showToast('Connected to Clawcage Cloud', 'success', 3000);
    } catch (e) {
      showToast('Login failed: ' + String(e), 'error');
    } finally {
      setConnecting(false);
    }
  }, []);

  const handleDisconnect = useCallback(async () => {
    await cloudDisconnect();
    setCloudAuth({ connected: false, email: null, plan: 'free' });
    showToast('Disconnected from cloud', 'info', 3000);
    refresh();
  }, [refresh]);

  const handleSync = useCallback(async (venvId: string) => {
    setSyncing(venvId);
    try {
      await cloudSyncVenv(venvId);
      const snaps = await cloudListSnapshots().catch(() => []);
      setSnapshots(snaps);
      showToast('Environment synced to cloud', 'success', 3000);
    } catch (e) {
      showToast('Sync failed: ' + String(e), 'error');
      setSyncing(null);
    }
    // Don't clear syncing here — the global store clears it on the 'done' event
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
          <div className="flex items-center gap-3">
            {status.plan !== 'free' && (
              <div className="flex items-center gap-2" title={autoSync ? 'Auto-sync enabled' : 'Auto-sync disabled'}>
                <span className="text-[10px] text-content/40">Auto-sync</span>
                <button
                  className={`relative w-8 h-4.5 rounded-full transition-colors ${autoSync ? 'bg-allowed' : 'bg-content/20'}`}
                  onClick={async () => {
                    const next = !autoSync;
                    setAutoSync(next);
                    try { await cloudSetAutoSync(next); } catch { setAutoSync(!next); }
                  }}
                >
                  <span className={`absolute top-0.5 left-0.5 w-3.5 h-3.5 rounded-full bg-white transition-transform ${autoSync ? 'translate-x-3.5' : ''}`} />
                </button>
              </div>
            )}
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${status.plan !== 'free' ? 'bg-allowed/10 text-allowed' : 'bg-content/5 text-content/50'}`}>
              {status.plan === 'pro_plus' ? 'Pro+' : status.plan === 'pro' ? 'Pro' : 'Free'}
            </span>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-auto">
        {/* Not connected — sign in screen */}
        {!status?.connected && (
          <div className="flex flex-col items-center justify-center min-h-full p-6">
            <div className="max-w-sm w-full text-center space-y-6">
              <div className="w-14 h-14 rounded-2xl bg-allowed/10 ring-2 ring-allowed/20 flex items-center justify-center mx-auto">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-7 h-7 text-allowed"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg>
              </div>
              <div>
                <h2 className="text-base font-semibold">Connect to Clawcage Cloud</h2>
                <p className="text-xs text-content/40 mt-1.5">End-to-end encrypted snapshots. Restore from any device.</p>
              </div>
              <button
                className="w-full px-4 py-2.5 text-sm rounded-lg bg-interactive text-on-interactive hover:opacity-90 transition font-medium flex items-center justify-center gap-2 disabled:opacity-50"
                onClick={handleLogin}
                disabled={connecting}
              >
                {connecting ? (
                  <><span className="spinner w-3.5 h-3.5" /> Waiting for browser...</>
                ) : 'Sign in with Browser'}
              </button>
              {connecting && (
                <p className="text-[11px] text-content/40">A browser window has opened. Complete sign-in there.</p>
              )}
            </div>
          </div>
        )}

        {/* Connected */}
        {status?.connected && (
        <div className="p-4 space-y-4">

          {/* Account strip — compact, inline */}
          <div className="flex items-center gap-2 text-[11px] text-content/40">
            <span className="size-1.5 rounded-full bg-allowed" />
            <span className="truncate">{status.email}</span>
            <span className={`px-1.5 py-0.5 rounded-full text-[9px] font-medium ${status.plan !== 'free' ? 'bg-allowed/10 text-allowed' : 'bg-content/5 text-content/50'}`}>
              {status.plan === 'pro_plus' ? 'Pro+' : status.plan === 'pro' ? 'Pro' : 'Free'}
            </span>
            <span className="flex-1" />
            <button className="text-[10px] text-content/30 hover:text-content/50 transition" onClick={handleDisconnect}>Sign out</button>
          </div>

          {/* Paid: Snapshots list */}
          {status.plan !== 'free' && snapshots.length > 0 && (
            <div className="space-y-2">
              {Object.entries(
                snapshots.reduce<Record<string, typeof snapshots>>((groups, s) => {
                  (groups[s.venv_name] ??= []).push(s);
                  return groups;
                }, {})
              ).map(([venvName, versions]) => (
                <VersionGroup key={venvName} venvName={venvName} versions={versions} restoring={restoring} setRestoring={setRestoring} />
              ))}
            </div>
          )}

          {/* Paid: No snapshots empty state */}
          {status.plan !== 'free' && snapshots.length === 0 && (
            <div className="py-12 text-center">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-8 h-8 text-content/10 mx-auto mb-2"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg>
              <p className="text-xs text-content/30">No snapshots yet</p>
              <p className="text-[10px] text-content/20 mt-0.5">Use the menu on any environment to sync</p>
            </div>
          )}

          {/* Paid: Bottom row — encryption + upgrade */}
          {status.plan !== 'free' && (
            <div className="flex items-center gap-2 pt-2 border-t border-edge/30">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3 text-content/20 shrink-0"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
              <span className="text-[10px] text-content/25">Encrypted on client side</span>
              <span className="text-content/10">|</span>
              <button
                className="text-[10px] text-allowed/60 hover:text-allowed transition"
                onClick={async () => { try { await cloudBackupKey(); showToast('Key saved to Keychain', 'success', 3000); } catch (e) { showToast('Failed: ' + String(e), 'error'); } }}
              >
                Backup key
              </button>
              <span className="text-content/10">|</span>
              <button
                className="text-[10px] text-content/30 hover:text-content/50 transition"
                onClick={async () => { try { const key = await cloudExportKey(); setExportedKey(exportedKey ? null : key); } catch (e) { showToast('Failed: ' + String(e), 'error'); } }}
              >
                {exportedKey ? 'Hide' : 'Export'}
              </button>
              {status.plan === 'pro' && (
                <>
                  <span className="flex-1" />
                  <button
                    className="text-[10px] text-content/30 hover:text-content/50 transition"
                    onClick={async () => { try { await cloudOpenPortal(); } catch (e) { showToast('Failed: ' + String(e), 'error'); } }}
                  >
                    Upgrade to Pro+
                  </button>
                </>
              )}
            </div>
          )}
          {exportedKey && (
            <input type="text" readOnly value={exportedKey}
              className="w-full px-2.5 py-1.5 text-[10px] font-mono border border-edge rounded-lg bg-surface focus:outline-none select-all"
              onFocus={(e) => e.target.select()} />
          )}

          {/* Free: Pricing */}
          {status.plan === 'free' && (
            <div className="space-y-4">
              <div>
                <p className="text-sm font-medium">Upgrade to unlock Cloud Sync</p>
                <p className="text-xs text-content/40 mt-1">E2E encrypted snapshots. Restore to any device.</p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-xl border-2 border-allowed/20 bg-allowed/[0.03] p-3.5 space-y-2.5">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-allowed">Pro</span>
                    <span className="text-[8px] px-1.5 py-0.5 rounded-full bg-allowed text-black font-bold uppercase tracking-wider">Popular</span>
                  </div>
                  <p className="text-lg font-bold">&pound;15<span className="text-xs font-normal text-content/30">/mo</span></p>
                  <p className="text-[10px] text-content/40">1 GB storage, unlimited snapshots, auto-sync, E2E encryption</p>
                  <button className="w-full py-1.5 text-xs rounded-lg bg-allowed text-black hover:bg-allowed/90 transition font-semibold"
                    onClick={() => openExternal('https://buy.polar.sh/polar_cl_ixyw7tfQ3ffYwLX282w0KTMCUcOu9moqAISvG3JjubI')}>
                    Get Pro
                  </button>
                </div>
                <div className="rounded-xl border border-edge bg-surface-alt/20 p-3.5 space-y-2.5">
                  <span className="text-xs font-semibold">Pro+</span>
                  <p className="text-lg font-bold">&pound;40<span className="text-xs font-normal text-content/30">/mo</span></p>
                  <p className="text-[10px] text-content/40">5 GB storage, 30-day history, rollback to any point</p>
                  <button className="w-full py-1.5 text-xs rounded-lg border border-edge hover:bg-surface-alt transition font-semibold"
                    onClick={() => openExternal('https://buy.polar.sh/polar_cl_MiDARs1PftXZcdAM2JGSHMGJLRoCnxgU0CQPw2vFMHm')}>
                    Get Pro+
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
        )}
      </div>
    </div>
  );
}
