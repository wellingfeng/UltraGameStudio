import type { GatewaySelection } from '@/core/ir';
import type {
  SkillHostPort, SkillLearningConfig, SkillLearningMode, SkillNativeToolEvent, SkillOrigin,
  SkillLearningJob, SkillMutationResult, SkillReviewModelPort, SkillReviewState, SkillEvidence,
} from '@/runtime/skills/types';
import { SkillReviewScheduler, trustedSkillEvidence, type SkillReviewReservation } from '@/runtime/skills/trigger';
import { runSkillReview } from '@/runtime/skills/review';
import { loadSkillContext } from '@/runtime/skills/context';
import { isCliVerificationEvent } from '@/runtime/skills/cliHost';
import { createSkillReviewModelPort } from './modelGateway/skillReviewGateway';
import { redactSkillText, SkillEvidenceCollector } from '@/runtime/skills/evidence';
import { createSkillControlHost, createSkillHost } from './skills';
import { loadSkillLearningConfig, SKILL_LEARNING_CONFIG_CHANGED_EVENT } from './skillLearningConfig';
import { SkillLearningQueue } from './skillLearningQueue';
import { beginReviewForeground } from '@/runtime/memory/review';
import { createSkillCandidateStore, syncSkillCandidateControlResult } from './skillCandidateStore';

export interface SkillTurnContext {
  prompt: string;
  loadedSkills: SkillLearningJob['loadedSkills'];
  catalogRevision: string;
}
export interface BeginSkillLearningTurnOptions {
  origin: SkillOrigin;
  prompt: string;
  selection: GatewaySelection;
  config?: SkillLearningConfig;
  explicitSkillIds?: string[];
  host?: SkillHostPort;
  model?: SkillReviewModelPort;
  onState?: (state: SkillReviewState) => void;
  ready?: Promise<void>;
  signal?: AbortSignal;
}

interface ReviewSource {
  origin: SkillOrigin;
  job: SkillLearningJob;
  selection: GatewaySelection;
  host?: SkillHostPort;
  model?: SkillReviewModelPort;
  onState?: (state: SkillReviewState) => void;
  ready?: Promise<void>;
  resolve: (result: SkillMutationResult) => void;
}
const foregroundQueue = new SkillLearningQueue<SkillReviewReservation, SkillMutationResult>('skills:local');
const scheduler = new SkillReviewScheduler();
const reviewSources = new Map<string, ReviewSource>();
const reservedSources = new Set<ReviewSource>();
const liveReviews = new Set<string>();
export function isSkillReviewLive(runId: string): boolean { return liveReviews.has(runId); }
const lastJobs = new Map<string, SkillLearningJob>();
const sessionKey = (origin: SkillOrigin) => JSON.stringify([origin.hostId, origin.workspaceId, origin.sessionId]);
let configListenerInstalled = false;

function ensureConfigListener(): void {
  if (configListenerInstalled || typeof window === 'undefined') return;
  configListenerInstalled = true;
  const changed = (event: Event) => {
    const workspaceId = event.type === SKILL_LEARNING_CONFIG_CHANGED_EVENT
      ? (event as CustomEvent<{ workspaceId?: string }>).detail?.workspaceId : undefined;
    for (const source of [...reviewSources.values()]) {
      if (workspaceId && source.origin.workspaceId !== workspaceId) continue;
      const current = loadSkillLearningConfig(source.origin.workspaceId);
      if (!current.enabled || current.mode === 'off') cancelSkillLearning(source.origin);
    }
  };
  window.addEventListener(SKILL_LEARNING_CONFIG_CHANGED_EVENT, changed);
  window.addEventListener('storage', changed);
}

function reviewSelection(selection: GatewaySelection, config: SkillLearningConfig): GatewaySelection {
  const override = config.reviewSelection;
  return override ? { adapter: override.adapter, modelClass: override.modelClass,
    providerId: override.providerId, channelId: override.channelId,
    ...(override.model === undefined ? {} : { modelOverride: override.model }) } : { ...selection };
}

