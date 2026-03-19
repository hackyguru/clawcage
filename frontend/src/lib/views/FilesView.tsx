// FilesView -- tree-based file browser with CodeMirror editor
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { queryDb, queryAll } from '../db';
import { FILE_TREE_SQL, FILE_TREE_SEARCH_SQL } from '../sql';
import { readFile, saveFile } from '../api';
import { showToast } from '../stores/toast';
import { useTheme } from '../stores/theme';
import { FolderIcon, FileIcon, ChevronRight, ChevronDown, GitBranchIcon } from '../icons/Icons';

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

interface FileEntry {
  path: string;
  action: string;
  size: number | null;
  timestamp: string;
}

/** A node in the file tree (either a folder or a file). */
interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: TreeNode[];
  /** Only present for file nodes */
  entry?: FileEntry;
  /** True if this directory contains a .git subfolder */
  hasGit?: boolean;
}

/** Badge classes per action using design system tokens. */
const ACTION_BADGE: Record<string, string> = {
  created: 'bg-file-created/15 text-file-created',
  modified: 'bg-file-modified/15 text-file-modified',
  deleted: 'bg-file-deleted/15 text-file-deleted',
};

const ACTION_LABELS: Record<string, string> = {
  created: 'new',
  modified: 'mod',
  deleted: 'del',
};

/** Detect language extension from file name. */
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
    case 'toml': return yaml(); // close enough for highlighting
    case 'sh': case 'bash': case 'zsh': return undefined; // no shell lang yet
    default: return undefined;
  }
}

// ── CodeMirror themes ──────────────────────────────────────────

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

/** Build a tree structure from flat file paths. */
function buildTree(entries: FileEntry[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', isDir: true, children: [] };

  for (const entry of entries) {
    const parts = entry.path.replace(/^\//, '').split('/');
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      const fullPath = '/' + parts.slice(0, i + 1).join('/');

      let child = current.children.find((c) => c.name === part);
      if (!child) {
        child = {
          name: part,
          path: fullPath,
          isDir: !isLast,
          children: [],
          entry: isLast ? entry : undefined,
        };
        current.children.push(child);
      }
      if (isLast && !child.entry) {
        child.entry = entry;
        child.isDir = false;
      }
      current = child;
    }
  }

  // Mark directories that contain a .git entry, then remove the .git node.
  function markGitRepos(nodes: TreeNode[]) {
    for (const n of nodes) {
      if (n.isDir) {
        const gitIdx = n.children.findIndex((c) => c.name === '.git');
        if (gitIdx !== -1) {
          n.hasGit = true;
          n.children.splice(gitIdx, 1);
        }
        markGitRepos(n.children);
      }
    }
  }
  markGitRepos(root.children);

  // Also check root-level .git (repo at /root itself).
  const rootGitIdx = root.children.findIndex((c) => c.name === '.git');
  if (rootGitIdx !== -1) {
    root.hasGit = true;
    root.children.splice(rootGitIdx, 1);
  }

  function sortNodes(nodes: TreeNode[]) {
    nodes.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const n of nodes) {
      if (n.children.length > 0) sortNodes(n.children);
    }
  }
  sortNodes(root.children);
  return root.children;
}

