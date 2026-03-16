// TerminalView - toolbar + terminal + stats bar
import { useState, useCallback } from 'react';
import Terminal from '../components/Terminal';
import StatsBar from '../components/StatsBar';
import { useVenvs, stopVenvAction, deleteVenvAction } from '../stores/venvs';
import { useSidebar } from '../stores/sidebar';
import { StopIcon, TrashIcon, HomeIcon } from '../icons/Icons';

function TerminalToolbar() {
  const { activeVenv } = useVenvs();
  const { setView } = useSidebar();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const handleStop = useCallback(() => {
    if (activeVenv) {
      stopVenvAction(activeVenv.id);
      setView('home');
    }
  }, [activeVenv, setView]);

  const handleDelete = useCallback(() => {
    if (!activeVenv) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      setTimeout(() => setConfirmDelete(false), 3000);
      return;
    }
    deleteVenvAction(activeVenv.id);
    setView('home');
  }, [activeVenv, confirmDelete, setView]);

  if (!activeVenv) return null;

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 bg-neutral-950 border-b border-white/5 select-none">
      <button
        className="text-neutral-500 hover:text-interactive transition-colors"
        onClick={() => setView('home')}
        title="Back to environments"
      >
        <HomeIcon className="size-3.5" />
      </button>
      <span className="text-neutral-600">·</span>
      <span className="text-xs font-medium text-neutral-300 truncate">{activeVenv.name}</span>
      {activeVenv.ephemeral && (
        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-caution/15 text-caution">ephemeral</span>
      )}
      <span className="flex-1" />
      {activeVenv.status === 'running' && (
        <button
          className="flex items-center gap-1 text-[11px] text-neutral-500 hover:text-denied transition-colors"
          onClick={handleStop}
          title="Stop environment"
        >
          <StopIcon className="size-3" />
          Stop
        </button>
      )}
      <button
        className={`flex items-center gap-1 text-[11px] transition-colors ${
          confirmDelete ? 'text-denied' : 'text-neutral-500 hover:text-denied'
        }`}
        onClick={handleDelete}
        title={confirmDelete ? 'Click again to confirm' : 'Delete environment'}
      >
        <TrashIcon className="size-3" />
        {confirmDelete ? 'Confirm?' : 'Delete'}
      </button>
    </div>
  );
}

export default function TerminalView() {
  return (
    <div className="flex flex-col h-full w-full">
      <TerminalToolbar />
      <div className="flex-1 min-h-0">
        <Terminal />
      </div>
      <StatsBar />
    </div>
  );
}
