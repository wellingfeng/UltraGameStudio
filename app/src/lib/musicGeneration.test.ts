import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MUSIC_GENERATION_SETTINGS,
  MUSIC_PROVIDERS,
  generateMusic,
  musicDurationSecondsFromPrompt,
  musicProviderBaseUrl,
  musicProviderById,
  musicProviderReady,
  normalizeMusicGenerationSettings,
  preferredReadyMusicProviderId,
  stripMusicCommand,
} from './musicGeneration';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function fakeAudioBuffer(durationSeconds: number, sampleRate: number): AudioBuffer {
  const length = durationSeconds * sampleRate;
  const samples = new Float32Array(length);
  samples.fill(0.01);
  for (let i = 2 * sampleRate; i < 2.7 * sampleRate; i += 1) {
    samples[i] = 0.85;
  }
  return {
    duration: durationSeconds,
    length,
    numberOfChannels: 1,
    sampleRate,
    getChannelData: () => samples,
  } as unknown as AudioBuffer;
}

function stubAudioDecoder(buffer: AudioBuffer): void {
  class FakeAudioContext {
    decodeAudioData(): Promise<AudioBuffer> {
      return Promise.resolve(buffer);
    }

    close(): Promise<void> {
      return Promise.resolve();
    }
  }

  vi.stubGlobal('AudioContext', FakeAudioContext);
}

function wavDurationSeconds(dataUrl: string): number {
  const base64 = dataUrl.split(',')[1] ?? '';
  const binary = globalThis.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  const view = new DataView(bytes.buffer);
  const channels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const bitsPerSample = view.getUint16(34, true);
  const dataLength = view.getUint32(40, true);
  return dataLength / (sampleRate * channels * (bitsPerSample / 8));
}

