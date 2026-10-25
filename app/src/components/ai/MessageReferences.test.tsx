import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import MessageContent from './MessageContent';
import { historyStore, __resetHistorySessionCacheForTests } from '@/store/history/store';
import { withMessageReferences } from '@/lib/messageReferences';

const external = vi.hoisted(() => vi.fn());
vi.mock('@/lib/tauri', async (importOriginal) => ({ ...await importOriginal<typeof import('@/lib/tauri')>(), openExternal: external }));
let container: HTMLDivElement;
let root: Root;
const source = { url: 'https://example.com/docs', title: '接口文档', toolCallId: 'search' };
const props = { text: '接口支持流式输出 [7](https://example.com/docs)。再次引用 [9](https://example.com/docs#api)。', referenceSources: [source] };
describe('reference rendering and history', () => {
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); external.mockClear(); });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
  it('renders one footer, locates its row and opens the original source', async () => {
    await act(async () => root.render(createElement(MessageContent, props)));
    expect(container.querySelectorAll('.ai-references__item')).toHaveLength(1);
    const buttons = container.querySelectorAll<HTMLButtonElement>('.ai-citation');
    expect([...buttons].map((button) => button.textContent)).toEqual(['[1]', '[1]']);
    await act(async () => buttons[0].click());
    expect(document.activeElement).toBe(container.querySelector('.ai-references__item'));
    await act(async () => container.querySelector<HTMLAnchorElement>('.ai-references a')!.click());
    expect(external).toHaveBeenCalledWith(source.url);
  });
  it('keeps citations scoped to their own bubble and ordinary links intact', async () => {
    await act(async () => root.render(createElement('div', {}, createElement(MessageContent, props), createElement(MessageContent, props))));
    const messages = container.querySelectorAll('.ai-message');
    await act(async () => messages[1].querySelector<HTMLButtonElement>('.ai-citation')!.click());
    expect(document.activeElement).toBe(messages[1].querySelector('.ai-references__item'));
    await act(async () => root.render(createElement(MessageContent, { text: '[普通链接](https://example.com/docs)' })));
    expect(container.querySelector('.ai-references')).toBeNull();
    expect(container.querySelector('.ai-citation')).toBeNull();
    expect(container.querySelector('a')?.getAttribute('href')).toBe(source.url);
  });
  it('restores sources after history cache reload with no tool-log dependence', async () => {
    const message = withMessageReferences({ id: 'reply', role: 'assistant', createdAt: 1, ...props });
    const record = await historyStore.createSession({ workspaceId: '__default__', id: 'reference-history', isWorkflow: false, messages: [message] });
    __resetHistorySessionCacheForTests();
    const restored = (await historyStore.getSession(record.workspaceId, record.id))!.messages[0];
    expect(restored.references).toEqual([{ ...source, number: 1 }]);
    await act(async () => root.render(createElement(MessageContent, { text: restored.text, referenceSources: restored.referenceSources })));
    expect(container.querySelector('.ai-references__title')?.textContent).toBe('接口文档');
  });
  it('does not cite user messages or execution reasoning', async () => {
    await act(async () => root.render(createElement(MessageContent, { ...props, collectReferences: false })));
    expect(container.querySelector('.ai-references')).toBeNull();
    await act(async () => root.render(createElement(MessageContent, { ...props, text: '<think>[推理资料](https://example.com/docs)</think>' + props.text })));
    expect(container.querySelector('.ai-reasoning .ai-citation')).toBeNull();
    expect(container.querySelectorAll('.ai-citation')).toHaveLength(2);
  });
  it('keeps a download link clickable when the same URL is also cited', async () => {
    await act(async () => root.render(createElement(MessageContent, { ...props, text: props.text + ' [下载文档](https://example.com/docs)' })));
    expect([...container.querySelectorAll('a')].find((link) => link.textContent?.includes('下载文档'))?.getAttribute('href')).toBe(source.url);
    expect(container.querySelectorAll('.ai-citation')).toHaveLength(2);
  });
});
