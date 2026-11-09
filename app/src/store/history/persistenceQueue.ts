import { estimateHistoryBytes, estimateRetainedHistoryBytes, HISTORY_PAYLOAD_BYTES, HISTORY_PENDING_BYTES } from './payloadBudget';

interface Job {
  bytes: number;
  epoch: number;
  key?: string;
  payload: unknown;
  run: (payload: any) => Promise<any>;
  merge?: (previous: any, incoming: any) => any | null;
  observeFailure?: boolean;
  waiters: Array<{ resolve: (value: any) => void; reject: (error: unknown) => void }>;
}

/** Coalesce only unstarted work in the same lane, never through a barrier. */
export class PersistenceQueue {
  private pending: Job[] = [];
  private activeKeys = new Set<string | undefined>();
  private admitted = 0;
  private retainedBytes = 0;
  private readonly maxBytes: number;
  private readonly maxPayloadBytes: number;
  private mergeEpoch = 0;
  private failure: { error: unknown } | undefined;
  private admissionTarget = 0;
  private flushing: { target: number; promise: Promise<void>; sampledFailure: () => boolean } | undefined;

  constructor(limits: { maxBytes?: number; maxPayloadBytes?: number } = {}) {
    this.maxBytes = limits.maxBytes ?? HISTORY_PENDING_BYTES;
    this.maxPayloadBytes = limits.maxPayloadBytes ?? HISTORY_PAYLOAD_BYTES;
  }

  flush(): Promise<void> {
    const target = this.admissionTarget;
    // A rejected admission does not advance target, but a barrier that already
    // sampled failure cannot acknowledge that newly recorded rejection.
    if (this.flushing?.target === target && (!this.flushing.sampledFailure() || !this.failure)) return this.flushing.promise;
    let sampledFailure = false;
    const run = new Promise<void>((resolve, reject) => {
      // One reserved global barrier still admits flush when the queue is full.
      this.admitted += 1;
      this.pending.push({ bytes: 0, epoch: ++this.mergeEpoch, payload: undefined, observeFailure: false,
        run: async () => { sampledFailure = true; const failure = this.failure; this.failure = undefined; if (failure) throw failure.error; },
        waiters: [{ resolve, reject }] });
      this.drain();
    });
    const promise = run.finally(() => { if (this.flushing?.promise === promise) this.flushing = undefined; });
    // A new target requires an intervening accepted caller. Barriers count
    // against the 128 slots, with only the last flush reserving slot 129;
    // repeated callers with the same target allocate nothing.
    this.flushing = { target, promise, sampledFailure: () => sampledFailure };
    return promise;
  }

  enqueue<T, P>(run: (payload: P) => Promise<T>, payload: P, key?: string, merge?: (a: P, b: P) => P | null, allowChunked = false): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.admitted >= 128) { const error = new Error('HISTORY_QUEUE_FULL'); this.failure ??= { error }; reject(error); return; }
      const epoch = this.mergeEpoch + (!merge || key === undefined ? 1 : 0);
      let previous: Job | undefined;
      for (let i = this.pending.length - 1; i >= 0; i -= 1) {
        const candidate = this.pending[i];
        if (candidate.epoch !== epoch || candidate.key === undefined || !candidate.merge) break;
        if (candidate.key === key) { previous = candidate; break; }
      }
      let combined: P | null | undefined, bytes: number;
      try {
        // Merge functions must be pure; validate incoming work before invoking
        // them and commit replacement/accounting ONLY after merged admission.
        const estimate = (value: P) => {
          try { return estimateHistoryBytes(value, this.maxPayloadBytes); }
          catch (error) {
            if (!allowChunked || !(error instanceof Error) || error.message !== 'HISTORY_PAYLOAD_TOO_LARGE') throw error;
            const retained = estimateRetainedHistoryBytes(value, this.maxPayloadBytes);
            if (retained < 512 * 1024) throw error;
            return retained;
          }
        };
        estimate(payload);
        combined = key && merge && previous?.key === key && previous.merge
          ? merge(previous.payload as P, payload) : null;
        bytes = estimate(combined ?? payload);
        const delta = bytes - (combined != null ? previous!.bytes : 0);
        if (delta > this.maxBytes - this.retainedBytes) throw new Error('HISTORY_QUEUE_BYTES_FULL');
        this.retainedBytes += delta;
      } catch (cause) {
        const error = cause instanceof Error && cause.message === 'HISTORY_PAYLOAD_TOO_LARGE'
          ? new Error('HISTORY_QUEUE_BYTES_FULL') : cause;
        this.failure ??= { error }; reject(error); return;
      }
      this.admitted += 1;
      this.admissionTarget += 1;
      this.mergeEpoch = epoch;
      if (combined !== null && combined !== undefined) {
        previous!.payload = combined;
        previous!.bytes = bytes;
        previous!.waiters.push({ resolve, reject });
      } else {
        this.pending.push({ bytes, epoch, key, payload, run, merge, waiters: [{ resolve, reject }] });
      }
      this.drain();
    });
  }

  private drain(): void {
    if (this.activeKeys.has(undefined)) return;
    while (this.activeKeys.size < 4) {
      let index = -1;
      for (let i = 0; i < this.pending.length; i += 1) {
        const candidate = this.pending[i];
        if (candidate.key === undefined) {
          if (i === 0 && this.activeKeys.size === 0) index = 0;
          break;
        }
        if (!this.activeKeys.has(candidate.key)) { index = i; break; }
      }
      if (index < 0) return;
      const [job] = this.pending.splice(index, 1);
      this.activeKeys.add(job.key);
      const completed = () => {
      this.admitted -= job.waiters.length;
      this.retainedBytes -= job.bytes;
      this.activeKeys.delete(job.key); this.drain();
      };
      void Promise.resolve().then(() => job.run(job.payload)).then(
        (result) => { completed(); for (const waiter of job.waiters) waiter.resolve(result); },
        (error) => { if (job.observeFailure !== false) this.failure ??= { error }; completed(); for (const waiter of job.waiters) waiter.reject(error); },
      );
      if (job.key === undefined) return;
    }
  }
}
