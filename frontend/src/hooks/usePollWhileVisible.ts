import { useEffect } from 'react';

// Runs `check` every `intervalMs` — but only while the tab is showing. A
// hidden tab (another tab in front, a minimised window, a locked phone) makes
// no requests at all; the moment it's shown again, `check` runs straight away
// so nobody looks at stale numbers, and the interval starts over from there.
//
// The first load is the caller's: this only keeps it fresh. `check` should be
// stable (a useCallback), or the interval restarts on every render.
export function usePollWhileVisible(check: () => void | Promise<void>, intervalMs: number): void {
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;

    const start = (): void => {
      timer ??= setInterval(() => void check(), intervalMs);
    };
    const stop = (): void => {
      clearInterval(timer);
      timer = undefined;
    };
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') {
        void check();
        stop(); // a fresh interval from this check, not the old schedule
        start();
      } else {
        stop();
      }
    };

    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [check, intervalMs]);
}
