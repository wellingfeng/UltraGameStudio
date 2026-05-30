/**
 * Local intent engine — keyword-driven fallback when the AI backend is
 * unavailable (no Tauri shell, no API key, network error, etc.).
 *
 * CONTRACT:
 *   applyIntent(ir, text): IntentResult
 *
 * Returns a (possibly mutated) IRGraph and a human-readable note describing
 * what happened. The original `ir` is never mutated in place; a structural
 * clone is returned when changes are made.
 *
 * Supported intents (Chinese + minimal English keywords):
 *   - Add node:       "增加/添加/新增 + agent/parallel/verify/log/branch/loop/..."
 *   - Remove node:    "删除/移除 + <label or type>"
 *   - Parallelize:    "把 X 改成/变成 并行"
 *   - Rename node:    "重命名 X 为 Y" / "把 X 改名为 Y"
 *   - Change model:   "<X> 用 haiku/sonnet/opus" / "把 X 模型改成 opus"
 *
 * When no intent matches, the input IR is returned unchanged with
 * `changed: false` and a hint explaining what the engine understands.
 */

import { EXEC, type IRGraph, type IRNode, type NodeType } from './ir';
import { shortId } from '@/lib/id';

export interface IntentResult {
  ir: IRGraph;
  changed: boolean;
  note: string;
}

/** Per-type defaults used when materialising a new node. */
const NODE_DEFAULTS: Record<
  NodeType,
  { label: string; params: Record<string, unknown> }
> = {
  start: { label: 'Start', params: {} },
  end: { label: 'End', params: {} },
  agent: { label: '新 Agent', params: { model: 'sonnet', prompt: '' } },
  parallel: { label: '并行', params: { branches: [] } },
  pipeline: { label: '流水线', params: { items: 'args', stages: [] } },
  phase: { label: '阶段', params: { title: '阶段' } },
  branch: { label: '分支', params: { condition: 'true' } },
  loop: { label: '循环', params: { condition: 'false' } },
  workflow: { label: '子工作流', params: { name: 'sub' } },
  log: { label: '日志', params: { message: '' } },
  variable: { label: '变量', params: { value: null } },
  codeblock: { label: '代码块', params: { code: '' } },
};

/**
 * Map a free-form Chinese/English fragment onto a NodeType.
 * Returns null when no known type word is found.
 */
function detectNodeType(text: string): NodeType | null {
  const t = text.toLowerCase();
  if (/(verify|verifier|校验|验证|核验)/.test(t)) return 'agent';
  if (/(parallel|并行|并联|并行节点)/.test(t)) return 'parallel';
  if (/(pipeline|流水线|串联)/.test(t)) return 'pipeline';
  if (/(phase|阶段)/.test(t)) return 'phase';
  if (/(branch|分支|条件)/.test(t)) return 'branch';
  if (/(loop|循环|重复)/.test(t)) return 'loop';
  if (/(workflow|子工作流|子流程)/.test(t)) return 'workflow';
  if (/(log|日志|记录)/.test(t)) return 'log';
  if (/(variable|变量)/.test(t)) return 'variable';
  if (/(codeblock|code\s*block|代码块|代码)/.test(t)) return 'codeblock';
  if (/(agent|智能体|步骤|节点)/.test(t)) return 'agent';
  return null;
}

/** Structural clone for an IRGraph — JSON is fine here, no functions/regex. */
function cloneIR(ir: IRGraph): IRGraph {
  return JSON.parse(JSON.stringify(ir)) as IRGraph;
}

/**
 * Find the right-most x coordinate in the layout so newly-added nodes don't
 * stack on existing ones.
 */
function nextX(ir: IRGraph): number {
  const layout = ir.layout ?? {};
  const xs = Object.values(layout).map((p) => p.x);
  return xs.length ? Math.max(...xs) + 240 : 0;
}

/**
 * Locate a node by fuzzy label/type match. Prefers exact label match, then
 * substring label match, then type match. Excludes start/end by default for
 * destructive ops to avoid breaking the spine.
 */
