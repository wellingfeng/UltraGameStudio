import { create } from 'zustand';
import {
  DATA,
  type ConsensusStrategy,
  type IREndpoint,
  type GatewaySelection,
  type IRGraph,
  type IRLayout,
  type IRNode,
  type IRRunSnapshot,
  type IRRunStatus,
  type NodeGatewayOverride,
  type NodeType,
  type PinKind,
} from '@/core/ir';
import {
  autoLayoutGraph,
  hasMissingLayout,
  hasStructuralChanges,
} from '@/core/autoLayout';
import { defaultBlueprint } from '@/core/defaultBlueprint';
import { isEmptyWorkflow } from '@/core/isEmptyWorkflow';
import { applyIntent } from '@/core/intentEngine';
import {
  generationAngles,
  isComplexGenerationRequest,
} from '@/core/consensusHeuristic';
import { genCandidateCount } from '@/lib/consensusSettings';
import {
  effectiveConsensusSamples,
  effectiveGenerationConsensusPlan,
  effectiveRunConcurrency,
  recordModelCall,
  timeoutPolicyForSelection,
} from '@/lib/modelSpeed';
import { appendStartUserInputs } from '@/core/startInputs';
import { isRunnable, topoOrderExec } from '@/core/topo';
import { readApiKey, readBaseUrl } from '@/lib/apiConfig';
import { appendComposerDraftState } from '@/lib/composerEntryPolicy';
import {
  clearActiveGatewaySelection,
  setActiveGatewaySelection as writeStoredGatewaySelection,
} from '@/lib/gatewayConfig';
import { maybeRunCcSwitchAutoImportOnFirstRun } from '@/lib/ccSwitchAutoImport';
import {
  modelClassFromModelId,
  nodeParamsWithGatewayOverride,
  normalizeGatewayWorkflow as migrateWorkflowGateway,
  systemDefaultGatewaySelection,
  workflowDefaultGatewaySelection,
  workflowGatewaySelection,
  withWorkflowGatewaySelection as withGatewayDefaults,
  withoutWorkflowGatewayDefaults,
} from '@/lib/modelGateway/resolver';
import { shortId } from '@/lib/id';
import { translatePromptFields } from '@/lib/promptTranslation';
import { aiEditViaCli, cancelAiCli, isTauri } from '@/lib/tauri';
import {
  applyGatewayOverride,
  completeGatewayText,
  nodeGatewayOverride,
  resolveCliGatewayRoute,
  resolveDirectGatewayRoute,
} from '@/lib/modelGateway/modelGateway';
import {
  UNIFIED_SYSTEM,
  extractJsonObject,
  modelStrategyGuidance,
} from '@/lib/anthropic';
import {
  INTERACTION_PROTOCOL,
  formatAnswerForPrompt,
  liveProse,
  parseInteraction,
  stripInteraction,
  summarizeAnswer,
  type InteractionAnswer,
  type InteractionRequest,
} from '@/core/interaction';
import {
  DEFAULT_LOCALE,
  languageAdaptationPrompt,
  localizePromptGroup,
  localizePromptItem,
  SUPPORTED_LOCALES,
  type Locale,
  withPromptGroupLocale,
  withPromptItemLocale,
} from '@/lib/i18n';
import {
  defaultComposer,
  initialActiveSessionId,
  modelOptions,
  permissionOptions,
  PROMPT_DEFAULT_ITEM_MIGRATIONS,
  PROMPT_DEFAULTS_VERSION,
  samplePromptGroups,
  sampleSessions,
} from './sampleSessions';
import {
  loadComposer,
  loadLocale,
  loadPromptAutoTranslate,
  loadPromptGroups,
  loadPromptGroupsVersion,
  saveComposer,
  saveLocale,
  savePromptAutoTranslate,
  savePromptGroups,
  savePromptGroupsVersion,
} from '@/lib/composerStorage';
import {
  applyAppearance,
  type AppearanceSettings,
  type StylePresetId,
} from '@/lib/appearance';
import { loadAppearance, saveAppearance } from '@/lib/appearanceStorage';
import { autosave, loadLocalWorkflow } from '@/lib/persist';
import {
  historyStore,
  isAutoTitlePlaceholder,
  titleFromText,
} from './history/store';
import {
  HISTORY_SCHEMA_VERSION,
  type SessionMeta,
  type SessionRecord,
  type SessionSummary,
  type WorkspaceSummary,
} from './history/types';
import type {
  CanvasViewport,
  ComposerSettings,
  Message,
  NodeRunState,
  PromptGroup,
  PromptItem,
  SelectOption,
  Session,
  SessionRunStatus,
} from './types';
import {
  selectRunProgress,
  type RunProgressSummary,
} from './runProgress';

export { selectRunProgress } from './runProgress';
export type { RunProgressSummary } from './runProgress';

export type WorkflowSessionKey = {
  workspaceId: string | null;
  sessionId: string | null;
};

/**
 * CONTRACT: the single zustand store. App.tsx and panels rely on this exact
 * surface — keep these fields and actions stable.
 *
 * State (pre-existing, unchanged):
 *   workflow, selectedNodeId,
 *   sessions, activeSessionId, messages, promptGroups,
 *   composer, composerDraft, composerDrafts, permissionOptions, modelOptions,
 *   workspaceHistory,
 *   appearance
 * State (added this milestone):
 *   mode ('design'|'running'), runState (Record<id,NodeRunState>),
 *   dirty (boolean), currentFilePath (string|null)
 *
 * Actions (pre-existing, unchanged signatures):
 *   selectNode(id), setWorkflow(ir), setAdapter(id), runWorkflow(),
 *   newWorkflow(), newSession(), sendPrompt(text), setComposer(patch),
 *   setComposerDraft(text), appendComposerDraft(text), setWorkspace(path),
 *   setStylePresetId(stylePresetId)
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
  runOutputs: Record<string, string>;
  lastRunFailedNodeId: string | null;
  canvasViewport: CanvasViewport | null;
  dirty: boolean;
  currentFilePath: string | null;

  // AI state (browser-direct streaming).
  /** True while an AI request is streaming in (drives loading + disables send). */
  aiStreaming: boolean;
  /**
   * Session-bound workflow edits currently owned by the AI-input dock. This is
   * the source for blueprint read-only locking and Sidebar live badges; keep
   * `aiStreaming` as request/loading state only.
   */
  aiEditingSessions: WorkflowSessionKey[];

  // Session / UI state
  sessions: Session[];
  activeSessionId: string | null;
  messages: Message[];
  promptGroups: PromptGroup[];
  locale: Locale;
  promptAutoTranslate: boolean;
  appearance: AppearanceSettings;

  // Composer (AI-input) state — pure UI, never enters the IRGraph.
  composer: ComposerSettings;
  /** Current text in the AI input box. Pure UI state; not persisted. */
  composerDraft: string;
  /** Per-session draft cache so unsent text stays with its workflow session. */
  composerDrafts: Record<string, string>;
  /** Incremented when another panel asks the AI input box to focus itself. */
  composerFocusVersion: number;
  permissionOptions: SelectOption[];
  modelOptions: SelectOption[];
  /** Previously-selected workspace folders, most-recent-first. */
  workspaceHistory: string[];
  /** True once `.worktree` history has been loaded or gracefully skipped. */
  historyReady: boolean;
  /** Resolved `.worktree` root path for diagnostics. */
  historyRootPath: string | null;
  /** Workspace buckets rendered as the first level of the history tree. */
  workspaces: WorkspaceSummary[];
  /** Session summaries grouped by workspace id for the Sidebar tree. */
  sessionTree: Record<string, Session[]>;
  /** Currently selected workspace bucket. */
  activeWorkspaceId: string | null;
  /**
   * Workflow sessions that are currently executing. A run is bound to its owning
   * session (not the active view), so it keeps running in the background when the
   * user switches sessions. Drives the Sidebar "running" badges. See the
   * `RunChannel` machinery below.
   */
  runningSessions: WorkflowSessionKey[];
  /** Lightweight live progress keyed by the owning workflow session. */
  runningSessionProgress: Record<string, RunProgressSummary>;
  /**
   * Compatibility marker for older UI code: the first currently executing
   * session, or null when nothing is running. Prefer `runningSessions`.
   */
  runningSessionId: string | null;
  /** Workspace id of `runningSessionId`. Prefer `runningSessions`. */
  runningWorkspaceId: string | null;

  // Actions
  initHistory: () => void;
  setLocale: (locale: Locale) => void;
  setPromptAutoTranslate: (enabled: boolean) => void;
  setStylePresetId: (stylePresetId: StylePresetId) => void;
  selectNode: (id: string | null) => void;
  setWorkflow: (ir: IRGraph) => void;
  openWorkflowSession: (ir: IRGraph, path?: string) => void;
  setAdapter: (adapter: string) => void;
  setGlobalRunSelection: (selection: GatewaySelection) => void;
  /** Clear the composer model pin so it inherits the Settings-active provider. */
  clearGlobalRunSelection: () => void;
  runWorkflow: () => void;
  resumeWorkflow: () => void;
  stopWorkflow: () => void;
  newWorkflow: () => void;
  newSession: () => void;
  selectSession: (sessionId: string, workspaceId?: string) => void;
  deleteSession: (sessionId: string, workspaceId?: string) => void;
  sendPrompt: (text: string) => void;
  /**
   * Submit the user's answer to an interactive node message (the AI-return dock
   * widget). Marks the message answered and unblocks the waiting run node so it
   * can continue with the user's choice/input. See core/interaction.ts.
   */
  answerInteraction: (messageId: string, answer: InteractionAnswer) => void;
  /**
   * Skip a pending interaction without answering it (the widget's "跳过"). Marks
   * it cancelled and unblocks the waiting loop with a null answer — a node ends
   * quietly; the AI editor proceeds with what it has. See core/interaction.ts.
   */
  dismissInteraction: (messageId: string) => void;
  setComposer: (patch: Partial<ComposerSettings>) => void;
  setComposerDraft: (text: string) => void;
  appendComposerDraft: (text: string) => void;
  setWorkspace: (path: string) => void;

  // Graph editing
  addNode: (
    type: NodeType,
    params?: Record<string, unknown>,
    parent?: string,
  ) => string;
  updateNodeParams: (id: string, patch: Record<string, unknown>) => void;
  updateNodeGatewayOverride: (
    id: string,
    override: NodeGatewayOverride | null,
  ) => void;
  updateNodeLabel: (id: string, label: string) => void;
  removeNode: (id: string) => void;
  addEdge: (from: IREndpoint, to: IREndpoint, kind: PinKind) => string;
  removeEdge: (id: string) => void;
  setNodePosition: (id: string, x: number, y: number) => void;

  // Run / mode control
  setMode: (mode: 'design' | 'running') => void;
  setRunState: (id: string, state: NodeRunState) => void;
  resetRunState: () => void;
  setCanvasViewport: (viewport: CanvasViewport | null) => void;

  // Whole-graph + persistence
  applyGraphEdit: (ir: IRGraph) => void;
  markSaved: (path?: string) => void;

  // Session-type marker: flip the active session's isWorkflow flag to true.
  // Locked — once true, it stays true (mirrors the SessionRecord contract in
  // history-store-spec.md §4.3). Called from every action that touches the
  // workflow blueprint so pure-chat sessions stay false.
  markActiveSessionAsWorkflow: () => void;

  // Prompt-library CRUD (persisted to localStorage)
  addPromptItem: (
    groupId: string,
    label: string,
    text: string,
    locale?: Locale,
  ) => void;
  updatePromptItem: (
    groupId: string,
    itemId: string,
    patch: Partial<PromptItem>,
  ) => void;
  updatePromptItemLocalized: (
    groupId: string,
    itemId: string,
    patch: Partial<PromptItem>,
    locale?: Locale,
  ) => Promise<boolean>;
  removePromptItem: (groupId: string, itemId: string) => void;
  addPromptGroup: (label: string, locale?: Locale) => string;
  updatePromptGroup: (groupId: string, label: string) => void;
  updatePromptGroupLocalized: (
    groupId: string,
    label: string,
    locale?: Locale,
  ) => Promise<boolean>;
  removePromptGroup: (groupId: string) => void;
  resetPromptGroups: () => void;
}

export type WorkflowReadOnlyReason = 'running' | 'aiEditing';
export type SessionLiveStatus = 'running' | 'aiEditing' | null;

type WorkflowWriteSource = 'user' | 'ai';
type WorkflowSessionState = Pick<
  StoreState,
  'activeWorkspaceId' | 'activeSessionId'
>;
type WorkflowReadOnlyState = Pick<
  StoreState,
  'mode' | 'activeWorkspaceId' | 'activeSessionId' | 'aiEditingSessions'
>;
type ComposerDraftState = Pick<
  StoreState,
  'activeWorkspaceId' | 'activeSessionId' | 'composerDraft' | 'composerDrafts'
>;
type SessionLiveStatusState = Pick<
  StoreState,
  'runningSessions' | 'aiEditingSessions'
>;

function activeWorkflowSessionKey(
  state: WorkflowSessionState,
): WorkflowSessionKey {
  return {
    workspaceId: state.activeWorkspaceId ?? null,
    sessionId: state.activeSessionId ?? null,
  };
}

function sameSessionKey(
  a: WorkflowSessionKey,
  b: WorkflowSessionKey,
): boolean {
  return a.workspaceId === b.workspaceId && a.sessionId === b.sessionId;
}

function hasSessionKey(
  sessions: WorkflowSessionKey[],
  key: WorkflowSessionKey,
): boolean {
  return sessions.some((item) => sameSessionKey(item, key));
}

export function workflowSessionKeyId(sessionKey: WorkflowSessionKey): string {
  return `${sessionKey.workspaceId ?? ''}::${sessionKey.sessionId ?? ''}`;
}

function composerDraftForSession(
  drafts: Record<string, string>,
  sessionKey: WorkflowSessionKey,
): string {
  return drafts[workflowSessionKeyId(sessionKey)] ?? '';
}

function composerDraftPatchForSession(
  state: ComposerDraftState,
  sessionKey: WorkflowSessionKey,
): Pick<StoreState, 'composerDraft' | 'composerDrafts'> {
  const currentKey = workflowSessionKeyId(activeWorkflowSessionKey(state));
  const composerDrafts =
    state.composerDrafts[currentKey] === state.composerDraft
      ? state.composerDrafts
      : { ...state.composerDrafts, [currentKey]: state.composerDraft };
  return {
    composerDrafts,
    composerDraft: composerDraftForSession(composerDrafts, sessionKey),
  };
}

export function isActiveAiEditingSession(
  state: WorkflowReadOnlyState,
): boolean {
  return hasSessionKey(
    state.aiEditingSessions,
    activeWorkflowSessionKey(state),
  );
}

export function workflowReadOnlyReason(
  state: WorkflowReadOnlyState,
): WorkflowReadOnlyReason | null {
  if (state.mode === 'running') return 'running';
  if (isActiveAiEditingSession(state)) return 'aiEditing';
  return null;
}

export function isWorkflowMutable(state: WorkflowReadOnlyState): boolean {
  return workflowReadOnlyReason(state) === null;
}

export function isWorkflowReadOnly(state: WorkflowReadOnlyState): boolean {
  return !isWorkflowMutable(state);
}

function canWriteWorkflow(
  state: WorkflowReadOnlyState,
  source: WorkflowWriteSource = 'user',
  sessionKey?: WorkflowSessionKey,
): boolean {
  if (
    sessionKey &&
    !sameSessionKey(activeWorkflowSessionKey(state), sessionKey)
  ) {
    return false;
  }
  const reason = workflowReadOnlyReason(state);
  return reason === null || (reason === 'aiEditing' && source === 'ai');
}

export function sessionLiveStatus(
  sessionKey: WorkflowSessionKey,
  state: SessionLiveStatusState,
): SessionLiveStatus {
  if (hasSessionKey(state.runningSessions, sessionKey)) return 'running';
  if (hasSessionKey(state.aiEditingSessions, sessionKey)) return 'aiEditing';
  return null;
}

const WORKSPACE_HISTORY_LIMIT = 8;
const CANVAS_VIEWPORT_PERSIST_DEBOUNCE_MS = 250;

const canvasViewportPersistTimers = new Map<
  string,
  ReturnType<typeof setTimeout>
>();
const canvasViewportMemory = new Map<string, CanvasViewport | null>();

/**
 * Per-type default label + params used by addNode. Mirrors the node catalogue
 * in the design doc; agent/control nodes carry their minimal editable params.
 */
const NODE_DEFAULTS: Record<
  NodeType,
  { label: string; params: Record<string, unknown> }
> = {
  start: { label: 'Start', params: { userInputs: [] } },
  end: { label: 'End', params: {} },
  agent: { label: '描述你的步骤', params: {} },
  parallel: { label: '并行', params: { branches: [] } },
  pipeline: { label: '流水线', params: { items: 'args', stages: [] } },
  phase: { label: '阶段', params: { title: '阶段' } },
  branch: { label: '分支', params: { condition: 'true' } },
  loop: { label: '循环', params: { condition: 'false' } },
  workflow: { label: '子工作流', params: { name: 'sub' } },
  log: { label: '日志', params: { message: '' } },
  variable: { label: '变量', params: { value: null } },
  codeblock: { label: '代码块', params: { code: '' } },
  consensus: { label: '共识', params: { voters: [], strategy: 'multi-lens' } },
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

function patchParams(
  params: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...params };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  return next;
}

function promptTranslationGatewayOptions(state: StoreState): {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  adapter?: string;
  selection?: GatewaySelection;
} {
  const selection = workflowGatewaySelection(state.workflow, state.composer.model);
  const direct = resolveDirectGatewayRoute(selection);
  return {
    selection,
    apiKey: (direct?.apiKey ?? readApiKey()) || undefined,
    baseUrl: (direct?.baseUrl ?? readBaseUrl()) || undefined,
    model: direct?.model ?? selection.modelClass,
    adapter: direct?.adapter ?? selection.adapter,
  };
}

function makeSession(locale: Locale = DEFAULT_LOCALE): Session {
  const ts = Date.now();
  return {
    id: shortId('s'),
    title: locale === 'en-US' ? 'New Session' : '新会话',
    createdAt: ts,
    updatedAt: ts,
    // New sessions default to chat-type; the first workflow touch flips this on.
    isWorkflow: false,
  };
}

function historySessionRunStatus(
  status?: unknown,
): SessionRunStatus | undefined {
  if (!isRunStatus(status) || status === 'idle') return undefined;
  return persistedStatusForDisplay(status) as SessionRunStatus;
}

function sessionFromSummary(summary: SessionSummary): Session {
  const runStatus = historySessionRunStatus(summary.runStatus);
  return {
    id: summary.id,
    workspaceId: summary.workspaceId,
    title: summary.title,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    isWorkflow: summary.isWorkflow,
    preview: summary.preview,
    messageCount: summary.messageCount,
    ...(runStatus ? { runStatus } : {}),
  };
}

function summaryFromRecord(record: SessionRecord): SessionSummary {
  const last = record.messages[record.messages.length - 1]?.text?.trim();
  const runStatus = record.meta?.runStatus;
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    title: record.title,
    isWorkflow: record.isWorkflow,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    preview: last ? last.slice(0, 80) : undefined,
    messageCount: record.messages.length,
    ...(runStatus ? { runStatus } : {}),
  };
}

function sessionFromRecord(record: SessionRecord): Session {
  return sessionFromSummary(summaryFromRecord(record));
}

async function loadSessionTree(
  workspaces: WorkspaceSummary[],
): Promise<Record<string, Session[]>> {
  const pairs = await Promise.all(
    workspaces.map(async (workspace) => {
      const sessions = await historyStore.listSessions(workspace.id);
      return [workspace.id, sessions.map((item) => sessionFromSummary(item))] as const;
    }),
  );
  return Object.fromEntries(pairs);
}

function getActiveHistoryContext():
  | { workspaceId: string; sessionId: string }
  | null {
  const state = useStore.getState();
  if (!state.historyReady) return null;
  if (!state.activeWorkspaceId || !state.activeSessionId) return null;
  return {
    workspaceId: state.activeWorkspaceId,
    sessionId: state.activeSessionId,
  };
}

async function persistMessage(msg: Message): Promise<void> {
  const ctx = getActiveHistoryContext();
  if (!ctx) return;
  await historyStore.appendMessage(ctx.workspaceId, ctx.sessionId, msg);
}

async function persistCurrentMessages(): Promise<void> {
  const ctx = getActiveHistoryContext();
  if (!ctx) return;
  const state = useStore.getState();
  await historyStore.updateSession(ctx.workspaceId, ctx.sessionId, {
    messages: state.messages,
  });
}

function historySessionKey(workspaceId: string, sessionId: string): string {
  return `${workspaceId}::${sessionId}`;
}

function normalizeCanvasViewport(
  viewport: CanvasViewport | null | undefined,
): CanvasViewport | null {
  if (!viewport) return null;
  const x = Number(viewport.x);
  const y = Number(viewport.y);
  const zoom = Number(viewport.zoom);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(zoom) || zoom <= 0) {
    return null;
  }
  return {
    x: Math.round(x * 100) / 100,
    y: Math.round(y * 100) / 100,
    zoom: Math.round(zoom * 1000) / 1000,
  };
}

function canvasViewportFromMeta(meta?: SessionMeta): CanvasViewport | null {
  return normalizeCanvasViewport(
    (meta?.canvasViewport as CanvasViewport | null | undefined) ?? null,
  );
}

function canvasViewportForSession(
  workspaceId: string,
  sessionId: string,
  meta?: SessionMeta,
): CanvasViewport | null {
  const key = historySessionKey(workspaceId, sessionId);
  if (canvasViewportMemory.has(key)) {
    return canvasViewportMemory.get(key) ?? null;
  }
  return canvasViewportFromMeta(meta);
}

