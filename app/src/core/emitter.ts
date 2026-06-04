import {
  DATA,
  type IRAgentSpec,
  type IREdge,
  type IRGraph,
  type IRNode,
  type IRPort,
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

  const portVarNames = assignCompositePortVarNames(ir, varNames);
  const ctx: EmitCtx = { ir, varNames, dataSources, hoisted, portVarNames };

  // Schema identifier definitions, so `schema: REVIEW` references resolve.
  const preamble = emitSchemaPreamble(ir);
  if (preamble.length > 0) {
    lines.push(...preamble);
    lines.push('');
  }

  // Self-contained runtime helpers (e.g. `consensus`) so the exported script is
  // genuinely runnable in real Claude Code without any external global. Annotated
  // `// @fuc:runtime` so the parser skips them and re-emits a fresh copy.
  const helpers = emitRuntimeHelpers(ir);
  if (helpers.length > 0) {
    lines.push(...helpers);
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
  /**
   * `${compositeId}::${portId}` → the JS parameter name the composite function
   * exposes for that input port. Consumers inside the body read a declared input
   * via this parameter rather than via a producer var (they live in a different
   * function scope), so a data edge whose source is the composite node resolves to
   * a param name here.
   */
  portVarNames: Map<string, string>;
}

/**
 * Sentinel delimiters bracketing the auto-injected data-flow context block.
 * Exported so the parser strips the exact same markers when recovering the
 * authored prompt (keeping emit→parse→emit idempotent).
 */
export const CTX_OPEN = '<!--fuc:ctx-->';
export const CTX_CLOSE = '<!--/fuc:ctx-->';

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
        const spec = nodeToSpec(node);
        const call = emitAgentCall(spec, ctxVars(ctx, node.id));
        out.push(
          `${pad}${decl(ctx, node.id, v)}await ${call} // @node ${node.id}${routeAnnotation(spec)}`,
        );
        break;
      }
      case 'parallel': {
        const v = assign(ctx, node.id);
        const spec = nodeToSpec(node);
        const call = emitParallel(node, indent, ctxVars(ctx, node.id));
        out.push(
          `${pad}${decl(ctx, node.id, v)}await ${call} // @node ${node.id}${routeAnnotation(spec)}`,
        );
        break;
      }
      case 'pipeline': {
        const v = assign(ctx, node.id);
        const spec = nodeToSpec(node);
        const call = emitPipeline(node, indent);
        out.push(
          `${pad}${decl(ctx, node.id, v)}await ${call} // @node ${node.id}${routeAnnotation(spec)}`,
        );
        break;
      }
      case 'consensus': {
        const v = assign(ctx, node.id);
        const spec = nodeToSpec(node);
        const call = emitConsensus(node, indent, ctxVars(ctx, node.id));
        out.push(
          `${pad}${decl(ctx, node.id, v)}await ${call} // @node ${node.id}${routeAnnotation(spec)}`,
        );
        break;
      }
      case 'workflow': {
        const v = assign(ctx, node.id);
        const name = str(String(node.params.name ?? node.label ?? 'sub'));
        out.push(
          `${pad}${decl(ctx, node.id, v)}await workflow(${name}) // @node ${node.id}${routeAnnotation(nodeToSpec(node))}`,
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
      case 'composite': {
        out.push(...emitComposite(ctx, node, indent));
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
  const gateway = readGatewayOverride(p.gateway);
  return {
    prompt: String(p.prompt ?? node.label ?? ''),
    label: optStr(p.label),
    agentType: optStr(p.agentType ?? p.agent),
    model: optStr(p.model) ?? gateway?.modelClass,
    gateway,
    schema: optStr(p.schema),
    isolation: p.isolation === 'worktree' ? 'worktree' : undefined,
    phase: optStr(p.phase),
    contextPolicy:
      p.contextPolicy === 'tail' || p.contextPolicy === 'full'
        ? p.contextPolicy
        : undefined,
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
  if (spec.gateway) opts.push(`gateway: ${emitGatewaySelection(spec.gateway)}`);
  if (spec.schema) opts.push(`schema: ${ident(spec.schema)}`); // bare identifier
  if (spec.isolation) opts.push(`isolation: ${str(spec.isolation)}`);
  if (spec.contextPolicy) opts.push(`contextPolicy: ${str(spec.contextPolicy)}`);
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

/**
 * The trailing `, { from: [a, b] }` data-input argument for a container call
 * (parallel / consensus). Unlike an `agent` (which weaves upstream outputs into
 * its prompt template) or a `pipeline` (whose data input is its `items` arg),
 * these two nodes carry no natural reference to their upstream producers, so
 * their data edges would otherwise vanish on emit→parse. Emitting upstream var
 * names as bare identifiers in an options object lets the parser's `wireDataRefs`
 * (which resolves identifier references against earlier bindings) reconstruct the
 * exact data edges — keeping round-trip lossless. The injected runtime helpers
 * read only their leading argument(s), so the extra `from` is inert at run time.
 * Empty ⇒ '' (no behavior change for nodes without data inputs, preserving
 * byte-stability of existing scripts).
 */
function dataInputArg(ctxVars: string[]): string {
  if (ctxVars.length === 0) return '';
  return `, { from: [${ctxVars.join(', ')}] }`;
}

/** Emit a `parallel([ () => agent(...), … ])` thunk array. */
function emitParallel(node: IRNode, indent: number, ctxVars: string[] = []): string {
  const branches = readSpecs(node.params.branches);
  const from = dataInputArg(ctxVars);
  if (branches.length === 0) return `parallel([]${from})`;
  const pad = '  '.repeat(indent + 1);
  const items = branches.map((b) => `${pad}() => ${emitAgentCall(b, [])},`);
  return `parallel([\n${items.join('\n')}\n${'  '.repeat(indent)}]${from})`;
}

/**
 * Emit a `pipeline(items, (item) => agent(...), (prev, item, i) => agent(...))`.
 * A pipeline's data input is its `items` argument (the parser recovers the
 * upstream edge from the `items` identifier), so — unlike parallel/consensus — it
 * needs no `from:` annotation.
 */
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
 * Emit a `consensus([ () => agent(...), … ], { strategy, … })` call. Voters mirror
 * `parallel` branches (thunk array, no nested ctx block). The trailing options use
 * a fixed key order (strategy, samples, quorum, schema) so re-emit is byte-stable;
 * `schema` is a bare identifier defined in the schema preamble. Upstream data
 * inputs (`ctxVars`) are folded into the same options object as a `from: […]`
 * array so they survive round-trip (the gate consumes worker outputs by edge,
 * not by prompt interpolation).
 */
function emitConsensus(node: IRNode, indent: number, ctxVars: string[] = []): string {
  const voters = readSpecs(node.params.voters);
  const opts = emitConsensusOpts(node, ctxVars);
  if (voters.length === 0) return `consensus([]${opts})`;
  const pad = '  '.repeat(indent + 1);
  const items = voters.map((b) => `${pad}() => ${emitAgentCall(b, [])},`);
  return `consensus([\n${items.join('\n')}\n${'  '.repeat(indent)}]${opts})`;
}

/** Build the `consensus` options object (fixed key order, present keys only). */
function emitConsensusOpts(node: IRNode, ctxVars: string[] = []): string {
  const p = node.params ?? {};
  const opts: string[] = [];
  const strategy = typeof p.strategy === 'string' ? p.strategy : 'multi-lens';
  opts.push(`strategy: ${str(strategy)}`);
  if (typeof p.samples === 'number') opts.push(`samples: ${p.samples}`);
  if (typeof p.quorum === 'number') opts.push(`quorum: ${p.quorum}`);
  const schema = optStr(p.schema);
  if (schema) opts.push(`schema: ${ident(schema)}`); // bare identifier
  if (ctxVars.length > 0) opts.push(`from: [${ctxVars.join(', ')}]`);
  return `, { ${opts.join(', ')} }`;
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
    const gateway = readGatewayOverride(o.gateway);
    return {
      prompt: String(o.prompt ?? o.label ?? ''),
      label: optStr(o.label),
      agentType: optStr(o.agentType ?? o.agent),
      model: optStr(o.model) ?? gateway?.modelClass,
      gateway,
      schema: optStr(o.schema),
      isolation: o.isolation === 'worktree' ? 'worktree' : undefined,
      phase: optStr(o.phase),
    };
  });
}

/* -------------------------------------------------------------------------- */
/* composite (encapsulated sub-workflow → local async function)               */
/* -------------------------------------------------------------------------- */

/** Read a composite node's declared `inputs`/`outputs` port arrays from params. */
function compositePorts(node: IRNode, key: 'inputs' | 'outputs'): IRPort[] {
  const raw = node.params?.[key];
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (p): p is IRPort =>
      !!p && typeof p === 'object' && typeof (p as IRPort).id === 'string',
  );
}

/** The data-kind input ports of a composite, in declared order. */
function compositeDataInputs(node: IRNode): IRPort[] {
  return compositePorts(node, 'inputs').filter((p) => (p.kind ?? DATA) === DATA);
}

/** The data-kind output ports of a composite, in declared order. */
function compositeDataOutputs(node: IRNode): IRPort[] {
  return compositePorts(node, 'outputs').filter((p) => (p.kind ?? DATA) === DATA);
}

/** The local async function name anchored to a composite's call var (`__composite_<callVar>`). */
function compositeFnName(callVar: string): string {
  return `__composite_${callVar}`;
}

/**
 * Assign each composite input *data* port a JS parameter name, recorded under
 * `${compositeId}::${portId}`. Names derive deterministically from the port label
 * (or id), are sanitized to valid identifiers, and are de-duplicated *within each
 * composite* (params share a function scope). Seeded with reserved globals so a
 * param never shadows `agent`/`parallel`/… .
 */
function assignCompositePortVarNames(
  ir: IRGraph,
  varNames: Map<string, string>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const node of ir.nodes) {
    if (node.type !== 'composite') continue;
    const used = new Set<string>(RESERVED_VAR_NAMES);
    // Avoid colliding with the composite's own call var / function name.
    const callVar = varNames.get(node.id);
    if (callVar) {
      used.add(callVar);
      used.add(compositeFnName(callVar));
    }
    for (const port of compositeDataInputs(node)) {
      const base = sanitizeIdent(port.label ?? port.id ?? 'arg') || 'arg';
      let candidate = base;
      let i = 2;
      while (used.has(candidate)) {
        candidate = `${base}${i}`;
        i += 1;
      }
      used.add(candidate);
      out.set(`${node.id}::${port.id}`, candidate);
    }
  }
  return out;
}

