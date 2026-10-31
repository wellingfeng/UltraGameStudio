import { acquireReviewBackground, subscribeReviewAvailable } from '@/runtime/memory/review';

export type SkillQueueResult<T> =
  | { status: 'completed'; result: T }
  | { status: 'cancelled' }
  | { status: 'failed'; error: unknown };

interface QueueEntry<Job, Result> {
  key: string;
  job: Job;
  run: (job: Job, signal: AbortSignal) => Promise<Result>;
  resolve: (result: SkillQueueResult<Result>) => void;
}

/** Optional renderer-wide admission; standalone queues keep caller-owned priority. */
export class SkillLearningQueue<Job, Result> {
  private foregroundCount = 0;
  private foregroundByKey = new Map<string, number>();
  private pending = new Map<string, QueueEntry<Job, Result>>();
  private active: { entry: QueueEntry<Job, Result>; controller: AbortController } | null = null;
  private stopWaiting?: () => void;

  constructor(private readonly sharedOwner?: string) {}

  get foregroundActive(): boolean { return this.foregroundCount > 0 || this.foregroundByKey.size > 0; }

  cancel(key?: string): void {
    for (const [pendingKey, entry] of this.pending) {
      if (key !== undefined && key !== pendingKey) continue;
      this.pending.delete(pendingKey);
      entry.resolve({ status: 'cancelled' });
    }
    if (this.active && (key === undefined || this.active.entry.key === key)) this.active.controller.abort();
    if (!this.pending.size) { this.stopWaiting?.(); this.stopWaiting = undefined; }
  }

  foregroundStarted(key?: string): () => void {
    if (key === undefined) this.foregroundCount += 1;
    else this.foregroundByKey.set(key, (this.foregroundByKey.get(key) ?? 0) + 1);
    if (this.active && (key === undefined || key === this.active.entry.key)) this.active.controller.abort();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (key === undefined) this.foregroundCount -= 1;
      else {
        const count = this.foregroundByKey.get(key)! - 1;
        if (count) this.foregroundByKey.set(key, count);
        else this.foregroundByKey.delete(key);
      }
      this.drain();
    };
  }

  enqueue(key: string, job: Job, run: QueueEntry<Job, Result>['run']): Promise<SkillQueueResult<Result>> {
    const promise = new Promise<SkillQueueResult<Result>>((resolve) => {
      this.pending.get(key)?.resolve({ status: 'cancelled' });
      this.pending.set(key, { key, job, run, resolve });
    });
    queueMicrotask(() => this.drain());
    return promise;
  }

  private drain(): void {
    if (this.foregroundCount || this.active) return;
    const entry = [...this.pending.values()].find((candidate) => !this.foregroundByKey.has(candidate.key));
    if (!entry) return;
    const slot = this.sharedOwner === undefined ? undefined : acquireReviewBackground(this.sharedOwner);
    if (this.sharedOwner !== undefined && !slot) {
      this.stopWaiting ??= subscribeReviewAvailable(() => this.drain());
      return; // Preserve the exact pending entry/reservation until admission.
    }
    this.stopWaiting?.();
    this.stopWaiting = undefined;
    this.pending.delete(entry.key);
    const controller = new AbortController();
    const abort = () => controller.abort(slot?.signal.reason);
    slot?.signal.addEventListener('abort', abort, { once: true });
    this.active = { entry, controller };
    void Promise.resolve().then(() => {
      // Foreground/cancel may win after reservation but before this dispatch.
      if (controller.signal.aborted) throw new Error('SKILL_REVIEW_CANCELLED');
      return entry.run(entry.job, controller.signal);
    }).then(
      (result) => entry.resolve({ status: 'completed', result }),
      (error) => entry.resolve(controller.signal.aborted
        ? { status: 'cancelled' }
        : { status: 'failed', error }),
    ).finally(() => {
      this.active = null;
      slot?.signal.removeEventListener('abort', abort);
      slot?.release(); // The callback includes actual host completion and revocation.
      this.drain();
    });
  }
}