function optionalModel(selection: GatewaySelection, config: SkillLearningConfig, origin: SkillOrigin): SkillReviewModelPort | undefined {
  try { return createSkillReviewModelPort(reviewSelection(selection, config), origin, config.reviewTransport); }
  catch { return undefined; } // Optional reuse never gains a coding/CLI fallback.
}

function emptyResult(origin: SkillOrigin, status: SkillMutationResult['status'], lesson: string, error?: unknown): SkillMutationResult {
  return { status, origin: { ...origin }, batchId: `review-${origin.runId}`, lesson,
    operationsApplied: 0, changes: [], riskReasons: [], ...(error === undefined ? {} : { error: String(error) }) };
}

function publish(source: Pick<ReviewSource, 'onState'> & { job?: SkillLearningJob; config?: SkillLearningConfig }, state: SkillReviewState): void {
  const frozenState: SkillReviewState & { mode?: SkillLearningMode } = { ...structuredClone(state),
    ...(source.job || source.config ? { mode: source.job?.config.mode ?? source.config!.mode } : {}) };
  try { source.onState?.(frozenState); } catch { /* Observers cannot change authority or hide commits. */ }
}

function awaitReadiness(ready: Promise<void> | undefined, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cancelled = () => reject(new Error('SKILL_REVIEW_CANCELLED'));
    if (signal?.aborted) { ready?.catch(() => {}); cancelled(); return; }
    signal?.addEventListener('abort', cancelled, { once: true });
    Promise.resolve(ready).then(() => {
      signal?.removeEventListener('abort', cancelled);
      if (signal?.aborted) cancelled(); else resolve();
    }, (error) => { signal?.removeEventListener('abort', cancelled); reject(error); });
  });
}

function replaceSource(origin: SkillOrigin, source: ReviewSource): void {
  const key = sessionKey(origin);
  const old = reviewSources.get(key);
  if (old && !reservedSources.has(old)) {
    const result = emptyResult(old.origin, 'cancelled', 'Superseded by a newer source turn.');
    publish(old, { status: result.status, origin: { ...old.origin }, result });
    old.resolve(result);
  }
  reviewSources.set(key, source);
}

export interface RequestExplicitSkillLearningOptions {
  origin: SkillOrigin;
  selection: GatewaySelection;
  kind: 'learn' | 'refine';
  text: string;
  onState?: (state: SkillReviewState) => void;
  ready?: Promise<void>;
  config?: SkillLearningConfig;
  host?: SkillHostPort;
  model?: SkillReviewModelPort;
  /** Trusted host snapshots, not text synthesized by the main chat model. */
  evidence?: SkillEvidence[];
  loadedSkills?: SkillLearningJob['loadedSkills'];
}

/** Explicit text is user input; it never invokes the ordinary chat gateway. */
export function requestExplicitSkillLearning(options: RequestExplicitSkillLearningOptions): Promise<SkillMutationResult> {
  ensureConfigListener();
  const origin = { ...options.origin };
  const config = structuredClone(options.config ?? loadSkillLearningConfig(origin.workspaceId));
  const previous = lastJobs.get(sessionKey(origin));
  const correction: SkillEvidence[] = options.kind === 'learn' && options.text.trim() ? [{
    evidenceId: JSON.stringify([origin.runId, 'user-correction', origin.turnId]), origin: { ...origin },
    occurredAt: Date.now(), kind: 'correction', provenance: 'user-input', status: 'success', summary: redactSkillText(options.text),
  }] : [];
  const job: SkillLearningJob = { origin, config, userText: options.kind === 'learn' ? options.text : previous?.userText ?? '', finalAnswer: previous?.finalAnswer ?? '',
    evidence: [...(options.evidence ?? previous?.evidence ?? []), ...correction], loadedSkills: options.loadedSkills ?? previous?.loadedSkills ?? [],
    explicit: true, ...(options.kind === 'refine' ? { focus: options.text } : {}) };
  const decision = scheduler.observe(job, 'completed');
  if (!decision.eligible) {
    const result = emptyResult(origin, 'noop', decision.reason);
    publish(options, { status: result.status, origin, result });
    return Promise.resolve(result);
  }
  const promise = new Promise<SkillMutationResult>((resolve) => {
    replaceSource(origin, { origin, job, selection: { ...options.selection }, host: options.host,
      model: options.model, onState: options.onState, ready: options.ready, resolve });
  });
  drainReviews();
  return promise;
}

