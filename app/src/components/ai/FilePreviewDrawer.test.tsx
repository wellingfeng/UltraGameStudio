import { act, createElement, useCallback, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FilePreviewDrawer, { rewriteLocalAssetsInHtml } from './FilePreviewDrawer';
import { ensureLocalAssetScope, openLocalPath, previewLocalFile, workspaceFileDiff } from '@/lib/tauri';
import GeneratedArtifactsCard from './GeneratedArtifactsCard';
import FileChip from './FileChip';
import SmartLink from './SmartLink';
import EditedFilesCard from './EditedFilesCard';
import type { FileRef } from './lib/filePath';

vi.mock('@/lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tauri')>()),
  ensureLocalAssetScope: vi.fn(),
  openLocalPath: vi.fn(),
  fileExists: vi.fn().mockResolvedValue(true),
  readImageThumbnail: vi.fn().mockRejectedValue(new Error('No thumbnail')),
  previewLocalFile: vi.fn(),
  workspaceFileDiff: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) =>
    `http://asset.localhost/${encodeURIComponent(path)}`,
}));

describe('FilePreviewDrawer', () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalCreateObjectUrl: typeof URL.createObjectURL | undefined;
  let originalRevokeObjectUrl: typeof URL.revokeObjectURL | undefined;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    originalCreateObjectUrl = URL.createObjectURL;
    originalRevokeObjectUrl = URL.revokeObjectURL;
    vi.useRealTimers();
    vi.mocked(ensureLocalAssetScope).mockReset();
    vi.mocked(ensureLocalAssetScope).mockResolvedValue(undefined);
    vi.mocked(previewLocalFile).mockReset();
    vi.mocked(workspaceFileDiff).mockReset();
    vi.mocked(workspaceFileDiff).mockResolvedValue(null);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: originalCreateObjectUrl,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: originalRevokeObjectUrl,
    });
  });

  it('resolves Markdown-relative images against the document directory', async () => {
    const documentPath = 'E:\\docs\\article\\note.md';
    const imagePath = 'E:\\docs\\article\\images\\figure one.png';
    vi.mocked(previewLocalFile).mockResolvedValue({
      path: documentPath,
      fileName: 'note.md',
      kind: 'text',
      mime: 'text/markdown',
      sizeBytes: 48,
      truncated: false,
      text: '![示意图](images/figure%20one.png)',
      base64: null,
    });

    await act(async () => {
      root.render(createElement(FilePreviewDrawer, {
        refData: { path: documentPath, basename: 'note.md' },
        onClose: vi.fn(),
      }));
    });

    expect(ensureLocalAssetScope).toHaveBeenCalledWith(imagePath);
    expect(container.querySelector<HTMLImageElement>('.ai-generated-image')?.getAttribute('src'))
      .toBe(`http://asset.localhost/${encodeURIComponent(imagePath)}`);
  });

  it('zooms Markdown content with Ctrl-wheel and opens its image without replacing the document', async () => {
    vi.mocked(previewLocalFile).mockResolvedValue({
      path: 'E:/docs/note.md', fileName: 'note.md', kind: 'text', mime: 'text/markdown',
      sizeBytes: 25, truncated: false, text: '# 文档\n![示意图](figure.png)', base64: null,
    });
    const onClose = vi.fn();
    await act(async () => root.render(createElement(FilePreviewDrawer, {
      refData: { path: 'E:/docs/note.md', basename: 'note.md' }, onClose,
    })));
    const image = container.querySelector<HTMLImageElement>('.ai-generated-image')!;
    const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -100 });
    await act(async () => image.dispatchEvent(wheel));
    expect(wheel.defaultPrevented).toBe(true);
    expect(container.querySelector('output[aria-label="预览缩放比例"]')?.textContent).toBe('122%');
    await act(async () => image.click());
    expect(container.querySelector('[role="dialog"][aria-label="图片查看"]')).not.toBeNull();
    expect(vi.mocked(previewLocalFile)).toHaveBeenCalledTimes(1);
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(container.querySelector('[role="dialog"][aria-label="图片查看"]')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('zooms code on Ctrl-wheel without blocking ordinary scrolling', async () => {
    vi.mocked(previewLocalFile).mockResolvedValue({
      path: 'E:/docs/main.ts', fileName: 'main.ts', kind: 'text', mime: 'text/plain',
      sizeBytes: 10, truncated: false, text: 'const x=1;', base64: null,
    });
    await act(async () => root.render(createElement(FilePreviewDrawer, {
      refData: { path: 'E:/docs/main.ts', basename: 'main.ts' }, onClose: vi.fn(),
    })));
    const scroll = container.querySelector('.ai-file-preview-diff__scroll')!;
    const plain = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100 });
    await act(async () => scroll.dispatchEvent(plain));
    expect(plain.defaultPrevented).toBe(false);
    const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -100 });
    await act(async () => scroll.dispatchEvent(wheel));
    expect(wheel.defaultPrevented).toBe(true);
    expect(container.querySelector('output[aria-label="预览缩放比例"]')?.textContent).toBe('122%');
  });

  it('keeps system open and reveal available when an RDC preview fails', async () => {
    vi.mocked(previewLocalFile).mockRejectedValue(new Error('读取文件信息失败：系统找不到指定的文件。'));
    vi.mocked(openLocalPath).mockResolvedValue(true);
    await act(async () => {
      root.render(createElement(FilePreviewDrawer, {
        refData: { path: 'Saved/capture.rdc', basename: 'capture.rdc' },
        cwd: 'E:\\Game', onClose: vi.fn(),
      }));
    });
    expect(container.textContent).toContain('无法预览');
    const open = container.querySelector<HTMLButtonElement>('[aria-label="用系统默认程序打开"]');
    const reveal = container.querySelector<HTMLButtonElement>('[aria-label="在文件夹中显示"]');
    expect(open).not.toBeNull();
    expect(reveal).not.toBeNull();
    await act(async () => { open!.click(); reveal!.click(); });
    expect(openLocalPath).toHaveBeenCalledWith('E:\\Game\\Saved\\capture.rdc');
    expect(openLocalPath).toHaveBeenCalledWith('E:\\Game\\Saved\\capture.rdc', { reveal: true });
  });

  it('does not offer local system actions for remote images or disabled external access', async () => {
    await act(async () => {
      root.render(createElement(FilePreviewDrawer, {
        refData: { path: 'https://example.com/image.png', basename: 'image.png', previewKind: 'image' },
        onClose: vi.fn(),
      }));
    });
    expect(container.querySelector('[aria-label="用系统默认程序打开"]')).toBeNull();
    vi.mocked(previewLocalFile).mockRejectedValue(new Error('无法读取'));
    await act(async () => {
      root.render(createElement(FilePreviewDrawer, {
        refData: { path: 'capture.rdc', basename: 'capture.rdc' },
        canOpenExternally: false, onClose: vi.fn(),
      }));
    });
    expect(container.querySelector('[aria-label="用系统默认程序打开"]')).toBeNull();
  });

  it('does not mount a full-screen backdrop that blocks the rest of the app', async () => {
    vi.mocked(previewLocalFile).mockReturnValue(new Promise(() => {}));

    await act(async () => {
      root.render(
        createElement(FilePreviewDrawer, {
          refData: { path: 'screen.png', basename: 'screen.png' },
          onClose: vi.fn(),
        }),
      );
    });

    expect(
      container.querySelector('button[aria-label="关闭文件预览"]'),
    ).toBeNull();
    expect(container.querySelector('aside')).not.toBeNull();
  });

  it('keeps a scoped preview inside its host and offers one expand action', async () => {
    vi.mocked(previewLocalFile).mockReturnValue(new Promise(() => {}));
    const scope = document.createElement('main');
    const onClose = vi.fn();

    await act(async () => {
      root.render(createElement(FilePreviewDrawer, {
        refData: { path: 'report.docx', basename: 'report.docx' },
        overlayContainerRef: { current: scope },
        onClose,
      }));
    });

    const overlay = scope.firstElementChild;
    const aside = scope.querySelector<HTMLElement>('aside');
    expect(overlay?.classList.contains('absolute')).toBe(true);
    expect(overlay?.classList.contains('fixed')).toBe(false);
    expect(aside?.style.width).not.toBe('');
    expect(aside?.style.maxWidth).toBe('100%');
    expect(scope.querySelector('button[aria-label="在主区域预览"]')).toBeNull();
    expect(scope.querySelectorAll('button[aria-label="占满区域"]')).toHaveLength(1);

    await act(async () => {
      scope.querySelector<HTMLButtonElement>('button[aria-label="占满区域"]')?.click();
    });
    expect(aside?.classList.contains('left-0')).toBe(true);
    expect(aside?.style.width).toBe('');

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(scope.querySelector('button[aria-label="占满区域"]')).not.toBeNull();
    expect(aside?.style.width).not.toBe('');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('can expand the preview to the app window and restore drawer width', async () => {
    vi.mocked(previewLocalFile).mockResolvedValue({
      path: 'E:\\UltraGameStudio\\src\\main.ts',
      fileName: 'main.ts',
      kind: 'text',
      mime: 'text/typescript',
      sizeBytes: 18,
      truncated: false,
      text: 'console.log(1);\n',
      base64: null,
    });

    await act(async () => {
      root.render(
        createElement(FilePreviewDrawer, {
          refData: { path: 'src/main.ts', basename: 'main.ts' },
          cwd: 'E:\\UltraGameStudio',
          onClose: vi.fn(),
        }),
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    const aside = container.querySelector<HTMLElement>('aside');
    expect(aside?.style.width).not.toBe('');

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="占满窗口"]')?.click();
    });

    expect(container.querySelector('button[aria-label="还原预览宽度"]')).not.toBeNull();
    expect(aside?.style.width).toBe('');

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="还原预览宽度"]')?.click();
    });

    expect(container.querySelector('button[aria-label="占满窗口"]')).not.toBeNull();
    expect(aside?.style.width).not.toBe('');
  });

  it('does not read VCS diff unless explicitly enabled', async () => {
    vi.mocked(previewLocalFile).mockResolvedValue({
      path: 'E:\\UltraGameStudio\\src\\main.ts',
      fileName: 'main.ts',
      kind: 'text',
      mime: 'text/typescript',
      sizeBytes: 18,
      truncated: false,
      text: 'console.log(1);\n',
      base64: null,
    });

    await act(async () => {
      root.render(
        createElement(FilePreviewDrawer, {
          refData: { path: 'src/main.ts', basename: 'main.ts' },
          cwd: 'E:\\UltraGameStudio',
          onClose: vi.fn(),
        }),
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(workspaceFileDiff).not.toHaveBeenCalled();
  });

  it('renders custom content without reading a local file', async () => {
    await act(async () => {
      root.render(
        createElement(FilePreviewDrawer, {
          refData: null,
          customContent: {
            label: '团队详情',
            path: '游戏团队 / 技术总监',
            meta: '团队属性与 Skill',
            children: createElement('div', {}, '技术总监 Skill'),
          },
          onClose: vi.fn(),
        }),
      );
    });

    expect(previewLocalFile).not.toHaveBeenCalled();
    expect(container.textContent).toContain('团队详情');
    expect(container.textContent).toContain('游戏团队 / 技术总监');
    expect(container.textContent).toContain('技术总监 Skill');
  });

  it('renders embedded mode without a fixed overlay or resize chrome', async () => {
    await act(async () => {
      root.render(
        createElement(FilePreviewDrawer, {
          refData: null,
          customContent: {
            label: '团队详情',
            path: '游戏团队 / 技术总监',
            children: createElement('div', {}, '技术总监 Skill'),
          },
          variant: 'embedded',
          onClose: vi.fn(),
        }),
      );
    });

    expect(container.querySelector('.fixed.inset-0')).toBeNull();
    expect(container.querySelector('aside')).toBeNull();
    expect(container.querySelector('[aria-label="占满窗口"]')).toBeNull();
    expect(container.querySelector('[aria-label="拖动调整预览宽度"]')).toBeNull();
    expect(container.textContent).toContain('团队详情');
  });

  it('closes embedded mode when the user clicks outside the preview', async () => {
    const onClose = vi.fn();

    await act(async () => {
      root.render(
        createElement(FilePreviewDrawer, {
          refData: null,
          customContent: {
            label: '团队详情',
            path: '游戏团队 / 技术总监',
            children: createElement('div', {}, '技术总监 Skill'),
          },
          variant: 'embedded',
          onClose,
        }),
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await act(async () => {
      container.firstElementChild?.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true }),
      );
    });
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      document.body.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true }),
      );
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes when the user clicks outside the preview drawer', async () => {
    vi.mocked(previewLocalFile).mockReturnValue(new Promise(() => {}));
    const onClose = vi.fn();

    await act(async () => {
      root.render(
        createElement(FilePreviewDrawer, {
          refData: { path: 'screen.png', basename: 'screen.png' },
          onClose,
        }),
      );
    });
    // Let the deferred listener registration run.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const aside = container.querySelector<HTMLElement>('aside');
    await act(async () => {
      aside?.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it.each(['overlay', 'embedded'] as const)(
    '%s switches directly between preview entries without closing on pointerdown',
    async (variant) => {
      const first = { path: 'report.md', basename: 'report.md' };
      const second = { path: 'result.svg', basename: 'result.svg' };
      const onClose = vi.fn();
      vi.mocked(previewLocalFile).mockImplementation(async (path) => ({
        path,
        fileName: path,
        kind: 'text',
        mime: 'text/plain',
        sizeBytes: 16,
        truncated: false,
        text: `Preview: ${path}`,
        base64: null,
      }));

      function PreviewEntries() {
        const [refData, setRefData] = useState<FileRef | null>(first);
        const close = useCallback(() => {
          onClose();
          setRefData(null);
        }, []);
        return createElement('div', {},
          createElement(GeneratedArtifactsCard, {
            artifacts: [{ ref: first, label: 'Report' }, { ref: second, label: 'Image' }],
            onOpenFile: setRefData,
          }),
          createElement(FileChip, { refData: first, onOpenFile: setRefData }),
          createElement(FileChip, { refData: second, onOpenFile: setRefData, thumbnailOnly: true }),
          createElement(SmartLink, {
            href: 'https://example.com/remote.png', children: 'Remote image', onOpenFile: setRefData,
          }),
          createElement(EditedFilesCard, {
            changes: { source: 'agent', files: [{ path: 'source.ts', status: 'modified', added: 1, deleted: 0 }] },
            locale: 'zh-CN', onOpenFile: setRefData,
          }),
          refData && createElement(FilePreviewDrawer, { refData, variant, onClose: close }),
        );
      }

      await act(async () => root.render(createElement(PreviewEntries)));
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

      for (const [selector, expectedLabel] of [
        ['button[aria-label="打开生成物：result.svg"] span span', second.basename],
        ['.ai-file-chip__label', first.basename],
        ['.ai-file-chip-thumb', second.basename],
        ['button[title="在右侧预览"]', 'Remote image'],
        ['[data-ugs-edited-files] button[title="source.ts"] span', 'source.ts'],
      ]) {
        const target = container.querySelector<HTMLElement>(selector);
        expect(target, selector).not.toBeNull();
        await act(async () => {
          target!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
        });
        expect(onClose, `Pointerdown on ${selector} must preserve the preview`).not.toHaveBeenCalled();
        await act(async () => target!.click());
        expect(container.querySelector('header')?.textContent).toContain(expectedLabel);
      }

      await act(async () => document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
      expect(onClose).toHaveBeenCalledOnce();
      expect(container.querySelector('header')).toBeNull();
    },
  );

  it('renders image previews through a blob URL instead of a large data URL', async () => {
    vi.useFakeTimers();
    const createObjectUrl = vi.fn(() => 'blob:preview-image');
    const revokeObjectUrl = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: createObjectUrl,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: revokeObjectUrl,
    });
    vi.mocked(previewLocalFile).mockResolvedValue({
      path: 'E:\\UltraGameStudio\\.ultragamestudio\\clipboard-images\\screen.png',
      fileName: 'screen.png',
      kind: 'image',
      mime: 'image/png',
      sizeBytes: 3,
      truncated: false,
      text: null,
      base64: btoa('png'),
    });

    await act(async () => {
      root.render(
        createElement(FilePreviewDrawer, {
          refData: { path: 'screen.png', basename: 'screen.png' },
          onClose: vi.fn(),
        }),
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      vi.runOnlyPendingTimers();
    });

    const img = container.querySelector<HTMLImageElement>('img');
    expect(createObjectUrl).toHaveBeenCalledOnce();
    expect(img?.getAttribute('src')).toBe('blob:preview-image');
    expect(img?.getAttribute('src')).not.toMatch(/^data:/);

    await act(async () => {
      root.render(
        createElement(FilePreviewDrawer, {
          refData: null,
          onClose: vi.fn(),
        }),
      );
    });
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:preview-image');
  });

  it('renders video previews through the asset protocol', async () => {
    vi.mocked(previewLocalFile).mockResolvedValue({
      path: 'E:\\UltraGameStudio\\clip.mp4',
      fileName: 'clip.mp4',
      kind: 'video',
      mime: 'video/mp4',
      sizeBytes: 1024,
      truncated: false,
      text: null,
      base64: null,
    });

    await act(async () => {
      root.render(
        createElement(FilePreviewDrawer, {
          refData: { path: 'clip.mp4', basename: 'clip.mp4' },
          onClose: vi.fn(),
        }),
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    const video = container.querySelector<HTMLVideoElement>('video');
    expect(video).not.toBeNull();
    expect(video?.getAttribute('src')).toContain('asset.localhost');
    expect(video?.getAttribute('src')).toContain('clip.mp4');
  });

  it('renders HTTP images directly without sending the URL to the local file backend', async () => {
    const url = 'https://cdn.example.com/previews/shot.png?token=1';

    await act(async () => {
      root.render(
        createElement(FilePreviewDrawer, {
          refData: { path: url, basename: '远程图片', previewKind: 'image' },
          onClose: vi.fn(),
        }),
      );
    });

    const image = container.querySelector<HTMLImageElement>('.ai-file-preview-image');
    expect(image?.getAttribute('src')).toBe(url);
    expect(container.textContent).toContain(url);
    expect(container.textContent).not.toContain('UltraGameStudio\\https');
    expect(previewLocalFile).not.toHaveBeenCalled();
  });

  it('shows diff failures instead of silently displaying unmarked source', async () => {
    vi.mocked(previewLocalFile).mockResolvedValue({
      path: 'E:/Game/main.cpp', fileName: 'main.cpp', kind: 'text', mime: 'text/plain',
      sizeBytes: 8, truncated: false, text: 'int x;\n', base64: null,
    });
    vi.mocked(workspaceFileDiff).mockRejectedValueOnce(new Error('P4 工作区映射检查失败'));
    await act(async () => {
      root.render(createElement(FilePreviewDrawer, {
        refData: { path: 'main.cpp', basename: 'main.cpp' }, cwd: 'E:/Game',
        diffEnabled: true, onClose: vi.fn(),
      }));
    });
    expect(container.querySelector('[role="status"]')?.textContent)
      .toContain('差异读取失败：P4 工作区映射检查失败');
  });

  it('renders VCS diff marks for text previews', async () => {
    vi.mocked(previewLocalFile).mockResolvedValue({
      path: 'E:\\UltraGameStudio\\src\\main.ts',
      fileName: 'main.ts',
      kind: 'text',
      mime: 'text/typescript',
      sizeBytes: 32,
      truncated: false,
      text: 'const oldValue = 1;\nconst nextValue = 2;\n',
      base64: null,
    });
    vi.mocked(workspaceFileDiff).mockResolvedValue({
      path: 'src/main.ts',
      oldPath: null,
      status: 'modified',
      binary: false,
      truncated: false,
      lines: [
        {
          kind: 'replacedDeleted',
          oldLine: 2,
          newLine: null,
          content: 'const oldValue = 2;',
        },
        {
          kind: 'replacedAdded',
          oldLine: null,
          newLine: 2,
          content: 'const nextValue = 2;',
        },
      ],
    });

    await act(async () => {
      root.render(
        createElement(FilePreviewDrawer, {
          refData: { path: 'src/main.ts', basename: 'main.ts' },
          cwd: 'E:\\UltraGameStudio',
          diffEnabled: true,
          onClose: vi.fn(),
        }),
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(workspaceFileDiff).toHaveBeenCalledWith('E:\\UltraGameStudio', 'src/main.ts');
    expect(
      container.querySelector('[data-vcs-kind="replacedAdded"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-vcs-kind="replacedDeleted"]'),
    ).not.toBeNull();
    expect(container.querySelector('.ai-file-preview-diff__minimap')).not.toBeNull();
    expect(container.textContent).toContain('相对版本库 · +1 / -1');
  });
});

describe('rewriteLocalAssetsInHtml', () => {
  it('converts Windows absolute paths inside src/srcset/href to asset URLs', () => {
    const html =
      '<img src="E:\\UltraGameStudio\\.ultragamestudio\\clipboard-images\\pasted-1.png">' +
      '<source srcset="E:/x/a.png 1x, E:/x/a@2x.png 2x">' +
      '<a href="E:\\x\\doc.pdf">link</a>';
    const out = rewriteLocalAssetsInHtml(html, '');
    expect(out).toContain(
      `http://asset.localhost/${encodeURIComponent(
        'E:\\UltraGameStudio\\.ultragamestudio\\clipboard-images\\pasted-1.png',
      )}`,
    );
    expect(out).toContain(
      `http://asset.localhost/${encodeURIComponent('E:/x/a.png')} 1x`,
    );
    expect(out).toContain(
      `http://asset.localhost/${encodeURIComponent('E:/x/a@2x.png')} 2x`,
    );
    expect(out).toContain(
      `http://asset.localhost/${encodeURIComponent('E:\\x\\doc.pdf')}`,
    );
  });

  it('resolves relative paths against baseDir', () => {
    const out = rewriteLocalAssetsInHtml(
      '<img src="./img/pic.png">',
      'E:\\site',
    );
    expect(out).toContain(
      `http://asset.localhost/${encodeURIComponent('E:\\site\\img\\pic.png')}`,
    );
  });

  it('leaves network/data URLs untouched', () => {
    const html =
      '<img src="https://cdn/x.png"><img src="data:image/png;base64,AAAA">';
    expect(rewriteLocalAssetsInHtml(html, '')).toBe(html);
  });

  it('rewrites CSS url() values', () => {
    const out = rewriteLocalAssetsInHtml(
      '<style>.a{background:url(E:\\x\\bg.png)}</style>',
      '',
    );
    expect(out).toContain(
      `url("http://asset.localhost/${encodeURIComponent('E:\\x\\bg.png')}")`,
    );
  });

  it('does not mistake a drive letter for a scheme', () => {
    const out = rewriteLocalAssetsInHtml('<img src="E:\\a\\b.png">', '');
    expect(out).not.toContain('src="E:\\a\\b.png"');
    expect(out).toContain('asset.localhost');
  });
});

