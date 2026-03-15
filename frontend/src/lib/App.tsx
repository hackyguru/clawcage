// App -- main shell component
import { useEffect, lazy, Suspense, Component, type ReactNode, type ErrorInfo } from 'react';
import { useSidebar } from './stores/sidebar';
import { useVm, initVm } from './stores/vm';
import { loadSettings } from './stores/settings';
import { initTheme } from './stores/theme';

import Sidebar from './components/Sidebar';
import StatusBar from './components/StatusBar';
import DownloadProgress from './components/DownloadProgress';
import ThemeToggle from './components/ThemeToggle';

import TerminalView from './views/TerminalView';

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
  const { activeView } = useSidebar();
  const { isDownloading, downloadProgress } = useVm();
  // Initialize on mount
  useEffect(() => {
    initTheme();
    initVm();
    loadSettings();
  }, []);

  const currentView = activeView;

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-base-100 text-base-content">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden relative">
        {/* Top bar with theme toggle */}
        <div className="flex items-center justify-end px-2 py-1 border-b border-base-300 bg-base-100/80 backdrop-blur-sm z-10">
          <ThemeToggle />
        </div>

        {/* Download overlay */}
        {isDownloading && downloadProgress && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-base-100/90 backdrop-blur-sm">
            <DownloadProgress />
          </div>
        )}

        {/* Main content area */}
        <div className="flex-1 min-h-0 overflow-hidden">
          {currentView === 'terminal' && <TerminalView />}
          <Suspense fallback={<div className="flex items-center justify-center h-full"><span className="loading loading-spinner loading-md" /></div>}>
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
