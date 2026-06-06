/**
 * CONTRACT: per-node dispatch — agent/workflow/parallel/pipeline/consensus/log.
 *
 * Moved from store/useStore.ts (`runNode` / `runParallel` / `runPipeline` /
 * `runConsensus` / `resolveConsensus`). `ch: RunChannel` is replaced by
 * `context: RunContext` + `callbacks: RunCallbacks`; selection resolution and
 * speed clamps go through the injected gateway. Behaviour is identical to the
 * GUI's original implementation.
 */
import type { ConsensusStrategy, GatewaySelection, IRGraph, IRNode } from '../core/ir';
import {
  VOTE_DIVERGENCE_THRESHOLD,
  measureDivergence,
  nodeComplexitySignal,
  normalizeForBucket,
  scaleCount,
} from '../core/consensusHeuristic';
import { runWithConcurrency } from './concurrency';
import { runComposite } from './composite';
import { isExecTerminalNode } from './dag';
import { buildDataContextString, type ContextCaps, type ContextPolicy } from './context';
import { parseRunFailure } from './failure';
import { newSessionId, runAgentWithInteraction } from './gateway';
import {
  describeSchema,
  extractJson,
  resolveSchemaShape,
  validateAgainstSchema,
} from './schema';
import {
  clampSamples,
  consensusStrategy,
  runSpecGatewayOverride,
  specList,
} from './spec';
import type { RunCallbacks, RunContext, RunFailure, RunSpec } from './types';

/**
 * Build the `schema` opts object for {@link runAgentWithInteraction} from a
 * schema identifier + the workflow's `meta.schemaDefs`, or `undefined` when no
 * (resolvable) schema applies. The validate closure extracts JSON from the
 * model's output and checks it against the resolved shape; the normalized JSON
 * string becomes the node's downstream output on success.
 */
function buildSchemaEnforcement(
  schemaName: string | undefined,
  workflow: IRGraph,
):
  | {
      instruction: string;
      validate: (text: string) => { ok: boolean; problems: string[]; normalized?: string };
    }
  | undefined {
  if (typeof schemaName !== 'string' || !schemaName) return undefined;
  const resolved = resolveSchemaShape(schemaName, workflow.meta);
  if (!resolved) return undefined;
  const instruction = describeSchema(resolved.name, resolved.source);
  return {
    instruction,
    validate: (text: string) => {
      const extracted = extractJson(text);
      if (!extracted) {
        return { ok: false, problems: ['未在输出中找到 JSON'] };
      }
      const { ok, problems } = validateAgainstSchema(extracted.value, resolved.shape);
      return { ok, problems, normalized: extracted.json };
    },
  };
}

function withAgentTypeRole(prompt: string, agentType: string | undefined): string {
  const role = agentType?.trim();
  if (!role) return prompt;
  return [
    `你在本步骤中扮演运行时角色：${role}。`,
    '这是 FreeUltraCode 的角色约束，会影响你的职责、视角和验收重点；当前 CLI 路径不会把它映射为 Claude Code 原生 subagent。',
    '',
    prompt,
  ].join('\n');
}

function verdictPassed(text: string | undefined): boolean {
  if (!text) return false;
  const parsed = extractJson(text);
  return (
    !!parsed &&
    typeof parsed.value === 'object' &&
    parsed.value !== null &&
    !Array.isArray(parsed.value) &&
    (parsed.value as { pass?: unknown }).pass === true
  );
}

/**
 * Tri-state read of a candidate's `pass` field: `true` / `false` when the
 * candidate parses to a verdict object carrying an explicit boolean, or `null`
 * when the candidate is not a verdict (no parseable `pass`). Used by the
 * machine-level veto so non-verdict candidates (plain artifacts) don't count as
 * votes either way.
 */
function verdictVote(text: string): boolean | null {
  const parsed = extractJson(text);
  if (
    !parsed ||
    typeof parsed.value !== 'object' ||
    parsed.value === null ||
    Array.isArray(parsed.value)
  ) {
    return null;
  }
  const pass = (parsed.value as { pass?: unknown }).pass;
  return typeof pass === 'boolean' ? pass : null;
}

/**
 * Machine-level veto for verdict-style consensus (the acceptance gate).
 *
 * When the candidates are structured verdicts (each carrying a boolean `pass`),
 * count the explicit votes. If the number of `pass: false` votes reaches the
 * quorum, the gate FAILS deterministically — a single downstream synthesis agent
 * must not be able to overturn a quorum of skeptics. Returns a forced fail
 * verdict (a real DYNAMIC_VERDICT-shaped object) in that case, otherwise `null`
 * to let normal synthesis proceed. Non-verdict candidates are ignored; if fewer
 * than 2 real votes exist there is nothing to veto.
 */
