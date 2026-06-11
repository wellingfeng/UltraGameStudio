import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  type ReactNode,
} from 'react';
import {
  ArrowDownToLine,
  ArrowUp,
  ArrowUpToLine,
  Check,
  ChevronDown,
  ChevronUp,
  Eye,
  File,
  Folder,
  GitBranch,
  Hash,
  Languages,
  ListChecks,
  Loader2,
  Plus,
  RotateCcw,
  Search,
  ShieldAlert,
  ShieldQuestionMark,
  Square,
  Trash2,
  X,
  Zap,
} from 'lucide-react';
import Select from '@/components/Select';
import { summarizeAnswer, type InteractionAnswer } from '@/core/interaction';
import { readStartUserInputs } from '@/core/startInputs';
import {
  systemDefaultGatewaySelection,
  workflowDefaultGatewaySelection,
} from '@/lib/modelGateway/resolver';
import {
  RUNTIME_ADAPTERS,
  type RuntimeAdapterId,
} from '@/lib/adapters';
import {
  getProviderRuntimeInfo,
  listProviders,
  type Provider,
  type ProviderKind,
  type ProviderRuntimeStatus,
} from '@/lib/apiConfig';
import {
  getCliRuntimeSnapshot,
  isCliAdapterAvailable,
} from '@/lib/cliConfig';
import { cn } from '@/lib/cn';
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
} from '@/lib/freeChannels';
import LocalModelSetupDialog from '@/components/LocalModelSetupDialog';
import {
  IMAGE_PROVIDERS,
  imageProviderModel,
  imageProviderReady,
  loadImageGenerationSettings,
  saveImageGenerationSettings,
  type ImageGenerationSettings,
  type ImageProviderId,
} from '@/lib/imageGeneration';
import {
  MUSIC_PROVIDERS,
  loadMusicGenerationSettings,
  musicProviderModel,
  musicProviderReady,
  saveMusicGenerationSettings,
  type MusicGenerationSettings,
  type MusicProviderId,
} from '@/lib/musicGeneration';
import {
  THREE_D_PROVIDERS,
  loadThreeDGenerationSettings,
  saveThreeDGenerationSettings,
  threeDProviderModel,
  threeDProviderReady,
  type ThreeDGenerationSettings,
  type ThreeDProviderId,
} from '@/lib/threeDGeneration';
import type { SelectOption } from '@/store/types';
import {
  LANGUAGE_SELECT_OPTIONS,
  localizeSelectOption,
  t,
  type Locale,
} from '@/lib/i18n';
import type { Message } from '@/store/types';
import {
  SLASH_COMMANDS,
  buildSlashSuggestions,
  slashText,
  type SlashSuggestion,
} from '@/lib/slashCommands';
import {
  parseGameExpertCommand,
  gameExpertMenuEntries,
} from '@/lib/gameExperts';
import {
  loadDockHeight,
  loadPaneWidth,
  saveDockHeight,
  savePaneWidth,
} from '@/lib/composerStorage';
import {
  describeShortcutBinding,
  isNativeTextareaNewlineShortcut,
  loadShortcutSettings,
  matchesShortcut,
  shortcutParts,
  subscribeShortcutSettings,
} from '@/lib/keyboardShortcuts';
import { shouldRefocusComposerAfterAppend } from '@/lib/composerEntryPolicy';
import {
  tauriAvailable,
  localModelStatus,
  listWorkspaceDirectory,
  onSlashCatalogUpdated,
  openExternal,
  openLocalPath,
  saveClipboardImage,
  slashCatalog,
  type LocalModelRuntimeStatus,
  type SlashCatalogEntry,
  type WorkspaceTreeEntry,
} from '@/lib/tauri';
import {
  applyProjectFileDragDropEffect,
  clearProjectFileDragData,
  hasProjectFileDragData,
  PROJECT_FILE_DRAG_END_EVENT,
  PROJECT_FILE_DRAG_MOVE_EVENT,
  type ProjectFileDragEndDetail,
  type ProjectFileDragMoveDetail,
  projectFilePathsFromDataTransfer,
  setProjectFileDragAccepted,
} from '@/lib/projectFileDrag';
import {
  canRefreshFreeChannelModels,
  freeChannelModelOptions,
  providerModelOptions,
  refreshFreeChannelModels,
  refreshProviderModels,
} from '@/lib/modelLists';
import { formatCompactTokenCount } from '@/lib/contextUsage';
import LazyMessageContent from '@/components/ai/LazyMessageContent';
import CopyButton from '@/components/ai/CopyButton';
import {
  answerActionText,
  cleanMessageText,
  renderMessageText,
  routeLabelFromText,
} from '@/components/ai/lib/messageText';
import { translatePublicText } from '@/lib/publicTranslation';
import { captureConversation } from '@/lib/sessionScreenshot';
import { recordConversationGif } from '@/lib/sessionGif';
import UltracodeRunCard from '@/panels/UltracodeRunCard';
import FileText from '@/components/ai/FileText';
import FilePreviewDrawer from '@/components/ai/FilePreviewDrawer';
import type { FileRef } from '@/components/ai/lib/filePath';
import type { OpenFileIntent } from '@/components/ai/FileChip';
import { shallow } from 'zustand/shallow';
import {
  isActiveAiEditingSession,
  useStore,
  type StoreState,
} from '@/store/useStore';

const DEFAULT_DOCK_HEIGHT = 208; // matches the former h-52
const MIN_DOCK_HEIGHT = 120;
/**
 * How many trailing messages render rich markdown eagerly on (re)mount. The rest
 * start as cheap plain text and upgrade lazily on scroll — see LazyMessageContent.
 * Sized to comfortably cover the visible bottom of the stream after auto-scroll.
 */
const EAGER_MESSAGE_TAIL = 6;
const STREAM_BOTTOM_TOLERANCE = 32;
/** Fixed height of the bottom input area in 'chat' layout (return fills the rest). */
const CHAT_INPUT_HEIGHT = 300;

/** localStorage key + bounds for the AI-input pane width (right column). */
const INPUT_WIDTH_KEY = 'freeultracode.aiInputWidth.v1';
const DEFAULT_INPUT_WIDTH = 384; // matches the former w-96
const MIN_INPUT_WIDTH = 280;
const MIN_RETURN_WIDTH = 240; // keep the AI-return pane usable
const NARROW_INPUT_MIN_WIDTH = 120;
const NARROW_INPUT_WIDTH_RATIO = 0.4;

/** localStorage key + bounds for the bottom input area height in 'chat' layout. */
const CHAT_INPUT_HEIGHT_KEY = 'freeultracode.chatInputHeight.v1';
const MIN_CHAT_INPUT_HEIGHT = 180;
const MIN_CHAT_RETURN_HEIGHT = 160; // keep the chat return area usable
const MAX_CHAT_TITLE_LENGTH = 80;

/** Clamp the chat input-area height so neither it nor the return area collapses. */
function clampChatInputHeight(h: number): number {
  const max =
    typeof window !== 'undefined'
      ? Math.max(MIN_CHAT_INPUT_HEIGHT, window.innerHeight - MIN_CHAT_RETURN_HEIGHT)
      : 480;
  return Math.min(Math.max(h, MIN_CHAT_INPUT_HEIGHT), max);
}

function clampHeight(h: number): number {
  const max =
    typeof window !== 'undefined' ? window.innerHeight * 0.75 : 600;
  return Math.min(Math.max(h, MIN_DOCK_HEIGHT), max);
}

interface StreamScrollSnapshot {
  atBottom: boolean;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  anchorMessageId: string | null;
  anchorOffsetTop: number;
}

function streamScrollKey(
  layout: 'dock' | 'chat',
  workspaceId: string | null | undefined,
  sessionId: string | null | undefined,
): string {
  return `${layout}:${workspaceId ?? 'global'}:${sessionId ?? 'none'}`;
}

function isStreamAtBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= STREAM_BOTTOM_TOLERANCE;
}

function scrollStreamToBottom(el: HTMLElement): void {
  if (typeof el.scrollTo === 'function') {
    el.scrollTo({ top: el.scrollHeight, behavior: 'instant' });
  } else {
    el.scrollTop = el.scrollHeight;
  }
}

function visibleStreamAnchor(
  stream: HTMLElement,
  messageRefs: Map<string, HTMLLIElement>,
): { messageId: string; offsetTop: number } | null {
  const streamRect = stream.getBoundingClientRect();
  if (streamRect.height <= 0 && stream.clientHeight <= 0) return null;

  for (const [messageId, node] of messageRefs) {
    const rect = node.getBoundingClientRect();
    const hasLayout =
      rect.width !== 0 || rect.height !== 0 || rect.top !== 0 || rect.bottom !== 0;
    if (!hasLayout) continue;
    if (rect.bottom < streamRect.top) continue;
    if (rect.top > streamRect.bottom) continue;
    return { messageId, offsetTop: rect.top - streamRect.top };
  }

  return null;
}

function readStreamScrollSnapshot(
  stream: HTMLElement,
  messageRefs: Map<string, HTMLLIElement>,
): StreamScrollSnapshot {
  const anchor = visibleStreamAnchor(stream, messageRefs);
  return {
    atBottom: isStreamAtBottom(stream),
    scrollTop: stream.scrollTop,
    scrollHeight: stream.scrollHeight,
    clientHeight: stream.clientHeight,
    anchorMessageId: anchor?.messageId ?? null,
    anchorOffsetTop: anchor?.offsetTop ?? 0,
  };
}

function restoreStreamScrollSnapshot(
  stream: HTMLElement,
  messageRefs: Map<string, HTMLLIElement>,
  snapshot: StreamScrollSnapshot | undefined,
): boolean {
  if (!snapshot || snapshot.atBottom) {
    scrollStreamToBottom(stream);
    return true;
  }

  if (snapshot.anchorMessageId) {
    const node = messageRefs.get(snapshot.anchorMessageId);
    if (!node) {
      stream.scrollTop = snapshot.scrollTop;
      return false;
    }
    const streamRect = stream.getBoundingClientRect();
    const nodeRect = node.getBoundingClientRect();
    const delta =
      nodeRect.top - streamRect.top - snapshot.anchorOffsetTop;
    if (Number.isFinite(delta) && Math.abs(delta) > 0.5) {
      stream.scrollTop += delta;
    }
    return true;
  }

  stream.scrollTop = snapshot.scrollTop;
  return true;
}

type ChatTitleState = Pick<
  StoreState,
  | 'activeSessionId'
  | 'activeWorkspaceId'
  | 'sessions'
  | 'sessionTree'
  | 'workflow'
>;

function activeChatTitle(state: ChatTitleState): string {
  const activeSessionId = state.activeSessionId;
  if (!activeSessionId) return state.workflow.meta?.name ?? '';

  const activeSession = state.activeWorkspaceId
    ? (state.sessionTree[state.activeWorkspaceId]?.find(
        (session) => session.id === activeSessionId,
      ) ??
      state.sessions.find(
        (session) =>
          session.id === activeSessionId &&
          (session.workspaceId == null ||
            session.workspaceId === state.activeWorkspaceId),
      ))
    : state.sessions.find((session) => session.id === activeSessionId);

  return activeSession?.title?.trim() || state.workflow.meta?.name || '';
}

function formatMessageTime(ts: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(ts));
}

type SearchMatchSource = 'text' | 'interaction';

interface SearchMatch {
  id: string;
  messageId: string;
  source: SearchMatchSource;
}

type MessageActionMenu =
  | { messageId: string; kind: 'model' | 'translate' }
  | null;

interface SlashTrigger {
  start: number;
  end: number;
  query: string;
}

interface FileMentionTrigger {
  start: number;
  end: number;
  directory: string;
  query: string;
}

type FileMentionListing =
  | {
      status: 'idle';
      rootPath: string;
      directory: string;
      entries: WorkspaceTreeEntry[];
      message?: undefined;
    }
  | {
      status: 'loading';
      rootPath: string;
      directory: string;
      entries: WorkspaceTreeEntry[];
      message?: undefined;
    }
  | {
      status: 'ready';
      rootPath: string;
      directory: string;
      entries: WorkspaceTreeEntry[];
      message?: undefined;
    }
  | {
      status: 'error';
      rootPath: string;
      directory: string;
      entries: WorkspaceTreeEntry[];
      message: string;
    };

const MAX_SLASH_SUGGESTIONS = 10;
const MAX_FILE_MENTION_SUGGESTIONS = 12;

function slashSuggestionRankForAdapter(
  suggestion: SlashSuggestion,
  adapter: RuntimeAdapterId,
): number {
  const sourceAdapter = suggestion.sourceAdapter;
  if (sourceAdapter === adapter) return 2;
  if (!sourceAdapter || sourceAdapter === 'app' || sourceAdapter === 'agent') {
    return 1;
  }
  return 0;
}

