/**
 * `fuc ultracode "<task>"` — dynamic workflow entrypoint.
 *
 * This command deliberately bypasses the visual workflow authoring path. It
 * generates a task-specific harness, executes it immediately through the shared
 * runtime, and persists the full run protocol under `.fuc-run/<run-id>/`.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, type Dirent } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatDuration } from '../../src/runtime/format';
import type { IRGraph, IRRunStatus } from '../../src/core/ir';
import {
  getRunnableNodes,
  type NodeRunResult,
  type RunFailure,
  type RunGateway,
  type RunResult,
} from '../../src/runtime';
import {
  encodeProgressEvent,
  type UltracodeNodeStatus,
  type UltracodeProgressEvent,
} from '../../src/runtime/ultracodeProgress';
import {
  PLANNER_NODE_ID,
  PLAN_CRITIC_NODE_ID,
  buildDynamicHarnessGraph,
  buildDynamicPlannerGraph,
  extractHarnessArtifacts,
  fallbackHarnessSpec,
  parseDynamicHarnessSpecResult,
  reconcileBudget,
  resolvePlannedSpec,
  verdictEffectivePass,
  type DynamicHarnessArtifacts,
  type DynamicHarnessSpec,
} from '../../src/runtime/dynamicHarness';
import { buildNodeGateway, runBlueprint, type RunEvent } from '../runtime-host';
import { CliError, errMsg } from '../utils/fs';
import { c, type GlobalOptions } from '../utils/format';
import { buildRunSummary } from './ultracodeSummary';
import { runObjectiveChecks, type ObjectiveChecksReport } from './objectiveChecks';

/**
 * Build timestamp baked in by cli/build.mjs (ISO seconds). `undefined` when the
 * command is run straight from source via `cli:dev` (--experimental-strip-types),
 * where there is no stale-dist hazard to guard against.
 */
declare const __FUC_BUILD_TIME__: string;
const FUC_BUILD_TIME: string | null =
  typeof __FUC_BUILD_TIME__ !== 'undefined' ? __FUC_BUILD_TIME__ : null;

/**
 * Whether to weave structured `<<FUC_PROGRESS>>` sentinels into stderr so the
 * desktop GUI can render a live run-progress card. Enabled only when stderr is
 * captured (not a TTY) — a human terminal sees the normal log lines untouched —
 * and never in --json-only/quiet contexts where stderr text matters less.
 * Overridable with FUC_PROGRESS_EVENTS=0 (force off) / =1 (force on).
 */
function progressEventsEnabled(): boolean {
  const env = process.env.FUC_PROGRESS_EVENTS;
  if (env === '0') return false;
  if (env === '1') return true;
  return !(process.stderr.isTTY ?? false);
}

const PROGRESS_EVENTS_ON = progressEventsEnabled();

/** Emit one structured progress event to stderr (no-op when disabled). */
function emitProgress(event: UltracodeProgressEvent): void {
  if (!PROGRESS_EVENTS_ON) return;
  process.stderr.write(encodeProgressEvent(event));
}

/**
 * Staleness guard for the "edited source but ran a stale dist" failure mode that
 * silently disabled the acceptance-gate budget reserve. When running from a
 * bundled dist, compare its build time against the newest mtime in the command's
 * own source tree (cli/ + src/runtime/). If source is newer, the dist is stale —
 * warn loudly so the user rebuilds before trusting the run. Best-effort: any
 * filesystem error degrades to silence (never blocks a legitimate run).
 */
function warnIfStaleBuild(quiet: boolean): void {
  if (quiet || !FUC_BUILD_TIME) return;
  const builtAt = Date.parse(FUC_BUILD_TIME);
  if (Number.isNaN(builtAt)) return;
  let here: string;
  try {
    here = dirname(fileURLToPath(import.meta.url));
  } catch {
    return;
  }
  // From cli/dist/ (bundled) or cli/commands/ (source), the CLI + runtime roots
  // sit at ../.. and ../../src/runtime. Scan both for the newest source mtime.
  const roots = [resolve(here, '..'), resolve(here, '..', '..', 'src', 'runtime')];
  let newestSrc = 0;
  for (const root of roots) {
    newestSrc = Math.max(newestSrc, newestMtimeOfTsFiles(root, 0));
  }
  if (newestSrc > builtAt + 1000) {
    const ageMin = Math.round((newestSrc - builtAt) / 60000);
    process.stderr.write(
      c.warn(
        `⚠ CLI dist 可能已过期：构建于 ${FUC_BUILD_TIME}，但源码有更新（最新改动比构建晚约 ${ageMin} 分钟）。\n` +
          `  本次运行用的是旧的 fuc.mjs，最近的源码改动可能未生效。请先重建：cd app && node cli/build.mjs\n`,
      ),
    );
  }
}

/** Newest mtime (ms) among *.ts files under dir, recursing up to 3 levels. */
function newestMtimeOfTsFiles(dir: string, depth: number): number {
  if (depth > 3) return 0;
  let newest = 0;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      newest = Math.max(newest, newestMtimeOfTsFiles(full, depth + 1));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      try {
        newest = Math.max(newest, statSync(full).mtimeMs);
      } catch {
        /* ignore */
      }
    }
  }
  return newest;
}

export interface UltracodeOptions extends GlobalOptions {
  adapter?: string;
  model?: string;
  provider?: string;
  cwd?: string;
  output?: string;
  interactive?: boolean;
  nonInteractive?: boolean;
  concurrency?: string;
  maxRetries?: string;
  maxAgentCalls?: string;
  maxRounds?: string;
  verifyCommand?: string;
  autoVerify?: boolean;
  timeout?: string;
  runId?: string;
  resume?: boolean;
  fromHarness?: string;
  trace?: boolean;
  plannerOnly?: boolean;
  /** Testing seam. The real CLI leaves this undefined. */
  gateway?: RunGateway;
}