/**
 * Emit a composite as a local `async function` declaration immediately preceding
 * its call site (so re-emit is byte-stable and nesting falls out naturally):
 *
 *   // @composite c1
 *   // @ports in=in_topic:topic out=out_summary:summary
 *   async function __composite_callVar(topic) {
 *     const researcher = await agent('…') // @node a1
 *     const summarizer = await agent('…') // @node a2
 *     return summarizer // @return out_summary
 *   }
 *
 *   const callVar = await __composite_callVar(inputArg) // @node c1
 *
 * The body reuses the normal `emitScope` machinery (so inner data edges round-trip
 * through the same CTX-block mechanism); declared input ports surface as function
 * params and declared output ports as the `return`.
 */
function emitComposite(ctx: EmitCtx, node: IRNode, indent: number): string[] {
  const pad = '  '.repeat(indent);
  const callVar = assign(ctx, node.id);
  const fnName = compositeFnName(callVar);
  const inputs = compositeDataInputs(node);
  const outputs = compositeDataOutputs(node);

  const params = inputs
    .map((p) => ctx.portVarNames.get(`${node.id}::${p.id}`))
    .filter((v): v is string => !!v);

  const out: string[] = [];
  // Annotations carry the authoritative id + declared port ids/labels.
  out.push(`${pad}// @composite ${node.id}`);
  out.push(`${pad}// @ports ${emitPortsAnnotation(inputs, outputs)}`);
  out.push(`${pad}async function ${fnName}(${params.join(', ')}) {`);

  // Body: ordinary scoped emission (children carry parent === node.id).
  out.push(...emitScope(ctx, node.id, indent + 1));

  // return over declared output ports → inner producer vars.
  out.push(...emitCompositeReturn(ctx, node, outputs, indent + 1));
  out.push(`${pad}}`);
  out.push('');

  // Call site: bind outer inputs (by declared input-port order) to the args.
  const args = inputs.map((p) => compositeInputArg(ctx, node, p)).join(', ');
  out.push(
    `${pad}${decl(ctx, node.id, callVar)}await ${fnName}(${args}) // @node ${node.id}`,
  );
  return out;
}

