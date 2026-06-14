import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SPEECH_GENERATION_SETTINGS,
  SPEECH_PROVIDERS,
  generateSpeech,
  looksLikeSpeechGenerationRequest,
  normalizeSpeechGenerationSettings,
  preferredReadySpeechProviderId,
  speechProviderBaseUrl,
  speechProviderById,
  speechProviderReady,
  speechProviderVoice,
  stripSpeechCommand,
} from './speechGeneration';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('speech generation settings and routing', () => {
  it('exposes commercial and free providers', () => {
    expect(SPEECH_PROVIDERS.length).toBeGreaterThan(12);
    expect(SPEECH_PROVIDERS.some((p) => p.category === 'commercial')).toBe(true);
    expect(SPEECH_PROVIDERS.some((p) => p.category === 'free')).toBe(true);
    expect(SPEECH_PROVIDERS.some((p) => p.local)).toBe(true);
  });

  it('normalizes unknown settings to defaults', () => {
    expect(normalizeSpeechGenerationSettings(null)).toEqual(
      DEFAULT_SPEECH_GENERATION_SETTINGS,
    );
    const normalized = normalizeSpeechGenerationSettings({
      enabled: false,
      preferredProviderId: 'not-a-provider',
      providerKeys: { elevenlabs: ' key ', bogus: 'x' },
      providerVoices: { elevenlabs: ' Rachel ' },
    });
    expect(normalized.enabled).toBe(false);
    expect(normalized.preferredProviderId).toBe(
      DEFAULT_SPEECH_GENERATION_SETTINGS.preferredProviderId,
    );
    expect(normalized.providerKeys).toEqual({ elevenlabs: 'key' });
    expect(normalized.providerVoices).toEqual({ elevenlabs: 'Rachel' });
  });

  it('treats a key-based provider as ready once a key is set', () => {
    expect(speechProviderReady('openai-tts', DEFAULT_SPEECH_GENERATION_SETTINGS)).toBe(false);
    const ready = speechProviderReady('openai-tts', {
      ...DEFAULT_SPEECH_GENERATION_SETTINGS,
      providerKeys: { 'openai-tts': 'sk-123' },
    });
    expect(ready).toBe(true);
  });

  it('requires account id for providers that need it', () => {
    const keyOnly = speechProviderReady('minimax-tts', {
      ...DEFAULT_SPEECH_GENERATION_SETTINGS,
      providerKeys: { 'minimax-tts': 'sk-123' },
    });
    expect(keyOnly).toBe(false);
    const ready = speechProviderReady('minimax-tts', {
      ...DEFAULT_SPEECH_GENERATION_SETTINGS,
      providerKeys: { 'minimax-tts': 'sk-123' },
      providerAccountIds: { 'minimax-tts': 'group-1' },
    });
    expect(ready).toBe(true);
  });

  it('requires a base URL for local providers', () => {
    expect(
      speechProviderReady('local-kokoro', DEFAULT_SPEECH_GENERATION_SETTINGS),
    ).toBe(false);
    const ready = speechProviderReady('local-kokoro', {
      ...DEFAULT_SPEECH_GENERATION_SETTINGS,
      providerBaseUrls: { 'local-kokoro': 'http://127.0.0.1:8880/v1' },
    });
    expect(ready).toBe(true);
  });

  it('falls back to another ready provider when the default is not configured', () => {
    const settings = {
      ...DEFAULT_SPEECH_GENERATION_SETTINGS,
      preferredProviderId: 'elevenlabs' as const,
      providerKeys: { 'openai-tts': 'sk-123' },
    };
    expect(preferredReadySpeechProviderId(settings)).toBe('openai-tts');
  });

  it('detects speech generation intent and strips commands', () => {
    expect(looksLikeSpeechGenerationRequest('/tts hello world')).toBe(true);
    expect(looksLikeSpeechGenerationRequest('把这段话朗读成语音')).toBe(true);
    expect(looksLikeSpeechGenerationRequest('修复登录 bug')).toBe(false);
    expect(stripSpeechCommand('/tts hello world')).toBe('hello world');
    expect(stripSpeechCommand('请帮我朗读：你好世界')).toContain('你好世界');
  });

  it('resolves the configured voice with a default fallback', () => {
    expect(speechProviderVoice('openai-tts', DEFAULT_SPEECH_GENERATION_SETTINGS)).toBe('alloy');
    expect(
      speechProviderVoice('openai-tts', {
        ...DEFAULT_SPEECH_GENERATION_SETTINGS,
        providerVoices: { 'openai-tts': 'nova' },
      }),
    ).toBe('nova');
  });

  it('calls the OpenAI speech endpoint and returns an audio data URL', async () => {
    const wavBytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x10, 0x00]);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(wavBytes, {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' },
      }),
    );

    const result = await generateSpeech(
      { prompt: '/tts hello there', providerId: 'openai-tts', model: 'tts-1', voice: 'nova' },
      { ...DEFAULT_SPEECH_GENERATION_SETTINGS, providerKeys: { 'openai-tts': 'sk-key' } },
    );

    expect(result.providerId).toBe('openai-tts');
    expect(result.voice).toBe('nova');
    expect(result.audios).toHaveLength(1);
    expect(result.audios[0]).toMatch(/^data:audio\/mpeg;base64,/);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.openai.com/v1/audio/speech');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual(
      expect.objectContaining({ model: 'tts-1', input: 'hello there', voice: 'nova' }),
    );
  });

  it('reads an audio URL from a JSON response (Gemini path)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  { inlineData: { mimeType: 'audio/wav', data: 'QUJDREVG' } },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const result = await generateSpeech(
      { prompt: '念一段话', providerId: 'google-gemini-tts', voice: 'Kore' },
      { ...DEFAULT_SPEECH_GENERATION_SETTINGS, providerKeys: { 'google-gemini-tts': 'AIza-key' } },
    );

    expect(result.audios).toHaveLength(1);
    expect(result.audios[0]).toMatch(/^data:audio\/(wav|mpeg);base64,QUJDREVG$/);
  });

  it('calls a configured local speech HTTP endpoint without an API key', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ audio_url: 'http://127.0.0.1:8880/output/speech.mp3', status: 'succeeded' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const result = await generateSpeech(
      { prompt: '/tts 本地朗读', providerId: 'local-speech-server' },
      {
        ...DEFAULT_SPEECH_GENERATION_SETTINGS,
        providerBaseUrls: { 'local-speech-server': 'http://127.0.0.1:8088/tts' },
      },
    );

    expect(result.audios).toEqual(['http://127.0.0.1:8880/output/speech.mp3']);
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:8088/tts');
  });

  it('decodes MiniMax hex audio', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ base_resp: { status_code: 0 }, data: { audio: '414243' } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const result = await generateSpeech(
      { prompt: '/tts 你好', providerId: 'minimax-tts' },
      {
        ...DEFAULT_SPEECH_GENERATION_SETTINGS,
        providerKeys: { 'minimax-tts': 'sk-key' },
        providerAccountIds: { 'minimax-tts': 'group-1' },
      },
    );

    expect(result.audios[0]).toBe(`data:audio/mpeg;base64,${btoa('ABC')}`);
  });

  it('throws when generation is disabled', async () => {
    await expect(
      generateSpeech(
        { prompt: 'hello', providerId: 'openai-tts' },
        { ...DEFAULT_SPEECH_GENERATION_SETTINGS, enabled: false },
      ),
    ).rejects.toThrow('SPEECH_GENERATION_DISABLED');
  });

  it('resolves provider metadata by id with a safe fallback', () => {
    expect(speechProviderById('elevenlabs').label).toContain('ElevenLabs');
    expect(speechProviderBaseUrl('openai-tts', DEFAULT_SPEECH_GENERATION_SETTINGS)).toBe(
      'https://api.openai.com/v1',
    );
  });
});