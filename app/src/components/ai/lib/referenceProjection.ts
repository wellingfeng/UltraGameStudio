import type { MessageReference, ReferenceSource } from '@/lib/messageReferences';
import type { ReferenceAnalysisRequest, ReferenceAnalysisResponse } from './referenceAnalysis';
import { admitAnalysisInput, admitReferences, inertReplyEnvelope, ownData, referenceEventData } from './referenceAdmission';

export const REFERENCE_ANALYSIS_TIMEOUT_MS = 10_000;
export { MAX_REFERENCE_ANALYSIS_CHARS, MAX_REFERENCE_ANALYSIS_SOURCES } from './referenceProtocol';
export interface ReferenceWorker {
  postMessage(request: ReferenceAnalysisRequest): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<ReferenceAnalysisResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
}

/** One in-flight request + one replaceable latest snapshot, owned by one bubble.
 * Failure/timeout/oversize discards streaming projection, never runs a main-thread
 * fallback parser. Final rendering and persistence remain synchronous/exact.
 */
export class ReferenceProjection {
  private disposed = false;
  private sequence = 0;
  private latest?: ReferenceAnalysisRequest;
  private inFlight?: ReferenceAnalysisRequest;
  private pending?: ReferenceAnalysisRequest;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private worker: ReferenceWorker, private accept: (text: string, references: MessageReference[]) => void,
    private failed: () => void = () => {}) {
    worker.onmessage = (event) => {
      if (this.disposed) return;
      const data = referenceEventData(event);
      const id = ownData(data, 'id');
      if (id === undefined) { this.fail(); return; }
      // A stale/unknown id cannot revive work or consume the active request.
      if (!this.inFlight || id !== this.inFlight.id) return;
      if (!inertReplyEnvelope(data)) { this.fail(); return; }
      const references = admitReferences(ownData(data, 'references'));
      const error = ownData(data, 'error');
      if (error !== undefined || !references) { this.fail(); return; }
      clearTimeout(this.timer); this.timer = undefined;
      const completed = this.inFlight;
      this.inFlight = undefined;
      if (completed.id === this.latest?.id) this.accept(completed.text, references);
      const pending = this.pending; this.pending = undefined;
      if (pending) this.send(pending);
    };
    worker.onerror = worker.onmessageerror = () => this.fail();
  }

  submit(text: string, sources: ReferenceSource[]): void {
    if (this.disposed || this.latest?.text === text) return;
    const admitted = admitAnalysisInput(text, sources);
    if (!admitted) { this.fail(); return; }
    const request = { id: ++this.sequence, ...admitted };
    this.latest = request;
    if (this.inFlight) this.pending = request;
    else this.send(request);
  }

  private send(request: ReferenceAnalysisRequest): void {
    if (this.disposed) return;
    this.inFlight = request;
    this.timer = setTimeout(() => this.fail(), REFERENCE_ANALYSIS_TIMEOUT_MS);
    try { this.worker.postMessage(request); } catch { this.fail(); }
  }

  private fail(): void {
    if (this.disposed) return;
    this.dispose();
    this.failed();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.timer); this.timer = undefined;
    this.inFlight = this.pending = this.latest = undefined;
    this.worker.onmessage = this.worker.onerror = this.worker.onmessageerror = null;
    this.worker.terminate();
  }
}
