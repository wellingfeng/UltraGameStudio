import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runConsolidatingReview } from './memoryConsolidate';
import {
  DIGEST_SYSTEM,
  joinDigestAndTail,
  splitTranscriptForDigest,
} from '@/core/memoryReview';
import { applyMemoryOp, loadMemory, readMemoryBase } from './memoryStore';

beforeEach(async () => {
  window.localStorage.clear();
});

const longMessages = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    text: `第${i}条：这是一段足够长的对话内容，用来撑爆转录预算的 filler-${i}-${'x'.repeat(200)}`,
  }));

afterEach(() => vi.restoreAllMocks());

describe('memoryConsolidate approvalMode queue (M2)', () => {
  it('reports a committed target honestly when cancellation blocks the second separate library', async () => {
    const controller = new AbortController();
    const original = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      original.call(this, key, value);
      if (key.endsWith('user.json')) controller.abort();
    });
    const run = runConsolidatingReview({ transcript: 'source', signal: controller.signal,
      invokeModel: async () => '<<UGS_MEMORY>>{"target":"user","operations":[{"action":"add","content":"committed user"}]}<<UGS_MEMORY_END>>' +
        '<<UGS_MEMORY>>{"target":"memory","operations":[{"action":"add","content":"not dispatched"}]}<<UGS_MEMORY_END>>' });
    const result = await run;
    expect(result.appliedOps).toBe(1);
    expect(result.lastErrors.join()).toMatch(/cancel/i);
    expect((await loadMemory('user')).map((e) => e.text)).toEqual(['committed user']);
    expect(await loadMemory('memory')).toEqual([]);
  });

  it('does not ask the model to retry a host CAS conflict', async () => {
    const invokeModel = vi.fn(async () => {
      await applyMemoryOp('user', { action: 'add', content: 'external edit' });
      return '<<UGS_MEMORY>>{"target":"user","operations":[{"action":"add","content":"stale proposal"}]}<<UGS_MEMORY_END>>';
    });
    const out = await runConsolidatingReview({ transcript: 'source', invokeModel });
    expect(invokeModel).toHaveBeenCalledTimes(1);
    expect(out.lastErrors.join()).toMatch(/conflict/i);
    expect((await loadMemory('user')).map((e) => e.text)).toEqual(['external edit']);
  });

  it('treats multiple blocks for one target as one atomic proposal', async () => {
    const out = await runConsolidatingReview({ transcript: 'source', unattended: false, maxRetries: 0,
      invokeModel: async () => '<<UGS_MEMORY>>{"target":"user","operations":[{"action":"add","content":"must not land"}]}<<UGS_MEMORY_END>>' +
        '<<UGS_MEMORY>>{"target":"user","operations":[{"action":"remove","oldText":"missing"}]}<<UGS_MEMORY_END>>' });
    expect(out.appliedOps).toBe(0);
    expect(await loadMemory('user')).toEqual([]);
  });

  it('cancels a review waiting for the pending queue lock without staging', async () => {
    const { withMemoryLock } = await import('./memoryTransactions');
    let entered!: () => void; let release!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const blocker = withMemoryLock('memories/pending.json', () => new Promise<void>((resolve) => { release = resolve; entered(); }));
    await ready;
    const controller = new AbortController();
    const run = runConsolidatingReview({ transcript: 'source', signal: controller.signal, approvalMode: 'queue',
      invokeModel: async () => {
        setTimeout(() => { controller.abort(); release(); }, 0);
        return '<<UGS_MEMORY>>{"target":"user","operations":[{"action":"add","content":"late batch"}]}<<UGS_MEMORY_END>>';
      } });
    await expect(run).rejects.toThrow(/cancel|abort/i); await blocker;
    const { listPendingMemoryWrites } = await import('./memoryPending');
    expect(await listPendingMemoryWrites()).toEqual([]);
  });

  it('freezes the original source and base before invoking the model', async () => {
    await applyMemoryOp('memory', { action: 'add', content: 'original' }, 'A');
    const base = await readMemoryBase('memory', 'A');
    const source = { hostId: 'desktop', namespaceId: 'local', workspaceId: 'A', sessionId: 's', turnId: 't', sourceMessageId: 'm', runId: 'r' };
    const opts = { transcript: 'source', workspaceId: 'A', reviewSource: source, bases: { memory: base }, approvalMode: 'queue' as const,
      invokeModel: async () => {
        opts.workspaceId = 'B'; source.workspaceId = 'B'; base.raw = null;
        await applyMemoryOp('memory', { action: 'add', content: 'later edit' }, 'A');
        return '<<UGS_MEMORY>>{"target":"memory","operations":[{"action":"remove","oldText":"original"}]}<<UGS_MEMORY_END>>';
      } };
    await runConsolidatingReview(opts);
    const { listPendingMemoryWrites, resolvePendingMemoryWrites } = await import('./memoryPending');
    const pending = await listPendingMemoryWrites();
    expect(pending[0].workspaceId).toBe('A');
    expect(pending[0].reviewSource?.workspaceId).toBe('A');
    expect(pending[0].base?.raw).not.toBeNull();
    const resolved = await resolvePendingMemoryWrites([pending[0].id], 'approve', 'B');
    expect(resolved.outcomes[0].status).toBe('conflicted');
    expect((await loadMemory('memory', 'A')).map((e) => e.text)).toEqual(['original', 'later edit']);
  });

  it('queues an unattended destructive batch even when direct mode was selected', async () => {
    await applyMemoryOp('memory', { action: 'add', content: 'keep original' }, 'A');
    const out = await runConsolidatingReview({ transcript: 'source', workspaceId: 'A', approvalMode: 'direct',
      invokeModel: async () => '<<UGS_MEMORY>>{"target":"memory","operations":[{"action":"remove","oldText":"keep original"},{"action":"add","content":"replacement"}]}<<UGS_MEMORY_END>>' });
    expect(out.appliedOps).toBe(0);
    expect(out.queuedOps).toBe(2);
    expect((await loadMemory('memory', 'A')).map((e) => e.text)).toEqual(['keep original']);
  });

  it('stages proposals into the pending queue instead of the store', async () => {
    const invokeModel = vi
      .fn()
      .mockResolvedValue(
        '<<UGS_MEMORY>>\n{"target":"user","operations":[{"action":"add","content":"待审批的事实"}]}\n<<UGS_MEMORY_END>>',
      );
    const out = await runConsolidatingReview({
      invokeModel,
      transcript: '用户：x\n助手：y',
      approvalMode: 'queue',
      source: 'review',
    });
    expect(out.queuedOps).toBe(1);
    expect(out.appliedOps).toBe(0); // staged, not applied
    expect(await loadMemory('user')).toHaveLength(0); // NOT applied
    const { listPendingMemoryWrites, resolvePendingMemoryWrites } = await import(
      './memoryPending'
    );
    const pending = await listPendingMemoryWrites();
    expect(pending).toHaveLength(1);
    expect(pending[0].source).toBe('review');
    await resolvePendingMemoryWrites([pending[0].id], 'reject');
  });

  it('never dispatches a late proposal after the review signal is cancelled', async () => {
    const controller = new AbortController();
    const opts = { invokeModel: async () => {
      controller.abort();
      return '<<UGS_MEMORY>>{"target":"user","operations":[{"action":"add","content":"late"}]}<<UGS_MEMORY_END>>';
    }, transcript: 'user source', signal: controller.signal };
    await expect(runConsolidatingReview(opts)).rejects.toThrow(/abort|cancel/i);
    expect(await loadMemory('user')).toEqual([]);
    const { listPendingMemoryWrites } = await import('./memoryPending');
    expect(await listPendingMemoryWrites()).toEqual([]);
  });

  it('still applies directly in the default mode', async () => {
    const invokeModel = vi
      .fn()
      .mockResolvedValue(
        '<<UGS_MEMORY>>\n{"target":"user","operations":[{"action":"add","content":"直写事实"}]}\n<<UGS_MEMORY_END>>',
      );
    const out = await runConsolidatingReview({
      invokeModel,
      transcript: '用户：x',
    });
    expect(out.queuedOps).toBe(0);
    expect(out.appliedOps).toBe(1);
    expect((await loadMemory('user')).map((e) => e.text)).toContain('直写事实');
  });
});

