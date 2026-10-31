import { type SkillCandidateList, type SkillCandidateStore } from '@/runtime/skills/preReview';
import type { SkillMutationResult, SkillOrigin } from '@/runtime/skills/types';
import { updateSkillCandidateSubmission } from '@/runtime/skills/preReview';
import { tauriAvailable } from '@/lib/tauri';

export type SkillCandidateTransport = (request: {
  action: 'load' | 'compare_and_swap'; origin: SkillOrigin; list?: SkillCandidateList; expectedRevision?: number;
}) => Promise<SkillCandidateList>;

/** UI is an adapter only. Remote callers MUST inject their namespaced server host. */
export function createSkillCandidateStore(origin: SkillOrigin, transport?: SkillCandidateTransport): SkillCandidateStore {
  const frozen = Object.freeze({ ...origin });
  const request: SkillCandidateTransport = transport ?? (async (payload) => {
    if (frozen.hostId !== 'local' || !tauriAvailable()) throw new Error('SKILL_CANDIDATE_HOST_UNAVAILABLE');
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<SkillCandidateList>('skill_candidates_request', { request: payload });
  });
  return {
    load: () => request({ action: 'load', origin: { ...frozen } }),
    save: async (list) => {
      await request({ action: 'compare_and_swap', origin: { ...frozen }, expectedRevision: list.revision ?? 0,
        list: structuredClone(list) });
    },
  };
}

/** Call only after exact host journal confirmation. A control outcome never
 * clears submitted/replay fences or grants a retry of the original task. */
export async function syncSkillCandidateControlResult(store: SkillCandidateStore,
  action: 'approve' | 'reject' | 'rollback', targetId: string, result: SkillMutationResult): Promise<void> {
  if (!['applied', 'rejected', 'conflicted'].includes(result.status)) return;
  const before = await store.load();
  const matches = before.candidates.filter(candidate => action === 'rollback'
    ? candidate.submission?.rollbackId === targetId : candidate.submission?.batchId === targetId);
  if (!matches.length) return; // Explicit commands do not pass through candidate accumulation.
  if (matches.length !== 1 || (action !== 'rollback' && result.batchId !== targetId)) {
    throw new Error('SKILL_CANDIDATE_CONTROL_TARGET_MISMATCH');
  }
  const candidate = matches[0];
  const state = action === 'rollback' && result.status === 'applied' ? 'rolled_back'
    : result.status === 'applied' ? 'applied' : result.status === 'rejected' ? 'rejected' : 'conflicted';
  const outcome = { state, targetRevision: result.revision || candidate.submission!.targetRevision,
    ...(result.rollbackId ? { rollbackId: result.rollbackId } : {}) } as const;
  // Duplicate control observations are harmless, but never reopen a candidate.
  if (candidate.submission!.state === outcome.state) return;
  await updateSkillCandidateSubmission(store, candidate.submission!.batchId, outcome);
  const saved = await store.load();
  const actual = saved.candidates.find(item => item.id === candidate.id);
  if (!actual || (saved.revision ?? 0) <= (before.revision ?? 0) || actual.submitted !== true
    || JSON.stringify(actual.sources) !== JSON.stringify(candidate.sources)
    || actual.submission?.state !== outcome.state || actual.submission?.targetRevision !== outcome.targetRevision
    || actual.submission?.batchId !== candidate.submission!.batchId) {
    throw new Error('SKILL_CANDIDATE_CONTROL_UNCONFIRMED');
  }
}
