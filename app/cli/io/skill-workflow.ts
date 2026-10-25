/** Node host orchestration; algorithms live in the shared skills runtime. */
import type { SkillLearningConfig, SkillMutationResult, SkillOrigin, SkillNativeToolEvent, SkillReviewModelPort, SkillLearningJob, SkillEvidence } from '../../src/runtime/skills/types';
import type { NodeSkillToolOptions } from './skill-tools';
import { SkillEvidenceCollector } from '../../src/runtime/skills/evidence';
import { isCliVerificationEvent } from '../../src/runtime/skills/cliHost';
import { SkillReviewScheduler } from '../../src/runtime/skills/trigger';
import { runSkillReview } from '../../src/runtime/skills/review';
import { loadSkillContext, type LoadedSkillContext } from '../../src/runtime/skills/context';
import { loadNodeSkillLearningConfig, resolveNodeSkillReviewRoute, type ResolvedRoute } from '../config/providers';
import { createNodeSkillHostPort, createNodeWorkspaceSkillRequest, type NodeSkillHostOptions } from './skill-host';
import { createNodeSkillReviewModelPort } from './skill-review-model';
import { createCliSkillReviewModelPort } from './skill-review-capability';
import { createNodeSkillCandidateStore } from './skill-candidate-store';

export interface NodeSkillWorkflowOptions {
  origin: SkillOrigin;
  cwd: string;
  adapter: string;
  prompt: string;
  explicit?: boolean;
  config?: Partial<SkillLearningConfig>;
  /** Caller-resolved HTTP route; no credential discovery and no CLI fallback. */
  route?: ResolvedRoute | null;
  model?: SkillReviewModelPort;
  request?: NodeSkillHostOptions['request'];
  signal?: AbortSignal;
  explicitSkillIds?: readonly string[];
}
export type NodeSkillWorkflowOutcome =
  | { status: 'unavailable' | 'disabled' | 'skipped'; origin: SkillOrigin; reason: string }
  | { status: 'reviewed'; origin: SkillOrigin; result: SkillMutationResult };

