import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReferenceProjection, type ReferenceWorker } from './referenceProjection';
import { analyzeReferenceRequest } from './referenceAnalysis';
import { MAX_REFERENCE_TITLE_BYTES, MAX_REFERENCE_SOURCE_BYTES } from './referenceProtocol';
import { admitSources } from './referenceAdmission';
const source = { url: 'https://example.com/docs', title: 'Docs', toolCallId: 'fixture' };
class Transport implements ReferenceWorker {
  onmessage: ReferenceWorker['onmessage'] = null;
  onerror: ReferenceWorker['onerror'] = null;
  onmessageerror: ReferenceWorker['onmessageerror'] = null;
  sent: unknown[] = []; terminated = false;
  postMessage(request: unknown) { this.sent.push(request); }
  terminate() { this.terminated = true; }
}
afterEach(() => vi.useRealTimers());
describe('reference reply admission', () => {
  it('rejects an executable error descriptor even when references are valid', () => {
    let calls = 0; const data = { id: 1, references: [{ ...source, number: 1 }] };
    Object.defineProperty(data, 'error', { get() { calls++; throw new Error('must not execute'); } });
    const worker = new Transport(); const accepted = vi.fn(); const failed = vi.fn(); const projection = new ReferenceProjection(worker, accepted, failed);
    projection.submit('text', [source]);
    try { worker.onmessage!({ data } as MessageEvent); expect(calls).toBe(0); expect(accepted).not.toHaveBeenCalled(); expect(failed).toHaveBeenCalledTimes(1); }
    finally { projection.dispose(); }
  });
  it('accepts native MessageEvent data without depending on an own data field', () => {
    const worker = new Transport(); const accept = vi.fn(); const projection = new ReferenceProjection(worker, accept);
    projection.submit('first', [source]);
    try { worker.onmessage!(new MessageEvent('message', { data: { id: 1, references: [{ ...source, number: 1 }] } })); expect(accept).toHaveBeenCalledTimes(1); }
    finally { projection.dispose(); }
  });
  it.each([undefined, null, {}, { id: 1, references: [null] },
    { id: 1, references: [{ ...source, number: 1, url: 'not-a-url' }] },
    { id: 1, references: [{ ...source, number: Number.MAX_SAFE_INTEGER + 1 }] },
    { id: 1, references: [{ ...source, number: 1, title: { bad: true } }] }])('fails closed and retires all work for malformed reply %#', (data) => {
    vi.useFakeTimers(); const worker = new Transport(); const accept = vi.fn(); const failed = vi.fn();
    const projection = new ReferenceProjection(worker, accept, failed); const callback = worker.onmessage!;
    projection.submit('first', [source]); projection.submit('latest', [source]);
    try {
      expect(() => callback({ data } as MessageEvent)).not.toThrow();
      expect(accept).not.toHaveBeenCalled(); expect(failed).toHaveBeenCalledTimes(1);
      expect(worker.terminated).toBe(true); expect(vi.getTimerCount()).toBe(0);
      expect([worker.onmessage, worker.onerror, worker.onmessageerror]).toEqual([null, null, null]);
      callback({ data: { id: 1, references: [{ ...source, number: 1 }] } } as MessageEvent);
      projection.submit('after failure', [source]); expect(worker.sent).toHaveLength(1);
    } finally { projection.dispose(); }
  });
  it('does not read executable reply fields', () => {
    let calls = 0; const data = Object.defineProperty({}, 'id', { get() { calls++; throw new Error('getter'); } });
    const worker = new Transport(); const failed = vi.fn(); const projection = new ReferenceProjection(worker, vi.fn(), failed);
    projection.submit('first', [source]);
    try { expect(() => worker.onmessage!({ data } as MessageEvent)).not.toThrow(); expect(calls).toBe(0); expect(failed).toHaveBeenCalledTimes(1); }
    finally { projection.dispose(); }
  });
  it('ignores stale ids before looking at their payload and allows current valid completion', () => {
    const worker = new Transport(); const accept = vi.fn(); const projection = new ReferenceProjection(worker, accept);
    projection.submit('first', [source]);
    try {
      worker.onmessage!({ data: { id: 999, references: [null] } } as MessageEvent);
      expect(worker.terminated).toBe(false);
      worker.onmessage!({ data: { id: 1, references: [{ ...source, number: 1 }] } } as MessageEvent);
      expect(accept).toHaveBeenCalledWith('first', [{ ...source, number: 1 }]);
    } finally { projection.dispose(); }
  });
});
describe('reference field and envelope budgets', () => {
  it.each([
    { ...source, title: 'x'.repeat(MAX_REFERENCE_TITLE_BYTES + 1) },
    { ...source, url: 'https://example.com/' + 'x'.repeat(8192) },
    { ...source, toolCallId: 'x'.repeat(1025) },
    { ...source, title: '界'.repeat(1500) },
  ])('rejects oversized field %# before post', (bad) => {
    const worker = new Transport(); const failed = vi.fn(); const projection = new ReferenceProjection(worker, vi.fn(), failed);
    try { projection.submit('text', [bad]); expect(worker.sent).toHaveLength(0); expect(failed).toHaveBeenCalledTimes(1); }
    finally { projection.dispose(); }
  });
  it('bounds aggregate source bytes, not just source count', () => {
    const sources = Array.from({ length: 100 }, (_, i) => ({ ...source, title: 'x'.repeat(3000), toolCallId: String(i) }));
    expect(JSON.stringify(sources).length).toBeGreaterThan(MAX_REFERENCE_SOURCE_BYTES);
    expect(admitSources(sources)).toBeNull();
  });
  it('rejects escaped request byte overflow while character count is within limit', () => {
    const worker = new Transport(); const failed = vi.fn(); const projection = new ReferenceProjection(worker, vi.fn(), failed);
    try { projection.submit('\u0000'.repeat(800_000), [source]); expect(worker.sent).toHaveLength(0); expect(failed).toHaveBeenCalledTimes(1); }
    finally { projection.dispose(); }
  });
  it('rejects oversized matching reply before accept', () => {
    const worker = new Transport(); const failed = vi.fn(); const accepted = vi.fn(); const projection = new ReferenceProjection(worker, accepted, failed);
    projection.submit('text', [source]);
    try { worker.onmessage!({ data: { id: 1, references: [{ ...source, number: 1, title: 'x'.repeat(MAX_REFERENCE_TITLE_BYTES + 1) }] } } as MessageEvent); expect(accepted).not.toHaveBeenCalled(); expect(failed).toHaveBeenCalledTimes(1); }
    finally { projection.dispose(); }
  });
  it('rejects worker output title derived from Markdown before post', () => {
    const result = analyzeReferenceRequest({ id: 9, text: '[' + 'x'.repeat(MAX_REFERENCE_TITLE_BYTES + 1) + '](https://example.com/docs)', sources: [{ ...source, title: source.url }] });
    expect(result.references).toBeUndefined(); expect(result.error).toBeDefined();
  });
});
