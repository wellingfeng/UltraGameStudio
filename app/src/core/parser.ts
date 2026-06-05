import { parse } from '@babel/parser';
import type {
  CallExpression,
  Expression,
  FunctionDeclaration,
  Node as BabelNode,
  ObjectExpression,
  Statement,
} from '@babel/types';
import {
  DATA,
  EXEC,
  type GatewaySelection,
  type IRAgentSpec,
  type IREdge,
  type IRGraph,
  type IRNode,
  type IRMeta,
  type IRPort,
  type NodeGatewayOverride,
  type NodeType,
} from './ir';
import { CTX_OPEN, CTX_CLOSE } from './emitter';
import { normalizeWorkflowNodeNumbers } from './nodeNumbers';
import { shortId } from '@/lib/id';

/**
 * CONTRACT: parseClaudeScript(src) parses a runnable Claude Code workflow script
 * into an IRGraph. It is the inverse of emitClaudeScript and is tolerant of
 * hand-written scripts.
 *
 * Strategy:
 *  1. Parse `src` with @babel/parser (module mode, top-level await allowed).
 *  2. Walk top-level statements:
 *      - `export const meta = {…}`               → graph meta
 *      - `const NAME = … // @schema NAME`        → meta.schemaDefs (no node)
 *      - `phase('…')`                            → phase node
 *      - `const x = await agent('…', {…})`       → agent node
 *      - `const x = await parallel([()=>…])`     → parallel node (thunk array)
 *      - `const x = await pipeline(items, …)`    → pipeline node (stage callbacks)
 *      - `const x = await workflow('…')`         → workflow node
 *      - `log('…')`                              → log node
 *      - `const x = <expr>`                      → variable node (raw source)
 *      - `if (…) { … }`                          → branch node + nested children
 *      - `while (…) { … }`                       → loop node + nested children
 *      - `return {…}`                            → ignored (return marker)
 *      - anything else                           → codeblock node (verbatim)
 *  3. Wire EXEC edges per scope: the top scope gets `start → … → end` sentinels;
 *     a container (`branch`/`loop`) wires `container → firstChild → … → lastChild`.
 *  4. Wire DATA edges from identifier references (incl. `${var}` interpolation)
 *     that match earlier bindings, or explicit `from:[…]` annotations.
 *  5. Honor `// @node <id>` annotations (on the opening line for blocks, the
 *     trailing line for calls) to reconstruct exact node ids — lossless round-trip.
 *
 * On a fatal parse error the entire source is wrapped in a single codeblock so
 * the canvas still has a renderable graph.
 */
export function parseClaudeScript(src: string): IRGraph {
  let ast;
  try {
    ast = parse(src, {
      sourceType: 'module',
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      plugins: ['typescript'],
    });
  } catch {
    return wrapUnparseable(src);
  }

  const ctx = new ParseContext(src);
  for (const stmt of ast.program.body) {
    handleStatement(stmt, ctx);
  }
  return ctx.finish();
}

/* -------------------------------------------------------------------------- */
/* parse context                                                              */
/* -------------------------------------------------------------------------- */

interface ScopeFrame {
  parentId: string | undefined;
  execSeq: IRNode[];
}

class ParseContext {
  readonly src: string;
  meta: IRMeta = { name: 'untitled', adapter: 'claude-code' };
  nodes: IRNode[] = [];
  edges: IREdge[] = [];
  /** Map of bound variable name → node id, for resolving data references. */
  bindings = new Map<string, string>();
  /**
   * While inside a composite function body, maps each function-parameter name to
   * the composite node + declared input port it represents, so inner references to
   * a parameter reconstruct an input-binding data edge
   * `{ from:{node:composite,port}, to:{node:inner,port:'data_in'} }`.
   */
  paramBindings = new Map<string, { compositeId: string; portId: string }>();
  /** Composite function name (`__composite_<var>`) → composite node id, for call-site matching. */
  compositeByFn = new Map<string, string>();
  layout: Record<string, { x: number; y: number }> = {};
  private col = 0;
  /** Stack of scopes; index 0 is the top scope (parent === undefined). */
  private frames: ScopeFrame[] = [{ parentId: undefined, execSeq: [] }];

  constructor(src: string) {
    this.src = src;
  }

  private get frame(): ScopeFrame {
    return this.frames[this.frames.length - 1];
  }

  /** Reconstructs the original id from a `// @node <id>` annotation, if present. */
  annotatedId(node: BabelNode, fallbackPrefix: string): string {
    const ann = readAnnotation(this.src, node, 'node');
    return ann ?? shortId(fallbackPrefix);
  }

  addNode(node: IRNode, opts: { executable: boolean }): void {
    node.parent = this.frame.parentId;
    this.nodes.push(node);
    this.layout[node.id] = { x: this.col * 240, y: 160 };
    this.col += 1;
    if (opts.executable) this.frame.execSeq.push(node);
  }

  bind(name: string | null, nodeId: string): void {
    if (name) this.bindings.set(name, nodeId);
  }

  /**
   * Append an already-created node (e.g. a composite, defined earlier as a
   * function but sequenced at its call site) to the current scope's exec sequence.
   */
  pushExecNode(node: IRNode): void {
    this.frame.execSeq.push(node);
  }

