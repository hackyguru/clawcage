// PortsView -- shows detected guest VM ports with forwarding controls
import { usePorts, forwardPortAction, stopForwardAction } from '../stores/ports';
import { showToast } from '../stores/toast';

export default function PortsView() {
  const { detected, forwarded, loading, error } = usePorts();

  const isForwarded = (port: number) => forwarded.some((f) => f.guest_port === port);
  const getHostPort = (port: number) => forwarded.find((f) => f.guest_port === port)?.host_port;

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
        {detected.length > 0 && (
          <span className="text-xs text-content/40">
            {detected.length} port{detected.length !== 1 ? 's' : ''} detected
          </span>
        )}
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
        ) : detected.length === 0 ? (
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
                <th className="text-left font-medium px-4 py-2">Status</th>
                <th className="text-right font-medium px-4 py-2">Action</th>
              </tr>
            </thead>
            <tbody>
              {detected
                .slice()
                .sort((a, b) => a.port - b.port)
                .map((p) => {
                  const fwd = isForwarded(p.port);
                  const hostPort = getHostPort(p.port);
                  return (
                    <tr
                      key={p.port}
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
                      <td className="px-4 py-2.5">
                        {fwd ? (
                          <span className="inline-flex items-center gap-1.5">
                            <span className="size-1.5 rounded-full bg-allowed animate-pulse" />
                            <span className="text-xs text-allowed font-medium">
                              Forwarded
                            </span>
                            <button
                              className="text-xs text-content/40 font-mono hover:text-interactive transition-colors"
                              onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(`localhost:${hostPort}`); showToast('Copied to clipboard', 'success', 2000); }}
                              title="Copy address"
                            >
                              localhost:{hostPort} 📋
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
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
