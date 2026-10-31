/**
 * CONTRACT: persistent curated memory for the simple-chat assistant.
 *
 * Two bounded, file-backed stores that survive across sessions:
 *   - MEMORY ('memory'): the assistant's own notes — environment facts,
 *     project conventions, detected engine, tool quirks, lessons learned.
 *   - USER   ('user'):   who the user is — name, role, preferences, style.
 *
 * Storage: JSON under `.ultragamestudio/memories/{memory,user}.json` via the
 * existing `history_*` Tauri commands (atomic write + backup + quarantine).
 * In the browser the same payload is mirrored to localStorage so a no-backend
 * build still persists across reloads. Mirrors store/history/store.ts.
 *
 * Frozen-snapshot pattern (IMPORTANT — do not "fix" this):
 *   `renderMemorySnapshot()` is read ONCE at session start and concatenated
 *   into the chat system prompt. Mid-session writes update the JSON on disk
 *   immediately (durable) but DO NOT change the live system prompt. This keeps
 *   the native-CLI prefix cache stable for the whole session; the snapshot
 *   refreshes on the next session start. Changing this to re-inject mid-session
 *   silently destroys prefix-cache reuse on the claude-code path.
 *
 *   `renderFrozenMemorySnapshot(workspaceId, freezeKey)` enforces that contract
 *   mechanically: it caches the rendered block keyed by `freezeKey` (the chat
 *   session id), so the caller physically cannot re-read disk mid-session.
 *   Callers that run argv-capped adapters (dsh / zcode) instead use
 *   `renderMemorySnapshotCompact()` to inject a hard-bounded snapshot that fits
 *   the command-line budget instead of dropping memory entirely.
 *
 * Limits are CHARACTER counts (not tokens) because char counts are
 * model-independent and stable. An `add` that would overflow is rejected with
 * the current entries echoed back, so the caller can remove/replace stale
 * entries to free room. A `batch` applies atomically and the limit is checked
 * only on the FINAL result, so one call can free room AND add together.
 * With `evictOnOverflow` the batch may instead drop the oldest (never the
 * entries touched by THIS batch) entries to stay under the limit, reporting
 * what was evicted.
 */

import { checkMemoryCancelled, compareExchangeMemoryJson, readMemoryJson, withMemoryLock } from './memoryTransactions';
import { normalizeMemoryRequests } from '@/core/memoryProtocol';
import { loadFrozenSnapshot, releaseFrozenSnapshot, resetSnapshotCache } from './memorySnapshots';
import { scanMemoryContent, type MemorySafetyFinding } from './memorySafety';
import type { MemoryReviewSource, MemorySourceConfirmation } from './memoryPending';

export type MemoryTarget = 'memory' | 'user';

export interface MemoryLimits {
  memory: number;
  user: number;
}

/** Defaults mirror Hermes' bounded stores; tune via setMemoryLimits(). */
export const DEFAULT_MEMORY_LIMITS: MemoryLimits = {
  memory: 2200,
  user: 1375,
};

let limits: MemoryLimits = { ...DEFAULT_MEMORY_LIMITS };

export function setMemoryLimits(next: Partial<MemoryLimits>): void {
  limits = {
    memory: Math.max(1, Math.floor(next.memory ?? limits.memory)),
    user: Math.max(1, Math.floor(next.user ?? limits.user)),
  };
}

export function getMemoryLimits(): MemoryLimits {
  return { ...limits };
}

/**
 * Usage-percentage threshold above which the rendered snapshot appends an
 * active "consolidate before writing" nudge. Synced from MemoryConfig (see
 * memoryConfig.ts) the same way the char limits are.
 */
let nudgeThresholdPct = 85;

export function setMemoryNudgeThresholdPct(pct: number): void {
  nudgeThresholdPct = Math.min(100, Math.max(0, Math.floor(pct)));
}

export function getMemoryNudgeThresholdPct(): number {
  return nudgeThresholdPct;
}

/**
 * AI-suggested importance tier for one entry, set by the model when it writes
 * (memoryProtocol `importance`) or by the user in the Memory settings panel.
 * Drives the colored badge in the UI and the eviction order (minor entries are
 * evicted before must-keep ones). `undefined` = untagged (legacy entries).
 */
export type MemoryImportance = 'must' | 'important' | 'minor';

/** Map tolerant model output (English or Chinese) onto the canonical tiers. */
export function normalizeImportance(value: unknown): MemoryImportance | undefined {
  if (typeof value !== 'string') return undefined;
  switch (value.trim().toLowerCase()) {
    case 'must':
    case 'critical':
    case '必须':
      return 'must';
    case 'important':
    case '重要':
      return 'important';
    case 'minor':
    case 'low':
    case 'trivial':
    case '不重要':
      return 'minor';
    default:
      return undefined;
  }
}

/** One stored entry. `updatedAt` is epoch-ms of the last add/replace; `undefined`
 * for entries migrated from the legacy string[] shape (timestamp unknown). */
export interface MemoryEntry {
  /** Stable identity assigned only during a successful CAS migration/write. */
  id?: string;
  text: string;
  updatedAt?: number;
  importance?: MemoryImportance;
}

/**
 * On-disk shape. v2 stores structured entries; v1 (legacy) stored plain strings.
 * Both are accepted on read; writes always emit v2.
 */
