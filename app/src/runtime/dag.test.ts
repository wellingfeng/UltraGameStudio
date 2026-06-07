/**
 * Headless run-engine tests. These import ONLY `@/runtime` (no store / React /
 * Tauri), proving the engine runs against injected callbacks + a mock gateway —
 * exactly what the future Node CLI will provide. Covers exec/data ordering,
 * data-context threading, parallel fan-out, auto-retry of transient failures,
 * terminal failure recording, and cancellation.
 */
import { describe, expect, it } from 'vitest';
import { EXEC, DATA, type IRGraph, type PinKind } from '@/core/ir';
import {
  classifyVotingNode,
  executeWorkflowDag,
  isExecTerminalNode,
  type RunCallbacks,
  type RunContext,
  type RunGateway,
  type SpawnCliAgentOpts,
} from '@/runtime';

function edge(id: string, from: string, to: string, kind: PinKind = EXEC) {
  return { id, from: { node: from, port: 'o' }, to: { node: to, port: 'i' }, kind };
}

/** A linear agent chain: start → a → b → end, with a data edge a → b. */
function chainGraph(): IRGraph {
  return {
    version: 1,
    meta: { name: 't', adapter: 'claude-code' },
    nodes: [
      { id: 'start', type: 'start', params: {} },
      { id: 'a', type: 'agent', label: 'A', params: { prompt: 'do A' } },
      { id: 'b', type: 'agent', label: 'B', params: { prompt: 'do B' } },
      { id: 'end', type: 'end', params: {} },
    ],
    edges: [
      edge('e1', 'start', 'a'),
      edge('e2', 'a', 'b'),
      edge('e3', 'b', 'end'),
      edge('e4', 'a', 'b', DATA),
    ],
    layout: {},
  };
}

/** A mock gateway that always spawns the CLI (no direct route) and runs `respond`. */
function mockGateway(
  respond: (prompt: string, opts: SpawnCliAgentOpts) => Promise<string>,
): RunGateway {
  return {
    resolveDirectRoute: () => null,
    resolveCliRoute: async () => ({ adapter: 'claude-code', cliCommand: 'claude' }),
    completeText: async () => ({ text: '', adapter: 'claude-code' }),
    spawnCliAgent: (prompt, _adapter, opts) => respond(prompt, opts),
    applyOverride: (s) => s,
    recordCall: () => {},
    timeoutPolicy: () => ({ timeoutSeconds: 600, idleTimeoutSeconds: 180 }),
    effectiveConcurrency: (n) => n,
    effectiveConsensusSamples: (n) => n,
    nodeGatewayOverride: () => undefined,
    modelClassFromModelId: () => 'sonnet',
  };
}

function collectingCallbacks(log: string[]): RunCallbacks {
  return {
    onNodeStart: (n) => log.push(`start:${n.id}`),
    onNodeSuccess: (n) => log.push(`ok:${n.id}`),
    onNodeFailure: (n, _f, state) => log.push(`fail:${n.id}:${state}`),
    onLog: () => {},
    beginStream: () => ({ append: () => {}, finalize: () => {}, fail: () => {} }),
    isCancelled: () => false,
    promptInteraction: async () => null,
  };
}

function ctx(gateway: RunGateway, overrides: Partial<RunContext> = {}): RunContext {
  return {
    selection: { adapter: 'claude-code', modelClass: 'sonnet' },
    concurrency: 4,
    maxRetries: 2,
    consensusSamples: 3,
    gateway,
    ...overrides,
  };
}

