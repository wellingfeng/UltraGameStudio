import { expect, it, vi } from 'vitest';
import { syncSkillCandidateControlResult } from './skillCandidateStore';
import type { SkillCandidateList, SkillCandidateStore } from '@/runtime/skills/preReview';
import type { SkillMutationResult } from '@/runtime/skills/types';

const origin = { hostId: 'local', workspaceId: 'workspace', sessionId: 'session', turnId: 'turn', runId: 'run' };
const result = (status: SkillMutationResult['status']): SkillMutationResult => ({ status, origin,
  batchId: 'batch', lesson: '', operationsApplied: status === 'applied' ? 1 : 0,
  changes: [], riskReasons: [], revision: 'target-v2', rollbackId: 'rollback' });
const fixture = (state: 'staged' | 'applied' = 'staged') => {
  let list: SkillCandidateList = { version: 1, revision: 3, seenSources: ['source'], candidates: [{
    id: 'candidate', lesson: 'Rule and reason.', context: '', sources: ['source'], consecutive: 2, submitted: true,
    submission: { state, batchId: 'batch', targetRevision: 'target-v1', ...(state === 'applied' ? { rollbackId: 'rollback' } : {}) },
  }] };
  const store: SkillCandidateStore = { load: async () => structuredClone(list),
    save: vi.fn(async value => { list = { ...structuredClone(value), revision: 4 }; }) };
  return store;
};

it('updates only the confirmed approved batch and retains suppression and replay identity', async () => {
  const store = fixture();
  await syncSkillCandidateControlResult(store, 'approve', 'batch', result('applied'));
  expect((await store.load()).candidates[0]).toMatchObject({ submitted: true, consecutive: 2,
    sources: ['source'], submission: { state: 'applied', batchId: 'batch', targetRevision: 'target-v2', rollbackId: 'rollback' } });
});
it('marks the original submission rolled back, not the newly created rollback batch', async () => {
  const store = fixture('applied');
  await syncSkillCandidateControlResult(store, 'rollback', 'rollback', { ...result('applied'), batchId: 'new-rollback-batch' });
  expect((await store.load()).candidates[0].submission).toMatchObject({ state: 'rolled_back', batchId: 'batch' });
});
it('failed controls cannot reopen or erase a staged candidate', async () => {
  const store = fixture();
  await syncSkillCandidateControlResult(store, 'approve', 'batch', result('failed'));
  expect(store.save).not.toHaveBeenCalled();
});
it('does not reinterpret an explicit user batch as a candidate submission', async () => {
  const store = fixture();
  await syncSkillCandidateControlResult(store, 'reject', 'explicit-other-batch', { ...result('rejected'), batchId: 'explicit-other-batch' });
  expect(store.save).not.toHaveBeenCalled();
});
it('rejects a candidate save that cannot be freshly confirmed', async () => {
  const store = fixture();
  vi.mocked(store.save).mockResolvedValue(undefined);
  await expect(syncSkillCandidateControlResult(store, 'reject', 'batch', result('rejected'))).rejects.toThrow('SKILL_CANDIDATE_CONTROL_UNCONFIRMED');
});
