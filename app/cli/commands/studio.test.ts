import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { resetFucConfigCache, type ResolvedRoute } from '../config/providers';
import { createHash } from 'node:crypto';
import type { RunGateway, SpawnCliAgentOpts } from '../../src/runtime';
import { runStudio } from './studio';

const isolated = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async (original) => ({ ...await original<typeof import('node:os')>(),
  homedir: () => { if (!isolated.home) throw new Error('Studio fixture home is not initialized'); return isolated.home; },
}));

let outBuf = '';
let errBuf = '';
let outSpy: { mockRestore: () => void };
let errSpy: { mockRestore: () => void };
let dir: string;
const servers: Server[] = [];

const sink = (append: (s: string) => void) =>
  ((chunk: unknown) => {
    append(String(chunk));
    return true;
  }) as never;

beforeEach(() => {
  outBuf = '';
  errBuf = '';
  outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(sink((s) => (outBuf += s)));
  errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(sink((s) => (errBuf += s)));
  dir = mkdtempSync(join(tmpdir(), 'ugs-studio-'));
  isolated.home = join(dir, 'isolated-home'); mkdirSync(isolated.home, { recursive: true });
  for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'XAI_API_KEY']) vi.stubEnv(name, undefined);
  resetFucConfigCache();
});

afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  outSpy.mockRestore();
  errSpy.mockRestore();
  vi.unstubAllEnvs(); vi.restoreAllMocks(); resetFucConfigCache();
  rmSync(dir, { recursive: true, force: true });
});