function machineVetoVerdict(candidates: string[], quorum: number): string | null {
  const votes = candidates.map(verdictVote).filter((v): v is boolean => v !== null);
  if (votes.length < 2) return null;
  const against = votes.filter((v) => v === false).length;
  if (against < quorum) return null;
  // Carry the rejecting verdicts' gaps/coverage forward so the report is useful.
  const merged = mergeRejectingVerdicts(candidates);
  return JSON.stringify({
    pass: false,
    acceptedArtifact: '',
    evidence: merged.evidence,
    criteriaCoverage: merged.criteriaCoverage,
    gaps:
      merged.gaps.length > 0
        ? merged.gaps
        : [
            {
              taskId: 'gate',
              severity: 'P1',
              reason: `机器级否决：${against}/${votes.length} 票判定未通过，达到否决阈值 ${quorum}。`,
              nextAction: '修复反对票列出的 gaps 后重新验收。',
            },
          ],
  });
}

/** Merge evidence/coverage/gaps from all candidates that voted fail. */
function mergeRejectingVerdicts(candidates: string[]): {
  evidence: string[];
  criteriaCoverage: unknown[];
  gaps: unknown[];
} {
  const evidence: string[] = [];
  const criteriaCoverage: unknown[] = [];
  const gaps: unknown[] = [];
  for (const c of candidates) {
    if (verdictVote(c) !== false) continue;
    const parsed = extractJson(c);
    const v = parsed?.value as
      | { evidence?: unknown; criteriaCoverage?: unknown; gaps?: unknown }
      | undefined;
    if (!v) continue;
    if (Array.isArray(v.evidence)) {
      for (const e of v.evidence) if (typeof e === 'string') evidence.push(e);
    }
    if (Array.isArray(v.criteriaCoverage)) criteriaCoverage.push(...v.criteriaCoverage);
    if (Array.isArray(v.gaps)) gaps.push(...v.gaps);
  }
  return { evidence, criteriaCoverage, gaps };
}

function maybeSkipAfterPassedVerdict(node: IRNode, results: Map<string, string>): string | null {
  const source =
    typeof node.params.skipIfVerdictPassFrom === 'string'
      ? node.params.skipIfVerdictPassFrom
      : '';
  if (!source || !verdictPassed(results.get(source))) return null;
  const outputFrom =
    typeof node.params.skipOutputFrom === 'string' ? node.params.skipOutputFrom : '';
  if (outputFrom && results.has(outputFrom)) return results.get(outputFrom) ?? '';
  return typeof node.params.skipOutput === 'string' ? node.params.skipOutput : '';
}

/** The run's default gateway selection (already resolved in the context). */
function globalSelection(context: RunContext): GatewaySelection {
  return context.selection;
}

/**
 * Upstream-context caps for a node. Reads the optional `contextPolicy` param and
 * defaults to 'full' (byte-identical legacy output → zero behaviour change unless
 * the user explicitly opts into truncation). Truncation only engages for 'tail'.
 */
function contextCaps(node: IRNode): ContextCaps {
  const policy: ContextPolicy =
    node.params.contextPolicy === 'tail' ? 'tail' : 'full';
  return { policy };
}

/**
 * When a linear Claude CLI chain is resumed through one warm session, outputs
 * from earlier nodes in the same chain are already in the conversation history.
 * Do not paste those same data-edge payloads into every successor prompt again.
 * Direct-HTTP routes do not have session continuity, so they keep the full data
 * context.
 */
function chainAwareContextCaps(
  context: RunContext,
  node: IRNode,
  selection: GatewaySelection,
): ContextCaps {
  const caps = contextCaps(node);
  const chain = context.agentChains?.get(node.id);
  if (!chain || chain.isFirst) return caps;
  if (context.gateway.resolveDirectRoute(selection)) return caps;

  const skipSourceNodes = new Set<string>();
  for (const [sourceId, membership] of context.agentChains ?? []) {
    if (sourceId !== node.id && membership.sessionId === chain.sessionId) {
      skipSourceNodes.add(sourceId);
    }
  }
  return skipSourceNodes.size > 0 ? { ...caps, skipSourceNodes } : caps;
}

/** Per-node selection: global selection + the node's own gateway override. */
function nodeSelection(
  context: RunContext,
  node: IRNode,
): GatewaySelection {
  return context.gateway.applyOverride(
    globalSelection(context),
    context.gateway.nodeGatewayOverride(node.params) ?? undefined,
  );
}

/**
 * Run a `parallel` node: each branch is its own concurrent agent call (real
 * fan-out). All branches share the node's upstream data context. Throws only if
 * every branch fails.
 */