function sameCanvasViewport(
  a: CanvasViewport | null,
  b: CanvasViewport | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.x === b.x && a.y === b.y && a.zoom === b.zoom;
}

function scheduleCanvasViewportPersist(
  workspaceId: string,
  sessionId: string,
  viewport: CanvasViewport | null,
): void {
  const key = historySessionKey(workspaceId, sessionId);
  const timer = canvasViewportPersistTimers.get(key);
  if (timer) clearTimeout(timer);
  const nextViewport = normalizeCanvasViewport(viewport);
  canvasViewportMemory.set(key, nextViewport);
  canvasViewportPersistTimers.set(
    key,
    setTimeout(() => {
      canvasViewportPersistTimers.delete(key);
      void historyStore
        .updateSession(workspaceId, sessionId, {
          meta: { canvasViewport: nextViewport },
        })
        .catch(() => undefined);
    }, CANVAS_VIEWPORT_PERSIST_DEBOUNCE_MS),
  );
}

function updateSessionRunStatus(
  state: StoreState,
  sessionKey: WorkflowSessionKey,
  runStatus: SessionRunStatus | undefined,
): Pick<StoreState, 'sessions' | 'sessionTree'> | null {
  const matchesSession = (session: Session): boolean => {
    if (session.id !== sessionKey.sessionId) return false;
    if (
      sessionKey.workspaceId !== null &&
      session.workspaceId !== undefined &&
      session.workspaceId !== sessionKey.workspaceId
    ) {
      return false;
    }
    return true;
  };

  let sessionsChanged = false;
  const nextSessions = state.sessions.map((session) => {
    if (!matchesSession(session) || session.runStatus === runStatus) return session;
    sessionsChanged = true;
    return runStatus ? { ...session, runStatus } : { ...session, runStatus: undefined };
  });

  let sessionTreeChanged = false;
  let nextSessionTree = state.sessionTree;
  if (sessionKey.workspaceId !== null) {
    const current = state.sessionTree[sessionKey.workspaceId];
    if (current) {
      const mapped = current.map((session) => {
        if (!matchesSession(session) || session.runStatus === runStatus) return session;
        sessionTreeChanged = true;
        return runStatus
          ? { ...session, runStatus }
          : { ...session, runStatus: undefined };
      });
      if (sessionTreeChanged) {
        nextSessionTree = {
          ...state.sessionTree,
          [sessionKey.workspaceId]: mapped,
        };
      }
    }
  }

  if (!sessionsChanged && !sessionTreeChanged) return null;
  return {
    sessions: sessionsChanged ? nextSessions : state.sessions,
    sessionTree: sessionTreeChanged ? nextSessionTree : state.sessionTree,
  };
}

function syncSessionRunStatus(
  sessionKey: WorkflowSessionKey,
  status: IRRunStatus | undefined,
): void {
  const runStatus = historySessionRunStatus(status);
  useStore.setState((state) => updateSessionRunStatus(state, sessionKey, runStatus) ?? state);
}

function markLocalActiveSessionWorkflow(): void {
  useStore.setState((state) => {
    const sessions = markedSessions(state.sessions, state.activeSessionId);
    if (sessions === state.sessions) return state;
    return {
      sessions,
      sessionTree: state.activeWorkspaceId
        ? { ...state.sessionTree, [state.activeWorkspaceId]: sessions }
        : state.sessionTree,
    };
  });
}

async function markActiveHistorySessionWorkflow(): Promise<void> {
  markLocalActiveSessionWorkflow();
  const ctx = getActiveHistoryContext();
  if (!ctx) return;
  await historyStore.updateSession(ctx.workspaceId, ctx.sessionId, {
    isWorkflow: true,
  });
}

async function persistActiveWorkflowSnapshot(
  ir?: IRGraph,
  meta?: Partial<SessionMeta>,
): Promise<void> {
  markLocalActiveSessionWorkflow();
  if (meta && 'runStatus' in meta && meta.runStatus !== 'running') {
    const state = useStore.getState();
    syncSessionRunStatus(activeWorkflowSessionKey(state), meta.runStatus);
  }
  const ctx = getActiveHistoryContext();
  if (!ctx) return;
  const state = useStore.getState();
  const workflow = ir ?? state.workflow;
  await historyStore.setSessionWorkflow(ctx.workspaceId, ctx.sessionId, workflow);
  if (meta) {
    await historyStore.updateSession(ctx.workspaceId, ctx.sessionId, {
      meta,
    });
  }
}

