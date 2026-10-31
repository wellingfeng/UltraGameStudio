/**
 * Store-domain types: session and UI state, decoupled from the IR.
 */

import type { GatewaySelection, IRRunStatus } from '@/core/ir';
import type {
  InteractionAnswer,
  InteractionRequest,
} from '@/core/interaction';
import type { StudioRunProgress } from '@/runtime/studioProgress';
import type {
  Locale,
  PromptGroupLocaleValue,
  PromptItemLocaleValue,
} from '@/lib/i18n';

export type MessageRole = 'user' | 'assistant' | 'system';

export type MessageAppAction =
  | {
      type: 'blueprint-mode-install';
      rootPath: string;
      modeArgs?: string | null;
      prompt?: string;
    };

/** Per-node execution status while a workflow is running. */
export type NodeRunState = IRRunStatus;

/** Terminal run status shown in the history rail after a workflow run ends. */
export type SessionRunStatus = Exclude<IRRunStatus, 'idle' | 'running'>;

/** Canvas pan/zoom state for one history session. */
export interface CanvasViewport {
  x: number;
  y: number;
  zoom: number;
}

export type ScheduledTaskWeekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface ScheduledTaskConfig {
  name?: string;
  templateId?: string;
  cronExpression?: string;
  timeZone?: string;
  promptLocale?: Locale;
  maxHistoryRuns?: number;
  /** Absolute timestamp for a one-time task. */
  onceAt?: number;
  lastError?: string;
  enabled: boolean;
  reminderText: string;
  hour: number;
  minute: number;
  second: number;
  weekdays: ScheduledTaskWeekday[];
  repeat: boolean;
  remindOnRun: boolean;
  updatedAt: number;
  lastRunAt?: number;
}

/** Lifecycle of an interactive message (a node asking the user to choose/type). */
export type InteractionStatus = 'pending' | 'answered' | 'cancelled';

/**
 * In-progress answer state for an interaction widget. `values` covers select
 * toggles (including custom-added options), `text` covers the free-text input
 * (select's custom-input box and the input widget's field).
 */
export interface InteractionDraft {
  values?: string[];
  text?: string;
}

export interface Message {
  id: string;
  role: MessageRole;
  text: string;
  scheduledTaskRun?: boolean;
  /** Revision timestamp; creation time remains stable for stream ordering. */
  editedAt?: number;
  /** Edited resend: hide this earlier user input in the stream, retain model history. */
  replacesMessageId?: string;
  /** Inactive conversation tails, including the original user input. */
  chatRevisions?: { messages: Message[]; savedAt: number }[];
  /** Position of the active tail among the saved versions plus the active one. */
  chatRevisionIndex?: number;
  /** Assistant route shown in the message header, e.g. "OpenRouter · glm-4.6". */
  routeLabel?: string;
  /** Thinking level selected when this turn started; default means no override. */
  thinkingLevel?: string;
  /** Epoch milliseconds. */
  createdAt: number;
  /** Epoch milliseconds when an assistant turn finished. Used for history order. */
  completedAt?: number;
  /** Native runtime confirmed that this assistant turn compressed its context. */
  contextCompressed?: boolean;
  /** File summary captured at turn completion; survives history reloads. */
  fileChanges?: import('@/lib/turnFileChanges').TurnFileChanges;
  /** Successful web-tool evidence, including results not used by the answer. */
  referenceSources?: import('@/lib/messageReferences').ReferenceSource[];
  /** Cited sources in first-use order; survives tool-log clipping. */
  references?: import('@/lib/messageReferences').MessageReference[];
  /** Full-read metadata for the source turn; never replayed as assistant prose. */
  skillContext?: {
    origin: import('@/runtime/skills/types').SkillOrigin;
    sourceSession?: import('@/runtime/skills/types').SkillSourceSession;
    loadedSkills: import('@/runtime/skills/types').SkillLearningJob['loadedSkills'];
    catalogRevision: string;
  };
  /** Host review state on a separate localOnly result card. */
  skillLearning?: import('@/runtime/skills/types').SkillReviewState;
  /**
   * Present when this message is a node's request for user input (rendered in
   * the AI-return dock as a select/input/confirm widget rather than plain text).
   * See {@link InteractionRequest}. Plain log/chat messages omit these.
   */
  interaction?: InteractionRequest;
  /** The user's reply, set once they submit the widget. */
  interactionAnswer?: InteractionAnswer;
  /** Widget lifecycle; gates rendering (pending = active, else read-only). */
  interactionStatus?: InteractionStatus;
  /**
   * UI-only draft of the in-progress answer (typed text / toggled options).
   * Persisted on the message so switching sessions and back doesn't wipe what
   * the user already typed into the widget. Cleared when the interaction is
   * answered or dismissed.
   */
  interactionDraft?: InteractionDraft;
  /** App-owned interactive actions rendered through the same AI return widget. */
  appAction?: MessageAppAction;
  /**
   * Present on the assistant message of a live `/studio` run: a structured
   * snapshot of run progress (agent count, elapsed, per-node status) decoded
   * from the CLI's `<<UGS_PROGRESS>>` sentinels. Drives the run-progress card
   * rendered above the message's log text. See runtime/studioProgress.ts.
   */
  runProgress?: StudioRunProgress;
  /**
   * Per-turn token usage for an assistant message: the snapshot delta across the
   * turn that produced it (a turn may issue several model sub-calls). Persisted
   * with the message so the chat history keeps the numbers after reload. Absent
   * on user/system messages and on assistant turns that recorded no usage.
   */
  usage?: MessageUsage;
  /**
   * UI-only note that must never be replayed back to the model as conversation
   * context. Set on bubbles produced for the user's benefit rather than as part
   * of the actual dialogue — e.g. the "🌐 翻译为…" on-demand translation of an
   * answer (whose translated text would otherwise corrupt the transcript, since
   * translating an assistant turn also rewrites its tool-call markup). History
   * builders MUST drop messages with this flag before sending to the LLM.
   */
  localOnly?: boolean;
  /**
   * User message that was steered ("插话") into an already-running turn instead
   * of starting a new one. It belongs to that turn's input, so the stream shows
   * it just above the turn's reply bubble rather than stranded at the tail of
   * the conversation, where it reads as "not sent yet".
   */
  interjected?: boolean;
  /** Reply bubble targeted by native steering; stable across history reloads. */
  interjectedReplyId?: string;
}