export async function runParallel(
  context: RunContext,
  callbacks: RunCallbacks,
  node: IRNode,
  workflow: IRGraph,
  results: Map<string, string>,
): Promise<string> {
  const branches = specList(node.params.branches, context.gateway);
  if (branches.length === 0) return '';
  const upstream = buildDataContextString(node, workflow, results, contextCaps(node));
  const baseSelection = nodeSelection(context, node);

  const settled = await runWithConcurrency(
    branches,
    Math.min(
      branches.length,
      context.gateway.effectiveConcurrency(context.concurrency, baseSelection),
    ),
    async (b, i) => {
      const label = b.label || b.agentType || b.prompt.slice(0, 16) || `分支${i + 1}`;
      const stepLabel = `并行分支 ${i + 1}/${branches.length} · ${label}`;
      const branchSelection = context.gateway.applyOverride(
        baseSelection,
        runSpecGatewayOverride(b, context.gateway),
      );
      try {
        const out = (
          await runAgentWithInteraction({
            context,
            callbacks,
            head: `【${stepLabel}】\n`,
            label: stepLabel,
            basePrompt: withAgentTypeRole(b.prompt, b.agentType) + upstream,
            selection: branchSelection,
            cli: { cwd: context.cwd, permission: context.permission },
            schema: buildSchemaEnforcement(b.schema, workflow),
          })
        ).trim();
        return { ok: true as const, label, out };
      } catch (err) {
        const failure = parseRunFailure(err);
        return { ok: false as const, label, out: '', failure };
      }
    },
  );

  if (settled.every((s) => !s.ok)) {
    const detail = settled
      .map((s) => (s.ok ? '' : `${s.label}: ${s.failure.message}`))
      .filter(Boolean)
      .join('；');
    throw new Error(detail ? `所有并行分支均失败：${detail}` : '所有并行分支均失败');
  }
  const okParts = settled
    .filter((s): s is { ok: true; label: string; out: string } => s.ok)
    .map((s) => ({ label: s.label, out: s.out }));
  const reduced = await reduceFanOutResults(context, callbacks, node, okParts);
  if (reduced !== null) return reduced;
  return settled
    .map((s) =>
      s.ok ? `【${s.label}】\n${s.out}` : `【${s.label}】\n(失败：${s.failure.message})`,
    )
    .join('\n\n');
}

/**
 * Optional map-reduce for fan-out nodes. When a node sets a positive
 * `reduceWhenOver` param AND the number of successful branch/item outputs
 * exceeds it, run ONE reducing agent that compresses the N results into a
 * compact structured digest (one line per item: id + status + key evidence +
 * gap) before the joined blob flows downstream to the acceptance gate. This
 * keeps a wide fan-out (e.g. 20 audited files) from dumping an over-long context
 * into the gate. Returns the digest string, or `null` to skip reduction (param
 * absent, threshold not exceeded, or too few outputs to be worth it). The
 * reducing call goes through the gateway, so it is budget-charged like any agent.
 */
async function reduceFanOutResults(
  context: RunContext,
  callbacks: RunCallbacks,
  node: IRNode,
  parts: { label: string; out: string }[],
): Promise<string | null> {
  const threshold =
    typeof node.params.reduceWhenOver === 'number' && node.params.reduceWhenOver > 0
      ? Math.floor(node.params.reduceWhenOver)
      : 0;
  if (threshold <= 0 || parts.length <= threshold || parts.length < 2) return null;
  if (callbacks.isCancelled()) return null;

  const block = parts
    .map((p, i) => `【${i + 1}. ${p.label}】\n${p.out}`)
    .join('\n\n');
  const label = `${node.label ?? 'fan-out'} · 归约摘要`;
  const prompt = [
    `下面是 ${parts.length} 个并行/逐项产出的结果。请把它们归约成一份紧凑的结构化摘要，供后续验收使用。`,
    '要求：每个条目一行，包含 条目标识、状态(完成/部分/失败)、关键证据(路径/命令/来源)、遗留 gap；',
    '不要逐字复制原文，不要新增结论，无法判定的写「待核」。最后用一两句话概述整体完成度与主要风险。',
    '',
    block,
  ].join('\n');
  try {
    return (
      await runAgentWithInteraction({
        context,
        callbacks,
        head: `【${label}】\n`,
        label,
        basePrompt: prompt,
        selection: nodeSelection(context, node),
        cli: { cwd: context.cwd, permission: context.permission },
      })
    ).trim();
  } catch {
    // A failed reduction must not drop the underlying results.
    return null;
  }
}

/**
 * Parse a pipeline node's `items` param into a non-empty list of per-item input
 * strings, or return `null` when it is not a JSON array (scalar / identifier /
 * empty ⇒ legacy single-pass). Object/array elements are stringified; primitive
 * elements are coerced to strings. This is the *fan-out* trigger: a JSON array
 * runs each element independently through all stages (Claude Code's
 * `pipeline(items, …)` semantics — per-file/per-unit migration & audit), while
 * any other shape keeps the original single chained pass byte-for-byte.
 *
 * NOTE (scope): only the headless `/ultracode` path (raw IRGraph JSON, no
 * emit/parse) reaches this. The emitter/parser deliberately are NOT taught to
 * round-trip a JSON-array `items` literal (the parser already treats a bare
 * array argument as legacy *stages*), so this stays a runtime interpretation.
 */
/**
 * Hard ceiling on pipeline fan-out width. A planner that emits a huge `items`
 * array could otherwise queue thousands of agent runs and burn the whole budget
 * on one runaway node. Items beyond this are dropped with a `log()` notice (per
 * CLAUDE.md: bounded coverage must never be silent). Mirrors the `slice` guard
 * that already caps `parallel` branches in dynamicHarness.
 */
const MAX_FAN_OUT_ITEMS = 64;