export interface UltracodeJsonResult {
  success: boolean;
  runId: string;
  runDir: string;
  spec: DynamicHarnessSpec;
  artifacts: DynamicHarnessArtifacts;
  budget?: UltracodeBudgetSnapshot;
  verification?: UltracodeVerificationResult;
  /**
   * Phase 2 observability — the two acceptance signals kept SEPARATE:
   * `modelVerdictPass` is the model's self-graded gate (verdictEffectivePass),
   * `groundTruthPass` is the objective --verify-command result (null when none).
   * `success` above is a mixed convenience flag; for accuracy measurement read
   * these two fields (and run-summary.json's gate quadrant), not `success`.
   */
  verdictSignals?: {
    modelVerdictPass: boolean | null;
    groundTruthPass: boolean | null;
  };
  /** Phase 1 observability — derived run flags surfaced for the summary. */
  observability?: {
    plannerFallback: boolean;
    closingPass: boolean;
  };
  durationMs: number;
  failedNodeId: string | null;
  error: Record<string, unknown> | null;
  outputs: Record<string, string>;
  nodeResults: Record<string, NodeRunResult>;
}

interface UltracodeBudgetSnapshot {
  maxAgentCalls: number;
  spentAgentCalls: number;
  exhausted: boolean;
}

interface UltracodeVerificationResult {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  passed: boolean;
  error?: string;
}

interface RunStore {
  runId: string;
  runDir: string;
  status: {
    runId: string;
    phase: 'planning' | 'executing' | 'complete' | 'error';
    status: 'running' | 'success' | 'error';
    updatedAt: number;
    request: string;
    nodeStates: Record<string, string>;
    failedNodeId?: string | null;
    error?: RunFailure | Record<string, unknown> | string | null;
    agentCalls?: number;
    maxAgentCalls?: number;
  };
}

