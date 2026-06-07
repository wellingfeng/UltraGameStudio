/**
 * Unit tests for the pure run-summary derivation (phase 1 + 2 observability).
 * Focus: the gate-vs-truth four-quadrant classification, rework-round counting,
 * and that observability flags pass through. No filesystem / runtime.
 */
import { describe, expect, it } from 'vitest';
import type { DynamicVerdict } from '../../src/runtime/dynamicHarness';
import type { NodeRunResult } from '../../src/runtime';
import { buildRunSummary, classifyGate, nodeRole } from './ultracodeSummary';
import type { UltracodeJsonResult } from './ultracode';

function verdict(pass: boolean): DynamicVerdict {
  return {
    pass,
    acceptedArtifact: pass ? 'done' : '',
    evidence: [],
    criteriaCoverage: [],
    gaps: [],
  };
}

function baseResult(over: Partial<UltracodeJsonResult> = {}): UltracodeJsonResult {
  return {
    success: true,
    runId: 'uc-test',
    runDir: '/tmp/uc-test',
    spec: {
      objective: '测试目标',
      nonGoals: [],
      successCriteria: [],
      budget: { maxAgentCalls: 12, maxRounds: 2 },
      strategies: [],
      workerGroups: [],
      acceptanceRubric: [],
      stopCondition: '',
    },
    artifacts: { ledger: null, verdict: null, report: '' },
    durationMs: 1000,
    failedNodeId: null,
    error: null,
    outputs: {},
    nodeResults: {},
    ...over,
  };
}

describe('classifyGate — gate × ground-truth quadrants', () => {
  it('confirmed: gate pass + truth pass', () => {
    const g = classifyGate(
      baseResult({
        artifacts: { ledger: null, verdict: verdict(true), report: '' },
        verification: { command: 't', exitCode: 0, stdout: '', stderr: '', durationMs: 5, passed: true },
      }),
    );
    expect(g).toMatchObject({ modelVerdictPass: true, groundTruthPass: true, classification: 'confirmed' });
  });

  it('false-accept: gate pass BUT truth fail (the dangerous miss)', () => {
    const g = classifyGate(
      baseResult({
        artifacts: { ledger: null, verdict: verdict(true), report: '' },
        verification: { command: 't', exitCode: 1, stdout: '', stderr: '', durationMs: 5, passed: false },
      }),
    );
    expect(g.classification).toBe('false-accept');
  });

  it('over-reject: gate fail BUT truth pass', () => {
    const g = classifyGate(
      baseResult({
        artifacts: { ledger: null, verdict: verdict(false), report: '' },
        verification: { command: 't', exitCode: 0, stdout: '', stderr: '', durationMs: 5, passed: true },
      }),
    );
    expect(g.classification).toBe('over-reject');
  });

  it('confirmed-fail: gate fail + truth fail', () => {
    const g = classifyGate(
      baseResult({
        artifacts: { ledger: null, verdict: verdict(false), report: '' },
        verification: { command: 't', exitCode: 1, stdout: '', stderr: '', durationMs: 5, passed: false },
      }),
    );
    expect(g.classification).toBe('confirmed-fail');
  });

  it('unverified: no verify-command (ground truth null)', () => {
    const g = classifyGate(
      baseResult({ artifacts: { ledger: null, verdict: verdict(true), report: '' } }),
    );
    expect(g).toMatchObject({ groundTruthPass: null, classification: 'unverified' });
  });

  it('unverified: no gate verdict at all', () => {
    const g = classifyGate(
      baseResult({
        verification: { command: 't', exitCode: 0, stdout: '', stderr: '', durationMs: 5, passed: true },
      }),
    );
    expect(g).toMatchObject({ modelVerdictPass: null, classification: 'unverified' });
  });
});

describe('buildRunSummary', () => {
  it('counts rework rounds and rework nodes from _r<N> ids', () => {
    const nodeResults: Record<string, NodeRunResult> = {
      n_workers: { status: 'success', durationMs: 100, retryCount: 0 },
      n_gate_r1: { status: 'success', durationMs: 50, retryCount: 1 },
      n_workers_r2: { status: 'success', durationMs: 120, retryCount: 0 },
      n_gate: { status: 'success', durationMs: 60, retryCount: 0 },
    };
    const s = buildRunSummary(baseResult({ nodeResults }));
    expect(s.rework.rounds).toBe(2);
    // Only the _r2 node is a rework node (_r1 is the first-round gate alias).
    expect(s.rework.reworkNodeCount).toBe(1);
    expect(s.nodes).toHaveLength(4);
  });

  it('passes through planner-fallback and closing-pass flags', () => {
    const s = buildRunSummary(
      baseResult({ observability: { plannerFallback: true, closingPass: true } }),
    );
    expect(s.planner.usedFallback).toBe(true);
    expect(s.closingPass).toBe(true);
  });

  it('ground truth is authoritative over the model verdict for outcome', () => {
    // success=true but verify-command failed ⇒ outcome must be fail.
    const s = buildRunSummary(
      baseResult({
        success: true,
        artifacts: { ledger: null, verdict: verdict(true), report: '' },
        verification: { command: 't', exitCode: 1, stdout: '', stderr: '', durationMs: 5, passed: false },
      }),
    );
    expect(s.outcome).toBe('fail');
    expect(s.gate.classification).toBe('false-accept');
  });

  it('does not turn a failed run into pass when objective truth passed', () => {
    const s = buildRunSummary(
      baseResult({
        success: false,
        artifacts: { ledger: null, verdict: verdict(false), report: '' },
        verdictSignals: { modelVerdictPass: false, groundTruthPass: true },
      }),
    );
    expect(s.outcome).toBe('fail');
    expect(s.gate.classification).toBe('over-reject');
  });

  it('reports budget-exhausted outcome', () => {
    const s = buildRunSummary(
      baseResult({
        success: false,
        budget: { maxAgentCalls: 4, spentAgentCalls: 4, exhausted: true },
      }),
    );
    expect(s.outcome).toBe('budget-exhausted');
    expect(s.agentCalls.exhausted).toBe(true);
  });
});

describe('nodeRole', () => {
  it('maps known harness node ids to roles', () => {
    expect(nodeRole('n_ledger')).toBe('任务账本');
    expect(nodeRole('n_workers_r2')).toBe('Worker 执行');
    expect(nodeRole('n_gate')).toBe('验收门');
    expect(nodeRole('n_dyn_1_scan')).toBe('动态步骤');
    expect(nodeRole('n_dyn_r2_1_scan')).toBe('动态步骤');
  });
});
