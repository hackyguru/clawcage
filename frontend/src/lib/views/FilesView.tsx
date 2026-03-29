// FilesView -- real file browser with lazy directory loading + CodeMirror editor
import { useState, useEffect, useCallback, useRef } from 'react';
import { listDir, readFile, saveFile } from '../api';
import { showToast } from '../stores/toast';
import { useTheme } from '../stores/theme';
import { FolderIcon, FileIcon, ChevronRight, ChevronDown } from '../icons/Icons';
import type { DirEntry } from '../types';

// CodeMirror imports
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, rectangularSelection } from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
import { defaultKeymap, indentWithTab, history, historyKeymap } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching, foldGutter, indentOnInput, HighlightStyle } from '@codemirror/language';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { json } from '@codemirror/lang-json';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { markdown } from '@codemirror/lang-markdown';
import { rust } from '@codemirror/lang-rust';
import { cpp } from '@codemirror/lang-cpp';
import { java } from '@codemirror/lang-java';
import { xml } from '@codemirror/lang-xml';
import { yaml } from '@codemirror/lang-yaml';
import { sql } from '@codemirror/lang-sql';
import { tags } from '@lezer/highlight';

// ── Types ─────────────────────────────────────────────────────────

interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modified: number;
  /** Lazily loaded children (null = not yet loaded). */
  children: TreeNode[] | null;
  loading?: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────

function langFromFilename(name: string) {
  const ext = name.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'js': case 'mjs': case 'cjs': return javascript();
    case 'ts': case 'mts': case 'cts': return javascript({ typescript: true });
    case 'jsx': return javascript({ jsx: true });
    case 'tsx': return javascript({ jsx: true, typescript: true });
    case 'py': case 'pyw': return python();
    case 'json': case 'jsonc': return json();
    case 'html': case 'htm': case 'svelte': case 'vue': return html();
    case 'css': case 'scss': case 'less': return css();
    case 'md': case 'mdx': case 'markdown': return markdown();
    case 'rs': return rust();
    case 'c': case 'h': case 'cpp': case 'cc': case 'cxx': case 'hpp': return cpp();
    case 'java': case 'kt': case 'kts': return java();
    case 'xml': case 'svg': case 'plist': return xml();
    case 'yml': case 'yaml': return yaml();
    case 'sql': return sql();
    case 'toml': return yaml();
    default: return undefined;
  }
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(epoch: number): string {
  if (!epoch) return '';
  const d = new Date(epoch * 1000);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return d.toLocaleDateString();
}

function entriesToNodes(parentPath: string, entries: DirEntry[]): TreeNode[] {
  return entries.map((e) => ({
    name: e.name,
    path: parentPath === '/' ? `/${e.name}` : `${parentPath}/${e.name}`,
    isDir: e.is_dir,
    size: e.size,
    modified: e.modified,
    children: e.is_dir ? null : null,
  }));
}

// ── CodeMirror themes ─────────────────────────────────────────────