/** `in=portId:label in=… out=portId:label …` annotation (labels optional). */
function emitPortsAnnotation(inputs: IRPort[], outputs: IRPort[]): string {
  const tok = (dir: 'in' | 'out', p: IRPort): string => {
    const label = p.label ? `:${slugToken(p.label)}` : '';
    return `${dir}=${p.id}${label}`;
  };
  return [
    ...inputs.map((p) => tok('in', p)),
    ...outputs.map((p) => tok('out', p)),
  ].join(' ');
}

/** A single annotation token's value, with whitespace collapsed (no spaces). */
function slugToken(label: string): string {
  return label.trim().replace(/\s+/g, '_');
}

/**
 * The argument expression passed for a composite input port at the call site: the
 * var name of the outer producer bound to that port via an input-binding data edge
 * `{ from:OUTER, to:{node:composite,port} }`. Undefined when unbound.
 */
function compositeInputArg(ctx: EmitCtx, node: IRNode, port: IRPort): string {
  const byId = new Map(ctx.ir.nodes.map((n) => [n.id, n]));
  const edge = ctx.ir.edges.find(
    (e) => e.kind === DATA && e.to.node === node.id && e.to.port === port.id,
  );
  if (!edge) return 'undefined';
  return resolveSourceVar(ctx, byId, edge.from.node, edge.from.port) ?? 'undefined';
}

