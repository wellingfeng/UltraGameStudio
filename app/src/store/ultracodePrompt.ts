import { formatDuration } from '@/runtime/format';
import type {
  UltracodeRunOptions,
  UltracodeRunResult,
} from '@/lib/tauri';

export interface ParsedUltracodePrompt {
  request: string;
  options: Pick<
    UltracodeRunOptions,
    | 'concurrency'
    | 'maxRetries'
    | 'maxAgentCalls'
    | 'maxRounds'
    | 'verifyCommand'
    | 'timeoutSeconds'
    | 'runId'
    | 'resume'
    | 'plannerOnly'
    | 'fromHarness'
    | 'trace'
    | 'interactive'
  >;
}

interface UltracodeJsonResult {
  success?: unknown;
  runId?: unknown;
  runDir?: unknown;
  durationMs?: unknown;
  failedNodeId?: unknown;
  spec?: {
    objective?: unknown;
    strategies?: unknown;
    budget?: unknown;
    plan?: unknown;
    workerGroups?: unknown;
  };
  artifacts?: {
    ledger?: unknown;
    report?: unknown;
    verdict?: {
      pass?: unknown;
      evidence?: unknown;
      criteriaCoverage?: unknown;
      gaps?: unknown;
    } | null;
  };
  budget?: {
    maxAgentCalls?: unknown;
    spentAgentCalls?: unknown;
    exhausted?: unknown;
  };
  verification?: {
    command?: unknown;
    exitCode?: unknown;
    stdout?: unknown;
    stderr?: unknown;
    durationMs?: unknown;
    passed?: unknown;
    error?: unknown;
  };
}

interface TaskLike {
  id?: unknown;
  title?: unknown;
  owner?: unknown;
  status?: unknown;
  artifact?: unknown;
  gaps?: unknown;
}

interface PlanStepLike {
  id?: unknown;
  title?: unknown;
  kind?: unknown;
  phase?: unknown;
}

interface WorkerGroupLike {
  id?: unknown;
  title?: unknown;
  deliverable?: unknown;
}

interface CoverageLike {
  criterion?: unknown;
  met?: unknown;
  evidence?: unknown;
}

const VALUE_FLAGS = new Set([
  '--run-id',
  '--from-harness',
  '--concurrency',
  '--max-retries',
  '--max-agent-calls',
  '--max-rounds',
  '--verify-command',
  '--timeout',
]);

const BOOLEAN_FLAGS = new Set([
  '--resume',
  '--planner-only',
  '--trace',
  '--interactive',
]);

export function parseUltracodePrompt(input: string): ParsedUltracodePrompt {
  const tokens = splitArgs(input);
  const requestTokens: string[] = [];
  const options: ParsedUltracodePrompt['options'] = {};
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (BOOLEAN_FLAGS.has(token)) {
      setBooleanOption(options, token);
      continue;
    }
    if (VALUE_FLAGS.has(token)) {
      const value = tokens[i + 1];
      if (value === undefined || looksLikeFlag(value)) {
        requestTokens.push(token);
        continue;
      }
      setValueOption(options, token, value);
      i += 1;
      continue;
    }
    requestTokens.push(token);
  }
  return {
    request: requestTokens.join(' ').trim(),
    options,
  };
}

export function ultracodeModeLabel(
  options: ParsedUltracodePrompt['options'],
): string {
  const modes: string[] = [];
  if (options.resume) modes.push('resume');
  if (options.plannerOnly) modes.push('planner-only');
  if (options.fromHarness) modes.push('from-harness');
  if (options.verifyCommand) modes.push('verify');
  if (options.trace) modes.push('trace');
  if (options.interactive) modes.push('interactive');
  return modes.length ? modes.join(', ') : 'run';
}

export function summarizeUltracodeResult(result: UltracodeRunResult): string {
  const json = asObject(result.resultJson) as UltracodeJsonResult | null;
  const runId = stringValue(json?.runId) ?? result.runId;
  const runDir = stringValue(json?.runDir) ?? result.runDir ?? null;
  const durationMs = numberValue(json?.durationMs);
  const spec = asObject(json?.spec);
  const budget = asObject(json?.budget);
  const artifacts = asObject(json?.artifacts);
  const verification = asObject(json?.verification);
  const verdict = asObject(artifacts?.verdict);
  const ledger = asObject(artifacts?.ledger);
  const report = stringValue(artifacts?.report)?.trim() ?? '';
  const pass = booleanValue(verdict?.pass);
  const gaps = arrayValue(verdict?.gaps);
  const accepted = result.exitCode === 0 && json?.success !== false;
  const lines: string[] = [
    accepted
      ? '✓ /ultracode 已通过验收门。'
      : '⚠ /ultracode 已结束，但验收未完全通过。',
    '',
    '**运行概览**',
    `runId: ${runId}`,
  ];

  if (runDir) lines.push(`账本: ${runDir}`);
  if (durationMs !== undefined) lines.push(`耗时: ${formatDuration(durationMs)}`);
  if (pass !== undefined) lines.push(`验收: ${pass ? 'pass' : 'fail'}`);
  appendBudget(lines, spec?.budget, budget);
  if (stringValue(json?.failedNodeId)) {
    lines.push(`失败节点: ${stringValue(json?.failedNodeId)}`);
  }

  appendPlan(lines, spec);
  appendLedger(lines, ledger);
  appendVerdict(lines, verdict, gaps);
  appendVerification(lines, verification);
  appendResumeAdvice(lines, {
    accepted,
    gaps,
    runId,
    objective: stringValue(spec?.objective),
    maxAgentCalls: numberValue(asObject(spec?.budget)?.maxAgentCalls),
    exhausted: booleanValue(budget?.exhausted),
  });
  appendReport(lines, report, result.stdout);

  return lines.filter((line, index, arr) => {
    if (line !== '') return true;
    return arr[index - 1] !== '' && arr[index + 1] !== undefined;
  }).join('\n');
}

