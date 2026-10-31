/**
 * CONTRACT: manual "refresh memory from recent history" for the Settings →
 * Memory panel.
 *
 * The background self-review loop (core/memoryReview.ts) only replays the
 * transcript of the turn that just finished. This module is the on-demand
 * counterpart: it walks the persisted chat history for the last N days, builds
 * one bounded transcript, asks the SAME review prompts to extract durable
 * facts, and applies the resulting <<UGS_MEMORY>> writes to disk.
 *
 * Two scopes, mirroring the two memory stores (lib/memoryStore.ts):
 *   - 'global'  → user profile (`user` store, global): reviews ALL workspaces
 *     because "who the user is" spans projects, and only applies `user` writes.
 *   - 'project' → assistant notes (`memory` store, per-workspace): reviews only
 *     the given workspace and only applies `memory` writes.
 *
 * The write lands on the NEXT session's frozen snapshot — it never mutates the
 * live system prompt (see memoryStore.ts CONTRACT).
 */

import { historyStore } from '@/store/history/store';
import { buildReviewTranscript, formatReviewMemoryContext } from '@/core/memoryReview';
import { readMemoryBase, getMemoryLimits } from '@/lib/memoryStore';
import { readPersistedSkillSourceSession } from '@/lib/skills';
import type { MemoryReviewSource } from './memoryPending';
import { isMemoryReviewMessageInWindow } from './memoryHistoryWindow';
import { acquireReviewBackground } from '@/runtime/memory/review';
import { runConsolidatingReview } from '@/lib/memoryConsolidate';
import { autotagMemoryEntries } from '@/lib/memoryAutotag';
import { createReviewCompletionInvoker, type ReviewCompletionOptions, type ReviewCompletionInvoker, type ReviewCompletionUsage } from '@/lib/modelGateway/reviewCompletionGateway';
import type { MemoryConfig } from '@/lib/memoryConfig';
import { loadMemoryConfig } from '@/lib/memoryConfig';
import {
  getDefaultGatewaySelection,
  getExplicitActiveGatewaySelection,
} from '@/lib/gatewayConfig';

export type RefreshScope = 'global' | 'project';

export interface RefreshMemoryOptions {
  signal?: AbortSignal;
  budget?: Omit<ReviewCompletionOptions, 'signal'>;
  scope: RefreshScope;
  /** Number of days of history to review (min 1). */
  days: number;
  /** Workspace id for the 'project' scope; ignored for 'global'. */
  workspaceId?: string;
  /** Evict oldest entries when a write overflows (mirrors MemoryConfig). */
  evictOnOverflow?: boolean;
  /**
   * Queue writes for approval in the Memory panel instead of applying them
   * (mirrors MemoryConfig.approvalRequired).
   */
  approvalRequired?: boolean;
  /** Cap on the review transcript size in chars. Default 12_000. */
  maxTranscriptChars?: number;
  /** Cap on how many sessions to load (most recent kept). Default 60. */
  maxSessions?: number;
}

export interface RefreshMemoryResult {
  usage?: ReviewCompletionUsage;
  source?: MemoryReviewSource;
  ok: boolean;
  scope: RefreshScope;
  /** Number of sessions whose messages were loaded (within the window). */
  sessionsScanned: number;
  /** Number of user/assistant messages folded into the transcript. */
  messagesScanned: number;
  /** Number of memory operations applied (add/replace/remove). */
  appliedOps: number;
  /** Operations staged into the pending-approval queue instead of applied. */
  queuedOps: number;
  /** Legacy untagged entries that received an AI-suggested importance tier. */
  taggedEntries: number;
  wroteUser: boolean;
  wroteMemory: boolean;
  error?: string;
}

const DAY_MS = 86_400_000;
const DEFAULT_MAX_TRANSCRIPT_CHARS = 12_000;
const DEFAULT_MAX_SESSIONS = 60;

/**
 * Best-effort AI pass that tags legacy untagged entries in one store. Runs on
 * every refresh — already-tagged entries are never re-rated, so a user's
 * manual override survives. Returns the tagged count (0 on any failure).
 */
