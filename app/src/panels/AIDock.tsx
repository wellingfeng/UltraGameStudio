import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  type ReactNode,
} from "react";
import { FilePreviewTabs, MainFilePreview } from "@/components/ai/FilePreviewTabs";
import { filePreviewScope, useFilePreviewTabs } from "@/store/filePreviewTabs";
import { TitleBarContent } from "@/components/TitleBar";
import SidebarToggleButton from "@/components/SidebarToggleButton";
import {
  ArrowDownToLine,
  ArrowUp,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsDown,
  ChevronsUp,
  ChevronUp,
  Copy,
  Eye,
  File,
  Folder,
  GitBranch,
  Hash,
  Languages,
  ListChecks,
  Loader2,
  Lock,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  ShieldAlert,
  ShieldQuestionMark,
  Square,
  Trash2,
  Unlock,
  X,
  Zap,
} from "lucide-react";
import Select from "@/components/Select";
import ComposerOptions from "@/components/ComposerOptions";
import EditedFilesCard from "@/components/ai/EditedFilesCard";
import SessionChangesSummary from "@/components/ai/SessionChangesSummary";
import ChatTaskProgress from "@/components/ai/ChatTaskProgress";
import { collectChatTaskProgress } from "@/lib/chatTasks";
import { MessageArtifacts } from "@/components/ai/GeneratedArtifactsCard";
import { collectSessionFileChanges, collectTurnFileChanges } from "@/lib/turnFileChanges";
import { summarizeAnswer, type InteractionAnswer } from "@/core/interaction";
import { readStartUserInputs } from "@/core/startInputs";
import {
  systemDefaultGatewaySelection,
  workflowDefaultGatewaySelection,
} from "@/lib/modelGateway/resolver";
import { RUNTIME_ADAPTERS, type RuntimeAdapterId } from "@/lib/adapters";
import {
  getProviderRuntimeInfo,
  listProviders,
  type Provider,
  type ProviderKind,
} from "@/lib/apiConfig";
import { getCliRuntimeSnapshot, isCliAdapterAvailable } from "@/lib/cliConfig";
import { cn } from "@/lib/cn";
import { attachAutoHideScroll } from "@/hooks/useAutoHideScroll";
import {
  FREE_CHANNELS,
  FREE_CHANNEL_AUTO_ID,
  FREE_CHANNEL_AUTO_MODEL,
  ensureFreeProxy,
  freeChannelById,
  freeChannelReady,
  freeChannelSelection,
  getFreeChannelKey,
  getFreeChannelModel,
  getFreeChannelModelOverride,
  isFreeChannelSelection,
  loadFreeChannelKeyFromAutoConfig,
  setFreeChannelKey,
  setFreeChannelModel,
  type FreeChannel,
} from "@/lib/freeChannels";
import LocalModelSetupDialog from "@/components/LocalModelSetupDialog";
import {
  DEFAULT_IMAGE_GENERATION_SETTINGS,
  imageProviders,
  imageProviderModel,
  imageProviderReady,
  loadImageGenerationSettings,
  saveImageGenerationSettings,
  type ImageGenerationSettings,
  type ImageProviderId,
} from "@/lib/imageGeneration";
import {
  DEFAULT_MUSIC_GENERATION_SETTINGS,
  MUSIC_PROVIDERS,
  loadMusicGenerationSettings,
  musicProviderModel,
  musicProviderReady,
  saveMusicGenerationSettings,
  type MusicGenerationSettings,
  type MusicProviderId,
} from "@/lib/musicGeneration";
import {
  DEFAULT_THREE_D_GENERATION_SETTINGS,
  THREE_D_PROVIDERS,
  loadThreeDGenerationSettings,
  saveThreeDGenerationSettings,
  threeDProviderModel,
  threeDProviderReady,
  type ThreeDGenerationSettings,
  type ThreeDProviderId,
} from "@/lib/threeDGeneration";
import {
  DEFAULT_VIDEO_GENERATION_SETTINGS,
  VIDEO_PROVIDERS,
  loadVideoGenerationSettings,
  saveVideoGenerationSettings,
  videoProviderModel,
  videoProviderReady,
  type VideoGenerationSettings,
  type VideoProviderId,
} from "@/lib/videoGeneration";
import {
  DEFAULT_ANIMATION_GENERATION_SETTINGS,
  animationProviderModel,
  animationProviderReady,
  animationProviders,
  loadAnimationGenerationSettings,
  saveAnimationGenerationSettings,
  type AnimationGenerationSettings,
  type AnimationProviderId,
} from "@/lib/animationGeneration";
import {
  DEFAULT_SPEECH_GENERATION_SETTINGS,
  SPEECH_PROVIDERS,
  loadSpeechGenerationSettings,
  saveSpeechGenerationSettings,
  speechProviderModel,
  speechProviderReady,
  type SpeechGenerationSettings,
  type SpeechProviderId,
} from "@/lib/speechGeneration";
import type { SelectOption } from "@/store/types";
import { cacheTtlOptions, startupModeOptions } from "@/store/sampleSessions";
import {
  THINKING_LEVEL_DEFAULT_ID,
  declaredLevelsFor,
  parseThinkingLevelOverrides,
  thinkingDefault,
  thinkingLevelOptions,
  thinkingLevelLabelKey,
} from "@/lib/thinkingLevels";
import {
  LANGUAGE_SELECT_OPTIONS,
  localizeSelectOption,
  t,
  type Locale,
} from "@/lib/i18n";
import type { Message } from "@/store/types";
import type { SkillReviewState } from "@/runtime/skills/types";
import SkillLearningCard from "@/components/ai/SkillLearningCard";
import { isSkillReviewVisible } from "@/components/ai/lib/skillReviewVisibility";
import {
  buildSlashSuggestions,
  buildGameSkillSuggestions,
  type SlashSuggestion,
} from "@/lib/slashCommands";
import {
  guardSlashCommandText,
  slashGuardChannelForText,
  type SlashGuardChannel,
  type SlashCommandGuardSettings,
} from "@/lib/slashCommandGuards";
import {
  parseGameExpertCommand,
  gameExpertMenuEntries,
} from "@/lib/gameExperts";
import {
  buildGameOrgTree,
  flattenGameOrgNodes,
  loadGameOrgDefinition,
  type GameOrgNodeDefinition,
  type ResolvedGameOrgNode,
} from "@/lib/gameOrg";
import {
  loadDockHeight,
  loadPaneWidth,
  saveDockHeight,
  savePaneWidth,
} from "@/lib/composerStorage";
import {
  describeShortcutBinding,
  isNativeTextareaNewlineShortcut,
  loadShortcutSettings,
  matchesShortcut,
  shortcutParts,
  subscribeShortcutSettings,
} from "@/lib/keyboardShortcuts";
import { shouldRefocusComposerAfterAppend } from "@/lib/composerEntryPolicy";
import {
  tauriAvailable,
  blueprintModeInstall,
  blueprintModeStatus,
  localModelStatus,
  listWorkspaceDirectory,
  onSlashCatalogUpdated,
  openExternal,
  openLocalPath,
  readLocalFileForUpload,
  saveClipboardImage,
  slashCatalog,
  type ClipboardImageSaveRequest,
  type LocalModelRuntimeStatus,
  type SessionCaptureSaveRequest,
  type SlashCatalogEntry,
  type WorkspaceDirectoryListing,
  type WorkspaceTreeEntry,
} from "@/lib/tauri";
import { downscalePastedImage } from "@/lib/pastedImage";
import {
  applyProjectFileDragDropEffect,
  clearProjectFileDragData,
  hasProjectFileDragData,
  PROJECT_FILE_DRAG_END_EVENT,
  PROJECT_FILE_DRAG_MOVE_EVENT,
  type ProjectFileDragEndDetail,
  type ProjectFileDragMoveDetail,
  projectFilePathsFromDataTransfer,
  projectFileRelativePathsFromDataTransfer,
  setProjectFileDragAccepted,
} from "@/lib/projectFileDrag";
import {
  canRefreshFreeChannelModels,
  freeChannelModelOptions,
  providerModelOptions,
  refreshFreeChannelModels,
  refreshProviderModels,
} from "@/lib/modelLists";
import { formatCompactTokenCount } from "@/lib/contextUsage";
import {
  uniqueWorkspaceHistory,
  workspacePathKey,
} from "@/lib/workspaceHistory";
import LazyMessageContent from "@/components/ai/LazyMessageContent";
import CopyButton from "@/components/ai/CopyButton";
import {
  answerActionText,
  cleanMessageText,
  renderMessageText,
  routeLabelFromText,
  turnTimingFromMessage,
} from "@/components/ai/lib/messageText";
import { translatePublicText } from "@/lib/publicTranslation";
import { captureConversation } from "@/lib/sessionScreenshot";
import { recordConversationGif } from "@/lib/sessionGif";
import StudioRunCard from "@/panels/StudioRunCard";
import GameTeamPanel, {
  OPEN_GAME_TEAM_DETAILS_EVENT,
} from "@/panels/GameTeamPanel";
import { requestProjectRightPanelFilePreview, requestProjectRightPanelToggle, requestProjectRightPanelSessionFiles,
  PROJECT_RIGHT_PANEL_VISIBILITY_EVENT } from "@/panels/projectRightPanelEvents";
import { activeChatTitle, formatMessageTime } from "@/panels/aidock/chatTitle";
import {
  fileMentionEntryForTarget,
  fileMentionErrorMessage,
  fileMentionInsertText,
  fileMentionListingKey,
  fileMentionListTargets,
  filterFileMentionEntries,
  findFileMentionTrigger,
  normalizeFileMentionPath,
  uniqueFileMentionEntries,
  type FileMentionListing,
  type FileMentionListTarget,
  type FileMentionTrigger,
} from "@/panels/aidock/fileMentions";
import {
  buildSearchMatches,
  normalizeSearchQuery,
  previousUserText,
  serializeConversation,
} from "@/panels/aidock/search";
import {
  expandSlashRequest,
  filterSlashSuggestions,
  findGameSkillTrigger,
  findOrgMentionTrigger,
  findSlashTrigger,
  scopeSlashSuggestionsForAdapter,
  type SlashTrigger,
} from "@/panels/aidock/slashSuggestions";
import {
  consumeForceBottomScrollForSession,
  readStreamScrollSnapshot,
  restoreStreamScrollSnapshot,
  scrollStreamToBottom,
  streamScrollKey,
  type StreamScrollSnapshot,
} from "@/panels/aidock/streamScroll";
import FileText from "@/components/ai/FileText";
import FilePreviewDrawer, {
  FILE_PREVIEW_DRAWER_LAYOUT_EVENT,
  type FilePreviewDrawerLayoutDetail,
} from "@/components/ai/FilePreviewDrawer";
import type { FileRef } from "@/components/ai/lib/filePath";
import {
  displayFileRefLabel,
  isImageFileRef,
  parentDirectoryPath,
} from "@/components/ai/lib/filePath";
import { scanFileRefs } from "@/components/ai/lib/fileScan";
import { orderDisplayMessages } from "@/components/ai/lib/orderDisplayMessages";
import FileChip, {
  FileChipBudgetProvider,
  type OpenFileIntent,
} from "@/components/ai/FileChip";
import { shallow } from "zustand/shallow";
import { isActiveAiEditingSession, useStore, retryPersistedSkillLearning } from "@/store/useStore";
import {
  getRemoteWorkspace,
  getCachedRemoteWorkspaceSkills,
  isRemoteRunnerProvider,
  isRemoteWorkspacePath,
  parseRemoteProviderId,
  refreshRemoteWorkspaceAccounts,
  refreshRemoteWorkspaceSkills,
  remoteModelForAdapter,
  remoteRunnerProviderMatchesWorkspace,
  remoteWorkspaceIdFromPath,
  listRemoteWorkspaceDirectory,
  uploadRemoteWorkspaceFile,
  REMOTE_WORKSPACE_SKILLS_UPDATED_EVENT,
} from "@/lib/remoteWorkspace";
import {
  isRemoteSettingsProfile,
  preloadSettingsProfile,
  settingsProfileIdForWorkspacePath,
  type SettingsProfileOptions,
} from "@/lib/generationSettingsStore";

const DEFAULT_DOCK_HEIGHT = 208; // matches the former h-52
const MIN_DOCK_HEIGHT = 120;
/**
 * How many trailing messages render rich markdown eagerly on (re)mount. The rest
 * start as cheap plain text and upgrade lazily on scroll — see LazyMessageContent.
 * Keep the first mount tiny; older rows are added after paint.
 */
const EAGER_MESSAGE_TAIL = 5;
const INITIAL_MESSAGE_WINDOW = 5;
const BACKGROUND_MESSAGE_WINDOW_TARGET = 80;
const BACKGROUND_MESSAGE_WINDOW_PAGE = 15;
const MESSAGE_WINDOW_PAGE = 80;
/**
 * Frames spent re-pinning a bottom-restored session while the message window
 * and lazy markdown upgrade (see scheduleBottomAlignment).
 */
const STREAM_BOTTOM_REALIGN_ATTEMPTS = 8;
const STREAM_BOTTOM_REALIGN_DELAY_MS = 32;
const TIMELINE_SUMMARY_LIMIT = 40;
/** Fixed height of the bottom input area in 'chat' layout (return fills the rest). */
const CHAT_INPUT_HEIGHT = 300;

/** localStorage key + bounds for the AI-input pane width (right column). */
const INPUT_WIDTH_KEY = "ultragamestudio.aiInputWidth.v1";
const DEFAULT_INPUT_WIDTH = 384; // matches the former w-96
const MIN_INPUT_WIDTH = 280;
const MIN_RETURN_WIDTH = 240; // keep the AI-return pane usable
const NARROW_INPUT_MIN_WIDTH = 120;
const NARROW_INPUT_WIDTH_RATIO = 0.4;

/** localStorage key + bounds for the bottom input area height in 'chat' layout. */
const CHAT_INPUT_HEIGHT_KEY = "ultragamestudio.chatInputHeight.v1";
const MIN_CHAT_INPUT_HEIGHT = 180;
const MIN_CHAT_RETURN_HEIGHT = 160; // keep the chat return area usable
// Empty-session centered composer: base card height is min-h-[14rem] (224px).
// Let the box grow with content up to 2.5x that base, then scroll internally.
const CENTER_INPUT_BASE_HEIGHT = 224;
const CENTER_INPUT_MAX_HEIGHT = Math.round(CENTER_INPUT_BASE_HEIGHT * 2.5);
const MIN_CHAT_VISIBLE_WIDTH = 320;
const MAX_CHAT_TITLE_LENGTH = 80;

type AIDockGenerationMode =
  | "image"
  | "music"
  | "threeD"
  | "video"
  | "animation"
  | "sprite"
  | "speech"
  | null;

type AIDockGenerationSettingsState = {
  profileId: string | null;
  loaded: boolean;
  image: ImageGenerationSettings;
  music: MusicGenerationSettings;
  threeD: ThreeDGenerationSettings;
  video: VideoGenerationSettings;
  animation: AnimationGenerationSettings;
  speech: SpeechGenerationSettings;
};

const AIDOCK_GENERATION_SETTINGS_EVENTS = [
  "ugs:image-generation-settings-changed",
  "ugs:music-generation-settings-changed",
  "ugs:three-d-generation-settings-changed",
  "ugs:video-generation-settings-changed",
  "ugs:animation-generation-settings-changed",
  "ugs:speech-generation-settings-changed",
] as const;

function composerGenerationMode(composer: {
  imageMode?: boolean;
  musicMode?: boolean;
  threeDMode?: boolean;
  videoMode?: boolean;
  animationMode?: boolean;
  spriteMode?: boolean;
  speechMode?: boolean;
}): AIDockGenerationMode {
  if (composer.imageMode) return "image";
  if (composer.musicMode) return "music";
  if (composer.threeDMode) return "threeD";
  if (composer.videoMode) return "video";
  if (composer.animationMode) return "animation";
  if (composer.spriteMode) return "sprite";
  if (composer.speechMode) return "speech";
  return null;
}

function defaultAIDockGenerationSettings(
  profileId: string | null,
): AIDockGenerationSettingsState {
  return {
    profileId,
    loaded: false,
    image: DEFAULT_IMAGE_GENERATION_SETTINGS,
    music: DEFAULT_MUSIC_GENERATION_SETTINGS,
    threeD: DEFAULT_THREE_D_GENERATION_SETTINGS,
    video: DEFAULT_VIDEO_GENERATION_SETTINGS,
    animation: DEFAULT_ANIMATION_GENERATION_SETTINGS,
    speech: DEFAULT_SPEECH_GENERATION_SETTINGS,
  };
}

function loadAIDockGenerationSettings(
  profileId: string | null,
  settingsProfile: SettingsProfileOptions,
): AIDockGenerationSettingsState {
  return {
    profileId,
    loaded: true,
    image: loadImageGenerationSettings(settingsProfile),
    music: loadMusicGenerationSettings(settingsProfile),
    threeD: loadThreeDGenerationSettings(settingsProfile),
    video: loadVideoGenerationSettings(settingsProfile),
    animation: loadAnimationGenerationSettings(settingsProfile),
    speech: loadSpeechGenerationSettings(settingsProfile),
  };
}

function slashChannelNeedsAIDockGenerationSettings(
  channel: SlashGuardChannel | null,
): boolean {
  return (
    channel === "image" ||
    channel === "music" ||
    channel === "threeD" ||
    channel === "video" ||
    channel === "animation" ||
    channel === "speech" ||
    channel === "sprite" ||
    channel === "comfyui"
  );
}

function aidockGenerationSettingsNeeded(
  generationMode: AIDockGenerationMode,
  slashChannel: SlashGuardChannel | null,
): boolean {
  return (
    generationMode !== null ||
    slashChannelNeedsAIDockGenerationSettings(slashChannel)
  );
}

/** Clamp the chat input-area height so neither it nor the return area collapses. */
function clampChatInputHeight(h: number): number {
  const max =
    typeof window !== "undefined"
      ? Math.max(
          MIN_CHAT_INPUT_HEIGHT,
          window.innerHeight - MIN_CHAT_RETURN_HEIGHT,
        )
      : 480;
  return Math.min(Math.max(h, MIN_CHAT_INPUT_HEIGHT), max);
}

function clampHeight(h: number): number {
  const max = typeof window !== "undefined" ? window.innerHeight * 0.75 : 600;
  return Math.min(Math.max(h, MIN_DOCK_HEIGHT), max);
}

function timelineMarkerTop(index: number, total: number): number {
  if (total <= 1) return 50;
  return 6 + (index / (total - 1)) * 88;
}

function summarizeTimelineText(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return "空段落";
  if (compact.length <= TIMELINE_SUMMARY_LIMIT) return compact;
  return compact.slice(0, TIMELINE_SUMMARY_LIMIT - 3).trimEnd() + "...";
}

const ASSET_SESSION_JUMP_EVENT = "ugs:asset-session-jump";

interface AssetSessionJumpDetail {
  assetId?: string;
  sessionId: string;
  workspaceId?: string | null;
  messageId?: string | null;
}

type MessageActionMenu = {
  messageId: string;
  kind: "model" | "translate";
} | null;

type IdleWindow = Window &
  typeof globalThis & {
    requestIdleCallback?: (
      callback: (deadline: { didTimeout: boolean; timeRemaining: () => number }) => void,
      options?: { timeout?: number },
    ) => number;
    cancelIdleCallback?: (handle: number) => void;
  };

function scheduleIdleMessageWindow(callback: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const idleWindow = window as IdleWindow;
  if (idleWindow.requestIdleCallback) {
    const handle = idleWindow.requestIdleCallback(() => callback(), {
      timeout: 200,
    });
    return () => idleWindow.cancelIdleCallback?.(handle);
  }
  const handle = window.setTimeout(callback, 80);
  return () => window.clearTimeout(handle);
}

// Row variants for the inline `$组织架构` tree menu.
type OrgMentionOption =
  | { kind: "back" }
  | { kind: "insert-self"; node: ResolvedGameOrgNode }
  | { kind: "node"; node: ResolvedGameOrgNode; hasChildren: boolean };

const ORG_SLASH_SUGGESTION_PREFIX = "game-org:";

function isOrgSlashSuggestion(suggestion: SlashSuggestion): boolean {
  return suggestion.id.startsWith(ORG_SLASH_SUGGESTION_PREFIX);
}

function orgNodeSearchText(node: ResolvedGameOrgNode): string {
  return [
    node.id,
    node.label,
    node.role,
    node.summary,
    node.profile.position,
    ...node.profile.responsibilities,
    ...node.profile.scenarios,
    ...node.profile.deliverables,
    ...node.profile.collaborators,
    ...node.path,
    ...node.groupLabels,
    ...node.expertIds,
    ...node.experts.flatMap((expert) => [
      expert.id,
      expert.name,
      expert.summary,
      expert.role,
      ...expert.triggers,
    ]),
  ]
    .join(" ")
    .toLocaleLowerCase();
}

/**
 * Flat segmented permission control (replaces the old dropdown). Each of our
 * three permission modes maps to an icon + a tone borrowed from the reference
 * mockup but expressed through our own status tokens:
 *   - readonly  → 安全（蓝）  : 只读，不会改动磁盘
 *   - ask       → 谨慎（琥珀）: 逐步确认
 *   - full      → 危险（红）  : 完全读写，激活时整组高亮
 * Returns the lucide icon and the CSS color variable used for text/active fill.
 */
type PermissionTone = "safe" | "caution" | "danger";

function permissionVisual(id: string): {
  Icon: typeof Eye;
  tone: PermissionTone;
  color: string;
} {
  if (id === "readonly") {
    return { Icon: Eye, tone: "safe", color: "var(--status-ai-edit)" };
  }
  if (id === "ask") {
    return { Icon: ListChecks, tone: "caution", color: "var(--accent-3)" };
  }
  // 'full' (and any unknown id) → most permissive, treat as the danger segment.
  return { Icon: ShieldAlert, tone: "danger", color: "var(--status-error)" };
}

/**
 * Display rank for the permission segments — left→right means increasing
 * privilege, so the most permissive ("full") sits at the far right. The store
 * array order is independent of this (it still drives the default), so we sort
 * a copy at render time using this rank.
 */
function permissionRank(id: string): number {
  if (id === "readonly") return 0; // 只读 — 最低
  if (id === "ask") return 1; // 每次询问 — 居中
  return 2; // 完全访问 — 最高，置于最右
}

function assistantHeaderLabel(message: Message, locale: Locale): string {
  const route = message.routeLabel?.trim() || routeLabelFromText(message.text);
  const level = message.thinkingLevel?.trim();
  if (!level) return route;
  const key = thinkingLevelLabelKey(level);
  const label = key ? t(locale, key) : level;
  return [route, `${t(locale, "dock.thinkingTitle")}：${label}`].filter(Boolean).join(" · ");
}

function translatedAnswerTitle(target: Locale, locale: Locale): string {
  const option = LANGUAGE_SELECT_OPTIONS.find((item) => item.id === target);
  const prefix = locale === "zh-CN" ? "🌐 翻译为 " : "🌐 Translate to ";
  if (!option) return `${prefix}${target}`;
  return `${prefix}${localizeSelectOption(option, locale).label}`;
}

function isCaptureUtilityMessage(message: Message): boolean {
  const text = message.text.trim();
  if (message.role === "user" && /^\/screenshot(?:-gif)?$/i.test(text)) {
    return true;
  }
  return (
    /^✓\s*(?:已截图当前会话|Captured this conversation|已把当前会话录成滚动 GIF|Recorded this conversation as a scrolling GIF)/i.test(
      text,
    ) ||
    /^✗\s*(?:截图失败|Screenshot failed|GIF 录制失败|GIF recording failed)/i.test(
      text,
    ) ||
    /!\[(?:截图预览|screenshot preview|GIF 预览|GIF preview)\]\(/i.test(text)
  );
}

function friendlyCaptureError(err: unknown, locale: Locale): string {
  const msg = err instanceof Error ? err.message : String(err);
  const zh = locale === "zh-CN";
  switch (msg) {
    case "CAPTURE_IMAGE_FETCH_TIMEOUT":
      return zh
        ? "图片加载超时。部分远程图片无响应，请稍后重试或先移除这类图片。"
        : "Image loading timed out. Some remote images did not respond; retry later or remove them first.";
    case "HTML2CANVAS_LOAD_TIMEOUT":
      return zh
        ? "截图组件加载超时。请重试。"
        : "Screenshot renderer load timed out. Please retry.";
    case "HTML2CANVAS_CAPTURE_TIMEOUT":
      return zh
        ? "截图渲染超时。会话可能太长，或包含加载很慢的图片。"
        : "Screenshot render timed out. The conversation may be too long or include slow images.";
    case "CANVAS_ENCODE_TIMEOUT":
      return zh
        ? "图片编码超时。请尝试缩短会话后再截图。"
        : "Image encoding timed out. Try capturing a shorter conversation.";
    case "SESSION_CAPTURE_SAVE_TIMEOUT":
      return zh
        ? "保存截图超时。请检查磁盘或工作区路径后重试。"
        : "Saving capture timed out. Check disk/workspace path and retry.";
    case "GIF_ENCODER_LOAD_TIMEOUT":
      return zh
        ? "GIF 编码器加载超时。请重试。"
        : "GIF encoder load timed out. Please retry.";
    default:
      return msg;
  }
}

function messageActionButtonClass(active = false): string {
  return (
    "relative flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-faint transition-colors hover:bg-border-soft hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-40 " +
    (active ? "bg-border-soft text-fg" : "")
  );
}

function MessageActionMenuPanel({ children }: { children: ReactNode }) {
  return (
    <div className="absolute bottom-[calc(100%+0.25rem)] left-0 z-40 max-h-64 min-w-44 overflow-y-auto rounded-md border border-border bg-panel py-1 shadow-xl">
      {children}
    </div>
  );
}

function MessageActionToolbar({
  messageId,
  text,
  locale,
  openMenu,
  modelOptions,
  modelValue,
  canRegenerate,
  usage,
  onToggleMenu,
  onRegenerate,
  onRegenerateWithModel,
  onTranslate,
  onBranch,
  onDelete,
}: {
  messageId: string;
  text: string;
  locale: Locale;
  openMenu: MessageActionMenu;
  modelOptions: SelectOption[];
  modelValue: string;
  canRegenerate: boolean;
  usage?: Message["usage"];
  onToggleMenu: (kind: "model" | "translate") => void;
  onRegenerate: () => void;
  onRegenerateWithModel: (model: string) => void;
  onTranslate: (target: Locale) => void;
  onBranch: () => void;
  onDelete: () => void;
}) {
  const modelMenuOpen =
    openMenu?.messageId === messageId && openMenu.kind === "model";
  const translateMenuOpen =
    openMenu?.messageId === messageId && openMenu.kind === "translate";
  return (
    <div className="relative mt-1 flex items-center gap-1">
      <CopyButton
        value={text}
        title={t(locale, "dock.copyAnswer")}
        className={messageActionButtonClass()}
      />
      <button
        type="button"
        onClick={onBranch}
        title={t(locale, "dock.branchFromHere")}
        aria-label={t(locale, "dock.branchAria")}
        className={messageActionButtonClass()}
      >
        <GitBranch size={14} />
      </button>
      <button
        type="button"
        onClick={onRegenerate}
        disabled={!canRegenerate}
        title={t(locale, "dock.regenerate")}
        aria-label={t(locale, "dock.regenerate")}
        className={messageActionButtonClass()}
      >
        <RotateCcw size={14} />
      </button>
      <div className="relative">
        <button
          type="button"
          onClick={() => onToggleMenu("model")}
          disabled={!canRegenerate || modelOptions.length === 0}
          title={t(locale, "dock.switchModel")}
          aria-label={t(locale, "dock.switchModel")}
          aria-expanded={modelMenuOpen}
          className={messageActionButtonClass(modelMenuOpen)}
        >
          <span className="font-mono text-sm font-semibold">@</span>
        </button>
        {modelMenuOpen && (
          <MessageActionMenuPanel>
            {modelOptions.map((option, index) => {
              const showGroup =
                !!option.group &&
                option.group !== modelOptions[index - 1]?.group;
              return (
                <div key={option.id}>
                  {showGroup && (
                    <div className="px-3 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-fg-faint">
                      {option.group}
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => onRegenerateWithModel(option.id)}
                    className={
                      "flex w-full items-center gap-2 whitespace-nowrap px-3 py-1.5 text-left text-xs transition-colors " +
                      (option.id === modelValue
                        ? "bg-border-soft text-fg"
                        : "text-fg-dim hover:bg-border-soft hover:text-fg")
                    }
                  >
                    <span
                      className={
                        option.id === modelValue
                          ? "text-[10px] text-accent"
                          : "text-[10px] text-transparent"
                      }
                    >
                      ●
                    </span>
                    <span>{option.label}</span>
                    {option.hint && (
                      <span className="ml-auto text-[10px] text-fg-faint">
                        {option.hint}
                      </span>
                    )}
                  </button>
                </div>
              );
            })}
          </MessageActionMenuPanel>
        )}
      </div>
      <div className="relative">
        <button
          type="button"
          onClick={() => onToggleMenu("translate")}
          disabled={!text}
          title={t(locale, "dock.translateAnswer")}
          aria-label={t(locale, "dock.translateAnswer")}
          aria-expanded={translateMenuOpen}
          className={messageActionButtonClass(translateMenuOpen)}
        >
          <Languages size={14} />
        </button>
        {translateMenuOpen && (
          <MessageActionMenuPanel>
            {LANGUAGE_SELECT_OPTIONS.map((option) => {
              const translations = option.translations as
                | Partial<Record<Locale, { label: string }>>
                | undefined;
              const localized = translations?.[locale]?.label ?? option.label;
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => onTranslate(option.id)}
                  className="flex w-full items-center gap-2 whitespace-nowrap px-3 py-1.5 text-left text-xs text-fg-dim transition-colors hover:bg-border-soft hover:text-fg"
                >
                  <span className="w-6 font-mono text-[10px] text-fg-faint">
                    {option.hint}
                  </span>
                  <span>{localized}</span>
                </button>
              );
            })}
          </MessageActionMenuPanel>
        )}
      </div>
      <button
        type="button"
        onClick={onDelete}
        title={t(locale, "dock.deleteAnswer")}
        aria-label={t(locale, "dock.deleteAnswer")}
        className={messageActionButtonClass()}
      >
        <Trash2 size={14} />
      </button>
      {usage && usage.totalTokens > 0 && (
        <span
          className="ml-auto inline-flex shrink-0 items-center gap-2 pl-2 font-mono text-[10px] text-fg-faint"
          title={
            usage.estimated
              ? locale === "zh-CN"
                ? `本轮 tokens（本地估算）：输入 ${usage.inputTokens} · 输出 ${usage.outputTokens}`
                : `Turn tokens (local estimate): input ${usage.inputTokens} · output ${usage.outputTokens}`
              : locale === "zh-CN"
                ? `本轮 tokens：输入 ${usage.inputTokens} · 输出 ${usage.outputTokens} · 缓存命中 ${usage.cachedInputTokens}`
                : `Turn tokens: input ${usage.inputTokens} · output ${usage.outputTokens} · cache hit ${usage.cachedInputTokens}`
          }
        >
          <span className="inline-flex items-center gap-1">
            <Hash size={11} />
            {formatCompactTokenCount(usage.totalTokens)}
          </span>
          <span className="inline-flex items-center gap-1">
            <Zap size={11} className="text-[var(--accent-3)]" />
            {usage.estimated
              ? "--"
              : `${Math.min(100, Math.round(usage.cachePercent))}%`}
          </span>
        </span>
      )}
    </div>
  );
}

interface TextSelection {
  start: number;
  end: number;
}

type FileMentionInsertMode = "mention" | "path";

function clampSelection(value: number, max: number): number {
  return Math.min(Math.max(value, 0), max);
}

function formatFilePathInsertion(paths: string[]): string {
  return paths
    .map((path) => path.trim())
    .filter(Boolean)
    // Wrap as inline code so the path is an explicit file surface: bare-text
    // chip detection (scanFileRefs) stops at whitespace to avoid mistaking
    // ordinary prose for a path, which breaks any inserted path that itself
    // contains a space (e.g. a workspace root under "C:\Users\John Doe\...").
    // Backticks route parsing through parseFileRef(..., { allowSpaces: true }),
    // so the resulting chip/preview always resolves to the real path.
    .map((path) => `\`${path}\``)
    .join("\n");
}

function filePathPickerInsertText(entry: WorkspaceTreeEntry): string {
  const relativePath = normalizeFileMentionPath(entry.relativePath);
  return `${relativePath}${entry.kind === "directory" ? "/" : ""}`;
}

function pointInsideElement(
  point: { x: number; y: number },
  el: HTMLElement,
): boolean {
  const scale = window.devicePixelRatio || 1;
  const x = point.x / scale;
  const y = point.y / scale;
  const rect = el.getBoundingClientRect();
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function clientPointInsideElement(
  point: { clientX: number; clientY: number },
  el: HTMLElement,
): boolean {
  const rect = el.getBoundingClientRect();
  return (
    point.clientX >= rect.left &&
    point.clientX <= rect.right &&
    point.clientY >= rect.top &&
    point.clientY <= rect.bottom
  );
}

async function pickComposerFiles(title: string): Promise<string[] | null> {
  if (!tauriAvailable()) return null;

  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({
    title,
    directory: false,
    multiple: true,
  });
  if (!picked) return null;
  return Array.isArray(picked) ? picked.map(String) : [String(picked)];
}

function pathsFromDataTransfer(dataTransfer: DataTransfer): string[] {
  return Array.from(dataTransfer.files)
    .map((file) => {
      const withPath = file as File & { path?: string };
      return withPath.path || file.webkitRelativePath || file.name;
    })
    .filter(Boolean);
}

function clipboardImageFiles(dataTransfer: DataTransfer): File[] {
  const seen = new Set<string>();
  const media: File[] = [];

  const isMediaMime = (mime: string) => {
    const t = mime.toLowerCase();
    return t.startsWith("image/") || t.startsWith("video/");
  };

  const add = (file: File | null, mimeHint = "") => {
    if (!file) return;
    const mime = (file.type || mimeHint).toLowerCase();
    if (!isMediaMime(mime)) return;
    const key = [mime, file.name, file.size, file.lastModified].join("\0");
    if (seen.has(key)) return;
    seen.add(key);
    media.push(file);
  };

  for (const item of Array.from(dataTransfer.items)) {
    if (item.kind !== "file") continue;
    if (!isMediaMime(item.type)) continue;
    add(item.getAsFile(), item.type);
  }
  if (media.length > 0) return media;

  for (const file of Array.from(dataTransfer.files)) add(file);

  return media;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkSize),
    );
  }
  return btoa(binary);
}

async function fileToBase64(file: File): Promise<string> {
  return bytesToBase64(new Uint8Array(await file.arrayBuffer()));
}

type RemoteUploadNamespace = "uploads" | "clipboard-images" | "session-captures";

function filesFromDataTransfer(dataTransfer: DataTransfer): File[] {
  const files = Array.from(dataTransfer.files).filter((file) => file.size >= 0);
  if (files.length > 0) return files;

  return Array.from(dataTransfer.items ?? [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => !!file && file.size >= 0);
}

async function uploadRemoteBytes(
  remoteRootPath: string,
  request: {
    bytesBase64: string;
    fileName?: string | null;
    mime?: string | null;
    namespace: RemoteUploadNamespace;
  },
): Promise<string> {
  const uploaded = await uploadRemoteWorkspaceFile(remoteRootPath, request);
  return uploaded.relativePath;
}

async function uploadRemoteFile(
  remoteRootPath: string,
  file: File,
  namespace: RemoteUploadNamespace = "uploads",
): Promise<string> {
  return uploadRemoteBytes(remoteRootPath, {
    bytesBase64: await fileToBase64(file),
    mime: file.type || null,
    fileName: file.name || "upload.bin",
    namespace,
  });
}

async function uploadLocalPathToRemote(
  remoteRootPath: string,
  path: string,
  namespace: RemoteUploadNamespace = "uploads",
): Promise<string> {
  const payload = await readLocalFileForUpload(path);
  return uploadRemoteBytes(remoteRootPath, {
    bytesBase64: payload.bytesBase64,
    mime: payload.mime ?? null,
    fileName: payload.fileName,
    namespace,
  });
}

async function savePastedImageFile(
  file: File,
  cwd: string,
  remoteRootPath?: string,
): Promise<string> {
  // Shrink big screenshots before they hit disk / the remote upload so a single
  // pasted image can't overflow the model request body.
  const compressed = await downscalePastedImage(file);
  if (remoteRootPath) {
    return uploadRemoteFile(remoteRootPath, compressed, "clipboard-images");
  }
  const request: ClipboardImageSaveRequest = {
    bytesBase64: await fileToBase64(compressed),
    mime: compressed.type || "image/png",
    fileName: compressed.name || null,
    cwd: cwd || null,
  };
  return saveClipboardImage(request);
}

function remoteProjectDragInsertPaths(
  remoteRootPath: string,
  paths: string[],
  relativePaths?: string[],
): string[] {
  const explicitRelativePaths = (relativePaths ?? [])
    .map((path) => path.trim())
    .filter(Boolean);
  if (explicitRelativePaths.length > 0) return explicitRelativePaths;

  const root = remoteRootPath.trim().replace(/[\\/]+$/g, "").replace(/\\/g, "/");
  return paths
    .map((path) => {
      const trimmed = path.trim();
      const normalized = trimmed.replace(/\\/g, "/");
      if (root && normalized.startsWith(`${root}/`)) {
        return normalized.slice(root.length + 1).replace(/^\/+|\/+$/g, "");
      }
      return trimmed;
    })
    .filter(Boolean);
}

function fulfilledSettledValues<T>(results: PromiseSettledResult<T>[]): T[] {
  return results
    .filter(
      (result): result is PromiseFulfilledResult<T> =>
        result.status === "fulfilled",
    )
    .map((result) => result.value);
}

function firstRejectedResult<T>(
  results: PromiseSettledResult<T>[],
): PromiseRejectedResult | undefined {
  return results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
}

async function saveRemoteSessionCapture(
  remoteRootPath: string,
  request: SessionCaptureSaveRequest,
): Promise<string> {
  return uploadRemoteBytes(remoteRootPath, {
    bytesBase64: request.bytesBase64,
    mime: request.mime,
    fileName: request.fileName ?? "session-capture",
    namespace: "session-captures",
  });
}

function describeLocalModelStatus(
  locale: Locale,
  channel: FreeChannel,
  status: LocalModelRuntimeStatus,
): string {
  const suffix = status.message ? ` ${status.message}` : "";
  if (status.state === "missing_model") {
    return `${channel.label}: ${t(locale, "settings.freeChannels.localMissingModel")}。`;
  }
  if (status.state === "service_unavailable") {
    return `${channel.label}: ${t(locale, "settings.freeChannels.localServiceDown")}。${suffix}`;
  }
  if (status.state === "model_missing") {
    return `${channel.label}: ${t(locale, "settings.freeChannels.localModelMissing")} (${status.configuredModel})。${suffix}`;
  }
  if (status.state === "desktop_unavailable") {
    return `${channel.label}: ${t(locale, "settings.freeChannels.localDesktopOnly")}。`;
  }
  if (status.state === "unsupported") {
    return `${channel.label}: ${t(locale, "settings.freeChannels.localUnsupported")}。${suffix}`;
  }
  return `${channel.label}: ${t(locale, "settings.freeChannels.localServiceError")}。${suffix}`;
}

const DEFAULT_PROVIDER_OPTION_PREFIX = "default-provider:";
const SYSTEM_DEFAULT_OPTION_PREFIX = "system-default:";
const FREE_CHANNEL_OPTION_PREFIX = "free:";

function defaultProviderOptionId(providerId: string): string {
  return `${DEFAULT_PROVIDER_OPTION_PREFIX}${providerId}`;
}

function systemDefaultOptionId(adapter: RuntimeAdapterId): string {
  return `${SYSTEM_DEFAULT_OPTION_PREFIX}${adapter}`;
}

function freeChannelOptionId(channelId: string): string {
  return `${FREE_CHANNEL_OPTION_PREFIX}${channelId}`;
}

function providerIdFromDefaultOption(optionId: string): string | null {
  if (!optionId.startsWith(DEFAULT_PROVIDER_OPTION_PREFIX)) return null;
  return optionId.slice(DEFAULT_PROVIDER_OPTION_PREFIX.length) || null;
}

function adapterFromSystemDefaultOption(
  optionId: string,
): RuntimeAdapterId | null {
  if (!optionId.startsWith(SYSTEM_DEFAULT_OPTION_PREFIX)) return null;
  const adapterId = optionId.slice(SYSTEM_DEFAULT_OPTION_PREFIX.length);
  const adapter = RUNTIME_ADAPTERS.find((item) => item.id === adapterId);
  return adapter?.id ?? null;
}

function freeChannelFromOption(optionId: string): string | null {
  if (!optionId.startsWith(FREE_CHANNEL_OPTION_PREFIX)) return null;
  const channelId = optionId.slice(FREE_CHANNEL_OPTION_PREFIX.length);
  return freeChannelById(channelId) ? channelId : null;
}

function defaultChannelRuntimeLabel(
  locale: Locale,
  adapter: { label: string },
): string {
  return `${adapter.label} · ${t(locale, "dock.channelKindDefault")}`;
}

function defaultChannelRuntimeGroup(
  locale: Locale,
  adapter: { label: string },
): string {
  return `${t(locale, "dock.channelGroupDefault")} · ${adapter.label}`;
}

function providerKindToAdapter(kind: ProviderKind): RuntimeAdapterId {
  if (kind === "codex") return "codex";
  if (kind === "gemini") return "gemini";
  if (kind === "kimi") return "kimi";
  if (kind === "deepseek-harness") return "deepseek-harness";
  if (kind === "zcode") return "zcode";
  if (kind === "grok") return "grok";
  return "claude-code";
}

function providerSelection(provider: Provider, modelOverride?: string) {
  const adapter = providerKindToAdapter(provider.kind);
  const model = (modelOverride ?? provider.model ?? "").trim();
  return {
    adapter,
    modelClass: model || "default",
    ...(modelOverride?.trim() ? { modelOverride: modelOverride.trim() } : {}),
    providerId: provider.id,
    channelId: "default",
  };
}

/**
 * The pinned provider's real model when the stored modelClass is only a bare
 * Claude tier placeholder. With no modelOverride pinned, runtime resolution
 * (resolveChannelModel) uses the channel's configured model — or a per-tier
 * map entry — so a bare "sonnet" written by older clamping logic would
 * otherwise display a model the run never uses (e.g. "sonnet" on a kimi-k3
 * channel). A tier that the channel's model list explicitly maps is a real
 * pick and stays visible.
 */
function providerDisplayModel(
  modelClass: string | undefined,
  provider: Provider,
): string {
  const stored = modelClass?.trim();
  const channelModel = (provider.model ?? "").trim();
  const tierMapped =
    !!stored &&
    (provider.models ?? []).some(
      (model) => model.trim().toLowerCase() === stored.toLowerCase(),
    );
  if (
    stored &&
    channelModel &&
    !tierMapped &&
    ["sonnet", "opus", "haiku"].includes(stored.toLowerCase())
  ) {
    return channelModel;
  }
  return stored || channelModel || "default";
}

function remoteAdapterToRuntimeAdapter(adapter: unknown): RuntimeAdapterId {
  if (adapter === "codex") return "codex";
  if (adapter === "gemini") return "gemini";
  return "claude-code";
}

function uniqueModelSelectOptions(
  values: Array<string | undefined | null>,
): SelectOption[] {
  const out: SelectOption[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const model = raw?.trim();
    if (!model) continue;
    const key = model.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: model, label: model });
  }
  return out;
}

function modelStrategyLabelKey(strategy: string | undefined) {
  switch (strategy) {
    case "prefer-better":
      return "dock.modelStrategy.better";
    case "prefer-cheaper":
      return "dock.modelStrategy.cheaper";
    case "smart":
      return "dock.modelStrategy.smart";
    default:
      return "dock.modelStrategy.inherit";
  }
}

function interactionOptionCountLabel(locale: Locale, count: number): string {
  return t(locale, "interaction.optionCount").replace("{count}", String(count));
}

function splitInteractionOption(option: string): {
  title: string;
  detail: string;
} {
  const lines = option
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length > 1) {
    return { title: lines[0], detail: lines.slice(1).join(" ") };
  }

  const colon = option.match(/^(.{2,48}?)[：:]\s+(.+)$/);
  if (colon) {
    return { title: colon[1].trim(), detail: colon[2].trim() };
  }

  return { title: option.trim(), detail: "" };
}

const BLUEPRINT_MODE_INSTALL_PROMPT =
  "当前 UE 项目未安装 BlueprintMode 插件。是否现在安装？";
const BLUEPRINT_MODE_INSTALL_LABEL = "安装 BlueprintMode 插件";

interface BlueprintModeStartPayload {
  modeArgs: string | null;
  prompt: string;
}

function tokenizeCommandPayload(
  raw: string,
): Array<{ value: string; start: number; end: number }> {
  const tokens: Array<{ value: string; start: number; end: number }> = [];
  const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|[^\s]+/g;
  for (const match of raw.matchAll(re)) {
    const value = match[1] ?? match[2] ?? match[0];
    tokens.push({
      value,
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
    });
  }
  return tokens;
}

function blueprintFlagExpectsValue(flag: string): boolean {
  if (flag.includes("=")) return false;
  return new Set([
    "--target",
    "--context",
    "--parent",
    "--class",
    "--asset",
    "--path",
    "--folder",
    "--name",
    "--package",
    "--project",
    "--map",
    "--level",
  ]).has(flag.toLowerCase());
}

function parseBlueprintModeStartPayload(
  rawPayload: string,
): BlueprintModeStartPayload {
  const raw = rawPayload.trim();
  if (!raw) return { modeArgs: null, prompt: "" };

  const tokens = tokenizeCommandPayload(raw);
  let index = 0;
  let argsEnd = 0;
  let promptStart = raw.length;

  while (index < tokens.length) {
    const token = tokens[index];
    if (!token.value.startsWith("-")) {
      promptStart = token.start;
      break;
    }
    argsEnd = token.end;
    index += 1;
    if (blueprintFlagExpectsValue(token.value) && index < tokens.length) {
      argsEnd = tokens[index].end;
      index += 1;
    }
  }

  const modeArgs = raw.slice(0, argsEnd).trim() || null;
  const prompt = raw.slice(promptStart).trim();
  return { modeArgs, prompt };
}

/**
 * Renders a node's interaction request (select / input / confirm) inside the
 * AI-return stream. States:
 *   - pending + active : interactive controls; submitting resolves the waiting
 *                        run node via onAnswer → store.answerInteraction.
 *   - answered         : compact "你的回答: …" summary.
 *   - cancelled / stale: read-only note (the run ended before it was answered).
 * See core/interaction.ts for the protocol and the run-loop side.
 */
function InteractionWidget({
  message,
  locale,
  active,
  onAnswer,
  onDismiss,
  onDraftChange,
  workspaceCwd,
  remoteRootPath,
}: {
  message: Message;
  locale: Locale;
  active: boolean;
  onAnswer: (answer: InteractionAnswer) => void;
  onDismiss: () => void;
  onDraftChange: (draft: { values?: string[]; text?: string }) => void;
  workspaceCwd?: string;
  remoteRootPath?: string;
}) {
  const req = message.interaction;
  const status = message.interactionStatus ?? "pending";
  const [selected, setSelectedState] = useState<string[]>(
    () => message.interactionDraft?.values ?? [],
  );
  const [text, setTextState] = useState(
    () => message.interactionDraft?.text ?? "",
  );
  // Keep the draft on the message so a session switch (which unmounts this
  // widget) doesn't lose what the user already typed/selected.
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const textRef = useRef(text);
  textRef.current = text;
  const setSelected = useCallback(
    (updater: (cur: string[]) => string[]) => {
      setSelectedState((cur) => {
        const next = updater(cur);
        selectedRef.current = next;
        onDraftChange({ values: next, text: textRef.current });
        return next;
      });
    },
    [onDraftChange],
  );
  const setText = useCallback(
    (updater: string | ((cur: string) => string)) => {
      setTextState((cur) => {
        const next = typeof updater === "function" ? updater(cur) : updater;
        textRef.current = next;
        onDraftChange({ values: selectedRef.current, text: next });
        return next;
      });
    },
    [onDraftChange],
  );

  if (!req) return null;

  if (status === "answered" && message.interactionAnswer) {
    return (
      <div className="rounded-lg border border-accent-2/40 bg-accent-2/10 px-3 py-2 text-xs text-fg-dim shadow-sm">
        <span className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-accent-2">
          <Check size={12} strokeWidth={2.4} />
          {t(locale, "interaction.youAnswered")}
        </span>{" "}
        {summarizeAnswer(req, message.interactionAnswer)}
      </div>
    );
  }
  if (status === "cancelled") {
    return (
      <div className="rounded-lg border border-border bg-panel-2 px-3 py-2 text-xs text-fg-faint shadow-sm">
        {t(locale, "interaction.cancelled")}
      </div>
    );
  }

  // A pending widget stays fully interactive even when nothing is live for it
  // (`active` false — the run/chat that asked already finished, the app was
  // reloaded mid-wait, etc.). Answering it then routes through
  // store.answerInteraction's orphan branch, which sends the answer as a fresh
  // chat turn instead of resolving a resolver that no longer exists — so a
  // long wait before answering never silently swallows the reply. `active`
  // only controls the informational hint below, not whether inputs work.
  const disabled = false;
  const trimmedText = text.trim();
  const canSubmitSelect = selected.length > 0;
  const submitSelect = () => {
    if (selected.length > 0) onAnswer({ kind: "select", values: selected });
  };
  const toggle = (opt: string) => {
    if (req.type !== "select") return;
    if (!req.multi) {
      onAnswer({ kind: "select", values: [opt] });
      return;
    }
    setSelected((cur) => {
      return cur.includes(opt) ? cur.filter((o) => o !== opt) : [...cur, opt];
    });
  };
  const submitInput = () => {
    if (trimmedText) onAnswer({ kind: "input", text: trimmedText });
  };
  const submitCustomSelect = () => {
    if (trimmedText) onAnswer({ kind: "select", values: [trimmedText] });
  };
  const addCustomOption = () => {
    const v = trimmedText;
    if (!v) return;
    setSelected((cur) => (cur.includes(v) ? cur : [...cur, v]));
    setText("");
  };
  const handleImagePaste = (
    event: ReactClipboardEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => {
    if (disabled) return;
    if (!tauriAvailable() && !remoteRootPath) return;
    const images = clipboardImageFiles(event.clipboardData);
    if (images.length === 0) return;
    event.preventDefault();
    const target = event.currentTarget;
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? target.value.length;
    void Promise.allSettled(
      images.map((file) =>
        savePastedImageFile(file, workspaceCwd ?? "", remoteRootPath),
      ),
    ).then((results) => {
      const paths = results
        .filter(
          (r): r is PromiseFulfilledResult<string> => r.status === "fulfilled",
        )
        .map((r) => r.value);
      if (paths.length === 0) return;
      const insertion = paths.join(" ");
      setText((cur) => cur.slice(0, start) + insertion + cur.slice(end));
    });
  };

  return (
    <div className="flex w-full max-w-[min(1040px,100%)] flex-col gap-3 rounded-lg border border-border bg-panel/95 p-3 shadow-lg shadow-black/25">
      <div className="flex items-start gap-2.5">
        <span
          aria-hidden="true"
          className="mt-5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-accent text-bg shadow-sm shadow-accent/25"
        >
          <ShieldQuestionMark size={14} strokeWidth={2.4} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="mb-1 text-xs font-semibold leading-4 text-accent">
            {t(locale, "interaction.title")}
          </div>
          <div className="whitespace-pre-wrap break-words text-sm font-semibold leading-relaxed text-fg">
            {req.prompt}
          </div>
          {req.type === "select" && (
            <div className="mt-1 text-xs leading-5 text-fg-faint">
              {interactionOptionCountLabel(locale, req.options?.length ?? 0)}
            </div>
          )}
          {active && (
            <div className="mt-1 font-mono text-[10px] leading-4 text-fg-faint">
              {t(locale, "interaction.waitingHint")}
            </div>
          )}
        </div>
      </div>

      {req.type === "select" && (
        <div className="flex flex-col gap-2">
          {req.multi && (
            <span className="font-mono text-[10px] uppercase tracking-wider text-fg-faint">
              {t(locale, "interaction.multiHint")}
            </span>
          )}
          <div className="flex flex-col gap-1.5">
            {req.options?.map((opt) => {
              const on = selected.includes(opt);
              const { title, detail } = splitInteractionOption(opt);
              return (
                <button
                  key={opt}
                  type="button"
                  disabled={disabled}
                  aria-pressed={on}
                  onClick={() => toggle(opt)}
                  className={cn(
                    "group flex min-h-[54px] w-full items-start gap-3 rounded-md border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-55",
                    on
                      ? "border-accent/70 bg-accent/10 text-fg"
                      : "border-border bg-panel-2/70 text-fg hover:border-accent/45 hover:bg-bg",
                  )}
                >
                  {req.multi && (
                    <span
                      aria-hidden="true"
                      className={cn(
                        "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors",
                        on
                          ? "border-accent bg-accent text-bg"
                          : "border-fg-faint/60 bg-bg text-transparent group-hover:border-accent/70",
                      )}
                    >
                      <Check size={12} strokeWidth={3} />
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block break-words text-sm font-medium leading-snug text-fg">
                      {title}
                    </span>
                    {detail && (
                      <span className="mt-0.5 block break-words text-xs leading-relaxed text-fg-faint">
                        {detail}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
          {req.allowInput && (
            <div className="flex flex-col gap-1.5">
              <span className="font-mono text-[10px] uppercase tracking-wider text-fg-faint">
                {t(locale, "interaction.customInputHint")}
              </span>
              <div className="flex gap-2">
                <input
                  value={text}
                  disabled={disabled}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter" || e.shiftKey) return;
                    e.preventDefault();
                    if (req.multi) addCustomOption();
                    else submitCustomSelect();
                  }}
                  onPaste={handleImagePaste}
                  placeholder={t(locale, "interaction.customInputPlaceholder")}
                  className="min-h-10 flex-1 rounded-md border border-border bg-bg px-2.5 py-1.5 text-sm text-fg outline-none transition-colors placeholder:text-fg-faint focus:border-accent focus:ring-1 focus:ring-accent disabled:cursor-not-allowed disabled:opacity-50"
                />
                {req.multi ? (
                  <button
                    type="button"
                    disabled={disabled || !trimmedText}
                    onClick={addCustomOption}
                    className="min-h-10 shrink-0 rounded-md border border-border bg-panel-2 px-3 text-xs font-medium text-fg-dim transition-colors hover:border-accent/45 hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {t(locale, "interaction.add")}
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={disabled || !trimmedText}
                    onClick={submitCustomSelect}
                    className="min-h-10 shrink-0 rounded-md bg-fg px-3 text-xs font-medium text-bg transition-colors hover:bg-fg-dim disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {t(locale, "interaction.submit")}
                  </button>
                )}
              </div>
              {req.multi &&
                selected.some((s) => !req.options?.includes(s)) && (
                  <div className="flex flex-wrap gap-1.5">
                    {selected
                      .filter((s) => !req.options?.includes(s))
                      .map((s) => (
                        <span
                          key={s}
                          className="inline-flex items-center gap-1 rounded-full bg-accent/15 px-2 py-0.5 text-xs text-fg"
                        >
                          {s}
                          <button
                            type="button"
                            disabled={disabled}
                            onClick={() =>
                              setSelected((cur) => cur.filter((o) => o !== s))
                            }
                            className="text-fg-faint hover:text-fg"
                            aria-label={t(locale, "common.cancel")}
                          >
                            ×
                          </button>
                        </span>
                      ))}
                  </div>
                )}
            </div>
          )}
          <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
            {!disabled && (
              <button
                type="button"
                onClick={onDismiss}
                className="min-h-8 rounded-md bg-accent-3 px-3 text-xs font-medium text-bg transition-colors hover:bg-accent-3/85 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-3"
                title={t(locale, "interaction.skipTitle")}
              >
                {t(locale, "common.cancel")}
              </button>
            )}
            {!active && (
              <span className="mr-auto font-mono text-[10px] text-fg-faint">
                {t(locale, "interaction.ended")}
              </span>
            )}
            {req.multi && (
              <button
                type="button"
                disabled={disabled || !canSubmitSelect}
                onClick={submitSelect}
                className="min-h-8 rounded-md bg-fg px-3 text-xs font-medium text-bg transition-colors hover:bg-fg-dim disabled:cursor-not-allowed disabled:opacity-40"
              >
                {t(locale, "interaction.submit")}
              </button>
            )}
          </div>
        </div>
      )}

      {req.type === "input" && (
        <div className="flex flex-col gap-2">
          {req.multiline ? (
            <textarea
              value={text}
              disabled={disabled}
              onChange={(e) => setText(e.target.value)}
              onPaste={handleImagePaste}
              placeholder={
                req.placeholder ?? t(locale, "interaction.inputPlaceholder")
              }
              rows={3}
              className="min-h-[92px] resize-none rounded-md border border-border bg-bg p-2.5 text-sm text-fg outline-none transition-colors placeholder:text-fg-faint focus:border-accent focus:ring-1 focus:ring-accent disabled:cursor-not-allowed disabled:opacity-50"
            />
          ) : (
            <input
              value={text}
              disabled={disabled}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && text.trim()) {
                  e.preventDefault();
                  submitInput();
                }
              }}
              onPaste={handleImagePaste}
              placeholder={
                req.placeholder ?? t(locale, "interaction.inputPlaceholder")
              }
              className="min-h-10 rounded-md border border-border bg-bg px-2.5 py-1.5 text-sm text-fg outline-none transition-colors placeholder:text-fg-faint focus:border-accent focus:ring-1 focus:ring-accent disabled:cursor-not-allowed disabled:opacity-50"
            />
          )}
          <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
            {!disabled && (
              <button
                type="button"
                onClick={onDismiss}
                className="min-h-8 rounded-md border border-transparent px-2.5 text-xs text-fg-faint transition-colors hover:border-border hover:bg-panel-2 hover:text-fg-dim focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                title={t(locale, "interaction.skipTitle")}
              >
                {t(locale, "interaction.skip")}
              </button>
            )}
            {!active && (
              <span className="mr-auto font-mono text-[10px] text-fg-faint">
                {t(locale, "interaction.ended")}
              </span>
            )}
            <button
              type="button"
              disabled={disabled || !trimmedText}
              onClick={submitInput}
              className="min-h-8 rounded-md bg-fg px-3 text-xs font-medium text-bg transition-colors hover:bg-fg-dim disabled:cursor-not-allowed disabled:opacity-40"
            >
              {t(locale, "interaction.submit")}
            </button>
          </div>
        </div>
      )}

      {req.type === "confirm" && (
        <div className="flex flex-col gap-2">
          <div className="rounded-md border border-border bg-panel-2 px-3 py-2 text-xs leading-relaxed text-fg-faint">
            {t(locale, "interaction.confirmHint")}
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {!disabled && (
              <button
                type="button"
                onClick={onDismiss}
                className="min-h-8 rounded-md border border-transparent px-2.5 text-xs text-fg-faint transition-colors hover:border-border hover:bg-panel-2 hover:text-fg-dim focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                title={t(locale, "interaction.skipTitle")}
              >
                {t(locale, "interaction.skip")}
              </button>
            )}
            {!active && (
              <span className="mr-auto font-mono text-[10px] text-fg-faint">
                {t(locale, "interaction.ended")}
              </span>
            )}
            <button
              type="button"
              disabled={disabled}
              onClick={() => onAnswer({ kind: "confirm", confirmed: false })}
              className="min-h-8 rounded-md border border-border bg-panel-2 px-3 text-xs text-fg-dim transition-colors hover:border-accent-3/60 hover:text-accent-3 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {req.cancelLabel ?? t(locale, "common.cancel")}
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onAnswer({ kind: "confirm", confirmed: true })}
              className="min-h-8 rounded-md bg-fg px-3 text-xs font-medium text-bg transition-colors hover:bg-fg-dim disabled:cursor-not-allowed disabled:opacity-40"
            >
              {req.confirmLabel ?? t(locale, "interaction.confirm")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * CONTRACT: default export, no props. Bottom-center AI interaction dock.
 *
 * Left : AI return stream (messages from the store).
 * Right: AI input box. The configured send shortcut calls store.sendPrompt;
 *        the configured newline shortcut inserts a line break.
 *
 * The whole dock is vertically resizable: drag the handle on its top edge
 * (cursor becomes row-resize) to change its height; the value is persisted.
 *
 * The split between the two panes is horizontally resizable: drag the vertical
 * divider between them (cursor becomes col-resize) to change the AI-input pane
 * width; the AI-return pane fills the rest. The width is persisted and clamped
 * so neither pane collapses.
 *
 * Mirrors design.html §06 "中 · 主工作区" bottom row (AI 返回 / AI 输入).
 *
 * `layout`:
 *   - 'dock' (default): the bottom dock described above — horizontal split,
 *     top-edge height resize, vertical width-resize divider.
 *   - 'chat': a full-height vertical chat surface used by simple workflows —
 *     AI return on top (fills the height), AI input pinned below. No canvas;
 *     drag the input card's visible top edge to resize the input area.
 */
export default function AIDock({
  layout = "dock",
}: {
  layout?: "dock" | "chat";
} = {}) {
  const isChat = layout === "chat";
  const messages = useStore((s) => s.messages);
  const sendPrompt = useStore((s) => s.sendPrompt);
  const learnSkills = useStore((s) => s.learnSkills);
  const reviewSkillLearningAction = useStore((s) => s.reviewSkillLearningAction);
  const updateSkillLearningState = useStore((s) => s.updateSkillLearningState);
  const handleSkillReviewAction = async (messageId: string, state: SkillReviewState, action: "approve" | "reject" | "rollback", id: string) => {
    const result = await reviewSkillLearningAction(state, action, id);
    if ((["hostId", "workspaceId", "sessionId", "turnId", "runId"] as const).some((key) => result.origin[key] !== state.origin[key])
      || result.origin.cwd !== state.origin.cwd
      || (action !== "rollback" && result.batchId !== state.result?.batchId)) throw new Error("SKILL_RESULT_ORIGIN_MISMATCH");
    await updateSkillLearningState(messageId, { ...state, status: result.status, action, result, error: result.error });
    return result;
  };
  const ensureSessionStartupWorkspace = useStore(
    (s) => s.ensureSessionStartupWorkspace,
  );
  const generateImagePrompt = useStore((s) => s.generateImagePrompt);
  const generateMusicPrompt = useStore((s) => s.generateMusicPrompt);
  const generateThreeDPrompt = useStore((s) => s.generateThreeDPrompt);
  const generateVideoPrompt = useStore((s) => s.generateVideoPrompt);
  const generateAnimationPrompt = useStore((s) => s.generateAnimationPrompt);
  const generateSpeechPrompt = useStore((s) => s.generateSpeechPrompt);
  const generateSpritePrompt = useStore((s) => s.generateSpritePrompt);
  const generateGddPrompt = useStore((s) => s.generateGddPrompt);
  const generateComfyPrompt = useStore((s) => s.generateComfyPrompt);
  const generateWorldPrompt = useStore((s) => s.generateWorldPrompt);
  const generateUiPrompt = useStore((s) => s.generateUiPrompt);
  const generateBlueprintPrompt = useStore((s) => s.generateBlueprintPrompt);
  const generateMetaHumanPrompt = useStore((s) => s.generateMetaHumanPrompt);
  const searchMeshLibraryPrompt = useStore((s) => s.searchMeshLibraryPrompt);
  const appendChatNote = useStore((s) => s.appendChatNote);
  const newSession = useStore((s) => s.newSession);
  const stopChat = useStore((s) => s.stopChat);
  const blockedSendTip = useStore((s) => s.blockedSendTip);
  const clearBlockedSendTip = useStore((s) => s.clearBlockedSendTip);
  const chatTitle = useStore(activeChatTitle);
  const activeSessionId = useStore((s) => s.activeSessionId);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const renameWorkflowSession = useStore((s) => s.renameWorkflowSession);
  const deleteMessage = useStore((s) => s.deleteMessage);
  const queuedChatMessageIds = useStore((s) => s.queuedChatMessageIds);
  const steerableQueuedChatMessageIds = useStore(
    (s) => s.steerableQueuedChatMessageIds,
  );
  const updateQueuedChatMessage = useStore((s) => s.updateQueuedChatMessage);
  const deleteQueuedChatMessage = useStore((s) => s.deleteQueuedChatMessage);
  const steerQueuedChatMessage = useStore(
    (s) => s.steerQueuedChatMessage,
  );
  const beginQueuedChatMessageEdit = useStore(
    (s) => s.beginQueuedChatMessageEdit,
  );
  const cancelQueuedChatMessageEdit = useStore(
    (s) => s.cancelQueuedChatMessageEdit,
  );
  const branchSessionFromMessage = useStore((s) => s.branchSessionFromMessage);
  const runSelection = useStore(
    (s) => workflowDefaultGatewaySelection(s.workflow),
    shallow,
  );
  const selectedAdapter =
    RUNTIME_ADAPTERS.find((adapter) => adapter.id === runSelection.adapter)
      ?.id ?? RUNTIME_ADAPTERS[0].id;
  const setSessionRunSelection = useStore((s) => s.setSessionRunSelection);
  const composer = useStore((s) => s.composer);
  const draft = useStore((s) => s.composerDraft);
  const generationMode = composerGenerationMode(composer);
  const composerFocusVersion = useStore((s) => s.composerFocusVersion);
  const locale = useStore((s) => s.locale);
  const [shortcutSettings, setShortcutSettingsState] =
    useState(loadShortcutSettings);
  const gameExpertSettings = useStore((s) => s.gameExpertSettings);
  const composerHintRowVisible = useStore((s) => s.composerHintRowVisible);
  // 「提及文件 / 组织架构 / 知识库」三个入口默认隐藏，设置 → 常规 里可打开。
  const composerToolButtonsVisible = useStore(
    (s) => s.composerToolButtonsVisible,
  );
  // 思考深度选择器：默认显示（档位按协议 + 模型族自动判定），可在设置 → 常规
  // 里整体隐藏，或用覆盖文本手写档位集合。
  const thinkingLevelsEnabled = useStore((s) => s.thinkingLevelsEnabled);
  const thinkingLevelOverrides = useStore((s) => s.thinkingLevelOverrides);
  const setComposer = useStore((s) => s.setComposer);
  const setComposerDraft = useStore((s) => s.setComposerDraft);
  const permissionOptions = useStore((s) => s.permissionOptions);
  const composerModelOptions = useStore((s) => s.modelOptions);
  const workspaces = useStore((s) => s.workspaces);
  const activeWorkspacePath = useMemo(
    () =>
      workspaces
        .find((workspace) => workspace.id === activeWorkspaceId)
        ?.path?.trim() ?? "",
    [activeWorkspaceId, workspaces],
  );
  const channelWorkspacePath = composer.workspace.trim() || activeWorkspacePath;
  const activeRemoteWorkspaceId = isRemoteWorkspacePath(channelWorkspacePath)
    ? remoteWorkspaceIdFromPath(channelWorkspacePath)
    : "";
  const activeRemoteWorkspaceRoot = activeRemoteWorkspaceId
    ? channelWorkspacePath
    : "";
  const activeRemoteWorkspaceConfig = activeRemoteWorkspaceId
    ? getRemoteWorkspace(activeRemoteWorkspaceId)
    : null;
  const generationSettingsProfileId = settingsProfileIdForWorkspacePath(
    channelWorkspacePath,
  );
  const generationSettingsProfile = useMemo<SettingsProfileOptions>(
    () => ({ profileId: generationSettingsProfileId }),
    [generationSettingsProfileId],
  );
  const remoteGenerationSettings = isRemoteSettingsProfile(
    generationSettingsProfileId,
  );
  const slashGuardChannel = useMemo(
    () => slashGuardChannelForText(draft, composer),
    [composer, draft],
  );
  const generationSettingsNeeded = aidockGenerationSettingsNeeded(
    generationMode,
    slashGuardChannel,
  );
  const activeSlashAdapter = activeRemoteWorkspaceConfig
    ? remoteAdapterToRuntimeAdapter(activeRemoteWorkspaceConfig.adapter)
    : selectedAdapter;
  const mode = useStore((s) => s.mode);
  const activeAiEditing = useStore((s) => isActiveAiEditingSession(s));
  const activeChatting = useStore((s) =>
    s.chattingSessions.some(
      (session) =>
        session.workspaceId === (s.activeWorkspaceId ?? null) &&
        session.sessionId === (s.activeSessionId ?? null),
    ),
  );
  const simpleChatMode = useStore((s) => s.workflow.meta?.simple === true);
  const activeSessionIsWorkflow = useStore((s) => {
    // A workflow is a workflow (not simple chat) if:
    // 1. The active session exists and has isWorkflow: true, OR
    // 2. There's no active session but the workflow has multiple nodes (design mode)
    if (!s.activeSessionId) return false;
    const session = s.sessions.find((sess) => sess.id === s.activeSessionId);
    if (session) return session.isWorkflow;
    // No session found - infer from workflow structure
    // A workflow mode has start -> agent -> end (multiple nodes)
    // A simple chat has just a start node
    return s.workflow.nodes.length > 1;
  });
  const firstStartUserInput = useStore((s) => {
    const startNode = s.workflow.nodes.find((node) => node.type === "start");
    return readStartUserInputs(startNode?.params)[0]?.trim() ?? "";
  });
  const activeChatFavorite = useStore((s) => {
    const sessionId = s.activeSessionId;
    if (!sessionId) return false;
    const activeSession = s.activeWorkspaceId
      ? (s.sessionTree[s.activeWorkspaceId]?.find(
          (session) => session.id === sessionId,
        ) ??
        s.sessions.find(
          (session) =>
            session.id === sessionId &&
            (session.workspaceId == null ||
              session.workspaceId === s.activeWorkspaceId),
        ))
      : s.sessions.find((session) => session.id === sessionId);
    return activeSession?.favorite === true;
  });
  const answerInteraction = useStore((s) => s.answerInteraction);
  const dismissInteraction = useStore((s) => s.dismissInteraction);
  const setInteractionDraft = useStore((s) => s.setInteractionDraft);
  const streamRef = useRef<HTMLDivElement>(null);
  // 中间信息流：滚动条默认隐藏，仅滚动或光标靠近右缘（分割线一侧）时显示。
  useEffect(() => {
    const el = streamRef.current;
    if (!el) return;
    return attachAutoHideScroll(el);
  }, []);
  // The inner message list. We observe its size (not just the scroll
  // container's) so appended messages and streaming tokens — which grow this
  // node while the container keeps its fixed height — still trigger auto-scroll.
  const streamContentRef = useRef<HTMLUListElement>(null);
  // Session long-screenshot (`/screenshot`). While capturing we force every
  // message to render its rich content (off-screen ones are otherwise plain-text
  // placeholders, see LazyMessageContent) so the image is faithful, then restore.
  const [captureStatus, setCaptureStatus] = useState<{
    kind: "busy" | "done" | "error";
    text: string;
  } | null>(null);
  const [forceEagerCapture, setForceEagerCapture] = useState(false);
  const captureInFlightRef = useRef(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const chatTitleInputRef = useRef<HTMLInputElement>(null);
  const chatTitleCommitInFlightRef = useRef(false);
  const skipNextTitleBlurCommitRef = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const inputDropRef = useRef<HTMLDivElement>(null);
  const draftRef = useRef(draft);
  const selectionRef = useRef<TextSelection>({ start: 0, end: 0 });
  const slashTriggerRef = useRef<SlashTrigger | null>(null);
  const gameSkillTriggerRef = useRef<SlashTrigger | null>(null);
  const fileMentionTriggerRef = useRef<FileMentionTrigger | null>(null);
  const fileMentionInsertModeRef =
    useRef<FileMentionInsertMode>("mention");
  const orgMentionTriggerRef = useRef<SlashTrigger | null>(null);
  const orgMentionRef = useRef<HTMLDivElement>(null);
  const lastComposerFocusVersion = useRef(composerFocusVersion);
  const messageRefs = useRef(new Map<string, HTMLLIElement>());
  const activeSearchMatchNodeRef = useRef<HTMLElement | null>(null);
  const searchScrollTopRef = useRef<number | null>(null);
  const lastSearchActiveRef = useRef(false);
  const stickToBottomRef = useRef(true);
  // Key of the session that requested a forced bottom-scroll (via
  // pinActiveStreamToBottom, e.g. right after the user hits send), or null
  // when no such request is pending. Storing the KEY — not a bare boolean —
  // matters because the request may still be in flight (the actual message
  // append can lag a tick behind an async submit) when the user switches to a
  // different session. A bare boolean would get "stolen" by the next
  // `messages.length` change, which fires on ANY session switch (the array
  // swaps to the new session's messages), forcibly bottom-scrolling and
  // clobbering whichever unrelated session happens to be active at that
  // moment. Gating on the key ensures the forced scroll only ever applies to
  // the session that actually asked for it.
  const forceNextMessageBottomRef = useRef<string | null>(null);
  const streamScrollSnapshotsRef = useRef(
    new Map<string, StreamScrollSnapshot>(),
  );
  /**
   * Scroll offsets this component wrote itself: session restore, bottom re-pin
   * and message-window growth compensation. Such a write always produces a
   * scroll event, and by the time the browser delivers it lazy markdown may
   * already have grown the content — so re-deriving `atBottom` from that event
   * reads "the user scrolled away from the bottom" when in fact the viewport
   * never moved by a user gesture. Because that flag is sticky (the restore and
   * the ResizeObserver only re-pin while it is true), one such event used to
   * latch a bottom-pinned conversation as manually scrolled and leave its
   * scrollbar stranded in the middle after switching back to it. Recording the
   * offsets we wrote lets `handleStreamScroll` tell our own writes apart from a
   * genuine user scroll (wheel, drag, keyboard or our smooth jump helpers).
   */
  const programmaticScrollTopsRef = useRef<number[]>([]);
  const markProgrammaticStreamScroll = useCallback(
    (stream: HTMLElement | null, before: number) => {
      if (!stream) return;
      // A write that did not move the viewport generates no scroll event, so
      // remembering it could only ever swallow a later genuine user scroll that
      // happens to land on the same offset.
      if (Math.abs(stream.scrollTop - before) <= 0.5) return;
      const marks = programmaticScrollTopsRef.current;
      marks.push(stream.scrollTop);
      if (marks.length > 8) marks.shift();
    },
    [],
  );
  const activeStreamScrollKey = useMemo(
    () => streamScrollKey(layout, activeWorkspaceId, activeSessionId),
    [activeSessionId, activeWorkspaceId, layout],
  );
  const activeStreamScrollKeyRef = useRef(activeStreamScrollKey);
  if (activeStreamScrollKeyRef.current !== activeStreamScrollKey) {
    // Marks are offsets, and an offset from the previous session must never
    // swallow the new session's first user scroll.
    programmaticScrollTopsRef.current.length = 0;
  }
  activeStreamScrollKeyRef.current = activeStreamScrollKey;
  const pendingStreamScrollRestoreKeyRef = useRef<string | null>(
    activeStreamScrollKey,
  );
  const messageWindowSizesRef = useRef(new Map<string, number>());
  const [messageWindow, setMessageWindow] = useState(() => ({
    key: activeStreamScrollKey,
    size: INITIAL_MESSAGE_WINDOW,
  }));
  const [assetJumpTarget, setAssetJumpTarget] =
    useState<AssetSessionJumpDetail | null>(null);
  const [assetJumpHighlightId, setAssetJumpHighlightId] = useState<
    string | null
  >(null);
  const assetJumpHighlightTimerRef = useRef<number | null>(null);
  const [activeTopicMessageId, setActiveTopicMessageId] = useState<
    string | null
  >(null);
  const [pendingTimelineJumpId, setPendingTimelineJumpId] = useState<
    string | null
  >(null);

  const isReadOnly = mode === "running";
  // Cache TTL is a session-open-time setting: changeable only before the first
  // message lands. Once the conversation has any messages (or the dock is
  // read-only because a run is in flight) the selector locks.
  const cacheTtlLocked = isReadOnly || messages.length > 0;
  // Startup mode (本地 / 新工作树) shares the cache-TTL lock: it only affects how
  // a brand-new session prepares its working directory, so it locks once the
  // conversation starts. Only meaningful for chat/simple sessions with a cwd.
  const startupModeLocked = isReadOnly || messages.length > 0;
  const remoteCacheOptions = useMemo<SelectOption[]>(
    () => [
      {
        id: "remote",
        label: t(locale, "dock.remoteCacheManaged"),
      },
    ],
    [locale],
  );
  const remoteStartupModeOptions = useMemo<SelectOption[]>(
    () => [
      {
        id: "remote",
        label: t(locale, "dock.remoteStartupMode"),
      },
    ],
    [locale],
  );
  const sendShortcutHint = useMemo(
    () =>
      `${describeShortcutBinding(shortcutSettings["composer-send"])} ${t(
        locale,
        "dock.sendShortcutAction",
      )} · ${describeShortcutBinding(
        shortcutSettings["composer-newline"],
      )} ${t(locale, "dock.newlineShortcutAction")}`,
    [locale, shortcutSettings],
  );
  const [dropActive, setDropActive] = useState(false);
  const previewScope = filePreviewScope(composer.workspace);
  const activePreviewId = useFilePreviewTabs((state) => state.activeByScope[previewScope]);
  const showMainPreview = isChat && Boolean(activePreviewId);
  useEffect(() => {
    useFilePreviewTabs.getState().select(previewScope, null);
  }, [activeSessionId, previewScope]);
  const [filePreviewRef, setFilePreviewRef] = useState<FileRef | null>(null);
  const [filePreviewDrawerWidth, setFilePreviewDrawerWidth] = useState(0);
  const [chatVisibleRightInset, setChatVisibleRightInset] = useState(0);
  const [chatTitleEditing, setChatTitleEditing] = useState(false);
  const [chatTitleDraft, setChatTitleDraft] = useState("");
  const [queuedEditMessageId, setQueuedEditMessageId] = useState<string | null>(
    null,
  );
  const [queuedEditDraft, setQueuedEditDraft] = useState("");
  const [chatTitleSaving, setChatTitleSaving] = useState(false);
  // The organization chart is no longer a top tab beside the stream; it pops up
  // from a `$组织架构` trigger at the input bottom and collapses on outside click.
  const [orgPanelOpen, setOrgPanelOpen] = useState(false);
  // When locked, the organization popup ignores outside clicks and Escape, so it
  // only closes via its explicit close button.
  const [orgPanelLocked, setOrgPanelLocked] = useState(false);
  // New-session layout: in the chat surface, before any message lands, the input
  // box floats in the vertical center. Opening the organization chart promotes
  // it back to the normal bottom composer so the popup never covers the input.
  const centerInput = isChat && messages.length === 0 && !orgPanelOpen;
  const [returnSearchOpen, setReturnSearchOpen] = useState(false);
  const [returnSearch, setReturnSearch] = useState("");
  const [activeSearchMatchIndex, setActiveSearchMatchIndex] = useState(0);
  const [slashTrigger, setSlashTrigger] = useState<SlashTrigger | null>(null);
  const [activeSlashIndex, setActiveSlashIndex] = useState(0);
  const [gameSkillTrigger, setGameSkillTrigger] = useState<SlashTrigger | null>(
    null,
  );
  const [activeGameSkillIndex, setActiveGameSkillIndex] = useState(0);
  const [fileMentionTrigger, setFileMentionTrigger] =
    useState<FileMentionTrigger | null>(null);
  const [activeFileMentionIndex, setActiveFileMentionIndex] = useState(0);
  // `$` at a word boundary opens an inline, searchable multi-level tree menu of
  // the organization chart (drill down level by level, then insert the role's
  // command). This is distinct from the bottom `$组织架构` button, which opens
  // the full blueprint popup panel.
  const [orgMentionTrigger, setOrgMentionTrigger] =
    useState<SlashTrigger | null>(null);
  const [activeOrgMentionIndex, setActiveOrgMentionIndex] = useState(0);
  // The branch the inline menu is currently drilled into (null = root level).
  const [orgMentionParentId, setOrgMentionParentId] = useState<string | null>(
    null,
  );
  const [orgDefinition, setOrgDefinition] = useState<GameOrgNodeDefinition>(
    () => loadGameOrgDefinition(),
  );
  const [fileMentionListing, setFileMentionListing] =
    useState<FileMentionListing>({
      status: "idle",
      rootPath: "",
      directory: "",
      entries: [],
    });
  const [slashCatalogEntries, setSlashCatalogEntries] = useState<
    SlashCatalogEntry[]
  >([]);
  // Remote workspaces surface the *remote* project's slash commands / skills
  // (synced once on connect, cached locally), not the local machine catalog.
  const [remoteSlashCatalogEntries, setRemoteSlashCatalogEntries] = useState<
    SlashCatalogEntry[]
  >([]);
  const [modelStrategyOpen, setModelStrategyOpen] = useState(false);
  const [messageActionMenu, setMessageActionMenu] =
    useState<MessageActionMenu>(null);
  const [fileUploadTipText, setFileUploadTipText] = useState("");
  const blockedSendTipText =
    blockedSendTip === "model-switched-while-chatting"
      ? t(locale, "dock.modelSwitchBlockedTip")
      : typeof blockedSendTip === "object" &&
          blockedSendTip?.kind === "slash-command-unavailable"
        ? blockedSendTip.message
        : "";
  const showFileUploadError = useCallback(
    (reason: unknown, remote = false) => {
      const detail =
        reason instanceof Error
          ? reason.message
          : typeof reason === "string"
            ? reason
            : "";
      const prefix = remote
        ? locale.startsWith("zh")
          ? "远程文件上传失败"
          : "Remote file upload failed"
        : locale.startsWith("zh")
          ? "文件处理失败"
          : "File handling failed";
      setFileUploadTipText(detail ? `${prefix}：${detail}` : prefix);
    },
    [locale],
  );
  const uploadedPathsFromResults = useCallback(
    (
      results: PromiseSettledResult<string>[],
      options: { remote?: boolean } = {},
    ): string[] => {
      const failed = firstRejectedResult(results);
      if (failed) showFileUploadError(failed.reason, options.remote);
      return fulfilledSettledValues(results);
    },
    [showFileUploadError],
  );

  useEffect(() => {
    if (!blockedSendTip) return;
    const id = window.setTimeout(() => clearBlockedSendTip(), 3200);
    return () => window.clearTimeout(id);
  }, [blockedSendTip, clearBlockedSendTip]);

  useEffect(() => {
    if (!fileUploadTipText) return;
    const id = window.setTimeout(() => setFileUploadTipText(""), 4000);
    return () => window.clearTimeout(id);
  }, [fileUploadTipText]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    const applyCatalog = (entries: SlashCatalogEntry[] | undefined) => {
      if (cancelled) return;
      const next = entries ?? [];
      setSlashCatalogEntries((current) =>
        current.length === next.length &&
        current.every((entry, index) => entry.id === next[index]?.id)
          ? current
          : next,
      );
    };

    void slashCatalog()
      .then((catalog) => applyCatalog(catalog.entries))
      .catch(() => applyCatalog([]));
    void onSlashCatalogUpdated((catalog) => applyCatalog(catalog.entries))
      .then((dispose) => {
        if (cancelled) dispose();
        else unlisten = dispose;
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Load (and once-per-connect sync) the remote workspace's skill catalog. The
  // `/` menu reads the cached entries; we only hit the network when the cache is
  // empty for this workspace, mirroring how accounts/files sync on connect.
  useEffect(() => {
    if (!activeRemoteWorkspaceId) {
      setRemoteSlashCatalogEntries([]);
      return;
    }
    let cancelled = false;
    const workspaceId = activeRemoteWorkspaceId;
    const apply = () => {
      if (cancelled) return;
      setRemoteSlashCatalogEntries(
        getCachedRemoteWorkspaceSkills(workspaceId) as SlashCatalogEntry[],
      );
    };
    apply();

    const onUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ workspaceId?: string }>).detail;
      if (!detail || detail.workspaceId === workspaceId) apply();
    };
    window.addEventListener(REMOTE_WORKSPACE_SKILLS_UPDATED_EVENT, onUpdated);

    const config = getRemoteWorkspace(workspaceId);
    if (config && getCachedRemoteWorkspaceSkills(workspaceId).length === 0) {
      void refreshRemoteWorkspaceSkills(config).catch(() => undefined);
    }

    return () => {
      cancelled = true;
      window.removeEventListener(
        REMOTE_WORKSPACE_SKILLS_UPDATED_EVENT,
        onUpdated,
      );
    };
  }, [activeRemoteWorkspaceId]);

  useEffect(() => subscribeShortcutSettings(setShortcutSettingsState), []);

  const normalizedSearch = useMemo(
    () => normalizeSearchQuery(returnSearch),
    [returnSearch],
  );
  // Mirrors normalizedSearch in a ref so the ResizeObserver callback (which
  // is stable with [] deps) can read the latest value without stale closure.
  const normalizedSearchRef = useRef(normalizedSearch);
  normalizedSearchRef.current = normalizedSearch;

  const searchMatches = useMemo(
    () => buildSearchMatches(messages, normalizedSearch),
    [messages, normalizedSearch],
  );
  const activeSearchMatch = searchMatches[activeSearchMatchIndex] ?? null;
  const activeSearchMatchId = activeSearchMatch?.id ?? null;
  const activeSearchMatchMessageId = activeSearchMatch?.messageId ?? null;
  const activeSearchMatchSource = activeSearchMatch?.source ?? null;
  const searchMatchMessageIds = useMemo(
    () => new Set(searchMatches.map((match) => match.messageId)),
    [searchMatches],
  );
  const topicMessageIds = useMemo(
    () =>
      messages
        .filter((message) => message.role === "user")
        .map((message) => message.id),
    [messages],
  );
  const timelineMarkers = useMemo(() => {
    const topics = messages
      .map((message, messageIndex) => ({ message, messageIndex }))
      .filter(({ message }) => message.role === "user");
    return topics.map(({ message, messageIndex }, topicIndex) => ({
      id: message.id,
      label: summarizeTimelineText(message.text),
      number: topicIndex + 1,
      position: timelineMarkerTop(topicIndex, topics.length),
      messageIndex,
    }));
  }, [messages]);
  // Remote workspaces use the remote project's catalog (synced + cached); local
  // workspaces use the desktop backend scan. Either way buildSlashSuggestions
  // folds in the app-only static commands, so the only difference is whether the
  // discovered skills come from the remote project or the local machine.
  const activeSlashCatalogEntries = activeRemoteWorkspaceId
    ? remoteSlashCatalogEntries
    : slashCatalogEntries;
  const slashSuggestions = useMemo(
    () => buildSlashSuggestions(activeSlashCatalogEntries, locale),
    [locale, activeSlashCatalogEntries],
  );
  // Game-expert hierarchy entries (root → group → expert), surfaced in the `/`
  // menu only when experts are enabled. They route through the same explicit
  // parser; insertText carries the localized path so it round-trips.
  const gameExpertSuggestions = useMemo<SlashSuggestion[]>(
    () =>
      gameExpertMenuEntries(gameExpertSettings, locale).map((entry) => ({
        id: entry.id,
        kind: "command" as const,
        name: entry.name,
        label: entry.name.slice(1),
        detail: entry.detail,
        insertText: entry.insertText,
        source: "app",
        sourceAdapter: "app" as const,
        searchText:
          `${entry.name} ${entry.detail} ${entry.insertText}`.toLowerCase(),
      })),
    [gameExpertSettings, locale],
  );
  // GameSkill suggestions powering the `#游戏Skill` menu. Always sourced from the
  // GameSkill registry (independent of the backend slash catalog / adapter scope)
  // so the UltraGameStudio-introduced skills get a clean, app-curated surface.
  const gameSkillSuggestions = useMemo(
    () => buildGameSkillSuggestions(locale),
    [locale],
  );
  const filteredGameSkillSuggestions = useMemo(
    () =>
      gameSkillTrigger
        ? filterSlashSuggestions(gameSkillSuggestions, gameSkillTrigger.query)
        : [],
    [gameSkillSuggestions, gameSkillTrigger],
  );
  const fileMentionOptions = useMemo(
    () =>
      fileMentionTrigger
        ? filterFileMentionEntries(
            fileMentionListing.entries,
            fileMentionTrigger.query,
          )
        : [],
    [fileMentionListing.entries, fileMentionTrigger],
  );
  // Resolved organization tree for the inline `$` menu. Root is the team; its
  // `children` form the first level the menu drills through.
  const orgTree = useMemo(
    () => buildGameOrgTree(gameExpertSettings, locale, orgDefinition),
    [gameExpertSettings, locale, orgDefinition],
  );
  const orgNodesFlat = useMemo(() => flattenGameOrgNodes(orgTree), [orgTree]);
  const orgNodeById = useMemo(() => {
    const map = new Map<string, ResolvedGameOrgNode>();
    for (const node of orgNodesFlat) map.set(node.id, node);
    return map;
  }, [orgNodesFlat]);
  const orgSlashSuggestions = useMemo<SlashSuggestion[]>(() => {
    const rootLabel = locale === "zh-CN" ? "组织架构" : "organization";
    return orgNodesFlat
      .filter((node) => node.id !== orgTree.id)
      .flatMap<SlashSuggestion>((node) => {
        const nodeName = `/${rootLabel}/${node.id}`;
        const nodeCommand = (node.commandText ?? "").trim();
        const nodeSearch = orgNodeSearchText(node);
        const roleSuggestion: SlashSuggestion = {
          id: `${ORG_SLASH_SUGGESTION_PREFIX}role:${node.id}`,
          kind: "command",
          name: nodeName,
          label: node.path.join(" / "),
          detail: node.summary || node.role,
          insertText: nodeCommand || nodeName,
          source: rootLabel,
          sourceAdapter: "app",
          searchText:
            `${nodeName} ${nodeSearch} ${nodeCommand}`.toLocaleLowerCase(),
        };
        const skillSuggestions = node.skills.map<SlashSuggestion>((skill) => {
          const skillName = `${nodeName}/${skill.id}`;
          return {
            id: `${ORG_SLASH_SUGGESTION_PREFIX}skill:${node.id}:${skill.id}`,
            kind: "skill",
            name: skillName,
            label: `${node.label} / ${skill.label}`,
            detail: skill.summary,
            insertText: skill.commandText.trim(),
            source: rootLabel,
            sourceAdapter: "app",
            searchText: [
              skillName,
              nodeSearch,
              skill.id,
              skill.label,
              skill.summary,
              skill.prompt,
              skill.commandText,
              skill.protocol.triggerConditions,
              skill.protocol.inputs,
              ...skill.protocol.executionSteps,
              skill.protocol.toolsAndResources,
              skill.protocol.outputs,
              skill.protocol.acceptanceCriteria,
              ...skill.allowedCapabilities,
              ...skill.capabilityLabels,
              ...skill.capabilities.flatMap((capability) => [
                capability.label,
                capability.command,
                capability.useWhen,
                ...capability.intentKeywords,
              ]),
              ...skill.collaboratorLabels,
            ]
              .join(" ")
              .toLocaleLowerCase(),
          };
        });
        return [roleSuggestion, ...skillSuggestions];
      });
  }, [locale, orgNodesFlat, orgTree.id]);
  const activeAdapterSlashSuggestions = useMemo(
    () => [
      ...scopeSlashSuggestionsForAdapter(slashSuggestions, activeSlashAdapter),
      ...gameExpertSuggestions,
      ...orgSlashSuggestions,
    ],
    [
      activeSlashAdapter,
      gameExpertSuggestions,
      orgSlashSuggestions,
      slashSuggestions,
    ],
  );
  const filteredSlashSuggestions = useMemo(
    () =>
      slashTrigger
        ? filterSlashSuggestions(
            activeAdapterSlashSuggestions,
            slashTrigger.query,
          )
        : [],
    [activeAdapterSlashSuggestions, slashTrigger],
  );
  const slashOpen =
    !isReadOnly && slashTrigger !== null && filteredSlashSuggestions.length > 0;
  const gameSkillOpen =
    !isReadOnly &&
    gameSkillTrigger !== null &&
    filteredGameSkillSuggestions.length > 0;
  const fileMentionOpen = !isReadOnly && fileMentionTrigger !== null;
  // The node whose children the menu currently lists (null = root level).
  const orgMentionParent = orgMentionParentId
    ? (orgNodeById.get(orgMentionParentId) ?? null)
    : null;
  const orgMentionQuery = orgMentionTrigger?.query.trim() ?? "";
  const orgMentionOptions = useMemo<OrgMentionOption[]>(() => {
    if (!orgMentionTrigger) return [];
    const query = orgMentionTrigger.query.trim().toLocaleLowerCase();
    // Search mode: flat match across every node, regardless of drill level.
    if (query) {
      return orgNodesFlat
        .filter((node) => node.id !== orgTree.id)
        .filter((node) => orgNodeSearchText(node).includes(query))
        .slice(0, 30)
        .map<OrgMentionOption>((node) => ({
          kind: "node",
          node,
          hasChildren: node.children.length > 0,
        }));
    }
    // Tree-navigation mode: list the current branch's children, with a back row
    // and a self-insert row when drilled past the root.
    const parent = orgMentionParentId
      ? (orgNodeById.get(orgMentionParentId) ?? null)
      : null;
    const levelNodes = parent ? parent.children : orgTree.children;
    const out: OrgMentionOption[] = [];
    if (parent) {
      out.push({ kind: "back" });
      out.push({ kind: "insert-self", node: parent });
    }
    for (const node of levelNodes) {
      out.push({ kind: "node", node, hasChildren: node.children.length > 0 });
    }
    return out;
  }, [
    orgMentionParentId,
    orgMentionTrigger,
    orgNodeById,
    orgNodesFlat,
    orgTree,
  ]);
  const orgMentionOpen =
    !isReadOnly && orgMentionTrigger !== null && orgMentionOptions.length > 0;
  useEffect(() => {
    if (activeOrgMentionIndex < orgMentionOptions.length) return;
    setActiveOrgMentionIndex(0);
  }, [activeOrgMentionIndex, orgMentionOptions.length]);
  useEffect(() => {
    if (activeFileMentionIndex < fileMentionOptions.length) return;
    setActiveFileMentionIndex(0);
  }, [activeFileMentionIndex, fileMentionOptions.length]);
  const firstUserMessageText = useMemo(
    () =>
      messages
        .find((message) => message.role === "user" && message.text.trim())
        ?.text.trim() ?? "",
    [messages],
  );
  const reusableChatText = firstUserMessageText || firstStartUserInput;
  const useChatRunButton = isChat && simpleChatMode;
  const chatRunText =
    useChatRunButton && activeChatFavorite && reusableChatText
      ? reusableChatText
      : draft.trim();
  const chatRunActive = useChatRunButton && activeChatting;
  // Follow-up while a turn is streaming: normal send adds it to the per-session
  // FIFO. Its lightning action may steer it into an active supported CLI turn.
  // With an empty box the button still acts as Stop. Favorite reruns keep
  // Stop-only so an accidental click cannot fire a stale prompt mid-stream.
  const chatFollowUp = chatRunActive && draft.trim().length > 0;
  useEffect(() => {
    if (!chatTitleEditing) setChatTitleDraft(chatTitle);
  }, [chatTitle, chatTitleEditing]);

  useLayoutEffect(() => {
    if (!chatTitleEditing) return;
    const input = chatTitleInputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [chatTitleEditing]);

  const beginChatTitleEdit = useCallback(() => {
    if (!isChat || !activeSessionId || chatTitleSaving) return;
    skipNextTitleBlurCommitRef.current = false;
    setChatTitleDraft(chatTitle);
    setChatTitleEditing(true);
  }, [activeSessionId, chatTitle, chatTitleSaving, isChat]);

  const cancelChatTitleEdit = useCallback(() => {
    skipNextTitleBlurCommitRef.current = true;
    setChatTitleDraft(chatTitle);
    setChatTitleEditing(false);
  }, [chatTitle]);

  const commitChatTitleEdit = useCallback(async () => {
    if (chatTitleCommitInFlightRef.current) return;

    const sessionId = activeSessionId;
    if (!sessionId) {
      setChatTitleEditing(false);
      return;
    }

    const trimmed = chatTitleDraft.trim();
    if (!trimmed || trimmed === chatTitle.trim()) {
      setChatTitleDraft(chatTitle);
      setChatTitleEditing(false);
      return;
    }

    chatTitleCommitInFlightRef.current = true;
    setChatTitleSaving(true);
    try {
      await renameWorkflowSession(
        sessionId,
        activeWorkspaceId ?? null,
        trimmed,
      );
      setChatTitleEditing(false);
    } catch {
      setChatTitleDraft(chatTitle);
    } finally {
      chatTitleCommitInFlightRef.current = false;
      setChatTitleSaving(false);
    }
  }, [
    activeSessionId,
    activeWorkspaceId,
    chatTitle,
    chatTitleDraft,
    renameWorkflowSession,
  ]);

  useEffect(() => {
    if (!queuedEditMessageId) return;
    if (queuedChatMessageIds.includes(queuedEditMessageId)) return;
    setQueuedEditMessageId(null);
    setQueuedEditDraft("");
  }, [queuedChatMessageIds, queuedEditMessageId]);

  const beginQueuedMessageEdit = useCallback(
    (message: Message) => {
      setQueuedEditMessageId(message.id);
      setQueuedEditDraft(message.text);
      beginQueuedChatMessageEdit(message.id);
    },
    [beginQueuedChatMessageEdit],
  );

  const cancelQueuedMessageEdit = useCallback(() => {
    setQueuedEditMessageId(null);
    setQueuedEditDraft("");
    cancelQueuedChatMessageEdit();
  }, [cancelQueuedChatMessageEdit]);

  const commitQueuedMessageEdit = useCallback(
    (messageId: string) => {
      if (!queuedEditDraft.trim()) return;
      if (updateQueuedChatMessage(messageId, queuedEditDraft)) {
        setQueuedEditMessageId(null);
        setQueuedEditDraft("");
      }
    },
    [queuedEditDraft, updateQueuedChatMessage],
  );

  // One bottom "Channel" select owns the active runtime route. The default
  // group mirrors Settings -> Default Channels: each configured provider is a
  // real channel; system CLI entries are only fallbacks for empty categories.
  const [freeChannelRevision, setFreeChannelRevision] = useState(0);
  useEffect(() => {
    const refresh = () => setFreeChannelRevision((n) => n + 1);
    window.addEventListener("ugs:gateway-config-changed", refresh);
    return () =>
      window.removeEventListener("ugs:gateway-config-changed", refresh);
  }, []);
  const [localRuntimeStatuses, setLocalRuntimeStatuses] = useState<
    Record<string, LocalModelRuntimeStatus | undefined>
  >({});
  const defaultChannelProviders = useMemo(() => {
    // Refresh after Settings edits/imports, because provider config is backed
    // by localStorage and surfaced through the gateway-config-changed event.
    void freeChannelRevision;
    const cliRuntime = getCliRuntimeSnapshot();
    const desktop = tauriAvailable();
    // 保持配置（添加）顺序，不做状态/名称重排：用户在设置里刚添加的渠道
    // 就停在该适配器分组的末尾，不会因列表跳动而找不到。
    const providers = listProviders()
      .filter((provider) => {
        // 远程工作区下，listProviders() 已经在远程 profile 下返回该项目
        // /user-settings 里的普通渠道（含 cc-switch 导入并同步过去的渠道），
        // 外加本地缓存的 `remote-runner:` 执行账号。普通渠道要原样保留（用户
        // 在远程项目里同样能选自己导入/同步的渠道），只对 `remote-runner:`
        // 执行账号按工作区做归属过滤，避免别的项目的执行账号串台。
        if (!isRemoteRunnerProvider(provider)) return true;
        return remoteRunnerProviderMatchesWorkspace(
          provider,
          activeRemoteWorkspaceId,
        );
      })
      .map((provider) => {
        const adapter = providerKindToAdapter(provider.kind);
        const runtime = getProviderRuntimeInfo(provider, {
          canUseCliFallback:
            desktop && isCliAdapterAvailable(adapter, cliRuntime),
        });
        return { provider, adapter, status: runtime.status };
      });
    // Collapse providers that render identically in the channel picker. Two
    // entries with the same adapter + name + baseUrl + model (e.g. a stale
    // `direct` copy left beside a cc-switch `cli` import) would otherwise show
    // up as duplicate "default" rows. Keep the first one added.
    const seen = new Set<string>();
    return providers.filter(({ provider, adapter }) => {
      const key = [
        adapter,
        provider.name.trim().toLowerCase(),
        provider.baseUrl.trim().replace(/\/+$/, "").toLowerCase(),
        (provider.model ?? "").trim().toLowerCase(),
      ].join("\0");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [activeRemoteWorkspaceId, freeChannelRevision]);
  // Generation settings only affect generation-mode channel/model selectors and
  // related slash-command guards. Keep normal session switches on cheap defaults;
  // load the real profile after paint only when those controls are needed.
  const [generationSettingsState, setGenerationSettingsState] =
    useState<AIDockGenerationSettingsState>(() =>
      defaultAIDockGenerationSettings(generationSettingsProfileId),
    );
  const fallbackGenerationSettingsState = useMemo(
    () => defaultAIDockGenerationSettings(generationSettingsProfileId),
    [generationSettingsProfileId],
  );
  const activeGenerationSettingsState =
    generationSettingsState.profileId === generationSettingsProfileId
      ? generationSettingsState
      : fallbackGenerationSettingsState;
  const generationSettingsReady =
    activeGenerationSettingsState.loaded &&
    activeGenerationSettingsState.profileId === generationSettingsProfileId;
  const imageSettings = activeGenerationSettingsState.image;
  const musicSettings = activeGenerationSettingsState.music;
  const threeDSettings = activeGenerationSettingsState.threeD;
  const videoSettings = activeGenerationSettingsState.video;
  const animationSettings = activeGenerationSettingsState.animation;
  const speechSettings = activeGenerationSettingsState.speech;

  useEffect(() => {
    if (!generationSettingsNeeded) return;
    let cancelled = false;
    let timer: number | null = null;
    const refresh = () => {
      void (async () => {
        await preloadSettingsProfile(generationSettingsProfileId);
        if (cancelled) return;
        setGenerationSettingsState(
          loadAIDockGenerationSettings(
            generationSettingsProfileId,
            generationSettingsProfile,
          ),
        );
      })();
    };
    timer = window.setTimeout(() => {
      timer = null;
      refresh();
    }, 0);
    for (const eventName of AIDOCK_GENERATION_SETTINGS_EVENTS) {
      window.addEventListener(eventName, refresh);
    }
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
      for (const eventName of AIDOCK_GENERATION_SETTINGS_EVENTS) {
        window.removeEventListener(eventName, refresh);
      }
    };
  }, [
    generationSettingsNeeded,
    generationSettingsProfile,
    generationSettingsProfileId,
  ]);
  const imageChannelOptions = useMemo<SelectOption[]>(
    () =>
      imageProviders(imageSettings)
        .filter((provider) => !remoteGenerationSettings || !provider.local)
        .map((provider) => ({
          id: provider.id,
          label:
            provider.label +
            (imageProviderReady(provider.id, imageSettings) ? "" : " ⚠"),
          hint: t(
            locale,
            provider.category === "commercial"
              ? "settings.imageGeneration.categoryCommercial"
              : "settings.imageGeneration.categoryFreeCredit",
          ),
          group: t(
            locale,
            provider.category === "commercial"
              ? "settings.imageGeneration.commercialProviders"
              : "settings.imageGeneration.freeCreditProviders",
          ),
        })),
    [imageSettings, locale, remoteGenerationSettings],
  );
  const imageChannelValue = imageChannelOptions.some(
    (option) => option.id === imageSettings.preferredProviderId,
  )
    ? imageSettings.preferredProviderId
    : "";
  const imageModelOptions = useMemo<SelectOption[]>(() => {
    const provider = imageProviders(imageSettings).find(
      (item) =>
        item.id === imageSettings.preferredProviderId &&
        (!remoteGenerationSettings || !item.local),
    );
    if (!provider) return [];
    const current = imageProviderModel(provider.id, imageSettings);
    return uniqueModelSelectOptions([
      current,
      ...(imageSettings.providerModelLists[provider.id] ?? []),
      ...provider.models,
    ]);
  }, [imageSettings, remoteGenerationSettings]);
  const imageModelValue = imageProviderModel(
    imageSettings.preferredProviderId,
    imageSettings,
  );
  const onImageChannelChange = useCallback((id: string) => {
    saveImageGenerationSettings({
      ...loadImageGenerationSettings(generationSettingsProfile),
      preferredProviderId: id as ImageProviderId,
    }, generationSettingsProfile);
  }, [generationSettingsProfile]);
  const onImageModelChange = useCallback((model: string) => {
    const selected = model.trim();
    if (!selected) return;
    const current = loadImageGenerationSettings(generationSettingsProfile);
    const providerId = current.preferredProviderId;
    saveImageGenerationSettings({
      ...current,
      providerModels: { ...current.providerModels, [providerId]: selected },
    }, generationSettingsProfile);
  }, [generationSettingsProfile]);
  const musicChannelOptions = useMemo<SelectOption[]>(
    () =>
      MUSIC_PROVIDERS.filter(
        (provider) => !remoteGenerationSettings || !provider.local,
      ).map((provider) => ({
        id: provider.id,
        label:
          provider.label +
          (musicProviderReady(provider.id, musicSettings) ? "" : " ⚠"),
        hint: t(
          locale,
          provider.category === "commercial"
            ? "settings.musicGeneration.categoryCommercial"
            : "settings.musicGeneration.categoryFree",
        ),
        group: t(
          locale,
          provider.category === "commercial"
            ? "settings.musicGeneration.commercialProviders"
            : "settings.musicGeneration.freeProviders",
        ),
      })),
    [musicSettings, locale, remoteGenerationSettings],
  );
  const musicChannelValue = musicChannelOptions.some(
    (option) => option.id === musicSettings.preferredProviderId,
  )
    ? musicSettings.preferredProviderId
    : "";
  const musicModelOptions = useMemo<SelectOption[]>(() => {
    const provider = MUSIC_PROVIDERS.find(
      (item) =>
        item.id === musicSettings.preferredProviderId &&
        (!remoteGenerationSettings || !item.local),
    );
    if (!provider) return [];
    const current = musicProviderModel(provider.id, musicSettings);
    return uniqueModelSelectOptions([current, ...provider.models]);
  }, [musicSettings, remoteGenerationSettings]);
  const musicModelValue = musicProviderModel(
    musicSettings.preferredProviderId,
    musicSettings,
  );
  const onMusicChannelChange = useCallback((id: string) => {
    saveMusicGenerationSettings({
      ...loadMusicGenerationSettings(generationSettingsProfile),
      preferredProviderId: id as MusicProviderId,
    }, generationSettingsProfile);
  }, [generationSettingsProfile]);
  const onMusicModelChange = useCallback((model: string) => {
    const selected = model.trim();
    if (!selected) return;
    const current = loadMusicGenerationSettings(generationSettingsProfile);
    const providerId = current.preferredProviderId;
    saveMusicGenerationSettings({
      ...current,
      providerModels: { ...current.providerModels, [providerId]: selected },
    }, generationSettingsProfile);
  }, [generationSettingsProfile]);
  const threeDChannelOptions = useMemo<SelectOption[]>(
    () =>
      THREE_D_PROVIDERS.filter(
        (provider) => !remoteGenerationSettings || !provider.local,
      ).map((provider) => ({
        id: provider.id,
        label:
          provider.label +
          (threeDProviderReady(provider.id, threeDSettings) ? "" : " ⚠"),
        hint: t(
          locale,
          provider.category === "commercial"
            ? "settings.threeDGeneration.categoryCommercial"
            : "settings.threeDGeneration.categoryFree",
        ),
        group: t(
          locale,
          provider.category === "commercial"
            ? "settings.threeDGeneration.commercialProviders"
            : "settings.threeDGeneration.freeProviders",
        ),
      })),
    [threeDSettings, locale, remoteGenerationSettings],
  );
  const threeDChannelValue = threeDChannelOptions.some(
    (option) => option.id === threeDSettings.preferredProviderId,
  )
    ? threeDSettings.preferredProviderId
    : "";
  const threeDModelOptions = useMemo<SelectOption[]>(() => {
    const provider = THREE_D_PROVIDERS.find(
      (item) =>
        item.id === threeDSettings.preferredProviderId &&
        (!remoteGenerationSettings || !item.local),
    );
    if (!provider) return [];
    const current = threeDProviderModel(provider.id, threeDSettings);
    return uniqueModelSelectOptions([current, ...provider.models]);
  }, [threeDSettings, remoteGenerationSettings]);
  const threeDModelValue = threeDProviderModel(
    threeDSettings.preferredProviderId,
    threeDSettings,
  );
  const onThreeDChannelChange = useCallback((id: string) => {
    saveThreeDGenerationSettings({
      ...loadThreeDGenerationSettings(generationSettingsProfile),
      preferredProviderId: id as ThreeDProviderId,
    }, generationSettingsProfile);
  }, [generationSettingsProfile]);
  const onThreeDModelChange = useCallback((model: string) => {
    const selected = model.trim();
    if (!selected) return;
    const current = loadThreeDGenerationSettings(generationSettingsProfile);
    const providerId = current.preferredProviderId;
    saveThreeDGenerationSettings({
      ...current,
      providerModels: { ...current.providerModels, [providerId]: selected },
    }, generationSettingsProfile);
  }, [generationSettingsProfile]);
  const videoChannelOptions = useMemo<SelectOption[]>(
    () =>
      VIDEO_PROVIDERS.filter(
        (provider) => !remoteGenerationSettings || !provider.local,
      ).map((provider) => ({
        id: provider.id,
        label:
          provider.label +
          (videoProviderReady(provider.id, videoSettings) ? "" : " ⚠"),
        hint: t(
          locale,
          provider.category === "commercial"
            ? "settings.videoGeneration.categoryCommercial"
            : "settings.videoGeneration.categoryFree",
        ),
        group: t(
          locale,
          provider.category === "commercial"
            ? "settings.videoGeneration.commercialProviders"
            : "settings.videoGeneration.freeProviders",
        ),
      })),
    [videoSettings, locale, remoteGenerationSettings],
  );
  const videoChannelValue = videoChannelOptions.some(
    (option) => option.id === videoSettings.preferredProviderId,
  )
    ? videoSettings.preferredProviderId
    : "";
  const videoModelOptions = useMemo<SelectOption[]>(() => {
    const provider = VIDEO_PROVIDERS.find(
      (item) =>
        item.id === videoSettings.preferredProviderId &&
        (!remoteGenerationSettings || !item.local),
    );
    if (!provider) return [];
    const current = videoProviderModel(provider.id, videoSettings);
    return uniqueModelSelectOptions([current, ...provider.models]);
  }, [videoSettings, remoteGenerationSettings]);
  const videoModelValue = videoProviderModel(
    videoSettings.preferredProviderId,
    videoSettings,
  );
  const onVideoChannelChange = useCallback((id: string) => {
    saveVideoGenerationSettings({
      ...loadVideoGenerationSettings(generationSettingsProfile),
      preferredProviderId: id as VideoProviderId,
    }, generationSettingsProfile);
  }, [generationSettingsProfile]);
  const onVideoModelChange = useCallback((model: string) => {
    const selected = model.trim();
    if (!selected) return;
    const current = loadVideoGenerationSettings(generationSettingsProfile);
    const providerId = current.preferredProviderId;
    saveVideoGenerationSettings({
      ...current,
      providerModels: { ...current.providerModels, [providerId]: selected },
    }, generationSettingsProfile);
  }, [generationSettingsProfile]);
  const animationChannelOptions = useMemo<SelectOption[]>(
    () =>
      animationProviders()
        .filter((provider) => !remoteGenerationSettings || !provider.local)
        .map((provider) => ({
          id: provider.id,
          label:
            provider.label +
            (animationProviderReady(provider.id, animationSettings) ? "" : " ⚠"),
          hint: t(
            locale,
            provider.category === "library"
              ? "settings.animationGeneration.categoryLibrary"
              : provider.category === "ai"
                ? "settings.animationGeneration.categoryAi"
                : "settings.animationGeneration.categoryLocal",
          ),
          group: t(
            locale,
            provider.category === "library"
              ? "settings.animationGeneration.libraryProviders"
              : provider.category === "ai"
                ? "settings.animationGeneration.aiProviders"
                : "settings.animationGeneration.localProviders",
          ),
        })),
    [animationSettings, locale, remoteGenerationSettings],
  );
  const animationChannelValue = animationChannelOptions.some(
    (option) => option.id === animationSettings.preferredProviderId,
  )
    ? animationSettings.preferredProviderId
    : "";
  const animationModelOptions = useMemo<SelectOption[]>(() => {
    const provider = animationProviders().find(
      (item) =>
        item.id === animationSettings.preferredProviderId &&
        (!remoteGenerationSettings || !item.local),
    );
    if (!provider) return [];
    const current = animationProviderModel(provider.id, animationSettings);
    return uniqueModelSelectOptions([
      current,
      ...(animationSettings.providerModelLists[provider.id] ?? []),
      ...provider.models,
    ]);
  }, [animationSettings, remoteGenerationSettings]);
  const animationModelValue = animationProviderModel(
    animationSettings.preferredProviderId,
    animationSettings,
  );
  const onAnimationChannelChange = useCallback((id: string) => {
    saveAnimationGenerationSettings({
      ...loadAnimationGenerationSettings(generationSettingsProfile),
      preferredProviderId: id as AnimationProviderId,
    }, generationSettingsProfile);
  }, [generationSettingsProfile]);
  const onAnimationModelChange = useCallback((model: string) => {
    const selected = model.trim();
    if (!selected) return;
    const current = loadAnimationGenerationSettings(generationSettingsProfile);
    const providerId = current.preferredProviderId;
    saveAnimationGenerationSettings({
      ...current,
      providerModels: { ...current.providerModels, [providerId]: selected },
    }, generationSettingsProfile);
  }, [generationSettingsProfile]);
  const speechChannelOptions = useMemo<SelectOption[]>(
    () =>
      SPEECH_PROVIDERS.filter(
        (provider) => !remoteGenerationSettings || !provider.local,
      ).map((provider) => ({
        id: provider.id,
        label:
          provider.label +
          (speechProviderReady(provider.id, speechSettings) ? "" : " ⚠"),
        hint: t(
          locale,
          provider.category === "commercial"
            ? "settings.speechGeneration.categoryCommercial"
            : "settings.speechGeneration.categoryFree",
        ),
        group: t(
          locale,
          provider.category === "commercial"
            ? "settings.speechGeneration.commercialProviders"
            : "settings.speechGeneration.freeProviders",
        ),
      })),
    [speechSettings, locale, remoteGenerationSettings],
  );
  const speechChannelValue = speechChannelOptions.some(
    (option) => option.id === speechSettings.preferredProviderId,
  )
    ? speechSettings.preferredProviderId
    : "";
  const speechModelOptions = useMemo<SelectOption[]>(() => {
    const provider = SPEECH_PROVIDERS.find(
      (item) =>
        item.id === speechSettings.preferredProviderId &&
        (!remoteGenerationSettings || !item.local),
    );
    if (!provider) return [];
    const current = speechProviderModel(provider.id, speechSettings);
    return uniqueModelSelectOptions([current, ...provider.models]);
  }, [speechSettings, remoteGenerationSettings]);
  const speechModelValue = speechProviderModel(
    speechSettings.preferredProviderId,
    speechSettings,
  );
  const onSpeechChannelChange = useCallback((id: string) => {
    saveSpeechGenerationSettings({
      ...loadSpeechGenerationSettings(generationSettingsProfile),
      preferredProviderId: id as SpeechProviderId,
    }, generationSettingsProfile);
  }, [generationSettingsProfile]);
  const onSpeechModelChange = useCallback((model: string) => {
    const selected = model.trim();
    if (!selected) return;
    const current = loadSpeechGenerationSettings(generationSettingsProfile);
    const providerId = current.preferredProviderId;
    saveSpeechGenerationSettings({
      ...current,
      providerModels: { ...current.providerModels, [providerId]: selected },
    }, generationSettingsProfile);
  }, [generationSettingsProfile]);
  const slashGuardSettings = useMemo<SlashCommandGuardSettings>(
    () => ({
      image: imageSettings,
      music: musicSettings,
      threeD: threeDSettings,
      video: videoSettings,
      animation: animationSettings,
      speech: speechSettings,
    }),
    [
      animationSettings,
      imageSettings,
      musicSettings,
      speechSettings,
      threeDSettings,
      videoSettings,
    ],
  );
  const currentSlashGuard = useMemo(() => {
    let currentSlashGuardSettings = slashGuardSettings;
    if (
      slashChannelNeedsAIDockGenerationSettings(slashGuardChannel) &&
      !generationSettingsReady
    ) {
      const loaded = loadAIDockGenerationSettings(
        generationSettingsProfileId,
        generationSettingsProfile,
      );
      currentSlashGuardSettings = {
        image: loaded.image,
        music: loaded.music,
        threeD: loaded.threeD,
        video: loaded.video,
        animation: loaded.animation,
        speech: loaded.speech,
      };
    }
    return guardSlashCommandText(draft, composer, currentSlashGuardSettings);
  }, [
    composer,
    draft,
    generationSettingsProfile,
    generationSettingsProfileId,
    generationSettingsReady,
    slashGuardChannel,
    slashGuardSettings,
  ]);
  const slashGuardTipText =
    currentSlashGuard && !currentSlashGuard.ok
      ? (currentSlashGuard.message ?? "")
      : "";
  const composerTipText =
    fileUploadTipText || blockedSendTipText || slashGuardTipText;
  const [pinnedChannelIds, setPinnedChannelIds] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem("ugs_pinned_channels_v1");
      if (raw) return JSON.parse(raw) as string[];
    } catch {
      /* ignore */
    }
    return [];
  });
  const toggleChannelPin = (id: string) => {
    setPinnedChannelIds((prev) => {
      const next = prev.includes(id)
        ? prev.filter((x) => x !== id)
        : [...prev, id];
      try {
        localStorage.setItem("ugs_pinned_channels_v1", JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  };
  const channelSelectOptions = useMemo<SelectOption[]>(() => {
    const defaultOptions = RUNTIME_ADAPTERS.flatMap((adapter) => {
      const hint = defaultChannelRuntimeLabel(locale, adapter);
      const group = defaultChannelRuntimeGroup(locale, adapter);
      const providers = defaultChannelProviders.filter(
        (item) => item.adapter === adapter.id,
      );
      // 系统 CLI 条目只是空类别的后备：该渠道已配置账号时不再额外展示
      // 「系统默认」，避免每个渠道都多出一行默认项。
      const entries = providers.map(({ provider }) => ({
        id: defaultProviderOptionId(provider.id),
        label: provider.name.trim() || adapter.label,
        hint,
        group,
      }));
      if (entries.length === 0) {
        entries.unshift({
          id: systemDefaultOptionId(adapter.id),
          label: `${adapter.label} · ${t(locale, "dock.channelSystemDefault")}`,
          hint,
          group,
        });
      }
      return entries;
    });

    const raw: SelectOption[] = [
      ...defaultOptions,
      ...FREE_CHANNELS.map((c) => {
        const localStatus = c.local ? localRuntimeStatuses[c.id] : undefined;
        const ready = freeChannelReady(c.id);
        const needsAttention =
          !ready || (c.local && localStatus && !localStatus.ready);
        const hint = c.local
          ? localStatus?.ready
            ? t(locale, "settings.freeChannels.localReady")
            : ready
              ? t(locale, "settings.freeChannels.localConfigured")
              : t(locale, "settings.freeChannels.localNeedsSetup")
          : ready
            ? t(locale, "settings.freeChannels.ready")
            : t(locale, "settings.freeChannels.needsKey");
        return {
          id: freeChannelOptionId(c.id),
          label: c.label + (needsAttention ? " ⚠" : ""),
          hint,
          group: t(locale, "dock.channelGroupFree"),
        };
      }),
    ];
    // 组内置顶：已锁定的渠道提到各自分组顶部，组间顺序保持首现顺序。
    const pinned = new Set(pinnedChannelIds);
    const buckets: SelectOption[][] = [];
    const bucketIndex = new Map<string, number>();
    for (const opt of raw) {
      const g = opt.group ?? "";
      let idx = bucketIndex.get(g);
      if (idx === undefined) {
        idx = buckets.length;
        buckets.push([]);
        bucketIndex.set(g, idx);
      }
      buckets[idx].push(opt);
    }
    return buckets.flatMap((items) => {
      const sorted = [...items];
      sorted.sort((a, b) => {
        const pa = pinned.has(a.id) ? 0 : 1;
        const pb = pinned.has(b.id) ? 0 : 1;
        return pa - pb;
      });
      return sorted;
    });
  }, [locale, defaultChannelProviders, localRuntimeStatuses, pinnedChannelIds]);
  const selectedFreeChannelId = isFreeChannelSelection(runSelection);
  const pinnedDefaultProvider = runSelection.providerId
    ? defaultChannelProviders.find(
        (item) =>
          item.provider.id === runSelection.providerId &&
          item.adapter === selectedAdapter,
      )
    : undefined;
  // 渠道已配置账号时下拉里不再展示「系统默认」条目；若当前 selection 仍停
  // 留在系统默认（例如刚配置好账号还没选过），显示层回退到该渠道第一个
  // 账号，避免触发按钮显示原始 id 字符串。
  const adapterProviderEntry = defaultChannelProviders.find(
    (item) => item.adapter === selectedAdapter,
  );
  const channelSelectValue = selectedFreeChannelId
    ? freeChannelOptionId(selectedFreeChannelId)
    : pinnedDefaultProvider
      ? defaultProviderOptionId(pinnedDefaultProvider.provider.id)
      : adapterProviderEntry
        ? defaultProviderOptionId(adapterProviderEntry.provider.id)
        : systemDefaultOptionId(selectedAdapter);
  const selectedFreeChannel = selectedFreeChannelId
    ? freeChannelById(selectedFreeChannelId)
    : undefined;
  const selectedDefaultProvider = selectedFreeChannel
    ? undefined
    : pinnedDefaultProvider;
  useEffect(() => {
    const providerId = runSelection.providerId;
    if (!providerId) return;
    const remote = parseRemoteProviderId(providerId);
    if (remote && remote.workspaceId !== activeRemoteWorkspaceId) {
      setSessionRunSelection(systemDefaultGatewaySelection(runSelection.adapter));
      return;
    }
    const provider = listProviders().find((item) => item.id === providerId);
    if (
      activeRemoteWorkspaceId &&
      provider &&
      !isRemoteRunnerProvider(provider)
    ) {
      setSessionRunSelection(systemDefaultGatewaySelection(runSelection.adapter));
      return;
    }
    if (
      provider &&
      isRemoteRunnerProvider(provider) &&
      !remoteRunnerProviderMatchesWorkspace(provider, activeRemoteWorkspaceId)
    ) {
      setSessionRunSelection(systemDefaultGatewaySelection(runSelection.adapter));
    }
  }, [
    activeRemoteWorkspaceId,
    freeChannelRevision,
    runSelection.adapter,
    runSelection.providerId,
    setSessionRunSelection,
  ]);
  useEffect(() => {
    if (!simpleChatMode || !activeRemoteWorkspaceId) return;
    const currentRemote = parseRemoteProviderId(runSelection.providerId);
    const config = getRemoteWorkspace(activeRemoteWorkspaceId);
    if (!config) return;
    if (currentRemote?.workspaceId === activeRemoteWorkspaceId) {
      // Only stamp the project's default model when it's compatible with the
      // selected account's adapter family. A Claude-family default (e.g.
      // claude-opus-4-8) must never be forced onto a Codex/Gemini account —
      // doing so showed "claude-opus-4-8" under a Codex channel.
      const projectModel = remoteModelForAdapter(
        selectedAdapter === "claude-code",
        config.model,
      );
      if (!projectModel) return;
      const currentModel =
        runSelection.modelOverride?.trim() || runSelection.modelClass?.trim();
      const currentOverride = runSelection.modelOverride?.trim();
      if (
        currentModel?.toLowerCase() === projectModel.toLowerCase() &&
        currentOverride?.toLowerCase() === projectModel.toLowerCase()
      ) {
        return;
      }
      setSessionRunSelection({
        ...runSelection,
        modelClass: projectModel,
        modelOverride: projectModel,
      });
      return;
    }

    let disposed = false;
    const applyRemoteSelection = (providers: Provider[]) => {
      if (disposed) return;
      const targetAdapter = remoteAdapterToRuntimeAdapter(config.adapter);
      // Bind only to an account that matches the project's configured agent.
      // When the project agent has no account on this runner, stay on that
      // agent's system default instead of hijacking to a mismatched account
      // (e.g. forcing Codex when the project is configured for Claude).
      const provider = providers.find(
        (item) => providerKindToAdapter(item.kind) === targetAdapter,
      );
      if (provider) {
        const providerAdapter = providerKindToAdapter(provider.kind);
        // Strip a Claude-family project model when binding a non-Claude account.
        const model = remoteModelForAdapter(
          providerAdapter === "claude-code",
          config.model,
        );
        setSessionRunSelection(providerSelection(provider, model));
        return;
      }
      const model = remoteModelForAdapter(
        targetAdapter === "claude-code",
        config.model,
      );
      setSessionRunSelection({
        ...systemDefaultGatewaySelection(targetAdapter),
        ...(model ? { modelClass: model, modelOverride: model } : {}),
      });
    };

    const currentProviders = listProviders().filter((provider) =>
      remoteRunnerProviderMatchesWorkspace(provider, activeRemoteWorkspaceId),
    );
    if (currentProviders.length > 0) {
      applyRemoteSelection(currentProviders);
      return;
    }

    void refreshRemoteWorkspaceAccounts(config)
      .then(applyRemoteSelection)
      .catch(() => applyRemoteSelection([]));
    return () => {
      disposed = true;
    };
  }, [
    activeRemoteWorkspaceId,
    freeChannelRevision,
    runSelection.modelClass,
    runSelection.modelOverride,
    runSelection.providerId,
    selectedAdapter,
    setSessionRunSelection,
    simpleChatMode,
  ]);
  const [modelListRevision, setModelListRevision] = useState(0);
  const [loadingChannelModels, setLoadingChannelModels] = useState(false);
  useEffect(() => {
    const refresh = () => setModelListRevision((n) => n + 1);
    window.addEventListener("ugs:model-list-changed", refresh);
    return () => window.removeEventListener("ugs:model-list-changed", refresh);
  }, []);
  useEffect(() => {
    if (!selectedFreeChannel) return;
    if (!canRefreshFreeChannelModels(selectedFreeChannel)) return;
    let disposed = false;
    setLoadingChannelModels(true);
    void refreshFreeChannelModels(selectedFreeChannel)
      .catch(() => undefined)
      .finally(() => {
        if (!disposed) setLoadingChannelModels(false);
      });
    return () => {
      disposed = true;
    };
  }, [selectedFreeChannel, freeChannelRevision]);
  useEffect(() => {
    if (selectedFreeChannel || !selectedDefaultProvider) return;
    let disposed = false;
    setLoadingChannelModels(true);
    void refreshProviderModels(selectedDefaultProvider.provider)
      .catch(() => undefined)
      .finally(() => {
        if (!disposed) setLoadingChannelModels(false);
      });
    return () => {
      disposed = true;
    };
  }, [
    selectedFreeChannel,
    selectedDefaultProvider,
    selectedDefaultProvider?.provider.id,
    selectedDefaultProvider?.provider.apiKey,
    selectedDefaultProvider?.provider.baseUrl,
    selectedDefaultProvider?.provider.model,
  ]);
  const modelSelectOptions = useMemo<SelectOption[]>(() => {
    void modelListRevision;
    const defaultModelOption = {
      id: "default",
      label: t(locale, "dock.channelSystemDefault"),
    };
    if (selectedFreeChannel) {
      const options = uniqueModelSelectOptions([
        runSelection.modelOverride,
        ...freeChannelModelOptions(selectedFreeChannel),
      ]);
      return options.length > 0 ? options : [defaultModelOption];
    }
    if (selectedDefaultProvider) {
      const provider = selectedDefaultProvider.provider;
      const fallback =
        selectedDefaultProvider.adapter === "claude-code"
          ? [
              runSelection.modelOverride,
              runSelection.modelClass,
              ...composerModelOptions.map((option) => option.id),
              "sonnet",
              "opus",
              "haiku",
            ]
          : ["default", runSelection.modelOverride, runSelection.modelClass];
      return uniqueModelSelectOptions([
        provider.model ?? "",
        ...providerModelOptions(provider),
        ...fallback,
      ]);
    }
    if (selectedAdapter === "claude-code") {
      return uniqueModelSelectOptions([
        runSelection.modelClass,
        ...composerModelOptions.map((option) => option.id),
        "sonnet",
        "opus",
        "haiku",
      ]);
    }
    return uniqueModelSelectOptions(["default", runSelection.modelClass]);
  }, [
    locale,
    selectedFreeChannel,
    selectedDefaultProvider,
    selectedAdapter,
    runSelection.modelOverride,
    runSelection.modelClass,
    composerModelOptions,
    modelListRevision,
  ]);
  const modelSelectValue = selectedFreeChannel
    ? selectedFreeChannel.id === FREE_CHANNEL_AUTO_ID
      ? (runSelection.modelOverride ??
          getFreeChannelModelOverride(selectedFreeChannel.id)) ||
        FREE_CHANNEL_AUTO_MODEL
      : (runSelection.modelOverride ??
        (runSelection.modelClass === "default"
          ? "default"
          : getFreeChannelModel(selectedFreeChannel.id) || "default"))
    : selectedDefaultProvider
      ? (runSelection.modelOverride ??
        providerDisplayModel(
          runSelection.modelClass,
          selectedDefaultProvider.provider,
        ))
      : runSelection.modelClass || "default";
  // 思考深度档位由 `thinkingLevelOptions` 按「协议通道 + 模型族」给出，只列出
  // 该接口真正支持的等级：claude-code 5 档、codex 6 档、DeepSeek 官方 4 档、
  // 第三方兼容网关按模型族（deepseek / claude / gpt-5 / gemini / grok / qwen /
  // glm …）各取其真实档位，未识别模型给通用三档。明确不推理的模型返回空数组。
  //
  // 「默认（不指定）」不是一句含糊的「用渠道默认」：`thinkingDefault` 会算出
  // 它真正等价于哪一档（claude CLI 按模型目录的 `default_effort` 实测值），
  // 能判定就在该档位上打「模型默认档」标记，判不了就把原因写明（CLI 自定 /
  // 网关默认不推理 / 端点自定），避免用户对着「默认」猜。
  const thinkingUi = useMemo<{
    options: SelectOption[];
    defaultHint: string;
  }>(() => {
    const provider = selectedDefaultProvider?.provider;
    const model =
      runSelection.modelOverride ??
      (provider
        ? providerDisplayModel(runSelection.modelClass, provider)
        : runSelection.modelClass);
    // 直连渠道用真实协议（anthropic / openai-compatible）解析档位，CLI 渠道才
    // 按适配器解析——这样选择器列出的档位与请求真正走的那条通道一致。
    const transport =
      provider?.transport === "direct"
        ? provider?.kind === "anthropic"
          ? "anthropic"
          : "openai-compatible"
        : "cli";
    const source = {
      adapter: selectedAdapter,
      baseUrl: provider?.baseUrl ?? "",
      model,
      transport,
      declaredLevels: declaredLevelsFor(
        model,
        parseThinkingLevelOverrides(thinkingLevelOverrides),
      ),
    };
    const fallback = thinkingDefault(source);
    const levels = thinkingLevelOptions(source);
    const labelById = new Map(
      levels.map((option) => [option.id, t(locale, option.labelKey)]),
    );
    // 默认档必须真的在本次可选集合里，否则不标（换渠道/换模型后可能不再支持）。
    const defaultLevelId =
      fallback.level && labelById.has(fallback.level) ? fallback.level : null;
    const options: SelectOption[] = levels.map((option) => {
      const hint = t(locale, option.hintKey);
      return {
        id: option.id,
        label: t(locale, option.labelKey),
        hint:
          option.id === defaultLevelId
            ? `${t(locale, "dock.thinkingLevelDefaultMark")} · ${hint}`
            : hint,
      };
    });
    const defaultHint = defaultLevelId
      ? `${t(locale, "dock.thinkingDefaultModel")} · ${t(
          locale,
          "dock.thinkingDefaultActual",
        )}${labelById.get(defaultLevelId) ?? defaultLevelId}`
      : t(locale, fallback.hintKey);
    return { options, defaultHint };
  }, [
    locale,
    selectedAdapter,
    selectedDefaultProvider,
    runSelection.modelOverride,
    runSelection.modelClass,
    thinkingLevelOverrides,
  ]);
  // 换渠道/换模型后上一个档位可能不再合法，此时显示「默认」——与实际下发的一致。
  const thinkingValue =
    runSelection.thinkingLevel &&
    thinkingUi.options.some((option) => option.id === runSelection.thinkingLevel)
      ? runSelection.thinkingLevel
      : THINKING_LEVEL_DEFAULT_ID;
  const handleThinkingChange = useCallback(
    (id: string) => {
      setSessionRunSelection({
        ...runSelection,
        thinkingLevel: id === THINKING_LEVEL_DEFAULT_ID ? undefined : id,
      });
    },
    [runSelection, setSessionRunSelection],
  );
  const [keyModalChannel, setKeyModalChannel] = useState<FreeChannel | null>(
    null,
  );
  const [keyModalValue, setKeyModalValue] = useState("");
  const [localSetupChannel, setLocalSetupChannel] =
    useState<FreeChannel | null>(null);
  const [localModelValue, setLocalModelValue] = useState("");
  const [localSetupMessage, setLocalSetupMessage] = useState<string | null>(
    null,
  );
  const [checkingLocalModel, setCheckingLocalModel] = useState(false);

  useEffect(() => {
    if (!tauriAvailable()) return;
    let disposed = false;
    const localChannels = FREE_CHANNELS.filter((channel) => {
      if (!channel.local) return false;
      return getFreeChannelModelOverride(channel.id).length > 0;
    });
    if (localChannels.length === 0) {
      setLocalRuntimeStatuses({});
      return;
    }
    void Promise.all(
      localChannels.map(async (channel) => {
        const model = getFreeChannelModelOverride(channel.id);
        try {
          return [
            channel.id,
            await localModelStatus(channel.id, model),
          ] as const;
        } catch {
          return [channel.id, undefined] as const;
        }
      }),
    ).then((entries) => {
      if (disposed) return;
      setLocalRuntimeStatuses(Object.fromEntries(entries));
    });
    return () => {
      disposed = true;
    };
  }, [freeChannelRevision]);
  const selectFreeChannel = useCallback(
    (channel: FreeChannel) => {
      void ensureFreeProxy();
      setSessionRunSelection(
        freeChannelSelection(channel.id, getFreeChannelModel(channel.id)),
      );
      setKeyModalChannel(null);
      setKeyModalValue("");
      setLocalSetupChannel(null);
      setLocalModelValue("");
      setLocalSetupMessage(null);
    },
    [setSessionRunSelection],
  );
  const onChannelChange = useCallback(
    (id: string) => {
      void (async () => {
        const providerId = providerIdFromDefaultOption(id);
        if (providerId) {
          const provider = defaultChannelProviders.find(
            (item) => item.provider.id === providerId,
          )?.provider;
          if (provider) setSessionRunSelection(providerSelection(provider));
          return;
        }
        const defaultAdapter = adapterFromSystemDefaultOption(id);
        if (defaultAdapter) {
          setSessionRunSelection(systemDefaultGatewaySelection(defaultAdapter));
          return;
        }
        const freeChannelId = freeChannelFromOption(id);
        if (!freeChannelId) return;
        const channel = freeChannelById(freeChannelId);
        if (!channel) return;
        if (channel.local) {
          const model = getFreeChannelModelOverride(freeChannelId);
          if (!model.trim()) {
            setLocalSetupChannel(channel);
            setLocalModelValue(model);
            setLocalSetupMessage(null);
            return;
          }
          if (tauriAvailable()) {
            setCheckingLocalModel(true);
            try {
              const status = await localModelStatus(freeChannelId, model);
              setLocalRuntimeStatuses((prev) => ({
                ...prev,
                [freeChannelId]: status,
              }));
              if (!status.ready) {
                setLocalSetupChannel(channel);
                setLocalModelValue(model);
                setLocalSetupMessage(
                  describeLocalModelStatus(locale, channel, status),
                );
                return;
              }
            } catch (err) {
              const status: LocalModelRuntimeStatus = {
                channelId: freeChannelId,
                configuredModel: model,
                reachable: false,
                ready: false,
                state: "service_unavailable",
                models: [],
                message: err instanceof Error ? err.message : String(err),
              };
              setLocalRuntimeStatuses((prev) => ({
                ...prev,
                [freeChannelId]: status,
              }));
              setLocalSetupChannel(channel);
              setLocalModelValue(model);
              setLocalSetupMessage(
                describeLocalModelStatus(locale, channel, status),
              );
              return;
            } finally {
              setCheckingLocalModel(false);
            }
          }
          selectFreeChannel(channel);
          return;
        }
        const key =
          channel.needsKey && !getFreeChannelKey(freeChannelId)
            ? await loadFreeChannelKeyFromAutoConfig(freeChannelId)
            : getFreeChannelKey(freeChannelId);
        if (channel.needsKey && !key) {
          setKeyModalChannel(channel);
          setKeyModalValue("");
          return;
        }
        selectFreeChannel(channel);
      })();
    },
    [
      defaultChannelProviders,
      locale,
      setSessionRunSelection,
      selectFreeChannel,
    ],
  );
  const onModelChange = useCallback(
    (model: string) => {
      const selectedModel = model.trim();
      if (!selectedModel) return;
      // Always overwrite modelOverride so a stale workflow.meta.gateway.defaults
      // value can never shadow the user's fresh pick. Explicitly clearing when
      // "default" is chosen keeps providerDisplayModel (channel-configured
      // model) as the visible fallback.
      const modelOverride =
        selectedModel === "default" ? undefined : selectedModel;
      if (selectedFreeChannel) {
        void ensureFreeProxy();
        if (selectedFreeChannel.id === FREE_CHANNEL_AUTO_ID) {
          const autoModel =
            selectedModel === "default"
              ? FREE_CHANNEL_AUTO_MODEL
              : selectedModel;
          const autoOverride =
            autoModel === FREE_CHANNEL_AUTO_MODEL ? undefined : autoModel;
          setSessionRunSelection({
            ...freeChannelSelection(selectedFreeChannel.id, autoModel),
            modelOverride: autoOverride,
          });
          return;
        }
        setSessionRunSelection({
          ...freeChannelSelection(selectedFreeChannel.id, selectedModel),
          modelOverride,
        });
        return;
      }
      if (selectedDefaultProvider) {
        const provider = selectedDefaultProvider.provider;
        setSessionRunSelection({
          ...providerSelection(provider, selectedModel),
          modelOverride,
        });
        return;
      }
      setSessionRunSelection({
        ...systemDefaultGatewaySelection(selectedAdapter),
        modelClass: selectedModel === "default" ? "default" : selectedModel,
        modelOverride,
      });
    },
    [
      selectedAdapter,
      selectedDefaultProvider,
      selectedFreeChannel,
      setSessionRunSelection,
    ],
  );
  const saveKeyModal = useCallback(() => {
    if (!keyModalChannel) return;
    const key = keyModalValue.trim();
    if (!key) return;
    setFreeChannelKey(keyModalChannel.id, key);
    selectFreeChannel(keyModalChannel);
  }, [keyModalChannel, keyModalValue, selectFreeChannel]);
  const saveLocalModelModal = useCallback(() => {
    if (!localSetupChannel) return;
    const model = localModelValue.trim();
    if (!model) return;
    void (async () => {
      setCheckingLocalModel(true);
      setFreeChannelModel(localSetupChannel.id, model);
      try {
        if (tauriAvailable()) {
          const status = await localModelStatus(localSetupChannel.id, model);
          setLocalRuntimeStatuses((prev) => ({
            ...prev,
            [localSetupChannel.id]: status,
          }));
          if (!status.ready) {
            setLocalSetupMessage(
              describeLocalModelStatus(locale, localSetupChannel, status),
            );
            return;
          }
        }
        selectFreeChannel(localSetupChannel);
      } catch (err) {
        const status: LocalModelRuntimeStatus = {
          channelId: localSetupChannel.id,
          configuredModel: model,
          reachable: false,
          ready: false,
          state: "service_unavailable",
          models: [],
          message: err instanceof Error ? err.message : String(err),
        };
        setLocalRuntimeStatuses((prev) => ({
          ...prev,
          [localSetupChannel.id]: status,
        }));
        setLocalSetupMessage(
          describeLocalModelStatus(locale, localSetupChannel, status),
        );
      } finally {
        setCheckingLocalModel(false);
      }
    })();
  }, [localModelValue, localSetupChannel, locale, selectFreeChannel]);

  const ensureSelectedLocalChannelReady =
    useCallback(async (): Promise<boolean> => {
      const id = isFreeChannelSelection(runSelection);
      if (!id) return true;
      const channel = freeChannelById(id);
      if (!channel?.local) return true;
      const model = getFreeChannelModelOverride(id);
      if (!model.trim()) {
        setLocalSetupChannel(channel);
        setLocalModelValue(model);
        setLocalSetupMessage(null);
        return false;
      }
      if (!tauriAvailable()) return true;
      setCheckingLocalModel(true);
      try {
        const status = await localModelStatus(id, model);
        setLocalRuntimeStatuses((prev) => ({ ...prev, [id]: status }));
        if (status.ready) return true;
        setLocalSetupChannel(channel);
        setLocalModelValue(model);
        setLocalSetupMessage(describeLocalModelStatus(locale, channel, status));
        return false;
      } catch (err) {
        const status: LocalModelRuntimeStatus = {
          channelId: id,
          configuredModel: model,
          reachable: false,
          ready: false,
          state: "service_unavailable",
          models: [],
          message: err instanceof Error ? err.message : String(err),
        };
        setLocalRuntimeStatuses((prev) => ({ ...prev, [id]: status }));
        setLocalSetupChannel(channel);
        setLocalModelValue(model);
        setLocalSetupMessage(describeLocalModelStatus(locale, channel, status));
        return false;
      } finally {
        setCheckingLocalModel(false);
      }
    }, [locale, runSelection]);

  // Open a local file referenced by an AI-message chip in the right preview pane.
  // Paths resolve against the active workspace folder in the Tauri command.
  const workspaceCwd = composer.workspace;
  const sessionFileChanges = useMemo(
    () => collectSessionFileChanges(messages, workspaceCwd || undefined),
    [messages, workspaceCwd],
  );
  const [projectFilePanelOpen, setProjectFilePanelOpen] = useState(false);
  useEffect(() => {
    const onVisibility = (event: Event) => {
      setProjectFilePanelOpen(Boolean((event as CustomEvent<{ open: boolean }>).detail?.open));
    };
    window.addEventListener(PROJECT_RIGHT_PANEL_VISIBILITY_EVENT, onVisibility);
    return () => window.removeEventListener(PROJECT_RIGHT_PANEL_VISIBILITY_EVENT, onVisibility);
  }, []);
  const fileMentionRootFolders = useMemo(
    () => {
      if (activeRemoteWorkspaceRoot) return [activeRemoteWorkspaceRoot];
      return uniqueWorkspaceHistory([
        composer.workspace,
        ...composer.workspaceFolders,
        activeWorkspacePath,
      ]);
    },
    [
      activeRemoteWorkspaceRoot,
      activeWorkspacePath,
      composer.workspace,
      composer.workspaceFolders,
    ],
  );
  const fileMentionRootKey = useMemo(
    () => fileMentionRootFolders.map(workspacePathKey).join("|"),
    [fileMentionRootFolders],
  );
  const fileMentionDirectory = fileMentionTrigger?.directory ?? null;
  const listComposerWorkspaceDirectory = useCallback(
    (
      rootPath: string,
      relativePath = "",
    ): Promise<WorkspaceDirectoryListing> => {
      if (isRemoteWorkspacePath(rootPath)) {
        return listRemoteWorkspaceDirectory(rootPath, relativePath);
      }
      return listWorkspaceDirectory(rootPath, relativePath);
    },
    [],
  );
  const enterBlueprintMode = useCallback(
    (modeArgs: string | null | undefined, prompt: string | undefined) => {
      const currentComposer = useStore.getState().composer;
      const wasBlueprintMode = currentComposer.blueprintMode;
      const startedAt = wasBlueprintMode
        ? (currentComposer.blueprintModeStartedAt ?? Date.now())
        : Date.now();
      setComposer({
        gddMode: false,
        gddModeStartedAt: null,
        imageMode: false,
        imageModeStartedAt: null,
        musicMode: false,
        musicModeStartedAt: null,
        threeDMode: false,
        threeDModeStartedAt: null,
        comfyMode: false,
        comfyModeStartedAt: null,
        videoMode: false,
        videoModeStartedAt: null,
        animationMode: false,
        animationModeStartedAt: null,
        spriteMode: false,
        spriteModeStartedAt: null,
        speechMode: false,
        speechModeStartedAt: null,
        uiMode: false,
        uiModeStartedAt: null,
        metahumanMode: false,
        metahumanModeStartedAt: null,
        worldMode: false,
        worldModeStartedAt: null,
        blueprintMode: true,
        blueprintModeStartedAt: startedAt,
        blueprintModeArgs: modeArgs?.trim() || null,
      });
      if (!wasBlueprintMode) {
        appendChatNote(
          locale === "zh-CN"
            ? "🧩 已进入 UE 蓝图模式 · 之后每条消息会按 Unreal Blueprint 创建、修改、编译和校验处理，发送 /blueprint-mode-end 退出"
            : "🧩 UE Blueprint mode on · every message now targets Unreal Blueprint creation, editing, compilation, and verification; send /blueprint-mode-end to exit",
          "system",
        );
      }
      const firstPrompt = prompt?.trim();
      if (firstPrompt) generateBlueprintPrompt(firstPrompt);
    },
    [appendChatNote, generateBlueprintPrompt, locale, setComposer],
  );

  const requestBlueprintModeInstall = useCallback(
    (rootPath: string, modeArgs: string | null, prompt: string) => {
      appendChatNote(BLUEPRINT_MODE_INSTALL_PROMPT, "assistant", {
        interaction: {
          type: "confirm",
          prompt: BLUEPRINT_MODE_INSTALL_PROMPT,
          confirmLabel: BLUEPRINT_MODE_INSTALL_LABEL,
          cancelLabel: t(locale, "common.cancel"),
        },
        appAction: {
          type: "blueprint-mode-install",
          rootPath,
          modeArgs,
          prompt,
        },
      });
    },
    [appendChatNote, locale],
  );

  const startBlueprintModeFromCommand = useCallback(
    async (payload: string) => {
      const { modeArgs, prompt } = parseBlueprintModeStartPayload(payload);
      const rootPath = (workspaceCwd || activeWorkspacePath).trim();
      if (!rootPath) {
        appendChatNote(
          locale === "zh-CN"
            ? "⚠️ 先选择 Unreal Engine 项目目录，才能检查或安装 BlueprintMode 插件。"
            : "⚠️ Select an Unreal Engine project folder before checking or installing BlueprintMode.",
        );
        return;
      }
      if (!tauriAvailable()) {
        appendChatNote(
          locale === "zh-CN"
            ? "⚠️ BlueprintMode 插件检查和安装需要在桌面应用中运行。"
            : "⚠️ BlueprintMode plugin checks and installation require the desktop app.",
        );
        return;
      }
      try {
        const status = await blueprintModeStatus({ rootPath, targetDir: null });
        if (!status.ok) {
          appendChatNote(
            status.error ||
              (locale === "zh-CN"
                ? "⚠️ 当前工作区无法启用 BlueprintMode。"
                : "⚠️ BlueprintMode cannot be enabled for this workspace."),
          );
          return;
        }
        if (status.installed) {
          enterBlueprintMode(modeArgs, prompt);
          return;
        }
        requestBlueprintModeInstall(rootPath, modeArgs, prompt);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        appendChatNote(
          locale === "zh-CN"
            ? `⚠️ 检查 BlueprintMode 插件失败：${msg}`
            : `⚠️ Failed to check BlueprintMode plugin: ${msg}`,
        );
      }
    },
    [
      activeWorkspacePath,
      appendChatNote,
      enterBlueprintMode,
      locale,
      requestBlueprintModeInstall,
      workspaceCwd,
    ],
  );
  const handleInteractionAnswer = useCallback(
    (message: Message, answer: InteractionAnswer) => {
      answerInteraction(message.id, answer);
      const action = message.appAction;
      if (action?.type !== "blueprint-mode-install") return;
      if (answer.kind !== "confirm" || !answer.confirmed) {
        appendChatNote(
          locale === "zh-CN"
            ? "已取消安装 BlueprintMode，未进入 UE 蓝图模式。"
            : "BlueprintMode installation cancelled; UE Blueprint mode was not enabled.",
          "system",
        );
        return;
      }
      void (async () => {
        appendChatNote(
          locale === "zh-CN"
            ? "正在安装 BlueprintMode 插件…"
            : "Installing BlueprintMode plugin...",
          "system",
        );
        try {
          const result = await blueprintModeInstall({
            rootPath: action.rootPath,
            targetDir: null,
            overwrite: false,
          });
          if (!result.ok) {
            appendChatNote(
              result.error ||
                (locale === "zh-CN"
                  ? "BlueprintMode 插件安装失败。"
                  : "BlueprintMode plugin installation failed."),
            );
            return;
          }
          appendChatNote(
            locale === "zh-CN"
              ? "✅ BlueprintMode 插件已安装；若 Unreal Editor 已打开，请重启后生效。"
              : "✅ BlueprintMode plugin installed; restart Unreal Editor if it is already open.",
            "system",
          );
          enterBlueprintMode(action.modeArgs, action.prompt);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          appendChatNote(
            locale === "zh-CN"
              ? `BlueprintMode 插件安装失败：${msg}`
              : `BlueprintMode plugin installation failed: ${msg}`,
          );
        }
      })();
    },
    [answerInteraction, appendChatNote, enterBlueprintMode, locale],
  );

  const handleInteractionDismiss = useCallback(
    (message: Message) => {
      dismissInteraction(message.id);
      if (message.appAction?.type === "blueprint-mode-install") {
        appendChatNote(
          locale === "zh-CN"
            ? "已取消安装 BlueprintMode，未进入 UE 蓝图模式。"
            : "BlueprintMode installation cancelled; UE Blueprint mode was not enabled.",
          "system",
        );
      }
    },
    [appendChatNote, dismissInteraction, locale],
  );
  useEffect(() => {
    if (fileMentionDirectory === null || isReadOnly) return;

    const targets = fileMentionListTargets(
      fileMentionDirectory,
      fileMentionRootFolders,
    );
    const listingKey = fileMentionListingKey(targets);
    const directory = fileMentionDirectory;
    if (targets.length === 0) {
      setFileMentionListing({
        status: "error",
        rootPath: "",
        directory,
        entries: [],
        message:
          locale === "zh-CN"
            ? "请先选择工作区。"
            : "Please select a workspace first.",
      });
      return;
    }

    let cancelled = false;
    const rootListingPromises = new Map<
      string,
      Promise<WorkspaceDirectoryListing>
    >();
    const rootListingForTarget = (
      target: FileMentionListTarget,
    ): Promise<WorkspaceDirectoryListing> => {
      const cacheKey = workspacePathKey(target.rootPath);
      const cached = rootListingPromises.get(cacheKey);
      if (cached) return cached;
      const promise = listComposerWorkspaceDirectory(target.rootPath, "").catch(
        (err) => {
          rootListingPromises.delete(cacheKey);
          throw err;
        },
      );
      rootListingPromises.set(cacheKey, promise);
      return promise;
    };

    setFileMentionListing((current) => ({
      status: "loading",
      rootPath: listingKey,
      directory,
      entries:
        current.rootPath === listingKey && current.directory === directory
          ? current.entries
          : [],
    }));

    void (async () => {
      if (targets.every((target) => !target.relativePath)) {
        return targets;
      }

      const rootResults = await Promise.allSettled(
        targets.map(async (target) => ({
          target,
          listing: await rootListingForTarget(target),
        })),
      );
      if (cancelled) return [];

      const fulfilled = rootResults.filter(
        (
          result,
        ): result is PromiseFulfilledResult<{
          target: FileMentionListTarget;
          listing: WorkspaceDirectoryListing;
        }> => result.status === "fulfilled",
      );
      const matchingTargets = fulfilled
        .filter(({ value }) => {
          const topLevelDirectory =
            normalizeFileMentionPath(value.target.relativePath)
              .split("/")
              .find(Boolean) ?? "";
          if (!topLevelDirectory) return true;
          return value.listing.entries.some(
            (entry) =>
              entry.kind === "directory" &&
              entry.name.toLowerCase() === topLevelDirectory.toLowerCase(),
          );
        })
        .map(({ value }) => value.target);

      if (matchingTargets.length > 0) {
        return matchingTargets;
      }

      if (fulfilled.length > 0) {
        fileMentionTriggerRef.current = null;
        setFileMentionTrigger(null);
        setActiveFileMentionIndex(0);
        setFileMentionListing({
          status: "idle",
          rootPath: "",
          directory: "",
          entries: [],
        });
        return [];
      }

      const rejected = rootResults.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      throw rejected?.reason ?? new Error("Workspace listing failed");
    })()
      .then((validTargets) => {
        if (cancelled || validTargets.length === 0) return [];
        return Promise.allSettled(
          validTargets.map(async (target) => ({
            target,
            listing:
              target.relativePath === ""
                ? await rootListingForTarget(target)
                : await listComposerWorkspaceDirectory(
                    target.rootPath,
                    target.relativePath,
                  ),
          })),
        );
      })
      .then((results) => {
        if (cancelled || results.length === 0) return;
        const fulfilled = results.filter(
          (
            result,
          ): result is PromiseFulfilledResult<{
            target: FileMentionListTarget;
            listing: Awaited<ReturnType<typeof listWorkspaceDirectory>>;
          }> => result.status === "fulfilled",
        );
        if (fulfilled.length === 0) {
          const rejected = results.find(
            (result): result is PromiseRejectedResult =>
              result.status === "rejected",
          );
          throw rejected?.reason ?? new Error("Workspace listing failed");
        }
        setFileMentionListing({
          status: "ready",
          rootPath: listingKey,
          directory,
          entries: uniqueFileMentionEntries(
            fulfilled.flatMap(({ value }) =>
              value.listing.entries.map((entry) =>
                fileMentionEntryForTarget(entry, value.target),
              ),
            ),
          ),
        });
        setActiveFileMentionIndex(0);
      })
      .catch((err) => {
        if (cancelled) return;
        setFileMentionListing({
          status: "error",
          rootPath: listingKey,
          directory,
          entries: [],
          message: fileMentionErrorMessage(err),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [
    fileMentionDirectory,
    fileMentionRootFolders,
    fileMentionRootKey,
    isReadOnly,
    listComposerWorkspaceDirectory,
    locale,
  ]);

  const onOpenFile = useCallback(
    (ref: FileRef, intent?: OpenFileIntent) => {
      if (activeRemoteWorkspaceRoot) return;
      if (intent?.reveal) {
        void openLocalPath(ref.path, {
          cwd: workspaceCwd || undefined,
          reveal: true,
        });
        return;
      }
      if (intent?.openContainingFolder) {
        // Jump to the folder itself rather than selecting the file inside it.
        // A bare filename has no parent of its own, so fall back to the
        // workspace root; when neither exists there is nothing to open.
        const parent = parentDirectoryPath(ref.path) || workspaceCwd;
        if (!parent) return;
        void openLocalPath(parent, { cwd: workspaceCwd || undefined });
        return;
      }
      if (
        requestProjectRightPanelFilePreview({
          ref,
          cwd: workspaceCwd || undefined,
        })
      ) {
        setFilePreviewRef(null);
        return;
      }
      setFilePreviewRef(ref);
    },
    [activeRemoteWorkspaceRoot, workspaceCwd],
  );

  // Image paths typed or pasted into the composer are just plain text
  // inside the <textarea>, so they can't be clicked the way chips in a sent
  // message can. Scan the draft for image refs and surface them as a
  // thumbnail-only strip below the input: one horizontal, scrollable row —
  // a pasted screenshot path is ~90 chars, so rendering the path text next to
  // each thumbnail stacked the strip into one image per row and filled the
  // card. The tile still opens the preview drawer; its x removes the path.
  const draftFileRefs = useMemo<FileRef[]>(() => {
    const text = draft.trim();
    if (!text) return [];
    const refs: FileRef[] = [];
    const seen = new Set<string>();
    for (const part of scanFileRefs(text)) {
      if (typeof part === "string") continue;
      if (!isImageFileRef(part)) continue;
      const key = displayFileRefLabel(part, workspaceCwd);
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push(part);
    }
    return refs;
  }, [draft, workspaceCwd]);

  // Heuristic "live bubble": the last assistant message is streaming while the
  // AI is editing or a run is in flight. Drives streaming-safe markdown repair
  // and in-progress reasoning rendering.
  const lastAssistantId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") return messages[i].id;
    }
    return null;
  }, [messages]);
  // The tail of the list is what's visible at the bottom on session switch, so
  // those messages render their (expensive) markdown eagerly to keep the initial
  // view correct and scroll-to-bottom precise. Everything above upgrades lazily
  // as it scrolls into view (see LazyMessageContent), so opening a long history
  // no longer parses every message's markdown in one blocking commit.
  const eagerMessageIds = useMemo(() => {
    const ids = new Set<string>();
    for (
      let i = Math.max(0, messages.length - EAGER_MESSAGE_TAIL);
      i < messages.length;
      i++
    ) {
      ids.add(messages[i].id);
    }
    return ids;
  }, [messages]);
  const renderFullMessageList =
    forceEagerCapture || normalizedSearch.length > 0;
  // Display-only ordering: chronological replies, interjections above their
  // target reply, and pending prompts at the tail in FIFO order. Queue changes
  // must rerender even when messages are unchanged. Store/history stay intact.
  const displayMessages = useMemo(() => {
    const visible = messages.filter((message) =>
      !message.skillLearning || isSkillReviewVisible(message.skillLearning) || message.text.trim().length > 0,
    );
    return orderDisplayMessages(
      visible.length === messages.length ? messages : visible,
      queuedChatMessageIds,
    );
  }, [messages, queuedChatMessageIds]);
  const taskProgress = useMemo(() => collectChatTaskProgress(messages.filter(
    (message) => !queuedChatMessageIds.includes(message.id),
  )), [messages, queuedChatMessageIds]);
  const jobDetails = useStore((s) => s.jobDetails);
  const currentJobs = useMemo(() => jobDetails.filter((job) =>
    job.manifest.workspaceId === (activeWorkspaceId ?? null)
    && job.manifest.sessionId === (activeSessionId ?? null)
    && job.manifest.startedAt >= taskProgress.startedAt,
  ), [jobDetails, activeWorkspaceId, activeSessionId, taskProgress.startedAt]);
  const scrollSnapshotForWindow =
    streamScrollSnapshotsRef.current.get(activeStreamScrollKey);
  const anchorMessageIndex = scrollSnapshotForWindow?.anchorMessageId
    ? displayMessages.findIndex(
        (message) => message.id === scrollSnapshotForWindow.anchorMessageId,
      )
    : -1;
  const anchorMessageWindowSize =
    anchorMessageIndex >= 0 ? displayMessages.length - anchorMessageIndex : 0;
  const savedMessageWindowSize =
    messageWindowSizesRef.current.get(activeStreamScrollKey) ??
    INITIAL_MESSAGE_WINDOW;
  const storedMessageWindowSize =
    messageWindow.key === activeStreamScrollKey
      ? messageWindow.size
      : savedMessageWindowSize;
  const effectiveMessageWindowSize = Math.min(
    displayMessages.length,
    Math.max(
      INITIAL_MESSAGE_WINDOW,
      storedMessageWindowSize,
      anchorMessageWindowSize,
    ),
  );
  const visibleMessageCount = renderFullMessageList
    ? displayMessages.length
    : effectiveMessageWindowSize;
  const hiddenMessageCount = Math.max(
    0,
    displayMessages.length - visibleMessageCount,
  );
  const visibleMessages = useMemo(
    () =>
      hiddenMessageCount > 0
        ? displayMessages.slice(hiddenMessageCount)
        : displayMessages,
    [hiddenMessageCount, displayMessages],
  );
  const queuedChatMessageIdSet = useMemo(
    () => new Set(queuedChatMessageIds),
    [queuedChatMessageIds],
  );
  const steerableQueuedChatMessageIdSet = useMemo(
    () => new Set(steerableQueuedChatMessageIds),
    [steerableQueuedChatMessageIds],
  );
  const aiBusy = mode === "running" || activeAiEditing || activeChatting;

  useLayoutEffect(() => {
    if (renderFullMessageList) return;
    setMessageWindow((current) =>
      current.key === activeStreamScrollKey &&
      current.size === effectiveMessageWindowSize
        ? current
        : { key: activeStreamScrollKey, size: effectiveMessageWindowSize },
    );
  }, [
    activeStreamScrollKey,
    effectiveMessageWindowSize,
    renderFullMessageList,
  ]);

  const [height, setHeight] = useState<number>(
    () => loadDockHeight() ?? DEFAULT_DOCK_HEIGHT,
  );

  // Width (px) of the right-hand AI-input pane. The left AI-return pane fills
  // the remaining space, so dragging the divider re-splits the dock.
  const [inputWidth, setInputWidth] = useState<number>(
    () => loadPaneWidth(INPUT_WIDTH_KEY) ?? DEFAULT_INPUT_WIDTH,
  );
  const [renderedInputWidth, setRenderedInputWidth] = useState(inputWidth);
  // Height (px) of the bottom AI-input area in 'chat' layout. The AI-return area
  // above fills the remaining space, so dragging the divider re-splits the chat.
  const [chatInputHeight, setChatInputHeight] = useState<number>(
    () => loadPaneWidth(CHAT_INPUT_HEIGHT_KEY) ?? CHAT_INPUT_HEIGHT,
  );
  const [renderedChatInputHeight, setRenderedChatInputHeight] =
    useState(chatInputHeight);
  const dockRef = useRef<HTMLDivElement>(null);
  const orgPanelRef = useRef<HTMLDivElement>(null);
  const inputSectionRef = useRef<HTMLElement>(null);
  // Live height of the input composer section. The `$组织架构` popup anchors its
  // bottom edge to this so it never overlaps the (variable-height) input bar.
  const [inputSectionHeight, setInputSectionHeight] = useState(0);

  useEffect(() => {
    const drawerWidths = new Map<string, number>();
    const syncWidth = () => {
      setFilePreviewDrawerWidth(
        Math.max(0, ...Array.from(drawerWidths.values())),
      );
    };
    const onLayout = (event: Event) => {
      const detail = (event as CustomEvent<FilePreviewDrawerLayoutDetail>)
        .detail;
      if (!detail?.id) return;
      if (detail.open) {
        drawerWidths.set(detail.id, Math.max(0, detail.width));
      } else {
        drawerWidths.delete(detail.id);
      }
      syncWidth();
    };
    window.addEventListener(FILE_PREVIEW_DRAWER_LAYOUT_EVENT, onLayout);
    return () => {
      window.removeEventListener(FILE_PREVIEW_DRAWER_LAYOUT_EVENT, onLayout);
    };
  }, []);

  // Track the input section height while the popup is open so the popup always
  // floats just above the composer instead of covering it.
  useEffect(() => {
    if (!orgPanelOpen) return;
    const el = inputSectionRef.current;
    if (!el) return;
    const measure = () => setInputSectionHeight(el.offsetHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [orgPanelOpen]);

  useLayoutEffect(() => {
    if (!isChat || filePreviewDrawerWidth <= 0) {
      setChatVisibleRightInset(0);
      return;
    }

    const updateInset = () => {
      const dock = dockRef.current;
      if (!dock || typeof window === "undefined") {
        setChatVisibleRightInset(0);
        return;
      }
      const dockRect = dock.getBoundingClientRect();
      const drawerLeft = window.innerWidth - filePreviewDrawerWidth;
      const overlap = Math.max(
        0,
        dockRect.right - Math.max(dockRect.left, drawerLeft),
      );
      const maxInset = Math.max(0, dockRect.width - MIN_CHAT_VISIBLE_WIDTH);
      setChatVisibleRightInset(Math.min(overlap, maxInset));
    };

    updateInset();
    window.addEventListener("resize", updateInset);
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined" && dockRef.current) {
      ro = new ResizeObserver(updateInset);
      ro.observe(dockRef.current);
    }
    return () => {
      window.removeEventListener("resize", updateInset);
      ro?.disconnect();
    };
  }, [filePreviewDrawerWidth, isChat]);

  // Collapse the organization popup when clicking anywhere outside of it (the
  // trigger button toggles it directly, so ignore clicks that land on it).
  useEffect(() => {
    if (!orgPanelOpen) return;
    if (orgPanelLocked) return;
    const handlePointerDown = (event: MouseEvent) => {
      const panel = orgPanelRef.current;
      const target = event.target as HTMLElement | null;
      if (panel && target && panel.contains(target)) return;
      if (target && target.closest("[data-org-panel-trigger]")) return;
      setOrgPanelOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOrgPanelOpen(false);
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [orgPanelOpen, orgPanelLocked]);

  // Keep the inline `$` menu's org definition fresh: reload when the popup
  // panel closes (it may have edited the chart) and on cross-tab storage edits.
  useEffect(() => {
    if (orgPanelOpen) return;
    setOrgDefinition(loadGameOrgDefinition());
  }, [orgPanelOpen]);
  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key && !event.key.includes("gameOrgDefinition")) return;
      setOrgDefinition(loadGameOrgDefinition());
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  const orgPanelBottomOffset =
    (inputSectionHeight || (isChat && !centerInput ? chatInputHeight : 112)) +
    12;

  const setActiveSearchMatchNode = useCallback((node: HTMLElement | null) => {
    activeSearchMatchNodeRef.current = node;
  }, []);

  const focusSearchInput = useCallback(() => {
    searchInputRef.current?.focus();
    searchInputRef.current?.select();
  }, []);

  const openReturnSearch = useCallback(() => {
    setReturnSearchOpen(true);
  }, []);

  const closeReturnSearch = useCallback(() => {
    setReturnSearchOpen(false);
    setReturnSearch("");
    setActiveSearchMatchIndex(0);
    activeSearchMatchNodeRef.current = null;
  }, []);

  const clearReturnSearch = useCallback(() => {
    setReturnSearch("");
    setActiveSearchMatchIndex(0);
    if (returnSearchOpen) focusSearchInput();
  }, [focusSearchInput, returnSearchOpen]);

  const moveSearchMatch = useCallback(
    (step: number) => {
      if (searchMatches.length === 0) return;
      setActiveSearchMatchIndex((current) => {
        const next =
          (current + step + searchMatches.length) % searchMatches.length;
        return next;
      });
    },
    [searchMatches.length],
  );

  const flashMessageHighlight = useCallback((messageId: string) => {
    setAssetJumpHighlightId(messageId);
    if (assetJumpHighlightTimerRef.current != null) {
      window.clearTimeout(assetJumpHighlightTimerRef.current);
    }
    assetJumpHighlightTimerRef.current = window.setTimeout(() => {
      setAssetJumpHighlightId(null);
      assetJumpHighlightTimerRef.current = null;
    }, 1800);
  }, []);

  const scrollToTimelineMessage = useCallback(
    (messageId: string) => {
      const targetIndex = messages.findIndex(
        (message) => message.id === messageId,
      );
      if (targetIndex < 0) return;

      if (!renderFullMessageList && targetIndex < hiddenMessageCount) {
        const requiredWindowSize = messages.length - targetIndex;
        const nextWindowSize = Math.min(
          messages.length,
          Math.max(INITIAL_MESSAGE_WINDOW, requiredWindowSize),
        );
        messageWindowSizesRef.current.set(
          activeStreamScrollKey,
          nextWindowSize,
        );
        setMessageWindow((current) =>
          current.key === activeStreamScrollKey && current.size >= nextWindowSize
            ? current
            : { key: activeStreamScrollKey, size: nextWindowSize },
        );
      }

      setPendingTimelineJumpId(messageId);
    },
    [activeStreamScrollKey, hiddenMessageCount, messages, renderFullMessageList],
  );

  useLayoutEffect(() => {
    if (!pendingTimelineJumpId) return;
    const node = messageRefs.current.get(pendingTimelineJumpId);
    if (!node) return;

    window.requestAnimationFrame(() => {
      const nextNode = messageRefs.current.get(pendingTimelineJumpId);
      if (!nextNode) return;
      nextNode.scrollIntoView?.({
        block: "center",
        inline: "nearest",
        behavior: "smooth",
      });
      flashMessageHighlight(pendingTimelineJumpId);
      setPendingTimelineJumpId(null);
    });
  }, [
    flashMessageHighlight,
    hiddenMessageCount,
    messages.length,
    pendingTimelineJumpId,
  ]);

  useEffect(() => {
    const handleAssetSessionJump = (event: Event) => {
      const detail = (event as CustomEvent<AssetSessionJumpDetail>).detail;
      if (!detail?.sessionId) return;
      setAssetJumpTarget({
        assetId: detail.assetId,
        sessionId: detail.sessionId,
        workspaceId: detail.workspaceId ?? null,
        messageId: detail.messageId ?? null,
      });
    };
    window.addEventListener(ASSET_SESSION_JUMP_EVENT, handleAssetSessionJump);
    return () => {
      window.removeEventListener(
        ASSET_SESSION_JUMP_EVENT,
        handleAssetSessionJump,
      );
      if (assetJumpHighlightTimerRef.current != null) {
        window.clearTimeout(assetJumpHighlightTimerRef.current);
        assetJumpHighlightTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!assetJumpTarget) return;
    if (activeSessionId !== assetJumpTarget.sessionId) return;
    if (
      assetJumpTarget.workspaceId != null &&
      activeWorkspaceId !== assetJumpTarget.workspaceId
    ) {
      return;
    }
    const stream = streamRef.current;
    if (!stream) return;
    const targetMessageId =
      assetJumpTarget.messageId &&
      messages.some((message) => message.id === assetJumpTarget.messageId)
        ? assetJumpTarget.messageId
        : (messages[messages.length - 1]?.id ?? null);
    if (!targetMessageId) return;
    if (!renderFullMessageList) {
      const targetIndex = messages.findIndex(
        (message) => message.id === targetMessageId,
      );
      const requiredWindowSize =
        targetIndex >= 0 ? messages.length - targetIndex : 0;
      if (requiredWindowSize > visibleMessageCount) {
        setMessageWindow({
          key: activeStreamScrollKey,
          size: requiredWindowSize,
        });
        messageWindowSizesRef.current.set(
          activeStreamScrollKey,
          requiredWindowSize,
        );
        return;
      }
    }

    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const node = messageRefs.current.get(targetMessageId);
        if (node) {
          node.scrollIntoView({
            block: "center",
            inline: "nearest",
            behavior: "smooth",
          });
        } else {
          scrollStreamToBottom(stream);
        }
        flashMessageHighlight(targetMessageId);
        setAssetJumpTarget(null);
      });
    });
  }, [
    activeSessionId,
    activeStreamScrollKey,
    activeWorkspaceId,
    assetJumpTarget,
    flashMessageHighlight,
    messages,
    renderFullMessageList,
    visibleMessageCount,
  ]);

  // Re-pin the active stream to the bottom. Called when the user sends a
  // message so the new entry is guaranteed to scroll into view, even if the
  // stored snapshot recorded a non-bottom position (line auto-scroll prefers
  // the snapshot's atBottom over stickToBottomRef, so we must clear it too).
  const pinActiveStreamToBottom = useCallback(() => {
    stickToBottomRef.current = true;
    const key = activeStreamScrollKeyRef.current;
    forceNextMessageBottomRef.current = key;
    const snapshot = streamScrollSnapshotsRef.current.get(key);
    if (snapshot) {
      streamScrollSnapshotsRef.current.set(key, {
        ...snapshot,
        atBottom: true,
        anchorMessageId: null,
      });
    }
    const stream = streamRef.current;
    if (stream) {
      const before = stream.scrollTop;
      scrollStreamToBottom(stream);
      markProgrammaticStreamScroll(stream, before);
    }
  }, [markProgrammaticStreamScroll]);

  // Timeline "jump to edge" buttons. Unlike pinActiveStreamToBottom (used on
  // send, instant scroll) these are user-triggered smooth scrolls, so they
  // don't force stickToBottomRef/forceNextMessageBottomRef — the normal
  // onScroll snapshot tracking already recalculates atBottom once the smooth
  // scroll settles.
  const jumpStreamToTop = useCallback(() => {
    if (!renderFullMessageList && messages.length > 0) {
      const key = activeStreamScrollKeyRef.current;
      messageWindowSizesRef.current.set(key, messages.length);
      setMessageWindow({ key, size: messages.length });
    }
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const stream = streamRef.current;
        if (!stream) return;
        if (typeof stream.scrollTo === "function") {
          stream.scrollTo({ top: 0, behavior: "smooth" });
        } else {
          stream.scrollTop = 0;
        }
      });
    });
  }, [messages.length, renderFullMessageList]);

  const jumpStreamToBottom = useCallback(() => {
    const stream = streamRef.current;
    if (!stream) return;
    if (typeof stream.scrollTo === "function") {
      stream.scrollTo({ top: stream.scrollHeight, behavior: "smooth" });
    } else {
      stream.scrollTop = stream.scrollHeight;
    }
  }, []);

  const rememberStreamScrollSnapshot = useCallback((key?: string) => {
    if (normalizedSearchRef.current) return;
    if (searchScrollTopRef.current !== null) return;
    const stream = streamRef.current;
    if (!stream) return;
    const snapshot = readStreamScrollSnapshot(stream, messageRefs.current);
    streamScrollSnapshotsRef.current.set(
      key ?? activeStreamScrollKeyRef.current,
      snapshot,
    );
    stickToBottomRef.current = snapshot.atBottom;
  }, []);

  const growMessageWindow = useCallback(
    ({
      targetSize,
      pageSize,
      persist,
    }: {
      targetSize: number;
      pageSize: number;
      persist: boolean;
    }) => {
      const stream = streamRef.current;
      const previousScrollHeight = stream?.scrollHeight ?? null;
      setMessageWindow((current) => {
        const currentSize =
          current.key === activeStreamScrollKey
            ? current.size
            : effectiveMessageWindowSize;
        const next = Math.min(
          messages.length,
          targetSize,
          Math.max(INITIAL_MESSAGE_WINDOW, currentSize) + pageSize,
        );
        if (persist) {
          messageWindowSizesRef.current.set(activeStreamScrollKey, next);
        }
        return current.key === activeStreamScrollKey && current.size === next
          ? current
          : { key: activeStreamScrollKey, size: next };
      });
      const ownerKey = activeStreamScrollKey;
      window.requestAnimationFrame(() => {
        // The scroll node is shared by every session, so a frame scheduled here
        // can run after the user switched conversations — with the other
        // session's content already in the DOM. `previousScrollHeight` then
        // belongs to the session that asked for the growth, and applying the
        // difference to whatever is mounted now both moves the wrong session's
        // scrollbar and records that bogus position as the other session's
        // remembered scroll state (which flips it away from "at bottom" and
        // disables every later re-pin). Bail unless the node AND the owning
        // session key are still the ones this growth was computed for.
        const nextStream = streamRef.current;
        if (!nextStream || nextStream !== stream || previousScrollHeight == null)
          return;
        if (activeStreamScrollKeyRef.current !== ownerKey) return;
        const delta = nextStream.scrollHeight - previousScrollHeight;
        if (Number.isFinite(delta) && delta > 0) {
          const before = nextStream.scrollTop;
          nextStream.scrollTop += delta;
          markProgrammaticStreamScroll(nextStream, before);
          rememberStreamScrollSnapshot(ownerKey);
        }
      });
    },
    [
      activeStreamScrollKey,
      effectiveMessageWindowSize,
      messages.length,
      rememberStreamScrollSnapshot,
    ],
  );

  useEffect(() => {
    if (renderFullMessageList) return undefined;
    const targetSize = Math.min(messages.length, BACKGROUND_MESSAGE_WINDOW_TARGET);
    if (effectiveMessageWindowSize >= targetSize) return undefined;
    return scheduleIdleMessageWindow(() => {
      growMessageWindow({
        targetSize,
        pageSize: BACKGROUND_MESSAGE_WINDOW_PAGE,
        // Persist the idle-grown window per session. Otherwise switching back
        // to a session resets the window to INITIAL_MESSAGE_WINDOW, so the
        // scroll restore first anchors against a truncated tail and then has
        // to re-anchor while `growMessageWindow` re-expands it in the
        // background — a fragile two-step path that can leave the restored
        // bottom position short of the real bottom in a real browser. Keeping
        // the grown window means the switch-back restore lands directly on the
        // same content the user actually scrolled.
        persist: true,
      });
    });
  }, [
    effectiveMessageWindowSize,
    growMessageWindow,
    messages.length,
    renderFullMessageList,
  ]);

  const revealEarlierMessages = useCallback(() => {
    growMessageWindow({
      targetSize: messages.length,
      pageSize: MESSAGE_WINDOW_PAGE,
      persist: true,
    });
  }, [growMessageWindow, messages.length]);

  const restoreStreamScrollSnapshotForKey = useCallback(
    (key: string): boolean => {
      const stream = streamRef.current;
      if (!stream) return false;
      // A pending notification-click jump for this session overrides its
      // remembered scroll position: snap to the bottom instead so the user
      // lands on whatever just finished/needs input, not a stale spot.
      if (consumeForceBottomScrollForSession(activeSessionId)) {
        const before = stream.scrollTop;
        scrollStreamToBottom(stream);
        markProgrammaticStreamScroll(stream, before);
        stickToBottomRef.current = true;
        streamScrollSnapshotsRef.current.set(key, {
          atBottom: true,
          scrollTop: stream.scrollTop,
          scrollHeight: stream.scrollHeight,
          clientHeight: stream.clientHeight,
          anchorMessageId: null,
          anchorOffsetTop: 0,
        });
        return true;
      }
      const snapshot = streamScrollSnapshotsRef.current.get(key);
      stickToBottomRef.current = snapshot?.atBottom ?? true;
      const before = stream.scrollTop;
      const restored = restoreStreamScrollSnapshot(
        stream,
        messageRefs.current,
        snapshot,
      );
      markProgrammaticStreamScroll(stream, before);
      return restored;
    },
    [activeSessionId, markProgrammaticStreamScroll],
  );

  /**
   * A session that was left pinned to the bottom is restored against the DOM as
   * it exists in that commit — where the message window is still clamped and
   * off-screen markdown is still a plain-text placeholder. Both grow right
   * afterwards, so the "bottom" reached at restore time can sit far above the
   * settled bottom. Re-pin for a bounded number of frames while the session is
   * still bottom-pinned; the ResizeObserver covers anything later.
   */
  const bottomAlignRef = useRef<{
    key: string;
    stream: HTMLElement;
    attempts: number;
    frame: number | null;
    timer: number | null;
  } | null>(null);

  const cancelBottomAlignment = useCallback(() => {
    const pending = bottomAlignRef.current;
    bottomAlignRef.current = null;
    if (!pending) return;
    if (pending.frame !== null) window.cancelAnimationFrame(pending.frame);
    if (pending.timer !== null) window.clearTimeout(pending.timer);
  }, []);

  const scheduleBottomAlignment = useCallback(
    (key: string) => {
      cancelBottomAlignment();
      const stream = streamRef.current;
      if (!stream) return;
      const state = {
        key,
        stream,
        attempts: 0,
        frame: null as number | null,
        timer: null as number | null,
      };
      bottomAlignRef.current = state;
      const align = () => {
        state.frame = null;
        state.timer = null;
        if (bottomAlignRef.current !== state) return;
        // Never re-pin a session the user already left.
        if (activeStreamScrollKeyRef.current !== key) return;
        if (streamRef.current !== stream) return;
        if (!streamScrollSnapshotsRef.current.get(key)?.atBottom) return;
        const before = stream.scrollTop;
        scrollStreamToBottom(stream);
        markProgrammaticStreamScroll(stream, before);
        rememberStreamScrollSnapshot(key);
        state.attempts += 1;
        if (state.attempts < STREAM_BOTTOM_REALIGN_ATTEMPTS) {
          state.timer = window.setTimeout(align, STREAM_BOTTOM_REALIGN_DELAY_MS);
        }
      };
      state.frame = window.requestAnimationFrame(align);
    },
    [
      cancelBottomAlignment,
      markProgrammaticStreamScroll,
      rememberStreamScrollSnapshot,
    ],
  );

  useEffect(() => cancelBottomAlignment, [cancelBottomAlignment]);

  const updateActiveTopicFromScroll = useCallback(() => {
    const stream = streamRef.current;
    if (!stream || topicMessageIds.length === 0) {
      setActiveTopicMessageId(null);
      return;
    }

    const streamRect = stream.getBoundingClientRect();
    const readLine = stream.scrollTop + Math.max(48, stream.clientHeight * 0.18);
    const topics = topicMessageIds
      .map((id) => {
        const node = messageRefs.current.get(id);
        if (!node) return null;
        return {
          id,
          top:
            node.getBoundingClientRect().top -
            streamRect.top +
            stream.scrollTop,
        };
      })
      .filter((item): item is { id: string; top: number } => item !== null);
    if (topics.length === 0) {
      setActiveTopicMessageId(null);
      return;
    }

    const active =
      [...topics].reverse().find((topic) => topic.top <= readLine) ??
      topics[0];
    setActiveTopicMessageId((current) =>
      current === active.id ? current : active.id,
    );
  }, [topicMessageIds]);

  // Track whether the user is parked at (or near) the bottom. Manual upward
  // scroll pins this session to the visible message anchor; bottom stays sticky
  // and follows new streamed content.
  const handleStreamScroll = useCallback(() => {
    const stream = streamRef.current;
    const marks = programmaticScrollTopsRef.current;
    const markIndex = stream
      ? marks.findIndex((top) => Math.abs(top - stream.scrollTop) <= 1)
      : -1;
    if (markIndex !== -1) {
      // We scrolled, not the user: refresh the recorded geometry but keep the
      // session's pinned/unpinned intent exactly as it was.
      marks.splice(markIndex, 1);
      if (stream) {
        const key = activeStreamScrollKeyRef.current;
        const previous = streamScrollSnapshotsRef.current.get(key);
        // No snapshot yet means this session never recorded an intent; a write
        // we made for it (restore/pin/compensation) is bottom-following, so
        // default to pinned — never to the previous session's flag.
        const atBottom = previous?.atBottom ?? true;
        streamScrollSnapshotsRef.current.set(key, {
          ...readStreamScrollSnapshot(stream, messageRefs.current),
          atBottom,
        });
        stickToBottomRef.current = atBottom;
      }
      updateActiveTopicFromScroll();
      return;
    }
    // A real gesture overrides any write we had pending.
    marks.length = 0;
    rememberStreamScrollSnapshot();
    updateActiveTopicFromScroll();
  }, [rememberStreamScrollSnapshot, updateActiveTopicFromScroll]);

  useLayoutEffect(() => {
    updateActiveTopicFromScroll();
  }, [hiddenMessageCount, messages.length, updateActiveTopicFromScroll]);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  // Both chat layouts grow with the draft. Measure the actual chrome so file
  // chips and wrapping toolbars cannot take space away from the last text line.
  const CENTER_TEXTAREA_BASE = CENTER_INPUT_BASE_HEIGHT - 96;
  const [centerInputTextareaHeight, setCenterInputTextareaHeight] = useState(
    CENTER_TEXTAREA_BASE,
  );
  const fitChatInput = useCallback(() => {
    if (!isChat) return;
    const el = inputRef.current;
    const section = inputSectionRef.current;
    if (!el || !section) return;
    const chrome = Math.max(
      0,
      section.getBoundingClientRect().height - el.getBoundingClientRect().height,
    );
    const prevHeight = el.style.height;
    const prevMinHeight = el.style.minHeight;
    const prevMaxHeight = el.style.maxHeight;
    const prevFlex = el.style.flex;
    el.style.overflowY = "hidden";
    el.style.height = "0px";
    el.style.minHeight = "0";
    el.style.maxHeight = "none";
    el.style.flex = "0 0 auto";
    const content = el.scrollHeight;
    el.style.height = prevHeight;
    el.style.minHeight = prevMinHeight;
    el.style.maxHeight = prevMaxHeight;
    el.style.flex = prevFlex;
    const dockHeight = dockRef.current?.getBoundingClientRect().height;
    const viewportMax = Math.max(
      MIN_CHAT_INPUT_HEIGHT,
      (dockHeight || window.innerHeight) - MIN_CHAT_RETURN_HEIGHT,
    );
    const maximum = Math.min(
      viewportMax,
      Math.max(CENTER_INPUT_MAX_HEIGHT, centerInput ? 0 : chatInputHeight),
    );
    const available = Math.max(0, maximum - chrome);
    if (centerInput) {
      setCenterInputTextareaHeight(
        Math.min(Math.max(content, CENTER_TEXTAREA_BASE), available),
      );
    } else {
      setRenderedChatInputHeight(
        Math.min(Math.max(content + chrome, chatInputHeight), maximum),
      );
    }
    el.style.overflowY = content > available + 1 ? "auto" : "hidden";
    if (el.style.overflowY === "hidden") el.scrollTop = 0;
  }, [isChat, centerInput, chatInputHeight, CENTER_TEXTAREA_BASE]);

  useLayoutEffect(fitChatInput, [draft, fitChatInput]);

  useLayoutEffect(() => {
    if (!isChat) return;
    const section = inputSectionRef.current;
    const card = inputDropRef.current;
    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(fitChatInput);
    // Section/dock changes catch wrapping, side panels and viewport changes;
    // card children catch asynchronous previews and toolbar height changes.
    if (section) observer?.observe(section);
    if (dockRef.current) observer?.observe(dockRef.current);
    if (card) {
      for (const child of Array.from(card.children)) observer?.observe(child);
    }
    window.addEventListener("resize", fitChatInput);
    document.fonts?.addEventListener("loadingdone", fitChatInput);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", fitChatInput);
      document.fonts?.removeEventListener("loadingdone", fitChatInput);
    };
  }, [fitChatInput, draftFileRefs.length, composerTipText]);

  const rememberSelection = useCallback(
    (target: HTMLTextAreaElement | null = inputRef.current) => {
      if (!target) return;
      const max = draftRef.current.length;
      selectionRef.current = {
        start: clampSelection(target.selectionStart, max),
        end: clampSelection(target.selectionEnd, max),
      };
    },
    [],
  );

  const closeSlashSuggestions = useCallback(() => {
    slashTriggerRef.current = null;
    setSlashTrigger(null);
    setActiveSlashIndex(0);
  }, []);

  const closeGameSkillSuggestions = useCallback(() => {
    gameSkillTriggerRef.current = null;
    setGameSkillTrigger(null);
    setActiveGameSkillIndex(0);
  }, []);

  const closeFileMentionSuggestions = useCallback(() => {
    fileMentionTriggerRef.current = null;
    fileMentionInsertModeRef.current = "mention";
    setFileMentionTrigger(null);
    setActiveFileMentionIndex(0);
  }, []);

  const closeOrgMentionSuggestions = useCallback(() => {
    orgMentionTriggerRef.current = null;
    setOrgMentionTrigger(null);
    setActiveOrgMentionIndex(0);
    setOrgMentionParentId(null);
  }, []);

  const closeComposerSuggestions = useCallback(() => {
    closeSlashSuggestions();
    closeGameSkillSuggestions();
    closeFileMentionSuggestions();
    closeOrgMentionSuggestions();
  }, [
    closeFileMentionSuggestions,
    closeGameSkillSuggestions,
    closeOrgMentionSuggestions,
    closeSlashSuggestions,
  ]);

  const syncSlashTrigger = useCallback(
    (target: HTMLTextAreaElement | null = inputRef.current) => {
      if (
        !target ||
        isReadOnly ||
        target.selectionStart !== target.selectionEnd
      ) {
        closeSlashSuggestions();
        return;
      }

      const next = findSlashTrigger(target.value, target.selectionStart);
      const prev = slashTriggerRef.current;
      const unchanged =
        prev?.start === next?.start &&
        prev?.end === next?.end &&
        prev?.query === next?.query;
      if (unchanged) return;

      slashTriggerRef.current = next;
      setSlashTrigger(next);
      setActiveSlashIndex(0);
    },
    [closeSlashSuggestions, isReadOnly],
  );

  const syncGameSkillTrigger = useCallback(
    (target: HTMLTextAreaElement | null = inputRef.current) => {
      if (
        !target ||
        isReadOnly ||
        target.selectionStart !== target.selectionEnd
      ) {
        closeGameSkillSuggestions();
        return;
      }

      const next = findGameSkillTrigger(target.value, target.selectionStart);
      const prev = gameSkillTriggerRef.current;
      const unchanged =
        prev?.start === next?.start &&
        prev?.end === next?.end &&
        prev?.query === next?.query;
      if (unchanged) return;

      gameSkillTriggerRef.current = next;
      setGameSkillTrigger(next);
      setActiveGameSkillIndex(0);
    },
    [closeGameSkillSuggestions, isReadOnly],
  );

  const syncFileMentionTrigger = useCallback(
    (target: HTMLTextAreaElement | null = inputRef.current) => {
      if (
        !target ||
        isReadOnly ||
        target.selectionStart !== target.selectionEnd
      ) {
        closeFileMentionSuggestions();
        return;
      }
      if (fileMentionInsertModeRef.current === "path") return;

      const next = findFileMentionTrigger(target.value, target.selectionStart);
      const prev = fileMentionTriggerRef.current;
      const unchanged =
        prev?.start === next?.start &&
        prev?.end === next?.end &&
        prev?.directory === next?.directory &&
        prev?.query === next?.query;
      if (unchanged) return;

      if (next) fileMentionInsertModeRef.current = "mention";
      fileMentionTriggerRef.current = next;
      setFileMentionTrigger(next);
      setActiveFileMentionIndex(0);
    },
    [closeFileMentionSuggestions, isReadOnly],
  );

  const syncOrgMentionTrigger = useCallback(
    (target: HTMLTextAreaElement | null = inputRef.current) => {
      if (
        !isChat ||
        !target ||
        isReadOnly ||
        target.selectionStart !== target.selectionEnd
      ) {
        closeOrgMentionSuggestions();
        return;
      }

      const next = findOrgMentionTrigger(target.value, target.selectionStart);
      const prev = orgMentionTriggerRef.current;
      const unchanged =
        prev?.start === next?.start &&
        prev?.end === next?.end &&
        prev?.query === next?.query;
      if (unchanged) return;

      orgMentionTriggerRef.current = next;
      setOrgMentionTrigger(next);
      setActiveOrgMentionIndex(0);
      // Leaving the `$` token entirely resets the drill level for next time.
      if (!next) setOrgMentionParentId(null);
    },
    [closeOrgMentionSuggestions, isChat, isReadOnly],
  );

  const syncComposerSuggestions = useCallback(
    (target: HTMLTextAreaElement | null = inputRef.current) => {
      syncSlashTrigger(target);
      syncGameSkillTrigger(target);
      syncFileMentionTrigger(target);
      syncOrgMentionTrigger(target);
    },
    [
      syncFileMentionTrigger,
      syncGameSkillTrigger,
      syncOrgMentionTrigger,
      syncSlashTrigger,
    ],
  );

  const insertComposerText = useCallback(
    (text: string, selection = selectionRef.current) => {
      if (isReadOnly || !text) return;

      const current = draftRef.current;
      const start = clampSelection(selection.start, current.length);
      const end = clampSelection(selection.end, current.length);
      const next = current.slice(0, start) + text + current.slice(end);
      const caret = start + text.length;

      draftRef.current = next;
      selectionRef.current = { start: caret, end: caret };
      setComposerDraft(next);

      window.requestAnimationFrame(() => {
        const el = inputRef.current;
        if (!(el instanceof HTMLTextAreaElement)) return;
        el.focus();
        el.setSelectionRange(caret, caret);
      });
    },
    [isReadOnly, setComposerDraft],
  );

  const applySlashSuggestion = useCallback(
    (suggestion: SlashSuggestion) => {
      if (isReadOnly) return;

      const trigger = slashTriggerRef.current;
      if (!trigger) return;

      const current = draftRef.current;
      const start = clampSelection(trigger.start, current.length);
      const end = clampSelection(trigger.end, current.length);
      const after = current.slice(end);
      const insertionText = isOrgSlashSuggestion(suggestion)
        ? suggestion.insertText.trim()
        : suggestion.name;
      const spacer = after.length > 0 && /^\s/.test(after) ? "" : " ";
      const inserted = `${insertionText}${spacer}`;
      const next = current.slice(0, start) + inserted + after;
      const caret = start + inserted.length;

      draftRef.current = next;
      selectionRef.current = { start: caret, end: caret };
      setComposerDraft(next);
      closeSlashSuggestions();

      window.requestAnimationFrame(() => {
        const el = inputRef.current;
        if (!(el instanceof HTMLTextAreaElement)) return;
        el.focus();
        el.setSelectionRange(caret, caret);
      });
    },
    [closeSlashSuggestions, isReadOnly, setComposerDraft],
  );

  // Replaces the active `#…` token with the GameSkill's canonical `/command`
  // token. We deliberately insert the slash command (not the protocol text) so
  // every existing submit-time route and channel guard keeps working unchanged —
  // `#` is purely a discovery surface for the UltraGameStudio GameSkills.
  const applyGameSkillSuggestion = useCallback(
    (suggestion: SlashSuggestion) => {
      if (isReadOnly) return;

      const trigger = gameSkillTriggerRef.current;
      if (!trigger) return;

      const current = draftRef.current;
      const start = clampSelection(trigger.start, current.length);
      const end = clampSelection(trigger.end, current.length);
      const after = current.slice(end);
      const spacer = after.length > 0 && /^\s/.test(after) ? "" : " ";
      const inserted = `${suggestion.name}${spacer}`;
      const next = current.slice(0, start) + inserted + after;
      const caret = start + inserted.length;

      draftRef.current = next;
      selectionRef.current = { start: caret, end: caret };
      setComposerDraft(next);
      closeGameSkillSuggestions();

      window.requestAnimationFrame(() => {
        const el = inputRef.current;
        if (!(el instanceof HTMLTextAreaElement)) return;
        el.focus();
        el.setSelectionRange(caret, caret);
      });
    },
    [closeGameSkillSuggestions, isReadOnly, setComposerDraft],
  );

  // Replaces the active `$…` token with a role's command text and closes the
  // inline menu (the terminal action when picking a node).
  const insertOrgMentionCommand = useCallback(
    (node: ResolvedGameOrgNode) => {
      if (isReadOnly) return;
      const trigger = orgMentionTriggerRef.current;
      if (!trigger) return;

      const command = (node.commandText ?? "").trim();
      const current = draftRef.current;
      const start = clampSelection(trigger.start, current.length);
      const end = clampSelection(trigger.end, current.length);
      const after = current.slice(end);
      const spacer =
        command && after.length > 0 && /^\s/.test(after) ? "" : " ";
      const inserted = command ? `${command}${spacer}` : "";
      const next = current.slice(0, start) + inserted + after;
      const caret = start + inserted.length;

      draftRef.current = next;
      selectionRef.current = { start: caret, end: caret };
      setComposerDraft(next);
      closeOrgMentionSuggestions();

      window.requestAnimationFrame(() => {
        const el = inputRef.current;
        if (!(el instanceof HTMLTextAreaElement)) return;
        el.focus();
        el.setSelectionRange(caret, caret);
      });
    },
    [closeOrgMentionSuggestions, isReadOnly, setComposerDraft],
  );

  // Drills the inline menu into a branch: clears the typed query (back to the
  // `$` token) and lists the branch's children.
  const drillOrgMention = useCallback(
    (parentId: string | null) => {
      const trigger = orgMentionTriggerRef.current;
      setOrgMentionParentId(parentId);
      setActiveOrgMentionIndex(0);
      if (!trigger || trigger.query.length === 0) return;
      // Strip any typed query so the navigation view (not search) is shown.
      const current = draftRef.current;
      const start = clampSelection(trigger.start, current.length);
      const end = clampSelection(trigger.end, current.length);
      const next = current.slice(0, start + 1) + current.slice(end);
      const caret = start + 1;
      const resetTrigger: SlashTrigger = { start, end: caret, query: "" };
      orgMentionTriggerRef.current = resetTrigger;
      draftRef.current = next;
      selectionRef.current = { start: caret, end: caret };
      setComposerDraft(next);
      setOrgMentionTrigger(resetTrigger);
      window.requestAnimationFrame(() => {
        const el = inputRef.current;
        if (!(el instanceof HTMLTextAreaElement)) return;
        el.focus();
        el.setSelectionRange(caret, caret);
      });
    },
    [setComposerDraft],
  );

  // Handles a click/Enter on any inline-menu row.
  const applyOrgMentionOption = useCallback(
    (option: OrgMentionOption) => {
      if (isReadOnly) return;
      if (option.kind === "back") {
        const parent = orgMentionParentId
          ? (orgNodeById.get(orgMentionParentId) ?? null)
          : null;
        // Find the node whose children include the current branch. If that is
        // the root, the menu returns to the top (null) level rather than
        // listing the root node itself.
        const owner = parent
          ? (orgNodesFlat.find((candidate) =>
              candidate.children.some((child) => child.id === parent.id),
            ) ?? null)
          : null;
        const grandparentId =
          owner && owner.id !== orgTree.id ? owner.id : null;
        drillOrgMention(grandparentId);
        return;
      }
      if (option.kind === "insert-self") {
        insertOrgMentionCommand(option.node);
        return;
      }
      // A branch node drills in; a leaf inserts its command immediately.
      if (option.hasChildren) {
        drillOrgMention(option.node.id);
      } else {
        insertOrgMentionCommand(option.node);
      }
    },
    [
      drillOrgMention,
      insertOrgMentionCommand,
      isReadOnly,
      orgMentionParentId,
      orgNodeById,
      orgNodesFlat,
      orgTree,
    ],
  );

  const applyFileMentionOption = useCallback(
    (entry: WorkspaceTreeEntry) => {
      if (isReadOnly) return;

      const trigger = fileMentionTriggerRef.current;
      if (!trigger) return;

      const current = draftRef.current;
      const start = clampSelection(trigger.start, current.length);
      const end = clampSelection(trigger.end, current.length);
      const after = current.slice(end);
      const mode = fileMentionInsertModeRef.current;
      const baseInserted =
        mode === "path"
          ? filePathPickerInsertText(entry)
          : fileMentionInsertText(entry);
      const prefix =
        mode === "path" && start > 0 && !/\s/.test(current[start - 1] ?? "")
          ? " "
          : "";
      const spacer =
        entry.kind === "file" && (after.length === 0 || !/^\s/.test(after))
          ? " "
          : "";
      const inserted = `${prefix}${baseInserted}${spacer}`;
      const next = current.slice(0, start) + inserted + after;
      const caret = start + inserted.length;

      draftRef.current = next;
      selectionRef.current = { start: caret, end: caret };
      setComposerDraft(next);

      if (entry.kind === "directory") {
        const nextTrigger =
          mode === "path"
            ? {
                start: start + prefix.length,
                end: caret,
                directory: normalizeFileMentionPath(entry.relativePath),
                query: "",
              }
            : findFileMentionTrigger(next, caret);
        fileMentionTriggerRef.current = nextTrigger;
        setFileMentionTrigger(nextTrigger);
        setActiveFileMentionIndex(0);
      } else {
        closeFileMentionSuggestions();
      }
      closeSlashSuggestions();

      window.requestAnimationFrame(() => {
        const el = inputRef.current;
        if (!(el instanceof HTMLTextAreaElement)) return;
        el.focus();
        el.setSelectionRange(caret, caret);
      });
    },
    [
      closeFileMentionSuggestions,
      closeSlashSuggestions,
      isReadOnly,
      setComposerDraft,
    ],
  );

  const insertFilePaths = useCallback(
    (paths: string[], selection = selectionRef.current) => {
      insertComposerText(formatFilePathInsertion(paths), selection);
    },
    [insertComposerText],
  );

  // Deleting a thumbnail in the composer strip must delete the underlying path
  // token from the draft, not just hide the tile: the path is what actually gets
  // sent. Pasted paths arrive backtick-wrapped (formatFilePathInsertion), a
  // manually typed or dropped one may be bare, and a `file:///` draft carries a
  // form parseFileRef normalized away — so try the wrapper, the raw path, then
  // the basename (only when it is unambiguous).
  const removeComposerFileRef = useCallback(
    (ref: FileRef) => {
      if (isReadOnly) return;

      const current = draftRef.current;
      const candidates = [`\`${ref.path}\``, ref.path];
      if (ref.basename && ref.basename !== ref.path) candidates.push(ref.basename);

      let index = -1;
      let length = 0;
      for (const candidate of candidates) {
        if (!candidate) continue;
        const at = current.indexOf(candidate);
        if (at === -1) continue;
        if (candidate === ref.basename && current.indexOf(candidate, at + 1) !== -1) {
          continue; // Ambiguous basename: never guess which occurrence to drop.
        }
        index = at;
        length = candidate.length;
        break;
      }
      if (index === -1) return;

      let start = index;
      let end = index + length;
      // Swallow the newline the path list left behind so removing the last
      // preview does not leave a blank line in the draft.
      if (current[end] === "\n") end += 1;
      else if (start > 0 && current[start - 1] === "\n") start -= 1;

      const next = current.slice(0, start) + current.slice(end);
      const caret = clampSelection(start, next.length);

      draftRef.current = next;
      selectionRef.current = { start: caret, end: caret };
      setComposerDraft(next);

      window.requestAnimationFrame(() => {
        const el = inputRef.current;
        if (!(el instanceof HTMLTextAreaElement)) return;
        el.focus();
        el.setSelectionRange(caret, caret);
      });
    },
    [isReadOnly, setComposerDraft],
  );

  const startFileMention = useCallback(() => {
    if (isReadOnly) return;
    fileMentionInsertModeRef.current = "mention";
    const current = draftRef.current;
    const start = clampSelection(selectionRef.current.start, current.length);
    const prefix = start > 0 && !/\s/.test(current[start - 1] ?? "") ? " " : "";
    insertComposerText(`${prefix}@`);
    window.requestAnimationFrame(() =>
      syncComposerSuggestions(inputRef.current),
    );
  }, [insertComposerText, isReadOnly, syncComposerSuggestions]);

  const startRemoteFilePathPicker = useCallback(() => {
    if (isReadOnly || !activeRemoteWorkspaceRoot) return;
    const current = draftRef.current;
    const start = clampSelection(selectionRef.current.start, current.length);
    const end = clampSelection(selectionRef.current.end, current.length);
    const nextTrigger: FileMentionTrigger = {
      start,
      end,
      directory: "",
      query: "",
    };
    fileMentionInsertModeRef.current = "path";
    fileMentionTriggerRef.current = nextTrigger;
    setFileMentionTrigger(nextTrigger);
    setActiveFileMentionIndex(0);
    closeSlashSuggestions();
    closeGameSkillSuggestions();
    closeOrgMentionSuggestions();
    window.requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!(el instanceof HTMLTextAreaElement)) return;
      el.focus();
      el.setSelectionRange(start, end);
    });
  }, [
    activeRemoteWorkspaceRoot,
    closeGameSkillSuggestions,
    closeOrgMentionSuggestions,
    closeSlashSuggestions,
    isReadOnly,
  ]);

  const startSlashCommand = useCallback(() => {
    if (isReadOnly) return;
    const current = draftRef.current;
    const start = clampSelection(selectionRef.current.start, current.length);
    const prefix = start > 0 && !/\s/.test(current[start - 1] ?? "") ? " " : "";
    const triggerStart = start + prefix.length;
    const nextTrigger: SlashTrigger = {
      start: triggerStart,
      end: triggerStart + 1,
      query: "",
    };
    const openSlashMenu = () => {
      slashTriggerRef.current = nextTrigger;
      setSlashTrigger(nextTrigger);
      setActiveSlashIndex(0);
    };
    insertComposerText(`${prefix}/`);
    closeFileMentionSuggestions();
    openSlashMenu();
    window.requestAnimationFrame(openSlashMenu);
  }, [closeFileMentionSuggestions, insertComposerText, isReadOnly]);

  const startGameSkill = useCallback(() => {
    if (isReadOnly) return;
    const current = draftRef.current;
    const start = clampSelection(selectionRef.current.start, current.length);
    const prefix = start > 0 && !/\s/.test(current[start - 1] ?? "") ? " " : "";
    const triggerStart = start + prefix.length;
    const nextTrigger: SlashTrigger = {
      start: triggerStart,
      end: triggerStart + 1,
      query: "",
    };
    const openGameSkillMenu = () => {
      gameSkillTriggerRef.current = nextTrigger;
      setGameSkillTrigger(nextTrigger);
      setActiveGameSkillIndex(0);
    };
    insertComposerText(`${prefix}#`);
    closeSlashSuggestions();
    closeFileMentionSuggestions();
    openGameSkillMenu();
    window.requestAnimationFrame(openGameSkillMenu);
  }, [
    closeFileMentionSuggestions,
    closeSlashSuggestions,
    insertComposerText,
    isReadOnly,
  ]);

  const handlePaste = useCallback(
    (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
      if (isReadOnly || (!tauriAvailable() && !activeRemoteWorkspaceRoot)) {
        return;
      }

      const images = clipboardImageFiles(event.clipboardData);
      if (images.length === 0) return;

      event.preventDefault();
      const selection = {
        start: event.currentTarget.selectionStart,
        end: event.currentTarget.selectionEnd,
      };
      selectionRef.current = selection;

      void Promise.allSettled(
        images.map((file) =>
          savePastedImageFile(file, workspaceCwd, activeRemoteWorkspaceRoot),
        ),
      ).then((results) => {
        const paths = uploadedPathsFromResults(results, {
          remote: !!activeRemoteWorkspaceRoot,
        });
        if (paths.length === 0) return;
        closeComposerSuggestions();
        insertFilePaths(paths, selection);
      });
    },
    [
      activeRemoteWorkspaceRoot,
      closeComposerSuggestions,
      insertFilePaths,
      isReadOnly,
      uploadedPathsFromResults,
      workspaceCwd,
    ],
  );

  const handleQueuedEditPaste = useCallback(
    (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
      if (isReadOnly || (!tauriAvailable() && !activeRemoteWorkspaceRoot)) {
        return;
      }

      const images = clipboardImageFiles(event.clipboardData);
      if (images.length === 0) return;

      event.preventDefault();
      const textarea = event.currentTarget;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;

      void Promise.allSettled(
        images.map((file) =>
          savePastedImageFile(file, workspaceCwd, activeRemoteWorkspaceRoot),
        ),
      ).then((results) => {
        const paths = uploadedPathsFromResults(results, {
          remote: !!activeRemoteWorkspaceRoot,
        });
        if (paths.length === 0) return;
        const insertText = formatFilePathInsertion(paths);
        setQueuedEditDraft((prev) => {
          const before = prev.slice(0, start);
          const after = prev.slice(end);
          return `${before}${insertText}${after}`;
        });
      });
    },
    [
      activeRemoteWorkspaceRoot,
      isReadOnly,
      uploadedPathsFromResults,
      workspaceCwd,
    ],
  );

  const handleComposerDragOver = useCallback(
    (event: ReactDragEvent<HTMLElement>) => {
      const hasProjectPaths = hasProjectFileDragData(event.dataTransfer);
      const hasFiles = Array.from(event.dataTransfer?.types ?? []).includes(
        "Files",
      );
      // Project-tree drags use HTML5 DnD. Browser/no-native builds can also
      // expose external files here, though those may only carry File.name.
      // Desktop full paths come from the Tauri native drag handler below.
      if (isReadOnly || (!hasProjectPaths && !hasFiles)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      if (hasProjectPaths) {
        setProjectFileDragAccepted(true);
        applyProjectFileDragDropEffect(event.dataTransfer);
      }
      setDropActive(true);
    },
    [isReadOnly],
  );

  const handleComposerDragLeave = useCallback(
    (event: ReactDragEvent<HTMLElement>) => {
      const nextTarget = event.relatedTarget;
      if (
        nextTarget instanceof Node &&
        event.currentTarget.contains(nextTarget)
      ) {
        return;
      }
      setDropActive(false);
      setProjectFileDragAccepted(false);
    },
    [],
  );

  const handleComposerDrop = useCallback(
    (event: ReactDragEvent<HTMLElement>) => {
      const hasProjectPaths = hasProjectFileDragData(event.dataTransfer);
      const projectPaths = activeRemoteWorkspaceRoot
        ? projectFileRelativePathsFromDataTransfer(event.dataTransfer)
        : projectFilePathsFromDataTransfer(event.dataTransfer);
      if (isReadOnly) return;

      const targetSelection =
        event.target instanceof HTMLTextAreaElement
          ? {
              start: event.target.selectionStart,
              end: event.target.selectionEnd,
            }
          : selectionRef.current;
      selectionRef.current = targetSelection;

      if (hasProjectPaths) {
        event.preventDefault();
        event.stopPropagation();
        setDropActive(false);
        setProjectFileDragAccepted(false);
        clearProjectFileDragData();
        if (projectPaths.length > 0) {
          closeComposerSuggestions();
          insertFilePaths(projectPaths, targetSelection);
        }
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      setDropActive(false);
      setProjectFileDragAccepted(false);
      closeComposerSuggestions();
      if (activeRemoteWorkspaceRoot) {
        const files = filesFromDataTransfer(event.dataTransfer);
        void Promise.allSettled(
          files.map((file) => uploadRemoteFile(activeRemoteWorkspaceRoot, file)),
        ).then((results) => {
          const paths = uploadedPathsFromResults(results, { remote: true });
          if (paths.length === 0) return;
          insertFilePaths(paths, targetSelection);
        });
        return;
      }
      insertFilePaths(pathsFromDataTransfer(event.dataTransfer), targetSelection);
    },
    [
      activeRemoteWorkspaceRoot,
      closeComposerSuggestions,
      insertFilePaths,
      isReadOnly,
      uploadedPathsFromResults,
    ],
  );

  const updateProjectDragFeedbackAtPoint = useCallback(
    (point: { clientX: number; clientY: number }): boolean => {
      const el = inputDropRef.current ?? inputRef.current;
      const accepted =
        !isReadOnly && !!el && clientPointInsideElement(point, el);
      setProjectFileDragAccepted(accepted);
      setDropActive(accepted);
      return accepted;
    },
    [isReadOnly],
  );

  /** Clamp the input width to keep both panes usable within the dock. */
  const clampInputWidth = useCallback((w: number): number => {
    const total = Math.max(
      0,
      dockRef.current?.clientWidth ?? window.innerWidth,
    );
    const constrained = total < MIN_INPUT_WIDTH + MIN_RETURN_WIDTH;
    const minInput = constrained
      ? Math.min(
          MIN_INPUT_WIDTH,
          Math.max(
            NARROW_INPUT_MIN_WIDTH,
            Math.floor(total * NARROW_INPUT_WIDTH_RATIO),
          ),
        )
      : MIN_INPUT_WIDTH;
    const minReturn = constrained
      ? Math.max(NARROW_INPUT_MIN_WIDTH, total - minInput)
      : MIN_RETURN_WIDTH;
    const max = Math.max(minInput, total - minReturn);
    return Math.min(Math.max(w, minInput), max);
  }, []);

  useEffect(() => {
    setActiveSearchMatchIndex(0);
  }, [normalizedSearch]);

  useEffect(() => {
    setActiveSlashIndex((current) =>
      filteredSlashSuggestions.length > 0
        ? Math.min(current, filteredSlashSuggestions.length - 1)
        : 0,
    );
  }, [filteredSlashSuggestions.length]);

  useEffect(() => {
    setActiveGameSkillIndex((current) =>
      filteredGameSkillSuggestions.length > 0
        ? Math.min(current, filteredGameSkillSuggestions.length - 1)
        : 0,
    );
  }, [filteredGameSkillSuggestions.length]);

  useEffect(() => {
    if (returnSearchOpen) focusSearchInput();
  }, [focusSearchInput, returnSearchOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (keyModalChannel || localSetupChannel) return;
      if (matchesShortcut(event, shortcutSettings["return-search"])) {
        event.preventDefault();
        openReturnSearch();
        return;
      }
      if (event.key === "Escape" && returnSearchOpen) {
        event.preventDefault();
        closeReturnSearch();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    closeReturnSearch,
    keyModalChannel,
    localSetupChannel,
    openReturnSearch,
    returnSearchOpen,
    shortcutSettings,
  ]);

  useEffect(() => {
    if (searchMatches.length === 0) {
      setActiveSearchMatchIndex(0);
      return;
    }
    setActiveSearchMatchIndex((current) =>
      Math.min(current, searchMatches.length - 1),
    );
  }, [searchMatches.length]);

  useEffect(() => {
    const wasActive = lastSearchActiveRef.current;
    lastSearchActiveRef.current = normalizedSearch.length > 0;
    if (normalizedSearch) {
      searchScrollTopRef.current = null;
    }
    if (wasActive && !normalizedSearch) {
      const el = streamRef.current;
      searchScrollTopRef.current = el?.scrollTop ?? null;
      window.requestAnimationFrame(() => {
        if (lastSearchActiveRef.current) return;
        const stream = streamRef.current;
        const top = searchScrollTopRef.current;
        if (!stream || top === null) return;
        const before = stream.scrollTop;
        stream.scrollTop = top;
        markProgrammaticStreamScroll(stream, before);
        searchScrollTopRef.current = null;
      });
    }
  }, [markProgrammaticStreamScroll, normalizedSearch]);

  // Session/workspace switches restore that conversation's own scroll state:
  // bottom remains sticky, while a manual non-bottom position is restored by
  // visible-message anchor so new streamed content below does not move the
  // user's reading position.
  useLayoutEffect(() => {
    pendingStreamScrollRestoreKeyRef.current = activeStreamScrollKey;
  }, [activeStreamScrollKey]);

  useLayoutEffect(() => {
    if (pendingStreamScrollRestoreKeyRef.current !== activeStreamScrollKey)
      return;
    if (restoreStreamScrollSnapshotForKey(activeStreamScrollKey)) {
      pendingStreamScrollRestoreKeyRef.current = null;
      // 首帧恢复只面对那一帧的 DOM：消息窗口还是收缩的、离屏 Markdown 还是
      // 纯文本占位，两者随后都会长高，所以恢复时的“底部”可能远高于真正的底部。
      // 这里安排一个跨帧的重新对齐（见 scheduleBottomAlignment），由它负责
      // 补齐这段增长，而不是只赌一次 ResizeObserver。
      scheduleBottomAlignment(activeStreamScrollKey);
    }
    return () => {
      // 同一个会话内的重跑（消息窗口增长 / 新消息）必须保留正在进行的底部
      // 对齐；只有真正换了会话才取消它。会话切换时 activeStreamScrollKeyRef
      // 已经在渲染阶段更新为新 key，所以这里能区分两种情况。
      if (activeStreamScrollKeyRef.current !== activeStreamScrollKey) {
        cancelBottomAlignment();
      }
    };
  }, [
    activeStreamScrollKey,
    hiddenMessageCount,
    messages.length,
    rememberStreamScrollSnapshot,
    restoreStreamScrollSnapshotForKey,
    scheduleBottomAlignment,
    cancelBottomAlignment,
  ]);

  useLayoutEffect(() => {
    // Only honor a pending forced-bottom request for the session that
    // actually asked for it. If the user switched sessions before the
    // request's `messages.length` change landed, the request is stale for
    // whatever session is active now — drop it rather than bottom-scrolling
    // (and clobbering the snapshot of) an unrelated session.
    if (forceNextMessageBottomRef.current !== activeStreamScrollKey) {
      forceNextMessageBottomRef.current = null;
      return;
    }
    const stream = streamRef.current;
    if (!stream) return;

    const before = stream.scrollTop;
    scrollStreamToBottom(stream);
    markProgrammaticStreamScroll(stream, before);
    stickToBottomRef.current = true;
    streamScrollSnapshotsRef.current.set(activeStreamScrollKeyRef.current, {
      atBottom: true,
      scrollTop: stream.scrollTop,
      scrollHeight: stream.scrollHeight,
      clientHeight: stream.clientHeight,
      anchorMessageId: null,
      anchorOffsetTop: 0,
    });
    forceNextMessageBottomRef.current = null;
  }, [activeStreamScrollKey, markProgrammaticStreamScroll, messages.length]);

  // Keep the latest message in view unless return search is active or the user
  // has scrolled away from the bottom. `stickToBottomRef` is updated by the
  // stream's onScroll handler — when the user is near the bottom we keep
  // following new messages, otherwise we leave the viewport anchored where they
  // left it (token-by-token streaming included).
  //
  // Uses ResizeObserver instead of useLayoutEffect to avoid a race condition:
  // useLayoutEffect fires synchronously during React's commit phase, so a user
  // scroll event that arrives between state update scheduling and effect
  // execution would leave stickToBottomRef still true. ResizeObserver fires
  // after the browser has processed layout and pending events, giving the
  // onScroll handler a chance to mark the user as "scrolled away" first.
  useEffect(() => {
    const el = streamRef.current;
    if (!el) return;
    const syncScrollAfterLayout = () => {
      if (normalizedSearchRef.current) return;
      if (searchScrollTopRef.current !== null) return;
      // Re-read the node and the key at fire time: this callback is async, so
      // the session it was created for may already be gone.
      if (streamRef.current !== el) return;
      const key = activeStreamScrollKeyRef.current;
      const snapshot = streamScrollSnapshotsRef.current.get(key);
      if (snapshot?.atBottom ?? stickToBottomRef.current) {
        const before = el.scrollTop;
        scrollStreamToBottom(el);
        markProgrammaticStreamScroll(el, before);
      } else if (snapshot) {
        const before = el.scrollTop;
        restoreStreamScrollSnapshot(el, messageRefs.current, snapshot);
        markProgrammaticStreamScroll(el, before);
      }
      rememberStreamScrollSnapshot(key);
    };
    if (typeof ResizeObserver === "undefined") {
      syncScrollAfterLayout();
      return;
    }
    const ro = new ResizeObserver(syncScrollAfterLayout);
    ro.observe(el);
    // Also watch the inner list: the container has a fixed height, so only its
    // content grows when messages are appended or stream tokens arrive. Without
    // this the observer never fires on new content and the newest message stays
    // hidden below the fold.
    const content = streamContentRef.current;
    if (content) ro.observe(content);
    return () => ro.disconnect();
    // Rebind per session: the observed nodes are replaced whenever the message
    // count changes, and a same-count switch must not keep the previous
    // session's observation closure around.
  }, [activeStreamScrollKey, markProgrammaticStreamScroll, rememberStreamScrollSnapshot, messages.length]);

  useEffect(() => {
    if (
      !normalizedSearch ||
      !activeSearchMatchId ||
      !activeSearchMatchMessageId
    ) {
      return;
    }
    const target =
      activeSearchMatchSource === "text"
        ? activeSearchMatchNodeRef.current
        : null;
    const messageEl = messageRefs.current.get(activeSearchMatchMessageId);
    const scrollTarget =
      target && target.dataset.searchMatchId === activeSearchMatchId
        ? target
        : messageEl;
    scrollTarget?.scrollIntoView?.({ block: "center", inline: "nearest" });
  }, [
    activeSearchMatchId,
    activeSearchMatchMessageId,
    activeSearchMatchSource,
    normalizedSearch,
  ]);

  // PromptPanel can append text into this composer. When it does, move focus to
  // the AI input and place the caret at the end so the user can continue typing.
  useEffect(() => {
    if (composerFocusVersion === lastComposerFocusVersion.current) return;
    lastComposerFocusVersion.current = composerFocusVersion;
    const el = inputRef.current;
    if (
      !(el instanceof HTMLTextAreaElement) ||
      !shouldRefocusComposerAfterAppend(mode)
    )
      return;
    el.focus();
    const end = el.value.length;
    el.setSelectionRange(end, end);
    selectionRef.current = { start: end, end };
  }, [composerFocusVersion, mode]);

  useEffect(() => {
    if (!tauriAvailable()) return;

    // Desktop OS file drops must use Tauri native DnD: WebView File objects can
    // expose only file.name on Windows. In-app project drags keep using HTML5.
    let disposed = false;
    let unlisten: (() => void) | undefined;

    const setup = async () => {
      const { getCurrentWebview } = await import("@tauri-apps/api/webview");
      const dispose = await getCurrentWebview().onDragDropEvent((event) => {
        if (disposed) return;
        const payload = event.payload;
        const el = inputDropRef.current ?? inputRef.current;

        if (payload.type === "leave") {
          setDropActive(false);
          return;
        }
        if (!el || isReadOnly) {
          setDropActive(false);
          return;
        }
        if (payload.type === "enter") {
          setDropActive(pointInsideElement(payload.position, el));
          return;
        }
        if (payload.type === "over") {
          setDropActive(pointInsideElement(payload.position, el));
          return;
        }
        if (payload.type === "drop") {
          const inside = pointInsideElement(payload.position, el);
          setDropActive(false);
          if (!inside) return;
          if (activeRemoteWorkspaceRoot) {
            void Promise.allSettled(
              payload.paths.map((path) =>
                uploadLocalPathToRemote(activeRemoteWorkspaceRoot, path),
              ),
            ).then((results) => {
              const paths = uploadedPathsFromResults(results, { remote: true });
              if (paths.length > 0) insertFilePaths(paths);
            });
            return;
          }
          insertFilePaths(payload.paths);
        }
      });
      if (disposed) {
        dispose();
        return;
      }
      unlisten = dispose;
    };

    void setup().catch(() => {
      if (!disposed) setDropActive(false);
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [
    activeRemoteWorkspaceRoot,
    insertFilePaths,
    isReadOnly,
    uploadedPathsFromResults,
  ]);

  useEffect(() => {
    const onProjectFileDragMove = (event: Event) => {
      const { detail } = event as CustomEvent<ProjectFileDragMoveDetail>;
      if (!detail?.paths?.length) return;
      updateProjectDragFeedbackAtPoint(detail);
    };

    const onProjectFileDragOver = (event: DragEvent) => {
      if (!event.dataTransfer || !hasProjectFileDragData(event.dataTransfer)) {
        return;
      }

      const accepted = updateProjectDragFeedbackAtPoint(event);
      if (!accepted) return;

      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      applyProjectFileDragDropEffect(event.dataTransfer);
    };

    window.addEventListener(
      PROJECT_FILE_DRAG_MOVE_EVENT,
      onProjectFileDragMove,
    );
    window.addEventListener("dragenter", onProjectFileDragOver, true);
    window.addEventListener("dragover", onProjectFileDragOver, true);
    return () => {
      window.removeEventListener(
        PROJECT_FILE_DRAG_MOVE_EVENT,
        onProjectFileDragMove,
      );
      window.removeEventListener("dragenter", onProjectFileDragOver, true);
      window.removeEventListener("dragover", onProjectFileDragOver, true);
      setProjectFileDragAccepted(false);
    };
  }, [updateProjectDragFeedbackAtPoint]);

  useEffect(() => {
    const onProjectFileDragEnd = (event: Event) => {
      const { detail } = event as CustomEvent<ProjectFileDragEndDetail>;
      const el = inputDropRef.current ?? inputRef.current;
      setDropActive(false);
      setProjectFileDragAccepted(false);

      if (!el || isReadOnly || !detail?.paths?.length) return;
      if (!clientPointInsideElement(detail, el)) return;

      closeComposerSuggestions();
      if (activeRemoteWorkspaceRoot) {
        const remotePaths = remoteProjectDragInsertPaths(
          activeRemoteWorkspaceRoot,
          detail.paths,
          detail.relativePaths,
        );
        if (remotePaths.length > 0) {
          insertFilePaths(remotePaths);
          return;
        }
        void Promise.allSettled(
          detail.paths.map((path) =>
            uploadLocalPathToRemote(activeRemoteWorkspaceRoot, path),
          ),
        ).then((results) => {
          const paths = uploadedPathsFromResults(results, { remote: true });
          if (paths.length > 0) insertFilePaths(paths);
        });
        return;
      }
      insertFilePaths(detail.paths);
    };

    window.addEventListener(PROJECT_FILE_DRAG_END_EVENT, onProjectFileDragEnd);
    return () => {
      window.removeEventListener(
        PROJECT_FILE_DRAG_END_EVENT,
        onProjectFileDragEnd,
      );
    };
  }, [
    activeRemoteWorkspaceRoot,
    closeComposerSuggestions,
    insertFilePaths,
    isReadOnly,
    uploadedPathsFromResults,
  ]);

  // Re-clamp the input width when the window (and thus the dock) resizes so
  // neither pane collapses below its minimum.
  useLayoutEffect(() => {
    const onResize = () => setRenderedInputWidth(clampInputWidth(inputWidth));
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [clampInputWidth, inputWidth]);

  // Drag the top edge to resize. The panel is anchored to the bottom, so
  // dragging up (smaller clientY) increases height.
  const onResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startY = e.clientY;
      const startHeight = height;
      document.body.style.userSelect = "none";
      document.body.style.cursor = "row-resize";

      const onMove = (ev: MouseEvent) => {
        setHeight(clampHeight(startHeight - (ev.clientY - startY)));
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        window.removeEventListener("blur", onUp);
        document.body.style.removeProperty("user-select");
        document.body.style.removeProperty("cursor");
        setHeight((h) => {
          saveDockHeight(h);
          return h;
        });
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      window.addEventListener("blur", onUp);
    },
    [height],
  );

  // Drag the vertical divider between the AI-return (left) and AI-input
  // (right) panes. Dragging left (smaller clientX) widens the input pane.
  const onSplitStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = renderedInputWidth;
      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";

      const onMove = (ev: MouseEvent) => {
        const next = clampInputWidth(startWidth - (ev.clientX - startX));
        setInputWidth(next);
        setRenderedInputWidth(next);
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        window.removeEventListener("blur", onUp);
        document.body.style.removeProperty("user-select");
        document.body.style.removeProperty("cursor");
        setInputWidth((w) => {
          savePaneWidth(INPUT_WIDTH_KEY, w);
          return w;
        });
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      window.addEventListener("blur", onUp);
    },
    [renderedInputWidth, clampInputWidth],
  );

  // Drag the horizontal divider between the AI-return (top) and AI-input
  // (bottom) areas in 'chat' layout. Dragging down (larger clientY) shrinks the
  // input area; dragging up grows it.
  const onChatSplitStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startY = e.clientY;
      const startHeight = renderedChatInputHeight;
      document.body.style.userSelect = "none";
      document.body.style.cursor = "row-resize";

      const onMove = (ev: MouseEvent) => {
        setChatInputHeight(
          clampChatInputHeight(startHeight - (ev.clientY - startY)),
        );
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        window.removeEventListener("blur", onUp);
        document.body.style.removeProperty("user-select");
        document.body.style.removeProperty("cursor");
        setChatInputHeight((h) => {
          savePaneWidth(CHAT_INPUT_HEIGHT_KEY, h);
          return h;
        });
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      window.addEventListener("blur", onUp);
    },
    [renderedChatInputHeight],
  );

  // Capture the whole conversation as a long screenshot. Forces every message
  // to its rich renderer first (so off-screen placeholders don't leak into the
  // image), waits two frames + a short settle for markdown/highlight/katex to
  // paint, then rasterizes the full scroll box (auto-paged when very long).
  const runSessionScreenshot = useCallback(async () => {
    const zh = locale === "zh-CN";
    if (captureInFlightRef.current) return;
    // Echo the command so the action is visible in the transcript even if the
    // capture itself no-ops or fails.
    appendChatNote("/screenshot", "user");
    const el = streamRef.current;
    if (!el) {
      appendChatNote(
        zh
          ? "✗ 截图失败：找不到会话视图。"
          : "✗ Screenshot failed: conversation view not found.",
      );
      return;
    }
    if (messages.length === 0) {
      appendChatNote(
        zh
          ? "当前会话为空，没有可截图的内容。"
          : "Conversation is empty — nothing to capture.",
      );
      return;
    }
    captureInFlightRef.current = true;
    setForceEagerCapture(true);
    setCaptureStatus({
      kind: "busy",
      text: zh ? "正在生成长截图…" : "Capturing…",
    });
    const nextFrame = () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    try {
      // Let the forced rich renderers mount and lay out before we rasterize.
      await nextFrame();
      await nextFrame();
      await new Promise((resolve) => setTimeout(resolve, 350));
      const result = await captureConversation(el, {
        cwd: workspaceCwd || undefined,
        save: activeRemoteWorkspaceRoot
          ? (request) =>
              saveRemoteSessionCapture(activeRemoteWorkspaceRoot, request)
          : undefined,
      });
      const preview = result.previewDataUrl
        ? `\n\n![${zh ? "截图预览" : "screenshot preview"}](${result.previewDataUrl})`
        : "";
      let note: string;
      let status: string;
      if (result.destination === "browser-download") {
        status = zh
          ? `已下载长截图（${result.pages} 张）`
          : `Downloaded ${result.pages} image(s)`;
        note =
          (zh
            ? `✓ 已截图当前会话（${result.pages} 张），已通过浏览器下载到默认下载目录。`
            : `✓ Captured this conversation (${result.pages} image(s)) — downloaded via your browser.`) +
          preview;
      } else {
        const paths =
          result.paths.length > 0
            ? result.paths
            : result.destination.split("\n").filter(Boolean);
        status = result.stitched
          ? zh
            ? `已保存 ${result.pages} 张拼接长图`
            : `Saved ${result.pages} stitched pages`
          : zh
            ? "已保存长截图"
            : "Screenshot saved";
        const pathLines = paths.map((p) => `- \`${p}\``).join("\n");
        note =
          (zh
            ? `✓ 已截图当前会话${result.stitched ? `（${result.pages} 张拼接长图）` : ""}，保存到（点击路径可预览）：\n${pathLines}`
            : `✓ Captured this conversation${result.stitched ? ` (${result.pages} stitched pages)` : ""}, saved to (click a path to preview):\n${pathLines}`) +
          preview;
      }
      appendChatNote(note);
      setCaptureStatus({ kind: "done", text: status });
    } catch (err) {
      const msg = friendlyCaptureError(err, locale);
      setCaptureStatus({
        kind: "error",
        text: (zh ? "截图失败：" : "Capture failed: ") + msg,
      });
      appendChatNote((zh ? "✗ 截图失败：" : "✗ Screenshot failed: ") + msg);
    } finally {
      setForceEagerCapture(false);
      captureInFlightRef.current = false;
    }
  }, [
    activeRemoteWorkspaceRoot,
    messages.length,
    locale,
    appendChatNote,
    workspaceCwd,
  ]);

  // Record the whole conversation as a top-to-bottom scrolling GIF. Shares the
  // same eager-render + settle machinery as the static screenshot, then hands
  // the expanded stream to the GIF recorder (renders once, scrolls in frames).
  const runSessionGif = useCallback(async () => {
    const zh = locale === "zh-CN";
    if (captureInFlightRef.current) return;
    appendChatNote("/screenshot-gif", "user");
    const el = streamRef.current;
    if (!el) {
      appendChatNote(
        zh
          ? "✗ GIF 录制失败：找不到会话视图。"
          : "✗ GIF recording failed: conversation view not found.",
      );
      return;
    }
    if (messages.length === 0) {
      appendChatNote(
        zh
          ? "当前会话为空，没有可录制的内容。"
          : "Conversation is empty — nothing to record.",
      );
      return;
    }
    captureInFlightRef.current = true;
    setForceEagerCapture(true);
    setCaptureStatus({
      kind: "busy",
      text: zh ? "正在录制 GIF…" : "Recording GIF…",
    });
    const nextFrame = () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    try {
      await nextFrame();
      await nextFrame();
      await new Promise((resolve) => setTimeout(resolve, 350));
      const result = await recordConversationGif(el, {
        cwd: workspaceCwd || undefined,
        save: activeRemoteWorkspaceRoot
          ? (request) =>
              saveRemoteSessionCapture(activeRemoteWorkspaceRoot, request)
          : undefined,
      });
      const preview = result.previewDataUrl
        ? `\n\n![${zh ? "GIF 预览" : "GIF preview"}](${result.previewDataUrl})`
        : "";
      let note: string;
      let status: string;
      if (result.destination === "browser-download") {
        status = zh
          ? `已下载 GIF（${result.frames} 帧）`
          : `Downloaded GIF (${result.frames} frames)`;
        note =
          (zh
            ? `✓ 已把当前会话录成滚动 GIF（${result.frames} 帧），已通过浏览器下载到默认下载目录。`
            : `✓ Recorded this conversation as a scrolling GIF (${result.frames} frames) — downloaded via your browser.`) +
          preview;
      } else {
        const paths =
          result.paths.length > 0
            ? result.paths
            : [result.destination].filter(Boolean);
        const pathLines = paths.map((p) => `- \`${p}\``).join("\n");
        status = zh
          ? `已保存 GIF（${result.frames} 帧）`
          : `Saved GIF (${result.frames} frames)`;
        note =
          (zh
            ? `✓ 已把当前会话录成滚动 GIF（${result.frames} 帧），保存到（点击路径可预览）：\n${pathLines}`
            : `✓ Recorded this conversation as a scrolling GIF (${result.frames} frames), saved to (click the path to preview):\n${pathLines}`) +
          preview;
      }
      appendChatNote(note);
      setCaptureStatus({ kind: "done", text: status });
    } catch (err) {
      const msg = friendlyCaptureError(err, locale);
      setCaptureStatus({
        kind: "error",
        text: (zh ? "GIF 录制失败：" : "GIF recording failed: ") + msg,
      });
      appendChatNote(
        (zh ? "✗ GIF 录制失败：" : "✗ GIF recording failed: ") + msg,
      );
    } finally {
      setForceEagerCapture(false);
      captureInFlightRef.current = false;
    }
  }, [
    activeRemoteWorkspaceRoot,
    messages.length,
    locale,
    appendChatNote,
    workspaceCwd,
  ]);

  // Auto-dismiss the screenshot status banner once it settles (keep the
  // "busy" state until capture finishes).
  useEffect(() => {
    if (!captureStatus || captureStatus.kind === "busy") return;
    const timer = setTimeout(() => setCaptureStatus(null), 4000);
    return () => clearTimeout(timer);
  }, [captureStatus]);

  const submit = (
    overrideText?: string,
    options: { clearDraft?: boolean } = {},
  ) => {
    const text = (overrideText ?? draft).trim();
    if (!text) return;
    closeComposerSuggestions();
    const submitSlashGuardChannel = slashGuardChannelForText(text, composer);
    let submitSlashGuardSettings = slashGuardSettings;
    if (
      slashChannelNeedsAIDockGenerationSettings(submitSlashGuardChannel) &&
      !generationSettingsReady
    ) {
      const loaded = loadAIDockGenerationSettings(
        generationSettingsProfileId,
        generationSettingsProfile,
      );
      setGenerationSettingsState(loaded);
      submitSlashGuardSettings = {
        image: loaded.image,
        music: loaded.music,
        threeD: loaded.threeD,
        video: loaded.video,
        speech: loaded.speech,
      };
    }
    const sendGuard = guardSlashCommandText(
      text,
      composer,
      submitSlashGuardSettings,
    );
    if (sendGuard && !sendGuard.ok) {
      useStore.setState({
        blockedSendTip: {
          kind: "slash-command-unavailable",
          message: sendGuard.message ?? "当前指令缺少必要渠道配置。",
        },
      });
      return;
    }
    // The user is sending something — always follow the new content to the
    // bottom regardless of where they had scrolled. We pin intent here so a
    // stale non-bottom snapshot can't suppress the post-render scroll.
    pinActiveStreamToBottom();
    const clearDraftIfNeeded = () => {
      if (overrideText === undefined || options.clearDraft) {
        setComposerDraft("");
        draftRef.current = "";
        selectionRef.current = { start: 0, end: 0 };
      }
    };
    // Session capture commands run regardless of read-only / active-editing
    // state (they only read the DOM, never touch the workflow), and are checked
    // before the guard below so they never silently no-op. GIF is matched before
    // /screenshot so the `-gif` suffix isn't swallowed by the screenshot matcher.
    if (/^\/(?:screenshot-gif|gif|录制gif|滚动gif)\s*$/iu.test(text)) {
      clearDraftIfNeeded();
      void runSessionGif();
      return;
    }
    if (/^\/(?:screenshot|截图|长图)\s*$/iu.test(text)) {
      clearDraftIfNeeded();
      void runSessionScreenshot();
      return;
    }
    if (isReadOnly || activeAiEditing) return;
    const learningCommand = /^\/(learn|refine)(?:\s+([\s\S]*))?$/i.exec(text);
    if (learningCommand) {
      const kind = learningCommand[1].toLowerCase() as "learn" | "refine";
      const lesson = (learningCommand[2] ?? "").trim();
      if (kind === "learn" && !lesson) {
        useStore.setState({ blockedSendTip: {
          kind: "slash-command-unavailable",
          message: locale === "zh-CN" ? "/learn 需要填写要学习的经验文本。" : "/learn requires the lesson text to learn.",
        } });
        return;
      }
      if (learnSkills(kind, lesson)) clearDraftIfNeeded();
      return;
    }
    const gddModeStart = /^\/gdd-mode-start(?:\s+([\s\S]*))?$/i.exec(text);
    if (gddModeStart) {
      const wasGddMode = composer.gddMode;
      const startedAt = wasGddMode
        ? (composer.gddModeStartedAt ?? Date.now())
        : Date.now();
      setComposer({
        gddMode: true,
        gddModeStartedAt: startedAt,
        imageMode: false,
        imageModeStartedAt: null,
        musicMode: false,
        musicModeStartedAt: null,
        threeDMode: false,
        threeDModeStartedAt: null,
        comfyMode: false,
        comfyModeStartedAt: null,
        videoMode: false,
        videoModeStartedAt: null,
        animationMode: false,
        animationModeStartedAt: null,
        spriteMode: false,
        spriteModeStartedAt: null,
        speechMode: false,
        speechModeStartedAt: null,
        uiMode: false,
        uiModeStartedAt: null,
        metahumanMode: false,
        metahumanModeStartedAt: null,
        worldMode: false,
        worldModeStartedAt: null,
        blueprintMode: false,
        blueprintModeStartedAt: null,
        blueprintModeArgs: null,
      });
      clearDraftIfNeeded();
      if (!wasGddMode) {
        appendChatNote(t(locale, "dock.gddModeEntered"), "system");
      }
      const prompt = (gddModeStart[1] ?? "").trim();
      if (prompt) generateGddPrompt(prompt);
      return;
    }
    const gddModeEnd = /^\/gdd-mode-end(?:\s+([\s\S]*))?$/i.exec(text);
    if (gddModeEnd) {
      const wasGddMode = composer.gddMode;
      setComposer({ gddMode: false, gddModeStartedAt: null });
      clearDraftIfNeeded();
      if (wasGddMode) {
        appendChatNote(t(locale, "dock.gddModeExited"), "system");
      }
      const prompt = (gddModeEnd[1] ?? "").trim();
      if (wasGddMode || prompt) generateGddPrompt(prompt, { finalize: true });
      return;
    }
    // Sticky image mode toggles. The command enters/leaves image mode; the input
    // background + placeholder reflect the mode. Any text typed after the command
    // on the same line is treated as a first image prompt (so picking the command
    // from the suggestion menu and typing right after it still works).
    const imageModeStart = /^\/image-mode-start(?:\s+([\s\S]*))?$/i.exec(text);
    if (imageModeStart) {
      const wasImageMode = composer.imageMode;
      const startedAt = wasImageMode
        ? (composer.imageModeStartedAt ?? Date.now())
        : Date.now();
      setComposer({
        gddMode: false,
        gddModeStartedAt: null,
        imageMode: true,
        imageModeStartedAt: startedAt,
        musicMode: false,
        musicModeStartedAt: null,
        threeDMode: false,
        threeDModeStartedAt: null,
        videoMode: false,
        videoModeStartedAt: null,
        animationMode: false,
        animationModeStartedAt: null,
        spriteMode: false,
        spriteModeStartedAt: null,
        speechMode: false,
        speechModeStartedAt: null,
        uiMode: false,
        uiModeStartedAt: null,
        metahumanMode: false,
        metahumanModeStartedAt: null,
        worldMode: false,
        worldModeStartedAt: null,
      });
      clearDraftIfNeeded();
      if (!wasImageMode) {
        appendChatNote(t(locale, "dock.imageModeEntered"), "system");
      }
      const prompt = (imageModeStart[1] ?? "").trim();
      if (prompt) generateImagePrompt(prompt);
      return;
    }
    const imageModeEnd = /^\/image-mode-end(?:\s+([\s\S]*))?$/i.exec(text);
    if (imageModeEnd) {
      const wasImageMode = composer.imageMode;
      setComposer({ imageMode: false, imageModeStartedAt: null });
      clearDraftIfNeeded();
      if (wasImageMode) {
        appendChatNote(t(locale, "dock.imageModeExited"), "system");
      }
      return;
    }
    const imageMatch =
      /^\/(?:image|img|draw|生图|画图|绘图|出图)(?:\s+([\s\S]*))?$/iu.exec(
        text,
      );
    if (imageMatch) {
      const prompt = (imageMatch[1] ?? "").trim();
      if (!prompt) return;
      generateImagePrompt(text);
      clearDraftIfNeeded();
      return;
    }
    const musicModeStart = /^\/music-mode-start(?:\s+([\s\S]*))?$/i.exec(text);
    if (musicModeStart) {
      const wasMusicMode = composer.musicMode;
      const startedAt = wasMusicMode
        ? (composer.musicModeStartedAt ?? Date.now())
        : Date.now();
      setComposer({
        gddMode: false,
        gddModeStartedAt: null,
        imageMode: false,
        imageModeStartedAt: null,
        musicMode: true,
        musicModeStartedAt: startedAt,
        threeDMode: false,
        threeDModeStartedAt: null,
        videoMode: false,
        videoModeStartedAt: null,
        animationMode: false,
        animationModeStartedAt: null,
        spriteMode: false,
        spriteModeStartedAt: null,
        speechMode: false,
        speechModeStartedAt: null,
        uiMode: false,
        uiModeStartedAt: null,
        metahumanMode: false,
        metahumanModeStartedAt: null,
        worldMode: false,
        worldModeStartedAt: null,
      });
      clearDraftIfNeeded();
      if (!wasMusicMode) {
        appendChatNote(t(locale, "dock.musicModeEntered"), "system");
      }
      const prompt = (musicModeStart[1] ?? "").trim();
      if (prompt) generateMusicPrompt(prompt);
      return;
    }
    const musicModeEnd = /^\/music-mode-end(?:\s+([\s\S]*))?$/i.exec(text);
    if (musicModeEnd) {
      const wasMusicMode = composer.musicMode;
      setComposer({ musicMode: false, musicModeStartedAt: null });
      clearDraftIfNeeded();
      if (wasMusicMode) {
        appendChatNote(t(locale, "dock.musicModeExited"), "system");
      }
      return;
    }
    const musicMatch =
      /^\/(?:music|song|audio|compose|作曲|音乐|生成音乐)(?:\s+([\s\S]*))?$/iu.exec(
        text,
      );
    if (musicMatch) {
      const prompt = (musicMatch[1] ?? "").trim();
      if (!prompt) return;
      generateMusicPrompt(text);
      clearDraftIfNeeded();
      return;
    }
    const videoModeStart = /^\/video-mode-start(?:\s+([\s\S]*))?$/i.exec(text);
    if (videoModeStart) {
      const wasVideoMode = composer.videoMode;
      const startedAt = wasVideoMode
        ? (composer.videoModeStartedAt ?? Date.now())
        : Date.now();
      setComposer({
        gddMode: false,
        gddModeStartedAt: null,
        imageMode: false,
        imageModeStartedAt: null,
        musicMode: false,
        musicModeStartedAt: null,
        threeDMode: false,
        threeDModeStartedAt: null,
        comfyMode: false,
        comfyModeStartedAt: null,
        videoMode: true,
        videoModeStartedAt: startedAt,
        animationMode: false,
        animationModeStartedAt: null,
        spriteMode: false,
        spriteModeStartedAt: null,
        speechMode: false,
        speechModeStartedAt: null,
        uiMode: false,
        uiModeStartedAt: null,
        metahumanMode: false,
        metahumanModeStartedAt: null,
        worldMode: false,
        worldModeStartedAt: null,
      });
      clearDraftIfNeeded();
      if (!wasVideoMode) {
        appendChatNote(t(locale, "dock.videoModeEntered"), "system");
      }
      const prompt = (videoModeStart[1] ?? "").trim();
      if (prompt) generateVideoPrompt(prompt);
      return;
    }
    const videoModeEnd = /^\/video-mode-end(?:\s+([\s\S]*))?$/i.exec(text);
    if (videoModeEnd) {
      const wasVideoMode = composer.videoMode;
      setComposer({ videoMode: false, videoModeStartedAt: null });
      clearDraftIfNeeded();
      if (wasVideoMode) {
        appendChatNote(t(locale, "dock.videoModeExited"), "system");
      }
      return;
    }
    const videoMatch =
      /^\/(?:video|movie|film|clip|视频|生成视频|短片)(?:\s+([\s\S]*))?$/iu.exec(
        text,
      );
    if (videoMatch) {
      const prompt = (videoMatch[1] ?? "").trim();
      if (!prompt) return;
      generateVideoPrompt(text);
      clearDraftIfNeeded();
      return;
    }
    const animationModeStart = /^\/anim-mode-start(?:\s+([\s\S]*))?$/i.exec(
      text,
    );
    if (animationModeStart) {
      const wasAnimationMode = composer.animationMode;
      const startedAt = wasAnimationMode
        ? (composer.animationModeStartedAt ?? Date.now())
        : Date.now();
      setComposer({
        gddMode: false,
        gddModeStartedAt: null,
        imageMode: false,
        imageModeStartedAt: null,
        musicMode: false,
        musicModeStartedAt: null,
        threeDMode: false,
        threeDModeStartedAt: null,
        comfyMode: false,
        comfyModeStartedAt: null,
        videoMode: false,
        videoModeStartedAt: null,
        animationMode: true,
        animationModeStartedAt: startedAt,
        spriteMode: false,
        spriteModeStartedAt: null,
        speechMode: false,
        speechModeStartedAt: null,
        uiMode: false,
        uiModeStartedAt: null,
        metahumanMode: false,
        metahumanModeStartedAt: null,
        worldMode: false,
        worldModeStartedAt: null,
      });
      clearDraftIfNeeded();
      if (!wasAnimationMode) {
        appendChatNote(t(locale, "dock.animationModeEntered"), "system");
      }
      const prompt = (animationModeStart[1] ?? "").trim();
      if (prompt) generateAnimationPrompt(prompt);
      return;
    }
    const animationModeEnd = /^\/anim-mode-end(?:\s+([\s\S]*))?$/i.exec(text);
    if (animationModeEnd) {
      const wasAnimationMode = composer.animationMode;
      setComposer({ animationMode: false, animationModeStartedAt: null });
      clearDraftIfNeeded();
      if (wasAnimationMode) {
        appendChatNote(t(locale, "dock.animationModeExited"), "system");
      }
      return;
    }
    const animationMatch =
      /^\/(?:anim|animation|motion|mocap|动画|动作|动作库)(?:\s+([\s\S]*))?$/iu.exec(
        text,
      );
    if (animationMatch) {
      const prompt = (animationMatch[1] ?? "").trim();
      if (!prompt) return;
      generateAnimationPrompt(text);
      clearDraftIfNeeded();
      return;
    }
    const speechModeStart = /^\/speech-mode-start(?:\s+([\s\S]*))?$/i.exec(
      text,
    );
    if (speechModeStart) {
      const wasSpeechMode = composer.speechMode;
      const startedAt = wasSpeechMode
        ? (composer.speechModeStartedAt ?? Date.now())
        : Date.now();
      setComposer({
        gddMode: false,
        gddModeStartedAt: null,
        imageMode: false,
        imageModeStartedAt: null,
        musicMode: false,
        musicModeStartedAt: null,
        threeDMode: false,
        threeDModeStartedAt: null,
        comfyMode: false,
        comfyModeStartedAt: null,
        videoMode: false,
        videoModeStartedAt: null,
        animationMode: false,
        animationModeStartedAt: null,
        spriteMode: false,
        spriteModeStartedAt: null,
        speechMode: true,
        speechModeStartedAt: startedAt,
        uiMode: false,
        uiModeStartedAt: null,
        metahumanMode: false,
        metahumanModeStartedAt: null,
        worldMode: false,
        worldModeStartedAt: null,
      });
      clearDraftIfNeeded();
      if (!wasSpeechMode) {
        appendChatNote(t(locale, "dock.speechModeEntered"), "system");
      }
      const prompt = (speechModeStart[1] ?? "").trim();
      if (prompt) generateSpeechPrompt(prompt);
      return;
    }
    const speechModeEnd = /^\/speech-mode-end(?:\s+([\s\S]*))?$/i.exec(text);
    if (speechModeEnd) {
      const wasSpeechMode = composer.speechMode;
      setComposer({ speechMode: false, speechModeStartedAt: null });
      clearDraftIfNeeded();
      if (wasSpeechMode) {
        appendChatNote(t(locale, "dock.speechModeExited"), "system");
      }
      return;
    }
    const speechMatch =
      /^\/(?:tts|speak|speech|say|voice|配音|朗读|语音|念)(?:\s+([\s\S]*))?$/iu.exec(
        text,
      );
    if (speechMatch) {
      const prompt = (speechMatch[1] ?? "").trim();
      if (!prompt) return;
      generateSpeechPrompt(text);
      clearDraftIfNeeded();
      return;
    }
    const spriteModeStart = /^\/sprite-mode-start(?:\s+([\s\S]*))?$/i.exec(
      text,
    );
    if (spriteModeStart) {
      const wasSpriteMode = composer.spriteMode;
      const startedAt = wasSpriteMode
        ? (composer.spriteModeStartedAt ?? Date.now())
        : Date.now();
      setComposer({
        gddMode: false,
        gddModeStartedAt: null,
        imageMode: false,
        imageModeStartedAt: null,
        musicMode: false,
        musicModeStartedAt: null,
        threeDMode: false,
        threeDModeStartedAt: null,
        comfyMode: false,
        comfyModeStartedAt: null,
        videoMode: false,
        videoModeStartedAt: null,
        animationMode: false,
        animationModeStartedAt: null,
        spriteMode: true,
        spriteModeStartedAt: startedAt,
        speechMode: false,
        speechModeStartedAt: null,
        uiMode: false,
        uiModeStartedAt: null,
        metahumanMode: false,
        metahumanModeStartedAt: null,
        worldMode: false,
        worldModeStartedAt: null,
      });
      clearDraftIfNeeded();
      if (!wasSpriteMode) {
        appendChatNote(t(locale, "dock.spriteModeEntered"), "system");
      }
      const prompt = (spriteModeStart[1] ?? "").trim();
      if (prompt) generateSpritePrompt(prompt);
      return;
    }
    const spriteModeEnd = /^\/sprite-mode-end(?:\s+([\s\S]*))?$/i.exec(text);
    if (spriteModeEnd) {
      const wasSpriteMode = composer.spriteMode;
      setComposer({ spriteMode: false, spriteModeStartedAt: null });
      clearDraftIfNeeded();
      if (wasSpriteMode) {
        appendChatNote(t(locale, "dock.spriteModeExited"), "system");
      }
      return;
    }
    const spriteMatch =
      /^\/(?:sprite|spritesheet|sprite-sheet|精灵|精灵图|序列帧)(?:\s+([\s\S]*))?$/iu.exec(
        text,
      );
    if (spriteMatch) {
      const prompt = (spriteMatch[1] ?? "").trim();
      if (!prompt) return;
      generateSpritePrompt(text);
      clearDraftIfNeeded();
      return;
    }
    const threeDModeStart = /^\/mesh-mode-start(?:\s+([\s\S]*))?$/i.exec(text);
    if (threeDModeStart) {
      const wasThreeDMode = composer.threeDMode;
      const startedAt = wasThreeDMode
        ? (composer.threeDModeStartedAt ?? Date.now())
        : Date.now();
      setComposer({
        gddMode: false,
        gddModeStartedAt: null,
        imageMode: false,
        imageModeStartedAt: null,
        musicMode: false,
        musicModeStartedAt: null,
        threeDMode: true,
        threeDModeStartedAt: startedAt,
        videoMode: false,
        videoModeStartedAt: null,
        animationMode: false,
        animationModeStartedAt: null,
        spriteMode: false,
        spriteModeStartedAt: null,
        speechMode: false,
        speechModeStartedAt: null,
        uiMode: false,
        uiModeStartedAt: null,
        metahumanMode: false,
        metahumanModeStartedAt: null,
        worldMode: false,
        worldModeStartedAt: null,
      });
      clearDraftIfNeeded();
      if (!wasThreeDMode) {
        appendChatNote(t(locale, "dock.threeDModeEntered"), "system");
      }
      const prompt = (threeDModeStart[1] ?? "").trim();
      if (prompt) generateThreeDPrompt(prompt);
      return;
    }
    const threeDModeEnd = /^\/mesh-mode-end(?:\s+([\s\S]*))?$/i.exec(text);
    if (threeDModeEnd) {
      const wasThreeDMode = composer.threeDMode;
      setComposer({ threeDMode: false, threeDModeStartedAt: null });
      clearDraftIfNeeded();
      if (wasThreeDMode) {
        appendChatNote(t(locale, "dock.threeDModeExited"), "system");
      }
      return;
    }
    const comfyModeStart = /^\/comfyui-mode-start(?:\s+([\s\S]*))?$/i.exec(
      text,
    );
    if (comfyModeStart) {
      const wasComfyMode = composer.comfyMode;
      const startedAt = wasComfyMode
        ? (composer.comfyModeStartedAt ?? Date.now())
        : Date.now();
      setComposer({
        gddMode: false,
        gddModeStartedAt: null,
        imageMode: false,
        imageModeStartedAt: null,
        musicMode: false,
        musicModeStartedAt: null,
        threeDMode: false,
        threeDModeStartedAt: null,
        comfyMode: true,
        comfyModeStartedAt: startedAt,
        videoMode: false,
        videoModeStartedAt: null,
        animationMode: false,
        animationModeStartedAt: null,
        spriteMode: false,
        spriteModeStartedAt: null,
        speechMode: false,
        speechModeStartedAt: null,
        uiMode: false,
        uiModeStartedAt: null,
        metahumanMode: false,
        metahumanModeStartedAt: null,
        worldMode: false,
        worldModeStartedAt: null,
      });
      clearDraftIfNeeded();
      if (!wasComfyMode) {
        appendChatNote(t(locale, "dock.comfyModeEntered"), "system");
      }
      const prompt = (comfyModeStart[1] ?? "").trim();
      if (prompt) generateComfyPrompt(prompt);
      return;
    }
    const comfyModeEnd = /^\/comfyui-mode-end(?:\s+([\s\S]*))?$/i.exec(text);
    if (comfyModeEnd) {
      const wasComfyMode = composer.comfyMode;
      setComposer({ comfyMode: false, comfyModeStartedAt: null });
      clearDraftIfNeeded();
      if (wasComfyMode) {
        appendChatNote(t(locale, "dock.comfyModeExited"), "system");
      }
      return;
    }
    const worldModeStart =
      /^\/(?:worldmodel|world-model)-mode-start(?:\s+([\s\S]*))?$/i.exec(text);
    if (worldModeStart) {
      const wasWorldMode = composer.worldMode;
      const startedAt = wasWorldMode
        ? (composer.worldModeStartedAt ?? Date.now())
        : Date.now();
      setComposer({
        gddMode: false,
        gddModeStartedAt: null,
        imageMode: false,
        imageModeStartedAt: null,
        musicMode: false,
        musicModeStartedAt: null,
        threeDMode: false,
        threeDModeStartedAt: null,
        comfyMode: false,
        comfyModeStartedAt: null,
        videoMode: false,
        videoModeStartedAt: null,
        animationMode: false,
        animationModeStartedAt: null,
        spriteMode: false,
        spriteModeStartedAt: null,
        speechMode: false,
        speechModeStartedAt: null,
        uiMode: false,
        uiModeStartedAt: null,
        metahumanMode: false,
        metahumanModeStartedAt: null,
        worldMode: true,
        worldModeStartedAt: startedAt,
      });
      clearDraftIfNeeded();
      if (!wasWorldMode) {
        appendChatNote(t(locale, "dock.worldModeEntered"), "system");
      }
      const prompt = (worldModeStart[1] ?? "").trim();
      if (prompt) generateWorldPrompt(prompt);
      return;
    }
    const worldModeEnd =
      /^\/(?:worldmodel|world-model)-mode-end(?:\s+([\s\S]*))?$/i.exec(text);
    if (worldModeEnd) {
      const wasWorldMode = composer.worldMode;
      setComposer({ worldMode: false, worldModeStartedAt: null });
      clearDraftIfNeeded();
      if (wasWorldMode) {
        appendChatNote(t(locale, "dock.worldModeExited"), "system");
      }
      return;
    }
    const worldMatch =
      /^\/(?:worldmodel|world-model|世界模型)(?:\s+([\s\S]*))?$/iu.exec(text);
    if (worldMatch) {
      const prompt = (worldMatch[1] ?? "").trim();
      if (!prompt) return;
      generateWorldPrompt(text);
      clearDraftIfNeeded();
      return;
    }
    const uiModeStart = /^\/ui-mode-start(?:\s+([\s\S]*))?$/i.exec(text);
    if (uiModeStart) {
      const wasUiMode = composer.uiMode;
      const startedAt = wasUiMode
        ? (composer.uiModeStartedAt ?? Date.now())
        : Date.now();
      setComposer({
        gddMode: false,
        gddModeStartedAt: null,
        imageMode: false,
        imageModeStartedAt: null,
        musicMode: false,
        musicModeStartedAt: null,
        threeDMode: false,
        threeDModeStartedAt: null,
        comfyMode: false,
        comfyModeStartedAt: null,
        videoMode: false,
        videoModeStartedAt: null,
        animationMode: false,
        animationModeStartedAt: null,
        spriteMode: false,
        spriteModeStartedAt: null,
        speechMode: false,
        speechModeStartedAt: null,
        uiMode: true,
        uiModeStartedAt: startedAt,
        metahumanMode: false,
        metahumanModeStartedAt: null,
        worldMode: false,
        worldModeStartedAt: null,
      });
      clearDraftIfNeeded();
      if (!wasUiMode) {
        appendChatNote(t(locale, "dock.uiModeEntered"), "system");
      }
      const prompt = (uiModeStart[1] ?? "").trim();
      if (prompt) generateUiPrompt(prompt);
      return;
    }
    const uiModeEnd = /^\/ui-mode-end(?:\s+([\s\S]*))?$/i.exec(text);
    if (uiModeEnd) {
      const wasUiMode = composer.uiMode;
      setComposer({ uiMode: false, uiModeStartedAt: null });
      clearDraftIfNeeded();
      if (wasUiMode) {
        appendChatNote(t(locale, "dock.uiModeExited"), "system");
      }
      return;
    }
    const metahumanModeStart =
      /^\/metahuman-mode-start(?:\s+([\s\S]*))?$/i.exec(text);
    if (metahumanModeStart) {
      const wasMetaHumanMode = composer.metahumanMode;
      const startedAt = wasMetaHumanMode
        ? (composer.metahumanModeStartedAt ?? Date.now())
        : Date.now();
      setComposer({
        gddMode: false,
        gddModeStartedAt: null,
        imageMode: false,
        imageModeStartedAt: null,
        musicMode: false,
        musicModeStartedAt: null,
        threeDMode: false,
        threeDModeStartedAt: null,
        comfyMode: false,
        comfyModeStartedAt: null,
        videoMode: false,
        videoModeStartedAt: null,
        animationMode: false,
        animationModeStartedAt: null,
        spriteMode: false,
        spriteModeStartedAt: null,
        speechMode: false,
        speechModeStartedAt: null,
        uiMode: false,
        uiModeStartedAt: null,
        blueprintMode: false,
        blueprintModeStartedAt: null,
        blueprintModeArgs: null,
        worldMode: false,
        worldModeStartedAt: null,
        metahumanMode: true,
        metahumanModeStartedAt: startedAt,
      });
      clearDraftIfNeeded();
      if (!wasMetaHumanMode) {
        appendChatNote(t(locale, "dock.metahumanModeEntered"), "system");
      }
      const prompt = (metahumanModeStart[1] ?? "").trim();
      if (prompt) generateMetaHumanPrompt(prompt);
      return;
    }
    const metahumanModeEnd = /^\/metahuman-mode-end(?:\s+([\s\S]*))?$/i.exec(
      text,
    );
    if (metahumanModeEnd) {
      const wasMetaHumanMode = composer.metahumanMode;
      setComposer({ metahumanMode: false, metahumanModeStartedAt: null });
      clearDraftIfNeeded();
      if (wasMetaHumanMode) {
        appendChatNote(t(locale, "dock.metahumanModeExited"), "system");
      }
      return;
    }
    const blueprintModeStart =
      /^\/blueprint-mode-start(?:\s+([\s\S]*))?$/i.exec(text);
    if (blueprintModeStart) {
      clearDraftIfNeeded();
      void startBlueprintModeFromCommand((blueprintModeStart[1] ?? "").trim());
      return;
    }
    const blueprintModeEnd = /^\/blueprint-mode-end(?:\s+([\s\S]*))?$/i.exec(
      text,
    );
    if (blueprintModeEnd) {
      const wasBlueprintMode = composer.blueprintMode;
      setComposer({
        blueprintMode: false,
        blueprintModeStartedAt: null,
        blueprintModeArgs: null,
      });
      clearDraftIfNeeded();
      if (wasBlueprintMode) {
        appendChatNote(
          locale === "zh-CN"
            ? "↩ 已退出 UE 蓝图模式 · 已切回 AI 编程渠道与模型"
            : "↩ UE Blueprint mode off · switched back to the AI coding channel and model",
          "system",
        );
      }
      return;
    }
    const threeDMatch =
      /^\/(?:3d|3d-model|model3d|three-d|三维|3d模型|生成3d)(?:\s+([\s\S]*))?$/iu.exec(
        text,
      );
    if (threeDMatch) {
      const prompt = (threeDMatch[1] ?? "").trim();
      if (!prompt) return;
      generateThreeDPrompt(text);
      clearDraftIfNeeded();
      return;
    }
    const meshSearchMatch =
      /^\/(?:mesh-search|model-search|asset-search|搜模型|搜索模型|找模型)(?:\s+([\s\S]*))?$/iu.exec(
        text,
      );
    if (meshSearchMatch) {
      const query = (meshSearchMatch[1] ?? "").trim();
      if (!query) return;
      searchMeshLibraryPrompt(text);
      clearDraftIfNeeded();
      return;
    }
    const studioMatch = /^\/studio(?:\s+([\s\S]*))?$/i.exec(text);
    if (studioMatch) {
      appendChatNote(
        locale === "zh-CN"
          ? "已关闭 /studio 动态多智能体编排。请直接描述编程、文档或分析需求，默认由当前编程模型单模型总控处理；素材生成、引擎识别、文件操作和验证仍由 UltraGameStudio 的专用能力承接。"
          : "/studio dynamic multi-agent orchestration is disabled. Describe the coding, writing, or analysis task directly; the current coding model handles it as the single controller, while UltraGameStudio keeps specialized asset, engine, file, and verification capabilities.",
        "system",
      );
      if (overrideText === undefined || options.clearDraft) {
        setComposerDraft("");
        draftRef.current = "";
        selectionRef.current = { start: 0, end: 0 };
      }
      return;
    }
    const deepResearchMatch = /^\/deep-research(?:\s+([\s\S]*))?$/i.exec(text);
    if (deepResearchMatch) {
      appendChatNote(
        locale === "zh-CN"
          ? "已移除 UltraGameStudio 内置 /deep-research Skill。需要调研时请直接描述问题，当前编程模型会按普通对话/工具能力处理；是否拆分检索、复核或写报告由模型根据任务自行决定。"
          : "The built-in UltraGameStudio /deep-research Skill has been removed. Describe the research request directly; the current coding model will decide whether search, verification, or reporting should be split.",
        "system",
      );
      if (overrideText === undefined || options.clearDraft) {
        setComposerDraft("");
        draftRef.current = "";
        selectionRef.current = { start: 0, end: 0 };
      }
      return;
    }
    // Sticky image mode: bare text (no slash command matched above) generates an
    // image instead of editing the workflow. Slash commands still win so the user
    // can drop a /studio or /plan without leaving image mode.
    if (composer.gddMode && !text.startsWith("/")) {
      generateGddPrompt(text);
      clearDraftIfNeeded();
      return;
    }
    if (composer.imageMode && !text.startsWith("/")) {
      generateImagePrompt(text);
      clearDraftIfNeeded();
      return;
    }
    if (composer.musicMode && !text.startsWith("/")) {
      generateMusicPrompt(text);
      clearDraftIfNeeded();
      return;
    }
    if (composer.threeDMode && !text.startsWith("/")) {
      generateThreeDPrompt(text);
      clearDraftIfNeeded();
      return;
    }
    if (composer.videoMode && !text.startsWith("/")) {
      generateVideoPrompt(text);
      clearDraftIfNeeded();
      return;
    }
    if (composer.animationMode && !text.startsWith("/")) {
      generateAnimationPrompt(text);
      clearDraftIfNeeded();
      return;
    }
    if (composer.speechMode && !text.startsWith("/")) {
      generateSpeechPrompt(text);
      clearDraftIfNeeded();
      return;
    }
    if (composer.spriteMode && !text.startsWith("/")) {
      generateSpritePrompt(text);
      clearDraftIfNeeded();
      return;
    }
    if (composer.comfyMode && !text.startsWith("/")) {
      generateComfyPrompt(text);
      clearDraftIfNeeded();
      return;
    }
    if (composer.worldMode && !text.startsWith("/")) {
      generateWorldPrompt(text);
      clearDraftIfNeeded();
      return;
    }
    if (composer.uiMode && !text.startsWith("/")) {
      generateUiPrompt(text);
      clearDraftIfNeeded();
      return;
    }
    if (composer.metahumanMode && !text.startsWith("/")) {
      generateMetaHumanPrompt(text);
      clearDraftIfNeeded();
      return;
    }
    if (composer.blueprintMode && !text.startsWith("/")) {
      generateBlueprintPrompt(text);
      clearDraftIfNeeded();
      return;
    }
    // Explicit game-expert / producer invocation. Supports both whole-team
    // routing via a root alias (`/game`, `/游戏专家`, multilingual) and
    // hierarchical drill-down by `/`-separated levels — `/游戏专家/编程/引擎程序`
    // (root → group → expert) or a direct leaf `/引擎程序`. Resolution is
    // locale-agnostic, so any UI language can name the group/expert. The
    // experts never auto-fire from chat text, so this command is the opt-in.
    const gameCommand = parseGameExpertCommand(text, gameExpertSettings);
    if (gameCommand) {
      const { task, expertIds } = gameCommand;
      if (!task || activeChatting) return;
      void (async () => {
        if (!(await ensureSelectedLocalChannelReady())) return;
        const accepted = sendPrompt(task, {
          forceGameExperts: true,
          ...(expertIds.length > 0 ? { gameExpertIds: expertIds } : {}),
        });
        if (accepted) clearDraftIfNeeded();
      })();
      return;
    }
    const promptText = expandSlashRequest(text, [
      ...activeAdapterSlashSuggestions,
      ...gameSkillSuggestions,
    ]);
    void (async () => {
      if (!(await ensureSelectedLocalChannelReady())) return;
      // Worktree startup mode: before the very first message, prepare an
      // isolated working directory and repoint the session cwd at it. No-op for
      // 'local' mode or once the conversation has started.
      await ensureSessionStartupWorkspace();
      const accepted = sendPrompt(promptText);
      if (accepted) clearDraftIfNeeded();
    })();
  };

  const addFiles = async () => {
    if (isReadOnly) return;
    rememberSelection();
    if (activeRemoteWorkspaceRoot) {
      startRemoteFilePathPicker();
      return;
    }
    const paths = await pickComposerFiles(t(locale, "dock.addFileDialogTitle"));
    if (!paths?.length) return;
    insertFilePaths(paths);
  };

  const searchStatus = normalizedSearch
    ? searchMatches.length === 0
      ? t(locale, "dock.searchNoMatch")
      : `${activeSearchMatchIndex + 1}/${searchMatches.length}`
    : "";
  const handleCopyConversation = useCallback(async () => {
    if (messages.every((m) => m.localOnly)) {
      setCaptureStatus({
        kind: "error",
        text: t(locale, "dock.conversationEmpty"),
      });
      return;
    }
    const text = serializeConversation(messages);
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        try {
          ta.select();
          document.execCommand("copy");
        } finally {
          if (ta.parentNode) ta.parentNode.removeChild(ta);
        }
      }
      setCaptureStatus({
        kind: "done",
        text: t(locale, "dock.conversationCopied"),
      });
    } catch {
      /* clipboard unavailable — ignore */
    }
  }, [messages, locale]);
  const handleExportConversation = useCallback(async () => {
    if (messages.every((m) => m.localOnly)) {
      setCaptureStatus({
        kind: "error",
        text: t(locale, "dock.conversationEmpty"),
      });
      return;
    }
    const text = serializeConversation(messages);
    const safeTitle = (chatTitle || t(locale, "dock.newSession"))
      .replace(/[\\/:*?"<>|]/g, "_")
      .slice(0, 60);
    const filename = `${safeTitle || "conversation"}.md`;
    try {
      if (tauriAvailable()) {
        const { save } = await import("@tauri-apps/plugin-dialog");
        const picked = await save({
          defaultPath: filename,
          filters: [{ name: "Markdown", extensions: ["md"] }],
        });
        if (!picked) return;
        const target = typeof picked === "string" ? picked : String(picked);
        const { writeTextFile } = await import("@tauri-apps/plugin-fs");
        await writeTextFile(target, text);
      } else {
        const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      }
      setCaptureStatus({
        kind: "done",
        text: t(locale, "dock.conversationExported"),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setCaptureStatus({
        kind: "error",
        text: `${t(locale, "dock.exportFailed")}: ${msg}`,
      });
    }
  }, [messages, locale, chatTitle]);
  const headerActionButtonClass =
    "ugs-control flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-transparent px-2.5 text-[13px] text-fg-dim transition-colors hover:bg-border-soft hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-40";
  const openTeamDetailsFromMain = useCallback((nodeId: string) => {
    window.dispatchEvent(
      new CustomEvent(OPEN_GAME_TEAM_DETAILS_EVENT, { detail: { nodeId } }),
    );
  }, []);
  const conversationActions = isChat && (
    <>
      <button
        type="button"
        onClick={() => void handleCopyConversation()}
        title={t(locale, "dock.copyConversation")}
        aria-label={t(locale, "dock.copyConversation")}
        className={headerActionButtonClass}
      >
        <Copy size={14} strokeWidth={1.5} />
      </button>
      <button
        type="button"
        onClick={() => void handleExportConversation()}
        title={t(locale, "dock.exportConversation")}
        aria-label={t(locale, "dock.exportConversation")}
        className={headerActionButtonClass}
      >
        <ArrowDownToLine size={14} strokeWidth={1.5} />
      </button>
      <button
        type="button"
        onClick={() => newSession()}
        title={t(locale, "dock.newSession")}
        aria-label={t(locale, "dock.newSession")}
        className={headerActionButtonClass}
      >
        <Plus size={14} strokeWidth={1.5} />
      </button>
    </>
  );
  const searchToggleButton = (
    <button
      type="button"
      onClick={() => {
        if (returnSearchOpen) closeReturnSearch();
        else openReturnSearch();
      }}
      title={t(locale, "dock.searchAria")}
      aria-label={t(locale, "dock.searchAria")}
      aria-expanded={returnSearchOpen}
      aria-controls="ai-return-search"
      className={
        "flex h-7 w-7 shrink-0 items-center justify-center rounded-md border transition-colors " +
        (returnSearchOpen
          ? "border-accent bg-accent/10 text-accent"
          : "border-border bg-panel-2 text-fg-dim hover:border-accent hover:text-fg")
      }
    >
      <Search size={14} strokeWidth={1.5} />
    </button>
  );
  const composerToolButtonClass =
    "ugs-control flex h-8 shrink-0 items-center justify-center rounded-md border border-transparent bg-transparent px-2 text-[13px] text-fg-dim transition-colors hover:bg-border-soft hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-40";
  const streamNavigation = isChat && timelineMarkers.length > 0 && (
    <div
      className="ugs-stream-nav absolute bottom-4 right-2 top-4 z-20 w-8"
      aria-label={t(locale, "dock.streamNavAria")}
    >
      <button
        type="button"
        onClick={jumpStreamToTop}
        title={t(locale, "dock.navTop")}
        aria-label={t(locale, "dock.navTop")}
        className="ugs-stream-nav-edge ugs-stream-nav-edge--top"
      >
        <ChevronsUp size={13} />
      </button>
      <div
        className="ugs-stream-nav-body"
        aria-label={t(locale, "dock.streamTimelineAria")}
      >
        <div className="ugs-stream-nav-track" aria-hidden="true" />
        {timelineMarkers.map((marker) => {
          const active =
            marker.id === activeTopicMessageId ||
            marker.id === assetJumpHighlightId ||
            marker.id === pendingTimelineJumpId;
          const hidden = marker.messageIndex < hiddenMessageCount;
          const ariaLabel = t(locale, "dock.timelineMarker")
            .replace("{index}", String(marker.number))
            .replace("{summary}", marker.label);
          return (
            <button
              key={marker.id}
              type="button"
              data-ugs-timeline-marker="true"
              data-active={active ? "true" : undefined}
              data-hidden={hidden ? "true" : undefined}
              onClick={() => scrollToTimelineMessage(marker.id)}
              title={marker.label}
              aria-label={ariaLabel}
              className={cn(
                "ugs-stream-nav-marker",
                active && "ugs-stream-nav-marker--active",
              )}
              style={{ top: `${marker.position}%` }}
            >
              <span className="ugs-stream-nav-tooltip">{marker.label}</span>
            </button>
          );
        })}
      </div>
      <button
        type="button"
        onClick={jumpStreamToBottom}
        title={t(locale, "dock.navBottom")}
        aria-label={t(locale, "dock.navBottom")}
        className="ugs-stream-nav-edge ugs-stream-nav-edge--bottom"
      >
        <ChevronsDown size={13} />
      </button>
    </div>
  );

  const channelOptions =
    generationMode === "image"
      ? imageChannelOptions
      : generationMode === "music"
        ? musicChannelOptions
        : generationMode === "threeD"
          ? threeDChannelOptions
          : generationMode === "video"
            ? videoChannelOptions
            : generationMode === "animation"
              ? animationChannelOptions
            : generationMode === "sprite"
              ? imageChannelOptions
              : generationMode === "speech"
                ? speechChannelOptions
                : channelSelectOptions;
  // 编程模式渠道才启用置顶锁定；其余生成模式只折叠不锁定。
  const isCodeChannelMode = channelOptions === channelSelectOptions;
  const channelValue =
    generationMode === "image"
      ? imageChannelValue
      : generationMode === "music"
        ? musicChannelValue
        : generationMode === "threeD"
          ? threeDChannelValue
          : generationMode === "video"
            ? videoChannelValue
            : generationMode === "animation"
              ? animationChannelValue
            : generationMode === "sprite"
              ? imageChannelValue
              : generationMode === "speech"
                ? speechChannelValue
                : channelSelectValue;
  const handleChannelChange =
    generationMode === "image"
      ? onImageChannelChange
      : generationMode === "music"
        ? onMusicChannelChange
        : generationMode === "threeD"
          ? onThreeDChannelChange
          : generationMode === "video"
            ? onVideoChannelChange
            : generationMode === "animation"
              ? onAnimationChannelChange
            : generationMode === "sprite"
              ? onImageChannelChange
              : generationMode === "speech"
                ? onSpeechChannelChange
                : onChannelChange;
  const modelOptionsForMode =
    generationMode === "image"
      ? imageModelOptions
      : generationMode === "music"
        ? musicModelOptions
        : generationMode === "threeD"
          ? threeDModelOptions
          : generationMode === "video"
            ? videoModelOptions
            : generationMode === "animation"
              ? animationModelOptions
            : generationMode === "sprite"
              ? imageModelOptions
              : generationMode === "speech"
                ? speechModelOptions
                : modelSelectOptions;
  const modelValueForMode =
    generationMode === "image"
      ? imageModelValue
      : generationMode === "music"
        ? musicModelValue
        : generationMode === "threeD"
          ? threeDModelValue
          : generationMode === "video"
            ? videoModelValue
            : generationMode === "animation"
              ? animationModelValue
            : generationMode === "sprite"
              ? imageModelValue
              : generationMode === "speech"
                ? speechModelValue
                : modelSelectValue;
  const handleModelChange =
    generationMode === "image"
      ? onImageModelChange
      : generationMode === "music"
        ? onMusicModelChange
        : generationMode === "threeD"
          ? onThreeDModelChange
          : generationMode === "video"
            ? onVideoModelChange
            : generationMode === "animation"
              ? onAnimationModelChange
            : generationMode === "sprite"
              ? onImageModelChange
              : generationMode === "speech"
                ? onSpeechModelChange
                : onModelChange;
  const modelTitleForMode =
    generationMode === "threeD"
      ? t(locale, "dock.threeDModelTitle")
      : generationMode === "music"
        ? t(locale, "dock.musicModelTitle")
        : generationMode === "video"
          ? t(locale, "dock.videoModelTitle")
          : generationMode === "animation"
            ? t(locale, "dock.animationModelTitle")
          : generationMode === "sprite"
            ? t(locale, "dock.imageModelTitle")
            : generationMode === "speech"
              ? t(locale, "dock.speechModelTitle")
              : generationMode === "image"
                ? t(locale, "dock.imageModelTitle")
                : loadingChannelModels
                  ? t(locale, "dock.modelVersionLoading")
                  : t(locale, "dock.modelVersionTitle");
  const composerModeClass =
    composer.gddMode && !dropActive
      ? "ugs-ai-input--gdd "
      : composer.imageMode && !dropActive
      ? "ugs-ai-input--image "
      : composer.musicMode && !dropActive
        ? "ugs-ai-input--music "
        : composer.threeDMode && !dropActive
          ? "ugs-ai-input--three-d "
          : composer.videoMode && !dropActive
            ? "ugs-ai-input--video "
            : composer.animationMode && !dropActive
              ? "ugs-ai-input--animation "
            : composer.spriteMode && !dropActive
              ? "ugs-ai-input--sprite "
              : composer.speechMode && !dropActive
                ? "ugs-ai-input--speech "
                : "";
  const regenerateMessage = useCallback(
    (messageId: string) => {
      if (aiBusy) return;
      const prompt = previousUserText(messages, messageId);
      if (!prompt) return;
      submit(prompt, { clearDraft: false });
    },
    [aiBusy, messages, submit],
  );
  const regenerateMessageWithModel = useCallback(
    (messageId: string, model: string) => {
      handleModelChange(model);
      setMessageActionMenu(null);
      window.setTimeout(() => regenerateMessage(messageId), 0);
    },
    [handleModelChange, regenerateMessage],
  );
  const translateMessage = useCallback(
    (messageId: string, target: Locale) => {
      if (aiBusy) return;
      const message = messages.find((item) => item.id === messageId);
      const text = message ? answerActionText(message.text) : "";
      if (!text) return;
      setMessageActionMenu(null);
      void (async () => {
        try {
          const translated = await translatePublicText(text, target, locale);
          if (!translated) return;
          // The translation is a UI-only convenience for the reader. Mark it
          // localOnly so it is never replayed into the model transcript —
          // translating an assistant answer also rewrites its tool-call markup
          // (e.g. <invoke> → <调用>), which would corrupt the next turn's context.
          appendChatNote(
            `${translatedAnswerTitle(target, locale)}\n\n${translated}`,
            "assistant",
            { localOnly: true },
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          appendChatNote(
            locale === "zh-CN"
              ? `✗ 翻译失败：${message}`
              : `✗ Translation failed: ${message}`,
            "assistant",
            { localOnly: true },
          );
        }
      })();
    },
    [aiBusy, appendChatNote, locale, messages],
  );

  return (
    <div
      ref={dockRef}
      className={
        "relative " + (showMainPreview ? "ugs-main-preview-active " : "") +
        (isChat
          ? "flex h-full min-h-0 flex-col bg-bg" +
            (centerInput ? " justify-center" : "")
          : "flex shrink-0 border-t border-border bg-panel")
      }
      style={
        isChat
          ? ({
              "--ugs-chat-visible-right-inset": `${chatVisibleRightInset}px`,
            } as CSSProperties)
          : { height }
      }
    >
      {/* Resize handle — sits on the top edge, cursor becomes row-resize.
          Hidden in chat layout (the surface fills its parent). */}
      {!isChat && (
        <div
          onMouseDown={onResizeStart}
          title={t(locale, "common.resizeHeight")}
          className="group absolute -top-1 left-0 right-0 z-20 flex h-2 cursor-row-resize items-center justify-center"
        >
          <div className="h-0.5 w-full bg-transparent transition-colors group-hover:bg-accent/40" />
        </div>
      )}
      {/* AI return stream */}
      <section
        className={
          "ugs-ai-return-pane flex min-h-0 min-w-0 flex-col " +
          (centerInput ? "shrink-0" : "flex-1")
        }
      >
        <TitleBarContent enabled={isChat}>
          <header
            data-tauri-drag-region={isChat || undefined}
            className={
              "ugs-ai-return-header flex flex-wrap items-center gap-2 border-b border-border-soft px-3 py-2 " +
              (centerInput ? "absolute left-0 top-0 z-20 bg-bg/95" : "relative")
            }
            style={
              centerInput
                ? {
                    right: "var(--ugs-chat-visible-right-inset)",
                  }
                : undefined
            }
          >
            {isChat ? (
              <FilePreviewTabs scope={previewScope}>{chatTitleEditing ? (
                <input
                  ref={chatTitleInputRef}
                  type="text"
                  aria-label={t(locale, "sidebar.renameSession")}
                  data-testid="chat-title-input"
                  value={chatTitleDraft}
                  maxLength={MAX_CHAT_TITLE_LENGTH}
                  disabled={chatTitleSaving}
                  onChange={(e) => setChatTitleDraft(e.target.value)}
                  onFocus={(e) => e.currentTarget.select()}
                  onBlur={() => {
                    if (skipNextTitleBlurCommitRef.current) {
                      skipNextTitleBlurCommitRef.current = false;
                      return;
                    }
                    void commitChatTitleEdit();
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void commitChatTitleEdit();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      cancelChatTitleEdit();
                    }
                  }}
                  className="min-w-0 flex-1 rounded-md border border-accent bg-bg px-2 py-1 text-sm font-medium text-fg outline-none transition-colors disabled:opacity-70"
                />
              ) : activeSessionId ? (
                <button
                  type="button"
                  onClick={beginChatTitleEdit}
                  className="min-w-0 flex-1 truncate rounded-sm text-left text-sm font-medium text-fg transition-colors hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                  title={chatTitle}
                  data-testid="chat-title-display"
                >
                  {chatTitle || t(locale, "dock.aiReturn")}
                </button>
              ) : (
                <span
                  className="min-w-0 flex-1 truncate text-sm font-medium text-fg"
                  title={chatTitle}
                >
                  {chatTitle || t(locale, "dock.aiReturn")}
                </span>
              )}</FilePreviewTabs>
            ) : (
              <span className="font-mono text-[10px] uppercase tracking-wider text-accent">
                {t(locale, "dock.aiReturn")}
              </span>
            )}
            {activeAiEditing && (
              <span className="flex items-center gap-1 font-mono text-[10px] text-accent-2">
                <span className="omc-pulse-dot" />
                {t(locale, "dock.generating")}
              </span>
            )}
            <div className={"ml-auto flex shrink-0 items-center gap-1" + (isChat ? " ugs-chat-header-actions" : "")}>
              {conversationActions}
              {searchToggleButton}
              {isChat && (
                <SidebarToggleButton side="right" open={projectFilePanelOpen}
                  onClick={requestProjectRightPanelToggle}
                  controls="ugs-project-file-panel" locale={locale} />
              )}
            </div>
            {returnSearchOpen && (
              <div
                className={
                  "ugs-ai-return-search absolute left-3 right-3 top-full z-30 mt-2 flex items-center gap-1 rounded-lg border border-border bg-panel/95 p-1.5 shadow-2xl backdrop-blur sm:w-96 " +
                  (isChat ? "sm:right-auto" : "sm:left-auto")
                }
              >
                <div className="ugs-ai-return-search-input flex min-w-0 flex-1 items-center gap-1 rounded-md border border-border bg-bg px-2 py-1 transition-colors focus-within:border-accent">
                  <Search size={13} className="shrink-0 text-fg-faint" />
                  <input
                    id="ai-return-search"
                    type="search"
                    ref={searchInputRef}
                    value={returnSearch}
                    onChange={(e) => setReturnSearch(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        moveSearchMatch(e.shiftKey ? -1 : 1);
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        e.stopPropagation();
                        closeReturnSearch();
                      }
                    }}
                    placeholder={t(locale, "dock.searchPlaceholder")}
                    aria-label={t(locale, "dock.searchAria")}
                    spellCheck={false}
                    className="min-w-0 flex-1 bg-transparent text-xs text-fg outline-none placeholder:text-fg-faint"
                  />
                  {returnSearch ? (
                    <button
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={clearReturnSearch}
                      title={t(locale, "dock.searchClear")}
                      aria-label={t(locale, "dock.searchClear")}
                      className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-faint transition-colors hover:text-fg"
                    >
                      <X size={12} />
                    </button>
                  ) : null}
                </div>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => moveSearchMatch(-1)}
                  disabled={searchMatches.length === 0}
                  title={t(locale, "dock.searchPrevious")}
                  aria-label={t(locale, "dock.searchPrevious")}
                  className="ugs-ai-return-search-button flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-panel-2 text-fg-dim transition-colors hover:border-accent hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <ChevronUp size={14} />
                </button>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => moveSearchMatch(1)}
                  disabled={searchMatches.length === 0}
                  title={t(locale, "dock.searchNext")}
                  aria-label={t(locale, "dock.searchNext")}
                  className="ugs-ai-return-search-button flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-panel-2 text-fg-dim transition-colors hover:border-accent hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <ChevronDown size={14} />
                </button>
                <span
                  aria-live="polite"
                  className={
                    "min-w-[3.75rem] whitespace-nowrap text-right font-mono text-[10px] " +
                    (normalizedSearch && searchMatches.length === 0
                      ? "text-accent-3"
                      : "text-fg-faint")
                  }
                >
                  {searchStatus}
                </span>
              </div>
            )}
          </header>
        </TitleBarContent>
        <div
          id="ugs-stream-surface"
          className={"relative min-h-0 " + (centerInput ? "" : "flex-1")}
        >
          {captureStatus && (
            <div
              className={
                "pointer-events-none absolute left-1/2 top-2 z-30 -translate-x-1/2 rounded-md border px-3 py-1.5 text-xs shadow-lg " +
                (captureStatus.kind === "error"
                  ? "border-accent-3/50 bg-panel-2 text-accent-3"
                  : captureStatus.kind === "busy"
                    ? "border-accent/40 bg-panel-2 text-fg-dim"
                    : "border-accent/50 bg-panel-2 text-fg")
              }
              role="status"
              aria-live="polite"
            >
              {captureStatus.text}
            </div>
          )}
          <div
            ref={streamRef}
            onScroll={handleStreamScroll}
            className={
              "ugs-ai-return-stream ugs-autohide-scroll min-h-0 overflow-y-auto px-6 py-4 " +
              (isChat && timelineMarkers.length > 0 ? "pr-12 " : "") +
              (centerInput ? "mx-auto w-full" : "h-full")
            }
            style={
              centerInput
                ? {
                    maxWidth:
                      "min(72rem, calc(100% - var(--ugs-chat-visible-right-inset)))",
                    transform:
                      "translateX(calc(var(--ugs-chat-visible-right-inset) / -2))",
                  }
                : undefined
            }
          >
            {messages.length === 0 ? (
              <div
                className={
                  isChat
                    ? "ugs-ai-return-empty flex items-center justify-center px-4 pb-6 text-center text-xl font-medium text-fg-dim" +
                      (centerInput ? "" : " h-full")
                    : "ugs-ai-return-empty text-xs text-fg-faint"
                }
              >
                {t(locale, isChat ? "dock.chatEmpty" : "dock.empty")}
              </div>
            ) : (
              <ul ref={streamContentRef} className="flex flex-col gap-4">
                {hiddenMessageCount > 0 && (
                  <li className="flex justify-center py-1">
                    <button
                      type="button"
                      data-ugs-load-earlier-messages="true"
                      onClick={revealEarlierMessages}
                      className="rounded-md border border-border bg-panel-2 px-3 py-1 text-xs text-fg-dim transition-colors hover:border-accent hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                    >
                      {t(locale, "dock.loadEarlierMessages").replace(
                        "{count}",
                        String(hiddenMessageCount),
                      )}
                    </button>
                  </li>
                )}
                {visibleMessages.map((m) => {
                  const isUser = m.role === "user";
                  const isChatUser = isChat && isUser;
                  const queuedUserMessage =
                    isChatUser && queuedChatMessageIdSet.has(m.id);
                  const editingQueuedMessage =
                    queuedUserMessage && queuedEditMessageId === m.id;
                  const isSystem = m.role === "system";
                  const isSearchHit = searchMatchMessageIds.has(m.id);
                  const isCurrentSearchHit =
                    activeSearchMatchMessageId === m.id;
                  const isAssetJumpHit = assetJumpHighlightId === m.id;
                  const assistantLabel =
                    !isUser && !isSystem ? assistantHeaderLabel(m, locale) : "";
                  const roleLabel = isUser
                    ? "› you"
                    : isSystem
                      ? "• system"
                      : assistantLabel
                        ? `⟳ ${assistantLabel}`
                        : "⟳ assistant";
                  const roleClass = isUser
                    ? "text-accent"
                    : isSystem
                      ? "text-accent-3"
                      : "text-accent-2";
                  const preserveRoleCase = !!assistantLabel;
                  const captureUtility = isCaptureUtilityMessage(m);
                  // Per-turn `⏱ …` timing line. The bubble renderer strips it
                  // from the body (renderMessageText), so surface it as a
                  // centered pill after each assistant turn's content — every
                  // turn keeps its own clock, not just the latest one. Falls
                  // back to createdAt/completedAt when the text prefix is gone.
                  const turnTiming =
                    !isUser && !isSystem ? turnTimingFromMessage(m) : "";
                  const assistantActions =
                    isChat &&
                    !isUser &&
                    !isSystem &&
                    !captureUtility &&
                    !m.interaction &&
                    !normalizedSearch;
                  const actionText = assistantActions
                    ? answerActionText(m.text)
                    : "";
                  const canRegenerate =
                    assistantActions &&
                    !aiBusy &&
                    previousUserText(messages, m.id).length > 0;
                  // Per-message search-highlight state. The hitCounter is a
                  // fresh object on each render; LazyMessageContent / FileText
                  // reset it to 0 before use so the fallback and rich renderer
                  // produce identical match IDs.
                  const searchState = normalizedSearch
                    ? {
                        query: normalizedSearch,
                        messageId: m.id,
                        hitCounter: { current: 0 },
                        activeMatchId: activeSearchMatchId,
                        onActiveMatchNode: setActiveSearchMatchNode,
                      }
                    : null;
                  return (
                    <li
                      key={m.id}
                      data-ugs-message-row="true"
                      data-ugs-capture-exclude={
                        captureUtility ? "true" : undefined
                      }
                      ref={(node) => {
                        if (node) messageRefs.current.set(m.id, node);
                        else messageRefs.current.delete(m.id);
                      }}
                      className={
                        "group/msg flex flex-col gap-1 rounded-md px-1 py-0.5 transition-colors " +
                        (isChatUser ? "items-end " : "") +
                        (isCurrentSearchHit || isAssetJumpHit
                          ? "bg-accent/5 ring-1 ring-inset ring-accent-3/40"
                          : isSearchHit
                            ? "ring-1 ring-inset ring-accent/20"
                            : "")
                      }
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <span
                          title={roleLabel}
                          className={
                            "min-w-0 truncate py-0.5 font-mono text-[10px] leading-4 " +
                            (preserveRoleCase
                              ? "normal-case tracking-normal "
                              : "uppercase tracking-wider ") +
                            roleClass
                          }
                        >
                          {roleLabel}
                        </span>
                        <span
                          className="shrink-0 font-mono text-[10px] text-fg-faint"
                          title={new Date(m.createdAt).toLocaleString()}
                        >
                          {formatMessageTime(m.createdAt)}
                        </span>
                        {queuedUserMessage && (
                          <span className="shrink-0 rounded border border-accent/30 px-1.5 py-0.5 font-mono text-[10px] text-accent">
                            排队中
                          </span>
                        )}
                        {m.interjected && !queuedUserMessage && (
                          <span
                            title={t(locale, "dock.interjectedBadgeTip")}
                            className="shrink-0 rounded border border-accent-3/30 px-1.5 py-0.5 font-mono text-[10px] text-accent-3"
                          >
                            {t(locale, "dock.interjectedBadge")}
                          </span>
                        )}
                        {isUser && m.text.trim() && (
                          <CopyButton
                            value={m.text}
                            title={t(locale, "dock.copy")}
                            className="shrink-0 opacity-0 transition-opacity group-hover/msg:opacity-100"
                          />
                        )}
                        {queuedUserMessage && !normalizedSearch && (
                          <>
                            {/* Explicit native CLI steer. Normal sends remain queued;
                                unsupported or rejected steer requests leave the
                                message in FIFO and never abort the active turn. */}
                            {steerableQueuedChatMessageIdSet.has(m.id) && (
                              <button
                                type="button"
                                onClick={() => steerQueuedChatMessage(m.id)}
                                title={t(locale, "dock.liveInterjectTip")}
                                aria-label={t(locale, "dock.liveInterject")}
                                className="shrink-0 rounded text-fg-faint opacity-0 transition-colors transition-opacity hover:text-accent-3 group-hover/msg:opacity-100"
                              >
                                <Zap size={13} />
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => beginQueuedMessageEdit(m)}
                              title={t(locale, "common.edit")}
                              aria-label={t(locale, "common.edit")}
                              className="shrink-0 rounded text-fg-faint opacity-0 transition-colors transition-opacity hover:text-fg group-hover/msg:opacity-100"
                            >
                              <Pencil size={13} />
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                if (queuedEditMessageId === m.id) {
                                  cancelQueuedMessageEdit();
                                }
                                deleteQueuedChatMessage(m.id);
                              }}
                              title={t(locale, "common.delete")}
                              aria-label={t(locale, "common.delete")}
                              className="shrink-0 rounded text-fg-faint opacity-0 transition-colors transition-opacity hover:text-accent-3 group-hover/msg:opacity-100"
                            >
                              <Trash2 size={13} />
                            </button>
                          </>
                        )}
                      </div>
                      {m.runProgress && (
                        <StudioRunCard
                          progress={m.runProgress}
                          locale={locale}
                          active={aiBusy && m.id === lastAssistantId}
                          onStop={stopChat}
                        />
                      )}
                      {m.interaction ? (
                        <InteractionWidget
                          message={m}
                          locale={locale}
                          workspaceCwd={workspaceCwd}
                          remoteRootPath={activeRemoteWorkspaceRoot}
                          active={
                            (m.interactionStatus ?? "pending") === "pending" &&
                            (!!m.appAction ||
                              mode === "running" ||
                              activeAiEditing ||
                              activeChatting)
                          }
                          onAnswer={(answer) =>
                            handleInteractionAnswer(m, answer)
                          }
                          onDismiss={() => handleInteractionDismiss(m)}
                          onDraftChange={(draft) =>
                            setInteractionDraft(m.id, draft)
                          }
                        />
                      ) : editingQueuedMessage ? (
                        <div className="ai-stream-user-bubble flex w-[min(100%,46rem)] max-w-[96%] flex-col gap-2 rounded-md px-3 py-2.5 text-left">
                          <textarea
                            value={queuedEditDraft}
                            onChange={(event) =>
                              setQueuedEditDraft(event.target.value)
                            }
                            onKeyDown={(event) => {
                              if (event.key === "Escape") {
                                event.preventDefault();
                                cancelQueuedMessageEdit();
                                return;
                              }
                              if (
                                event.key === "Enter" &&
                                (event.ctrlKey || event.metaKey)
                              ) {
                                event.preventDefault();
                                commitQueuedMessageEdit(m.id);
                              }
                            }}
                            onPaste={handleQueuedEditPaste}
                            autoFocus
                            rows={Math.min(12, Math.max(4, queuedEditDraft.split("\n").length))}
                            className="max-h-80 min-h-28 resize-y rounded-md border border-border bg-bg/70 px-2.5 py-2 text-sm leading-relaxed text-fg outline-none transition-colors focus:border-accent"
                          />
                          <div className="flex justify-end gap-1">
                            <button
                              type="button"
                              onClick={cancelQueuedMessageEdit}
                              title={t(locale, "common.cancel")}
                              aria-label={t(locale, "common.cancel")}
                              className="flex h-7 w-7 items-center justify-center rounded-md border border-border text-fg-dim transition-colors hover:border-accent hover:text-fg"
                            >
                              <X size={14} />
                            </button>
                            <button
                              type="button"
                              onClick={() => commitQueuedMessageEdit(m.id)}
                              disabled={!queuedEditDraft.trim()}
                              title={t(locale, "common.save")}
                              aria-label={t(locale, "common.save")}
                              className="flex h-7 w-7 items-center justify-center rounded-md border border-accent/50 text-accent transition-colors hover:border-accent hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              <Check size={14} />
                            </button>
                          </div>
                        </div>
                      ) : isUser ? (
                        <span
                          className={
                            "whitespace-pre-wrap break-words text-sm leading-relaxed " +
                            (isChatUser
                              ? "ai-stream-user-bubble max-w-[86%] rounded-md px-3 py-2 text-left"
                              : isChat
                                ? "ai-stream-text w-full"
                                : "ai-stream-text")
                          }
                        >
                          <FileText
                            text={m.text}
                            onOpenFile={onOpenFile}
                            cwd={workspaceCwd || undefined}
                            searchState={searchState}
                          />
                        </span>
                      ) : (
                        // Assistant / system: rich markdown, code, tables, file
                        // chips, links, and collapsible reasoning blocks. Off-screen
                        // messages render as plain text first and upgrade lazily so
                        // opening a long history doesn't block on parsing every one.
                        // During search, inline <mark> highlights are applied via
                        // searchState without losing the rich rendering.
                        <div className="min-w-0 w-full">
                          <LazyMessageContent
                            referenceSources={m.referenceSources ?? m.references}
                            collectReferences={m.role === 'assistant' && !m.localOnly}
                            text={renderMessageText(m.text)}
                            fallback={cleanMessageText(m.text)}
                            streaming={aiBusy && m.id === lastAssistantId}
                            showActions={!isSystem}
                            onOpenFile={onOpenFile}
                            eager={
                              forceEagerCapture ||
                              !!normalizedSearch ||
                              eagerMessageIds.has(m.id) ||
                              (aiBusy && m.id === lastAssistantId)
                            }
                            scrollRootRef={streamRef}
                            cwd={workspaceCwd || undefined}
                            searchState={searchState}
                          />
                          {m.skillLearning && (() => {
                            const state = m.skillLearning;
                            return <SkillLearningCard state={state} locale={locale}
                              onApprove={(id) => handleSkillReviewAction(m.id, state, "approve", id)}
                              onReject={(id) => handleSkillReviewAction(m.id, state, "reject", id)}
                              onRetry={state.resume ? () => retryPersistedSkillLearning(state) : undefined}
                              onRollback={(id) => handleSkillReviewAction(m.id, state, "rollback", id)} />;
                          })()}
                          {!isSystem && !m.localOnly && !(aiBusy && m.id === lastAssistantId) && (() => {
                            const changes = m.fileChanges ?? collectTurnFileChanges([m], null, workspaceCwd || undefined);
                            return <>
                              {changes && <EditedFilesCard changes={changes} locale={locale}
                                cwd={workspaceCwd || undefined} onOpenFile={onOpenFile} />}
                              <MessageArtifacts text={m.text} cwd={workspaceCwd || undefined} onOpenFile={onOpenFile} />
                            </>;
                          })()}
                        </div>
                      )}
                      {assistantActions && actionText && (
                        <MessageActionToolbar
                          messageId={m.id}
                          text={actionText}
                          locale={locale}
                          openMenu={messageActionMenu}
                          modelOptions={modelOptionsForMode}
                          modelValue={modelValueForMode}
                          canRegenerate={canRegenerate}
                          usage={m.usage}
                          onToggleMenu={(kind) =>
                            setMessageActionMenu((current) =>
                              current?.messageId === m.id &&
                              current.kind === kind
                                ? null
                                : { messageId: m.id, kind },
                            )
                          }
                          onRegenerate={() => regenerateMessage(m.id)}
                          onRegenerateWithModel={(model) =>
                            regenerateMessageWithModel(m.id, model)
                          }
                          onTranslate={(target) =>
                            translateMessage(m.id, target)
                          }
                          onBranch={() => {
                            setMessageActionMenu(null);
                            branchSessionFromMessage(m.id);
                          }}
                          onDelete={() => {
                            setMessageActionMenu(null);
                            deleteMessage(m.id);
                          }}
                        />
                      )}
                      {turnTiming && (
                        <div className="flex justify-center pt-1">
                          <span className="rounded-full border border-border bg-panel-2 px-3 py-1 font-mono text-[11px] leading-4 text-fg-dim tabular-nums">
                            {turnTiming}
                          </span>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          {streamNavigation}
        </div>
      </section>

      {/* Vertical divider — drag to re-split AI 返回 / AI 输入.
          Hidden in chat layout (input is stacked below, full width). */}
      {!isChat && (
        <div
          onMouseDown={onSplitStart}
          title={t(locale, "common.resizeSplit")}
          className="group relative z-20 flex w-1.5 shrink-0 cursor-col-resize items-stretch justify-center border-l border-border-soft"
        >
          <div className="h-full w-0.5 bg-transparent transition-colors group-hover:bg-accent/40" />
        </div>
      )}

      {/* AI input box. Dock: right column (resizable width). Chat: full-width
          row pinned below the return stream (resizable height).
          The textarea and tool row are wrapped in a single bordered card so they
          read as one big input area, with controls anchored at the bottom edge:
          left = + (add file), permission, workspace; right = runtime + send. */}
      <section
        ref={inputSectionRef}
        data-ugs-composer
        className={
          "relative flex shrink-0 flex-col bg-transparent p-3 " +
          (centerInput ? "mx-auto w-full max-w-6xl px-4 sm:px-6" : "")
        }
        style={
          isChat
            ? centerInput
              ? {
                  maxWidth:
                    "min(72rem, calc(100% - var(--ugs-chat-visible-right-inset)))",
                  transform:
                    "translateX(calc(var(--ugs-chat-visible-right-inset) / -2))",
                }
              : {
                  height: renderedChatInputHeight,
                  marginRight: "var(--ugs-chat-visible-right-inset)",
                }
            : { width: renderedInputWidth }
        }
        aria-label={
          t(locale, "dock.aiInput") +
          (isReadOnly ? t(locale, "dock.readonlySuffix") : "")
        }
      >
        {orgMentionOpen && (
          <div
            ref={orgMentionRef}
            id="ugs-org-mention-suggestions"
            role="listbox"
            aria-label={t(locale, "dock.tabOrganization")}
            className="absolute bottom-[calc(100%+0.375rem)] left-3 right-3 z-50 max-h-72 overflow-y-auto rounded-md border border-border bg-panel shadow-2xl"
          >
            <div className="flex items-center gap-1.5 border-b border-border-soft px-2.5 py-1.5 text-[11px] text-fg-faint">
              <GitBranch size={12} className="shrink-0 text-accent" />
              <span className="truncate">
                {orgMentionQuery
                  ? t(locale, "dock.tabOrganization")
                  : orgMentionParent
                    ? orgMentionParent.path.join(" / ")
                    : orgTree.label}
              </span>
            </div>
            {orgMentionOptions.map((option, index) => {
              const active = index === activeOrgMentionIndex;
              const rowClass =
                "flex w-full min-w-0 items-center gap-2 border-l-2 px-2.5 py-2 text-left transition-colors " +
                (active
                  ? "border-l-accent bg-accent/20 text-fg ring-1 ring-inset ring-accent/40"
                  : "border-l-transparent text-fg-dim hover:border-l-accent/50 hover:bg-border-soft hover:text-fg");
              if (option.kind === "back") {
                return (
                  <button
                    key="__org-back"
                    id={`ugs-org-mention-suggestion-${index}`}
                    type="button"
                    role="option"
                    aria-selected={active}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setActiveOrgMentionIndex(index)}
                    onClick={() => applyOrgMentionOption(option)}
                    className={rowClass}
                  >
                    <ChevronUp size={14} className="shrink-0 -rotate-90" />
                    <span className="truncate text-sm">
                      {t(locale, "common.back")}
                    </span>
                  </button>
                );
              }
              const node = option.node;
              const isSelf = option.kind === "insert-self";
              const hasChildren = option.kind === "node" && option.hasChildren;
              return (
                <button
                  key={`${option.kind}-${node.id}`}
                  id={`ugs-org-mention-suggestion-${index}`}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActiveOrgMentionIndex(index)}
                  onClick={() => applyOrgMentionOption(option)}
                  className={rowClass}
                >
                  <GitBranch
                    size={14}
                    className={
                      "shrink-0 " + (active ? "text-accent" : "text-fg-faint")
                    }
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {node.label}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-fg-faint">
                      {isSelf
                        ? t(locale, "dock.orgMentionInsertSelf")
                        : orgMentionQuery
                          ? node.path.join(" / ")
                          : node.role}
                    </span>
                  </span>
                  {hasChildren && !orgMentionQuery && (
                    <ChevronRight
                      size={14}
                      className="shrink-0 text-fg-faint"
                    />
                  )}
                </button>
              );
            })}
          </div>
        )}

        {slashOpen && (
          <div
            id="ugs-slash-suggestions"
            role="listbox"
            aria-label="Slash suggestions"
            className="absolute bottom-[calc(100%+0.375rem)] left-3 right-3 z-50 max-h-[32rem] overflow-y-auto rounded-md border border-border bg-panel shadow-2xl"
          >
            {filteredSlashSuggestions.map((suggestion, index) => {
              const active = index === activeSlashIndex;
              return (
                <button
                  key={suggestion.id}
                  id={`ugs-slash-suggestion-${index}`}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActiveSlashIndex(index)}
                  onClick={() => applySlashSuggestion(suggestion)}
                  className={
                    "flex w-full items-start gap-2 border-l-2 px-2.5 py-2 text-left transition-colors " +
                    (active
                      ? "border-l-accent bg-accent/20 text-fg ring-1 ring-inset ring-accent/40"
                      : "border-l-transparent text-fg-dim hover:border-l-accent/50 hover:bg-border-soft hover:text-fg")
                  }
                >
                  <span
                    className={
                      "mt-0.5 rounded border px-1.5 py-0.5 font-mono text-[11px] leading-none " +
                      (active
                        ? "border-accent bg-accent text-bg"
                        : "border-border bg-bg text-accent")
                    }
                  >
                    {suggestion.name}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-sm font-medium">
                        {suggestion.label}
                      </span>
                      <span
                        className={
                          "shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider " +
                          (active
                            ? "border-accent/50 text-accent"
                            : "border-border-soft text-fg-faint")
                        }
                      >
                        {suggestion.kind}
                      </span>
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-fg-faint">
                      {suggestion.detail}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {gameSkillOpen && (
          <div
            id="ugs-game-skill-suggestions"
            role="listbox"
            aria-label={t(locale, "dock.gameSkillSuggestions")}
            className="absolute bottom-[calc(100%+0.375rem)] left-3 right-3 z-50 max-h-[32rem] overflow-y-auto rounded-md border border-border bg-panel shadow-2xl"
          >
            <div className="sticky top-0 border-b border-border-soft bg-panel px-2.5 py-1.5 text-[11px] font-medium text-fg-faint">
              {t(locale, "dock.hintGameSkill")}
            </div>
            {filteredGameSkillSuggestions.map((suggestion, index) => {
              const active = index === activeGameSkillIndex;
              return (
                <button
                  key={suggestion.id}
                  id={`ugs-game-skill-suggestion-${index}`}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActiveGameSkillIndex(index)}
                  onClick={() => applyGameSkillSuggestion(suggestion)}
                  className={
                    "flex w-full items-start gap-2 border-l-2 px-2.5 py-2 text-left transition-colors " +
                    (active
                      ? "border-l-accent bg-accent/20 text-fg ring-1 ring-inset ring-accent/40"
                      : "border-l-transparent text-fg-dim hover:border-l-accent/50 hover:bg-border-soft hover:text-fg")
                  }
                >
                  <span
                    className={
                      "mt-0.5 rounded border px-1.5 py-0.5 font-mono text-[11px] leading-none " +
                      (active
                        ? "border-accent bg-accent text-bg"
                        : "border-border bg-bg text-accent")
                    }
                  >
                    {suggestion.name}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-sm font-medium">
                        {suggestion.label}
                      </span>
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-fg-faint">
                      {suggestion.detail}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {fileMentionOpen && (
          <div
            id="ugs-file-mention-suggestions"
            role="listbox"
            aria-label={t(locale, "dock.fileSuggestions")}
            className="absolute bottom-[calc(100%+0.375rem)] left-3 right-3 z-50 max-h-[36rem] overflow-y-auto rounded-md border border-border bg-panel shadow-2xl"
          >
            {fileMentionOptions.map((entry, index) => {
              const active = index === activeFileMentionIndex;
              const isDirectory = entry.kind === "directory";
              return (
                <button
                  key={entry.path}
                  id={`ugs-file-mention-suggestion-${index}`}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActiveFileMentionIndex(index)}
                  onClick={() => applyFileMentionOption(entry)}
                  className={
                    "flex w-full min-w-0 items-start gap-2 border-l-2 px-2.5 py-2 text-left transition-colors " +
                    (active
                      ? "border-l-accent bg-accent/20 text-fg ring-1 ring-inset ring-accent/40"
                      : "border-l-transparent text-fg-dim hover:border-l-accent/50 hover:bg-border-soft hover:text-fg")
                  }
                >
                  <span
                    className={
                      "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border " +
                      (active
                        ? "border-accent bg-accent text-bg"
                        : "border-border bg-bg text-fg-faint")
                    }
                  >
                    {isDirectory ? (
                      <Folder size={13} strokeWidth={2} />
                    ) : (
                      <File size={13} strokeWidth={2} />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {entry.name}
                      {isDirectory ? "/" : ""}
                    </span>
                    <span className="mt-0.5 block truncate font-mono text-xs text-fg-faint">
                      {normalizeFileMentionPath(entry.relativePath)}
                      {isDirectory ? "/" : ""}
                    </span>
                  </span>
                </button>
              );
            })}
            {fileMentionListing.status === "loading" &&
              fileMentionOptions.length === 0 && (
                <div className="flex items-center gap-2 px-3 py-2 text-sm text-fg-faint">
                  <Loader2 size={14} className="animate-spin text-accent" />
                  <span>{t(locale, "dock.loading")}</span>
                </div>
              )}
            {fileMentionListing.status === "error" &&
              fileMentionOptions.length === 0 && (
                <div className="px-3 py-2 text-sm leading-snug text-status-error">
                  {fileMentionListing.message}
                </div>
              )}
            {fileMentionListing.status === "ready" &&
              fileMentionOptions.length === 0 && (
                <div className="px-3 py-2 text-sm text-fg-faint">
                  {t(locale, "dock.noMatchingFiles")}
                </div>
              )}
          </div>
        )}

        {isChat && <ChatTaskProgress key={`${activeWorkspaceId}:${activeSessionId}:${taskProgress.startedAt}`}
          progress={taskProgress} jobs={currentJobs} active={activeAiEditing || activeChatting}
          locale={locale} cwd={workspaceCwd} onOpenFile={onOpenFile} />}

        {isChat && <SessionChangesSummary key={activeSessionId}
          changes={sessionFileChanges} locale={locale} onOpenSessionFiles={requestProjectRightPanelSessionFiles} />}

        {/* Hint/permission row — floats above the input card (over the return
            stream), as its own line rather than inside the card. Left: composer
            input hints with the user's real shortcuts. Right: flat segmented
            permission control (ordered low→high privilege, left→right) plus
            send/newline shortcut hints. */}
        {composerHintRowVisible && (
        <div data-testid="composer-hint-row" className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] leading-none text-fg-faint">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="inline-flex items-center gap-1">
              <span className="font-mono text-fg-dim">/</span>
              {t(locale, "dock.hintSlash")}
            </span>
            <span className="text-border">·</span>
            <span className="inline-flex items-center gap-1">
              <span className="font-mono text-fg-dim">@</span>
              {t(locale, "dock.hintMention")}
            </span>
            <span className="text-border">·</span>
            <span className="inline-flex items-center gap-1">
              {shortcutParts(shortcutSettings["return-search"]).map((part) => (
                <kbd
                  key={part}
                  className="rounded border border-border bg-panel-2 px-1 py-0.5 font-mono text-[10px] leading-none text-fg-dim"
                >
                  {part}
                </kbd>
              ))}
              <span>{t(locale, "dock.hintSearch")}</span>
            </span>
          </div>

          <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <div
              role="radiogroup"
              aria-label={t(locale, "dock.permissionTitle")}
              className={
                "flex shrink-0 items-center gap-0.5 rounded-md border p-0.5 transition-colors " +
                (permissionVisual(composer.permission).tone === "danger"
                  ? "border-status-warning/30 bg-transparent"
                  : "border-border-soft bg-transparent")
              }
            >
              {[...permissionOptions]
                .sort((a, b) => permissionRank(a.id) - permissionRank(b.id))
                .map((opt) => {
                  const localized = localizeSelectOption(opt, locale);
                  const { Icon, tone, color } = permissionVisual(opt.id);
                  const active = composer.permission === opt.id;
                  // Risk is a persistent label + shield, not a solid error button.
                  const activeDanger = active && tone === "danger";
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      disabled={isReadOnly}
                      title={`${localized.label}${
                        localized.hint ? ` · ${localized.hint}` : ""
                      }`}
                      onClick={() => setComposer({ permission: opt.id })}
                      className={
                        "ugs-control flex min-h-7 items-center gap-1.5 rounded px-2 py-1 text-xs font-medium leading-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50 " +
                        (activeDanger
                          ? "bg-status-warning/10 text-status-warning"
                          : active
                            ? "bg-panel-2"
                            : "text-fg-dim hover:bg-border-soft hover:text-fg")
                      }
                      style={active && !activeDanger ? { color } : undefined}
                    >
                      <Icon size={12} strokeWidth={2.2} />
                      <span>{localized.label}</span>
                    </button>
                  );
                })}
            </div>

            <div className="hidden shrink-0 items-center gap-2 sm:flex">
              <span className="inline-flex items-center gap-1">
                {shortcutParts(shortcutSettings["composer-send"]).map(
                  (part) => (
                    <kbd
                      key={part}
                      className="rounded border border-border bg-panel-2 px-1 py-0.5 font-mono text-[10px] leading-none text-fg-dim"
                    >
                      {part}
                    </kbd>
                  ),
                )}
                <span>{t(locale, "dock.sendShortcutAction")}</span>
              </span>
              <span className="inline-flex items-center gap-1">
                {shortcutParts(shortcutSettings["composer-newline"]).map(
                  (part) => (
                    <kbd
                      key={part}
                      className="rounded border border-border bg-panel-2 px-1 py-0.5 font-mono text-[10px] leading-none text-fg-dim"
                    >
                      {part}
                    </kbd>
                  ),
                )}
                <span>{t(locale, "dock.newlineShortcutAction")}</span>
              </span>
            </div>
          </div>
        </div>

        )}
        {/* `z-30`：卡片带 backdrop-filter（global.css 的 .ugs-ai-input-card），
            本身就是一个层叠上下文，里面下拉菜单的 z-index 压不过 DOM 靠后的
            兄弟面板（右栏「会话文件」）。给卡片一个正的 z-index，菜单才能画在
            面板之上而不被切断。 */}
        <div
          ref={inputDropRef}
          onDragOver={handleComposerDragOver}
          onDragLeave={handleComposerDragLeave}
          onDrop={handleComposerDrop}
          className={
            "ugs-ai-input-card relative z-30 flex min-h-0 flex-1 flex-col rounded-lg border transition-colors focus-within:border-accent " +
            (centerInput ? "min-h-[14rem] " : "") +
            (dropActive
              ? "ugs-ai-input--drop border-accent "
              : isChat
                ? "ugs-ai-input--chat border-border "
                : "border-border ") +
            composerModeClass +
            (isReadOnly ? "opacity-60 " : "")
          }
        >
          {isChat && !centerInput && (
            <div
              onMouseDown={(event) => {
                event.stopPropagation();
                onChatSplitStart(event);
              }}
              title={t(locale, "common.resizeHeight")}
              className="group absolute -top-1 left-0 right-0 z-20 flex h-2 cursor-row-resize items-center justify-center"
            >
              <div className="h-0.5 w-full bg-transparent transition-colors group-hover:bg-accent/40" />
            </div>
          )}
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(e) => {
              const next = e.target.value;
              // `$` at a word boundary now opens an inline searchable tree menu
              // (handled by syncComposerSuggestions), not the popup panel. The
              // `$` stays in the draft as the active trigger token, mirroring `/`.
              draftRef.current = next;
              setComposerDraft(next);
              rememberSelection(e.currentTarget);
              syncComposerSuggestions(e.currentTarget);
            }}
            onClick={(e) => {
              rememberSelection(e.currentTarget);
              syncComposerSuggestions(e.currentTarget);
            }}
            onKeyUp={(e) => {
              rememberSelection(e.currentTarget);
              syncComposerSuggestions(e.currentTarget);
            }}
            onSelect={(e) => {
              rememberSelection(e.currentTarget);
              syncComposerSuggestions(e.currentTarget);
            }}
            onFocus={(e) => {
              rememberSelection(e.currentTarget);
              syncComposerSuggestions(e.currentTarget);
            }}
            onBlur={closeComposerSuggestions}
            onPaste={handlePaste}
            onKeyDown={(e) => {
              if (orgMentionOpen) {
                if (e.key === "ArrowDown" && orgMentionOptions.length > 0) {
                  e.preventDefault();
                  setActiveOrgMentionIndex(
                    (index) => (index + 1) % orgMentionOptions.length,
                  );
                  return;
                }
                if (e.key === "ArrowUp" && orgMentionOptions.length > 0) {
                  e.preventDefault();
                  setActiveOrgMentionIndex(
                    (index) =>
                      (index - 1 + orgMentionOptions.length) %
                      orgMentionOptions.length,
                  );
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  closeOrgMentionSuggestions();
                  return;
                }
                if (
                  (e.key === "Tab" || (e.key === "Enter" && !e.ctrlKey)) &&
                  orgMentionOptions.length > 0
                ) {
                  e.preventDefault();
                  const option = orgMentionOptions[activeOrgMentionIndex];
                  if (option) applyOrgMentionOption(option);
                  return;
                }
              }
              if (fileMentionOpen) {
                if (e.key === "ArrowDown" && fileMentionOptions.length > 0) {
                  e.preventDefault();
                  setActiveFileMentionIndex(
                    (index) => (index + 1) % fileMentionOptions.length,
                  );
                  return;
                }
                if (e.key === "ArrowUp" && fileMentionOptions.length > 0) {
                  e.preventDefault();
                  setActiveFileMentionIndex(
                    (index) =>
                      (index - 1 + fileMentionOptions.length) %
                      fileMentionOptions.length,
                  );
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  closeFileMentionSuggestions();
                  return;
                }
                if (
                  (e.key === "Tab" || (e.key === "Enter" && !e.ctrlKey)) &&
                  fileMentionOptions.length > 0
                ) {
                  e.preventDefault();
                  const option = fileMentionOptions[activeFileMentionIndex];
                  if (option) applyFileMentionOption(option);
                  return;
                }
              }
              if (slashOpen) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setActiveSlashIndex(
                    (index) => (index + 1) % filteredSlashSuggestions.length,
                  );
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setActiveSlashIndex(
                    (index) =>
                      (index - 1 + filteredSlashSuggestions.length) %
                      filteredSlashSuggestions.length,
                  );
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  closeSlashSuggestions();
                  return;
                }
                if (e.key === "Tab" || (e.key === "Enter" && !e.ctrlKey)) {
                  e.preventDefault();
                  const suggestion = filteredSlashSuggestions[activeSlashIndex];
                  if (suggestion) applySlashSuggestion(suggestion);
                  return;
                }
              }
              if (gameSkillOpen) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setActiveGameSkillIndex(
                    (index) =>
                      (index + 1) % filteredGameSkillSuggestions.length,
                  );
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setActiveGameSkillIndex(
                    (index) =>
                      (index - 1 + filteredGameSkillSuggestions.length) %
                      filteredGameSkillSuggestions.length,
                  );
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  closeGameSkillSuggestions();
                  return;
                }
                if (e.key === "Tab" || (e.key === "Enter" && !e.ctrlKey)) {
                  e.preventDefault();
                  const suggestion =
                    filteredGameSkillSuggestions[activeGameSkillIndex];
                  if (suggestion) applyGameSkillSuggestion(suggestion);
                  return;
                }
              }
              if (
                matchesShortcut(
                  e.nativeEvent,
                  shortcutSettings["composer-send"],
                )
              ) {
                e.preventDefault();
                closeComposerSuggestions();
                submit();
                return;
              }
              if (
                matchesShortcut(
                  e.nativeEvent,
                  shortcutSettings["composer-newline"],
                )
              ) {
                if (!isNativeTextareaNewlineShortcut(e.nativeEvent)) {
                  e.preventDefault();
                  closeComposerSuggestions();
                  insertComposerText("\n", {
                    start: e.currentTarget.selectionStart,
                    end: e.currentTarget.selectionEnd,
                  });
                }
              }
            }}
            readOnly={isReadOnly}
            disabled={isReadOnly}
            placeholder={
              isReadOnly
                ? t(locale, "dock.runningPlaceholder")
                : composer.gddMode
                  ? t(locale, "dock.gddModePlaceholder")
                  : composer.imageMode
                  ? t(locale, "dock.imageModePlaceholder")
                  : composer.musicMode
                    ? t(locale, "dock.musicModePlaceholder")
                    : composer.threeDMode
                      ? t(locale, "dock.threeDModePlaceholder")
                      : composer.videoMode
                        ? t(locale, "dock.videoModePlaceholder")
                        : composer.animationMode
                          ? t(locale, "dock.animationModePlaceholder")
                          : composer.spriteMode
                            ? t(locale, "dock.spriteModePlaceholder")
                            : composer.speechMode
                              ? t(locale, "dock.speechModePlaceholder")
                            : composer.uiMode
                              ? t(locale, "dock.uiModePlaceholder")
                              : composer.metahumanMode
                                ? t(locale, "dock.metahumanModePlaceholder")
                                : composer.blueprintMode
                                  ? t(locale, "dock.blueprintModePlaceholder")
                                  : composer.worldMode
                                    ? t(locale, "dock.worldModePlaceholder")
                                    : t(locale, "dock.placeholder")
            }
            aria-expanded={slashOpen || gameSkillOpen || fileMentionOpen}
            aria-controls={
              fileMentionOpen
                ? "ugs-file-mention-suggestions"
                : slashOpen
                  ? "ugs-slash-suggestions"
                  : gameSkillOpen
                    ? "ugs-game-skill-suggestions"
                    : undefined
            }
            aria-activedescendant={
              fileMentionOpen && fileMentionOptions.length > 0
                ? `ugs-file-mention-suggestion-${activeFileMentionIndex}`
                : slashOpen
                  ? `ugs-slash-suggestion-${activeSlashIndex}`
                  : gameSkillOpen
                    ? `ugs-game-skill-suggestion-${activeGameSkillIndex}`
                    : undefined
            }
            className={
              "min-h-0 resize-none border-0 bg-transparent text-sm leading-relaxed text-fg outline-none placeholder:text-fg-faint " +
              (centerInput
                ? "flex-1 px-4 pt-4 pb-3 overflow-y-auto ugs-autohide-scroll "
                : "flex-1 px-3 pt-3 pb-2 ") +
              (isReadOnly ? "cursor-not-allowed" : "")
            }
            style={
              centerInput
                ? {
                    // Keep flex growth free to absorb the card's min-h-[14rem]
                    // slack and anchor the toolbar at its bottom edge. The
                    // measured minimum caps content growth; maxHeight here
                    // would strand unused base height below the toolbar.
                    minHeight: centerInputTextareaHeight,
                  }
                : undefined
            }
          />

          {draftFileRefs.length > 0 && (
            <div
              data-testid="composer-file-refs"
              className="flex flex-row flex-nowrap items-center gap-2 overflow-x-auto overflow-y-hidden overscroll-x-contain px-2 pb-1"
            >
              <FileChipBudgetProvider>
                {draftFileRefs.map((ref) => (
                  <FileChip
                    key={displayFileRefLabel(ref, workspaceCwd)}
                    refData={ref}
                    onOpenFile={onOpenFile}
                    cwd={workspaceCwd}
                    thumbnailOnly
                    onRemove={() => removeComposerFileRef(ref)}
                  />
                ))}
              </FileChipBudgetProvider>
            </div>
          )}

          {composerTipText && (
            <div
              role="status"
              aria-live="polite"
              data-testid="blocked-send-tip"
              className="mx-2 mb-1 rounded-md border border-status-error/40 bg-status-error/10 px-2.5 py-1.5 text-xs leading-snug text-status-error"
            >
              {composerTipText}
            </div>
          )}

          {/* Tool row pinned to the bottom edge of the card. Left cluster groups
              file/workspace tools; channel/model stay near the send button
              aligned to the right.
              rounded-b-lg: parent has no overflow-hidden so dropdown menus can
              extend above the card; this keeps the toolbar visually flush with
              the parent's rounded bottom corners. */}
          <div
            className={
              "ugs-ai-input-toolbar flex shrink-0 flex-wrap items-center gap-2 rounded-b-lg px-2 py-2"
            }
          >
            {!generationMode && !simpleChatMode && activeSessionIsWorkflow && (
              <button
                type="button"
                title={t(locale, "dock.modelStrategyTitle")}
                onClick={() => setModelStrategyOpen((v) => !v)}
                className={cn(composerToolButtonClass, "gap-1")}
              >
                <span className="text-fg-faint">◇</span>
                <span className="truncate">
                  {t(locale, modelStrategyLabelKey(composer.modelStrategy))}
                </span>
              </button>
            )}
            {modelStrategyOpen && (
              <div className="absolute bottom-full left-0 mb-1 w-56 rounded-md border border-border bg-panel shadow-lg">
                <ul role="listbox">
                  {(
                    [
                      "inherit",
                      "smart",
                      "prefer-better",
                      "prefer-cheaper",
                    ] as const
                  ).map((strategy) => (
                    <li key={strategy}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={composer.modelStrategy === strategy}
                        onClick={() => {
                          setComposer({ modelStrategy: strategy });
                          setModelStrategyOpen(false);
                        }}
                        className={
                          "block w-full px-3 py-1.5 text-left text-xs transition-colors " +
                          (composer.modelStrategy === strategy
                            ? "bg-border-soft text-fg"
                            : "text-fg-dim hover:bg-border-soft hover:text-fg")
                        }
                      >
                        {t(locale, modelStrategyLabelKey(strategy))}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                void addFiles();
              }}
              disabled={isReadOnly}
              title={
                isReadOnly
                  ? t(locale, "dock.inputLockedTitle")
                  : t(locale, "dock.addFileTitle")
              }
              aria-label={t(locale, "dock.addFileTitle")}
              className={cn(composerToolButtonClass, "w-7 px-0")}
            >
              <Plus size={15} strokeWidth={2} />
            </button>
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={startSlashCommand}
              disabled={isReadOnly}
              title={t(locale, "dock.hintSlash")}
              aria-label={t(locale, "dock.hintSlash")}
              className={cn(composerToolButtonClass, "gap-1 font-medium")}
            >
              <span className="font-mono text-sm font-semibold">/</span>
              <span>{t(locale, "dock.hintSlash")}</span>
            </button>
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={startGameSkill}
              disabled={isReadOnly}
              title={t(locale, "dock.hintGameSkill")}
              aria-label={t(locale, "dock.hintGameSkill")}
              className={cn(composerToolButtonClass, "gap-1 font-medium")}
            >
              <span className="font-mono text-sm font-semibold">#</span>
              <span>{t(locale, "dock.hintGameSkill")}</span>
            </button>
            {/* 三个「进阶入口」按钮默认隐藏（见 store.composerToolButtonsVisible），
                避免常驻挤占底部工具条；用户在 设置 → 常规 里打开后才渲染。 */}
            {composerToolButtonsVisible && (
              <>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={startFileMention}
                  disabled={isReadOnly}
                  title={t(locale, "dock.hintMention")}
                  aria-label={t(locale, "dock.hintMention")}
                  className={cn(composerToolButtonClass, "gap-1 font-medium")}
                >
                  <span className="font-mono text-sm font-semibold">@</span>
                  <span>{t(locale, "dock.hintMentionShort")}</span>
                </button>
                {isChat && (
                  <button
                    type="button"
                    data-org-panel-trigger
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => setOrgPanelOpen((open) => !open)}
                    aria-pressed={orgPanelOpen}
                    title={t(locale, "dock.tabOrganization")}
                    aria-label={t(locale, "dock.tabOrganization")}
                    className={cn(
                      composerToolButtonClass,
                      "gap-1 font-medium",
                      orgPanelOpen && "bg-border-soft/55 text-fg",
                    )}
                  >
                    <span className="font-mono text-sm font-semibold">$</span>
                    <span>{t(locale, "dock.tabOrganization")}</span>
                  </button>
                )}
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() =>
                    setComposer({
                      knowledgeBaseMode: !composer.knowledgeBaseMode,
                    })
                  }
                  disabled={isReadOnly}
                  aria-pressed={composer.knowledgeBaseMode}
                  title={t(
                    locale,
                    composer.knowledgeBaseMode
                      ? "dock.knowledgeBaseOnTitle"
                      : "dock.knowledgeBaseOffTitle",
                  )}
                  aria-label={t(locale, "dock.knowledgeBaseLabel")}
                  className={cn(
                    composerToolButtonClass,
                    "gap-1 font-medium",
                    composer.knowledgeBaseMode &&
                      "border-accent/45 bg-accent/10 text-accent",
                  )}
                >
                  <BookOpen size={14} strokeWidth={2.1} />
                  <span>{t(locale, "dock.knowledgeBaseShort")}</span>
                </button>
              </>
            )}

            <ComposerOptions label={locale === "zh-CN" ? "会话选项" : "Session options"}>
            {activeRemoteWorkspaceRoot ? (
              <>
                <Select
                  title={t(locale, "dock.remoteCacheTitle")}
                  options={remoteCacheOptions}
                  value="remote"
                  onChange={() => {}}
                  disabled
                  className="min-w-0 max-w-[8rem]"
                  icon="☁"
                  variant="ghost"
                  showSelectedHint={false}
                />
                <Select
                  title={t(locale, "dock.remoteStartupModeTitle")}
                  options={remoteStartupModeOptions}
                  value="remote"
                  onChange={() => {}}
                  disabled
                  className="min-w-0 max-w-[9rem]"
                  icon="⎇"
                  variant="ghost"
                  showSelectedHint={false}
                />
              </>
            ) : (
              <>
                {/* Session cache TTL — chosen before the conversation starts and
                    locked once the first message is sent so a single session keeps
                    one consistent value. */}
                <Select
                  title={
                    cacheTtlLocked
                      ? t(locale, "dock.cacheTtlLocked")
                      : t(locale, "dock.cacheTtlTitle")
                  }
                  options={cacheTtlOptions.map((opt) =>
                    localizeSelectOption(opt, locale),
                  )}
                  value={String(composer.cacheTtlMinutes)}
                  onChange={(id) =>
                    setComposer({ cacheTtlMinutes: Number(id) })
                  }
                  disabled={cacheTtlLocked}
                  className="min-w-0 max-w-[8rem]"
                  icon="⏱"
                  variant="ghost"
                  showSelectedHint={false}
                />

                {/* Session startup mode — choose whether a new session runs in the
                    workspace directly (本地) or in an isolated git worktree / copy
                    (新工作树). Like cache TTL it only affects brand-new sessions and
                    locks once the first message is sent. */}
                <Select
                  title={
                    startupModeLocked
                      ? t(locale, "dock.startupModeLocked")
                      : t(locale, "dock.startupModeTitle")
                  }
                  options={startupModeOptions.map((opt) =>
                    localizeSelectOption(opt, locale),
                  )}
                  value={composer.startupMode}
                  onChange={(id) =>
                    setComposer({
                      startupMode: id === "worktree" ? "worktree" : "local",
                    })
                  }
                  disabled={startupModeLocked}
                  className="min-w-0 max-w-[9rem]"
                  icon="⎇"
                  variant="ghost"
                  showSelectedHint={false}
                />
              </>
            )}
            </ComposerOptions>

            <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
              <Select
                title={t(locale, "dock.channelTitle")}
                options={channelOptions}
                value={channelValue}
                onChange={handleChannelChange}
                disabled={isReadOnly}
                className="min-w-0 max-w-[13rem]"
                icon="✦"
                variant="ghost"
                showSelectedHint={false}
                collapsibleGroups
                collapsedGroupsKey="ugs_collapsed_channel_groups_v1"
                pinnable={isCodeChannelMode}
                pinnedIds={isCodeChannelMode ? pinnedChannelIds : undefined}
                onTogglePin={isCodeChannelMode ? toggleChannelPin : undefined}
              />
              {modelOptionsForMode.length > 0 && (
                <Select
                  title={modelTitleForMode}
                  options={modelOptionsForMode}
                  value={modelValueForMode}
                  onChange={handleModelChange}
                  disabled={isReadOnly}
                  className="min-w-0 max-w-[14rem]"
                  icon={!generationMode && loadingChannelModels ? "↻" : "◇"}
                  variant="ghost"
                />
              )}
              {!generationMode &&
                thinkingLevelsEnabled &&
                thinkingUi.options.length > 0 && (
                <Select
                  title={t(locale, "dock.thinkingTitle")}
                  options={[
                    {
                      id: THINKING_LEVEL_DEFAULT_ID,
                      label: t(locale, "dock.thinkingDefault"),
                      hint: thinkingUi.defaultHint,
                    },
                    ...thinkingUi.options,
                  ]}
                  value={thinkingValue}
                  onChange={handleThinkingChange}
                  disabled={isReadOnly}
                  className="min-w-0 max-w-[9rem]"
                  icon="◐"
                  variant="ghost"
                  // 触发按钮只显示档位名；每个档位的说明留在下拉里，
                  // 否则长说明会把窄触发条撑爆。
                  showSelectedHint={false}
                />
              )}
              <button
                type="button"
                onClick={() => {
                  if (chatFollowUp) {
                    submit();
                    return;
                  }
                  if (chatRunActive) {
                    stopChat();
                    return;
                  }
                  if (useChatRunButton) {
                    submit(chatRunText, { clearDraft: true });
                    return;
                  }
                  submit();
                }}
                disabled={
                  !chatFollowUp &&
                  !chatRunActive &&
                  (!(useChatRunButton ? chatRunText : draft.trim()) ||
                    isReadOnly ||
                    activeAiEditing)
                }
                title={
                  chatFollowUp
                    ? t(locale, "dock.interjectTitle")
                    : chatRunActive
                      ? t(locale, "dock.stopChatTitle")
                      : isReadOnly
                        ? t(locale, "dock.inputLockedTitle")
                        : activeAiEditing
                          ? t(locale, "dock.aiGeneratingTitle")
                          : useChatRunButton
                            ? t(locale, "dock.runChatTitle")
                            : sendShortcutHint
                }
                aria-label={
                  chatFollowUp
                    ? t(locale, "dock.interjectTitle")
                    : chatRunActive
                      ? t(locale, "dock.stopChatTitle")
                      : useChatRunButton
                        ? t(locale, "dock.runChatTitle")
                        : sendShortcutHint
                }
                className={
                  "ugs-composer-send flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-panel disabled:cursor-not-allowed disabled:opacity-40 " +
                  (chatRunActive && !chatFollowUp
                    ? "border border-border bg-panel-2 text-fg-dim hover:bg-border-soft hover:text-fg"
                    : "bg-accent text-[var(--ugs-accent-contrast)] hover:brightness-110")
                }
              >
                {chatFollowUp ? (
                  <ArrowUp size={16} strokeWidth={2.4} />
                ) : chatRunActive ? (
                  <Square size={12} strokeWidth={2.2} />
                ) : activeAiEditing ? (
                  "…"
                ) : (
                  <ArrowUp size={16} strokeWidth={2.4} />
                )}
              </button>
            </div>
          </div>
        </div>
      </section>
      {isChat && orgPanelOpen && (
        <div
          ref={orgPanelRef}
          role="dialog"
          aria-label={t(locale, "dock.tabOrganization")}
          className="ugs-ai-input--blueprint absolute left-4 top-12 z-40 flex flex-col overflow-hidden rounded-xl border shadow-2xl"
          style={{
            bottom: orgPanelBottomOffset,
            right: `calc(1rem + var(--ugs-chat-visible-right-inset))`,
          }}
        >
          <div className="flex shrink-0 items-center gap-2 border-b border-border-soft px-3 py-2">
            <GitBranch size={14} className="shrink-0 text-accent" />
            <span className="text-sm font-medium text-fg">
              {t(locale, "dock.tabOrganization")}
            </span>
            <button
              type="button"
              onClick={() => setOrgPanelLocked((prev) => !prev)}
              aria-pressed={orgPanelLocked}
              title={t(
                locale,
                orgPanelLocked ? "dock.orgPanelUnlock" : "dock.orgPanelLock",
              )}
              aria-label={t(
                locale,
                orgPanelLocked ? "dock.orgPanelUnlock" : "dock.orgPanelLock",
              )}
              className={cn(
                "ml-auto flex h-7 w-7 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent",
                orgPanelLocked
                  ? "bg-accent/15 text-accent hover:bg-accent/25"
                  : "text-fg-dim hover:bg-border-soft/55 hover:text-fg",
              )}
            >
              {orgPanelLocked ? <Lock size={14} /> : <Unlock size={14} />}
            </button>
            <button
              type="button"
              onClick={() => setOrgPanelOpen(false)}
              title={t(locale, "common.close")}
              aria-label={t(locale, "common.close")}
              className="flex h-7 w-7 items-center justify-center rounded-md text-fg-dim transition-colors hover:bg-border-soft/55 hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            >
              <X size={15} />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            <GameTeamPanel
              mode="organization"
              onOpenDetails={openTeamDetailsFromMain}
            />
          </div>
        </div>
      )}
      {isChat && <MainFilePreview scope={previewScope} />}
      <FilePreviewDrawer
        refData={filePreviewRef}
        cwd={workspaceCwd || undefined}
        diffEnabled={Boolean(
          workspaceCwd && !isRemoteWorkspacePath(workspaceCwd),
        )}
        onClose={() => setFilePreviewRef(null)}
      />
      {keyModalChannel && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-bg/75 px-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-lg border border-border bg-panel p-4 shadow-2xl">
            <div className="flex items-start gap-3">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-accent/40 bg-accent/10 text-accent">
                ✦
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-semibold text-fg">
                  {t(locale, "dock.freeKeyTitle")} · {keyModalChannel.label}
                </h3>
                <p className="mt-1 text-xs leading-relaxed text-fg-faint">
                  {t(locale, "dock.freeKeyDescription")}
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setKeyModalChannel(null);
                  setKeyModalValue("");
                }}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-faint transition-colors hover:bg-border-soft hover:text-fg"
                title={t(locale, "common.close")}
              >
                <X size={15} strokeWidth={2} />
              </button>
            </div>

            <div className="mt-4 space-y-3">
              <input
                type="password"
                value={keyModalValue}
                onChange={(event) => setKeyModalValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") saveKeyModal();
                  if (event.key === "Escape") {
                    setKeyModalChannel(null);
                    setKeyModalValue("");
                  }
                }}
                autoFocus
                placeholder={t(locale, "dock.freeKeyPlaceholder")}
                autoComplete="off"
                spellCheck={false}
                className="w-full rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg outline-none transition-colors focus:border-accent"
              />
              <div className="flex flex-wrap items-center justify-between gap-2">
                {keyModalChannel.credentialUrl ? (
                  <button
                    type="button"
                    onClick={() =>
                      void openExternal(keyModalChannel.credentialUrl as string)
                    }
                    className="rounded-md border border-border bg-panel-2 px-3 py-1.5 text-xs text-fg-dim transition-colors hover:border-accent hover:text-fg"
                  >
                    {t(locale, "dock.freeKeyGet")}
                  </button>
                ) : (
                  <span className="text-xs text-fg-faint">
                    {t(locale, "dock.freeKeyNoUrl")}
                  </span>
                )}
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setKeyModalChannel(null);
                      setKeyModalValue("");
                    }}
                    className="rounded-md border border-border bg-panel-2 px-3 py-1.5 text-xs text-fg-dim transition-colors hover:border-accent hover:text-fg"
                  >
                    {t(locale, "dock.freeKeyCancel")}
                  </button>
                  <button
                    type="button"
                    onClick={saveKeyModal}
                    disabled={!keyModalValue.trim()}
                    className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-bg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {t(locale, "dock.freeKeySave")}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
      {localSetupChannel?.id === "ollama" && (
        <LocalModelSetupDialog
          locale={locale}
          downloadUrl={localSetupChannel.setupUrl}
          statusMessage={localSetupMessage}
          onClose={() => {
            setLocalSetupChannel(null);
            setLocalModelValue("");
            setLocalSetupMessage(null);
          }}
          onModelSelected={(model) => {
            setFreeChannelModel(localSetupChannel.id, model);
            setLocalModelValue(model);
            setLocalSetupMessage(t(locale, "settings.localModel.setupStarted"));
          }}
        />
      )}
      {localSetupChannel && localSetupChannel.id !== "ollama" && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-bg/75 px-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-lg border border-border bg-panel p-4 shadow-2xl">
            <div className="flex items-start gap-3">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-accent/40 bg-accent/10 text-accent">
                ▣
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-semibold text-fg">
                  {t(locale, "dock.localModelTitle")} ·{" "}
                  {localSetupChannel.label}
                </h3>
                <p className="mt-1 text-xs leading-relaxed text-fg-faint">
                  {t(locale, "dock.localModelDescription")}
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setLocalSetupChannel(null);
                  setLocalModelValue("");
                  setLocalSetupMessage(null);
                }}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-faint transition-colors hover:bg-border-soft hover:text-fg"
                title={t(locale, "common.close")}
              >
                <X size={15} strokeWidth={2} />
              </button>
            </div>

            <div className="mt-4 space-y-3">
              {localSetupMessage && (
                <p className="rounded-md border border-status-warning/30 bg-status-warning/10 px-3 py-2 text-[11px] leading-relaxed text-status-warning">
                  {localSetupMessage}
                </p>
              )}
              <label className="block space-y-1">
                <span className="text-[11px] font-medium text-fg-dim">
                  {t(locale, "settings.freeChannels.modelLabel")}
                </span>
                <input
                  type="text"
                  value={localModelValue}
                  onChange={(event) => setLocalModelValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") saveLocalModelModal();
                    if (event.key === "Escape") {
                      setLocalSetupChannel(null);
                      setLocalModelValue("");
                      setLocalSetupMessage(null);
                    }
                  }}
                  autoFocus
                  placeholder={t(locale, "dock.localModelPlaceholder")}
                  autoComplete="off"
                  spellCheck={false}
                  className="w-full rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg outline-none transition-colors focus:border-accent"
                />
              </label>
              <div className="flex flex-wrap items-center justify-between gap-2">
                {localSetupChannel.setupUrl ? (
                  <button
                    type="button"
                    onClick={() =>
                      void openExternal(localSetupChannel.setupUrl as string)
                    }
                    className="rounded-md border border-border bg-panel-2 px-3 py-1.5 text-xs text-fg-dim transition-colors hover:border-accent hover:text-fg"
                  >
                    {t(locale, "dock.localModelDownload")}
                  </button>
                ) : (
                  <span className="text-xs text-fg-faint">
                    {t(locale, "dock.localModelNoUrl")}
                  </span>
                )}
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setLocalSetupChannel(null);
                      setLocalModelValue("");
                      setLocalSetupMessage(null);
                    }}
                    className="rounded-md border border-border bg-panel-2 px-3 py-1.5 text-xs text-fg-dim transition-colors hover:border-accent hover:text-fg"
                  >
                    {t(locale, "dock.freeKeyCancel")}
                  </button>
                  <button
                    type="button"
                    onClick={saveLocalModelModal}
                    disabled={!localModelValue.trim() || checkingLocalModel}
                    className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-bg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {checkingLocalModel
                      ? t(locale, "settings.freeChannels.localChecking")
                      : t(locale, "dock.localModelSave")}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
