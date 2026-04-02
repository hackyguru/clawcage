// BrowserView — in-app browser for previewing guest VM ports without forwarding
import { useState, useEffect, useCallback, useRef } from 'react';
import { startBrowserProxy, stopBrowserProxy } from '../api';
import { usePorts } from '../stores/ports';
import { consumePendingBrowserPort } from '../stores/sidebar';
import { showToast } from '../stores/toast';
import { GlobeIcon, PlusIcon, CloseIcon, RefreshIcon } from '../icons/Icons';

interface BrowserTab {
  guestPort: number;
  hostPort: number;
  label: string;
}

export default function BrowserView() {
  const [tabs, setTabs] = useState<BrowserTab[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [showPortPicker, setShowPortPicker] = useState(false);
  const { detected } = usePorts();
  const iframeRefs = useRef<Map<number, HTMLIFrameElement>>(new Map());
  const mountedRef = useRef(true);

  // Open a guest port in a new browser tab.
  const openTab = useCallback(async (guestPort: number) => {
    // Already open?
    const existing = tabs.findIndex((t) => t.guestPort === guestPort);
    if (existing >= 0) {
      setActiveIdx(existing);
      return;
    }
    try {
      const hostPort = await startBrowserProxy(guestPort);
      if (!mountedRef.current) return;
      setTabs((prev) => {
        const next = [...prev, { guestPort, hostPort, label: `:${guestPort}` }];
        setActiveIdx(next.length - 1);
        return next;
      });
    } catch (e) {
      showToast(`Failed to open port ${guestPort}: ${e}`, 'error');
    }
    setShowPortPicker(false);
  }, [tabs]);

  // Close a tab and stop its proxy.
  const closeTab = useCallback(async (idx: number) => {
    const tab = tabs[idx];
    if (!tab) return;
    await stopBrowserProxy(tab.guestPort).catch(() => {});
    iframeRefs.current.delete(tab.guestPort);
    setTabs((prev) => {
      const next = prev.filter((_, i) => i !== idx);
      setActiveIdx((cur) => cur >= next.length ? Math.max(0, next.length - 1) : cur > idx ? cur - 1 : cur);
      return next;
    });
  }, [tabs]);

  // Refresh the active tab's iframe.
  const refreshActive = useCallback(() => {
    const tab = tabs[activeIdx];
    if (!tab) return;
    const iframe = iframeRefs.current.get(tab.guestPort);
    if (iframe) {
      iframe.src = iframe.src;
    }
  }, [tabs, activeIdx]);

  // Handle pending browser port from PortsView "Open in Browser" action.
  useEffect(() => {
    const port = consumePendingBrowserPort();
    if (port) openTab(port);
  }, []);

  // Cleanup all proxies on unmount.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      tabs.forEach((t) => stopBrowserProxy(t.guestPort).catch(() => {}));
    };
  }, []);

  const activeTab = tabs[activeIdx] ?? null;

  // Ports available to open (not already in a tab).
  const openPorts = tabs.map((t) => t.guestPort);
  const availablePorts = detected.filter((d) => !openPorts.includes(d.port));

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Tab bar */}
      <div className="flex items-center gap-0.5 px-2 py-1 bg-surface border-b border-edge select-none overflow-x-auto shrink-0">
        {tabs.map((tab, i) => (
          <button
            key={tab.guestPort}
            className={`group flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] transition-colors ${
              i === activeIdx
                ? 'bg-content/10 text-content/80'
                : 'text-content/40 hover:text-content/70 hover:bg-content/5'
            }`}
            onClick={() => setActiveIdx(i)}
          >
            <GlobeIcon className="size-3 shrink-0" />
            <span className="truncate max-w-24">{tab.label}</span>
            <span
              className="opacity-0 group-hover:opacity-100 hover:text-denied transition-opacity"
              onClick={(e) => { e.stopPropagation(); closeTab(i); }}
              title="Close tab"
            >
              <CloseIcon className="size-2.5" />
            </span>
          </button>
        ))}
        <div className="relative">
          <button
            className="flex items-center justify-center size-5 rounded text-content/30 hover:text-content/70 hover:bg-content/5 transition-colors ml-0.5"
            onClick={() => setShowPortPicker(!showPortPicker)}
            title="Open port"
          >
            <PlusIcon className="size-3" />
          </button>
          {showPortPicker && (
            <div className="absolute top-7 left-0 z-50 bg-surface border border-edge rounded-lg shadow-xl py-1 min-w-40">
              {availablePorts.length === 0 && detected.length === 0 ? (
                <div className="px-3 py-2 text-xs text-content/40">No ports detected</div>
              ) : availablePorts.length === 0 ? (
                <div className="px-3 py-2 text-xs text-content/40">All ports already open</div>
              ) : (
                availablePorts.map((d) => (
                  <button
                    key={d.port}
                    className="w-full text-left px-3 py-1.5 text-xs hover:bg-surface-alt transition-colors flex items-center gap-2"
                    onClick={() => openTab(d.port)}
                  >
                    <span className="font-mono font-medium">{d.port}</span>
                    <span className="text-content/40 truncate">{d.process}</span>
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      </div>

      {/* Toolbar */}
      {activeTab && (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-surface border-b border-edge shrink-0">
          <button
            className="p-1 rounded hover:bg-surface-alt text-content/40 hover:text-content/70 transition-colors"
            onClick={refreshActive}
            title="Refresh"
          >
            <RefreshIcon className="size-3.5" />
          </button>
          <div className="flex-1 flex items-center px-2.5 py-1 rounded-md bg-surface-alt border border-edge/50 text-xs font-mono text-content/60">
            <span className="text-content/30 mr-1">guest:</span>
            {activeTab.guestPort}
          </div>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 min-h-0 relative">
        {tabs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-content/30 text-sm gap-2">
            <GlobeIcon className="size-8 opacity-30" />
            <p>No browser tabs open</p>
            <p className="text-xs text-content/20">
              Click + to preview a port running in the VM
            </p>
            {detected.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {detected.slice(0, 5).map((d) => (
                  <button
                    key={d.port}
                    className="px-2.5 py-1 text-xs rounded-md border border-edge hover:bg-surface-alt hover:border-interactive/30 transition-colors font-mono"
                    onClick={() => openTab(d.port)}
                  >
                    :{d.port}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          tabs.map((tab, i) => (
            <iframe
              key={tab.guestPort}
              ref={(el) => { if (el) iframeRefs.current.set(tab.guestPort, el); }}
              src={`http://127.0.0.1:${tab.hostPort}`}
              className="absolute inset-0 w-full h-full border-none"
              style={{ display: i === activeIdx ? 'block' : 'none' }}
              title={`Port ${tab.guestPort}`}
              sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals"
            />
          ))
        )}
      </div>

      {/* Close port picker on outside click */}
      {showPortPicker && (
        <div className="fixed inset-0 z-40" onClick={() => setShowPortPicker(false)} />
      )}
    </div>
  );
}
