import { deriveRendererMarkdown } from './rendererMarkdown';
import type { RendererMarkdownRequest } from './rendererMarkdownQueue';

self.onmessage = (event: MessageEvent<RendererMarkdownRequest>) => {
  const { revision, text, streaming } = event.data;
  try {
    self.postMessage({ revision, result: deriveRendererMarkdown(text, streaming) });
  } catch {
    self.postMessage({ revision, error: true });
  }
};
