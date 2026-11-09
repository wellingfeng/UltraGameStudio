import {
  encodeToolPatch,
  extractToolSentinels,
  hasToolSentinel,
  mergeToolPatches,
  TOOL_CLOSE,
  type ToolEvent,
} from '@/components/ai/lib/toolEvent';
import { extractSessionFiles, type SessionFileEntry } from './sessionFiles';
import type { Message } from '@/store/types';
import type { WorkspaceChanges, WorkspaceChangeFileStatus } from './tauri';
import { createBoundedTextCache } from '@/components/ai/lib/boundedTextCache';

export interface TurnFileChange {
  path: string;
  status?: WorkspaceChangeFileStatus;
  added?: number;
  deleted?: number;
  binary?: boolean;
  truncated?: boolean;
}

export interface TurnFileChanges {
  source: 'agent' | 'snapshot';
  rootPath?: string;
  files: TurnFileChange[];
  truncated?: boolean;
}

/** Session totals are cumulative confirmed edits, not the repository's dirty diff. */
export function collectSessionFileChanges(
  messages: Message[],
  rootPath?: string,
): TurnFileChanges | undefined {
  const turns: Message[][] = [[]];
  for (const message of messages) {
    if (message.localOnly) continue;
    if (message.role === 'user') turns.push([]);
    else if (message.role === 'assistant') turns[turns.length - 1].push(message);
  }
  const byPath = new Map<string, TurnFileChange>();
  let source: TurnFileChanges['source'] = 'agent';
  let truncated = false;
  for (const turn of turns) {
    // The saved summary covers all tool messages owned by this turn, including
    // traces no longer rendered in the stream. Never add those events again.
    const saved = turn.filter((message) => message.fileChanges?.files.length).at(-1)?.fileChanges;
    const changes = saved ?? collectTurnFileChanges(turn, null, rootPath);
    if (!changes) continue;
    if (changes.source === 'snapshot') source = 'snapshot';
    truncated ||= Boolean(changes.truncated);
    for (const file of changes.files) {
      const root = changes.rootPath || rootPath;
      const key = pathKey(file.path, root);
      const old = byPath.get(key);
      byPath.set(key, old ? {
        ...old,
        status: old.status === 'added' && file.status !== 'deleted' ? 'added' : file.status ?? old.status,
        added: old.added == null || file.added == null ? undefined : old.added + file.added,
        deleted: old.deleted == null || file.deleted == null ? undefined : old.deleted + file.deleted,
        binary: old.binary || file.binary,
        truncated: old.truncated || file.truncated,
      } : { ...file, path: root && !/^(?:[A-Za-z]:[\\/]|\/|~\/)/.test(file.path)
        ? `${root.replace(/[\\/]+$/, '')}/${file.path}` : file.path });
    }
  }
  return byPath.size ? { source, rootPath, files: [...byPath.values()], truncated } : undefined;
}

/** Keep the sidebar's membership and paths identical to the session summary. */
export function collectSessionEditedFiles(messages: Message[], rootPath?: string): SessionFileEntry[] {
  const activity = extractSessionFiles(messages.filter((message) => !message.localOnly));
  const byPath = new Map(activity.map((entry) => [pathKey(entry.path, rootPath), entry]));
  return (collectSessionFileChanges(messages, rootPath)?.files ?? []).map((file) => {
    const entry = byPath.get(pathKey(file.path, rootPath));
    return {
      path: file.path,
      basename: file.path.replace(/\\/g, '/').split('/').pop() ?? file.path,
      action: 'edited',
      changeStatus: file.status ?? 'modified',
      touchCount: entry?.touchCount ?? 1,
      lastTouchedAt: entry?.lastTouchedAt ?? 0,
    };
  });
}

export function supportsNativeFileChanges(adapter: string): boolean {
  return ['codex', 'codex-cli', 'claude-code', 'deepseek-harness'].includes(adapter);
}

function pathKey(path: string, rootPath?: string): string {
  const clean = path.replace(/\\/g, '/').replace(/^\.\//, '');
  const root = rootPath?.replace(/\\/g, '/').replace(/\/+$/, '');
  const absolute = root && !/^(?:[A-Za-z]:\/|\/|~\/)/.test(clean)
    ? `${root}/${clean}` : clean;
  return /^(?:[A-Za-z]:\/|\/\/)/.test(absolute) ? absolute.toLowerCase() : absolute;
}

function changedLineCounts(oldText: string, newText: string): Pick<TurnFileChange, 'added' | 'deleted'> {
  const lines = (text: string) => text ? text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n') : [];
  const oldLines = lines(oldText);
  const newLines = lines(newText);
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd--; newEnd--;
  }
  const oldCount = oldEnd - start;
  const newCount = newEnd - start;
  if (oldCount * newCount > 1_000_000) return {};
  const row = new Uint32Array(newCount + 1);
  for (let i = 0; i < oldCount; i++) {
    let diagonal = 0;
    for (let j = 1; j <= newCount; j++) {
      const before = row[j];
      row[j] = oldLines[start + i] === newLines[start + j - 1]
        ? diagonal + 1 : Math.max(row[j], row[j - 1]);
      diagonal = before;
    }
  }
  return { added: newCount - row[newCount], deleted: oldCount - row[newCount] };
}

