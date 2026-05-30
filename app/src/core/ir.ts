/**
 * Authoritative intermediate representation (IR) for OpenWorkflow.
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
  | 'codeblock';

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
  /** Schema identifier name (bare), e.g. "REVIEW". */
  schema?: string;
  isolation?: 'worktree';
  phase?: string;
}

/** A node in the workflow graph. */
export interface IRNode {
  /** Globally unique node id. */
  id: string;
  /** Node category. */
  type: NodeType;
  /**
   * Id of the containing `branch`/`loop` node, or undefined for the top scope.
   * Children of a container are emitted inside its `if`/`while` block; the
   * canvas renders them as React Flow sub-flow children.
   */
  parent?: string;
  /** Display label. */
  label?: string;
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
   *   agent:    { prompt, label?, agentType?, model?, schema?, isolation?, phase? }
   *   parallel: { branches: IRAgentSpec[] }       — emitted as a thunk array
   *   pipeline: { items: string, stages: IRAgentSpec[] } — items is an expr ref
   *   branch:   { condition: string }             — children carry parent=this.id
   *   loop:     { condition: string }             — while-continue condition
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

/** Graph metadata. */
export interface IRMeta {
  name?: string;
  description?: string;
  /** Target adapter id, e.g. "claude-code". */
  adapter?: string;
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