describe('executeWorkflowDag', () => {
  it('runs an exec chain in order and threads data context downstream', async () => {
    const seen: string[] = [];
    const gw = mockGateway(async (prompt) => {
      if (prompt.includes('do A')) return 'A-OUTPUT';
      // B must receive A's output via the data edge.
      seen.push(prompt.includes('A-OUTPUT') ? 'B-got-A' : 'B-missing-A');
      return 'B-OUTPUT';
    });
    const log: string[] = [];
    const result = await executeWorkflowDag(
      chainGraph(),
      collectingCallbacks(log),
      ctx(gw, { selection: { adapter: 'codex', modelClass: 'sonnet' } }),
    );

    expect(result.success).toBe(true);
    expect(seen).toEqual(['B-got-A']);
    expect(result.outputs.a).toBe('A-OUTPUT');
    expect(result.outputs.b).toBe('B-OUTPUT');
    // start before a before b before end.
    expect(log.indexOf('ok:a')).toBeLessThan(log.indexOf('start:b'));
    expect(log.indexOf('ok:b')).toBeLessThan(log.indexOf('ok:end'));
  });

  it('does not duplicate same-chain data context when resuming a warm CLI session', async () => {
    const seenB: string[] = [];
    const sessions: SpawnCliAgentOpts[] = [];
    const gw = mockGateway(async (prompt, opts) => {
      sessions.push(opts);
      if (prompt.includes('do A')) return 'A-OUTPUT';
      if (prompt.includes('do B')) {
        seenB.push(prompt);
        return 'B-OUTPUT';
      }
      return '';
    });
    const result = await executeWorkflowDag(chainGraph(), collectingCallbacks([]), ctx(gw));

    expect(result.success).toBe(true);
    expect(seenB).toHaveLength(1);
    expect(seenB[0]).not.toContain('A-OUTPUT');
    expect(sessions[0].sessionId).toBeTruthy();
    expect(sessions[1].sessionId).toBe(sessions[0].sessionId);
    expect(sessions[1].resume).toBe(true);
  });

  it('keeps data context on direct HTTP routes because they have no warm session', async () => {
    const seen: string[] = [];
    const gw: RunGateway = {
      ...mockGateway(async () => ''),
      resolveDirectRoute: () => ({ adapter: 'claude-code' }),
      completeText: async ({ prompt }) => {
        if (prompt.includes('do A')) return { text: 'A-OUTPUT', adapter: 'claude-code' };
        seen.push(prompt.includes('A-OUTPUT') ? 'B-got-A' : 'B-missing-A');
        return { text: 'B-OUTPUT', adapter: 'claude-code' };
      },
    };
    const result = await executeWorkflowDag(chainGraph(), collectingCallbacks([]), ctx(gw));

    expect(result.success).toBe(true);
    expect(seen).toEqual(['B-got-A']);
  });

  it('auto-retries a transient failure then succeeds', async () => {
    let attempts = 0;
    const gw = mockGateway(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('CLI "claude" 退出码 1: boom');
      return 'recovered';
    });
    const log: string[] = [];
    const g: IRGraph = {
      version: 1,
      meta: { name: 't', adapter: 'claude-code' },
      nodes: [
        { id: 'start', type: 'start', params: {} },
        { id: 'a', type: 'agent', label: 'A', params: { prompt: 'go' } },
        { id: 'end', type: 'end', params: {} },
      ],
      edges: [edge('e1', 'start', 'a'), edge('e2', 'a', 'end')],
      layout: {},
    };
    const result = await executeWorkflowDag(g, collectingCallbacks(log), ctx(gw));
    expect(attempts).toBe(2);
    expect(result.success).toBe(true);
    expect(result.nodeResults.a.retryCount).toBe(1);
  });

  it('records the first failure as the resume point and reports failure', async () => {
    const gw = mockGateway(async () => {
      throw new Error('启动 CLI "claude" 失败: not found'); // spawn = non-retryable
    });
    const log: string[] = [];
    const g: IRGraph = {
      version: 1,
      meta: { name: 't', adapter: 'claude-code' },
      nodes: [
        { id: 'start', type: 'start', params: {} },
        { id: 'a', type: 'agent', label: 'A', params: { prompt: 'go' } },
        { id: 'end', type: 'end', params: {} },
      ],
      edges: [edge('e1', 'start', 'a'), edge('e2', 'a', 'end')],
      layout: {},
    };
    const result = await executeWorkflowDag(g, collectingCallbacks(log), ctx(gw));
    expect(result.success).toBe(false);
    expect(result.failedNodeId).toBe('a');
    expect(result.error?.code).toBe('spawn');
    expect(log).toContain('fail:a:error');
  });

  it('fans out a parallel node across branches', async () => {
    let maxConcurrent = 0;
    let active = 0;
    const gw = mockGateway(async () => {
      active += 1;
      maxConcurrent = Math.max(maxConcurrent, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return 'branch-out';
    });
    const g: IRGraph = {
      version: 1,
      meta: { name: 't', adapter: 'claude-code' },
      nodes: [
        { id: 'start', type: 'start', params: {} },
        {
          id: 'p',
          type: 'parallel',
          label: 'P',
          params: { branches: [{ prompt: 'x' }, { prompt: 'y' }, { prompt: 'z' }] },
        },
        { id: 'end', type: 'end', params: {} },
      ],
      edges: [edge('e1', 'start', 'p'), edge('e2', 'p', 'end')],
      layout: {},
    };
    const result = await executeWorkflowDag(g, collectingCallbacks([]), ctx(gw));
    expect(result.success).toBe(true);
    expect(maxConcurrent).toBeGreaterThan(1); // genuine fan-out
    expect(result.outputs.p).toContain('branch-out');
  });

  it('stops scheduling once cancelled', async () => {
    let cancelled = false;
    const log: string[] = [];
    const gw = mockGateway(async () => {
      cancelled = true; // cancel after the first node runs
      return 'first';
    });
    const callbacks: RunCallbacks = {
      ...collectingCallbacks(log),
      isCancelled: () => cancelled,
    };
    const result = await executeWorkflowDag(chainGraph(), callbacks, ctx(gw));
    expect(result.success).toBe(false); // cancelled mid-run
  });
});
/** A single terminal agent node: start → a → end. `a` is the exec-spine tail. */
function singleAgentGraph(prompt = 'do the work'): IRGraph {
  return {
    version: 1,
    meta: { name: 't', adapter: 'claude-code' },
    nodes: [
      { id: 'start', type: 'start', params: {} },
      { id: 'a', type: 'agent', label: 'A', params: { prompt } },
      { id: 'end', type: 'end', params: {} },
    ],
    edges: [edge('e1', 'start', 'a'), edge('e2', 'a', 'end')],
    layout: {},
  };
}

