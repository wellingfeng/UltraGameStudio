import { MemoryReviewScheduler, beginReviewForeground, acquireReviewBackground, subscribeReviewAvailable, subscribeReviewCancellation, buildMemoryReviewMessages, type MemoryReviewJob } from '@/runtime/memory/review';
export { beginReviewForeground, acquireReviewBackground, cancelMemoryReviews, cancelReviewBackground } from '@/runtime/memory/review';
import { readMemoryBase, getMemoryLimits } from './memoryStore';
import { loadMemoryConfig, loadMemoryReviewJournal, saveMemoryReviewJournal,
  MEMORY_REVIEW_JOURNAL_PATH, type MemoryReviewJournal } from './memoryConfig';
import { checkMemoryCancelled, withMemoryLock } from './memoryTransactions';
import type { ReviewCompletionInvoker, ReviewCompletionUsage } from './modelGateway/reviewCompletionGateway';
import { makeReviewInvoker } from './memoryRefresh';
import { runConsolidatingReview } from './memoryConsolidate';
import { buildReviewTranscript, formatReviewMemoryContext } from '@/core/memoryReview';
import type { MemoryReviewSource } from './memoryPending';
import { getExplicitActiveGatewaySelection, getDefaultGatewaySelection } from './gatewayConfig';
import { readPersistedSkillSourceSession } from './skills';
import { publishMemoryReview, type MemoryReviewChatState } from './memoryReviewEvents';
export { getMemoryReviewStates, subscribeMemoryReview } from './memoryReviewEvents';

