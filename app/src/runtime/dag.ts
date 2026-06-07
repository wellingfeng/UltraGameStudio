/**
 * CONTRACT: the headless DAG run engine.
 *
 * `getRunnableNodes` / `buildDependencyGraph` are the pure graph helpers (moved
 * from store/useStore.ts `runnableOrder` / `buildRunDependencies`).
 * `executeWorkflowDag` is the bounded-concurrency pump + per-node auto-retry
 * loop (moved from `executeViaCliInterpreter`), with every UI/Tauri side effect
 * routed through the injected {@link RunCallbacks}. The pump/pickReady algorithm
 * and the retry/back-off policy are unchanged from the GUI implementation, so a
 * run's observable order, retries, and terminal state match exactly.
 */
import { EXEC, type IRGraph, type IRNode, type IRRunStatus } from '../core/ir';
import {
  assessConsensusFit,
  isTerminalIntentNode,
  nodeComplexitySignal,
} from '../core/consensusHeuristic';
import { isRunnable, topoOrderExec } from '../core/topo';
import { runFailureMeta } from './failure';
import { newSessionId } from './gateway';
import { computeNodeHashes, validCachedNodeIds } from './node-hash';
import { runSingleNode } from './run-node';
import type { NodeRunResult, RunCallbacks, RunContext, RunResult } from './types';

/**
 * Build `parentOf: Map<childId, parentId>` for every node in a single pass. Used
 * by {@link inCompositeBody} to walk parent chains without an O(n²) `nodes.find`.
 */
function buildParentOf(workflow: IRGraph): Map<string, string | undefined> {
  const parentOf = new Map<string, string | undefined>();
  for (const n of workflow.nodes) parentOf.set(n.id, n.parent ?? undefined);
  return parentOf;
}

/**
 * True when `nodeId`'s parent chain passes through ANY `composite` node — i.e.
 * the node lives inside a composite body and must NOT be scheduled by the outer
 * pump (it is run by {@link runComposite} when the composite node executes).
 * Branch/loop bodies are unaffected: their children stay in the flat runnable
 * set exactly as before (their parent chain never hits a composite).
 */
function inCompositeBody(
  nodeId: string,
  parentOf: Map<string, string | undefined>,
  compositeIds: Set<string>,
): boolean {
  let cur = parentOf.get(nodeId);
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    if (compositeIds.has(cur)) return true;
    seen.add(cur);
    cur = parentOf.get(cur);
  }
  return false;
}

/**
 * Runnable nodes in exec-topological order (drops structural `phase` markers and
 * composite-body nodes). Composite-body nodes (whose parent chain reaches a
 * `composite`) are excluded from the outer schedule: the composite node itself is
 * retained, and {@link runComposite} drives its body when it executes. This
 * prevents double-execution (outer pump + composite body). When the graph has no
 * composites this is byte-for-byte the legacy `topoOrderExec(...).filter(...)`.
 */
export function getRunnableNodes(workflow: IRGraph): IRNode[] {
  const flat = topoOrderExec(workflow).filter(isRunnable);
  const compositeIds = new Set(
    workflow.nodes.filter((n) => n.type === 'composite').map((n) => n.id),
  );
  if (compositeIds.size === 0) return flat;
  const parentOf = buildParentOf(workflow);
  return flat.filter((n) => !inCompositeBody(n.id, parentOf, compositeIds));
}

/**
 * Count a node's EXEC successors that are real work: runnable (not `phase`),
 * not a self-edge, and not the `start`/`end` sentinels. `0` ⇒ the node is the
 * tail of the exec spine (its only successor, if any, is `end`). Reuses
 * {@link getRunnableNodes} so the view matches exactly what a run executes —
 * the run engine uses this to detect terminal nodes for adversarial verify+vote.
 */
export function execNonEndSuccessorCount(
  workflow: IRGraph,
  nodeId: string,
): number {
  const byId = new Map(getRunnableNodes(workflow).map((n) => [n.id, n]));
  if (!byId.has(nodeId)) return 0;
  let count = 0;
  for (const e of workflow.edges) {
    if (e.kind !== EXEC) continue;
    if (e.from.node !== nodeId || e.to.node === nodeId) continue;
    const to = byId.get(e.to.node);
    if (!to || to.type === 'start' || to.type === 'end') continue;
    count += 1;
  }
  return count;
}

/**
 * Whether a node sits at the tail of the exec spine for run-time voting: no real
 * downstream work, OR a self-test/summary/validation step with <= 1 successor.
 * Shared by the run engine ({@link classifyVotingNode}) so the UI marker and the
 * dispatcher never disagree on what counts as "terminal".
 */