export async function runUltracode(
  request: string,
  opts: UltracodeOptions,
): Promise<number> {
  const task = request.trim();
  if (!task) {
    throw new CliError('请提供任务：fuc ultracode "<任务>"', 1);
  }

  const cwd = opts.cwd ? resolve(process.cwd(), opts.cwd) : process.cwd();
  const runId = opts.runId?.trim() || makeRunId(task);
  const runDir = join(cwd, '.fuc-run', runId);
  const store = createRunStore(runId, runDir, task);
  const startedAt = Date.now();
  const controller = new AbortController();
  const onSigint = installSigintHandler(controller);

  try {
    const resumeSnapshot = opts.resume && !opts.plannerOnly ? readResumeSnapshot(runDir) : null;
    if (!opts.quiet) {
      process.stderr.write(c.dim(`ultracode run: ${runId}\n`));
      process.stderr.write(c.dim(`run dir: ${runDir}\n`));
      if (FUC_BUILD_TIME) {
        process.stderr.write(c.dim(`cli build: ${FUC_BUILD_TIME}\n`));
      }
      warnIfStaleBuild(opts.quiet ?? false);
      if (opts.resume) {
        process.stderr.write(
          resumeSnapshot
            ? c.dim(`Resuming ultracode snapshot (failed node: ${resumeSnapshot.failedNodeId ?? 'auto'})\n`)
            : c.warn('No resumable ultracode result.json found; running fresh.\n'),
        );
      }
    }

    writeJson(join(runDir, 'request.json'), { request: task, createdAt: startedAt });

    let spec: DynamicHarnessSpec;
    let plannerResult: RunResult | null = null;
    // Run-scoped observability flags surfaced into result.json + run-summary.json.
    let plannerFallback = false;
    let ranClosingPass = false;
    if (resumeSnapshot) {
      spec = applyBudgetOverrides(resumeSnapshot.spec, opts);
    } else if (opts.fromHarness) {
      // Reuse a previously-saved harness.json, skipping the planner entirely so
      // a run can be reproduced/iterated without re-planning. The file is run
      // through the same normalizer as planner output, so hand-edits are
      // tolerated (missing fields fall back to safe defaults).
      const raw = readTextFile(resolve(process.cwd(), opts.fromHarness));
      if (raw === null) {
        throw new CliError(`无法读取 harness 规格文件：${opts.fromHarness}`, 1);
      }
      const loaded = parseDynamicHarnessSpecResult(raw, task);
      if (loaded.usedFallback) {
        throw new CliError(
          `harness 规格文件不是合法 JSON：${opts.fromHarness}`,
          1,
        );
      }
      if (!opts.quiet) {
        process.stderr.write(c.dim(`复用 harness 规格：${opts.fromHarness}（跳过规划）\n`));
      }
      appendEvent(runDir, {
        ts: Date.now(),
        phase: 'planning',
        kind: 'planner_skipped',
        source: opts.fromHarness,
      });
      spec = applyBudgetOverrides(loaded.spec, opts);
    } else {
      updateStore(store, { phase: 'planning', status: 'running' });
      const plannerGraph = buildDynamicPlannerGraph(task);
      writeJson(join(runDir, 'planner.fuc.json'), plannerGraph);
      const plannerEvents = makeRunLogger(store, 'planning', opts);

      try {
        plannerResult = await runBlueprint(plannerGraph, {
          adapter: opts.adapter,
          model: opts.model,
          providerId: opts.provider,
          cwd,
          concurrency: 1,
          maxRetries: parseNumber(opts.maxRetries),
          timeoutSeconds: parseNumber(opts.timeout),
          nonInteractive: opts.interactive ? false : opts.nonInteractive ?? true,
          gateway: opts.gateway,
          signal: controller.signal,
          onEvent: plannerEvents,
        });
      } catch (err) {
        throw classifyRunError(err, 'Planning failed');
      }

      let usedFallback = false;
      if (plannerResult.success) {
        // Resolve the spec from the planner + plan-critic pair. The critic's
        // revisedSpec (a stronger model auditing the cheaper planner) is
        // authoritative when present, since the whole run inherits this spec's
        // success criteria and scope — the cheapest place to fix errors.
        const resolved = resolvePlannedSpec(
          plannerResult.outputs[PLANNER_NODE_ID],
          plannerResult.outputs[PLAN_CRITIC_NODE_ID],
          task,
        );
        spec = resolved.spec;
        usedFallback = resolved.usedFallback;
        if (resolved.critiqueApplied) {
          appendEvent(runDir, {
            ts: Date.now(),
            phase: 'planning',
            kind: 'plan_critique_applied',
            ok: resolved.critique?.ok ?? null,
            issueCount: resolved.critique?.issues.length ?? 0,
            issues: resolved.critique?.issues ?? [],
          });
          if (!opts.quiet && resolved.critique && resolved.critique.issues.length > 0) {
            process.stderr.write(
              c.dim(`规格复审修正了 ${resolved.critique.issues.length} 处问题。\n`),
            );
          }
        }
      } else {
        spec = fallbackHarnessSpec(task);
        usedFallback = true;
      }
      plannerFallback = usedFallback;
      if (usedFallback) {
        const reason = plannerResult.success
          ? 'planner 未产出可解析的 harness 规格'
          : 'planner 节点执行失败';
        appendEvent(runDir, {
          ts: Date.now(),
          phase: 'planning',
          kind: 'planner_fallback',
          reason,
        });
        if (!opts.quiet) {
          process.stderr.write(
            c.warn(`降级规划：${reason}，已回退到基于关键词推断的默认 harness。\n`),
          );
        }
      }
      spec = applyBudgetOverrides(spec, opts);
    }
    // Reconcile the call budget against the declared repair rounds so the plan
    // can't promise more rounds than the budget can fund (the failure mode where
    // a 2-round plan ran out of calls at the first acceptance gate). When the
    // user pinned --max-agent-calls, treat it as a hard ceiling: rounds drop to
    // fit rather than the ceiling rising past the user's explicit cap.
    {
      const userCeiling = parseNumber(opts.maxAgentCalls);
      const reconciled = reconcileBudget(spec, userCeiling ?? undefined);
      if (reconciled.note) {
        spec = reconciled.spec;
        appendEvent(runDir, {
          ts: Date.now(),
          phase: 'planning',
          kind: 'budget_reconciled',
          note: reconciled.note,
          maxAgentCalls: spec.budget.maxAgentCalls,
          maxRounds: spec.budget.maxRounds,
        });
        if (!opts.quiet) process.stderr.write(c.dim(`${reconciled.note}\n`));
      }
    }
    writeJson(join(runDir, 'harness.json'), spec);

    if (opts.plannerOnly) {
      updateStore(store, { phase: 'complete', status: 'success' });
      const json = resultJson(
        runId,
        runDir,
        spec,
        emptyArtifacts(),
        plannerResult ?? emptyRunResult(),
        startedAt,
      );
      writeJson(join(runDir, 'result.json'), json);
      emitResult(json, opts);
      return 0;
    }

    updateStore(store, {
      phase: 'executing',
      status: 'running',
      maxAgentCalls: spec.budget.maxAgentCalls,
    });
    const harnessGraph = resumeSnapshot?.workflow ?? buildDynamicHarnessGraph(spec);
    writeJson(join(runDir, 'workflow.fuc.json'), harnessGraph);
    emitProgress({
      kind: 'harness_ready',
      totalNodes: getRunnableNodes(harnessGraph).length,
      maxAgentCalls: spec.budget.maxAgentCalls,
      objective: spec.objective,
    });
    const seedOutputs = resumeSnapshot?.outputs;
    const seedRunState = resumeSnapshot
      ? nodeStatesFromResults(resumeSnapshot.nodeResults)
      : undefined;
    const resumeFromNodeId = resumeSnapshot
      ? resumeSnapshot.failedNodeId ?? inferResumeNodeId(harnessGraph, seedOutputs ?? {}, seedRunState ?? {})
      : null;
    if (resumeSnapshot) {
      updateStore(store, {
        nodeStates: {
          ...store.status.nodeStates,
          ...(seedRunState ?? {}),
        },
        failedNodeId: resumeFromNodeId,
      });
    }

    let spentCalls = 0;
    const baseGateway = opts.gateway ?? buildNodeGateway({ cwd, signal: controller.signal });
    // Reserve a slice of the budget so the acceptance gate + report can still run
    // (a graceful closing pass) if the work phase exhausts its share. Sized to
    // the gate's voter count plus the report, clamped to leave real work budget.
    const closingReserve = closingReserveFor(spec);
    const budget = createBudgetState(spec.budget.maxAgentCalls, closingReserve);
    const gateway = budgetGateway(baseGateway, budget, (spent) => {
      spentCalls = spent;
      updateStore(store, { agentCalls: spentCalls });
      emitProgress({ kind: 'agent_calls', spent: spentCalls });
    }, () => {
      appendEvent(runDir, {
        ts: Date.now(),
        phase: 'executing',
        kind: budget.exhausted ? 'budget_exhausted' : 'work_budget_exhausted',
        maxAgentCalls: budget.maxAgentCalls,
        spentAgentCalls: budget.spentAgentCalls,
      });
      controller.abort();
    });
    const runEvents = makeRunLogger(store, 'executing', opts);

    let runResult: RunResult;
    try {
      runResult = await runBlueprint(harnessGraph, {
        adapter: opts.adapter,
        model: opts.model,
        providerId: opts.provider,
        cwd,
        concurrency: parseNumber(opts.concurrency),
        maxRetries: parseNumber(opts.maxRetries),
        timeoutSeconds: parseNumber(opts.timeout),
        nonInteractive: opts.interactive ? false : opts.nonInteractive ?? true,
        gateway,
        signal: controller.signal,
        seedOutputs,
        seedRunState,
        resumeFromNodeId,
        runtimeVoteSamplesMax: 1,
        terminalVoteSamplesMax: 1,
        escalationBudget: 0,
        adaptiveEscalation: false,
        onEvent: runEvents,
      });
    } catch (err) {
      throw classifyRunError(err, 'Execution failed');
    }

    // Graceful closing pass: the work phase ran out of its budget share mid-run
    // (which aborted the in-flight run) but a reserve remains. Resume from the
    // first unfinished node (the gate/report) over whatever outputs were
    // produced, drawing from the reserved pool, so the user gets an honest
    // acceptance verdict instead of raw half-products.
    if (budget.workExhausted && !budget.exhausted) {
      ranClosingPass = true;
      runResult = await runClosingPass({
        opts,
        cwd,
        runDir,
        store,
        harnessGraph,
        budget,
        prevResult: runResult,
        onSpent: (spent) => {
          spentCalls = spent;
          updateStore(store, { agentCalls: spentCalls });
          emitProgress({ kind: 'agent_calls', spent: spentCalls });
        },
      });
    }

    const budgetSnapshot = budget.snapshot();
    let artifacts = withBudgetExhaustionArtifacts(
      extractHarnessArtifacts(runResult.outputs),
      budgetSnapshot,
    );
    // Capture the model's OWN acceptance verdict BEFORE verify-command folds its
    // result into artifacts.verdict (withVerificationArtifacts rewrites pass to
    // `pass && verification.passed`). Phase-2 calibration needs the unmutated
    // self-verdict, otherwise the false-accept quadrant could never be detected.
    const modelVerdictPass = artifacts.verdict
      ? verdictEffectivePass(artifacts.verdict, spec.successCriteria)
      : null;
    const verification = await maybeRunVerificationCommand(opts, cwd, runDir);
    if (verification) {
      artifacts = withVerificationArtifacts(artifacts, verification);
    }
    // Objective checks the planner emitted: read-only file assertions always
    // run; command checks run only under --auto-verify. Skipped command checks
    // make the objective signal incomplete rather than a strong pass.
    const objectiveReport = await maybeRunObjectiveChecks(spec, opts, cwd, runDir);
    if (objectiveReport && (objectiveReport.ranCount > 0 || objectiveReport.skippedCount > 0)) {
      artifacts = withObjectiveCheckArtifacts(artifacts, objectiveReport);
    }
    const groundTruthPass = combineGroundTruth(verification, objectiveReport);
    const failedNodeId = runResult.failedNodeId ??
      (budgetSnapshot.exhausted || groundTruthPass === false
        ? inferResumeNodeId(harnessGraph, runResult.outputs, nodeStatesFromResults(runResult.nodeResults))
        : null);
    const json = resultJson(
      runId,
      runDir,
      spec,
      artifacts,
      runResult,
      startedAt,
      budgetSnapshot,
      failedNodeId,
      verification ?? undefined,
      { plannerFallback, closingPass: ranClosingPass },
      modelVerdictPass,
      groundTruthPass,
    );
    writeJson(join(runDir, 'result.json'), json);
    writeJson(join(runDir, 'run-summary.json'), buildRunSummary(json));
    if (opts.output) writeJson(resolve(process.cwd(), opts.output), json);
    updateStore(store, {
      phase: json.success ? 'complete' : 'error',
      status: json.success ? 'success' : 'error',
      failedNodeId,
      error: runResult.error ?? null,
      agentCalls: spentCalls,
    });
    emitProgress({ kind: 'phase', phase: json.success ? 'complete' : 'error' });
    emitResult(json, opts);
    return json.success ? 0 : 1;
  } catch (err) {
    const msg = errMsg(err);
    updateStore(store, {
      phase: 'error',
      status: 'error',
      error: msg,
    });
    emitProgress({ kind: 'phase', phase: 'error' });
    appendEvent(runDir, { ts: Date.now(), phase: store.status.phase, kind: 'fatal', error: msg });
    if (err instanceof CliError) throw err;
    throw new CliError(msg, /NO_MODEL_GATEWAY_BACKEND|NO_API_KEY|NO_MODEL\b/.test(msg) ? 4 : 1);
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
}

function makeRunLogger(
  store: RunStore,
  phase: 'planning' | 'executing',
  opts: UltracodeOptions,
): (event: RunEvent) => void {
  const quiet = opts.quiet ?? false;
  // Only the execution harness feeds the GUI progress card's node list (its
  // totalNodes denominator comes from the harness graph); planning nodes precede
  // harness_ready and would otherwise inflate the count.
  const emitNodes = phase === 'executing';
  const nodeStatus = (state: IRRunStatus): UltracodeNodeStatus =>
    state === 'success'
      ? 'success'
      : state === 'interrupted'
        ? 'interrupted'
        : state === 'running'
          ? 'running'
          : 'error';
  return (event) => {
    if (opts.trace || !isStreamEvent(event)) {
      appendEvent(store.runDir, { ts: Date.now(), phase, ...event });
    }
    switch (event.kind) {
      case 'node_start':
        updateStore(store, {
          phase,
          status: 'running',
          nodeStates: { ...store.status.nodeStates, [event.nodeId]: 'running' },
        });
        if (emitNodes) {
          emitProgress({ kind: 'node', id: event.nodeId, label: event.label, status: 'running' });
        }
        if (!quiet) process.stderr.write(`${c.cyan('▶')} ${phase} ${event.nodeId}${event.label ? ` (${event.label})` : ''}\n`);
        break;
      case 'node_success':
        updateStore(store, {
          phase,
          status: 'running',
          nodeStates: { ...store.status.nodeStates, [event.nodeId]: 'success' },
        });
        if (emitNodes) emitProgress({ kind: 'node', id: event.nodeId, status: 'success' });
        if (!quiet) process.stderr.write(`${c.ok('✓')} ${phase} ${event.nodeId}\n`);
        break;
      case 'node_failure':
        updateStore(store, {
          phase,
          status: 'error',
          nodeStates: { ...store.status.nodeStates, [event.nodeId]: event.state },
          failedNodeId: event.nodeId,
          error: event.failure,
        });
        if (emitNodes) {
          emitProgress({ kind: 'node', id: event.nodeId, status: nodeStatus(event.state) });
        }
        if (!quiet) process.stderr.write(`${c.err('✗')} ${phase} ${event.nodeId}: ${event.failure.message}\n`);
        break;
      case 'node_retry':
        if (!quiet) {
          process.stderr.write(
            `${c.warn('↻')} ${phase} ${event.nodeId} retry ${event.attempt}/${event.maxRetries}\n`,
          );
        }
        break;
      case 'log':
        if (!quiet && (opts.verbose || event.role === 'error')) {
          process.stderr.write(`${c.dim('●')} ${event.text}\n`);
        }
        break;
      case 'stream_append':
        if (!quiet && opts.verbose) process.stderr.write(event.chunk);
        break;
      default:
        break;
    }
  };
}

function isStreamEvent(event: RunEvent): boolean {
  return (
    event.kind === 'stream_begin' ||
    event.kind === 'stream_append' ||
    event.kind === 'stream_finalize' ||
    event.kind === 'stream_fail'
  );
}

function budgetGateway(
  base: RunGateway,
  budget: UltracodeBudgetState,
  onSpent: (spent: number) => void,
  onExhausted?: () => void,
): RunGateway {
  let exhaustedEventSent = false;
  const charge = () => {
    const charged = budget.charge();
    if (charged) onSpent(budget.spentAgentCalls);
    else if (!exhaustedEventSent) {
      exhaustedEventSent = true;
      onExhausted?.();
    }
    return charged;
  };
  return {
    ...base,
    completeText: async (opts) => {
      if (!charge()) {
        throw budgetExhaustedError(budget);
      }
      return base.completeText(opts);
    },
    spawnCliAgent: async (prompt, adapter, opts) => {
      if (!charge()) throw budgetExhaustedError(budget);
      return base.spawnCliAgent(prompt, adapter, opts);
    },
  };
}

/**
 * Size the closing reserve: enough for the acceptance gate's voters plus a
 * report call, clamped so it never eats more than ~40% of the budget and always
 * leaves real work budget behind. Returns 0 when the budget is too small to
 * reserve anything (degrades to the old hard-stop behaviour).
 */
function closingReserveFor(spec: DynamicHarnessSpec): number {
  const voters = Math.max(2, spec.acceptance?.voters ?? 2);
  const want = voters + 1; // gate voters + report
  const cap = Math.floor(spec.budget.maxAgentCalls * 0.4);
  const reserve = Math.min(want, cap);
  return reserve >= 2 ? reserve : 0;
}

interface ClosingPassArgs {
  opts: UltracodeOptions;
  cwd: string;
  runDir: string;
  store: RunStore;
  harnessGraph: IRGraph;
  budget: UltracodeBudgetState;
  prevResult: RunResult;
  onSpent: (spent: number) => void;
}

/**
 * Run the acceptance gate + report over already-produced outputs using the
 * reserved budget pool, on a fresh AbortController (the work phase aborted its
 * own). Merges the closing outputs back into the prior result so downstream
 * artifact extraction sees a complete run. If nothing remains to run, returns
 * the prior result unchanged.
 */
async function runClosingPass(args: ClosingPassArgs): Promise<RunResult> {
  const { opts, cwd, runDir, store, harnessGraph, budget, prevResult, onSpent } = args;
  const seedOutputs = prevResult.outputs;
  const seedRunState = nodeStatesFromResults(prevResult.nodeResults);
  const resumeFromNodeId = inferResumeNodeId(harnessGraph, seedOutputs, seedRunState);
  if (!resumeFromNodeId) return prevResult;

  budget.enterClosing();
  appendEvent(runDir, {
    ts: Date.now(),
    phase: 'executing',
    kind: 'closing_pass',
    resumeFromNodeId,
    spentAgentCalls: budget.spentAgentCalls,
    maxAgentCalls: budget.maxAgentCalls,
  });
  if (!opts.quiet) {
    process.stderr.write(
      c.warn(`工作预算已用尽，使用预留额度执行收尾验收/报告（从 ${resumeFromNodeId} 续跑）。\n`),
    );
  }

  const controller = new AbortController();
  const closingBase = opts.gateway ?? buildNodeGateway({ cwd, signal: controller.signal });
  const gateway = budgetGateway(closingBase, budget, onSpent, () => {
    appendEvent(runDir, {
      ts: Date.now(),
      phase: 'executing',
      kind: 'budget_exhausted',
      maxAgentCalls: budget.maxAgentCalls,
      spentAgentCalls: budget.spentAgentCalls,
    });
    controller.abort();
  });

  let closingResult: RunResult;
  try {
    closingResult = await runBlueprint(harnessGraph, {
      adapter: opts.adapter,
      model: opts.model,
      providerId: opts.provider,
      cwd,
      concurrency: parseNumber(opts.concurrency),
      maxRetries: parseNumber(opts.maxRetries),
      timeoutSeconds: parseNumber(opts.timeout),
      nonInteractive: opts.interactive ? false : opts.nonInteractive ?? true,
      gateway,
      signal: controller.signal,
      seedOutputs,
      seedRunState,
      resumeFromNodeId,
      runtimeVoteSamplesMax: 1,
      terminalVoteSamplesMax: 1,
      escalationBudget: 0,
      adaptiveEscalation: false,
      onEvent: makeRunLogger(store, 'executing', opts),
    });
  } catch {
    // A failed closing pass must not mask the work that did complete.
    return prevResult;
  }

  return {
    success: closingResult.success,
    durationMs: prevResult.durationMs + closingResult.durationMs,
    nodeResults: { ...prevResult.nodeResults, ...closingResult.nodeResults },
    outputs: { ...prevResult.outputs, ...closingResult.outputs },
    failedNodeId: closingResult.failedNodeId,
    error: closingResult.error ?? null,
  };
}

interface UltracodeBudgetState {
  readonly maxAgentCalls: number;
  readonly spentAgentCalls: number;
  readonly exhausted: boolean;
  /** True once the work-phase ceiling (max - reserve) is hit. */
  readonly workExhausted: boolean;
  /** Switch to the closing phase so reserved calls (gate/report) can run. */
  enterClosing(): void;
  charge(): boolean;
  snapshot(): UltracodeBudgetSnapshot;
}

/**
 * Two-phase agent-call budget. The work phase (workers + mid-stages) may spend
 * up to `maxAgentCalls - reserve`; hitting that ceiling stops new work WITHOUT
 * marking the whole budget exhausted, so a graceful closing pass (acceptance
 * gate + report over whatever was produced) can still run from the reserved
 * pool. Only when the absolute `maxAgentCalls` ceiling is reached is the budget
 * truly exhausted. `reserve` is clamped to leave at least 1 work call.
 */
function createBudgetState(maxAgentCalls: number, reserve = 0): UltracodeBudgetState {
  const safeReserve = Math.max(0, Math.min(reserve, Math.max(0, maxAgentCalls - 1)));
  const workCeiling = maxAgentCalls - safeReserve;
  let spentAgentCalls = 0;
  let exhausted = false;
  let workExhausted = false;
  let closing = false;
  return {
    maxAgentCalls,
    get spentAgentCalls() {
      return spentAgentCalls;
    },
    get exhausted() {
      return exhausted;
    },
    get workExhausted() {
      return workExhausted;
    },
    enterClosing() {
      closing = true;
    },
    charge() {
      const ceiling = closing ? maxAgentCalls : workCeiling;
      if (spentAgentCalls >= ceiling) {
        if (closing) exhausted = true;
        else workExhausted = true;
        return false;
      }
      spentAgentCalls += 1;
      return true;
    },
    snapshot() {
      return { maxAgentCalls, spentAgentCalls, exhausted };
    },
  };
}

function budgetExhaustedError(budget: UltracodeBudgetState): Error {
  return new Error(budgetExhaustedReason(budget));
}

function budgetExhaustedReason(budget: UltracodeBudgetSnapshot | UltracodeBudgetState): string {
  return `ULTRACODE_BUDGET_EXHAUSTED: maxAgentCalls=${budget.maxAgentCalls}, spentAgentCalls=${budget.spentAgentCalls}`;
}

function createRunStore(runId: string, runDir: string, request: string): RunStore {
  mkdirSync(runDir, { recursive: true });
  const store: RunStore = {
    runId,
    runDir,
    status: {
      runId,
      phase: 'planning',
      status: 'running',
      updatedAt: Date.now(),
      request,
      nodeStates: {},
    },
  };
  writeJson(join(runDir, 'status.json'), store.status);
  return store;
}

function updateStore(store: RunStore, patch: Partial<RunStore['status']>): void {
  store.status = {
    ...store.status,
    ...patch,
    nodeStates: patch.nodeStates ?? store.status.nodeStates,
    updatedAt: Date.now(),
  };
  writeJson(join(store.runDir, 'status.json'), store.status);
}

function appendEvent(runDir: string, event: Record<string, unknown>): void {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'events.jsonl'), `${JSON.stringify(event)}\n`, {
    encoding: 'utf8',
    flag: 'a',
  });
}