export interface RunExplicitSkillLearningOptions extends Omit<RequestExplicitSkillLearningOptions, 'kind' | 'text'> {
  kind?: 'learn' | 'refine';
  text?: string;
  /** Only lesson is explicit correction input; prompt/focus are context. */
  lesson?: string;
  prompt?: string;
  focus?: string;
}

export function runExplicitSkillLearning(options: RunExplicitSkillLearningOptions): Promise<SkillMutationResult> {
  const kind = options.kind ?? (options.lesson === undefined ? 'refine' : 'learn');
  return requestExplicitSkillLearning({ ...options, kind,
    text: options.text ?? (kind === 'learn' ? options.lesson ?? '' : options.focus ?? '') });
}

/** Keep the saved batch origin; Rust separates user/background authority by actor. */
export async function performSkillReviewAction(
  state: SkillReviewState & { mode?: SkillLearningMode }, action: 'approve' | 'reject' | 'rollback',
): Promise<SkillMutationResult> {
  const snapshot = structuredClone(state);
  const origin = snapshot.origin;
  const id = action === 'rollback' ? snapshot.result?.rollbackId : snapshot.result?.batchId;
  if (!id) throw new Error('SKILL_CONTROL_TARGET_REQUIRED');
  const sameOrigin = (candidate: SkillOrigin) => ['hostId', 'workspaceId', 'sessionId', 'turnId', 'runId', 'cwd']
    .every((field) => candidate[field as keyof SkillOrigin] === origin[field as keyof SkillOrigin]);
  if (!sameOrigin(snapshot.result!.origin)) throw new Error('SKILL_CONTROL_SOURCE_MISMATCH');
  const host = createSkillControlHost({ origin, mode: snapshot.mode ?? 'approve-all' });
  const result = await host[action](id);
  // Approve/reject update the selected batch. Rollback creates a new batch.
  if (action !== 'rollback' && result.batchId !== id) throw new Error('SKILL_CONTROL_TARGET_MISMATCH');
  const history = await host.history();
  const saved = history.results.find((record) => record.batchId === result.batchId && sameOrigin(record.origin));
  if (!sameOrigin(result.origin) || !saved || saved.status !== result.status || saved.operationsApplied !== result.operationsApplied) {
    throw new Error('SKILL_MUTATION_UNCONFIRMED');
  }
  // Auxiliary dedup state must not turn a real confirmed commit into failure.
  try {
    await syncSkillCandidateControlResult(createSkillCandidateStore(origin), action, id, result);
  } catch (error) {
    return { ...result, error: [result.error, `SKILL_CANDIDATE_SYNC_FAILED: ${String(error)}`].filter(Boolean).join('; ') };
  }
  return result;
}

let reviewTimer: ReturnType<typeof setTimeout> | undefined;

/** Cancel only background work for a frozen source session, or all when off. */
export function cancelSkillLearning(origin?: SkillOrigin): void {
  const key = origin === undefined ? undefined : sessionKey(origin);
  foregroundQueue.cancel(key);
  for (const [sourceKey, source] of reviewSources) {
    if (key !== undefined && key !== sourceKey) continue;
    scheduler.observe(source.job, 'cancelled');
    if (reservedSources.has(source)) continue;
    reviewSources.delete(sourceKey);
    const result = emptyResult(source.origin, 'cancelled', 'Background review cancelled.');
    publish(source, { status: 'cancelled', origin: { ...source.origin }, result });
    source.resolve(result);
  }
  drainReviews();
}