/**
 * Token usage attached to a single assistant message. `cachePercent` is only
 * meaningful when `estimated` is false (a real, server-reported turn).
 */
export interface MessageUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  cachePercent: number;
  estimated: boolean;
}

export interface Session {
  id: string;
  /** Workspace bucket that owns this session once history persistence is active. */
  workspaceId?: string;
  title: string;
  createdAt: number;
  /** Last message / workflow update time; falls back to createdAt for old seeds. */
  updatedAt?: number;
  /**
   * True once this session has touched the workflow blueprint — runs, AI graph
   * edits, or direct node/edge mutations all flip it on. Pure chat sessions
   * stay false. Locked: never transitions back to false (mirrors the
   * SessionRecord contract in history-store-spec.md §4.3).
   */
  isWorkflow: boolean;
  /**
   * True when this workflow session is a "simple workflow" (meta.simple) — a
   * single nameless node used for easy one-shot questions. Drives the chat
   * history badge (vs "WF"). Always false/undefined for chat sessions.
   */
  simple?: boolean;
  /** Sidebar preview from the last persisted message. */
  preview?: string;
  /** Persisted message count for lightweight history rendering. */
  messageCount?: number;
  /** Last terminal workflow run status, used by the history status indicator. */
  runStatus?: SessionRunStatus;
  /**
   * True when `runStatus === 'success'` and the user has not opened the session
   * since that completion. Drives the "已完成（未查看）" brighter-green badge in
   * the history rail; cleared once the session is selected.
   */
  unreadCompletion?: boolean;
  /** This session has a confirmed native context compression. */
  contextCompressed?: boolean;
  /** True when a workflow session is pinned into the Sidebar favorites tab. */
  favorite?: boolean;
  /** Highest-priority ordering in the Sidebar history list. */
  pinned?: boolean;
  /** Optional alarm-style schedule for favorite sessions. */
  scheduledTask?: ScheduledTaskConfig;
}

export interface PromptItem {
  id: string;
  label: string;
  /** Prompt text appended to the AI input box from the prompt library. */
  text: string;
  /** Per-language prompt variants. Legacy label/text remain the fallback. */
  translations?: Partial<Record<Locale, PromptItemLocaleValue>>;
}

