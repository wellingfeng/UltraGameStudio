import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { simpleBlueprint } from '@/core/defaultBlueprint';
import { defaultComposer } from './sampleSessions';
const seams = vi.hoisted(() => ({ complete: vi.fn(), resolve: vi.fn(), begin: vi.fn(), finish: vi.fn(), full: vi.fn(), compact: vi.fn(), review: vi.fn(), make: vi.fn() }));
vi.mock('@/lib/tauri', async (original) => ({ ...await original<typeof import('@/lib/tauri')>(), tauriAvailable: () => false, isTauri: () => false }));
vi.mock('@/lib/modelGateway/modelGateway', async (original) => ({ ...await original<typeof import('@/lib/modelGateway/modelGateway')>(), completeGatewayText: seams.complete, resolveDirectGatewayRoute: seams.resolve }));
vi.mock('@/lib/memoryReviewDesktop', async (original) => ({ ...await original<typeof import('@/lib/memoryReviewDesktop')>(), beginMemoryReviewTurn: seams.begin }));
vi.mock('@/lib/memoryRefresh', async (original) => ({ ...await original<typeof import('@/lib/memoryRefresh')>(), makeReviewInvoker: seams.make }));
vi.mock('@/lib/memoryConsolidate', async (original) => ({ ...await original<typeof import('@/lib/memoryConsolidate')>(), runConsolidatingReview: seams.review }));
vi.mock('@/lib/memoryStore', async (original) => ({ ...await original<typeof import('@/lib/memoryStore')>(), renderFrozenMemorySnapshot: seams.full, renderMemorySnapshotCompact: seams.compact }));
import { useStore, __resetSimpleChatRuntimeForTests } from './useStore';
import { historyStore } from './history/store';
import { saveMemoryConfig, DEFAULT_MEMORY_CONFIG, loadMemoryReviewJournal, MEMORY_REVIEW_JOURNAL_PATH } from '@/lib/memoryConfig';
import type { MemoryReviewTurnOptions } from '@/lib/memoryReviewDesktop';
import { subscribeMemoryReview, type MemoryReviewChatState } from '@/lib/memoryReviewEvents';
import { readMemoryJson } from '@/lib/memoryTransactions';
import { acquireReviewBackground, beginReviewForeground, cancelMemoryReviews } from '@/runtime/memory/review';
import { resetGenerationSettingsStoreForTests } from '@/lib/generationSettingsStore';
import { activeAiEdits, aiEditSnapshots } from './channelRegistry';

async function mountRealMemoryProducer() {
  const real = await vi.importActual<typeof import('@/lib/memoryReviewDesktop')>('@/lib/memoryReviewDesktop');
  const pending = new Map<string, ReturnType<ReturnType<typeof real.beginMemoryReviewTurn>['finish']>>();
  seams.begin.mockImplementation((options: MemoryReviewTurnOptions) => {
    const turn = real.beginMemoryReviewTurn(options);
    const observed: typeof turn = { ...turn, finish(terminal, messages) {
      const completion = turn.finish(terminal, messages);
      pending.set(options.source.turnId, completion);
      return completion;
    } };
    return observed;
  });
  return pending;
}

