// SettingsSection -- recursive settings tree renderer
import { useState, useCallback, useRef } from 'react';
import { useSettings } from '../../stores/settings';
import { showToast } from '../../stores/toast';
import { ChevronRight, ChevronDown } from '../../icons/Icons';
import type {
  SettingsNode, SettingsGroup, SettingsLeaf,
  SettingValue,
} from '../../types';

// ---------- Helpers ----------

function isDomainList(leaf: SettingsLeaf): boolean {
  return leaf.setting_type === 'text' && (
    leaf.id.endsWith('.domains') ||
    leaf.id === 'network.custom_allow' ||
    leaf.id === 'network.custom_block'
  );
}

function hasChoices(leaf: SettingsLeaf): boolean {
  return leaf.setting_type === 'text' && leaf.metadata.choices.length > 0;
}

/** True for controls that render below the label row instead of inline-right. */
function isBlockControl(leaf: SettingsLeaf): boolean {
  return isDomainList(leaf) || leaf.setting_type === 'file';
}

// ---------- Inline controls (right-aligned) ----------

function BoolControl({ leaf, onChange }: { leaf: SettingsLeaf; onChange: (v: boolean) => void }) {
  return (
    <input
      type="checkbox"
      className="toggle-switch"
      checked={leaf.effective_value === true}
      disabled={leaf.corp_locked || !leaf.enabled}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
}

function NumberControl({ leaf, onChange }: { leaf: SettingsLeaf; onChange: (v: number) => void }) {
  const [value, setValue] = useState(String(leaf.effective_value ?? ''));
  return (
    <input
      type="number"
      className="input input-xs w-24 font-mono text-xs border-edge bg-base-100 focus:outline-none focus:ring-1 focus:ring-interactive/40 disabled:opacity-40"
      value={value}
      disabled={leaf.corp_locked || !leaf.enabled}
      min={leaf.metadata.min ?? undefined}
      max={leaf.metadata.max ?? undefined}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => { const n = Number(value); if (!isNaN(n)) onChange(n); }}
      onKeyDown={(e) => { if (e.key === 'Enter') { const n = Number(value); if (!isNaN(n)) onChange(n); } }}
    />
  );
}

function ChoiceControl({ leaf, onChange }: { leaf: SettingsLeaf; onChange: (v: string) => void }) {
  return (
    <select
      className="select select-xs border-edge bg-base-100 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-interactive/40 disabled:opacity-40"
      value={String(leaf.effective_value ?? '')}
      disabled={leaf.corp_locked || !leaf.enabled}
      onChange={(e) => onChange(e.target.value)}
    >
      {leaf.metadata.choices.map((c) => (
        <option key={c} value={c}>{c}</option>
      ))}
    </select>
  );
}

function TextControl({ leaf, onChange }: { leaf: SettingsLeaf; onChange: (v: string) => void }) {
  const [value, setValue] = useState(String(leaf.effective_value ?? ''));
  const isSecret = leaf.setting_type === 'password' || leaf.setting_type === 'apikey';
  const [revealed, setRevealed] = useState(false);

  return (
    <div className="flex items-center gap-1.5">
      <input
        type={revealed ? 'text' : isSecret ? 'password' : 'text'}
        className="input input-xs w-52 font-mono text-xs border-edge bg-base-100 focus:outline-none focus:ring-1 focus:ring-interactive/40 disabled:opacity-40"
        value={value}
        disabled={leaf.corp_locked || !leaf.enabled}
        placeholder={String(leaf.default_value ?? '')}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => { if (value !== String(leaf.effective_value ?? '')) onChange(value); }}
        onKeyDown={(e) => { if (e.key === 'Enter') onChange(value); }}
      />
      {isSecret && (
        <button
          className="btn btn-ghost btn-xs text-base-content/40 hover:text-base-content"
          onClick={() => setRevealed(!revealed)}
        >
          {revealed ? 'Hide' : 'Show'}
        </button>
      )}
      {isSecret && value && (
        <button
          className="btn btn-ghost btn-xs text-base-content/40 hover:text-base-content"
          onClick={() => { navigator.clipboard.writeText(value); showToast('Copied', 'success', 2000); }}
        >
          Copy
        </button>
      )}
    </div>
  );
}

// ---------- Block controls (full-width, below label) ----------

