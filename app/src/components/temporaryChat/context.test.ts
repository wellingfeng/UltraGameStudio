import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ preview: vi.fn(), thumbnail: vi.fn(), invoke: vi.fn() }));
vi.mock('@/lib/tauri', async (importOriginal) => ({ ...await importOriginal<typeof import('@/lib/tauri')>(), tauriAvailable: () => false, previewLocalFile: mocks.preview, readImageThumbnail: mocks.thumbnail, previewOfficeDocument: vi.fn() }));
vi.mock('@tauri-apps/api/core', async (importOriginal) => ({ ...await importOriginal<typeof import('@tauri-apps/api/core')>(), invoke: mocks.invoke, convertFileSrc: (path: string) => path }));
import { browserSource, currentSource, fileSource, observeCurrentSource, registerVisibleSource } from './context';
import { useStore } from '@/store/useStore';

describe('temporary chat source snapshots', () => {
  beforeEach(() => { vi.clearAllMocks(); useStore.setState({ composer: { ...useStore.getState().composer, workspace: 'E:/Game' }, activeSessionId: null, sessions: [], messages: [] }); });
  it('reads file contents rather than only sharing the path and reports truncation', async () => {
    mocks.preview.mockResolvedValue({ path: 'E:/test.txt', kind: 'text', text: '真实正文', truncated: true });
    const result = await fileSource({ path: 'test.txt', basename: 'test.txt' }, 'E:/').load();
    expect(mocks.preview).toHaveBeenCalledWith('test.txt', { cwd: 'E:/' });
    expect(result).toMatchObject({ text: expect.stringContaining('真实正文'), note: '文件预览已截断' });
  });
  it('sends image bytes and reads the live webpage snapshot', async () => {
    mocks.preview.mockResolvedValue({ path: 'E:/a.png', kind: 'image' });
    mocks.thumbnail.mockResolvedValue({ mime: 'image/jpeg', base64: 'YWJj' });
    expect(await fileSource({ path: 'a.png', basename: 'a.png' }).load()).toMatchObject({ image: { mime: 'image/jpeg', base64: 'YWJj' } });
    mocks.invoke.mockResolvedValue({ title: '当前页面', url: 'https://example.test/', text: '动态正文' });
    expect(await browserSource('https://example.test/', 'browser-2').load()).toMatchObject({ label: '当前页面', text: expect.stringContaining('动态正文') });
    expect(mocks.invoke).toHaveBeenCalledWith('floating_browser_page_context', { browserId: 'browser-2' });
    expect(browserSource('https://example.test/', 'browser-1').key).not.toBe(browserSource('https://example.test/', 'browser-2').key);
  });
  it('chooses the most recently visible source and restores the previous one on close', async () => {
    const a = fileSource({ path: 'a.txt', basename: 'a.txt' });
    const b = browserSource();
    const closeA = registerVisibleSource(a); const closeB = registerVisibleSource(b);
    expect(await currentSource()).toBe(b); closeB(); expect(await currentSource()).toBe(a); closeA();
  });
  it('identifies files, pages and sessions separately and follows changes', async () => {
    const updates = vi.fn();
    useStore.setState({ activeSessionId: 'one' });
    const stop = observeCurrentSource(updates);
    const initial = (await currentSource())?.key;
    await vi.waitFor(() => expect(updates).toHaveBeenCalled());
    useStore.setState({ activeSessionId: 'two' });
    await vi.waitFor(() => expect(updates.mock.lastCall?.[0].key).not.toBe(initial));
    const a = fileSource({ path: 'a.txt', basename: 'a.txt' }, 'E:/Game');
    const same = fileSource({ path: 'E:\\Game\\A.txt', basename: 'A.txt' });
    expect(a.key).toBe(same.key);
    const close = registerVisibleSource(a);
    await vi.waitFor(() => expect(updates.mock.lastCall?.[0].key).toBe(a.key));
    const page = browserSource('https://example.test/');
    const closePage = registerVisibleSource(page);
    await vi.waitFor(() => expect(updates.mock.lastCall?.[0].key).toBe(page.key));
    closePage(); close();
    const current = await currentSource();
    await vi.waitFor(() => expect(updates.mock.lastCall?.[0].key).toBe(current?.key));
    stop();
  });
});
