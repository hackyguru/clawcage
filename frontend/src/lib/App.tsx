// App -- main shell component
import { useEffect, lazy, Suspense, Component, useCallback, type ReactNode, type ErrorInfo } from 'react';
import { useSidebar } from './stores/sidebar';
import { useVm, initVm } from './stores/vm';
import { useVenvs } from './stores/venvs';
import { loadSettings } from './stores/settings';
import { initTheme } from './stores/theme';
import ToastContainer from './components/ToastContainer';
import { showToast } from './stores/toast';
import type { ViewName } from './types';

import Sidebar from './components/Sidebar';
import StatusBar from './components/StatusBar';
import DownloadProgress from './components/DownloadProgress';

import TerminalView from './views/TerminalView';
import HomeView from './views/HomeView';

// Lazy-load heavy views (StatsView pulls in recharts ~700KB)
const StatsView = lazy(() => import('./views/StatsView'));
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
  const { activeVenvId } = useVenvs();

  // Keyboard shortcuts: Cmd+1 = Console, Cmd+2 = Stats, Cmd+3 = Settings
  const viewKeys: Record<string, ViewName> = { '1': 'terminal', '2': 'stats', '3': 'settings' };
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
  }, []);

  const currentView = activeView;

  return (
  <div className="flex h-screen w-screen overflow-hidden bg-surface text-content">
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
        <div className="flex-1 min-h-0 overflow-hidden">
          {currentView === 'home' && <HomeView />}
          {currentView === 'terminal' && <TerminalView key={activeVenvId ?? 'none'} />}
          <Suspense fallback={<div className="flex items-center justify-center h-full"><span className="spinner w-6 h-6 text-content/30" /></div>}>
            {currentView === 'stats' && <StatsView />}
            {currentView === 'settings' && <SettingsView />}
          </Suspense>
        </div>

        {/* Status bar */}
        <StatusBar />
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
