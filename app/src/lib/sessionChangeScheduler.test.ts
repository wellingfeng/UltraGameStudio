import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSessionChangeScheduler } from './sessionChangeScheduler';

afterEach(() => vi.useRealTimers());

describe('session change scheduler', () => {
  it('coalesces completed turns and waits at least three minutes between scans', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const scan = vi.fn(async () => {});
    const scheduler = createSessionChangeScheduler(scan);
    scheduler.request('session');
    await vi.advanceTimersByTimeAsync(0);
    expect(scan).toHaveBeenCalledTimes(1);
    scheduler.request('session');
    scheduler.request('session');
    await vi.advanceTimersByTimeAsync(179_999);
    expect(scan).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it('does not scan while a new turn is running and resumes on completion', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    let idle = true;
    const scan = vi.fn(async () => {});
    const scheduler = createSessionChangeScheduler(scan, () => idle);
    scheduler.request('session');
    await vi.advanceTimersByTimeAsync(0);
    scheduler.request('session');
    idle = false;
    await vi.advanceTimersByTimeAsync(180_000);
    expect(scan).toHaveBeenCalledTimes(1);
    idle = true;
    scheduler.request('session');
    await vi.advanceTimersByTimeAsync(0);
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it('retains the minimum interval across scheduler recreation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const saved = new Map<string, number>();
    const history = { read: (key: string) => saved.get(key), write: (key: string, time: number) => saved.set(key, time) };
    const scan = vi.fn(async () => {});
    createSessionChangeScheduler(scan, undefined, history).request('session');
    await vi.advanceTimersByTimeAsync(0);
    createSessionChangeScheduler(scan, undefined, history).request('session');
    await vi.advanceTimersByTimeAsync(179_999);
    expect(scan).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(scan).toHaveBeenCalledTimes(2);
  });
});
