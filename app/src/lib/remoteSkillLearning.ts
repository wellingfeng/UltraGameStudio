import { REMOTE_SKILL_HOST_ID } from '@ugs/protocol';
import type { RunnerClient } from '@ugs/protocol';
import type { GatewaySelection } from '@/core/ir';
import { loadSkillContext } from '@/runtime/skills/context';
import type { LoadedSkillContext, LoadSkillContextOptions } from '@/runtime/skills/context';
import { SkillEvidenceCollector, redactSkillText } from '@/runtime/skills/evidence';
import { runSkillReview } from '@/runtime/skills/review';
import { SkillReviewScheduler, shouldTriggerSkillReview } from '@/runtime/skills/trigger';
import { SkillLearningQueue } from './skillLearningQueue';
import { beginReviewForeground } from '@/runtime/memory/review';
import type { SkillControlHost, SkillServiceRequest } from './skills';
import type { SkillCatalog, SkillEntry, SkillHostPort, SkillLearningJob, SkillLearningMode, SkillMutationResult, SkillOrigin, SkillReadResult, SkillReviewModelPort, SkillReviewState } from '@/runtime/skills/types';

import type { SkillCandidateStore } from '@/runtime/skills/preReview';

export interface RemoteSkillCandidateClient {
  skillCandidateRequest(projectId: string, request: { action: 'load' | 'compare_and_swap'; origin: SkillOrigin;
    list?: import('@/runtime/skills/preReview').SkillCandidateList; expectedRevision?: number }): Promise<import('@/runtime/skills/preReview').SkillCandidateList>;
}

export function createRemoteSkillCandidateStore(options: { client: RunnerClient; projectId: string; origin: SkillOrigin }): SkillCandidateStore {
  const origin = boundRemoteOrigin(options.projectId, options.origin);
  const client = options.client as RunnerClient & Partial<RemoteSkillCandidateClient>;
  const request = (payload: Parameters<RemoteSkillCandidateClient['skillCandidateRequest']>[1]) => {
    if (typeof client.skillCandidateRequest !== 'function') throw new Error('REMOTE_SKILL_CANDIDATE_HOST_UNAVAILABLE');
    return client.skillCandidateRequest(options.projectId, payload);
  };
  return { load: () => request({ action: 'load', origin: { ...origin } }),
    save: async (list) => { await request({ action: 'compare_and_swap', origin: { ...origin },
      list: structuredClone(list), expectedRevision: list.revision ?? 0 }); } };
}

export interface RequestRemoteContextOptions extends Omit<LoadSkillContextOptions, 'host'> {
  client: RunnerClient;
  projectId: string;
}

export interface CreateRemoteSkillControlHostOptions {
  client: RunnerClient;
  projectId: string;
  origin: SkillOrigin;
  mode: SkillLearningMode;
}

function boundRemoteOrigin(projectId: string, origin: SkillOrigin): SkillOrigin {
  if (origin.hostId !== REMOTE_SKILL_HOST_ID || origin.workspaceId !== projectId ||
    Object.keys(origin).some((key) => !['hostId', 'workspaceId', 'sessionId', 'turnId', 'runId'].includes(key)) ||
    ['sessionId', 'turnId', 'runId'].some((key) => typeof origin[key as keyof SkillOrigin] !== 'string' ||
      !origin[key as keyof SkillOrigin] || origin[key as keyof SkillOrigin]!.length > 200)) {
    throw new Error('REMOTE_SKILL_ORIGIN_MISMATCH');
  }
  return Object.freeze({ hostId: REMOTE_SKILL_HOST_ID, workspaceId: projectId,
    sessionId: origin.sessionId, turnId: origin.turnId, runId: origin.runId });
}

