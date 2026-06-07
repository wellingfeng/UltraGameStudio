/**
 * Tests for the advisory determinism lint (core/determinism.ts). Mirrors
 * DeepSeek-Code-Whale's banned-token guard: Date.now()/Math.random()/new Date()
 * in codeblock bodies are flagged because they break content-addressed resume
 * and throw under real Claude Code. The lint is advisory (never blocks a run).
 */
import { describe, expect, it } from 'vitest';
import type { IRGraph } from '@/core/ir';
import { findDeterminismHazards, isDeterministicGraph } from '@/core/determinism';

function graphWithCodeblock(code: string): IRGraph {
  return {
    version: 1,
    meta: { name: 't', adapter: 'claude-code' },
    nodes: [
      { id: 'start', type: 'start', params: {} },
      { id: 'cb', type: 'codeblock', params: { code } },
      { id: 'end', type: 'end', params: {} },
    ],
    edges: [],
    layout: {},
  };
}

describe('findDeterminismHazards', () => {
  it('flags Date.now()', () => {
    const f = findDeterminismHazards(graphWithCodeblock('const t = Date.now();'));
    expect(f).toHaveLength(1);
    expect(f[0].token).toBe('Date.now');
    expect(f[0].nodeId).toBe('cb');
  });

  it('flags Math.random() and new Date()', () => {
    const f = findDeterminismHazards(
      graphWithCodeblock('const r = Math.random(); const d = new Date();'),
    );
    expect(f.map((x) => x.token).sort()).toEqual(['Math.random', 'new Date']);
  });

  it('does NOT flag tokens inside string literals or comments', () => {
    const g = graphWithCodeblock(
      'const s = "Date.now()"; // Math.random() in a comment\nconst x = 1;',
    );
    expect(findDeterminismHazards(g)).toHaveLength(0);
    expect(isDeterministicGraph(g)).toBe(true);
  });

  it('tolerates whitespace between the call and parens', () => {
    const f = findDeterminismHazards(graphWithCodeblock('Date.now ()'));
    expect(f).toHaveLength(1);
  });

  it('ignores non-codeblock nodes', () => {
    const g: IRGraph = {
      version: 1,
      meta: { name: 't', adapter: 'claude-code' },
      // An agent prompt mentioning Date.now() is just text, not executed JS.
      nodes: [{ id: 'a', type: 'agent', params: { prompt: 'explain Date.now()' } }],
      edges: [],
      layout: {},
    };
    expect(findDeterminismHazards(g)).toHaveLength(0);
  });

  it('returns empty for a clean codeblock', () => {
    expect(isDeterministicGraph(graphWithCodeblock('const x = args.value + 1;'))).toBe(true);
  });
});
