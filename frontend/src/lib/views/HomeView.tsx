// HomeView -- virtual environment list + create
import { useState, useEffect, useCallback, useRef } from 'react';
import { useVenvs, loadVenvs, createVenvAction, deleteVenvAction, startVenvAction, stopVenvAction, openVenv } from '../stores/venvs';
import { useSidebar } from '../stores/sidebar';
import { updateSetting, saveVenvFile, getVenvMetrics, cloneVenv, exportVenv, importVenv, onSnapshotProgress, type SnapshotProgress } from '../api';
import { showToast } from '../stores/toast';
import type { SystemMetrics } from '../types';
import { PlusIcon, PlayIcon, StopIcon, TrashIcon, TerminalIcon, ChevronRight, ChevronDown } from '../icons/Icons';
import Dialog, { ConfirmDialog } from '../components/Dialog';
import { TEMPLATES, getTemplate } from '../templates';
import type { VenvInfo, VenvTemplate, TemplateFormField } from '../types';

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

function formatDiskSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
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

/** Icon for a template card. Uses logo image if available, otherwise SVG icon.
 *  When `fill` is true, the logo fills its parent container (use with overflow-hidden). */
function TemplateIcon({ icon, logo, className = 'size-5', fill }: { icon: string; logo?: string; className?: string; fill?: boolean }) {
  if (logo) {
    return <img src={logo} alt="" className={fill ? 'w-full h-full object-cover' : `${className} rounded object-contain`} />;
  }
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
            <div className={`flex items-center justify-center w-8 h-8 rounded-md shrink-0 overflow-hidden ${
              t.logo ? '' : selected === t.id ? 'bg-interactive/20 text-interactive' : 'bg-content/5 text-content/40'
            }`}>
              <TemplateIcon icon={t.icon} logo={t.logo} className="size-4" fill={!!t.logo} />
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

/** Renders a single template form field. */
function TemplateField({ field, value, onChange, formValues }: {
  field: TemplateFormField;
  value: string | boolean;
  onChange: (value: string | boolean) => void;
  formValues: Record<string, string | boolean>;
}) {
  // Conditional visibility: hide if the condition's field does NOT equal the target.
  // (inverted: show when the condition field is NOT 'skip')
  if (field.condition) {
    const depVal = formValues[field.condition.field];
    if (field.condition.equals === 'skip') {
      // Special: "show when NOT skip"
      if (depVal === 'skip' || depVal === undefined) return null;
    } else if (depVal !== field.condition.equals) {
      return null;
    }
  }

  if (field.type === 'checkbox') {
    return (
      <label className="flex items-center gap-2 cursor-pointer select-none">
        <input
          type="checkbox"
          className="toggle-switch"
          checked={!!value}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="text-sm">{field.label}</span>
        {field.description && <span className="text-[11px] text-content/40">{field.description}</span>}
      </label>
    );
  }

  if (field.type === 'select') {
    return (
      <div>
        <label className="text-xs text-content/50 mb-1 block">{field.label}</label>
        <select
          className="w-full px-2.5 py-1.5 text-sm border border-edge rounded-md bg-surface focus:outline-none focus:ring-2 focus:ring-interactive/40"
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
        >
          {field.options?.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>
    );
  }

  // text / password
  return (
    <div>
      <label className="text-xs text-content/50 mb-1 block">{field.label}</label>
      <input
        type={field.type === 'password' ? 'password' : 'text'}
        className="w-full font-mono text-xs px-2.5 py-1.5 border border-edge rounded-md bg-surface focus:outline-none focus:ring-2 focus:ring-interactive/40"
        placeholder={field.description ?? ''}
        value={String(value ?? '')}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

/** Collapsible template configuration section. */
function TemplateFormSection({ fields, values, onValue }: {
  fields: TemplateFormField[];
  values: Record<string, string | boolean>;
  onValue: (id: string, value: string | boolean) => void;
}) {
  const [open, setOpen] = useState(true);
  const filled = fields.filter((f) => {
    const v = values[f.id];
    return v !== undefined && v !== '' && v !== false && v !== f.default;
  }).length;

  return (
    <div className="border border-edge rounded-lg overflow-hidden">
      <button
        type="button"
        className="flex items-center gap-2 w-full px-3 py-2 text-left hover:bg-surface-alt transition-colors"
        onClick={() => setOpen(!open)}
      >
        {open ? <ChevronDown className="size-3 text-content/40" /> : <ChevronRight className="size-3 text-content/40" />}
        <span className="text-xs font-medium text-content/60">Setup</span>
        {!open && (
          <span className="text-[10px] text-content/30 ml-auto">
            {filled > 0 ? `${filled} configured` : 'defaults'}
          </span>
        )}
      </button>
      {open && (
        <div className="flex flex-col gap-2.5 px-3 pb-3 pt-1">
          {fields.map((field) => (
            <TemplateField
              key={field.id}
              field={field}
              value={values[field.id] ?? field.default ?? ''}
              onChange={(v) => onValue(field.id, v)}
              formValues={values}
            />
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

/** Tiny trend arrow: up, down, or stable. */
function TrendArrow({ current, previous }: { current: number; previous: number }) {
  const diff = current - previous;
  if (Math.abs(diff) < 0.5) return null;
  return diff > 0
    ? <svg viewBox="0 0 8 8" className="size-2 shrink-0 text-denied/60"><path d="M4 1L7 5H1z" fill="currentColor" /></svg>
    : <svg viewBox="0 0 8 8" className="size-2 shrink-0 text-allowed/60"><path d="M4 7L1 3h6z" fill="currentColor" /></svg>;
}

/** Live metrics bar for a running venv card. */
function VenvMetrics({ venvId }: { venvId: string }) {
  const [metrics, setMetrics] = useState<SystemMetrics | null>(null);
  const prevRef = useRef<{ cpu: number; mem: number; disk: number }>({ cpu: 0, mem: 0, disk: 0 });

  useEffect(() => {
    let mounted = true;
    const poll = () => {
      getVenvMetrics(venvId).then((m) => {
        if (!mounted) return;
        if (metrics) {
          prevRef.current = {
            cpu: metrics.cpu_percent,
            mem: metrics.mem_total_kb > 0 ? (metrics.mem_used_kb / metrics.mem_total_kb) * 100 : 0,
            disk: metrics.disk_total_kb > 0 ? (metrics.disk_used_kb / metrics.disk_total_kb) * 100 : 0,
          };
        }
        setMetrics(m);
      }).catch(() => {});
    };
    poll();
    const iv = setInterval(poll, 3000);
    return () => { mounted = false; clearInterval(iv); };
  }, [venvId]);

  if (!metrics || metrics.updated_at === 0) return null;

  const cpuPct = metrics.cpu_percent;
  const memPct = metrics.mem_total_kb > 0 ? (metrics.mem_used_kb / metrics.mem_total_kb) * 100 : 0;
  const diskPct = metrics.disk_total_kb > 0 ? (metrics.disk_used_kb / metrics.disk_total_kb) * 100 : 0;
  const memMb = Math.round(metrics.mem_used_kb / 1024);
  const memTotalGb = (metrics.mem_total_kb / (1024 * 1024)).toFixed(1);
  const prev = prevRef.current;

  return (
    <div className="flex items-center gap-3 text-[10px] text-content/40 tabular-nums pt-2 border-t border-edge/30">
      {/* CPU */}
      <div className="flex items-center gap-1" title={`CPU ${cpuPct.toFixed(1)}%`}>
        <svg viewBox="0 0 16 16" className="size-3 shrink-0 text-content/30"><rect x="3" y="3" width="10" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.2" fill="none" /><path d="M6 1v2M10 1v2M6 13v2M10 13v2M1 6h2M1 10h2M13 6h2M13 10h2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg>
        <span>{cpuPct.toFixed(1)}%</span>
        <TrendArrow current={cpuPct} previous={prev.cpu} />
      </div>
      {/* Memory */}
      <div className="flex items-center gap-1" title={`${memMb} MB / ${memTotalGb} GB`}>
        <svg viewBox="0 0 16 16" className="size-3 shrink-0 text-content/30"><rect x="2" y="4" width="12" height="8" rx="1" stroke="currentColor" strokeWidth="1.2" fill="none" /><rect x="4" y="6" width="2" height="4" rx="0.5" fill="currentColor" /><rect x="7" y="6" width="2" height="4" rx="0.5" fill="currentColor" opacity="0.5" /></svg>
        <span>{memPct.toFixed(1)}%</span>
        <TrendArrow current={memPct} previous={prev.mem} />
      </div>
      {/* Disk */}
      <div className="flex items-center gap-1" title={`Disk ${diskPct.toFixed(1)}%`}>
        <svg viewBox="0 0 16 16" className="size-3 shrink-0 text-content/30"><circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.2" fill="none" /><circle cx="8" cy="8" r="1.5" fill="currentColor" /></svg>
        <span>{diskPct.toFixed(1)}%</span>
        <TrendArrow current={diskPct} previous={prev.disk} />
      </div>
    </div>
  );
}

function VenvCard({ venv, onDelete }: { venv: VenvInfo; onDelete: (v: VenvInfo) => void }) {
  const { setView } = useSidebar();
  const tmpl = getTemplate(venv.template);
  const [showStopDialog, setShowStopDialog] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [showCloneDialog, setShowCloneDialog] = useState(false);
  const [cloneName, setCloneName] = useState('');
  const [busy, setBusy] = useState(false);

  const handleClone = useCallback(async () => {
    if (!cloneName.trim() || busy) return;
    setBusy(true);
    try {
      await cloneVenv(venv.id, cloneName.trim());
      showToast('Environment cloned', 'success', 3000);
      setShowCloneDialog(false);
      loadVenvs();
    } catch (e) { showToast('Clone failed: ' + String(e), 'error'); }
    finally { setBusy(false); }
  }, [venv.id, cloneName, busy]);

  const handleExport = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setShowMenu(false);
    try {
      const { save } = await import('@tauri-apps/plugin-dialog');
      const path = await save({ defaultPath: `${venv.name}.clawcage`, filters: [{ name: 'Clawcage Archive', extensions: ['clawcage'] }] });
      if (path) {
        await exportVenv(venv.id, path);
        showToast('Environment exported', 'success', 3000);
      }
    } catch (e) { showToast('Export failed: ' + String(e), 'error'); }
    finally { setBusy(false); }
  }, [venv.id, venv.name, busy]);

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
          <div className="relative">
            <button
              className="p-1.5 rounded-md hover:bg-surface-alt text-content/40 hover:text-content/70 transition-colors"
              onClick={(e) => { e.stopPropagation(); setShowMenu(!showMenu); }}
              title="More actions"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="size-3.5"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>
            </button>
            {showMenu && (
              <>
                <div className="fixed inset-0 z-40" onClick={(e) => { e.stopPropagation(); setShowMenu(false); }} />
                <div className="absolute right-0 top-8 z-50 bg-surface border border-edge rounded-xl shadow-xl overflow-hidden min-w-36" onClick={(e) => e.stopPropagation()}>
                  <button className="w-full text-left px-3 py-2 text-xs hover:bg-surface-alt transition-colors" onClick={() => { setShowMenu(false); setCloneName(venv.name + ' (copy)'); setShowCloneDialog(true); }}>Clone</button>
                  <button className="w-full text-left px-3 py-2 text-xs hover:bg-surface-alt transition-colors disabled:text-content/20" disabled={isRunning} onClick={handleExport}>
                    Export{isRunning ? ' (stop first)' : ''}
                  </button>
                  <div className="border-t border-edge" />
                  <button className="w-full text-left px-3 py-2 text-xs text-denied hover:bg-denied/10 transition-colors" onClick={() => { setShowMenu(false); onDelete(venv); }}>Delete</button>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Icon + name */}
        <div className="flex items-center gap-3 mb-3">
          <div className={`flex items-center justify-center w-10 h-10 rounded-xl shrink-0 overflow-hidden ${
            venv.icon || tmpl.logo ? '' : isRunning ? 'bg-allowed/10 text-allowed' : 'bg-interactive/10 text-interactive'
          }`}>
            {venv.icon_url ? (
              <img src={venv.icon_url} alt="" className="w-full h-full object-cover" />
            ) : (
              <TemplateIcon icon={tmpl.icon} logo={tmpl.logo} className="size-5" fill={!!tmpl.logo} />
            )}
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

        {/* Footer: live metrics for running, static info for stopped */}
        {isRunning ? (
          <VenvMetrics venvId={venv.id} />
        ) : (
          <div className="flex items-center justify-between text-[11px] text-content/30 pt-2 border-t border-edge/30">
            <span>{relativeTime(venv.last_used)}</span>
            <div className="flex items-center gap-2">
              {venv.disk_allocated_bytes != null && venv.disk_allocated_bytes > 0 && (
                <span className="tabular-nums">
                  {venv.disk_used_bytes ? formatDiskSize(venv.disk_used_bytes) : '0 B'} / {formatDiskSize(venv.disk_allocated_bytes)}
                </span>
              )}
              <span>{new Date(venv.created_at).toLocaleDateString()}</span>
            </div>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={showStopDialog}
        onClose={() => setShowStopDialog(false)}
        onConfirm={handleConfirmStop}
        title="Stop Environment"
        message={`Stop "${venv.name}"? ${venv.ephemeral ? 'This is an ephemeral environment — all files will be lost.' : 'Persistent files will be saved.'}`}
        confirmLabel="Stop"
        variant="danger"
      />

      {/* Clone dialog */}
      <Dialog open={showCloneDialog} onClose={() => setShowCloneDialog(false)} title="Clone Environment" width="max-w-sm">
        <div className="flex flex-col gap-3">
          <p className="text-xs text-content/50">Create a copy of "{venv.name}" with all files and settings.</p>
          <div>
            <label className="text-xs text-content/50 mb-1 block">New name</label>
            <input
              type="text"
              className="w-full px-2.5 py-1.5 text-sm border border-edge rounded-md bg-surface focus:outline-none focus:ring-2 focus:ring-interactive/40"
              value={cloneName}
              onChange={(e) => setCloneName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleClone(); }}
              autoFocus
            />
          </div>
          <div className="flex justify-end gap-2">
            <button className="px-3 py-1.5 text-sm rounded-lg hover:bg-surface-alt transition-colors" onClick={() => setShowCloneDialog(false)}>Cancel</button>
            <button className="px-3 py-1.5 text-sm rounded-lg bg-interactive text-on-interactive hover:opacity-90 font-medium disabled:opacity-40" onClick={handleClone} disabled={!cloneName.trim() || busy}>
              {busy ? 'Cloning...' : 'Clone'}
            </button>
          </div>
        </div>
      </Dialog>

    </>
  );
}

export default function HomeView() {
  const { venvs, loading } = useVenvs();
  const [creating, setCreating] = useState(false);
  const [step, setStep] = useState(0);
  const [newName, setNewName] = useState('');
  const [selectedTemplate, setSelectedTemplate] = useState(TEMPLATES[0]);
  const [newEphemeral, setNewEphemeral] = useState(TEMPLATES[0].defaultEphemeral);
  const [hwCpu, setHwCpu] = useState(HW_DEFAULTS.cpu);
  const [hwRam, setHwRam] = useState(HW_DEFAULTS.ram);
  const [hwDisk, setHwDisk] = useState(HW_DEFAULTS.disk);
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
  const [formValues, setFormValues] = useState<Record<string, string | boolean>>({});
  const [allowAllDomains, setAllowAllDomains] = useState(false);
  const [mitmEnabled, setMitmEnabled] = useState(true);
  const [deleteTarget, setDeleteTarget] = useState<VenvInfo | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState<SnapshotProgress | null>(null);

  // Listen for snapshot/clone/export/import progress events.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let doneTimer: ReturnType<typeof setTimeout> | null = null;
    onSnapshotProgress((p) => {
      if (p.phase === 'done' || p.phase === 'error') {
        // Small delay so user sees 100% before modal closes.
        if (doneTimer) clearTimeout(doneTimer);
        doneTimer = setTimeout(() => setProgress(null), 500);
      } else {
        setProgress(p);
        // Safety: auto-dismiss if stuck at 100% for 3 seconds.
        if (p.total_bytes > 0 && p.bytes_processed >= p.total_bytes) {
          if (doneTimer) clearTimeout(doneTimer);
          doneTimer = setTimeout(() => setProgress(null), 3000);
        }
      }
    }).then((fn) => { unlisten = fn; });
    return () => { if (unlisten) unlisten(); if (doneTimer) clearTimeout(doneTimer); };
  }, []);

  useEffect(() => {
    loadVenvs();
  }, []);

  const handleSelectTemplate = useCallback((t: VenvTemplate) => {
    setSelectedTemplate(t);
    setNewEphemeral(t.defaultEphemeral);
    // Init form values from template field defaults
    const defaults: Record<string, string | boolean> = {};
    for (const f of t.setupForm ?? []) {
      if (f.default !== undefined) defaults[f.id] = f.default;
    }
    setFormValues(defaults);
    // Apply template network defaults
    setAllowAllDomains(t.defaultSettings?.['network.allow_all_domains'] === true);
    setMitmEnabled(t.defaultSettings?.['network.proxy_enabled'] !== false);
  }, []);

  const setApiKey = useCallback((id: string, value: string) => {
    setApiKeys((prev) => ({ ...prev, [id]: value }));
  }, []);

  const resetForm = useCallback(() => {
    setStep(0);
    setNewName('');
    setSelectedTemplate(TEMPLATES[0]);
    setNewEphemeral(TEMPLATES[0].defaultEphemeral);
    setFormValues({});
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
        // Save template default settings + network toggles.
        if (selectedTemplate.defaultSettings) {
          for (const [key, val] of Object.entries(selectedTemplate.defaultSettings)) {
            await updateSetting(key, val, venv.id);
          }
        }
        if (allowAllDomains) await updateSetting('network.allow_all_domains', true, venv.id);
        if (!mitmEnabled) await updateSetting('network.proxy_enabled', false, venv.id);
        // Auto-allow domains required by the template.
        if (selectedTemplate.requiredDomains?.length) {
          await updateSetting('network.custom_allow', selectedTemplate.requiredDomains.join(', '), venv.id);
        }
        // Save template setup script + form values for boot-time execution.
        if (selectedTemplate.setupScript) {
          await saveVenvFile(venv.id, 'setup.sh', selectedTemplate.setupScript);
          // Save form values as env file (KEY=VALUE lines) for the agent to source.
          const envLines = Object.entries(formValues)
            .filter(([, v]) => v !== '' && v !== undefined)
            .map(([k, v]) => `CLAWCAGE_FORM_${k}=${String(v)}`);
          if (envLines.length > 0) {
            await saveVenvFile(venv.id, 'setup.env', envLines.join('\n'));
          }
        }
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
  }, [newName, newEphemeral, allowAllDomains, mitmEnabled, selectedTemplate, hwCpu, hwRam, hwDisk, apiKeys, formValues, resetForm, submitting]);

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
        <div className="flex items-center gap-1.5">
          <button
            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-md border border-edge hover:bg-surface-alt transition font-medium"
            onClick={async () => {
              try {
                const { open } = await import('@tauri-apps/plugin-dialog');
                const path = await open({ filters: [{ name: 'Clawcage Archive', extensions: ['clawcage'] }] });
                if (path && typeof path === 'string') {
                  await importVenv(path);
                  showToast('Environment imported', 'success', 3000);
                  loadVenvs();
                }
              } catch (e) { showToast('Import failed: ' + String(e), 'error'); }
            }}
            aria-label="Import environment"
          >
            Import
          </button>
          <button
            className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md bg-interactive text-on-interactive hover:opacity-90 transition font-medium"
            onClick={() => setCreating(true)}
            aria-label="Create new environment"
          >
            <PlusIcon className="size-3.5" />
            New
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
      <div className="max-w-5xl w-full mx-auto px-6 py-6">

        {/* Create dialog */}
        <Dialog open={creating} onClose={handleCloseCreate} title="New Environment" width="max-w-lg">
          <div className="flex flex-col gap-3 min-h-80">
            {/* Step indicator */}
            <div className="flex items-center gap-1.5 mb-1">
              {['Template', 'Configure', 'Advanced'].map((label, i) => (
                <button
                  key={label}
                  className={`text-[11px] px-2 py-0.5 rounded-full transition-colors ${
                    step === i
                      ? 'bg-interactive/15 text-interactive font-medium'
                      : step > i
                        ? 'text-content/50 cursor-pointer hover:text-content/70'
                        : 'text-content/20'
                  }`}
                  onClick={() => { if (i < step) setStep(i); }}
                  disabled={i > step}
                >
                  {label}
                </button>
              ))}
            </div>

            {/* Step 0: Template */}
            {step === 0 && (
              <>
                <TemplatePicker selected={selectedTemplate.id} onSelect={handleSelectTemplate} />
              </>
            )}

            {/* Step 1: Configure */}
            {step === 1 && (
              <>
                <div className="flex items-center gap-2 mb-1">
                  <div className="flex items-center justify-center w-7 h-7 rounded-md bg-interactive/10">
                    <TemplateIcon icon={selectedTemplate.icon} logo={selectedTemplate.logo} className="size-4" />
                  </div>
                  <span className="text-xs text-content/50">{selectedTemplate.name}</span>
                </div>
                <div>
                  <label className="text-xs text-content/50 mb-1 block">Name</label>
                  <input
                    type="text"
                    className="w-full px-2.5 py-1.5 text-sm border border-edge rounded-md bg-surface focus:outline-none focus:ring-2 focus:ring-interactive/40"
                    placeholder="my-project"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && newName.trim()) setStep(2); }}
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
                {selectedTemplate.setupForm && selectedTemplate.setupForm.length > 0 && (
                  <TemplateFormSection
                    fields={selectedTemplate.setupForm}
                    values={formValues}
                    onValue={(id, v) => setFormValues((prev) => ({ ...prev, [id]: v }))}
                  />
                )}
              </>
            )}

            {/* Step 2: Advanced */}
            {step === 2 && (
              <>
                <div className="flex items-center gap-2 mb-1">
                  <div className="flex items-center justify-center w-7 h-7 rounded-md bg-interactive/10">
                    <TemplateIcon icon={selectedTemplate.icon} logo={selectedTemplate.logo} className="size-4" />
                  </div>
                  <span className="text-xs font-medium text-content/70">{newName}</span>
                  <span className="text-[10px] text-content/30">{selectedTemplate.name}</span>
                </div>
                <HardwareSection
                  cpu={hwCpu} ram={hwRam} disk={hwDisk}
                  onCpu={setHwCpu} onRam={setHwRam} onDisk={setHwDisk}
                />
                <ApiKeysSection keys={apiKeys} onKey={setApiKey} />
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
              </>
            )}

            {/* Navigation buttons */}
            <div className="flex items-center justify-between pt-1 mt-auto">
              <div>
                {step > 0 && (
                  <button
                    className="px-3 py-1.5 text-sm rounded-lg hover:bg-surface-alt transition-colors text-content/60"
                    onClick={() => setStep(step - 1)}
                  >
                    Back
                  </button>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  className="px-3 py-1.5 text-sm rounded-lg hover:bg-surface-alt transition-colors"
                  onClick={handleCloseCreate}
                >
                  Cancel
                </button>
                {step < 2 ? (
                  <button
                    className="px-3 py-1.5 text-sm rounded-lg bg-interactive text-on-interactive hover:opacity-90 transition font-medium disabled:opacity-40"
                    onClick={() => setStep(step + 1)}
                    disabled={step === 1 && !newName.trim()}
                  >
                    Next
                  </button>
                ) : (
                  <button
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-interactive text-on-interactive hover:opacity-90 transition font-medium disabled:opacity-40"
                    onClick={handleCreate}
                    disabled={!newName.trim() || submitting}
                  >
                    {submitting && <span className="spinner w-3.5 h-3.5" />}
                    {submitting ? 'Creating...' : 'Create'}
                  </button>
                )}
              </div>
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

        {/* Progress modal for snapshot/clone/export/import */}
        {progress && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm">
            <div className="max-w-sm w-full mx-4 glass-elevated border border-edge rounded-xl shadow-2xl px-6 py-5">
              <div className="flex flex-col items-center gap-4">
                <span className="spinner w-6 h-6 text-interactive" />
                <div className="text-center">
                  <p className="text-sm font-medium text-content capitalize">{progress.operation}...</p>
                  <p className="text-xs text-content/50 mt-0.5 capitalize">{progress.phase}</p>
                </div>
                {progress.total_bytes > 0 ? (
                  <div className="w-full">
                    <div className="h-1.5 bg-content/5 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-interactive rounded-full transition-all duration-300"
                        style={{ width: `${Math.min(100, (progress.bytes_processed / progress.total_bytes) * 100)}%` }}
                      />
                    </div>
                    <div className="flex items-center justify-between mt-1.5">
                      <span className="text-xs font-medium text-content/60 tabular-nums">
                        {Math.min(100, Math.round((progress.bytes_processed / progress.total_bytes) * 100))}%
                      </span>
                      <span className="text-[10px] text-content/30 tabular-nums">
                        {formatDiskSize(progress.bytes_processed)} / {formatDiskSize(progress.total_bytes)}
                      </span>
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-content/30">Please wait...</p>
                )}
                <button
                  className="px-3 py-1 text-xs rounded-md text-content/40 hover:text-content/70 hover:bg-surface-alt transition-colors"
                  onClick={() => setProgress(null)}
                >
                  Dismiss
                </button>
              </div>
            </div>
          </div>
        )}

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
            <h2 className="text-lg font-semibold mb-4">No environments yet</h2>
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