  pushScope(parentId: string): void {
    this.frames.push({ parentId, execSeq: [] });
  }

  /** Pop a container scope and wire `container → firstChild → … → lastChild`. */
  popScope(): void {
    const frame = this.frames.pop()!;
    let prev = frame.parentId;
    for (const node of frame.execSeq) {
      if (prev) this.addExecEdge(prev, node.id);
      prev = node.id;
    }
  }

  addExecEdge(fromId: string, toId: string): void {
    const id = `e_${fromId}_${toId}`;
    if (this.edges.some((e) => e.id === id)) return;
    this.edges.push({
      id,
      from: { node: fromId, port: 'exec_out' },
      to: { node: toId, port: 'exec_in' },
      kind: EXEC,
    });
  }

  addDataEdge(
    sourceNodeId: string,
    targetNodeId: string,
    fromPort = 'data_out',
    toPort = 'data_in',
  ): void {
    if (sourceNodeId === targetNodeId) return;
    const id = `d_${sourceNodeId}_${targetNodeId}`;
    if (this.edges.some((e) => e.id === id)) return;
    this.edges.push({
      id,
      from: { node: sourceNodeId, port: fromPort },
      to: { node: targetNodeId, port: toPort },
      kind: DATA,
    });
  }

  /** Wire the top scope's `start → … → end` spine and return the final graph. */
  finish(): IRGraph {
    const top = this.frames[0];
    const start: IRNode = { id: 'n_start', type: 'start', label: 'Start', params: {} };
    const end: IRNode = { id: 'n_end', type: 'end', label: 'End', params: {} };
    this.nodes.unshift(start);
    this.nodes.push(end);
    this.layout[start.id] = { x: -240, y: 160 };
    this.layout[end.id] = { x: this.col * 240, y: 160 };

    const spine = [start, ...top.execSeq, end];
    for (let i = 0; i < spine.length - 1; i += 1) {
      this.addExecEdge(spine[i].id, spine[i + 1].id);
    }

    return normalizeWorkflowNodeNumbers({
      version: 1,
      meta: this.meta,
      nodes: this.nodes,
      edges: this.edges,
      layout: this.layout,
    });
  }
}

/* -------------------------------------------------------------------------- */
/* statement handlers                                                         */
/* -------------------------------------------------------------------------- */

function handleStatement(stmt: Statement, ctx: ParseContext): void {
  // Self-contained runtime helpers (emitted with `// @fuc:runtime`, e.g. the
  // `consensus` function) are regenerated by the emitter — skip them so they
  // never become nodes (mirrors how `// @schema` defs are routed away).
  if (readAnnotation(ctx.src, stmt, 'fuc:runtime')) return;

  // export const meta = {...}
  if (
    stmt.type === 'ExportNamedDeclaration' &&
    stmt.declaration?.type === 'VariableDeclaration'
  ) {
    const decl = stmt.declaration.declarations[0];
    if (
      decl?.id.type === 'Identifier' &&
      decl.id.name === 'meta' &&
      decl.init?.type === 'ObjectExpression'
    ) {
      applyMeta(decl.init, ctx);
      return;
    }
    ctx.addNode(codeblockNode(stmt, ctx), { executable: true });
    return;
  }

  // async function __composite_xxx(args) { … } annotated with `// @composite <id>`
  // → composite definition (a local sub-workflow function).
  if (stmt.type === 'FunctionDeclaration') {
    const compositeId = readPrecedingAnnotation(ctx.src, stmt, 'composite');
    if (compositeId) {
      handleCompositeDefinition(stmt, compositeId, ctx);
      return;
    }
    // A function without the `// @composite` trigger → verbatim codeblock.
    ctx.addNode(codeblockNode(stmt, ctx), { executable: true });
    return;
  }

  // if (cond) { ... }  → branch node + nested body
  if (stmt.type === 'IfStatement') {
    const id = ctx.annotatedId(stmt, 'n_branch');
    const condition = sliceSource(ctx.src, stmt.test);
    const node: IRNode = { id, type: 'branch', label: '分支', params: { condition } };
    ctx.addNode(node, { executable: true });
    ctx.pushScope(id);
    handleBlock(stmt.consequent, ctx);
    ctx.popScope();
    return;
  }

  // while (cond) { ... }  → loop node + nested body
  if (stmt.type === 'WhileStatement') {
    const id = ctx.annotatedId(stmt, 'n_loop');
    const condition = sliceSource(ctx.src, stmt.test);
    const node: IRNode = { id, type: 'loop', label: '循环', params: { condition } };
    ctx.addNode(node, { executable: true });
    ctx.pushScope(id);
    handleBlock(stmt.body, ctx);
    ctx.popScope();
    return;
  }

  // const x = await <call>(...)   OR   const x = <literal>   OR   const NAME = {…} // @schema
  if (stmt.type === 'VariableDeclaration') {
    // Schema-definition preamble: route to meta, do not create a node.
    const schemaName = readAnnotation(ctx.src, stmt, 'schema');
    if (schemaName) {
      const init = stmt.declarations[0]?.init;
      ctx.meta.schemaDefs = ctx.meta.schemaDefs ?? {};
      ctx.meta.schemaDefs[schemaName] = init ? sliceSource(ctx.src, init) : '{}';
      return;
    }

    const decl = stmt.declarations[0];
    const name = decl?.id.type === 'Identifier' ? decl.id.name : null;
    const init = decl?.init ?? null;
    const call = unwrapAwaitCall(init);
    if (call) {
      handleCall(call, stmt, name, ctx);
      return;
    }
    if (init && isLiteralish(init)) {
      const node = variableNode(stmt, name, init, ctx);
      if (name) node.binding = name;
      ctx.addNode(node, { executable: false });
      ctx.bind(name, node.id);
      return;
    }
    ctx.addNode(codeblockNode(stmt, ctx), { executable: true });
    return;
  }

  // bare call: phase(...), log(...), agent(...) (no binding)
  if (stmt.type === 'ExpressionStatement') {
    const call = unwrapAwaitCall(stmt.expression);
    if (call) {
      handleCall(call, stmt, null, ctx);
      return;
    }
    ctx.addNode(codeblockNode(stmt, ctx), { executable: true });
    return;
  }

  // return {...} — terminal marker, ignored (the end sentinel covers it).
  if (stmt.type === 'ReturnStatement') return;

  // Everything else → codeblock.
  ctx.addNode(codeblockNode(stmt, ctx), { executable: true });
}

