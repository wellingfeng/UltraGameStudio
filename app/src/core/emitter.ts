import {
  DATA,
  type IRAgentSpec,
  type IREdge,
  type IRGraph,
  type IRNode,
} from './ir';
import { topoOrderScope } from './topo';

/**
 * CONTRACT: emitClaudeScript(ir) compiles an IRGraph into a *genuinely runnable*
 * Claude Code workflow script (the injected-globals DSL documented in
 * docs/workflow-syntax-reference.html).
 *
 * Output shape:
 *
 *   export const meta = { name, description, phases:[{title}] }
 *
 *   const REVIEW = { … } // @schema REVIEW          ← schema identifier defs
 *
 *   phase('Scan')
 *   const scan = await agent('…', { agentType:'explore', model:'haiku' }) // @node n_scan
 *   const review = await parallel([
 *     () => agent('…', { agentType:'quality-reviewer', schema: REVIEW }),
 *   ]) // @node n_review
 *   const out = await pipeline(files,
 *     (item) => agent('…', { schema: REVIEW }),
 *     (prev, item, i) => agent('…', { schema: VERDICT }),
 *   ) // @node n_pipe
 *   if (scan.ok) { // @node n_branch
 *     const fix = await agent('…') // @node n_fix
 *   }
 *   return { scan, review }
 *
 * Design notes:
 * - Nodes are ordered topologically along the execution (`exec`) spine, per
 *   scope. `branch`/`loop` nodes emit real `if`/`while` blocks and their child
 *   nodes (those whose `parent` equals the container id) are emitted, indented,
 *   inside the block via recursive scope emission.
 * - Each statement carries a trailing `// @node <id>` annotation so the parser
 *   reconstructs the exact original node id (lossless round-trip). For block
 *   statements the annotation sits on the opening `{` line.
 * - `parallel` branches are emitted as a thunk array `() => agent(...)`;
 *   `pipeline` stages as `(prev, item, i) => agent(...)` callbacks — the real,
 *   runnable forms (not string arrays).
 * - Data edges surface as `${var}` template interpolation inside a deterministic,
 *   sentinel-delimited context block appended to the consuming agent's prompt, so
 *   data flow round-trips while `params.prompt` stays stable across re-emit.
 * - `schema` is emitted as a *bare identifier*; the referenced identifiers are
 *   defined once in a preamble from `meta.schemaDefs` (default `{}`).
 * - `codeblock` nodes carry verbatim source in `params.code` and pass through raw.
 */
export function emitClaudeScript(ir: IRGraph): string {
  const lines: string[] = [];
  lines.push(emitMeta(ir));
  lines.push('');

  // Build naming + data-flow context that the whole emission shares.
  const emissionOrder = flattenEmissionOrder(ir);
  const varNames = assignVarNames(emissionOrder);
  const dataSources = buildDataSourceIndex(ir);
  const hoisted = computeHoistedProducers(ir, dataSources);

  const ctx: EmitCtx = { ir, varNames, dataSources, hoisted };

  // Schema identifier definitions, so `schema: REVIEW` references resolve.
  const preamble = emitSchemaPreamble(ir);
  if (preamble.length > 0) {
    lines.push(...preamble);
    lines.push('');
  }

  // `let` declarations for producers referenced from an outer scope.
  if (hoisted.size > 0) {
    const names = [...hoisted].map((id) => varNames.get(id)!).filter(Boolean);
    if (names.length > 0) lines.push(`let ${names.join(', ')}`);
    lines.push('');
  }

  // Top scope (parent === undefined): includes start/end sentinels.
  lines.push(...emitScope(ctx, undefined, 0));

  // `return { … }` over top-scope value-producing nodes.
  const returnVars = topoOrderScope(ir, undefined)
    .filter((n) => producesReturn(n.type))
    .map((n) => varNames.get(n.id)!)
    .filter(Boolean);
  if (returnVars.length > 0) {
    lines.push('');
    lines.push(`return { ${returnVars.join(', ')} }`);
  }

  lines.push('');
  return lines.join('\n');
}

/* -------------------------------------------------------------------------- */
/* emission context                                                           */
/* -------------------------------------------------------------------------- */

