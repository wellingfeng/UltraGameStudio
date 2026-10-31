import { beforeEach, expect, it, vi } from 'vitest';
import type { SkillCandidateList } from '@/runtime/skills/preReview';
import type { SkillMutationResult, SkillReviewState } from '@/runtime/skills/types';

const ports = vi.hoisted(() => ({ approve: vi.fn(), history: vi.fn(), invoke: vi.fn() }));
vi.mock('./skills', () => ({ createSkillControlHost: () => ({ approve: ports.approve, history: ports.history }) }));
vi.mock('./tauri', () => ({ tauriAvailable: () => true }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: ports.invoke }));
import { performSkillReviewAction } from './skillLearningDesktop';

const origin = { hostId: 'local', workspaceId: 'original-workspace', sessionId: 'session', turnId: 'turn', runId: 'review', cwd: 'E:/original' };
const approved: SkillMutationResult = { origin, status: 'applied', batchId: 'staged-batch', lesson: 'Verified rule.',
  operationsApplied: 1, changes: [], riskReasons: [], rollbackId: 'rollback', revision: 'v2' };
const state: SkillReviewState = { origin, status: 'awaiting_approval', result: { ...approved, status: 'awaiting_approval', operationsApplied: 0 } };
let disk: SkillCandidateList;
beforeEach(() => {
  vi.clearAllMocks();
  disk = { version: 1, revision: 1, candidates: [{ id: 'candidate', lesson: 'Verified rule.', context: '',
    sources: ['saved-source'], consecutive: 2, submitted: true, submission: { state: 'staged', batchId: 'staged-batch', targetRevision: 'v1' } }] };
  ports.approve.mockResolvedValue(approved);
  ports.history.mockResolvedValue({ results: [approved] });
  ports.invoke.mockImplementation(async (command, { request }) => {
    if (command !== 'skill_candidates_request' || request.origin.workspaceId !== origin.workspaceId) throw new Error('WRONG_HOST');
    if (request.action === 'load') return structuredClone(disk);
    if (request.expectedRevision !== disk.revision) throw new Error('SKILL_CANDIDATE_CONFLICT');
    disk = { ...structuredClone(request.list), revision: disk.revision! + 1 };
    return structuredClone(disk);
  });
});
it('production approval synchronizes the original candidate only after journal readback', async () => {
  expect(await performSkillReviewAction(state, 'approve')).toEqual(approved);
  expect(disk.candidates[0].submission).toMatchObject({ state: 'applied', rollbackId: 'rollback', targetRevision: 'v2' });
  expect(disk.candidates[0].submitted).toBe(true);
  expect(ports.history.mock.invocationCallOrder[0]).toBeLessThan(ports.invoke.mock.invocationCallOrder[0]);
});
it('unconfirmed host outcome cannot change candidate bookkeeping', async () => {
  ports.history.mockResolvedValue({ results: [] });
  await expect(performSkillReviewAction(state, 'approve')).rejects.toThrow('SKILL_MUTATION_UNCONFIRMED');
  expect(ports.invoke).not.toHaveBeenCalled();
});
it('auxiliary CAS failure does not conceal a host-confirmed skill commit', async () => {
  ports.invoke.mockRejectedValue(new Error('disk unavailable'));
  const result = await performSkillReviewAction(state, 'approve');
  expect(result).toMatchObject({ status: 'applied', operationsApplied: 1 });
  expect(result.error).toContain('SKILL_CANDIDATE_SYNC_FAILED');
});