function DomainListControl({ leaf, onChange }: { leaf: SettingsLeaf; onChange: (v: string) => void }) {
  const parse = (v: string) => v.split(',').map(s => s.trim()).filter(Boolean);
  const [domains, setDomains] = useState(() => parse(String(leaf.effective_value ?? '')));
  const [input, setInput] = useState('');
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const disabled = leaf.corp_locked || !leaf.enabled;

  const commit = (next: string[]) => {
    setDomains(next);
    onChange(next.join(', '));
  };

  const add = (raw: string) => {
    const items = parse(raw);
    if (items.length === 0) return;
    const next = [...domains];
    for (const item of items) {
      if (!next.includes(item)) next.push(item);
    }
    commit(next);
    setInput('');
  };

  const remove = (index: number) => {
    commit(domains.filter((_, i) => i !== index));
  };

  return (
    <div className={`rounded-lg border border-edge overflow-hidden ${disabled ? 'opacity-40 pointer-events-none' : ''}`}>
      {/* Domain rows */}
      {domains.length > 0 && (
        <div className="bg-base-100">
          {domains.map((d, i) => (
            <div
              key={`${d}-${i}`}
              className="flex items-center gap-2.5 px-3 py-2 border-b border-edge/20 last:border-b-0 group hover:bg-base-200/40 transition-colors"
            >
              <span className="size-1.5 rounded-full bg-interactive/40 shrink-0" />
              <span className="flex-1 text-xs font-mono text-base-content/75 select-all">{d}</span>
              {!disabled && (
                <button
                  className="size-5 flex items-center justify-center rounded text-base-content/25 hover:text-denied hover:bg-denied/10 text-xs transition-all shrink-0"
                  onClick={() => remove(i)}
                  title="Remove domain"
                >
                  &times;
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Add input */}
      {!disabled && (
        <div className={`flex items-center gap-2.5 px-3 py-2 bg-base-200/30 ${domains.length > 0 ? 'border-t border-edge/40' : ''}`}>
          <span className={`text-xs transition-colors ${focused ? 'text-interactive' : 'text-base-content/25'}`}>+</span>
          <input
            ref={inputRef}
            className="flex-1 bg-transparent text-xs font-mono outline-none text-base-content placeholder:text-base-content/30"
            value={input}
            placeholder={domains.length === 0 ? 'Type a domain and press Enter' : 'Add domain...'}
            onFocus={() => setFocused(true)}
            onBlur={() => { setFocused(false); if (input.trim()) add(input); }}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                add(input);
              } else if (e.key === 'Backspace' && input === '' && domains.length > 0) {
                remove(domains.length - 1);
              }
            }}
          />
        </div>
      )}
    </div>
  );
}

function FileControl({ leaf, onChange }: { leaf: SettingsLeaf; onChange: (v: { path: string; content: string }) => void }) {
  const fileValue = typeof leaf.effective_value === 'object' && leaf.effective_value !== null
    ? leaf.effective_value as { path: string; content: string }
    : { path: '', content: '' };
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(fileValue.content);
  const disabled = leaf.corp_locked || !leaf.enabled;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs text-base-content/40 truncate">{fileValue.path || 'No file'}</span>
        <button
          className="btn btn-ghost btn-xs text-base-content/40 hover:text-base-content"
          onClick={() => setEditing(!editing)}
          disabled={disabled}
        >
          {editing ? 'Close' : 'Edit'}
        </button>
      </div>
      {editing && (
        <div className="space-y-2">
          <textarea
            className="w-full font-mono h-28 text-xs px-3 py-2 rounded-md border border-edge bg-base-100 focus:outline-none focus:ring-1 focus:ring-interactive/40 disabled:opacity-40 resize-y"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            disabled={disabled}
          />
          <button
            className="btn btn-xs bg-interactive text-on-interactive"
            onClick={() => { onChange({ path: fileValue.path, content }); setEditing(false); }}
          >
            Save
          </button>
        </div>
      )}
    </div>
  );
}

// ---------- Setting row ----------

function SettingRow({ leaf }: { leaf: SettingsLeaf }) {
  const { update, resetVenv, issuesFor, venvId } = useSettings();
  const issues = issuesFor(leaf.id);

  const handleChange = useCallback((value: SettingValue) => {
    update(leaf.id, value);
  }, [leaf.id, update]);

  const sourceLabel = leaf.source === 'corp' ? 'Corp' : leaf.source === 'venv' ? 'Venv' : leaf.source === 'user' ? 'User' : '';
  const sourceBadge = leaf.source === 'corp'
    ? 'bg-caution/15 text-caution'
    : leaf.source === 'venv'
      ? 'bg-interactive/15 text-interactive'
      : leaf.source === 'user'
        ? 'bg-base-content/8 text-base-content/50'
        : '';

  const block = isBlockControl(leaf);

  const control = (() => {
    if (leaf.setting_type === 'bool') return <BoolControl leaf={leaf} onChange={handleChange} />;
    if (isDomainList(leaf)) return <DomainListControl leaf={leaf} onChange={handleChange} />;
    if (hasChoices(leaf)) return <ChoiceControl leaf={leaf} onChange={handleChange} />;
    if (leaf.setting_type === 'number') return <NumberControl leaf={leaf} onChange={handleChange} />;
    if (leaf.setting_type === 'file') return <FileControl leaf={leaf} onChange={handleChange} />;
    return <TextControl leaf={leaf} onChange={handleChange} />;
  })();

  return (
    <div className={`py-3.5 ${!leaf.enabled ? 'opacity-40' : ''}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-base-content/85">{leaf.name}</span>
            {leaf.corp_locked && (
              <span className="badge badge-xs bg-caution/15 text-caution font-semibold">Locked</span>
            )}
            {sourceLabel && (
              <span className={`badge badge-xs ${sourceBadge}`}>{sourceLabel}</span>
            )}
            {venvId && leaf.venv_overridden && (
              <button
                className="text-xs text-base-content/35 hover:text-interactive underline"
                onClick={() => resetVenv(leaf.id)}
              >
                Reset
              </button>
            )}
          </div>
          <p className="text-xs text-base-content/35 mt-0.5 leading-relaxed">{leaf.description}</p>
        </div>
        {!block && <div className="shrink-0 pt-0.5">{control}</div>}
      </div>

      {block && <div className="mt-2.5">{control}</div>}

      {issues.length > 0 && (
        <div className="mt-2 space-y-0.5">
          {issues.map((issue, i) => (
            <p key={i} className={`text-xs ${issue.severity === 'error' ? 'text-denied' : 'text-caution'}`}>
              {issue.message}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- Group ----------

function GroupSection({ group, depth }: { group: SettingsGroup; depth: number }) {
  const [collapsed, setCollapsed] = useState(group.collapsed ?? depth > 1);

  return (
    <div className={depth > 0 ? 'mt-1' : ''}>
      <button
        className={`flex items-center gap-1.5 w-full text-left rounded-md transition-colors
          ${depth === 0
            ? 'py-2.5 px-1 hover:bg-base-200/40'
            : 'py-1.5 px-1 hover:bg-base-200/30'
          }`}
        onClick={() => setCollapsed(!collapsed)}
      >
        {collapsed
          ? <ChevronRight className="size-3 text-base-content/25 shrink-0" />
          : <ChevronDown className="size-3 text-base-content/25 shrink-0" />
        }
        <span className={`font-semibold ${
          depth === 0
            ? 'text-sm text-base-content/70'
            : 'text-xs text-base-content/55'
        }`}>
          {group.name}
        </span>
        {group.description && (
          <span className="text-xs text-base-content/25 truncate">{group.description}</span>
        )}
      </button>
      {!collapsed && (
        <div className={depth > 0 ? 'ml-4 pl-3 border-l border-edge/30' : ''}>
          <div className="divide-y divide-edge/30">
            {group.children.map((child) => (
              <NodeRenderer
                key={child.kind === 'leaf' ? child.id : child.key}
                node={child}
                depth={depth + 1}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- Dispatcher ----------

function NodeRenderer({ node, depth }: { node: SettingsNode; depth: number }) {
  if (node.kind === 'leaf') return <SettingRow leaf={node} />;
  return <GroupSection group={node} depth={depth} />;
}

// ---------- Public ----------

interface Props {
  sectionName: string;
}

export default function SettingsSection({ sectionName }: Props) {
  const { section, loading, error } = useSettings();
  const group = section(sectionName);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <span className="loading loading-spinner loading-sm text-base-content/20" />
      </div>
    );
  }
  if (error) return <div className="p-6 text-denied text-sm">{error}</div>;
  if (!group) return <div className="p-6 text-base-content/30 text-sm">Section &ldquo;{sectionName}&rdquo; not found</div>;

  return (
    <div className="p-5 overflow-auto h-full">
      <div className="max-w-2xl">
        {group.kind === 'group' ? (
          <div className="space-y-1">
            {group.children.map((child) => (
              <NodeRenderer key={child.kind === 'leaf' ? child.id : child.key} node={child} depth={0} />
            ))}
          </div>
        ) : (
          <SettingRow leaf={group as SettingsLeaf} />
        )}
      </div>
    </div>
  );
}
