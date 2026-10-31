import { afterEach, expect, it, vi } from 'vitest';
import { useStore, persistSkillLearningStateForSource, retryPersistedSkillLearning } from './useStore';
import { historyStore } from './history/store';
import { requestExplicitSkillLearning, cancelSkillLearning } from '@/lib/skillLearningDesktop';
import * as reviewGateway from '@/lib/modelGateway/skillReviewGateway';
import { DEFAULT_SKILL_LEARNING_CONFIG, saveSkillLearningConfig } from '@/lib/skillLearningConfig';
import { readPersistedSkillSourceSession } from '@/lib/skills';
import type { SkillMutationResult, SkillReviewState } from '@/runtime/skills/types';
import type { SessionRecord } from './history/types';

const previous = Object.getOwnPropertyDescriptor(window, '__TAURI_INTERNALS__');
afterEach(() => {
  cancelSkillLearning();
  vi.restoreAllMocks();
  window.localStorage.clear();
  if (previous) Object.defineProperty(window, '__TAURI_INTERNALS__', previous);
  else Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
});

/** Real scheduler/writer/fresh reader; native bytes never alias historyStore's cache. */
async function generatedSource() {
  const origin = { hostId: 'local', workspaceId: `public-retry-${crypto.randomUUID()}`, sessionId: 'original-session',
    turnId: 'original-turn', runId: 'source-execution-run', cwd: 'E:/Original-Source' };
  const relPath = `workspaces/${origin.workspaceId}/sessions/${origin.sessionId}.json`;
  const bytes = new Map<string, string>();
  let discardWrites = false;
  const ipc = vi.fn(async (command: string, payload: Record<string, unknown> = {}): Promise<unknown> => {
    if (command === 'history_read_json') return bytes.get(String(payload.relPath)) ?? null;
    if (command === 'history_write_json') { if (!discardWrites) bytes.set(String(payload.relPath), String(payload.json)); return; }
    if (command === 'history_list_dir') return [];
    if (command === 'skills_bind_run' || command === 'skills_revoke_run') return;
    if (command === 'skills_request') {
      const request = payload.request as { action: string };
      if (request.action === 'list') return { revision: 'native-empty', entries: [] };
      if (request.action === 'history') return { results: [] };
    }
    throw new Error(`Unexpected retry IPC ${command}`);
  });
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: { invoke: ipc } });
  const record: SessionRecord = { id: origin.sessionId, workspaceId: origin.workspaceId, title: 'Saved retry source',
    isWorkflow: false, createdAt: 1, updatedAt: 1, messages: [{ id: origin.turnId, role: 'user',
      text: '以后必须先读取真实来源再重试。', createdAt: 1, skillContext: { origin, loadedSkills: [], catalogRevision: '' } }] };
  bytes.set(relPath, JSON.stringify(record));
  const config = { ...DEFAULT_SKILL_LEARNING_CONFIG, mode: 'approve-all' as const, activityThreshold: 1, cooldownMs: 0 };
  saveSkillLearningConfig(config, origin.workspaceId);
  const requests: { task: { userText: string } }[] = [];
  const complete = vi.fn().mockRejectedValueOnce(new Error('Original review HTTP failed')).mockImplementation(async (request) => {
    requests.push(JSON.parse(request.userContent));
    return { text: JSON.stringify({ version: 1, kind: 'noop', reason: 'insufficient-evidence' }) };
  });
  vi.spyOn(reviewGateway, 'createSkillReviewModelPort').mockReturnValue({ capability: 'completion-only', complete });
  let writes = Promise.resolve();
  await requestExplicitSkillLearning({ origin, kind: 'learn', text: record.messages[0].text,
    selection: { adapter: 'codex', modelClass: 'saved-review-model' }, config,
    onState: (state: SkillReviewState) => { writes = writes.then(() => persistSkillLearningStateForSource(origin, state)); } });
  await writes;
  const savedRecord = JSON.parse(bytes.get(relPath)!) as SessionRecord;
  const message = savedRecord.messages.find((item) => item.skillLearning)!;
  const state = message.skillLearning!;
  expect(state.status).toBe('failed');
  expect(state.origin.runId).not.toBe(origin.runId);
  expect(state.resume!.job.origin).toEqual(origin);
  useStore.setState({ activeWorkspaceId: origin.workspaceId, activeSessionId: origin.sessionId, messages: savedRecord.messages });
  const cached = (await historyStore.getSession(origin.workspaceId, origin.sessionId))!;
  const cachedState = cached.messages.find((item) => item.id === message.id)!.skillLearning!;
  return { origin, state, message, cached, cachedState, bytes, relPath, complete, ipc, requests,
    discard: () => { discardWrites = true; } };
}

