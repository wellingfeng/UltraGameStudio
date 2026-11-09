import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import MessageContent from './MessageContent';
import { encodeToolPatch } from './lib/toolEvent';
import { collectMessageReferences, type ReferenceSource } from '@/lib/messageReferences';
import { analyzeReferenceRequest } from './lib/referenceAnalysis';
import { MAX_REFERENCE_ANALYSIS_CHARS, REFERENCE_ANALYSIS_TIMEOUT_MS } from './lib/referenceProjection';
import type { RendererMarkdownRequest } from './lib/rendererMarkdownQueue';

const work = vi.hoisted(() => ({ worker: false, main: [] as number[], background: [] as number[], milliseconds: 0, mainMs: 0, backgroundMs: 0 }));
vi.mock('@/lib/messageReferences', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/messageReferences')>();
  return { ...actual, collectMessageReferences: (...args: Parameters<typeof actual.collectMessageReferences>) => {
    (work.worker ? work.background : work.main).push(args[0].length);
    const start = performance.now();
    try { return actual.collectMessageReferences(...args); }
    finally {
      const elapsed = performance.now() - start;
      work.milliseconds += elapsed;
      if (work.worker) work.backgroundMs += elapsed; else work.mainMs += elapsed;
    }
  } };
});

const source = { url: 'https://example.com/docs', title: 'Verified docs', toolCallId: 'web' };
type Request = { id: number; text: string; sources: ReferenceSource[] };
// Only the asynchronous transport is doubled. Every response runs the actual
// reference collector, including remark-parse, segmentation and evidence gates.
class BoundaryWorker {
  static instances: BoundaryWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  sent: Request[] = [];
  terminated = false;
  constructor() { BoundaryWorker.instances.push(this); }
  postMessage(request: Request) { this.sent.push(request); }
  terminate() { this.terminated = true; }
  complete(index = this.sent.length - 1, callback = this.onmessage) {
    const request = this.sent[index];
    work.worker = true;
    let response;
    try { response = analyzeReferenceRequest(request); }
    finally { work.worker = false; }
    callback?.({ data: response } as MessageEvent);
  }
}

