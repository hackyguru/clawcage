import Head from "next/head";
import { useState, useEffect } from "react";

// ---------------------------------------------------------------------------
// Icons (currentColor, matching desktop app)
// ---------------------------------------------------------------------------

function ShieldIcon({ className = "size-6" }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

function NetworkIcon({ className = "size-6" }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M9 2v6" /><path d="M15 2v6" /><path d="M12 17v5" />
      <path d="M5 8h14" /><path d="M6 11V8h12v3a6 6 0 0 1-12 0Z" />
    </svg>
  );
}

function EyeIcon({ className = "size-6" }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function TerminalIcon({ className = "size-6" }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" x2="20" y1="19" y2="19" />
    </svg>
  );
}

function CpuIcon({ className = "size-6" }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect width="16" height="16" x="4" y="4" rx="2" />
      <rect width="6" height="6" x="9" y="9" rx="1" />
      <path d="M15 2v2" /><path d="M15 20v2" /><path d="M2 15h2" /><path d="M2 9h2" />
      <path d="M20 15h2" /><path d="M20 9h2" /><path d="M9 2v2" /><path d="M9 20v2" />
    </svg>
  );
}

function KeyIcon({ className = "size-6" }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4" />
      <path d="m21 2-9.6 9.6" /><circle cx="7.5" cy="15.5" r="5.5" />
    </svg>
  );
}

function AppleIcon({ className = "size-5" }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z" />
    </svg>
  );
}

function GithubIcon({ className = "size-5" }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
    </svg>
  );
}

function ChartIcon({ className = "size-6" }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M3 3v16a2 2 0 0 0 2 2h16" />
      <path d="m19 9-5 5-4-4-3 3" />
    </svg>
  );
}

