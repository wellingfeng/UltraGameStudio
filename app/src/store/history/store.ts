import { isSupportedWorkspacePath } from '@/lib/cloudProjects';
import { SCHEDULED_TASK_SCOPE, SCHEDULED_TASK_HISTORY_DIR } from '@/lib/scheduledTaskScope';
import { setStartUserInputs } from '@/core/startInputs';
import { retainScheduledTaskMessages } from '@/lib/scheduledTaskRetention';
import { sessionHasContextCompression } from '@/lib/contextCompression';
import type { IRGraph } from '@/core/ir';
import { loadComposer } from '@/lib/composerStorage';
import { UGS_STORAGE_KEY } from '@/lib/persist';
import { tauriAvailable } from '@/lib/tauri';
import type { Message } from '@/store/types';
import { runMetaFromSnapshot, workflowWithRunSnapshot } from '../runSnapshot';
import { PersistenceQueue } from './persistenceQueue';
import { serializeHistory } from './serialization';
import { sessionDelta } from './sessionDelta';
import { estimateRetainedHistoryBytes } from './payloadBudget';
import { hydrateSessionPayload, splitSessionPayload } from './chunkedSession';
import {
  deriveWorkspaceId,
  isWorkspaceId,
  normalizeWorkspaceIdentityPath,
  workspaceIdentityHashInput,
  workspaceLeafName,
} from './paths';
import {
  DEFAULT_WORKSPACE_ID,
  HISTORY_SCHEMA_VERSION,
  UNASSIGNED_WORKSPACE_ID,
  type HistoryConfig,
  type SessionCreateInput,
  type SessionOrigin,
  type SessionFinalReconciliation,
  type SessionConditionalWriteResult,
  type SessionPatch,
  type SessionRecord,
  type SessionSummary,
  type WorkspaceRecord,
  type WorkspaceSummary,
  type WorkspaceUpsertInput,
} from './types';

export interface HistoryStore {
  ready(): Promise<void>;
  /** Drain accepted writes and propagate any unobserved durability failure. */
  flush(): Promise<void>;
  rootPath(): Promise<string>;

  getConfig(): Promise<HistoryConfig>;
  patchConfig(patch: Partial<HistoryConfig>): Promise<HistoryConfig>;

  listWorkspaces(): Promise<WorkspaceSummary[]>;
  getWorkspace(id: string): Promise<WorkspaceRecord | null>;
  resolveWorkspaceByPath(path: string): Promise<WorkspaceRecord>;
  renameWorkspace(id: string, name: string): Promise<WorkspaceRecord>;
  patchWorkspaceMetadata(
    id: string,
    patch: WorkspaceRecord['metadata'],
  ): Promise<WorkspaceRecord>;
  deleteWorkspace(id: string, soft?: boolean): Promise<void>;

  listSessions(workspaceId: string): Promise<SessionSummary[]>;
  getSession(
    workspaceId: string,
    sessionId: string,
  ): Promise<SessionRecord | null>;
  /** Restore a draft without hydrating the transcript or populating its cache. */
  getSessionComposerDraft(workspaceId: string, sessionId: string): Promise<string | undefined>;
  /** Backing identity read: missing is null; unknown/unreadable rejects. */
  getSessionForGeneration(workspaceId: string, sessionId: string): Promise<SessionRecord | null>;
  createSession(input: SessionCreateInput): Promise<SessionRecord>;
  updateSession(
    workspaceId: string,
    sessionId: string,
    patch: SessionPatch,
  ): Promise<SessionRecord>;
  /** null retires a deleted/replaced target; rejection retains the obligation. */
  updateSessionIfGeneration(
    workspaceId: string,
    sessionId: string,
    origin: SessionOrigin,
    patch: SessionPatch,
    reconciliation?: SessionFinalReconciliation,
  ): Promise<SessionConditionalWriteResult | null>;
  pruneScheduledTaskHistory(workspaceId: string, sessionId: string, protectedMessageIds?: () => ReadonlySet<string>): Promise<{ record: SessionRecord; removedIds: string[]; backupError?: unknown } | null>;
  clearScheduledTaskHistory(workspaceId: string, sessionId: string, extraMessageIds: string[]): Promise<{ record: SessionRecord; removedIds: string[]; backupError?: unknown }>;
  deleteSession(
    workspaceId: string,
    sessionId: string,
    soft?: boolean,
  ): Promise<void>;

  appendMessage(
    workspaceId: string,
    sessionId: string,
    msg: Message,
  ): Promise<void>;
  upsertMessage(
    workspaceId: string,
    sessionId: string,
    msg: Message,
    preserveUpdatedAt?: boolean,
  ): Promise<void>;
  setSessionWorkflow(
    workspaceId: string,
    sessionId: string,
    ir: IRGraph,
  ): Promise<void>;
}

const CONFIG_PATH = 'config.json';
const WORKSPACES_INDEX = 'workspaces/index.json';
const FALLBACK_PREFIX = 'ultragamestudio.history.v1:';
const SESSION_RECORD_CACHE_LIMIT = 5;
const SESSION_RECORD_PREWARM_LIMIT = 5;
const SESSION_SUMMARY_ACTIVITY_VERSION = 3;

const writeQueue = new PersistenceQueue();
// Session payload I/O is concurrent; all read/modify/write index transactions
// still share one lane. Global maintenance waits for the session queue first.
let metadataQueue: Promise<unknown> = Promise.resolve();
function enqueueMetadata<T>(fn: () => Promise<T>): Promise<T> {
  const run = metadataQueue.then(fn, fn);
  metadataQueue = run.then(() => undefined, () => undefined);
  return run;
}
const sessionRecordCache = new Map<string, Map<string, SessionRecord>>();
const scheduledTaskRemovedMessages = new Map<string, Set<string>>();
const sessionPrewarmTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Declare ALL payload retained by closures; undefined is not a cost bypass. */
function enqueue<T>(fn: () => Promise<T>, retained: unknown, allowChunked = false): Promise<T> {
  return writeQueue.enqueue(fn, retained, undefined, undefined, allowChunked);
}

function mergeCheckpoints(previous: SessionPatch, incoming: SessionPatch): SessionPatch | null {
  if (!previous.streamCheckpoint || !incoming.streamCheckpoint ||
      !!previous.mergeMessages !== !!incoming.mergeMessages ||
      !!previous.preserveUpdatedAt !== !!incoming.preserveUpdatedAt) return null;
  return {
    ...previous, ...Object.fromEntries(Object.entries(incoming).filter(([, value]) => value !== undefined)),
    ...(previous.isWorkflow || incoming.isWorkflow ? { isWorkflow: true } : {}),
    ...(previous.messages && incoming.messages && incoming.mergeMessages
      ? { messages: mergePersistedMessages(previous.messages, incoming.messages) } : {}),
    ...(previous.meta || incoming.meta ? { meta: { ...previous.meta, ...incoming.meta } } : {}),
    ...(previous.metadata || incoming.metadata ? { metadata: { ...previous.metadata, ...incoming.metadata } } : {}),
  };
}

async function getInvoke() {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke;
}

async function command<T>(
  name: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const invoke = await getInvoke();
  return invoke<T>(name, args);
}

function hasLocalStorage(): boolean {
  try {
    return typeof window !== 'undefined' && !!window.localStorage;
  } catch {
    return false;
  }
}

function localGet(key: string): string | null {
  if (!hasLocalStorage()) return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function localSet(key: string, value: string): void {
  if (!hasLocalStorage()) throw new Error('HISTORY_STORAGE_UNAVAILABLE');
  window.localStorage.setItem(key, value);
}

function localRemovePath(relPath: string): void {
  if (!hasLocalStorage()) return;
  const exactKey = FALLBACK_PREFIX + relPath;
  const childPrefix = `${exactKey}/`;
  try {
    const keys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (key === exactKey || key?.startsWith(childPrefix)) {
        keys.push(key);
      }
    }
    keys.forEach((key) => window.localStorage.removeItem(key));
  } catch {
    /* non-fatal */
  }
}

