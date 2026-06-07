import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultBlueprint } from '@/core/defaultBlueprint';
import type { IRGraph } from '@/core/ir';
import {
  DEFAULT_IMAGE_GENERATION_SETTINGS,
  type ImageGenerationSettings,
} from '@/lib/imageGeneration';
import { useStore } from './useStore';

const IMAGE_SETTINGS_KEY = 'freeultracode.imageGeneration.v1';

function cloneGraph(graph: IRGraph): IRGraph {
  return JSON.parse(JSON.stringify(graph)) as IRGraph;
}

function writeImageSettings(partial: Partial<ImageGenerationSettings>): void {
  window.localStorage.setItem(
    IMAGE_SETTINGS_KEY,
    JSON.stringify({ ...DEFAULT_IMAGE_GENERATION_SETTINGS, ...partial }),
  );
}

function resetStore(): void {
  useStore.setState({
    workflow: cloneGraph(defaultBlueprint('Image workflow')),
    selectedNodeId: null,
    mode: 'design',
    aiStreaming: false,
    aiEditingSessions: [],
    dirty: false,
    currentFilePath: null,
    messages: [],
    composerDraft: '',
    composerDrafts: {},
    activeSessionId: null,
    activeWorkspaceId: null,
    historyReady: false,
    sessions: [],
    sessionTree: {},
    runState: {},
    runOutputs: {},
    lastRunFailedNodeId: null,
  });
}

async function waitFor(
  condition: () => boolean,
  description: string,
): Promise<void> {
  const deadline = Date.now() + 1500;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for ${description}\n` +
          `messages=${JSON.stringify(useStore.getState().messages, null, 2)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

beforeEach(() => {
  resetStore();
});

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  resetStore();
});

describe('image generation chat flow', () => {
  it('routes /image through the provider and renders the returned image', async () => {
    writeImageSettings({
      enabled: true,
      preferredProviderId: 'minimax',
      providerKeys: { minimax: 'test-key' },
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: { image_urls: ['https://example.com/generated.png'] },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    useStore.getState().generateImagePrompt('/image 一张赛博朋克海报');

    await waitFor(() => {
      const assistant = useStore
        .getState()
        .messages.find((message) => message.role === 'assistant');
      return !!assistant && assistant.text.includes('图片生成完成');
    }, 'image generation to finish');

    const messages = useStore.getState().messages;
    const user = messages.find((message) => message.role === 'user');
    const assistant = messages.find((message) => message.role === 'assistant');

    expect(user?.text).toBe('/image 一张赛博朋克海报');
    expect(assistant?.text).toContain('MiniMax 海螺');
    expect(assistant?.text).toContain('一张赛博朋克海报');
    expect(assistant?.text).toContain(
      '![生成图片 1](https://example.com/generated.png)',
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.minimax.io/v1/image_generation',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('surfaces a friendly failure when the provider errors', async () => {
    writeImageSettings({
      enabled: true,
      preferredProviderId: 'minimax',
      providerKeys: { minimax: 'test-key' },
    });
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response('rate limited', {
          status: 429,
          statusText: 'Too Many Requests',
        }),
      );

    useStore.getState().generateImagePrompt('/image 一只柴犬');

    await waitFor(() => {
      const assistant = useStore
        .getState()
        .messages.find((message) => message.role === 'assistant');
      return !!assistant && assistant.text.includes('图片生成失败');
    }, 'image generation failure message');

    const assistant = useStore
      .getState()
      .messages.find((message) => message.role === 'assistant');
    expect(assistant?.text).toContain('请在设置 > 生图中配置可用的图片 Provider');
    expect(fetchMock).toHaveBeenCalled();
  });

  it('does not auto-route natural-language image intent through sendPrompt', async () => {
    // Image generation is now explicit-only (the /image-mode-start sticky mode). A
    // natural-language message that merely mentions generating an image must
    // NOT be hijacked into the image provider — it stays an AI-editing prompt.
    writeImageSettings({
      enabled: true,
      preferredProviderId: 'minimax',
      providerKeys: { minimax: 'test-key' },
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: { image_urls: ['https://example.com/poster.png'] },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    useStore.getState().sendPrompt('帮我生成一张山水画海报');

    // Give any mistaken async image turn a chance to fire before asserting.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(fetchMock).not.toHaveBeenCalledWith(
      'https://api.minimax.io/v1/image_generation',
      expect.objectContaining({ method: 'POST' }),
    );
    const assistant = useStore
      .getState()
      .messages.find((message) => message.role === 'assistant');
    expect(assistant?.text ?? '').not.toContain('图片生成完成');
  });
});
