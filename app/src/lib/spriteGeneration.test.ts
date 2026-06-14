import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SPRITE_GENERATION_SETTINGS,
  SPRITE_PROVIDERS,
  generateSprite,
  looksLikeSpriteGenerationRequest,
  normalizeSpriteGenerationSettings,
  preferredReadySpriteProviderId,
  spriteProviderBaseUrl,
  spriteProviderById,
  spriteProviderModel,
  spriteProviderReady,
  stripSpriteCommand,
} from './spriteGeneration';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('sprite generation settings and routing', () => {
  it('exposes commercial and local-open providers', () => {
    expect(SPRITE_PROVIDERS.map((provider) => provider.id)).toEqual([
      'ludo-sprite',
      'local-comfyui-sprite',
    ]);
    expect(SPRITE_PROVIDERS.some((provider) => provider.category === 'commercial')).toBe(true);
    expect(SPRITE_PROVIDERS.some((provider) => provider.category === 'local-open')).toBe(true);
  });

  it('normalizes unknown settings to defaults', () => {
    expect(normalizeSpriteGenerationSettings(null)).toEqual(
      DEFAULT_SPRITE_GENERATION_SETTINGS,
    );
    const normalized = normalizeSpriteGenerationSettings({
      enabled: false,
      preferredProviderId: 'not-a-provider',
      providerKeys: { 'ludo-sprite': ' key ', bogus: 'x' },
      defaultFrameCount: 999,
      defaultFrameSize: 1,
      removeBackground: false,
    });
    expect(normalized.enabled).toBe(false);
    expect(normalized.preferredProviderId).toBe(
      DEFAULT_SPRITE_GENERATION_SETTINGS.preferredProviderId,
    );
    expect(normalized.providerKeys).toEqual({ 'ludo-sprite': 'key' });
    expect(normalized.defaultFrameCount).toBe(64);
    expect(normalized.defaultFrameSize).toBe(16);
    expect(normalized.removeBackground).toBe(false);
  });

  it('requires a key for Ludo and treats the default local ComfyUI endpoint as ready', () => {
    expect(spriteProviderReady('ludo-sprite', DEFAULT_SPRITE_GENERATION_SETTINGS)).toBe(false);
    expect(
      spriteProviderReady('ludo-sprite', {
        ...DEFAULT_SPRITE_GENERATION_SETTINGS,
        providerKeys: { 'ludo-sprite': 'ludo-key' },
      }),
    ).toBe(true);
    expect(
      spriteProviderReady('local-comfyui-sprite', DEFAULT_SPRITE_GENERATION_SETTINGS),
    ).toBe(true);
    expect(
      spriteProviderReady('local-comfyui-sprite', {
        ...DEFAULT_SPRITE_GENERATION_SETTINGS,
        providerBaseUrls: {
          'local-comfyui-sprite': 'http://127.0.0.1:8190/generate-sprite',
        },
      }),
    ).toBe(true);
  });

  it('falls back to another ready provider when the default is not configured', () => {
    const settings = {
      ...DEFAULT_SPRITE_GENERATION_SETTINGS,
      preferredProviderId: 'ludo-sprite' as const,
    };
    expect(preferredReadySpriteProviderId(settings)).toBe('local-comfyui-sprite');
  });

  it('detects sprite generation intent and strips commands', () => {
    expect(looksLikeSpriteGenerationRequest('/sprite idle robot')).toBe(true);
    expect(looksLikeSpriteGenerationRequest('生成一套像素角色序列帧')).toBe(true);
    expect(looksLikeSpriteGenerationRequest('修复登录 bug')).toBe(false);
    expect(stripSpriteCommand('/spritesheet idle robot')).toBe('idle robot');
    expect(stripSpriteCommand('请帮我生成一个精灵图小火球')).toContain('小火球');
  });

  it('calls the local sprite endpoint with postprocess options', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          spritesheet_url: 'http://127.0.0.1:8190/out/sheet.png',
          frame_urls: ['http://127.0.0.1:8190/out/frame-01.png'],
          gif_url: 'http://127.0.0.1:8190/out/preview.gif',
          status: 'succeeded',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const result = await generateSprite(
      {
        prompt: '/sprite idle robot',
        providerId: 'local-comfyui-sprite',
        model: 'AnimateDiff',
      },
      {
        ...DEFAULT_SPRITE_GENERATION_SETTINGS,
        providerBaseUrls: {
          'local-comfyui-sprite': 'http://127.0.0.1:8190/generate-sprite',
        },
      },
    );

    expect(result.providerId).toBe('local-comfyui-sprite');
    expect(result.spritesheets).toEqual(['http://127.0.0.1:8190/out/sheet.png']);
    expect(result.frames).toEqual(['http://127.0.0.1:8190/out/frame-01.png']);
    expect(result.gifs).toEqual(['http://127.0.0.1:8190/out/preview.gif']);
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:8190/generate-sprite');
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body).toEqual(
      expect.objectContaining({
        action: 'createImage',
        frame_count: 16,
        frame_size: 128,
        remove_background: true,
        align_frames: true,
        pack_spritesheet: true,
      }),
    );
    expect(body.postprocess).toEqual(
      expect.objectContaining({
        ffmpeg_extract_frames: true,
        remove_background: true,
        align_frames: true,
        pack_spritesheet: true,
      }),
    );
  });

  it('posts to Ludo with bearer auth and maps animation mode', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          spritesheetUrl: 'https://cdn.example.com/sheet.png',
          videoUrl: 'https://cdn.example.com/clip.mp4',
          status: 'succeeded',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const result = await generateSprite(
      {
        prompt: '/sprite 首帧参考图生成 walk 动画',
        providerId: 'ludo-sprite',
      },
      {
        ...DEFAULT_SPRITE_GENERATION_SETTINGS,
        providerKeys: { 'ludo-sprite': 'ludo-key' },
      },
    );

    expect(result.providerId).toBe('ludo-sprite');
    expect(result.mode).toBe('image-to-animation');
    expect(result.spritesheets).toEqual(['https://cdn.example.com/sheet.png']);
    expect(result.videos).toEqual(['https://cdn.example.com/clip.mp4']);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.ludo.ai/sprite/generations');
    expect(fetchMock.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer ludo-key',
          'Content-Type': 'application/json',
        }),
      }),
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.action).toBe('animateSprite');
  });

  it('throws when generation is disabled', async () => {
    await expect(
      generateSprite(
        { prompt: 'idle robot', providerId: 'ludo-sprite' },
        { ...DEFAULT_SPRITE_GENERATION_SETTINGS, enabled: false },
      ),
    ).rejects.toThrow('SPRITE_GENERATION_DISABLED');
  });

  it('resolves provider metadata by id with a safe fallback', () => {
    expect(spriteProviderById('ludo-sprite').label).toContain('Ludo');
    expect(spriteProviderBaseUrl('ludo-sprite', DEFAULT_SPRITE_GENERATION_SETTINGS)).toBe(
      'https://api.ludo.ai',
    );
    expect(spriteProviderModel('local-comfyui-sprite')).toBe('AnimateDiff');
  });
});
