/**
 * CONTRACT: historical-record data shapes.
 *
 * Canonical `History*` types model the target `.ultragamestudio/**` schema. The
 * unprefixed types at the bottom preserve the current runtime-store contract
 * until persistence code migrates from the legacy field names.
 */

import type { IRGraph, IRRunStatus } from '@/core/ir';
import type { RuntimeAdapterId } from '@/lib/adapters';
import type {
  CanvasViewport,
  Message,
  ScheduledTaskConfig,
} from '@/store/types';
import { HISTORY_ERROR_CODES } from './constants';

export {
  BACKUPS_DIR_NAME,
  DEFAULT_WORKSPACE_ID,
  DEFAULT_WORKSPACE_NAME,
  DELETED_DIR_NAME,
  HISTORY_ERROR_CODES,
  HISTORY_ROOT_DIR,
  HISTORY_SCHEMA_VERSION,
  HISTORY_TIMESTAMP_FORMAT,
  LEGACY_SESSION_ID_PATTERN,
  LEGACY_SESSIONS_INDEX_FILE,
  LEGACY_TMP_DIR_NAME,
  LEGACY_WORKSPACE_ID_PATTERN,
  LEGACY_WORKSPACES_INDEX_FILE,
  MIGRATIONS_DIR_NAME,
  MIGRATION_BACKUPS_DIR_NAME,
  MIGRATION_SESSION_ID_PREFIX,
  QUARANTINE_DIR_NAME,
  ROOT_BACKUPS_DIR_NAME,
  ROOT_CONFIG_FILE,
  ROOT_INDEX_FILE,
  SESSION_ID_MAX_LENGTH,
  SESSION_ID_PATTERN,
  SESSION_ID_PREFIX,
  SESSIONS_DIR_NAME,
  SESSIONS_INDEX_FILE,
  TMP_DIR_NAME,
  TRASH_DIR_NAME,
  UNASSIGNED_WORKSPACE_ID,
  UNASSIGNED_WORKSPACE_NAME,
  WORKSPACE_DIR_PREFIX,
  WORKSPACE_FILE,
  WORKSPACE_ID_MAX_LENGTH,
  WORKSPACE_ID_PATTERN,
  WORKSPACES_INDEX_FILE,
  WORKTREE_ROOT_DIR,
} from './constants';

// ---------- Canonical history schema ----------

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;

export interface JsonObject {
  [key: string]: JsonValue | undefined;
}

export type HistoryTimestamp = string;
export type WorkspaceId = string;
export type SessionId = string;

/**
 * Extension slot for persisted history records.
 *
 * Canonical writers should only store JSON-safe values here. The type remains
 * intentionally broad so legacy runtime metadata such as run-error objects can
 * pass through unchanged until repository-level normalization exists.
 */
export interface HistoryMetadata {
  [key: string]: unknown;
}

export interface HistoryMigrationRecord extends JsonObject {
  migrationVersion: number;
  sourceFingerprint: string;
  completedAt?: HistoryTimestamp;
  migrationId?: string;
  sourceKey?: string;
  backupId?: string;
  status?: 'in_progress' | 'applied' | 'rolled_back' | 'conflict' | 'failed';
  createdAt?: HistoryTimestamp;
  appliedAt?: HistoryTimestamp;
}

export interface MessageSummary extends JsonObject {
  count: number;
  lastRole?: Message['role'];
  lastPreview?: string;
  lastAt?: HistoryTimestamp;
  /** Legacy summary alias. */
  preview?: string;
  /** Legacy summary alias. */
  lastMessageAt?: HistoryTimestamp | number;
}

export interface HistoryWorkspaceSummary {
  workspaceId: WorkspaceId;
  displayName: string;
  createdAt: HistoryTimestamp;
  updatedAt: HistoryTimestamp;
  sessionCount: number;
  lastActiveSessionId?: SessionId;
  metadata?: HistoryMetadata;

  /** Legacy read alias for workspaceId. */
  id?: WorkspaceId;
  /** Legacy read alias for displayName. */
  name?: string;
  /** Legacy path field; canonical records use canonicalPath/pathAliases. */
  path?: string;
  /** Legacy display-oriented directory name. */
  directoryName?: string;
}

export interface HistoryWorkspaceRecord extends HistoryWorkspaceSummary {
  schemaVersion: number;
  canonicalPath: string;
  pathAliases: string[];
  status: 'active' | 'deleted' | 'quarantined';
}

export interface HistorySessionSummary {
  workspaceId: WorkspaceId;
  sessionId: SessionId;
  title: string;
  messageSummary: MessageSummary;
  createdAt: HistoryTimestamp;
  updatedAt: HistoryTimestamp;
  isWorkflow: boolean;
  metadata?: HistoryMetadata;

  /** Legacy read alias for sessionId. */
  id?: SessionId;
  /** Legacy sidebar preview alias. */
  preview?: string;
  /** Legacy sidebar count alias. */
  messageCount?: number;
  /** Legacy extension slot. Canonical writers should emit metadata. */
  meta?: SessionMeta;
}