function localListDir(relPath: string): string[] {
  if (!hasLocalStorage()) return [];
  const prefix = relPath ? `${FALLBACK_PREFIX + relPath}/` : FALLBACK_PREFIX;
  const out = new Set<string>();
  try {
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (!key?.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (!rest) continue;
      out.add(rest.split('/')[0]);
    }
  } catch {
    /* non-fatal */
  }
  return [...out].sort();
}

async function readJson<T>(relPath: string, authoritative = false, skipLargeSession = false, draftOnly = false): Promise<T | null> {
  const localRead = (): string | null => {
    if (!authoritative) return localGet(FALLBACK_PREFIX + relPath);
    if (!hasLocalStorage()) throw new Error('HISTORY_STORAGE_UNAVAILABLE');
    return window.localStorage.getItem(FALLBACK_PREFIX + relPath);
  };
  const raw = tauriAvailable()
    ? await command<string | null>('history_read_json', { relPath })
    : localRead();
  if (authoritative ? raw === null : !raw) return null;
  // The sidebar may prewarm recent sessions, but loading megabytes of legacy
  // text (or every referenced chunk) must wait until the session is opened.
  if (skipLargeSession && raw!.length > 256 * 1024) return null;
  let value: T;
  try {
    value = JSON.parse(raw!) as T;
    if (authoritative && value === null) throw new Error('HISTORY_SESSION_INVALID');
  } catch (error) {
    if (authoritative) throw error;
    return null;
  }
  const session = /^(?:workspaces\/[^/]+\/sessions|scheduled-tasks\/sessions)\/[^/]+\.json$/.test(relPath) && !relPath.endsWith('/index.json');
  if (skipLargeSession && session && value && typeof value === 'object' && (value as Record<string, unknown>).__ugsHistoryChunkVersion === 1) return null;
  if (!session) return value;
  const hydrate = <U,>(input: U) => hydrateSessionPayload(input, relPath, (path) => readJson(path, true), undefined,
    tauriAvailable() ? async (paths) => {
      const chunks = await command<(string | null)[]>('history_read_chunks', { relPaths: paths });
      if (!Array.isArray(chunks)) throw new Error('HISTORY_CHUNK_CORRUPT');
      return chunks.map((chunk) => chunk === null ? null : JSON.parse(chunk));
    } : undefined);
  if (draftOnly && value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const meta = record.meta && typeof record.meta === 'object' ? record.meta as Record<string, unknown> : {};
    const selected = await hydrate({
      ...(record.__ugsHistoryChunkVersion === 1 ? { __ugsHistoryChunkVersion: 1 } : {}),
      draft: meta.composerDraft,
    });
    return { meta: { composerDraft: selected.draft } } as T;
  }
  return hydrate(value);
}

/** Only a missing backing object is null; unreadable/malformed is unknown. */
async function readSessionForGeneration(workspaceId: string, sessionId: string): Promise<SessionRecord | null> {
  const record = await readJson<SessionRecord>(sessionPath(workspaceId, sessionId), true);
  if (record === null) return null;
  if (!record || typeof record !== 'object' || Array.isArray(record) ||
      typeof record.id !== 'string' || typeof record.workspaceId !== 'string' ||
      !Number.isFinite(record.createdAt) || !Array.isArray(record.messages)) {
    throw new Error('HISTORY_SESSION_INVALID');
  }
  return record;
}

// `JSON.stringify` faithfully serializes lone (unpaired) UTF-16 surrogates as
// `\udXXX` escapes — they slip in when a string is truncated mid-emoji, which
// is common in streamed/pasted model output. Browser `JSON.parse` tolerates
// them, but the Rust backend's serde validator rejects the escape with
// "unexpected end of hex escape", which aborts the whole history load. Replace
// any unpaired surrogate with U+FFFD so every payload round-trips cleanly.
async function writeJson(relPath: string, value: unknown, streamCheckpoint = false): Promise<void> {
  await serializeHistory(value, { relPath, onSerialized: async (json) => {
    if (tauriAvailable()) {
      await command<void>('history_write_json', { relPath, json, streamCheckpoint });
      return;
    }
    localSet(FALLBACK_PREFIX + relPath, json);
  } });
}

async function removePath(relPath: string, soft = true): Promise<void> {
  if (tauriAvailable()) {
    await command<void>('history_remove', { relPath, soft });
    return;
  }
  localRemovePath(relPath);
}

async function listDir(relPath: string): Promise<string[]> {
  if (tauriAvailable()) {
    return command<string[]>('history_list_dir', { relPath });
  }
  return localListDir(relPath);
}

function now(): number {
  return Date.now();
}

function randomId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `s_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
}

function normalizePath(input: string): string {
  return normalizeWorkspaceIdentityPath(input);
}

async function workspaceIdForPath(path: string): Promise<string> {
  const normalized = normalizePath(path);
  if (!normalized) return UNASSIGNED_WORKSPACE_ID;
  return deriveWorkspaceId(normalized);
}

function workspaceName(path: string): string {
  const normalized = normalizePath(path);
  if (!normalized) return '未指定工作区';
  return workspaceLeafName(normalized) || '未指定工作区';
}

function workspaceMetaPath(id: string): string {
  return `workspaces/${id}/meta.json`;
}

function sessionIndexPath(workspaceId: string): string {
  return `${sessionDirectory(workspaceId)}/index.json`;
}

function sessionPath(workspaceId: string, sessionId: string): string {
  return `${sessionDirectory(workspaceId)}/${sessionId}.json`;
}

function sessionDirectory(workspaceId: string): string {
  return workspaceId === SCHEDULED_TASK_SCOPE
    ? `${SCHEDULED_TASK_HISTORY_DIR}/sessions`
    : `workspaces/${workspaceId}/sessions`;
}

function sessionCacheForWorkspace(
  workspaceId: string,
): Map<string, SessionRecord> {
  let cache = sessionRecordCache.get(workspaceId);
  if (!cache) {
    cache = new Map();
    sessionRecordCache.set(workspaceId, cache);
  }
  return cache;
}

function cachedSessionRecord(
  workspaceId: string,
  sessionId: string,
): SessionRecord | null {
  const cache = sessionRecordCache.get(workspaceId);
  const record = cache?.get(sessionId);
  if (!record || !cache) return null;
  cache.delete(sessionId);
  cache.set(sessionId, record);
  return record;
}

function rememberSessionRecord(record: SessionRecord): SessionRecord {
  const cache = sessionCacheForWorkspace(record.workspaceId);
  cache.delete(record.id);
  cache.set(record.id, record);
  while (cache.size > SESSION_RECORD_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (!oldest) break;
    cache.delete(oldest);
  }
  return record;
}

function forgetSessionRecord(workspaceId: string, sessionId: string): void {
  const cache = sessionRecordCache.get(workspaceId);
  if (!cache) return;
  cache.delete(sessionId);
  if (cache.size === 0) sessionRecordCache.delete(workspaceId);
}

function forgetWorkspaceSessionRecords(workspaceId: string): void {
  sessionRecordCache.delete(workspaceId);
  const timer = sessionPrewarmTimers.get(workspaceId);
  if (timer) clearTimeout(timer);
  sessionPrewarmTimers.delete(workspaceId);
}

function clearSessionRecordCache(): void {
  for (const timer of sessionPrewarmTimers.values()) clearTimeout(timer);
  sessionPrewarmTimers.clear();
  sessionRecordCache.clear();
}

async function prewarmRecentSessionRecords(
  workspaceId: string,
  sessions: SessionSummary[],
): Promise<void> {
  for (const summary of sessions.slice(0, SESSION_RECORD_PREWARM_LIMIT)) {
    if (cachedSessionRecord(workspaceId, summary.id)) continue;
    const record = await readJson<SessionRecord>(
      sessionPath(workspaceId, summary.id), false, true,
    );
    if (record) rememberSessionRecord(record);
  }
}

function scheduleRecentSessionPrewarm(
  workspaceId: string,
  sessions: SessionSummary[],
): void {
  const recent = sessions.slice(0, SESSION_RECORD_PREWARM_LIMIT);
  if (recent.length === 0) return;
  const existing = sessionPrewarmTimers.get(workspaceId);
  if (existing) clearTimeout(existing);
  sessionPrewarmTimers.set(
    workspaceId,
    setTimeout(async () => {
      sessionPrewarmTimers.delete(workspaceId);
      try {
        await enqueue(() => prewarmRecentSessionRecords(workspaceId, recent), { workspaceId, recent });
      } catch {
        /* non-fatal */
      }
    }, 0),
  );
}

function preview(messages: Message[]): string | undefined {
  const text = messages[messages.length - 1]?.text?.trim();
  if (!text) return undefined;
  return text.length > 80 ? `${text.slice(0, 80)}...` : text;
}

const AUTO_TITLE_PLACEHOLDERS = new Set([
  '新会话',
  'New Session',
  'Nueva sesión',
  'Nouvelle session',
  'Новая сессия',
  'جلسة جديدة',
  'नया सत्र',
  '新規セッション',
  'Nova sessão',
  'Neue Sitzung',
  '새 세션',
  '未命名会话',
  'Untitled Session',
  'Sesion sin titulo',
  'Session sans titre',
  'Безымянная сессия',
  'جلسة بلا عنوان',
  'शीर्षक रहित सत्र',
  '無題のセッション',
  'Sessao sem titulo',
  'Unbenannte Sitzung',
  '제목 없는 세션',
  '新建工作流',
  'New Workflow',
  '未命名工作流',
  '未命名的工作流',
  'Untitled Workflow',
  'Untitled workflow',
  'untitled',
]);

export function isAutoTitlePlaceholder(title?: string | null): boolean {
  const compact = title?.trim();
  return !compact || AUTO_TITLE_PLACEHOLDERS.has(compact);
}

export function titleFromText(text: string, fallback = '新会话'): string {
  const compact = text
    .replace(
      /`(?:file:\/\/\/)?[a-z]:[\\/][^`]+`/gi,
      ' ',
    )
    .replace(
      /(?:file:\/\/\/)?[a-z]:[\\/][^\s`"'<>，。！？；：、,;:!?]+/gi,
      ' ',
    )
    .trim()
    .replace(
      /^[\s`"'“”‘’「」『』《》【】[\]({（,，。;；:：、!！?？-]+/,
      '',
    )
    .replace(/\s+/g, ' ');
  if (!compact) return fallback;
  return compact.length > 36 ? `${compact.slice(0, 36)}...` : compact;
}

