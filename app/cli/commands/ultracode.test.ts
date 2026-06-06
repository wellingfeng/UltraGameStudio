import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunGateway, SpawnCliAgentOpts } from '../../src/runtime';
import { runUltracode } from './ultracode';

let outBuf = '';
let errBuf = '';
let outSpy: { mockRestore: () => void };
let errSpy: { mockRestore: () => void };
let dir: string;

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
  dir = mkdtempSync(join(tmpdir(), 'fuc-ultracode-'));
});

afterEach(() => {
  outSpy.mockRestore();
  errSpy.mockRestore();
  rmSync(dir, { recursive: true, force: true });
});

describe('fuc ultracode', () => {
  it('plans, executes, validates, and persists a dynamic harness run', async () => {
    const calls: string[] = [];
    const gateway = fakeUltracodeGateway(calls);
    const code = await runUltracode('审查博客里的技术论断', {
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
    const runDir = join(dir, '.fuc-run', 'uc-test');
    expect(result.success).toBe(true);
    expect(result.artifacts.verdict.pass).toBe(true);
    expect(result.artifacts.ledger.tasks[0].id).toBe('t1');
    expect(result.outputs.n_ledger).toBeTruthy();
    expect(result.nodeResults.n_ledger.status).toBe('success');
    expect(existsSync(join(runDir, 'request.json'))).toBe(true);
    expect(existsSync(join(runDir, 'harness.json'))).toBe(true);
    expect(existsSync(join(runDir, 'workflow.fuc.json'))).toBe(true);
    expect(existsSync(join(runDir, 'events.jsonl'))).toBe(true);
    expect(existsSync(join(runDir, 'status.json'))).toBe(true);
    expect(existsSync(join(runDir, 'result.json'))).toBe(true);
    const workflow = JSON.parse(readFileSync(join(runDir, 'workflow.fuc.json'), 'utf8'));
    expect(workflow.nodes.some((node: { id: string; type: string }) => node.id.includes('claims') && node.type === 'agent')).toBe(true);
    expect(workflow.nodes.some((node: { id: string; type: string }) => node.id.includes('verify') && node.type === 'parallel')).toBe(true);
    const events = readFileSync(join(runDir, 'events.jsonl'), 'utf8');
    expect(events).toContain('node_success');
    expect(events).not.toContain('stream_append');
    expect(calls.length).toBeGreaterThanOrEqual(6);
  });

  it('soft-stops on budget exhaustion and still writes a partial result', async () => {
    const calls: string[] = [];
    const gateway = fakeUltracodeGateway(calls, { maxAgentCalls: 4, maxRounds: 2 });
    const code = await runUltracode('修复复杂失败并循环验收', {
      cwd: dir,
      runId: 'uc-budget',
      json: true,
      quiet: true,
      gateway,
      concurrency: '3',
      maxRetries: '0',
    });

    expect(code).toBe(1);
    const result = JSON.parse(outBuf);
    const runDir = join(dir, '.fuc-run', 'uc-budget');
    expect(result.success).toBe(false);
    expect(result.budget.exhausted).toBe(true);
    expect(result.budget.spentAgentCalls).toBe(4);
    expect(result.artifacts.verdict.pass).toBe(false);
    expect(result.artifacts.verdict.gaps[0].reason).toContain('ULTRACODE_BUDGET_EXHAUSTED');
    expect(result.artifacts.report).toContain('预算已耗尽');
    expect(result.failedNodeId).toBeTruthy();
    expect(result.outputs.n_gate).toBeUndefined();
    expect(existsSync(join(runDir, 'result.json'))).toBe(true);
    expect(readFileSync(join(runDir, 'events.jsonl'), 'utf8')).toContain('budget_exhausted');
  });

  it('resumes from persisted ultracode outputs without replanning completed work', async () => {
    const firstCalls: string[] = [];
    const firstGateway = fakeUltracodeGateway(firstCalls, { maxAgentCalls: 6, maxRounds: 2 });
    const firstCode = await runUltracode('修复复杂失败并循环验收', {
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
    const resumeGateway = fakeUltracodeGateway(resumeCalls, { maxAgentCalls: 20, maxRounds: 2 });
    const resumeCode = await runUltracode('修复复杂失败并循环验收', {
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
    const gateway = fakeUltracodeGateway(calls);
    const code = await runUltracode('审查博客里的技术论断', {
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
    const events = readFileSync(join(dir, '.fuc-run', 'uc-trace', 'events.jsonl'), 'utf8');
    expect(events).toContain('stream_append');
  });

  it('skips repair rounds once an earlier acceptance gate passes', async () => {
    const calls: string[] = [];
    const gateway = fakeUltracodeGateway(calls, { maxAgentCalls: 20, maxRounds: 2 });
    const code = await runUltracode('修复复杂失败并循环验收', {
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
    const workflow = JSON.parse(readFileSync(join(dir, '.fuc-run', 'uc-skip-repair', 'workflow.fuc.json'), 'utf8'));
    expect(workflow.nodes.some((node: { id: string }) => node.id.includes('n_dyn_r2'))).toBe(true);
  });

  it('records a planner_fallback event when planning yields no parseable spec', async () => {
    const calls: string[] = [];
    // A gateway whose planner output is NOT valid JSON ⇒ fallback spec.
    const gateway = fakeUltracodeGateway(calls, { maxAgentCalls: 20, maxRounds: 2 });
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
    const code = await runUltracode('审查博客里的技术论断', {
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
    const events = readFileSync(join(dir, '.fuc-run', 'uc-fallback', 'events.jsonl'), 'utf8');
    expect(events).toContain('planner_fallback');
  });

  it('reuses a saved harness.json with --from-harness and skips planning', async () => {
    // 1) plannerOnly run to produce harness.json.
    const planCalls: string[] = [];
    const planGateway = fakeUltracodeGateway(planCalls, { maxAgentCalls: 20, maxRounds: 2 });
    await runUltracode('审查博客里的技术论断', {
      cwd: dir,
      runId: 'uc-plan',
      json: true,
      quiet: true,
      gateway: planGateway,
      plannerOnly: true,
    });
    const harnessPath = join(dir, '.fuc-run', 'uc-plan', 'harness.json');
    expect(existsSync(harnessPath)).toBe(true);
    outBuf = '';

    // 2) reuse it — the planner must not be invoked.
    const reuseCalls: string[] = [];
    const reuseGateway = fakeUltracodeGateway(reuseCalls, { maxAgentCalls: 20, maxRounds: 2 });
    const code = await runUltracode('审查博客里的技术论断', {
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
    const reuseEvents = readFileSync(join(dir, '.fuc-run', 'uc-reuse', 'events.jsonl'), 'utf8');
    expect(reuseEvents).toContain('planner_skipped');
  });

  it('runs a graceful closing pass from the reserve when work budget exhausts', async () => {
    const calls: string[] = [];
    // maxAgentCalls 5 ⇒ closing reserve 2, work ceiling 3: work exhausts mid-run
    // and the gate/report run from the reserved pool instead of hard-aborting.
    const gateway = fakeUltracodeGateway(calls, { maxAgentCalls: 5, maxRounds: 1 });
    const code = await runUltracode('审查博客里的技术论断', {
      cwd: dir,
      runId: 'uc-closing',
      json: true,
      quiet: true,
      gateway,
      concurrency: '1',
      maxRetries: '0',
    });

    expect([0, 1]).toContain(code);
    const events = readFileSync(join(dir, '.fuc-run', 'uc-closing', 'events.jsonl'), 'utf8');
    expect(events).toContain('work_budget_exhausted');
    expect(events).toContain('closing_pass');
    // The budget was NOT fully exhausted (reserve absorbed the closing pass).
    const result = JSON.parse(outBuf);
    expect(result.budget.maxAgentCalls).toBe(5);
  });

  it('runs verify-command and fails the run when the command exits nonzero', async () => {
    const calls: string[] = [];
    const gateway = fakeUltracodeGateway(calls);
    const code = await runUltracode('审查博客里的技术论断', {
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
    const runDir = join(dir, '.fuc-run', 'uc-verify-fail');
    expect(code).toBe(1);
    expect(result.success).toBe(false);
    expect(result.verification.command).toBe('node -e "process.exit(7)"');
    expect(result.verification.exitCode).toBe(7);
    expect(result.artifacts.verdict.pass).toBe(false);
    expect(result.artifacts.verdict.gaps.some((gap: { taskId: string }) => gap.taskId === 'verification')).toBe(true);
    expect(existsSync(join(runDir, 'verification.json'))).toBe(true);
    expect(readFileSync(join(runDir, 'events.jsonl'), 'utf8')).toContain('verification_complete');
  });
});

function fakeUltracodeGateway(
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
