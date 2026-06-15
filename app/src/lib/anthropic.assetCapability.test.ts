import { describe, expect, it } from 'vitest';
import {
  buildAssetCapabilityBlock,
  shouldUseAssetCapabilityBlockForPrompt,
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

  it('states that asset-center/product-rule requests must not trigger channel routing', () => {
    const text = buildAssetCapabilityBlock({ ...none, image: true, sprite: true });
    expect(text).toContain('资产中心');
    expect(text).toContain('偏题原因');
    expect(text).toContain('忽略本段');
  });
});

describe('shouldUseAssetCapabilityBlockForPrompt', () => {
  it('does not trigger for asset-center product rules even when they mention generated assets', () => {
    expect(
      shouldUseAssetCapabilityBlockForPrompt(
        '资产中心的内容不需要将用户发送的内容也展示出来，只展示AI生成、下载、修改后的资产',
      ),
    ).toBe(false);
  });

  it('does not trigger for debugging an off-topic AI answer', () => {
    expect(
      shouldUseAssetCapabilityBlockForPrompt(
        '这里的回答有问题，好像AI没有理解我的要求，回答一个无关的内容',
      ),
    ).toBe(false);
  });

  it('triggers for explicit asset generation and slash commands', () => {
    expect(shouldUseAssetCapabilityBlockForPrompt('帮我生成一张赛博朋克头像')).toBe(
      true,
    );
    expect(shouldUseAssetCapabilityBlockForPrompt('/image a minimal app icon')).toBe(
      true,
    );
    expect(shouldUseAssetCapabilityBlockForPrompt('做一段 15 秒 BGM')).toBe(true);
    expect(shouldUseAssetCapabilityBlockForPrompt('生成一个 3D 道具模型')).toBe(
      true,
    );
    expect(shouldUseAssetCapabilityBlockForPrompt('修复一张老照片')).toBe(true);
    expect(shouldUseAssetCapabilityBlockForPrompt('我有个需求：生成一张头像')).toBe(
      true,
    );
  });
});
