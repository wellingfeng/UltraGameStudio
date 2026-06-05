import { describe, expect, it } from 'vitest';
import {
  GATE_NODE_ID,
  LEDGER_NODE_ID,
  WORKERS_NODE_ID,
  buildDynamicHarnessGraph,
  extractHarnessArtifacts,
  parseDynamicHarnessSpec,
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
});
