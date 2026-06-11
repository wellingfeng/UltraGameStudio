import { create } from 'zustand';
import {
  DATA,
  type IREndpoint,
  type GatewaySelection,
  type ConsensusStrategy,
  type IRGraph,
  type IRNode,
  type IRRunSnapshot,
  type IRRunStatus,
  type NodeGatewayOverride,
  type NodeType,
  type PinKind,
} from '@/core/ir';
// [dynamic-only refactor] 静态蓝图编辑相关模块已停用（autoLayout/genPrompt/intentEngine/
// isEmptyWorkflow/determinism）。源码保留并已从编译图 exclude。simpleBlueprint 是
// 聊天会话的底层结构，保留；defaultBlueprint/captainBlueprint 仅蓝图创建用，停用。
// import { autoLayoutGraph } from '@/core/autoLayout';
import { simpleBlueprint } from '@/core/defaultBlueprint';
// import { defaultBlueprint, captainBlueprint } from '@/core/defaultBlueprint';
// import { isEmptyWorkflow } from '@/core/isEmptyWorkflow';
import { normalizeWorkflowNodeNumbers } from '@/core/nodeNumbers';
// import {
//   BLUEPRINT_DIRECT_EDIT_CONTRACT,
//   prepareGraphEdit,
//   replyIncludesIRGraph,
//   strictBlueprintRetryAppendix,
// } from '@/core/genPrompt';
// import { applyIntent } from '@/core/intentEngine';
import { extractToolSentinels } from '@/components/ai/lib/toolEvent';
import {
  personalInstructionsBlock,
  personalInstructionsForSelection,
  withPersonalInstructionsForSelection,
  type PersonalInstructionsByModel,
} from '@/core/personalInstructions';
import {
  assessConsensusFit,
  defaultConsensusLenses,
  generationAngles,
  isComplexGenerationRequest,
  nodeComplexitySignal,
  measureDivergence,
  researchAngles,
  scaleCount,
  VOTE_DIVERGENCE_THRESHOLD,
} from '@/core/consensusHeuristic';
import {
  adaptiveEscalationEnabled,
  complexityScaling,
  genCandidateCount,
  nodeGenCandidateRange,
  researchAngleRange,
  runtimeVoteSampleRange,
  terminalVoteSampleRange,
} from '@/lib/consensusSettings';
import {
  effectiveConsensusSamples,
  effectiveGenerationConsensusPlan,
  effectiveRunConcurrency,
  recordModelCall,
  timeoutPolicyForSelection,
} from '@/lib/modelSpeed';
import {
  recordEstimatedModelUsageForSelection,
  recordModelUsageForRoute,
  mergeUsageReports,
  readUsageMeterSnapshot,
  usageReportFromCliUsage,
  usageTurnFromSnapshots,
  type ModelUsageReport,
} from '@/lib/usageMeter';
import {
  appendStartUserInputs,
  readStartUserInputs,
  setStartUserInputs,
  setGenerationProvenance,
  type GenProvenance,
} from '@/core/startInputs';
// [dynamic-only refactor] determinism lint 仅用于蓝图 AI 改图分支，已停用。
// import { findDeterminismHazards } from '@/core/determinism';
import { readApiKey, readBaseUrl } from '@/lib/apiConfig';
import { appendComposerDraftState } from '@/lib/composerEntryPolicy';
import {
  clearActiveGatewaySelection,
  getExplicitActiveGatewaySelection,
  setActiveGatewaySelection,
} from '@/lib/gatewayConfig';
import { getCliRuntimeSnapshot } from '@/lib/cliConfig';
import { maybeRunCcSwitchAutoImportOnFirstRun } from '@/lib/ccSwitchAutoImport';
import { ensureFreeProxy, isFreeChannelSelection } from '@/lib/freeChannels';
import { getManifestModeEnabled } from '@/lib/manifestMode';
import { projectSettingsFromMetadata } from '@/lib/projectSettings';
import {
  isNotifiableCompletionStatus,
  notifySessionComplete,
  setSessionNotificationClickHandler,
} from '@/lib/sessionNotification';
import {
  generateImage,
  imageProviderById,
  loadImageGenerationSettings,
  preferredReadyImageProviderId,
  stripImageCommand,
  type ImageProviderId,
} from '@/lib/imageGeneration';
import {
  generateMusic,
  loadMusicGenerationSettings,
  musicDurationSecondsFromPrompt,
  musicProviderById,
  musicProviderModel,
  preferredReadyMusicProviderId,
  stripMusicCommand,
  type MusicProviderId,
} from '@/lib/musicGeneration';
import {
  assessThreeDRigging,
  generateThreeD,
  loadThreeDGenerationSettings,
  preferredReadyThreeDProviderId,
  stripThreeDCommand,
  threeDRiggingPromptGuidance,
  threeDProviderById,
  threeDProviderModel,
  type ThreeDProviderId,
} from '@/lib/threeDGeneration';
import {
  loadMeshLibrarySettings,
  meshLibraryById,
  searchMeshLibraries,
  stripMeshSearchCommand,
  type MeshSearchResult,
} from '@/lib/meshLibrary';
import {
  buildGameExpertPrompt,
  normalizeGameExpertSettings,
  type GameExpertSettings,
} from '@/lib/gameExperts';
import {
  buildProducerPrompt,
  shouldUseProducer,
} from '@/lib/gameProducer';
import {
  modelClassFromModelId,
  nodeParamsWithGatewayOverride,
  listGatewayRunOptions,
  normalizeGatewaySelection,
  normalizeGatewayWorkflow as migrateWorkflowGateway,
  selectionKey,
  systemDefaultGatewaySelection,
  workflowDefaultGatewaySelection,
} from '@/lib/modelGateway/resolver';
import { shortId } from '@/lib/id';
import { translatePromptFields } from '@/lib/promptTranslation';
import {
  aiEditViaCli,
  cancelAiCli,
  downloadModelAsset,
  ensureDefaultWorkspaceDir,
  isTauri,
  runUltracode,
} from '@/lib/tauri';
import {
  parseUltracodePrompt,
  summarizeUltracodeResult,
  ultracodeAccepted,
  ultracodeModeLabel,
} from './ultracodePrompt';
import {
  applyGatewayOverride,
  completeGatewayText,
  nodeGatewayOverride,
  resolveCliGatewayRoute,
  resolveDirectGatewayRoute,
} from '@/lib/modelGateway/modelGateway';
import type { ResolvedGatewayRoute } from '@/lib/modelGateway/types';
import {
  UNIFIED_SYSTEM,
  SIMPLE_CHAT_SYSTEM,
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
  executeWorkflowDag,
  formatClock,
  formatDuration,
  getRunnableNodes as runnableOrder,
  parseRunFailure as describeRunFailure,
  runFailureMeta,
  runWithConcurrency,
  newSessionId,
  decodeProgressEvents,
  emptyProgress,
  reduceProgress,
  type RunCallbacks,
  type RunContext as RuntimeRunContext,
  type RunFailure,
  type RunGateway,
  type UltracodeRunProgress,
} from '@/runtime';
import {
  DEFAULT_LOCALE,
  languageAdaptationPrompt,
  localizePromptGroup,
  localizePromptItem,
  SUPPORTED_LOCALES,
  t,
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
  loadGameExpertSettings,
  loadLocale,
  loadPersonalInstructionsByModel,
  loadPromptAutoTranslate,
  loadPromptGroups,
  loadPromptGroupsVersion,
  saveComposer,
  saveGameExpertSettings,
  saveLocale,
  savePersonalInstructionsByModel,
  savePromptAutoTranslate,
  savePromptGroups,
  savePromptGroupsVersion,
} from '@/lib/composerStorage';
import type { PersistedComposer } from '@/lib/composerStorage';
import {
  normalizeWorkspacePath,
  uniqueWorkspaceHistory,
  workspaceHistoryWithRecent,
  workspacePathKey,
} from '@/lib/workspaceHistory';
import {
  applyAppearance,
  isBuiltinStylePresetId,
  normalizeAppearanceSettings,
  streamSchemeForStylePresetId,
  type AppearanceSettings,
  type FontFamilyId,
  type StreamSchemeId,
  type StylePresetId,
} from '@/lib/appearance';
import { loadAppearance, saveAppearance } from '@/lib/appearanceStorage';
import {
  autosave,
  exportWorkflowToFile,
  importWorkflowFromFile,
} from '@/lib/persist';
import {
  ensureCachedSessionChangesBaseline,
  refreshCachedSessionChanges,
  sessionChangesCacheKey,
} from '@/lib/sessionChanges';
import {
  historyStore,
  isAutoTitlePlaceholder,
  titleFromText,
} from './history/store';
import {
  HISTORY_SCHEMA_VERSION,
  type SessionMeta,
  type SessionPatch,
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
  SessionComposerSettings,
  SessionRunStatus,
  ScheduledTaskConfig,
  ScheduledTaskWeekday,
} from './types';
import {
  selectRunProgress,
  type RunProgressSummary,
} from './runProgress';

export { selectRunProgress } from './runProgress';
export type { RunProgressSummary } from './runProgress';

/**
 * The id of the composite node whose subgraph is currently being viewed, or
 * undefined when at the top level. New nodes added via {@link StoreState.addNode}
 * are parented to this scope.
 */
export function selectActiveScopeId(
  state: Pick<StoreState, 'graphPath'>,
): string | undefined {
  return state.graphPath[state.graphPath.length - 1]?.nodeId;
}

export type WorkflowSessionKey = {
  workspaceId: string | null;
  sessionId: string | null;
};

export type BlockedSendTip = 'model-switched-while-chatting';

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
 *   newWorkflow(), newSimpleWorkflow(), newSession(), sendPrompt(text), setComposer(patch),
 *   setComposerDraft(text), appendComposerDraft(text), setWorkspace(path),
 *   setStylePresetId(stylePresetId), setStreamSchemeId(streamSchemeId),
 *   setFontFamilyId(fontFamilyId), setFontSizePx(fontSizePx)
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
  /**
   * Drill-down navigation stack for composite nodes. `[]` = top-level graph;
   * each entry pushes one level into a composite's subgraph. UI-transient only:
   * it never mutates `workflow` and is not persisted (like canvasViewport, it is
   * a view concern). The last entry's nodeId is the active scope into which new
   * nodes are parented. See enterComposite/exitComposite/popToGraph.
   */
  graphPath: { nodeId: string; label: string }[];

  // Editor lifecycle state
  mode: 'design' | 'running';
  runState: Record<string, NodeRunState>;
  runOutputs: Record<string, string>;
  lastRunFailedNodeId: string | null;
  canvasViewport: CanvasViewport | null;
  dirty: boolean;
  currentFilePath: string | null;

  // AI state (browser-direct streaming).
  /**
   * True while one or more AI blueprint edits are active. This is an aggregate
   * background indicator; current-session send locking is derived from
   * `aiEditingSessions`.
   */
  aiStreaming: boolean;
  /**
   * Session-bound workflow edits currently owned by the AI-input dock. This is
   * the source for blueprint read-only locking and Sidebar live badges; keep
   * `aiStreaming` as request/loading state only.
   */
  aiEditingSessions: WorkflowSessionKey[];
  /**
   * Session-bound simple-workflow CHAT turns in flight. Like aiEditingSessions
   * they keep `aiStreaming` truthy and drive Sidebar live badges + delete
   * protection, but they do NOT lock the workflow read-only (chatting is not
   * blueprint editing), so consecutive chat messages aren't blocked.
   */
  chattingSessions: WorkflowSessionKey[];
  /** Short-lived composer tip when a send is rejected by chat concurrency rules. */
  blockedSendTip: BlockedSendTip | null;

  // Session / UI state
  sessions: Session[];
  activeSessionId: string | null;
  messages: Message[];
  promptGroups: PromptGroup[];
  locale: Locale;
  promptAutoTranslate: boolean;
  personalInstructionsByModel: PersonalInstructionsByModel;
  personalInstructions: string;
  gameExpertSettings: GameExpertSettings;
  appearance: AppearanceSettings;

  // Composer (AI-input) state — pure UI, never enters the IRGraph.
  composer: ComposerSettings;
  /** Per-session composer controls: permission, runtime selection and cwd. */
  composerBySession: Record<string, SessionComposerSettings>;
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
  /** True once `.freeultracode` history has been loaded or gracefully skipped. */
  historyReady: boolean;
  /** Last history initialization failure, shown instead of sample sessions. */
  historyError: string | null;
  /** Resolved `.freeultracode` root path for diagnostics. */
  historyRootPath: string | null;
  /** Workspace buckets rendered as the first level of the history tree. */
  workspaces: WorkspaceSummary[];
  /** Session summaries grouped by workspace id for the Sidebar tree. */
  sessionTree: Record<string, Session[]>;
  /** Currently selected workspace bucket. */
  activeWorkspaceId: string | null;
  /**
   * Workspace pinned by the top-left workspace switcher (and workspace-header
   * clicks). This is a pure navigation/browsing selection: it only changes on
   * explicit workspace navigation (dropdown selection, workspace header click,
   * init, or deletion fallback) and is deliberately NOT touched when the user
   * opens a session that happens to live in another workspace. Drives the top
   * switcher label and the workspace ordering in the Sidebar so opening a
   * cross-workspace session no longer reshuffles the list. Falls back to
   * `activeWorkspaceId` when null (e.g. before history init).
   */
  selectedWorkspaceId: string | null;
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
  setPersonalInstructions: (
    instructions: string,
    selection?: GatewaySelection | null,
  ) => void;
  setGameExpertSettings: (patch: Partial<GameExpertSettings>) => void;
  setStylePresetId: (stylePresetId: StylePresetId) => void;
  setStreamSchemeId: (streamSchemeId: StreamSchemeId) => void;
  setFontFamilyId: (fontFamilyId: FontFamilyId) => void;
  setFontSizePx: (fontSizePx: number) => void;
  selectNode: (id: string | null) => void;
  /** Drill into a composite node's subgraph (pushes onto graphPath). */
  enterComposite: (nodeId: string) => void;
  /** Pop one level out of the current composite subgraph. */
  exitComposite: () => void;
  /** Truncate graphPath to `depth` levels (breadcrumb click; 0 = top level). */
  popToGraph: (depth: number) => void;
  setWorkflow: (ir: IRGraph) => void;
  openWorkflowSession: (ir: IRGraph, path?: string) => void;
  /** Export the current workflow to a user-chosen file (.fuc.json). */
  exportWorkflow: (title?: string) => void;
  /** Export a workflow session from history to a user-chosen file. */
  exportWorkflowSession: (
    sessionId: string,
    workspaceId: string | null,
    title?: string,
  ) => void;
  /** Import a workflow from a file and open it in a fresh session. */
  importWorkflow: (title?: string) => void;
  /** Import a workflow from a file into a specific workspace history bucket. */
  importWorkflowToWorkspace: (workspaceId: string, title?: string) => void;
  setAdapter: (adapter: string) => void;
  setGlobalRunSelection: (selection: GatewaySelection) => void;
  setSessionRunSelection: (selection: GatewaySelection) => void;
  /** Clear the composer model pin so it inherits the Settings-active provider. */
  clearGlobalRunSelection: () => void;
  runWorkflow: () => void;
  resumeWorkflow: () => void;
  stopWorkflow: () => void;
  stopChat: () => void;
  newWorkflow: () => void;
  newSimpleWorkflow: () => void;
  newCaptainWorkflow: () => void;
  newSession: () => void;
  selectSession: (sessionId: string, workspaceId?: string) => void;
  deleteSession: (sessionId: string, workspaceId?: string) => void;
  deleteWorkspaceHistory: (workspaceId: string) => void;
  renameWorkflowSession: (
    sessionId: string,
    workspaceId: string | null,
    name: string,
  ) => Promise<void>;
  setWorkflowFavoriteSession: (
    sessionId: string,
    workspaceId: string | null,
    favorite: boolean,
  ) => Promise<void>;
  setWorkflowScheduledTaskSession: (
    sessionId: string,
    workspaceId: string | null,
    scheduledTask: ScheduledTaskConfig | null,
  ) => Promise<void>;
  runScheduledTaskSession: (
    sessionId: string,
    workspaceId: string | null,
    scheduledTask: ScheduledTaskConfig,
  ) => Promise<void>;
  sendPrompt: (
    text: string,
    options?: { forceGameExperts?: boolean; gameExpertIds?: string[] },
  ) => void;
  generateImagePrompt: (
    text: string,
    options?: { providerId?: ImageProviderId; model?: string },
  ) => void;
  generateMusicPrompt: (
    text: string,
    options?: { providerId?: MusicProviderId; model?: string },
  ) => void;
  generateThreeDPrompt: (
    text: string,
    options?: { providerId?: ThreeDProviderId; model?: string },
  ) => void;
  /**
   * Search the enabled online 3D model libraries (Project Settings > 模型库) for
   * the given query and render thumbnails / previews / downloads into the active
   * chat. Wired to the `/mesh-search` slash command in AIDock.
   */
  searchMeshLibraryPrompt: (text: string) => void;
  runUltracodePrompt: (task: string) => void;
  /**
   * Append a local message to the current chat session and persist it. Used by
   * app-side actions that produce a result without an AI turn (e.g. the
   * /screenshot and /screenshot-gif export commands echoing the user's command
   * and surfacing their saved path + an inline preview). Returns the message id.
   */
  appendChatNote: (text: string, role?: 'user' | 'assistant' | 'system') => string;
  /** Delete one message from the active conversation and persist the transcript. */
  deleteMessage: (messageId: string) => void;
  /** Create a new chat session containing messages up to the chosen assistant reply. */
  branchSessionFromMessage: (messageId: string) => void;
  clearBlockedSendTip: () => void;
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
  addWorkspaceFolder: (path: string) => void;
  removeWorkspaceFolder: (path: string) => void;
  removeWorkspace: (path: string) => void;
  /**
   * Apply a project's configured workspace folders to the active session's
   * composer. Called after Project Settings → 概览 saves its folder list so the
   * currently-open session immediately operates over the same multi-folder set
   * (new sessions inherit it from workspace metadata). No-op when the given
   * workspace is not the active one.
   */
  applyWorkspaceFolders: (workspaceId: string, folders: string[]) => void;

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
  convertNodeToConsensus: (id: string, strategy: ConsensusStrategy) => void;
  removeNode: (id: string) => void;
  addEdge: (from: IREndpoint, to: IREndpoint, kind: PinKind) => string;
  removeEdge: (id: string) => void;
  setNodePosition: (id: string, x: number, y: number) => void;
  autoArrangeWorkflow: () => void;

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
type ComposerSessionState = Pick<
  StoreState,
  | 'activeWorkspaceId'
  | 'activeSessionId'
  | 'composer'
  | 'composerBySession'
  | 'workflow'
>;
type SessionLiveStatusState = Pick<
  StoreState,
  'runningSessions' | 'aiEditingSessions'
> &
  Partial<Pick<StoreState, 'chattingSessions'>>;

function activeWorkflowSessionKey(
  state: WorkflowSessionState,
): WorkflowSessionKey {
  return {
    workspaceId: state.activeWorkspaceId ?? null,
    sessionId: state.activeSessionId ?? null,
  };
}

type SessionChangesRootState = Pick<
  StoreState,
  | 'activeSessionId'
  | 'activeWorkspaceId'
  | 'composer'
  | 'composerBySession'
  | 'workspaces'
> &
  Partial<Pick<StoreState, 'sessions' | 'sessionTree'>>;

function trimmedPath(path: string | null | undefined): string | null {
  const trimmed = path?.trim();
  return trimmed || null;
}

function workspacePathForId(
  workspaces: WorkspaceSummary[],
  workspaceId: string | null,
): string | null {
  if (!workspaceId) return null;
  return trimmedPath(
    workspaces.find((workspace) => workspace.id === workspaceId)?.path,
  );
}

function projectMcpGuidanceForState(
  state: Pick<StoreState, 'workspaces'>,
  sessionKey: WorkflowSessionKey,
): string {
  if (!sessionKey.workspaceId) return '';
  const workspace = state.workspaces.find(
    (candidate) => candidate.id === sessionKey.workspaceId,
  );
  if (!workspace) return '';
  const settings = projectSettingsFromMetadata(workspace.metadata);
  if (settings.mcp.enabled === false) return '';
  const enabledServers = settings.mcp.servers.filter((server) => server.enabled);
  if (enabledServers.length === 0) return '';

  const serverLines = enabledServers
    .map((server) => {
      const probe = server.lastProbe;
      const status = probe?.ok
        ? `已连接${typeof probe.toolsCount === 'number' ? `，${probe.toolsCount} 个工具` : ''}`
        : probe
          ? `未连接：${probe.message}`
          : '已配置，尚未探测';
      return `- ${server.label}（${server.id}，${status}）`;
    })
    .join('\n');
  const hasUnrealMcp = enabledServers.some((server) =>
    `${server.id} ${server.label}`.toLowerCase().includes('unreal') ||
    server.id.toLowerCase().includes('ue-mcp'),
  );
  const realtimeRule = hasUnrealMcp
    ? '当用户问题涉及 Unreal Editor、当前打开场景、Actor、资源、材质、渲染状态、PIE 或编辑器实时状态时，优先使用 Unreal MCP 工具读取编辑器实时状态；命令行、文件搜索和日志作为补充。'
    : '当用户问题涉及已配置工具能直接读取的运行时状态时，优先使用对应 MCP 工具；命令行、文件搜索和日志作为补充。';

  return `\n\n【全局 MCP】\n当前工作区已启用 MCP server，所有模型请求都应优先使用这些实时工具：\n${serverLines}\n${realtimeRule}\n若 MCP 工具不可用或连接失败，先说明原因，再退回本地文件/日志分析。`;
}

function composerWorkspaceForSessionKey(
  state: SessionChangesRootState,
  sessionKey: WorkflowSessionKey,
): string | null {
  const activeComposerPath = sameSessionKey(
    activeWorkflowSessionKey(state),
    sessionKey,
  )
    ? trimmedPath(state.composer.workspace)
    : null;
  const storedComposerPath = sessionKeyPersistable(sessionKey)
    ? trimmedPath(
        state.composerBySession[workflowSessionKeyId(sessionKey)]?.composer
          .workspace,
      )
    : null;
  return activeComposerPath || storedComposerPath;
}

export function sessionChangesRootPathForSession(
  state: SessionChangesRootState,
  sessionKey: WorkflowSessionKey,
  rootOverride?: string | null,
): string | null {
  const overridePath = trimmedPath(rootOverride);
  if (overridePath) return overridePath;

  const liveRunPath = trimmedPath(
    getRunChannel(sessionKey.workspaceId, sessionKey.sessionId)?.config.cwd,
  );
  if (liveRunPath) return liveRunPath;

  const liveAiPath = trimmedPath(
    getAiEditViewSource(sessionKey.workspaceId, sessionKey.sessionId)
      ?.workspaceRootPath,
  );
  if (liveAiPath) return liveAiPath;

  return (
    composerWorkspaceForSessionKey(state, sessionKey) ||
    workspacePathForId(state.workspaces, sessionKey.workspaceId)
  );
}

export function sessionChangesBaselineAtForSession(
  state: SessionChangesRootState,
  sessionKey: WorkflowSessionKey,
): number | null {
  const session = sessionForKey(
    {
      sessions: state.sessions ?? [],
      sessionTree: state.sessionTree ?? {},
    },
    sessionKey,
  );
  return typeof session?.createdAt === 'number' ? session.createdAt : null;
}

function ensureSessionChangeBaselineForKey(
  state: SessionChangesRootState,
  sessionKey: WorkflowSessionKey,
  rootOverride?: string | null,
): Promise<void> {
  const rootPath = sessionChangesRootPathForSession(
    state,
    sessionKey,
    rootOverride,
  );
  const cacheKey = sessionChangesCacheKey(
    sessionKey.workspaceId,
    sessionKey.sessionId,
    rootPath,
  );
  const baselineAtMs = sessionChangesBaselineAtForSession(state, sessionKey);
  if (!rootPath || !cacheKey) return Promise.resolve();
  return ensureCachedSessionChangesBaseline(rootPath, cacheKey, baselineAtMs).catch(() => {});
}

function refreshSessionChangesForKey(
  sessionKey: WorkflowSessionKey,
  rootOverride?: string | null,
): void {
  const state = useStore.getState();
  const rootPath = sessionChangesRootPathForSession(
    state,
    sessionKey,
    rootOverride,
  );
  const cacheKey = sessionChangesCacheKey(
    sessionKey.workspaceId,
    sessionKey.sessionId,
    rootPath,
  );
  const baselineAtMs = sessionChangesBaselineAtForSession(state, sessionKey);
  if (!rootPath || !cacheKey) return;
  void refreshCachedSessionChanges(rootPath, cacheKey, baselineAtMs).catch(() => {});
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

function personalInstructionsSelectionForState(
  state: Pick<StoreState, 'workflow' | 'composer'>,
): GatewaySelection {
  return workflowDefaultGatewaySelection(state.workflow, state.composer.model);
}

function activePersonalInstructionsForState(
  state: Pick<
    StoreState,
    'personalInstructionsByModel' | 'workflow' | 'composer'
  >,
): string {
  return personalInstructionsForSelection(
    state.personalInstructionsByModel,
    personalInstructionsSelectionForState(state),
  );
}

function sessionKeyPersistable(sessionKey: WorkflowSessionKey): boolean {
  return sessionKey.sessionId !== null;
}

function withSessionGatewayDefaults(
  workflow: IRGraph,
  selection: GatewaySelection,
): IRGraph {
  const normalized = normalizeGatewaySelection(selection);
  return {
    ...workflow,
    meta: {
      ...workflow.meta,
      adapter: normalized.adapter,
      gateway: {
        ...(workflow.meta.gateway ?? {}),
        defaults: normalized,
      },
    },
  };
}

function configuredCliGatewaySelection(): GatewaySelection | null {
  const selected = getCliRuntimeSnapshot().config.selected;
  if (selected.kind !== 'known' && selected.kind !== 'path') return null;
  return systemDefaultGatewaySelection(selected.adapter);
}

function withNewSessionGatewayDefaults(workflow: IRGraph): IRGraph {
  const selection = getExplicitActiveGatewaySelection() ?? configuredCliGatewaySelection();
  return selection ? withSessionGatewayDefaults(workflow, selection) : workflow;
}

function normalizeWorkspaceFolderList(
  paths: unknown,
  primary?: string,
): string[] {
  const primaryKey = primary ? workspacePathKey(primary) : '';
  return uniqueWorkspaceHistory(Array.isArray(paths) ? paths : []).filter(
    (path) => workspacePathKey(path) !== primaryKey,
  );
}

function composerWorkspacePaths(composer: ComposerSettings): string[] {
  return uniqueWorkspaceHistory([
    composer.workspace,
    ...normalizeWorkspaceFolderList(
      composer.workspaceFolders,
      composer.workspace,
    ),
  ]);
}

function composerCliWorkspaceOptions(composer: ComposerSettings): {
  cwd?: string;
  extraWorkspacePaths?: string[];
} {
  const [cwd, ...extraWorkspacePaths] = composerWorkspacePaths(composer);
  return {
    ...(cwd ? { cwd } : {}),
    ...(extraWorkspacePaths.length > 0 ? { extraWorkspacePaths } : {}),
  };
}

function aiEditCliWorkspaceOptions(
  ch: Pick<AiEditChannel, 'workspaceRootPath'>,
  composer: ComposerSettings,
): {
  cwd?: string;
  extraWorkspacePaths?: string[];
} {
  const options = composerCliWorkspaceOptions(composer);
  if (options.cwd) return options;
  const fallback = ch.workspaceRootPath?.trim();
  return fallback ? { ...options, cwd: fallback } : options;
}

function workspaceHistoryWithRecentPaths(
  paths: readonly unknown[],
  history: readonly unknown[],
): string[] {
  return uniqueWorkspaceHistory(
    [...paths, ...history],
    WORKSPACE_HISTORY_LIMIT,
  );
}

function defaultSessionComposer(
  workspace?: string,
  folders?: readonly string[],
): ComposerSettings {
  const trimmed = workspace?.trim();
  return normalizeComposerSettings(
    {
      ...defaultComposer,
      workspace: trimmed || defaultComposer.workspace,
      workspaceFolders: folders ? [...folders] : [],
    },
  );
}

/**
 * Read the project-configured extra workspace folders from a workspace's
 * persisted metadata. New chat sessions inherit these so the composer (and the
 * CLI adapters) operate over the same multi-folder set the user configured in
 * Project Settings → 概览.
 */
function workspaceFoldersFromMetadata(
  metadata: WorkspaceSummary['metadata'],
): string[] {
  return projectSettingsFromMetadata(metadata).folders;
}

function normalizeComposerSettings(value: Partial<ComposerSettings> | undefined): ComposerSettings {
  const source = value ?? {};
  const workspace = normalizeWorkspacePath(source.workspace ?? defaultComposer.workspace);
  return {
    ...defaultComposer,
    ...source,
    workspace,
    workspaceFolders: normalizeWorkspaceFolderList(
      source.workspaceFolders,
      workspace,
    ),
    modelStrategy: source.modelStrategy ?? defaultComposer.modelStrategy,
    imageMode: source.imageMode ?? defaultComposer.imageMode,
    imageModeStartedAt:
      source.imageModeStartedAt ?? defaultComposer.imageModeStartedAt,
    musicMode: source.musicMode ?? defaultComposer.musicMode,
    musicModeStartedAt:
      source.musicModeStartedAt ?? defaultComposer.musicModeStartedAt,
    threeDMode: source.threeDMode ?? defaultComposer.threeDMode,
    threeDModeStartedAt:
      source.threeDModeStartedAt ?? defaultComposer.threeDModeStartedAt,
  };
}

function composerSnapshotFromState(
  state: Pick<StoreState, 'composer' | 'workflow'>,
): SessionComposerSettings {
  return {
    composer: state.composer,
    gatewaySelection: workflowDefaultGatewaySelection(
      state.workflow,
      state.composer.model,
    ),
  };
}

let deferredComposerSave: PersistedComposer | null = null;
let deferredComposerSaveTimer: ReturnType<typeof setTimeout> | null = null;

function saveComposerSoon(state: PersistedComposer): void {
  deferredComposerSave = state;
  if (deferredComposerSaveTimer) return;
  deferredComposerSaveTimer = setTimeout(() => {
    deferredComposerSaveTimer = null;
    const next = deferredComposerSave;
    deferredComposerSave = null;
    if (next) saveComposer(next);
  }, 0);
}

function rememberSessionComposer(
  state: ComposerSessionState,
  nextBySession: Record<string, SessionComposerSettings> = state.composerBySession,
  snapshot: SessionComposerSettings = composerSnapshotFromState(state),
): Record<string, SessionComposerSettings> {
  const currentKey = activeWorkflowSessionKey(state);
  if (!sessionKeyPersistable(currentKey)) return nextBySession;
  return {
    ...nextBySession,
    [workflowSessionKeyId(currentKey)]: snapshot,
  };
}

function composerPatchForSession(
  state: ComposerSessionState,
  sessionKey: WorkflowSessionKey,
  workflow: IRGraph,
  fallbackComposer: ComposerSettings = defaultSessionComposer(),
): Pick<StoreState, 'composer' | 'composerBySession' | 'workflow'> {
  let composerBySession = rememberSessionComposer(state);
  const key = workflowSessionKeyId(sessionKey);
  const stored = sessionKeyPersistable(sessionKey)
    ? composerBySession[key]
    : undefined;
  const snapshot =
    stored ??
    ({
      composer: fallbackComposer,
      gatewaySelection: workflowDefaultGatewaySelection(
        workflow,
        fallbackComposer.model,
      ),
    } satisfies SessionComposerSettings);
  if (!stored && sessionKeyPersistable(sessionKey)) {
    composerBySession = { ...composerBySession, [key]: snapshot };
  }
  return {
    composer: normalizeComposerSettings(snapshot.composer),
    composerBySession,
    workflow: withSessionGatewayDefaults(workflow, snapshot.gatewaySelection),
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
  if (hasSessionKey(state.chattingSessions ?? [], sessionKey)) return 'running';
  if (hasSessionKey(state.aiEditingSessions, sessionKey)) return 'aiEditing';
  return null;
}

export type WorkflowDeleteProtectionReason = SessionLiveStatus;

export function workflowDeleteProtectionReason(
  session: Pick<Session, 'id' | 'isWorkflow'>,
  workspaceId: string | null | undefined,
  state: SessionLiveStatusState,
): WorkflowDeleteProtectionReason {
  if (!session.isWorkflow) return null;

  return sessionLiveStatus(
    { workspaceId: workspaceId ?? null, sessionId: session.id },
    state,
  );
}

const WORKSPACE_HISTORY_LIMIT = 8;
const CANVAS_VIEWPORT_PERSIST_DEBOUNCE_MS = 250;

let historyNavigationVersion = 0;

function beginHistoryNavigation(): number {
  historyNavigationVersion += 1;
  return historyNavigationVersion;
}

function isLatestHistoryNavigation(version: number): boolean {
  return version === historyNavigationVersion;
}

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
  composite: { label: '复合', params: { inputs: [], outputs: [] } },
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
  const selection = workflowDefaultGatewaySelection(
    state.workflow,
    state.composer.model,
  );
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
    title: untitledSessionTitle(locale),
    createdAt: ts,
    updatedAt: ts,
    // New sessions default to chat-type; the first workflow touch flips this on.
    isWorkflow: false,
  };
}

