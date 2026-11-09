import { describe, expect, it, vi } from 'vitest';
import { analyzeReferenceRequest, type ReferenceAnalysisRequest } from './referenceAnalysis';
const source = { url: 'https://example.com/docs', title: 'Docs', toolCallId: 'fixture' };
describe('reference Worker request exceptions', () => {
  it.each([null, undefined, { id: '1', text: 'text', sources: [source] }, { id: -1, text: 'text', sources: [source] },
    { id: 12, text: 42, sources: [source] }, { id: 13, text: 'text', sources: [null] },
    { id: 14, text: 'text', sources: [{ ...source, extra: 1n }] },
    { id: 15, text: 'text', sources: [{ ...source, title: 'x'.repeat(4 * 1024 * 1024) }] }])('returns safe error without throwing for malformed request %#', (request) => {
    let result: ReturnType<typeof analyzeReferenceRequest> | undefined;
    expect(() => { result = analyzeReferenceRequest(request as unknown as ReferenceAnalysisRequest); }).not.toThrow();
    expect(result?.error).toBe('REFERENCE_ANALYSIS_FAILED'); expect(result?.references).toBeUndefined();
    expect(Number.isSafeInteger(result?.id)).toBe(true);
    expect(result?.id).toBe(typeof request?.id === 'number' && request.id > 0 ? request.id : 0);
  });
  it('never calls an id getter or toJSON in catch handling', () => {
    let calls = 0; const request = { toJSON() { calls++; throw new Error('toJSON'); } };
    Object.defineProperty(request, 'id', { get() { calls++; throw new Error('getter'); } });
    expect(() => analyzeReferenceRequest(request as unknown as ReferenceAnalysisRequest)).not.toThrow(); expect(calls).toBe(0);
  });
  it('real Worker entry tolerates missing event shape and native MessageEvent', async () => {
    const oldMessage = Object.getOwnPropertyDescriptor(globalThis, 'onmessage');
    const post = vi.fn(); vi.stubGlobal('postMessage', post);
    try {
      await import('./referenceAnalysis.worker');
      const callback = (globalThis as unknown as { onmessage: (event: unknown) => void }).onmessage;
      for (const event of [null, undefined, {}, { data: undefined }, { data: null }]) expect(() => callback(event)).not.toThrow();
      expect(post.mock.calls.map(call => call[0])).toEqual(Array(5).fill({ id: 0, error: 'REFERENCE_ANALYSIS_FAILED' }));
      callback(new MessageEvent('message', { data: { id: 99, text: '[Docs](https://example.com/docs)', sources: [source] } }));
      expect(post.mock.lastCall?.[0]).toEqual({ id: 99, references: [{ ...source, number: 1 }] });
    } finally {
      vi.unstubAllGlobals(); if (oldMessage) Object.defineProperty(globalThis, 'onmessage', oldMessage); else Reflect.deleteProperty(globalThis, 'onmessage');
    }
  });
});
