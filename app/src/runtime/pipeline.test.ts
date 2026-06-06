/**
 * Pipeline node tests — covers the two execution modes of runPipeline:
 *   - legacy single chain: stages run sequentially over one upstream input.
 *   - JSON-array fan-out: each `items` element runs the full stage chain
 *     independently and concurrently (Claude-Code `pipeline(items, …)` shape).
 *
 * Imports only `@/runtime` + a mock gateway, mirroring dag.test.ts, so this
 * stays a pure headless-engine test with no store/React/Tauri.
 */
import { describe, expect, it } from 'vitest';
import type { IRGraph, IRNode } from '@/core/ir';
import {
  runPipeline,
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

function callbacks(logs?: string[]): RunCallbacks {
  return {
    onNodeStart: () => {},
    onNodeSuccess: () => {},
    onNodeFailure: () => {},
    onLog: (m) => logs?.push(m),
    beginStream: () => ({ append: () => {}, finalize: () => {}, fail: () => {} }),
    isCancelled: () => false,
    promptInteraction: async () => null,
  };
}

function ctx(gateway: RunGateway, adapter = 'codex'): RunContext {
  return {
    selection: { adapter, modelClass: 'sonnet' },
    concurrency: 4,
    maxRetries: 0,
    consensusSamples: 3,
    gateway,
  };
}

function pipelineNode(params: Record<string, unknown>): IRNode {
  return { id: 'p', type: 'pipeline', label: 'P', params };
}

const EMPTY_GRAPH: IRGraph = {
  version: 1,
  meta: { name: 't', adapter: 'claude-code' },
  nodes: [],
  edges: [],
};

describe('runPipeline', () => {
  it('runs stages as one sequential chain when items is a scalar', async () => {
    const order: string[] = [];
    const gw = mockGateway(async (prompt) => {
      if (prompt.includes('STAGE-1')) {
        order.push('s1');
        return 'OUT-1';
      }
      // Stage 2 must receive stage 1's output.
      order.push(prompt.includes('OUT-1') ? 's2-got-1' : 's2-missing-1');
      return 'OUT-2';
    });
    const node = pipelineNode({
      items: 'just one input',
      stages: [{ prompt: 'STAGE-1' }, { prompt: 'STAGE-2' }],
    });

    const out = await runPipeline(ctx(gw), callbacks(), node, EMPTY_GRAPH, new Map());

    expect(order).toEqual(['s1', 's2-got-1']);
    expect(out).toBe('OUT-2');
  });

  it('fans out a JSON-array items list, running the stage chain per element', async () => {
    const seenStage1Items: string[] = [];
    const gw = mockGateway(async (prompt) => {
      if (prompt.includes('IMPLEMENT')) {
        const m = prompt.match(/当前条目 \(\d+\/\d+\): (\S+)/);
        if (m) seenStage1Items.push(m[1]);
        return `impl(${m?.[1] ?? '?'})`;
      }
      // VERIFY stage: echo the implementation it received.
      const im = prompt.match(/impl\(([^)]+)\)/);
      return `verified ${im?.[1] ?? '?'}`;
    });
    const node = pipelineNode({
      items: JSON.stringify(['src/a.ts', 'src/b.ts', 'src/c.ts']),
      stages: [{ prompt: 'IMPLEMENT' }, { prompt: 'VERIFY' }],
    });

    const out = await runPipeline(ctx(gw), callbacks(), node, EMPTY_GRAPH, new Map());

    expect(seenStage1Items.sort()).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    // One joined block per item, each carrying its verified final output.
    expect(out).toContain('verified src/a.ts');
    expect(out).toContain('verified src/b.ts');
    expect(out).toContain('verified src/c.ts');
    expect(out.match(/【条目 \d+\/3:/g)).toHaveLength(3);
  });

  it('keeps fan-out item chains isolated (no shared warm session id)', async () => {
    const sessionIds = new Set<string | undefined>();
    const gw = mockGateway(async (_prompt, opts) => {
      sessionIds.add(opts.sessionId);
      return 'ok';
    });
    const node = pipelineNode({
      items: JSON.stringify(['x', 'y']),
      stages: [{ prompt: 'A' }, { prompt: 'B' }],
    });

    await runPipeline(
      ctx(gw, 'claude-code'),
      callbacks(),
      node,
      EMPTY_GRAPH,
      new Map(),
    );

    // Two items ⇒ two distinct warm session ids (one chain each).
    expect(sessionIds.size).toBe(2);
  });

  it('survives partial item failure and reports the failed entry', async () => {
    const gw = mockGateway(async (prompt) => {
      if (prompt.includes('当前条目 (2/2): boom')) {
        throw new Error('CLI "claude" 退出码 1: kaboom');
      }
      return 'fine';
    });
    const node = pipelineNode({
      items: JSON.stringify(['ok', 'boom']),
      stages: [{ prompt: 'ONLY' }],
    });

    const out = await runPipeline(ctx(gw), callbacks(), node, EMPTY_GRAPH, new Map());

    expect(out).toContain('fine');
    expect(out).toContain('失败：');
  });

  it('treats an empty JSON array as legacy single-pass, not fan-out', async () => {
    let calls = 0;
    const gw = mockGateway(async () => {
      calls += 1;
      return 'single';
    });
    const node = pipelineNode({ items: '[]', stages: [{ prompt: 'ONLY' }] });

    const out = await runPipeline(ctx(gw), callbacks(), node, EMPTY_GRAPH, new Map());

    expect(calls).toBe(1);
    expect(out).toBe('single');
  });

  it('reduces a wide fan-out into one digest when reduceWhenOver is exceeded', async () => {
    let reduceCalled = false;
    const gw = mockGateway(async (prompt) => {
      if (prompt.includes('归约成一份紧凑的结构化摘要')) {
        reduceCalled = true;
        return 'DIGEST: 3 items summarized';
      }
      return 'item-out';
    });
    // 3 items > reduceWhenOver:2 ⇒ a reducing agent runs over the item finals.
    const node = pipelineNode({
      items: JSON.stringify(['a', 'b', 'c']),
      stages: [{ prompt: 'ONLY' }],
      reduceWhenOver: 2,
    });

    const out = await runPipeline(ctx(gw), callbacks(), node, EMPTY_GRAPH, new Map());

    expect(reduceCalled).toBe(true);
    expect(out).toBe('DIGEST: 3 items summarized');
  });

  it('does not reduce when fan-out width is within reduceWhenOver', async () => {
    let reduceCalled = false;
    const gw = mockGateway(async (prompt) => {
      if (prompt.includes('归约成一份紧凑的结构化摘要')) reduceCalled = true;
      return 'item-out';
    });
    const node = pipelineNode({
      items: JSON.stringify(['a', 'b']),
      stages: [{ prompt: 'ONLY' }],
      reduceWhenOver: 5,
    });

    const out = await runPipeline(ctx(gw), callbacks(), node, EMPTY_GRAPH, new Map());

    expect(reduceCalled).toBe(false);
    expect(out.match(/【条目 \d+\/2:/g)).toHaveLength(2);
  });

  it('caps fan-out width at the ceiling and logs the dropped items', async () => {
    let runs = 0;
    const gw = mockGateway(async () => {
      runs += 1;
      return 'x';
    });
    // 70 items > MAX_FAN_OUT_ITEMS (64): only 64 chains run, 6 dropped + logged.
    const items = Array.from({ length: 70 }, (_, i) => `item-${i}`);
    const node = pipelineNode({ items: JSON.stringify(items), stages: [{ prompt: 'ONLY' }] });
    const logs: string[] = [];

    const out = await runPipeline(ctx(gw), callbacks(logs), node, EMPTY_GRAPH, new Map());

    expect(runs).toBe(64);
    expect(out.match(/【条目 \d+\/64:/g)).toHaveLength(64);
    expect(logs.some((l) => l.includes('已丢弃后 6 条'))).toBe(true);
  });
});
