// HomeView -- virtual environment list + create
import { useState, useEffect, useCallback } from 'react';
import { useVenvs, loadVenvs, createVenvAction, deleteVenvAction, startVenvAction, stopVenvAction, openVenv } from '../stores/venvs';
import { useSidebar } from '../stores/sidebar';
import { updateSetting } from '../api';
import { PlusIcon, PlayIcon, StopIcon, TrashIcon, TerminalIcon, ChevronRight, ChevronDown } from '../icons/Icons';
import Dialog, { ConfirmDialog } from '../components/Dialog';
import { TEMPLATES, getTemplate } from '../templates';
import type { VenvInfo, VenvTemplate } from '../types';

// Hardware defaults (must match config/defaults.toml)
const HW_DEFAULTS = { cpu: 4, ram: 4, disk: 16 };
const HW_LIMITS = {
  cpu:  { min: 1, max: 8 },
  ram:  { min: 1, max: 16 },
  disk: { min: 1, max: 128 },
};

function relativeTime(iso: string | null): string {
  if (!iso) return 'Never used';
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function statusDot(status: VenvInfo['status']): string {
  switch (status) {
    case 'running': return 'bg-allowed';
    case 'booting': return 'bg-caution';
    case 'error': return 'bg-denied';
    default: return 'bg-content/20';
  }
}

function statusText(status: VenvInfo['status']): string {
  switch (status) {
    case 'running': return 'text-allowed';
    case 'booting': return 'text-caution';
    case 'error': return 'text-denied';
    default: return 'text-content/40';
  }
}

/** Icon for a template card. Maps template.icon string to JSX. */
function TemplateIcon({ icon, className = 'size-5' }: { icon: string; className?: string }) {
  switch (icon) {
    case 'bot':
      return (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
          <path d="M12 8V4H8" />
          <rect width="16" height="12" x="4" y="8" rx="2" />
          <path d="M2 14h2" />
          <path d="M20 14h2" />
          <path d="M15 13v2" />
          <path d="M9 13v2" />
        </svg>
      );
    default:
      return <TerminalIcon className={className} />;
  }
}

function TemplatePicker({ selected, onSelect }: { selected: string; onSelect: (t: VenvTemplate) => void }) {
  return (
    <div>
      <label className="text-xs text-content/50 mb-1.5 block">Template</label>
      <div className="grid grid-cols-2 gap-2">
        {TEMPLATES.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`flex items-start gap-2.5 p-2.5 rounded-lg border text-left transition-all ${
              selected === t.id
                ? 'border-interactive bg-interactive/10'
                : 'border-edge hover:border-interactive/30 hover:bg-surface-alt'
            }`}
            onClick={() => onSelect(t)}
          >
            <div className={`flex items-center justify-center w-8 h-8 rounded-md shrink-0 ${
              selected === t.id ? 'bg-interactive/20 text-interactive' : 'bg-content/5 text-content/40'
            }`}>
              <TemplateIcon icon={t.icon} className="size-4" />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-medium truncate">{t.name}</div>
              <div className="text-[11px] text-content/40 leading-tight">{t.description}</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Labeled range slider for hardware config. */
function HwSlider({ label, unit, value, min, max, defaultVal, onChange }: {
  label: string;
  unit: string;
  value: number;
  min: number;
  max: number;
  defaultVal: number;
  onChange: (v: number) => void;
}) {
  const isDefault = value === defaultVal;
  return (
    <div className="flex items-center gap-3">
      <span className="text-xs text-content/50 w-12 shrink-0">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="flex-1 h-1 accent-interactive cursor-pointer"
      />
      <span className={`text-xs tabular-nums w-16 text-right ${isDefault ? 'text-content/40' : 'text-content'}`}>
        {value} {unit}
      </span>
    </div>
  );
}

interface ProviderEntry {
  id: string;
  name: string;
  settingKey: string;
  allowKey: string;
  envVar: string;
  placeholder: string;
}

const PROVIDERS: ProviderEntry[] = [
  { id: 'anthropic', name: 'Anthropic', settingKey: 'ai.anthropic.api_key', allowKey: 'ai.anthropic.allow', envVar: 'ANTHROPIC_API_KEY', placeholder: 'sk-ant-...' },
  { id: 'openai', name: 'OpenAI', settingKey: 'ai.openai.api_key', allowKey: 'ai.openai.allow', envVar: 'OPENAI_API_KEY', placeholder: 'sk-...' },
  { id: 'google', name: 'Google AI', settingKey: 'ai.google.api_key', allowKey: 'ai.google.allow', envVar: 'GEMINI_API_KEY', placeholder: 'AIza...' },
];

/** Collapsible API keys section for per-venv credentials. */
function ApiKeysSection({ keys, onKey }: {
  keys: Record<string, string>;
  onKey: (id: string, value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const filled = PROVIDERS.filter((p) => keys[p.id]?.trim()).length;

  return (
    <div className="border border-edge rounded-lg overflow-hidden">
      <button
        type="button"
        className="flex items-center gap-2 w-full px-3 py-2 text-left hover:bg-surface-alt transition-colors"
        onClick={() => setOpen(!open)}
      >
        {open ? <ChevronDown className="size-3 text-content/40" /> : <ChevronRight className="size-3 text-content/40" />}
        <span className="text-xs font-medium text-content/60">API Keys</span>
        {!open && (
          <span className="text-[10px] text-content/30 ml-auto">
            {filled > 0 ? `${filled} key${filled > 1 ? 's' : ''} set` : 'none set'}
          </span>
        )}
      </button>
      {open && (
        <div className="flex flex-col gap-2.5 px-3 pb-3 pt-1">
          <p className="text-[11px] text-content/40 leading-snug">
            Set API keys for this environment. Keys stay on the host and are injected by the proxy.
          </p>
          {PROVIDERS.map((p) => (
            <div key={p.id} className="flex items-center gap-2">
              <span className="text-xs text-content/50 w-16 shrink-0">{p.name}</span>
              <input
                type="password"
                className="flex-1 font-mono text-xs px-2 py-1 border border-edge rounded-md bg-surface focus:outline-none focus:ring-2 focus:ring-interactive/40 transition"
                placeholder={p.placeholder}
                value={keys[p.id] ?? ''}
                onChange={(e) => onKey(p.id, e.target.value)}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Collapsible hardware settings section. */
function HardwareSection({ cpu, ram, disk, onCpu, onRam, onDisk }: {
  cpu: number; ram: number; disk: number;
  onCpu: (v: number) => void;
  onRam: (v: number) => void;
  onDisk: (v: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const isAllDefault = cpu === HW_DEFAULTS.cpu && ram === HW_DEFAULTS.ram && disk === HW_DEFAULTS.disk;

  return (
    <div className="border border-edge rounded-lg overflow-hidden">
      <button
        type="button"
        className="flex items-center gap-2 w-full px-3 py-2 text-left hover:bg-surface-alt transition-colors"
        onClick={() => setOpen(!open)}
      >
        {open ? <ChevronDown className="size-3 text-content/40" /> : <ChevronRight className="size-3 text-content/40" />}
        <span className="text-xs font-medium text-content/60">Hardware</span>
        {!open && (
          <span className="text-[10px] text-content/30 ml-auto">
            {cpu} CPU &middot; {ram} GB RAM &middot; {disk} GB disk
            {isAllDefault && <span className="ml-1 text-content/20">(default)</span>}
          </span>
        )}
      </button>
      {open && (
        <div className="flex flex-col gap-2.5 px-3 pb-3 pt-1">
          <HwSlider label="CPU" unit="cores" value={cpu} min={HW_LIMITS.cpu.min} max={HW_LIMITS.cpu.max} defaultVal={HW_DEFAULTS.cpu} onChange={onCpu} />
          <HwSlider label="RAM" unit="GB" value={ram} min={HW_LIMITS.ram.min} max={HW_LIMITS.ram.max} defaultVal={HW_DEFAULTS.ram} onChange={onRam} />
          <HwSlider label="Disk" unit="GB" value={disk} min={HW_LIMITS.disk.min} max={HW_LIMITS.disk.max} defaultVal={HW_DEFAULTS.disk} onChange={onDisk} />
        </div>
      )}
    </div>
  );
}

function VenvCard({ venv, onDelete }: { venv: VenvInfo; onDelete: (v: VenvInfo) => void }) {
  const { setView } = useSidebar();
  const tmpl = getTemplate(venv.template);
  const [showStopDialog, setShowStopDialog] = useState(false);

  const handleOpen = useCallback(() => {
    openVenv(venv.id);
    startVenvAction(venv.id);
    setView('terminal');
  }, [venv.id, setView]);

  const handleConfirmStop = useCallback(() => {
    stopVenvAction(venv.id);
  }, [venv.id]);

  const isRunning = venv.status === 'running';
  const isBooting = venv.status === 'booting';

  return (
    <>
      <div
        className={`group relative glass border rounded-xl p-4 shadow-xs hover:shadow-md transition-all cursor-pointer ${
          isRunning ? 'border-allowed/30 hover:border-allowed/50' : 'border-edge hover:border-interactive/30'
        }`}
        onClick={handleOpen}
      >
        {/* Actions (top-right) */}
        <div className="absolute top-3 right-3 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity" onClick={(e) => e.stopPropagation()}>
          {isRunning ? (
            <button
              className="p-1.5 rounded-md hover:bg-denied/10 text-content/40 hover:text-denied transition-colors"
              onClick={(e) => { e.stopPropagation(); setShowStopDialog(true); }}
              title="Stop"
              aria-label={`Stop ${venv.name}`}
            >
              <StopIcon className="size-3.5" />
            </button>
          ) : (
            <button
              className="p-1.5 rounded-md hover:bg-allowed/10 text-content/40 hover:text-allowed transition-colors"
              onClick={(e) => { e.stopPropagation(); handleOpen(); }}
              title="Start"
              aria-label={`Start ${venv.name}`}
            >
              <PlayIcon className="size-3.5" />
            </button>
          )}
          <button
            className="p-1.5 rounded-md hover:bg-denied/10 text-content/40 hover:text-denied transition-colors"
            onClick={(e) => { e.stopPropagation(); onDelete(venv); }}
            title="Delete"
            aria-label={`Delete ${venv.name}`}
          >
            <TrashIcon className="size-3.5" />
          </button>
        </div>

        {/* Icon + name */}
        <div className="flex items-center gap-3 mb-3">
          <div className={`flex items-center justify-center w-10 h-10 rounded-xl shrink-0 ${
            isRunning ? 'bg-allowed/10 text-allowed' : 'bg-interactive/10 text-interactive'
          }`}>
            <TemplateIcon icon={tmpl.icon} className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold truncate">{venv.name}</h3>
            <span className="text-[11px] text-content/35">{tmpl.name}</span>
          </div>
        </div>

        {/* Status + badges */}
        <div className="flex items-center gap-2 mb-3">
          <div className="flex items-center gap-1.5">
            <span className={`inline-block size-1.5 rounded-full ${statusDot(venv.status)} ${isBooting ? 'animate-pulse' : ''}`} />
            <span className={`text-[11px] capitalize font-medium ${statusText(venv.status)}`}>{venv.status}</span>
          </div>
          <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${venv.ephemeral ? 'bg-caution/10 text-caution' : 'bg-allowed/10 text-allowed'}`}>
            {venv.ephemeral ? 'ephemeral' : 'persistent'}
          </span>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between text-[11px] text-content/30 pt-2 border-t border-edge/30">
          <span>{relativeTime(venv.last_used)}</span>
          <span>{new Date(venv.created_at).toLocaleDateString()}</span>
        </div>
      </div>

      <ConfirmDialog
        open={showStopDialog}
        onClose={() => setShowStopDialog(false)}
        onConfirm={handleConfirmStop}
        title="Stop Environment"
        message={`Stop "${venv.name}"? ${venv.ephemeral ? 'This is an ephemeral environment — all files will be lost.' : 'Persistent files will be saved.'}`}
        confirmLabel="Stop"
        variant="caution"
      />
    </>
  );
}

export default function HomeView() {
  const { venvs, loading } = useVenvs();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [selectedTemplate, setSelectedTemplate] = useState(TEMPLATES[0]);
  const [newEphemeral, setNewEphemeral] = useState(TEMPLATES[0].defaultEphemeral);
  const [hwCpu, setHwCpu] = useState(HW_DEFAULTS.cpu);
  const [hwRam, setHwRam] = useState(HW_DEFAULTS.ram);
  const [hwDisk, setHwDisk] = useState(HW_DEFAULTS.disk);
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
  const [allowAllDomains, setAllowAllDomains] = useState(false);
  const [mitmEnabled, setMitmEnabled] = useState(true);
  const [deleteTarget, setDeleteTarget] = useState<VenvInfo | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    loadVenvs();
  }, []);

  const handleSelectTemplate = useCallback((t: VenvTemplate) => {
    setSelectedTemplate(t);
    setNewEphemeral(t.defaultEphemeral);
  }, []);

  const setApiKey = useCallback((id: string, value: string) => {
    setApiKeys((prev) => ({ ...prev, [id]: value }));
  }, []);

  const resetForm = useCallback(() => {
    setNewName('');
    setSelectedTemplate(TEMPLATES[0]);
    setNewEphemeral(TEMPLATES[0].defaultEphemeral);
    setAllowAllDomains(false);
    setMitmEnabled(true);
    setHwCpu(HW_DEFAULTS.cpu);
    setHwRam(HW_DEFAULTS.ram);
    setHwDisk(HW_DEFAULTS.disk);
    setApiKeys({});
  }, []);

  const handleCreate = useCallback(async () => {
    const name = newName.trim();
    if (!name || submitting) return;
    setSubmitting(true);
    try {
      const venv = await createVenvAction(name, newEphemeral, selectedTemplate.id);
      if (venv) {
        // Save non-default hardware settings as per-venv overrides.
        if (hwCpu !== HW_DEFAULTS.cpu) updateSetting('vm.cpu_count', hwCpu, venv.id);
        if (hwRam !== HW_DEFAULTS.ram) updateSetting('vm.ram_gb', hwRam, venv.id);
        if (hwDisk !== HW_DEFAULTS.disk) updateSetting('vm.scratch_disk_size_gb', hwDisk, venv.id);
        // Save network settings if changed from defaults.
        if (allowAllDomains) await updateSetting('network.allow_all_domains', true, venv.id);
        if (!mitmEnabled) await updateSetting('network.proxy_enabled', false, venv.id);
        // Save per-venv API keys and auto-enable the provider.
        for (const provider of PROVIDERS) {
          const key = apiKeys[provider.id]?.trim();
          if (key) {
            await updateSetting(provider.settingKey, key, venv.id);
            await updateSetting(provider.allowKey, true, venv.id);
          }
        }
      }
      resetForm();
      setCreating(false);
    } finally {
      setSubmitting(false);
    }
  }, [newName, newEphemeral, allowAllDomains, mitmEnabled, selectedTemplate, hwCpu, hwRam, hwDisk, apiKeys, resetForm, submitting]);

  const handleCloseCreate = useCallback(() => {
    setCreating(false);
    resetForm();
  }, [resetForm]);

  const handleConfirmDelete = useCallback(() => {
    if (deleteTarget) {
      deleteVenvAction(deleteTarget.id);
      setDeleteTarget(null);
    }
  }, [deleteTarget]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-edge shrink-0">
        <div>
          <h2 className="text-sm font-semibold">Environments</h2>
          <p className="text-xs text-content/50 mt-0.5">
            {venvs.length > 0 ? `${venvs.length} environment${venvs.length !== 1 ? 's' : ''}` : 'Create and manage sandboxed environments'}
          </p>
        </div>
        <button
          className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md bg-interactive text-on-interactive hover:opacity-90 transition font-medium"
          onClick={() => setCreating(true)}
          aria-label="Create new environment"
        >
          <PlusIcon className="size-3.5" />
          New
        </button>
      </div>

      <div className="flex-1 overflow-auto">
      <div className="max-w-5xl w-full mx-auto px-6 py-6">

        {/* Create dialog */}
        <Dialog open={creating} onClose={handleCloseCreate} title="New Environment">
          <div className="flex flex-col gap-3">
            <TemplatePicker selected={selectedTemplate.id} onSelect={handleSelectTemplate} />
            <div>
              <label className="text-xs text-content/50 mb-1 block">Name</label>
              <input
                type="text"
                className="w-full px-2.5 py-1.5 text-sm border border-edge rounded-md bg-surface focus:outline-none focus:ring-2 focus:ring-interactive/40"
                placeholder="my-project"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); }}
                autoFocus
              />
            </div>
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                className="toggle-switch"
                checked={newEphemeral}
                onChange={(e) => setNewEphemeral(e.target.checked)}
              />
              <span className="text-sm">Ephemeral</span>
              <span className="text-[11px] text-content/40">
                {newEphemeral ? 'Files are wiped on every restart' : 'Files persist across restarts'}
              </span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                className="toggle-switch"
                checked={allowAllDomains}
                onChange={(e) => setAllowAllDomains(e.target.checked)}
              />
              <span className="text-sm">Allow all domains</span>
              <span className="text-[11px] text-content/40">
                {allowAllDomains ? 'Unrestricted internet access' : 'Only allowed domains'}
              </span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                className="toggle-switch"
                checked={mitmEnabled}
                onChange={(e) => setMitmEnabled(e.target.checked)}
              />
              <span className="text-sm">MITM Proxy</span>
              <span className="text-[11px] text-content/40">
                {mitmEnabled ? 'TLS traffic is inspected' : 'Traffic passes through transparently'}
              </span>
            </label>
            <HardwareSection
              cpu={hwCpu} ram={hwRam} disk={hwDisk}
              onCpu={setHwCpu} onRam={setHwRam} onDisk={setHwDisk}
            />
            <ApiKeysSection keys={apiKeys} onKey={setApiKey} />
            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                className="px-3 py-1.5 text-sm rounded-lg hover:bg-surface-alt transition-colors"
                onClick={handleCloseCreate}
              >
                Cancel
              </button>
              <button
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-interactive text-on-interactive hover:opacity-90 transition font-medium disabled:opacity-40"
                onClick={handleCreate}
                disabled={!newName.trim() || submitting}
              >
                {submitting && <span className="spinner w-3.5 h-3.5" />}
                {submitting ? 'Creating...' : 'Create'}
              </button>
            </div>
          </div>
        </Dialog>

        {/* Delete confirmation dialog */}
        <ConfirmDialog
          open={deleteTarget !== null}
          onClose={() => setDeleteTarget(null)}
          onConfirm={handleConfirmDelete}
          title="Delete Environment"
          message={deleteTarget ? `Are you sure you want to delete "${deleteTarget.name}"? ${deleteTarget.ephemeral ? 'This environment is ephemeral so no data will be lost.' : 'All persistent data for this environment will be permanently removed.'}` : ''}
          confirmLabel="Delete"
          variant="danger"
        />

        {/* Loading state */}
        {loading && venvs.length === 0 && (
          <div className="flex items-center justify-center py-20">
            <span className="spinner w-6 h-6 text-content/30" />
          </div>
        )}

        {/* Empty state */}
        {!loading && venvs.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="w-16 h-16 rounded-2xl bg-interactive/10 flex items-center justify-center mb-4">
              <TerminalIcon className="size-8 text-interactive" />
            </div>
            <h2 className="text-lg font-semibold mb-1">No environments yet</h2>
            <p className="text-sm text-content/50 mb-4 max-w-xs">
              Create your first sandboxed virtual environment to get started.
            </p>
            <button
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-interactive text-on-interactive hover:opacity-90 transition font-medium"
              onClick={() => setCreating(true)}
            >
              <PlusIcon className="size-4" />
              Create Environment
            </button>
          </div>
        )}

        {/* Venv grid */}
        {venvs.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
            {venvs.map((v) => (
              <VenvCard key={v.id} venv={v} onDelete={setDeleteTarget} />
            ))}
          </div>
        )}
      </div>
      </div>
    </div>
  );
}