/** Read a UTF-8 text file, or `null` if it cannot be read. */
function readTextFile(file: string): string | null {
  try {
    return existsSync(file) ? readFileSync(file, 'utf8') : null;
  } catch {
    return null;
  }
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

interface UltracodeResumeSnapshot {
  spec: DynamicHarnessSpec;
  outputs: Record<string, string>;
  nodeResults: Record<string, NodeRunResult>;
  failedNodeId: string | null;
  workflow?: IRGraph;
}

function readResumeSnapshot(runDir: string): UltracodeResumeSnapshot | null {
  const file = join(runDir, 'result.json');
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<UltracodeJsonResult>;
    if (!raw.spec || !isStringRecord(raw.outputs) || !isNodeResultsRecord(raw.nodeResults)) {
      return null;
    }
    return {
      spec: raw.spec,
      outputs: raw.outputs,
      nodeResults: raw.nodeResults,
      failedNodeId: typeof raw.failedNodeId === 'string' ? raw.failedNodeId : null,
      workflow: readWorkflowSnapshot(runDir) ?? undefined,
    };
  } catch {
    return null;
  }
}

function readWorkflowSnapshot(runDir: string): IRGraph | null {
  const file = join(runDir, 'workflow.fuc.json');
  if (!existsSync(file)) return null;
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as IRGraph;
    return value && Array.isArray(value.nodes) && Array.isArray(value.edges) ? value : null;
  } catch {
    return null;
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).every((v) => typeof v === 'string');
}

