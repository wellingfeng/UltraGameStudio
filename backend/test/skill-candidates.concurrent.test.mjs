import assert from 'node:assert/strict';
import test from 'node:test';
import { fork } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createSkillCandidateService } from '../src/skill-candidate-service.mjs';
const scratch = 'C:/Users/fengwei/AppData/Local/hermes/cache/scratch/ugs-self-review-development/candidate-stream';

test('independent processes report a CAS conflict rather than lose the other observation', async () => {
  const dir = await mkdtemp(join(scratch, 'process-'));
  const worker = join(dir, 'worker.mjs');
  const moduleUrl = new URL('../src/skill-candidate-service.mjs', import.meta.url).href;
  await writeFile(worker, `import { createSkillCandidateService } from ${JSON.stringify(moduleUrl)};
const store = createSkillCandidateService({dir: process.argv[2]});
const list = await store.load();
list.candidates.push({id:process.argv[3],lesson:'lesson',context:'',sources:[process.argv[3]],consecutive:1,submitted:false});
process.send('ready');
process.once('message',async()=>{try{await store.compareAndSwap(list.revision,list);process.send('applied');}catch(e){process.send(e.message);}process.disconnect();});`);
  const children = ['A', 'B'].map((id) => fork(worker, [dir, id], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }));
  try {
    await Promise.all(children.map((child) => new Promise((resolve, reject) => {
      child.once('message', resolve); child.once('error', reject);
    })));
    const results = await Promise.all(children.map((child) => new Promise((resolve, reject) => {
      child.once('message', resolve); child.once('error', reject); child.send('commit');
    })));
    assert.deepEqual(results.sort(), ['SKILL_CANDIDATE_CONFLICT', 'applied']);
    const store = createSkillCandidateService({ dir }); const saved = await store.load();
    assert.equal(saved.revision, 1); assert.equal(saved.candidates.length, 1);
    assert.ok(['A', 'B'].includes(saved.candidates[0].id));
  } finally { for (const child of children) child.kill(); await rm(dir, { recursive: true, force: true }); }
});

test('host refuses to erase replay tombstones even with a fresh revision', async () => {
  const dir = await mkdtemp(join(scratch, 'replay-'));
  try {
    const host = createSkillCandidateService({ dir }); const list = await host.load();
    list.seenSources = ['already-observed'];
    await host.compareAndSwap(0, list);
    const next = await host.load(); next.seenSources = [];
    await assert.rejects(host.compareAndSwap(next.revision, next), /REPLAY_ERASURE/);
    assert.deepEqual((await host.load()).seenSources, ['already-observed']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('remote host namespace isolates tenant, server, account and workspace', async () => {
  const dir = await mkdtemp(join(scratch, 'namespace-'));
  try {
    const namespace = { tenantId: 'tenant', serverId: 'server', accountId: 'account', workspaceId: 'workspace' };
    const a = createSkillCandidateService({ dir, namespace }); const list = await a.load();
    list.candidates.push({ id: 'a', lesson: 'lesson', context: '', sources: ['a'], consecutive: 1, submitted: false });
    await a.compareAndSwap(0, list);
    for (const key of Object.keys(namespace)) {
      assert.equal((await createSkillCandidateService({ dir, namespace: { ...namespace, [key]: 'other' } }).load()).candidates.length, 0);
    }
    assert.equal((await a.load()).candidates.length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