function titleFromMessages(messages: Message[], fallback = '新会话'): string {
  const user = messages.find((m) => m.role === 'user' && m.text.trim());
  if (!user) return fallback;
  return titleFromText(user.text, fallback);
}

function workspaceSummary(record: WorkspaceRecord): WorkspaceSummary {
  return {
    id: record.id,
    path: record.path,
    name: record.name,
    updatedAt: record.updatedAt,
    sessionCount: record.sessionCount,
    lastActiveSessionId: record.lastActiveSessionId,
    metadata: record.metadata,
  };
}

function sessionSummary(record: SessionRecord): SessionSummary {
  const runStatus = record.meta?.runStatus;
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    title: record.title,
    isWorkflow: record.isWorkflow,
    createdAt: record.createdAt,
    updatedAt: sessionCompletionTimestamp(record.messages, record.updatedAt),
    activityVersion: SESSION_SUMMARY_ACTIVITY_VERSION,
    preview: preview(record.messages),
    messageCount: record.messages.length,
    ...(record.workflow?.meta?.simple ? { simple: true } : {}),
    ...(runStatus ? { runStatus } : {}),
    ...(record.meta?.unreadCompletion === true ? { unreadCompletion: true } : {}),
    ...(sessionHasContextCompression(record.messages, record.meta) ? { contextCompressed: true } : {}),
    ...(record.meta?.favorite === true ? { favorite: true } : {}),
    ...(record.meta?.pinned === true ? { pinned: true } : {}),
    ...(record.meta?.scheduledTask
      ? { scheduledTask: record.meta.scheduledTask }
      : {}),
  };
}

async function readConfigInternal(): Promise<HistoryConfig | null> {
  return readJson<HistoryConfig>(CONFIG_PATH);
}

async function writeConfigInternal(config: HistoryConfig): Promise<void> {
  await writeJson(CONFIG_PATH, config);
}

async function getConfigInternal(): Promise<HistoryConfig> {
  return (
    (await readConfigInternal()) ?? {
      schemaVersion: HISTORY_SCHEMA_VERSION,
    }
  );
}

async function readWorkspaceIndexInternal(): Promise<WorkspaceSummary[]> {
  return (await readJson<WorkspaceSummary[]>(WORKSPACES_INDEX)) ?? [];
}

async function listWorkspaceDirectoryIdsInternal(): Promise<string[]> {
  return (await listDir('workspaces')).filter(
    (name) => !name.endsWith('.json') && isWorkspaceId(name),
  );
}

function sortWorkspaces(records: WorkspaceSummary[]): WorkspaceSummary[] {
  return [...records].sort((a, b) => b.updatedAt - a.updatedAt);
}

function sortSessions(records: SessionSummary[]): SessionSummary[] {
  return [...records].sort((a, b) => b.updatedAt - a.updatedAt);
}

function sessionFileIdFromName(name: string): string | null {
  if (!name.endsWith('.json') || name === 'index.json') return null;
  return name.slice(0, -'.json'.length);
}

async function listSessionFileIdsInternal(workspaceId: string): Promise<string[]> {
  const fileNames = await listDir(sessionDirectory(workspaceId));
  return fileNames
    .map(sessionFileIdFromName)
    .filter((id): id is string => id != null);
}

function sessionIndexMatchesFiles(
  index: SessionSummary[],
  fileIds: string[],
): boolean {
  if (index.length !== fileIds.length) return false;
  const indexed = new Set(index.map((session) => session.id));
  return fileIds.every((id) => indexed.has(id));
}

function sessionIndexHasCurrentActivityVersion(
  index: SessionSummary[],
): boolean {
  return index.every(
    (session) => session.activityVersion === SESSION_SUMMARY_ACTIVITY_VERSION,
  );
}

async function readSessionIndexInternal(
  workspaceId: string,
): Promise<SessionSummary[] | null> {
  const list = await readJson<unknown>(sessionIndexPath(workspaceId));
  return Array.isArray(list) ? sortSessions(list as SessionSummary[]) : null;
}

function finiteTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

const LEGACY_TURN_CLOCK_RE =
  /^⏱\s*\d{1,2}:\d{2}(?::\d{2})?\s*→\s*(\d{1,2}):(\d{2})(?::(\d{2}))?/u;
const DAY_MS = 86_400_000;

function clockTimestampOnMessageDate(
  messageCreatedAt: number,
  hour: number,
  minute: number,
  second: number,
): number | null {
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  if (second < 0 || second > 59) return null;
  const end = new Date(messageCreatedAt);
  end.setHours(hour, minute, second, 0);
  let timestamp = end.getTime();
  if (timestamp < messageCreatedAt - 60_000) timestamp += DAY_MS;
  return timestamp;
}

function legacyAssistantCompletedTimestamp(message: Message): number | null {
  if (message.role !== 'assistant') return null;
  if (!finiteTimestamp(message.createdAt)) return null;
  const match = message.text.match(LEGACY_TURN_CLOCK_RE);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = match[3] ? Number(match[3]) : 0;
  return clockTimestampOnMessageDate(message.createdAt, hour, minute, second);
}

function messageCompletedTimestamp(message: Message): number | null {
  if (finiteTimestamp(message.completedAt)) return message.completedAt;
  return legacyAssistantCompletedTimestamp(message);
}

function messagesCompletedTimestamp(messages: Message[]): number | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const timestamp = messageCompletedTimestamp(messages[i]);
    if (timestamp != null) return timestamp;
  }
  return null;
}

