// WizardView -- onboarding wizard with API key setup
import { useState, useCallback } from 'react';
import { useSidebar } from '../stores/sidebar';
import { updateSetting } from '../api';
import { showToast } from '../stores/toast';
import { ChevronRight } from '../icons/Icons';

interface ProviderEntry {
  id: string;
  name: string;
  settingKey: string;
  envVar: string;
  placeholder: string;
}

const PROVIDERS: ProviderEntry[] = [
  { id: 'anthropic', name: 'Anthropic', settingKey: 'ai.anthropic.api_key', envVar: 'ANTHROPIC_API_KEY', placeholder: 'sk-ant-...' },
  { id: 'openai', name: 'OpenAI', settingKey: 'ai.openai.api_key', envVar: 'OPENAI_API_KEY', placeholder: 'sk-...' },
  { id: 'google', name: 'Google AI', settingKey: 'ai.google.api_key', envVar: 'GEMINI_API_KEY', placeholder: 'AIza...' },
];

export default function WizardView() {
  const { setView } = useSidebar();
  const [step, setStep] = useState(0); // 0 = welcome, 1 = keys, 2 = done
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const setKey = useCallback((id: string, value: string) => {
    setKeys((prev) => ({ ...prev, [id]: value }));
  }, []);

  const hasAnyKey = Object.values(keys).some((v) => v.trim().length > 0);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      for (const provider of PROVIDERS) {
        const value = keys[provider.id]?.trim();
        if (value) {
          await updateSetting(provider.settingKey, value);
        }
      }
      showToast('API keys saved successfully', 'success');
      setStep(2);
    } catch (e) {
      showToast('Failed to save keys: ' + String(e), 'error');
    } finally {
      setSaving(false);
    }
  }, [keys]);

  const handleFinish = useCallback(() => {
    setView('home');
  }, [setView]);

  const handleSkip = useCallback(() => {
    setView('home');
  }, [setView]);

  // Step 0: Welcome
  if (step === 0) {
    return (
      <div className="flex items-center justify-center h-full w-full bg-surface">
        <div className="text-center max-w-lg space-y-6 px-4">
          <div className="w-16 h-16 rounded-2xl bg-interactive/10 flex items-center justify-center mx-auto">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="size-8 text-interactive">
              <path d="M12 22v-6M12 8V2M4 12H2M10 12H8M16 12h-2M22 12h-2" />
              <circle cx="12" cy="12" r="2" />
            </svg>
          </div>
          <h1 className="text-3xl font-bold text-content">Welcome to AI.VM</h1>
          <p className="text-content/60 leading-relaxed">
            Sandboxed Linux virtual environments for AI agents.
            Let's get you set up with API credentials so your agents can connect to AI providers.
          </p>
          <div className="flex items-center justify-center gap-3 pt-2">
            <button
              className="px-6 py-2.5 rounded-lg bg-interactive text-white hover:opacity-90 transition font-medium inline-flex items-center gap-2"
              onClick={() => setStep(1)}
            >
              Get Started
              <ChevronRight className="size-4" />
            </button>
            <button
              className="px-4 py-2.5 rounded-lg text-content/50 hover:text-content hover:bg-surface-alt transition text-sm"
              onClick={handleSkip}
            >
              Skip for now
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Step 1: API key setup
  if (step === 1) {
    return (
      <div className="flex items-center justify-center h-full w-full bg-surface">
        <div className="max-w-lg w-full space-y-6 px-4">
          <div className="text-center">
            <h2 className="text-xl font-bold text-content">Configure AI Providers</h2>
            <p className="text-sm text-content/60 mt-1">
              Add at least one API key. You can always change these later in Settings.
            </p>
          </div>

          <div className="space-y-3">
            {PROVIDERS.map((provider) => (
              <div key={provider.id} className="bg-surface border border-edge rounded-lg p-4">
                <div className="flex items-center justify-between mb-2">
                  <label className="text-sm font-medium text-content">{provider.name}</label>
                  <span className="text-[10px] font-mono text-content/30">{provider.envVar}</span>
                </div>
                <input
                  type="password"
                  className="w-full font-mono text-xs px-3 py-2 border border-edge rounded-md bg-surface focus:outline-none focus:ring-2 focus:ring-interactive/40 transition"
                  placeholder={provider.placeholder}
                  value={keys[provider.id] ?? ''}
                  onChange={(e) => setKey(provider.id, e.target.value)}
                />
              </div>
            ))}
          </div>

          <div className="flex items-center justify-between pt-2">
            <button
              className="px-4 py-2 rounded-lg text-content/50 hover:text-content hover:bg-surface-alt transition text-sm"
              onClick={() => setStep(0)}
            >
              Back
            </button>
            <div className="flex items-center gap-2">
              <button
                className="px-4 py-2 rounded-lg text-content/50 hover:text-content hover:bg-surface-alt transition text-sm"
                onClick={handleSkip}
              >
                Skip
              </button>
              <button
                className="inline-flex items-center gap-2 px-5 py-2 rounded-lg bg-interactive text-white hover:opacity-90 transition font-medium disabled:opacity-40"
                onClick={handleSave}
                disabled={!hasAnyKey || saving}
              >
                {saving && <span className="spinner w-3.5 h-3.5" />}
                {saving ? 'Saving...' : 'Save & Continue'}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Step 2: Done
  return (
    <div className="flex items-center justify-center h-full w-full bg-surface">
      <div className="text-center max-w-md space-y-6 px-4">
        <div className="w-16 h-16 rounded-2xl bg-allowed/10 flex items-center justify-center mx-auto">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="size-8 text-allowed">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </div>
        <h2 className="text-2xl font-bold text-content">You're all set!</h2>
        <p className="text-content/60">
          Your API keys have been saved. Create your first environment to start running AI agents in a sandboxed VM.
        </p>
        <button
          className="px-8 py-2.5 rounded-lg bg-interactive text-white hover:opacity-90 transition font-medium"
          onClick={handleFinish}
        >
          Create Environment
        </button>
      </div>
    </div>
  );
}
