import {
  DATA,
  EXEC,
  type ConsensusStrategy,
  type IRAgentSpec,
  type IRGraph,
  type IRNode,
  type TaskLedger,
} from '../core/ir';
import { extractJson } from './schema';

export const DYNAMIC_HARNESS_SCHEMA =
  `{
  objective: '',
  nonGoals: [],
  successCriteria: [],
  budget: { maxAgentCalls: 12, maxRounds: 2 },
  strategies: [],
  plan: [],
  workerGroups: [{ id: '', title: '', focus: '', deliverable: '', acceptance: '', evidenceRequired: '' }],
  acceptanceRubric: [],
  stopCondition: ''
}`;

export const DYNAMIC_TASK_LEDGER_SCHEMA =
  `{
  tasks: [{
    id: '',
    title: '',
    owner: '',
    input: '',
    deliverable: '',
    acceptance: '',
    evidenceRequired: '',
    status: 'pending',
    artifact: '',
    gaps: []
  }]
}`;

export const DYNAMIC_WORKER_RESULT_SCHEMA =
  `{
  taskId: '',
  status: 'done',
  artifact: '',
  evidence: [],
  gaps: []
}`;

export const DYNAMIC_VERDICT_SCHEMA =
  `{
  pass: false,
  acceptedArtifact: '',
  evidence: [],
  gaps: [{ taskId: '', severity: 'P1', reason: '', nextAction: '' }]
}`;

export const PLANNER_NODE_ID = 'n_plan';
export const LEDGER_NODE_ID = 'n_ledger';
export const WORKERS_NODE_ID = 'n_workers';
export const GATE_NODE_ID = 'n_gate';
export const REPORT_NODE_ID = 'n_report';

export type DynamicStrategy =
  | 'classify-and-act'
  | 'fan-out-and-synthesize'
  | 'adversarial-verification'
  | 'generate-and-filter'
  | 'tournament'
  | 'loop-until-done';

export interface DynamicWorkerGroup {
  id: string;
  title: string;
  focus: string;
  deliverable: string;
  acceptance: string;
  evidenceRequired: string;
}

export type DynamicPlanStepKind = 'agent' | 'parallel' | 'pipeline' | 'consensus';

export interface DynamicPlanActor {
  id?: string;
  title?: string;
  label?: string;
  prompt?: string;
  focus?: string;
  deliverable?: string;
  acceptance?: string;
  evidenceRequired?: string;
  agentType?: string;
  model?: string;
  schema?: string;
}

export interface DynamicPlanStep extends DynamicPlanActor {
  id: string;
  kind: DynamicPlanStepKind;
  title: string;
  phase?: string;
  items?: string;
  dependsOn?: string[];
  branches?: DynamicPlanActor[];
  stages?: DynamicPlanActor[];
  voters?: DynamicPlanActor[];
  strategy?: ConsensusStrategy;
  quorum?: number;
  samples?: number;
}

export interface DynamicHarnessSpec {
  objective: string;
  nonGoals: string[];
  successCriteria: string[];
  budget: {
    maxAgentCalls: number;
    maxRounds: number;
  };
  strategies: DynamicStrategy[];
  plan?: DynamicPlanStep[];
  workerGroups: DynamicWorkerGroup[];
  acceptanceRubric: string[];
  stopCondition: string;
}

export interface DynamicHarnessArtifacts {
  ledger: TaskLedger | null;
  verdict: DynamicVerdict | null;
  report: string;
}

export interface DynamicVerdictGap {
  taskId: string;
  severity: string;
  reason: string;
  nextAction: string;
}

export interface DynamicVerdict {
  pass: boolean;
  acceptedArtifact: string;
  evidence: string[];
  gaps: DynamicVerdictGap[];
}

const ALL_STRATEGIES: readonly DynamicStrategy[] = [
  'classify-and-act',
  'fan-out-and-synthesize',
  'adversarial-verification',
  'generate-and-filter',
  'tournament',
  'loop-until-done',
] as const;