/**
 * Emit the composite's `return`. Single declared output → `return <var> // @return
 * <portId>`. Multiple → `return { <portId>: <var>, … } // @returns p1,p2`. No
 * output → no return. The inner producer for an output port is the source of the
 * output-binding edge `{ from:INNER, to:{node:composite,port} }`.
 */
function emitCompositeReturn(
  ctx: EmitCtx,
  node: IRNode,
  outputs: IRPort[],
  indent: number,
): string[] {
  const pad = '  '.repeat(indent);
  if (outputs.length === 0) return [];
  const byId = new Map(ctx.ir.nodes.map((n) => [n.id, n]));
  const resolve = (port: IRPort): string => {
    const edge = ctx.ir.edges.find(
      (e) => e.kind === DATA && e.to.node === node.id && e.to.port === port.id,
    );
    return (
      (edge && resolveSourceVar(ctx, byId, edge.from.node, edge.from.port)) ??
      'undefined'
    );
  };
  if (outputs.length === 1) {
    const port = outputs[0];
    return [`${pad}return ${resolve(port)} // @return ${port.id}`];
  }
  const entries = outputs.map((p) => `${p.id}: ${resolve(p)}`).join(', ');
  const ports = outputs.map((p) => p.id).join(',');
  return [`${pad}return { ${entries} } // @returns ${ports}`];
}

/* -------------------------------------------------------------------------- */
/* meta + schema preamble                                                     */
/* -------------------------------------------------------------------------- */

function emitMeta(ir: IRGraph): string {
  const parts: string[] = [];
  parts.push(`name: ${str(ir.meta.name ?? 'workflow')}`);
  if (ir.meta.description != null) parts.push(`description: ${str(ir.meta.description)}`);
  if (ir.meta.adapter != null) parts.push(`adapter: ${str(ir.meta.adapter)}`);
  if (ir.meta.gateway?.defaults) {
    parts.push(`gateway: { defaults: ${emitGatewaySelection(ir.meta.gateway.defaults)} }`);
  }
  const phases = ir.nodes
    .filter((n) => n.type === 'phase')
    .map((n) => `{ title: ${str(phaseTitle(n))} }`);
  if (phases.length > 0) parts.push(`phases: [${phases.join(', ')}]`);
  return `export const meta = { ${parts.join(', ')} }`;
}