interface EmitCtx {
  ir: IRGraph;
  varNames: Map<string, string>;
  /** target node id → inbound data sources (producer node ids). */
  dataSources: Map<string, string[]>;
  /** producer node ids that must be hoisted to a top-scope `let`. */
  hoisted: Set<string>;
}

/**
 * Sentinel delimiters bracketing the auto-injected data-flow context block.
 * Exported so the parser strips the exact same markers when recovering the
 * authored prompt (keeping emit→parse→emit idempotent).
 */
export const CTX_OPEN = '<!--owf:ctx-->';
export const CTX_CLOSE = '<!--/owf:ctx-->';

/* -------------------------------------------------------------------------- */
/* scope emission                                                             */
/* -------------------------------------------------------------------------- */

/** Emit every node in one scope (a given `parent`), recursing into containers. */
function emitScope(
  ctx: EmitCtx,
  parentId: string | undefined,
  indent: number,
): string[] {
  const pad = '  '.repeat(indent);
  const out: string[] = [];
  const order = topoOrderScope(ctx.ir, parentId);

  for (const node of order) {
    switch (node.type) {
      case 'start':
      case 'end':
        break; // implicit script entry / `return`
      case 'phase':
        out.push(`${pad}phase(${str(phaseTitle(node))}) // @node ${node.id}`);
        break;
      case 'agent': {
        const v = assign(ctx, node.id);
        const call = emitAgentCall(nodeToSpec(node), ctxVars(ctx, node.id));
        out.push(`${pad}${decl(ctx, node.id, v)}await ${call} // @node ${node.id}`);
        break;
      }
      case 'parallel': {
        const v = assign(ctx, node.id);
        const call = emitParallel(node, indent);
        out.push(`${pad}${decl(ctx, node.id, v)}await ${call} // @node ${node.id}`);
        break;
      }
      case 'pipeline': {
        const v = assign(ctx, node.id);
        const call = emitPipeline(node, indent);
        out.push(`${pad}${decl(ctx, node.id, v)}await ${call} // @node ${node.id}`);
        break;
      }
      case 'workflow': {
        const v = assign(ctx, node.id);
        const name = str(String(node.params.name ?? node.label ?? 'sub'));
        out.push(
          `${pad}${decl(ctx, node.id, v)}await workflow(${name}) // @node ${node.id}`,
        );
        break;
      }
      case 'log': {
        const msg = str(String(node.params.message ?? node.params.msg ?? node.label ?? ''));
        out.push(`${pad}log(${msg}) // @node ${node.id}`);
        break;
      }
      case 'variable': {
        const v = assign(ctx, node.id);
        out.push(`${pad}${decl(ctx, node.id, v)}${variableValue(node)} // @node ${node.id}`);
        break;
      }
      case 'branch': {
        const cond = String(node.params.condition ?? 'true');
        out.push(`${pad}if (${cond}) { // @node ${node.id}`);
        out.push(...emitScope(ctx, node.id, indent + 1));
        out.push(`${pad}}`);
        break;
      }
      case 'loop': {
        const cond = String(node.params.condition ?? node.params.until ?? 'false');
        out.push(`${pad}while (${cond}) { // @node ${node.id}`);
        out.push(...emitScope(ctx, node.id, indent + 1));
        out.push(`${pad}}`);
        break;
      }
      case 'codeblock': {
        const code = String(node.params.code ?? '').replace(/\s+$/, '');
        out.push(`${pad}${code} // @node ${node.id}`);
        break;
      }
      default:
        out.push(`${pad}/* unknown node ${node.id} */ // @node ${node.id}`);
    }
  }
  return out;
}

/** `const name = ` or `name = ` (hoisted) prefix for a value-producing node. */
function decl(ctx: EmitCtx, nodeId: string, varName: string): string {
  return ctx.hoisted.has(nodeId) ? `${varName} = ` : `const ${varName} = `;
}

function assign(ctx: EmitCtx, nodeId: string): string {
  return ctx.varNames.get(nodeId) ?? 'v';
}