export function buildDynamicPlannerGraph(request: string): IRGraph {
  return {
    version: 1,
    meta: {
      name: 'ultracode harness planner',
      adapter: 'claude-code',
      gateway: { defaults: { adapter: 'claude-code', modelClass: 'sonnet' } },
      schemaDefs: {
        DYNAMIC_HARNESS: DYNAMIC_HARNESS_SCHEMA,
      },
    },
    nodes: [
      { id: 'n_start', type: 'start', label: 'Start', params: { userInputs: [request] } },
      {
        id: PLANNER_NODE_ID,
        type: 'agent',
        label: '生成动态 Harness',
        params: {
          agentType: 'workflow-manager',
          schema: 'DYNAMIC_HARNESS',
          prompt: dynamicPlannerPrompt(request),
        },
      },
      { id: 'n_end', type: 'end', label: 'End', params: {} },
    ],
    edges: [
      {
        id: 'e_start_plan',
        from: { node: 'n_start', port: 'exec_out' },
        to: { node: PLANNER_NODE_ID, port: 'exec_in' },
        kind: EXEC,
      },
      {
        id: 'e_plan_end',
        from: { node: PLANNER_NODE_ID, port: 'exec_out' },
        to: { node: 'n_end', port: 'exec_in' },
        kind: EXEC,
      },
    ],
  };
}

export function buildDynamicHarnessGraph(spec: DynamicHarnessSpec): IRGraph {
  if (spec.plan && spec.plan.length > 0) {
    return buildDynamicPlanHarnessGraph(spec);
  }

  const branches = spec.workerGroups.map((group, index) => ({
    label: group.title || `Worker ${index + 1}`,
    schema: 'DYNAMIC_WORKER_RESULT',
    prompt: workerPrompt(spec, group),
  }));

  return {
    version: 1,
    meta: {
      name: `ultracode: ${shortName(spec.objective)}`,
      adapter: 'claude-code',
      gateway: { defaults: { adapter: 'claude-code', modelClass: 'sonnet' } },
      schemaDefs: {
        DYNAMIC_TASK_LEDGER: DYNAMIC_TASK_LEDGER_SCHEMA,
        DYNAMIC_WORKER_RESULT: DYNAMIC_WORKER_RESULT_SCHEMA,
        DYNAMIC_VERDICT: DYNAMIC_VERDICT_SCHEMA,
      },
    },
    nodes: [
      { id: 'n_start', type: 'start', label: 'Start', params: { userInputs: [spec.objective] } },
      {
        id: 'n_scope',
        type: 'agent',
        label: '目标冻结',
        params: {
          prompt: freezePrompt(spec),
        },
      },
      {
        id: LEDGER_NODE_ID,
        type: 'agent',
        label: '任务账本',
        params: {
          agentType: 'workflow-manager',
          schema: 'DYNAMIC_TASK_LEDGER',
          prompt: ledgerPrompt(spec),
        },
      },
      {
        id: WORKERS_NODE_ID,
        type: 'parallel',
        label: 'Worker 执行',
        params: { branches },
      },
      {
        id: GATE_NODE_ID,
        type: 'consensus',
        label: '验收门',
        params: {
          strategy: 'adversarial',
          schema: 'DYNAMIC_VERDICT',
          voters: [
            {
              label: '验收者',
              schema: 'DYNAMIC_VERDICT',
              prompt: acceptorPrompt(spec),
            },
            {
              label: '反面复核',
              schema: 'DYNAMIC_VERDICT',
              prompt: skepticPrompt(spec),
            },
          ],
        },
      },
      {
        id: REPORT_NODE_ID,
        type: 'agent',
        label: '验收报告',
        params: {
          prompt: reportPrompt(spec),
        },
      },
      { id: 'n_end', type: 'end', label: 'End', params: {} },
    ],
    edges: [
      execEdge('e_start_scope', 'n_start', 'n_scope'),
      execEdge('e_scope_ledger', 'n_scope', LEDGER_NODE_ID),
      execEdge('e_ledger_workers', LEDGER_NODE_ID, WORKERS_NODE_ID),
      execEdge('e_workers_gate', WORKERS_NODE_ID, GATE_NODE_ID),
      execEdge('e_gate_report', GATE_NODE_ID, REPORT_NODE_ID),
      execEdge('e_report_end', REPORT_NODE_ID, 'n_end'),
      dataEdge('d_scope_ledger', 'n_scope', LEDGER_NODE_ID),
      dataEdge('d_ledger_workers', LEDGER_NODE_ID, WORKERS_NODE_ID),
      dataEdge('d_ledger_gate', LEDGER_NODE_ID, GATE_NODE_ID),
      dataEdge('d_workers_gate', WORKERS_NODE_ID, GATE_NODE_ID),
      dataEdge('d_ledger_report', LEDGER_NODE_ID, REPORT_NODE_ID),
      dataEdge('d_workers_report', WORKERS_NODE_ID, REPORT_NODE_ID),
      dataEdge('d_gate_report', GATE_NODE_ID, REPORT_NODE_ID),
    ],
  };
}

export function parseDynamicHarnessSpec(text: string | undefined, request: string): DynamicHarnessSpec {
  const extracted = text ? extractJson(text) : null;
  if (!extracted) return fallbackHarnessSpec(request);
  return normalizeHarnessSpec(extracted.value, request);
}

