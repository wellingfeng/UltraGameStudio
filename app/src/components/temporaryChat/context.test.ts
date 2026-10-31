import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ preview: vi.fn(), thumbnail: vi.fn(), invoke: vi.fn() }));
vi.mock('@/lib/tauri', () => ({ previewLocalFile: mocks.preview, readImageThumbnail: mocks.thumbnail, previewOfficeDocument: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke, convertFileSrc: (path: string) => path }));
import { browserSource, currentSource, fileSource, registerVisibleSource } from './context';

describe('temporary chat source snapshots', () => {
  beforeEach(() => vi.clearAllMocks());
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
    expect(await browserSource().load()).toMatchObject({ label: '当前页面', text: expect.stringContaining('动态正文') });
  });
  it('chooses the most recently visible source and restores the previous one on close', () => {
    const a = fileSource({ path: 'a.txt', basename: 'a.txt' });
    const b = browserSource();
    const closeA = registerVisibleSource(a); const closeB = registerVisibleSource(b);
    expect(currentSource()).toBe(b); closeB(); expect(currentSource()).toBe(a); closeA();
  });
});