function isNodeResultsRecord(value: unknown): value is Record<string, NodeRunResult> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).every((v) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    const status = (v as { status?: unknown }).status;
    return status === 'idle' || status === 'running' || status === 'success' || status === 'error' || status === 'interrupted';
  });
}

function nodeStatesFromResults(
  nodeResults: Record<string, NodeRunResult>,
): Record<string, IRRunStatus> {
  const states: Record<string, IRRunStatus> = {};
  for (const [id, result] of Object.entries(nodeResults)) {
    states[id] = result.status;
  }
  return states;
}

function inferResumeNodeId(
  workflow: IRGraph,
  outputs: Record<string, string>,
  nodeStates: Record<string, IRRunStatus>,
): string | null {
  for (const node of getRunnableNodes(workflow)) {
    if (node.type === 'start' || node.type === 'end') continue;
    if (outputs[node.id] !== undefined || nodeStates[node.id] === 'success') continue;
    return node.id;
  }
  return null;
}

function withBudgetExhaustionArtifacts(
  artifacts: DynamicHarnessArtifacts,
  budget: UltracodeBudgetSnapshot,
): DynamicHarnessArtifacts {
  if (!budget.exhausted) return artifacts;
  const reason = budgetExhaustedReason(budget);
  return {
    ...artifacts,
    verdict: {
      pass: false,
      acceptedArtifact: artifacts.verdict?.acceptedArtifact ?? '',
      evidence: [
        ...(artifacts.verdict?.evidence ?? []),
        `预算软停止：${reason}`,
      ],
      criteriaCoverage: artifacts.verdict?.criteriaCoverage ?? [],
      gaps: [
        ...(artifacts.verdict?.gaps ?? []),
        {
          taskId: 'budget',
          severity: 'P1',
          reason,
          nextAction: '基于 result.json 中已有 outputs 继续，或提高预算后使用 --resume 续跑 /ultracode。',
        },
      ],
    },
    report: budgetExhaustedReport(reason, artifacts.report),
  };
}

