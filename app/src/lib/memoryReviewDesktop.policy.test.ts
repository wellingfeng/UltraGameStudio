import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Isolate the completion-only network boundary; review/store/queue stay real.
const seams = vi.hoisted(() => ({ make: vi.fn(), invoke: vi.fn() }));
vi.mock('./tauri', () => ({ tauriAvailable: () => false }));
vi.mock('./memoryRefresh', () => ({ makeReviewInvoker: seams.make }));
vi.mock('./gatewayConfig', () => ({
  getExplicitActiveGatewaySelection: () => ({ adapter: 'codex', modelClass: 'policy-fixture' }),
  getDefaultGatewaySelection: () => ({ adapter: 'codex', modelClass: 'policy-fixture' }),
}));
import { beginMemoryReviewTurn } from './memoryReviewDesktop';
import { DEFAULT_MEMORY_CONFIG, loadMemoryReviewJournal, saveMemoryConfig } from './memoryConfig';
import { resetGenerationSettingsStoreForTests, writeSettingsRaw } from './generationSettingsStore';
import { loadMemory, readMemoryBase } from './memoryStore';
import * as memoryStore from './memoryStore';
import { withMemoryLock } from './memoryTransactions';
import { listPendingMemoryWrites, resolvePendingMemoryWrites } from './memoryPending';

const policy = { reviewEnabled: true, writeEnabled: true, reviewMinMessages: 2, reviewMinIntervalMinutes: 0 };
const source = (id: string) => ({ hostId: 'local', namespaceId: 'local', workspaceId: 'policy-workspace',
  sessionId: id, turnId: 'user', sourceMessageId: 'user', runId: id });
const messages = [{ id: 'user', role: 'user', text: 'A durable user preference from the original turn.' },
  { id: 'answer', role: 'assistant', text: 'Completed.' }];
const proposal = '<<UGS_MEMORY>>{"target":"user","operations":[{"action":"add","content":"original proposed fact"}]}<<UGS_MEMORY_END>>';
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => {
  localStorage.clear(); resetGenerationSettingsStoreForTests();
  saveMemoryConfig({ ...DEFAULT_MEMORY_CONFIG, ...policy });
  seams.invoke.mockReset(); seams.make.mockReset();
  Object.defineProperty(seams.invoke, 'usage', { configurable: true,
    get: () => ({ calls: seams.invoke.mock.calls.length, inputTokens: 100, outputTokens: 20, estimated: true }) });
  seams.make.mockReturnValue(seams.invoke);
});
afterEach(() => vi.restoreAllMocks());