function drainReviews(): void {
  if (reviewTimer !== undefined) { clearTimeout(reviewTimer); reviewTimer = undefined; }
  const reservation = scheduler.take();
  if (!reservation) {
    const next = scheduler.nextReadyAt();
    if (next !== undefined) reviewTimer = setTimeout(() => { reviewTimer = undefined; drainReviews(); }, Math.max(0, next - Date.now()));
    return;
  }
  const source = reviewSources.get(sessionKey(reservation.job.origin));
  if (!source) { scheduler.finish(reservation.id, 'cancelled'); return; }
  reservedSources.add(source);
  const reviewOrigin: SkillOrigin = { ...reservation.job.origin, runId: `skill-review-${crypto.randomUUID()}` };
  liveReviews.add(reviewOrigin.runId);
  const queuedAt = Date.now();
  const resume = { job: structuredClone(reservation.job), selection: { ...source.selection } };
  const emit = (state: SkillReviewState) => publish(source, { ...state, resume, queuedAt, updatedAt: Date.now() });
  void foregroundQueue.enqueue(sessionKey(reservation.job.origin), reservation, async ({ job }, signal) => {
    let reviewHost: SkillHostPort | undefined;
    try {
      await awaitReadiness(source.ready, signal);
      emit({ status: 'reading', origin: reviewOrigin, detail: '正在连接技能库并读取目录' });
      reviewHost = source.host ?? createSkillHost({ origin: reviewOrigin, mode: job.explicit ? job.config.mode : 'approve-all', evidence: job.evidence, signal, ready: source.ready });
      const model = source.model ?? createSkillReviewModelPort(reviewSelection(source.selection, job.config), reviewOrigin, job.config.reviewTransport);
      return await runSkillReview({ ...job, origin: reviewOrigin }, { host: reviewHost, model, signal, onState: emit,
        candidateStore: createSkillCandidateStore(job.origin) });
    } catch (error) {
      const result = emptyResult(reviewOrigin, signal.aborted ? 'cancelled' : 'failed', '', error);
      emit({ status: result.status, origin: { ...reviewOrigin }, result, error: result.error });
      return result;
    } finally {
      // Revocation follows the actual host outcome; never interrupt a dispatched transaction.
      if (!source.host && reviewHost && 'revoke' in reviewHost && typeof reviewHost.revoke === 'function') {
        await (reviewHost.revoke() as Promise<void>).catch(() => {});
      }
    }
  }).then((outcome) => {
    const result = outcome.status === 'completed' ? outcome.result : emptyResult(reviewOrigin,
      outcome.status === 'cancelled' ? 'cancelled' : 'failed', '', outcome.status === 'failed' ? outcome.error : undefined);
    if (outcome.status !== 'completed') emit({ status: result.status, origin: { ...result.origin }, result });
    liveReviews.delete(reviewOrigin.runId);
    scheduler.finish(reservation.id, result.status);
    reservedSources.delete(source);
    const key = sessionKey(source.origin);
    const latest = reviewSources.get(key);
    if (latest === source) reviewSources.delete(key);
    else if (latest && result.status !== 'cancelled') {
      const decision = scheduler.observe(latest.job, 'completed');
      if (!decision.eligible) {
        reviewSources.delete(key);
        const consumed = emptyResult(latest.origin, 'noop', 'The earlier review already consumed this evidence.');
        publish(latest, { status: 'noop', origin: { ...latest.origin }, result: consumed });
        latest.resolve(consumed);
      }
    }
    source.resolve(result);
    drainReviews();
  });
  // Observers may cancel immediately; install the pending entry first.
  emit({ status: 'queued', origin: { ...reviewOrigin }, detail: '等待所有前台任务结束并取得共享后台复盘名额' });
}

