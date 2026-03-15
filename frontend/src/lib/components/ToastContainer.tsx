// Toast notification overlay
import { useToasts, dismissToast, type ToastLevel } from '../stores/toast';
import { CloseIcon } from '../icons/Icons';

const levelClass: Record<ToastLevel, string> = {
  info: 'bg-blue-100 text-blue-800 border-blue-300',
  success: 'bg-green-100 text-green-800 border-green-300',
  warning: 'bg-yellow-100 text-yellow-900 border-yellow-300',
  error: 'bg-red-100 text-red-800 border-red-300',
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
            className="flex items-center justify-center rounded-full p-1 hover:bg-black/10 focus:outline-none focus:ring-2 focus:ring-primary-400"
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
