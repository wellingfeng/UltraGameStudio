import { create } from 'zustand';
import {
  DATA,
  type IREndpoint,
  type IRGraph,
  type IRNode,
  type NodeType,
  type PinKind,
} from '@/core/ir';
import { defaultBlueprint } from '@/core/defaultBlueprint';
import { isEmptyWorkflow } from '@/core/isEmptyWorkflow';
import { applyIntent } from '@/core/intentEngine';
import { isRunnable, topoOrderExec } from '@/core/topo';
import { shortId } from '@/lib/id';
import { aiEditViaCli, isTauri } from '@/lib/tauri';
import {
  UNIFIED_SYSTEM,
  extractJsonObject,
  streamAnthropic,
} from '@/lib/anthropic';
import {
  defaultComposer,
  initialActiveSessionId,
  modelOptions,
  permissionOptions,
  PROMPT_DEFAULTS_VERSION,
  samplePromptGroups,
  sampleSessions,
} from './sampleSessions';
import {
  loadComposer,
  loadPromptGroups,
  loadPromptGroupsVersion,
  saveComposer,
  savePromptGroups,
  savePromptGroupsVersion,
} from '@/lib/composerStorage';
import { autosave, loadLocalWorkflow } from '@/lib/persist';
import type {
  ComposerSettings,
  Message,
  NodeRunState,
  PromptGroup,
  PromptItem,
  SelectOption,
  Session,
} from './types';

/**
 * CONTRACT: the single zustand store. App.tsx and panels rely on this exact
 * surface — keep these fields and actions stable.
 *
 * State (pre-existing, unchanged):
 *   workflow, selectedNodeId,
 *   sessions, activeSessionId, messages, promptGroups,
 *   composer, permissionOptions, modelOptions, workspaceHistory
 * State (added this milestone):
 *   mode ('design'|'running'), runState (Record<id,NodeRunState>),
 *   dirty (boolean), currentFilePath (string|null)
 *
 * Actions (pre-existing, unchanged signatures):
 *   selectNode(id), setWorkflow(ir), setAdapter(id), runWorkflow(),
 *   newWorkflow(), newSession(), sendPrompt(text), setComposer(patch),
 *   setWorkspace(path)
 * Actions (added this milestone — graph editing + run/mode control):
 *   addNode(type, params?) -> id, updateNodeParams(id, patch),
 *   updateNodeLabel(id, label), removeNode(id),
 *   addEdge(from, to, kind) -> id, removeEdge(id),
 *   setNodePosition(id, x, y), setMode(mode),
 *   setRunState(id, state), resetRunState(),
 *   applyGraphEdit(ir), markSaved(path?),
 *   markActiveSessionAsWorkflow() — locked flag, called from any
 *     graph-touching action; once true the session never reverts.
 * Actions (prompt-library CRUD — every mutation persists to localStorage):
 *   addPromptItem(groupId, label, text), updatePromptItem(groupId, itemId, patch),
 *   removePromptItem(groupId, itemId),
 *   addPromptGroup(label) -> id, updatePromptGroup(groupId, label),
 *   removePromptGroup(groupId), resetPromptGroups()
 *
 * Every graph-mutating action sets dirty=true (except setNodePosition, which
 * only touches layout and is flushed via markSaved to avoid polluting the
 * dirty flag during frequent drags).
 */
export interface StoreState {
  // Graph state
  workflow: IRGraph;
  selectedNodeId: string | null;

  // Editor lifecycle state
  mode: 'design' | 'running';
  runState: Record<string, NodeRunState>;
  dirty: boolean;
  currentFilePath: string | null;

  // AI state (browser-direct streaming).
  /** True while an AI request is streaming in (drives loading + disables send). */
  aiStreaming: boolean;

  // Session / UI state
  sessions: Session[];
  activeSessionId: string | null;
  messages: Message[];
  promptGroups: PromptGroup[];

  // Composer (AI-input) state — pure UI, never enters the IRGraph.
  composer: ComposerSettings;
  permissionOptions: SelectOption[];
  modelOptions: SelectOption[];
  /** Previously-selected workspace folders, most-recent-first. */
  workspaceHistory: string[];

  // Actions
  selectNode: (id: string | null) => void;
  setWorkflow: (ir: IRGraph) => void;
  setAdapter: (adapter: string) => void;
  runWorkflow: () => void;
  newWorkflow: () => void;
  newSession: () => void;
  sendPrompt: (text: string) => void;
  setComposer: (patch: Partial<ComposerSettings>) => void;
  setWorkspace: (path: string) => void;

  // Graph editing
  addNode: (
    type: NodeType,
    params?: Record<string, unknown>,
    parent?: string,
  ) => string;
  updateNodeParams: (id: string, patch: Record<string, unknown>) => void;
  updateNodeLabel: (id: string, label: string) => void;
  removeNode: (id: string) => void;
  addEdge: (from: IREndpoint, to: IREndpoint, kind: PinKind) => string;
  removeEdge: (id: string) => void;
  setNodePosition: (id: string, x: number, y: number) => void;

  // Run / mode control
  setMode: (mode: 'design' | 'running') => void;
  setRunState: (id: string, state: NodeRunState) => void;
  resetRunState: () => void;

  // Whole-graph + persistence
  applyGraphEdit: (ir: IRGraph) => void;
  markSaved: (path?: string) => void;

