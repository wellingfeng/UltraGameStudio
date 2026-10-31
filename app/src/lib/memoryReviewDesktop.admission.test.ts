import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const seams = vi.hoisted(() => ({ read: vi.fn(), review: vi.fn(), make: vi.fn() }));
vi.mock('./memoryStore', () => ({ readMemoryBase: seams.read, getMemoryLimits: () => ({ user: 1375, memory: 2200 }), setMemoryLimits: vi.fn(), setMemoryNudgeThresholdPct: vi.fn() }));
vi.mock('./memoryRefresh', () => ({ makeReviewInvoker: seams.make }));
vi.mock('./gatewayConfig', () => ({ getExplicitActiveGatewaySelection: () => ({ adapter: 'codex', modelClass: 'fixture-reviewer' }), getDefaultGatewaySelection: () => ({ adapter: 'codex', modelClass: 'fixture-reviewer' }) }));
vi.mock('./memoryConsolidate', () => ({ runConsolidatingReview: seams.review }));
import { beginMemoryReviewTurn, subscribeMemoryReview } from './memoryReviewDesktop';
import { acquireReviewBackground, beginReviewForeground, cancelMemoryReviews } from '@/runtime/memory/review';
import { saveMemoryConfig, DEFAULT_MEMORY_CONFIG, MEMORY_REVIEW_JOURNAL_PATH } from './memoryConfig';
import { readMemoryJson } from './memoryTransactions';
import { resetGenerationSettingsStoreForTests } from './generationSettingsStore';

const policy = { reviewEnabled: true, writeEnabled: true, reviewMinMessages: 2, reviewMinIntervalMinutes: 0 };
const source = (id: string) => ({ hostId: 'local', namespaceId: 'local', workspaceId: 'admission-workspace', sessionId: id, turnId: 'user', sourceMessageId: 'user', runId: id });
const messages = [{ id: 'user', role: 'user', text: 'An actual terminal source for the isolated scheduler test.' }, { id: 'answer', role: 'assistant', text: 'Completed.' }];
beforeEach(() => {
  localStorage.clear(); resetGenerationSettingsStoreForTests();
  saveMemoryConfig({ ...DEFAULT_MEMORY_CONFIG, ...policy });
  seams.read.mockReset().mockImplementation(async (target, workspaceId) => ({ target, workspaceId, raw: null, entries: [] }));
  seams.review.mockReset().mockResolvedValue({ appliedOps: 0, queuedOps: 0, wroteUser: false, wroteMemory: false, lastErrors: [] });
  seams.make.mockReset().mockReturnValue(async () => '');
});
afterEach(() => vi.restoreAllMocks());

