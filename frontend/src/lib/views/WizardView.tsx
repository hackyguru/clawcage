// WizardView -- simple onboarding prompt for initial setup
import { useSidebar } from '../stores/sidebar';
import { useSettings } from '../stores/settings';

export default function WizardView() {
  const { setView, setSettingsSection } = useSidebar();
  const { sections } = useSettings();

  function goToSettings() {
    const providerSection = sections.find((s) => s.toLowerCase().includes('provider') || s.toLowerCase().includes('api'));
    if (providerSection) setSettingsSection(providerSection);
    setView('settings');
  }

  return (
  <div className="flex items-center justify-center h-full w-full bg-surface">
      <div className="text-center max-w-md space-y-6 px-4">
  <h1 className="text-3xl font-bold text-neutral-900">Welcome to AI.VM</h1>
  <p className="text-neutral-700">
          To get started, configure at least one AI provider API key in Settings.
        </p>
        <button
          className="px-8 py-2.5 rounded-lg bg-interactive text-white hover:opacity-90 transition font-medium"
          onClick={goToSettings}
        >
          Open Settings
        </button>
      </div>
    </div>
  );
}
