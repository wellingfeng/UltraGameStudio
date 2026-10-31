/**
 * CONTRACT: the consolidation-retry loop for the memory review path.
 *
 * Hermes' memory tool handles a full store in three moves: (1) on overflow it
 * REFUSES to write and echoes the current entries back, telling the model to
 * merge; (2) a batch is applied atomically and the char limit is checked only
 * on the FINAL result, so one call can remove/replace to free room AND add;
 * (3) it caps retries at 3 so the model never loops forever.
 *
 * Moves (2) is already enforced inside lib/memoryStore.ts (`applyMemoryBatch`
 * checks the limit only on the final working set). This module wires up moves
 * (1) and (3): it runs the review model, applies whatever it proposes, and when
 * a batch is rejected (overflow / bad oldText / etc.) it formats the rejection
 * with the CURRENT entries and re-invokes the model to consolidate and retry,
 * up to MAX_CONSOLIDATE_RETRIES additional attempts.
 *
 * The model still decides what to remove/merge — nothing is silently dropped.
 * `evictOnOverflow` stays a separate mechanical fallback and is passed through
 * untouched.
 *
 * This module owns the loop; the caller owns the model invocation (its gateway
 * selection differs between the manual refresh and the background self-review).
 */

import {
  REVIEW_SYSTEM,
  DIGEST_SYSTEM,
  buildDigestUserPrompt,
  buildReviewUserPrompt,
  buildConsolidateFeedback,
  buildConsolidateRetryPrompt,
  joinDigestAndTail,
  splitTranscriptForDigest,
  DIGEST_MAX_RATIO,
  MAX_CONSOLIDATE_RETRIES,
} from '@/core/memoryReview';
import { parseMemoryWrites, type MemoryTarget } from '@/core/memoryProtocol';
import { applyMemoryBatch, getMemoryLimits, readMemoryBase, type MemoryBase, type MemoryResult } from '@/lib/memoryStore';
import type { MemoryReviewSource } from './memoryPending';

export interface ConsolidatingReviewOptions {
  signal?: AbortSignal;
  /** Default true: any remove/replace (including accompanying adds) is queued. */
  unattended?: boolean;
  /** Trusted caller identity and exact host snapshots; never model fields. */
  reviewSource?: MemoryReviewSource;
  bases?: Partial<Record<MemoryTarget, MemoryBase>>;
  /** Runs one fresh model call; system is REVIEW_SYSTEM (passed through). */
  invokeModel: (system: string, userContent: string) => Promise<string>;
  /** The bounded transcript of what to review. */
  transcript: string;
  /**
   * Raw messages for the two-stage digest path: when given (and summarize is
   * set), the overflow head is model-compressed into a digest that is
   * prepended to the verbatim tail instead of being discarded.
   */
  messages?: { role: string; text: string }[];
  /** Current-store snapshot blocks to inject on the first attempt. */
  contexts?: string[];
  /** Scopes the `memory` store; ignored for `user`. */
  workspaceId?: string;
  /** Passed straight through to the write; off means over-limit rejects. */
  evictOnOverflow?: boolean;
  /** Restrict applied writes to one store (refresh scope); undefined = both. */
  target?: MemoryTarget;
  /** Source label recorded on queued writes (approvalMode 'queue'). */
  source?: 'review' | 'refresh';
  /**
   * Two-stage digest (summary replay): when the transcript overflows its
   * budget, `summarize` compresses the overflow head into dense facts that
   * are prepended to the verbatim tail. Omit → legacy truncate-keep-tail.
   * Should point at the cheap review model; failures fall back to truncation.
   */
  summarize?: (system: string, userContent: string) => Promise<string>;
  /** Extra retries past the first attempt (default MAX_CONSOLIDATE_RETRIES). */
  maxRetries?: number;
  /**
   * 'direct' (default) applies writes to the store immediately. 'queue' stages
   * them into the pending-approval list instead (lib/memoryPending.ts) — used
   * when approvalRequired is on, for autonomous/unsupervised review paths.
   */
  approvalMode?: 'direct' | 'queue';
  /** Host-owned live policy, never parsed from model output. May throw to fail closed. */
  getWritePolicy?: () => 'direct' | 'queue';
}

