import { DATA, EXEC, type IREdge, type IRGraph, type IRNode } from './ir';
import { sampleWorkflow } from './sample';
import { defaultBlueprint, captainBlueprint } from './defaultBlueprint';

/**
 * Round-trip fixtures exercising the runnable-fidelity emitter/parser:
 * thunk-array parallel, stage-callback pipeline, real if/while nesting,
 * cross-scope data flow, and schema preamble. Consumed by roundtrip.ts.
 */

const exec = (from: string, to: string): IREdge => ({
  id: `e_${from}_${to}`,
  from: { node: from, port: 'exec_out' },
  to: { node: to, port: 'exec_in' },
  kind: EXEC,
});

const data = (from: string, to: string): IREdge => ({
  id: `d_${from}_${to}`,
  from: { node: from, port: 'data_out' },
  to: { node: to, port: 'data_in' },
  kind: DATA,
});

/** A data edge with explicit ports (for composite port-binding edges). */
const portData = (
  from: string,
  fromPort: string,
  to: string,
  toPort: string,
): IREdge => ({
  id: `d_${from}_${to}`,
  from: { node: from, port: fromPort },
  to: { node: to, port: toPort },
  kind: DATA,
});

const start: IRNode = { id: 'n_start', type: 'start', label: 'Start', params: {} };
const end: IRNode = { id: 'n_end', type: 'end', label: 'End', params: {} };

const grid = (ids: string[]): Record<string, { x: number; y: number }> =>
  Object.fromEntries(ids.map((id, i) => [id, { x: i * 240, y: 160 }]));

/** F2 — variable → pipeline(items, 2 schema stages) → end. */
export const pipelineSample: IRGraph = {
  version: 1,
  meta: {
    name: 'pipeline-sample',
    adapter: 'claude-code',
    schemaDefs: { REVIEW: '{ ok: false }', VERDICT: '{ pass: false }' },
  },
  nodes: [
    start,
    { id: 'n_files', type: 'variable', label: 'files', params: { name: 'files', value: "['src/a.ts', 'src/b.ts']", raw: true } },
    {
      id: 'n_pipe',
      type: 'pipeline',
      label: 'Pipeline',
      params: {
        items: 'files',
        stages: [
          { prompt: '审查 ${item}', schema: 'REVIEW' },
          { prompt: '验证 ${item} 的发现', schema: 'VERDICT' },
        ],
      },
    },
    end,
  ],
  edges: [exec('n_start', 'n_pipe'), exec('n_pipe', 'n_end'), data('n_files', 'n_pipe')],
  layout: grid(['n_start', 'n_files', 'n_pipe', 'n_end']),
};

/** F3 — branch containing two child agents, on the top spine. */
export const branchSample: IRGraph = {
  version: 1,
  meta: { name: 'branch-sample', adapter: 'claude-code' },
  nodes: [
    start,
    { id: 'n_setup', type: 'agent', label: 'Setup', params: { prompt: '准备数据', model: 'haiku' } },
    { id: 'n_branch', type: 'branch', label: '分支', params: { condition: 'setup.ok' } },
    { id: 'n_c1', type: 'agent', parent: 'n_branch', label: 'Fix', params: { prompt: '修复问题' } },
    { id: 'n_c2', type: 'agent', parent: 'n_branch', label: 'Report', params: { prompt: '汇报结果' } },
    { id: 'n_after', type: 'agent', label: 'After', params: { prompt: '收尾' } },
    end,
  ],
  edges: [
    exec('n_start', 'n_setup'),
    exec('n_setup', 'n_branch'),
    exec('n_branch', 'n_after'),
    exec('n_after', 'n_end'),
    exec('n_branch', 'n_c1'),
    exec('n_c1', 'n_c2'),
  ],
  layout: grid(['n_start', 'n_setup', 'n_branch', 'n_c1', 'n_c2', 'n_after', 'n_end']),
};

/** F4 — loop containing an agent that consumes a top-scope variable (data edge). */
export const loopSample: IRGraph = {
  version: 1,
  meta: { name: 'loop-sample', adapter: 'claude-code' },
  nodes: [
    start,
    { id: 'n_seed', type: 'variable', label: 'seed', params: { name: 'seed', value: '0', raw: true } },
    { id: 'n_loop', type: 'loop', label: '循环', params: { condition: 'false' } },
    { id: 'n_step', type: 'agent', parent: 'n_loop', label: 'Step', params: { prompt: '处理一轮' } },
    end,
  ],
  edges: [
    exec('n_start', 'n_loop'),
    exec('n_loop', 'n_end'),
    exec('n_loop', 'n_step'),
    data('n_seed', 'n_step'),
  ],
  layout: grid(['n_start', 'n_seed', 'n_loop', 'n_step', 'n_end']),
};