function diffCounts(diff: string): Pick<TurnFileChange, 'added' | 'deleted'> {
  let added = 0;
  let deleted = 0;
  let inHunk = false;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('diff --git ') || line.startsWith('*** ')) inHunk = false;
    if (line.startsWith('@@')) inHunk = true;
    else if (inHunk && line.startsWith('+')) added += 1;
    else if (inHunk && line.startsWith('-')) deleted += 1;
  }
  return { added, deleted };
}

function nativeDetails(event: ToolEvent, paths: string[]): TurnFileChange[] {
  const supplied = event.fileChanges;
  if (supplied?.length) return supplied;
  const args = event.args as Record<string, unknown> | undefined;
  const changes = Array.isArray(args?.changes) ? args.changes : [];
  return paths.map((path) => {
    const change = changes.find((item) => item && typeof item === 'object' &&
      (item as Record<string, unknown>).path === path) as Record<string, unknown> | undefined;
    const kind = change?.kind ?? change?.status;
    const kindName = typeof kind === 'string' ? kind :
      kind && typeof kind === 'object' ? (kind as Record<string, unknown>).type : undefined;
    const status = /^(add|added|create|created)$/.test(String(kindName)) ? 'added' :
      /^(delete|deleted|remove|removed)$/.test(String(kindName)) ? 'deleted' :
      /^(rename|renamed|move|moved)$/.test(String(kindName)) ? 'renamed' : undefined;
    const diff = change?.diff ?? args?.diff;
    let counts: Pick<TurnFileChange, 'added' | 'deleted'> = {};
    if (!event.truncated && typeof diff === 'string' && /@@/.test(diff)) counts = diffCounts(diff);
    else if (paths.length === 1 && !event.truncated && args?.replace_all !== true &&
      typeof args?.old_string === 'string' && typeof args.new_string === 'string' &&
      !args.old_string.includes('…（已截断）') && !args.new_string.includes('…（已截断）')) {
      counts = changedLineCounts(args.old_string, args.new_string);
    }
    return { path, status, ...counts };
  });
}

/** Prefer confirmed native writes. A fresh per-turn snapshot is the fallback. */
const singleRevisionCache = createBoundedTextCache<TurnFileChanges | undefined>(128, 1_000_000);
const confirmedRevisionCache = createBoundedTextCache<Array<{ id: string; files: TurnFileChange[] }>>(128, 1_000_000);

function confirmedMessageChanges(message: Message) {
  const closedAt = message.text.lastIndexOf(TOOL_CLOSE);
  const end = closedAt < 0 ? 0 : closedAt + TOOL_CLOSE.length;
  // Prose cannot revise confirmed native writes. An unfinished patch may,
  // so retain the original decoder path whenever a tool starts in the tail.
  const revision = hasToolSentinel(message.text.slice(end)) ? message.text : message.text.slice(0, end);
  return confirmedRevisionCache.get(revision, () =>
    mergeToolPatches(extractToolSentinels(revision).patches)
      .filter((event) => event.status === 'done')
      .map((event) => {
        const paths = extractSessionFiles([{ ...message, fileChanges: undefined,
          text: encodeToolPatch(event) }]).filter((entry) => entry.action === 'edited').map((entry) => entry.path);
        return { id: event.id, files: nativeDetails(event, paths) };
      }), (value) => JSON.stringify(value).length);
}

export function collectTurnFileChanges(
  messages: Message[],
  snapshot?: WorkspaceChanges | null,
  rootPath?: string,
): TurnFileChanges | undefined {
  if (messages.length === 1 && !snapshot && messages[0].role === 'assistant' && !messages[0].localOnly) {
    return singleRevisionCache.get(`${rootPath ?? ''}\0${messages[0].text}`,
      () => deriveTurnFileChanges(messages, snapshot, rootPath),
      (value) => value ? JSON.stringify(value).length : 0);
  }
  return deriveTurnFileChanges(messages, snapshot, rootPath);
}

function deriveTurnFileChanges(
  messages: Message[], snapshot?: WorkspaceChanges | null, rootPath?: string,
): TurnFileChanges | undefined {
  const byPath = new Map<string, TurnFileChange>();
  const seenEvents = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'assistant' || message.localOnly) continue;
    for (const event of confirmedMessageChanges(message)) {
      if (seenEvents.has(event.id)) continue;
      seenEvents.add(event.id);
      for (const file of event.files) {
        const key = pathKey(file.path, rootPath);
        const old = byPath.get(key);
        byPath.set(key, old ? {
          ...old,
          status: old.status === 'added' && file.status !== 'deleted' ? 'added' : file.status ?? old.status,
          added: old.added == null || file.added == null ? undefined : old.added + file.added,
          deleted: old.deleted == null || file.deleted == null ? undefined : old.deleted + file.deleted,
        } : { ...file });
      }
    }
  }
  if (byPath.size) return { source: 'agent', rootPath, files: [...byPath.values()] };
  if (!snapshot?.files.length) return undefined;
  return {
    source: 'snapshot', rootPath: snapshot.rootPath, truncated: snapshot.truncated,
    files: snapshot.files.map((file) => ({
      path: file.path, status: file.status, binary: file.binary, truncated: file.truncated,
      ...(file.binary || file.truncated ? {} : {
        added: file.lines.filter((line) => line.kind === 'added' || line.kind === 'replacedAdded').length,
        deleted: file.lines.filter((line) => line.kind === 'deleted' || line.kind === 'replacedDeleted').length,
      }),
    })),
  };
}