/** Resume only captured host evidence, using a fresh run and fresh target reads. */
export function resumeSkillLearningReview(state: SkillReviewState, onState: (state: SkillReviewState) => void): Promise<SkillMutationResult> {
  if (!state.resume || state.origin.hostId !== 'local' || state.sourceSession) throw new Error('SKILL_REVIEW_SOURCE_UNAVAILABLE');
  const { job, selection } = structuredClone(state.resume);
  if (sessionKey(job.origin) !== sessionKey(state.origin) || job.origin.turnId !== state.origin.turnId || job.origin.cwd !== state.origin.cwd) {
    throw new Error('SKILL_REVIEW_SOURCE_MISMATCH');
  }
  const current = loadSkillLearningConfig(job.origin.workspaceId);
  // A later disabled setting remains authoritative; a retry cannot increase write authority.
  const config = { ...job.config, enabled: current.enabled, mode: current.mode === 'off' ? 'off' as const : job.config.mode,
    reviewSelection: current.reviewSelection ?? job.config.reviewSelection,
    reviewTransport: current.reviewTransport ?? job.config.reviewTransport };
  const decision = scheduler.observe({ ...job, config, explicit: true }, 'completed');
  if (!decision.eligible) return Promise.resolve(emptyResult(job.origin, 'noop', decision.reason));
  const result = new Promise<SkillMutationResult>((resolve) => {
    replaceSource(job.origin, { origin: job.origin, job: { ...job, config, explicit: true }, selection, onState, resolve });
  });
  drainReviews();
  return result;
}

