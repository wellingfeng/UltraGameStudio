import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_IMAGE_GENERATION_SETTINGS } from './imageGeneration';
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
  it('keeps legacy sprite provider metadata only for persisted settings compatibility', () => {
    expect(SPRITE_PROVIDERS.map((provider) => provider.id)).toEqual([
      'ludo-sprite',
      'local-comfyui-sprite',
    ]);
    expect(spriteProviderById('ludo-sprite').label).toContain('Ludo');
    expect(spriteProviderBaseUrl('ludo-sprite', DEFAULT_SPRITE_GENERATION_SETTINGS)).toBe(
      'https://api.ludo.ai',
    );
    expect(spriteProviderModel('local-comfyui-sprite')).toBe('AnimateDiff');
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
    expect(normalized.sheetPreset).toBe('4x4');
    expect(normalized.chromaKey).toBe('#FF00FF');
  });

  it('normalizes Sprite Forge advanced options', () => {
    const normalized = normalizeSpriteGenerationSettings({
      sheetPreset: 'custom',
      sheetRows: 99,
      sheetColumns: 0,
      chromaKey: '#00ff00',
      frameAnchor: 'bottom',
      componentMode: 'all',
      rejectEdgeTouch: false,
      fitScale: 2,
    });

    expect(normalized.sheetPreset).toBe('custom');
    expect(normalized.sheetRows).toBe(8);
    expect(normalized.sheetColumns).toBe(1);
    expect(normalized.chromaKey).toBe('#00FF00');
    expect(normalized.frameAnchor).toBe('bottom');
    expect(normalized.componentMode).toBe('all');
    expect(normalized.rejectEdgeTouch).toBe(false);
    expect(normalized.fitScale).toBe(1);
  });

  it('legacy sprite provider readiness is not used by Sprite generation routing', () => {
    expect(spriteProviderReady('ludo-sprite', DEFAULT_SPRITE_GENERATION_SETTINGS)).toBe(false);
    expect(
      spriteProviderReady('local-comfyui-sprite', DEFAULT_SPRITE_GENERATION_SETTINGS),
    ).toBe(true);

    expect(
      preferredReadySpriteProviderId({
        ...DEFAULT_IMAGE_GENERATION_SETTINGS,
        preferredProviderId: 'pollinations',
        providerKeys: { pollinations: 'pollinations-key' },
      }),
    ).toBe('pollinations');
    expect(
      preferredReadySpriteProviderId({
        ...DEFAULT_IMAGE_GENERATION_SETTINGS,
        preferredProviderId: 'zhipu-cogview',
        providerKeys: { 'agnes-image': 'agnes-key' },
      }),
    ).toBeNull();
  });

  it('detects sprite generation intent and strips commands', () => {
    expect(looksLikeSpriteGenerationRequest('/sprite idle robot')).toBe(true);
    expect(looksLikeSpriteGenerationRequest('生成一套像素角色序列帧')).toBe(true);
    expect(looksLikeSpriteGenerationRequest('修复登录 bug')).toBe(false);
    expect(stripSpriteCommand('/spritesheet idle robot')).toBe('idle robot');
    expect(stripSpriteCommand('请帮我生成一个精灵图小火球')).toContain('小火球');
  });

  it('reuses the configured image provider and wraps its output as a spritesheet', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ url: 'https://cdn.example.test/sprite-sheet.png' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const result = await generateSprite(
      {
        prompt: '/sprite idle robot',
        providerId: 'pollinations',
        model: 'flux',
      },
      DEFAULT_SPRITE_GENERATION_SETTINGS,
      {
        ...DEFAULT_IMAGE_GENERATION_SETTINGS,
        preferredProviderId: 'pollinations',
        providerKeys: { pollinations: 'pollinations-key' },
      },
    );

    expect(result.providerId).toBe('pollinations');
    expect(result.providerLabel).toBe('Pollinations');
    expect(result.spritesheets).toEqual(['https://cdn.example.test/sprite-sheet.png']);
    expect(result.frames).toEqual([]);
    expect(result.gifs).toEqual([]);
    expect(result.videos).toEqual([]);
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      'https://gen.pollinations.ai/image/',
    );
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    const imagePrompt = decodeURIComponent(url.pathname.replace(/^\/image\//, ''));
    expect(imagePrompt).toContain('Sprite Forge compatible raw spritesheet constraints');
    expect(imagePrompt).toContain('exact layout: 4 rows x 4 columns, 16 frames');
    expect(imagePrompt).toContain('solid #FF00FF chroma key');
    expect(url.searchParams.get('model')).toBe('flux');
  });

  it('uses the image default provider when Sprite gets no explicit provider', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ url: 'https://cdn.example.test/sprite-sheet.png' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const result = await generateSprite(
      {
        prompt: '/sprite idle robot',
      },
      DEFAULT_SPRITE_GENERATION_SETTINGS,
      {
        ...DEFAULT_IMAGE_GENERATION_SETTINGS,
        preferredProviderId: 'zhipu-cogview',
        providerKeys: { 'zhipu-cogview': 'zhipu-key' },
      },
    );

    expect(result.providerId).toBe('zhipu-cogview');
    expect(result.providerLabel).toBe('智谱 CogView');
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      'https://open.bigmodel.cn/api/paas/v4/images/generations',
    );
  });

  it('does not fall back to Agnes when the image default provider is missing', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ url: 'https://cdn.example.test/sprite-sheet.png' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    await expect(
      generateSprite(
        {
          prompt: '/sprite idle robot',
        },
        DEFAULT_SPRITE_GENERATION_SETTINGS,
        {
          ...DEFAULT_IMAGE_GENERATION_SETTINGS,
          preferredProviderId: 'zhipu-cogview',
          providerKeys: { 'agnes-image': 'agnes-key' },
        },
      ),
    ).rejects.toThrow('IMAGE_PROVIDER_NOT_READY:zhipu-cogview');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses fixed sheet presets as the image prompt grid contract', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ url: 'https://cdn.example.test/sprite-sheet.png' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const result = await generateSprite(
      {
        prompt: '/sprite attack fx',
        providerId: 'pollinations',
      },
      {
        ...DEFAULT_SPRITE_GENERATION_SETTINGS,
        sheetPreset: '2x3',
        sheetRows: 2,
        sheetColumns: 3,
      },
      {
        ...DEFAULT_IMAGE_GENERATION_SETTINGS,
        preferredProviderId: 'pollinations',
        providerKeys: { pollinations: 'pollinations-key' },
      },
    );

    const url = new URL(String(fetchMock.mock.calls[0][0]));
    const imagePrompt = decodeURIComponent(url.pathname.replace(/^\/image\//, ''));
    expect(result.frameCount).toBe(6);
    expect(imagePrompt).toContain('exact layout: 2 rows x 3 columns, 6 frames');
  });

  it('throws when generation is disabled', async () => {
    await expect(
      generateSprite(
        { prompt: 'idle robot', providerId: 'pollinations' },
        { ...DEFAULT_SPRITE_GENERATION_SETTINGS, enabled: false },
        {
          ...DEFAULT_IMAGE_GENERATION_SETTINGS,
          preferredProviderId: 'pollinations',
          providerKeys: { pollinations: 'pollinations-key' },
        },
      ),
    ).rejects.toThrow('SPRITE_GENERATION_DISABLED');
  });
});
