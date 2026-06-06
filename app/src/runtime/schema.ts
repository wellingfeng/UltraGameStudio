/**
 * CONTRACT: schema as a *runtime behaviour guarantee* for the IR DAG interpreter.
 *
 * The emitter/parser already carry `schema` at the syntax level: an agent spec's
 * `schema: NAME` is a bare identifier whose body lives in `meta.schemaDefs[NAME]`
 * as a JS object/array *literal source string* (e.g. `"{ real: true, confidence: 0 }"`).
 * But the headless run engine (`runtime/`) never enforced it. This module supplies
 * the missing enforcement primitives — pure, host-agnostic, no React / Zustand /
 * Tauri, no `window` / `document` / `localStorage`. It only depends on
 * `@babel/parser` (already installed, used by `core/parser.ts`) to turn the
 * literal-source string into a real JS value WITHOUT `eval`.
 *
 * The pieces:
 * - `resolveSchemaShape`  : NAME + meta → { name, source, shape } (shape = parsed value).
 * - `describeSchema`      : NAME + source → a Chinese instruction telling the model
 *                           to output ONLY a JSON matching that structure.
 * - `extractJson`         : tolerant JSON extraction from free-form model output.
 * - `validateAgainstSchema`: JSON-Schema-lite OR example-object compatibility check.
 * - `schemaRetryFeedback` : Chinese feedback that asks the model to try again.
 *
 * `node-dispatch.ts` wires these into `runAgentWithInteraction` so a node that
 * declares a schema actually appends the instruction, extracts the JSON, validates
 * it, and (bounded) retries with feedback. A still-failing schema is NON-FATAL:
 * we adopt the best-effort output rather than crashing the run.
 */
import { parseExpression } from '@babel/parser';
import type {
  ArrayExpression,
  Expression,
  ObjectExpression,
} from '@babel/types';

/** A resolved schema: the referenced name, its literal source, and the parsed value (if literal). */
export interface ResolvedSchema {
  name: string;
  source: string;
  /** The parsed JS value, or `undefined` when the source isn't a pure literal. */
  shape: unknown;
}

/**
 * Look up `meta.schemaDefs[name]` and parse its literal-source string into a
 * pure JS value. Only literal nodes are accepted (object / array / string /
 * number / boolean / null, recursively + unary +/- on numbers). On any
 * non-literal node we return the entry with `shape: undefined` (still usable as
 * an instruction target) instead of throwing.
 */
export function resolveSchemaShape(
  name: string | undefined,
  meta: { schemaDefs?: Record<string, string> } | undefined,
): ResolvedSchema | undefined {
  if (!name || typeof name !== 'string') return undefined;
  const source = meta?.schemaDefs?.[name];
  if (typeof source !== 'string') return undefined;
  return { name, source, shape: evalLiteralSource(source) };
}

/**
 * Parse a JS object/array literal *source string* into a pure value. Returns
 * `undefined` (never throws) when the source can't be parsed or contains any
 * non-literal node (identifiers, calls, template strings, spreads, …).
 */
function evalLiteralSource(src: string): unknown {
  if (typeof src !== 'string' || !src.trim()) return undefined;
  let ast: Expression;
  try {
    ast = parseExpression(src, { plugins: [], errorRecovery: false });
  } catch {
    return undefined;
  }
  try {
    return literalToValue(ast);
  } catch {
    // Non-literal node encountered — bail to `undefined` (still allow source use).
    return undefined;
  }
}

/** Thrown internally when a non-literal AST node is hit; caught in evalLiteralSource. */
const NON_LITERAL = Symbol('non-literal');

function literalToValue(node: Expression): unknown {
  switch (node.type) {
    case 'StringLiteral':
    case 'BooleanLiteral':
    case 'NumericLiteral':
      return node.value;
    case 'NullLiteral':
      return null;
    case 'UnaryExpression': {
      // Allow only +/- in front of a numeric literal.
      if (
        (node.operator === '-' || node.operator === '+') &&
        node.argument.type === 'NumericLiteral'
      ) {
        const n = node.argument.value;
        return node.operator === '-' ? -n : n;
      }
      throw NON_LITERAL;
    }
    case 'ArrayExpression':
      return arrayToValue(node);
    case 'ObjectExpression':
      return objectToValue(node);
    default:
      throw NON_LITERAL;
  }
}

function arrayToValue(node: ArrayExpression): unknown[] {
  const out: unknown[] = [];
  for (const el of node.elements) {
    if (el === null) {
      out.push(undefined); // hole
      continue;
    }
    if (el.type === 'SpreadElement') throw NON_LITERAL;
    out.push(literalToValue(el as Expression));
  }
  return out;
}

function objectToValue(node: ObjectExpression): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const prop of node.properties) {
    if (prop.type !== 'ObjectProperty' || prop.computed) throw NON_LITERAL;
    const key = prop.key;
    let name: string;
    if (key.type === 'Identifier') name = key.name;
    else if (key.type === 'StringLiteral') name = key.value;
    else if (key.type === 'NumericLiteral') name = String(key.value);
    else throw NON_LITERAL;
    out[name] = literalToValue(prop.value as Expression);
  }
  return out;
}

