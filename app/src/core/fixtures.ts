import { DATA, EXEC, type IREdge, type IRGraph, type IRNode } from './ir';
import { sampleWorkflow } from './sample';
import { defaultBlueprint } from './defaultBlueprint';

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

/** Named fixtures for the round-trip suite (F1 = sample, F6 = default blueprint). */
export const roundtripFixtures: { name: string; ir: IRGraph }[] = [
  { name: 'F1 review-changes (parallel + data + schema)', ir: sampleWorkflow },
  { name: 'F2 pipeline (items + stages)', ir: pipelineSample },
  { name: 'F3 branch (nested children)', ir: branchSample },
  { name: 'F4 loop (data edge into body)', ir: loopSample },
  { name: 'F5 nested branch>loop>agent', ir: nestedSample },
  { name: 'F6 default blueprint', ir: defaultBlueprint() },
];
