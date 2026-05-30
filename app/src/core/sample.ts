import { DATA, EXEC, type IRGraph } from './ir';

/**
 * CONTRACT: sampleWorkflow is the default "review-changes" graph used for the
 * first paint and during development:
 *
 *   start → agent(scan) → parallel(review) → agent(verify) → end
 *
 * Edges are execution-flow (exec) along the main spine; a data edge carries the
 * scan result into the verify step to demonstrate data flow. `parallel` carries
 * structured branch specs (real thunk array on emit); the verify agent declares
 * a schema identifier defined in `meta.schemaDefs`.
 */
export const sampleWorkflow: IRGraph = {
  version: 1,
  meta: {
    name: 'review-changes',
    description: 'Scan a changeset, review it in parallel, then verify.',
    adapter: 'claude-code',
    schemaDefs: {
      REVIEW: '{ findings: [], severity: 0 }',
      VERDICT: '{ ok: false, notes: [] }',
    },
  },
  nodes: [
    { id: 'n_start', type: 'start', label: 'Start', params: {} },
    {
      id: 'n_scan',
      type: 'agent',
      label: 'Scan changes',
      params: {
        agentType: 'explore',
        model: 'haiku',
        prompt: 'Scan the changeset and list touched files and symbols.',
      },
    },
    {
      id: 'n_review',
      type: 'parallel',
      label: 'Review (parallel)',
      params: {
        branches: [
          { prompt: '审查代码质量与可维护性。', agentType: 'quality-reviewer', schema: 'REVIEW' },
          { prompt: '审查安全与信任边界。', agentType: 'security-reviewer' },
          { prompt: '审查 API 契约与兼容性。', agentType: 'code-reviewer' },
        ],
      },
    },
    {
      id: 'n_verify',
      type: 'agent',
      label: 'Verify',
      params: {
        agentType: 'verifier',
        model: 'sonnet',
        schema: 'VERDICT',
        prompt: 'Verify review findings against the changeset.',
      },
    },
    { id: 'n_end', type: 'end', label: 'End', params: {} },
  ],
  edges: [
    { id: 'e_start_scan', from: { node: 'n_start', port: 'exec_out' }, to: { node: 'n_scan', port: 'exec_in' }, kind: EXEC },
    { id: 'e_scan_review', from: { node: 'n_scan', port: 'exec_out' }, to: { node: 'n_review', port: 'exec_in' }, kind: EXEC },
    { id: 'e_review_verify', from: { node: 'n_review', port: 'exec_out' }, to: { node: 'n_verify', port: 'exec_in' }, kind: EXEC },
    { id: 'e_verify_end', from: { node: 'n_verify', port: 'exec_out' }, to: { node: 'n_end', port: 'exec_in' }, kind: EXEC },
    { id: 'd_scan_verify', from: { node: 'n_scan', port: 'data_out' }, to: { node: 'n_verify', port: 'data_in' }, kind: DATA },
  ],
  layout: {
    n_start: { x: 0, y: 160 },
    n_scan: { x: 240, y: 160 },
    n_review: { x: 480, y: 160 },
    n_verify: { x: 720, y: 160 },
    n_end: { x: 960, y: 160 },
  },
};
