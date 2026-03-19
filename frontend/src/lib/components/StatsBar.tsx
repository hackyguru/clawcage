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
    <div className="flex items-center gap-4 px-3 py-1.5 glass text-xs select-none border-t border-edge">
      <span className="font-mono text-content/40 tabular-nums">{totalTokens} tok</span>
      <span className="text-content/15">·</span>
      <span className="font-mono text-content/40 tabular-nums">{toolCount} tools</span>
      <span className="text-content/15">·</span>
      <span className="font-mono text-content/40 tabular-nums">{totalCost}</span>
      <span className="flex-1" />
      <button
        className="text-content/30 hover:text-interactive transition-colors"
        onClick={() => setView('stats')}
      >
        Stats &rsaquo;
      </button>
    </div>
  );
}
