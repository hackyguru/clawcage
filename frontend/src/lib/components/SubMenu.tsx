// SubMenu component
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
    <aside className="shrink-0 w-50 border-r border-base-300 bg-base-200/50 overflow-y-auto py-3 px-2">
      {groups.map((group, gi) => (
        <div key={group.label || gi}>
          {gi > 0 && <div className="divider my-1" />}
          <ul className="menu menu-sm p-0">
            {group.items.length > 1 && group.label && (
              <li className="menu-title text-[10px] uppercase tracking-wider">{group.label}</li>
            )}
            {group.items.map((item) => (
              <li key={item.id}>
                <button
                  className={`text-xs ${active === item.id ? 'menu-active' : ''}`}
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
