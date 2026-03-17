// TerminalView - toolbar + shell tabs + terminal + stats bar
import { useState, useCallback } from 'react';
import Terminal from '../components/Terminal';
import StatsBar from '../components/StatsBar';
import { useVenvs, stopVenvAction, deleteVenvAction } from '../stores/venvs';
import { useSidebar } from '../stores/sidebar';
import { useShells } from '../stores/shells';
import { ConfirmDialog } from '../components/Dialog';
import { StopIcon, TrashIcon, HomeIcon, PlusIcon, CloseIcon } from '../icons/Icons';

function TerminalToolbar() {
  const { activeVenv } = useVenvs();
  const { setView } = useSidebar();
  const { spawnShell } = useShells();
  const [showStopDialog, setShowStopDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  const handleConfirmStop = useCallback(() => {
    if (activeVenv) {
      stopVenvAction(activeVenv.id);
      setView('home');
    }
  }, [activeVenv, setView]);

  const handleConfirmDelete = useCallback(() => {
    if (activeVenv) {
      deleteVenvAction(activeVenv.id);
      setView('home');
    }
  }, [activeVenv, setView]);

  if (!activeVenv) return null;

  return (
    <>
      <div className="flex items-center gap-2 px-3 py-1.5 bg-base-300 border-b border-edge select-none">
        <button
          className="text-content/40 hover:text-interactive transition-colors"
          onClick={() => setView('home')}
          title="Back to environments"
          aria-label="Back to environments"
        >
          <HomeIcon className="size-3.5" />
        </button>
        <span className="text-content/20">·</span>
        <span className="text-xs font-medium text-content/80 truncate">{activeVenv.name}</span>
        {activeVenv.ephemeral && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-caution/15 text-caution">ephemeral</span>
        )}
        <span className="flex-1" />
        {activeVenv.status === 'running' && (
          <button
            className="flex items-center gap-1 text-[11px] text-content/40 hover:text-interactive transition-colors"
            onClick={() => spawnShell()}
            title="New shell"
            aria-label="New shell"
          >
            <PlusIcon className="size-3" />
            Shell
          </button>
        )}
        {activeVenv.status === 'running' && (
          <button
            className="flex items-center gap-1 text-[11px] text-content/40 hover:text-denied transition-colors"
            onClick={() => setShowStopDialog(true)}
            title="Stop environment"
            aria-label="Stop environment"
          >
            <StopIcon className="size-3" />
            Stop
          </button>
        )}
        <button
          className="flex items-center gap-1 text-[11px] text-content/40 hover:text-denied transition-colors"
          onClick={() => setShowDeleteDialog(true)}
          title="Delete environment"
          aria-label="Delete environment"
        >
          <TrashIcon className="size-3" />
          Delete
        </button>
      </div>

      {/* Stop confirmation */}
      <ConfirmDialog
        open={showStopDialog}
        onClose={() => setShowStopDialog(false)}
        onConfirm={handleConfirmStop}
        title="Stop Environment"
        message={`Stop "${activeVenv.name}"? ${activeVenv.ephemeral ? 'This is an ephemeral environment — all files will be lost.' : 'Persistent files will be saved.'}`}
        confirmLabel="Stop"
        variant="caution"
      />

      {/* Delete confirmation */}
      <ConfirmDialog
        open={showDeleteDialog}
        onClose={() => setShowDeleteDialog(false)}
        onConfirm={handleConfirmDelete}
        title="Delete Environment"
        message={`Are you sure you want to delete "${activeVenv.name}"? ${activeVenv.ephemeral ? 'This environment is ephemeral so no data will be lost.' : 'All persistent data for this environment will be permanently removed.'}`}
        confirmLabel="Delete"
        variant="danger"
      />
    </>
  );
}

function ShellTabLabel({ tab, onRename }: { tab: { sessionId: number; label: string }; onRename: (id: number, label: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(tab.label);

  const commit = useCallback(() => {
    setEditing(false);
    if (draft.trim() && draft.trim() !== tab.label) {
      onRename(tab.sessionId, draft.trim());
    } else {
      setDraft(tab.label);
    }
  }, [draft, tab.label, tab.sessionId, onRename]);

  if (editing) {
    return (
      <input
        className="bg-transparent text-[11px] w-16 outline-none border-b border-interactive"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setDraft(tab.label); setEditing(false); } }}
        autoFocus
        onClick={(e) => e.stopPropagation()}
      />
    );
  }

  return (
    <span
      className="truncate max-w-25"
      onDoubleClick={(e) => { e.stopPropagation(); setDraft(tab.label); setEditing(true); }}
      title="Double-click to rename"
    >
      {tab.label}
    </span>
  );
}

function ShellTabBar() {
  const { tabs, activeSessionId, spawnShell, closeShell, setActiveSession, renameShell } = useShells();

  return (
    <div className="flex items-center gap-0.5 px-2 py-1 bg-base-300 border-b border-edge select-none overflow-x-auto" role="tablist" aria-label="Shell tabs">
      {tabs.map((tab) => (
        <button
          key={tab.sessionId}
          role="tab"
          aria-selected={tab.sessionId === activeSessionId}
          aria-label={tab.label}
          className={`group flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] transition-colors ${
            tab.sessionId === activeSessionId
              ? 'bg-content/10 text-content/80'
              : 'text-content/40 hover:text-content/70 hover:bg-content/5'
          }`}
          onClick={() => setActiveSession(tab.sessionId)}
        >
          <ShellTabLabel tab={tab} onRename={renameShell} />
          {tab.sessionId !== 0 && (
            <span
              className="opacity-0 group-hover:opacity-100 hover:text-denied transition-opacity"
              onClick={(e) => {
                e.stopPropagation();
                closeShell(tab.sessionId);
              }}
              title="Close shell"
            >
              <CloseIcon className="size-2.5" />
            </span>
          )}
        </button>
      ))}
      <button
        className="flex items-center justify-center size-5 rounded text-content/30 hover:text-content/70 hover:bg-content/5 transition-colors ml-0.5"
        onClick={spawnShell}
        title="New shell"
        aria-label="New shell"
      >
        <PlusIcon className="size-3" />
      </button>
    </div>
  );
}

export default function TerminalView() {
  const { tabs, activeSessionId } = useShells();

  return (
    <div className="flex flex-col h-full w-full">
      <TerminalToolbar />
      <ShellTabBar />
      <div className="flex-1 min-h-0 relative">
        {tabs.map((tab) => (
          <div
            key={tab.sessionId}
            className="absolute inset-0"
            style={{ display: tab.sessionId === activeSessionId ? 'block' : 'none' }}
          >
            <Terminal sessionId={tab.sessionId} />
          </div>
        ))}
      </div>
      <StatsBar />
    </div>
  );
}
