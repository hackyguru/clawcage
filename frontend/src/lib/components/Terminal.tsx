// Terminal component - wraps the capsem-terminal web component
import { useEffect, useRef, useCallback, useState } from 'react';
import type { CapsemTerminal as CapsemTerminalElement } from '../../components/capsem-terminal';
import { serialInput, terminalResize, terminalPoll, onTerminalSourceChanged } from '../api';
import { getTheme } from '../stores/theme';
import { setTerminalRenderer } from '../stores/vm';

// Side-effect: register the web component
import '../../components/capsem-terminal';

export default function Terminal() {
  const termRef = useRef<CapsemTerminalElement>(null);
  const mountedRef = useRef(true);
  const inputBufferRef = useRef('');
  const inputTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isMock, setIsMock] = useState(false);
  const [booting, setBooting] = useState(true);
  // Boot phases: 'booting' = discard all output, 'buffering' = vsock connected
  // but bashrc hasn't cleared screen yet (accumulate), 'ready' = pass-through.
  const phaseRef = useRef<'booting' | 'buffering' | 'ready'>('booting');
  const postBootBuf = useRef<number[]>([]);

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
    serialInput(batch).catch(() => {});
  }, []);

  useEffect(() => {
    import('../mock').then((mod) => setIsMock(mod.isMock));
  }, []);

  useEffect(() => {
    const termEl = termRef.current;
    if (!termEl) return;
    mountedRef.current = true;
    const cleanups: (() => void)[] = [];

    // Set initial theme
    termEl.setTheme(getTheme() as 'light' | 'dark');

    // Forward terminal input with batching
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
      terminalResize(cols, rows).catch(() => {});
    }) as EventListener;
    termEl.addEventListener('terminal-resize', onResize);
    cleanups.push(() => termEl.removeEventListener('terminal-resize', onResize));

    // Poll-based output loop with retry for VM boot delay.
    // Until we see the bashrc clear-screen escape (\x1b[2J), all data is
    // accumulated but hidden behind the loading overlay.  Once the clear-
    // screen arrives we write from that byte onwards (the banner + prompt)
    // and switch to direct pass-through.  This works regardless of whether
    // the clear-screen arrives before or after the vsock event.
    const CLEAR_SEQ = [0x1b, 0x5b, 0x32, 0x4a]; // \x1b[2J

    function scanForClearScreen(data: number[]): number {
      for (let i = 0; i <= data.length - CLEAR_SEQ.length; i++) {
        if (data[i] === CLEAR_SEQ[0] && data[i+1] === CLEAR_SEQ[1] &&
            data[i+2] === CLEAR_SEQ[2] && data[i+3] === CLEAR_SEQ[3]) {
          return i;
        }
      }
      return -1;
    }

    if (!isMock) {
      (async function pollTerminalOutput() {
        while (mountedRef.current) {
          try {
            const data = await terminalPoll();
            if (data.length === 0) continue;

            if (phaseRef.current === 'ready') {
              termEl.write(new Uint8Array(data));
              await new Promise((r) => requestAnimationFrame(r));
            } else {
              // Both 'booting' and 'buffering': accumulate and scan
              postBootBuf.current.push(...data);
              const clearIdx = scanForClearScreen(postBootBuf.current);
              if (clearIdx >= 0) {
                // Found clear-screen — write from that byte onwards
                phaseRef.current = 'ready';
                setBooting(false);
                const fromClear = new Uint8Array(postBootBuf.current.slice(clearIdx));
                postBootBuf.current = [];
                termEl.clear();
                termEl.fit();
                termEl.write(fromClear);
              } else if (postBootBuf.current.length > 256 * 1024) {
                // Cap buffer at 256KB to prevent unbounded growth
                postBootBuf.current = postBootBuf.current.slice(-CLEAR_SEQ.length);
              }
            }
          } catch {
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
            'Test: capsem-test\r\n' +
            '\r\n' +
            '\x1b[1;34maivm:~#\x1b[0m ',
        ),
      );
    }

    setTerminalRenderer(termEl.renderer);
    termEl.focusTerminal();

    return () => {
      mountedRef.current = false;
      flushInput();
      for (const fn of cleanups) fn();
    };
  }, [flushInput]);

  return (
    <div className="relative h-full w-full">
      <capsem-terminal
        ref={termRef as any}
        class="block h-full w-full"
      />
      {booting && !isMock && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-neutral-950">
          <span className="loading loading-spinner loading-md text-interactive mb-3" />
          <span className="text-sm text-neutral-400">Starting environment...</span>
        </div>
      )}
    </div>
  );
}

// Declare the web component for React JSX
declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'capsem-terminal': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        ref?: any;
        class?: string;
      };
    }
  }
}
