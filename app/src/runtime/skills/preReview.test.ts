import { describe, expect, it, vi } from 'vitest';
import { emptySkillCandidates, observeSkillCandidate, markSkillCandidateSubmitted, type SkillCandidateStore } from './preReview';
import { runSkillReview } from './review';
import * as candidates from './preReview';
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
  it('finalizes candidate submission only after the allowed host validation correction', async () => {
    const store = memoryStore(); await observeSkillCandidate(job('one'), proposal, store, compare(store));
    const manage = vi.fn(async (): Promise<SkillMutationResult> => ({ status: manage.mock.calls.length === 1 ? 'failed' : 'awaiting_approval',
      batchId: 'fixed-batch', origin, lesson: '', operationsApplied: 0, changes: [], riskReasons: [],
      ...(manage.mock.calls.length === 1 ? { error: 'invalid YAML frontmatter' } : {}) }));
    const model = { capability: 'completion-only' as const, complete: async (request: { system: string }) => request.system.includes('语义比对器')
      ? compare(store)() : { text: JSON.stringify(proposal) } };
    const result = await runSkillReview(job('two'), { host: { list: async () => ({ revision: 'c', entries: [] }),
      view: async () => { throw new Error('unused'); }, manage }, model, candidateStore: store });
    expect(result.status).toBe('awaiting_approval'); expect(result.error).toBeUndefined();
    expect((await store.load()).candidates[0].submission).toMatchObject({ state: 'staged', batchId: 'fixed-batch' });
  });
  it('suppresses rolled-back and changed applied revisions until explicit new-revision reopening', async () => {
    const store = memoryStore(); await observeSkillCandidate(job('one'), proposal, store, compare(store));
    await observeSkillCandidate(job('two'), proposal, store, compare(store));
    await markSkillCandidateSubmitted(job('two'), store, { status: 'applied', batchId: 'b', revision: 'rev1', rollbackId: 'undo', origin,
      lesson: '', operationsApplied: 1, changes: [], riskReasons: [] }, 'base');
    const id = (await store.load()).candidates[0].id;
    expect(await observeSkillCandidate(job('three'), proposal, store, compare(store))).toMatchObject({ eligible: false });
    await candidates.updateSkillCandidateSubmission(store, 'b', { state: 'rolled_back', targetRevision: 'restored' });
    expect((await store.load()).candidates[0].submission).toMatchObject({ state: 'rolled_back', batchId: 'b', targetRevision: 'restored', rollbackId: 'undo' });
    expect(await observeSkillCandidate(job('four'), proposal, store, compare(store))).toMatchObject({ eligible: false });
    await expect(candidates.reopenSkillCandidate(store, id, 'wrong-batch', 'rev2')).rejects.toThrow('INVALID_REOPEN');
    await candidates.reopenSkillCandidate(store, id, 'b', 'rev2');
    expect(await observeSkillCandidate(job('five'), proposal, store, compare(store))).toMatchObject({ eligible: false, consecutive: 1 });
    expect(await observeSkillCandidate(job('six'), proposal, store, compare(store))).toMatchObject({ eligible: true, consecutive: 2 });
  });
  it('reports a host CAS conflict without retrying the model or dispatching manage', async () => {
    const store = memoryStore(); await observeSkillCandidate(job('one'), proposal, store, compare(store));
    const manage = vi.fn();
    const model = { capability: 'completion-only' as const, complete: vi.fn(async (request: { system: string }) => request.system.includes('语义比对器')
      ? compare(store)() : { text: JSON.stringify(proposal) }) };
    store.save = async () => { throw new Error('SKILL_CANDIDATE_CONFLICT'); };
    const result = await runSkillReview(job('two'), { host: { list: async () => ({ revision: 'c', entries: [] }),
      view: async () => { throw new Error('unused'); }, manage }, model, candidateStore: store });
    expect(result.status).toBe('conflicted'); expect(manage).not.toHaveBeenCalled(); expect(model.complete).toHaveBeenCalledTimes(2);
  });
  it('keeps a pending submission when the candidate list reaches retention capacity', async () => {
    const store = memoryStore();
    await observeSkillCandidate(job('one'), proposal, store, compare(store));
    await observeSkillCandidate(job('two'), proposal, store, compare(store));
    await markSkillCandidateSubmitted(job('two'), store);
    const id = (await store.load()).candidates[0].id;
    for (let index = 0; index < 64; index++) await observeSkillCandidate(job(`different-${index}`), { ...proposal, lesson: `Other ${index}` }, store,
      async () => ({ text: '{"candidateId":null,"similarity":0}' }));
    expect((await store.load()).candidates.find((item) => item.id === id)?.submitted).toBe(true);
  });
  it('reserves an eligible candidate before dispatch so another task cannot stage it twice', async () => {
    const store = memoryStore();
    let started!: () => void; const entered = new Promise<void>((resolve) => { started = resolve; });
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    let dispatches = 0;
    const manage = vi.fn(async (): Promise<SkillMutationResult> => {
      if (++dispatches === 1) { started(); await gate; }
      return { status: 'awaiting_approval', batchId: 'only-batch', origin, lesson: '', operationsApplied: 0, changes: [], riskReasons: [] };
    });
    const host: SkillHostPort = { list: async () => ({ revision: 'c', entries: [] }), view: async () => { throw new Error('unused'); }, manage };
    const model = { capability: 'completion-only' as const, complete: async (request: { system: string }) => request.system.includes('语义比对器')
      ? compare(store)() : { text: JSON.stringify(proposal) } };
    await runSkillReview(job('one'), { host, model, candidateStore: store });
    const second = runSkillReview(job('two'), { host, model, candidateStore: store });
    await entered;
    const third = runSkillReview(job('three'), { host, model, candidateStore: store });
    try { await third; } finally { release(); }
    await Promise.all([second, third]);
    expect(manage).toHaveBeenCalledTimes(1);
  });
  it('keeps rejection suppressed until an explicit batch-bound reopen', async () => {
    const store = memoryStore();
    await observeSkillCandidate(job('one'), proposal, store, compare(store));
    await observeSkillCandidate(job('two'), proposal, store, compare(store));
    await markSkillCandidateSubmitted(job('two'), store, { status: 'awaiting_approval', batchId: 'batch', origin,
      lesson: '', operationsApplied: 0, changes: [], riskReasons: [] }, 'c');
    expect(candidates.updateSkillCandidateSubmission).toBeTypeOf('function');
    await candidates.updateSkillCandidateSubmission(store, 'batch', { state: 'rejected', targetRevision: 'c' });
    expect(await observeSkillCandidate(job('three'), proposal, store, compare(store))).toMatchObject({ eligible: false });
    const id = (await store.load()).candidates[0].id;
    await candidates.reopenSkillCandidate(store, id, 'batch', 'new-target');
    expect(await observeSkillCandidate(job('two'), proposal, store, compare(store))).toMatchObject({ eligible: false });
    expect(await observeSkillCandidate(job('four'), proposal, store, compare(store))).toMatchObject({ eligible: false, consecutive: 1 });
    expect(await observeSkillCandidate(job('five'), proposal, store, compare(store))).toMatchObject({ eligible: true, consecutive: 2 });
  });
  it('retains replay protection beyond the candidate source window', async () => {
    const store = memoryStore();
    for (let index = 0; index < 260; index++) await observeSkillCandidate(job(`old-${index}`), proposal, store, compare(store));
    const before = (await store.load()).candidates[0].consecutive;
    expect(await observeSkillCandidate(job('old-0'), proposal, store, compare(store))).toMatchObject({ eligible: false, consecutive: before });
    expect((await store.load()).candidates[0].consecutive).toBe(before);
  });
  it('never admits a replay of an eligible source as another submission', async () => {
    const store = memoryStore();
    await observeSkillCandidate(job('one'), proposal, store, compare(store));
    expect(await observeSkillCandidate(job('two'), proposal, store, compare(store))).toMatchObject({ eligible: true, consecutive: 2 });
    expect(await observeSkillCandidate(job('two'), proposal, store, compare(store))).toMatchObject({ eligible: false, consecutive: 2 });
  });
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
    expect((await store.load()).candidates[0]).toMatchObject({ submission: {
      state: 'staged', batchId: 'batch', targetRevision: 'c',
    } });
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