export interface ConsolidatingReviewResult {
  /** Total model invocations made (1 + successful retries, capped). */
  attempts: number;
  /** Operations actually persisted across all rounds (add/replace/remove). */
  appliedOps: number;
  wroteUser: boolean;
  wroteMemory: boolean;
  /** Error strings from the final round's rejections (empty when settled). */
  lastErrors: string[];
  /** Ops staged for approval instead of applied (approvalMode 'queue'). */
  queuedOps: number;
}

/** Only this host guard can redirect a prepared write into the approval queue. */
class MemoryApprovalRequiredError extends Error {}

export async function runConsolidatingReview(
  opts: ConsolidatingReviewOptions,
): Promise<ConsolidatingReviewResult> {
  // Snapshot caller data synchronously. Functions and AbortSignal stay shared.
  opts = { ...opts, messages: opts.messages ? structuredClone(opts.messages) : undefined,
    contexts: opts.contexts ? [...opts.contexts] : undefined,
    reviewSource: opts.reviewSource ? structuredClone(opts.reviewSource) : undefined,
    bases: opts.bases ? structuredClone(opts.bases) : {} };
  const signal = opts.signal;
  const invokeModel = opts.invokeModel; // one caller-frozen budget owner for every stage
  const checkCancelled = () => { if (signal?.aborted) throw new DOMException('Memory review cancelled', 'AbortError'); };
  checkCancelled();
  if (opts.reviewSource && opts.reviewSource.workspaceId !== (opts.workspaceId ?? '')) throw new Error('Memory source/workspace mismatch');
  const bases = opts.bases!;
  for (const target of ['user', 'memory'] as const) {
    if (opts.target && target !== opts.target) continue;
    bases[target] ??= await readMemoryBase(target, target === 'memory' ? opts.workspaceId : undefined);
    if (bases[target]!.target !== target || (target === 'memory' && bases[target]!.workspaceId !== opts.workspaceId)) throw new Error('Memory base/target mismatch');
    checkCancelled();
  }
  const maxAttempts = 1 + Math.max(0, opts.maxRetries ?? MAX_CONSOLIDATE_RETRIES);
  let appliedOps = 0;
  let wroteUser = false;
  let wroteMemory = false;
  let queuedOps = 0;
  let lastErrors: string[] = [];
  let attempts = 0;
  let approvalRequired = opts.approvalMode === 'queue';
  const requiresApproval = () => {
    const live = opts.getWritePolicy?.(); // evaluate even if already strict: disabled must fail closed
    approvalRequired ||= live === 'queue';
    return approvalRequired;
  };
  const beforeDispatch = () => {
    if (requiresApproval()) throw new MemoryApprovalRequiredError('Memory approval required before dispatch');
  };

  // Two-stage digest: compress the overflow head instead of dropping it.
  // Runs whenever raw messages + summarize are provided; on any digest
  // failure the caller's pre-built (truncated) transcript is the fallback.
  let digestUsed = false;
  let userContent = '';
  if (opts.messages?.length && opts.summarize) {
    const overflow = splitTranscriptForDigest(opts.messages);
    if (overflow) {
      const digestMax = Math.max(
        200,
        Math.floor(DIGEST_MAX_RATIO * (overflow.overflow.length + overflow.tail.length)),
      );
      try {
        checkCancelled();
        const digest = await invokeModel(
          DIGEST_SYSTEM,
          buildDigestUserPrompt(overflow.overflow, digestMax),
        );
        checkCancelled();
        userContent = buildReviewUserPrompt(
          joinDigestAndTail(digest.slice(0, digestMax), overflow.tail),
          opts.contexts ?? [],
        );
        digestUsed = true;
      } catch {
        checkCancelled();
        /* digest is best-effort; fall back to the caller's transcript */
      }
    }
  }
  if (!digestUsed) {
    userContent = buildReviewUserPrompt(opts.transcript, opts.contexts ?? []);
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attempts = attempt;
    checkCancelled();
    const out = await invokeModel(REVIEW_SYSTEM, userContent);
    checkCancelled();
    const parsed = parseMemoryWrites(out);
    const proposals = (['user', 'memory'] as const).filter((target) => !opts.target || target === opts.target)
      .map((target) => ({ target, operations: parsed.filter((request) => request.target === target).flatMap((request) => request.operations) }))
      .filter((request) => request.operations.length);
    if (!proposals.length) {
      // "无" / nothing emitted — the review is done, nothing to retry.
      lastErrors = [];
      break;
    }

    const stage = async (pending: typeof proposals) => {
      const { queuePendingMemoryWrites } = await import('./memoryPending');
      checkCancelled();
      requiresApproval();
      queuedOps += await queuePendingMemoryWrites(
        pending,
        opts.source ?? 'review',
        opts.workspaceId,
        { reviewSource: opts.reviewSource, bases, signal },
      );
      for (const p of pending) {
        if (p.target === 'user') wroteUser = true;
        if (p.target === 'memory') wroteMemory = true;
      }
      // Staged ops are NOT counted as appliedOps — the caller reports them
      // separately via queuedOps (they have not hit the store yet).
    };
    if (requiresApproval() || (opts.unattended !== false &&
        proposals.some((proposal) => proposal.operations.some((op) => op.action !== 'add')))) {
      await stage(proposals);
      lastErrors = [];
      break;
    }

    checkCancelled();
    const results: MemoryResult[] = [];
    let pendingApproval: typeof proposals = [];
    for (const [index, proposal] of proposals.entries()) {
      if (!results.length) checkCancelled();
      const failure = (error: unknown): MemoryResult => ({ success: false, target: proposal.target,
        entries: bases[proposal.target]!.entries,
        used: bases[proposal.target]!.entries.map((entry) => entry.text).join('\n').length,
        limit: getMemoryLimits()[proposal.target], appliedCount: 0, error: String(error) });
      if (signal?.aborted) {
        results.push(failure('Memory review cancelled; remaining library not dispatched'));
        continue;
      }
      try {
        results.push(await applyMemoryBatch(proposal.target, proposal.operations, opts.workspaceId, {
          expectedRaw: bases[proposal.target]!.raw, evictOnOverflow: false, signal,
          beforeDispatch,
        }));
      } catch (error) {
        if (error instanceof MemoryApprovalRequiredError) {
          pendingApproval = proposals.slice(index);
          break;
        }
        if (!results.some((result) => result.success)) throw error;
        // Separate libraries are not a global transaction. Preserve earlier real commits.
        results.push(failure(error));
      }
    }

    const failures: MemoryResult[] = [];
    for (let i = 0; i < results.length; i += 1) {
      const r = results[i];
      if (!r || !r.success) {
        if (r) failures.push(r);
        continue;
      }
      const count = r.appliedCount ?? proposals[i].operations.length - (r.skipped?.length ?? 0);
      appliedOps += count;
      if (count && proposals[i].target === 'user') wroteUser = true;
      if (count && proposals[i].target === 'memory') wroteMemory = true;
    }

    if (pendingApproval.length) {
      try { await stage(pendingApproval); }
      catch (error) {
        if (!appliedOps) throw error;
        // A failed stage cannot undo an earlier library's confirmed commit.
        lastErrors = [...failures.map((failure) => failure.error ?? '未知错误'), String(error)];
        break;
      }
      lastErrors = failures.map((failure) => failure.error ?? '未知错误');
      break; // Same proposal, no model retry or additional billing for a policy change.
    }

    if (!failures.length) {
      lastErrors = [];
      break;
    }

    lastErrors = failures.map((f) => f.error ?? '未知错误');
    if (attempt >= maxAttempts || appliedOps || lastErrors.some((error) => /conflict|recovery/i.test(error))) break;

    userContent = buildConsolidateRetryPrompt(
      opts.transcript,
      failures.map((f) =>
        buildConsolidateFeedback({
          target: f.target,
          error: f.error ?? '未知错误',
          entries: f.entries.map((e) => e.text),
          used: f.used,
          limit: f.limit,
        }),
      ),
    );
  }

  return { attempts, appliedOps, wroteUser, wroteMemory, lastErrors, queuedOps };
}
