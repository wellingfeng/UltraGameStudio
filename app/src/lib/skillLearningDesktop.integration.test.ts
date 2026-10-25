import { Blob as NodeBlob } from 'node:buffer';
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import type { GatewayProvider } from './modelGateway/types';
import type { SkillCatalog, SkillLearningMode, SkillMutationResult, SkillOrigin, SkillReviewState } from '@/runtime/skills/types';
import type { SkillRunBindingRequest, SkillServiceRequest } from './skills';

interface TestProxyHttpRequest {
  method: string;
  url: string;
  headers: Array<{ name: string; value: string }>;
  bodyBase64: string | null;
  timeoutMs: number;
  maxResponseBytes: number;
}
// @ts-expect-error Existing Node filesystem service has no TS declaration.
import { createWorkspaceSkillService } from '../../../backend/src/workspace-skill-service.mjs';

const seams = vi.hoisted(() => ({
  providers: [] as GatewayProvider[],
  invoke: vi.fn(),
  cli: vi.fn(() => { throw new Error('FORBIDDEN_CLI_FALLBACK'); }),
  generic: vi.fn(() => { throw new Error('FORBIDDEN_GENERIC_GATEWAY'); }),
}));
vi.mock('@/lib/gatewayConfig', () => ({ listGatewayProviders: () => seams.providers }));
vi.mock('@/lib/tauri', async (original) => ({
  ...await original<typeof import('@/lib/tauri')>(),
  // Only native IPC is injected; tauriFetch runs its actual IPC transport wrapper.
  tauriAvailable: () => true,
  aiEditViaCli: seams.cli,
}));

vi.mock('./modelGateway/modelGateway', () => ({ completeGatewayText: seams.generic }));
import { beginSkillLearningTurn, cancelSkillLearning, performSkillReviewAction } from './skillLearningDesktop';
import { DEFAULT_SKILL_LEARNING_CONFIG } from './skillLearningConfig';
import { createSkillControlHost } from './skills';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  window.localStorage.clear();
  cancelSkillLearning();
  await Promise.all(cleanup.splice(0).map((close) => close()));
  seams.providers = [];
  seams.invoke.mockReset();
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  vi.unstubAllGlobals();
});

