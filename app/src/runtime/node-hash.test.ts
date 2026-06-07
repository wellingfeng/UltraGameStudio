/**
 * Tests for content-addressed node hashing (the IRGraph analogue of
 * DeepSeek-Code-Whale's per-call resume cache key). Covers: stability across
 * re-computation, presentation-only fields NOT affecting the hash, a spec edit
 * changing the node's hash, upstream-edit propagation to all downstream hashes,
 * schemaDefs edits propagating, and validCachedNodeIds intersection semantics.
 */
import { describe, expect, it } from 'vitest';
import { EXEC, DATA, type IRGraph, type PinKind } from '@/core/ir';
import { computeNodeHashes, validCachedNodeIds } from '@/runtime';

function edge(id: string, from: string, to: string, kind: PinKind = EXEC) {
  return { id, from: { node: from, port: 'o' }, to: { node: to, port: 'i' }, kind };
}

/** start → a → b → c → end, with data edges a→b and b→c. */
function lineGraph(): IRGraph {
  return {
    version: 1,
    meta: { name: 't', adapter: 'claude-code' },
    nodes: [
      { id: 'start', type: 'start', params: { userInputs: ['请求 X'] } },
      { id: 'a', type: 'agent', label: 'A', params: { prompt: 'do A' } },
      { id: 'b', type: 'agent', label: 'B', params: { prompt: 'do B' } },
      { id: 'c', type: 'agent', label: 'C', params: { prompt: 'do C' } },
      { id: 'end', type: 'end', params: {} },
    ],
    edges: [
      edge('e1', 'start', 'a'),
      edge('e2', 'a', 'b'),
      edge('e3', 'b', 'c'),
      edge('e4', 'c', 'end'),
      edge('d1', 'a', 'b', DATA),
      edge('d2', 'b', 'c', DATA),
    ],
    layout: {},
  };
}

describe('computeNodeHashes', () => {
  it('is stable across recomputation of the same graph', () => {
    const g = lineGraph();
    expect(computeNodeHashes(g)).toEqual(computeNodeHashes(structuredClone(g)));
  });

  it('ignores presentation-only fields (label/binding/numberLabel)', () => {
    const g = lineGraph();
    const before = computeNodeHashes(g);
    const g2 = structuredClone(g);
    const a = g2.nodes.find((n) => n.id === 'a')!;
    a.label = 'Renamed A';
    a.binding = 'renamedVar';
    a.numberLabel = 99;
    expect(computeNodeHashes(g2)).toEqual(before);
  });

  it('changes a node hash when its prompt changes', () => {
    const g = lineGraph();
    const before = computeNodeHashes(g);
    const g2 = structuredClone(g);
    g2.nodes.find((n) => n.id === 'b')!.params.prompt = 'do B differently';
    const after = computeNodeHashes(g2);
    expect(after.b).not.toBe(before.b);
  });

  it('propagates an upstream edit to ALL downstream node hashes', () => {
    const g = lineGraph();
    const before = computeNodeHashes(g);
    const g2 = structuredClone(g);
    // Edit `a` (upstream of b and c).
    g2.nodes.find((n) => n.id === 'a')!.params.prompt = 'do A v2';
    const after = computeNodeHashes(g2);
    expect(after.a).not.toBe(before.a);
    expect(after.b).not.toBe(before.b); // downstream changed
    expect(after.c).not.toBe(before.c); // transitively downstream changed
  });

  it('does NOT change an upstream hash when a downstream node is edited', () => {
    const g = lineGraph();
    const before = computeNodeHashes(g);
    const g2 = structuredClone(g);
    g2.nodes.find((n) => n.id === 'c')!.params.prompt = 'do C v2';
    const after = computeNodeHashes(g2);
    expect(after.a).toBe(before.a); // untouched prefix is stable
    expect(after.b).toBe(before.b);
    expect(after.c).not.toBe(before.c);
  });

  it('propagates a start-node userInputs edit to downstream nodes', () => {
    const g = lineGraph();
    const before = computeNodeHashes(g);
    const g2 = structuredClone(g);
    g2.nodes.find((n) => n.id === 'start')!.params.userInputs = ['请求 Y'];
    const after = computeNodeHashes(g2);
    expect(after.a).not.toBe(before.a);
    expect(after.c).not.toBe(before.c);
  });

  it('propagates a referenced schemaDef edit to the node that names it', () => {
    const g = lineGraph();
    g.meta.schemaDefs = { V: '{ ok: false }' };
    g.nodes.find((n) => n.id === 'b')!.params.schema = 'V';
    const before = computeNodeHashes(g);
    const g2 = structuredClone(g);
    g2.meta.schemaDefs = { V: '{ ok: false, extra: 0 }' };
    const after = computeNodeHashes(g2);
    expect(after.b).not.toBe(before.b); // schema body changed
    expect(after.c).not.toBe(before.c); // downstream of b
    expect(after.a).toBe(before.a); // upstream of b, unaffected
  });
});

describe('validCachedNodeIds', () => {
  it('returns empty when there is no seed', () => {
    const cur = computeNodeHashes(lineGraph());
    expect(validCachedNodeIds(cur, undefined).size).toBe(0);
  });

  it('returns only nodes whose hash matches the seed', () => {
    const g = lineGraph();
    const seed = computeNodeHashes(g);
    const g2 = structuredClone(g);
    g2.nodes.find((n) => n.id === 'b')!.params.prompt = 'changed';
    const cur = computeNodeHashes(g2);
    const valid = validCachedNodeIds(cur, seed);
    // a/start unchanged → valid; b changed and c downstream → invalid.
    expect(valid.has('a')).toBe(true);
    expect(valid.has('start')).toBe(true);
    expect(valid.has('b')).toBe(false);
    expect(valid.has('c')).toBe(false);
  });
});