function budgetExhaustedReport(reason: string, existingReport: string): string {
  const prefix = [
    '最终结论：未通过。',
    '',
    `预算已耗尽：${reason}`,
    '已完成节点的产物已保留在 result.json、events.jsonl 和 status.json 中。',
    '下一步：提高 maxAgentCalls 或缩小任务范围后用 --resume 继续执行。',
  ].join('\n');
  return existingReport.trim() ? `${existingReport.trim()}\n\n${prefix}` : prefix;
}

async function maybeRunVerificationCommand(
  opts: UltracodeOptions,
  cwd: string,
  runDir: string,
): Promise<UltracodeVerificationResult | null> {
  const command = opts.verifyCommand?.trim();
  if (!command) return null;
  appendEvent(runDir, {
    ts: Date.now(),
    phase: 'executing',
    kind: 'verification_start',
    command,
  });
  if (!opts.quiet) {
    process.stderr.write(c.dim(`verification: ${command}\n`));
  }
  const startedAt = Date.now();
  const result = await runVerificationCommand(command, cwd);
  const verification: UltracodeVerificationResult = {
    command,
    exitCode: result.exitCode,
    stdout: clipOutput(result.stdout),
    stderr: clipOutput(result.stderr),
    durationMs: Date.now() - startedAt,
    passed: result.exitCode === 0,
    ...(result.error ? { error: result.error } : {}),
  };
  writeJson(join(runDir, 'verification.json'), verification);
  appendEvent(runDir, {
    ts: Date.now(),
    phase: 'executing',
    kind: 'verification_complete',
    command,
    exitCode: verification.exitCode,
    passed: verification.passed,
    durationMs: verification.durationMs,
    error: verification.error ?? null,
  });
  return verification;
}