function sessionCompletionTimestamp(
  messages: Message[],
  fallback: number,
): number {
  return messagesCompletedTimestamp(messages) ?? fallback;
}

function minTimestamp(values: number[], fallback: number): number {
  return values.length > 0 ? Math.min(...values) : fallback;
}

function maxTimestamp(values: number[], fallback: number): number {
  return values.length > 0 ? Math.max(...values) : fallback;
}

function workspacePathIdentity(path: string): string {
  const normalized = normalizePath(path);
  return normalized ? workspaceIdentityHashInput(normalized) : '';
}

function isDefaultWorkspaceAlias(id: string): boolean {
  return id === DEFAULT_WORKSPACE_ID || id === UNASSIGNED_WORKSPACE_ID;
}

async function listWorkspacesInternal(): Promise<WorkspaceSummary[]> {
  return sortWorkspaces(await readWorkspaceIndexInternal());
}

async function writeWorkspaceIndexInternal(
  records: WorkspaceSummary[],
): Promise<void> {
  await writeJson(
    WORKSPACES_INDEX,
    sortWorkspaces(records),
  );
}

async function getWorkspaceInternal(
  id: string,
): Promise<WorkspaceRecord | null> {
  return readJson<WorkspaceRecord>(workspaceMetaPath(id));
}

function fallbackWorkspaceRecord(
  summary: WorkspaceSummary,
  normalizedPath: string,
): WorkspaceRecord {
  const ts = finiteTimestamp(summary.updatedAt) ? summary.updatedAt : now();
  return {
    id: summary.id,
    path: normalizedPath,
    name: summary.name || workspaceName(normalizedPath),
    createdAt: ts,
    updatedAt: ts,
    lastActiveSessionId: summary.lastActiveSessionId,
    sessionCount: finiteTimestamp(summary.sessionCount)
      ? summary.sessionCount
      : 0,
  };
}

async function writeWorkspaceInternal(
  record: WorkspaceRecord,
): Promise<WorkspaceRecord> {
  await writeJson(workspaceMetaPath(record.id), record);
  const current = await listWorkspacesInternal();
  const next = [
    workspaceSummary(record),
    ...current.filter((w) => w.id !== record.id),
  ];
  await writeWorkspaceIndexInternal(next);
  return record;
}

interface WorkspaceMergeGroup {
  canonicalId: string;
  normalizedPath: string;
  identityKey: string;
  summaries: WorkspaceSummary[];
}

interface SessionMergeItem {
  summary: SessionSummary;
  record?: SessionRecord;
}

async function shouldRebuildWorkspaceIndexFromFilesInternal(
  workspaceId: string,
): Promise<boolean> {
  if (!isDefaultWorkspaceAlias(workspaceId)) return true;
  const workspace = await getWorkspaceInternal(workspaceId);
  return !workspace || !normalizePath(workspace.path);
}

async function readSessionRecordsFromWorkspaceDirectoryInternal(
  workspaceId: string,
  allowedWorkspaceIds = new Set([workspaceId]),
): Promise<SessionRecord[]> {
  const sessionIds = await listSessionFileIdsInternal(workspaceId);
  return (
    await Promise.all(
      sessionIds.map((sessionId) => getSessionInternal(workspaceId, sessionId)),
    )
  ).filter(
    (record): record is SessionRecord =>
      record != null && allowedWorkspaceIds.has(record.workspaceId),
  );
}

async function workspaceMergeIdentity(
  summary: WorkspaceSummary,
): Promise<{
  canonicalId: string;
  normalizedPath: string;
  identityKey: string;
}> {
  const normalizedPath = normalizePath(summary.path ?? '');
  if (!normalizedPath) {
    return {
      canonicalId: summary.id,
      normalizedPath,
      identityKey: `id:${summary.id}`,
    };
  }
  const canonicalId = await workspaceIdForPath(normalizedPath);
  return {
    canonicalId,
    normalizedPath,
    identityKey: normalizedPath
      ? workspaceIdentityHashInput(normalizedPath)
      : canonicalId,
  };
}

async function readWorkspaceSessionsForMergeInternal(
  sourceWorkspaceId: string,
  targetWorkspaceId: string,
): Promise<SessionMergeItem[]> {
  const summaries = await listSessionsInternal(sourceWorkspaceId);
  return Promise.all(
    summaries.map(async (summary) => {
      const record = await getSessionInternal(sourceWorkspaceId, summary.id);
      if (!record) {
        return {
          summary: {
            ...summary,
            workspaceId: targetWorkspaceId,
          },
        };
      }
      const nextRecord: SessionRecord = {
        ...record,
        workspaceId: targetWorkspaceId,
      };
      return {
        summary: sessionSummary(nextRecord),
        record: nextRecord,
      };
    }),
  );
}

async function workspaceSummaryUsesDirectoryAsSource(
  group: WorkspaceMergeGroup,
  summary: WorkspaceSummary,
): Promise<boolean> {
  if (summary.id === group.canonicalId) return true;
  if (!group.normalizedPath) return summary.id === group.canonicalId;

  const summaryIdentity = workspacePathIdentity(summary.path ?? '');
  const record = await getWorkspaceInternal(summary.id);
  const recordIdentity = record ? workspacePathIdentity(record.path) : '';
  if (recordIdentity) return recordIdentity === group.identityKey;
  if (isDefaultWorkspaceAlias(summary.id) && summaryIdentity) return false;
  return summaryIdentity === group.identityKey;
}

async function rebuildWorkspaceSessionIndexFromFilesInternal(
  workspaceId: string,
  force = false,
): Promise<SessionSummary[]> {
  const list =
    (await readJson<SessionSummary[]>(sessionIndexPath(workspaceId))) ?? [];
  if (!force && !(await shouldRebuildWorkspaceIndexFromFilesInternal(workspaceId))) {
    return sortSessions(list);
  }

  const records =
    await readSessionRecordsFromWorkspaceDirectoryInternal(workspaceId);
  const rebuilt = sortSessions(records.map((record) => sessionSummary(record)));
  await writeSessionIndexInternal(workspaceId, rebuilt);
  const workspace = await getWorkspaceInternal(workspaceId);
  if (workspace) {
    await writeWorkspaceInternal({
      ...workspace,
      sessionCount: rebuilt.length,
      updatedAt: maxTimestamp(
        [workspace.updatedAt, ...rebuilt.map((session) => session.updatedAt)].filter(
          finiteTimestamp,
        ),
        workspace.updatedAt,
      ),
    });
  }
  return rebuilt;
}

async function rebuildAllWorkspaceSessionIndexesInternal(): Promise<void> {
  const workspaces = await readWorkspaceIndexInternal();
  const directoryIds = await listWorkspaceDirectoryIdsInternal();
  const workspaceIds = new Set([
    ...workspaces.map((workspace) => workspace.id),
    ...directoryIds,
  ]);
  for (const workspaceId of workspaceIds) {
    await rebuildWorkspaceSessionIndexFromFilesInternal(workspaceId);
  }
}

async function readRecoverableWorkspaceIndexInternal(): Promise<
  WorkspaceSummary[]
> {
  const raw = await readWorkspaceIndexInternal();
  const recovered = [...raw];
  const seen = new Set(
    raw.map(
      (workspace) => `${workspace.id}\u0000${workspacePathIdentity(workspace.path ?? '')}`,
    ),
  );
  const directoryIds = await listWorkspaceDirectoryIdsInternal();

  for (const workspaceId of directoryIds) {
    const workspace = await getWorkspaceInternal(workspaceId);
    if (workspace) {
      const summary = workspaceSummary(workspace);
      const key = `${summary.id}\u0000${workspacePathIdentity(summary.path ?? '')}`;
      if (!seen.has(key)) {
        recovered.push(summary);
        seen.add(key);
      }
      continue;
    }

    const sessions = await listSessionsInternal(workspaceId);
    if (sessions.length === 0) continue;
    const updatedAt = maxTimestamp(
      sessions.map((session) => session.updatedAt).filter(finiteTimestamp),
      now(),
    );
    const summary: WorkspaceSummary = {
      id: workspaceId,
      path: '',
      name: workspaceName(''),
      updatedAt,
      sessionCount: sessions.length,
      lastActiveSessionId: sessions[0]?.id,
    };
    const key = `${summary.id}\u0000`;
    if (!seen.has(key)) {
      recovered.push(summary);
      seen.add(key);
    }
  }

  return recovered;
}

