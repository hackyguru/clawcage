// SettingsSection -- recursive settings tree renderer
import { useState, useMemo, useCallback } from 'react';
import { useSettings } from '../../stores/settings';
import { ChevronRight, ChevronDown } from '../../icons/Icons';
import type {
  SettingsNode, SettingsGroup, SettingsLeaf,
  SettingValue, ConfigIssue, SettingType,
} from '../../types';

// ---------- Leaf renderers ----------

function BoolField({ leaf, onChange }: { leaf: SettingsLeaf; onChange: (v: boolean) => void }) {
  return (
    <input
      type="checkbox"
  className="h-4 w-4 rounded border-2 border-primary-400 bg-[--color-base-100] checked:bg-primary-500 focus:ring-2 focus:ring-primary-400 disabled:opacity-40 transition"
      checked={leaf.effective_value === true}
      disabled={leaf.corp_locked || !leaf.enabled}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
}

function TextField({ leaf, onChange }: { leaf: SettingsLeaf; onChange: (v: string) => void }) {
  const [value, setValue] = useState(String(leaf.effective_value ?? ''));
  const inputType = leaf.setting_type === 'password' || leaf.setting_type === 'apikey' ? 'password' : 'text';
  const [revealed, setRevealed] = useState(false);

  return (
    <div className="flex items-center gap-1">
      <input
        type={revealed ? 'text' : inputType}
  className="w-full max-w-xs font-mono text-xs px-2 py-1 border border-neutral-300 rounded bg-[--color-base-100] focus:outline-none focus:ring-2 focus:ring-primary-400 disabled:opacity-40 transition"
        value={value}
        disabled={leaf.corp_locked || !leaf.enabled}
        placeholder={String(leaf.default_value ?? '')}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => { if (value !== String(leaf.effective_value ?? '')) onChange(value); }}
        onKeyDown={(e) => { if (e.key === 'Enter') onChange(value); }}
      />
      {(leaf.setting_type === 'password' || leaf.setting_type === 'apikey') && (
        <button
          className="btn btn-ghost btn-xs"
          onClick={() => setRevealed(!revealed)}
          title={revealed ? 'Hide' : 'Reveal'}
        >
          {revealed ? '🙈' : '👁'}
        </button>
      )}
    </div>
  );
}