// Keep independent worker protocols separate. The renderer's real parser and
// ACK semantics are exercised by Markdown.incremental.test.tsx; this transport
// deliberately holds its work while the reference collector is under test.
class RendererTransport {
  static instances: RendererTransport[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: RendererMarkdownRequest[] = [];
  constructor() { RendererTransport.instances.push(this); }
  postMessage(request: RendererMarkdownRequest) { this.sent.push(request); }
  terminate() {}
}
class RoutedWorker {
  constructor(url: URL) {
    if (url.pathname.endsWith('/referenceAnalysis.worker.ts')) return new BoundaryWorker();
    if (url.pathname.endsWith('/rendererMarkdown.worker.ts')) return new RendererTransport();
    throw new Error(`Unexpected worker entry: ${url.pathname}`);
  }
}

let container: HTMLDivElement;
let root: Root;
const publish = async (text: string, referenceSources: ReferenceSource[] | undefined, streaming = true, collectReferences = true) => {
  await act(async () => root.render(createElement(MessageContent, { text, referenceSources, streaming, collectReferences })));
};

beforeEach(() => {
  work.main = []; work.background = []; work.milliseconds = 0; work.mainMs = 0; work.backgroundMs = 0;
  BoundaryWorker.instances = [];
  RendererTransport.instances = [];
  vi.stubGlobal('Worker', RoutedWorker);
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('real MessageContent streaming reference workload', () => {
  it.each(['external', 'web-tool'] as const)('%s moves full reference parsing off publication and coalesces to latest', async (kind) => {
    const prefix = kind === 'web-tool' ? encodeToolPatch({ id: 'web', name: 'web_search', status: 'done',
      provenance: 'native-tool', evidenceStatus: 'success', result: JSON.stringify({ url: source.url, title: source.title }) }) : '';
    const sources = kind === 'external' ? [source] : undefined;
    let text = prefix + 'Long answer prose without links. '.repeat(3500).slice(0, 105000);
    await publish(text, sources);
    for (let i = 0; i < 60; i++) { text += ' delta'; await publish(text, sources); }
    console.info('REFERENCE_WORKLOAD', JSON.stringify({ kind, mainCalls: work.main.length,
      mainChars: work.main.reduce((sum, n) => sum + n, 0), maxMainChars: Math.max(0, ...work.main), collectorMs: work.milliseconds }));
    expect(work.main, 'stream publication must not synchronously collect the whole answer').toEqual([]);
    const worker = BoundaryWorker.instances[0];
    expect(BoundaryWorker.instances).toHaveLength(1);
    expect(RendererTransport.instances).toHaveLength(1);
    expect(worker.sent).toHaveLength(1);
    expect(worker.sent[0].sources).toEqual([source]);
    await act(async () => worker.complete(0));
    expect(worker.sent).toHaveLength(2);
    expect(worker.sent[1].text).toBe(text);
    await act(async () => worker.complete(1));
    expect(work.background).toHaveLength(2);
    text += '\n\n[资料][api]\n\n[api]: https://example.com/docs';
    await publish(text, sources, false);
    expect(work.main).toEqual([text.length]);
    expect(container.querySelectorAll('.ai-references__item')).toHaveLength(1);
    expect(container.querySelector('.ai-citation')?.textContent).toBe('[1]');
    expect(worker.terminated).toBe(true);
    await publish(text, sources?.map((s) => ({ ...s })), false);
    expect(work.main).toHaveLength(1);
    console.info('REFERENCE_FINAL_WORKLOAD', JSON.stringify({ kind, mainCalls: work.main.length,
      mainChars: work.main.reduce((sum, n) => sum + n, 0), workerCalls: work.background.length,
      workerChars: work.background.reduce((sum, n) => sum + n, 0), collectorMs: work.milliseconds,
      finalMainCollectorMs: work.mainMs, backgroundCollectorMs: work.backgroundMs }));
  }, 60_000);

  it('shows actual streaming citations and invalidates stable-identity source edits, replacement and revocation', async () => {
    const sources = [{ ...source }];
    const text = '[Docs](https://example.com/docs)';
    await publish(text, sources);
    const first = BoundaryWorker.instances[0];
    await act(async () => first.complete());
    expect(container.querySelector('.ai-citation')?.textContent).toBe('[1]');
    expect(container.querySelector('.ai-references__title')?.textContent).toBe(source.title);
    const oldCallback = first.onmessage;
    sources[0].title = 'Amended evidence';
    await publish(text + ' appended', sources);
    expect(first.terminated).toBe(true);
    expect(container.querySelector('.ai-references')).toBeNull();
    await act(async () => first.complete(0, oldCallback));
    expect(container.querySelector('.ai-references')).toBeNull();
    const second = BoundaryWorker.instances[1];
    await act(async () => second.complete());
    expect(container.querySelector('.ai-references__title')?.textContent).toBe('Amended evidence');
    await publish('Replacement without a citation.', sources);
    expect(container.querySelector('.ai-references')).toBeNull();
    // Already-queued callbacks from the old text cannot refill a replacement.
    await act(async () => second.complete(0));
    expect(container.querySelector('.ai-references')).toBeNull();
    await act(async () => second.complete(1));
    await publish(text, sources);
    const lateCallback = second.onmessage;
    await publish(text, []);
    expect(second.terminated).toBe(true);
    await act(async () => second.complete(2, lateCallback));
    expect(container.querySelector('.ai-references')).toBeNull();
    expect(work.main).toEqual([]);
  });

  it('worker failure removes previously accepted streaming citations without parsing on the UI thread', async () => {
    const text = '[Docs](https://example.com/docs)';
    await publish(text, [source]);
    const worker = BoundaryWorker.instances[0];
    await act(async () => worker.complete());
    expect(container.querySelector('.ai-citation')).not.toBeNull();
    await publish(text + ' append', [source]);
    await act(async () => worker.onerror?.());
    expect(container.querySelector('.ai-references')).toBeNull();
    expect(work.main).toEqual([]);
  });

  it('disposes an unmounted bubble even when a worker callback was already queued', async () => {
    await publish('[Docs](https://example.com/docs)', [source]);
    const worker = BoundaryWorker.instances[0];
    const callback = worker.onmessage;
    await act(async () => root.unmount());
    await act(async () => worker.complete(0, callback));
    expect(worker.terminated).toBe(true);
    expect(container.textContent).toBe('');
    // afterEach still owns a valid root.
    root = createRoot(container);
  });

  it.each(['missing', 'constructor', 'error', 'messageerror', 'timeout', 'oversize'] as const)('%s has no synchronous streaming fallback; final is exact', async (failure) => {
    vi.useFakeTimers();
    if (failure === 'missing') vi.stubGlobal('Worker', undefined);
    if (failure === 'constructor') vi.stubGlobal('Worker', class { constructor() { throw new Error('Unavailable'); } });
    let text = '[Docs](https://example.com/docs)';
    if (failure === 'oversize') text += 'x'.repeat(MAX_REFERENCE_ANALYSIS_CHARS);
    await publish(text, [source]);
    const worker = BoundaryWorker.instances[0];
    const lateCallback = worker?.onmessage;
    if (failure === 'error') await act(async () => worker.onerror?.());
    if (failure === 'messageerror') await act(async () => worker.onmessageerror?.());
    if (failure === 'timeout') await act(async () => vi.advanceTimersByTime(REFERENCE_ANALYSIS_TIMEOUT_MS));
    await publish(text + ' delta', [source]);
    expect(work.main).toEqual([]);
    if (worker) expect(worker.terminated).toBe(true);
    if (worker?.sent.length) await act(async () => worker.complete(0, lateCallback));
    expect(container.querySelector('.ai-references')).toBeNull();
    // The oversized streaming document is deliberately not rendered again at
    // final: this guard concerns projection limits, not a browser memory test.
    await publish('[Docs](https://example.com/docs)', [source], false);
    expect(work.main).toEqual(['[Docs](https://example.com/docs)'.length]);
    expect(container.querySelector('.ai-citation')?.textContent).toBe('[1]');
  }, 30_000);

  it('final preserves first use, definitions, code/reasoning and download/media exclusions after a pending stream', async () => {
    const other = { ...source, url: 'https://example.com/other', title: 'Other' };
    const media = { ...source, url: 'https://example.com/image.png' };
    const sources = [source, other, media];
    const text = '<think>[Hidden](https://example.com/other)</think>' +
      '[Other][ref] [Docs](https://example.com/docs#api) [下载](https://example.com/docs) ' +
      '[Media](https://example.com/image.png) `[Code](https://example.com/docs)`\n\n' +
      '```md\n[Code](https://example.com/docs)\n```\n\n[ref]: https://example.com/other';
    await publish(text, sources);
    const worker = BoundaryWorker.instances[0];
    const callback = worker.onmessage;
    await publish(text, sources, false);
    expect(work.main).toEqual([text.length]);
    expect([...container.querySelectorAll('.ai-citation')].map((node) => node.textContent)).toEqual(['[1]', '[2]']);
    expect([...container.querySelectorAll('.ai-references__title')].map((node) => node.textContent)).toEqual(['Other', source.title]);
    expect(collectMessageReferences(text, sources)).toEqual([{ ...other, number: 1 }, { ...source, number: 2 }]);
    await act(async () => worker.complete(0, callback));
    expect([...container.querySelectorAll('.ai-citation')].map((node) => node.textContent)).toEqual(['[1]', '[2]']);
  });
});