function mergeSessionItems(items: SessionMergeItem[]): SessionMergeItem[] {
  const byId = new Map<string, SessionMergeItem>();
  for (const item of items) {
    const existing = byId.get(item.summary.id);
    if (!existing || item.summary.updatedAt >= existing.summary.updatedAt) {
      byId.set(item.summary.id, item);
    }
  }
  return sortSessions([...byId.values()].map((item) => item.summary)).map(
    (summary) => byId.get(summary.id) ?? { summary },
  );
}

async function mergeWorkspaceGroupInternal(
  group: WorkspaceMergeGroup,
): Promise<WorkspaceRecord> {
  const trustedSummaries = (
    await Promise.all(
      group.summaries.map(async (summary) => ({
        summary,
        trusted: await workspaceSummaryUsesDirectoryAsSource(group, summary),
      })),
    )
  )
    .filter((item) => item.trusted)
    .map((item) => item.summary);
  const sourceIds = Array.from(
    new Set([
      ...trustedSummaries.map((summary) => summary.id),
      group.canonicalId,
    ]),
  );
  const sourceRecords = (
    await Promise.all(
      sourceIds.map(async (id) => {
        const record = await getWorkspaceInternal(id);
        if (record) return record;
        const summary = trustedSummaries.find((item) => item.id === id);
        return summary
          ? fallbackWorkspaceRecord(summary, group.normalizedPath)
          : null;
      }),
    )
  ).filter((record): record is WorkspaceRecord => record != null);
  const targetRecord =
    sourceRecords.find((record) => record.id === group.canonicalId) ??
    (await getWorkspaceInternal(group.canonicalId));
  const newestRecord = [...sourceRecords].sort(
    (a, b) => b.updatedAt - a.updatedAt,
  )[0];
  const sessionItems = mergeSessionItems(
    (
      await Promise.all(
        sourceIds.map((sourceId) =>
          readWorkspaceSessionsForMergeInternal(sourceId, group.canonicalId),
        ),
      )
    ).flat(),
  );
  const sessions = sessionItems.map((item) => item.summary);
  const sessionIds = new Set(sessions.map((session) => session.id));
  const lastActiveSessionId =
    (targetRecord?.lastActiveSessionId &&
    sessionIds.has(targetRecord.lastActiveSessionId)
      ? targetRecord.lastActiveSessionId
      : undefined) ??
    sourceRecords.find(
      (record) =>
        record.lastActiveSessionId &&
        sessionIds.has(record.lastActiveSessionId),
    )?.lastActiveSessionId ??
    sessions[0]?.id;
  const createdAt = minTimestamp(
    sourceRecords.map((record) => record.createdAt).filter(finiteTimestamp),
    now(),
  );
  const updatedAt = maxTimestamp(
    [
      ...sourceRecords.map((record) => record.updatedAt),
      ...sessions.map((session) => session.updatedAt),
    ].filter(finiteTimestamp),
    createdAt,
  );
  const mergedRecord: WorkspaceRecord = {
    ...(targetRecord ?? {}),
    id: group.canonicalId,
    path: group.normalizedPath,
    name:
      targetRecord?.name ??
      newestRecord?.name ??
      workspaceName(group.normalizedPath),
    createdAt,
    updatedAt,
    ...(lastActiveSessionId ? { lastActiveSessionId } : {}),
    sessionCount: sessions.length,
  };

  await writeJson(workspaceMetaPath(group.canonicalId), mergedRecord);
  // Large records share the same serialization budget. Migrate one at a time
  // so multiple independently chunked sessions cannot exhaust it together.
  for (const item of sessionItems) {
    if (item.record) await writeSessionPayload(sessionPath(group.canonicalId, item.record.id), item.record);
  }
  await writeSessionIndexInternal(group.canonicalId, sessions);

  await Promise.all(
    sourceIds
      .filter((sourceId) => sourceId !== group.canonicalId)
      .map((sourceId) => removePath(`workspaces/${sourceId}`, true)),
  );

  return mergedRecord;
}

async function reconcileWorkspaceIndexInternal(): Promise<void> {
  const rawIndex = await readWorkspaceIndexInternal();
  const raw = await readRecoverableWorkspaceIndexInternal();
  if (raw.length === 0) return;

  const groups = new Map<string, WorkspaceMergeGroup>();
  for (const summary of raw) {
    const identity = await workspaceMergeIdentity(summary);
    const group = groups.get(identity.identityKey);
    if (group) {
      group.summaries.push(summary);
      continue;
    }
    groups.set(identity.identityKey, {
      ...identity,
      summaries: [summary],
    });
  }

  const idMap = new Map<string, string>();
  const nextIndex: WorkspaceSummary[] = [];
  let changed = raw.length !== rawIndex.length;

  for (const group of groups.values()) {
    const needsCanonicalization = group.summaries.some(
      (summary) =>
        summary.id !== group.canonicalId ||
        normalizePath(summary.path ?? '') !== group.normalizedPath,
    );
    if (group.summaries.length > 1 || needsCanonicalization) {
      const merged = await mergeWorkspaceGroupInternal(group);
      nextIndex.push(workspaceSummary(merged));
      for (const summary of group.summaries) {
        if (await workspaceSummaryUsesDirectoryAsSource(group, summary)) {
          idMap.set(summary.id, group.canonicalId);
        }
      }
      changed = true;
      continue;
    }
    nextIndex.push(group.summaries[0]);
  }

  if (!changed) return;

  await writeWorkspaceIndexInternal(nextIndex);
  const config = await getConfigInternal();
  const lastActiveWorkspaceId = config.lastActiveWorkspaceId
    ? idMap.get(config.lastActiveWorkspaceId) ?? config.lastActiveWorkspaceId
    : undefined;
  if (lastActiveWorkspaceId !== config.lastActiveWorkspaceId) {
    await writeConfigInternal({
      ...config,
      lastActiveWorkspaceId,
    });
  }
}

async function resolveWorkspaceInternal(
  input: WorkspaceUpsertInput,
): Promise<WorkspaceRecord> {
  const normalized = normalizePath(input.path);
  const id = await workspaceIdForPath(normalized);
  const existing = await getWorkspaceInternal(id);
  if (existing) {
    const patched: WorkspaceRecord = {
      ...existing,
      path: normalized,
      name: input.name ?? existing.name,
    };
    if (patched.path !== existing.path || patched.name !== existing.name) {
      return writeWorkspaceInternal({ ...patched, updatedAt: now() });
    }
    return existing;
  }

  const ts = now();
  return writeWorkspaceInternal({
    id,
    path: normalized,
    name: input.name ?? workspaceName(normalized),
    createdAt: ts,
    updatedAt: ts,
    sessionCount: 0,
  });
}

async function listSessionsInternal(
  workspaceId: string,
): Promise<SessionSummary[]> {
  const indexed = await readSessionIndexInternal(workspaceId);
  if (indexed) {
    const fileIds = await listSessionFileIdsInternal(workspaceId);
    if (
      sessionIndexMatchesFiles(indexed, fileIds) &&
      sessionIndexHasCurrentActivityVersion(indexed)
    ) {
      return indexed;
    }
    if (!(await shouldRebuildWorkspaceIndexFromFilesInternal(workspaceId))) {
      return indexed;
    }
  }
  if (!(await shouldRebuildWorkspaceIndexFromFilesInternal(workspaceId))) {
    return indexed ?? [];
  }
  return rebuildWorkspaceSessionIndexFromFilesInternal(workspaceId, true);
}