const darkTheme = EditorView.theme({
  '&': { backgroundColor: 'transparent', color: '#c9d1d9', fontSize: '12px' },
  '.cm-content': { caretColor: '#58a6ff', fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace' },
  '.cm-cursor': { borderLeftColor: '#58a6ff' },
  '.cm-gutters': { backgroundColor: 'transparent', color: '#484f58', borderRight: '1px solid rgba(255,255,255,0.06)' },
  '.cm-activeLineGutter': { backgroundColor: 'rgba(255,255,255,0.04)' },
  '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.04)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: 'rgba(56,139,253,0.2)' },
  '.cm-matchingBracket': { backgroundColor: 'rgba(56,139,253,0.25)', outline: 'none' },
  '.cm-searchMatch': { backgroundColor: 'rgba(210,153,34,0.3)' },
  '.cm-foldGutter .cm-gutterElement': { color: '#484f58' },
}, { dark: true });

const lightTheme = EditorView.theme({
  '&': { backgroundColor: 'transparent', color: '#24292f', fontSize: '12px' },
  '.cm-content': { caretColor: '#0969da', fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace' },
  '.cm-cursor': { borderLeftColor: '#0969da' },
  '.cm-gutters': { backgroundColor: 'transparent', color: '#8c959f', borderRight: '1px solid rgba(0,0,0,0.06)' },
  '.cm-activeLineGutter': { backgroundColor: 'rgba(0,0,0,0.03)' },
  '.cm-activeLine': { backgroundColor: 'rgba(0,0,0,0.03)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: 'rgba(9,105,218,0.15)' },
  '.cm-matchingBracket': { backgroundColor: 'rgba(9,105,218,0.2)', outline: 'none' },
  '.cm-searchMatch': { backgroundColor: 'rgba(210,153,34,0.25)' },
  '.cm-foldGutter .cm-gutterElement': { color: '#8c959f' },
}, { dark: false });

const darkHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: '#ff7b72' },
  { tag: tags.string, color: '#a5d6ff' },
  { tag: tags.number, color: '#79c0ff' },
  { tag: tags.bool, color: '#79c0ff' },
  { tag: tags.null, color: '#79c0ff' },
  { tag: tags.comment, color: '#8b949e', fontStyle: 'italic' },
  { tag: tags.variableName, color: '#c9d1d9' },
  { tag: tags.definition(tags.variableName), color: '#d2a8ff' },
  { tag: tags.function(tags.variableName), color: '#d2a8ff' },
  { tag: tags.typeName, color: '#ff7b72' },
  { tag: tags.className, color: '#f0883e' },
  { tag: tags.propertyName, color: '#79c0ff' },
  { tag: tags.operator, color: '#ff7b72' },
  { tag: tags.punctuation, color: '#8b949e' },
  { tag: tags.bracket, color: '#8b949e' },
  { tag: tags.meta, color: '#79c0ff' },
  { tag: tags.tagName, color: '#7ee787' },
  { tag: tags.attributeName, color: '#79c0ff' },
  { tag: tags.attributeValue, color: '#a5d6ff' },
  { tag: tags.heading, color: '#79c0ff', fontWeight: 'bold' },
  { tag: tags.link, color: '#a5d6ff', textDecoration: 'underline' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: 'bold' },
]);

const lightHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: '#cf222e' },
  { tag: tags.string, color: '#0a3069' },
  { tag: tags.number, color: '#0550ae' },
  { tag: tags.bool, color: '#0550ae' },
  { tag: tags.null, color: '#0550ae' },
  { tag: tags.comment, color: '#6e7781', fontStyle: 'italic' },
  { tag: tags.variableName, color: '#24292f' },
  { tag: tags.definition(tags.variableName), color: '#8250df' },
  { tag: tags.function(tags.variableName), color: '#8250df' },
  { tag: tags.typeName, color: '#cf222e' },
  { tag: tags.className, color: '#953800' },
  { tag: tags.propertyName, color: '#0550ae' },
  { tag: tags.operator, color: '#cf222e' },
  { tag: tags.punctuation, color: '#6e7781' },
  { tag: tags.bracket, color: '#6e7781' },
  { tag: tags.meta, color: '#0550ae' },
  { tag: tags.tagName, color: '#116329' },
  { tag: tags.attributeName, color: '#0550ae' },
  { tag: tags.attributeValue, color: '#0a3069' },
  { tag: tags.heading, color: '#0550ae', fontWeight: 'bold' },
  { tag: tags.link, color: '#0a3069', textDecoration: 'underline' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: 'bold' },
]);

// ── Tree row ──────────────────────────────────────────────────────

