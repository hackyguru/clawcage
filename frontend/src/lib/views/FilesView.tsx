// FilesView -- tree-based file browser showing files touched during the session
import { useState, useEffect, useCallback, useMemo } from 'react';
import { queryDb, queryAll } from '../db';
import { FILE_TREE_SQL, FILE_TREE_SEARCH_SQL } from '../sql';
import { showToast } from '../stores/toast';
import { FolderIcon, FileIcon, ChevronRight, ChevronDown } from '../icons/Icons';
import { colors } from '../css-var';

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
}

const ACTION_COLORS: Record<string, string> = {
  created: colors.fileCreated,
  modified: colors.fileModified,
  deleted: colors.fileDeleted,
};

const ACTION_LABELS: Record<string, string> = {
  created: 'new',
  modified: 'mod',
  deleted: 'del',
};

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

  // Sort: folders first, then alphabetical
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
  if (bytes == null) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function TreeRow({
  node,
  depth,
  expanded,
  onToggle,
  selected,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  selected: string | null;
  onSelect: (node: TreeNode) => void;
}) {
  const isOpen = expanded.has(node.path);
  const action = node.entry?.action;
  const isSelected = selected === node.path;

  return (
    <>
      <button
        className={`flex items-center w-full px-2 py-1 text-left hover:bg-surface-alt/50 transition-colors ${
          isSelected ? 'bg-interactive/10' : ''
        }`}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={() => {
          if (node.isDir) onToggle(node.path);
          onSelect(node);
        }}
        aria-label={node.isDir ? `Folder ${node.name}` : `File ${node.name}`}
      >
        {/* Expand/collapse chevron for dirs */}
        <span className="w-4 shrink-0 flex items-center justify-center">
          {node.isDir ? (
            isOpen ? <ChevronDown className="size-3 text-content/40" /> : <ChevronRight className="size-3 text-content/40" />
          ) : null}
        </span>

        {/* Icon */}
        <span className="mr-1.5 shrink-0">
          {node.isDir ? (
            <FolderIcon className="size-3.5 text-interactive/70" />
          ) : (
            <FileIcon className="size-3.5 text-content/40" />
          )}
        </span>

        {/* Name */}
        <span className={`text-xs truncate flex-1 ${
          action === 'deleted' ? 'line-through text-content/30' : 'text-content/80'
        }`}>
          {node.name}
        </span>

        {/* Action badge */}
        {action && (
          <span
            className="ml-2 px-1.5 py-0.5 text-[9px] rounded-full text-white font-medium shrink-0"
            style={{ backgroundColor: ACTION_COLORS[action] }}
          >
            {ACTION_LABELS[action] ?? action}
          </span>
        )}

        {/* Size */}
        {node.entry && (
          <span className="ml-2 text-[10px] text-content/30 font-mono shrink-0 w-16 text-right">
            {formatSize(node.entry.size)}
          </span>
        )}
      </button>

      {/* Recursive children */}
      {node.isDir && isOpen && node.children.map((child) => (
        <TreeRow
          key={child.path}
          node={child}
          depth={depth + 1}
          expanded={expanded}
          onToggle={onToggle}
          selected={selected}
          onSelect={onSelect}
        />
      ))}
    </>
  );
}

function DetailSidebar({ node, onClose }: { node: TreeNode; onClose: () => void }) {
  const entry = node.entry;
  return (
    <div className="w-64 border-l border-edge bg-surface-alt/30 overflow-auto shrink-0">
      <div className="flex items-center justify-between px-3 py-2 border-b border-edge">
        <h3 className="text-xs font-semibold truncate">{node.name}</h3>
        <button
          className="text-content/40 hover:text-content transition-colors"
          onClick={onClose}
          aria-label="Close detail panel"
        >
          <span className="text-xs">×</span>
        </button>
      </div>
      <div className="p-3 space-y-3 text-xs">
        <div>
          <span className="text-content/40 block mb-0.5">Path</span>
          <span className="font-mono text-content/70 break-all">{node.path}</span>
        </div>
        {node.isDir ? (
          <div>
            <span className="text-content/40 block mb-0.5">Type</span>
            <span className="text-content/70">Directory</span>
          </div>
        ) : entry ? (
          <>
            <div>
              <span className="text-content/40 block mb-0.5">Status</span>
              <span
                className="inline-flex items-center px-1.5 py-0.5 text-[10px] text-white rounded-full"
                style={{ backgroundColor: ACTION_COLORS[entry.action] }}
              >
                {entry.action}
              </span>
            </div>
            <div>
              <span className="text-content/40 block mb-0.5">Size</span>
              <span className="text-content/70 font-mono">{formatSize(entry.size)}</span>
            </div>
            <div>
              <span className="text-content/40 block mb-0.5">Last modified</span>
              <span className="text-content/70 font-mono">
                {entry.timestamp?.replace('T', ' ').slice(0, 19) ?? '-'}
              </span>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

export default function FilesView() {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<TreeNode | null>(null);

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

  const tree = useMemo(() => buildTree(entries), [entries]);

  // Auto-expand root-level folders on first load
  useEffect(() => {
    if (tree.length > 0 && expanded.size === 0) {
      const roots = new Set(tree.filter((n) => n.isDir).map((n) => n.path));
      setExpanded(roots);
    }
  }, [tree]);

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
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-edge shrink-0">
        <div>
          <h2 className="text-sm font-semibold">Files</h2>
          <p className="text-xs text-content/50 mt-0.5">
            Files created and modified during this session
          </p>
        </div>
        <div className="flex items-center gap-3">
          {entries.length > 0 && (
            <span className="text-xs text-content/40">
              {fileCount} file{fileCount !== 1 ? 's' : ''}
              {deletedCount > 0 && `, ${deletedCount} deleted`}
            </span>
          )}
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-edge shrink-0">
        <input
          type="text"
          placeholder="Search files..."
          className="px-2 py-1 text-xs border border-edge rounded bg-surface focus:outline-none focus:ring-1 focus:ring-interactive/40 w-48"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search files"
        />
        {search && (
          <span className="text-xs text-content/40">
            {entries.length} result{entries.length !== 1 ? 's' : ''}
          </span>
        )}
        <span className="flex-1" />
        <button
          className="text-[11px] text-content/40 hover:text-content/70 transition-colors"
          onClick={expandAll}
          aria-label="Expand all folders"
        >
          Expand all
        </button>
        <button
          className="text-[11px] text-content/40 hover:text-content/70 transition-colors"
          onClick={collapseAll}
          aria-label="Collapse all folders"
        >
          Collapse all
        </button>
      </div>

      {/* Content */}
      <div className="flex flex-1 min-h-0">
        <div className="flex-1 overflow-auto">
          {loading ? (
            <div className="flex items-center justify-center h-full">
              <span className="spinner w-4 h-4 text-content/30" />
            </div>
          ) : entries.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-content/30 text-sm gap-2">
              <FolderIcon className="size-8 opacity-40" />
              <p>No file activity yet</p>
              <p className="text-xs text-content/20">
                Files created or modified in the VM will appear here
              </p>
            </div>
          ) : (
            <div className="py-1">
              {tree.map((node) => (
                <TreeRow
                  key={node.path}
                  node={node}
                  depth={0}
                  expanded={expanded}
                  onToggle={toggleExpand}
                  selected={selected?.path ?? null}
                  onSelect={setSelected}
                />
              ))}
            </div>
          )}
        </div>

        {/* Detail sidebar */}
        {selected && (
          <DetailSidebar node={selected} onClose={() => setSelected(null)} />
        )}
      </div>
    </div>
  );
}