beforeEach(async () => {
  __resetSimpleChatRuntimeForTests(); activeAiEdits.clear(); aiEditSnapshots.clear(); localStorage.clear(); resetGenerationSettingsStoreForTests();
  saveMemoryConfig({ ...DEFAULT_MEMORY_CONFIG, reviewEnabled: true, reviewMinMessages: 2, reviewMinIntervalMinutes: 0 });
  seams.full.mockReset().mockResolvedValue(''); seams.compact.mockReset().mockResolvedValue('');
  seams.finish.mockReset().mockResolvedValue(undefined); seams.begin.mockReset().mockReturnValue({ finish: seams.finish });
  seams.resolve.mockReset().mockReturnValue({ adapter: 'codex', modelClass: 'default', model: 'fixture', mode: 'direct', transport: 'openai-compatible', label: 'Fixture', source: 'global' });
  seams.complete.mockReset().mockResolvedValue('Task completed.');
  seams.make.mockReset().mockReturnValue(async () => '');
  seams.review.mockReset().mockResolvedValue({ appliedOps: 0, queuedOps: 0, wroteUser: false, wroteMemory: false, lastErrors: [] });
  const record = await historyStore.createSession({ workspaceId: '__default__', id: `memory-${crypto.randomUUID()}`, isWorkflow: false, messages: [], title: 'Source' });
  useStore.setState({ ...useStore.getInitialState(), workflow: simpleBlueprint('Source'), composer: { ...defaultComposer }, historyReady: true, activeWorkspaceId: record.workspaceId, activeSessionId: record.id, mode: 'design', aiStreaming: false, aiEditingSessions: [], chattingSessions: [], runningSessions: [], waitingInputSessions: [], messages: [], workspaces: [], sessions: [], sessionTree: {}, personalInstructions: '' });
});
afterEach(() => { __resetSimpleChatRuntimeForTests(); activeAiEdits.clear(); aiEditSnapshots.clear(); vi.restoreAllMocks(); });
describe('real simple-chat memory review producer', () => {
  it('retains the undispatched old review across a real send and dispatches once only after every foreground owner ends', async () => {
    const pending = await mountRealMemoryProducer();
    saveMemoryConfig({ ...DEFAULT_MEMORY_CONFIG, reviewEnabled: true, reviewMinMessages: 2, reviewMinIntervalMinutes: 1 });
    const holder = acquireReviewBackground('skills:host-commit-fixture');
    const states: MemoryReviewChatState[] = [];
    const sessionId = useStore.getState().activeSessionId!;
    const unsubscribe = subscribeMemoryReview((state) => { if (state.source.sessionId === sessionId) states.push(state); });
    let finishNew!: (answer: string) => void;
    const foregroundAnswer = new Promise<string>((resolve) => { finishNew = resolve; });
    let endOther = () => {};
    try {
      expect(holder).toBeDefined();
      expect(useStore.getState().sendPrompt('Remember the older exact project fact.')).toBe(true);
      await vi.waitFor(() => expect(states.map((state) => state.phase)).toEqual(['queued']));
      const oldSource = seams.begin.mock.calls[0][0].source;
      const oldPending = pending.get(oldSource.turnId)!;
      let oldSettled = false;
      void oldPending.then(() => { oldSettled = true; });
      expect(oldPending).toBeDefined();
      expect(holder!.signal.aborted).toBe(true);
      await expect(seams.begin.mock.calls[0][0].ready).resolves.toBeUndefined();
      const persisted = await historyStore.getSession('__default__', sessionId);
      expect(persisted?.messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: oldSource.sourceMessageId, role: 'user', text: 'Remember the older exact project fact.' }),
        expect.objectContaining({ role: 'assistant', text: expect.stringContaining('Task completed.') }),
      ]));
      expect(await readMemoryJson(MEMORY_REVIEW_JOURNAL_PATH)).toBeNull();
      expect(seams.review).not.toHaveBeenCalled();

      endOther = beginReviewForeground('another-live-session');
      seams.complete.mockImplementation(() => foregroundAnswer);
      expect(useStore.getState().sendPrompt('A new foreground prompt must not clear the older queue.')).toBe(true);
      await vi.waitFor(() => expect(seams.begin).toHaveBeenCalledTimes(2));
      await Promise.resolve();
      expect(states.filter((state) => state.source.turnId === oldSource.turnId).map((state) => state.phase)).toEqual(['queued']);
      expect(oldSettled).toBe(false);
      expect(seams.review).not.toHaveBeenCalled();
      holder!.release();
      await Promise.resolve(); await Promise.resolve();
      expect(seams.review).not.toHaveBeenCalled();
      expect(acquireReviewBackground()).toBeUndefined();

      finishNew('New foreground task completed.');
      await vi.waitFor(() => expect(useStore.getState().chattingSessions).toHaveLength(0));
      expect(seams.review).not.toHaveBeenCalled();
      expect(oldSettled).toBe(false);
      endOther();
      expect(await oldPending).toMatchObject({ source: oldSource, phase: 'noop' });
      await Promise.all(pending.values());
      expect(seams.review).toHaveBeenCalledTimes(1);
      expect(seams.review.mock.calls[0][0]).toMatchObject({ reviewSource: oldSource, messages: expect.arrayContaining([
        expect.objectContaining({ id: oldSource.sourceMessageId, role: 'user', text: 'Remember the older exact project fact.' }),
      ]) });
      expect(states.filter((state) => state.source.turnId === oldSource.turnId).map((state) => state.phase)).toEqual(['queued', 'admitting', 'reading', 'noop']);
      expect((await loadMemoryReviewJournal()).value.jobs).toEqual([
        expect.objectContaining({ source: oldSource, phase: 'noop' }),
      ]);
      // Repeated releases must not re-dispatch the completed old range.
      holder!.release(); endOther();
      await Promise.resolve(); await Promise.resolve();
      expect(seams.review).toHaveBeenCalledTimes(1);
    } finally {
      finishNew('Cleanup foreground completion.');
      cancelMemoryReviews(); holder?.release(); endOther();
      await vi.waitFor(() => expect(useStore.getState().chattingSessions).toHaveLength(0));
      await Promise.all(pending.values());
      unsubscribe();
    }
  });

  it('keeps the active memory slot through preemption until the dispatched host completion and terminal readback finish', async () => {
    const pending = await mountRealMemoryProducer();
    saveMemoryConfig({ ...DEFAULT_MEMORY_CONFIG, reviewEnabled: true, reviewMinMessages: 2, reviewMinIntervalMinutes: 1 });
    let finishHost!: () => void;
    const hostCompletion = new Promise<void>((resolve) => { finishHost = resolve; });
    seams.review.mockImplementationOnce(async () => {
      await hostCompletion;
      return { appliedOps: 1, queuedOps: 0, wroteUser: true, wroteMemory: false, lastErrors: [] };
    });
    try {
      expect(useStore.getState().sendPrompt('Complete the older dispatched review.')).toBe(true);
      await vi.waitFor(() => expect(seams.review).toHaveBeenCalledTimes(1));
      const oldSource = seams.begin.mock.calls[0][0].source;
      const oldPending = pending.get(oldSource.turnId)!;
      let oldSettled = false;
      void oldPending.then(() => { oldSettled = true; });
      const dispatchedSignal: AbortSignal = seams.review.mock.calls[0][0].signal;
      const admittedRaw = await readMemoryJson(MEMORY_REVIEW_JOURNAL_PATH);
      expect(JSON.parse(admittedRaw!).jobs).toEqual([expect.objectContaining({ source: oldSource, phase: 'reading' })]);

      expect(useStore.getState().sendPrompt('Foreground work may finish before the old host commit.')).toBe(true);
      await vi.waitFor(() => expect(seams.begin).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(useStore.getState().chattingSessions).toHaveLength(0));
      expect(dispatchedSignal.aborted).toBe(true);
      expect(oldSettled).toBe(false);
      expect(acquireReviewBackground()).toBeUndefined();
      expect(seams.review).toHaveBeenCalledTimes(1);
      expect(await readMemoryJson(MEMORY_REVIEW_JOURNAL_PATH)).toBe(admittedRaw);

      finishHost();
      expect(await oldPending).toMatchObject({ source: oldSource, phase: 'applied', appliedOps: 1 });
      await Promise.all(pending.values());
      expect((await loadMemoryReviewJournal()).value.jobs).toEqual([
        expect.objectContaining({ source: oldSource, phase: 'applied', appliedOps: 1 }),
      ]);
      expect(seams.review).toHaveBeenCalledTimes(1);
      const released = acquireReviewBackground();
      expect(released).toBeDefined(); released?.release();
    } finally {
      finishHost(); cancelMemoryReviews();
      await vi.waitFor(() => expect(useStore.getState().chattingSessions).toHaveLength(0));
      await Promise.all(pending.values());
    }
  });

  it.each(['stopChat', 'reviewEnabled', 'writeEnabled'] as const)('still cancels an undispatched real-store review on explicit %s', async (action) => {
    const pending = await mountRealMemoryProducer();
    const holder = acquireReviewBackground('skills:explicit-cancel-fixture');
    const sessionId = useStore.getState().activeSessionId!;
    const states: MemoryReviewChatState[] = [];
    const unsubscribe = subscribeMemoryReview((state) => { if (state.source.sessionId === sessionId) states.push(state); });
    try {
      expect(holder).toBeDefined();
      expect(useStore.getState().sendPrompt('A queued review remains explicitly cancellable.')).toBe(true);
      await vi.waitFor(() => expect(states.map((state) => state.phase)).toEqual(['queued']));
      const source = seams.begin.mock.calls[0][0].source;
      if (action === 'stopChat') useStore.getState().stopChat();
      else saveMemoryConfig({ ...DEFAULT_MEMORY_CONFIG, reviewEnabled: true, [action]: false });
      expect(await pending.get(source.turnId)).toMatchObject({ source, phase: 'cancelled', appliedOps: 0, queuedOps: 0 });
      expect(states.map((state) => state.phase)).toEqual(['queued', 'cancelled']);
      expect(await readMemoryJson(MEMORY_REVIEW_JOURNAL_PATH)).toBeNull();
      holder!.release();
      await Promise.resolve(); await Promise.resolve();
      expect(seams.make).not.toHaveBeenCalled();
      expect(seams.review).not.toHaveBeenCalled();
    } finally { cancelMemoryReviews(); holder?.release(); await Promise.all(pending.values()); unsubscribe(); }
  });

  it('includes the real same-turn widget answer with its persisted native message ID', async () => {
    seams.complete.mockResolvedValueOnce('<<UGS_ASK>>\n{"type":"select","prompt":"项目必须使用哪种编码？","options":["UTF-8"],"multi":false}\n<<UGS_ASK_END>>').mockResolvedValue('Task completed.');
    useStore.getState().sendPrompt('确认项目编码。');
    await vi.waitFor(() => expect(useStore.getState().messages.some((message) => message.interactionStatus === 'pending')).toBe(true));
    expect(seams.finish).not.toHaveBeenCalled();
    const widget = useStore.getState().messages.find((message) => message.interactionStatus === 'pending')!;
    useStore.getState().answerInteraction(widget.id, { kind: 'select', values: ['UTF-8'] });
    await vi.waitFor(() => expect(useStore.getState().chattingSessions).toHaveLength(0));
    expect(seams.finish.mock.calls[0][1]).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'user', sourceMessageId: widget.id, text: expect.stringContaining('UTF-8') })]));
    const persisted = await historyStore.getSession('__default__', useStore.getState().activeSessionId!);
    expect(persisted?.messages.find((message) => message.id === widget.id)?.interactionAnswer?.values).toEqual(['UTF-8']);
  });
  it('forwards exact persisted source and finishes only with real terminal messages', async () => {
    expect(useStore.getState().sendPrompt('Remember the exact project fact.')).toBe(true);
    await vi.waitFor(() => expect(useStore.getState().chattingSessions).toHaveLength(0));
    expect(seams.begin).toHaveBeenCalledTimes(1);
    const options = seams.begin.mock.calls[0][0];
    const user = useStore.getState().messages.find((message) => message.role === 'user')!;
    expect(options.source).toMatchObject({ hostId: 'local', namespaceId: 'local', workspaceId: '__default__', sessionId: useStore.getState().activeSessionId, turnId: user.id, sourceMessageId: user.id });
    await expect(options.ready).resolves.toBeUndefined();
    expect(seams.finish.mock.calls[0][0]).toBe('completed');
    expect(seams.finish.mock.calls[0][1]).toEqual(expect.arrayContaining([expect.objectContaining({ id: user.id, text: user.text }), expect.objectContaining({ role: 'assistant', text: expect.stringContaining('Task completed.') })]));
  });
  it('passes the same session freeze key to full and compact production calls', async () => {
    useStore.getState().sendPrompt('Inspect frozen memory.');
    await vi.waitFor(() => expect(useStore.getState().chattingSessions).toHaveLength(0));
    expect(seams.compact.mock.calls[0][2]).toBe(seams.full.mock.calls[0][1]);
  });
});