describe('adaptive divergence escalation (run-time voting)', () => {
  // The escalation loop sends three kinds of prompt to the gateway:
  //  - sample prompts (the node's own basePrompt),
  //  - a judge prompt asking for a `disagreement: 0..1` score (prose path),
  //  - a final vote/synthesis prompt that lists 【候选 N】 blocks.
  // We classify by content so the sample counter only counts real samples.
  const VOTE = (p: string) => p.includes('【候选');
  const JUDGE = (p: string) => p.includes('disagreement');

  const voteCtx = (over: Partial<RunContext> = {}) =>
    ({
      runtimeVoteSamplesMin: 2,
      runtimeVoteSamplesMax: 16,
      terminalVoteSamplesMin: 2,
      terminalVoteSamplesMax: 16,
      adaptiveEscalation: true,
      maxRetries: 0, // isolate the voting path from node-level retry
      ...over,
    }) as Partial<RunContext>;

  it('runs a single call when voting is disabled (max<=1) — default headless parity', async () => {
    let samples = 0;
    const gw = mockGateway(async () => {
      samples += 1;
      return 'answer';
    });
    // No *VoteSamplesMax in ctx ⇒ undefined ⇒ voting off.
    const result = await executeWorkflowDag(singleAgentGraph(), collectingCallbacks([]), ctx(gw));
    expect(result.success).toBe(true);
    expect(samples).toBe(1); // exactly one call, no fan-out
  });

  it('runs MIN samples + one vote and does NOT escalate when outputs agree', async () => {
    let samples = 0;
    let judgeCalls = 0;
    const gw = mockGateway(async (prompt) => {
      if (JUDGE(prompt)) {
        judgeCalls += 1;
        return 'disagreement: 0.0';
      }
      if (VOTE(prompt)) return 'final';
      samples += 1;
      return 'SAME'; // all samples identical
    });
    const result = await executeWorkflowDag(
      singleAgentGraph(),
      collectingCallbacks([]),
      ctx(gw, voteCtx()),
    );
    expect(result.success).toBe(true);
    expect(samples).toBe(2); // started at min=2
    expect(judgeCalls).toBe(1); // measured divergence once, then converged
    expect(result.outputs.a).toBe('final');
  });

  it('escalates 2→4→8 on sustained disagreement, reusing prior samples, until it converges', async () => {
    let samples = 0;
    let judgeRound = 0;
    const gw = mockGateway(async (prompt) => {
      if (JUDGE(prompt)) {
        judgeRound += 1;
        // High disagreement for the first two measurements, then converge.
        return judgeRound < 3 ? 'disagreement: 0.9' : 'disagreement: 0.1';
      }
      if (VOTE(prompt)) return 'final';
      samples += 1;
      return `out-${samples}`; // distinct outputs
    });
    const result = await executeWorkflowDag(
      singleAgentGraph(),
      collectingCallbacks([]),
      ctx(gw, voteCtx()),
    );
    expect(result.success).toBe(true);
    // 2 (start) → +2 → +4 = 8 accumulated samples (delta reuse: not 2+4+8).
    expect(samples).toBe(8);
    expect(result.outputs.a).toBe('final');
  });

  it('respects the master switch OFF — runs MIN, votes once, never doubles', async () => {
    let samples = 0;
    let judgeCalls = 0;
    const gw = mockGateway(async (prompt) => {
      if (JUDGE(prompt)) {
        judgeCalls += 1;
        return 'disagreement: 1.0';
      }
      if (VOTE(prompt)) return 'final';
      samples += 1;
      return `out-${samples}`;
    });
    const result = await executeWorkflowDag(
      singleAgentGraph(),
      collectingCallbacks([]),
      ctx(gw, voteCtx({ adaptiveEscalation: false })),
    );
    expect(result.success).toBe(true);
    expect(samples).toBe(2); // capped at min, no escalation
    expect(judgeCalls).toBe(0); // off ⇒ no divergence measurement at all
    expect(result.outputs.a).toBe('final');
  });

  it('does not disable voting when one sample of the first batch fails', async () => {
    let calls = 0;
    const gw = mockGateway(async (prompt) => {
      if (JUDGE(prompt)) return 'disagreement: 0.0';
      if (VOTE(prompt)) return 'voted-final';
      calls += 1;
      if (calls === 1) throw new Error('CLI "claude" 退出码 1: flaky'); // 1st sample fails
      return 'good';
    });
    const result = await executeWorkflowDag(
      singleAgentGraph(),
      collectingCallbacks([]),
      ctx(gw, voteCtx()),
    );
    expect(result.success).toBe(true);
    // 1st batch: 1 ok + 1 fail ⇒ oks<2 ⇒ tops up more ⇒ ≥2 oks ⇒ votes.
    expect(result.outputs.a).toBe('voted-final');
  });

  it('caps escalation by the run-level budget', async () => {
    let samples = 0;
    const gw = mockGateway(async (prompt) => {
      if (JUDGE(prompt)) return 'disagreement: 0.9'; // never converges
      if (VOTE(prompt)) return 'final';
      samples += 1;
      return `out-${samples}`;
    });
    const result = await executeWorkflowDag(
      singleAgentGraph(),
      collectingCallbacks([]),
      ctx(gw, voteCtx({ escalationBudget: 3, escalationSpent: 0 })),
    );
    expect(result.success).toBe(true);
    // start=2, budget allows only +3 extra ⇒ at most 5 samples (not 16).
    expect(samples).toBeLessThanOrEqual(5);
    expect(result.outputs.a).toBe('final');
  });
});

