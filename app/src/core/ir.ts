/**
 * Authoritative intermediate representation (IR) for FreeUltraCode.
 *
 * The IRGraph is the single source of truth for the entire system. The canvas
 * (React Flow), the script emitter/parser, and AI-driven mutations all operate
 * on this model-agnostic representation.
 *
 * CONTRACT: The exported types and the EXEC/DATA constants below are consumed
 * directly by App.tsx and every downstream module. Do not change their shapes.
 */

/** Pin / edge kinds. `▶ exec` is execution flow, `● data` is data flow. */
export const EXEC = 'exec' as const;
export const DATA = 'data' as const;

/** Kind of a pin or an edge: execution flow or data flow. */
export type PinKind = typeof EXEC | typeof DATA;

/**
 * All node categories supported by the blueprint canvas. Mirrors the node
 * catalogue described in the design doc (section 5).
 */
export type NodeType =
  | 'start'
  | 'end'
  | 'agent'
  | 'parallel'
  | 'pipeline'
  | 'phase'
  | 'branch'
  | 'loop'
  | 'workflow'
  | 'log'
  | 'variable'
  | 'codeblock'
  | 'consensus'
  | 'composite';

/** A single pin (input/output port) on a node. */
export interface IRPort {
  /** Stable id, unique within the node. */
  id: string;
  /** Whether this is an input or output pin. */
  direction: 'in' | 'out';
  /** Execution flow or data flow. */
  kind: PinKind;
  /** Human-readable label. */
  label?: string;
}

/**
 * A spec for a single `agent()` call used inside a `parallel` branch or a
 * `pipeline` stage. Emitted as `agent('<prompt>', { … })`; `schema` is an
 * identifier name (e.g. "REVIEW") emitted bare, never quoted.
 */
export interface IRAgentSpec {
  prompt: string;
  label?: string;
  /** Custom sub-agent type, emitted as the real `agentType:` option. */
  agentType?: string;
  model?: string;
  gateway?: NodeGatewayOverride;
  /** Schema identifier name (bare), e.g. "REVIEW". */
  schema?: string;
  isolation?: 'worktree';
  phase?: string;
  /**
   * Upstream-context convergence policy applied when building this node's data
   * block (see runtime/context.ts). 'full' (default) concatenates upstream
   * outputs verbatim; 'tail' head/tail-truncates over-long inputs. Omitted ⇒
   * 'full', so this is opt-in and never changes existing output.
   */
  contextPolicy?: 'full' | 'tail';
}

/**
 * Consensus strategies — the four reusable "quality patterns" Claude Code
 * Dynamic Workflows use to win by adversarial verification rather than scale:
 *   - 'adversarial'      一批出结论 → 一批专门反驳,扛住反驳才保留
 *   - 'multi-lens'       多个角度审同一目标 → 多数票通过
 *   - 'tournament'       各出方案 → 打分选胜 + 嫁接亮点
 *   - 'self-consistency' 同一提示跑 N 次 → 结构化多数票
 */
export type ConsensusStrategy =
  | 'adversarial'
  | 'multi-lens'
  | 'tournament'
  | 'self-consistency';

/**
 * Options for a `consensus` node, shared by the emitter, parser and run engine.
 * Emitted as the trailing `{ … }` of a `consensus([…voters], { … })` call with a
 * fixed key order so emit→parse→emit stays byte-stable.
 */
export interface ConsensusOpts {
  strategy: ConsensusStrategy;
  /** self-consistency only: run voters[0] this many times. Default 3, clamp 2..7. */
  samples?: number;
  /** Votes required to pass. Default ceil(N/2). */
  quorum?: number;
  /** Structured-verdict schema identifier (bare), e.g. "VERDICT". */
  schema?: string;
}

export type ModelClass = 'haiku' | 'sonnet' | 'opus' | string;

export interface GatewaySelection {
  adapter: 'claude-code' | 'codex' | 'gemini' | string;
  modelClass: ModelClass;
  /** Exact provider/free-channel model for a session, without changing global defaults. */
  modelOverride?: string;
  /** Use the selected runtime CLI exactly as configured on the machine. */
  systemDefault?: boolean;
  providerId?: string;
  channelId?: string;
}