it('preserves original source/config/evidence/selection with a new review run', async () => {
  const { origin, state, complete, requests } = await generatedSource();
  await retryPersistedSkillLearning(state);
  const native = await readPersistedSkillSourceSession(origin.workspaceId, origin.sessionId);
  const retried = native!.messages.find((item) => item.skillLearning?.status === 'noop')!.skillLearning!;
  expect(complete).toHaveBeenCalledTimes(2);
  expect(retried.origin.runId).not.toBe(state.origin.runId);
  expect(retried.origin.runId).not.toBe(origin.runId);
  expect(retried.resume).toEqual(state.resume);
  expect(retried.mode).toBe(state.mode);
  expect(requests[0].task.userText).toBe(state.resume!.job.userText);
});

it('rejects a cache-only replacement of the supplied native resume snapshot before billing', async () => {
  const { state, cachedState, complete } = await generatedSource();
  cachedState.resume!.job.userText = 'CACHE SUBSTITUTE: not the supplied saved source';
  cachedState.resume!.selection.modelClass = 'cache-substitute-model';
  await expect(retryPersistedSkillLearning(state)).rejects.toThrow();
  expect(complete).toHaveBeenCalledOnce();
});

it('does not acknowledge an unwritten retry or publish a saved noop in chat', async () => {
  const { origin, state, bytes, relPath, complete, discard } = await generatedSource();
  const before = bytes.get(relPath)!;
  discard();
  let failure: unknown;
  try { await retryPersistedSkillLearning(state); } catch (cause) { failure = cause; }
  expect(String(failure)).toMatch(/SKILL_(?:RETRY_STATE|HISTORY_SAVE|RESULT_NOT_PERSISTED).*UNCONFIRMED|SKILL_RESULT_NOT_PERSISTED/);
  expect(String(failure)).toContain(state.error!);
  const native = await readPersistedSkillSourceSession(origin.workspaceId, origin.sessionId);
  expect(complete).toHaveBeenCalledTimes(2);
  expect(bytes.get(relPath)).toBe(before);
  expect(native!.messages.some((item) => item.skillLearning?.status === 'noop')).toBe(false);
  expect(useStore.getState().messages.some((item) => item.skillLearning?.status === 'noop')).toBe(false);
});

it('retains an actual applied host result separately when history bytes were not written', async () => {
  const { origin, state, bytes, relPath, complete, ipc, discard } = await generatedSource();
  const before = bytes.get(relPath)!;
  const invoke = ipc.getMockImplementation()!;
  const committed: SkillMutationResult[] = [];
  ipc.mockImplementation(async (command, payload = {}) => {
    if (command === 'skills_request') {
      const request = payload.request as { action: string; origin: SkillMutationResult['origin'] };
      if (request.action === 'manage') {
        const result: SkillMutationResult = { status: 'applied', batchId: 'real-host-batch', origin: request.origin,
          operationsApplied: 1, lesson: 'Read the source.', changes: [], riskReasons: [], rollbackId: 'real-host-rollback' };
        committed.push(structuredClone(result));
        return result;
      }
    }
    return invoke(command, payload);
  });
  complete.mockImplementation(async (request) => {
    const evidence = JSON.parse(request.userContent).evidence;
    return { text: JSON.stringify({ version: 1, kind: 'propose', lesson: 'Read the source.',
      evidenceIds: [evidence[0].evidenceId], operations: [{ action: 'create', name: 'read-source-first',
        content: '---\nname: read-source-first\ndescription: Read the source first.\n---\nRead exact source bytes before retry.' }] }) };
  });
  discard();
  let failure: unknown;
  try { await retryPersistedSkillLearning(state); } catch (cause) { failure = cause; }
  expect(committed).toHaveLength(1);
  expect(failure).toMatchObject({ result: { ...committed[0], usage: { calls: 1 } }, recordingError: expect.stringContaining('UNCONFIRMED') });
  expect(complete).toHaveBeenCalledTimes(2);
  expect(bytes.get(relPath)).toBe(before);
  expect((await readPersistedSkillSourceSession(origin.workspaceId, origin.sessionId))!.messages.some((item) => item.skillLearning?.status === 'applied')).toBe(false);
  expect(useStore.getState().messages.some((item) => item.skillLearning?.status === 'applied')).toBe(false);
});

