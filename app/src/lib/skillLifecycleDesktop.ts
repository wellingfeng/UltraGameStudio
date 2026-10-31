import { evaluateSkillLifecycle, type SkillLifecycleDecision } from '@/runtime/skills/lifecycle';
import type { SkillEntry, SkillLearningConfig } from '@/runtime/skills/types';
export interface SkillLifecycleAdvice extends SkillLifecycleDecision { entry: SkillEntry }
export interface SkillLifecycleAdvisoryOptions {
  /** Exact source workspace/namespace, supplied by the controller, never inferred from root labels. */
  scopeKey: string;
  getEntries: () => SkillEntry[];
  getConfig: () => SkillLearningConfig;
  onResult: (advice: SkillLifecycleAdvice[]) => void;
  onError?: (error: unknown) => void;
  /** Host-supplied metadata only. Unknown provenance protects the package. */
  getProtection?: (entry: SkillEntry) => { backgroundCreated?: boolean; cronReferenced?: boolean };
  isForegroundBusy?: () => boolean;
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
  idleMs?: number;
  intervalMs?: number;
}
const identity = (entry: SkillEntry) => JSON.stringify([entry.rootId, entry.skillId]);
/** UI-idle, low-frequency deterministic advice only. No host/model/archive/delete ports exist here. */
export function startSkillLifecycleAdvisory(options: SkillLifecycleAdvisoryOptions): () => void {
  const idleMs = Math.max(1, options.idleMs ?? 120000);
  const intervalMs = Math.max(idleMs, options.intervalMs ?? 3600000);
  const storage = options.storage ?? window.localStorage;
  const key = `ultragamestudio.skillLifecycleAdvice.v1.${encodeURIComponent(options.scopeKey)}`;
  let lastInteractionAt = Date.now();
  let timer: ReturnType<typeof setTimeout>;
  let stopped = false;
  const observeActivity = () => { lastInteractionAt = Date.now(); };
  const events = ['keydown', 'pointerdown', 'wheel', 'visibilitychange'] as const;
  const schedule = (delay: number) => { if (!stopped) timer = setTimeout(check, delay); };
  const check = () => {
    if (stopped) return;
    const now = Date.now();
    const remaining = idleMs - (now - lastInteractionAt);
    if (remaining > 0) { schedule(remaining); return; }
    if (document.visibilityState === 'hidden' || options.isForegroundBusy?.()) { schedule(idleMs); return; }
    try {
      const raw = storage.getItem(key);
      const parsed: unknown = raw === null ? {} : JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('SKILL_LIFECYCLE_OBSERVATIONS_UNREADABLE');
      const data = parsed as { firstObserved?: Record<string, number>; checkedAt?: number };
      if (data.firstObserved !== undefined && (!data.firstObserved || typeof data.firstObserved !== 'object' || Array.isArray(data.firstObserved)
        || Object.values(data.firstObserved).some(value => typeof value !== 'number' || !Number.isFinite(value)))) throw new Error('SKILL_LIFECYCLE_OBSERVATIONS_UNREADABLE');
      if (typeof data.checkedAt === 'number' && now - data.checkedAt < intervalMs) { schedule(intervalMs - (now - data.checkedAt)); return; }
      const firstObserved: Record<string, number> = {};
      const advice = options.getEntries().slice(0, 2000).map(entry => {
        const decision = evaluateSkillLifecycle({ entry, config: options.getConfig(), now,
          firstObservedAt: data.firstObserved?.[identity(entry)], ...options.getProtection?.(entry) });
        firstObserved[identity(entry)] = decision.firstObservedAt;
        return { ...decision, entry };
      });
      storage.setItem(key, JSON.stringify({ firstObserved, checkedAt: now }));
      options.onResult(advice);
    } catch (error) { options.onError?.(error); }
    schedule(intervalMs);
  };
  for (const event of events) document.addEventListener(event, observeActivity, { passive: true });
  schedule(idleMs);
  return () => {
    stopped = true;
    clearTimeout(timer);
    for (const event of events) document.removeEventListener(event, observeActivity);
  };
}