export interface NodeGatewayOverride {
  modelClass?: ModelClass;
  providerId?: string;
  channelId?: string;
}

/** A node in the workflow graph. */
export interface IRNode {
  /** Globally unique node id. */
  id: string;
  /** Node category. */
  type: NodeType;
  /**
   * Id of the containing `branch`/`loop`/`composite` node, or undefined for the
   * top scope. Children of a container are emitted inside its `if`/`while` block
   * (branch/loop) or its local `async function` body (composite); the canvas
   * renders them as independent nodes connected to the container node. `composite`
   * is the 4th container kind and reuses the same flat `parent` scoping mechanism.
   */
  parent?: string;
  /** Display label. */
  label?: string;
  /**
   * Auto-assigned numeric tag shown on ordinary workflow nodes. Scoped to this
   * IRGraph, contiguous, and never set for Start/End.
   */
  numberLabel?: number;
  /**
   * JS variable name this node binds to in the emitted script (e.g. `scan` in
   * `const scan = await agent(...)`). Recovered on parse and reused on re-emit so
   * var names — and the `${var}` data-flow references that depend on them — stay
   * stable across emit→parse→emit. Optional; the emitter derives one from the
   * label when absent.
   */
  binding?: string;
  /**
   * Arbitrary, type-specific parameters. Notable shapes:
   *   start:    { userInputs?: string[] }        — source requirements shown on the Start node
   *   agent:    { prompt, label?, agentType?, model?, gateway?, schema?, isolation?, phase?, contextPolicy? }
   *   parallel: { branches: IRAgentSpec[] }       — emitted as a thunk array
   *   pipeline: { items: string, stages: IRAgentSpec[] } — items is an expr ref
   *   branch:   { condition: string }             — children carry parent=this.id
   *   loop:     { condition: string }             — while-continue condition
   *   consensus:{ voters: IRAgentSpec[], strategy, samples?, quorum?, schema? }
   *             — fan out voters, cross-validate, then vote (see ConsensusStrategy /
   *               ConsensusOpts). voters mirror parallel.branches (each carries its
   *               own full prompt); emitted as `consensus([…thunks], { … })`.
   *   composite:{ inputs: IRPort[], outputs: IRPort[], label? }
   *             — a reusable container encapsulating a complete sub-workflow with
   *               declared input/output ports. Each entry of `inputs` is
   *               `{ id, direction:'in', kind:'data'|'exec', label? }`; each entry
   *               of `outputs` is `{ id, direction:'out', kind:'data'|'exec', label? }`.
   *               The body nodes are NOT nested inside params — they are ordinary
   *               IR nodes carrying `parent = <this composite id>` (flat scoping,
   *               same as branch/loop), enabling unlimited nesting. The composite
   *               compiles to a local `async function` declaration plus a call site;
   *               its declared ports bind to the body via DATA edges:
   *
   *               Input binding (outer → composite port):
   *                 { from:{node:OUTER,port:'data_out'}, to:{node:COMPOSITE,port:<inputPortId>} }
   *               Input binding (composite port → inner consumer):
   *                 { from:{node:COMPOSITE,port:<inputPortId>}, to:{node:INNER,port:'data_in'} }
   *               Output binding (inner producer → composite port):
   *                 { from:{node:INNER,port:'data_out'}, to:{node:COMPOSITE,port:<outputPortId>} }
   *               Output binding (composite port → downstream consumer):
   *                 { from:{node:COMPOSITE,port:<outputPortId>}, to:{node:DOWNSTREAM,port:'data_in'} }
   *
   *               Exec spine: outer `…→COMPOSITE→next` like any value node; the
   *               body entry edge `COMPOSITE(exec_out)→firstChild(exec_in)` crosses
   *               into the body scope (same convention as branch/loop body entry).
   */
  params: Record<string, unknown>;
  /** Optional explicit pin definitions; otherwise derived from the registry. */
  ports?: IRPort[];
}

/** An endpoint of an edge: a specific port on a specific node. */
export interface IREndpoint {
  node: string;
  port: string;
}

