// DownloadProgress component
import { useVm } from '../stores/vm';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function DownloadProgress() {
  const { downloadProgress: progress } = useVm();
  const pct = progress && progress.total_bytes > 0
    ? Math.round((progress.bytes_downloaded / progress.total_bytes) * 100)
    : 0;
  const downloaded = progress ? formatBytes(progress.bytes_downloaded) : '0 B';
  const total = progress && progress.total_bytes > 0 ? formatBytes(progress.total_bytes) : '...';

  return (
  <div className="flex items-center justify-center h-full bg-[--color-base-100]">
      <div className="flex flex-col items-center gap-6 max-w-md w-full px-8">
  <h2 className="text-xl font-semibold text-neutral-900">Downloading VM image</h2>
  <p className="text-sm text-neutral-600 text-center">
          The sandbox rootfs is downloaded once and cached locally.
          {progress?.phase === 'verifying' && ' Verifying integrity...'}
          {progress?.phase === 'connecting' && ' Connecting...'}
        </p>
        <div className="w-full">
          <progress
            className="progress w-full h-3 [&::-webkit-progress-value]:bg-allowed [&::-moz-progress-bar]:bg-allowed"
            value={pct}
            max={100}
          />
        </div>
  <div className="flex justify-between w-full text-xs text-neutral-500">
          <span>{downloaded} / {total}</span>
          <span>{pct}%</span>
        </div>
      </div>
    </div>
  );
}
