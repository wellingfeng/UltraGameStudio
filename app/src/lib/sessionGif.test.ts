import { describe, expect, it } from 'vitest';
import { planScrollOffsets } from './sessionGif';

describe('planScrollOffsets', () => {
  it('returns a single still frame when the content fits the viewport', () => {
    expect(planScrollOffsets(500, 800)).toEqual([0]);
    expect(planScrollOffsets(800, 800)).toEqual([0]);
  });

  it('scrolls from 0 to the bottom and holds at the end', () => {
    const offsets = planScrollOffsets(2000, 800, {
      step: 200,
      maxFrames: 100,
      tailHold: 3,
    });
    // maxOffset = 1200; steps 0,200,...,1000 then explicit 1200, then 3 holds.
    expect(offsets[0]).toBe(0);
    const maxOffset = 1200;
    expect(offsets[offsets.length - 1]).toBe(maxOffset);
    // Last 3 frames are the tail hold on the bottom.
    expect(offsets.slice(-3)).toEqual([maxOffset, maxOffset, maxOffset]);
    // Never scrolls past the bottom.
    expect(Math.max(...offsets)).toBe(maxOffset);
  });

  it('monotonically increases (never scrolls backwards)', () => {
    const offsets = planScrollOffsets(10000, 800, { step: 150 });
    for (let i = 1; i < offsets.length; i++) {
      expect(offsets[i]).toBeGreaterThanOrEqual(offsets[i - 1]);
    }
  });

  it('caps the frame count for very long sessions by widening the step', () => {
    const maxFrames = 60;
    const tailHold = 8;
    const offsets = planScrollOffsets(200000, 800, {
      step: 90,
      maxFrames,
      tailHold,
    });
    expect(offsets.length).toBeLessThanOrEqual(maxFrames);
    // Still reaches the very bottom despite the cap.
    expect(offsets[offsets.length - 1]).toBe(200000 - 800);
  });

  it('keeps short scrolls at their natural step without widening', () => {
    const offsets = planScrollOffsets(1600, 800, {
      step: 100,
      maxFrames: 100,
      tailHold: 2,
    });
    // maxOffset = 800; natural steps 0..700 (8) + bottom (800) well under budget.
    expect(offsets[1]).toBe(100);
    expect(offsets[2]).toBe(200);
  });
});
