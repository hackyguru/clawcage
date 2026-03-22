// Sidebar component
import { useSidebar } from '../stores/sidebar';
import { useVenvs, closeVenv } from '../stores/venvs';
import { HomeIcon, TerminalIcon, PortsIcon, FolderIcon, LogsIcon, StatsIcon, VpnIcon, SettingsIcon } from '../icons/Icons';
import type { ViewName } from '../types';
import type { FC } from 'react';

const vmItems: { view: ViewName; label: string; Icon: FC<{ className?: string }> }[] = [
  { view: 'terminal', label: 'Console', Icon: TerminalIcon },
  { view: 'ports', label: 'Ports', Icon: PortsIcon },
  { view: 'files', label: 'Files', Icon: FolderIcon },
  { view: 'logs', label: 'Logs', Icon: LogsIcon },
  { view: 'stats', label: 'Stats', Icon: StatsIcon },
  { view: 'vpn', label: 'VPN', Icon: VpnIcon },
  { view: 'settings', label: 'Settings', Icon: SettingsIcon },
];

function SidebarButton({ label, Icon, active, onClick }: {
  label: string; Icon: FC<{ className?: string }>; active: boolean; onClick: () => void;
}) {
  return (
    <li>
      <button
        className={`flex items-center justify-center w-9 h-9 rounded-lg transition-all duration-100 focus:outline-none focus:ring-1 focus:ring-white/20 ${
          active
            ? 'bg-interactive/15 text-interactive'
            : 'text-content/40 hover:bg-content/8 hover:text-content/70'
        }`}
        onClick={onClick}
        aria-label={label}
        title={label}
      >
        <Icon className="size-4.5" />
      </button>
    </li>
  );
}

export default function Sidebar() {
  const { activeView, setView } = useSidebar();
  const { activeVenvId } = useVenvs();

  const goHome = () => {
    closeVenv();
    setView('home');
  };

  return (
    <aside className="flex flex-col shrink-0 border-r border-edge glass w-12 overflow-hidden" role="complementary" aria-label="Sidebar navigation">
      {/* Logo -- vertically centered with the content header row */}
      <div className="flex items-center justify-center pt-5 pb-3 shrink-0">
        <img src="/logo.svg" alt="Clawcage" className="size-7 opacity-60" style={{ filter: 'var(--logo-filter, invert(1))' }} />
      </div>
      <nav className="flex-1 py-3" aria-label="Main navigation">
        <ul className="flex flex-col gap-1 px-1.5">
          {/* Home always visible */}
          <SidebarButton
            label="Environments"
            Icon={HomeIcon}
            active={activeView === 'home'}
            onClick={goHome}
          />

          {/* VM-specific nav only when a venv is open */}
          {activeVenvId && (
            <>
              <li><div className="border-t border-edge my-1.5 mx-1" /></li>
              {vmItems.map((item) => (
                <SidebarButton
                  key={item.view}
                  label={item.label}
                  Icon={item.Icon}
                  active={activeView === item.view}
                  onClick={() => setView(item.view)}
                />
              ))}
            </>
          )}
        </ul>
      </nav>
    </aside>
  );
}
