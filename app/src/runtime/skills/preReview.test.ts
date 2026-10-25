import { describe, expect, it, vi } from 'vitest';
import { emptySkillCandidates, observeSkillCandidate, markSkillCandidateSubmitted, type SkillCandidateStore } from './preReview';
import { runSkillReview } from './review';
import type { SkillLearningJob, SkillProposal, SkillHostPort, SkillMutationResult } from './types';

const origin = { hostId: 'local', workspaceId: 'workspace', sessionId: 'session', turnId: 'one', runId: 'run' };
const proposal: SkillProposal = { version: 1, kind: 'propose', lesson: '当测试失败时，先复现原因，再修复并重跑原测试。',
  evidenceIds: ['e'], operations: [{ action: 'create', name: 'verified-fixes', content: 'body' }] };
const job = (turnId: string): SkillLearningJob => ({ origin: { ...origin, turnId }, userText: '修复测试失败', finalAnswer: '已验证',
  loadedSkills: [], config: { enabled: true, mode: 'approve-all', activityThreshold: 1, cooldownMs: 0, maxRounds: 6,
    maxInputTokens: 48000, maxOutputTokens: 6000, timeoutMs: 90000, autoArchive: false, staleAfterDays: 30, archiveAfterDays: 90 },
  evidence: [{ evidenceId: 'e', origin: { ...origin, turnId }, occurredAt: 1, kind: 'correction', provenance: 'user-input',
    status: 'success', summary: '必须先复现再修改并重测' }] });
function memoryStore(): SkillCandidateStore {
  let list = emptySkillCandidates();
  return { load: async () => structuredClone(list), save: async (value) => { list = structuredClone(value); } };
}
const compare = (store: SkillCandidateStore, similarity = 0.98) => vi.fn(async () => ({
  text: JSON.stringify({ candidateId: (await store.load()).candidates[0].id, similarity }),
}));

describe('persistent pre-review recurrence gate', () => {
  it('holds the first occurrence, admits a highly similar second task, and ignores retries', async () => {
    const store = memoryStore(); const complete = compare(store);
    expect(await observeSkillCandidate(job('one'), proposal, store, complete)).toMatchObject({ eligible: false, consecutive: 1 });
    expect(complete).not.toHaveBeenCalled();
    expect(await observeSkillCandidate(job('one'), proposal, store, complete)).toMatchObject({ eligible: false, consecutive: 1 });
    expect(await observeSkillCandidate(job('two'), proposal, store, complete)).toMatchObject({ eligible: true, consecutive: 2 });
    await markSkillCandidateSubmitted(job('two'), store);
    expect(await observeSkillCandidate(job('three'), proposal, store, complete)).toMatchObject({ eligible: false });
  });
  it('does not merge a related topic below the high similarity threshold', async () => {
    const store = memoryStore();
    await observeSkillCandidate(job('one'), proposal, store, compare(store));
    expect(await observeSkillCandidate(job('two'), { ...proposal, lesson: '构建成功后检查视口截图' }, store, compare(store, 0.94))).toMatchObject({ eligible: false, consecutive: 1 });
    expect((await store.load()).candidates).toHaveLength(2);
  });
  it('resets consecutive count when a different candidate intervenes', async () => {
    const store = memoryStore();
    await observeSkillCandidate(job('one'), proposal, store, compare(store));
    await observeSkillCandidate(job('two'), { ...proposal, lesson: '其他经验' }, store, async () => ({ text: '{"candidateId":null,"similarity":0}' }));
    expect(await observeSkillCandidate(job('three'), proposal, store, compare(store))).toMatchObject({ eligible: false, consecutive: 1 });
    expect(await observeSkillCandidate(job('four'), proposal, store, compare(store))).toMatchObject({ eligible: true, consecutive: 2 });
  });
  it.each(['{"candidateId":"unknown","similarity":0.99}', '{"candidateId":null,"similarity":2}', 'not JSON'])(
    'fails closed for invalid AI similarity responses: %s', async (text) => {
      const store = memoryStore();
      await observeSkillCandidate(job('one'), proposal, store, compare(store));
      await expect(observeSkillCandidate(job('two'), proposal, store, async () => ({ text }))).rejects.toThrow();
      expect((await store.load()).candidates[0].consecutive).toBe(1);
    });
  it('integrates with the real reviewer: no host mutation on first appearance, pending approval on second', async () => {
    const store = memoryStore();
    const manage = vi.fn(async (p: SkillProposal): Promise<SkillMutationResult> => ({ status: 'awaiting_approval',
      batchId: 'batch', origin, lesson: p.lesson, operationsApplied: 0, changes: [], riskReasons: [] }));
    const host: SkillHostPort = { list: async () => ({ revision: 'c', entries: [] }), view: async () => { throw new Error('unexpected'); }, manage };
    const complete = vi.fn(async (request: { system: string }) => request.system.includes('语义比对器')
      ? compare(store)() : { text: JSON.stringify(proposal), usage: { inputTokens: 10, outputTokens: 10 } });
    const model = { capability: 'completion-only' as const, complete };
    expect((await runSkillReview(job('one'), { host, model, candidateStore: store })).status).toBe('noop');
    expect(manage).not.toHaveBeenCalled();
    const reviewed = await runSkillReview(job('two'), { host, model, candidateStore: store });
    expect(reviewed.status).toBe('awaiting_approval');
    expect(reviewed.lesson).toContain('连续出现 2 次');
    expect(reviewed.usage?.calls).toBe(2);
    expect(manage).toHaveBeenCalledTimes(1);
  });
  it('keeps explicit user learning exempt from automatic recurrence', async () => {
    const manage = vi.fn(async (): Promise<SkillMutationResult> => ({ status: 'awaiting_approval', batchId: 'b', origin,
      lesson: '用户主动提取', operationsApplied: 0, changes: [], riskReasons: [] }));
    const reviewed = await runSkillReview({ ...job('one'), explicit: true }, { host: {
      list: async () => ({ revision: 'c', entries: [] }), view: async () => { throw new Error('unused'); }, manage },
      model: { capability: 'completion-only', complete: async () => ({ text: JSON.stringify(proposal) }) } });
    expect(reviewed.status).toBe('awaiting_approval'); expect(manage).toHaveBeenCalledTimes(1);
  });
});
