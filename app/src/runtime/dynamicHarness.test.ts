import { describe, expect, it } from 'vitest';
import {
  GATE_NODE_ID,
  HARD_MAX_AGENT_CALLS,
  LEDGER_NODE_ID,
  PLANNER_NODE_ID,
  PLAN_CRITIC_NODE_ID,
  REPORT_NODE_ID,
  WORKERS_NODE_ID,
  buildDynamicHarnessGraph,
  buildDynamicPlannerGraph,
  estimateHarnessCalls,
  extractHarnessArtifacts,
  fallbackHarnessSpec,
  parseDynamicHarnessSpec,
  reconcileBudget,
  resolvePlannedSpec,
  verdictEffectivePass,
} from './dynamicHarness';

describe('dynamic harness', () => {
  it('normalizes planner JSON into a bounded harness spec', () => {
    const spec = parseDynamicHarnessSpec(
      JSON.stringify({
        objective: '修复 flaky test',
        nonGoals: ['不要重写整个测试框架'],
        successCriteria: ['50 次运行不失败'],
        budget: { maxAgentCalls: 99, maxRounds: 9 },
        strategies: ['loop-until-done', 'adversarial-verification', 'bad-mode'],
        workerGroups: [
          {
            id: 't1',
            title: '复现',
            focus: '重复运行测试',
            deliverable: '失败样本',
            acceptance: '找到失败日志',
            evidenceRequired: '命令输出',
          },
        ],
        acceptanceRubric: ['有证据'],
        stopCondition: '通过验收',
      }),
      'fallback',
    );

    expect(spec.objective).toBe('修复 flaky test');
    expect(spec.budget.maxAgentCalls).toBe(32);
    expect(spec.budget.maxRounds).toBe(5);
    expect(spec.strategies).toEqual(['loop-until-done', 'adversarial-verification']);
    expect(spec.workerGroups).toHaveLength(1);
  });

  it('normalizes dynamic plan steps into a bounded executable DSL', () => {
    const spec = parseDynamicHarnessSpec(
      JSON.stringify({
        objective: '实现并验证功能',
        nonGoals: ['不改 UI'],
        successCriteria: ['测试通过'],
        budget: { maxAgentCalls: 20, maxRounds: 2 },
        strategies: ['fan-out-and-synthesize'],
        plan: [
          {
            id: 'Scan Files',
            kind: 'agent',
            title: '扫描文件',
            focus: '找相关文件',
            deliverable: '文件清单',
            acceptance: '列出证据路径',
            evidenceRequired: '文件路径',
          },
          {
            id: 'build+verify',
            kind: 'pipeline',
            title: '实现并验证',
            dependsOn: ['Scan Files'],
            stages: [
              {
                title: '实现',
                focus: '修改代码',
                deliverable: '代码变更',
                acceptance: '覆盖需求',
                evidenceRequired: 'diff',
              },
              {
                title: '验证',
                focus: '运行测试',
                deliverable: '测试结果',
                acceptance: '测试通过',
                evidenceRequired: '命令输出',
              },
            ],
          },
          { id: 'bad', kind: 'branch', title: '非法步骤' },
        ],
        workerGroups: [],
        acceptanceRubric: ['有证据'],
        stopCondition: '验收通过',
      }),
      'fallback',
    );

    expect(spec.plan).toHaveLength(2);
    expect(spec.plan?.[0].id).toBe('scan_files');
    expect(spec.plan?.[1].id).toBe('build_verify');
    expect(spec.plan?.[1].dependsOn).toEqual(['scan_files']);
    expect(spec.plan?.[1].stages).toHaveLength(2);
  });

  it('preserves omitted dependsOn as implicit previous-step dependency', () => {
    const spec = parseDynamicHarnessSpec(
      JSON.stringify({
        objective: '线性实现并验证',
        successCriteria: ['完成'],
        budget: { maxAgentCalls: 20, maxRounds: 1 },
        strategies: [],
        plan: [
          { id: 'a', kind: 'agent', title: '步骤 A' },
          { id: 'b', kind: 'agent', title: '步骤 B' },
        ],
        workerGroups: [],
        acceptanceRubric: ['完成'],
        stopCondition: '验收通过',
      }),
      'fallback',
    );
    expect(spec.plan?.[1].dependsOn).toBeUndefined();
    const graph = buildDynamicHarnessGraph(spec);
    const a = graph.nodes.find((n) => n.id.includes('_a'));
    const b = graph.nodes.find((n) => n.id.includes('_b'));
    expect(graph.edges.some((e) => e.from.node === a?.id && e.to.node === b?.id && e.kind === 'exec')).toBe(true);
    expect(graph.edges.some((e) => e.from.node === LEDGER_NODE_ID && e.to.node === b?.id && e.kind === 'exec')).toBe(false);
  });

  it('repairs ambiguous deep-research plan dependencies into a decision chain', () => {
    const spec = parseDynamicHarnessSpec(
      JSON.stringify({
        objective: '执行 deep-research，调研产品路线并输出建议',
        successCriteria: ['有明确建议'],
        budget: { maxAgentCalls: 20, maxRounds: 1 },
        strategies: ['fan-out-and-synthesize', 'adversarial-verification'],
        plan: [
          { id: 'scope', kind: 'agent', title: 'Scope Freeze', dependsOn: [] },
          { id: 'research', kind: 'parallel', title: 'Parallel Source Research', dependsOn: [] },
          { id: 'synthesis', kind: 'agent', title: 'Synthesis Recommendations', dependsOn: [] },
          { id: 'verify', kind: 'consensus', title: 'Adversarial Verification', dependsOn: [] },
          { id: 'final', kind: 'agent', title: 'Final Decision Brief', dependsOn: [] },
        ],
        workerGroups: [],
        acceptanceRubric: ['有决策价值'],
        stopCondition: '验收通过',
      }),
      'fallback',
    );
    expect(spec.plan?.map((step) => step.dependsOn)).toEqual([
      [],
      ['scope'],
      ['research'],
      ['synthesis'],
      ['verify'],
    ]);
  });

  it('builds an executable ledger -> workers -> gate -> report graph', () => {
    const spec = parseDynamicHarnessSpec('', '审查博客里的技术论断');
    const graph = buildDynamicHarnessGraph(spec);

    expect(graph.meta.schemaDefs?.DYNAMIC_TASK_LEDGER).toBeTruthy();
    expect(graph.meta.schemaDefs?.DYNAMIC_WORKER_RESULT).toBeTruthy();
    expect(graph.meta.schemaDefs?.DYNAMIC_VERDICT).toBeTruthy();
    expect(graph.nodes.find((node) => node.id === LEDGER_NODE_ID)?.type).toBe('agent');
    expect(graph.nodes.find((node) => node.id === WORKERS_NODE_ID)?.type).toBe('parallel');
    expect(graph.nodes.find((node) => node.id === GATE_NODE_ID)?.type).toBe('consensus');
    expect(graph.edges.some((edge) => edge.from.node === WORKERS_NODE_ID && edge.to.node === GATE_NODE_ID && edge.kind === 'data')).toBe(true);
  });

  it('expands loop-until-done into bounded repair rounds', () => {
    const spec = parseDynamicHarnessSpec(
      JSON.stringify({
        objective: '修复失败测试',
        nonGoals: ['不重写模块'],
        successCriteria: ['测试通过'],
        budget: { maxAgentCalls: 16, maxRounds: 3 },
        strategies: ['loop-until-done', 'adversarial-verification'],
        workerGroups: [
          {
            id: 't1',
            title: '修复',
            focus: '定位并修复失败',
            deliverable: '代码变更',
            acceptance: '测试通过',
            evidenceRequired: '命令输出',
          },
        ],
        acceptanceRubric: ['有证据'],
        stopCondition: '验收通过或预算耗尽',
      }),
      'fallback',
    );

    const graph = buildDynamicHarnessGraph(spec);

    expect(graph.nodes.find((node) => node.id === WORKERS_NODE_ID)?.type).toBe('parallel');
    expect(graph.nodes.find((node) => node.id === 'n_workers_r2')?.type).toBe('parallel');
    expect(graph.nodes.find((node) => node.id === 'n_workers_r3')?.type).toBe('parallel');
    expect(graph.nodes.find((node) => node.id === 'n_gate_r1')?.type).toBe('consensus');
    expect(graph.nodes.find((node) => node.id === 'n_gate_r2')?.type).toBe('consensus');
    expect(graph.nodes.find((node) => node.id === GATE_NODE_ID)?.type).toBe('consensus');
    expect(graph.edges.some((edge) => edge.from.node === 'n_gate_r2' && edge.to.node === 'n_workers_r3' && edge.kind === 'exec')).toBe(true);
    expect(graph.edges.some((edge) => edge.from.node === GATE_NODE_ID && edge.to.node === REPORT_NODE_ID && edge.kind === 'exec')).toBe(true);
  });

  it('compiles a dynamic plan into executable steps while preserving ledger and acceptance gate', () => {
    const spec = parseDynamicHarnessSpec(
      JSON.stringify({
        objective: '完成复杂编程任务',
        nonGoals: ['不做无关重构'],
        successCriteria: ['产物通过验收'],
        budget: { maxAgentCalls: 16, maxRounds: 2 },
        strategies: ['fan-out-and-synthesize', 'adversarial-verification'],
        plan: [
          {
            id: 'inventory',
            kind: 'agent',
            title: '盘点题目',
            focus: '读取题目和约束',
            deliverable: '题目清单',
            acceptance: '清单完整',
            evidenceRequired: '文件路径',
          },
          {
            id: 'solve',
            kind: 'parallel',
            title: '分组求解',
            dependsOn: ['inventory'],
            branches: [
              {
                title: '前半题',
                focus: '完成 1-50',
                deliverable: '答案',
                acceptance: '格式正确',
                evidenceRequired: '输出路径',
              },
              {
                title: '后半题',
                focus: '完成 51-100',
                deliverable: '答案',
                acceptance: '格式正确',
                evidenceRequired: '输出路径',
              },
            ],
          },
          {
            id: 'verify',
            kind: 'consensus',
            title: '交叉复核',
            dependsOn: ['solve'],
            strategy: 'adversarial',
            voters: [
              {
                title: '格式复核',
                focus: '检查 HTML 结构',
                deliverable: '复核结论',
                acceptance: '100 条均存在',
                evidenceRequired: 'DOM 计数',
              },
              {
                title: '内容复核',
                focus: '检查答案覆盖',
                deliverable: '复核结论',
                acceptance: '无遗漏',
                evidenceRequired: '抽样记录',
              },
            ],
          },
        ],
        workerGroups: [],
        acceptanceRubric: ['完整覆盖', '证据充分'],
        stopCondition: '验收通过',
      }),
      'fallback',
    );
    const graph = buildDynamicHarnessGraph(spec);

    expect(graph.nodes.find((node) => node.id === LEDGER_NODE_ID)?.type).toBe('agent');
    expect(graph.nodes.find((node) => node.id === GATE_NODE_ID)?.type).toBe('consensus');
    expect(graph.nodes.some((node) => node.id.includes('inventory') && node.type === 'agent')).toBe(true);
    expect(graph.nodes.some((node) => node.id.includes('solve') && node.type === 'parallel')).toBe(true);
    expect(graph.nodes.some((node) => node.id.includes('verify') && node.type === 'consensus')).toBe(true);

    const solveNode = graph.nodes.find((node) => node.id.includes('solve'));
    const verifyNode = graph.nodes.find((node) => node.id.includes('verify'));
    expect(solveNode?.params.branches).toHaveLength(2);
    expect(verifyNode?.params.voters).toHaveLength(2);
    expect(graph.edges.some((edge) => edge.from.node === LEDGER_NODE_ID && edge.to.node === solveNode?.id && edge.kind === 'data')).toBe(true);
    expect(graph.edges.some((edge) => edge.from.node === verifyNode?.id && edge.to.node === GATE_NODE_ID && edge.kind === 'exec')).toBe(true);
    expect(graph.edges.some((edge) => edge.from.node === GATE_NODE_ID && edge.to.node === REPORT_NODE_ID && edge.kind === 'data')).toBe(true);
  });

  it('extracts ledger, verdict, and report artifacts from runtime outputs', () => {
    const artifacts = extractHarnessArtifacts({
      n_ledger: JSON.stringify({
        tasks: [{ id: 't1', title: '复现', status: 'accepted', acceptance: '有证据' }],
      }),
      n_gate: JSON.stringify({
        pass: true,
        acceptedArtifact: '已修复',
        evidence: ['npm test'],
        gaps: [],
      }),
      n_report: '验收通过',
    });

    expect(artifacts.ledger?.tasks[0]?.id).toBe('t1');
    expect(artifacts.ledger?.tasks[0]?.status).toBe('accepted');
    expect(artifacts.verdict?.pass).toBe(true);
    expect(artifacts.report).toBe('验收通过');
  });

  it('treats an unmet success criterion as a fail even when pass=true', () => {
    const artifacts = extractHarnessArtifacts({
      n_gate: JSON.stringify({
        pass: true,
        acceptedArtifact: '部分完成',
        evidence: ['x'],
        criteriaCoverage: [
          { criterion: '产物回应目标', met: true, evidence: 'a' },
          { criterion: '有可复查证据', met: false, evidence: '' },
        ],
        gaps: [],
      }),
    });
    expect(artifacts.verdict?.pass).toBe(true); // raw model claim
    expect(verdictEffectivePass(artifacts.verdict)).toBe(false); // machine gate overrides
  });

  it('falls back to the raw pass flag when no criteriaCoverage is given', () => {
    const artifacts = extractHarnessArtifacts({
      n_gate: JSON.stringify({ pass: true, acceptedArtifact: 'ok', evidence: [], gaps: [] }),
    });
    expect(verdictEffectivePass(artifacts.verdict)).toBe(true);
  });

  it('fails when an authoritative criterion is omitted from coverage (no silent escape)', () => {
    const criteria = ['产物回应目标', '关键结论有可复查证据', '验收门明确通过或不通过'];
    const verdict = {
      pass: true,
      acceptedArtifact: '只覆盖了一部分',
      evidence: ['x'],
      // Acceptor only covered ONE of the three criteria, all met=true.
      criteriaCoverage: [{ criterion: '产物回应目标', met: true, evidence: 'a' }],
      gaps: [],
    };
    const artifacts = extractHarnessArtifacts({ n_gate: JSON.stringify(verdict) });
    // Self-reported coverage all met → legacy check would pass…
    expect(verdictEffectivePass(artifacts.verdict)).toBe(true);
    // …but the set check against the authoritative criteria fails: two omitted.
    expect(verdictEffectivePass(artifacts.verdict, criteria)).toBe(false);
  });

  it('passes only when every authoritative criterion is covered and met', () => {
    const criteria = ['产物回应目标', '有可复查证据'];
    const verdict = {
      pass: true,
      acceptedArtifact: '完成',
      evidence: ['x'],
      criteriaCoverage: [
        // Superstring of the criterion (criterion ⊂ row) → matches.
        { criterion: '产物回应目标且无遗漏', met: true, evidence: 'a' },
        { criterion: '有可复查证据', met: true, evidence: 'b' },
      ],
      gaps: [],
    };
    const artifacts = extractHarnessArtifacts({ n_gate: JSON.stringify(verdict) });
    expect(verdictEffectivePass(artifacts.verdict, criteria)).toBe(true);
  });

  it('fails when a covered authoritative criterion is met=false', () => {
    const criteria = ['产物回应目标', '有可复查证据'];
    const verdict = {
      pass: true,
      acceptedArtifact: '',
      evidence: [],
      criteriaCoverage: [
        { criterion: '产物回应目标', met: true, evidence: 'a' },
        { criterion: '有可复查证据', met: false, evidence: '' },
      ],
      gaps: [],
    };
    const artifacts = extractHarnessArtifacts({ n_gate: JSON.stringify(verdict) });
    expect(verdictEffectivePass(artifacts.verdict, criteria)).toBe(false);
  });

  it('treats a malformed acceptance-gate output as not passed (gate safety contract)', () => {
    // Gate emitted prose instead of a DYNAMIC_VERDICT ⇒ parseVerdict returns null
    // ⇒ verdictEffectivePass(null) is false. The gate is never auto-passed on
    // unparseable output, even though worker-node schema enforcement is lenient.
    const artifacts = extractHarnessArtifacts({ n_gate: '抱歉，我无法给出结构化结论。' });
    expect(artifacts.verdict).toBeNull();
    expect(verdictEffectivePass(artifacts.verdict)).toBe(false);
    expect(verdictEffectivePass(artifacts.verdict, ['任意标准'])).toBe(false);
  });

  it('lets strategies drive a synthesize mid-stage between workers and gate', () => {
    const spec = parseDynamicHarnessSpec(
      JSON.stringify({
        objective: '核查并综合多来源结论',
        nonGoals: [],
        successCriteria: ['有证据'],
        budget: { maxAgentCalls: 12, maxRounds: 1 },
        strategies: ['fan-out-and-synthesize', 'adversarial-verification'],
        workerGroups: [
          { id: 't1', title: 'A', focus: 'a', deliverable: 'da', acceptance: 'aa', evidenceRequired: 'ea' },
          { id: 't2', title: 'B', focus: 'b', deliverable: 'db', acceptance: 'ab', evidenceRequired: 'eb' },
        ],
        acceptanceRubric: ['证据充分'],
        stopCondition: '验收通过',
      }),
      'fallback',
    );
    const graph = buildDynamicHarnessGraph(spec);
    const synth = graph.nodes.find((n) => n.id === 'n_synth');
    expect(synth?.type).toBe('agent');
    expect(graph.edges.some((e) => e.from.node === WORKERS_NODE_ID && e.to.node === 'n_synth' && e.kind === 'exec')).toBe(true);
    expect(graph.edges.some((e) => e.from.node === 'n_synth' && e.to.node === GATE_NODE_ID && e.kind === 'exec')).toBe(true);
  });

  it('lets generate-and-filter insert a tournament filter mid-stage', () => {
    const spec = parseDynamicHarnessSpec(
      JSON.stringify({
        objective: '为产品起名',
        nonGoals: [],
        successCriteria: ['有候选'],
        budget: { maxAgentCalls: 12, maxRounds: 1 },
        strategies: ['generate-and-filter', 'tournament'],
        workerGroups: [
          { id: 't1', title: 'A', focus: 'a', deliverable: 'da', acceptance: 'aa', evidenceRequired: 'ea' },
          { id: 't2', title: 'B', focus: 'b', deliverable: 'db', acceptance: 'ab', evidenceRequired: 'eb' },
        ],
        acceptanceRubric: ['择优'],
        stopCondition: '验收通过',
      }),
      'fallback',
    );
    const graph = buildDynamicHarnessGraph(spec);
    const synth = graph.nodes.find((n) => n.id === 'n_synth');
    expect(synth?.type).toBe('consensus');
    expect(synth?.params.strategy).toBe('tournament');
  });

  it('drives fan-out-and-synthesize on the PLAN path (production default path)', () => {
    const spec = parseDynamicHarnessSpec(
      JSON.stringify({
        objective: '多来源调研并综合',
        nonGoals: [],
        successCriteria: ['有证据'],
        budget: { maxAgentCalls: 20, maxRounds: 1 },
        strategies: ['fan-out-and-synthesize', 'adversarial-verification'],
        plan: [
          {
            id: 'research',
            kind: 'parallel',
            title: '并行调研',
            branches: [
              { title: '来源 A', focus: 'a', deliverable: 'da', acceptance: 'aa', evidenceRequired: 'ea' },
              { title: '来源 B', focus: 'b', deliverable: 'db', acceptance: 'ab', evidenceRequired: 'eb' },
            ],
          },
        ],
        workerGroups: [],
        acceptanceRubric: ['证据充分'],
        stopCondition: '验收通过',
      }),
      'fallback',
    );
    const graph = buildDynamicHarnessGraph(spec);
    const synth = graph.nodes.find((n) => n.id === 'n_plan_synth');
    const research = graph.nodes.find((n) => n.id.includes('research'));
    expect(synth?.type).toBe('agent'); // synthesize
    expect(graph.edges.some((e) => e.from.node === research?.id && e.to.node === 'n_plan_synth' && e.kind === 'exec')).toBe(true);
    expect(graph.edges.some((e) => e.from.node === 'n_plan_synth' && e.to.node === GATE_NODE_ID && e.kind === 'exec')).toBe(true);
    expect(graph.edges.some((e) => e.from.node === 'n_plan_synth' && e.to.node === GATE_NODE_ID && e.kind === 'data')).toBe(true);
  });

  it('drives generate-and-filter into a tournament filter on the PLAN path', () => {
    const spec = parseDynamicHarnessSpec(
      JSON.stringify({
        objective: '为产品起名并择优',
        nonGoals: [],
        successCriteria: ['有候选'],
        budget: { maxAgentCalls: 20, maxRounds: 1 },
        strategies: ['generate-and-filter', 'tournament'],
        plan: [
          { id: 'gen_a', kind: 'agent', title: '候选 A', dependsOn: [], focus: 'a', deliverable: 'd', acceptance: 'x', evidenceRequired: 'e' },
          { id: 'gen_b', kind: 'agent', title: '候选 B', dependsOn: [], focus: 'b', deliverable: 'd', acceptance: 'x', evidenceRequired: 'e' },
        ],
        workerGroups: [],
        acceptanceRubric: ['择优'],
        stopCondition: '验收通过',
      }),
      'fallback',
    );
    const graph = buildDynamicHarnessGraph(spec);
    const filter = graph.nodes.find((n) => n.id === 'n_plan_synth');
    expect(filter?.type).toBe('consensus');
    expect(filter?.params.strategy).toBe('tournament');
    const genA = graph.nodes.find((n) => n.id.includes('gen_a'));
    const genB = graph.nodes.find((n) => n.id.includes('gen_b'));
    expect(graph.edges.some((e) => e.from.node === genA?.id && e.to.node === 'n_plan_synth' && e.kind === 'data')).toBe(true);
    expect(graph.edges.some((e) => e.from.node === genB?.id && e.to.node === 'n_plan_synth' && e.kind === 'data')).toBe(true);
  });

  it('skips the plan mid-stage when there is a single linear chain (nothing to merge)', () => {
    const spec = parseDynamicHarnessSpec(
      JSON.stringify({
        objective: '线性实现',
        nonGoals: [],
        successCriteria: ['完成'],
        budget: { maxAgentCalls: 20, maxRounds: 1 },
        strategies: ['fan-out-and-synthesize'],
        plan: [
          { id: 'a', kind: 'agent', title: '步骤 A', focus: 'a', deliverable: 'd', acceptance: 'x', evidenceRequired: 'e' },
          { id: 'b', kind: 'agent', title: '步骤 B', dependsOn: ['a'], focus: 'b', deliverable: 'd', acceptance: 'x', evidenceRequired: 'e' },
        ],
        workerGroups: [],
        acceptanceRubric: ['完成'],
        stopCondition: '验收通过',
      }),
      'fallback',
    );
    const graph = buildDynamicHarnessGraph(spec);
    expect(graph.nodes.some((n) => n.id === 'n_plan_synth')).toBe(false);
    const b = graph.nodes.find((n) => n.id.includes('_b'));
    expect(graph.edges.some((e) => e.from.node === b?.id && e.to.node === GATE_NODE_ID && e.kind === 'exec')).toBe(true);
  });

  it('counts the plan mid-stage in the budget estimate', () => {
    // Two independent generators (explicit empty dependsOn ⇒ both terminal) plus
    // a generate-and-filter strategy ⇒ the plan-path filter mid-stage applies.
    const withFilter = parseDynamicHarnessSpec(
      JSON.stringify({
        objective: '为产品起名',
        successCriteria: ['有候选'],
        budget: { maxAgentCalls: 20, maxRounds: 1 },
        strategies: ['generate-and-filter'],
        plan: [
          { id: 'g1', kind: 'agent', title: 'A', dependsOn: [] },
          { id: 'g2', kind: 'agent', title: 'B', dependsOn: [] },
        ],
        workerGroups: [],
        acceptanceRubric: ['择优'],
        acceptance: { voters: 2, strategy: 'adversarial' },
        stopCondition: 's',
      }),
      'fallback',
    );
    // work = 2 agents + filter(consensus 2 voters + synthesis = 3) = 5; gate = 3.
    // setup 2 + 1*(5+3) + report 1 = 11.
    expect(estimateHarnessCalls(withFilter, 1)).toBe(11);
    // Without a fan-out strategy the mid-stage is gone: work = 2; 2+1*(2+3)+1 = 8.
    expect(estimateHarnessCalls({ ...withFilter, strategies: [] }, 1)).toBe(8);
  });

  it('honours acceptance config: more voters + escalated repair model', () => {
    const spec = parseDynamicHarnessSpec(
      JSON.stringify({
        objective: '高风险安全核查',
        nonGoals: [],
        successCriteria: ['安全'],
        budget: { maxAgentCalls: 20, maxRounds: 3 },
        strategies: ['loop-until-done', 'adversarial-verification'],
        workerGroups: [
          { id: 't1', title: '核查', focus: 'a', deliverable: 'd', acceptance: 'x', evidenceRequired: 'e' },
        ],
        acceptanceRubric: ['证据充分'],
        acceptance: { voters: 4, strategy: 'multi-lens' },
        stopCondition: '验收通过',
      }),
      'fallback',
    );
    expect(spec.acceptance).toEqual({ voters: 4, strategy: 'multi-lens' });
    const graph = buildDynamicHarnessGraph(spec);
    const gate = graph.nodes.find((n) => n.id === GATE_NODE_ID);
    expect(gate?.params.strategy).toBe('multi-lens');
    expect((gate?.params.voters as unknown[]).length).toBe(4);
    // Round 3 repair workers escalate to opus.
    const r3 = graph.nodes.find((n) => n.id === 'n_workers_r3');
    const branches = r3?.params.branches as Array<{ model?: string }>;
    expect(branches.every((b) => b.model === 'opus')).toBe(true);
  });

  it('builds a planner graph with an escalated plan-critic stage', () => {
    const graph = buildDynamicPlannerGraph('实现并验证一个功能');
    const planner = graph.nodes.find((n) => n.id === PLANNER_NODE_ID);
    const critic = graph.nodes.find((n) => n.id === PLAN_CRITIC_NODE_ID);
    expect(planner?.type).toBe('agent');
    expect(critic?.type).toBe('agent');
    // Critic is escalated above the planner's default sonnet.
    expect(critic?.params.model).toBe('opus');
    expect(graph.meta.schemaDefs?.DYNAMIC_PLAN_CRITIQUE).toBeTruthy();
    // planner -> critic exec + data, critic -> end exec.
    expect(graph.edges.some((e) => e.from.node === PLANNER_NODE_ID && e.to.node === PLAN_CRITIC_NODE_ID && e.kind === 'exec')).toBe(true);
    expect(graph.edges.some((e) => e.from.node === PLANNER_NODE_ID && e.to.node === PLAN_CRITIC_NODE_ID && e.kind === 'data')).toBe(true);
    expect(graph.edges.some((e) => e.from.node === PLAN_CRITIC_NODE_ID && e.to.node === 'n_end' && e.kind === 'exec')).toBe(true);
  });

  it("prefers the critic's revisedSpec over the planner spec", () => {
    const plannerText = JSON.stringify({
      objective: '原始目标',
      successCriteria: ['质量好'],
      workerGroups: [{ id: 't1', title: 'A', focus: 'a', deliverable: 'd', acceptance: 'x', evidenceRequired: 'e' }],
      stopCondition: 's',
    });
    const critiqueText = JSON.stringify({
      ok: false,
      issues: [{ field: 'successCriteria', severity: 'P1', problem: '不可机检', fix: '改写成可观测判定' }],
      revisedSpec: {
        objective: '修正后的目标',
        successCriteria: ['app/x.ts 存在且包含 export function foo'],
        workerGroups: [{ id: 't1', title: 'A', focus: 'a', deliverable: 'd', acceptance: 'x', evidenceRequired: 'e' }],
        stopCondition: 's',
      },
    });
    const resolved = resolvePlannedSpec(plannerText, critiqueText, 'fallback');
    expect(resolved.critiqueApplied).toBe(true);
    expect(resolved.usedFallback).toBe(false);
    expect(resolved.spec.objective).toBe('修正后的目标');
    expect(resolved.spec.successCriteria).toEqual(['app/x.ts 存在且包含 export function foo']);
    expect(resolved.critique?.issues).toHaveLength(1);
  });

  it('falls back to the planner spec when the critic gives no usable revision', () => {
    const plannerText = JSON.stringify({
      objective: '保留这个目标',
      successCriteria: ['标准A'],
      workerGroups: [{ id: 't1', title: 'A', focus: 'a', deliverable: 'd', acceptance: 'x', evidenceRequired: 'e' }],
      stopCondition: 's',
    });
    // Critic returned prose, not a DYNAMIC_PLAN_CRITIQUE object.
    const resolved = resolvePlannedSpec(plannerText, '抱歉，我无法给出结构化复审。', 'fallback');
    expect(resolved.critiqueApplied).toBe(false);
    expect(resolved.usedFallback).toBe(false);
    expect(resolved.spec.objective).toBe('保留这个目标');
  });

  it('normalizes objectiveChecks and drops unrunnable entries', () => {
    const spec = parseDynamicHarnessSpec(
      JSON.stringify({
        objective: '实现功能',
        successCriteria: ['文件存在'],
        budget: { maxAgentCalls: 12, maxRounds: 1 },
        strategies: ['fan-out-and-synthesize'],
        workerGroups: [{ id: 't1', title: 'A', focus: 'a', deliverable: 'd', acceptance: 'x', evidenceRequired: 'e' }],
        acceptanceRubric: ['证据充分'],
        objectiveChecks: [
          { kind: 'file-exists', path: 'app/src/core/ir.ts', description: '核心文件' },
          { kind: 'file-contains', path: 'app/src/core/ir.ts', contains: 'IRGraph' },
          { kind: 'command', command: 'npm run typecheck' },
          { kind: 'file-exists' }, // no path → dropped
          { kind: 'file-contains', path: 'x.ts' }, // no contains → dropped
          { kind: 'nonsense', path: 'y' }, // bad kind → dropped
        ],
        stopCondition: 's',
      }),
      'fallback',
    );
    expect(spec.objectiveChecks).toHaveLength(3);
    expect(spec.objectiveChecks?.map((c) => c.kind)).toEqual(['file-exists', 'file-contains', 'command']);
  });

  it('builds a task-shaped fallback for debug requests', () => {
    const spec = fallbackHarnessSpec('修复 flaky test 偶发失败');
    expect(spec.budget.maxRounds).toBe(3);
    expect(spec.workerGroups.map((g) => g.title)).toContain('复现');
    expect(spec.strategies).toContain('loop-until-done');
  });
});

