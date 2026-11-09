import type { StoreApi } from 'zustand';
import type {
  ConsensusStrategy,
  GatewaySelection,
  IREndpoint,
  IRGraph,
  NodeGatewayOverride,
  NodeType,
  PinKind,
} from '@/core/ir';
import type {
  InteractionAnswer,
  InteractionRequest,
} from '@/core/interaction';
import type { PersonalInstructionsByModel } from '@/core/personalInstructions';
import type { GameExpertSettings } from '@/lib/gameExperts';
import type { OnGenerationSettled } from '@/lib/assetCapture';
import type { ImageProviderId } from '@/lib/imageGeneration';
import type { MusicProviderId } from '@/lib/musicGeneration';
import type { ThreeDProviderId } from '@/lib/threeDGeneration';
import type { VideoProviderId } from '@/lib/videoGeneration';
import type { AnimationProviderId } from '@/lib/animationGeneration';
import type { SpeechProviderId } from '@/lib/speechGeneration';
import type {
  AppearanceSettings,
  FontFamilyId,
  StreamSchemeId,
  StylePresetId,
} from '@/lib/appearance';
import type { Locale } from '@/lib/i18n';
import type { RunProgressSummary } from './runProgress';
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
  ScheduledTaskConfig,
} from './types';
import type { WorkspaceSummary } from './history/types';
import type { SkillMutationResult, SkillReviewState } from '@/runtime/skills/types';

export type WorkflowSessionKey = {
  workspaceId: string | null;
  sessionId: string | null;
};

export type BlockedSendTip =
  | 'model-switched-while-chatting'
  | {
      kind: 'slash-command-unavailable';
      message: string;
    };

export type WorkflowWriteSource = 'user' | 'ai';

