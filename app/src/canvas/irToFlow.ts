import type { Edge, Node } from '@xyflow/react';
import { MarkerType } from '@xyflow/react';
import { DATA, EXEC, type IRGraph, type IRNode, type NodeType } from '@/core/ir';
import type { NodeRunState } from '@/store/types';

/**
 * Adapter that projects the authoritative {@link IRGraph} onto the
 * nodes/edges shape consumed by React Flow.
 *
 * The IR is the single source of truth; this module is a pure, one-way
 * transform (IR -> flow). It performs no mutation and holds no state.
 *
 * Nesting: `branch`/`loop` nodes are React Flow sub-flow parents. Their children
 * (nodes whose `parent` equals the container id) are emitted with `parentId` +
 * `extent:'parent'` and positioned *relative* to the container, which is sized to
 * fit its (recursively measured) children. Top-level nodes use `graph.layout`
 * (so user drags survive); children are auto-stacked.
 *
 * Run-state policy: the optional `runState` map is threaded onto each flow
 * node's `data.runState` so the custom node components render status borders.
 */

/** Extra payload carried on each React Flow node's `data` field. */
export interface FlowNodeData extends Record<string, unknown> {
  label: string;
  irType: NodeType;
  params: Record<string, unknown>;
  /** Live execution state — only set while a workflow is running. */
  runState?: NodeRunState;
}

export type FlowNode = Node<FlowNodeData>;
export type FlowEdge = Edge;

/** Default spacing used when a top-level node has no recorded layout. */
const DEFAULT_DX = 240;
const DEFAULT_Y = 160;

/* Sub-flow layout constants. */
const LEAF_W = 220;
const LEAF_H = 96;
const HEADER = 40;
const PAD = 16;
const GAP = 14;

/** Map an IR node type to the registered custom React Flow node component. */
function flowNodeType(type: NodeType): string {
  switch (type) {
    case 'agent':
      return 'agent';
    case 'parallel':
      return 'parallel';
    case 'pipeline':
      return 'pipeline';
    case 'branch':
    case 'loop':
      return 'container';
    case 'start':
    case 'end':
      return 'control';
    default:
      return 'agent';
  }
}

function isContainer(type: NodeType): boolean {
  return type === 'branch' || type === 'loop';
}

/** Human-readable fallback label for a node missing an explicit one. */
function nodeLabel(node: IRNode): string {
  if (node.label && node.label.trim()) return node.label;
  return node.id;
}

/* -------------------------------------------------------------------------- */
/* recursive sub-flow measurement                                             */
/* -------------------------------------------------------------------------- */

interface Size {
  w: number;
  h: number;
}

/** Children of each container, in declaration order. */
function indexChildren(graph: IRGraph): Map<string, IRNode[]> {
  const map = new Map<string, IRNode[]>();
  for (const n of graph.nodes) {
    if (!n.parent) continue;
    const list = map.get(n.parent) ?? [];
    list.push(n);
    map.set(n.parent, list);
  }
  return map;
}

/** Measure a node's footprint, recursing into containers. */
function measure(node: IRNode, children: Map<string, IRNode[]>): Size {
  if (!isContainer(node.type)) return { w: LEAF_W, h: LEAF_H };
  const kids = children.get(node.id) ?? [];
  if (kids.length === 0) return { w: LEAF_W + PAD * 2, h: HEADER + PAD * 2 + 24 };
  let w = LEAF_W;
  let h = HEADER + PAD;
  for (const kid of kids) {
    const m = measure(kid, children);
    w = Math.max(w, m.w);
    h += m.h + GAP;
  }
  h += PAD - GAP;
  return { w: w + PAD * 2, h };
}

/** Depth of a node in the parent chain (0 = top level). */
function depthOf(node: IRNode, byId: Map<string, IRNode>): number {
  let d = 0;
  let p = node.parent;
  while (p) {
    d += 1;
    p = byId.get(p)?.parent;
  }
  return d;
}

/* -------------------------------------------------------------------------- */
/* projection                                                                 */
/* -------------------------------------------------------------------------- */

function toFlowNode(
  node: IRNode,
  index: number,
  graph: IRGraph,
  children: Map<string, IRNode[]>,
  relPos: Map<string, { x: number; y: number }>,
  runState: Record<string, NodeRunState> | undefined,
): FlowNode {
  const state = runState?.[node.id];
  const base: FlowNode = {
    id: node.id,
    type: flowNodeType(node.type),
    position: node.parent
      ? relPos.get(node.id) ?? { x: PAD, y: HEADER + PAD }
      : graph.layout?.[node.id] ?? { x: index * DEFAULT_DX, y: DEFAULT_Y },
    data: {
      label: nodeLabel(node),
      irType: node.type,
      params: node.params,
      ...(state ? { runState: state } : null),
    },
  };
  if (node.parent) {
    base.parentId = node.parent;
    base.extent = 'parent';
  }
  if (isContainer(node.type)) {
    const m = measure(node, children);
    base.style = { width: m.w, height: m.h };
  }
  return base;
}

/** Convert a single IR edge into a React Flow edge. */
function toFlowEdge(edge: IREdgeLike): FlowEdge {
  const isData = edge.kind === DATA;
  const color = isData ? 'var(--accent-2)' : 'var(--accent)';
  return {
    id: edge.id,
    source: edge.from.node,
    target: edge.to.node,
    sourceHandle: edge.from.port,
    targetHandle: edge.to.port,
    type: 'smoothstep',
    animated: edge.kind === EXEC,
    style: {
      stroke: color,
      strokeWidth: 1.5,
      strokeDasharray: isData ? '4 4' : undefined,
    },
    markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
    data: { kind: edge.kind },
  };
}

type IREdgeLike = IRGraph['edges'][number];

export interface FlowGraph {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

/**
 * Project an {@link IRGraph} into React Flow `nodes` and `edges`.
 *
 * Pure function: same input always yields an equivalent output. Containers are
 * sized to fit their children and children are laid out relative to them; nodes
 * are emitted parents-before-children (a React Flow requirement for sub-flows).
 */
export function irToFlow(
  graph: IRGraph,
  runState?: Record<string, NodeRunState>,
): FlowGraph {
  const children = indexChildren(graph);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  // Compute each child's relative position by stacking within its container.
  const relPos = new Map<string, { x: number; y: number }>();
  for (const [, kids] of children) {
    let cursorY = HEADER + PAD;
    for (const kid of kids) {
      relPos.set(kid.id, { x: PAD, y: cursorY });
      cursorY += measure(kid, children).h + GAP;
    }
  }

  // Parents must precede their children in the array; sort by depth (stable).
  const ordered = graph.nodes
    .map((node, i) => ({ node, i }))
    .sort((a, b) => depthOf(a.node, byId) - depthOf(b.node, byId) || a.i - b.i);

  const nodes = ordered.map(({ node, i }) =>
    toFlowNode(node, i, graph, children, relPos, runState),
  );
  const edges = graph.edges.map(toFlowEdge);
  return { nodes, edges };
}
