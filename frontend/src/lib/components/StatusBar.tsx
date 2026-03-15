// StatusBar component
import { useVm } from '../stores/vm';
import VmStateIndicator from './VmStateIndicator';

export default function StatusBar() {
  const { terminalRenderer } = useVm();

  return (
    <footer className="flex flex-shrink-0 items-center justify-between border-t border-base-300 bg-base-200 px-3 py-1 text-xs text-base-content/60">
      <div className="flex items-center gap-2">
        <VmStateIndicator />
        {terminalRenderer && (
          <span className="text-base-content/40">
            {terminalRenderer === 'webgl' ? 'WebGL' : 'Canvas'}
          </span>
        )}
      </div>
    </footer>
  );
}
