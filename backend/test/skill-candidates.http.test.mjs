import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { issueSession } from '../src/session.mjs';
import { REMOTE_SKILL_HOST_ID } from '../../packages/protocol/index.js';

async function fixture(t) {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'ugs-candidates-http-'));
  const env = { UGS_RUNNER_HOST: '127.0.0.1', UGS_RUNNER_PORT: '0', UGS_RUNNER_AUTH_MODE: 'multiuser',
    UGS_RUNNER_TOKEN: 'candidate-service-fixture', UGS_RUNNER_JWT_SECRET: 'candidate-jwt-fixture',
    UGS_RUNNER_DATADIR: join(dir, 'data'), UGS_RUNNER_WORKDIR: join(dir, 'work'), UGS_RUNNER_ACCOUNTS: '[]',
    UGS_RUNNER_TENANT_ID: 'tenant-a', UGS_RUNNER_SERVER_ID: 'server-a' };
  const oldEnv = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  // Import the production server from an empty scratch cwd: never read repo .env.
  const cwd = process.cwd(); let mod;
  try { process.chdir(dir); mod = await import(`../src/server.mjs?candidates=${Date.now()}-${Math.random()}`); }
  finally { process.chdir(cwd); }
  if (!mod.server.listening) await new Promise((done) => mod.server.once('listening', done));
  const base = `http://127.0.0.1:${mod.server.address().port}`;
  const users = ['account-a', 'account-b'].map((id) => ({ id, email: `${id}@fixture.invalid`, emailVerified: true, status: 'active' }));
  users.forEach((user) => mod.store.upsertUser(user));
  const tokens = users.map((user) => issueSession(mod.store, user, { jwtSecret: env.UGS_RUNNER_JWT_SECRET }).accessToken);
  const project = { id: 'candidate-project', userId: users[0].id, label: 'Candidate disk fixture', repoUrl: null };
  mod.store.upsertProject(project);
  const origin = { hostId: REMOTE_SKILL_HOST_ID, workspaceId: project.id, sessionId: 'candidate-session', turnId: 'source-message', runId: 'source-job' };
  const job = { id: origin.runId, projectId: project.id, userId: users[0].id, status: 'done', prompt: 'Check the actual manifest.',
    skillOrigin: origin, createdAt: 1, updatedAt: 2, messages: [] };
  mod.store.upsertJob(job);
  await mod.store._writeChain;
  t.after(async () => {
    await new Promise((done) => { mod.server.close(done); mod.server.closeAllConnections(); });
    await mod.store._writeChain.catch(() => {});
    await mod.settleWorkspacePrepares();
    for (const [key, value] of Object.entries(oldEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(dir, { recursive: true, force: true });
  });
  const path = `/projects/${project.id}/skill-service/candidates`;
  const post = async (body, token = tokens[0]) => {
    const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const directory = join(env.UGS_RUNNER_WORKDIR, project.userId, project.id, '.ultragamestudio', 'skill-learning');
  const candidatePath = (tenantId = 'tenant-a', serverId = 'server-a', accountId = 'account-a') => join(directory,
    `pre-review.${createHash('sha256').update(JSON.stringify([tenantId, serverId, accountId, project.id])).digest('hex')}.json`);
  return { mod, post, origin, job, tokens, directory, candidatePath, project, env };
}

test('candidate HTTP requires authentication and exact workspace ownership before disk access', async (t) => {
  const { post, origin, tokens, directory } = await fixture(t);
  for (const action of ['load', 'compare_and_swap']) {
    const body = { action, origin, ...(action === 'compare_and_swap' ? { list, expectedRevision: 0 } : {}) };
    assert.equal((await post(body, '')).status, 401);
    assert.equal((await post(body, 'invalid-fixture-token')).status, 401);
    assert.equal((await post(body, tokens[1])).status, 404);
  }
  await assert.rejects(readdir(directory), { code: 'ENOENT' });
});

test('candidate route rejects client namespace and authority overrides for load and CAS', async (t) => {
  const { post, origin, directory } = await fixture(t);
  for (const action of ['load', 'compare_and_swap']) {
    const body = { action, origin, ...(action === 'compare_and_swap' ? { list, expectedRevision: 0 } : {}) };
    for (const field of ['namespace', 'tenantId', 'serverId', 'accountId', 'workspaceId', 'root', 'cwd', 'actor', 'ownerControl']) {
      assert.equal((await post({ ...body, [field]: 'untrusted' })).status, 400, field);
    }
    for (const changed of [{ ...origin, workspaceId: 'another-project' }, { ...origin, hostId: 'local' },
      { ...origin, namespace: 'untrusted' }, { ...origin, turnId: '' }, { ...origin, runId: 'x'.repeat(201) }]) {
      assert.equal((await post({ ...body, origin: changed })).status, 400);
    }
  }
  await assert.rejects(readdir(directory), { code: 'ENOENT' });
});

test('candidate route checks a fresh exact persisted completed source rather than optimistic jobs', async (t) => {
  const { mod, post, origin, job, directory } = await fixture(t);
  for (const changed of [{ ...origin, sessionId: 'foreign-session' }, { ...origin, turnId: 'foreign-turn' }, { ...origin, runId: 'missing-run' }]) {
    assert.equal((await post({ action: 'load', origin: changed })).status, 400);
  }
  // The write chain resolves, but backing storage lacks the source. A cached
  // completed job must not grant load or write authority.
  const disk = JSON.parse(await readFile(mod.store.file, 'utf8'));
  for (const changed of [null, { ...job, prompt: '' }, { ...job, prompt: 'A different literal source.' },
    { ...job, status: 'running' }, { ...job, userId: 'account-b' }, { ...job, skillOrigin: { ...origin, turnId: 'foreign-turn' } }]) {
    const value = structuredClone(disk);
    if (changed === null) delete value.jobs[origin.runId]; else value.jobs[origin.runId] = changed;
    await writeFile(mod.store.file, JSON.stringify(value));
    for (const action of ['load', 'compare_and_swap']) {
      const response = await post({ action, origin, ...(action === 'compare_and_swap' ? { list, expectedRevision: 0 } : {}) });
      assert.equal(response.status, 400);
      assert.equal(response.body.error, 'SKILL_CANDIDATE_SOURCE_NOT_PERSISTED');
    }
  }
  await assert.rejects(readdir(directory), { code: 'ENOENT' });
});

test('candidate source barrier waits for a changing write chain before authorizing CAS', async (t) => {
  const { mod, post, origin, job, candidatePath } = await fixture(t);
  let releaseFirst; let releaseSecond;
  const first = new Promise((done) => { releaseFirst = done; });
  const second = new Promise((done) => { releaseSecond = done; });
  mod.store._writeChain = first;
  let settled = false;
  const saving = post({ action: 'compare_and_swap', origin, expectedRevision: 0, list }).then((result) => { settled = true; return result; });
  await new Promise((done) => setTimeout(done, 40));
  mod.store._writeChain = first.then(() => second);
  releaseFirst();
  await new Promise((done) => setTimeout(done, 40));
  const premature = settled;
  releaseSecond();
  assert.equal((await saving).status, 200);
  assert.equal(premature, false, 'new source writes must remain behind the barrier');
  assert.equal(JSON.parse(await readFile(candidatePath(), 'utf8')).revision, 1);
  // A later failed persistence barrier must reject, leaving exact bytes intact.
  const before = await readFile(candidatePath());
  mod.store._writeChain = Promise.reject(new Error('FIXTURE_SOURCE_WRITE_FAILED'));
  mod.store._writeChain.catch(() => {});
  assert.equal((await post({ action: 'compare_and_swap', origin, expectedRevision: 1, list: { ...list, revision: 1 } })).status, 400);
  assert.deepEqual(await readFile(candidatePath()), before);
  mod.store._writeChain = Promise.resolve();
});

test('concurrent HTTP candidate CAS keeps one winner and rejects replay erasure without disk changes', async (t) => {
  const { post, origin, candidatePath } = await fixture(t);
  const results = await Promise.all([post({ action: 'compare_and_swap', origin, expectedRevision: 0, list }),
    post({ action: 'compare_and_swap', origin, expectedRevision: 0, list: { ...list, candidates: [], seenSources: ['other-source'] } })]);
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  const before = await readFile(candidatePath());
  const refused = await post({ action: 'compare_and_swap', origin, expectedRevision: 1,
    list: { version: 1, revision: 1, candidates: [], seenSources: [] } });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error, 'SKILL_CANDIDATE_REPLAY_ERASURE');
  assert.deepEqual(await readFile(candidatePath()), before);
});

test('candidate namespaces survive server restart and isolate server-configured tenant/server identity', async (t) => {
  const { mod, post, origin, tokens, env, candidatePath } = await fixture(t);
  const saved = await post({ action: 'compare_and_swap', origin, expectedRevision: 0, list });
  assert.equal(saved.status, 200);
  await new Promise((done) => { mod.server.close(done); mod.server.closeAllConnections(); });
  const start = async (tenantId, serverId) => {
    process.env.UGS_RUNNER_TENANT_ID = tenantId; process.env.UGS_RUNNER_SERVER_ID = serverId;
    const cwd = process.cwd(); let restarted;
    try { process.chdir(join(env.UGS_RUNNER_DATADIR, '..')); restarted = await import(`../src/server.mjs?restart=${Date.now()}-${Math.random()}`); }
    finally { process.chdir(cwd); }
    if (!restarted.server.listening) await new Promise((done) => restarted.server.once('listening', done));
    const call = async (body) => {
      const response = await fetch(`http://127.0.0.1:${restarted.server.address().port}/projects/${origin.workspaceId}/skill-service/candidates`,
        { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[0]}` }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
    return { call, close: async () => { await new Promise((done) => { restarted.server.close(done); restarted.server.closeAllConnections(); }); await restarted.store._writeChain; } };
  };
  const restarted = await start('tenant-a', 'server-a');
  try { assert.deepEqual((await restarted.call({ action: 'load', origin })).body.result, saved.body.result); }
  finally { await restarted.close(); }
  const other = await start('tenant-b', 'server-b');
  try {
    assert.deepEqual((await other.call({ action: 'load', origin })).body.result, { version: 1, revision: 0, candidates: [] });
    assert.equal((await other.call({ action: 'compare_and_swap', origin, expectedRevision: 0, list })).status, 200);
    assert.deepEqual(JSON.parse(await readFile(candidatePath('tenant-b', 'server-b'), 'utf8')), saved.body.result);
    assert.deepEqual(JSON.parse(await readFile(candidatePath(), 'utf8')), saved.body.result);
  } finally { await other.close(); }
});

const list = { version: 1, revision: 0, candidates: [{ id: 'manifest-first', lesson: 'Read the complete manifest.', context: 'A manifest verification task.',
  sources: ['source-job'], consecutive: 1, submitted: false }], seenSources: ['source-job'] };

test('production authenticated candidate HTTP route CAS persists and freshly reloads its server namespace', async (t) => {
  const { post, origin, candidatePath, directory } = await fixture(t);
  const loaded = await post({ action: 'load', origin });
  assert.equal(loaded.status, 200, 'the production server must mount the authoritative candidate route');
  assert.deepEqual(loaded.body.result, { version: 1, revision: 0, candidates: [] });
  const saved = await post({ action: 'compare_and_swap', origin, expectedRevision: 0, list });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.result.revision, 1);
  assert.deepEqual(JSON.parse(await readFile(candidatePath(), 'utf8')), saved.body.result);
  assert.deepEqual((await post({ action: 'load', origin })).body.result, saved.body.result);
  const conflict = await post({ action: 'compare_and_swap', origin, expectedRevision: 0, list });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error, 'SKILL_CANDIDATE_CONFLICT');
  assert.deepEqual(await readdir(directory), [candidatePath().split(/[\\/]/).at(-1)]);
});