function scopeSlashSuggestionsForAdapter(
  suggestions: SlashSuggestion[],
  adapter: RuntimeAdapterId,
): SlashSuggestion[] {
  const scoped = suggestions
    .filter((suggestion) => slashSuggestionRankForAdapter(suggestion, adapter) > 0)
    .sort(
      (a, b) =>
        slashSuggestionRankForAdapter(b, adapter) -
        slashSuggestionRankForAdapter(a, adapter),
    );
  const seen = new Set<string>();
  const out: SlashSuggestion[] = [];
  for (const suggestion of scoped) {
    const key = `${suggestion.kind}:${suggestion.name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(suggestion);
  }
  return out;
}

function findSlashTrigger(text: string, caret: number): SlashTrigger | null {
  if (caret < 1) return null;

  const beforeCaret = text.slice(0, caret);
  const match = /(^|\s)\/([^\s/]*)$/.exec(beforeCaret);
  if (!match) return null;

  const query = match[2] ?? '';
  const start = beforeCaret.length - query.length - 1;
  return { start, end: caret, query };
}

function normalizeFileMentionPath(value: string): string {
  return value
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\/+/, '');
}

function splitFileMentionPath(value: string): {
  directory: string;
  query: string;
} {
  const normalized = normalizeFileMentionPath(value);
  const slash = normalized.lastIndexOf('/');
  if (slash === -1) return { directory: '', query: normalized };
  return {
    directory: normalized.slice(0, slash).replace(/^\/+|\/+$/g, ''),
    query: normalized.slice(slash + 1),
  };
}

function findFileMentionTrigger(
  text: string,
  caret: number,
): FileMentionTrigger | null {
  if (caret < 1) return null;

  const beforeCaret = text.slice(0, caret);
  const match = /(^|\s)@([^\s]*)$/.exec(beforeCaret);
  if (!match) return null;

  const rawPath = match[2] ?? '';
  const start = beforeCaret.length - rawPath.length - 1;
  const { directory, query } = splitFileMentionPath(rawPath);
  return { start, end: caret, directory, query };
}

function filterSlashSuggestions(
  suggestions: SlashSuggestion[],
  query: string,
): SlashSuggestion[] {
  const q = query.trim().toLowerCase();
  if (!q) return suggestions.slice(0, MAX_SLASH_SUGGESTIONS);

  const starts: SlashSuggestion[] = [];
  const contains: SlashSuggestion[] = [];
  for (const suggestion of suggestions) {
    const name = suggestion.name.slice(1).toLowerCase();
    const label = suggestion.label.toLowerCase();
    if (name.startsWith(q) || label.startsWith(q)) {
      starts.push(suggestion);
      continue;
    }
    if (suggestion.searchText.includes(q)) contains.push(suggestion);
  }

  return [...starts, ...contains].slice(0, MAX_SLASH_SUGGESTIONS);
}

function filterFileMentionEntries(
  entries: WorkspaceTreeEntry[],
  query: string,
): WorkspaceTreeEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries.slice(0, MAX_FILE_MENTION_SUGGESTIONS);

  const starts: WorkspaceTreeEntry[] = [];
  const contains: WorkspaceTreeEntry[] = [];
  for (const entry of entries) {
    const name = entry.name.toLowerCase();
    const path = entry.relativePath.toLowerCase();
    if (name.startsWith(q) || path.startsWith(q)) {
      starts.push(entry);
      continue;
    }
    if (name.includes(q) || path.includes(q)) contains.push(entry);
  }

  return [...starts, ...contains].slice(0, MAX_FILE_MENTION_SUGGESTIONS);
}

function fileMentionInsertText(entry: WorkspaceTreeEntry): string {
  const relativePath = normalizeFileMentionPath(entry.relativePath);
  return `@${relativePath}${entry.kind === 'directory' ? '/' : ''}`;
}

function fileMentionErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message === 'NO_BACKEND') {
    return '当前浏览器模式不能读取本机文件。请使用桌面端。';
  }
  return err instanceof Error ? err.message : String(err);
}

function findSlashSuggestionForText(
  text: string,
  suggestions: SlashSuggestion[],
): { suggestion: SlashSuggestion; request: string } | null {
  const match = /^\/[^\s]+(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!match) return null;
  const command = text.trim().split(/\s+/, 1)[0]?.toLowerCase();
  if (!command) return null;
  const suggestion = suggestions.find(
    (item) => item.name.toLowerCase() === command,
  );
  if (!suggestion) return null;
  return {
    suggestion,
    request: (match[1] ?? '').trim(),
  };
}

function expandSlashRequest(
  text: string,
  suggestions: SlashSuggestion[],
): string {
  const found = findSlashSuggestionForText(text, suggestions);
  if (!found) return text;
  const { suggestion, request } = found;
  const instruction =
    suggestion.insertText.trim() ||
    suggestion.detail.trim() ||
    `Use ${suggestion.name} for this request.`;
  if (!request) return instruction;
  return `${instruction}\n\n请求：\n${request}`;
}

function normalizeSearchQuery(value: string): string {
  return value.trim().toLowerCase();
}

function previousUserText(messages: Message[], messageId: string): string {
  const index = messages.findIndex((message) => message.id === messageId);
  if (index <= 0) return '';
  for (let i = index - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role === 'user') return message.text.trim();
  }
  return '';
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
type PermissionTone = 'safe' | 'caution' | 'danger';

function permissionVisual(id: string): {
  Icon: typeof Eye;
  tone: PermissionTone;
  color: string;
} {
  if (id === 'readonly') {
    return { Icon: Eye, tone: 'safe', color: 'var(--status-ai-edit)' };
  }
  if (id === 'ask') {
    return { Icon: ListChecks, tone: 'caution', color: 'var(--accent-3)' };
  }
  // 'full' (and any unknown id) → most permissive, treat as the danger segment.
  return { Icon: ShieldAlert, tone: 'danger', color: 'var(--status-error)' };
}

/**
 * Display rank for the permission segments — left→right means increasing
 * privilege, so the most permissive ("full") sits at the far right. The store
 * array order is independent of this (it still drives the default), so we sort
 * a copy at render time using this rank.
 */
function permissionRank(id: string): number {
  if (id === 'readonly') return 0; // 只读 — 最低
  if (id === 'ask') return 1; // 每次询问 — 居中
  return 2; // 完全访问 — 最高，置于最右
}

function assistantHeaderLabel(message: Message): string {
  return message.routeLabel?.trim() || routeLabelFromText(message.text);
}

function translatedAnswerTitle(target: Locale, locale: Locale): string {
  const option = LANGUAGE_SELECT_OPTIONS.find((item) => item.id === target);
  if (!option) return `🌐 翻译为 ${target}`;
  return `🌐 翻译为 ${localizeSelectOption(option, locale).label}`;
}

function isCaptureUtilityMessage(message: Message): boolean {
  const text = message.text.trim();
  if (
    message.role === 'user' &&
    /^\/screenshot(?:-gif)?$/i.test(text)
  ) {
    return true;
  }
  return (
    /^✓\s*(?:已截图当前会话|Captured this conversation|已把当前会话录成滚动 GIF|Recorded this conversation as a scrolling GIF)/i.test(text) ||
    /^✗\s*(?:截图失败|Screenshot failed|GIF 录制失败|GIF recording failed)/i.test(text) ||
    /!\[(?:截图预览|screenshot preview|GIF 预览|GIF preview)\]\(/i.test(text)
  );
}

function messageActionButtonClass(active = false): string {
  return (
    'relative flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-faint transition-colors hover:bg-border-soft hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-40 ' +
    (active ? 'bg-border-soft text-fg' : '')
  );
}

function MessageActionMenuPanel({
  children,
}: {
  children: ReactNode;
}) {
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
  usage?: Message['usage'];
  onToggleMenu: (kind: 'model' | 'translate') => void;
  onRegenerate: () => void;
  onRegenerateWithModel: (model: string) => void;
  onTranslate: (target: Locale) => void;
  onBranch: () => void;
  onDelete: () => void;
}) {
  const modelMenuOpen =
    openMenu?.messageId === messageId && openMenu.kind === 'model';
  const translateMenuOpen =
    openMenu?.messageId === messageId && openMenu.kind === 'translate';
  return (
    <div className="relative mt-1 flex items-center gap-1">
      <CopyButton
        value={text}
        title="复制 AI 回答"
        className={messageActionButtonClass()}
      />
      <button
        type="button"
        onClick={onBranch}
        title="从这里创建分支会话"
        aria-label="创建会话分支"
        className={messageActionButtonClass()}
      >
        <GitBranch size={14} />
      </button>
      <button
        type="button"
        onClick={onRegenerate}
        disabled={!canRegenerate}
        title="重新生成回答"
        aria-label="重新生成回答"
        className={messageActionButtonClass()}
      >
        <RotateCcw size={14} />
      </button>
      <div className="relative">
        <button
          type="button"
          onClick={() => onToggleMenu('model')}
          disabled={!canRegenerate || modelOptions.length === 0}
          title="切换模型回答"
          aria-label="切换模型回答"
          aria-expanded={modelMenuOpen}
          className={messageActionButtonClass(modelMenuOpen)}
        >
          <span className="font-mono text-sm font-semibold">@</span>
        </button>
        {modelMenuOpen && (
          <MessageActionMenuPanel>
            {modelOptions.map((option, index) => {
              const showGroup =
                !!option.group && option.group !== modelOptions[index - 1]?.group;
              return (
                <div key={option.id}>
                  {showGroup && (
                    <div className="px-3 pb-1 pt-1.5 font-mono text-[9px] uppercase tracking-wider text-fg-faint">
                      {option.group}
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => onRegenerateWithModel(option.id)}
                    className={
                      'flex w-full items-center gap-2 whitespace-nowrap px-3 py-1.5 text-left text-xs transition-colors ' +
                      (option.id === modelValue
                        ? 'bg-border-soft text-fg'
                        : 'text-fg-dim hover:bg-border-soft hover:text-fg')
                    }
                  >
                    <span
                      className={
                        option.id === modelValue
                          ? 'text-[10px] text-accent'
                          : 'text-[10px] text-transparent'
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
          onClick={() => onToggleMenu('translate')}
          disabled={!text}
          title="翻译回答"
          aria-label="翻译回答"
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
        title="删除回答"
        aria-label="删除回答"
        className={messageActionButtonClass()}
      >
        <Trash2 size={14} />
      </button>
      {usage && usage.totalTokens > 0 && (
        <span
          className="ml-auto inline-flex shrink-0 items-center gap-2 pl-2 font-mono text-[10px] text-fg-faint"
          title={
            usage.estimated
              ? `本轮 tokens（本地估算）：输入 ${usage.inputTokens} · 输出 ${usage.outputTokens}`
              : `本轮 tokens：输入 ${usage.inputTokens} · 输出 ${usage.outputTokens} · 缓存命中 ${usage.cachedInputTokens}`
          }
        >
          <span className="inline-flex items-center gap-1">
            <Hash size={11} />
            {formatCompactTokenCount(usage.totalTokens)}
          </span>
          <span className="inline-flex items-center gap-1">
            <Zap size={11} className="text-[var(--accent-3)]" />
            {usage.estimated
              ? '--'
              : `${Math.min(999, Math.round(usage.cachePercent))}%`}
          </span>
        </span>
      )}
    </div>
  );
}

function interactionSearchText(message: Message): string {
  if (!message.interaction) return '';
  const parts = [message.interaction.prompt];
  if (message.interaction.options?.length) {
    parts.push(message.interaction.options.join(' '));
  }
  if (message.interactionAnswer) {
    parts.push(summarizeAnswer(message.interaction, message.interactionAnswer));
  }
  return parts.filter(Boolean).join('\n');
}

function buildSearchMatches(messages: Message[], query: string): SearchMatch[] {
  if (!query) return [];

  const out: SearchMatch[] = [];
  const lowerQuery = query.toLowerCase();

  for (const message of messages) {
    const segments: Array<{ source: SearchMatchSource; text: string }> = [];
    const cleaned = cleanMessageText(message.text);
    if (cleaned.trim()) {
      segments.push({ source: 'text', text: cleaned });
    }
    const interactionText = interactionSearchText(message);
    if (interactionText) {
      segments.push({ source: 'interaction', text: interactionText });
    }

    for (const segment of segments) {
      const lowerText = segment.text.toLowerCase();
      let start = 0;
      let hitIndex = 0;

      while (start <= lowerText.length) {
        const found = lowerText.indexOf(lowerQuery, start);
        if (found === -1) break;
        out.push({
          id: `${message.id}:${segment.source}:${hitIndex}`,
          messageId: message.id,
          source: segment.source,
        });
        hitIndex += 1;
        start = found + Math.max(lowerQuery.length, 1);
      }
    }
  }

  return out;
}

function renderHighlightedText(
  text: string,
  messageId: string,
  query: string,
  activeMatchId: string | null,
  onActiveMatchNode: (node: HTMLElement | null) => void,
): ReactNode {
  if (!query) return text;

  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  if (!lowerQuery) return text;

  const nodes: ReactNode[] = [];
  let cursor = 0;
  let hitIndex = 0;

  while (cursor <= lowerText.length) {
    const found = lowerText.indexOf(lowerQuery, cursor);
    if (found === -1) break;
    if (found > cursor) nodes.push(text.slice(cursor, found));

    const matchId = `${messageId}:text:${hitIndex}`;
    const isActive = matchId === activeMatchId;
    nodes.push(
      <mark
        key={matchId}
        data-search-match-id={matchId}
        ref={
          isActive
            ? (node) => {
                onActiveMatchNode(node);
              }
            : undefined
        }
        className={
          'rounded-sm px-0.5 text-fg transition-colors ' +
          (isActive
            ? 'bg-accent-3/35 ring-1 ring-inset ring-accent-3/55'
            : 'bg-accent/20')
        }
      >
        {text.slice(found, found + lowerQuery.length)}
      </mark>,
    );

    hitIndex += 1;
    cursor = found + Math.max(lowerQuery.length, 1);
  }

  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes.length > 0 ? nodes : text;
}

interface TextSelection {
  start: number;
  end: number;
}

function clampSelection(value: number, max: number): number {
  return Math.min(Math.max(value, 0), max);
}

function formatFilePathInsertion(paths: string[]): string {
  return paths.map((path) => path.trim()).filter(Boolean).join('\n');
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

  const { open } = await import('@tauri-apps/plugin-dialog');
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
  const images: File[] = [];

  const add = (file: File | null, mimeHint = '') => {
    if (!file) return;
    const mime = (file.type || mimeHint).toLowerCase();
    if (!mime.startsWith('image/')) return;
    const key = [mime, file.name, file.size, file.lastModified].join('\0');
    if (seen.has(key)) return;
    seen.add(key);
    images.push(file);
  };

  for (const item of Array.from(dataTransfer.items)) {
    if (item.kind !== 'file') continue;
    if (!item.type.toLowerCase().startsWith('image/')) continue;
    add(item.getAsFile(), item.type);
  }
  if (images.length > 0) return images;

  for (const file of Array.from(dataTransfer.files)) add(file);

  return images;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

async function fileToBase64(file: File): Promise<string> {
  return bytesToBase64(new Uint8Array(await file.arrayBuffer()));
}

async function savePastedImageFile(file: File, cwd: string): Promise<string> {
  return saveClipboardImage({
    bytesBase64: await fileToBase64(file),
    mime: file.type || 'image/png',
    fileName: file.name || null,
    cwd: cwd || null,
  });
}

function describeLocalModelStatus(
  locale: Locale,
  channel: FreeChannel,
  status: LocalModelRuntimeStatus,
): string {
  const suffix = status.message ? ` ${status.message}` : '';
  if (status.state === 'missing_model') {
    return `${channel.label}: ${t(locale, 'settings.freeChannels.localMissingModel')}。`;
  }
  if (status.state === 'service_unavailable') {
    return `${channel.label}: ${t(locale, 'settings.freeChannels.localServiceDown')}。${suffix}`;
  }
  if (status.state === 'model_missing') {
    return `${channel.label}: ${t(locale, 'settings.freeChannels.localModelMissing')} (${status.configuredModel})。${suffix}`;
  }
  if (status.state === 'desktop_unavailable') {
    return `${channel.label}: ${t(locale, 'settings.freeChannels.localDesktopOnly')}。`;
  }
  if (status.state === 'unsupported') {
    return `${channel.label}: ${t(locale, 'settings.freeChannels.localUnsupported')}。${suffix}`;
  }
  return `${channel.label}: ${t(locale, 'settings.freeChannels.localServiceError')}。${suffix}`;
}

const DEFAULT_PROVIDER_OPTION_PREFIX = 'default-provider:';
const SYSTEM_DEFAULT_OPTION_PREFIX = 'system-default:';
const FREE_CHANNEL_OPTION_PREFIX = 'free:';

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
  return `${adapter.label} · ${t(locale, 'dock.channelKindDefault')}`;
}

function defaultChannelRuntimeGroup(
  locale: Locale,
  adapter: { label: string },
): string {
  return `${t(locale, 'dock.channelGroupDefault')} · ${adapter.label}`;
}

function providerKindToAdapter(kind: ProviderKind): RuntimeAdapterId {
  if (kind === 'codex') return 'codex';
  if (kind === 'gemini') return 'gemini';
  return 'claude-code';
}

function providerSelection(provider: Provider, modelOverride?: string) {
  const adapter = providerKindToAdapter(provider.kind);
  const model = (modelOverride ?? provider.model ?? '').trim();
  return {
    adapter,
    modelClass: model || 'default',
    providerId: provider.id,
    channelId: 'default',
  };
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
    case 'prefer-better':
      return 'dock.modelStrategy.better';
    case 'prefer-cheaper':
      return 'dock.modelStrategy.cheaper';
    case 'smart':
      return 'dock.modelStrategy.smart';
    default:
      return 'dock.modelStrategy.inherit';
  }
}

function providerSortRank(status: ProviderRuntimeStatus): number {
  if (status === 'direct') return 1;
  if (status === 'cli') return 2;
  return 3;
}

function interactionOptionCountLabel(locale: Locale, count: number): string {
  return t(locale, 'interaction.optionCount').replace('{count}', String(count));
}

function splitInteractionOption(option: string): { title: string; detail: string } {
  const lines = option
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length > 1) {
    return { title: lines[0], detail: lines.slice(1).join(' ') };
  }

  const colon = option.match(/^(.{2,48}?)[：:]\s+(.+)$/);
  if (colon) {
    return { title: colon[1].trim(), detail: colon[2].trim() };
  }

  return { title: option.trim(), detail: '' };
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
}: {
  message: Message;
  locale: Locale;
  active: boolean;
  onAnswer: (answer: InteractionAnswer) => void;
  onDismiss: () => void;
}) {
  const req = message.interaction;
  const status = message.interactionStatus ?? 'pending';
  const [selected, setSelected] = useState<string[]>([]);
  const [text, setText] = useState('');

  if (!req) return null;

  if (status === 'answered' && message.interactionAnswer) {
    return (
      <div className="rounded-lg border border-accent-2/40 bg-accent-2/10 px-3 py-2 text-xs text-fg-dim shadow-sm">
        <span className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-accent-2">
          <Check size={12} strokeWidth={2.4} />
          {t(locale, 'interaction.youAnswered')}
        </span>{' '}
        {summarizeAnswer(req, message.interactionAnswer)}
      </div>
    );
  }
  if (status === 'cancelled') {
    return (
      <div className="rounded-lg border border-border bg-panel-2 px-3 py-2 text-xs text-fg-faint shadow-sm">
        {t(locale, 'interaction.cancelled')}
      </div>
    );
  }

  const disabled = !active;
  const trimmedText = text.trim();
  const canSubmitSelect = selected.length > 0;
  const submitSelect = () => {
    if (selected.length > 0) onAnswer({ kind: 'select', values: selected });
  };
  const toggle = (opt: string) => {
    if (req.type !== 'select') return;
    if (!req.multi) {
      onAnswer({ kind: 'select', values: [opt] });
      return;
    }
    setSelected((cur) => {
      return cur.includes(opt)
        ? cur.filter((o) => o !== opt)
        : [...cur, opt];
    });
  };
  const submitInput = () => {
    if (trimmedText) onAnswer({ kind: 'input', text: trimmedText });
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
            {t(locale, 'interaction.title')}
          </div>
          <div className="whitespace-pre-wrap break-words text-sm font-semibold leading-relaxed text-fg">
            {req.prompt}
          </div>
          {req.type === 'select' && (
            <div className="mt-1 text-xs leading-5 text-fg-faint">
              {interactionOptionCountLabel(locale, req.options?.length ?? 0)}
            </div>
          )}
        </div>
      </div>

      {req.type === 'select' && (
        <div className="flex flex-col gap-2">
          {req.multi && (
            <span className="font-mono text-[10px] uppercase tracking-wider text-fg-faint">
              {t(locale, 'interaction.multiHint')}
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
                    'group flex min-h-[54px] w-full items-start gap-3 rounded-md border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-55',
                    on
                      ? 'border-accent/70 bg-accent/10 text-fg'
                      : 'border-border bg-panel-2/70 text-fg hover:border-accent/45 hover:bg-bg',
                  )}
                >
                  {req.multi && (
                    <span
                      aria-hidden="true"
                      className={cn(
                        'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors',
                        on
                          ? 'border-accent bg-accent text-bg'
                          : 'border-fg-faint/60 bg-bg text-transparent group-hover:border-accent/70',
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
          <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
            {!disabled && (
              <button
                type="button"
                onClick={onDismiss}
                className="min-h-8 rounded-md bg-accent-3 px-3 text-xs font-medium text-bg transition-colors hover:bg-accent-3/85 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-3"
                title={t(locale, 'interaction.skipTitle')}
              >
                {t(locale, 'common.cancel')}
              </button>
            )}
            {disabled && (
              <span className="mr-auto font-mono text-[10px] text-fg-faint">
                {t(locale, 'interaction.ended')}
              </span>
            )}
            {req.multi && (
              <button
                type="button"
                disabled={disabled || !canSubmitSelect}
                onClick={submitSelect}
                className="min-h-8 rounded-md bg-fg px-3 text-xs font-medium text-bg transition-colors hover:bg-fg-dim disabled:cursor-not-allowed disabled:opacity-40"
              >
                {t(locale, 'interaction.submit')}
              </button>
            )}
          </div>
        </div>
      )}

      {req.type === 'input' && (
        <div className="flex flex-col gap-2">
          {req.multiline ? (
            <textarea
              value={text}
              disabled={disabled}
              onChange={(e) => setText(e.target.value)}
              placeholder={
                req.placeholder ?? t(locale, 'interaction.inputPlaceholder')
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
                if (e.key === 'Enter' && !e.shiftKey && text.trim()) {
                  e.preventDefault();
                  submitInput();
                }
              }}
              placeholder={
                req.placeholder ?? t(locale, 'interaction.inputPlaceholder')
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
                title={t(locale, 'interaction.skipTitle')}
              >
                {t(locale, 'interaction.skip')}
              </button>
            )}
            {disabled && (
              <span className="mr-auto font-mono text-[10px] text-fg-faint">
                {t(locale, 'interaction.ended')}
              </span>
            )}
            <button
              type="button"
              disabled={disabled || !trimmedText}
              onClick={submitInput}
              className="min-h-8 rounded-md bg-fg px-3 text-xs font-medium text-bg transition-colors hover:bg-fg-dim disabled:cursor-not-allowed disabled:opacity-40"
            >
              {t(locale, 'interaction.submit')}
            </button>
          </div>
        </div>
      )}

      {req.type === 'confirm' && (
        <div className="flex flex-col gap-2">
          <div className="rounded-md border border-border bg-panel-2 px-3 py-2 text-xs leading-relaxed text-fg-faint">
            {t(locale, 'interaction.confirmHint')}
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {!disabled && (
              <button
                type="button"
                onClick={onDismiss}
                className="min-h-8 rounded-md border border-transparent px-2.5 text-xs text-fg-faint transition-colors hover:border-border hover:bg-panel-2 hover:text-fg-dim focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                title={t(locale, 'interaction.skipTitle')}
              >
                {t(locale, 'interaction.skip')}
              </button>
            )}
            {disabled && (
              <span className="mr-auto font-mono text-[10px] text-fg-faint">
                {t(locale, 'interaction.ended')}
              </span>
            )}
            <button
              type="button"
              disabled={disabled}
              onClick={() => onAnswer({ kind: 'confirm', confirmed: false })}
              className="min-h-8 rounded-md border border-border bg-panel-2 px-3 text-xs text-fg-dim transition-colors hover:border-accent-3/60 hover:text-accent-3 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {req.cancelLabel ?? t(locale, 'common.cancel')}
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onAnswer({ kind: 'confirm', confirmed: true })}
              className="min-h-8 rounded-md bg-fg px-3 text-xs font-medium text-bg transition-colors hover:bg-fg-dim disabled:cursor-not-allowed disabled:opacity-40"
            >
              {req.confirmLabel ?? t(locale, 'interaction.confirm')}
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
 *     AI return on top (fills the height), AI input pinned below. No canvas,
 *     no resize handles; reuses the exact same return/input JSX.
 */
export default function AIDock({
  layout = 'dock',
}: {
  layout?: 'dock' | 'chat';
} = {}) {
  const isChat = layout === 'chat';
  const messages = useStore((s) => s.messages);
  const sendPrompt = useStore((s) => s.sendPrompt);
  const generateImagePrompt = useStore((s) => s.generateImagePrompt);
  const generateMusicPrompt = useStore((s) => s.generateMusicPrompt);
  const generateThreeDPrompt = useStore((s) => s.generateThreeDPrompt);
  const searchMeshLibraryPrompt = useStore((s) => s.searchMeshLibraryPrompt);
  const runUltracodePrompt = useStore((s) => s.runUltracodePrompt);
  const appendChatNote = useStore((s) => s.appendChatNote);
  const stopChat = useStore((s) => s.stopChat);
  const blockedSendTip = useStore((s) => s.blockedSendTip);
  const clearBlockedSendTip = useStore((s) => s.clearBlockedSendTip);
  const chatTitle = useStore(activeChatTitle);
  const activeSessionId = useStore((s) => s.activeSessionId);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const renameWorkflowSession = useStore((s) => s.renameWorkflowSession);
  const deleteMessage = useStore((s) => s.deleteMessage);
  const branchSessionFromMessage = useStore((s) => s.branchSessionFromMessage);
  const runSelection = useStore((s) => workflowDefaultGatewaySelection(s.workflow), shallow);
  const selectedAdapter =
    RUNTIME_ADAPTERS.find((adapter) => adapter.id === runSelection.adapter)?.id ??
    RUNTIME_ADAPTERS[0].id;
  const setSessionRunSelection = useStore((s) => s.setSessionRunSelection);
  const composer = useStore((s) => s.composer);
  const draft = useStore((s) => s.composerDraft);
  const composerFocusVersion = useStore((s) => s.composerFocusVersion);
  const locale = useStore((s) => s.locale);
  const [shortcutSettings, setShortcutSettingsState] = useState(
    loadShortcutSettings,
  );
  const gameExpertSettings = useStore((s) => s.gameExpertSettings);
  const setComposer = useStore((s) => s.setComposer);
  const setComposerDraft = useStore((s) => s.setComposerDraft);
  const permissionOptions = useStore((s) => s.permissionOptions);
  const composerModelOptions = useStore((s) => s.modelOptions);
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
    const startNode = s.workflow.nodes.find((node) => node.type === 'start');
    return readStartUserInputs(startNode?.params)[0]?.trim() ?? '';
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
  const streamRef = useRef<HTMLDivElement>(null);
  // The inner message list. We observe its size (not just the scroll
  // container's) so appended messages and streaming tokens — which grow this
  // node while the container keeps its fixed height — still trigger auto-scroll.
  const streamContentRef = useRef<HTMLUListElement>(null);
  // Session long-screenshot (`/screenshot`). While capturing we force every
  // message to render its rich content (off-screen ones are otherwise plain-text
  // placeholders, see LazyMessageContent) so the image is faithful, then restore.
  const [captureStatus, setCaptureStatus] = useState<
    { kind: 'busy' | 'done' | 'error'; text: string } | null
  >(null);
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
  const fileMentionTriggerRef = useRef<FileMentionTrigger | null>(null);
  const lastComposerFocusVersion = useRef(composerFocusVersion);
  const messageRefs = useRef(new Map<string, HTMLLIElement>());
  const activeSearchMatchNodeRef = useRef<HTMLElement | null>(null);
  const searchScrollTopRef = useRef<number | null>(null);
  const lastSearchActiveRef = useRef(false);
  const stickToBottomRef = useRef(true);
  const streamScrollSnapshotsRef = useRef(new Map<string, StreamScrollSnapshot>());
  const activeStreamScrollKey = useMemo(
    () => streamScrollKey(layout, activeWorkspaceId, activeSessionId),
    [activeSessionId, activeWorkspaceId, layout],
  );
  const activeStreamScrollKeyRef = useRef(activeStreamScrollKey);
  activeStreamScrollKeyRef.current = activeStreamScrollKey;
  const pendingStreamScrollRestoreKeyRef = useRef<string | null>(
    activeStreamScrollKey,
  );

  const isReadOnly = mode === 'running';
  const sendShortcutHint = useMemo(
    () =>
      `${describeShortcutBinding(shortcutSettings['composer-send'])} ${t(
        locale,
        'dock.sendShortcutAction',
      )} · ${describeShortcutBinding(
        shortcutSettings['composer-newline'],
      )} ${t(locale, 'dock.newlineShortcutAction')}`,
    [locale, shortcutSettings],
  );
  const [dropActive, setDropActive] = useState(false);
  const [filePreviewRef, setFilePreviewRef] = useState<FileRef | null>(null);
  const [chatTitleEditing, setChatTitleEditing] = useState(false);
  const [chatTitleDraft, setChatTitleDraft] = useState('');
  const [chatTitleSaving, setChatTitleSaving] = useState(false);
  const [returnSearchOpen, setReturnSearchOpen] = useState(false);
  const [returnSearch, setReturnSearch] = useState('');
  const [activeSearchMatchIndex, setActiveSearchMatchIndex] = useState(0);
  const [slashTrigger, setSlashTrigger] = useState<SlashTrigger | null>(null);
  const [activeSlashIndex, setActiveSlashIndex] = useState(0);
  const [fileMentionTrigger, setFileMentionTrigger] =
    useState<FileMentionTrigger | null>(null);
  const [activeFileMentionIndex, setActiveFileMentionIndex] = useState(0);
  const [fileMentionListing, setFileMentionListing] =
    useState<FileMentionListing>({
      status: 'idle',
      rootPath: '',
      directory: '',
      entries: [],
    });
  const [slashCatalogEntries, setSlashCatalogEntries] = useState<
    SlashCatalogEntry[]
  >([]);
  const [modelStrategyOpen, setModelStrategyOpen] = useState(false);
  const [messageActionMenu, setMessageActionMenu] =
    useState<MessageActionMenu>(null);
  const blockedSendTipText =
    blockedSendTip === 'model-switched-while-chatting'
      ? t(locale, 'dock.modelSwitchBlockedTip')
      : '';

  useEffect(() => {
    if (!blockedSendTip) return;
    const id = window.setTimeout(() => clearBlockedSendTip(), 3200);
    return () => window.clearTimeout(id);
  }, [blockedSendTip, clearBlockedSendTip]);

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

  useEffect(
    () => subscribeShortcutSettings(setShortcutSettingsState),
    [],
  );

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
        .filter((message) => message.role === 'user')
        .map((message) => message.id),
    [messages],
  );
  const slashSuggestions = useMemo(
    () => buildSlashSuggestions(slashCatalogEntries, locale),
    [locale, slashCatalogEntries],
  );
  // Game-expert hierarchy entries (root → group → expert), surfaced in the `/`
  // menu only when experts are enabled. They route through the same explicit
  // parser; insertText carries the localized path so it round-trips.
  const gameExpertSuggestions = useMemo<SlashSuggestion[]>(
    () =>
      gameExpertMenuEntries(gameExpertSettings, locale).map((entry) => ({
        id: entry.id,
        kind: 'command' as const,
        name: entry.name,
        label: entry.name.slice(1),
        detail: entry.detail,
        insertText: entry.insertText,
        source: 'app',
        sourceAdapter: 'app' as const,
        searchText:
          `${entry.name} ${entry.detail} ${entry.insertText}`.toLowerCase(),
      })),
    [gameExpertSettings, locale],
  );
  const activeAdapterSlashSuggestions = useMemo(
    () => [
      ...scopeSlashSuggestionsForAdapter(slashSuggestions, selectedAdapter),
      ...gameExpertSuggestions,
    ],
    [gameExpertSuggestions, selectedAdapter, slashSuggestions],
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
  const slashOpen =
    !isReadOnly && slashTrigger !== null && filteredSlashSuggestions.length > 0;
  const fileMentionOpen = !isReadOnly && fileMentionTrigger !== null;
  useEffect(() => {
    if (activeFileMentionIndex < fileMentionOptions.length) return;
    setActiveFileMentionIndex(0);
  }, [activeFileMentionIndex, fileMentionOptions.length]);
  const firstUserMessageText = useMemo(
    () =>
      messages.find((message) => message.role === 'user' && message.text.trim())
        ?.text.trim() ?? '',
    [messages],
  );
  const reusableChatText = firstUserMessageText || firstStartUserInput;
  const useChatRunButton = isChat && simpleChatMode;
  const chatRunText =
    useChatRunButton && activeChatFavorite && reusableChatText
      ? reusableChatText
      : draft.trim();
  const chatRunActive = useChatRunButton && activeChatting;
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

  // One bottom "Channel" select owns the active runtime route. The default
  // group mirrors Settings -> Default Channels: each configured provider is a
  // real channel; system CLI entries are only fallbacks for empty categories.
  const [freeChannelRevision, setFreeChannelRevision] = useState(0);
  useEffect(() => {
    const refresh = () => setFreeChannelRevision((n) => n + 1);
    window.addEventListener('fuc:gateway-config-changed', refresh);
    return () => window.removeEventListener('fuc:gateway-config-changed', refresh);
  }, []);
  const [localRuntimeStatuses, setLocalRuntimeStatuses] = useState<
    Record<string, LocalModelRuntimeStatus | undefined>
  >({});
  const defaultChannelProviders = useMemo(
    () => {
      // Refresh after Settings edits/imports, because provider config is backed
      // by localStorage and surfaced through the gateway-config-changed event.
      void freeChannelRevision;
      const cliRuntime = getCliRuntimeSnapshot();
      const desktop = tauriAvailable();
      const sorted = listProviders()
        .map((provider) => {
          const adapter = providerKindToAdapter(provider.kind);
          const runtime = getProviderRuntimeInfo(provider, {
            canUseCliFallback:
              desktop && isCliAdapterAvailable(adapter, cliRuntime),
          });
          return { provider, adapter, status: runtime.status };
        })
        .sort((a, b) => {
          const adapterRank =
            RUNTIME_ADAPTERS.findIndex((item) => item.id === a.adapter) -
            RUNTIME_ADAPTERS.findIndex((item) => item.id === b.adapter);
          if (adapterRank !== 0) return adapterRank;
          const rankA = providerSortRank(a.status);
          const rankB = providerSortRank(b.status);
          if (rankA !== rankB) return rankA - rankB;
          return a.provider.name.localeCompare(b.provider.name);
        });
      // Collapse providers that render identically in the channel picker. Two
      // entries with the same adapter + name + baseUrl + model (e.g. a stale
      // `direct` copy left beside a cc-switch `cli` import) would otherwise show
      // up as duplicate "default" rows. Keep the first — the list is already
      // sorted best-status-first, so we drop the weaker duplicate.
      const seen = new Set<string>();
      return sorted.filter(({ provider, adapter }) => {
        const key = [
          adapter,
          provider.name.trim().toLowerCase(),
          provider.baseUrl.trim().replace(/\/+$/, '').toLowerCase(),
          (provider.model ?? '').trim().toLowerCase(),
        ].join('\0');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    },
    [freeChannelRevision],
  );
  // Image-generation settings power the bottom channel/model selectors while
  // the composer is in image mode. They live in their own store (separate from
  // the AI-editing runSelection), so flipping image mode never disturbs the
  // coding channel/model — leaving image mode just reads runSelection again.
  const [imageSettings, setImageSettings] = useState<ImageGenerationSettings>(
    () => loadImageGenerationSettings(),
  );
  useEffect(() => {
    const refresh = () => setImageSettings(loadImageGenerationSettings());
    window.addEventListener('fuc:image-generation-settings-changed', refresh);
    return () =>
      window.removeEventListener(
        'fuc:image-generation-settings-changed',
        refresh,
      );
  }, []);
  const imageChannelOptions = useMemo<SelectOption[]>(
    () =>
      IMAGE_PROVIDERS.map((provider) => ({
        id: provider.id,
        label:
          provider.label +
          (imageProviderReady(provider.id, imageSettings) ? '' : ' ⚠'),
        hint: t(
          locale,
          provider.category === 'commercial'
            ? 'settings.imageGeneration.categoryCommercial'
            : 'settings.imageGeneration.categoryFreeCredit',
        ),
        group: t(
          locale,
          provider.category === 'commercial'
            ? 'settings.imageGeneration.commercialProviders'
            : 'settings.imageGeneration.freeCreditProviders',
        ),
      })),
    [imageSettings, locale],
  );
  const imageChannelValue = imageSettings.preferredProviderId;
  const imageModelOptions = useMemo<SelectOption[]>(() => {
    const provider = IMAGE_PROVIDERS.find(
      (item) => item.id === imageSettings.preferredProviderId,
    );
    if (!provider) return [];
    const current = imageProviderModel(provider.id, imageSettings);
    return uniqueModelSelectOptions([current, ...provider.models]);
  }, [imageSettings]);
  const imageModelValue = imageProviderModel(
    imageSettings.preferredProviderId,
    imageSettings,
  );
  const onImageChannelChange = useCallback((id: string) => {
    saveImageGenerationSettings({
      ...loadImageGenerationSettings(),
      preferredProviderId: id as ImageProviderId,
    });
  }, []);
  const onImageModelChange = useCallback(
    (model: string) => {
      const selected = model.trim();
      if (!selected) return;
      const current = loadImageGenerationSettings();
      const providerId = current.preferredProviderId;
      saveImageGenerationSettings({
        ...current,
        providerModels: { ...current.providerModels, [providerId]: selected },
      });
    },
    [],
  );
  const [musicSettings, setMusicSettings] = useState<MusicGenerationSettings>(
    () => loadMusicGenerationSettings(),
  );
  useEffect(() => {
    const refresh = () => setMusicSettings(loadMusicGenerationSettings());
    window.addEventListener('fuc:music-generation-settings-changed', refresh);
    return () =>
      window.removeEventListener(
        'fuc:music-generation-settings-changed',
        refresh,
      );
  }, []);
  const musicChannelOptions = useMemo<SelectOption[]>(
    () =>
      MUSIC_PROVIDERS.map((provider) => ({
        id: provider.id,
        label:
          provider.label +
          (musicProviderReady(provider.id, musicSettings) ? '' : ' ⚠'),
        hint: t(
          locale,
          provider.category === 'commercial'
            ? 'settings.musicGeneration.categoryCommercial'
            : 'settings.musicGeneration.categoryFree',
        ),
        group: t(
          locale,
          provider.category === 'commercial'
            ? 'settings.musicGeneration.commercialProviders'
            : 'settings.musicGeneration.freeProviders',
        ),
      })),
    [musicSettings, locale],
  );
  const musicChannelValue = musicSettings.preferredProviderId;
  const musicModelOptions = useMemo<SelectOption[]>(() => {
    const provider = MUSIC_PROVIDERS.find(
      (item) => item.id === musicSettings.preferredProviderId,
    );
    if (!provider) return [];
    const current = musicProviderModel(provider.id, musicSettings);
    return uniqueModelSelectOptions([current, ...provider.models]);
  }, [musicSettings]);
  const musicModelValue = musicProviderModel(
    musicSettings.preferredProviderId,
    musicSettings,
  );
  const onMusicChannelChange = useCallback((id: string) => {
    saveMusicGenerationSettings({
      ...loadMusicGenerationSettings(),
      preferredProviderId: id as MusicProviderId,
    });
  }, []);
  const onMusicModelChange = useCallback(
    (model: string) => {
      const selected = model.trim();
      if (!selected) return;
      const current = loadMusicGenerationSettings();
      const providerId = current.preferredProviderId;
      saveMusicGenerationSettings({
        ...current,
        providerModels: { ...current.providerModels, [providerId]: selected },
      });
    },
    [],
  );
  const [threeDSettings, setThreeDSettings] = useState<ThreeDGenerationSettings>(
    () => loadThreeDGenerationSettings(),
  );
  useEffect(() => {
    const refresh = () => setThreeDSettings(loadThreeDGenerationSettings());
    window.addEventListener('fuc:three-d-generation-settings-changed', refresh);
    return () =>
      window.removeEventListener(
        'fuc:three-d-generation-settings-changed',
        refresh,
      );
  }, []);
  const threeDChannelOptions = useMemo<SelectOption[]>(
    () =>
      THREE_D_PROVIDERS.map((provider) => ({
        id: provider.id,
        label:
          provider.label +
          (threeDProviderReady(provider.id, threeDSettings) ? '' : ' ⚠'),
        hint: t(
          locale,
          provider.category === 'commercial'
            ? 'settings.threeDGeneration.categoryCommercial'
            : 'settings.threeDGeneration.categoryFree',
        ),
        group: t(
          locale,
          provider.category === 'commercial'
            ? 'settings.threeDGeneration.commercialProviders'
            : 'settings.threeDGeneration.freeProviders',
        ),
      })),
    [threeDSettings, locale],
  );
  const threeDChannelValue = threeDSettings.preferredProviderId;
  const threeDModelOptions = useMemo<SelectOption[]>(() => {
    const provider = THREE_D_PROVIDERS.find(
      (item) => item.id === threeDSettings.preferredProviderId,
    );
    if (!provider) return [];
    const current = threeDProviderModel(provider.id, threeDSettings);
    return uniqueModelSelectOptions([current, ...provider.models]);
  }, [threeDSettings]);
  const threeDModelValue = threeDProviderModel(
    threeDSettings.preferredProviderId,
    threeDSettings,
  );
  const onThreeDChannelChange = useCallback((id: string) => {
    saveThreeDGenerationSettings({
      ...loadThreeDGenerationSettings(),
      preferredProviderId: id as ThreeDProviderId,
    });
  }, []);
  const onThreeDModelChange = useCallback(
    (model: string) => {
      const selected = model.trim();
      if (!selected) return;
      const current = loadThreeDGenerationSettings();
      const providerId = current.preferredProviderId;
      saveThreeDGenerationSettings({
        ...current,
        providerModels: { ...current.providerModels, [providerId]: selected },
      });
    },
    [],
  );
  const channelSelectOptions = useMemo<SelectOption[]>(
    () => {
      const defaultOptions = RUNTIME_ADAPTERS.flatMap((adapter) => {
        const hint = defaultChannelRuntimeLabel(locale, adapter);
        const group = defaultChannelRuntimeGroup(locale, adapter);
        return [
          {
            id: systemDefaultOptionId(adapter.id),
            label: `${adapter.label} · ${t(locale, 'dock.channelSystemDefault')}`,
            hint,
            group,
          },
          ...defaultChannelProviders
            .filter((item) => item.adapter === adapter.id)
            .map(({ provider }) => ({
              id: defaultProviderOptionId(provider.id),
              label: provider.name.trim() || adapter.label,
              hint,
              group,
            })),
        ];
      });

      return [
        ...defaultOptions,
        ...FREE_CHANNELS.map((c) => {
          const localStatus = c.local ? localRuntimeStatuses[c.id] : undefined;
          const ready = freeChannelReady(c.id);
          const needsAttention =
            !ready ||
            (c.local && localStatus && !localStatus.ready);
          const hint = c.local
            ? localStatus?.ready
              ? t(locale, 'settings.freeChannels.localReady')
              : ready
                ? t(locale, 'settings.freeChannels.localConfigured')
                : t(locale, 'settings.freeChannels.localNeedsSetup')
            : ready
              ? t(locale, 'settings.freeChannels.ready')
              : t(locale, 'settings.freeChannels.needsKey');
          return {
            id: freeChannelOptionId(c.id),
            label: c.label + (needsAttention ? ' ⚠' : ''),
            hint,
            group: t(locale, 'dock.channelGroupFree'),
          };
        }),
      ];
    },
    [locale, defaultChannelProviders, localRuntimeStatuses],
  );
  const selectedFreeChannelId = isFreeChannelSelection(runSelection);
  const pinnedDefaultProvider = runSelection.providerId
    ? defaultChannelProviders.find(
        (item) =>
          item.provider.id === runSelection.providerId &&
          item.adapter === selectedAdapter,
      )
    : undefined;
  const channelSelectValue = selectedFreeChannelId
    ? freeChannelOptionId(selectedFreeChannelId)
    : pinnedDefaultProvider
      ? defaultProviderOptionId(pinnedDefaultProvider.provider.id)
      : systemDefaultOptionId(selectedAdapter);
  const selectedFreeChannel = selectedFreeChannelId
    ? freeChannelById(selectedFreeChannelId)
    : undefined;
  const selectedDefaultProvider = selectedFreeChannel
    ? undefined
    : pinnedDefaultProvider;
  const [modelListRevision, setModelListRevision] = useState(0);
  const [loadingChannelModels, setLoadingChannelModels] = useState(false);
  useEffect(() => {
    const refresh = () => setModelListRevision((n) => n + 1);
    window.addEventListener('fuc:model-list-changed', refresh);
    return () => window.removeEventListener('fuc:model-list-changed', refresh);
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
      id: 'default',
      label: t(locale, 'dock.channelSystemDefault'),
    };
    if (selectedFreeChannel) {
      const options = uniqueModelSelectOptions(
        [runSelection.modelOverride, ...freeChannelModelOptions(selectedFreeChannel)],
      );
      return options.length > 0 ? options : [defaultModelOption];
    }
    if (selectedDefaultProvider) {
      const provider = selectedDefaultProvider.provider;
      const fallback =
        selectedDefaultProvider.adapter === 'claude-code'
          ? [
              runSelection.modelClass,
              ...composerModelOptions.map((option) => option.id),
              'sonnet',
              'opus',
              'haiku',
            ]
          : ['default', runSelection.modelClass];
      return uniqueModelSelectOptions([
        provider.model ?? '',
        ...providerModelOptions(provider),
        ...fallback,
      ]);
    }
    if (selectedAdapter === 'claude-code') {
      return uniqueModelSelectOptions([
        runSelection.modelClass,
        ...composerModelOptions.map((option) => option.id),
        'sonnet',
        'opus',
        'haiku',
      ]);
    }
    return uniqueModelSelectOptions(['default', runSelection.modelClass]);
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
      : runSelection.modelOverride ??
        (runSelection.modelClass === 'default'
          ? 'default'
          : getFreeChannelModel(selectedFreeChannel.id) || 'default')
    : selectedDefaultProvider
      ? runSelection.modelOverride ??
        (runSelection.modelClass === 'default'
          ? 'default'
          : (selectedDefaultProvider.provider.model ?? '').trim() ||
            runSelection.modelClass ||
            'default')
      : runSelection.modelClass || 'default';
  const [keyModalChannel, setKeyModalChannel] = useState<FreeChannel | null>(null);
  const [keyModalValue, setKeyModalValue] = useState('');
  const [localSetupChannel, setLocalSetupChannel] =
    useState<FreeChannel | null>(null);
  const [localModelValue, setLocalModelValue] = useState('');
  const [localSetupMessage, setLocalSetupMessage] = useState<string | null>(null);
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
          return [channel.id, await localModelStatus(channel.id, model)] as const;
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
      setKeyModalValue('');
      setLocalSetupChannel(null);
      setLocalModelValue('');
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
                state: 'service_unavailable',
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
          setKeyModalValue('');
          return;
        }
        selectFreeChannel(channel);
      })();
    },
    [defaultChannelProviders, locale, setSessionRunSelection, selectFreeChannel],
  );
  const onModelChange = useCallback(
    (model: string) => {
      const selectedModel = model.trim();
      if (!selectedModel) return;
      const modelOverride =
        selectedModel === 'default' ? undefined : selectedModel;
      if (selectedFreeChannel) {
        void ensureFreeProxy();
        if (selectedFreeChannel.id === FREE_CHANNEL_AUTO_ID) {
          const autoModel =
            selectedModel === 'default' ? FREE_CHANNEL_AUTO_MODEL : selectedModel;
          const modelOverride =
            autoModel === FREE_CHANNEL_AUTO_MODEL ? undefined : autoModel;
          setSessionRunSelection(
            {
              ...freeChannelSelection(selectedFreeChannel.id, autoModel),
              ...(modelOverride ? { modelOverride } : {}),
            },
          );
          return;
        }
        setSessionRunSelection(
          {
            ...freeChannelSelection(selectedFreeChannel.id, selectedModel),
            ...(modelOverride ? { modelOverride } : {}),
          },
        );
        return;
      }
      if (selectedDefaultProvider) {
        const provider = selectedDefaultProvider.provider;
        setSessionRunSelection(
          {
            ...providerSelection(provider, selectedModel),
            ...(modelOverride ? { modelOverride } : {}),
          },
        );
        return;
      }
      setSessionRunSelection(
        {
          ...systemDefaultGatewaySelection(selectedAdapter),
          modelClass: selectedModel === 'default' ? 'default' : selectedModel,
        },
      );
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
          state: 'service_unavailable',
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

  const ensureSelectedLocalChannelReady = useCallback(async (): Promise<boolean> => {
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
        state: 'service_unavailable',
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
  useEffect(() => {
    if (!fileMentionTrigger || isReadOnly) return;

    const rootPath = workspaceCwd.trim();
    const directory = fileMentionTrigger.directory;
    if (!rootPath) {
      setFileMentionListing({
        status: 'error',
        rootPath: '',
        directory,
        entries: [],
        message: '请先选择工作区。',
      });
      return;
    }

    let cancelled = false;
    setFileMentionListing((current) => ({
      status: 'loading',
      rootPath,
      directory,
      entries:
        current.rootPath === rootPath && current.directory === directory
          ? current.entries
          : [],
    }));

    void listWorkspaceDirectory(rootPath, directory)
      .then((listing) => {
        if (cancelled) return;
        setFileMentionListing({
          status: 'ready',
          rootPath: listing.rootPath,
          directory: listing.relativePath,
          entries: listing.entries,
        });
        setActiveFileMentionIndex(0);
      })
      .catch((err) => {
        if (cancelled) return;
        setFileMentionListing({
          status: 'error',
          rootPath,
          directory,
          entries: [],
          message: fileMentionErrorMessage(err),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [fileMentionTrigger?.directory, isReadOnly, workspaceCwd]);

  const onOpenFile = useCallback(
    (ref: FileRef, intent?: OpenFileIntent) => {
      if (intent?.reveal) {
        void openLocalPath(ref.path, {
          cwd: workspaceCwd || undefined,
          reveal: true,
        });
        return;
      }
      setFilePreviewRef(ref);
    },
    [workspaceCwd],
  );

  // Heuristic "live bubble": the last assistant message is streaming while the
  // AI is editing or a run is in flight. Drives streaming-safe markdown repair
  // and in-progress reasoning rendering.
  const lastAssistantId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') return messages[i].id;
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
    for (let i = Math.max(0, messages.length - EAGER_MESSAGE_TAIL); i < messages.length; i++) {
      ids.add(messages[i].id);
    }
    return ids;
  }, [messages]);
  const aiBusy = mode === 'running' || activeAiEditing || activeChatting;

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
  const dockRef = useRef<HTMLDivElement>(null);

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
    setReturnSearch('');
    setActiveSearchMatchIndex(0);
    activeSearchMatchNodeRef.current = null;
  }, []);

  const clearReturnSearch = useCallback(() => {
    setReturnSearch('');
    setActiveSearchMatchIndex(0);
    if (returnSearchOpen) focusSearchInput();
  }, [focusSearchInput, returnSearchOpen]);

  const moveSearchMatch = useCallback(
    (step: number) => {
      if (searchMatches.length === 0) return;
      setActiveSearchMatchIndex((current) => {
        const next = (current + step + searchMatches.length) % searchMatches.length;
        return next;
      });
    },
    [searchMatches.length],
  );

  const scrollToStreamEdge = useCallback((edge: 'top' | 'bottom') => {
    const stream = streamRef.current;
    if (!stream) return;
    if (edge === 'bottom') stickToBottomRef.current = true;
    stream.scrollTo({
      top: edge === 'top' ? 0 : stream.scrollHeight,
      behavior: 'smooth',
    });
  }, []);

  // Re-pin the active stream to the bottom. Called when the user sends a
  // message so the new entry is guaranteed to scroll into view, even if the
  // stored snapshot recorded a non-bottom position (line auto-scroll prefers
  // the snapshot's atBottom over stickToBottomRef, so we must clear it too).
  const pinActiveStreamToBottom = useCallback(() => {
    stickToBottomRef.current = true;
    const key = activeStreamScrollKeyRef.current;
    const snapshot = streamScrollSnapshotsRef.current.get(key);
    if (snapshot) {
      streamScrollSnapshotsRef.current.set(key, {
        ...snapshot,
        atBottom: true,
        anchorMessageId: null,
      });
    }
    const stream = streamRef.current;
    if (stream) scrollStreamToBottom(stream);
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

  const restoreStreamScrollSnapshotForKey = useCallback((key: string): boolean => {
    const stream = streamRef.current;
    if (!stream) return false;
    const snapshot = streamScrollSnapshotsRef.current.get(key);
    stickToBottomRef.current = snapshot?.atBottom ?? true;
    return restoreStreamScrollSnapshot(stream, messageRefs.current, snapshot);
  }, []);

  // Track whether the user is parked at (or near) the bottom. Manual upward
  // scroll pins this session to the visible message anchor; bottom stays sticky
  // and follows new streamed content.
  const handleStreamScroll = useCallback(() => {
    rememberStreamScrollSnapshot();
  }, [rememberStreamScrollSnapshot]);

  const scrollToTopic = useCallback(
    (direction: -1 | 1) => {
      const stream = streamRef.current;
      if (!stream || topicMessageIds.length === 0) return;

      const streamRect = stream.getBoundingClientRect();
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
      if (topics.length === 0) return;

      const threshold = 4;
      const currentTop = stream.scrollTop;
      const target =
        direction > 0
          ? topics.find((topic) => topic.top > currentTop + threshold)
          : [...topics]
              .reverse()
              .find((topic) => topic.top < currentTop - threshold);

      if (!target) return;
      messageRefs.current
        .get(target.id)
        ?.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'smooth' });
    },
    [topicMessageIds],
  );

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

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

  const closeFileMentionSuggestions = useCallback(() => {
    fileMentionTriggerRef.current = null;
    setFileMentionTrigger(null);
    setActiveFileMentionIndex(0);
  }, []);

  const closeComposerSuggestions = useCallback(() => {
    closeSlashSuggestions();
    closeFileMentionSuggestions();
  }, [closeFileMentionSuggestions, closeSlashSuggestions]);

  const syncSlashTrigger = useCallback(
    (target: HTMLTextAreaElement | null = inputRef.current) => {
      if (!target || isReadOnly || target.selectionStart !== target.selectionEnd) {
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

  const syncFileMentionTrigger = useCallback(
    (target: HTMLTextAreaElement | null = inputRef.current) => {
      if (!target || isReadOnly || target.selectionStart !== target.selectionEnd) {
        closeFileMentionSuggestions();
        return;
      }

      const next = findFileMentionTrigger(target.value, target.selectionStart);
      const prev = fileMentionTriggerRef.current;
      const unchanged =
        prev?.start === next?.start &&
        prev?.end === next?.end &&
        prev?.directory === next?.directory &&
        prev?.query === next?.query;
      if (unchanged) return;

      fileMentionTriggerRef.current = next;
      setFileMentionTrigger(next);
      setActiveFileMentionIndex(0);
    },
    [closeFileMentionSuggestions, isReadOnly],
  );

  const syncComposerSuggestions = useCallback(
    (target: HTMLTextAreaElement | null = inputRef.current) => {
      syncSlashTrigger(target);
      syncFileMentionTrigger(target);
    },
    [syncFileMentionTrigger, syncSlashTrigger],
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
      const spacer = after.length > 0 && /^\s/.test(after) ? '' : ' ';
      const inserted = `${suggestion.name}${spacer}`;
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

  const applyFileMentionOption = useCallback(
    (entry: WorkspaceTreeEntry) => {
      if (isReadOnly) return;

      const trigger = fileMentionTriggerRef.current;
      if (!trigger) return;

      const current = draftRef.current;
      const start = clampSelection(trigger.start, current.length);
      const end = clampSelection(trigger.end, current.length);
      const after = current.slice(end);
      const baseInserted = fileMentionInsertText(entry);
      const spacer =
        entry.kind === 'file' && (after.length === 0 || !/^\s/.test(after))
          ? ' '
          : '';
      const inserted = `${baseInserted}${spacer}`;
      const next = current.slice(0, start) + inserted + after;
      const caret = start + inserted.length;

      draftRef.current = next;
      selectionRef.current = { start: caret, end: caret };
      setComposerDraft(next);

      if (entry.kind === 'directory') {
        const nextTrigger = findFileMentionTrigger(next, caret);
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

  const startFileMention = useCallback(() => {
    if (isReadOnly) return;
    const current = draftRef.current;
    const start = clampSelection(selectionRef.current.start, current.length);
    const prefix = start > 0 && !/\s/.test(current[start - 1] ?? '') ? ' ' : '';
    insertComposerText(`${prefix}@`);
    window.requestAnimationFrame(() => syncComposerSuggestions(inputRef.current));
  }, [insertComposerText, isReadOnly, syncComposerSuggestions]);

  const startSlashCommand = useCallback(() => {
    if (isReadOnly) return;
    const current = draftRef.current;
    const start = clampSelection(selectionRef.current.start, current.length);
    const prefix = start > 0 && !/\s/.test(current[start - 1] ?? '') ? ' ' : '';
    const triggerStart = start + prefix.length;
    const nextTrigger: SlashTrigger = {
      start: triggerStart,
      end: triggerStart + 1,
      query: '',
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

  const handlePaste = useCallback(
    (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
      if (isReadOnly || !tauriAvailable()) return;

      const images = clipboardImageFiles(event.clipboardData);
      if (images.length === 0) return;

      event.preventDefault();
      const selection = {
        start: event.currentTarget.selectionStart,
        end: event.currentTarget.selectionEnd,
      };
      selectionRef.current = selection;

      void Promise.allSettled(
        images.map((file) => savePastedImageFile(file, workspaceCwd)),
      ).then((results) => {
        const paths = results
          .filter(
            (result): result is PromiseFulfilledResult<string> =>
              result.status === 'fulfilled',
          )
          .map((result) => result.value);
        if (paths.length === 0) return;
        closeComposerSuggestions();
        insertFilePaths(paths, selection);
      });
    },
    [closeComposerSuggestions, insertFilePaths, isReadOnly, workspaceCwd],
  );

  const handleComposerDragOver = useCallback(
    (event: ReactDragEvent<HTMLElement>) => {
      const hasProjectPaths = hasProjectFileDragData(event.dataTransfer);
      const hasFiles = Array.from(event.dataTransfer?.types ?? []).includes(
        'Files',
      );
      // Project-tree drags use HTML5 DnD. Browser/no-native builds can also
      // expose external files here, though those may only carry File.name.
      // Desktop full paths come from the Tauri native drag handler below.
      if (isReadOnly || (!hasProjectPaths && !hasFiles)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
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
      const projectPaths = projectFilePathsFromDataTransfer(event.dataTransfer);
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
      insertFilePaths(pathsFromDataTransfer(event.dataTransfer), targetSelection);
    },
    [closeComposerSuggestions, insertFilePaths, isReadOnly],
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
    const total = Math.max(0, dockRef.current?.clientWidth ?? window.innerWidth);
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
    if (returnSearchOpen) focusSearchInput();
  }, [focusSearchInput, returnSearchOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (keyModalChannel || localSetupChannel) return;
      if (matchesShortcut(event, shortcutSettings['return-search'])) {
        event.preventDefault();
        openReturnSearch();
        return;
      }
      if (event.key === 'Escape' && returnSearchOpen) {
        event.preventDefault();
        closeReturnSearch();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
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
        stream.scrollTop = top;
        searchScrollTopRef.current = null;
      });
    }
  }, [normalizedSearch]);

  // Session/workspace switches restore that conversation's own scroll state:
  // bottom remains sticky, while a manual non-bottom position is restored by
  // visible-message anchor so new streamed content below does not move the
  // user's reading position.
  useLayoutEffect(() => {
    pendingStreamScrollRestoreKeyRef.current = activeStreamScrollKey;
  }, [activeStreamScrollKey]);

  useLayoutEffect(() => {
    if (pendingStreamScrollRestoreKeyRef.current !== activeStreamScrollKey) return;
    if (restoreStreamScrollSnapshotForKey(activeStreamScrollKey)) {
      pendingStreamScrollRestoreKeyRef.current = null;
    }
  }, [
    activeStreamScrollKey,
    messages.length,
    restoreStreamScrollSnapshotForKey,
  ]);

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
      const key = activeStreamScrollKeyRef.current;
      const snapshot = streamScrollSnapshotsRef.current.get(key);
      if (snapshot?.atBottom ?? stickToBottomRef.current) {
        scrollStreamToBottom(el);
      } else if (snapshot) {
        restoreStreamScrollSnapshot(el, messageRefs.current, snapshot);
      }
      rememberStreamScrollSnapshot(key);
    };
    if (typeof ResizeObserver === 'undefined') {
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
  }, [rememberStreamScrollSnapshot, messages.length]);

  useEffect(() => {
    if (!normalizedSearch || !activeSearchMatchId || !activeSearchMatchMessageId) {
      return;
    }
    const target =
      activeSearchMatchSource === 'text'
        ? activeSearchMatchNodeRef.current
        : null;
    const messageEl = messageRefs.current.get(activeSearchMatchMessageId);
    const scrollTarget =
      target && target.dataset.searchMatchId === activeSearchMatchId
        ? target
        : messageEl;
    scrollTarget?.scrollIntoView?.({ block: 'center', inline: 'nearest' });
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
    if (!(el instanceof HTMLTextAreaElement) || !shouldRefocusComposerAfterAppend(mode)) return;
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
      const { getCurrentWebview } = await import('@tauri-apps/api/webview');
      const dispose = await getCurrentWebview().onDragDropEvent((event) => {
        if (disposed) return;
        const payload = event.payload;
        const el = inputDropRef.current ?? inputRef.current;

        if (payload.type === 'leave') {
          setDropActive(false);
          return;
        }
        if (!el || isReadOnly) {
          setDropActive(false);
          return;
        }
        if (payload.type === 'enter') {
          setDropActive(pointInsideElement(payload.position, el));
          return;
        }
        if (payload.type === 'over') {
          setDropActive(pointInsideElement(payload.position, el));
          return;
        }
        if (payload.type === 'drop') {
          const inside = pointInsideElement(payload.position, el);
          setDropActive(false);
          if (inside) insertFilePaths(payload.paths);
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
  }, [insertFilePaths, isReadOnly]);

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
      event.dataTransfer.dropEffect = 'copy';
      applyProjectFileDragDropEffect(event.dataTransfer);
    };

    window.addEventListener(
      PROJECT_FILE_DRAG_MOVE_EVENT,
      onProjectFileDragMove,
    );
    window.addEventListener('dragenter', onProjectFileDragOver, true);
    window.addEventListener('dragover', onProjectFileDragOver, true);
    return () => {
      window.removeEventListener(
        PROJECT_FILE_DRAG_MOVE_EVENT,
        onProjectFileDragMove,
      );
      window.removeEventListener('dragenter', onProjectFileDragOver, true);
      window.removeEventListener('dragover', onProjectFileDragOver, true);
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
      insertFilePaths(detail.paths);
    };

    window.addEventListener(PROJECT_FILE_DRAG_END_EVENT, onProjectFileDragEnd);
    return () => {
      window.removeEventListener(
        PROJECT_FILE_DRAG_END_EVENT,
        onProjectFileDragEnd,
      );
    };
  }, [closeComposerSuggestions, insertFilePaths, isReadOnly]);

  // Re-clamp the input width when the window (and thus the dock) resizes so
  // neither pane collapses below its minimum.
  useLayoutEffect(() => {
    const onResize = () => setRenderedInputWidth(clampInputWidth(inputWidth));
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [clampInputWidth, inputWidth]);

  // Drag the top edge to resize. The panel is anchored to the bottom, so
  // dragging up (smaller clientY) increases height.
  const onResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startY = e.clientY;
      const startHeight = height;
      const prevUserSelect = document.body.style.userSelect;
      const prevCursor = document.body.style.cursor;
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'row-resize';

      const onMove = (ev: MouseEvent) => {
        setHeight(clampHeight(startHeight - (ev.clientY - startY)));
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        document.body.style.userSelect = prevUserSelect;
        document.body.style.cursor = prevCursor;
        setHeight((h) => {
          saveDockHeight(h);
          return h;
        });
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
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
      const prevUserSelect = document.body.style.userSelect;
      const prevCursor = document.body.style.cursor;
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'col-resize';

      const onMove = (ev: MouseEvent) => {
        const next = clampInputWidth(startWidth - (ev.clientX - startX));
        setInputWidth(next);
        setRenderedInputWidth(next);
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        document.body.style.userSelect = prevUserSelect;
        document.body.style.cursor = prevCursor;
        setInputWidth((w) => {
          savePaneWidth(INPUT_WIDTH_KEY, w);
          return w;
        });
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
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
      const startHeight = chatInputHeight;
      const prevUserSelect = document.body.style.userSelect;
      const prevCursor = document.body.style.cursor;
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'row-resize';

      const onMove = (ev: MouseEvent) => {
        setChatInputHeight(clampChatInputHeight(startHeight - (ev.clientY - startY)));
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        document.body.style.userSelect = prevUserSelect;
        document.body.style.cursor = prevCursor;
        setChatInputHeight((h) => {
          savePaneWidth(CHAT_INPUT_HEIGHT_KEY, h);
          return h;
        });
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [chatInputHeight],
  );

  // Capture the whole conversation as a long screenshot. Forces every message
  // to its rich renderer first (so off-screen placeholders don't leak into the
  // image), waits two frames + a short settle for markdown/highlight/katex to
  // paint, then rasterizes the full scroll box (auto-paged when very long).
  const runSessionScreenshot = useCallback(async () => {
    const zh = locale === 'zh-CN';
    if (captureInFlightRef.current) return;
    // Echo the command so the action is visible in the transcript even if the
    // capture itself no-ops or fails.
    appendChatNote('/screenshot', 'user');
    const el = streamRef.current;
    if (!el) {
      appendChatNote(
        zh ? '✗ 截图失败：找不到会话视图。' : '✗ Screenshot failed: conversation view not found.',
      );
      return;
    }
    if (messages.length === 0) {
      appendChatNote(zh ? '当前会话为空，没有可截图的内容。' : 'Conversation is empty — nothing to capture.');
      return;
    }
    captureInFlightRef.current = true;
    setForceEagerCapture(true);
    setCaptureStatus({
      kind: 'busy',
      text: zh ? '正在生成长截图…' : 'Capturing…',
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
      });
      const preview = result.previewDataUrl
        ? `\n\n![${zh ? '截图预览' : 'screenshot preview'}](${result.previewDataUrl})`
        : '';
      let note: string;
      let status: string;
      if (result.destination === 'browser-download') {
        status = zh ? `已下载长截图（${result.pages} 张）` : `Downloaded ${result.pages} image(s)`;
        note =
          (zh
            ? `✓ 已截图当前会话（${result.pages} 张），已通过浏览器下载到默认下载目录。`
            : `✓ Captured this conversation (${result.pages} image(s)) — downloaded via your browser.`) +
          preview;
      } else {
        const paths = result.paths.length > 0
          ? result.paths
          : result.destination.split('\n').filter(Boolean);
        status = result.stitched
          ? zh
            ? `已保存 ${result.pages} 张拼接长图`
            : `Saved ${result.pages} stitched pages`
          : zh
            ? '已保存长截图'
            : 'Screenshot saved';
        const pathLines = paths.map((p) => `- \`${p}\``).join('\n');
        note =
          (zh
            ? `✓ 已截图当前会话${result.stitched ? `（${result.pages} 张拼接长图）` : ''}，保存到（点击路径可预览）：\n${pathLines}`
            : `✓ Captured this conversation${result.stitched ? ` (${result.pages} stitched pages)` : ''}, saved to (click a path to preview):\n${pathLines}`) +
          preview;
      }
      appendChatNote(note);
      setCaptureStatus({ kind: 'done', text: status });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setCaptureStatus({ kind: 'error', text: (zh ? '截图失败：' : 'Capture failed: ') + msg });
      appendChatNote((zh ? '✗ 截图失败：' : '✗ Screenshot failed: ') + msg);
    } finally {
      setForceEagerCapture(false);
      captureInFlightRef.current = false;
    }
  }, [messages.length, locale, appendChatNote, workspaceCwd]);

  // Record the whole conversation as a top-to-bottom scrolling GIF. Shares the
  // same eager-render + settle machinery as the static screenshot, then hands
  // the expanded stream to the GIF recorder (renders once, scrolls in frames).
  const runSessionGif = useCallback(async () => {
    const zh = locale === 'zh-CN';
    if (captureInFlightRef.current) return;
    appendChatNote('/screenshot-gif', 'user');
    const el = streamRef.current;
    if (!el) {
      appendChatNote(
        zh ? '✗ GIF 录制失败：找不到会话视图。' : '✗ GIF recording failed: conversation view not found.',
      );
      return;
    }
    if (messages.length === 0) {
      appendChatNote(zh ? '当前会话为空，没有可录制的内容。' : 'Conversation is empty — nothing to record.');
      return;
    }
    captureInFlightRef.current = true;
    setForceEagerCapture(true);
    setCaptureStatus({
      kind: 'busy',
      text: zh ? '正在录制 GIF…' : 'Recording GIF…',
    });
    const nextFrame = () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    try {
      await nextFrame();
      await nextFrame();
      await new Promise((resolve) => setTimeout(resolve, 350));
      const result = await recordConversationGif(el, {
        cwd: workspaceCwd || undefined,
      });
      const preview = result.previewDataUrl
        ? `\n\n![${zh ? 'GIF 预览' : 'GIF preview'}](${result.previewDataUrl})`
        : '';
      let note: string;
      let status: string;
      if (result.destination === 'browser-download') {
        status = zh ? `已下载 GIF（${result.frames} 帧）` : `Downloaded GIF (${result.frames} frames)`;
        note =
          (zh
            ? `✓ 已把当前会话录成滚动 GIF（${result.frames} 帧），已通过浏览器下载到默认下载目录。`
            : `✓ Recorded this conversation as a scrolling GIF (${result.frames} frames) — downloaded via your browser.`) +
          preview;
      } else {
        const paths = result.paths.length > 0
          ? result.paths
          : [result.destination].filter(Boolean);
        const pathLines = paths.map((p) => `- \`${p}\``).join('\n');
        status = zh ? `已保存 GIF（${result.frames} 帧）` : `Saved GIF (${result.frames} frames)`;
        note =
          (zh
            ? `✓ 已把当前会话录成滚动 GIF（${result.frames} 帧），保存到（点击路径可预览）：\n${pathLines}`
            : `✓ Recorded this conversation as a scrolling GIF (${result.frames} frames), saved to (click the path to preview):\n${pathLines}`) +
          preview;
      }
      appendChatNote(note);
      setCaptureStatus({ kind: 'done', text: status });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setCaptureStatus({ kind: 'error', text: (zh ? 'GIF 录制失败：' : 'GIF recording failed: ') + msg });
      appendChatNote((zh ? '✗ GIF 录制失败：' : '✗ GIF recording failed: ') + msg);
    } finally {
      setForceEagerCapture(false);
      captureInFlightRef.current = false;
    }
  }, [messages.length, locale, appendChatNote, workspaceCwd]);

  // Auto-dismiss the screenshot status banner once it settles (keep the
  // "busy" state until capture finishes).
  useEffect(() => {
    if (!captureStatus || captureStatus.kind === 'busy') return;
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
    // The user is sending something — always follow the new content to the
    // bottom regardless of where they had scrolled. The actual scroll happens
    // once the message renders (ResizeObserver-driven sync), but we pin intent
    // here so a stale non-bottom snapshot can't suppress it.
    pinActiveStreamToBottom();
    const clearDraftIfNeeded = () => {
      if (overrideText === undefined || options.clearDraft) {
        setComposerDraft('');
        draftRef.current = '';
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
    // Sticky image mode toggles. The command enters/leaves image mode; the input
    // background + placeholder reflect the mode. Any text typed after the command
    // on the same line is treated as a first image prompt (so picking the command
    // from the suggestion menu and typing right after it still works).
    const imageModeStart = /^\/image-mode-start(?:\s+([\s\S]*))?$/i.exec(text);
    if (imageModeStart) {
      const wasImageMode = composer.imageMode;
      const startedAt = wasImageMode
        ? composer.imageModeStartedAt ?? Date.now()
        : Date.now();
      setComposer({
        imageMode: true,
        imageModeStartedAt: startedAt,
        musicMode: false,
        musicModeStartedAt: null,
        threeDMode: false,
        threeDModeStartedAt: null,
      });
      clearDraftIfNeeded();
      if (!wasImageMode) {
        appendChatNote(t(locale, 'dock.imageModeEntered'), 'system');
      }
      const prompt = (imageModeStart[1] ?? '').trim();
      if (prompt) generateImagePrompt(prompt);
      return;
    }
    const imageModeEnd = /^\/image-mode-end(?:\s+([\s\S]*))?$/i.exec(text);
    if (imageModeEnd) {
      const wasImageMode = composer.imageMode;
      setComposer({ imageMode: false, imageModeStartedAt: null });
      clearDraftIfNeeded();
      if (wasImageMode) {
        appendChatNote(t(locale, 'dock.imageModeExited'), 'system');
      }
      return;
    }
    const musicModeStart = /^\/music-mode-start(?:\s+([\s\S]*))?$/i.exec(text);
    if (musicModeStart) {
      const wasMusicMode = composer.musicMode;
      const startedAt = wasMusicMode
        ? composer.musicModeStartedAt ?? Date.now()
        : Date.now();
      setComposer({
        imageMode: false,
        imageModeStartedAt: null,
        musicMode: true,
        musicModeStartedAt: startedAt,
        threeDMode: false,
        threeDModeStartedAt: null,
      });
      clearDraftIfNeeded();
      if (!wasMusicMode) {
        appendChatNote(t(locale, 'dock.musicModeEntered'), 'system');
      }
      const prompt = (musicModeStart[1] ?? '').trim();
      if (prompt) generateMusicPrompt(prompt);
      return;
    }
    const musicModeEnd = /^\/music-mode-end(?:\s+([\s\S]*))?$/i.exec(text);
    if (musicModeEnd) {
      const wasMusicMode = composer.musicMode;
      setComposer({ musicMode: false, musicModeStartedAt: null });
      clearDraftIfNeeded();
      if (wasMusicMode) {
        appendChatNote(t(locale, 'dock.musicModeExited'), 'system');
      }
      return;
    }
    const musicMatch = /^\/(?:music|song|audio|compose|作曲|音乐|生成音乐)(?:\s+([\s\S]*))?$/iu.exec(text);
    if (musicMatch) {
      const prompt = (musicMatch[1] ?? '').trim();
      if (!prompt) return;
      generateMusicPrompt(text);
      clearDraftIfNeeded();
      return;
    }
    const threeDModeStart = /^\/mesh-mode-start(?:\s+([\s\S]*))?$/i.exec(text);
    if (threeDModeStart) {
      const wasThreeDMode = composer.threeDMode;
      const startedAt = wasThreeDMode
        ? composer.threeDModeStartedAt ?? Date.now()
        : Date.now();
      setComposer({
        imageMode: false,
        imageModeStartedAt: null,
        musicMode: false,
        musicModeStartedAt: null,
        threeDMode: true,
        threeDModeStartedAt: startedAt,
      });
      clearDraftIfNeeded();
      if (!wasThreeDMode) {
        appendChatNote(t(locale, 'dock.threeDModeEntered'), 'system');
      }
      const prompt = (threeDModeStart[1] ?? '').trim();
      if (prompt) generateThreeDPrompt(prompt);
      return;
    }
    const threeDModeEnd = /^\/mesh-mode-end(?:\s+([\s\S]*))?$/i.exec(text);
    if (threeDModeEnd) {
      const wasThreeDMode = composer.threeDMode;
      setComposer({ threeDMode: false, threeDModeStartedAt: null });
      clearDraftIfNeeded();
      if (wasThreeDMode) {
        appendChatNote(t(locale, 'dock.threeDModeExited'), 'system');
      }
      return;
    }
    const threeDMatch = /^\/(?:3d|3d-model|model3d|three-d|三维|3d模型|生成3d)(?:\s+([\s\S]*))?$/iu.exec(text);
    if (threeDMatch) {
      const prompt = (threeDMatch[1] ?? '').trim();
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
      const query = (meshSearchMatch[1] ?? '').trim();
      if (!query) return;
      searchMeshLibraryPrompt(text);
      clearDraftIfNeeded();
      return;
    }
    const deepResearchMatch = /^\/deep-research(?:\s+([\s\S]*))?$/i.exec(text);
    if (deepResearchMatch) {
      const question = (deepResearchMatch[1] ?? '').trim();
      if (!question || activeChatting) return;
      const instruction =
        slashText(
          SLASH_COMMANDS.find((command) => command.name === '/deep-research')?.text ?? {},
          locale,
        ) || 'Run deep research with source ledger, claim audit, citations, and gaps.';
      runUltracodePrompt(`${instruction}\n\n研究问题：\n${question}`);
      if (overrideText === undefined || options.clearDraft) {
        setComposerDraft('');
        draftRef.current = '';
        selectionRef.current = { start: 0, end: 0 };
      }
      return;
    }
    const ultracodeMatch = /^\/ultracode(?:\s+([\s\S]*))?$/i.exec(text);
    if (ultracodeMatch) {
      const task = (ultracodeMatch[1] ?? '').trim();
      if (!task || activeChatting) return;
      runUltracodePrompt(task);
      if (overrideText === undefined || options.clearDraft) {
        setComposerDraft('');
        draftRef.current = '';
        selectionRef.current = { start: 0, end: 0 };
      }
      return;
    }
    // Sticky image mode: bare text (no slash command matched above) generates an
    // image instead of editing the workflow. Slash commands still win so the user
    // can drop a /ultracode or /plan without leaving image mode.
    if (composer.imageMode && !text.startsWith('/')) {
      generateImagePrompt(text);
      clearDraftIfNeeded();
      return;
    }
    if (composer.musicMode && !text.startsWith('/')) {
      generateMusicPrompt(text);
      clearDraftIfNeeded();
      return;
    }
    if (composer.threeDMode && !text.startsWith('/')) {
      generateThreeDPrompt(text);
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
        sendPrompt(task, {
          forceGameExperts: true,
          ...(expertIds.length > 0 ? { gameExpertIds: expertIds } : {}),
        });
        clearDraftIfNeeded();
      })();
      return;
    }
    const promptText = expandSlashRequest(text, activeAdapterSlashSuggestions);
    void (async () => {
      if (!(await ensureSelectedLocalChannelReady())) return;
      sendPrompt(promptText);
      if (overrideText === undefined || options.clearDraft) {
        setComposerDraft('');
        draftRef.current = '';
        selectionRef.current = { start: 0, end: 0 };
      }
    })();
  };

  const addFiles = async () => {
    if (isReadOnly) return;
    rememberSelection();
    const paths = await pickComposerFiles(t(locale, 'dock.addFileDialogTitle'));
    if (paths?.length) insertFilePaths(paths);
  };

  const searchStatus = normalizedSearch
    ? searchMatches.length === 0
      ? t(locale, 'dock.searchNoMatch')
      : `${activeSearchMatchIndex + 1}/${searchMatches.length}`
    : '';
  const searchToggleButton = (
    <button
      type="button"
      onClick={() => {
        if (returnSearchOpen) closeReturnSearch();
        else openReturnSearch();
      }}
      title={t(locale, 'dock.searchAria')}
      aria-label={t(locale, 'dock.searchAria')}
      aria-expanded={returnSearchOpen}
      aria-controls="ai-return-search"
      className={
        'flex h-7 w-7 shrink-0 items-center justify-center rounded-md border transition-colors ' +
        (returnSearchOpen
          ? 'border-accent bg-accent/10 text-accent'
          : 'border-border bg-panel-2 text-fg-dim hover:border-accent hover:text-fg')
      }
    >
      <Search size={14} />
    </button>
  );
  const streamNavButtonClass =
    'fuc-stream-nav-button flex h-7 w-7 items-center justify-center rounded-md text-fg-dim transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-35';
  const composerToolButtonClass =
    'flex h-7 shrink-0 items-center justify-center rounded-md border border-transparent bg-transparent px-2 text-xs text-fg-dim transition-colors hover:bg-border-soft/55 hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-40';
  const streamNavigation = isChat && messages.length > 0 && (
    <div
      className="fuc-stream-nav absolute right-2 top-1/2 z-20 flex -translate-y-1/2 flex-col gap-1 rounded-lg p-1"
      aria-label={t(locale, 'dock.streamNavAria')}
    >
      <button
        type="button"
        onClick={() => scrollToStreamEdge('top')}
        title={t(locale, 'dock.navTop')}
        aria-label={t(locale, 'dock.navTop')}
        className={streamNavButtonClass}
      >
        <ArrowUpToLine size={14} />
      </button>
      <button
        type="button"
        onClick={() => scrollToTopic(-1)}
        disabled={topicMessageIds.length === 0}
        title={t(locale, 'dock.navPrevTopic')}
        aria-label={t(locale, 'dock.navPrevTopic')}
        className={streamNavButtonClass}
      >
        <ChevronUp size={14} />
      </button>
      <button
        type="button"
        onClick={() => scrollToTopic(1)}
        disabled={topicMessageIds.length === 0}
        title={t(locale, 'dock.navNextTopic')}
        aria-label={t(locale, 'dock.navNextTopic')}
        className={streamNavButtonClass}
      >
        <ChevronDown size={14} />
      </button>
      <button
        type="button"
        onClick={() => scrollToStreamEdge('bottom')}
        title={t(locale, 'dock.navBottom')}
        aria-label={t(locale, 'dock.navBottom')}
        className={streamNavButtonClass}
      >
        <ArrowDownToLine size={14} />
      </button>
    </div>
  );
  const generationMode: 'image' | 'music' | 'threeD' | null = composer.imageMode
    ? 'image'
    : composer.musicMode
      ? 'music'
      : composer.threeDMode
        ? 'threeD'
        : null;
  const channelOptions =
    generationMode === 'image'
      ? imageChannelOptions
      : generationMode === 'music'
        ? musicChannelOptions
        : generationMode === 'threeD'
          ? threeDChannelOptions
          : channelSelectOptions;
  const channelValue =
    generationMode === 'image'
      ? imageChannelValue
      : generationMode === 'music'
        ? musicChannelValue
        : generationMode === 'threeD'
          ? threeDChannelValue
          : channelSelectValue;
  const handleChannelChange =
    generationMode === 'image'
      ? onImageChannelChange
      : generationMode === 'music'
        ? onMusicChannelChange
        : generationMode === 'threeD'
          ? onThreeDChannelChange
          : onChannelChange;
  const modelOptionsForMode =
    generationMode === 'image'
      ? imageModelOptions
      : generationMode === 'music'
        ? musicModelOptions
        : generationMode === 'threeD'
          ? threeDModelOptions
          : modelSelectOptions;
  const modelValueForMode =
    generationMode === 'image'
      ? imageModelValue
      : generationMode === 'music'
        ? musicModelValue
        : generationMode === 'threeD'
          ? threeDModelValue
          : modelSelectValue;
  const handleModelChange =
    generationMode === 'image'
      ? onImageModelChange
      : generationMode === 'music'
        ? onMusicModelChange
        : generationMode === 'threeD'
          ? onThreeDModelChange
          : onModelChange;
  const modelTitleForMode =
    generationMode === 'threeD'
      ? t(locale, 'dock.threeDModelTitle')
      : generationMode === 'music'
      ? t(locale, 'dock.musicModelTitle')
      : generationMode === 'image'
        ? t(locale, 'dock.imageModelTitle')
        : loadingChannelModels
          ? t(locale, 'dock.modelVersionLoading')
          : t(locale, 'dock.modelVersionTitle');
  const composerModeClass =
    composer.imageMode && !dropActive
      ? 'fuc-ai-input--image '
      : composer.musicMode && !dropActive
        ? 'fuc-ai-input--music '
        : composer.threeDMode && !dropActive
          ? 'fuc-ai-input--three-d '
          : '';
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
      const text = message ? answerActionText(message.text) : '';
      if (!text) return;
      setMessageActionMenu(null);
      void (async () => {
        try {
          const translated = await translatePublicText(text, target, locale);
          if (!translated) return;
          appendChatNote(`${translatedAnswerTitle(target, locale)}\n\n${translated}`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          appendChatNote(`✗ 翻译失败：${message}`);
        }
      })();
    },
    [aiBusy, appendChatNote, locale, messages],
  );

  return (
    <div
      ref={dockRef}
      className={
        'relative ' +
        (isChat
          ? 'flex h-full min-h-0 flex-col bg-bg'
          : 'flex shrink-0 border-t border-border bg-panel')
      }
      style={isChat ? undefined : { height }}
    >
      {/* Resize handle — sits on the top edge, cursor becomes row-resize.
          Hidden in chat layout (the surface fills its parent). */}
      {!isChat && (
        <div
          onMouseDown={onResizeStart}
          title={t(locale, 'common.resizeHeight')}
          className="group absolute -top-1 left-0 right-0 z-20 flex h-2 cursor-row-resize items-center justify-center"
        >
          <div className="h-0.5 w-full bg-transparent transition-colors group-hover:bg-accent/40" />
        </div>
      )}
      {/* AI return stream */}
      <section className="fuc-ai-return-pane flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="fuc-ai-return-header relative flex flex-wrap items-center gap-2 border-b border-border-soft px-3 py-2">
          {isChat && searchToggleButton}
          {isChat ? (
            chatTitleEditing ? (
              <input
                ref={chatTitleInputRef}
                type="text"
                aria-label={t(locale, 'sidebar.renameSession')}
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
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void commitChatTitleEdit();
                  } else if (e.key === 'Escape') {
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
                {chatTitle || t(locale, 'dock.aiReturn')}
              </button>
            ) : (
              <span
                className="min-w-0 flex-1 truncate text-sm font-medium text-fg"
                title={chatTitle}
              >
                {chatTitle || t(locale, 'dock.aiReturn')}
              </span>
            )
          ) : (
            <span className="font-mono text-[10px] uppercase tracking-wider text-accent">
              {t(locale, 'dock.aiReturn')}
            </span>
          )}
          {activeAiEditing && (
            <span className="flex items-center gap-1 font-mono text-[10px] text-accent-2">
              <span className="omc-pulse-dot" />
              {t(locale, 'dock.generating')}
            </span>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {!isChat && searchToggleButton}
          </div>
          {returnSearchOpen && (
            <div
              className={
                'fuc-ai-return-search absolute left-3 right-3 top-full z-30 mt-2 flex items-center gap-1 rounded-lg border border-border bg-panel/95 p-1.5 shadow-2xl backdrop-blur sm:w-96 ' +
                (isChat ? 'sm:right-auto' : 'sm:left-auto')
              }
            >
              <div className="fuc-ai-return-search-input flex min-w-0 flex-1 items-center gap-1 rounded-md border border-border bg-bg px-2 py-1 transition-colors focus-within:border-accent">
                <Search size={13} className="shrink-0 text-fg-faint" />
                <input
                  id="ai-return-search"
                  type="search"
                  ref={searchInputRef}
                  value={returnSearch}
                  onChange={(e) => setReturnSearch(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      moveSearchMatch(e.shiftKey ? -1 : 1);
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      e.stopPropagation();
                      closeReturnSearch();
                    }
                  }}
                  placeholder={t(locale, 'dock.searchPlaceholder')}
                  aria-label={t(locale, 'dock.searchAria')}
                  spellCheck={false}
                  className="min-w-0 flex-1 bg-transparent text-xs text-fg outline-none placeholder:text-fg-faint"
                />
                {returnSearch ? (
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={clearReturnSearch}
                    title={t(locale, 'dock.searchClear')}
                    aria-label={t(locale, 'dock.searchClear')}
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
                title={t(locale, 'dock.searchPrevious')}
                aria-label={t(locale, 'dock.searchPrevious')}
                className="fuc-ai-return-search-button flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-panel-2 text-fg-dim transition-colors hover:border-accent hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
              >
                <ChevronUp size={14} />
              </button>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => moveSearchMatch(1)}
                disabled={searchMatches.length === 0}
                title={t(locale, 'dock.searchNext')}
                aria-label={t(locale, 'dock.searchNext')}
                className="fuc-ai-return-search-button flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-panel-2 text-fg-dim transition-colors hover:border-accent hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
              >
                <ChevronDown size={14} />
              </button>
              <span
                aria-live="polite"
                className={
                  'min-w-[3.75rem] whitespace-nowrap text-right font-mono text-[10px] ' +
                  (normalizedSearch && searchMatches.length === 0
                    ? 'text-accent-3'
                    : 'text-fg-faint')
                }
              >
                {searchStatus}
              </span>
            </div>
          )}
        </header>
        <div className="relative min-h-0 flex-1">
          {captureStatus && (
            <div
              className={
                'pointer-events-none absolute left-1/2 top-2 z-30 -translate-x-1/2 rounded-md border px-3 py-1.5 text-xs shadow-lg ' +
                (captureStatus.kind === 'error'
                  ? 'border-accent-3/50 bg-panel-2 text-accent-3'
                  : captureStatus.kind === 'busy'
                    ? 'border-accent/40 bg-panel-2 text-fg-dim'
                    : 'border-accent/50 bg-panel-2 text-fg')
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
            className="fuc-ai-return-stream h-full min-h-0 overflow-y-auto p-3"
          >
            {messages.length === 0 ? (
              <div
                className={
                  isChat
                    ? 'fuc-ai-return-empty flex h-full items-center justify-center px-4 text-center text-xl font-medium text-fg-dim'
                    : 'fuc-ai-return-empty text-xs text-fg-faint'
                }
              >
                {t(locale, isChat ? 'dock.chatEmpty' : 'dock.empty')}
              </div>
            ) : (
              <ul ref={streamContentRef} className="flex flex-col gap-3">
                {messages.map((m) => {
                  const isUser = m.role === 'user';
                  const isChatUser = isChat && isUser;
                  const isSystem = m.role === 'system';
                  const isSearchHit = searchMatchMessageIds.has(m.id);
                  const isCurrentSearchHit = activeSearchMatchMessageId === m.id;
                  const assistantLabel =
                    !isUser && !isSystem ? assistantHeaderLabel(m) : '';
                  const roleLabel = isUser
                    ? '› you'
                    : isSystem
                      ? '• system'
                      : assistantLabel
                        ? `⟳ ${assistantLabel}`
                        : '⟳ assistant';
                  const roleClass = isUser
                    ? 'text-accent'
                    : isSystem
                      ? 'text-accent-3'
                      : 'text-accent-2';
                  const preserveRoleCase = !!assistantLabel;
                  const captureUtility = isCaptureUtilityMessage(m);
                  const assistantActions =
                    isChat &&
                    !isUser &&
                    !isSystem &&
                    !captureUtility &&
                    !m.interaction &&
                    !normalizedSearch;
                  const actionText = assistantActions ? answerActionText(m.text) : '';
                  const canRegenerate =
                    assistantActions &&
                    !aiBusy &&
                    previousUserText(messages, m.id).length > 0;
                  return (
                    <li
                      key={m.id}
                      data-fuc-capture-exclude={captureUtility ? 'true' : undefined}
                      ref={(node) => {
                        if (node) messageRefs.current.set(m.id, node);
                        else messageRefs.current.delete(m.id);
                      }}
                      className={
                        'group/msg flex flex-col gap-1 rounded-md px-1 py-0.5 transition-colors ' +
                        (isChatUser ? 'items-end ' : '') +
                        (isCurrentSearchHit
                          ? 'bg-accent/5 ring-1 ring-inset ring-accent-3/40'
                          : isSearchHit
                            ? 'ring-1 ring-inset ring-accent/20'
                            : '')
                      }
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <span
                          title={roleLabel}
                          className={
                            'min-w-0 truncate py-0.5 font-mono text-[10px] leading-4 ' +
                            (preserveRoleCase
                              ? 'normal-case tracking-normal '
                              : 'uppercase tracking-wider ') +
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
                        {isUser && m.text.trim() && (
                          <CopyButton
                            value={m.text}
                            title="复制"
                            className="shrink-0 opacity-0 transition-opacity group-hover/msg:opacity-100"
                          />
                        )}
                      </div>
                      {m.runProgress && (
                        <UltracodeRunCard
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
                          active={
                            (m.interactionStatus ?? 'pending') === 'pending' &&
                            (mode === 'running' || activeAiEditing)
                          }
                          onAnswer={(answer) => answerInteraction(m.id, answer)}
                          onDismiss={() => dismissInteraction(m.id)}
                        />
                      ) : normalizedSearch ? (
                        // While a return search is active we fall back to the
                        // plain highlighter for every message so match marks
                        // land on real text nodes.
                          <span
                            className={
                              'whitespace-pre-wrap break-words text-sm leading-relaxed ' +
                              (isChatUser
                                ? 'ai-stream-user-bubble max-w-[86%] rounded-md px-3 py-2 text-left'
                                : isChat
                                  ? 'ai-stream-text w-[min(100%,calc(100%_-_2rem))]'
                                  : 'ai-stream-text')
                            }
                          >
                          {renderHighlightedText(
                            isUser ? m.text : cleanMessageText(m.text),
                            m.id,
                            normalizedSearch,
                            activeSearchMatchId,
                            setActiveSearchMatchNode,
                          )}
                        </span>
                      ) : isUser ? (
                        <span
                          className={
                            'whitespace-pre-wrap break-words text-sm leading-relaxed ' +
                            (isChatUser
                              ? 'ai-stream-user-bubble max-w-[86%] rounded-md px-3 py-2 text-left'
                              : isChat
                                ? 'ai-stream-text w-[min(100%,calc(100%_-_2rem))]'
                                : 'ai-stream-text')
                          }
                        >
                          <FileText
                            text={m.text}
                            onOpenFile={onOpenFile}
                            cwd={workspaceCwd || undefined}
                          />
                        </span>
                      ) : (
                        // Assistant / system: rich markdown, code, tables, file
                        // chips, links, and collapsible reasoning blocks. Off-screen
                        // messages render as plain text first and upgrade lazily so
                        // opening a long history doesn't block on parsing every one.
                        <div
                          className={
                            isChat ? 'w-[min(100%,calc(100%_-_2rem))]' : 'w-full'
                          }
                        >
                          <LazyMessageContent
                            text={renderMessageText(m.text)}
                            fallback={cleanMessageText(m.text)}
                            streaming={aiBusy && m.id === lastAssistantId}
                            showActions={!isSystem}
                            onOpenFile={onOpenFile}
                            eager={
                              forceEagerCapture ||
                              eagerMessageIds.has(m.id) ||
                              (aiBusy && m.id === lastAssistantId)
                            }
                            scrollRootRef={streamRef}
                            cwd={workspaceCwd || undefined}
                          />
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
                          onTranslate={(target) => translateMessage(m.id, target)}
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
          title={t(locale, 'common.resizeSplit')}
          className="group relative z-20 flex w-1.5 shrink-0 cursor-col-resize items-stretch justify-center border-l border-border-soft"
        >
          <div className="h-full w-0.5 bg-transparent transition-colors group-hover:bg-accent/40" />
        </div>
      )}

      {/* Horizontal divider (chat layout only) — drag to re-split AI 返回 (top) /
          AI 输入 (bottom). */}
      {isChat && (
        <div
          onMouseDown={onChatSplitStart}
          title={t(locale, 'common.resizeHeight')}
          className="group relative z-20 flex h-1.5 shrink-0 cursor-row-resize items-stretch justify-center"
        >
          <div className="h-0.5 w-full bg-transparent transition-colors group-hover:bg-accent/40" />
        </div>
      )}

      {/* AI input box. Dock: right column (resizable width). Chat: full-width
          row pinned below the return stream (resizable height).
          The textarea and tool row are wrapped in a single bordered card so they
          read as one big input area, with controls anchored at the bottom edge:
          left = + (add file), permission, workspace; right = runtime + send. */}
      <section
        className="relative flex shrink-0 flex-col bg-transparent p-3"
        style={isChat ? { height: chatInputHeight } : { width: renderedInputWidth }}
        aria-label={t(locale, 'dock.aiInput') + (isReadOnly ? t(locale, 'dock.readonlySuffix') : '')}
      >
        {slashOpen && (
          <div
            id="fuc-slash-suggestions"
            role="listbox"
            aria-label="Slash suggestions"
            className="absolute bottom-[calc(100%+0.375rem)] left-3 right-3 z-50 max-h-64 overflow-y-auto rounded-md border border-border bg-panel shadow-2xl"
          >
            {filteredSlashSuggestions.map((suggestion, index) => {
              const active = index === activeSlashIndex;
              return (
                <button
                  key={suggestion.id}
                  id={`fuc-slash-suggestion-${index}`}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActiveSlashIndex(index)}
                  onClick={() => applySlashSuggestion(suggestion)}
                  className={
                    'flex w-full items-start gap-2 border-l-2 px-2.5 py-2 text-left transition-colors ' +
                    (active
                      ? 'border-l-accent bg-accent/20 text-fg ring-1 ring-inset ring-accent/40'
                      : 'border-l-transparent text-fg-dim hover:border-l-accent/50 hover:bg-border-soft hover:text-fg')
                  }
                >
                  <span
                    className={
                      'mt-0.5 rounded border px-1.5 py-0.5 font-mono text-[11px] leading-none ' +
                      (active
                        ? 'border-accent bg-accent text-bg'
                        : 'border-border bg-bg text-accent')
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
                          'shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider ' +
                          (active
                            ? 'border-accent/50 text-accent'
                            : 'border-border-soft text-fg-faint')
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

        {fileMentionOpen && (
          <div
            id="fuc-file-mention-suggestions"
            role="listbox"
            aria-label="文件建议"
            className="absolute bottom-[calc(100%+0.375rem)] left-3 right-3 z-50 max-h-72 overflow-y-auto rounded-md border border-border bg-panel shadow-2xl"
          >
            {fileMentionOptions.map((entry, index) => {
              const active = index === activeFileMentionIndex;
              const isDirectory = entry.kind === 'directory';
              return (
                <button
                  key={entry.path}
                  id={`fuc-file-mention-suggestion-${index}`}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActiveFileMentionIndex(index)}
                  onClick={() => applyFileMentionOption(entry)}
                  className={
                    'flex w-full min-w-0 items-start gap-2 border-l-2 px-2.5 py-2 text-left transition-colors ' +
                    (active
                      ? 'border-l-accent bg-accent/20 text-fg ring-1 ring-inset ring-accent/40'
                      : 'border-l-transparent text-fg-dim hover:border-l-accent/50 hover:bg-border-soft hover:text-fg')
                  }
                >
                  <span
                    className={
                      'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border ' +
                      (active
                        ? 'border-accent bg-accent text-bg'
                        : 'border-border bg-bg text-fg-faint')
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
                      {isDirectory ? '/' : ''}
                    </span>
                    <span className="mt-0.5 block truncate font-mono text-xs text-fg-faint">
                      {normalizeFileMentionPath(entry.relativePath)}
                      {isDirectory ? '/' : ''}
                    </span>
                  </span>
                </button>
              );
            })}
            {fileMentionListing.status === 'loading' &&
              fileMentionOptions.length === 0 && (
                <div className="flex items-center gap-2 px-3 py-2 text-sm text-fg-faint">
                  <Loader2 size={14} className="animate-spin text-accent" />
                  <span>读取中</span>
                </div>
              )}
            {fileMentionListing.status === 'error' &&
              fileMentionOptions.length === 0 && (
                <div className="px-3 py-2 text-sm leading-snug text-status-error">
                  {fileMentionListing.message}
                </div>
              )}
            {fileMentionListing.status === 'ready' &&
              fileMentionOptions.length === 0 && (
                <div className="px-3 py-2 text-sm text-fg-faint">
                  没有匹配的文件
                </div>
              )}
          </div>
        )}

        {/* Hint/permission row — floats above the input card (over the return
            stream), as its own line rather than inside the card. Left: composer
            input hints with the user's real shortcuts. Right: flat segmented
            permission control (ordered low→high privilege, left→right) plus
            send/newline shortcut hints. */}
        <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] leading-none text-fg-faint">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="inline-flex items-center gap-1">
              <span className="font-mono text-fg-dim">/</span>
              {t(locale, 'dock.hintSlash')}
            </span>
            <span className="text-border">·</span>
            <span className="inline-flex items-center gap-1">
              <span className="font-mono text-fg-dim">@</span>
              {t(locale, 'dock.hintMention')}
            </span>
            <span className="text-border">·</span>
            <span className="inline-flex items-center gap-1">
              {shortcutParts(shortcutSettings['return-search']).map((part) => (
                <kbd
                  key={part}
                  className="rounded border border-border bg-panel-2 px-1 py-0.5 font-mono text-[10px] leading-none text-fg-dim"
                >
                  {part}
                </kbd>
              ))}
              <span>{t(locale, 'dock.hintSearch')}</span>
            </span>
          </div>

          <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <div
              role="radiogroup"
              aria-label={t(locale, 'dock.permissionTitle')}
              className={
                'flex shrink-0 items-center gap-0.5 rounded-md border p-0.5 transition-colors ' +
                (permissionVisual(composer.permission).tone === 'danger'
                  ? 'border-status-error/60 bg-status-error/10'
                  : 'border-border bg-panel-2')
              }
            >
              {[...permissionOptions]
                .sort((a, b) => permissionRank(a.id) - permissionRank(b.id))
                .map((opt) => {
                  const localized = localizeSelectOption(opt, locale);
                  const { Icon, tone, color } = permissionVisual(opt.id);
                  const active = composer.permission === opt.id;
                  // The most permissive ("danger") segment, when active, fills
                  // solid like the mockup's yolo state; safer segments just tint
                  // their label with the tone color on a neutral chip.
                  const activeDanger = active && tone === 'danger';
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      disabled={isReadOnly}
                      title={`${localized.label}${
                        localized.hint ? ` · ${localized.hint}` : ''
                      }`}
                      onClick={() => setComposer({ permission: opt.id })}
                      className={
                        'flex items-center gap-1 rounded px-1.5 py-1 text-[11px] font-medium leading-none transition-colors disabled:cursor-not-allowed disabled:opacity-50 ' +
                        (activeDanger
                          ? 'bg-status-error text-status-error-contrast'
                          : active
                            ? 'bg-bg'
                            : 'text-fg-faint hover:text-fg-dim')
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
                {shortcutParts(shortcutSettings['composer-send']).map((part) => (
                  <kbd
                    key={part}
                    className="rounded border border-border bg-panel-2 px-1 py-0.5 font-mono text-[10px] leading-none text-fg-dim"
                  >
                    {part}
                  </kbd>
                ))}
                <span>{t(locale, 'dock.sendShortcutAction')}</span>
              </span>
              <span className="inline-flex items-center gap-1">
                {shortcutParts(shortcutSettings['composer-newline']).map(
                  (part) => (
                    <kbd
                      key={part}
                      className="rounded border border-border bg-panel-2 px-1 py-0.5 font-mono text-[10px] leading-none text-fg-dim"
                    >
                      {part}
                    </kbd>
                  ),
                )}
                <span>{t(locale, 'dock.newlineShortcutAction')}</span>
              </span>
            </div>
          </div>
        </div>

        <div
          ref={inputDropRef}
          onDragOver={handleComposerDragOver}
          onDragLeave={handleComposerDragLeave}
          onDrop={handleComposerDrop}
          className={
            'fuc-ai-input-card relative flex min-h-0 flex-1 flex-col rounded-lg border transition-colors focus-within:border-accent ' +
            (dropActive
              ? 'fuc-ai-input--drop border-accent '
              : isChat
                ? 'fuc-ai-input--chat border-border '
                : 'border-border ') +
            composerModeClass +
            (isReadOnly ? 'opacity-60 ' : '')
          }
        >
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(e) => {
              draftRef.current = e.target.value;
              setComposerDraft(e.target.value);
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
              if (fileMentionOpen) {
                if (e.key === 'ArrowDown' && fileMentionOptions.length > 0) {
                  e.preventDefault();
                  setActiveFileMentionIndex((index) =>
                    (index + 1) % fileMentionOptions.length,
                  );
                  return;
                }
                if (e.key === 'ArrowUp' && fileMentionOptions.length > 0) {
                  e.preventDefault();
                  setActiveFileMentionIndex(
                    (index) =>
                      (index - 1 + fileMentionOptions.length) %
                      fileMentionOptions.length,
                  );
                  return;
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  closeFileMentionSuggestions();
                  return;
                }
                if (
                  (e.key === 'Tab' || (e.key === 'Enter' && !e.ctrlKey)) &&
                  fileMentionOptions.length > 0
                ) {
                  e.preventDefault();
                  const option = fileMentionOptions[activeFileMentionIndex];
                  if (option) applyFileMentionOption(option);
                  return;
                }
              }
              if (slashOpen) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setActiveSlashIndex((index) =>
                    (index + 1) % filteredSlashSuggestions.length,
                  );
                  return;
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setActiveSlashIndex(
                    (index) =>
                      (index - 1 + filteredSlashSuggestions.length) %
                      filteredSlashSuggestions.length,
                  );
                  return;
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  closeSlashSuggestions();
                  return;
                }
                if (e.key === 'Tab' || (e.key === 'Enter' && !e.ctrlKey)) {
                  e.preventDefault();
                  const suggestion = filteredSlashSuggestions[activeSlashIndex];
                  if (suggestion) applySlashSuggestion(suggestion);
                  return;
                }
              }
              if (matchesShortcut(e.nativeEvent, shortcutSettings['composer-send'])) {
                e.preventDefault();
                closeComposerSuggestions();
                submit();
                return;
              }
              if (
                matchesShortcut(
                  e.nativeEvent,
                  shortcutSettings['composer-newline'],
                )
              ) {
                if (!isNativeTextareaNewlineShortcut(e.nativeEvent)) {
                  e.preventDefault();
                  closeComposerSuggestions();
                  insertComposerText('\n', {
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
                ? t(locale, 'dock.runningPlaceholder')
                : composer.imageMode
                  ? t(locale, 'dock.imageModePlaceholder')
                  : composer.musicMode
                    ? t(locale, 'dock.musicModePlaceholder')
                    : composer.threeDMode
                      ? t(locale, 'dock.threeDModePlaceholder')
                      : t(locale, 'dock.placeholder')
            }
            aria-expanded={slashOpen || fileMentionOpen}
            aria-controls={
              fileMentionOpen
                ? 'fuc-file-mention-suggestions'
                : slashOpen
                  ? 'fuc-slash-suggestions'
                  : undefined
            }
            aria-activedescendant={
              fileMentionOpen && fileMentionOptions.length > 0
                ? `fuc-file-mention-suggestion-${activeFileMentionIndex}`
                : slashOpen
                  ? `fuc-slash-suggestion-${activeSlashIndex}`
                  : undefined
            }
            className={
              'min-h-0 flex-1 resize-none border-0 bg-transparent px-3 pt-3 pb-2 text-sm leading-relaxed text-fg outline-none placeholder:text-fg-faint ' +
              (isReadOnly ? 'cursor-not-allowed' : '')
            }
          />

          {blockedSendTipText && (
            <div
              role="status"
              aria-live="polite"
              data-testid="blocked-send-tip"
              className="mx-2 mb-1 rounded-md border border-status-error/40 bg-status-error/10 px-2.5 py-1.5 text-xs leading-snug text-status-error"
            >
              {blockedSendTipText}
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
              'fuc-ai-input-toolbar flex flex-wrap items-center gap-2 rounded-b-lg px-2 py-2'
            }
          >
            {!generationMode && !simpleChatMode && activeSessionIsWorkflow && (
              <button
                type="button"
                title={t(locale, 'dock.modelStrategyTitle')}
                onClick={() => setModelStrategyOpen((v) => !v)}
                className={cn(composerToolButtonClass, 'gap-1')}
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
                  {(['inherit', 'smart', 'prefer-better', 'prefer-cheaper'] as const).map(
                    (strategy) => (
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
                            'block w-full px-3 py-1.5 text-left text-xs transition-colors ' +
                            (composer.modelStrategy === strategy
                              ? 'bg-border-soft text-fg'
                              : 'text-fg-dim hover:bg-border-soft hover:text-fg')
                          }
                        >
                          {t(locale, modelStrategyLabelKey(strategy))}
                        </button>
                      </li>
                    ),
                  )}
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
                  ? t(locale, 'dock.inputLockedTitle')
                  : t(locale, 'dock.addFileTitle')
              }
              aria-label={t(locale, 'dock.addFileTitle')}
              className={cn(composerToolButtonClass, 'w-7 px-0')}
            >
              <Plus size={15} strokeWidth={2} />
            </button>
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={startSlashCommand}
              disabled={isReadOnly}
              title={t(locale, 'dock.hintSlash')}
              aria-label={t(locale, 'dock.hintSlash')}
              className={cn(composerToolButtonClass, 'gap-1 font-medium')}
            >
              <span className="font-mono text-sm font-semibold">/</span>
              <span>{t(locale, 'dock.hintSlash')}</span>
            </button>
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={startFileMention}
              disabled={isReadOnly}
              title="提及工作区文件"
              aria-label="提及工作区文件"
              className={cn(composerToolButtonClass, 'gap-1 font-medium')}
            >
              <span className="font-mono text-sm font-semibold">@</span>
              <span>提及</span>
            </button>

            <div className="ml-auto flex items-center gap-2">
              <Select
                title={t(locale, 'dock.channelTitle')}
                options={channelOptions}
                value={channelValue}
                onChange={handleChannelChange}
                disabled={isReadOnly}
                className="min-w-0 max-w-[13rem]"
                icon="✦"
                variant="ghost"
                showSelectedHint={false}
              />
              {modelOptionsForMode.length > 0 && (
                <Select
                  title={modelTitleForMode}
                  options={modelOptionsForMode}
                  value={modelValueForMode}
                  onChange={handleModelChange}
                  disabled={isReadOnly}
                  className="min-w-0 max-w-[14rem]"
                  icon={!generationMode && loadingChannelModels ? '↻' : '◇'}
                  variant="ghost"
                />
              )}
              <button
                type="button"
                onClick={() => {
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
                  !chatRunActive &&
                  (!(useChatRunButton ? chatRunText : draft.trim()) ||
                    isReadOnly ||
                    activeAiEditing
                  )
                }
                title={
                  chatRunActive
                    ? t(locale, 'dock.stopChatTitle')
                    : isReadOnly
                      ? t(locale, 'dock.inputLockedTitle')
                      : activeAiEditing
                        ? t(locale, 'dock.aiGeneratingTitle')
                        : useChatRunButton
                          ? t(locale, 'dock.runChatTitle')
                          : sendShortcutHint
                }
                aria-label={
                  chatRunActive
                    ? t(locale, 'dock.stopChatTitle')
                    : useChatRunButton
                      ? t(locale, 'dock.runChatTitle')
                      : sendShortcutHint
                }
                className={
                  'flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40 ' +
                  (chatRunActive
                    ? 'border border-border bg-panel-2 text-fg-dim hover:border-accent hover:text-fg'
                    : 'bg-fg-dim text-bg hover:bg-fg')
                }
              >
                {chatRunActive ? (
                  <Square size={12} strokeWidth={2.2} />
                ) : activeAiEditing
                  ? '…'
                  : (
                    <ArrowUp size={16} strokeWidth={2.4} />
                  )}
              </button>
            </div>
          </div>
        </div>
      </section>
      <FilePreviewDrawer
        refData={filePreviewRef}
        cwd={workspaceCwd || undefined}
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
                  {t(locale, 'dock.freeKeyTitle')} · {keyModalChannel.label}
                </h3>
                <p className="mt-1 text-xs leading-relaxed text-fg-faint">
                  {t(locale, 'dock.freeKeyDescription')}
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setKeyModalChannel(null);
                  setKeyModalValue('');
                }}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-faint transition-colors hover:bg-border-soft hover:text-fg"
                title={t(locale, 'common.close')}
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
                  if (event.key === 'Enter') saveKeyModal();
                  if (event.key === 'Escape') {
                    setKeyModalChannel(null);
                    setKeyModalValue('');
                  }
                }}
                autoFocus
                placeholder={t(locale, 'dock.freeKeyPlaceholder')}
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
                    {t(locale, 'dock.freeKeyGet')}
                  </button>
                ) : (
                  <span className="text-xs text-fg-faint">
                    {t(locale, 'dock.freeKeyNoUrl')}
                  </span>
                )}
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setKeyModalChannel(null);
                      setKeyModalValue('');
                    }}
                    className="rounded-md border border-border bg-panel-2 px-3 py-1.5 text-xs text-fg-dim transition-colors hover:border-accent hover:text-fg"
                  >
                    {t(locale, 'dock.freeKeyCancel')}
                  </button>
                  <button
                    type="button"
                    onClick={saveKeyModal}
                    disabled={!keyModalValue.trim()}
                    className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-bg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {t(locale, 'dock.freeKeySave')}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
      {localSetupChannel?.id === 'ollama' && (
        <LocalModelSetupDialog
          locale={locale}
          downloadUrl={localSetupChannel.setupUrl}
          statusMessage={localSetupMessage}
          onClose={() => {
            setLocalSetupChannel(null);
            setLocalModelValue('');
            setLocalSetupMessage(null);
          }}
          onModelSelected={(model) => {
            setFreeChannelModel(localSetupChannel.id, model);
            setLocalModelValue(model);
            setLocalSetupMessage(t(locale, 'settings.localModel.setupStarted'));
          }}
        />
      )}
      {localSetupChannel && localSetupChannel.id !== 'ollama' && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-bg/75 px-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-lg border border-border bg-panel p-4 shadow-2xl">
            <div className="flex items-start gap-3">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-accent/40 bg-accent/10 text-accent">
                ▣
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-semibold text-fg">
                  {t(locale, 'dock.localModelTitle')} · {localSetupChannel.label}
                </h3>
                <p className="mt-1 text-xs leading-relaxed text-fg-faint">
                  {t(locale, 'dock.localModelDescription')}
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setLocalSetupChannel(null);
                  setLocalModelValue('');
                  setLocalSetupMessage(null);
                }}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-faint transition-colors hover:bg-border-soft hover:text-fg"
                title={t(locale, 'common.close')}
              >
                <X size={15} strokeWidth={2} />
              </button>
            </div>

            <div className="mt-4 space-y-3">
              {localSetupMessage && (
                <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-200">
                  {localSetupMessage}
                </p>
              )}
              <label className="block space-y-1">
                <span className="text-[11px] font-medium text-fg-dim">
                  {t(locale, 'settings.freeChannels.modelLabel')}
                </span>
                <input
                  type="text"
                  value={localModelValue}
                  onChange={(event) => setLocalModelValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') saveLocalModelModal();
                    if (event.key === 'Escape') {
                      setLocalSetupChannel(null);
                      setLocalModelValue('');
                      setLocalSetupMessage(null);
                    }
                  }}
                  autoFocus
                  placeholder={t(locale, 'dock.localModelPlaceholder')}
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
                    {t(locale, 'dock.localModelDownload')}
                  </button>
                ) : (
                  <span className="text-xs text-fg-faint">
                    {t(locale, 'dock.localModelNoUrl')}
                  </span>
                )}
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setLocalSetupChannel(null);
                      setLocalModelValue('');
                      setLocalSetupMessage(null);
                    }}
                    className="rounded-md border border-border bg-panel-2 px-3 py-1.5 text-xs text-fg-dim transition-colors hover:border-accent hover:text-fg"
                  >
                    {t(locale, 'dock.freeKeyCancel')}
                  </button>
                  <button
                    type="button"
                    onClick={saveLocalModelModal}
                    disabled={!localModelValue.trim() || checkingLocalModel}
                    className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-bg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {checkingLocalModel
                      ? t(locale, 'settings.freeChannels.localChecking')
                      : t(locale, 'dock.localModelSave')}
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