function formatSize(bytes: number | null): string {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function TreeRow({
  node,
  depth,
  expanded,
  onToggle,
  selectedPath,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  selectedPath: string | null;
  onSelect: (node: TreeNode) => void;
}) {
  const isOpen = expanded.has(node.path);
  const action = node.entry?.action;
  const isSelected = selectedPath === node.path;
  const canOpen = !node.isDir && action !== 'deleted';

  return (
    <>
      <div
        className={`group flex items-center w-full h-7 text-left transition-colors cursor-default select-none ${
          isSelected
            ? 'bg-interactive/10'
            : canOpen || node.isDir
              ? 'hover:bg-base-200/60'
              : ''
        }`}
        style={{ paddingLeft: `${depth * 16 + 8}px`, paddingRight: 8 }}
        onClick={() => {
          if (node.isDir) onToggle(node.path);
          else if (canOpen) onSelect(node);
        }}
      >
        {/* Chevron */}
        <span className="w-4 shrink-0 flex items-center justify-center">
          {node.isDir ? (
            isOpen
              ? <ChevronDown className="size-3 text-base-content/30" />
              : <ChevronRight className="size-3 text-base-content/30" />
          ) : null}
        </span>

        {/* Icon */}
        <span className="shrink-0 mr-1.5">
          {node.isDir ? (
            <FolderIcon className="size-4 text-interactive/60" />
          ) : (
            <FileIcon className="size-3.5 text-base-content/30" />
          )}
        </span>

        {/* Name */}
        <span className={`text-xs truncate flex-1 ${
          action === 'deleted'
            ? 'line-through text-base-content/25'
            : node.isDir
              ? 'font-medium text-base-content/70'
              : 'text-base-content/60'
        }`}>
          {node.name}
        </span>

        {/* Git indicator */}
        {node.hasGit && (
          <GitBranchIcon className="size-3 text-base-content/30 shrink-0 mr-1" />
        )}

        {/* Badge + size */}
        {action && (
          <span className={`badge badge-xs ${ACTION_BADGE[action] ?? 'badge-outline text-base-content/40'} shrink-0`}>
            {ACTION_LABELS[action] ?? action}
          </span>
        )}
        {node.entry && node.entry.size != null && node.entry.size > 0 && (
          <span className="text-[10px] text-base-content/25 font-mono ml-2 tabular-nums shrink-0">
            {formatSize(node.entry.size)}
          </span>
        )}
      </div>

      {node.isDir && isOpen && node.children.map((child) => (
        <TreeRow
          key={child.path}
          node={child}
          depth={depth + 1}
          expanded={expanded}
          onToggle={onToggle}
          selectedPath={selectedPath}
          onSelect={onSelect}
        />
      ))}
    </>
  );
}

/** Editor panel -- CodeMirror 6 with syntax highlighting. */
function EditorPanel({
  node,
  onClose,
}: {
  node: TreeNode;
  onClose: () => void;
}) {
  const guestPath = node.entry!.path;

  const [content, setContent] = useState<string | null>(null);
  const [original, setOriginal] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const themeCompartment = useRef(new Compartment());
  const contentRef = useRef<string | null>(null);
  const { theme } = useTheme();

  // Load file content
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

  // Keep contentRef in sync for the save handler
  useEffect(() => {
    contentRef.current = content;
  }, [content]);

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

  // Initialize CodeMirror
  useEffect(() => {
    if (content === null || !editorRef.current) return;
    if (viewRef.current) return; // already initialized

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

    const state = EditorState.create({
      doc: content,
      extensions,
    });

    const view = new EditorView({
      state,
      parent: editorRef.current,
    });

    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [content !== null]); // only run once when content loads

  // Update theme when it changes
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

  // Cmd+S / Ctrl+S to save
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
      {/* Editor header */}
      <div className="flex items-center justify-between px-3 h-9 border-b border-edge shrink-0 bg-base-200/40">
        <div className="flex items-center gap-2 min-w-0">
          <FileIcon className="size-3.5 text-base-content/30 shrink-0" />
          <span className="text-xs font-medium text-base-content/70 truncate">{node.name}</span>
          {isDirty && <span className="size-1.5 rounded-full bg-caution shrink-0" title="Unsaved changes" />}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {isDirty && (
            <button
              className="btn btn-xs bg-interactive text-on-interactive hover:opacity-90 transition-opacity disabled:opacity-50"
              onClick={handleSave}
              disabled={saving}
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
          )}
          <button
            className="btn btn-ghost btn-xs text-base-content/40 hover:text-base-content"
            onClick={onClose}
            aria-label="Close editor"
          >
            &times;
          </button>
        </div>
      </div>

      {/* Editor body */}
      <div className="flex-1 min-h-0 overflow-auto">
        {loadError ? (
          <div className="flex flex-col items-center justify-center h-full text-base-content/30 text-xs gap-2 px-4">
            <p className="text-center">{loadError}</p>
          </div>
        ) : content === null ? (
          <div className="flex items-center justify-center h-full">
            <span className="loading loading-spinner loading-sm text-base-content/20" />
          </div>
        ) : (
          <div ref={editorRef} className="h-full" />
        )}
      </div>

      {/* Status bar */}
      {content !== null && (
        <div className="flex items-center justify-between px-3 h-6 border-t border-edge text-[10px] text-base-content/30 shrink-0 bg-base-200/20">
          <span className="font-mono truncate">{guestPath}</span>
          <span className="font-mono shrink-0 ml-4">{lineCount} lines</span>
        </div>
      )}
    </div>
  );
}

export default function FilesView() {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<TreeNode | null>(null);
  const [showDotfiles, setShowDotfiles] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const res = search
        ? await queryDb(FILE_TREE_SEARCH_SQL, [`%${search}%`])
        : await queryDb(FILE_TREE_SQL);
      setEntries(queryAll<FileEntry>(res));
    } catch (e) {
      console.error('FilesView load failed:', e);
      showToast('Failed to load file data', 'error');
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => {
    setLoading(true);
    loadData();
    const iv = setInterval(loadData, 5000);
    return () => clearInterval(iv);
  }, [loadData]);

  const fullTree = useMemo(() => buildTree(entries), [entries]);

  const tree = useMemo(() => {
    if (showDotfiles) return fullTree;
    function filterDot(nodes: TreeNode[]): TreeNode[] {
      return nodes
        .filter((n) => !n.name.startsWith('.'))
        .map((n) => n.isDir ? { ...n, children: filterDot(n.children) } : n);
    }
    return filterDot(fullTree);
  }, [fullTree, showDotfiles]);

  const toggleExpand = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const expandAll = useCallback(() => {
    const allDirs = new Set<string>();
    function walk(nodes: TreeNode[]) {
      for (const n of nodes) {
        if (n.isDir) { allDirs.add(n.path); walk(n.children); }
      }
    }
    walk(tree);
    setExpanded(allDirs);
  }, [tree]);

  const collapseAll = useCallback(() => {
    setExpanded(new Set());
  }, []);

  const fileCount = entries.filter((e) => e.action !== 'deleted').length;
  const deletedCount = entries.filter((e) => e.action === 'deleted').length;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header -- matches PortsView pattern */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-edge shrink-0">
        <div>
          <h2 className="text-sm font-semibold">Files</h2>
          <p className="text-xs text-base-content/40 mt-0.5">
            Files created and modified during this session
          </p>
        </div>
        {entries.length > 0 && (
          <span className="text-xs text-base-content/30 tabular-nums">
            {fileCount} file{fileCount !== 1 ? 's' : ''}
            {deletedCount > 0 && `, ${deletedCount} deleted`}
          </span>
        )}
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 h-9 border-b border-edge shrink-0 bg-base-200/30">
        <input
          type="text"
          placeholder="Search files..."
          className="input input-xs border-edge bg-base-100 w-44 text-xs focus:outline-none focus:ring-1 focus:ring-interactive/40"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search files"
        />
        {search && (
          <span className="text-[11px] text-base-content/30 tabular-nums">
            {entries.length} result{entries.length !== 1 ? 's' : ''}
          </span>
        )}
        <span className="flex-1" />
        <div className="flex items-center gap-1">
          <button
            className={`btn btn-ghost btn-xs text-[11px] ${showDotfiles ? 'text-interactive' : 'text-base-content/40'}`}
            onClick={() => setShowDotfiles((v) => !v)}
            title={showDotfiles ? 'Hide dotfiles' : 'Show dotfiles'}
          >
            .files
          </button>
          <span className="text-base-content/10">|</span>
          <button
            className="btn btn-ghost btn-xs text-[11px] text-base-content/40"
            onClick={expandAll}
          >
            Expand
          </button>
          <span className="text-base-content/10">|</span>
          <button
            className="btn btn-ghost btn-xs text-[11px] text-base-content/40"
            onClick={collapseAll}
          >
            Collapse
          </button>
        </div>
      </div>

      {/* Content: tree + editor split */}
      <div className="flex flex-1 min-h-0">
        {/* File tree */}
        <div className={`overflow-auto ${selected ? 'w-72 shrink-0' : 'flex-1'}`}>
          {loading ? (
            <div className="flex items-center justify-center h-full">
              <span className="loading loading-spinner loading-sm text-base-content/20" />
            </div>
          ) : entries.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-base-content/30 text-sm gap-2">
              <FolderIcon className="size-8 opacity-30" />
              <p>No file activity yet</p>
              <p className="text-xs text-base-content/20">
                Files created or modified in the VM will appear here
              </p>
            </div>
          ) : (
            <div className="py-0.5">
              {tree.map((node) => (
                <TreeRow
                  key={node.path}
                  node={node}
                  depth={0}
                  expanded={expanded}
                  onToggle={toggleExpand}
                  selectedPath={selected?.path ?? null}
                  onSelect={setSelected}
                />
              ))}
            </div>
          )}
        </div>

        {/* Editor panel */}
        {selected && (
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