export function isExecTerminalNode(node: IRNode, workflow: IRGraph): boolean {
  const succ = execNonEndSuccessorCount(workflow, node.id);
  if (succ === 0) return true;
  return succ <= 1 && isTerminalIntentNode(node);
}

/** Why a node will trigger run-time divergence voting (for the UI marker tooltip). */
export interface VotingClassification {
  /** Will this node fan out + adversarially vote when run-time voting is enabled? */
  willVote: boolean;
  /** Which sample-knob category applies (terminal beats complex). */
  kind: 'terminal' | 'complex' | 'none';
  /** Deterministic 0..1 complexity signal (drives the starting-count scaling). */
  complexitySignal: number;
  /** Short human-readable reasons (e.g. 执行链尾 / 提示较长 / 含 3 个子目标). */
  reasons: string[];
}

/**
 * Pure, zero-model classifier shared by the run engine and the GUI: would this
 * node trigger run-time divergence voting (the 2→4→8→16 escalation)? `terminal`
 * (tail of the spine, or self-test/summary near the tail) takes precedence over
 * `complex` (assessConsensusFit). `willVote` is purely structural — it reflects
 * "would vote IF run-time voting is enabled", independent of the user's settings,
 * so the canvas/inspector marker stays stable regardless of the current knobs.
 */
export function classifyVotingNode(
  node: IRNode,
  workflow: IRGraph,
): VotingClassification {
  const signal = nodeComplexitySignal(node, workflow);
  if (node.type === 'agent' || node.type === 'workflow') {
    if (isExecTerminalNode(node, workflow)) {
      const reasons: string[] = [];
      if (execNonEndSuccessorCount(workflow, node.id) === 0) reasons.push('执行链尾');
      if (isTerminalIntentNode(node)) reasons.push('自检/汇总/校验类');
      return { willVote: true, kind: 'terminal', complexitySignal: signal, reasons };
    }
    const fit = assessConsensusFit(node, workflow);
    if (fit.fit) {
      return {
        willVote: true,
        kind: 'complex',
        complexitySignal: signal,
        reasons: fit.reason ? fit.reason.split('、') : [],
      };
    }
  }
  return { willVote: false, kind: 'none', complexitySignal: signal, reasons: [] };
}

/**
 * Build the runtime dependency map: a node depends on every other *runnable*
 * node that feeds it via an exec OR data edge. Connected nodes never reorder;
 * independent nodes have disjoint dependency sets and run concurrently.
 */
export function buildDependencyGraph(
  order: IRNode[],
  workflow: IRGraph,
): Map<string, Set<string>> {
  const idSet = new Set(order.map((n) => n.id));
  const deps = new Map<string, Set<string>>();
  for (const n of order) deps.set(n.id, new Set());
  for (const e of workflow.edges) {
    if (!idSet.has(e.from.node) || !idSet.has(e.to.node)) continue;
    if (e.from.node === e.to.node) continue;
    deps.get(e.to.node)!.add(e.from.node);
  }
  return deps;
}

/** True when a selection's adapter is part of the claude family. */
function isClaudeAdapter(adapter: string): boolean {
  return adapter === 'claude' || adapter === 'claude-code';
}

/**
 * Detect *linear claude agent chains* and assign each a shared warm session.
 *
 * A chain is a maximal run of adjacent nodes joined by EXEC edges where, for
 * every joining edge `from → to`, ALL of the following hold:
 *   - both `from` and `to` are runnable `agent`/`workflow` nodes;
 *   - both resolve (selection + per-node gateway override) to a claude(-code)
 *     adapter, and to the SAME adapter;
 *   - the edge is the only EXEC edge leaving `from` AND the only EXEC edge
 *     entering `to` (single-out / single-in — excludes fan-in / fan-out);
 *   - the two endpoints' resolved selections are identical (no override clash).
 *
 * Chains of a single node are not minted a session (nothing to resume). Every
 * node in a multi-node chain shares one `newSessionId()`; the chain's first node
 * is `isFirst=true`, the rest resume the warm context. DATA edges are ignored —
 * they don't affect chaining (the explicit upstream block is still injected by
 * the dispatcher). Returns a map keyed by node id; nodes not in any multi-node
 * chain are absent (and therefore cold-start unchanged).
 *
 * The EXEC dependency built by {@link buildDependencyGraph} guarantees a chain's
 * nodes run strictly sequentially, so the shared session id is never used
 * concurrently.
 */