export function extractHarnessArtifacts(outputs: Record<string, string>): DynamicHarnessArtifacts {
  return {
    ledger: parseLedger(outputs[LEDGER_NODE_ID]),
    verdict: parseVerdict(outputs[GATE_NODE_ID]),
    report: outputs[REPORT_NODE_ID] ?? '',
  };
}

export function fallbackHarnessSpec(request: string): DynamicHarnessSpec {
  const strategies = inferStrategies(request);
  const objective = request.trim() || '完成用户指定任务';
  const groups: DynamicWorkerGroup[] = [
    {
      id: 't1',
      title: '现状与约束',
      focus: '研究目标、现有上下文、相关文件/资料、隐含约束和不在范围内的事项。',
      deliverable: '现状分析与约束清单',
      acceptance: '列出可复查依据，明确范围边界，不做未经证据支持的结论。',
      evidenceRequired: '文件路径、命令输出、来源链接或明确的推理依据',
    },
    {
      id: 't2',
      title: '方案与执行',
      focus: '根据目标产出最小充分方案或执行核心任务。',
      deliverable: '可交付方案/变更/结论',
      acceptance: '覆盖用户目标，说明关键取舍，并标出未完成事项。',
      evidenceRequired: '产物路径、关键命令、检查结果或结构化结论',
    },
    {
      id: 't3',
      title: '验证与风险',
      focus: '从反面寻找漏洞、遗漏、证据不足、目标漂移和过度声称。',
      deliverable: '验证记录与风险/gaps',
      acceptance: '每个风险都有原因和下一步动作；通过项有证据支撑。',
      evidenceRequired: '验证命令、复核清单、失败/通过证据',
    },
  ];
  return {
    objective,
    nonGoals: ['不要扩大到用户未要求的重构或产品改版', '不要把未通过验收的候选结果包装成完成'],
    successCriteria: [
      '产物直接回应用户目标',
      '关键结论或变更有可复查证据',
      '验收门明确通过/不通过，并列出 gaps',
    ],
    budget: { maxAgentCalls: 12, maxRounds: 2 },
    strategies,
    workerGroups: groups,
    acceptanceRubric: [
      '是否完整覆盖目标和非目标',
      '是否提供可复查证据',
      '是否存在未声明的风险或遗漏',
      '是否把候选产物和已验收产物区分清楚',
    ],
    stopCondition: '验收门 pass=true，或预算耗尽后输出剩余 gaps 和下一步。',
  };
}

function dynamicPlannerPrompt(request: string): string {
  return [
    '你是 /ultracode 的动态工作流 harness 规划器。',
    '你的任务不是直接完成用户任务，而是为当前任务即时生成一个可执行 harness 规格。',
    '六种模式只能作为内部策略组合：classify-and-act、fan-out-and-synthesize、adversarial-verification、generate-and-filter、tournament、loop-until-done。',
    '不要让用户选择模式；你要根据任务风险和形态自己选择。',
    '优先生成 plan：1 到 6 个会真实执行的动态步骤，每个步骤 kind 只能是 agent、parallel、pipeline、consensus。',
    'agent 用于单一明确任务；parallel 用于互不依赖的 fan-out；pipeline 用于前后依赖的连续加工；consensus 只用于中间候选/核验，不要替代最终验收门。',
    'plan 中每个步骤/分支/阶段都要写 title、prompt/focus、deliverable、acceptance、evidenceRequired；不要预声明不会运行的阶段。',
    '最终任务账本、验收门和报告由 harness 自动补上，plan 只描述中间执行体。',
    'workerGroups 必须是 2 到 5 个可并行或半独立的任务组，每组都要有 deliverable、acceptance、evidenceRequired。',
    '预算要务实，避免为了简单任务过度并行。',
    '',
    '用户任务：',
    request,
  ].join('\n');
}

function freezePrompt(spec: DynamicHarnessSpec): string {
  return [
    '冻结本次 /ultracode 目标，防止目标漂移。',
    '',
    `目标：${spec.objective}`,
    listBlock('非目标', spec.nonGoals),
    listBlock('成功标准', spec.successCriteria),
    `停止条件：${spec.stopCondition}`,
    `内部策略：${spec.strategies.join(', ')}`,
    '',
    '输出：目标、非目标、成功标准、预算约束、最终交付物。只收敛范围，不展开执行。',
  ].join('\n');
}

