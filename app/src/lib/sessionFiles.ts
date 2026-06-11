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
  'file_path',
  'filePath',
  'path',
  'notebook_path',
  'notebookPath',
  'target_file',
  'targetFile',
  'filename',
  'fileName',
];

/** Pull candidate file paths out of a single tool event's args + subject. */
function pathsFromEvent(event: ToolEvent): string[] {
  const out: string[] = [];

  const args = event.args;
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    const record = args as Record<string, unknown>;
    for (const key of PATH_ARG_KEYS) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) out.push(value.trim());
    }
  }

  // Fall back to the one-line subject (only for tools whose subject is a path,
  // never for shell/search subjects which are commands/patterns).
  if (out.length === 0 && event.subject && toolSubjectAllowsFileRefs(event.name)) {
    const ref = parseFileRef(event.subject.trim());
    if (ref) out.push(ref.path);
  }

  return out;
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
      touchCount: entry.touchCount,
      lastTouchedAt: entry.lastTouchedAt,
    }));
}