export function createNodeSkillWorkflow(options: NodeSkillWorkflowOptions) {
  const origin = Object.freeze({ ...options.origin });
  const config = loadNodeSkillLearningConfig(options.cwd, options.config);
  const collector = new SkillEvidenceCollector(origin);
  collector.collect([], options.prompt);
  const collectors = new Map<string, SkillEvidenceCollector>([[origin.runId, collector]]);
  const verifiedCalls = new Set<string>();
  let reviewOrigin: SkillOrigin = origin;
  const scheduler = new SkillReviewScheduler();
  const request = options.request ?? createNodeWorkspaceSkillRequest({ cwd: options.cwd, hostId: origin.hostId, workspaceId: origin.workspaceId });
  let loadedSkills: SkillLearningJob['loadedSkills'] = [];
  let context: Promise<LoadedSkillContext> | undefined;
  let finished: Promise<NodeSkillWorkflowOutcome> | undefined;
  const reviewModel = (): SkillReviewModelPort => {
    if (options.model) return options.model;
    if (config.reviewSelection) return createNodeSkillReviewModelPort({ route: resolveNodeSkillReviewRoute({
      adapter: config.reviewSelection.adapter, modelClass: config.reviewSelection.modelClass,
      providerId: config.reviewSelection.providerId, channelId: config.reviewSelection.channelId,
      ...(config.reviewSelection.model !== undefined ? { modelOverride: config.reviewSelection.model } : {}),
    }, options.cwd, config.reviewTransport) });
    if (options.route) return createNodeSkillReviewModelPort({ route: options.route });
    return createCliSkillReviewModelPort(options.adapter);
  };
  const snapshotEvidence = (): SkillEvidence[] => [...collectors.values()].flatMap((source) => source.snapshot()).map((item) =>
    verifiedCalls.has(item.evidenceId) ? { ...item, kind: 'verification' as const } : item);
  return {
    /** Host-only foreground bridge options; never append request/origin to a provider payload. */
    foregroundTools(): NodeSkillToolOptions {
      return { origin, request, mode: config.mode, allowManage: config.enabled && config.mode !== 'off',
        evidence: snapshotEvidence, signal: options.signal };
    },
    loadContext(): Promise<LoadedSkillContext> {
      context ??= (async () => {
        const host = createNodeSkillHostPort({ origin, request, mode: 'off' });
        let model: SkillReviewModelPort | undefined;
        try { model = reviewModel(); } catch { /* Semantic selection is optional; no fallback dispatch. */ }
        const loaded = await loadSkillContext({ host, origin, prompt: options.prompt, explicitSkillIds: options.explicitSkillIds,
          signal: options.signal, model });
        loadedSkills = loaded.loadedSkills;
        return loaded;
      })();
      return context;
    },
    onNativeToolEvent(event: SkillNativeToolEvent): void {
      if (finished || (event.runId !== origin.runId && !event.runId.startsWith(`${origin.runId}/cli/`))) return;
      let source = collectors.get(event.runId);
      if (!source) {
        source = new SkillEvidenceCollector({ ...origin, runId: event.runId });
        collectors.set(event.runId, source);
      }
      source.collect([event]);
      if (isCliVerificationEvent(event)) verifiedCalls.add(JSON.stringify([event.runId, event.toolCallId]));
      if (event.phase === 'end' && event.provenance === 'native-tool' && event.status === 'success') reviewOrigin = { ...origin, runId: event.runId };
    },
    /** Only a trusted Node check runner calls this; never a model response. */
    onHostVerification(check: { toolCallId: string; command: string; exitCode: number | null; output: string }): void {
      if (finished || !check.toolCallId) return;
      const exitCode = check.exitCode === null || Number.isSafeInteger(check.exitCode) ? check.exitCode : undefined;
      collector.collect([{ runId: origin.runId, toolCallId: check.toolCallId, toolName: 'verify-command', phase: 'end',
        provenance: 'host-check', args: { command: check.command }, result: check.output, exitCode,
        status: exitCode === 0 ? 'success' : typeof exitCode === 'number' ? 'error' : 'unknown' }]);
      verifiedCalls.add(JSON.stringify([origin.runId, check.toolCallId]));
      if (exitCode === 0) reviewOrigin = origin;
    },
    finish(result: { finalAnswer: string; terminal: 'completed' | 'cancelled' | 'failed' }): Promise<NodeSkillWorkflowOutcome> {
      finished ??= (async (): Promise<NodeSkillWorkflowOutcome> => {
        if (!config.enabled || config.mode === 'off') return { status: 'disabled', origin, reason: 'Skill learning is disabled.' };
        let model: SkillReviewModelPort;
        try { model = reviewModel(); }
        catch (error) { return { status: 'unavailable', origin, reason: String(error) }; }
        const evidence = snapshotEvidence();
        const job = { origin: reviewOrigin, userText: options.prompt, finalAnswer: result.finalAnswer, evidence, loadedSkills, config, explicit: options.explicit };
        const decision = scheduler.observe(job, result.terminal);
        if (!decision.eligible) return { status: 'skipped', origin, reason: decision.reason };
        const reservation = scheduler.take();
        if (!reservation) return { status: 'skipped', origin, reason: 'scheduler-not-ready' };
        const host = createNodeSkillHostPort({ origin: reservation.job.origin, request, mode: 'approve-all', evidence: reservation.job.evidence });
        const mutation = await runSkillReview(reservation.job, { host, model, signal: options.signal,
          candidateStore: createNodeSkillCandidateStore(options.cwd) });
        scheduler.finish(reservation.id, mutation.status);
        return { status: 'reviewed', origin, result: mutation };
      })();
      return finished;
    },
  };
}