async function writeSessionIndexInternal(
  workspaceId: string,
  records: SessionSummary[],
): Promise<void> {
  await writeJson(
    sessionIndexPath(workspaceId),
    sortSessions(records),
  );
}

async function touchWorkspaceForSessionInternal(
  workspaceId: string,
  sessionId: string,
  updatedAt: number,
  sessionCount?: number,
): Promise<void> {
  const workspace = await getWorkspaceInternal(workspaceId);
  if (!workspace) return;
  const count =
    sessionCount ?? (await listSessionsInternal(workspaceId)).length;
  await writeWorkspaceInternal({
    ...workspace,
    updatedAt,
    lastActiveSessionId: sessionId,
    sessionCount: count,
  });
}

async function getSessionInternal(
  workspaceId: string,
  sessionId: string,
): Promise<SessionRecord | null> {
  const cached = cachedSessionRecord(workspaceId, sessionId);
  if (cached) return cached;
  const record = await readJson<SessionRecord>(
    sessionPath(workspaceId, sessionId),
  );
  return record ? rememberSessionRecord(record) : null;
}

async function writeSessionPayload(
  path: string,
  record: SessionRecord,
  streamCheckpoint = false,
  previous?: SessionRecord,
): Promise<void> {
  const value = streamCheckpoint && previous && tauriAvailable() ? sessionDelta(previous, record) : record;
  const persist = async (payload: unknown, checkpoint: boolean, inlineTail: boolean) => {
    try {
      await writeJson(path, payload, checkpoint);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (!tauriAvailable() || !['HISTORY_PAYLOAD_TOO_LARGE', 'HISTORY_JSON_TOO_LARGE', 'HISTORY_SERIALIZATION_BYTES_FULL'].includes(reason) ||
        estimateRetainedHistoryBytes(payload, Number.MAX_SAFE_INTEGER) < 512 * 1024) throw error;
      const chunked = await splitSessionPayload(payload, path, (chunkPath) => readJson(chunkPath, true), (chunkPath, chunk) => writeJson(chunkPath, chunk), inlineTail);
      await writeJson(path, chunked, checkpoint);
    }
  };
  try {
    await persist(value, streamCheckpoint, streamCheckpoint && value !== record);
  } catch (error) {
    // Rotate a full journal by atomically publishing the complete latest state.
    // The old base and durable journal remain valid if replacement fails.
    if (!streamCheckpoint || !tauriAvailable() || (error instanceof Error ? error.message : String(error)) !== 'HISTORY_JOURNAL_FULL') throw error;
    await persist(record, true, false);
  }
}

async function writeSessionInternal(
  record: SessionRecord,
  streamCheckpoint = false,
  previous?: SessionRecord,
  terminalStatusOnly = false,
): Promise<SessionRecord> {
  await writeSessionPayload(sessionPath(record.workspaceId, record.id), record, streamCheckpoint || terminalStatusOnly, previous);
  rememberSessionRecord(record);
  if (streamCheckpoint) return record;
  return enqueueMetadata(async () => {
  const current = await listSessionsInternal(record.workspaceId);
  const next = [
    sessionSummary(record),
    ...current.filter((s) => s.id !== record.id),
  ];
  await writeSessionIndexInternal(record.workspaceId, next);
  await touchWorkspaceForSessionInternal(
    record.workspaceId,
    record.id,
    record.updatedAt,
    next.length,
  );
  return rememberSessionRecord(record);
  });
}