function TreeRow({
  node,
  depth,
  expanded,
  onToggle,
  selectedPath,
  onSelect,
  showDotfiles,
}: {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  selectedPath: string | null;
  onSelect: (node: TreeNode) => void;
  showDotfiles: boolean;
}) {
  const isOpen = expanded.has(node.path);
  const isSelected = selectedPath === node.path;

  const visibleChildren = (node.children ?? []).filter(
    (c) => showDotfiles || !c.name.startsWith('.')
  );

  return (
    <>
      <div
        className={`group flex items-center w-full h-7 text-left transition-colors cursor-default select-none ${
          isSelected
            ? 'bg-interactive/10'
            : 'hover:bg-surface-alt/60'
        }`}
        style={{ paddingLeft: `${depth * 16 + 8}px`, paddingRight: 8 }}
        onClick={() => {
          if (node.isDir) onToggle(node.path);
          else onSelect(node);
        }}
      >
        {/* Chevron */}
        <span className="w-4 shrink-0 flex items-center justify-center">
          {node.isDir ? (
            node.loading
              ? <span className="spinner w-3 h-3 text-content/30" />
              : isOpen
                ? <ChevronDown className="size-3 text-content/30" />
                : <ChevronRight className="size-3 text-content/30" />
          ) : null}
        </span>

        {/* Icon */}
        <span className="shrink-0 mr-1.5">
          {node.isDir ? (
            <FolderIcon className="size-4 text-interactive/60" />
          ) : (
            <FileIcon className="size-3.5 text-content/30" />
          )}
        </span>

        {/* Name */}
        <span className={`text-xs truncate flex-1 ${
          node.isDir ? 'font-medium text-content/70' : 'text-content/60'
        }`}>
          {node.name}
        </span>

        {/* Size + time */}
        {!node.isDir && node.size > 0 && (
          <span className="text-[10px] text-content/25 font-mono ml-2 tabular-nums shrink-0">
            {formatSize(node.size)}
          </span>
        )}
        {node.modified > 0 && (
          <span className="text-[10px] text-content/20 ml-2 shrink-0 hidden group-hover:inline">
            {formatTime(node.modified)}
          </span>
        )}
      </div>

      {node.isDir && isOpen && visibleChildren.map((child) => (
        <TreeRow
          key={child.path}
          node={child}
          depth={depth + 1}
          expanded={expanded}
          onToggle={onToggle}
          selectedPath={selectedPath}
          onSelect={onSelect}
          showDotfiles={showDotfiles}
        />
      ))}
    </>
  );
}

// ── Editor panel ──────────────────────────────────────────────────

