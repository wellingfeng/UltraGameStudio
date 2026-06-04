import { DATA, EXEC, type IRGraph } from './ir';
import { normalizeWorkflowNodeNumbers } from './nodeNumbers';
import {
  DEFAULT_LOCALE,
  type Locale,
  t,
} from '@/lib/i18n';

/**
 * Placeholder prompt(s) used by the fresh starter agent. `isEmptyWorkflow`
 * treats a graph carrying one of these (or a blank prompt) as "new/empty" so
 * the AI input box frames the instruction as a create rather than an edit.
 *
 * Collected from all supported locales so a default blueprint created in any
 * language is recognised as empty.
 */
export const PLACEHOLDER_PROMPTS: readonly string[] = (() => {
  const prompts = new Set<string>();
  for (const locale of [
    'zh-CN',
    'en-US',
    'fr-FR',
    'ru-RU',
    'es-ES',
    'hi-IN',
    'ar-SA',
    'pt-BR',
    'ja-JP',
    'de-DE',
    'ko-KR',
  ] as const) {
    prompts.add(t(locale as Locale, 'defaultBlueprint.agentPlaceholder'));
    prompts.add(t(locale as Locale, 'defaultBlueprint.agentStep'));
  }
  return [...prompts];
})();

/**
 * CONTRACT: defaultBlueprint(name?, locale?) returns the canonical starter
 * graph used by newWorkflow(). It is a minimal, ready-to-edit spine:
 *
 *   start → agent(placeholder) → end
 *
 * The agent's label and prompt are localised to `locale` (defaults to zh-CN).
 * Two execution edges wire the spine; layout coordinates are pre-placed so the
 * canvas paints a clean left-to-right row. Downstream code relies on the node
 * ids (n_start / n_step1 / n_end), the exec port names (exec_out / exec_in),
 * and the IRGraph shape — keep them stable.
 */
