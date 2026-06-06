/**
 * Acceptance-gate machine-level veto tests. Verifies that for verdict-style
 * consensus (adversarial / multi-lens) a quorum of explicit `pass: false` votes
 * fails the gate deterministically — the downstream synthesis agent must not be
 * able to overturn the skeptics. Non-verdict candidates fall through to normal
 * synthesis. Imports only `@/runtime` + a mock gateway.
 */
import { describe, expect, it } from 'vitest';
import type { IRGraph, IRNode } from '@/core/ir';
import {
  resolveConsensus,
  type RunCallbacks,
  type RunContext,
  type RunGateway,
  type SpawnCliAgentOpts,
} from '@/runtime';

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

function callbacks(logs: string[] = []): RunCallbacks {
  return {
    onNodeStart: () => {},
    onNodeSuccess: () => {},
    onNodeFailure: () => {},
    onLog: (m) => logs.push(m),
    beginStream: () => ({ append: () => {}, finalize: () => {}, fail: () => {} }),
    isCancelled: () => false,
    promptInteraction: async () => null,
  };
}

function ctx(gateway: RunGateway): RunContext {
  return {
    selection: { adapter: 'codex', modelClass: 'sonnet' },
    concurrency: 4,
    maxRetries: 0,
    consensusSamples: 3,
    gateway,
  };
}

const NODE: IRNode = { id: 'gate', type: 'consensus', label: '验收门', params: {} };
const GRAPH: IRGraph = { version: 1, meta: { name: 't', adapter: 'claude-code' }, nodes: [], edges: [] };

function verdict(pass: boolean, reason = ''): string {
  return JSON.stringify({
    pass,
    acceptedArtifact: pass ? 'done' : '',
    evidence: [],
    criteriaCoverage: [],
    gaps: pass ? [] : [{ taskId: 't1', severity: 'P1', reason, nextAction: 'fix' }],
  });
}

describe('resolveConsensus machine-level veto', () => {
  it('fails the gate when a quorum votes pass:false, without calling synthesis', async () => {
    let synthesisCalled = false;
    const gw = mockGateway(async () => {
      synthesisCalled = true;
      // A rogue synthesis agent that tries to pass anyway.
      return verdict(true);
    });
    const logs: string[] = [];
    // 2 of 3 vote fail, quorum 2 ⇒ machine veto.
    const candidates = [verdict(false, '证据不足'), verdict(false, '目标漂移'), verdict(true)];

    const out = await resolveConsensus(
      ctx(gw),
      callbacks(logs),
      NODE,
      GRAPH,
      candidates,
      'adversarial',
      2,
      { adapter: 'codex', modelClass: 'sonnet' },
    );

    expect(synthesisCalled).toBe(false);
    const parsed = JSON.parse(out);
    expect(parsed.pass).toBe(false);
    // Rejecting verdicts' gaps are carried forward.
    expect(parsed.gaps.length).toBeGreaterThanOrEqual(2);
    expect(logs.some((l) => l.includes('机器级否决'))).toBe(true);
  });

  it('allows synthesis to proceed when fail votes are below quorum', async () => {
    let synthesisCalled = false;
    const gw = mockGateway(async () => {
      synthesisCalled = true;
      return verdict(true);
    });
    // Only 1 of 3 votes fail, quorum 2 ⇒ no veto.
    const candidates = [verdict(true), verdict(true), verdict(false, 'minor')];

    const out = await resolveConsensus(
      ctx(gw),
      callbacks(),
      NODE,
      GRAPH,
      candidates,
      'adversarial',
      2,
      { adapter: 'codex', modelClass: 'sonnet' },
    );

    expect(synthesisCalled).toBe(true);
    expect(JSON.parse(out).pass).toBe(true);
  });

  it('does not veto non-verdict candidates (no parseable pass field)', async () => {
    let synthesisCalled = false;
    const gw = mockGateway(async () => {
      synthesisCalled = true;
      return 'synthesized answer';
    });
    const candidates = ['just prose A', 'just prose B', 'just prose C'];

    const out = await resolveConsensus(
      ctx(gw),
      callbacks(),
      NODE,
      GRAPH,
      candidates,
      'multi-lens',
      2,
      { adapter: 'codex', modelClass: 'sonnet' },
    );

    expect(synthesisCalled).toBe(true);
    expect(out).toBe('synthesized answer');
  });
});