function runOutputsFromMeta(meta?: SessionMeta): Record<string, string> {
  const raw = meta?.runOutputs;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

function isRunStatus(value: unknown): value is IRRunStatus {
  return (
    value === 'idle' ||
    value === 'running' ||
    value === 'success' ||
    value === 'error' ||
    value === 'interrupted'
  );
}

function persistedStatusForDisplay(status: IRRunStatus): NodeRunState {
  // A reopened workflow cannot still be executing inside this UI session.
  return status === 'running' ? 'interrupted' : status;
}

function runOutputsFromSnapshot(
  snapshot?: IRRunSnapshot,
): Record<string, string> {
  const raw = snapshot?.outputs;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

function runSnapshotFromMeta(meta?: SessionMeta): IRRunSnapshot | null {
  if (!meta) return null;
  const hasRunData =
    !!meta.runStatus ||
    !!meta.runState ||
    !!meta.runOutputs ||
    typeof meta.failedNodeId === 'string' ||
    !!meta.runError;
  if (!hasRunData) return null;
  return {
    status: isRunStatus(meta.runStatus) ? meta.runStatus : 'idle',
    nodeStates: meta.runState,
    outputs: runOutputsFromMeta(meta),
    failedNodeId:
      typeof meta.failedNodeId === 'string' ? meta.failedNodeId : null,
    error: meta.runError ?? null,
  };
}

function runProgressFromSnapshot(
  workflow: IRGraph,
  snapshot?: IRRunSnapshot | null,
): Pick<StoreState, 'runState' | 'runOutputs' | 'lastRunFailedNodeId'> {
  if (!snapshot) return emptyRunProgress();

  const nodeIds = new Set(workflow.nodes.map((node) => node.id));
  const runOutputs = Object.fromEntries(
    Object.entries(runOutputsFromSnapshot(snapshot)).filter(([nodeId]) =>
      nodeIds.has(nodeId),
    ),
  );
  const runState: Record<string, NodeRunState> = {};

  for (const nodeId of Object.keys(runOutputs)) {
    runState[nodeId] = 'success';
  }

  const rawNodeStates = snapshot.nodeStates;
  if (
    rawNodeStates &&
    typeof rawNodeStates === 'object' &&
    !Array.isArray(rawNodeStates)
  ) {
    for (const [nodeId, status] of Object.entries(rawNodeStates)) {
      if (!nodeIds.has(nodeId) || !isRunStatus(status) || status === 'idle') {
        continue;
      }
      runState[nodeId] = persistedStatusForDisplay(status);
    }
  }

  const preferredFailedNodeId =
    typeof snapshot.failedNodeId === 'string' &&
    nodeIds.has(snapshot.failedNodeId)
      ? snapshot.failedNodeId
      : null;
  const lastRunFailedNodeId =
    preferredFailedNodeId ??
    Object.entries(runState).find(
      ([, status]) =>
        status === 'error' ||
        status === 'interrupted' ||
        status === 'running',
    )?.[0] ??
    null;

  if (lastRunFailedNodeId && runState[lastRunFailedNodeId] == null) {
    runState[lastRunFailedNodeId] =
      snapshot.status === 'interrupted' || snapshot.status === 'running'
        ? 'interrupted'
        : 'error';
  }

  return { runState, runOutputs, lastRunFailedNodeId };
}

function emptyRunProgress(): Pick<
  StoreState,
  'runState' | 'runOutputs' | 'lastRunFailedNodeId'
> {
  return { runState: {}, runOutputs: {}, lastRunFailedNodeId: null };
}

function emptyRunMeta(): Partial<SessionMeta> {
  return {
    runStatus: 'idle',
    runState: {},
    runOutputs: {},
    failedNodeId: null,
    runError: null,
  };
}

function applyWorkflowEdit(
  source: WorkflowWriteSource,
  edit: (
    state: StoreState,
  ) => (Partial<
    Pick<
      StoreState,
      | 'selectedNodeId'
      | 'dirty'
      | 'runState'
      | 'runOutputs'
      | 'lastRunFailedNodeId'
    >
  > & { workflow: IRGraph }) | null,
  persistMeta: Partial<SessionMeta> = emptyRunMeta(),
  sessionKey?: WorkflowSessionKey,
): boolean {
  let committed = false;
  let nextWorkflow: IRGraph | null = null;

  useStore.setState((state) => {
    if (!canWriteWorkflow(state, source, sessionKey)) return state;
    const patch = edit(state);
    if (!patch) return state;

    committed = true;
    nextWorkflow = patch.workflow;

    const next: Partial<StoreState> = { workflow: patch.workflow };
    if (patch.selectedNodeId !== undefined) {
      next.selectedNodeId = patch.selectedNodeId;
    }
    if (patch.dirty !== undefined) next.dirty = patch.dirty;
    if (patch.runState !== undefined) next.runState = patch.runState;
    if (patch.runOutputs !== undefined) next.runOutputs = patch.runOutputs;
    if (patch.lastRunFailedNodeId !== undefined) {
      next.lastRunFailedNodeId = patch.lastRunFailedNodeId;
    }
    return next;
  });

  if (committed && nextWorkflow) {
    void persistActiveWorkflowSnapshot(nextWorkflow, persistMeta);
  }
  return committed;
}

function workflowWithoutRunSnapshot(workflow: IRGraph): IRGraph {
  if (!workflow.meta.run) return workflow;
  const meta = { ...workflow.meta };
  delete meta.run;
  return { ...workflow, meta };
}

function workflowWithRunSnapshot(
  workflow: IRGraph,
  snapshot: IRRunSnapshot,
): IRGraph {
  const hasState = snapshot.nodeStates && Object.keys(snapshot.nodeStates).length > 0;
  const hasOutputs = snapshot.outputs && Object.keys(snapshot.outputs).length > 0;
  if (
    snapshot.status === 'idle' &&
    !hasState &&
    !hasOutputs &&
    !snapshot.failedNodeId &&
    !snapshot.error
  ) {
    return workflowWithoutRunSnapshot(workflow);
  }
  return { ...workflow, meta: { ...workflow.meta, run: snapshot } };
}

function prepareGraphEdit(currentWorkflow: IRGraph, ir: IRGraph): IRGraph {
  const trustedLayout: IRLayout = {};
  for (const node of ir.nodes) {
    const pos = currentWorkflow.layout?.[node.id];
    if (pos) trustedLayout[node.id] = { x: pos.x, y: pos.y };
  }
  const irWithTrustedLayout = { ...ir, layout: trustedLayout };
  const shouldRelayout =
    hasStructuralChanges(currentWorkflow, ir) ||
    hasMissingLayout(irWithTrustedLayout);
  let nextWorkflow = shouldRelayout
    ? autoLayoutGraph(irWithTrustedLayout, currentWorkflow, { relayout: 'all' })
    : irWithTrustedLayout;
  nextWorkflow = workflowWithoutRunSnapshot(nextWorkflow);
  if (
    !nextWorkflow.meta.gateway?.defaults &&
    currentWorkflow.meta.gateway?.defaults
  ) {
    nextWorkflow = withGatewayDefaults(
      nextWorkflow,
      currentWorkflow.meta.gateway.defaults,
    );
  }
  return nextWorkflow;
}

function commitGraphEdit(
  ir: IRGraph,
  source: WorkflowWriteSource = 'user',
  sessionKey?: WorkflowSessionKey,
): boolean {
  let nextWorkflow = ir;
  return applyWorkflowEdit(source, (state) => {
    nextWorkflow = prepareGraphEdit(state.workflow, ir);
    return {
      workflow: nextWorkflow,
      selectedNodeId: null,
      dirty: true,
      ...emptyRunProgress(),
    };
  }, emptyRunMeta(), sessionKey);
}

function runSnapshotFromState(
  state: StoreState,
  status?: IRRunStatus,
  error: Record<string, unknown> | null = null,
): IRRunSnapshot {
  const nodeStates = Object.fromEntries(
    Object.entries(state.runState).filter(([, nodeStatus]) => nodeStatus !== 'idle'),
  );
  const outputs = Object.fromEntries(
    Object.entries(state.runOutputs).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
  const inferredStatus =
    state.mode === 'running'
      ? 'running'
      : Object.values(state.runState).some((nodeStatus) => nodeStatus === 'error')
        ? 'error'
        : Object.values(state.runState).some(
              (nodeStatus) => nodeStatus === 'interrupted',
            )
          ? 'interrupted'
          : Object.keys(nodeStates).length > 0
            ? 'success'
            : 'idle';
  return {
    status: status ?? inferredStatus,
    nodeStates,
    outputs,
    failedNodeId: state.lastRunFailedNodeId,
    error,
    route: workflowDefaultGatewaySelection(
      state.workflow,
      state.composer.model,
    ),
    updatedAt: Date.now(),
  };
}

function runMetaFromSnapshot(snapshot: IRRunSnapshot): Partial<SessionMeta> {
  return {
    runStatus: snapshot.status,
    runState: snapshot.nodeStates ?? {},
    runOutputs: snapshot.outputs ?? {},
    failedNodeId: snapshot.failedNodeId ?? null,
    runError: snapshot.error ?? null,
  };
}

function restoreWorkflowRunSnapshot(
  workflow: IRGraph,
  meta?: SessionMeta,
): IRGraph {
  const migrated = migrateWorkflowGateway(workflow, defaultComposer.model);
  const source = runSnapshotFromMeta(meta) ?? migrated.meta.run ?? null;
  if (!source) return workflowWithoutRunSnapshot(migrated);
  const progress = runProgressFromSnapshot(migrated, source);
  return workflowWithRunSnapshot(migrated, {
    status: source.status === 'running' ? 'interrupted' : source.status,
    nodeStates: progress.runState,
    outputs: progress.runOutputs,
    failedNodeId: progress.lastRunFailedNodeId,
    error: source.error ?? null,
    updatedAt: source.updatedAt ?? Date.now(),
  });
}

async function persistWorkflowRunSnapshot(
  workflow: IRGraph,
  snapshot: IRRunSnapshot,
): Promise<void> {
  const nextWorkflow = workflowWithRunSnapshot(workflow, snapshot);
  const currentPath = useStore.getState().currentFilePath;
  await persistActiveWorkflowSnapshot(nextWorkflow, runMetaFromSnapshot(snapshot));
  const path = await autosave(nextWorkflow, currentPath);
  if (path) useStore.getState().markSaved(path);
}


function previewFromText(text: string): string {
  const compact = text.trim().replace(/\s+/g, ' ');
  return compact.length > 80 ? `${compact.slice(0, 80)}...` : compact;
}

function applyPromptTitle(
  state: StoreState,
  text: string,
  createdAt: number,
): {
  sessions: Session[];
  sessionTree: Record<string, Session[]>;
  workflow: IRGraph;
} {
  const activeSessionId = state.activeSessionId;
  if (!activeSessionId) {
    return {
      sessions: state.sessions,
      sessionTree: state.sessionTree,
      workflow: state.workflow,
    };
  }

  const title = titleFromText(text);
  const activeSession = state.sessions.find((session) => session.id === activeSessionId);
  const renameSession = activeSession
    ? isAutoTitlePlaceholder(activeSession.title)
    : false;
  const renameWorkflow =
    !!activeSession?.isWorkflow &&
    isAutoTitlePlaceholder(state.workflow.meta.name);

  const updateSession = (session: Session): Session => {
    if (session.id !== activeSessionId) return session;
    return {
      ...session,
      title: renameSession ? title : session.title,
      updatedAt: createdAt,
      preview: previewFromText(text),
      messageCount: (session.messageCount ?? 0) + 1,
    };
  };

  const sessions = state.sessions.map(updateSession);
  const sessionTree = state.activeWorkspaceId
    ? {
        ...state.sessionTree,
        [state.activeWorkspaceId]: (
          state.sessionTree[state.activeWorkspaceId] ?? state.sessions
        ).map(updateSession),
      }
    : state.sessionTree;
  const workflow = renameWorkflow
    ? { ...state.workflow, meta: { ...state.workflow.meta, name: title } }
    : state.workflow;

  return { sessions, sessionTree, workflow };
}

async function createNewChatSession(): Promise<void> {
  const state = useStore.getState();
  const workspaceId = state.activeWorkspaceId;
  if (!state.historyReady || !workspaceId) {
    const session = makeSession(state.locale);
    useStore.setState((s) => ({
      sessions: [session, ...s.sessions],
      activeSessionId: session.id,
      messages: [],
      canvasViewport: null,
      ...composerDraftPatchForSession(s, {
        workspaceId: s.activeWorkspaceId ?? null,
        sessionId: session.id,
      }),
    }));
    return;
  }

  const record = await historyStore.createSession({
    workspaceId,
    isWorkflow: false,
    messages: [],
    title: state.locale === 'en-US' ? 'New Session' : '新会话',
  });
  const session = sessionFromRecord(record);
  const workspaces = await historyStore.listWorkspaces();
  const sessionTree = await loadSessionTree(workspaces);
  useStore.setState((s) => ({
    workspaces,
    sessions: sessionTree[workspaceId] ?? [session],
    sessionTree,
    activeSessionId: session.id,
    messages: [],
    canvasViewport: null,
    ...composerDraftPatchForSession(s, {
      workspaceId,
      sessionId: session.id,
    }),
  }));
  await historyStore.patchConfig({
    lastActiveWorkspaceId: workspaceId,
    lastActiveSessionId: session.id,
  });
}

async function createNewWorkflowSession(): Promise<void> {
  const state = useStore.getState();
  const workspaceId = state.activeWorkspaceId;
  const workflow = defaultBlueprint(undefined, state.locale);
  const title =
    workflow.meta.name ??
    (state.locale === 'en-US' ? 'New Workflow' : '新建工作流');
  if (state.mode === 'running' || isActiveAiEditingSession(state)) {
    await openWorkflowInSession(workflow);
    return;
  }
  if (!state.historyReady || !workspaceId) {
    useStore.setState((s) => ({
      workflow,
      selectedNodeId: null,
      dirty: false,
      runState: {},
      runOutputs: {},
      lastRunFailedNodeId: null,
      canvasViewport: null,
      mode: 'design',
      composerDrafts: {
        ...s.composerDrafts,
        [workflowSessionKeyId({
          workspaceId: s.activeWorkspaceId ?? null,
          sessionId: s.activeSessionId,
        })]: '',
      },
      composerDraft: '',
    }));
    return;
  }

  const record = await historyStore.createSession({
    workspaceId,
    isWorkflow: true,
    workflow,
    title,
  });
  const session = sessionFromRecord(record);
  const workspaces = await historyStore.listWorkspaces();
  const sessionTree = await loadSessionTree(workspaces);
  useStore.setState((s) => ({
    workflow,
    selectedNodeId: null,
    dirty: false,
    runState: {},
    runOutputs: {},
    lastRunFailedNodeId: null,
    canvasViewport: null,
    mode: 'design',
    workspaces,
    sessions: sessionTree[workspaceId] ?? [session],
    sessionTree,
    activeSessionId: session.id,
    messages: [],
    ...composerDraftPatchForSession(s, {
      workspaceId,
      sessionId: session.id,
    }),
  }));
  await historyStore.patchConfig({
    lastActiveWorkspaceId: workspaceId,
    lastActiveSessionId: session.id,
  });
}

async function openWorkflowInSession(ir: IRGraph, path?: string): Promise<void> {
  const state = useStore.getState();
  const workflow = restoreWorkflowRunSnapshot(
    migrateWorkflowGateway(ir, defaultComposer.model),
  );
  const runProgress = runProgressFromSnapshot(workflow, workflow.meta.run ?? null);
  const title =
    workflow.meta.name ??
    (state.locale === 'en-US' ? 'Workflow' : '工作流');

  if (!isWorkflowReadOnly(state)) {
    applyWorkflowEdit(
      'user',
      () => ({ workflow, ...runProgress }),
      workflow.meta.run ? runMetaFromSnapshot(workflow.meta.run) : emptyRunMeta(),
    );
    useStore.getState().markSaved(path);
    return;
  }

  const workspaceId = state.activeWorkspaceId;
  if (!state.historyReady || !workspaceId) {
    const createdAt = Date.now();
    const session: Session = {
      id: shortId('s'),
      title,
      createdAt,
      updatedAt: createdAt,
      isWorkflow: true,
    };
    useStore.setState((s) => ({
      workflow,
      selectedNodeId: null,
      dirty: false,
      runState: runProgress.runState,
      runOutputs: runProgress.runOutputs,
      lastRunFailedNodeId: runProgress.lastRunFailedNodeId,
      canvasViewport: null,
      mode: 'design',
      currentFilePath: path ?? null,
      sessions: [session, ...s.sessions],
      activeSessionId: session.id,
      messages: [],
      ...composerDraftPatchForSession(s, {
        workspaceId: s.activeWorkspaceId ?? null,
        sessionId: session.id,
      }),
    }));
    return;
  }

  const record = await historyStore.createSession({
    workspaceId,
    isWorkflow: true,
    workflow,
    title,
  });
  const session = sessionFromRecord(record);
  const workspaces = await historyStore.listWorkspaces();
  const sessionTree = await loadSessionTree(workspaces);
  useStore.setState((s) => ({
    workflow,
    selectedNodeId: null,
    dirty: false,
    runState: runProgress.runState,
    runOutputs: runProgress.runOutputs,
    lastRunFailedNodeId: runProgress.lastRunFailedNodeId,
    canvasViewport: null,
    mode: 'design',
    currentFilePath: path ?? null,
    workspaces,
    sessions: sessionTree[workspaceId] ?? [session],
    sessionTree,
    activeSessionId: session.id,
    messages: [],
    ...composerDraftPatchForSession(s, {
      workspaceId,
      sessionId: session.id,
    }),
  }));
  await historyStore.patchConfig({
    lastActiveWorkspaceId: workspaceId,
    lastActiveSessionId: session.id,
  });
}

async function activateHistorySession(
  sessionId: string,
  workspaceId?: string,
): Promise<void> {
  const state = useStore.getState();
  const targetWorkspaceId = workspaceId ?? state.activeWorkspaceId ?? undefined;
  if (!state.historyReady || !targetWorkspaceId) {
    useStore.setState((s) => ({
      activeSessionId: sessionId,
      canvasViewport: null,
      ...(() => {
        const run = getRunChannel(s.activeWorkspaceId ?? null, sessionId);
        const liveRun = runActive(run) ? run : null;
        if (liveRun) {
          return {
            messages: liveRun.messages,
            workflow: liveRun.workflow,
            runState: liveRun.runState,
            runOutputs: liveRun.runOutputs,
            lastRunFailedNodeId: liveRun.failedNodeId,
            mode: 'running' as const,
          };
        }
        const aiEdit = getAiEditChannel(s.activeWorkspaceId ?? null, sessionId);
        const liveAiEdit = aiEditActive(aiEdit) ? aiEdit : null;
        const aiEditSnapshot =
          liveAiEdit ?? getAiEditSnapshot(s.activeWorkspaceId ?? null, sessionId);
        if (aiEditSnapshot) {
          return {
            messages: aiEditSnapshot.messages,
            workflow: aiEditSnapshot.workflow,
            selectedNodeId: null,
            ...emptyRunProgress(),
            mode: 'design' as const,
          };
        }
        return {};
      })(),
      ...composerDraftPatchForSession(s, {
        workspaceId: s.activeWorkspaceId ?? null,
        sessionId,
      }),
    }));
    return;
  }

  const record = await historyStore.getSession(targetWorkspaceId, sessionId);
  if (!record) return;
  const session = sessionFromRecord(record);
  const workspace = state.workspaces.find((ws) => ws.id === targetWorkspaceId);

  // If we're switching BACK to the session whose run is still executing, rebuild
  // the view from the live in-memory channel (not the persisted snapshot, which
  // may lag a tick behind and would show stale/interrupted state). This keeps
  // the run visibly live — including any mid-flight streaming message — and
  // crucially does NOT cancel its CLI processes.
  const ch = getRunChannel(targetWorkspaceId, session.id);
  const liveRun = runActive(ch) ? ch : null;
  const aiCh = getAiEditChannel(targetWorkspaceId, session.id);
  const liveAiEdit = aiEditActive(aiCh) ? aiCh : null;

  const workflow = liveRun
    ? liveRun.workflow
    : liveAiEdit
      ? liveAiEdit.workflow
    : restoreWorkflowRunSnapshot(record.workflow ?? state.workflow, record.meta);
  const runProgress = liveRun
    ? {
        runState: liveRun.runState,
        runOutputs: liveRun.runOutputs,
        lastRunFailedNodeId: liveRun.failedNodeId,
      }
    : liveAiEdit
      ? emptyRunProgress()
    : runProgressFromSnapshot(workflow, workflow.meta.run ?? null);
  const canvasViewport = canvasViewportForSession(
    targetWorkspaceId,
    session.id,
    record.meta,
  );
  useStore.setState((s) => {
    const draftPatch = composerDraftPatchForSession(s, {
      workspaceId: targetWorkspaceId,
      sessionId: session.id,
    });
    const composer = workspace
      ? { ...s.composer, workspace: workspace.path }
      : s.composer;
    const workspaceHistory = workspace?.path
      ? [
          workspace.path,
          ...s.workspaceHistory.filter((p) => p !== workspace.path),
        ].slice(0, WORKSPACE_HISTORY_LIMIT)
      : s.workspaceHistory;
    if (workspace) saveComposer({ composer, workspaceHistory });
    return {
      activeWorkspaceId: targetWorkspaceId,
      activeSessionId: session.id,
      composer,
      workspaceHistory,
      ...draftPatch,
      sessions: s.sessionTree[targetWorkspaceId] ?? [session],
      sessionTree: {
        ...s.sessionTree,
        [targetWorkspaceId]: [
          session,
          ...(s.sessionTree[targetWorkspaceId] ?? []).filter(
            (item) => item.id !== session.id,
          ),
      ],
      },
      messages: liveRun
        ? liveRun.messages
        : liveAiEdit
          ? liveAiEdit.messages
          : record.messages,
      workflow,
      ...runProgress,
      canvasViewport,
      mode: liveRun ? 'running' : 'design',
    };
  });
  await historyStore.patchConfig({
    lastActiveWorkspaceId: targetWorkspaceId,
    lastActiveSessionId: session.id,
  });
}

async function deleteHistorySession(
  sessionId: string,
  workspaceId?: string,
): Promise<void> {
  const state = useStore.getState();
  const targetWorkspaceId = workspaceId ?? state.activeWorkspaceId ?? undefined;
  if (!targetWorkspaceId) return;

  await historyStore.deleteSession(targetWorkspaceId, sessionId);

  const workspaces = await historyStore.listWorkspaces();
  const wasActive =
    state.activeSessionId === sessionId &&
    state.activeWorkspaceId === targetWorkspaceId;

  if (!wasActive) {
    useStore.setState((s) => {
      const nextSessions = (s.sessionTree[targetWorkspaceId] ?? s.sessions).filter(
        (session) => session.id !== sessionId,
      );
      return {
        workspaces,
        sessionTree: {
          ...s.sessionTree,
          [targetWorkspaceId]: nextSessions,
        },
      };
    });
    return;
  }

  // Deleting the active session: switch to the next available session and
  // load its full data (messages, workflow, run state), or clear the editor
  // when the workspace becomes empty.
  const freshState = useStore.getState();
  const nextSessions = (
    freshState.sessionTree[targetWorkspaceId] ?? freshState.sessions
  ).filter((session) => session.id !== sessionId);
  const nextActive = nextSessions[0] ?? null;

  if (nextActive) {
    await activateHistorySession(nextActive.id, targetWorkspaceId);
  } else {
    useStore.setState((s) => ({
      workspaces,
      activeSessionId: null,
      sessions: nextSessions,
      sessionTree: {
        ...s.sessionTree,
        [targetWorkspaceId]: nextSessions,
      },
      messages: [],
      workflow: defaultBlueprint(undefined, s.locale),
      selectedNodeId: null,
      dirty: false,
      runState: {},
      runOutputs: {},
      lastRunFailedNodeId: null,
      canvasViewport: null,
      mode: 'design' as const,
      ...composerDraftPatchForSession(s, {
        workspaceId: targetWorkspaceId,
        sessionId: null,
      }),
    }));
    await historyStore.patchConfig({
      lastActiveSessionId: undefined,
    });
  }
}

async function activateWorkspacePath(path: string): Promise<void> {
  const trimmed = path.trim();
  if (!trimmed) return;
  const state = useStore.getState();
  if (!state.historyReady) return;

  const workspace = await historyStore.resolveWorkspaceByPath(trimmed);
  const sessions = await historyStore.listSessions(workspace.id);
  let active = sessions[0];
  if (!active) {
    const record = await historyStore.createSession({
      workspaceId: workspace.id,
      isWorkflow: false,
      messages: [],
    });
    active = summaryFromRecord(record);
    sessions.unshift(summaryFromRecord(record));
  }

  const workspaces = await historyStore.listWorkspaces();
  const sessionTree = await loadSessionTree(workspaces);
  const activeRecord = active
    ? await historyStore.getSession(workspace.id, active.id)
    : null;
  const workflow = restoreWorkflowRunSnapshot(
    activeRecord?.workflow ?? state.workflow,
    activeRecord?.meta,
  );
  const runProgress = runProgressFromSnapshot(workflow, workflow.meta.run ?? null);
  const canvasViewport = canvasViewportForSession(
    workspace.id,
    active?.id ?? '',
    activeRecord?.meta,
  );
  useStore.setState((s) => ({
    workspaces,
    activeWorkspaceId: workspace.id,
    sessions: sessions.map((item) => sessionFromSummary(item)),
    sessionTree,
    activeSessionId: active?.id ?? null,
    messages: activeRecord?.messages ?? [],
    workflow,
    ...runProgress,
    canvasViewport,
    mode: 'design',
    composer: { ...s.composer, workspace: trimmed },
    ...composerDraftPatchForSession(s, {
      workspaceId: workspace.id,
      sessionId: active?.id ?? null,
    }),
  }));
  await historyStore.patchConfig({
    lastActiveWorkspaceId: workspace.id,
    lastActiveSessionId: active?.id,
  });
}

async function initHistoryFromDisk(): Promise<void> {
  if (historyInitStarted) return;
  historyInitStarted = true;
  try {
    await historyStore.ready();
    const rootPath = await historyStore.rootPath();
    const config = await historyStore.getConfig();
    let workspaces = await historyStore.listWorkspaces();

    const persisted = loadComposer();
    const persistedPath = persisted?.composer.workspace?.trim();
    const configuredWorkspace = config.lastActiveWorkspaceId
      ? await historyStore.getWorkspace(config.lastActiveWorkspaceId)
      : null;
    let workspace = persistedPath
      ? await historyStore.resolveWorkspaceByPath(persistedPath)
      : configuredWorkspace;
    if (!workspace && workspaces[0]) {
      workspace = await historyStore.getWorkspace(workspaces[0].id);
    }
    if (!workspace) {
      workspace = await historyStore.resolveWorkspaceByPath('');
    }

    workspaces = await historyStore.listWorkspaces();
    const sessions = await historyStore.listSessions(workspace.id);
    let active =
      sessions.find((s) => s.id === config.lastActiveSessionId) ??
      sessions.find((s) => s.id === workspace.lastActiveSessionId) ??
      sessions[0];
    if (!active) {
      const created = await historyStore.createSession({
        workspaceId: workspace.id,
        isWorkflow: false,
        messages: [],
      });
      active = summaryFromRecord(created);
      sessions.unshift(summaryFromRecord(created));
      workspaces = await historyStore.listWorkspaces();
    }
    const sessionTree = await loadSessionTree(workspaces);
    const activeRecord = active
      ? await historyStore.getSession(workspace.id, active.id)
      : null;
    const workflow = restoreWorkflowRunSnapshot(
      activeRecord?.workflow ?? useStore.getState().workflow,
      activeRecord?.meta,
    );
    const runProgress = runProgressFromSnapshot(workflow, workflow.meta.run ?? null);
    const canvasViewport = canvasViewportForSession(
      workspace.id,
      active?.id ?? '',
      activeRecord?.meta,
    );

    useStore.setState((s) => ({
      historyReady: true,
      historyRootPath: rootPath,
      workspaces,
      activeWorkspaceId: workspace.id,
      sessions: sessions.map((item) => sessionFromSummary(item)),
      sessionTree,
      activeSessionId: active?.id ?? null,
      messages: activeRecord?.messages ?? [],
      workflow,
      ...runProgress,
      canvasViewport,
      mode: 'design',
      composer: {
        ...s.composer,
        workspace: workspace.path || s.composer.workspace,
      },
      ...composerDraftPatchForSession(s, {
        workspaceId: workspace.id,
        sessionId: active?.id ?? null,
      }),
    }));
    void maybeRunCcSwitchAutoImportOnFirstRun();
    await historyStore.patchConfig({
      schemaVersion: HISTORY_SCHEMA_VERSION,
      lastActiveWorkspaceId: workspace.id,
      lastActiveSessionId: active?.id,
    });
  } catch {
    useStore.setState({ historyReady: true });
  }
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
  // Backfill modelStrategy for legacy persisted composers that predate the field.
  const withStrategy: ComposerSettings = {
    ...c,
    modelStrategy: c.modelStrategy ?? defaultComposer.modelStrategy,
  };
  const valid = modelOptions.some((o) => o.id === withStrategy.model);
  return valid ? withStrategy : { ...withStrategy, model: defaultComposer.model };
})();
const seedLocale = loadLocale();
const seedPromptAutoTranslate = loadPromptAutoTranslate();
const seedAppearance = loadAppearance();

// Seed the graph from the last autosaved workflow if present, otherwise start
// from a fresh default blueprint (start → agent → end). We deliberately do NOT
// seed the demo sample here: that caused "new workflow" to flicker back to the
// review-changes sample whenever the store module re-initialised (e.g. on HMR).
const seedWorkflow = migrateWorkflowGateway(
  loadLocalWorkflow() ??
    defaultBlueprint(undefined, seedLocale),
  defaultComposer.model,
);
const seedWorkflowState = restoreWorkflowRunSnapshot(seedWorkflow);
const seedRunProgress = runProgressFromSnapshot(
  seedWorkflowState,
  seedWorkflowState.meta.run ?? null,
);

/**
 * Seed the prompt library, merging newly-shipped default groups and selected
 * default prompt items into the user's persisted library.
 *
 * Without this, adding a default group to `samplePromptGroups` would never show
 * up for users who already have a persisted library (loadPromptGroups() wins),
 * silently hiding new defaults. The merge runs once per PROMPT_DEFAULTS_VERSION
 * bump (tracked in localStorage): any default group whose `id` is absent from
 * the persisted set is appended, and item migrations add specific new prompts
 * inside existing default groups while preserving the user's own edits.
 */
function seedPromptGroups(): PromptGroup[] {
  const stored = loadPromptGroups();
  if (!stored) return samplePromptGroups; // never edited → use full defaults
  if (loadPromptGroupsVersion() >= PROMPT_DEFAULTS_VERSION) return stored;

  const existing = new Set(stored.map((g) => g.id));
  const additions = samplePromptGroups.filter((g) => !existing.has(g.id));
  let merged = additions.length ? [...stored, ...additions] : stored;
  let changed = additions.length > 0;

  for (const migration of PROMPT_DEFAULT_ITEM_MIGRATIONS) {
    const defaultGroup = samplePromptGroups.find(
      (g) => g.id === migration.groupId,
    );
    const defaultItem = defaultGroup?.items.find(
      (item) => item.id === migration.itemId,
    );
    if (!defaultItem) continue;

    merged = merged.map((group) => {
      if (group.id !== migration.groupId) return group;
      if (group.items.some((item) => item.id === migration.itemId)) {
        return group;
      }
      changed = true;
      return { ...group, items: [...group.items, defaultItem] };
    });
  }

  if (changed) savePromptGroups(merged);
  savePromptGroupsVersion(PROMPT_DEFAULTS_VERSION);
  return merged;
}
const seedPromptGroupsValue = seedPromptGroups();
let historyInitStarted = false;

export const useStore = create<StoreState>((set) => ({
  // Seed graph: restored autosave, or a fresh default blueprint.
  workflow: seedWorkflowState,
  selectedNodeId: null,

  // Editor lifecycle: start in design mode, no run state, clean, unsaved.
  mode: 'design',
  runState: seedRunProgress.runState,
  runOutputs: seedRunProgress.runOutputs,
  lastRunFailedNodeId: seedRunProgress.lastRunFailedNodeId,
  canvasViewport: null,
  dirty: false,
  currentFilePath: null,

  // AI: idle.
  aiStreaming: false,
  aiEditingSessions: [],

  // Seed session-domain state from the sample module so the dev UI renders
  // a populated session history, message stream, and prompt library.
  sessions: sampleSessions,
  activeSessionId: initialActiveSessionId,
  // Start with an empty AI return stream; messages accrue as the user interacts.
  messages: [],
  // Restore the user-edited prompt library if present (merging in any newly-
  // shipped default groups), else the full defaults. See seedPromptGroups().
  promptGroups: seedPromptGroupsValue,
  locale: seedLocale,
  promptAutoTranslate: seedPromptAutoTranslate,
  appearance: seedAppearance,

  // Composer settings seeded from the sample option lists, overlaid with any
  // persisted selections.
  composer: seedComposer,
  composerDraft: '',
  composerDrafts: {},
  composerFocusVersion: 0,
  permissionOptions,
  modelOptions,
  workspaceHistory: persisted?.workspaceHistory ?? [],
  historyReady: false,
  historyRootPath: null,
  workspaces: [],
  sessionTree: {},
  activeWorkspaceId: null,
  runningSessions: [],
  runningSessionProgress: {},
  runningSessionId: null,
  runningWorkspaceId: null,

  initHistory: () => {
    void initHistoryFromDisk();
  },

  setLocale: (locale) => {
    set({ locale });
    saveLocale(locale);
  },

  setPromptAutoTranslate: (enabled) => {
    set({ promptAutoTranslate: enabled });
    savePromptAutoTranslate(enabled);
  },

  setStylePresetId: (stylePresetId) => {
    const appearance: AppearanceSettings = { stylePresetId };
    set({ appearance });
    saveAppearance(appearance);
    applyAppearance(appearance);
  },

  selectNode: (id) => set({ selectedNodeId: id }),

  setWorkflow: (ir) => {
    const workflow = restoreWorkflowRunSnapshot(
      migrateWorkflowGateway(ir, defaultComposer.model),
    );
    const runProgress = runProgressFromSnapshot(
      workflow,
      workflow.meta.run ?? null,
    );
    applyWorkflowEdit(
      'user',
      () => ({ workflow, ...runProgress }),
      workflow.meta.run ? runMetaFromSnapshot(workflow.meta.run) : emptyRunMeta(),
    );
  },

  openWorkflowSession: (ir, path) => {
    void openWorkflowInSession(ir, path).catch(() => {});
  },

  // Switch the target runtime adapter (Claude Code / Codex / Gemini). The
  // adapter lives in the IR meta so the emitter can target the right runtime.
  setAdapter: (adapter) => {
    applyWorkflowEdit('user', (state) => ({
      workflow: workflowWithoutRunSnapshot(
        withGatewayDefaults(
          state.workflow,
          systemDefaultGatewaySelection(adapter),
        ),
      ),
      ...emptyRunProgress(),
    }));
  },

  setGlobalRunSelection: (selection) => {
    writeStoredGatewaySelection(selection);
    applyWorkflowEdit('user', (state) => ({
      workflow: workflowWithoutRunSnapshot(
        withGatewayDefaults(state.workflow, selection),
      ),
      ...emptyRunProgress(),
    }));
  },

  clearGlobalRunSelection: () => {
    clearActiveGatewaySelection();
    applyWorkflowEdit('user', (state) => ({
      workflow: workflowWithoutRunSnapshot(
        withoutWorkflowGatewayDefaults(state.workflow),
      ),
      ...emptyRunProgress(),
    }));
  },

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
  runWorkflow: () => startWorkflowRun(false),

  resumeWorkflow: () => startWorkflowRun(true),

  stopWorkflow: () => stopWorkflowRun(),

  // Load a fresh starter graph (start → agent → end), clean and in design mode.
  newWorkflow: () =>
    void createNewWorkflowSession(),

  newSession: () => {
    if (useStore.getState().aiStreaming) return;
    void createNewChatSession();
  },

  selectSession: (sessionId, workspaceId) => {
    void activateHistorySession(sessionId, workspaceId);
  },

  deleteSession: (sessionId, workspaceId) => {
    void deleteHistorySession(sessionId, workspaceId);
  },

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
    if (state.aiStreaming || isWorkflowReadOnly(state)) return;
    const aiEditingSession = activeWorkflowSessionKey(state);
    const capturedStartInputs: string[] = [trimmed];

    const userMsg: Message = {
      id: shortId('m'),
      role: 'user',
      text: trimmed,
      createdAt: Date.now(),
    };
    const promptUpdate = applyPromptTitle(
      state,
      trimmed,
      userMsg.createdAt,
    );
    const ch: AiEditChannel = {
      key: runKey(aiEditingSession.workspaceId, aiEditingSession.sessionId),
      workspaceId: aiEditingSession.workspaceId,
      sessionId: aiEditingSession.sessionId,
      workflow: promptUpdate.workflow,
      messages: [...state.messages, userMsg],
    };
    addAiEditChannel(ch);
    if (aiEditViewActive(ch)) {
      set({
        messages: ch.messages,
        sessions: promptUpdate.sessions,
        sessionTree: promptUpdate.sessionTree,
        workflow: ch.workflow,
      });
    }
    updateAiEditSessionSummary(ch);
    const promptWorkflowName =
      promptUpdate.workflow.meta.name !== state.workflow.meta.name
        ? promptUpdate.workflow.meta.name
        : null;
    if (ch.workspaceId && ch.sessionId) {
      void historyStore
        .appendMessage(ch.workspaceId, ch.sessionId, userMsg)
        .catch(() => {});
    }

    const ir = ch.workflow;
    const gatewaySelection = workflowGatewaySelection(ir, state.composer.model);
    const directRoute = resolveDirectGatewayRoute(gatewaySelection);
    const inTauri = isTauri();
    const useApi = !!directRoute;
    const useCli = !useApi && inTauri;

    const pushAssistant = (txt: string) => {
      const msg: Message = {
        id: shortId('m'),
        role: 'assistant',
        text: txt,
        createdAt: Date.now(),
      };
      ch.messages = [...ch.messages, msg];
      aiEditCommitMessages(ch, true);
    };

    // No API key and no desktop CLI: local keyword fallback.
    if (!useApi && !useCli) {
      const result = applyIntent(ir, trimmed);
      if (result.changed) {
        commitAiChannelBlueprint(
          ch,
          appendStartUserInputs(result.ir, capturedStartInputs),
        );
        pushAssistant(`⟳ 已修改蓝图 (本地意图引擎)。${result.note}`);
      } else {
        pushAssistant(
          `当前环境无法调用所选运行时。请在桌面版中使用本地 CLI，或切回 Claude Code 并配置 API key。\n（本地意图引擎：${result.note}）`,
        );
      }
      removeAiEditChannel(ch);
      return;
    }

    // "grill-me" and explicit clarification prompts opt into interrogation
    // mode. Ordinary AI-input turns should produce/apply a blueprint directly.
    const isGrill = isGrillRequest(trimmed);
    let allowClarification = isClarifyingEditRequest(trimmed);
    const wrapped = isGrill
      ? `请扮演严格的需求评审者。针对当前工作流蓝图，用交互（select / input）逐个向我追问还没考虑清楚的关键问题，例如：每个节点的输入/输出、边界与异常处理、成功/验收标准、节点依赖与先后顺序、该并行还是串行、用什么运行时与模型。一次只问一个问题；问清若干轮后，再据此优化蓝图并按要求输出。`
      : isEmptyWorkflow(ir)
        ? `我希望新建一个 workflow，目的如下：\n${trimmed}`
        : `我希望继续修改 workflow，根据下面意见你来优化流程：\n${trimmed}`;
    const userContent = `当前 IRGraph(JSON)：\n${JSON.stringify(ir)}\n\n用户意见：\n${wrapped}`;
    const generationPlan = effectiveGenerationConsensusPlan(
      genCandidateCount(),
      gatewaySelection,
    );

    const aiStartedAt = Date.now();
    const withAiTiming = (body: string, endedAt = Date.now()) =>
      `⏱ ${formatClock(aiStartedAt)} → ${formatClock(endedAt)} · 耗时 ${formatDuration(
        endedAt - aiStartedAt,
      )}\n${body}`;
    const withPromptWorkflowName = (nextIr: IRGraph): IRGraph =>
      promptWorkflowName
        ? {
            ...nextIr,
            meta: { ...nextIr.meta, name: promptWorkflowName },
          }
        : nextIr;
    const withCapturedStartInputs = (nextIr: IRGraph): IRGraph =>
      appendStartUserInputs(
        withPromptWorkflowName(nextIr),
        capturedStartInputs,
      );
    const commitAiBlueprint = (nextIr: IRGraph): 'ok' | 'stale' | 'locked' => {
      return commitAiChannelBlueprint(ch, nextIr) ? 'ok' : 'locked';
    };
    const capturedAnswerText = (
      req: InteractionRequest,
      answer: InteractionAnswer,
    ): string => {
      const questionLabel = state.locale === 'en-US' ? 'Question' : '问题';
      const answerLabel = state.locale === 'en-US' ? 'Answer' : '回答';
      return `${questionLabel}: ${req.prompt}\n${answerLabel}: ${summarizeAnswer(req, answer)}`;
    };

    // Explicit clarification mode may ask questions via the interaction
    // protocol. Normal edit mode goes straight for a blueprint and gets one
    // stricter retry if the model returns prose/markdown without an IRGraph.
    let activeId = '';
    const newBubble = (initial: string) => {
      const id = shortId('m');
      activeId = id;
      ch.messages = [
        ...ch.messages,
        { id, role: 'assistant', text: initial, createdAt: Date.now() },
      ];
      aiEditCommitMessages(ch, false);
    };
    const setActive = (txt: string, persist = false) => {
      ch.messages = ch.messages.map((m) =>
        m.id === activeId ? { ...m, text: txt } : m,
      );
      aiEditCommitMessages(ch, persist);
    };
    const persistAiMessages = () => aiEditCommitMessages(ch, true);
    const aiEditViaCliWithSpeed = async (
      prompt: string,
      cli: Awaited<ReturnType<typeof resolveCliGatewayRoute>>,
      opts: {
        permission: string;
        model?: string;
        cliCommand?: string;
        env?: Record<string, string>;
        onProgress?: (chunk: string) => void;
      },
    ): Promise<string> => {
      const policy = timeoutPolicyForSelection(cli.selection, prompt);
      const startedAt = Date.now();
      let firstProgressAt: number | undefined;
      try {
        const text = await aiEditViaCli(prompt, cli.adapter, {
          ...opts,
          timeoutSeconds: policy.timeoutSeconds,
          idleTimeoutSeconds: policy.idleTimeoutSeconds,
          onProgress: opts.onProgress
            ? (chunk) => {
                firstProgressAt ??= Date.now();
                opts.onProgress?.(chunk);
              }
            : undefined,
        });
        recordModelCall(cli.selection, {
          elapsedMs: Date.now() - startedAt,
          firstProgressMs: firstProgressAt ? firstProgressAt - startedAt : undefined,
          ok: true,
        });
        return text;
      } catch (err) {
        const failure = describeRunFailure(err);
        recordModelCall(cli.selection, {
          elapsedMs: Date.now() - startedAt,
          firstProgressMs: firstProgressAt ? firstProgressAt - startedAt : undefined,
          ok: false,
          failureCode: failure.code,
          timeoutSeconds: failure.timeoutSeconds,
          idleTimeoutSeconds: failure.idleTimeoutSeconds,
        });
        throw err;
      }
    };
    const completeDirectWithSpeed = async (request: {
      system: string;
      userContent: string;
      onDelta?: (chunk: string) => void;
    }): Promise<string> => {
      if (!directRoute) throw new Error('NO_MODEL_GATEWAY_BACKEND');
      const startedAt = Date.now();
      let firstProgressAt: number | undefined;
      try {
        const text = await completeGatewayText({
          route: directRoute,
          system: request.system,
          userContent: request.userContent,
          maxTokens: 8192,
          onDelta: (chunk) => {
            firstProgressAt ??= Date.now();
            request.onDelta?.(chunk);
          },
        });
        recordModelCall(gatewaySelection, {
          elapsedMs: Date.now() - startedAt,
          firstProgressMs: firstProgressAt ? firstProgressAt - startedAt : undefined,
          ok: true,
        });
        return text;
      } catch (err) {
        const failure = describeRunFailure(err);
        recordModelCall(gatewaySelection, {
          elapsedMs: Date.now() - startedAt,
          firstProgressMs: firstProgressAt ? firstProgressAt - startedAt : undefined,
          ok: false,
          failureCode: failure.code,
          timeoutSeconds: failure.timeoutSeconds,
          idleTimeoutSeconds: failure.idleTimeoutSeconds,
        });
        throw err;
      }
    };

    // Split a full reply into explanation + optional IRGraph and apply it to the
    // active bubble. Only called once the AI is done asking (no interaction block).
    const finalizeReply = (full: string) => {
      const fence = full.indexOf('```');
      const explanation = (fence === -1 ? full : full.slice(0, fence)).trim();
      if (fence === -1) {
        // No fenced JSON. If the model still emitted a bare {…} object, try it;
        // otherwise this was a question/explanation and the graph is unchanged.
        const maybe = extractJsonObject(full);
        if (maybe.trim().startsWith('{')) {
          try {
            const nextIr = withCapturedStartInputs(JSON.parse(maybe) as IRGraph);
            if (Array.isArray(nextIr.nodes) && Array.isArray(nextIr.edges)) {
              const commitState = commitAiBlueprint(nextIr);
              if (commitState !== 'ok') {
                setActive(
                  withAiTiming(
                    commitState === 'stale'
                      ? '⚠ 蓝图未更新：AI 结果对应的会话已切换，未写入当前工作流。'
                      : '⚠ 蓝图未更新：当前 workflow 处于只读状态，无法写入 AI 生成的蓝图。',
                  ),
                );
                persistAiMessages();
                return;
              }
              setActive(
                withAiTiming(
                  `✓ 已更新蓝图（${nextIr.nodes.length} 节点 / ${nextIr.edges.length} 边）。`,
                ),
              );
              persistAiMessages();
              return;
            }
          } catch {
            /* fall through to prose */
          }
        }
        const head = explanation ? `${explanation}\n\n` : '';
        setActive(
          withAiTiming(
            `${head}⚠ 蓝图未更新：这次模型只给了说明、没有输出可写入的蓝图。\n请把需求写得更具体（例如“在 X 节点后加一个 Y 节点”），或再发送一次让我据此改图。`,
          ),
        );
        persistAiMessages();
        return;
      }
      try {
        const nextIr = withCapturedStartInputs(
          JSON.parse(extractJsonObject(full)) as IRGraph,
        );
        if (!Array.isArray(nextIr.nodes) || !Array.isArray(nextIr.edges)) {
          throw new Error('返回的不是合法 IRGraph');
        }
        const commitState = commitAiBlueprint(nextIr);
        if (commitState !== 'ok') {
          setActive(
            withAiTiming(
              commitState === 'stale'
                ? '⚠ 蓝图未更新：AI 结果对应的会话已切换，未写入当前工作流。'
                : '⚠ 蓝图未更新：当前 workflow 处于只读状态，无法写入 AI 生成的蓝图。',
            ),
          );
          persistAiMessages();
          return;
        }
        const head = explanation ? `${explanation}\n\n` : '';
        setActive(
          withAiTiming(
            `${head}✓ 已更新蓝图（${nextIr.nodes.length} 节点 / ${nextIr.edges.length} 边）。`,
          ),
        );
        persistAiMessages();
      } catch (parseErr) {
        const msg = (parseErr as Error)?.message ?? String(parseErr);
        const head = explanation ? `${explanation}\n\n` : '';
        setActive(withAiTiming(`${head}⚠ 蓝图未更新：返回的 JSON 无法解析 (${msg})。`));
        persistAiMessages();
      }
    };

    // Per-node model-strategy guidance is injected after UNIFIED_SYSTEM so both
    // the API and CLI paths (cliPrompt derives from system) carry it. 'inherit'
    // yields an empty string, preserving the pre-feature behavior exactly.
    // Language adaptation instruction tells the LLM to generate node content in
    // the current UI locale's language (no-op for zh-CN which is the default).
    const unifiedBase =
      UNIFIED_SYSTEM +
      modelStrategyGuidance(state.composer.modelStrategy) +
      languageAdaptationPrompt(state.locale);
    const clarifyingSystem =
      `${unifiedBase}\n\n${INTERACTION_PROTOCOL}\n` +
      `（交互澄清模式：用户明确要求你先澄清/确认/反问时，才使用上面的交互块提一个关键问题；用户回答后不要继续追问，必须把回答吸收到 workflow 蓝图，并输出中文说明 + \`\`\`json 蓝图。）`;
    // Strict, blueprint-only system (no interaction) used once we force output.
    const directSystem = `${unifiedBase}\n\n${BLUEPRINT_DIRECT_EDIT_CONTRACT}`;
    // First-pass direct system: still aims for a blueprint, but lets the model
    // emit ONE granularity-choice select when the requested scale is ambiguous.
    const directWithEscapeSystem =
      `${unifiedBase}\n\n${INTERACTION_PROTOCOL}\n\n${SIMPLE_TASK_ESCAPE_CONTRACT}`;
    // Generation-time consensus: for a complex direct request, produce several
    // candidate blueprints in parallel and let a judge merge the best (the
    // "tournament" pattern applied to AI 改图 itself). Skipped for grill /
    // explicit-clarification turns and for simple requests.
    const complexGenerationRequest = isComplexGenerationRequest(trimmed);
    const speedLimitedGeneration =
      (useApi || useCli) &&
      !isGrill &&
      !allowClarification &&
      complexGenerationRequest &&
      !generationPlan.enabled;
    const shouldGenConsensus =
      (useApi || useCli) &&
      !isGrill &&
      !allowClarification &&
      complexGenerationRequest &&
      generationPlan.enabled;
    let forceBlueprintOnly = false;
    let sawInteraction = false;
    let blueprintRetries = 0;

    // One backend round. Streams live into the active bubble (API) or returns the
    // CLI's full reply. Returns the raw text for interaction/graph parsing.
    const callOnce = async (convo: string): Promise<string> => {
      const system = forceBlueprintOnly
        ? directSystem
        : allowClarification
          ? clarifyingSystem
          : directWithEscapeSystem;
      if (useCli) {
        const cli = await resolveCliGatewayRoute(gatewaySelection);
        const cliPrompt =
          `${system}\n\n` +
          `只针对工作流蓝图作答，不要读取或探索任何代码文件，不要创建或修改任何本地文件。` +
          (forceBlueprintOnly
            ? `不要提问、不要等待确认、不要输出 Markdown 计划；直接输出中文说明 + 一个完整 \`\`\`json IRGraph 代码块。蓝图规模要和任务复杂度匹配，简单需求优先最小充分结构。\n\n`
            : allowClarification
              ? `用户明确要求澄清时才用交互块提问；问清后输出中文说明 + 一个 \`\`\`json IRGraph 代码块。\n\n`
              : `默认直接输出与任务复杂度匹配的中文说明 + 一个完整 \`\`\`json IRGraph 代码块；简单需求优先最小充分结构，复杂需求再展开。仅当你判断当前输入在“最小改动”与“完整多步蓝图”之间真的存在结构性歧义时，可改为只发一个两选项 select（“${SIMPLE_OPT_MINIMAL}” / “${SIMPLE_OPT_FULL}”）让用户选择，不要输出 Markdown 计划。\n\n`) +
          convo;
        return aiEditViaCliWithSpeed(cliPrompt, cli, {
          permission: 'full', // -> --dangerously-skip-permissions, no prompts
          model: cli.model,
          cliCommand: cli.cliCommand,
          env: cli.env,
        });
      }
      let full = '';
      const returned = await completeDirectWithSpeed({
        system,
        userContent: convo,
        onDelta: (chunk) => {
          full += chunk;
          setActive(liveProse(full) || '⟳ 生成中…');
        },
      });
      return full || returned;
    };

    // Generate several candidate blueprints in parallel (each from a distinct
    // design angle), then judge-merge the best into one. Falls back gracefully
    // when too few candidates are usable. Reuses finalizeReply to apply the result.
    const runGenConsensus = async (): Promise<void> => {
      const angles = generationAngles(generationPlan.count);
      newBubble(
        withAiTiming(
          `⟳ 复杂任务：生成 ${angles.length} 份候选蓝图（并发 ${generationPlan.concurrency}）…`,
        ),
      );

      const genOne = async (angle: string): Promise<string> => {
        const convoA = `${userContent}\n\n【本候选侧重】${angle}\n（据此给出与任务复杂度匹配的完整蓝图。）`;
        if (useCli) {
          const cli = await resolveCliGatewayRoute(gatewaySelection);
          return aiEditViaCliWithSpeed(
            `${directSystem}\n\n只针对工作流蓝图作答，不要读取或修改任何文件；直接输出中文说明 + 一个完整 \`\`\`json IRGraph 代码块。\n\n${convoA}`,
            cli,
            {
              permission: 'full',
              model: cli.model,
              cliCommand: cli.cliCommand,
              env: cli.env,
            },
          );
        }
        return completeDirectWithSpeed({
          system: directSystem,
          userContent: convoA,
        });
      };

      // Candidates fan out only when the current model is fast enough. The
      // dynamic cap avoids starting several slow CLI processes that all hit the
      // same no-progress timeout window together.
      const settled = await runWithConcurrency(
        angles,
        generationPlan.concurrency,
        async (a) => {
          try {
            return { full: await genOne(a), failure: null as RunFailure | null };
          } catch (err) {
            return { full: '', failure: describeRunFailure(err) };
          }
        },
      );

      const valid = settled
        .map(({ full }) => {
          try {
            const json = extractJsonObject(full);
            const obj = JSON.parse(json) as IRGraph;
            if (Array.isArray(obj.nodes) && Array.isArray(obj.edges)) {
              return { full, json };
            }
          } catch {
            /* skip invalid candidate */
          }
          return null;
        })
        .filter((v): v is { full: string; json: string } => v !== null);

      if (valid.length === 0) {
        const failures = settled
          .map((s) => s.failure)
          .filter((f): f is RunFailure => f !== null);
        const allFailed = failures.length === settled.length;
        const anyTimeout = failures.some(
          (f) => f.code === 'timeout' || f.code === 'idle_timeout',
        );
        // If every candidate timed out, those failures have just updated the
        // speed profile. Retry once as a single strict generation with the now
        // larger dynamic timeout, instead of launching another multi-candidate
        // fan-out.
        if (allFailed && anyTimeout) {
          setActive(
            withAiTiming(
              `⚠ ${angles.length} 份候选生成均超时，已判定当前模型偏慢：关闭多候选，并用更长的动态超时改为单次生成…`,
            ),
          );
          forceBlueprintOnly = true;
          finalizeReply(await callOnce(userContent));
          return;
        }
        setActive(
          withAiTiming(
            generationPlan.enabled
              ? '⚠ 候选生成均未产出可用蓝图，回退为单次生成…'
              : '⚠ 当前模型速度不适合多候选，已改为单次生成…',
          ),
        );
        forceBlueprintOnly = true;
        finalizeReply(await callOnce(userContent));
        return;
      }
      if (valid.length === 1) {
        finalizeReply(valid[0].full);
        return;
      }

      setActive(withAiTiming(`⟳ 已得 ${valid.length} 份候选，正在评审合并最佳…`));
      const judgeSystem =
        `${unifiedBase}\n\n你将收到同一需求的多份候选 workflow 蓝图(IRGraph JSON)。请择优合并：以整体最佳的一份为基底，把其它候选中确实更优的局部（更合理的并行/分支拓扑、遗漏的验收/回退、更贴切的 consensus 用法、更准确的节点划分）合并进去，并纠正明显问题。输出中文说明(2-4 句，说明取舍理由) + 一个完整的 \`\`\`json IRGraph。\n\n` +
        BLUEPRINT_DIRECT_EDIT_CONTRACT;
      const judgeConvo =
        `原始需求：\n${wrapped}\n\n当前 IRGraph：\n${JSON.stringify(ir)}\n\n` +
        `以下是多份候选蓝图，请评审合并出最佳：\n\n` +
        valid.map((v, i) => `【候选 ${i + 1}】\n${v.json}`).join('\n\n');

      let merged = '';
      if (useCli) {
        const cli = await resolveCliGatewayRoute(gatewaySelection);
        merged = await aiEditViaCliWithSpeed(`${judgeSystem}\n\n${judgeConvo}`, cli, {
          permission: 'full',
          model: cli.model,
          cliCommand: cli.cliCommand,
          env: cli.env,
        });
      } else if (directRoute) {
        let judgeFull = '';
        merged = await completeDirectWithSpeed({
          system: judgeSystem,
          userContent: judgeConvo,
          onDelta: (chunk) => {
            judgeFull += chunk;
            setActive(liveProse(judgeFull) || '⟳ 评审合并中…');
          },
        });
        merged = merged || judgeFull;
      }
      // If the judge didn't return a graph, keep the best candidate as-is.
      finalizeReply(replyIncludesIRGraph(merged) ? merged : valid[0].full);
    };

    void (async () => {
      let convo = userContent;
      let finalized = false;
      try {
        if (shouldGenConsensus) {
          await runGenConsensus();
          finalized = true;
        }
        for (let round = 0; round < MAX_INTERACTION_ROUNDS && !finalized; round += 1) {
          newBubble(
            useCli
              ? speedLimitedGeneration
                ? `⟳ 当前模型速度策略：${generationPlan.reason}，通过命令行单次生成…`
                : `⟳ 通过命令行调用 ${gatewaySelection.adapter}…`
              : speedLimitedGeneration
                ? `⟳ 当前模型速度策略：${generationPlan.reason}，单次生成…`
              : '⟳ 生成中…',
          );
          const full = await callOnce(convo);
          // Parse an interaction whenever we haven't yet forced blueprint-only
          // output. In direct mode this is the single "task is trivial" select;
          // in clarify mode it's the user's explicit clarification question.
          const req = !forceBlueprintOnly ? parseInteraction(full) : null;
          if (!req) {
            const hasBlueprint = replyIncludesIRGraph(full);
            const shouldForceBlueprint =
              !hasBlueprint && blueprintRetries < MAX_BLUEPRINT_RETRIES;
            if (shouldForceBlueprint) {
              blueprintRetries += 1;
              forceBlueprintOnly = true;
              setActive(
                withAiTiming(
                  allowClarification || sawInteraction
                    ? `⚠ 澄清后模型仍未返回可写入的 workflow 蓝图，正在强制重试为 IRGraph（第 ${blueprintRetries}/${MAX_BLUEPRINT_RETRIES} 次）。`
                    : `⚠ 模型未返回可写入的 workflow 蓝图，正在按严格 IRGraph 格式重试（第 ${blueprintRetries}/${MAX_BLUEPRINT_RETRIES} 次）。`,
                ),
              );
              convo += strictBlueprintRetryAppendix(full);
              continue;
            }
            finalizeReply(full);
            finalized = true;
            break;
          }
          // The AI is asking. Show its prose, render the widget, and wait.
          setActive(
            withAiTiming(stripInteraction(full) || '（我有几个问题想先和你确认）'),
          );
          persistAiMessages();
          sawInteraction = true;
          const answer = await awaitInteraction(null, req, ch);
          if (!answer) {
            forceBlueprintOnly = true;
            allowClarification = false;
            convo +=
              '\n\n（用户跳过了这个澄清问题，请不要再追问，直接基于现有信息输出优化后的蓝图。）';
            continue;
          }
          capturedStartInputs.push(capturedAnswerText(req, answer));
          convo += `\n\n${formatAnswerForPrompt(req, answer)}\n\n${INTERACTION_BLUEPRINT_APPENDIX}`;
          forceBlueprintOnly = true;
          allowClarification = false;
        }
        if (!finalized) {
          newBubble(
            withAiTiming(
              `⚠ 澄清轮数已达上限（${MAX_INTERACTION_ROUNDS}）。请根据以上对话再发送一次，让我据此生成/优化蓝图。`,
            ),
          );
          persistAiMessages();
        }
      } catch (err) {
        const msg = (err as Error)?.message ?? String(err);
        if (activeId) setActive(withAiTiming(`✗ 调用失败: ${msg}`));
        else pushAssistant(withAiTiming(`✗ 调用失败: ${msg}`));
        persistAiMessages();
      } finally {
        removeAiEditChannel(ch);
      }
    })();
  },

  // Resolve a node's interaction request with the user's answer. Marks the
  // message answered (so the widget collapses to a summary) and resolves the
  // promise the run loop is awaiting on (see awaitInteraction). A no-op resolver
  // (e.g. answering a stale widget after the run ended) just updates the message.
  answerInteraction: (messageId, answer) => {
    const mark = (m: Message): Message =>
      m.id === messageId && m.interactionStatus === 'pending'
        ? { ...m, interactionAnswer: answer, interactionStatus: 'answered' }
        : m;
    const resolver = pendingInteractionResolvers.get(messageId);
    const ch = resolver?.runKey ? getRunChannelByKey(resolver.runKey) : null;
    const aiCh = resolver?.aiEditKey
      ? getAiEditChannelByKey(resolver.aiEditKey)
      : null;
    // Keep the run channel's shadow in sync so a later commit doesn't overwrite
    // the answered status with stale messages.
    if (ch) {
      ch.messages = ch.messages.map(mark);
      channelCommitMessages(ch, true);
    } else if (aiCh) {
      aiCh.messages = aiCh.messages.map(mark);
      aiEditCommitMessages(aiCh, true);
    } else {
      set((s) => ({ messages: s.messages.map(mark) }));
      void persistCurrentMessages();
    }
    if (resolver) {
      pendingInteractionResolvers.delete(messageId);
      resolver.resolve(answer);
    }
  },

  // Skip a pending interaction (the widget's "跳过"): mark it cancelled and
  // resolve the waiting loop with null (no answer).
  dismissInteraction: (messageId) => {
    const mark = (m: Message): Message =>
      m.id === messageId && m.interactionStatus === 'pending'
        ? { ...m, interactionStatus: 'cancelled' }
        : m;
    const resolver = pendingInteractionResolvers.get(messageId);
    const ch = resolver?.runKey ? getRunChannelByKey(resolver.runKey) : null;
    const aiCh = resolver?.aiEditKey
      ? getAiEditChannelByKey(resolver.aiEditKey)
      : null;
    if (ch) {
      ch.messages = ch.messages.map(mark);
      channelCommitMessages(ch, true);
    } else if (aiCh) {
      aiCh.messages = aiCh.messages.map(mark);
      aiEditCommitMessages(aiCh, true);
    } else {
      set((s) => ({ messages: s.messages.map(mark) }));
      void persistCurrentMessages();
    }
    if (resolver) {
      pendingInteractionResolvers.delete(messageId);
      resolver.resolve(null);
    }
  },

  setComposer: (patch) =>
    set((state) => {
      const composer = { ...state.composer, ...patch };
      saveComposer({ composer, workspaceHistory: state.workspaceHistory });
      return { composer };
    }),

  setComposerDraft: (text) =>
    set((state) => {
      const currentKey = workflowSessionKeyId(activeWorkflowSessionKey(state));
      const composerDrafts =
        state.composerDrafts[currentKey] === text
          ? state.composerDrafts
          : { ...state.composerDrafts, [currentKey]: text };
      if (
        state.composerDraft === text &&
        composerDrafts === state.composerDrafts
      ) {
        return state;
      }
      return { composerDraft: text, composerDrafts };
    }),

  appendComposerDraft: (text) => {
    const addition = text.trim();
    if (!addition) return;
    set((state) => {
      const next = appendComposerDraftState(
        state.composerDraft,
        addition,
        state.mode === 'running',
      );
      if (next.focusVersionDelta === 0) return state;
      const currentKey = workflowSessionKeyId(activeWorkflowSessionKey(state));
      const composerDrafts =
        state.composerDrafts[currentKey] === next.draft
          ? state.composerDrafts
          : { ...state.composerDrafts, [currentKey]: next.draft };
      return {
        composerDraft: next.draft,
        composerDrafts,
        composerFocusVersion:
          state.composerFocusVersion + next.focusVersionDelta,
      };
    });
  },

  // Set the active workspace and record it in the most-recent-first history
  // (deduped, capped). Empty paths are ignored.
  setWorkspace: (path) => {
    const trimmed = path.trim();
    if (!trimmed) return;
    if (useStore.getState().aiStreaming) return;
    set((state) => {
      const composer = { ...state.composer, workspace: trimmed };
      const workspaceHistory = [
        trimmed,
        ...state.workspaceHistory.filter((p) => p !== trimmed),
      ].slice(0, WORKSPACE_HISTORY_LIMIT);
      saveComposer({ composer, workspaceHistory });
      return { composer, workspaceHistory };
    });
    void activateWorkspacePath(trimmed);
  },

  // ── Graph editing ──────────────────────────────────────────────────────

  addNode: (type, params, parent) => {
    const id = shortId('n');
    const committed = applyWorkflowEdit('user', (state) => {
      const defaults = NODE_DEFAULTS[type];
      const node: IRNode = {
        id,
        type,
        ...(parent ? { parent } : {}),
        label: defaults.label,
        params: { ...defaults.params, ...(params ?? {}) },
      };
      const nextWorkflow = autoLayoutGraph(
        {
          ...state.workflow,
          nodes: [...state.workflow.nodes, node],
        },
        state.workflow,
      );
      return {
        workflow: workflowWithoutRunSnapshot(nextWorkflow),
        dirty: true,
        ...emptyRunProgress(),
      };
    });
    return committed ? id : '';
  },

  updateNodeParams: (id, patch) => {
    applyWorkflowEdit('user', (state) => ({
      workflow: workflowWithoutRunSnapshot({
        ...state.workflow,
        nodes: state.workflow.nodes.map((n) =>
          n.id === id ? { ...n, params: patchParams(n.params, patch) } : n,
        ),
      }),
      dirty: true,
      ...emptyRunProgress(),
    }));
  },

  updateNodeGatewayOverride: (id, override) => {
    applyWorkflowEdit('user', (state) => ({
      workflow: workflowWithoutRunSnapshot({
        ...state.workflow,
        nodes: state.workflow.nodes.map((n) => {
          if (n.id !== id) return n;
          return {
            ...n,
            params: nodeParamsWithGatewayOverride(n.params ?? {}, override),
          };
        }),
      }),
      dirty: true,
      ...emptyRunProgress(),
    }));
  },

  updateNodeLabel: (id, label) => {
    applyWorkflowEdit('user', (state) => ({
      workflow: workflowWithoutRunSnapshot({
        ...state.workflow,
        nodes: state.workflow.nodes.map((n) =>
          n.id === id ? { ...n, label } : n,
        ),
      }),
      dirty: true,
      ...emptyRunProgress(),
    }));
  },

  // Remove a node and, when it is a container (branch/loop), all of its
  // transitive descendants — plus every edge touching any removed node.
  removeNode: (id) => {
    applyWorkflowEdit('user', (state) => {
      const doomed = collectSubtree(state.workflow.nodes, id);
      const layout = { ...(state.workflow.layout ?? {}) };
      for (const d of doomed) delete layout[d];
      return {
        workflow: workflowWithoutRunSnapshot({
          ...state.workflow,
          nodes: state.workflow.nodes.filter((n) => !doomed.has(n.id)),
          edges: state.workflow.edges.filter(
            (e) => !doomed.has(e.from.node) && !doomed.has(e.to.node),
          ),
          layout,
        }),
        selectedNodeId: doomed.has(state.selectedNodeId ?? '')
          ? null
          : state.selectedNodeId,
        dirty: true,
        ...emptyRunProgress(),
      };
    });
  },

  addEdge: (from, to, kind) => {
    const id = kind === DATA ? shortId('d') : shortId('e');
    const committed = applyWorkflowEdit('user', (state) => {
      // Dedupe: identical from/to/kind edges are ignored.
      const exists = state.workflow.edges.some(
        (e) =>
          e.kind === kind &&
          e.from.node === from.node &&
          e.from.port === from.port &&
          e.to.node === to.node &&
          e.to.port === to.port,
      );
      if (exists) return null;
      return {
        workflow: workflowWithoutRunSnapshot({
          ...state.workflow,
          edges: [...state.workflow.edges, { id, from, to, kind }],
        }),
        dirty: true,
        ...emptyRunProgress(),
      };
    });
    return committed ? id : '';
  },

  removeEdge: (id) => {
    applyWorkflowEdit('user', (state) => {
      const edges = state.workflow.edges.filter((e) => e.id !== id);
      if (edges.length === state.workflow.edges.length) return null;
      return {
        workflow: workflowWithoutRunSnapshot({
          ...state.workflow,
          edges,
        }),
        dirty: true,
        ...emptyRunProgress(),
      };
    });
  },

  // Layout-only write. Deliberately does not set dirty: drags are frequent and
  // position is flushed to persistence via markSaved.
  setNodePosition: (id, x, y) => {
    let committed = false;
    set((state) => {
      if (!canWriteWorkflow(state)) return state;
      committed = true;
      return {
        workflow: {
          ...state.workflow,
          layout: { ...(state.workflow.layout ?? {}), [id]: { x, y } },
        },
      };
    });
    if (committed) void markActiveHistorySessionWorkflow();
  },

  // ── Run / mode control ─────────────────────────────────────────────────

  setMode: (mode) => set({ mode }),

  setRunState: (id, runNodeState) => {
    set((state) => {
      const runState = { ...state.runState, [id]: runNodeState };
      const workflow = workflowWithRunSnapshot(
        state.workflow,
        runSnapshotFromState({ ...state, runState }),
      );
      return { runState, workflow };
    });
    const state = useStore.getState();
    void persistWorkflowRunSnapshot(
      state.workflow,
      runSnapshotFromState(state),
    );
  },

  resetRunState: () => {
    set((state) => ({
      runState: {},
      workflow: workflowWithoutRunSnapshot(state.workflow),
    }));
    const state = useStore.getState();
    void persistWorkflowRunSnapshot(state.workflow, {
      status: 'idle',
      nodeStates: {},
      outputs: {},
      failedNodeId: null,
      error: null,
      updatedAt: Date.now(),
    });
  },

  setCanvasViewport: (viewport) => {
    const nextViewport = normalizeCanvasViewport(viewport);
    const state = useStore.getState();
    if (sameCanvasViewport(state.canvasViewport, nextViewport)) return;
    set({ canvasViewport: nextViewport });
    const ctx = getActiveHistoryContext();
    if (!ctx) return;
    scheduleCanvasViewportPersist(ctx.workspaceId, ctx.sessionId, nextViewport);
  },

  // ── Whole-graph + persistence ──────────────────────────────────────────

  applyGraphEdit: (ir) => {
    commitGraphEdit(ir);
  },

  markSaved: (path) =>
    set((state) => ({
      dirty: false,
      currentFilePath: path ?? state.currentFilePath,
    })),

  // Flip the active session's isWorkflow flag to true (locked — never reverts).
  // Returns the state unchanged when nothing flips so we avoid an extra render.
  markActiveSessionAsWorkflow: () => {
    set((state) => {
      const sessions = markedSessions(state.sessions, state.activeSessionId);
      if (sessions === state.sessions) return state;
      const workspaceId = state.activeWorkspaceId;
      return {
        sessions,
        sessionTree: workspaceId
          ? { ...state.sessionTree, [workspaceId]: sessions }
          : state.sessionTree,
      };
    });
    void markActiveHistorySessionWorkflow();
  },

  // ── Prompt-library CRUD ────────────────────────────────────────────────
  //
  // Every mutating action computes the next promptGroups array, persists it via
  // savePromptGroups(next), and commits it to the store. Edits therefore survive
  // a reload (loadPromptGroups seeds the store on init).

  addPromptItem: (groupId, label, text, locale = useStore.getState().locale) =>
    set((state) => {
      const next = state.promptGroups.map((g) =>
        g.id === groupId
          ? {
              ...g,
              items: [
                ...g.items,
                withPromptItemLocale(
                  { id: shortId('pi'), label, text },
                  locale,
                  { label, text },
                ),
              ],
            }
          : g,
      );
      savePromptGroups(next);
      return { promptGroups: next };
    }),

  updatePromptItem: (groupId, itemId, patch) =>
    set((state) => {
      const locale = state.locale;
      const next = state.promptGroups.map((g) =>
        g.id === groupId
          ? {
              ...g,
              items: g.items.map((it) =>
                it.id === itemId
                  ? withPromptItemLocale(it, locale, {
                      label:
                        typeof patch.label === 'string'
                          ? patch.label
                          : localizePromptItem(it, locale).label,
                      text:
                        typeof patch.text === 'string'
                          ? patch.text
                          : localizePromptItem(it, locale).text,
                    })
                  : it,
              ),
            }
          : g,
      );
      savePromptGroups(next);
      return { promptGroups: next };
    }),

  updatePromptItemLocalized: async (groupId, itemId, patch, locale) => {
    const state = useStore.getState();
    const sourceLocale = locale ?? state.locale;
    const group = state.promptGroups.find((g) => g.id === groupId);
    const item = group?.items.find((it) => it.id === itemId);
    if (!group || !item) return false;

    const current = localizePromptItem(item, sourceLocale);
    const sourceValue = {
      label: typeof patch.label === 'string' ? patch.label : current.label,
      text: typeof patch.text === 'string' ? patch.text : current.text,
    };

    let next = state.promptGroups.map((g) =>
      g.id === groupId
        ? {
            ...g,
            items: g.items.map((it) =>
              it.id === itemId
                ? withPromptItemLocale(it, sourceLocale, sourceValue)
                : it,
            ),
          }
        : g,
    );
    savePromptGroups(next);
    set({ promptGroups: next });

    if (!state.promptAutoTranslate) return false;

    const targetLocales = SUPPORTED_LOCALES.filter(
      (value): value is Locale => value !== sourceLocale,
    );
    try {
      const translated = await translatePromptFields(
        sourceValue,
        sourceLocale,
        targetLocales,
        promptTranslationGatewayOptions(state),
      );
      const translatedLocales = Object.entries(translated) as [
        Locale,
        { label: string; text: string },
      ][];
      if (translatedLocales.length > 0) {
        next = useStore.getState().promptGroups.map((g) =>
          g.id === groupId
            ? {
                ...g,
                items: g.items.map((it) =>
                  it.id === itemId
                    ? translatedLocales.reduce(
                        (acc, [localeKey, value]) =>
                          withPromptItemLocale(acc, localeKey, value),
                        it,
                      )
                    : it,
                ),
              }
            : g,
        );
        savePromptGroups(next);
        set({ promptGroups: next });
      }
      return translatedLocales.length > 0;
    } catch {
      return false;
    }
  },

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

  addPromptGroup: (label, locale = useStore.getState().locale) => {
    const id = shortId('pg');
    set((state) => {
      const next = [
        ...state.promptGroups,
        withPromptGroupLocale({ id, label, items: [] }, locale, { label }),
      ];
      savePromptGroups(next);
      return { promptGroups: next };
    });
    return id;
  },

  updatePromptGroup: (groupId, label) =>
    set((state) => {
      const locale = state.locale;
      const next = state.promptGroups.map((g) =>
        g.id === groupId
          ? withPromptGroupLocale(g, locale, {
              label:
                typeof label === 'string'
                  ? label
                  : localizePromptGroup(g, locale).label,
            })
          : g,
      );
      savePromptGroups(next);
      return { promptGroups: next };
    }),

  updatePromptGroupLocalized: async (groupId, label, locale) => {
    const state = useStore.getState();
    const sourceLocale = locale ?? state.locale;
    const group = state.promptGroups.find((g) => g.id === groupId);
    if (!group) return false;

    const current = localizePromptGroup(group, sourceLocale);
    const sourceLabel = typeof label === 'string' ? label : current.label;

    let next = state.promptGroups.map((g) =>
      g.id === groupId
        ? withPromptGroupLocale(g, sourceLocale, { label: sourceLabel })
        : g,
    );
    savePromptGroups(next);
    set({ promptGroups: next });

    if (!state.promptAutoTranslate) return false;

    const targetLocales = SUPPORTED_LOCALES.filter(
      (value): value is Locale => value !== sourceLocale,
    );
    try {
      const translated = await translatePromptFields(
        { label: sourceLabel },
        sourceLocale,
        targetLocales,
        promptTranslationGatewayOptions(state),
      );
      const translatedLocales = Object.entries(translated) as [
        Locale,
        { label?: string; text?: string },
      ][];
      if (translatedLocales.length > 0) {
        next = useStore.getState().promptGroups.map((g) =>
          g.id === groupId
            ? translatedLocales.reduce(
                (acc, [localeKey, value]) =>
                  withPromptGroupLocale(acc, localeKey, {
                    label: value.label || sourceLabel,
                  }),
                g,
              )
            : g,
        );
        savePromptGroups(next);
        set({ promptGroups: next });
      }
      return translatedLocales.length > 0;
    } catch {
      return false;
    }
  },

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

interface RunConfig {
  cwd?: string;
  permission?: string;
  model?: string;
  cliCommand?: string;
  gatewaySelection?: GatewaySelection;
}

/**
 * A run is bound to the session that started it — NOT to whatever session the
 * user is currently viewing. This channel is that run's single source of truth:
 * the run loop reads/writes the shadow state here, and `channelCommit` mirrors it
 * into the live store ONLY while the owning session is the active view, and
 * persists it to the owning session regardless. That decoupling is what lets a
 * run keep executing in the background after the user switches to another
 * session (and resume seamlessly when they switch back). Multiple sessions may
 * have their own channels so independent workflow blueprints can run together.
 */
interface RunChannel {
  key: string;
  workspaceId: string | null;
  sessionId: string | null;
  cancelled: boolean;
  workflow: IRGraph;
  config: RunConfig;
  cliRunIds: Set<string>;
  messages: Message[];
  runState: Record<string, NodeRunState>;
  runOutputs: Record<string, string>;
  failedNodeId: string | null;
  error: Record<string, unknown> | null;
}
const activeRuns = new Map<string, RunChannel>();

interface AiEditChannel {
  key: string;
  workspaceId: string | null;
  sessionId: string | null;
  workflow: IRGraph;
  messages: Message[];
}
const activeAiEdits = new Map<string, AiEditChannel>();
const aiEditSnapshots = new Map<string, AiEditChannel>();

function runKey(workspaceId: string | null, sessionId: string | null): string {
  return workflowSessionKeyId({ workspaceId, sessionId });
}

function getRunChannel(workspaceId: string | null, sessionId: string | null): RunChannel | null {
  return activeRuns.get(runKey(workspaceId, sessionId)) ?? null;
}

function getRunChannelByKey(key: string): RunChannel | null {
  return activeRuns.get(key) ?? null;
}

function getAiEditChannelByKey(key: string): AiEditChannel | null {
  return activeAiEdits.get(key) ?? null;
}

function getAiEditChannel(
  workspaceId: string | null,
  sessionId: string | null,
): AiEditChannel | null {
  return activeAiEdits.get(runKey(workspaceId, sessionId)) ?? null;
}

function getAiEditSnapshot(
  workspaceId: string | null,
  sessionId: string | null,
): AiEditChannel | null {
  return aiEditSnapshots.get(runKey(workspaceId, sessionId)) ?? null;
}

function activeRunChannels(): RunChannel[] {
  return [...activeRuns.values()].filter((ch) => !ch.cancelled);
}

function activeAiEditChannels(): AiEditChannel[] {
  return [...activeAiEdits.values()];
}

function runningProgressFromChannel(ch: RunChannel): RunProgressSummary {
  return selectRunProgress(
    ch.runState,
    runnableOrder(ch.workflow).map((node) => node.id),
  );
}

function runningSessionProgressByKey(): Record<string, RunProgressSummary> {
  return Object.fromEntries(
    [...activeRuns.values()].map((ch) => [
      ch.key,
      runningProgressFromChannel(ch),
    ]),
  );
}

function syncRunningSessions(): void {
  const runningSessions = activeRunChannels().map((ch) => ({
    workspaceId: ch.workspaceId,
    sessionId: ch.sessionId,
  }));
  const first = runningSessions[0] ?? null;
  useStore.setState({
    runningSessions,
    runningSessionProgress: runningSessionProgressByKey(),
    runningSessionId: first?.sessionId ?? null,
    runningWorkspaceId: first?.workspaceId ?? null,
  });
}

function syncAiEditingSessions(): void {
  const aiEditingSessions = activeAiEditChannels().map((ch) => ({
    workspaceId: ch.workspaceId,
    sessionId: ch.sessionId,
  }));
  useStore.setState({
    aiEditingSessions,
    aiStreaming: aiEditingSessions.length > 0,
  });
}

function syncRunningSessionProgress(): void {
  useStore.setState({ runningSessionProgress: runningSessionProgressByKey() });
}

function aiEditRegistered(ch: AiEditChannel | null): ch is AiEditChannel {
  return !!ch && activeAiEdits.get(ch.key) === ch;
}

function aiEditActive(ch: AiEditChannel | null): boolean {
  return aiEditRegistered(ch);
}

function aiEditViewActive(ch: AiEditChannel | null): boolean {
  if (!ch) return false;
  if (!ch.sessionId) return true;
  const s = useStore.getState();
  return s.activeSessionId === ch.sessionId && s.activeWorkspaceId === ch.workspaceId;
}

function addAiEditChannel(ch: AiEditChannel): void {
  activeAiEdits.set(ch.key, ch);
  aiEditSnapshots.set(ch.key, { ...ch, messages: [...ch.messages] });
  syncAiEditingSessions();
}

function removeAiEditChannel(ch: AiEditChannel | null): void {
  if (!aiEditRegistered(ch)) return;
  aiEditSnapshots.set(ch.key, { ...ch, messages: [...ch.messages] });
  activeAiEdits.delete(ch.key);
  syncAiEditingSessions();
}

/** Is a run alive? (false once the user hits 停止, or the channel is gone.) */
function runRegistered(ch: RunChannel | null): ch is RunChannel {
  return !!ch && activeRuns.get(ch.key) === ch;
}

/** Is a run alive? (false once the user hits 停止, or the channel is gone.) */
function runActive(ch: RunChannel | null): boolean {
  return runRegistered(ch) && !ch.cancelled;
}

/**
 * Is the running session the one currently shown in the UI? When true, run
 * writes mirror into the live store (the user watches live progress); when false
 * the run is backgrounded and writes only persist to its owning session. Falls
 * back to true when there is no history context (browser/simulator single view).
 */
function runViewActive(ch: RunChannel | null): boolean {
  if (!ch) return false;
  if (!ch.sessionId) return true;
  const s = useStore.getState();
  return s.activeSessionId === ch.sessionId && s.activeWorkspaceId === ch.workspaceId;
}

/** Build an IRRunSnapshot from the channel's shadow state. */
function channelSnapshot(ch: RunChannel, status: IRRunStatus): IRRunSnapshot {
  return {
    status,
    nodeStates: Object.fromEntries(
      Object.entries(ch.runState).filter(([, s]) => s !== 'idle'),
    ),
    outputs: Object.fromEntries(
      Object.entries(ch.runOutputs).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    ),
    failedNodeId: ch.failedNodeId,
    error: ch.error,
    route: ch.config.gatewaySelection,
    updatedAt: Date.now(),
  };
}

/**
 * Persist the channel's shadow to its OWNING session (not the active view).
 * When the run has no history context (browser/simulator) it falls back to the
 * active-session path only while that run is the visible session. Deliberately
 * skips `.owf.json` file autosave for backgrounded runs so a background run
 * never overwrites the file bound to the session the user is currently editing.
 */
async function persistChannelSnapshot(
  ch: RunChannel,
  snapshot: IRRunSnapshot,
): Promise<void> {
  const workflow = workflowWithRunSnapshot(ch.workflow, snapshot);
  if (!ch.workspaceId || !ch.sessionId) {
    if (runViewActive(ch)) {
      await persistWorkflowRunSnapshot(workflow, snapshot);
    }
    return;
  }
  try {
    await historyStore.updateSession(ch.workspaceId, ch.sessionId, {
      messages: ch.messages,
      workflow,
      meta: runMetaFromSnapshot(snapshot),
    });
  } catch {
    /* persistence is best-effort; the in-memory channel stays authoritative */
  }
}

/**
 * Mirror the channel's full shadow into the live store (only when its session is
 * the active view) and persist a run snapshot to the owning session. Called on
 * every node-state transition and at terminal states.
 */
function channelCommit(ch: RunChannel | null, status: IRRunStatus, persist = true): void {
  if (!runRegistered(ch)) return;
  const snapshot = channelSnapshot(ch, status);
  ch.workflow = workflowWithRunSnapshot(ch.workflow, snapshot);
  syncRunningSessionProgress();
  if (status !== 'running') {
    syncSessionRunStatus(
      { workspaceId: ch.workspaceId, sessionId: ch.sessionId },
      status,
    );
  }
  if (runViewActive(ch)) {
    useStore.setState({
      messages: ch.messages,
      runState: ch.runState,
      runOutputs: ch.runOutputs,
      lastRunFailedNodeId: ch.failedNodeId,
      workflow: ch.workflow,
    });
  }
  if (persist) void persistChannelSnapshot(ch, snapshot);
}

/**
 * Lightweight commit for message-only changes (logs, streaming chunks). Mirrors
 * the channel's message buffer into the live store when viewed; persists only
 * when asked (streaming chunks pass persist=false to avoid per-chunk writes).
 */
function channelCommitMessages(ch: RunChannel | null, persist: boolean): void {
  if (!runRegistered(ch)) return;
  if (runViewActive(ch)) {
    useStore.setState({ messages: ch.messages });
  }
  if (persist && ch.workspaceId && ch.sessionId) {
    const ws = ch.workspaceId;
    const session = ch.sessionId;
    const messages = ch.messages;
    void historyStore
      .updateSession(ws, session, { messages })
      .catch(() => {});
  }
}

function updateAiEditSessionSummary(ch: AiEditChannel): void {
  const last = ch.messages[ch.messages.length - 1]?.text ?? '';
  const updatedAt = Date.now();
  const matchesSession = (session: Session): boolean => {
    if (session.id !== ch.sessionId) return false;
    if (
      ch.workspaceId !== null &&
      session.workspaceId !== undefined &&
      session.workspaceId !== ch.workspaceId
    ) {
      return false;
    }
    return true;
  };
  const update = (session: Session): Session =>
    matchesSession(session)
      ? {
          ...session,
          isWorkflow: true,
          updatedAt,
          preview: last ? previewFromText(last) : session.preview,
          messageCount: ch.messages.length,
        }
      : session;

  useStore.setState((state) => {
    const sessions = state.sessions.map(update);
    const sessionTree =
      ch.workspaceId && state.sessionTree[ch.workspaceId]
        ? {
            ...state.sessionTree,
            [ch.workspaceId]: state.sessionTree[ch.workspaceId].map(update),
          }
        : state.sessionTree;
    return { sessions, sessionTree };
  });
}

function persistAiEditMessages(ch: AiEditChannel): void {
  if (!ch.workspaceId || !ch.sessionId) return;
  const { workspaceId, sessionId, messages } = ch;
  void historyStore
    .updateSession(workspaceId, sessionId, { messages })
    .catch(() => {});
}

function persistAiEditWorkflow(ch: AiEditChannel): void {
  if (!ch.workspaceId || !ch.sessionId) return;
  const { workspaceId, sessionId, messages, workflow } = ch;
  void historyStore
    .updateSession(workspaceId, sessionId, {
      messages,
      workflow,
      meta: emptyRunMeta(),
    })
    .catch(() => {});
}

function aiEditCommitMessages(ch: AiEditChannel | null, persist: boolean): void {
  if (!aiEditRegistered(ch)) return;
  aiEditSnapshots.set(ch.key, { ...ch, messages: [...ch.messages] });
  if (aiEditViewActive(ch)) {
    useStore.setState({ messages: ch.messages });
  }
  if (persist) {
    updateAiEditSessionSummary(ch);
    persistAiEditMessages(ch);
  }
}

function aiEditCommitWorkflow(ch: AiEditChannel | null, persist: boolean): void {
  if (!aiEditRegistered(ch)) return;
  aiEditSnapshots.set(ch.key, { ...ch, messages: [...ch.messages] });
  if (aiEditViewActive(ch)) {
    useStore.setState({
      messages: ch.messages,
      workflow: ch.workflow,
      selectedNodeId: null,
      dirty: true,
      ...emptyRunProgress(),
    });
  }
  if (persist) {
    updateAiEditSessionSummary(ch);
    syncSessionRunStatus(
      { workspaceId: ch.workspaceId, sessionId: ch.sessionId },
      undefined,
    );
    persistAiEditWorkflow(ch);
  }
}

function commitAiChannelBlueprint(ch: AiEditChannel, ir: IRGraph): boolean {
  if (!aiEditActive(ch)) return false;
  ch.workflow = prepareGraphEdit(ch.workflow, ir);
  aiEditCommitWorkflow(ch, true);
  return true;
}

/** Append a message to the run channel (or, with no run, to the live store). */
function pushChannelMessage(
  ch: RunChannel | null,
  msg: Message,
  persist: boolean,
): void {
  if (ch) {
    ch.messages = [...ch.messages, msg];
    channelCommitMessages(ch, persist);
    return;
  }
  useStore.setState((s) => ({ messages: [...s.messages, msg] }));
  void persistMessage(msg);
}

/** Mark a node's run state through the channel (or live store with no run). */
function markRunNode(ch: RunChannel | null, id: string, state: NodeRunState): void {
  if (ch) {
    ch.runState = { ...ch.runState, [id]: state };
    channelCommit(ch, 'running');
    return;
  }
  useStore.getState().setRunState(id, state);
}

/** Tear down the active run channel and clear the Sidebar "running" markers. */
function finishRun(ch: RunChannel | null): void {
  if (!ch) return;
  activeRuns.delete(ch.key);
  syncRunningSessions();
}

/**
 * Resolvers for interaction messages the run loop is currently blocked on,
 * keyed by message id. `answerInteraction` (user submits the widget) or
 * `resolvePendingInteractions` (run stopped) calls the resolver to unblock the
 * awaiting node. Each entry tracks the owning run so multiple runs can wait on
 * interactions independently.
 */
const pendingInteractionResolvers = new Map<
  string,
  {
    runKey: string | null;
    aiEditKey: string | null;
    resolve: (answer: InteractionAnswer | null) => void;
  }
>();

/** Max times a single node may ask the user before we stop re-invoking it. */
const MAX_INTERACTION_ROUNDS = 6;

/** How many times to force a blueprint-only retry when the model gives prose. */
const MAX_BLUEPRINT_RETRIES = 2;

const BLUEPRINT_DIRECT_EDIT_CONTRACT = `---
普通 AI 输入框编辑规则：
- 默认目标是把用户需求写入 workflow 蓝图，而不是生成 Markdown 计划或让用户确认后再做。
- 必须基于当前 IRGraph 输出“简短中文说明 + 一个完整 \`\`\`json IRGraph 代码块”。
- 不要输出交互块，不要提问，不要等待批准，不要创建/修改本地文件。
- 如果需求提到“规划代码修改/支持某功能/实现某能力”，把它转成 workflow 节点：例如需求理解、代码定位、实现、验证、回归检查、总结等步骤。
- 信息不足时自行做保守假设，并把需要后续确认的事项放进蓝图中的澄清/验证节点。
- 蓝图规模要和任务复杂度匹配：简单需求优先最小充分结构，复杂需求才展开更多步骤、分支和验证。`;

/** The two — and only two — option labels for the granularity-choice select. */
const SIMPLE_OPT_MINIMAL = '直接改图（最小改动）';
const SIMPLE_OPT_FULL = '生成完整多步工作流蓝图';

const SIMPLE_TASK_ESCAPE_CONTRACT = `---
普通 AI 输入框编辑规则（默认改蓝图）：
- 默认目标是把用户需求写入 workflow 蓝图：直接基于当前 IRGraph 输出“简短中文说明 + 一个完整 \`\`\`json IRGraph 代码块”。
- 不要输出 Markdown 计划/需求文档/TODO/文件名，不要等待用户批准，不要创建或修改本地文件。
- 蓝图规模要和任务复杂度匹配：简单需求优先最小充分结构，复杂需求再展开成多步流程。
- 唯一例外：只有当你判断当前输入在“直接改一个小点”与“需要完整多步蓝图”之间真的存在结构性歧义，且这个选择会明显改变蓝图形态时，才用下方交互协议发**一个** select（然后立刻结束本回合，不要再输出蓝图或其它文字），选项必须**正好**是这两项：
  ["${SIMPLE_OPT_MINIMAL}", "${SIMPLE_OPT_FULL}"]
  让用户自己选“直接做最小改动”还是“铺成完整多步蓝图”。
- 除上面这一个例外，其余一切情况都必须直接出蓝图，绝不只输出说明。`;

const INTERACTION_BLUEPRINT_APPENDIX = `---
交互完成后的强制规则：
- 用户已经回答了一个 select / input / confirm 之后，下一轮必须把这次回答吸收到当前 workflow 蓝图里并输出完整 IRGraph。
- 不要继续把对话停留在问答、说明或 Markdown 计划上。
- 不要再追问，除非当前回答根本无法理解；即使如此，也要尽快收口到蓝图修改。`;

function isGrillRequest(text: string): boolean {
  return /^(grill[-\s]?me|拷问我|审问我|质询我|挑战我)$/i.test(text.trim());
}

function isClarifyingEditRequest(text: string): boolean {
  const trimmed = text.trim();
  if (isGrillRequest(trimmed)) return true;
  return /(?:先|动手前|改图前|修改前|执行前).*(?:确认|澄清|追问|提问|询问|反问)|(?:确认|澄清|追问|提问|询问|反问).*(?:再|后).*(?:改图|修改|优化|生成)|(?:用|通过).*(?:交互|select\s*\/\s*input|select|input|confirm).*(?:确认|澄清|提问|询问)|逐个.*(?:确认|澄清|提问|询问)|问清|grill[-\s]?me|clarify|ask me|question me|confirm with me/i.test(
    trimmed,
  );
}

function replyIncludesIRGraph(text: string): boolean {
  try {
    const parsed = JSON.parse(extractJsonObject(text)) as Partial<IRGraph>;
    return Array.isArray(parsed.nodes) && Array.isArray(parsed.edges);
  } catch {
    return false;
  }
}

function strictBlueprintRetryAppendix(previousReply: string): string {
  return `\n\n---
上一轮输出没有包含可解析的 workflow IRGraph，因此不能写入蓝图。上一轮输出节选如下：
${previousReply.slice(0, 4000)}

请忽略上一轮的 Markdown/计划/确认请求，直接基于最初的用户需求和当前 IRGraph 返回：
1) 简短中文说明。
2) 一个完整、可解析、可直接写入蓝图的 \`\`\`json IRGraph 代码块。
不得创建或修改本地文件，不得等待用户批准。`;
}

/**
 * Push an interactive message into the dock and return a promise that resolves
 * when the user answers it (or null if the run is stopped first).
 */
function awaitInteraction(
  ch: RunChannel | null,
  req: InteractionRequest,
  aiCh: AiEditChannel | null = null,
): Promise<InteractionAnswer | null> {
  const id = shortId('m');
  const msg: Message = {
    id,
    role: 'assistant',
    text: req.prompt,
    createdAt: Date.now(),
    interaction: req,
    interactionStatus: 'pending',
  };
  if (aiCh) {
    aiCh.messages = [...aiCh.messages, msg];
    aiEditCommitMessages(aiCh, true);
  } else {
    pushChannelMessage(ch, msg, true);
  }
  return new Promise((resolve) => {
    pendingInteractionResolvers.set(id, {
      runKey: ch?.key ?? null,
      aiEditKey: aiCh?.key ?? null,
      resolve,
    });
  });
}

/** Cancel in-flight interactions for one run (run stopped): resolve null, mark them. */
function resolvePendingInteractions(ch: RunChannel | null): void {
  if (!ch) return;
  for (const [id, entry] of [...pendingInteractionResolvers]) {
    if (entry.runKey !== ch.key) continue;
    pendingInteractionResolvers.delete(id);
    entry.resolve(null);
  }
  const mark = (m: Message): Message =>
    m.interaction && m.interactionStatus === 'pending'
      ? { ...m, interactionStatus: 'cancelled' }
      : m;
  ch.messages = ch.messages.map(mark);
  channelCommitMessages(ch, true);
}

/** Append a system log line to the message stream (routed through the run channel). */
function pushRunLog(
  ch: RunChannel | null,
  text: string,
  role: Message['role'] = 'system',
): void {
  const msg: Message = { id: shortId('m'), role, text, createdAt: Date.now() };
  pushChannelMessage(ch, msg, true);
}

function formatClock(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const sec = String(seconds).padStart(2, '0');
  const min = String(minutes).padStart(2, '0');
  if (hours > 0) return `${hours}h ${min}m ${sec}s`;
  if (minutes > 0) return `${minutes}m ${sec}s`;
  return `${seconds}s`;
}

function runnableOrder(workflow: IRGraph): IRNode[] {
  return topoOrderExec(workflow).filter(isRunnable);
}

function findResumeNodeId(state: StoreState): string | null {
  const nodeIds = new Set(state.workflow.nodes.map((node) => node.id));
  if (
    state.lastRunFailedNodeId &&
    nodeIds.has(state.lastRunFailedNodeId) &&
    state.runState[state.lastRunFailedNodeId] !== 'success'
  ) {
    return state.lastRunFailedNodeId;
  }
  return (
    runnableOrder(state.workflow).find((node) => {
      const status = state.runState[node.id];
      return status === 'error' || status === 'interrupted';
    })?.id ?? null
  );
}

function seedRunStateFromOutputs(
  workflow: IRGraph,
  outputs: Record<string, string>,
  existing: Record<string, NodeRunState> = {},
): Record<string, NodeRunState> {
  const nodeIds = new Set(workflow.nodes.map((node) => node.id));
  const runState: Record<string, NodeRunState> = { ...existing };
  for (const nodeId of Object.keys(outputs)) {
    if (nodeIds.has(nodeId)) runState[nodeId] = 'success';
  }
  return runState;
}

function workflowHasDirectGatewayRoute(
  workflow: IRGraph,
  workflowSelection: GatewaySelection,
): boolean {
  for (const node of runnableOrder(workflow)) {
    const nodeSelection = applyGatewayOverride(
      workflowSelection,
      nodeGatewayOverride(node.params) ?? undefined,
    );

    if (node.type === 'agent' || node.type === 'workflow') {
      if (resolveDirectGatewayRoute(nodeSelection)) return true;
    } else if (node.type === 'parallel') {
      for (const spec of specList(node.params.branches)) {
        const selection = applyGatewayOverride(
          nodeSelection,
          runSpecGatewayOverride(spec),
        );
        if (resolveDirectGatewayRoute(selection)) return true;
      }
    } else if (node.type === 'pipeline') {
      for (const spec of specList(node.params.stages)) {
        const selection = applyGatewayOverride(
          nodeSelection,
          runSpecGatewayOverride(spec),
        );
        if (resolveDirectGatewayRoute(selection)) return true;
      }
    }
  }
  return false;
}

function getRunLaunchContext(state: StoreState): {
  workspaceId: string | null;
  sessionId: string | null;
} {
  const ctx = getActiveHistoryContext();
  if (ctx) return ctx;
  return { workspaceId: null, sessionId: state.activeSessionId };
}

function startWorkflowRun(resume: boolean): void {
  const state = useStore.getState();
  if (isWorkflowReadOnly(state)) return;

  const { workflow } = state;
  const name = workflow.meta.name ?? 'untitled';
  const gatewaySelection = workflowDefaultGatewaySelection(
    workflow,
    state.composer.model,
  );
  const adapter = gatewaySelection.adapter;
  const runStartedAt = Date.now();
  const resumeFromNodeId = resume ? findResumeNodeId(state) : null;
  if (resume && !resumeFromNodeId) {
    pushRunLog(null, '没有可继续的失败节点。', 'system');
    return;
  }

  const resumeNode = resumeFromNodeId
    ? workflow.nodes.find((node) => node.id === resumeFromNodeId)
    : null;
  const seedOutputs = resume ? { ...state.runOutputs } : {};
  const initialRunState = resume
    ? seedRunStateFromOutputs(workflow, seedOutputs, state.runState)
    : {};
  if (resumeFromNodeId) delete initialRunState[resumeFromNodeId];

  // Capture the run's workspace + permission (from the AIDock controls) so each
  // node's CLI agent runs in the right dir with enough access to act without
  // stalling on permission prompts.
  const config: RunConfig = {
    cwd: state.composer.workspace || undefined,
    permission: state.composer.permission || 'full',
    model: gatewaySelection.modelClass,
    gatewaySelection,
  };

  // Bind this run to the session that started it. The channel — not the active
  // view — is the run's source of truth from here on, so switching sessions
  // leaves it running in the background (writes route to its owning session).
  const ctx = getRunLaunchContext(state);
  const key = runKey(ctx.workspaceId, ctx.sessionId);
  const ch: RunChannel = {
    key,
    workspaceId: ctx.workspaceId,
    sessionId: ctx.sessionId,
    cancelled: false,
    workflow,
    config,
    cliRunIds: new Set<string>(),
    messages: [...state.messages],
    runState: { ...initialRunState },
    runOutputs: { ...seedOutputs },
    failedNodeId: null,
    error: null,
  };

  activeRuns.set(key, ch);
  syncRunningSessions();

  useStore.setState({
    mode: 'running',
    runState: initialRunState,
    runOutputs: seedOutputs,
    lastRunFailedNodeId: null,
  });

  const action = resume ? '继续工作流' : '运行工作流';
  const from = resumeNode
    ? ` · 从 "${resumeNode.label ?? resumeNode.type}" 继续`
    : '';
  const runMsg: Message = {
    id: shortId('m'),
    role: 'system',
    text: `▶ ${action} "${name}"${from} · 开始 ${formatClock(runStartedAt)} · 运行时 ${adapter} · 模型 ${gatewaySelection.modelClass} · 权限 ${ch.config.permission}${ch.config.cwd ? ` · 工作区 ${ch.config.cwd}` : ''}`,
    createdAt: runStartedAt,
  };
  ch.messages = [...ch.messages, runMsg];
  channelCommit(ch, 'running', true);

  if (isTauri() || workflowHasDirectGatewayRoute(workflow, gatewaySelection)) {
    void executeViaCliInterpreter(ch, workflow, adapter, runStartedAt, {
      resumeFromNodeId,
      seedOutputs,
    });
  } else {
    void executeViaSimulator(ch, workflow, { resumeFromNodeId, seedOutputs });
  }
}

function stopWorkflowRun(): void {
  const state = useStore.getState();
  const ch = getRunChannel(state.activeWorkspaceId ?? null, state.activeSessionId);
  if (!ch) return;

  const runningNodeIds = Object.entries(ch.runState)
    .filter(([, status]) => status === 'running')
    .map(([nodeId]) => nodeId);
  const interruptedNodeId = runningNodeIds[0] ?? null;
  const stoppedAt = Date.now();
  const runError = interruptedNodeId
    ? {
        code: 'interrupted',
        message: '用户手动中断运行。',
        nodeId: interruptedNodeId,
        occurredAt: stoppedAt,
      }
    : null;

  // Flip the channel to cancelled FIRST so the run loop's `stillRunning()` short-
  // circuits, then record the interrupted state.
  ch.cancelled = true;
  ch.runState = {
    ...ch.runState,
    ...Object.fromEntries(
      runningNodeIds.map((nodeId) => [nodeId, 'interrupted' as const]),
    ),
  };
  ch.failedNodeId = interruptedNodeId;
  ch.error = runError;

  resolvePendingInteractions(ch);
  void cancelActiveCliRuns(ch);
  pushRunLog(
    ch,
    interruptedNodeId
      ? `⏹ 运行已中断 · ${formatClock(stoppedAt)} · 可从当前节点继续。`
      : `⏹ 运行已中断 · ${formatClock(stoppedAt)}。`,
    'assistant',
  );
  channelCommit(ch, 'interrupted', true);
  // The stop button only exists on the live run view, so drop back to design.
  if (runViewActive(ch)) useStore.getState().setMode('design');
  finishRun(ch);
}

function makeCliRunId(): string {
  return `cli_${Date.now()}_${shortId('run')}`;
}

async function cancelActiveCliRuns(ch: RunChannel | null): Promise<void> {
  const runIds = ch ? [...ch.cliRunIds] : [];
  await Promise.all(runIds.map((runId) => cancelAiCli(runId).catch(() => {})));
}

async function invokeAgentCli(
  ch: RunChannel,
  prompt: string,
  adapter: string,
  opts: {
    model?: string;
    cliCommand?: string;
    env?: Record<string, string>;
    cwd?: string;
    permission?: string;
    timeoutSeconds?: number;
    idleTimeoutSeconds?: number;
    onProgress?: (text: string) => void;
    sessionId?: string;
    resume?: boolean;
  } = {},
): Promise<string> {
  const runId = makeCliRunId();
  ch.cliRunIds.add(runId);
  try {
    return await aiEditViaCli(prompt, adapter, {
      ...opts,
      cliCommand: opts.cliCommand ?? ch.config.cliCommand,
      env: opts.env,
      timeoutSeconds: opts.timeoutSeconds,
      idleTimeoutSeconds: opts.idleTimeoutSeconds,
      runId,
    });
  } finally {
    ch.cliRunIds.delete(runId);
  }
}

async function invokeGatewayAgent(
  ch: RunChannel,
  prompt: string,
  selection: GatewaySelection,
  opts: {
    model?: string;
    omitModel?: boolean;
    cliCommand?: string;
    cwd?: string;
    permission?: string;
    timeoutSeconds?: number;
    idleTimeoutSeconds?: number;
    onProgress?: (text: string) => void;
    sessionId?: string;
    resume?: boolean;
  } = {},
): Promise<{ text: string; adapter: string }> {
  const direct = resolveDirectGatewayRoute(selection);
  if (direct) {
    const startedAt = Date.now();
    let firstProgressAt: number | undefined;
    try {
      const text = await completeGatewayText({
        route: {
          ...direct,
          model: opts.omitModel ? undefined : opts.model ?? direct.model,
        },
        system: '',
        userContent: prompt,
        maxTokens: 8192,
        onDelta: (chunk) => {
          firstProgressAt ??= Date.now();
          opts.onProgress?.(chunk);
        },
      });
      recordModelCall(selection, {
        elapsedMs: Date.now() - startedAt,
        firstProgressMs: firstProgressAt ? firstProgressAt - startedAt : undefined,
        ok: true,
      });
      return { text, adapter: direct.adapter };
    } catch (err) {
      const failure = describeRunFailure(err);
      recordModelCall(selection, {
        elapsedMs: Date.now() - startedAt,
        firstProgressMs: firstProgressAt ? firstProgressAt - startedAt : undefined,
        ok: false,
        failureCode: failure.code,
        timeoutSeconds: failure.timeoutSeconds,
        idleTimeoutSeconds: failure.idleTimeoutSeconds,
      });
      throw err;
    }
  }

  const cli = await resolveCliGatewayRoute(selection);
  const startedAt = Date.now();
  let firstProgressAt: number | undefined;
  try {
    const text = await invokeAgentCli(ch, prompt, cli.adapter, {
      model: opts.omitModel ? undefined : opts.model ?? cli.model,
      env: cli.env,
      cwd: opts.cwd,
      permission: opts.permission,
      timeoutSeconds: opts.timeoutSeconds,
      idleTimeoutSeconds: opts.idleTimeoutSeconds,
      cliCommand: opts.cliCommand ?? cli.cliCommand,
      onProgress: (chunk) => {
        firstProgressAt ??= Date.now();
        opts.onProgress?.(chunk);
      },
      sessionId: opts.sessionId,
      resume: opts.resume,
    });
    recordModelCall(selection, {
      elapsedMs: Date.now() - startedAt,
      firstProgressMs: firstProgressAt ? firstProgressAt - startedAt : undefined,
      ok: true,
    });
    return { text, adapter: cli.adapter };
  } catch (err) {
    const failure = describeRunFailure(err);
    recordModelCall(selection, {
      elapsedMs: Date.now() - startedAt,
      firstProgressMs: firstProgressAt ? firstProgressAt - startedAt : undefined,
      ok: false,
      failureCode: failure.code,
      timeoutSeconds: failure.timeoutSeconds,
      idleTimeoutSeconds: failure.idleTimeoutSeconds,
    });
    throw err;
  }
}

/** A fresh Claude session id (uuid) for chaining warm context across steps. */
function newSessionId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    /* fall through */
  }
  // Deterministic-enough fallback uuid v4 shape.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function withNodeExecutionContract(prompt: string): string {
  return `${prompt}

---
OpenWorkflows node execution contract:
- Treat this as one bounded workflow node, not an open-ended session.
- Finish with a concise final answer even if optional verification remains.
- Do not start long-running ad-hoc harnesses after the requested checks pass.
- If a command or investigation stops making progress, stop and report the exact next step instead of waiting indefinitely.`;
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
  gateway?: NodeGatewayOverride;
}

type RunFailureCode =
  | 'timeout'
  | 'idle_timeout'
  | 'interrupted'
  | 'exit'
  | 'spawn'
  | 'backend'
  | 'wait'
  | 'unknown';

interface RunFailure {
  code: RunFailureCode;
  message: string;
  raw: string;
  cli?: string;
  exitCode?: number;
  timeoutSeconds?: number;
  idleTimeoutSeconds?: number;
}

const RUN_ERROR_PREVIEW_LIMIT = 1200;

function compactRunError(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= RUN_ERROR_PREVIEW_LIMIT) return trimmed;
  return `${trimmed.slice(0, RUN_ERROR_PREVIEW_LIMIT)}\n...（错误信息已截断）`;
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}

function describeRunFailure(err: unknown): RunFailure {
  const raw = compactRunError(errorText(err));

  if (raw === 'NO_BACKEND') {
    return {
      code: 'backend',
      raw,
      message: '当前不在 Tauri 桌面壳，无法调用本地 CLI。',
    };
  }

  const timeout = /CLI "([^"]+)" 超时[（(](\d+)s[）)]已终止/u.exec(raw);
  if (timeout) {
    const seconds = Number(timeout[2]);
    return {
      code: 'timeout',
      raw,
      cli: timeout[1],
      timeoutSeconds: seconds,
      message: `CLI "${timeout[1]}" 超过 ${seconds}s 未完成，已终止。可通过 OPENWORKFLOW_AI_CLI_TIMEOUT_SECS 调整上限。`,
    };
  }

  const idleTimeout =
    /CLI "([^"]+)" 空转超过 (\d+)s 未产生输出，已终止/u.exec(raw);
  if (idleTimeout) {
    const seconds = Number(idleTimeout[2]);
    return {
      code: 'idle_timeout',
      raw,
      cli: idleTimeout[1],
      idleTimeoutSeconds: seconds,
      message: `CLI "${idleTimeout[1]}" 超过 ${seconds}s 没有新的输出或结果文件更新，已终止。可通过 OPENWORKFLOW_AI_CLI_IDLE_TIMEOUT_SECS 调整。`,
    };
  }

  const interrupted = /CLI "([^"]+)" 已由用户中断/u.exec(raw);
  if (interrupted) {
    return {
      code: 'interrupted',
      raw,
      cli: interrupted[1],
      message: `CLI "${interrupted[1]}" 已由用户中断。`,
    };
  }

  const exit = /CLI "([^"]+)" 退出码 (-?\d+):\s*([\s\S]*)/u.exec(raw);
  if (exit) {
    const detail = exit[3]?.trim();
    return {
      code: 'exit',
      raw,
      cli: exit[1],
      exitCode: Number(exit[2]),
      message: `CLI "${exit[1]}" 退出码 ${exit[2]}${
        detail ? `: ${detail}` : ''
      }`,
    };
  }

  const spawn = /启动 CLI "([^"]+)" 失败:\s*([\s\S]*)/u.exec(raw);
  if (spawn) {
    return {
      code: 'spawn',
      raw,
      cli: spawn[1],
      message: `无法启动 CLI "${spawn[1]}"：${spawn[2].trim()}`,
    };
  }

  const wait = /等待 CLI "([^"]+)" 失败:\s*([\s\S]*)/u.exec(raw);
  if (wait) {
    return {
      code: 'wait',
      raw,
      cli: wait[1],
      message: `等待 CLI "${wait[1]}" 结束失败：${wait[2].trim()}`,
    };
  }

  return { code: 'unknown', raw, message: raw || '未知错误' };
}

