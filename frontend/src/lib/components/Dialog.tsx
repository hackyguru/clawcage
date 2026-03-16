// Dialog -- reusable modal overlay
import { useEffect, useRef, useCallback, type ReactNode } from 'react';
import { CloseIcon } from '../icons/Icons';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  /** Max width class, default 'max-w-md' */
  width?: string;
}

export default function Dialog({ open, onClose, title, children, width = 'max-w-md' }: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, onClose]);

  // Close on backdrop click
  const handleBackdrop = useCallback((e: React.MouseEvent) => {
    if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
      onClose();
    }
  }, [onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={handleBackdrop}
    >
      <div
        ref={panelRef}
        className={`${width} w-full mx-4 bg-surface border border-edge rounded-xl shadow-2xl animate-in`}
      >
        {title && (
          <div className="flex items-center justify-between px-5 pt-4 pb-0">
            <h2 className="text-sm font-semibold">{title}</h2>
            <button
              className="p-1 rounded hover:bg-surface-alt text-content/40 hover:text-content transition-colors"
              onClick={onClose}
            >
              <CloseIcon className="size-3.5" />
            </button>
          </div>
        )}
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

/** Pre-built confirmation dialog for destructive actions */
interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmLabel?: string;
  /** 'danger' uses red, 'caution' uses yellow */
  variant?: 'danger' | 'caution';
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel = 'Confirm',
  variant = 'danger',
}: ConfirmDialogProps) {
  const colorClass = variant === 'danger' ? 'bg-denied text-white' : 'bg-caution text-black';

  return (
    <Dialog open={open} onClose={onClose} title={title} width="max-w-sm">
      <p className="text-sm text-content/70 mb-5">{message}</p>
      <div className="flex items-center justify-end gap-2">
        <button
          className="px-3 py-1.5 text-sm rounded-lg hover:bg-surface-alt transition-colors"
          onClick={onClose}
        >
          Cancel
        </button>
        <button
          className={`px-3 py-1.5 text-sm rounded-lg font-medium hover:opacity-90 transition ${colorClass}`}
          onClick={() => { onConfirm(); onClose(); }}
        >
          {confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}