/**
 * Run the planner's objective checks (file-exists/file-contains always;
 * command only under --auto-verify). Returns null when the spec has no checks.
 * Persists a report and surfaces start/complete events.
 */
async function maybeRunObjectiveChecks(
  spec: DynamicHarnessSpec,
  opts: UltracodeOptions,
  cwd: string,
  runDir: string,
): Promise<ObjectiveChecksReport | null> {
  const checks = spec.objectiveChecks ?? [];
  if (checks.length === 0) return null;
  const allowCommands = opts.autoVerify === true;
  appendEvent(runDir, {
    ts: Date.now(),
    phase: 'executing',
    kind: 'objective_checks_start',
    total: checks.length,
    allowCommands,
  });
  if (!opts.quiet) {
    process.stderr.write(
      c.dim(`objective checks: ${checks.length}${allowCommands ? '（含命令检查）' : '（仅只读文件检查）'}\n`),
    );
  }
  const report = await runObjectiveChecks(checks, cwd, { allowCommands });
  writeJson(join(runDir, 'objective-checks.json'), report);
  appendEvent(runDir, {
    ts: Date.now(),
    phase: 'executing',
    kind: 'objective_checks_complete',
    ran: report.ranCount,
    failed: report.failedCount,
    passed: report.passed,
  });
  return report;
}

/**
 * Combine the two objective ground-truth signals. A `false` from either source
 * is authoritative (a failing check means the run did not meet ground truth).
 * `true` requires every complete signal that produced an opinion to pass.
 * Skipped command checks mean the objective signal is incomplete, so they do
 * not override a model rejection as "ground truth passed".
 */
function combineGroundTruth(
  verification: UltracodeVerificationResult | null,
  objective: ObjectiveChecksReport | null,
): boolean | null {
  const signals: boolean[] = [];
  if (verification) signals.push(verification.passed);
  if (objective && objective.passed === false) signals.push(false);
  if (objective && objective.passed === true && !objective.hasSkippedCommands) signals.push(true);
  if (signals.length === 0) return null;
  return signals.every(Boolean);
}

/**
 * Fold objective-check results into the verdict + report so a failing check
 * lands in gaps and the report, mirroring withVerificationArtifacts.
 */
function withObjectiveCheckArtifacts(
  artifacts: DynamicHarnessArtifacts,
  report: ObjectiveChecksReport,
): DynamicHarnessArtifacts {
  const lines = report.results.map((r) => {
    const status = r.status === 'pass' ? '通过' : r.status === 'fail' ? '未通过' : '已跳过';
    return `客观检查[${r.kind}] ${r.target}：${status}（${r.detail}）`;
  });
  const failed = report.results.filter((r) => r.status === 'fail');
  const skippedCommands = report.results.filter((r) => r.status === 'skipped' && r.kind === 'command');
  const evidence = [...(artifacts.verdict?.evidence ?? []), ...lines];
  const gaps = [
    ...(artifacts.verdict?.gaps ?? []),
    ...failed.map((r) => ({
      taskId: 'objective-check',
      severity: 'P0',
      reason: `客观检查未通过：[${r.kind}] ${r.target} — ${r.detail}`,
      nextAction: '修复产物使客观检查通过，或修正 harness 规格中的检查后用同一 runId 续跑。',
    })),
    ...skippedCommands.map((r) => ({
      taskId: 'objective-check',
      severity: 'P2',
      reason: `命令类客观检查未执行：[${r.kind}] ${r.target} — ${r.detail}`,
      nextAction: '需要强客观验收时，用 --auto-verify 续跑或手动执行该命令并记录结果。',
    })),
  ];
  const report_ = [
    artifacts.report.trim(),
    '',
    '客观检查：',
    ...lines.map((line) => `- ${line}`),
  ]
    .filter(Boolean)
    .join('\n');
  return {
    ...artifacts,
    verdict: {
      pass: (artifacts.verdict?.pass ?? true) && report.failedCount === 0,
      acceptedArtifact: artifacts.verdict?.acceptedArtifact ?? '',
      evidence,
      criteriaCoverage: artifacts.verdict?.criteriaCoverage ?? [],
      gaps,
    },
    report: report_,
  };
}

function runVerificationCommand(
  command: string,
  cwd: string,
): Promise<{ exitCode: number | null; stdout: string; stderr: string; error?: string }> {
  return new Promise((resolveResult) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (err) => {
      resolveResult({
        exitCode: null,
        stdout,
        stderr,
        error: errMsg(err),
      });
    });
    child.on('close', (code) => {
      resolveResult({ exitCode: code, stdout, stderr });
    });
  });
}

