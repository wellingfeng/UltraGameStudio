/**
 * CONTRACT: extractSessionFiles(messages) -> SessionFileEntry[]
 *
 * Derives the set of local files that are RELEVANT TO THE CURRENT SESSION —
 * purely from the AI agent's own activity — WITHOUT touching any version
 * control system (no git / p4 / svn). The only data source is the structured
 * tool-call events the CLI runtime already weaves into assistant messages as
 * `<<FUC_TOOL>>…<<FUC_TOOL_END>>` sentinels (see components/ai/lib/toolEvent).
 *
 * For every file-oriented tool call (Read / Edit / Write / patch / …) we pull a
 * file path out of the event's structured `args` (preferred) or its one-line
 * `subject`, classify it as `read` or `edited`, and fold repeats into a single
 * deduplicated row that keeps the strongest action and the most recent touch
 * time. Shell/search tools (Bash, Grep, Glob, …) are ignored so the list stays
 * a clean record of files the agent actually opened or changed.
 *
 * Pure module (no react / zustand / tauri) so it is unit-testable in isolation.
 */

import {
  extractToolSentinels,
  hasToolSentinel,
  mergeToolPatches,
  type ToolEvent,
} from '@/components/ai/lib/toolEvent';
import { parseFileRef } from '@/components/ai/lib/filePath';
import { toolSubjectAllowsFileRefs } from '@/components/ai/lib/toolDisplay';
import type { WorkspaceChanges, WorkspaceChangeFileStatus } from '@/lib/tauri';
import type { Message } from '@/store/types';

/** How a file was touched during the session. `edited` wins over `read`. */
export type SessionFileAction = 'read' | 'edited';

export interface SessionFileEntry {
  /** Path verbatim as the tool reported it (relative or absolute). */
  path: string;
  /** Last path segment, used as the row's primary label. */
  basename: string;
  /** Strongest action observed across the session (`edited` > `read`). */
  action: SessionFileAction;
  /** Actual workspace status when a persisted session-change snapshot exists. */
  changeStatus?: WorkspaceChangeFileStatus;
  /** How many file-tool calls referenced this path. */
  touchCount: number;
  /** Epoch ms of the most recent touch (the assistant message's createdAt). */
  lastTouchedAt: number;
}

/** Optional inputs that further refine which session files are surfaced. */
export interface ExtractSessionFilesOptions {
  /**
   * Predicate returning true for a path that should be HIDDEN because it is not
   * under version control (matched a `.gitignore` / `.p4ignore` / `.svnignore`
   * rule). It receives the verbatim path the tool reported. This is a pure,
   * caller-supplied function — this module never reads files or calls any VCS.
   */
  isIgnored?: (path: string) => boolean;
}

/**
 * Normalise a tool name for matching: lowercase and drop every non-alphanumeric
 * character so `read_file`, `read-file`, and `ReadFile` all collapse to
 * `readfile`. Keeps the action tables small and robust across runtimes.
 */
function normalizeToolName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Tools that OPEN a file's contents (no mutation).
const READ_TOOLS = new Set([
  'read',
  'readfile',
  'fileread',
  'view',
  'viewfile',
  'openfile',
  'cat',
]);

// Tools that MUTATE a file (create / overwrite / patch / replace).
const EDIT_TOOLS = new Set([
  'edit',
  'editfile',
  'fileedit',
  'multiedit',
  'filechange',
  'write',
  'writefile',
  'filewrite',
  'create',
  'createfile',
  'newfile',
  'patch',
  'applypatch',
  'strreplace',
  'strreplaceeditor',
  'strreplacebasededittool',
  'notebookedit',
  'updatefile',
]);

/** Map a (normalised) tool name to its file action, or null when not a file tool. */
function fileActionForTool(name: string): SessionFileAction | null {
  const key = normalizeToolName(name);
  if (EDIT_TOOLS.has(key)) return 'edited';
  if (READ_TOOLS.has(key)) return 'read';
  return null;
}

