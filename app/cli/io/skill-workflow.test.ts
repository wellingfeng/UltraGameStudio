import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { ResolvedRoute } from '../config/providers';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SkillOrigin } from '../../src/runtime/skills/types';

const dirs: string[] = [];
const servers: Server[] = [];
const isolated = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async (original) => ({ ...await original<typeof import('node:os')>(),
  homedir: () => { if (!isolated.home) throw new Error('Workflow fixture home is not initialized'); return isolated.home; },
}));
beforeEach(async () => {
  isolated.home = await workspace();
  for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'XAI_API_KEY']) vi.stubEnv(name, undefined);
  (await import('../config/providers')).resetFucConfigCache();
});
afterEach(async () => {
  vi.unstubAllEnvs(); vi.restoreAllMocks();
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function workspace() { const dir = await mkdtemp(join(tmpdir(), 'ugs-node-skill-workflow-')); dirs.push(dir); return dir; }
const origin: SkillOrigin = { hostId: 'node-cli', workspaceId: 'workspace-a', sessionId: 'session-a', turnId: 'turn-a', runId: 'run-a' };

async function implementation() { return await import(/* @vite-ignore */ './skill-workflow'); }

describe('Node shared skill workflow', () => {
  it('reports an unavailable CLI learning channel instead of spawning a general reviewer', async () => {
    const { createNodeSkillWorkflow } = await implementation();
    const flow = createNodeSkillWorkflow({ origin, cwd: await workspace(), adapter: 'codex', prompt: 'task' });
    expect(await flow.finish({ finalAnswer: 'done', terminal: 'completed' })).toMatchObject({
      status: 'unavailable', origin, reason: expect.stringContaining('SKILL_REVIEW_UNAVAILABLE'),
    });
  });

  it('uses the shared reviewer over real HTTP and the managed-root service only after authentic activity', async () => {
    const { createNodeSkillWorkflow } = await implementation();
    const dir = await workspace();
    const content = '---\nname: verify-work\ndescription: Use when verifying changes.\n---\nRun the actual check before reporting success.\n';
    const payloads: Record<string, unknown>[] = [];
    const server = createServer((req, res) => {
      let body = ''; req.setEncoding('utf8'); req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const payload = JSON.parse(body); payloads.push(payload);
        const snapshot = JSON.parse(payload.messages[1].content);
        res.writeHead(200, { 'content-type': 'application/json' });
        if (payload.messages[0].content.includes('语义比对器')) {
          res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ candidateId: snapshot.candidates[0].id, similarity: 0.98 }) } }],
            usage: { prompt_tokens: 20, completion_tokens: 20 } })); return;
        }
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ version: 1, kind: 'propose',
          lesson: 'Verify actual outcomes before reporting success.', evidenceIds: snapshot.evidence.map((e: { evidenceId: string }) => e.evidenceId),
          operations: [{ action: 'create', name: 'verify-work', content }] }) } }],
          usage: { prompt_tokens: 20, completion_tokens: 20, total_tokens: 40 } }));
      });
    });
    servers.push(server); await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('server');
    const route: ResolvedRoute = { selection: { adapter: 'custom', modelClass: 'review' }, adapter: 'custom', modelClass: 'review',
      mode: 'direct', transport: 'openai-compatible', model: 'review-model', baseUrl: `http://127.0.0.1:${address.port}` };
    const flow = createNodeSkillWorkflow({ origin, cwd: dir, adapter: 'codex', prompt: 'task', route,
      config: { activityThreshold: 1 } });
    expect(flow.onNativeToolEvent, 'Native tool callback must reach the shared collector').toBeTypeOf('function');
    flow.onNativeToolEvent({ runId: origin.runId, toolCallId: 'tool-a', toolName: 'Bash', phase: 'end',
      provenance: 'native-tool', occurredAt: 1, args: { command: 'npm test' }, result: 'PASS', status: 'success', exitCode: 0 });
    const result = await flow.finish({ finalAnswer: 'done', terminal: 'completed' });
    const snapshot = JSON.parse((payloads[0].messages as Array<{ content: string }>)[1].content);
    expect(snapshot.evidence[0]).toMatchObject({ kind: 'verification', provenance: 'native-tool', exitCode: 0 });
    expect(result).toMatchObject({ status: 'reviewed', result: { status: 'noop', operationsApplied: 0, usage: { calls: 1, estimated: false } } });
    await expect(readFile(join(dir, '.ultragamestudio', 'skills', 'verify-work', 'SKILL.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    const candidates = JSON.parse(await readFile(join(dir, '.ultragamestudio', 'skill-learning', 'pre-review.v1.json'), 'utf8'));
    expect(candidates.candidates[0]).toMatchObject({ consecutive: 1, submitted: false });
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).not.toHaveProperty('tools');
    expect(payloads[0]).not.toHaveProperty('mcp');
    const repeatedOrigin = { ...origin, turnId: 'second-turn', runId: 'second-run' };
    const repeated = createNodeSkillWorkflow({ origin: repeatedOrigin, cwd: dir, adapter: 'codex', prompt: 'repeat task', route,
      config: { activityThreshold: 1 } });
    repeated.onNativeToolEvent({ runId: repeatedOrigin.runId, toolCallId: 'second-test', toolName: 'Bash', phase: 'end',
      provenance: 'native-tool', occurredAt: 2, args: { command: 'npm test' }, result: 'PASS', status: 'success', exitCode: 0 });
    const pending = await repeated.finish({ finalAnswer: 'done again', terminal: 'completed' });
    expect(pending).toMatchObject({ status: 'reviewed', result: { status: 'awaiting_approval', operationsApplied: 0 } });
    expect(payloads).toHaveLength(3);
    await expect(readFile(join(dir, '.ultragamestudio', 'skills', 'verify-work', 'SKILL.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    if (pending.status !== 'reviewed') throw new Error('Expected a reviewed candidate');
    // @ts-expect-error Existing Node filesystem service has no TypeScript declaration.
    const { createWorkspaceSkillService } = await import('../../../backend/src/workspace-skill-service.mjs');
    const service = createWorkspaceSkillService({ dir, hostId: origin.hostId, workspaceId: origin.workspaceId });
    const applied = await service.request({ action: 'approve', origin: repeatedOrigin, mode: 'approve-all', batchId: pending.result.batchId });
    expect(applied).toMatchObject({ status: 'applied', operationsApplied: 1 });
    expect(await readFile(join(dir, '.ultragamestudio', 'skills', 'verify-work', 'SKILL.md'), 'utf8')).toBe(content);
  });

  it('discovers the persisted independent HTTP reviewer and writes its proposal using the review model rather than the source CLI model', async () => {
    const { createNodeSkillWorkflow } = await implementation();
    const dir = await workspace();
    const payloads: Record<string, unknown>[] = [];
    const content = '---\nname: review-route-checks\ndescription: Use when checking review routing.\n---\nKeep low-authority review separate from ordinary coding execution.\n';
    const server = createServer((req, res) => {
      let body = ''; req.setEncoding('utf8'); req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const payload = JSON.parse(body); payloads.push(payload);
        const snapshot = JSON.parse(payload.messages[1].content);
        res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ version: 1, kind: 'propose',
          lesson: 'Keep low-authority review separate from ordinary coding execution.', evidenceIds: snapshot.evidence.map((item: { evidenceId: string }) => item.evidenceId),
          operations: [{ action: 'create', name: 'review-route-checks', content }] }) } }], usage: { prompt_tokens: 20, completion_tokens: 20 } }));
      });
    });
    servers.push(server); await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('server');
    await mkdir(join(dir, '.ugs'), { recursive: true });
    const path = join(dir, '.ugs', 'config.json');
    await writeFile(path, JSON.stringify({ providers: { 'fixture-review': { transport: 'cli', baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'foreground/default' } },
      skillLearning: { reviewSelection: { adapter: 'codex', providerId: 'fixture-review', modelClass: 'review/selected', model: 'review/pinned-model' }, reviewTransport: 'openai-compatible', activityThreshold: 1 } }));
    const before = await readFile(path);
    const providers = await import('../config/providers');
    const ordinary = vi.spyOn(providers, 'resolveDirectRoute').mockImplementation(() => { throw new Error('FORBIDDEN_GENERAL_GATEWAY'); });
    const cli = vi.spyOn(providers, 'resolveCliRoute').mockImplementation(() => { throw new Error('FORBIDDEN_REVIEW_CLI'); });
    const flow = createNodeSkillWorkflow({ origin, cwd: dir, adapter: 'claude-code', prompt: 'task' });
    flow.onHostVerification({ toolCallId: 'actual-check', command: 'node check.mjs', exitCode: 0, output: 'CHECK PASSED' });
    expect(await flow.finish({ finalAnswer: 'done', terminal: 'completed' })).toMatchObject({ status: 'reviewed', result: { status: 'noop', operationsApplied: 0 } });
    expect(payloads).toHaveLength(1);
    expect(payloads[0].model).toBe('review/pinned-model');
    expect(Object.keys(payloads[0]).sort()).toEqual(['max_tokens', 'messages', 'model', 'stream']);
    expect(ordinary).not.toHaveBeenCalled(); expect(cli).not.toHaveBeenCalled();
    await expect(readFile(join(dir, '.ultragamestudio', 'skills', 'review-route-checks', 'SKILL.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path)).toEqual(before);
  });

  it('uses the configured HTTP reviewer for optional semantic context selection without using ordinary routing', async () => {
    const { createNodeSkillWorkflow } = await implementation(); const dir = await workspace();
    const pkg = join(dir, '.ultragamestudio', 'skills', 'review-route-checks'); await mkdir(pkg, { recursive: true });
    const content = '---\nname: review-route-checks\ndescription: Use when checking review routing.\n---\nSELECTOR FULL RULE.\n';
    await writeFile(join(pkg, 'SKILL.md'), content);
    const payloads: Record<string, unknown>[] = [];
    const server = createServer((req, res) => {
      let body = ''; req.setEncoding('utf8'); req.on('data', (chunk) => { body += chunk; }); req.on('end', () => {
        const payload = JSON.parse(body); payloads.push(payload); const index = JSON.parse(payload.messages[1].content).index;
        res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ skillIds: [index[0].skillId] }) } }] }));
      });
    });
    servers.push(server); await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('server');
    await mkdir(join(dir, '.ugs'), { recursive: true });
    await writeFile(join(dir, '.ugs', 'config.json'), JSON.stringify({ providers: { 'fixture-review': { transport: 'cli', baseUrl: `http://127.0.0.1:${address.port}` } },
      skillLearning: { reviewSelection: { adapter: 'codex', providerId: 'fixture-review', modelClass: 'selector/review-model' }, reviewTransport: 'openai-compatible' } }));
    const providers = await import('../config/providers');
    const ordinary = vi.spyOn(providers, 'resolveDirectRoute').mockImplementation(() => { throw new Error('FORBIDDEN_GENERAL_GATEWAY'); });
    const flow = createNodeSkillWorkflow({ origin, cwd: dir, adapter: 'claude-code', prompt: 'inspect an unrelated description' });
    const context = await flow.loadContext();
    expect(context.loadedSkills).toHaveLength(1); expect(context.prompt).toContain('SELECTOR FULL RULE');
    expect(payloads).toHaveLength(1); expect(payloads[0]).toMatchObject({ model: 'selector/review-model', stream: false, max_tokens: 512 });
    expect(ordinary).not.toHaveBeenCalled();
  });

  it('prefers an independent configured reviewer over a source HTTP route supplied by the caller', async () => {
    const { createNodeSkillWorkflow } = await implementation(); const dir = await workspace();
    const payloads: Record<string, unknown>[] = [];
    const server = createServer((req, res) => {
      let body = ''; req.setEncoding('utf8'); req.on('data', (chunk) => { body += chunk; }); req.on('end', () => {
        payloads.push(JSON.parse(body)); res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
        res.end(JSON.stringify({ choices: [{ message: { content: '{"version":1,"kind":"noop","reason":"no new lesson"}' } }] }));
      });
    });
    servers.push(server); await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('server');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    await mkdir(join(dir, '.ugs'), { recursive: true });
    await writeFile(join(dir, '.ugs', 'config.json'), JSON.stringify({ providers: { 'fixture-review': { transport: 'openai-compatible', baseUrl, model: 'review/default' } } }));
    const route: ResolvedRoute = { selection: { adapter: 'claude-code', modelClass: 'foreground/source' }, adapter: 'claude-code', modelClass: 'foreground/source',
      mode: 'direct', transport: 'anthropic', model: 'foreground/source', baseUrl };
    const flow = createNodeSkillWorkflow({ origin, cwd: dir, adapter: 'claude-code', prompt: 'task', route,
      config: { activityThreshold: 1, reviewSelection: { adapter: 'codex', providerId: 'fixture-review', modelClass: 'review/exact-model' }, reviewTransport: 'openai-compatible' } });
    flow.onHostVerification({ toolCallId: 'actual-check', command: 'node check.mjs', exitCode: 0, output: 'PASS' });
    expect(await flow.finish({ finalAnswer: 'done', terminal: 'completed' })).toMatchObject({ status: 'reviewed', result: { status: 'noop' } });
    expect(payloads).toHaveLength(1); expect(payloads[0].model).toBe('review/exact-model');
    expect(payloads[0]).not.toHaveProperty('system'); expect(route.model).toBe('foreground/source'); expect(route.transport).toBe('anthropic');
  });

  it('loads the full managed skill via shared context before execution and re-reads external changes', async () => {
    const { createNodeSkillWorkflow } = await implementation();
    const dir = await workspace();
    const packageDir = join(dir, '.ultragamestudio', 'skills', 'verify-work');
    await mkdir(packageDir, { recursive: true });
    const content = '---\nname: verify-work\ndescription: Use when verifying changes.\n---\nFIRST FULL RULE: test before reporting.\n';
    const file = join(packageDir, 'SKILL.md'); await writeFile(file, content);
    const first = createNodeSkillWorkflow({ origin, cwd: dir, adapter: 'codex', prompt: '/verify-work task' });
    expect(first.loadContext, 'Shared context loader must be exposed').toBeTypeOf('function');
    const loaded = await first.loadContext();
    expect(loaded.prompt.startsWith('/verify-work task')).toBe(true);
    expect(loaded.prompt).toContain('FIRST FULL RULE');
    expect(loaded.loadedSkills).toHaveLength(1);
    const changed = content.replace('FIRST FULL RULE', 'UPDATED FULL RULE'); await writeFile(file, changed);
    const second = createNodeSkillWorkflow({ origin: { ...origin, runId: 'run-b' }, cwd: dir, adapter: 'codex', prompt: '/verify-work task' });
    const current = await second.loadContext();
    expect(current.prompt).toContain('UPDATED FULL RULE');
    expect(current.loadedSkills[0].hash).not.toBe(loaded.loadedSkills[0].hash);
  });

  it('feeds an actual host verification result into the shared evidence pipeline without parsing model claims', async () => {
    const { createNodeSkillWorkflow } = await implementation();
    let seen: Record<string, unknown> | undefined;
    const flow = createNodeSkillWorkflow({ origin, cwd: await workspace(), adapter: 'codex', prompt: 'task',
      config: { activityThreshold: 1 }, model: { capability: 'completion-only', complete: async (request) => {
        seen = JSON.parse(request.userContent); return { text: '{"version":1,"kind":"noop","reason":"no new lesson"}' };
      } } });
    expect(flow.onHostVerification).toBeTypeOf('function');
    flow.onHostVerification({ toolCallId: 'host-check', command: 'node check.mjs', exitCode: 0, output: 'actual check passed' });
    expect(await flow.finish({ finalAnswer: 'assistant claimed success', terminal: 'completed' })).toMatchObject({ status: 'reviewed', result: { status: 'noop' } });
    expect(seen?.evidence).toMatchObject([{ origin, provenance: 'host-check', toolCallId: 'host-check',
      kind: 'verification', toolName: 'verify-command', status: 'success', exitCode: 0, result: 'actual check passed' }]);
  });

  it('exposes a foreground tool host whose evidence is bound to the same authentic invocation and cannot learn from a model claim', async () => {
    const { createNodeSkillWorkflow } = await implementation();
    const cwd = await workspace();
    const flow = createNodeSkillWorkflow({ origin, cwd, adapter: 'claude-code', prompt: 'task', config: { mode: 'auto-safe' } });
    const toolsFactory = (flow as unknown as { foregroundTools?: () => unknown }).foregroundTools;
    expect(toolsFactory, 'Workflow must publish a host-only foreground tool port').toBeTypeOf('function');
    const options = toolsFactory!() as import('./skill-tools').NodeSkillToolOptions;
    const { createNodeSkillToolDispatcher } = await import('./skill-tools');
    const nativeRun = `${origin.runId}/cli/active`;
    const tools = createNodeSkillToolDispatcher({ ...options, origin: { ...origin, runId: nativeRun } });
    flow.onNativeToolEvent({ runId: nativeRun, toolCallId: 'check', toolName: 'Bash', phase: 'end', provenance: 'model-output',
      args: { command: 'npm test' }, result: 'PASS', status: 'success', exitCode: 0 });
    expect(await tools.invoke('skills_list', {})).toMatchObject({ learningEvidence: [] });
    flow.onNativeToolEvent({ runId: nativeRun, toolCallId: 'check', toolName: 'Bash', phase: 'end', provenance: 'native-tool',
      args: { command: 'npm test' }, result: 'PASS', status: 'success', exitCode: 0 });
    const catalog = await tools.invoke('skills_list', {}) as { learningEvidence: Array<{ evidenceId: string }> };
    expect(catalog.learningEvidence).toMatchObject([{ kind: 'verification', provenance: 'native-tool', exitCode: 0 }]);
    const content = '---\nname: verify-outcomes\ndescription: Use when checking outcomes.\n---\nRead actual results before reporting success.\n';
    expect(await tools.invoke('skill_manage', { version: 1, kind: 'propose', lesson: 'Read actual outcomes.', evidenceIds: catalog.learningEvidence.map((e) => e.evidenceId),
      operations: [{ action: 'create', name: 'verify-outcomes', content }] })).toMatchObject({ status: 'applied', operationsApplied: 1 });
    expect(await readFile(join(cwd, '.ultragamestudio', 'skills', 'verify-outcomes', 'SKILL.md'), 'utf8')).toBe(content);
  });

  it('preserves separate host invocation identities through the shared collector and reviewer', async () => {
    const { createNodeSkillWorkflow } = await implementation();
    let seen: Record<string, unknown> | undefined;
    const flow = createNodeSkillWorkflow({ origin, cwd: await workspace(), adapter: 'codex', prompt: 'task',
      config: { activityThreshold: 2 }, model: { capability: 'completion-only', complete: async (request) => {
        seen = JSON.parse(request.userContent);
        return { text: '{"version":1,"kind":"noop","reason":"no new lesson"}' };
      } } });
    for (const runId of ['other-task/cli/1', `${origin.runId}/cli/1`, `${origin.runId}/cli/2`]) {
      flow.onNativeToolEvent({ runId, toolCallId: 'same-tool-id', toolName: 'Bash', phase: 'end', provenance: 'native-tool',
        occurredAt: 1, args: { command: 'npm test' }, result: 'PASS', status: 'success', exitCode: 0 });
    }
    expect(await flow.finish({ finalAnswer: 'done', terminal: 'completed' })).toMatchObject({ status: 'reviewed' });
    const evidence = seen?.evidence as Array<{ origin: SkillOrigin; toolCallId: string }>;
    expect(evidence.map((item) => item.origin.runId)).toEqual([`${origin.runId}/cli/1`, `${origin.runId}/cli/2`]);
    expect(evidence.map((item) => item.toolCallId)).toEqual(['same-tool-id', 'same-tool-id']);
  });
});