function failureTitle(failure: RunFailure): string {
  switch (failure.code) {
    case 'timeout':
      return '超时';
    case 'idle_timeout':
      return '空转超时';
    case 'interrupted':
      return '已中断';
    case 'exit':
      return '执行失败';
    case 'spawn':
      return '启动失败';
    case 'backend':
      return '后端不可用';
    case 'wait':
      return '等待失败';
    default:
      return '失败';
  }
}

function formatFailureLine(label: string, failure: RunFailure): string {
  return `✗ ${label} ${failureTitle(failure)}: ${failure.message}`;
}

function runFailureMeta(
  node: IRNode,
  adapter: string,
  failure: RunFailure,
): Record<string, unknown> {
  return {
    code: failure.code,
    message: failure.message,
    raw: failure.raw,
    adapter,
    nodeId: node.id,
    nodeLabel: node.label ?? node.type,
    nodeType: node.type,
    occurredAt: Date.now(),
    ...(failure.cli ? { cli: failure.cli } : {}),
    ...(failure.exitCode == null ? {} : { exitCode: failure.exitCode }),
    ...(failure.timeoutSeconds == null
      ? {}
      : { timeoutSeconds: failure.timeoutSeconds }),
    ...(failure.idleTimeoutSeconds == null
      ? {}
      : { idleTimeoutSeconds: failure.idleTimeoutSeconds }),
  };
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
      gateway: nodeGatewayOverride(o),
    };
  });
}

