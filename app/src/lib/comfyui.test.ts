import { describe, expect, it, afterEach } from 'vitest';
import {
  parseComfyGraph,
  stringifyComfyGraph,
  stripComfyCommand,
  comfyViewUrl,
  loadComfyUiSettings,
  comfyBaseUrl,
  comfyApiKey,
  comfyAuthHeaders,
  type ComfyPromptGraph,
} from './comfyui';
import {
  saveImageGenerationSettings,
  DEFAULT_IMAGE_GENERATION_SETTINGS,
} from './imageGeneration';

const SAMPLE: ComfyPromptGraph = {
  '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sd_xl.safetensors' } },
  '2': { class_type: 'CLIPTextEncode', inputs: { text: 'a cat', clip: ['1', 1] } },
  '3': { class_type: 'SaveImage', inputs: { images: ['2', 0] } },
};

describe('parseComfyGraph', () => {
  it('parses a bare prompt-map body', () => {
    const graph = parseComfyGraph(JSON.stringify(SAMPLE));
    expect(graph).not.toBeNull();
    expect(Object.keys(graph!)).toHaveLength(3);
    expect(graph!['2'].class_type).toBe('CLIPTextEncode');
  });

  it('unwraps a {prompt: ...} wrapper', () => {
    const graph = parseComfyGraph(JSON.stringify({ prompt: SAMPLE }));
    expect(graph).not.toBeNull();
    expect(graph!['1'].class_type).toBe('CheckpointLoaderSimple');
  });

  it('unwraps a {workflow: ...} wrapper', () => {
    const graph = parseComfyGraph(JSON.stringify({ workflow: SAMPLE }));
    expect(graph).not.toBeNull();
    expect(Object.keys(graph!)).toHaveLength(3);
  });

  it('returns null for invalid JSON', () => {
    expect(parseComfyGraph('{ not json')).toBeNull();
  });

  it('returns null for an empty object', () => {
    expect(parseComfyGraph('{}')).toBeNull();
  });

  it('returns null when nodes lack class_type', () => {
    expect(parseComfyGraph(JSON.stringify({ '1': { inputs: {} } }))).toBeNull();
  });

  it('round-trips through stringify', () => {
    const body = stringifyComfyGraph(SAMPLE);
    expect(parseComfyGraph(body)).toEqual(SAMPLE);
  });
});

describe('stripComfyCommand', () => {
  it('strips the mode-start marker', () => {
    expect(stripComfyCommand('/comfyui-mode-start a red car')).toBe('a red car');
  });

  it('strips a bare /comfyui prefix', () => {
    expect(stripComfyCommand('/comfy a red car')).toBe('a red car');
  });

  it('leaves plain text untouched', () => {
    expect(stripComfyCommand('a red car')).toBe('a red car');
  });
});

describe('comfyViewUrl', () => {
  it('builds a /view URL with filename, subfolder, and type', () => {
    const url = comfyViewUrl('http://127.0.0.1:8188', {
      filename: 'out.png',
      subfolder: 'batch',
      type: 'output',
    });
    expect(url).toContain('/view?');
    expect(url).toContain('filename=out.png');
    expect(url).toContain('subfolder=batch');
    expect(url).toContain('type=output');
  });
});

describe('loadComfyUiSettings', () => {
  it('falls back to the local default base URL', () => {
    expect(loadComfyUiSettings().baseUrl).toBe('http://127.0.0.1:8188');
  });
});

describe('comfyBaseUrl (shared image channel)', () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it('falls back to the localhost default when nothing is configured', () => {
    expect(comfyBaseUrl()).toBe('http://127.0.0.1:8188');
  });

  it('uses the image-generation ComfyUI channel base URL by default', () => {
    saveImageGenerationSettings({
      ...DEFAULT_IMAGE_GENERATION_SETTINGS,
      providerBaseUrls: { 'local-comfyui': 'https://comfy.example.com/' },
    });
    expect(comfyBaseUrl()).toBe('https://comfy.example.com');
  });

  it('lets an explicit standalone ComfyUI setting override the channel', () => {
    saveImageGenerationSettings({
      ...DEFAULT_IMAGE_GENERATION_SETTINGS,
      providerBaseUrls: { 'local-comfyui': 'https://channel.example.com' },
    });
    window.localStorage.setItem(
      'freeultracode.comfyui.v1',
      JSON.stringify({ baseUrl: 'https://override.example.com' }),
    );
    expect(comfyBaseUrl()).toBe('https://override.example.com');
  });

  it('reads the channel API key for authenticated remote endpoints', () => {
    saveImageGenerationSettings({
      ...DEFAULT_IMAGE_GENERATION_SETTINGS,
      providerKeys: { 'local-comfyui': 'sk-remote-123' },
    });
    expect(comfyApiKey()).toBe('sk-remote-123');
    expect(comfyAuthHeaders('sk-remote-123')).toEqual({
      Authorization: 'Bearer sk-remote-123',
    });
  });

  it('emits no auth header when no key is set', () => {
    expect(comfyAuthHeaders('')).toEqual({});
  });
});