function withVerificationArtifacts(
  artifacts: DynamicHarnessArtifacts,
  verification: UltracodeVerificationResult,
): DynamicHarnessArtifacts {
  const line =
    `验证命令：${verification.command} ` +
    `exitCode=${verification.exitCode ?? 'spawn-error'} ` +
    `耗时=${formatDuration(verification.durationMs)}`;
  const evidence = [
    ...(artifacts.verdict?.evidence ?? []),
    line,
    ...(verification.stdout.trim()
      ? [`stdout: ${oneLine(verification.stdout, 240)}`]
      : []),
    ...(verification.stderr.trim()
      ? [`stderr: ${oneLine(verification.stderr, 240)}`]
      : []),
  ];
  const gaps = [
    ...(artifacts.verdict?.gaps ?? []),
    ...(verification.passed
      ? []
      : [
          {
            taskId: 'verification',
            severity: 'P0',
            reason:
              verification.error ??
              `验证命令未通过：${verification.command} exitCode=${verification.exitCode ?? 'unknown'}`,
            nextAction: '修复命令失败原因后使用同一 runId 续跑，或调整 --verify-command 后重新执行。',
          },
        ]),
  ];
  const report = [
    artifacts.report.trim(),
    '',
    '验证命令：',
    `- ${line}`,
    verification.stdout.trim() ? `- stdout: ${oneLine(verification.stdout, 500)}` : '',
    verification.stderr.trim() ? `- stderr: ${oneLine(verification.stderr, 500)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return {
    ...artifacts,
    verdict: {
      pass: (artifacts.verdict?.pass ?? true) && verification.passed,
      acceptedArtifact: artifacts.verdict?.acceptedArtifact ?? '',
      evidence,
      criteriaCoverage: artifacts.verdict?.criteriaCoverage ?? [],
      gaps,
    },
    report,
  };
}

function clipOutput(value: string): string {
  return value.length > 12_000 ? `${value.slice(0, 12_000)}\n…[truncated]` : value;
}

function oneLine(value: string, max: number): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

function resultJson(
  runId: string,
  runDir: string,
  spec: DynamicHarnessSpec,
  artifacts: DynamicHarnessArtifacts,
  result: RunResult,
  startedAt: number,
  budget?: UltracodeBudgetSnapshot,
  failedNodeId?: string | null,
  verification?: UltracodeVerificationResult,
  observability?: { plannerFallback: boolean; closingPass: boolean },
  modelVerdictPassOverride?: boolean | null,
  groundTruthPassOverride?: boolean | null,
): UltracodeJsonResult {
  // Prefer the pre-verification model verdict captured by the caller; fall back
  // to (re)computing it for callers that don't pass it (e.g. plannerOnly).
  const modelVerdictPass =
    modelVerdictPassOverride !== undefined
      ? modelVerdictPassOverride
      : artifacts.verdict
        ? verdictEffectivePass(artifacts.verdict, spec.successCriteria)
        : null;
  // Combined objective ground truth (verify-command + objective checks). Callers
  // that compute it pass it explicitly; legacy callers fall back to the
  // verify-command result alone.
  const groundTruthPass =
    groundTruthPassOverride !== undefined
      ? groundTruthPassOverride
      : verification == null
        ? null
        : verification.passed === true;
  return {
    success:
      result.success &&
      !budget?.exhausted &&
      groundTruthPass !== false &&
      (artifacts.verdict ? modelVerdictPass === true : result.success),
    runId,
    runDir,
    spec,
    artifacts,
    ...(budget ? { budget } : {}),
    ...(verification ? { verification } : {}),
    verdictSignals: { modelVerdictPass, groundTruthPass },
    ...(observability ? { observability } : {}),
    durationMs: Date.now() - startedAt,
    failedNodeId: failedNodeId ?? result.failedNodeId ?? null,
    error: result.error ?? null,
    outputs: result.outputs,
    nodeResults: result.nodeResults,
  };
}

function emitResult(json: UltracodeJsonResult, opts: UltracodeOptions): void {
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(json, null, 2)}\n`);
    return;
  }
  const verdict = json.artifacts.verdict;
  const status = json.success ? c.ok('Ultracode complete') : c.err('Ultracode incomplete');
  process.stdout.write(`${status} — ${formatDuration(json.durationMs)}\n`);
  process.stdout.write(`run: ${json.runDir}\n`);
  if (verdict) {
    process.stdout.write(`verdict: ${verdict.pass ? 'pass' : 'fail'}\n`);
    const unmet = verdict.criteriaCoverage.filter((row) => !row.met);
    if (unmet.length > 0) {
      process.stdout.write(
        `未满足成功标准: ${unmet.map((row) => row.criterion || '?').join('；')}\n`,
      );
    }
    if (verdict.gaps.length > 0) {
      process.stdout.write(
        `gaps: ${verdict.gaps.map((gap) => `${gap.taskId || '?'} ${gap.severity}: ${gap.reason}`).join('；')}\n`,
      );
    }
  }
  const report = json.artifacts.report.trim();
  if (report) {
    process.stdout.write(`\n${report}\n`);
  }
}

function classifyRunError(err: unknown, prefix: string): CliError {
  const msg = errMsg(err);
  if (/NO_MODEL_GATEWAY_BACKEND|NO_API_KEY|NO_MODEL\b/.test(msg)) {
    return new CliError(`${prefix}: configuration error: ${msg}`, 4);
  }
  return new CliError(`${prefix}: ${msg}`, 1);
}

function installSigintHandler(controller: AbortController): () => void {
  let interrupts = 0;
  const onSigint = () => {
    interrupts += 1;
    if (interrupts === 1) {
      process.stderr.write(c.warn('\nInterrupt received — stopping after in-flight calls settle (Ctrl+C again to force).\n'));
      controller.abort();
    } else {
      process.stderr.write(c.err('\nForce kill.\n'));
      process.exit(2);
    }
  };
  process.on('SIGINT', onSigint);
  return onSigint;
}

function makeRunId(task: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const slug = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36);
  return `ultracode-${stamp}${slug ? `-${slug}` : ''}`;
}

function parseNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function applyBudgetOverrides(
  spec: DynamicHarnessSpec,
  opts: UltracodeOptions,
): DynamicHarnessSpec {
  const maxAgentCalls = parseNumber(opts.maxAgentCalls);
  const maxRounds = parseNumber(opts.maxRounds);
  if (!maxAgentCalls && !maxRounds) return spec;
  return {
    ...spec,
    budget: {
      ...spec.budget,
      ...(maxAgentCalls
        ? { maxAgentCalls: Math.max(1, Math.floor(maxAgentCalls)) }
        : {}),
      ...(maxRounds
        ? { maxRounds: Math.max(1, Math.floor(maxRounds)) }
        : {}),
    },
  };
}

function emptyArtifacts(): DynamicHarnessArtifacts {
  return { ledger: null, verdict: null, report: '' };
}

function emptyRunResult(): RunResult {
  return {
    success: true,
    durationMs: 0,
    nodeResults: {},
    outputs: {},
    failedNodeId: undefined,
    error: null,
  };
}
