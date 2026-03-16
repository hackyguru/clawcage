// SettingsView -- settings panel with section sub-menu and venv scope selector
import { useEffect } from 'react';
import { useSettings, loadSettings } from '../stores/settings';
import { useSidebar } from '../stores/sidebar';
import { useVenvs } from '../stores/venvs';
import SubMenu from '../components/SubMenu';
import SettingsSection from './settings/SettingsSection';

export default function SettingsView() {
  const { sections, loading, venvId, setScope } = useSettings();
  const { settingsSection, setSettingsSection } = useSidebar();
  const { venvs, activeVenvId } = useVenvs();

  // Load settings on mount
  useEffect(() => {
    loadSettings();
  }, []);

  // Auto-select first section if none is active
  useEffect(() => {
    if (!settingsSection && sections.length > 0) {
      setSettingsSection(sections[0]);
    }
  }, [sections, settingsSection, setSettingsSection]);

  const activeSection = settingsSection || sections[0] || '';

  return (
    <div className="flex h-full w-full">
      <SubMenu
        groups={[{
          label: 'Settings',
          items: sections.map((s) => ({ id: s, label: s })),
        }]}
        active={activeSection}
        onSelect={(id) => setSettingsSection(id)}
      />
      <div className="flex-1 min-w-0 overflow-hidden flex flex-col">
        {/* Scope selector: global vs per-venv */}
        {venvs.length > 0 && (
          <div className="flex items-center gap-2 px-4 py-2 border-b border-edge bg-surface-alt/50 shrink-0">
            <span className="text-xs text-content/60">Scope:</span>
            <select
              className="text-xs px-2 py-1 rounded border border-edge bg-surface focus:outline-none focus:ring-1 focus:ring-interactive/40"
              value={venvId ?? '__global__'}
              onChange={(e) => setScope(e.target.value === '__global__' ? null : e.target.value)}
            >
              <option value="__global__">Global (all venvs)</option>
              {venvs.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}{v.id === activeVenvId ? ' (active)' : ''}
                </option>
              ))}
            </select>
            {venvId && (
              <span className="text-xs text-interactive font-medium">
                Per-venv overrides
              </span>
            )}
          </div>
        )}

        <div className="flex-1 min-w-0 overflow-hidden">
          {loading ? (
            <div className="flex items-center justify-center h-full">
              <span className="spinner w-4 h-4 text-content/30" />
            </div>
          ) : activeSection ? (
            <SettingsSection sectionName={activeSection} />
          ) : (
            <div className="flex items-center justify-center h-full text-neutral-300 text-sm">
              Select a settings section
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