function NumberField({ leaf, onChange }: { leaf: SettingsLeaf; onChange: (v: number) => void }) {
  const [value, setValue] = useState(String(leaf.effective_value ?? ''));

  return (
    <input
      type="number"
  className="w-28 font-mono text-xs px-2 py-1 border border-neutral-300 rounded bg-[--color-base-100] focus:outline-none focus:ring-2 focus:ring-primary-400 disabled:opacity-40 transition"
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

function FileField({ leaf, onChange }: { leaf: SettingsLeaf; onChange: (v: { path: string; content: string }) => void }) {
  const fileValue = typeof leaf.effective_value === 'object' && leaf.effective_value !== null
    ? leaf.effective_value as { path: string; content: string }
    : { path: '', content: '' };
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(fileValue.content);

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs text-base-content/60">{fileValue.path || 'No file'}</span>
        <button className="btn btn-ghost btn-xs" onClick={() => setEditing(!editing)}>
          {editing ? 'Close' : 'Edit'}
        </button>
      </div>
      {editing && (
        <div className="space-y-1">
          <textarea
            className="w-full font-mono h-32 text-xs px-2 py-1 border border-neutral-300 rounded bg-[--color-base-100] focus:outline-none focus:ring-2 focus:ring-primary-400 disabled:opacity-40 transition"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            disabled={leaf.corp_locked || !leaf.enabled}
          />
          <button
            className="btn btn-primary btn-xs"
            onClick={() => { onChange({ path: fileValue.path, content }); setEditing(false); }}
          >
            Save
          </button>
        </div>
      )}
    </div>
  );
}

// ---------- Leaf component (handles all types) ----------

function LeafNode({ leaf }: { leaf: SettingsLeaf }) {
  const { update, issuesFor } = useSettings();
  const issues = issuesFor(leaf.id);

  const handleChange = useCallback((value: SettingValue) => {
    update(leaf.id, value);
  }, [leaf.id, update]);

  const sourceLabel = leaf.source === 'corp' ? '🏢 Corp' : leaf.source === 'user' ? '👤 User' : '';

  return (
    <div className={`py-2 px-3 rounded-lg ${!leaf.enabled ? 'opacity-40' : ''}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{leaf.name}</span>
            {leaf.corp_locked && <span className="inline-block px-2 py-0.5 rounded bg-yellow-100 text-yellow-700 text-xs font-semibold ml-1">Locked</span>}
            {sourceLabel && <span className="text-xs text-base-content/50">{sourceLabel}</span>}
          </div>
          <p className="text-xs text-base-content/60 mt-0.5">{leaf.description}</p>
          {issues.length > 0 && (
            <div className="mt-1 space-y-0.5">
              {issues.map((issue, i) => (
                <div key={i} className={`text-xs ${issue.severity === 'error' ? 'text-error' : 'text-warning'}`}>
                  {issue.severity === 'error' ? '⛔' : '⚠️'} {issue.message}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="shrink-0">
          {leaf.setting_type === 'bool' && <BoolField leaf={leaf} onChange={handleChange} />}
          {(leaf.setting_type === 'text' || leaf.setting_type === 'password' || leaf.setting_type === 'apikey' || leaf.setting_type === 'url' || leaf.setting_type === 'email') && (
            <TextField leaf={leaf} onChange={handleChange} />
          )}
          {leaf.setting_type === 'number' && <NumberField leaf={leaf} onChange={handleChange} />}
          {leaf.setting_type === 'file' && <FileField leaf={leaf} onChange={handleChange} />}
        </div>
      </div>
    </div>
  );
}

// ---------- Group component (recursive) ----------

function GroupNode({ group, depth }: { group: SettingsGroup; depth: number }) {
  const [collapsed, setCollapsed] = useState(group.collapsed ?? depth > 1);

  return (
    <div className={depth > 0 ? 'ml-2 border-l border-base-300 pl-2' : ''}>
      <button
  className="flex items-center gap-1.5 py-1.5 w-full text-left hover:bg-[--color-base-100] rounded px-1 transition-colors"
        onClick={() => setCollapsed(!collapsed)}
      >
        {collapsed ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
        <span className={`font-semibold ${depth === 0 ? 'text-sm' : 'text-xs'}`}>{group.name}</span>
        {group.description && <span className="text-xs text-base-content/50 truncate">{group.description}</span>}
      </button>
      {!collapsed && (
        <div className="space-y-0.5">
          {group.children.map((child) => (
            <SettingsNodeComponent key={child.kind === 'leaf' ? child.id : child.key} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- Dispatcher ----------

function SettingsNodeComponent({ node, depth }: { node: SettingsNode; depth: number }) {
  if (node.kind === 'leaf') return <LeafNode leaf={node} />;
  return <GroupNode group={node} depth={depth} />;
}

// ---------- Public component ----------

interface Props {
  sectionName: string;
}

export default function SettingsSection({ sectionName }: Props) {
  const { section, loading, error } = useSettings();
  const group = section(sectionName);

  if (loading) return <div className="p-4 text-base-content/50 text-sm">Loading settings…</div>;
  if (error) return <div className="p-4 text-error text-sm">{error}</div>;
  if (!group) return <div className="p-4 text-base-content/30 text-sm">Section "{sectionName}" not found</div>;

  return (
  <div className="p-4 space-y-1 overflow-auto h-full hover:bg-[--color-base-100]">
      {group.kind === 'group' ? (
        group.children.map((child) => (
          <SettingsNodeComponent key={child.kind === 'leaf' ? child.id : child.key} node={child} depth={0} />
        ))
      ) : (
        <LeafNode leaf={group as SettingsLeaf} />
      )}
    </div>
  );
}
