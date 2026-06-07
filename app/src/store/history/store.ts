import type { IRGraph } from '@/core/ir';
import { loadComposer } from '@/lib/composerStorage';
import { FUC_STORAGE_KEY } from '@/lib/persist';
import { tauriAvailable } from '@/lib/tauri';
import type { Message } from '@/store/types';
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
  type SessionPatch,
  type SessionRecord,
  type SessionSummary,
  type WorkspaceRecord,
  type WorkspaceSummary,
  type WorkspaceUpsertInput,
} from './types';

export interface HistoryStore {
  ready(): Promise<void>;
  rootPath(): Promise<string>;

  getConfig(): Promise<HistoryConfig>;
  patchConfig(patch: Partial<HistoryConfig>): Promise<HistoryConfig>;

  listWorkspaces(): Promise<WorkspaceSummary[]>;
  getWorkspace(id: string): Promise<WorkspaceRecord | null>;
  resolveWorkspaceByPath(path: string): Promise<WorkspaceRecord>;
  renameWorkspace(id: string, name: string): Promise<WorkspaceRecord>;
  deleteWorkspace(id: string, soft?: boolean): Promise<void>;

  listSessions(workspaceId: string): Promise<SessionSummary[]>;
  getSession(
    workspaceId: string,
    sessionId: string,
  ): Promise<SessionRecord | null>;
  createSession(input: SessionCreateInput): Promise<SessionRecord>;
  updateSession(
    workspaceId: string,
    sessionId: string,
    patch: SessionPatch,
  ): Promise<SessionRecord>;
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
  setSessionWorkflow(
    workspaceId: string,
    sessionId: string,
    ir: IRGraph,
  ): Promise<void>;
}

const CONFIG_PATH = 'config.json';
const WORKSPACES_INDEX = 'workspaces/index.json';
const FALLBACK_PREFIX = 'freeultracode.history.v1:';

let writeQueue: Promise<unknown> = Promise.resolve();

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(fn, fn);
  writeQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
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
  if (!hasLocalStorage()) return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* non-fatal */
  }
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

