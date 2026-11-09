import { afterEach, describe, expect, it, vi } from 'vitest';
import { deriveRendererMarkdown } from './rendererMarkdown';
import { createRendererMarkdownQueue, type RendererMarkdownWorker, type RendererMarkdownRequest, type RendererMarkdownReply } from './rendererMarkdownQueue';

class Transport implements RendererMarkdownWorker {
  onmessage: RendererMarkdownWorker['onmessage'] = null;
  onerror: RendererMarkdownWorker['onerror'] = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  requests: RendererMarkdownRequest[] = [];
  terminated = false;
  postMessage(request: RendererMarkdownRequest) { this.requests.push(request); }
  terminate() { this.terminated = true; }
  reply(index: number) {
    const request = this.requests[index];
    this.onmessage?.({ data: { revision: request.revision, result: deriveRendererMarkdown(request.text, request.streaming) } } as MessageEvent<RendererMarkdownReply>);
  }
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('renderer-owned actual parser worker boundary', () => {
  it('executes the actual worker message handler with the actual Markdown pipeline', async () => {
    const postMessage = vi.fn();
    const scope = { onmessage: null as ((event: MessageEvent<RendererMarkdownRequest>) => void) | null, postMessage };
    vi.stubGlobal('self', scope);
    await import('./rendererMarkdown.worker');
    scope.onmessage!({ data: { revision: 7, text: '**bold**\n\n$x+y$\n\n---\n\nlast', streaming: true } } as MessageEvent<RendererMarkdownRequest>);
    expect(postMessage).toHaveBeenCalledTimes(1);
    const reply = postMessage.mock.calls[0][0] as RendererMarkdownReply;
    expect(reply.revision).toBe(7);
    expect(reply.result).toEqual(deriveRendererMarkdown('**bold**\n\n$x+y$\n\n---\n\nlast', true));
    expect(JSON.stringify(reply.result?.tree)).toContain('katex');
  });
  it('coalesces blocked jobs, ignores stale revisions and commits only the latest real tree', () => {
    const transport = new Transport(); const commit = vi.fn(); const fail = vi.fn();
    const queue = createRendererMarkdownQueue(commit, fail, () => transport);
    queue.submit('first', true);
    for (let i = 0; i < 60; i++) queue.submit(`latest ${i}`, true);
    expect(transport.requests).toHaveLength(1);
    transport.onmessage?.({ data: { revision: -1, result: deriveRendererMarkdown('bad', true) } } as MessageEvent<RendererMarkdownReply>);
    expect(transport.requests).toHaveLength(1);
    transport.reply(0);
    expect(commit).not.toHaveBeenCalled();
    expect(transport.requests).toHaveLength(2);
    expect(transport.requests[1].text).toBe('latest 59');
    transport.reply(1);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0][1]).toEqual(deriveRendererMarkdown('latest 59', true));
    queue.dispose();
    expect(transport.terminated).toBe(true);
  });
  it('fails closed on a reply with a missing tree without stranding a pending revision', () => {
    vi.useFakeTimers();
    const transport = new Transport(); const commit = vi.fn(); const fail = vi.fn();
    const queue = createRendererMarkdownQueue(commit, fail, () => transport);
    queue.submit('first', true); queue.submit('pending', true);
    const callback = transport.onmessage!;
    expect(() => callback({ data: { revision: 1, result: {} } } as MessageEvent<RendererMarkdownReply>)).not.toThrow();
    for (let i = 0; i < 60; i++) queue.submit(`later ${i}`, true);
    expect(fail).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
    expect(transport.requests).toHaveLength(1);
    expect(transport.terminated).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    callback({ data: { revision: 1, result: deriveRendererMarkdown('late', true) } } as MessageEvent<RendererMarkdownReply>);
    expect(commit).not.toHaveBeenCalled();
    queue.dispose();
  });
  it('does not deliver a queued callback after disposal', () => {
    const transport = new Transport(); const commit = vi.fn();
    const queue = createRendererMarkdownQueue(commit, vi.fn(), () => transport);
    queue.submit('first', true); queue.submit('pending', true);
    const queued = transport.onmessage!;
    queue.dispose();
    queued({ data: { revision: 1, result: deriveRendererMarkdown('first', true) } } as MessageEvent<RendererMarkdownReply>);
    expect(commit).not.toHaveBeenCalled();
    expect(transport.requests).toHaveLength(1);
    expect(transport.terminated).toBe(true);
  });
  it.each(['factory', 'postMessage', 'error', 'messageerror', 'timeout'])('bounds %s failure and never retries per delta', (kind) => {
    vi.useFakeTimers();
    const transport = new Transport(); const failure = vi.fn(); const factory = vi.fn(() => {
      if (kind === 'factory') throw new Error('unavailable');
      return transport;
    });
    if (kind === 'postMessage') transport.postMessage = () => { throw new Error('closed'); };
    const queue = createRendererMarkdownQueue(vi.fn(), failure, factory, 25);
    queue.submit('first', true);
    if (kind === 'timeout') vi.advanceTimersByTime(25);
    if (kind === 'error') transport.onerror?.(new ErrorEvent('error'));
    if (kind === 'messageerror') transport.onmessageerror?.(new MessageEvent('messageerror'));
    for (let i = 0; i < 60; i++) queue.submit(`latest ${i}`, true);
    expect(failure).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledTimes(1);
    if (kind !== 'factory') expect(transport.terminated).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    queue.dispose();
  });
});
