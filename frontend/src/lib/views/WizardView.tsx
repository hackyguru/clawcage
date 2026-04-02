// WizardView -- onboarding wizard with app overview and page-by-page guide
import { useCallback, useState } from 'react';
import { useSidebar } from '../stores/sidebar';
import { ChevronRight } from '../icons/Icons';

const STEPS = [
  {
    title: 'Welcome to Clawcage',
    subtitle: 'Sandboxed Linux environments for AI agents.',
    content: (
      <p className="text-content/60 leading-relaxed text-center max-w-md mx-auto">
        Every AI agent runs in an isolated virtual machine with full network inspection
        and credential isolation. Let's walk through how it works.
      </p>
    ),
  },
  {
    title: 'Environments',
    subtitle: 'Create and manage sandboxed VMs.',
    content: (
      <div className="space-y-3 max-w-md mx-auto">
        <Feature
          icon={<BoxIcon />}
          title="Home Page"
          desc="Create, start, and stop environments. Each one is an isolated Linux VM with its own filesystem, network policy, and API keys."
        />
        <Feature
          icon={<TemplateIcon />}
          title="Templates"
          desc="Pick a template (Blank, OpenClaw, Hermes) to pre-configure your environment with one click. The setup runs automatically on first boot."
        />
        <Feature
          icon={<ParallelIcon />}
          title="Parallel VMs"
          desc="Run multiple environments at the same time. Each has independent resources and settings. Switch between them from the sidebar."
        />
      </div>
    ),
  },
  {
    title: 'Terminal & Shells',
    subtitle: 'Work inside the VM.',
    content: (
      <div className="space-y-3 max-w-md mx-auto">
        <Feature
          icon={<TerminalIcon />}
          title="Console"
          desc="Full terminal access to the VM. Run AI agents (Claude, Gemini, Codex), install packages, start servers. Everything happens inside the sandbox."
        />
        <Feature
          icon={<TabsIcon />}
          title="Multi-Shell"
          desc="Open multiple shell tabs within the same VM. Each gets its own PTY. Close all tabs and create new ones without restarting."
        />
      </div>
    ),
  },
  {
    title: 'Network & Security',
    subtitle: 'Control what agents can access.',
    content: (
      <div className="space-y-3 max-w-md mx-auto">
        <Feature
          icon={<ShieldIcon />}
          title="Domain Policy"
          desc="Only allowed domains are reachable. Block or allow specific sites. Toggle 'Allow all domains' for unrestricted access."
        />
        <Feature
          icon={<LockIcon />}
          title="Credential Isolation"
          desc="API keys never enter the VM. The host proxy injects them into outgoing requests. A compromised VM cannot steal your keys."
        />
        <Feature
          icon={<EyeIcon />}
          title="MITM Proxy"
          desc="Optionally inspect all HTTPS traffic. See every request, response, and header in the Stats page. Disable for transparent passthrough."
        />
      </div>
    ),
  },
  {
    title: 'Tools & Monitoring',
    subtitle: 'See what your agents are doing.',
    content: (
      <div className="space-y-3 max-w-md mx-auto">
        <Feature
          icon={<PortIcon />}
          title="Ports"
          desc="Detect listening ports in the VM. Forward them to your host or preview directly in the in-app browser."
        />
        <Feature
          icon={<FolderIcon />}
          title="Files"
          desc="Browse the VM filesystem, view and edit files with syntax highlighting."
        />
        <Feature
          icon={<ChartIcon />}
          title="Stats"
          desc="Real-time charts for network events, file activity, AI token usage, tool calls, and system resources (CPU, memory, disk)."
        />
        <Feature
          icon={<GlobeIcon />}
          title="Browser"
          desc="Preview web apps running inside the VM without forwarding ports. Traffic stays internal through the vsock bridge."
        />
      </div>
    ),
  },
];