/**
 * Build a Chinese instruction appended to a node's prompt that forces the model
 * to end its turn with a single JSON matching the schema structure. The literal
 * `source` is shown verbatim as the target structure so weaker models can mirror
 * it directly.
 */
export function describeSchema(name: string, source: string): string {
  return `---
输出结构要求（重要）：
你这一步的最终回答必须是、且只能是一个满足下面 ${name} 结构的 JSON 对象/数组。可以把它放在 \`\`\`json 代码块里。
不要输出除这个 JSON 之外的任何解释性文字、前言或结尾。

目标结构 ${name}：
${source}

要求：
- 严格遵循上面的结构（字段名、类型、必填项）。
- 只输出一个合法 JSON，不要附加注释或多余文字。
- 如果某些值需要你推断，就给出合理取值，但结构必须完整。`;
}

/**
 * Tolerantly extract a JSON value from free-form model output. Strategy:
 *   1. a ```json … ``` (or bare ``` … ```) fenced block that parses as JSON;
 *   2. the first *balanced* top-level `{…}` or `[…]` span in the body.
 * Returns the parsed value + a normalized `JSON.stringify` string, or null.
 */
export function extractJson(text: string): { value: unknown; json: string } | null {
  if (typeof text !== 'string' || !text.trim()) return null;

  // (1) Fenced code blocks — prefer ```json, then any ``` fence.
  for (const candidate of fencedBlocks(text)) {
    const parsed = tryParse(candidate);
    if (parsed) return parsed;
  }

  // (2) First balanced {…} / […] span in the raw text.
  const span = firstBalancedSpan(text);
  if (span) {
    const parsed = tryParse(span);
    if (parsed) return parsed;
  }
  return null;
}

function tryParse(src: string): { value: unknown; json: string } | null {
  const trimmed = src.trim();
  if (!trimmed) return null;
  try {
    const value = sanitizeParsed(JSON.parse(trimmed) as unknown);
    return { value, json: JSON.stringify(value) };
  } catch {
    return null;
  }
}

/**
 * Recursively strip prototype-pollution keys (`__proto__`, `constructor`,
 * `prototype`) from a freshly `JSON.parse`d value. Model output is untrusted
 * data and the parsed object is later spread into `node.params`
 * (dynamicHarness.normalizeHarnessSpec), so a crafted `{"__proto__": …}` could
 * otherwise reach an object spread. Rebuilds plain objects with only own,
 * non-dangerous keys; arrays/primitives pass through (mapped for nested
 * objects). Mirrors the same defensive posture as the workflow-script literal
 * evaluator's reserved-key rejection.
 */
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function sanitizeParsed(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeParsed);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (DANGEROUS_KEYS.has(key)) continue;
      out[key] = sanitizeParsed(val);
    }
    return out;
  }
  return value;
}

/** Yield the inner content of every ```…``` fenced block, ```json first. */
function fencedBlocks(text: string): string[] {
  const blocks: { lang: string; body: string }[] = [];
  const re = /```([a-zA-Z0-9_-]*)\s*\n?([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    blocks.push({ lang: (m[1] || '').toLowerCase(), body: m[2] ?? '' });
  }
  // ```json blocks first, then the rest in source order.
  return [
    ...blocks.filter((b) => b.lang === 'json').map((b) => b.body),
    ...blocks.filter((b) => b.lang !== 'json').map((b) => b.body),
  ];
}

/**
 * Return the first balanced top-level `{…}` or `[…]` span (string-aware), or
 * null. Scans for whichever of `{`/`[` appears first.
 */
function firstBalancedSpan(text: string): string | null {
  let start = -1;
  let open = '';
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '{' || text[i] === '[') {
      start = i;
      open = text[i];
      break;
    }
  }
  if (start === -1) return null;
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Result of validating a value against a schema shape. */
export interface SchemaValidation {
  ok: boolean;
  problems: string[];
}

/**
 * Validate `value` against `shape`. Two modes:
 *
 *   - JSON-Schema-lite: when `shape` looks like a JSON Schema (an object with a
 *     string `type`, or with `properties` / `required`). Supports `type`,
 *     `required`, `properties` (per-field type), `enum`, and array `items` type.
 *   - Example-object: otherwise `shape` is treated as a *sample* — `value` must
 *     be an object containing every key the sample has, with loosely compatible
 *     base types (string / number / boolean / object / array).
 *
 * `shape === undefined` → `{ ok: true, problems: [] }` (can't validate → allow).
 */
export function validateAgainstSchema(value: unknown, shape: unknown): SchemaValidation {
  if (shape === undefined) return { ok: true, problems: [] };

  if (looksLikeJsonSchema(shape)) {
    const problems: string[] = [];
    validateJsonSchema(value, shape as Record<string, unknown>, '根', problems);
    return { ok: problems.length === 0, problems };
  }

  // Example-object mode.
  const problems: string[] = [];
  validateExample(value, shape, '根', problems);
  return { ok: problems.length === 0, problems };
}