// Structured-arg keys the various runtimes use to carry a target file path.
const PATH_ARG_KEYS = [
  'file',
  'file_path',
  'filePath',
  'path',
  'relative_path',
  'relativePath',
  'notebook_path',
  'notebookPath',
  'target_file',
  'targetFile',
  'target_path',
  'targetPath',
  'filename',
  'fileName',
  'old_path',
  'oldPath',
  'new_path',
  'newPath',
];

const PATH_CONTAINER_KEYS = [
  'files',
  'paths',
  'changes',
  'edits',
  'patches',
  'modified_files',
  'modifiedFiles',
  'changed_files',
  'changedFiles',
];

function addPathValue(out: string[], value: unknown): void {
  if (typeof value === 'string' && value.trim()) {
    out.push(value.trim());
  } else if (Array.isArray(value)) {
    for (const item of value) addPathValue(out, item);
  }
}

function looksLikePathRef(value: string): boolean {
  return (
    /[\\/]/.test(value) ||
    /^(?:[A-Za-z]:|\.{1,2}[\\/]|~[\\/])/.test(value) ||
    /\.[A-Za-z0-9]{1,10}(?::\d+(?::\d+)?)?$/.test(value)
  );
}

function addPathLikeString(out: string[], value: string): void {
  const trimmed = value.trim();
  if (!trimmed) return;
  if (!looksLikePathRef(trimmed)) return;
  const ref = parseFileRef(trimmed);
  if (ref) out.push(ref.path);
}

function collectStructuredPaths(value: unknown, out: string[], depth = 0): void {
  if (depth > 6) return;

  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string') addPathLikeString(out, item);
      else collectStructuredPaths(item, out, depth + 1);
    }
    return;
  }

  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;

  for (const key of PATH_ARG_KEYS) {
    addPathValue(out, record[key]);
  }

  for (const key of PATH_CONTAINER_KEYS) {
    collectStructuredPaths(record[key], out, depth + 1);
  }

  // Some runtimes encode a changed-file map as `{ "src/a.ts": { ... } }`.
  for (const key of Object.keys(record)) {
    addPathLikeString(out, key);
  }
}

