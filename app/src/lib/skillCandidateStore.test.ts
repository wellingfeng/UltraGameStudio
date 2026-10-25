import { afterEach, expect, it } from 'vitest';
import { createSkillCandidateStore } from './skillCandidateStore';
import { emptySkillCandidates } from '@/runtime/skills/preReview';

afterEach(() => window.localStorage.clear());
const origin = { hostId: 'local', workspaceId: 'project', sessionId: 'one', turnId: 'turn', runId: 'run', cwd: 'E:/project' };
it('reloads the private candidate list across store recreation and source sessions', async () => {
  const store = createSkillCandidateStore(origin);
  const list = emptySkillCandidates();
  list.lastId = 'candidate';
  list.candidates.push({ id: 'candidate', lesson: '先读取 manifest', context: '项目依赖', sources: ['one'], consecutive: 1, submitted: false });
  await store.save(list);
  expect(await createSkillCandidateStore({ ...origin, sessionId: 'two', turnId: 'next' }).load()).toEqual(list);
  for (const other of [{ ...origin, workspaceId: 'other' }, { ...origin, hostId: 'remote' }, { ...origin, cwd: 'E:/other' }]) {
    expect(await createSkillCandidateStore(other).load()).toEqual(emptySkillCandidates());
  }
});
