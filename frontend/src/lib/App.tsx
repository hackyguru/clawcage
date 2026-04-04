// App -- main shell component
import { useEffect, useState, lazy, Suspense, Component, useCallback, type ReactNode, type ErrorInfo } from 'react';
import { useSidebar } from './stores/sidebar';
import { useVm, initVm } from './stores/vm';
import { useVenvs, loadVenvs, startVenvListener } from './stores/venvs';
import { loadSettings } from './stores/settings';
import { initTheme } from './stores/theme';
import ToastContainer from './components/ToastContainer';
import { showToast } from './stores/toast';
import { hostDiskFree } from './api';
import { startPorts } from './stores/ports';
import { startProcesses } from './stores/processes';
import { startNotificationHooks } from './stores/notificationHooks';
import type { ViewName } from './types';
import WizardView from './views/WizardView';

import Sidebar from './components/Sidebar';
import TitleBar from './components/TitleBar';
import StatusBar from './components/StatusBar';
import DownloadProgress from './components/DownloadProgress';

import TerminalView from './views/TerminalView';
import HomeView from './views/HomeView';

// Lazy-load heavy views (StatsView pulls in recharts ~700KB)
const PortsView = lazy(() => import('./views/PortsView'));
const StorageView = lazy(() => import('./views/StorageView'));
const CloudView = lazy(() => import('./views/CloudView'));
const BrowserView = lazy(() => import('./views/BrowserView'));
const FilesView = lazy(() => import('./views/FilesView'));
const LogsView = lazy(() => import('./views/LogsView'));
const StatsView = lazy(() => import('./views/StatsView'));
const VpnView = lazy(() => import('./views/VpnView'));
const SettingsView = lazy(() => import('./views/SettingsView'));

// Error boundary to catch rendering crashes
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, color: '#f66', fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}>
          <h2>UI Error</h2>
          <p>{this.state.error.message}</p>
          <pre style={{ fontSize: 11, opacity: 0.7, marginTop: 8 }}>{this.state.error.stack}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

function AppInner() {
  const { activeView, setView } = useSidebar();
  const { isDownloading, downloadProgress } = useVm();
  const { activeVenvId, venvs, initialized: venvsInitialized } = useVenvs();
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);

  // Show onboarding only after venvs have loaded to prevent flash for returning users
  const showOnboarding = venvsInitialized && venvs.length === 0 && !onboardingDismissed;

  // Keyboard shortcuts: Cmd+1..8 for views
  const viewKeys: Record<string, ViewName> = { '1': 'terminal', '2': 'ports', '3': 'files', '4': 'logs', '5': 'stats', '6': 'vpn', '7': 'settings' };
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && viewKeys[e.key]) {
      e.preventDefault();
      setView(viewKeys[e.key]);
    }
  }, [setView]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // Initialize on mount
  useEffect(() => {
    initTheme();
    initVm().catch((e) => showToast('Failed to initialize VM: ' + String(e), 'error'));
    loadSettings().catch((e) => showToast('Failed to load settings: ' + String(e), 'error'));
    loadVenvs().catch((e) => showToast('Failed to load environments: ' + String(e), 'error'));
    startVenvListener();
    startNotificationHooks();
    startPorts();
    startProcesses();

    // Periodic host disk space check (every 30s).
    const LOW_DISK_THRESHOLD = 2 * 1024 * 1024 * 1024; // 2 GB
    let warned = false;
    const checkDisk = () => {
      hostDiskFree().then((free) => {
        if (free < LOW_DISK_THRESHOLD && !warned) {
          warned = true;
          const gb = (free / (1024 * 1024 * 1024)).toFixed(1);
          showToast(`Low disk space: ${gb} GB free. VMs may experience I/O errors.`, 'warning', 10000);
        } else if (free >= LOW_DISK_THRESHOLD) {
          warned = false;
        }
      }).catch(() => {});
    };
    checkDisk();
    const diskIv = setInterval(checkDisk, 30000);
    return () => clearInterval(diskIv);
  }, []);

  const currentView = activeView;

  // Show onboarding wizard if no environments exist yet
  if (showOnboarding) {
    return (
      <div className="flex flex-col h-screen w-screen overflow-hidden bg-surface text-content rounded-[10px] border border-edge">
        <TitleBar />
        <ToastContainer />
        <WizardView onComplete={() => setOnboardingDismissed(true)} />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-surface text-content rounded-[10px] border border-edge">
      <TitleBar />
      <div className="flex flex-1 min-h-0 overflow-hidden">
        <Sidebar />
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden relative">
          {/* Download overlay */}
          {isDownloading && downloadProgress && (
            <div className="absolute inset-0 z-50 flex items-center justify-center bg-surface/90 backdrop-blur-sm">
              <DownloadProgress />
            </div>
          )}

          {/* Toast notifications */}
          <ToastContainer />

          {/* Main content area */}
          <div className="flex-1 min-h-0 overflow-hidden relative">
            {currentView === 'home' && <HomeView />}
            {currentView === 'storage' && <Suspense fallback={<div className="flex items-center justify-center h-full"><span className="spinner w-6 h-6 text-content/30" /></div>}><StorageView /></Suspense>}
            {currentView === 'cloud' && <Suspense fallback={<div className="flex items-center justify-center h-full"><span className="spinner w-6 h-6 text-content/30" /></div>}><CloudView /></Suspense>}
            {/* Keep TerminalView mounted (hidden) so xterm state survives view switches */}
            {activeVenvId && (
              <div
                className="absolute inset-0"
                style={{ display: currentView === 'terminal' ? 'block' : 'none' }}
              >
                <TerminalView key={activeVenvId} />
              </div>
            )}
            <Suspense fallback={<div className="flex items-center justify-center h-full"><span className="spinner w-6 h-6 text-content/30" /></div>}>
              {currentView === 'ports' && <PortsView />}
              {currentView === 'browser' && <BrowserView />}
              {currentView === 'files' && <FilesView />}
              {currentView === 'logs' && <LogsView />}
              {currentView === 'stats' && <StatsView />}
              {currentView === 'vpn' && <VpnView />}
              {currentView === 'settings' && <SettingsView />}
            </Suspense>
          </div>

          {/* Status bar */}
          <StatusBar />
        </div>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <AppInner />
    </ErrorBoundary>
  );
}