/** Sidebar-ready workspace bucket. Session entries are summaries only. */
export interface WorkspaceHistoryGroup {
  workspaceId: WorkspaceId;
  workspace: HistoryWorkspaceSummary;
  sessions: HistorySessionSummary[];
  metadata?: HistoryMetadata;
}

/** Full payload stored in `<workspaceId>/sessions/<sessionId>.json`. */
export interface HistoryRecord extends HistorySessionSummary {
  schemaVersion: number;
  messages: Message[];
  workflow?: IRGraph;
  sourceFingerprint?: string;
  deletedAt?: HistoryTimestamp;
}

export type HistoryErrorCode = (typeof HISTORY_ERROR_CODES)[number];

export interface HistoryErrorOptions {
  code: HistoryErrorCode;
  message: string;
  recoverable: boolean;
  path?: string;
  entityId?: string;
  details?: HistoryMetadata;
  cause?: unknown;
}

export class HistoryError extends Error {
  readonly code: HistoryErrorCode;
  readonly recoverable: boolean;
  readonly path?: string;
  readonly entityId?: string;
  readonly details?: HistoryMetadata;
  readonly cause?: unknown;

  constructor(options: HistoryErrorOptions) {
    super(options.message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'HistoryError';
    this.code = options.code;
    this.recoverable = options.recoverable;
    this.path = options.path;
    this.entityId = options.entityId;
    this.details = options.details;
    this.cause = options.cause;
  }
}

export type HistoryResult<T> =
  | { ok: true; data: T; warnings?: HistoryError[] }
  | { ok: false; error: HistoryError };

export function isHistoryError(value: unknown): value is HistoryError {
  return value instanceof HistoryError;
}

// ---------- Legacy runtime-store compatibility ----------

export type LegacyHistoryTimestamp = number;

export interface WorkspaceRecord {
  /** `sha1(normalizePath(absPath)).slice(0,16)` or `'__unassigned__'`. */
  id: string;
  /** Absolute path, '' for the unassigned bucket only. */
  path: string;
  /** Display name (path basename, falls back to '未指定工作区'). User-editable. */
  name: string;
  createdAt: LegacyHistoryTimestamp;
  updatedAt: LegacyHistoryTimestamp;
  /** Last active session id (auto-restored next launch). */
  lastActiveSessionId?: string;
  /** Maintained by writes; read path does not depend on it. */
  sessionCount: number;

  // Forward-compatible canonical fields.
  workspaceId?: WorkspaceId;
  displayName?: string;
  canonicalPath?: string;
  pathAliases?: string[];
  status?: HistoryWorkspaceRecord['status'];
  schemaVersion?: number;
  metadata?: HistoryMetadata;
}

/** Light shape stored in the legacy workspace index and read by the Sidebar. */
export type WorkspaceSummary = Pick<
  WorkspaceRecord,
  'id' | 'path' | 'name' | 'updatedAt' | 'sessionCount' | 'lastActiveSessionId'
> & {
  workspaceId?: WorkspaceId;
  displayName?: string;
  metadata?: HistoryMetadata;
};

export interface SessionRecord {
  id: string;
  workspaceId: string;
  /** Display title - default = first user message[0..36], else '新会话'. */
  title: string;
  /** True = workflow session (carries an IRGraph snapshot); false = chat-only. */
  isWorkflow: boolean;
  createdAt: LegacyHistoryTimestamp;
  updatedAt: LegacyHistoryTimestamp;
  messages: Message[];
  workflow?: IRGraph;
  /** Legacy extension slot. Canonical writers use `metadata`. */
  meta?: SessionMeta;