export function detectAgentChains(
  order: IRNode[],
  workflow: IRGraph,
  context: RunContext,
): Map<string, { sessionId: string; isFirst: boolean }> {
  const chains = new Map<string, { sessionId: string; isFirst: boolean }>();
  const runnableIds = new Set(order.map((n) => n.id));
  const byId = new Map(order.map((n) => [n.id, n]));

  const isChainable = (node: IRNode | undefined): node is IRNode =>
    !!node && (node.type === 'agent' || node.type === 'workflow');

  // EXEC in/out degree (counted only over runnable endpoints).
  const outDeg = new Map<string, number>();
  const inDeg = new Map<string, number>();
  for (const n of order) {
    outDeg.set(n.id, 0);
    inDeg.set(n.id, 0);
  }
  for (const e of workflow.edges) {
    if (e.kind !== EXEC) continue;
    if (!runnableIds.has(e.from.node) || !runnableIds.has(e.to.node)) continue;
    if (e.from.node === e.to.node) continue;
    outDeg.set(e.from.node, (outDeg.get(e.from.node) ?? 0) + 1);
    inDeg.set(e.to.node, (inDeg.get(e.to.node) ?? 0) + 1);
  }

  // Per-node resolved selection (selection + node gateway override).
  const selectionOf = (node: IRNode) =>
    context.gateway.applyOverride(
      context.selection,
      context.gateway.nodeGatewayOverride(node.params) ?? undefined,
    );

  // `next[fromId] = toId` for every EXEC edge eligible to join a chain.
  const next = new Map<string, string>();
  for (const e of workflow.edges) {
    if (e.kind !== EXEC) continue;
    if (e.from.node === e.to.node) continue;
    const from = byId.get(e.from.node);
    const to = byId.get(e.to.node);
    if (!isChainable(from) || !isChainable(to)) continue;
    // Same-scope only — a warm-session chain must not cross a composite (or any
    // container) boundary, where the body-entry edge joins different scopes.
    if ((from.parent ?? undefined) !== (to.parent ?? undefined)) continue;
    // Single-out from `from`, single-in to `to` — excludes fan-in / fan-out.
    if ((outDeg.get(from.id) ?? 0) !== 1 || (inDeg.get(to.id) ?? 0) !== 1) continue;
    const sf = selectionOf(from);
    const st = selectionOf(to);
    if (!isClaudeAdapter(sf.adapter) || !isClaudeAdapter(st.adapter)) continue;
    // Both endpoints must resolve to the SAME selection (adapter + overrides).
    if (
      sf.adapter !== st.adapter ||
      sf.modelClass !== st.modelClass ||
      sf.providerId !== st.providerId ||
      sf.channelId !== st.channelId ||
      !!sf.systemDefault !== !!st.systemDefault
    ) {
      continue;
    }
    next.set(from.id, to.id);
  }

  // Walk from each chain head (a chainable node with no chainable predecessor)
  // and assign one session id per multi-node chain.
  const hasPred = new Set(next.values());
  for (const node of order) {
    if (!isChainable(node)) continue;
    if (hasPred.has(node.id)) continue; // not a head — visited from its predecessor
    if (!next.has(node.id)) continue; // singleton chain — nothing to resume
    const sessionId = newSessionId();
    let cursor: string | undefined = node.id;
    let isFirst = true;
    while (cursor) {
      chains.set(cursor, { sessionId, isFirst });
      isFirst = false;
      cursor = next.get(cursor);
    }
  }

  return chains;
}

export interface ExecuteWorkflowOptions {
  resumeFromNodeId?: string | null;
  /** Outputs of nodes already known-complete (resume seed). */
  seedOutputs?: Record<string, string>;
  /** Run states already known (resume seed); used to mark nodes done. */
  seedRunState?: Record<string, IRRunStatus>;
  /**
   * Per-node content hashes from the run that produced `seedOutputs` (see
   * {@link computeNodeHashes}). When present, a seeded output is reused ONLY if
   * the node's CURRENT hash matches its seed hash — i.e. neither the node nor
   * any upstream node was edited since. A node whose hash changed (and therefore
   * every node downstream of it) drops its stale cache and re-runs. This makes
   * "edit the graph, then continue" correct: the edited subgraph re-runs while
   * the untouched prefix is reused. Absent ⇒ legacy behaviour (reuse every
   * seeded output by node id, the pre-hash semantics).
   */
  seedNodeHashes?: Record<string, string>;
}

/**
 * Interpret the IR as a dependency DAG and execute it through the injected
 * gateway. Independent nodes run concurrently (bounded by `context.concurrency`,
 * itself clamped by the gateway's speed tier). Returns the aggregate
 * {@link RunResult}; per-node transitions and logs stream through `callbacks`.
 */
