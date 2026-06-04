import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  ArrowDownToLine,
  ArrowUpToLine,
  ChevronDown,
  ChevronUp,
  Plus,
  Search,
  Square,
  X,
} from 'lucide-react';
import Select from '@/components/Select';
import WorkspaceSelect from '@/components/WorkspaceSelect';
import { summarizeAnswer, type InteractionAnswer } from '@/core/interaction';
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
  updateProvider,
  type Provider,
  type ProviderKind,
  type ProviderRuntimeStatus,
} from '@/lib/apiConfig';
import {
  getCliRuntimeSnapshot,
  isCliAdapterAvailable,
} from '@/lib/cliConfig';
import {
  FREE_CHANNELS,
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
import type { SelectOption } from '@/store/types';
import { localizeSelectOption, t, type Locale } from '@/lib/i18n';
import type { Message } from '@/store/types';
import {
  loadDockHeight,
  loadPaneWidth,
  saveDockHeight,
  savePaneWidth,
} from '@/lib/composerStorage';
import { shouldRefocusComposerAfterAppend } from '@/lib/composerEntryPolicy';
import {
  tauriAvailable,
  localModelStatus,
  openExternal,
  type LocalModelRuntimeStatus,
} from '@/lib/tauri';
import {
  canRefreshFreeChannelModels,
  freeChannelModelOptions,
  providerModelOptions,
  refreshFreeChannelModels,
  refreshProviderModels,
} from '@/lib/modelLists';
import LazyMessageContent from '@/components/ai/LazyMessageContent';
import FilePreviewDrawer from '@/components/ai/FilePreviewDrawer';
import type { FileRef } from '@/components/ai/lib/filePath';
import {
  extractToolSentinels,
  hasToolSentinel,
} from '@/components/ai/lib/toolEvent';
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

function normalizeSearchQuery(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Strip inline tool sentinels (`<<FUC_TOOL>>…`) from a message's text so the
 * search index and the search-active plain-text fallback never see/show raw
 * protocol JSON that the rich renderer would otherwise turn into tool cards.
 */
function cleanMessageText(text: string): string {
  return hasToolSentinel(text) ? extractToolSentinels(text).text : text;
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

function uniqueModelSelectOptions(values: string[]): SelectOption[] {
  const out: SelectOption[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const model = raw.trim();
    if (!model) continue;
    const key = model.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: model, label: model });
  }
  return out;
}

function providerSortRank(status: ProviderRuntimeStatus): number {
  if (status === 'direct') return 1;
  if (status === 'cli') return 2;
  return 3;
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
      <div className="rounded-md border border-accent-2/40 bg-accent-2/5 px-2.5 py-1.5 text-xs text-fg-dim">
        <span className="font-mono text-[10px] uppercase tracking-wider text-accent-2">
          ✓ {t(locale, 'interaction.youAnswered')}
        </span>{' '}
        {summarizeAnswer(req, message.interactionAnswer)}
      </div>
    );
  }
  if (status === 'cancelled') {
    return (
      <div className="rounded-md border border-border bg-panel-2 px-2.5 py-1.5 text-xs text-fg-faint">
        ✖ {t(locale, 'interaction.cancelled')}
      </div>
    );
  }

  const disabled = !active;
  const toggle = (opt: string) =>
    setSelected((cur) =>
      cur.includes(opt) ? cur.filter((o) => o !== opt) : [...cur, opt],
    );

  return (
    <div className="flex flex-col gap-2 rounded-md border border-accent/40 bg-accent/5 px-2.5 py-2">
      <div className="whitespace-pre-wrap text-sm leading-relaxed text-fg-dim">
        {req.prompt}
      </div>

      {req.type === 'select' && !req.multi && (
        <div className="flex flex-wrap gap-1.5">
          {req.options?.map((opt) => (
            <button
              key={opt}
              type="button"
              disabled={disabled}
              onClick={() => onAnswer({ kind: 'select', values: [opt] })}
              className="rounded border border-border bg-bg px-2 py-1 text-xs text-fg transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
            >
              {opt}
            </button>
          ))}
        </div>
      )}

      {req.type === 'select' && req.multi && (
        <div className="flex flex-col gap-2">
          <span className="font-mono text-[10px] uppercase tracking-wider text-fg-faint">
            {t(locale, 'interaction.multiHint')}
          </span>
          <div className="flex flex-wrap gap-1.5">
            {req.options?.map((opt) => {
              const on = selected.includes(opt);
              return (
                <button
                  key={opt}
                  type="button"
                  disabled={disabled}
                  onClick={() => toggle(opt)}
                  className={
                    'rounded border px-2 py-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50 ' +
                    (on
                      ? 'border-accent bg-accent/10 text-accent'
                      : 'border-border bg-bg text-fg hover:border-accent/50')
                  }
                >
                  {on ? '☑' : '☐'} {opt}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            disabled={disabled || selected.length === 0}
            onClick={() => onAnswer({ kind: 'select', values: selected })}
            className="self-start rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-bg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t(locale, 'interaction.submit')}
          </button>
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
              className="resize-none rounded border border-border bg-bg p-2 text-sm text-fg outline-none focus:border-accent disabled:cursor-not-allowed disabled:opacity-50"
            />
          ) : (
            <input
              value={text}
              disabled={disabled}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && text.trim()) {
                  e.preventDefault();
                  onAnswer({ kind: 'input', text: text.trim() });
                }
              }}
              placeholder={
                req.placeholder ?? t(locale, 'interaction.inputPlaceholder')
              }
              className="rounded border border-border bg-bg px-2 py-1.5 text-sm text-fg outline-none focus:border-accent disabled:cursor-not-allowed disabled:opacity-50"
            />
          )}
          <button
            type="button"
            disabled={disabled || !text.trim()}
            onClick={() => onAnswer({ kind: 'input', text: text.trim() })}
            className="self-start rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-bg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t(locale, 'interaction.submit')}
          </button>
        </div>
      )}

      {req.type === 'confirm' && (
        <div className="flex gap-2">
          <button
            type="button"
            disabled={disabled}
            onClick={() => onAnswer({ kind: 'confirm', confirmed: true })}
            className="rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-bg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {req.confirmLabel ?? t(locale, 'interaction.confirm')}
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onAnswer({ kind: 'confirm', confirmed: false })}
            className="rounded-md border border-border px-2.5 py-1 text-xs text-fg-dim transition-colors hover:border-accent-3/60 hover:text-accent-3 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {req.cancelLabel ?? t(locale, 'common.cancel')}
          </button>
        </div>
      )}

      {disabled ? (
        <span className="font-mono text-[10px] text-fg-faint">
          {t(locale, 'interaction.ended')}
        </span>
      ) : (
        <button
          type="button"
          onClick={onDismiss}
          className="self-start font-mono text-[10px] text-fg-faint underline-offset-2 transition-colors hover:text-accent-3 hover:underline"
          title={t(locale, 'interaction.skipTitle')}
        >
          {t(locale, 'interaction.skip')}
        </button>
      )}
    </div>
  );
}

