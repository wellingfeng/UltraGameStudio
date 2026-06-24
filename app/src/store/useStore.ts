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
  encodeToolPatch,
  extractToolSentinels,
  hasToolSentinel,
  type ToolEventPatch,
} from '@/components/ai/lib/toolEvent';
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
import { listProviders, setActiveProviderId } from '@/lib/apiConfig';
import { appendComposerDraftState } from '@/lib/composerEntryPolicy';
import {
  clearActiveGatewaySelection,
  getDefaultGatewaySelection,
  getExplicitActiveGatewaySelection,
  setActiveGatewaySelection,
} from '@/lib/gatewayConfig';
import { getCliRuntimeSnapshot } from '@/lib/cliConfig';
import { ensureFreeProxy, isFreeChannelSelection } from '@/lib/freeChannels';
import { getManifestModeEnabled } from '@/lib/manifestMode';
import {
  projectEngineLabel,
  projectSettingsFromMetadata,
} from '@/lib/projectSettings';
import {
  isNotifiableCompletionStatus,
  notifySessionComplete,
  setSessionNotificationClickHandler,
} from '@/lib/sessionNotification';
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
  selectionKey,
  systemDefaultGatewaySelection,
  workflowDefaultGatewaySelection,
} from '@/lib/modelGateway/resolver';
import { shortId } from '@/lib/id';
import {
  aiEditViaCli,
  cancelAiCli,
  downloadModelAsset,
  ensureDefaultWorkspaceDir,
  isTauri,
} from '@/lib/tauri';
import {
  linkManagedAssetsFromMessageText,
  registerAsset,
  type AssetKind,
  type AssetOrigin,
} from '@/lib/downloadRegistry';
import {
  COMFY_PROMPT_SYSTEM,
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
  startSpeechGenerationTurn,
  startSpriteGenerationTurn,
  startMeshSearchTurn,
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
  extractJsonObject,
  modelStrategyGuidance,
  buildAssetCapabilityBlock,
  shouldUseAssetCapabilityBlockForPrompt,
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
  type RunCallbacks,
  type RunContext as RuntimeRunContext,
  type RunFailure,
  type RunGateway,
} from '@/runtime';
import {
  DEFAULT_LOCALE,
  languageAdaptationPrompt,
  t,
  type Locale,
} from '@/lib/i18n';
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
  remoteRunnerProviderMatchesWorkspace,
  remoteWorkspaceIdFromPath,
} from '@/lib/remoteWorkspace';
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
  Partial<Pick<StoreState, 'chattingSessions' | 'waitingInputSessions'>>;

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
  return 'claude-code';
}

const REMOTE_CLAUDE_TIER_ALIASES = new Set(['haiku', 'sonnet', 'opus']);

