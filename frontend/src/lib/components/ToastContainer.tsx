// Toast notification overlay
import { useToasts, dismissToast, type ToastLevel } from '../stores/toast';
import { CloseIcon } from '../icons/Icons';

const levelClass: Record<ToastLevel, string> = {
  info: 'bg-allowed/10 text-allowed border-allowed/30',
  success: 'bg-allowed/10 text-allowed border-allowed/30',
  warning: 'bg-caution/10 text-caution border-caution/30',
  error: 'bg-denied/10 text-denied border-denied/30',
};

export default function ToastContainer() {
  const toasts = useToasts();
  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-0 right-0 z-50 pr-4 pb-10 flex flex-col items-end gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`border shadow-lg py-2 px-3 flex items-center gap-2 max-w-xs rounded-lg ${levelClass[t.level]}`}
        >
          <span className="text-sm flex-1">{t.message}</span>
          <button
            className="flex items-center justify-center rounded-full p-1 hover:bg-black/10 focus:outline-none focus:ring-1 focus:ring-interactive/50"
            onClick={() => dismissToast(t.id)}
            aria-label="Dismiss"
          >
            <CloseIcon className="size-3" />
          </button>
        </div>
      ))}
    </div>
  );
}