/** F5 — branch whose child is a loop with an inner agent (depth ≥2). */
export const nestedSample: IRGraph = {
  version: 1,
  meta: { name: 'nested-sample', adapter: 'claude-code' },
  nodes: [
    start,
    { id: 'n_b', type: 'branch', label: '分支', params: { condition: 'true' } },
    { id: 'n_l', type: 'loop', parent: 'n_b', label: '循环', params: { condition: 'false' } },
    { id: 'n_inner', type: 'agent', parent: 'n_l', label: 'Inner', params: { prompt: '内层步骤' } },
    end,
  ],
  edges: [
    exec('n_start', 'n_b'),
    exec('n_b', 'n_end'),
    exec('n_b', 'n_l'),
    exec('n_l', 'n_inner'),
  ],
  layout: grid(['n_start', 'n_b', 'n_l', 'n_inner', 'n_end']),
};

/**
 * F7 — composite (single input + single output). A `topic` variable feeds the
 * composite's `in_topic` input port; inside, two chained agents (a1 → a2) produce
 * the result; the `out_summary` output port flows to a downstream consumer agent.
 * Exercises: body-entry edge, inner data edge, inner input/output port bindings,
 * outer input/output port bindings.
 */
export const compositeSingleSample: IRGraph = {
  version: 1,
  meta: { name: 'composite-single', adapter: 'claude-code' },
  nodes: [
    start,
    { id: 'n_topic', type: 'variable', label: 'topic', params: { name: 'topic', value: "'缓存层'", raw: true } },
    {
      id: 'c1',
      type: 'composite',
      label: 'Composite',
      params: {
        inputs: [{ id: 'in_topic', direction: 'in', kind: DATA, label: 'topic' }],
        outputs: [{ id: 'out_summary', direction: 'out', kind: DATA, label: 'summary' }],
      },
    },
    { id: 'a1', type: 'agent', parent: 'c1', label: 'Research', params: { prompt: '深入研究该主题。' } },
    { id: 'a2', type: 'agent', parent: 'c1', label: 'Summarize', params: { prompt: '总结研究发现。' } },
    { id: 'n_consumer', type: 'agent', label: 'Consumer', params: { prompt: '基于结果撰写报告。' } },
    end,
  ],
  edges: [
    // exec spine (top scope) + body entry.
    exec('n_start', 'c1'),
    exec('c1', 'n_consumer'),
    exec('n_consumer', 'n_end'),
    exec('c1', 'a1'),
    exec('a1', 'a2'),
    // inner data edge.
    data('a1', 'a2'),
    // inner input binding: composite input port → first inner consumer.
    portData('c1', 'in_topic', 'a1', 'data_in'),
    // inner output binding: inner producer → composite output port.
    portData('a2', 'data_out', 'c1', 'out_summary'),
    // outer input binding: outer producer → composite input port.
    portData('n_topic', 'data_out', 'c1', 'in_topic'),
    // outer output binding: composite output port → downstream consumer.
    portData('c1', 'out_summary', 'n_consumer', 'data_in'),
  ],
  layout: grid(['n_start', 'n_topic', 'c1', 'a1', 'a2', 'n_consumer', 'n_end']),
};

/**
 * F8 — nested composite (a composite inside a composite). Verifies unlimited
 * nesting + nested local function declarations. Outer composite `outer` has one
 * input + one output; its body contains an inner composite `inner` (also 1-in/1-out)
 * plus a trailing agent. Data threads outer-input → inner → trailing agent → outer-output.
 */
export const compositeNestedSample: IRGraph = {
  version: 1,
  meta: { name: 'composite-nested', adapter: 'claude-code' },
  nodes: [
    start,
    { id: 'n_seed', type: 'variable', label: 'seed', params: { name: 'seed', value: "'数据'", raw: true } },
    {
      id: 'outer',
      type: 'composite',
      label: 'Outer',
      params: {
        inputs: [{ id: 'o_in', direction: 'in', kind: DATA, label: 'src' }],
        outputs: [{ id: 'o_out', direction: 'out', kind: DATA, label: 'result' }],
      },
    },
    {
      id: 'inner',
      type: 'composite',
      parent: 'outer',
      label: 'Inner',
      params: {
        inputs: [{ id: 'i_in', direction: 'in', kind: DATA, label: 'x' }],
        outputs: [{ id: 'i_out', direction: 'out', kind: DATA, label: 'y' }],
      },
    },
    { id: 'ia', type: 'agent', parent: 'inner', label: 'InnerStep', params: { prompt: '处理输入。' } },
    { id: 'oa', type: 'agent', parent: 'outer', label: 'OuterStep', params: { prompt: '加工结果。' } },
    end,
  ],
  edges: [
    // top-scope exec spine + outer body entry.
    exec('n_start', 'outer'),
    exec('outer', 'n_end'),
    exec('outer', 'inner'),
    exec('inner', 'oa'),
    // inner body entry.
    exec('inner', 'ia'),
    // outer input binding (outer): seed → outer.o_in.
    portData('n_seed', 'data_out', 'outer', 'o_in'),
    // outer input → inner composite input (inside outer body): outer.o_in → inner.i_in.
    portData('outer', 'o_in', 'inner', 'i_in'),
    // inner input → inner agent: inner.i_in → ia.
    portData('inner', 'i_in', 'ia', 'data_in'),
    // inner output binding: ia → inner.i_out.
    portData('ia', 'data_out', 'inner', 'i_out'),
    // inner output → outer trailing agent: inner.i_out → oa.
    portData('inner', 'i_out', 'oa', 'data_in'),
    // outer output binding: oa → outer.o_out.
    portData('oa', 'data_out', 'outer', 'o_out'),
  ],
  layout: grid(['n_start', 'n_seed', 'outer', 'inner', 'ia', 'oa', 'n_end']),
};

