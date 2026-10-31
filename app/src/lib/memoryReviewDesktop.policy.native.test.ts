import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Sequential SDK/IPC seam: real consolidation, serialized store and queue.
// Browser tests separately cover the real producer. Not Rust-host/product-GUI coverage.
const seams = vi.hoisted(() => ({ invoke: vi.fn(), model: vi.fn(), acquireInvoke: undefined as (() => void) | undefined }));
vi.mock('./tauri', () => ({ tauriAvailable: () => true }));
vi.mock('@tauri-apps/api/core', () => {
  const sdk = { invoke: seams.invoke };
  Object.defineProperty(sdk, 'invoke', { get: () => { seams.acquireInvoke?.(); return seams.invoke; } });
  return sdk;
});

import { DEFAULT_MEMORY_CONFIG, loadMemoryConfig, saveMemoryConfig } from './memoryConfig';
import { resetGenerationSettingsStoreForTests, writeSettingsRaw } from './generationSettingsStore';
import { loadMemory } from './memoryStore';
import { listPendingMemoryWrites } from './memoryPending';
import { runConsolidatingReview } from './memoryConsolidate';

const policy = { reviewEnabled: true, writeEnabled: true, reviewMinMessages: 2, reviewMinIntervalMinutes: 0 };
const userPath = 'memories/user.json';
const original = { hostId: 'local', namespaceId: 'local', workspaceId: 'native-policy-workspace',
  sessionId: 'native-policy', turnId: 'user', sourceMessageId: 'user', runId: 'native-policy' };

const proposal = '<<UGS_MEMORY>>{"target":"user","operations":[{"action":"add","content":"native proposed fact"}]}<<UGS_MEMORY_END>>';
let bytes: Map<string, string>;
let onRead: ((path: string) => void) | undefined;
let onCommit: ((path: string) => void) | undefined;
beforeEach(() => {
  localStorage.clear(); resetGenerationSettingsStoreForTests();
  bytes = new Map(); onRead = undefined; onCommit = undefined; seams.acquireInvoke = undefined;
  seams.model.mockReset().mockResolvedValue(proposal);

  seams.invoke.mockReset().mockImplementation(async (command: string, args: { relPath: string; expectedJson?: string | null; json?: string }) => {
    if (command === 'memory_read_json') { onRead?.(args.relPath); return bytes.get(args.relPath) ?? null; }
    if (command === 'memory_compare_exchange_json') {
      if ((bytes.get(args.relPath) ?? null) !== args.expectedJson) throw new Error('Memory CAS conflict');
      bytes.set(args.relPath, args.json!); onCommit?.(args.relPath); return args.json;
    }
    if (command === 'history_write_json' && args.relPath === 'settings/memoryConfig.v1.json') {
      bytes.set(args.relPath, args.json!); return undefined;
    }
    throw new Error(`Unexpected native command ${command}`);
  });
  saveMemoryConfig({ ...DEFAULT_MEMORY_CONFIG, ...policy });

});
afterEach(() => { seams.acquireInvoke = undefined; vi.restoreAllMocks(); });
const finish = (signal?: AbortSignal) => runConsolidatingReview({ transcript: 'original user source', invokeModel: seams.model,
  reviewSource: original, workspaceId: original.workspaceId, target: 'user', signal,
  bases: { user: { target: 'user', raw: null, entries: [] } },
  getWritePolicy: () => {
    const live = loadMemoryConfig();
    if (!live.reviewEnabled || !live.writeEnabled) throw new DOMException('Memory review cancelled: policy disabled', 'AbortError');
    return live.approvalRequired ? 'queue' : 'direct';
  },
});
const userMutations = () => seams.invoke.mock.calls.filter(([command, args]) => command === 'memory_compare_exchange_json' && args.relPath === userPath);

describe('native memory policy at actual SDK dispatch', () => {
  it('rechecks approval after acquiring dynamic invoke and before any library IPC mutation', async () => {
    let userReads = 0; let boundaryReached = false;
    onRead = (path) => {
      if (path !== userPath || ++userReads !== 1) return; // after the store lock/read, before CAS imports invoke
      seams.acquireInvoke = () => {
        seams.acquireInvoke = undefined; boundaryReached = true;
        saveMemoryConfig({ ...DEFAULT_MEMORY_CONFIG, ...policy, approvalRequired: true });
      };
    };
    const outcome = await finish();
    expect(boundaryReached).toBe(true);
    expect(outcome).toMatchObject({ appliedOps: 0, queuedOps: 1, attempts: 1, lastErrors: [] });
    expect(userMutations()).toEqual([]);
    expect(bytes.has(userPath)).toBe(false);
    expect(seams.model).toHaveBeenCalledTimes(1);
    expect(await loadMemory('user')).toEqual([]);
    expect(await listPendingMemoryWrites()).toEqual([expect.objectContaining({ reviewSource: original,
      base: { target: 'user', raw: null, entries: [] }, operations: [{ action: 'add', content: 'native proposed fact' }] })]);
  });

  it.each(['reviewEnabled', 'writeEnabled'] as const)('fails closed if live %s closes at the native seam without a cancellation notification', async (field) => {
    let reads = 0; let boundaryReached = false;
    onRead = (path) => {
      if (path !== userPath || ++reads !== 1) return;
      seams.acquireInvoke = () => {
        seams.acquireInvoke = undefined; boundaryReached = true;
        writeSettingsRaw('settings/memoryConfig.v1.json', 'ultragamestudio.memoryConfig.v1',
          JSON.stringify({ ...DEFAULT_MEMORY_CONFIG, ...policy, [field]: false }));
      };
    };
    await expect(finish()).rejects.toThrow(/policy disabled/i);
    expect(boundaryReached).toBe(true);
    expect(userMutations()).toEqual([]);
    expect(bytes.has(userPath)).toBe(false);
    expect(seams.model).toHaveBeenCalledTimes(1);
    expect(await listPendingMemoryWrites()).toEqual([]);
  });

  it('keeps a confirmed native commit applied when cancellation and approval arrive after dispatch', async () => {
    const controller = new AbortController();
    onCommit = (path) => {
      if (path !== userPath) return;
      controller.abort();
      saveMemoryConfig({ ...DEFAULT_MEMORY_CONFIG, ...policy, approvalRequired: true });
    };
    const outcome = await finish(controller.signal);
    expect(outcome).toMatchObject({ appliedOps: 1, queuedOps: 0, attempts: 1, lastErrors: [] });
    expect(userMutations()).toHaveLength(1);
    expect((await loadMemory('user')).map((entry) => entry.text)).toEqual(['native proposed fact']);
    expect(await listPendingMemoryWrites()).toEqual([]);
    expect(seams.model).toHaveBeenCalledTimes(1);
  });
});
