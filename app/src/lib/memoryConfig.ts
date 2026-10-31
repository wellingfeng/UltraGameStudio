/**
 * CONTRACT: user-tunable memory system configuration.
 *
 * Small synchronous config blob for the long-term memory features: enable
 * switches, character limits, and background-review parameters. Persisted via
 * the generationSettingsStore write-behind cache (disk under Tauri,
 * localStorage in the browser) so UI `useState(() => load())` initializers can
 * read it synchronously.
 *
 * Defaults are conservative: memory write + recall are ON (cheap, no extra
 * model calls beyond the turn the user already paid for), but background review
 * is OFF by default because it spends model quota autonomously.
 */

import { readSettingsRaw, writeSettingsRaw } from '@/lib/generationSettingsStore';
import { setMemoryLimits, setMemoryNudgeThresholdPct } from '@/lib/memoryStore';
import { readMemoryJson, compareExchangeMemoryJson } from './memoryTransactions';
import type { MemoryReviewSchedulerState } from '@/runtime/memory/review';
import { cancelMemoryReviews } from '@/runtime/memory/review';
import type { MemoryReviewSource } from './memoryPending';
import type { ReviewCompletionUsage } from './modelGateway/reviewCompletionGateway';

const REL_PATH = 'settings/memoryConfig.v1.json';
const LEGACY_KEY = 'ultragamestudio.memoryConfig.v1';


export interface MemoryConfig {
  /** Inject the frozen memory snapshot into the chat system prompt. */
  snapshotEnabled: boolean;
  /** Offer the <<UGS_MEMORY>> write protocol to the model. */
  writeEnabled: boolean;
  /** Offer the <<UGS_RECALL>> history-search protocol to the model. */
  recallEnabled: boolean;
  /** Character cap for the assistant-notes (memory) store. */
  memoryCharLimit: number;
  /** Character cap for the user-profile (user) store. */
  userCharLimit: number;
  /** Background self-review after qualifying turns (spends model quota). */
  reviewEnabled: boolean;
  /** Only review turns with at least this many messages (signal gate). */
  reviewMinMessages: number;
  /** Minimum minutes between background reviews (rate limit). */
  reviewMinIntervalMinutes: number;
  /** Prefer the cheapest model tier for review when routing allows. */
  reviewPreferCheapModel: boolean;
  /**
   * Explicit gateway selection for review calls when reviewPreferCheapModel
   * is on — a haiku-tier pin on the current adapter by default. Stored as a
   * normalized GatewaySelection JSON blob; empty/invalid falls back to the
   * main conversation route.
   */
  reviewModelSelection: {
    adapter: string;
    modelClass: string;
    systemDefault?: boolean;
    providerId?: string;
    channelId?: string;
  } | null;
  /** When a memory write overflows, evict the oldest entries instead of rejecting. */
  evictOnOverflow: boolean;
  /** Usage percentage at which the snapshot appends a "consolidate first" nudge. */
  nudgeThresholdPct: number;
  /** Char budget for the compact snapshot injected into argv-capped adapters. */
  compactSnapshotCharLimit: number;
  /**
   * Scan every add/replace for prompt-injection / credentials / invisible
   * Unicode before it lands in the store ('reject' mode). See memorySafety.ts.
   */
  safetyScanEnabled: boolean;
  /**
   * Background-review / manual-refresh writes require explicit approval in the
   * Memory settings panel before they hit the store (Hermes' write_approval).
   * Foreground UGS_MEMORY writes stay direct — the user saw the turn that
   * proposed them.
   */
  approvalRequired: boolean;
  /**
   * Run the AI pre-screen (triage) automatically whenever new writes land in
   * the pending queue — the user only ever sees what survived the AI pass.
   * Requires approvalRequired; reuses the review model route.
   */
  triageAutoRun: boolean;
}

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  snapshotEnabled: true,
  writeEnabled: true,
  recallEnabled: true,
  memoryCharLimit: 2200,
  userCharLimit: 1375,
  reviewEnabled: false,
  reviewMinMessages: 6,
  reviewMinIntervalMinutes: 30,
  reviewPreferCheapModel: true,
  reviewModelSelection: null,
  evictOnOverflow: false,
  nudgeThresholdPct: 85,
  compactSnapshotCharLimit: 600,
  safetyScanEnabled: true,
  approvalRequired: false,
  triageAutoRun: true,
};

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

type ReviewSelection = MemoryConfig['reviewModelSelection'];

function coerceReviewSelection(raw: unknown): ReviewSelection {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const adapter =
    obj.adapter === 'codex' || obj.adapter === 'gemini' ? obj.adapter : 'claude-code';
  const modelClass =
    typeof obj.modelClass === 'string' && obj.modelClass.trim()
      ? obj.modelClass.trim()
      : 'haiku';
  return {
    adapter,
    modelClass,
    ...(obj.systemDefault === true ? { systemDefault: true as const } : {}),
    ...(typeof obj.providerId === 'string' && obj.providerId
      ? { providerId: obj.providerId }
      : {}),
    ...(typeof obj.channelId === 'string' && obj.channelId
      ? { channelId: obj.channelId }
      : {}),
  };
}