describe('ugs studio', () => {
  it('forwards independent reviewer flags into a real Anthropic request without changing foreground CLI selection', async () => {
    writeFileSync(join(dir, 'check.mjs'), "console.log('INDEPENDENT REVIEW CHECK PASSED');\n");
    const content = '---\nname: independent-review\ndescription: Use when isolating background review.\n---\nKeep completion-only review independent of foreground coding execution.\n';
    const payloads: Record<string, unknown>[] = [];
    const paths: string[] = [];
    const server = createServer((req, res) => {
      let body = ''; req.setEncoding('utf8'); req.on('data', (chunk) => { body += chunk; }); req.on('end', () => {
        paths.push(req.url ?? ''); const payload = JSON.parse(body); payloads.push(payload);
        const snapshot = JSON.parse(payload.messages[0].content);
        res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
        if (String(payload.system).includes('语义比对器')) {
          res.end(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({
            candidateId: snapshot.candidates[0].id, similarity: 0.99,
          }) }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 } }));
          return;
        }
        res.end(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ version: 1, kind: 'propose',
          lesson: 'Keep completion-only review independent of coding execution.',
          evidenceIds: snapshot.evidence.map((item: { evidenceId: string }) => item.evidenceId),
          operations: [{ action: 'create', name: 'independent-review', content }] }) }],
          stop_reason: 'end_turn', usage: { input_tokens: 40, output_tokens: 40 } }));
      });
    });
    servers.push(server); await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('server');
    mkdirSync(join(dir, '.ugs'), { recursive: true }); const configFile = join(dir, '.ugs', 'config.json');
    writeFileSync(configFile, JSON.stringify({ providers: { 'fixture-review': {
      transport: 'cli', baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'foreground/default-model',
    } }, skillLearning: { activityThreshold: 1 } }));
    const configBefore = readFileSync(configFile);
    const { createNodeSkillCandidateStore } = await import('../io/skill-candidate-store');
    await createNodeSkillCandidateStore(dir).save({ version: 1, lastId: 'prior-independent-review', candidates: [{
      id: 'prior-independent-review', lesson: 'Keep completion-only review independent of coding execution.',
      context: 'Earlier verified task.', sources: [JSON.stringify(['prior-session', 'prior-turn'])], consecutive: 1, submitted: false,
    }] });
    const providers = await import('../config/providers');
    const ordinary = vi.spyOn(providers, 'resolveDirectRoute').mockImplementation(() => { throw new Error('FORBIDDEN_REVIEW_GENERAL_GATEWAY'); });
    const cli = vi.spyOn(providers, 'resolveCliRoute').mockImplementation(() => { throw new Error('FORBIDDEN_REVIEW_CLI_ROUTE'); });
    const foregroundSelections: Array<{ adapter: string; modelClass: string; providerId?: string }> = [];
    const calls: string[] = []; const foreground = fakeStudioGateway(calls);
    const gateway: RunGateway = { ...foreground, resolveCliRoute: async (selection) => {
      foregroundSelections.push({ ...selection }); return foreground.resolveCliRoute(selection);
    } };
    const options = { cwd: dir, runId: 'uc-independent-flags', json: true, quiet: true, gateway, maxRetries: '0',
      adapter: 'claude-code', model: 'sonnet', provider: 'foreground-coding', verifyCommand: 'node check.mjs',
      reviewAdapter: 'codex', reviewProvider: 'fixture-review', reviewModel: 'review/exact-model', reviewTransport: 'anthropic' };
    expect(await runStudio('审查博客里的技术论断', options)).toBe(0);
    const result = JSON.parse(outBuf);
    expect(result.skillLearning).toMatchObject({ status: 'reviewed', result: { status: 'awaiting_approval', operationsApplied: 0 } });
    // @ts-expect-error Existing Node filesystem service has no TypeScript declaration.
    const { createWorkspaceSkillService } = await import('../../../backend/src/workspace-skill-service.mjs');
    const reviewOrigin = result.skillLearning.result.origin;
    const service = createWorkspaceSkillService({ dir, hostId: reviewOrigin.hostId, workspaceId: reviewOrigin.workspaceId });
    expect(await service.request({ action: 'approve', origin: reviewOrigin, batchId: result.skillLearning.result.batchId }))
      .toMatchObject({ status: 'applied', operationsApplied: 1 });
    expect(result.verification).toMatchObject({ exitCode: 0, passed: true, stdout: expect.stringContaining('INDEPENDENT REVIEW CHECK PASSED') });
    expect(paths).toEqual(['/v1/messages', '/v1/messages']); expect(payloads).toHaveLength(2);
    for (const payload of payloads) {
      expect(payload).toMatchObject({ model: 'review/exact-model', stream: false });
      expect(Object.keys(payload).sort()).toEqual(['max_tokens', 'messages', 'model', 'stream', 'system']);
    }
    expect(foregroundSelections.length).toBeGreaterThan(0);
    expect(foregroundSelections.every((selection) => selection.adapter === 'claude-code' && selection.modelClass === 'sonnet' && selection.providerId === 'foreground-coding')).toBe(true);
    expect(ordinary).not.toHaveBeenCalled(); expect(cli).not.toHaveBeenCalled();
    expect(readFileSync(configFile)).toEqual(configBefore);
    const file = join(dir, '.ultragamestudio', 'skills', 'independent-review', 'SKILL.md');
    const bytes = readFileSync(file); expect(bytes.toString('utf8')).toBe(content);
    const { createNodeSkillHostPort, createNodeWorkspaceSkillRequest } = await import('../io/skill-host');
    const origin = { ...result.skillLearning.origin, turnId: 'fresh-read-turn', runId: 'fresh-read-run' };
    const host = createNodeSkillHostPort({ origin, request: createNodeWorkspaceSkillRequest({ cwd: dir, hostId: origin.hostId, workspaceId: origin.workspaceId }) });
    const fresh = await host.view({ skillId: (await host.list()).entries[0].skillId });
    expect(fresh).toMatchObject({ content, fullRead: true, hash: createHash('sha256').update(bytes).digest('hex') });
    const evidenceDir = process.env.UGS_REVIEW_ROUTE_EVIDENCE_DIR;
    if (evidenceDir) {
      mkdirSync(evidenceDir, { recursive: true });
      writeFileSync(join(evidenceDir, 'studio-independent-flags.json'), JSON.stringify({ paths, payloads,
        foregroundSelections, verification: result.verification, outcome: result.skillLearning,
        configByteIdentical: readFileSync(configFile).equals(configBefore), freshRead: fresh }, null, 2));
    }
  }, 20000);

  it('automatically reviews actual verify-command evidence over HTTP then delivers the learned rule to a new task', async () => {
    const content = '---\nname: verify-outcomes\ndescription: Use when verifying outcomes.\n---\nRun check.mjs and read CHECK PASSED before reporting success.\n';
    writeFileSync(join(dir, 'check.mjs'), "console.log('CHECK PASSED');\n");
    const snapshots: Array<{ evidence: Array<Record<string, unknown>> }> = [];
    const server = createServer((req, res) => {
      let body = ''; req.setEncoding('utf8'); req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const payload = JSON.parse(body); const snapshot = JSON.parse(payload.messages[1].content);
        res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
        if (payload.messages[0].content.includes('语义比对器')) {
          res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
            candidateId: snapshot.candidates[0].id, similarity: 0.99,
          }) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
          return;
        }
        snapshots.push(snapshot);
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ version: 1, kind: 'propose',
          lesson: 'Read an actual successful host check before reporting success.',
          evidenceIds: snapshot.evidence.map((item: { evidenceId: string }) => item.evidenceId),
          operations: [{ action: 'create', name: 'verify-outcomes', content }] }) } }],
          usage: { prompt_tokens: 40, completion_tokens: 40 } }));
      });
    });
    servers.push(server); await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('server');
    const route: ResolvedRoute = { selection: { adapter: 'custom', modelClass: 'review' }, adapter: 'custom', modelClass: 'review',
      mode: 'direct', transport: 'openai-compatible', model: 'review-only', baseUrl: `http://127.0.0.1:${address.port}` };
    const { createNodeSkillCandidateStore } = await import('../io/skill-candidate-store');
    await createNodeSkillCandidateStore(dir).save({ version: 1, lastId: 'prior-verified-outcomes', candidates: [{
      id: 'prior-verified-outcomes', lesson: 'Read an actual successful host check before reporting success.',
      context: 'Earlier verified task.', sources: [JSON.stringify(['prior-session', 'prior-turn'])], consecutive: 1, submitted: false,
    }] });
    expect(await runStudio('审查博客里的技术论断', { cwd: dir, runId: 'uc-auto-skill-http', json: true, quiet: true,
      gateway: fakeStudioGateway([]), maxRetries: '0', verifyCommand: 'node check.mjs',
      skillWorkflow: { route, config: { activityThreshold: 1 } } })).toBe(0);
    const first = JSON.parse(outBuf);
    expect(first.verification).toMatchObject({ exitCode: 0, passed: true, stdout: expect.stringContaining('CHECK PASSED') });
    expect(first.skillLearning).toMatchObject({ status: 'reviewed', result: { status: 'awaiting_approval', operationsApplied: 0 } });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].evidence).toMatchObject([{ provenance: 'host-check', kind: 'verification', exitCode: 0, status: 'success' }]);
    expect(snapshots[0].evidence).toHaveLength(1);
    const file = join(dir, '.ultragamestudio', 'skills', 'verify-outcomes', 'SKILL.md');
    expect(existsSync(file)).toBe(false);
    // @ts-expect-error Existing Node filesystem service has no TypeScript declaration.
    const { createWorkspaceSkillService } = await import('../../../backend/src/workspace-skill-service.mjs');
    const reviewOrigin = first.skillLearning.result.origin;
    const service = createWorkspaceSkillService({ dir, hostId: reviewOrigin.hostId, workspaceId: reviewOrigin.workspaceId });
    expect(await service.request({ action: 'approve', origin: reviewOrigin, batchId: first.skillLearning.result.batchId }))
      .toMatchObject({ status: 'applied', operationsApplied: 1 });
    expect(readFileSync(file, 'utf8')).toBe(content);
    outBuf = ''; const calls: string[] = [];
    expect(await runStudio('/verify-outcomes 审查博客里的技术论断', { cwd: dir, runId: 'uc-reuse-learned-skill', json: true, quiet: true,
      gateway: fakeStudioGateway(calls), maxRetries: '0', verifyCommand: 'node check.mjs' })).toBe(0);
    const second = JSON.parse(outBuf);
    expect(second.loadedSkills).toHaveLength(1);
    expect(calls[0]).toContain('Run check.mjs and read CHECK PASSED');
    expect(calls[calls.length - 1]).toContain('Run check.mjs and read CHECK PASSED');
    expect(second.verification).toMatchObject({ exitCode: 0, passed: true });
  // Two real filesystem/verify-command runs and HTTP review exceed Vitest's
  // default 5s under suite contention; match the adjacent HTTP integration.
  }, 20000);

  it('delivers the full Node managed skill to planner and execution and reports unsafe CLI review unavailable', async () => {
    const packageDir = join(dir, '.ultragamestudio', 'skills', 'verify-work');
    mkdirSync(packageDir, { recursive: true });
    const content = '---\nname: verify-work\ndescription: Use when verifying work.\n---\nSTUDIO FULL RULE: validate actual results before reporting.\n';
    writeFileSync(join(packageDir, 'SKILL.md'), content);
    const calls: string[] = [];
    const code = await runStudio('/verify-work 审查博客里的技术论断', { cwd: dir, runId: 'uc-skills', json: true, quiet: true,
      gateway: fakeStudioGateway(calls), concurrency: '3', maxRetries: '0' });
    expect(code).toBe(0);
    expect(calls[0]).toContain('STUDIO FULL RULE');
    expect(calls[calls.length - 1]).toContain('STUDIO FULL RULE');
    const result = JSON.parse(outBuf);
    expect(result.skillLearning).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('SKILL_REVIEW_UNAVAILABLE') });
    expect(result.loadedSkills).toHaveLength(1);
    expect(readFileSync(join(packageDir, 'SKILL.md'), 'utf8')).toBe(content);
    expect(JSON.parse(readFileSync(join(dir, '.ugs-run', 'uc-skills', 'skill-review.json'), 'utf8'))).toMatchObject({ status: 'unavailable' });
  });

  it('passes the foreground tool host to the ordinary Node Studio gateway while leaving reviewer capsules unavailable', async () => {
    const source = await import('../runtime-host');
    const fake = fakeStudioGateway([]);
    const build = vi.spyOn(source, 'buildNodeGateway').mockImplementation((options) => {
      expect(options?.skillTools?.origin.runId).toBe(options?.runId);
      expect(options?.skillTools?.request).toBeTypeOf('function');
      expect(options?.skillTools?.evidence).toBeTypeOf('function');
      return fake;
    });
    try {
      expect(await runStudio('审查博客里的技术论断', { cwd: dir, runId: 'uc-active-tools', json: true, quiet: true, maxRetries: '0' })).toBe(0);
      expect(build).toHaveBeenCalled();
      expect(JSON.parse(outBuf).skillLearning).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('SKILL_REVIEW_UNAVAILABLE') });
    } finally { build.mockRestore(); }
  });

  it('plans, executes, validates, and persists a dynamic harness run', async () => {
    const calls: string[] = [];
    const gateway = fakeStudioGateway(calls);
    const code = await runStudio('审查博客里的技术论断', {
      cwd: dir,
      runId: 'uc-test',
      json: true,
      quiet: true,
      gateway,
      concurrency: '3',
      maxRetries: '0',
    });

    expect(code).toBe(0);
    const result = JSON.parse(outBuf);
    const runDir = join(dir, '.ugs-run', 'uc-test');
    expect(result.success).toBe(true);
    expect(result.artifacts.verdict.pass).toBe(true);
    expect(result.artifacts.ledger.tasks[0].id).toBe('t1');
    expect(result.outputs.n_ledger).toBeTruthy();
    expect(result.nodeResults.n_ledger.status).toBe('success');
    expect(result.evidence.some((item: { id: string }) => item.id === 'run-result')).toBe(true);
    expect(result.evidence.some((item: { id: string }) => item.id === 'acceptance-verdict')).toBe(true);
    expect(existsSync(join(runDir, 'request.json'))).toBe(true);
    expect(existsSync(join(runDir, 'harness.json'))).toBe(true);
    expect(existsSync(join(runDir, 'workflow.ugs.json'))).toBe(true);
    expect(existsSync(join(runDir, 'events.jsonl'))).toBe(true);
    expect(existsSync(join(runDir, 'status.json'))).toBe(true);
    expect(existsSync(join(runDir, 'result.json'))).toBe(true);
    const workflow = JSON.parse(readFileSync(join(runDir, 'workflow.ugs.json'), 'utf8'));
    expect(workflow.nodes.some((node: { id: string; type: string }) => node.id.includes('claims') && node.type === 'agent')).toBe(true);
    expect(workflow.nodes.some((node: { id: string; type: string }) => node.id.includes('verify') && node.type === 'parallel')).toBe(true);
    const events = readFileSync(join(runDir, 'events.jsonl'), 'utf8');
    expect(events).toContain('node_success');
    expect(events).not.toContain('stream_append');
    expect(calls.length).toBeGreaterThanOrEqual(6);
  });

  it('soft-stops on budget exhaustion and still writes a partial result', async () => {
    const calls: string[] = [];
    const gateway = fakeStudioGateway(calls, { maxAgentCalls: 4, maxRounds: 2 });
    const code = await runStudio('修复复杂失败并循环验收', {
      cwd: dir,
      runId: 'uc-budget',
      json: true,
      quiet: true,
      gateway,
      concurrency: '3',
      maxRetries: '0',
      // Pin a deliberately tiny budget via the CLI override: an explicit user
      // ceiling that reconcileBudget must honor as a hard cap (lowering rounds,
      // not raising calls), so the soft-stop path is still exercised.
      maxAgentCalls: '4',
    });

    expect(code).toBe(1);
    const result = JSON.parse(outBuf);
    const runDir = join(dir, '.ugs-run', 'uc-budget');
    expect(result.success).toBe(false);
    expect(result.budget.exhausted).toBe(true);
    expect(result.budget.spentAgentCalls).toBe(4);
    expect(result.artifacts.verdict.pass).toBe(false);
    expect(result.artifacts.verdict.gaps[0].reason).toContain('STUDIO_BUDGET_EXHAUSTED');
    expect(result.artifacts.report).toContain('预算已耗尽');
    expect(result.failedNodeId).toBeTruthy();
    expect(result.outputs.n_gate).toBeUndefined();
    expect(existsSync(join(runDir, 'result.json'))).toBe(true);
    expect(readFileSync(join(runDir, 'events.jsonl'), 'utf8')).toContain('budget_exhausted');
  });

  it('resumes from persisted studio outputs without replanning completed work', async () => {
    const firstCalls: string[] = [];
    const firstGateway = fakeStudioGateway(firstCalls, { maxAgentCalls: 6, maxRounds: 2 });
    const firstCode = await runStudio('修复复杂失败并循环验收', {
      cwd: dir,
      runId: 'uc-resume',
      json: true,
      quiet: true,
      gateway: firstGateway,
      concurrency: '3',
      maxRetries: '0',
    });
    expect(firstCode).toBe(1);
    outBuf = '';

    const resumeCalls: string[] = [];
    const resumeGateway = fakeStudioGateway(resumeCalls, { maxAgentCalls: 20, maxRounds: 2 });
    const resumeCode = await runStudio('修复复杂失败并循环验收', {
      cwd: dir,
      runId: 'uc-resume',
      resume: true,
      json: true,
      quiet: true,
      gateway: resumeGateway,
      concurrency: '3',
      maxRetries: '0',
      maxAgentCalls: '20',
    });

    const result = JSON.parse(outBuf);
    expect(resumeCode).toBe(0);
    expect(result.success).toBe(true);
    expect(result.outputs.n_ledger).toBeTruthy();
    expect(resumeCalls.some((prompt) => prompt.includes('DYNAMIC_HARNESS'))).toBe(false);
    expect(resumeCalls.some((prompt) => prompt.includes('DYNAMIC_TASK_LEDGER'))).toBe(false);
  });

  it('persists stream events only when trace is enabled', async () => {
    const calls: string[] = [];
    const gateway = fakeStudioGateway(calls);
    const code = await runStudio('审查博客里的技术论断', {
      cwd: dir,
      runId: 'uc-trace',
      json: true,
      quiet: true,
      trace: true,
      gateway,
      concurrency: '3',
      maxRetries: '0',
    });

    expect(code).toBe(0);
    const events = readFileSync(join(dir, '.ugs-run', 'uc-trace', 'events.jsonl'), 'utf8');
    expect(events).toContain('stream_append');
  });

  it('skips repair rounds once an earlier acceptance gate passes', async () => {
    const calls: string[] = [];
    const gateway = fakeStudioGateway(calls, { maxAgentCalls: 20, maxRounds: 2 });
    const code = await runStudio('修复复杂失败并循环验收', {
      cwd: dir,
      runId: 'uc-skip-repair',
      json: true,
      quiet: true,
      gateway,
      concurrency: '3',
      maxRetries: '0',
    });

    expect(code).toBe(0);
    const repairCalls = calls.filter((prompt) => prompt.includes('返工轮次') || prompt.includes('第 2 轮返工'));
    expect(repairCalls).toHaveLength(0);
    const workflow = JSON.parse(readFileSync(join(dir, '.ugs-run', 'uc-skip-repair', 'workflow.ugs.json'), 'utf8'));
    expect(workflow.nodes.some((node: { id: string }) => node.id.includes('n_dyn_r2'))).toBe(true);
  });

  it('records a planner_fallback event when planning yields no parseable spec', async () => {
    const calls: string[] = [];
    // A gateway whose planner output is NOT valid JSON ⇒ fallback spec.
    const gateway = fakeStudioGateway(calls, { maxAgentCalls: 20, maxRounds: 2 });
    const badPlanner: RunGateway = {
      ...gateway,
      spawnCliAgent: async (prompt, adapter, opts) => {
        if (prompt.includes('DYNAMIC_HARNESS')) {
          opts.onProgress?.('chunk');
          return '抱歉，我无法生成规格，这只是一段普通说明文字。';
        }
        return gateway.spawnCliAgent(prompt, adapter, opts);
      },
    };
    const code = await runStudio('审查博客里的技术论断', {
      cwd: dir,
      runId: 'uc-fallback',
      json: true,
      quiet: true,
      gateway: badPlanner,
      concurrency: '3',
      maxRetries: '0',
    });

    // Fallback may or may not pass acceptance (it runs an inferred spec); the
    // point of this test is that the degraded planning is surfaced, not silent.
    expect([0, 1]).toContain(code);
    const events = readFileSync(join(dir, '.ugs-run', 'uc-fallback', 'events.jsonl'), 'utf8');
    expect(events).toContain('planner_fallback');
  });

  it('reuses a saved harness.json with --from-harness and skips planning', async () => {
    // 1) plannerOnly run to produce harness.json.
    const planCalls: string[] = [];
    const planGateway = fakeStudioGateway(planCalls, { maxAgentCalls: 20, maxRounds: 2 });
    await runStudio('审查博客里的技术论断', {
      cwd: dir,
      runId: 'uc-plan',
      json: true,
      quiet: true,
      gateway: planGateway,
      plannerOnly: true,
    });
    const harnessPath = join(dir, '.ugs-run', 'uc-plan', 'harness.json');
    expect(existsSync(harnessPath)).toBe(true);
    outBuf = '';

    // 2) reuse it — the planner must not be invoked.
    const reuseCalls: string[] = [];
    const reuseGateway = fakeStudioGateway(reuseCalls, { maxAgentCalls: 20, maxRounds: 2 });
    const code = await runStudio('审查博客里的技术论断', {
      cwd: dir,
      runId: 'uc-reuse',
      json: true,
      quiet: true,
      gateway: reuseGateway,
      fromHarness: harnessPath,
      concurrency: '3',
      maxRetries: '0',
    });

    expect(code).toBe(0);
    expect(reuseCalls.some((p) => p.includes('DYNAMIC_HARNESS'))).toBe(false);
    const reuseEvents = readFileSync(join(dir, '.ugs-run', 'uc-reuse', 'events.jsonl'), 'utf8');
    expect(reuseEvents).toContain('planner_skipped');
  });

  it('runs a graceful closing pass from the reserve when work budget exhausts', async () => {
    const calls: string[] = [];
    // maxAgentCalls 5 ⇒ closing reserve 2, work ceiling 3: work exhausts mid-run
    // and the gate/report run from the reserved pool instead of hard-aborting.
    const gateway = fakeStudioGateway(calls, { maxAgentCalls: 5, maxRounds: 1 });
    const code = await runStudio('审查博客里的技术论断', {
      cwd: dir,
      runId: 'uc-closing',
      json: true,
      quiet: true,
      gateway,
      concurrency: '1',
      maxRetries: '0',
      // Explicit user ceiling of 5 — honored as a hard cap so the reserve /
      // closing-pass split (work ceiling 3, reserve 2) is exercised as intended.
      maxAgentCalls: '5',
    });

    expect([0, 1]).toContain(code);
    const events = readFileSync(join(dir, '.ugs-run', 'uc-closing', 'events.jsonl'), 'utf8');
    expect(events).toContain('work_budget_exhausted');
    expect(events).toContain('closing_pass');
    // The budget was NOT fully exhausted (reserve absorbed the closing pass).
    const result = JSON.parse(outBuf);
    expect(result.budget.maxAgentCalls).toBe(5);
  });

  it('runs verify-command and fails the run when the command exits nonzero', async () => {
    const calls: string[] = [];
    const gateway = fakeStudioGateway(calls);
    const code = await runStudio('审查博客里的技术论断', {
      cwd: dir,
      runId: 'uc-verify-fail',
      json: true,
      quiet: true,
      gateway,
      concurrency: '3',
      maxRetries: '0',
      verifyCommand: 'node -e "process.exit(7)"',
    });

    const result = JSON.parse(outBuf);
    const runDir = join(dir, '.ugs-run', 'uc-verify-fail');
    expect(code).toBe(1);
    expect(result.success).toBe(false);
    expect(result.verification.command).toBe('node -e "process.exit(7)"');
    expect(result.verification.exitCode).toBe(7);
    expect(
      result.nextSteps.some(
        (step: { id: string; command?: string }) =>
          step.id === 'rerun-verify-command' &&
          step.command?.includes('--verify-command'),
      ),
    ).toBe(true);
    expect(
      result.evidence.some(
        (item: { id: string; kind: string; status: string }) =>
          item.id === 'verify-command' && item.kind === 'command' && item.status === 'fail',
      ),
    ).toBe(true);
    expect(result.artifacts.verdict.pass).toBe(false);
    expect(result.artifacts.verdict.gaps.some((gap: { taskId: string }) => gap.taskId === 'verification')).toBe(true);
    expect(existsSync(join(runDir, 'verification.json'))).toBe(true);
    expect(readFileSync(join(runDir, 'events.jsonl'), 'utf8')).toContain('verification_complete');

    // Phase-2 observability: the model's gate said pass, but ground truth failed
    // ⇒ a false-accept must be detected (the pre-verification verdict is captured
    // in verdictSignals, not erased by the verification fold).
    expect(result.verdictSignals.modelVerdictPass).toBe(true);
    expect(result.verdictSignals.groundTruthPass).toBe(false);
    const summary = JSON.parse(readFileSync(join(runDir, 'run-summary.json'), 'utf8'));
    expect(summary.gate.classification).toBe('false-accept');
    expect(summary.outcome).toBe('fail');
  });

  it('runs read-only objective checks and folds a failing one into ground truth', async () => {
    const calls: string[] = [];
    const base = fakeStudioGateway(calls);
    // Planner emits a file-exists check pointing at a path that does NOT exist
    // in the run cwd → objective ground truth fails even though the model gate
    // self-reports pass.
    const gateway: RunGateway = {
      ...base,
      spawnCliAgent: async (prompt, adapter, opts) => {
        if (prompt.includes('DYNAMIC_HARNESS') && !prompt.includes('DYNAMIC_PLAN_CRITIQUE')) {
          opts.onProgress?.('chunk');
          return JSON.stringify({
            objective: '审查博客里的技术论断',
            nonGoals: [],
            successCriteria: ['产物文件存在'],
            budget: { maxAgentCalls: 20, maxRounds: 1 },
            strategies: ['fan-out-and-synthesize', 'adversarial-verification'],
            workerGroups: [
              { id: 't1', title: 'A', focus: 'a', deliverable: 'd', acceptance: 'x', evidenceRequired: 'e' },
              { id: 't2', title: 'B', focus: 'b', deliverable: 'd', acceptance: 'x', evidenceRequired: 'e' },
            ],
            acceptanceRubric: ['证据充分'],
            objectiveChecks: [{ kind: 'file-exists', path: 'definitely-missing-artifact.md' }],
            stopCondition: '验收门通过',
          });
        }
        return base.spawnCliAgent(prompt, adapter, opts);
      },
    };
    const code = await runStudio('审查博客里的技术论断', {
      cwd: dir,
      runId: 'uc-objchecks',
      json: true,
      quiet: true,
      gateway,
      concurrency: '3',
      maxRetries: '0',
    });

    const result = JSON.parse(outBuf);
    const runDir = join(dir, '.ugs-run', 'uc-objchecks');
    expect(code).toBe(1);
    expect(existsSync(join(runDir, 'objective-checks.json'))).toBe(true);
    // Model gate self-reported pass, but the objective check failed → false-accept.
    expect(result.verdictSignals.modelVerdictPass).toBe(true);
    expect(result.verdictSignals.groundTruthPass).toBe(false);
    expect(result.success).toBe(false);
    expect(
      result.nextSteps.some(
        (step: { id: string; command?: string }) =>
          step.id === 'rerun-objective-checks' &&
          step.command?.includes('--resume'),
      ),
    ).toBe(true);
    expect(
      result.evidence.some(
        (item: { id: string; kind: string; status: string }) =>
          item.id === 'objective-checks' && item.kind === 'check' && item.status === 'fail',
      ),
    ).toBe(true);
    const events = readFileSync(join(runDir, 'events.jsonl'), 'utf8');
    expect(events).toContain('objective_checks_complete');
    const summary = JSON.parse(readFileSync(join(runDir, 'run-summary.json'), 'utf8'));
    expect(summary.gate.classification).toBe('false-accept');
  });

  it('skips planner-proposed command checks unless --auto-verify is set', async () => {
    const calls: string[] = [];
    const base = fakeStudioGateway(calls);
    const gateway: RunGateway = {
      ...base,
      spawnCliAgent: async (prompt, adapter, opts) => {
        if (prompt.includes('DYNAMIC_HARNESS') && !prompt.includes('DYNAMIC_PLAN_CRITIQUE')) {
          opts.onProgress?.('chunk');
          return JSON.stringify({
            objective: '审查博客里的技术论断',
            nonGoals: [],
            successCriteria: ['命令通过'],
            budget: { maxAgentCalls: 20, maxRounds: 1 },
            strategies: ['fan-out-and-synthesize', 'adversarial-verification'],
            workerGroups: [
              { id: 't1', title: 'A', focus: 'a', deliverable: 'd', acceptance: 'x', evidenceRequired: 'e' },
              { id: 't2', title: 'B', focus: 'b', deliverable: 'd', acceptance: 'x', evidenceRequired: 'e' },
            ],
            acceptanceRubric: ['证据充分'],
            objectiveChecks: [{ kind: 'command', command: 'node -e "process.exit(5)"' }],
            stopCondition: '验收门通过',
          });
        }
        return base.spawnCliAgent(prompt, adapter, opts);
      },
    };
    const code = await runStudio('审查博客里的技术论断', {
      cwd: dir,
      runId: 'uc-cmd-skip',
      json: true,
      quiet: true,
      gateway,
      concurrency: '3',
      maxRetries: '0',
    });

    const result = JSON.parse(outBuf);
    const runDir = join(dir, '.ugs-run', 'uc-cmd-skip');
    // Command check was skipped (no --auto-verify) → no objective signal → run
    // succeeds on the model gate alone.
    expect(code).toBe(0);
    expect(result.success).toBe(true);
    const report = JSON.parse(readFileSync(join(runDir, 'objective-checks.json'), 'utf8'));
    expect(report.results[0].status).toBe('skipped');
    expect(report.skippedCount).toBe(1);
    expect(report.hasSkippedCommands).toBe(true);
    expect(report.passed).toBeNull();
  });

  it('does not let weak objective checks override a model rejection', async () => {
    const calls: string[] = [];
    const base = fakeStudioGateway(calls);
    const gateway: RunGateway = {
      ...base,
      spawnCliAgent: async (prompt, adapter, opts) => {
        if (prompt.includes('DYNAMIC_HARNESS') && !prompt.includes('DYNAMIC_PLAN_CRITIQUE')) {
          opts.onProgress?.('chunk');
          return JSON.stringify({
            objective: '审查博客里的技术论断',
            nonGoals: [],
            successCriteria: ['产物文件存在', '命令通过'],
            budget: { maxAgentCalls: 20, maxRounds: 1 },
            strategies: ['fan-out-and-synthesize', 'adversarial-verification'],
            workerGroups: [
              { id: 't1', title: 'A', focus: 'a', deliverable: 'd', acceptance: 'x', evidenceRequired: 'e' },
              { id: 't2', title: 'B', focus: 'b', deliverable: 'd', acceptance: 'x', evidenceRequired: 'e' },
            ],
            acceptanceRubric: ['证据充分'],
            objectiveChecks: [
              { kind: 'file-exists', path: '.ugs-run/uc-weak-truth/request.json' },
              { kind: 'command', command: 'node -e "process.exit(0)"' },
            ],
            stopCondition: '验收门通过',
          });
        }
        if (prompt.includes('DYNAMIC_VERDICT')) {
          opts.onProgress?.('chunk');
          return JSON.stringify({
            pass: false,
            acceptedArtifact: '',
            evidence: [],
            criteriaCoverage: [{ criterion: '命令通过', met: false, evidence: '命令未执行' }],
            gaps: [
              {
                taskId: 'verification',
                severity: 'P1',
                reason: '命令验收未执行',
                nextAction: '使用 --auto-verify 续跑。',
              },
            ],
          });
        }
        return base.spawnCliAgent(prompt, adapter, opts);
      },
    };
    const code = await runStudio('审查博客里的技术论断', {
      cwd: dir,
      runId: 'uc-weak-truth',
      json: true,
      quiet: true,
      gateway,
      concurrency: '3',
      maxRetries: '0',
    });

    const result = JSON.parse(outBuf);
    const runDir = join(dir, '.ugs-run', 'uc-weak-truth');
    expect(code).toBe(1);
    expect(result.success).toBe(false);
    expect(result.verdictSignals.modelVerdictPass).toBe(false);
    expect(result.verdictSignals.groundTruthPass).toBeNull();
    const report = JSON.parse(readFileSync(join(runDir, 'objective-checks.json'), 'utf8'));
    expect(report.passed).toBe(true);
    expect(report.hasSkippedCommands).toBe(true);
    const summary = JSON.parse(readFileSync(join(runDir, 'run-summary.json'), 'utf8'));
    expect(summary.outcome).toBe('fail');
    expect(summary.gate.classification).toBe('unverified');
  });
});

