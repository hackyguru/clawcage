// StatusBar component
import { useVm } from '../stores/vm';
import VmStateIndicator from './VmStateIndicator';

export default function StatusBar() {
  const { terminalRenderer } = useVm();

  return (
  <footer className="flex shrink-0 items-center justify-between border-t border-neutral-300 bg-[--color-base-100] px-3 py-1 text-xs text-neutral-600">
      <div className="flex items-center gap-2">
        <VmStateIndicator />
        {terminalRenderer && (
          <span className="text-neutral-400">
            {terminalRenderer === 'webgl' ? 'WebGL' : 'Canvas'}
          </span>
        )}
      </div>
    </footer>
  );
}
