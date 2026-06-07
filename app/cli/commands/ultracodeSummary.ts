/**
 * Pure run-summary derivation for `/ultracode` observability (phase 1 + 2).
 *
 * Phase 1 (single-run debuggability): collapse a finished run's per-node results
 * into a compact, role-labeled summary (status, duration, retries, rework rounds).
 * Phase 2 (gate-vs-truth calibration): cross the model's self-reported acceptance
 * verdict against the objective ground truth (the --verify-command result) into a
 * four-quadrant classification, so "did the gate actually tell the truth?" becomes
 * a data point rather than a guess.
 *
 * This module is PURE: it derives everything from an UltracodeJsonResult, touches
 * no filesystem / runtime, and is unit-tested directly.
 */
import type { NodeRunResult } from '../../src/runtime';
import { verdictEffectivePass } from '../../src/runtime/dynamicHarness';
import type { UltracodeJsonResult } from './ultracode';

export type GateClassification =
  | 'confirmed' // gate passed AND ground truth passed (ideal)
  | 'false-accept' // gate passed BUT ground truth failed (⚠ the dangerous miss)
  | 'over-reject' // gate rejected BUT ground truth passed (too strict)
  | 'confirmed-fail' // gate rejected AND ground truth failed (correct rejection)
  | 'unverified'; // no gate, or no ground truth to calibrate against

export interface GateTruthQuadrant {
  /** verdictEffectivePass(verdict, successCriteria); null when no gate verdict. */
  modelVerdictPass: boolean | null;
  /** verification.passed; null when no --verify-command was supplied. */
  groundTruthPass: boolean | null;
  classification: GateClassification;
}

export interface RunSummaryNode {
  id: string;
  role: string;
  status: string;
  durationMs: number;
  retryCount: number;
}

export interface RunSummary {
  runId: string;
  objective: string;
  outcome: 'pass' | 'fail' | 'budget-exhausted' | 'error';
  durationMs: number;
  agentCalls: { spent: number; max: number; exhausted: boolean };
  planner: { usedFallback: boolean };
  closingPass: boolean;
  nodes: RunSummaryNode[];
  rework: { rounds: number; reworkNodeCount: number };
  gate: GateTruthQuadrant;
}

const OBJECTIVE_MAX = 80;

/** Derive the full run summary from a finished run's result JSON. */
export function buildRunSummary(json: UltracodeJsonResult): RunSummary {
  const gate = classifyGate(json);
  return {
    runId: json.runId,
    objective: clip(json.spec?.objective ?? '', OBJECTIVE_MAX),
    outcome: deriveOutcome(json, gate),
    durationMs: json.durationMs,
    agentCalls: {
      spent: json.budget?.spentAgentCalls ?? 0,
      max: json.budget?.maxAgentCalls ?? 0,
      exhausted: json.budget?.exhausted ?? false,
    },
    planner: { usedFallback: json.observability?.plannerFallback ?? false },
    closingPass: json.observability?.closingPass ?? false,
    nodes: summarizeNodes(json.nodeResults ?? {}),
    rework: summarizeRework(json.nodeResults ?? {}),
    gate,
  };
}

/** Phase 2: cross model self-verdict against objective ground truth. */
export function classifyGate(json: UltracodeJsonResult): GateTruthQuadrant {
  // Prefer the explicitly-captured pre-verification self-verdict. The persisted
  // artifacts.verdict is MUTATED by verify-command folding (pass becomes
  // `pass && verification.passed`), so recomputing from it would erase the
  // false-accept signal. Fall back to recompute only for legacy runs that
  // predate verdictSignals.
  const modelVerdictPass =
    json.verdictSignals?.modelVerdictPass !== undefined
      ? json.verdictSignals.modelVerdictPass
      : json.artifacts?.verdict
        ? verdictEffectivePass(json.artifacts.verdict, json.spec?.successCriteria)
        : null;
  const groundTruthPass =
    json.verdictSignals?.groundTruthPass !== undefined
      ? json.verdictSignals.groundTruthPass
      : json.verification == null
        ? null
        : json.verification.passed === true;

  let classification: GateClassification;
  if (modelVerdictPass === null || groundTruthPass === null) {
    classification = 'unverified';
  } else if (modelVerdictPass && groundTruthPass) {
    classification = 'confirmed';
  } else if (modelVerdictPass && !groundTruthPass) {
    classification = 'false-accept';
  } else if (!modelVerdictPass && groundTruthPass) {
    classification = 'over-reject';
  } else {
    classification = 'confirmed-fail';
  }
  return { modelVerdictPass, groundTruthPass, classification };
}

function deriveOutcome(
  json: UltracodeJsonResult,
  gate: GateTruthQuadrant,
): RunSummary['outcome'] {
  if (json.error) return 'error';
  if (json.budget?.exhausted) return 'budget-exhausted';
  // result.success is the single final status. Objective truth can force a fail,
  // but a structural/objective pass must not override a model acceptance reject.
  if (gate.groundTruthPass === false) return 'fail';
  return json.success ? 'pass' : 'fail';
}

/** Map a harness node id to a human-readable role for the summary table. */
export function nodeRole(id: string): string {
  if (id === 'n_start' || id === 'n_end') return '哨兵';
  if (id === 'n_scope') return '目标冻结';
  if (id === 'n_ledger') return '任务账本';
  if (id === 'n_plan') return '规划';
  if (id === 'n_plan_critic') return '规格复审';
  if (/^n_workers(_r\d+)?$/.test(id)) return 'Worker 执行';
  if (/^n_synth(_r\d+)?$/.test(id)) return '中间归并';
  if (/^n_gate(_r\d+)?$/.test(id)) return '验收门';
  if (id === 'n_report') return '验收报告';
  if (/^n_dyn(_r\d+)?_/.test(id)) return '动态步骤';
  return id;
}

/** True for repair-round node ids (carry an `_r<N>` round suffix, N>=2). */
function isReworkNodeId(id: string): boolean {
  return /_r[2-9]\d*(_|$)/.test(id);
}

/** Highest repair round referenced by any node id (1 when none). */
function maxRoundFromIds(ids: string[]): number {
  let max = 1;
  for (const id of ids) {
    const m = id.match(/_r(\d+)/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

function summarizeNodes(nodeResults: Record<string, NodeRunResult>): RunSummaryNode[] {
  return Object.entries(nodeResults)
    .filter(([id]) => id !== 'n_start' && id !== 'n_end')
    .map(([id, r]) => ({
      id,
      role: nodeRole(id),
      status: r.status,
      durationMs: r.durationMs ?? 0,
      retryCount: r.retryCount ?? 0,
    }));
}

function summarizeRework(nodeResults: Record<string, NodeRunResult>): {
  rounds: number;
  reworkNodeCount: number;
} {
  const ids = Object.keys(nodeResults);
  return {
    rounds: maxRoundFromIds(ids),
    reworkNodeCount: ids.filter(isReworkNodeId).length,
  };
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
