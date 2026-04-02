// PortsView -- shows detected guest VM ports with forwarding controls,
// plus an optional "Show processes" toggle to reveal all running processes.
import { useState, useCallback } from 'react';
import { usePorts, forwardPortAction, stopForwardAction } from '../stores/ports';
import { useProcesses, killProcessAction } from '../stores/processes';
import { showToast } from '../stores/toast';
import { openInBrowser } from '../stores/sidebar';
import Dialog from '../components/Dialog';

const ICON_BTN = 'p-1.5 rounded-md transition-colors';
const ICON_BTN_DEFAULT = `${ICON_BTN} text-content/40 hover:text-interactive hover:bg-interactive/10`;
const ICON_BTN_DANGER = `${ICON_BTN} text-content/40 hover:text-denied hover:bg-denied/10`;

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

// Internal VM ports that should not appear in the user-facing list.
const HIDDEN_PORTS = new Set([53, 10443]); // dnsmasq, clawcage-net-proxy

export default function PortsView() {
  const { detected: allDetected, forwarded, loading, error } = usePorts();
  const detected = allDetected.filter((d) => !HIDDEN_PORTS.has(d.port));
  const { processes } = useProcesses();
  const [showProcesses, setShowProcesses] = useState(false);
  const [forwardDialog, setForwardDialog] = useState<number | null>(null);
  const [dialogHostPort, setDialogHostPort] = useState('');

  const openForwardDialog = useCallback((guestPort: number) => {
    setDialogHostPort(String(guestPort));
    setForwardDialog(guestPort);
  }, []);

  const handleForward = useCallback(() => {
    if (forwardDialog === null) return;
    const hp = parseInt(dialogHostPort, 10);
    if (isNaN(hp) || hp < 1 || hp > 65535) {
      showToast('Invalid port number', 'error');
      return;
    }
    forwardPortAction(forwardDialog, hp === forwardDialog ? undefined : hp);
    setForwardDialog(null);
  }, [forwardDialog, dialogHostPort]);

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
            <input
              type="checkbox"
              className="toggle-switch"
              checked={showProcesses}
              onChange={(e) => setShowProcesses(e.target.checked)}
            />
            <span className="text-[11px] text-content/40">Processes</span>
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
          <table className="w-full text-sm table-fixed">
            <colgroup>
              <col className="w-16" />
              <col />
              <col className="w-14" />
              {showProcesses && (
                <>
                  <col className="w-14" />
                  <col className="w-18" />
                  <col className="w-18" />
                </>
              )}
              <col className="w-20" />
              <col className="w-32" />
              <col className="w-24" />
            </colgroup>
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
                <th className="text-left font-medium px-4 py-2">Forwarded</th>
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
                        <span className="inline-flex items-center gap-1.5">
                          <span className={`size-1.5 rounded-full ${fwd ? 'bg-allowed animate-pulse' : 'bg-content/20'}`} />
                          <span className={`text-xs font-medium ${fwd ? 'text-allowed' : 'text-content/50'}`}>
                            {fwd ? 'Forwarded' : 'Detected'}
                          </span>
                        </span>
                      </td>
                      <td className="px-4 py-2.5">
                        {fwd && hostPort && (
                          <button
                            className="inline-flex items-center gap-1 text-xs font-mono text-content/60 hover:text-interactive transition-colors"
                            onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(`localhost:${hostPort}`); showToast('Copied to clipboard', 'success', 2000); }}
                            title="Copy address"
                          >
                            :{hostPort}
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="size-3 shrink-0"><rect width="14" height="14" x="8" y="8" rx="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" /></svg>
                          </button>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <button className={ICON_BTN_DEFAULT} onClick={() => openInBrowser(p.port)} title="Preview in browser">
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="size-3.5"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
                          </button>
                          {fwd ? (
                            <button className={ICON_BTN_DANGER} onClick={() => stopForwardAction(p.port)} title="Stop forwarding">
                              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="size-3.5"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>
                            </button>
                          ) : (
                            <button className={ICON_BTN_DEFAULT} onClick={() => openForwardDialog(p.port)} title="Forward port to host">
                              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="size-3.5"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>
                            </button>
                          )}
                          <button className={ICON_BTN_DANGER} onClick={() => killProcessAction(p.pid)} title="Kill process">
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="size-3.5"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
                          </button>
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
                          <button className={ICON_BTN_DANGER} onClick={() => killProcessAction(p.pid)} title="Kill process">
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="size-3.5"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
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

      {/* Forward port dialog */}
      <Dialog open={forwardDialog !== null} onClose={() => setForwardDialog(null)} title="Forward Port" width="max-w-sm">
        {forwardDialog !== null && (
          <div className="flex flex-col gap-4">
            <p className="text-xs text-content/50">
              Forward guest port <span className="font-mono font-medium text-content">{forwardDialog}</span> to a host port.
            </p>
            <div>
              <label className="text-xs text-content/50 mb-1 block">Host Port</label>
              <input
                type="number"
                min={1}
                max={65535}
                className="w-full px-2.5 py-1.5 text-sm font-mono border border-edge rounded-md bg-surface focus:outline-none focus:ring-2 focus:ring-interactive/40 tabular-nums"
                value={dialogHostPort}
                onChange={(e) => setDialogHostPort(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleForward(); }}
                autoFocus
              />
              <p className="text-[11px] text-content/30 mt-1">
                Access at <span className="font-mono">localhost:{dialogHostPort || forwardDialog}</span>
              </p>
            </div>
            <div className="flex items-center justify-end gap-2">
              <button
                className="px-3 py-1.5 text-sm rounded-lg hover:bg-surface-alt transition-colors"
                onClick={() => setForwardDialog(null)}
              >
                Cancel
              </button>
              <button
                className="px-3 py-1.5 text-sm rounded-lg bg-interactive text-on-interactive hover:opacity-90 transition font-medium"
                onClick={handleForward}
              >
                Forward
              </button>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}