describe('budget ↔ rounds reconciliation', () => {
  // The shape of the run that failed: plan = parallel(4) → agent → consensus(1
  // voter) → pipeline(2 stages); acceptance gate voters=3; budget 14 calls /
  // 2 rounds. Per round work = 4 + 1 + (1+1) + 2 = 9; gate = 3+1 = 4. Setup 2,
  // report 1. Two rounds need 2 + 2*(9+4) + 1 = 29 calls — far over 14.
  const failedRunSpec = (): ReturnType<typeof fallbackHarnessSpec> => ({
    ...fallbackHarnessSpec('调研 dynamic workflows 并给出优化建议'),
    plan: [
      { id: 'step1', kind: 'parallel', title: '并行调研', branches: [{}, {}, {}, {}] },
      { id: 'step2', kind: 'agent', title: '归类综合' },
      { id: 'step3', kind: 'consensus', title: '对抗核验', voters: [{}] },
      { id: 'step4', kind: 'pipeline', title: '生成报告', stages: [{}, {}] },
    ],
    acceptance: { voters: 3, strategy: 'adversarial' },
    budget: { maxAgentCalls: 14, maxRounds: 2 },
  });

  it('estimates worst-case calls matching the harness node expansion', () => {
    const spec = failedRunSpec();
    expect(estimateHarnessCalls(spec, 1)).toBe(2 + (9 + 4) + 1); // 16
    expect(estimateHarnessCalls(spec, 2)).toBe(2 + 2 * (9 + 4) + 1); // 29
  });

  it('raises maxAgentCalls to fund the declared rounds when under the ceiling', () => {
    const spec = {
      ...failedRunSpec(),
      plan: [{ id: 's1', kind: 'agent' as const, title: '执行' }],
      acceptance: { voters: 2, strategy: 'adversarial' as const },
      budget: { maxAgentCalls: 4, maxRounds: 2 },
    };
    // per round: 1 work + (2+1) gate = 4; two rounds = 2 + 2*4 + 1 = 11.
    const { spec: out, note } = reconcileBudget(spec);
    expect(out.budget.maxRounds).toBe(2);
    expect(out.budget.maxAgentCalls).toBe(11);
    expect(note).toMatch(/上调/);
  });

  it('would have caught the real failed run (budget 14, rounds 2)', () => {
    const { spec: out, note } = reconcileBudget(failedRunSpec());
    expect(note).not.toBeNull();
    // 29 <= HARD_MAX (32), so it funds both rounds by raising the ceiling.
    expect(out.budget.maxRounds).toBe(2);
    expect(out.budget.maxAgentCalls).toBe(29);
    expect(out.budget.maxAgentCalls).toBeGreaterThan(14);
  });

  it('drops rounds when even the hard ceiling cannot fund them', () => {
    const spec = {
      ...failedRunSpec(),
      plan: [
        { id: 'step1', kind: 'parallel' as const, title: 'p', branches: [{}, {}, {}, {}, {}] },
        { id: 'step2', kind: 'pipeline' as const, title: 'pl', stages: [{}, {}, {}] },
      ],
      acceptance: { voters: 5, strategy: 'adversarial' as const },
      budget: { maxAgentCalls: 14, maxRounds: 4 },
    };
    // per round: (5+3) work + (5+1) gate = 14; 4 rounds = 2 + 4*14 + 1 = 59 > 32.
    const { spec: out, note } = reconcileBudget(spec);
    expect(out.budget.maxRounds).toBeLessThan(4);
    expect(out.budget.maxAgentCalls).toBeLessThanOrEqual(HARD_MAX_AGENT_CALLS);
    expect(note).toMatch(/降为/);
  });

  it('honors an explicit user ceiling by lowering rounds instead of raising calls', () => {
    // User pinned --max-agent-calls 16. Funding 2 rounds needs 29; cannot exceed
    // 16, so rounds drop to what fits (1 round needs 16).
    const { spec: out } = reconcileBudget(failedRunSpec(), 16);
    expect(out.budget.maxAgentCalls).toBeLessThanOrEqual(16);
    expect(out.budget.maxRounds).toBe(1);
  });

  it('leaves an already-consistent budget untouched', () => {
    const spec = {
      ...failedRunSpec(),
      budget: { maxAgentCalls: 30, maxRounds: 2 },
    };
    const { spec: out, note } = reconcileBudget(spec);
    expect(note).toBeNull();
    expect(out).toBe(spec);
  });
});