function ledgerPrompt(spec: DynamicHarnessSpec): string {
  return [
    '你是队长，只负责拆单、调度、验收口径，不亲自生产核心产物。',
    '请把冻结目标转成任务账本。每个 workerGroup 至少对应一个 task，task id 使用 workerGroup id。',
    '任务必须可验收，并声明 evidenceRequired。严格按 DYNAMIC_TASK_LEDGER 输出。',
    '',
    groupBlock(spec),
    planBlock(spec),
  ].join('\n');
}

function workerPrompt(spec: DynamicHarnessSpec, group: DynamicWorkerGroup): string {
  return [
    `你是 ${group.title} worker。`,
    '只执行分配给你的任务组，不扩大范围，不替其他 worker 做事。',
    '你会收到上游任务账本；只处理与你 taskId/group id 匹配的工作。',
    '',
    `总目标：${spec.objective}`,
    `taskId：${group.id}`,
    `关注范围：${group.focus}`,
    `交付物：${group.deliverable}`,
    `验收线：${group.acceptance}`,
    `证据要求：${group.evidenceRequired}`,
    '',
    '输出必须按 DYNAMIC_WORKER_RESULT。artifact 写产物/结论/路径，evidence 写可复查证据，gaps 写未完成或风险。',
  ].join('\n');
}

function acceptorPrompt(spec: DynamicHarnessSpec): string {
  return [
    '你是验收者。逐条对照任务账本、worker 输出和验收 rubric。',
    '不接受“已完成”这类声明；没有证据就不通过。',
    '只把通过验收的内容放入 acceptedArtifact；未通过项写入 gaps。',
    '',
    `目标：${spec.objective}`,
    listBlock('验收 Rubric', spec.acceptanceRubric),
    planBlock(spec),
    `停止条件：${spec.stopCondition}`,
    '',
    '严格按 DYNAMIC_VERDICT 输出。',
  ].join('\n');
}

function skepticPrompt(spec: DynamicHarnessSpec): string {
  return [
    '你是反面复核者。站在对立面找遗漏、冲突、证据不足、目标漂移和过度声称。',
    '你的职责是尽量证伪 pass=true；任何存疑都写成 gap，并给 nextAction。',
    '',
    `目标：${spec.objective}`,
    listBlock('非目标', spec.nonGoals),
    listBlock('成功标准', spec.successCriteria),
    listBlock('验收 Rubric', spec.acceptanceRubric),
    planBlock(spec),
    '',
    '严格按 DYNAMIC_VERDICT 输出。',
  ].join('\n');
}

function reportPrompt(spec: DynamicHarnessSpec): string {
  return [
    '生成最终验收报告，而不是拼接所有 worker 输出。',
    '只基于任务账本、worker 证据和验收门 verdict。未通过验收的内容不得当作成果呈现。',
    '',
    `目标：${spec.objective}`,
    '',
    '报告结构：',
    '1. 最终结论：通过/未通过。',
    '2. 已验收内容与证据。',
    '3. 未解决 gaps（按严重程度）。',
    '4. 预算或范围说明。',
    '5. 下一步。',
  ].join('\n');
}

function normalizeHarnessSpec(value: unknown, request: string): DynamicHarnessSpec {
  const fallback = fallbackHarnessSpec(request);
  if (!isRecord(value)) return fallback;
  const budgetRaw = isRecord(value.budget) ? value.budget : {};
  const plan = normalizeDynamicPlan(value.plan);
  const workerGroups = arrayOfRecords(value.workerGroups)
    .map((group, index): DynamicWorkerGroup => ({
      id: stringValue(group.id, `t${index + 1}`),
      title: stringValue(group.title, `任务组 ${index + 1}`),
      focus: stringValue(group.focus, fallback.workerGroups[index % fallback.workerGroups.length].focus),
      deliverable: stringValue(group.deliverable, '可验收产物'),
      acceptance: stringValue(group.acceptance, '满足任务目标并提供证据'),
      evidenceRequired: stringValue(group.evidenceRequired, '文件路径、命令输出、来源或推理证据'),
    }))
    .filter((group) => group.id && group.title)
    .slice(0, 5);

  return {
    objective: stringValue(value.objective, fallback.objective),
    nonGoals: stringArray(value.nonGoals, fallback.nonGoals),
    successCriteria: stringArray(value.successCriteria, fallback.successCriteria),
    budget: {
      maxAgentCalls: clampInt(budgetRaw.maxAgentCalls, 4, 32, fallback.budget.maxAgentCalls),
      maxRounds: clampInt(budgetRaw.maxRounds, 1, 5, fallback.budget.maxRounds),
    },
    strategies: normalizeStrategies(value.strategies, fallback.strategies),
    ...(plan.length > 0 ? { plan } : {}),
    workerGroups: workerGroups.length > 0 ? workerGroups : fallback.workerGroups,
    acceptanceRubric: stringArray(value.acceptanceRubric, fallback.acceptanceRubric),
    stopCondition: stringValue(value.stopCondition, fallback.stopCondition),
  };
}

