// SettingsView -- settings panel with section sub-menu and venv scope selector
import { useEffect, useState, useCallback, useRef } from 'react';
import { useSettings, loadSettings } from '../stores/settings';
import { useSidebar } from '../stores/sidebar';
import { useVenvs, deleteVenvAction, loadVenvs } from '../stores/venvs';
import { renameVenv, setVenvIcon } from '../api';
import { showToast } from '../stores/toast';
import { ChevronDown, TrashIcon } from '../icons/Icons';
import { ConfirmDialog } from '../components/Dialog';
import SubMenu from '../components/SubMenu';
import SettingsSection from './settings/SettingsSection';
import { getTemplate } from '../templates';

/** Inline environment name + icon customization. */
function VenvCustomization({ venvId, name, icon }: { venvId: string; name: string; icon?: string | null }) {
  const [editingName, setEditingName] = useState(false);
  const [draft, setDraft] = useState(name);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleSaveName = useCallback(async () => {
    const trimmed = draft.trim();
    if (!trimmed || trimmed === name) {
      setDraft(name);
      setEditingName(false);
      return;
    }
    try {
      await renameVenv(venvId, trimmed);
      await loadVenvs();
      showToast('Environment renamed', 'success', 2000);
    } catch (e) {
      showToast('Rename failed: ' + String(e), 'error');
      setDraft(name);
    }
    setEditingName(false);
  }, [venvId, name, draft]);

  const handleIconChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      showToast('Please select an image file', 'error');
      return;
    }
    if (file.size > 512 * 1024) {
      showToast('Image must be under 512 KB', 'error');
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = reader.result as string;
      console.log('[icon] uploading', dataUrl.length, 'chars');
      try {
        await setVenvIcon(venvId, dataUrl);
        console.log('[icon] saved, reloading venvs');
        await loadVenvs();
        showToast('Icon updated', 'success', 2000);
      } catch (err) {
        console.error('[icon] upload failed:', err);
        showToast('Failed to set icon: ' + String(err), 'error');
      }
    };
    reader.readAsDataURL(file);
    // Reset so same file can be re-selected.
    e.target.value = '';
  }, [venvId]);

  const handleRemoveIcon = useCallback(async () => {
    try {
      await setVenvIcon(venvId, null);
      await loadVenvs();
      showToast('Icon removed', 'success', 2000);
    } catch (e) {
      showToast('Failed to remove icon: ' + String(e), 'error');
    }
  }, [venvId]);

  // Find the icon from the venvs list. Fall back to template logo.
  const { venvs: allVenvs } = useVenvs();
  const venvData = allVenvs.find((v) => v.id === venvId);
  const iconUrl = venvData?.icon_url ?? null;
  const tmpl = venvData ? getTemplate(venvData.template) : null;
  const displayIcon = iconUrl ?? tmpl?.logo ?? null;

  return (
    <div className="border-t border-edge mx-4 mt-6 pt-4 pb-2">
      <h3 className="text-xs font-semibold text-content/60 mb-3">Environment</h3>
      <div className="flex flex-col gap-3">
        {/* Name */}
        <div className="flex items-center gap-3">
          <span className="text-xs text-content/50 w-12 shrink-0">Name</span>
          {editingName ? (
            <div className="flex items-center gap-1.5 flex-1">
              <input
                type="text"
                className="flex-1 px-2 py-1 text-xs border border-edge rounded-md bg-surface focus:outline-none focus:ring-1 focus:ring-interactive/40"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleSaveName(); if (e.key === 'Escape') { setDraft(name); setEditingName(false); } }}
                autoFocus
              />
              <button className="px-2 py-1 text-xs rounded-md bg-interactive text-on-interactive hover:opacity-90 font-medium" onClick={handleSaveName}>Save</button>
              <button className="px-2 py-1 text-xs rounded text-content/40 hover:text-content/70" onClick={() => { setDraft(name); setEditingName(false); }}>Cancel</button>
            </div>
          ) : (
            <div className="flex items-center gap-2 flex-1">
              <span className="text-xs text-content/80">{name}</span>
              <button className="text-[11px] text-content/30 hover:text-interactive transition-colors" onClick={() => { setDraft(name); setEditingName(true); }}>Edit</button>
            </div>
          )}
        </div>
        {/* Icon */}
        <div className="flex items-center gap-3">
          <span className="text-xs text-content/50 w-12 shrink-0">Icon</span>
          <div className="flex items-center gap-2">
            {displayIcon ? (
              <img src={displayIcon} alt="" className="size-8 rounded-md object-cover border border-edge" />
            ) : (
              <div className="size-8 rounded-md bg-content/5 border border-edge/50 flex items-center justify-center text-content/20 text-[10px]">
                None
              </div>
            )}
            <button
              className="px-2 py-1 text-xs rounded-md border border-edge hover:bg-surface-alt transition-colors"
              onClick={() => fileRef.current?.click()}
            >
              {displayIcon ? 'Change' : 'Upload Image'}
            </button>
            {icon && (
              <button
                className="px-2 py-1 text-xs rounded text-content/40 hover:text-denied transition-colors"
                onClick={handleRemoveIcon}
              >
                Remove
              </button>
            )}
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleIconChange} />
          </div>
        </div>
      </div>
    </div>
  );
}

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

          {/* Environment customization */}
          {activeVenv && <VenvCustomization venvId={activeVenv.id} name={activeVenv.name} icon={activeVenv.icon} />}

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
