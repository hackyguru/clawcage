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

    // Poll-based output loop with retry for VM boot delay
    if (!isMock) {
      (async function pollTerminalOutput() {
        while (mountedRef.current) {
          try {
            const data = await terminalPoll();
            if (data.length > 0) {
              termEl.write(new Uint8Array(data));
              await new Promise((r) => requestAnimationFrame(r));
            }
          } catch {
            // VM may not be ready yet or terminal closed between venv switches.
            // Retry after a short delay; the loop exits when the component unmounts.
            await new Promise((r) => setTimeout(r, 250));
          }
        }
      })();
    }

    // When vsock connects, re-fit terminal
    onTerminalSourceChanged((_source) => {
      termEl.fit();
    }).then((unsub) => cleanups.push(unsub));

    // Watch for data-theme changes on <html>
    const observer = new MutationObserver(() => {
      const theme = document.documentElement.getAttribute('data-theme');
      if (theme === 'light' || theme === 'dark') {
        termEl.setTheme(theme);
      }
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    cleanups.push(() => observer.disconnect());

    // In mock mode, write a demo banner
    if (isMock) {
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
    <capsem-terminal
      ref={termRef as any}
      class="block h-full w-full"
    />
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