/** A directed edge connecting two ports. */
export interface IREdge {
  /** Globally unique edge id. */
  id: string;
  from: IREndpoint;
  to: IREndpoint;
  /** Execution flow or data flow. */
  kind: PinKind;
}

/** Optional per-node layout coordinates. */
export type IRLayout = Record<string, { x: number; y: number }>;

/** Persistable execution status for a workflow run or an individual node. */
export type IRRunStatus =
  | 'idle'
  | 'running'
  | 'success'
  | 'error'
  | 'interrupted';

/**
 * One row of a captain-loop task ledger. The "队长" (manager) node decomposes a
 * frozen goal into these; the acceptance gate marks each accepted/rejected with
 * evidence and gaps. Persisted inside the run snapshot (see {@link TaskLedger})
 * so reopen/resume recovers task-level state — not just node success/failure.
 */
export interface TaskLedgerEntry {
  /** Stable id within the ledger (e.g. "t1"). */
  id: string;
  /** Short human-readable task title. */
  title: string;
  /** Who/which worker owns this subtask. */
  owner?: string;
  /** The acceptance line: what must be true for this task to pass. */
  acceptance?: string;
  /** Evidence form / pointer (command output, file path, screenshot, link). */
  evidence?: string;
  /** Acceptance state, set by the gate. */
  status: 'pending' | 'running' | 'accepted' | 'rejected' | 'blocked';
  /** Path / identifier of the produced artifact. */
  artifact?: string;
  /** Outstanding gaps blocking acceptance (rework reasons). */
  gaps?: string[];
}

/**
 * Captain-loop task ledger: the structured, recoverable record of subtasks,
 * their acceptance state, evidence and gaps — kept on the run snapshot (not in
 * the chat stream) so long tasks don't "forget". `anchor` is the current
 * best accepted artifact; `round` is the rework iteration count. Ignored by
 * emit/parse (it lives under meta.run, which they skip).
 */
export interface TaskLedger {
  tasks: TaskLedgerEntry[];
  /** Current best accepted artifact (the "已验收锚点"). */
  anchor?: string;
  /** Rework/acceptance round number. */
  round?: number;
}

/** Runtime snapshot persisted with the workflow so reopen/resume can recover. */
export interface IRRunSnapshot {
  status: IRRunStatus;
  nodeStates?: Record<string, IRRunStatus>;
  outputs?: Record<string, string>;
  failedNodeId?: string | null;
  error?: Record<string, unknown> | null;
  route?: GatewaySelection;
  usage?: Record<string, unknown> | null;
  /**
   * Captain-loop task ledger (subtask status / acceptance / evidence / gaps).
   * Populated by the acceptance gate during a captain-loop run; surfaced in the
   * right-hand panel. Absent for ordinary workflows. Ignored by emit/parse.
   */
  taskLedger?: TaskLedger;
  updatedAt?: number;
}

/** Graph metadata. */
export interface IRMeta {
  name?: string;
  description?: string;
  /** Target adapter id, e.g. "claude-code". */
  adapter?: string;
  /**
   * "Simple workflow" mode. When true the graph must stay a single node (the
   * lone `start` node created by simpleBlueprint(), which accumulates the user's
   * inputs in params.userInputs) for its entire lifetime — used for easy,
   * one-shot questions. The AI dock runs as a plain chat (no blueprint
   * generation): input goes straight to the model and the graph never grows past
   * that one node. Ignored by emit/parse.
   */
  simple?: boolean;
  gateway?: {
    defaults?: GatewaySelection;
  };
  /** Last known runtime progress; ignored by emit/parse. */
  run?: IRRunSnapshot;
  /**
   * Definitions for schema identifiers referenced by agent/branch/stage specs,
   * keyed by identifier name. Emitted as a `const <name> = <body> // @schema`
   * preamble so the generated script is genuinely runnable. Recovered on parse
   * from `// @schema` annotations rather than becoming nodes.
   */
  schemaDefs?: Record<string, string>;
}

/** The complete workflow graph — the single source of truth. */
export interface IRGraph {
  version: number;
  meta: IRMeta;
  nodes: IRNode[];
  edges: IREdge[];
  layout?: IRLayout;
}