/** Walk a block (or single statement) body, dispatching each inner statement. */
function handleBlock(body: BabelNode, ctx: ParseContext): void {
  if (body.type === 'BlockStatement') {
    for (const s of body.body) handleStatement(s as Statement, ctx);
  } else {
    handleStatement(body as Statement, ctx);
  }
}

function handleCall(
  call: CallExpression,
  stmt: BabelNode,
  bindName: string | null,
  ctx: ParseContext,
): void {
  const callee = call.callee.type === 'Identifier' ? call.callee.name : null;

  switch (callee) {
    case 'phase': {
      const title = firstStringArg(call) ?? 'Phase';
      const node: IRNode = {
        id: ctx.annotatedId(stmt, 'n_phase'),
        type: 'phase',
        label: title,
        params: { title },
      };
      ctx.addNode(node, { executable: true });
      ctx.bind(bindName, node.id);
      return;
    }
    case 'agent': {
      const spec = extractAgentSpec(call);
      const node: IRNode = {
        id: ctx.annotatedId(stmt, 'n_agent'),
        type: 'agent',
        label: deriveLabel(spec.prompt) || 'Agent',
        params: specToParams(spec),
      };
      finalizeCallNode(node, call, stmt, bindName, ctx);
      return;
    }
    case 'parallel': {
      const branches = extractAgentSpecArray(call.arguments[0]);
      const node: IRNode = {
        id: ctx.annotatedId(stmt, 'n_parallel'),
        type: 'parallel',
        label: 'Parallel',
        params: { branches },
      };
      finalizeCallNode(node, call, stmt, bindName, ctx);
      return;
    }
    case 'pipeline': {
      const { items, stages } = extractPipeline(call, ctx);
      const node: IRNode = {
        id: ctx.annotatedId(stmt, 'n_pipeline'),
        type: 'pipeline',
        label: 'Pipeline',
        params: { items, stages },
      };
      finalizeCallNode(node, call, stmt, bindName, ctx);
      return;
    }
    case 'consensus': {
      const voters = extractAgentSpecArray(call.arguments[0]);
      const opts = extractConsensusOpts(call.arguments[1]);
      const node: IRNode = {
        id: ctx.annotatedId(stmt, 'n_consensus'),
        type: 'consensus',
        label: 'Consensus',
        params: { voters, ...opts },
      };
      finalizeCallNode(node, call, stmt, bindName, ctx);
      return;
    }
    case 'workflow': {
      const name = firstStringArg(call) ?? 'sub';
      const node: IRNode = {
        id: ctx.annotatedId(stmt, 'n_workflow'),
        type: 'workflow',
        label: name,
        params: { name },
      };
      finalizeCallNode(node, call, stmt, bindName, ctx);
      return;
    }
    case 'log': {
      const message = firstStringArg(call) ?? '';
      const node: IRNode = {
        id: ctx.annotatedId(stmt, 'n_log'),
        type: 'log',
        label: deriveLabel(message) || 'Log',
        params: { message },
      };
      ctx.addNode(node, { executable: true });
      ctx.bind(bindName, node.id);
      return;
    }
    default: {
      // const x = await __composite_xxx(args) // @node <id> → composite call site.
      if (callee && callee.startsWith('__composite_') && ctx.compositeByFn.has(callee)) {
        handleCompositeCall(call, stmt, callee, bindName, ctx);
        return;
      }
      ctx.addNode(codeblockNode(stmt, ctx), { executable: true });
      return;
    }
  }
}

