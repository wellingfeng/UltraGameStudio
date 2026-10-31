import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { expect, it } from 'vitest';
import { createNodeSkillCandidateStore } from './skill-candidate-store';
import { emptySkillCandidates } from '../../src/runtime/skills/preReview';

it('rejects a stale snapshot from another host instance without losing the winner', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ugs-cas-'));
  try {
    const a = createNodeSkillCandidateStore(dir); const b = createNodeSkillCandidateStore(dir);
    const first = await a.load(); const stale = await b.load();
    first.candidates.push({ id: 'a', lesson: 'A', context: '', sources: ['a'], consecutive: 1, submitted: false });
    stale.candidates.push({ id: 'b', lesson: 'B', context: '', sources: ['b'], consecutive: 1, submitted: false });
    await a.save(first);
    await expect(b.save(stale)).rejects.toThrow('SKILL_CANDIDATE_CONFLICT');
    expect((await b.load()).candidates.map((item) => item.id)).toEqual(['a']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('persists CLI candidates atomically and reloads them in a new host instance', async () => {
  const root = resolve('../.ultragamestudio/tests/skill-candidate-storage');
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, 'run-'));
  if (!resolve(dir).startsWith(`${root}\\`) && !resolve(dir).startsWith(`${root}/`)) throw new Error('Unexpected test cleanup path');
  try {
    const list = emptySkillCandidates();
    list.candidates.push({ id: 'a', lesson: '先复现再修复', context: '测试失败', sources: ['source-a'], consecutive: 1, submitted: false });
    await createNodeSkillCandidateStore(dir).save(list);
    expect(await createNodeSkillCandidateStore(dir).load()).toEqual({ ...list, revision: 1 });
    expect(JSON.parse(await readFile(join(dir, '.ultragamestudio/skill-learning/pre-review.v1.json'), 'utf8'))).toEqual({ ...list, revision: 1 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