it.each(['configured-http', 'explicit-http-for-cli'] as const)('holds the first candidate, approves the repeated batch, fresh-loads and undoes it through %s', async (reviewRoute) => {

  const scratch = process.env.TMPDIR ?? tmpdir();
  await mkdir(scratch, { recursive: true });
  const dir = await mkdtemp(join(scratch, 'ugs-desktop-learning-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  // Scheduler replay watermarks deliberately survive cancellation; fixtures
  // for independent protocols need distinct source sessions rather than a reset.
  const origin: SkillOrigin = { hostId: 'local', workspaceId: 'fs-workspace', sessionId: `fs-source-${reviewRoute}`, turnId: 'fs-turn', runId: 'foreground-run' };
  const sessionPath = join(dir, 'source-session.json');
  const service: { request(request: SkillServiceRequest): Promise<unknown> } = createWorkspaceSkillService({ dir, hostId: origin.hostId, workspaceId: origin.workspaceId });
  const bindings = new Map<string, SkillRunBindingRequest>();
  const calls: Array<{ command: string; request?: SkillServiceRequest | SkillRunBindingRequest }> = [];
  const key = (owner: SkillOrigin, actor: string) => JSON.stringify([owner, actor]);
  // Use the SDK's real entry point for concurrent revoke/bind/HTTP imports.
  // The injected IPC host delegates HTTP to an actual loopback fetch, not a canned response.
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: { invoke: seams.invoke } });
  seams.invoke.mockImplementation(async (command: string, args: { request?: (SkillServiceRequest & SkillRunBindingRequest) | TestProxyHttpRequest; origin?: SkillOrigin }) => {
    if (command === 'proxy_http') {
      const request = args.request as TestProxyHttpRequest;
      expect(request.timeoutMs).toBeGreaterThan(0);
      expect(request.timeoutMs).toBeLessThanOrEqual(10000);
      const response = await fetch(request.url, { method: request.method, headers: request.headers.map(({ name, value }): [string, string] => [name, value]),
        body: request.bodyBase64 === null ? undefined : Buffer.from(request.bodyBase64, 'base64'), signal: AbortSignal.timeout(request.timeoutMs) });
      const bytes = Buffer.from(await response.arrayBuffer());
      expect(bytes.byteLength).toBeLessThanOrEqual(request.maxResponseBytes);
      return { status: response.status, statusText: response.statusText, url: response.url,
        headers: Array.from(response.headers, ([name, value]) => ({ name, value })), bodyBase64: bytes.toString('base64') };
    }
    const request = args.request as SkillServiceRequest & SkillRunBindingRequest;
    calls.push({ command, request: request && structuredClone(request) });
    if (command === 'skills_bind_run') {
      const saved = JSON.parse(await readFile(sessionPath, 'utf8'));
      expect(saved).toMatchObject({ workspaceId: request.origin.workspaceId, sessionId: request.origin.sessionId });
      bindings.set(key(request.origin, request.actor), structuredClone(request));
      return;
    }
    if (command === 'skills_revoke_run') { bindings.delete(key(args.origin!, 'background')); return; }
    if (command !== 'skills_request') throw new Error(`Unexpected IPC: ${command}`);

    const actor = ['approve', 'reject', 'rollback', 'set_policy', 'archive', 'restore', 'import'].includes(request.action) ? 'user' : 'background';
    expect(bindings.has(key(request.origin, actor)) || (['list', 'view', 'history', 'usage'].includes(request.action) && bindings.has(key(request.origin, 'user')))).toBe(true);
    return service.request(request);
  });

  const content = '---\nname: manifest-first\ndescription: Use when choosing project dependencies.\n---\n\nRead the complete manifest before selecting dependencies so versions match the project.\n';
  const httpCalls: Array<{ path: string; body: Record<string, unknown>; review?: { evidence: Array<{ evidenceId: string; origin: SkillOrigin }>; task: { userText: string } } }> = [];
  const server: Server = createServer((req, res) => {
    let text = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { text += chunk; });
    req.on('end', () => {
      const body = JSON.parse(text);
      const selection = String(body.messages[0].content).startsWith('Select only');
      const review = selection ? undefined : JSON.parse(body.messages[1].content);
      const similarity = String(body.messages[0].content).includes('语义比对器');
      httpCalls.push({ path: req.url ?? '', body, review });
      const response = selection ? { skillIds: [] } : similarity ? { candidateId: review.candidates[0].id, similarity: 0.98 } : { version: 1, kind: 'propose',
        lesson: 'Read the complete manifest before selecting project dependencies.', evidenceIds: [review.evidence[0].evidenceId],
        operations: [{ action: 'create', name: 'manifest-first', content }] };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(response) } }],
        usage: { prompt_tokens: 41, completion_tokens: 29, total_tokens: 70 } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections();
  }));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing HTTP fixture port');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  seams.providers = [{ id: 'review-provider', kind: 'codex', adapter: 'codex', name: 'Deterministic HTTP',
    channels: [{ id: 'review-http', name: 'completion', apiKey: '', baseUrl, model: 'review-model', models: undefined,
      route: { transport: reviewRoute === 'explicit-http-for-cli' ? 'cli' : 'openai-compatible', baseUrl, model: 'review-model', models: undefined } }] }];
  vi.stubGlobal('Blob', NodeBlob);
  const reviewerSelection = { adapter: 'codex', modelClass: 'default', providerId: 'review-provider', channelId: 'review-http' };
  const selection = reviewRoute === 'explicit-http-for-cli'
    ? { adapter: 'codex', modelClass: 'foreground-cli-model', systemDefault: true }
    : reviewerSelection;
  const config = { ...DEFAULT_SKILL_LEARNING_CONFIG, activityThreshold: 1, cooldownMs: 0, timeoutMs: 10000,
    ...(reviewRoute === 'explicit-http-for-cli' ? { reviewSelection: reviewerSelection, reviewTransport: 'openai-compatible' as const } : {}) };
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  const states: Array<SkillReviewState & { mode?: SkillLearningMode }> = [];
  const turn = beginSkillLearningTurn({ origin, prompt: 'Verify the project dependency check.', selection, config, ready,
    onState: (state) => { states.push(state); } });
  const initialContext = turn.loadContext();
  await Promise.resolve();
  expect(calls).toEqual([]);
  await writeFile(sessionPath, JSON.stringify({ workspaceId: origin.workspaceId, sessionId: origin.sessionId }));
  release();
  await expect(initialContext).resolves.toMatchObject({ loadedSkills: [] });


  const manifestPath = join(dir, 'package.json');
  await writeFile(manifestPath, JSON.stringify({ name: 'dependency-fixture', version: '1.0.0', private: true, dependencies: { 'fixture-lib': '^2.0.0' } }));
  const checkPath = join(dir, 'dependency-check.test.mjs');
  await writeFile(checkPath, "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs'; test('dependency manifest check', () => assert.equal(JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).name, 'dependency-fixture'));\n");
  const check = await promisify(execFile)(process.execPath, ['--test', '--test-reporter=tap', checkPath]);
  expect(check.stdout).toContain('# fail 0');

  turn.onHostEvidence([{ evidenceId: 'actual-dependency-check', origin: { ...origin, runId: 'real-host-check' }, occurredAt: Date.now(),
    toolCallId: 'dependency-check', toolName: 'test', kind: 'verification',
    provenance: 'host-check', status: 'success', exitCode: 0, summary: `node --test --test-reporter=tap ${checkPath}`, result: check.stdout }]);
  const finalAnswer = 'The real dependency check completed.';

  const first = await turn.finish({ finalAnswer, terminal: 'completed' });
  expect(first).toMatchObject({ status: 'noop', operationsApplied: 0,
    usage: { calls: 1, inputTokens: 41, outputTokens: 29, totalTokens: 70, estimated: false } });
  const repeatedOrigin = { ...origin, turnId: 'repeated-turn', runId: 'repeated-run' };
  const repeated = beginSkillLearningTurn({ origin: repeatedOrigin, prompt: 'Verify the project dependency check again.', selection, config, ready,
    onState: (state) => { states.push(state); } });
  const rechecked = await promisify(execFile)(process.execPath, ['--test', '--test-reporter=tap', checkPath]);
  repeated.onHostEvidence([{ evidenceId: 'repeated-dependency-check', origin: repeatedOrigin, occurredAt: Date.now(),
    toolCallId: 'repeated-check', toolName: 'test', kind: 'verification', provenance: 'host-check', status: 'success', exitCode: 0,
    summary: `node --test --test-reporter=tap ${checkPath}`, result: rechecked.stdout }]);
  const pending = await repeated.finish({ finalAnswer, terminal: 'completed' });
  expect(pending, pending.error).toMatchObject({ status: 'awaiting_approval', operationsApplied: 0,
    usage: { calls: 2, inputTokens: 82, outputTokens: 58, totalTokens: 140, estimated: false } });
  const path = join(dir, '.ultragamestudio', 'skills', 'manifest-first', 'SKILL.md');
  await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  expect(states.at(-1)?.result).toEqual(pending);
  const applied = await performSkillReviewAction({ status: pending.status, origin: pending.origin, result: pending, mode: 'approve-all' }, 'approve');
  expect(applied).toMatchObject({ status: 'applied', operationsApplied: 1 });
  expect(applied.origin.runId).not.toBe(origin.runId);
  expect(turn.getSnapshot().finalAnswer).toBe(finalAnswer);
  expect(await readFile(path, 'utf8')).toBe(content);
  expect(httpCalls[0]).toMatchObject({ path: '/v1/chat/completions', body: { model: 'review-model' }, review: { task: { userText: 'Verify the project dependency check.' },
    evidence: [expect.objectContaining({ origin: { ...origin, runId: 'real-host-check' } })] } });
  expect(Object.keys(httpCalls[0].body).sort()).toEqual(['max_tokens', 'messages', 'model', 'stream']);
  expect(seams.cli).not.toHaveBeenCalled();
  expect(seams.generic).not.toHaveBeenCalled();
  expect(seams.providers[0].channels[0].route.transport).toBe(reviewRoute === 'explicit-http-for-cli' ? 'cli' : 'openai-compatible');
  expect(selection).toEqual(reviewRoute === 'explicit-http-for-cli'
    ? { adapter: 'codex', modelClass: 'foreground-cli-model', systemDefault: true }
    : reviewerSelection);

  const nextOrigin = { ...origin, turnId: 'next-turn', runId: 'next-run' };
  const next = beginSkillLearningTurn({ origin: nextOrigin, prompt: 'Use manifest-first for the next dependency task.', selection, config, ready });
  const context = await next.loadContext();

  const delivered = JSON.parse(context.prompt.split('<UGS_SKILL_CONTEXT>\n')[1].split('\n</UGS_SKILL_CONTEXT>')[0]);
  expect(delivered[0].content).toBe(content);
  expect(context.loadedSkills[0]).toMatchObject({ skillId: applied.changes[0].skillId, hash: applied.changes[0].afterHash });
  const reuseCheckPath = join(dir, 'reuse-dependency-rule.test.mjs');
  await writeFile(reuseCheckPath, "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { readFileSync, writeFileSync } from 'node:fs'; test('adopts the manifest-first dependency rule', () => { const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')); const selected = { ...manifest.dependencies }; assert.equal(selected['fixture-lib'], '^2.0.0'); writeFileSync(new URL('./selected-dependencies.json', import.meta.url), JSON.stringify(selected)); });\n");
  const adopted = await promisify(execFile)(process.execPath, ['--test', '--test-reporter=tap', reuseCheckPath]);
  expect(adopted.stdout).toContain('# fail 0');
  expect(JSON.parse(await readFile(join(dir, 'selected-dependencies.json'), 'utf8'))).toEqual({ 'fixture-lib': '^2.0.0' });
  next.onHostEvidence([{ evidenceId: 'actual-manifest-adoption', origin: nextOrigin, occurredAt: Date.now(),
    toolCallId: 'reuse-dependency-rule', toolName: 'saved-byte-check', kind: 'skill-use',
    provenance: 'host-check', status: 'success', exitCode: 0, skillId: context.loadedSkills[0].skillId,
    revision: context.loadedSkills[0].revision, summary: 'The host checked that the next task read the manifest before selecting matching dependency versions.', result: adopted.stdout }]);
  await next.finish({ finalAnswer: 'The next task adopted and verified the delivered dependency rule.', terminal: 'completed' });
  const restarted = createWorkspaceSkillService({ dir, hostId: origin.hostId, workspaceId: origin.workspaceId });
  const measured = await restarted.request({ action: 'list', origin: nextOrigin, mode: 'off' }) as SkillCatalog;
  expect(measured.entries.find((entry) => entry.skillId === context.loadedSkills[0].skillId)?.usage)
    .toMatchObject({ viewed: 1, delivered: 1, usedWithEvidence: 1 });

  // Explicit existing user controls are package-level and remain usable after
  // the foreground background grant closes. No automatic archiver is involved.
  const control = createSkillControlHost({ origin: nextOrigin, mode: 'off', ready });
  const archived = await control.archive(context.loadedSkills[0].skillId);
  expect(archived).toMatchObject({ skillId: context.loadedSkills[0].skillId, state: 'archived' });
  expect((await control.list()).entries.find((entry) => entry.skillId === archived.skillId)?.state).toBe('archived');
  await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  const restored = await control.restore(archived.skillId);
  expect(restored).toMatchObject({ skillId: archived.skillId, state: 'active', hash: context.loadedSkills[0].hash });
  expect((await control.list()).entries.find((entry) => entry.skillId === restored.skillId)?.state).toBe('active');
  expect(await readFile(path, 'utf8')).toBe(content);

  const rolledBack = await performSkillReviewAction({ status: 'applied', origin: applied.origin, result: applied, mode: 'auto-safe' }, 'rollback');

  expect(rolledBack).toMatchObject({ status: 'applied', operationsApplied: 1, origin: applied.origin });
  await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  const actualHistory = await service.request({ action: 'history', origin: applied.origin, mode: 'off' }) as { results: SkillMutationResult[] };
  expect(actualHistory.results.some((result) => result.batchId === rolledBack.batchId && result.status === 'applied')).toBe(true);
  expect(actualHistory.results.some((result) => result.batchId === applied.batchId && result.status === 'applied')).toBe(true);
// Real Windows fsync/CAS, child startup, fresh reads and rollback exceed unit-test timing.
// The independent HTTP model call retains its configured 10-second hard budget.
}, 30000);
