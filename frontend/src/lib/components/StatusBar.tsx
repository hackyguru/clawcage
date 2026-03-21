// StatusBar component
import { useState, useEffect } from 'react';
import { useVm } from '../stores/vm';
import { useVenvs } from '../stores/venvs';
import { useTheme } from '../stores/theme';
import { SunIcon, MoonIcon } from '../icons/Icons';
import VmStateIndicator from './VmStateIndicator';

const isTauri = typeof window !== 'undefined' && !!(window as any).__TAURI_INTERNALS__;

export default function StatusBar() {
  const { terminalRenderer } = useVm();
  const { activeVenv } = useVenvs();
  const { theme, toggle } = useTheme();
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    if (isTauri) {
      import('@tauri-apps/api/app').then(({ getVersion }) => getVersion()).then(setVersion).catch(() => {});
    } else {
      setVersion('dev');
    }
  }, []);

  return (
    <footer className="flex shrink-0 items-center justify-between border-t border-edge bg-surface px-3 py-1 text-xs text-content/50">
      <div className="flex items-center gap-3">
        {activeVenv && (
          <span className="font-medium text-content/70">{activeVenv.name}</span>
        )}
        <VmStateIndicator />
        {terminalRenderer && (
          <span className="text-content/30">
            {terminalRenderer === 'webgl' ? 'WebGL' : 'Canvas'}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        {version && (
          <span className="text-content/25 text-[10px]">v{version}</span>
        )}
        <button
          className="flex items-center justify-center w-5 h-5 rounded hover:bg-surface-alt text-content/40 hover:text-content/70 transition-colors"
          onClick={toggle}
          aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
        >
          {theme === 'dark' ? <SunIcon className="size-3.5" /> : <MoonIcon className="size-3.5" />}
        </button>
      </div>
    </footer>
  );
}
