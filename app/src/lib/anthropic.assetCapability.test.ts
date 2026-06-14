import { describe, expect, it } from 'vitest';
import {
  buildAssetCapabilityBlock,
  type AssetChannelAvailability,
} from '@/lib/anthropic';

const none: AssetChannelAvailability = {
  image: false,
  music: false,
  threeD: false,
  video: false,
  speech: false,
  sprite: false,
};

describe('buildAssetCapabilityBlock', () => {
  it("returns '' when no channel is ready", () => {
    expect(buildAssetCapabilityBlock(none)).toBe('');
  });

  it('begins with a separator so it can be appended onto a system prompt', () => {
    const text = buildAssetCapabilityBlock({ ...none, image: true });
    expect(text.startsWith('\n\n')).toBe(true);
  });

  it('always carries the anti-fabrication rule when any channel is ready', () => {
    const text = buildAssetCapabilityBlock({ ...none, music: true });
    expect(text).toContain('PIL');
    expect(text).toContain('ffmpeg');
  });

  it('lists only the channels that are ready', () => {
    const text = buildAssetCapabilityBlock({ ...none, image: true });
    expect(text).toContain('/image');
    // Unready channels must not be advertised.
    expect(text).not.toContain('/music');
    expect(text).not.toContain('/video');
    expect(text).not.toContain('/mesh-mode-start');
    expect(text).not.toContain('/sprite');
    expect(text).not.toContain('/speech');
  });

  it('surfaces every channel command when all are ready', () => {
    const text = buildAssetCapabilityBlock({
      image: true,
      music: true,
      threeD: true,
      video: true,
      speech: true,
      sprite: true,
    });
    expect(text).toContain('/image');
    expect(text).toContain('/sprite');
    expect(text).toContain('/mesh-mode-start');
    expect(text).toContain('/music');
    expect(text).toContain('/speech');
    expect(text).toContain('/video');
  });
});