function remoteWorkspaceModelForAdapter(
  adapter: GatewaySelection['adapter'],
  model: string | null | undefined,
): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed) return undefined;
  if (
    adapter !== 'claude-code' &&
    REMOTE_CLAUDE_TIER_ALIASES.has(trimmed.toLowerCase())
  ) {
    return undefined;
  }
  return trimmed;
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
  const provider =
    remoteProviders.find(
      (item) => runtimeAdapterFromProviderKind(item.kind) === configAdapter,
    ) ?? remoteProviders[0];
  if (provider) {
    const adapter = runtimeAdapterFromProviderKind(provider.kind);
    const model =
      configModel || remoteWorkspaceModelForAdapter(adapter, provider.model) || 'default';
    return normalizeGatewaySelection({
      adapter,
      modelClass: model,
      ...(configModel ? { modelOverride: configModel } : {}),
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
): Pick<StoreState, 'composer' | 'composerBySession' | 'workflow'> {
  let composerBySession = rememberSessionComposer(state);
  const key = workflowSessionKeyId(sessionKey);
  const stored = sessionKeyPersistable(sessionKey)
    ? composerBySession[key]
    : undefined;
  const baseSnapshot =
    stored ??
    ({
      composer: fallbackComposer,
      gatewaySelection: workflowDefaultGatewaySelection(
        workflow,
        fallbackComposer.model,
      ),
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
): void {
  // The Asset Hub only tracks what the AI produced/handled (generated,
  // downloaded, modified). Asset paths the user types are not AI-handled
  // assets, so skip non-assistant messages.
  if (message.role !== 'assistant') return;
  if (!message.text.includes('.ultragamestudio')) return;
  linkManagedAssetsFromMessageText({
    text: message.text,
    sessionId: sessionKey.sessionId,
    workspaceId: sessionKey.workspaceId,
    messageId: message.id,
  });
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
    ...(summary.favorite === true ? { favorite: true } : {}),
    ...(scheduledTask ? { scheduledTask } : {}),
  };
}

export function summaryFromRecord(record: SessionRecord): SessionSummary {
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
  useStore.setState((s) => {
    if (s.activeWorkspaceId !== workspaceId) return {};
    const sessionKey = { workspaceId, sessionId };
    const composerPatch = composerPatchForSession(
      s,
      sessionKey,
      nextWorkflow,
      fallbackComposer,
    );
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
      await historyStore.createSession({
        workspaceId,
        id: sessionId,
        isWorkflow: false,
        messages: [],
        title,
      });
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

  generateSpeechPrompt: (text, options = {}) => {
    startSpeechGenerationTurn(text, options);
  },

  generateSpritePrompt: (text, options = {}) => {
    startSpriteGenerationTurn(text, options);
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

  branchSessionFromMessage: (messageId) => {
    void branchChatSessionFromMessage(messageId);
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
    const state = useStore.getState();
    if (isWorkflowReadOnly(state)) return false;
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
      return false;
    }
    if (activeChatAppend === 'appended') {
      if (state.blockedSendTip) set({ blockedSendTip: null });
      return true;
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
    linkMessageManagedAssets(userMsg, aiEditingSession);
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
    if (
      !useApi &&
      !useCli &&
      !selectedRemoteWorkspaceConfig
    ) {
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
        return true;
      }
      // [dynamic-only refactor] 本地意图引擎(applyIntent)蓝图编辑已停用。
      // 非简单模式 + 无后端：仅提示，不再做关键词改图。
      pushAssistant(
        `当前环境无法调用所选运行时。请在桌面版中使用本地 CLI，或切回 Claude Code 并配置 API key。`,
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
      sessionId: ch.sessionId ?? undefined,
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
          workspacePath: workspaceRootPath,
          locale: state.locale,
          projectEngineGuidance,
          personalBlock,
          gameExpertBlock,
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

      // Serialize turns for this chat session so a follow-up sent mid-stream
      // ("插话") queues behind the in-flight turn and then runs with --resume
      // (warm context) instead of colliding on the same native --session-id.
      // Favorite reruns mint a fresh session per turn, so they need no queue.
      const runChatTurn = async () => {
        const simpleAssetCapabilityBlock = shouldUseAssetCapabilityBlockForPrompt(trimmed)
          ? assetCapabilityBlock
          : '';
        const chatSystem = [
          SIMPLE_CHAT_SYSTEM,
          languageAdaptationPrompt(state.locale),
          personalBlock,
          gameExpertBlock,
          simpleAssetCapabilityBlock,
          projectEngineGuidance,
          useCli ? projectMcpGuidance : '',
        ].join('');
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
        const priorMessages = historyBeforeThisTurn.filter(
          (m) =>
            m.role !== 'system' &&
            !m.localOnly &&
            m.text.trim() &&
            !(m.role === 'assistant' && m.text.trimStart().startsWith('⟳')),
        );
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
          let routeLine = gatewayRouteLine(directRoute);
          // The model may emit a click-to-choose interaction block instead of a
          // final answer (see core/interaction.ts). Loop: call → if it asked,
          // render the widget, wait for the user's click, feed the answer back,
          // and re-invoke; otherwise finalize. Bounded so a model that keeps
          // asking can't spin forever.
          let continuation = '';
          let finalAnswer = '';
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
              const basePromptBody =
                nativeSession && nativeResume
                  ? unseenTranscript
                    ? `以下是你这个模型会话尚未看到的中间对话，请先吸收上下文，再回答最后一个「用户」消息：\n\n${unseenTranscript}\n\n用户：${trimmed}`
                    : trimmed
                  : chatPrompt;
              // On a continuation round the native session already carries the
              // prior context, so send only the user's answer; otherwise send
              // the full prompt body.
              const promptBody = continuation || basePromptBody;
              let live = '';
              const callNativeCli = async (
                body: string,
                session: ChatNativeSession | null,
                resume: boolean,
              ) =>
                aiEditViaCliWithSpeed(`${chatSystem}\n\n${body}`, cli, {
                  permission: chatPermission,
                  model: cli.model,
                  cliCommand: cli.cliCommand,
                  env: cli.env,
                  ...aiEditCliWorkspaceOptions(ch, state.composer),
                  sessionId: session?.sessionId,
                  resume: session ? resume : undefined,
                  onProgress: (chunk) => {
                    live += chunk;
                    setActive(
                      withAiTiming(routedBody(routeLine, liveProse(live) || '⟳ 生成中…')),
                    );
                  },
                });
              try {
                answer = await callNativeCli(promptBody, nativeSession, nativeResume);
              } catch (err) {
                // Two recoverable native-session failures share one cure: drop the
                // bad id, mint a fresh one, and re-send the transcript as cold
                // context.
                //   - "No conversation found …" — the resume target vanished
                //     (only meaningful when we were resuming).
                //   - "Session ID … is already in use" — the id is registered AND
                //     locked from a prior turn that never exited cleanly; this can
                //     hit the FIRST turn too (a create collision), so it is not
                //     gated on nativeResume.
                if (
                  nativeSession &&
                  ((nativeResume && isMissingClaudeConversationError(err)) ||
                    isSessionAlreadyInUseError(err))
                ) {
                  forgetChatNativeSession(nativeSession);
                  nativeSession = chatNativeSessionFor(ch, cli);
                  const fallbackPromptBody = continuation
                    ? `${chatPrompt}\n\n${continuation}`
                    : chatPrompt;
                  live = '';
                  setActive(withAiTiming(routedBody(routeLine, '⟳ 生成中…')));
                  answer = await callNativeCli(fallbackPromptBody, nativeSession, false);
                } else {
                  throw err;
                }
              }
              if (nativeSession) nativeSession.started = true;
              if (!answer.trim() && live.trim()) answer = live;
              // Preserve any tool-call sentinels the CLI streamed this round so
              // the session-files list keeps the files this turn read/edited.
              latestCliLive = live;
              if (hasToolSentinel(live)) {
                const { patches } = extractToolSentinels(live);
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
              const returned = await completeDirectWithSpeed({
                system: chatSystem,
                userContent,
                onDelta: (chunk) => {
                  full += chunk;
                  setActive(withAiTiming(routedBody(routeLine, liveProse(full) || '⟳ 生成中…')));
                },
              });
              answer = full || returned;
            }
            const req = parseInteraction(answer);
            if (!req) {
              finalAnswer = answer;
              break;
            }
            // The model is asking the user to choose. Show whatever prose came
            // before the block, render the clickable widget, and wait.
            setActive(
              withAiTiming(routedBody(routeLine, stripInteraction(answer) || '（请选择）')),
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
            newBubble(withAiTiming('⟳ 生成中…'));
            continuation = formatAnswerForPrompt(req, userAnswer);
          }
          const turnMessageId = activeId;
          // Re-attach the tool sentinels captured while streaming so the answer
          // bubble keeps its tool cards AND the session-files list keeps the
          // files this turn touched (it parses <<UGS_TOOL>> sentinels from the
          // persisted message text). Without this, the clean CLI reply replaces
          // the streamed text and every read/edited file vanishes from the list.
          const finalProse = finalAnswer.trim() || '（模型没有返回内容）';
          const finalBody = finalChatBodyWithStreamedTools(
            finalProse,
            latestCliLive,
            streamedToolSentinels,
          );
          setActive(
            withAiTiming(routedBody(routeLine, finalBody)),
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
      // Interjection ("插话") is the default for every simple-chat turn: a
      // follow-up sent while a turn is still streaming queues behind the in-flight
      // turn and then runs once it finishes — so it always continues the SAME
      // conversation with the prior answer folded into context (and, for CLI,
      // --resume onto the warm native session instead of colliding on the shared
      // --session-id). This applies to BOTH CLI and direct-API turns; serializing
      // the API path too is what makes an interjection merge into the running
      // chat rather than racing it as a parallel turn. Favorite reruns mint a
      // fresh session per turn, so they never queue.
      if (!replayFavoriteSimpleChat) {
        void enqueueChatTurn(chSessionKey, runChatTurn);
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
        stampUsageOnMessage(activeId, usageBefore);
        removeAiEditChannel(ch);
      }
    })();
    return true;
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
      syncWaitingInputSessions();
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
      syncWaitingInputSessions();
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

  ensureSessionStartupWorkspace: () => ensureSessionStartupWorkspaceSlice(),

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

function clearChatTurnQueue(sessionKey: string): void {
  chatTurnQueues.delete(sessionKey);
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
    clearChatTurnQueue(ch.sessionKey);
    resolvePendingAiEditInteractions(ch);
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

export function mergeMessagesById(base: Message[], updates: Message[]): Message[] {
  if (updates.length === 0) return base;
  const byId = new Map(updates.map((message) => [message.id, message]));
  // Apply in-place updates first, preserving `base` ordering for messages that
  // already exist (e.g. live streaming edits to an assistant bubble).
  const merged = base.map((message) => byId.get(message.id) ?? message);
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

export function aiEditCommitMessages(ch: AiEditChannel | null, persist: boolean): void {
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

export function gatewayRouteLine(route: RouteDisplay | null | undefined): string {
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

export function gatewayRouteHeader(route: RouteDisplay | null | undefined): string {
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

function finalChatBodyWithStreamedTools(
  finalProse: string,
  latestLive: string,
  fallbackSentinels: string,
): string {
  if (!fallbackSentinels) return finalProse;
  const ordered = orderedFinalBodyFromLiveTools(finalProse, latestLive);
  if (!ordered) return `${fallbackSentinels}${finalProse}`;

  const orderedKeys = new Set(
    extractToolSentinels(ordered).patches.map(toolPatchIdentity),
  );
  const missingPatches = extractToolSentinels(fallbackSentinels).patches.filter(
    (patch) => !orderedKeys.has(toolPatchIdentity(patch)),
  );
  if (missingPatches.length === 0) return ordered;
  // These sentinels were collected this turn but aren't in `latestLive` (e.g.
  // tool calls from an earlier interaction round whose stream isn't part of the
  // final round). Chronologically they ran BEFORE this round's work and the
  // conclusion the model emits last, so prepend them — appending here would
  // wrongly render those tool cards below the final answer.
  return `${missingPatches.map(encodeToolPatch).join('')}${ordered}`;
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
  for (const [id, entry] of [...pendingInteractionResolvers]) {
    if (entry.runKey !== ch.key) continue;
    pendingInteractionResolvers.delete(id);
    entry.resolve(null);
  }
  syncWaitingInputSessions();
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
  for (const [id, entry] of [...pendingInteractionResolvers]) {
    if (entry.aiEditKey !== ch.key) continue;
    pendingInteractionResolvers.delete(id);
    entry.resolve(null);
  }
  syncWaitingInputSessions();
  const mark = (m: Message): Message =>
    m.interaction && m.interactionStatus === 'pending'
      ? { ...m, interactionStatus: 'cancelled' }
      : m;
  ch.messages = ch.messages.map(mark);
  aiEditCommitMessages(ch, true);
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
