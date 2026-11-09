import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import MessageContent from './MessageContent';
import { useMessageReferences } from './lib/useMessageReferences';
import type { ReferenceSource } from '@/lib/messageReferences';
const source = { url: 'https://example.com/docs', title: 'Docs', toolCallId: 'fixture' };
class Transport {
  static refs: Transport[] = []; onmessage: ((event: MessageEvent) => void) | null = null;
  onerror = null; onmessageerror = null; sent: unknown[] = []; terminated = false;
  constructor(url: URL) { if (url.pathname.endsWith('/referenceAnalysis.worker.ts')) Transport.refs.push(this); }
  postMessage(request: unknown) { this.sent.push(request); } terminate() { this.terminated = true; }
}
let root: Root; let container: HTMLDivElement;
beforeEach(() => { Transport.refs = []; vi.stubGlobal('Worker', Transport); container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { try { await act(async () => root.unmount()); } finally { container.remove(); vi.unstubAllGlobals(); } });
const publish = (sources: unknown, streaming = true) => act(async () => root.render(createElement(MessageContent, { text: '[Docs](https://example.com/docs)', referenceSources: sources as ReferenceSource[], streaming })));
describe('real UI source admission before merge and key encoding', () => {
  it('rejects a 4 MiB title before constructing a reference Worker', async () => {
    await publish([{ ...source, title: 'x'.repeat(4 * 1024 * 1024) }]);
    expect(Transport.refs).toHaveLength(0);
    expect(container.querySelector('[data-reference-admission="rejected"]')).not.toBeNull();
  });
  it.each(['null', 'object-title', 'cyclic-extra', 'bigint-extra', 'toJSON', 'getter'] as const)('rejects %s before reference Worker construction or post', async (kind) => {
    let calls = 0; const bad: Record<string, unknown> = { ...source };
    if (kind === 'object-title') bad.title = { invalid: true };
    if (kind === 'cyclic-extra') bad.extra = bad;
    if (kind === 'bigint-extra') bad.extra = 1n;
    if (kind === 'toJSON') bad.toJSON = () => { calls++; throw new Error('must not execute'); };
    if (kind === 'getter') Object.defineProperty(bad, 'title', { get() { calls++; throw new Error('must not execute'); } });
    await expect(publish([kind === 'null' ? null : bad])).resolves.toBeUndefined();
    expect(calls).toBe(0); expect(Transport.refs).toHaveLength(0);
    expect(container.querySelector('.ai-references')).toBeNull();
    expect(container.querySelector('[data-reference-admission="rejected"]')).not.toBeNull();
  });
  it('revokes accepted references and queued work on invalid source revision; valid final recovers', async () => {
    await publish([source]); const worker = Transport.refs[0]; const late = worker.onmessage!;
    await act(async () => late({ data: { id: 1, references: [{ ...source, number: 1 }] } } as MessageEvent));
    expect(container.querySelector('.ai-references')).not.toBeNull();
    await publish([{ ...source, title: { invalid: true } }]); expect(worker.terminated).toBe(true);
    await act(async () => late({ data: { id: 1, references: [{ ...source, number: 1 }] } } as MessageEvent));
    expect(container.querySelector('.ai-references')).toBeNull();
    await publish([{ ...source, number: 9 }], false);
    expect(container.querySelector('.ai-citation')?.textContent).toBe('[1]');
  });
  it('hook independently rejects invalid input before JSON without a Worker', async () => {
    vi.stubGlobal('Worker', undefined); let calls = 0;
    const bad = { ...source, toJSON() { calls++; throw new Error('must not execute'); } };
    function Hook() { const references = useMessageReferences('[Docs](https://example.com/docs)', [bad], false, true); return createElement('span', null, references.length); }
    await expect(act(async () => root.render(createElement(Hook)))).resolves.toBeUndefined();
    expect(calls).toBe(0); expect(container.textContent).toBe('0');
  });
});
