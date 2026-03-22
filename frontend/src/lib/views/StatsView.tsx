// StatsView -- tabbed stats panel with sub-menu
import { useStats, setStatsTab } from '../stores/stats';
import SubMenu from '../components/SubMenu';
import AITab from './stats/AITab';
import ToolsTab from './stats/ToolsTab';
import NetworkTab from './stats/NetworkTab';
import FilesTab from './stats/FilesTab';
import SystemTab from './stats/SystemTab';
import type { StatsTab as StatsTabType } from '../types';

const TABS: { id: StatsTabType; label: string }[] = [
  { id: 'ai', label: 'AI' },
  { id: 'tools', label: 'Tools' },
  { id: 'network', label: 'Network' },
  { id: 'files', label: 'Files' },
  { id: 'system', label: 'System' },
];

export default function StatsView() {
  const { activeTab } = useStats();

  return (
    <div className="flex h-full w-full">
      <SubMenu
        groups={[{ label: 'Stats', items: TABS.map((t) => ({ id: t.id, label: t.label })) }]}
        active={activeTab}
        onSelect={(id) => setStatsTab(id as StatsTabType)}
      />
      <div className="flex-1 min-w-0 overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-edge shrink-0">
          <div>
            <h2 className="text-sm font-semibold">Stats</h2>
            <p className="text-xs text-content/50 mt-0.5">Session telemetry and usage analytics</p>
          </div>
        </div>
        <div className="flex-1 min-h-0 overflow-hidden">
          {activeTab === 'ai' && <AITab />}
          {activeTab === 'tools' && <ToolsTab />}
          {activeTab === 'network' && <NetworkTab />}
          {activeTab === 'files' && <FilesTab />}
          {activeTab === 'system' && <SystemTab />}
        </div>
      </div>
    </div>
  );
}
