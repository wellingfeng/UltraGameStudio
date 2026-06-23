import { afterEach, describe, expect, it, vi } from 'vitest';

import { CAPTAIN_LOOP_GUIDANCE, UNIFIED_SYSTEM, streamAnthropic } from './anthropic';

function mockAnthropicStream(text: string): Response {
  const sse =
    `data: {"type":"content_block_delta","delta":{"type":"text_delta","text":${JSON.stringify(text)}}}\n\n` +
    'data: [DONE]\n\n';
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sse));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/**
 * Captain-loop guidance — the generation-layer accuracy lever. These tests pin
 * that the guidance is present, names the concrete primitives the model must
 * emit, and is actually wired into the unified system prompt (a guidance string
 * defined but never injected would silently do nothing).
 */
describe('CAPTAIN_LOOP_GUIDANCE', () => {
  it('names the captain-loop primitives', () => {
    expect(CAPTAIN_LOOP_GUIDANCE).toContain('TASK_LEDGER');
    expect(CAPTAIN_LOOP_GUIDANCE).toContain('VERDICT');
    expect(CAPTAIN_LOOP_GUIDANCE).toContain('adversarial');
    expect(CAPTAIN_LOOP_GUIDANCE).toContain('workflow-manager');
    expect(CAPTAIN_LOOP_GUIDANCE).toContain('队长闭环');
  });

  it('scopes when to use it (complex) and when not (simple)', () => {
    // Mentions the gating signal and the "don't over-apply" guard.
    expect(CAPTAIN_LOOP_GUIDANCE).toMatch(/复杂|可拆|高风险/);
    expect(CAPTAIN_LOOP_GUIDANCE).toMatch(/简单|单步|低风险/);
  });

  it('is injected into UNIFIED_SYSTEM', () => {
    expect(UNIFIED_SYSTEM).toContain(CAPTAIN_LOOP_GUIDANCE);
  });
});

describe('streamAnthropic multimodal content', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function bodyOf(fetchMock: ReturnType<typeof vi.fn>) {
    return JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
  }

  it('sends a plain string content when no images are attached', async () => {
    const fetchMock = vi.fn(async () => mockAnthropicStream('ok'));
    vi.stubGlobal('fetch', fetchMock);
    await streamAnthropic({ apiKey: 'k', system: 's', userContent: 'hello' });
    expect(bodyOf(fetchMock).messages[0].content).toBe('hello');
  });

  it('emits an image block for data URLs and keeps the text block', async () => {
    const fetchMock = vi.fn(async () => mockAnthropicStream('ok'));
    vi.stubGlobal('fetch', fetchMock);
    await streamAnthropic({
      apiKey: 'k',
      system: 's',
      userContent: 'judge this',
      userImages: ['data:image/png;base64,AAAA'],
    });
    const content = bodyOf(fetchMock).messages[0].content;
    expect(Array.isArray(content)).toBe(true);
    expect(content[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
    });
    expect(content[1]).toEqual({ type: 'text', text: 'judge this' });
  });

  it('emits a url image block for http(s) sources', async () => {
    const fetchMock = vi.fn(async () => mockAnthropicStream('ok'));
    vi.stubGlobal('fetch', fetchMock);
    await streamAnthropic({
      apiKey: 'k',
      system: 's',
      userContent: 't',
      userImages: ['https://example.com/a.png', 'not-an-image'],
    });
    const content = bodyOf(fetchMock).messages[0].content;
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({
      type: 'image',
      source: { type: 'url', url: 'https://example.com/a.png' },
    });
  });
});
