/**
 * Store-domain types: session and UI state, decoupled from the IR.
 */

export type MessageRole = 'user' | 'assistant' | 'system';

/** Per-node execution status while a workflow is running. */
export type NodeRunState = 'idle' | 'running' | 'success' | 'error';

export interface Message {
  id: string;
  role: MessageRole;
  text: string;
  /** Epoch milliseconds. */
  createdAt: number;
}

export interface Session {
  id: string;
  title: string;
  createdAt: number;
  /**
   * True once this session has touched the workflow blueprint — runs, AI graph
   * edits, or direct node/edge mutations all flip it on. Pure chat sessions
   * stay false. Locked: never transitions back to false (mirrors the
   * SessionRecord contract in history-store-spec.md §4.3).
   */
  isWorkflow: boolean;
}

export interface PromptItem {
  id: string;
  label: string;
  /** The prompt text sent via sendPrompt. */
  text: string;
}

export interface PromptGroup {
  id: string;
  label: string;
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
}

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
}