function emitGatewaySelection(selection: {
  adapter?: string;
  modelClass?: string;
  providerId?: string;
  channelId?: string;
}): string {
  const parts: string[] = [];
  if (selection.adapter) parts.push(`adapter: ${str(selection.adapter)}`);
  if (selection.modelClass) parts.push(`modelClass: ${str(selection.modelClass)}`);
  if (selection.providerId) parts.push(`providerId: ${str(selection.providerId)}`);
  if (selection.channelId) parts.push(`channelId: ${str(selection.channelId)}`);
  return `{ ${parts.join(', ')} }`;
}

function readGatewayOverride(value: unknown): IRAgentSpec['gateway'] {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const gateway: NonNullable<IRAgentSpec['gateway']> = {};
  if (typeof raw.modelClass === 'string') gateway.modelClass = raw.modelClass;
  if (typeof raw.providerId === 'string') gateway.providerId = raw.providerId;
  if (typeof raw.channelId === 'string') gateway.channelId = raw.channelId;
  return Object.keys(gateway).length > 0 ? gateway : undefined;
}

function routeAnnotation(spec: IRAgentSpec): string {
  const gateway = spec.gateway;
  if (!gateway) return '';
  const parts: string[] = [];
  if (gateway.providerId) parts.push(`provider=${gateway.providerId}`);
  if (gateway.channelId) parts.push(`channel=${gateway.channelId}`);
  if (gateway.modelClass) parts.push(`modelClass=${gateway.modelClass}`);
  return parts.length > 0 ? ` // @route ${parts.join(' ')}` : '';
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
    if (node.type === 'consensus') {
      add(optStr(node.params.schema));
      for (const v of readSpecs(node.params.voters)) add(v.schema);
    }
  }
  return names;
}

/* -------------------------------------------------------------------------- */
/* self-contained runtime helpers (portable export)                           */
/* -------------------------------------------------------------------------- */

/**
 * A self-contained `consensus(voters, opts)` helper, implementing the four
 * quality patterns purely on top of the `agent`/`parallel` globals so the
 * exported script runs in real Claude Code with no external dependency. Written
 * with `String.raw` + `+` concatenation (no backticks / no `${}`) so its `\n`
 * escapes survive verbatim into the emitted script. Annotated `// @fuc:runtime`
 * so the parser skips it and the emitter re-generates a fresh copy (idempotent).
 */
const CONSENSUS_RUNTIME_HELPER = String.raw`async function consensus(voters, opts) { // @fuc:runtime consensus
  const o = opts || {}
  const strategy = o.strategy || 'multi-lens'
  const want = strategy === 'self-consistency' ? Math.max(2, Math.min(7, o.samples || 3)) : voters.length
  const thunks = strategy === 'self-consistency' ? Array.from({ length: want }, () => voters[0]) : voters
  const out = (await parallel(thunks)).filter((r) => r != null)
  if (out.length === 0) return null
  const quorum = o.quorum || Math.ceil(want / 2)
  const text = (r) => (typeof r === 'string' ? r : JSON.stringify(r))
  const joinAll = out.map(text).join('\n\n')
  if (strategy === 'adversarial') {
    const kept = []
    for (const r of out) {
      const v = await agent('严格审视并尝试反驳下面的结论。若能推翻请以 REFUTED 开头，否则以 STANDS 开头：\n\n' + text(r))
      if (!/^\s*REFUTED/i.test(typeof v === 'string' ? v : '')) kept.push(r)
    }
    return (kept.length ? kept : out).map(text).join('\n\n---\n\n')
  }
  if (strategy === 'tournament') {
    const list = out.map((r, i) => '方案 ' + (i + 1) + '：\n' + text(r)).join('\n\n')
    return await agent('下面是 ' + out.length + ' 个独立方案。请择优选出最佳方案，并把其它方案中值得借鉴的亮点合并进去后输出最终方案：\n\n' + list)
  }
  if (o.schema) {
    const yes = out.filter((r) => r && (r.real || r.pass || r.agree || r.ok) === true)
    if (yes.length >= quorum) return text(yes[0])
    return await agent('下面是 ' + out.length + ' 份独立判定但未达成多数共识，请权衡后给出最可信结论：\n\n' + joinAll)
  }
  const buckets = new Map()
  for (const r of out) {
    const key = text(r).trim().toLowerCase().replace(/\s+/g, ' ')
    buckets.set(key, (buckets.get(key) || []).concat([r]))
  }
  let best = out[0], bestN = 0
  for (const g of buckets.values()) if (g.length > bestN) { bestN = g.length; best = g[0] }
  if (bestN >= quorum) return text(best)
  return await agent('下面是 ' + out.length + ' 份独立结果但未形成多数一致，请综合给出最可信结论：\n\n' + joinAll)
}`;