async function createSessionInternal(
  input: SessionCreateInput,
): Promise<SessionRecord> {
  const ts = now();
  const messages = input.messages ?? [];
  const title = input.title ?? titleFromMessages(messages);
  const record: SessionRecord = {
    id: input.id ?? randomId(),
    generation: crypto.randomUUID(),
    workspaceId: input.workspaceId,
    title,
    isWorkflow: input.isWorkflow,
    createdAt: ts,
    updatedAt: sessionCompletionTimestamp(messages, ts),
    messages,
    ...(input.isWorkflow && input.workflow ? { workflow: input.workflow } : {}),
    ...(input.meta ? { meta: input.meta } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
  return writeSessionInternal(record);
}

async function updateSessionInternal(
  workspaceId: string,
  sessionId: string,
  patch: SessionPatch,
): Promise<SessionRecord> {
  const current = await getSessionInternal(workspaceId, sessionId);
  if (!current) {
    throw new Error(`Session not found: ${workspaceId}/${sessionId}`);
  }

  if (patch.terminalStatusOnly && (patch.messages !== undefined || patch.workflow !== undefined ||
      patch.title !== undefined || patch.isWorkflow !== undefined || patch.metadata !== undefined || patch.streamCheckpoint)) {
    throw new Error('HISTORY_TERMINAL_STATUS_PATCH_INVALID');
  }

  const nextIsWorkflow =
    current.isWorkflow || patch.isWorkflow === true || !!patch.workflow;
  const removedIds = scheduledTaskRemovedMessages.get(JSON.stringify([workspaceId, sessionId]));
  const incomingMessages = patch.messages && removedIds
    ? patch.messages.filter((message) => !removedIds.has(message.id))
    : patch.messages;
  const messages = incomingMessages
    ? patch.mergeMessages ? mergePersistedMessages(current.messages, incomingMessages) : incomingMessages
    : current.messages;
  const updatedAt = patch.preserveUpdatedAt
    ? current.updatedAt
    : patch.messages
      ? sessionCompletionTimestamp(messages, now())
      : now();
  const next: SessionRecord = {
    ...current,
    title: patch.title ?? current.title,
    isWorkflow: nextIsWorkflow,
    updatedAt,
    messages,
    ...(nextIsWorkflow
      ? { workflow: patch.workflow ?? current.workflow }
      : { workflow: undefined }),
    ...(patch.meta ? { meta: { ...(current.meta ?? {}), ...patch.meta } } : {}),
    ...(patch.metadata ? { metadata: { ...current.metadata, ...patch.metadata } } : {}),
  };

  return writeSessionInternal(next, patch.streamCheckpoint === true, current, patch.terminalStatusOnly === true);
}

/** Only upsertMessage advances host-owned learning metadata on an existing id. */
function mergePersistedMessages(current: Message[], updates: Message[]): Message[] {
  const merged = [...current];
  let anchor = -1;
  for (const update of updates) {
    const index = merged.findIndex((message) => message.id === update.id);
    if (index >= 0) {
      const saved = merged[index];
      const freshness = (message: Message) => Math.max(message.editedAt ?? 0, message.streamUpdatedAt ?? 0, message.completedAt ?? message.createdAt);
      const newer = freshness(saved) > freshness(update) ? saved : update;
      // Preserve immutable old messages so a full UI snapshot sends only deltas.
      if (newer === saved) { anchor = index; continue; }
      merged[index] = { ...saved, ...newer,
        ...(saved.skillLearning ? { skillLearning: saved.skillLearning, localOnly: true } : {}),
        ...(saved.skillContext && !newer.skillContext ? { skillContext: saved.skillContext } : {}),
      };
      anchor = index;
    } else {
      const insertAt = anchor < 0 ? merged.length : anchor + 1;
      merged.splice(insertAt, 0, update);
      anchor = insertAt;
    }
  }
  return merged;
}

async function appendMessageInternal(
  workspaceId: string,
  sessionId: string,
  msg: Message,
): Promise<void> {
  const current = await getSessionInternal(workspaceId, sessionId);
  if (!current) return;
  const messages = [...current.messages, msg];
  await updateSessionInternal(workspaceId, sessionId, {
    messages,
    title:
      isAutoTitlePlaceholder(current.title)
        ? titleFromMessages(messages, current.title)
        : current.title,
  });
}

async function migrateLocalWorkflowInternal(): Promise<void> {
  const config = await getConfigInternal();
  if (config.migratedFromLocalStorage) return;

  const raw = localGet(UGS_STORAGE_KEY);
  let migrated = false;
  if (raw) {
    try {
      const workflow = JSON.parse(raw) as IRGraph;
      if (workflow && Array.isArray(workflow.nodes) && Array.isArray(workflow.edges)) {
        const persisted = loadComposer();
        const workspace = await resolveWorkspaceInternal({
          path: persisted?.composer.workspace ?? '',
        });
        await createSessionInternal({
          workspaceId: workspace.id,
          isWorkflow: true,
          workflow,
          title: workflow.meta?.name ?? '已迁移工作流',
          meta: {
            adapter:
              workflow.meta?.adapter === 'codex' ||
              workflow.meta?.adapter === 'gemini'
                ? workflow.meta.adapter
                : 'claude-code',
          },
        });
        migrated = true;
      }
    } catch {
      /* corrupt legacy autosave: ignore and mark migration attempted */
    }
  }

  await writeConfigInternal({
    ...config,
    schemaVersion: HISTORY_SCHEMA_VERSION,
    migratedFromLocalStorage: true,
    ...(migrated ? {} : {}),
  });
}

/** Copy first, then retire the source into history trash. Safe to retry after a failed write. */
async function migrateScheduledTasksInternal(): Promise<void> {
  for (const workspace of await listWorkspacesInternal()) {
    const summaries = await listSessionsInternal(workspace.id);
    const moved = new Set<string>();
    for (const summary of summaries) {
      if (!summary.scheduledTask) continue;
      const record = await getSessionInternal(workspace.id, summary.id);
      if (!record?.meta?.scheduledTask) continue;
      let id = record.id;
      let existing = await getSessionInternal(SCHEDULED_TASK_SCOPE, id);
      if (existing && existing.meta?.scheduledTaskSourceWorkspaceId !== workspace.id) {
        id = `${workspace.id}_${record.id}`;
        existing = await getSessionInternal(SCHEDULED_TASK_SCOPE, id);
      }
      if (!existing) await writeSessionInternal({
        ...record, id, workspaceId: SCHEDULED_TASK_SCOPE,
        meta: { ...record.meta, scheduledTaskSourceWorkspaceId: workspace.id, scheduledTaskSourceSessionId: record.id, scheduledTaskExecutionPath: workspace.path },
      });
      await removePath(sessionPath(workspace.id, record.id), true);
      forgetSessionRecord(workspace.id, record.id);
      moved.add(record.id);
    }
    if (moved.size) {
      const remaining = summaries.filter((summary) => !moved.has(summary.id));
      await writeSessionIndexInternal(workspace.id, remaining);
      const current = await getWorkspaceInternal(workspace.id);
      if (current) await writeWorkspaceInternal({ ...current, sessionCount: remaining.length,
        lastActiveSessionId: remaining.some((summary) => summary.id === current.lastActiveSessionId) ? current.lastActiveSessionId : remaining[0]?.id });
    }
  }
}

export const historyStore: HistoryStore = {
  flush() { return writeQueue.flush(); },
  async ready() {
    clearSessionRecordCache();
    await enqueue(async () => {
      const config = await getConfigInternal();
      if (!config.schemaVersion) {
        await writeConfigInternal({
          ...config,
          schemaVersion: HISTORY_SCHEMA_VERSION,
        });
      }
      if (!(await readJson<WorkspaceSummary[]>(WORKSPACES_INDEX))) {
        await writeWorkspaceIndexInternal([]);
      }
      // Maintenance passes (legacy migration, index rebuild, dedup) re-serialize
      // and rewrite stored records. A single failing write here must not abort
      // the whole load and strand the user's existing, readable sessions, so
      // each pass is isolated — a thrown error is logged and skipped.
      const maintenance: Array<[string, () => Promise<void>]> = [
        ['migrateLocalWorkflow', migrateLocalWorkflowInternal],
        ['rebuildWorkspaceSessionIndexes', rebuildAllWorkspaceSessionIndexesInternal],
        ['reconcileWorkspaceIndex', reconcileWorkspaceIndexInternal],
        ['migrateScheduledTasks', migrateScheduledTasksInternal],
      ];
      for (const [label, step] of maintenance) {
        try {
          await step();
        } catch (err) {
          console.error(`[history] maintenance step "${label}" failed`, err);
        }
      }
    }, null);
  },

  async rootPath() {
    if (tauriAvailable()) {
      return command<string>('history_root');
    }
    return 'localStorage://ultragamestudio.history.v1';
  },

  getConfig() {
    return enqueue(getConfigInternal, null);
  },

  patchConfig(patch) {
    // Navigation state shares its own lane, not a barrier across all sessions.
    return writeQueue.enqueue(async () => {
      const config = await getConfigInternal();
      const next = { ...config, ...patch, schemaVersion: HISTORY_SCHEMA_VERSION };
      await writeConfigInternal(next);
      return next;
    }, patch, JSON.stringify(['config']));
  },

  listWorkspaces() {
    // 仅隐藏已退役云端记录；内部索引仍保留，避免后续写入丢失旧历史。
    return enqueue(listWorkspacesInternal, null).then((workspaces) =>
      workspaces.filter((workspace) => isSupportedWorkspacePath(workspace.path)),
    );
  },

  getWorkspace(id) {
    return enqueue(() => getWorkspaceInternal(id), id);
  },

  resolveWorkspaceByPath(path) {
    return enqueue(() => resolveWorkspaceInternal({ path }), path);
  },

  renameWorkspace(id, name) {
    return enqueue(async () => {
      const workspace = await getWorkspaceInternal(id);
      if (!workspace) throw new Error(`Workspace not found: ${id}`);
      return writeWorkspaceInternal({
        ...workspace,
        name: name.trim() || workspace.name,
        updatedAt: now(),
      });
    }, { id, name });
  },

  patchWorkspaceMetadata(id, patch) {
    return enqueue(async () => {
      const workspace = await getWorkspaceInternal(id);
      if (!workspace) throw new Error(`Workspace not found: ${id}`);
      return writeWorkspaceInternal({
        ...workspace,
        metadata: {
          ...(workspace.metadata ?? {}),
          ...(patch ?? {}),
        },
      });
    }, { id, patch });
  },

  deleteWorkspace(id, soft = true) {
    return enqueue(async () => {
      await removePath(`workspaces/${id}`, soft);
      forgetWorkspaceSessionRecords(id);
      const current = await listWorkspacesInternal();
      await writeWorkspaceIndexInternal(current.filter((w) => w.id !== id));
      const config = await getConfigInternal();
      if (config.lastActiveWorkspaceId === id) {
        await writeConfigInternal({
          ...config,
          lastActiveWorkspaceId: undefined,
          lastActiveSessionId: undefined,
        });
      }
    }, id);
  },

  listSessions(workspaceId) {
    return enqueue(() => listSessionsInternal(workspaceId), workspaceId).then((sessions) => {
      scheduleRecentSessionPrewarm(workspaceId, sessions);
      return sessions;
    });
  },

  getSession(workspaceId, sessionId) {
    // Preserve read-after-write ordering for this session without blocking on
    // unrelated streaming checkpoints or cold loads.
    return writeQueue.enqueue(() => getSessionInternal(workspaceId, sessionId),
      { workspaceId, sessionId }, JSON.stringify([workspaceId, sessionId]));
  },

  getSessionComposerDraft(workspaceId, sessionId) {
    return writeQueue.enqueue(async () => {
      const record = cachedSessionRecord(workspaceId, sessionId)
        ?? await readJson<SessionRecord>(sessionPath(workspaceId, sessionId), false, false, true);
      return typeof record?.meta?.composerDraft === 'string' ? record.meta.composerDraft : undefined;
    }, { workspaceId, sessionId }, JSON.stringify([workspaceId, sessionId]));
  },

  getSessionForGeneration(workspaceId, sessionId) {
    return writeQueue.enqueue(async () => {
      const record = await readSessionForGeneration(workspaceId, sessionId);
      return record && !record.deletedAt && record.id === sessionId && record.workspaceId === workspaceId ? record : null;
    }, { workspaceId, sessionId }, JSON.stringify([workspaceId, sessionId]));
  },

  createSession(input) {
    return enqueue(() => createSessionInternal(input), input, true);
  },

  updateSession(workspaceId, sessionId, patch) {
    return writeQueue.enqueue((next) => updateSessionInternal(workspaceId, sessionId, next),
      patch, JSON.stringify([workspaceId, sessionId]), patch.streamCheckpoint ? mergeCheckpoints : undefined, true);
  },

  updateSessionIfGeneration(workspaceId, sessionId, origin, patch, reconciliation) {
    // Every captured inert value is byte-admitted. No opaque payload callback,
    // no coalescing through a generation check, and no unbounded tombstone map.
    const payload = { workspaceId, sessionId,
      origin: { generation: origin.generation, createdAt: origin.createdAt, sourceFingerprint: origin.sourceFingerprint },
      patch, reconciliation };
    return writeQueue.enqueue(async (request) => {
      // Maintenance may move/remove records behind a hydrated cache. The
      // persisted incarnation, not an LRU entry, is the authority for CAS.
      const current = await readSessionForGeneration(request.workspaceId, request.sessionId);
      if (!current || current.deletedAt || current.workspaceId !== request.workspaceId || current.id !== request.sessionId ||
          current.generation !== request.origin.generation || current.createdAt !== request.origin.createdAt ||
          current.sourceFingerprint !== request.origin.sourceFingerprint) return null;
      rememberSessionRecord(current);
      let nextPatch = request.patch;
      if (request.reconciliation) {
        const initial = new Map(request.reconciliation.originMessages.map((message) => [message.id, message]));
        const liveIds = new Set(current.messages.map((message) => message.id));
        const messages = request.patch.messages?.filter((message) => !initial.has(message.id) ||
          liveIds.has(message.id) && JSON.stringify(initial.get(message.id)) !== JSON.stringify(message));
        const snapshot = request.reconciliation.snapshot;
        nextPatch = { ...request.patch, messages };
        if (snapshot) {
          const newerRun = (current.workflow?.meta.run?.updatedAt ?? 0) > (snapshot.updatedAt ?? 0);
          const { workflow, meta, ...other } = request.patch;
          nextPatch = { ...other, messages, ...(!newerRun ? {
            ...(current.workflow || workflow ? { workflow: workflowWithRunSnapshot(current.workflow ?? workflow!, snapshot) } : {}),
            meta: { ...meta, ...runMetaFromSnapshot(snapshot) },
          } : {}) };
        }
      }
      const record = await updateSessionInternal(request.workspaceId, request.sessionId, nextPatch);
      return { record, messages: nextPatch.messages ?? [] };
    }, payload, JSON.stringify([workspaceId, sessionId]), undefined, true);
  },

  clearScheduledTaskHistory(workspaceId, sessionId, extraMessageIds) {
    return enqueue(async () => {
      const record = await getSessionInternal(workspaceId, sessionId);
      if (!record?.meta?.scheduledTask) throw new Error('Scheduled task not found');
      const removedIds = [...new Set([...record.messages.map((message) => message.id), ...extraMessageIds])];
      const updated = await updateSessionInternal(workspaceId, sessionId, {
        messages: [], preserveUpdatedAt: true,
        ...(record.workflow?.meta?.simple === true ? { workflow: setStartUserInputs(record.workflow, []) } : {}),
        meta: { contextCompressed: false, unreadCompletion: false },
      });
      if (removedIds.length) {
        const key = JSON.stringify([workspaceId, sessionId]);
        const tombstones = scheduledTaskRemovedMessages.get(key) ?? new Set<string>();
        for (const id of removedIds) tombstones.add(id);
        scheduledTaskRemovedMessages.set(key, tombstones);
      }
      try {
        if (tauriAvailable()) await command<void>('history_delete_session_backups', { relPath: sessionPath(workspaceId, sessionId) });
      } catch (backupError) {
        return { record: updated, removedIds, backupError };
      }
      return { record: updated, removedIds };
    }, { workspaceId, sessionId, extraMessageIds }, true);
  },

  pruneScheduledTaskHistory(workspaceId, sessionId, protectedMessageIds) {
    return enqueue(async () => {
      const record = await getSessionInternal(workspaceId, sessionId);
      const task = record?.meta?.scheduledTask;
      if (!record || !task || !Number.isSafeInteger(task.maxHistoryRuns) || !task.maxHistoryRuns || task.maxHistoryRuns < 1) return null;
      const messages = retainScheduledTaskMessages(record.messages, task);
      const retainedIds = new Set(messages.map((message) => message.id));
      const removedIds = record.messages.filter((message) => !retainedIds.has(message.id)).map((message) => message.id);
      const protectedIds = protectedMessageIds?.();
      if (protectedIds && removedIds.some((id) => protectedIds.has(id))) return { record, removedIds: [] };
      const updated = removedIds.length ? await updateSessionInternal(workspaceId, sessionId, { messages, preserveUpdatedAt: true }) : record;
      if (removedIds.length) {
        const key = JSON.stringify([workspaceId, sessionId]);
        const tombstones = scheduledTaskRemovedMessages.get(key) ?? new Set<string>();
        for (const id of removedIds) tombstones.add(id);
        scheduledTaskRemovedMessages.set(key, tombstones);
      }
      try {
        if (tauriAvailable()) await command<void>('history_delete_session_backups', { relPath: sessionPath(workspaceId, sessionId) });
      } catch (backupError) {
        return { record: updated, removedIds, backupError };
      }
      return { record: updated, removedIds };
    }, { workspaceId, sessionId });
  },

  deleteSession(workspaceId, sessionId, soft = true) {
    return enqueue(async () => {
      await removePath(sessionPath(workspaceId, sessionId), soft);
      forgetSessionRecord(workspaceId, sessionId);
      scheduledTaskRemovedMessages.delete(JSON.stringify([workspaceId, sessionId]));
      const current = await listSessionsInternal(workspaceId);
      await writeSessionIndexInternal(
        workspaceId,
        current.filter((s) => s.id !== sessionId),
      );
      const workspace = await getWorkspaceInternal(workspaceId);
      if (workspace) {
        const sessions = await listSessionsInternal(workspaceId);
        await writeWorkspaceInternal({
          ...workspace,
          sessionCount: sessions.length,
          lastActiveSessionId:
            workspace.lastActiveSessionId === sessionId
              ? sessions[0]?.id
              : workspace.lastActiveSessionId,
          updatedAt: now(),
        });
      }
    }, { workspaceId, sessionId });
  },

  appendMessage(workspaceId, sessionId, msg) {
    return enqueue(() => appendMessageInternal(workspaceId, sessionId, msg), msg, true);
  },

  upsertMessage(workspaceId, sessionId, msg, preserveUpdatedAt = false) {
    return enqueue(async () => {
      const current = await getSessionInternal(workspaceId, sessionId);
      if (!current) return;
      const index = current.messages.findIndex((message) => message.id === msg.id);
      const messages = [...current.messages];
      if (index === -1) {
        messages.push(msg);
      } else {
        messages[index] = {
          ...messages[index],
          ...msg,
          createdAt: messages[index].createdAt,
        };
      }
      await updateSessionInternal(workspaceId, sessionId, {
        messages,
        preserveUpdatedAt,
        title: isAutoTitlePlaceholder(current.title)
          ? titleFromMessages(messages, current.title)
          : current.title,
      });
    }, msg, true);
  },

  setSessionWorkflow(workspaceId, sessionId, ir) {
    return enqueue(() =>
      updateSessionInternal(workspaceId, sessionId, {
        isWorkflow: true,
        workflow: ir,
        meta: {
          adapter:
            ir.meta.adapter === 'codex' || ir.meta.adapter === 'gemini'
              ? ir.meta.adapter
              : 'claude-code',
        },
      }),
      ir,
    ).then(() => undefined);
  },
};

export function __resetHistorySessionCacheForTests(): void {
  scheduledTaskRemovedMessages.clear();
  clearSessionRecordCache();
}
