// SettingsView -- settings panel with section sub-menu
import { useEffect } from 'react';
import { useSettings, loadSettings } from '../stores/settings';
import { useSidebar } from '../stores/sidebar';
import SubMenu from '../components/SubMenu';
import SettingsSection from './settings/SettingsSection';

export default function SettingsView() {
  const { sections, loading } = useSettings();
  const { settingsSection, setSettingsSection } = useSidebar();

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
      <div className="flex-1 min-w-0 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <span className="loading loading-spinner loading-sm" />
          </div>
        ) : activeSection ? (
          <SettingsSection sectionName={activeSection} />
        ) : (
          <div className="flex items-center justify-center h-full text-base-content/30 text-sm">
            Select a settings section
          </div>
        )}
      </div>
    </div>
  );
}