/** Adds a value-producing call node, binds it, and wires its data edges. */
function finalizeCallNode(
  node: IRNode,
  call: CallExpression,
  stmt: BabelNode,
  bindName: string | null,
  ctx: ParseContext,
): void {
  const gateway = readRouteAnnotation(ctx.src, stmt);
  if (gateway) node.params = { ...node.params, gateway };
  if (bindName) node.binding = bindName;
  ctx.addNode(node, { executable: true });
  ctx.bind(bindName, node.id);
  wireDataRefs(node, call, ctx);
}

/* -------------------------------------------------------------------------- */
/* composite (local async function ↔ encapsulated sub-workflow)               */
/* -------------------------------------------------------------------------- */

/**
 * Reads a `// @<tag> <value>` annotation from the comment line(s) immediately
 * preceding a node's start (the emitter places `// @composite`/`// @ports` on
 * their own lines above `async function …`). Returns the first token after the
 * tag, or null.
 */
function readPrecedingAnnotation(
  src: string,
  node: BabelNode,
  tag: string,
): string | null {
  const tokens = readPrecedingMultiAnnotation(src, node, tag);
  return tokens && tokens.length > 0 ? tokens[0] : null;
}

/** Like {@link readPrecedingAnnotation} but returns all whitespace-separated tokens. */
function readPrecedingMultiAnnotation(
  src: string,
  node: BabelNode,
  tag: string,
): string[] | null {
  const start = node.start ?? 0;
  // Scan up to a handful of lines above the node start for the annotation.
  const re = new RegExp(`// @${escapeRe(tag)}\\s+(.+)$`, 'u');
  let pos = start;
  for (let i = 0; i < 6; i += 1) {
    const lineStart = src.lastIndexOf('\n', pos - 1) + 1;
    const line = src.slice(lineStart, src.indexOf('\n', lineStart) === -1 ? undefined : src.indexOf('\n', lineStart));
    const m = re.exec(line);
    if (m) return m[1].trim().split(/\s+/).filter(Boolean);
    if (lineStart === 0) break;
    pos = lineStart - 1;
    // Stop scanning once we pass a non-comment, non-blank line.
    const trimmed = line.trim();
    if (i > 0 && trimmed && !trimmed.startsWith('//')) break;
  }
  return null;
}

/** Parse the `@ports in=id:label out=id:label …` token list into input/output ports. */
function parsePortsAnnotation(tokens: string[] | null): {
  inputs: IRPort[];
  outputs: IRPort[];
} {
  const inputs: IRPort[] = [];
  const outputs: IRPort[] = [];
  for (const token of tokens ?? []) {
    const eq = token.indexOf('=');
    if (eq < 0) continue;
    const dir = token.slice(0, eq);
    const rest = token.slice(eq + 1);
    const colon = rest.indexOf(':');
    const id = colon < 0 ? rest : rest.slice(0, colon);
    const label = colon < 0 ? undefined : rest.slice(colon + 1).replace(/_/g, ' ');
    if (!id) continue;
    if (dir === 'in') inputs.push({ id, direction: 'in', kind: DATA, label });
    else if (dir === 'out') outputs.push({ id, direction: 'out', kind: DATA, label });
  }
  return { inputs, outputs };
}

/**
 * Handle a composite *definition*: an `async function __composite_<var>(params)`
 * annotated `// @composite <id>` / `// @ports …`. Creates the composite node,
 * registers its function name for call-site matching, registers each param as a
 * binding to its declared input port, walks the body in a pushed scope (children
 * inherit parent === composite id), and reconstructs output-binding edges from the
 * `return` (using `@return`/`@returns`).
 */
function handleCompositeDefinition(
  fn: FunctionDeclaration,
  compositeId: string,
  ctx: ParseContext,
): void {
  const fnName = fn.id?.name ?? '';
  const { inputs, outputs } = parsePortsAnnotation(
    readPrecedingMultiAnnotation(ctx.src, fn, 'ports'),
  );

  const node: IRNode = {
    id: compositeId,
    type: 'composite',
    label: 'Composite',
    params: { inputs, outputs },
  };
  // Add to the graph but NOT to the current exec sequence: in the emitted script
  // the function declaration precedes the call site, but in the IR exec spine the
  // composite sits at its *call-site* position. The call site (handled later)
  // appends it to the exec sequence at the right place.
  ctx.addNode(node, { executable: false });
  if (fnName) ctx.compositeByFn.set(fnName, compositeId);

  // Map each function parameter (in order) to its declared input port, so inner
  // references to the param become input-binding edges.
  const paramNames = fn.params.map((p) =>
    p.type === 'Identifier' ? p.name : null,
  );
  const savedParamBindings = ctx.paramBindings;
  ctx.paramBindings = new Map(savedParamBindings);
  paramNames.forEach((name, i) => {
    const port = inputs[i];
    if (name && port) {
      ctx.paramBindings.set(name, { compositeId, portId: port.id });
    }
  });

  // Walk the body in the composite's scope, capturing the return statement.
  ctx.pushScope(compositeId);
  let returnStmt: BabelNode | null = null;
  for (const s of fn.body.body) {
    if (s.type === 'ReturnStatement') {
      returnStmt = s;
      continue; // handled below as output bindings, not as a node
    }
    handleStatement(s as Statement, ctx);
  }
  // Reconstruct output-binding edges from the return expression + annotations.
  if (returnStmt) wireCompositeReturn(node, returnStmt, outputs, ctx);
  ctx.popScope();

  ctx.paramBindings = savedParamBindings;
}

