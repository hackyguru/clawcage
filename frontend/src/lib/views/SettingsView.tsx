// SettingsView -- settings panel with section sub-menu and venv scope selector
import { useEffect, useState, useCallback } from 'react';
import { useSettings, loadSettings } from '../stores/settings';
import { useSidebar } from '../stores/sidebar';
import { useVenvs, deleteVenvAction } from '../stores/venvs';
import { ChevronDown, TrashIcon } from '../icons/Icons';
import { ConfirmDialog } from '../components/Dialog';
import SubMenu from '../components/SubMenu';
import SettingsSection from './settings/SettingsSection';

export default function SettingsView() {
  const { sections, loading, venvId, setScope } = useSettings();
  const { settingsSection, setSettingsSection } = useSidebar();
  const { activeVenvId, activeVenv } = useVenvs();
  const { setView } = useSidebar();
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  const handleConfirmDelete = useCallback(() => {
    if (activeVenv) {
      deleteVenvAction(activeVenv.id);
      setView('home');
    }
  }, [activeVenv, setView]);

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
        {/* Header with scope selector */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-edge shrink-0">
          <div>
            <h2 className="text-sm font-semibold">Settings</h2>
            <p className="text-xs text-content/50 mt-0.5">
              {venvId ? 'Per-environment overrides' : 'Global configuration for all environments'}
            </p>
          </div>
          {activeVenv && (
            <div className="relative flex items-center gap-2">
              <span className="text-xs text-content/40">Scope</span>
              <div className="relative">
                <select
                  className="appearance-none rounded-md border border-edge bg-surface-alt pl-2.5 pr-7 py-1 text-xs text-content/80 focus:outline-none focus:ring-1 focus:ring-interactive/40 cursor-pointer"
                  value={venvId ?? '__global__'}
                  onChange={(e) => setScope(e.target.value === '__global__' ? null : e.target.value)}
                >
                  <option value="__global__">Global</option>
                  <option value={activeVenvId!}>{activeVenv.name}</option>
                </select>
                <ChevronDown className="absolute right-1.5 top-1/2 -translate-y-1/2 size-3 text-content/40 pointer-events-none" />
              </div>
            </div>
          )}
        </div>

        <div className="flex-1 min-w-0 overflow-auto">
          {loading ? (
            <div className="flex items-center justify-center h-full">
              <span className="spinner w-5 h-5 text-content/30" />
            </div>
          ) : activeSection ? (
            <SettingsSection sectionName={activeSection} />
          ) : (
            <div className="flex items-center justify-center h-full text-content/30 text-sm">
              Select a settings section
            </div>
          )}

          {/* Danger zone -- delete environment */}
          {activeVenv && (
            <div className="border-t border-edge mx-4 mt-6 pt-4 pb-6">
              <h3 className="text-xs font-semibold text-denied mb-1">Danger Zone</h3>
              <p className="text-xs text-content/50 mb-3">
                Permanently delete this environment and all its configuration.
              </p>
              <button
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border border-denied/30 text-denied hover:bg-denied/10 transition-colors font-medium"
                onClick={() => setShowDeleteDialog(true)}
              >
                <TrashIcon className="size-3" />
                Delete &ldquo;{activeVenv.name}&rdquo;
              </button>
            </div>
          )}
        </div>

        {/* Delete confirmation dialog */}
        <ConfirmDialog
          open={showDeleteDialog}
          onClose={() => setShowDeleteDialog(false)}
          onConfirm={handleConfirmDelete}
          title="Delete Environment"
          message={`Are you sure you want to delete "${activeVenv?.name ?? ''}"? ${activeVenv?.ephemeral ? 'This environment is ephemeral so no data will be lost.' : 'All persistent data for this environment will be permanently removed.'}`}
          confirmLabel="Delete"
          variant="danger"
        />
      </div>
    </div>
  );
}
