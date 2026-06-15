import { beforeEach, describe, expect, it } from 'vitest';
import {
  preferRicherSnapshot,
  readUsageMeterSnapshot,
  rebuildSnapshotFromTurns,
  recordModelUsageForRoute,
  recordEstimatedModelUsageForSelection,
  sessionCachePercent,
  usageReportFromCliUsage,
  usageReportFromCodex,
  usageReportFromOpenAI,
  usageTurnFromSnapshots,
} from './usageMeter';

const selection = {
  adapter: 'claude-code',
  modelClass: 'sonnet',
} as const;

describe('usage meter', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('persists token totals per session context', () => {
    recordEstimatedModelUsageForSelection(
      selection,
      'hello from session one',
      'reply one',
      { providerName: 'DeepSeek', model: 'deepseek-chat' },
      { context: { workspaceId: 'w1', sessionId: 's1' } },
    );
    recordEstimatedModelUsageForSelection(
      selection,
      'hello from session two '.repeat(20),
      'reply two '.repeat(20),
      { providerName: 'DeepSeek', model: 'deepseek-chat' },
      { context: { workspaceId: 'w1', sessionId: 's2' } },
    );

    const s1 = readUsageMeterSnapshot({ workspaceId: 'w1', sessionId: 's1' });
    const s2 = readUsageMeterSnapshot({ workspaceId: 'w1', sessionId: 's2' });

    expect(s1.totals.calls).toBe(1);
    expect(s2.totals.calls).toBe(1);
    expect(s1.totals.totalTokens).toBeGreaterThan(0);
    expect(s2.totals.totalTokens).toBeGreaterThan(s1.totals.totalTokens);
  });

  it('keeps sessions separate from the global fallback bucket', () => {
    recordEstimatedModelUsageForSelection(selection, 'global', 'reply');
    recordEstimatedModelUsageForSelection(
      selection,
      'session',
      'reply',
      { providerName: 'DeepSeek', model: 'deepseek-chat' },
      { context: { workspaceId: 'w1', sessionId: 's1' } },
    );

    expect(readUsageMeterSnapshot().totals.calls).toBe(1);
    expect(readUsageMeterSnapshot({ workspaceId: 'w1', sessionId: 's1' }).totals.calls)
      .toBe(1);
    expect(readUsageMeterSnapshot({ workspaceId: 'w1', sessionId: 's2' }).totals.calls)
      .toBe(0);
  });

  it('falls back to the default-workspace bucket when a session gains a workspace id later', () => {
    recordEstimatedModelUsageForSelection(
      selection,
      'created before workspace resolved',
      'reply',
      { providerName: 'Claude Code', model: 'sonnet' },
      { context: { sessionId: 's1' } },
    );

    const snapshot = readUsageMeterSnapshot({
      workspaceId: 'w1',
      sessionId: 's1',
    });

    expect(snapshot.totals.calls).toBe(1);
    expect(snapshot.totals.totalTokens).toBeGreaterThan(0);
  });

  it('records OpenAI-compatible cached token usage as real data', () => {
    const report = usageReportFromOpenAI({
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      prompt_tokens_details: { cached_tokens: 64 },
    });

    recordModelUsageForRoute(
      { providerName: 'OpenAI', model: 'gpt-5.1' },
      report!,
      { estimated: false, context: { workspaceId: 'w1', sessionId: 's1' } },
    );

    const snapshot = readUsageMeterSnapshot({ workspaceId: 'w1', sessionId: 's1' });
    expect(snapshot.lastCall.estimated).toBe(false);
    expect(snapshot.lastCall.cachedInputTokens).toBe(64);
    expect(snapshot.lastCall.cachePercent).toBe(64);
  });

  it('records Codex CLI cached token usage as real data', () => {
    const report = usageReportFromCodex({
      input_tokens: 22451,
      cached_input_tokens: 11648,
      output_tokens: 28,
      reasoning_output_tokens: 21,
    });

    recordModelUsageForRoute(
      { providerName: 'KuroAI', model: 'gpt-5.5' },
      report!,
      { estimated: false, context: { workspaceId: 'w1', sessionId: 's1' } },
    );

    const snapshot = readUsageMeterSnapshot({ workspaceId: 'w1', sessionId: 's1' });
    expect(snapshot.lastCall.estimated).toBe(false);
    expect(snapshot.lastCall.inputTokens).toBe(22451);
    expect(snapshot.lastCall.cachedInputTokens).toBe(11648);
    expect(snapshot.lastCall.cachePercent).toBeCloseTo(51.88, 2);
  });

  it('folds Anthropic CLI cache hits back into the input total', () => {
    // claude stream-json reports input_tokens as the *uncached* prefix only;
    // the cached prefix lives in cache_read/cache_creation.
    const report = usageReportFromCliUsage({
      input_tokens: 120,
      output_tokens: 40,
      cache_read_input_tokens: 800,
      cache_creation_input_tokens: 80,
    });

    expect(report).not.toBeNull();
    // 120 + 800 + 80 folded into a single input total.
    expect(report!.inputTokens).toBe(1000);

    recordModelUsageForRoute(
      { providerName: 'Anthropic', model: 'claude-sonnet-4' },
      report!,
      { estimated: false, context: { workspaceId: 'w1', sessionId: 's1' } },
    );

    const snapshot = readUsageMeterSnapshot({ workspaceId: 'w1', sessionId: 's1' });
    expect(snapshot.lastCall.estimated).toBe(false);
    expect(snapshot.lastCall.inputTokens).toBe(1000);
    expect(snapshot.lastCall.cachedInputTokens).toBe(880);
    expect(snapshot.lastCall.cachePercent).toBeCloseTo(88, 2);
  });

  it('treats Codex CLI input_tokens as already inclusive of the cached portion', () => {
    const report = usageReportFromCliUsage({
      input_tokens: 22451,
      cached_input_tokens: 11648,
      output_tokens: 28,
    });

    expect(report).not.toBeNull();
    // No cache_read/creation keys -> Codex style, input stays as reported.
    expect(report!.inputTokens).toBe(22451);
    expect(report!.cacheReadInputTokens).toBe(11648);
  });

  it('reads nested CLI usage payloads from newer JSON event shapes', () => {
    const report = usageReportFromCliUsage({
      total_token_usage: {
        input_tokens: 1000,
        output_tokens: 50,
        input_tokens_details: { cached_tokens: 640 },
      },
    });

    expect(report).not.toBeNull();
    expect(report!.inputTokens).toBe(1000);
    expect(report!.outputTokens).toBe(50);
    expect(report!.totalTokens).toBe(1050);
    expect(report!.cacheReadInputTokens).toBe(640);
  });

  it('returns null for usage payloads without recognizable token counts', () => {
    expect(usageReportFromCliUsage(null)).toBeNull();
    expect(usageReportFromCliUsage({})).toBeNull();
    expect(usageReportFromCliUsage({ some: 'thing' })).toBeNull();
  });

  it('computes the session cache percent from real calls only', () => {
    const ctx = { workspaceId: 'w1', sessionId: 's1' };

    // An estimated turn first: it must not pollute the session cache ratio.
    recordEstimatedModelUsageForSelection(
      selection,
      'estimate me '.repeat(50),
      'reply',
      { providerName: 'DeepSeek', model: 'deepseek-chat' },
      { context: ctx },
    );
    expect(sessionCachePercent(readUsageMeterSnapshot(ctx))).toBeNull();

    // Then a real call with a known cache hit.
    recordModelUsageForRoute(
      { providerName: 'OpenAI', model: 'gpt-5.1' },
      usageReportFromOpenAI({
        prompt_tokens: 200,
        completion_tokens: 20,
        total_tokens: 220,
        prompt_tokens_details: { cached_tokens: 150 },
      })!,
      { estimated: false, context: ctx },
    );

    // 150 / 200 = 75%, unaffected by the earlier estimated turn.
    expect(sessionCachePercent(readUsageMeterSnapshot(ctx))).toBeCloseTo(75, 5);
  });

  it('derives per-turn token usage from the snapshot delta', () => {
    const ctx = { workspaceId: 'w1', sessionId: 's1' };
    const before = readUsageMeterSnapshot(ctx);

    recordModelUsageForRoute(
      { providerName: 'OpenAI', model: 'gpt-5.1' },
      usageReportFromOpenAI({
        prompt_tokens: 100,
        completion_tokens: 30,
        total_tokens: 130,
        prompt_tokens_details: { cached_tokens: 40 },
      })!,
      { estimated: false, context: ctx },
    );
    // A second sub-call in the same turn (e.g. a follow-up generation).
    recordModelUsageForRoute(
      { providerName: 'OpenAI', model: 'gpt-5.1' },
      usageReportFromOpenAI({
        prompt_tokens: 100,
        completion_tokens: 10,
        total_tokens: 110,
        prompt_tokens_details: { cached_tokens: 60 },
      })!,
      { estimated: false, context: ctx },
    );

    const delta = usageTurnFromSnapshots(before, readUsageMeterSnapshot(ctx));
    expect(delta.inputTokens).toBe(200);
    expect(delta.outputTokens).toBe(40);
    expect(delta.totalTokens).toBe(240);
    expect(delta.cachedInputTokens).toBe(100);
    expect(delta.cachePercent).toBeCloseTo(50, 5);
    expect(delta.estimated).toBe(false);
  });

  it('flags an estimated-only turn delta as estimated', () => {
    const ctx = { workspaceId: 'w1', sessionId: 's1' };
    const before = readUsageMeterSnapshot(ctx);
    recordEstimatedModelUsageForSelection(
      selection,
      'just an estimate',
      'reply text',
      { providerName: 'DeepSeek', model: 'deepseek-chat' },
      { context: ctx },
    );
    const delta = usageTurnFromSnapshots(before, readUsageMeterSnapshot(ctx));
    expect(delta.totalTokens).toBeGreaterThan(0);
    expect(delta.estimated).toBe(true);
    expect(delta.cachePercent).toBe(0);
  });

  it('rebuilds a session snapshot from persisted message turns', () => {
    const snapshot = rebuildSnapshotFromTurns([
      undefined,
      {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        cachedInputTokens: 40,
        cachePercent: 40,
        estimated: false,
      },
      {
        inputTokens: 50,
        outputTokens: 10,
        totalTokens: 60,
        cachedInputTokens: 0,
        cachePercent: 0,
        estimated: true,
      },
    ]);
    expect(snapshot.totals.calls).toBe(2);
    expect(snapshot.totals.totalTokens).toBe(180);
    expect(snapshot.totals.inputTokens).toBe(150);
    // Cache % counts real turns only: 40 cached / 100 real input.
    expect(sessionCachePercent(snapshot)).toBeCloseTo(40, 5);
  });

  it('returns null cache % when rebuilt from estimated-only turns', () => {
    const snapshot = rebuildSnapshotFromTurns([
      {
        inputTokens: 80,
        outputTokens: 10,
        totalTokens: 90,
        cachedInputTokens: 0,
        cachePercent: 0,
        estimated: true,
      },
    ]);
    expect(snapshot.totals.totalTokens).toBe(90);
    expect(sessionCachePercent(snapshot)).toBeNull();
  });

  it('prefers whichever snapshot carries more tokens', () => {
    const live = rebuildSnapshotFromTurns([
      {
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
        cachedInputTokens: 0,
        cachePercent: 0,
        estimated: false,
      },
    ]);
    const rebuilt = rebuildSnapshotFromTurns([
      {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        cachedInputTokens: 0,
        cachePercent: 0,
        estimated: false,
      },
    ]);
    expect(preferRicherSnapshot(live, rebuilt)).toBe(rebuilt);
    expect(preferRicherSnapshot(rebuilt, live)).toBe(rebuilt);
  });
});