function runSpecGatewayOverride(spec: RunSpec): NodeGatewayOverride | undefined {
  const gateway = spec.gateway ? { ...spec.gateway } : undefined;
  if (gateway?.modelClass) return gateway;
  if (!spec.model) return gateway;
  return {
    ...(gateway ?? {}),
    modelClass: modelClassFromModelId(spec.model),
  };
}

function runGlobalGatewaySelection(
  ch: RunChannel,
  workflow: IRGraph,
): GatewaySelection {
  return (
    ch.config.gatewaySelection ??
    workflowDefaultGatewaySelection(workflow, ch.config.model)
  );
}

function runNodeGatewaySelection(
  ch: RunChannel,
  workflow: IRGraph,
  node: IRNode,
): GatewaySelection {
  return applyGatewayOverride(
    runGlobalGatewaySelection(ch, workflow),
    nodeGatewayOverride(node.params) ?? undefined,
  );
}

/**
 * Push a fresh assistant message and return handles to grow it live (append) or
 * replace it (finalize). Used so each node/branch shows its CLI output streaming
 * in rather than appearing all at once when the step finishes.
 */
function createStreamMessage(
  ch: RunChannel,
  header: string,
): {
  append: (chunk: string) => void;
  finalize: (text: string) => void;
  fail: (text: string) => void;
} {
  const id = shortId('m');
  const startedAt = Date.now();
  let currentText = header;
  const decorate = (text: string, endedAt?: number, failed = false) => {
    const prefix = endedAt
      ? `⏱ ${formatClock(startedAt)} → ${formatClock(endedAt)} · 耗时 ${formatDuration(endedAt - startedAt)}${failed ? ' · 失败' : ''}`
      : `⏱ 开始 ${formatClock(startedAt)}`;
    return `${prefix}\n${text}`;
  };
  const replace = (text: string, persist = false, endedAt?: number, failed = false) => {
    if (!stillRunning(ch) && !persist) return;
    currentText = text;
    const decorated = decorate(text, endedAt, failed);
    const map = (m: Message): Message =>
      m.id === id ? { ...m, text: decorated } : m;
    ch.messages = ch.messages.map(map);
    channelCommitMessages(ch, persist);
  };

  pushChannelMessage(
    ch,
    { id, role: 'assistant', text: decorate(header), createdAt: startedAt },
    false,
  );
  return {
    append: (chunk) => replace(currentText + chunk),
    finalize: (text) => replace(text, true, Date.now(), false),
    fail: (text) =>
      replace(
        currentText.trim()
          ? `${currentText.trimEnd()}\n\n${text}`
          : text,
        true,
        Date.now(),
        true,
      ),
  };
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

/**
 * Is the run still active? (false once the user hits 停止 or the run ends.)
 * Keyed on the run channel — NOT the global `mode` — so the loop keeps executing
 * while the user views a different session (the run is backgrounded, not killed).
 */
function stillRunning(ch: RunChannel): boolean {
  return runActive(ch);
}

/**
 * Run one CLI step that may ask the user to choose/type before producing its
 * final result. Streams each attempt into its own dock message. If the model
 * emits an interaction block (see core/interaction.ts) it renders a widget,
 * waits for the answer, appends it to the prompt, and re-invokes — bounded by
 * MAX_INTERACTION_ROUNDS. Returns the final (interaction-stripped) output;
 * throws on CLI failure (after streaming the failure line) so callers can mark
 * the node errored.
 */
async function runCliWithInteraction(opts: {
  ch: RunChannel;
  /** Streaming header, e.g. `【label】\n`. */
  head: string;
  /** Bracket label for the streamed finalize/failure line (no ✓ prefix). */
  label: string;
  /** Prompt base — already includes upstream data context / stage feed. */
  basePrompt: string;
  selection: GatewaySelection;
  cli: {
    model?: string;
    omitModel?: boolean;
    cliCommand?: string;
    cwd?: string;
    permission?: string;
    timeoutSeconds?: number;
    idleTimeoutSeconds?: number;
  };
  /**
   * Optional Claude session continuity. `id` is the shared session; `resume`
   * marks whether the *first* attempt continues an existing session (a later
   * pipeline stage) or creates it (the first stage). Interaction re-invokes
   * always resume, so a clarifying round keeps the same warm context instead of
   * recreating the id (which would error).
   */
  session?: { id: string; resume: boolean };
}): Promise<string> {
  const { ch } = opts;
  let appendix = '';
  let lastClean = '';
  for (let round = 0; round < MAX_INTERACTION_ROUNDS; round += 1) {
    if (!stillRunning(ch)) return lastClean;
    const sm = createStreamMessage(
      ch,
      round === 0 ? opts.head : `${opts.head}（已根据你的回答继续）\n`,
    );
    const prompt = `${withNodeExecutionContract(opts.basePrompt)}\n\n${INTERACTION_PROTOCOL}${appendix}`;
    const timeoutPolicy = timeoutPolicyForSelection(opts.selection, prompt);

    let raw: string;
    try {
      raw = (
        await invokeGatewayAgent(ch, prompt, opts.selection, {
          model: opts.cli.model,
          omitModel: opts.cli.omitModel,
          cliCommand: opts.cli.cliCommand,
          cwd: opts.cli.cwd,
          permission: opts.cli.permission,
          timeoutSeconds: opts.cli.timeoutSeconds ?? timeoutPolicy.timeoutSeconds,
          idleTimeoutSeconds:
            opts.cli.idleTimeoutSeconds ?? timeoutPolicy.idleTimeoutSeconds,
          onProgress: sm.append,
          sessionId: opts.session?.id,
          // First attempt uses the caller's resume intent; any re-ask continues
          // the now-existing session.
          resume: opts.session ? opts.session.resume || round > 0 : undefined,
        })
      ).text.trim();
    } catch (err) {
      const failure = describeRunFailure(err);
      if (stillRunning(ch)) sm.fail(formatFailureLine(opts.label, failure));
      throw err;
    }

    const clean = stripInteraction(raw);
    lastClean = clean;

    // Stopped during the call, or the node produced a plain result → done.
    const req = stillRunning(ch) ? parseInteraction(raw) : null;
    if (!req) {
      if (!stillRunning(ch)) return clean;
      sm.finalize(`【✓ ${opts.label}】\n${clean || '(无输出)'}`);
      return clean;
    }

    // The node is asking. Finalize this attempt (showing any prose it emitted),
    // render the widget, and block until the user answers.
    sm.finalize(
      clean
        ? `【${opts.label}】\n${clean}`
        : `【${opts.label}】\n（已向你提出一个问题，请在下方作答）`,
    );
    const answer = await awaitInteraction(ch, req);
    if (!answer || !stillRunning(ch)) return clean; // dismissed or run stopped
    appendix += `\n\n${formatAnswerForPrompt(req, answer)}`;
  }

  pushRunLog(
    ch,
    `⚠ ${opts.label}：交互轮数已达上限（${MAX_INTERACTION_ROUNDS}），停止追问。`,
    'system',
  );
  return lastClean;
}

/**
 * Run a `parallel` node: each branch is its own concurrent `claude -p` call
 * (real fan-out, not one lumped prompt). All branches share the node's upstream
 * data context. Per-branch output streams in as it lands; the combined output is
 * threaded to downstream nodes. Throws only if every branch fails.
 */
async function runParallel(
  ch: RunChannel,
  node: IRNode,
  workflow: IRGraph,
  results: Map<string, string>,
): Promise<string> {
  const branches = specList(node.params.branches);
  if (branches.length === 0) return '';
  const upstream = dataContextString(node, workflow, results);
  const baseSelection = runNodeGatewaySelection(ch, workflow, node);

  const settled = await runWithConcurrency(
    branches,
    Math.min(
      branches.length,
      effectiveRunConcurrency(runConcurrency(), baseSelection),
    ),
    async (b, i) => {
      const label = b.label || b.agentType || b.prompt.slice(0, 16) || `分支${i + 1}`;
      const stepLabel = `并行分支 ${i + 1}/${branches.length} · ${label}`;
      const branchSelection = applyGatewayOverride(
        baseSelection,
        runSpecGatewayOverride(b),
      );
      try {
        const out = (
          await runCliWithInteraction({
            ch,
            head: `【${stepLabel}】\n`,
            label: stepLabel,
            basePrompt: b.prompt + upstream,
            selection: branchSelection,
            cli: {
              cwd: ch.config.cwd,
              permission: ch.config.permission,
            },
          })
        ).trim();
        return { ok: true as const, label, out };
      } catch (err) {
        const failure = describeRunFailure(err);
        return { ok: false as const, label, out: '', failure };
      }
    },
  );

  if (settled.every((s) => !s.ok)) {
    const detail = settled
      .map((s) => (s.ok ? '' : `${s.label}: ${s.failure.message}`))
      .filter(Boolean)
      .join('；');
    throw new Error(detail ? `所有并行分支均失败：${detail}` : '所有并行分支均失败');
  }
  return settled
    .map((s) =>
      s.ok ? `【${s.label}】\n${s.out}` : `【${s.label}】\n(失败：${s.failure.message})`,
    )
    .join('\n\n');
}

/**
 * Run a `pipeline` node: stages execute sequentially, each receiving the previous
 * stage's output (the first stage also gets the node's upstream context + items
 * expression). Returns the final stage's output.
 */
async function runPipeline(
  ch: RunChannel,
  node: IRNode,
  workflow: IRGraph,
  results: Map<string, string>,
): Promise<string> {
  const stages = specList(node.params.stages);
  if (stages.length === 0) return '';
  const items = String(node.params.items ?? '').trim();
  let prev = '';
  const baseSelection = runNodeGatewaySelection(ch, workflow, node);

  // A pipeline is one agent working through sequential stages, so share a single
  // Claude session across the stages (claude adapter only): each stage continues
  // the previous stage's warm context instead of cold-starting and re-exploring
  // the project — the dominant per-node cost. Other adapters ignore the flags.
  const isClaude =
    baseSelection.adapter === 'claude-code' || baseSelection.adapter === 'claude';
  const sessionId = isClaude ? newSessionId() : undefined;

  for (let i = 0; i < stages.length; i += 1) {
    if (!stillRunning(ch)) break;
    const s = stages[i];
    const label = s.label || s.prompt.slice(0, 16) || `阶段${i + 1}`;
    const stepLabel = `流水线阶段 ${i + 1}/${stages.length} · ${label}`;
    const feed =
      i === 0
        ? dataContextString(node, workflow, results) +
          (items ? `\n\n输入数据: ${items}` : '')
        : `\n\n---\n上一步输出：\n${prev}`;
    const stageSelection = applyGatewayOverride(
      baseSelection,
      runSpecGatewayOverride(s),
    );
    prev = (
      await runCliWithInteraction({
        ch,
        head: `【${stepLabel}】\n`,
        label: stepLabel,
        basePrompt: s.prompt + feed,
        selection: stageSelection,
        cli: {
          // On a resumed stage the session already carries its model; passing a
          // different --model alongside --resume can conflict, so only set it
          // through the gateway route when creating the session.
          omitModel: !!(sessionId && i > 0),
          cwd: ch.config.cwd,
          permission: ch.config.permission,
        },
        session: sessionId ? { id: sessionId, resume: i > 0 } : undefined,
      })
    ).trim();
  }
  return prev;
}

/** Default fan-out samples for a consensus node (localStorage owf_consensus_default_samples). */
function defaultConsensusSamples(): number {
  try {
    if (typeof window !== 'undefined') {
      const raw = window.localStorage.getItem('owf_consensus_default_samples');
      if (raw) {
        const n = Number.parseInt(raw, 10);
        if (Number.isFinite(n)) return Math.min(7, Math.max(2, n));
      }
    }
  } catch {
    /* ignore */
  }
  return 3;
}

/** Clamp a samples value to the supported 2..7 range. */
function clampSamples(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : defaultConsensusSamples();
  return Math.min(7, Math.max(2, n || 3));
}

/** Coerce an arbitrary value into a known ConsensusStrategy (default multi-lens). */
function consensusStrategy(value: unknown): ConsensusStrategy {
  return value === 'adversarial' ||
    value === 'tournament' ||
    value === 'self-consistency'
    ? value
    : 'multi-lens';
}

/** Run `fn` over `items` with bounded concurrency, preserving result order. */
async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  };
  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

