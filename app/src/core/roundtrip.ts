import type { IRGraph } from './ir';
import { sampleWorkflow } from './sample';
import { roundtripFixtures } from './fixtures';
import { isEmptyWorkflow } from './isEmptyWorkflow';
import { defaultBlueprint } from './defaultBlueprint';
import { emitClaudeScript } from './emitter';
import { parseClaudeScript } from './parser';

/**
 * Round-trip harness: IRGraph → emit (script) → parse (IRGraph).
 *
 * Demonstrates that the emitter and parser are inverses for the topology that
 * matters: node ids/types, the `parent` nesting, and the exec/data edge
 * structure survive a full emit→parse cycle thanks to the `// @node <id>`
 * annotations the emitter embeds.
 *
 * Callable from the browser console (in dev): `OpenWorkflow.roundtrip()` /
 * `OpenWorkflow.roundtripAll()`.
 */

export interface RoundtripReport {
  ok: boolean;
  script: string;
  reparsed: IRGraph;
  diffs: string[];
  /** True when emit→parse→emit produced a byte-identical script (idempotent). */
  idempotent: boolean;
  counts: {
    sourceNodes: number;
    reparsedNodes: number;
    sourceEdges: number;
    reparsedEdges: number;
  };
}

/** Runs a single IR → script → IR round-trip and reports structural fidelity. */
export function roundtrip(ir: IRGraph = sampleWorkflow): RoundtripReport {
  const script = emitClaudeScript(ir);
  const reparsed = parseClaudeScript(script);
  const diffs = compareGraphs(ir, reparsed);
  const reEmitted = emitClaudeScript(reparsed);

  return {
    ok: diffs.length === 0,
    script,
    reparsed,
    diffs,
    idempotent: reEmitted === script,
    counts: {
      sourceNodes: ir.nodes.length,
      reparsedNodes: reparsed.nodes.length,
      sourceEdges: ir.edges.length,
      reparsedEdges: reparsed.edges.length,
    },
  };
}

/**
 * Compares two graphs structurally, returning a list of human-readable diffs.
 * Empty list ⇒ structurally equivalent (ids, types, `parent`, exec/data adjacency).
 */
function compareGraphs(a: IRGraph, b: IRGraph): string[] {
  const diffs: string[] = [];

  const aNodes = new Map(a.nodes.map((n) => [n.id, n]));
  const bNodes = new Map(b.nodes.map((n) => [n.id, n]));

  for (const [id, na] of aNodes) {
    const nb = bNodes.get(id);
    if (!nb) {
      diffs.push(`missing node after round-trip: ${id} (${na.type})`);
      continue;
    }
    if (na.type !== nb.type) {
      diffs.push(`node ${id} type changed: ${na.type} → ${nb.type}`);
    }
    if ((na.parent ?? undefined) !== (nb.parent ?? undefined)) {
      diffs.push(
        `node ${id} parent changed: ${na.parent ?? '∅'} → ${nb.parent ?? '∅'}`,
      );
    }
  }
  for (const id of bNodes.keys()) {
    if (!aNodes.has(id)) diffs.push(`extra node after round-trip: ${id}`);
  }

  const execAdj = (g: IRGraph) =>
    new Set(g.edges.filter((e) => e.kind === 'exec').map((e) => `${e.from.node}->${e.to.node}`));
  const dataAdj = (g: IRGraph) =>
    new Set(g.edges.filter((e) => e.kind === 'data').map((e) => `${e.from.node}->${e.to.node}`));

  diffSets(execAdj(a), execAdj(b), 'exec edge', diffs);
  diffSets(dataAdj(a), dataAdj(b), 'data edge', diffs);

  return diffs;
}

function diffSets(a: Set<string>, b: Set<string>, kind: string, out: string[]): void {
  for (const e of a) if (!b.has(e)) out.push(`missing ${kind}: ${e}`);
  for (const e of b) if (!a.has(e)) out.push(`extra ${kind}: ${e}`);
}

/**
 * Pretty-prints a round-trip report to the console. Returns the report so it
 * can be inspected programmatically.
 */
export function runRoundtripDemo(ir: IRGraph = sampleWorkflow): RoundtripReport {
  const report = roundtrip(ir);

  /* eslint-disable no-console */
  console.group(`%cOpenWorkflow round-trip — ${ir.meta.name ?? 'workflow'}`, 'font-weight:bold');
  console.log('Emitted Claude Code script:\n');
  console.log(report.script);
  console.log('Node counts:', report.counts);
  if (report.ok) {
    console.log('%c✓ round-trip preserved graph structure', 'color:#37c2a8');
  } else {
    console.warn('round-trip diffs:');
    for (const d of report.diffs) console.warn('  •', d);
  }
  if (!report.idempotent) console.warn('  • emit→parse→emit is NOT byte-identical');
  console.groupEnd();
  /* eslint-enable no-console */

  return report;
}

/** Aggregate report across every fixture, with the empty-workflow predicate check. */
export interface SuiteReport {
  ok: boolean;
  results: { name: string; ok: boolean; idempotent: boolean; diffs: string[] }[];
}

/** Run the full fixture suite (F1–F6) plus the isEmptyWorkflow sanity check. */
export function roundtripAll(): SuiteReport {
  const results = roundtripFixtures.map(({ name, ir }) => {
    const r = roundtrip(ir);
    return { name, ok: r.ok, idempotent: r.idempotent, diffs: r.diffs };
  });

  // isEmptyWorkflow: default blueprint is empty; the sample is not.
  const emptyOk = isEmptyWorkflow(defaultBlueprint()) && !isEmptyWorkflow(sampleWorkflow);
  results.push({
    name: 'isEmptyWorkflow predicate',
    ok: emptyOk,
    idempotent: true,
    diffs: emptyOk ? [] : ['isEmptyWorkflow misclassified default/sample'],
  });

  const ok = results.every((r) => r.ok && r.idempotent);

  /* eslint-disable no-console */
  console.group('%cOpenWorkflow round-trip suite', 'font-weight:bold');
  for (const r of results) {
    const tag = r.ok && r.idempotent ? '✓' : '✗';
    const note = !r.ok ? ' (structure)' : !r.idempotent ? ' (not idempotent)' : '';
    console.log(`${tag} ${r.name}${note}`);
    for (const d of r.diffs) console.warn('    •', d);
  }
  console.log(ok ? '%c✓ all fixtures passed' : '%c✗ some fixtures failed', `color:${ok ? '#37c2a8' : '#e36a6a'}`);
  console.groupEnd();
  /* eslint-enable no-console */

  return { ok, results };
}

/**
 * Dev convenience: expose the harness on `window.OpenWorkflow` so it can be
 * invoked from the browser console. No-op outside a browser environment.
 */
export function installRoundtripConsole(): void {
  if (typeof window === 'undefined') return;
  const api = {
    roundtrip,
    runRoundtripDemo,
    roundtripAll,
    emit: emitClaudeScript,
    parse: parseClaudeScript,
    sample: sampleWorkflow,
    fixtures: roundtripFixtures,
  };
  (window as unknown as { OpenWorkflow?: typeof api }).OpenWorkflow = api;
}
