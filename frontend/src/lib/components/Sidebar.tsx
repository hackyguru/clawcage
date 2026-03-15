// Sidebar component
import { useSidebar } from '../stores/sidebar';
import { TerminalIcon, StatsIcon, SettingsIcon } from '../icons/Icons';
import type { ViewName } from '../types';
import type { FC } from 'react';

const items: { view: ViewName; label: string; Icon: FC<{ className?: string }> }[] = [
  { view: 'terminal', label: 'Console', Icon: TerminalIcon },
  { view: 'stats', label: 'Stats', Icon: StatsIcon },
  { view: 'settings', label: 'Settings', Icon: SettingsIcon },
];

export default function Sidebar() {
  const { activeView, setView } = useSidebar();

  return (
    <aside className="flex flex-col shrink-0 border-r border-blue-900 bg-blue-700 w-12 overflow-hidden">
      <nav className="flex-1 py-2">
        <ul className="flex flex-col gap-1 px-1.5">
          {items.map((item) => (
            <li key={item.view}>
              <button
                className={`flex items-center justify-center px-2 py-2 rounded-lg transition-colors duration-100 focus:outline-none focus:ring-2 focus:ring-blue-300 ${activeView === item.view ? 'bg-blue-900 text-white' : 'hover:bg-blue-800 text-blue-100'}`}
                onClick={() => setView(item.view)}
                title={item.label}
              >
                <item.Icon className="size-5" />
              </button>
            </li>
          ))}
        </ul>
      </nav>
    </aside>
  );
}
