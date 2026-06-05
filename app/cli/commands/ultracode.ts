/**
 * `fuc ultracode "<task>"` — dynamic workflow entrypoint.
 *
 * This command deliberately bypasses the visual workflow authoring path. It
 * generates a task-specific harness, executes it immediately through the shared
 * runtime, and persists the full run protocol under `.fuc-run/<run-id>/`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { formatDuration } from '../../src/runtime/format';
import type { RunFailure, RunGateway, RunResult } from '../../src/runtime';
import {
  PLANNER_NODE_ID,
  buildDynamicHarnessGraph,
  buildDynamicPlannerGraph,
  extractHarnessArtifacts,
  fallbackHarnessSpec,
  parseDynamicHarnessSpec,
  type DynamicHarnessArtifacts,
  type DynamicHarnessSpec,
} from '../../src/runtime/dynamicHarness';
import { buildNodeGateway, runBlueprint, type RunEvent } from '../runtime-host';
import { CliError, errMsg } from '../utils/fs';
import { c, type GlobalOptions } from '../utils/format';

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
  timeout?: string;
  runId?: string;
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
  durationMs: number;
  failedNodeId: string | null;
  error: Record<string, unknown> | null;
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
    if (!opts.quiet) {
      process.stderr.write(c.dim(`ultracode run: ${runId}\n`));
      process.stderr.write(c.dim(`run dir: ${runDir}\n`));
    }

    writeJson(join(runDir, 'request.json'), { request: task, createdAt: startedAt });

    updateStore(store, { phase: 'planning', status: 'running' });
    const plannerGraph = buildDynamicPlannerGraph(task);
    writeJson(join(runDir, 'planner.fuc.json'), plannerGraph);
    const plannerEvents = makeRunLogger(store, 'planning', opts);

    let plannerResult: RunResult;
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

    const spec = plannerResult.success
      ? parseDynamicHarnessSpec(plannerResult.outputs[PLANNER_NODE_ID], task)
      : fallbackHarnessSpec(task);
    writeJson(join(runDir, 'harness.json'), spec);

    if (opts.plannerOnly) {
      updateStore(store, { phase: 'complete', status: 'success' });
      const json = resultJson(runId, runDir, spec, emptyArtifacts(), plannerResult, startedAt);
      writeJson(join(runDir, 'result.json'), json);
      emitResult(json, opts);
      return 0;
    }

    updateStore(store, {
      phase: 'executing',
      status: 'running',
      maxAgentCalls: spec.budget.maxAgentCalls,
    });
    const harnessGraph = buildDynamicHarnessGraph(spec);
    writeJson(join(runDir, 'workflow.fuc.json'), harnessGraph);

    let spentCalls = 0;
    const baseGateway = opts.gateway ?? buildNodeGateway({ cwd, signal: controller.signal });
    const gateway = budgetGateway(baseGateway, spec.budget.maxAgentCalls, (spent) => {
      spentCalls = spent;
      updateStore(store, { agentCalls: spentCalls });
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
        runtimeVoteSamplesMin: 2,
        runtimeVoteSamplesMax: 4,
        terminalVoteSamplesMin: 2,
        terminalVoteSamplesMax: 4,
        escalationBudget: Math.max(0, spec.budget.maxAgentCalls - 4),
        onEvent: runEvents,
      });
    } catch (err) {
      throw classifyRunError(err, 'Execution failed');
    }

    const artifacts = extractHarnessArtifacts(runResult.outputs);
    const json = resultJson(runId, runDir, spec, artifacts, runResult, startedAt);
    writeJson(join(runDir, 'result.json'), json);
    if (opts.output) writeJson(resolve(process.cwd(), opts.output), json);
    updateStore(store, {
      phase: runResult.success ? 'complete' : 'error',
      status: runResult.success ? 'success' : 'error',
      failedNodeId: runResult.failedNodeId ?? null,
      error: runResult.error ?? null,
      agentCalls: spentCalls,
    });
    emitResult(json, opts);
    return json.success ? 0 : 1;
  } catch (err) {
    const msg = errMsg(err);
    updateStore(store, {
      phase: 'error',
      status: 'error',
      error: msg,
    });
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
  return (event) => {
    appendEvent(store.runDir, { ts: Date.now(), phase, ...event });
    switch (event.kind) {
      case 'node_start':
        updateStore(store, {
          phase,
          status: 'running',
          nodeStates: { ...store.status.nodeStates, [event.nodeId]: 'running' },
        });
        if (!quiet) process.stderr.write(`${c.cyan('▶')} ${phase} ${event.nodeId}${event.label ? ` (${event.label})` : ''}\n`);
        break;
      case 'node_success':
        updateStore(store, {
          phase,
          status: 'running',
          nodeStates: { ...store.status.nodeStates, [event.nodeId]: 'success' },
        });
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

function budgetGateway(
  base: RunGateway,
  maxCalls: number,
  onSpent: (spent: number) => void,
): RunGateway {
  let spent = 0;
  const charge = () => {
    spent += 1;
    onSpent(spent);
    if (spent > maxCalls) {
      throw new Error(`ULTRACODE_BUDGET_EXCEEDED: maxAgentCalls=${maxCalls}`);
    }
  };
  return {
    ...base,
    completeText: async (opts) => {
      charge();
      return base.completeText(opts);
    },
    spawnCliAgent: async (prompt, adapter, opts) => {
      charge();
      return base.spawnCliAgent(prompt, adapter, opts);
    },
  };
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

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function resultJson(
  runId: string,
  runDir: string,
  spec: DynamicHarnessSpec,
  artifacts: DynamicHarnessArtifacts,
  result: RunResult,
  startedAt: number,
): UltracodeJsonResult {
  return {
    success: result.success && (artifacts.verdict?.pass ?? result.success),
    runId,
    runDir,
    spec,
    artifacts,
    durationMs: Date.now() - startedAt,
    failedNodeId: result.failedNodeId ?? null,
    error: result.error ?? null,
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

function emptyArtifacts(): DynamicHarnessArtifacts {
  return { ledger: null, verdict: null, report: '' };
}