type ConsensusSample =
  | { ok: true; label: string; out: string }
  | { ok: false; label: string; out: ''; failure?: RunFailure };

/**
 * Run a `consensus` node: fan out N voters over the SAME target (multi-angle
 * exploration), then cross-validate + vote per strategy and return the single
 * winning answer downstream (Claude-Code-style "win by adversarial verification").
 * Sample concurrency is capped at min(N, runConcurrency()) so an N-way vote can't
 * spawn unbounded `claude -p` processes. Mirrors runParallel's failure policy:
 * throws only when too few samples succeed to vote, so node-level auto-retry and
 * resume-from-failed-node keep working.
 */
async function runConsensus(
  ch: RunChannel,
  node: IRNode,
  workflow: IRGraph,
  results: Map<string, string>,
): Promise<string> {
  const voters = specList(node.params.voters);
  if (voters.length === 0) return '';
  const strategy = consensusStrategy(node.params.strategy);
  const upstream = dataContextString(node, workflow, results);
  const baseSelection = runNodeGatewaySelection(ch, workflow, node);

  // self-consistency replicates the first voter; other strategies use distinct lenses.
  const samples =
    strategy === 'self-consistency'
      ? Array.from(
          { length: effectiveConsensusSamples(clampSamples(node.params.samples), baseSelection) },
          () => voters[0],
        )
      : voters;
  const total = samples.length;
  const quorum =
    typeof node.params.quorum === 'number' && node.params.quorum > 0
      ? node.params.quorum
      : Math.ceil(total / 2);

  const settled = await runWithConcurrency<RunSpec, ConsensusSample>(
    samples,
    Math.min(total, effectiveRunConcurrency(runConcurrency(), baseSelection)),
    async (s, i) => {
      if (!stillRunning(ch)) return { ok: false, label: `样本${i + 1}`, out: '' };
      const label = s.label || s.agentType || s.prompt.slice(0, 16) || `样本${i + 1}`;
      const stepLabel = `共识样本 ${i + 1}/${total} · ${label}`;
      const sampleSelection = applyGatewayOverride(baseSelection, runSpecGatewayOverride(s));
      try {
        const out = (
          await runCliWithInteraction({
            ch,
            head: `【${stepLabel}】\n`,
            label: stepLabel,
            basePrompt: s.prompt + upstream,
            selection: sampleSelection,
            cli: { cwd: ch.config.cwd, permission: ch.config.permission },
          })
        ).trim();
        return { ok: true, label, out };
      } catch (err) {
        return { ok: false, label, out: '', failure: describeRunFailure(err) };
      }
    },
  );

  const oks = settled.filter((s): s is { ok: true; label: string; out: string } => s.ok && !!s.out);
  if (oks.length < 2) {
    if (oks.length === 1) return oks[0].out; // single survivor — return rather than dead-end
    const detail = settled
      .map((s) => (s.ok ? '' : `${s.label}: ${s.failure?.message ?? '无输出'}`))
      .filter(Boolean)
      .join('；');
    throw new Error(detail ? `共识失败：可用样本不足以投票（${detail}）` : '共识失败：可用样本不足以投票');
  }
  if (!stillRunning(ch)) return oks[0].out;

  return resolveConsensus(
    ch,
    node,
    oks.map((s) => s.out),
    strategy,
    quorum,
    baseSelection,
  );
}

