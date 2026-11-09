import { useEffect, useRef, useState } from 'react';
import type { RendererMarkdownResult } from './rendererMarkdown';
import { createRendererMarkdownQueue } from './rendererMarkdownQueue';

interface Revision { text: string; streaming: boolean; result?: RendererMarkdownResult }
/** Initial/replacement/terminal render stays exact; long appends retain last ACK. */
export function useRendererMarkdown(text: string, streaming: boolean) {
  const [committed, setCommitted] = useState<Revision>({ text, streaming });
  const [failed, setFailed] = useState(false);
  const latest = useRef({ text, streaming });
  const previous = useRef({ text, streaming });
  const queue = useRef<ReturnType<typeof createRendererMarkdownQueue>>();
  latest.current = { text, streaming };
  const append = text.startsWith(committed.text);
  const background = streaming && text.length > 4096;
  // Never allow a prior document/streaming repair to leak into a replacement or final.
  const visible = background && append && committed.streaming ? committed : { text, streaming };
  useEffect(() => {
    const replaced = !text.startsWith(previous.current.text) || !previous.current.streaming;
    previous.current = { text, streaming };
    if (!background || replaced) {
      queue.current?.dispose(); queue.current = undefined;
      setFailed(false);
      setCommitted({ text, streaming });
      return;
    }
    if (text === committed.text) return;
    if (!queue.current) queue.current = createRendererMarkdownQueue(
      (request, result) => {
        if (latest.current.text === request.text && latest.current.streaming === request.streaming)
          setCommitted({ text: request.text, streaming: request.streaming, result });
      },
      () => setFailed(true),
    );
    queue.current.submit(text, streaming);
  }, [text, streaming, background]);
  useEffect(() => () => { queue.current?.dispose(); }, []);
  return { ...visible, delayed: background && failed && visible.text !== text };
}
