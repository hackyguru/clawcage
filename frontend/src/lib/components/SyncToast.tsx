// SyncToast — persistent bottom-right toast showing cloud sync progress.
// Always visible during sync, regardless of which view the user is on.
import { useCloudSync } from '../stores/cloudSync';
import { CloudIcon } from '../icons/Icons';

const phaseLabels: Record<string, string> = {
  compressing: 'Compressing',
  encrypting: 'Encrypting',
  uploading: 'Uploading',
  done: 'Done',
};

function formatSize(bytes: number): string {
  if (bytes < 1e6) return `${(bytes / 1e3).toFixed(0)} KB`;
  if (bytes < 1e9) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e9).toFixed(2)} GB`;
}

export default function SyncToast() {
  const { syncingVenvId, phase, bytesProcessed, totalBytes } = useCloudSync();

  if (!syncingVenvId) return null;

  const isDone = phase === 'done';
  const pct = totalBytes > 0 ? Math.round((bytesProcessed / totalBytes) * 100) : 0;
  const label = phaseLabels[phase] ?? phase;

  return (
    <div className="fixed bottom-4 right-4 z-[60] animate-in">
      <div className="bg-surface border border-edge rounded-xl p-3 min-w-[280px] max-w-sm">
        <div className="flex items-center gap-2.5">
          <div className={`flex items-center justify-center size-8 rounded-lg shrink-0 ${isDone ? 'bg-allowed/15 ring-2 ring-allowed/30' : 'bg-allowed/10'}`}>
            {isDone ? (
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-4 h-4 text-allowed"><path d="M20 6 9 17l-5-5"/></svg>
            ) : (
              <CloudIcon className="w-4 h-4 text-allowed animate-pulse" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-medium truncate">
                {isDone ? 'Sync complete' : `${label}...`}
              </p>
              {!isDone && phase === 'uploading' && totalBytes > 0 && (
                <span className="text-[10px] text-content/40 tabular-nums">{pct}%</span>
              )}
            </div>
            {!isDone && (
              <div className="mt-1.5 w-full h-1 rounded-full bg-content/10 overflow-hidden">
                <div
                  className="h-full bg-allowed rounded-full transition-all duration-300"
                  style={{ width: phase === 'uploading' && totalBytes > 0 ? `${pct}%` : '100%', opacity: phase === 'uploading' ? 1 : 0.3 }}
                />
              </div>
            )}
            {phase === 'uploading' && totalBytes > 0 && (
              <p className="text-[10px] text-content/30 mt-1 tabular-nums">
                {formatSize(bytesProcessed)} / {formatSize(totalBytes)}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
