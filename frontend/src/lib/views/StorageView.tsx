// StorageView — lists all Clawcage files with sizes, allows deletion
import { useState, useEffect, useCallback } from 'react';
import { listStorage, deleteStorage, hostDiskFree } from '../api';
import { showToast } from '../stores/toast';
import { TrashIcon } from '../icons/Icons';
import { ConfirmDialog } from '../components/Dialog';

interface StorageEntry {
  path: string;
  name: string;
  size_bytes: number;
  actual_bytes: number;
  kind: string;
  deletable: boolean;
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const KIND_BADGE: Record<string, string> = {
  venv: 'bg-interactive/10 text-interactive',
  snapshot: 'bg-caution/10 text-caution',
  rootfs: 'bg-allowed/10 text-allowed',
  config: 'bg-content/5 text-content/50',
  other: 'bg-content/5 text-content/50',
};

const KIND_LABEL: Record<string, string> = {
  venv: 'Environment',
  snapshot: 'Snapshot',
  rootfs: 'System',
  config: 'Config',
  other: 'Other',
};

export default function StorageView() {
  const [entries, setEntries] = useState<StorageEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [diskFree, setDiskFree] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<StorageEntry | null>(null);

  const load = useCallback(async () => {
    try {
      const [items, free] = await Promise.all([listStorage(), hostDiskFree()]);
      setEntries(items);
      setDiskFree(free);
    } catch (e) {
      console.error('Failed to load storage:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    try {
      await deleteStorage(deleteTarget.path);
      showToast(`Deleted ${deleteTarget.name}`, 'success', 3000);
      setDeleteTarget(null);
      load();
    } catch (e) {
      showToast(`Delete failed: ${e}`, 'error');
    }
  }, [deleteTarget, load]);

  const totalUsed = entries.reduce((sum, e) => sum + e.actual_bytes, 0);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-edge shrink-0">
        <div>
          <h2 className="text-sm font-semibold">Storage</h2>
          <p className="text-xs text-content/50 mt-0.5">
            Manage disk space used by Clawcage
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs text-content/40 tabular-nums">
          <span>Used: <span className="text-content/70 font-medium">{formatSize(totalUsed)}</span></span>
          {diskFree != null && (
            <span>Free: <span className="text-content/70 font-medium">{formatSize(diskFree)}</span></span>
          )}
        </div>
      </div>

      {/* Usage bar */}
      {diskFree != null && totalUsed > 0 && (
        <div className="px-4 py-2 border-b border-edge shrink-0">
          <div className="h-2 bg-content/5 rounded-full overflow-hidden">
            <div
              className="h-full bg-interactive rounded-full transition-all"
              style={{ width: `${Math.min(100, (totalUsed / (totalUsed + diskFree)) * 100)}%` }}
            />
          </div>
          <div className="flex justify-between mt-1 text-[10px] text-content/30">
            <span>Clawcage: {formatSize(totalUsed)}</span>
            <span>{formatSize(diskFree)} available</span>
          </div>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <span className="spinner w-5 h-5 text-content/30" />
          </div>
        ) : entries.length === 0 ? (
          <div className="flex items-center justify-center h-full text-content/30 text-sm">
            No Clawcage data found
          </div>
        ) : (
          <div className="divide-y divide-edge/50">
            {entries.map((entry) => (
              <div
                key={entry.path}
                className="flex items-center gap-3 px-4 py-3 hover:bg-surface-alt/30 transition-colors"
              >
                {/* Kind badge */}
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0 ${KIND_BADGE[entry.kind] ?? KIND_BADGE.other}`}>
                  {KIND_LABEL[entry.kind] ?? entry.kind}
                </span>

                {/* Name */}
                <div className="flex-1 min-w-0">
                  <span className="text-sm text-content/80 truncate block">{entry.name}</span>
                  <span className="text-[10px] text-content/25 font-mono truncate block">{entry.path}</span>
                </div>

                {/* Size */}
                <div className="text-right shrink-0 w-28">
                  <span className="text-xs text-content/50 tabular-nums font-mono">
                    {formatSize(entry.actual_bytes)}
                  </span>
                  {entry.kind === 'venv' && entry.size_bytes !== entry.actual_bytes && (
                    <span className="block text-[10px] text-content/25 tabular-nums">
                      allocated {formatSize(entry.size_bytes)}
                    </span>
                  )}
                </div>

                {/* Delete */}
                {entry.deletable ? (
                  <button
                    className="p-1.5 rounded-md text-content/30 hover:text-denied hover:bg-denied/10 transition-colors shrink-0"
                    onClick={() => setDeleteTarget(entry)}
                    title="Delete"
                  >
                    <TrashIcon className="size-3.5" />
                  </button>
                ) : (
                  <div className="w-8 shrink-0" />
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Delete confirmation */}
      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title="Delete Storage"
        message={deleteTarget ? `Delete "${deleteTarget.name}"? This will free ${formatSize(deleteTarget.size_bytes)}. This action cannot be undone.` : ''}
        confirmLabel="Delete"
        variant="danger"
      />
    </div>
  );
}
