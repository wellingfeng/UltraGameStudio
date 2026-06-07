import { describe, expect, it } from 'vitest';
import {
  captureBytesToBase64,
  planPageSlices,
  siblingPagePath,
} from './sessionScreenshot';

describe('planPageSlices', () => {
  it('returns no slices for an empty box', () => {
    expect(planPageSlices(0)).toEqual([]);
    expect(planPageSlices(-100)).toEqual([]);
  });

  it('returns a single full-height slice for a short session', () => {
    expect(planPageSlices(800)).toEqual([[0, 800]]);
  });

  it('keeps short sessions to one page right up to the ceiling', () => {
    const slices = planPageSlices(12000);
    expect(slices).toHaveLength(1);
    expect(slices[0]).toEqual([0, 12000]);
  });

  it('splits a tall session into evenly-sized, gapless, non-overlapping pages', () => {
    const total = 30000;
    const slices = planPageSlices(total);
    expect(slices.length).toBeGreaterThan(1);

    // Each page stays under the canvas ceiling.
    for (const [, height] of slices) {
      expect(height).toBeLessThanOrEqual(12000);
      expect(height).toBeGreaterThan(0);
    }

    // Slices are contiguous: each starts where the previous ended.
    for (let i = 1; i < slices.length; i++) {
      const [y] = slices[i];
      const [prevY, prevH] = slices[i - 1];
      expect(y).toBe(prevY + prevH);
    }

    // The slices exactly cover the full height.
    const last = slices[slices.length - 1];
    expect(last[0] + last[1]).toBe(total);
  });
});

describe('siblingPagePath', () => {
  it('derives page 2+ from a picked `-1.png` path (posix)', () => {
    expect(siblingPagePath('/home/me/chat-1.png', 1)).toBe('/home/me/chat-2.png');
    expect(siblingPagePath('/home/me/chat-1.png', 2)).toBe('/home/me/chat-3.png');
  });

  it('handles Windows backslash separators', () => {
    expect(siblingPagePath('C:\\Users\\FW\\chat-1.png', 1)).toBe(
      'C:\\Users\\FW\\chat-2.png',
    );
  });

  it('recovers the base name when the user dropped the `-1` suffix', () => {
    expect(siblingPagePath('/tmp/session.png', 1)).toBe('/tmp/session-2.png');
  });

  it('works with a bare filename (no directory)', () => {
    expect(siblingPagePath('chat-1.png', 1)).toBe('chat-2.png');
  });
});

describe('captureBytesToBase64', () => {
  it('encodes bytes in the format expected by the desktop save IPC', () => {
    expect(captureBytesToBase64(new Uint8Array([0, 1, 2, 253, 254, 255]))).toBe(
      'AAEC/f7/',
    );
  });
});
