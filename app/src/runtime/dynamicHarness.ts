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
  acceptance: { voters: 2, strategy: 'adversarial' },
  objectiveChecks: [{ kind: 'file-exists', path: '', contains: '', command: '', description: '' }],
  stopCondition: ''
}`;

export const DYNAMIC_PLAN_CRITIQUE_SCHEMA =
  `{
  ok: false,
  issues: [{ field: '', severity: 'P1', problem: '', fix: '' }],
  revisedSpec: ${DYNAMIC_HARNESS_SCHEMA}
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
  criteriaCoverage: [{ criterion: '', met: false, evidence: '' }],
  gaps: [{ taskId: '', severity: 'P1', reason: '', nextAction: '' }]
}`;

export const PLANNER_NODE_ID = 'n_plan';
export const PLAN_CRITIC_NODE_ID = 'n_plan_critic';
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

export interface DynamicAcceptanceConfig {
  voters: number;
  strategy: ConsensusStrategy;
}

/**
 * A machine-runnable objective check the planner emits so acceptance does not
 * rest solely on the model's self-verdict. Three kinds, ordered by safety:
 *  - `file-exists`  — assert a path exists (read-only, always auto-run).
 *  - `file-contains`— assert a file exists AND contains `contains` (read-only,
 *    always auto-run). Doubles as deterministic evidence verification: a worker
 *    that claims it wrote X can be checked against the filesystem for free.
 *  - `command`      — run a shell command and assert exit 0. This executes
 *    MODEL-GENERATED shell, so it is NOT auto-run by default; it only runs when
 *    the user opts in with `--auto-verify`. Otherwise it is surfaced as a
 *    suggested manual check in the report.
 */
export type DynamicObjectiveCheckKind = 'file-exists' | 'file-contains' | 'command';

export interface DynamicObjectiveCheck {
  kind: DynamicObjectiveCheckKind;
  path?: string;
  contains?: string;
  command?: string;
  description?: string;
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
  acceptance?: DynamicAcceptanceConfig;
  objectiveChecks?: DynamicObjectiveCheck[];
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

export interface DynamicVerdictCoverage {
  criterion: string;
  met: boolean;
  evidence: string;
}

export interface DynamicVerdict {
  pass: boolean;
  acceptedArtifact: string;
  evidence: string[];
  criteriaCoverage: DynamicVerdictCoverage[];
  gaps: DynamicVerdictGap[];
}

/**
 * Fan-out width above which a parallel/pipeline node inserts a single reducing
 * agent to compress its many branch/item outputs into a structured digest
 * before they reach the acceptance gate (see node-dispatch.reduceFanOutResults).
 */
const FAN_OUT_REDUCE_THRESHOLD = 6;

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
        DYNAMIC_PLAN_CRITIQUE: DYNAMIC_PLAN_CRITIQUE_SCHEMA,
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
      {
        id: PLAN_CRITIC_NODE_ID,
        type: 'agent',
        label: '规格复审',
        params: {
          // Escalate the critic above the planner: a stronger model auditing a
          // cheaper planner's spec is the highest-ROI accuracy lever, because
          // every downstream node inherits this spec's success criteria and
          // scope. Reads the planner's full output (no truncation).
          model: 'opus',
          schema: 'DYNAMIC_PLAN_CRITIQUE',
          prompt: planCriticPrompt(request),
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
        id: 'e_plan_critic',
        from: { node: PLANNER_NODE_ID, port: 'exec_out' },
        to: { node: PLAN_CRITIC_NODE_ID, port: 'exec_in' },
        kind: EXEC,
      },
      {
        id: 'd_plan_critic',
        from: { node: PLANNER_NODE_ID, port: 'data_out' },
        to: { node: PLAN_CRITIC_NODE_ID, port: 'data_in' },
        kind: DATA,
      },
      {
        id: 'e_critic_end',
        from: { node: PLAN_CRITIC_NODE_ID, port: 'exec_out' },
        to: { node: 'n_end', port: 'exec_in' },
        kind: EXEC,
      },
    ],
  };
}

export function buildDynamicHarnessGraph(spec: DynamicHarnessSpec): IRGraph {
  const rounds = effectiveHarnessRounds(spec);
  if (spec.plan && spec.plan.length > 0) {
    return buildDynamicPlanHarnessGraph(spec, rounds);
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
    nodes: buildWorkerHarnessNodes(spec, rounds, branches),
    edges: buildWorkerHarnessEdges(spec, rounds),
  };
}

function effectiveHarnessRounds(spec: DynamicHarnessSpec): number {
  return spec.strategies.includes('loop-until-done')
    ? Math.max(1, spec.budget.maxRounds)
    : 1;
}

/**
 * Acceptance gate voters. Default is the classic adversarial pair (验收者 +
 * 反面复核). When the spec asks for more voters (high-risk tasks), extra
 * diverse-lens skeptics are added so the gate scales with risk instead of being
 * hard-wired to two votes.
 */
function gateVoters(spec: DynamicHarnessSpec, round: number): IRAgentSpec[] {
  const acceptorPromptText = round === 1 ? acceptorPrompt(spec) : repairAcceptorPrompt(spec, round);
  const skepticPromptText = round === 1 ? skepticPrompt(spec) : repairSkepticPrompt(spec, round);
  const voters: IRAgentSpec[] = [
    { label: '验收者', schema: 'DYNAMIC_VERDICT', prompt: acceptorPromptText },
    { label: '反面复核', schema: 'DYNAMIC_VERDICT', prompt: skepticPromptText },
  ];
  const want = spec.acceptance?.voters ?? 2;
  const lenses = ['正确性视角', '证据/可复查性视角', '遗漏与边界视角', '安全/风险视角'];
  for (let i = 0; voters.length < want && i < lenses.length; i += 1) {
    voters.push({
      label: `复核 · ${lenses[i]}`,
      schema: 'DYNAMIC_VERDICT',
      prompt: `${skepticPromptText}\n\n本次复核请特别聚焦：${lenses[i]}。`,
    });
  }
  return voters;
}

function gateStrategy(spec: DynamicHarnessSpec): ConsensusStrategy {
  return spec.acceptance?.strategy ?? 'adversarial';
}

/**
 * Per-round model escalation (CLAUDE.md: when an approach fails twice, change
 * the root approach). Repair rounds climb the model tier (sonnet → opus) so a
 * stuck task gets more capability rather than the same prompt retried.
 */
function repairModelForRound(round: number): string | undefined {
  if (round <= 1) return undefined;
  return round >= 3 ? 'opus' : 'sonnet';
}

/**
 * Strategy → mid-stage between workers and the acceptance gate (Feature: make
 * strategies actually change the DAG, not just prompt text).
 *   - generate-and-filter / tournament → a `consensus` node that picks/merges
 *     the best worker output before it reaches the gate.
 *   - fan-out-and-synthesize → a single `agent` that synthesizes all parallel
 *     branches and resolves conflicts before the gate.
 * Returns `null` when no strategy calls for a mid-stage (legacy behaviour).
 */
type MidStageKind = 'synthesize' | 'filter';

/**
 * Pure strategy → mid-stage kind mapping, with NO structural guard. Both the
 * worker-group path and the plan path consult this so a declared strategy maps
 * to the same mid-stage everywhere. Callers apply their own applicability guard
 * (worker path: ≥2 worker groups; plan path: see {@link planMidStageApplies}).
 */
function midStageStrategy(spec: DynamicHarnessSpec): MidStageKind | null {
  if (spec.strategies.includes('generate-and-filter') || spec.strategies.includes('tournament')) {
    return 'filter';
  }
  if (spec.strategies.includes('fan-out-and-synthesize')) return 'synthesize';
  return null;
}

/** Worker-group-path mid-stage: only meaningful when ≥2 groups produce candidates. */
function midStageKind(spec: DynamicHarnessSpec): MidStageKind | null {
  if (spec.workerGroups.length < 2) return null;
  return midStageStrategy(spec);
}

/**
 * Plan-path mid-stage applicability. A synthesize/filter stage only earns its
 * place when there are MULTIPLE candidate outputs to merge or pick between:
 * either ≥2 terminal plan nodes feeding the gate, or a single terminal `parallel`
 * step that itself fans out into ≥2 branches. A lone linear pipeline has nothing
 * to merge, so the stage is skipped (no wasted agent call).
 */
function planMidStageApplies(spec: DynamicHarnessSpec, plan: DynamicPlanStep[]): boolean {
  if (!midStageStrategy(spec)) return false;
  const terminals = planTerminalStepIds(plan);
  if (terminals.length >= 2) return true;
  if (terminals.length === 1) {
    const step = plan.find((s) => s.id === terminals[0]);
    return !!step && step.kind === 'parallel' && (step.branches?.length ?? 0) >= 2;
  }
  return false;
}

/**
 * Step ids that nothing else depends on (the plan's leaves), mirroring the
 * dependency logic in {@link buildDynamicPlanHarnessGraph}: a step with an
 * explicit (array) `dependsOn` uses those (filtered to existing ids); otherwise
 * it implicitly depends on its predecessor. Kept id-level and round-independent
 * so {@link estimateHarnessCalls} can reason about the mid-stage without building
 * the graph.
 */
function planTerminalStepIds(plan: DynamicPlanStep[]): string[] {
  const ids = plan.map((s) => s.id);
  const idSet = new Set(ids);
  const hasDependent = new Set<string>();
  for (let i = 0; i < plan.length; i += 1) {
    const step = plan[i];
    const deps = Array.isArray(step.dependsOn)
      ? step.dependsOn.filter((d) => idSet.has(d))
      : i > 0
        ? [plan[i - 1].id]
        : [];
    for (const d of deps) hasDependent.add(d);
  }
  return ids.filter((id) => !hasDependent.has(id));
}

/** Leaf agent-call cost of a mid-stage: filter = consensus(2 voters)+synthesis; synthesize = 1 agent. */
function midStageLeafCalls(kind: MidStageKind): number {
  return kind === 'filter' ? 3 : 1;
}

function midStageNodeId(round: number): string {
  return round === 1 ? 'n_synth' : `n_synth_r${round}`;
}

/** Plan-path mid-stage id, namespaced apart from the worker-path `n_synth`. */
function planMidStageNodeId(round: number): string {
  return round === 1 ? 'n_plan_synth' : `n_plan_synth_r${round}`;
}

function midStageNode(spec: DynamicHarnessSpec, kind: MidStageKind, round: number, id?: string): IRNode {
  const nodeId = id ?? midStageNodeId(round);
  const roundLabel = round > 1 ? ` · 返工 ${round}` : '';
  if (kind === 'filter') {
    return {
      id: nodeId,
      type: 'consensus',
      label: `候选筛选${roundLabel}`,
      params: {
        strategy: 'tournament',
        schema: 'DYNAMIC_WORKER_RESULT',
        voters: [
          { label: '筛选 A', schema: 'DYNAMIC_WORKER_RESULT', prompt: filterPrompt(spec) },
          { label: '筛选 B', schema: 'DYNAMIC_WORKER_RESULT', prompt: filterPrompt(spec) },
        ],
        contextPolicy: 'tail',
      },
    };
  }
  return {
    id: nodeId,
    type: 'agent',
    label: `综合${roundLabel}`,
    params: {
      schema: 'DYNAMIC_WORKER_RESULT',
      prompt: synthesizePrompt(spec),
      contextPolicy: 'tail',
    },
  };
}

function buildWorkerHarnessNodes(
  spec: DynamicHarnessSpec,
  rounds: number,
  firstRoundBranches: IRAgentSpec[],
): IRNode[] {
  const nodes: IRNode[] = [
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
  ];

  const mid = midStageKind(spec);
  for (let round = 1; round <= rounds; round += 1) {
    const workerId = workerRoundNodeId(round);
    const gateId = gateRoundNodeId(round, rounds);
    const branches =
      round === 1
        ? firstRoundBranches
        : spec.workerGroups.map((group, index) => ({
            label: `${group.title || `Worker ${index + 1}`} · 返工 ${round}`,
            schema: 'DYNAMIC_WORKER_RESULT',
            prompt: repairWorkerPrompt(spec, group, round),
            ...(repairModelForRound(round) ? { model: repairModelForRound(round) } : {}),
          }));
    nodes.push(
      {
        id: workerId,
        type: 'parallel',
        label: round === 1 ? 'Worker 执行' : `Worker 返工 ${round}`,
        params: {
          branches,
          contextPolicy: 'tail',
          ...(round > 1
            ? {
                skipIfVerdictPassFrom: gateRoundNodeId(round - 1, rounds),
                skipOutput: JSON.stringify({
                  taskId: 'already-accepted',
                  status: 'done',
                  artifact: '上一轮验收已通过，本轮无需返工。',
                  evidence: [],
                  gaps: [],
                }),
              }
            : {}),
        },
      },
    );
    if (mid) nodes.push(midStageNode(spec, mid, round));
    nodes.push(
      {
        id: gateId,
        type: 'consensus',
        label: round === rounds ? '验收门' : `验收门 ${round}`,
        params: {
          strategy: gateStrategy(spec),
          schema: 'DYNAMIC_VERDICT',
          voters: gateVoters(spec, round),
          contextPolicy: 'tail',
          ...(round > 1
            ? {
                skipIfVerdictPassFrom: gateRoundNodeId(round - 1, rounds),
                skipOutputFrom: gateRoundNodeId(round - 1, rounds),
              }
            : {}),
        },
      },
    );
  }

  nodes.push(
    {
      id: REPORT_NODE_ID,
      type: 'agent',
      label: '验收报告',
      params: {
        prompt: reportPrompt(spec),
        contextPolicy: 'tail',
      },
    },
    { id: 'n_end', type: 'end', label: 'End', params: {} },
  );

  return nodes;
}

function buildWorkerHarnessEdges(spec: DynamicHarnessSpec, rounds: number) {
  const edges = [
      execEdge('e_start_scope', 'n_start', 'n_scope'),
      execEdge('e_scope_ledger', 'n_scope', LEDGER_NODE_ID),
      dataEdge('d_scope_ledger', 'n_scope', LEDGER_NODE_ID),
      dataEdge('d_ledger_report', LEDGER_NODE_ID, REPORT_NODE_ID),
    ];
  let edgeSeq = 0;
  let execFrom = LEDGER_NODE_ID;
  const mid = midStageKind(spec);
  const allWorkerIds: string[] = [];
  const allGateIds: string[] = [];
  const allMidIds: string[] = [];

  for (let round = 1; round <= rounds; round += 1) {
    const workerId = workerRoundNodeId(round);
    const gateId = gateRoundNodeId(round, rounds);
    allWorkerIds.push(workerId);
    allGateIds.push(gateId);
    edges.push(execEdge(`e_round_${round}_workers`, execFrom, workerId));
    if (mid) {
      const midId = midStageNodeId(round);
      allMidIds.push(midId);
      edges.push(execEdge(`e_round_${round}_mid`, workerId, midId));
      edges.push(execEdge(`e_round_${round}_gate`, midId, gateId));
      edges.push(dataEdge(`d_round_${round}_workers_mid`, workerId, midId));
      edges.push(dataEdge(`d_round_${round}_ledger_mid`, LEDGER_NODE_ID, midId));
      edges.push(dataEdge(`d_round_${round}_mid_gate`, midId, gateId));
    } else {
      edges.push(execEdge(`e_round_${round}_gate`, workerId, gateId));
    }
    edges.push(dataEdge(`d_round_${round}_ledger_workers`, LEDGER_NODE_ID, workerId));
    edges.push(dataEdge(`d_round_${round}_ledger_gate`, LEDGER_NODE_ID, gateId));
    edges.push(dataEdge(`d_round_${round}_workers_gate`, workerId, gateId));
    if (round > 1) {
      const prevWorkerId = workerRoundNodeId(round - 1);
      const prevGateId = gateRoundNodeId(round - 1, rounds);
      edges.push(dataEdge(`d_repair_${round}_prev_workers`, prevWorkerId, workerId));
      edges.push(dataEdge(`d_repair_${round}_prev_gate`, prevGateId, workerId));
      edges.push(dataEdge(`d_repair_${round}_prev_gate_to_gate`, prevGateId, gateId));
    }
    execFrom = gateId;
  }

  edges.push(execEdge('e_gate_report', execFrom, REPORT_NODE_ID));
  edges.push(execEdge('e_report_end', REPORT_NODE_ID, 'n_end'));
  for (const workerId of allWorkerIds) {
    edges.push(dataEdge(`d_report_${edgeSeq++}_${workerId}`, workerId, REPORT_NODE_ID));
  }
  for (const midId of allMidIds) {
    edges.push(dataEdge(`d_report_${edgeSeq++}_${midId}`, midId, REPORT_NODE_ID));
  }
  for (const gateId of allGateIds) {
    edges.push(dataEdge(`d_report_${edgeSeq++}_${gateId}`, gateId, REPORT_NODE_ID));
  }
  return edges;
}

function buildDynamicPlanHarnessGraph(spec: DynamicHarnessSpec, rounds: number): IRGraph {
  const nodes: IRNode[] = [
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
  ];
  const edges = [
    execEdge('e_start_scope', 'n_start', 'n_scope'),
    execEdge('e_scope_ledger', 'n_scope', LEDGER_NODE_ID),
    dataEdge('d_scope_ledger', 'n_scope', LEDGER_NODE_ID),
  ];
  let edgeSeq = 0;
  const addExec = (from: string, to: string) => {
    edges.push(execEdge(`e_dyn_${edgeSeq++}_${safeId(from)}_${safeId(to)}`, from, to));
  };
  const addData = (from: string, to: string) => {
    edges.push(dataEdge(`d_dyn_${edgeSeq++}_${safeId(from)}_${safeId(to)}`, from, to));
  };

  const allPlanNodeIds: string[] = [];
  const allGateIds: string[] = [];
  const allMidIds: string[] = [];
  const plan = spec.plan ?? [];
  const mid = planMidStageApplies(spec, plan) ? midStageStrategy(spec) : null;
  let previousGateId: string | null = null;

  for (let round = 1; round <= rounds; round += 1) {
    const stepNodeIds = new Map<string, string>();
    const roundAnchor = previousGateId ?? LEDGER_NODE_ID;
    for (let i = 0; i < plan.length; i += 1) {
      const step = plan[i];
      const nodeId = dynamicPlanNodeId(step, i, round);
      stepNodeIds.set(step.id, nodeId);
      allPlanNodeIds.push(nodeId);
      nodes.push(dynamicPlanStepNode(spec, step, nodeId, round));
      if (round > 1) {
        const prevGateId = previousGateId ?? '';
        const node = nodes[nodes.length - 1];
        node.params = {
          ...node.params,
          skipIfVerdictPassFrom: prevGateId,
          skipOutput: JSON.stringify({
            taskId: 'already-accepted',
            status: 'done',
            artifact: '上一轮验收已通过，本轮无需返工。',
            evidence: [],
            gaps: [],
          }),
        };
      }
    }

    const outgoingPlanDeps = new Set<string>();
    for (let i = 0; i < plan.length; i += 1) {
      const step = plan[i];
      const nodeId = stepNodeIds.get(step.id)!;
      const explicitDepends = Array.isArray(step.dependsOn);
      const deps = explicitDepends
        ? (step.dependsOn ?? [])
            .map((dep) => stepNodeIds.get(dep))
            .filter((dep): dep is string => !!dep)
        : i > 0
          ? [stepNodeIds.get(plan[i - 1].id)!]
          : [];
      const execDeps = deps.length > 0 ? deps : [roundAnchor];

      for (const dep of execDeps) {
        addExec(dep, nodeId);
        if (dep !== roundAnchor) outgoingPlanDeps.add(dep);
      }
      addData(LEDGER_NODE_ID, nodeId);
      if (previousGateId) addData(previousGateId, nodeId);
      for (const dep of deps) addData(dep, nodeId);
    }

    const planNodeIds = plan.map((step) => stepNodeIds.get(step.id)!).filter(Boolean);
    const terminalPlanNodeIds = planNodeIds.filter((nodeId) => !outgoingPlanDeps.has(nodeId));

    // Strategy → mid-stage (Feature: make fan-out-and-synthesize / generate-and-filter /
    // tournament actually change the DAG on the PLAN path, not just the legacy worker
    // path). When the plan fans out into multiple candidate outputs, insert a single
    // synthesize/filter node that merges or picks the best before the acceptance gate
    // sees it — the same shape the worker path already uses.
    let gateInputs = terminalPlanNodeIds.length > 0 ? terminalPlanNodeIds : [roundAnchor];
    let roundMidId: string | null = null;
    if (mid && terminalPlanNodeIds.length > 0) {
      const midId = planMidStageNodeId(round);
      allMidIds.push(midId);
      roundMidId = midId;
      nodes.push(midStageNode(spec, mid, round, midId));
      for (const input of terminalPlanNodeIds) {
        addExec(input, midId);
        addData(input, midId);
      }
      addData(LEDGER_NODE_ID, midId);
      gateInputs = [midId];
    }

    const gateId = gateRoundNodeId(round, rounds);
    allGateIds.push(gateId);
    nodes.push({
      id: gateId,
      type: 'consensus',
      label: round === rounds ? '验收门' : `验收门 ${round}`,
      params: {
        strategy: gateStrategy(spec),
        schema: 'DYNAMIC_VERDICT',
        voters: gateVoters(spec, round),
        contextPolicy: 'tail',
        ...(round > 1 && previousGateId
          ? {
              skipIfVerdictPassFrom: previousGateId,
              skipOutputFrom: previousGateId,
            }
          : {}),
      },
    });

    for (const input of gateInputs) addExec(input, gateId);
    addData(LEDGER_NODE_ID, gateId);
    if (previousGateId) addData(previousGateId, gateId);
    // The gate evaluates the merged/filtered artifact when a mid-stage ran;
    // otherwise it sees the plan nodes directly.
    if (roundMidId) addData(roundMidId, gateId);
    for (const nodeId of planNodeIds) addData(nodeId, gateId);
    previousGateId = gateId;
  }

  const finalGateId = previousGateId ?? LEDGER_NODE_ID;

  nodes.push(
    {
      id: REPORT_NODE_ID,
      type: 'agent',
      label: '验收报告',
      params: {
        prompt: reportPrompt(spec),
        contextPolicy: 'tail',
      },
    },
    { id: 'n_end', type: 'end', label: 'End', params: {} },
  );

  addExec(finalGateId, REPORT_NODE_ID);
  addExec(REPORT_NODE_ID, 'n_end');

  addData(LEDGER_NODE_ID, REPORT_NODE_ID);
  for (const nodeId of allPlanNodeIds) {
    addData(nodeId, REPORT_NODE_ID);
  }
  for (const midId of allMidIds) {
    addData(midId, REPORT_NODE_ID);
  }
  for (const gateId of allGateIds) addData(gateId, REPORT_NODE_ID);

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
    nodes,
    edges,
  };
}

function dynamicPlanStepNode(
  spec: DynamicHarnessSpec,
  step: DynamicPlanStep,
  nodeId: string,
  round = 1,
): IRNode {
  const roundLabel = round > 1 ? ` · 返工 ${round}` : '';
  const label = step.phase ? `${step.phase} · ${step.title}${roundLabel}` : `${step.title}${roundLabel}`;
  switch (step.kind) {
    case 'parallel': {
      const branches = (step.branches && step.branches.length > 0 ? step.branches : [step])
        .map((actor, index) => dynamicActorSpec(spec, step, actor, `分支 ${index + 1}`, round));
      return {
        id: nodeId,
        type: 'parallel',
        label,
        params: { branches, contextPolicy: 'tail', reduceWhenOver: FAN_OUT_REDUCE_THRESHOLD },
      };
    }
    case 'pipeline': {
      const stages = (step.stages && step.stages.length > 0 ? step.stages : [step])
        .map((actor, index) => dynamicActorSpec(spec, step, actor, `阶段 ${index + 1}`, round));
      return {
        id: nodeId,
        type: 'pipeline',
        label,
        params: {
          items: step.items || step.title,
          stages,
          contextPolicy: 'tail',
          reduceWhenOver: FAN_OUT_REDUCE_THRESHOLD,
        },
      };
    }
    case 'consensus': {
      const voters = (step.voters && step.voters.length > 0 ? step.voters : [step])
        .map((actor, index) => dynamicActorSpec(spec, step, actor, `样本 ${index + 1}`, round));
      return {
        id: nodeId,
        type: 'consensus',
        label,
        params: {
          strategy: step.strategy ?? 'multi-lens',
          schema: 'DYNAMIC_WORKER_RESULT',
          voters,
          ...(step.quorum ? { quorum: step.quorum } : {}),
          ...(step.samples ? { samples: step.samples } : {}),
          contextPolicy: 'tail',
        },
      };
    }
    case 'agent':
    default:
      return {
        id: nodeId,
        type: 'agent',
        label,
        params: {
          ...dynamicActorSpec(spec, step, step, '执行', round),
          contextPolicy: 'tail',
        },
      };
  }
}

function dynamicActorSpec(
  spec: DynamicHarnessSpec,
  step: DynamicPlanStep,
  actor: DynamicPlanActor,
  fallbackLabel: string,
  round = 1,
): IRAgentSpec {
  return {
    label: actor.label || actor.title || fallbackLabel,
    prompt: dynamicActorPrompt(spec, step, actor, fallbackLabel, round),
    agentType: actor.agentType || step.agentType,
    model: actor.model || step.model || repairModelForRound(round),
    schema: actor.schema || step.schema || 'DYNAMIC_WORKER_RESULT',
    phase: step.phase,
    contextPolicy: 'tail',
  };
}

function dynamicActorPrompt(
  spec: DynamicHarnessSpec,
  step: DynamicPlanStep,
  actor: DynamicPlanActor,
  fallbackLabel: string,
  round = 1,
): string {
  const actorTitle = actor.title || actor.label || fallbackLabel;
  const focus = actor.prompt || actor.focus || step.prompt || step.focus || actorTitle;
  const deliverable = actor.deliverable || step.deliverable || '可验收产物';
  const acceptance = actor.acceptance || step.acceptance || '满足本步骤目标并提供证据';
  const evidenceRequired = actor.evidenceRequired || step.evidenceRequired || '文件路径、命令输出、来源或推理证据';
  return [
    `你是 /ultracode 动态执行步骤「${step.title}」中的「${actorTitle}」。`,
    '只完成分配给你的动态步骤，不扩大范围，不替验收门下最终结论。',
    '你会收到上游任务账本和依赖步骤输出；如果证据不足，要把缺口写进 gaps。',
    '',
    `总目标：${spec.objective}`,
    `taskId：${actor.id || step.id}`,
    round > 1 ? `返工轮次：第 ${round} 轮。你会收到上一轮验收门 verdict；只修复相关 gaps。如果上一轮已 pass=true，输出已通过无需返工的结构化结果。` : '',
    step.phase ? `阶段：${step.phase}` : '',
    `关注范围：${focus}`,
    `交付物：${deliverable}`,
    `验收线：${acceptance}`,
    `证据要求：${evidenceRequired}`,
    '',
    '输出必须按 DYNAMIC_WORKER_RESULT：artifact 写产物/结论/路径，evidence 写可复查证据，gaps 写未完成或风险。',
  ].filter(Boolean).join('\n');
}

export function parseDynamicHarnessSpec(text: string | undefined, request: string): DynamicHarnessSpec {
  return parseDynamicHarnessSpecResult(text, request).spec;
}

/**
 * Like {@link parseDynamicHarnessSpec} but reports whether the planner output
 * actually yielded a usable spec (`usedFallback: false`) or we fell back to the
 * keyword-inferred default (`usedFallback: true`). The CLI uses this to surface
 * a `planner_fallback` event so a degraded run isn't silent.
 */
export function parseDynamicHarnessSpecResult(
  text: string | undefined,
  request: string,
): { spec: DynamicHarnessSpec; usedFallback: boolean } {
  const extracted = text ? extractJson(text) : null;
  if (!extracted) return { spec: fallbackHarnessSpec(request), usedFallback: true };
  return { spec: normalizeHarnessSpec(extracted.value, request), usedFallback: false };
}

export interface DynamicPlanCritique {
  ok: boolean;
  issues: { field: string; severity: string; problem: string; fix: string }[];
}

/**
 * Resolve the harness spec from the planner + plan-critic outputs. The critic's
 * `revisedSpec` is authoritative when present (it audited and repaired the
 * planner's spec); we fall back to the raw planner spec, then to the
 * keyword-inferred default. `usedFallback` is true only when NEITHER the critic
 * nor the planner produced a usable spec. `critiqueApplied` reports whether the
 * critic's revision was the source, and `critique` carries the issues it found
 * (surfaced as a run event so a silently-corrected plan isn't invisible).
 */
export function resolvePlannedSpec(
  plannerText: string | undefined,
  critiqueText: string | undefined,
  request: string,
): {
  spec: DynamicHarnessSpec;
  usedFallback: boolean;
  critiqueApplied: boolean;
  critique: DynamicPlanCritique | null;
} {
  const critiqueExtract = critiqueText ? extractJson(critiqueText) : null;
  const critiqueValue = critiqueExtract && isRecord(critiqueExtract.value) ? critiqueExtract.value : null;
  const critique = critiqueValue ? parsePlanCritique(critiqueValue) : null;

  // The critic's revisedSpec is authoritative when it is a usable object.
  if (critiqueValue && isRecord(critiqueValue.revisedSpec)) {
    return {
      spec: normalizeHarnessSpec(critiqueValue.revisedSpec, request),
      usedFallback: false,
      critiqueApplied: true,
      critique,
    };
  }

  // No usable revision → fall back to the raw planner spec.
  const planner = parseDynamicHarnessSpecResult(plannerText, request);
  return {
    spec: planner.spec,
    usedFallback: planner.usedFallback,
    critiqueApplied: false,
    critique,
  };
}

function parsePlanCritique(value: Record<string, unknown>): DynamicPlanCritique {
  return {
    ok: value.ok === true,
    issues: arrayOfRecords(value.issues).map((issue) => ({
      field: stringValue(issue.field, ''),
      severity: stringValue(issue.severity, 'P2'),
      problem: stringValue(issue.problem, ''),
      fix: stringValue(issue.fix, ''),
    })),
  };
}

export function extractHarnessArtifacts(outputs: Record<string, string>): DynamicHarnessArtifacts {
  return {
    ledger: parseLedger(outputs[LEDGER_NODE_ID]),
    verdict: parseVerdict(outputs[GATE_NODE_ID]),
    report: outputs[REPORT_NODE_ID] ?? '',
  };
}

/**
 * Machine-level acceptance: a verdict only truly passes when the model claims
 * `pass` AND every success criterion is actually met.
 *
 * Behaviour by coverage state:
 *  - No `criteriaCoverage` rows → trust the raw `pass` flag (a terse acceptor
 *    that vouches without itemizing; preserves legacy/simple flows).
 *  - Some coverage rows → the acceptor opted into itemizing, so it must do so
 *    HONESTLY: when `successCriteria` is supplied (the gate's authoritative
 *    list), EVERY criterion must have a matching row with `met: true`. A
 *    criterion silently omitted from a non-empty coverage list counts as NOT
 *    met — "list only the easy ones, drop the hard one" becomes a fail rather
 *    than a pass. Without `successCriteria`, every listed row must be met
 *    (legacy check).
 *
 * Matching is whitespace-normalized, case-insensitive, bidirectional-substring,
 * tolerating minor rewording.
 */
export function verdictEffectivePass(
  verdict: DynamicVerdict | null,
  successCriteria?: string[],
): boolean {
  if (!verdict) return false;
  if (!verdict.pass) return false;

  // Empty coverage → trust the raw pass flag (no itemization claimed).
  if (verdict.criteriaCoverage.length === 0) return true;

  const criteria = (successCriteria ?? []).map((c) => c.trim()).filter(Boolean);
  if (criteria.length > 0) {
    // Acceptor itemized AND we know the authoritative list: every criterion
    // must be covered and met. Omission from a non-empty list ⇒ unmet.
    return criteria.every((criterion) => {
      const row = verdict.criteriaCoverage.find((r) => criterionMatches(r.criterion, criterion));
      return !!row && row.met;
    });
  }

  // No authoritative list available: every listed row must be met.
  return verdict.criteriaCoverage.every((row) => row.met);
}

/** Whitespace-normalized, case-insensitive, bidirectional-substring match. */
function criterionMatches(a: string, b: string): boolean {
  const na = a.replace(/\s+/g, '').toLowerCase();
  const nb = b.replace(/\s+/g, '').toLowerCase();
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

export function fallbackHarnessSpec(request: string): DynamicHarnessSpec {
  const strategies = inferStrategies(request);
  const objective = request.trim() || '完成用户指定任务';
  const shape = inferTaskShape(request);
  const groups = fallbackWorkerGroups(shape);
  return {
    objective,
    nonGoals: ['不要扩大到用户未要求的重构或产品改版', '不要把未通过验收的候选结果包装成完成'],
    successCriteria: fallbackSuccessCriteria(shape),
    budget: { maxAgentCalls: 12, maxRounds: shape === 'debug' ? 3 : 2 },
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

type TaskShape = 'debug' | 'review' | 'generate' | 'classify' | 'generic';

/** Classify the request into a coarse task shape, mirroring inferStrategies' signals. */
function inferTaskShape(request: string): TaskShape {
  const text = request.toLowerCase();
  if (/test|flaky|失败|报错|bug|根因|debug|排查|incident|日志|崩溃|crash/.test(text)) return 'debug';
  if (/审查|安全|验证|核查|review|security|audit|claim|事实|引用|合规/.test(text)) return 'review';
  if (/命名|方案|设计|候选|创意|name|design|option|文案|草稿|生成/.test(text)) return 'generate';
  if (/分类|triage|工单|简历|排序|排名|rank|classif|打标|归类/.test(text)) return 'classify';
  return 'generic';
}

function fallbackSuccessCriteria(shape: TaskShape): string[] {
  switch (shape) {
    case 'debug':
      return ['失败被稳定复现并定位根因', '修复后验证通过且有命令证据', '没有引入新的回归或目标漂移'];
    case 'review':
      return ['每条结论都对应可复查的原始证据', '反面复核覆盖了过度声称和遗漏', '通过/不通过判定明确并列出 gaps'];
    case 'generate':
      return ['产出多个候选并择优', '最终方案直接回应用户目标并说明取舍', '关键主张有依据，区分候选与定稿'];
    case 'classify':
      return ['分类/排序规则明确且一致', '每个条目的归类有理由', '边界与不确定项被标注'];
    default:
      return ['产物直接回应用户目标', '关键结论或变更有可复查证据', '验收门明确通过/不通过，并列出 gaps'];
  }
}

function fallbackWorkerGroups(shape: TaskShape): DynamicWorkerGroup[] {
  switch (shape) {
    case 'debug':
      return [
        { id: 't1', title: '复现', focus: '稳定复现失败，收集日志与触发条件。', deliverable: '可复现步骤与失败样本', acceptance: '给出可重复触发失败的命令与输出。', evidenceRequired: '命令输出、失败日志' },
        { id: 't2', title: '定位与修复', focus: '定位根因并产出最小修复。', deliverable: '根因说明与代码变更', acceptance: '根因有证据支撑，修复范围最小且针对性强。', evidenceRequired: '文件路径、diff、根因推理链' },
        { id: 't3', title: '验证', focus: '验证修复有效且无回归。', deliverable: '验证记录', acceptance: '修复后测试/命令通过，并复核未引入回归。', evidenceRequired: '验证命令输出、对照结果' },
      ];
    case 'review':
      return [
        { id: 't1', title: '提取论断', focus: '从材料中抽取需要核验的论断/主张。', deliverable: '论断清单', acceptance: '论断可逐条核验，附原文位置。', evidenceRequired: '原文片段、出处' },
        { id: 't2', title: '并行核验', focus: '对照可信来源逐条核验论断。', deliverable: '核验结果', acceptance: '每条结论都有来源或文件路径。', evidenceRequired: '来源链接、文件路径、命令输出' },
        { id: 't3', title: '反面复核', focus: '寻找过度声称、证据不足与遗漏。', deliverable: '风险清单', acceptance: '每个风险有原因和下一步。', evidenceRequired: '复核记录、对照证据' },
      ];
    case 'generate':
      return [
        { id: 't1', title: '生成候选', focus: '围绕目标产出多个差异化候选。', deliverable: '候选集合', acceptance: '至少给出 3 个角度不同的候选。', evidenceRequired: '候选列表与各自取舍' },
        { id: 't2', title: '筛选定稿', focus: '按质量择优并合并亮点产出定稿。', deliverable: '最终方案', acceptance: '定稿回应目标并说明为何优于其它候选。', evidenceRequired: '评比理由、最终产物' },
        { id: 't3', title: '验证与风险', focus: '检查定稿是否有遗漏、过度声称或风险。', deliverable: '验证记录与风险', acceptance: '每个风险有原因和下一步。', evidenceRequired: '复核清单、对照证据' },
      ];
    case 'classify':
      return [
        { id: 't1', title: '规则梳理', focus: '明确分类/排序的口径与边界。', deliverable: '规则说明', acceptance: '规则一致、可执行、覆盖边界情况。', evidenceRequired: '规则定义、示例' },
        { id: 't2', title: '执行归类', focus: '按规则对条目分类/排序。', deliverable: '归类结果', acceptance: '每个条目有归类理由，标注不确定项。', evidenceRequired: '逐条理由、置信度' },
        { id: 't3', title: '验证与风险', focus: '抽检一致性、找错分与边界争议。', deliverable: '验证记录与风险', acceptance: '抽检有证据，争议项有下一步。', evidenceRequired: '抽检记录、对照证据' },
      ];
    default:
      return [
        { id: 't1', title: '现状与约束', focus: '研究目标、现有上下文、相关文件/资料、隐含约束和不在范围内的事项。', deliverable: '现状分析与约束清单', acceptance: '列出可复查依据，明确范围边界，不做未经证据支持的结论。', evidenceRequired: '文件路径、命令输出、来源链接或明确的推理依据' },
        { id: 't2', title: '方案与执行', focus: '根据目标产出最小充分方案或执行核心任务。', deliverable: '可交付方案/变更/结论', acceptance: '覆盖用户目标，说明关键取舍，并标出未完成事项。', evidenceRequired: '产物路径、关键命令、检查结果或结构化结论' },
        { id: 't3', title: '验证与风险', focus: '从反面寻找漏洞、遗漏、证据不足、目标漂移和过度声称。', deliverable: '验证记录与风险/gaps', acceptance: '每个风险都有原因和下一步动作；通过项有证据支撑。', evidenceRequired: '验证命令、复核清单、失败/通过证据' },
      ];
  }
}

function dynamicPlannerPrompt(request: string): string {
  return [
    '你是 /ultracode 的动态工作流 harness 规划器。',
    '你的任务不是直接完成用户任务，而是为当前任务即时生成一个可执行 harness 规格。',
    '六种模式只能作为内部策略组合：classify-and-act、fan-out-and-synthesize、adversarial-verification、generate-and-filter、tournament、loop-until-done。',
    '不要让用户选择模式；你要根据任务风险和形态自己选择。',
    '优先生成 plan：1 到 6 个会真实执行的动态步骤，每个步骤 kind 只能是 agent、parallel、pipeline、consensus。',
    'agent 用于单一明确任务；parallel 用于互不依赖的 fan-out；pipeline 用于前后依赖的连续加工；consensus 只用于中间候选/核验，不要替代最终验收门。',
    'dependsOn 语义必须准确：省略 dependsOn 表示默认依赖上一个步骤；dependsOn: [] 表示该步骤可从 ledger 后并行启动；任何综合、核验、定稿、报告、落盘步骤都必须显式 dependsOn 它需要读取的上游步骤，不能写成 []。',
    '对 deep-research、产品调研、技术路线、架构建议这类任务，默认 plan 形状应为 scope → parallel source/context research → synthesis/recommendations → adversarial verification → final decision brief/report，并用 dependsOn 串起来。',
    'pipeline 默认是单条链（stages 顺序加工同一份输入）。如果你能在创作期就把要处理的对象逐一列举出来（例如多个文件、多个模块、多条记录），把 items 写成一个 JSON 数组字符串，例如 items: "[\\"src/a.ts\\",\\"src/b.ts\\"]"；这样每个条目会各自独立跑完所有 stage 并发执行（适合逐文件迁移/逐项审计）。无法在创作期列举的运行期动态清单不要硬塞，改用单条链或 parallel。',
    'plan 中每个步骤/分支/阶段都要写 title、prompt/focus、deliverable、acceptance、evidenceRequired；不要预声明不会运行的阶段。',
    '最终任务账本、验收门和报告由 harness 自动补上，plan 只描述中间执行体。',
    'workerGroups 必须是 2 到 5 个可并行或半独立的任务组，每组都要有 deliverable、acceptance、evidenceRequired。',
    'acceptance 按任务风险给出验收门强度：低风险 voters=2 strategy=adversarial；高风险（安全、事实核查、不可逆操作）voters 给 3 到 5，strategy 用 adversarial 或 multi-lens。',
    'successCriteria 要可逐条核验——验收门会强制对每一条打勾，任一条不满足都不通过。每条标准都要写成可观测、可判定的样子（含明确对象/动词/可检查信号），避免“质量好”“符合预期”这类无法核验的措辞。',
    '如果任务是产品/技术路线调研，successCriteria 必须验收决策价值，而不只是报告格式：至少包含 Top 3/5 opportunities、明确优先级、MVP/原型切入点、当前项目触点、本阶段不做什么、风险与验证信号。',
    'objectiveChecks：尽量给出不依赖模型自评的客观检查，作为验收的真值信号。每项 kind 只能是 file-exists、file-contains、command 之一：',
    '  - file-exists：断言某产物路径存在（填 path）。',
    '  - file-contains：断言某文件存在且包含关键字符串（填 path 和 contains）。这也用于核验 worker 自报的“我写了 X”证据。',
    '  - command：可复跑且退出码 0 即通过的命令（填 command，如测试/类型检查）。注意 command 默认不会自动执行（需要用户显式开启），所以能用 file-exists/file-contains 表达的就优先用它们。',
    '  path 优先写相对工作区路径，并使用 / 分隔符（例如 app/src/core/ir.ts）；不要写 E:\\、C:\\、/Users/...、target/release 或其它机器专属绝对路径，除非用户明确给定。command 必须跨平台，优先 npm/node/git/rg 这类命令；不要默认生成 PowerShell、cmd.exe、bash 专属语法。',
    '  每项都加一句 description 说明它验证哪条成功标准。无法给出客观检查时可留空数组，不要编造不存在的路径或命令。',
    '预算要务实，避免为了简单任务过度并行。',
    '',
    '用户任务：',
    request,
  ].join('\n');
}

/**
 * Plan-critic prompt: a stronger model audits the planner's spec BEFORE any
 * work runs. It is not asked to redo planning from scratch — it must return the
 * planner's spec corrected in place (`revisedSpec`), so a good plan passes
 * through nearly untouched while a flawed one gets repaired at the one point
 * where the whole run's accuracy is still cheap to fix.
 */
function planCriticPrompt(request: string): string {
  return [
    '你是 /ultracode 的规格复审员（plan-critic）。',
    '上游规划器已产出一份动态 harness 规格（DYNAMIC_HARNESS JSON，在你的输入里）。',
    '你的职责不是重新规划，而是审计并就地修正这份规格，因为下游每个执行节点和验收门都继承它——这里是修正错误成本最低的位置。',
    '逐项检查并修复：',
    '1. successCriteria：每条是否可观测、可逐条机检？把“质量好/符合预期”这类无法核验的改写成带明确对象与可检查信号的判定句；漏掉的关键标准要补上。',
    '2. workerGroups / plan：是否完整覆盖 objective，且彼此范围不重叠、不遗漏？有缺口就调整任务组或步骤。',
    '3. nonGoals：是否真的把范围框住，挡掉了用户没要求的扩张？不足就补。',
    '4. budget：maxAgentCalls / maxRounds 是否与任务规模匹配？过大就收敛，过小就适度提高。',
    '5. acceptance：高风险任务（安全、事实核查、不可逆操作）voters 是否足够（3-5）？',
    '6. objectiveChecks：是否给了不依赖模型自评的客观检查？能加 file-exists/file-contains 来核验产物或证据的就补上；不要编造不存在的路径或命令。',
    '7. plan dependsOn：是否真的表达执行顺序？dependsOn: [] 只允许用于可并行启动的根步骤；综合、核验、定稿、报告、落盘步骤不能是空依赖，必须依赖其上游证据/草案步骤。',
    '8. 决策型研究价值：如果用户要产品/技术路线建议，successCriteria 和 final deliverable 必须要求决策简报（优先级、MVP、项目触点、不做什么、验证信号），不能只验 source ledger / claim audit / 章节格式。',
    '9. 跨平台性：路径和命令是否能在 Windows 与 macOS 上工作？objectiveChecks 的 path 优先相对路径 + / 分隔符；不要把 Windows 盘符、PowerShell、NSIS、target/release 等 host-specific 假设写进通用验收。',
    '把发现的问题写进 issues（field/severity/problem/fix），把修正后的完整规格写进 revisedSpec。',
    'revisedSpec 必须是一份完整、合法、可直接执行的 DYNAMIC_HARNESS（保留 plan/workerGroups 等所有字段，不要只给 diff）。',
    '如果原规格已经过硬，ok=true、issues 可为空，revisedSpec 原样回填即可。',
    '严格按 DYNAMIC_PLAN_CRITIQUE 输出。',
    '',
    '用户任务（用于判断规格是否切题）：',
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

function repairWorkerPrompt(
  spec: DynamicHarnessSpec,
  group: DynamicWorkerGroup,
  round: number,
): string {
  return [
    `你是 ${group.title} worker 的第 ${round} 轮返工。`,
    '你会收到上一轮 worker 输出和验收门 verdict。只修复与你 taskId/group id 匹配的 gaps。',
    '如果上一轮 verdict 已经 pass=true，输出 DYNAMIC_WORKER_RESULT，说明无需返工，不要重复执行。',
    '如果预算或证据不足，必须把缺口写进 gaps，不要声称完成。',
    '',
    `总目标：${spec.objective}`,
    `taskId：${group.id}`,
    `关注范围：${group.focus}`,
    `交付物：${group.deliverable}`,
    `验收线：${group.acceptance}`,
    `证据要求：${group.evidenceRequired}`,
    '',
    '输出必须按 DYNAMIC_WORKER_RESULT：artifact 写本轮新增/修复产物，evidence 写可复查证据，gaps 写仍未完成或风险。',
  ].join('\n');
}

function acceptorPrompt(spec: DynamicHarnessSpec): string {
  return [
    '你是验收者。逐条对照任务账本、worker 输出和验收 rubric。',
    '不接受“已完成”这类声明；没有证据就不通过。',
    '只把通过验收的内容放入 acceptedArtifact；未通过项写入 gaps。',
    '你必须在 criteriaCoverage 中逐条对照下面每一条“成功标准”，给出 met 和对应 evidence；只要有任一条 met=false，pass 必须为 false。',
    '',
    `目标：${spec.objective}`,
    listBlock('成功标准（必须逐条覆盖）', spec.successCriteria),
    listBlock('验收 Rubric', spec.acceptanceRubric),
    planBlock(spec),
    `停止条件：${spec.stopCondition}`,
    '',
    '严格按 DYNAMIC_VERDICT 输出，criteriaCoverage 需覆盖每一条成功标准。',
  ].join('\n');
}

function repairAcceptorPrompt(spec: DynamicHarnessSpec, round: number): string {
  return [
    `你是第 ${round} 轮验收者。逐条对照任务账本、所有 worker 输出、上一轮 verdict 和验收 rubric。`,
    '如果上一轮已 pass=true 且本轮无新风险，可以继续 pass=true；否则只接受已被本轮证据修复的内容。',
    '没有证据就不通过。只把通过验收的内容放入 acceptedArtifact；未通过项写入 gaps。',
    '你必须在 criteriaCoverage 中逐条对照下面每一条“成功标准”，给出 met 和对应 evidence；只要有任一条 met=false，pass 必须为 false。',
    '',
    `目标：${spec.objective}`,
    listBlock('成功标准（必须逐条覆盖）', spec.successCriteria),
    listBlock('验收 Rubric', spec.acceptanceRubric),
    planBlock(spec),
    `停止条件：${spec.stopCondition}`,
    '',
    '严格按 DYNAMIC_VERDICT 输出，criteriaCoverage 需覆盖每一条成功标准。',
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

function repairSkepticPrompt(spec: DynamicHarnessSpec, round: number): string {
  return [
    `你是第 ${round} 轮反面复核者。重点复核上一轮 gaps 是否真的被修复。`,
    '站在对立面找遗漏、冲突、证据不足、目标漂移和过度声称；任何存疑都写成 gap，并给 nextAction。',
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

function filterPrompt(spec: DynamicHarnessSpec): string {
  return [
    '你是候选筛选/择优者。上游并行 worker 产出了多个候选产物。',
    '按质量择优选出最佳候选，并把其它候选中值得借鉴的亮点合并进来，输出统一的最佳产物。',
    '不要简单拼接，要解决候选之间的冲突；没有证据支撑的内容不要保留。',
    '',
    `总目标：${spec.objective}`,
    listBlock('成功标准', spec.successCriteria),
    '',
    '输出必须按 DYNAMIC_WORKER_RESULT：artifact 写择优后的统一产物，evidence 写可复查证据，gaps 写仍未解决项。',
  ].join('\n');
}

function synthesizePrompt(spec: DynamicHarnessSpec): string {
  return [
    '你是综合者。上游并行 worker 各自产出了结果，可能存在重叠或冲突。',
    '把它们消化成一份统一草稿：去重、解决冲突、补齐衔接，但不要扩大范围或编造证据。',
    '冲突无法靠现有证据解决时，写进 gaps 而不是强行下结论。',
    '',
    `总目标：${spec.objective}`,
    listBlock('成功标准', spec.successCriteria),
    '',
    '输出必须按 DYNAMIC_WORKER_RESULT：artifact 写综合后的统一草稿，evidence 写可复查证据，gaps 写冲突或未完成项。',
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
  const plan = normalizeDynamicPlan(value.plan, stringValue(value.objective, request));
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
    ...(normalizeAcceptance(value.acceptance)
      ? { acceptance: normalizeAcceptance(value.acceptance)! }
      : {}),
    ...(normalizeObjectiveChecks(value.objectiveChecks).length > 0
      ? { objectiveChecks: normalizeObjectiveChecks(value.objectiveChecks) }
      : {}),
    stopCondition: stringValue(value.stopCondition, fallback.stopCondition),
  };
}

/** Hard ceiling on agent calls (mirrors the clampInt max in normalizeHarnessSpec). */
export const HARD_MAX_AGENT_CALLS = 32;

/**
 * Leaf agent-call count a single plan step expands into at run time. Mirrors
 * {@link dynamicPlanStepNode}: parallel → one call per branch, pipeline → one
 * per stage, consensus → one per voter plus a synthesis pass, agent → one.
 */
function planStepLeafCalls(step: DynamicPlanStep): number {
  switch (step.kind) {
    case 'parallel':
      return Math.max(1, step.branches?.length ?? 1);
    case 'pipeline':
      return Math.max(1, step.stages?.length ?? 1);
    case 'consensus':
      // voters + 1 synthesis pass (resolveConsensus); a machine veto can make
      // this cheaper, so this is the worst case — exactly what budgeting wants.
      return Math.max(1, step.voters?.length ?? 1) + 1;
    case 'agent':
    default:
      return 1;
  }
}

/**
 * Estimate the worst-case agent-call cost of running the harness for `rounds`
 * rounds. Mirrors buildDynamicHarnessGraph / buildWorkerHarness node expansion
 * (setup = scope + ledger, per round = work + acceptance gate, plus a final
 * report) so the budget can be reconciled against reality before the run.
 * Worst case = no round short-circuits via skipIfVerdictPass.
 */
export function estimateHarnessCalls(spec: DynamicHarnessSpec, rounds: number): number {
  const setup = 2; // n_scope + n_ledger
  const report = 1; // n_report
  const gateVoters = Math.max(2, spec.acceptance?.voters ?? 2);
  const gateCost = gateVoters + 1; // voters + synthesis pass
  let roundWork: number;
  if (spec.plan && spec.plan.length > 0) {
    const plan = spec.plan;
    roundWork = plan.reduce((sum, step) => sum + planStepLeafCalls(step), 0);
    // Plan-path mid-stage (synthesize/filter) when strategies + fan-out call for it.
    const planMid = planMidStageApplies(spec, plan) ? midStageStrategy(spec) : null;
    if (planMid) roundWork += midStageLeafCalls(planMid);
  } else {
    // Worker-group path: one call per group, plus an optional mid-stage.
    const workers = Math.max(1, spec.workerGroups.length);
    const mid = midStageKind(spec);
    roundWork = workers + (mid ? midStageLeafCalls(mid) : 0);
  }
  return setup + rounds * (roundWork + gateCost) + report;
}

/**
 * Reconcile budget.maxAgentCalls with budget.maxRounds so the planner can't
 * declare more repair rounds than the call budget can fund — the failure mode
 * where a 2-round plan exhausted its budget at the very first acceptance gate.
 *
 * Strategy: honor the requested rounds by raising maxAgentCalls to fit them,
 * capped at {@link HARD_MAX_AGENT_CALLS}. Only when even the ceiling can't fund
 * the requested rounds do we lower maxRounds to what fits (>= 1). Returns the
 * possibly-adjusted spec plus a human-readable note when anything changed.
 */
export function reconcileBudget(
  spec: DynamicHarnessSpec,
  ceiling: number = HARD_MAX_AGENT_CALLS,
): { spec: DynamicHarnessSpec; note: string | null } {
  const hardCeiling = Math.max(1, Math.min(HARD_MAX_AGENT_CALLS, Math.floor(ceiling)));
  const requestedRounds = spec.budget.maxRounds;
  const requestedCalls = spec.budget.maxAgentCalls;
  const needForRequested = estimateHarnessCalls(spec, requestedRounds);
  if (requestedCalls >= needForRequested) return { spec, note: null };

  // Prefer funding the requested rounds by raising the ceiling.
  if (needForRequested <= hardCeiling) {
    return {
      spec: { ...spec, budget: { maxAgentCalls: needForRequested, maxRounds: requestedRounds } },
      note:
        `预算自洽：maxAgentCalls ${requestedCalls} 不足以支撑 ${requestedRounds} 轮` +
        `（最坏需 ~${needForRequested} 次），已上调至 ${needForRequested}。`,
    };
  }

  // The ceiling can't fund all requested rounds — keep the ceiling and drop
  // rounds to the most that fits (never below 1).
  let fitRounds = requestedRounds;
  while (fitRounds > 1 && estimateHarnessCalls(spec, fitRounds) > hardCeiling) {
    fitRounds -= 1;
  }
  const fitCalls = Math.min(
    hardCeiling,
    Math.max(requestedCalls, estimateHarnessCalls(spec, fitRounds)),
  );
  return {
    spec: { ...spec, budget: { maxAgentCalls: fitCalls, maxRounds: fitRounds } },
    note:
      `预算自洽：${requestedRounds} 轮最坏需 ~${needForRequested} 次调用，超过上限 ${hardCeiling}；` +
      `已降为 ${fitRounds} 轮并设 maxAgentCalls=${fitCalls}。`,
  };
}

/**
 * Normalize planner-supplied objective checks. Drops malformed/empty entries
 * (a check that names neither a path nor a command is unrunnable noise), caps
 * the count so a runaway planner can't spawn dozens of checks, and only keeps
 * the fields each kind actually needs.
 */
function normalizeObjectiveChecks(value: unknown): DynamicObjectiveCheck[] {
  return arrayOfRecords(value)
    .map((raw): DynamicObjectiveCheck | null => {
      const kind = raw.kind;
      const path = optionalString(raw.path);
      const contains = optionalString(raw.contains);
      const command = optionalString(raw.command);
      const description = optionalString(raw.description);
      if (kind === 'file-exists' && path) {
        return { kind, path, ...(description ? { description } : {}) };
      }
      if (kind === 'file-contains' && path && contains) {
        return { kind, path, contains, ...(description ? { description } : {}) };
      }
      if (kind === 'command' && command) {
        return { kind, command, ...(description ? { description } : {}) };
      }
      return null;
    })
    .filter((check): check is DynamicObjectiveCheck => check !== null)
    .slice(0, 12);
}

/** Normalize a planner-supplied acceptance gate config (voters clamped 2..5). */
function normalizeAcceptance(value: unknown): DynamicAcceptanceConfig | undefined {
  if (!isRecord(value)) return undefined;
  const strategy = normalizeConsensusStrategy(value.strategy);
  const votersRaw = value.voters;
  const voters =
    typeof votersRaw === 'number' && Number.isFinite(votersRaw)
      ? Math.min(5, Math.max(2, Math.floor(votersRaw)))
      : undefined;
  if (voters === undefined && !strategy) return undefined;
  return { voters: voters ?? 2, strategy: strategy ?? 'adversarial' };
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

function normalizeDynamicPlan(value: unknown, objective = ''): DynamicPlanStep[] {
  const used = new Set<string>();
  const plan = arrayOfRecords(value)
    .map((step, index): DynamicPlanStep | null => {
      const kind = normalizePlanKind(step.kind);
      if (!kind) return null;
      const id = uniquePlanId(
        safeId(stringValue(step.id, `step${index + 1}`)) || `step${index + 1}`,
        used,
      );
      const title = stringValue(step.title ?? step.label, `动态步骤 ${index + 1}`);
      const dependsOn = Array.isArray(step.dependsOn)
        ? stringArray(step.dependsOn, []).map(safeId).filter(Boolean)
        : undefined;
      const normalized: DynamicPlanStep = {
        id,
        kind,
        title,
        phase: optionalString(step.phase),
        prompt: optionalString(step.prompt),
        focus: optionalString(step.focus),
        deliverable: optionalString(step.deliverable),
        acceptance: optionalString(step.acceptance),
        evidenceRequired: optionalString(step.evidenceRequired),
        agentType: optionalString(step.agentType),
        model: optionalString(step.model),
        schema: optionalString(step.schema),
        items: optionalString(step.items),
        ...(dependsOn !== undefined ? { dependsOn } : {}),
        branches: normalizePlanActors(step.branches, 'branch'),
        stages: normalizePlanActors(step.stages, 'stage'),
        voters: normalizePlanActors(step.voters, 'voter'),
        strategy: normalizeConsensusStrategy(step.strategy),
        quorum: optionalPositiveInt(step.quorum, 16),
        samples: optionalPositiveInt(step.samples, 16),
      };
      return normalized;
    })
    .filter((step): step is DynamicPlanStep => !!step)
    .slice(0, 6);
  return repairAmbiguousResearchPlanDependencies(plan, objective);
}

function repairAmbiguousResearchPlanDependencies(
  plan: DynamicPlanStep[],
  objective: string,
): DynamicPlanStep[] {
  if (plan.length < 3) return plan;
  if (!looksLikeSequentialResearchPlan(plan, objective)) return plan;

  let changed = false;
  const repaired = plan.map((step, index) => {
    if (index === 0) return step;
    if (Array.isArray(step.dependsOn) && step.dependsOn.length > 0) return step;
    changed = true;
    return { ...step, dependsOn: [plan[index - 1]!.id] };
  });
  return changed ? repaired : plan;
}

function looksLikeSequentialResearchPlan(plan: DynamicPlanStep[], objective: string): boolean {
  const text = `${objective}\n${plan
    .map((step) => `${step.title} ${step.focus ?? ''} ${step.prompt ?? ''}`)
    .join('\n')}`.toLowerCase();
  const researchSignal =
    /deep[- ]?research|source ledger|claim audit|research|调研|研究|证据|来源|引用/.test(text);
  const orderedSignals = [
    /scope|freeze|范围|目标冻结/.test(text),
    /synth|综合|汇总|矩阵|recommend|建议/.test(text),
    /verify|verification|audit|核验|复核|验收/.test(text),
    /final|report|brief|报告|简报|定稿/.test(text),
  ].filter(Boolean).length;
  return researchSignal && orderedSignals >= 2;
}

function uniquePlanId(base: string, used: Set<string>): string {
  const root = base || 'step';
  let id = root;
  let suffix = 2;
  while (used.has(id)) {
    id = `${root}_${suffix}`;
    suffix += 1;
  }
  used.add(id);
  return id;
}

function normalizePlanActors(value: unknown, prefix: string): DynamicPlanActor[] | undefined {
  const actors = arrayOfRecords(value)
    .map((actor, index): DynamicPlanActor => ({
      id: optionalString(actor.id) ?? `${prefix}${index + 1}`,
      title: optionalString(actor.title),
      label: optionalString(actor.label),
      prompt: optionalString(actor.prompt),
      focus: optionalString(actor.focus),
      deliverable: optionalString(actor.deliverable),
      acceptance: optionalString(actor.acceptance),
      evidenceRequired: optionalString(actor.evidenceRequired),
      agentType: optionalString(actor.agentType),
      model: optionalString(actor.model),
      schema: optionalString(actor.schema),
    }))
    .filter((actor) => !!(actor.title || actor.label || actor.prompt || actor.focus))
    .slice(0, 8);
  return actors.length > 0 ? actors : undefined;
}

function normalizePlanKind(value: unknown): DynamicPlanStepKind | null {
  return value === 'agent' || value === 'parallel' || value === 'pipeline' || value === 'consensus'
    ? value
    : null;
}

function normalizeConsensusStrategy(value: unknown): ConsensusStrategy | undefined {
  return value === 'adversarial' ||
    value === 'multi-lens' ||
    value === 'tournament' ||
    value === 'self-consistency'
    ? value
    : undefined;
}

function optionalPositiveInt(value: unknown, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return undefined;
  return Math.min(max, Math.max(1, Math.floor(value)));
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

/**
 * CONTRACT (acceptance-gate safety): when the gate's output is not a parseable
 * verdict object, this returns `null`, and {@link verdictEffectivePass} maps a
 * `null` verdict to `false`. Together they guarantee that a gate which fails to
 * emit a valid DYNAMIC_VERDICT is treated as NOT PASSED — schema enforcement is
 * best-effort/non-fatal for ordinary worker nodes, but the acceptance gate must
 * never be auto-passed on malformed output. Do not change this to a lenient
 * default without revisiting verdictEffectivePass.
 */
function parseVerdict(text: string | undefined): DynamicVerdict | null {
  const extracted = text ? extractJson(text) : null;
  if (!extracted || !isRecord(extracted.value)) return null;
  const v = extracted.value;
  return {
    pass: v.pass === true,
    acceptedArtifact: stringValue(v.acceptedArtifact, ''),
    evidence: stringArray(v.evidence, []),
    criteriaCoverage: arrayOfRecords(v.criteriaCoverage).map((row) => ({
      criterion: stringValue(row.criterion, ''),
      met: row.met === true,
      evidence: stringValue(row.evidence, ''),
    })),
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

function planBlock(spec: DynamicHarnessSpec): string {
  if (!spec.plan || spec.plan.length === 0) return '动态执行计划：未提供，按 workerGroups 执行。';
  return `动态执行计划：\n${spec.plan
    .map((step, index) => {
      const parts = [
        `${index + 1}. ${step.id} ${step.title} (${step.kind})`,
        step.phase ? `phase: ${step.phase}` : '',
        step.dependsOn && step.dependsOn.length > 0 ? `dependsOn: ${step.dependsOn.join(', ')}` : '',
        step.focus ? `focus: ${step.focus}` : '',
        step.deliverable ? `deliverable: ${step.deliverable}` : '',
        step.acceptance ? `acceptance: ${step.acceptance}` : '',
        step.evidenceRequired ? `evidenceRequired: ${step.evidenceRequired}` : '',
      ].filter(Boolean);
      return parts.join('\n  ');
    })
    .join('\n')}`;
}

function listBlock(title: string, values: string[]): string {
  if (values.length === 0) return `${title}：无`;
  return `${title}：\n${values.map((value) => `- ${value}`).join('\n')}`;
}

function shortName(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 40) || 'dynamic task';
}

function safeId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 36);
}

function workerRoundNodeId(round: number): string {
  return round === 1 ? WORKERS_NODE_ID : `${WORKERS_NODE_ID}_r${round}`;
}

function gateRoundNodeId(round: number, totalRounds: number): string {
  return round === totalRounds ? GATE_NODE_ID : `${GATE_NODE_ID}_r${round}`;
}

function dynamicPlanNodeId(step: DynamicPlanStep, index: number, round: number): string {
  const base = `n_dyn_${index + 1}_${safeId(step.id || step.title)}`;
  return round === 1 ? base : `n_dyn_r${round}_${index + 1}_${safeId(step.id || step.title)}`;
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