/** Cross-validate the candidate outputs and return the consensus answer. */
async function resolveConsensus(
  ch: RunChannel,
  node: IRNode,
  candidates: string[],
  strategy: ConsensusStrategy,
  quorum: number,
  baseSelection: GatewaySelection,
): Promise<string> {
  // self-consistency: deterministic majority over normalized text (no model call).
  if (strategy === 'self-consistency') {
    const buckets = new Map<string, { rep: string; n: number }>();
    for (const c of candidates) {
      const key = c.trim().toLowerCase().replace(/\s+/g, ' ');
      const b = buckets.get(key);
      if (b) b.n += 1;
      else buckets.set(key, { rep: c, n: 1 });
    }
    let best = { rep: candidates[0], n: 0 };
    for (const b of buckets.values()) if (b.n > best.n) best = b;
    pushRunLog(ch, `共识(自一致投票)：最高一致 ${best.n}/${candidates.length}`, 'system');
    if (best.n >= quorum) return best.rep;
    // No quorum → fall through to an arbiter so the node never dead-ends.
  }

  const instruction =
    strategy === 'adversarial'
      ? '下面是多个独立得出的结论。请逐条尝试证伪，丢弃站不住脚的，只综合那些扛住反驳的结论，给出最终答案。'
      : strategy === 'tournament'
        ? '下面是多个独立方案。请按质量择优选出最佳方案，并把其它方案中值得借鉴的亮点合并进去，输出最终方案。'
        : '下面是多个独立角度对同一目标的判定。请按多数意见综合，给出最可信的最终结论，并简述理由。';
  const block = candidates.map((c, i) => `【候选 ${i + 1}】\n${c}`).join('\n\n');
  const label = `${node.label ?? '共识'} · 评审/投票`;
  return (
    await runCliWithInteraction({
      ch,
      head: `【${label}】\n`,
      label,
      basePrompt: `${instruction}\n\n${block}`,
      selection: baseSelection,
      cli: { cwd: ch.config.cwd, permission: ch.config.permission },
    })
  ).trim();
}