function pipelineFanOutItems(raw: string): { items: string[]; dropped: number } | null {
  if (!raw || (raw[0] !== '[' && !raw.startsWith('['))) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const all = parsed.map((el) =>
    typeof el === 'string' ? el : el === null || el === undefined ? '' : JSON.stringify(el),
  );
  const dropped = Math.max(0, all.length - MAX_FAN_OUT_ITEMS);
  return { items: dropped > 0 ? all.slice(0, MAX_FAN_OUT_ITEMS) : all, dropped };
}

/** Truncate a per-item label so fan-out progress lines stay readable. */
function shortItemLabel(item: string): string {
  const flat = item.replace(/\s+/g, ' ').trim();
  return flat.length > 24 ? `${flat.slice(0, 24)}…` : flat || '空条目';
}

/**
 * Run one chain of stages over a single seed input (the `stage0Feed`). Each
 * stage receives the previous stage's output; the first receives `stage0Feed`.
 * A fresh warm session is used per chain (Claude adapter) so concurrent fan-out
 * items never share conversation state. Returns the final stage's output.
 */
async function runPipelineChain(
  context: RunContext,
  callbacks: RunCallbacks,
  workflow: IRGraph,
  stages: RunSpec[],
  baseSelection: GatewaySelection,
  stage0Feed: string,
  labelPrefix: string,
): Promise<string> {
  const isClaude =
    baseSelection.adapter === 'claude-code' || baseSelection.adapter === 'claude';
  const sessionId = isClaude ? newSessionId() : undefined;
  let prev = '';
  for (let i = 0; i < stages.length; i += 1) {
    if (callbacks.isCancelled()) break;
    const s = stages[i];
    const label = s.label || s.prompt.slice(0, 16) || `阶段${i + 1}`;
    const stepLabel = `${labelPrefix}流水线阶段 ${i + 1}/${stages.length} · ${label}`;
    const feed = i === 0 ? stage0Feed : `\n\n---\n上一步输出：\n${prev}`;
    const stageSelection = context.gateway.applyOverride(
      baseSelection,
      runSpecGatewayOverride(s, context.gateway),
    );
    prev = (
      await runAgentWithInteraction({
        context,
        callbacks,
        head: `【${stepLabel}】\n`,
        label: stepLabel,
        basePrompt: withAgentTypeRole(s.prompt, s.agentType) + feed,
        selection: stageSelection,
        cli: {
          omitModel: !!(sessionId && i > 0),
          cwd: context.cwd,
          permission: context.permission,
        },
        session: sessionId ? { id: sessionId, resume: i > 0 } : undefined,
        schema: buildSchemaEnforcement(s.schema, workflow),
      })
    ).trim();
  }
  return prev;
}

/**
 * Run a `pipeline` node. When `items` is a JSON array, each element is fanned
 * out concurrently through all stages (per-item chains, bounded by the node's
 * effective concurrency) and the per-item finals are joined — like a `parallel`
 * of chains. Otherwise stages execute as a single sequential chain seeded by the
 * upstream data context (legacy behaviour, byte-identical).
 */
export async function runPipeline(
  context: RunContext,
  callbacks: RunCallbacks,
  node: IRNode,
  workflow: IRGraph,
  results: Map<string, string>,
): Promise<string> {
  const stages = specList(node.params.stages, context.gateway);
  if (stages.length === 0) return '';
  const itemsRaw = String(node.params.items ?? '').trim();
  const baseSelection = nodeSelection(context, node);
  const upstream = buildDataContextString(node, workflow, results, contextCaps(node));

  const fanOut = pipelineFanOutItems(itemsRaw);
  if (fanOut) {
    if (fanOut.dropped > 0) {
      callbacks.onLog(
        `流水线 fan-out 条目超过上限 ${MAX_FAN_OUT_ITEMS}，已丢弃后 ${fanOut.dropped} 条（仅处理前 ${MAX_FAN_OUT_ITEMS} 条）。`,
        'system',
      );
    }
    const fanItems = fanOut.items;
    const total = fanItems.length;
    const settled = await runWithConcurrency(
      fanItems,
      Math.min(total, context.gateway.effectiveConcurrency(context.concurrency, baseSelection)),
      async (item, i) => {
        const prefix = `条目 ${i + 1}/${total} · `;
        const stage0Feed = `${upstream}\n\n当前条目 (${i + 1}/${total}): ${item}`;
        try {
          const out = await runPipelineChain(
            context,
            callbacks,
            workflow,
            stages,
            baseSelection,
            stage0Feed,
            prefix,
          );
          return { ok: true as const, item, out };
        } catch (err) {
          return { ok: false as const, item, out: '', failure: parseRunFailure(err) };
        }
      },
    );

    if (settled.every((s) => !s.ok)) {
      const detail = settled
        .map((s) => (s.ok ? '' : `${shortItemLabel(s.item)}: ${s.failure.message}`))
        .filter(Boolean)
        .join('；');
      throw new Error(detail ? `所有流水线条目均失败：${detail}` : '所有流水线条目均失败');
    }
    const okParts = settled
      .map((s, i) =>
        s.ok ? { label: `条目 ${i + 1}/${total}: ${shortItemLabel(s.item)}`, out: s.out } : null,
      )
      .filter((p): p is { label: string; out: string } => p !== null);
    const reduced = await reduceFanOutResults(context, callbacks, node, okParts);
    if (reduced !== null) return reduced;
    return settled
      .map((s, i) =>
        s.ok
          ? `【条目 ${i + 1}/${total}: ${shortItemLabel(s.item)}】\n${s.out}`
          : `【条目 ${i + 1}/${total}: ${shortItemLabel(s.item)}】\n(失败：${s.failure.message})`,
      )
      .join('\n\n');
  }

  const stage0Feed = upstream + (itemsRaw ? `\n\n输入数据: ${itemsRaw}` : '');
  return runPipelineChain(
    context,
    callbacks,
    workflow,
    stages,
    baseSelection,
    stage0Feed,
    '',
  );
}

