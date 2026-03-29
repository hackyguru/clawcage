// Terminal component - wraps the clawcage-terminal web component
import { useEffect, useRef, useCallback, useState } from 'react';
import type { ClawcageTerminal as ClawcageTerminalElement } from '../../components/clawcage-terminal';
import { serialInput, terminalResize, terminalPoll, onTerminalSourceChanged, vmStatus } from '../api';
import { getTheme } from '../stores/theme';
import { setTerminalRenderer } from '../stores/vm';
import { getActiveVenv } from '../stores/venvs';
import { getTemplate } from '../templates';

// Side-effect: register the web component
import '../../components/clawcage-terminal';

interface TerminalProps {
  sessionId?: number;
}

export default function Terminal({ sessionId = 0 }: TerminalProps) {
  const termRef = useRef<ClawcageTerminalElement>(null);
  const mountedRef = useRef(true);
  const inputBufferRef = useRef('');
  const inputTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isMock, setIsMock] = useState(false);
  const [booting, setBooting] = useState(true);
  const [settingUp, setSettingUp] = useState(false);
  const settingUpRef = useRef(false);
  const [setupName, setSetupName] = useState('');
  const [disconnected, setDisconnected] = useState(false);
  const failCountRef = useRef(0);
  const DISCONNECT_THRESHOLD = 8; // ~2s of consecutive failures
  // Boot phases: 'booting' = discard all output, 'buffering' = vsock connected
  // but bashrc hasn't cleared screen yet (accumulate), 'ready' = pass-through.
  const phaseRef = useRef<'booting' | 'buffering' | 'ready'>('booting');
  const postBootBuf = useRef<number[]>([]);
  const vmAlreadyRunning = useRef(false);

  const INPUT_BATCH_MS = 5;
  const INPUT_BATCH_MAX = 4096;

  const flushInput = useCallback(() => {
    if (inputTimerRef.current !== null) {
      clearTimeout(inputTimerRef.current);
      inputTimerRef.current = null;
    }
    if (inputBufferRef.current.length === 0) return;
    const batch = inputBufferRef.current;
    inputBufferRef.current = '';
    serialInput(batch, sessionId).catch(() => {});
  }, []);

  useEffect(() => {
    import('../mock').then((mod) => setIsMock(mod.isMock));
  }, []);

  useEffect(() => {
    const termEl = termRef.current;
    if (!termEl) return;
    mountedRef.current = true;
    const cleanups: (() => void)[] = [];

    // Forward terminal input with batching (DOM events work before open)
    const onInput = ((e: CustomEvent) => {
      inputBufferRef.current += e.detail;
      if (inputBufferRef.current.length >= INPUT_BATCH_MAX) {
        flushInput();
      } else if (inputTimerRef.current === null) {
        inputTimerRef.current = setTimeout(flushInput, INPUT_BATCH_MS);
      }
    }) as EventListener;
    termEl.addEventListener('terminal-input', onInput);
    cleanups.push(() => termEl.removeEventListener('terminal-input', onInput));

    // Forward terminal resize to Tauri
    const onResize = ((e: CustomEvent) => {
      const { cols, rows } = e.detail;
      terminalResize(cols, rows, sessionId).catch(() => {});
    }) as EventListener;
    termEl.addEventListener('terminal-resize', onResize);
    cleanups.push(() => termEl.removeEventListener('terminal-resize', onResize));

    // Wait for the web component to finish opening xterm (async connectedCallback
    // awaits font loading). Without this, write/fit/focus calls silently fail.
    termEl.ready.then(() => {
      if (!mountedRef.current) return;
      initTerminal(termEl, cleanups);
    });

    return () => {
      mountedRef.current = false;
      flushInput();
      for (const fn of cleanups) fn();
    };
  }, [flushInput, sessionId]);

  // Extracted so it runs only after the web component is fully opened.
  function initTerminal(termEl: ClawcageTerminalElement, cleanups: (() => void)[]) {
    // Set initial theme
    termEl.setTheme(getTheme() as 'light' | 'dark');

    // Poll-based output loop with retry for VM boot delay.
    // Until we see the bashrc clear-screen escape (\x1b[2J), all data is
    // accumulated but hidden behind the loading overlay.  Once the clear-
    // screen arrives we write from that byte onwards (the banner + prompt)
    // and switch to direct pass-through.  This works regardless of whether
    // the clear-screen arrives before or after the vsock event.
    const CLEAR_SEQ = [0x1b, 0x5b, 0x32, 0x4a]; // \x1b[2J
    // OSC markers for template setup: \x1b]777;clawcage-setup;start\x1b\\ and ;done
    const SETUP_START = 'clawcage-setup;start';
    const SETUP_DONE = 'clawcage-setup;done';
    const decoder = new TextDecoder();

    function scanForClearScreen(data: number[]): number {
      for (let i = 0; i <= data.length - CLEAR_SEQ.length; i++) {
        if (data[i] === CLEAR_SEQ[0] && data[i+1] === CLEAR_SEQ[1] &&
            data[i+2] === CLEAR_SEQ[2] && data[i+3] === CLEAR_SEQ[3]) {
          return i;
        }
      }
      return -1;
    }

    // If the VM is already running when we mount (e.g. switching venvs back),
    // skip the boot phase — the clear-screen was sent long ago and won't repeat.
    // This prevents an empty terminal stuck on "Starting environment..." for 8s.
    if (!isMock) {
      vmStatus().then((s) => {
        if (!mountedRef.current) return;
        if (s.toLowerCase() === 'running' && phaseRef.current !== 'ready') {
          vmAlreadyRunning.current = true;
          phaseRef.current = 'ready';
          setBooting(false);
          termEl.clear();
          termEl.fit();
          // Send Enter so the shell prints a fresh prompt on the new terminal
          serialInput('\n', sessionId).catch(() => {});
        }
      }).catch(() => {});
    }

    if (!isMock) {
      (async function pollTerminalOutput() {
        while (mountedRef.current) {
          try {
            const data = await terminalPoll(sessionId);
            if (failCountRef.current > 0) {
              failCountRef.current = 0;
              setDisconnected(false);
            }
            if (data.length === 0) continue;

            if (phaseRef.current === 'ready') {
              // Scan for setup markers in the stream
              const text = decoder.decode(new Uint8Array(data), { stream: true });
              if (text.includes(SETUP_START)) {
                const venv = getActiveVenv();
                const tpl = venv ? getTemplate(venv.template) : null;
                setSetupName(tpl?.name ?? 'Template');
                settingUpRef.current = true;
                setSettingUp(true);
              }
              if (text.includes(SETUP_DONE)) {
                settingUpRef.current = false;
                setSettingUp(false);
                // Clear and show fresh prompt
                termEl.clear();
                termEl.fit();
                serialInput('\n', sessionId).catch(() => {});
              }
              // Don't write setup output to terminal — show overlay instead
              if (!settingUpRef.current && !text.includes(SETUP_START)) {
                termEl.write(new Uint8Array(data));
              }
              await new Promise((r) => requestAnimationFrame(r));
            } else {
              // Both 'booting' and 'buffering': accumulate and scan
              postBootBuf.current.push(...data);

              // Check for setup start marker in the buffered data
              const bufText = decoder.decode(new Uint8Array(postBootBuf.current), { stream: true });
              if (bufText.includes(SETUP_START) && !settingUpRef.current) {
                const venv = getActiveVenv();
                const tpl = venv ? getTemplate(venv.template) : null;
                setSetupName(tpl?.name ?? 'Template');
                settingUpRef.current = true;
                setSettingUp(true);
                setBooting(false);
              }

              const clearIdx = scanForClearScreen(postBootBuf.current);
              if (clearIdx >= 0) {
                // Found clear-screen — write from that byte onwards
                phaseRef.current = 'ready';
                setBooting(false);
                const fromClear = new Uint8Array(postBootBuf.current.slice(clearIdx));
                postBootBuf.current = [];
                termEl.clear();
                termEl.fit();
                // Don't write if we're in setup mode
                if (!settingUpRef.current) {
                  termEl.write(fromClear);
                }
              } else if (postBootBuf.current.length > 256 * 1024) {
                // Cap buffer at 256KB to prevent unbounded growth
                postBootBuf.current = postBootBuf.current.slice(-CLEAR_SEQ.length);
              }
            }
          } catch {
            failCountRef.current++;
            if (failCountRef.current >= DISCONNECT_THRESHOLD) {
              setDisconnected(true);
            }
            await new Promise((r) => setTimeout(r, 250));
          }
        }
      })();
    }

    // When vsock connects, re-fit terminal (phase transition is handled
    // entirely by the poll loop scanning for the clear-screen sequence).
    onTerminalSourceChanged((_source) => {
      termEl.fit();
    }).then((unsub) => cleanups.push(unsub));

    // Safety timeout: if clear-screen never arrives within 8s, force-show
    // whatever we have so the user isn't stuck on the loading screen.
    const bufferTimeout = setTimeout(() => {
      if (phaseRef.current !== 'ready') {
        phaseRef.current = 'ready';
        setBooting(false);
        termEl.clear();
        termEl.fit();
        if (postBootBuf.current.length > 0) {
          termEl.write(new Uint8Array(postBootBuf.current));
          postBootBuf.current = [];
        }
      }
    }, 8000);
    cleanups.push(() => clearTimeout(bufferTimeout));

    // Watch for data-theme changes on <html>
    const observer = new MutationObserver(() => {
      const theme = document.documentElement.getAttribute('data-theme');
      if (theme === 'light' || theme === 'dark') {
        termEl.setTheme(theme);
      }
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    cleanups.push(() => observer.disconnect());

    // In mock mode, skip loading and write a demo banner
    if (isMock) {
      setBooting(false);
      const encoder = new TextEncoder();
      termEl.write(
        encoder.encode(
          '\x1b[1;34mAI.VM sandbox ready\x1b[0m\r\n' +
            '\x1b[35mLinux 6.6.127 | aarch64\x1b[0m\r\n' +
            '\r\n' +
            'Dev:  python3  node  npm  git  vim\r\n' +
            'AI:   claude   gemini  codex\r\n' +
            'Test: clawcage-test\r\n' +
            '\r\n' +
            '\x1b[1;34mclawcage:~#\x1b[0m ',
        ),
      );
    }

    setTerminalRenderer(termEl.renderer);
    termEl.focusTerminal();
  }

  return (
    <div className="relative h-full w-full">
      <clawcage-terminal
        ref={termRef as any}
        class="block h-full w-full"
      />
      {booting && !settingUp && !isMock && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-base-300">
          <span className="spinner w-6 h-6 text-interactive mb-3" />
          <span className="text-sm text-content/50">Starting environment...</span>
        </div>
      )}
      {settingUp && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-base-300">
          <span className="spinner w-6 h-6 text-interactive mb-3" />
          <span className="text-sm text-content/50">Setting up {setupName}...</span>
          <span className="text-xs text-content/30 mt-1">This may take a minute</span>
        </div>
      )}
      {disconnected && !booting && (
        <div className="absolute top-0 inset-x-0 z-10 flex items-center justify-center py-1.5 bg-denied/90 text-white text-xs font-medium gap-2">
          <span className="inline-block w-2 h-2 rounded-full bg-white/60 animate-pulse" />
          Connection lost — waiting to reconnect...
        </div>
      )}
    </div>
  );
}

// Declare the web component for React JSX
declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'clawcage-terminal': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        ref?: any;
        class?: string;
      };
    }
  }
}