/**
 * CONTRACT: default export, no props. Bottom-center AI interaction dock.
 *
 * Left : AI return stream (messages from the store).
 * Right: AI input box. Enter inserts a newline; Ctrl+Enter calls
 *        store.sendPrompt.
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
  const stopChat = useStore((s) => s.stopChat);
  const chatTitle = useStore(activeChatTitle);
  const activeSessionId = useStore((s) => s.activeSessionId);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const renameWorkflowSession = useStore((s) => s.renameWorkflowSession);
  const runSelection = useStore((s) => workflowDefaultGatewaySelection(s.workflow), shallow);
  const setGlobalRunSelection = useStore((s) => s.setGlobalRunSelection);
  const composer = useStore((s) => s.composer);
  const draft = useStore((s) => s.composerDraft);
  const composerFocusVersion = useStore((s) => s.composerFocusVersion);
  const locale = useStore((s) => s.locale);
  const setComposer = useStore((s) => s.setComposer);
  const setComposerDraft = useStore((s) => s.setComposerDraft);
  const setWorkspace = useStore((s) => s.setWorkspace);
  const permissionOptions = useStore((s) => s.permissionOptions);
  const composerModelOptions = useStore((s) => s.modelOptions);
  const workspaceHistory = useStore((s) => s.workspaceHistory);
  const mode = useStore((s) => s.mode);
  const activeAiEditing = useStore((s) => isActiveAiEditingSession(s));
  const activeChatting = useStore((s) =>
    s.chattingSessions.some(
      (session) =>
        session.workspaceId === (s.activeWorkspaceId ?? null) &&
        session.sessionId === (s.activeSessionId ?? null),
    ),
  );
  const answerInteraction = useStore((s) => s.answerInteraction);
  const dismissInteraction = useStore((s) => s.dismissInteraction);
  const streamRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const chatTitleInputRef = useRef<HTMLInputElement>(null);
  const chatTitleCommitInFlightRef = useRef(false);
  const skipNextTitleBlurCommitRef = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const draftRef = useRef(draft);
  const selectionRef = useRef<TextSelection>({ start: 0, end: 0 });
  const lastComposerFocusVersion = useRef(composerFocusVersion);
  const messageRefs = useRef(new Map<string, HTMLLIElement>());
  const activeSearchMatchNodeRef = useRef<HTMLElement | null>(null);
  const searchScrollTopRef = useRef<number | null>(null);
  const lastSearchActiveRef = useRef(false);

  const isReadOnly = mode === 'running';
  const [dropActive, setDropActive] = useState(false);
  const [filePreviewRef, setFilePreviewRef] = useState<FileRef | null>(null);
  const [chatTitleEditing, setChatTitleEditing] = useState(false);
  const [chatTitleDraft, setChatTitleDraft] = useState('');
  const [chatTitleSaving, setChatTitleSaving] = useState(false);
  const [returnSearchOpen, setReturnSearchOpen] = useState(false);
  const [returnSearch, setReturnSearch] = useState('');
  const [activeSearchMatchIndex, setActiveSearchMatchIndex] = useState(0);
  const normalizedSearch = useMemo(
    () => normalizeSearchQuery(returnSearch),
    [returnSearch],
  );
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
      return listProviders()
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
    },
    [freeChannelRevision],
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
          const needsAttention =
            !freeChannelReady(c.id) ||
            (c.local && localStatus && !localStatus.ready);
          return {
            id: freeChannelOptionId(c.id),
            label: 'Free · ' + c.label + (needsAttention ? ' ⚠' : ''),
            hint: t(locale, 'dock.channelKindFree'),
            group: t(locale, 'dock.channelGroupFree'),
          };
        }),
      ];
    },
    [locale, defaultChannelProviders, localRuntimeStatuses],
  );
  const selectedFreeChannelId = isFreeChannelSelection(runSelection);
  const selectedAdapter =
    RUNTIME_ADAPTERS.find((adapter) => adapter.id === runSelection.adapter)?.id ??
    RUNTIME_ADAPTERS[0].id;
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
        freeChannelModelOptions(selectedFreeChannel),
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
    runSelection.modelClass,
    composerModelOptions,
    modelListRevision,
  ]);
  const modelSelectValue = selectedFreeChannel
    ? getFreeChannelModel(selectedFreeChannel.id) || 'default'
    : selectedDefaultProvider
      ? (selectedDefaultProvider.provider.model ?? '').trim() ||
        runSelection.modelClass ||
        'default'
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
      setGlobalRunSelection(
        freeChannelSelection(channel.id, getFreeChannelModel(channel.id)),
      );
      setKeyModalChannel(null);
      setKeyModalValue('');
      setLocalSetupChannel(null);
      setLocalModelValue('');
      setLocalSetupMessage(null);
    },
    [setGlobalRunSelection],
  );
  const onChannelChange = useCallback(
    (id: string) => {
      void (async () => {
        const providerId = providerIdFromDefaultOption(id);
        if (providerId) {
          const provider = defaultChannelProviders.find(
            (item) => item.provider.id === providerId,
          )?.provider;
          if (provider) setGlobalRunSelection(providerSelection(provider));
          return;
        }
        const defaultAdapter = adapterFromSystemDefaultOption(id);
        if (defaultAdapter) {
          setGlobalRunSelection(systemDefaultGatewaySelection(defaultAdapter));
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
    [defaultChannelProviders, locale, setGlobalRunSelection, selectFreeChannel],
  );
  const onModelChange = useCallback(
    (model: string) => {
      const selectedModel = model.trim();
      if (!selectedModel) return;
      if (selectedFreeChannel) {
        setFreeChannelModel(selectedFreeChannel.id, selectedModel);
        void ensureFreeProxy();
        setGlobalRunSelection(
          freeChannelSelection(selectedFreeChannel.id, selectedModel),
        );
        return;
      }
      if (selectedDefaultProvider) {
        const nextModel =
          selectedModel === 'default' ? undefined : selectedModel;
        const provider = selectedDefaultProvider.provider;
        updateProvider(provider.id, { model: nextModel });
        setGlobalRunSelection(
          providerSelection({ ...provider, model: nextModel }, nextModel),
        );
        return;
      }
      setGlobalRunSelection(
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
      setGlobalRunSelection,
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
  const onOpenFile = useCallback(
    (ref: FileRef) => {
      setFilePreviewRef(ref);
    },
    [],
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
    stream.scrollTo({
      top: edge === 'top' ? 0 : stream.scrollHeight,
      behavior: 'smooth',
    });
  }, []);

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
        if (!el) return;
        el.focus();
        el.setSelectionRange(caret, caret);
      });
    },
    [isReadOnly, setComposerDraft],
  );

  const insertFilePaths = useCallback(
    (paths: string[], selection = selectionRef.current) => {
      insertComposerText(formatFilePathInsertion(paths), selection);
    },
    [insertComposerText],
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
    if (returnSearchOpen) focusSearchInput();
  }, [focusSearchInput, returnSearchOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (keyModalChannel || localSetupChannel) return;
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        event.key.toLowerCase() === 'f'
      ) {
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

  // Keep the latest message in view unless return search is active.
  useEffect(() => {
    if (normalizedSearch) return;
    if (searchScrollTopRef.current !== null) return;
    const el = streamRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, normalizedSearch]);

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
    if (!el || !shouldRefocusComposerAfterAppend(mode)) return;
    el.focus();
    const end = el.value.length;
    el.setSelectionRange(end, end);
    selectionRef.current = { start: end, end };
  }, [composerFocusVersion, mode]);

  useEffect(() => {
    if (!tauriAvailable()) return;

    let disposed = false;
    let unlisten: (() => void) | undefined;

    const setup = async () => {
      const { getCurrentWebview } = await import('@tauri-apps/api/webview');
      const dispose = await getCurrentWebview().onDragDropEvent((event) => {
        if (disposed) return;
        const payload = event.payload;
        const el = inputRef.current;

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

  const submit = (overrideText?: string) => {
    if (isReadOnly || activeAiEditing) return;
    const text = (overrideText ?? draft).trim();
    if (!text) return;
    void (async () => {
      if (!(await ensureSelectedLocalChannelReady())) return;
      sendPrompt(text);
      if (overrideText === undefined) {
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
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="relative flex flex-wrap items-center gap-2 border-b border-border-soft px-3 py-2">
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
            {isChat && activeChatting && (
              <button
                type="button"
                onClick={stopChat}
                title={t(locale, 'dock.stopChatTitle')}
                aria-label={t(locale, 'dock.stopChatTitle')}
                className="flex shrink-0 items-center gap-1.5 rounded-md border border-status-error/40 bg-status-error/15 px-3 py-1.5 text-xs font-semibold text-status-error transition-opacity hover:opacity-90"
              >
                <Square size={12} fill="currentColor" strokeWidth={2.2} />
                <span>{t(locale, 'dock.runningStop')}</span>
              </button>
            )}
            {!isChat && searchToggleButton}
          </div>
          {returnSearchOpen && (
            <div
              className={
                'absolute left-3 right-3 top-full z-30 mt-2 flex items-center gap-1 rounded-lg border border-border bg-panel/95 p-1.5 shadow-2xl backdrop-blur sm:w-96 ' +
                (isChat ? 'sm:right-auto' : 'sm:left-auto')
              }
            >
              <div className="flex min-w-0 flex-1 items-center gap-1 rounded-md border border-border bg-bg px-2 py-1 transition-colors focus-within:border-accent">
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
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-panel-2 text-fg-dim transition-colors hover:border-accent hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
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
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-panel-2 text-fg-dim transition-colors hover:border-accent hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
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
          <div
            ref={streamRef}
            className={
              'h-full min-h-0 overflow-y-auto p-3 ' + (isChat ? 'pr-10' : '')
            }
          >
            {messages.length === 0 ? (
              <div
                className={
                  isChat
                    ? 'flex h-full items-center justify-center px-4 text-center text-xl font-medium text-fg-dim'
                    : 'text-xs text-fg-faint'
                }
              >
                {t(locale, isChat ? 'dock.chatEmpty' : 'dock.empty')}
              </div>
            ) : (
              <ul className="flex flex-col gap-3">
                {messages.map((m) => {
                  const isUser = m.role === 'user';
                  const isChatUser = isChat && isUser;
                  const isSystem = m.role === 'system';
                  const isSearchHit = searchMatchMessageIds.has(m.id);
                  const isCurrentSearchHit = activeSearchMatchMessageId === m.id;
                  const roleLabel = isUser
                    ? '› you'
                    : isSystem
                      ? '• system'
                      : '⟳ assistant';
                  const roleClass = isUser
                    ? 'text-accent'
                    : isSystem
                      ? 'text-accent-3'
                      : 'text-accent-2';
                  return (
                    <li
                      key={m.id}
                      ref={(node) => {
                        if (node) messageRefs.current.set(m.id, node);
                        else messageRefs.current.delete(m.id);
                      }}
                      className={
                        'flex flex-col gap-1 rounded-md px-1 py-0.5 transition-colors ' +
                        (isChatUser ? 'items-end ' : '') +
                        (isCurrentSearchHit
                          ? 'bg-accent/5 ring-1 ring-inset ring-accent-3/40'
                          : isSearchHit
                            ? 'ring-1 ring-inset ring-accent/20'
                            : '')
                      }
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className={
                            'font-mono text-[10px] uppercase tracking-wider ' + roleClass
                          }
                        >
                          {roleLabel}
                        </span>
                        <span
                          className="font-mono text-[10px] text-fg-faint"
                          title={new Date(m.createdAt).toLocaleString()}
                        >
                          {formatMessageTime(m.createdAt)}
                        </span>
                      </div>
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
                      ) : isUser || normalizedSearch ? (
                        // User turns stay plain text; while a return search is
                        // active we fall back to the plain highlighter for every
                        // message so match marks land on real text nodes.
                        <span
                          className={
                            'whitespace-pre-wrap break-words text-sm leading-relaxed ' +
                            (isChatUser
                              ? 'max-w-[86%] rounded-md border border-accent/20 bg-accent/10 px-3 py-2 text-left text-fg'
                              : isChat
                                ? 'w-[min(100%,calc(100%_-_2rem))] text-fg-dim'
                                : 'text-fg-dim')
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
                            text={m.text}
                            fallback={cleanMessageText(m.text)}
                            streaming={aiBusy && m.id === lastAssistantId}
                            showActions={!isSystem}
                            onOpenFile={onOpenFile}
                            eager={
                              eagerMessageIds.has(m.id) ||
                              (aiBusy && m.id === lastAssistantId)
                            }
                            scrollRootRef={streamRef}
                          />
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
          className="group relative z-20 flex h-1.5 shrink-0 cursor-row-resize items-stretch justify-center border-t border-border-soft"
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
        className="relative flex shrink-0 flex-col bg-panel p-3"
        style={isChat ? { height: chatInputHeight } : { width: renderedInputWidth }}
        aria-label={t(locale, 'dock.aiInput') + (isReadOnly ? t(locale, 'dock.readonlySuffix') : '')}
      >
        <div
          className={
            'fuc-ai-input-card relative flex min-h-0 flex-1 flex-col rounded-lg border bg-bg transition-colors focus-within:border-accent ' +
            (dropActive
              ? 'fuc-ai-input--drop border-accent '
              : isChat
                ? 'fuc-ai-input--chat border-border '
                : 'border-border ') +
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
            }}
            onClick={(e) => rememberSelection(e.currentTarget)}
            onKeyUp={(e) => rememberSelection(e.currentTarget)}
            onSelect={(e) => rememberSelection(e.currentTarget)}
            onFocus={(e) => rememberSelection(e.currentTarget)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && e.ctrlKey) {
                e.preventDefault();
                submit();
              }
            }}
            onDragOver={(e) => {
              if (isReadOnly || tauriAvailable()) return;
              e.preventDefault();
              setDropActive(true);
            }}
            onDragLeave={() => setDropActive(false)}
            onDrop={(e) => {
              if (isReadOnly || tauriAvailable()) return;
              e.preventDefault();
              setDropActive(false);
              rememberSelection(e.currentTarget);
              insertFilePaths(pathsFromDataTransfer(e.dataTransfer));
            }}
            readOnly={isReadOnly}
            disabled={isReadOnly}
            placeholder={
              isReadOnly
                ? t(locale, 'dock.runningPlaceholder')
                : t(locale, 'dock.placeholder')
            }
            className={
              'min-h-0 flex-1 resize-none border-0 bg-transparent px-3 pt-3 pb-2 text-sm leading-relaxed text-fg outline-none placeholder:text-fg-faint ' +
              (isReadOnly ? 'cursor-not-allowed' : '')
            }
          />

          {/* Tool row pinned to the bottom edge of the card. Left cluster groups
              channel/file/permission/workspace; the send button stays
              aligned to the right.
              rounded-b-lg: parent has no overflow-hidden so dropdown menus can
              extend above the card; this keeps the toolbar visually flush with
              the parent's rounded bottom corners. */}
          <div className="flex flex-wrap items-center gap-2 rounded-b-lg bg-bg px-2 py-2">
            <Select
              title={t(locale, 'dock.channelTitle')}
              options={channelSelectOptions}
              value={channelSelectValue}
              onChange={onChannelChange}
              disabled={isReadOnly}
              className="min-w-0"
              icon="✦"
            />
            {modelSelectOptions.length > 0 && (
              <Select
                title={
                  loadingChannelModels
                    ? t(locale, 'dock.modelVersionLoading')
                    : t(locale, 'dock.modelVersionTitle')
                }
                options={modelSelectOptions}
                value={modelSelectValue}
                onChange={onModelChange}
                disabled={isReadOnly}
                className="min-w-0 max-w-[14rem]"
                icon={loadingChannelModels ? '↻' : '◇'}
              />
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
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-panel-2 text-fg-dim transition-colors hover:border-accent hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Plus size={15} strokeWidth={2} />
            </button>
            <Select
              title={t(locale, 'dock.permissionTitle')}
              options={permissionOptions.map((opt) => localizeSelectOption(opt, locale))}
              value={composer.permission}
              onChange={(id) => setComposer({ permission: id })}
              disabled={isReadOnly}
              icon="⚠"
            />
            <WorkspaceSelect
              value={composer.workspace}
              history={workspaceHistory}
              onSelect={setWorkspace}
              disabled={activeAiEditing}
              className="min-w-0"
            />

            <div className="ml-auto flex items-center">
              <button
                type="button"
                onClick={() => submit()}
                disabled={!draft.trim() || isReadOnly || activeAiEditing}
                title={
                  isReadOnly
                    ? t(locale, 'dock.inputLockedTitle')
                    : activeAiEditing
                      ? t(locale, 'dock.aiGeneratingTitle')
                      : t(locale, 'dock.sendShortcut')
                }
                aria-label={t(locale, 'dock.sendShortcut')}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent text-sm font-medium text-bg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {activeAiEditing ? '…' : '↑'}
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