describe('memory review shared background admission', () => {
  it('releases an aborted foreground owner even when its caller never reaches finish', async () => {
    const controller = new AbortController();
    const turn = beginMemoryReviewTurn({ source: source('aborted-foreground-owner'), config: policy,
      messages, ready: Promise.resolve(), signal: controller.signal });
    controller.abort();
    const slot = acquireReviewBackground('abort-inspection');
    const released = !!slot;
    slot?.release();
    try {
      expect(released).toBe(true);
      expect(seams.make).not.toHaveBeenCalled();
      expect(seams.review).not.toHaveBeenCalled();
      expect(await readMemoryJson(MEMORY_REVIEW_JOURNAL_PATH)).toBeNull();
    } finally { await turn.finish('cancelled'); }
  });

  it('installs one public finish promise before synchronous queued observers can re-enter', async () => {
    const holder = acquireReviewBackground('skills:reentry-fixture');
    const turn = beginMemoryReviewTurn({ source: source('reentrant-memory'), config: policy, messages, ready: Promise.resolve() });
    let entered = false;
    let reentrant: ReturnType<typeof turn.finish> | undefined;
    const unsubscribe = subscribeMemoryReview((state) => {
      if (state.source.sessionId !== 'reentrant-memory' || entered) return;
      entered = true;
      reentrant = turn.finish('completed');
    });
    const pending = turn.finish('completed');
    try {
      expect(reentrant).toBe(pending);
      holder?.release();
      expect(await pending).toMatchObject({ phase: 'noop' });
      expect(seams.review).toHaveBeenCalledTimes(1);
    } finally { holder?.release(); await pending; unsubscribe(); }
  });

  it('ends cancelled read-only preparation without waiting for a stalled native read', async () => {
    let releaseRead!: () => void;
    const gate = new Promise<void>((resolve) => { releaseRead = resolve; });
    seams.read.mockImplementation(async (target, workspaceId) => {
      await gate;
      return { target, workspaceId, raw: null, entries: [] };
    });
    const controller = new AbortController();
    const turn = beginMemoryReviewTurn({ source: source('cancel-stalled-read'), config: policy,
      messages, ready: Promise.resolve(), signal: controller.signal });
    let settled = false;
    const pending = turn.finish('completed').then((result) => { settled = true; return result; });
    try {
      for (let i = 0; i < 80; i++) await Promise.resolve();
      expect(seams.read).toHaveBeenCalledTimes(2);
      controller.abort();
      for (let i = 0; i < 80; i++) await Promise.resolve();
      expect(settled).toBe(true);
      expect(await pending).toMatchObject({ phase: 'cancelled', appliedOps: 0 });
      const slot = acquireReviewBackground('after-cancelled-read');
      const released = !!slot;
      slot?.release();
      expect(released).toBe(true);
      expect(seams.make).not.toHaveBeenCalled();
      expect(seams.review).not.toHaveBeenCalled();
    } finally { controller.abort(); releaseRead(); await pending; }
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(seams.review).not.toHaveBeenCalled();
  });

  it('honors explicit module cancellation while queued without cancelling another owner', async () => {
    const holder = acquireReviewBackground('skills:explicit-cancel-fixture');
    const turn = beginMemoryReviewTurn({ source: source('explicit-queued-cancel'), config: policy, messages, ready: Promise.resolve() });
    const pending = turn.finish('completed');
    try {
      cancelMemoryReviews();
      expect(await pending).toMatchObject({ phase: 'cancelled', appliedOps: 0 });
      expect(seams.review).not.toHaveBeenCalled();
      expect(await readMemoryJson(MEMORY_REVIEW_JOURNAL_PATH)).toBeNull();
    } finally { holder?.release(); await pending; }
  });

  it('retains an undispatched completed turn until the occupied background slot releases', async () => {
    const holder = acquireReviewBackground('skills:admission-fixture');
    expect(holder).toBeDefined();
    const phases: string[] = [];
    const unsubscribe = subscribeMemoryReview((state) => { if (state.source.sessionId === 'busy-slot') phases.push(state.phase); });
    const turn = beginMemoryReviewTurn({ source: source('busy-slot'), config: policy, messages, ready: Promise.resolve() });
    const pending = turn.finish('completed');
    try {
      await Promise.resolve();
      expect(phases).toEqual(['queued']);
      expect(seams.make).not.toHaveBeenCalled();
      expect(seams.review).not.toHaveBeenCalled();
      expect(await readMemoryJson(MEMORY_REVIEW_JOURNAL_PATH)).toBeNull();
      holder!.release();
      expect(await pending).toMatchObject({ phase: 'noop', appliedOps: 0, queuedOps: 0 });
      expect(phases).toEqual(['queued', 'admitting', 'reading', 'noop']);
      expect(seams.review).toHaveBeenCalledTimes(1);
    } finally { holder?.release(); await pending; unsubscribe(); }
  });

  it('requires newly enabled approval when a completed turn leaves the busy queue', async () => {
    const holder = acquireReviewBackground('skills:tightened-policy-fixture');
    expect(holder).toBeDefined();
    const turn = beginMemoryReviewTurn({ source: source('tightened-queued'), config: policy, messages, ready: Promise.resolve() });
    const pending = turn.finish('completed');
    try {
      await Promise.resolve();
      expect(seams.review).not.toHaveBeenCalled();
      saveMemoryConfig({ ...DEFAULT_MEMORY_CONFIG, ...policy, approvalRequired: true });
      holder!.release();
      await pending;
      expect(seams.review).toHaveBeenCalledTimes(1);
      expect(seams.review.mock.calls[0][0].approvalMode).toBe('queue');
    } finally { holder?.release(); await pending; }
  });

  it('keeps a job that originally required approval queued after settings relax', async () => {
    saveMemoryConfig({ ...DEFAULT_MEMORY_CONFIG, ...policy, approvalRequired: true });
    const holder = acquireReviewBackground('skills:original-strict-policy-fixture');
    const turn = beginMemoryReviewTurn({ source: source('original-strict-queued'), config: policy, messages, ready: Promise.resolve() });
    const pending = turn.finish('completed');
    try {
      saveMemoryConfig({ ...DEFAULT_MEMORY_CONFIG, ...policy, approvalRequired: false });
      holder!.release();
      await pending;
      expect(seams.review).toHaveBeenCalledTimes(1);
      expect(seams.review.mock.calls[0][0].approvalMode).toBe('queue');
    } finally { holder?.release(); await pending; }
  });

  it('waits for every foreground owner and wakes without a timer or model retry', async () => {
    const releaseOther = beginReviewForeground('other-live-session');
    const turn = beginMemoryReviewTurn({ source: source('all-foreground'), config: policy, messages, ready: Promise.resolve() });
    const pending = turn.finish('completed');
    try {
      await Promise.resolve();
      expect(seams.review).not.toHaveBeenCalled();
      releaseOther();
      expect(await pending).toMatchObject({ phase: 'noop' });
      expect(seams.review).toHaveBeenCalledTimes(1);
    } finally { releaseOther(); await pending; }
  });

  it('cancels an undispatched queued turn without a journal or a later billed dispatch', async () => {
    const holder = acquireReviewBackground('skills:cancel-fixture');
    const controller = new AbortController();
    const turn = beginMemoryReviewTurn({ source: source('cancel-queued'), config: policy, messages, ready: Promise.resolve(), signal: controller.signal });
    const pending = turn.finish('completed');
    try {
      await Promise.resolve();
      controller.abort();
      expect(await pending).toMatchObject({ phase: 'cancelled', appliedOps: 0, queuedOps: 0 });
      expect(await readMemoryJson(MEMORY_REVIEW_JOURNAL_PATH)).toBeNull();
      holder?.release();
      await Promise.resolve(); await Promise.resolve();
      expect(seams.make).not.toHaveBeenCalled();
      expect(seams.review).not.toHaveBeenCalled();
    } finally { controller.abort(); holder?.release(); await pending; }
  });
});
