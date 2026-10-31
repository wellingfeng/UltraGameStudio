import { sessionHasContextCompression, CONTEXT_COMPRESSION_TOOL } from '@/lib/contextCompression';
import { mergeReferenceSources, sourcesFromTool, withMessageReferences } from '@/lib/messageReferences';
import { create } from 'zustand';
import {
  type GatewaySelection,
  type IRGraph,
  type IRRunSnapshot,
  type IRRunStatus,
  type NodeGatewayOverride,
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
import {
  closeDanglingToolPatches,
  encodeToolPatch,
  extractToolSentinels,
  finalizeToolSentinelsForPersistence,
  hasToolSentinel,
  type ToolEventPatch,
} from '@/components/ai/lib/toolEvent';
import { legacyXmlToolsToSentinels } from '@/components/ai/lib/legacyXmlTool';
import { scanFileRefs } from '@/components/ai/lib/fileScan';
import {
  displayFileRefPath,
  isDocumentFileRef,
  isImageFileRef,
} from '@/components/ai/lib/filePath';
import {
  personalInstructionsBlock,
  personalInstructionsForSelection,
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
  estimateGatewayUsage,
  estimateUsageForText,
  recordEstimatedModelUsageForSelection,
  recordModelUsageForRoute,
  mergeUsageReports,
  readUsageMeterSnapshot,
  usageReportFromCliUsage,
  usageTurnFromReport,
  usageTurnFromSnapshots,
  type ModelUsageReport,
  type UsageTurnDelta,
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
import { listProviders, setActiveProviderId, type Provider } from '@/lib/apiConfig';
import { appendComposerDraftState } from '@/lib/composerEntryPolicy';
import {
  clearActiveGatewaySelection,
  getDefaultGatewaySelection,
  getExplicitActiveGatewaySelection,
  setActiveGatewaySelection,
} from '@/lib/gatewayConfig';
import { getCliRuntimeSnapshot } from '@/lib/cliConfig';
import { readPersistedSkillSourceSession } from '@/lib/skills';
import { beginSkillLearningTurn, performSkillReviewAction, requestExplicitSkillLearning, resumeSkillLearningReview, isSkillReviewLive } from '@/lib/skillLearningDesktop';
import { loadSkillLearningConfig } from '@/lib/skillLearningConfig';
import type { SkillLearningJob, SkillMutationResult, SkillOrigin, SkillReviewState } from '@/runtime/skills/types';
import { ensureFreeProxy, isFreeChannelSelection } from '@/lib/freeChannels';
import { getManifestModeEnabled } from '@/lib/manifestMode';
import {
  projectEngineLabel,
  projectSettingsFromMetadata,
} from '@/lib/projectSettings';
import {
  dismissSessionWaitingInputNotification,
  isNotifiableCompletionStatus,
  notifySessionComplete,
  setSessionNotificationClickHandler,
} from '@/lib/sessionNotification';
import { requestForceBottomScrollForSession } from '@/panels/aidock/streamScroll';
import {
  imageProviderById,
  imageProviders,
  loadImageGenerationSettings,
  preferredReadyImageProviderId,
  type ImageProviderId,
} from '@/lib/imageGeneration';
import {
  loadMusicGenerationSettings,
  preferredReadyMusicProviderId,
} from '@/lib/musicGeneration';
import {
  loadThreeDGenerationSettings,
  preferredReadyThreeDProviderId,
} from '@/lib/threeDGeneration';
import { stripComfyCommand, fetchComfyObjectInfo, comfyBaseUrl } from '@/lib/comfyui';
import {
  loadWorldModelGenerationSettings,
  worldModelProviderById,
  worldModelProviders,
  type WorldModelProviderId,
} from '@/lib/worldModel';
import {
  loadVideoGenerationSettings,
  preferredReadyVideoProviderId,
} from '@/lib/videoGeneration';
import {
  loadAnimationGenerationSettings,
  preferredReadyAnimationProviderId,
} from '@/lib/animationGeneration';
import {
  loadSpeechGenerationSettings,
  preferredReadySpeechProviderId,
} from '@/lib/speechGeneration';
import {
  preferredReadySpriteProviderId,
} from '@/lib/spriteGeneration';
import {
  loadUiDesignChannelSettings,
  uiDesignChannelReady,
} from '@/lib/uiDesignChannels';
import {
  loadMeshLibrarySettings,
  meshLibraryById,
  type MeshLibraryAccountSettings,
  type MeshSearchQueryResolution,
  type MeshSearchResult,
} from '@/lib/meshLibrary';
import { settingsProfileIdForWorkspacePath } from '@/lib/generationSettingsStore';
import {
  buildGameExpertPrompt,
} from '@/lib/gameExperts';
import {
  buildProducerPrompt,
  shouldUseProducer,
} from '@/lib/gameProducer';
import {
  modelClassFromModelId,
  normalizeGatewaySelection,
  normalizeGatewayWorkflow as migrateWorkflowGateway,
  systemDefaultGatewaySelection,
  withoutWorkflowGatewayDefaults,
  workflowDefaultGatewaySelection,
} from '@/lib/modelGateway/resolver';
import { shortId } from '@/lib/id';
import {
  aiEditViaCli,
  aiCliSteerSupported,
  cancelAiCli,
  downloadModelAsset,
  ensureDefaultWorkspaceDir,
  isTauri,
  previewLocalFile,
  steerAiCli,
  tauriAvailable,
  ugsJobWrapperPath,
  type NativeCliSkillToolsOptions,
} from '@/lib/tauri';
import {
  linkManagedAssetsFromMessageText,
  linkModifiedAssetsFromMessage,
  registerAsset,
  type AssetKind,
  type AssetOrigin,
} from '@/lib/downloadRegistry';
import {
  COMFY_PROMPT_SYSTEM,
  stripGddModeCommand,
  gddModePromptSystem,
  gddModeFinalizePromptSystem,
  stripUiModeCommand,
  uiDesignPromptSystem,
  stripBlueprintModeCommand,
  blueprintModePromptSystem,
  stripMetaHumanModeCommand,
  metaHumanModePromptSystem,
  startImageGenerationTurn,
  startMusicGenerationTurn,
  startThreeDGenerationTurn,
  startWorldModelGenerationTurn,
  startVideoGenerationTurn,
  startAnimationGenerationTurn,
  startSpeechGenerationTurn,
  startSpriteGenerationTurn,
  startMeshSearchTurn,
} from './generationActions';
import type {
  GenerationTurnResult,
  OnGenerationSettled,
} from './generationActions';
import {
  addPromptItem,
  updatePromptItem,
  updatePromptItemLocalized,
  removePromptItem,
  addPromptGroup,
  updatePromptGroup,
  updatePromptGroupLocalized,
  removePromptGroup,
  resetPromptGroups,
} from './promptLibraryActions';
import {
  initHistory as initHistorySlice,
  setWorkflowFavoriteHistorySession,
  setHistorySessionPinned,
  setWorkflowScheduledTaskHistorySession,
  ensureSessionStartupWorkspace as ensureSessionStartupWorkspaceSlice,
  setWorkspace as setWorkspaceSlice,
  addWorkspaceFolder as addWorkspaceFolderSlice,
  removeWorkspaceFolder as removeWorkspaceFolderSlice,
  removeWorkspace as removeWorkspaceSlice,
  applyWorkspaceFolders as applyWorkspaceFoldersSlice,
} from './historyActions';
import { createWorkflowEditorSlice } from './workflowEditorSlice';
import {
  createSettingsSlice,
  loadSettingsSliceSeeds,
} from './settingsSlice';
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
  BACKGROUND_JOB_INSTRUCTION,
  extractJsonObject,
  modelStrategyGuidance,
  buildAssetCapabilityBlock,
  shouldUseAssetCapabilityBlockForPrompt,
} from '@/lib/anthropic';
import { runtimeAdapterLabel, type RuntimeAdapterId } from '@/lib/adapters';
import {
  applyMemoryWrites,
  renderFrozenMemorySnapshot,
  renderMemorySnapshotCompact,
} from '@/lib/memoryStore';
import { beginMemoryReviewTurn, cancelMemoryReviews } from '@/lib/memoryReviewDesktop';
import { buildMemoryReviewMessages, preemptReviewBackground } from '@/runtime/memory/review';
import { renderKnowledgeBaseContextForPrompt } from '@/lib/knowledgeBase';
import {
  MEMORY_WRITE_INSTRUCTION,
  parseMemoryWrites,
  stripMemoryWrites,
} from '@/core/memoryProtocol';
import {
  RECALL_INSTRUCTION,
  parseRecall,
  stripRecall,
} from '@/core/recallProtocol';
import {
  genInstruction,
  parseGenRequests,
  stripGenRequests,
  genKindLabel,
  detectRequestedGenKinds,
  mergeGenKinds,
  type GenKind,
  type GenRequest,
} from '@/core/generationProtocol';
import {
  formatRecallHits,
  type SessionReader,
  type SessionSearchHit,
} from '@/lib/sessionSearch';
import { searchSessionsIndexed } from '@/lib/sessionIndex';
import { loadMemoryConfig } from '@/lib/memoryConfig';
import {
  INTERACTION_PROTOCOL,
  detectFallbackInteraction,
  extractLeadConclusion,
  formatAnswerForPrompt,
  isPinnableAnswer,
  liveProse,
  parseInteraction,
  stripCliProgressMarkers,
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
  type RunCallbacks,
  type RunContext as RuntimeRunContext,
  type RunFailure,
  type RunGateway,
  WORKSPACE_LAYOUT_DIRECTIVE,
} from '@/runtime';
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  languageAdaptationPrompt,
  languageDirectiveReminder,
  t,
  type Locale,
} from '@/lib/i18n';
import { parseCron, validTimeZone } from '@/lib/scheduledTasks';
import { scheduleText } from '@/lib/scheduledTaskI18n';
import { SCHEDULED_TASK_SCOPE } from '@/lib/scheduledTaskScope';
import {
  CACHE_TTL_MINUTES_OPTIONS,
  DEFAULT_CACHE_TTL_MINUTES,
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
  loadPromptGroups,
  loadPromptGroupsVersion,
  saveComposer,
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
  getRemoteWorkspace,
  isRemoteWorkspacePath,
  parseRemoteProviderId,
  remoteModelForAdapter,
  remoteRunnerProviderMatchesWorkspace,
  remoteWorkspaceIdFromPath,
  RunnerClient,
} from '@/lib/remoteWorkspace';
import { REMOTE_SKILL_HOST_ID } from '@ugs/protocol';
import { createRemoteSkillControlHost } from '@/lib/remoteSkillLearning';
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
import { collectTurnFileChanges, supportsNativeFileChanges } from '@/lib/turnFileChanges';
import { ensureWorkspaceChangesBaseline, listWorkspaceChanges } from '@/lib/tauri';
import {
  historyStore,
  isAutoTitlePlaceholder,
  titleFromText,
} from './history/store';
import { scheduleComposerDraftPersist } from './composerDraftPersistence';
import { generateSessionTitle } from './sessionTitleNaming';
import {
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
// Channel types extracted to channelTypes.ts (type-only, no cycle). Re-exported
// below so `import type { AiEditChannel } from './useStore'` sites keep working.
import type {
  RunConfig,
  RunChannel,
  AiEditChannel,
  ChatNativeSession,
} from './channelTypes';
export type { AiEditChannel } from './channelTypes';
// Pure session-key helpers extracted to sessionKey.ts (no cycle). runKey and
// chatTurnKey are re-exported so existing `import { runKey } from './useStore'`
// sites (e.g. generationActions) keep working unchanged.
import {
  workflowSessionKeyId,
  runKey,
  chatTurnKey,
} from './sessionKey';
export { runKey, chatTurnKey, workflowSessionKeyId } from './sessionKey';
import { startRemoteChatTurn } from './remoteChatTurn';
// Channel registry: owns the run/AI-edit Maps + pure read accessors (no cycle).
// The Maps are imported so the side-effecting mutators below can write them.
// aiEditRegistered is re-exported for generationActions.
import {
  activeRuns,
  activeAiEdits,
  aiEditSnapshots,
  getRunChannel,
  getRunChannelByKey,
  getAiEditChannelByKey,
  getAiEditChannel,
  getAiEditSnapshot,
  getAiEditViewSource,
  getAiEditChannelsForSession,
  getAiEditChatChannels,
  getAiEditSnapshotsForSession,
  activeRunChannels,
  activeAiEditChannels,
  aiEditRegistered,
  abortAllPendingRuns,
} from './channelRegistry';
export { aiEditRegistered } from './channelRegistry';
// [M3] Pure run-snapshot <-> session-meta mappers extracted to ./runSnapshot
// (no cycle). Imported for internal use and re-exported so existing import
// sites (historyActions, workflowEditorSlice, tests) keep resolving them here.
import {
  runProgressFromSnapshot,
  emptyRunProgress,
  isRunStatus,
  persistedStatusForDisplay,
  runMetaFromSnapshot,
  runSnapshotFromState,
  restoreWorkflowRunSnapshot,
  workflowWithoutRunSnapshot,
  workflowWithRunSnapshot,
} from './runSnapshot';
export {
  runProgressFromSnapshot,
  emptyRunProgress,
  restoreWorkflowRunSnapshot,
} from './runSnapshot';
import type {
  StoreState,
  WorkflowSessionKey,
  WorkflowWriteSource,
} from './storeState';

export { selectRunProgress } from './runProgress';
export { selectActiveScopeId } from './workflowEditorSlice';
export type { RunProgressSummary } from './runProgress';
export type {
  BlockedSendTip,
  StoreState,
  WorkflowSessionKey,
  WorkflowWriteSource,
} from './storeState';

export type WorkflowReadOnlyReason = 'running' | 'aiEditing';
export type SessionLiveStatus = 'running' | 'waiting' | 'aiEditing' | null;

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
  Partial<
    Pick<
      StoreState,
      'chattingSessions' | 'waitingInputSessions' | 'jobSessions'
    >
  >;

export function activeWorkflowSessionKey(
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

function settingsProfileForState(
  state: Pick<StoreState, 'activeWorkspaceId' | 'composer' | 'workspaces'>,
) {
  const workspacePath =
    trimmedPath(state.composer.workspace) ??
    workspacePathForId(state.workspaces, state.activeWorkspaceId);
  return { profileId: settingsProfileIdForWorkspacePath(workspacePath) };
}

export function projectMcpGuidanceForState(
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
  const hasGodotMcp = enabledServers.some((server) =>
    `${server.id} ${server.label}`.toLowerCase().includes('godot'),
  );
  const realtimeRule = hasUnrealMcp
    ? '当用户问题涉及 Unreal Editor、当前打开场景、Actor、资源、材质、渲染状态、PIE 或编辑器实时状态时，优先使用 Unreal MCP 工具读取编辑器实时状态；命令行、文件搜索和日志作为补充。'
    : hasGodotMcp
      ? '当用户问题涉及 Godot Editor、运行中项目、场景、节点、资源、GDScript、调试输出或编辑器实时状态时，优先使用 Godot MCP 工具读取或操作实时状态；命令行、文件搜索和日志作为补充。'
    : '当用户问题涉及已配置工具能直接读取的运行时状态时，优先使用对应 MCP 工具；命令行、文件搜索和日志作为补充。';

  return `\n\n【全局 MCP】\n当前工作区已启用 MCP server，所有模型请求都应优先使用这些实时工具：\n${serverLines}\n${realtimeRule}\n若 MCP 工具不可用或连接失败，先说明原因，再退回本地文件/日志分析。`;
}

function projectEngineGuidanceForState(
  state: Pick<StoreState, 'workspaces'>,
  sessionKey: WorkflowSessionKey,
): string {
  if (!sessionKey.workspaceId) return '';
  const workspace = state.workspaces.find(
    (candidate) => candidate.id === sessionKey.workspaceId,
  );
  if (!workspace) return '';
  const settings = projectSettingsFromMetadata(workspace.metadata);
  const configuredEngine =
    settings.engine !== 'auto' && settings.engine !== 'unknown'
      ? projectEngineLabel(settings.engine)
      : null;
  const workspacePath = workspace.path?.trim();
  const pathLine = workspacePath ? `\n工作区路径：${workspacePath}` : '';
  const engineLine = configuredEngine
    ? `当前项目引擎：${configuredEngine}（来自项目设置/自动检测结果）。`
    : '当前项目引擎：未识别或自动模式。';
  const rule = configuredEngine
    ? `涉及游戏开发、图像转游戏、素材落地、代码/蓝图/组件拆解时，优先按 ${configuredEngine} 项目实现；除非用户明确要求，不要改用 Godot 或其它引擎。`
    : '涉及游戏开发、图像转游戏、素材落地、代码/蓝图/组件拆解时，必须根据工作区文件标记和上下文自动判读具体引擎（例如 .uproject=Unreal，Packages/manifest.json+ProjectSettings=Unity，project.godot=Godot，project.json/assets=Cocos），不要默认使用 Godot。';
  return `\n\n【项目引擎】\n${engineLine}${pathLine}\n${rule}`;
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

function composerDraftForSession(
  drafts: Record<string, string>,
  sessionKey: WorkflowSessionKey,
): string {
  return drafts[workflowSessionKeyId(sessionKey)] ?? '';
}

export function composerDraftPatchForSession(
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

/**
 * Seed the in-memory draft cache with a session record's persisted
 * `meta.composerDraft` when activating a session, then apply the normal
 * per-session draft flush/load.
 *
 * An in-memory entry always wins over the persisted value (it is fresher), so
 * only sessions with no in-memory draft get restored from disk. The one
 * exception to the flush rule: when the target session is the same as the
 * currently-active session and the in-memory `composerDraft` is still the empty
 * default (nothing typed this run), the flush must NOT clobber the freshly
 * restored persisted draft with `''` — otherwise a restart would always wipe
 * the draft it just loaded.
 */
export function composerDraftPatchForSessionFromRecord(
  state: ComposerDraftState,
  sessionKey: WorkflowSessionKey,
  meta: SessionMeta | undefined,
): Pick<StoreState, 'composerDraft' | 'composerDrafts'> {
  const currentKey = workflowSessionKeyId(activeWorkflowSessionKey(state));
  const key = workflowSessionKeyId(sessionKey);
  const persisted = meta?.composerDraft;

  // 1. Restore the persisted draft for the target session when no fresher
  //    in-memory entry exists.
  let composerDrafts = state.composerDrafts;
  if (persisted && composerDrafts[key] === undefined) {
    composerDrafts = { ...composerDrafts, [key]: persisted };
  }

  // 2. Flush the current session's in-memory draft into the cache, mirroring
  //    composerDraftPatchForSession. Skip only the degenerate same-session case
  //    where the "draft" is the empty default and would erase the restore above.
  const flushValue = state.composerDraft;
  const skipFlush = currentKey === key && !flushValue;
  if (!skipFlush && composerDrafts[currentKey] !== flushValue) {
    composerDrafts = { ...composerDrafts, [currentKey]: flushValue };
  }

  return {
    composerDrafts,
    composerDraft: composerDraftForSession(composerDrafts, sessionKey),
  };
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

function persistGlobalGatewaySelection(selection: GatewaySelection): GatewaySelection {
  const normalized = normalizeGatewaySelection(selection);
  if (normalized.providerId) setActiveProviderId(normalized.providerId);
  setActiveGatewaySelection(normalized);
  return normalized;
}

function runtimeAdapterFromRemoteAdapter(adapter: unknown): GatewaySelection['adapter'] {
  if (adapter === 'codex') return 'codex';
  if (adapter === 'gemini') return 'gemini';
  return 'claude-code';
}

function runtimeAdapterFromProviderKind(kind: unknown): GatewaySelection['adapter'] {
  if (kind === 'codex') return 'codex';
  if (kind === 'gemini') return 'gemini';
  if (kind === 'kimi') return 'kimi';
  if (kind === 'deepseek-harness') return 'deepseek-harness';
  if (kind === 'zcode') return 'zcode';
  if (kind === 'grok') return 'grok';
  return 'claude-code';
}

const HISTORICAL_ROUTE_LINE_RE =
  /^⚙ (?:(?:路由：(?<route>.*?)(?: · 模型：(?<model>.*))?)|(?:模型：(?<modelOnly>.*)))$/m;

function sameRouteLabel(a: string | undefined, b: string | undefined): boolean {
  return (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();
}

function historicalMessageRouteLabel(message: Message): string {
  const explicit = message.routeLabel?.trim();
  if (explicit) return explicit;
  const match = message.text.match(HISTORICAL_ROUTE_LINE_RE);
  const groups = match?.groups;
  if (!groups) return '';
  const route = groups.route?.trim() ?? '';
  const model = (groups.model ?? groups.modelOnly ?? '').trim();
  return [route, model].filter(Boolean).join(' · ');
}

function historicalRouteParts(
  messages: readonly Message[],
): { routeName: string; model?: string } | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'assistant') continue;
    const label = historicalMessageRouteLabel(message);
    if (!label) continue;
    const parts = label
      .split(' · ')
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length === 0) continue;
    if (parts.length === 1) return { routeName: parts[0] };
    return {
      routeName: parts.slice(0, -1).join(' · '),
      model: parts[parts.length - 1],
    };
  }
  return null;
}

function providerMatchesHistoricalModel(provider: Provider, model: string): boolean {
  const selected = model.trim();
  if (!selected) return true;
  const candidates = [provider.model, ...(provider.models ?? [])]
    .map((item) => item?.trim())
    .filter((item): item is string => Boolean(item));
  if (candidates.length === 0) return true;
  return candidates.some((candidate) => sameRouteLabel(candidate, selected));
}

function adapterFromHistoricalRouteName(
  routeName: string,
): RuntimeAdapterId | null {
  const adapters: RuntimeAdapterId[] = [
    'claude-code',
    'codex',
    'gemini',
    'kimi',
    'grok',
  ];
  return (
    adapters.find((adapter) =>
      sameRouteLabel(runtimeAdapterLabel(adapter), routeName),
    ) ?? null
  );
}

export function historicalGatewaySelectionFromMessages(
  messages: readonly Message[],
): GatewaySelection | null {
  const route = historicalRouteParts(messages);
  if (!route) return null;
  const model = route.model?.trim();
  const providers = listProviders().filter((provider) =>
    sameRouteLabel(provider.name, route.routeName),
  );
  const provider =
    providers.find((candidate) =>
      providerMatchesHistoricalModel(candidate, model ?? ''),
    ) ?? providers[0];
  if (provider) {
    const adapter = runtimeAdapterFromProviderKind(provider.kind);
    const providerModel = provider.model?.trim() ?? '';
    const selectedModel = model || providerModel || 'default';
    const modelOverride =
      model && providerModel && !sameRouteLabel(model, providerModel)
        ? model
        : undefined;
    return normalizeGatewaySelection({
      adapter,
      modelClass: selectedModel,
      ...(modelOverride ? { modelOverride } : {}),
      providerId: provider.id,
      channelId: 'default',
    });
  }
  const adapter = adapterFromHistoricalRouteName(route.routeName);
  if (!adapter) return null;
  const selectedModel = model || 'default';
  return normalizeGatewaySelection({
    adapter,
    modelClass: selectedModel,
  });
}

function remoteWorkspaceModelForAdapter(
  adapter: GatewaySelection['adapter'],
  model: string | null | undefined,
): string | undefined {
  return remoteModelForAdapter(adapter === 'claude-code', model);
}

function remoteWorkspaceGatewaySelection(
  workspacePath: string,
  current: GatewaySelection,
): GatewaySelection | null {
  if (!isRemoteWorkspacePath(workspacePath)) return null;
  const workspaceId = remoteWorkspaceIdFromPath(workspacePath);
  const remote = parseRemoteProviderId(current.providerId);
  const config = getRemoteWorkspace(workspaceId);
  if (!config) return null;
  const configAdapter = runtimeAdapterFromRemoteAdapter(config.adapter);
  const configModel = remoteWorkspaceModelForAdapter(configAdapter, config.model);
  if (remote?.workspaceId === workspaceId) {
    const provider = listProviders().find((item) => item.id === current.providerId);
    const adapter = provider
      ? runtimeAdapterFromProviderKind(provider.kind)
      : current.adapter || configAdapter;
    const currentModel = remoteWorkspaceModelForAdapter(
      adapter,
      current.modelOverride?.trim() || current.modelClass?.trim(),
    );
    if (!configModel) {
      if (currentModel) return current;
      const providerModel =
        remoteWorkspaceModelForAdapter(adapter, provider?.model) || 'default';
      return normalizeGatewaySelection({
        ...current,
        adapter,
        modelClass: providerModel,
        modelOverride: undefined,
        providerId: current.providerId,
        channelId: current.channelId || 'default',
      });
    }
    const currentOverride = current.modelOverride?.trim();
    if (
      currentModel?.toLowerCase() === configModel.toLowerCase() &&
      currentOverride?.toLowerCase() === configModel.toLowerCase()
    ) {
      return current;
    }
    return normalizeGatewaySelection({
      ...current,
      adapter,
      modelClass: configModel,
      modelOverride: configModel,
      providerId: current.providerId,
      channelId: current.channelId || 'default',
    });
  }

  const remoteProviders = listProviders().filter((provider) =>
    remoteRunnerProviderMatchesWorkspace(provider, workspaceId),
  );
  // Bind only to an account that matches the project's configured agent. When
  // no such account exists on the runner, fall through to that agent's system
  // default rather than hijacking to a mismatched account (e.g. a Codex account
  // when the project is configured for Claude).
  const provider = remoteProviders.find(
    (item) => runtimeAdapterFromProviderKind(item.kind) === configAdapter,
  );
  if (provider) {
    const adapter = runtimeAdapterFromProviderKind(provider.kind);
    // Re-derive the project model against the bound account's adapter family so
    // a Claude-family default (e.g. claude-opus-4-8) never lands on Codex/Gemini.
    const adapterConfigModel = remoteWorkspaceModelForAdapter(adapter, config.model);
    const model =
      adapterConfigModel ||
      remoteWorkspaceModelForAdapter(adapter, provider.model) ||
      'default';
    return normalizeGatewaySelection({
      adapter,
      modelClass: model,
      ...(adapterConfigModel ? { modelOverride: adapterConfigModel } : {}),
      providerId: provider.id,
      channelId: 'default',
    });
  }

  const model = configModel || 'default';
  return normalizeGatewaySelection({
    adapter: configAdapter,
    modelClass: model,
    ...(configModel ? { modelOverride: configModel } : {}),
    systemDefault: true,
  });
}

/**
 * 本地工作区不能使用 `remote-runner:` provider（那是某个远程项目专属的执行
 * 通道）。从远程会话切回本地会话时，全局活动选择 / 旧会话快照里可能还残留着
 * 远程 provider，导致底部渠道/大模型停在远程的、本地项目跑不了。
 *
 * 这里把指向远程 runner 的 selection 替换成一个干净的本地默认（优先沿用当前
 * 适配器对应的本地 provider，否则退回系统默认）。非远程 selection 原样返回。
 */
function sanitizeLocalWorkspaceSelection(
  selection: GatewaySelection,
): GatewaySelection {
  if (!parseRemoteProviderId(selection.providerId)) return selection;
  const fallback =
    getExplicitActiveGatewaySelection() ??
    configuredCliGatewaySelection() ??
    getDefaultGatewaySelection();
  // 若全局活动选择本身也指向远程（同一次泄漏的来源），再退一层到 CLI/系统默认。
  const clean = parseRemoteProviderId(fallback.providerId)
    ? configuredCliGatewaySelection() ?? getDefaultGatewaySelection()
    : fallback;
  return normalizeGatewaySelection(clean);
}

function withNewSessionGatewayDefaults(workflow: IRGraph): IRGraph {
  const explicit = getExplicitActiveGatewaySelection();
  const selection = explicit
    ? sanitizeLocalWorkspaceSelection(explicit)
    : configuredCliGatewaySelection();
  return selection ? withSessionGatewayDefaults(workflow, selection) : workflow;
}

export function normalizeWorkspaceFolderList(
  paths: unknown,
  primary?: string,
): string[] {
  const primaryKey = primary ? workspacePathKey(primary) : '';
  return uniqueWorkspaceHistory(Array.isArray(paths) ? paths : []).filter(
    (path) => workspacePathKey(path) !== primaryKey,
  );
}

export function composerWorkspacePaths(composer: ComposerSettings): string[] {
  return uniqueWorkspaceHistory([
    composer.workspace,
    ...normalizeWorkspaceFolderList(
      composer.workspaceFolders,
      composer.workspace,
    ),
  ]);
}

export function composerCliWorkspaceOptions(composer: ComposerSettings): {
  cwd?: string;
  extraWorkspacePaths?: string[];
} {
  const [cwd, ...extraWorkspacePaths] = composerWorkspacePaths(composer);
  return {
    ...(cwd ? { cwd } : {}),
    ...(extraWorkspacePaths.length > 0 ? { extraWorkspacePaths } : {}),
  };
}

// The bundled ugs-job wrapper path is stable for the app's lifetime, so resolve
// it once and cache the promise. Returns '' when unavailable (browser/dev or
// not found) so the caller simply omits the background-job guidance.
let ugsJobWrapperPathCache: Promise<string> | undefined;
function resolveUgsJobWrapperPath(): Promise<string> {
  ugsJobWrapperPathCache ??= ugsJobWrapperPath()
    .then((p) => p ?? '')
    .catch(() => '');
  return ugsJobWrapperPathCache;
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

export function workspaceHistoryWithRecentPaths(
  paths: readonly unknown[],
  history: readonly unknown[],
): string[] {
  return uniqueWorkspaceHistory(
    [...paths, ...history],
    WORKSPACE_HISTORY_LIMIT,
  );
}

export function defaultSessionComposer(
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
export function workspaceFoldersFromMetadata(
  metadata: WorkspaceSummary['metadata'],
): string[] {
  return projectSettingsFromMetadata(metadata).folders;
}

function normalizeCacheTtlMinutes(value: unknown): number {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value)
        : NaN;
  return CACHE_TTL_MINUTES_OPTIONS.includes(
    Math.floor(n) as (typeof CACHE_TTL_MINUTES_OPTIONS)[number],
  )
    ? Math.floor(n)
    : DEFAULT_CACHE_TTL_MINUTES;
}

export function normalizeComposerSettings(value: Partial<ComposerSettings> | undefined): ComposerSettings {
  const source = value ?? {};
  const workspace = normalizeWorkspacePath(source.workspace ?? defaultComposer.workspace);
  return {
    ...defaultComposer,
    ...source,
    workspace,
    cacheTtlMinutes: normalizeCacheTtlMinutes(source.cacheTtlMinutes),
    startupMode:
      source.startupMode === 'worktree' ? 'worktree' : defaultComposer.startupMode,
    workspaceFolders: normalizeWorkspaceFolderList(
      source.workspaceFolders,
      workspace,
    ),
    modelStrategy: source.modelStrategy ?? defaultComposer.modelStrategy,
    knowledgeBaseMode:
      source.knowledgeBaseMode ?? defaultComposer.knowledgeBaseMode,
    gddMode: source.gddMode ?? defaultComposer.gddMode,
    gddModeStartedAt:
      source.gddModeStartedAt ?? defaultComposer.gddModeStartedAt,
    imageMode: source.imageMode ?? defaultComposer.imageMode,
    imageModeStartedAt:
      source.imageModeStartedAt ?? defaultComposer.imageModeStartedAt,
    musicMode: source.musicMode ?? defaultComposer.musicMode,
    musicModeStartedAt:
      source.musicModeStartedAt ?? defaultComposer.musicModeStartedAt,
    threeDMode: source.threeDMode ?? defaultComposer.threeDMode,
    threeDModeStartedAt:
      source.threeDModeStartedAt ?? defaultComposer.threeDModeStartedAt,
    videoMode: source.videoMode ?? defaultComposer.videoMode,
    videoModeStartedAt:
      source.videoModeStartedAt ?? defaultComposer.videoModeStartedAt,
    animationMode: source.animationMode ?? defaultComposer.animationMode,
    animationModeStartedAt:
      source.animationModeStartedAt ?? defaultComposer.animationModeStartedAt,
    speechMode: source.speechMode ?? defaultComposer.speechMode,
    speechModeStartedAt:
      source.speechModeStartedAt ?? defaultComposer.speechModeStartedAt,
    spriteMode: source.spriteMode ?? defaultComposer.spriteMode,
    spriteModeStartedAt:
      source.spriteModeStartedAt ?? defaultComposer.spriteModeStartedAt,
    comfyMode: source.comfyMode ?? defaultComposer.comfyMode,
    comfyModeStartedAt:
      source.comfyModeStartedAt ?? defaultComposer.comfyModeStartedAt,
    worldMode: source.worldMode ?? defaultComposer.worldMode,
    worldModeStartedAt:
      source.worldModeStartedAt ?? defaultComposer.worldModeStartedAt,
    uiMode: source.uiMode ?? defaultComposer.uiMode,
    uiModeStartedAt:
      source.uiModeStartedAt ?? defaultComposer.uiModeStartedAt,
    metahumanMode: source.metahumanMode ?? defaultComposer.metahumanMode,
    metahumanModeStartedAt:
      source.metahumanModeStartedAt ?? defaultComposer.metahumanModeStartedAt,
    blueprintMode: source.blueprintMode ?? defaultComposer.blueprintMode,
    blueprintModeStartedAt:
      source.blueprintModeStartedAt ?? defaultComposer.blueprintModeStartedAt,
    blueprintModeArgs:
      source.blueprintModeArgs ?? defaultComposer.blueprintModeArgs,
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

export function saveComposerSoon(state: PersistedComposer): void {
  deferredComposerSave = state;
  if (deferredComposerSaveTimer) return;
  deferredComposerSaveTimer = setTimeout(() => {
    deferredComposerSaveTimer = null;
    const next = deferredComposerSave;
    deferredComposerSave = null;
    if (next) saveComposer(next);
  }, 0);
}

export function rememberSessionComposer(
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

export function composerPatchForSession(
  state: ComposerSessionState,
  sessionKey: WorkflowSessionKey,
  workflow: IRGraph,
  fallbackComposer: ComposerSettings = defaultSessionComposer(),
  fallbackGatewaySelection: GatewaySelection | null = null,
): Pick<StoreState, 'composer' | 'composerBySession' | 'workflow'> {
  let composerBySession = rememberSessionComposer(state);
  const key = workflowSessionKeyId(sessionKey);
  const stored = sessionKeyPersistable(sessionKey)
    ? composerBySession[key]
    : undefined;
  const fallbackSelection =
    workflow.meta.gateway?.defaults || !fallbackGatewaySelection
      ? workflowDefaultGatewaySelection(workflow, fallbackComposer.model)
      : normalizeGatewaySelection(fallbackGatewaySelection);
  const baseSnapshot =
    stored ??
    ({
      composer: fallbackComposer,
      gatewaySelection: fallbackSelection,
    } satisfies SessionComposerSettings);
  const remoteSelection = remoteWorkspaceGatewaySelection(
    baseSnapshot.composer.workspace || fallbackComposer.workspace,
    baseSnapshot.gatewaySelection,
  );
  // 本地工作区：清洗掉残留的远程 runner 选择，避免底部渠道/大模型停在远程的、
  // 导致本地项目跑不了。同时把全局活动 pin 一并修复，让运行时解析与新建会话
  // 不再继续泄漏远程 provider。
  const localSelection = remoteSelection
    ? null
    : (() => {
        const cleaned = sanitizeLocalWorkspaceSelection(
          baseSnapshot.gatewaySelection,
        );
        if (cleaned === baseSnapshot.gatewaySelection) return null;
        const activePin = getExplicitActiveGatewaySelection();
        if (activePin && parseRemoteProviderId(activePin.providerId)) {
          setActiveGatewaySelection(cleaned);
        }
        return cleaned;
      })();
  const effectiveSelection = remoteSelection ?? localSelection;
  const snapshot = effectiveSelection
    ? { ...baseSnapshot, gatewaySelection: effectiveSelection }
    : baseSnapshot;
  if ((!stored || effectiveSelection) && sessionKeyPersistable(sessionKey)) {
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
  // A turn parked on a user interaction is still "live" (its channel is open
  // and it also appears in running/chatting), but it is *paused* on the user —
  // surface that first so the badge shows a static "waiting" dot, not a spinner.
  if (hasSessionKey(state.waitingInputSessions ?? [], sessionKey)) {
    return 'waiting';
  }
  if (hasSessionKey(state.runningSessions, sessionKey)) return 'running';
  if (hasSessionKey(state.chattingSessions ?? [], sessionKey)) return 'running';
  if (hasSessionKey(state.aiEditingSessions, sessionKey)) return 'aiEditing';
  // A detached background job (external process still working after the CLI turn
  // ended) keeps the session "running" so the Sidebar dot reflects the real
  // work, not just the finished chat turn. Ranked last so an in-flight turn's
  // own status (running/waiting/aiEditing) always takes precedence.
  if (hasSessionKey(state.jobSessions ?? [], sessionKey)) return 'running';
  return null;
}

export type WorkflowDeleteProtectionReason = SessionLiveStatus;

export function workflowDeleteProtectionReason(
  session: Pick<Session, 'id'>,
  workspaceId: string | null | undefined,
  state: SessionLiveStatusState,
): WorkflowDeleteProtectionReason {
  return sessionLiveStatus(
    { workspaceId: workspaceId ?? null, sessionId: session.id },
    state,
  );
}

export const WORKSPACE_HISTORY_LIMIT = 8;
const CANVAS_VIEWPORT_PERSIST_DEBOUNCE_MS = 250;

let historyNavigationVersion = 0;

export function beginHistoryNavigation(): number {
  historyNavigationVersion += 1;
  return historyNavigationVersion;
}

export function isLatestHistoryNavigation(version: number): boolean {
  return version === historyNavigationVersion;
}

const canvasViewportPersistTimers = new Map<
  string,
  ReturnType<typeof setTimeout>
>();
const canvasViewportMemory = new Map<string, CanvasViewport | null>();

// Mirror historyStore's id format so an optimistic session and its persisted
// record share the same id (no swap / flicker on reconcile).
function randomSessionId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `s_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
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

export function chatWorkflow(title: string | undefined, locale: Locale): IRGraph {
  return withNewSessionGatewayDefaults(simpleBlueprint(title, locale));
}

export function imageResultMarkdown(result: {
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

/**
 * Translate the internal image-generation error codes / raw provider errors
 * into actionable Chinese guidance. `generateImage` throws sentinel strings
 * like `NO_READY_IMAGE_PROVIDER` or `IMAGE_PROVIDER_NOT_READY:<id>` that mean
 * nothing to a user; surface them as concrete next steps instead.
 */
export function friendlyImageGenerationError(message: string): string {
  if (message === 'IMAGE_GENERATION_DISABLED') {
    return '生图功能已关闭。请在 设置 > 生图 中打开“启用生图”开关。';
  }
  if (message === 'NO_READY_IMAGE_PROVIDER') {
    return '尚未配置可用的图片 Provider。请在 设置 > 生图 中选择一个图片模型渠道，并填写对应的 API Key / Base URL。';
  }
  if (message.startsWith('IMAGE_PROVIDER_NOT_READY:')) {
    const providerId = message.slice('IMAGE_PROVIDER_NOT_READY:'.length);
    const settings = loadImageGenerationSettings();
    const label = isImageProviderId(providerId, settings)
      ? imageProviderById(providerId, settings).label
      : providerId;
    return `图片 Provider「${label}」尚未配置完整（缺少 API Key、Account ID 或 Base URL）。请在 设置 > 生图 中补全后重试。`;
  }
  return message;
}

function isImageProviderId(
  value: unknown,
  settings = loadImageGenerationSettings(),
): value is ImageProviderId {
  return (
    typeof value === 'string' &&
    imageProviders(settings).some((provider) => provider.id === value)
  );
}

export function musicResultMarkdown(result: {
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

export function videoResultMarkdown(result: {
  providerLabel: string;
  model: string;
  prompt: string;
  videos: string[];
}): string {
  const routeLine = `⚙ 路由：${result.providerLabel} · 模型：${result.model}`;
  const videoLines = result.videos
    .map((src, index) => `[播放视频 ${index + 1}](${src})`)
    .join('\n\n');
  return `${routeLine}\n✓ 视频生成完成\n\n提示词：${result.prompt}\n\n${videoLines}`;
}

export function animationResultMarkdown(result: {
  providerLabel: string;
  model: string;
  prompt: string;
  mode: string;
  fallbackReason?: string;
  videos: string[];
  models: string[];
  clips: string[];
  metadata: string[];
  searchResults: Array<{
    providerLabel: string;
    title: string;
    url: string;
    use?: string;
    targets: string[];
    formats: string[];
  }>;
}): string {
  const routeLine = `⚙ 路由：${result.providerLabel} · 模型：${result.model}`;
  const modeLine = result.mode === 'search' ? '动作库搜索完成' : '动画生成完成';
  const fallbackLine = result.fallbackReason ? `\n⚠ ${result.fallbackReason}` : '';
  const videoLines = result.videos
    .map((src, index) => `[播放动画预览 ${index + 1}](${src})`)
    .join('\n\n');
  const modelLines = result.models
    .map((src, index) => `[预览动画模型 ${index + 1}](${modelAssetHref(src)})`)
    .join('\n\n');
  const clipLines = result.clips
    .map((src, index) => `[动画剪辑 ${index + 1}](${modelAssetHref(src)})`)
    .join('\n\n');
  const metadataLines = result.metadata
    .map((src, index) => `[动画元数据 ${index + 1}](${src})`)
    .join('\n\n');
  const searchLines = result.searchResults
    .map((item) => {
      const target = item.targets.length ? ` · 目标：${item.targets.join(', ')}` : '';
      const formats = item.formats.length ? ` · 格式：${item.formats.join(', ')}` : '';
      const note = item.use ? ` · 说明：${item.use}` : '';
      return `- [${item.title}](${item.url})${target}${formats}${note}`;
    })
    .join('\n');
  const assets = [
    videoLines ? `预览：\n\n${videoLines}` : '',
    modelLines ? `模型：\n\n${modelLines}` : '',
    clipLines ? `剪辑：\n\n${clipLines}` : '',
    metadataLines ? `元数据：\n\n${metadataLines}` : '',
    searchLines ? `搜索结果：\n${searchLines}` : '',
  ].filter(Boolean);
  return `${routeLine}\n✓ ${modeLine}${fallbackLine}\n\n需求：${result.prompt}\n\n${assets.join('\n\n')}`;
}

export function speechResultMarkdown(result: {
  providerLabel: string;
  model: string;
  voice: string;
  prompt: string;
  audios: string[];
}): string {
  const voicePart = result.voice ? ` · 音色：${result.voice}` : '';
  const routeLine = `⚙ 路由：${result.providerLabel} · 模型：${result.model}${voicePart}`;
  const audioLines = result.audios
    .map((src, index) => `[播放语音 ${index + 1}](${src})`)
    .join('\n\n');
  return `${routeLine}\n✓ 语音合成完成\n\n文本：${result.prompt}\n\n${audioLines}`;
}

export function spriteResultMarkdown(result: {
  providerLabel: string;
  model: string;
  prompt: string;
  mode: string;
  frameCount: number;
  frameSize: number;
  spritesheets: string[];
  frames: string[];
  gifs: string[];
  videos: string[];
  metadata: string[];
}): string {
  const routeLine = `⚙ 路由：${result.providerLabel} · 模型：${result.model}`;
  const metaLine = `模式：${result.mode} · 帧数：${result.frameCount} · 帧尺寸：${result.frameSize}px`;
  const sheetLines = result.spritesheets
    .map((src, index) => `![Sprite Sheet ${index + 1}](${src})`)
    .join('\n\n');
  const gifLines = result.gifs
    .map((src, index) => `![GIF 预览 ${index + 1}](${src})`)
    .join('\n\n');
  const frameLines = result.frames
    .map((src, index) => `[序列帧 ${index + 1}](${src})`)
    .join('\n\n');
  const videoLines = result.videos
    .map((src, index) => `[播放视频 ${index + 1}](${src})`)
    .join('\n\n');
  const metadataLines = result.metadata
    .map((src, index) => `[元数据 ${index + 1}](${src})`)
    .join('\n\n');
  const assets = [
    sheetLines,
    gifLines,
    frameLines ? `序列帧：\n\n${frameLines}` : '',
    videoLines ? `视频：\n\n${videoLines}` : '',
    metadataLines ? `元数据：\n\n${metadataLines}` : '',
  ].filter(Boolean);
  return `${routeLine}\n✓ Sprite raw sheet 生成完成\n${metaLine}\n后续可用于规范化、切帧、manifest 和质检。\n\n提示词：${result.prompt}\n\n${assets.join('\n\n')}`;
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

export function threeDResultMarkdown(result: {
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

export function worldModelResultMarkdown(result: {
  providerLabel: string;
  model: string;
  prompt: string;
  specBody: string;
  assets: string[];
}): string {
  const routeLine = `⚙ 路由：${result.providerLabel} · 模型：${result.model}`;
  const assetLines = result.assets
    .map((src, index) => `[打开世界资源 ${index + 1}](${modelAssetHref(src)})`)
    .join('\n\n');
  const assetsBlock = assetLines ? `\n\n${assetLines}` : '';
  return `${routeLine}\n✓ 世界模型生成完成\n\n提示词：${result.prompt}${assetsBlock}\n\n\`\`\`worldmodel\n${result.specBody}\n\`\`\``;
}

export function friendlyWorldModelGenerationError(message: string): string {
  if (message === 'WORLD_MODEL_GENERATION_DISABLED') {
    return '世界模型功能已关闭。请在 设置 > 世界模型 中打开“启用世界模型”开关。';
  }
  if (message === 'NO_READY_WORLD_MODEL_PROVIDER') {
    return '尚未配置可用的世界模型 Provider。请在 设置 > 世界模型 中选择渠道，并填写对应的 API Key / Base URL。';
  }
  if (message.startsWith('WORLD_MODEL_PROVIDER_NOT_READY:')) {
    const providerId = message.slice('WORLD_MODEL_PROVIDER_NOT_READY:'.length);
    const settings = loadWorldModelGenerationSettings();
    const label = isWorldModelProviderId(providerId, settings)
      ? worldModelProviderById(providerId, settings).label
      : providerId;
    return `世界模型 Provider「${label}」尚未配置完整（缺少 API Key 或 Base URL，或该渠道暂无公开 API）。请在 设置 > 世界模型 中补全后重试。`;
  }
  return message;
}

function isWorldModelProviderId(
  value: unknown,
  settings = loadWorldModelGenerationSettings(),
): value is WorldModelProviderId {
  return (
    typeof value === 'string' &&
    worldModelProviders(settings).some((provider) => provider.id === value)
  );
}

function threeDAssetFileName(src: string, index: number): string {
  const clean = src.trim().split(/[?#]/, 1)[0] ?? '';
  const ext =
    /\.(glb|gltf|obj|stl|fbx|ply|usdz|zip)$/i.exec(clean)?.[1]?.toLowerCase() ??
    'glb';
  return `3d-model-${index + 1}.${ext}`;
}

export async function downloadThreeDAssets(
  assets: string[],
  cwd?: string,
  context?: {
    sessionId?: string | null;
    workspaceId?: string | null;
    messageId?: string;
    pendingAssetId?: string | null;
  },
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
        sessionId: context?.sessionId ?? undefined,
        workspaceId: context?.workspaceId ?? null,
        messageId: context?.messageId,
        trackAssetId: downloaded.length === 0 ? (context?.pendingAssetId ?? undefined) : undefined,
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

export function meshSearchResultMarkdown(
  result: MeshSearchResult,
  downloaded: Map<string, string>,
  settings: MeshLibraryAccountSettings,
  queryResolution?: MeshSearchQueryResolution,
): string {
  const lines: string[] = [];
  lines.push(
    queryResolution?.translated && queryResolution.sourceQuery !== result.query
      ? `🔎 在线模型库搜索：${queryResolution.sourceQuery}`
      : `🔎 在线模型库搜索：${result.query}`,
  );
  if (queryResolution?.translated && queryResolution.sourceQuery !== result.query) {
    lines.push(`英文搜索词：${result.query}`);
  } else if (queryResolution?.translationError) {
    lines.push(`英文化搜索词失败，已改用原词：${queryResolution.translationError}`);
  }
  const enabledLabels = settings.enabledIds
    .map((id) => meshLibraryById(id, settings)?.label)
    .filter((label): label is string => !!label);
  if (enabledLabels.length > 0) {
    lines.push(`已搜索：${enabledLabels.join('、')}`);
  }
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
    if (settings.enabledIds.length === 0) {
      lines.push('\n没有启用任何在线模型库。请在设置 > 在线模型库中启用并配置账号。');
    } else {
      lines.push('\n未找到匹配的在线模型结果。可以换成更通用的关键词再试，例如 `cartoon bear`、`low poly bear` 或 `teddy bear`。');
    }
  }
  return lines.join('\n');
}

export async function downloadMeshSearchAssets(
  result: MeshSearchResult,
  settings: ReturnType<typeof loadMeshLibrarySettings>,
  cwd?: string,
  context?: {
    sessionId?: string | null;
    workspaceId?: string | null;
    messageId?: string;
    pendingAssetId?: string | null;
  },
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
        sessionId: context?.sessionId ?? undefined,
        workspaceId: context?.workspaceId ?? null,
        messageId: context?.messageId,
        trackAssetId: downloaded.size === 0 ? (context?.pendingAssetId ?? undefined) : undefined,
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

function generatedAssetExtension(kind: AssetKind): string {
  switch (kind) {
    case 'image':
    case 'sprite':
      return 'png';
    case 'video':
      return 'mp4';
    case 'audio':
    case 'music':
    case 'speech':
      return 'mp3';
    case 'mesh':
    case 'model':
      return 'glb';
    default:
      return 'bin';
  }
}

export function registerPendingGeneratedAsset(input: {
  kind: AssetKind;
  origin: AssetOrigin;
  provider?: string;
  model?: string;
  prompt: string;
  sessionId?: string | null;
  workspaceId?: string | null;
  messageId: string;
  titlePrefix: string;
  meta?: Record<string, unknown>;
}): string {
  return registerAsset({
    kind: input.kind,
    source: 'generated',
    origin: input.origin,
    title: `${input.titlePrefix}.${generatedAssetExtension(input.kind)}`,
    provider: input.provider,
    model: input.model,
    prompt: input.prompt,
    sessionId: input.sessionId ?? undefined,
    workspaceId: input.workspaceId ?? null,
    messageId: input.messageId,
    meta: input.meta,
  });
}

export function linkMessageManagedAssets(
  message: Message,
  sessionKey: WorkflowSessionKey,
  cwd?: string,
): void {
  // The Asset Hub only tracks what the AI produced/handled (generated,
  // downloaded, modified). Asset paths the user types are not AI-handled
  // assets, so skip non-assistant messages.
  if (message.role !== 'assistant' || !sessionKey.sessionId) return;
  linkManagedAssetsFromMessageText({
    text: message.text,
    sessionId: sessionKey.sessionId,
    workspaceId: sessionKey.workspaceId,
    messageId: message.id,
    at: message.createdAt,
    cwd: message.fileChanges?.rootPath ?? cwd ?? useStore.getState().workspaces.find(workspace => workspace.id === sessionKey.workspaceId)?.path,
  });
  linkModifiedAssetsFromMessage({ changes: message.fileChanges, sessionId: sessionKey.sessionId, workspaceId: sessionKey.workspaceId, messageId: message.id, at: message.createdAt });
}

export function threeDFailureHint(message: string): string {
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

export function visibleChatSessionSummaries(
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

export function normalizeScheduledTask(
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
  if (raw.cronExpression !== undefined) {
    if (typeof raw.cronExpression !== 'string') return undefined;
    try { parseCron(raw.cronExpression); } catch { return undefined; }
  }
  if (raw.timeZone !== undefined && (typeof raw.timeZone !== 'string' || !validTimeZone(raw.timeZone))) return undefined;
  if (raw.onceAt !== undefined && (typeof raw.onceAt !== 'number' || !Number.isFinite(raw.onceAt) || raw.cronExpression !== undefined)) return undefined;
  if (raw.promptLocale !== undefined && !SUPPORTED_LOCALES.includes(raw.promptLocale)) return undefined;
  if (raw.maxHistoryRuns !== undefined && (!Number.isSafeInteger(raw.maxHistoryRuns) || raw.maxHistoryRuns < 1)) return undefined;
  return {
    ...(typeof raw.name === 'string' ? { name: raw.name.trim() } : {}),
    ...(typeof raw.templateId === 'string' ? { templateId: raw.templateId } : {}),
    ...(raw.cronExpression !== undefined ? { cronExpression: raw.cronExpression.trim() } : {}),
    ...(raw.timeZone !== undefined ? { timeZone: raw.timeZone } : {}),
    ...(raw.promptLocale !== undefined ? { promptLocale: raw.promptLocale } : {}),
    ...(raw.maxHistoryRuns !== undefined ? { maxHistoryRuns: raw.maxHistoryRuns } : {}),
    ...(raw.onceAt !== undefined ? { onceAt: raw.onceAt } : {}),
    ...(typeof raw.lastError === 'string' ? { lastError: raw.lastError } : {}),
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

export function sessionFromSummary(summary: SessionSummary): Session {
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
    ...(summary.unreadCompletion === true ? { unreadCompletion: true } : {}),
    ...(summary.contextCompressed === true ? { contextCompressed: true } : {}),
    ...(summary.favorite === true ? { favorite: true } : {}),
    ...(summary.pinned === true ? { pinned: true } : {}),
    ...(scheduledTask ? { scheduledTask } : {}),
  };
}

const LEGACY_TURN_CLOCK_RE =
  /^⏱\s*\d{1,2}:\d{2}(?::\d{2})?\s*→\s*(\d{1,2}):(\d{2})(?::(\d{2}))?/u;
const DAY_MS = 86_400_000;

function legacyAssistantCompletedTimestamp(message: Message): number | null {
  if (message.role !== 'assistant') return null;
  if (!Number.isFinite(message.createdAt)) return null;
  const match = message.text.match(LEGACY_TURN_CLOCK_RE);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = match[3] ? Number(match[3]) : 0;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  if (second < 0 || second > 59) return null;
  const end = new Date(message.createdAt);
  end.setHours(hour, minute, second, 0);
  let timestamp = end.getTime();
  if (timestamp < message.createdAt - 60_000) timestamp += DAY_MS;
  return timestamp;
}

export function summaryFromRecord(record: SessionRecord): SessionSummary {
  const last = record.messages[record.messages.length - 1]?.text?.trim();
  const runStatus = record.meta?.runStatus;
  const scheduledTask = normalizeScheduledTask(record.meta?.scheduledTask);
  const completedAt = [...record.messages]
    .reverse()
    .map((message) =>
      typeof message.completedAt === 'number' && Number.isFinite(message.completedAt)
        ? message.completedAt
        : legacyAssistantCompletedTimestamp(message),
    )
    .find((timestamp) => typeof timestamp === 'number' && Number.isFinite(timestamp));
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    title: record.title,
    isWorkflow: record.isWorkflow,
    createdAt: record.createdAt,
    updatedAt: completedAt ?? record.updatedAt,
    ...(record.workflow?.meta?.simple ? { simple: true } : {}),
    preview: last ? last.slice(0, 80) : undefined,
    messageCount: record.messages.length,
    ...(runStatus ? { runStatus } : {}),
    ...(record.meta?.unreadCompletion === true ? { unreadCompletion: true } : {}),
    ...(sessionHasContextCompression(record.messages, record.meta) ? { contextCompressed: true } : {}),
    ...(record.meta?.favorite === true ? { favorite: true } : {}),
    ...(record.meta?.pinned === true ? { pinned: true } : {}),
    ...(scheduledTask ? { scheduledTask } : {}),
  };
}

export function sessionFromRecord(record: SessionRecord): Session {
  return sessionFromSummary(summaryFromRecord(record));
}

export async function loadSessionTree(
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
  return { ...Object.fromEntries(pairs),
    [SCHEDULED_TASK_SCOPE]: (await historyStore.listSessions(SCHEDULED_TASK_SCOPE)).map(sessionFromSummary),
  };
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

export function sessionForKey(
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

export function canvasViewportForSession(
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
          preserveUpdatedAt: true,
        })
        .catch(() => undefined);
    }, CANVAS_VIEWPORT_PERSIST_DEBOUNCE_MS),
  );
}

function sessionWithRunStatus(
  session: Session,
  runStatus: SessionRunStatus | undefined,
  unreadCompletion: boolean,
): Session | null {
  const runStatusChanged = session.runStatus !== runStatus;
  const unreadChanged = (session.unreadCompletion === true) !== unreadCompletion;
  if (!runStatusChanged && !unreadChanged) return null;
  const next: Session = { ...session };
  if (runStatusChanged) {
    if (runStatus) next.runStatus = runStatus;
    else delete next.runStatus;
  }
  if (unreadCompletion) next.unreadCompletion = true;
  else delete next.unreadCompletion;
  return next;
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
  // A run that completes while the user is already looking at its session needs
  // no "unviewed" badge; anything else completing in the background does.
  const isActive = sameSessionKey(activeWorkflowSessionKey(state), sessionKey);
  const unreadCompletion = runStatus === 'success' && !isActive;

  let sessionsChanged = false;
  const nextSessions = state.sessions.map((session) => {
    if (!matchesSession(session)) return session;
    const next = sessionWithRunStatus(session, runStatus, unreadCompletion);
    if (!next) return session;
    sessionsChanged = true;
    return next;
  });

  let sessionTreeChanged = false;
  let nextSessionTree = state.sessionTree;
  if (sessionKey.workspaceId !== null) {
    const current = state.sessionTree[sessionKey.workspaceId];
    if (current) {
      const mapped = current.map((session) => {
        if (!matchesSession(session)) return session;
        const next = sessionWithRunStatus(session, runStatus, unreadCompletion);
        if (!next) return session;
        sessionTreeChanged = true;
        return next;
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

function sessionRunUnreadCompletion(
  sessionKey: WorkflowSessionKey,
  status: IRRunStatus | undefined,
): boolean {
  const state = useStore.getState();
  const isActive = sameSessionKey(activeWorkflowSessionKey(state), sessionKey);
  return status === 'success' && !isActive;
}

export function syncAndPersistSessionRunStatus(
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
      meta: {
        runStatus: status ?? 'idle',
        unreadCompletion: sessionRunUnreadCompletion(sessionKey, status),
      },
    })
    .catch(() => {});
}

/**
 * Clear a session's "unviewed completion" flag (in-memory + persisted) once the
 * user actually opens it. Idempotent — safe to call on every activation.
 */
function markSessionCompletionViewed(sessionKey: WorkflowSessionKey): void {
  if (!sessionKey.sessionId) return;

  useStore.setState((state) => {
    const clearUnread = (session: Session): Session | null => {
      if (session.id !== sessionKey.sessionId) return null;
      if (
        sessionKey.workspaceId !== null &&
        session.workspaceId !== undefined &&
        session.workspaceId !== sessionKey.workspaceId
      ) {
        return null;
      }
      if (session.unreadCompletion !== true) return null;
      const next = { ...session };
      delete next.unreadCompletion;
      return next;
    };

    let sessionsChanged = false;
    let sessionTreeChanged = false;
    let nextSessions = state.sessions;
    let nextSessionTree = state.sessionTree;

    const mappedSessions = state.sessions.map((session) => {
      const next = clearUnread(session);
      if (!next) return session;
      sessionsChanged = true;
      return next;
    });
    if (sessionsChanged) nextSessions = mappedSessions;

    if (
      sessionKey.workspaceId !== null &&
      state.sessionTree[sessionKey.workspaceId]
    ) {
      const mapped = state.sessionTree[sessionKey.workspaceId].map((session) => {
        const next = clearUnread(session);
        if (!next) return session;
        sessionTreeChanged = true;
        return next;
      });
      if (sessionTreeChanged) {
        nextSessionTree = {
          ...state.sessionTree,
          [sessionKey.workspaceId]: mapped,
        };
      }
    }

    if (!sessionsChanged && !sessionTreeChanged) return state;
    return {
      sessions: nextSessions,
      sessionTree: nextSessionTree,
    };
  });

  if (!sessionKey.workspaceId) return;
  void historyStore
    .updateSession(sessionKey.workspaceId, sessionKey.sessionId, {
      meta: { unreadCompletion: false },
      preserveUpdatedAt: true,
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

function notifySessionWaitingInput(
  sessionKey: WorkflowSessionKey,
  req: InteractionRequest,
): void {
  const state = useStore.getState();
  const session = sessionForKey(state, sessionKey);
  const sessionTitle =
    session?.title?.trim() ||
    state.workflow.meta?.name?.trim() ||
    null;
  void notifySessionComplete({
    status: 'waitingInput',
    sessionTitle,
    detail: req.prompt,
    workspaceId: sessionKey.workspaceId,
    sessionId: sessionKey.sessionId,
  });
}

function scheduleSessionWaitingInputNotification(
  sessionKey: WorkflowSessionKey | null,
  req: InteractionRequest,
  messageId: string,
): void {
  if (!sessionKey) return;
  globalThis.setTimeout(() => {
    if (!pendingInteractionResolvers.has(messageId)) return;
    notifySessionWaitingInput(sessionKey, req);
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

// [M3] The pure run-snapshot <-> session-meta mappers moved to ./runSnapshot.
// They are imported above and re-exported below so existing import sites
// (historyActions, workflowEditorSlice, tests) keep resolving them from here.

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

// [M3] workflowWithoutRunSnapshot / workflowWithRunSnapshot moved to
// ./runSnapshot (imported + re-exported below).

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

// [M3] runSnapshotFromState / runMetaFromSnapshot / restoreWorkflowRunSnapshot
// moved to ./runSnapshot (imported + re-exported below). runSnapshotFromState
// now takes a state slice; useStore passes the full state, which satisfies it.

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
          ...(sessionHasContextCompression(messages) ? { contextCompressed: true } : {}),
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

export async function pruneScheduledTaskHistory(workspaceId: string, sessionId: string): Promise<void> {
  flushAiEditPersistKey(aiEditPersistKey(workspaceId, sessionId));
  const result = await historyStore.pruneScheduledTaskHistory(workspaceId, sessionId, () => new Set(
    getAiEditChannelsForSession(workspaceId, sessionId).flatMap((channel) => [...(channel.ownedMessageIds ?? [])]),
  ));
  if (!result) return;
  if (!result.removedIds.length) {
    if (result.backupError) throw result.backupError;
    return;
  }
  const removedIds = new Set(result.removedIds);
  pruneAiEditSourcesForDeletion(workspaceId, sessionId, removedIds);
  useStore.setState((state) => {
    const viewing = state.activeWorkspaceId === workspaceId && state.activeSessionId === sessionId;
    const messages = viewing ? removeMessagesById(state.messages, removedIds) : undefined;
    const sourceMessages = messages ?? getAiEditViewSource(workspaceId, sessionId)?.messages ?? result.record.messages;
    const last = [...sourceMessages].reverse().find((message) => message.text.trim());
    const update = (session: Session): Session => sessionMatchesTarget(session, sessionId, workspaceId)
      ? { ...session, messageCount: sourceMessages.length, preview: last ? previewFromText(last.text) : undefined }
      : session;
    return {
      ...(messages ? { messages, workflow: simpleWorkflowFromMessages(state.workflow, messages) } : {}),
      sessions: state.sessions.map(update),
      sessionTree: state.sessionTree[workspaceId]
        ? { ...state.sessionTree, [workspaceId]: state.sessionTree[workspaceId].map(update) }
        : state.sessionTree,
    };
  });
  if (result.backupError) throw result.backupError;
}

export function applyPromptTitle(
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

type SessionTitleNamingPhase = 'intent' | 'summary';

const MAX_SESSION_TITLE_NAMING_IMAGES = 2;


const sessionTitleNamingInFlight = new Set<string>();
const sessionIntentAutoTitles = new Map<string, Set<string>>();
let sessionTitleNamingEpoch = 0;

function sessionTitleImageRefs(userText: string, cwd?: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const part of scanFileRefs(userText)) {
    if (typeof part === 'string' || !isImageFileRef(part)) continue;
    const path = displayFileRefPath(part, cwd);
    const key = path.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    paths.push(path);
  }
  return paths;
}

function sessionTitleImageCount(userText: string, cwd?: string): number {
  return sessionTitleImageRefs(userText, cwd).length;
}

function firstTurnFallbackTitle(
  userText: string,
  locale: Locale,
  imageCount: number,
): string {
  const derived = titleFromText(userText);
  if (!isAutoTitlePlaceholder(derived)) return derived;
  if (imageCount <= 0) return derived;
  return locale === 'en-US' ? 'Image chat' : '图片分析';
}

function canAttachSessionTitleImages(route: ResolvedGatewayRoute): boolean {
  return (
    route.mode === 'direct' &&
    (route.transport === 'anthropic' ||
      route.transport === 'openai-compatible')
  );
}

async function loadSessionTitleImages(
  userText: string,
  cwd?: string,
): Promise<string[]> {
  if (!isTauri() || (cwd && isRemoteWorkspacePath(cwd))) return [];
  const images: string[] = [];
  for (const path of sessionTitleImageRefs(userText, cwd).slice(
    0,
    MAX_SESSION_TITLE_NAMING_IMAGES,
  )) {
    if (/^(?:remote|remote-project):\/\//i.test(path)) continue;
    try {
      const preview = await previewLocalFile(path, { cwd });
      if (preview.kind !== 'image' || !preview.base64 || !preview.mime) continue;
      images.push(`data:${preview.mime};base64,${preview.base64}`);
    } catch {
      /* best-effort: missing image preview must not block title naming */
    }
  }
  return images;
}


function firstUserMessageId(messages: Message[]): string | null {
  return (
    messages.find(
      (message) =>
        message.role === 'user' && !message.localOnly && message.text.trim(),
    )?.id ?? null
  );
}

function canAutoReplaceSessionTitle(
  title: string | undefined,
  allowedAutoTitles: Set<string>,
): boolean {
  const trimmed = title?.trim();
  return !trimmed || isAutoTitlePlaceholder(trimmed) || allowedAutoTitles.has(trimmed);
}

function canAutoNameSession(record: SessionRecord): boolean {
  return !record.isWorkflow || record.workflow?.meta?.simple === true;
}

function sessionTitleNamingSessionKey(workspaceId: string, sessionId: string): string {
  return `${workspaceId}\u0000${sessionId}`;
}

function rememberSessionIntentAutoTitle(sessionKey: string, title: string): void {
  const trimmed = title.trim();
  if (!trimmed) return;
  const titles = sessionIntentAutoTitles.get(sessionKey) ?? new Set<string>();
  titles.add(trimmed);
  sessionIntentAutoTitles.set(sessionKey, titles);
}

function buildAllowedSessionAutoTitles(args: {
  record: SessionRecord;
  sessionKey: string;
  phase: SessionTitleNamingPhase;
  fallbackTitle: string;
  userText: string;
}): Set<string> {
  const titles = new Set([
    args.fallbackTitle.trim(),
    titleFromText(args.userText).trim(),
    args.record.workflow?.meta.name?.trim() ?? '',
  ]);
  if (args.phase === 'summary') {
    for (const title of sessionIntentAutoTitles.get(args.sessionKey) ?? []) {
      titles.add(title);
    }
  }
  titles.delete('');
  return titles;
}

async function resolveSessionTitleNamingRoute(
  selection: GatewaySelection,
  directRoute: ResolvedGatewayRoute | null,
): Promise<ResolvedGatewayRoute | null> {
  if (directRoute) return directRoute;
  if (!isTauri()) return null;
  if (isFreeChannelSelection(selection)) {
    await ensureFreeProxy(freeProxyOptionsForSelection(selection));
  }
  return resolveCliGatewayRoute(selection);
}

function applyGeneratedSessionTitleToState(
  workspaceId: string,
  record: SessionRecord,
): void {
  const updatedSession = sessionFromRecord(record);
  useStore.setState((state) => {
    const update = (session: Session): Session =>
      session.id === record.id && session.workspaceId === workspaceId
        ? updatedSession
        : session;
    const sessionTree = state.sessionTree[workspaceId]
      ? {
          ...state.sessionTree,
          [workspaceId]: state.sessionTree[workspaceId].map(update),
        }
      : state.sessionTree;
    return {
      sessions: state.sessions.map(update),
      sessionTree,
      workflow:
        state.activeWorkspaceId === workspaceId &&
        state.activeSessionId === record.id &&
        record.workflow
          ? record.workflow
          : state.workflow,
    };
  });
}

function scheduleFirstTurnSessionTitleNaming(args: {
  phase: SessionTitleNamingPhase;
  workspaceId: string | null;
  sessionId: string | null;
  userMessageId: string;
  userText: string;
  assistantText?: string;
  userImageCount?: number;
  fallbackTitle: string;
  locale: Locale;
  gatewaySelection: GatewaySelection;
  directRoute: ResolvedGatewayRoute | null;
  cwd?: string;
}): void {
  const { workspaceId, sessionId } = args;
  if (!workspaceId || !sessionId || !args.userText.trim()) return;
  if (args.phase === 'summary' && !args.assistantText?.trim()) return;

  const sessionKey = sessionTitleNamingSessionKey(workspaceId, sessionId);
  const inFlightKey = `${sessionKey}\u0000${args.phase}`;
  if (sessionTitleNamingInFlight.has(inFlightKey)) return;
  sessionTitleNamingInFlight.add(inFlightKey);
  const epoch = sessionTitleNamingEpoch;

  void (async () => {
    try {
      const initial = await historyStore.getSession(workspaceId, sessionId);
      if (!initial || !canAutoNameSession(initial)) return;
      const initialFirstUserId = firstUserMessageId(initial.messages);
      if (initialFirstUserId && initialFirstUserId !== args.userMessageId) return;

      const allowedAutoTitles = buildAllowedSessionAutoTitles({
        record: initial,
        sessionKey,
        phase: args.phase,
        fallbackTitle: args.fallbackTitle,
        userText: args.userText,
      });
      if (!canAutoReplaceSessionTitle(initial.title, allowedAutoTitles)) return;

      const route = await resolveSessionTitleNamingRoute(
        args.gatewaySelection,
        args.directRoute,
      );
      if (!route || sessionTitleNamingEpoch !== epoch) return;
      const userImages = canAttachSessionTitleImages(route)
        ? await loadSessionTitleImages(args.userText, args.cwd)
        : [];


      const title = await generateSessionTitle({
        route,
        userText: args.userText,
        assistantText: args.assistantText,
        userImageCount: args.userImageCount ?? 0,
        ...(userImages.length ? { userImages } : {}),

        fallbackTitle: args.fallbackTitle,
        locale: args.locale,
        cwd: args.cwd,
      });
      if (!title.trim() || title.trim() === initial.title.trim()) return;

      const latest = await historyStore.getSession(workspaceId, sessionId);
      if (!latest || !canAutoNameSession(latest) || sessionTitleNamingEpoch !== epoch) {
        return;
      }
      const latestFirstUserId = firstUserMessageId(latest.messages);
      if (latestFirstUserId && latestFirstUserId !== args.userMessageId) return;
      const latestAllowedAutoTitles = buildAllowedSessionAutoTitles({
        record: latest,
        sessionKey,
        phase: args.phase,
        fallbackTitle: args.fallbackTitle,
        userText: args.userText,
      });
      if (!canAutoReplaceSessionTitle(latest.title, latestAllowedAutoTitles)) return;

      const workflow = latest.workflow
        ? { ...latest.workflow, meta: { ...latest.workflow.meta, name: title } }
        : undefined;
      const updated = await historyStore.updateSession(workspaceId, sessionId, {
        title,
        ...(workflow ? { workflow } : {}),
        preserveUpdatedAt: true,
      });
      if (sessionTitleNamingEpoch !== epoch) return;
      if (args.phase === 'intent') {
        rememberSessionIntentAutoTitle(sessionKey, title);
      }
      applyGeneratedSessionTitleToState(workspaceId, updated);
    } catch {
      /* best-effort: title naming must never disturb chat completion */
    } finally {
      sessionTitleNamingInFlight.delete(inFlightKey);
    }
  })();
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

  // Optimistic, incremental new session.
  //
  // The old path awaited createSession -> listWorkspaces -> loadSessionTree
  // (which rebuilt EVERY workspace's session index from disk, one IPC per
  // session file) before switching the UI — that's the multi-second stall on
  // "new session". Instead: build the session locally, switch immediately, and
  // persist + reconcile in the background. The client-supplied id is reused by
  // the store so there is no id swap / flicker.
  const sessionId = randomSessionId();
  const now = Date.now();
  const session: Session = {
    id: sessionId,
    workspaceId,
    title,
    createdAt: now,
    updatedAt: now,
    isWorkflow: false,
    messageCount: 0,
  };
  const nextWorkflow = chatWorkflow(title, state.locale);
  const workspace = state.workspaces.find((item) => item.id === workspaceId);
  const fallbackComposer = defaultSessionComposer(
    workspace?.path,
    workspaceFoldersFromMetadata(workspace?.metadata),
  );
  // Publish the persistence barrier before the optimistic session is visible.
  // Skill bindings must never race the first history record into existence.
  const persistenceKey = runKey(workspaceId, sessionId);
  const sessionPersisted = historyStore.createSession({
    workspaceId, id: sessionId, isWorkflow: false, messages: [], title,
  }).then(() => {});
  pendingSessionCreations.set(persistenceKey, sessionPersisted);
  void sessionPersisted.catch(() => {});
  useStore.setState((s) => {
    if (s.activeWorkspaceId !== workspaceId) return {};
    const sessionKey = { workspaceId, sessionId };
    const composerPatch = composerPatchForSession(
      s,
      sessionKey,
      nextWorkflow,
      fallbackComposer,
    );
    saveComposerSoon({
      composer: composerPatch.composer,
      composerBySession: composerPatch.composerBySession,
      workspaceHistory: s.workspaceHistory,
    });
    const existing = s.sessionTree[workspaceId] ?? s.sessions;
    const sessions = [session, ...existing.filter((it) => it.id !== sessionId)];
    return {
      workflow: composerPatch.workflow,
      composer: composerPatch.composer,
      composerBySession: composerPatch.composerBySession,
      selectedNodeId: null,
      dirty: false,
      ...emptyRunProgress(),
      sessions,
      sessionTree: { ...s.sessionTree, [workspaceId]: sessions },
      activeSessionId: sessionId,
      selectedWorkspaceId: s.selectedWorkspaceId ?? workspaceId,
      messages: [],
      canvasViewport: null,
      currentFilePath: null,
      mode: 'design',
      ...composerDraftPatchForSession(s, sessionKey),
    };
  });

  // Persist + reconcile in the background. UI is already on the new session.
  void (async () => {
    try {
      await sessionPersisted;
      const current = useStore.getState();
      if (
        current.activeWorkspaceId === workspaceId &&
        current.activeSessionId === sessionId
      ) {
        await historyStore.patchConfig({
          lastActiveWorkspaceId: workspaceId,
          lastActiveSessionId: sessionId,
        });
      }
    } catch (err) {
      console.error('[new-session] failed to persist new chat session', err);
    } finally {
      if (pendingSessionCreations.get(persistenceKey) === sessionPersisted) {
        pendingSessionCreations.delete(persistenceKey);
      }
    }
  })();
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

interface UltraGameStudioSessionOptions {
  workspaceId?: string | null;
  forceNewSession?: boolean;
}

async function openWorkflowInSession(
  ir: IRGraph,
  path?: string,
  options: UltraGameStudioSessionOptions = {},
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
      // Opening a workflow into a session must not move the top switcher's
      // pinned workspace. Preserve the existing pin (initializing when unset).
      selectedWorkspaceId: s.selectedWorkspaceId ?? workspaceId,
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
  markSessionCompletionViewed({
    workspaceId: targetWorkspaceId ?? null,
    sessionId,
  });
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
            // History is still initializing; keep the visible chat transcript
            // until the persisted record is available instead of flashing blank.
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
  // The persisted record may still carry `unreadCompletion` because the async
  // clear in markSessionCompletionViewed has not flushed yet. Opening the
  // session IS the act of viewing it, so never promote a stale unread flag back
  // into the sidebar list (it would otherwise only clear after the next click).
  delete session.unreadCompletion;

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
  const liveAiEdit = aiEditSnapshot && activeAiEdits.get(aiEditSnapshot.key) === aiEditSnapshot
    ? aiEditSnapshot
    : null;

  const recordWorkflow = record.workflow
    ? restoreWorkflowRunSnapshot(record.workflow, record.meta)
    : null;
  const historicalGatewaySelection = historicalGatewaySelectionFromMessages(
    record.messages,
  );
  const workflow = liveRun
    ? liveRun.workflow
      : aiEditSnapshot
        ? aiEditSnapshot.workflow
      : recordWorkflow ??
        withoutWorkflowGatewayDefaults(simpleBlueprint(record.title, state.locale));
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
  // The persisted record is the authority, but a retained snapshot can be
  // either ahead of it (a stream that kept running while another session was on
  // screen) or behind it (an intermediate commit frozen mid-turn). Arbitrate per
  // message id by freshness so a stale snapshot can never bury the final answer
  // that is already on disk, while a fresh snapshot still restores in-flight
  // text the debounced write has not flushed yet.
  const viewMessages = liveRun
    ? liveRun.messages
    : aiEditSnapshot
      ? mergeMessagesById(record.messages, aiEditSnapshot.messages, (base, update) => {
          // Streaming chunks keep createdAt unchanged; the debounced disk copy
          // can therefore have the same timestamp while still being empty.
          // The live turn owns its messages. Retained snapshots and messages
          // belonging to other turns still use persisted freshness arbitration.
          if (liveAiEdit && (!liveAiEdit.chat || liveAiEdit.ownedMessageIds?.has(update.id))) {
            return update;
          }
          return newerMessage(base, update);
        })
      : record.messages;
  // Converge the RETAINED snapshot (channel already torn down) onto what we just
  // rendered. Without this the stale snapshot keeps winning on every later
  // switch back — it is never otherwise invalidated. Live channels are skipped:
  // their buffer is still being appended to, and overwriting the array under a
  // running stream would drop chunks the streamer still holds indices into.
  if (
    !liveRun &&
    aiEditSnapshot &&
    viewMessages !== aiEditSnapshot.messages &&
    !activeAiEdits.has(aiEditSnapshot.key)
  ) {
    aiEditSnapshot.messages = viewMessages;
    aiEditSnapshots.set(aiEditSnapshot.key, aiEditSnapshot);
  }
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
    const draftPatch = composerDraftPatchForSessionFromRecord(
      s,
      {
        workspaceId: targetWorkspaceId,
        sessionId: session.id,
      },
      record.meta,
    );
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
      historicalGatewaySelection,
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

function scheduledTaskAlertMessage(
  title: string,
  scheduledTask: ScheduledTaskConfig,
): string {
  const text = scheduledTask.reminderText.trim();
  const heading = scheduleText(scheduledTask.promptLocale ?? useStore.getState().locale, 'title');
  return text ? `${heading}\n${title}\n\n${text}` : `${heading}\n${title}`;
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
  if (sessionLiveStatus(sessionKey, state)) throw new Error(scheduleText(state.locale, 'busy'));

  const targetSessions = targetWorkspaceId
    ? sessionsForWorkspaceState(state, targetWorkspaceId)
    : state.sessions;
  const target = targetSessions.find((session) =>
    sessionMatchesTarget(session, sessionId, targetWorkspaceId),
  );
  if (!target) throw new Error(scheduleText(state.locale, 'failed'));

  if (normalizedTask.remindOnRun && typeof window !== 'undefined') {
    window.alert(scheduledTaskAlertMessage(target.title, normalizedTask));
  }

  if (targetWorkspaceId === SCHEDULED_TASK_SCOPE) {
    const record = await historyStore.getSession(SCHEDULED_TASK_SCOPE, sessionId);
    if (!record) throw new Error(scheduleText(state.locale, 'failed'));
    const key = workflowSessionKeyId(sessionKey);
    if (!state.composerBySession[key]) {
      const sourceWorkspaceId = record.meta?.scheduledTaskSourceWorkspaceId;
      const sourceSessionId = record.meta?.scheduledTaskSourceSessionId;
      const source = typeof sourceWorkspaceId === 'string' && typeof sourceSessionId === 'string'
        ? state.composerBySession[workflowSessionKeyId({ workspaceId: sourceWorkspaceId, sessionId: sourceSessionId })]
        : undefined;
      useStore.setState((s) => {
        const composerBySession = { ...s.composerBySession, [key]: source ?? {
          ...composerSnapshotFromState(s),
          composer: normalizeComposerSettings({ ...s.composer, workspace: typeof record.meta?.scheduledTaskExecutionPath === 'string' ? record.meta.scheduledTaskExecutionPath : '' }),
        } };
        saveComposerSoon({ composer: s.composer, composerBySession, workspaceHistory: s.workspaceHistory });
        return { composerBySession };
      });
    }
    const messages = getAiEditViewSource(SCHEDULED_TASK_SCOPE, sessionId)?.messages ?? record.messages;
    if (sessionLiveStatus(sessionKey, useStore.getState())) throw new Error(scheduleText(state.locale, 'busy'));
    if (!useStore.getState().sendPrompt(normalizedTask.reminderText, {
      locale: normalizedTask.promptLocale,
      scheduledTaskRun: true,
      externalSession: { workspaceId: SCHEDULED_TASK_SCOPE, sessionId, messages },
    })) throw new Error(scheduleText(state.locale, 'failed'));
    return;
  }

  await activateHistorySession(sessionId, targetWorkspaceId ?? undefined);
  const current = useStore.getState();
  if (
    current.activeSessionId !== sessionId ||
    (targetWorkspaceId !== null && current.activeWorkspaceId !== targetWorkspaceId)
  ) {
    throw new Error(scheduleText(state.locale, 'failed'));
  }
  if (
    sessionLiveStatus(
      { workspaceId: current.activeWorkspaceId ?? null, sessionId },
      current,
    )
  ) {
    throw new Error(scheduleText(state.locale, 'busy'));
  }

  if (current.workflow.meta?.simple === true || target.isWorkflow === false) {
    if (!current.sendPrompt(normalizedTask.reminderText, { locale: normalizedTask.promptLocale, scheduledTaskRun: true })) {
      throw new Error(scheduleText(state.locale, 'failed'));
    }
    return;
  }
  current.runWorkflow();
}

/** Create the task conversation without replacing the user's active conversation. */
export async function createScheduledTaskSession(task: ScheduledTaskConfig): Promise<WorkflowSessionKey> {
  const normalized = normalizeScheduledTask(task);
  if (!normalized?.name || !normalized.reminderText.trim()) throw new Error('Invalid scheduled task');
  const state = useStore.getState();
  const workspaceId = SCHEDULED_TASK_SCOPE;
  const id = randomSessionId();
  const now = Date.now();
  const session = state.historyReady && workspaceId
    ? sessionFromRecord(await historyStore.createSession({ workspaceId, id, title: normalized.name, isWorkflow: false, messages: [], meta: { scheduledTask: normalized, scheduledTaskExecutionPath: state.composer.workspace } }))
    : { id, title: normalized.name, createdAt: now, updatedAt: now, isWorkflow: false, messageCount: 0, scheduledTask: normalized, ...(workspaceId ? { workspaceId } : {}) };
  useStore.setState((s) => {
    const composerBySession = {
      ...s.composerBySession,
      [workflowSessionKeyId({ workspaceId, sessionId: id })]: {
        ...composerSnapshotFromState(state),
        composer: normalizeComposerSettings(state.composer),
      },
    };
    saveComposerSoon({ composer: s.composer, composerBySession, workspaceHistory: s.workspaceHistory });
    return {
      composerBySession,
      sessions: s.activeWorkspaceId === workspaceId ? [session, ...s.sessions] : s.sessions,
      sessionTree: workspaceId ? { ...s.sessionTree, [workspaceId]: [session, ...(s.sessionTree[workspaceId] ?? [])] } : s.sessionTree,
    };
  });
  return { sessionId: id, workspaceId };
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

export function sessionMatchesTarget(
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

// Cold-start directly into the plain chat surface. Hidden workflow snapshots
// remain on disk, but they are no longer restored into the user-facing UI.
const seedWorkflow = migrateWorkflowGateway(
  simpleBlueprint(undefined, seedLocale),
  defaultComposer.model,
);
const seedSettings = loadSettingsSliceSeeds(seedWorkflow, seedComposer, seedLocale);
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

export const useStore = create<StoreState>((set, get) => ({
  ...createWorkflowEditorSlice(
    set,
    {
      applyWorkflowEdit,
      canWriteWorkflow,
      emptyRunProgress,
      markActiveHistorySessionWorkflow,
      workflowWithoutRunSnapshot,
    },
    {
      workflow: seedWorkflowState,
      mode: 'design',
      runState: seedRunProgress.runState,
      runOutputs: seedRunProgress.runOutputs,
      lastRunFailedNodeId: seedRunProgress.lastRunFailedNodeId,
    },
  ),

  // AI: idle.
  aiStreaming: false,
  aiEditingSessions: [],
  chattingSessions: [],
  queuedChatMessageIds: [],
  steerableQueuedChatMessageIds: [],
  editingQueuedChatMessageId: null,
  waitingInputSessions: [],
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
  ...createSettingsSlice(set, get, seedSettings),

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
  jobSessions: [],
  jobSessionProgress: {},
  jobDetails: [],

  initHistory: () => {
    initHistorySlice();
  },

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

  // Export the current workflow IR to a user-chosen .ugs.json file. The run
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
    const normalized = persistGlobalGatewaySelection(selection);
    set((state) => {
      if (isWorkflowReadOnly(state)) return state;
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

  setDefaultRunSelection: (selection) => {
    const normalized = persistGlobalGatewaySelection(selection);
    set((state) => ({
      personalInstructions: personalInstructionsForSelection(
        state.personalInstructionsByModel,
        normalized,
      ),
    }));
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

  // [workflow 编排已废弃] 运行入口已短路（startWorkflowRun 入口直接 return）。
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

  setSessionPinned: (sessionId, workspaceId, pinned) =>
    setHistorySessionPinned(sessionId, workspaceId, pinned),

  setWorkflowFavoriteSession: (sessionId, workspaceId, favorite) =>
    setWorkflowFavoriteHistorySession(sessionId, workspaceId, favorite),

  setWorkflowScheduledTaskSession: (sessionId, workspaceId, scheduledTask) =>
    setWorkflowScheduledTaskHistorySession(sessionId, workspaceId, scheduledTask),

  runScheduledTaskSession: (sessionId, workspaceId, scheduledTask) =>
    runScheduledTaskHistorySession(sessionId, workspaceId, scheduledTask),

  setBackgroundJobState: (jobSessions, jobSessionProgress, jobDetails = []) => {
    const previousJobs = useStore.getState().jobSessions;
    useStore.setState({ jobSessions, jobSessionProgress, jobDetails });
    for (const key of previousJobs) {
      if (!key.workspaceId || !key.sessionId || hasSessionKey(jobSessions, key)) continue;
      const state = useStore.getState();
      if (!sessionLiveStatus(key, state) && sessionForKey(state, key)?.scheduledTask?.maxHistoryRuns !== undefined) {
        void pruneScheduledTaskHistory(key.workspaceId, key.sessionId).catch((error) => console.warn('[scheduled-task] 清理历史失败', error));
      }
    }
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
  runStudioPrompt: (task) => {
    const trimmed = task.trim();
    if (!trimmed) return;
    get().appendChatNote(
      '已关闭 /studio 动态多智能体编排。请直接描述编程、文档或分析需求，默认由当前编程模型单模型总控处理；素材生成、引擎识别、文件操作和验证仍由 UltraGameStudio 的专用能力承接。',
      'system',
    );
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

  generateVideoPrompt: (text, options = {}) => {
    startVideoGenerationTurn(text, options);
  },

  generateAnimationPrompt: (text, options = {}) => {
    startAnimationGenerationTurn(text, options);
  },

  generateSpeechPrompt: (text, options = {}) => {
    startSpeechGenerationTurn(text, options);
  },

  generateSpritePrompt: (text, options = {}) => {
    startSpriteGenerationTurn(text, options);
  },

  generateGddPrompt: (text, options = {}) => {
    const prompt = stripGddModeCommand(text);
    const userPrompt =
      prompt ||
      (options.finalize
        ? '冻结当前 GDD 草稿，提取资产/场景/玩法合约，并按差异落地资产和代码。'
        : '');
    if (!userPrompt) return;
    const systemPrompt = options.finalize
      ? gddModeFinalizePromptSystem()
      : gddModePromptSystem();
    void get().sendPrompt(`${systemPrompt}\n\n用户需求：\n${userPrompt}`);
  },

  generateComfyPrompt: (text) => {
    const prompt = stripComfyCommand(text);
    if (!prompt) return;
    // Route through the normal coding-model turn, but front-load the ComfyUI
    // authoring instruction so the model emits a ```comfyui block instead of
    // editing the workflow blueprint. This reuses all channel/persistence logic
    // and renders the result as an embedded node graph in the chat stream.
    //
    // Best-effort: fetch the server's actual node catalog so the model is told
    // which class_types really exist (otherwise it invents nodes the local
    // ComfyUI can't run, and POST /prompt rejects the graph). Falls back to the
    // base instruction if the server is unreachable.
    void (async () => {
      let systemPrompt = COMFY_PROMPT_SYSTEM;
      try {
        const info = await fetchComfyObjectInfo(comfyBaseUrl());
        if (info.classTypes.length > 0) {
          systemPrompt += `\n\n本地 ComfyUI 服务器实际可用的节点类型(只能使用其中的 class_type，不得编造其它节点)：\n${info.classTypes.join(', ')}`;
        }
      } catch {
        /* server unreachable — fall back to the base instruction */
      }
      void get().sendPrompt(`${systemPrompt}\n\n用户需求：\n${prompt}`);
    })();
  },

  generateWorldPrompt: (text) => {
    startWorldModelGenerationTurn(text);
  },

  generateUiPrompt: (text) => {
    const prompt = stripUiModeCommand(text);
    if (!prompt) return;
    const settingsProfile = settingsProfileForState(get());
    // Route through the normal coding-model turn, but front-load a game-UI
    // design instruction tied to the project's default UI channel so the model
    // produces interface specs / deliverables instead of editing the workflow
    // blueprint. Reuses all channel/persistence logic.
    void get().sendPrompt(
      `${uiDesignPromptSystem(settingsProfile)}\n\n用户需求：\n${prompt}`,
    );
  },

  generateBlueprintPrompt: (text) => {
    const prompt = stripBlueprintModeCommand(text);
    if (!prompt) return;
    const modeArgs = get().composer.blueprintModeArgs;
    void get().sendPrompt(
      `${blueprintModePromptSystem(modeArgs)}\n\n用户需求：\n${prompt}`,
    );
  },

  generateMetaHumanPrompt: (text) => {
    const prompt = stripMetaHumanModeCommand(text);
    if (!prompt) return;
    void get().sendPrompt(`${metaHumanModePromptSystem()}\n\n用户需求：\n${prompt}`);
  },

  searchMeshLibraryPrompt: (text) => {
    startMeshSearchTurn(text);
  },

  appendChatNote: (text, role = 'assistant', options) => {
    const msg: Message = {
      id: shortId('m'),
      role,
      text,
      createdAt: Date.now(),
      ...(options?.interaction
        ? {
            interaction: options.interaction,
            interactionStatus: 'pending' as const,
          }
        : {}),
      ...(options?.appAction ? { appAction: options.appAction } : {}),
      ...(options?.localOnly ? { localOnly: true } : {}),
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

  updateQueuedChatMessage: (messageId, text) => {
    const entry = queuedChatTurnEntryForMessage(messageId);
    const nextText = text.trim();
    if (!entry || !nextText) return false;
    const ch = entry.channel;
    ch.messages = ch.messages.map((message) =>
      message.id === messageId ? { ...message, text: nextText } : message,
    );
    ch.workflow = simpleWorkflowFromMessages(ch.workflow, ch.messages);
    rememberAiEditSnapshot(ch);
    if (aiEditViewActive(ch)) {
      set((state) => {
        const messages = state.messages.map((message) =>
          message.id === messageId ? { ...message, text: nextText } : message,
        );
        return {
          messages,
          workflow: simpleWorkflowFromMessages(state.workflow, messages),
          ...activeMessageSummaryPatch(state, messages),
        };
      });
    }
    updateAiEditSessionSummary(ch);
    persistQueuedChatConversation(ch);
    clearQueuedChatEditFor(messageId);
    return true;
  },

  reviseChatMessage: (messageId, text) => get().sendPrompt(text, { reviseMessageId: messageId }),

  selectChatRevision: (messageId, index) => {
    const state = get();
    const position = state.messages.findIndex((message) => message.id === messageId);
    const message = state.messages[position];
    if (!state.workflow.meta?.simple || message?.role !== 'user' || !message.chatRevisions?.length ||
        !Number.isInteger(index) || index < 0 || index > (message.chatRevisions?.length ?? 0) ||
        isWorkflowReadOnly(state) || getAiEditChatChannels(state.activeWorkspaceId, state.activeSessionId).length) return false;
    const versions = chatRevisionVersions(state.messages, position);
    const selected = versions.splice(index, 1)[0];
    if (!selected || index === (message.chatRevisionIndex ?? versions.length)) return false;
    const restored = selected.messages.map((item, offset) => offset === 0
      ? { ...item, chatRevisions: versions, chatRevisionIndex: index,
          editedAt: Math.max(Date.now(), (message.editedAt ?? message.createdAt) + 1) } : item);
    const messages = [...state.messages.slice(0, position), ...restored];
    invalidateChatRevisionSources(state, state.messages.slice(position));
    const workflow = simpleWorkflowFromMessages(state.workflow, messages);
    set({ messages, workflow, ...activeMessageSummaryPatch(state, messages) });
    void persistCurrentConversation(messages).catch((error) => console.warn('[chat-revision] 版本保存失败', error));
    return true;
  },

  deleteQueuedChatMessage: (messageId) => {
    const entry = queuedChatTurnEntryForMessage(messageId);
    if (!entry) return false;
    entry.cancelled = true;
    chatTurnQueueEntries.delete(entry.channel.key);
    clearQueuedChatEditFor(messageId);
    syncQueuedChatMessageIds();
    const ids = new Set([messageId]);
    const ch = entry.channel;
    pruneAiEditSourcesForDeletion(ch.workspaceId, ch.sessionId, ids);
    // A queued turn's channel may not be registered in `activeAiEdits` before
    // its FIFO slot starts, in which case the registry walk above cannot see
    // it. Prune the entry's own buffer explicitly so its `ownedMessageIds` and
    // messages stop carrying the deleted id.
    pruneAiEditSourceMessages(ch, ids);
    let nextMessages: Message[] | null = null;
    let nextWorkflow: IRGraph | null = null;
    let persistWorkflow = false;
    if (aiEditViewActive(ch)) {
      set((state) => {
        const messages = removeMessagesById(state.messages, ids);
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
    }
    // Persist AFTER the message leaves the view. `persistQueuedChatConversation`
    // rebuilds the written list through `mergeAiEditChatMessages`, whose merge
    // base is the visible `store.messages`; persisting first would merge the
    // just-deleted message straight back into the disk record, and switching to
    // another session and back would then resurrect it. Always persist (not only
    // when the session is visible): the conditional `persistCurrentConversation`
    // below is skipped for background sessions, and without this call the
    // deletion never reaches disk.
    persistQueuedChatConversation(ch);
    if (nextMessages) {
      void persistCurrentConversation(
        nextMessages,
        persistWorkflow ? nextWorkflow ?? undefined : undefined,
      );
    }
    return true;
  },

  steerQueuedChatMessage: (messageId) => steerQueuedChatTurn(messageId),

  beginQueuedChatMessageEdit: (messageId) => {
    // Only a message that is still queued may be edited; otherwise the gate
    // would pause a slot that no longer exists.
    if (!queuedChatTurnEntryForMessage(messageId)) return;
    beginQueuedChatEditGate(messageId);
    useStore.setState({ editingQueuedChatMessageId: messageId });
  },

  cancelQueuedChatMessageEdit: () => {
    const messageId = useStore.getState().editingQueuedChatMessageId;
    if (messageId) clearQueuedChatEditFor(messageId);
  },

  branchSessionFromMessage: (messageId) => {
    void branchChatSessionFromMessage(messageId);
  },

  learnSkills: (kind, text) => startExplicitSkillLearning(kind, text),

  reviewSkillLearningAction: (state, action, id) => reviewPersistedSkillLearningAction(state, action, id),

  updateSkillLearningState: async (messageId, state) => {
    await persistSkillLearningStateForSource(skillHistorySource(state), state, messageId);
  },

  sendPrompt: (text, options) => {
    const trimmed = text.trim();
    if (!trimmed) return false;
    // Game experts / producer orchestration are now explicit-only: they never
    // auto-fire from chat text. The host opts in by passing forceGameExperts
    // (wired to the multilingual `/game` slash command in AIDock). When the
    // user drilled into specific experts via a hierarchical path (e.g.
    // /游戏专家/编程/引擎程序 or /引擎程序), gameExpertIds pins exactly those.
    const forceGameExperts = options?.forceGameExperts === true;
    const pinnedGameExpertIds = options?.gameExpertIds ?? [];
    const selectedSkillIds = [...new Set(options?.skillIds ?? [])];
    // Capture the task language for this turn; never change the global UI locale.
    let state = options?.locale ? { ...useStore.getState(), locale: options.locale } : useStore.getState();
    if (options?.externalSession) {
      const target = options.externalSession;
      const workspace = state.workspaces.find((w) => w.id === target.workspaceId);
      if (!workspace && target.workspaceId !== SCHEDULED_TASK_SCOPE) return false;
      const key = { workspaceId: target.workspaceId, sessionId: target.sessionId };
      const stored = state.composerBySession[workflowSessionKeyId(key)]?.composer;
      const composer = normalizeComposerSettings({ ...(stored ?? state.composer), workspace: workspace?.path ?? stored?.workspace ?? '' });
      state = { ...state, activeWorkspaceId: target.workspaceId, activeSessionId: target.sessionId,
        composer, workflow: withSessionGatewayDefaults(chatWorkflow(target.workspaceId === SCHEDULED_TASK_SCOPE ? '定时任务' : '消息平台会话', state.locale),
          state.composerBySession[workflowSessionKeyId(key)]?.gatewaySelection ?? getExplicitActiveGatewaySelection()),
        messages: target.messages, mode: 'design' };
    }
    if (isWorkflowReadOnly(state)) return false;
    const revisionPosition = options?.reviseMessageId
      ? state.messages.findIndex((message) => message.id === options.reviseMessageId) : -1;
    const revisionMessage = revisionPosition >= 0 ? state.messages[revisionPosition] : undefined;
    if (options?.reviseMessageId) {
      if (options.externalSession || !state.workflow.meta?.simple || revisionMessage?.role !== 'user' || revisionMessage.localOnly ||
          revisionMessage.interaction || state.queuedChatMessageIds.includes(revisionMessage.id)) return false;
    }
    // Image generation is routed explicitly (the /image-mode-* sticky mode and
    // /image one-shot command in AIDock), never inferred from message text here.
    // sendPrompt always means AI editing / workflow authoring.
    const aiEditingSession = activeWorkflowSessionKey(state);
    // A fresh user message on a session means "I'm answering you with a new
    // turn, not by clicking the widget". Cancel any parked interaction for
    // THIS session so the previous chat turn's `awaitInteraction` resolves
    // null immediately and releases the per-session FIFO — otherwise the new
    // turn would queue behind an await that never resolves, which is exactly
    // the "sent it and nothing happened" stall.
    cancelParkedInteractionsForSession(aiEditingSession);
    const gatewaySelection = workflowDefaultGatewaySelection(
      state.workflow,
      state.composer.model,
    );
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

    const userMsg: Message = revisionMessage ? {
      ...revisionMessage,
      id: shortId('m'),
      text: trimmed,
      createdAt: state.messages.reduce((latest, message) => Math.max(latest, message.createdAt + 1), Date.now()),
      editedAt: Math.max(Date.now(), (revisionMessage.editedAt ?? revisionMessage.createdAt) + 1),
      replacesMessageId: revisionMessage.id,
      chatRevisions: undefined,
      chatRevisionIndex: undefined,
      interjected: undefined,
      interjectedReplyId: undefined,
      skillContext: undefined,
    } : {
      id: shortId('m'),
      role: 'user',
      text: trimmed,
      createdAt: Date.now(),
      ...(options?.scheduledTaskRun ? { scheduledTaskRun: true } : {}),
    };
    linkMessageManagedAssets(userMsg, aiEditingSession);
    const promptUpdate = applyPromptTitle(
      state,
      trimmed,
      userMsg.createdAt,
    );
    const activeSession = sessionForKey(state, aiEditingSession);
    const simpleMode = promptUpdate.workflow.meta?.simple === true;
    const replayFavoriteSimpleChat =
      !revisionMessage && simpleMode && activeSession?.favorite === true && aiEditingSession.workspaceId !== SCHEDULED_TASK_SCOPE;
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
      key: chatMode ? `${chatTurnKey(chSessionKey, userMsg.id)}${revisionMessage ? `::revision::${userMsg.editedAt}` : ''}` : chSessionKey,
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
    let skillLearningTurn: ReturnType<typeof beginSkillLearningTurn> | undefined;
    let skillExecutionOrigin: SkillOrigin | undefined;
    let nativeSkillTools: NativeCliSkillToolsOptions | undefined;
    preemptReviewBackground('memory'); // Preempt dispatched work; retain undispatched completed turns.
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
    // Capture the actual append/update outcome, not just session existence.
    // A later optimistic transcript write cannot repair this turn's failed fence.
    const sourceMessageReady = persistReviewSourceMessage(ch, userMsg, replayFavoriteSimpleChat
      ? { messages: structuredClone(ch.messages), ...(ch.workflowSession ? { workflow: ch.workflow } : {}), meta: emptyRunMeta() }
      : undefined);
    void sourceMessageReady.catch((error) => console.warn('[review-source] 来源消息保存失败', error));

    const ir = ch.workflow;
    // Simple-workflow mode: the AI dock is a plain CLI/chat. The user's input
    // goes straight to the model (no blueprint generation), and each input is
    // appended to the lone start node's userInputs so the node mirrors the
    // conversation. The graph stays a single node.
    const directRoute = resolveDirectGatewayRoute(gatewaySelection);
    const inTauri = isTauri();
    const projectEngineGuidance = projectEngineGuidanceForState(
      state,
      aiEditingSession,
    );
    const projectMcpGuidance = projectMcpGuidanceForState(state, aiEditingSession);
    const preferCliForProjectMcp = inTauri && !!projectMcpGuidance;
    const useApi = !!directRoute && !preferCliForProjectMcp;
    const useCli = (!useApi && inTauri) || preferCliForProjectMcp;
    const selectedRemoteWorkspaceConfig =
      simpleMode && workspaceRootPath && isRemoteWorkspacePath(workspaceRootPath)
        ? getRemoteWorkspace(remoteWorkspaceIdFromPath(workspaceRootPath))
        : null;
    const remoteProvider = parseRemoteProviderId(gatewaySelection.providerId);
    const selectedRemoteProviderMatchesWorkspace =
      !!remoteProvider &&
      !!workspaceRootPath &&
      isRemoteWorkspacePath(workspaceRootPath) &&
      remoteProvider.workspaceId === remoteWorkspaceIdFromPath(workspaceRootPath);
    // Intent-phase title naming fires immediately on send. In API mode
    // (directRoute != null) it uses the direct route; in CLI mode it falls
    // back to resolveSessionTitleNamingRoute → resolveCliGatewayRoute.
    if (
      simpleMode &&
      !selectedRemoteWorkspaceConfig &&
      (directRoute || isTauri())
    ) {
      const userImageCount = sessionTitleImageCount(
        trimmed,
        ch.workspaceRootPath ?? undefined,
      );
      scheduleFirstTurnSessionTitleNaming({
        phase: 'intent',
        workspaceId: ch.workspaceId,
        sessionId: ch.sessionId,
        userMessageId: userMsg.id,
        userText: trimmed,
        userImageCount,
        fallbackTitle: firstTurnFallbackTitle(
          trimmed,
          state.locale,
          userImageCount,
        ),
        locale: state.locale,
        gatewaySelection,
        directRoute,
        cwd: ch.workspaceRootPath ?? undefined,
      });
    }

    const pushAssistant = (txt: string, routeLabel?: string) => {
      const msg: Message = {
        id: shortId('m'),
        role: 'assistant',
        text: txt,
        ...(routeLabel ? { routeLabel } : {}),
        thinkingLevel: gatewaySelection.thinkingLevel || 'default',
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
    if (
      !useApi &&
      !useCli &&
      !selectedRemoteWorkspaceConfig
    ) {
      if (simpleMode) {
        // Simple mode is a direct model chat — there's no local fallback.
        pushAssistant(
          [
            '当前没有可用的模型后端，无法发送。请任选一种方式：',
            '· 直连 API：打开「设置 → 模型渠道」添加一个渠道，来源选 Claude Code（走 Anthropic API）或 Codex / Gemini（走 OpenAI 兼容 API），填好 Base URL 与 API Key，运行方式选“直连 API”。本地代理（如 http://127.0.0.1:8045）也按这里填。',
            '· 本地 CLI：仅桌面版可用，安装并配置好对应命令行后，运行方式选“本地 CLI”。',
            '配置完成后，在 AI 输入框底部把该渠道选为当前运行渠道，再重新发送。',
          ].join('\n'),
        );
        syncAndPersistSessionRunStatus(
          { workspaceId: ch.workspaceId, sessionId: ch.sessionId },
          'error',
        );
        removeAiEditChannel(ch);
        return true;
      }
      // [dynamic-only refactor] 本地意图引擎(applyIntent)蓝图编辑已停用。
      // 非简单模式 + 无后端：仅提示，不再做关键词改图。
      pushAssistant(
        [
          '当前环境无法调用所选运行时。请在「设置 → 模型渠道」添加并选用一个可用渠道：',
          '· 直连 API：来源选 Claude Code（Anthropic API）或 Codex / Gemini（OpenAI 兼容 API），填好 Base URL 与 API Key，运行方式选“直连 API”（本地代理同样按此填写）。',
          '· 本地 CLI：仅桌面版可用，配置好命令行后运行方式选“本地 CLI”。',
        ].join('\n'),
      );
      removeAiEditChannel(ch);
      return true;
    }

    if (remoteProvider && !selectedRemoteProviderMatchesWorkspace) {
      pushAssistant(
        '当前远程 Runner 渠道只适用于它绑定的云端项目。请切回对应云端项目，或切换为本地/系统默认渠道。',
      );
      syncAndPersistSessionRunStatus(
        { workspaceId: ch.workspaceId, sessionId: ch.sessionId },
        'error',
      );
      removeAiEditChannel(ch);
      return true;
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
      ch.activeAssistantMessageId = id;
      ch.ownedMessageIds?.add(id);
      ch.messages = [
        ...ch.messages,
        {
          id,
          role: 'assistant',
          text: initial,
          ...(routeLabel ? { routeLabel } : {}),
          thinkingLevel: gatewaySelection.thinkingLevel || 'default',
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
    const captureReferenceSources = (event: import('@/runtime/skills/types').SkillNativeToolEvent) => {
      if (event.provenance !== 'native-tool' || !activeId) return;
      const sources = sourcesFromTool(event);
      if (!sources.length) return;
      ch.messages = ch.messages.map((message) => message.id === activeId
        ? { ...message, referenceSources: mergeReferenceSources(message.referenceSources ?? [], sources) } : message);
      aiEditCommitMessages(ch, false);
    };
    // Per-turn token usage: snapshot the session meter before the turn, diff it
    // after the reply lands, and stamp the delta onto the assistant bubble so the
    // chat history keeps each turn's tokens/cache even after reload.
    const usageMeterContext = {
      workspaceId: ch.workspaceId,
      sessionId: ch.sessionId ?? undefined,
    };
    let explicitUsageInputTokens = 0;
    let explicitUsageOutputTokens = 0;
    let explicitUsageTotalTokens = 0;
    let explicitUsageCachedInputTokens = 0;
    let explicitUsageRealInputTokens = 0;
    let explicitUsageRealCachedInputTokens = 0;
    const rememberExplicitUsage = (
      report: ModelUsageReport,
      options: { estimated?: boolean },
    ) => {
      const delta = usageTurnFromReport(report, options);
      if (delta.totalTokens <= 0) return;
      explicitUsageInputTokens += delta.inputTokens;
      explicitUsageOutputTokens += delta.outputTokens;
      explicitUsageTotalTokens += delta.totalTokens;
      explicitUsageCachedInputTokens += delta.cachedInputTokens;
      if (!delta.estimated) {
        explicitUsageRealInputTokens += delta.inputTokens;
        explicitUsageRealCachedInputTokens += delta.cachedInputTokens;
      }
    };
    const explicitUsageDelta = (): UsageTurnDelta | null => {
      if (explicitUsageTotalTokens <= 0) return null;
      const estimated = explicitUsageRealInputTokens <= 0;
      return {
        inputTokens: explicitUsageInputTokens,
        outputTokens: explicitUsageOutputTokens,
        totalTokens: explicitUsageTotalTokens,
        cachedInputTokens: explicitUsageCachedInputTokens,
        cachePercent: estimated
          ? 0
          : (Math.min(
              explicitUsageRealInputTokens,
              explicitUsageRealCachedInputTokens,
            ) /
              explicitUsageRealInputTokens) *
            100,
        estimated,
      };
    };
    const stampUsageOnMessage = (
      messageId: string,
      before: ReturnType<typeof readUsageMeterSnapshot>,
      explicit?: UsageTurnDelta | null,
    ) => {
      if (!messageId) return;
      let delta = usageTurnFromSnapshots(
        before,
        readUsageMeterSnapshot(usageMeterContext),
      );
      if (delta.totalTokens <= 0 && explicit && explicit.totalTokens > 0) {
        delta = explicit;
      }
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
        languageDirective?: string;
      },
    ): Promise<string> => {
      await changesBaselineReady;
      const policy = timeoutPolicyForSelection(cli.selection, prompt);
      const startedAt = Date.now();
      let firstProgressAt: number | undefined;
      const runId = opts.runId ?? makeCliRunId();
      ch.cliRunIds.add(runId);
      // Carry the STORE session identity into the spawned CLI's env so any
      // long-running process it detaches (yt-dlp/whisper/ffmpeg) can write a
      // background-job manifest bound to this exact session. Without this the
      // detached work is invisible and the Sidebar dot goes green the moment the
      // turn ends. See lib/backgroundJobs.ts + BackgroundJobRunner.
      const envWithSession: Record<string, string> = { ...(opts.env ?? {}) };
      if (ch.sessionId) envWithSession.UGS_SESSION_ID = ch.sessionId;
      if (ch.workspaceId) envWithSession.UGS_WORKSPACE_ID = ch.workspaceId;
      envWithSession.UGS_TOOL_CATALOG_SCOPE = JSON.stringify({
        workspaceId: ch.workspaceId ?? '', sessionId: ch.sessionId ?? '', agentId: cli.selection.adapter,
        providerId: cli.selection.providerId ?? '', channelId: cli.selection.channelId ?? '', model: cli.selection.modelOverride?.trim() || cli.selection.modelClass?.trim() || '',
      });
      const liveSteerSupported = await aiCliSteerSupported(
        cli.adapter,
        opts.cliCommand,
        opts.permission,
      ).catch(() => false);
      // Always record the steer surface for the running turn. Only `native`
      // adapters (codex/claude/zcode — the ones with a real in-turn channel,
      // per the Rust `ai_cli_steer_channel`) surface the ⚡ 插话 action; for the
      // rest it stays hidden and the queued message simply keeps its place in
      // the FIFO — see trySteerQueuedCliTurn.
      ch.liveSteer = {
        adapter: cli.adapter,
        runId,
        accepting: true,
        native: liveSteerSupported,
      };
      syncQueuedChatMessageIds();
      autoSteerChatRevisions(ch.sessionKey ?? ch.key);
      // Capture the backend's real token usage (claude/codex emit cache hits
      // via the `ai-cli-usage` event). When present we record it as authoritative
      // so the status bar shows the true cache percentage instead of `--`.
      let realUsage: ModelUsageReport | null = null;
      try {
        const text = await aiEditViaCli(prompt, cli.adapter, {
          ...opts,
          env: envWithSession,
          timeoutSeconds: policy.timeoutSeconds,
          idleTimeoutSeconds: policy.idleTimeoutSeconds,
          runId,
          onTool: (event) => {
            skillLearningTurn?.onTool(event);
            captureReferenceSources(event);
          },
          skillTools: nativeSkillTools,
          signal: ch.abortController.signal,
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
        rememberExplicitUsage(realUsage ?? estimateUsageForText(prompt, text), {
          estimated: !realUsage,
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
      } finally {
        if (ch.liveSteer?.runId === runId) {
          ch.liveSteer.accepting = false;
          syncQueuedChatMessageIds();
        }
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
      let realUsage: ModelUsageReport | null = null;
      ch.cliRunIds.add(runId);
      try {
        const text = await completeGatewayText({
          route: directRoute,
          system: request.system,
          userContent: request.userContent,
          maxTokens: 8192,
          signal: ch.abortController.signal,
          runId,
          onToolEvent: (event) => {
            skillLearningTurn?.onTool(event);
            captureReferenceSources(event);
          },
          skillTools: nativeSkillTools,
          usageContext: { workspaceId: ch.workspaceId, sessionId: ch.sessionId },
          permission: state.composer.permission || 'full',
          cwd: ch.workspaceRootPath ?? undefined,
          forceCli: preferCliForProjectMcp,
          onDelta: (chunk) => {
            firstProgressAt ??= Date.now();
            request.onDelta?.(chunk);
          },
          onUsage: (report) => {
            realUsage = mergeUsageReports(realUsage, report);
          },
        });
        rememberExplicitUsage(
          realUsage ??
            estimateGatewayUsage(request.system, request.userContent, text),
          { estimated: !realUsage },
        );
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
    const settingsProfile = settingsProfileForState(state);
    const imageSettings = loadImageGenerationSettings(settingsProfile);
    const gameAssetChannels = {
      image: preferredReadyImageProviderId(imageSettings) != null,
      music:
        preferredReadyMusicProviderId(loadMusicGenerationSettings(settingsProfile)) !=
        null,
      threeD:
        preferredReadyThreeDProviderId(loadThreeDGenerationSettings(settingsProfile)) !=
        null,
      video:
        preferredReadyVideoProviderId(loadVideoGenerationSettings(settingsProfile)) !=
        null,
      animation:
        preferredReadyAnimationProviderId(
          loadAnimationGenerationSettings(settingsProfile),
        ) != null,
      speech:
        preferredReadySpeechProviderId(loadSpeechGenerationSettings(settingsProfile)) !=
        null,
      sprite: preferredReadySpriteProviderId(imageSettings) != null,
      ui: (() => {
        const settings = loadUiDesignChannelSettings(settingsProfile);
        return uiDesignChannelReady(settings.preferredChannelId, settings);
      })(),
    };
    // Capability awareness for EVERY path (blueprint + simple chat): tell the
    // model which built-in generation channels are configured + ready so it
    // routes asset needs to /image, /music, /mesh-mode-start, etc. instead of
    // fabricating images with PIL / audio with ffmpeg / meshes with code.
    const assetCapabilityBlock = buildAssetCapabilityBlock({
      image: gameAssetChannels.image,
      music: gameAssetChannels.music,
      threeD: gameAssetChannels.threeD,
      video: gameAssetChannels.video,
      animation: gameAssetChannels.animation,
      speech: gameAssetChannels.speech,
      sprite: gameAssetChannels.sprite,
    });
    // Explicit-only routing (方案 A 之上的收紧)：游戏专家 / 制作人视角不再从
    // 聊天文本自动触发，只有用户通过 /game（或分层路径）显式调用时才注入。
    // - 指定了具体专家(分层路径命中) → 直接用专家融合，固定为这些专家。
    // - 仅 /game 整体调用 → 完整/多阶段需求走制作人视角计划，其余走专家融合。
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
      assetCapabilityBlock +
      projectEngineGuidance +
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
      if (workspaceRootPath && selectedRemoteWorkspaceConfig) {
        startRemoteChatTurn({
          ch,
          prompt: trimmed,
          sourceMessageId: userMsg.id,
          ready: sourceMessageReady,
          explicitSkillIds: selectedSkillIds,
          onSkillContext: (context) => persistSkillContextForSource(ch, userMsg.id, context),
          onSkillReviewState: (reviewState) => {
            void persistSkillLearningStateForSource(ch, reviewState).catch((error) =>
              console.warn('[skills] 远程来源学习结果回存失败', error));
          },
          workspacePath: workspaceRootPath,
          locale: state.locale,
          projectEngineGuidance,
          personalBlock,
          gameExpertBlock,
          knowledgeBaseMode: state.composer.knowledgeBaseMode,
          aiEditCommitMessages,
          commitAiChannelBlueprint,
          appendStartUserInputs,
          syncAndPersistSessionRunStatus,
          formatClock,
          formatDuration,
          removeAiEditChannel,
        });
        return true;
      }

      // Serialize turns for this chat session. Normal follow-ups always remain
      // in FIFO. The explicit lightning action may steer a queued follow-up
      // into an active CLI turn when that adapter exposes real steering.
      // Favorite reruns mint a fresh session per turn, so they need no queue.
      const runChatTurn = async () => {
        // Capture at FIFO execution time, not send time: queued turns must not
        // inherit writes from the preceding turn. Native tool metadata wins.
        const turnChangesKey = `turn:${ch.workspaceId ?? ''}:${ch.sessionId ?? ''}:${userMsg.id}`;
        let turnBaselineReady = false;
        let turnToolTrace = '';
        const ensureTurnBaseline = async (adapter: string) => {
          if (turnBaselineReady || supportsNativeFileChanges(adapter) || !workspaceRootPath ||
            isRemoteWorkspacePath(workspaceRootPath)) return;
          try {
            await ensureWorkspaceChangesBaseline(workspaceRootPath, turnChangesKey);
            turnBaselineReady = true;
          } catch (error) {
            console.warn('[session-files] 本轮文件基线读取失败', error);
          }
        };
        const turnText =
          ch.messages.find((message) => message.id === userMsg.id)?.text.trim() ??
          userMsg.text.trim();
        if (!turnText) return;
        const skillConfig = loadSkillLearningConfig(ch.workspaceId ?? '__default__');
        const simpleAssetCapabilityBlock = shouldUseAssetCapabilityBlockForPrompt(turnText)
          ? assetCapabilityBlock
          : '';
        // Frozen memory snapshot: read ONCE at the start of a session and cached
        // by session id (renderFrozenMemorySnapshot). Mid-session writes only
        // touch disk; the live system prompt stays byte-identical across turns so
        // the native-CLI prefix cache stays warm. See lib/memoryStore.ts CONTRACT.
        const workspaceMemoryId = ch.workspaceId || undefined;
        const memoryConfig = loadMemoryConfig();
        const snapshotFreezeKey = ch.sessionId ?? workspaceMemoryId ?? 'global';
        const memorySnapshot = memoryConfig.snapshotEnabled
          ? await renderFrozenMemorySnapshot(
              workspaceMemoryId,
              snapshotFreezeKey,
            ).catch(() => '')
          : '';
        // argv-capped adapters (dsh / zcode) can't afford the full snapshot, but
        // dropping memory entirely made them "write-only". Inject a hard-bounded
        // compact snapshot instead so memory still reaches those models.
        const memorySnapshotCompact = memoryConfig.snapshotEnabled
          ? await renderMemorySnapshotCompact(
              workspaceMemoryId,
              memoryConfig.compactSnapshotCharLimit,
              snapshotFreezeKey,
            ).catch(() => '')
          : '';
        const knowledgeContext = state.composer.knowledgeBaseMode
          ? await renderKnowledgeBaseContextForPrompt({
              workspaceId: ch.workspaceId,
              workspacePath: workspaceRootPath,
              query: turnText,
            }).catch(() => '')
          : '';
        // Only teach the ugs-job wrapper when this turn runs through a local CLI
        // (the model can spawn processes there) AND the wrapper is actually
        // resolvable. Substitutes the real script path into the guidance.
        const jobWrapperPath = useCli ? await resolveUgsJobWrapperPath() : '';
        const backgroundJobBlock = jobWrapperPath
          ? BACKGROUND_JOB_INSTRUCTION.replace('<UGS_JOB_PATH>', jobWrapperPath)
          : '';
        // Which asset channels this turn may auto-generate. Only the sticky
        // modes the user actually entered are authorized (敲 /image、/video 等);
        // the UGS_GEN protocol is advertised only for those and ignored
        // otherwise, so a stray sentinel in ordinary chat can never spend quota.
        // Authorize a channel two ways: (1) the sticky mode the user entered
        // (敲 /image-mode-start), or (2) an explicit one-shot command the user
        // typed in THIS turn's message (e.g. "配图，用 /image ..."). Both are the
        // user asking for that asset, so both let the model DRIVE generation via
        // the UGS_GEN protocol instead of only recommending a command to click.
        const genKinds = mergeGenKinds(
          authorizedGenKinds(state.composer),
          detectRequestedGenKinds(turnText),
        );
        const genInstructionBlock = genKinds.length ? genInstruction(genKinds) : '';
        const chatSystem = [
          SIMPLE_CHAT_SYSTEM,
          languageAdaptationPrompt(state.locale),
          personalBlock,
          memorySnapshot,
          memoryConfig.writeEnabled ? MEMORY_WRITE_INSTRUCTION : '',
          // Recall needs a workspace to scope the history search; only offer it
          // when this session belongs to one and recall is enabled.
          ch.workspaceId && memoryConfig.recallEnabled ? RECALL_INSTRUCTION : '',
          gameExpertBlock,
          simpleAssetCapabilityBlock,
          genInstructionBlock,
          projectEngineGuidance,
          knowledgeContext,
          useCli ? projectMcpGuidance : '',
          backgroundJobBlock,
          // 简单直聊同样会产出临时脚本/文档/HTML 等副产物，必须与 workflow
          // agent 节点（gateway.ts）一样注入目录约定，否则模型全写进项目根目录。
          WORKSPACE_LAYOUT_DIRECTIVE,
        ].join('');
        // DeepSeek Harness (dsh) reads its task ONLY from an argv positional
        // argument (no stdin), and on Windows it launches via `cmd /C dsh.cmd`,
        // whose command line is hard-capped at ~8191 chars. The full chatSystem
        // (system prompt + personal defaults + memory snapshot + game-expert +
        // MCP + knowledge blocks) easily exceeds that, which truncates the
        // TAIL of the argv — i.e. the user's actual request — leaving dsh with
        // only the lead-in and making it reply with a generic "我已就绪" greeting.
        // dsh carries its own harness system prompt, so it needs only a compact
        // UGS system prefix; drop the heavy, dsh-redundant blocks to keep the
        // real task inside the argv budget. See lib.rs `is_dsh` branch.
        const dshChatSystem = [
          SIMPLE_CHAT_SYSTEM,
          languageAdaptationPrompt(state.locale),
          personalBlock,
          memorySnapshotCompact,
          memoryConfig.writeEnabled ? MEMORY_WRITE_INSTRUCTION : '',
          ch.workspaceId && memoryConfig.recallEnabled ? RECALL_INSTRUCTION : '',
          // dsh 也必须知道「应用内置生成渠道已就绪」以及「素材自动生成协议」，
          // 否则模型只会推荐 /image 让用户自己点，永远不会自动发生成块。
          // 这两个块都很短（各数百字符），不会像 memory / game-expert /
          // knowledge 那些大块那样撑爆 Windows argv 上限；且 genInstructionBlock
          // 仅在用户本轮明确敲了 /image 等素材命令（或已进入素材模式）时才非空，
          // 正好只在需要自动生成的回合占用 argv 预算。
          simpleAssetCapabilityBlock,
          genInstructionBlock,
        ].join('');
        // ZCode（zcode）与 dsh 一样把整轮任务作为单个 argv 值（`--prompt`）
        // 传给 CLI（无 stdin），命令行长度的风险同样存在（直连 node 后上限
        // 约 32767 字符，仍会被超大 memory / game-expert / knowledge 块挤爆）。
        // GLM 模型自带编码智能体系统提示，所以复用 dsh 的精简 UGS 前缀。
        const zcodeChatSystem = dshChatSystem;
        // Multi-turn context: the gateway/CLI takes a single string, so fold the
        // prior conversation (text messages only, skipping system notices) into
        // the prompt as a transcript, then the current question. Keeps a bounded
        // tail so very long chats don't blow the context window.
        //
        // Recompute the history at EXECUTION time, not at enqueue time. An
        // interjection ("插话") queued behind an in-flight turn must see that
        // turn's REAL answer once it lands — not the stale "⟳ 生成中…" placeholder
        // that was live when the follow-up was typed (baseMessages is captured
        // synchronously in sendPrompt and its placeholder bubble never mutates in
        // place). Read the live session view (front-most) or fall back to this
        // turn's channel snapshot, cut at this turn's own user message, and drop
        // any still-streaming placeholder bubble so it can't poison the prompt.
        const liveSessionMessages = aiEditViewActive(ch)
          ? useStore.getState().messages
          : ch.messages;
        const selfUserIndex = liveSessionMessages.findIndex(
          (m) => m.id === userMsg.id,
        );
        const historyBeforeThisTurn =
          selfUserIndex >= 0
            ? liveSessionMessages.slice(0, selfUserIndex)
            : liveSessionMessages;
        const interruptedContinuation = isInterruptedChatContinuation(
          historyBeforeThisTurn,
        );
        const priorMessages = chatPromptHistoryMessages(historyBeforeThisTurn);
        // A `document` content block anywhere in the conversation (prior history
        // or this turn's own message) forces the resume-disabling downgrade on
        // third-party gateways. Images don't count. Computed once per turn.
        const sessionHasDocument =
          chatSessionReferencesDocument(priorMessages) ||
          chatSessionReferencesDocument([userMsg]);
        // `max` 默认截断到最近 SIMPLE_CHAT_HISTORY_TURNS 条以控制 token；传
        // Infinity 用于"切回模型时补发离开期间对话"的场景——那段 transcript 是
        // 对端模型能看到该区间的唯一来源，截断会永久丢内容。
        const chatTranscript = (
          messages: Message[],
          max: number = SIMPLE_CHAT_HISTORY_TURNS,
        ): string =>
          messages
            .slice(-max)
            .map((m) => {
              const text = transcriptText(m);
              return text ? `${m.role === 'user' ? '用户' : '助手'}：${text}` : '';
            })
            .filter(Boolean)
            .join('\n\n');
        const prior = chatTranscript(priorMessages);
        const interruptedContinuationDirective = interruptedContinuation
          ? '上一轮任务被用户中断且尚未完成。请保留此前对话中的原始目标、已完成工作和工具结果，把当前用户消息视为对原任务的新约束或补充；除非用户明确取消原任务，否则在新约束下继续完成原任务。不要把当前消息当成孤立的新任务。'
          : '';
        let requestTurnText = turnText;
        let chatPrompt = prior.length
          ? interruptedContinuation
            ? `${interruptedContinuationDirective}\n\n以下是中断前的对话：\n\n${prior}\n\n用户补充：${turnText}`
            : `以下是之前的对话，请结合上下文继续回答最后一个「用户」消息：\n\n${prior}\n\n用户：${turnText}`
          : interruptedContinuation
            ? `${interruptedContinuationDirective}\n\n用户补充：${turnText}`
            : turnText;
        // Respect the permission the user picked in the composer (read-only /
        // ask-each-time / full), matching the other run paths instead of
        // hard-coding 'full'.
        const chatPermission = state.composer.permission || 'full';
        // Tracked across try/catch so a failure before the session ever
        // completed can forget its (already disk-registered) session id —
        // otherwise "继续"/retry reuses it and claude rejects the duplicate.
        let nativeSession: ChatNativeSession | null = null;
        const usageBefore = readUsageMeterSnapshot(usageMeterContext);
        // Elapsed time must advance even when the model/CLI emits no events.
        // Streaming callbacks refresh the bubble opportunistically, but a
        // stalled first token previously left it frozen at "耗时 0s".
        const timingRefresh = globalThis.setInterval(() => {
          if (!activeId || !aiEditActive(ch)) return;
          const current = ch.messages.find((message) => message.id === activeId);
          if (!current?.text.startsWith('⏱ ')) return;
          const bodyStart = current.text.indexOf('\n');
          if (bodyStart < 0) return;
          setActive(withAiTiming(current.text.slice(bodyStart + 1)));
        }, 1_000);
        let skillFinalAnswer = '';
        let skillTerminal: 'completed' | 'cancelled' | 'failed' = 'failed';
        const memoryReviewTurn = ch.workspaceId && ch.sessionId ? beginMemoryReviewTurn({
          source: { hostId: 'local', namespaceId: 'local', workspaceId: ch.workspaceId,
            sessionId: ch.sessionId, turnId: userMsg.id, sourceMessageId: userMsg.id,
            runId: ch.key, ...(workspaceRootPath ? { cwd: workspaceRootPath } : {}) },
          config: memoryConfig, ready: sourceMessageReady, signal: ch.abortController.signal,
          messages: buildMemoryReviewMessages(ch.messages),
        }) : undefined;
        try {
          if (tauriAvailable()) {
            const ready = sourceMessageReady;
            // Automatic context is advisory when history is unavailable; explicit
            // selection remains fail-closed through the host's same barrier.
            void ready.catch(() => {});
            skillExecutionOrigin = Object.freeze({
              hostId: 'local', workspaceId: ch.workspaceId ?? '__default__',
              sessionId: ch.sessionId ?? '', turnId: userMsg.id, runId: userMsg.id,
              ...(workspaceRootPath ? { cwd: workspaceRootPath } : {}),
            });
            skillLearningTurn = beginSkillLearningTurn({
              origin: skillExecutionOrigin,
              prompt: turnText, selection: { ...gatewaySelection },
              config: skillConfig,
              explicitSkillIds: selectedSkillIds,
              signal: ch.abortController.signal,
              ...{ ready },
              onState: (reviewState) => {
                void persistSkillLearningStateForSource(ch, reviewState).catch((error) => {
                  console.warn('[skills] 来源会话学习结果回存失败', error);
                });
              },
            });
          }
          newBubble(withAiTiming('⟳ 生成中…'));
          if (skillLearningTurn) {
            try {
              const context = await skillLearningTurn.loadContext();
              await sourceMessageReady;
              requestTurnText = context.prompt;
              chatPrompt += context.prompt.slice(turnText.length);
              const contextPersisted = persistSkillContextForSource(ch, userMsg.id, {
                origin: skillExecutionOrigin!, loadedSkills: context.loadedSkills,
                catalogRevision: context.catalogRevision,
              });
              await contextPersisted;
              if (skillConfig.enabled && skillConfig.mode !== 'off') {
                nativeSkillTools = { source: { ...skillExecutionOrigin! },
                  config: { enabled: skillConfig.enabled, mode: skillConfig.mode }, ready: contextPersisted };
              }
            } catch (error) {
              if (selectedSkillIds.length || ch.abortController.signal.aborted) throw error;
              console.warn('[skills] 本轮技能上下文不可用', error);
              if (ch.workspaceId && ch.sessionId) pushAssistant(`技能来源不可用：${String(error)}`);
            }
          }
          let routeLine = gatewayRouteLine(directRoute);
          // The model may emit a click-to-choose interaction block instead of a
          // final answer (see core/interaction.ts). Loop: call → if it asked,
          // render the widget, wait for the user's click, feed the answer back,
          // and re-invoke; otherwise finalize. Bounded so a model that keeps
          // asking can't spin forever.
          let continuation = '';
          let finalAnswer = '';
          // Facts settled by earlier rounds of THIS turn (question → answer).
          // Fed back with every continuation so a re-invocation cannot re-decide
          // what the user already answered (see InteractionBaseline).
          const confirmedBaseline: string[] = [];
          // 「会话文件」列表只能从消息文本里的 <<UGS_TOOL>> 哨兵解析出本会话
          // AI 读/改过的文件。CLI 回合最终化时用的是不含哨兵的纯净答复
          // （result/acc），会把流式期间出现过的工具事件抹掉，导致文件先显示
          // 后消失、且下一轮扫不到历史活动。这里把每个回合流式收集到的哨兵
          // 累加起来，最终化时补回消息文本，保证本会话所有 AI 改动文件持续可见。
          let streamedToolSentinels = '';
          let latestCliLive = '';
          for (let round = 0; round < MAX_INTERACTION_ROUNDS; round += 1) {
            let answer = '';
            if (useCli) {
              const cli = await resolveAiCliRoute();
              routeLine = gatewayRouteLine(cli);
              setActive(withAiTiming(routedBody(routeLine, '⟳ 生成中…')));
              nativeSession = replayFavoriteSimpleChat
                ? null
                : chatNativeSessionFor(ch, cli, sessionHasDocument);
              const nativeResume = nativeSession?.started === true;
              // coveredMessageCount 的写入端（回合成功路径）与读取端必须使用同一个
              // 过滤器 chatPromptHistoryMessages：它排除 localOnly 中断通知、⟳ 占位
              // 等消息。旧实现写入端用了宽松过滤（只排除 system/空文本），每积累一条
              // localOnly 消息边界就前移一位；slice(coveredMessageCount) 作用在严格
              // 过滤后的数组上，切走模型再切回时会把"未看过片段"里最早的消息悄悄丢掉。
              const coveredMessageCount = Math.min(
                nativeSession?.coveredMessageCount ?? 0,
                priorMessages.length,
              );
              // 切回模型时只有这段 unseenTranscript 是对端模型能看到"离开期间对话"的
              // 唯一来源（--resume 只重放该模型自己 session 的历史），因此这里不做
              // SIMPLE_CHAT_HISTORY_TURNS 截断，保证切换期间的对话完整送达。
              const unseenTranscript =
                nativeSession && nativeResume
                  ? chatTranscript(
                      priorMessages.slice(coveredMessageCount),
                      Number.POSITIVE_INFINITY,
                    )
                  : '';
              const basePromptBody =
                nativeSession && nativeResume
                  ? unseenTranscript
                    ? interruptedContinuation
                      ? `${interruptedContinuationDirective}\n\n以下是你这个模型会话尚未看到的中间对话：\n\n${unseenTranscript}\n\n用户补充：${requestTurnText}`
                      : `以下是你这个模型会话尚未看到的中间对话，请先吸收上下文，再回答最后一个「用户」消息：\n\n${unseenTranscript}\n\n用户：${requestTurnText}`
                    : interruptedContinuation
                      ? `${interruptedContinuationDirective}\n\n用户补充：${requestTurnText}`
                      : requestTurnText
                  : chatPrompt;
              // On a continuation round, a live native session already carries
              // the prior context via --resume, so send only the user's answer.
              // Without a native session (e.g. third-party gateways where resume
              // is disabled) the model is stateless, so we MUST re-send the full
              // prompt body or the continuation loses all history.
              const promptBody = continuation
                ? nativeSession
                  ? continuation
                  : `${basePromptBody}\n\n${continuation}`
                : basePromptBody;
              let live = '';
              const callNativeCli = async (
                body: string,
                session: ChatNativeSession | null,
                resume: boolean,
              ) => {
                await ensureTurnBaseline(cli.adapter);
                return aiEditViaCliWithSpeed(
                  `${
                    cli.adapter === 'deepseek-harness'
                      ? dshChatSystem
                      : cli.adapter === 'zcode'
                        ? zcodeChatSystem
                        : chatSystem
                  }\n\n${body}`,
                  cli,
                  {
                  permission: chatPermission,
                  model: cli.model,
                  cliCommand: cli.cliCommand,
                  env: cli.env,
                  ...aiEditCliWorkspaceOptions(ch, state.composer),
                  sessionId: session?.sessionId,
                  resume: session ? resume : undefined,
                  languageDirective: languageDirectiveReminder(state.locale),
                  onProgress: (chunk) => {
                    live += chunk;
                    turnToolTrace += chunk;
                    if (!ch.messages.find((message) => message.id === activeId)?.contextCompressed &&
                      live.includes(CONTEXT_COMPRESSION_TOOL) && extractToolSentinels(live).patches.some((patch) =>
                      patch.name === CONTEXT_COMPRESSION_TOOL && patch.status === 'done')) {
                      ch.messages = ch.messages.map((message) => message.id === activeId
                        ? { ...message, contextCompressed: true } : message);
                      updateAiEditSessionSummary(ch);
                    }
                    const displayLive = legacyXmlToolsToSentinels(live, {
                      streamingTail: true,
                    });
                    setActive(
                      withAiTiming(
                        routedBody(
                          routeLine,
                          // Plain chat: the model's own code blocks are real
                          // content, so skip the fence cut entirely.
                          liveProse(displayLive, false) || '⟳ 生成中…',
                        ),
                      ),
                    );
                  },
                });
              };
              try {
                answer = await callNativeCli(promptBody, nativeSession, nativeResume);
              } catch (err) {
                // Recoverable native-session failures share one cure: drop the
                // bad id, mint a fresh one, and re-send the transcript as cold
                // context.
                //   - "No conversation found …" — the resume target vanished
                //     (only meaningful when we were resuming).
                //   - "Session ID … is already in use" — the id is registered AND
                //     locked from a prior turn that never exited cleanly; this can
                //     hit the FIRST turn too (a create collision), so it is not
                //     gated on nativeResume.
                //   - "未产生任何回复就退出（退出码 0）" — the CLI exited cleanly
                //     but produced no content at all (dropped relay, unloadable
                //     resume target after a long conversation, killed mid-turn).
                //     A cold replay gives the turn a real second chance instead
                //     of surfacing a hard failure right after the user answered.
                if (
                  nativeSession &&
                  ((nativeResume && isMissingClaudeConversationError(err)) ||
                    isSessionAlreadyInUseError(err) ||
                    isCliEmptyExitError(err))
                ) {
                  forgetChatNativeSession(nativeSession);
                  nativeSession = chatNativeSessionFor(ch, cli, sessionHasDocument);
                  const fallbackPromptBody = continuation
                    ? `${chatPrompt}\n\n${continuation}`
                    : chatPrompt;
                  live = '';
                  setActive(withAiTiming(routedBody(routeLine, '⟳ 生成中…')));
                  answer = await callNativeCli(fallbackPromptBody, nativeSession, false);
                } else if (!nativeSession && isCliEmptyExitError(err)) {
                  // Stateless call (no native session — e.g. a relay channel or a
                  // favorite replay): there is no session id to drop, so just give
                  // the turn one clean retry. A clean exit 0 with no content is
                  // typically a transient relay/connection drop, and the same
                  // full-context call usually succeeds on the second attempt.
                  live = '';
                  setActive(withAiTiming(routedBody(routeLine, '⟳ 生成中…')));
                  answer = await callNativeCli(promptBody, null, false);
                } else {
                  throw err;
                }
              }
              if (nativeSession) nativeSession.started = true;
              if (!answer.trim() && live.trim()) {
                // The CLI's terminal `result` was empty but the stream
                // captured content. Fall back to `live`, but first strip
                // ephemeral progress markers (⏳ 正在请求模型… / ⚙ 会话已
                // 启动…) the Rust backend injected via ai-cli-progress —
                // otherwise they leak into the finalized bubble and linger
                // beside a parked interaction widget.
                answer = stripCliProgressMarkers(live);
              }
              // Preserve any tool-call sentinels the CLI streamed this round so
              // the session-files list keeps the files this turn read/edited.
              // Also strip the protocol blocks (memory/recall/gen/ask) from this
              // buffer: finalChatBodyWithStreamedTools can resurrect `live` over
              // the stripped `finalProse` when the stream captured more text than
              // the CLI's terminal result, which would re-inject the raw
              // <<UGS_MEMORY>>/<<UGS_RECALL>>/<<UGS_GEN>>/<<UGS_ASK>> JSON into
              // the bubble.
              latestCliLive = stripGenRequests(
                stripRecall(
                  stripMemoryWrites(
                    stripInteraction(
                      legacyXmlToolsToSentinels(live, { streamingTail: true }),
                    ),
                  ),
                ),
              );
              if (hasToolSentinel(latestCliLive)) {
                const { patches } = extractToolSentinels(latestCliLive);
                for (const patch of patches.filter(isPersistentToolPatch)) {
                  streamedToolSentinels += encodeToolPatch(patch);
                }
              }
            } else {
              let full = '';
              setActive(withAiTiming(routedBody(routeLine, '⟳ 生成中…')));
              // The direct API call is stateless, so a continuation round must
              // resend the full context plus the user's answer.
              const userContent = continuation
                ? `${chatPrompt}\n\n${continuation}`
                : chatPrompt;
              // Direct-HTTP path has no Rust-side heartbeat: when the upstream
              // holds thinking for minutes before the first text token (typical
              // for reasoning models behind gateways), the bubble would sit on
              // the static "⟳ 生成中…" placeholder and read as hung. Emit a
              // live "仍在等待模型返回…（已 Xs）" line whenever onDelta goes
              // quiet for >HEARTBEAT_GRACE_MS; cleared the moment real text
              // streams in or the call finishes.
              const HEARTBEAT_GRACE_MS = 5_000;
              const HEARTBEAT_TICK_MS = 1_000;
              let lastDeltaAt = Date.now();
              let heartbeatActive = false;
              const directHeartbeat = globalThis.setInterval(() => {
                if (!activeId || !aiEditActive(ch)) return;
                const silenceMs = Date.now() - lastDeltaAt;
                if (silenceMs < HEARTBEAT_GRACE_MS) return;
                if (full.trim()) {
                  // Real tokens are streaming; onDelta owns the bubble now.
                  if (heartbeatActive) heartbeatActive = false;
                  return;
                }
                heartbeatActive = true;
                setActive(
                  withAiTiming(
                    routedBody(
                      routeLine,
                      `⟳ 生成中…\n\n⏳ 仍在等待模型返回（已 ${formatDuration(silenceMs)}）`,
                    ),
                  ),
                );
              }, HEARTBEAT_TICK_MS);
              try {
                const returned = await completeDirectWithSpeed({
                  system: chatSystem,
                  userContent,
                  onDelta: (chunk) => {
                    lastDeltaAt = Date.now();
                    heartbeatActive = false;
                    full += chunk;
                    setActive(withAiTiming(routedBody(routeLine, liveProse(full, false) || '⟳ 生成中…')));
                  },
                });
                answer = full || returned;
              } finally {
                globalThis.clearInterval(directHeartbeat);
              }
            }
            // History recall: if the model asked to search past conversations,
            // run the search, strip the block, feed the formatted hits back as
            // a continuation, and loop again (bounded by MAX_INTERACTION_ROUNDS).
            const recallWorkspaceId = ch.workspaceId;
            const recall =
              recallWorkspaceId && memoryConfig.recallEnabled ? parseRecall(answer) : null;
            if (recall && recallWorkspaceId) {
              const preface = stripRecall(answer);
              setActive(
                withAiTiming(routedBody(routeLine, preface || '⟳ 检索历史会话…')),
                true,
              );
              const reader: SessionReader = {
                listSessions: (wid) =>
                  historyStore.listSessions(wid).then((rows) =>
                    rows.map((r) => ({
                      sessionId: r.sessionId ?? r.id,
                      title: r.title,
                      updatedAt:
                        typeof r.updatedAt === 'number'
                          ? r.updatedAt
                          : Date.parse(String(r.updatedAt)) || 0,
                    })),
                  ),
                getSession: (wid, sid) =>
                  historyStore
                    .getSession(wid, sid)
                    .then((rec) => (rec ? { messages: rec.messages } : null)),
              };
              const hits: SessionSearchHit[] = await searchSessionsIndexed(
                reader,
                recallWorkspaceId,
                recall.query,
                { limit: Math.min(recall.limit ?? 5, 8), excludeSessionId: ch.sessionId ?? undefined },
              ).catch(() => []);
              // Workspace-first with a global fallback: a query about a global
              // fact (user preferences, cross-project tooling) finds nothing in
              // one project's history — search all workspaces before giving up.
              let effectiveHits: SessionSearchHit[] = hits;
              if (!effectiveHits.length) {
                const allWs = await historyStore.listWorkspaces().catch(() => []);
                for (const ws of allWs) {
                  if (ws.id === recallWorkspaceId) continue;
                  const wsHits = await searchSessionsIndexed(
                    reader,
                    ws.id,
                    recall.query,
                    { limit: 4, excludeSessionId: ch.sessionId ?? undefined },
                  ).catch(() => []);
                  effectiveHits = effectiveHits.concat(wsHits);
                  if (effectiveHits.length >= 8) break;
                }
                effectiveHits = effectiveHits.slice(0, 8);
              }
              newBubble(withAiTiming('⟳ 生成中…'));
              continuation = `历史会话检索结果（query: ${recall.query}）：\n${formatRecallHits(effectiveHits)}\n\n请基于以上检索结果继续回答用户。`;
              continue;
            }
            // Model-driven asset generation (UGS_GEN protocol). Only honored when
            // the user is in a matching asset mode — entering the mode is the
            // authorization to spend that channel's quota automatically. Run each
            // request through the same generation actions the input box uses,
            // then feed a compact result summary back so the model can continue
            // (e.g. fill saved paths into a doc, or retry a failed one).
            if (genKinds.length) {
              const genRequests = parseGenRequests(answer).filter((r) =>
                genKinds.includes(r.kind),
              );
              if (genRequests.length) {
                const capped = genRequests.slice(0, MAX_GEN_REQUESTS_PER_TURN);
                const preface = stripGenRequests(answer);
                setActive(
                  withAiTiming(
                    routedBody(
                      routeLine,
                      preface || `⟳ 正在生成 ${capped.length} 个素材…`,
                    ),
                  ),
                  true,
                );
                persistAiMessages();
                const actions = useStore.getState();
                const summaries: string[] = [];
                // Run each block serially and mirror progress into the active
                // chat bubble as it goes. Without per-block feedback a batch of
                // (say) 5 images looks frozen — the bubble stays on "正在生成…"
                // for minutes — which reads as "the session stopped".
                const progressPreface = preface ? `${preface}\n` : '';
                for (let gi = 0; gi < capped.length; gi += 1) {
                  const kindLabel = genKindLabel(capped[gi].kind);
                  setActive(
                    withAiTiming(
                      routedBody(
                        routeLine,
                        `${progressPreface}⟳ 正在生成素材 ${gi + 1}/${capped.length}（${kindLabel}）…`,
                      ),
                    ),
                    true,
                  );
                  const result = await runGenRequest(actions, capped[gi], {
                    workspaceId: ch.workspaceId,
                    sessionId: ch.sessionId,
                  }, ch.messages);
                  summaries.push(formatGenResult(gi, capped[gi], result));
                  const progress = result.ok ? '✓ 已完成' : '✗ 失败';
                  const remaining =
                    capped.length > 1
                      ? `，继续生成剩余 ${capped.length - gi - 1} 个…`
                      : '';
                  setActive(
                    withAiTiming(
                      routedBody(
                        routeLine,
                        `${progressPreface}${progress} ${gi + 1}/${capped.length}（${kindLabel}）${remaining}`,
                      ),
                    ),
                    true,
                  );
                }
                if (genRequests.length > capped.length) {
                  summaries.push(
                    `（本轮生成请求超过上限 ${MAX_GEN_REQUESTS_PER_TURN} 个，其余已忽略；如需继续请再发起。）`,
                  );
                }
                newBubble(withAiTiming('⟳ 生成中…'));
                continuation =
                  `素材生成结果（已由系统实际执行）：\n${summaries.join('\n')}\n\n` +
                  '请基于以上结果继续：把成功素材的路径写入需要的地方；对失败项可调整提示词后重试，或说明原因。';
                continue;
              }
            }
            let req = parseInteraction(answer);
            if (!req) {
              // Protocol fallback: the model asked a question as plain text
              // instead of emitting `<<UGS_ASK>>`. Synthesize a widget from the
              // question-shaped tail so the user still gets clickable options
              // (or at minimum an input box) instead of a bubble that ends in
              // "?" while the turn stays parked on `awaitInteraction`.
              // `allowInput: true` on the synthesized select gives the user an
              // escape hatch if the heuristic misfires. Always on by design: no
              // settings switch, so every harness gets the same behaviour.
              req = detectFallbackInteraction(stripCliProgressMarkers(answer));
            }
            if (!req) {
              finalAnswer = answer;
              break;
            }
            // The model is asking the user to choose. Show whatever prose came
            // before the block, render the clickable widget, and wait.
            setActive(
              withAiTiming(
                routedBody(
                  routeLine,
                  stripCliProgressMarkers(stripInteraction(answer)) ||
                    '（请选择）',
                ),
              ),
              true,
            );
            persistAiMessages();
            const userAnswer = await awaitInteraction(null, req, ch);
            if (!userAnswer) {
              // Skipped: finalize with whatever prose we already have.
              finalAnswer = stripInteraction(answer);
              break;
            }
            // Continue in a fresh bubble with the user's choice fed back.
            // The appendix pins two things the next round must not re-decide:
            // the model's own conclusion from this round (otherwise it re-reads
            // the source material and re-labels the task) and every Q/A settled
            // earlier in this turn. It also forbids re-emitting a deliverable
            // this turn already produced.
            newBubble(withAiTiming('⟳ 生成中…'));
            continuation =
              `${formatAnswerForPrompt(req, userAnswer, {
                roundConclusion: extractLeadConclusion(
                  stripInteraction(answer),
                ),
                confirmations: confirmedBaseline,
              })}\n\n${SIMPLE_CHAT_INCREMENT_RULE}`;
            const confirmed = summarizeAnswer(req, userAnswer);
            if (isPinnableAnswer(req, userAnswer)) {
              confirmedBaseline.push(`${req.prompt} → ${confirmed}`);
            }
          }
          const turnMessageId = activeId;
          // Defensive: if a recall block survived into the final answer (e.g.
          // the round budget ran out before it was processed), strip it so the
          // protocol JSON never reaches the user.
          finalAnswer = stripRecall(finalAnswer);
          // Same for any UGS_GEN block: strip it unconditionally so raw protocol
          // JSON never shows, even when generation wasn't authorized this turn
          // (no matching mode) or the round budget ran out before executing it.
          finalAnswer = stripGenRequests(finalAnswer);
          // Long-term memory: strip every <<UGS_MEMORY>> block from the visible
          // prose UNCONDITIONALLY. Hiding protocol JSON must never depend on the
          // write switch — otherwise disabling "写入记忆" leaks the raw block
          // into the chat bubble (stripRecall / stripGenRequests above always run
          // for exactly this reason). Only the disk write is gated on
          // writeEnabled. The write lands on the NEXT session's frozen snapshot —
          // it does not touch this turn's prompt/cache. When eviction is enabled,
          // an overflowing write drops the oldest entries instead of silently
          // failing (the result is fire-and-forget, so the model would otherwise
          // never see the error).
          const memoryWrites = memoryConfig.writeEnabled
            ? parseMemoryWrites(finalAnswer)
            : [];
          finalAnswer = stripMemoryWrites(finalAnswer);
          if (memoryWrites.length) {
            // Fire-and-forget, but not SILENT: rejections (safety scan, char
            // limit) and duplicate skips are logged so a blocked write is
            // diagnosable from the console instead of vanishing.
            void applyMemoryWrites(memoryWrites, workspaceMemoryId, {
              evictOnOverflow: memoryConfig.evictOnOverflow,
              safetyScan: memoryConfig.safetyScanEnabled ? 'reject' : 'off',
            })
              .then((results) => {
                for (const r of results) {
                  if (!r.success) {
                    console.warn('[memory] 写入被拒', r.target, r.error);
                  } else if (r.skipped?.length) {
                    console.info(
                      '[memory] 跳过',
                      r.target,
                      r.skipped.map((s) => s.reason).join('；'),
                    );
                  }
                }
              })
              .catch((err) => {
                console.warn('[memory] 写入失败', err);
              });
          }
          // Memory review scheduling is finalized after the real terminal state.

          // Re-attach the tool sentinels captured while streaming so the answer
          // bubble keeps its tool cards AND the session-files list keeps the
          // files this turn touched (it parses <<UGS_TOOL>> sentinels from the
          // persisted message text). Without this, the clean CLI reply replaces
          // the streamed text and every read/edited file vanishes from the list.
          const finalProse = finalAnswer.trim() || '（模型没有返回内容）';
          // The turn is finalizing now — any tool call whose sentinel never
          // got a matching done/error patch (background command the model
          // didn't wait on, CLI exited mid-stream, round budget exhausted)
          // would otherwise stay a permanent spinner in the persisted
          // message even though this turn is over. Close those out here.
          const finalBody = closeDanglingToolPatches(
            finalChatBodyWithStreamedTools(
              finalProse,
              latestCliLive,
              streamedToolSentinels,
            ),
          );
          setActive(
            withAiTiming(routedBody(routeLine, finalBody)),
            true,
          );
          if (useCli && !replayFavoriteSimpleChat && nativeSession) {
            nativeSession.started = true;
            // 必须与读取端（priorMessages = chatPromptHistoryMessages）使用同一
            // 过滤器。旧的宽松过滤会把 localOnly 中断通知等 claude 从未见过的
            // 消息也计入 coveredMessageCount，边界每多一条就前移一位；切回该
            // 模型时 slice(coveredMessageCount) 会丢掉未看过片段里最早的消息。
            nativeSession.coveredMessageCount = chatPromptHistoryMessages(
              ch.messages,
            ).length;
          }
          // Record the input on the node (keeps the graph a single node).
          commitAiChannelBlueprint(ch, appendStartUserInputs(ch.workflow, [turnText]));
          // The user hit Stop mid-turn but the underlying CLI/gateway promise still
          // resolved (graceful exit flushed remaining text). stopActiveChat already
          // marked the run 'interrupted'; promoting it to 'success' here would fire
          // a bogus "会话已完成" desktop notification. Respect the abort signal and
          // keep the interrupted status.
          if (!ch.abortController.signal.aborted) {
            syncAndPersistSessionRunStatus(
              { workspaceId: ch.workspaceId, sessionId: ch.sessionId },
              'success',
            );
          }
          const userImageCount = sessionTitleImageCount(
            turnText,
            ch.workspaceRootPath ?? undefined,
          );
          scheduleFirstTurnSessionTitleNaming({
            phase: 'summary',
            workspaceId: ch.workspaceId,
            sessionId: ch.sessionId,
            userMessageId: userMsg.id,
            userText: turnText,
            assistantText: finalProse,
            userImageCount,
            fallbackTitle: firstTurnFallbackTitle(
              turnText,
              state.locale,
              userImageCount,
            ),
            locale: state.locale,
            gatewaySelection,
            directRoute,
            cwd: ch.workspaceRootPath ?? undefined,
          });
          stampUsageOnMessage(turnMessageId, usageBefore, explicitUsageDelta());
          skillFinalAnswer = finalProse;
          skillTerminal = ch.abortController.signal.aborted ? 'cancelled' : 'completed';
        } catch (err) {
          const msg = (err as Error)?.message ?? String(err);
          // The CLI failed (e.g. ConnectionRefused) before the model call
          // succeeded. claude already registered the `--session-id` on disk, so
          // drop the unstarted native session to free the id — otherwise the
          // next retry reuses it and dies with "Session ID … is already in use".
          const interrupted = ch.abortController.signal.aborted;
          if (nativeSession && interrupted) {
            // Claude registers its native session before the cancelled process
            // exits. Preserve it for `--resume`; if registration did not finish,
            // the existing missing-session fallback will replay cold context.
            nativeSession.started = true;
            nativeSession.coveredMessageCount = chatPromptHistoryMessages(
              ch.messages,
            ).length;
          } else if (nativeSession && !nativeSession.started) {
            forgetChatNativeSession(nativeSession);
          }
          if (!interrupted) {
            if (activeId) setActive(withAiTiming(`✗ 调用失败: ${msg}`), true);
            else pushAssistant(withAiTiming(`✗ 调用失败: ${msg}`));
            persistAiMessages();
            if (aiEditActive(ch)) {
              syncAndPersistSessionRunStatus(
                { workspaceId: ch.workspaceId, sessionId: ch.sessionId },
                'error',
              );
            }
          }
        } finally {
          globalThis.clearInterval(timingRefresh);
          // Model/CLI work is terminal. File-summary reads may still be slow,
          // but cannot keep unrelated memory/skill reviews behind a foreground owner.
          skillLearningTurn?.endForeground?.();
          memoryReviewTurn?.endForeground?.();
          try {
            const ownedMessages = ch.messages.filter((message) =>
              ch.ownedMessageIds?.has(message.id) ?? message.id === activeId);
            const tracedMessages: Message[] = turnToolTrace ? [{
              id: `${userMsg.id}:tools`, role: 'assistant', createdAt: userMsg.createdAt,
              text: legacyXmlToolsToSentinels(turnToolTrace, { streamingTail: true }),
            }, ...ownedMessages] : ownedMessages;
            let changes = collectTurnFileChanges(tracedMessages, null, workspaceRootPath || undefined);
            if (!changes && turnBaselineReady && workspaceRootPath) {
              const snapshot = await listWorkspaceChanges(workspaceRootPath, turnChangesKey);
              changes = collectTurnFileChanges(ownedMessages, snapshot, workspaceRootPath);
            }
            const targetId = activeId ?? ownedMessages.filter((message) => message.role === 'assistant').at(-1)?.id;
            if (changes && targetId) {
              ch.messages = ch.messages.map((message) => message.id === targetId
                ? { ...message, fileChanges: changes } : message);
              aiEditCommitMessages(ch, true);
            }
          } catch (error) {
            console.warn('[session-files] 本轮文件汇总读取失败', error);
          }
          for (const message of ch.messages.filter(message => ch.ownedMessageIds?.has(message.id))) {
            linkMessageManagedAssets(message, { sessionId: ch.sessionId, workspaceId: ch.workspaceId }, workspaceRootPath || undefined);
          }
          removeAiEditChannel(ch);
          // Both foreground owners must close before memory attempts shared admission.
          void skillLearningTurn?.finish({
            finalAnswer: skillFinalAnswer,
            terminal: ch.abortController.signal.aborted ? 'cancelled' : skillTerminal,
          }).catch((error) => console.warn('[skills] 回顾任务失败', error));
          void memoryReviewTurn?.finish(ch.abortController.signal.aborted ? 'cancelled' : skillTerminal,
            buildMemoryReviewMessages(ch.messages)).catch((error) =>
              console.warn('[memory-review] 回顾任务失败', error));
        }
      };
      // Every simple-chat turn enters the per-session FIFO. Normal sends stay
      // queued until the in-flight turn ends; only the explicit lightning
      // action may consume one through Codex App Server `turn/steer`.
      // Favorite reruns mint a fresh session per turn, so they never queue.
      if (!replayFavoriteSimpleChat) {
        void enqueueChatTurn(chSessionKey, ch, runChatTurn);
      } else {
        void runChatTurn();
      }
      return true;
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
        stampUsageOnMessage(activeId, usageBefore, explicitUsageDelta());
        removeAiEditChannel(ch);
      }
    })();
    return true;
  },

  clearBlockedSendTip: () => set({ blockedSendTip: null }),

  // Resolve a node's interaction request with the user's answer. Marks the
  // message answered (so the widget collapses to a summary) and resolves the
  // promise the run loop is awaiting on (see awaitInteraction).
  //
  // ORPHAN CASE: if the run/chat loop that asked the question is no longer
  // around to catch the resolve (it already finished, died, or the app
  // reloaded during a long wait — pendingInteractionResolvers is in-memory
  // only, never persisted), the answer used to just vanish: the widget flipped
  // to "answered" but nothing downstream ever ran. Instead, fold the answer
  // into a brand-new chat turn using the same protocol text a live loop would
  // have fed back, so a slow reply still resumes the task.
  answerInteraction: (messageId, answer) => {
    const mark = (m: Message): Message =>
      m.id === messageId && m.interactionStatus === 'pending'
        ? {
            ...m,
            interactionAnswer: answer,
            interactionStatus: 'answered',
            interactionDraft: undefined,
          }
        : m;
    const resolver = pendingInteractionResolvers.get(messageId);
    const ch = resolver?.runKey ? getRunChannelByKey(resolver.runKey) : null;
    const aiCh = resolver?.aiEditKey
      ? getAiEditChannelByKey(resolver.aiEditKey)
      : null;
    // Captured before mark() flips the status — only used on the orphan path.
    const orphanReq = !resolver
      ? useStore.getState().messages.find((m) => m.id === messageId)?.interaction
      : undefined;
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
      syncWaitingInputSessions();
      dismissWaitingInputNotificationIfSettled(resolver.sessionKey);
      resolver.resolve(answer);
      return;
    }
    if (orphanReq) {
      get().sendPrompt(formatAnswerForPrompt(orphanReq, answer));
    }
  },

  // Skip a pending interaction (the widget's "跳过"): mark it cancelled and
  // resolve the waiting loop with null (no answer).
  dismissInteraction: (messageId) => {
    const mark = (m: Message): Message =>
      m.id === messageId && m.interactionStatus === 'pending'
        ? { ...m, interactionStatus: 'cancelled', interactionDraft: undefined }
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
      syncWaitingInputSessions();
      dismissWaitingInputNotificationIfSettled(resolver.sessionKey);
      resolver.resolve(null);
    }
  },

  // Persist the widget's in-progress draft so a session switch doesn't wipe
  // what the user already typed/selected. Mirrors answerInteraction's routing
  // (run channel / AI-edit channel / plain chat) so the draft lands on the
  // same message copy the widget reads from.
  setInteractionDraft: (messageId, draft) => {
    const normalized =
      draft.values?.length || draft.text
        ? {
            ...(draft.values?.length ? { values: draft.values } : {}),
            ...(draft.text ? { text: draft.text } : {}),
          }
        : undefined;
    const mark = (m: Message): Message =>
      m.id === messageId && m.interactionStatus === 'pending'
        ? { ...m, interactionDraft: normalized }
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

  ensureSessionStartupWorkspace: () => ensureSessionStartupWorkspaceSlice(),

  setComposerDraft: (text) => {
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
    });
    const state = get();
    scheduleComposerDraftPersist(
      state.activeWorkspaceId,
      state.activeSessionId,
      text,
    );
  },

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
    const state = get();
    scheduleComposerDraftPersist(
      state.activeWorkspaceId,
      state.activeSessionId,
      state.composerDraft,
    );
  },

  setWorkspace: (path) => setWorkspaceSlice(path),

  addWorkspaceFolder: (path) => addWorkspaceFolderSlice(path),

  removeWorkspaceFolder: (path) => removeWorkspaceFolderSlice(path),

  removeWorkspace: (path) => removeWorkspaceSlice(path),

  applyWorkspaceFolders: (workspaceId, folders) =>
    applyWorkspaceFoldersSlice(workspaceId, folders),


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

  addPromptItem: (groupId, label, text, locale) =>
    addPromptItem(groupId, label, text, locale),

  updatePromptItem: (groupId, itemId, patch) =>
    updatePromptItem(groupId, itemId, patch),

  updatePromptItemLocalized: (groupId, itemId, patch, locale) =>
    updatePromptItemLocalized(groupId, itemId, patch, locale),

  removePromptItem: (groupId, itemId) => removePromptItem(groupId, itemId),

  addPromptGroup: (label, locale) => addPromptGroup(label, locale),

  updatePromptGroup: (groupId, label) => updatePromptGroup(groupId, label),

  updatePromptGroupLocalized: (groupId, label, locale) =>
    updatePromptGroupLocalized(groupId, label, locale),

  removePromptGroup: (groupId) => removePromptGroup(groupId),

  resetPromptGroups: () => resetPromptGroups(),
}));

setSessionNotificationClickHandler(({ workspaceId, sessionId }) => {
  if (!sessionId) return;
  // The notification fired because something happened after the user last
  // looked at this session (it finished or needs input) — jump straight to
  // the latest content instead of restoring wherever the scrollbar happened
  // to be left, which may be far above the new content.
  requestForceBottomScrollForSession(sessionId);
  useStore.getState().selectSession(sessionId, workspaceId ?? undefined);
});

/* -------------------------------------------------------------------------- */
/* Run execution helpers                                                      */
/* -------------------------------------------------------------------------- */

function formatRunWorkspaceSuffix(config: RunConfig): string {
  const paths = uniqueWorkspaceHistory([
    config.cwd,
    ...(config.extraWorkspacePaths ?? []),
  ]);
  if (paths.length === 0) return '';
  return ` · 工作区 ${paths[0]}${paths.length > 1 ? ` +${paths.length - 1}` : ''}`;
}



const chatNativeSessions = new Map<string, ChatNativeSession>();

function chatRevisionVersions(messages: Message[], position: number): { messages: Message[]; savedAt: number }[] {
  const message = messages[position];
  const versions = [...(message.chatRevisions ?? [])];
  const tail = messages.slice(position).map((item, index) => {
    if (index !== 0) return item;
    const plain = { ...item };
    delete plain.chatRevisions;
    delete plain.chatRevisionIndex;
    return plain;
  });
  versions.splice(message.chatRevisionIndex ?? versions.length, 0, { messages: tail, savedAt: Date.now() });
  return versions;
}

function invalidateChatRevisionSources(state: StoreState, tail: Message[]): void {
  const key = runKey(state.activeWorkspaceId, state.activeSessionId);
  for (const nativeKey of chatNativeSessions.keys()) {
    if (nativeKey.startsWith(`${key}::`)) chatNativeSessions.delete(nativeKey);
  }
  pruneAiEditSourcesForDeletion(state.activeWorkspaceId, state.activeSessionId, new Set(tail.map((message) => message.id)));
}

const CHAT_INTERRUPTED_NOTICE = '⏹ 会话已中断';

function isChatInterruptedNotice(message: Message): boolean {
  const text = message.text.trimStart();
  return (
    message.role === 'assistant' &&
    (text.startsWith(CHAT_INTERRUPTED_NOTICE) ||
      text.startsWith('⚡ 已插话打断当前回复'))
  );
}

function isInterruptedChatContinuation(messages: Message[]): boolean {
  const lastMeaningful = [...messages]
    .reverse()
    .find((message) => message.role !== 'system' && message.text.trim());
  return !!lastMeaningful && isChatInterruptedNotice(lastMeaningful);
}

function chatPromptHistoryMessages(messages: Message[]): Message[] {
  return messages.filter(
    (message) =>
      message.role !== 'system' &&
      !message.localOnly &&
      !isChatInterruptedNotice(message) &&
      message.text.trim() &&
      !(
        message.role === 'assistant' &&
        message.text.trimStart().startsWith('⟳')
      ),
  );
}

/**
 * Per-session serialization for simple-chat turns. A normal follow-up is
 * accepted, shown immediately, then runs after the in-flight turn. The explicit
 * lightning action may steer it into an active Codex App Server turn. This also
 * avoids colliding with Claude's live native `--session-id`.
 */
const chatTurnQueues = new Map<string, Promise<void>>();

interface ChatTurnQueueEntry {
  sessionKey: string;
  messageId: string;
  channel: AiEditChannel;
  started: boolean;
  cancelled: boolean;
  steering: boolean;
  /**
   * Queue-steer confirmation (non-native adapters): the user steered this
   * queued message into the active turn, so it drops the "pending" badge and
   * merges into the running stream immediately. The FIFO entry itself stays
   * alive — the message still fires after the current turn drains, via the
   * full-history replay — so nothing is lost.
   */
  confirmed?: boolean;
}

const chatTurnQueueEntries = new Map<string, ChatTurnQueueEntry>();

function queuedChatMessageIds(): string[] {
  return [...chatTurnQueueEntries.values()]
    .filter(
      (entry) =>
        !entry.started && !entry.cancelled && !entry.steering && !entry.confirmed,
    )
    .map((entry) => entry.messageId);
}

function runningSteerEntryForQueued(
  entry: ChatTurnQueueEntry,
): ChatTurnQueueEntry | null {
  return (
    [...chatTurnQueueEntries.values()].find(
      (candidate) =>
        candidate.sessionKey === entry.sessionKey &&
        candidate.started &&
        !candidate.cancelled &&
        candidate.channel.liveSteer !== undefined &&
        candidate.channel.liveSteer.accepting,
    ) ?? null
  );
}

function steerableQueuedChatMessageIds(): string[] {
  return [...chatTurnQueueEntries.values()]
    .filter((entry) => {
      if (
        entry.started ||
        entry.cancelled ||
        entry.steering ||
        entry.confirmed
      ) {
        return false;
      }
      const running = runningSteerEntryForQueued(entry);
      // Only expose the lightning action when the running CLI exposes a real
      // in-turn steer channel (codex/claude/zcode). Non-native adapters fall
      // back to a confirm-only path inside trySteerQueuedCliTurn, which makes
      // the button feel like a no-op — hide it instead. See issue "GPT 插话
      // 点击无效".
      return running?.channel.liveSteer?.native === true;
    })
    .map((entry) => entry.messageId);
}

function syncQueuedChatMessageIds(): void {
  useStore.setState({
    queuedChatMessageIds: queuedChatMessageIds(),
    steerableQueuedChatMessageIds: steerableQueuedChatMessageIds(),
  });
}

function queuedChatTurnEntryForMessage(
  messageId: string,
): ChatTurnQueueEntry | null {
  return (
    [...chatTurnQueueEntries.values()].find(
      (entry) =>
        entry.messageId === messageId && !entry.started && !entry.cancelled,
    ) ?? null
  );
}

/**
 * Inline-edit gates. A queued message open in the editor holds an unresolved
 * promise; its FIFO slot awaits it before starting, so a turn never fires with
 * stale text while the user is still typing. Committing, cancelling, deleting or
 * steering the message resolves the gate and lets the queue drain.
 */
interface QueuedChatEditGate {
  promise: Promise<void>;
  resolve: () => void;
}

const queuedChatEditGates = new Map<string, QueuedChatEditGate>();

function beginQueuedChatEditGate(messageId: string): void {
  if (queuedChatEditGates.has(messageId)) return;
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  queuedChatEditGates.set(messageId, { promise, resolve });
}

function endQueuedChatEditGate(messageId: string): void {
  const gate = queuedChatEditGates.get(messageId);
  if (!gate) return;
  queuedChatEditGates.delete(messageId);
  gate.resolve();
}

function waitForQueuedChatEdit(messageId: string): Promise<void> {
  return queuedChatEditGates.get(messageId)?.promise ?? Promise.resolve();
}

function clearQueuedChatEditFor(messageId: string): void {
  endQueuedChatEditGate(messageId);
  if (useStore.getState().editingQueuedChatMessageId === messageId) {
    useStore.setState({ editingQueuedChatMessageId: null });
  }
}

function persistQueuedChatConversation(ch: AiEditChannel): void {
  const patch: SessionPatch = {
    messages: ch.chat ? mergeAiEditChatMessages(ch) : ch.messages,
  };
  if (ch.workflowSession) patch.workflow = ch.workflow;
  scheduleAiEditPersist(ch, patch, 0);
}

async function trySteerQueuedCliTurn(entry: ChatTurnQueueEntry): Promise<boolean> {
  if (entry.steering) return false;
  const running = runningSteerEntryForQueued(entry);
  if (!running?.channel.liveSteer) return false;
  const text = entry.channel.messages
    .find((message) => message.id === entry.messageId)
    ?.text.trim();
  if (!text) return false;

  // Non-native adapters (gemini, kimi, grok, dsh, …) have no in-turn steer
  // channel. Confirm the message instead: drop its "pending" badge so it reads
  // as sent in the stream (the text already lives in the shared `messages`
  // list — the badge is only an overlay), then let the FIFO fire it right
  // after the current turn drains. The full-history replay carries the
  // context, so the model still sees it in order. Nothing is merged into the
  // running channel, nothing is cancelled, and the queue slot is kept — we
  // only re-label the UI state.
  if (!running.channel.liveSteer.native) {
    entry.confirmed = true;
    clearQueuedChatEditFor(entry.messageId);
    syncQueuedChatMessageIds();
    return true;
  }

  entry.steering = true;
  syncQueuedChatMessageIds();
  try {
    const steered = await steerAiCli(running.channel.liveSteer.runId, text);
    if (!steered || entry.cancelled) return false;
    entry.cancelled = true;
    chatTurnQueueEntries.delete(entry.channel.key);
    clearQueuedChatEditFor(entry.messageId);
    syncQueuedChatMessageIds();

    const userMessage = entry.channel.messages.find(
      (message) => message.id === entry.messageId,
    );
    if (userMessage) {
      // 插话显示在「当前正在流式的那条 assistant 气泡」正上方——
      // 用户视觉上看到的是"我打断了这条回复"。
      // completedAt can be stamped by intermediate persistence; it is not a
      // reliable live-bubble selector. Track the actual current bubble ID.
      const replyId = running.channel.activeAssistantMessageId;
      const interjection: Message = {
        ...userMessage, interjected: true,
        ...(replyId ? { interjectedReplyId: replyId } : {}),
      };
      running.channel.ownedMessageIds?.add(interjection.id);
      const nextMessages = running.channel.messages.filter(
        (message) => message.id !== interjection.id,
      );
      // Index must be found AFTER the filter, otherwise a removal before the
      // target shifts everything by one.
      const streamTargetIdx = nextMessages.findIndex(
        (message) => message.id === replyId,
      );
      if (streamTargetIdx >= 0) {
        nextMessages.splice(streamTargetIdx, 0, interjection);
      } else {
        nextMessages.push(interjection);
      }
      running.channel.messages = nextMessages;
      running.channel.workflow = simpleWorkflowFromMessages(
        running.channel.workflow,
        running.channel.messages,
      );
      // The visible list is the merge base, so it needs the same reposition;
      // merging preserves `base` positions and would otherwise keep the old
      // copy at its original slot on the next commit.
      if (aiEditViewActive(running.channel)) {
        useStore.setState((state) => {
          const filtered = state.messages.filter(
            (message) => message.id !== interjection.id,
          );
          const globalStreamTargetIdx = filtered.findIndex(
            (message) => message.id === replyId,
          );
          if (globalStreamTargetIdx >= 0) {
            filtered.splice(globalStreamTargetIdx, 0, interjection);
          } else {
            filtered.push(interjection);
          }
          return { messages: filtered };
        });
      }
      // Keep the active assistant bubble streaming. The user message was
      // already appended to durable history by sendPrompt; persisting this
      // channel here would stamp the still-running assistant as completed.
      aiEditCommitMessages(running.channel, false);
      entry.channel.messages = running.channel.messages;
      entry.channel.workflow = running.channel.workflow;
    }
    removeAiEditChannel(entry.channel);
    return true;
  } catch {
    // Version skew or a temporarily non-steerable CLI turn: leave the
    // message in FIFO so it runs normally after the active turn completes.
    return false;
  } finally {
    if (!entry.cancelled) {
      entry.steering = false;
      syncQueuedChatMessageIds();
    }
  }
}

function enqueueChatTurn(
  sessionKey: string,
  ch: AiEditChannel,
  run: () => Promise<void>,
): Promise<void> {
  const messageId =
    [...(ch.ownedMessageIds ?? [])].find((id) =>
      ch.messages.some((message) => message.id === id && message.role === 'user'),
    ) ??
    ch.messages.find((message) => message.role === 'user')?.id ??
    ch.key;
  const entry: ChatTurnQueueEntry = {
    sessionKey,
    messageId,
    channel: ch,
    started: false,
    cancelled: false,
    steering: false,
  };
  chatTurnQueueEntries.set(ch.key, entry);
  syncQueuedChatMessageIds();
  autoSteerChatRevisions(sessionKey);
  const prev = chatTurnQueues.get(sessionKey) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    if (entry.cancelled || !aiEditRegistered(ch)) return;
    // Pause the slot while the user is editing this queued message. The gate
    // resolves on commit/cancel/delete/steer, then the turn runs with the final
    // text. Re-check cancellation afterwards: deleting while editing must skip.
    await waitForQueuedChatEdit(entry.messageId);
    if (entry.cancelled || !aiEditRegistered(ch)) return;
    entry.started = true;
    syncQueuedChatMessageIds();
    try {
      await run();
    } finally {
      chatTurnQueueEntries.delete(ch.key);
      syncQueuedChatMessageIds();
    }
  });
  chatTurnQueues.set(sessionKey, next);
  void next.catch(() => {}).finally(() => {
    if (chatTurnQueues.get(sessionKey) === next) {
      chatTurnQueues.delete(sessionKey);
    }
  });
  return next;
}

/** Edited prompts reuse native in-turn steering; other transports keep FIFO. */
function autoSteerChatRevisions(sessionKey: string): void {
  for (const entry of chatTurnQueueEntries.values()) {
    if (entry.sessionKey !== sessionKey || entry.started || entry.cancelled || entry.steering) continue;
    const message = entry.channel.messages.find((item) => item.id === entry.messageId);
    if (message?.replacesMessageId && runningSteerEntryForQueued(entry)?.channel.liveSteer?.native) {
      void trySteerQueuedCliTurn(entry);
    }
  }
}

function clearPendingChatTurns(sessionKey: string): void {
  for (const [key, entry] of chatTurnQueueEntries) {
    if (entry.sessionKey !== sessionKey || entry.started) continue;
    entry.cancelled = true;
    chatTurnQueueEntries.delete(key);
    clearQueuedChatEditFor(entry.messageId);
  }
  syncQueuedChatMessageIds();
}

/**
 * Test-only: drop every queued/in-flight simple-chat turn and the native CLI
 * session map. The chat-turn queue is module-level and keyed by session, so a
 * turn left pending by one test (e.g. a mock that never resolves) would block
 * the next test that reuses the same session key now that ALL simple-chat turns
 * serialize through it. Call from afterEach to keep tests isolated.
 */
export function __resetSimpleChatRuntimeForTests(): void {
  chatTurnQueues.clear();
  chatTurnQueueEntries.clear();
  queuedChatEditGates.clear();
  sessionTitleNamingInFlight.clear();
  sessionIntentAutoTitles.clear();
  sessionTitleNamingEpoch += 1;
  syncQueuedChatMessageIds();
  useStore.setState({ editingQueuedChatMessageId: null });
  chatNativeSessions.clear();
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

/**
 * True when any message in the conversation references a document file
 * (PDF/Office), which claude CLI turns into a `document` content block that
 * third-party Anthropic-compatible upstreams reject. Image refs (jpg/png/…) are
 * `image` blocks and are safe, so a pure image/text session returns false and
 * keeps its `--resume` continuity. See {@link chatNativeSessionFor}.
 */
function chatSessionReferencesDocument(messages: Message[]): boolean {
  for (const message of messages) {
    if (message.localOnly) continue;
    const text = transcriptText(message);
    if (!text) continue;
    for (const part of scanFileRefs(text)) {
      if (typeof part !== 'string' && isDocumentFileRef(part)) return true;
    }
  }
  return false;
}

function chatNativeSessionFor(
  ch: Pick<AiEditChannel, 'sessionKey' | 'sessionId'>,
  route: Awaited<ReturnType<typeof resolveCliGatewayRoute>>,
  sessionHasDocument: boolean,
): ChatNativeSession | null {
  if (!ch.sessionId) return null;
  if (route.transport !== 'cli' || route.adapter !== 'claude-code') return null;
  // 非 Anthropic 原生上游（Kimi 等）不认识 Claude 的 `document` content
  // block（PDF/Office 附件）。claude CLI `--resume` 会从本地 session 存储
  // 重放完整历史，若历史里含 document 块，这些上游直接 400（"Input tag
  // 'document' ... does not match any of the expected tags"）。图片是 `image`
  // block、不受此限。因此仅当会话「确实引用了文档文件」且目标端点又不是
  // Anthropic 原生 API 时才禁用 native session、降级为每轮纯文本全量模式
  // （chatPrompt）；纯图片/纯文本会话继续正常走 --resume 续接。
  if (sessionHasDocument && !routeTargetsAnthropicNativeApi(route)) return null;
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
 * Claude's native session continuity (`--session-id` / `--resume`) is only safe
 * when the CLI targets the real Anthropic API. A resumed turn replays the full
 * message history from the CLI's on-disk session store, which can contain
 * `document` content blocks (PDF/Office attachments from a `@file` mention or a
 * tool call) that third-party Anthropic-compatible upstreams (Kimi, OpenRouter,
 * GLM, ...) reject with HTTP 400. When a custom base URL is injected, require
 * the Anthropic host; no injected base URL means the CLI uses its own default
 * endpoint, which is out of the app's control and kept as-is.
 */
function routeTargetsAnthropicNativeApi(
  route: Awaited<ReturnType<typeof resolveCliGatewayRoute>>,
): boolean {
  const baseUrl = (route.env?.ANTHROPIC_BASE_URL ?? route.baseUrl ?? '').trim();
  if (!baseUrl) return true;
  try {
    return new URL(baseUrl).hostname.toLowerCase() === 'api.anthropic.com';
  } catch {
    return false;
  }
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

function isMissingClaudeConversationError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '');
  return /No conversation found with session ID/i.test(message);
}

/**
 * Claude rejects a launch with "Session ID … is already in use" when the
 * `--session-id` (create) or `--resume` target is already registered AND locked
 * on disk — usually because a prior turn for this chat registered the id but its
 * process never exited cleanly (timeout / cancel / relay outage), so the lock is
 * still held. Recovery: drop the stuck id and mint a fresh one, re-sending the
 * transcript as cold context (mirrors the missing-conversation fallback).
 */
function isSessionAlreadyInUseError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '');
  return /session ID .* is already in use/i.test(message);
}

/**
 * Claude exited with code 0 but produced no model content at all — a silent
 * failure (dropped relay connection, a resume target that cannot be loaded
 * after a long conversation, or the process being killed mid-turn while still
 * reporting a clean exit). Same cure as the missing/in-use session cases: drop
 * the bad id, mint a fresh one, and re-send the transcript as cold context, so
 * a flaky continuation after a long run doesn't just surface a hard error.
 */
function isCliEmptyExitError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '');
  return /CLI "[^"]+" 未产生任何回复就退出[（(]退出码 0[）)]/.test(message);
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

function aiEditActive(ch: AiEditChannel | null): boolean {
  return aiEditRegistered(ch);
}

export function aiEditViewActive(ch: AiEditChannel | null): boolean {
  if (!ch) return false;
  // Background turns (e.g. a UGS_GEN generation driven from inside the chat
  // loop) persist their results but never mirror into the live store — their
  // shadow view must not flash over the driving chat bubble.
  if (ch.background) return false;
  if (!ch.sessionId) return true;
  const s = useStore.getState();
  return s.activeSessionId === ch.sessionId && s.activeWorkspaceId === ch.workspaceId;
}

export function addAiEditChannel(ch: AiEditChannel): void {
  activeAiEdits.set(ch.key, ch);
  rememberAiEditSnapshot(ch);
  syncAiEditingSessions();
}

export function removeAiEditChannel(ch: AiEditChannel | null): void {
  if (!aiEditRegistered(ch)) return;
  const sessionKey = { workspaceId: ch.workspaceId, sessionId: ch.sessionId };
  const rootPath = ch.workspaceRootPath;
  rememberAiEditSnapshot(ch);
  flushAiEditPersist(ch);
  // Leak guard: any still-pending interaction resolver bound to this channel
  // must be cancelled before the channel disappears from the registry.
  // Otherwise the resolver lingers in `pendingInteractionResolvers`, the
  // session stays in `waitingInputSessions`, and the Sidebar keeps showing a
  // yellow "awaiting input" dot for a widget the user can no longer see or
  // answer (channel already gone → no visible message carries the widget).
  resolvePendingAiEditInteractions(ch);
  activeAiEdits.delete(ch.key);
  syncAiEditingSessions();
  if (ch.workspaceId && ch.sessionId && !sessionLiveStatus(sessionKey, useStore.getState()) &&
      sessionForKey(useStore.getState(), sessionKey)?.scheduledTask?.maxHistoryRuns !== undefined) {
    void pruneScheduledTaskHistory(ch.workspaceId, ch.sessionId).catch((error) => console.warn('[scheduled-task] 清理历史失败', error));
  }
  refreshSessionChangesForKey(sessionKey, rootPath);
}

function stopActiveChat(): void {
  cancelMemoryReviews();
  const state = useStore.getState();
  const key = activeWorkflowSessionKey(state);
  const channels = getAiEditChatChannels(key.workspaceId, key.sessionId);
  if (channels.length === 0) return;

  const stoppedAt = Date.now();
  for (const ch of channels) {
    ch.abortController.abort();
    // Drop pending follow-ups, but keep the running promise as queue tail. A
    // continuation sent immediately after Stop must wait for the cancelled CLI
    // process to release its native session lock before `--resume` starts.
    clearPendingChatTurns(ch.sessionKey);
    resolvePendingAiEditInteractions(ch);
    void cancelActiveAiEditRuns(ch);
    // Finalize incomplete tool sentinels in uncompleted assistant messages so
    // that file modifications remain visible in the session-files list after
    // reload. Without this, an unclosed <<UGS_TOOL>> sentinel (streaming was
    // interrupted mid-tool-call) is silently skipped by extractSessionFiles.
    ch.messages = ch.messages.map((m) => {
      if (m.role !== 'assistant') return m;
      if (ch.ownedMessageIds && !ch.ownedMessageIds.has(m.id)) return m;
      if (typeof m.completedAt === 'number' && Number.isFinite(m.completedAt)) return m;
      return { ...m, text: finalizeToolSentinelsForPersistence(m.text) };
    });
  }
  const ch = channels[0];
  const stoppedMsg: Message = {
    id: shortId('m'),
    role: 'assistant',
    text: `${CHAT_INTERRUPTED_NOTICE} · ${formatClock(stoppedAt)}。`,
    createdAt: stoppedAt,
    // UI audit marker only. Never replay it as assistant dialogue: doing so
    // narrows the next model call to the correction and makes it drop the goal.
    localOnly: true,
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

/**
 * Explicit lightning action for a queued simple-chat message. Supported CLI
 * turns receive it through their native steer channel; rejection or unsupported
 * adapters leave the message in FIFO. This action never aborts the active turn.
 */
function steerQueuedChatTurn(messageId: string): boolean {
  const entry = queuedChatTurnEntryForMessage(messageId);
  if (!entry || entry.steering || entry.confirmed) return false;
  const running = runningSteerEntryForQueued(entry);
  if (!running) return false;
  void trySteerQueuedCliTurn(entry);
  return true;
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
 * skips `.ugs.json` file autosave for backgrounded runs so a background run
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

const pendingSessionCreations = new Map<string, Promise<void>>();

/** Exact source-message fence shared by chat, remote and review producers. */
export function persistReviewSourceMessage(
  source: Pick<AiEditChannel, 'workspaceId' | 'sessionId'>,
  message: Message,
  replacement?: SessionPatch,
  writeMode: 'append' | 'upsert' = 'append',
): Promise<void> {
  const { workspaceId, sessionId } = source;
  const captured = structuredClone(message);
  if (!workspaceId || !sessionId || captured.role !== 'user' || !captured.id) {
    return Promise.reject(new Error('SKILL_SOURCE_MESSAGE_REQUIRED'));
  }
  const capturedReplacement = replacement === undefined ? undefined : structuredClone(replacement);
  const append = () => capturedReplacement
    ? historyStore.updateSession(workspaceId, sessionId, capturedReplacement).then(() => {})
    : writeMode === 'upsert' ? historyStore.upsertMessage(workspaceId, sessionId, captured, true)
      : historyStore.appendMessage(workspaceId, sessionId, captured);
  // Creation enters history's FIFO before publication; snapshot its Promise so
  // a settled/replaced pending map entry cannot change this turn's outcome.
  const creation = pendingSessionCreations.get(runKey(workspaceId, sessionId));
  const written = creation ? creation.then(append) : append();
  return written.then(() => assertPersistedReviewSourceMessage({ workspaceId, sessionId }, captured));
}

function reviewSourceContent(message: Message): string {
  // Native JSON writers may reorder object keys. Array order and all literal
  // multimodal values still belong to the exact source-content fence.
  return JSON.stringify((message as Message & { content?: unknown }).content ?? null, (_key, value: unknown) =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
      : value);
}

export async function assertPersistedReviewSourceMessage(
  source: Pick<AiEditChannel, 'workspaceId' | 'sessionId'>, message: Message,
): Promise<void> {
  const { workspaceId, sessionId } = source;
  const expected = structuredClone(message);
  if (!workspaceId || !sessionId || !expected.id || expected.role !== 'user' || typeof expected.text !== 'string') {
    throw new Error('SKILL_SOURCE_NOT_PERSISTED');
  }
  const record = await readPersistedSkillSourceSession(workspaceId, sessionId);
  const matches = record?.messages.filter((item) => item.id === expected.id) ?? [];
  if (!record || record.workspaceId !== workspaceId || (record.sessionId ?? record.id) !== sessionId || record.deletedAt ||
    matches.length !== 1 || matches[0].role !== 'user' || matches[0].text !== expected.text ||
    reviewSourceContent(matches[0]) !== reviewSourceContent(expected)) {
    throw new Error('SKILL_SOURCE_MESSAGE_NOT_PERSISTED');
  }
}

async function waitForPersistedSkillSource(
  workspaceId: string | null,
  sessionId: string | null,
): Promise<void> {
  if (!workspaceId || !sessionId) throw new Error('SKILL_SOURCE_NOT_PERSISTED');
  await pendingSessionCreations.get(runKey(workspaceId, sessionId));
  const record = await historyStore.getSession(workspaceId, sessionId);
  if (!record || record.workspaceId !== workspaceId ||
    (record.sessionId ?? record.id) !== sessionId || record.deletedAt) {
    throw new Error('SKILL_SOURCE_NOT_PERSISTED');
  }
}

const skillStateWrites = new Map<string, Promise<void>>();

function skillHistorySource(state: SkillReviewState): { workspaceId: string; sessionId: string } {
  if (state.origin.hostId === 'local' && state.sourceSession === undefined) {
    return { workspaceId: state.origin.workspaceId, sessionId: state.origin.sessionId };
  }
  const source = state.sourceSession;
  if (state.origin.hostId !== REMOTE_SKILL_HOST_ID || !source?.workspaceId ||
    source.sessionId !== state.origin.sessionId || !source.serverUrl || state.origin.cwd !== undefined ||
    [source.workspaceId, source.sessionId].some((id) => id.length > 256 || /[\\/:]/.test(id) || id.indexOf(String.fromCharCode(0)) !== -1 || id === '.' || id === '..')) {
    throw new Error('SKILL_SOURCE_ORIGIN_MISMATCH');
  }
  return { workspaceId: source.workspaceId, sessionId: source.sessionId };
}

function sameSkillSourceSession(left: SkillReviewState['sourceSession'], right: SkillReviewState['sourceSession']): boolean {
  return left === undefined && right === undefined || !!left && !!right &&
    left.workspaceId === right.workspaceId && left.sessionId === right.sessionId && left.serverUrl === right.serverUrl;
}

async function reviewRemoteSkillLearningAction(
  state: SkillReviewState, action: 'approve' | 'reject' | 'rollback', id: string,
): Promise<SkillMutationResult> {
  const source = state.sourceSession!;
  const workspace = await historyStore.getWorkspace(source.workspaceId);
  if (!workspace?.path || !isRemoteWorkspacePath(workspace.path)) throw new Error('REMOTE_SKILL_SOURCE_UNAVAILABLE');
  const remoteId = remoteWorkspaceIdFromPath(workspace.path);
  const config = getRemoteWorkspace(remoteId);
  if (!config?.projectId || !state.mode) throw new Error('REMOTE_SKILL_SOURCE_UNAVAILABLE');
  const client = await RunnerClient.fromWorkspaceAsync(remoteId);
  if (!client || client.serverUrl !== source.serverUrl) throw new Error('REMOTE_SKILL_SERVER_MISMATCH');
  const project = await client.getProject(config.projectId);
  if (project.id !== state.origin.workspaceId) throw new Error('REMOTE_SKILL_PROJECT_MISMATCH');
  const host = createRemoteSkillControlHost({ client, projectId: project.id, origin: state.origin, mode: state.mode });
  try {
    const result = await host[action](id);
    if (!sameSkillOrigin(result.origin, state.origin) || action !== 'rollback' && result.batchId !== id) {
      throw new Error('SKILL_CONTROL_TARGET_MISMATCH');
    }
    const history = await host.history();
    const saved = history.results.find((record) => record.batchId === result.batchId && sameSkillOrigin(record.origin, state.origin));
    if (!saved || saved.status !== result.status || saved.operationsApplied !== result.operationsApplied) {
      throw new Error('SKILL_MUTATION_UNCONFIRMED');
    }
    return result;
  } finally {
    await host.revoke();
  }
}

async function reviewPersistedSkillLearningAction(
  state: SkillReviewState, action: 'approve' | 'reject' | 'rollback', id: string,
): Promise<SkillMutationResult> {
  const snapshot = structuredClone(state);
  const expectedId = action === 'rollback' ? snapshot.result?.rollbackId : snapshot.result?.batchId;
  if (!id || id !== expectedId || !snapshot.result || !sameSkillOrigin(snapshot.origin, snapshot.result.origin)) {
    throw new Error('SKILL_CONTROL_TARGET_MISMATCH');
  }
  const source = skillHistorySource(snapshot);
  await waitForPersistedSkillSource(source.workspaceId, source.sessionId);
  const record = await historyStore.getSession(source.workspaceId, source.sessionId);
  const saved = record?.messages.find((message) => message.skillLearning &&
    sameSkillOrigin(message.skillLearning.origin, snapshot.origin) &&
    message.skillLearning.result?.batchId === snapshot.result!.batchId)?.skillLearning;
  if (!saved || !sameSkillSourceSession(saved.sourceSession, snapshot.sourceSession) || saved.mode !== snapshot.mode || saved.status !== snapshot.status ||
    (action === 'rollback' ? saved.result?.rollbackId : saved.result?.batchId) !== id) {
    throw new Error('SKILL_REVIEW_MESSAGE_REQUIRED');
  }
  const result = saved.origin.hostId === REMOTE_SKILL_HOST_ID
    ? await reviewRemoteSkillLearningAction(structuredClone(saved), action, id)
    : await performSkillReviewAction(structuredClone(saved), action);
  if (!sameSkillOrigin(result.origin, snapshot.origin) || (action !== 'rollback' && result.batchId !== id)) {
    throw new Error('SKILL_RESULT_ORIGIN_MISMATCH');
  }
  return result;
}

/** Compare persisted JSON values, independent of native object-key ordering. */
function skillReviewSnapshot(state: SkillReviewState): string {
  return JSON.stringify(state, (_key, value: unknown) =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
      : value);
}

const skillRetries = new Set<string>();
export async function retryPersistedSkillLearning(state: SkillReviewState): Promise<void> {
  const frozen = structuredClone(state);
  const expected = skillReviewSnapshot(frozen);
  const source = skillHistorySource(frozen);
  if (!frozen.resume || frozen.origin.hostId !== 'local' || !['failed', 'cancelled', 'conflicted'].includes(frozen.status) ||
    !sameSkillOrigin({ ...frozen.resume.job.origin, runId: frozen.origin.runId }, frozen.origin)) {
    throw new Error('SKILL_REVIEW_SOURCE_UNAVAILABLE');
  }
  const runId = frozen.origin.runId;
  if (isSkillReviewLive(runId) || skillRetries.has(runId)) return;
  // Own admission before any await; concurrent callers cannot bill this review twice.
  skillRetries.add(runId);
  let writes = Promise.resolve();
  try {
    await waitForPersistedSkillSource(source.workspaceId, source.sessionId);
    const native = await readPersistedSkillSourceSession(source.workspaceId, source.sessionId);
    // Reacquire the cache after the native await; another writer may replace its record.
    const record = await historyStore.getSession(source.workspaceId, source.sessionId);
    const matches = record?.messages.filter((message) => message.skillLearning && sameSkillOrigin(message.skillLearning.origin, frozen.origin)) ?? [];
    const persisted = native?.messages.filter((message) => message.skillLearning && sameSkillOrigin(message.skillLearning.origin, frozen.origin)) ?? [];
    if (!record || !native || native.workspaceId !== source.workspaceId || (native.sessionId ?? native.id) !== source.sessionId || native.deletedAt ||
      matches.length !== 1 || persisted.length !== 1 || matches[0].id !== persisted[0].id ||
      record.messages.filter((message) => message.id === matches[0].id).length !== 1 ||
      native.messages.filter((message) => message.id === persisted[0].id).length !== 1 ||
      skillReviewSnapshot(matches[0].skillLearning!) !== expected || skillReviewSnapshot(persisted[0].skillLearning!) !== expected) {
      throw new Error('SKILL_REVIEW_MESSAGE_REQUIRED');
    }
    let terminal: SkillReviewState | undefined;
    const result = await resumeSkillLearningReview(frozen, (next) => {
      terminal = structuredClone(next);
      // A failed progress write must not prevent recording the already-running job's terminal result.
      writes = writes.catch(() => {}).then(() => persistSkillLearningStateForSource(source, next));
      void writes.catch(() => {});
    });
    try {
      await writes;
      const after = await readPersistedSkillSourceSession(source.workspaceId, source.sessionId);
      const finalMessages = terminal ? after?.messages.filter((message) => message.id === `skill-learning:${terminal!.origin.runId}`) ?? [] : [];
      if (!after || after.workspaceId !== source.workspaceId || (after.sessionId ?? after.id) !== source.sessionId || after.deletedAt ||
        !terminal || terminal.status !== result.status || !terminal.result ||
        skillReviewSnapshot({ ...terminal, result }) !== skillReviewSnapshot(terminal) || finalMessages.length !== 1 ||
        !finalMessages[0].skillLearning || skillReviewSnapshot(finalMessages[0].skillLearning) !== skillReviewSnapshot(terminal)) {
        throw new Error('SKILL_RETRY_STATE_UNCONFIRMED');
      }
    } catch (error) {
      // History failure must not cancel or redispatch a host-confirmed applied result.
      const recordingError = `SKILL_HISTORY_SAVE_UNCONFIRMED: SKILL_RETRY_STATE_UNCONFIRMED: ${String(error)}`;
      throw Object.assign(new Error([frozen.error, recordingError].filter(Boolean).join('; ')), { result: structuredClone(result), recordingError });
    }
  } finally { skillRetries.delete(runId); }
}

function startExplicitSkillLearning(kind: 'learn' | 'refine', text: string): boolean {
  const current = useStore.getState();
  const { workspaceId, sessionId } = activeWorkflowSessionKey(current);
  const input = text.trim();
  const reject = (message: string) => {
    useStore.setState({ blockedSendTip: { kind: 'slash-command-unavailable', message } });
    return false;
  };
  if (!tauriAvailable() || !current.historyReady || !workspaceId || !sessionId || isWorkflowReadOnly(current)) {
    return reject(current.locale === 'en-US' ? 'Skill review requires an available host and an existing source session.' : '技能复盘需要可用宿主和已有来源会话。');
  }
  if (kind === 'learn' && !input) return reject('/learn requires lesson text.');
  const config = loadSkillLearningConfig(workspaceId);
  if (!config.enabled || config.mode === 'off') return reject(current.locale === 'en-US' ? 'Skill learning is disabled.' : '技能学习已关闭。');
  const previous = [...current.messages].reverse().find((message) => message.role === 'user' &&
    message.skillContext?.origin.hostId === 'local' && message.skillContext.origin.workspaceId === workspaceId &&
    message.skillContext.origin.sessionId === sessionId)?.skillContext;
  if (kind === 'refine' && !previous) return reject(current.locale === 'en-US' ? 'No persisted skill source is available to refine.' : '尚无已保存的技能来源可复盘。');
  if (previous?.origin.cwd && isRemoteWorkspacePath(previous.origin.cwd)) return reject('REMOTE_SKILL_REVIEW_REQUIRED');
  const commandId = shortId('m');
  const origin: SkillOrigin = kind === 'refine' ? { ...previous!.origin } : {
    hostId: 'local', workspaceId, sessionId, turnId: commandId, runId: commandId,
    ...(previous?.origin.cwd ? { cwd: previous.origin.cwd } : {}),
  };
  const command: Message = { id: commandId, role: 'user', text: `/${kind}${input ? ` ${input}` : ''}`,
    createdAt: Date.now(), localOnly: true, ...(kind === 'learn' ? { skillContext: {
      origin: { ...origin }, loadedSkills: [], catalogRevision: '',
    } } : {}) };
  const source = { workspaceId, sessionId };
  const selection = { ...workflowDefaultGatewaySelection(current.workflow, current.composer.model) };
  useStore.setState({ blockedSendTip: null, messages: [...current.messages, command] });
  const ready = (async () => {
    await waitForPersistedSkillSource(workspaceId, sessionId);
    await historyStore.appendMessage(workspaceId, sessionId, command);
    const record = await historyStore.getSession(workspaceId, sessionId);
    if (!record?.messages.some((message) => message.id === commandId && message.text === command.text)) {
      throw new Error('SKILL_SOURCE_MESSAGE_NOT_PERSISTED');
    }
    if (kind === 'refine' && !record.messages.some((message) => message.skillContext && sameSkillOrigin(message.skillContext.origin, origin))) {
      throw new Error('SKILL_SOURCE_ORIGIN_MISMATCH');
    }
  })();
  void ready.then(() => requestExplicitSkillLearning({ origin, kind, text: input, selection, config, ready,
    onState: (state) => { void persistSkillLearningStateForSource(source, state).catch((error) => console.warn('[skills] 显式学习状态回存失败', error)); },
  })).then((result) => persistSkillLearningStateForSource(source, {
    origin: result.origin, mode: config.mode, status: result.status, result, error: result.error,
  })).catch((error) => {
    console.warn('[skills] 显式学习失败', error);
    if (useStore.getState().activeWorkspaceId === workspaceId && useStore.getState().activeSessionId === sessionId) {
      useStore.setState({ blockedSendTip: { kind: 'slash-command-unavailable', message: String(error) } });
    }
  });
  return true;
}

async function persistSkillContextForSource(
  source: Pick<AiEditChannel, 'workspaceId' | 'sessionId' | 'messages'>, messageId: string, context: NonNullable<Message['skillContext']>,
): Promise<void> {
  const metadata = structuredClone(context);
  const { workspaceId, sessionId } = source;
  const locator = metadata.origin.hostId === REMOTE_SKILL_HOST_ID
    ? metadata.sourceSession : { workspaceId: metadata.origin.workspaceId, sessionId: metadata.origin.sessionId };
  if (!workspaceId || !sessionId || locator?.workspaceId !== workspaceId ||
    locator.sessionId !== sessionId || metadata.origin.sessionId !== sessionId || metadata.origin.turnId !== messageId ||
    metadata.origin.hostId === REMOTE_SKILL_HOST_ID && (!metadata.sourceSession?.serverUrl || metadata.origin.cwd !== undefined)) {
    throw new Error('SKILL_SOURCE_ORIGIN_MISMATCH');
  }
  await waitForPersistedSkillSource(workspaceId, sessionId);
  const message = source.messages.find((item) => item.id === messageId);
  if (!message || message.role !== 'user') throw new Error('SKILL_SOURCE_MESSAGE_REQUIRED');
  const updated = { ...message, skillContext: metadata };
  source.messages = source.messages.map((item) => item.id === messageId ? updated : item);
  if ('abortController' in source) aiEditCommitMessages(source as AiEditChannel, true);
  await historyStore.upsertMessage(workspaceId, sessionId, updated, true);
  const saved = (await readPersistedSkillSourceSession(workspaceId, sessionId))?.messages.find((item) => item.id === messageId);
  if (!saved?.skillContext || !sameSkillOrigin(saved.skillContext.origin, metadata.origin) ||
    saved.skillContext.catalogRevision !== metadata.catalogRevision) throw new Error('SKILL_CONTEXT_NOT_PERSISTED');
}

function sameSkillOrigin(left: SkillOrigin, right: SkillOrigin): boolean {
  return (['hostId', 'workspaceId', 'sessionId', 'turnId', 'runId', 'cwd'] as const)
    .every((field) => left[field] === right[field]);
}

/** Background results target the captured history bucket, never the active view. */
export function persistSkillLearningStateForSource(
  source: Pick<AiEditChannel, 'workspaceId' | 'sessionId'>,
  state: SkillReviewState,
  messageId?: string,
): Promise<void> {
  const frozen = structuredClone(state);
  const workspaceId = source.workspaceId;
  const sessionId = source.sessionId;
  const locator = skillHistorySource(frozen);
  if (!workspaceId || !sessionId || locator.workspaceId !== workspaceId ||
    locator.sessionId !== sessionId || (frozen.result && !sameSkillOrigin(frozen.origin, frozen.result.origin))) {
    return Promise.reject(new Error('SKILL_RESULT_ORIGIN_MISMATCH'));
  }
  const key = runKey(workspaceId, sessionId);
  const write = (skillStateWrites.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
    await waitForPersistedSkillSource(workspaceId, sessionId);
    flushAiEditPersistKey(aiEditPersistKey(workspaceId, sessionId));
    const current = await historyStore.getSession(workspaceId, sessionId);
    const existing = messageId === undefined ? undefined : current?.messages.find((item) => item.id === messageId);
    if (messageId !== undefined && (!existing?.skillLearning || !sameSkillOrigin(existing.skillLearning.origin, frozen.origin) ||
      !sameSkillSourceSession(existing.skillLearning.sourceSession, frozen.sourceSession))) {
      throw new Error('SKILL_REVIEW_MESSAGE_REQUIRED');
    }
    if (existing?.skillLearning && existing.skillLearning.mode !== frozen.mode) {
      throw new Error('SKILL_REVIEW_MODE_MISMATCH');
    }
    const message: Message = {
      id: messageId ?? `skill-learning:${frozen.origin.runId}`,
      role: 'assistant', text: '', createdAt: existing?.createdAt ?? Date.now(), localOnly: true,
      skillLearning: frozen,
    };
    await historyStore.upsertMessage(workspaceId, sessionId, message, true);
    // A cached acknowledgement can exist even when the backend wrote no bytes.
    const record = await readPersistedSkillSourceSession(workspaceId, sessionId);
    const matches = record?.messages.filter((item) => item.id === message.id) ?? [];
    const saved = matches[0];
    if (!record || record.workspaceId !== workspaceId || (record.sessionId ?? record.id) !== sessionId || record.deletedAt ||
      matches.length !== 1 || saved.role !== 'assistant' || !saved.skillLearning || skillReviewSnapshot(saved.skillLearning) !== skillReviewSnapshot(frozen)) {
      throw new Error('SKILL_RESULT_NOT_PERSISTED');
    }
    const merge = (messages: Message[]) => messages.some((item) => item.id === saved.id)
      ? messages.map((item) => item.id === saved.id ? saved : item)
      : [...messages, saved];
    for (const channel of getAiEditChannelsForSession(workspaceId, sessionId)) {
      channel.messages = merge(channel.messages);
      rememberAiEditSnapshot(channel);
    }
    for (const snapshot of aiEditSnapshots.values()) {
      if (snapshot.workspaceId === workspaceId && snapshot.sessionId === sessionId) snapshot.messages = merge(snapshot.messages);
    }
    const pending = pendingAiEditPersists.get(aiEditPersistKey(workspaceId, sessionId));
    if (pending?.patch.messages) pending.patch.messages = merge(pending.patch.messages);
    useStore.setState((current) => current.activeWorkspaceId === workspaceId && current.activeSessionId === sessionId
      ? { messages: merge(current.messages) } : current);
  });
  skillStateWrites.set(key, write);
  void write.finally(() => {
    if (skillStateWrites.get(key) === write) skillStateWrites.delete(key);
  }).catch(() => {});
  return write;
}

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
    sessionId: ch.sessionId ?? undefined,
    patch: {
      ...(prev?.patch ?? {}),
      ...(ch.chat ? { mergeMessages: true } : {}),
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

/**
 * Wall-clock freshness of a message: the completion stamp when the turn
 * finished, otherwise its creation stamp. Used to decide which of two copies of
 * the SAME message id (persisted record vs retained channel snapshot) is the
 * newer one — a mid-stream commit stamps an early `completedAt`, the final
 * answer stamps a later one, and a still-streaming reply carries none.
 */
export function messageFreshness(message: Message): number {
  return Math.max(message.editedAt ?? 0, message.completedAt ?? message.createdAt);
}

/**
 * Conflict resolver for {@link mergeMessagesById}: keep whichever copy of the
 * message id is fresher, preferring `base` when both agree (equal stamps mean
 * no information either way, and the persisted record is the authority).
 */
export function newerMessage(base: Message, update: Message): Message {
  return messageFreshness(update) > messageFreshness(base) ? update : base;
}

/**
 * Merge by id, preserving `base` ordering. `resolve` arbitrates when both sides
 * carry the same id; without it the `updates` copy wins (in-place edit).
 */
export function mergeMessagesById(
  base: Message[],
  updates: Message[],
  resolve?: (baseMessage: Message, updateMessage: Message) => Message,
): Message[] {
  if (updates.length === 0) return base;
  const byId = new Map(updates.map((message) => [message.id, message]));
  // Apply in-place updates first, preserving `base` ordering for messages that
  // already exist (e.g. live streaming edits to an assistant bubble).
  const merged = base.map((message) => {
    const update = byId.get(message.id);
    if (!update) return message;
    return resolve ? resolve(message, update) : update;
  });
  const indexOfId = new Map(merged.map((message, index) => [message.id, index]));
  // Insert brand-new messages at the position implied by the `updates` order
  // rather than blindly at the tail. A turn's owned messages are ordered
  // [userPrompt, assistant…]; the user prompt is already present in `base`, so
  // its assistant reply must land right after it — even when a later turn's
  // user message has already been appended to `base` (the "插话" / interjection
  // case). Tail-appending here is what made an in-flight reply jump below the
  // next user message, merging the two prompts visually.
  let anchorIndex = -1;
  for (const message of updates) {
    const existingIndex = indexOfId.get(message.id);
    if (existingIndex !== undefined) {
      anchorIndex = existingIndex;
      continue;
    }
    const insertAt = anchorIndex + 1;
    merged.splice(insertAt, 0, message);
    // Every entry at/after the insertion shifts right by one.
    for (const [id, index] of indexOfId) {
      if (index >= insertAt) indexOfId.set(id, index + 1);
    }
    indexOfId.set(message.id, insertAt);
    anchorIndex = insertAt;
  }
  return merged;
}

/**
 * Merge base for a background (non-viewed) AI-edit channel.
 *
 * Deliberately NON-monotonic sources are banned here. `aiEditSnapshots` is
 * written on EVERY commit (`rememberAiEditSnapshot`) and never invalidated, so
 * a snapshot can be OLDER than the conversation: an interjection commits the
 * still-running reply, freezing that mid-stream text into the snapshot, and the
 * final answer only lands on disk afterwards. Using the snapshot as the base
 * then rolls the channel back — and because the rolled-back buffer is what
 * `persistAiEditMessages` writes out (750 ms debounce), the rollback reaches
 * disk too. That is exactly "switch away, switch back: the final answer is gone
 * and an already-dropped mid-stream copy is back".
 *
 * The channel's own buffer only ever grows forward, so it is the base whenever
 * it has anything; the snapshot is a bootstrap fallback for a channel that has
 * not produced a single message yet.
 */
export function aiEditMergeBaseMessages(
  channelMessages: Message[],
  snapshotMessages: Message[] | undefined,
): Message[] {
  if (channelMessages.length > 0) return channelMessages;
  return snapshotMessages ?? channelMessages;
}

function aiEditBaseMessages(ch: AiEditChannel): Message[] {
  if (aiEditViewActive(ch)) return useStore.getState().messages;
  return aiEditMergeBaseMessages(
    ch.messages,
    getAiEditSnapshot(ch.workspaceId, ch.sessionId)?.messages,
  );
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
  // Same monotonic-source rule as `aiEditBaseMessages`: once the channel has
  // produced anything, its own workflow wins over the retained snapshot, which
  // may predate it.
  if (ch.messages.length > 0) return ch.workflow;
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

export function updateAiEditSessionSummary(ch: AiEditChannel): void {
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
            ...(sessionHasContextCompression(ch.messages) ? { contextCompressed: true } : {}),
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

function completeLatestAiEditAssistantMessage(
  ch: AiEditChannel,
  messages: Message[],
  completedAt: number,
): Message[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'assistant') continue;
    if (ch.ownedMessageIds && !ch.ownedMessageIds.has(message.id)) continue;
    if (
      typeof message.completedAt === 'number' &&
      Number.isFinite(message.completedAt)
    ) {
      return messages;
    }
    const next = [...messages];
    next[index] = { ...message, completedAt };
    return next;
  }
  return messages;
}

export function aiEditCommitMessages(ch: AiEditChannel | null, persist: boolean): void {
  if (!aiEditRegistered(ch)) return;
  let messages = ch.chat ? mergeAiEditChatMessages(ch) : ch.messages;
  if (persist) {
    messages = completeLatestAiEditAssistantMessage(ch, messages, Date.now());
    messages = messages.map((message) => !ch.ownedMessageIds || ch.ownedMessageIds.has(message.id) ? withMessageReferences(message) : message);
    ch.messages = messages;
  }
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
  let messages = ch.chat ? mergeAiEditChatMessages(ch) : ch.messages;
  if (persist) {
    messages = completeLatestAiEditAssistantMessage(ch, messages, Date.now());
    ch.messages = messages;
  }
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

export function commitAiChannelBlueprint(ch: AiEditChannel, ir: IRGraph): boolean {
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
  // Leak guard: any still-pending interaction resolver bound to this channel
  // must be cancelled before the channel disappears from the registry.
  // Otherwise `waitingInputSessions` keeps this session and the Sidebar keeps
  // showing a phantom yellow "awaiting input" dot with no widget to answer.
  resolvePendingInteractions(ch);
  activeRuns.delete(ch.key);
  syncRunningSessions();
  refreshSessionChangesForKey(sessionKey, rootPath);
}

/**
 * Force-teardown every still-active run channel, used as the last-resort
 * safety net. Mirrors {@link stopWorkflowRun}'s per-channel cleanup but
 * applies to ALL active runs (not just the one bound to the active session):
 * flips each to cancelled, persists an `interrupted` snapshot, cancels child
 * CLI runs, and drops the channel from the registry. Idempotent — channels
 * already cancelled are skipped by {@link abortAllPendingRuns}.
 *
 * Call sites:
 *   - `beforeunload` (page close / reload): so a stale run can't lock the
 *     owning session into a phantom "running" state on next load.
 *   - HMR dispose (see module hot path below).
 *   - Anywhere the host suspects a run is wedged (executor promise rejected
 *     without reaching its finally, relay process died, etc.).
 */
function abortAllActiveRuns(reason: string): void {
  abortAllPendingRuns((ch) => {
    const runningNodeIds = Object.entries(ch.runState)
      .filter(([, status]) => status === 'running')
      .map(([nodeId]) => nodeId);
    const interruptedNodeId = runningNodeIds[0] ?? null;
    const stoppedAt = Date.now();
    ch.runState = {
      ...ch.runState,
      ...Object.fromEntries(
        runningNodeIds.map((nodeId) => [nodeId, 'interrupted' as const]),
      ),
    };
    ch.failedNodeId = interruptedNodeId;
    ch.error = interruptedNodeId
      ? {
          code: 'interrupted',
          message: reason,
          nodeId: interruptedNodeId,
          occurredAt: stoppedAt,
        }
      : null;
    resolvePendingInteractions(ch);
    void cancelActiveCliRuns(ch);
    // Finalize incomplete tool sentinels so file modifications survive reload.
    ch.messages = ch.messages.map((m) =>
      m.role === 'assistant' && !m.completedAt
        ? { ...m, text: finalizeToolSentinelsForPersistence(m.text) }
        : m,
    );
    pushRunLog(
      ch,
      `⏹ 运行已中止（${reason}）· ${formatClock(stoppedAt)}`,
      'assistant',
    );
    channelCommit(ch, 'interrupted', true);
    if (runViewActive(ch)) useStore.getState().setMode('design');
    syncRunningSessions();
    refreshSessionChangesForKey(
      { workspaceId: ch.workspaceId, sessionId: ch.sessionId },
      ch.config.cwd,
    );
  });
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    abortAllActiveRuns('页面卸载');
  });
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
    sessionKey: WorkflowSessionKey | null;
    resolve: (answer: InteractionAnswer | null) => void;
  }
>();

/** Sessions parked on a pending interaction (derived from the resolver map). */
function syncWaitingInputSessions(): void {
  const seen = new Set<string>();
  const waitingInputSessions: WorkflowSessionKey[] = [];
  for (const entry of pendingInteractionResolvers.values()) {
    const key = entry.sessionKey;
    if (!key) continue;
    const id = workflowSessionKeyId(key);
    if (seen.has(id)) continue;
    seen.add(id);
    waitingInputSessions.push(key);
  }
  useStore.setState({ waitingInputSessions });
}

function sessionHasPendingInteraction(sessionKey: WorkflowSessionKey | null): boolean {
  if (!sessionKey) return false;
  const targetId = workflowSessionKeyId(sessionKey);
  for (const entry of pendingInteractionResolvers.values()) {
    if (entry.sessionKey && workflowSessionKeyId(entry.sessionKey) === targetId) {
      return true;
    }
  }
  return false;
}

function dismissWaitingInputNotificationIfSettled(
  sessionKey: WorkflowSessionKey | null,
): void {
  if (!sessionKey || sessionHasPendingInteraction(sessionKey)) return;
  void dismissSessionWaitingInputNotification({
    workspaceId: sessionKey.workspaceId ?? null,
    sessionId: sessionKey.sessionId ?? null,
  });
}

function dismissSettledWaitingInputNotifications(
  sessionKeys: Array<WorkflowSessionKey | null>,
): void {
  const seen = new Set<string>();
  for (const sessionKey of sessionKeys) {
    if (!sessionKey) continue;
    const id = workflowSessionKeyId(sessionKey);
    if (seen.has(id)) continue;
    seen.add(id);
    dismissWaitingInputNotificationIfSettled(sessionKey);
  }
}

/** Max times a single node may ask the user before we stop re-invoking it. */
const MAX_INTERACTION_ROUNDS = 6;

/**
 * Appended to every interaction-continuation in simple-chat mode. Without it a
 * follow-up answer re-runs the whole task and the model re-emits the entire
 * deliverable: session 037bb1b8 produced the same 10-question interview set
 * five times over (each round cost 3–10 minutes) because answering "要不要导出
 * docx？" was implemented as "run the task again".
 */
const SIMPLE_CHAT_INCREMENT_RULE =
  '本轮只输出相对上一轮的增量或改动部分。如果上一轮已经给出过完整交付物（整套题、文档、报告等），不要重发全量内容；' +
  '也不要重新读一遍已经读过的资料。只有在你判断上一轮并没有产出可用结果时，才重新给出完整结果。';

/** How many prior chat turns simple-workflow mode folds into the prompt for
 *  multi-turn context (bounded so long chats don't overflow the model). */
const SIMPLE_CHAT_HISTORY_TURNS = 20;

// Bound how many asset-generation blocks a single model turn may drive, so a
// runaway reply can't fan out into unbounded paid generations.
const MAX_GEN_REQUESTS_PER_TURN = 8;

// Long-stop timeout for a single model-driven generation block (UGS_GEN). This
// is deliberately generous — 3D mesh generation can poll for several minutes,
// and video/speech generation can legitimately run for an hour — and exists
// only as a safety net so a wedged generation can never leave the chat turn
// awaiting a never-resolving Promise.
const GENERATION_TURN_TIMEOUT_MINUTES = 60;
const GENERATION_TURN_TIMEOUT_MS = GENERATION_TURN_TIMEOUT_MINUTES * 60 * 1000;

/**
 * The asset kinds the model is authorized to auto-generate this turn, derived
 * from the composer's sticky modes. Entering a mode (敲 /image、/video 等) IS the
 * user's authorization; outside every mode the list is empty and the UGS_GEN
 * protocol is neither advertised nor honored.
 */
function authorizedGenKinds(composer: ComposerSettings): GenKind[] {
  const kinds: GenKind[] = [];
  if (composer.imageMode) kinds.push('image');
  if (composer.musicMode) kinds.push('music');
  if (composer.videoMode) kinds.push('video');
  if (composer.spriteMode) kinds.push('sprite');
  if (composer.speechMode) kinds.push('speech');
  if (composer.threeDMode) kinds.push('threeD');
  if (composer.animationMode) kinds.push('animation');
  return kinds;
}

// Route a parsed UGS_GEN request to the matching generation turn, wrapped in a
// Promise that resolves once the turn settles (success paths / failure error).
// Reuses the exact same start*GenerationTurn actions the input box drives, so
// the model-driven path behaves identically to a manual one.
//
// Robustness: the generation turns settle via `onSettled`, but a handful of
// early-return guards (channel removed / aborted) historically skipped the
// callback, which left the chat loop awaiting a Promise that never resolved —
// the session then looked "stopped". This wrapper therefore (1) settles at most
// once, (2) converts a synchronous throw into a failure result, and (3) carries
// a long-stop timeout so a wedged generation can never park the turn forever.
function runGenRequest(
  actions: {
    generateImagePrompt: (text: string, options?: { onSettled?: OnGenerationSettled; background?: boolean; sessionKey?: WorkflowSessionKey; baseMessages?: Message[] }) => void;
    generateMusicPrompt: (text: string, options?: { onSettled?: OnGenerationSettled; background?: boolean; sessionKey?: WorkflowSessionKey; baseMessages?: Message[] }) => void;
    generateVideoPrompt: (text: string, options?: { onSettled?: OnGenerationSettled; background?: boolean; sessionKey?: WorkflowSessionKey; baseMessages?: Message[] }) => void;
    generateSpritePrompt: (text: string, options?: { onSettled?: OnGenerationSettled; background?: boolean; sessionKey?: WorkflowSessionKey; baseMessages?: Message[] }) => void;
    generateSpeechPrompt: (text: string, options?: { onSettled?: OnGenerationSettled; background?: boolean; sessionKey?: WorkflowSessionKey; baseMessages?: Message[] }) => void;
    generateThreeDPrompt: (text: string, options?: { onSettled?: OnGenerationSettled; background?: boolean; sessionKey?: WorkflowSessionKey; baseMessages?: Message[] }) => void;
    generateAnimationPrompt: (text: string, options?: { onSettled?: OnGenerationSettled; background?: boolean; sessionKey?: WorkflowSessionKey; baseMessages?: Message[] }) => void;
  },
  req: GenRequest,
  sessionKey: WorkflowSessionKey,
  baseMessages: Message[],
): Promise<GenerationTurnResult> {
  return new Promise<GenerationTurnResult>((resolve) => {
    let settled = false;
    const finish = (result: GenerationTurnResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      resolve(result);
    };
    // Long-stop watchdog: some channels (3D mesh polling) legitimately take many
    // minutes, so this is only a safety net against a permanently wedged turn.
    const watchdog = setTimeout(() => {
      finish({
        ok: false,
        error: `生成超时（超过 ${GENERATION_TURN_TIMEOUT_MINUTES} 分钟未完成），已放弃等待。`,
      });
    }, GENERATION_TURN_TIMEOUT_MS);
    const opts: { onSettled: OnGenerationSettled; background: true; sessionKey: WorkflowSessionKey; baseMessages: Message[] } = {
      onSettled: finish,
      background: true,
      sessionKey,
      baseMessages,
    };
    try {
      switch (req.kind) {
        case 'image':
          actions.generateImagePrompt(req.prompt, opts);
          break;
        case 'music':
          actions.generateMusicPrompt(req.prompt, opts);
          break;
        case 'video':
          actions.generateVideoPrompt(req.prompt, opts);
          break;
        case 'sprite':
          actions.generateSpritePrompt(req.prompt, opts);
          break;
        case 'speech':
          actions.generateSpeechPrompt(req.prompt, opts);
          break;
        case 'threeD':
          actions.generateThreeDPrompt(req.prompt, opts);
          break;
        case 'animation':
          actions.generateAnimationPrompt(req.prompt, opts);
          break;
        default:
          finish({ ok: false, error: `未知的素材类型：${String(req.kind)}` });
      }
    } catch (err) {
      finish({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}

// Format one settled generation into the continuation line fed back to the
// model so it knows where the asset landed (or why it failed).
function formatGenResult(index: number, req: GenRequest, result: GenerationTurnResult): string {
  const label = genKindLabel(req.kind);
  if (!result.ok) {
    return `第 ${index + 1} 个（${label}）生成失败：${result.error ?? '未知错误'}`;
  }
  const paths = (result.locations ?? [])
    .map((loc) => loc.localPath ?? loc.remoteUrl ?? loc.title)
    .filter(Boolean);
  if (paths.length === 0) {
    return `第 ${index + 1} 个（${label}）已生成，但未取得可用路径。`;
  }
  return `第 ${index + 1} 个（${label}）已生成：${paths.join('、')}`;
}

type RouteDisplay = Pick<
  ResolvedGatewayRoute,
  'adapter' | 'modelClass' | 'model' | 'providerName' | 'channelName' | 'label'
>;

function compactRoutePart(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function routeAdapterLabel(value: unknown): string {
  if (value === 'claude-code' || value === 'codex' || value === 'gemini') {
    return runtimeAdapterLabel(value as RuntimeAdapterId);
  }
  return compactRoutePart(value);
}

function stripRouteModelSuffix(label: string, model: string): string {
  if (!label || !model) return label;
  const suffix = ` · ${model}`;
  return label.toLowerCase().endsWith(suffix.toLowerCase())
    ? label.slice(0, -suffix.length).trim()
    : label;
}

function visibleRouteName(route: RouteDisplay, model: string): string {
  const provider = compactRoutePart(route.providerName);
  if (provider) return provider;
  const fallback =
    stripRouteModelSuffix(compactRoutePart(route.label), model) ||
    routeAdapterLabel(route.adapter);
  return fallback || compactRoutePart(route.channelName);
}

export function gatewayRouteLine(route: RouteDisplay | null | undefined): string {
  if (!route) return '';
  const model = compactRoutePart(route.model) || compactRoutePart(route.modelClass);
  const routeText = visibleRouteName(route, model);
  if (routeText && model) return `⚙ 路由：${routeText} · 模型：${model}`;
  if (routeText) return `⚙ 路由：${routeText}`;
  return model ? `⚙ 模型：${model}` : '';
}

export function gatewayRouteHeader(route: RouteDisplay | null | undefined): string {
  if (!route) return '';
  const model = compactRoutePart(route.model) || compactRoutePart(route.modelClass);
  const routeText = visibleRouteName(route, model);
  return [routeText, model].filter(Boolean).join(' · ');
}

function routedBody(routeLine: string, body: string): string {
  const text = body.trim() ? body : '⟳ 生成中…';
  return routeLine ? `${routeLine}\n${text}` : text;
}

function finalChatBodyWithStreamedTools(
  finalProse: string,
  latestLive: string,
  fallbackSentinels: string,
): string {
  const finalWithXmlTools = legacyXmlToolsToSentinels(finalProse, {
    streamingTail: true,
  });
  const finalXmlPatches = hasToolSentinel(finalWithXmlTools)
    ? extractToolSentinels(finalWithXmlTools).patches.filter(isPersistentToolPatch)
    : [];
  const finalCleanProse =
    finalXmlPatches.length > 0
      ? extractToolSentinels(finalWithXmlTools).text.trim() || '（模型没有返回内容）'
      : finalProse;
  const allFallbackSentinels =
    fallbackSentinels + finalXmlPatches.map(encodeToolPatch).join('');
  if (!allFallbackSentinels) return finalWithXmlTools;

  const normalizedLatestLive = legacyXmlToolsToSentinels(latestLive, {
    streamingTail: true,
  });
  const ordered = orderedFinalBodyFromLiveTools(finalCleanProse, normalizedLatestLive);
  const base = ordered ?? finalWithXmlTools;

  const orderedKeys = new Set(
    extractToolSentinels(base).patches.map(toolPatchIdentity),
  );
  const missingPatches = extractToolSentinels(allFallbackSentinels).patches.filter(
    (patch) => !orderedKeys.has(toolPatchIdentity(patch)),
  );
  if (missingPatches.length === 0) return base;
  // These sentinels were collected this turn but aren't in `latestLive` (e.g.
  // tool calls from an earlier interaction round whose stream isn't part of the
  // final round). Chronologically they ran BEFORE this round's work and the
  // conclusion the model emits last, so prepend them — appending here would
  // wrongly render those tool cards below the final answer.
  return `${missingPatches.map(encodeToolPatch).join('')}${base}`;
}

function isPersistentToolPatch(patch: ToolEventPatch): boolean {
  return patch.ephemeral !== true;
}

function orderedFinalBodyFromLiveTools(
  finalProse: string,
  latestLive: string,
): string | null {
  if (!hasToolSentinel(latestLive)) return null;
  const split = extractToolSentinels(latestLive);
  const persistentParts = split.parts.filter(
    (part) => 'text' in part || isPersistentToolPatch(part.patch),
  );
  if (!persistentParts.some((part) => 'patch' in part)) return null;
  // Moon Add: dsh 多 turn 会话里 stdout 只给最后一个 turn 的最终答案，而
  // live 缓冲里有完整正文（含中间 turn 的「结论先行」正文）。当 live 正文
  // 严格包含 finalProse 且更长时，以 live 的完整正文+工具顺序为准，避免
  // finalProse 之外的正文被整体丢弃（旧逻辑会回退到只剩 finalProse）。
  const liveText = Array.from(split.text).filter(isNonWhitespace).join('');
  const finalText = Array.from(finalProse).filter(isNonWhitespace).join('');
  if (
    finalText.length > 0 &&
    liveText.includes(finalText) &&
    liveText.length > finalText.length
  ) {
    return stripCliProgressMarkers(
      persistentParts
        .map((part) =>
          'text' in part ? part.text : encodeToolPatch(part.patch),
        )
        .join(''),
    );
  }

  const answerRange = findTextRangeIgnoringWhitespace(split.text, finalProse);
  if (!answerRange) return null;
  const insertions: Array<{ offset: number; text: string }> = [];
  let cleanOffset = 0;

  for (const part of persistentParts) {
    if ('text' in part) {
      cleanOffset += part.text.length;
      continue;
    }
    const offset =
      cleanOffset <= answerRange.start
        ? 0
        : cleanOffset >= answerRange.end
          ? finalProse.length
          : finalOffsetForCleanOffset(
              split.text,
              finalProse,
              answerRange.start,
              cleanOffset,
          );
    insertions.push({ offset, text: encodeToolPatch(part.patch) });
  }

  if (
    finalProse.length > 0 &&
    insertions.some((insertion) => insertion.offset > 0 && insertion.offset < finalProse.length)
  ) {
    return null;
  }

  let out = '';
  let cursor = 0;
  for (const insertion of insertions.sort((a, b) => a.offset - b.offset)) {
    out += finalProse.slice(cursor, insertion.offset);
    out += insertion.text;
    cursor = insertion.offset;
  }
  return out + finalProse.slice(cursor);
}

function findTextRangeIgnoringWhitespace(
  haystack: string,
  needle: string,
): { start: number; end: number } | null {
  const target = Array.from(needle).filter(isNonWhitespace).join('');
  if (!target) return null;

  let best: { start: number; end: number } | null = null;
  let normalized = '';
  let start = -1;
  for (let i = 0; i < haystack.length; i += 1) {
    const ch = haystack[i];
    if (!isNonWhitespace(ch)) continue;
    if (start === -1) start = i;
    normalized += ch;
    while (normalized.length > target.length) {
      start = nextNonWhitespaceIndex(haystack, start + 1);
      normalized = normalized.slice(1);
    }
    if (normalized === target) {
      best = { start, end: i + 1 };
    }
  }
  return best;
}

function finalOffsetForCleanOffset(
  cleanText: string,
  finalProse: string,
  cleanStart: number,
  cleanOffset: number,
): number {
  let nonWhitespaceBefore = 0;
  for (let i = cleanStart; i < cleanOffset && i < cleanText.length; i += 1) {
    if (isNonWhitespace(cleanText[i])) nonWhitespaceBefore += 1;
  }
  if (nonWhitespaceBefore <= 0) return 0;

  let seen = 0;
  for (let i = 0; i < finalProse.length; i += 1) {
    if (!isNonWhitespace(finalProse[i])) continue;
    seen += 1;
    if (seen === nonWhitespaceBefore) return i + 1;
  }
  return finalProse.length;
}

function nextNonWhitespaceIndex(text: string, from: number): number {
  for (let i = from; i < text.length; i += 1) {
    if (isNonWhitespace(text[i])) return i;
  }
  return text.length;
}

function isNonWhitespace(ch: string): boolean {
  return !/\s/u.test(ch);
}

function toolPatchIdentity(patch: unknown): string {
  return JSON.stringify(patch);
}

function transcriptText(message: Message): string {
  let text =
    message.role === 'assistant' && message.text.includes('<<UGS_TOOL>>')
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
    aiCh.ownedMessageIds?.add(id);
    aiCh.messages = [...aiCh.messages, msg];
    aiEditCommitMessages(aiCh, true);
  } else {
    pushChannelMessage(ch, msg, true);
  }
  const owner = aiCh ?? ch;
  const sessionKey: WorkflowSessionKey | null = owner
    ? { workspaceId: owner.workspaceId, sessionId: owner.sessionId }
    : null;
  return new Promise((resolve) => {
    pendingInteractionResolvers.set(id, {
      runKey: ch?.key ?? null,
      aiEditKey: aiCh?.key ?? null,
      sessionKey,
      resolve,
    });
    // The turn is now parked on the user: flip the session to a static
    // "waiting" badge (no spinner) and let the composer accept the answer.
    syncWaitingInputSessions();
    scheduleSessionWaitingInputNotification(sessionKey, req, id);
  });
}

/** Cancel in-flight interactions for one run (run stopped): resolve null, mark them. */
function resolvePendingInteractions(ch: RunChannel | null): void {
  if (!ch) return;
  const settledSessionKeys: Array<WorkflowSessionKey | null> = [];
  for (const [id, entry] of [...pendingInteractionResolvers]) {
    if (entry.runKey !== ch.key) continue;
    pendingInteractionResolvers.delete(id);
    settledSessionKeys.push(entry.sessionKey);
    entry.resolve(null);
  }
  syncWaitingInputSessions();
  dismissSettledWaitingInputNotifications(settledSessionKeys);
  const mark = (m: Message): Message =>
    m.interaction && m.interactionStatus === 'pending'
      ? { ...m, interactionStatus: 'cancelled' }
      : m;
  ch.messages = ch.messages.map(mark);
  channelCommitMessages(ch, true);
}

/**
 * Cancel in-flight interactions parked on an AI-edit/chat channel (chat
 * stopped): resolve null so the awaiting turn unwinds, and mark the widgets
 * cancelled. Mirrors resolvePendingInteractions for the aiEdit side.
 */
function resolvePendingAiEditInteractions(ch: AiEditChannel | null): void {
  if (!ch) return;
  const settledSessionKeys: Array<WorkflowSessionKey | null> = [];
  for (const [id, entry] of [...pendingInteractionResolvers]) {
    if (entry.aiEditKey !== ch.key) continue;
    pendingInteractionResolvers.delete(id);
    settledSessionKeys.push(entry.sessionKey);
    entry.resolve(null);
  }
  syncWaitingInputSessions();
  dismissSettledWaitingInputNotifications(settledSessionKeys);
  const mark = (m: Message): Message =>
    m.interaction && m.interactionStatus === 'pending'
      ? { ...m, interactionStatus: 'cancelled' }
      : m;
  ch.messages = ch.messages.map(mark);
  aiEditCommitMessages(ch, true);
}

/**
 * New user message arrived on a session: cancel every parked interaction for
 * that session so the previous chat turn's `awaitInteraction` resolves null
 * immediately and unwinds through its `finally`, releasing the per-session
 * FIFO (`enqueueChatTurn`) for the new turn. Without this, a user who replies
 * by typing a fresh message instead of clicking the widget would queue behind
 * an await that never resolves — the visible "send it and nothing happens".
 *
 * Only cancels entries whose sessionKey matches; widgets on OTHER sessions are
 * left alone so the user can still answer them after switching back. Pending
 * widgets are marked cancelled on the channel so they stop looking clickable.
 */
function cancelParkedInteractionsForSession(
  sessionKey: WorkflowSessionKey | null,
): void {
  if (!sessionKey) return;
  const targetId = workflowSessionKeyId(sessionKey);
  const settledSessionKeys: Array<WorkflowSessionKey | null> = [];
  const cancelledMessageIds = new Set<string>();
  for (const [id, entry] of [...pendingInteractionResolvers]) {
    if (!entry.sessionKey) continue;
    if (workflowSessionKeyId(entry.sessionKey) !== targetId) continue;
    pendingInteractionResolvers.delete(id);
    settledSessionKeys.push(entry.sessionKey);
    cancelledMessageIds.add(id);
    entry.resolve(null);
  }
  if (cancelledMessageIds.size === 0) return;
  syncWaitingInputSessions();
  dismissSettledWaitingInputNotifications(settledSessionKeys);
  // Mark the parked widgets cancelled in any ai-edit channel that owns them so
  // the user sees "交互已取消" instead of a dead-clickable widget. We scan the
  // session's channels rather than track a single owner because the same
  // session can be rendered by multiple channels across reconnects.
  for (const ch of getAiEditChannelsForSession(sessionKey.workspaceId, sessionKey.sessionId)) {
    if (!ch.messages.some((m) => cancelledMessageIds.has(m.id))) continue;
    ch.messages = ch.messages.map((m) =>
      cancelledMessageIds.has(m.id) && m.interaction && m.interactionStatus === 'pending'
        ? { ...m, interactionStatus: 'cancelled' }
        : m,
    );
    aiEditCommitMessages(ch, true);
  }
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

// [workflow 编排已废弃] 总闸：蓝图编排运行链路已停用（UI 无编排入口，canvas/ 画布
// 早已无人引用）。返回 true 时 startWorkflowRun/stopWorkflowRun 入口直接短路；
// 改回 false 即可整体恢复，执行器代码（executeViaCliInterpreter/executeViaSimulator/
// runtime/dag.ts 等）全部保留。用函数而非常量，避免 TS 把后续代码判成不可达。
function workflowOrchestrationDisabled(): boolean {
  return true;
}

function startWorkflowRun(resume: boolean): void {
  // [workflow 编排已废弃] 见 workflowOrchestrationDisabled 注释。
  if (workflowOrchestrationDisabled()) return;
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
  // 该建议性告警仅在蓝图运行路径触发，纯聊天/studio 不经过此处。
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
  // [workflow 编排已废弃] 与 startWorkflowRun 同批停用，见 workflowOrchestrationDisabled。
  if (workflowOrchestrationDisabled()) return;
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
  cancelGuiSkillRun(ch);
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
  // Finalize incomplete tool sentinels in assistant messages so file
  // modifications remain visible in the session-files list after reload.
  ch.messages = ch.messages.map((m) =>
    m.role === 'assistant' && !m.completedAt
      ? { ...m, text: finalizeToolSentinelsForPersistence(m.text) }
      : m,
  );
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

export function makeCliRunId(): string {
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
    onToolEvent?: RuntimeRunContext['onToolEvent'];
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
      onTool: opts.onToolEvent,
      signal: guiSkillRuns.get(ch)?.signal,
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
    completeText: async ({ selection, model, omitModel, prompt, onDelta, onToolEvent }) => {
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
        signal: guiSkillRuns.get(ch)?.signal,
        onToolEvent,
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
        onToolEvent: opts.onToolEvent,
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

export function freeProxyOptionsForSelection(selection: GatewaySelection): {
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
const guiSkillRuns = new WeakMap<RunChannel, AbortController>();

/** A stopped DAG revokes its foreground learning authority immediately. */
export function cancelGuiSkillRun(ch: RunChannel): void {
  ch.cancelled = true;
  guiSkillRuns.get(ch)?.abort();
}

function buildGuiRunContext(ch: RunChannel, workflow: IRGraph): RuntimeRunContext {
  const state = useStore.getState();
  const { personalInstructions, personalInstructionsByModel } = state;
  const sessionKey = {
    workspaceId: ch.workspaceId,
    sessionId: ch.sessionId,
  };
  return {
    selection: runGlobalGatewaySelection(ch, workflow),
    personalInstructions,
    personalInstructionsByModel,
    globalInstructions:
      projectEngineGuidanceForState(state, sessionKey) +
      projectMcpGuidanceForState(state, sessionKey),
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

/** Default fan-out samples for a consensus node (localStorage ugs_consensus_default_samples). */
function defaultConsensusSamples(): number {
  try {
    if (typeof window !== 'undefined') {
      const raw = window.localStorage.getItem('ugs_consensus_default_samples');
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
 * (`ugs_run_concurrency`, clamped 1–16) or force the old strictly-sequential
 * behaviour with `ugs_sequential=1`. Linear chains stay sequential regardless
 * (a node still waits for its predecessors); the cap only bounds how many
 * *independent* nodes run together.
 */
function runConcurrency(): number {
  try {
    if (typeof window !== 'undefined') {
      if (window.localStorage.getItem('ugs_sequential') === '1') return 1;
      const raw = window.localStorage.getItem('ugs_run_concurrency');
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
 * Tune via localStorage (`ugs_run_max_retries`, clamped 0–10); set 0 to disable
 * auto-retry entirely.
 */
function runMaxRetries(): number {
  try {
    if (typeof window !== 'undefined') {
      const raw = window.localStorage.getItem('ugs_run_max_retries');
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
export async function executeViaCliInterpreter(
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
  // Freeze source before proxy/route awaits or UI navigation. Reuse the exact
  // user message, never a run log or a model-generated node summary.
  const sourceMessage = ch.messages.findLast((message) => message.role === 'user');
  const capturedSource = sourceMessage ? structuredClone(sourceMessage) : undefined;
  const sourceReady = capturedSource ? assertPersistedReviewSourceMessage(ch, capturedSource)
    .then(() => persistReviewSourceMessage(ch, capturedSource, undefined, 'upsert')) : undefined;
  void sourceReady?.catch(() => {});
  const controller = new AbortController();
  guiSkillRuns.set(ch, controller);
  let learningTurn: ReturnType<typeof beginSkillLearningTurn> | undefined;
  let terminal: 'completed' | 'cancelled' | 'failed' = 'failed';
  let finalAnswer = '';
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

  try {
    if (capturedSource && ch.workspaceId && ch.sessionId) {
      await sourceReady;
      if (!stillRunning(ch) || controller.signal.aborted) return;
      const origin: SkillOrigin = Object.freeze({ hostId: 'local', workspaceId: ch.workspaceId,
        sessionId: ch.sessionId, turnId: capturedSource.id, runId: makeCliRunId(),
        ...(ch.config.cwd ? { cwd: ch.config.cwd } : {}) });
      learningTurn = beginSkillLearningTurn({ origin, prompt: capturedSource.text,
        selection: context.selection, ready: sourceReady, signal: controller.signal,
        onState: (state) => {
          void persistSkillLearningStateForSource(ch, state).catch((error) =>
            console.warn('[skills] DAG 来源学习结果回存失败', error));
        } });
      context.skillOrigin = origin;
      context.onToolEvent = (event) => learningTurn!.onTool(event);
      const delivered = new Map<string, SkillLearningJob['loadedSkills'][number]>();
      context.skills = { origin, host: learningTurn.host, model: learningTurn.model, signal: controller.signal,
        onLoaded: async (loaded) => {
          for (const skill of loaded.loadedSkills) delivered.set(skill.skillId, structuredClone(skill));
          const aggregate = { loadedSkills: [...delivered.values()].slice(-32), catalogRevision: loaded.catalogRevision };
          learningTurn!.onLoaded(aggregate);
          await persistSkillContextForSource(ch, capturedSource.id, { origin, ...aggregate });
        } };
    }
    const result = await executeWorkflowDag(workflow, callbacks, context, {
      resumeFromNodeId: options.resumeFromNodeId,
      seedOutputs: options.seedOutputs,
      seedRunState: ch.runState,
      seedNodeHashes: options.seedNodeHashes,
    });

    terminal = ch.cancelled || controller.signal.aborted ? 'cancelled' : result.success ? 'completed' : 'failed';
    finalAnswer = Object.values(result.outputs).join('\n\n');
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
  } catch (err) {
    // Safety net: if executeWorkflowDag (or anything above) throws, the channel
    // would otherwise stay in activeRuns with mode='running' forever — the UI
    // shows "运行中" but nothing is actually executing. Treat it as interrupted
    // and tear down so the user can re-run.
    if (runActive(ch)) {
      const message = err instanceof Error ? err.message : String(err);
      ch.error = {
        code: 'uncaught',
        message,
        adapter,
        occurredAt: Date.now(),
      };
      pushRunLog(
        ch,
        `✗ 运行意外中止: ${message} · ${formatClock(Date.now())}`,
        'assistant',
      );
      channelCommit(ch, 'interrupted', true);
      if (runViewActive(ch)) useStore.getState().setMode('design');
      finishRun(ch);
    }
  } finally {
    if (learningTurn) {
      const actualTerminal = ch.cancelled || controller.signal.aborted ? 'cancelled' : terminal;
      void learningTurn.finish({ finalAnswer, terminal: actualTerminal }).catch((error) =>
        console.warn('[skills] DAG 后台回顾失败', error));
    }
    guiSkillRuns.delete(ch);
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

  try {
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
  } catch (err) {
    if (runActive(ch)) {
      const message = err instanceof Error ? err.message : String(err);
      pushRunLog(
        ch,
        `✗ 模拟运行意外中止: ${message} · ${formatClock(Date.now())}`,
        'assistant',
      );
      channelCommit(ch, 'interrupted', true);
      if (runViewActive(ch)) useStore.getState().setMode('design');
      finishRun(ch);
    }
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
