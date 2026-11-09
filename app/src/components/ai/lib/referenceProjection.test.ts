import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReferenceProjection, MAX_REFERENCE_ANALYSIS_SOURCES, REFERENCE_ANALYSIS_TIMEOUT_MS, type ReferenceWorker } from './referenceProjection';
import { analyzeReferenceRequest, type ReferenceAnalysisRequest, type ReferenceAnalysisResponse } from './referenceAnalysis';
const source = { url: 'https://example.com/docs', title: 'Docs', toolCallId: 'web' };
class Transport implements ReferenceWorker {
  onmessage: ReferenceWorker['onmessage'] = null;
  onerror: ReferenceWorker['onerror'] = null;
  onmessageerror: ReferenceWorker['onmessageerror'] = null;
  sent: ReferenceAnalysisRequest[] = [];
  terminated = false;
  postMessage(request: ReferenceAnalysisRequest) { this.sent.push(request); }
  terminate() { this.terminated = true; }
  complete(index: number) { this.onmessage?.({ data: analyzeReferenceRequest(this.sent[index]) } as MessageEvent<ReferenceAnalysisResponse>); }
}
afterEach(() => vi.useRealTimers());
describe('component-owned reference projection transport', () => {
  it('bounds pending requests and timers while parsing only the initial and newest snapshots', () => {
    vi.useFakeTimers();
    const worker = new Transport(); const accept = vi.fn();
    const projection = new ReferenceProjection(worker, accept);
    projection.submit('[Docs](https://example.com/docs)', [source]);
    for (let i = 0; i < 100; i++) projection.submit(`[Docs](https://example.com/docs) ${i}`, [source]);
    expect(worker.sent).toHaveLength(1); expect(vi.getTimerCount()).toBe(1);
    worker.complete(0);
    expect(accept).not.toHaveBeenCalled(); expect(worker.sent).toHaveLength(2);
    expect(worker.sent[1].text).toBe('[Docs](https://example.com/docs) 99');
    expect(vi.getTimerCount()).toBe(1);
    worker.complete(1);
    expect(accept).toHaveBeenCalledWith(worker.sent[1].text, [{ ...source, number: 1 }]);
    expect(vi.getTimerCount()).toBe(0);
    projection.dispose(); expect(worker.terminated).toBe(true);
  });
  it.each(['post', 'response', 'sources', 'timeout'] as const)('%s failure releases requests and does not accept queued late events', (failure) => {
    vi.useFakeTimers();
    const worker = new Transport(); const accept = vi.fn(); const failed = vi.fn();
    if (failure === 'post') worker.postMessage = () => { throw new Error('Transport unavailable'); };
    const projection = new ReferenceProjection(worker, accept, failed);
    const callback = worker.onmessage;
    projection.submit('[Docs](https://example.com/docs)', failure === 'sources' ? Array(MAX_REFERENCE_ANALYSIS_SOURCES + 1).fill(source) : [source]);
    if (failure === 'response') callback?.({ data: { id: 1, error: 'REFERENCE_ANALYSIS_FAILED' } } as MessageEvent);
    if (failure === 'timeout') vi.advanceTimersByTime(REFERENCE_ANALYSIS_TIMEOUT_MS);
    expect(worker.terminated).toBe(true); expect(vi.getTimerCount()).toBe(0); expect(failed).toHaveBeenCalledTimes(1);
    callback?.({ data: analyzeReferenceRequest({ id: 1, text: '[Docs](https://example.com/docs)', sources: [source] }) } as MessageEvent);
    projection.submit('late', [source]);
    expect(accept).not.toHaveBeenCalled(); expect(failed).toHaveBeenCalledTimes(1);
  });
});