export interface PromptGroup {
  id: string;
  label: string;
  /** Per-language group labels. Legacy label remains the fallback. */
  translations?: Partial<Record<Locale, PromptGroupLocaleValue>>;
  items: PromptItem[];
}

/**
 * A single choice in a composer dropdown (workspace / permission / model).
 * `label` is the primary text; `hint` is optional secondary text shown as a
 * badge (e.g. a model tier like "5.5 超高").
 */
export interface SelectOption {
  id: string;
  label: string;
  hint?: string;
  action?: boolean;
  /**
   * Optional category label. When consecutive options carry different `group`
   * values, the dropdown renders a divider + header before the first option of
   * each group (e.g. grouping models by runtime: Claude Code / Codex / Gemini).
   */
  group?: string;
  translations?: Partial<Record<Locale, { label: string; hint?: string }>>;
}

/**
 * AI 改图时为每个节点自动选模型的策略。
 * 'inherit' = 不自动指定，保持现状（不注入额外提示词）。
 */
export type ModelStrategy = 'inherit' | 'smart' | 'prefer-better' | 'prefer-cheaper';

/**
 * 会话启动模式。决定新会话首次发消息时如何准备工作目录:
 * - 'local'：在本地处理 — 直接在所选工作区目录中运行(默认)。
 * - 'worktree'：新工作树 — 首次发送前先准备一个隔离工作目录(git 仓库用
 *   `git worktree` 新建分支,非 git 目录复制一份),之后会话在隔离目录中运行,
 *   原工作区不受影响。与缓存时间(TTL)一样,仅在会话开启前可改,开启后锁定。
 */
export type StartupMode = 'local' | 'worktree';

/**
 * AI-input composer settings. Pure UI state — never enters the IRGraph.
 * Each field holds the id of the selected option in its respective list.
 */