/**
 * CONTRACT: the single zustand store shape. App.tsx and panels rely on this
 * exact surface — keep these fields and actions stable.
 *
 * SLICE DECOMPOSITION (where each part lives after the useStore slicing):
 *   - storeState.ts (this file): the StoreState interface — the canonical shape.
 *   - useStore.ts: create(), seeding, and all not-yet-extracted logic
 *     (streaming/consensus, AiEditChannel/RunChannel, autosave/export).
 *   - settingsSlice.ts: createSettingsSlice(set, get) + loadSettingsSliceSeeds()
 *     — owns locale, appearance, personalInstructions*, promptAutoTranslate,
 *     gameExpertSettings and their setters. True Zustand slice.
 *   - workflowEditorSlice.ts: createWorkflowEditorSlice(set, get, deps) — owns
 *     workflow-editing actions (addNode/updateNodeParams/applyGraphEdit/setMode/
 *     markSaved/...). True Zustand slice; receives private useStore fns via deps.
 *   - generationActions.ts / historyActions.ts / promptLibraryActions.ts: NOT
 *     slices. Call-time action modules in a deliberate single-edge import cycle
 *     with useStore.ts (see each file's constraint header). useStore.ts wraps
 *     their exported fns as thin store actions.
 *   - channelTypes.ts / sessionKey.ts / channelRegistry.ts / runSnapshot.ts:
 *     PURE leaf modules of the streaming/run-state decomposition. They import
 *     nothing from useStore (so they cannot join the cycle): channelTypes holds
 *     the RunChannel/AiEditChannel types, sessionKey the pure keying helpers,
 *     channelRegistry the channel Maps + read accessors, and runSnapshot the
 *     run-snapshot<->session-meta mappers. useStore.ts re-exports their names so
 *     existing import sites keep resolving them from './useStore'.
 *
 * State:
 *   workflow, selectedNodeId (legacy canvas era — persist as runtime state, the
 *     canvas is dormant; see CLAUDE.md),
 *   sessions, activeSessionId, messages, promptGroups,
 *   composer, composerDraft, composerDrafts, permissionOptions, modelOptions,
 *   workspaceHistory,
 *   appearance, locale (seeded by settingsSlice),
 *   mode ('design'|'running'), runState (Record<id,NodeRunState>),
 *   dirty (boolean), currentFilePath (string|null)
 *
 * Actions (chat/session/composer — useStore.ts):
 *   newSession(), sendPrompt(text), setComposer(patch),
 *   setComposerDraft(text), appendComposerDraft(text), setWorkspace(path),
 *   setWorkflow(ir), newWorkflow(), newSimpleWorkflow(), runWorkflow()
 * Actions (appearance/settings — settingsSlice.ts):
 *   setStylePresetId(id), setStreamSchemeId(id),
 *   setFontFamilyId(id), setFontSizePx(px)
 * Actions (workflow/graph editing — workflowEditorSlice.ts):
 *   addNode(type, params?) -> id, updateNodeParams(id, patch),
 *   updateNodeLabel(id, label), removeNode(id),
 *   addEdge(from, to, kind) -> id, removeEdge(id),
 *   setNodePosition(id, x, y), setMode(mode),
 *   setRunState(id, state), resetRunState(),
 *   applyGraphEdit(ir), markSaved(path?),
 *   markActiveSessionAsWorkflow() — locked flag; once true the session never reverts.
 * Actions (prompt-library CRUD — promptLibraryActions.ts; every mutation persists):
 *   addPromptItem(groupId, label, text), updatePromptItem(groupId, itemId, patch),
 *   removePromptItem(groupId, itemId),
 *   addPromptGroup(label) -> id, updatePromptGroup(groupId, label),
 *   removePromptGroup(groupId), resetPromptGroups()
 *
 * Persistence is manual (per-field load/save helpers, not zustand/persist):
 * each persisted field needs a matching save call. For the settings slice this
 * is now enforced at compile time via lib/persistedFields.ts (definePersistedFields
 * requires a paired load+save per field). Fields outside that registry still
 * rely on convention — so don't add a persisted field without its save side.
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
  /** User message ids for simple-chat turns accepted locally but not started yet. */
  queuedChatMessageIds: string[];
  /** Queued messages that can be steered into the active native CLI turn. */
  steerableQueuedChatMessageIds: string[];
  /**
   * Queued simple-chat message currently open in the inline editor. While set,
   * that message's FIFO slot is paused: the queue will not send it (with stale
   * text) until the edit is committed, cancelled, or the message is removed.
   */
  editingQueuedChatMessageId: string | null;
  /**
   * Sessions whose in-flight turn is parked on a user interaction (a UGS_ASK
   * select/input/confirm). The turn is still "live" (its channel stays open),
   * but it is *paused* waiting on the user rather than streaming — so the
   * Sidebar shows a static "waiting" badge instead of the running spinner, and
   * the composer accepts the answer instead of treating the box as locked.
   */
  waitingInputSessions: WorkflowSessionKey[];
  /** Short-lived composer tip when a send is rejected by chat concurrency rules. */
  blockedSendTip: BlockedSendTip | null;

  // Session / UI state
  sessions: Session[];
  activeSessionId: string | null;
  messages: Message[];
  promptGroups: PromptGroup[];
  locale: Locale;
  promptAutoTranslate: boolean;
  /**
   * Whether the composer's inline tool buttons (提及文件 / 组织架构 / 知识库)
   * are shown. Default false — they are opt-in from 设置 → 常规.
   */
  composerToolButtonsVisible: boolean;
  /**
   * Whether the composer's 思考深度 (thinking level) selector is shown. Default
   * true — levels come from protocol + model-family detection.
   */
  thinkingLevelsEnabled: boolean;
  /** 输入框上方提示与权限栏默认隐藏，由通用设置开启。 */
  composerHintRowVisible: boolean;
  /** 资产中心入口和缓存扫描默认关闭，由通用设置显式启用。 */
  assetCenterEnabled: boolean;
  /**
   * 手写的档位覆盖规则（每行 `模型匹配=档位列表`），用于私有网关的档位词汇
   * 与公开接口不一致的情况。空串 = 完全自动判定。
   */
  thinkingLevelOverrides: string;
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
  /** True once `.ultragamestudio` history has been loaded or gracefully skipped. */
  historyReady: boolean;
  /** Last history initialization failure, shown instead of sample sessions. */
  historyError: string | null;
  /** Resolved `.ultragamestudio` root path for diagnostics. */
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
   * Sessions with a live background job (a detached external process such as
   * yt-dlp/whisper/ffmpeg that outlives the CLI turn that started it). These
   * keep the Sidebar dot in the running state until the job's artifact lands or
   * it fails, so the dot reflects real work rather than just "the turn ended".
   * Fed by `BackgroundJobRunner` polling `.ultragamestudio/jobs/`.
   */
  jobSessions: WorkflowSessionKey[];
  /** Live background-job progress (0-100) keyed by owning session. */
  jobSessionProgress: Record<string, RunProgressSummary>;
  /** Per-job progress and log tails for the chat task disclosure. */
  jobDetails: import('@/lib/chatTasks').BackgroundJobDetail[];
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
  setComposerToolButtonsVisible: (visible: boolean) => void;
  setThinkingLevelsEnabled: (enabled: boolean) => void;
  setComposerHintRowVisible: (visible: boolean) => void;
  setAssetCenterEnabled: (enabled: boolean) => void;
  setThinkingLevelOverrides: (raw: string) => void;
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
  /** Export the current workflow to a user-chosen file (.ugs.json). */
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
  /** Persist the Settings default run channel without rebinding the active session. */
  setDefaultRunSelection: (selection: GatewaySelection) => void;
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
  continueSessionWithHandoff: () => Promise<{ thinkingLevel?: string }>;
  selectSession: (sessionId: string, workspaceId?: string) => void;
  deleteSession: (sessionId: string, workspaceId?: string) => void;
  deleteWorkspaceHistory: (workspaceId: string) => void;
  renameWorkflowSession: (
    sessionId: string,
    workspaceId: string | null,
    name: string,
  ) => Promise<void>;
  setSessionPinned: (
    sessionId: string,
    workspaceId: string | null,
    pinned: boolean,
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
  /**
   * Replace the live background-job set + progress in one shot. Called by
   * `BackgroundJobRunner` on each poll tick with the sessions that still have a
   * running detached process and their latest progress.
   */
  setBackgroundJobState: (
    jobSessions: WorkflowSessionKey[],
    jobSessionProgress: Record<string, RunProgressSummary>,
    jobDetails?: import('@/lib/chatTasks').BackgroundJobDetail[],
  ) => void;
  runScheduledTaskSession: (
    sessionId: string,
    workspaceId: string | null,
    scheduledTask: ScheduledTaskConfig,
  ) => Promise<void>;
  sendPrompt: (
    text: string,
    options?: { forceGameExperts?: boolean; gameExpertIds?: string[]; skillIds?: string[]; locale?: Locale; reviseMessageId?: string; scheduledTaskRun?: boolean; onChatTerminal?: (status: 'completed' | 'cancelled' | 'failed') => void; gatewaySelectionOverride?: GatewaySelection; externalSession?: { workspaceId: string; sessionId: string; messages: Message[] } },
  ) => boolean;
  /** Explicit skill review never falls through to the normal chat gateway. */
  learnSkills: (kind: 'learn' | 'refine', text: string) => boolean;
  /** User controls resolve the saved batch, not the currently displayed session. */
  reviewSkillLearningAction: (state: SkillReviewState, action: 'approve' | 'reject' | 'rollback', id: string) => Promise<SkillMutationResult>;
  /** Update one existing source card after a host-confirmed control result. */
  updateSkillLearningState: (messageId: string, state: SkillReviewState) => Promise<void>;
  generateImagePrompt: (
    text: string,
    options?: {
      providerId?: ImageProviderId;
      model?: string;
      strictProvider?: boolean;
      onSettled?: OnGenerationSettled;
      background?: boolean;
      sessionKey?: WorkflowSessionKey;
      baseMessages?: Message[];
    },
  ) => void;
  generateMusicPrompt: (
    text: string,
    options?: {
      providerId?: MusicProviderId;
      model?: string;
      strictProvider?: boolean;
      onSettled?: OnGenerationSettled;
      background?: boolean;
      sessionKey?: WorkflowSessionKey;
      baseMessages?: Message[];
    },
  ) => void;
  generateThreeDPrompt: (
    text: string,
    options?: {
      providerId?: ThreeDProviderId;
      model?: string;
      strictProvider?: boolean;
      onSettled?: OnGenerationSettled;
      background?: boolean;
      sessionKey?: WorkflowSessionKey;
      baseMessages?: Message[];
    },
  ) => void;
  generateVideoPrompt: (
    text: string,
    options?: {
      providerId?: VideoProviderId;
      model?: string;
      strictProvider?: boolean;
      onSettled?: OnGenerationSettled;
      background?: boolean;
      sessionKey?: WorkflowSessionKey;
      baseMessages?: Message[];
    },
  ) => void;
  generateAnimationPrompt: (
    text: string,
    options?: {
      providerId?: AnimationProviderId;
      model?: string;
      strictProvider?: boolean;
      onSettled?: OnGenerationSettled;
      background?: boolean;
      sessionKey?: WorkflowSessionKey;
      baseMessages?: Message[];
    },
  ) => void;
  generateSpeechPrompt: (
    text: string,
    options?: {
      providerId?: SpeechProviderId;
      model?: string;
      strictProvider?: boolean;
      voice?: string;
      onSettled?: OnGenerationSettled;
      background?: boolean;
      sessionKey?: WorkflowSessionKey;
      baseMessages?: Message[];
    },
  ) => void;
  generateSpritePrompt: (
    text: string,
    options?: {
      providerId?: ImageProviderId;
      model?: string;
      strictProvider?: boolean;
      onSettled?: OnGenerationSettled;
      background?: boolean;
      sessionKey?: WorkflowSessionKey;
      baseMessages?: Message[];
    },
  ) => void;
  /**
   * GDD mode turn: route the request through the selected coding model with
   * instructions to update/freeze the game design document contract instead of
   * editing an UltraGameStudio workflow blueprint.
   */
  generateGddPrompt: (
    text: string,
    options?: { finalize?: boolean },
  ) => void;
  /**
   * ComfyUI mode turn: ask the selected coding model to author a ComfyUI prompt
   * graph and emit it as a ```comfyui fenced block, which the chat stream then
   * renders as an embedded, expandable node graph. Wired to the
   * /comfyui-mode-start command and sticky comfyMode in AIDock.
   */
  generateComfyPrompt: (text: string) => void;
  /**
   * World-model mode turn: ask the selected coding model to author an
   * interactive playable-world definition and emit it as a ```worldmodel fenced
   * block, which the chat stream renders as an embedded, expandable, playable
   * world preview. Wired to /worldmodel-mode-start and sticky worldMode in
   * AIDock.
   */
  generateWorldPrompt: (text: string) => void;
  /**
   * UI mode turn: ask the selected coding model to design a game UI deliverable
   * for the global default UI channel (Settings > UI 渠道). Front-loads
   * a UI-design instruction so the model produces interface specs/assets instead
   * of editing the workflow blueprint. Wired to /ui-mode-start and sticky uiMode
   * in AIDock.
   */
  generateUiPrompt: (text: string) => void;
  /**
   * UE Blueprint mode turn: route the request through the selected coding model
   * with instructions to operate UE Blueprint assets via the editor plugin/MCP
   * when available, never UltraGameStudio workflow IRGraph.
   */
  generateBlueprintPrompt: (text: string) => void;
  /**
   * MetaHuman MVP mode turn: route the request through the selected coding
   * model as a staged, user-confirmed local Unreal Engine MetaHuman pipeline.
   */
  generateMetaHumanPrompt: (text: string) => void;
  /**
   * Search the enabled online 3D model libraries (Settings > 在线模型库) for
   * the given query and render thumbnails / previews / downloads into the active
   * chat. Wired to the `/mesh-search` slash command in AIDock.
   */
  searchMeshLibraryPrompt: (text: string) => void;
  runStudioPrompt: (task: string) => void;
  /**
   * Append a local message to the current chat session and persist it. Used by
   * app-side actions that produce a result without an AI turn (e.g. the
   * /screenshot and /screenshot-gif export commands echoing the user's command
   * and surfacing their saved path + an inline preview). Returns the message id.
   */
  appendChatNote: (
    text: string,
    role?: 'user' | 'assistant' | 'system',
    options?: {
      appAction?: Message['appAction'];
      interaction?: InteractionRequest;
      localOnly?: boolean;
    },
  ) => string;
  /** Delete one message from the active conversation and persist the transcript. */
  deleteMessage: (messageId: string) => void;
  /** Edit a simple-chat user message that is still waiting in the local queue. */
  updateQueuedChatMessage: (messageId: string, text: string) => boolean;
  /** Revise an already-sent input and answer again from that turn. */
  reviseChatMessage: (messageId: string, text: string) => boolean;
  /** Restore a saved input/reply version without invoking the model. */
  selectChatRevision: (messageId: string, index: number) => boolean;
  /** Delete a simple-chat user message that is still waiting in the local queue. */
  deleteQueuedChatMessage: (messageId: string) => boolean;
  /** Open the inline editor for a queued message and pause its queue slot. */
  beginQueuedChatMessageEdit: (messageId: string) => void;
  /** Close the inline editor without applying changes; the queue slot resumes. */
  cancelQueuedChatMessageEdit: () => void;
  /** Steer a queued message into a compatible active native CLI turn. */
  steerQueuedChatMessage: (messageId: string) => boolean;
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
  /**
   * Persist the widget's in-progress draft (typed text / toggled options) onto
   * the message so it survives session switches. Pass an empty object (or omit
   * fields) to clear. No-op once the interaction is no longer pending.
   */
  setInteractionDraft: (
    messageId: string,
    draft: { values?: string[]; text?: string },
  ) => void;
  setComposer: (patch: Partial<ComposerSettings>) => void;
  /**
   * If the active session was started in "worktree" mode and has not begun yet
   * (no messages), prepare an isolated working directory (git worktree or copy)
   * and repoint the composer cwd at it. Idempotent and a no-op for 'local' mode,
   * web (no backend), or once the conversation has started. Resolves before the
   * caller sends the first message so the CLI runs in the isolated directory.
   */
  ensureSessionStartupWorkspace: () => Promise<void>;
  setComposerDraft: (text: string) => void;
  appendComposerDraft: (text: string) => void;
  setWorkspace: (path: string) => void;
  addWorkspaceFolder: (path: string) => void;
  removeWorkspaceFolder: (path: string) => void;
  removeWorkspace: (path: string) => void;
  /**
   * Apply a project's configured workspace folders to the active session's
   * composer. Called after Project Settings -> 概览 saves its folder list so the
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

/**
 * Canonical store set/get signatures, derived from zustand's own StoreApi so
 * slice factories stay in sync with whatever `create<StoreState>()` actually
 * passes. Zustand's docs recommend `StoreApi<T>['setState']` over hand-rolled
 * SetState types. If middleware (immer/devtools) is ever added, switch these to
 * the StateCreator-projected mutators in one place instead of per slice.
 */
export type StoreSet = StoreApi<StoreState>['setState'];
export type StoreGet = StoreApi<StoreState>['getState'];
