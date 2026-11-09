import { tauriAvailable } from './tauri';

export interface UiPerformanceSample {
  kind: 'longTask' | 'timerDrift' | 'heartbeat';
  durationMs: number;
  hidden: boolean;
}

export interface UiPerformanceOptions {
  desktop?: boolean;
  report?: (samples: UiPerformanceSample[]) => Promise<void>;
}

async function reportToNative(samples: UiPerformanceSample[]): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('report_ui_performance', { samples });
}

/** Optional diagnostics: never read message bodies, entry names or attribution. */
export function startUiPerformanceMonitor(options: UiPerformanceOptions = {}): () => void {
  if (!(options.desktop ?? tauriAvailable())) return () => {};
  const report = options.report ?? reportToNative;
  const pending: UiPerformanceSample[] = [];
  let stopped = false;
  let reporting = false;
  let observer: PerformanceObserver | undefined;
  const enqueue = (sample: UiPerformanceSample) => {
    if (pending.length === 64) pending.shift();
    pending.push(sample);
  };
  try {
    if (typeof PerformanceObserver !== 'undefined'
      && PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
      observer = new PerformanceObserver((entries) => {
        if (stopped) return;
        for (const entry of entries.getEntries()) {
          if (Number.isFinite(entry.duration) && entry.duration >= 50 && entry.duration <= 86_400_000) {
            enqueue({ kind: 'longTask', durationMs: entry.duration, hidden: document.hidden });
          }
        }
      });
      observer.observe({ type: 'longtask' });
    }
  } catch {
    // Unsupported observers must not prevent application startup.
    observer?.disconnect();
    observer = undefined;
  }
  const timer = setInterval(() => {
    if (stopped || reporting) return;
    const samples = pending.splice(0, 32);
    if (samples.length === 0) samples.push({ kind: 'heartbeat', durationMs: 0, hidden: document.hidden });
    reporting = true;
    // Do not race a timeout and submit more IPC while the first is still queued.
    // A hung native message loop must not accumulate probes/reports.
    void Promise.resolve().then(() => { if (!stopped) return report(samples); }).catch(() => {})
      .finally(() => { reporting = false; });
  }, 5_000);
  let previousTick = performance.now();
  const heartbeat = setInterval(() => {
    if (stopped) return;
    const now = performance.now();
    const drift = now - previousTick - 1_000;
    previousTick = now;
    // Chromium intentionally throttles hidden windows; do not label that a freeze.
    if (!document.hidden && Number.isFinite(drift) && drift >= 200 && drift <= 86_400_000) {
      enqueue({ kind: 'timerDrift', durationMs: drift, hidden: false });
    }
  }, 1_000);
  return () => {
    stopped = true;
    clearInterval(timer);
    clearInterval(heartbeat);
    observer?.disconnect();
    pending.length = 0;
  };
}