async function autotagTarget(
  target: 'user' | 'memory',
  workspaceId: string | undefined,
  invokeModel: ReturnType<typeof makeReviewInvoker>,
  signal?: AbortSignal,
): Promise<{ taggedEntries: number }> {
  try {
    const autotag = await autotagMemoryEntries({
      target,
      workspaceId,
      invokeModel,
      signal,
    });
    return { taggedEntries: autotag.tagged };
  } catch (err) {
    console.warn('[memory] autotag pass failed (best-effort):', err);
    return { taggedEntries: 0 };
  }
}

export async function refreshMemoryFromHistory(
  options: RefreshMemoryOptions,
): Promise<RefreshMemoryResult> {
  const scope = options.scope;
  const days = Math.max(1, Math.floor(options.days || 10));
  const now = Date.now();
  const cutoff = now - days * DAY_MS;
  const maxTranscriptChars =
    options.maxTranscriptChars ?? DEFAULT_MAX_TRANSCRIPT_CHARS;
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  let invokeModel: ReviewCompletionInvoker | undefined;
  let slot: ReturnType<typeof acquireReviewBackground>;

  try {
    const config = loadMemoryConfig();
    if (!config.writeEnabled) throw new Error('MEMORY_WRITE_DISABLED');
    slot = acquireReviewBackground();
    if (!slot) throw new Error('MEMORY_REVIEW_FOREGROUND_BUSY');
    options = { ...options, signal: options.signal ? AbortSignal.any([options.signal, slot.signal]) : slot.signal };
    invokeModel = makeReviewInvoker(config, undefined, { ...options.budget, signal: options.signal });
    // Reads self-heal: listSessions() rebuilds its index lazily from the session
    // files when out of date, and listWorkspaces() returns [] when uninitialized.
    const workspaceIds =
      scope === 'global'
        ? (await historyStore.listWorkspaces()).map((w) => w.id).filter(Boolean)
        : [options.workspaceId].filter((v): v is string => !!v);

    // Collect in-window sessions across the selected scope. Sort newest-first,
    // keep the most recent `maxSessions`, then reverse to oldest-first so the
    // tail-kept truncation in buildReviewTranscript retains the newest content.
    const candidates: { wsId: string; sessionId: string; updatedAt: number }[] = [];
    for (const wsId of workspaceIds) {
      const summaries = await historyStore.listSessions(wsId);
      for (const summary of summaries) {
        if (summary.updatedAt >= cutoff) {
          candidates.push({
            wsId,
            sessionId: summary.id,
            updatedAt: summary.updatedAt,
          });
        }
      }
    }
    candidates.sort((a, b) => b.updatedAt - a.updatedAt);
    const qualifying = candidates.slice(0, maxSessions).reverse();

    const messages: { role: string; text: string }[] = [];
    let reviewSource: MemoryReviewSource | undefined;
    for (const { wsId, sessionId } of qualifying) {
      const record = await readPersistedSkillSourceSession(wsId, sessionId);
      if (!record) continue;
      if (record.workspaceId !== wsId || (record.sessionId ?? record.id) !== sessionId || record.deletedAt) throw new Error('MEMORY_SOURCE_NOT_PERSISTED');
      for (const msg of record.messages) {
        if (!isMemoryReviewMessageInWindow(msg, cutoff, now) || msg.localOnly) continue;
        const text = msg.text?.trim();
        if (!text) continue;
        messages.push({ role: msg.role, text });
        if (msg.role === 'user' && msg.id) reviewSource = {
          hostId: 'local', namespaceId: 'local', workspaceId: wsId, sessionId,
          sourceMessageId: msg.id, turnId: msg.id, runId: crypto.randomUUID(),
        };
      }
    }

    const sessionsScanned = qualifying.length;
    const messagesScanned = messages.length;
    const target = scope === 'global' ? 'user' : 'memory';
    if (messagesScanned === 0) {
      // No persisted source means no model or metadata-write authority.
      return {
        ok: true,
        scope,
        sessionsScanned,
        messagesScanned: 0,
        appliedOps: 0,
        queuedOps: 0,
        taggedEntries: 0,
        wroteUser: false,
        wroteMemory: false,
      };
    }

    const transcript = buildReviewTranscript(messages, maxTranscriptChars);

    // Give the review model the live inventory of the target store so it can
    // consolidate (merge overlap / drop stale) before adding — mirroring the
    // "current entries on overflow" affordance in Hermes' memory tool. Without
    // this a full store rejects every add and the review never writes again.
    if (!reviewSource) throw new Error('MEMORY_SOURCE_USER_MESSAGE_REQUIRED');
    const base = await readMemoryBase(target, target === 'memory' ? options.workspaceId : undefined);
    const usage = { entries: base.entries, used: base.entries.map((entry) => entry.text).join('\n').length, limit: getMemoryLimits()[target] };
    const context = formatReviewMemoryContext({
      label: target === 'user' ? '用户画像（全局）' : '助手笔记（本项目）',
      entries: usage.entries,
      used: usage.used,
      limit: usage.limit,
    });

    const out = await runConsolidatingReview({
      invokeModel,
      transcript,
      // Two-stage summary replay: compress the overflow head into a digest
      // instead of dropping it (buildReviewTranscript stays the fallback).
      messages,
      summarize: invokeModel,
      contexts: [context],
      workspaceId: reviewSource.workspaceId,
      reviewSource,
      bases: { [target]: base },
      signal: options.signal,
      unattended: false,
      evictOnOverflow: options.evictOnOverflow,
      target,
      approvalMode: options.approvalRequired || config.approvalRequired ? 'queue' : 'direct',
      getWritePolicy: () => {
        const live = loadMemoryConfig();
        // Manual refresh does not require background reviewEnabled, but writes must stay enabled.
        if (!config.writeEnabled || !live.writeEnabled) throw new DOMException('Memory refresh cancelled: write disabled', 'AbortError');
        return options.approvalRequired || config.approvalRequired || live.approvalRequired ? 'queue' : 'direct';
      },
      source: 'refresh',
    });

    // 自动打标：给存量未评级条目补上 must/important/minor（元数据-only，
    // 不改文本/时间，所以 approvalRequired 队列模式也直接生效）。
    const { taggedEntries } = await autotagTarget(target, options.workspaceId, invokeModel, options.signal);

    return {
      ok: out.lastErrors.length === 0,
      scope,
      sessionsScanned,
      messagesScanned,
      appliedOps: out.appliedOps,
      queuedOps: out.queuedOps,
      wroteUser: out.wroteUser,
      wroteMemory: out.wroteMemory,
      taggedEntries,
      usage: invokeModel.usage,
      source: reviewSource,
      ...(out.lastErrors.length ? { error: out.lastErrors.join('; ') } : {}),
    };
  } catch (err) {
    return {
      ok: false,
      scope,
      sessionsScanned: 0,
      messagesScanned: 0,
      appliedOps: 0,
      queuedOps: 0,
      taggedEntries: 0,
      wroteUser: false,
      wroteMemory: false,
      error: err instanceof Error ? err.message : String(err),
      usage: invokeModel?.usage,
    };
  } finally {
    slot?.release();
  }
}

/** Run review through completion-only HTTP. Missing routes fail closed. */
export async function completeReview(system: string, userContent: string): Promise<string> {
  const selection =
    getExplicitActiveGatewaySelection() ?? getDefaultGatewaySelection();
  return createReviewCompletionInvoker(selection)(system, userContent);
}

/**
 * Review model invocation honoring `reviewPreferCheapModel` +
 * `reviewModelSelection` (MemoryConfig): when the pin is set, resolve THAT
 * selection once, without inheriting the main conversation's tools on failure.
 * Shared by the background self-review (useStore) and the manual refresh.
 */
export function makeReviewInvoker(
  config: Pick<MemoryConfig, 'reviewPreferCheapModel' | 'reviewModelSelection'>,
  _legacyFallback?: (system: string, userContent: string) => Promise<string>,
  options: ReviewCompletionOptions = {},
): ReviewCompletionInvoker {
  const selection = config.reviewPreferCheapModel && config.reviewModelSelection
    ? config.reviewModelSelection
    : getExplicitActiveGatewaySelection() ?? getDefaultGatewaySelection();
  return createReviewCompletionInvoker(selection, options);
}