describe('music generation settings and routing', () => {
  it('strips music command prefixes', () => {
    expect(stripMusicCommand('/music 30s calm lo-fi bgm')).toBe('30s calm lo-fi bgm');
    expect(stripMusicCommand('/音乐 一段赛博朋克配乐')).toBe('一段赛博朋克配乐');
  });

  it('extracts the requested duration from music prompts', () => {
    expect(musicDurationSecondsFromPrompt('生成3秒钟 金属武器打击碰撞声音')).toBe(3);
    expect(musicDurationSecondsFromPrompt('1分30秒 cinematic loop')).toBe(90);
    expect(musicDurationSecondsFromPrompt('0:45 upbeat hook')).toBe(45);
    expect(
      musicDurationSecondsFromPrompt(
        '3秒游戏战斗音效：快速挥砍破风 0.2 秒、主撞击爆发 0.4 秒、金属震颤衰减 2 秒',
      ),
    ).toBe(3);
  });

  it('normalizes persisted settings conservatively', () => {
    const settings = normalizeMusicGenerationSettings({
      enabled: false,
      preferredProviderId: 'beatoven-maestro',
      providerKeys: { 'beatoven-maestro': ' token ', unknown: 'x' },
      providerModels: { 'beatoven-maestro': ' maestro-loop ' },
    });
    expect(settings.enabled).toBe(false);
    expect(settings.preferredProviderId).toBe('beatoven-maestro');
    expect(settings.providerKeys['beatoven-maestro']).toBe('token');
    expect(settings.providerModels['beatoven-maestro']).toBe('maestro-loop');
  });

  it('checks ready providers and endpoint defaults', () => {
    const settings = {
      ...DEFAULT_MUSIC_GENERATION_SETTINGS,
      preferredProviderId: 'elevenlabs-music' as const,
      providerKeys: { 'beatoven-maestro': 'beatoven-key' },
    };
    expect(musicProviderReady('elevenlabs-music', settings)).toBe(false);
    expect(musicProviderReady('beatoven-maestro', settings)).toBe(true);
    expect(preferredReadyMusicProviderId(settings)).toBe('beatoven-maestro');
    expect(musicProviderBaseUrl('beatoven-maestro')).toBe('https://public-api.beatoven.ai');
    expect(musicProviderById('mubert').credentialUrl).toBe('https://mubert.com/api');
  });

  it('falls back to the configured Hugging Face provider when the default is not ready', () => {
    const settings = normalizeMusicGenerationSettings({
      preferredProviderId: 'elevenlabs-music',
      providerKeys: { 'huggingface-musicgen': 'hf_test' },
    });

    expect(settings.preferredProviderId).toBe('elevenlabs-music');
    expect(preferredReadyMusicProviderId(settings)).toBe('huggingface-musicgen');
    expect(musicProviderReady('local-music-server', settings)).toBe(false);
  });

  it('shares the Hugging Face token across free Hugging Face music providers', async () => {
    const settings = normalizeMusicGenerationSettings({
      preferredProviderId: 'huggingface-audioldm2',
      providerKeys: { 'huggingface-musicgen': 'hf_test' },
    });

    expect(musicProviderReady('huggingface-audioldm2', settings)).toBe(true);
    expect(musicProviderReady('huggingface-tango2', settings)).toBe(true);
    expect(musicProviderReady('huggingface-stable-audio', settings)).toBe(true);
    expect(preferredReadyMusicProviderId(settings)).toBe('huggingface-audioldm2');
  });

  it('splits music providers into commercial and free categories', () => {
    const commercial = MUSIC_PROVIDERS.filter(
      (provider) => provider.category === 'commercial',
    ).map((provider) => provider.id);
    const free = MUSIC_PROVIDERS.filter(
      (provider) => provider.category === 'free',
    ).map((provider) => provider.id);

    expect(commercial).toEqual([
      'elevenlabs-music',
      'google-lyria',
      'minimax-music',
      'stability-stable-audio',
      'beatoven-maestro',
      'mureka-song',
      'mureka-instrumental',
      'tempolor-song',
      'tempolor-instrumental',
      'mubert',
      'sunoapi-music',
      'sonauto-song',
      'sonauto-instrumental',
      'fal-ace-step',
      'fal-stable-audio',
      'minimax-302-music',
    ]);
    expect(free).toEqual([
      'minimax-music-free',
      'huggingface-musicgen',
      'huggingface-audioldm2',
      'huggingface-tango2',
      'huggingface-stable-audio',
      'local-ace-step',
      'local-diffrhythm',
      'local-yue',
      'local-stable-audio',
      'local-musicgen',
      'local-riffusion',
      'local-audioldm2',
      'local-tango2',
      'local-music-server',
    ]);
  });

  it('calls ElevenLabs music and parses JSON audio URLs', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          audio_url: 'https://example.com/song.mp3',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const result = await generateMusic(
      {
        prompt: '/music cinematic synthwave track',
        providerId: 'elevenlabs-music',
      },
      {
        ...DEFAULT_MUSIC_GENERATION_SETTINGS,
        providerKeys: { 'elevenlabs-music': 'test-key' },
        providerBaseUrls: {},
        providerModels: {},
      },
    );

    expect(result.prompt).toBe('cinematic synthwave track');
    expect(result.audios).toEqual(['https://example.com/song.mp3']);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.elevenlabs.io/v1/music',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'xi-api-key': 'test-key',
          'Content-Type': 'application/json',
        }),
      }),
    );
  });

  it('trims overlong returned audio to the requested duration', async () => {
    stubAudioDecoder(fakeAudioBuffer(5, 1000));
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            audio_url: 'https://example.com/long.mp3',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response('audio-bytes', {
          status: 200,
          headers: { 'content-type': 'audio/mpeg' },
        }),
      );

    const result = await generateMusic(
      {
        prompt: '/music 3秒钟 金属武器打击碰撞声音',
        providerId: 'elevenlabs-music',
      },
      {
        ...DEFAULT_MUSIC_GENERATION_SETTINGS,
        providerKeys: { 'elevenlabs-music': 'test-key' },
        providerBaseUrls: {},
        providerModels: {},
      },
    );

    expect(result.audios[0]).toMatch(/^data:audio\/wav;base64,/);
    expect(wavDurationSeconds(result.audios[0])).toBeCloseTo(3, 3);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://api.elevenlabs.io/v1/music',
      expect.objectContaining({
        body: expect.stringContaining('"music_length_ms":3000'),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://example.com/long.mp3',
      expect.any(Object),
    );
  });

  it('polls Beatoven until a composed track URL is available', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: 'started',
            task_id: 'task-1',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: 'composed',
            meta: {
              track_url: 'https://example.com/beatoven.mp3',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );

    const result = await generateMusic(
      {
        prompt: '/music peaceful podcast intro',
        providerId: 'beatoven-maestro',
      },
      {
        ...DEFAULT_MUSIC_GENERATION_SETTINGS,
        providerKeys: { 'beatoven-maestro': 'test-key' },
        providerBaseUrls: {},
        providerModels: {},
      },
    );

    expect(result.audios).toEqual(['https://example.com/beatoven.mp3']);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://public-api.beatoven.ai/api/v1/tracks/compose',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://public-api.beatoven.ai/api/v1/tasks/task-1',
      expect.objectContaining({ headers: expect.any(Object) }),
    );
  });

  it('calls Mureka instrumental generation through its async endpoint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'mureka-task-1',
          choices: [
            {
              url: 'https://example.com/mureka.mp3',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const result = await generateMusic(
      {
        prompt: '/music cinematic action bgm',
        providerId: 'mureka-instrumental',
      },
      {
        ...DEFAULT_MUSIC_GENERATION_SETTINGS,
        providerKeys: { 'mureka-song': 'mureka-key' },
        providerBaseUrls: {},
        providerModels: {},
      },
    );

    expect(result.audios).toEqual(['https://example.com/mureka.mp3']);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.mureka.ai/v1/instrumental/generate',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer mureka-key',
        }),
        body: JSON.stringify({
          model: 'mureka-8',
          prompt: 'cinematic action bgm',
          n: 1,
        }),
      }),
    );
  });

  it('calls TemPolor song generation with shared key settings', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 200000,
          message: 'success',
          data: {
            songs: [
              {
                status: 'succeeded',
                audio_url: 'https://example.com/tempolor.mp3',
              },
            ],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const result = await generateMusic(
      {
        prompt: '/music dream pop chorus',
        providerId: 'tempolor-song',
      },
      {
        ...DEFAULT_MUSIC_GENERATION_SETTINGS,
        providerKeys: { 'tempolor-song': 'Tempo-test' },
        providerBaseUrls: {},
        providerModels: {},
      },
    );

    expect(result.audios).toEqual(['https://example.com/tempolor.mp3']);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.tempolor.com/open-apis/v1/song/generate',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Tempo-test',
        }),
        body: JSON.stringify({
          prompt: 'dream pop chorus',
          model: 'TemPolor v4.6',
          lyrics: '[Verse]\ndream pop chorus\n\n[Chorus]\ndream pop chorus',
        }),
      }),
    );
  });

  it('calls Google Lyria through generateContent and parses inline audio', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    inlineData: {
                      mimeType: 'audio/wav',
                      data: 'YXVkaW8=',
                    },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const result = await generateMusic(
      {
        prompt: '/music upbeat electronic hook',
        providerId: 'google-lyria',
      },
      {
        ...DEFAULT_MUSIC_GENERATION_SETTINGS,
        providerKeys: { 'google-lyria': 'test-key' },
        providerBaseUrls: {},
        providerModels: {},
      },
    );

    expect(result.audios).toEqual(['data:audio/wav;base64,YXVkaW8=']);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://generativelanguage.googleapis.com/v1beta/models/lyria-3-clip-preview:generateContent',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-goog-api-key': 'test-key',
          'Content-Type': 'application/json',
        }),
      }),
    );
  });

  it('calls MiniMax music generation with the configured China-region endpoint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          base_resp: { status_code: 0, status_msg: 'success' },
          data: {
            audio_url: 'https://example.com/minimax.mp3',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const result = await generateMusic(
      {
        prompt: '/music 国风电子短配乐',
        providerId: 'minimax-music-free',
      },
      {
        ...DEFAULT_MUSIC_GENERATION_SETTINGS,
        providerKeys: { 'minimax-music-free': 'minimax-key' },
        providerBaseUrls: {},
        providerModels: {},
      },
    );

    expect(result.audios).toEqual(['https://example.com/minimax.mp3']);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.minimaxi.com/v1/music_generation',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer minimax-key',
        }),
        body: JSON.stringify({
          model: 'music-2.6-free',
          prompt: '国风电子短配乐',
          lyrics_optimizer: true,
          is_instrumental: true,
          output_format: 'url',
          audio_setting: {
            sample_rate: 44100,
            bitrate: 256000,
            format: 'mp3',
          },
        }),
      }),
    );
  });

  it('calls Hugging Face MusicGen through the official inference endpoint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          audio_url: 'https://example.com/musicgen.mp3',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const result = await generateMusic(
      {
        prompt: '/music ambient study track',
        providerId: 'huggingface-musicgen',
      },
      {
        ...DEFAULT_MUSIC_GENERATION_SETTINGS,
        providerKeys: { 'huggingface-musicgen': 'hf_test' },
        providerBaseUrls: {},
        providerModels: {},
      },
    );

    expect(result.audios).toEqual(['https://example.com/musicgen.mp3']);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api-inference.huggingface.co/models/facebook/musicgen-small',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer hf_test',
        }),
        body: JSON.stringify({
          inputs: 'ambient study track',
          parameters: {
            duration: 30,
          },
          options: {
            wait_for_model: true,
          },
        }),
      }),
    );
  });

  it('polls SunoAPI.org until generated audio is ready', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 200,
            data: {
              taskId: 'suno-task-1',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 200,
            data: {
              status: 'SUCCESS',
              response: {
                audio_url: 'https://example.com/suno.mp3',
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );

    const pending = generateMusic(
      {
        prompt: '/music upbeat city pop',
        providerId: 'sunoapi-music',
      },
      {
        ...DEFAULT_MUSIC_GENERATION_SETTINGS,
        providerKeys: { 'sunoapi-music': 'suno-key' },
        providerBaseUrls: {},
        providerModels: {},
      },
    );
    await vi.advanceTimersByTimeAsync(3000);
    const result = await pending;

    expect(result.audios).toEqual(['https://example.com/suno.mp3']);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://api.sunoapi.org/api/v1/generate',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer suno-key',
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://api.sunoapi.org/api/v1/generate/record-info?taskId=suno-task-1',
      expect.objectContaining({ headers: expect.any(Object) }),
    );
  });

  it('polls fal queue jobs and reads the result audio URL', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            request_id: 'fal-task-1',
            status_url: 'https://queue.fal.run/fal-ai/ace-step/requests/fal-task-1/status',
            response_url: 'https://queue.fal.run/fal-ai/ace-step/requests/fal-task-1',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: 'COMPLETED',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            audio: {
              url: 'https://example.com/fal.mp3',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );

    const pending = generateMusic(
      {
        prompt: '/music ambient synth loop',
        providerId: 'fal-ace-step',
      },
      {
        ...DEFAULT_MUSIC_GENERATION_SETTINGS,
        providerKeys: { 'fal-ace-step': 'fal-key' },
        providerBaseUrls: {},
        providerModels: {},
      },
    );
    await vi.advanceTimersByTimeAsync(3000);
    const result = await pending;

    expect(result.audios).toEqual(['https://example.com/fal.mp3']);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://queue.fal.run/fal-ai/ace-step',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Key fal-key',
        }),
        body: JSON.stringify({
          input: {
            prompt: 'ambient synth loop',
            lyrics: '[Instrumental]',
            duration: 30,
            output_format: 'mp3',
          },
        }),
      }),
    );
  });

  it('calls a configured local music HTTP endpoint without an API key', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          audio_url: 'http://127.0.0.1:7860/output/song.mp3',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const result = await generateMusic(
      {
        prompt: '/music 本地 ACE-Step 配乐',
        providerId: 'local-music-server',
      },
      {
        ...DEFAULT_MUSIC_GENERATION_SETTINGS,
        providerKeys: {},
        providerBaseUrls: { 'local-music-server': 'http://127.0.0.1:7860/generate' },
        providerModels: {},
      },
    );

    expect(result.audios).toEqual(['http://127.0.0.1:7860/output/song.mp3']);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:7860/generate',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
        }),
      }),
    );
  });

  it('calls configured local model preset endpoints independently', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          audio_url: 'http://127.0.0.1:7865/output/ace-step.mp3',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const result = await generateMusic(
      {
        prompt: '/music 本地 ACE-Step 流行歌',
        providerId: 'local-ace-step',
      },
      {
        ...DEFAULT_MUSIC_GENERATION_SETTINGS,
        providerKeys: {},
        providerBaseUrls: { 'local-ace-step': 'http://127.0.0.1:7865/generate' },
        providerModels: {},
      },
    );

    expect(result.model).toBe('ACE-Step-1.5');
    expect(result.audios).toEqual(['http://127.0.0.1:7865/output/ace-step.mp3']);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:7865/generate',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          prompt: '本地 ACE-Step 流行歌',
          model: 'ACE-Step-1.5',
          duration: 30,
          output_format: 'mp3',
        }),
      }),
    );
  });
});
