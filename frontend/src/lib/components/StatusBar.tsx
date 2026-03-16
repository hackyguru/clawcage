// StatusBar component
import { useVm } from '../stores/vm';
import { useVenvs } from '../stores/venvs';
import { useTheme } from '../stores/theme';
import { SunIcon, MoonIcon } from '../icons/Icons';
import VmStateIndicator from './VmStateIndicator';

export default function StatusBar() {
  const { terminalRenderer } = useVm();
  const { activeVenv } = useVenvs();
  const { theme, toggle } = useTheme();

  return (
    <footer className="flex shrink-0 items-center justify-between border-t border-base-300 bg-base-100 px-3 py-1 text-xs text-base-content/50">
      <div className="flex items-center gap-3">
        {activeVenv && (
          <span className="font-medium text-base-content/70">{activeVenv.name}</span>
        )}
        <VmStateIndicator />
        {terminalRenderer && (
          <span className="text-base-content/30">
            {terminalRenderer === 'webgl' ? 'WebGL' : 'Canvas'}
          </span>
        )}
      </div>
      <button
        className="flex items-center justify-center w-5 h-5 rounded hover:bg-base-300 text-base-content/40 hover:text-base-content/70 transition-colors"
        onClick={toggle}
        aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
      >
        {theme === 'dark' ? <SunIcon className="size-3.5" /> : <MoonIcon className="size-3.5" />}
      </button>
    </footer>
  );
}
