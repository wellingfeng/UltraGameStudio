import { EXEC, type IRGraph } from './ir';

/**
 * Placeholder prompt(s) used by the fresh starter agent. `isEmptyWorkflow`
 * treats a graph carrying one of these (or a blank prompt) as "new/empty" so
 * the AI input box frames the instruction as a create rather than an edit.
 * Single source of truth — keep in sync with the default agent below.
 */
export const PLACEHOLDER_PROMPTS = ['描述你的第一个步骤', '描述你的步骤'] as const;

/**
 * CONTRACT: defaultBlueprint(name?) returns the canonical starter graph used by
 * newWorkflow(). It is a minimal, ready-to-edit spine:
 *
 *   start → agent("描述你的第一个步骤", model:'sonnet') → end
 *
 * Two execution edges wire the spine; layout coordinates are pre-placed so the
 * canvas paints a clean left-to-right row. Downstream code relies on the node
 * ids (n_start / n_step1 / n_end), the exec port names (exec_out / exec_in),
 * and the IRGraph shape — keep them stable.
 */
export function defaultBlueprint(name = '未命名工作流'): IRGraph {
  return {
    version: 1,
    meta: { name, adapter: 'claude-code' },
    nodes: [
      {
        id: 'n_start',
        type: 'start',
        label: 'Start',
        params: {},
      },
      {
        id: 'n_step1',
        type: 'agent',
        label: '描述你的第一个步骤',
        params: {
          model: 'sonnet',
          prompt: '描述你的第一个步骤',
        },
      },
      {
        id: 'n_end',
        type: 'end',
        label: 'End',
        params: {},
      },
    ],
    edges: [
      {
        id: 'e_start_step1',
        from: { node: 'n_start', port: 'exec_out' },
        to: { node: 'n_step1', port: 'exec_in' },
        kind: EXEC,
      },
      {
        id: 'e_step1_end',
        from: { node: 'n_step1', port: 'exec_out' },
        to: { node: 'n_end', port: 'exec_in' },
        kind: EXEC,
      },
    ],
    layout: {
      n_start: { x: 0, y: 160 },
      n_step1: { x: 240, y: 160 },
      n_end: { x: 480, y: 160 },
    },
  };
}
