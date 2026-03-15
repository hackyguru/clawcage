// VmStateIndicator component
import { useVm } from '../stores/vm';

export default function VmStateIndicator({ collapsed = false }: { collapsed?: boolean }) {
  const { vmState } = useVm();

  const dotClass =
    vmState === 'running' ? 'bg-allowed'
    : vmState === 'stopped' || vmState === 'error' ? 'bg-denied'
    : vmState === 'booting' ? 'bg-caution'
  : 'bg-neutral-900';

  const textClass =
    vmState === 'running' ? 'text-allowed'
    : vmState === 'stopped' || vmState === 'error' ? 'text-denied'
    : vmState === 'booting' ? 'text-caution'
    : '';

  return (
    <div className="flex items-center gap-1.5" title={collapsed ? vmState : undefined}>
      <span className={`inline-block size-2 rounded-full ${dotClass}`} />
      {!collapsed && (
        <span className={`text-xs whitespace-nowrap ${textClass}`}>{vmState}</span>
      )}
    </div>
  );
}
