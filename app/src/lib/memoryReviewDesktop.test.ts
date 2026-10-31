import { beforeEach, describe, expect, it, vi } from 'vitest';
const seams = vi.hoisted(() => ({ read: vi.fn(), review: vi.fn(), invoke: vi.fn(), make: vi.fn(), persisted: vi.fn(), selection: { adapter: 'codex', modelClass: 'original-reviewer' } }));
vi.mock('./memoryStore', () => ({ readMemoryBase: seams.read, getMemoryLimits: () => ({ user: 1375, memory: 2200 }), setMemoryLimits: vi.fn(), setMemoryNudgeThresholdPct: vi.fn() }));
vi.mock('./memoryRefresh', () => ({ makeReviewInvoker: seams.make }));
vi.mock('./gatewayConfig', () => ({ getExplicitActiveGatewaySelection: () => seams.selection, getDefaultGatewaySelection: () => seams.selection }));
vi.mock('./skills', () => ({ readPersistedSkillSourceSession: seams.persisted }));
vi.mock('./memoryConsolidate', () => ({ runConsolidatingReview: seams.review }));
import { beginMemoryReviewTurn, acquireReviewBackground } from './memoryReviewDesktop';
import * as desktopReview from './memoryReviewDesktop';
import * as memoryConfig from './memoryConfig';
import * as memoryTransactions from './memoryTransactions';
import { saveMemoryConfig, DEFAULT_MEMORY_CONFIG, loadMemoryReviewJournal, saveMemoryReviewJournal } from './memoryConfig';
import { resetGenerationSettingsStoreForTests } from './generationSettingsStore';
import { buildMemoryReviewMessages } from '@/runtime/memory/review';
const source = (id: string) => ({ hostId: 'local', namespaceId: 'local', workspaceId: 'workspace', sessionId: id, turnId: 'source-user', sourceMessageId: 'source-user', runId: id });
const config = { reviewEnabled: true, writeEnabled: true, reviewMinMessages: 2, reviewMinIntervalMinutes: 0 };
const messages = [{ id: 'source-user', role: 'user', text: 'Exact user fact' }, { id: 'source-answer', role: 'assistant', text: 'Final answer' }];
beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear(); resetGenerationSettingsStoreForTests();
  saveMemoryConfig({ ...DEFAULT_MEMORY_CONFIG, reviewEnabled: true, writeEnabled: true });
  seams.read.mockReset().mockImplementation(async (target, workspaceId) => ({ target, workspaceId, raw: null, entries: [] }));
  seams.review.mockReset().mockResolvedValue({ appliedOps: 1, queuedOps: 0, wroteUser: true, wroteMemory: false, lastErrors: [] });
  seams.invoke.mockReset();
  seams.make.mockReset().mockReturnValue(seams.invoke);
  seams.selection.modelClass = 'original-reviewer';
  seams.persisted.mockReset();
});
describe('production memory review turn', () => {
  it('publishes admission then confirmed reading and the real outcome without changing billing', async () => {
    const observed: { phase: string; source: unknown; appliedOps: number }[] = [];
    const api = desktopReview as unknown as { subscribeMemoryReview?: (listener: (state: typeof observed[number]) => void) => () => void };
    const unsubscribe = api.subscribeMemoryReview?.((state) => observed.push(state)) ?? (() => {});
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    const turn = beginMemoryReviewTurn({ source: source('chat-visible'), config, messages, ready });
    const pending = turn.finish('completed');
    try {
      expect(observed.map((state) => state.phase)).toEqual(['admitting']);
      expect(await memoryTransactions.readMemoryJson(memoryConfig.MEMORY_REVIEW_JOURNAL_PATH)).toBeNull();
      release();
      const result = await pending;
      expect(observed.map((state) => state.phase)).toEqual(['admitting', 'reading', 'applied']);
      expect(observed.at(-1)).toMatchObject({ source: source('chat-visible'), appliedOps: result!.appliedOps });
      expect(seams.review).toHaveBeenCalledTimes(1);
    } finally { release(); await pending; unsubscribe(); }
  });
  it.each([
    ['disabled', 'disabled', { ...config, writeEnabled: false }, 'completed'],
    ['threshold', 'skipped', { ...config, reviewMinMessages: 6 }, 'completed'],
    ['cancelled', 'cancelled', config, 'cancelled'],
  ] as const)('shows %s without pretending to read or persisting a job', async (id, phase, policy, terminal) => {
    const observed: string[] = [];
    const unsubscribe = desktopReview.subscribeMemoryReview((state) => observed.push(state.phase));
    if (id === 'disabled') saveMemoryConfig({ ...DEFAULT_MEMORY_CONFIG, reviewEnabled: true, writeEnabled: false });
    try {
      const turn = beginMemoryReviewTurn({ source: source(`chat-${id}`), config: policy, messages, ready: Promise.resolve() });
      expect(await turn.finish(terminal)).toBeUndefined();
      expect(observed).toEqual([phase]);
      expect(seams.review).not.toHaveBeenCalled();
      expect(await memoryTransactions.readMemoryJson(memoryConfig.MEMORY_REVIEW_JOURNAL_PATH)).toBeNull();
    } finally { unsubscribe(); }
  });
  it('does not retry or publish a journal after admission persistence fails', async () => {
    const save = vi.spyOn(memoryConfig, 'saveMemoryReviewJournal').mockRejectedValueOnce(new Error('admission CAS failed'));
    const turn = beginMemoryReviewTurn({ source: source('admission-failed'), config, messages, ready: Promise.resolve() });
    expect(await turn.finish('completed')).toMatchObject({ phase: 'failed', appliedOps: 0, error: expect.stringContaining('admission CAS failed') });
    expect(save).toHaveBeenCalledTimes(1);
    expect(memoryTransactions.readMemoryJson(memoryConfig.MEMORY_REVIEW_JOURNAL_PATH)).resolves.toBeNull();
    expect(seams.read).not.toHaveBeenCalled();
    expect(seams.review).not.toHaveBeenCalled();
    const slot = acquireReviewBackground();
    expect(slot).toBeDefined(); slot?.release();
  });
  it('releases its slot when usage observation throws without hiding a real commit', async () => {
    const invoke = Object.defineProperty(async () => '', 'usage', { get() { throw new Error('usage unavailable'); } });
    seams.make.mockReturnValue(invoke);
    const turn = beginMemoryReviewTurn({ source: source('usage-failed'), config, messages, ready: Promise.resolve() });
    const outcome = await turn.finish('completed').catch((error) => ({ error: String(error) }));
    const slot = acquireReviewBackground();
    const released = !!slot; slot?.release();
    expect(outcome).toMatchObject({ phase: 'applied', appliedOps: 1, recordingError: expect.stringContaining('usage unavailable') });
    expect(released).toBe(true);
  });
  it('does not write a late admission after cancellation while waiting for the journal lock', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const lock = memoryTransactions.withMemoryLock(memoryConfig.MEMORY_REVIEW_JOURNAL_PATH, () => gate);
    const save = vi.spyOn(memoryConfig, 'saveMemoryReviewJournal');
    const controller = new AbortController();
    const turn = beginMemoryReviewTurn({ source: source('cancel-lock'), config, messages, ready: Promise.resolve(), signal: controller.signal });
    const pending = turn.finish('completed');
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    controller.abort(); release(); await lock;
    expect(await pending).toMatchObject({ phase: 'cancelled', appliedOps: 0 });
    expect(save).not.toHaveBeenCalled();
    expect(seams.read).not.toHaveBeenCalled();
  });
  it('revokes dispatch authority when the admitted journal changes during target reads', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    seams.read.mockImplementation(async (target, workspaceId) => { await gate; return { target, workspaceId, raw: null, entries: [] }; });
    const turn = beginMemoryReviewTurn({ source: source('changed-before-model'), config, messages, ready: Promise.resolve() });
    const pending = turn.finish('completed');
    await vi.waitFor(() => expect(seams.read).toHaveBeenCalled());
    const current = await loadMemoryReviewJournal();
    await saveMemoryReviewJournal(current.raw, { ...current.value, jobs: [] });
    const newerRaw = await memoryTransactions.readMemoryJson(memoryConfig.MEMORY_REVIEW_JOURNAL_PATH);
    const save = vi.spyOn(memoryConfig, 'saveMemoryReviewJournal');
    release();
    expect(await pending).toMatchObject({ phase: 'failed', appliedOps: 0, error: expect.stringContaining('MEMORY_REVIEW_JOURNAL_AUTHORITY_LOST') });
    expect(seams.make).not.toHaveBeenCalled();
    expect(seams.review).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(await memoryTransactions.readMemoryJson(memoryConfig.MEMORY_REVIEW_JOURNAL_PATH)).toBe(newerRaw);
  });
  it('labels a rejected source outcome as not durable without creating a journal', async () => {
    const turn = beginMemoryReviewTurn({ source: source('ready-rejected'), config, messages, ready: Promise.reject(new Error('source append rejected')) });
    expect(await turn.finish('completed')).toMatchObject({ phase: 'failed', appliedOps: 0,
      error: expect.stringContaining('source append rejected'), recordingError: expect.stringContaining('MEMORY_REVIEW_OUTCOME_NOT_RECORDED') });
    expect(await memoryTransactions.readMemoryJson(memoryConfig.MEMORY_REVIEW_JOURNAL_PATH)).toBeNull();
    const slot = acquireReviewBackground(); expect(slot).toBeDefined(); slot?.release();
  });
  it('does not dispatch after acknowledged-but-unwritten admission and permits a fresh explicit attempt', async () => {
    const key = 'ultragamestudio.memory.v1:' + memoryConfig.MEMORY_REVIEW_JOURNAL_PATH;
    const original = Storage.prototype.setItem;
    let dropped = false;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, name, value) {
      if (name === key && !dropped) { dropped = true; return; }
      original.call(this, name, value);
    });
    const first = beginMemoryReviewTurn({ source: source('unwritten-admission'), config, messages, ready: Promise.resolve() });
    expect(await first.finish('completed')).toMatchObject({ phase: 'failed', appliedOps: 0, error: expect.stringContaining('readback mismatch') });
    expect(seams.review).not.toHaveBeenCalled();
    expect(localStorage.getItem(key)).toBeNull();
    const second = beginMemoryReviewTurn({ source: source('unwritten-admission'), config, messages, ready: Promise.resolve() });
    expect(await second.finish('completed')).toMatchObject({ phase: 'applied', appliedOps: 1 });
    expect(seams.review).toHaveBeenCalledTimes(1);
  });
  it('retains an uncertain written admission as a replay fence without a retry write', async () => {
    const key = 'ultragamestudio.memory.v1:' + memoryConfig.MEMORY_REVIEW_JOURNAL_PATH;
    const original = Storage.prototype.getItem;
    let failReadback = true;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, name) {
      const value = original.call(this, name);
      if (name === key && value !== null && failReadback) { failReadback = false; return null; }
      return value;
    });
    const save = vi.spyOn(memoryConfig, 'saveMemoryReviewJournal');
    const first = beginMemoryReviewTurn({ source: source('uncertain-admission'), config, messages, ready: Promise.resolve() });
    expect(await first.finish('completed')).toMatchObject({ phase: 'failed', appliedOps: 0, error: expect.stringContaining('readback mismatch') });
    const writtenRaw = localStorage.getItem(key);
    expect(JSON.parse(writtenRaw!).jobs[0].phase).toBe('reading');
    const second = beginMemoryReviewTurn({ source: source('uncertain-admission'), config, messages, ready: Promise.resolve() });
    expect(await second.finish('completed')).toBeUndefined();
    expect(save).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(key)).toBe(writtenRaw);
    expect(seams.review).not.toHaveBeenCalled();
  });
  it('denies a fabricated absent journal without overwriting the actual exact target', async () => {
    const before = await loadMemoryReviewJournal();
    await saveMemoryReviewJournal(before.raw, before.value);
    const realRaw = await memoryTransactions.readMemoryJson(memoryConfig.MEMORY_REVIEW_JOURNAL_PATH);
    vi.spyOn(memoryConfig, 'loadMemoryReviewJournal').mockResolvedValueOnce({ raw: null, value: before.value });
    const save = vi.spyOn(memoryConfig, 'saveMemoryReviewJournal');
    const turn = beginMemoryReviewTurn({ source: source('fake-null'), config, messages, ready: Promise.resolve() });
    expect(await turn.finish('completed')).toMatchObject({ phase: 'failed', appliedOps: 0, error: expect.stringContaining('CAS conflict') });
    expect(save).toHaveBeenCalledTimes(1);
    expect(await memoryTransactions.readMemoryJson(memoryConfig.MEMORY_REVIEW_JOURNAL_PATH)).toBe(realRaw);
    expect(seams.review).not.toHaveBeenCalled();
  });
  it('preserves a real partial commit when the terminal journal CAS loses to another writer', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    seams.review.mockImplementation(async () => { await gate; return { appliedOps: 1, queuedOps: 2, lastErrors: ['other library failed'] }; });
    const turn = beginMemoryReviewTurn({ source: source('terminal-conflict'), config, messages, ready: Promise.resolve() });
    const pending = turn.finish('completed');
    await vi.waitFor(() => expect(seams.review).toHaveBeenCalled());
    const current = await loadMemoryReviewJournal();
    await saveMemoryReviewJournal(current.raw, { ...current.value, jobs: [] });
    const newerRaw = await memoryTransactions.readMemoryJson(memoryConfig.MEMORY_REVIEW_JOURNAL_PATH);
    release();
    expect(await pending).toMatchObject({ phase: 'applied', appliedOps: 1, queuedOps: 2,
      error: 'other library failed', recordingError: expect.stringContaining('CAS conflict') });
    expect(await memoryTransactions.readMemoryJson(memoryConfig.MEMORY_REVIEW_JOURNAL_PATH)).toBe(newerRaw);
    expect((await loadMemoryReviewJournal()).value.scheduler.attempted).not.toEqual([]);
  });
  it('marks stale interrupted journals cancelled without replaying their source job', async () => {
    const turn = beginMemoryReviewTurn({ source: source('after-stale'), config, messages, ready: Promise.resolve() });
    const journal = await loadMemoryReviewJournal();
    await saveMemoryReviewJournal(journal.raw, { ...journal.value, jobs: [{ id: 'crashed', source: source('crashed'), phase: 'reading', appliedOps: 0, queuedOps: 0, updatedAt: Date.now() - 120001 }] });
    await turn.finish('completed');
    expect((await loadMemoryReviewJournal()).value.jobs.find((entry) => entry.id === 'crashed')).toMatchObject({ phase: 'cancelled', error: 'MEMORY_REVIEW_INTERRUPTED' });
    expect(seams.review).toHaveBeenCalledTimes(1);
  });
  it('does not create a new background dispatch after writeEnabled is disabled during foreground', async () => {
    const turn = beginMemoryReviewTurn({ source: source('off-before-finish'), config, messages, ready: Promise.resolve() });
    saveMemoryConfig({ ...DEFAULT_MEMORY_CONFIG, reviewEnabled: true, writeEnabled: false });
    await turn.finish('completed');
    expect(seams.read).not.toHaveBeenCalled();
    expect(seams.review).not.toHaveBeenCalled();
  });
  it('reviews an exact same-turn widget answer only after fresh persisted readback', async () => {
    const widget = { id: 'widget', role: 'assistant', text: 'Choose', interactionStatus: 'answered',
      interaction: { prompt: 'Choose' }, interactionAnswer: { kind: 'select' as const, values: ['UTF-8'] } };
    const derived = buildMemoryReviewMessages([...messages, widget]);
    seams.persisted.mockResolvedValue({ id: 'widget-confirmed', workspaceId: 'workspace', messages: [...messages, widget] });
    const turn = beginMemoryReviewTurn({ source: source('widget-confirmed'), config, messages: derived, ready: Promise.resolve() });
    expect(await turn.finish('completed')).toMatchObject({ phase: 'applied', appliedOps: 1 });
    expect(seams.review.mock.calls[0][0].messages).toEqual(expect.arrayContaining([expect.objectContaining({ sourceMessageId: 'widget', role: 'user', text: expect.stringContaining('UTF-8') })]));
  });
  it('rejects an optimistic widget answer that was not saved in its source session', async () => {
    const derived = [...messages, { id: 'widget:answer', sourceMessageId: 'widget', role: 'user', text: 'Exact widget answer' }];
    seams.persisted.mockResolvedValue({ id: 'widget-durable', workspaceId: 'workspace', messages: [{ id: 'widget', role: 'assistant', text: 'Choose', interactionStatus: 'pending' }] });
    const turn = beginMemoryReviewTurn({ source: source('widget-durable'), config, messages: derived, ready: Promise.resolve() });
    expect(await turn.finish('completed')).toMatchObject({ phase: 'failed', appliedOps: 0, error: expect.stringContaining('MEMORY_INTERACTION_NOT_PERSISTED') });
    expect(seams.read).not.toHaveBeenCalled();
    expect(seams.review).not.toHaveBeenCalled();
  });
  it('preserves pending evidence when one library commits but another library fails', async () => {
    seams.review.mockResolvedValue({ appliedOps: 1, queuedOps: 0, lastErrors: ['Memory CAS conflict: project library changed'] });
    const turn = beginMemoryReviewTurn({ source: source('partial-commit'), config, messages, ready: Promise.resolve() });
    expect(await turn.finish('completed')).toMatchObject({ phase: 'applied', appliedOps: 1, error: expect.stringContaining('conflict') });
    const journal = await loadMemoryReviewJournal();
    expect(journal.value.scheduler.consumed).toEqual([]);
    expect(journal.value.scheduler.lastCompleted).toEqual([]);
  });
  it('retains the source cancellation signal even when the caller mutates its options', async () => {
    const controller = new AbortController();
    const options = { source: source('frozen-signal'), config, messages, ready: Promise.resolve(), signal: controller.signal };
    const turn = beginMemoryReviewTurn(options);
    options.signal = new AbortController().signal;
    controller.abort();
    expect(await turn.finish('completed')).toMatchObject({ phase: 'cancelled', appliedOps: 0 });
    expect(seams.review).not.toHaveBeenCalled();
  });
  it('freezes the unpinned reviewer before asynchronous source persistence', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const turn = beginMemoryReviewTurn({ source: source('frozen-route'), config, messages, ready: gate });
    seams.selection.modelClass = 'changed-foreground';
    const pending = turn.finish('completed'); release(); await pending;
    expect(seams.make.mock.calls[0][0].reviewModelSelection).toMatchObject({ modelClass: 'original-reviewer' });
  });
  it('uses tightened approval after asynchronous memory reads while retaining the frozen reviewer', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    seams.read.mockImplementation(async (target, workspaceId) => { await gate; return { target, workspaceId, raw: null, entries: [] }; });
    const turn = beginMemoryReviewTurn({ source: source('tightened-during-read'), config, messages, ready: Promise.resolve() });
    const pending = turn.finish('completed');
    try {
      await vi.waitFor(() => expect(seams.read).toHaveBeenCalled());
      saveMemoryConfig({ ...DEFAULT_MEMORY_CONFIG, ...config, approvalRequired: true,
        reviewModelSelection: { adapter: 'codex', modelClass: 'new-settings-reviewer' } });
      seams.selection.modelClass = 'new-foreground-reviewer';
      release(); await pending;
      expect(seams.review).toHaveBeenCalledTimes(1);
      expect(seams.review.mock.calls[0][0].approvalMode).toBe('queue');
      expect(seams.make).toHaveBeenCalledTimes(1);
      expect(seams.make.mock.calls[0][0].reviewModelSelection).toMatchObject({ modelClass: 'original-reviewer' });
    } finally { release(); await pending; }
  });
  it('releases a cancelled job without waiting for an unresolved source append', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const controller = new AbortController();
    const turn = beginMemoryReviewTurn({ source: source('cancel-persist'), config, messages, ready: gate, signal: controller.signal });
    const pending = turn.finish('completed');
    controller.abort();
    const observed = await Promise.race([pending, new Promise((resolve) => setTimeout(() => resolve('hung'), 30))]);
    release(); await pending;
    expect(observed).toMatchObject({ phase: 'cancelled', appliedOps: 0 });
    expect(seams.read).not.toHaveBeenCalled();
    expect(seams.review).not.toHaveBeenCalled();
  });
  it('cancels an admitted job when memory writes are switched off before dispatch', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    seams.read.mockImplementation(async (target, workspaceId) => { await gate; return { target, workspaceId, raw: null, entries: [] }; });
    const turn = beginMemoryReviewTurn({ source: source('disabled-write'), config, messages, ready: Promise.resolve() });
    const pending = turn.finish('completed');
    await vi.waitFor(() => expect(seams.read).toHaveBeenCalled());
    saveMemoryConfig({ ...DEFAULT_MEMORY_CONFIG, reviewEnabled: true, writeEnabled: false });
    release();
    expect(await pending).toMatchObject({ phase: 'cancelled', appliedOps: 0 });
    expect(seams.review).not.toHaveBeenCalled();
  });
  it('keeps a real dispatched host result visible even after cancellation', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    seams.review.mockImplementation(async () => { await gate; return { appliedOps: 1, queuedOps: 0, lastErrors: [] }; });
    const controller = new AbortController();
    const turn = beginMemoryReviewTurn({ source: source('committed-after-stop'), config, messages, ready: Promise.resolve(), signal: controller.signal });
    const pending = turn.finish('completed');
    await vi.waitFor(() => expect(seams.review).toHaveBeenCalled());
    controller.abort(); release();
    expect(await pending).toMatchObject({ phase: 'applied', appliedOps: 1 });
  });
  it('cancels a superseded background job before model dispatch', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    seams.read.mockImplementation(async (target, workspaceId) => { await gate; return { target, workspaceId, raw: null, entries: [] }; });
    const older = beginMemoryReviewTurn({ source: source('superseded-old'), config, messages, ready: Promise.resolve() });
    const pending = older.finish('completed');
    await vi.waitFor(() => expect(seams.read).toHaveBeenCalled());
    const newer = beginMemoryReviewTurn({ source: source('superseded-new'), config, messages, ready: Promise.resolve() });
    release();
    expect(await pending).toMatchObject({ phase: 'cancelled', appliedOps: 0 });
    expect(seams.review).not.toHaveBeenCalled();
    await newer.finish('cancelled');
  });
  it('persists the original real assistant message identity for both admission and outcome', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    seams.read.mockImplementation(async (target, workspaceId) => { await gate; return { target, workspaceId, raw: null, entries: [] }; });
    const observed: { phase: string; assistantMessageId?: string }[] = [];
    const unsubscribe = desktopReview.subscribeMemoryReview((state) => observed.push(state));
    const originalSource = source('assistant-journal');
    const turn = beginMemoryReviewTurn({ source: originalSource, config, messages: [messages[0]], ready: Promise.resolve() });
    const completedMessages = [...messages, { id: 'original-final-answer', role: 'assistant', text: 'Real terminal answer' }];
    const pending = turn.finish('completed', completedMessages);
    completedMessages[2].id = 'mutated-ui-answer';
    try {
      await vi.waitFor(() => expect(seams.read).toHaveBeenCalled());
      const reading = (await loadMemoryReviewJournal()).value.jobs[0];
      release();
      const outcome = await pending;
      const saved = (await loadMemoryReviewJournal()).value.jobs.find((entry) => entry.id === outcome!.id);
      expect(reading).toMatchObject({ phase: 'reading', assistantMessageId: 'original-final-answer', source: originalSource });
      expect(saved).toMatchObject({ phase: 'applied', assistantMessageId: 'original-final-answer', source: originalSource });
      expect(observed.map((state) => state.assistantMessageId)).toEqual(['original-final-answer', 'original-final-answer', 'original-final-answer']);
      expect(seams.review.mock.calls[0][0].reviewSource).toEqual(originalSource);
    } finally { release(); await pending; unsubscribe(); }
  });
  it('omits assistant message metadata when there is no real assistant message', async () => {
    const turn = beginMemoryReviewTurn({ source: source('no-assistant-journal'), config,
      messages: [messages[0], { id: 'another-user-message', role: 'user', text: 'Another actual user fact' }], ready: Promise.resolve() });
    const outcome = await turn.finish('completed');
    const saved = (await loadMemoryReviewJournal()).value.jobs.find((entry) => entry.id === outcome!.id);
    expect(saved).not.toHaveProperty('assistantMessageId');
  });
  it('persists interrupted diagnostics even when the original replay fence denies another dispatch', async () => {
    let releaseRead!: () => void;
    const gate = new Promise<void>((resolve) => { releaseRead = resolve; });
    seams.read.mockImplementation(async (target, workspaceId) => {
      await gate;
      return { target, workspaceId, raw: null, entries: [] };
    });
    const controller = new AbortController();
    const first = beginMemoryReviewTurn({ source: source('interrupted-replay'), config, messages,
      ready: Promise.resolve(), signal: controller.signal }).finish('completed');
    let crashed!: Awaited<ReturnType<typeof loadMemoryReviewJournal>>['value'];
    try {
      await vi.waitFor(() => expect(seams.read).toHaveBeenCalledTimes(2));
      crashed = (await loadMemoryReviewJournal()).value;
      expect(crashed.jobs[0].phase).toBe('reading');
      controller.abort();
    } finally { controller.abort(); releaseRead(); await first; }
    const terminal = await loadMemoryReviewJournal();
    await saveMemoryReviewJournal(terminal.raw, crashed);
    vi.spyOn(Date, 'now').mockReturnValue(crashed.jobs[0].updatedAt + 121000);
    const retry = beginMemoryReviewTurn({ source: source('interrupted-replay'), config, messages, ready: Promise.resolve() });
    expect(await retry.finish('completed')).toBeUndefined();
    const saved = await loadMemoryReviewJournal();
    expect(saved.value.jobs[0]).toMatchObject({ phase: 'cancelled', error: 'MEMORY_REVIEW_INTERRUPTED' });
    expect(saved.value.scheduler).toEqual(crashed.scheduler);
    expect(seams.make).not.toHaveBeenCalled();
    expect(seams.review).not.toHaveBeenCalled();
  });

  it('persists the job outcome and consumed watermark through the real memory CAS journal', async () => {
    const turn = beginMemoryReviewTurn({ source: source('durable-journal'), config, messages, ready: Promise.resolve() });
    const outcome = await turn.finish('completed');
    const journal = await loadMemoryReviewJournal();
    expect(journal.value.jobs).toEqual(expect.arrayContaining([expect.objectContaining({ id: outcome!.id, phase: 'applied', appliedOps: 1 })]));
    expect(journal.value.scheduler.attempted).toContain(outcome!.id);
  });
  it('waits for exact source persistence before reads then dispatches one frozen budget and exact bases', async () => {
    let ready!: () => void;
    const gate = new Promise<void>((resolve) => { ready = resolve; });
    const turn = beginMemoryReviewTurn({ source: source('source-barrier'), config, messages, ready: gate });
    const pending = turn.finish('completed');
    await Promise.resolve();
    expect(seams.read).not.toHaveBeenCalled();
    ready();
    const outcome = await pending;
    expect(outcome).toMatchObject({ phase: 'applied', appliedOps: 1 });
    expect(seams.review).toHaveBeenCalledTimes(1);
    const request = seams.review.mock.calls[0][0];
    expect(request.summarize).toBe(request.invokeModel);
    expect(request.reviewSource).toEqual(source('source-barrier'));
    expect(request.bases).toEqual({ user: { target: 'user', workspaceId: undefined, raw: null, entries: [] }, memory: { target: 'memory', workspaceId: 'workspace', raw: null, entries: [] } });
  });
});
