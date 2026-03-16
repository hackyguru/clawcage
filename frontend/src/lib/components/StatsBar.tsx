// StatsBar component
import { useEffect } from 'react';
import { useStats, startStats, stopStats } from '../stores/stats';
import { useSidebar } from '../stores/sidebar';

export default function StatsBar() {
  const { totalTokens, toolCount, totalCost } = useStats();
  const { setView } = useSidebar();

  useEffect(() => {
    startStats();
    return () => stopStats();
  }, []);

  return (
    <div className="flex items-center gap-4 px-3 py-1.5 bg-neutral-950 text-xs select-none border-t border-white/5">
      <span className="font-mono text-neutral-500 tabular-nums">{totalTokens} tok</span>
      <span className="text-neutral-700">·</span>
      <span className="font-mono text-neutral-500 tabular-nums">{toolCount} tools</span>
      <span className="text-neutral-700">·</span>
      <span className="font-mono text-neutral-500 tabular-nums">{totalCost}</span>
      <span className="flex-1" />
      <button
        className="text-neutral-600 hover:text-interactive transition-colors"
        onClick={() => setView('stats')}
      >
        Stats &rsaquo;
      </button>
    </div>
  );
}