function findNode(
  ir: IRGraph,
  needle: string,
  opts: { allowEnds?: boolean } = {},
): IRNode | null {
  const q = needle.trim().toLowerCase();
  if (!q) return null;
  const candidates = opts.allowEnds
    ? ir.nodes
    : ir.nodes.filter((n) => n.type !== 'start' && n.type !== 'end');

  // 1) exact label
  const exact = candidates.find((n) => (n.label ?? '').toLowerCase() === q);
  if (exact) return exact;
  // 2) substring label
  const sub = candidates.find((n) =>
    (n.label ?? '').toLowerCase().includes(q),
  );
  if (sub) return sub;
  // 3) type word
  const byType = candidates.find((n) => n.type.toLowerCase() === q);
  if (byType) return byType;
  // 4) any node whose label contains any meaningful token from q
  const tokens = q.split(/[\s,，。：:、]+/).filter(Boolean);
  for (const t of tokens) {
    const hit = candidates.find((n) =>
      (n.label ?? '').toLowerCase().includes(t),
    );
    if (hit) return hit;
  }
  return null;
}

/**
 * Remove a node and any edges touching it. If the node sat on the exec spine
 * between A → node → B, stitch A → B so the spine stays connected.
 */
function removeNodeFromIR(ir: IRGraph, id: string): IRGraph {
  const next = cloneIR(ir);
  const incoming = next.edges.filter(
    (e) => e.kind === EXEC && e.to.node === id,
  );
  const outgoing = next.edges.filter(
    (e) => e.kind === EXEC && e.from.node === id,
  );
  next.nodes = next.nodes.filter((n) => n.id !== id);
  next.edges = next.edges.filter(
    (e) => e.from.node !== id && e.to.node !== id,
  );
  if (next.layout) delete next.layout[id];

  // Stitch: connect each predecessor's exec_out to each successor's exec_in.
  for (const inEdge of incoming) {
    for (const outEdge of outgoing) {
      const exists = next.edges.some(
        (e) =>
          e.kind === EXEC &&
          e.from.node === inEdge.from.node &&
          e.to.node === outEdge.to.node,
      );
      if (!exists) {
        next.edges.push({
          id: shortId('e'),
          from: { node: inEdge.from.node, port: 'exec_out' },
          to: { node: outEdge.to.node, port: 'exec_in' },
          kind: EXEC,
        });
      }
    }
  }
  return next;
}

/**
 * Append a new node before the End node (if present) so the spine remains
 * start → ... → newNode → end. Falls back to appending at the tail otherwise.
 */
function appendNodeBeforeEnd(ir: IRGraph, type: NodeType): {
  ir: IRGraph;
  node: IRNode;
} {
  const next = cloneIR(ir);
  const defaults = NODE_DEFAULTS[type];
  const node: IRNode = {
    id: shortId('n'),
    type,
    label: defaults.label,
    params: { ...defaults.params },
  };
  next.nodes.push(node);

  const endNode = next.nodes.find((n) => n.type === 'end');
  if (endNode) {
    // Find the edge feeding end. We'll redirect it: prev → node → end.
    const feedEnd = next.edges.find(
      (e) => e.kind === EXEC && e.to.node === endNode.id,
    );
    if (feedEnd) {
      const prevNode = feedEnd.from.node;
      next.edges = next.edges.filter((e) => e.id !== feedEnd.id);
      next.edges.push({
        id: shortId('e'),
        from: { node: prevNode, port: 'exec_out' },
        to: { node: node.id, port: 'exec_in' },
        kind: EXEC,
      });
      next.edges.push({
        id: shortId('e'),
        from: { node: node.id, port: 'exec_out' },
        to: { node: endNode.id, port: 'exec_in' },
        kind: EXEC,
      });
    } else {
      // No edge to end yet — just connect node → end.
      next.edges.push({
        id: shortId('e'),
        from: { node: node.id, port: 'exec_out' },
        to: { node: endNode.id, port: 'exec_in' },
        kind: EXEC,
      });
    }
  }

  // Layout: place right of existing right-most node, then bump end further.
  next.layout = next.layout ?? {};
  const x = nextX(ir);
  next.layout[node.id] = { x, y: 160 };
  if (endNode && next.layout[endNode.id]) {
    next.layout[endNode.id] = { x: x + 240, y: 160 };
  }
  return { ir: next, node };
}

