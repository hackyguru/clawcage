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
  <aside className="shrink-0 w-50 border-r border-neutral-200 dark:border-neutral-800 bg-[--color-base-100] overflow-y-auto py-3 px-2">
      {groups.map((group, gi) => (
        <div key={group.label || gi}>
          {gi > 0 && <div className="my-1 border-t border-neutral-200 dark:border-neutral-700" />}
          <ul className="flex flex-col gap-0.5 p-0">
            {group.items.length > 1 && group.label && (
              <li className="text-[10px] uppercase tracking-wider text-neutral-500 font-semibold mb-1 mt-2 pl-2">{group.label}</li>
            )}
            {group.items.map((item) => (
              <li key={item.id}>
                <button
                  className={`w-full text-left text-xs px-2 py-1 rounded-md transition-colors duration-100 ${active === item.id ? 'bg-primary-100 dark:bg-primary-900 text-primary-700 dark:text-primary-300 font-semibold' : 'hover:bg-neutral-200 dark:hover:bg-neutral-800 text-neutral-700 dark:text-neutral-300'}`}
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