/* -------------------------------------------------------------------------- */
/* agent / parallel / pipeline calls                                          */
/* -------------------------------------------------------------------------- */

/** Read an agent node's params as an IRAgentSpec (tolerating the legacy `agent:` key). */
function nodeToSpec(node: IRNode): IRAgentSpec {
  const p = node.params ?? {};
  return {
    prompt: String(p.prompt ?? node.label ?? ''),
    label: optStr(p.label),
    agentType: optStr(p.agentType ?? p.agent),
    model: optStr(p.model),
    schema: optStr(p.schema),
    isolation: p.isolation === 'worktree' ? 'worktree' : undefined,
    phase: optStr(p.phase),
  };
}

/**
 * Emit a single `agent(prompt, opts)` call. When `ctxVars` is non-empty the
 * prompt is emitted as a template literal carrying the data-flow context block.
 */
function emitAgentCall(spec: IRAgentSpec, ctxVars: string[]): string {
  const prompt = emitPromptLiteral(spec.prompt, ctxVars);
  const opts = emitAgentOpts(spec);
  return `agent(${prompt}${opts})`;
}

/** Build the trailing `{ … }` options object for an agent spec (present keys only). */
function emitAgentOpts(spec: IRAgentSpec): string {
  const opts: string[] = [];
  if (spec.label) opts.push(`label: ${str(spec.label)}`);
  if (spec.phase) opts.push(`phase: ${str(spec.phase)}`);
  if (spec.agentType) opts.push(`agentType: ${str(spec.agentType)}`);
  if (spec.model) opts.push(`model: ${str(spec.model)}`);
  if (spec.schema) opts.push(`schema: ${ident(spec.schema)}`); // bare identifier
  if (spec.isolation) opts.push(`isolation: ${str(spec.isolation)}`);
  if (opts.length === 0) return '';
  return `, { ${opts.join(', ')} }`;
}

/** Emit the prompt as a quoted string, or a template literal with a context block. */
function emitPromptLiteral(prompt: string, ctxVars: string[]): string {
  if (ctxVars.length === 0) return str(prompt);
  const body = ctxVars.map((v) => `- \${${v}}`).join('\n');
  const tpl =
    `${prompt}\n\n${CTX_OPEN}\n上文输出:\n${body}\n${CTX_CLOSE}`;
  return template(tpl);
}

/** Emit a `parallel([ () => agent(...), … ])` thunk array. */
function emitParallel(node: IRNode, indent: number): string {
  const branches = readSpecs(node.params.branches);
  if (branches.length === 0) return 'parallel([])';
  const pad = '  '.repeat(indent + 1);
  const items = branches.map((b) => `${pad}() => ${emitAgentCall(b, [])},`);
  return `parallel([\n${items.join('\n')}\n${'  '.repeat(indent)}])`;
}

/** Emit a `pipeline(items, (item) => agent(...), (prev, item, i) => agent(...))`. */
function emitPipeline(node: IRNode, indent: number): string {
  const items = String(node.params.items ?? 'args');
  const stages = readSpecs(node.params.stages);
  if (stages.length === 0) return `pipeline(${items})`;
  const pad = '  '.repeat(indent + 1);
  const cbs = stages.map((s, i) => {
    const sig = i === 0 ? '(item)' : '(prev, item, i)';
    return `${pad}${sig} => ${emitAgentCall(s, [])},`;
  });
  return `pipeline(${items},\n${cbs.join('\n')}\n${'  '.repeat(indent)})`;
}

/**
 * Coerce a params array of agent specs into IRAgentSpec[], tolerating the legacy
 * `string[]` form (a bare agent-name string becomes `{ prompt: name }`).
 */
function readSpecs(value: unknown): IRAgentSpec[] {
  if (!Array.isArray(value)) return [];
  return value.map((v): IRAgentSpec => {
    if (typeof v === 'string') return { prompt: v };
    const o = (v ?? {}) as Record<string, unknown>;
    return {
      prompt: String(o.prompt ?? o.label ?? ''),
      label: optStr(o.label),
      agentType: optStr(o.agentType ?? o.agent),
      model: optStr(o.model),
      schema: optStr(o.schema),
      isolation: o.isolation === 'worktree' ? 'worktree' : undefined,
      phase: optStr(o.phase),
    };
  });
}