describe('memoryConsolidate digest replay (M3)', () => {
  it('shares the review budget owner with digest even when a legacy summarizer differs', async () => {
    const invokeModel = vi.fn(async (system: string) => system === DIGEST_SYSTEM ? 'shared digest' : '无');
    const legacySummarizer = vi.fn(async () => 'unsafe independent digest');
    await runConsolidatingReview({ invokeModel, transcript: '', messages: longMessages(40), summarize: legacySummarizer });
    expect(legacySummarizer).not.toHaveBeenCalled();
    expect(invokeModel).toHaveBeenCalledTimes(2);
    expect(invokeModel.mock.calls[0][0]).toBe(DIGEST_SYSTEM);
  });

  it('compresses the overflow head and prepends the digest', async () => {
    const digestText = '事实A；事实B';
    const invokeModel = vi
      .fn()
      .mockImplementation(async (system: string) => {
        if (system === DIGEST_SYSTEM) return digestText;
        return '无'; // review sees digest+tail, finds nothing new
      });
    await runConsolidatingReview({
      invokeModel,
      transcript: '',
      messages: longMessages(40),
      summarize: invokeModel,
    });
    const reviewCall = invokeModel.mock.calls.find((c) => c[0] !== DIGEST_SYSTEM)!;
    expect(reviewCall[1]).toContain('（较早对话摘要）');
    expect(reviewCall[1]).toContain(digestText);
    expect(reviewCall[1]).toContain('（近期对话原文）');
  });

  it('falls back to the plain transcript when digest fails', async () => {
    const invokeModel = vi
      .fn()
      .mockImplementation(async (system: string) => {
        if (system === DIGEST_SYSTEM) throw new Error('digest model down');
        return '无';
      });
    await runConsolidatingReview({
      invokeModel,
      transcript: 'fallback-transcript',
      messages: longMessages(40),
      summarize: invokeModel,
    });
    const reviewCall = invokeModel.mock.calls.find((c) => c[0] !== DIGEST_SYSTEM)!;
    expect(reviewCall[1]).toContain('fallback-transcript');
  });
});