function EditorPanel({
  node,
  onClose,
}: {
  node: TreeNode;
  onClose: () => void;
}) {
  const guestPath = node.path;

  const [content, setContent] = useState<string | null>(null);
  const [original, setOriginal] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const themeCompartment = useRef(new Compartment());
  const contentRef = useRef<string | null>(null);
  const { theme } = useTheme();

  useEffect(() => {
    setContent(null);
    setOriginal(null);
    setLoadError(null);
    readFile(guestPath).then((text) => {
      setContent(text);
      setOriginal(text);
    }).catch((e) => {
      setLoadError(e?.message ?? String(e));
    });
  }, [guestPath]);

  useEffect(() => { contentRef.current = content; }, [content]);

  const isDirty = content !== null && content !== original;

  const handleSave = useCallback(async () => {
    const cur = contentRef.current;
    if (cur === null || cur === original) return;
    setSaving(true);
    try {
      await saveFile(guestPath, cur);
      setOriginal(cur);
      showToast('File saved', 'success', 2000);
    } catch (e: any) {
      showToast(`Save failed: ${e?.message ?? e}`, 'error');
    } finally {
      setSaving(false);
    }
  }, [guestPath, original]);

  useEffect(() => {
    if (content === null || !editorRef.current) return;
    if (viewRef.current) return;

    const isDark = theme === 'dark';
    const lang = langFromFilename(node.name);

    const extensions = [
      lineNumbers(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      drawSelection(),
      rectangularSelection(),
      bracketMatching(),
      closeBrackets(),
      indentOnInput(),
      foldGutter(),
      highlightSelectionMatches(),
      history(),
      keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        indentWithTab,
      ]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          const doc = update.state.doc.toString();
          contentRef.current = doc;
          setContent(doc);
        }
      }),
      themeCompartment.current.of([
        isDark ? darkTheme : lightTheme,
        syntaxHighlighting(isDark ? darkHighlight : lightHighlight),
      ]),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      EditorView.lineWrapping,
    ];
    if (lang) extensions.push(lang);

    const state = EditorState.create({ doc: content, extensions });
    const view = new EditorView({ state, parent: editorRef.current });
    viewRef.current = view;

    return () => { view.destroy(); viewRef.current = null; };
  }, [content !== null]);

  useEffect(() => {
    if (!viewRef.current) return;
    const isDark = theme === 'dark';
    viewRef.current.dispatch({
      effects: themeCompartment.current.reconfigure([
        isDark ? darkTheme : lightTheme,
        syntaxHighlighting(isDark ? darkHighlight : lightHighlight),
      ]),
    });
  }, [theme]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleSave]);

  const lineCount = content?.split('\n').length ?? 0;

  return (
    <div className="flex flex-col h-full border-l border-edge">
      <div className="flex items-center justify-between px-3 h-9 border-b border-edge shrink-0 bg-surface/40">
        <div className="flex items-center gap-2 min-w-0">
          <FileIcon className="size-3.5 text-content/30 shrink-0" />
          <span className="text-xs font-medium text-content/70 truncate">{node.name}</span>
          {isDirty && <span className="size-1.5 rounded-full bg-caution shrink-0" title="Unsaved changes" />}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {isDirty && (
            <button
              className="px-2 py-0.5 text-xs rounded-md bg-interactive text-on-interactive hover:opacity-90 transition-opacity font-medium disabled:opacity-50"
              onClick={handleSave}
              disabled={saving}
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
          )}
          <button
            className="px-1.5 py-0.5 text-xs rounded text-content/40 hover:text-content/70 transition-colors"
            onClick={onClose}
          >
            &times;
          </button>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {loadError ? (
          <div className="flex flex-col items-center justify-center h-full text-content/30 text-xs gap-2 px-4">
            <p className="text-center">{loadError}</p>
          </div>
        ) : content === null ? (
          <div className="flex items-center justify-center h-full">
            <span className="spinner w-5 h-5 text-content/30" />
          </div>
        ) : (
          <div ref={editorRef} className="h-full" />
        )}
      </div>
      {content !== null && (
        <div className="flex items-center justify-between px-3 h-6 border-t border-edge text-[10px] text-content/30 shrink-0 bg-surface/20">
          <span className="font-mono truncate">{guestPath}</span>
          <span className="font-mono shrink-0 ml-4">{lineCount} lines</span>
        </div>
      )}
    </div>
  );
}

// ── Main view ─────────────────────────────────────────────────────

const ROOT_PATH = '/root';

