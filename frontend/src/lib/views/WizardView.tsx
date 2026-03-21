// WizardView -- onboarding wizard with app overview (API keys are per-venv in create dialog)
import { useCallback, useState } from 'react';
import { useSidebar } from '../stores/sidebar';
import { ChevronRight } from '../icons/Icons';

export default function WizardView({ onComplete }: { onComplete: () => void }) {
  const { setView } = useSidebar();
  const [step, setStep] = useState(0); // 0 = welcome, 1 = overview

  const handleFinish = useCallback(() => {
    onComplete();
    setView('home');
  }, [setView, onComplete]);

  const handleSkip = useCallback(() => {
    onComplete();
    setView('home');
  }, [setView, onComplete]);

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
            Let's walk you through how it works before you create your first environment.
          </p>
          <div className="flex items-center justify-center gap-3 pt-2">
            <button
              className="px-6 py-2.5 rounded-lg bg-interactive text-on-interactive hover:opacity-90 transition font-medium inline-flex items-center gap-2"
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

  // Step 1: Overview -- explain what Aivm does, then direct to create environment
  const features = [
    {
      icon: (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="size-5 text-interactive">
          <rect x="2" y="3" width="20" height="14" rx="2" /><line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" />
        </svg>
      ),
      title: 'Sandboxed Linux VMs',
      desc: 'Each environment runs in an isolated virtual machine. AI agents get a full Linux userspace but cannot access your host files or network.',
    },
    {
      icon: (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="size-5 text-interactive">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        </svg>
      ),
      title: 'Network Policy',
      desc: 'All outbound traffic is inspected. Only allowed domains (AI providers, package registries) can be reached. Everything else is blocked.',
    },
    {
      icon: (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="size-5 text-interactive">
          <rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
      ),
      title: 'Credential Isolation',
      desc: 'API keys stay on the host and are configured per environment. The proxy injects credentials into upstream requests so a compromised VM can never exfiltrate your keys.',
    },
  ];

  return (
    <div className="flex items-center justify-center h-full w-full bg-surface">
      <div className="max-w-lg w-full space-y-6 px-4">
        <div className="text-center">
          <h2 className="text-xl font-bold text-content">How AI.VM Works</h2>
          <p className="text-sm text-content/60 mt-1">
            A secure runtime for AI agents in three layers.
          </p>
        </div>

        <div className="space-y-3">
          {features.map((f) => (
            <div key={f.title} className="flex gap-3 bg-surface border border-edge rounded-lg p-4">
              <div className="shrink-0 w-9 h-9 rounded-lg bg-interactive/10 flex items-center justify-center">
                {f.icon}
              </div>
              <div>
                <h3 className="text-sm font-semibold text-content">{f.title}</h3>
                <p className="text-xs text-content/50 mt-0.5 leading-relaxed">{f.desc}</p>
              </div>
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
          <button
            className="inline-flex items-center gap-2 px-5 py-2 rounded-lg bg-interactive text-on-interactive hover:opacity-90 transition font-medium"
            onClick={handleFinish}
          >
            Create Your First Environment
            <ChevronRight className="size-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