/** Heuristic: does the text express an "add" intent? */
function isAddIntent(text: string): boolean {
  return /(增加|添加|新增|加一个|加个|插入|加入|append|add|insert)/.test(text);
}

/** Heuristic: does the text express a "remove" intent? */
function isRemoveIntent(text: string): boolean {
  return /(删除|移除|去掉|去除|删掉|remove|delete|drop)/.test(text);
}

/** Heuristic: parallelize intent. */
function isParallelizeIntent(text: string): boolean {
  return /(改成并行|变成并行|改为并行|并行化|改并行|turn .* into parallel|make .* parallel)/.test(
    text,
  );
}

/** Heuristic: rename intent. */
function isRenameIntent(text: string): boolean {
  return /(重命名|改名|改名为|命名为|改成|改为|rename)/.test(text);
}

/** Heuristic: model change intent. */
function detectModel(text: string): 'haiku' | 'sonnet' | 'opus' | null {
  const t = text.toLowerCase();
  if (/\bhaiku\b/.test(t)) return 'haiku';
  if (/\bsonnet\b/.test(t)) return 'sonnet';
  if (/\bopus\b/.test(t)) return 'opus';
  return null;
}

/**
 * Extract "把/将 X 改成/改为/重命名为 Y" target Y label, or null.
 * Falls back to: "重命名 X 为 Y", "改名 X 为 Y".
 */
function extractRenameTarget(text: string): {
  from: string;
  to: string;
} | null {
  const patterns = [
    /(?:把|将)\s*(.+?)\s*(?:改成|改为|重命名为|命名为|改名为)\s*([^\s,。.]+)/,
    /(?:重命名|改名)\s*(.+?)\s*为\s*([^\s,。.]+)/,
    /rename\s+(.+?)\s+to\s+([^\s,.]+)/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return { from: m[1].trim(), to: m[2].trim() };
  }
  return null;
}

/**
 * Extract the target X in "把 X 改成并行" / "把 X 变成并行".
 */
function extractParallelTarget(text: string): string | null {
  const m = text.match(/(?:把|将)\s*(.+?)\s*(?:改成|变成|改为)\s*并行/);
  if (m) return m[1].trim();
  const m2 = text.match(/make\s+(.+?)\s+parallel/i);
  if (m2) return m2[1].trim();
  return null;
}

/**
 * Drive a single user instruction through the keyword rules and return a
 * (possibly updated) IR plus a note describing the outcome.
 */