function LockIcon({ className = "size-6" }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Bento visual elements — mini UI mockups inside each card
// ---------------------------------------------------------------------------

function BentoSandbox() {
  return (
    <div className="bento-visual mt-4 flex items-center gap-3">
      <div className="flex-1 border border-edge rounded-md p-2.5 bg-surface-alt/50">
        <div className="text-[9px] text-content/20 uppercase tracking-widest mb-1.5">Guest VM</div>
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-allowed/50" /><span className="text-[10px] text-content/25 font-mono">clawcage-pty-agent</span></div>
          <div className="flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-allowed/50" /><span className="text-[10px] text-content/25 font-mono">clawcage-net-proxy</span></div>
          <div className="flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-caution/50" /><span className="text-[10px] text-content/25 font-mono">clawcage-sys-watch</span></div>
        </div>
      </div>
      <div className="flex flex-col items-center gap-0.5 text-content/10">
        <div className="w-px h-4 bg-edge" />
        <span className="text-[8px] uppercase tracking-widest">vsock</span>
        <div className="w-px h-4 bg-edge" />
      </div>
      <div className="flex-1 border border-edge rounded-md p-2.5 bg-surface-alt/50">
        <div className="text-[9px] text-content/20 uppercase tracking-widest mb-1.5">Host</div>
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-interactive/30" /><span className="text-[10px] text-content/25 font-mono">MITM proxy</span></div>
          <div className="flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-interactive/30" /><span className="text-[10px] text-content/25 font-mono">Policy engine</span></div>
          <div className="flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-interactive/30" /><span className="text-[10px] text-content/25 font-mono">Credential vault</span></div>
        </div>
      </div>
    </div>
  );
}

function BentoVisibility() {
  const rows = [
    { method: "POST", domain: "api.anthropic.com", path: "/v1/messages", status: "allowed" },
    { method: "GET", domain: "pypi.org", path: "/simple/requests/", status: "allowed" },
    { method: "POST", domain: "exfil.evil.com", path: "/steal", status: "denied" },
  ];
  return (
    <div className="bento-visual mt-4 border border-edge rounded-md overflow-hidden text-[10px] font-mono">
      <div className="grid grid-cols-[40px_1fr_80px] gap-x-2 px-2.5 py-1.5 border-b border-edge text-content/15 uppercase tracking-wider text-[8px]">
        <span>Method</span><span>Request</span><span className="text-right">Status</span>
      </div>
      {rows.map((r, i) => (
        <div key={i} className="grid grid-cols-[40px_1fr_80px] gap-x-2 px-2.5 py-1.5 border-b border-edge last:border-0">
          <span className="text-content/30">{r.method}</span>
          <span className="text-content/20 truncate">{r.domain}{r.path}</span>
          <span className={`text-right ${r.status === "allowed" ? "text-allowed/60" : "text-denied/60"}`}>{r.status}</span>
        </div>
      ))}
    </div>
  );
}

function BentoCredential() {
  return (
    <div className="bento-visual mt-4 flex flex-col gap-2">
      <div className="border border-edge rounded-md px-2.5 py-2 flex items-center justify-between">
        <span className="text-[10px] text-content/25 font-mono">ANTHROPIC_API_KEY</span>
        <span className="text-[9px] text-denied/50 border border-denied/20 rounded px-1.5 py-0.5">blocked in VM</span>
      </div>
      <div className="flex items-center gap-2 text-content/10">
        <div className="flex-1 h-px bg-edge" />
        <span className="text-[8px] uppercase tracking-widest shrink-0">host injects at proxy</span>
        <div className="flex-1 h-px bg-edge" />
      </div>
      <div className="border border-edge rounded-md px-2.5 py-2 flex items-center justify-between">
        <span className="text-[10px] text-content/25 font-mono">x-api-key: sk-ant-***</span>
        <span className="text-[9px] text-allowed/50 border border-allowed/20 rounded px-1.5 py-0.5">injected</span>
      </div>
    </div>
  );
}

function BentoPolicy() {
  const rules = [
    { domain: "api.anthropic.com", action: "allow", methods: "POST" },
    { domain: "*.openai.com", action: "allow", methods: "POST, GET" },
    { domain: "pypi.org", action: "allow", methods: "GET" },
    { domain: "*.evil.com", action: "block", methods: "*" },
    { domain: "raw.githubusercontent.com", action: "allow", methods: "GET" },
  ];
  return (
    <div className="bento-visual mt-4 border border-edge rounded-md overflow-hidden text-[10px] font-mono">
      <div className="grid grid-cols-[1fr_56px_64px] gap-x-2 px-2.5 py-1.5 border-b border-edge text-content/15 uppercase tracking-wider text-[8px]">
        <span>Domain</span><span>Action</span><span className="text-right">Methods</span>
      </div>
      {rules.map((r, i) => (
        <div key={i} className="grid grid-cols-[1fr_56px_64px] gap-x-2 px-2.5 py-1.5 border-b border-edge last:border-0">
          <span className="text-content/25 truncate">{r.domain}</span>
          <span className={r.action === "allow" ? "text-allowed/50" : "text-denied/50"}>{r.action}</span>
          <span className="text-content/15 text-right">{r.methods}</span>
        </div>
      ))}
    </div>
  );
}

function BentoTerminal() {
  return (
    <div className="bento-visual mt-4 border border-edge rounded-md overflow-hidden font-mono text-[10px]">
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-b border-edge">
        <span className="px-2 py-0.5 rounded text-[9px] bg-content/5 text-content/30">shell-0</span>
        <span className="px-2 py-0.5 rounded text-[9px] text-content/15">shell-1</span>
        <span className="px-2 py-0.5 rounded text-[9px] text-content/15">shell-2</span>
      </div>
      <div className="px-2.5 py-2 leading-5">
        <div className="text-content/20">root@clawcage:~/project$ <span className="text-content/35">python train.py</span></div>
        <div className="text-content/15">Epoch 1/10 ████████░░ 80% [loss: 0.342]</div>
      </div>
    </div>
  );
}

function BentoMetrics() {
  const bars = [38, 52, 44, 61, 55, 48, 72, 65, 58, 43, 67, 50];
  return (
    <div className="bento-visual mt-4 flex flex-col gap-2.5">
      <div className="flex items-end gap-[3px] h-12">
        {bars.map((h, i) => (
          <div key={i} className="flex-1 rounded-sm bg-content/5 relative overflow-hidden">
            <div className="absolute bottom-0 left-0 right-0 rounded-sm bg-content/10 transition-all duration-500" style={{ height: `${h}%` }} />
          </div>
        ))}
      </div>
      <div className="flex items-center gap-3 text-[9px] text-content/20">
        <span>CPU 23%</span>
        <span className="w-px h-2.5 bg-edge" />
        <span>RAM 856 MB / 2 GB</span>
        <span className="w-px h-2.5 bg-edge" />
        <span>Disk 3.0 / 10 GB</span>
      </div>
    </div>
  );
}

function BentoAnalytics() {
  const models = [
    { name: "claude-4-sonnet", tokens: "1.2M", pct: 58 },
    { name: "gpt-4o", tokens: "680K", pct: 33 },
    { name: "gemini-2.5", tokens: "190K", pct: 9 },
  ];
  return (
    <div className="bento-visual mt-4 flex flex-col gap-2">
      {models.map((m, i) => (
        <div key={i}>
          <div className="flex items-center justify-between text-[10px] mb-1">
            <span className="text-content/25 font-mono">{m.name}</span>
            <span className="text-content/15 tabular-nums">{m.tokens}</span>
          </div>
          <div className="h-1 rounded-full bg-content/5 overflow-hidden">
            <div className="h-full rounded-full bg-content/15 transition-all duration-700" style={{ width: `${m.pct}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function BentoEphemeral() {
  return (
    <div className="bento-visual mt-4 flex items-center gap-4">
      <div className="flex-1 border border-edge rounded-md p-2.5 bg-surface-alt/50">
        <div className="text-[9px] text-content/15 uppercase tracking-widest mb-1.5">Session A</div>
        <div className="flex flex-col gap-1 text-[10px] font-mono text-content/20">
          <span>~/project/model.py</span>
          <span>~/project/data.csv</span>
          <span>~/project/.env</span>
        </div>
      </div>
      <div className="flex flex-col items-center gap-1 text-content/10 shrink-0">
        <span className="text-[8px] uppercase tracking-widest">reboot</span>
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="size-4"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
      </div>
      <div className="flex-1 border border-dashed border-edge rounded-md p-2.5">
        <div className="text-[9px] text-content/15 uppercase tracking-widest mb-1.5">Session B</div>
        <div className="flex flex-col gap-1 text-[10px] font-mono text-content/10">
          <span className="line-through">~/project/model.py</span>
          <span className="line-through">~/project/data.csv</span>
          <span className="line-through">~/project/.env</span>
        </div>
        <div className="text-[9px] text-caution/40 mt-1.5">clean slate</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Navbar
// ---------------------------------------------------------------------------

function Navbar() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <nav className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 border-b ${scrolled ? "bg-surface/70 backdrop-blur-xl border-edge" : "border-transparent"}`}>
      <div className="max-w-5xl mx-auto px-6 h-14 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <img src="/logo.svg" alt="Clawcage" className="w-7 h-7 invert" />
          <span className="text-sm font-semibold tracking-tight">Clawcage</span>
        </div>
        <div className="hidden sm:flex items-center gap-6 text-xs text-content/40">
          <a href="#features" className="hover:text-content transition-colors">Features</a>
          <a href="#how-it-works" className="hover:text-content transition-colors">How it works</a>
          <a href="#pricing" className="hover:text-content transition-colors">Pricing</a>
          <a href="https://github.com/hackyguru/clawcage" target="_blank" rel="noopener noreferrer" className="hover:text-content transition-colors flex items-center gap-1.5">
            <GithubIcon className="size-3.5" />
            GitHub
          </a>
        </div>
        <a
          href="https://github.com/hackyguru/clawcage/releases/latest"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-interactive text-on-interactive hover:opacity-90 transition"
        >
          Download
        </a>
      </div>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Hero
// ---------------------------------------------------------------------------

function Hero() {
  return (
    <section className="pt-32 pb-24 sm:pt-40 sm:pb-32">
      <div className="max-w-3xl mx-auto px-6">
        {/* Badge */}
        <div className="flex justify-center mb-8">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-edge text-[11px] text-content/40">
            <span className="inline-block size-1.5 rounded-full bg-allowed" />
            Public beta
          </div>
        </div>

        <h1 className="text-3xl sm:text-4xl md:text-5xl font-semibold tracking-tight leading-[1.15] text-center mb-5">
          Sandbox your AI agents
          <br />
          <span className="text-content/30">before they sandbox you</span>
        </h1>

        <p className="text-sm sm:text-base text-content/40 max-w-xl mx-auto text-center mb-10 leading-relaxed">
          Clawcage runs every AI agent in an air-gapped Linux VM on your Mac.
          Full network inspection, credential isolation, and kill-switch control.
        </p>

        {/* CTA */}
        <div className="flex flex-col sm:flex-row items-center justify-center gap-3" id="download">
          <a
            href="https://github.com/hackyguru/clawcage/releases/latest"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-medium rounded-lg bg-interactive text-on-interactive hover:opacity-90 transition"
          >
            <AppleIcon className="size-4" />
            Download for macOS
          </a>
          <a
            href="https://github.com/hackyguru/clawcage"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-medium rounded-lg border border-edge hover:bg-surface-alt transition"
          >
            <GithubIcon className="size-4" />
            View source
          </a>
        </div>

        <p className="text-[11px] text-content/20 mt-3 text-center">
          macOS 13+ &middot; Apple Silicon &middot; Free &amp; open source
        </p>

        {/* App mockup */}
        <div className="mt-14 max-w-3xl mx-auto relative">
          <img
            src="/mockup.png"
            alt="Clawcage desktop application"
            className="w-full rounded-xl border border-edge"
            style={{ maskImage: "linear-gradient(to bottom, black 50%, transparent 100%)", WebkitMaskImage: "linear-gradient(to bottom, black 50%, transparent 100%)" }}
          />
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Features bento grid
// ---------------------------------------------------------------------------

function BentoCard({ icon, title, description, span, children }: {
  icon: React.ReactNode;
  title: string;
  description: string;
  span?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className={`group bento-card glass border border-edge rounded-lg p-5 overflow-hidden ${span ?? ""}`}>
      <div className="relative z-10">
        <div className="w-8 h-8 rounded-md bg-content/5 flex items-center justify-center mb-3 text-content/40 group-hover:text-content/60 transition-colors">
          {icon}
        </div>
        <h3 className="text-sm font-semibold mb-1.5">{title}</h3>
        <p className="text-xs text-content/35 leading-relaxed">{description}</p>
      </div>
      {children}
    </div>
  );
}

function Features() {
  return (
    <section id="features" className="py-20 sm:py-28 border-t border-edge">
      <div className="max-w-5xl mx-auto px-6">
        <div className="mb-12">
          <div className="text-[10px] text-content/30 uppercase tracking-widest font-semibold mb-2">Features</div>
          <h2 className="text-2xl sm:text-3xl font-semibold tracking-tight">
            Built for AI safety
          </h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <BentoCard icon={<ShieldIcon className="size-5" />} title="Air-Gapped Sandbox" description="Every AI agent runs in a full Linux VM with no direct internet access. Traffic is routed through a MITM proxy with domain-level allow/block policies." span="md:col-span-2">
            <BentoSandbox />
          </BentoCard>

          <BentoCard icon={<EyeIcon className="size-5" />} title="Full Visibility" description="See every HTTP request, tool call, and file change in real time.">
            <BentoVisibility />
          </BentoCard>

          <BentoCard icon={<KeyIcon className="size-5" />} title="Credential Isolation" description="API keys never enter the guest VM. The proxy injects credentials on the host side.">
            <BentoCredential />
          </BentoCard>

          <BentoCard icon={<NetworkIcon className="size-5" />} title="Network Policy Engine" description="Granular domain allow/block lists with HTTP method+path rules. Corp policies override user settings. Hot-reload without restarting." span="md:col-span-2">
            <BentoPolicy />
          </BentoCard>

          <BentoCard icon={<TerminalIcon className="size-5" />} title="Native Terminal" description="Full xterm.js terminal with multi-shell support, dynamic resize, and natural interaction.">
            <BentoTerminal />
          </BentoCard>

          <BentoCard icon={<CpuIcon className="size-5" />} title="Live System Metrics" description="Real-time CPU, memory, and disk usage charts from the guest VM.">
            <BentoMetrics />
          </BentoCard>

          <BentoCard icon={<ChartIcon className="size-5" />} title="AI Usage Analytics" description="Track token usage, costs, and model calls per provider.">
            <BentoAnalytics />
          </BentoCard>

          <BentoCard icon={<LockIcon className="size-5" />} title="Ephemeral by Default" description="VMs are stateless — the scratch disk is formatted fresh every boot. No writes survive across sessions." span="md:col-span-2">
            <BentoEphemeral />
          </BentoCard>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// How it works
// ---------------------------------------------------------------------------

function HowItWorks() {
  const steps = [
    { num: "1", title: "Create an environment", desc: "Pick a template, set hardware limits, and optionally add your API keys. Each environment is a fully isolated VM." },
    { num: "2", title: "Run your AI agent", desc: "Launch Claude, Codex, Gemini, or any tool. It runs inside the VM with no direct internet access." },
    { num: "3", title: "Observe everything", desc: "Watch every network request, tool call, and file change in real time. Block or allow domains on the fly." },
    { num: "4", title: "Stay in control", desc: "Credential isolation keeps your API keys safe. Ephemeral VMs ensure nothing persists beyond the session." },
  ];

  return (
    <section id="how-it-works" className="py-20 sm:py-28 border-t border-edge">
      <div className="max-w-5xl mx-auto px-6">
        <div className="mb-12">
          <div className="text-[10px] text-content/30 uppercase tracking-widest font-semibold mb-2">How it works</div>
          <h2 className="text-2xl sm:text-3xl font-semibold tracking-tight">
            Zero to sandbox in 10 seconds
          </h2>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
          {steps.map((step) => (
            <div key={step.num}>
              <div className="text-[10px] text-content/20 uppercase tracking-widest font-semibold mb-3">
                Step {step.num}
              </div>
              <h3 className="text-sm font-semibold mb-1.5">{step.title}</h3>
              <p className="text-xs text-content/35 leading-relaxed">{step.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

function Pricing() {
  return (
    <section id="pricing" className="py-20 sm:py-28 border-t border-edge">
      <div className="max-w-5xl mx-auto px-6">
        <div className="mb-12">
          <div className="text-[10px] text-content/30 uppercase tracking-widest font-semibold mb-2">Pricing</div>
          <h2 className="text-2xl sm:text-3xl font-semibold tracking-tight">
            Free forever. Pro when you need it.
          </h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 max-w-3xl">
          {/* Free tier */}
          <div className="glass border border-edge rounded-lg p-6 flex flex-col">
            <div className="text-[10px] text-content/30 uppercase tracking-widest font-semibold mb-3">Open Source</div>
            <div className="flex items-baseline gap-1 mb-1">
              <span className="text-3xl font-semibold">$0</span>
              <span className="text-xs text-content/30">forever</span>
            </div>
            <p className="text-xs text-content/35 mb-5">Everything you need to sandbox AI agents locally.</p>

            <ul className="flex flex-col gap-2.5 text-xs text-content/50 mb-6 flex-1">
              <li className="flex items-start gap-2">
                <span className="text-allowed mt-0.5 shrink-0">&#10003;</span>
                Unlimited local VMs
              </li>
              <li className="flex items-start gap-2">
                <span className="text-allowed mt-0.5 shrink-0">&#10003;</span>
                Air-gapped sandbox with MITM proxy
              </li>
              <li className="flex items-start gap-2">
                <span className="text-allowed mt-0.5 shrink-0">&#10003;</span>
                Network policy engine
              </li>
              <li className="flex items-start gap-2">
                <span className="text-allowed mt-0.5 shrink-0">&#10003;</span>
                Credential isolation
              </li>
              <li className="flex items-start gap-2">
                <span className="text-allowed mt-0.5 shrink-0">&#10003;</span>
                Full telemetry &amp; analytics
              </li>
              <li className="flex items-start gap-2">
                <span className="text-allowed mt-0.5 shrink-0">&#10003;</span>
                Bring your own API keys
              </li>
            </ul>

            <a
              href="https://github.com/hackyguru/clawcage/releases/latest"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium rounded-lg border border-edge hover:bg-surface-alt transition w-full"
            >
              Download
            </a>
          </div>

          {/* Pro tier */}
          <div className="glass border border-edge rounded-lg p-6 flex flex-col relative overflow-hidden">
            <div className="absolute top-4 right-4">
              <span className="text-[9px] text-caution/70 border border-caution/20 rounded px-1.5 py-0.5 uppercase tracking-widest font-semibold">Coming soon</span>
            </div>
            <div className="text-[10px] text-content/30 uppercase tracking-widest font-semibold mb-3">Pro</div>
            <div className="flex items-baseline gap-1 mb-1">
              <span className="text-xl font-semibold text-content/30">Coming soon</span>
            </div>
            <p className="text-xs text-content/35 mb-5">Managed infrastructure so you don&apos;t have to bring your own.</p>

            <ul className="flex flex-col gap-2.5 text-xs text-content/35 mb-6 flex-1">
              <li className="flex items-start gap-2">
                <span className="text-content/15 mt-0.5 shrink-0">&#10003;</span>
                Everything in Open Source
              </li>
              <li className="flex items-start gap-2">
                <span className="text-content/15 mt-0.5 shrink-0">&#10003;</span>
                Managed AI inference endpoints
              </li>
              <li className="flex items-start gap-2">
                <span className="text-content/15 mt-0.5 shrink-0">&#10003;</span>
                Managed VPN for sandboxed traffic
              </li>
              <li className="flex items-start gap-2">
                <span className="text-content/15 mt-0.5 shrink-0">&#10003;</span>
                No API keys needed
              </li>
              <li className="flex items-start gap-2">
                <span className="text-content/15 mt-0.5 shrink-0">&#10003;</span>
                Usage dashboard &amp; billing
              </li>
              <li className="flex items-start gap-2">
                <span className="text-content/15 mt-0.5 shrink-0">&#10003;</span>
                Priority support
              </li>
            </ul>

            <button
              disabled
              className="inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-interactive/10 text-content/25 w-full cursor-not-allowed"
            >
              Notify me
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// CTA
// ---------------------------------------------------------------------------

function CTA() {
  return (
    <section className="py-20 sm:py-28 border-t border-edge">
      <div className="max-w-2xl mx-auto px-6 text-center">
        <h2 className="text-2xl sm:text-3xl font-semibold tracking-tight mb-3">
          Ready to sandbox your AI?
        </h2>
        <p className="text-sm text-content/35 mb-8 max-w-md mx-auto">
          Free, open source, and built for developers who want full control
          over their AI agents.
        </p>
        <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
          <a
            href="https://github.com/hackyguru/clawcage/releases/latest"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-medium rounded-lg bg-interactive text-on-interactive hover:opacity-90 transition"
          >
            <AppleIcon className="size-4" />
            Download for macOS
          </a>
          <a
            href="https://github.com/hackyguru/clawcage"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-medium rounded-lg border border-edge hover:bg-surface-alt transition"
          >
            <GithubIcon className="size-4" />
            Star on GitHub
          </a>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Footer
// ---------------------------------------------------------------------------

function Footer() {
  return (
    <footer className="border-t border-edge py-6">
      <div className="max-w-5xl mx-auto px-6 flex flex-col sm:flex-row items-center justify-between gap-4 text-[11px] text-content/20">
        <div className="flex items-center gap-2">
          <img src="/logo.svg" alt="Clawcage" className="w-5 h-5 invert" />
          <span>&copy; {new Date().getFullYear()} Clawcage</span>
        </div>
        <div className="flex items-center gap-5">
          <a href="https://github.com/hackyguru/clawcage" target="_blank" rel="noopener noreferrer" className="hover:text-content/50 transition-colors">GitHub</a>
          <a href="#" className="hover:text-content/50 transition-colors">Docs</a>
          <a href="#" className="hover:text-content/50 transition-colors">License</a>
        </div>
      </div>
    </footer>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function Home() {
  return (
    <>
      <Head>
        <title>Clawcage — Sandbox your AI agents</title>
        <meta name="description" content="Run AI agents in air-gapped Linux VMs on your Mac. Full network inspection, credential isolation, and kill-switch control." />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="/favicon.ico" />
      </Head>
      <Navbar />
      <main>
        <Hero />
        <Features />
        <HowItWorks />
        <Pricing />
        <CTA />
      </main>
      <Footer />
    </>
  );
}