function coerce(raw: Partial<MemoryConfig> | null | undefined): MemoryConfig {
  const d = DEFAULT_MEMORY_CONFIG;
  if (!raw || typeof raw !== 'object') return { ...d };
  return {
    snapshotEnabled: raw.snapshotEnabled ?? d.snapshotEnabled,
    writeEnabled: raw.writeEnabled ?? d.writeEnabled,
    recallEnabled: raw.recallEnabled ?? d.recallEnabled,
    memoryCharLimit: clampInt(raw.memoryCharLimit, d.memoryCharLimit, 200, 20000),
    userCharLimit: clampInt(raw.userCharLimit, d.userCharLimit, 200, 20000),
    reviewEnabled: raw.reviewEnabled ?? d.reviewEnabled,
    reviewMinMessages: clampInt(raw.reviewMinMessages, d.reviewMinMessages, 2, 100),
    reviewMinIntervalMinutes: clampInt(
      raw.reviewMinIntervalMinutes,
      d.reviewMinIntervalMinutes,
      0,
      1440,
    ),
    reviewPreferCheapModel: raw.reviewPreferCheapModel ?? d.reviewPreferCheapModel,
    reviewModelSelection: coerceReviewSelection(raw.reviewModelSelection),
    evictOnOverflow: raw.evictOnOverflow ?? d.evictOnOverflow,
    nudgeThresholdPct: clampInt(raw.nudgeThresholdPct, d.nudgeThresholdPct, 50, 100),
    compactSnapshotCharLimit: clampInt(
      raw.compactSnapshotCharLimit,
      d.compactSnapshotCharLimit,
      200,
      4000,
    ),
    safetyScanEnabled: raw.safetyScanEnabled ?? d.safetyScanEnabled,
    approvalRequired: raw.approvalRequired ?? d.approvalRequired,
    triageAutoRun: raw.triageAutoRun ?? d.triageAutoRun,
  };
}

/** Synchronous read. Also syncs the live char limits into memoryStore. */
export function loadMemoryConfig(): MemoryConfig {
  let parsed: Partial<MemoryConfig> | null = null;
  try {
    const raw = readSettingsRaw(REL_PATH, LEGACY_KEY);
    if (raw) parsed = JSON.parse(raw) as Partial<MemoryConfig>;
  } catch {
    parsed = null;
  }
  const config = coerce(parsed);
  setMemoryLimits({ memory: config.memoryCharLimit, user: config.userCharLimit });
  setMemoryNudgeThresholdPct(config.nudgeThresholdPct);
  return config;
}

/** Synchronous write-behind. Applies char limits to the live memoryStore. */
export function saveMemoryConfig(config: MemoryConfig): MemoryConfig {
  const next = coerce(config);
  writeSettingsRaw(REL_PATH, LEGACY_KEY, JSON.stringify(next));
  setMemoryLimits({ memory: next.memoryCharLimit, user: next.userCharLimit });
  setMemoryNudgeThresholdPct(next.nudgeThresholdPct);
  if (!next.reviewEnabled || !next.writeEnabled) cancelMemoryReviews();

  return next;
}