function inferStrategies(request: string): DynamicStrategy[] {
  const text = request.toLowerCase();
  const strategies = new Set<DynamicStrategy>();
  if (/test|flaky|失败|报错|bug|根因|debug|排查|incident|日志/.test(text)) {
    strategies.add('loop-until-done');
    strategies.add('adversarial-verification');
  }
  if (/审查|安全|验证|核查|review|security|audit|claim|事实|引用/.test(text)) {
    strategies.add('fan-out-and-synthesize');
    strategies.add('adversarial-verification');
  }
  if (/命名|方案|设计|候选|创意|name|design|option/.test(text)) {
    strategies.add('generate-and-filter');
    strategies.add('tournament');
  }
  if (/分类|triage|工单|简历|排序|排名|rank|classif/.test(text)) {
    strategies.add('classify-and-act');
    strategies.add('tournament');
  }
  if (strategies.size === 0) {
    strategies.add('fan-out-and-synthesize');
    strategies.add('adversarial-verification');
  }
  return [...strategies];
}

function normalizeStrategies(value: unknown, fallback: DynamicStrategy[]): DynamicStrategy[] {
  const out = new Set<DynamicStrategy>();
  for (const item of Array.isArray(value) ? value : []) {
    if (typeof item === 'string' && (ALL_STRATEGIES as readonly string[]).includes(item)) {
      out.add(item as DynamicStrategy);
    }
  }
  return out.size > 0 ? [...out] : fallback;
}

function parseLedger(text: string | undefined): TaskLedger | null {
  const extracted = text ? extractJson(text) : null;
  if (!extracted || !isRecord(extracted.value) || !Array.isArray(extracted.value.tasks)) {
    return null;
  }
  return {
    tasks: arrayOfRecords(extracted.value.tasks).map((task, index) => ({
      id: stringValue(task.id, `t${index + 1}`),
      title: stringValue(task.title, `任务 ${index + 1}`),
      owner: optionalString(task.owner),
      acceptance: optionalString(task.acceptance),
      evidence: optionalString(task.evidenceRequired ?? task.evidence),
      status: ledgerStatus(task.status),
      artifact: optionalString(task.artifact),
      gaps: stringArray(task.gaps, []),
    })),
    round: 1,
  };
}

function parseVerdict(text: string | undefined): DynamicVerdict | null {
  const extracted = text ? extractJson(text) : null;
  if (!extracted || !isRecord(extracted.value)) return null;
  const v = extracted.value;
  return {
    pass: v.pass === true,
    acceptedArtifact: stringValue(v.acceptedArtifact, ''),
    evidence: stringArray(v.evidence, []),
    gaps: arrayOfRecords(v.gaps).map((gap) => ({
      taskId: stringValue(gap.taskId, ''),
      severity: stringValue(gap.severity, 'P1'),
      reason: stringValue(gap.reason, ''),
      nextAction: stringValue(gap.nextAction, ''),
    })),
  };
}

function ledgerStatus(value: unknown): TaskLedger['tasks'][number]['status'] {
  return value === 'running' ||
    value === 'accepted' ||
    value === 'rejected' ||
    value === 'blocked'
    ? value
    : 'pending';
}

function execEdge(id: string, from: string, to: string) {
  return {
    id,
    from: { node: from, port: 'exec_out' },
    to: { node: to, port: 'exec_in' },
    kind: EXEC,
  };
}

function dataEdge(id: string, from: string, to: string) {
  return {
    id,
    from: { node: from, port: 'data_out' },
    to: { node: to, port: 'data_in' },
    kind: DATA,
  };
}

function groupBlock(spec: DynamicHarnessSpec): string {
  return spec.workerGroups
    .map(
      (group) =>
        `- ${group.id} ${group.title}\n  focus: ${group.focus}\n  deliverable: ${group.deliverable}\n  acceptance: ${group.acceptance}\n  evidenceRequired: ${group.evidenceRequired}`,
    )
    .join('\n');
}

function listBlock(title: string, values: string[]): string {
  if (values.length === 0) return `${title}：无`;
  return `${title}：\n${values.map((value) => `- ${value}`).join('\n')}`;
}

function shortName(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 40) || 'dynamic task';
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const out = value.filter((item): item is string => typeof item === 'string' && !!item.trim()).map((item) => item.trim());
  return out.length > 0 ? out : fallback;
}

function arrayOfRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(max, Math.max(min, n));
}