  // Forward-compatible canonical fields.
  sessionId?: SessionId;
  messageSummary?: MessageSummary;
  sourceFingerprint?: string;
  deletedAt?: HistoryTimestamp;
  schemaVersion?: number;
  metadata?: HistoryMetadata;
}

export interface SessionMeta extends HistoryMetadata {
  adapter?: RuntimeAdapterId;
  permission?: string;
  model?: string;
  favorite?: boolean;
  pinned?: boolean;
  scheduledTask?: ScheduledTaskConfig | null;
  canvasViewport?: CanvasViewport | null;
  runStatus?: 'idle' | 'running' | 'success' | 'error' | 'interrupted';
  /** True when the last successful run has not been viewed yet. */
  unreadCompletion?: boolean;
  contextCompressed?: boolean;
  /** Unsent text left in the AI input box for this session (persisted draft). */
  composerDraft?: string;
  runState?: Record<string, IRRunStatus>;
  runOutputs?: Record<string, string>;
  failedNodeId?: string | null;
  runError?: Record<string, unknown> | null;
  migration?: HistoryMigrationRecord;
}

export type CliAdapter = RuntimeAdapterId;
export type CliPlatform = 'windows' | 'macos' | 'linux';

export interface CliLastError {
  code: 'missing' | 'permission-denied' | 'not-executable' | 'spawn-failed';
  message: string;
  checkedAt: string;
}

export interface CliStoredCustomPath {
  adapter: CliAdapter;
  path: string;
  normalizedPath: string;
  platform: CliPlatform;
  addedAt: string;
  lastSeenAt?: string;
  lastError?: CliLastError;
}

export type CliSelection =
  | { kind: 'auto' }
  | {
      kind: 'known';
      adapter: CliAdapter;
      command: 'claude' | 'claude-code' | 'codex' | 'gemini' | string;
      selectedAt: string;
      pathHint?: string;
      platform?: CliPlatform;
    }
  | {
      kind: 'path';
      adapter: CliAdapter;
      path: string;
      normalizedPath: string;
      selectedAt: string;
      platform: CliPlatform;
    };

export interface CliMigrationNotice {
  code:
    | 'legacy-shell-wrapper'
    | 'legacy-unrecognized'
    | 'legacy-path-unavailable';
  raw: string;
  createdAt: string;
}

export interface CliSelectionConfig {
  schemaVersion: 1;
  selected: CliSelection;
  customPaths: CliStoredCustomPath[];
  migrationNotice?: CliMigrationNotice;
}

/** Light shape stored in the legacy session index; no `messages` / `workflow`. */
export type SessionSummary = Pick<
  SessionRecord,
  'id' | 'workspaceId' | 'title' | 'isWorkflow' | 'createdAt' | 'updatedAt'
> & {
  /** True when the workflow snapshot is a "simple workflow" (meta.simple). */
  simple?: boolean;
  /** First 80 chars of the last message - sidebar two-line preview. */
  preview?: string;
  messageCount: number;
  /** Derived from meta.runStatus for lightweight history status badges. */
  runStatus?: SessionMeta['runStatus'];
  /** Derived from meta.unreadCompletion for the "unviewed completion" badge. */
  unreadCompletion?: boolean;
  contextCompressed?: boolean;
  /** Derived from meta.favorite for lightweight favorite-tab rendering. */
  favorite?: boolean;
  pinned?: boolean;
  /** Derived from meta.scheduledTask for lightweight schedule rendering. */
  scheduledTask?: ScheduledTaskConfig;
  /** Internal migration marker for completion-time based ordering. */
  activityVersion?: number;

  // Forward-compatible canonical fields.
  sessionId?: SessionId;
  messageSummary?: MessageSummary;
  metadata?: HistoryMetadata;
};

export type CcSwitchAutoImportStatus =
  | 'imported'
  | 'no-source'
  | 'empty'
  | 'failed';

export interface CcSwitchAutoImportRecord {
  version: 1;
  attemptedAt: string;
  status: CcSwitchAutoImportStatus;
  importedCount?: number;
  reason?: string;
}

export interface HistoryConfig {
  schemaVersion: number;
  lastActiveWorkspaceId?: string;
  lastActiveSessionId?: string;
  cli?: CliSelectionConfig;
  /** Legacy CLI selection aliases; read-only compatibility path. */
  selectedCli?: unknown;
  cliPath?: unknown;
  cliCommand?: unknown;
  commandPath?: unknown;
  cliAdapter?: unknown;
  /** Set true once the first-run localStorage migration has run. */
  migratedFromLocalStorage?: boolean;
  /** One-shot marker for the first-run cc-switch provider import. */
  ccSwitchAutoImport?: CcSwitchAutoImportRecord;
  migrationVersion?: number;
  migrations?: HistoryMigrationRecord[];
  metadata?: HistoryMetadata;
}

export interface SessionCreateInput {
  workspaceId: string;
  /**
   * Optional client-supplied id. Lets the UI switch to a new session
   * optimistically and persist with the same id, avoiding an id swap / flicker.
   */
  id?: string;
  title?: string;
  isWorkflow: boolean;
  messages?: Message[];
  /** Required when isWorkflow=true; stored as the initial workflow snapshot. */
  workflow?: IRGraph;
  meta?: SessionMeta;
  metadata?: HistoryMetadata;
}

export interface SessionPatch {
  title?: string;
  isWorkflow?: boolean;
  workflow?: IRGraph;
  meta?: Partial<SessionMeta>;
  metadata?: HistoryMetadata;
  /** Preserve history ordering for metadata-only updates such as favorites. */
  preserveUpdatedAt?: boolean;
  /** Whole-replace messages (rare - prefer appendMessage). */
  messages?: Message[];
  /** Merge an asynchronous chat snapshot inside the history write queue. */
  mergeMessages?: boolean;
}

export interface WorkspaceUpsertInput {
  /** Absolute path; '' resolves to the default workspace bucket. */
  path: string;
  /** Optional display-name override. */
  name?: string;
  metadata?: HistoryMetadata;
}
