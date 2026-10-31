import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { REMOTE_SKILL_HOST_ID } from '@ugs/protocol';
import type { RemoteSkillCandidateClient } from './remoteSkillLearning';
// Conditional transport tests do not enable the retired production UI.
vi.mock('./cloudProjects', () => ({ CLOUD_PROJECTS_ENABLED: true, assertCloudProjectsEnabled: () => {} }));
import { RunnerClient } from './remoteWorkspace';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((close) => close())); });

it('the real RunnerClient authenticates candidate CAS to the production server and reloads exact disk bytes', async () => {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'ugs-client-candidates-'));
  const env = { UGS_RUNNER_HOST: '127.0.0.1', UGS_RUNNER_PORT: '0', UGS_RUNNER_AUTH_MODE: 'token',
    UGS_RUNNER_TOKEN: 'candidate-client-fixture', UGS_RUNNER_DATADIR: join(dir, 'data'),
    UGS_RUNNER_WORKDIR: join(dir, 'work'), UGS_RUNNER_ACCOUNTS: '[]', UGS_RUNNER_TENANT_ID: 'client-tenant', UGS_RUNNER_SERVER_ID: 'client-server' };
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  await mkdir(dir, { recursive: true });
  const loader = join(dir, 'native-import.cjs');
  await writeFile(loader, 'module.exports = (url) => import(url);\n');
  const cwd = process.cwd(); let mod;
  try {
    process.chdir(dir);
    // Native ESM loading avoids Vite's browser rewrite of the server shebang.
    const importNode = createRequire(import.meta.url)(loader);
    mod = await importNode(pathToFileURL(join(cwd, '..', 'backend', 'src', 'server.mjs')).href);
  } finally { process.chdir(cwd); }
  if (!mod.server.listening) await new Promise<void>((done) => mod.server.once('listening', done));
  cleanup.push(async () => {
    await new Promise<void>((done) => { mod.server.close(done); mod.server.closeAllConnections(); });
    await mod.store._writeChain;
    await mod.settleWorkspacePrepares();
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${mod.server.address().port}`;
  const projectId = 'client-candidate-project';
  const origin = { hostId: REMOTE_SKILL_HOST_ID, workspaceId: projectId, sessionId: 'client-session', turnId: 'client-source', runId: 'client-job' };
  mod.store.upsertProject({ id: projectId, userId: 'default', label: 'Client candidate fixture' });
  mod.store.upsertJob({ id: origin.runId, projectId, userId: 'default', status: 'done', skillOrigin: origin, prompt: 'Read the actual manifest.', messages: [] });
  await mod.store._writeChain;
  const client = new RunnerClient(base, env.UGS_RUNNER_TOKEN) as RunnerClient & Partial<RemoteSkillCandidateClient>;
  expect(typeof client.skillCandidateRequest, 'the production client must ship the candidate transport, not a prototype test seam').toBe('function');
  const loaded = await client.skillCandidateRequest!(projectId, { action: 'load', origin });
  expect(loaded).toEqual({ version: 1, revision: 0, candidates: [] });
  const list = { version: 1 as const, revision: 0, candidates: [], seenSources: ['client-job'] };
  const result = await client.skillCandidateRequest!(projectId, { action: 'compare_and_swap', origin, expectedRevision: 0, list });
  const hash = createHash('sha256').update(JSON.stringify(['client-tenant', 'client-server', 'default', projectId])).digest('hex');
  const path = join(env.UGS_RUNNER_WORKDIR, 'default', projectId, '.ultragamestudio', 'skill-learning', `pre-review.${hash}.json`);
  expect(result).toEqual({ ...list, revision: 1 });
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(result);
  expect(await (new RunnerClient(base, env.UGS_RUNNER_TOKEN) as typeof client).skillCandidateRequest!(projectId, { action: 'load', origin })).toEqual(result);
  await expect(client.skillCandidateRequest!(projectId, { action: 'compare_and_swap', origin, expectedRevision: 0, list })).rejects.toThrow('SKILL_CANDIDATE_CONFLICT');
  const anonymous = new RunnerClient(base, '') as typeof client;
  await expect(anonymous.skillCandidateRequest!(projectId, { action: 'load', origin })).rejects.toThrow('unauthorized');
}, 30000);