export interface ComposerSettings {
  /** matches a permissionOptions[].id */
  permission: string;
  /** matches a modelOptions[].id */
  model: string;
  /**
   * 会话缓存时间(TTL)，单位分钟。用于标记会话上下文希望保留的时长。
   * 仅允许 5/10/20/30/40/50/60, 默认 5。会话开启(发出首条消息)
   * 后锁定，不再可改。
   */
  cacheTtlMinutes: number;
  /**
   * 会话启动模式 ('local' | 'worktree')。决定新会话首次发消息时是否准备隔离
   * 工作目录。仅在会话开启(发出首条消息)前可改,开启后锁定,不再可改。默认
   * 'local'。
   */
  startupMode: StartupMode;
  /** absolute path of the selected workspace folder ('' = none chosen yet) */
  workspace: string;
  /** Additional workspace folders attached to the current session. */
  workspaceFolders: string[];
  /** AI 改图时为每个节点自动选模型的策略 */
  modelStrategy: ModelStrategy;
  /**
   * 项目知识库检索开关。true 时简单聊天会从当前项目知识库检索相关片段并注入 prompt。
   */
  knowledgeBaseMode: boolean;
  /**
   * 粘性 GDD 草稿模式。true 时裸文本走“反复修改 GDD/资产清单/实现计划”
   * 流程；由 /gdd-mode-start 开启、/gdd-mode-end 冻结并退出。
   */
  gddMode: boolean;
  /** Epoch ms when sticky GDD mode started. */
  gddModeStartedAt?: number | null;
  /**
   * 粘性生图模式。true 时输入框里的裸文本(无 slash 命令)走图片生成而非
   * AI 编程;由 /image-mode-start 开启、/image-mode-end 关闭。
   */
  imageMode: boolean;
  /** Epoch ms when sticky image mode started; used to merge mode-local prompts. */
  imageModeStartedAt?: number | null;
  /**
   * 粘性音乐模式。true 时输入框里的裸文本(无 slash 命令)走音乐生成而非
   * AI 编程;由 /music-mode-start 开启、/music-mode-end 关闭。
   */
  musicMode: boolean;
  /** Epoch ms when sticky music mode started; used to merge mode-local prompts. */
  musicModeStartedAt?: number | null;
  /**
   * 粘性 3D 生成模式。true 时输入框里的裸文本(无 slash 命令)走 3D 模型生成而非
   * AI 编程;由 /mesh-mode-start 开启、/mesh-mode-end 关闭。
   */
  threeDMode: boolean;
  /** Epoch ms when sticky mesh mode started; used to merge mode-local prompts. */
  threeDModeStartedAt?: number | null;
  /**
   * 粘性生视频模式。true 时输入框里的裸文本(无 slash 命令)走视频生成而非
   * AI 编程;由 /video-mode-start 开启、/video-mode-end 关闭。
   */
  videoMode: boolean;
  /** Epoch ms when sticky video mode started; used to merge mode-local prompts. */
  videoModeStartedAt?: number | null;
  /**
   * 粘性动画模式。true 时输入框里的裸文本走动作库搜索或 AI 动画生成而非
   * AI 编程;由 /anim-mode-start 开启、/anim-mode-end 关闭。
   */
  animationMode: boolean;
  /** Epoch ms when sticky animation mode started; used to merge mode-local prompts. */
  animationModeStartedAt?: number | null;
  /**
   * 粘性文本转语音模式。true 时输入框里的裸文本(无 slash 命令)走语音合成而非
   * AI 编程;由 /speech-mode-start 开启、/speech-mode-end 关闭。
   */
  speechMode: boolean;
  /** Epoch ms when sticky speech mode started; used to merge mode-local prompts. */
  speechModeStartedAt?: number | null;
  /**
   * 粘性 Sprite 动画模式。true 时输入框里的裸文本(无 slash 命令)走 sprite
   * 生成而非 AI 编程;由 /sprite-mode-start 开启、/sprite-mode-end 关闭。
   */
  spriteMode: boolean;
  /** Epoch ms when sticky sprite mode started; used to merge mode-local prompts. */
  spriteModeStartedAt?: number | null;
  /**
   * 粘性 ComfyUI 模式。true 时输入框里的裸文本(无 slash 命令)走 ComfyUI 节点图
   * 生成而非 AI 编程;由 /comfyui-mode-start 开启、/comfyui-mode-end 关闭。
   * 编程模型被要求输出一个 ```comfyui 代码块(ComfyUI prompt graph JSON),
   * 信息流将其渲染为可展开的内嵌节点图。
   */
  comfyMode: boolean;
  /** Epoch ms when sticky ComfyUI mode started; used to merge mode-local prompts. */
  comfyModeStartedAt?: number | null;
  /**
   * 粘性世界模型模式。true 时输入框里的裸文本(无 slash 命令)走交互式可玩世界
   * 模型生成而非 AI 编程;由 /worldmodel-mode-start 开启、/worldmodel-mode-end
   * 关闭。编程模型被要求输出一个 ```worldmodel 代码块(世界定义 JSON),信息流
   * 将其渲染为可展开、可直接试玩的内嵌世界预览。
   */
  worldMode: boolean;
  /** Epoch ms when sticky world-model mode started; used to merge mode-local prompts. */
  worldModeStartedAt?: number | null;
  /**
   * 粘性 UI 设计模式。true 时输入框里的裸文本(无 slash 命令)走游戏 UI 设计流程而非
   * 普通 AI 编程;由 /ui-mode-start 开启、/ui-mode-end 关闭。编程模型被要求按默认
   * UI 渠道产出界面设计稿与可交付资产。
   */
  uiMode: boolean;
  /** Epoch ms when sticky UI mode started; used to merge mode-local prompts. */
  uiModeStartedAt?: number | null;
  /**
   * 粘性 MetaHuman MVP 模式。true 时输入框里的裸文本走“参考脸图 → 3D 人脸
   * mesh/参数拟合 → UE 本地 MetaHuman Identity/Character”的分阶段确认流程，
   * 而不是普通 AI 编程;由 /metahuman-mode-start 开启、/metahuman-mode-end 关闭。
   */
  metahumanMode: boolean;
  /** Epoch ms when sticky MetaHuman MVP mode started. */
  metahumanModeStartedAt?: number | null;
  /**
   * 粘性 UE 蓝图模式。true 时输入框里的裸文本走 UE 蓝图编排提示，而不是普通
   * AI 编程;由 /blueprint-mode-start 开启、/blueprint-mode-end 关闭。
   */
  blueprintMode: boolean;
  /** Epoch ms when sticky UE Blueprint mode started. */
  blueprintModeStartedAt?: number | null;
  /** Raw /blueprint-mode-start options, e.g. --target BP_Player --context full. */
  blueprintModeArgs?: string | null;
}

export interface SessionComposerSettings {
  composer: ComposerSettings;
  gatewaySelection: GatewaySelection;
}
