import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const seams = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock('./tauri', () => ({ tauriAvailable: () => false }));
vi.mock('@/store/history/store', () => ({ historyStore: {
  listWorkspaces: async () => [{ id: 'refresh-policy-workspace' }],
  listSessions: async () => [{ id: 'refresh-policy-session', updatedAt: Date.now() }],
} }));
vi.mock('./skills', () => ({ readPersistedSkillSourceSession: async () => ({
  id: 'refresh-policy-session', workspaceId: 'refresh-policy-workspace',
  messages: [{ id: 'source-user', role: 'user', text: 'A persisted historical preference.', createdAt: Date.now() - 1000 }],
}) }));
vi.mock('./gatewayConfig', () => ({
  getExplicitActiveGatewaySelection: () => ({ adapter: 'codex', modelClass: 'refresh-policy-model' }),
  getDefaultGatewaySelection: () => ({ adapter: 'codex', modelClass: 'refresh-policy-model' }),
}));
vi.mock('./modelGateway/skillReviewGateway', () => ({
  createSkillReviewModelPort: () => ({ capability: 'completion-only', complete: seams.complete }),
}));
import { refreshMemoryFromHistory } from './memoryRefresh';
import { DEFAULT_MEMORY_CONFIG, saveMemoryConfig } from './memoryConfig';
import { resetGenerationSettingsStoreForTests } from './generationSettingsStore';
import { loadMemory } from './memoryStore';
import { listPendingMemoryWrites } from './memoryPending';

beforeEach(() => {
  localStorage.clear(); resetGenerationSettingsStoreForTests(); seams.complete.mockReset();
  saveMemoryConfig({ ...DEFAULT_MEMORY_CONFIG, reviewEnabled: true, writeEnabled: true });
});
afterEach(() => vi.restoreAllMocks());

it('honors approval enabled during a refresh model await without another completion call', async () => {
  let release!: () => void; let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  seams.complete.mockImplementation(async () => {
    entered(); await gate;
    return { text: '<<UGS_MEMORY>>{"target":"memory","operations":[{"action":"add","content":"historical proposed fact"}]}<<UGS_MEMORY_END>>',
      usage: { inputTokens: 40, outputTokens: 10, estimated: false } };
  });
  const pending = refreshMemoryFromHistory({ scope: 'project', workspaceId: 'refresh-policy-workspace', days: 1, approvalRequired: false });
  try {
    await ready;
    saveMemoryConfig({ ...DEFAULT_MEMORY_CONFIG, reviewEnabled: true, writeEnabled: true, approvalRequired: true });
    release();
    const result = await pending;
    expect(result).toMatchObject({ ok: true, appliedOps: 0, queuedOps: 1, usage: { calls: 1 } });
    expect(seams.complete).toHaveBeenCalledTimes(1);
    expect(await loadMemory('memory', 'refresh-policy-workspace')).toEqual([]);
    expect(await listPendingMemoryWrites()).toEqual([expect.objectContaining({ reviewSource: result.source,
      base: { target: 'memory', workspaceId: 'refresh-policy-workspace', raw: null, entries: [] },
      operations: [{ action: 'add', content: 'historical proposed fact' }] })]);
  } finally { release(); await pending; }
});