/**
 * Execute one node, returning its result string (stored for downstream data
 * edges), or null when there is nothing to run (control / log / variable /
 * codeblock). Streams sub-results for parallel/pipeline. Throws on hard error.
 */
async function runNode(
  ch: RunChannel,
  node: IRNode,
  workflow: IRGraph,
  results: Map<string, string>,
): Promise<string | null> {
  const label = node.label ?? node.type;
  const nodeSelection = runNodeGatewaySelection(ch, workflow, node);
  switch (node.type) {
    case 'agent': {
      const base = String(node.params.prompt ?? node.label ?? '').trim();
      if (!base) return '';
      return runCliWithInteraction({
        ch,
        head: `【${label}】\n`,
        label,
        basePrompt: base + dataContextString(node, workflow, results),
        selection: nodeSelection,
        cli: {
          cwd: ch.config.cwd,
          permission: ch.config.permission,
        },
      });
    }
    case 'workflow': {
      const base = `运行子工作流 "${String(node.params.name ?? node.label ?? 'sub')}" 并返回结果。`;
      return runCliWithInteraction({
        ch,
        head: `【${label}】\n`,
        label,
        basePrompt: base + dataContextString(node, workflow, results),
        selection: nodeSelection,
        cli: {
          cwd: ch.config.cwd,
          permission: ch.config.permission,
        },
      });
    }
    case 'parallel':
      return runParallel(ch, node, workflow, results);
    case 'pipeline':
      return runPipeline(ch, node, workflow, results);
    case 'consensus':
      return runConsensus(ch, node, workflow, results);
    case 'log': {
      const msg = String(node.params.message ?? node.params.msg ?? '').trim();
      if (msg) pushRunLog(ch, msg);
      return null;
    }
    default:
      return null; // start/end/branch/loop/variable/codeblock
  }
}

/** Default number of workflow nodes executed concurrently (see runConcurrency). */
const DEFAULT_RUN_CONCURRENCY = 10;

/**
 * How many runnable nodes may execute at once. Each node is a heavy `claude -p`
 * process, so this absolute cap is combined with the model-speed tier caps from
 * Settings > Consensus. Tune it per machine via localStorage
 * (`owf_run_concurrency`, clamped 1–16) or force the old strictly-sequential
 * behaviour with `owf_sequential=1`. Linear chains stay sequential regardless
 * (a node still waits for its predecessors); the cap only bounds how many
 * *independent* nodes run together.
 */
function runConcurrency(): number {
  try {
    if (typeof window !== 'undefined') {
      if (window.localStorage.getItem('owf_sequential') === '1') return 1;
      const raw = window.localStorage.getItem('owf_run_concurrency');
      if (raw) {
        const n = Number.parseInt(raw, 10);
        if (Number.isFinite(n)) return Math.min(16, Math.max(1, n));
      }
    }
  } catch {
    /* ignore — fall through to default */
  }
  return DEFAULT_RUN_CONCURRENCY;
}

/** Default number of automatic re-runs for a transient node failure. */
const DEFAULT_RUN_MAX_RETRIES = 2;

/**
 * Failure codes worth re-attempting automatically. These are transient or
 * non-deterministic: a CLI timeout / idle-timeout (the common case — the model
 * was simply slow and a fresh attempt usually clears it), a non-zero exit, a
 * wait error, or an unclassified failure. User interruptions (`interrupted`),
 * a missing desktop backend (`backend`), and unresolvable launch errors
 * (`spawn`, e.g. the binary isn't found) are NOT retried — re-running can't fix
 * them and would only waste time.
 */
const RETRYABLE_FAILURE_CODES: ReadonlySet<RunFailureCode> = new Set([
  'timeout',
  'idle_timeout',
  'exit',
  'wait',
  'unknown',
]);

/**
 * How many times a failed node is automatically re-run before it is recorded as
 * failed. Only transient failures (see RETRYABLE_FAILURE_CODES) are retried.
 * Tune via localStorage (`owf_run_max_retries`, clamped 0–10); set 0 to disable
 * auto-retry entirely.
 */
function runMaxRetries(): number {
  try {
    if (typeof window !== 'undefined') {
      const raw = window.localStorage.getItem('owf_run_max_retries');
      if (raw !== null) {
        const n = Number.parseInt(raw, 10);
        if (Number.isFinite(n)) return Math.min(10, Math.max(0, n));
      }
    }
  } catch {
    /* ignore — fall through to default */
  }
  return DEFAULT_RUN_MAX_RETRIES;
}

function isRetryableFailure(failure: RunFailure): boolean {
  return RETRYABLE_FAILURE_CODES.has(failure.code);
}

/**
 * Build the runtime dependency map: a node depends on every other *runnable*
 * node that feeds it via an exec OR data edge. This is the true graph topology,
 * so connected nodes never reorder (a step always waits for what flows into it),
 * while independent nodes — multiple roots, exec forks, sibling branches — have
 * disjoint dependency sets and are free to run concurrently.
 */
function buildRunDependencies(
  order: IRNode[],
  workflow: IRGraph,
): Map<string, Set<string>> {
  const idSet = new Set(order.map((n) => n.id));
  const deps = new Map<string, Set<string>>();
  for (const n of order) deps.set(n.id, new Set());
  for (const e of workflow.edges) {
    if (!idSet.has(e.from.node) || !idSet.has(e.to.node)) continue;
    if (e.from.node === e.to.node) continue;
    deps.get(e.to.node)!.add(e.from.node);
  }
  return deps;
}

/**
 * Real run: interpret the IR as a dependency DAG, executing nodes through the
 * local agent CLI. A node runs as soon as every node feeding it (exec/data edge)
 * has completed, so independent nodes run concurrently (bounded by
 * runConcurrency) instead of being flattened to a single serial line — a big win
 * over re-paying each node's cold start one-after-another. Agent/workflow nodes
 * are single `claude -p` calls; `parallel` fans each branch out concurrently;
 * `pipeline` chains stages sequentially. Outputs stream into the dock, thread to
 * downstream nodes via data edges, and drive per-node run badges. Aborts on 停止;
 * returns to design mode when finished.
 */
async function executeViaCliInterpreter(
  ch: RunChannel,
  workflow: IRGraph,
  adapter: string,
  runStartedAt: number,
  options: {
    resumeFromNodeId?: string | null;
    seedOutputs?: Record<string, string>;
  } = {},
): Promise<void> {
  const launchSelection =
    ch.config.gatewaySelection ??
    workflowDefaultGatewaySelection(workflow, ch.config.model);
  if (!resolveDirectGatewayRoute(launchSelection)) {
    try {
      const cli = await resolveCliGatewayRoute(launchSelection);
      if (!stillRunning(ch)) return;
      ch.config.cliCommand = cli.cliCommand;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ch.error = {
        code: 'cli_config',
        message,
        adapter,
        occurredAt: Date.now(),
      };
      pushRunLog(ch, `✗ CLI 配置不可用: ${message}`, 'assistant');
      channelCommit(ch, 'error', true);
      if (runViewActive(ch)) useStore.getState().setMode('design');
      finishRun(ch);
      return;
    }
  }
  if (!stillRunning(ch)) return;

  const order = runnableOrder(workflow);
  const resumeFromNodeId =
    options.resumeFromNodeId && order.some((node) => node.id === options.resumeFromNodeId)
      ? options.resumeFromNodeId
      : null;
  const results = new Map<string, string>(Object.entries(options.seedOutputs ?? {}));
  const deps = buildRunDependencies(order, workflow);

  // Seed completed nodes so they are never re-run: prior outputs / successes,
  // and — when resuming from a node — everything topologically before it (those
  // steps already ran; resume re-executes only the failed node onward).
  const liveRunState = ch.runState;
  const resumeIdx = resumeFromNodeId
    ? order.findIndex((n) => n.id === resumeFromNodeId)
    : -1;
  const done = new Set<string>();
  order.forEach((node, i) => {
    if (results.has(node.id) || liveRunState[node.id] === 'success') {
      done.add(node.id);
    } else if (resumeIdx >= 0 && i < resumeIdx) {
      done.add(node.id);
    }
  });
  if (resumeFromNodeId) done.delete(resumeFromNodeId); // force the target to re-run

  let errored = false;
  let runError: Record<string, unknown> | null = null;

  // Execute one node: trivial sentinels resolve immediately; real nodes stream
  // their own labelled message(s) and store the result for downstream data
  // edges. Returns true on success (node may be marked done).
  const processNode = async (node: IRNode): Promise<boolean> => {
    if (node.type === 'start' || node.type === 'end') {
      markRunNode(ch, node.id, 'success');
      return true;
    }

    const nodeStartedAt = Date.now();
    markRunNode(ch, node.id, 'running');
    pushRunLog(ch, `▸ ${node.label ?? node.type} · 开始 ${formatClock(nodeStartedAt)}`);

    const maxRetries = runMaxRetries();
    let attempt = 0; // how many retries have been consumed so far

    // Attempt loop: transient failures (timeouts, idle-timeouts, non-deterministic
    // CLI exits) are re-run up to maxRetries times before the node is recorded as
    // failed. A genuine success or a non-retryable failure exits immediately.
    for (;;) {
      try {
        const out = await runNode(ch, node, workflow, results);
        if (!stillRunning(ch)) return false; // stopped during the call(s)
        if (out !== null) {
          results.set(node.id, out);
          ch.runOutputs = { ...ch.runOutputs, [node.id]: out };
          if (!errored) ch.failedNodeId = null;
        }
        markRunNode(ch, node.id, 'success');
        const nodeFinishedAt = Date.now();
        pushRunLog(
          ch,
          `✓ ${node.label ?? node.type} · 完成 ${formatClock(nodeFinishedAt)} · 耗时 ${formatDuration(
            nodeFinishedAt - nodeStartedAt,
          )}${attempt > 0 ? ` · 重试 ${attempt} 次后成功` : ''}`,
          'assistant',
        );
        return true;
      } catch (err) {
        const failure = describeRunFailure(err);
        if (!stillRunning(ch)) return false;

        // Auto-retry transient failures (e.g. a CLI timeout) before recording the
        // node as failed. Back off a little between attempts; bail if the run was
        // stopped while waiting.
        if (attempt < maxRetries && isRetryableFailure(failure)) {
          attempt += 1;
          const backoffMs = Math.min(15000, 1500 * attempt);
          pushRunLog(
            ch,
            `⟳ ${node.label ?? node.type} · ${failureTitle(
              failure,
            )}，正在自动重试（第 ${attempt}/${maxRetries} 次，${Math.round(
              backoffMs / 1000,
            )}s 后重试）：${failure.message}`,
            'assistant',
          );
          markRunNode(ch, node.id, 'running');
          await delay(backoffMs);
          if (!stillRunning(ch)) return false;
          continue;
        }

        const nodeFinishedAt = Date.now();
        const retriedNote = attempt > 0 ? `（已自动重试 ${attempt} 次仍失败）` : '';
        pushRunLog(
          ch,
          `✗ ${node.label ?? node.type} · 失败 ${formatClock(nodeFinishedAt)} · 耗时 ${formatDuration(
            nodeFinishedAt - nodeStartedAt,
          )}${retriedNote}: ${failure.message}`,
          'assistant',
        );
        const state = failure.code === 'interrupted' ? 'interrupted' : 'error';
        // Only the first failure becomes the run's recorded error / resume point;
        // any still-in-flight siblings that also fail don't clobber it.
        if (!errored) {
          errored = true;
          runError = runFailureMeta(node, adapter, failure);
          ch.runState = { ...ch.runState, [node.id]: state };
          ch.failedNodeId = node.id;
          ch.error = runError;
          channelCommit(ch, state, true);
        } else {
          markRunNode(ch, node.id, state);
        }
        return false;
      }
    }
  };

  const concurrency = effectiveRunConcurrency(
    runConcurrency(),
    runGlobalGatewaySelection(ch, workflow),
  );
  const claimed = new Set<string>(done); // nodes already picked or completed

  // Bounded-concurrency pump over the dependency DAG.
  await new Promise<void>((resolve) => {
    let active = 0;
    let finished = false;
    const finish = () => {
      if (!finished) {
        finished = true;
        resolve();
      }
    };

    // The next node whose dependencies are all satisfied, or — to stay robust
    // against cycles / unsatisfiable deps when nothing is in flight — the
    // earliest unclaimed node (mirrors topoOrderExec's cycle tolerance).
    const pickReady = (): IRNode | null => {
      for (const node of order) {
        if (claimed.has(node.id)) continue;
        let ready = true;
        for (const dep of deps.get(node.id)!) {
          if (!done.has(dep)) {
            ready = false;
            break;
          }
        }
        if (ready) return node;
      }
      if (active === 0) {
        for (const node of order) if (!claimed.has(node.id)) return node;
      }
      return null;
    };

    const pump = (): void => {
      if (finished) return;
      if (!stillRunning(ch)) {
        if (active === 0) finish();
        return;
      }
      while (active < concurrency && !errored && stillRunning(ch)) {
        const next = pickReady();
        if (!next) break;
        claimed.add(next.id);
        active += 1;
        void processNode(next).then((ok) => {
          active -= 1;
          if (ok) done.add(next.id);
          pump();
        });
      }
      if (active === 0 && (errored || !stillRunning(ch) || !pickReady())) {
        finish();
      }
    };

    pump();
  });

  if (runActive(ch)) {
    const runFinishedAt = Date.now();
    pushRunLog(
      ch,
      errored
        ? `✗ 运行中断 · 完成 ${formatClock(runFinishedAt)} · 总耗时 ${formatDuration(
            runFinishedAt - runStartedAt,
          )}`
        : `✓ 运行完成 · 完成 ${formatClock(runFinishedAt)} · 总耗时 ${formatDuration(
            runFinishedAt - runStartedAt,
          )}`,
      'assistant',
    );
    if (errored) ch.error = runError;
    channelCommit(ch, errored ? 'error' : 'success', true);
    // Only the live view should drop back to design mode; a backgrounded run's
    // owning session reverts when the user next opens it (its persisted snapshot
    // is already terminal).
    if (runViewActive(ch)) useStore.getState().setMode('design');
    finishRun(ch);
  }
}

/**
 * Browser fallback: walk the exec topological order and animate each runnable
 * node idle → running → success with a short delay, streaming a log line per
 * step. Aborted gracefully when the user clicks "停止" (mode flips to design).
 */
async function executeViaSimulator(
  ch: RunChannel,
  workflow: IRGraph,
  options: {
    resumeFromNodeId?: string | null;
    seedOutputs?: Record<string, string>;
  } = {},
): Promise<void> {
  const order = runnableOrder(workflow);
  const stepDelay = 350;
  const resumeFromNodeId =
    options.resumeFromNodeId && order.some((node) => node.id === options.resumeFromNodeId)
      ? options.resumeFromNodeId
      : null;
  let resumePending = !!resumeFromNodeId;

  for (const node of order) {
    if (!stillRunning(ch)) return; // user stopped
    if (resumePending && node.id !== resumeFromNodeId) {
      if (
        node.type === 'start' ||
        node.type === 'end' ||
        options.seedOutputs?.[node.id] != null ||
        ch.runState[node.id] === 'success'
      ) {
        markRunNode(ch, node.id, 'success');
      }
      continue;
    }
    if (resumePending && node.id === resumeFromNodeId) {
      resumePending = false;
    }
    markRunNode(ch, node.id, 'running');
    pushRunLog(ch, `▸ ${node.label ?? node.type} (${node.id})`);

    await delay(stepDelay);
    if (!stillRunning(ch)) return;

    ch.runOutputs = {
      ...ch.runOutputs,
      [node.id]: `模拟完成: ${node.label ?? node.type}`,
    };
    ch.failedNodeId = null;
    markRunNode(ch, node.id, 'success');
  }

  if (runActive(ch)) {
    pushRunLog(
      ch,
      `✓ 模拟运行完成 · ${order.length} 个节点（浏览器无命令行，未真正执行）`,
      'assistant',
    );
    channelCommit(ch, 'success', true);
    if (runViewActive(ch)) useStore.getState().setMode('design');
    finishRun(ch);
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
