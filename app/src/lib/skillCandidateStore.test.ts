import { afterEach, expect, it } from 'vitest';
import { createSkillCandidateStore, type SkillCandidateTransport } from './skillCandidateStore';
import { emptySkillCandidates, type SkillCandidateList } from '@/runtime/skills/preReview';

afterEach(() => window.localStorage.clear());
const origin = { hostId: 'local', workspaceId: 'project', sessionId: 'one', turnId: 'turn', runId: 'run', cwd: 'E:/project' };
it('does not grant browser localStorage candidate authority', async () => {
  await expect(createSkillCandidateStore(origin).load()).rejects.toThrow('SKILL_CANDIDATE_HOST_UNAVAILABLE');
});
it('reloads the private candidate list across store recreation and source sessions', async () => {
  const records = new Map<string, SkillCandidateList>();
  const host: SkillCandidateTransport = async (request) => {
    const key = JSON.stringify([request.origin.hostId, request.origin.workspaceId, request.origin.cwd]);
    const current = records.get(key) ?? emptySkillCandidates();
    if (request.action === 'load') return structuredClone(current);
    if (request.expectedRevision !== (current.revision ?? 0)) throw new Error('SKILL_CANDIDATE_CONFLICT');
    const next = { ...request.list!, revision: (current.revision ?? 0) + 1 };
    records.set(key, structuredClone(next)); return next;
  };
  const store = createSkillCandidateStore(origin, host);
  const list = emptySkillCandidates();
  list.lastId = 'candidate';
  list.candidates.push({ id: 'candidate', lesson: '先读取 manifest', context: '项目依赖', sources: ['one'], consecutive: 1, submitted: false });
  await store.save(list);
  expect(await createSkillCandidateStore({ ...origin, sessionId: 'two', turnId: 'next' }, host).load()).toEqual({ ...list, revision: 1 });
  for (const other of [{ ...origin, workspaceId: 'other' }, { ...origin, hostId: 'remote' }, { ...origin, cwd: 'E:/other' }]) {
    expect(await createSkillCandidateStore(other, host).load()).toEqual(emptySkillCandidates());
  }
});