/** Emit any self-contained runtime helpers the graph needs (currently `consensus`). */
function emitRuntimeHelpers(ir: IRGraph): string[] {
  const needsConsensus = ir.nodes.some((n) => n.type === 'consensus');
  return needsConsensus ? [CONSENSUS_RUNTIME_HELPER] : [];
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

/**
 * The producer var names that flow into `nodeId` (only those resolvable to a
 * name). A normal producer resolves to its `const` var name. A composite *input
 * port* (a data edge whose source node is a composite and whose source port is one
 * of that composite's declared input ports) resolves instead to the function
 * *parameter* name the composite exposes for that port — because the consumer
 * lives inside the composite's function body, a different lexical scope.
 */
function ctxVars(ctx: EmitCtx, nodeId: string): string[] {
  const byId = new Map(ctx.ir.nodes.map((n) => [n.id, n]));
  const names: string[] = [];
  const seen = new Set<string>();
  // Deterministic order: iterate sorted source node ids (matches dataSources),
  // resolving each source's contribution(s) for this consumer.
  const sources = ctx.dataSources.get(nodeId) ?? [];
  const push = (name: string | undefined): void => {
    if (name && !seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  };
  for (const sourceId of sources) {
    const source = byId.get(sourceId);
    if (source?.type === 'composite') {
      // A composite feeds a consumer through declared ports: INPUT ports resolve to
      // the function param (consumer is inside the body); OUTPUT ports resolve to
      // the composite call var (consumer is outside). Iterate every edge from this
      // composite into the consumer, sorted by port id for determinism.
      const edges = ctx.ir.edges
        .filter(
          (e) =>
            e.kind === DATA && e.from.node === sourceId && e.to.node === nodeId,
        )
        .sort((a, b) => a.from.port.localeCompare(b.from.port));
      for (const e of edges) {
        push(resolveSourceVar(ctx, byId, sourceId, e.from.port));
      }
      continue;
    }
    push(ctx.varNames.get(sourceId));
  }
  return names;
}

/** True when `portId` is one of `composite`'s declared input ports. */
function isCompositeInputPort(composite: IRNode, portId: string): boolean {
  return compositePorts(composite, 'inputs').some((p) => p.id === portId);
}

/**
 * Resolve the JS expression that names the value emitted by a data-edge source
 * `(fromNode, fromPort)` *from the perspective of code reading it*:
 *  - composite + input port  → the function parameter exposed for that port
 *    (the reader is inside that composite's body);
 *  - composite + output port → the composite's call var (the reader is outside);
 *  - any other producer       → its `const` var name.
 * Returns undefined when no name can be resolved.
 */
function resolveSourceVar(
  ctx: EmitCtx,
  byId: Map<string, IRNode>,
  fromNode: string,
  fromPort: string,
): string | undefined {
  const source = byId.get(fromNode);
  if (source?.type === 'composite' && isCompositeInputPort(source, fromPort)) {
    return ctx.portVarNames.get(`${fromNode}::${fromPort}`);
  }
  return ctx.varNames.get(fromNode);
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
    // Port-binding edges (source or target IS a composite node) cross function
    // boundaries via declared ports → params/return, never via a hoisted `let`.
    if (consumer.type === 'composite') continue;
    for (const producerId of producers) {
      const producer = byId.get(producerId);
      if (!producer) continue;
      if (producer.type === 'composite') continue; // composite output → param/return
      // A producer that is invisible across a composite function boundary cannot
      // be reached via a hoisted `let` (the let would reference an out-of-scope
      // var, or an inner var leaking out). Such illegal bare edges (bypassing a
      // declared port) are simply not wired — skip rather than emit invalid JS.
      if (!sameFunctionReachable(producer, consumer, byId)) continue;
      if (!isVisible(producer, consumer, byId)) hoist.add(producerId);
    }
  }
  return hoist;
}

/**
 * The nearest composite ancestor of a node (its enclosing function body), or
 * undefined when the node lives in the top-level function. Used to decide whether
 * two nodes share a function for hoisting purposes.
 */
function enclosingComposite(
  node: IRNode,
  byId: Map<string, IRNode>,
): string | undefined {
  let scope = node.parent ?? undefined;
  while (scope !== undefined) {
    const n = byId.get(scope);
    if (n?.type === 'composite') return scope;
    scope = n?.parent ?? undefined;
  }
  return undefined;
}

/** True when `producer` and `consumer` live in the same emitted function. */
function sameFunctionReachable(
  producer: IRNode,
  consumer: IRNode,
  byId: Map<string, IRNode>,
): boolean {
  return (
    enclosingComposite(producer, byId) === enclosingComposite(consumer, byId)
  );
}

/**
 * True when `producer`'s declaration scope is visible at `consumer`.
 *
 * branch/loop are transparent lexical blocks inside the same function, so a
 * top-scope (or ancestor-scope) `let` is visible from a nested block. `composite`
 * is a hard boundary: it compiles to a *separate* `async function`, so a producer
 * inside a composite is invisible outside it and vice versa. We model this by
 * walking the consumer's scope chain toward the root and refusing to cross a
 * composite boundary: the moment the walk steps *out of* a composite scope, the
 * producer's scope (if not yet matched) is in a different function and invisible.
 *
 * Legal cross-boundary data flow only travels through declared ports (input/output
 * binding edges, whose source or target is the composite node itself); those
 * resolve to function params / return values and never need hoisting.
 */
function isVisible(
  producer: IRNode,
  consumer: IRNode,
  byId: Map<string, IRNode>,
): boolean {
  const producerScope = producer.parent ?? undefined;
  // Walk the consumer's scope chain up to the root, checking the match before each
  // step (so the consumer's own scope is considered first).
  let scope: string | undefined = consumer.parent ?? undefined;
  if (scope === producerScope) return true;
  while (scope !== undefined) {
    // Stepping out of a composite scope crosses a function boundary: if the
    // producer was not in this composite (or an inner scope already checked), it
    // lives in a different function and is not visible.
    const node = byId.get(scope);
    if (node?.type === 'composite') return false;
    scope = node?.parent ?? undefined;
    if (scope === producerScope) return true;
  }
  // Consumer reached top scope without matching; producer lives elsewhere.
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
      if (
        node.type === 'branch' ||
        node.type === 'loop' ||
        node.type === 'composite'
      ) {
        walk(node.id);
      }
    }
  };
  walk(undefined);
  return out;
}

