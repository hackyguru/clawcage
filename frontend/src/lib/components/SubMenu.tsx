// SubMenu component -- vertical nav used by StatsView and SettingsView
import type { FC } from 'react';

interface SubMenuItem {
  id: string;
  label: string;
}

interface SubMenuGroup {
  label: string;
  items: SubMenuItem[];
}

interface SubMenuProps {
  groups: SubMenuGroup[];
  active: string;
  onSelect: (id: string) => void;
}

export default function SubMenu({ groups, active, onSelect }: SubMenuProps) {
  return (
    <aside className="shrink-0 w-44 border-r border-edge glass overflow-y-auto py-3 px-2">
      {groups.map((group, gi) => (
        <div key={group.label || gi}>
          {gi > 0 && <div className="my-2 border-t border-edge" />}
          <ul className="flex flex-col gap-0.5 p-0">
            {group.items.length > 1 && group.label && (
              <li className="text-[10px] uppercase tracking-wider text-content/30 font-semibold mb-1 mt-2 px-2">
                {group.label}
              </li>
            )}
            {group.items.map((item) => (
              <li key={item.id}>
                <button
                  className={`w-full text-left text-xs px-2.5 py-1.5 rounded-md transition-colors duration-100 ${
                    active === item.id
                      ? 'bg-interactive/15 text-interactive font-semibold'
                      : 'text-content/60 hover:text-content/80 hover:bg-surface-alt/60'
                  }`}
                  onClick={() => onSelect(item.id)}
                >
                  <span className="whitespace-nowrap">{item.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </aside>
  );
}
