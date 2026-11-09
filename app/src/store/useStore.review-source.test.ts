import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { simpleBlueprint } from '@/core/defaultBlueprint';
import { defaultComposer } from './sampleSessions';

const boundary = vi.hoisted(() => ({ native: true, invoke: vi.fn(), complete: vi.fn(), resolve: vi.fn(), review: vi.fn() }));
vi.mock('@/lib/tauri', async (original) => ({
  ...await original<typeof import('@/lib/tauri')>(), tauriAvailable: () => boundary.native,
  isTauri: () => false,
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: boundary.invoke }));
vi.mock('@/lib/modelGateway/modelGateway', async (original) => ({
  ...await original<typeof import('@/lib/modelGateway/modelGateway')>(),
  completeGatewayText: boundary.complete, resolveDirectGatewayRoute: boundary.resolve,
}));
vi.mock('@/lib/memoryRefresh', async (original) => ({
  ...await original<typeof import('@/lib/memoryRefresh')>(),
  makeReviewInvoker: () => Object.assign(async () => '', { usage: { calls: 0, inputTokens: 0, outputTokens: 0, estimated: true } }),
}));
vi.mock('@/lib/memoryConsolidate', async (original) => ({
  ...await original<typeof import('@/lib/memoryConsolidate')>(), runConsolidatingReview: boundary.review,
}));
import { useStore, persistReviewSourceMessage, assertPersistedReviewSourceMessage, __resetSimpleChatRuntimeForTests } from './useStore';
import { historyStore } from './history/store';
import { cancelSkillLearning } from '@/lib/skillLearningDesktop';
import { activeAiEdits, aiEditSnapshots } from './channelRegistry';
import { DEFAULT_MEMORY_CONFIG, saveMemoryConfig, loadMemoryReviewJournal } from '@/lib/memoryConfig';
import * as memoryReviewDesktop from '@/lib/memoryReviewDesktop';

const prefix = 'ultragamestudio.history.v1:';
let originalTauriInternals: PropertyDescriptor | undefined;
function children(path: string) {
  const start = prefix + (path ? path + '/' : '');
  return [...new Set(Object.keys(localStorage).filter((key) => key.startsWith(start))
    .map((key) => key.slice(start.length).split('/')[0]))];
}
beforeEach(async () => {
  __resetSimpleChatRuntimeForTests(); activeAiEdits.clear(); aiEditSnapshots.clear(); localStorage.clear();
  boundary.native = true;
  boundary.review.mockReset().mockResolvedValue({ appliedOps: 0, queuedOps: 0, lastErrors: [] });
  originalTauriInternals = Object.getOwnPropertyDescriptor(window, '__TAURI_INTERNALS__');
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: { invoke: boundary.invoke } });
  boundary.invoke.mockReset().mockImplementation(async (command: string, payload: Record<string, unknown> = {}) => {
    if (command === 'history_read_json') return localStorage.getItem(prefix + payload.relPath);
    if (command === 'history_write_json') { localStorage.setItem(prefix + payload.relPath, String(payload.json)); return; }
    if (command === 'history_list_dir') return children(String(payload.relPath ?? ''));
    if (command === 'memory_read_json') return localStorage.getItem('ultragamestudio.memory.v1:' + payload.relPath);
    if (command === 'memory_compare_exchange_json') {
      const key = 'ultragamestudio.memory.v1:' + payload.relPath;
      if (localStorage.getItem(key) !== payload.expectedJson) throw new Error('Fixture memory CAS conflict');
      localStorage.setItem(key, String(payload.json)); return payload.json;
    }
    if (command === 'history_root') return 'memory://source-producer';
    if (command === 'skills_bind_run' || command === 'skills_revoke_run') return;
    if (command === 'skills_request') return { revision: 'empty', entries: [] };
    throw new Error(`Fixture IPC unavailable: ${command}`);
  });
  boundary.resolve.mockReset().mockReturnValue({ adapter: 'codex', modelClass: 'default', model: 'fixture',
    mode: 'direct', transport: 'openai-compatible', label: 'Fixture', source: 'global' });
  boundary.complete.mockReset().mockResolvedValue('Task completed.');
  const session = await historyStore.createSession({ workspaceId: '__default__', id: `source-${crypto.randomUUID()}`,
    isWorkflow: false, messages: [], title: 'Source' });
  useStore.setState({ ...useStore.getInitialState(), workflow: simpleBlueprint('Source'), composer: { ...defaultComposer },
    historyReady: true, activeWorkspaceId: session.workspaceId, activeSessionId: session.id,
    mode: 'design', aiStreaming: false, aiEditingSessions: [], chattingSessions: [], runningSessions: [],
    waitingInputSessions: [], messages: [], workspaces: [], sessions: [], sessionTree: {}, personalInstructions: '' });
});
afterEach(() => {
  cancelSkillLearning(); __resetSimpleChatRuntimeForTests(); activeAiEdits.clear(); aiEditSnapshots.clear();
  boundary.native = false; vi.restoreAllMocks();
  if (originalTauriInternals) Object.defineProperty(window, '__TAURI_INTERNALS__', originalTauriInternals);
  else Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
});
const hostCalls = () => boundary.invoke.mock.calls.filter(([command]) => String(command).startsWith('skills_') && command !== 'skills_revoke_run');

