/**
 * CONTRACT: determinism lint for workflow graphs.
 *
 * DeepSeek-Code-Whale bans `Date.now()`, `Math.random()`, and `new Date()` from
 * workflow scripts — they are stripped at parse time and overridden to throw at
 * run time — because a resumable workflow MUST produce the same sequence of
 * calls every run; a nondeterministic clock/RNG breaks the cache identity.
 *
 * OpenWorkflow interprets the IR node-by-node rather than running a JS sandbox,
 * so we can't (and needn't) override globals. But the same hazard applies to our
 * content-addressed resume (runtime/node-hash.ts): if a `codeblock` node's body
 * calls `Date.now()`/`Math.random()`, its hash is stable yet its real output
 * varies run-to-run, so a hash-matched "reuse" would silently serve a stale or
 * wrong value. And when such a graph is emitted and run under real Claude Code,
 * those calls throw outright.
 *
 * This module is a PURE, ADVISORY scanner: it reports occurrences so the host
 * can surface a warning. It never mutates the graph and never blocks a run —
 * matching our "correct the user, don't silently rewrite" stance.
 */
import type { IRGraph } from './ir';

/** One determinism hazard found in a node's code. */
export interface DeterminismFinding {
  nodeId: string;
  /** Which banned construct was found. */
  token: 'Date.now' | 'Math.random' | 'new Date';
  /** Human-readable, why-it-matters message (zh, matching the app's UI language). */
  message: string;
}

const BANNED: { token: DeterminismFinding['token']; needle: string }[] = [
  { token: 'Date.now', needle: 'Date.now(' },
  { token: 'Math.random', needle: 'Math.random(' },
  { token: 'new Date', needle: 'new Date(' },
];

/**
 * Blank out string literals, template literals, and comments so a banned token
 * appearing inside a string/comment is not flagged. Mirrors Whale's
 * `maskStringsAndComments`. Returns a same-length string with masked regions
 * replaced by spaces, so positions are preserved.
 */
function maskStringsAndComments(src: string): string {
  const out = src.split('');
  let i = 0;
  const n = src.length;
  const blank = (from: number, to: number) => {
    for (let j = from; j < to && j < n; j += 1) out[j] = ' ';
  };
  while (i < n) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      let j = i + 1;
      for (; j < n; j += 1) {
        if (src[j] === '\\') {
          j += 1;
          continue;
        }
        if (src[j] === quote) break;
      }
      blank(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      let j = i + 2;
      while (j < n && src[j] !== '\n') j += 1;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      let j = i + 2;
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j += 1;
      blank(i, Math.min(n, j + 2));
      i = j + 2;
      continue;
    }
    i += 1;
  }
  return out.join('');
}

function messageFor(token: DeterminismFinding['token']): string {
  return `代码块使用了 ${token}()，会破坏运行确定性：节点哈希不变但真实输出每次都不同，"继续运行"会复用到过期缓存；在真实 Claude Code workflow 中这类调用还会直接抛错。改用上游传入的固定值或在节点外预先取值。`;
}

/**
 * Scan a graph for determinism hazards in `codeblock` node bodies. Pure and
 * advisory — returns every finding (a node calling both Date.now and
 * Math.random yields two findings). Empty array ⇒ the graph is clean.
 */
export function findDeterminismHazards(workflow: IRGraph): DeterminismFinding[] {
  const findings: DeterminismFinding[] = [];
  for (const node of workflow.nodes) {
    if (node.type !== 'codeblock') continue;
    const raw = typeof node.params.code === 'string' ? node.params.code : '';
    if (!raw) continue;
    const masked = maskStringsAndComments(raw).replace(/\s+/g, '');
    for (const { token, needle } of BANNED) {
      if (masked.includes(needle.replace(/\s+/g, ''))) {
        findings.push({ nodeId: node.id, token, message: messageFor(token) });
      }
    }
  }
  return findings;
}

/** Convenience: true when the graph has no determinism hazards. */
export function isDeterministicGraph(workflow: IRGraph): boolean {
  return findDeterminismHazards(workflow).length === 0;
}