describe('live autonomous memory submission policy (real review/store/queue)', () => {
  it('preserves the real applied result when cancellation follows a browser commit', async () => {
    const controller = new AbortController(); const set = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, name, raw) {
      set.call(this, name, raw);
      if (name === 'ultragamestudio.memory.v1:memories/user.json') controller.abort();
    });
    seams.invoke.mockResolvedValue(proposal);
    expect(await beginMemoryReviewTurn({ source: source('cancel-after-commit'), config: policy, messages,
      signal: controller.signal, ready: Promise.resolve() }).finish('completed')).toMatchObject({ phase: 'applied', appliedOps: 1, queuedOps: 0 });
    expect((await loadMemory('user')).map((entry) => entry.text)).toEqual(['original proposed fact']);
    expect(seams.invoke).toHaveBeenCalledTimes(1);
    expect(await listPendingMemoryWrites()).toEqual([]);
  });

  it('preserves the first commit and surfaces a failed second-library stage without rebilling', async () => {
    const key = 'ultragamestudio.memory.v1:memories/pending.json'; const raw = '{bad queue';
    localStorage.setItem(key, raw);
    const set = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, name, value) {
      set.call(this, name, value);
      if (name === 'ultragamestudio.memory.v1:memories/user.json') {
        saveMemoryConfig({ ...DEFAULT_MEMORY_CONFIG, ...policy, approvalRequired: true });
      }
    });
    seams.invoke.mockResolvedValue(proposal + '<<UGS_MEMORY>>{"target":"memory","operations":[{"action":"add","content":"second library proposal"}]}<<UGS_MEMORY_END>>');
    const original = source('failed-second-stage');
    expect(await beginMemoryReviewTurn({ source: original, config: policy, messages,
      ready: Promise.resolve() }).finish('completed')).toMatchObject({ phase: 'applied', appliedOps: 1, queuedOps: 0, error: expect.any(String) });
    expect((await loadMemory('user')).map((entry) => entry.text)).toEqual(['original proposed fact']);
    expect(await loadMemory('memory', original.workspaceId)).toEqual([]);
    expect(localStorage.getItem(key)).toBe(raw);
    expect(seams.invoke).toHaveBeenCalledTimes(1);
  });

  it('retains original approval after live settings relax during the model await', async () => {
    saveMemoryConfig({ ...DEFAULT_MEMORY_CONFIG, ...policy, approvalRequired: true });
    const entered = deferred<void>(); const model = deferred<string>();
    seams.invoke.mockImplementation(() => { entered.resolve(); return model.promise; });
    const pending = beginMemoryReviewTurn({ source: source('original-strict'), config: policy, messages,
      ready: Promise.resolve() }).finish('completed');
    try {
      await entered.promise;
      saveMemoryConfig({ ...DEFAULT_MEMORY_CONFIG, ...policy, approvalRequired: false });
      model.resolve(proposal);
      expect(await pending).toMatchObject({ phase: 'awaiting_approval', appliedOps: 0, queuedOps: 1 });
      expect(seams.invoke).toHaveBeenCalledTimes(1);
      expect(await loadMemory('user')).toEqual([]);
      expect(await listPendingMemoryWrites()).toHaveLength(1);
    } finally { model.resolve(proposal); await pending; }
  });

  it.each([2, 3])('rechecks approval during library read %i including the final browser CAS read', async (atRead) => {
    const key = 'ultragamestudio.memory.v1:memories/user.json';
    const get = Storage.prototype.getItem; const set = Storage.prototype.setItem;
    let reads = 0; let tightened = false; const mutations: string[] = [];
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, name) {
      const raw = get.call(this, name);
      if (name === key && ++reads === atRead) {
        tightened = true;
        saveMemoryConfig({ ...DEFAULT_MEMORY_CONFIG, ...policy, approvalRequired: true });
      }
      return raw;
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, name, raw) {
      if (name === key) mutations.push(raw);
      set.call(this, name, raw);
    });
    seams.invoke.mockResolvedValue(proposal);
    const pending = beginMemoryReviewTurn({ source: source(`read-${atRead}`), config: policy, messages,
      ready: Promise.resolve() }).finish('completed');
    expect(await pending).toMatchObject({ phase: 'awaiting_approval', appliedOps: 0, queuedOps: 1 });
    expect(tightened).toBe(true);
    expect(mutations).toEqual([]);
    expect(seams.invoke).toHaveBeenCalledTimes(1);
    expect(await loadMemory('user')).toEqual([]);
    expect(await listPendingMemoryWrites()).toHaveLength(1);
  });

  it('stages only the undispatched second library after approval tightens on the first commit', async () => {
    const set = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, name, raw) {
      set.call(this, name, raw);
      if (name === 'ultragamestudio.memory.v1:memories/user.json') {
        saveMemoryConfig({ ...DEFAULT_MEMORY_CONFIG, ...policy, approvalRequired: true });
      }
    });
    seams.invoke.mockResolvedValue(proposal + '<<UGS_MEMORY>>{"target":"memory","operations":[{"action":"add","content":"second library proposal"}]}<<UGS_MEMORY_END>>');
    const original = source('second-library');
    const base = await readMemoryBase('memory', original.workspaceId);
    expect(await beginMemoryReviewTurn({ source: original, config: policy, messages,
      ready: Promise.resolve() }).finish('completed')).toMatchObject({ phase: 'applied', appliedOps: 1, queuedOps: 1 });
    expect((await loadMemory('user')).map((entry) => entry.text)).toEqual(['original proposed fact']);
    expect(await loadMemory('memory', original.workspaceId)).toEqual([]);
    expect(await listPendingMemoryWrites()).toEqual([expect.objectContaining({ target: 'memory', reviewSource: original, base,
      operations: [{ action: 'add', content: 'second library proposal' }] })]);
    expect(seams.invoke).toHaveBeenCalledTimes(1);
  });

  it.each(['reviewEnabled', 'writeEnabled'] as const)('fails closed when live %s closes during a store lock without a notification', async (field) => {
    const entered = deferred<void>(); const release = deferred<void>();
    const blocker = withMemoryLock('memories/user.json', () => { entered.resolve(); return release.promise; });
    await entered.promise;
    const apply = vi.spyOn(memoryStore, 'applyMemoryBatch');
    seams.invoke.mockResolvedValue(proposal);
    const pending = beginMemoryReviewTurn({ source: source(`closed-${field}`), config: policy, messages,
      ready: Promise.resolve() }).finish('completed');
    try {
      await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
      writeSettingsRaw('settings/memoryConfig.v1.json', 'ultragamestudio.memoryConfig.v1',
        JSON.stringify({ ...DEFAULT_MEMORY_CONFIG, ...policy, [field]: false }));
      release.resolve(); await blocker;
      expect(await pending).toMatchObject({ phase: 'cancelled', appliedOps: 0, queuedOps: 0 });
      expect(await loadMemory('user')).toEqual([]);
      expect(await listPendingMemoryWrites()).toEqual([]);
      expect(seams.invoke).toHaveBeenCalledTimes(1);
    } finally { release.resolve(); await blocker; await pending; }
  });

  it('preserves malformed pending bytes after tightening instead of writing or retrying the model', async () => {
    const key = 'ultragamestudio.memory.v1:memories/pending.json';
    const raw = '{broken pending bytes';
    localStorage.setItem(key, raw);
    seams.invoke.mockImplementation(async () => {
      saveMemoryConfig({ ...DEFAULT_MEMORY_CONFIG, ...policy, approvalRequired: true });
      return proposal;
    });
    const outcome = await beginMemoryReviewTurn({ source: source('malformed-queue'), config: policy, messages,
      ready: Promise.resolve() }).finish('completed');
    expect(outcome).toMatchObject({ phase: 'failed', appliedOps: 0, queuedOps: 0 });
    expect(localStorage.getItem(key)).toBe(raw);
    expect(await loadMemory('user')).toEqual([]);
    expect(seams.invoke).toHaveBeenCalledTimes(1);
  });

  it('still permits explicit whole-batch approval with receipts while global approval remains enabled', async () => {
    seams.invoke.mockImplementation(async () => {
      saveMemoryConfig({ ...DEFAULT_MEMORY_CONFIG, ...policy, approvalRequired: true });
      return proposal;
    });
    const original = source('human-approved');
    expect(await beginMemoryReviewTurn({ source: original, config: policy, messages,
      ready: Promise.resolve() }).finish('completed')).toMatchObject({ appliedOps: 0, queuedOps: 1 });
    const [pending] = await listPendingMemoryWrites();
    expect(await resolvePendingMemoryWrites([pending.id], 'approve')).toMatchObject({
      outcomes: [{ id: pending.id, status: 'applied', appliedCount: 1 }],
    });
    expect((await loadMemory('user')).map((entry) => entry.text)).toEqual(['original proposed fact']);
    expect(await memoryStore.readMemoryTransactionHistory('user')).toEqual([expect.objectContaining({
      id: pending.id, reviewSource: original, appliedCount: 1, before: [],
      after: [expect.objectContaining({ text: 'original proposed fact' })], afterRevision: expect.any(String),
    })]);
    expect(await listPendingMemoryWrites()).toEqual([]);
    expect(seams.invoke).toHaveBeenCalledTimes(1);
  });

  it('stages rather than mutating after waiting for the actual memory library lock', async () => {
    const entered = deferred<void>(); const release = deferred<void>();
    const blocker = withMemoryLock('memories/user.json', () => { entered.resolve(); return release.promise; });
    await entered.promise;
    const apply = vi.spyOn(memoryStore, 'applyMemoryBatch'); // observe, never replace the writer
    seams.invoke.mockResolvedValue(proposal);
    const original = source('memory-lock');
    const base = await readMemoryBase('user');
    const turn = beginMemoryReviewTurn({ source: original, config: policy, messages, ready: Promise.resolve() });
    const pending = turn.finish('completed');
    try {
      await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
      saveMemoryConfig({ ...DEFAULT_MEMORY_CONFIG, ...policy, approvalRequired: true });
      release.resolve(); await blocker;
      expect(await pending).toMatchObject({ phase: 'awaiting_approval', appliedOps: 0, queuedOps: 1, usage: { calls: 1 } });
      expect(seams.invoke).toHaveBeenCalledTimes(1);
      expect(await loadMemory('user')).toEqual([]);
      expect(await listPendingMemoryWrites()).toEqual([expect.objectContaining({ reviewSource: original, base,
        operations: [{ action: 'add', content: 'original proposed fact' }] })]);
    } finally { release.resolve(); await blocker; await pending; }
  });

  it('stages the same proposal when approval is enabled during the model await without rebilling', async () => {
    const entered = deferred<void>(); const model = deferred<string>();
    seams.invoke.mockImplementation(() => { entered.resolve(); return model.promise; });
    const original = source('model-await');
    const base = await readMemoryBase('user');
    const turn = beginMemoryReviewTurn({ source: original, config: policy, messages, ready: Promise.resolve() });
    const pending = turn.finish('completed');
    try {
      await entered.promise;
      saveMemoryConfig({ ...DEFAULT_MEMORY_CONFIG, ...policy, approvalRequired: true });
      model.resolve(proposal);
      const outcome = await pending;
      expect(outcome).toMatchObject({ phase: 'awaiting_approval', appliedOps: 0, queuedOps: 1, usage: { calls: 1 } });
      expect(seams.invoke).toHaveBeenCalledTimes(1);
      expect(await loadMemory('user')).toEqual([]);
      expect(await listPendingMemoryWrites()).toEqual([expect.objectContaining({
        reviewSource: original, base, status: 'awaiting_approval',
        operations: [{ action: 'add', content: 'original proposed fact' }],
      })]);
      expect((await loadMemoryReviewJournal()).value.jobs).toEqual([expect.objectContaining({
        id: outcome!.id, phase: 'awaiting_approval', appliedOps: 0, queuedOps: 1, usage: { calls: 1, inputTokens: 100, outputTokens: 20, estimated: true },
      })]);
    } finally { model.resolve(proposal); await pending; }
  });
});
