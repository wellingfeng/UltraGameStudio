import { describe, expect, it } from 'vitest';

import { captainBlueprint } from './defaultBlueprint';
import { emitClaudeScript } from './emitter';
import { roundtrip } from './roundtrip';
import { DATA } from './ir';
import type { IRRunSnapshot, TaskLedger } from './ir';

/**
 * Captain-loop blueprint — the manager-led pattern (目标冻结 → 队长拆单 →
 * 并行 worker → adversarial 验收门 → 汇总). These tests pin its topology, its
 * embedded schemas, and — most importantly — that it survives emit→parse→emit
 * (round-trip), since a template that can't round-trip would corrupt the canvas
 * on reopen.
 */
describe('captainBlueprint', () => {
  it('survives emit→parse→emit (round-trip)', () => {
    const report = roundtrip(captainBlueprint());
    expect(report.diffs).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.idempotent).toBe(true);
  });

  it('has the 7-node captain topology', () => {
    const ir = captainBlueprint();
    expect(ir.nodes).toHaveLength(7);

    const byType = (t: string) => ir.nodes.filter((n) => n.type === t);
    expect(byType('start')).toHaveLength(1);
    expect(byType('end')).toHaveLength(1);
    expect(byType('parallel')).toHaveLength(1);
    expect(byType('consensus')).toHaveLength(1);
    // goal-freeze, captain, summary
    expect(byType('agent')).toHaveLength(3);
  });

  it('captain node declares the TASK_LEDGER schema', () => {
    const ir = captainBlueprint();
    const captain = ir.nodes.find((n) => n.id === 'n_captain');
    expect(captain?.params.schema).toBe('TASK_LEDGER');
    expect(captain?.params.agentType).toBe('workflow-manager');
  });

  it('acceptance gate is an adversarial consensus on VERDICT', () => {
    const ir = captainBlueprint();
    const gate = ir.nodes.find((n) => n.id === 'n_gate');
    expect(gate?.type).toBe('consensus');
    expect(gate?.params.strategy).toBe('adversarial');
    expect(gate?.params.schema).toBe('VERDICT');
    expect((gate?.params.voters as unknown[]).length).toBe(2);
  });

  it('embeds TASK_LEDGER and VERDICT schema definitions', () => {
    const ir = captainBlueprint();
    expect(ir.meta.schemaDefs).toBeDefined();
    expect(ir.meta.schemaDefs).toHaveProperty('TASK_LEDGER');
    expect(ir.meta.schemaDefs).toHaveProperty('VERDICT');
  });

  it('wires the key data edges (ledger→workers, workers→gate, gate→summary)', () => {
    const ir = captainBlueprint();
    const dataEdge = (from: string, to: string) =>
      ir.edges.some(
        (e) => e.kind === DATA && e.from.node === from && e.to.node === to,
      );
    expect(dataEdge('n_captain', 'n_workers')).toBe(true);
    expect(dataEdge('n_workers', 'n_gate')).toBe(true);
    expect(dataEdge('n_gate', 'n_summary')).toBe(true);
  });

  it('emits a runnable script with schemas and an adversarial consensus', () => {
    const script = emitClaudeScript(captainBlueprint());
    expect(script).toContain('// @schema TASK_LEDGER');
    expect(script).toContain('// @schema VERDICT');
    expect(script).toContain('consensus(');
    expect(script).toContain("strategy: 'adversarial'");
  });
});

/**
 * Compile-time smoke test for the new TaskLedger types: a literal must assign to
 * IRRunSnapshot['taskLedger']. This fails at `tsc` / vitest transform time if the
 * type drifts, with no runtime assertion needed.
 */
describe('TaskLedger type', () => {
  it('accepts a well-formed ledger literal', () => {
    const ledger: TaskLedger = {
      round: 1,
      anchor: 'accepted artifact v1',
      tasks: [
        {
          id: 't1',
          title: '实现登录校验',
          owner: 'Worker A',
          acceptance: '通过单元测试',
          evidence: 'npm test 输出',
          status: 'accepted',
          artifact: 'src/auth.ts',
          gaps: [],
        },
      ],
    };
    const snap: IRRunSnapshot = { status: 'success', taskLedger: ledger };
    expect(snap.taskLedger?.tasks).toHaveLength(1);
    expect(snap.taskLedger?.tasks[0].status).toBe('accepted');
  });
});
