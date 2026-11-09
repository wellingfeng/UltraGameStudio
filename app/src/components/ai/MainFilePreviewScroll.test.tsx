import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { MainFilePreview } from './FilePreviewTabs';
import { useFilePreviewTabs } from '@/store/filePreviewTabs';
import type { LocalFilePreview } from '@/lib/tauri';

vi.mock('@/components/temporaryChat/context', () => ({
  fileSource: (ref: { path: string; basename: string }) => ({ key: ref.path, label: ref.basename, load: async () => undefined }),
  registerVisibleSource: () => () => {},
  observeCurrentSource: () => () => {},
}));

const previewFile = async (path: string): Promise<LocalFilePreview> => ({
  path, fileName: path, kind: 'text', mime: 'text/markdown', text: '# 测试\n\n正文',
  sizeBytes: 20, truncated: false, base64: null,
});
const scope = 'e:/first';
const otherScope = 'e:/second';
let host: HTMLDivElement | undefined;
let root: ReturnType<typeof createRoot> | undefined;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove(); root = undefined; host = undefined;
  useFilePreviewTabs.setState({ tabs: [], activeByScope: {}, browserTabs: [], chatOpenByScope: {} });
});

it('切换工作区及会话后，文件与随手聊保留原有阅读位置', async () => {
  useFilePreviewTabs.getState().open({ scope, ref: { path: 'one.md', basename: 'one.md' }, cwd: 'E:/First', previewFile, diffEnabled: false, canOpenExternally: false });
  useFilePreviewTabs.getState().setPreviewChatOpen(scope, true);
  const firstId = useFilePreviewTabs.getState().activeByScope[scope]!;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<MainFilePreview scope={scope} />));
  const scroll = host.querySelector<HTMLElement>('.ugs-main-file-preview-content .ai-markdown')!.closest<HTMLElement>('.overflow-auto')!;
  const frame = host.querySelector<HTMLIFrameElement>('iframe[title^="文件随手聊"]')!;
  scroll.scrollTop = 320;
  expect(frame).toBeTruthy();

  await act(async () => root!.render(<MainFilePreview scope={otherScope} />));
  expect(scroll.isConnected).toBe(true);
  expect(frame.isConnected).toBe(true);
  expect(scroll.closest('.ugs-main-file-preview-content')?.hasAttribute('hidden')).toBe(true);

  await act(async () => {
    useFilePreviewTabs.getState().open({ scope: otherScope, ref: { path: 'two.md', basename: 'two.md' }, cwd: 'E:/Second', previewFile, diffEnabled: false, canOpenExternally: false });
  });
  await act(async () => root!.render(<MainFilePreview scope={scope} />));
  expect(host.querySelector('.ugs-main-file-preview-content:not([hidden]) .ai-markdown')?.closest('.overflow-auto')).toBe(scroll);
  expect(scroll.scrollTop).toBe(320);
  expect(host.querySelector('.ugs-main-file-preview-content:not([hidden]) iframe[title^="文件随手聊"]')).toBe(frame);

  await act(async () => useFilePreviewTabs.getState().select(scope, null));
  await act(async () => useFilePreviewTabs.getState().select(scope, firstId));
  expect(scroll.scrollTop).toBe(320);
  expect(host.querySelector('.ugs-main-file-preview-content:not([hidden]) iframe[title^="文件随手聊"]')).toBe(frame);
});