  // Session-type marker: flip the active session's isWorkflow flag to true.
  // Locked — once true, it stays true (mirrors the SessionRecord contract in
  // history-store-spec.md §4.3). Called from every action that touches the
  // workflow blueprint so pure-chat sessions stay false.
  markActiveSessionAsWorkflow: () => void;

  // Prompt-library CRUD (persisted to localStorage)
  addPromptItem: (groupId: string, label: string, text: string) => void;
  updatePromptItem: (
    groupId: string,
    itemId: string,
    patch: Partial<PromptItem>,
  ) => void;
  removePromptItem: (groupId: string, itemId: string) => void;
  addPromptGroup: (label: string) => string;
  updatePromptGroup: (groupId: string, label: string) => void;
  removePromptGroup: (groupId: string) => void;
  resetPromptGroups: () => void;
}

const WORKSPACE_HISTORY_LIMIT = 8;

/** localStorage key holding the user's Anthropic API key (set via AIDock). */
const API_KEY_STORAGE = 'owf_anthropic_key';

/** Read the API key from localStorage; returns null in non-browser contexts. */
function readApiKey(): string | null {
  try {
    if (typeof window === 'undefined') return null;
    const v = window.localStorage.getItem(API_KEY_STORAGE);
    return v && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Per-type default label + params used by addNode. Mirrors the node catalogue
 * in the design doc; agent/control nodes carry their minimal editable params.
 */
const NODE_DEFAULTS: Record<
  NodeType,
  { label: string; params: Record<string, unknown> }
> = {
  start: { label: 'Start', params: {} },
  end: { label: 'End', params: {} },
  agent: { label: '描述你的步骤', params: { model: 'sonnet' } },
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
 * Collect a node id plus every transitive descendant (children whose `parent`
 * chain leads back to it). Used by removeNode so deleting a branch/loop removes
 * its whole body rather than orphaning child nodes.
 */
function collectSubtree(nodes: IRNode[], rootId: string): Set<string> {
  const doomed = new Set<string>([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of nodes) {
      if (n.parent && doomed.has(n.parent) && !doomed.has(n.id)) {
        doomed.add(n.id);
        grew = true;
      }
    }
  }
  return doomed;
}

function makeSession(): Session {
  return {
    id: shortId('s'),
    title: 'New Session',
    createdAt: Date.now(),
    // New sessions default to chat-type; the first workflow touch flips this on.
    isWorkflow: false,
  };
}

/**
 * Pure helper: return the updated `sessions` array with the active session's
 * `isWorkflow` flipped to true, or the original array when nothing changes
 * (no active session, already flagged, or session missing). Used inside
 * mutating actions so we keep the flag flip in the same set() call as the
 * graph mutation — no extra render.
 *
 * Lock semantics: never flips a `true` back to `false`.
 */
function markedSessions(
  sessions: Session[],
  activeSessionId: string | null,
): Session[] {
  if (!activeSessionId) return sessions;
  let dirty = false;
  const next = sessions.map((s) => {
    if (s.id !== activeSessionId || s.isWorkflow) return s;
    dirty = true;
    return { ...s, isWorkflow: true };
  });
  return dirty ? next : sessions;
}

// Restore persisted composer settings + workspace history (if any). Normalize a
// stale model id (e.g. an old fake option) back to the default so the real
// Anthropic call always gets a valid model.
const persisted = loadComposer();
const seedComposer: ComposerSettings = (() => {
  const c = persisted?.composer ?? defaultComposer;
  const valid = modelOptions.some((o) => o.id === c.model);
  return valid ? c : { ...c, model: defaultComposer.model };
})();

// Seed the graph from the last autosaved workflow if present, otherwise start
// from a fresh default blueprint (start → agent → end). We deliberately do NOT
// seed the demo sample here: that caused "new workflow" to flicker back to the
// review-changes sample whenever the store module re-initialised (e.g. on HMR).
const seedWorkflow = loadLocalWorkflow() ?? defaultBlueprint();

/**
 * Seed the prompt library, merging newly-shipped default groups into the user's
 * persisted library.
 *
 * Without this, adding a default group to `samplePromptGroups` would never show
 * up for users who already have a persisted library (loadPromptGroups() wins),
 * silently hiding new defaults. The merge runs once per PROMPT_DEFAULTS_VERSION
 * bump (tracked in localStorage): any default group whose `id` is absent from
 * the persisted set is appended, preserving all of the user's own edits and not
 * resurrecting groups they deliberately deleted in earlier versions.
 */
function seedPromptGroups(): PromptGroup[] {
  const stored = loadPromptGroups();
  if (!stored) return samplePromptGroups; // never edited → use full defaults
  if (loadPromptGroupsVersion() >= PROMPT_DEFAULTS_VERSION) return stored;

  const existing = new Set(stored.map((g) => g.id));
  const additions = samplePromptGroups.filter((g) => !existing.has(g.id));
  const merged = additions.length ? [...stored, ...additions] : stored;
  if (additions.length) savePromptGroups(merged);
  savePromptGroupsVersion(PROMPT_DEFAULTS_VERSION);
  return merged;
}
const seedPromptGroupsValue = seedPromptGroups();

export const useStore = create<StoreState>((set) => ({
  // Seed graph: restored autosave, or a fresh default blueprint.
  workflow: seedWorkflow,
  selectedNodeId: null,

  // Editor lifecycle: start in design mode, no run state, clean, unsaved.
  mode: 'design',
  runState: {},
  dirty: false,
  currentFilePath: null,

  // AI: idle.
  aiStreaming: false,

  // Seed session-domain state from the sample module so the dev UI renders
  // a populated session history, message stream, and prompt library.
  sessions: sampleSessions,
  activeSessionId: initialActiveSessionId,
  // Start with an empty AI return stream; messages accrue as the user interacts.
  messages: [],
  // Restore the user-edited prompt library if present (merging in any newly-
  // shipped default groups), else the full defaults. See seedPromptGroups().
  promptGroups: seedPromptGroupsValue,

  // Composer settings seeded from the sample option lists, overlaid with any
  // persisted selections.
  composer: seedComposer,
  permissionOptions,
  modelOptions,
  workspaceHistory: persisted?.workspaceHistory ?? [],

  selectNode: (id) => set({ selectedNodeId: id }),

  setWorkflow: (ir) => set({ workflow: ir }),

  // Switch the target runtime adapter (Claude Code / Codex / Gemini). The
  // adapter lives in the IR meta so the emitter can target the right runtime.
  setAdapter: (adapter) =>
    set((state) => ({
      workflow: { ...state.workflow, meta: { ...state.workflow.meta, adapter } },
    })),

  // Run action — execute the blueprint node-by-node.
  //
  // Flow:
  //   1. Flip to running mode and reset per-node run state.
  //   2. In Tauri: interpret the IR — walk the exec spine and run each agent/
  //      parallel/pipeline/workflow node through the local CLI (`claude -p` via
  //      `ai_cli`), threading upstream data-edge outputs into the prompt and
  //      streaming each node's result into the dock.
  //   3. In a plain browser (no CLI): a topological simulation (running→success
  //      with a short delay per node).
  //   4. Either way the run terminates and returns to design mode (the "运行中"
  //      badge clears), or the user can hit 停止 to abort early.
  runWorkflow: () => {
    const state = useStore.getState();
    if (state.mode === 'running') return;

    const { workflow } = state;
    const name = workflow.meta.name ?? 'untitled';
    const adapter = workflow.meta.adapter ?? 'claude-code';

    // Capture the run's workspace + permission (from the AIDock controls) so each
    // node's CLI agent runs in the right dir with enough access to act without
    // stalling on permission prompts.
    activeRunConfig = {
      cwd: state.composer.workspace || undefined,
      permission: state.composer.permission || 'full',
    };

    set({ mode: 'running', runState: {} });
    set((s) => ({
      messages: [
        ...s.messages,
        {
          id: shortId('m'),
          role: 'system',
          text: `▶ 运行工作流 "${name}" · 运行时 ${adapter} · 权限 ${activeRunConfig.permission}${activeRunConfig.cwd ? ` · 工作区 ${activeRunConfig.cwd}` : ''}`,
          createdAt: Date.now(),
        },
      ],
    }));

    if (isTauri()) {
      void executeViaCliInterpreter(workflow, adapter);
    } else {
      void executeViaSimulator(workflow);
    }
  },

  // Load a fresh starter graph (start → agent → end), clean and in design mode.
  newWorkflow: () =>
    set({
      workflow: defaultBlueprint(),
      selectedNodeId: null,
      dirty: false,
      runState: {},
      mode: 'design',
    }),

  newSession: () =>
    set((state) => {
      const session = makeSession();
      return {
        sessions: [session, ...state.sessions],
        activeSessionId: session.id,
        messages: [],
      };
    }),

  // AI-driven graph edit (design mode only).
  //
  // Flow:
  //   1. Push the user message into the stream immediately so the UI feels
  //      responsive.
  //   2. While in running mode, no-op (the AIDock disables input anyway).
  //   3. Snapshot the current IR + read the API key from localStorage.
  //   4. Try `aiEditGraph(ir, text, apiKey)`:
  //        - Success → applyGraphEdit(newIr) + push "已修改蓝图" receipt.
  //        - Throws NO_BACKEND / NO_API_KEY / network error → fall back to
  //          the local intent engine (applyIntent). When the engine changes
  //          the graph, apply it; otherwise push the engine's hint as-is.
  //
  // The action stays `(text) => void` per the public contract; the async
  // work runs in a self-invoked IIFE.
  // AI send — one step, returns an explanation + (optional) IRGraph that is
  // applied automatically.
  //
  // Backend priority:
  //   1. Desktop shell (Tauri): shell out to the local agent CLI (`claude -p`)
  //      via the `ai_cli` command — uses the machine's own env/credentials, so
  //      NO in-app key is needed. Non-streaming (CLI returns the full reply).
  //   2. Browser with a key: stream directly from the Anthropic API (live
  //      token-by-token) using the localStorage key + selected model.
  //   3. Otherwise: local keyword intent engine for simple edits, else a hint.
  //
  // In all cases the reply is a short Chinese explanation optionally followed by
  // a fenced ```json IRGraph; the JSON is hidden from the stream, parsed, and
  // applied to the blueprint. Pure questions (no fence) leave the graph as-is.
  sendPrompt: (text) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const state = useStore.getState();
    if (state.mode === 'running' || state.aiStreaming) return;

    set((s) => ({
      messages: [
        ...s.messages,
        { id: shortId('m'), role: 'user', text: trimmed, createdAt: Date.now() },
      ],
    }));

    const ir = state.workflow;
    const apiKey = readApiKey() ?? undefined;
    const model = state.composer.model;
    const adapter = ir.meta.adapter ?? 'claude-code';
    const inTauri = isTauri();
    // Blueprint edits prefer the Anthropic API (its system prompt strictly
    // constrains the reply to a single IRGraph JSON). The `claude` CLI is a
    // conversational agent that tends to ask for confirmation / explore code
    // instead of returning pure JSON, so it is only a no-key fallback here.
    const useApi = !!apiKey;
    const useCli = !apiKey && inTauri;

    const pushAssistant = (txt: string) => {
      set((s) => ({
        messages: [
          ...s.messages,
          { id: shortId('m'), role: 'assistant', text: txt, createdAt: Date.now() },
        ],
      }));
    };

    // No API key and no desktop CLI: local keyword fallback.
    if (!useApi && !useCli) {
      const result = applyIntent(ir, trimmed);
      if (result.changed) {
        useStore.getState().applyGraphEdit(result.ir);
        pushAssistant(`⟳ 已修改蓝图 (本地意图引擎)。${result.note}`);
      } else {
        pushAssistant(
          `当前在网页环境且未配置 API key。请点右上角 ⚙ 设置 key 以调用大模型改图；或用桌面版（用命令行，无需 key）。\n（本地意图引擎：${result.note}）`,
        );
      }
      return;
    }

    const wrapped = isEmptyWorkflow(ir)
      ? `我希望新建一个 workflow，目的如下：\n${trimmed}`
      : `我希望继续修改 workflow，根据下面意见你来优化流程：\n${trimmed}`;
    const userContent = `当前 IRGraph(JSON)：\n${JSON.stringify(ir)}\n\n用户意见：\n${wrapped}`;

    // Placeholder assistant message; updated live (API stream) or once (CLI).
    const assistantId = shortId('m');
    set((s) => ({
      aiStreaming: true,
      messages: [
        ...s.messages,
        {
          id: assistantId,
          role: 'assistant',
          text: useCli ? `⟳ 通过命令行调用 ${adapter} 生成蓝图…` : '',
          createdAt: Date.now(),
        },
      ],
    }));
    const setMessage = (txt: string) => {
      set((s) => ({
        messages: s.messages.map((m) =>
          m.id === assistantId ? { ...m, text: txt } : m,
        ),
      }));
    };

    // Shared: split a full reply into explanation + optional IRGraph, apply it.
    const finalizeReply = (full: string) => {
      const fence = full.indexOf('```');
      const explanation = (fence === -1 ? full : full.slice(0, fence)).trim();
      if (fence === -1) {
        // No fenced JSON. If the model still emitted a bare {…} object, try it;
        // otherwise this was a question/explanation and the graph is unchanged.
        const maybe = extractJsonObject(full);
        if (maybe.trim().startsWith('{')) {
          try {
            const nextIr = JSON.parse(maybe) as IRGraph;
            if (Array.isArray(nextIr.nodes) && Array.isArray(nextIr.edges)) {
              useStore.getState().applyGraphEdit(nextIr);
              setMessage(
                `✓ 已更新蓝图（${nextIr.nodes.length} 节点 / ${nextIr.edges.length} 边）。`,
              );
              return;
            }
          } catch {
            /* fall through to prose */
          }
        }
        setMessage(explanation || '(模型未返回蓝图。请把意图描述得更具体，例如“在 X 后加一个 Y 节点”。)');
        return;
      }
      try {
        const nextIr = JSON.parse(extractJsonObject(full)) as IRGraph;
        if (!Array.isArray(nextIr.nodes) || !Array.isArray(nextIr.edges)) {
          throw new Error('返回的不是合法 IRGraph');
        }
        useStore.getState().applyGraphEdit(nextIr);
        const head = explanation ? `${explanation}\n\n` : '';
        setMessage(
          `${head}✓ 已更新蓝图（${nextIr.nodes.length} 节点 / ${nextIr.edges.length} 边）。`,
        );
      } catch (parseErr) {
        const msg = (parseErr as Error)?.message ?? String(parseErr);
        const head = explanation ? `${explanation}\n\n` : '';
        setMessage(`${head}⚠ 蓝图未更新：返回的 JSON 无法解析 (${msg})。`);
      }
    };

    void (async () => {
      try {
        if (useCli) {
          // No-key fallback: drive the CLI to behave like a JSON-only editor.
          // The CLI is an interactive agent, so we (a) forbid questions/code
          // exploration in the prompt and (b) skip permission prompts so it
          // never stalls waiting for a confirmation the UI can't provide.
          const cliPrompt =
            `${UNIFIED_SYSTEM}\n\n` +
            `严格要求：只输出结果（中文说明 + 一个 \`\`\`json IRGraph 代码块）。` +
            `不要反问、不要请求确认、不要去读取或探索任何代码文件，直接基于下面给出的 IRGraph(JSON) 作答。\n\n` +
            userContent;
          const full = await aiEditViaCli(cliPrompt, adapter, {
            permission: 'full', // -> --dangerously-skip-permissions, no prompts
          });
          finalizeReply(full);
        } else {
          // Anthropic API (key + selected model), streaming. Show only the prose
          // before the ``` fence as it streams; hide the JSON payload.
          let full = '';
          await streamAnthropic({
            apiKey,
            model,
            system: UNIFIED_SYSTEM,
            userContent,
            maxTokens: 8192,
            onDelta: (chunk) => {
              full += chunk;
              const fence = full.indexOf('```');
              const visible = fence === -1 ? full : full.slice(0, fence).trimEnd();
              setMessage(visible || '⟳ 生成中…');
            },
          });
          finalizeReply(full);
        }
        set({ aiStreaming: false });
      } catch (err) {
        const msg = (err as Error)?.message ?? String(err);
        setMessage(`✗ 调用失败: ${msg}`);
        set({ aiStreaming: false });
      }
    })();
  },

  setComposer: (patch) =>
    set((state) => {
      const composer = { ...state.composer, ...patch };
      saveComposer({ composer, workspaceHistory: state.workspaceHistory });
      return { composer };
    }),

  // Set the active workspace and record it in the most-recent-first history
  // (deduped, capped). Empty paths are ignored.
  setWorkspace: (path) => {
    const trimmed = path.trim();
    if (!trimmed) return;
    set((state) => {
      const composer = { ...state.composer, workspace: trimmed };
      const workspaceHistory = [
        trimmed,
        ...state.workspaceHistory.filter((p) => p !== trimmed),
      ].slice(0, WORKSPACE_HISTORY_LIMIT);
      saveComposer({ composer, workspaceHistory });
      return { composer, workspaceHistory };
    });
  },

  // ── Graph editing ──────────────────────────────────────────────────────

  addNode: (type, params, parent) => {
    const id = shortId('n');
    set((state) => {
      const defaults = NODE_DEFAULTS[type];
      const node: IRNode = {
        id,
        type,
        ...(parent ? { parent } : null),
        label: defaults.label,
        params: { ...defaults.params, ...(params ?? {}) },
      };
      // Place the new node to the right of the right-most existing node.
      const layout = state.workflow.layout ?? {};
      const xs = Object.values(layout).map((p) => p.x);
      const x = xs.length ? Math.max(...xs) + 240 : 0;
      return {
        workflow: {
          ...state.workflow,
          nodes: [...state.workflow.nodes, node],
          layout: { ...layout, [id]: { x, y: 160 } },
        },
        dirty: true,
      };
    });
    return id;
  },

  updateNodeParams: (id, patch) =>
    set((state) => ({
      workflow: {
        ...state.workflow,
        nodes: state.workflow.nodes.map((n) =>
          n.id === id ? { ...n, params: { ...n.params, ...patch } } : n,
        ),
      },
      dirty: true,
    })),

  updateNodeLabel: (id, label) =>
    set((state) => ({
      workflow: {
        ...state.workflow,
        nodes: state.workflow.nodes.map((n) =>
          n.id === id ? { ...n, label } : n,
        ),
      },
      dirty: true,
    })),

  // Remove a node and, when it is a container (branch/loop), all of its
  // transitive descendants — plus every edge touching any removed node.
  removeNode: (id) =>
    set((state) => {
      const doomed = collectSubtree(state.workflow.nodes, id);
      const layout = { ...(state.workflow.layout ?? {}) };
      for (const d of doomed) delete layout[d];
      return {
        workflow: {
          ...state.workflow,
          nodes: state.workflow.nodes.filter((n) => !doomed.has(n.id)),
          edges: state.workflow.edges.filter(
            (e) => !doomed.has(e.from.node) && !doomed.has(e.to.node),
          ),
          layout,
        },
        selectedNodeId: doomed.has(state.selectedNodeId ?? '')
          ? null
          : state.selectedNodeId,
        dirty: true,
      };
    }),

  addEdge: (from, to, kind) => {
    const id = kind === DATA ? shortId('d') : shortId('e');
    set((state) => {
      // Dedupe: identical from/to/kind edges are ignored.
      const exists = state.workflow.edges.some(
        (e) =>
          e.kind === kind &&
          e.from.node === from.node &&
          e.from.port === from.port &&
          e.to.node === to.node &&
          e.to.port === to.port,
      );
      if (exists) return state;
      return {
        workflow: {
          ...state.workflow,
          edges: [...state.workflow.edges, { id, from, to, kind }],
        },
        dirty: true,
      };
    });
    return id;
  },

  removeEdge: (id) =>
    set((state) => ({
      workflow: {
        ...state.workflow,
        edges: state.workflow.edges.filter((e) => e.id !== id),
      },
      dirty: true,
    })),

  // Layout-only write. Deliberately does not set dirty: drags are frequent and
  // position is flushed to persistence via markSaved.
  setNodePosition: (id, x, y) =>
    set((state) => ({
      workflow: {
        ...state.workflow,
        layout: { ...(state.workflow.layout ?? {}), [id]: { x, y } },
      },
    })),

  // ── Run / mode control ─────────────────────────────────────────────────

  setMode: (mode) => set({ mode }),

  setRunState: (id, runNodeState) =>
    set((state) => ({
      runState: { ...state.runState, [id]: runNodeState },
    })),

  resetRunState: () => set({ runState: {} }),

  // ── Whole-graph + persistence ──────────────────────────────────────────

  applyGraphEdit: (ir) =>
    set({ workflow: ir, selectedNodeId: null, dirty: true }),

  markSaved: (path) =>
    set((state) => ({
      dirty: false,
      currentFilePath: path ?? state.currentFilePath,
    })),

  // Flip the active session's isWorkflow flag to true (locked — never reverts).
  // Returns the state unchanged when nothing flips so we avoid an extra render.
  markActiveSessionAsWorkflow: () =>
    set((state) => {
      const sessions = markedSessions(state.sessions, state.activeSessionId);
      return sessions === state.sessions ? state : { sessions };
    }),

  // ── Prompt-library CRUD ────────────────────────────────────────────────
  //
  // Every mutating action computes the next promptGroups array, persists it via
  // savePromptGroups(next), and commits it to the store. Edits therefore survive
  // a reload (loadPromptGroups seeds the store on init).

  addPromptItem: (groupId, label, text) =>
    set((state) => {
      const next = state.promptGroups.map((g) =>
        g.id === groupId
          ? { ...g, items: [...g.items, { id: shortId('pi'), label, text }] }
          : g,
      );
      savePromptGroups(next);
      return { promptGroups: next };
    }),

  updatePromptItem: (groupId, itemId, patch) =>
    set((state) => {
      const next = state.promptGroups.map((g) =>
        g.id === groupId
          ? {
              ...g,
              items: g.items.map((it) =>
                it.id === itemId ? { ...it, ...patch } : it,
              ),
            }
          : g,
      );
      savePromptGroups(next);
      return { promptGroups: next };
    }),

  removePromptItem: (groupId, itemId) =>
    set((state) => {
      const next = state.promptGroups.map((g) =>
        g.id === groupId
          ? { ...g, items: g.items.filter((it) => it.id !== itemId) }
          : g,
      );
      savePromptGroups(next);
      return { promptGroups: next };
    }),

  addPromptGroup: (label) => {
    const id = shortId('pg');
    set((state) => {
      const next = [...state.promptGroups, { id, label, items: [] }];
      savePromptGroups(next);
      return { promptGroups: next };
    });
    return id;
  },

  updatePromptGroup: (groupId, label) =>
    set((state) => {
      const next = state.promptGroups.map((g) =>
        g.id === groupId ? { ...g, label } : g,
      );
      savePromptGroups(next);
      return { promptGroups: next };
    }),

  removePromptGroup: (groupId) =>
    set((state) => {
      const next = state.promptGroups.filter((g) => g.id !== groupId);
      savePromptGroups(next);
      return { promptGroups: next };
    }),

  resetPromptGroups: () =>
    set(() => {
      const next = samplePromptGroups;
      savePromptGroups(next);
      savePromptGroupsVersion(PROMPT_DEFAULTS_VERSION);
      return { promptGroups: next };
    }),
}));

/* -------------------------------------------------------------------------- */
/* Run execution helpers                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Per-run CLI config (workspace + permission), captured from the AIDock controls
 * at run start and shared by every node's `aiEditViaCli` call. Only one run is
 * active at a time (guarded by `mode`), so a module-level value is safe and
 * avoids threading these through every interpreter helper.
 */
let activeRunConfig: { cwd?: string; permission?: string } = {};

/** Append a system log line to the message stream. */
function pushRunLog(text: string, role: Message['role'] = 'system'): void {
  useStore.setState((s) => ({
    messages: [...s.messages, { id: shortId('m'), role, text, createdAt: Date.now() }],
  }));
}

/** Collect outputs of nodes that feed `node` via data edges (producer → node). */
function dataInputsFor(
  node: IRNode,
  workflow: IRGraph,
  results: Map<string, string>,
): { label: string; text: string }[] {
  const byId = new Map(workflow.nodes.map((n) => [n.id, n]));
  const inputs: { label: string; text: string }[] = [];
  for (const e of workflow.edges) {
    if (e.kind !== DATA || e.to.node !== node.id) continue;
    const out = results.get(e.from.node);
    if (out == null) continue;
    inputs.push({ label: byId.get(e.from.node)?.label ?? e.from.node, text: out });
  }
  return inputs;
}

/** An agent spec for a parallel branch / pipeline stage (tolerates legacy strings). */
interface RunSpec {
  prompt: string;
  label?: string;
  agentType?: string;
  model?: string;
}

/** Coerce a params array into RunSpec[] (objects or legacy string[]). */
function specList(value: unknown): RunSpec[] {
  if (!Array.isArray(value)) return [];
  return value.map((v): RunSpec => {
    if (typeof v === 'string') return { prompt: v };
    const o = (v ?? {}) as Record<string, unknown>;
    return {
      prompt: String(o.prompt ?? ''),
      label: typeof o.label === 'string' ? o.label : undefined,
      agentType: typeof o.agentType === 'string' ? o.agentType : undefined,
      model: typeof o.model === 'string' ? o.model : undefined,
    };
  });
}

/**
 * Push a fresh assistant message and return handles to grow it live (append) or
 * replace it (finalize). Used so each node/branch shows its CLI output streaming
 * in rather than appearing all at once when the step finishes.
 */
function createStreamMessage(header: string): {
  append: (chunk: string) => void;
  finalize: (text: string) => void;
} {
  const id = shortId('m');
  useStore.setState((s) => ({
    messages: [
      ...s.messages,
      { id, role: 'assistant', text: header, createdAt: Date.now() },
    ],
  }));
  return {
    append: (chunk) =>
      useStore.setState((s) => ({
        messages: s.messages.map((m) =>
          m.id === id ? { ...m, text: m.text + chunk } : m,
        ),
      })),
    finalize: (text) =>
      useStore.setState((s) => ({
        messages: s.messages.map((m) => (m.id === id ? { ...m, text } : m)),
      })),
  };
}

/** The model tier configured on a node's params (for `--model`), if any. */
function nodeModel(params: Record<string, unknown>): string | undefined {
  return typeof params.model === 'string' ? params.model : undefined;
}

/** The "上游输出" context block for a node, or '' when it has no data inputs. */
function dataContextString(
  node: IRNode,
  workflow: IRGraph,
  results: Map<string, string>,
): string {
  const inputs = dataInputsFor(node, workflow, results);
  if (inputs.length === 0) return '';
  const ctx = inputs
    .map((i) => `### 来自「${i.label}」的输出\n${i.text}`)
    .join('\n\n');
  return `\n\n---\n以下是上游步骤的输出，供你参考：\n\n${ctx}`;
}

/** Is the run still active? (false once the user hits 停止.) */
function stillRunning(): boolean {
  return useStore.getState().mode === 'running';
}

/**
 * Run a `parallel` node: each branch is its own concurrent `claude -p` call
 * (real fan-out, not one lumped prompt). All branches share the node's upstream
 * data context. Per-branch output streams in as it lands; the combined output is
 * threaded to downstream nodes. Throws only if every branch fails.
 */
async function runParallel(
  node: IRNode,
  workflow: IRGraph,
  results: Map<string, string>,
  adapter: string,
): Promise<string> {
  const branches = specList(node.params.branches);
  if (branches.length === 0) return '';
  const upstream = dataContextString(node, workflow, results);

  const settled = await Promise.all(
    branches.map(async (b, i) => {
      const label = b.label || b.agentType || b.prompt.slice(0, 16) || `分支${i + 1}`;
      const head = `【并行分支 ${i + 1}/${branches.length} · ${label}】\n`;
      const sm = createStreamMessage(head);
      try {
        const out = (
          await aiEditViaCli(b.prompt + upstream, adapter, {
            model: b.model,
            cwd: activeRunConfig.cwd,
            permission: activeRunConfig.permission,
            onProgress: sm.append,
          })
        ).trim();
        sm.finalize(`【✓ 并行分支 ${i + 1}/${branches.length} · ${label}】\n${out || '(无输出)'}`);
        return { ok: true, label, out };
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        sm.finalize(`✗ 并行分支 ${i + 1} · ${label} 失败: ${msg}`);
        return { ok: false, label, out: '' };
      }
    }),
  );

  if (settled.every((s) => !s.ok)) throw new Error('所有并行分支均失败');
  return settled.map((s) => `【${s.label}】\n${s.out}`).join('\n\n');
}

/**
 * Run a `pipeline` node: stages execute sequentially, each receiving the previous
 * stage's output (the first stage also gets the node's upstream context + items
 * expression). Returns the final stage's output.
 */
async function runPipeline(
  node: IRNode,
  workflow: IRGraph,
  results: Map<string, string>,
  adapter: string,
): Promise<string> {
  const stages = specList(node.params.stages);
  if (stages.length === 0) return '';
  const items = String(node.params.items ?? '').trim();
  let prev = '';

  for (let i = 0; i < stages.length; i += 1) {
    if (!stillRunning()) break;
    const s = stages[i];
    const label = s.label || s.prompt.slice(0, 16) || `阶段${i + 1}`;
    const head = `【流水线阶段 ${i + 1}/${stages.length} · ${label}】\n`;
    const sm = createStreamMessage(head);
    const feed =
      i === 0
        ? dataContextString(node, workflow, results) +
          (items ? `\n\n输入数据: ${items}` : '')
        : `\n\n---\n上一步输出：\n${prev}`;
    prev = (
      await aiEditViaCli(s.prompt + feed, adapter, {
        model: s.model,
        cwd: activeRunConfig.cwd,
        permission: activeRunConfig.permission,
        onProgress: sm.append,
      })
    ).trim();
    sm.finalize(`【✓ 流水线阶段 ${i + 1}/${stages.length} · ${label}】\n${prev || '(无输出)'}`);
  }
  return prev;
}

/**
 * Execute one node, returning its result string (stored for downstream data
 * edges), or null when there is nothing to run (control / log / variable /
 * codeblock). Streams sub-results for parallel/pipeline. Throws on hard error.
 */
async function runNode(
  node: IRNode,
  workflow: IRGraph,
  results: Map<string, string>,
  adapter: string,
): Promise<string | null> {
  const label = node.label ?? node.type;
  switch (node.type) {
    case 'agent': {
      const base = String(node.params.prompt ?? node.label ?? '').trim();
      if (!base) return '';
      const head = `【${label}】\n`;
      const sm = createStreamMessage(head);
      const out = (
        await aiEditViaCli(base + dataContextString(node, workflow, results), adapter, {
          model: nodeModel(node.params),
          cwd: activeRunConfig.cwd,
          permission: activeRunConfig.permission,
          onProgress: sm.append,
        })
      ).trim();
      sm.finalize(`【✓ ${label}】\n${out || '(无输出)'}`);
      return out;
    }
    case 'workflow': {
      const base = `运行子工作流 "${String(node.params.name ?? node.label ?? 'sub')}" 并返回结果。`;
      const head = `【${label}】\n`;
      const sm = createStreamMessage(head);
      const out = (
        await aiEditViaCli(base + dataContextString(node, workflow, results), adapter, {
          cwd: activeRunConfig.cwd,
          permission: activeRunConfig.permission,
          onProgress: sm.append,
        })
      ).trim();
      sm.finalize(`【✓ ${label}】\n${out || '(无输出)'}`);
      return out;
    }
    case 'parallel':
      return runParallel(node, workflow, results, adapter);
    case 'pipeline':
      return runPipeline(node, workflow, results, adapter);
    case 'log': {
      const msg = String(node.params.message ?? node.params.msg ?? '').trim();
      if (msg) pushRunLog(msg);
      return null;
    }
    default:
      return null; // start/end/branch/loop/variable/codeblock
  }
}

/**
 * Real run: interpret the IR along the exec spine through the local agent CLI.
 * Agent/workflow nodes are single `claude -p` calls; `parallel` fans each branch
 * out as a concurrent call; `pipeline` chains stages sequentially. Outputs stream
 * into the dock, thread to downstream nodes via data edges, and drive per-node
 * run badges. Aborts on 停止; returns to design mode when finished.
 */
async function executeViaCliInterpreter(
  workflow: IRGraph,
  adapter: string,
): Promise<void> {
  const order = topoOrderExec(workflow).filter(isRunnable);
  const results = new Map<string, string>();
  let errored = false;

  for (const node of order) {
    if (!stillRunning()) return; // stopped between steps

    if (node.type === 'start' || node.type === 'end') {
      useStore.getState().setRunState(node.id, 'success');
      continue;
    }

    useStore.getState().setRunState(node.id, 'running');
    pushRunLog(`▸ ${node.label ?? node.type}`);

    try {
      // runNode streams its own labeled message(s) live; we just store the
      // result for downstream data edges.
      const out = await runNode(node, workflow, results, adapter);
      if (!stillRunning()) return; // stopped during the call(s)
      if (out !== null) results.set(node.id, out);
      useStore.getState().setRunState(node.id, 'success');
    } catch (err) {
      pushRunLog(
        `✗ ${node.label ?? node.type} 执行失败: ${(err as Error).message ?? String(err)}`,
        'assistant',
      );
      useStore.getState().setRunState(node.id, 'error');
      errored = true;
      break;
    }
  }

  if (stillRunning()) {
    pushRunLog(errored ? '✗ 运行中断（见上方错误）。' : '✓ 运行完成。', 'assistant');
    useStore.getState().setMode('design'); // clear the "运行中" state
  }
}

/**
 * Browser fallback: walk the exec topological order and animate each runnable
 * node idle → running → success with a short delay, streaming a log line per
 * step. Aborted gracefully when the user clicks "停止" (mode flips to design).
 */
async function executeViaSimulator(workflow: IRGraph): Promise<void> {
  const order = topoOrderExec(workflow).filter(isRunnable);
  const stepDelay = 350;

  for (const node of order) {
    if (useStore.getState().mode !== 'running') return; // user stopped
    useStore.getState().setRunState(node.id, 'running');
    const startLog: Message = {
      id: shortId('m'),
      role: 'system',
      text: `▸ ${node.label ?? node.type} (${node.id})`,
      createdAt: Date.now(),
    };
    useStore.setState((s) => ({ messages: [...s.messages, startLog] }));

    await delay(stepDelay);
    if (useStore.getState().mode !== 'running') return;

    useStore.getState().setRunState(node.id, 'success');
  }

  if (useStore.getState().mode === 'running') {
    const done: Message = {
      id: shortId('m'),
      role: 'assistant',
      text: `✓ 模拟运行完成 · ${order.length} 个节点（浏览器无命令行，未真正执行）`,
      createdAt: Date.now(),
    };
    useStore.setState((s) => ({ messages: [...s.messages, done] }));
    useStore.getState().setMode('design'); // clear the "运行中" state
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* -------------------------------------------------------------------------- */
/* Autosave subscriber                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Debounced autosave: whenever `dirty` flips to true, schedule a write 1.5s
 * later. We re-read the latest store state inside the timer so we always
 * persist the most recent IR (not the one we observed at scheduling time).
 *
 * Strategy:
 *   - If `currentFilePath` is set (and not the localStorage sentinel), write
 *     to that path via the Tauri fs plugin.
 *   - Otherwise (fresh graph, never saved), write to localStorage so a reload
 *     doesn't lose the user's work.
 *
 * On a successful save we call `markSaved(path)` which clears dirty and
 * remembers the path; the toolbar status text reads that flag.
 *
 * Errors are swallowed deliberately: autosave must never crash the editor.
 * The next dirty edit will retry.
 */
const AUTOSAVE_DEBOUNCE_MS = 1500;
let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
let autosaveInFlight = false;

useStore.subscribe((state, prev) => {
  // Only react when `dirty` transitions false -> true. We don't want to keep
  // rescheduling on every graph edit while a save is already pending.
  if (!state.dirty || prev.dirty) return;
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    autosaveTimer = null;
    void runAutosave();
  }, AUTOSAVE_DEBOUNCE_MS);
});

async function runAutosave(): Promise<void> {
  if (autosaveInFlight) return;
  autosaveInFlight = true;
  try {
    const { workflow, currentFilePath } = useStore.getState();
    const path = await autosave(workflow, currentFilePath);
    if (path) useStore.getState().markSaved(path);
  } catch {
    /* swallow: next dirty edit will retry. */
  } finally {
    autosaveInFlight = false;
  }
}