/**
 * Reconstruct output-binding edges from a composite's `return`:
 *   - single output: `return <var> // @return <portId>` → edge inner→{composite,port}
 *   - multi output:  `return { portId: <var>, … } // @returns p1,p2`
 */
function wireCompositeReturn(
  composite: IRNode,
  returnStmt: BabelNode,
  outputs: IRPort[],
  ctx: ParseContext,
): void {
  const arg = (returnStmt as { argument?: Expression | null }).argument;
  if (!arg) return;

  const single = readAnnotation(ctx.src, returnStmt, 'return');
  if (single && arg.type === 'Identifier') {
    const sourceId = ctx.bindings.get(arg.name);
    if (sourceId) ctx.addDataEdge(sourceId, composite.id, 'data_out', single);
    return;
  }

  if (arg.type === 'ObjectExpression') {
    for (const prop of arg.properties) {
      if (
        prop.type !== 'ObjectProperty' ||
        prop.key.type !== 'Identifier' ||
        prop.value.type !== 'Identifier'
      ) {
        continue;
      }
      const portId = prop.key.name;
      const sourceId = ctx.bindings.get(prop.value.name);
      if (sourceId) ctx.addDataEdge(sourceId, composite.id, 'data_out', portId);
    }
    return;
  }

  // Fallback: a single declared output with a non-identifier/no-annotation return.
  if (outputs.length === 1 && arg.type === 'Identifier') {
    const sourceId = ctx.bindings.get(arg.name);
    if (sourceId) ctx.addDataEdge(sourceId, composite.id, 'data_out', outputs[0].id);
  }
}

/**
 * Handle a composite *call site*: `const x = await __composite_<var>(args) // @node
 * <id>`. Looks up the previously-registered composite node, binds the call var,
 * wires exec, and reconstructs input-binding edges from the call arguments
 * (positional, by declared input-port order). Downstream references to the call
 * var reconstruct output-binding edges via the normal identifier-scan mechanism.
 */
function handleCompositeCall(
  call: CallExpression,
  stmt: BabelNode,
  fnName: string,
  bindName: string | null,
  ctx: ParseContext,
): void {
  const compositeId = ctx.compositeByFn.get(fnName)!;
  const node = ctx.nodes.find((n) => n.id === compositeId);
  if (!node) {
    ctx.addNode(codeblockNode(stmt, ctx), { executable: true });
    return;
  }

  // The annotated `// @node` id should match the definition's composite id; we
  // keep the definition node as the single instance and just bind/wire it here.
  if (bindName) node.binding = bindName;
  ctx.bind(bindName, compositeId);
  // Sequence the composite into the exec spine at the call-site position.
  ctx.pushExecNode(node);

  // Input-binding edges: arg[i] (an outer producer or an enclosing composite's
  // parameter) → {composite, inputPort[i]}.
  const inputs = (node.params.inputs as IRPort[]) ?? [];
  call.arguments.forEach((arg, i) => {
    const port = inputs[i];
    if (!port || !arg || arg.type !== 'Identifier') return;
    // An enclosing composite's parameter feeds the nested composite via that
    // composite's output-side port (its declared input port from the outer view).
    const param = ctx.paramBindings.get(arg.name);
    if (param) {
      ctx.addDataEdge(param.compositeId, compositeId, param.portId, port.id);
      return;
    }
    const sourceId = ctx.bindings.get(arg.name);
    if (sourceId) ctx.addDataEdge(sourceId, compositeId, 'data_out', port.id);
  });
}

/* -------------------------------------------------------------------------- */
/* agent / parallel / pipeline extraction                                     */
/* -------------------------------------------------------------------------- */

/** Extract an IRAgentSpec from an `agent('…', {…})` call. */
function extractAgentSpec(call: CallExpression): IRAgentSpec {
  const raw = firstStringArg(call) ?? '';
  const spec: IRAgentSpec = { prompt: stripCtxBlock(raw) };
  const opts = call.arguments[1];
  if (opts && opts.type === 'ObjectExpression') {
    for (const prop of opts.properties) {
      if (prop.type !== 'ObjectProperty' || prop.key.type !== 'Identifier') continue;
      const key = prop.key.name;
      if (key === 'from') continue;
      if (key === 'gateway' && prop.value.type === 'ObjectExpression') {
        spec.gateway = readGatewayOverrideObject(prop.value);
        continue;
      }
      const value = readOptValue(prop.value);
      if (value == null) continue;
      switch (key) {
        case 'agentType':
          spec.agentType = value;
          break;
        case 'model':
          spec.model = value;
          break;
        case 'schema':
          spec.schema = value;
          break;
        case 'label':
          spec.label = value;
          break;
        case 'phase':
          spec.phase = value;
          break;
        case 'isolation':
          if (value === 'worktree') spec.isolation = 'worktree';
          break;
        case 'contextPolicy':
          if (value === 'tail' || value === 'full') spec.contextPolicy = value;
          break;
        // legacy: `agent:` was the old key for the sub-agent type.
        case 'agent':
          if (!spec.agentType) spec.agentType = value;
          break;
      }
    }
  }
  return spec;
}

