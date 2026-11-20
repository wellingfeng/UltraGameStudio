const MIN_SCAN_INTERVAL_MS = 180_000;

/** Requests come from completed turns only. A busy session is retried at its next completion. */
export function createSessionChangeScheduler(
  scan: (key: string) => Promise<void>,
  isIdle: (key: string) => boolean = () => true,
  history?: { read: (key: string) => number | undefined; write: (key: string, time: number) => void },
) {
  const states = new Map<string, { lastStarted: number; pending: boolean; running: boolean; timer?: ReturnType<typeof setTimeout> }>();
  function schedule(key: string) {
    const state = states.get(key)!;
    if (!state.pending || state.running || state.timer) return;
    const delay = Math.max(0, state.lastStarted + MIN_SCAN_INTERVAL_MS - Date.now());
    state.timer = setTimeout(() => {
      state.timer = undefined;
      if (!state.pending || !isIdle(key)) return;
      state.pending = false;
      state.running = true;
      state.lastStarted = Date.now();
      history?.write(key, state.lastStarted);
      void scan(key).catch((error) => console.warn('[session-files] 会话变更扫描失败', error)).finally(() => {
        state.running = false;
        schedule(key);
      });
    }, delay);
  }
  return {
    request(key: string) {
      let state = states.get(key);
      if (!state) {
        state = { lastStarted: history?.read(key) ?? -Infinity, pending: false, running: false };
        states.set(key, state);
      }
      state.pending = true;
      schedule(key);
    },
  };
}
