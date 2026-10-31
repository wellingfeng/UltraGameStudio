import { beforeEach, describe, expect, it, vi } from 'vitest';

const seams = vi.hoisted(() => ({
  complete: vi.fn(),
  generic: vi.fn(),
  cli: vi.fn(),
  selection: { adapter: 'codex' as const, modelClass: 'review', providerId: 'review', channelId: 'http' },
}));
vi.mock('@/lib/modelGateway/skillReviewGateway', () => ({
  createSkillReviewModelPort: vi.fn(() => ({ capability: 'completion-only', complete: seams.complete })),
}));
vi.mock('@/lib/modelGateway/modelGateway', () => ({
  resolveDirectGatewayRoute: () => ({ transport: 'openai-compatible' }),
  resolveCliGatewayRoute: seams.cli,
  completeGatewayText: seams.generic,
}));
vi.mock('@/lib/gatewayConfig', () => ({
  getExplicitActiveGatewaySelection: () => seams.selection,
  getDefaultGatewaySelection: () => seams.selection,
}));
import { makeReviewInvoker } from './memoryRefresh';
import { createReviewCompletionInvoker } from './modelGateway/reviewCompletionGateway';

beforeEach(() => {
  seams.complete.mockReset().mockRejectedValue(new Error('HTTP unavailable'));
  seams.generic.mockReset().mockRejectedValue(new Error('HTTP unavailable'));
  seams.cli.mockReset();
});

describe('memory review authority', () => {
  it('does not fall back to foreground completion when the pinned HTTP reviewer fails', async () => {
    const foreground = vi.fn().mockResolvedValue('foreground output');
    const invoke = makeReviewInvoker({ reviewPreferCheapModel: true, reviewModelSelection: seams.selection }, foreground);
    await expect(invoke('review', 'source')).rejects.toThrow('HTTP unavailable');
    expect(foreground).not.toHaveBeenCalled();
    expect(seams.generic).not.toHaveBeenCalled();
    expect(seams.cli).not.toHaveBeenCalled();
  });

  it('shares the hard call budget across digest, review and tagging', async () => {
    seams.complete.mockResolvedValue({ text: '无', usage: { inputTokens: 2, outputTokens: 1, estimated: false } });
    const invoke = createReviewCompletionInvoker(seams.selection, { maxCalls: 2 });
    await invoke('digest', 'source');
    await invoke('review', 'source');
    await expect(invoke('tagging', 'source')).rejects.toThrow('REVIEW_CALL_BUDGET');
    expect(seams.complete).toHaveBeenCalledTimes(2);
  });

  it('rejects an input outside the aggregate budget before dispatch', async () => {
    seams.complete.mockResolvedValue({ text: '无' });
    const invoke = createReviewCompletionInvoker(seams.selection, { maxInputTokens: 10 });
    await expect(invoke('review', 'x'.repeat(200))).rejects.toThrow('REVIEW_INPUT_BUDGET');
    expect(seams.complete).not.toHaveBeenCalled();
  });

  it('passes only the remaining output budget to later auxiliary stages', async () => {
    seams.complete.mockResolvedValue({ text: '无', usage: { inputTokens: 2, outputTokens: 3, estimated: false } });
    const invoke = createReviewCompletionInvoker(seams.selection, { maxOutputTokens: 5 });
    await invoke('digest', 'source');
    await invoke('review', 'source');
    expect(seams.complete.mock.calls[1][0].maxOutputTokens).toBe(2);
    await expect(invoke('tagging', 'source')).rejects.toThrow('REVIEW_OUTPUT_BUDGET');
  });

  it('ignores a late completion after cancellation and reports unknown interrupted output', async () => {
    let finish!: (value: { text: string }) => void;
    seams.complete.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const controller = new AbortController();
    const invoke = createReviewCompletionInvoker(seams.selection, { signal: controller.signal });
    const pending = invoke('review', 'source');
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    finish({ text: 'late write proposal' });
    await rejection;
    expect(invoke.usage).toMatchObject({ calls: 1, outputTokens: undefined, estimated: true });
  });

  it('bounds the entire auxiliary job when a model port ignores its timeout', async () => {
    seams.complete.mockImplementation(() => new Promise(() => {}));
    const invoke = createReviewCompletionInvoker(seams.selection, { timeoutMs: 30 });
    const observed = await Promise.race([
      invoke('review', 'source').catch((error: unknown) => error),
      new Promise((resolve) => setTimeout(() => resolve('hung'), 100)),
    ]);
    expect(observed).toMatchObject({ name: 'TimeoutError' });
  });

  it('redacts and bounds transcript text before the reviewer receives it', async () => {
    seams.complete.mockResolvedValue({ text: '无' });
    const invoke = createReviewCompletionInvoker(seams.selection);
    await invoke('review', 'Authorization: Bearer fixture-value\n' + 'x'.repeat(100000));
    const sent = seams.complete.mock.calls[0][0].userContent;
    expect(sent).toContain('[REDACTED]');
    expect(sent).not.toContain('fixture-value');
    expect(sent.length).toBeLessThanOrEqual(48000);
  });

  it.each(['maxCalls', 'maxInputTokens', 'maxOutputTokens', 'timeoutMs'] as const)('rejects non-finite %s instead of bypassing its hard limit', (key) => {
    expect(() => createReviewCompletionInvoker(seams.selection, { [key]: Number.NaN })).toThrow('REVIEW_INVALID_BUDGET');
  });
});