function cleanPatchPath(raw: string, trustBare = false): string | null {
  let path = raw.trim();
  if (!path || path === '/dev/null') return null;
  path = path.replace(/\t.*$/, '').trim();
  path = path.replace(/^["']|["']$/g, '');
  path = path.replace(/^[ab]\//, '');
  if (!path || path === '/dev/null') return null;
  const ref = parseFileRef(path);
  if (ref) return ref.path;
  if (trustBare || /^(?:[A-Za-z]:[\\/]|[/\\]|\.{1,2}[\\/])/.test(path)) {
    return path;
  }
  if (/[\\/]/.test(path) || /\.[A-Za-z0-9]{1,10}$/.test(path)) return path;
  return null;
}

function pathsFromPatchText(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const patchFile = line.match(
      /^\s*\*{3}\s+(?:Add|Update|Delete) File:\s+(.+?)\s*$/i,
    );
    if (patchFile?.[1]) {
      const path = cleanPatchPath(patchFile[1], true);
      if (path) out.push(path);
      continue;
    }

    const moveTo = line.match(/^\s*\*{3}\s+Move to:\s+(.+?)\s*$/i);
    if (moveTo?.[1]) {
      const path = cleanPatchPath(moveTo[1], true);
      if (path) out.push(path);
      continue;
    }

    const diff = line.match(/^\s*diff --git\s+a\/(.+?)\s+b\/(.+?)\s*$/);
    if (diff?.[2]) {
      const path = cleanPatchPath(diff[2], true);
      if (path) out.push(path);
      continue;
    }

    const unified = line.match(/^\s*(?:---|\+\+\+)\s+([ab]\/.+?)\s*$/);
    if (unified?.[1]) {
      const path = cleanPatchPath(unified[1], true);
      if (path) out.push(path);
      continue;
    }

    const statusLine = line.match(/^\s*(?:[AMDRCU?]{1,2})\s+(.+?)\s*$/);
    if (statusLine?.[1]) {
      const path = cleanPatchPath(statusLine[1]);
      if (path) out.push(path);
      continue;
    }

    const labelled = line.match(
      /^\s*(?:added|created|deleted|modified|updated|renamed|wrote)(?: file)?\s*[:\-]\s+(.+?)\s*$/i,
    );
    if (labelled?.[1]) {
      const path = cleanPatchPath(labelled[1]);
      if (path) out.push(path);
    }
  }
  return out;
}

function pathsFromResult(result: string | undefined): string[] {
  const out: string[] = [];
  const text = result?.trim();
  if (!text) return out;

  try {
    collectStructuredPaths(JSON.parse(text) as unknown, out);
  } catch {
    out.push(...pathsFromPatchText(text));
  }

  return out;
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of paths) {
    const key = dedupeKey(path);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(path);
  }
  return out;
}

/** Pull candidate file paths out of a single tool event's args, result, subject. */
function pathsFromEvent(event: ToolEvent): string[] {
  const out: string[] = [];

  collectStructuredPaths(event.args, out);
  if (out.length === 0) out.push(...pathsFromResult(event.result));

  // Fall back to the one-line subject (only for tools whose subject is a path,
  // never for shell/search subjects which are commands/patterns).
  if (out.length === 0 && event.subject && toolSubjectAllowsFileRefs(event.name)) {
    const ref = parseFileRef(event.subject.trim());
    if (ref) out.push(ref.path);
  }

  return uniquePaths(out);
}

/** Dedup key: separator- and case-insensitive so `A/b.ts` == `a\B.ts`. */
function dedupeKey(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function basenameOf(path: string): string {
  const cleaned = path.replace(/[\\/]+$/, '');
  const idx = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'));
  return idx === -1 ? cleaned : cleaned.slice(idx + 1);
}

interface MutableEntry extends SessionFileEntry {
  /** First-seen order, so equally-recent rows keep a stable order. */
  seq: number;
}

const STATUS_RANK: Record<WorkspaceChangeFileStatus, number> = {
  modified: 1,
  renamed: 2,
  added: 3,
  deleted: 4,
};

function strongerStatus(
  a: WorkspaceChangeFileStatus | undefined,
  b: WorkspaceChangeFileStatus,
): WorkspaceChangeFileStatus {
  if (!a) return b;
  return STATUS_RANK[b] > STATUS_RANK[a] ? b : a;
}

/**
 * Walk a session's messages and return the deduplicated set of files the agent
 * read or edited, most-recently-touched first. Returns [] when no tool activity
 * is present (pure chat sessions, or sessions that never opened a file).
 */
export function extractSessionFiles(
  messages: Message[],
  options: ExtractSessionFilesOptions = {},
): SessionFileEntry[] {
  const { isIgnored } = options;
  const byKey = new Map<string, MutableEntry>();
  let seq = 0;

  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    if (!hasToolSentinel(message.text)) continue;

    const { patches } = extractToolSentinels(message.text);
    if (patches.length === 0) continue;
    const events = mergeToolPatches(patches);
    const touchedAt = message.createdAt ?? 0;

    for (const event of events) {
      const action = fileActionForTool(event.name);
      if (!action) continue;

      for (const path of pathsFromEvent(event)) {
        const key = dedupeKey(path);
        if (!key) continue;
        // Drop files excluded by the workspace's ignore rules — they aren't
        // under version control, so they don't belong in the session list.
        if (isIgnored && isIgnored(path)) continue;

        const existing = byKey.get(key);
        if (existing) {
          existing.touchCount += 1;
          if (action === 'edited') existing.action = 'edited';
          if (touchedAt >= existing.lastTouchedAt) {
            existing.lastTouchedAt = touchedAt;
            // Prefer the latest verbatim spelling so the row reflects the most
            // recent tool call (paths can shift between relative/absolute).
            existing.path = path;
            existing.basename = basenameOf(path);
          }
        } else {
          byKey.set(key, {
            path,
            basename: basenameOf(path),
            action,
            touchCount: 1,
            lastTouchedAt: touchedAt,
            seq: seq++,
          });
        }
      }
    }
  }

  return Array.from(byKey.values())
    .sort((a, b) => b.lastTouchedAt - a.lastTouchedAt || a.seq - b.seq)
    .map((entry): SessionFileEntry => ({
      path: entry.path,
      basename: entry.basename,
      action: entry.action,
      changeStatus: entry.changeStatus,
      touchCount: entry.touchCount,
      lastTouchedAt: entry.lastTouchedAt,
    }));
}

/**
 * Merge the persisted workspace-change cache into activity derived from tool
 * events. Trusted snapshot caches represent this session's filesystem baseline,
 * so they can add missing edited files. VCS caches only decorate files already
 * proven by tool activity, because dirty workspaces can contain unrelated edits.
 */
export function mergeSessionFilesWithWorkspaceChanges(
  activityFiles: SessionFileEntry[],
  changes: WorkspaceChanges | null | undefined,
  options: ExtractSessionFilesOptions = {},
): SessionFileEntry[] {
  const byKey = new Map<string, MutableEntry>();
  const editedKeys = new Set<string>();
  let seq = 0;

  for (const entry of activityFiles) {
    const key = dedupeKey(entry.path);
    byKey.set(key, { ...entry, seq: seq++ });
    if (entry.action === 'edited') editedKeys.add(key);
  }

  for (const file of changes?.files ?? []) {
    const path = file.path.trim();
    const key = dedupeKey(path);
    if (!key) continue;
    if (options.isIgnored?.(path)) continue;

    const oldKey = file.oldPath ? dedupeKey(file.oldPath) : '';
    const trustSnapshot = changes?.source === 'snapshot';
    const matchKey = editedKeys.has(key)
      ? key
      : editedKeys.has(oldKey)
        ? oldKey
        : trustSnapshot && byKey.has(key)
          ? key
          : trustSnapshot && byKey.has(oldKey)
            ? oldKey
            : trustSnapshot
              ? key
              : '';
    if (!matchKey) continue;

    const existing = byKey.get(matchKey);
    if (existing) {
      existing.action = 'edited';
      existing.changeStatus = strongerStatus(existing.changeStatus, file.status);
      if ((changes?.generatedAtMs ?? 0) >= existing.lastTouchedAt) {
        existing.path = path;
        existing.basename = basenameOf(path);
        existing.lastTouchedAt = changes?.generatedAtMs ?? existing.lastTouchedAt;
      }
    } else if (trustSnapshot) {
      byKey.set(key, {
        path,
        basename: basenameOf(path),
        action: 'edited',
        changeStatus: file.status,
        touchCount: 1,
        lastTouchedAt: changes?.generatedAtMs ?? 0,
        seq: seq++,
      });
    }
  }

  return Array.from(byKey.values())
    .sort((a, b) => b.lastTouchedAt - a.lastTouchedAt || a.seq - b.seq)
    .map((entry): SessionFileEntry => ({
      path: entry.path,
      basename: entry.basename,
      action: entry.action,
      changeStatus: entry.changeStatus,
      touchCount: entry.touchCount,
      lastTouchedAt: entry.lastTouchedAt,
    }));
}

export interface SessionFileChangeCounts {
  added: number;
  modified: number;
  deleted: number;
  renamed: number;
}

export function countSessionFileChanges(
  files: readonly SessionFileEntry[],
): SessionFileChangeCounts {
  const counts: SessionFileChangeCounts = {
    added: 0,
    modified: 0,
    deleted: 0,
    renamed: 0,
  };
  for (const file of files) {
    if (!file.changeStatus) continue;
    counts[file.changeStatus] += 1;
  }
  return counts;
}

export interface SessionFileTreeDirectoryNode {
  type: 'directory';
  key: string;
  name: string;
  path: string;
  fileCount: number;
  children: SessionFileTreeNode[];
}

export interface SessionFileTreeFileNode {
  type: 'file';
  key: string;
  name: string;
  entry: SessionFileEntry;
}

export type SessionFileTreeNode =
  | SessionFileTreeDirectoryNode
  | SessionFileTreeFileNode;

interface MutableSessionFileTreeDirectory {
  key: string;
  name: string;
  path: string;
  fileCount: number;
  directories: Map<string, MutableSessionFileTreeDirectory>;
  files: SessionFileTreeFileNode[];
}

function splitPathBody(path: string): string[] {
  return path
    .split(/\/+/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function sessionFilePathSegments(entry: SessionFileEntry): string[] {
  const raw = entry.path.trim();
  const slashPath = raw.replace(/\\/g, '/');
  const unc = slashPath.match(/^\/\/+([^/]+)\/+([^/]+)(?:\/+(.*))?$/);
  if (unc) {
    return [`//${unc[1]}/${unc[2]}`, ...splitPathBody(unc[3] ?? '')];
  }

  const drive = slashPath.match(/^([A-Za-z]:)(?:\/+(.*))?$/);
  if (drive) {
    return [`${drive[1]}/`, ...splitPathBody(drive[2] ?? '')];
  }

  if (slashPath.startsWith('/')) {
    return ['/', ...splitPathBody(slashPath.replace(/^\/+/, ''))];
  }

  const relativeParts = splitPathBody(slashPath.replace(/^\.\/+/, ''));
  return relativeParts.length > 0 ? relativeParts : [entry.basename || raw];
}

function sessionTreeChildPath(parentPath: string, segment: string): string {
  if (!parentPath) return segment;
  if (parentPath === '/') return `/${segment}`;
  if (parentPath.endsWith('/')) return `${parentPath}${segment}`;
  return `${parentPath}/${segment}`;
}

function createMutableSessionDirectory(
  name: string,
  path: string,
): MutableSessionFileTreeDirectory {
  return {
    key: path,
    name,
    path,
    fileCount: 0,
    directories: new Map(),
    files: [],
  };
}

function compareSessionFileTreeNodes(
  a: SessionFileTreeNode,
  b: SessionFileTreeNode,
): number {
  if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
  const nameCompare =
    a.name.toLocaleLowerCase().localeCompare(b.name.toLocaleLowerCase()) ||
    a.name.localeCompare(b.name);
  if (nameCompare !== 0) return nameCompare;
  const aPath = a.type === 'directory' ? a.path : a.entry.path;
  const bPath = b.type === 'directory' ? b.path : b.entry.path;
  return aPath.localeCompare(bPath);
}

function finalizeSessionDirectory(
  dir: MutableSessionFileTreeDirectory,
): SessionFileTreeDirectoryNode {
  const children: SessionFileTreeNode[] = [
    ...Array.from(dir.directories.values()).map(finalizeSessionDirectory),
    ...dir.files,
  ].sort(compareSessionFileTreeNodes);

  return {
    type: 'directory',
    key: dir.key,
    name: dir.name,
    path: dir.path,
    fileCount: dir.fileCount,
    children,
  };
}

export function buildSessionFileTree(
  files: readonly SessionFileEntry[],
): SessionFileTreeNode[] {
  const root = createMutableSessionDirectory('', '');

  for (const entry of files) {
    const segments = sessionFilePathSegments(entry);
    const fileName = segments.pop() ?? entry.basename;
    const ancestors: MutableSessionFileTreeDirectory[] = [root];
    let current = root;

    for (const segment of segments) {
      const lookupKey = segment.toLocaleLowerCase();
      const nextPath = sessionTreeChildPath(current.path, segment);
      let next = current.directories.get(lookupKey);
      if (!next) {
        next = createMutableSessionDirectory(segment, nextPath);
        current.directories.set(lookupKey, next);
      }
      current = next;
      ancestors.push(current);
    }

    for (const dir of ancestors) {
      dir.fileCount += 1;
    }

    current.files.push({
      type: 'file',
      key: `file:${dedupeKey(entry.path)}`,
      name: fileName || entry.basename || entry.path,
      entry,
    });
  }

  return finalizeSessionDirectory(root).children;
}
