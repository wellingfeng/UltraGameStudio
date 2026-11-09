import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { deriveRendererMarkdown } from './lib/rendererMarkdown';
import type { RendererMarkdownReply, RendererMarkdownRequest } from './lib/rendererMarkdownQueue';
import MessageReferences from './MessageReferences';
import { FileChipBudgetProvider } from './FileChip';

// Only the browser transport is doubled. Every delivered job runs the real parser.
class ParserWorker {
  static instances: ParserWorker[] = [];
  onmessage: ((event: MessageEvent<RendererMarkdownReply>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  posted: RendererMarkdownRequest[] = [];
  work: number[] = [];
  terminated = false;
  constructor(readonly url: URL, readonly options: WorkerOptions) { ParserWorker.instances.push(this); }
  postMessage(request: RendererMarkdownRequest) { this.posted.push(request); }
  terminate() { this.terminated = true; }
  deliver(index: number) {
    const request = this.posted[index];
    this.work.push(request.text.length);
    const result = deriveRendererMarkdown(request.text, request.streaming);
    this.onmessage?.({ data: { revision: request.revision, result } } as MessageEvent<RendererMarkdownReply>);
  }
}
beforeEach(() => { ParserWorker.instances = []; vi.stubGlobal('Worker', ParserWorker); });
afterEach(() => { vi.unstubAllGlobals(); });
import Markdown from './Markdown';
import MessageContent from './MessageContent';
import { encodeToolPatch } from './lib/toolEvent';

const parsed = vi.hoisted(() => ({ lengths: [] as number[] }));
vi.mock('react-markdown', async (load) => {
  const real = await load<typeof import('react-markdown')>();
  return { ...real, default: (props: Parameters<typeof real.default>[0]) => {
    parsed.lengths.push(props.children?.length ?? 0);
    return real.default(props);
  } };
});

describe('production streaming Markdown', () => {
  it.each(['completed', 'cancelled'])('flushes exact %s bytes immediately and rejects old/replaced/unmounted results', async (mode) => {
    const container = document.createElement('div'); const root = createRoot(container);
    const first = 'old '.repeat(1500);
    const replacement = 'replacement '.repeat(500);
    try {
      await act(async () => root.render(<Markdown text={first} streaming />));
      await act(async () => root.render(<Markdown text={first + ' pending'} streaming />));
      const oldWorker = ParserWorker.instances[0]; const oldCallback = oldWorker.onmessage!;
      await act(async () => root.render(<Markdown text={replacement} streaming />));
      expect(oldWorker.terminated).toBe(true);
      await act(async () => oldCallback({ data: { revision: 1, result: deriveRendererMarkdown(first + ' pending', true) } } as MessageEvent<RendererMarkdownReply>));
      expect(container.textContent).not.toContain('old');
      await act(async () => root.render(<Markdown text={replacement + ' pending'} streaming />));
      const active = ParserWorker.instances[1]; const late = active.onmessage!;
      const final = replacement + ` ${mode} final **bold**`;
      parsed.lengths = [];
      await act(async () => root.render(<Markdown text={final} streaming={false} />));
      expect(container.textContent).toContain(`${mode} final bold`);
      expect(parsed.lengths.filter((length) => length > 4096)).toHaveLength(1);
      const exact = container.innerHTML;
      await act(async () => late({ data: { revision: 1, result: deriveRendererMarkdown(replacement + ' pending', true) } } as MessageEvent<RendererMarkdownReply>));
      expect(container.innerHTML).toBe(exact);
      expect(active.terminated).toBe(true);
      await act(async () => root.unmount());
      await act(async () => late({ data: { revision: 1, result: deriveRendererMarkdown('obsolete', true) } } as MessageEvent<RendererMarkdownReply>));
      expect(container.innerHTML).toBe('');
    } finally { if (container.innerHTML) await act(async () => root.unmount()); }
  });
  it('reports worker unavailability without repeated synchronous parses and never loses final content', async () => {
    vi.stubGlobal('Worker', class { constructor() { throw new Error('unavailable'); } });
    const container = document.createElement('div'); const root = createRoot(container);
    let text = 'initial '.repeat(700);
    try {
      await act(async () => root.render(<Markdown text={text} streaming />));
      parsed.lengths = [];
      for (let i = 0; i < 60; i++) { text += ' delta'; await act(async () => root.render(<Markdown text={text} streaming />)); }
      expect(container.querySelector('[role="status"]')).not.toBeNull();
      expect(Math.max(0, ...parsed.lengths)).toBe(0);
      await act(async () => root.render(<Markdown text={text} streaming={false} />));
      expect(container.querySelector('[role="status"]')).toBeNull();
      expect(container.textContent).toBe(text);
    } finally { await act(async () => root.unmount()); }
  });
  it('replays the same file-chip cap after an actual worker parser ACK and expands it', async () => {
    const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
    const prefix = 'prose '.repeat(800) + Array.from({ length: 14 }, (_, i) => ` src/worker-${i}.ts`).join('');
    const view = (text: string) => <FileChipBudgetProvider><Markdown text={text} streaming onOpenFile={() => {}} /></FileChipBudgetProvider>;
    try {
      await act(async () => root.render(view(prefix)));
      parsed.lengths = [];
      await act(async () => root.render(view(prefix + ' latest')));
      expect(Math.max(0, ...parsed.lengths)).toBe(0);
      expect(container.querySelectorAll('.ai-file-chip:not(.ai-file-chip--folded)')).toHaveLength(12);
      await act(async () => ParserWorker.instances[0].deliver(0));
      expect(container.textContent).toContain('latest');
      expect(container.querySelectorAll('.ai-file-chip:not(.ai-file-chip--folded)')).toHaveLength(12);
      expect(container.querySelector('.ai-file-chip-limit')).not.toBeNull();
      await act(async () => container.querySelector<HTMLButtonElement>('.ai-file-chip-limit')?.click());
      expect(container.querySelectorAll('.ai-file-chip:not(.ai-file-chip--folded)')).toHaveLength(14);
    } finally { await act(async () => root.unmount()); container.remove(); }
  });
  it('keeps citations and safe URL handling on a worker-derived tree', async () => {
    const container = document.createElement('div'); const root = createRoot(container);
    const references = [{ number: 1, title: 'Verified source', url: 'https://example.com', toolCallId: 'renderer-source' }];
    const prefix = 'prose '.repeat(800) + '\n\n[1](https://example.com) [unsafe](javascript:alert%281%29)\n\n$x+y$\n\n---\n\n中文第一行\n中文第二行';
    const view = (text: string, streaming: boolean) => <MessageReferences references={references}><Markdown text={text} streaming={streaming} citations /></MessageReferences>;
    try {
      await act(async () => root.render(view(prefix, true)));
      await act(async () => root.render(view(prefix + ' latest', true)));
      await act(async () => ParserWorker.instances[0].deliver(0));
      expect(container.querySelector('.ai-citation')?.textContent).toBe('[1]');
      expect(container.querySelector('[href^="javascript:"]')).toBeNull();
      expect(container.querySelector('.katex')).not.toBeNull();
      expect(container.querySelector('.ai-para-group')).not.toBeNull();
      expect(container.textContent).toContain('latest');
    } finally { await act(async () => root.unmount()); }
  });
  it.each(['paragraph', 'open fence'])('does not synchronously full-parse a growing 100K %s on 60 appends', async (kind) => {
    const container = document.createElement('div'); const root = createRoot(container);
    let text = (kind === 'open fence' ? '```text\n' : '') + 'word '.repeat(20_100);
    try {
      await act(async () => root.render(<Markdown text={text} streaming />));
      parsed.lengths = [];
      for (let i = 0; i < 60; i++) {
        text += ' delta';
        await act(async () => root.render(<Markdown text={text} streaming />));
      }
      const total = parsed.lengths.reduce((sum, length) => sum + length, 0);
      const max = Math.max(0, ...parsed.lengths);
      console.info('renderer-indivisible-evidence', JSON.stringify({ kind, updates: 60, inputChars: text.length, max, total, calls: parsed.lengths.length }));
      expect(max).toBeLessThanOrEqual(4096);
      expect(total).toBeLessThan(text.length);
      expect(ParserWorker.instances).toHaveLength(1);
      const worker = ParserWorker.instances[0];
      expect(worker.options.type).toBe('module');
      expect(worker.url.pathname).toContain('rendererMarkdown.worker.ts');
      expect(worker.posted).toHaveLength(1);
      const previousHtml = container.innerHTML;
      await act(async () => worker.deliver(0));
      expect(container.innerHTML).toBe(previousHtml);
      expect(worker.posted).toHaveLength(2);
      expect(worker.posted[1].text).toBe(text);
      await act(async () => worker.deliver(1));
      expect(container.textContent).toContain('delta delta delta');
      expect(worker.work).toHaveLength(2);
      console.info('renderer-worker-parser-evidence', JSON.stringify({ kind, updates: 60, inputChars: text.length, workerCalls: worker.work.length, workerTotal: worker.work.reduce((a, b) => a + b, 0), mainParse: parsed.lengths }));
      const expected = document.createElement('div'); const expectedRoot = createRoot(expected);
      await act(async () => root.render(<Markdown text={text} streaming={false} />));
      await act(async () => expectedRoot.render(<Markdown text={text} />));
      expect(container.innerHTML).toBe(expected.innerHTML);
      expect(worker.terminated).toBe(true);
      await act(async () => expectedRoot.unmount());
      expect(container.textContent).toContain('delta delta delta');
    } finally { await act(async () => root.unmount()); }
  }, 60_000);
  it.each([
    ['fence', '```ts\nconst x = 1;\n\nconst y = 2;\n```'],
    ['table', '| a | b |\n| --- | --- |\n| one | two |'],
    ['reference', '[guide][ref]\n\n[ref]: https://example.com'],
    ['HTML', '<details>\n<summary>title</summary>\n\nbody\n</details>'],
    ['math', '$$\nx + y\n$$'],
  ])('unifies completed %s output with a fresh full-document render', async (_, suffix) => {
    const container = document.createElement('div'); const root = createRoot(container);
    const expected = document.createElement('div'); const expectedRoot = createRoot(expected);
    const prefix = 'Completed **paragraph**.\n\n'.repeat(240);
    const text = prefix + suffix;
    try {
      await act(async () => root.render(<Markdown text={prefix + 'tail'} streaming />));
      await act(async () => root.render(<Markdown text={text} streaming />));
      await act(async () => root.render(<Markdown text={text} streaming={false} />));
      await act(async () => expectedRoot.render(<Markdown text={text} streaming={false} />));
      expect(container.innerHTML).toBe(expected.innerHTML);
    } finally { await act(async () => { root.unmount(); expectedRoot.unmount(); }); }
  });
  it('keeps one file-chip budget across memoized sealed paragraphs and the growing tail', async () => {
    const container = document.createElement('div'); const root = createRoot(container);
    const prefix = Array.from({ length: 12 }, (_, i) => `src/first-${i}.ts\n\n`).join('') + 'Completed paragraph.\n\n'.repeat(260);
    const open = () => {};
    try {
      await act(async () => root.render(<MessageContent text={prefix + 'tail'} streaming onOpenFile={open} />));
      await act(async () => root.render(<MessageContent text={prefix + 'tail src/new.ts'} streaming onOpenFile={open} />));
      expect(container.querySelectorAll('.ai-file-chip:not(.ai-file-chip--folded)')).toHaveLength(12);
      expect(container.querySelector('.ai-file-chip-limit')).not.toBeNull();
    } finally { await act(async () => root.unmount()); }
  });
  it('bounds real parser input across repeated deltas to a six-figure answer', async () => {
    const container = document.createElement('div'); const root = createRoot(container);
    let text = 'Completed paragraph with **formatting**.\n\n'.repeat(3200) + 'Live';
    try {
      await act(async () => root.render(<MessageContent text={text} streaming />));
      parsed.lengths = [];
      for (let i = 0; i < 60; i++) {
        text += ' delta';
        await act(async () => root.render(<MessageContent text={text} streaming />));
      }
      const max = Math.max(...parsed.lengths);
      const total = parsed.lengths.reduce((sum, length) => sum + length, 0);
      expect(text.length).toBeGreaterThan(100_000);
      expect(max).toBeLessThan(4096);
      expect(total).toBeLessThan(text.length);
      expect(container.querySelectorAll('p')).toHaveLength(3201);
      console.info('incremental-markdown-evidence', JSON.stringify({ inputChars: text.length, updates: 60, maxParsedChars: max, totalParsedChars: total }));
    } finally { await act(async () => root.unmount()); }
  });
  it('does not re-decode closed source-tool payloads through the real message citation path', async () => {
    const container = document.createElement('div'); const root = createRoot(container);
    const text = encodeToolPatch({ id: 'citation-cache-tool', name: 'web_search', status: 'done', result: '[source](https://example.com)' }) + 'plain answer';
    try {
      await act(async () => root.render(<MessageContent text={text} streaming showActions />));
      const decode = vi.spyOn(JSON, 'parse');
      try {
        await act(async () => root.render(<MessageContent text={text + ' more'} streaming showActions />));
        expect(container.textContent).toContain('plain answer more');
        expect(decode.mock.calls.filter(([input]) => input.includes('citation-cache-tool'))).toHaveLength(0);
      } finally { decode.mockRestore(); }
    } finally { await act(async () => root.unmount()); }
  });
  it('keeps live inline-code repair when search disables chunk memoization', async () => {
    const container = document.createElement('div'); const root = createRoot(container);
    try {
      await act(async () => root.render(<Markdown text="answer `unfinished" streaming
        searchState={{ query: 'answer', messageId: 'repair-search', hitCounter: { current: 0 }, activeMatchId: null }} />));
      expect(container.querySelector('.ai-inline-code')).not.toBeNull();
      expect(container.textContent).not.toContain('`');
    } finally { await act(async () => root.unmount()); }
  });
  it('keeps sealed Markdown memoized through the real message reference provider', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const text = 'Completed **paragraph**.\n\n'.repeat(300) + 'Tail';
    try {
      await act(async () => root.render(<MessageContent text={text} streaming />));
      parsed.lengths = [];
      await act(async () => root.render(<MessageContent text={text + ' delta'} streaming />));
      expect(container.textContent).toContain('Tail delta');
      expect(Math.max(...parsed.lengths)).toBeLessThan(4096);
    } finally { await act(async () => root.unmount()); }
  });
  it('does not reparse completed paragraphs when the long answer tail grows', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const text = Array.from({ length: 180 }, (_, i) => `Paragraph ${i} with **bold** content.\n\n`).join('') + 'Live tail';
    try {
      await act(async () => root.render(<Markdown text={text} streaming />));
      const firstParagraph = container.querySelector('p');
      parsed.lengths = [];
      await act(async () => root.render(<Markdown text={text + ' appended'} streaming />));
      expect(container.textContent).toContain('Live tail appended');
      expect(container.querySelector('p')).toBe(firstParagraph);
      expect(parsed.lengths.length).toBeGreaterThan(0);
      expect(Math.max(...parsed.lengths)).toBeLessThan(4096);
    } finally { await act(async () => root.unmount()); }
  });
});