export function ultracodeAccepted(result: UltracodeRunResult): boolean {
  const json = asObject(result.resultJson) as { success?: unknown } | null;
  return result.exitCode === 0 && json?.success !== false;
}

function splitArgs(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (const ch of input.trim()) {
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/u.test(ch)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

function looksLikeFlag(value: string): boolean {
  return value.startsWith('--') && (VALUE_FLAGS.has(value) || BOOLEAN_FLAGS.has(value));
}

function setBooleanOption(
  options: ParsedUltracodePrompt['options'],
  flag: string,
): void {
  if (flag === '--resume') options.resume = true;
  if (flag === '--planner-only') options.plannerOnly = true;
  if (flag === '--trace') options.trace = true;
  if (flag === '--interactive') options.interactive = true;
}

function setValueOption(
  options: ParsedUltracodePrompt['options'],
  flag: string,
  value: string,
): void {
  if (flag === '--run-id') options.runId = value;
  if (flag === '--from-harness') options.fromHarness = value;
  if (flag === '--concurrency') options.concurrency = parsePositiveInt(value);
  if (flag === '--max-retries') options.maxRetries = parseNonNegativeInt(value);
  if (flag === '--max-agent-calls') options.maxAgentCalls = parsePositiveInt(value);
  if (flag === '--max-rounds') options.maxRounds = parsePositiveInt(value);
  if (flag === '--verify-command') options.verifyCommand = value;
  if (flag === '--timeout') options.timeoutSeconds = parsePositiveInt(value);
}

function parsePositiveInt(value: string): number | undefined {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseNonNegativeInt(value: string): number | undefined {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function appendBudget(
  lines: string[],
  specBudgetRaw: unknown,
  budgetRaw: Record<string, unknown> | null,
): void {
  const specBudget = asObject(specBudgetRaw);
  const maxAgentCalls =
    numberValue(budgetRaw?.maxAgentCalls) ?? numberValue(specBudget?.maxAgentCalls);
  const spentAgentCalls = numberValue(budgetRaw?.spentAgentCalls);
  const maxRounds = numberValue(specBudget?.maxRounds);
  const exhausted = booleanValue(budgetRaw?.exhausted);
  const pieces: string[] = [];
  if (spentAgentCalls !== undefined && maxAgentCalls !== undefined) {
    pieces.push(`agent calls ${spentAgentCalls}/${maxAgentCalls}`);
  } else if (maxAgentCalls !== undefined) {
    pieces.push(`agent calls max ${maxAgentCalls}`);
  }
  if (maxRounds !== undefined) pieces.push(`rounds max ${maxRounds}`);
  if (exhausted) pieces.push('已耗尽');
  if (pieces.length > 0) lines.push(`预算: ${pieces.join(' · ')}`);
}

function appendPlan(
  lines: string[],
  spec: Record<string, unknown> | null,
): void {
  const objective = stringValue(spec?.objective);
  const strategies = stringArray(spec?.strategies).slice(0, 4);
  const plan = arrayValue(spec?.plan).slice(0, 5) as PlanStepLike[];
  const workerGroups = arrayValue(spec?.workerGroups).slice(0, 5) as WorkerGroupLike[];
  if (!objective && strategies.length === 0 && plan.length === 0 && workerGroups.length === 0) {
    return;
  }
  lines.push('', '**计划**');
  if (objective) lines.push(`目标: ${clip(objective, 180)}`);
  if (strategies.length > 0) lines.push(`策略: ${strategies.join(', ')}`);
  for (const rawStep of plan) {
    const step = asObject(rawStep);
    const title = stringValue(step?.title) ?? stringValue(step?.id) ?? '未命名步骤';
    const kind = stringValue(step?.kind);
    lines.push(`- ${kind ? `${kind}: ` : ''}${clip(title, 90)}`);
  }
  if (plan.length === 0) {
    for (const rawGroup of workerGroups) {
      const group = asObject(rawGroup);
      const title = stringValue(group?.title) ?? stringValue(group?.id) ?? '未命名任务组';
      const deliverable = stringValue(group?.deliverable);
      lines.push(`- ${clip(title, 70)}${deliverable ? ` -> ${clip(deliverable, 80)}` : ''}`);
    }
  }
}

function appendLedger(
  lines: string[],
  ledger: Record<string, unknown> | null,
): void {
  const tasks = arrayValue(ledger?.tasks).slice(0, 6) as TaskLike[];
  if (tasks.length === 0) return;
  lines.push('', '**任务账本**');
  for (const rawTask of tasks) {
    const task = asObject(rawTask);
    const id = stringValue(task?.id);
    const title = stringValue(task?.title) ?? '未命名任务';
    const status = stringValue(task?.status) ?? 'unknown';
    const artifact = stringValue(task?.artifact);
    const gaps = stringArray(task?.gaps);
    lines.push(
      `- ${id ? `${id} ` : ''}${clip(title, 70)}: ${status}` +
        `${artifact ? ` · ${clip(artifact, 80)}` : ''}` +
        `${gaps.length > 0 ? ` · gaps ${gaps.length}` : ''}`,
    );
  }
}

function appendVerdict(
  lines: string[],
  verdict: Record<string, unknown> | null,
  gaps: unknown[],
): void {
  const coverage = arrayValue(verdict?.criteriaCoverage).slice(0, 6) as CoverageLike[];
  const evidence = stringArray(verdict?.evidence).slice(0, 5);
  if (!verdict && coverage.length === 0 && evidence.length === 0 && gaps.length === 0) {
    return;
  }
  lines.push('', '**验收门**');
  const pass = booleanValue(verdict?.pass);
  if (pass !== undefined) lines.push(`结论: ${pass ? 'pass' : 'fail'}`);
  for (const rawItem of coverage) {
    const item = asObject(rawItem);
    const criterion = stringValue(item?.criterion) ?? '未命名标准';
    const met = booleanValue(item?.met);
    const evidenceText = stringValue(item?.evidence);
    lines.push(
      `- ${met === true ? '✓' : met === false ? '✗' : '?'} ${clip(criterion, 80)}` +
        `${evidenceText ? ` · ${clip(evidenceText, 90)}` : ''}`,
    );
  }
  if (evidence.length > 0) lines.push(`证据: ${evidence.map((item) => clip(item, 80)).join('；')}`);
  if (gaps.length > 0) {
    lines.push('', '**未解决项/续跑建议**');
    for (const rawGap of gaps.slice(0, 5)) {
      const gap = asObject(rawGap);
      const severity = stringValue(gap?.severity);
      const reason = stringValue(gap?.reason) ?? '未说明原因';
      const nextAction = stringValue(gap?.nextAction);
      lines.push(
        `- ${severity ? `${severity}: ` : ''}${clip(reason, 100)}` +
          `${nextAction ? ` -> ${clip(nextAction, 100)}` : ''}`,
      );
    }
  }
}

function appendVerification(
  lines: string[],
  verification: Record<string, unknown> | null,
): void {
  if (!verification) return;
  const command = stringValue(verification.command);
  const passed = booleanValue(verification.passed);
  const exitCode = numberValue(verification.exitCode);
  const durationMs = numberValue(verification.durationMs);
  const error = stringValue(verification.error);
  const stdout = stringValue(verification.stdout);
  const stderr = stringValue(verification.stderr);
  lines.push('', '**验证命令**');
  if (command) lines.push(`命令: ${command}`);
  lines.push(
    `结论: ${passed ? 'pass' : 'fail'}${exitCode !== undefined ? ` · exitCode ${exitCode}` : ''}` +
      `${durationMs !== undefined ? ` · ${formatDuration(durationMs)}` : ''}`,
  );
  if (error) lines.push(`错误: ${clip(error, 180)}`);
  if (stdout) lines.push(`stdout: ${clip(stdout.replace(/\s+/g, ' ').trim(), 240)}`);
  if (stderr) lines.push(`stderr: ${clip(stderr.replace(/\s+/g, ' ').trim(), 240)}`);
}

function appendResumeAdvice(
  lines: string[],
  args: {
    accepted: boolean;
    gaps: unknown[];
    runId: string;
    objective?: string;
    maxAgentCalls?: number;
    exhausted?: boolean;
  },
): void {
  if (args.accepted) return;
  if (args.gaps.length === 0) lines.push('', '**未解决项/续跑建议**');
  const suggestedCalls = Math.max(
    12,
    Math.ceil((args.maxAgentCalls ?? 12) * (args.exhausted ? 1.5 : 1.25)),
  );
  const objective = args.objective ? ` ${clip(args.objective, 120)}` : '';
  lines.push(
    `建议续跑: /ultracode --resume --run-id ${args.runId} --max-agent-calls ${suggestedCalls}${objective}`,
  );
}

function appendReport(lines: string[], report: string, stdout: string): void {
  const fallback = stdout.trim();
  const text = report || fallback;
  if (!text) return;
  lines.push('', '**报告**', clip(text, 1800));
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringArray(value: unknown): string[] {
  return arrayValue(value)
    .map((item) => stringValue(item))
    .filter((item): item is string => Boolean(item));
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}
