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
    <div className="flex items-center justify-center h-full w-full bg-base-100">
      <div className="text-center max-w-md space-y-6 px-4">
        <h1 className="text-3xl font-bold text-base-content">Welcome to AI.VM</h1>
        <p className="text-base-content/70">
          To get started, configure at least one AI provider API key in Settings.
        </p>
        <button
          className="btn btn-primary btn-wide"
          onClick={goToSettings}
        >
          Open Settings
        </button>
      </div>
    </div>
  );
}