describe('memoryReview splitTranscriptForDigest', () => {
  it('returns null under budget', () => {
    expect(splitTranscriptForDigest([{ role: 'user', text: 'hi' }], 6000)).toBeNull();
  });

  it('splits overflow into head + tail', () => {
    const msgs = longMessages(30);
    const parts = splitTranscriptForDigest(msgs, 2000);
    expect(parts).not.toBeNull();
    expect(parts!.overflow.length + parts!.tail.length).toBeLessThanOrEqual(
      parts!.overflow.length + 2000,
    );
    const joined = joinDigestAndTail('摘要内容', parts!.tail);
    expect(joined).toContain('摘要内容');
    expect(joined).toContain(parts!.tail);
  });
});

describe('memoryStore frozen snapshot regression (M4/P6)', () => {
  it('same freezeKey renders identically twice without writes', async () => {
    const { renderFrozenMemorySnapshot, resetFrozenMemorySnapshot } = await import(
      './memoryStore'
    );
    resetFrozenMemorySnapshot();
    await applyMemoryOp('user', { action: 'add', content: '稳定条目' });
    const a = await renderFrozenMemorySnapshot(undefined, 'k');
    const b = await renderFrozenMemorySnapshot(undefined, 'k');
    expect(a).toBe(b);
    resetFrozenMemorySnapshot();
  });
});