function fakeStudioGateway(
  calls: string[],
  plannerBudget: { maxAgentCalls: number; maxRounds: number } = { maxAgentCalls: 20, maxRounds: 2 },
): RunGateway {
  const respond = async (
    prompt: string,
    _adapter: string,
    opts: SpawnCliAgentOpts,
  ): Promise<string> => {
    calls.push(prompt);
    opts.onProgress?.('chunk');
    if (prompt.includes('DYNAMIC_HARNESS')) {
      return JSON.stringify({
        objective: '审查博客里的技术论断',
        nonGoals: ['不要改写博客风格'],
        successCriteria: ['每条技术论断都有证据'],
        budget: plannerBudget,
        strategies:
          plannerBudget.maxRounds > 1
            ? ['loop-until-done', 'adversarial-verification']
            : ['fan-out-and-synthesize', 'adversarial-verification'],
        plan: [
          {
            id: 'claims',
            kind: 'agent',
            title: '识别论断',
            focus: '找出需要核验的技术论断',
            deliverable: '论断清单',
            acceptance: '至少列出一条论断',
            evidenceRequired: '原文片段',
          },
          {
            id: 'verify',
            kind: 'parallel',
            title: '并行核验',
            dependsOn: ['claims'],
            branches: [
              {
                title: '代码核验',
                focus: '对照代码库核验论断',
                deliverable: '核验结果',
                acceptance: '每条结论都有文件路径或原因',
                evidenceRequired: '文件路径',
              },
              {
                title: '反面检查',
                focus: '寻找证据不足和过度声称',
                deliverable: '风险清单',
                acceptance: '风险有原因',
                evidenceRequired: '复核记录',
              },
            ],
          },
        ],
        workerGroups: [
          {
            id: 't1',
            title: '识别论断',
            focus: '找出需要核验的技术论断',
            deliverable: '论断清单',
            acceptance: '至少列出一条论断',
            evidenceRequired: '原文片段',
          },
          {
            id: 't2',
            title: '代码核验',
            focus: '对照代码库核验论断',
            deliverable: '核验结果',
            acceptance: '每条结论都有文件路径或原因',
            evidenceRequired: '文件路径',
          },
        ],
        acceptanceRubric: ['证据充分', '没有过度声称'],
        stopCondition: '验收门通过',
      });
    }
    if (prompt.includes('DYNAMIC_TASK_LEDGER')) {
      return JSON.stringify({
        tasks: [
          {
            id: 't1',
            title: '识别论断',
            owner: 'worker',
            input: '博客草稿',
            deliverable: '论断清单',
            acceptance: '至少列出一条论断',
            evidenceRequired: '原文片段',
            status: 'accepted',
            artifact: 'claims.md',
            gaps: [],
          },
        ],
      });
    }
    if (prompt.includes('DYNAMIC_WORKER_RESULT')) {
      return JSON.stringify({
        taskId: prompt.includes('t2') ? 't2' : 't1',
        status: 'done',
        artifact: '核验结果',
        evidence: ['app/src/core/ir.ts'],
        gaps: [],
      });
    }
    if (prompt.includes('DYNAMIC_VERDICT')) {
      return JSON.stringify({
        pass: true,
        acceptedArtifact: '技术论断已核验',
        evidence: ['app/src/core/ir.ts'],
        gaps: [],
      });
    }
    return '最终结论：通过\n已验收内容与证据：app/src/core/ir.ts\n未解决 gaps：无';
  };

  return {
    resolveDirectRoute: () => null,
    resolveCliRoute: async () => ({ adapter: 'claude-code', cliCommand: 'fake' }),
    completeText: async () => {
      throw new Error('direct path not used');
    },
    spawnCliAgent: respond,
    applyOverride: (selection, override) =>
      override
        ? { ...selection, modelClass: override.modelClass ?? selection.modelClass }
        : { ...selection },
    nodeGatewayOverride: () => undefined,
    modelClassFromModelId: () => 'sonnet',
    recordCall: () => {},
    timeoutPolicy: () => ({ timeoutSeconds: 1800, idleTimeoutSeconds: 300 }),
    effectiveConcurrency: (configured) => Math.max(1, configured),
    effectiveConsensusSamples: (configured) => configured,
  };
}