/** Read a string/identifier/number/boolean option value as a string. */
function readOptValue(node: BabelNode): string | null {
  if (node.type === 'StringLiteral') return node.value;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'NumericLiteral' || node.type === 'BooleanLiteral') {
    return String(node.value);
  }
  return null;
}

/** Drop undefined fields from a spec into a node params record. */
function specToParams(spec: IRAgentSpec): Record<string, unknown> {
  const params: Record<string, unknown> = { prompt: spec.prompt };
  if (spec.agentType) params.agentType = spec.agentType;
  if (spec.model) params.model = spec.model;
  if (spec.gateway) params.gateway = spec.gateway;
  if (spec.schema) params.schema = spec.schema;
  if (spec.label) params.label = spec.label;
  if (spec.isolation) params.isolation = spec.isolation;
  if (spec.phase) params.phase = spec.phase;
  if (spec.contextPolicy) params.contextPolicy = spec.contextPolicy;
  return params;
}

/**
 * Extract `parallel` branches from a thunk array `[() => agent(...), …]`.
 * Tolerates the legacy `string[]` form (each string → `{ prompt }`).
 */
function extractAgentSpecArray(arg: BabelNode | undefined): IRAgentSpec[] {
  if (!arg || arg.type !== 'ArrayExpression') return [];
  const specs: IRAgentSpec[] = [];
  for (const el of arg.elements) {
    if (!el) continue;
    if (el.type === 'ArrowFunctionExpression') {
      const call = asAgentCall(el.body);
      if (call) specs.push(extractAgentSpec(call));
    } else if (el.type === 'StringLiteral') {
      specs.push({ prompt: el.value });
    }
  }
  return specs;
}

/** Extract `pipeline(items, stage, …)` into an items expression + stage specs. */
function extractPipeline(
  call: CallExpression,
  ctx: ParseContext,
): { items: string; stages: IRAgentSpec[] } {
  const arg0 = call.arguments[0];
  // Legacy `pipeline(['a','b'])` (single string array) → stages, items='args'.
  if (arg0 && arg0.type === 'ArrayExpression' && call.arguments.length === 1) {
    const stages: IRAgentSpec[] = [];
    for (const el of arg0.elements) {
      if (el && el.type === 'StringLiteral') stages.push({ prompt: el.value });
    }
    return { items: 'args', stages };
  }
  const items = arg0 ? sliceSource(ctx.src, arg0) : 'args';
  const stages: IRAgentSpec[] = [];
  for (let i = 1; i < call.arguments.length; i += 1) {
    const arg = call.arguments[i];
    if (arg && arg.type === 'ArrowFunctionExpression') {
      const c = asAgentCall(arg.body);
      if (c) stages.push(extractAgentSpec(c));
    }
  }
  return { items, stages };
}

/** Extract a `consensus` node's options object into params (defaults strategy). */
function extractConsensusOpts(arg: BabelNode | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = { strategy: 'multi-lens' };
  if (!arg || arg.type !== 'ObjectExpression') return out;
  for (const prop of arg.properties) {
    if (prop.type !== 'ObjectProperty' || prop.key.type !== 'Identifier') continue;
    const value = readOptValue(prop.value);
    if (value == null) continue;
    switch (prop.key.name) {
      case 'strategy':
        out.strategy = value;
        break;
      case 'samples':
        out.samples = Number(value);
        break;
      case 'quorum':
        out.quorum = Number(value);
        break;
      case 'schema':
        out.schema = value;
        break;
    }
  }
  return out;
}

/** Return the `agent(...)` call inside an arrow body, or null. */
function asAgentCall(expr: BabelNode): CallExpression | null {
  const call = unwrapAwaitCall(expr as Expression);
  if (call && call.callee.type === 'Identifier' && call.callee.name === 'agent') {
    return call;
  }
  return null;
}