/** Bind a turn before any asynchronous work or UI navigation occurs. */
export function beginSkillLearningTurn(options: BeginSkillLearningTurnOptions) {
  ensureConfigListener();
  options = { ...options, origin: { ...options.origin }, selection: { ...options.selection },
    explicitSkillIds: options.explicitSkillIds === undefined ? undefined : [...options.explicitSkillIds],
    config: structuredClone(options.config ?? loadSkillLearningConfig(options.origin.workspaceId)) };
  const origin = Object.freeze({ ...options.origin });
  const config = options.config!;
  const ownedHost = options.host ? undefined : createSkillHost({ origin, mode: config.mode, evidence: [], signal: options.signal, ready: options.ready });
  const host = options.host ?? ownedHost!;
  const model = options.model ?? optionalModel(options.selection, config, origin);
  const releaseForeground = foregroundQueue.foregroundStarted(sessionKey(origin));
  const releaseSharedForeground = beginReviewForeground(sessionKey(origin));
  const collectors = new Map<string, SkillEvidenceCollector>();
  const verifiedCalls = new Set<string>();
  const userEvidence = new SkillEvidenceCollector(origin).collect([], options.prompt);
  const hostEvidence = new Map<string, SkillEvidence>();
  let finalAnswer = '';
  let loadedSkills: SkillLearningJob['loadedSkills'] = [];
  let catalogRevision = '';
  let loadPromise: Promise<SkillTurnContext> | undefined;
  let finished: Promise<SkillMutationResult> | undefined;
  let foregroundClosed: Promise<void> | undefined;
  let learningDisabled = false;
  const onConfigChange = (event: Event) => {
    const workspaceId = event.type === SKILL_LEARNING_CONFIG_CHANGED_EVENT
      ? (event as CustomEvent<{ workspaceId?: string }>).detail?.workspaceId : undefined;
    if (workspaceId && workspaceId !== origin.workspaceId) return;
    const current = loadSkillLearningConfig(origin.workspaceId);
    if (current.enabled && current.mode !== 'off') return;
    // Off is a live cancellation gate, not a mutation of the frozen task policy.
    learningDisabled = true;
    cancelSkillLearning(origin);
    void ownedHost?.revoke().catch(() => {});
  };
  if (typeof window !== 'undefined') {
    window.addEventListener(SKILL_LEARNING_CONFIG_CHANGED_EVENT, onConfigChange);
    window.addEventListener('storage', onConfigChange);
  }
  const endForeground = () => {
    releaseForeground();
    releaseSharedForeground();
  };
  const closeForeground = (usage?: Promise<void>) => {
    endForeground();
    if (typeof window !== 'undefined') {
      window.removeEventListener(SKILL_LEARNING_CONFIG_CHANGED_EVENT, onConfigChange);
      window.removeEventListener('storage', onConfigChange);
    }
    // Injected hosts may be shared and retain caller-owned lifetimes.
    const revoke = () => ownedHost?.revoke().catch(() => {}) ?? Promise.resolve();
    foregroundClosed ??= usage ? usage.then(revoke, revoke) : revoke();
    return foregroundClosed;
  };
  const recordVerifiedUsage = (): Promise<void> | undefined => {
    const adoptions = loadedSkills.map((loaded) => ({ skillId: loaded.skillId,
      evidence: [...hostEvidence.values()].filter((item) => item.kind === 'skill-use' && item.status === 'success' &&
        item.exitCode === 0 && !!item.toolCallId && item.origin.turnId === origin.turnId &&
        item.skillId === loaded.skillId && item.revision === loaded.revision).map((item) => structuredClone(item)) }))
      .filter((adoption) => adoption.evidence.length);
    if (!adoptions.length) return;
    return (async () => {
      for (const adoption of adoptions) {
        try {
          if (ownedHost) await ownedHost.recordVerifiedUsage(adoption.skillId, adoption.evidence);
          else await host.recordUsage?.(adoption.skillId, 'used-with-evidence', adoption.evidence.map((item) => item.evidenceId));
        } catch { /* Usage telemetry cannot fail the task or manufacture adoption. */ }
      }
    })();
  };
  const onAbort = () => {
    cancelSkillLearning(origin);
    // Optional telemetry must never prolong foreground authority on abort.
    void ownedHost?.revoke().catch(() => {});
    void closeForeground();
  };
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener('abort', onAbort, { once: true });
  return {
    origin,
    host,
    model,
    // The task has ended; advisory file scans must not retain global priority.
    endForeground,
    onLoaded(context: Pick<SkillTurnContext, 'loadedSkills' | 'catalogRevision'>): void {
      loadedSkills = structuredClone(context.loadedSkills.slice(0, 32));
      catalogRevision = context.catalogRevision;
    },
    getSnapshot(): SkillLearningJob & { catalogRevision: string } {
      return { origin: { ...origin }, config: structuredClone(config), userText: redactSkillText(options.prompt), finalAnswer,
        loadedSkills: structuredClone(loadedSkills), catalogRevision,
        evidence: [...userEvidence, ...[...hostEvidence.values()].map((item) => structuredClone(item)), ...[...collectors.values()].flatMap((collector) => collector.snapshot())].map((item) =>
          verifiedCalls.has(item.evidenceId) ? { ...item, kind: 'verification' } : item) };
    },
    loadContext(): Promise<SkillTurnContext> {
      loadPromise ??= (async () => {
        try {
          await awaitReadiness(options.ready, options.signal);
          const context = await loadSkillContext({ host, origin, prompt: options.prompt,
            explicitSkillIds: options.explicitSkillIds, signal: options.signal, model });
          loadedSkills = context.loadedSkills;
          catalogRevision = context.catalogRevision;
          return context;
        } catch (error) {
          if (options.explicitSkillIds?.length || options.signal?.aborted ||
            String(error).includes('SKILL_CONTEXT_AMBIGUOUS_NAME')) throw error;
          return { prompt: options.prompt, loadedSkills: [], catalogRevision: '' };
        }
      })();
      return loadPromise;
    },
    onTool(event: SkillNativeToolEvent): void {
      if (finished || event.phase !== 'end' || !['native-tool', 'host-check'].includes(event.provenance)) return;
      let collector = collectors.get(event.runId);
      if (!collector) {
        collector = new SkillEvidenceCollector({ ...origin, runId: event.runId });
        collectors.set(event.runId, collector);
        if (collectors.size > 32) collectors.delete(collectors.keys().next().value!);
      }
      const id = JSON.stringify([event.runId, event.toolCallId]);
      collector.collect([event]);
      const captured = collector.snapshot().find((item) => item.evidenceId === id);
      if (captured) {
        let args: unknown;
        try { args = JSON.parse(captured.summary); } catch { args = { command: captured.summary }; }
        if (isCliVerificationEvent({ runId: captured.origin.runId, toolCallId: captured.toolCallId ?? '',
          toolName: captured.toolName ?? '', phase: 'end', provenance: captured.provenance,
          status: captured.status, exitCode: captured.exitCode, args })) verifiedCalls.add(id);
      }
      while (verifiedCalls.size > 256) verifiedCalls.delete(verifiedCalls.values().next().value!);
    },
    /** Trusted host callback only: model output and refine focus never enter here. */
    onHostEvidence(evidence: readonly SkillEvidence[]): void {
      if (finished) return;
      for (const item of trustedSkillEvidence(evidence, origin)) {
        if (item.provenance !== 'host-check' || item.origin.cwd !== origin.cwd || hostEvidence.has(item.evidenceId)) continue;
        hostEvidence.set(item.evidenceId, { ...structuredClone(item), summary: redactSkillText(item.summary),
          result: item.result === undefined ? undefined : redactSkillText(item.result) });
      }
      while (hostEvidence.size > 256) hostEvidence.delete(hostEvidence.keys().next().value!);
    },
    finish(result: { finalAnswer: string; terminal: 'completed' | 'cancelled' | 'failed' }): Promise<SkillMutationResult> {
      if (finished) return finished;
      let resolveFinished!: (result: SkillMutationResult) => void;
      let rejectFinished!: (error: unknown) => void;
      // Install the final public promise before any source/queue observer can
      // re-enter finish or append evidence to this now-terminal turn.
      finished = new Promise<SkillMutationResult>((resolve, reject) => {
        resolveFinished = resolve;
        rejectFinished = reject;
      });
      finalAnswer = redactSkillText(result.finalAnswer);
      const terminal = options.signal?.aborted ? 'cancelled' : result.terminal;
      const job: SkillLearningJob = { origin, config: learningDisabled ? { ...config, enabled: false, mode: 'off' } : config,
        userText: options.prompt, finalAnswer: result.finalAnswer,
        evidence: [...userEvidence, ...[...hostEvidence.values()].map((item) => structuredClone(item)), ...[...collectors.values()].flatMap((collector) => collector.snapshot())].map((item) =>
          verifiedCalls.has(item.evidenceId) ? { ...item, kind: 'verification' } : item), loadedSkills };
      lastJobs.delete(sessionKey(origin));
      lastJobs.set(sessionKey(origin), structuredClone({ ...job, userText: redactSkillText(job.userText), finalAnswer: redactSkillText(job.finalAnswer),
        evidence: job.evidence.slice(-256) }));
      while (lastJobs.size > 32) lastJobs.delete(lastJobs.keys().next().value!);
      const decision = scheduler.observe(job, terminal);
      let reviewResult: Promise<SkillMutationResult>;
      if (decision.eligible) {
        reviewResult = new Promise<SkillMutationResult>((resolve) => {
          replaceSource(origin, { origin, job, selection: { ...options.selection }, host: options.host,
            model: options.model, onState: options.onState, ready: options.ready, resolve });
        });
        drainReviews();
      } else {
        if (terminal !== 'completed' || learningDisabled || !config.enabled || config.mode === 'off') cancelSkillLearning(origin);
        const skipped = emptyResult(origin, 'noop', decision.reason);
        // A completed task below the threshold must explain non-admission, not
        // pretend a reviewer ran or silently disappear from the source surface.
        if (terminal === 'completed' && !learningDisabled && config.enabled && config.mode !== 'off') {
          publish(options, { status: 'noop', origin, result: skipped,
            admission: { status: 'not-admitted', reason: decision.reason,
              completedActivities: decision.completedActivities, activityThreshold: config.activityThreshold },
            detail: `Completed activities: ${decision.completedActivities} / ${config.activityThreshold}` });
        }
        reviewResult = Promise.resolve(skipped);
      }
      // Queued review starts only after every foreground owner exits.
      void Promise.all([reviewResult, closeForeground(terminal === 'completed' ? recordVerifiedUsage() : undefined)]).then(([actual]) => {
        options.signal?.removeEventListener('abort', onAbort);
        resolveFinished(actual);
      }, rejectFinished);
      return finished;
    },
  };
}
