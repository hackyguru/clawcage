// TitleBar -- custom frameless window titlebar with traffic light controls
import { useCallback } from 'react';
import { useVenvs } from '../stores/venvs';
import { useSidebar } from '../stores/sidebar';
import { useCloudAuth } from '../stores/cloudAuth';

/** Check if running inside Tauri (not browser dev mode). */
const isTauri = typeof window !== 'undefined' && !!(window as any).__TAURI_INTERNALS__;

async function getWindow() {
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  return getCurrentWindow();
}

function TrafficLights() {
  const handleClose = useCallback(async () => {
    if (!isTauri) return;
    const win = await getWindow();
    await win.close();
  }, []);

  const handleMinimize = useCallback(async () => {
    if (!isTauri) return;
    const win = await getWindow();
    await win.minimize();
  }, []);

  const handleMaximize = useCallback(async () => {
    if (!isTauri) return;
    const win = await getWindow();
    const maximized = await win.isMaximized();
    if (maximized) await win.unmaximize();
    else await win.maximize();
  }, []);

  return (
    <div className="flex items-center gap-2 pl-3 shrink-0 z-10 group" onDoubleClick={(e) => e.stopPropagation()}>
      <button
        className="size-3 rounded-full bg-content/15 hover:bg-[#ff5f57] transition-colors focus:outline-none"
        onClick={handleClose}
        aria-label="Close window"
      />
      <button
        className="size-3 rounded-full bg-content/15 hover:bg-[#febc2e] transition-colors focus:outline-none"
        onClick={handleMinimize}
        aria-label="Minimize window"
      />
      <button
        className="size-3 rounded-full bg-content/15 hover:bg-[#28c840] transition-colors focus:outline-none"
        onClick={handleMaximize}
        aria-label="Maximize window"
      />
    </div>
  );
}

export default function TitleBar() {
  const { activeVenv } = useVenvs();
  const { setView } = useSidebar();
  const { connected: cloudConnected, email: cloudEmail } = useCloudAuth();

  const handleDoubleClick = useCallback(async () => {
    if (!isTauri) return;
    const win = await getWindow();
    const maximized = await win.isMaximized();
    if (maximized) await win.unmaximize();
    else await win.maximize();
  }, []);

  return (
    <header
      data-tauri-drag-region
      className="flex items-center h-10 shrink-0 border-b border-edge select-none titlebar"
      onDoubleClick={handleDoubleClick}
    >
      <TrafficLights />
      <div data-tauri-drag-region className="flex-1" />
      {/* Cloud login / account */}
      <button
        className="flex items-center gap-1.5 text-[11px] text-content/40 hover:text-content/70 transition-colors mr-2 z-10"
        onClick={() => setView('cloud')}
        title={cloudConnected ? cloudEmail ?? 'Cloud connected' : 'Sign in to Clawcage Cloud'}
      >
        {cloudConnected ? (
          <span className="flex items-center gap-1">
            <span className="size-1.5 rounded-full bg-allowed" />
            <span className="hidden sm:inline">{cloudEmail?.split('@')[0]}</span>
          </span>
        ) : (
          <span className="px-2 py-0.5 rounded-md border border-content/15 hover:border-content/30 text-content/50 hover:text-content/70 transition">Sign in</span>
        )}
      </button>
      <span className="flex items-center gap-1.5 text-xs font-medium text-content/40 pointer-events-none pr-3">
        <img src="/logo.svg" alt="" className="size-3.5 opacity-40" style={{ filter: 'var(--logo-filter, invert(1))' }} />
        {activeVenv ? activeVenv.name : 'Clawcage'}
      </span>
    </header>
  );
}