type ConsensusSample =
  | { ok: true; label: string; out: string }
  | { ok: false; label: string; out: ''; failure?: RunFailure };

/**
 * Run a `consensus` node: fan out N voters over the SAME target, then
 * cross-validate + vote per strategy. Throws only when too few samples succeed
 * to vote, so node-level auto-retry keeps working.
 */
export async function runConsensus(
  context: RunContext,
  callbacks: RunCallbacks,
  node: IRNode,
  workflow: IRGraph,
  results: Map<string, string>,
): Promise<string> {
  const voters = specList(node.params.voters, context.gateway);
  if (voters.length === 0) return '';
  const strategy = consensusStrategy(node.params.strategy);
  const upstream = buildDataContextString(node, workflow, results, contextCaps(node));
  const baseSelection = nodeSelection(context, node);

  const samples =
    strategy === 'self-consistency'
      ? Array.from(
          {
            length: context.gateway.effectiveConsensusSamples(
              clampSamples(node.params.samples, context.consensusSamples),
              baseSelection,
            ),
          },
          () => voters[0],
        )
      : voters;
  const total = samples.length;
  const quorum =
    typeof node.params.quorum === 'number' && node.params.quorum > 0
      ? node.params.quorum
      : Math.ceil(total / 2);

  const settled = await runWithConcurrency<RunSpec, ConsensusSample>(
    samples,
    Math.min(
      total,
      context.gateway.effectiveConcurrency(context.concurrency, baseSelection),
    ),
    async (s, i) => {
      if (callbacks.isCancelled()) return { ok: false, label: `样本${i + 1}`, out: '' };
      const label = s.label || s.agentType || s.prompt.slice(0, 16) || `样本${i + 1}`;
      const stepLabel = `共识样本 ${i + 1}/${total} · ${label}`;
      const sampleSelection = context.gateway.applyOverride(
        baseSelection,
        runSpecGatewayOverride(s, context.gateway),
      );
      try {
        const out = (
          await runAgentWithInteraction({
            context,
            callbacks,
            head: `【${stepLabel}】\n`,
            label: stepLabel,
            basePrompt: withAgentTypeRole(s.prompt, s.agentType) + upstream,
            selection: sampleSelection,
            cli: { cwd: context.cwd, permission: context.permission },
            schema: buildSchemaEnforcement(s.schema, workflow),
          })
        ).trim();
        return { ok: true, label, out };
      } catch (err) {
        return { ok: false, label, out: '', failure: parseRunFailure(err) };
      }
    },
  );

  const oks = settled.filter(
    (s): s is { ok: true; label: string; out: string } => s.ok && !!s.out,
  );
  if (oks.length < 2) {
    if (oks.length === 1) return oks[0].out;
    const detail = settled
      .map((s) => (s.ok ? '' : `${s.label}: ${s.failure?.message ?? '无输出'}`))
      .filter(Boolean)
      .join('；');
    throw new Error(
      detail ? `共识失败：可用样本不足以投票（${detail}）` : '共识失败：可用样本不足以投票',
    );
  }
  if (callbacks.isCancelled()) return oks[0].out;

  return resolveConsensus(
    context,
    callbacks,
    node,
    workflow,
    oks.map((s) => s.out),
    strategy,
    quorum,
    baseSelection,
  );
}

