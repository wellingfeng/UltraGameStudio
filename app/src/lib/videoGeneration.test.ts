import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_VIDEO_GENERATION_SETTINGS,
  VIDEO_PROVIDERS,
  generateVideo,
  looksLikeVideoGenerationRequest,
  normalizeVideoGenerationSettings,
  preferredReadyVideoProviderId,
  stripVideoCommand,
  videoDurationSecondsFromPrompt,
  videoProviderBaseUrl,
  videoProviderById,
  videoProviderReady,
} from './videoGeneration';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('video generation settings and routing', () => {
  it('exposes commercial and free providers', () => {
    expect(VIDEO_PROVIDERS.length).toBeGreaterThan(8);
    expect(VIDEO_PROVIDERS.some((p) => p.category === 'commercial')).toBe(true);
    expect(VIDEO_PROVIDERS.some((p) => p.category === 'free')).toBe(true);
  });

  it('normalizes unknown settings to defaults', () => {
    expect(normalizeVideoGenerationSettings(null)).toEqual(
      DEFAULT_VIDEO_GENERATION_SETTINGS,
    );
    const normalized = normalizeVideoGenerationSettings({
      enabled: false,
      preferredProviderId: 'not-a-provider',
      providerKeys: { runway: ' key ', bogus: 'x' },
    });
    expect(normalized.enabled).toBe(false);
    expect(normalized.preferredProviderId).toBe(
      DEFAULT_VIDEO_GENERATION_SETTINGS.preferredProviderId,
    );
    expect(normalized.providerKeys).toEqual({ runway: 'key' });
  });

  it('treats a key-based provider as ready once a key is set', () => {
    expect(videoProviderReady('runway', DEFAULT_VIDEO_GENERATION_SETTINGS)).toBe(
      false,
    );
    const ready = videoProviderReady('runway', {
      ...DEFAULT_VIDEO_GENERATION_SETTINGS,
      providerKeys: { runway: 'key_123' },
    });
    expect(ready).toBe(true);
  });

  it('requires a base URL for local providers', () => {
    expect(
      videoProviderReady('local-wan-video', DEFAULT_VIDEO_GENERATION_SETTINGS),
    ).toBe(false);
    const ready = videoProviderReady('local-wan-video', {
      ...DEFAULT_VIDEO_GENERATION_SETTINGS,
      providerBaseUrls: { 'local-wan-video': 'http://127.0.0.1:7861/generate' },
    });
    expect(ready).toBe(true);
  });

  it('falls back to another ready provider when the default is not configured', () => {
    const settings = {
      ...DEFAULT_VIDEO_GENERATION_SETTINGS,
      preferredProviderId: 'runway' as const,
      providerKeys: { 'fal-video': 'fal-key' },
    };
    expect(preferredReadyVideoProviderId(settings)).toBe('fal-video');
  });

  it('detects video generation intent and strips commands', () => {
    expect(looksLikeVideoGenerationRequest('/video a cat running')).toBe(true);
    expect(looksLikeVideoGenerationRequest('生成一段海边日落的视频')).toBe(true);
    expect(looksLikeVideoGenerationRequest('修复登录 bug')).toBe(false);
    expect(stripVideoCommand('/video a cat running')).toBe('a cat running');
    expect(stripVideoCommand('生成一段视频：海边日落')).toContain('海边日落');
  });

  it('parses a target duration from the prompt', () => {
    expect(videoDurationSecondsFromPrompt('一个 8 秒的镜头')).toBe(8);
    expect(videoDurationSecondsFromPrompt('no duration here')).toBeNull();
  });

  it('builds the fal endpoint and reads the result video URL', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            request_id: 'fal-vid-1',
            status_url:
              'https://queue.fal.run/fal-ai/wan/requests/fal-vid-1/status',
            response_url: 'https://queue.fal.run/fal-ai/wan/requests/fal-vid-1',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'COMPLETED' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ video: { url: 'https://example.com/clip.mp4' } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );

    const pending = generateVideo(
      {
        prompt: '/video ocean sunset timelapse',
        providerId: 'fal-video',
        model: 'fal-ai/wan/v2.2-a14b/text-to-video',
      },
      {
        ...DEFAULT_VIDEO_GENERATION_SETTINGS,
        providerKeys: { 'fal-video': 'fal-key' },
      },
    );
    await vi.advanceTimersByTimeAsync(3000);
    const result = await pending;

    expect(result.videos).toEqual(['https://example.com/clip.mp4']);
    expect(result.providerId).toBe('fal-video');
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://queue.fal.run/fal-ai/wan/v2.2-a14b/text-to-video',
    );
    expect(fetchMock.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Key fal-key' }),
      }),
    );
  });

  it('calls a configured local video HTTP endpoint without an API key', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          video_url: 'http://127.0.0.1:7861/output/clip.mp4',
          status: 'succeeded',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const result = await generateVideo(
      {
        prompt: '/video 本地 Wan 视频',
        providerId: 'local-wan-video',
      },
      {
        ...DEFAULT_VIDEO_GENERATION_SETTINGS,
        providerBaseUrls: {
          'local-wan-video': 'http://127.0.0.1:7861/generate',
        },
      },
    );

    expect(result.videos).toEqual(['http://127.0.0.1:7861/output/clip.mp4']);
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:7861/generate');
  });

  it('throws when generation is disabled', async () => {
    await expect(
      generateVideo(
        { prompt: 'a clip', providerId: 'fal-video' },
        { ...DEFAULT_VIDEO_GENERATION_SETTINGS, enabled: false },
      ),
    ).rejects.toThrow('VIDEO_GENERATION_DISABLED');
  });

  it('creates and polls a ByteDance Seedance task on Volcano Ark', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'cgt-seedance-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: 'succeeded',
            content: { video_url: 'https://ark.example.com/seedance.mp4' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );

    const pending = generateVideo(
      {
        prompt: '/video 樱花飘落的庭院 8秒',
        providerId: 'bytedance-seedance',
        model: 'doubao-seedance-1-0-pro-250528',
      },
      {
        ...DEFAULT_VIDEO_GENERATION_SETTINGS,
        providerKeys: { 'bytedance-seedance': 'ark-key' },
      },
    );
    await vi.advanceTimersByTimeAsync(3000);
    const result = await pending;

    expect(result.videos).toEqual(['https://ark.example.com/seedance.mp4']);
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks',
    );
    expect(fetchMock.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer ark-key' }),
      }),
    );
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/cgt-seedance-1',
    );
  });

  it('resolves provider metadata by id with a safe fallback', () => {
    expect(videoProviderById('runway').label).toContain('Runway');
    expect(videoProviderBaseUrl('runway', DEFAULT_VIDEO_GENERATION_SETTINGS)).toBe(
      'https://api.dev.runwayml.com/v1',
    );
  });
});