export function applyIntent(ir: IRGraph, text: string): IntentResult {
  const trimmed = text.trim();
  if (!trimmed) {
    return { ir, changed: false, note: '空指令，未做改动。' };
  }

  // 1) Parallelize a specific node: "把 X 改成并行" — change node.type to parallel.
  if (isParallelizeIntent(trimmed)) {
    const target = extractParallelTarget(trimmed);
    if (target) {
      const node = findNode(ir, target);
      if (node) {
        const next = cloneIR(ir);
        const found = next.nodes.find((n) => n.id === node.id);
        if (found) {
          found.type = 'parallel';
          // Seed a single branch spec from the node's old prompt/label so the
          // emitted thunk array has something runnable.
          const seedPrompt =
            (typeof found.params?.prompt === 'string' && found.params.prompt) ||
            node.label ||
            '并行子任务';
          found.params = { branches: [{ prompt: seedPrompt }] };
          found.label = `${node.label ?? '节点'} (并行)`;
        }
        return {
          ir: next,
          changed: true,
          note: `已将 "${node.label ?? node.id}" 改为并行节点。`,
        };
      }
      return {
        ir,
        changed: false,
        note: `未找到名为 "${target}" 的节点。`,
      };
    }
  }

  // 2) Rename: "把 X 改成 Y" / "重命名 X 为 Y"
  if (isRenameIntent(trimmed) && !isParallelizeIntent(trimmed)) {
    const ren = extractRenameTarget(trimmed);
    if (ren) {
      const node = findNode(ir, ren.from);
      if (node) {
        const next = cloneIR(ir);
        const found = next.nodes.find((n) => n.id === node.id);
        if (found) found.label = ren.to;
        return {
          ir: next,
          changed: true,
          note: `已将 "${node.label ?? node.id}" 重命名为 "${ren.to}"。`,
        };
      }
      return {
        ir,
        changed: false,
        note: `未找到名为 "${ren.from}" 的节点。`,
      };
    }
  }

  // 3) Model change — applies when a model keyword is present and the text
  //    talks about "模型" / "model", e.g. "把 Scan 模型改成 opus".
  const model = detectModel(trimmed);
  if (model && /(模型|model)/i.test(trimmed)) {
    // Try to find a target node by stripping common phrasing.
    const m = trimmed.match(
      /(?:把|将)?\s*(.+?)\s*(?:的)?\s*模型\s*(?:改成|改为|设为|换成|用)?\s*(haiku|sonnet|opus)/i,
    );
    const targetLabel = m ? m[1].trim() : '';
    let node: IRNode | null = null;
    if (targetLabel) {
      node = findNode(ir, targetLabel);
    }
    // Fallback: only one agent node? use it.
    if (!node) {
      const agents = ir.nodes.filter((n) => n.type === 'agent');
      if (agents.length === 1) node = agents[0];
    }
    if (node) {
      const next = cloneIR(ir);
      const found = next.nodes.find((n) => n.id === node!.id);
      if (found) {
        found.params = { ...(found.params ?? {}), model };
      }
      return {
        ir: next,
        changed: true,
        note: `已将 "${node.label ?? node.id}" 的模型设为 ${model}。`,
      };
    }
    return {
      ir,
      changed: false,
      note: `识别到模型 ${model}，但找不到对应节点。`,
    };
  }

  // 4) Remove node: "删除 X" / "去掉 verify"
  if (isRemoveIntent(trimmed)) {
    // Try a labeled target first (everything after the verb).
    const m = trimmed.match(
      /(?:删除|移除|去掉|去除|删掉|remove|delete|drop)\s*(.+)/i,
    );
    const targetLabel = m ? m[1].trim() : '';
    let node: IRNode | null = null;
    if (targetLabel) {
      node = findNode(ir, targetLabel);
    }
    if (!node) {
      const type = detectNodeType(trimmed);
      if (type) {
        node =
          ir.nodes.find(
            (n) => n.type === type && n.type !== 'start' && n.type !== 'end',
          ) ?? null;
      }
    }
    if (node) {
      const next = removeNodeFromIR(ir, node.id);
      return {
        ir: next,
        changed: true,
        note: `已删除节点 "${node.label ?? node.id}"。`,
      };
    }
    return { ir, changed: false, note: '未找到要删除的目标节点。' };
  }

  // 5) Add node: "增加一个 verify" / "加一个并行" / "add agent"
  if (isAddIntent(trimmed)) {
    const type = detectNodeType(trimmed);
    if (type) {
      const { ir: next, node } = appendNodeBeforeEnd(ir, type);
      // If user said "verify", set the label accordingly.
      if (/(verify|校验|验证|核验)/i.test(trimmed) && type === 'agent') {
        const found = next.nodes.find((n) => n.id === node.id);
        if (found) {
          found.label = 'Verify';
          found.params = {
            ...(found.params ?? {}),
            agentType: 'verifier',
            prompt: '校验前序步骤的输出。',
          };
        }
      }
      return {
        ir: next,
        changed: true,
        note: `已添加 ${type} 节点 "${node.label ?? node.id}"。`,
      };
    }
    return {
      ir,
      changed: false,
      note: '不清楚要添加什么类型的节点 (支持 agent/parallel/verify/log/branch/loop 等)。',
    };
  }

  // Nothing matched.
  return {
    ir,
    changed: false,
    note:
      '本地意图引擎未能识别该指令。可尝试: ' +
      '"增加一个 verify 节点"、"删除 Scan"、"把 Review 改成并行"、' +
      '"重命名 Verify 为 校验"、"把 Scan 模型改成 opus"。',
  };
}