export function defaultBlueprint(
  name?: string,
  locale?: Locale,
): IRGraph {
  const localeCode: Locale = locale ?? DEFAULT_LOCALE;
  const placeholder = t(localeCode, 'defaultBlueprint.agentPlaceholder');
  const workflowName =
    name ?? t(localeCode, 'defaultBlueprint.untitledWorkflow');
  return normalizeWorkflowNodeNumbers({
    version: 1,
    meta: {
      name: workflowName,
      adapter: 'claude-code',
      gateway: { defaults: { adapter: 'claude-code', modelClass: 'sonnet' } },
    },
    nodes: [
      {
        id: 'n_start',
        type: 'start',
        label: 'Start',
        params: { userInputs: [] },
      },
      {
        id: 'n_step1',
        type: 'agent',
        label: placeholder,
        params: {
          prompt: placeholder,
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
  });
}

/**
 * CONTRACT: simpleBlueprint(name?, locale?) returns a "simple workflow" — a
 * single, nameless node that just collects and displays the user's inputs:
 *
 *   (one start-type node, no label, no edges)
 *
 * Used by newSimpleWorkflow() for easy one-shot questions. `meta.simple` marks
 * the graph as simple mode: the AI dock then behaves like a plain CLI/chat
 * (sends the user's input straight to the model, no blueprint generation) and
 * appends each input to this node's `userInputs` so the node mirrors the
 * conversation. The node reuses the start-node input-list rendering but hides
 * the "Start" name (see ControlNode's `simple` handling). The graph stays a
 * single node for its whole lifetime.
 */
export function simpleBlueprint(
  name?: string,
  locale?: Locale,
): IRGraph {
  const localeCode: Locale = locale ?? DEFAULT_LOCALE;
  const workflowName =
    name ?? t(localeCode, 'defaultBlueprint.untitledSession');
  return normalizeWorkflowNodeNumbers({
    version: 1,
    meta: {
      name: workflowName,
      adapter: 'claude-code',
      simple: true,
      gateway: { defaults: { adapter: 'claude-code', modelClass: 'sonnet' } },
    },
    nodes: [
      {
        id: 'n_start',
        type: 'start',
        params: { userInputs: [] },
      },
    ],
    edges: [],
    layout: {
      n_start: { x: 240, y: 160 },
    },
  });
}

/**
 * Schema source strings embedded in a captain-loop blueprint's `meta.schemaDefs`.
 * They make the emitted script genuinely runnable (the captain node declares its
 * task ledger, the acceptance gate declares its verdict) and are what the runtime
 * schema-enforcement layer validates against. Kept as plain JS object source
 * (not JSON) so the emitter writes them verbatim as `const NAME = <body>`.
 *
 * Shapes mirror the captain-loop research doc (docs/workflow-captain-research.html).
 */
export const CAPTAIN_TASK_LEDGER_SCHEMA =
  `{ tasks: [{ id: '', title: '', owner: '', input: '', deliverable: '', ` +
  `acceptance: '', evidenceRequired: '', status: 'pending', artifact: '', gaps: [] }] }`;

export const CAPTAIN_VERDICT_SCHEMA =
  `{ pass: false, acceptedArtifact: '', evidence: [], ` +
  `gaps: [{ taskId: '', severity: 'P0', reason: '', nextAction: '' }] }`;

/**
 * CONTRACT: captainBlueprint(name?, locale?) returns the "captain loop" starter
 * graph used by newCaptainWorkflow(). It encodes the manager-led pattern the
 * research doc recommends for complex, decomposable, high-stakes long tasks —
 * NOT more agents, but a visible "队长 + 任务账本 + 验收门 + 汇总" structure:
 *
 *   start
 *     → 目标冻结 (agent)            freeze goal / non-goals / success criteria
 *     → 队长拆单 (agent, TASK_LEDGER) decompose into an acceptance-bearing ledger
 *     → workers   (parallel)        N workers, each only its assigned subtask
 *     → 验收门   (consensus, VERDICT) adversarial: acceptor + counter-reviewer
 *     → 汇总     (agent)            read accepted artifacts + open gaps only
 *     → end
 *
 * Zero core-DSL change: every node type already exists (`consensus` is first
 * class; schemas ride `meta.schemaDefs`). The graph survives emit→parse→emit
 * (round-trip), since the emitter annotates each statement with `// @node <id>`.
 *
 * Exec spine wires the 7 nodes; DATA edges feed the ledger to workers, worker
 * outputs to the gate, and the gate verdict (+ ledger) to the summary so the
 * final node synthesises from accepted work rather than concatenating raw worker
 * output. Node labels/prompts are Chinese literals (the workflow content domain
 * is Chinese); only the button text and default name are localised.
 */
export function captainBlueprint(
  name?: string,
  locale?: Locale,
): IRGraph {
  const localeCode: Locale = locale ?? DEFAULT_LOCALE;
  const workflowName =
    name ?? t(localeCode, 'defaultBlueprint.captainWorkflow');
  return normalizeWorkflowNodeNumbers({
    version: 1,
    meta: {
      name: workflowName,
      adapter: 'claude-code',
      gateway: { defaults: { adapter: 'claude-code', modelClass: 'sonnet' } },
      schemaDefs: {
        TASK_LEDGER: CAPTAIN_TASK_LEDGER_SCHEMA,
        VERDICT: CAPTAIN_VERDICT_SCHEMA,
      },
    },
    nodes: [
      {
        id: 'n_start',
        type: 'start',
        label: 'Start',
        params: { userInputs: [] },
      },
      {
        id: 'n_goal',
        type: 'agent',
        label: '目标冻结',
        params: {
          prompt:
            '冻结目标：列出本次要达成的目标、明确的非目标（不在范围内的事项）、' +
            '可验收的成功标准、预算/约束与最终交付物。只做收敛，不要展开实现细节。',
        },
      },
      {
        id: 'n_captain',
        type: 'agent',
        label: '队长拆单',
        params: {
          prompt:
            '你是队长（manager），只负责拆解、调度、汇总与验收，不亲自生产核心产物。' +
            '把上游冻结的目标拆成一份「任务账本」：每个子任务给出 id、标题、负责人(owner)、' +
            '输入、交付物(deliverable)、验收线(acceptance)、需要的证据形态(evidenceRequired)、' +
            '初始状态(status=pending)。子任务之间尽量相互独立、可并行。严格按 TASK_LEDGER 结构输出。',
          agentType: 'workflow-manager',
          schema: 'TASK_LEDGER',
        },
      },
      {
        id: 'n_workers',
        type: 'parallel',
        label: 'Worker 执行',
        params: {
          branches: [
            {
              prompt:
                'Worker A：只执行任务账本中分配给你的那个独立子任务。' +
                '严格按验收线产出交付物，并附上可复查的证据（命令与输出/文件路径/来源链接等）。' +
                '不要扩大范围，不要替别的 Worker 做事。',
              label: 'Worker A',
            },
            {
              prompt:
                'Worker B：只执行任务账本中分配给你的那个独立子任务。' +
                '严格按验收线产出交付物，并附上可复查的证据。不要扩大范围。',
              label: 'Worker B',
            },
            {
              prompt:
                'Worker C：只执行任务账本中分配给你的那个独立子任务。' +
                '严格按验收线产出交付物，并附上可复查的证据。不要扩大范围。',
              label: 'Worker C',
            },
          ],
        },
      },
      {
        id: 'n_gate',
        type: 'consensus',
        label: '验收门',
        params: {
          voters: [
            {
              prompt:
                '验收者：逐条对照任务账本的验收线核验每个 Worker 的证据。' +
                '不接受“已完成”这类文本声明——没有可复查证据即视为未通过。' +
                '对每个未达标项写入 gaps（taskId、severity、reason、nextAction），' +
                '并给出可作为锚点合入的 acceptedArtifact。严格按 VERDICT 结构输出。',
              label: '验收',
              schema: 'VERDICT',
            },
            {
              prompt:
                '反面复核者：站在对立面找遗漏、相互冲突、证据不足、过度声称之处。' +
                '尽量证伪“已通过”的结论；任何存疑都记为 gap。严格按 VERDICT 结构输出。',
              label: '反面复核',
              schema: 'VERDICT',
            },
          ],
          strategy: 'adversarial',
          schema: 'VERDICT',
        },
      },
      {
        id: 'n_summary',
        type: 'agent',
        label: '汇总',
        params: {
          prompt:
            '生成验收报告，而不是把所有 Worker 输出拼在一起。只基于「已通过验收的产物」' +
            '(accepted anchor) 与「未解决的 gaps」撰写：已验收内容及其证据、未解决的 P0/P1、' +
            '若预算耗尽说明原因、以及下一步建议。未通过验收的内容不得当作成果呈现。',
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
      // Exec spine.
      {
        id: 'e_start_goal',
        from: { node: 'n_start', port: 'exec_out' },
        to: { node: 'n_goal', port: 'exec_in' },
        kind: EXEC,
      },
      {
        id: 'e_goal_captain',
        from: { node: 'n_goal', port: 'exec_out' },
        to: { node: 'n_captain', port: 'exec_in' },
        kind: EXEC,
      },
      {
        id: 'e_captain_workers',
        from: { node: 'n_captain', port: 'exec_out' },
        to: { node: 'n_workers', port: 'exec_in' },
        kind: EXEC,
      },
      {
        id: 'e_workers_gate',
        from: { node: 'n_workers', port: 'exec_out' },
        to: { node: 'n_gate', port: 'exec_in' },
        kind: EXEC,
      },
      {
        id: 'e_gate_summary',
        from: { node: 'n_gate', port: 'exec_out' },
        to: { node: 'n_summary', port: 'exec_in' },
        kind: EXEC,
      },
      {
        id: 'e_summary_end',
        from: { node: 'n_summary', port: 'exec_out' },
        to: { node: 'n_end', port: 'exec_in' },
        kind: EXEC,
      },
      // Data flow: ledger → workers, worker outputs → gate, verdict + ledger → summary.
      {
        id: 'd_captain_workers',
        from: { node: 'n_captain', port: 'data_out' },
        to: { node: 'n_workers', port: 'data_in' },
        kind: DATA,
      },
      {
        id: 'd_workers_gate',
        from: { node: 'n_workers', port: 'data_out' },
        to: { node: 'n_gate', port: 'data_in' },
        kind: DATA,
      },
      {
        id: 'd_gate_summary',
        from: { node: 'n_gate', port: 'data_out' },
        to: { node: 'n_summary', port: 'data_in' },
        kind: DATA,
      },
      {
        id: 'd_captain_summary',
        from: { node: 'n_captain', port: 'data_out' },
        to: { node: 'n_summary', port: 'data_in' },
        kind: DATA,
      },
    ],
    layout: {
      n_start: { x: 0, y: 160 },
      n_goal: { x: 240, y: 160 },
      n_captain: { x: 480, y: 160 },
      n_workers: { x: 720, y: 160 },
      n_gate: { x: 960, y: 160 },
      n_summary: { x: 1200, y: 160 },
      n_end: { x: 1440, y: 160 },
    },
  });
}