/** A shape is JSON-Schema-like when it has a string `type` or `properties`/`required`. */
function looksLikeJsonSchema(shape: unknown): boolean {
  if (!isPlainObject(shape)) return false;
  if (typeof (shape as Record<string, unknown>).type === 'string') return true;
  if ('properties' in shape || 'required' in shape) return true;
  return false;
}

function validateJsonSchema(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
  problems: string[],
): void {
  const type = schema.type;
  if (typeof type === 'string' && !matchesJsonType(value, type)) {
    problems.push(`${path}：期望类型 ${type}，实际为 ${baseType(value)}`);
    // If the top-level type is wrong, deeper checks are unreliable — stop here.
    return;
  }

  // enum constraint.
  if (Array.isArray(schema.enum)) {
    const allowed = schema.enum as unknown[];
    if (!allowed.some((a) => deepEqualPrimitive(a, value))) {
      problems.push(`${path}：取值必须是 ${JSON.stringify(allowed)} 之一`);
    }
  }

  // Object properties + required.
  if (type === 'object' || isPlainObject(schema.properties) || Array.isArray(schema.required)) {
    if (!isPlainObject(value)) {
      problems.push(`${path}：期望对象，实际为 ${baseType(value)}`);
      return;
    }
    const obj = value as Record<string, unknown>;
    const required = Array.isArray(schema.required) ? (schema.required as unknown[]) : [];
    for (const key of required) {
      if (typeof key === 'string' && !(key in obj)) {
        problems.push(`${path}：缺少必填字段 "${key}"`);
      }
    }
    const props = isPlainObject(schema.properties)
      ? (schema.properties as Record<string, unknown>)
      : {};
    for (const [key, propSchema] of Object.entries(props)) {
      if (key in obj && isPlainObject(propSchema)) {
        validateJsonSchema(obj[key], propSchema as Record<string, unknown>, `${path}.${key}`, problems);
      }
    }
  }

  // Array items.
  if (type === 'array' || 'items' in schema) {
    if (!Array.isArray(value)) {
      problems.push(`${path}：期望数组，实际为 ${baseType(value)}`);
      return;
    }
    if (isPlainObject(schema.items)) {
      const itemSchema = schema.items as Record<string, unknown>;
      value.forEach((el, i) => validateJsonSchema(el, itemSchema, `${path}[${i}]`, problems));
    }
  }
}

/** A JSON-Schema `type` keyword matches a runtime value. */
function matchesJsonType(value: unknown, type: string): boolean {
  switch (type) {
    case 'object':
      return isPlainObject(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return true; // unknown type keyword → don't fail on it
  }
}

/**
 * Example-object validation: `value` must contain all of `example`'s keys with
 * loosely compatible base types. Arrays only check that `value` is an array (and
 * recurse into the first sample element if present). Primitives only check base
 * type compatibility.
 */
function validateExample(
  value: unknown,
  example: unknown,
  path: string,
  problems: string[],
): void {
  if (isPlainObject(example)) {
    if (!isPlainObject(value)) {
      problems.push(`${path}：期望对象，实际为 ${baseType(value)}`);
      return;
    }
    const obj = value as Record<string, unknown>;
    for (const [key, sample] of Object.entries(example)) {
      if (!(key in obj)) {
        problems.push(`${path}：缺少字段 "${key}"`);
        continue;
      }
      validateExample(obj[key], sample, `${path}.${key}`, problems);
    }
    return;
  }

  if (Array.isArray(example)) {
    if (!Array.isArray(value)) {
      problems.push(`${path}：期望数组，实际为 ${baseType(value)}`);
      return;
    }
    if (example.length > 0 && value.length > 0) {
      // Loosely check each provided element against the first sample element.
      value.forEach((el, i) => validateExample(el, example[0], `${path}[${i}]`, problems));
    }
    return;
  }

  // Primitive sample → base-type compatibility (loose).
  const want = baseType(example);
  const got = baseType(value);
  if (want !== got) {
    problems.push(`${path}：期望类型 ${want}，实际为 ${got}`);
  }
}

/** Build Chinese retry feedback enumerating why the last output failed the schema. */
export function schemaRetryFeedback(name: string, problems: string[]): string {
  const list = problems.length
    ? problems.map((p) => `- ${p}`).join('\n')
    : '- 未能从你的输出中解析出符合结构的 JSON';
  return `---
你上一次的输出不满足 ${name} 结构，存在以下问题：
${list}

请重新只输出一个满足 ${name} 结构的 JSON（可放在 \`\`\`json 代码块里），不要附加任何解释性文字。`;
}

/* helpers -------------------------------------------------------------------- */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Coarse runtime base type used in both validation modes + problem messages. */
function baseType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value; // 'string' | 'number' | 'boolean' | 'object' | 'undefined' | …
}

function deepEqualPrimitive(a: unknown, b: unknown): boolean {
  return a === b;
}
