// Sidebar component
import { useSidebar } from '../stores/sidebar';
import { TerminalIcon, SettingsIcon } from '../icons/Icons';
import type { ViewName } from '../types';
import type { FC } from 'react';

const items: { view: ViewName; label: string; Icon: FC<{ className?: string }> }[] = [
  { view: 'terminal', label: 'Console', Icon: TerminalIcon },
  { view: 'settings', label: 'Settings', Icon: SettingsIcon },
];

export default function Sidebar() {
  const { activeView, setView } = useSidebar();

  return (
    <aside className="flex flex-col shrink-0 border-r border-base-300 bg-black w-12 overflow-hidden">
      <nav className="flex-1 py-2">
        <ul className="menu menu-vertical gap-1 px-1.5">
          {items.map((item) => (
            <li key={item.view}>
              <button
                className={`flex items-center justify-center px-2 py-2 ${activeView === item.view ? 'menu-active' : ''}`}
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