export interface MemoryCommitReceipt {
  id: string; signature: string; appliedCount: number; skippedCount: number;
  target?: MemoryTarget; workspaceId?: string; reviewSource?: MemoryReviewSource;
  sourceConfirmation?: MemorySourceConfirmation;
  before?: MemoryEntry[]; after?: MemoryEntry[]; afterRevision?: string; undoes?: string;
}
interface MemoryFile {
  version: 1 | 2;
  entries: (string | MemoryEntry)[];
  revision?: string;
  receipts?: MemoryCommitReceipt[];
}

/**
 * The shape produced by `readFile`: legacy string entries have already been
 * converted to structured `MemoryEntry`s, so consumers only ever see v2 shape.
 */
interface NormalizedMemoryFile {
  version: 2;
  entries: MemoryEntry[];
  raw: string | null;
  revision?: string;
  receipts?: MemoryCommitReceipt[];
}

export interface MemoryBase {
  target: MemoryTarget;
  workspaceId?: string;
  raw: string | null;
  entries: MemoryEntry[];
  revision?: string;
}



/**
 * Resolve the on-disk relative path for a target.
 *
 * `user` is GLOBAL — who the user is (name, style) carries across every
 * project. `memory` is per-WORKSPACE when a workspaceId is given, because the
 * assistant's project notes (detected engine, asset-dir conventions, toolchain
 * quirks) must NOT leak between game projects — a "引擎=Unity" note from one
 * project would otherwise poison another. With no workspaceId, memory falls
 * back to the shared global file (CLI / no-project sessions).
 */
function relPathFor(target: MemoryTarget, workspaceId?: string): string {
  if (target === 'user') return 'memories/user.json';
  if (workspaceId === undefined || workspaceId === '') return 'memories/memory.json';
  // Never repair IDs into a different project's leaf. Real workspace IDs are host-derived.
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(workspaceId) || workspaceId.endsWith('.') ||
      /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(workspaceId)) throw new Error('Invalid memory workspace scope identity');
  return `memories/workspaces/${workspaceId}/memory.json`;
}

// --- single-op / batch operation shapes --------------------------------------

export interface MemoryOp {
  action: 'add' | 'replace' | 'remove';
  content?: string;
  /** A short unique substring identifying the entry for replace/remove. */
  oldText?: string;
  /**
   * AI-suggested importance for add; on replace it overrides the existing
   * tier (omit to keep the entry's current one). Ignored for remove. Free-form
   * string from the model — normalized via normalizeImportance() on write,
   * falling back to 'important'.
   */
  importance?: string;
}

export interface MemoryResult {
  success: boolean;
  appliedCount?: number;
  skippedCount?: number;
  alreadyApplied?: boolean;
  target: MemoryTarget;
  /** Live entries after the operation (or the current entries on failure). */
  entries: MemoryEntry[];
  used: number;
  limit: number;
  error?: string;
  /** Entry texts evicted to make room, only when `evictOnOverflow` ran. */
  evicted?: string[];
  /**
   * Ops skipped WITHOUT failing the batch. Two causes, both mirroring Hermes:
   * an `add` whose normalized text already exists verbatim ("no duplicate
   * added") and an add/replace rejected by the safety scan when
   * `safetyScan` mode is 'skip'. Callers surface these to the model/user.
   */
  skipped?: { reason: string }[];
  /** Safety-scan findings that rejected this batch (only on failure). */
  safetyFindings?: MemorySafetyFinding[];
}

/** Optional policy knobs for a batch (see `applyMemoryBatch`). */
export interface MemoryBatchOptions {
  signal?: AbortSignal;
  /** Trusted producer guard, rechecked immediately before host CAS dispatch. */
  beforeDispatch?: () => void;
  /** Exact host bytes captured for this proposal; null means confirmed absent. */
  expectedRaw?: string | null;
  transactionId?: string;
  reviewSource?: MemoryReviewSource;
  sourceConfirmation?: MemorySourceConfirmation;
  /**
   * When the final result overflows the char limit, drop the OLDEST entries
   * (entries touched by THIS batch are never evicted) until it fits, instead of
   * rejecting. Off by default so no data is lost without an explicit opt-in.
   */
  evictOnOverflow?: boolean;
  /**
   * Safety-scan policy for add/replace content (see lib/memorySafety.ts).
   * 'reject' (default) fails the whole batch atomically when a scan fires;
   * 'off' disables the scan; 'skip' rejects only the offending op and carries
   * on (the op lands in `result.skipped`). Never rewrites content.
   */
  safetyScan?: 'reject' | 'skip' | 'off';
}

// --- low-level IO (mirrors store/history/store.ts) ---------------------------



function validSourceConfirmation(value: unknown): value is MemorySourceConfirmation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const source = value as Partial<MemorySourceConfirmation>;
  return Object.keys(source).every((key) => ['provenance', 'legacyId', 'confirmedAt', 'workspaceId', 'sessionId', 'sourceMessageId', 'message'].includes(key)) &&
    source.provenance === 'user_confirmed_rebinding' && typeof source.workspaceId === 'string' &&
    [source.legacyId, source.sessionId, source.sourceMessageId].every((field) => typeof field === 'string' && field.length > 0) &&
    Number.isSafeInteger(source.confirmedAt) && source.confirmedAt! >= 0 &&
    !!source.message && typeof source.message === 'object' && !Array.isArray(source.message) &&
    source.message.id === source.sourceMessageId && source.message.role === 'user' && typeof source.message.text === 'string';
}

