import { EXEC, type IRGraph, type IRNode } from './ir';

/**
 * Topologically order the nodes of an IRGraph along the execution (`exec`)
 * spine. Stable: ties are broken by the order in which nodes appear in
 * `ir.nodes`. Cycles are tolerated — cycle members are appended in original
 * declaration order after the acyclic prefix.
 *
 * This is the canonical exec ordering used by both the script emitter and the
 * runtime simulator, so the visible run order in the UI matches the order of
 * statements in the emitted script.
 */
export function topoOrderExec(ir: IRGraph): IRNode[] {
  const byId = new Map(ir.nodes.map((n) => [n.id, n]));
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const n of ir.nodes) {
    indeg.set(n.id, 0);
    adj.set(n.id, []);
  }

  for (const e of ir.edges) {
    if (e.kind !== EXEC) continue;
    if (!byId.has(e.from.node) || !byId.has(e.to.node)) continue;
    adj.get(e.from.node)!.push(e.to.node);
    indeg.set(e.to.node, (indeg.get(e.to.node) ?? 0) + 1);
  }

  const result: IRNode[] = [];
  const visited = new Set<string>();
  const queue: string[] = ir.nodes
    .filter((n) => (indeg.get(n.id) ?? 0) === 0)
    .map((n) => n.id);

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const node = byId.get(id);
    if (node) result.push(node);
    for (const next of adj.get(id) ?? []) {
      const d = (indeg.get(next) ?? 0) - 1;
      indeg.set(next, d);
      if (d <= 0 && !visited.has(next)) queue.push(next);
    }
  }

  // Append any cycle survivors in declaration order so every node is
  // represented exactly once.
  for (const n of ir.nodes) {
    if (!visited.has(n.id)) result.push(n);
  }
  return result;
}

/**
 * Topologically order only the nodes belonging to a single scope — those whose
 * `parent` equals `parentId` (`undefined` = the top scope). Ordering follows
 * exec edges whose *both* endpoints live in the scope; the container→firstChild
 * body-entry edge crosses scopes, so the first child of a container naturally
 * has zero intra-scope indegree and seeds the chain.
 *
 * Used by the emitter to walk each `if`/`while` body (and the top scope)
 * independently. Stable and cycle-tolerant, mirroring {@link topoOrderExec}.
 */
export function topoOrderScope(
  ir: IRGraph,
  parentId: string | undefined,
): IRNode[] {
  const scopeNodes = ir.nodes.filter((n) => (n.parent ?? undefined) === parentId);
  const inScope = new Set(scopeNodes.map((n) => n.id));
  const byId = new Map(scopeNodes.map((n) => [n.id, n]));

  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const n of scopeNodes) {
    indeg.set(n.id, 0);
    adj.set(n.id, []);
  }

  for (const e of ir.edges) {
    if (e.kind !== EXEC) continue;
    // Only intra-scope edges constrain the order within this scope.
    if (!inScope.has(e.from.node) || !inScope.has(e.to.node)) continue;
    adj.get(e.from.node)!.push(e.to.node);
    indeg.set(e.to.node, (indeg.get(e.to.node) ?? 0) + 1);
  }

  const result: IRNode[] = [];
  const visited = new Set<string>();
  const queue: string[] = scopeNodes
    .filter((n) => (indeg.get(n.id) ?? 0) === 0)
    .map((n) => n.id);

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const node = byId.get(id);
    if (node) result.push(node);
    for (const next of adj.get(id) ?? []) {
      const d = (indeg.get(next) ?? 0) - 1;
      indeg.set(next, d);
      if (d <= 0 && !visited.has(next)) queue.push(next);
    }
  }

  for (const n of scopeNodes) {
    if (!visited.has(n.id)) result.push(n);
  }
  return result;
}

/**
 * Nodes whose execution status is meaningful to visualize at runtime. `start`
 * and `end` are sentinels in the IR but useful to drive the run-state HUD;
 * `phase` is a structural marker that has no runtime work of its own.
 */
export function isRunnable(node: IRNode): boolean {
  return node.type !== 'phase';
}