/** Cross-validate the candidate outputs and return the consensus answer. */
export async function resolveConsensus(
  context: RunContext,
  callbacks: RunCallbacks,
  node: IRNode,
  workflow: IRGraph,
  candidates: string[],
  strategy: ConsensusStrategy,
  quorum: number,
  baseSelection: GatewaySelection,
): Promise<string> {
  if (strategy === 'self-consistency') {
    const buckets = new Map<string, { rep: string; n: number }>();
    for (const c of candidates) {
      const key = normalizeForBucket(c);
      const b = buckets.get(key);
      if (b) b.n += 1;
      else buckets.set(key, { rep: c, n: 1 });
    }
    let best = { rep: candidates[0], n: 0 };
    for (const b of buckets.values()) if (b.n > best.n) best = b;
    callbacks.onLog(
      `共识(自一致投票)：最高一致 ${best.n}/${candidates.length}`,
      'system',
    );
    if (best.n >= quorum) return best.rep;
  }

  // Machine-level veto for verdict-style gates (adversarial / multi-lens): if a
  // quorum of voters explicitly returned `pass: false`, fail deterministically
  // rather than letting the downstream synthesis agent overturn the skeptics.
  if (strategy === 'adversarial' || strategy === 'multi-lens') {
    const veto = machineVetoVerdict(candidates, quorum);
    if (veto) {
      callbacks.onLog(
        `共识(机器级否决)：反对票达到否决阈值 ${quorum}，验收门直接判定未通过。`,
        'system',
      );
      return veto;
    }
  }

  const instruction =
    strategy === 'adversarial'
      ? '下面是多个独立得出的结论。请逐条尝试证伪，丢弃站不住脚的，只综合那些扛住反驳的结论，给出最终答案。'
      : strategy === 'tournament'
        ? '下面是多个独立方案。请按质量择优选出最佳方案，并把其它方案中值得借鉴的亮点合并进去，输出最终方案。'
        : '下面是多个独立角度对同一目标的判定。请按多数意见综合，给出最可信的最终结论，并简述理由。';
  const block = candidates.map((c, i) => `【候选 ${i + 1}】\n${c}`).join('\n\n');
  const label = `${node.label ?? '共识'} · 评审/投票`;
  return (
    await runAgentWithInteraction({
      context,
      callbacks,
      head: `【${label}】\n`,
      label,
      basePrompt: `${instruction}\n\n${block}`,
      selection: baseSelection,
      cli: { cwd: context.cwd, permission: context.permission },
      schema: buildSchemaEnforcement(
        typeof node.params.schema === 'string' ? node.params.schema : undefined,
        workflow,
      ),
    })
  ).trim();
}

/**
 * Cheap pre-gate for run-time verify+vote (Features 3 & 4). When BOTH ceilings
 * are <= 1 (every headless caller that omits them) this is false, so
 * dispatchNode skips ALL the extra per-node work below — no terminal detection,
 * no complexity scan, no fan-out — and behaves byte-for-byte as a single call.
 * The GUI passes max=16 by default, opting in.
 */
function runtimeVoteEnabled(context: RunContext): boolean {
  return (context.runtimeVoteSamplesMax ?? 1) > 1 || (context.terminalVoteSamplesMax ?? 1) > 1;
}

/**
 * Terminal node = tail of the exec spine (no real downstream work), OR a node
 * that reads like a self-test / summary / validation / review step AND sits
 * near the tail. Delegates to the shared {@link isExecTerminalNode} so the
 * run engine and the GUI marker classify terminals identically.
 */
function isTerminalNode(node: IRNode, workflow: IRGraph): boolean {
  return isExecTerminalNode(node, workflow);
}

/**
 * Effective (min,max) run-time vote range for a node: pick the terminal vs.
 * complex category knobs, scale the STARTING count by the node's complexity
 * signal (within the ceiling), and clamp min<=max. A max<=1 short-circuits to
 * {1,1} (voting off), so each category respects its own knob independently.
 */
function effectiveRuntimeSamples(
  context: RunContext,
  node: IRNode,
  workflow: IRGraph,
): { min: number; max: number } {
  const terminal = isTerminalNode(node, workflow);
  const max = terminal
    ? context.terminalVoteSamplesMax ?? 1
    : context.runtimeVoteSamplesMax ?? 1;
  if (max <= 1) return { min: 1, max: 1 };
  const baseMin = terminal
    ? context.terminalVoteSamplesMin ?? 2
    : context.runtimeVoteSamplesMin ?? 2;
  // Scale the starting count up by complexity, but never above the ceiling.
  const min = Math.min(
    max,
    scaleCount(baseMin, nodeComplexitySignal(node, workflow), context.complexityScaling ?? 1, max),
  );
  return { min: Math.max(2, min), max };
}

/** A single fanned-out sample (success carries its output; failure carries the reason). */
async function runSampleBatch(
  context: RunContext,
  callbacks: RunCallbacks,
  label: string,
  prompt: string,
  selection: GatewaySelection,
  schema: ReturnType<typeof buildSchemaEnforcement>,
  delta: number,
  offset: number,
  total: number,
): Promise<ConsensusSample[]> {
  return runWithConcurrency<number, ConsensusSample>(
    Array.from({ length: delta }, (_, i) => i),
    Math.min(delta, context.gateway.effectiveConcurrency(context.concurrency, selection)),
    async (_v, i) => {
      const idx = offset + i + 1;
      if (callbacks.isCancelled()) return { ok: false, label: `样本${idx}`, out: '' };
      const stepLabel = `${label} · 验证样本 ${idx}/${total}`;
      try {
        const out = (
          await runAgentWithInteraction({
            context,
            callbacks,
            head: `【${stepLabel}】\n`,
            label: stepLabel,
            basePrompt: prompt,
            selection,
            cli: { cwd: context.cwd, permission: context.permission },
            schema,
          })
        ).trim();
        return { ok: true, label: stepLabel, out };
      } catch (err) {
        return { ok: false, label: stepLabel, out: '', failure: parseRunFailure(err) };
      }
    },
  );
}