export async function executeWorkflowDag(
  workflow: IRGraph,
  callbacks: RunCallbacks,
  context: RunContext,
  options: ExecuteWorkflowOptions = {},
): Promise<RunResult> {
  const runStartedAt = Date.now();
  const adapter = context.selection.adapter;
  const stillRunning = () => !callbacks.isCancelled();

  const order = getRunnableNodes(workflow);
  const resumeFromNodeId =
    options.resumeFromNodeId &&
    order.some((node) => node.id === options.resumeFromNodeId)
      ? options.resumeFromNodeId
      : null;

  // Content-addressed resume (cf. DeepSeek-Code-Whale's per-call resume cache):
  // a seeded output is only trustworthy if the node's spec AND all of its
  // upstream specs are byte-identical to the run that produced it. We compute
  // this run's Merkle node hashes once and intersect with the seed hashes; any
  // node whose hash changed (it or an ancestor was edited) is NOT reusable, so
  // it and its downstream re-run with fresh inputs. With no seed hashes we fall
  // back to the legacy "reuse every seeded output by id" behaviour.
  const nodeHashes = computeNodeHashes(workflow);
  const seedOutputs = options.seedOutputs ?? {};
  const reusable = options.seedNodeHashes
    ? validCachedNodeIds(nodeHashes, options.seedNodeHashes)
    : null; // null ⇒ legacy: trust every seeded id
  const isReusable = (nodeId: string): boolean =>
    reusable ? reusable.has(nodeId) : true;

  const results = new Map<string, string>(
    Object.entries(seedOutputs).filter(([nodeId]) => isReusable(nodeId)),
  );
  const deps = buildDependencyGraph(order, workflow);
  const seedRunState = options.seedRunState ?? {};

  // Share a warm claude session across linear agent chains so successors
  // continue the predecessor's context instead of cold-starting (Fix 1). The
  // chain's EXEC dependency keeps its nodes strictly sequential, so the shared
  // session id is never used concurrently.
  context.agentChains = detectAgentChains(order, workflow, context);

  const resumeIdx = resumeFromNodeId
    ? order.findIndex((n) => n.id === resumeFromNodeId)
    : -1;
  const done = new Set<string>();
  order.forEach((node, i) => {
    if (results.has(node.id)) {
      // Output present AND hash-valid (results was already filtered above).
      done.add(node.id);
    } else if (seedRunState[node.id] === 'success' && isReusable(node.id)) {
      done.add(node.id);
    } else if (resumeIdx >= 0 && i < resumeIdx && isReusable(node.id)) {
      done.add(node.id);
    }
  });
  if (resumeFromNodeId) done.delete(resumeFromNodeId);

  const nodeResults: Record<string, NodeRunResult> = {};
  // Expose the live accumulator so nested composite-body schedulers record their
  // body nodes' terminal results into the same aggregate RunResult.
  context.nodeResults = nodeResults;
  let errored = false;
  let failedNodeId: string | null = null;
  let runError: Record<string, unknown> | null = null;

  const processNode = async (node: IRNode): Promise<boolean> => {
    const outcome = await runSingleNode(
      context,
      callbacks,
      node,
      workflow,
      results,
      nodeResults,
    );
    if (outcome.kind === 'ok') return true;
    if (outcome.kind === 'cancelled') return false;
    // Terminal failure — only the first becomes the run's error / resume point.
    if (!errored) {
      errored = true;
      failedNodeId = node.id;
      runError = runFailureMeta(node, adapter, outcome.failure);
    }
    return false;
  };

  const concurrency = context.gateway.effectiveConcurrency(
    context.concurrency,
    context.selection,
  );
  const claimed = new Set<string>(done);

  await new Promise<void>((resolve) => {
    let active = 0;
    let finished = false;
    const finish = () => {
      if (!finished) {
        finished = true;
        resolve();
      }
    };

    const pickReady = (): IRNode | null => {
      for (const node of order) {
        if (claimed.has(node.id)) continue;
        let ready = true;
        for (const dep of deps.get(node.id)!) {
          if (!done.has(dep)) {
            ready = false;
            break;
          }
        }
        if (ready) return node;
      }
      if (active === 0) {
        for (const node of order) if (!claimed.has(node.id)) return node;
      }
      return null;
    };

    const pump = (): void => {
      if (finished) return;
      if (!stillRunning()) {
        if (active === 0) finish();
        return;
      }
      while (active < concurrency && !errored && stillRunning()) {
        const next = pickReady();
        if (!next) break;
        claimed.add(next.id);
        active += 1;
        void processNode(next).then((ok) => {
          active -= 1;
          if (ok) done.add(next.id);
          pump();
        });
      }
      if (active === 0 && (errored || !stillRunning() || !pickReady())) {
        finish();
      }
    };

    pump();
  });

  const outputs = Object.fromEntries(results);
  return {
    success: !errored && stillRunning(),
    durationMs: Date.now() - runStartedAt,
    nodeResults,
    outputs,
    failedNodeId: failedNodeId ?? undefined,
    error: runError,
    nodeHashes,
  };
}
