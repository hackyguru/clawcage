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
    <div className="flex items-center gap-4 px-3 py-1 bg-black text-xs text-base-content/60 select-none">
      <span className="font-mono">{totalTokens} tokens</span>
      <span className="text-base-content/20">|</span>
      <span className="font-mono">{toolCount} tools</span>
      <span className="text-base-content/20">|</span>
      <span className="font-mono">{totalCost}</span>
      <span className="flex-1" />
      <button
        className="text-xs text-base-content/50 hover:text-interactive transition-colors"
        onClick={() => setView('stats')}
      >
        Stats &rsaquo;
      </button>
    </div>
  );
}