describe('classifyVotingNode (UI marker ↔ engine parity)', () => {
  // start → a → b(末端) → end ; plus a mid-graph "验证" node m with a successor.
  const g: IRGraph = {
    version: 1,
    meta: { name: 't', adapter: 'claude-code' },
    nodes: [
      { id: 'start', type: 'start', params: {} },
      { id: 'a', type: 'agent', label: '抓取', params: { prompt: '下载页面' } },
      { id: 'm', type: 'agent', label: '验证输入', params: { prompt: '验证后继续处理下一步' } },
      { id: 'b', type: 'agent', label: '汇总', params: { prompt: '汇总并输出最终结论' } },
      { id: 'end', type: 'end', params: {} },
    ],
    edges: [
      edge('e1', 'start', 'a'),
      edge('e2', 'a', 'm'),
      edge('e3', 'm', 'b'),
      edge('e4', 'b', 'end'),
    ],
    layout: {},
  };
  const byId = (id: string) => g.nodes.find((n) => n.id === id)!;

  it('marks the exec-spine tail as a terminal voting node', () => {
    const c = classifyVotingNode(byId('b'), g);
    expect(c.willVote).toBe(true);
    expect(c.kind).toBe('terminal');
    expect(c.reasons).toContain('执行链尾');
  });

  it('does NOT mark a mid-graph node whose label contains 验证 but has a successor', () => {
    const c = classifyVotingNode(byId('m'), g);
    // succ('m') = 1 (→ b), and it is not a long/complex prompt ⇒ not terminal, not complex.
    expect(c.kind).not.toBe('terminal');
  });

  it('marks a long / high-stakes prompt as a complex voting node', () => {
    const complex: IRGraph = {
      ...g,
      nodes: g.nodes.map((n) =>
        n.id === 'a'
          ? {
              ...n,
              label: '安全审计',
              params: { prompt: '请做安全审计：首先 X；其次 Y；然后 Z；并交叉验证。'.repeat(8) },
            }
          : n,
      ),
    };
    const c = classifyVotingNode(complex.nodes.find((n) => n.id === 'a')!, complex);
    expect(c.willVote).toBe(true);
    expect(c.kind).toBe('complex');
    expect(c.reasons.length).toBeGreaterThan(0);
  });

  it('agrees with isExecTerminalNode for terminal nodes', () => {
    expect(isExecTerminalNode(byId('b'), g)).toBe(true);
    expect(isExecTerminalNode(byId('a'), g)).toBe(false);
  });

  it('leaves ordinary mid-graph nodes unmarked', () => {
    expect(classifyVotingNode(byId('a'), g).willVote).toBe(false);
  });
});