/** Layout-only fixtures that stress the layered auto-layout. */
export const linearSample: IRGraph = {
  version: 1,
  meta: { name: 'linear-sample', adapter: 'claude-code' },
  nodes: [
    start,
    { id: 'n_a', type: 'agent', label: 'A', params: { prompt: 'A' } },
    { id: 'n_b', type: 'agent', label: 'B', params: { prompt: 'B' } },
    end,
  ],
  edges: [exec('n_start', 'n_a'), exec('n_a', 'n_b'), exec('n_b', 'n_end')],
  layout: grid(['n_start', 'n_a', 'n_b', 'n_end']),
};

export const dataHeavySample: IRGraph = {
  version: 1,
  meta: { name: 'data-heavy-sample', adapter: 'claude-code' },
  nodes: [
    start,
    { id: 'n_seed', type: 'variable', label: 'seed', params: { name: 'seed', value: '42', raw: true } },
    { id: 'n_ctx', type: 'variable', label: 'ctx', params: { name: 'ctx', value: 'input', raw: true } },
    { id: 'n_join', type: 'agent', label: 'Join', params: { prompt: 'Join inputs' } },
    { id: 'n_tail', type: 'agent', label: 'Tail', params: { prompt: 'Tail step' } },
    end,
  ],
  edges: [
    exec('n_start', 'n_join'),
    exec('n_join', 'n_tail'),
    exec('n_tail', 'n_end'),
    data('n_seed', 'n_join'),
    data('n_ctx', 'n_join'),
    data('n_join', 'n_tail'),
  ],
  layout: grid(['n_start', 'n_seed', 'n_ctx', 'n_join', 'n_tail', 'n_end']),
};

export const multiTerminalSample: IRGraph = {
  version: 1,
  meta: { name: 'multi-terminal-sample', adapter: 'claude-code' },
  nodes: [
    start,
    { id: 'n_start2', type: 'start', label: 'Start 2', params: {} },
    { id: 'n_a', type: 'agent', label: 'A', params: { prompt: 'A' } },
    { id: 'n_b', type: 'branch', label: 'Branch', params: { condition: 'true' } },
    { id: 'n_child', type: 'agent', parent: 'n_b', label: 'Child', params: { prompt: 'child' } },
    { id: 'n_end2', type: 'end', label: 'End 2', params: {} },
    end,
  ],
  edges: [
    exec('n_start', 'n_a'),
    exec('n_start2', 'n_b'),
    exec('n_a', 'n_b'),
    exec('n_b', 'n_end2'),
    exec('n_b', 'n_child'),
    exec('n_child', 'n_end'),
  ],
  layout: grid(['n_start', 'n_start2', 'n_a', 'n_b', 'n_child', 'n_end2', 'n_end']),
};

export const isolatedSample: IRGraph = {
  version: 1,
  meta: { name: 'isolated-sample', adapter: 'claude-code' },
  nodes: [
    start,
    { id: 'n_island', type: 'log', label: 'Island', params: { message: 'isolated node' } },
    { id: 'n_data', type: 'variable', label: 'Data', params: { name: 'data', value: '[]', raw: true } },
    end,
  ],
  edges: [exec('n_start', 'n_end')],
  layout: grid(['n_start', 'n_island', 'n_data', 'n_end']),
};

/** Named fixtures for the round-trip suite (F1 = sample, F6 = default blueprint). */
export const roundtripFixtures: { name: string; ir: IRGraph }[] = [
  { name: 'F1 review-changes (parallel + data + schema)', ir: sampleWorkflow },
  { name: 'F2 pipeline (items + stages)', ir: pipelineSample },
  { name: 'F3 branch (nested children)', ir: branchSample },
  { name: 'F4 loop (data edge into body)', ir: loopSample },
  { name: 'F5 nested branch>loop>agent', ir: nestedSample },
  { name: 'F6 default blueprint', ir: defaultBlueprint() },
  { name: 'F7 composite (single in/out)', ir: compositeSingleSample },
  { name: 'F8 composite (nested)', ir: compositeNestedSample },
  { name: 'F9 captain loop (manager + adversarial gate)', ir: captainBlueprint() },
];

export const layoutFixtures: { name: string; ir: IRGraph }[] = [
  { name: 'L1 linear', ir: linearSample },
  { name: 'L2 data-heavy', ir: dataHeavySample },
  { name: 'L3 multi-terminal', ir: multiTerminalSample },
  { name: 'L4 isolated', ir: isolatedSample },
];
