import type { RendererMarkdownResult } from './rendererMarkdown';

export interface RendererMarkdownRequest { revision: number; text: string; streaming: boolean }
export interface RendererMarkdownReply { revision: number; result?: RendererMarkdownResult; error?: boolean }
export interface RendererMarkdownWorker {
  postMessage: (request: RendererMarkdownRequest) => void;
  terminate: () => void;
  onmessage: ((event: MessageEvent<RendererMarkdownReply>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror?: ((event: MessageEvent) => void) | null;
}
export const createRendererMarkdownWorker = (): RendererMarkdownWorker =>
  new Worker(new URL('./rendererMarkdown.worker.ts', import.meta.url), { type: 'module' });

/** One in flight, one replaceable pending source. Failure is terminal until reset. */
export function createRendererMarkdownQueue(
  commit: (request: RendererMarkdownRequest, result: RendererMarkdownResult) => void,
  fail: () => void,
  factory = createRendererMarkdownWorker,
  timeoutMs = 10_000,
) {
  let worker: RendererMarkdownWorker | undefined;
  let active: RendererMarkdownRequest | undefined;
  let pending: RendererMarkdownRequest | undefined;
  let latest = 0;
  let disposed = false;
  let failed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    clearTimeout(timer);
    if (worker) { worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null; worker.terminate(); }
    worker = undefined; active = undefined; pending = undefined;
  };
  const failure = () => { if (disposed || failed) return; failed = true; stop(); fail(); };
  const dispatch = (request: RendererMarkdownRequest) => {
    try {
      if (!worker) {
        worker = factory();
        worker.onerror = failure;
        worker.onmessageerror = failure;
        worker.onmessage = ({ data }) => {
          if (disposed || failed || !active) return;
          if (!data || !Number.isSafeInteger(data.revision)) { failure(); return; }
          if (data.revision !== active.revision) return;
          clearTimeout(timer);
          const completed = active;
          active = undefined;
          if (data.error || !data.result || typeof data.result.source !== 'string' ||
              data.result.tree?.type !== 'root' || !Array.isArray(data.result.tree.children)) { failure(); return; }
          if (completed.revision === latest) commit(completed, data.result);
          if (pending) { const next = pending; pending = undefined; dispatch(next); }
        };
      }
      active = request;
      timer = setTimeout(failure, timeoutMs);
      worker.postMessage(request);
    } catch { failure(); }
  };
  return {
    submit(text: string, streaming: boolean) {
      if (disposed || failed) return;
      const request = { revision: ++latest, text, streaming };
      if (active) pending = request;
      else dispatch(request);
    },
    dispose() { disposed = true; stop(); },
  };
}