/* -------------------------------------------------------------------------- */
/* meta + schema preamble                                                     */
/* -------------------------------------------------------------------------- */

function emitMeta(ir: IRGraph): string {
  const parts: string[] = [];
  parts.push(`name: ${str(ir.meta.name ?? 'workflow')}`);
  if (ir.meta.description != null) parts.push(`description: ${str(ir.meta.description)}`);
  if (ir.meta.adapter != null) parts.push(`adapter: ${str(ir.meta.adapter)}`);
  const phases = ir.nodes
    .filter((n) => n.type === 'phase')
    .map((n) => `{ title: ${str(phaseTitle(n))} }`);
  if (phases.length > 0) parts.push(`phases: [${phases.join(', ')}]`);
  return `export const meta = { ${parts.join(', ')} }`;
}

/** Emit `const NAME = <body> // @schema NAME` for every referenced schema id. */
function emitSchemaPreamble(ir: IRGraph): string[] {
  const names = collectSchemaNames(ir);
  const defs = ir.meta.schemaDefs ?? {};
  return [...names].map((name) => {
    const body = (defs[name] ?? '{}').trim() || '{}';
    return `const ${ident(name)} = ${body} // @schema ${name}`;
  });
}

/** Distinct schema identifier names referenced by any agent/branch/stage spec. */
function collectSchemaNames(ir: IRGraph): Set<string> {
  const names = new Set<string>();
  const add = (s?: string) => {
    if (s && /^[A-Za-z_$][\w$]*$/.test(s)) names.add(s);
  };
  for (const node of ir.nodes) {
    if (node.type === 'agent') add(nodeToSpec(node).schema);
    if (node.type === 'parallel') for (const b of readSpecs(node.params.branches)) add(b.schema);
    if (node.type === 'pipeline') for (const s of readSpecs(node.params.stages)) add(s.schema);
  }
  return names;
}

/* -------------------------------------------------------------------------- */
/* data flow                                                                  */
/* -------------------------------------------------------------------------- */

/** Maps a consuming node id → producer node ids (sorted, deduped) over data edges. */
function buildDataSourceIndex(ir: IRGraph): Map<string, string[]> {
  const map = new Map<string, Set<string>>();
  for (const edge of ir.edges) {
    if (edge.kind !== DATA) continue;
    if (edge.from.node === edge.to.node) continue;
    const set = map.get(edge.to.node) ?? new Set<string>();
    set.add(edge.from.node);
    map.set(edge.to.node, set);
  }
  const out = new Map<string, string[]>();
  for (const [k, set] of map) out.set(k, [...set].sort());
  return out;
}

/** The producer var names that flow into `nodeId` (only those with a var name). */
function ctxVars(ctx: EmitCtx, nodeId: string): string[] {
  const sources = ctx.dataSources.get(nodeId) ?? [];
  return sources.map((id) => ctx.varNames.get(id)).filter((v): v is string => !!v);
}

/**
 * A producer must be hoisted to a top-scope `let` when it is consumed by a node
 * that cannot see its `const` — i.e. the producer is declared inside a
 * block/scope that is not an ancestor of (or equal to) the consumer's scope.
 */
function computeHoistedProducers(
  ir: IRGraph,
  dataSources: Map<string, string[]>,
): Set<string> {
  const byId = new Map(ir.nodes.map((n) => [n.id, n]));
  const hoist = new Set<string>();
  for (const [consumerId, producers] of dataSources) {
    const consumer = byId.get(consumerId);
    if (!consumer) continue;
    for (const producerId of producers) {
      const producer = byId.get(producerId);
      if (!producer) continue;
      if (!isVisible(producer, consumer, byId)) hoist.add(producerId);
    }
  }
  return hoist;
}