/** Remove the auto-injected `<!--fuc:ctx-->…<!--/fuc:ctx-->` data-flow block. */
function stripCtxBlock(prompt: string): string {
  const i = prompt.indexOf(CTX_OPEN);
  if (i === -1) return prompt;
  const before = prompt.slice(0, i).replace(/\n+$/, '');
  // Defensive: also drop a trailing close marker if it somehow leaked.
  return before.replace(new RegExp(`${escapeRe(CTX_CLOSE)}\\s*$`), '');
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* -------------------------------------------------------------------------- */
/* meta                                                                       */
/* -------------------------------------------------------------------------- */

function applyMeta(obj: ObjectExpression, ctx: ParseContext): void {
  for (const prop of obj.properties) {
    if (prop.type !== 'ObjectProperty' || prop.key.type !== 'Identifier') continue;
    const key = prop.key.name;
    if (key === 'name' && isStringLiteral(prop.value)) ctx.meta.name = prop.value.value;
    else if (key === 'description' && isStringLiteral(prop.value))
      ctx.meta.description = prop.value.value;
    else if (key === 'adapter' && isStringLiteral(prop.value))
      ctx.meta.adapter = prop.value.value;
    else if (key === 'gateway' && prop.value.type === 'ObjectExpression') {
      const defaults = readGatewayDefaults(prop.value);
      if (defaults) {
        ctx.meta.gateway = { ...(ctx.meta.gateway ?? {}), defaults };
        if (!ctx.meta.adapter && defaults.adapter) ctx.meta.adapter = defaults.adapter;
      }
    }
    // `phases` is reconstructed from phase() calls, so it is ignored here.
  }
}

function readGatewayDefaults(obj: ObjectExpression): GatewaySelection | null {
  for (const prop of obj.properties) {
    if (
      prop.type === 'ObjectProperty' &&
      prop.key.type === 'Identifier' &&
      prop.key.name === 'defaults' &&
      prop.value.type === 'ObjectExpression'
    ) {
      const selection = readGatewaySelectionObject(prop.value);
      return selection.modelClass ? selection : null;
    }
  }
  return null;
}

function readGatewaySelectionObject(obj: ObjectExpression): GatewaySelection {
  const out: GatewaySelection = {
    adapter: 'claude-code',
    modelClass: 'sonnet',
  };
  for (const prop of obj.properties) {
    if (prop.type !== 'ObjectProperty' || prop.key.type !== 'Identifier') continue;
    const value = readOptValue(prop.value);
    if (!value) continue;
    if (prop.key.name === 'adapter') out.adapter = value;
    else if (prop.key.name === 'modelClass') out.modelClass = value;
    else if (prop.key.name === 'modelOverride') out.modelOverride = value;
    else if (prop.key.name === 'providerId') out.providerId = value;
    else if (prop.key.name === 'channelId') out.channelId = value;
  }
  return out;
}

function readGatewayOverrideObject(obj: ObjectExpression): NodeGatewayOverride {
  const out: NodeGatewayOverride = {};
  for (const prop of obj.properties) {
    if (prop.type !== 'ObjectProperty' || prop.key.type !== 'Identifier') continue;
    const value = readOptValue(prop.value);
    if (!value) continue;
    if (prop.key.name === 'modelClass') out.modelClass = value;
    else if (prop.key.name === 'providerId') out.providerId = value;
    else if (prop.key.name === 'channelId') out.channelId = value;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* data flow                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Discovers data dependencies for a call node by:
 *  - reading an explicit `from: ['<sourceNodeId>', …]` option (hand-written), and
 *  - scanning identifier references (incl. `${var}` interpolation) that match
 *    earlier bindings.
 */
function wireDataRefs(node: IRNode, call: CallExpression, ctx: ParseContext): void {
  const opts = call.arguments.find((a) => a.type === 'ObjectExpression') as
    | ObjectExpression
    | undefined;
  if (opts) {
    for (const prop of opts.properties) {
      if (
        prop.type === 'ObjectProperty' &&
        prop.key.type === 'Identifier' &&
        prop.key.name === 'from' &&
        prop.value.type === 'ArrayExpression'
      ) {
        for (const el of prop.value.elements) {
          if (el && el.type === 'StringLiteral') ctx.addDataEdge(el.value, node.id);
        }
      }
    }
  }

  for (const name of collectIdentifiers(call.arguments)) {
    // A reference to a composite function parameter inside the body reconstructs
    // an input-binding edge from the composite's declared input port.
    const param = ctx.paramBindings.get(name);
    if (param) {
      ctx.addDataEdge(param.compositeId, node.id, param.portId, 'data_in');
      continue;
    }
    const sourceId = ctx.bindings.get(name);
    if (sourceId) ctx.addDataEdge(sourceId, node.id);
  }
}

/** Collects identifier names referenced anywhere within the given AST nodes. */
function collectIdentifiers(nodes: BabelNode[]): Set<string> {
  const found = new Set<string>();
  const seen = new Set<BabelNode>();
  const visit = (n: BabelNode | null | undefined): void => {
    if (!n || typeof n !== 'object' || seen.has(n)) return;
    seen.add(n);
    if (n.type === 'Identifier') found.add(n.name);
    for (const key of Object.keys(n)) {
      if (key === 'loc' || key === 'start' || key === 'end' || key === 'range') continue;
      const child = (n as unknown as Record<string, unknown>)[key];
      if (Array.isArray(child)) {
        for (const c of child) visit(c as BabelNode);
      } else if (child && typeof child === 'object' && 'type' in child) {
        visit(child as BabelNode);
      }
    }
  };
  for (const n of nodes) visit(n);
  return found;
}

/* -------------------------------------------------------------------------- */
/* node builders                                                              */
/* -------------------------------------------------------------------------- */

function codeblockNode(stmt: BabelNode, ctx: ParseContext): IRNode {
  const code = sliceSource(ctx.src, stmt).replace(/\s*\/\/ @node \S+\s*$/, '');
  return {
    id: ctx.annotatedId(stmt, 'n_code'),
    type: 'codeblock',
    label: 'Code',
    params: { code },
  };
}

function variableNode(
  stmt: BabelNode,
  name: string | null,
  init: Expression,
  ctx: ParseContext,
): IRNode {
  // Store the verbatim initializer source; the emitter re-emits it as-is so
  // arrays/objects/refs survive a round-trip (raw=true marks the convention).
  return {
    id: ctx.annotatedId(stmt, 'n_var'),
    type: 'variable' as NodeType,
    label: name ?? 'variable',
    params: { name, value: sliceSource(ctx.src, init), raw: true },
  };
}

/* -------------------------------------------------------------------------- */
/* AST utilities                                                              */
/* -------------------------------------------------------------------------- */

function unwrapAwaitCall(expr: Expression | null | undefined): CallExpression | null {
  if (!expr) return null;
  if (expr.type === 'AwaitExpression') {
    return expr.argument.type === 'CallExpression' ? expr.argument : null;
  }
  if (expr.type === 'CallExpression') return expr;
  return null;
}

function firstStringArg(call: CallExpression): string | null {
  const a = call.arguments[0];
  if (a && (a.type === 'StringLiteral' || a.type === 'TemplateLiteral')) {
    return stringOf(a);
  }
  return null;
}

function stringOf(node: BabelNode): string | null {
  if (node.type === 'StringLiteral') return node.value;
  if (node.type === 'TemplateLiteral') {
    // Reconstruct the literal text, marking interpolations with ${…}.
    let out = '';
    for (let i = 0; i < node.quasis.length; i += 1) {
      out += node.quasis[i].value.cooked ?? node.quasis[i].value.raw;
      if (i < node.expressions.length) out += '${…}';
    }
    return out;
  }
  return null;
}

function isStringLiteral(
  node: BabelNode,
): node is Extract<BabelNode, { type: 'StringLiteral' }> {
  return node.type === 'StringLiteral';
}

function isLiteralish(expr: Expression): boolean {
  return (
    expr.type === 'StringLiteral' ||
    expr.type === 'NumericLiteral' ||
    expr.type === 'BooleanLiteral' ||
    expr.type === 'ArrayExpression' ||
    expr.type === 'ObjectExpression' ||
    expr.type === 'NullLiteral'
  );
}

function deriveLabel(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > 40 ? `${oneLine.slice(0, 37)}…` : oneLine;
}

/**
 * Reads a `// @<tag> <value>` annotation from the line containing the AST node's
 * end (calls) or start (block statements). Returns the value or null.
 */
function readAnnotation(src: string, node: BabelNode, tag: string): string | null {
  const re = new RegExp(`// @${tag} (\\S+)`);
  const lineAt = (pos: number): string => {
    const lineStart = src.lastIndexOf('\n', pos - 1) + 1;
    const lineEnd = src.indexOf('\n', pos);
    return src.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
  };
  const endLine = lineAt(node.end ?? 0);
  const startLine = lineAt(node.start ?? 0);
  for (const line of [endLine, startLine]) {
    const m = re.exec(line);
    if (m) return m[1];
  }
  return null;
}

function readRouteAnnotation(
  src: string,
  node: BabelNode,
): NodeGatewayOverride | null {
  const lineAt = (pos: number): string => {
    const lineStart = src.lastIndexOf('\n', pos - 1) + 1;
    const lineEnd = src.indexOf('\n', pos);
    return src.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
  };
  const lines = [lineAt(node.end ?? 0), lineAt(node.start ?? 0)];
  for (const line of lines) {
    const match = /\/\/ @route\s+(.+)$/u.exec(line);
    if (!match) continue;
    const out: NodeGatewayOverride = {};
    for (const token of match[1].trim().split(/\s+/)) {
      const [rawKey, ...valueParts] = token.split('=');
      const value = valueParts.join('=').trim();
      if (!value) continue;
      if (rawKey === 'provider' || rawKey === 'providerId') {
        out.providerId = value;
      } else if (rawKey === 'channel' || rawKey === 'channelId') {
        out.channelId = value;
      } else if (rawKey === 'modelClass') {
        out.modelClass = value;
      }
    }
    return Object.keys(out).length > 0 ? out : null;
  }
  return null;
}

function sliceSource(src: string, node: BabelNode): string {
  if (node.start == null || node.end == null) return '';
  return src.slice(node.start, node.end);
}

function wrapUnparseable(src: string): IRGraph {
  const code: IRNode = {
    id: shortId('n_code'),
    type: 'codeblock',
    label: 'Unparsed script',
    params: { code: src },
  };
  const start: IRNode = { id: 'n_start', type: 'start', label: 'Start', params: {} };
  const end: IRNode = { id: 'n_end', type: 'end', label: 'End', params: {} };
  return normalizeWorkflowNodeNumbers({
    version: 1,
    meta: { name: 'unparsed', adapter: 'claude-code' },
    nodes: [start, code, end],
    edges: [
      {
        id: 'e_start_code',
        from: { node: start.id, port: 'exec_out' },
        to: { node: code.id, port: 'exec_in' },
        kind: EXEC,
      },
      {
        id: 'e_code_end',
        from: { node: code.id, port: 'exec_out' },
        to: { node: end.id, port: 'exec_in' },
        kind: EXEC,
      },
    ],
    layout: {
      [start.id]: { x: 0, y: 160 },
      [code.id]: { x: 240, y: 160 },
      [end.id]: { x: 480, y: 160 },
    },
  });
}