async function readFile(target: MemoryTarget, workspaceId?: string): Promise<NormalizedMemoryFile> {
  const raw = await readMemoryJson(relPathFor(target, workspaceId));
  if (raw === null) return { version: 2, entries: [], raw };
  const parsed = JSON.parse(raw) as Partial<MemoryFile>;
  if (Object.keys(parsed ?? {}).some((key) => !['version', 'entries', 'revision', 'receipts'].includes(key))) throw new Error('Unknown memory JSON fields');
  if (parsed?.revision !== undefined && typeof parsed.revision !== 'string') throw new Error('Invalid memory revision');
  const validSnapshot = (value: unknown) => Array.isArray(value) && value.every((entry) => entry && typeof entry === 'object' &&
    typeof entry.text === 'string' && entry.text.trim() && Object.keys(entry).every((key) => ['id', 'text', 'updatedAt', 'importance'].includes(key)) &&
    (entry.id === undefined || (typeof entry.id === 'string' && !!entry.id)) &&
    (entry.updatedAt === undefined || Number.isFinite(entry.updatedAt)) &&
    (entry.importance === undefined || !!normalizeImportance(entry.importance)));
  if (parsed?.receipts !== undefined && (!Array.isArray(parsed.receipts) || parsed.receipts.some((receipt) =>
      !receipt || typeof receipt.id !== 'string' || typeof receipt.signature !== 'string' ||
      Object.keys(receipt).some((key) => !['id', 'signature', 'appliedCount', 'skippedCount', 'target', 'workspaceId', 'reviewSource', 'sourceConfirmation', 'before', 'after', 'afterRevision', 'undoes'].includes(key)) ||
      (receipt.before !== undefined && !validSnapshot(receipt.before)) || (receipt.after !== undefined && !validSnapshot(receipt.after)) ||
      (receipt.afterRevision !== undefined && typeof receipt.afterRevision !== 'string') ||
      (receipt.target !== undefined && !['memory', 'user'].includes(receipt.target)) ||
      (receipt.workspaceId !== undefined && typeof receipt.workspaceId !== 'string') ||
      (receipt.undoes !== undefined && typeof receipt.undoes !== 'string') ||
      (receipt.sourceConfirmation !== undefined && !validSourceConfirmation(receipt.sourceConfirmation)) ||
      (receipt.reviewSource !== undefined && (!receipt.reviewSource ||
        typeof receipt.reviewSource.workspaceId !== 'string' ||
        ['hostId', 'namespaceId', 'sessionId', 'turnId', 'sourceMessageId', 'runId'].some((key) =>
          typeof receipt.reviewSource?.[key as keyof MemoryReviewSource] !== 'string' || !receipt.reviewSource[key as keyof MemoryReviewSource]) ||
        (receipt.reviewSource.cwd !== undefined && (typeof receipt.reviewSource.cwd !== 'string' || !receipt.reviewSource.cwd)) ||
        Object.keys(receipt.reviewSource).some((key) => !['hostId', 'namespaceId', 'workspaceId', 'sessionId', 'turnId', 'sourceMessageId', 'runId', 'cwd'].includes(key)))) ||
      !Number.isInteger(receipt.appliedCount) || receipt.appliedCount < 0 || !Number.isInteger(receipt.skippedCount) || receipt.skippedCount < 0))) throw new Error('Invalid memory receipts');
  if (!parsed || ![1, 2].includes(parsed.version as number) || !Array.isArray(parsed.entries)) {
    throw new Error('Unknown memory JSON schema; refusing overwrite');
  }
  const entries = parsed.entries.map((e): MemoryEntry => {
    if (typeof e === 'string' && e.trim()) return { text: e.trim() };
    if (!e || typeof e !== 'object' || typeof e.text !== 'string' || !e.text.trim()) {
      throw new Error('Invalid memory entry; refusing partial read');
    }
    if (Object.keys(e).some((key) => !['id', 'text', 'updatedAt', 'importance'].includes(key)) ||
        (e.id !== undefined && (typeof e.id !== 'string' || !e.id))) throw new Error('Invalid memory entry identity/fields');
    if (e.updatedAt !== undefined && (typeof e.updatedAt !== 'number' || !Number.isFinite(e.updatedAt))) {
      throw new Error('Invalid memory timestamp');
    }
    const importance = normalizeImportance(e.importance);
    if (e.importance !== undefined && !importance) throw new Error('Invalid memory importance');
    return { ...(e.id ? { id: e.id } : {}), text: e.text.trim(), ...(e.updatedAt !== undefined ? { updatedAt: e.updatedAt } : {}), ...(importance ? { importance } : {}) };
  });
  return { version: 2, entries, raw, revision: parsed.revision, receipts: parsed.receipts };
}

/** Captures a complete exact target; caller must freeze it before model dispatch. */
export async function readMemoryBase(target: MemoryTarget, workspaceId?: string): Promise<MemoryBase> {
  const file = await readFile(target, workspaceId);
  return { target, ...(target === 'memory' && workspaceId !== undefined ? { workspaceId } : {}), raw: file.raw, entries: file.entries, revision: file.revision };
}