describe('executeWorkflowDag — hash-checked resume', () => {
  it('reuses a seeded output when the node hash still matches (no re-run)', async () => {
    let aCalls = 0;
    const gw = mockGateway(async (prompt) => {
      if (prompt.includes('do A')) {
        aCalls += 1;
        return 'A-FRESH';
      }
      return 'B-OUTPUT';
    });
    const g = chainGraph();
    // First run to capture this graph's node hashes.
    const first = await executeWorkflowDag(g, collectingCallbacks([]), ctx(gw));
    expect(aCalls).toBe(1);
    // Resume the SAME graph: a's seeded output should be reused (a not re-run).
    aCalls = 0;
    const second = await executeWorkflowDag(g, collectingCallbacks([]), ctx(gw), {
      seedOutputs: { a: 'A-CACHED' },
      seedNodeHashes: first.nodeHashes,
    });
    expect(second.success).toBe(true);
    expect(aCalls).toBe(0); // a reused from cache
    expect(second.outputs.a).toBe('A-CACHED');
  });

  it('drops a stale seeded output when the node was edited since the seed run', async () => {
    let aCalls = 0;
    const gw = mockGateway(async (prompt) => {
      if (prompt.includes('do A')) {
        aCalls += 1;
        return 'A-FRESH';
      }
      return 'B-OUTPUT';
    });
    const g = chainGraph();
    const first = await executeWorkflowDag(g, collectingCallbacks([]), ctx(gw));
    // Edit node a's prompt — its hash changes, so the seed no longer matches.
    const edited = structuredClone(g);
    edited.nodes.find((n) => n.id === 'a')!.params.prompt = 'do A v2';
    aCalls = 0;
    const second = await executeWorkflowDag(edited, collectingCallbacks([]), ctx(gw), {
      seedOutputs: { a: 'A-CACHED' }, // stale cache must be ignored
      seedNodeHashes: first.nodeHashes,
    });
    expect(second.success).toBe(true);
    expect(aCalls).toBe(1); // a re-ran because its hash changed
    expect(second.outputs.a).toBe('A-FRESH');
  });

  it('re-runs downstream when an upstream edit invalidates its hash', async () => {
    let bCalls = 0;
    const gw = mockGateway(async (prompt) => {
      if (prompt.includes('do A')) return 'A-FRESH';
      if (prompt.includes('do B')) {
        bCalls += 1;
        return 'B-FRESH';
      }
      return '';
    });
    const g = chainGraph();
    const first = await executeWorkflowDag(g, collectingCallbacks([]), ctx(gw));
    // Edit a (upstream of b). b's hash changes too ⇒ its seeded output is dropped.
    const edited = structuredClone(g);
    edited.nodes.find((n) => n.id === 'a')!.params.prompt = 'do A v2';
    bCalls = 0;
    const second = await executeWorkflowDag(edited, collectingCallbacks([]), ctx(gw), {
      seedOutputs: { a: 'A-CACHED', b: 'B-CACHED' },
      seedNodeHashes: first.nodeHashes,
    });
    expect(second.success).toBe(true);
    expect(bCalls).toBe(1); // downstream re-ran due to upstream edit
    expect(second.outputs.b).toBe('B-FRESH');
  });

  it('without seedNodeHashes falls back to legacy reuse-by-id (backward compatible)', async () => {
    let aCalls = 0;
    const gw = mockGateway(async (prompt) => {
      if (prompt.includes('do A')) {
        aCalls += 1;
        return 'A-FRESH';
      }
      return 'B-OUTPUT';
    });
    const second = await executeWorkflowDag(chainGraph(), collectingCallbacks([]), ctx(gw), {
      seedOutputs: { a: 'A-CACHED' }, // legacy: trusted by id, no hash check
    });
    expect(second.success).toBe(true);
    expect(aCalls).toBe(0); // reused by id as before
    expect(second.outputs.a).toBe('A-CACHED');
  });
});