/**
 * Judge-scored disagreement over a pool of outputs, in [0,1] (no schema ⇒ prose,
 * where string-bucketing is useless). One model call asks for a single
 * `disagreement: 0..1` line. Falls back to the cheap structured measure on any
 * parse failure so the loop always has a signal. Returns the structured
 * (no-model) measure directly when a schema is present (JSON field compare is
 * both cheaper and more accurate than asking the judge).
 */
async function measurePoolDivergence(
  context: RunContext,
  callbacks: RunCallbacks,
  label: string,
  outputs: string[],
  selection: GatewaySelection,
  hasSchema: boolean,
): Promise<number> {
  if (outputs.length < 2) return 0;
  if (hasSchema) return measureDivergence(outputs);
  if (callbacks.isCancelled()) return 0;
  const block = outputs.map((c, i) => `【输出 ${i + 1}】\n${c}`).join('\n\n');
  try {
    const reply = await runAgentWithInteraction({
      context,
      callbacks,
      head: `【${label} · 评估分歧】\n`,
      label: `${label} · 评估分歧`,
      basePrompt:
        `下面是针对同一问题的多份独立回答。请只评估它们在“最终结论”上的分歧程度，` +
        `用一行输出：disagreement: <0到1之间的小数>（0=完全一致，1=完全不一致）。不要解释。\n\n${block}`,
      selection,
      cli: { cwd: context.cwd, permission: context.permission },
    });
    const m = reply.match(/disagreement\s*[:：]\s*(0(?:\.\d+)?|1(?:\.0+)?)/i);
    if (m) return Math.max(0, Math.min(1, Number.parseFloat(m[1])));
  } catch {
    /* fall back to the cheap measure */
  }
  return measureDivergence(outputs);
}

/**
 * Divergence-driven ADAPTIVE escalation. Runs `min` samples over the SAME
 * prompt, measures disagreement, and while it stays above the threshold (and
 * the run-level escalation budget allows) DOUBLES the count (min→…→max, reusing
 * prior samples — only the delta is run each round) until it converges or hits
 * the ceiling. Then votes ONCE over the accumulated pool via the shared
 * {@link resolveConsensus} (voting is never reimplemented). Degrades gracefully:
 * a pool with < 2 usable samples returns the single output.
 *
 * Doubling is bounded purely by `pool reaches max` — `target = min(max, oks*2)`
 * strictly increases the successful pool until it hits the ceiling, so no
 * separate iteration cap is needed. `delta`/doubling are driven off SUCCESSFUL
 * samples (`oks`), so one flaky sample never disables voting (it just gets
 * topped up next round).
 */
async function runAgentVoted(
  context: RunContext,
  callbacks: RunCallbacks,
  node: IRNode,
  workflow: IRGraph,
  label: string,
  prompt: string,
  selection: GatewaySelection,
  min: number,
  max: number,
): Promise<string> {
  const schema = buildSchemaEnforcement(
    typeof node.params.schema === 'string' ? node.params.schema : undefined,
    workflow,
  );
  // Master switch OFF ⇒ run the starting count and vote once, never escalate.
  const ceiling = context.adaptiveEscalation === false ? Math.max(2, Math.min(min, max)) : max;
  const pool: ConsensusSample[] = [];
  let target = Math.max(2, Math.min(min, ceiling));
  let div = 0;
  // Run-level budget: extra samples beyond the first across the whole run.
  const budgetLeft = () =>
    context.escalationBudget == null
      ? Number.POSITIVE_INFINITY
      : Math.max(0, context.escalationBudget - (context.escalationSpent ?? 0));

  for (;;) {
    const okCount = pool.filter((s) => s.ok && s.out).length;
    let delta = target - okCount;
    // The first batch (okCount 0) is not "escalation"; only extra rounds spend budget.
    if (okCount > 0) {
      const allowed = Math.floor(budgetLeft());
      if (allowed <= 0) break;
      delta = Math.min(delta, allowed);
    }
    if (delta <= 0) break;
    const batch = await runSampleBatch(
      context,
      callbacks,
      label,
      prompt,
      selection,
      schema,
      delta,
      pool.length,
      target,
    );
    pool.push(...batch);
    if (okCount > 0 && context.escalationBudget != null) {
      context.escalationSpent = (context.escalationSpent ?? 0) + batch.filter((s) => s.ok).length;
    }
    const oks = pool.filter((s) => s.ok && s.out);
    if (callbacks.isCancelled()) {
      if (oks.length < 2) return oks[0]?.out ?? '';
      break;
    }
    if (oks.length >= ceiling) break; // ceiling reached
    if (oks.length < 2) {
      // Couldn't measure yet; if we can still grow toward the ceiling, top up.
      if (oks.length === pool.length || budgetLeft() <= 0) return oks[0]?.out ?? '';
      target = Math.min(ceiling, Math.max(target, oks.length + 1, 2));
      continue;
    }
    div = await measurePoolDivergence(
      context,
      callbacks,
      label,
      oks.map((s) => s.out),
      selection,
      !!schema,
    );
    if (div <= VOTE_DIVERGENCE_THRESHOLD) break; // converged
    if (callbacks.isCancelled()) break;
    target = Math.min(ceiling, oks.length * 2); // ESCALATE: double, reuse prior samples
    if (target <= oks.length) break; // can't grow (already at ceiling)
  }

  const oks = pool.filter(
    (s): s is { ok: true; label: string; out: string } => s.ok && !!s.out,
  );
  if (oks.length < 2) return oks[0]?.out ?? '';
  callbacks.onLog(
    `${label} · 对抗校验：${oks.length} 个样本可用（分歧 ${div.toFixed(2)}），开始投票`,
    'system',
  );
  return resolveConsensus(
    context,
    callbacks,
    node,
    workflow,
    oks.map((s) => s.out),
    'adversarial',
    Math.ceil(oks.length / 2),
    selection,
  );
}

