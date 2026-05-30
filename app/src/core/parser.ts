import { parse } from '@babel/parser';
import type {
  CallExpression,
  Expression,
  Node as BabelNode,
  ObjectExpression,
  Statement,
} from '@babel/types';
import {
  DATA,
  EXEC,
  type IRAgentSpec,
  type IREdge,
  type IRGraph,
  type IRNode,
  type IRMeta,
  type NodeType,
} from './ir';
import { CTX_OPEN, CTX_CLOSE } from './emitter';
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

  addDataEdge(sourceNodeId: string, targetNodeId: string): void {
    if (sourceNodeId === targetNodeId) return;
    const id = `d_${sourceNodeId}_${targetNodeId}`;
    if (this.edges.some((e) => e.id === id)) return;
    this.edges.push({
      id,
      from: { node: sourceNodeId, port: 'data_out' },
      to: { node: targetNodeId, port: 'data_in' },
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

    return {
      version: 1,
      meta: this.meta,
      nodes: this.nodes,
      edges: this.edges,
      layout: this.layout,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* statement handlers                                                         */
/* -------------------------------------------------------------------------- */

function handleStatement(stmt: Statement, ctx: ParseContext): void {
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
      ctx.addNode(codeblockNode(stmt, ctx), { executable: true });
      return;
    }
  }
}

/** Adds a value-producing call node, binds it, and wires its data edges. */
function finalizeCallNode(
  node: IRNode,
  call: CallExpression,
  _stmt: BabelNode,
  bindName: string | null,
  ctx: ParseContext,
): void {
  if (bindName) node.binding = bindName;
  ctx.addNode(node, { executable: true });
  ctx.bind(bindName, node.id);
  wireDataRefs(node, call, ctx);
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
  if (spec.schema) params.schema = spec.schema;
  if (spec.label) params.label = spec.label;
  if (spec.isolation) params.isolation = spec.isolation;
  if (spec.phase) params.phase = spec.phase;
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

/** Return the `agent(...)` call inside an arrow body, or null. */
function asAgentCall(expr: BabelNode): CallExpression | null {
  const call = unwrapAwaitCall(expr as Expression);
  if (call && call.callee.type === 'Identifier' && call.callee.name === 'agent') {
    return call;
  }
  return null;
}

/** Remove the auto-injected `<!--owf:ctx-->…<!--/owf:ctx-->` data-flow block. */
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
    // `phases` is reconstructed from phase() calls, so it is ignored here.
  }
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
  return {
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
  };
}
