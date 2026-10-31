import { beforeEach, describe, expect, it, vi } from 'vitest';
const seams = vi.hoisted(() => ({
  review: vi.fn(), tag: vi.fn(), complete: vi.fn(), writeEnabled: true,
  base: vi.fn(async () => ({ target: 'memory', workspaceId: 'source-workspace', raw: 'exact-raw', entries: [], revision: 'exact-revision' })),
  messages: [{ id: 'source-user', role: 'user', text: 'Stable fact', createdAt: Date.now() }],
}));
vi.mock('@/store/history/store', () => ({ historyStore: {
  listWorkspaces: async () => [{ id: 'source-workspace' }],
  listSessions: async () => [{ id: 'source-session', updatedAt: Date.now() }],
  getSession: async () => ({ id: 'source-session', workspaceId: 'source-workspace', messages: seams.messages }),
} }));
vi.mock('@/lib/skills', () => ({ readPersistedSkillSourceSession: async () => ({ id: 'source-session', workspaceId: 'source-workspace', messages: seams.messages }) }));
vi.mock('@/lib/memoryStore', () => ({ readMemoryBase: seams.base, getMemoryLimits: () => ({ memory: 2200, user: 1375 }), getMemoryUsage: async () => ({ entries: [], used: 0, limit: 2200 }) }));
vi.mock('@/lib/memoryConsolidate', () => ({ runConsolidatingReview: seams.review }));
vi.mock('@/lib/memoryAutotag', () => ({ autotagMemoryEntries: seams.tag }));
vi.mock('@/lib/memoryConfig', () => ({ loadMemoryConfig: () => ({ writeEnabled: seams.writeEnabled, reviewPreferCheapModel: false, reviewModelSelection: null }) }));
vi.mock('@/lib/gatewayConfig', () => ({
  getExplicitActiveGatewaySelection: () => ({ adapter: 'codex', modelClass: 'review', providerId: 'provider', channelId: 'http' }),
  getDefaultGatewaySelection: () => ({ adapter: 'codex', modelClass: 'review' }),
}));
vi.mock('@/lib/modelGateway/skillReviewGateway', () => ({
  createSkillReviewModelPort: () => ({ capability: 'completion-only', complete: seams.complete }),
}));
import { refreshMemoryFromHistory } from './memoryRefresh';
import { beginReviewForeground } from '@/runtime/memory/review';
beforeEach(() => {
  seams.review.mockReset().mockResolvedValue({ appliedOps: 0, queuedOps: 0, wroteUser: false, wroteMemory: false, lastErrors: [] });
  seams.tag.mockReset().mockResolvedValue({ tagged: 0 });
  seams.complete.mockReset();
});
describe('manual memory refresh budget', () => {
  it('does not review or autotag when memory writes are disabled', async () => {
    seams.writeEnabled = false;
    try {
      const result = await refreshMemoryFromHistory({ scope: 'project', workspaceId: 'source-workspace', days: 1 });
      expect(result.ok).toBe(false);
      expect(result.error).toContain('MEMORY_WRITE_DISABLED');
      expect(seams.review).not.toHaveBeenCalled();
      expect(seams.tag).not.toHaveBeenCalled();
    } finally { seams.writeEnabled = true; }
  });
  it('does not dispatch manual refresh while the shared coordinator owns a foreground task', async () => {
    const release = beginReviewForeground('active-task');
    try {
      const result = await refreshMemoryFromHistory({ scope: 'project', workspaceId: 'source-workspace', days: 1 });
      expect(result.ok).toBe(false);
      expect(seams.review).not.toHaveBeenCalled();
      expect(seams.tag).not.toHaveBeenCalled();
    } finally { release(); }
  });
  it('enforces the aggregate call cap through real digest and review before autotag dispatch', async () => {
    const original = seams.messages;
    seams.messages = [{ id: 'budget-user', role: 'user', text: 'Long historical fact. '.repeat(800), createdAt: Date.now() - 1000 }];
    const real = await vi.importActual<typeof import('./memoryConsolidate')>('./memoryConsolidate');
    seams.review.mockImplementation(real.runConsolidatingReview);
    seams.tag.mockImplementation(async ({ invokeModel }) => { await invokeModel('tag', 'inventory'); return { tagged: 1 }; });
    seams.complete.mockResolvedValue({ text: '无', usage: { inputTokens: 10, outputTokens: 1, estimated: false } });
    try {
      const result = await refreshMemoryFromHistory({ scope: 'project', workspaceId: 'source-workspace', days: 1, ...{ budget: { maxCalls: 2 } } });
      expect(result.ok).toBe(true);
      expect(seams.complete).toHaveBeenCalledTimes(2);
      expect(result.taggedEntries).toBe(0);
      expect(result).toMatchObject({ usage: { calls: 2 } });
    } finally { seams.messages = original; }
  });
  it('filters by each message timestamp rather than the touched session timestamp', async () => {
    const original = seams.messages;
    const now = Date.now();
    seams.messages = [
      { id: 'old', role: 'user', text: 'Outside window', createdAt: now - 2 * 86400000 },
      { id: 'new', role: 'user', text: 'Within window', createdAt: now - 1000 },
      { id: 'future', role: 'assistant', text: 'Future message', createdAt: now + 86400000 },
      { id: 'unknown', role: 'user', text: 'Unknown timestamp', createdAt: NaN },
    ];
    try {
      const result = await refreshMemoryFromHistory({ scope: 'project', workspaceId: 'source-workspace', days: 1 });
      expect(result.messagesScanned).toBe(1);
      expect(seams.review.mock.calls[0][0].messages).toEqual([{ role: 'user', text: 'Within window' }]);
    } finally { seams.messages = original; }
  });
  it('forwards the exact persisted source and target base with the cancellation signal', async () => {
    const controller = new AbortController();
    await refreshMemoryFromHistory({ scope: 'project', workspaceId: 'source-workspace', days: 1, ...{ signal: controller.signal } });
    const options = seams.review.mock.calls[0][0];
    expect(options.reviewSource).toMatchObject({ hostId: 'local', namespaceId: 'local', workspaceId: 'source-workspace', sessionId: 'source-session', turnId: 'source-user', sourceMessageId: 'source-user' });
    expect(options.reviewSource.runId).toEqual(expect.any(String));
    expect(options.bases.memory).toMatchObject({ raw: 'exact-raw', revision: 'exact-revision' });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(seams.tag.mock.calls[0][0].signal).toBe(options.signal);
    controller.abort();
    expect(options.signal.aborted).toBe(true);
  });
  it('shares one frozen invoker across digest, review and autotag', async () => {
    expect((await refreshMemoryFromHistory({ scope: 'project', workspaceId: 'source-workspace', days: 1 })).ok).toBe(true);
    const reviewOptions = seams.review.mock.calls[0][0];
    expect(reviewOptions.summarize).toBe(reviewOptions.invokeModel);
    expect(seams.tag.mock.calls[0][0].invokeModel).toBe(reviewOptions.invokeModel);
  });
});