export default function WizardView({ onComplete }: { onComplete: () => void }) {
  const { setView } = useSidebar();
  const [step, setStep] = useState(0);

  const handleFinish = useCallback(() => {
    onComplete();
    setView('home');
  }, [setView, onComplete]);

  const current = STEPS[step];
  const isLast = step === STEPS.length - 1;

  return (
    <div className="flex items-center justify-center h-full w-full bg-surface">
      <div className="max-w-xl w-full px-6">
        {/* Progress dots */}
        <div className="flex items-center justify-center gap-1.5 mb-8">
          {STEPS.map((_, i) => (
            <button
              key={i}
              className={`rounded-full transition-all ${
                i === step ? 'w-6 h-1.5 bg-interactive' : 'w-1.5 h-1.5 bg-content/15'
              }`}
              onClick={() => { if (i <= step) setStep(i); }}
            />
          ))}
        </div>

        {/* Header */}
        <div className="text-center mb-6">
          {step === 0 && (
            <div className="flex items-center justify-center mx-auto mb-4">
              <img src="/applogo.png" alt="Clawcage" className="size-14 rounded-xl" />
            </div>
          )}
          <h1 className="text-xl font-bold text-content">{current.title}</h1>
          <p className="text-sm text-content/50 mt-1">{current.subtitle}</p>
        </div>

        {/* Content */}
        <div className="mb-8">
          {current.content}
        </div>

        {/* Navigation */}
        <div className="flex items-center justify-between">
          <div>
            {step > 0 ? (
              <button
                className="px-4 py-2 rounded-lg text-content/50 hover:text-content hover:bg-surface-alt transition text-sm"
                onClick={() => setStep(step - 1)}
              >
                Back
              </button>
            ) : (
              <button
                className="px-4 py-2 rounded-lg text-content/30 hover:text-content/50 transition text-sm"
                onClick={handleFinish}
              >
                Skip
              </button>
            )}
          </div>
          <button
            className="inline-flex items-center gap-2 px-5 py-2 rounded-lg bg-interactive text-on-interactive hover:opacity-90 transition font-medium"
            onClick={isLast ? handleFinish : () => setStep(step + 1)}
          >
            {isLast ? 'Create Your First Environment' : 'Next'}
            <ChevronRight className="size-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Helper components ─────────────────────────────────────────────

function Feature({ icon, title, desc }: { icon: React.ReactNode; title: string; desc: string }) {
  return (
    <div className="flex gap-3 bg-surface border border-edge rounded-lg p-3.5">
      <div className="shrink-0 w-8 h-8 rounded-lg bg-interactive/10 flex items-center justify-center">
        {icon}
      </div>
      <div className="min-w-0">
        <h3 className="text-sm font-semibold text-content">{title}</h3>
        <p className="text-xs text-content/50 mt-0.5 leading-relaxed">{desc}</p>
      </div>
    </div>
  );
}

// ── Inline icons ──────────────────────────────────────────────────

const cls = 'size-4 text-interactive';

function BoxIcon() {
  return <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={cls}><path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>;
}
function TemplateIcon() {
  return <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={cls}><rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/></svg>;
}
function ParallelIcon() {
  return <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={cls}><rect x="2" y="4" width="8" height="16" rx="1"/><rect x="14" y="4" width="8" height="16" rx="1"/></svg>;
}
function TerminalIcon() {
  return <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={cls}><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>;
}
function TabsIcon() {
  return <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={cls}><path d="M4 6h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z"/><path d="M2 10h20"/><path d="M8 6v4"/><path d="M14 6v4"/></svg>;
}
function ShieldIcon() {
  return <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={cls}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>;
}
function LockIcon() {
  return <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={cls}><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>;
}
function EyeIcon() {
  return <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={cls}><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>;
}
function PortIcon() {
  return <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={cls}><circle cx="12" cy="12" r="2"/><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>;
}
function FolderIcon() {
  return <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={cls}><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/></svg>;
}
function ChartIcon() {
  return <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={cls}><path d="M3 3v18h18"/><path d="M7 16l4-8 4 4 4-8"/></svg>;
}
function GlobeIcon() {
  return <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={cls}><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>;
}
