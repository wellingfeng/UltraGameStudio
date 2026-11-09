import { afterEach, describe, expect, it, vi } from 'vitest';
import { StreamPublicationQueue } from './streamPublication';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('bounded stream publications', () => {
  it('yields after the shared publication budget instead of draining every owner', () => {
    vi.useFakeTimers();
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const queue = new StreamPublicationQueue();
    const published: number[] = [];
    for (let i = 0; i < 10; i += 1) queue.schedule({}, () => { published.push(i); now += 3; });
    vi.advanceTimersByTime(40);
    expect(published).toEqual([0, 1]);
    vi.runAllTimers();
    expect(published).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('publishes in a hidden page without waiting for an animation frame', () => {
    vi.useFakeTimers();
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);
    const queue = new StreamPublicationQueue();
    const publish = vi.fn();
    queue.schedule({}, publish);
    vi.advanceTimersByTime(40);
    expect(publish).toHaveBeenCalledOnce();
  });

  it('coalesces only one owner and flushes its latest publication synchronously', () => {
    vi.useFakeTimers();
    const queue = new StreamPublicationQueue();
    const owner = {};
    const first = vi.fn();
    const latest = vi.fn();
    const other = vi.fn();
    queue.schedule(owner, first);
    queue.schedule(owner, latest);
    queue.schedule({}, other);
    queue.flush(owner);
    expect(latest).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();
    expect(other).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(other).toHaveBeenCalledOnce();
    expect(latest).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
