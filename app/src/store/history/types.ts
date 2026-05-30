/**
 * CONTRACT: historical-record data shapes.
 *
 * Mirrors §3 of `.omc/plans/history-store-spec.md`. The fields are the on-disk
 * schema for `.worktree/**` and the input/output payloads of every HistoryStore
 * call. Do not rename or delete declared fields without bumping
 * HISTORY_SCHEMA_VERSION and providing a migration in HistoryStore.ready().
 */

import type { IRGraph } from '@/core/ir';
import type { Message } from '@/store/types';

/** Top-level schema version. Bump on a breaking on-disk change + migration. */
export const HISTORY_SCHEMA_VERSION = 1;

/** Reserved id for the "no workspace selected" bucket. */
export const UNASSIGNED_WORKSPACE_ID = '__unassigned__';

// ---------- Workspace ----------

export interface WorkspaceRecord {
  /** `sha1(normalizePath(absPath)).slice(0,16)` or `'__unassigned__'`. */
  id: string;
  /** Absolute path, '' for the unassigned bucket only. */
  path: string;
  /** Display name (path basename, falls back to '未指定工作区'). User-editable. */
  name: string;
  createdAt: number;
  updatedAt: number;
  /** Last active session id (auto-restored next launch). */
  lastActiveSessionId?: string;
  /** Maintained by writes; read path does not depend on it. */
  sessionCount: number;
}

/** Light shape stored in `workspaces/index.json` and read by the Sidebar. */
export type WorkspaceSummary = Pick<
  WorkspaceRecord,
  'id' | 'path' | 'name' | 'updatedAt' | 'sessionCount' | 'lastActiveSessionId'
>;

// ---------- Session ----------

export interface SessionRecord {
  id: string;
  workspaceId: string;
  /** Display title — default = first user message[0..24], else '新会话'. */
  title: string;
  /** ⭐ true = workflow session (carries an IRGraph snapshot); false = chat-only. */
  isWorkflow: boolean;
  createdAt: number;
  updatedAt: number;

  /** Full message stream; append-only writes; flushed on every push. */
  messages: Message[];

  /**
   * Only present when isWorkflow is true. Snapshot of the IRGraph at session
   * completion — historical archive, NOT a live mirror of `store.workflow`.
   */
  workflow?: IRGraph;

  /** Extension slot — must stay optional. */
  meta?: SessionMeta;
}

export interface SessionMeta {
  adapter?: 'claude-code' | 'codex' | 'gemini';
  permission?: string;
  model?: string;
  runStatus?: 'idle' | 'running' | 'success' | 'error';
  [k: string]: unknown;
}

/** Light shape stored in `sessions/index.json`; no `messages` / `workflow`. */
export type SessionSummary = Pick<
  SessionRecord,
  'id' | 'workspaceId' | 'title' | 'isWorkflow' | 'createdAt' | 'updatedAt'
> & {
  /** First 80 chars of the last message — sidebar two-line preview. */
  preview?: string;
  messageCount: number;
};

// ---------- Global config ----------

export interface HistoryConfig {
  schemaVersion: number;
  lastActiveWorkspaceId?: string;
  lastActiveSessionId?: string;
  /** Set true once the first-run localStorage migration has run. */
  migratedFromLocalStorage?: boolean;
}

// ---------- Write payloads ----------

export interface SessionCreateInput {
  workspaceId: string;
  title?: string;
  isWorkflow: boolean;
  messages?: Message[];
  /** Required when isWorkflow=true; stored as the initial workflow snapshot. */
  workflow?: IRGraph;
  meta?: SessionMeta;
}

export interface SessionPatch {
  title?: string;
  isWorkflow?: boolean;
  workflow?: IRGraph;
  meta?: Partial<SessionMeta>;
  /** Whole-replace messages (rare — prefer appendMessage). */
  messages?: Message[];
}

export interface WorkspaceUpsertInput {
  /** Absolute path; '' resolves to the '__unassigned__' bucket. */
  path: string;
  /** Optional display-name override. */
  name?: string;
}
