// PortsView -- shows detected guest VM ports with forwarding controls,
// plus an optional "Show processes" toggle to reveal all running processes.
import { useState } from 'react';
import { usePorts, forwardPortAction, stopForwardAction } from '../stores/ports';
import { useProcesses, killProcessAction } from '../stores/processes';
import { showToast } from '../stores/toast';

function formatRuntime(secs: number): string {
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return `${h}h ${m}m`;
}

function formatMemory(kb: number): string {
  if (kb < 1024) return `${kb} KB`;
  if (kb < 1048576) return `${(kb / 1024).toFixed(1)} MB`;
  return `${(kb / 1048576).toFixed(1)} GB`;
}

export default function PortsView() {
  const { detected, forwarded, loading, error } = usePorts();
  const { processes } = useProcesses();
  const [showProcesses, setShowProcesses] = useState(false);

  const isForwarded = (port: number) => forwarded.some((f) => f.guest_port === port);
  const getHostPort = (port: number) => forwarded.find((f) => f.guest_port === port)?.host_port;

  // Non-port processes (those without a listening port)
  const portPids = new Set(detected.map((d) => d.pid));
  const nonPortProcesses = processes.filter((p) => p.port == null && !portPids.has(p.pid));

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-edge shrink-0">
        <div>
          <h2 className="text-sm font-semibold">Ports</h2>
          <p className="text-xs text-content/50 mt-0.5">
            Detected listening ports inside the VM
          </p>
        </div>
        <div className="flex items-center gap-3">
          {detected.length > 0 && (
            <span className="text-xs text-content/40">
              {detected.length} port{detected.length !== 1 ? 's' : ''}
            </span>
          )}
          {/* Show processes toggle */}
          <label className="flex items-center gap-1.5 cursor-pointer select-none">
            <span className="text-[11px] text-content/40">Processes</span>
            <button
              role="switch"
              aria-checked={showProcesses}
              onClick={() => setShowProcesses(!showProcesses)}
              className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${showProcesses ? 'bg-interactive' : 'bg-content/15'}`}
            >
              <span className={`inline-block size-2.5 rounded-full bg-white transition-transform ${showProcesses ? 'translate-x-3.5' : 'translate-x-1'}`} />
            </button>
          </label>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="px-4 py-2 bg-denied/10 text-denied text-xs border-b border-edge">
          {error}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <span className="spinner w-4 h-4 text-content/30" />
          </div>
        ) : detected.length === 0 && (!showProcesses || nonPortProcesses.length === 0) ? (
          <div className="flex flex-col items-center justify-center h-full text-content/30 text-sm gap-2">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="size-8 opacity-40">
              <path d="M12 22v-6M12 8V2M4 12H2M10 12H8M16 12h-2M22 12h-2" strokeLinecap="round" strokeLinejoin="round" />
              <circle cx="12" cy="12" r="2" />
            </svg>
            <p>No listening ports detected</p>
            <p className="text-xs text-content/20">
              Start a server inside the VM (e.g. npm run dev) and it will appear here
            </p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-edge text-xs text-content/50">
                <th className="text-left font-medium px-4 py-2">Port</th>
                <th className="text-left font-medium px-4 py-2">Process</th>
                <th className="text-left font-medium px-4 py-2">PID</th>
                {showProcesses && (
                  <>
                    <th className="text-right font-medium px-4 py-2">CPU</th>
                    <th className="text-right font-medium px-4 py-2">Memory</th>
                    <th className="text-right font-medium px-4 py-2">Runtime</th>
                  </>
                )}
                <th className="text-left font-medium px-4 py-2">Status</th>
                <th className="text-right font-medium px-4 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {/* Port rows */}
              {detected
                .slice()
                .sort((a, b) => a.port - b.port)
                .map((p) => {
                  const fwd = isForwarded(p.port);
                  const hostPort = getHostPort(p.port);
                  // Find matching process for extra info
                  const proc = processes.find((pr) => pr.port === p.port || pr.pid === p.pid);
                  return (
                    <tr
                      key={`port-${p.port}`}
                      className="border-b border-edge/50 hover:bg-surface-alt/30 transition-colors"
                    >
                      <td className="px-4 py-2.5">
                        <span className="font-mono font-medium">{p.port}</span>
                      </td>
                      <td className="px-4 py-2.5">
                        <span className="font-mono text-content/70">{p.process}</span>
                      </td>
                      <td className="px-4 py-2.5">
                        <span className="font-mono text-content/50 text-xs">{p.pid}</span>
                      </td>
                      {showProcesses && (
                        <>
                          <td className="px-4 py-2.5 text-right">
                            <span className={`font-mono text-xs ${(proc?.cpu_percent ?? 0) > 50 ? 'text-denied' : (proc?.cpu_percent ?? 0) > 20 ? 'text-caution' : 'text-content/70'}`}>
                              {proc ? `${proc.cpu_percent.toFixed(1)}%` : '--'}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 text-right">
                            <span className="font-mono text-xs text-content/70">
                              {proc ? formatMemory(proc.mem_kb) : '--'}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 text-right">
                            <span className="font-mono text-xs text-content/50">
                              {proc ? formatRuntime(proc.runtime_secs) : '--'}
                            </span>
                          </td>
                        </>
                      )}
                      <td className="px-4 py-2.5">
                        {fwd ? (
                          <span className="inline-flex items-center gap-1.5">
                            <span className="size-1.5 rounded-full bg-allowed animate-pulse" />
                            <span className="text-xs text-allowed font-medium">Forwarded</span>
                            <button
                              className="text-xs text-content/40 font-mono hover:text-interactive transition-colors"
                              onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(`localhost:${hostPort}`); showToast('Copied to clipboard', 'success', 2000); }}
                              title="Copy address"
                            >
                              localhost:{hostPort} <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="size-3 inline-block ml-0.5"><rect width="14" height="14" x="8" y="8" rx="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" /></svg>
                            </button>
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5">
                            <span className="size-1.5 rounded-full bg-content/20" />
                            <span className="text-xs text-content/50">Detected</span>
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          {fwd ? (
                            <button
                              className="px-2.5 py-1 text-xs rounded-md border border-edge hover:bg-denied/10 hover:text-denied hover:border-denied/30 transition-colors font-medium"
                              onClick={() => stopForwardAction(p.port)}
                            >
                              Stop
                            </button>
                          ) : (
                            <button
                              className="px-2.5 py-1 text-xs rounded-md bg-interactive text-on-interactive hover:opacity-90 transition-opacity font-medium"
                              onClick={() => forwardPortAction(p.port)}
                            >
                              Forward
                            </button>
                          )}
                          {showProcesses && (
                            <button
                              className="px-2 py-1 text-xs rounded-md border border-edge hover:bg-denied/10 hover:text-denied hover:border-denied/30 transition-colors"
                              onClick={() => killProcessAction(p.pid)}
                              title="Kill process"
                            >
                              Kill
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}

              {/* Non-port process rows (only when toggle is on) */}
              {showProcesses && nonPortProcesses.length > 0 && (
                <>
                  {detected.length > 0 && (
                    <tr>
                      <td colSpan={8} className="px-4 pt-3 pb-1">
                        <span className="text-[10px] uppercase tracking-wider text-content/30 font-semibold">
                          Other processes
                        </span>
                      </td>
                    </tr>
                  )}
                  {nonPortProcesses
                    .slice()
                    .sort((a, b) => b.cpu_percent - a.cpu_percent)
                    .map((p) => (
                      <tr
                        key={`proc-${p.pid}`}
                        className="border-b border-edge/50 hover:bg-surface-alt/30 transition-colors"
                      >
                        <td className="px-4 py-2.5">
                          <span className="text-xs text-content/20">--</span>
                        </td>
                        <td className="px-4 py-2.5">
                          <span className="font-mono text-content/70">{p.name}</span>
                        </td>
                        <td className="px-4 py-2.5">
                          <span className="font-mono text-content/50 text-xs">{p.pid}</span>
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <span className={`font-mono text-xs ${p.cpu_percent > 50 ? 'text-denied' : p.cpu_percent > 20 ? 'text-caution' : 'text-content/70'}`}>
                            {p.cpu_percent.toFixed(1)}%
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <span className="font-mono text-xs text-content/70">
                            {formatMemory(p.mem_kb)}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <span className="font-mono text-xs text-content/50">
                            {formatRuntime(p.runtime_secs)}
                          </span>
                        </td>
                        <td className="px-4 py-2.5">
                          <span className="text-xs text-content/20">--</span>
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <button
                            className="px-2 py-1 text-xs rounded-md border border-edge hover:bg-denied/10 hover:text-denied hover:border-denied/30 transition-colors"
                            onClick={() => killProcessAction(p.pid)}
                            title="Kill process"
                          >
                            Kill
                          </button>
                        </td>
                      </tr>
                    ))}
                </>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