it('still persists the actual terminal result when an earlier progress write was unconfirmed', async () => {
  const { origin, state, bytes, relPath, complete, ipc } = await generatedSource();
  const invoke = ipc.getMockImplementation()!;
  let skippedProgress = false;
  ipc.mockImplementation(async (command, payload = {}) => {
    if (!skippedProgress && command === 'history_write_json' && payload.relPath === relPath) {
      skippedProgress = true; return;
    }
    return invoke(command, payload);
  });
  await expect(retryPersistedSkillLearning(state)).resolves.toBeUndefined();
  expect(skippedProgress).toBe(true);
  expect(complete).toHaveBeenCalledTimes(2);
  const native = await readPersistedSkillSourceSession(origin.workspaceId, origin.sessionId);
  expect(native!.messages.filter((item) => item.skillLearning?.status === 'noop')).toHaveLength(1);
  expect(JSON.parse(bytes.get(relPath)!).messages.some((item: { skillLearning?: SkillReviewState }) => item.skillLearning?.status === 'noop')).toBe(true);
});

it('rechecks the exact final review after its writer acknowledged a now-stale read', async () => {
  const { state, bytes, relPath, complete, ipc } = await generatedSource();
  const invoke = ipc.getMockImplementation()!;
  let changed = false;
  ipc.mockImplementation(async (command, payload = {}) => {
    const value = await invoke(command, payload);
    if (command === 'history_read_json' && payload.relPath === relPath && typeof value === 'string' && !changed) {
      const record = JSON.parse(value) as SessionRecord;
      const terminal = record.messages.find((item) => item.skillLearning?.status === 'noop')?.skillLearning;
      if (terminal) {
        changed = true;
        terminal.error = 'Concurrent native edit after writer readback';
        bytes.set(relPath, JSON.stringify(record));
      }
    }
    return value;
  });
  await expect(retryPersistedSkillLearning(state)).rejects.toThrow(/SKILL_HISTORY_SAVE_UNCONFIRMED/);
  expect(changed).toBe(true);
  expect(complete).toHaveBeenCalledTimes(2);
});

const snapshotMutations: [string, (state: SkillReviewState) => void][] = [
  ...(['hostId', 'workspaceId', 'sessionId', 'turnId', 'runId', 'cwd'] as const).map((field): [string, (state: SkillReviewState) => void] =>
    [`resume source ${field}`, (state) => { state.resume!.job.origin[field] = 'foreign-source'; }]),
  ['review status', (state) => { state.status = 'conflicted'; }],
  ['review mode', (state) => { state.mode = 'auto-safe'; }],
  ['review diagnostic', (state) => { state.error = 'Different stored review'; }],
  ['literal text', (state) => { state.resume!.job.userText += ' '; }],
  ['answer', (state) => { state.resume!.job.finalAnswer = 'Foreign answer'; }],
  ['config', (state) => { state.resume!.job.config.maxRounds += 1; }],
  ['evidence', (state) => { state.resume!.job.evidence[0].summary += ' '; }],
  ['selection', (state) => { state.resume!.selection.modelClass = 'foreign-model'; }],
  ['source locator', (state) => { state.sourceSession = { workspaceId: 'foreign', sessionId: state.origin.sessionId, serverUrl: 'https://foreign.invalid' }; }],
  ['host result', (state) => { state.result!.operationsApplied += 1; }],
];

