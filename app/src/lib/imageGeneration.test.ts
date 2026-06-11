import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_IMAGE_GENERATION_SETTINGS,
  IMAGE_PROVIDERS,
  generateImage,
  imageProviderBaseUrl,
  imageProviderById,
  imageProviderReady,
  looksLikeImageGenerationRequest,
  normalizeImageGenerationSettings,
  preferredReadyImageProviderId,
  stripImageCommand,
} from './imageGeneration';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('image generation settings and routing', () => {
  it('detects explicit image generation requests', () => {
    expect(looksLikeImageGenerationRequest('帮我生成一张赛博朋克头像')).toBe(true);
    expect(looksLikeImageGenerationRequest('/image a minimal app icon')).toBe(true);
    expect(looksLikeImageGenerationRequest('create a poster for launch')).toBe(true);
    expect(looksLikeImageGenerationRequest('修复这个 TypeScript 类型错误')).toBe(false);
  });

  it('strips image command prefixes without eating the actual prompt', () => {
    expect(stripImageCommand('/image a red robot')).toBe('a red robot');
    expect(stripImageCommand('请帮我生成一张山水海报')).toBe('山水海报');
  });

  it('normalizes persisted settings conservatively', () => {
    const settings = normalizeImageGenerationSettings({
      enabled: false,
      showComposerModelSelect: true,
      preferredProviderId: 'pollinations',
      providerKeys: { pollinations: ' token ', unknown: 'x' },
      providerModels: { pollinations: ' flux ' },
    });
    expect(settings.enabled).toBe(false);
    expect(settings.showComposerModelSelect).toBe(true);
    expect(settings.preferredProviderId).toBe('pollinations');
    expect(settings.providerKeys.pollinations).toBe('token');
    expect(settings.providerModels.pollinations).toBe('flux');
  });

  it('does not route anonymous fallback traffic to Pollinations', () => {
    const settings = {
      ...DEFAULT_IMAGE_GENERATION_SETTINGS,
      preferredProviderId: 'cloudflare' as const,
      providerKeys: {},
      providerAccountIds: {},
    };
    expect(imageProviderReady('cloudflare', settings)).toBe(false);
    expect(imageProviderReady('pollinations', settings)).toBe(false);
    expect(preferredReadyImageProviderId(settings)).toBe('ai-horde');
  });

  it('uses direct credential and endpoint links for image providers', () => {
    expect(imageProviderBaseUrl('pollinations')).toBe('https://gen.pollinations.ai');
    expect(imageProviderBaseUrl('recraft')).toBe('https://external.api.recraft.ai/v1');
    expect(imageProviderBaseUrl('google-imagen')).toBe(
      'https://generativelanguage.googleapis.com/v1beta',
    );
    expect(imageProviderById('pollinations').credentialUrl).toBe(
      'https://enter.pollinations.ai',
    );
    expect(imageProviderById('siliconflow').credentialUrl).toBe(
      'https://cloud.siliconflow.cn/account/ak',
    );
    expect(imageProviderById('zhipu-cogview').credentialUrl).toBe(
      'https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys',
    );
    expect(imageProviderById('dashscope-wanx').credentialUrl).toBe(
      'https://bailian.console.aliyun.com/?apiKey=1#/api-key-center',
    );
    expect(imageProviderById('ai-horde').credentialUrl).toBe(
      'https://stablehorde.net/register',
    );
    expect(imageProviderById('replicate').credentialUrl).toBe(
      'https://replicate.com/account/api-tokens',
    );
  });

  it('splits image providers into free-credit and commercial categories', () => {
    const freeCredit = IMAGE_PROVIDERS.filter(
      (provider) => provider.category === 'free-credit',
    ).map((provider) => provider.id);
    const commercial = IMAGE_PROVIDERS.filter(
      (provider) => provider.category === 'commercial',
    ).map((provider) => provider.id);

    expect(freeCredit).toEqual([
      'agnes-image',
      'siliconflow',
      'cloudflare',
      'pollinations',
      'ai-horde',
      'local-comfyui',
      'local-vllm-image',
      'replicate',
      'fal-ai',
      'runware',
    ]);
    expect(commercial).toEqual([
      'google-gemini-image',
      'google-imagen',
      'bfl-flux',
      'ideogram',
      'recraft',
      'stability-ai',
      'adobe-firefly',
      'luma-photon',
      'xai-grok-imagine',
      'zhipu-cogview',
      'dashscope-wanx',
      'minimax',
      'volcengine-seedream',
      'byteplus-seedream',
    ]);
  });

  it('parses OpenAI-style and nested image provider responses', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            image_urls: ['https://example.com/generated.png'],
          },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    const result = await generateImage(
      {
        prompt: '/image 一张中文海报',
        providerId: 'minimax',
      },
      {
        ...DEFAULT_IMAGE_GENERATION_SETTINGS,
        providerKeys: { minimax: 'test-key' },
        providerAccountIds: {},
        providerBaseUrls: {},
        providerModels: {},
      },
    );

    expect(result.providerId).toBe('minimax');
    expect(result.prompt).toBe('一张中文海报');
    expect(result.images).toEqual(['https://example.com/generated.png']);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.minimax.io/v1/image_generation',
      expect.objectContaining({
        method: 'POST',
      }),
    );
  });

  it('calls OpenAI-compatible image providers such as Recraft', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ url: 'https://example.com/recraft.png' }],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );

    const result = await generateImage(
      {
        prompt: '/image brand icon',
        providerId: 'recraft',
      },
      {
        ...DEFAULT_IMAGE_GENERATION_SETTINGS,
        providerKeys: { recraft: 'test-key' },
        providerAccountIds: {},
        providerBaseUrls: {},
        providerModels: {},
      },
    );

    expect(result.images).toEqual(['https://example.com/recraft.png']);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://external.api.recraft.ai/v1/images/generations',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-key',
          'Content-Type': 'application/json',
        }),
      }),
    );
  });

  it('parses Google Imagen base64 predictions', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          predictions: [
            {
              bytesBase64Encoded: 'aW1hZ2U=',
              mimeType: 'image/png',
            },
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );

    const result = await generateImage(
      {
        prompt: '/image product photo',
        providerId: 'google-imagen',
      },
      {
        ...DEFAULT_IMAGE_GENERATION_SETTINGS,
        providerKeys: { 'google-imagen': 'test-key' },
        providerAccountIds: {},
        providerBaseUrls: {},
        providerModels: {},
      },
    );

    expect(result.images).toEqual(['data:image/png;base64,aW1hZ2U=']);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-generate-001:predict?key=test-key',
      expect.objectContaining({
        method: 'POST',
      }),
    );
  });
});