/** Explicit UI controls only; this host must never be passed to a review model. */
export function createRemoteSkillControlHost(options: CreateRemoteSkillControlHostOptions): SkillControlHost {
  const { client, projectId, mode } = options;
  const origin = boundRemoteOrigin(projectId, options.origin);
  let revoked = false;
  const request = <T extends SkillCatalog | SkillReadResult | SkillEntry | SkillMutationResult | { results: SkillMutationResult[] }>(payload: Omit<SkillServiceRequest, 'origin' | 'mode'>): Promise<T> => {
    if (revoked) return Promise.reject(new Error('REMOTE_SKILL_CONTROL_REVOKED'));
    return client.skillRequest<T>(projectId, { ...payload, origin, mode }, { ownerControl: true });
  };
  return {
    revoke: async () => { revoked = true; },
    list: () => request<SkillCatalog>({ action: 'list' }),
    view: (read) => request<SkillReadResult>({ action: 'view', skillId: read.skillId,
      ...(read.filePath === undefined ? {} : { filePath: read.filePath }) }),
    manage: async () => { throw new Error('REMOTE_SKILL_CONTROL_REVIEW_FORBIDDEN'); },
    approve: (batchId) => request<SkillMutationResult>({ action: 'approve', batchId }),
    reject: (batchId) => request<SkillMutationResult>({ action: 'reject', batchId }),
    rollback: (rollbackId) => request<SkillMutationResult>({ action: 'rollback', rollbackId }),
    history: () => request<{ results: SkillMutationResult[] }>({ action: 'history' }),
    setPolicy: (skillId, policy) => request<SkillEntry>({ action: 'set_policy', skillId, policy: { ...policy } }),
    archive: (skillId) => request<SkillEntry>({ action: 'archive', skillId }),
    restore: (skillId) => request<SkillEntry>({ action: 'restore', skillId }),
    importSkill: (sourceSkillId) => request<SkillEntry>({ action: 'import', sourceSkillId }),
  };
}

/** Fresh remote reads only; neither local paths nor the owner-control header can reach this host. */
export async function requestRemoteContext(options: RequestRemoteContextOptions): Promise<LoadedSkillContext> {
  const { client, projectId } = options;
  const origin = boundRemoteOrigin(projectId, options.origin);
  const host: SkillHostPort = {
    list: () => client.skillRequest<SkillCatalog>(projectId, { action: 'list', origin, mode: 'auto-safe' }, { signal: options.signal }),
    view: (read) => client.skillRequest<SkillReadResult>(projectId, { action: 'view', origin, mode: 'auto-safe', skillId: read.skillId,
      ...(read.filePath === undefined ? {} : { filePath: read.filePath }) }, { signal: options.signal }),
    manage: async () => { throw new Error('REMOTE_SKILL_CONTEXT_READ_ONLY'); },
    recordUsage: async (skillId, kind) => {
      if (kind !== 'delivered') throw new Error('REMOTE_SKILL_CONTEXT_USAGE_REQUIRES_EVIDENCE');
      await client.skillRequest<SkillEntry>(projectId, { action: 'usage', origin, mode: 'auto-safe', skillId, kind }, { signal: options.signal });
    },
  };
  return loadSkillContext({ host, origin, prompt: options.prompt, explicitSkillIds: options.explicitSkillIds,
    supportRequests: options.supportRequests, model: options.model, signal: options.signal });
}

export interface FinishRemoteLearningOptions {
  client: RunnerClient;
  projectId: string;
  origin: SkillOrigin;
  userText: string;
  finalAnswer: string;
  loadedSkills?: SkillLearningJob['loadedSkills'];
  /** Construct only from real store/user input, never from model output or tool text. */
  userCorrections?: ReadonlyArray<{ text: string; occurredAt: number }>;
  selection?: GatewaySelection;
  model?: SkillReviewModelPort;
  signal?: AbortSignal;
  onState?: (state: SkillReviewState) => void;
  onResult?: (result: SkillMutationResult) => void;
}