export interface MemoryReviewTurnOptions extends MemoryReviewJob {
  source: MemoryReviewSource;
  ready: Promise<void>;
  signal?: AbortSignal;
}
export interface MemoryReviewOutcome {
  id: string;
  source: MemoryReviewSource;
  assistantMessageId?: string;
  phase: 'applied' | 'awaiting_approval' | 'noop' | 'failed' | 'cancelled';
  appliedOps: number;
  queuedOps: number;
  error?: string;
  updatedAt: number;
  usage?: ReviewCompletionUsage;
  recordingError?: string;
}
/** Only race read-only preparation. Dispatched CAS/transactions still own completion. */
async function waitForReviewSource<T>(ready: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void ready.catch(() => {});
    throw new DOMException('Memory review cancelled', 'AbortError');
  }
  let onAbort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(new DOMException('Memory review cancelled', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([ready, cancelled]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

const waitingSlots = new Set<() => void>();
type ReviewSlot = NonNullable<ReturnType<typeof acquireReviewBackground>>;
/** No journal/fence/model work until an event grants the shared slot. */
function waitForMemorySlot(signal: AbortSignal | undefined, onQueued: () => void): Promise<ReviewSlot> {
  if (waitingSlots.size >= 64) return Promise.reject(new Error('MEMORY_REVIEW_QUEUE_CAPACITY'));
  return new Promise((resolve, reject) => {
    let settled = false;
    let stopAvailable = () => {};
    let stopCancellation = () => {};
    const cleanup = () => {
      stopAvailable(); stopCancellation();
      signal?.removeEventListener('abort', cancelled);
      waitingSlots.delete(cancelled);
    };
    const cancelled = () => {
      if (settled) return;
      settled = true; cleanup();
      reject(new DOMException('Memory review cancelled before dispatch', 'AbortError'));
    };
    const available = () => {
      if (settled) return;
      if (signal?.aborted) { cancelled(); return; }
      const slot = acquireReviewBackground();
      if (!slot) return;
      settled = true; cleanup(); resolve(slot);
    };
    waitingSlots.add(cancelled);
    stopAvailable = subscribeReviewAvailable(available);
    stopCancellation = subscribeReviewCancellation(owner => { if (!owner || owner === 'memory') cancelled(); });
    signal?.addEventListener('abort', cancelled, { once: true });
    if (signal?.aborted) cancelled();
    else onQueued();
  });
}

export function beginMemoryReviewTurn(options: MemoryReviewTurnOptions) {
  const job = structuredClone({ source: options.source, messages: options.messages,
    config: { ...loadMemoryConfig(), ...options.config } });
  job.config.reviewModelSelection = structuredClone(job.config.reviewPreferCheapModel && job.config.reviewModelSelection
    ? job.config.reviewModelSelection : getExplicitActiveGatewaySelection() ?? getDefaultGatewaySelection());
  job.config.reviewPreferCheapModel = true; // selection is now job-owned, never reread foreground routing
  // Attach immediately; a failed persistence Promise remains failed authority.
  const ready = options.ready;
  const sourceSignal = options.signal;
  void ready.catch(() => {});
  const releaseForeground = beginReviewForeground(job.source.runId);
  const endForeground = () => {
    sourceSignal?.removeEventListener('abort', endForeground);
    releaseForeground();
  };
  if (sourceSignal?.aborted) endForeground();
  else sourceSignal?.addEventListener('abort', endForeground, { once: true });
  let finished: Promise<MemoryReviewOutcome | undefined> | undefined;
  return { endForeground, finish(terminal: 'completed' | 'cancelled' | 'failed', messages?: MemoryReviewJob['messages']) {
    if (finished) return finished;
    if (messages) job.messages = structuredClone(messages);
    let resolveFinished!: (outcome: MemoryReviewOutcome | undefined) => void;
    let rejectFinished!: (cause: unknown) => void;
    // Install the public completion before any synchronous observer can re-enter.
    finished = new Promise((resolve, reject) => { resolveFinished = resolve; rejectFinished = reject; });
    const operation = (async () => {
      endForeground();
      const sourceIndex = job.messages.findIndex(message => message.id === job.source.sourceMessageId && message.role === 'user');
      const assistantMessageId = sourceIndex >= 0 ? job.messages.slice(sourceIndex + 1).reverse().find(message => message.role === 'assistant')?.id : undefined;
      const publishState = (state: MemoryReviewChatState) => publishMemoryReview({ ...state, assistantMessageId });
      const showGate = (phase: MemoryReviewChatState['phase'], detail: string) => publishState({
        id: JSON.stringify([job.source.hostId, job.source.namespaceId, job.source.workspaceId, job.source.sessionId, job.source.turnId]),
        source: job.source, phase, detail, appliedOps: 0, queuedOps: 0, updatedAt: Date.now(),
      });
      if (terminal !== 'completed') {
        showGate(terminal === 'cancelled' ? 'cancelled' : 'skipped', terminal === 'cancelled' ? 'foreground_cancelled' : 'foreground_failed');
        return;
      }
      const current = loadMemoryConfig();
      if (!current.reviewEnabled || !current.writeEnabled || !job.config.reviewEnabled || !job.config.writeEnabled) {
        showGate('disabled', 'review_or_write_disabled'); return;
      }
      let scheduler = new MemoryReviewScheduler();
      let reservation = scheduler.reserve(job, terminal, Date.now());
      if (!reservation) { showGate('skipped', 'below_threshold'); return; }
      const result: MemoryReviewOutcome = { id: reservation.id, source: job.source,
        ...(assistantMessageId ? { assistantMessageId } : {}),
        phase: 'failed', appliedOps: 0, queuedOps: 0, updatedAt: Date.now() };
      let journal: MemoryReviewJournal | undefined;
      let journalRaw: string | null = null;
      let invokeModel: ReviewCompletionInvoker | undefined;
      let slot: ReviewSlot | undefined;
      try {
      try {
        slot = acquireReviewBackground();
        if (!slot) slot = await waitForMemorySlot(sourceSignal, () => publishState({ ...result, phase: 'queued', detail: 'background_busy' }));
        const signal = sourceSignal ? AbortSignal.any([sourceSignal, slot.signal]) : slot.signal;
        const current = loadMemoryConfig();
        if (!current.reviewEnabled || !current.writeEnabled) { showGate('disabled', 'review_or_write_disabled'); return; }
        publishState({ ...result, phase: 'admitting' });
        await waitForReviewSource(ready, signal);
        if (signal.aborted) throw new DOMException('Memory review cancelled', 'AbortError');
        const derivedAnswers = job.messages.filter((message) => message.sourceMessageId);
        if (derivedAnswers.length) {
          const record = await waitForReviewSource(readPersistedSkillSourceSession(job.source.workspaceId, job.source.sessionId), signal);
          const persisted = record && record.workspaceId === job.source.workspaceId &&
            (record.sessionId ?? record.id) === job.source.sessionId && !record.deletedAt
            ? buildMemoryReviewMessages(record.messages) : [];
          if (derivedAnswers.some((message) => !persisted.some((entry) => entry.id === message.id &&
              entry.sourceMessageId === message.sourceMessageId && entry.role === message.role && entry.text === message.text))) {
            throw new Error('MEMORY_INTERACTION_NOT_PERSISTED');
          }
        }
        const admitted = await withMemoryLock(MEMORY_REVIEW_JOURNAL_PATH, async () => {
          checkMemoryCancelled(signal);
          const loaded = await waitForReviewSource(loadMemoryReviewJournal(), signal);
          checkMemoryCancelled(signal);
          const candidate = loaded.value;
          // A crashed in-flight job is diagnostic-only; do not auto-resume/rebill it.
          if (candidate.jobs.some((entry) => entry.phase === 'reading' && Date.now() < entry.updatedAt + 120000)) return false;
          const interrupted = candidate.jobs.some((entry) => entry.phase === 'reading');
          candidate.jobs = candidate.jobs.map((entry) => entry.phase === 'reading'
            ? { ...entry, phase: 'cancelled' as const, error: 'MEMORY_REVIEW_INTERRUPTED' } : entry);
          scheduler = new MemoryReviewScheduler(candidate.scheduler);
          reservation = scheduler.reserve(job, terminal, Date.now());
          if (!reservation) {
            // A denied replay may repair diagnostics, never its evidence/billing fence.
            if (interrupted) await saveMemoryReviewJournal(loaded.raw, candidate, signal);
            return false;
          }
          candidate.scheduler = scheduler.snapshot();
          candidate.jobs = [...candidate.jobs.filter((entry) => entry.id !== result.id), { ...result, phase: 'reading' as const }].slice(-100);
          await saveMemoryReviewJournal(loaded.raw, candidate, signal);
          // Only a confirmed admission owns a terminal journal CAS. Never retry an uncertain write.
          journal = candidate;
          journalRaw = JSON.stringify(candidate);
          return true;
        });
        if (!admitted) { showGate('skipped', 'not_admitted'); return; }
        publishState({ ...result, phase: 'reading' });
        if (signal.aborted) throw new DOMException('Memory review cancelled', 'AbortError');
        const [user, memory] = await waitForReviewSource(Promise.all([
          readMemoryBase('user'), readMemoryBase('memory', job.source.workspaceId),
        ]), signal);
        if (signal.aborted) throw new DOMException('Memory review cancelled', 'AbortError');
        try {
          const currentJournal = await waitForReviewSource(loadMemoryReviewJournal(), signal);
          if (currentJournal.raw !== journalRaw) throw new Error('MEMORY_REVIEW_JOURNAL_AUTHORITY_LOST: exact admitted revision changed; no merge or retry');
        } catch (error) {
          journal = undefined; // No terminal write authority after a failed pre-dispatch readback.
          throw error;
        }
        checkMemoryCancelled(signal);
        invokeModel = makeReviewInvoker(job.config, undefined, { signal });
        const limits = getMemoryLimits();
        const out = await runConsolidatingReview({
          invokeModel, summarize: invokeModel, signal,
          transcript: buildReviewTranscript(reservation.job.messages), messages: reservation.job.messages,
          reviewSource: job.source, bases: { user, memory }, workspaceId: job.source.workspaceId,
          unattended: true, source: 'review', approvalMode: job.config.approvalRequired || loadMemoryConfig().approvalRequired ? 'queue' : 'direct',
          getWritePolicy: () => {
            const live = loadMemoryConfig();
            if (!job.config.reviewEnabled || !job.config.writeEnabled || !live.reviewEnabled || !live.writeEnabled) {
              throw new DOMException('Memory review cancelled: review or write disabled', 'AbortError');
            }
            return job.config.approvalRequired || live.approvalRequired ? 'queue' : 'direct';
          },
          contexts: [user, memory].map((base) => formatReviewMemoryContext({
            label: base.target === 'user' ? '用户画像（全局）' : '助手笔记（本项目）',
            entries: base.entries, used: base.entries.map((entry) => entry.text).join('\n').length, limit: limits[base.target],
          })),
        });
        result.appliedOps = out.appliedOps;
        result.queuedOps = out.queuedOps;
        result.phase = out.appliedOps ? 'applied' : out.queuedOps ? 'awaiting_approval' : out.lastErrors.length ? 'failed' : 'noop';
        if (out.lastErrors.length) result.error = out.lastErrors.join('; ');
      } catch (error) {
        result.phase = error instanceof DOMException && error.name === 'AbortError' ? 'cancelled' : 'failed';
        result.error = String(error);
      }
      result.updatedAt = Date.now();
      try { result.usage = invokeModel?.usage ?? { calls: 0, inputTokens: 0, outputTokens: 0, estimated: true }; }
      catch (error) { result.recordingError = String(error); }
      if (reservation) scheduler.finish(reservation.id, result.error ? 'failed' : result.phase, result.updatedAt);
      if (journal) {
        journal.scheduler = scheduler.snapshot();
        journal.jobs = [...journal.jobs.filter((entry) => entry.id !== result.id), result].slice(-100);
        try { await withMemoryLock(MEMORY_REVIEW_JOURNAL_PATH, () => saveMemoryReviewJournal(journalRaw, journal!)); }
        catch (error) { result.recordingError = [result.recordingError, String(error)].filter(Boolean).join('; '); }
      } else {
        result.recordingError = [result.recordingError, 'MEMORY_REVIEW_OUTCOME_NOT_RECORDED: no confirmed journal authority; no write or retry'].filter(Boolean).join('; ');
      }
      publishState(result);
      return result;
      } finally { slot?.release(); }
    })();
    void operation.then(resolveFinished, rejectFinished);
    return finished;
  } };
}
