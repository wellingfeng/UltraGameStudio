/**
 * Store-domain types: session and UI state, decoupled from the IR.
 */

import type { GatewaySelection, IRRunStatus } from '@/core/ir';
import type {
  InteractionAnswer,
  InteractionRequest,
} from '@/core/interaction';
import type { UltracodeRunProgress } from '@/runtime/ultracodeProgress';
import type {
  Locale,
  PromptGroupLocaleValue,
  PromptItemLocaleValue,
} from '@/lib/i18n';

export type MessageRole = 'user' | 'assistant' | 'system';

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

export interface Message {
  id: string;
  role: MessageRole;
  text: string;
  /** Assistant route shown in the message header, e.g. "OpenRouter · glm-4.6". */
  routeLabel?: string;
  /** Epoch milliseconds. */
  createdAt: number;
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
   * Present on the assistant message of a live `/ultracode` run: a structured
   * snapshot of run progress (agent count, elapsed, per-node status) decoded
   * from the CLI's `<<FUC_PROGRESS>>` sentinels. Drives the run-progress card
   * rendered above the message's log text. See runtime/ultracodeProgress.ts.
   */
  runProgress?: UltracodeRunProgress;
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
  /** True when a workflow session is pinned into the Sidebar favorites tab. */
  favorite?: boolean;
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
 * AI-input composer settings. Pure UI state — never enters the IRGraph.
 * Each field holds the id of the selected option in its respective list.
 */
export interface ComposerSettings {
  /** matches a permissionOptions[].id */
  permission: string;
  /** matches a modelOptions[].id */
  model: string;
  /** absolute path of the selected workspace folder ('' = none chosen yet) */
  workspace: string;
  /** AI 改图时为每个节点自动选模型的策略 */
  modelStrategy: ModelStrategy;
  /**
   * 粘性生图模式。true 时输入框里的裸文本(无 slash 命令)走图片生成而非
   * AI 编程;由 /image-mode-start 开启、/image-mode-end 关闭。
   */
  imageMode: boolean;
}

export interface SessionComposerSettings {
  composer: ComposerSettings;
  gatewaySelection: GatewaySelection;
}