function chatWorkflow(title: string | undefined, locale: Locale): IRGraph {
  return withNewSessionGatewayDefaults(simpleBlueprint(title, locale));
}

function imageResultMarkdown(result: {
  providerLabel: string;
  model: string;
  prompt: string;
  images: string[];
}): string {
  const routeLine = `⚙ 路由：${result.providerLabel} · 模型：${result.model}`;
  const imageLines = result.images
    .map((src, index) => `![生成图片 ${index + 1}](${src})`)
    .join('\n\n');
  return `${routeLine}\n✓ 图片生成完成\n\n提示词：${result.prompt}\n\n${imageLines}`;
}

function musicResultMarkdown(result: {
  providerLabel: string;
  model: string;
  prompt: string;
  audios: string[];
}): string {
  const routeLine = `⚙ 路由：${result.providerLabel} · 模型：${result.model}`;
  const audioLines = result.audios
    .map((src, index) => `[播放音频 ${index + 1}](${src})`)
    .join('\n\n');
  return `${routeLine}\n✓ 音乐生成完成\n\n提示词：${result.prompt}\n\n${audioLines}`;
}

function modelAssetHref(src: string): string {
  if (/^(?:https?:|data:|file:\/\/)/i.test(src)) return src;
  const normalized = src.replace(/\\/g, '/');
  const encoded = encodeURI(normalized).replace(/#/g, '%23').replace(/\?/g, '%3F');
  if (/^[A-Za-z]:\//.test(normalized)) return `file:///${encoded}`;
  if (normalized.startsWith('//')) return `file:${encoded}`;
  if (normalized.startsWith('/')) return `file://${encoded}`;
  return src;
}

function threeDResultMarkdown(result: {
  providerLabel: string;
  model: string;
  prompt: string;
  rigging?: {
    enabled: boolean;
    defaultAnimations: string[];
    requestedAnimations?: string[];
    needsAnimationSearch?: boolean;
  };
  autoRigging?: {
    status: 'succeeded' | 'skipped' | 'failed';
    providerLabel: string;
    reason?: string;
    error?: string;
  } | null;
  assets: string[];
  downloaded?: Array<{ source: string; path: string }>;
  downloadErrors?: Array<{ source: string; error: string }>;
}): string {
  const routeLine = `⚙ 路由：${result.providerLabel} · 模型：${result.model}`;
  const downloaded = new Map(
    (result.downloaded ?? []).map((item) => [item.source, item.path]),
  );
  const assetLines = result.assets
    .map(
      (src, index) =>
        `[预览 3D 模型 ${index + 1}](${modelAssetHref(downloaded.get(src) ?? src)})`,
    )
    .join('\n\n');
  const downloadLines = [
    ...downloaded.values(),
  ].map((path, index) => `- 已下载到本地 ${index + 1}：${path}`);
  const errorLines = (result.downloadErrors ?? []).map(
    (item, index) => `- 下载失败 ${index + 1}：${item.error}（保留远程链接）`,
  );
  const downloadBlock =
    downloadLines.length || errorLines.length
      ? `\n\n${[...downloadLines, ...errorLines].join('\n')}`
      : '';
  const riggingLine = result.rigging
    ? `\n骨骼：${
        result.rigging.enabled
          ? [
              `已按可绑骨资产请求骨骼绑定和 ${result.rigging.defaultAnimations.join('、')} 预览动画`,
              result.autoRigging?.status === 'succeeded'
                ? `${result.autoRigging.providerLabel} 自动绑骨完成`
                : '',
              result.autoRigging?.status === 'skipped'
                ? `自动绑骨跳过：${result.autoRigging.reason ?? '条件不足'}`
                : '',
              result.autoRigging?.status === 'failed'
                ? `自动绑骨失败：${result.autoRigging.error ?? '未知错误'}`
                : '',
              result.rigging.requestedAnimations?.length
                ? `额外动作：${result.rigging.requestedAnimations.join('、')}${
                    result.rigging.needsAnimationSearch ? '（需匹配动画库）' : ''
                  }`
                : '',
            ]
              .filter(Boolean)
              .join('；')
          : '静态资产，跳过骨骼绑定'
      }`
    : '';
  return `${routeLine}\n✓ 3D 模型生成完成${riggingLine}\n\n提示词：${result.prompt}${downloadBlock}\n\n${assetLines}`;
}

function threeDAssetFileName(src: string, index: number): string {
  const clean = src.trim().split(/[?#]/, 1)[0] ?? '';
  const ext =
    /\.(glb|gltf|obj|stl|fbx|ply|usdz|zip)$/i.exec(clean)?.[1]?.toLowerCase() ??
    'glb';
  return `3d-model-${index + 1}.${ext}`;
}

async function downloadThreeDAssets(
  assets: string[],
  cwd?: string,
): Promise<{
  downloaded: Array<{ source: string; path: string }>;
  downloadErrors: Array<{ source: string; error: string }>;
}> {
  const downloaded: Array<{ source: string; path: string }> = [];
  const downloadErrors: Array<{ source: string; error: string }> = [];

  for (const [index, source] of assets.entries()) {
    if (!/^https?:\/\//i.test(source)) continue;
    try {
      const saved = await downloadModelAsset(source, {
        cwd,
        fileName: threeDAssetFileName(source, index),
      });
      downloaded.push({ source, path: saved.path });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === 'NO_BACKEND') continue;
      downloadErrors.push({ source, error: message });
    }
  }

  return { downloaded, downloadErrors };
}

function meshSearchResultMarkdown(
  result: MeshSearchResult,
  downloaded: Map<string, string>,
): string {
  const lines: string[] = [];
  lines.push(`🔎 在线模型库搜索：${result.query}`);
  if (result.items.length > 0) {
    lines.push(`\n找到 ${result.items.length} 个可预览结果：`);
    for (const item of result.items) {
      const parts: string[] = [];
      parts.push(`### ${item.title} · ${item.libraryLabel}`);
      const meta = [
        item.author ? `作者：${item.author}` : '',
        item.license ? `许可：${item.license}` : '',
        item.free ? '可下载' : '需授权',
      ]
        .filter(Boolean)
        .join(' · ');
      if (meta) parts.push(meta);
      if (item.thumbnailUrl) {
        parts.push(`![${item.title}](${item.thumbnailUrl})`);
      }
      const localPath = item.downloadUrl ? downloaded.get(item.downloadUrl) : undefined;
      if (localPath) {
        parts.push(`已下载到本地：[预览 3D 模型](${modelAssetHref(localPath)})`);
      } else if (item.downloadUrl) {
        parts.push(`[预览 / 下载 3D 模型](${item.downloadUrl})`);
      }
      parts.push(`[在 ${item.libraryLabel} 打开](${item.pageUrl})`);
      lines.push(parts.join('\n\n'));
    }
  }
  if (result.linkOuts.length > 0) {
    lines.push('\n以下库无公开下载 API 或未配置账号，已生成搜索深链：');
    for (const link of result.linkOuts) {
      const reason = link.reason ? `（${link.reason}）` : '';
      lines.push(`- [${link.libraryLabel} 搜索结果](${link.searchUrl})${reason}`);
    }
  }
  if (result.errors.length > 0) {
    lines.push('\n部分库搜索失败：');
    for (const error of result.errors) {
      lines.push(`- ${error.libraryLabel}：${error.message}`);
    }
  }
  if (result.items.length === 0 && result.linkOuts.length === 0) {
    lines.push('\n没有启用任何在线模型库。请在项目设置 > 模型库中启用并配置账号。');
  }
  return lines.join('\n');
}

async function downloadMeshSearchAssets(
  result: MeshSearchResult,
  settings: ReturnType<typeof loadMeshLibrarySettings>,
  cwd?: string,
): Promise<Map<string, string>> {
  const downloaded = new Map<string, string>();
  if (!settings.autoDownload) return downloaded;
  let index = 0;
  for (const item of result.items) {
    if (!item.downloadUrl || !/^https?:\/\//i.test(item.downloadUrl)) continue;
    // The Sketchfab download endpoint returns a JSON archive descriptor, not a
    // raw model file, so skip auto-downloading it (link-out for the user).
    if (item.libraryId === 'sketchfab') continue;
    try {
      const saved = await downloadModelAsset(item.downloadUrl, {
        cwd,
        fileName: meshSearchAssetFileName(item.downloadUrl, item.format, index),
      });
      downloaded.set(item.downloadUrl, saved.path);
      index += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === 'NO_BACKEND') return downloaded;
    }
  }
  return downloaded;
}

function meshSearchAssetFileName(src: string, format: string | undefined, index: number): string {
  const clean = src.trim().split(/[?#]/, 1)[0] ?? '';
  const ext =
    /\.(glb|gltf|obj|stl|fbx|ply|usdz|zip)$/i.exec(clean)?.[1]?.toLowerCase() ??
    (format && /^(glb|gltf|obj|stl|fbx|ply|usdz|zip)$/i.test(format)
      ? format.toLowerCase()
      : 'glb');
  return `mesh-search-${index + 1}.${ext}`;
}

function threeDFailureHint(message: string): string {
  if (
    message === 'NO_READY_THREE_D_PROVIDER' ||
    message === 'THREE_D_GENERATION_DISABLED' ||
    message.startsWith('THREE_D_PROVIDER_NOT_READY') ||
    /api key is missing/i.test(message)
  ) {
    return '请在设置 > 3D 渠道中配置可用的商用或免费 Provider。';
  }
  if (/^(?:401\b|.*Unauthorized)/i.test(message)) {
    return '请检查 3D Provider API Key 是否有效。';
  }
  if (/^(?:402\b|.*Payment Required)|credits?/i.test(message)) {
    return '请检查 3D Provider 余额或 credits。';
  }
  if (/^429\b|Too Many Requests/i.test(message)) {
    return '请求过频，请稍后重试。';
  }
  return '配置已读取；请检查 3D Provider 返回错误、模型参数、额度或网络。';
}

function untitledSessionTitle(locale: Locale): string {
  return t(locale, 'defaultBlueprint.untitledSession');
}

function isVisibleChatSessionSummary(summary: SessionSummary): boolean {
  return !summary.isWorkflow || summary.simple === true;
}

function visibleChatSessionSummaries(
  sessions: SessionSummary[],
): SessionSummary[] {
  return sessions.filter(isVisibleChatSessionSummary);
}

function historySessionRunStatus(
  status?: unknown,
): SessionRunStatus | undefined {
  if (!isRunStatus(status) || status === 'idle') return undefined;
  return persistedStatusForDisplay(status) as SessionRunStatus;
}

function isScheduledTaskWeekday(
  value: unknown,
): value is ScheduledTaskWeekday {
  return (
    value === 0 ||
    value === 1 ||
    value === 2 ||
    value === 3 ||
    value === 4 ||
    value === 5 ||
    value === 6
  );
}

function normalizeSchedulePart(value: unknown, max: number): number | null {
  if (typeof value !== 'number') return null;
  if (!Number.isInteger(value) || value < 0 || value > max) return null;
  return value;
}

function normalizeScheduledTask(
  value: unknown,
): ScheduledTaskConfig | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Partial<ScheduledTaskConfig>;
  const hour = normalizeSchedulePart(raw.hour, 23);
  const minute = normalizeSchedulePart(raw.minute, 59);
  const second = normalizeSchedulePart(raw.second, 59);
  const weekdays = Array.isArray(raw.weekdays)
    ? Array.from(new Set(raw.weekdays)).filter(isScheduledTaskWeekday)
    : [];
  if (
    typeof raw.enabled !== 'boolean' ||
    typeof raw.reminderText !== 'string' ||
    hour === null ||
    minute === null ||
    second === null ||
    weekdays.length === 0 ||
    typeof raw.repeat !== 'boolean' ||
    typeof raw.remindOnRun !== 'boolean' ||
    typeof raw.updatedAt !== 'number' ||
    !Number.isFinite(raw.updatedAt)
  ) {
    return undefined;
  }
  return {
    enabled: raw.enabled,
    reminderText: raw.reminderText,
    hour,
    minute,
    second,
    weekdays,
    repeat: raw.repeat,
    remindOnRun: raw.remindOnRun,
    updatedAt: raw.updatedAt,
    ...(typeof raw.lastRunAt === 'number' && Number.isFinite(raw.lastRunAt)
      ? { lastRunAt: raw.lastRunAt }
      : {}),
  };
}

function sessionFromSummary(summary: SessionSummary): Session {
  const runStatus = historySessionRunStatus(summary.runStatus);
  const scheduledTask = normalizeScheduledTask(summary.scheduledTask);
  return {
    id: summary.id,
    workspaceId: summary.workspaceId,
    title: summary.title,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    isWorkflow: summary.isWorkflow,
    ...(summary.simple ? { simple: true } : {}),
    preview: summary.preview,
    messageCount: summary.messageCount,
    ...(runStatus ? { runStatus } : {}),
    ...(summary.favorite === true ? { favorite: true } : {}),
    ...(scheduledTask ? { scheduledTask } : {}),
  };
}

function summaryFromRecord(record: SessionRecord): SessionSummary {
  const last = record.messages[record.messages.length - 1]?.text?.trim();
  const runStatus = record.meta?.runStatus;
  const scheduledTask = normalizeScheduledTask(record.meta?.scheduledTask);
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    title: record.title,
    isWorkflow: record.isWorkflow,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.workflow?.meta?.simple ? { simple: true } : {}),
    preview: last ? last.slice(0, 80) : undefined,
    messageCount: record.messages.length,
    ...(runStatus ? { runStatus } : {}),
    ...(record.meta?.favorite === true ? { favorite: true } : {}),
    ...(scheduledTask ? { scheduledTask } : {}),
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
      return [
        workspace.id,
        visibleChatSessionSummaries(sessions).map((item) =>
          sessionFromSummary(item),
        ),
      ] as const;
    }),
  );
  return Object.fromEntries(pairs);
}

function sessionsForWorkspaceState(
  state: Pick<StoreState, 'activeWorkspaceId' | 'sessions' | 'sessionTree'>,
  workspaceId: string,
): Session[] {
  return (
    state.sessionTree[workspaceId] ??
    (state.activeWorkspaceId === workspaceId ? state.sessions : [])
  );
}

function sessionForKey(
  state: Pick<StoreState, 'sessions' | 'sessionTree'>,
  sessionKey: WorkflowSessionKey,
): Session | undefined {
  const sessionId = sessionKey.sessionId;
  if (!sessionId) return undefined;
  const workspaceSessions =
    sessionKey.workspaceId !== null
      ? state.sessionTree[sessionKey.workspaceId]
      : undefined;
  return (workspaceSessions ?? state.sessions).find(
    (session) => session.id === sessionId,
  );
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

async function persistCurrentConversation(
  messages: Message[],
  workflow?: IRGraph,
): Promise<void> {
  const ctx = getActiveHistoryContext();
  if (!ctx) return;
  await historyStore.updateSession(ctx.workspaceId, ctx.sessionId, {
    messages,
    ...(workflow ? { workflow } : {}),
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

function syncAndPersistSessionRunStatus(
  sessionKey: WorkflowSessionKey,
  status: IRRunStatus | undefined,
): void {
  syncSessionRunStatus(sessionKey, status);
  scheduleSessionRunCompletedNotification(sessionKey, status);
  if (!sessionKey.workspaceId || !sessionKey.sessionId) return;
  flushAiEditPersistKey(
    aiEditPersistKey(sessionKey.workspaceId, sessionKey.sessionId),
  );
  void historyStore
    .updateSession(sessionKey.workspaceId, sessionKey.sessionId, {
      meta: { runStatus: status ?? 'idle' },
    })
    .catch(() => {});
}

function sessionHasLiveActivity(sessionKey: WorkflowSessionKey): boolean {
  return (
    !!getRunChannel(sessionKey.workspaceId, sessionKey.sessionId) ||
    getAiEditChannelsForSession(
      sessionKey.workspaceId,
      sessionKey.sessionId,
    ).length > 0
  );
}

function notifySessionRunCompleted(
  sessionKey: WorkflowSessionKey,
  status: IRRunStatus | undefined,
): void {
  if (!isNotifiableCompletionStatus(status)) return;
  if (sessionHasLiveActivity(sessionKey)) return;
  const state = useStore.getState();
  const session = sessionForKey(state, sessionKey);
  const sessionTitle =
    session?.title?.trim() ||
    state.workflow.meta?.name?.trim() ||
    null;
  void notifySessionComplete({
    status,
    sessionTitle,
    workspaceId: sessionKey.workspaceId,
    sessionId: sessionKey.sessionId,
  });
}

function scheduleSessionRunCompletedNotification(
  sessionKey: WorkflowSessionKey,
  status: IRRunStatus | undefined,
): void {
  if (!isNotifiableCompletionStatus(status)) return;
  globalThis.setTimeout(() => {
    notifySessionRunCompleted(sessionKey, status);
  }, 0);
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
    nextWorkflow = normalizeWorkflowNodeNumbers(patch.workflow);

    const next: Partial<StoreState> = { workflow: nextWorkflow };
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

function commitGraphEdit(
  ir: IRGraph,
  source: WorkflowWriteSource = 'user',
  sessionKey?: WorkflowSessionKey,
): boolean {
  let nextWorkflow = ir;
  return applyWorkflowEdit(source, (state) => {
    // [dynamic-only refactor] 原用 prepareGraphEdit(state.workflow, ir)(含 autoLayout)。
    // 蓝图布局编辑已停用，退化为仅节点编号归一化。
    void state;
    nextWorkflow = normalizeWorkflowNodeNumbers(ir);
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
  const migrated = normalizeWorkflowNodeNumbers(
    migrateWorkflowGateway(workflow, defaultComposer.model),
  );
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

function activeMessageSummaryPatch(
  state: StoreState,
  messages: Message[],
): Pick<StoreState, 'sessions' | 'sessionTree'> {
  const activeSessionId = state.activeSessionId;
  if (!activeSessionId) {
    return { sessions: state.sessions, sessionTree: state.sessionTree };
  }
  const last = [...messages].reverse().find((message) => message.text.trim());
  const updatedAt = Date.now();
  const updateSession = (session: Session): Session =>
    session.id === activeSessionId
      ? {
          ...session,
          updatedAt,
          preview: last ? previewFromText(last.text) : undefined,
          messageCount: messages.length,
        }
      : session;
  return {
    sessions: state.sessions.map(updateSession),
    sessionTree: state.activeWorkspaceId
      ? {
          ...state.sessionTree,
          [state.activeWorkspaceId]: (
            state.sessionTree[state.activeWorkspaceId] ?? state.sessions
          ).map(updateSession),
        }
      : state.sessionTree,
  };
}

function removeMessagesById(messages: Message[], ids: Set<string>): Message[] {
  if (ids.size === 0) return messages;
  return messages.filter((message) => !ids.has(message.id));
}

function previousUserIdForAssistantTurn(
  messages: Message[],
  assistantIndex: number,
): string | null {
  for (let i = assistantIndex - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role === 'user') return message.id;
    if (message.role === 'assistant') return null;
  }
  return null;
}

function aiEditOwnedTurnIds(
  workspaceId: string | null,
  sessionId: string | null,
  messageId: string,
): Set<string> {
  const ids = new Set<string>();
  const sources = [
    ...getAiEditChannelsForSession(workspaceId, sessionId),
    ...getAiEditSnapshotsForSession(workspaceId, sessionId),
  ];
  for (const ch of sources) {
    if (!ch.ownedMessageIds?.has(messageId)) continue;
    for (const id of ch.ownedMessageIds) ids.add(id);
  }
  return ids;
}

function deletionIdsForAssistantTurn(
  messages: Message[],
  messageId: string,
  sessionKey: WorkflowSessionKey,
): Set<string> {
  const ids = aiEditOwnedTurnIds(
    sessionKey.workspaceId,
    sessionKey.sessionId,
    messageId,
  );
  const index = messages.findIndex((message) => message.id === messageId);
  const target = index >= 0 ? messages[index] : null;
  if (!target) return ids;
  ids.add(messageId);
  if (target.role === 'assistant') {
    const previousUserId = previousUserIdForAssistantTurn(messages, index);
    if (previousUserId) ids.add(previousUserId);
  }
  return ids;
}

function simpleWorkflowFromMessages(workflow: IRGraph, messages: Message[]): IRGraph {
  if (workflow.meta?.simple !== true) return workflow;
  return setStartUserInputs(workflow, chatUserInputsFromMessages(messages));
}

function pruneAiEditSourceMessages(
  ch: AiEditChannel,
  ids: Set<string>,
): boolean {
  const beforeCount = ch.messages.length;
  ch.messages = removeMessagesById(ch.messages, ids);
  for (const id of ids) ch.ownedMessageIds?.delete(id);
  ch.workflow = simpleWorkflowFromMessages(ch.workflow, ch.messages);
  return ch.messages.length !== beforeCount;
}

function pruneAiEditSourcesForDeletion(
  workspaceId: string | null,
  sessionId: string | null,
  ids: Set<string>,
): void {
  const activeKeys = new Set<string>();
  for (const ch of getAiEditChannelsForSession(workspaceId, sessionId)) {
    activeKeys.add(ch.key);
    const deletesOwnedTurn = [...ids].some((id) => ch.ownedMessageIds?.has(id));
    const changed = pruneAiEditSourceMessages(ch, ids);
    if (deletesOwnedTurn) {
      ch.abortController.abort();
      void cancelActiveAiEditRuns(ch);
      removeAiEditChannel(ch);
    } else if (changed) {
      rememberAiEditSnapshot(ch);
    }
  }

  for (const ch of getAiEditSnapshotsForSession(workspaceId, sessionId)) {
    if (activeKeys.has(ch.key)) continue;
    if (pruneAiEditSourceMessages(ch, ids)) {
      aiEditSnapshots.set(ch.key, cloneAiEditSnapshot(ch));
    }
  }
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

function messagesThroughAssistantReply(
  messages: Message[],
  messageId: string,
): Message[] {
  const index = messages.findIndex((message) => message.id === messageId);
  if (index < 0 || messages[index]?.role !== 'assistant') return [];
  return messages.slice(0, index + 1).map((message) => ({ ...message }));
}

function branchSessionTitle(
  sourceTitle: string | undefined,
  messages: Message[],
  locale: Locale,
): string {
  const fallback = locale === 'en-US' ? 'Session branch' : '会话分支';
  const source =
    sourceTitle && !isAutoTitlePlaceholder(sourceTitle)
      ? sourceTitle
      : messages.find((message) => message.role === 'user' && message.text.trim())
          ?.text;
  const prefix = locale === 'en-US' ? 'Branch: ' : '分支：';
  return titleFromText(`${prefix}${source?.trim() || fallback}`, fallback);
}

async function branchChatSessionFromMessage(messageId: string): Promise<void> {
  const state = useStore.getState();
  const branchMessages = messagesThroughAssistantReply(state.messages, messageId);
  if (branchMessages.length === 0) return;

  const sourceSession = sessionForKey(state, activeWorkflowSessionKey(state));
  const title = branchSessionTitle(
    sourceSession?.title ?? state.workflow.meta?.name,
    branchMessages,
    state.locale,
  );
  const gatewaySelection = workflowDefaultGatewaySelection(
    state.workflow,
    state.composer.model,
  );
  const snapshot: SessionComposerSettings = {
    composer: state.composer,
    gatewaySelection,
  };
  const workspaceId = state.activeWorkspaceId;

  if (!state.historyReady || !workspaceId) {
    const createdAt = Date.now();
    const last = [...branchMessages]
      .reverse()
      .find((message) => message.text.trim());
    const session: Session = {
      id: shortId('s'),
      title,
      createdAt,
      updatedAt: createdAt,
      isWorkflow: false,
      preview: last ? previewFromText(last.text) : undefined,
      messageCount: branchMessages.length,
    };
    const sessionKey = {
      workspaceId: state.activeWorkspaceId ?? null,
      sessionId: session.id,
    };
    useStore.setState((s) => {
      const currentComposerBySession = rememberSessionComposer(s);
      const composerBySession = {
        ...currentComposerBySession,
        [workflowSessionKeyId(sessionKey)]: snapshot,
      };
      saveComposerSoon({
        composer: snapshot.composer,
        composerBySession,
        workspaceHistory: s.workspaceHistory,
      });
      const workflow = withSessionGatewayDefaults(
        chatWorkflow(title, s.locale),
        snapshot.gatewaySelection,
      );
      const draftPatch = composerDraftPatchForSession(s, sessionKey);
      return {
        workflow,
        composer: normalizeComposerSettings(snapshot.composer),
        composerBySession,
        selectedNodeId: null,
        dirty: false,
        ...emptyRunProgress(),
        sessions: [session, ...s.sessions],
        activeSessionId: session.id,
        messages: branchMessages,
        canvasViewport: null,
        currentFilePath: null,
        mode: 'design' as const,
        sessionTree: s.activeWorkspaceId
          ? {
              ...s.sessionTree,
              [s.activeWorkspaceId]: [
                session,
                ...(s.sessionTree[s.activeWorkspaceId] ?? s.sessions),
              ],
            }
          : s.sessionTree,
        ...draftPatch,
      };
    });
    return;
  }

  const record = await historyStore.createSession({
    workspaceId,
    isWorkflow: false,
    messages: branchMessages,
    title,
  });
  const sessionKey = { workspaceId, sessionId: record.id };
  useStore.setState((s) => {
    const composerBySession = {
      ...rememberSessionComposer(s),
      [workflowSessionKeyId(sessionKey)]: snapshot,
    };
    saveComposerSoon({
      composer: snapshot.composer,
      composerBySession,
      workspaceHistory: s.workspaceHistory,
    });
    return { composerBySession };
  });
  await activateHistorySession(record.id, workspaceId);
}

async function createNewChatSession(): Promise<void> {
  const state = useStore.getState();
  let workspaceId = state.activeWorkspaceId;
  const title = untitledSessionTitle(state.locale);
  const workflow = chatWorkflow(title, state.locale);

  // No workspace selected yet: fall back to a default workspace folder so the
  // new session has a real cwd instead of being a detached local-only session.
  // Resolve (and create on disk) the platform default, register it as a
  // workspace, then continue with that id.
  if (state.historyReady && !workspaceId) {
    const defaultPath = await ensureDefaultWorkspaceDir();
    if (defaultPath) {
      try {
        const defaultWorkspace =
          await historyStore.resolveWorkspaceByPath(defaultPath);
        workspaceId = defaultWorkspace.id;
        const workspaces = await historyStore.listWorkspaces();
        useStore.setState((s) => {
          const workspaceHistory = workspaceHistoryWithRecent(
            defaultPath,
            s.workspaceHistory,
            WORKSPACE_HISTORY_LIMIT,
          );
          const composer = normalizeComposerSettings({
            ...s.composer,
            workspace: defaultPath,
          });
          saveComposerSoon({
            composer,
            composerBySession: s.composerBySession,
            workspaceHistory,
          });
          return {
            workspaces,
            activeWorkspaceId: defaultWorkspace.id,
            selectedWorkspaceId: defaultWorkspace.id,
            composer,
            workspaceHistory,
          };
        });
      } catch (err) {
        console.error('[new-session] failed to create default workspace', err);
      }
    }
  }

  if (!state.historyReady || !workspaceId) {
    const session = makeSession(state.locale);
    useStore.setState((s) => {
      const sessionKey = {
        workspaceId: s.activeWorkspaceId ?? null,
        sessionId: session.id,
      };
      const composerPatch = composerPatchForSession(s, sessionKey, workflow);
      return {
        workflow: composerPatch.workflow,
        composer: composerPatch.composer,
        composerBySession: composerPatch.composerBySession,
        selectedNodeId: null,
        dirty: false,
        ...emptyRunProgress(),
        sessions: [session, ...s.sessions],
        activeSessionId: session.id,
        messages: [],
        canvasViewport: null,
        currentFilePath: null,
        mode: 'design',
        ...composerDraftPatchForSession(s, sessionKey),
      };
    });
    return;
  }

  const record = await historyStore.createSession({
    workspaceId,
    isWorkflow: false,
    messages: [],
    title,
  });
  const session = sessionFromRecord(record);
  const workspaces = await historyStore.listWorkspaces();
  const sessionTree = await loadSessionTree(workspaces);
  const nextWorkflow = chatWorkflow(record.title, state.locale);
  useStore.setState((s) => {
    if (s.activeWorkspaceId !== workspaceId) {
      return {
        workspaces,
        sessionTree,
        sessions: s.activeWorkspaceId
          ? sessionTree[s.activeWorkspaceId] ?? s.sessions
          : s.sessions,
      };
    }
    const sessionKey = {
      workspaceId,
      sessionId: session.id,
    };
    const workspace = workspaces.find((item) => item.id === workspaceId);
    const composerPatch = composerPatchForSession(
      s,
      sessionKey,
      nextWorkflow,
      defaultSessionComposer(
        workspace?.path,
        workspaceFoldersFromMetadata(workspace?.metadata),
      ),
    );
    return {
      workflow: composerPatch.workflow,
      composer: composerPatch.composer,
      composerBySession: composerPatch.composerBySession,
      selectedNodeId: null,
      dirty: false,
      ...emptyRunProgress(),
      workspaces,
      sessions: sessionTree[workspaceId] ?? [session],
      sessionTree,
      activeSessionId: session.id,
      selectedWorkspaceId: workspaceId,
      messages: [],
      canvasViewport: null,
      currentFilePath: null,
      mode: 'design',
      ...composerDraftPatchForSession(s, sessionKey),
    };
  });
  const current = useStore.getState();
  if (
    current.activeWorkspaceId === workspaceId &&
    current.activeSessionId === session.id
  ) {
    await historyStore.patchConfig({
      lastActiveWorkspaceId: workspaceId,
      lastActiveSessionId: session.id,
    });
  }
}

async function createNewWorkflowSession(
  // [dynamic-only refactor] 默认 build 原为 defaultBlueprint(已停用)，改为 simpleBlueprint。
  build: (name: string | undefined, locale: Locale) => IRGraph = simpleBlueprint,
): Promise<void> {
  const state = useStore.getState();
  const workspaceId = state.activeWorkspaceId;
  const workflow = withNewSessionGatewayDefaults(build(undefined, state.locale));
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
  useStore.setState((s) => {
    if (s.activeWorkspaceId !== workspaceId) {
      return {
        workspaces,
        sessionTree,
        sessions: s.activeWorkspaceId
          ? sessionTree[s.activeWorkspaceId] ?? s.sessions
          : s.sessions,
      };
    }
    const sessionKey = {
      workspaceId,
      sessionId: session.id,
    };
    return {
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
      ...composerDraftPatchForSession(s, sessionKey),
    };
  });
  const current = useStore.getState();
  if (
    current.activeWorkspaceId === workspaceId &&
    current.activeSessionId === session.id
  ) {
    await historyStore.patchConfig({
      lastActiveWorkspaceId: workspaceId,
      lastActiveSessionId: session.id,
    });
  }
}

interface FreeUltraCodeSessionOptions {
  workspaceId?: string | null;
  forceNewSession?: boolean;
}

async function openWorkflowInSession(
  ir: IRGraph,
  path?: string,
  options: FreeUltraCodeSessionOptions = {},
): Promise<void> {
  const state = useStore.getState();
  const workflow = restoreWorkflowRunSnapshot(
    migrateWorkflowGateway(ir, defaultComposer.model),
  );
  const runProgress = runProgressFromSnapshot(workflow, workflow.meta.run ?? null);
  const title =
    workflow.meta.name ??
    (state.locale === 'en-US' ? 'Workflow' : '工作流');

  if (!options.forceNewSession && !isWorkflowReadOnly(state)) {
    applyWorkflowEdit(
      'user',
      () => ({ workflow, ...runProgress }),
      workflow.meta.run ? runMetaFromSnapshot(workflow.meta.run) : emptyRunMeta(),
    );
    useStore.getState().markSaved(path);
    return;
  }

  const workspaceId = options.workspaceId ?? state.activeWorkspaceId;
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
  useStore.setState((s) => {
    const sessionKey = { workspaceId, sessionId: session.id };
    const workspace = workspaces.find((item) => item.id === workspaceId);
    const workspaceHistory = workspace?.path
      ? workspaceHistoryWithRecent(
          workspace.path,
          s.workspaceHistory,
          WORKSPACE_HISTORY_LIMIT,
        )
      : s.workspaceHistory;
    const composerPatch = composerPatchForSession(
      s,
      sessionKey,
      workflow,
      defaultSessionComposer(
        workspace?.path,
        workspaceFoldersFromMetadata(workspace?.metadata),
      ),
    );
    if (workspace?.path) {
      saveComposerSoon({
        composer: composerPatch.composer,
        composerBySession: composerPatch.composerBySession,
        workspaceHistory,
      });
    }
    return {
      workflow: composerPatch.workflow,
      composer: composerPatch.composer,
      composerBySession: composerPatch.composerBySession,
      selectedNodeId: null,
      dirty: false,
      runState: runProgress.runState,
      runOutputs: runProgress.runOutputs,
      lastRunFailedNodeId: runProgress.lastRunFailedNodeId,
      canvasViewport: null,
      mode: 'design',
      currentFilePath: path ?? null,
      activeWorkspaceId: workspaceId,
      selectedWorkspaceId: workspaceId,
      workspaces,
      sessions: sessionTree[workspaceId] ?? [session],
      sessionTree,
      activeSessionId: session.id,
      messages: [],
      workspaceHistory,
      ...composerDraftPatchForSession(s, sessionKey),
    };
  });
  await historyStore.patchConfig({
    lastActiveWorkspaceId: workspaceId,
    lastActiveSessionId: session.id,
  });
}

async function exportWorkflowHistorySession(
  sessionId: string,
  workspaceId: string | null,
  title?: string,
): Promise<void> {
  const state = useStore.getState();
  const targetWorkspaceId = workspaceId ?? state.activeWorkspaceId ?? null;
  const isActive =
    state.activeSessionId === sessionId &&
    state.activeWorkspaceId === targetWorkspaceId;
  let workflow =
    liveWorkflowForSession(targetWorkspaceId, sessionId) ??
    (isActive ? state.workflow : null);

  if (!workflow && state.historyReady && targetWorkspaceId) {
    const record = await historyStore.getSession(targetWorkspaceId, sessionId);
    if (record?.isWorkflow && record.workflow) {
      workflow = restoreWorkflowRunSnapshot(record.workflow, record.meta);
    }
  }

  if (!workflow) return;
  await exportWorkflowToFile(workflow, title);
}

async function importWorkflowIntoWorkspace(
  workspaceId: string,
  title?: string,
): Promise<void> {
  const result = await importWorkflowFromFile(title);
  if (!result) return;
  await openWorkflowInSession(result.ir, result.path ?? undefined, {
    workspaceId,
    forceNewSession: true,
  });
}

async function activateHistorySession(
  sessionId: string,
  workspaceId?: string,
  options?: { onlyIfActive?: WorkflowSessionKey },
): Promise<void> {
  const navigationVersion = beginHistoryNavigation();
  const state = useStore.getState();
  const targetWorkspaceId = workspaceId ?? state.activeWorkspaceId ?? undefined;
  if (!state.historyReady || !targetWorkspaceId) {
    useStore.setState((s) => {
      if (!isLatestHistoryNavigation(navigationVersion)) return s;
      if (
        options?.onlyIfActive &&
        !sameSessionKey(activeWorkflowSessionKey(s), options.onlyIfActive)
      ) {
        return s;
      }
      const targetSession = sessionForKey(s, {
        workspaceId: s.activeWorkspaceId ?? null,
        sessionId,
      });
      const sessionKey = {
        workspaceId: s.activeWorkspaceId ?? null,
        sessionId,
      };
      const livePatch = (() => {
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
        const aiEditSnapshot = getAiEditViewSource(
          s.activeWorkspaceId ?? null,
          sessionId,
        );
        if (aiEditSnapshot) {
          return {
            messages: aiEditSnapshot.messages,
            workflow: aiEditSnapshot.workflow,
            ...emptyRunProgress(),
            mode: 'design' as const,
          };
        }
        return null;
      })();
      const fallbackPatch = !targetSession?.isWorkflow
        ? {
            messages: [],
            workflow: chatWorkflow(targetSession?.title, s.locale),
            ...emptyRunProgress(),
            mode: 'design' as const,
          }
        : null;
      const baseWorkflow =
        livePatch?.workflow ?? fallbackPatch?.workflow ?? s.workflow;
      const composerPatch = composerPatchForSession(
        s,
        sessionKey,
        baseWorkflow,
      );
      return {
        activeSessionId: sessionId,
        canvasViewport: null,
        selectedNodeId: null,
        ...(fallbackPatch ?? {}),
        ...(livePatch ?? {}),
        workflow: composerPatch.workflow,
        composer: composerPatch.composer,
        composerBySession: composerPatch.composerBySession,
        ...composerDraftPatchForSession(s, sessionKey),
      };
    });
    return;
  }

  const record = await historyStore.getSession(targetWorkspaceId, sessionId);
  if (!isLatestHistoryNavigation(navigationVersion)) return;
  if (!record) return;
  const session = sessionFromRecord(record);

  // If we're switching BACK to the session whose run is still executing, rebuild
  // the view from the live in-memory channel (not the persisted snapshot, which
  // may lag a tick behind and would show stale/interrupted state). This keeps
  // the run visibly live — including any mid-flight streaming message — and
  // crucially does NOT cancel its CLI processes.
  const ch = getRunChannel(targetWorkspaceId, session.id);
  const liveRun = runActive(ch) ? ch : null;
  // Pick the freshest AI-edit source for view restoration. getAiEditViewSource
  // prefers the live channel (including chat-mode channels, which getAiEditChannel
  // deliberately excludes for read-only-lock purposes) and falls back to the
  // retained snapshot so a finished stream still restores its final messages.
  const aiEditSnapshot = getAiEditViewSource(targetWorkspaceId, session.id);

  const recordWorkflow = record.workflow
    ? restoreWorkflowRunSnapshot(record.workflow, record.meta)
    : null;
  const workflow = liveRun
    ? liveRun.workflow
    : aiEditSnapshot
      ? aiEditSnapshot.workflow
      : recordWorkflow ?? chatWorkflow(record.title, state.locale);
  const runProgress = liveRun
    ? {
        runState: liveRun.runState,
        runOutputs: liveRun.runOutputs,
        lastRunFailedNodeId: liveRun.failedNodeId,
      }
    : aiEditSnapshot
      ? emptyRunProgress()
      : recordWorkflow
        ? runProgressFromSnapshot(workflow, workflow.meta.run ?? null)
        : emptyRunProgress();
  const viewMessages = liveRun
    ? liveRun.messages
    : aiEditSnapshot
      ? mergeMessagesById(record.messages, aiEditSnapshot.messages)
      : record.messages;
  const canvasViewport = canvasViewportForSession(
    targetWorkspaceId,
    session.id,
    record.meta,
  );
  let activated = false;
  useStore.setState((s) => {
    if (!isLatestHistoryNavigation(navigationVersion)) return s;
    if (
      options?.onlyIfActive &&
      !sameSessionKey(activeWorkflowSessionKey(s), options.onlyIfActive)
    ) {
      return s;
    }
    activated = true;
    const draftPatch = composerDraftPatchForSession(s, {
      workspaceId: targetWorkspaceId,
      sessionId: session.id,
    });
    const workspace = s.workspaces.find((ws) => ws.id === targetWorkspaceId);
    const fallbackComposer = defaultSessionComposer(
      workspace?.path,
      workspaceFoldersFromMetadata(workspace?.metadata),
    );
    const workspaceHistory = workspace?.path
      ? workspaceHistoryWithRecent(
          workspace.path,
          s.workspaceHistory,
          WORKSPACE_HISTORY_LIMIT,
        )
      : s.workspaceHistory;
    const composerPatch = composerPatchForSession(
      s,
      { workspaceId: targetWorkspaceId, sessionId: session.id },
      workflow,
      fallbackComposer,
    );
    if (workspace) {
      saveComposerSoon({
        composer: composerPatch.composer,
        composerBySession: composerPatch.composerBySession,
        workspaceHistory,
      });
    }
    return {
      activeWorkspaceId: targetWorkspaceId,
      activeSessionId: session.id,
      composer: composerPatch.composer,
      composerBySession: composerPatch.composerBySession,
      workspaceHistory,
      workflow: composerPatch.workflow,
      ...draftPatch,
      ...(() => {
        const currentSessions = sessionsForWorkspaceState(s, targetWorkspaceId);
        const promotedSessions = [
          session,
          ...currentSessions.filter((item) => item.id !== session.id),
        ];
        return {
          sessions: promotedSessions,
          sessionTree: {
            ...s.sessionTree,
            [targetWorkspaceId]: promotedSessions,
          },
        };
      })(),
      messages: viewMessages,
      ...runProgress,
      canvasViewport: recordWorkflow ? canvasViewport : null,
      selectedNodeId: null,
      mode: liveRun ? 'running' : 'design',
    };
  });
  if (!activated || !isLatestHistoryNavigation(navigationVersion)) return;
  const current = useStore.getState();
  if (
    current.activeWorkspaceId !== targetWorkspaceId ||
    current.activeSessionId !== session.id
  ) {
    return;
  }
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

  const targetSession = sessionsForWorkspaceState(
    state,
    targetWorkspaceId,
  ).find((session) => session.id === sessionId);
  if (
    targetSession &&
    workflowDeleteProtectionReason(targetSession, targetWorkspaceId, state)
  ) {
    return;
  }

  await historyStore.deleteSession(targetWorkspaceId, sessionId);

  const workspaces = await historyStore.listWorkspaces();
  const postDelete = {
    nextActiveId: null as string | null,
    shouldClearActive: false,
  };

  useStore.setState((s) => {
    const targetIsActiveWorkspace = s.activeWorkspaceId === targetWorkspaceId;
    const sourceSessions = sessionsForWorkspaceState(s, targetWorkspaceId);
    const nextSessions = sourceSessions.filter(
      (session) => session.id !== sessionId,
    );
    const stillDeletingActive =
      targetIsActiveWorkspace && s.activeSessionId === sessionId;
    const nextActive = stillDeletingActive ? nextSessions[0] ?? null : null;
    postDelete.nextActiveId = nextActive?.id ?? null;
    postDelete.shouldClearActive = stillDeletingActive && nextActive == null;

    const sessionTree = {
      ...s.sessionTree,
      [targetWorkspaceId]: nextSessions,
    };

    if (!postDelete.shouldClearActive) {
      return {
        workspaces,
        sessionTree,
        ...(targetIsActiveWorkspace ? { sessions: nextSessions } : {}),
      };
    }

    return {
      workspaces,
      activeSessionId: null,
      sessions: nextSessions,
      sessionTree,
      messages: [],
      workflow: chatWorkflow(undefined, s.locale),
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
    };
  });

  // Deleting the active session: switch to the next available session and
  // load its full data (messages, workflow, run state), or clear the editor
  // when the workspace becomes empty. The state above is computed after the
  // async delete so a user switch during deletion is respected.
  if (postDelete.nextActiveId) {
    await activateHistorySession(postDelete.nextActiveId, targetWorkspaceId, {
      onlyIfActive: {
        workspaceId: targetWorkspaceId,
        sessionId,
      },
    });
  } else if (postDelete.shouldClearActive) {
    await historyStore.patchConfig({
      lastActiveSessionId: undefined,
    });
  }
}

function workspaceHasLiveSession(
  state: Pick<
    StoreState,
    'runningSessions' | 'aiEditingSessions' | 'chattingSessions'
  >,
  workspaceId: string,
): boolean {
  return [
    ...state.runningSessions,
    ...state.aiEditingSessions,
    ...state.chattingSessions,
  ].some((sessionKey) => sessionKey.workspaceId === workspaceId);
}

async function deleteHistoryWorkspace(workspaceId: string): Promise<void> {
  const state = useStore.getState();
  if (!state.historyReady || !workspaceId) return;
  if (workspaceHasLiveSession(state, workspaceId)) return;

  await historyStore.deleteWorkspace(workspaceId);
  const workspaces = await historyStore.listWorkspaces();
  const sessionTree = await loadSessionTree(workspaces);

  const deletingInitiallyActiveWorkspace = state.activeWorkspaceId === workspaceId;
  const nextActiveWorkspaceId = deletingInitiallyActiveWorkspace
    ? workspaces[0]?.id ?? null
    : null;
  const nextActiveSessions = nextActiveWorkspaceId
    ? sessionTree[nextActiveWorkspaceId] ?? []
    : [];
  const nextActiveSessionId = nextActiveSessions[0]?.id ?? null;
  const nextActive =
    nextActiveWorkspaceId && nextActiveSessionId
      ? { workspaceId: nextActiveWorkspaceId, sessionId: nextActiveSessionId }
      : null;

  useStore.setState((s) => {
    const deletingActiveWorkspace = s.activeWorkspaceId === workspaceId;
    const activeWorkspaceId = deletingActiveWorkspace
      ? nextActiveWorkspaceId
      : s.activeWorkspaceId;
    const activeSessions = activeWorkspaceId
      ? sessionTree[activeWorkspaceId] ?? []
      : [];
    const activeSessionId = deletingActiveWorkspace
      ? nextActiveSessionId
      : s.activeSessionId;
    // The top switcher's pinned workspace is independent of the active session.
    // Only re-point it when the pinned workspace itself is the one being deleted.
    const selectedWorkspaceId =
      s.selectedWorkspaceId === workspaceId
        ? workspaces[0]?.id ?? null
        : s.selectedWorkspaceId;

    if (!deletingActiveWorkspace) {
      return {
        workspaces,
        sessionTree,
        selectedWorkspaceId,
        sessions: s.activeWorkspaceId
          ? sessionTree[s.activeWorkspaceId] ?? s.sessions
          : s.sessions,
      };
    }

    return {
      workspaces,
      sessionTree,
      activeWorkspaceId,
      selectedWorkspaceId,
      activeSessionId,
      sessions: activeSessions,
      messages: [],
      workflow: chatWorkflow(activeSessions[0]?.title, s.locale),
      selectedNodeId: null,
      dirty: false,
      ...emptyRunProgress(),
      canvasViewport: null,
      mode: 'design' as const,
      ...composerDraftPatchForSession(s, {
        workspaceId: activeWorkspaceId,
        sessionId: activeSessionId,
      }),
    };
  });

  if (nextActive) {
    await activateHistorySession(nextActive.sessionId, nextActive.workspaceId);
  } else if (state.activeWorkspaceId === workspaceId) {
    await historyStore.patchConfig({
      lastActiveWorkspaceId: undefined,
      lastActiveSessionId: undefined,
    });
  }
}

async function renameWorkflowHistorySession(
  sessionId: string,
  workspaceId: string | null,
  name: string,
): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error('Session name is required');
  }

  const state = useStore.getState();
  const isActive =
    state.activeSessionId === sessionId &&
    state.activeWorkspaceId === workspaceId;

  if (!workspaceId || !state.historyReady) {
    const localSessions = workspaceId
      ? state.sessionTree[workspaceId] ?? state.sessions
      : state.sessions;
    const target = localSessions.find((session) =>
      sessionMatchesTarget(session, sessionId, workspaceId),
    );
    if (!target) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const shouldRenameWorkflow = target.isWorkflow;
    const liveWorkflow = shouldRenameWorkflow
      ? renameWorkflowInLiveChannels(workspaceId, sessionId, trimmed)
      : null;
    let activeWorkflow: IRGraph | null = null;
    useStore.setState((s) => {
      const update = (session: Session): Session =>
        sessionMatchesTarget(session, sessionId, workspaceId)
          ? { ...session, title: trimmed, updatedAt: Date.now() }
          : session;
      const sessionTree = workspaceId
        ? {
            ...s.sessionTree,
            [workspaceId]: (s.sessionTree[workspaceId] ?? s.sessions).map(update),
          }
        : s.sessionTree;
      activeWorkflow = isActive && shouldRenameWorkflow
        ? (liveWorkflow ?? workflowWithName(s.workflow, trimmed))
        : null;
      return {
        sessions: s.sessions.map(update),
        sessionTree,
        workflow: activeWorkflow ?? s.workflow,
      };
    });
    if (activeWorkflow) {
      const path = await autosave(activeWorkflow, useStore.getState().currentFilePath);
      if (path) useStore.getState().markSaved(path);
    }
    return;
  }

  const record = await historyStore.getSession(workspaceId, sessionId);
  if (!record) {
    throw new Error(`Session not found: ${workspaceId}/${sessionId}`);
  }

  const freshState = useStore.getState();
  const activeAfterLoad =
    freshState.activeSessionId === sessionId &&
    freshState.activeWorkspaceId === workspaceId;
  const shouldRenameWorkflow = record.isWorkflow;
  const liveWorkflow = shouldRenameWorkflow
    ? renameWorkflowInLiveChannels(workspaceId, sessionId, trimmed)
    : null;
  const baseWorkflow = shouldRenameWorkflow
    ? (liveWorkflow ??
      (activeAfterLoad ? freshState.workflow : null) ??
      record.workflow)
    : null;
  const nextWorkflow = baseWorkflow
    ? workflowWithName(baseWorkflow, trimmed)
    : undefined;
  const updated = await historyStore.updateSession(workspaceId, sessionId, {
    title: trimmed,
    ...(shouldRenameWorkflow ? { isWorkflow: true } : {}),
    ...(nextWorkflow ? { workflow: nextWorkflow } : {}),
  });
  const updatedSession = sessionFromRecord(updated);

  let stillActive = false;
  useStore.setState((s) => {
    stillActive =
      s.activeSessionId === sessionId &&
      s.activeWorkspaceId === workspaceId;
    const update = (session: Session): Session =>
      sessionMatchesTarget(session, sessionId, workspaceId)
        ? updatedSession
        : session;
    const sessionTree = s.sessionTree[workspaceId]
      ? {
          ...s.sessionTree,
          [workspaceId]: s.sessionTree[workspaceId].map(update),
        }
      : s.sessionTree;
    return {
      sessions: s.sessions.map(update),
      sessionTree,
      workflow: stillActive && nextWorkflow ? nextWorkflow : s.workflow,
    };
  });

  if (stillActive && nextWorkflow) {
    const path = await autosave(nextWorkflow, useStore.getState().currentFilePath);
    if (path) useStore.getState().markSaved(path);
  }
}

async function setWorkflowFavoriteHistorySession(
  sessionId: string,
  workspaceId: string | null,
  favorite: boolean,
): Promise<void> {
  const state = useStore.getState();
  if (!workspaceId || !state.historyReady) {
    const localSessions = workspaceId
      ? state.sessionTree[workspaceId] ?? state.sessions
      : state.sessions;
    const target = localSessions.find((session) =>
      sessionMatchesTarget(session, sessionId, workspaceId),
    );
    if (!target) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    useStore.setState((s) => {
      const update = (session: Session): Session =>
        sessionMatchesTarget(session, sessionId, workspaceId)
          ? { ...session, favorite }
          : session;
      return {
        sessions: s.sessions.map(update),
        sessionTree: workspaceId
          ? {
              ...s.sessionTree,
              [workspaceId]: (s.sessionTree[workspaceId] ?? s.sessions).map(
                update,
              ),
            }
          : s.sessionTree,
      };
    });
    return;
  }

  const record = await historyStore.getSession(workspaceId, sessionId);
  if (!record) {
    throw new Error(`Session not found: ${workspaceId}/${sessionId}`);
  }

  const updated = await historyStore.updateSession(workspaceId, sessionId, {
    meta: { favorite },
    preserveUpdatedAt: true,
  });
  const updatedSession = sessionFromRecord(updated);

  useStore.setState((s) => {
    const update = (session: Session): Session =>
      sessionMatchesTarget(session, sessionId, workspaceId)
        ? updatedSession
        : session;
    return {
      sessions: s.sessions.map(update),
      sessionTree: s.sessionTree[workspaceId]
        ? {
            ...s.sessionTree,
            [workspaceId]: s.sessionTree[workspaceId].map(update),
          }
        : s.sessionTree,
    };
  });
}

async function setWorkflowScheduledTaskHistorySession(
  sessionId: string,
  workspaceId: string | null,
  scheduledTask: ScheduledTaskConfig | null,
): Promise<void> {
  const normalizedTask = scheduledTask
    ? normalizeScheduledTask(scheduledTask)
    : undefined;
  if (scheduledTask && !normalizedTask) {
    throw new Error('Invalid scheduled task config');
  }

  const state = useStore.getState();
  if (!workspaceId || !state.historyReady) {
    const localSessions = workspaceId
      ? state.sessionTree[workspaceId] ?? state.sessions
      : state.sessions;
    const target = localSessions.find((session) =>
      sessionMatchesTarget(session, sessionId, workspaceId),
    );
    if (!target) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    useStore.setState((s) => {
      const update = (session: Session): Session => {
        if (!sessionMatchesTarget(session, sessionId, workspaceId)) {
          return session;
        }
        return normalizedTask
          ? { ...session, scheduledTask: normalizedTask }
          : { ...session, scheduledTask: undefined };
      };
      return {
        sessions: s.sessions.map(update),
        sessionTree: workspaceId
          ? {
              ...s.sessionTree,
              [workspaceId]: (s.sessionTree[workspaceId] ?? s.sessions).map(
                update,
              ),
            }
          : s.sessionTree,
      };
    });
    return;
  }

  const record = await historyStore.getSession(workspaceId, sessionId);
  if (!record) {
    throw new Error(`Session not found: ${workspaceId}/${sessionId}`);
  }

  const updated = await historyStore.updateSession(workspaceId, sessionId, {
    meta: { scheduledTask: normalizedTask ?? null },
    preserveUpdatedAt: true,
  });
  const updatedSession = sessionFromRecord(updated);

  useStore.setState((s) => {
    const update = (session: Session): Session =>
      sessionMatchesTarget(session, sessionId, workspaceId)
        ? updatedSession
        : session;
    return {
      sessions: s.sessions.map(update),
      sessionTree: s.sessionTree[workspaceId]
        ? {
            ...s.sessionTree,
            [workspaceId]: s.sessionTree[workspaceId].map(update),
          }
        : s.sessionTree,
    };
  });
}

function scheduledTaskAlertMessage(
  title: string,
  scheduledTask: ScheduledTaskConfig,
): string {
  const text = scheduledTask.reminderText.trim();
  return text ? `自动化运行提醒\n${title}\n\n${text}` : `自动化运行提醒\n${title}`;
}

function firstReusableChatInput(messages: Message[], workflow?: IRGraph): string {
  const firstMessageInput =
    messages.find((message) => message.role === 'user' && message.text.trim())
      ?.text.trim() ?? '';
  if (firstMessageInput) return firstMessageInput;
  return workflow ? startInputsFromWorkflow(workflow)[0]?.trim() ?? '' : '';
}

async function runScheduledTaskHistorySession(
  sessionId: string,
  workspaceId: string | null,
  scheduledTask: ScheduledTaskConfig,
): Promise<void> {
  const normalizedTask = normalizeScheduledTask(scheduledTask);
  if (!normalizedTask?.enabled) return;

  const state = useStore.getState();
  const targetWorkspaceId = workspaceId ?? state.activeWorkspaceId ?? null;
  const sessionKey = { workspaceId: targetWorkspaceId, sessionId };
  if (sessionLiveStatus(sessionKey, state)) return;

  const targetSessions = targetWorkspaceId
    ? sessionsForWorkspaceState(state, targetWorkspaceId)
    : state.sessions;
  const target = targetSessions.find((session) =>
    sessionMatchesTarget(session, sessionId, targetWorkspaceId),
  );
  if (!target) return;

  if (normalizedTask.remindOnRun && typeof window !== 'undefined') {
    window.alert(scheduledTaskAlertMessage(target.title, normalizedTask));
  }

  await activateHistorySession(sessionId, targetWorkspaceId ?? undefined);
  const current = useStore.getState();
  if (
    current.activeSessionId !== sessionId ||
    (targetWorkspaceId !== null && current.activeWorkspaceId !== targetWorkspaceId)
  ) {
    return;
  }
  if (
    sessionLiveStatus(
      { workspaceId: current.activeWorkspaceId ?? null, sessionId },
      current,
    )
  ) {
    return;
  }

  if (current.workflow.meta?.simple === true || target.isWorkflow === false) {
    const reusableInput = target.favorite
      ? firstReusableChatInput(current.messages, current.workflow)
      : '';
    current.sendPrompt(reusableInput || normalizedTask.reminderText);
    return;
  }
  current.runWorkflow();
}

async function activateWorkspacePath(path: string): Promise<void> {
  const trimmed = normalizeWorkspacePath(path);
  if (!trimmed) return;
  const navigationVersion = beginHistoryNavigation();
  const state = useStore.getState();
  if (!state.historyReady) return;

  const workspace = await historyStore.resolveWorkspaceByPath(trimmed);
  if (!isLatestHistoryNavigation(navigationVersion)) return;
  let sessions = visibleChatSessionSummaries(
    await historyStore.listSessions(workspace.id),
  );
  if (!isLatestHistoryNavigation(navigationVersion)) return;
  let active = sessions[0];
  if (!active) {
    const record = await historyStore.createSession({
      workspaceId: workspace.id,
      isWorkflow: false,
      messages: [],
    });
    if (!isLatestHistoryNavigation(navigationVersion)) return;
    active = summaryFromRecord(record);
    sessions = [summaryFromRecord(record), ...sessions];
  }

  const workspaces = await historyStore.listWorkspaces();
  if (!isLatestHistoryNavigation(navigationVersion)) return;
  const sessionTree = await loadSessionTree(workspaces);
  if (!isLatestHistoryNavigation(navigationVersion)) return;
  const activeRecord = active
    ? await historyStore.getSession(workspace.id, active.id)
    : null;
  if (!isLatestHistoryNavigation(navigationVersion)) return;
  const activeRecordIsSimpleChat =
    activeRecord?.workflow?.meta?.simple === true;
  const workflow =
    activeRecordIsSimpleChat && activeRecord?.workflow
      ? restoreWorkflowRunSnapshot(activeRecord.workflow, activeRecord.meta)
      : chatWorkflow(activeRecord?.title, state.locale);
  const runProgress = activeRecordIsSimpleChat
    ? runProgressFromSnapshot(workflow, workflow.meta.run ?? null)
    : emptyRunProgress();
  const canvasViewport = canvasViewportForSession(
    workspace.id,
    active?.id ?? '',
    activeRecord?.meta,
  );
  useStore.setState((s) => {
    if (!isLatestHistoryNavigation(navigationVersion)) return s;
    const sessionKey = {
      workspaceId: workspace.id,
      sessionId: active?.id ?? null,
    };
    const composerPatch = composerPatchForSession(
      s,
      sessionKey,
      workflow,
      defaultSessionComposer(
        trimmed,
        workspaceFoldersFromMetadata(workspace.metadata),
      ),
    );
    const workspaceHistory = workspaceHistoryWithRecent(
      trimmed,
      s.workspaceHistory,
      WORKSPACE_HISTORY_LIMIT,
    );
    saveComposerSoon({
      composer: composerPatch.composer,
      composerBySession: composerPatch.composerBySession,
      workspaceHistory,
    });
    return {
      workspaces,
      activeWorkspaceId: workspace.id,
      selectedWorkspaceId: workspace.id,
      sessions: sessions.map((item) => sessionFromSummary(item)),
      sessionTree,
      activeSessionId: active?.id ?? null,
      messages: activeRecord?.messages ?? [],
      workflow: composerPatch.workflow,
      composer: composerPatch.composer,
      composerBySession: composerPatch.composerBySession,
      workspaceHistory,
      ...runProgress,
      canvasViewport: activeRecordIsSimpleChat ? canvasViewport : null,
      mode: 'design',
      ...composerDraftPatchForSession(s, sessionKey),
    };
  });
  if (!isLatestHistoryNavigation(navigationVersion)) return;
  const current = useStore.getState();
  if (
    current.activeWorkspaceId !== workspace.id ||
    current.activeSessionId !== (active?.id ?? null)
  ) {
    return;
  }
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
    let sessions = visibleChatSessionSummaries(
      await historyStore.listSessions(workspace.id),
    );
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
      sessions = [summaryFromRecord(created), ...sessions];
      workspaces = await historyStore.listWorkspaces();
    }
    const sessionTree = await loadSessionTree(workspaces);
    const activeRecord = active
      ? await historyStore.getSession(workspace.id, active.id)
      : null;
    const currentState = useStore.getState();
    const activeRecordIsSimpleChat =
      activeRecord?.workflow?.meta?.simple === true;
    const workflow =
      activeRecordIsSimpleChat && activeRecord?.workflow
        ? restoreWorkflowRunSnapshot(activeRecord.workflow, activeRecord.meta)
        : chatWorkflow(activeRecord?.title, currentState.locale);
    const runProgress = activeRecordIsSimpleChat
      ? runProgressFromSnapshot(workflow, workflow.meta.run ?? null)
      : emptyRunProgress();
    const canvasViewport = canvasViewportForSession(
      workspace.id,
      active?.id ?? '',
      activeRecord?.meta,
    );

    useStore.setState((s) => {
      const sessionKey = {
        workspaceId: workspace.id,
        sessionId: active?.id ?? null,
      };
      const composerPatch = composerPatchForSession(
        s,
        sessionKey,
        workflow,
        {
          ...s.composer,
          workspace: workspace.path || s.composer.workspace,
          workspaceFolders: workspaceFoldersFromMetadata(workspace.metadata),
        },
      );
      return {
        historyReady: true,
        historyError: null,
        historyRootPath: rootPath,
        workspaces,
        activeWorkspaceId: workspace.id,
        selectedWorkspaceId: workspace.id,
        sessions: sessions.map((item) => sessionFromSummary(item)),
        sessionTree,
        activeSessionId: active?.id ?? null,
        messages: activeRecord?.messages ?? [],
        workflow: composerPatch.workflow,
        composer: composerPatch.composer,
        composerBySession: composerPatch.composerBySession,
        ...runProgress,
        canvasViewport: activeRecordIsSimpleChat ? canvasViewport : null,
        mode: 'design',
        ...composerDraftPatchForSession(s, sessionKey),
      };
    });
    void maybeRunCcSwitchAutoImportOnFirstRun();
    await historyStore.patchConfig({
      schemaVersion: HISTORY_SCHEMA_VERSION,
      lastActiveWorkspaceId: workspace.id,
      lastActiveSessionId: active?.id,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[history-init] failed to load history', err);
    useStore.setState({
      historyReady: true,
      historyError: message || 'Unknown history initialization error',
      historyRootPath: null,
      workspaces: [],
      activeWorkspaceId: null,
      selectedWorkspaceId: null,
      sessions: [],
      sessionTree: {},
      activeSessionId: null,
      messages: [],
    });
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

function workflowWithName(workflow: IRGraph, name: string): IRGraph {
  return { ...workflow, meta: { ...workflow.meta, name } };
}

function sessionMatchesTarget(
  session: Session,
  sessionId: string,
  workspaceId: string | null,
): boolean {
  if (session.id !== sessionId) return false;
  if (
    workspaceId !== null &&
    session.workspaceId !== undefined &&
    session.workspaceId !== workspaceId
  ) {
    return false;
  }
  return true;
}

function liveWorkflowForSession(
  workspaceId: string | null,
  sessionId: string | null,
): IRGraph | null {
  const run = getRunChannel(workspaceId, sessionId);
  if (run) return run.workflow;

  const aiEdit = getAiEditChannel(workspaceId, sessionId);
  if (aiEdit) return aiEdit.workflow;

  return getAiEditSnapshot(workspaceId, sessionId)?.workflow ?? null;
}

function renameWorkflowInLiveChannels(
  workspaceId: string | null,
  sessionId: string,
  name: string,
): IRGraph | null {
  let workflow: IRGraph | null = null;
  const run = getRunChannel(workspaceId, sessionId);
  if (run) {
    run.workflow = workflowWithName(run.workflow, name);
    workflow = run.workflow;
  }

  const aiEdit = getAiEditChannel(workspaceId, sessionId);
  if (aiEdit) {
    aiEdit.workflow = workflowWithName(aiEdit.workflow, name);
    rememberAiEditSnapshot(aiEdit);
    workflow = aiEdit.workflow;
  } else {
    const snapshot = getAiEditSnapshot(workspaceId, sessionId);
    if (snapshot) {
      const nextSnapshot = {
        ...snapshot,
        workflow: workflowWithName(snapshot.workflow, name),
        messages: [...snapshot.messages],
      };
      aiEditSnapshots.set(snapshot.key, nextSnapshot);
      workflow = nextSnapshot.workflow;
    }
  }

  return workflow;
}

// Restore persisted composer settings + workspace history (if any). Normalize a
// stale model id (e.g. an old fake option) back to the default so the real
// Anthropic call always gets a valid model.
const persisted = loadComposer();
const seedComposer: ComposerSettings = (() => {
  const c = persisted?.composer ?? defaultComposer;
  // Backfill fields for legacy persisted composers that predate them.
  const withStrategy = normalizeComposerSettings(c);
  const valid = modelOptions.some((o) => o.id === withStrategy.model);
  return valid ? withStrategy : { ...withStrategy, model: defaultComposer.model };
})();
const seedLocale = loadLocale();
const seedPromptAutoTranslate = loadPromptAutoTranslate();
const seedGameExpertSettings = loadGameExpertSettings();
const seedAppearance = loadAppearance();

// Cold-start directly into the plain chat surface. Hidden workflow snapshots
// remain on disk, but they are no longer restored into the user-facing UI.
const seedWorkflow = migrateWorkflowGateway(
  simpleBlueprint(undefined, seedLocale),
  defaultComposer.model,
);
const seedPersonalInstructionsSelection = workflowDefaultGatewaySelection(
  seedWorkflow,
  seedComposer.model,
);
const seedPersonalInstructionsSelections = [
  seedPersonalInstructionsSelection,
  ...listGatewayRunOptions().map((option) => option.selection),
];
const seedPersonalInstructionsByModel = loadPersonalInstructionsByModel(
  seedPersonalInstructionsSelection,
  seedPersonalInstructionsSelections,
);
const seedPersonalInstructions = personalInstructionsForSelection(
  seedPersonalInstructionsByModel,
  seedPersonalInstructionsSelection,
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

export const useStore = create<StoreState>((set, get) => ({
  // Seed graph: restored autosave, or a fresh default blueprint.
  workflow: seedWorkflowState,
  selectedNodeId: null,
  graphPath: [],

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
  chattingSessions: [],
  blockedSendTip: null,

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
  personalInstructionsByModel: seedPersonalInstructionsByModel,
  personalInstructions: seedPersonalInstructions,
  gameExpertSettings: seedGameExpertSettings,
  appearance: seedAppearance,

  // Composer settings seeded from the sample option lists, overlaid with any
  // persisted selections.
  composer: seedComposer,
  composerBySession: persisted?.composerBySession ?? {},
  composerDraft: '',
  composerDrafts: {},
  composerFocusVersion: 0,
  permissionOptions,
  modelOptions,
  workspaceHistory: uniqueWorkspaceHistory(
    persisted?.workspaceHistory ?? [],
    WORKSPACE_HISTORY_LIMIT,
  ),
  historyReady: false,
  historyError: null,
  historyRootPath: null,
  workspaces: [],
  sessionTree: {},
  activeWorkspaceId: null,
  selectedWorkspaceId: null,
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
  setPersonalInstructions: (instructions, selection) => {
    set((state) => {
      const targetSelection = selection
        ? normalizeGatewaySelection(selection)
        : personalInstructionsSelectionForState(state);
      const personalInstructionsByModel = withPersonalInstructionsForSelection(
        state.personalInstructionsByModel,
        targetSelection,
        instructions,
      );
      savePersonalInstructionsByModel(personalInstructionsByModel);
      return {
        personalInstructionsByModel,
        personalInstructions: activePersonalInstructionsForState({
          ...state,
          personalInstructionsByModel,
        }),
      };
    });
  },

  setGameExpertSettings: (patch) => {
    set((state) => {
      const gameExpertSettings = normalizeGameExpertSettings({
        ...state.gameExpertSettings,
        ...patch,
      });
      saveGameExpertSettings(gameExpertSettings);
      return { gameExpertSettings };
    });
  },

  setStylePresetId: (stylePresetId) => {
    const appearance: AppearanceSettings = normalizeAppearanceSettings({
      ...get().appearance,
      stylePresetId,
      streamSchemeId: streamSchemeForStylePresetId(stylePresetId),
    });
    set({ appearance });
    saveAppearance(appearance);
    applyAppearance(appearance);
  },

  setStreamSchemeId: (streamSchemeId) => {
    const current = get().appearance;
    const appearance: AppearanceSettings = normalizeAppearanceSettings({
      ...current,
      stylePresetId: isBuiltinStylePresetId(streamSchemeId)
        ? streamSchemeId
        : current.stylePresetId,
      streamSchemeId,
    });
    set({ appearance });
    saveAppearance(appearance);
    applyAppearance(appearance);
  },

  setFontFamilyId: (fontFamilyId) => {
    const appearance: AppearanceSettings = normalizeAppearanceSettings({
      ...get().appearance,
      fontFamilyId,
    });
    set({ appearance });
    saveAppearance(appearance);
    applyAppearance(appearance);
  },

  setFontSizePx: (fontSizePx) => {
    const appearance: AppearanceSettings = normalizeAppearanceSettings({
      ...get().appearance,
      fontSizePx,
    });
    set({ appearance });
    saveAppearance(appearance);
    applyAppearance(appearance);
  },

  selectNode: (id) => set({ selectedNodeId: id }),

  // Composite drill-down navigation. These only touch the UI-transient
  // graphPath + selection; they never read or mutate `workflow`.
  enterComposite: (nodeId) =>
    set((state) => {
      const node = state.workflow.nodes.find((n) => n.id === nodeId);
      if (!node) return state;
      const label = node.label?.trim() || node.id;
      return {
        graphPath: [...state.graphPath, { nodeId, label }],
        selectedNodeId: null,
      };
    }),
  exitComposite: () =>
    set((state) =>
      state.graphPath.length === 0
        ? state
        : { graphPath: state.graphPath.slice(0, -1), selectedNodeId: null },
    ),
  popToGraph: (depth) =>
    set((state) => {
      const clamped = Math.max(0, Math.min(depth, state.graphPath.length));
      if (clamped === state.graphPath.length) {
        return { selectedNodeId: null };
      }
      return {
        graphPath: state.graphPath.slice(0, clamped),
        selectedNodeId: null,
      };
    }),

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

  // Export the current workflow IR to a user-chosen .fuc.json file. The run
  // snapshot is stripped (see persist.ts) so the file is a clean, shareable
  // blueprint. Export does not touch currentFilePath — it's a "save a copy".
  exportWorkflow: (title) => {
    const { workflow } = useStore.getState();
    void exportWorkflowToFile(workflow, title).catch(() => {});
  },

  exportWorkflowSession: (sessionId, workspaceId, title) => {
    void exportWorkflowHistorySession(sessionId, workspaceId, title).catch(
      () => {},
    );
  },

  // Import a workflow from a file and open it as a fresh session. Invalid /
  // cancelled picks are no-ops so the current canvas is never clobbered.
  importWorkflow: (title) => {
    void importWorkflowFromFile(title)
      .then((result) => {
        if (result) {
          void openWorkflowInSession(result.ir, result.path ?? undefined, {
            forceNewSession: true,
          });
        }
      })
      .catch(() => {});
  },

  importWorkflowToWorkspace: (workspaceId, title) => {
    void importWorkflowIntoWorkspace(workspaceId, title).catch(() => {});
  },

  // Switch the target runtime adapter (Claude Code / Codex / Gemini). The
  // adapter lives in the IR meta so the emitter can target the right runtime.
  setAdapter: (adapter) => {
    const selection = systemDefaultGatewaySelection(adapter);
    applyWorkflowEdit('user', (state) => ({
      workflow: workflowWithoutRunSnapshot(
        withSessionGatewayDefaults(
          state.workflow,
          selection,
        ),
      ),
      personalInstructions: personalInstructionsForSelection(
        state.personalInstructionsByModel,
        selection,
      ),
      ...emptyRunProgress(),
    }));
  },

  setGlobalRunSelection: (selection) => {
    set((state) => {
      if (isWorkflowReadOnly(state)) return state;
      const normalized = normalizeGatewaySelection(selection);
      setActiveGatewaySelection(normalized);
      const workflow = workflowWithoutRunSnapshot(
        withSessionGatewayDefaults(state.workflow, normalized),
      );
      const snapshot: SessionComposerSettings = {
        composer: state.composer,
        gatewaySelection: normalized,
      };
      const composerBySession = rememberSessionComposer(
        { ...state, workflow },
        state.composerBySession,
        snapshot,
      );
      saveComposerSoon({
        composer: state.composer,
        composerBySession,
        workspaceHistory: state.workspaceHistory,
      });
      return {
        workflow,
        composerBySession,
        personalInstructions: personalInstructionsForSelection(
          state.personalInstructionsByModel,
          normalized,
        ),
        ...emptyRunProgress(),
      };
    });
  },

  setSessionRunSelection: (selection) => {
    set((state) => {
      if (isWorkflowReadOnly(state)) return state;
      const normalized = normalizeGatewaySelection(selection);
      const workflow = workflowWithoutRunSnapshot(
        withSessionGatewayDefaults(state.workflow, normalized),
      );
      const snapshot: SessionComposerSettings = {
        composer: state.composer,
        gatewaySelection: normalized,
      };
      const composerBySession = rememberSessionComposer(
        { ...state, workflow },
        state.composerBySession,
        snapshot,
      );
      saveComposerSoon({
        composer: state.composer,
        composerBySession,
        workspaceHistory: state.workspaceHistory,
      });
      return {
        workflow,
        composerBySession,
        personalInstructions: personalInstructionsForSelection(
          state.personalInstructionsByModel,
          normalized,
        ),
        ...emptyRunProgress(),
      };
    });
  },

  clearGlobalRunSelection: () => {
    clearActiveGatewaySelection();
    set((state) => {
      if (isWorkflowReadOnly(state)) return state;
      const selection = systemDefaultGatewaySelection(
        state.workflow.meta.adapter ?? 'claude-code',
      );
      const workflow = workflowWithoutRunSnapshot(
        withSessionGatewayDefaults(state.workflow, selection),
      );
      const snapshot: SessionComposerSettings = {
        composer: state.composer,
        gatewaySelection: selection,
      };
      const composerBySession = rememberSessionComposer(
        { ...state, workflow },
        state.composerBySession,
        snapshot,
      );
      saveComposerSoon({
        composer: state.composer,
        composerBySession,
        workspaceHistory: state.workspaceHistory,
      });
      return {
        workflow,
        composerBySession,
        personalInstructions: personalInstructionsForSelection(
          state.personalInstructionsByModel,
          selection,
        ),
        ...emptyRunProgress(),
      };
    });
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

  stopChat: () => stopActiveChat(),

  // [dynamic-only refactor] 蓝图创建动作已停用（newWorkflow/newCaptainWorkflow）。
  // GUI 不再提供可视化蓝图入口；保留空实现以满足 StoreState 契约与类型。
  // newSimpleWorkflow 仍可用：simpleBlueprint 是聊天会话底层结构（保留模块）。
  // Load a fresh starter graph (start → agent → end), clean and in design mode.
  newWorkflow: () => {
    /* disabled: blueprint authoring removed */
  },

  // Load a minimal single-node starter graph (one agent, no sentinels).
  newSimpleWorkflow: () =>
    void createNewWorkflowSession(simpleBlueprint),

  // Load the captain-loop starter graph (目标冻结 → 队长拆单 → 并行 worker →
  // 验收门 → 汇总) for complex, decomposable, high-stakes long tasks.
  newCaptainWorkflow: () => {
    /* [dynamic-only refactor] disabled: captainBlueprint authoring removed */
  },

  newSession: () => {
    void createNewChatSession();
  },

  selectSession: (sessionId, workspaceId) => {
    void activateHistorySession(sessionId, workspaceId);
  },

  deleteSession: (sessionId, workspaceId) => {
    void deleteHistorySession(sessionId, workspaceId);
  },

  deleteWorkspaceHistory: (workspaceId) => {
    void deleteHistoryWorkspace(workspaceId);
  },

  renameWorkflowSession: (sessionId, workspaceId, name) =>
    renameWorkflowHistorySession(sessionId, workspaceId, name),

  setWorkflowFavoriteSession: (sessionId, workspaceId, favorite) =>
    setWorkflowFavoriteHistorySession(sessionId, workspaceId, favorite),

  setWorkflowScheduledTaskSession: (sessionId, workspaceId, scheduledTask) =>
    setWorkflowScheduledTaskHistorySession(sessionId, workspaceId, scheduledTask),

  runScheduledTaskSession: (sessionId, workspaceId, scheduledTask) =>
    runScheduledTaskHistorySession(sessionId, workspaceId, scheduledTask),

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
  runUltracodePrompt: (task) => {
    const trimmed = task.trim();
    if (!trimmed) return;
    const parsed = parseUltracodePrompt(trimmed);
    const request =
      parsed.request ||
      (parsed.options.resume ? '续跑 /ultracode 任务' : trimmed);
    const modeLabel = ultracodeModeLabel(parsed.options);
    const state = useStore.getState();
    if (state.mode === 'running') return;
    const sessionKey = activeWorkflowSessionKey(state);
    if (hasSessionKey(state.chattingSessions, sessionKey)) return;
    if (state.blockedSendTip) set({ blockedSendTip: null });
    const workspaceRootPath = sessionChangesRootPathForSession(state, sessionKey);
    const changesBaselineReady = ensureSessionChangeBaselineForKey(
      state,
      sessionKey,
      workspaceRootPath,
    );

    const now = Date.now();
    const userMsg: Message = {
      id: shortId('m'),
      role: 'user',
      text: `/ultracode ${trimmed}`,
      createdAt: now,
    };
    const assistantId = shortId('m');
    const assistantMsg: Message = {
      id: assistantId,
      role: 'assistant',
      text:
        modeLabel === 'planner-only'
          ? `⟳ /ultracode 正在生成动态 harness 计划…`
          : `⟳ /ultracode 正在生成动态 harness 并执行…`,
      routeLabel: '/ultracode',
      createdAt: now + 1,
    };
    const promptUpdate = applyPromptTitle(state, request, now);
    const chKey = chatTurnKey(runKey(sessionKey.workspaceId, sessionKey.sessionId), userMsg.id);
    const ch: AiEditChannel = {
      key: chKey,
      sessionKey: runKey(sessionKey.workspaceId, sessionKey.sessionId),
      workspaceId: sessionKey.workspaceId,
      sessionId: sessionKey.sessionId,
      workspaceRootPath,
      workflow: promptUpdate.workflow,
      messages: [...state.messages, userMsg, assistantMsg],
      cliRunIds: new Set<string>(),
      abortController: new AbortController(),
      gatewaySelection: workflowDefaultGatewaySelection(
        promptUpdate.workflow,
        state.composer.model,
      ),
      workflowSession: false,
      chat: true,
      ownedMessageIds: new Set<string>([userMsg.id, assistantId]),
    };

    const replaceAssistant = (
      text: string,
      persist = false,
      runProgress?: UltracodeRunProgress,
    ) => {
      if (!aiEditRegistered(ch)) return;
      ch.messages = ch.messages.map((msg) =>
        msg.id === assistantId
          ? {
              ...msg,
              text,
              routeLabel: '/ultracode',
              ...(runProgress ? { runProgress } : {}),
            }
          : msg,
      );
      aiEditCommitMessages(ch, persist);
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
    syncAndPersistSessionRunStatus(sessionKey, 'running');
    if (ch.workspaceId && ch.sessionId) {
      void historyStore
        .updateSession(ch.workspaceId, ch.sessionId, {
          messages: ch.messages,
          meta: { runStatus: 'running' },
        })
        .catch(() => {});
    }

    void (async () => {
      const startedAt = Date.now();
      const runId = parsed.options.runId || makeCliRunId();
      ch.cliRunIds.add(runId);
      let live = '';
      // Live run-progress snapshot, folded from the CLI's <<FUC_PROGRESS>>
      // sentinels (decoded out of the streamed stderr) so the GUI can render a
      // run-progress card above the log text. Seeded with the wall-clock start.
      let progress: UltracodeRunProgress = { ...emptyProgress(), startedAt };
      let concurrencyForDisplay = parsed.options.concurrency ?? runConcurrency();
      const ultracodeWorkspacePaths = composerWorkspacePaths(state.composer);
      const workspaceSummary =
        ultracodeWorkspacePaths.length > 0
          ? `工作区: ${ultracodeWorkspacePaths[0]}${
              ultracodeWorkspacePaths.length > 1
                ? ` +${ultracodeWorkspacePaths.length - 1}`
                : ''
            }`
          : '工作区: 默认';
      const composeLiveText = () =>
        [
          `⟳ /ultracode 执行中…`,
          `runId: ${runId}`,
          workspaceSummary,
          `模式: ${modeLabel}`,
          `并发: ${concurrencyForDisplay}`,
          '',
          live.trim(),
        ].join('\n');
      try {
        await changesBaselineReady;
        const gatewaySelection = ch.gatewaySelection;
        if (gatewaySelection && isFreeChannelSelection(gatewaySelection)) {
          await ensureFreeProxy(freeProxyOptionsForSelection(gatewaySelection));
        }
        const concurrency = parsed.options.concurrency ?? runConcurrency();
        concurrencyForDisplay = concurrency;
        const result = await runUltracode(request, {
          ...aiEditCliWorkspaceOptions(ch, state.composer),
          adapter: gatewaySelection?.adapter,
          model:
            gatewaySelection?.modelOverride ||
            gatewaySelection?.modelClass,
          provider: gatewaySelection?.providerId,
          concurrency,
          maxRetries: parsed.options.maxRetries ?? runMaxRetries(),
          maxAgentCalls: parsed.options.maxAgentCalls,
          maxRounds: parsed.options.maxRounds,
          timeoutSeconds: parsed.options.timeoutSeconds,
          runId,
          resume: parsed.options.resume,
          plannerOnly: parsed.options.plannerOnly,
          fromHarness: parsed.options.fromHarness,
          trace: parsed.options.trace,
          interactive: parsed.options.interactive,
          onProgress: (chunk) => {
            // Pull structured progress sentinels out of the chunk; the cleaned
            // remainder (the human-readable log lines) stays in the stream. A
            // sentinel-only stderr line leaves a dangling "[stderr] " prefix —
            // drop those orphan tokens so the log doesn't sprout blank rows.
            const { text: cleaned, events } = decodeProgressEvents(chunk);
            const visible = cleaned.replace(
              /\n[ \t]*\[(?:stderr|stdout)\][ \t]*(?=\n|$)/g,
              '',
            );
            live = (live + visible).slice(-5000);
            if (events.length > 0) progress = reduceProgress(progress, events);
            replaceAssistant(composeLiveText(), false, progress);
          },
        });
        if (!aiEditRegistered(ch)) return;
        progress = {
          ...progress,
          phase: ultracodeAccepted(result) ? 'complete' : 'error',
          endedAt: Date.now(),
        };
        replaceAssistant(
          `⏱ ${formatClock(startedAt)} → ${formatClock(Date.now())} · 耗时 ${formatDuration(Date.now() - startedAt)}\n${summarizeUltracodeResult(result)}`,
          true,
          progress,
        );
        syncAndPersistSessionRunStatus(
          sessionKey,
          ultracodeAccepted(result) ? 'success' : 'error',
        );
      } catch (err) {
        if (!aiEditRegistered(ch)) return;
        const msg = (err as Error)?.message ?? String(err);
        progress = { ...progress, phase: 'error', endedAt: Date.now() };
        replaceAssistant(
          `⏱ ${formatClock(startedAt)} → ${formatClock(Date.now())} · 耗时 ${formatDuration(Date.now() - startedAt)} · 失败\n✗ /ultracode 调用失败: ${msg}`,
          true,
          progress,
        );
        syncAndPersistSessionRunStatus(sessionKey, 'error');
      } finally {
        ch.cliRunIds.delete(runId);
        removeAiEditChannel(ch);
      }
    })();
  },

  generateImagePrompt: (text, options = {}) => {
    startImageGenerationTurn(text, options);
  },

  generateMusicPrompt: (text, options = {}) => {
    startMusicGenerationTurn(text, options);
  },

  generateThreeDPrompt: (text, options = {}) => {
    startThreeDGenerationTurn(text, options);
  },

  searchMeshLibraryPrompt: (text) => {
    startMeshSearchTurn(text);
  },

  appendChatNote: (text, role = 'assistant') => {
    const msg: Message = {
      id: shortId('m'),
      role,
      text,
      createdAt: Date.now(),
    };
    set((state) => ({ messages: [...state.messages, msg] }));
    void persistMessage(msg);
    return msg.id;
  },

  deleteMessage: (messageId) => {
    const current = useStore.getState();
    const sessionKey = activeWorkflowSessionKey(current);
    const deleteIds = deletionIdsForAssistantTurn(
      current.messages,
      messageId,
      sessionKey,
    );
    if (deleteIds.size === 0) return;
    let nextMessages: Message[] | null = null;
    let nextWorkflow: IRGraph | null = null;
    let persistWorkflow = false;
    set((state) => {
      const messages = removeMessagesById(state.messages, deleteIds);
      if (messages.length === state.messages.length) return state;
      const workflow = simpleWorkflowFromMessages(state.workflow, messages);
      const activeSession = sessionForKey(state, activeWorkflowSessionKey(state));
      nextMessages = messages;
      nextWorkflow = workflow;
      persistWorkflow = activeSession?.isWorkflow === true;
      return {
        messages,
        workflow,
        ...activeMessageSummaryPatch(state, messages),
      };
    });
    if (!nextMessages) return;
    pruneAiEditSourcesForDeletion(
      sessionKey.workspaceId,
      sessionKey.sessionId,
      deleteIds,
    );
    void persistCurrentConversation(
      nextMessages,
      persistWorkflow ? nextWorkflow ?? undefined : undefined,
    );
  },

  branchSessionFromMessage: (messageId) => {
    void branchChatSessionFromMessage(messageId);
  },

  sendPrompt: (text, options) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    // Game experts / producer orchestration are now explicit-only: they never
    // auto-fire from chat text. The host opts in by passing forceGameExperts
    // (wired to the multilingual `/game` slash command in AIDock). When the
    // user drilled into specific experts via a hierarchical path (e.g.
    // /游戏专家/编程/引擎程序 or /引擎程序), gameExpertIds pins exactly those.
    const forceGameExperts = options?.forceGameExperts === true;
    const pinnedGameExpertIds = options?.gameExpertIds ?? [];
    const state = useStore.getState();
    if (isWorkflowReadOnly(state)) return;
    // Image generation is routed explicitly (the /image-mode-* sticky mode and
    // /image one-shot command in AIDock), never inferred from message text here.
    // sendPrompt always means AI editing / workflow authoring.
    const aiEditingSession = activeWorkflowSessionKey(state);
    const gatewaySelection = workflowDefaultGatewaySelection(
      state.workflow,
      state.composer.model,
    );
    const activeChatAppend =
      state.workflow.meta?.simple === true
        ? appendPromptToActiveSimpleChat(
            aiEditingSession,
            gatewaySelection,
            trimmed,
          )
        : 'none';
    if (activeChatAppend === 'selection-mismatch') {
      set({ blockedSendTip: 'model-switched-while-chatting' });
      return;
    }
    if (activeChatAppend === 'appended') {
      if (state.blockedSendTip) set({ blockedSendTip: null });
      return;
    }
    if (state.blockedSendTip) set({ blockedSendTip: null });
    const workspaceRootPath = sessionChangesRootPathForSession(
      state,
      aiEditingSession,
    );
    const changesBaselineReady = ensureSessionChangeBaselineForKey(
      state,
      aiEditingSession,
      workspaceRootPath,
    );
    const capturedStartInputs: string[] = [trimmed];
    // Accumulates how the blueprint was produced (research / candidates /
    // escalation). Each generation phase writes into it; stamped onto the Start
    // node by withCapturedStartInputs at every commit. Empty ⇒ no-op.
    const provenance: GenProvenance = {};

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
    const activeSession = sessionForKey(state, aiEditingSession);
    const simpleMode = promptUpdate.workflow.meta?.simple === true;
    const replayFavoriteSimpleChat =
      simpleMode && activeSession?.favorite === true;
    const baseMessages = replayFavoriteSimpleChat ? [] : state.messages;
    const channelWorkflow = replayFavoriteSimpleChat
      ? setStartUserInputs(promptUpdate.workflow, [])
      : promptUpdate.workflow;
    const workflowSession =
      activeSession?.isWorkflow ?? !simpleMode;
    const chSessionKey = runKey(
      aiEditingSession.workspaceId,
      aiEditingSession.sessionId,
    );
    const chatMode = simpleMode;
    const ch: AiEditChannel = {
      key: chatMode ? chatTurnKey(chSessionKey, userMsg.id) : chSessionKey,
      sessionKey: chSessionKey,
      workspaceId: aiEditingSession.workspaceId,
      sessionId: aiEditingSession.sessionId,
      workspaceRootPath,
      workflow: channelWorkflow,
      messages: [...baseMessages, userMsg],
      cliRunIds: new Set<string>(),
      abortController: new AbortController(),
      gatewaySelection,
      workflowSession,
      ...(chatMode
        ? { chat: true, ownedMessageIds: new Set<string>([userMsg.id]) }
        : {}),
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
      if (replayFavoriteSimpleChat) {
        void historyStore
          .updateSession(ch.workspaceId, ch.sessionId, {
            messages: ch.messages,
            ...(ch.workflowSession ? { workflow: ch.workflow } : {}),
            meta: emptyRunMeta(),
          })
          .catch(() => {});
      } else {
        void historyStore
          .appendMessage(ch.workspaceId, ch.sessionId, userMsg)
          .catch(() => {});
      }
    }

    const ir = ch.workflow;
    // Simple-workflow mode: the AI dock is a plain CLI/chat. The user's input
    // goes straight to the model (no blueprint generation), and each input is
    // appended to the lone start node's userInputs so the node mirrors the
    // conversation. The graph stays a single node.
    const directRoute = resolveDirectGatewayRoute(gatewaySelection);
    const inTauri = isTauri();
    const projectMcpGuidance = projectMcpGuidanceForState(state, aiEditingSession);
    const preferCliForProjectMcp = inTauri && !!projectMcpGuidance;
    const useApi = !!directRoute && !preferCliForProjectMcp;
    const useCli = (!useApi && inTauri) || preferCliForProjectMcp;

    const pushAssistant = (txt: string, routeLabel?: string) => {
      const msg: Message = {
        id: shortId('m'),
        role: 'assistant',
        text: txt,
        ...(routeLabel ? { routeLabel } : {}),
        createdAt: Date.now(),
      };
      ch.ownedMessageIds?.add(msg.id);
      ch.messages = [...ch.messages, msg];
      aiEditCommitMessages(ch, true);
    };

    // [dynamic-only refactor] 以下三个蓝图编辑辅助原从 @/core/genPrompt 导入(该模块已停用)。
    // 它们仅被本函数下方"非简单模式"蓝图生成分支使用——该分支在纯聊天 GUI 下已不可达，
    // 但仍需编译。保留为本地内联副本（与 genPrompt 原实现等价），以便日后整体恢复。
    const BLUEPRINT_DIRECT_EDIT_CONTRACT = `---
普通 AI 输入框编辑规则：
- 默认目标是把用户需求写入 workflow 蓝图，而不是生成 Markdown 计划或让用户确认后再做。
- 必须基于当前 IRGraph 输出“简短中文说明 + 一个完整 \`\`\`json IRGraph 代码块”。
- 不要输出交互块，不要提问，不要等待批准，不要创建/修改本地文件。
- 如果需求提到“规划代码修改/支持某功能/实现某能力”，把它转成 workflow 节点：例如需求理解、代码定位、实现、验证、回归检查、总结等步骤。
- 信息不足时自行做保守假设，并把需要后续确认的事项放进蓝图中的澄清/验证节点。
- 蓝图规模要和任务复杂度匹配：简单需求优先最小充分结构，复杂需求才展开更多步骤、分支和验证。`;
    const replyIncludesIRGraph = (text: string): boolean => {
      try {
        const parsed = JSON.parse(extractJsonObject(text)) as Partial<IRGraph>;
        return Array.isArray(parsed.nodes) && Array.isArray(parsed.edges);
      } catch {
        return false;
      }
    };
    const strictBlueprintRetryAppendix = (previousReply: string): string =>
      `\n\n---
上一轮输出没有包含可解析的 workflow IRGraph，因此不能写入蓝图。上一轮输出节选如下：
${previousReply.slice(0, 4000)}

请忽略上一轮的 Markdown/计划/确认请求，直接基于最初的用户需求和当前 IRGraph 返回：
1) 简短中文说明。
2) 一个完整、可解析、可直接写入蓝图的 \`\`\`json IRGraph 代码块。
不得创建或修改本地文件，不得等待用户批准。`;

    // No API key and no desktop CLI: local keyword fallback.
    if (!useApi && !useCli) {
      if (simpleMode) {
        // Simple mode is a direct model chat — there's no local fallback.
        pushAssistant(
          '简单模式需要可用的模型后端：请在桌面版配置本地 CLI，或切到 Claude Code 并配置 API key 后再试。',
        );
        syncAndPersistSessionRunStatus(
          { workspaceId: ch.workspaceId, sessionId: ch.sessionId },
          'error',
        );
        removeAiEditChannel(ch);
        return;
      }
      // [dynamic-only refactor] 本地意图引擎(applyIntent)蓝图编辑已停用。
      // 非简单模式 + 无后端：仅提示，不再做关键词改图。
      pushAssistant(
        `当前环境无法调用所选运行时。请在桌面版中使用本地 CLI，或切回 Claude Code 并配置 API key。`,
      );
      removeAiEditChannel(ch);
      return;
    }

    // "grill-me" and explicit clarification prompts opt into interrogation
    // mode. Ordinary AI-input turns should produce/apply a blueprint directly.
    const isGrill = isGrillRequest(trimmed);
    let allowClarification = isClarifyingEditRequest(trimmed);
    const wrapped = isGrill
      ? `请扮演严格的需求评审者。针对当前工作流蓝图，用交互（select / input）逐个向我追问还没考虑清楚的关键问题，例如：每个节点的输入/输出、边界与异常处理、成功/验收标准、节点依赖与先后顺序、该并行还是串行、用什么运行时与模型。一次只问一个问题；问清若干轮后，再据此优化蓝图并按要求输出。`
      // [dynamic-only refactor] 原用 isEmptyWorkflow(ir) 区分"新建/继续修改"措辞，
      // 该模块已停用；非简单模式蓝图生成路径已不可达，措辞退化为统一文案。
      : `我希望继续修改 workflow，根据下面意见你来优化流程：\n${trimmed}`;
    const irJson = JSON.stringify(ir);
    // `let` so the multi-angle research step (Feature 1) can fold its findings
    // into the generation context before any candidate/judge call reads it.
    let userContent = `当前 IRGraph(JSON)：\n${irJson}\n\n用户意见：\n${wrapped}`;
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
      appendStartUserInputs(withPromptWorkflowName(nextIr), capturedStartInputs);
    // FEATURE 2 — complex-node generation verify+vote. When nodeGenCandidates>1,
    // auto-escalate each generated `agent` node that the free heuristic flags as
    // complex into a first-class `consensus` node (in place — same id, same edges
    // — so the graph stays the source of truth and the change is portable). The
    // voting happens at RUN time via the existing consensus machinery; this adds
    // ZERO extra generation-time model calls. Voter count scales with the node's
    // complexity (capped at 5). nodeGenCandidates<=1 ⇒ returns the graph verbatim.
    // FEATURE 2 — complex-node generation verify+vote. Auto-escalate each
    // generated `agent` node the heuristic flags as complex into a first-class
    // `consensus` node (in place — same id/edges), seeding `min` lens voters so
    // its adversarial vote runs at RUN time. max<=1 ⇒ feature off (graph
    // verbatim). The starting voter count scales with node complexity.
    const escalateComplexNodes = (graph: IRGraph): IRGraph => {
      const range = nodeGenCandidateRange();
      if (range.max <= 1 || !Array.isArray(graph.nodes)) return graph;
      const mult = complexityScaling();
      let upgraded = 0;
      const nodes = graph.nodes.map((node) => {
        if (node.type !== 'agent') return node;
        const fit = assessConsensusFit(node, graph);
        if (!fit.fit) return node;
        const voterCount = Math.min(
          range.max,
          scaleCount(range.min, nodeComplexitySignal(node, graph), mult, range.max),
        );
        if (voterCount <= 1) return node;
        const target = String(node.params.prompt ?? node.label ?? '');
        const lenses = defaultConsensusLenses(target);
        const voters = Array.from(
          { length: voterCount },
          (_, i) => lenses[i % lenses.length],
        );
        upgraded += 1;
        return {
          ...node,
          type: 'consensus' as const,
          params: { ...node.params, voters, strategy: fit.strategy },
        };
      });
      if (upgraded === 0) return graph;
      provenance.upgradedNodes = upgraded;
      return { ...graph, nodes };
    };
    const commitAiBlueprint = (nextIr: IRGraph): 'ok' | 'stale' | 'locked' => {
      // Escalate complex nodes first (may set provenance.upgradedNodes), THEN
      // stamp the accumulated provenance onto the Start node, THEN commit — so
      // the Start node reflects the final escalated graph.
      const escalated = escalateComplexNodes(nextIr);
      const stamped = setGenerationProvenance(
        escalated,
        { ...provenance, at: provenance.at ?? Date.now() },
      );
      return commitAiChannelBlueprint(ch, stamped) ? 'ok' : 'locked';
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
    let activeRouteLabel = gatewayRouteHeader(directRoute);
    const setActiveRouteLabel = (routeLabel: string) => {
      activeRouteLabel = routeLabel;
      if (!activeId || !routeLabel) return;
      ch.messages = ch.messages.map((m) =>
        m.id === activeId ? { ...m, routeLabel } : m,
      );
      aiEditCommitMessages(ch, false);
    };
    const newBubble = (initial: string, routeLabel = activeRouteLabel) => {
      const id = shortId('m');
      activeId = id;
      ch.ownedMessageIds?.add(id);
      ch.messages = [
        ...ch.messages,
        {
          id,
          role: 'assistant',
          text: initial,
          ...(routeLabel ? { routeLabel } : {}),
          createdAt: Date.now(),
        },
      ];
      aiEditCommitMessages(ch, false);
    };
    const setActive = (txt: string, persist = false, routeLabel = activeRouteLabel) => {
      ch.messages = ch.messages.map((m) =>
        m.id === activeId
          ? {
              ...m,
              text: txt,
              ...(routeLabel ? { routeLabel } : {}),
            }
          : m,
      );
      aiEditCommitMessages(ch, persist);
    };
    const persistAiMessages = () => aiEditCommitMessages(ch, true);
    // Per-turn token usage: snapshot the session meter before the turn, diff it
    // after the reply lands, and stamp the delta onto the assistant bubble so the
    // chat history keeps each turn's tokens/cache even after reload.
    const usageMeterContext = {
      workspaceId: ch.workspaceId,
      sessionId: ch.sessionId,
    };
    const stampUsageOnMessage = (
      messageId: string,
      before: ReturnType<typeof readUsageMeterSnapshot>,
    ) => {
      if (!messageId) return;
      const delta = usageTurnFromSnapshots(
        before,
        readUsageMeterSnapshot(usageMeterContext),
      );
      if (delta.totalTokens <= 0) return;
      ch.messages = ch.messages.map((m) =>
        m.id === messageId ? { ...m, usage: delta } : m,
      );
      aiEditCommitMessages(ch, true);
    };
    let aiCliRoutePromise: Promise<Awaited<ReturnType<typeof resolveCliGatewayRoute>>> | null =
      null;
    const resolveAiCliRoute = () => {
      aiCliRoutePromise ??= (async () => {
        // Free-channel AI edits route through the built-in local proxy; ensure
        // it is up (latest keys/models) before resolving so the cached port is
        // current. No-op on web.
        if (isFreeChannelSelection(gatewaySelection)) {
          await ensureFreeProxy(freeProxyOptionsForSelection(gatewaySelection));
        }
        return resolveCliGatewayRoute(gatewaySelection);
      })();
      return aiCliRoutePromise.then((route) => {
        setActiveRouteLabel(gatewayRouteHeader(route));
        return route;
      });
    };
    const aiEditViaCliWithSpeed = async (
      prompt: string,
      cli: Awaited<ReturnType<typeof resolveCliGatewayRoute>>,
      opts: {
        permission: string;
        model?: string;
        cliCommand?: string;
        env?: Record<string, string>;
        cwd?: string;
        extraWorkspacePaths?: string[];
        runId?: string;
        onProgress?: (chunk: string) => void;
        sessionId?: string;
        resume?: boolean;
      },
    ): Promise<string> => {
      await changesBaselineReady;
      const policy = timeoutPolicyForSelection(cli.selection, prompt);
      const startedAt = Date.now();
      let firstProgressAt: number | undefined;
      const runId = opts.runId ?? makeCliRunId();
      ch.cliRunIds.add(runId);
      // Capture the backend's real token usage (claude/codex emit cache hits
      // via the `ai-cli-usage` event). When present we record it as authoritative
      // so the status bar shows the true cache percentage instead of `--`.
      let realUsage: ModelUsageReport | null = null;
      try {
        const text = await aiEditViaCli(prompt, cli.adapter, {
          ...opts,
          timeoutSeconds: policy.timeoutSeconds,
          idleTimeoutSeconds: policy.idleTimeoutSeconds,
          runId,
          onUsage: (raw) => {
            realUsage = mergeUsageReports(realUsage, usageReportFromCliUsage(raw));
          },
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
        const usageRoute = {
          baseUrl: cli.baseUrl,
          model: cli.model,
          providerName: cli.providerName,
          channelName: cli.channelName,
          label: cli.label,
        };
        if (realUsage) {
          recordModelUsageForRoute(
            { ...usageRoute, selection: cli.selection },
            realUsage,
            {
              estimated: false,
              context: { workspaceId: ch.workspaceId, sessionId: ch.sessionId },
            },
          );
        } else {
          recordEstimatedModelUsageForSelection(
            cli.selection,
            prompt,
            text,
            usageRoute,
            {
              context: { workspaceId: ch.workspaceId, sessionId: ch.sessionId },
            },
          );
        }
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
      } finally {
        ch.cliRunIds.delete(runId);
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
      const runId = makeCliRunId();
      ch.cliRunIds.add(runId);
      try {
        const text = await completeGatewayText({
          route: directRoute,
          system: request.system,
          userContent: request.userContent,
          maxTokens: 8192,
          signal: ch.abortController.signal,
          runId,
          usageContext: { workspaceId: ch.workspaceId, sessionId: ch.sessionId },
          permission: state.composer.permission || 'full',
          cwd: ch.workspaceRootPath ?? undefined,
          forceCli: preferCliForProjectMcp,
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
      } finally {
        ch.cliRunIds.delete(runId);
      }
    };

    // Split a full reply into explanation + optional IRGraph and apply it to the
    // active bubble. Only called once the AI is done asking (no interaction block).
    // A short human summary of the quantity-for-quality machinery that produced
    // this blueprint, appended to the success bubble (empty when nothing ran).
    const provenanceSummary = (): string => {
      const parts: string[] = [];
      if (provenance.researchLenses) {
        parts.push(
          `${provenance.researchLenses} 视角调研` +
            (provenance.researchRounds && provenance.researchRounds > 1
              ? `(${provenance.researchRounds} 轮)`
              : ''),
        );
      }
      if (provenance.candidates && provenance.candidates > 1) {
        parts.push(
          `${provenance.candidates} 份候选` +
            (provenance.judgeMerged ? '评审合并' : ''),
        );
      }
      if (provenance.upgradedNodes) {
        parts.push(`升级 ${provenance.upgradedNodes} 个共识节点`);
      }
      return parts.length ? ` · ${parts.join(' · ')}` : '';
    };
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
                  `✓ 已更新蓝图（${nextIr.nodes.length} 节点 / ${nextIr.edges.length} 边）。${provenanceSummary()}`,
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
            `${head}✓ 已更新蓝图（${nextIr.nodes.length} 节点 / ${nextIr.edges.length} 边）。${provenanceSummary()}`,
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
    const personalBlock = personalInstructionsBlock(
      personalInstructionsForSelection(
        state.personalInstructionsByModel,
        gatewaySelection,
      ),
      gatewaySelection.adapter,
    );
    const gameAssetChannels = {
      image: preferredReadyImageProviderId() != null,
      music: preferredReadyMusicProviderId() != null,
      threeD: preferredReadyThreeDProviderId() != null,
    };
    // Explicit-only routing (方案 A 之上的收紧)：游戏专家 / 制作人总控不再从
    // 聊天文本自动触发，只有用户通过 /game（或分层路径）显式调用时才注入。
    // - 指定了具体专家(分层路径命中) → 直接用专家融合，固定为这些专家。
    // - 仅 /game 整体调用 → 完整/多阶段需求走制作人总控，其余走专家融合。
    const hasPinnedExperts = pinnedGameExpertIds.length > 0;
    const gameExpertBlock = !forceGameExperts
      ? ''
      : hasPinnedExperts
        ? buildGameExpertPrompt(trimmed, state.gameExpertSettings, gameAssetChannels, {
            force: true,
            pinnedExpertIds: pinnedGameExpertIds,
          })
        : shouldUseProducer(trimmed)
          ? buildProducerPrompt(trimmed, state.gameExpertSettings, gameAssetChannels, {
              force: true,
            })
          : buildGameExpertPrompt(trimmed, state.gameExpertSettings, gameAssetChannels, {
              force: true,
            });
    const unifiedBase =
      UNIFIED_SYSTEM +
      modelStrategyGuidance(state.composer.modelStrategy) +
      languageAdaptationPrompt(state.locale) +
      personalBlock +
      gameExpertBlock +
      projectMcpGuidance;
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
        const cli = await resolveAiCliRoute();
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
          ...aiEditCliWorkspaceOptions(ch, state.composer),
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
      provenance.candidates = angles.length;
      newBubble(
        withAiTiming(
          `⟳ 复杂任务：生成 ${angles.length} 份候选蓝图（并发 ${generationPlan.concurrency}）…`,
        ),
      );

      const genOne = async (angle: string): Promise<string> => {
        const convoA = `${userContent}\n\n【本候选侧重】${angle}\n（据此给出与任务复杂度匹配的完整蓝图。）`;
        if (useCli) {
          const cli = await resolveAiCliRoute();
          return aiEditViaCliWithSpeed(
            `${directSystem}\n\n只针对工作流蓝图作答，不要读取或修改任何文件；直接输出中文说明 + 一个完整 \`\`\`json IRGraph 代码块。\n\n${convoA}`,
            cli,
            {
              permission: 'full',
              model: cli.model,
              cliCommand: cli.cliCommand,
              env: cli.env,
              ...aiEditCliWorkspaceOptions(ch, state.composer),
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
      provenance.candidatesValid = valid.length;

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
        `原始需求：\n${wrapped}\n\n当前 IRGraph：\n${irJson}\n\n` +
        `以下是多份候选蓝图，请评审合并出最佳：\n\n` +
        valid.map((v, i) => `【候选 ${i + 1}】\n${v.json}`).join('\n\n');

      let merged = '';
      if (useCli) {
        const cli = await resolveAiCliRoute();
        merged = await aiEditViaCliWithSpeed(`${judgeSystem}\n\n${judgeConvo}`, cli, {
          permission: 'full',
          model: cli.model,
          cliCommand: cli.cliCommand,
          env: cli.env,
          ...aiEditCliWorkspaceOptions(ch, state.composer),
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
      const judgeProducedGraph = replyIncludesIRGraph(merged);
      provenance.judgeMerged = judgeProducedGraph;
      finalizeReply(judgeProducedGraph ? merged : valid[0].full);
    };

    // Simple-workflow mode: skip ALL blueprint generation. Send the user's
    // input straight to the model (like a plain CLI/chat), stream the answer
    // into the chat bubble, and append the input to the lone start node so the
    // node mirrors the conversation. The graph never grows past one node.
    if (simpleMode) {
      // Serialize turns for this chat session so a follow-up sent mid-stream
      // ("插话") queues behind the in-flight turn and then runs with --resume
      // (warm context) instead of colliding on the same native --session-id.
      // Favorite reruns mint a fresh session per turn, so they need no queue.
      const runChatTurn = async () => {
        const chatSystem = [
          SIMPLE_CHAT_SYSTEM,
          languageAdaptationPrompt(state.locale),
          personalBlock,
          gameExpertBlock,
          useCli ? projectMcpGuidance : '',
        ].join('');
        // Multi-turn context: the gateway/CLI takes a single string, so fold the
        // prior conversation (text messages only, skipping system notices) into
        // the prompt as a transcript, then the current question. Keeps a bounded
        // tail so very long chats don't blow the context window.
        const priorMessages = baseMessages
          .filter((m) => m.role !== 'system' && m.text.trim());
        const chatTranscript = (messages: Message[]): string =>
          messages
            .slice(-SIMPLE_CHAT_HISTORY_TURNS)
            .map((m) => {
              const text = transcriptText(m);
              return text ? `${m.role === 'user' ? '用户' : '助手'}：${text}` : '';
            })
            .filter(Boolean)
            .join('\n\n');
        const prior = chatTranscript(priorMessages);
        const chatPrompt = prior.length
          ? `以下是之前的对话，请结合上下文继续回答最后一个「用户」消息：\n\n${prior}\n\n用户：${trimmed}`
          : trimmed;
        // Respect the permission the user picked in the composer (read-only /
        // ask-each-time / full), matching the other run paths instead of
        // hard-coding 'full'.
        const chatPermission = state.composer.permission || 'full';
        // Tracked across try/catch so a failure before the session ever
        // completed can forget its (already disk-registered) session id —
        // otherwise "继续"/retry reuses it and claude rejects the duplicate.
        let nativeSession: ChatNativeSession | null = null;
        const usageBefore = readUsageMeterSnapshot(usageMeterContext);
        try {
          newBubble(withAiTiming('⟳ 生成中…'));
          const turnMessageId = activeId;
          let answer = '';
          let routeLine = gatewayRouteLine(directRoute);
          if (useCli) {
            const cli = await resolveAiCliRoute();
            routeLine = gatewayRouteLine(cli);
            setActive(withAiTiming(routedBody(routeLine, '⟳ 生成中…')));
            nativeSession = replayFavoriteSimpleChat
              ? null
              : chatNativeSessionFor(ch, cli);
            const nativeResume = nativeSession?.started === true;
            const coveredMessageCount = Math.min(
              nativeSession?.coveredMessageCount ?? 0,
              priorMessages.length,
            );
            const unseenTranscript =
              nativeSession && nativeResume
                ? chatTranscript(priorMessages.slice(coveredMessageCount))
                : '';
            const promptBody =
              nativeSession && nativeResume
                ? unseenTranscript
                  ? `以下是你这个模型会话尚未看到的中间对话，请先吸收上下文，再回答最后一个「用户」消息：\n\n${unseenTranscript}\n\n用户：${trimmed}`
                  : trimmed
                : chatPrompt;
            let live = '';
            answer = await aiEditViaCliWithSpeed(`${chatSystem}\n\n${promptBody}`, cli, {
              permission: chatPermission,
              model: cli.model,
              cliCommand: cli.cliCommand,
              env: cli.env,
              ...aiEditCliWorkspaceOptions(ch, state.composer),
              sessionId: nativeSession?.sessionId,
              resume: nativeSession ? nativeResume : undefined,
              onProgress: (chunk) => {
                live += chunk;
                setActive(withAiTiming(routedBody(routeLine, live)));
              },
            });
            if (nativeSession) nativeSession.started = true;
            if (!answer.trim() && live.trim()) answer = live;
          } else {
            let full = '';
            setActive(withAiTiming(routedBody(routeLine, '⟳ 生成中…')));
            const returned = await completeDirectWithSpeed({
              system: chatSystem,
              userContent: chatPrompt,
              onDelta: (chunk) => {
                full += chunk;
                setActive(withAiTiming(routedBody(routeLine, full)));
              },
            });
            answer = full || returned;
          }
          setActive(
            withAiTiming(routedBody(routeLine, answer.trim() || '（模型没有返回内容）')),
            true,
          );
          if (useCli && !replayFavoriteSimpleChat && nativeSession) {
            nativeSession.started = true;
            nativeSession.coveredMessageCount = ch.messages.filter(
              (m) => m.role !== 'system' && m.text.trim(),
            ).length;
          }
          // Record the input on the node (keeps the graph a single node).
          commitAiChannelBlueprint(ch, appendStartUserInputs(ch.workflow, [trimmed]));
          syncAndPersistSessionRunStatus(
            { workspaceId: ch.workspaceId, sessionId: ch.sessionId },
            'success',
          );
          stampUsageOnMessage(turnMessageId, usageBefore);
        } catch (err) {
          const msg = (err as Error)?.message ?? String(err);
          // The CLI failed (e.g. ConnectionRefused) before the model call
          // succeeded. claude already registered the `--session-id` on disk, so
          // drop the unstarted native session to free the id — otherwise the
          // next retry reuses it and dies with "Session ID … is already in use".
          if (nativeSession && !nativeSession.started) {
            forgetChatNativeSession(nativeSession);
          }
          if (activeId) setActive(withAiTiming(`✗ 调用失败: ${msg}`), true);
          else pushAssistant(withAiTiming(`✗ 调用失败: ${msg}`));
          persistAiMessages();
          if (aiEditActive(ch)) {
            syncAndPersistSessionRunStatus(
              { workspaceId: ch.workspaceId, sessionId: ch.sessionId },
              'error',
            );
          }
        } finally {
          removeAiEditChannel(ch);
        }
      };
      // CLI turns share one native --session-id per chat session, so a follow-up
      // sent mid-stream must queue behind the in-flight turn and then --resume it
      // (otherwise claude rejects the duplicate id with "already in use"). API
      // turns have no such constraint and stay concurrent. Favorite reruns mint a
      // fresh session per turn, so they never queue.
      if (useCli && !replayFavoriteSimpleChat) {
        void enqueueChatTurn(chSessionKey, runChatTurn);
      } else {
        void runChatTurn();
      }
      return;
    }

    void (async () => {
      let convo = userContent;
      let finalized = false;
      const usageBefore = readUsageMeterSnapshot(usageMeterContext);
      try {
        // FEATURE 1 — multi-angle research before generation. max<=1 ⇒ skipped
        // entirely. Starts at `min` lenses; when adaptive escalation is on and
        // the findings disagree, it doubles the lens count (min→…→max, reusing
        // prior findings) before folding the accumulated conclusions into the
        // generation context. CLI lenses may read the workspace (cwd + full
        // permission); API lenses are reasoning-only over the request + IRGraph.
        const researchRange = researchAngleRange();
        if (
          (useApi || useCli) &&
          researchRange.max > 1 &&
          !isGrill &&
          !allowClarification &&
          complexGenerationRequest
        ) {
          try {
            const adaptive = adaptiveEscalationEnabled();
            const allLenses = researchAngles(researchRange.max);
            const researchSystem = useCli
              ? `${unifiedBase}\n\n你现在处于「调研」阶段（不是改图）。请围绕给定视角调研，可读取工作区中的相关代码/文件以了解现状，但不要创建或修改任何文件，也不要输出蓝图或 \`\`\`json 代码块。只用要点列表给出该视角的简明结论（不超过 200 字）。`
              : `${unifiedBase}\n\n你现在处于「调研」阶段（不是改图）。请仅基于给定的需求与当前 IRGraph，围绕给定视角做分析推理（你无法读取本地文件）。不要输出蓝图或 \`\`\`json 代码块。只用要点列表给出该视角的简明结论（不超过 200 字）。`;
            const runLens = async (lens: string): Promise<string> => {
              const convoR =
                `调研目标（用户需求）：\n${wrapped}\n\n当前 IRGraph：\n${irJson}\n\n` +
                `【本视角聚焦】${lens}`;
              try {
                if (useCli) {
                  const cli = await resolveAiCliRoute();
                  return await aiEditViaCliWithSpeed(`${researchSystem}\n\n${convoR}`, cli, {
                    permission: 'full',
                    model: cli.model,
                    cliCommand: cli.cliCommand,
                    env: cli.env,
                    ...aiEditCliWorkspaceOptions(ch, state.composer),
                  });
                }
                return await completeDirectWithSpeed({ system: researchSystem, userContent: convoR });
              } catch {
                return '';
              }
            };
            const findings: string[] = [];
            let ran = 0;
            let rounds = 0;
            let lastDivergence = 0;
            let target = Math.max(2, Math.min(researchRange.min, researchRange.max));
            for (;;) {
              const delta = allLenses.slice(ran, target);
              if (delta.length === 0) break;
              const conc = Math.max(1, Math.min(delta.length, generationPlan.concurrency || delta.length));
              newBubble(
                withAiTiming(`⟳ 多角度调研：并行展开 ${target} 个视角（并发 ${conc}）…`),
              );
              const batch = await runWithConcurrency(delta, conc, runLens);
              findings.push(...batch);
              ran = target;
              rounds += 1;
              const usable = findings.filter((f) => f && f.trim());
              if (!adaptive || ran >= researchRange.max || usable.length < 2) break;
              // Prose findings: distinct conclusions ⇒ escalate one doubling step.
              const div = measureDivergence(usable);
              lastDivergence = div;
              if (div <= VOTE_DIVERGENCE_THRESHOLD) break;
              target = Math.min(researchRange.max, ran * 2);
              if (target <= ran) break;
            }
            const usable = findings.filter((f) => f && f.trim());
            if (usable.length) {
              provenance.researchLenses = ran;
              provenance.researchUsable = usable.length;
              provenance.researchRounds = rounds;
              provenance.researchDivergence = lastDivergence;
              const block =
                `\n\n=== 多角度调研结论（供生成参考，请据此完善蓝图） ===\n` +
                usable.map((f, i) => `【视角 ${i + 1}】\n${f.trim()}`).join('\n\n');
              userContent += block;
              convo = userContent;
              setActive(
                withAiTiming(
                  `✓ 多角度调研完成（${usable.length}/${ran} 个视角有结论），已并入生成上下文。`,
                ),
              );
            }
          } catch {
            /* research is best-effort; fall through to normal generation */
          }
        }
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
        // Stamp the whole turn's token usage onto the final assistant bubble so
        // the blueprint-generation path also keeps per-turn tokens/cache.
        stampUsageOnMessage(activeId, usageBefore);
        removeAiEditChannel(ch);
      }
    })();
  },

  clearBlockedSendTip: () => set({ blockedSendTip: null }),

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
      const composer = normalizeComposerSettings({ ...state.composer, ...patch });
      const snapshot: SessionComposerSettings = {
        composer,
        gatewaySelection: workflowDefaultGatewaySelection(
          state.workflow,
          composer.model,
        ),
      };
      const composerBySession = rememberSessionComposer(
        { ...state, composer },
        state.composerBySession,
        snapshot,
      );
      saveComposerSoon({
        composer,
        composerBySession,
        workspaceHistory: state.workspaceHistory,
      });
      return { composer, composerBySession };
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
    const trimmed = normalizeWorkspacePath(path);
    if (!trimmed) return;
    if (isActiveAiEditingSession(useStore.getState())) return;
    set((state) => {
      const composer = normalizeComposerSettings({
        ...state.composer,
        workspace: trimmed,
        workspaceFolders: state.composer.workspaceFolders,
      });
      const workspaceHistory = workspaceHistoryWithRecentPaths(
        composerWorkspacePaths(composer),
        state.workspaceHistory,
      );
      const snapshot: SessionComposerSettings = {
        composer,
        gatewaySelection: workflowDefaultGatewaySelection(
          state.workflow,
          composer.model,
        ),
      };
      const composerBySession = rememberSessionComposer(
        { ...state, composer },
        state.composerBySession,
        snapshot,
      );
      saveComposerSoon({ composer, composerBySession, workspaceHistory });
      return { composer, composerBySession, workspaceHistory };
    });
    void activateWorkspacePath(trimmed);
  },

  // Add a session-only workspace folder. The first folder becomes the primary
  // cwd; later folders are passed to CLI adapters as extra allowed directories.
  addWorkspaceFolder: (path) => {
    const trimmed = normalizeWorkspacePath(path);
    if (!trimmed) return;
    const current = useStore.getState();
    if (isActiveAiEditingSession(current)) return;
    const shouldActivate = !normalizeWorkspacePath(current.composer.workspace);
    set((state) => {
      const composer = shouldActivate
        ? normalizeComposerSettings({
            ...state.composer,
            workspace: trimmed,
            workspaceFolders: [],
          })
        : normalizeComposerSettings({
            ...state.composer,
            workspaceFolders: [trimmed, ...state.composer.workspaceFolders],
          });
      const workspaceHistory = workspaceHistoryWithRecentPaths(
        composerWorkspacePaths(composer),
        state.workspaceHistory,
      );
      const snapshot: SessionComposerSettings = {
        composer,
        gatewaySelection: workflowDefaultGatewaySelection(
          state.workflow,
          composer.model,
        ),
      };
      const composerBySession = rememberSessionComposer(
        { ...state, composer },
        state.composerBySession,
        snapshot,
      );
      saveComposerSoon({ composer, composerBySession, workspaceHistory });
      return { composer, composerBySession, workspaceHistory };
    });
    if (shouldActivate) void activateWorkspacePath(trimmed);
  },

  removeWorkspaceFolder: (path) => {
    const key = workspacePathKey(path);
    if (!key) return;
    if (isActiveAiEditingSession(useStore.getState())) return;
    set((state) => {
      const primaryKey = workspacePathKey(state.composer.workspace);
      const currentExtras = normalizeWorkspaceFolderList(
        state.composer.workspaceFolders,
        state.composer.workspace,
      );
      let workspace = state.composer.workspace;
      let workspaceFolders = currentExtras.filter(
        (item) => workspacePathKey(item) !== key,
      );
      if (primaryKey === key) {
        workspace = workspaceFolders[0] ?? '';
        workspaceFolders = workspaceFolders.slice(1);
      }
      const composer = normalizeComposerSettings({
        ...state.composer,
        workspace,
        workspaceFolders,
      });
      const snapshot: SessionComposerSettings = {
        composer,
        gatewaySelection: workflowDefaultGatewaySelection(
          state.workflow,
          composer.model,
        ),
      };
      const composerBySession = rememberSessionComposer(
        { ...state, composer },
        state.composerBySession,
        snapshot,
      );
      saveComposerSoon({
        composer,
        composerBySession,
        workspaceHistory: state.workspaceHistory,
      });
      return { composer, composerBySession };
    });
  },

  // Remove a folder from the workspace history. If it was the active
  // workspace, the active selection is cleared (falls back to "no folder").
  removeWorkspace: (path) => {
    const key = workspacePathKey(path);
    if (!key) return;
    if (isActiveAiEditingSession(useStore.getState())) return;
    set((state) => {
      const workspaceHistory = state.workspaceHistory.filter(
        (p) => workspacePathKey(p) !== key,
      );
      if (workspaceHistory.length === state.workspaceHistory.length) {
        return state;
      }
      const removingActive = workspacePathKey(state.composer.workspace) === key;
      const currentExtras = normalizeWorkspaceFolderList(
        state.composer.workspaceFolders,
        state.composer.workspace,
      ).filter((item) => workspacePathKey(item) !== key);
      if (!removingActive && currentExtras.length === state.composer.workspaceFolders.length) {
        saveComposerSoon({
          composer: state.composer,
          composerBySession: state.composerBySession,
          workspaceHistory,
        });
        return { workspaceHistory };
      }
      const composer = normalizeComposerSettings({
        ...state.composer,
        workspace: removingActive ? currentExtras[0] ?? '' : state.composer.workspace,
        workspaceFolders: removingActive ? currentExtras.slice(1) : currentExtras,
      });
      const snapshot: SessionComposerSettings = {
        composer,
        gatewaySelection: workflowDefaultGatewaySelection(
          state.workflow,
          composer.model,
        ),
      };
      const composerBySession = rememberSessionComposer(
        { ...state, composer },
        state.composerBySession,
        snapshot,
      );
      saveComposerSoon({ composer, composerBySession, workspaceHistory });
      return { composer, composerBySession, workspaceHistory };
    });
  },

  applyWorkspaceFolders: (workspaceId, folders) => {
    if (isActiveAiEditingSession(useStore.getState())) return;
    set((state) => {
      if (!workspaceId || state.activeWorkspaceId !== workspaceId) return state;
      const workspace = state.workspaces.find((ws) => ws.id === workspaceId);
      const primary = normalizeWorkspacePath(
        state.composer.workspace || workspace?.path || '',
      );
      const composer = normalizeComposerSettings({
        ...state.composer,
        workspace: primary,
        workspaceFolders: folders,
      });
      const snapshot: SessionComposerSettings = {
        composer,
        gatewaySelection: workflowDefaultGatewaySelection(
          state.workflow,
          composer.model,
        ),
      };
      const composerBySession = rememberSessionComposer(
        { ...state, composer },
        state.composerBySession,
        snapshot,
      );
      saveComposerSoon({
        composer,
        composerBySession,
        workspaceHistory: state.workspaceHistory,
      });
      return { composer, composerBySession };
    });
  },

  // ── Graph editing ──────────────────────────────────────────────────────

  addNode: (type, params, parent) => {
    const id = shortId('n');
    const committed = applyWorkflowEdit('user', (state) => {
      const defaults = NODE_DEFAULTS[type];
      // Default the parent to the composite subgraph currently being viewed, so
      // nodes created while drilled in are owned by that composite. An explicit
      // `parent` arg (e.g. type-change preserving branch/loop nesting) wins.
      const effectiveParent = parent ?? selectActiveScopeId(state);
      const node: IRNode = {
        id,
        type,
        ...(effectiveParent ? { parent: effectiveParent } : {}),
        label: defaults.label,
        params: { ...defaults.params, ...(params ?? {}) },
      };
      // [dynamic-only refactor] autoLayoutGraph(蓝图布局)已停用；蓝图编辑动作在
      // 纯聊天 GUI 下不可达，这里直接追加节点不做自动布局。
      const nextWorkflow = {
        ...state.workflow,
        nodes: [...state.workflow.nodes, node],
      };
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

  convertNodeToConsensus: (id, strategy) => {
    applyWorkflowEdit('user', (state) => {
      let converted = false;
      const nodes = state.workflow.nodes.map((n) => {
        if (n.id !== id || n.type !== 'agent') return n;
        converted = true;
        const target = String(n.params.prompt ?? n.label ?? '');
        return {
          ...n,
          type: 'consensus' as const,
          params: {
            ...n.params,
            voters: defaultConsensusLenses(target),
            strategy,
          },
        };
      });
      if (!converted) return null;
      return {
        workflow: workflowWithoutRunSnapshot({
          ...state.workflow,
          nodes,
        }),
        selectedNodeId: id,
        dirty: true,
        ...emptyRunProgress(),
      };
    });
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

  // Re-layer every node into a clean topological layout along the exec spine.
  // Layout-only (preserves run state) but dirties so positions persist. Reuses
  // the existing layered engine; stripping the prior layout forces a full
  // re-arrange rather than honoring stale coordinates.
  autoArrangeWorkflow: () => {
    // [dynamic-only refactor] 画布自动布局已停用（autoLayoutGraph 模块 exclude）。
    /* disabled: blueprint canvas auto-layout removed */
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

setSessionNotificationClickHandler(({ workspaceId, sessionId }) => {
  if (!sessionId) return;
  useStore.getState().selectSession(sessionId, workspaceId ?? undefined);
});

/* -------------------------------------------------------------------------- */
/* Run execution helpers                                                      */
/* -------------------------------------------------------------------------- */

interface RunConfig {
  cwd?: string;
  extraWorkspacePaths?: string[];
  permission?: string;
  model?: string;
  cliCommand?: string;
  gatewaySelection?: GatewaySelection;
}

function formatRunWorkspaceSuffix(config: RunConfig): string {
  const paths = uniqueWorkspaceHistory([
    config.cwd,
    ...(config.extraWorkspacePaths ?? []),
  ]);
  if (paths.length === 0) return '';
  return ` · 工作区 ${paths[0]}${paths.length > 1 ? ` +${paths.length - 1}` : ''}`;
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
  /**
   * Per-node content hashes from this run (runtime `computeNodeHashes`). Captured
   * when the run finishes and persisted in the run snapshot, so the next
   * "continue" reuses a cached node output only when its hash still matches —
   * editing the graph re-runs the affected subgraph. Absent until the run ends.
   */
  nodeHashes?: Record<string, string>;
}
const activeRuns = new Map<string, RunChannel>();

interface AiEditChannel {
  key: string;
  sessionKey: string;
  workspaceId: string | null;
  sessionId: string | null;
  /** Filesystem root used for this turn's session-change snapshot. */
  workspaceRootPath?: string | null;
  workflow: IRGraph;
  messages: Message[];
  cliRunIds: Set<string>;
  abortController: AbortController;
  /** Gateway/model snapshot captured when this AI turn started. */
  gatewaySelection?: GatewaySelection;
  /** Whether this channel belongs to a history session that should store IRGraph. */
  workflowSession: boolean;
  /**
   * True for simple-workflow chat turns. Such turns reuse the AI-edit channel
   * plumbing (message persistence, background completion, userInputs commit) but
   * are NOT "blueprint editing": they surface as `chattingSessions` rather than
   * `aiEditingSessions`, so they don't lock the (nonexistent) canvas as
   * read-only. See sendPrompt's simpleMode branch.
   */
  chat?: boolean;
  /** Message ids created by this chat turn; used to merge concurrent replies. */
  ownedMessageIds?: Set<string>;
}
const activeAiEdits = new Map<string, AiEditChannel>();
const aiEditSnapshots = new Map<string, AiEditChannel>();

interface ChatNativeSession {
  sessionId: string;
  started: boolean;
  coveredMessageCount: number;
}

const chatNativeSessions = new Map<string, ChatNativeSession>();

/**
 * Per-session serialization for simple-chat turns. A follow-up message can be
 * sent while a turn is still streaming ("插话"): it is accepted immediately and
 * shown in the transcript, then runs right after the in-flight turn finishes so
 * it can `--resume` the warm native session instead of colliding with the live
 * process on the same `--session-id` (which claude rejects with "Session ID …
 * is already in use"). Turns for the same chat session run strictly in order;
 * a failed turn does not block the queued ones.
 */
const chatTurnQueues = new Map<string, Promise<void>>();

function enqueueChatTurn(
  sessionKey: string,
  run: () => Promise<void>,
): Promise<void> {
  const prev = chatTurnQueues.get(sessionKey) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(run);
  chatTurnQueues.set(sessionKey, next);
  void next.catch(() => {}).finally(() => {
    if (chatTurnQueues.get(sessionKey) === next) {
      chatTurnQueues.delete(sessionKey);
    }
  });
  return next;
}

function chatNativeSessionKey(
  ch: Pick<AiEditChannel, 'sessionKey' | 'sessionId'>,
  route: Awaited<ReturnType<typeof resolveCliGatewayRoute>>,
): string {
  return [
    ch.sessionKey,
    route.adapter,
    route.providerId ?? '',
    route.channelId ?? '',
    route.model ?? route.modelClass ?? '',
    route.env?.ANTHROPIC_BASE_URL ?? '',
    route.env?.ANTHROPIC_MODEL ?? '',
  ].join('::');
}

function chatNativeSessionFor(
  ch: Pick<AiEditChannel, 'sessionKey' | 'sessionId'>,
  route: Awaited<ReturnType<typeof resolveCliGatewayRoute>>,
): ChatNativeSession | null {
  if (!ch.sessionId) return null;
  if (route.transport !== 'cli' || route.adapter !== 'claude-code') return null;
  const key = chatNativeSessionKey(ch, route);
  const existing = chatNativeSessions.get(key);
  if (existing) return existing;
  const created = {
    sessionId: newSessionId(),
    started: false,
    coveredMessageCount: 0,
  };
  chatNativeSessions.set(key, created);
  return created;
}

/**
 * Drop a chat's native session from the map (by identity). Used when a CLI call
 * fails before the session ever completed: claude registers the `--session-id`
 * on disk the moment it launches (even if the model call then errors), so a
 * naive retry would reuse the same id and hit "Session ID … is already in use".
 * Forgetting the unstarted session forces the next turn to mint a fresh id.
 */
function forgetChatNativeSession(session: ChatNativeSession): void {
  for (const [key, value] of chatNativeSessions) {
    if (value === session) {
      chatNativeSessions.delete(key);
      return;
    }
  }
}

function runKey(workspaceId: string | null, sessionId: string | null): string {
  return workflowSessionKeyId({ workspaceId, sessionId });
}

function chatTurnKey(sessionKey: string, messageId: string): string {
  return `${sessionKey}::chat::${messageId}`;
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
  const key = runKey(workspaceId, sessionId);
  return (
    activeAiEdits.get(key) ??
    getAiEditChannelsForSession(workspaceId, sessionId).find((ch) => !ch.chat) ??
    null
  );
}

function getAiEditSnapshot(
  workspaceId: string | null,
  sessionId: string | null,
): AiEditChannel | null {
  const key = runKey(workspaceId, sessionId);
  const exact = aiEditSnapshots.get(key);
  if (exact) return exact;
  const snapshots = getAiEditSnapshotsForSession(workspaceId, sessionId);
  return snapshots[snapshots.length - 1] ?? null;
}

/**
 * Best message-source for restoring the AI-return view when switching back into
 * a session. Prefers the LIVE channel (so we get the freshest in-flight text —
 * snapshots can lag a single chunk behind), then any chat channel for the
 * session (chat channels are deliberately excluded from getAiEditChannel because
 * they don't lock the workflow), and finally the snapshot map. Returning the
 * snapshot last means a session whose stream finished a while ago (channel
 * removed but snapshot retained) still restores its final messages.
 */
function getAiEditViewSource(
  workspaceId: string | null,
  sessionId: string | null,
): AiEditChannel | null {
  const channels = getAiEditChannelsForSession(workspaceId, sessionId);
  if (channels.length > 0) {
    // Prefer blueprint-edit (non-chat); fall back to the most recently added chat
    // channel, which carries the live streaming bubble for a simple-workflow turn.
    return (
      channels.find((ch) => !ch.chat) ??
      channels[channels.length - 1]
    );
  }
  return getAiEditSnapshot(workspaceId, sessionId);
}

function channelMatchesSession(
  ch: Pick<AiEditChannel, 'sessionKey' | 'workspaceId' | 'sessionId'>,
  workspaceId: string | null,
  sessionId: string | null,
): boolean {
  return ch.sessionKey === runKey(workspaceId, sessionId);
}

function getAiEditChannelsForSession(
  workspaceId: string | null,
  sessionId: string | null,
): AiEditChannel[] {
  return [...activeAiEdits.values()].filter((ch) =>
    channelMatchesSession(ch, workspaceId, sessionId),
  );
}

function getAiEditChatChannels(
  workspaceId: string | null,
  sessionId: string | null,
): AiEditChannel[] {
  return getAiEditChannelsForSession(workspaceId, sessionId).filter(
    (ch) => ch.chat,
  );
}

// Currently unused (no caller wired up yet); kept commented to preserve intent.
// function hasActiveChatForDifferentSelection(
//   sessionKey: WorkflowSessionKey,
//   selection: GatewaySelection,
// ): boolean {
//   const currentKey = selectionKey(normalizeGatewaySelection(selection));
//   return getAiEditChatChannels(
//     sessionKey.workspaceId,
//     sessionKey.sessionId,
//   ).some((ch) => {
//     if (!ch.gatewaySelection) return false;
//     return selectionKey(normalizeGatewaySelection(ch.gatewaySelection)) !== currentKey;
//   });
// }

type ActiveChatAppendResult = 'none' | 'appended' | 'selection-mismatch';

function appendPromptToActiveSimpleChat(
  sessionKey: WorkflowSessionKey,
  selection: GatewaySelection,
  text: string,
): ActiveChatAppendResult {
  void text;
  const channels = getAiEditChatChannels(
    sessionKey.workspaceId,
    sessionKey.sessionId,
  );
  if (channels.length === 0) return 'none';

  const currentKey = selectionKey(normalizeGatewaySelection(selection));
  const compatible = channels.filter((ch) => {
    if (!ch.gatewaySelection) return false;
    return selectionKey(normalizeGatewaySelection(ch.gatewaySelection)) === currentKey;
  });
  if (compatible.length !== channels.length || compatible.length === 0) {
    return 'selection-mismatch';
  }

  return 'none';
}

function getAiEditSnapshotsForSession(
  workspaceId: string | null,
  sessionId: string | null,
): AiEditChannel[] {
  return [...aiEditSnapshots.values()].filter((ch) =>
    channelMatchesSession(ch, workspaceId, sessionId),
  );
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
  const channels = activeAiEditChannels();
  // Blueprint-editing channels lock the workflow as read-only; chat channels
  // (simple-workflow turns) do not — they surface separately so consecutive
  // chat messages aren't blocked by the read-only gate. Both keep aiStreaming
  // truthy so the composer reflects "busy".
  const aiEditingSessions = uniqueAiEditSessions(
    channels.filter((ch) => !ch.chat),
  );
  const chattingSessions = uniqueAiEditSessions(
    channels.filter((ch) => ch.chat),
  );
  useStore.setState({
    aiEditingSessions,
    chattingSessions,
    aiStreaming: aiEditingSessions.length + chattingSessions.length > 0,
  });
}

function syncRunningSessionProgress(): void {
  useStore.setState({ runningSessionProgress: runningSessionProgressByKey() });
}

function uniqueAiEditSessions(channels: AiEditChannel[]): WorkflowSessionKey[] {
  const seen = new Set<string>();
  const out: WorkflowSessionKey[] = [];
  for (const ch of channels) {
    if (seen.has(ch.sessionKey)) continue;
    seen.add(ch.sessionKey);
    out.push({ workspaceId: ch.workspaceId, sessionId: ch.sessionId });
  }
  return out;
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
  rememberAiEditSnapshot(ch);
  syncAiEditingSessions();
}

function removeAiEditChannel(ch: AiEditChannel | null): void {
  if (!aiEditRegistered(ch)) return;
  const sessionKey = { workspaceId: ch.workspaceId, sessionId: ch.sessionId };
  const rootPath = ch.workspaceRootPath;
  rememberAiEditSnapshot(ch);
  flushAiEditPersist(ch);
  activeAiEdits.delete(ch.key);
  syncAiEditingSessions();
  refreshSessionChangesForKey(sessionKey, rootPath);
}

function stopActiveChat(): void {
  const state = useStore.getState();
  const key = activeWorkflowSessionKey(state);
  const channels = getAiEditChatChannels(key.workspaceId, key.sessionId);
  if (channels.length === 0) return;

  const stoppedAt = Date.now();
  for (const ch of channels) {
    ch.abortController.abort();
    void cancelActiveAiEditRuns(ch);
  }
  const ch = channels[0];
  const stoppedMsg: Message = {
    id: shortId('m'),
    role: 'assistant',
    text: `⏹ 会话已中断 · ${formatClock(stoppedAt)}。`,
    createdAt: stoppedAt,
  };
  ch.ownedMessageIds?.add(stoppedMsg.id);
  ch.messages = [
    ...ch.messages,
    stoppedMsg,
  ];
  aiEditCommitMessages(ch, true);
  syncAndPersistSessionRunStatus(
    { workspaceId: ch.workspaceId, sessionId: ch.sessionId },
    'interrupted',
  );
  for (const item of channels) {
    removeAiEditChannel(item);
  }
}

const IMAGE_PROMPT_SYSTEM = `你是专业的"生图提示词工程师"。用户会给出一句关于想要生成的图片的描述或想法，你要把它扩写成一段高质量、可直接喂给文生图模型的提示词。
要求：
- 直接输出最终提示词正文，不要任何解释、前后缀、标题、引号或代码块。
- 补全画面主体、风格、构图、光线、色调、镜头/视角、画质等关键要素，使画面具体而协调。
- 保留用户明确指定的内容；用户没提到的细节由你做合理且不喧宾夺主的补充。
- 与用户输入语言保持一致（中文需求输出中文提示词，英文需求输出英文提示词）。
- 只描述要画什么，不要写"请生成/帮我画"之类的指令性措辞。`;

const MUSIC_PROMPT_SYSTEM = `你是专业的"音乐生成提示词工程师"。用户会给出一句关于想要生成的音乐、歌曲、BGM 或音频的描述，你要把它扩写成一段高质量、可直接喂给音乐生成模型的提示词。
要求：
- 直接输出最终提示词正文，不要任何解释、前后缀、标题、引号或代码块。
- 补全音乐类型、情绪、速度、乐器、编曲层次、段落结构、混音质感、是否有人声/歌词等关键要素。
- 保留用户明确指定的内容；用户没提到的细节由你做合理且不喧宾夺主的补充。
- 与用户输入语言保持一致（中文需求输出中文提示词，英文需求输出英文提示词）。
- 不要要求模仿现役艺人、受版权歌曲或具体受保护歌词；用可授权的风格描述替代。
- 只描述要生成什么音乐，不要写"请生成/帮我写"之类的指令性措辞。`;

const THREE_D_PROMPT_SYSTEM = `你是专业的"3D模型生成提示词工程师"。用户会给出一句关于想要生成的 3D 模型、游戏资产、道具、角色或产品模型的描述，你要把它扩写成一段高质量、可直接喂给文生 3D 模型的提示词。
要求：
- 直接输出最终提示词正文，不要任何解释、前后缀、标题、引号或代码块。
- 补全主体形体、比例、轮廓、结构细节、材质、PBR 贴图、拓扑/面数倾向、可用视角和导出目标等关键要素。
- 让模型聚焦单个可用 3D 资产；避免复杂背景、场景叙事、摄影机语言和纯 2D 画面描述。
- 骨骼/动画只用于能自然绑定的角色、生物、可动机器人或机械臂；石头、家具、武器、建筑、产品等静态资产不要写骨骼或动画。
- 保留用户明确指定的内容；用户没提到的细节由你做合理且不喧宾夺主的补充。
- 与用户输入语言保持一致（中文需求输出中文提示词，英文需求输出英文提示词）。
- 只描述要生成什么 3D 模型，不要写"请生成/帮我建模"之类的指令性措辞。`;

type GenerationPromptMode = 'image' | 'music' | 'threeD';

function generationModeStartedAt(
  composer: ComposerSettings,
  mode: GenerationPromptMode,
): number | null {
  const value =
    mode === 'image'
      ? composer.imageModeStartedAt
      : mode === 'music'
        ? composer.musicModeStartedAt
        : composer.threeDModeStartedAt;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function generationModeActive(
  composer: ComposerSettings,
  mode: GenerationPromptMode,
): boolean {
  return mode === 'image'
    ? composer.imageMode
    : mode === 'music'
      ? composer.musicMode
      : composer.threeDMode;
}

function generationModeEnteredText(mode: GenerationPromptMode, text: string): boolean {
  if (mode === 'image') return /已进入生图模式|image mode on/i.test(text);
  if (mode === 'music') return /已进入音乐模式|music mode on/i.test(text);
  return /已进入\s*Mesh\s*模式|mesh mode on/i.test(text);
}

function generationModeExitedText(mode: GenerationPromptMode, text: string): boolean {
  if (mode === 'image') return /已退出生图模式|image mode off/i.test(text);
  if (mode === 'music') return /已退出音乐模式|music mode off/i.test(text);
  return /已退出\s*Mesh\s*模式|mesh mode off/i.test(text);
}

function inferGenerationModeStartedAt(
  messages: readonly Message[],
  mode: GenerationPromptMode,
): number | null {
  let startedAt: number | null = null;
  for (const message of messages) {
    if (message.role !== 'system') continue;
    if (generationModeEnteredText(mode, message.text)) {
      startedAt = message.createdAt;
    } else if (generationModeExitedText(mode, message.text)) {
      startedAt = null;
    }
  }
  return startedAt;
}

function stripGenerationCommand(
  mode: GenerationPromptMode,
  text: string,
): string {
  if (mode === 'image') return stripImageCommand(text);
  if (mode === 'music') return stripMusicCommand(text);
  return stripThreeDCommand(text);
}

function normalizeGenerationTurn(
  mode: GenerationPromptMode,
  text: string,
): string {
  return stripGenerationCommand(mode, text)
    .replace(/\s+/g, ' ')
    .trim();
}

function modeContextPrompt(
  state: Pick<StoreState, 'composer' | 'messages'>,
  mode: GenerationPromptMode,
  currentPrompt: string,
): string {
  const current = normalizeGenerationTurn(mode, currentPrompt);
  if (!generationModeActive(state.composer, mode)) {
    return current;
  }
  const startedAt =
    generationModeStartedAt(state.composer, mode) ??
    inferGenerationModeStartedAt(state.messages, mode) ??
    0;

  const priorTurns = state.messages
    .filter(
      (message) =>
        message.role === 'user' &&
        message.createdAt >= startedAt &&
        message.text.trim(),
    )
    .map((message) => normalizeGenerationTurn(mode, message.text))
    .filter(Boolean);
  const turns =
    priorTurns[priorTurns.length - 1] === current
      ? priorTurns
      : [...priorTurns, current];
  if (turns.length <= 1) return current;

  return [
    '本次生成模式内的连续需求如下，请合并成当前这一次的最终生成需求。',
    '规则：后面的补充优先；除非最新输入明确换主体，否则保留前文主体和约束。',
    ...turns.map((turn, index) => `${index + 1}. ${turn}`),
  ].join('\n');
}

/** Strip code fences / labels / surrounding quotes the model may wrap around the prompt. */
function cleanGeneratedImagePrompt(raw: string): string {
  let text = raw.trim();
  const fence = /^```[^\n]*\n([\s\S]*?)\n```$/.exec(text);
  if (fence) text = fence[1].trim();
  text = text.replace(/^(?:生图提示词|提示词|prompt)\s*[:：]\s*/iu, '').trim();
  const quoted = /^["'「『]([\s\S]+)["'」』]$/u.exec(text);
  if (quoted) text = quoted[1].trim();
  return text;
}

function cleanGeneratedMusicPrompt(raw: string): string {
  let text = raw.trim();
  const fence = /^```[^\n]*\n([\s\S]*?)\n```$/.exec(text);
  if (fence) text = fence[1].trim();
  text = text
    .replace(/^(?:音乐提示词|作曲提示词|提示词|prompt)\s*[:：]\s*/iu, '')
    .trim();
  const quoted = /^["'「『]([\s\S]+)["'」』]$/u.exec(text);
  if (quoted) text = quoted[1].trim();
  return text;
}

function cleanGeneratedThreeDPrompt(raw: string): string {
  let text = raw.trim();
  const fence = /^```[^\n]*\n([\s\S]*?)\n```$/.exec(text);
  if (fence) text = fence[1].trim();
  text = text
    .replace(/^(?:3d\s*模型提示词|三维模型提示词|建模提示词|提示词|prompt)\s*[:：]\s*/iu, '')
    .trim();
  const quoted = /^["'「『]([\s\S]+)["'」』]$/u.exec(text);
  if (quoted) text = quoted[1].trim();
  return text;
}

/**
 * Step 1 of the fixed two-step image flow: send the user's description to the
 * selected coding/text model and have it author a high-quality image-generation
 * prompt. Returns null when no text-model backend is reachable (e.g. browser
 * without an API key) so the caller can fall back to the raw user text. Honors
 * the channel's abort signal (direct) and cliRunIds (CLI) so 停止 cancels it.
 */
async function refineImagePromptViaModel(
  ch: AiEditChannel,
  userText: string,
  codingSelection: GatewaySelection,
  permission: string,
  onProgress: (live: string) => void,
): Promise<{ prompt: string; routeLine: string; routeHeader: string } | null> {
  const userContent = `请把下面的图片需求改写成一段高质量的生图提示词：\n\n${userText}`;
  const projectMcpGuidance = projectMcpGuidanceForState(useStore.getState(), {
    workspaceId: ch.workspaceId,
    sessionId: ch.sessionId,
  });
  const preferCliForProjectMcp = isTauri() && !!projectMcpGuidance;
  const system = `${IMAGE_PROMPT_SYSTEM}${projectMcpGuidance}`;
  const direct = resolveDirectGatewayRoute(codingSelection);
  if (direct && !preferCliForProjectMcp) {
    let full = '';
    const text = await completeGatewayText({
      route: direct,
      system,
      userContent,
      maxTokens: 1024,
      signal: ch.abortController.signal,
      usageContext: { workspaceId: ch.workspaceId, sessionId: ch.sessionId },
      permission,
      cwd: ch.workspaceRootPath ?? undefined,
      onDelta: (chunk) => {
        full += chunk;
        onProgress(full);
      },
    });
    return {
      prompt: cleanGeneratedImagePrompt(full || text),
      routeLine: gatewayRouteLine(direct),
      routeHeader: gatewayRouteHeader(direct),
    };
  }
  if (isTauri()) {
    if (isFreeChannelSelection(codingSelection)) {
      await ensureFreeProxy(freeProxyOptionsForSelection(codingSelection));
    }
    const cli = await resolveCliGatewayRoute(codingSelection);
    const runId = makeCliRunId();
    ch.cliRunIds.add(runId);
    try {
      let live = '';
      const text = await aiEditViaCli(
        `${system}\n\n${userContent}`,
        cli.adapter,
        {
          permission,
          model: cli.model,
          cliCommand: cli.cliCommand,
          env: cli.env,
          cwd: ch.workspaceRootPath ?? undefined,
          runId,
          onProgress: (chunk) => {
            live += chunk;
            onProgress(live);
          },
        },
      );
      return {
        prompt: cleanGeneratedImagePrompt(text || live),
        routeLine: gatewayRouteLine(cli),
        routeHeader: gatewayRouteHeader(cli),
      };
    } finally {
      ch.cliRunIds.delete(runId);
    }
  }
  return null;
}

async function refineMusicPromptViaModel(
  ch: AiEditChannel,
  userText: string,
  codingSelection: GatewaySelection,
  permission: string,
  onProgress: (live: string) => void,
): Promise<{ prompt: string; routeLine: string; routeHeader: string } | null> {
  const userContent = `请把下面的音乐需求改写成一段高质量的音乐生成提示词：\n\n${userText}`;
  const projectMcpGuidance = projectMcpGuidanceForState(useStore.getState(), {
    workspaceId: ch.workspaceId,
    sessionId: ch.sessionId,
  });
  const preferCliForProjectMcp = isTauri() && !!projectMcpGuidance;
  const system = `${MUSIC_PROMPT_SYSTEM}${projectMcpGuidance}`;
  const direct = resolveDirectGatewayRoute(codingSelection);
  if (direct && !preferCliForProjectMcp) {
    let full = '';
    const text = await completeGatewayText({
      route: direct,
      system,
      userContent,
      maxTokens: 1024,
      signal: ch.abortController.signal,
      usageContext: { workspaceId: ch.workspaceId, sessionId: ch.sessionId },
      permission,
      cwd: ch.workspaceRootPath ?? undefined,
      onDelta: (chunk) => {
        full += chunk;
        onProgress(full);
      },
    });
    return {
      prompt: cleanGeneratedMusicPrompt(full || text),
      routeLine: gatewayRouteLine(direct),
      routeHeader: gatewayRouteHeader(direct),
    };
  }
  if (isTauri()) {
    if (isFreeChannelSelection(codingSelection)) {
      await ensureFreeProxy(freeProxyOptionsForSelection(codingSelection));
    }
    const cli = await resolveCliGatewayRoute(codingSelection);
    const runId = makeCliRunId();
    ch.cliRunIds.add(runId);
    try {
      let live = '';
      const text = await aiEditViaCli(
        `${system}\n\n${userContent}`,
        cli.adapter,
        {
          permission,
          model: cli.model,
          cliCommand: cli.cliCommand,
          env: cli.env,
          cwd: ch.workspaceRootPath ?? undefined,
          runId,
          onProgress: (chunk) => {
            live += chunk;
            onProgress(live);
          },
        },
      );
      return {
        prompt: cleanGeneratedMusicPrompt(text || live),
        routeLine: gatewayRouteLine(cli),
        routeHeader: gatewayRouteHeader(cli),
      };
    } finally {
      ch.cliRunIds.delete(runId);
    }
  }
  return null;
}

async function refineThreeDPromptViaModel(
  ch: AiEditChannel,
  userText: string,
  codingSelection: GatewaySelection,
  permission: string,
  onProgress: (live: string) => void,
): Promise<{ prompt: string; routeLine: string; routeHeader: string } | null> {
  const userContent = `请把下面的 3D 模型需求改写成一段高质量的文生 3D 提示词。
${threeDRiggingPromptGuidance(userText)}

原始需求：
${userText}`;
  const projectMcpGuidance = projectMcpGuidanceForState(useStore.getState(), {
    workspaceId: ch.workspaceId,
    sessionId: ch.sessionId,
  });
  const preferCliForProjectMcp = isTauri() && !!projectMcpGuidance;
  const system = `${THREE_D_PROMPT_SYSTEM}${projectMcpGuidance}`;
  const direct = resolveDirectGatewayRoute(codingSelection);
  if (direct && !preferCliForProjectMcp) {
    let full = '';
    const text = await completeGatewayText({
      route: direct,
      system,
      userContent,
      maxTokens: 1024,
      signal: ch.abortController.signal,
      usageContext: { workspaceId: ch.workspaceId, sessionId: ch.sessionId },
      permission,
      cwd: ch.workspaceRootPath ?? undefined,
      onDelta: (chunk) => {
        full += chunk;
        onProgress(full);
      },
    });
    return {
      prompt: cleanGeneratedThreeDPrompt(full || text),
      routeLine: gatewayRouteLine(direct),
      routeHeader: gatewayRouteHeader(direct),
    };
  }
  if (isTauri()) {
    if (isFreeChannelSelection(codingSelection)) {
      await ensureFreeProxy(freeProxyOptionsForSelection(codingSelection));
    }
    const cli = await resolveCliGatewayRoute(codingSelection);
    const runId = makeCliRunId();
    ch.cliRunIds.add(runId);
    try {
      let live = '';
      const text = await aiEditViaCli(
        `${system}\n\n${userContent}`,
        cli.adapter,
        {
          permission,
          model: cli.model,
          cliCommand: cli.cliCommand,
          env: cli.env,
          cwd: ch.workspaceRootPath ?? undefined,
          runId,
          onProgress: (chunk) => {
            live += chunk;
            onProgress(live);
          },
        },
      );
      return {
        prompt: cleanGeneratedThreeDPrompt(text || live),
        routeLine: gatewayRouteLine(cli),
        routeHeader: gatewayRouteHeader(cli),
      };
    } finally {
      ch.cliRunIds.delete(runId);
    }
  }
  return null;
}

function startImageGenerationTurn(
  text: string,
  options: { providerId?: ImageProviderId; model?: string } = {},
): void {
  const prompt = stripImageCommand(text);
  if (!prompt) return;
  const state = useStore.getState();
  if (isWorkflowReadOnly(state)) return;
  const generationPrompt = modeContextPrompt(state, 'image', prompt);
  const sessionKey = activeWorkflowSessionKey(state);
  const settings = loadImageGenerationSettings();
  if (!settings.enabled) return;
  const providerId = options.providerId ?? preferredReadyImageProviderId(settings);
  // The coding/text model that authors the image prompt (step 1) is the channel
  // the composer currently has selected — image mode only swaps the image
  // provider selectors, not composer.model. Permission mirrors the composer so a
  // CLI run behaves like the rest of the app.
  const codingSelection = workflowDefaultGatewaySelection(
    state.workflow,
    state.composer.model,
  );
  const codingPermission = state.composer.permission || 'full';

  if (state.blockedSendTip) useStore.setState({ blockedSendTip: null });

  const now = Date.now();
  const providerLabel = providerId
    ? imageProviderById(providerId).label
    : 'Image generation';
  const model = providerId
    ? options.model?.trim() ||
      settings.providerModels[providerId]?.trim() ||
      imageProviderById(providerId).defaultModel
    : options.model?.trim() || '';
  const userMsg: Message = {
    id: shortId('m'),
    role: 'user',
    text,
    createdAt: now,
  };
  const assistantId = shortId('m');
  const assistantMsg: Message = {
    id: assistantId,
    role: 'assistant',
    text: `⚙ 出图：${providerLabel}${model ? ` · 模型：${model}` : ''}\n① 正在让模型撰写生图提示词…`,
    routeLabel: model ? `${providerLabel} · ${model}` : providerLabel,
    createdAt: now + 1,
  };
  const promptUpdate = applyPromptTitle(state, prompt, now);
  const activeSession = sessionForKey(state, sessionKey);
  const simpleMode = promptUpdate.workflow.meta?.simple === true;
  const baseMessages = state.messages;
  const chSessionKey = runKey(sessionKey.workspaceId, sessionKey.sessionId);
  const workspaceRootPath = sessionChangesRootPathForSession(state, sessionKey);
  const ch: AiEditChannel = {
    key: chatTurnKey(chSessionKey, userMsg.id),
    sessionKey: chSessionKey,
    workspaceId: sessionKey.workspaceId,
    sessionId: sessionKey.sessionId,
    workspaceRootPath,
    workflow: promptUpdate.workflow,
    messages: [...baseMessages, userMsg, assistantMsg],
    cliRunIds: new Set<string>(),
    abortController: new AbortController(),
    workflowSession: activeSession?.isWorkflow ?? !simpleMode,
    chat: true,
    ownedMessageIds: new Set<string>([userMsg.id, assistantId]),
  };

  const setAssistant = (textValue: string, persist: boolean) => {
    if (!aiEditRegistered(ch)) return;
    ch.messages = ch.messages.map((message) =>
      message.id === assistantId
        ? {
            ...message,
            text: textValue,
            routeLabel: model ? `${providerLabel} · ${model}` : providerLabel,
          }
        : message,
    );
    aiEditCommitMessages(ch, persist);
  };

  addAiEditChannel(ch);
  if (aiEditViewActive(ch)) {
    useStore.setState({
      messages: ch.messages,
      sessions: promptUpdate.sessions,
      sessionTree: promptUpdate.sessionTree,
      workflow: ch.workflow,
    });
  }
  updateAiEditSessionSummary(ch);
  if (ch.workspaceId && ch.sessionId) {
    void historyStore
      .updateSession(ch.workspaceId, ch.sessionId, {
        messages: ch.messages,
        ...(ch.workflowSession ? { workflow: ch.workflow } : {}),
        meta: { runStatus: 'running' },
      })
      .catch(() => {});
  }
  syncAndPersistSessionRunStatus(sessionKey, 'running');

  void (async () => {
    const startedAt = Date.now();
    const elapsed = () =>
      `⏱ ${formatClock(startedAt)} → ${formatClock(Date.now())} · 耗时 ${formatDuration(
        Date.now() - startedAt,
      )}`;
    try {
      // ── Step ① — ask the selected coding/text model to author the image
      // prompt. When no text-model backend is reachable (browser without an API
      // key, tests) refineImagePromptViaModel returns null and we fall back to
      // the raw user text so image generation still works end to end.
      let imagePrompt = generationPrompt;
      let refineHeader = '';
      try {
        const refined = await refineImagePromptViaModel(
          ch,
          generationPrompt,
          codingSelection,
          codingPermission,
          (live) => {
            if (!aiEditRegistered(ch)) return;
            setAssistant(
              `${elapsed()}\n① 撰写生图提示词中…\n\n${live.trim() || '⟳ 生成中…'}`,
              false,
            );
          },
        );
        if (refined && refined.prompt) {
          imagePrompt = refined.prompt;
          refineHeader = refined.routeHeader;
        }
      } catch (err) {
        if (ch.abortController.signal.aborted || !aiEditRegistered(ch)) return;
        // Prompt authoring failed (model error/timeout). Degrade to the raw
        // user text rather than failing the whole turn.
        imagePrompt = generationPrompt;
      }
      if (!aiEditRegistered(ch)) return;

      // ── Step ② — feed the authored prompt to the image model. `text:false`
      // skips stripImageCommand inside generateImage (already a clean prompt).
      const promptModelLine = refineHeader
        ? `✎ 提示词模型：${refineHeader}\n`
        : '';
      setAssistant(
        `${elapsed()}\n${promptModelLine}② 已生成提示词，正在出图…\n\n生图提示词：${imagePrompt}`,
        false,
      );
      const result = await generateImage(
        {
          prompt: imagePrompt,
          providerId: options.providerId,
          model: options.model,
          signal: ch.abortController.signal,
        },
        settings,
      );
      const body = imageResultMarkdown(result);
      setAssistant(`${elapsed()}\n${promptModelLine}${body}`, true);
      commitAiChannelBlueprint(ch, appendStartUserInputs(ch.workflow, [text]));
      syncAndPersistSessionRunStatus(sessionKey, 'success');
    } catch (err) {
      if (!aiEditRegistered(ch)) return;
      const msg = err instanceof Error ? err.message : String(err);
      setAssistant(
        `${elapsed()} · 失败\n✗ 图片生成失败: ${msg}\n\n请在设置 > 生图中配置可用的图片 Provider，或切换到本地 ComfyUI。`,
        true,
      );
      syncAndPersistSessionRunStatus(sessionKey, 'error');
    } finally {
      removeAiEditChannel(ch);
    }
  })();
}

function startMusicGenerationTurn(
  text: string,
  options: { providerId?: MusicProviderId; model?: string } = {},
): void {
  const prompt = stripMusicCommand(text);
  if (!prompt) return;
  const state = useStore.getState();
  if (isWorkflowReadOnly(state)) return;
  const generationPrompt = modeContextPrompt(state, 'music', prompt);
  const sessionKey = activeWorkflowSessionKey(state);
  const settings = loadMusicGenerationSettings();
  if (!settings.enabled) return;
  const providerId = options.providerId ?? preferredReadyMusicProviderId(settings);
  const codingSelection = workflowDefaultGatewaySelection(
    state.workflow,
    state.composer.model,
  );
  const codingPermission = state.composer.permission || 'full';

  if (state.blockedSendTip) useStore.setState({ blockedSendTip: null });

  const now = Date.now();
  const providerLabel = providerId
    ? musicProviderById(providerId).label
    : 'Music generation';
  const provider = providerId ? musicProviderById(providerId) : null;
  const model = providerId
    ? options.model?.trim() || musicProviderModel(providerId, settings)
    : options.model?.trim() || '';
  const userMsg: Message = {
    id: shortId('m'),
    role: 'user',
    text,
    createdAt: now,
  };
  const assistantId = shortId('m');
  const assistantMsg: Message = {
    id: assistantId,
    role: 'assistant',
    text: `⚙ 作曲：${providerLabel}${model ? ` · 模型：${model}` : ''}\n① 正在让模型撰写音乐提示词…`,
    routeLabel: model ? `${providerLabel} · ${model}` : providerLabel,
    createdAt: now + 1,
  };
  const promptUpdate = applyPromptTitle(state, prompt, now);
  const activeSession = sessionForKey(state, sessionKey);
  const simpleMode = promptUpdate.workflow.meta?.simple === true;
  const baseMessages = state.messages;
  const chSessionKey = runKey(sessionKey.workspaceId, sessionKey.sessionId);
  const workspaceRootPath = sessionChangesRootPathForSession(state, sessionKey);
  const ch: AiEditChannel = {
    key: chatTurnKey(chSessionKey, userMsg.id),
    sessionKey: chSessionKey,
    workspaceId: sessionKey.workspaceId,
    sessionId: sessionKey.sessionId,
    workspaceRootPath,
    workflow: promptUpdate.workflow,
    messages: [...baseMessages, userMsg, assistantMsg],
    cliRunIds: new Set<string>(),
    abortController: new AbortController(),
    workflowSession: activeSession?.isWorkflow ?? !simpleMode,
    chat: true,
    ownedMessageIds: new Set<string>([userMsg.id, assistantId]),
  };

  const setAssistant = (textValue: string, persist: boolean) => {
    if (!aiEditRegistered(ch)) return;
    ch.messages = ch.messages.map((message) =>
      message.id === assistantId
        ? {
            ...message,
            text: textValue,
            routeLabel: model ? `${providerLabel} · ${model}` : providerLabel,
          }
        : message,
    );
    aiEditCommitMessages(ch, persist);
  };

  addAiEditChannel(ch);
  if (aiEditViewActive(ch)) {
    useStore.setState({
      messages: ch.messages,
      sessions: promptUpdate.sessions,
      sessionTree: promptUpdate.sessionTree,
      workflow: ch.workflow,
    });
  }
  updateAiEditSessionSummary(ch);
  if (ch.workspaceId && ch.sessionId) {
    void historyStore
      .updateSession(ch.workspaceId, ch.sessionId, {
        messages: ch.messages,
        ...(ch.workflowSession ? { workflow: ch.workflow } : {}),
        meta: { runStatus: 'running' },
      })
      .catch(() => {});
  }
  syncAndPersistSessionRunStatus(sessionKey, 'running');

  void (async () => {
    const startedAt = Date.now();
    const elapsed = () =>
      `⏱ ${formatClock(startedAt)} → ${formatClock(Date.now())} · 耗时 ${formatDuration(
        Date.now() - startedAt,
      )}`;
    try {
      let musicPrompt = generationPrompt;
      let refineHeader = '';
      try {
        const refined = await refineMusicPromptViaModel(
          ch,
          generationPrompt,
          codingSelection,
          codingPermission,
          (live) => {
            if (!aiEditRegistered(ch)) return;
            setAssistant(
              `${elapsed()}\n① 撰写音乐提示词中…\n\n${live.trim() || '⟳ 生成中…'}`,
              false,
            );
          },
        );
        if (refined && refined.prompt) {
          musicPrompt = refined.prompt;
          refineHeader = refined.routeHeader;
        }
      } catch (err) {
        if (ch.abortController.signal.aborted || !aiEditRegistered(ch)) return;
        musicPrompt = generationPrompt;
      }
      if (!aiEditRegistered(ch)) return;
      const promptModelLine = refineHeader
        ? `✎ 提示词模型：${refineHeader}\n`
        : '';
      setAssistant(
        `${elapsed()}\n${promptModelLine}② 已生成提示词，正在调用${
          provider?.local ? '本地音乐模型' : '音乐 API'
        }…\n\n音乐提示词：${musicPrompt}`,
        false,
      );
      const result = await generateMusic(
        {
          prompt: musicPrompt,
          providerId: options.providerId,
          model: options.model,
          targetDurationSeconds:
            musicDurationSecondsFromPrompt(musicPrompt) ?? undefined,
          signal: ch.abortController.signal,
        },
        settings,
      );
      setAssistant(`${elapsed()}\n${promptModelLine}${musicResultMarkdown(result)}`, true);
      commitAiChannelBlueprint(ch, appendStartUserInputs(ch.workflow, [text]));
      syncAndPersistSessionRunStatus(sessionKey, 'success');
    } catch (err) {
      if (!aiEditRegistered(ch)) return;
      const msg = err instanceof Error ? err.message : String(err);
      setAssistant(
        `${elapsed()} · 失败\n✗ 音乐生成失败: ${msg}\n\n请在设置 > 音乐渠道中配置可用的商用或免费 Provider。`,
        true,
      );
      syncAndPersistSessionRunStatus(sessionKey, 'error');
    } finally {
      removeAiEditChannel(ch);
    }
  })();
}

function startThreeDGenerationTurn(
  text: string,
  options: { providerId?: ThreeDProviderId; model?: string } = {},
): void {
  const prompt = stripThreeDCommand(text);
  if (!prompt) return;
  const state = useStore.getState();
  if (isWorkflowReadOnly(state)) return;
  const generationPrompt = modeContextPrompt(state, 'threeD', prompt);
  const sessionKey = activeWorkflowSessionKey(state);
  const settings = loadThreeDGenerationSettings();
  if (!settings.enabled) return;
  const providerId = options.providerId ?? preferredReadyThreeDProviderId(settings);
  const codingSelection = workflowDefaultGatewaySelection(
    state.workflow,
    state.composer.model,
  );
  const codingPermission = state.composer.permission || 'full';

  if (state.blockedSendTip) useStore.setState({ blockedSendTip: null });

  const now = Date.now();
  const providerLabel = providerId
    ? threeDProviderById(providerId).label
    : '3D generation';
  const provider = providerId ? threeDProviderById(providerId) : null;
  const model = providerId
    ? options.model?.trim() || threeDProviderModel(providerId, settings)
    : options.model?.trim() || '';
  const rigging = assessThreeDRigging(generationPrompt);
  const userMsg: Message = {
    id: shortId('m'),
    role: 'user',
    text,
    createdAt: now,
  };
  const assistantId = shortId('m');
  const assistantMsg: Message = {
    id: assistantId,
    role: 'assistant',
    text: `⚙ 3D：${providerLabel}${model ? ` · 模型：${model}` : ''}\n骨骼：${
      rigging.enabled
        ? `可绑骨资产，默认预览 ${rigging.defaultAnimations.join('、')}${
            rigging.requestedAnimations.length
              ? `，额外动作 ${rigging.requestedAnimations.join('、')}${
                  rigging.needsAnimationSearch ? ' 需匹配动画库' : ''
                }`
              : ''
          }`
        : '静态资产，跳过'
    }\n① 正在让模型撰写 3D 提示词…`,
    routeLabel: model ? `${providerLabel} · ${model}` : providerLabel,
    createdAt: now + 1,
  };
  const promptUpdate = applyPromptTitle(state, prompt, now);
  const activeSession = sessionForKey(state, sessionKey);
  const simpleMode = promptUpdate.workflow.meta?.simple === true;
  const baseMessages = state.messages;
  const chSessionKey = runKey(sessionKey.workspaceId, sessionKey.sessionId);
  const workspaceRootPath = sessionChangesRootPathForSession(state, sessionKey);
  const ch: AiEditChannel = {
    key: chatTurnKey(chSessionKey, userMsg.id),
    sessionKey: chSessionKey,
    workspaceId: sessionKey.workspaceId,
    sessionId: sessionKey.sessionId,
    workspaceRootPath,
    workflow: promptUpdate.workflow,
    messages: [...baseMessages, userMsg, assistantMsg],
    cliRunIds: new Set<string>(),
    abortController: new AbortController(),
    workflowSession: activeSession?.isWorkflow ?? !simpleMode,
    chat: true,
    ownedMessageIds: new Set<string>([userMsg.id, assistantId]),
  };

  const setAssistant = (textValue: string, persist: boolean) => {
    if (!aiEditRegistered(ch)) return;
    ch.messages = ch.messages.map((message) =>
      message.id === assistantId
        ? {
            ...message,
            text: textValue,
            routeLabel: model ? `${providerLabel} · ${model}` : providerLabel,
          }
        : message,
    );
    aiEditCommitMessages(ch, persist);
  };

  addAiEditChannel(ch);
  if (aiEditViewActive(ch)) {
    useStore.setState({
      messages: ch.messages,
      sessions: promptUpdate.sessions,
      sessionTree: promptUpdate.sessionTree,
      workflow: ch.workflow,
    });
  }
  updateAiEditSessionSummary(ch);
  if (ch.workspaceId && ch.sessionId) {
    void historyStore
      .updateSession(ch.workspaceId, ch.sessionId, {
        messages: ch.messages,
        ...(ch.workflowSession ? { workflow: ch.workflow } : {}),
        meta: { runStatus: 'running' },
      })
      .catch(() => {});
  }
  syncAndPersistSessionRunStatus(sessionKey, 'running');

  void (async () => {
    const startedAt = Date.now();
    const elapsed = () =>
      `⏱ ${formatClock(startedAt)} → ${formatClock(Date.now())} · 耗时 ${formatDuration(
        Date.now() - startedAt,
      )}`;
    try {
      let threeDPrompt = generationPrompt;
      let refineHeader = '';
      try {
        const refined = await refineThreeDPromptViaModel(
          ch,
          generationPrompt,
          codingSelection,
          codingPermission,
          (live) => {
            if (!aiEditRegistered(ch)) return;
            setAssistant(
              `${elapsed()}\n① 撰写 3D 提示词中…\n\n${live.trim() || '⟳ 生成中…'}`,
              false,
            );
          },
        );
        if (refined && refined.prompt) {
          threeDPrompt = refined.prompt;
          refineHeader = refined.routeHeader;
        }
      } catch {
        if (ch.abortController.signal.aborted || !aiEditRegistered(ch)) return;
        threeDPrompt = generationPrompt;
      }
      if (!aiEditRegistered(ch)) return;
      const promptModelLine = refineHeader
        ? `✎ 提示词模型：${refineHeader}\n`
        : '';
      setAssistant(
        `${elapsed()}\n${promptModelLine}② 已生成提示词，正在调用${
          provider?.local ? '本地 3D 模型' : '3D API'
        }…\n\n3D 提示词：${threeDPrompt}`,
        false,
      );
      const result = await generateThreeD(
        {
          prompt: threeDPrompt,
          providerId: options.providerId,
          model: options.model,
          signal: ch.abortController.signal,
        },
        settings,
      );
      setAssistant(
        `${elapsed()}\n${promptModelLine}③ 3D 模型已生成，正在下载到本地缓存…\n\n3D 提示词：${threeDPrompt}`,
        false,
      );
      const downloads = await downloadThreeDAssets(
        result.assets,
        state.composer.workspace || undefined,
      );
      setAssistant(
        `${elapsed()}\n${promptModelLine}${threeDResultMarkdown({
          ...result,
          ...downloads,
        })}`,
        true,
      );
      commitAiChannelBlueprint(ch, appendStartUserInputs(ch.workflow, [text]));
      syncAndPersistSessionRunStatus(sessionKey, 'success');
    } catch (err) {
      if (!aiEditRegistered(ch)) return;
      const msg = err instanceof Error ? err.message : String(err);
      setAssistant(
        `${elapsed()} · 失败\n✗ 3D 模型生成失败: ${msg}\n\n${threeDFailureHint(msg)}`,
        true,
      );
      syncAndPersistSessionRunStatus(sessionKey, 'error');
    } finally {
      removeAiEditChannel(ch);
    }
  })();
}

function startMeshSearchTurn(text: string): void {
  const query = stripMeshSearchCommand(text);
  const state = useStore.getState();
  if (isWorkflowReadOnly(state)) return;
  const sessionKey = activeWorkflowSessionKey(state);
  const settings = loadMeshLibrarySettings();

  if (state.blockedSendTip) useStore.setState({ blockedSendTip: null });

  const now = Date.now();
  const enabledLabels = settings.enabledIds
    .map((id) => meshLibraryById(id)?.label)
    .filter((label): label is string => !!label);
  const userMsg: Message = {
    id: shortId('m'),
    role: 'user',
    text,
    createdAt: now,
  };
  const assistantId = shortId('m');
  const assistantMsg: Message = {
    id: assistantId,
    role: 'assistant',
    text: query
      ? `🔎 在线模型库搜索：${query}\n库：${
          enabledLabels.length ? enabledLabels.join('、') : '未启用任何模型库'
        }\n① 正在搜索…`
      : '🔎 在线模型库搜索\n请在 /mesh-search 后输入要搜索的关键字。',
    routeLabel: '在线模型库',
    createdAt: now + 1,
  };
  const promptUpdate = applyPromptTitle(state, query || '在线模型库搜索', now);
  const activeSession = sessionForKey(state, sessionKey);
  const simpleMode = promptUpdate.workflow.meta?.simple === true;
  const baseMessages = state.messages;
  const chSessionKey = runKey(sessionKey.workspaceId, sessionKey.sessionId);
  const workspaceRootPath = sessionChangesRootPathForSession(state, sessionKey);
  const ch: AiEditChannel = {
    key: chatTurnKey(chSessionKey, userMsg.id),
    sessionKey: chSessionKey,
    workspaceId: sessionKey.workspaceId,
    sessionId: sessionKey.sessionId,
    workspaceRootPath,
    workflow: promptUpdate.workflow,
    messages: [...baseMessages, userMsg, assistantMsg],
    cliRunIds: new Set<string>(),
    abortController: new AbortController(),
    workflowSession: activeSession?.isWorkflow ?? !simpleMode,
    chat: true,
    ownedMessageIds: new Set<string>([userMsg.id, assistantId]),
  };

  const setAssistant = (textValue: string, persist: boolean) => {
    if (!aiEditRegistered(ch)) return;
    ch.messages = ch.messages.map((message) =>
      message.id === assistantId
        ? { ...message, text: textValue, routeLabel: '在线模型库' }
        : message,
    );
    aiEditCommitMessages(ch, persist);
  };

  addAiEditChannel(ch);
  if (aiEditViewActive(ch)) {
    useStore.setState({
      messages: ch.messages,
      sessions: promptUpdate.sessions,
      sessionTree: promptUpdate.sessionTree,
      workflow: ch.workflow,
    });
  }
  updateAiEditSessionSummary(ch);

  if (!query) {
    setAssistant(
      '🔎 在线模型库搜索\n请在 /mesh-search 后输入要搜索的关键字，例如 `/mesh-search 低多边形宝箱`。',
      true,
    );
    commitAiChannelBlueprint(ch, appendStartUserInputs(ch.workflow, [text]));
    removeAiEditChannel(ch);
    return;
  }

  if (ch.workspaceId && ch.sessionId) {
    void historyStore
      .updateSession(ch.workspaceId, ch.sessionId, {
        messages: ch.messages,
        ...(ch.workflowSession ? { workflow: ch.workflow } : {}),
        meta: { runStatus: 'running' },
      })
      .catch(() => {});
  }
  syncAndPersistSessionRunStatus(sessionKey, 'running');

  void (async () => {
    const startedAt = Date.now();
    const elapsed = () =>
      `⏱ ${formatClock(startedAt)} → ${formatClock(Date.now())} · 耗时 ${formatDuration(
        Date.now() - startedAt,
      )}`;
    try {
      const result = await searchMeshLibraries(query, settings, ch.abortController.signal);
      if (!aiEditRegistered(ch)) return;
      const downloadable = result.items.filter(
        (item) => item.downloadUrl && item.libraryId !== 'sketchfab',
      ).length;
      setAssistant(
        `${elapsed()}\n② 找到 ${result.items.length} 个可预览结果${
          downloadable > 0 && settings.autoDownload
            ? `，正在下载 ${downloadable} 个可直接下载的模型…`
            : '…'
        }`,
        false,
      );
      const downloaded = await downloadMeshSearchAssets(
        result,
        settings,
        state.composer.workspace || undefined,
      );
      if (!aiEditRegistered(ch)) return;
      setAssistant(`${elapsed()}\n${meshSearchResultMarkdown(result, downloaded)}`, true);
      commitAiChannelBlueprint(ch, appendStartUserInputs(ch.workflow, [text]));
      syncAndPersistSessionRunStatus(sessionKey, 'success');
    } catch (err) {
      if (!aiEditRegistered(ch)) return;
      const msg = err instanceof Error ? err.message : String(err);
      setAssistant(
        `${elapsed()} · 失败\n✗ 在线模型库搜索失败: ${msg}\n\n请检查网络，或在项目设置 > 模型库中配置账号 API Key 后重试。`,
        true,
      );
      syncAndPersistSessionRunStatus(sessionKey, 'error');
    } finally {
      removeAiEditChannel(ch);
    }
  })();
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
    ...(ch.nodeHashes ? { nodeHashes: ch.nodeHashes } : {}),
    updatedAt: Date.now(),
  };
}

/**
 * Persist the channel's shadow to its OWNING session (not the active view).
 * When the run has no history context (browser/simulator) it falls back to the
 * active-session path only while that run is the visible session. Deliberately
 * skips `.fuc.json` file autosave for backgrounded runs so a background run
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
    scheduleSessionRunCompletedNotification(
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

function cloneAiEditSnapshot(ch: AiEditChannel): AiEditChannel {
  return {
    ...ch,
    messages: [...ch.messages],
    cliRunIds: new Set(ch.cliRunIds),
    ownedMessageIds: ch.ownedMessageIds
      ? new Set(ch.ownedMessageIds)
      : undefined,
  };
}

function rememberAiEditSnapshot(ch: AiEditChannel): void {
  aiEditSnapshots.set(ch.key, cloneAiEditSnapshot(ch));
}

const AI_EDIT_PERSIST_DEBOUNCE_MS = 750;

interface PendingAiEditPersist {
  workspaceId: string;
  sessionId: string;
  patch: SessionPatch;
}

const pendingAiEditPersists = new Map<string, PendingAiEditPersist>();
const aiEditPersistTimers = new Map<string, ReturnType<typeof setTimeout>>();

function aiEditPersistKey(workspaceId: string, sessionId: string): string {
  return `${workspaceId}::${sessionId}`;
}

function flushAiEditPersistKey(key: string): void {
  const timer = aiEditPersistTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    aiEditPersistTimers.delete(key);
  }
  const pending = pendingAiEditPersists.get(key);
  if (!pending) return;
  pendingAiEditPersists.delete(key);
  void historyStore
    .updateSession(pending.workspaceId, pending.sessionId, pending.patch)
    .catch(() => {});
}

function flushAiEditPersist(ch: AiEditChannel | null): void {
  if (!ch?.workspaceId || !ch.sessionId) return;
  flushAiEditPersistKey(aiEditPersistKey(ch.workspaceId, ch.sessionId));
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  (timer as { unref?: () => void }).unref?.();
}

function scheduleAiEditPersist(
  ch: AiEditChannel,
  patch: SessionPatch,
  delayMs = AI_EDIT_PERSIST_DEBOUNCE_MS,
): void {
  if (!ch.workspaceId || !ch.sessionId) return;
  const key = aiEditPersistKey(ch.workspaceId, ch.sessionId);
  const prev = pendingAiEditPersists.get(key);
  pendingAiEditPersists.set(key, {
    workspaceId: ch.workspaceId,
    sessionId: ch.sessionId,
    patch: {
      ...(prev?.patch ?? {}),
      ...patch,
      meta: {
        ...(prev?.patch.meta ?? {}),
        ...(patch.meta ?? {}),
      },
    },
  });
  const timer = aiEditPersistTimers.get(key);
  if (timer) clearTimeout(timer);
  const nextTimer = setTimeout(() => flushAiEditPersistKey(key), delayMs);
  unrefTimer(nextTimer);
  aiEditPersistTimers.set(key, nextTimer);
}

function aiEditOwnedMessages(ch: AiEditChannel): Message[] {
  if (!ch.chat || !ch.ownedMessageIds) return ch.messages;
  return ch.messages.filter((message) => ch.ownedMessageIds?.has(message.id));
}

function mergeMessagesById(base: Message[], updates: Message[]): Message[] {
  if (updates.length === 0) return base;
  const byId = new Map(updates.map((message) => [message.id, message]));
  const merged = base.map((message) => byId.get(message.id) ?? message);
  const existing = new Set(base.map((message) => message.id));
  for (const message of updates) {
    if (!existing.has(message.id)) {
      merged.push(message);
      existing.add(message.id);
    }
  }
  return merged;
}

function aiEditBaseMessages(ch: AiEditChannel): Message[] {
  if (aiEditViewActive(ch)) return useStore.getState().messages;
  return getAiEditSnapshot(ch.workspaceId, ch.sessionId)?.messages ?? ch.messages;
}

function mergeAiEditChatMessages(ch: AiEditChannel): Message[] {
  if (!ch.chat) return ch.messages;
  ch.messages = mergeMessagesById(aiEditBaseMessages(ch), aiEditOwnedMessages(ch));
  return ch.messages;
}

function startInputsFromWorkflow(workflow: IRGraph): string[] {
  const startNode = workflow.nodes.find((node) => node.type === 'start');
  return readStartUserInputs(startNode?.params);
}

function aiEditBaseWorkflow(ch: AiEditChannel): IRGraph {
  if (aiEditViewActive(ch)) return useStore.getState().workflow;
  return getAiEditSnapshot(ch.workspaceId, ch.sessionId)?.workflow ?? ch.workflow;
}

function chatUserInputsFromMessages(messages: Message[]): string[] {
  return messages
    .filter((message) => message.role === 'user' && message.text.trim())
    .map((message) => message.text);
}

function mergeAiEditChatWorkflow(ch: AiEditChannel, nextIr: IRGraph): IRGraph {
  const messages = mergeAiEditChatMessages(ch);
  return setStartUserInputs(aiEditBaseWorkflow(ch), [
    ...chatUserInputsFromMessages(messages),
    ...startInputsFromWorkflow(nextIr),
  ]);
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
      ? (() => {
          const next: Session = {
            ...session,
            isWorkflow: ch.workflowSession,
            updatedAt,
            preview: last ? previewFromText(last) : session.preview,
            messageCount: ch.messages.length,
          };
          if (ch.workflowSession && ch.workflow.meta?.simple === true) {
            return { ...next, simple: true };
          }
          return { ...next, simple: undefined };
        })()
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

function persistAiEditMessages(ch: AiEditChannel, messages: Message[]): void {
  if (!ch.workspaceId || !ch.sessionId) return;
  scheduleAiEditPersist(ch, { messages });
}

function persistAiEditWorkflow(ch: AiEditChannel, messages: Message[]): void {
  if (!ch.workspaceId || !ch.sessionId) return;
  const { workflow } = ch;
  const patch = ch.workflowSession
    ? { messages, workflow, meta: emptyRunMeta() }
    : { messages, meta: emptyRunMeta() };
  scheduleAiEditPersist(ch, patch);
}

function aiEditCommitMessages(ch: AiEditChannel | null, persist: boolean): void {
  if (!aiEditRegistered(ch)) return;
  const messages = ch.chat ? mergeAiEditChatMessages(ch) : ch.messages;
  rememberAiEditSnapshot(ch);
  if (aiEditViewActive(ch)) {
    useStore.setState({ messages });
  }
  if (persist) {
    updateAiEditSessionSummary(ch);
    persistAiEditMessages(ch, messages);
  }
}

function aiEditCommitWorkflow(ch: AiEditChannel | null, persist: boolean): void {
  if (!aiEditRegistered(ch)) return;
  const messages = ch.chat ? mergeAiEditChatMessages(ch) : ch.messages;
  rememberAiEditSnapshot(ch);
  if (aiEditViewActive(ch)) {
    useStore.setState({
      messages,
      workflow: ch.workflow,
      selectedNodeId: null,
      dirty: ch.workflowSession,
      ...emptyRunProgress(),
    });
  }
  if (persist) {
    updateAiEditSessionSummary(ch);
    syncSessionRunStatus(
      { workspaceId: ch.workspaceId, sessionId: ch.sessionId },
      undefined,
    );
    persistAiEditWorkflow(ch, messages);
  }
}

function commitAiChannelBlueprint(ch: AiEditChannel, ir: IRGraph): boolean {
  if (!aiEditActive(ch)) return false;
  // [dynamic-only refactor] 非 chat 通道（蓝图编辑）已停用；保留路径只有 chat 模式，
  // 走 mergeAiEditChatWorkflow。原 else 分支用 prepareGraphEdit(含 autoLayout)，已停用，
  // 退化为仅节点编号归一化以保持编译与单节点聊天语义。
  ch.workflow = ch.chat
    ? mergeAiEditChatWorkflow(ch, ir)
    : normalizeWorkflowNodeNumbers(ir);
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
  const sessionKey = { workspaceId: ch.workspaceId, sessionId: ch.sessionId };
  const rootPath = ch.config.cwd;
  activeRuns.delete(ch.key);
  syncRunningSessions();
  refreshSessionChangesForKey(sessionKey, rootPath);
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

/** How many prior chat turns simple-workflow mode folds into the prompt for
 *  multi-turn context (bounded so long chats don't overflow the model). */
const SIMPLE_CHAT_HISTORY_TURNS = 20;

type RouteDisplay = Pick<
  ResolvedGatewayRoute,
  'adapter' | 'modelClass' | 'model' | 'providerName' | 'channelName' | 'label'
>;

function compactRoutePart(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function gatewayRouteLine(route: RouteDisplay | null | undefined): string {
  if (!route) return '';
  const provider = compactRoutePart(route.providerName);
  const channel = compactRoutePart(route.channelName);
  const model = compactRoutePart(route.model) || compactRoutePart(route.modelClass);
  const fallback = compactRoutePart(route.label) || compactRoutePart(route.adapter);
  const routeParts =
    provider && channel && provider !== channel
      ? [provider, channel]
      : [provider || channel || fallback];
  const routeText = routeParts.filter(Boolean).join(' · ');
  if (routeText && model) return `⚙ 路由：${routeText} · 模型：${model}`;
  if (routeText) return `⚙ 路由：${routeText}`;
  return model ? `⚙ 模型：${model}` : '';
}

function gatewayRouteHeader(route: RouteDisplay | null | undefined): string {
  if (!route) return '';
  const provider = compactRoutePart(route.providerName);
  const channel = compactRoutePart(route.channelName);
  const model = compactRoutePart(route.model) || compactRoutePart(route.modelClass);
  const fallback = compactRoutePart(route.label) || compactRoutePart(route.adapter);
  const routeParts =
    provider && channel && provider !== channel
      ? [provider, channel]
      : [provider || channel || fallback];
  const routeText = routeParts.filter(Boolean).join(' · ');
  return [routeText, model].filter(Boolean).join(' · ');
}

function routedBody(routeLine: string, body: string): string {
  const text = body.trim() ? body : '⟳ 生成中…';
  return routeLine ? `${routeLine}\n${text}` : text;
}

function transcriptText(message: Message): string {
  let text =
    message.role === 'assistant' && message.text.includes('<<FUC_TOOL>>')
      ? extractToolSentinels(message.text).text
      : message.text;
  text = text
    .replace(/^⏱ [^\n]*(?:\n|$)/, '')
    .replace(/^⚙ (?:路由|模型)：[^\n]*(?:\n|$)/, '')
    .trim();
  return text;
}

/** How many times to force a blueprint-only retry when the model gives prose. */
const MAX_BLUEPRINT_RETRIES = 2;

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
  // Prior run's per-node hashes (persisted in the run snapshot). Passed to the
  // engine on resume so a seeded output is reused only when the node's spec and
  // all its upstreams are unchanged — an edited subgraph re-runs instead of
  // silently reusing stale cache. Absent ⇒ engine falls back to legacy by-id reuse.
  const seedNodeHashes = resume ? state.workflow.meta.run?.nodeHashes : undefined;
  const initialRunState = resume
    ? seedRunStateFromOutputs(workflow, seedOutputs, state.runState)
    : {};
  if (resumeFromNodeId) delete initialRunState[resumeFromNodeId];

  // Capture the run's workspace + permission (from the AIDock controls) so each
  // node's CLI agent runs in the right dir with enough access to act without
  // stalling on permission prompts.
  const workspaceOptions = composerCliWorkspaceOptions(state.composer);
  const config: RunConfig = {
    ...workspaceOptions,
    permission: state.composer.permission || 'full',
    model: gatewaySelection.modelClass,
    gatewaySelection,
  };

  // Bind this run to the session that started it. The channel — not the active
  // view — is the run's source of truth from here on, so switching sessions
  // leaves it running in the background (writes route to its owning session).
  const ctx = getRunLaunchContext(state);
  const changesBaselineReady = ensureSessionChangeBaselineForKey(
    state,
    ctx,
    config.cwd,
  );
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
    text: `▶ ${action} "${name}"${from} · 开始 ${formatClock(runStartedAt)} · 运行时 ${adapter} · 模型 ${gatewaySelection.modelClass} · 权限 ${ch.config.permission}${formatRunWorkspaceSuffix(ch.config)}`,
    createdAt: runStartedAt,
  };
  ch.messages = [...ch.messages, runMsg];
  channelCommit(ch, 'running', true);

  // Advisory determinism lint: warn (don't block) when a codeblock uses
  // Date.now()/Math.random()/new Date(), which would make hash-checked resume
  // serve stale cache and throw under real Claude Code. See core/determinism.ts.
  // [dynamic-only refactor] 决定性 lint(findDeterminismHazards)已停用（蓝图模块 exclude）。
  // 该建议性告警仅在蓝图运行路径触发，纯聊天/ultracode 不经过此处。
  /*
  for (const finding of findDeterminismHazards(workflow)) {
    const node = workflow.nodes.find((n) => n.id === finding.nodeId);
    pushRunLog(
      ch,
      `⚠ ${node?.label ?? finding.nodeId}: ${finding.message}`,
      'system',
    );
  }
  */

  if (isTauri() || workflowHasDirectGatewayRoute(workflow, gatewaySelection)) {
    void (async () => {
      await changesBaselineReady;
      await executeViaCliInterpreter(ch, workflow, adapter, runStartedAt, {
        resumeFromNodeId,
        seedOutputs,
        seedNodeHashes,
      });
    })();
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
  await Promise.all(
    runIds.map((runId) =>
      Promise.resolve(cancelAiCli(runId)).catch(() => {}),
    ),
  );
}

async function cancelActiveAiEditRuns(ch: AiEditChannel | null): Promise<void> {
  const runIds = ch ? [...ch.cliRunIds] : [];
  await Promise.all(
    runIds.map((runId) =>
      Promise.resolve(cancelAiCli(runId)).catch(() => {}),
    ),
  );
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
    extraWorkspacePaths?: string[];
    permission?: string;
    timeoutSeconds?: number;
    idleTimeoutSeconds?: number;
    onProgress?: (text: string) => void;
    sessionId?: string;
    resume?: boolean;
    selection?: GatewaySelection;
  } = {},
): Promise<string> {
  const runId = makeCliRunId();
  ch.cliRunIds.add(runId);
  // Capture the backend's real token usage (cache hits included) so node runs
  // also feed true cache percentages into the meter instead of estimates.
  let realUsage: ModelUsageReport | null = null;
  try {
    const text = await aiEditViaCli(prompt, adapter, {
      ...opts,
      cliCommand: opts.cliCommand ?? ch.config.cliCommand,
      extraWorkspacePaths:
        opts.extraWorkspacePaths ?? ch.config.extraWorkspacePaths,
      env: opts.env,
      timeoutSeconds: opts.timeoutSeconds,
      idleTimeoutSeconds: opts.idleTimeoutSeconds,
      runId,
      onUsage: (raw) => {
        realUsage = mergeUsageReports(realUsage, usageReportFromCliUsage(raw));
      },
    });
    if (opts.selection) {
      const usageRoute = {
        baseUrl:
          opts.env?.ANTHROPIC_BASE_URL ||
          opts.env?.OPENAI_BASE_URL ||
          opts.env?.GOOGLE_GEMINI_BASE_URL,
        model: opts.model,
      };
      if (realUsage) {
        recordModelUsageForRoute(
          { ...usageRoute, selection: opts.selection },
          realUsage,
          {
            estimated: false,
            context: { workspaceId: ch.workspaceId, sessionId: ch.sessionId },
          },
        );
      } else {
        recordEstimatedModelUsageForSelection(
          opts.selection,
          prompt,
          text,
          usageRoute,
          {
            context: { workspaceId: ch.workspaceId, sessionId: ch.sessionId },
          },
        );
      }
    }
    return text;
  } finally {
    ch.cliRunIds.delete(runId);
  }
}

/**
 * Build the injected {@link RunGateway} for the desktop GUI. The "direct HTTP"
 * path stays `completeGatewayText` (browser fetch); the CLI subprocess path is
 * the Tauri spawn seam `invokeAgentCli` (which tracks the run's cliRunIds so the
 * stop button can cancel in-flight processes). Selection resolution and the
 * speed/timeout heuristics delegate to the existing lib helpers, so behaviour is
 * identical to the pre-refactor inline implementation.
 */
function buildGuiGateway(ch: RunChannel): RunGateway {
  const state = useStore.getState();
  const projectMcpGuidance = projectMcpGuidanceForState(state, {
    workspaceId: ch.workspaceId,
    sessionId: ch.sessionId,
  });
  const preferCliForProjectMcp = isTauri() && !!projectMcpGuidance;
  return {
    resolveDirectRoute: (selection) => {
      if (preferCliForProjectMcp) return null;
      const direct = resolveDirectGatewayRoute(selection);
      return direct ? { adapter: direct.adapter, model: direct.model } : null;
    },
    resolveCliRoute: async (selection) => {
      const cli = await resolveCliGatewayRoute(selection);
      return {
        adapter: cli.adapter,
        model: cli.model,
        cliCommand: cli.cliCommand,
        env: cli.env,
      };
    },
    completeText: async ({ selection, model, omitModel, prompt, onDelta }) => {
      // Re-resolve the full direct route (apiKey/baseUrl/transport) off the
      // selection, then apply the per-call model override exactly as the
      // pre-refactor invokeGatewayAgent did.
      const direct = resolveDirectGatewayRoute(selection);
      if (!direct) throw new Error('NO_MODEL_GATEWAY_BACKEND');
      const text = await completeGatewayText({
        route: { ...direct, model: omitModel ? undefined : model ?? direct.model },
        system: '',
        userContent: prompt,
        maxTokens: 8192,
        usageContext: { workspaceId: ch.workspaceId, sessionId: ch.sessionId },
        permission: ch.config.permission,
        cwd: ch.config.cwd,
        forceCli: preferCliForProjectMcp,
        onDelta,
      });
      return { text, adapter: direct.adapter };
    },
    spawnCliAgent: (prompt, adapter, opts) =>
      invokeAgentCli(ch, prompt, adapter, {
        selection: opts.selection,
        model: opts.model,
        env: opts.env,
        cwd: opts.cwd,
        extraWorkspacePaths: opts.extraWorkspacePaths,
        permission: opts.permission,
        timeoutSeconds: opts.timeoutSeconds,
        idleTimeoutSeconds: opts.idleTimeoutSeconds,
        cliCommand: opts.cliCommand,
        onProgress: opts.onProgress,
        sessionId: opts.sessionId,
        resume: opts.resume,
      }),
    applyOverride: (selection, override) =>
      applyGatewayOverride(selection, override),
    recordCall: (selection, timing) => recordModelCall(selection, timing),
    timeoutPolicy: (selection, prompt) =>
      timeoutPolicyForSelection(selection, prompt),
    effectiveConcurrency: (configured, selection) =>
      effectiveRunConcurrency(configured, selection),
    effectiveConsensusSamples: (configured, selection) =>
      effectiveConsensusSamples(configured, selection),
    nodeGatewayOverride: (nodeOrParams) => nodeGatewayOverride(nodeOrParams),
    modelClassFromModelId: (model) => modelClassFromModelId(model),
  };
}

function freeProxyOptionsForSelection(selection: GatewaySelection): {
  strict: true;
  modelOverrides?: Record<string, string>;
} {
  const freeChannelId = isFreeChannelSelection(selection);
  const modelOverride = selection.modelOverride?.trim();
  if (!freeChannelId || !modelOverride) return { strict: true };
  return {
    strict: true,
    modelOverrides: { [freeChannelId]: modelOverride },
  };
}

/** GUI-side {@link RunSpec} mirror (legacy string / object specs). */
interface RunSpec {
  prompt: string;
  label?: string;
  agentType?: string;
  model?: string;
  gateway?: NodeGatewayOverride;
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
/**
 * Is the run still active? (false once the user hits 停止 or the run ends.)
 * Keyed on the run channel — NOT the global `mode` — so the loop keeps executing
 * while the user views a different session (the run is backgrounded, not killed).
 */
function stillRunning(ch: RunChannel): boolean {
  return runActive(ch);
}

/**
 * GUI implementation of the headless engine's {@link RunCallbacks}. Maps each
 * run-engine side effect onto the run channel's shadow state + Zustand commits,
 * preserving the pre-refactor behaviour: node-state colouring, streaming dock
 * messages, system/assistant log lines, the stop-button cancel check, and the
 * React interaction widget. The engine's first-failure bookkeeping is mirrored
 * here (failedNodeId / error / channelCommit) so resume-from-failed keeps
 * working.
 */
function buildGuiCallbacks(
  ch: RunChannel,
  adapter: string,
  errorRef: { errored: boolean },
): RunCallbacks {
  return {
    onNodeStart: (node) => markRunNode(ch, node.id, 'running'),
    onNodeSuccess: (node, output) => {
      if (output !== null) {
        ch.runOutputs = { ...ch.runOutputs, [node.id]: output };
        if (!errorRef.errored) ch.failedNodeId = null;
      }
      markRunNode(ch, node.id, 'success');
    },
    onNodeFailure: (node, failure, state) => {
      // Only the first failure becomes the run's recorded error / resume point;
      // still-in-flight siblings that also fail don't clobber it.
      if (!errorRef.errored) {
        errorRef.errored = true;
        const runError = runFailureMeta(node, adapter, failure);
        ch.runState = { ...ch.runState, [node.id]: state };
        ch.failedNodeId = node.id;
        ch.error = runError;
        channelCommit(ch, state, true);
      } else {
        markRunNode(ch, node.id, state);
      }
    },
    onNodeRetry: (node) => markRunNode(ch, node.id, 'running'),
    onLog: (text, role) =>
      pushRunLog(
        ch,
        text,
        role === 'assistant' ? 'assistant' : 'system',
      ),
    beginStream: (header) => createStreamMessage(ch, header),
    isCancelled: () => !stillRunning(ch),
    promptInteraction: (req) => awaitInteraction(ch, req),
  };
}

/**
 * Build the engine {@link RuntimeRunContext} from the run channel + the host's
 * localStorage-tuned knobs (concurrency / retries / consensus samples) and the
 * GUI gateway. The engine never reads these globals — they are resolved here and
 * injected.
 */
function buildGuiRunContext(ch: RunChannel, workflow: IRGraph): RuntimeRunContext {
  const state = useStore.getState();
  const { personalInstructions, personalInstructionsByModel } = state;
  return {
    selection: runGlobalGatewaySelection(ch, workflow),
    personalInstructions,
    personalInstructionsByModel,
    globalInstructions: projectMcpGuidanceForState(state, {
      workspaceId: ch.workspaceId,
      sessionId: ch.sessionId,
    }),
    cwd: ch.config.cwd,
    extraWorkspacePaths: ch.config.extraWorkspacePaths,
    permission: ch.config.permission,
    concurrency: runConcurrency(),
    maxRetries: runMaxRetries(),
    consensusSamples: defaultConsensusSamples(),
    manifestMode: getManifestModeEnabled(),
    // Quantity-for-quality run-time voting: starting count (min) + escalation
    // ceiling (max). GUI default 2/16; a feature's max<=1 disables it.
    runtimeVoteSamplesMin: runtimeVoteSampleRange().min,
    runtimeVoteSamplesMax: runtimeVoteSampleRange().max,
    terminalVoteSamplesMin: terminalVoteSampleRange().min,
    terminalVoteSamplesMax: terminalVoteSampleRange().max,
    complexityScaling: complexityScaling(),
    adaptiveEscalation: adaptiveEscalationEnabled(),
    // Run-level guardrail: bound total escalation samples so a large graph can't
    // multiply the per-node ceiling by node count unbounded.
    escalationBudget: 64,
    escalationSpent: 0,
    gateway: buildGuiGateway(ch),
    cliCommand: ch.config.cliCommand,
  };
}

/** Default fan-out samples for a consensus node (localStorage fuc_consensus_default_samples). */
function defaultConsensusSamples(): number {
  try {
    if (typeof window !== 'undefined') {
      const raw = window.localStorage.getItem('fuc_consensus_default_samples');
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

/** Default number of workflow nodes executed concurrently (see runConcurrency). */
const DEFAULT_RUN_CONCURRENCY = 10;

/**
 * How many runnable nodes may execute at once. Each node is a heavy `claude -p`
 * process, so this absolute cap is combined with the model-speed tier caps from
 * Settings > Consensus. Tune it per machine via localStorage
 * (`fuc_run_concurrency`, clamped 1–16) or force the old strictly-sequential
 * behaviour with `fuc_sequential=1`. Linear chains stay sequential regardless
 * (a node still waits for its predecessors); the cap only bounds how many
 * *independent* nodes run together.
 */
function runConcurrency(): number {
  try {
    if (typeof window !== 'undefined') {
      if (window.localStorage.getItem('fuc_sequential') === '1') return 1;
      const raw = window.localStorage.getItem('fuc_run_concurrency');
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
 * How many times a failed node is automatically re-run before it is recorded as
 * failed. Only transient failures (see RETRYABLE_FAILURE_CODES) are retried.
 * Tune via localStorage (`fuc_run_max_retries`, clamped 0–10); set 0 to disable
 * auto-retry entirely.
 */
function runMaxRetries(): number {
  try {
    if (typeof window !== 'undefined') {
      const raw = window.localStorage.getItem('fuc_run_max_retries');
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
    seedNodeHashes?: Record<string, string>;
  } = {},
): Promise<void> {
  const launchSelection =
    ch.config.gatewaySelection ??
    workflowDefaultGatewaySelection(workflow, ch.config.model);
  // Free-channel runs are routed through the built-in local proxy. Ensure it is
  // up (and pointed at the latest keys/models) before the gateway route is
  // resolved, so the freshly-cached port is used. No-op on web.
  if (isFreeChannelSelection(launchSelection)) {
    await ensureFreeProxy(freeProxyOptionsForSelection(launchSelection));
    if (!stillRunning(ch)) return;
  }
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

  // The decoupled run engine (runtime/dag.ts) owns the DAG scheduling, per-node
  // dispatch, streaming, interaction, and auto-retry. The GUI supplies the host
  // side effects (callbacks) and host capabilities (gateway + tuned knobs via
  // context); the channel stays the run's shadow-state source of truth.
  const errorRef = { errored: false };
  const callbacks = buildGuiCallbacks(ch, adapter, errorRef);
  const context = buildGuiRunContext(ch, workflow);

  const result = await executeWorkflowDag(workflow, callbacks, context, {
    resumeFromNodeId: options.resumeFromNodeId,
    seedOutputs: options.seedOutputs,
    seedRunState: ch.runState,
    seedNodeHashes: options.seedNodeHashes,
  });

  // Record this run's per-node hashes so a later "continue" can validate which
  // cached outputs are still reusable (unchanged node + unchanged upstreams).
  if (result.nodeHashes) ch.nodeHashes = result.nodeHashes;

  if (runActive(ch)) {
    const runFinishedAt = Date.now();
    const errored = !result.success;
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
    if (errored && result.error) ch.error = result.error;
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
