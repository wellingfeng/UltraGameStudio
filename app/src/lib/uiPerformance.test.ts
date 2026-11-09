import { afterEach, describe, expect, it, vi } from 'vitest';
import { startUiPerformanceMonitor, type UiPerformanceSample } from './uiPerformance';

let observerCallback: PerformanceObserverCallback;
const disconnect = vi.fn();
const observe = vi.fn();
const stops: Array<() => void> = [];

function emitLongTasks(...durations: number[]) {
  observerCallback({ getEntries: () => durations.map((duration) => ({
    entryType: 'longtask', duration, name: 'never-serialize-this-sensitive-name',
    attribution: [{ name: 'private-window-url' }],
  })) } as unknown as PerformanceObserverEntryList, {} as PerformanceObserver);
}

function setup(
  report = vi.fn<(samples: UiPerformanceSample[]) => Promise<void>>().mockResolvedValue(undefined),
  entryTypes = ['longtask'],
) {
  vi.useFakeTimers();
  vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
  class Observer {
    static supportedEntryTypes = entryTypes;
    constructor(callback: PerformanceObserverCallback) { observerCallback = callback; }
    observe = observe;
    disconnect = disconnect;
  }
  vi.stubGlobal('PerformanceObserver', Observer);
  stops.push(startUiPerformanceMonitor({ desktop: true, report }));
  return report;
}

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  observe.mockClear();
  disconnect.mockClear();
});

describe('UI performance diagnostics', () => {
  it('does not dispatch a report microtask queued before disposal', async () => {
    const report = setup();
    vi.advanceTimersByTime(5_000);
    stops.pop()!();
    await Promise.resolve();
    await Promise.resolve();
    expect(report).not.toHaveBeenCalled();
  });
  it('reports long tasks as numeric-only batches without names or attribution', async () => {
    const report = setup();
    expect(observe).toHaveBeenCalledWith({ type: 'longtask' });
    emitLongTasks(49, 120, Number.NaN, Infinity, -3);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][0]).toEqual([{ kind: 'longTask', durationMs: 120, hidden: false }]);
  });

  it('keeps only one native report in flight while a backend is unresponsive', async () => {
    let finish!: () => void;
    const report = setup(vi.fn<(samples: UiPerformanceSample[]) => Promise<void>>()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }))
      .mockResolvedValue(undefined));
    emitLongTasks(120);
    await vi.advanceTimersByTimeAsync(5_000);
    emitLongTasks(130);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(report).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(report).toHaveBeenCalledTimes(2);
    expect(report.mock.calls[1][0]).toEqual([{ kind: 'longTask', durationMs: 130, hidden: false }]);
  });

  it('bounds queued diagnostics to the latest 64 samples and native batches to 32', async () => {
    let finish!: () => void;
    const report = setup(vi.fn<(samples: UiPerformanceSample[]) => Promise<void>>()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }))
      .mockResolvedValue(undefined));
    emitLongTasks(120);
    await vi.advanceTimersByTimeAsync(5_000);
    const durations = Array.from({ length: 1_000 }, (_, i) => 100 + i);
    emitLongTasks(...durations);
    finish();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(report.mock.calls.every(([batch]) => batch.length <= 32)).toBe(true);
    expect(report.mock.calls.slice(1).flatMap(([batch]) => batch.map((s) => s.durationMs)))
      .toEqual(durations.slice(-64));
    expect(report).toHaveBeenCalledTimes(3);
  });

  it('emits a frontend heartbeat even when long-task observation is unsupported', async () => {
    const report = setup(undefined, []);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(observe).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith([{ kind: 'heartbeat', durationMs: 0, hidden: false }]);
  });

  it('records visible event-loop drift rather than normal hidden-page throttling', async () => {
    const report = setup();
    vi.setSystemTime(Date.now() + 500);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(report.mock.calls[0][0]).toEqual([{ kind: 'timerDrift', durationMs: 500, hidden: false }]);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    vi.setSystemTime(Date.now() + 2_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(report.mock.calls[1][0]).toEqual([{ kind: 'heartbeat', durationMs: 0, hidden: true }]);
  });

  it('disconnects and removes timers on disposal, ignoring already queued observer callbacks', async () => {
    const report = setup();
    const stop = stops.pop()!;
    emitLongTasks(100);
    stop();
    stop();
    emitLongTasks(200);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(report).not.toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not create timers or observers outside the desktop shell', async () => {
    vi.useFakeTimers();
    const report = vi.fn<(samples: UiPerformanceSample[]) => Promise<void>>();
    stops.push(startUiPerformanceMonitor({ desktop: false, report }));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(report).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
