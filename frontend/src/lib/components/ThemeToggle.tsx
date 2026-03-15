// ThemeToggle component
import { useTheme } from '../stores/theme';
import { SunIcon, MoonIcon } from '../icons/Icons';

export default function ThemeToggle() {
  const { theme, toggle } = useTheme();

  return (
    <button className="btn btn-ghost btn-xs" onClick={toggle} title="Toggle theme">
      {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}
