import { describe, expect, it, vi } from 'vitest';
import { createBoundedTextCache } from './boundedTextCache';

describe('production bounded derivation cache', () => {
  it('reuses immutable revision values and caches undefined results', () => {
    const cache = createBoundedTextCache<undefined>();
    const derive = vi.fn(() => undefined);
    expect(cache.get('unchanged', derive)).toBeUndefined();
    expect(cache.get('unchanged', derive)).toBeUndefined();
    expect(derive).toHaveBeenCalledTimes(1);
  });

  it('evicts the least recently used revision at the entry limit', () => {
    const cache = createBoundedTextCache<object>(2, 100);
    const a = cache.get('a', () => ({}));
    const b = cache.get('b', () => ({}));
    expect(cache.get('a', () => ({}))).toBe(a);
    cache.get('c', () => ({}));
    expect(cache.get('a', () => ({}))).toBe(a);
    expect(cache.get('b', () => ({}))).not.toBe(b);
  });

  it('counts derived output as well as source keys against its character budget', () => {
    const cache = createBoundedTextCache<string>(10, 10);
    const first = vi.fn(() => '123456');
    cache.get('a', first, (value) => value.length);
    cache.get('b', () => '654321', (value) => value.length);
    cache.get('a', first, (value) => value.length);
    expect(first).toHaveBeenCalledTimes(2);
  });

  it('never retains an oversized key or value', () => {
    const cache = createBoundedTextCache<string>(10, 10);
    const keyDerive = vi.fn(() => 'short');
    const valueDerive = vi.fn(() => 'oversized output');
    for (let i = 0; i < 2; i++) {
      cache.get('oversized input', keyDerive);
      cache.get('small', valueDerive, (value) => value.length);
    }
    expect(keyDerive).toHaveBeenCalledTimes(2);
    expect(valueDerive).toHaveBeenCalledTimes(2);
  });
});
