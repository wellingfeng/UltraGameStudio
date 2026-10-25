import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import FilePreviewDrawer from './FilePreviewDrawer';
import { FilePreviewTabs, MainFilePreview } from './FilePreviewTabs';
import { useFilePreviewTabs } from '@/store/filePreviewTabs';
import { useStore } from '@/store/useStore';
import type { LocalFilePreview } from '@/lib/tauri';

let root: Root;
let host: HTMLDivElement;
const scope = 'e:/game';
const read = vi.fn(async (path: string): Promise<LocalFilePreview> => ({
  path, fileName: path, kind: 'text', mime: 'text/markdown',
  text: `# ${path}\n\n文件内容`, sizeBytes: 32, truncated: false, base64: null,
}));
function Demo() {
  const [ref, setRef] = useState<{ path: string; basename: string } | null>({ path: 'one.md', basename: 'one.md' });
  return <>
    <FilePreviewTabs scope={scope}><button>测试会话</button></FilePreviewTabs>
    <button id="second" onClick={() => setRef({ path: 'two.md', basename: 'two.md' })}>打开第二个文件</button>
    <MainFilePreview scope={scope} />
    <FilePreviewDrawer refData={ref} cwd="E:/Game" previewFile={read} variant="embedded" onClose={() => setRef(null)} />
  </>;
}
beforeEach(async () => {
  read.mockClear();
  useFilePreviewTabs.setState({ tabs: [], activeByScope: {} });
  useStore.setState({ composer: { ...useStore.getState().composer, workspace: 'E:/Game' } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<Demo />));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); useFilePreviewTabs.setState({ tabs: [], activeByScope: {} }); });
async function click(selector: string) { await act(async () => host.querySelector<HTMLButtonElement>(selector)!.click()); }

it('promotes the right preview into a file tab and returns to chat without discarding reader state', async () => {
  await click('[aria-label="在主区域预览"]');
  expect(host.querySelectorAll('[aria-label="在主区域预览"]')).toHaveLength(0);
  const content = host.querySelector('.ugs-main-file-preview-content .ai-markdown')!;
  expect(content.textContent).toContain('one.md');
  await click('[aria-label="会话信息流"]');
  expect(host.querySelector('.ugs-main-file-preview')?.hasAttribute('hidden')).toBe(true);
  await click('[role="tab"][title="E:/Game/one.md"]');
  expect(host.querySelector('.ugs-main-file-preview-content .ai-markdown')).toBe(content);
});

it('keeps multiple files and closes only the active tab on Escape', async () => {
  await click('[aria-label="在主区域预览"]');
  await click('#second');
  await click('[aria-label="在主区域预览"]');
  expect(useFilePreviewTabs.getState().tabs).toHaveLength(2);
  await act(async () => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })));
  expect(useFilePreviewTabs.getState().tabs).toHaveLength(2);
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
  expect(useFilePreviewTabs.getState().tabs.map((tab) => tab.ref.basename)).toEqual(['one.md']);
  expect(useFilePreviewTabs.getState().activeByScope[scope]).toBeNull();
});

it('reuses the same resolved file and preserves another workspace selection', async () => {
  await click('[aria-label="在主区域预览"]');
  const first = useFilePreviewTabs.getState().tabs[0];
  await act(async () => {
    useFilePreviewTabs.getState().open({ ...first, ref: { path: 'E:\\Game\\ONE.md', basename: 'ONE.md' } });
    useFilePreviewTabs.getState().open({ ...first, scope: 'e:/other' });
  });
  expect(useFilePreviewTabs.getState().tabs).toHaveLength(2);
  expect(host.querySelectorAll('.ugs-preview-file-tab')).toHaveLength(1);
  await click('[aria-label="关闭预览：ONE.md"]');
  expect(useFilePreviewTabs.getState().activeByScope['e:/other']).toBeTruthy();
});

it('switches tabs with arrow keys', async () => {
  await click('[aria-label="在主区域预览"]');
  await click('[aria-label="会话信息流"]');
  const chat = host.querySelector<HTMLElement>('[aria-label="会话信息流"]')!;
  chat.focus();
  await act(async () => chat.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
  expect(host.querySelector('.ugs-preview-file-tab [role="tab"]')?.getAttribute('aria-selected')).toBe('true');
});
