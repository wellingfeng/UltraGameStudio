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
      // Pin a deliberately tiny budget via the CLI override: an explicit user
      // ceiling that reconcileBudget must honor as a hard cap (lowering rounds,
      // not raising calls), so the soft-stop path is still exercised.
      maxAgentCalls: '4',
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
      // Explicit user ceiling of 5 — honored as a hard cap so the reserve /
      // closing-pass split (work ceiling 3, reserve 2) is exercised as intended.
      maxAgentCalls: '5',
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
    const base = fakeUltracodeGateway(calls);
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
    const code = await runUltracode('审查博客里的技术论断', {
      cwd: dir,
      runId: 'uc-objchecks',
      json: true,
      quiet: true,
      gateway,
      concurrency: '3',
      maxRetries: '0',
    });

    const result = JSON.parse(outBuf);
    const runDir = join(dir, '.fuc-run', 'uc-objchecks');
    expect(code).toBe(1);
    expect(existsSync(join(runDir, 'objective-checks.json'))).toBe(true);
    // Model gate self-reported pass, but the objective check failed → false-accept.
    expect(result.verdictSignals.modelVerdictPass).toBe(true);
    expect(result.verdictSignals.groundTruthPass).toBe(false);
    expect(result.success).toBe(false);
    const events = readFileSync(join(runDir, 'events.jsonl'), 'utf8');
    expect(events).toContain('objective_checks_complete');
    const summary = JSON.parse(readFileSync(join(runDir, 'run-summary.json'), 'utf8'));
    expect(summary.gate.classification).toBe('false-accept');
  });

  it('skips planner-proposed command checks unless --auto-verify is set', async () => {
    const calls: string[] = [];
    const base = fakeUltracodeGateway(calls);
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
    const code = await runUltracode('审查博客里的技术论断', {
      cwd: dir,
      runId: 'uc-cmd-skip',
      json: true,
      quiet: true,
      gateway,
      concurrency: '3',
      maxRetries: '0',
    });

    const result = JSON.parse(outBuf);
    const runDir = join(dir, '.fuc-run', 'uc-cmd-skip');
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
    const base = fakeUltracodeGateway(calls);
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
              { kind: 'file-exists', path: '.fuc-run/uc-weak-truth/request.json' },
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
    const code = await runUltracode('审查博客里的技术论断', {
      cwd: dir,
      runId: 'uc-weak-truth',
      json: true,
      quiet: true,
      gateway,
      concurrency: '3',
      maxRetries: '0',
    });

    const result = JSON.parse(outBuf);
    const runDir = join(dir, '.fuc-run', 'uc-weak-truth');
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
