import type { Edge, Node } from '@xyflow/react';
import { MarkerType } from '@xyflow/react';
import type { ComfyPromptGraph } from '@/lib/comfyui';

/**
 * Pure, one-way projection of a {@link ComfyPromptGraph} onto the nodes/edges
 * shape React Flow consumes — the ComfyUI analogue of canvas/irToFlow.ts.
 *
 * ComfyUI graphs are a flat node-id -> node map. Links live inside each node's
 * `inputs` as `[sourceNodeId, outputIndex]` tuples, so edges are recovered by
 * scanning every input value. Layout is computed with a simple longest-path
 * layering (sources on the left, sinks on the right) since ComfyUI prompt JSON
 * carries no positions.
 */

export interface ComfyFlowNodeData extends Record<string, unknown> {
  /** Display title — node `_meta.title` if present, else the class_type. */
  title: string;
  classType: string;
  /** Literal (non-link) inputs, shown as a compact key/value list. */
  fields: Array<{ key: string; value: string }>;
}

export type ComfyFlowNode = Node<ComfyFlowNodeData>;
export type ComfyFlowEdge = Edge;

const NODE_W = 200;
const COL_GAP = 260;
const ROW_GAP = 150;

function isLink(value: unknown): value is [string, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === 'string' &&
    typeof value[1] === 'number'
  );
}

function literalToString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') {
    return value.length > 48 ? `${value.slice(0, 45)}…` : value;
  }
  return String(value);
}

/** Longest-path layering: each node's column = max(depth of its link sources)+1. */
function computeColumns(graph: ComfyPromptGraph): Map<string, number> {
  const depth = new Map<string, number>();
  const visiting = new Set<string>();

  const resolve = (id: string): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (visiting.has(id)) return 0; // cycle guard
    visiting.add(id);
    const node = graph[id];
    let maxParent = -1;
    if (node) {
      for (const value of Object.values(node.inputs ?? {})) {
        if (isLink(value)) {
          const src = value[0];
          if (graph[src]) maxParent = Math.max(maxParent, resolve(src));
        }
      }
    }
    visiting.delete(id);
    const d = maxParent + 1;
    depth.set(id, d);
    return d;
  };

  for (const id of Object.keys(graph)) resolve(id);
  return depth;
}

export function comfyToFlow(graph: ComfyPromptGraph | null): {
  nodes: ComfyFlowNode[];
  edges: ComfyFlowEdge[];
} {
  if (!graph) return { nodes: [], edges: [] };
  const columns = computeColumns(graph);
  const rowCursor = new Map<number, number>();

  const nodes: ComfyFlowNode[] = Object.entries(graph).map(([id, node]) => {
    const col = columns.get(id) ?? 0;
    const row = rowCursor.get(col) ?? 0;
    rowCursor.set(col, row + 1);
    const fields = Object.entries(node.inputs ?? {})
      .filter(([, value]) => !isLink(value))
      .map(([key, value]) => ({ key, value: literalToString(value) }));
    return {
      id,
      type: 'comfy',
      position: { x: col * COL_GAP, y: row * ROW_GAP },
      width: NODE_W,
      data: {
        title: node._meta?.title?.trim() || node.class_type,
        classType: node.class_type,
        fields,
      },
    };
  });

  const edges: ComfyFlowEdge[] = [];
  for (const [id, node] of Object.entries(graph)) {
    for (const [key, value] of Object.entries(node.inputs ?? {})) {
      if (!isLink(value)) continue;
      const [source] = value;
      if (!graph[source]) continue;
      edges.push({
        id: `${source}->${id}:${key}`,
        source,
        target: id,
        label: key,
        animated: false,
        markerEnd: { type: MarkerType.ArrowClosed },
      });
    }
  }

  return { nodes, edges };
}

/** Node count + edge count summary for the collapsed block header. */
export function comfyGraphStats(graph: ComfyPromptGraph | null): {
  nodes: number;
  edges: number;
} {
  if (!graph) return { nodes: 0, edges: 0 };
  let edges = 0;
  for (const node of Object.values(graph)) {
    for (const value of Object.values(node.inputs ?? {})) {
      if (isLink(value)) edges += 1;
    }
  }
  return { nodes: Object.keys(graph).length, edges };
}