/** True when `producer`'s declaration scope is visible at `consumer`. */
function isVisible(
  producer: IRNode,
  consumer: IRNode,
  byId: Map<string, IRNode>,
): boolean {
  const producerScope = producer.parent ?? undefined;
  if (producerScope === undefined) return true; // top scope: visible everywhere
  // Walk the consumer's scope chain up to the root.
  let scope: string | undefined = consumer.parent ?? undefined;
  while (scope !== undefined) {
    if (scope === producerScope) return true;
    scope = byId.get(scope)?.parent ?? undefined;
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/* emission ordering + var naming                                             */
/* -------------------------------------------------------------------------- */

/**
 * Depth-first flatten of the whole graph in *emission* order: each scope is
 * walked via topoOrderScope, descending into a container's body at the point the
 * container appears. This is the order var names are assigned in, and it matches
 * the emission order — which is what survives a round-trip — so var names stay
 * stable across emit→parse→emit (idempotent).
 */
function flattenEmissionOrder(ir: IRGraph): IRNode[] {
  const out: IRNode[] = [];
  const walk = (parentId: string | undefined): void => {
    for (const node of topoOrderScope(ir, parentId)) {
      out.push(node);
      if (node.type === 'branch' || node.type === 'loop') walk(node.id);
    }
  };
  walk(undefined);
  return out;
}

/** Assign a readable, unique JS identifier to each value-producing node. */
function assignVarNames(order: IRNode[]): Map<string, string> {
  const names = new Map<string, string>();
  const used = new Set<string>();
  for (const node of order) {
    if (!producesValue(node.type)) continue;
    // Prefer a recovered binding so re-emit reproduces the exact var name.
    let base =
      node.binding && /^[A-Za-z_$][\w$]*$/.test(node.binding)
        ? node.binding
        : sanitizeIdent(node.label ?? node.type ?? 'v');
    if (!base) base = 'v';
    let candidate = base;
    let i = 2;
    while (used.has(candidate)) {
      candidate = `${base}${i}`;
      i += 1;
    }
    used.add(candidate);
    names.set(node.id, candidate);
  }
  return names;
}

function producesValue(type: IRNode['type']): boolean {
  return (
    type === 'agent' ||
    type === 'parallel' ||
    type === 'pipeline' ||
    type === 'workflow' ||
    type === 'variable'
  );
}

/** Value-producing node types surfaced in the top-level `return { … }`. */
function producesReturn(type: IRNode['type']): boolean {
  return (
    type === 'agent' || type === 'parallel' || type === 'pipeline' || type === 'workflow'
  );
}

function sanitizeIdent(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^[0-9]/, (m) => `_${m}`);
  const parts = cleaned.split('_').filter(Boolean);
  if (parts.length === 0) return '';
  const camel =
    parts[0] +
    parts
      .slice(1)
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join('');
  return camel.slice(0, 24);
}

/* -------------------------------------------------------------------------- */
/* small helpers                                                              */
/* -------------------------------------------------------------------------- */

function phaseTitle(node: IRNode): string {
  return String(node.params.title ?? node.label ?? 'Phase');
}

function optStr(v: unknown): string | undefined {
  if (v == null) return undefined;
  const s = String(v).trim();
  return s ? s : undefined;
}

/** Escapes a string as a single-quoted JS literal. */
function str(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
}

/**
 * Escapes a string as a template literal, preserving intentional `${…}`
 * interpolations (only backslashes and backticks are escaped; `${` is left
 * intact so injected variable references resolve).
 */
function template(value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/`/g, '\\`');
  return `\`${escaped}\``;
}

/** Emit a bare identifier; falls back to a safe placeholder if malformed. */
function ident(name: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : 'Object';
}

/**
 * Emit a `variable` node's initializer. The parser stores the verbatim source of
 * the initializer with `params.raw = true`, in which case we emit it as-is (so
 * arrays/objects/identifier refs survive). Inspector-authored values (`raw`
 * unset) are JSON-encoded. Either way emit→parse→emit converges to the verbatim
 * form, keeping the script idempotent.
 */
function variableValue(node: IRNode): string {
  const value = node.params.value;
  if (node.params.raw && typeof value === 'string') return value;
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return str(value);
  try {
    return JSON.stringify(value);
  } catch {
    return 'null';
  }
}

// Re-export to keep IREdge referenced for type clarity.
export type { IREdge };
