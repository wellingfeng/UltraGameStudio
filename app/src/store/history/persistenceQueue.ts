import { estimateHistoryBytes, estimateRetainedHistoryBytes, historySerializationPeakBytes, HISTORY_PAYLOAD_BYTES, HISTORY_PENDING_BYTES } from './payloadBudget';

interface Job {
  bytes: number;
  serializationBytes?: number;
  epoch: number;
  key?: string;
  payload: unknown;
  run: (payload: unknown) => Promise<unknown>;
  merge?: (previous: unknown, incoming: unknown) => unknown;
  observeFailure?: boolean;
  waiters: Array<{ resolve: (value: unknown) => void; reject: (error: unknown) => void }>;
  completion?: { promise: Promise<void>; resolve: () => void };
}

/** Coalesce only unstarted work in the same lane, never through a barrier. */
export class PersistenceQueue {
  private pending: Job[] = [];
  private activeKeys = new Set<string | undefined>();
  private activeJobs = new Set<Job>();
  private admitted = 0;
  private retainedBytes = 0;
  private serializationBytes = 0;
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

  /** Ordering only: no admission, payload retention or consumption of failures. */
  waitForAccepted(): Promise<void> {
    return Promise.all([...this.activeJobs, ...this.pending].map((job) => {
      if (!job.completion) {
        let resolve!: () => void;
        const promise = new Promise<void>((done) => { resolve = done; });
        job.completion = { promise, resolve };
      }
      return job.completion.promise;
    })).then(() => undefined);
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
        waiters: [{ resolve: () => resolve(), reject }] });
      this.drain();
    });
    const promise = run.finally(() => { if (this.flushing?.promise === promise) this.flushing = undefined; });
    // A new target requires an intervening accepted caller. Barriers count
    // against the 128 slots, with only the last flush reserving slot 129;
    // repeated callers with the same target allocate nothing.
    this.flushing = { target, promise, sampledFailure: () => sampledFailure };
    return promise;
  }

  /** Terminal payloads retain bounded references while awaiting execution bytes. */
  enqueue<T, P>(run: (payload: P) => Promise<T>, payload: P, key?: string, merge?: (a: P, b: P) => P | null, allowChunked = false, terminal = false): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.admitted >= 128) { const error = new Error('HISTORY_QUEUE_FULL'); this.failure ??= { error }; reject(error); return; }
      const epoch = this.mergeEpoch + (!merge || key === undefined || terminal ? 1 : 0);
      let previous: Job | undefined;
      for (let i = this.pending.length - 1; i >= 0; i -= 1) {
        const candidate = this.pending[i];
        if (candidate.epoch !== epoch || candidate.key === undefined || !candidate.merge) break;
        if (candidate.key === key) { previous = candidate; break; }
      }
      let combined: P | null | undefined, bytes: number, serializationBytes = 0;
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
        const next = combined ?? payload;
        bytes = estimate(next);
        if (terminal) {
          // Terminal work waits INSIDE the existing 128-slot/64-MiB queue,
          // charging all retained references, including work not yet started.
          // Never create a second, unaccounted queue of payload closures.
          bytes = estimateRetainedHistoryBytes(next, this.maxPayloadBytes);
          try {
            // Input peak is 4x logical bytes. Twice that also covers the
            // escaped output/envelope (12 bytes per JSON UTF-16 unit).
            // Large/chunked transactions run alone; the serializer remains
            // the authoritative global reservation through actual writes.
            serializationBytes = Math.min(this.maxBytes, 3 * historySerializationPeakBytes(estimateHistoryBytes(next, this.maxPayloadBytes)));
          } catch (error) {
            if (!(error instanceof Error) || error.message !== 'HISTORY_PAYLOAD_TOO_LARGE') throw error;
            serializationBytes = this.maxBytes;
          }
        }
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
      // Jobs erase P/T only at the heterogeneous queue boundary.
      const waiter = { resolve: (value: unknown) => resolve(value as T), reject };
      if (combined !== null && combined !== undefined) {
        previous!.payload = combined;
        previous!.bytes = bytes;
        previous!.serializationBytes = serializationBytes;
        previous!.waiters.push(waiter);
      } else {
        this.pending.push({ bytes, serializationBytes, epoch, key, payload,
          run: (value) => run(value as P), merge: merge && !terminal ? (a, b) => merge(a as P, b as P) : undefined, waiters: [waiter] });
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
        // Do not reorder a lane by bypassing its waiting expensive final.
        const earlierInLane = this.pending.slice(0, i).some((job) => job.key === candidate.key);
        const cost = candidate.serializationBytes ?? 0;
        if (!this.activeKeys.has(candidate.key) && !earlierInLane &&
            this.serializationBytes < this.maxBytes && cost <= this.maxBytes - this.serializationBytes &&
            (cost < this.maxBytes || this.activeKeys.size === 0)) { index = i; break; }
      }
      if (index < 0) return;
      const [job] = this.pending.splice(index, 1);
      this.activeKeys.add(job.key);
      this.activeJobs.add(job);
      this.serializationBytes += job.serializationBytes ?? 0;
      const completed = () => {
      this.admitted -= job.waiters.length;
      this.retainedBytes -= job.bytes;
      this.serializationBytes -= job.serializationBytes ?? 0;
      this.activeJobs.delete(job);
      job.completion?.resolve();
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