async function readJson<T>(relPath: string): Promise<T | null> {
  const raw = tauriAvailable()
    ? await command<string | null>('history_read_json', { relPath })
    : localGet(FALLBACK_PREFIX + relPath);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// `JSON.stringify` faithfully serializes lone (unpaired) UTF-16 surrogates as
// `\udXXX` escapes — they slip in when a string is truncated mid-emoji, which
// is common in streamed/pasted model output. Browser `JSON.parse` tolerates
// them, but the Rust backend's serde validator rejects the escape with
// "unexpected end of hex escape", which aborts the whole history load. Replace
// any unpaired surrogate with U+FFFD so every payload round-trips cleanly.
function sanitizeLoneSurrogates(json: string): string {
  return json.replace(
    /\\u(d[89ab][0-9a-f]{2})(\\ud[c-f][0-9a-f]{2})?|\\ud[c-f][0-9a-f]{2}/gi,
    (match, _high, lowPair) =>
      // A matched high+low pair (lowPair present) is valid — keep it. A lone
      // high (no lowPair) or a lone low (other branch) becomes U+FFFD.
      lowPair ? match : '\\ufffd',
  );
}

async function writeJson(relPath: string, value: unknown): Promise<void> {
  const json = sanitizeLoneSurrogates(JSON.stringify(value, null, 2));
  if (tauriAvailable()) {
    await command<void>('history_write_json', { relPath, json });
    return;
  }
  localSet(FALLBACK_PREFIX + relPath, json);
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
  return `workspaces/${workspaceId}/sessions/index.json`;
}

function sessionPath(workspaceId: string, sessionId: string): string {
  return `workspaces/${workspaceId}/sessions/${sessionId}.json`;
}

function preview(messages: Message[]): string | undefined {
  const text = messages[messages.length - 1]?.text?.trim();
  if (!text) return undefined;
  return text.length > 80 ? `${text.slice(0, 80)}...` : text;
}

const AUTO_TITLE_PLACEHOLDERS = new Set([
  '新会话',
  'New Session',
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

export function titleFromText(text: string, fallback = '未命名会话'): string {
  const compact = text.trim().replace(/\s+/g, ' ');
  if (!compact) return fallback;
  return compact.length > 36 ? `${compact.slice(0, 36)}...` : compact;
}

function titleFromMessages(messages: Message[], fallback = '未命名会话'): string {
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
    updatedAt: record.updatedAt,
    preview: preview(record.messages),
    messageCount: record.messages.length,
    ...(record.workflow?.meta?.simple ? { simple: true } : {}),
    ...(runStatus ? { runStatus } : {}),
    ...(record.meta?.favorite === true ? { favorite: true } : {}),
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

function finiteTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
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
  const fileNames = await listDir(`workspaces/${workspaceId}/sessions`);
  const sessionIds = fileNames
    .filter((name) => name.endsWith('.json') && name !== 'index.json')
    .map((name) => name.slice(0, -'.json'.length));
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
): Promise<SessionSummary[]> {
  const list =
    (await readJson<SessionSummary[]>(sessionIndexPath(workspaceId))) ?? [];
  if (!(await shouldRebuildWorkspaceIndexFromFilesInternal(workspaceId))) {
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
  await Promise.all(
    sessionItems
      .filter((item): item is SessionMergeItem & { record: SessionRecord } =>
        item.record != null,
      )
      .map((item) =>
        writeJson(sessionPath(group.canonicalId, item.record.id), item.record),
      ),
  );
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
  return rebuildWorkspaceSessionIndexFromFilesInternal(workspaceId);
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
): Promise<void> {
  const workspace = await getWorkspaceInternal(workspaceId);
  if (!workspace) return;
  const sessions = await listSessionsInternal(workspaceId);
  await writeWorkspaceInternal({
    ...workspace,
    updatedAt,
    lastActiveSessionId: sessionId,
    sessionCount: sessions.length,
  });
}

async function getSessionInternal(
  workspaceId: string,
  sessionId: string,
): Promise<SessionRecord | null> {
  return readJson<SessionRecord>(sessionPath(workspaceId, sessionId));
}

async function writeSessionInternal(
  record: SessionRecord,
): Promise<SessionRecord> {
  await writeJson(sessionPath(record.workspaceId, record.id), record);
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
  );
  return record;
}

async function createSessionInternal(
  input: SessionCreateInput,
): Promise<SessionRecord> {
  const ts = now();
  const messages = input.messages ?? [];
  const title = input.title ?? titleFromMessages(messages);
  const record: SessionRecord = {
    id: randomId(),
    workspaceId: input.workspaceId,
    title,
    isWorkflow: input.isWorkflow,
    createdAt: ts,
    updatedAt: ts,
    messages,
    ...(input.isWorkflow && input.workflow ? { workflow: input.workflow } : {}),
    ...(input.meta ? { meta: input.meta } : {}),
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

  const nextIsWorkflow =
    current.isWorkflow || patch.isWorkflow === true || !!patch.workflow;
  const messages = patch.messages ?? current.messages;
  const next: SessionRecord = {
    ...current,
    title: patch.title ?? current.title,
    isWorkflow: nextIsWorkflow,
    updatedAt: patch.preserveUpdatedAt ? current.updatedAt : now(),
    messages,
    ...(nextIsWorkflow
      ? { workflow: patch.workflow ?? current.workflow }
      : { workflow: undefined }),
    ...(patch.meta ? { meta: { ...(current.meta ?? {}), ...patch.meta } } : {}),
  };

  return writeSessionInternal(next);
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

  const raw = localGet(FUC_STORAGE_KEY);
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

export const historyStore: HistoryStore = {
  async ready() {
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
      ];
      for (const [label, step] of maintenance) {
        try {
          await step();
        } catch (err) {
          console.error(`[history] maintenance step "${label}" failed`, err);
        }
      }
    });
  },

  async rootPath() {
    if (tauriAvailable()) {
      return command<string>('history_root');
    }
    return 'localStorage://freeultracode.history.v1';
  },

  getConfig() {
    return getConfigInternal();
  },

  patchConfig(patch) {
    return enqueue(async () => {
      const config = await getConfigInternal();
      const next = { ...config, ...patch, schemaVersion: HISTORY_SCHEMA_VERSION };
      await writeConfigInternal(next);
      return next;
    });
  },

  listWorkspaces() {
    return listWorkspacesInternal();
  },

  getWorkspace(id) {
    return getWorkspaceInternal(id);
  },

  resolveWorkspaceByPath(path) {
    return enqueue(() => resolveWorkspaceInternal({ path }));
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
    });
  },

  deleteWorkspace(id, soft = true) {
    return enqueue(async () => {
      await removePath(`workspaces/${id}`, soft);
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
    });
  },

  listSessions(workspaceId) {
    return listSessionsInternal(workspaceId);
  },

  getSession(workspaceId, sessionId) {
    return getSessionInternal(workspaceId, sessionId);
  },

  createSession(input) {
    return enqueue(() => createSessionInternal(input));
  },

  updateSession(workspaceId, sessionId, patch) {
    return enqueue(() => updateSessionInternal(workspaceId, sessionId, patch));
  },

  deleteSession(workspaceId, sessionId, soft = true) {
    return enqueue(async () => {
      await removePath(sessionPath(workspaceId, sessionId), soft);
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
    });
  },

  appendMessage(workspaceId, sessionId, msg) {
    return enqueue(() => appendMessageInternal(workspaceId, sessionId, msg));
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
    ).then(() => undefined);
  },
};