export default function FilesView() {
  const [rootNodes, setRootNodes] = useState<TreeNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<TreeNode | null>(null);
  const [showDotfiles, setShowDotfiles] = useState(false);
  // Store loaded children keyed by dir path for lazy loading.
  const childrenCache = useRef<Map<string, TreeNode[]>>(new Map());

  // Load root directory on mount.
  const loadRoot = useCallback(async () => {
    try {
      const entries = await listDir(ROOT_PATH);
      const nodes = entriesToNodes(ROOT_PATH, entries);
      childrenCache.current.set(ROOT_PATH, nodes);
      setRootNodes(nodes);
      setError(null);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRoot();
  }, [loadRoot]);

  // Load children for a directory.
  const loadChildren = useCallback(async (dirPath: string) => {
    // Already cached?
    if (childrenCache.current.has(dirPath)) return;

    // Mark as loading.
    updateNode(dirPath, (n) => ({ ...n, loading: true }));

    try {
      const entries = await listDir(dirPath);
      const children = entriesToNodes(dirPath, entries);
      childrenCache.current.set(dirPath, children);
      updateNode(dirPath, (n) => ({ ...n, children, loading: false }));
    } catch {
      updateNode(dirPath, (n) => ({ ...n, children: [], loading: false }));
    }
  }, []);

  // Update a node in the tree by path.
  function updateNode(path: string, updater: (n: TreeNode) => TreeNode) {
    setRootNodes((prev) => deepUpdate(prev, path, updater));
  }

  function deepUpdate(nodes: TreeNode[], path: string, updater: (n: TreeNode) => TreeNode): TreeNode[] {
    return nodes.map((n) => {
      if (n.path === path) return updater(n);
      if (path.startsWith(n.path + '/') && n.children) {
        return { ...n, children: deepUpdate(n.children, path, updater) };
      }
      return n;
    });
  }

  const toggleExpand = useCallback(async (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
        // Lazy load children when expanding for the first time.
        if (!childrenCache.current.has(path)) {
          loadChildren(path);
        }
      }
      return next;
    });
  }, [loadChildren]);

  const refresh = useCallback(async () => {
    childrenCache.current.clear();
    setLoading(true);
    await loadRoot();
    // Re-expand all previously expanded dirs.
    for (const dir of expanded) {
      if (dir !== ROOT_PATH) loadChildren(dir);
    }
  }, [loadRoot, expanded, loadChildren]);

  const visibleNodes = showDotfiles
    ? rootNodes
    : rootNodes.filter((n) => !n.name.startsWith('.'));

  const fileCount = rootNodes.filter((n) => !n.isDir).length;
  const dirCount = rootNodes.filter((n) => n.isDir).length;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-edge shrink-0">
        <div>
          <h2 className="text-sm font-semibold">Files</h2>
          <p className="text-xs text-content/50 mt-0.5">
            Browse files in the virtual environment
          </p>
        </div>
        {rootNodes.length > 0 && (
          <span className="text-xs text-content/40 tabular-nums">
            {dirCount} folder{dirCount !== 1 ? 's' : ''}, {fileCount} file{fileCount !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-3 px-4 h-9 border-b border-edge shrink-0">
        <span className="text-[11px] text-content/40 font-mono">{ROOT_PATH}</span>
        <span className="flex-1" />
        <label className="flex items-center gap-1.5 cursor-pointer select-none">
          <input
            type="checkbox"
            className="toggle-switch"
            checked={showDotfiles}
            onChange={(e) => setShowDotfiles(e.target.checked)}
          />
          <span className="text-[11px] text-content/50">Dotfiles</span>
        </label>
        <button
          className="px-1.5 py-0.5 text-[11px] rounded text-content/40 hover:text-content/70 transition-colors"
          onClick={refresh}
        >
          Refresh
        </button>
      </div>

      {/* Content: tree + editor split */}
      <div className="flex flex-1 min-h-0">
        {/* File tree */}
        <div className={`overflow-auto ${selected ? 'w-72 shrink-0' : 'flex-1'}`}>
          {loading ? (
            <div className="flex items-center justify-center h-full">
              <span className="spinner w-5 h-5 text-content/30" />
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center h-full text-content/30 text-sm gap-2 px-4">
              <FolderIcon className="size-8 opacity-30" />
              <p className="text-center text-xs">{error}</p>
              <button
                className="text-xs text-interactive hover:underline"
                onClick={refresh}
              >
                Retry
              </button>
            </div>
          ) : visibleNodes.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-content/30 text-sm gap-2">
              <FolderIcon className="size-8 opacity-30" />
              <p>Empty directory</p>
            </div>
          ) : (
            <div className="py-0.5">
              {visibleNodes.map((node) => (
                <TreeRow
                  key={node.path}
                  node={node}
                  depth={0}
                  expanded={expanded}
                  onToggle={toggleExpand}
                  selectedPath={selected?.path ?? null}
                  onSelect={setSelected}
                  showDotfiles={showDotfiles}
                />
              ))}
            </div>
          )}
        </div>

        {/* Editor panel */}
        {selected && !selected.isDir && (
          <div className="flex-1 min-w-0">
            <EditorPanel
              key={selected.path}
              node={selected}
              onClose={() => setSelected(null)}
            />
          </div>
        )}
      </div>
    </div>
  );
}