describe('real sendPrompt source persistence barrier', () => {
  it('releases both native foreground owners before admitting same-turn memory review', async () => {
    const realBegin = memoryReviewDesktop.beginMemoryReviewTurn;
    let completion: Promise<unknown> | undefined;
    const begin = vi.spyOn(memoryReviewDesktop, 'beginMemoryReviewTurn').mockImplementation((options) => {
      const turn = realBegin(options);
      return { ...turn, finish: (...args) => { const result = turn.finish(...args); completion = result; return result; } };
    });
    saveMemoryConfig({ ...DEFAULT_MEMORY_CONFIG, writeEnabled: true, reviewEnabled: true,
      reviewMinMessages: 2, reviewMinIntervalMinutes: 0 });
    expect(useStore.getState().sendPrompt('Review this exact persisted task fact.')).toBe(true);
    await vi.waitFor(() => expect(useStore.getState().chattingSessions).toHaveLength(0));
    expect(begin.mock.calls.map(([options]) => options.config)).toEqual([
      expect.objectContaining({ reviewEnabled: true, writeEnabled: true }),
    ]);
    const outcome = await completion as memoryReviewDesktop.MemoryReviewOutcome | undefined;
    expect(outcome?.error).toBeUndefined();
    expect(outcome).toMatchObject({ phase: 'noop', appliedOps: 0, queuedOps: 0 });
    expect(boundary.review).toHaveBeenCalledTimes(1);
    const { value } = await loadMemoryReviewJournal();
    expect(value.jobs).toHaveLength(1);
    expect(value.jobs[0]).toMatchObject({ phase: 'noop', appliedOps: 0, queuedOps: 0 });
    expect(value.jobs[0].source.sourceMessageId).toBe(useStore.getState().messages.find((message) => message.role === 'user')!.id);
  });
  it('rejects a changed multimodal source even when its saved text and ID match', async () => {
    const source = { workspaceId: useStore.getState().activeWorkspaceId, sessionId: useStore.getState().activeSessionId };
    const message = { id: 'source-image', role: 'user' as const, text: 'Inspect this image.', createdAt: 1,
      content: [{ type: 'image_url' as const, image_url: { url: 'data:image/png;base64,original' } }] };
    await historyStore.appendMessage(source.workspaceId!, source.sessionId!, message);
    const changed = structuredClone(message); changed.content[0].image_url.url = 'data:image/png;base64,different';
    await expect(assertPersistedReviewSourceMessage(source, changed)).rejects.toThrow('SKILL_SOURCE_MESSAGE_NOT_PERSISTED');
  });

  it('freezes the expected source before an asynchronous readback', async () => {
    const source = { workspaceId: useStore.getState().activeWorkspaceId, sessionId: useStore.getState().activeSessionId };
    const message = { id: 'source-snapshot', role: 'user' as const, text: 'Original source.', createdAt: 1 };
    await historyStore.appendMessage(source.workspaceId!, source.sessionId!, message);
    const record = structuredClone((await historyStore.getSession(source.workspaceId!, source.sessionId!))!);
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const invoke = boundary.invoke.getMockImplementation()!;
    boundary.invoke.mockImplementation(async (command, payload = {}) => {
      if (command === 'history_read_json' && String(payload.relPath).endsWith(`/${record.id}.json`)) {
        await wait; return JSON.stringify(record);
      }
      return invoke(command, payload);
    });
    const ready = assertPersistedReviewSourceMessage(source, message);
    message.text = 'Changed after the fence.';
    source.sessionId = 'different-session';
    release();
    await expect(ready).resolves.toBeUndefined();
  });

  it('freezes append content and its bucket while the storage write is pending', async () => {
    const source = { workspaceId: useStore.getState().activeWorkspaceId, sessionId: useStore.getState().activeSessionId };
    const original = { ...source };
    const message = { id: 'delayed-source', role: 'user' as const, text: 'Literal original source.', createdAt: 1 };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const append = historyStore.appendMessage.bind(historyStore);
    vi.spyOn(historyStore, 'appendMessage').mockImplementation(async (...args) => { await gate; await append(...args); });
    const ready = persistReviewSourceMessage(source, message);
    message.text = 'Mutated UI text.'; source.sessionId = 'unrelated-session'; release();
    await ready;
    const saved = await historyStore.getSession(original.workspaceId!, original.sessionId!);
    expect(saved?.messages.find((item) => item.id === 'delayed-source')?.text).toBe('Literal original source.');
  });

  it('rejects a swallowed browser storage write rather than trusting the cache', async () => {
    boundary.native = false;
    const source = { workspaceId: useStore.getState().activeWorkspaceId, sessionId: useStore.getState().activeSessionId };
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Quota failed', 'QuotaExceededError'); });
    await expect(persistReviewSourceMessage(source, { id: 'quota-source', role: 'user', text: 'Literal source.', createdAt: 1 }))
      .rejects.toThrow('SKILL_SOURCE_MESSAGE_NOT_PERSISTED');
  });

  it('does not treat the optimistic history cache as successful native readback', async () => {
    const sessionId = useStore.getState().activeSessionId!;
    const invoke = boundary.invoke.getMockImplementation()!;
    boundary.invoke.mockImplementation(async (command, payload = {}) => {
      if (command === 'history_write_json' && String(payload.relPath).endsWith(`/${sessionId}.json`)) return;
      return invoke(command, payload);
    });
    expect(useStore.getState().sendPrompt('Verify the actual persisted source.')).toBe(true);
    await vi.waitFor(() => expect(useStore.getState().chattingSessions).toHaveLength(0));
    expect(hostCalls()).toEqual([]);
    expect(useStore.getState().messages.some((message) => message.text.includes('技能来源不可用'))).toBe(false);
    expect(boundary.complete.mock.calls.some(([request]) => request.runId)).toBe(true);
  });

  it('never grants skill reads or review when append fails in an existing session', async () => {
    const append = vi.spyOn(historyStore, 'appendMessage').mockRejectedValue(new Error('SOURCE_APPEND_FAILED'));
    expect(useStore.getState().sendPrompt('Verify source durability.')).toBe(true);
    await vi.waitFor(() => expect(useStore.getState().chattingSessions).toHaveLength(0));
    expect(append).toHaveBeenCalled();
    expect(hostCalls()).toEqual([]);
    expect(useStore.getState().messages.some((message) => message.text.includes('技能来源不可用'))).toBe(false);
    expect(boundary.complete.mock.calls.some(([request]) => request.runId)).toBe(true);
  });
});
