import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const seam = vi.hoisted(() => ({ invoke: vi.fn(), read: vi.fn(), consolidate: vi.fn(), make: vi.fn() }));
vi.mock('@/lib/tauri', () => ({ tauriAvailable: () => true }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: seam.invoke }));
vi.mock('@/lib/memoryStore', () => ({ readMemoryBase: seam.read, getMemoryLimits: () => ({ user: 1375, memory: 2200 }), setMemoryLimits: vi.fn(), setMemoryNudgeThresholdPct: vi.fn() }));
vi.mock('@/lib/memoryRefresh', () => ({ makeReviewInvoker: seam.make }));
vi.mock('@/lib/memoryConsolidate', () => ({ runConsolidatingReview: seam.consolidate }));
vi.mock('@/lib/gatewayConfig', () => ({ getExplicitActiveGatewaySelection: () => ({ adapter: 'codex', modelClass: 'probe' }), getDefaultGatewaySelection: () => ({ adapter: 'codex', modelClass: 'probe' }) }));
import { requestExplicitSkillLearning, cancelSkillLearning, isSkillReviewLive } from '@/lib/skillLearningDesktop';
import { acquireReviewBackground } from '@/runtime/memory/review';
import { beginMemoryReviewTurn, subscribeMemoryReview } from '@/lib/memoryReviewDesktop';
import { DEFAULT_SKILL_LEARNING_CONFIG } from '@/lib/skillLearningConfig';
import { DEFAULT_MEMORY_CONFIG, saveMemoryConfig } from '@/lib/memoryConfig';
import { resetGenerationSettingsStoreForTests } from '@/lib/generationSettingsStore';
import type { SkillReviewState } from '@/runtime/skills/types';
import { createMemoryIpcFixture } from '@/test/nativePersistenceFixture';
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function flush() { for (let i = 0; i < 100; i++) await Promise.resolve(); }
const config = { ...DEFAULT_SKILL_LEARNING_CONFIG, cooldownMs: 0, timeoutMs: 1000 };
function learn(id: string, states: SkillReviewState[], injected = false) {
  return requestExplicitSkillLearning({ origin: { hostId: 'local', workspaceId: 'probe-workspace', sessionId: id, turnId: 'user', runId: id },
    kind: 'learn', text: '先读完整文件。', selection: { adapter: 'codex', modelClass: 'default' }, config,
    model: { capability: 'completion-only', complete: async () => ({ text: '{"version":1,"kind":"noop","reason":"已有规则覆盖。"}' }) },
    ...(injected ? { host: { list: async () => ({ revision: 'empty', entries: [] }), view: vi.fn(), manage: vi.fn() } } : {}),
    onState: state => states.push(state) });
}
let tombstone: boolean;
let bindGate: ReturnType<typeof deferred>;
let revokeGate: ReturnType<typeof deferred>;
beforeEach(async () => {
  await import('@tauri-apps/api/core');
  vi.useFakeTimers(); localStorage.clear(); resetGenerationSettingsStoreForTests();
  saveMemoryConfig({ ...DEFAULT_MEMORY_CONFIG, reviewEnabled: true, writeEnabled: true, reviewMinMessages: 2, reviewMinIntervalMinutes: 0 });
  tombstone = false; bindGate = deferred(); revokeGate = deferred();
  const memoryIpc = createMemoryIpcFixture();
  seam.invoke.mockReset().mockImplementation(async (command, payload: Record<string, unknown> = {}) => {
    if (command === 'memory_read_json' || command === 'memory_compare_exchange_json') return memoryIpc.invoke(command, payload);
    if (command === 'history_read_json') return JSON.stringify({ id: 'stalled-bind', workspaceId: 'probe-workspace', messages: [{ id: 'user', role: 'user', text: 'Persisted source.' }] });
    if (command === 'skills_bind_run') { await bindGate.promise; if (tombstone) throw new Error('run authority revoked'); }
    if (command === 'skills_revoke_run') { await revokeGate.promise; tombstone = true; }
    if (command === 'skills_request') return { revision: 'empty', entries: [] };
    return null;
  });
  seam.read.mockReset().mockImplementation(async (target, workspaceId) => ({ target, workspaceId, raw: null, entries: [] }));
  seam.make.mockReset().mockReturnValue(async () => ''); seam.consolidate.mockReset().mockResolvedValue({ appliedOps: 0, queuedOps: 0, lastErrors: [] });
});
afterEach(async () => { revokeGate.resolve(); bindGate.resolve(); cancelSkillLearning(); await flush(); vi.useRealTimers(); vi.restoreAllMocks(); });
it('releases the shared review slot only after native prebind revoke acknowledgement and rejects late dispatch', async () => {
  const firstStates: SkillReviewState[] = [], secondStates: SkillReviewState[] = [], memoryStates: string[] = [];
  let firstSettled = false;
  const first = learn('stalled-bind', firstStates).then(value => { firstSettled = true; return value; });
  await vi.advanceTimersByTimeAsync(1); await flush();
  expect(seam.invoke.mock.calls.some(([command]) => command === 'skills_bind_run')).toBe(true);
  await vi.advanceTimersByTimeAsync(1001); await flush();
  expect(firstStates.at(-1)?.error).toContain('SKILL_REVIEW_BUDGET_TIME');
  const second = learn('behind-stalled-bind', secondStates, true);
  const unsubscribe = subscribeMemoryReview(state => { if (state.source.sessionId === 'memory-behind-bind') memoryStates.push(state.phase); });
  const turn = beginMemoryReviewTurn({ source: { hostId: 'local', namespaceId: 'local', workspaceId: 'probe-workspace', sessionId: 'memory-behind-bind', turnId: 'user', sourceMessageId: 'user', runId: 'memory-behind-bind' },
    config: { reviewEnabled: true, writeEnabled: true, reviewMinMessages: 2, reviewMinIntervalMinutes: 0 },
    messages: [{ id: 'user', role: 'user', text: '实际输入' }, { id: 'answer', role: 'assistant', text: '实际答复' }], ready: Promise.resolve() });
  const memory = turn.finish('completed');
  await vi.advanceTimersByTimeAsync(1); await flush();
  const beforeAck = acquireReviewBackground('inspection'); const heldBeforeAck = !beforeAck; beforeAck?.release();
  const revokeBeforeBind = seam.invoke.mock.calls.some(([command]) => command === 'skills_revoke_run');
  revokeGate.resolve(); await vi.advanceTimersByTimeAsync(2022000); await flush();
  const candidate = acquireReviewBackground('inspection'); const slotFree = !!candidate; candidate?.release();
  const observed = { heldBeforeAck, revokeBeforeBind, firstSettled, firstLive: isSkillReviewLive(firstStates[0].origin.runId),
    secondStatuses: secondStates.map(s => s.status), memoryStatuses: [...memoryStates], slotFree };
  // Finish the actual late bind rather than forcibly releasing queue ownership.
  bindGate.resolve(); await first; await second; await memory; await flush(); unsubscribe();
  console.log('PROBE_NATIVE_BIND_QUEUE', JSON.stringify(observed));
  expect(observed).toMatchObject({ heldBeforeAck: true, revokeBeforeBind: true, firstSettled: true, firstLive: false, slotFree: true });
  expect(observed.secondStatuses).toContain('noop'); expect(observed.memoryStatuses).toContain('noop');
  expect(tombstone).toBe(true);
  expect(seam.invoke.mock.calls.some(([command]) => command === 'skills_request')).toBe(false);
});
