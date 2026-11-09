import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { PDF_DOCUMENT_OPTIONS } from '@/lib/pdfAssets'; // Moon Add
import { displayFileRefPath, type FileRef } from '@/components/ai/lib/filePath';
import { previewLocalFile, previewOfficeDocument, readImageThumbnail } from '@/lib/tauri';
import { extractSessionFiles } from '@/lib/sessionFiles';
import { useFilePreviewTabs, filePreviewScope } from '@/store/filePreviewTabs';

export type ChatContext = { label: string; text: string; image?: { mime: string; base64: string }; note?: string };
export type ContextSource = { label: string; key?: string; load: () => Promise<ChatContext | undefined> };
export const SOURCE_CHANGED_EVENT = 'ugs:temporary-chat-source-changed';
const visibleSources = new Map<symbol, ContextSource>();
export function registerVisibleSource(source: ContextSource): () => void {
  const id = Symbol();
  visibleSources.set(id, source);
  window.dispatchEvent(new Event(SOURCE_CHANGED_EVENT));
  return () => { visibleSources.delete(id); window.dispatchEvent(new Event(SOURCE_CHANGED_EVENT)); };
}
const LIMIT = 60000;
function limited(text: string): { text: string; note?: string } {
  return text.length > LIMIT ? { text: text.slice(0, LIMIT), note: '内容过长，仅引用前 6 万字' } : { text };
}

export function fileSource(ref: FileRef, cwd?: string): ContextSource {
  const path = filePreviewScope(displayFileRefPath(ref, cwd));
  return { label: ref.basename, key: JSON.stringify(['file', path]), load: async () => {
    const file = await previewLocalFile(ref.path, { cwd });
    const prefix = `文件：${file.path}\n`;
    if (file.kind === 'image') {
      const image = await readImageThumbnail(file.path, { maxEdge: 1600 });
      return { label: ref.basename, text: prefix, image: { mime: image.mime, base64: image.base64 } };
    }
    if (file.kind === 'text') return { label: ref.basename, ...limited(prefix + (file.text ?? '')), note: file.truncated ? '文件预览已截断' : limited(prefix + (file.text ?? '')).note };
    if (file.kind === 'document' && file.mime === 'application/pdf' && file.streamPath) {
      const pdfjs = await import('pdfjs-dist');
      const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      const task = pdfjs.getDocument({ url: convertFileSrc(file.streamPath), ...PDF_DOCUMENT_OPTIONS });
      try {
        const doc = await task.promise;
        let text = prefix;
        let extracted = '';
        for (let i = 1; i <= doc.numPages && text.length <= LIMIT; i++) {
          const page = await doc.getPage(i);
          const content = await page.getTextContent();
          const pageText = content.items.map(item => 'str' in item ? item.str : '').join(' ');
          extracted += pageText;
          text += `\n第 ${i} 页\n` + pageText;
        }
        if (!extracted.trim()) throw new Error('PDF 没有可提取的文字；扫描件暂不支持');
        return { label: ref.basename, ...limited(text) };
      } finally { await task.destroy(); }
    }
    if (file.kind === 'office' && file.streamPath) {
      if (/\.docx$/i.test(file.path)) {
        const response = await fetch(convertFileSrc(file.streamPath));
        if (!response.ok) throw new Error('无法读取 Word 文件');
        const mammoth = await import('mammoth/mammoth.browser');
        const result = await mammoth.extractRawText({ arrayBuffer: await response.arrayBuffer() });
        return { label: ref.basename, ...limited(prefix + result.value) };
      }
      const office = await previewOfficeDocument(file.path, { maxPages: 100 });
      const text = office.pages.map(page => new DOMParser().parseFromString(page.html, 'text/html').body.textContent ?? '').join('\n');
      return { label: ref.basename, ...limited(prefix + text), note: office.truncated ? '文件页数过多，仅引用部分页面' : limited(prefix + text).note };
    }
    throw new Error('此文件类型暂不支持引用内容');
  } };
}

export function browserSource(url?: string, browserId?: string): ContextSource {
  return { label: '当前网页', key: url ? JSON.stringify(['browser', browserId, url]) : undefined, load: async () => {
    const page = await invoke<{ url: string; title: string; text: string }>('floating_browser_page_context', browserId ? { browserId } : undefined);
    if (!page.text.trim()) throw new Error('网页没有可读取的正文');
    return { label: page.title || page.url, ...limited(`网页：${page.title}\n地址：${page.url}\n\n${page.text}`) };
  } };
}

export async function currentSource(): Promise<ContextSource | undefined> {
  const visible = Array.from(visibleSources.values()).at(-1);
  if (visible) return visible;
  const { useStore } = await import('@/store/useStore');
  const latestVisible = Array.from(visibleSources.values()).at(-1);
  if (latestVisible) return latestVisible;
  const state = useStore.getState();
  const scope = filePreviewScope(state.composer.workspace);
  const previews = useFilePreviewTabs.getState();
  const tab = previews.tabs.find(item => item.scope === scope && item.id === previews.activeByScope[scope]);
  if (tab) return fileSource(tab.ref, tab.cwd);
  if (!state.activeSessionId) return { label: '随手聊', key: JSON.stringify(['unscoped']), load: async () => undefined };
  const sessionId = state.activeSessionId;
  return { label: '当前会话', key: JSON.stringify(['session', scope, sessionId]), load: async () => {
  const title = state.sessions.find(item => item.id === state.activeSessionId)?.title || '当前会话';
  const messages = state.messages.filter(item => (item.role === 'user' || item.role === 'assistant') && item.text.trim());
  const entries = extractSessionFiles(messages);
  const cwd = state.composer.workspace;
    let text = `会话：${title}\n\n` + messages.map(item => `${item.role === 'user' ? '用户' : '助手'}：${item.text}`).join('\n\n');
    const omitted: string[] = [];
    for (const entry of entries) {
      if (text.length >= LIMIT) { omitted.push(entry.basename); continue; }
      try {
        const file = await previewLocalFile(entry.path, { cwd });
        if (file.kind !== 'text' || file.text == null) { omitted.push(entry.basename); continue; }
        text += `\n\n会话文件：${file.path}\n${file.text}${file.truncated ? '\n（文件已截断）' : ''}`;
      } catch { omitted.push(entry.basename); }
    }
    const result = limited(text);
    return { label: title, ...result, note: [result.note, omitted.length ? `${omitted.length} 个会话文件未能作为文本读取` : ''].filter(Boolean).join('；') || undefined };
  } };
}

export function observeCurrentSource(changed: (source: ContextSource | undefined) => void): () => void {
  let lastKey: string | undefined;
  let stopped = false;
  let revision = 0;
  let stopStore: (() => void) | undefined;
  const check = () => {
    const current = ++revision;
    void currentSource().then(source => {
      if (stopped || current !== revision || source?.key === lastKey) return;
      lastKey = source?.key;
      changed(source);
    });
  };
  window.addEventListener(SOURCE_CHANGED_EVENT, check);
  const stopPreviews = useFilePreviewTabs.subscribe(check);
  void import('@/store/useStore').then(({ useStore }) => {
    if (stopped) return;
    stopStore = useStore.subscribe(check);
    check();
  });
  return () => { stopped = true; window.removeEventListener(SOURCE_CHANGED_EVENT, check); stopStore?.(); stopPreviews(); };
}