async function writeFile(
  target: MemoryTarget,
  file: { version: 2; entries: MemoryEntry[] },
  workspaceId: string | undefined,
  expectedRaw: string | null,
  receipt?: MemoryCommitReceipt,
  signal?: AbortSignal,
  beforeDispatch?: () => void,
): Promise<void> {
  const relPath = relPathFor(target, workspaceId);
  const previous = expectedRaw === null ? {} : JSON.parse(expectedRaw) as Partial<MemoryFile>;
  const receipts = [...(previous.receipts ?? []), ...(receipt ? [receipt] : [])].slice(-64);
  const entries = file.entries.map((entry) => ({ ...entry, id: entry.id ?? crypto.randomUUID() }));
  const revision = crypto.randomUUID();
  if (receipt) Object.assign(receipt, { target, ...(target === 'memory' && workspaceId !== undefined ? { workspaceId } : {}),
    before: previous.entries?.map((entry) => typeof entry === 'string' ? { text: entry.trim() } : entry) ?? [], after: entries, afterRevision: revision });
  const json = JSON.stringify({ ...file, entries,
    revision, ...(receipts.length ? { receipts } : {}) }, null, 2);
  await compareExchangeMemoryJson(relPath, expectedRaw, json, signal, beforeDispatch);
}

// --- helpers -----------------------------------------------------------------

function charCount(entries: MemoryEntry[]): number {
  // Joined length approximates the rendered block size; the delimiter is a
  // single separator char so this stays close to the on-screen footprint.
  return entries.map((e) => e.text).join('\n').length;
}

function limitFor(target: MemoryTarget): number {
  return target === 'user' ? limits.user : limits.memory;
}

function result(
  target: MemoryTarget,
  entries: MemoryEntry[],
  ok: boolean,
  error?: string,
): MemoryResult {
  return {
    success: ok,
    target,
    entries,
    used: charCount(entries),
    limit: limitFor(target),
    ...(error ? { error } : {}),
  };
}

/**
 * Normalized form for exact-duplicate detection (mirrors Hermes' "no duplicate
 * added"). Trim + collapse ALL whitespace runs so an add that differs only in
 * spacing/padding from an existing entry is still recognized as the same fact.
 */
