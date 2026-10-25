import { Blob as NodeBlob } from 'node:buffer';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { REMOTE_SKILL_HOST_ID, RunnerClient, type RemoteJob } from '@ugs/protocol';
import type { GatewayProvider } from './modelGateway/types';
import type { SkillCatalog, SkillLearningConfig, SkillMutationResult, SkillOrigin, SkillReviewState } from '@/runtime/skills/types';
import type { SkillServiceRequest } from './skills';
// @ts-expect-error Existing filesystem service has no TypeScript declaration.
import { createWorkspaceSkillService } from '../../../backend/src/workspace-skill-service.mjs';

const seams = vi.hoisted(() => ({
  providers: [] as GatewayProvider[],
  cli: vi.fn(() => { throw new Error('FORBIDDEN_CLI_REVIEW'); }),
  generic: vi.fn(() => { throw new Error('FORBIDDEN_GENERAL_GATEWAY'); }),
}));
vi.mock('@/lib/gatewayConfig', () => ({ listGatewayProviders: () => seams.providers }));
vi.mock('@/lib/tauri', async (original) => ({
  ...await original<typeof import('@/lib/tauri')>(),
  tauriAvailable: () => false,
  aiEditViaCli: seams.cli,
}));
vi.mock('./modelGateway/modelGateway', () => ({ completeGatewayText: seams.generic }));
import { createRemoteSkillControlHost, finishRemoteLearning, requestRemoteContext } from './remoteSkillLearning';
import { DEFAULT_SKILL_LEARNING_CONFIG } from './skillLearningConfig';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  window.localStorage.clear();
  await Promise.all(cleanup.splice(0).map((close) => close()));
  seams.providers = [];
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it('dispatches the persisted independent HTTP protocol for a CLI source through real loopback HTTP and disk', async () => {
  // A local HTTP host fixture, not a deployed runner or a live model provider.
  // Tool envelopes are fixtures around a genuinely executed host check.
  const scratch = process.env.TMPDIR ?? tmpdir();
  await mkdir(scratch, { recursive: true });
  const dir = await mkdtemp(join(scratch, 'ugs-remote-review-http-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const origin: SkillOrigin = { hostId: REMOTE_SKILL_HOST_ID, workspaceId: 'remote-http-fixture',
    sessionId: 'independent-http-session', turnId: 'checked-turn', runId: 'checked-host-run' };
  const service = createWorkspaceSkillService({ dir, hostId: origin.hostId, workspaceId: origin.workspaceId }) as {
    request(request: SkillServiceRequest): Promise<unknown>;
    setConfig(config: Partial<SkillLearningConfig>): Promise<SkillLearningConfig>;
    getConfig(): Promise<SkillLearningConfig>;
  };
  const reviewSelection = { adapter: 'codex', modelClass: 'default', providerId: 'remote-review-provider',
    channelId: 'review-cli-channel', model: 'independent-review-model' };
  const config = { ...DEFAULT_SKILL_LEARNING_CONFIG, activityThreshold: 1, cooldownMs: 0, timeoutMs: 10000,
    reviewSelection, reviewTransport: 'openai-compatible' as const };
  await service.setConfig(config);
  const statePath = join(dir, '.ultragamestudio', 'skills', '.state', 'state.json');
  expect(JSON.parse(await readFile(statePath, 'utf8')).config).toEqual(config);

  const manifestPath = join(dir, 'package.json');
  await writeFile(manifestPath, JSON.stringify({ name: 'remote-review-fixture', version: '1.0.0', private: true }));
  const checkPath = join(dir, 'manifest-check.test.mjs');
  await writeFile(checkPath, "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs'; test('reads the actual project manifest', () => assert.equal(JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).name, 'remote-review-fixture'));\n");
  const checked = await promisify(execFile)(process.execPath, ['--test', '--test-reporter=tap', checkPath]);
  expect(checked.stdout).toContain('# fail 0');
  const job: RemoteJob = { id: origin.runId, projectId: origin.workspaceId, skillOrigin: origin,
    status: 'done', createdAt: 1, updatedAt: 2, repoUrl: null, branch: null, adapter: 'codex', model: null,
    prompt: 'Verify the manifest.', pushBranch: null, logs: [], result: { exitCode: 0 }, error: null,
    messages: [{ at: Date.now(), role: 'tool', kind: 'tool', runId: origin.runId, toolCallId: 'actual-manifest-check',
      toolName: 'command_execution', phase: 'end', provenance: 'native-tool', status: 'success', toolExitCode: 0,
      args: { command: `node --test --test-reporter=tap ${JSON.stringify(checkPath)}` }, result: checked.stdout }] };
  const jobPath = join(dir, 'persisted-job.json');
  await writeFile(jobPath, JSON.stringify(job));
  const content = '---\nname: manifest-first\ndescription: Use when choosing project dependencies.\n---\n\nRead the complete project manifest before choosing dependencies so versions match the project.\n';
  const requests: Array<{ path: string; body?: Record<string, unknown>; owner: boolean }> = [];
  const server = createServer(async (req, res) => {
    try {
      let text = '';
      for await (const chunk of req) text += String(chunk);
      const body = text ? JSON.parse(text) as Record<string, unknown> : undefined;
      const path = req.url ?? '';
      const owner = req.headers['x-ugs-skill-control'] === 'owner';
      requests.push({ path, body, owner });
      let response: unknown;
      if (path.startsWith('/jobs/')) response = { ok: true, job: JSON.parse(await readFile(jobPath, 'utf8')) };
      else if (path === `/projects/${origin.workspaceId}/skill-service/config`) response = { ok: true, config: await service.getConfig() };
      else if (path === `/projects/${origin.workspaceId}/skill-service`) {
        const request = body as unknown as SkillServiceRequest;
        expect(request.origin.hostId).toBe(origin.hostId);
        expect(request.origin.workspaceId).toBe(origin.workspaceId);
        expect(request.origin).not.toHaveProperty('cwd');
        expect(request).not.toHaveProperty('sourceSession');
        expect(owner).toBe(request.action === 'approve' || request.action === 'rollback');
        response = { ok: true, result: await service.request(request) };
      } else if (path === '/v1/chat/completions') {
        expect(owner).toBe(false);
        expect(Object.keys(body!).sort()).toEqual(['max_tokens', 'messages', 'model', 'stream']);
        expect(body).toMatchObject({ model: reviewSelection.model, stream: false });
        const messages = body!.messages as Array<{ content: string }>;
        const review = JSON.parse(messages[1].content) as { candidates?: Array<{ id: string }>; evidence: Array<{ evidenceId: string; origin: SkillOrigin }> };
        if (messages[0].content.includes('语义比对器')) {
          response = { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ candidateId: review.candidates![0].id, similarity: 0.98 }) } }],
            usage: { prompt_tokens: 12, completion_tokens: 18 } };
          res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(response)); return;
        }
        expect(review.evidence).toHaveLength(1);
        expect(review.evidence[0].origin).toEqual(JSON.parse(await readFile(jobPath, 'utf8')).skillOrigin);
        response = { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ version: 1,
          kind: 'propose', lesson: 'Read the complete manifest before choosing project dependencies.',
          evidenceIds: [review.evidence[0].evidenceId], operations: [{ action: 'create', name: 'manifest-first', content }] }) } }],
          usage: { prompt_tokens: 12, completion_tokens: 18, total_tokens: 30 } };
      } else throw new Error(`Unexpected local HTTP fixture path: ${path}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(response));
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(error) }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections();
  }));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing local fixture port');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  seams.providers = [{ id: reviewSelection.providerId, kind: 'codex', adapter: 'codex', name: 'Local reviewer fixture',
    channels: [{ id: reviewSelection.channelId, name: 'Source CLI channel', apiKey: '', baseUrl,
      model: reviewSelection.model, models: undefined,
      route: { transport: 'cli', baseUrl, model: reviewSelection.model, models: undefined } }] }];
  vi.stubGlobal('Blob', NodeBlob);
  const sourceSelection = { adapter: 'codex', modelClass: 'foreground-cli-model', systemDefault: true };
  const client = new RunnerClient(baseUrl, '');
  const states: SkillReviewState[] = [];
  const first = await finishRemoteLearning({ client, projectId: origin.workspaceId, origin,
    userText: 'Verify the actual project manifest.', finalAnswer: 'The manifest check completed.', selection: sourceSelection,
    onState: (state) => { states.push(state); } });
  expect(first).toMatchObject({ status: 'noop', operationsApplied: 0 });
  const repeatedOrigin = { ...origin, turnId: 'repeated-turn', runId: 'repeated-host-run' };
  await writeFile(jobPath, JSON.stringify({ ...job, id: repeatedOrigin.runId, skillOrigin: repeatedOrigin,
    messages: job.messages!.map((message) => ({ ...message, runId: repeatedOrigin.runId })) }));
  const proposed = await finishRemoteLearning({ client, projectId: origin.workspaceId, origin: repeatedOrigin,
    userText: 'Verify the actual project manifest again.', finalAnswer: 'The manifest check completed again.', selection: sourceSelection,
    onState: (state) => { states.push(state); } });
  // This local fixture deliberately does not impersonate the deployed server's
  // native-evidence authentication. Ordinary tool evidence cannot auto-save.
  expect(proposed, proposed?.error).toMatchObject({ status: 'awaiting_approval', origin: repeatedOrigin, operationsApplied: 0,
    usage: { calls: 2, inputTokens: 24, outputTokens: 36, totalTokens: 60, estimated: false } });
  const path = join(dir, '.ultragamestudio', 'skills', 'manifest-first', 'SKILL.md');
  await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  expect(states.at(-1)?.result).toEqual(proposed);
  const control = createRemoteSkillControlHost({ client, projectId: origin.workspaceId, origin: repeatedOrigin, mode: 'off' });
  const applied = await control.approve(proposed!.batchId);
  expect(applied).toMatchObject({ status: 'applied', origin: repeatedOrigin, operationsApplied: 1 });
  expect(await readFile(path, 'utf8')).toBe(content);
  const restarted = createWorkspaceSkillService({ dir, hostId: origin.hostId, workspaceId: origin.workspaceId }) as typeof service;
  expect(await restarted.getConfig()).toEqual(config);
  const catalog = await restarted.request({ action: 'list', origin, mode: 'off' }) as SkillCatalog;
  const learned = catalog.entries.find((entry) => entry.skillId === applied!.changes[0].skillId)!;
  expect(learned.hash).toBe(applied!.changes[0].afterHash);
  const nextOrigin = { ...origin, turnId: 'next-turn', runId: 'next-read-run' };
  const reused = await requestRemoteContext({ client, projectId: origin.workspaceId, origin: nextOrigin,
    prompt: 'Use the learned dependency procedure.', explicitSkillIds: [learned.skillId] });
  const block = reused.prompt.split('<UGS_SKILL_CONTEXT>\n')[1].split('\n</UGS_SKILL_CONTEXT>')[0];
  expect(JSON.parse(block)[0].content).toBe(content);
  expect(reused.loadedSkills[0]).toMatchObject({ skillId: learned.skillId, revision: learned.revision, hash: learned.hash });
  const undone = await control.rollback(applied!.rollbackId!);
  expect(undone).toMatchObject({ status: 'applied', origin: repeatedOrigin, operationsApplied: 1 });
  await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  const history = await restarted.request({ action: 'history', origin, mode: 'off' }) as { results: SkillMutationResult[] };
  expect(history.results.some((result) => result.batchId === undone.batchId && result.status === 'applied')).toBe(true);
  expect(requests.filter((request) => request.path === '/v1/chat/completions')).toHaveLength(3);
  expect(requests.filter((request) => request.body?.action === 'manage').every((request) => !request.owner)).toBe(true);
  expect(seams.providers[0].channels[0].route.transport).toBe('cli');
  expect(sourceSelection).toEqual({ adapter: 'codex', modelClass: 'foreground-cli-model', systemDefault: true });
  expect(seams.cli).not.toHaveBeenCalled();
  expect(seams.generic).not.toHaveBeenCalled();
}, 30000);