it.each(snapshotMutations)('rejects cache-only changes to %s', async (_field, mutate) => {
  const { state, cachedState, complete } = await generatedSource();
  mutate(cachedState);
  await expect(retryPersistedSkillLearning(state)).rejects.toThrow();
  expect(complete).toHaveBeenCalledOnce();
});

it.each(snapshotMutations)('rejects native-only changes to %s', async (_field, mutate) => {
  const { state, bytes, relPath, message, complete } = await generatedSource();
  const native = JSON.parse(bytes.get(relPath)!) as SessionRecord;
  mutate(native.messages.find((item) => item.id === message.id)!.skillLearning!);
  bytes.set(relPath, JSON.stringify(native));
  await expect(retryPersistedSkillLearning(state)).rejects.toThrow();
  expect(complete).toHaveBeenCalledOnce();
});

it('compares the supplied state even when native and cache agree on a replacement', async () => {
  const { state, cachedState, bytes, relPath, complete } = await generatedSource();
  cachedState.resume!.job.userText = 'Replacement agreed by both stores';
  const native = JSON.parse(bytes.get(relPath)!) as SessionRecord;
  native.messages.find((item) => item.skillLearning)!.skillLearning = structuredClone(cachedState);
  bytes.set(relPath, JSON.stringify(native));
  await expect(retryPersistedSkillLearning(state)).rejects.toThrow();
  expect(complete).toHaveBeenCalledOnce();
});

it.each(['cache', 'native'] as const)('rejects duplicate review message IDs in %s', async (storage) => {
  const { state, cached, message, bytes, relPath, complete } = await generatedSource();
  const record = storage === 'cache' ? cached : JSON.parse(bytes.get(relPath)!) as SessionRecord;
  record.messages.push({ ...structuredClone(message), skillLearning: undefined });
  if (storage === 'native') bytes.set(relPath, JSON.stringify(record));
  await expect(retryPersistedSkillLearning(state)).rejects.toThrow();
  expect(complete).toHaveBeenCalledOnce();
});

function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  return value !== null && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverseObjectKeys(item)])) : value;
}

it('accepts reordered native object keys without relaxing literal or array equality', async () => {
  const { state, bytes, relPath, complete } = await generatedSource();
  bytes.set(relPath, JSON.stringify(reverseObjectKeys(JSON.parse(bytes.get(relPath)!))));
  await expect(retryPersistedSkillLearning(state)).resolves.toBeUndefined();
  expect(complete).toHaveBeenCalledTimes(2);
});