function normalizeForDuplicate(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

interface OpOutcome {
  entries: MemoryEntry[];
  /** Non-fatal skip note (duplicate add / skipped-by-scan op). */
  skippedReason?: string;
}

/**
 * Apply one op to a working copy.
 * - A verbatim-duplicate `add` is a no-op (skippedReason), NOT an error —
 *   Hermes treats re-adding the same fact as success-without-effect.
 * - Throws Error(message) on a bad targeted op or (mode 'reject') on a
 *   safety-scan hit.
 */
function applyOp(
  entries: MemoryEntry[],
  op: MemoryOp,
  now: number,
  safetyMode: 'reject' | 'skip' | 'off',
): OpOutcome {
  const failSafety = (text: string): string | null => {
    if (safetyMode === 'off') return null;
    const findings = scanMemoryContent(text);
    if (!findings.length) return null;
    return `安全扫描拒绝写入：${findings.map((f) => f.reason).join('；')}`;
  };

  if (op.action === 'add') {
    const text = (op.content ?? '').trim();
    if (!text) throw new Error("'add' needs non-empty content.");
    const dup = normalizeForDuplicate(text);
    if (entries.some((e) => normalizeForDuplicate(e.text) === dup)) {
      return { entries, skippedReason: 'no duplicate added — 已存在内容相同的条目' };
    }
    const safetyError = failSafety(text);
    if (safetyError) {
      if (safetyMode === 'skip') return { entries, skippedReason: safetyError };
      throw new Error(safetyError);
    }
    // Entries default to 'important' when the writer doesn't judge a tier;
    // tolerant model output (Chinese aliases) normalizes here, at the store.
    const importance = normalizeImportance(op.importance) ?? 'important';
    return { entries: [...entries, { text, updatedAt: now, importance }] };
  }
  const needle = (op.oldText ?? '').trim();
  if (!needle) {
    throw new Error(
      `'${op.action}' needs oldText — a short unique substring of the entry to ${op.action}.`,
    );
  }
  const matches = entries.filter((e) => e.text.includes(needle));
  if (matches.length === 0) {
    throw new Error(`No entry matches "${needle}".`);
  }
  if (matches.length > 1) {
    throw new Error(`"${needle}" matches ${matches.length} entries — use a more specific substring.`);
  }
  if (op.action === 'remove') {
    return { entries: entries.filter((e) => !e.text.includes(needle)) };
  }
  // replace — keep the entry's existing importance unless the op supplies one.
  const text = (op.content ?? '').trim();
  if (!text) throw new Error("'replace' needs non-empty content.");
  const safetyError = failSafety(text);
  if (safetyError) {
    if (safetyMode === 'skip') return { entries, skippedReason: safetyError };
    throw new Error(safetyError);
  }
  return {
    entries: entries.map((e) =>
      e.text.includes(needle)
        ? {
            ...e,
            text,
            updatedAt: now,
            ...(normalizeImportance(op.importance)
              ? { importance: normalizeImportance(op.importance) }
              : {}),
          }
        : e,
    ),
  };
}

/**
 * Drop entries until the store fits `limit`. Entries whose `updatedAt === now`
 * were touched by the current batch and are pinned — they are never evicted
 * (we never silently discard what the caller just wrote). Eviction order:
 * least-important first (minor → untagged → important → must), oldest first
 * within a tier. Returns the kept list plus the evicted entries in order.
 */
function evictOldest(
  entries: MemoryEntry[],
  limit: number,
  now: number,
): { kept: MemoryEntry[]; evicted: MemoryEntry[] } {
  // Higher rank = keep longer. Untagged (legacy) entries sit between the tiers.
  const rank = (e: MemoryEntry): number =>
    e.importance === 'minor' ? 0 : e.importance === 'must' ? 3 : e.importance === 'important' ? 2 : 1;
  const evictable = entries
    .filter((e) => e.updatedAt !== now)
    .sort((a, b) => rank(a) - rank(b) || (a.updatedAt ?? 0) - (b.updatedAt ?? 0));
  const evicted: MemoryEntry[] = [];
  let kept = entries;
  for (const entry of evictable) {
    if (charCount(kept) <= limit) break;
    kept = kept.filter((k) => k !== entry);
    evicted.push(entry);
  }
  return { kept, evicted };
}

// --- public API --------------------------------------------------------------

/**
 * Load all entries for a target (used by UI/inspection and tests).
 * `workspaceId` scopes the `memory` store; ignored for `user` (always global).
 */
export async function loadMemory(
  target: MemoryTarget,
  workspaceId?: string,
): Promise<MemoryEntry[]> {
  const file = await readFile(target, workspaceId);
  return file.entries;
}

/**
 * Load entries as plain text (legacy shape). Convenience for snapshot rendering
 * and any consumer that doesn't care about timestamps.
 */
export async function loadMemoryTexts(
  target: MemoryTarget,
  workspaceId?: string,
): Promise<string[]> {
  const entries = await loadMemory(target, workspaceId);
  return entries.map((e) => e.text);
}

/**
 * Backfill `updatedAt` for entries migrated from the v1 string[] shape, which
 * never stored a timestamp and render as "更新于 —". Assigns one shared `now`
 * so they get a concrete baseline time, then persists back as v2. No-op when
 * every entry already has a numeric timestamp (no write). Returns the entries.
 *
 * Called explicitly from the Memory settings panel (on load and after any op /
 * refresh); kept out of `loadMemory` because that is a pure read used on the
 * snapshot hot path and must not write.
 */
export async function backfillMemoryTimestamps(
  target: MemoryTarget,
  workspaceId?: string,
): Promise<MemoryEntry[]> {
  const file = await readFile(target, workspaceId);
  const hasLegacy = file.entries.some((e) => typeof e.updatedAt !== 'number');
  if (!hasLegacy) return file.entries;
  const now = Date.now();
  const entries = file.entries.map((e) =>
    typeof e.updatedAt === 'number' ? e : { text: e.text, updatedAt: now },
  );
  await writeFile(target, { version: 2, entries }, workspaceId, file.raw);
  return entries;
}

/**
 * Apply a batch of operations atomically. The char limit is checked only on
 * the FINAL result, so a single call can remove/replace stale entries to free
 * room AND add new ones. On overflow or a bad op NOTHING is written and the
 * current entries are echoed back with an error — unless `evictOnOverflow` is
 * set, in which case the oldest entries are dropped (never the ones this batch
 * touched) and reported in `result.evicted`.
 * `workspaceId` scopes the `memory` store; ignored for `user`.
 */
export async function applyMemoryBatch(
  target: MemoryTarget,
  ops: MemoryOp[],
  workspaceId?: string,
  opts?: MemoryBatchOptions,
): Promise<MemoryResult> {
  const requests = normalizeMemoryRequests([{ target, operations: ops }]);
  if (!requests && ops.length) return result(target, [], false, 'Invalid memory operation payload');
  const frozenOps = structuredClone(requests?.[0]?.operations ?? []);
  const frozenOpts = opts ? { ...opts, reviewSource: opts.reviewSource ? structuredClone(opts.reviewSource) : undefined,
    sourceConfirmation: opts.sourceConfirmation ? structuredClone(opts.sourceConfirmation) : undefined } : undefined;
  return withMemoryLock(relPathFor(target, workspaceId), () => applyMemoryBatchLocked(target, frozenOps, workspaceId, frozenOpts));
}

async function applyMemoryBatchLocked(
  target: MemoryTarget,
  ops: MemoryOp[],
  workspaceId?: string,
  opts?: MemoryBatchOptions,
): Promise<MemoryResult> {
  checkMemoryCancelled(opts?.signal);
  const file = await readFile(target, workspaceId);
  checkMemoryCancelled(opts?.signal);
  const signature = opts?.transactionId ? JSON.stringify({ target, workspaceId,
    base: opts.expectedRaw === null ? null : JSON.parse(opts.expectedRaw ?? '{}').revision ?? opts.expectedRaw, operations: ops }) : '';
  const prior = opts?.transactionId ? file.receipts?.find((receipt) => receipt.id === opts.transactionId) : undefined;
  if (prior) {
    if (prior.signature !== signature) return result(target, file.entries, false, 'Memory transaction identity conflict');
    return { ...result(target, file.entries, true), appliedCount: 0, skippedCount: ops.length, alreadyApplied: true };
  }
  if (opts && 'expectedRaw' in opts && opts.expectedRaw !== file.raw) {
    return result(target, file.entries, false, 'Memory CAS conflict: proposal base changed');
  }
  if (!ops.length) return result(target, file.entries, true);

  const now = Date.now();
  const safetyMode = opts?.safetyScan ?? 'reject';
  let working = file.entries;
  const skipped: { reason: string }[] = [];
  try {
    for (const op of ops) {
      const outcome = applyOp(working, op, now, safetyMode);
      working = outcome.entries;
      if (outcome.skippedReason) skipped.push({ reason: outcome.skippedReason });
    }
  } catch (err) {
    return result(
      target,
      file.entries,
      false,
      err instanceof Error ? err.message : String(err),
    );
  }

  const limit = limitFor(target);
  const used = charCount(working);
  if (used > limit) {
    if (!opts?.evictOnOverflow) {
      return result(
        target,
        file.entries,
        false,
        `Result would be ${used}/${limit} chars — over the limit. Remove or shorten entries in the same batch.`,
      );
    }
    const { kept, evicted } = evictOldest(working, limit, now);
    if (charCount(kept) > limit) {
      // Even after dropping every pre-existing entry, the batch's own content
      // is too large — nothing safe to evict, so reject without writing.
      return result(
        target,
        file.entries,
        false,
        `Result would be ${charCount(kept)}/${limit} chars even after evicting older entries — the new content itself is over the limit.`,
      );
    }
    await writeFile(target, { version: 2, entries: kept }, workspaceId, file.raw,
      opts?.transactionId ? { id: opts.transactionId, signature, appliedCount: ops.length - skipped.length, skippedCount: skipped.length, reviewSource: opts.reviewSource, sourceConfirmation: opts.sourceConfirmation } : undefined, opts?.signal, opts?.beforeDispatch);
    return {
      ...result(target, kept, true), appliedCount: ops.length - skipped.length, skippedCount: skipped.length,
      ...(skipped.length ? { skipped } : {}),
      ...(evicted.length ? { evicted: evicted.map((e) => e.text) } : {}),
    };
  }

  await writeFile(target, { version: 2, entries: working }, workspaceId, file.raw,
    opts?.transactionId ? { id: opts.transactionId, signature, appliedCount: ops.length - skipped.length, skippedCount: skipped.length, reviewSource: opts.reviewSource, sourceConfirmation: opts.sourceConfirmation } : undefined, opts?.signal, opts?.beforeDispatch);
  return {
    ...result(target, working, true), appliedCount: ops.length - skipped.length, skippedCount: skipped.length,
    ...(skipped.length ? { skipped } : {}),
  };
}

export interface MemoryTransactionView extends MemoryCommitReceipt {
  base: MemoryBase; canUndo: boolean; undoReason?: string;
}
/** Receipt availability is established by a fresh exact target read, not review-job status. */
export async function readMemoryTransactionHistory(target: MemoryTarget, workspaceId?: string): Promise<MemoryTransactionView[]> {
  const file = await readFile(target, workspaceId);
  const base: MemoryBase = { target, workspaceId: target === 'memory' ? workspaceId : undefined, raw: file.raw, entries: file.entries, revision: file.revision };
  return (file.receipts ?? []).map((receipt) => {
    const reason = receipt.undoes ? '撤销审计' : file.receipts?.some((entry) => entry.undoes === receipt.id) ? '已撤销' :
      !receipt.before || !receipt.after || !receipt.afterRevision ? '旧回执没有 before，不可撤销' :
      receipt.target !== target || receipt.workspaceId !== base.workspaceId || receipt.afterRevision !== file.revision ||
        JSON.stringify(receipt.after) !== JSON.stringify(file.entries) ? '目标已改变，撤销冲突' : undefined;
    return { ...receipt, base, canUndo: !reason && receipt.appliedCount > 0, undoReason: reason };
  });
}

/** Undo is a new single-target host CAS; neither the journal nor a queue ID authorizes it. */
export async function undoMemoryTransaction(target: MemoryTarget, transactionId: string, workspaceId: string | undefined,
  expectedRaw: string | null): Promise<MemoryResult> {
  return withMemoryLock(relPathFor(target, workspaceId), async () => {
    const file = await readFile(target, workspaceId);
    if (file.receipts?.some((receipt) => receipt.undoes === transactionId)) {
      return { ...result(target, file.entries, true), alreadyApplied: true, appliedCount: 0 };
    }
    const receipt = file.receipts?.find((entry) => entry.id === transactionId);
    if (!receipt?.before || !receipt.after || !receipt.afterRevision) return result(target, file.entries, false, 'Legacy receipt has no before snapshot; cannot undo');
    if (receipt.target !== target || receipt.workspaceId !== (target === 'memory' ? workspaceId : undefined) ||
        file.raw !== expectedRaw || file.revision !== receipt.afterRevision || JSON.stringify(file.entries) !== JSON.stringify(receipt.after)) {
      return result(target, file.entries, false, 'Memory undo CAS conflict: committed target changed');
    }
    await writeFile(target, { version: 2, entries: receipt.before }, workspaceId, file.raw, {
      id: `undo:${transactionId}`, signature: JSON.stringify({ undoes: transactionId, afterRevision: receipt.afterRevision }),
      appliedCount: 1, skippedCount: 0, undoes: transactionId, reviewSource: receipt.reviewSource, sourceConfirmation: receipt.sourceConfirmation,
    });
    return { ...result(target, (await readFile(target, workspaceId)).entries, true), appliedCount: 1 };
  });
}

/** Convenience single-op wrapper. */
export function applyMemoryOp(
  target: MemoryTarget,
  op: MemoryOp,
  workspaceId?: string,
  opts?: MemoryBatchOptions,
): Promise<MemoryResult> {
  return applyMemoryBatch(target, [op], workspaceId, opts);
}

/**
 * Set (or clear) the importance tier of ONE entry without touching its text or
 * `updatedAt` — used by the Memory settings badge, which cycles the tier on
 * click. Matches by unique substring like replace/remove. Returns false when
 * the entry is missing or ambiguous.
 */
export async function setMemoryImportance(
  target: MemoryTarget,
  oldText: string,
  importance: MemoryImportance | undefined,
  workspaceId?: string,
): Promise<boolean> {
  const needle = oldText.trim();
  if (!needle) return false;
  const file = await readFile(target, workspaceId);
  const matches = file.entries.filter((e) => e.text.includes(needle));
  if (matches.length !== 1) return false;
  const entries = file.entries.map((e) =>
    e.text.includes(needle)
      ? { ...e, ...(importance ? { importance } : { importance: undefined }) }
      : e,
  );
  // JSON.stringify drops undefined fields, so the cleared tier simply vanishes.
  await writeFile(target, { version: 2, entries }, workspaceId, file.raw);
  return true;
}

/** Atomic metadata-only update tied to the model's exact pre-dispatch inventory. */
export async function setMemoryImportances(
  target: MemoryTarget, tags: { text: string; importance: MemoryImportance }[],
  workspaceId: string | undefined, expectedRaw: string | null, signal?: AbortSignal,
): Promise<number> {
  const frozen = structuredClone(tags);
  return withMemoryLock(relPathFor(target, workspaceId), async () => {
    checkMemoryCancelled(signal);
    const file = await readFile(target, workspaceId);
    if (file.raw !== expectedRaw) return 0;
    const seen = new Set<string>();
    for (const tag of frozen) {
      if (seen.has(tag.text) || !normalizeImportance(tag.importance) ||
          file.entries.filter((entry) => entry.text === tag.text && !entry.importance).length !== 1) return 0;
      seen.add(tag.text);
    }
    if (!frozen.length) return 0;
    const byText = new Map(frozen.map((tag) => [tag.text, tag.importance]));
    const entries = file.entries.map((entry) => byText.has(entry.text) ? { ...entry, importance: byText.get(entry.text)! } : entry);
    await writeFile(target, { version: 2, entries }, workspaceId, file.raw, undefined, signal);
    return frozen.length;
  });
}

/**
 * Usage snapshot for one store — used for the snapshot footer and UI meters.
 */
export interface MemoryUsage {
  target: MemoryTarget;
  used: number;
  limit: number;
  pct: number;
  entries: MemoryEntry[];
}

/** Compute `used/limit/pct` for a target (pct is 0-100, rounded). */
export async function getMemoryUsage(
  target: MemoryTarget,
  workspaceId?: string,
): Promise<MemoryUsage> {
  const entries = await loadMemory(target, workspaceId);
  const limit = limitFor(target);
  const used = charCount(entries);
  const pct = limit > 0 ? Math.round((used / limit) * 100) : 0;
  return { target, used, limit, pct, entries };
}

function pctText(used: number, limit: number): string {
  const pct = limit > 0 ? Math.round((used / limit) * 100) : 0;
  return `${pct}%`;
}

/** Shared renderer: full snapshot when `maxChars` is undefined, else bounded. */
function renderSnapshotText(
  userEntries: MemoryEntry[],
  memEntries: MemoryEntry[],
  maxChars?: number,
): string {
  if (!userEntries.length && !memEntries.length) return '';

  const memUsed = charCount(memEntries);
  const userUsed = charCount(userEntries);
  const memLimit = limitFor('memory');
  const userLimit = limitFor('user');
  const memHot = memLimit > 0 && memUsed >= (memLimit * nudgeThresholdPct) / 100;
  const userHot = userLimit > 0 && userUsed >= (userLimit * nudgeThresholdPct) / 100;

  if (maxChars === undefined) {
    const lines: string[] = ['\n\n【长期记忆（会话开始时的快照，仅供参考）】'];
    if (userEntries.length) {
      lines.push('用户画像（关于用户是谁、其偏好与风格）：');
      userEntries.forEach((e) => lines.push(`- ${e.text}`));
    }
    if (memEntries.length) {
      lines.push('助手笔记（环境、引擎、约定、工具怪癖、经验）：');
      memEntries.forEach((e) => lines.push(`- ${e.text}`));
    }
    lines.push(
      '以上为持久记忆快照；若与本回合用户的最新指令冲突，以用户最新指令为准。',
    );
    lines.push(
      `【记忆用量】助手笔记 ${memUsed}/${memLimit} 字（${pctText(memUsed, memLimit)}），用户画像 ${userUsed}/${userLimit} 字（${pctText(userUsed, userLimit)}）。`,
    );
    if (memHot || userHot) {
      const which = [memHot && '助手笔记', userHot && '用户画像'].filter(Boolean).join('、');
      lines.push(
        `⚠ ${which}已接近字数上限：写入新记忆前，请先在同一个记忆块里用 remove/replace 合并或删除过期条目，腾出空间再 add。`,
      );
    }
    return lines.join('\n');
  }

  // Compact form for argv-capped adapters (dsh / zcode). Dense, one line per
  // section, truncated to the budget while always keeping the head + usage.
  const parts: string[] = [];
  if (userEntries.length) {
    parts.push(`用户画像：${userEntries.map((e) => e.text).join('；')}`);
  }
  if (memEntries.length) {
    parts.push(`助手笔记：${memEntries.map((e) => e.text).join('；')}`);
  }
  const usage = `用量：笔记 ${memUsed}/${memLimit}（${pctText(memUsed, memLimit)}），画像 ${userUsed}/${userLimit}（${pctText(userUsed, userLimit)}）`;
  const nudge = memHot || userHot ? '；接近上限，写前请先合并/删除旧条目' : '';
  let body = `\n\n【长期记忆】${parts.join(' | ')}（${usage}${nudge}）`;
  if (body.length > maxChars) {
    body = `${body.slice(0, Math.max(0, maxChars - 1))}…`;
  }
  return body;
}

/**
 * Render the frozen system-prompt snapshot. Read ONCE at session start and
 * concatenated into the chat system prompt. Returns '' when both stores are
 * empty so nothing is injected. `workspaceId` selects the project-scoped
 * `memory` notes to merge alongside the global `user` profile. See the
 * file-level CONTRACT before changing.
 */
export async function renderMemorySnapshot(workspaceId?: string): Promise<string> {
  const [userEntries, memEntries] = await Promise.all([
    loadMemory('user'),
    loadMemory('memory', workspaceId),
  ]);
  return renderSnapshotText(userEntries, memEntries);
}

/**
 * Bounded snapshot for adapters that pass the whole prompt through a single,
 * size-capped command-line argument (dsh / zcode). Same data, truncated to
 * `maxChars` so memory still reaches the model instead of being dropped.
 */
export async function renderMemorySnapshotCompact(
  workspaceId?: string,
  maxChars = 600,
  freezeKey?: string,
): Promise<string> {
  if (freezeKey !== undefined) {
    const text = (await frozenSessionSnapshot(workspaceId, freezeKey)).compact;
    return text.length > maxChars ? `${text.slice(0, Math.max(0, maxChars - 1))}…` : text;
  }
  const [userEntries, memEntries] = await Promise.all([
    loadMemory('user'),
    loadMemory('memory', workspaceId),
  ]);
  return renderSnapshotText(userEntries, memEntries, maxChars);
}




/**
 * Session-frozen variant of `renderMemorySnapshot`. Caches the rendered block
 * by `freezeKey` (the chat session id) so a mid-session write can never change
 * the live system prompt — preserving the native-CLI prefix cache. A new
 * freeze key (new session) re-reads disk.
 */
export async function renderFrozenMemorySnapshot(
  workspaceId: string | undefined,
  freezeKey: string,
): Promise<string> {
  return (await frozenSessionSnapshot(workspaceId, freezeKey)).full;
}

function frozenSessionSnapshot(workspaceId: string | undefined, freezeKey: string) {
  return loadFrozenSnapshot(workspaceId, freezeKey, async () => {
    const [user, memory] = await Promise.all([loadMemory('user'), loadMemory('memory', workspaceId)]);
    return { full: renderSnapshotText(user, memory), compact: renderSnapshotText(user, memory, Number.MAX_SAFE_INTEGER) };
  });
}

/** Drop every cached frozen snapshot (tests / force-refresh). */
export function resetFrozenMemorySnapshot(): void {
  resetSnapshotCache();
}

/** Release runtime ownership only; reopening the session restores its durable original. */
export const releaseFrozenMemorySnapshot = releaseFrozenSnapshot;

/**
 * Apply parsed memory-write requests (from core/memoryProtocol) to disk. Each
 * request is one atomic batch against its target store. Returns the per-request
 * results so callers can log/surface failures. Never throws — a bad request is
 * reported as an unsuccessful result so a memory write can't break a chat turn.
 */
export async function applyMemoryWrites(
  requests: { target: MemoryTarget; operations: MemoryOp[] }[],
  workspaceId?: string,
  opts?: MemoryBatchOptions,
): Promise<MemoryResult[]> {
  const validated = normalizeMemoryRequests(requests);
  if (!validated) return requests.map((req) => result(req.target, [], false, 'Invalid memory submission; entire payload rejected'));
  const results: MemoryResult[] = [];
  for (const req of validated) {
    try {
      results.push(await applyMemoryBatch(req.target, req.operations, workspaceId, opts));
    } catch (err) {
      results.push(
        result(
          req.target,
          [],
          false,
          err instanceof Error ? err.message : String(err),
        ),
      );
    }
  }
  return results;
}