/**
 * Execute one node, returning its result string (stored for downstream data
 * edges), or null when there is nothing to run (control / log / variable /
 * codeblock). Throws on hard error.
 */
export async function dispatchNode(
  context: RunContext,
  callbacks: RunCallbacks,
  node: IRNode,
  workflow: IRGraph,
  results: Map<string, string>,
): Promise<string | null> {
  const skipped = maybeSkipAfterPassedVerdict(node, results);
  if (skipped !== null) {
    callbacks.onLog(`${node.label ?? node.type} · 上一轮验收已通过，跳过本轮返工。`, 'system');
    return skipped;
  }
  const label = node.label ?? node.type;
  const selection = nodeSelection(context, node);
  switch (node.type) {
    case 'agent': {
      const base = String(node.params.prompt ?? node.label ?? '').trim();
      if (!base) return '';
      const rolePrompt = withAgentTypeRole(
        base,
        typeof node.params.agentType === 'string' ? node.params.agentType : undefined,
      );
      // If this node belongs to a linear claude agent chain (Fix 1), reuse the
      // chain's warm session — exactly mirroring runPipeline's stage handling.
      const chain = context.agentChains?.get(node.id);
      const prompt =
        rolePrompt + buildDataContextString(
          node,
          workflow,
          results,
          chainAwareContextCaps(context, node, selection),
        );
      // FEATURES 3 & 4 — run-time adversarial verify+vote for complex / terminal
      // nodes. Pre-gated so the default (both knobs = 1, and all headless
      // callers) skips this entirely. Mutually exclusive with warm-session
      // chains (a shared session must not be fanned out concurrently).
      if (!chain && runtimeVoteEnabled(context)) {
        const { min, max } = effectiveRuntimeSamples(context, node, workflow);
        if (max > 1) {
          return runAgentVoted(context, callbacks, node, workflow, label, prompt, selection, min, max);
        }
      }
      return runAgentWithInteraction({
        context,
        callbacks,
        head: `【${label}】\n`,
        label,
        basePrompt: prompt,
        selection,
        cli: {
          omitModel: chain ? !chain.isFirst : undefined,
          cwd: context.cwd,
          permission: context.permission,
        },
        session: chain ? { id: chain.sessionId, resume: !chain.isFirst } : undefined,
        schema: buildSchemaEnforcement(
          typeof node.params.schema === 'string' ? node.params.schema : undefined,
          workflow,
        ),
      });
    }
    case 'workflow': {
      const base = `运行子工作流 "${String(node.params.name ?? node.label ?? 'sub')}" 并返回结果。`;
      const chain = context.agentChains?.get(node.id);
      const prompt =
        base + buildDataContextString(
          node,
          workflow,
          results,
          chainAwareContextCaps(context, node, selection),
        );
      if (!chain && runtimeVoteEnabled(context)) {
        const { min, max } = effectiveRuntimeSamples(context, node, workflow);
        if (max > 1) {
          return runAgentVoted(context, callbacks, node, workflow, label, prompt, selection, min, max);
        }
      }
      return runAgentWithInteraction({
        context,
        callbacks,
        head: `【${label}】\n`,
        label,
        basePrompt: prompt,
        selection,
        cli: {
          omitModel: chain ? !chain.isFirst : undefined,
          cwd: context.cwd,
          permission: context.permission,
        },
        session: chain ? { id: chain.sessionId, resume: !chain.isFirst } : undefined,
        schema: buildSchemaEnforcement(
          typeof node.params.schema === 'string' ? node.params.schema : undefined,
          workflow,
        ),
      });
    }
    case 'parallel':
      return runParallel(context, callbacks, node, workflow, results);
    case 'pipeline':
      return runPipeline(context, callbacks, node, workflow, results);
    case 'consensus':
      return runConsensus(context, callbacks, node, workflow, results);
    case 'composite':
      return runComposite(context, callbacks, node, workflow, results);
    case 'log': {
      const msg = String(node.params.message ?? node.params.msg ?? '').trim();
      if (msg) callbacks.onLog(msg, 'system');
      return null;
    }
    default:
      return null; // start/end/branch/loop/variable/codeblock
  }
}