const schedulers = new Map<string, SkillReviewScheduler>();
// Failed/cancelled attempts may retain evidence, but never redispatch their source.
const dispatchedSources = new WeakMap<SkillReviewScheduler, Set<string>>();
const reviewQueue = new SkillLearningQueue<FinishRemoteLearningOptions, SkillMutationResult | undefined>('skills:remote');
const pendingReviews = new Map<string, string>();
let queueSequence = 0;

/** Call before remote foreground work; release in finally before calling finishRemoteLearning. */
export function beginRemoteSkillForeground(): () => void {
  const releaseQueue = reviewQueue.foregroundStarted();
  const releaseShared = beginReviewForeground('skills:remote');
  return () => { releaseQueue(); releaseShared(); };
}

/** Uses the authenticated server snapshot, not UI tool cards or a job's process exit. */
export async function finishRemoteLearning(options: FinishRemoteLearningOptions): Promise<SkillMutationResult | undefined> {
  const { client, projectId } = options;
  const origin = boundRemoteOrigin(projectId, options.origin);
  if (options.signal?.aborted) return undefined;
  const snapshot = await client.getJob(origin.runId);
  if (snapshot.id !== origin.runId || snapshot.projectId !== projectId) throw new Error('REMOTE_SKILL_JOB_MISMATCH');
  if (snapshot.status !== 'done' || options.signal?.aborted) return undefined;
  if (!snapshot.skillOrigin || Object.keys(snapshot.skillOrigin).length !== 5 ||
    ['hostId', 'workspaceId', 'sessionId', 'turnId', 'runId'].some((key) =>
      snapshot.skillOrigin![key as keyof SkillOrigin] !== origin[key as keyof SkillOrigin])) {
    throw new Error('REMOTE_SKILL_JOB_ORIGIN_MISMATCH');
  }
  const config = await client.getProjectSkillConfig(projectId);
  if (!config.enabled || config.mode === 'off' || options.signal?.aborted) return undefined;
  const collector = new SkillEvidenceCollector(origin);
  const evidence = collector.collect((snapshot.messages ?? []).filter((message) => message.provenance === 'native-tool' &&
    message.phase === 'end' && message.runId === snapshot.id && message.toolCallId && message.toolName &&
    Number.isFinite(message.at)).map((message) => ({
      runId: snapshot.id, toolCallId: message.toolCallId!, toolName: message.toolName!, phase: 'end', provenance: 'native-tool',
      occurredAt: message.at, parentId: message.parentId, args: message.args, result: message.result,
      status: ['success', 'error', 'unknown'].includes(message.status ?? '') ? message.status as 'success' | 'error' | 'unknown' : 'unknown',
      exitCode: Object.prototype.hasOwnProperty.call(message, 'toolExitCode') ? message.toolExitCode : message.exitCode,
    })));
  for (const [index, correction] of (options.userCorrections ?? []).slice(0, 16).entries()) {
    if (typeof correction.text !== 'string' || !correction.text.trim() || !Number.isFinite(correction.occurredAt)) throw new Error('REMOTE_SKILL_INVALID_USER_CORRECTION');
    evidence.push({ evidenceId: JSON.stringify([origin.runId, 'user-correction', origin.turnId, index]),
      origin: { ...origin }, occurredAt: correction.occurredAt, kind: 'correction', provenance: 'user-input',
      status: 'success', summary: redactSkillText(correction.text) });
  }
  const scopeKey = JSON.stringify([client.serverUrl, projectId, origin.sessionId]);
  let scheduler = schedulers.get(scopeKey);
  if (!scheduler) { scheduler = new SkillReviewScheduler(); schedulers.set(scopeKey, scheduler); }
  const sourceKey = JSON.stringify([origin.turnId, origin.runId]);
  let dispatched = dispatchedSources.get(scheduler);
  if (!dispatched) { dispatched = new Set(); dispatchedSources.set(scheduler, dispatched); }
  if (dispatched.has(sourceKey)) return undefined;
  const triggerJob: SkillLearningJob = { origin, userText: options.userText, finalAnswer: options.finalAnswer, evidence,
    loadedSkills: options.loadedSkills ?? [], config };
  const decision = scheduler.observe(triggerJob);
  const boundScheduler = scheduler;
  if (!decision.eligible) return undefined;
  const publishUndispatched = (error: string, status: 'cancelled' | 'failed' = 'cancelled') => {
    try { options.onState?.({ status, origin: { ...origin }, mode: config.mode, error }); } catch { /* Observers cannot grant authority. */ }
  };
  try { options.onState?.({ status: 'queued', origin: { ...origin }, mode: config.mode }); } catch { /* Observers cannot grant authority. */ }
  if (options.signal?.aborted) { publishUndispatched('SKILL_REVIEW_CANCELLED'); return undefined; }
  const queueKey = JSON.stringify([scopeKey, ++queueSequence]);
  const superseded = pendingReviews.get(scopeKey);
  if (superseded) reviewQueue.cancel(superseded);
  pendingReviews.set(scopeKey, queueKey);
  const readyAt = scheduler.nextReadyAt() ?? Date.now();
  if (readyAt > Date.now()) {
    const ready = await new Promise<boolean>((resolve) => {
      const cancel = () => { clearTimeout(timer); resolve(false); };
      const timer = setTimeout(() => { options.signal?.removeEventListener('abort', cancel); resolve(true); }, readyAt - Date.now());
      options.signal?.addEventListener('abort', cancel, { once: true });
      if (options.signal?.aborted) cancel();
    });
    if (!ready) {
      if (pendingReviews.get(scopeKey) === queueKey) pendingReviews.delete(scopeKey);
      publishUndispatched('SKILL_REVIEW_CANCELLED');
      return undefined;
    }
  }
  if (pendingReviews.get(scopeKey) !== queueKey) { publishUndispatched('SKILL_REVIEW_SUPERSEDED'); return undefined; }
  const cancelQueued = () => reviewQueue.cancel(queueKey);
  options.signal?.addEventListener('abort', cancelQueued, { once: true });
  const pending = reviewQueue.enqueue(queueKey, options, async (_options, queueSignal) => {
  if (options.signal?.aborted || queueSignal.aborted) return undefined;
  const scheduler = boundScheduler;
  // finish(failed) clears scheduler pending. Only an undispatched, independently
  // eligible fresh source can restore it; retained failed evidence is not a retry.
  if (pendingReviews.get(scopeKey) === queueKey && !dispatched.has(sourceKey) &&
    scheduler.nextReadyAt() === undefined && shouldTriggerSkillReview({ origin, evidence, config, terminal: 'completed' }).eligible) {
    scheduler.observe(triggerJob);
  }
  const remainingReadyAt = scheduler.nextReadyAt();
  if (remainingReadyAt !== undefined && remainingReadyAt > Date.now()) {
    const ready = await new Promise<boolean>((resolve) => {
      const finish = (ready: boolean) => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', cancel);
        queueSignal.removeEventListener('abort', cancel);
        resolve(ready);
      };
      const cancel = () => finish(false);
      const timer = setTimeout(() => finish(true), Math.ceil(remainingReadyAt - Date.now()));
      options.signal?.addEventListener('abort', cancel, { once: true });
      queueSignal.addEventListener('abort', cancel, { once: true });
      if (options.signal?.aborted || queueSignal.aborted) cancel();
    });
    if (!ready) return undefined;
  }
  if (options.signal?.aborted || queueSignal.aborted) return undefined;
  if (pendingReviews.get(scopeKey) !== queueKey) return undefined;
  const reservation = scheduler.take();
  if (!reservation) return undefined;
  dispatched.add(sourceKey);
  if (pendingReviews.get(scopeKey) === queueKey) pendingReviews.delete(scopeKey);
  const job = { ...reservation.job, config: { ...reservation.job.config,
    mode: reservation.job.explicit ? reservation.job.config.mode : 'approve-all' as const } };
  let result: SkillMutationResult;
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (options.signal?.aborted || queueSignal.aborted) abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  queueSignal.addEventListener('abort', abort, { once: true });
  try {
    let model = options.model;
    const override = job.config.reviewSelection;
    const selection: GatewaySelection | undefined = override ? { adapter: override.adapter, modelClass: override.modelClass,
      providerId: override.providerId, channelId: override.channelId,
      ...(override.model === undefined ? {} : { modelOverride: override.model }) } : options.selection;
    if (!model && selection) {
      const { createSkillReviewModelPort } = await import('./modelGateway/skillReviewGateway');
      model = createSkillReviewModelPort(selection, job.origin, job.config.reviewTransport);
    }
    if (!model) throw new Error('SKILL_REVIEW_UNAVAILABLE: no configured completion-only HTTP route');
    const host: SkillHostPort = {
      list: () => client.skillRequest<SkillCatalog>(projectId, { action: 'list', origin: job.origin, mode: job.config.mode }, { signal: controller.signal }),
      view: (read) => client.skillRequest<SkillReadResult>(projectId, { action: 'view', origin: job.origin, mode: job.config.mode,
        skillId: read.skillId, ...(read.filePath === undefined ? {} : { filePath: read.filePath }) }, { signal: controller.signal }),
      // Do not pass an abort signal after dispatch: the host must return its real commit/recovery.
      manage: async (proposal) => {
        const result = await client.skillRequest<SkillMutationResult>(projectId, { action: 'manage', origin: job.origin,
          mode: job.config.mode, evidence: job.evidence, proposal }, {
            userInputEvidence: job.evidence.some((item) => item.provenance === 'user-input' &&
              item.origin.runId === job.origin.runId && item.origin.turnId === job.origin.turnId),
          });
        if (!result.origin || Object.keys(result.origin).length !== 5 ||
          Object.entries(job.origin).some(([key, value]) => result.origin[key as keyof SkillOrigin] !== value)) {
          throw new Error('REMOTE_SKILL_MUTATION_ORIGIN_MISMATCH');
        }
        return result;
      },
    };
    result = await runSkillReview(job, { host, model, signal: controller.signal,
      candidateStore: createRemoteSkillCandidateStore({ client, projectId, origin: job.origin }),
      onState: (state) => options.onState?.({ ...structuredClone(state), mode: job.config.mode }) });
  } catch (error) {
    result = { status: 'failed', batchId: `review-${job.origin.runId}`, origin: job.origin, lesson: '',
      operationsApplied: 0, changes: [], riskReasons: [], error: String(error) };
    try { options.onState?.({ status: result.status, origin: { ...job.origin }, mode: job.config.mode,
      result: structuredClone(result), error: result.error }); } catch { /* Observers cannot hide failures. */ }
  } finally {
    options.signal?.removeEventListener('abort', abort);
    queueSignal.removeEventListener('abort', abort);
  }
  scheduler.finish(reservation.id, result.status);
  // Successful coverage keeps the scheduler's evidence watermark fence. Only
  // unresolved attempts need an extra source fence against automatic replay.
  if (!['failed', 'conflicted', 'needs_recovery', 'cancelled'].includes(result.status)) dispatched.delete(sourceKey);
  return result;
  });
  if (options.signal?.aborted) cancelQueued();
  const queued = await pending.finally(() => {
    options.signal?.removeEventListener('abort', cancelQueued);
    if (pendingReviews.get(scopeKey) === queueKey) pendingReviews.delete(scopeKey);
  });
  const result = queued.status === 'completed' ? queued.result : undefined;
  if (!result) {
    publishUndispatched(queued.status === 'failed' ? String(queued.error) :
      options.signal?.aborted ? 'SKILL_REVIEW_CANCELLED' : 'SKILL_REVIEW_NOT_DISPATCHED', queued.status === 'failed' ? 'failed' : 'cancelled');
    return undefined;
  }
  try { options.onResult?.(structuredClone(result)); } catch { /* Observers cannot hide a real commit. */ }
  return result;
}
