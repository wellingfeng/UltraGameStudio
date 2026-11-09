import { stringifyCanonicalHistory, type SerializationResponse } from './serializeValue';
import { estimateHistoryBytes, prepareHistoryTransport, historySerializationPeakBytes, HistoryByteBudget, historyJsonEnvelopeBytes } from './payloadBudget';
let worker: Worker | undefined;
let sequence = 0;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
const byteBudget = new HistoryByteBudget();
const requests = new Map<number, { resolve: (json: string) => void; reject: (error: unknown) => void; release: () => void; timer: ReturnType<typeof setTimeout> }>();

export interface SerializationOptions {
  /** Additional budget, never a replacement for the global bound. */
  budget?: HistoryByteBudget;
  relPath?: string;
  /** Keep output/envelope permits until the actual write completes. */
  onSerialized?: (json: string) => Promise<void>;
}
function reserve(bytes: number, extra?: HistoryByteBudget): () => void {
  const release = byteBudget.reserve(bytes);
  let releaseExtra: (() => void) | undefined;
  try { if (extra && extra !== byteBudget) releaseExtra = extra.reserve(bytes); }
  catch (error) { release(); throw error; }
  return () => { release(); releaseExtra?.(); };
}
function scheduleIdle(): void {
  if (requests.size) return;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { worker?.terminate(); worker = undefined; idleTimer = undefined; }, 5_000);
  (idleTimer as { unref?: () => void }).unref?.();
}
function failWorker(reason: string): void {
  // Timeout is NOT clone completion: terminate its owner BEFORE releasing.
  worker?.terminate(); worker = undefined;
  if (idleTimer) clearTimeout(idleTimer); idleTimer = undefined;
  for (const request of requests.values()) { clearTimeout(request.timer); request.release(); request.reject(new Error(reason)); }
  requests.clear();
}

/** Account inert record structure BEFORE postMessage can clone it. */
export async function serializeHistory(value: unknown, options: SerializationOptions = {}): Promise<string> {
  if (requests.size >= 64) throw new Error('HISTORY_SERIALIZATION_FULL');
  const releaseInput = reserve(historySerializationPeakBytes(estimateHistoryBytes(value)), options.budget);
  let projection: unknown;
  try {
  projection = prepareHistoryTransport(value);
  const finish = async (json: string): Promise<string> => {
    const releaseOutput = reserve(historyJsonEnvelopeBytes(json, options.relPath), options.budget);
    projection = undefined;
    releaseInput();
    try { await options.onSerialized?.(json); return json; }
    finally { releaseOutput(); }
  };
  if (typeof Worker === 'undefined') {
    try { return await finish(stringifyCanonicalHistory(projection)); }
    finally { releaseInput(); }
  }
  if (idleTimer) clearTimeout(idleTimer);
  if (!worker) {
    try { worker = new Worker(new URL('./serialization.worker.ts', import.meta.url), { type: 'module' }); }
    catch {
      try { return await finish(stringifyCanonicalHistory(projection)); }
      finally { releaseInput(); }
    }
    const source = worker;
    worker.onmessage = (event: MessageEvent<SerializationResponse>) => {
      if (worker !== source) return;
      const { id, json, error } = event.data;
      const pending = requests.get(id);
      if (!pending) return;
      requests.delete(id); clearTimeout(pending.timer);
      if (error || typeof json !== 'string') { pending.release(); pending.reject(new Error(error || 'HISTORY_SERIALIZATION_INVALID')); }
      else pending.resolve(json);
      scheduleIdle();
    };
    const onFailure = () => { if (worker === source) failWorker('HISTORY_SERIALIZATION_WORKER_FAILED'); };
    worker.onerror = onFailure; worker.onmessageerror = onFailure;
  }
  const json = await new Promise<string>((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => failWorker('HISTORY_SERIALIZATION_TIMEOUT'), 15_000);
    requests.set(id, { resolve, reject, timer, release: releaseInput });
    try { worker!.postMessage({ id, value: projection, canonicalVersion: 1 }); }
    catch (error) { requests.delete(id); clearTimeout(timer); releaseInput(); reject(error); scheduleIdle(); }
  });
  return await finish(json);
  } finally { projection = undefined; releaseInput(); }
}