export interface MemoryReviewJournalJob {
  id: string; source: MemoryReviewSource;
  phase: 'reading' | 'applied' | 'awaiting_approval' | 'noop' | 'failed' | 'cancelled';
  appliedOps: number; queuedOps: number; updatedAt: number;
  /** Exact assistant captured by the producer; absent in legacy journals. */
  assistantMessageId?: string;
  error?: string; usage?: ReviewCompletionUsage; recordingError?: string;
}
export interface MemoryReviewJournal { version: 1; scheduler: MemoryReviewSchedulerState; jobs: MemoryReviewJournalJob[] }
export const MEMORY_REVIEW_JOURNAL_PATH = 'memories/review-jobs.v1.json';
function validMemoryReviewJournal(value: unknown): value is MemoryReviewJournal {
  const record = (entry: unknown): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && !Array.isArray(entry);
  const knownFields = (entry: Record<string, unknown>, keys: string[]) => Object.keys(entry).every(key => keys.includes(key));
  const text = (entry: unknown): entry is string => typeof entry === 'string' && entry.length > 0;
  const count = (entry: unknown) => typeof entry === 'number' && Number.isSafeInteger(entry) && entry >= 0;
  const strings = (entry: unknown, max: number): entry is string[] => Array.isArray(entry) && entry.length <= max &&
    entry.every(text) && new Set(entry).size === entry.length;
  const pairs = (entry: unknown, max: number, validValue: (entry: unknown) => boolean) => Array.isArray(entry) && entry.length <= max &&
    entry.every((pair) => Array.isArray(pair) && pair.length === 2 && text(pair[0]) && validValue(pair[1])) &&
    new Set(entry.map((pair) => pair[0])).size === entry.length;
  const validFence = (fence: unknown) => fence === undefined || (Array.isArray(fence) && fence.length === 2048 &&
    fence.every((word) => count(word) && (word as number) <= 0xffffffff));
  if (!record(value) || !knownFields(value, ['version', 'scheduler', 'jobs']) || value.version !== 1 ||
      !record(value.scheduler) || !Array.isArray(value.jobs) || value.jobs.length > 100) return false;
  const scheduler = value.scheduler;
  if (!knownFields(scheduler, ['consumed', 'attempted', 'lastCompleted', 'consumedFence', 'attemptedFence']) ||
      !pairs(scheduler.consumed, 128, (ids) => strings(ids, 256)) || !strings(scheduler.attempted, 256) ||
      !pairs(scheduler.lastCompleted, 128, count) || !validFence(scheduler.consumedFence) || !validFence(scheduler.attemptedFence)) return false;
  const seen = new Set<string>();
  return value.jobs.every((job) => {
    if (!record(job) || !knownFields(job, ['id', 'source', 'phase', 'appliedOps', 'queuedOps', 'updatedAt',
        'assistantMessageId', 'error', 'usage', 'recordingError']) || !text(job.id) || seen.has(job.id) || !record(job.source) ||
        !['reading', 'applied', 'awaiting_approval', 'noop', 'failed', 'cancelled'].includes(job.phase as string) ||
        !count(job.appliedOps) || !count(job.queuedOps) || !count(job.updatedAt)) return false;
    seen.add(job.id);
    const source = job.source;
    if (!knownFields(source, ['hostId', 'namespaceId', 'workspaceId', 'sessionId', 'turnId', 'sourceMessageId', 'runId', 'cwd']) ||
        !['hostId', 'namespaceId', 'sessionId', 'turnId', 'sourceMessageId', 'runId'].every((key) => text(source[key])) ||
        typeof source.workspaceId !== 'string' || (source.cwd !== undefined && !text(source.cwd))) return false;
    if ((job.assistantMessageId !== undefined && !text(job.assistantMessageId)) ||
        (job.error !== undefined && typeof job.error !== 'string') ||
        (job.recordingError !== undefined && typeof job.recordingError !== 'string')) return false;
    if (job.usage !== undefined && (!record(job.usage) || !knownFields(job.usage, ['calls', 'inputTokens', 'outputTokens', 'estimated']) ||
        !count(job.usage.calls) || !count(job.usage.inputTokens) ||
        (job.usage.outputTokens !== undefined && !count(job.usage.outputTokens)) || typeof job.usage.estimated !== 'boolean')) return false;
    return true;
  });
}
function parseMemoryReviewJournal(raw: string): MemoryReviewJournal {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('MEMORY_REVIEW_JOURNAL_INVALID'); }
  if (!validMemoryReviewJournal(value)) throw new Error('MEMORY_REVIEW_JOURNAL_INVALID');
  return value;
}
export async function loadMemoryReviewJournal(): Promise<{ raw: string | null; value: MemoryReviewJournal }> {
  const raw = await readMemoryJson(MEMORY_REVIEW_JOURNAL_PATH);
  if (raw === null) return { raw, value: { version: 1, scheduler: { consumed: [], attempted: [], lastCompleted: [] }, jobs: [] } };
  return { raw, value: parseMemoryReviewJournal(raw) };
}
export async function saveMemoryReviewJournal(expectedRaw: string | null, value: MemoryReviewJournal, signal?: AbortSignal): Promise<void> {
  // Match native validation: neither a malformed base nor payload may be repaired by CAS.
  if (expectedRaw !== null) parseMemoryReviewJournal(expectedRaw);
  if (!validMemoryReviewJournal(value)) throw new Error('MEMORY_REVIEW_JOURNAL_INVALID');
  await compareExchangeMemoryJson(MEMORY_REVIEW_JOURNAL_PATH, expectedRaw, JSON.stringify(value), signal);
}

// --- background-review rate-limit timestamp ---------------------------------
// Stored separately from the config blob so writing a review timestamp does not
// race the user editing settings. Scoped per-workspace so one project's review
// cadence doesn't gate another's.

const REVIEW_TS_REL = 'settings/memoryReviewState.v1.json';
const REVIEW_TS_KEY = 'ultragamestudio.memoryReviewState.v1';

type ReviewState = Record<string, number>;

function readReviewState(): ReviewState {
  try {
    const raw = readSettingsRaw(REVIEW_TS_REL, REVIEW_TS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object') return parsed as ReviewState;
    }
  } catch {
    /* fall through to empty */
  }
  return {};
}

/** Last background-review epoch-ms for a workspace (0 if never). */
export function getLastReviewAt(workspaceId: string): number {
  const state = readReviewState();
  const v = state[workspaceId || '_global'];
  return typeof v === 'number' ? v : 0;
}

/** Record a background-review run time for a workspace. */
export function setLastReviewAt(workspaceId: string, at: number = Date.now()): void {
  const state = readReviewState();
  state[workspaceId || '_global'] = at;
  writeSettingsRaw(REVIEW_TS_REL, REVIEW_TS_KEY, JSON.stringify(state));
}