/**
 * Identifiers that must never be used as a node's variable name: the injected
 * DSL globals and our self-contained runtime helpers. Seeding the used-set with
 * these prevents `const consensus = await consensus(...)` (a TDZ self-shadow) and
 * similar collisions with `agent`/`parallel`/… globals.
 */
const RESERVED_VAR_NAMES = [
  'agent',
  'parallel',
  'pipeline',
  'phase',
  'log',
  'workflow',
  'consensus',
  'args',
  'budget',
  'meta',
];

/** Assign a readable, unique JS identifier to each value-producing node. */
function assignVarNames(order: IRNode[]): Map<string, string> {
  const names = new Map<string, string>();
  const used = new Set<string>(RESERVED_VAR_NAMES);
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
    // A composite also occupies its derived function name so no other node's var
    // (or another composite's function name) can ever collide with it.
    if (node.type === 'composite') used.add(compositeFnName(candidate));
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
    type === 'consensus' ||
    type === 'composite' ||
    type === 'variable'
  );
}

/** Value-producing node types surfaced in the top-level `return { … }`. */
function producesReturn(type: IRNode['type']): boolean {
  return (
    type === 'agent' ||
    type === 'parallel' ||
    type === 'pipeline' ||
    type === 'workflow' ||
    type === 'consensus' ||
    type === 'composite'
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