it('rejects reordered evidence arrays rather than treating them as unordered object keys', async () => {
  const { origin, state, bytes, relPath, message, complete } = await generatedSource();
  state.resume!.job.evidence.push({ ...structuredClone(state.resume!.job.evidence[0]), evidenceId: 'second-evidence' });
  await persistSkillLearningStateForSource(origin, state);
  const native = JSON.parse(bytes.get(relPath)!) as SessionRecord;
  native.messages.find((item) => item.id === message.id)!.skillLearning!.resume!.job.evidence.reverse();
  bytes.set(relPath, JSON.stringify(native));
  await expect(retryPersistedSkillLearning(state)).rejects.toThrow();
  expect(complete).toHaveBeenCalledOnce();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

it('freezes all supplied input before waiting for native history', async () => {
  const { origin, state, complete, ipc, relPath, requests } = await generatedSource();
  const original = structuredClone(state);
  const gate = deferred();
  const entered = deferred();
  const invoke = ipc.getMockImplementation()!;
  ipc.mockImplementation(async (command, payload = {}) => {
    if (command === 'history_read_json' && payload.relPath === relPath) { entered.resolve(); await gate.promise; }
    return invoke(command, payload);
  });
  const retry = retryPersistedSkillLearning(state);
  await entered.promise;
  state.origin.runId = 'mutated-review';
  state.origin.workspaceId = 'mutated-workspace';
  state.resume!.job.origin.sessionId = 'mutated-session';
  state.resume!.job.userText = 'Mutable caller replacement';
  state.resume!.selection.modelClass = 'mutated-model';
  state.status = 'applied';
  gate.resolve();
  await retry;
  expect(complete).toHaveBeenCalledTimes(2);
  expect(requests[0].task.userText).toBe(original.resume!.job.userText);
  const native = await readPersistedSkillSourceSession(origin.workspaceId, origin.sessionId);
  expect(native!.messages.find((item) => item.skillLearning?.status === 'noop')!.skillLearning!.resume).toEqual(original.resume);
});

it('rejects cache changes made while the native history read is pending', async () => {
  const { state, cachedState, complete, ipc, relPath } = await generatedSource();
  const gate = deferred();
  const entered = deferred();
  const invoke = ipc.getMockImplementation()!;
  ipc.mockImplementation(async (command, payload = {}) => {
    if (command === 'history_read_json' && payload.relPath === relPath) { entered.resolve(); await gate.promise; }
    return invoke(command, payload);
  });
  const retry = retryPersistedSkillLearning(state);
  const outcome = expect(retry).rejects.toThrow();
  await entered.promise;
  cachedState.resume!.selection.modelClass = 'changed-during-await';
  gate.resolve();
  await outcome;
  expect(complete).toHaveBeenCalledOnce();
});

it('rejects a replaced cache record while the native history read is pending', async () => {
  const { origin, state, cachedState, message, complete, ipc, relPath, discard } = await generatedSource();
  const gate = deferred();
  const entered = deferred();
  const invoke = ipc.getMockImplementation()!;
  let firstRead = true;
  ipc.mockImplementation(async (command, payload = {}) => {
    if (firstRead && command === 'history_read_json' && payload.relPath === relPath) {
      firstRead = false; entered.resolve(); await gate.promise;
    }
    return invoke(command, payload);
  });
  const retry = retryPersistedSkillLearning(state);
  const outcome = expect(retry).rejects.toThrow();
  await entered.promise;
  discard();
  const replacement = structuredClone(cachedState);
  replacement.resume!.selection.modelClass = 'replaced-during-await';
  await historyStore.upsertMessage(origin.workspaceId, origin.sessionId, { ...message, skillLearning: replacement }, true);
  gate.resolve();
  await outcome;
  expect(complete).toHaveBeenCalledOnce();
});

it('does not bill or acknowledge a persisted retry after current policy disables learning', async () => {
  const { origin, state, bytes, relPath, complete } = await generatedSource();
  const before = bytes.get(relPath)!;
  saveSkillLearningConfig({ ...DEFAULT_SKILL_LEARNING_CONFIG, enabled: false }, origin.workspaceId);
  await expect(retryPersistedSkillLearning(state)).rejects.toMatchObject({
    recordingError: expect.stringContaining('UNCONFIRMED'), result: { status: 'noop', operationsApplied: 0 },
  });
  expect(complete).toHaveBeenCalledOnce();
  expect(bytes.get(relPath)).toBe(before);
});

it('admits one model review for concurrent retries and never automatically rebills', async () => {
  const { state, complete } = await generatedSource();
  const gate = deferred();
  const entered = deferred();
  complete.mockImplementation(async () => {
    entered.resolve(); await gate.promise;
    return { text: JSON.stringify({ version: 1, kind: 'noop', reason: 'insufficient-evidence' }) };
  });
  const first = retryPersistedSkillLearning(state);
  const second = retryPersistedSkillLearning(structuredClone(state));
  await entered.promise;
  gate.resolve();
  await Promise.all([first, second]);
  expect(complete).toHaveBeenCalledTimes(2);
  await Promise.resolve();
  expect(complete).toHaveBeenCalledTimes(2);
});
