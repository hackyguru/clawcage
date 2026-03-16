// HomeView -- virtual environment list + create
import { useState, useEffect, useCallback } from 'react';
import { useVenvs, loadVenvs, createVenvAction, deleteVenvAction, startVenvAction, stopVenvAction, openVenv } from '../stores/venvs';
import { useSidebar } from '../stores/sidebar';
import { PlusIcon, PlayIcon, StopIcon, TrashIcon, TerminalIcon } from '../icons/Icons';
import type { VenvInfo } from '../types';

function relativeTime(iso: string | null): string {
  if (!iso) return 'Never used';
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function statusDot(status: VenvInfo['status']): string {
  switch (status) {
    case 'running': return 'bg-allowed';
    case 'booting': return 'bg-caution';
    case 'error': return 'bg-denied';
    default: return 'bg-content/20';
  }
}

function statusText(status: VenvInfo['status']): string {
  switch (status) {
    case 'running': return 'text-allowed';
    case 'booting': return 'text-caution';
    case 'error': return 'text-denied';
    default: return 'text-content/40';
  }
}

function VenvCard({ venv }: { venv: VenvInfo }) {
  const { setView } = useSidebar();
  const [confirming, setConfirming] = useState(false);

  const handleOpen = useCallback(() => {
    openVenv(venv.id);
    // Always start — backend handles stopping any currently running venv.
    // Even if status shows 'running', it may be stale from a previous session.
    startVenvAction(venv.id);
    setView('terminal');
  }, [venv.id, setView]);

  const handleStop = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    stopVenvAction(venv.id);
  }, [venv.id]);

  const handleDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirming) {
      setConfirming(true);
      setTimeout(() => setConfirming(false), 3000);
      return;
    }
    deleteVenvAction(venv.id);
  }, [venv.id, confirming]);

  return (
    <div
      className="group bg-surface border border-edge rounded-xl p-4 shadow-xs hover:shadow-md hover:border-interactive/30 transition-all cursor-pointer"
      onClick={handleOpen}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-interactive/10 text-interactive shrink-0">
              <TerminalIcon className="size-4" />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold truncate">{venv.name}</h3>
              <div className="flex items-center gap-1.5 mt-0.5">
                <span className={`inline-block size-1.5 rounded-full ${statusDot(venv.status)}`} />
                <span className={`text-[11px] capitalize ${statusText(venv.status)}`}>{venv.status}</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${venv.ephemeral ? 'bg-caution/15 text-caution' : 'bg-allowed/15 text-allowed'}`}>
                  {venv.ephemeral ? 'ephemeral' : 'persistent'}
                </span>
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity" onClick={(e) => e.stopPropagation()}>
          {venv.status === 'running' ? (
            <button
              className="p-1 rounded hover:bg-surface-alt text-content/50 hover:text-denied transition-colors"
              onClick={handleStop}
              title="Stop"
            >
              <StopIcon className="size-3.5" />
            </button>
          ) : (
            <button
              className="p-1 rounded hover:bg-surface-alt text-content/50 hover:text-allowed transition-colors"
              onClick={(e) => { e.stopPropagation(); handleOpen(); }}
              title="Start"
            >
              <PlayIcon className="size-3.5" />
            </button>
          )}
          <button
            className={`p-1 rounded hover:bg-surface-alt transition-colors ${confirming ? 'text-denied' : 'text-content/50 hover:text-denied'}`}
            onClick={handleDelete}
            title={confirming ? 'Click again to confirm' : 'Delete'}
          >
            <TrashIcon className="size-3.5" />
          </button>
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between text-[11px] text-content/40">
        <span>Last used: {relativeTime(venv.last_used)}</span>
        <span>{new Date(venv.created_at).toLocaleDateString()}</span>
      </div>
    </div>
  );
}

export default function HomeView() {
  const { venvs, loading } = useVenvs();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newEphemeral, setNewEphemeral] = useState(false);

  useEffect(() => {
    loadVenvs();
  }, []);

  const handleCreate = useCallback(async () => {
    const name = newName.trim();
    if (!name) return;
    await createVenvAction(name, newEphemeral);
    setNewName('');
    setNewEphemeral(false);
    setCreating(false);
  }, [newName, newEphemeral]);

  return (
    <div className="flex flex-col h-full overflow-auto">
      <div className="max-w-4xl w-full mx-auto px-6 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-xl font-bold">Environments</h1>
            <p className="text-sm text-content/50 mt-1">Create and manage isolated virtual environments</p>
          </div>
          <button
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-interactive text-white hover:opacity-90 transition font-medium"
            onClick={() => setCreating(true)}
          >
            <PlusIcon className="size-4" />
            New
          </button>
        </div>

        {/* Create modal inline */}
        {creating && (
          <div className="bg-surface border border-edge rounded-xl p-4 mb-6 shadow-sm">
            <h3 className="text-sm font-semibold mb-3">New Environment</h3>
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  className="flex-1 px-2.5 py-1.5 text-sm border border-edge rounded-md bg-surface focus:outline-none focus:ring-2 focus:ring-interactive/40"
                  placeholder="Environment name..."
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') setCreating(false); }}
                  autoFocus
                />
              </div>
              <div className="flex items-center justify-between">
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    className="toggle-switch"
                    checked={newEphemeral}
                    onChange={(e) => setNewEphemeral(e.target.checked)}
                  />
                  <span className="text-sm">Ephemeral</span>
                  <span className="text-[11px] text-content/40">
                    {newEphemeral ? 'Files are wiped on every restart' : 'Files persist across restarts'}
                  </span>
                </label>
                <div className="flex items-center gap-2">
                  <button
                    className="px-3 py-1.5 text-sm rounded-lg hover:bg-surface-alt transition-colors"
                    onClick={() => { setCreating(false); setNewName(''); setNewEphemeral(false); }}
                  >
                    Cancel
                  </button>
                  <button
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-interactive text-white hover:opacity-90 transition font-medium"
                    onClick={handleCreate}
                    disabled={!newName.trim()}
                  >
                    Create
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Loading state */}
        {loading && venvs.length === 0 && (
          <div className="flex items-center justify-center py-20">
            <span className="spinner w-6 h-6 text-content/30" />
          </div>
        )}

        {/* Empty state */}
        {!loading && venvs.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="w-16 h-16 rounded-2xl bg-interactive/10 flex items-center justify-center mb-4">
              <TerminalIcon className="size-8 text-interactive" />
            </div>
            <h2 className="text-lg font-semibold mb-1">No environments yet</h2>
            <p className="text-sm text-content/50 mb-4 max-w-xs">
              Create your first sandboxed virtual environment to get started.
            </p>
            <button
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-interactive text-white hover:opacity-90 transition font-medium"
              onClick={() => setCreating(true)}
            >
              <PlusIcon className="size-4" />
              Create Environment
            </button>
          </div>
        )}

        {/* Venv grid */}
        {venvs.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {venvs.map((v) => (
              <VenvCard key={v.id} venv={v} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
