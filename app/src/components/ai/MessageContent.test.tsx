import { beforeEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import MessageContent from './MessageContent';
import { encodeToolPatch } from './lib/toolEvent';
import { MESSAGE_FILE_CHIP_LIMIT } from './lib/fileChipBudget';
import { useStore } from '@/store/useStore';

/**
 * Integration smoke test: render a representative AI message through the real
 * react-markdown + remark-gfm + rehype-highlight pipeline and assert the rich
 * output appears (highlighted code, GFM table, file chip, reasoning block).
 * Guards the load-bearing assumption that the pre/code overrides and language
 * detection work under react-markdown v9.
 */
describe('MessageContent integration', () => {
  beforeEach(() => {
    useStore.setState({ locale: 'zh-CN' });
  });

  const sample = [
    '# Heading',
    '',
    'Some **bold** prose with inline `src/store/useStore.ts:42` reference.',
    '',
    '```ts',
    'const x: number = 1;',
    'console.log(x);',
    '```',
    '',
    '| a | b |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    'A [link](https://example.com).',
  ].join('\n');

  it('preserves Windows clipboard-image paths through markdown so preview works', () => {
    // CommonMark would collapse the `\.ultragamestudio` escape and corrupt the path, leaving
    // the file chip pointing at a non-existent file (so clicking it cannot
    // preview). The protect pass keeps the original separators intact.
    const B = String.fromCharCode(92);
    const winPath = `E:${B}UltraGameStudio${B}.ultragamestudio${B}clipboard-images${B}pasted-1780825313768-e964bfa29a1d4c87-0.png`;
    const html = renderToStaticMarkup(
      createElement(MessageContent, {
        text: `已保存截图 ${winPath} 完成。`,
        streaming: false,
        onOpenFile: () => {},
      }),
    );
    expect(html).toMatch(/ai-file-chip-thumb/);
    // The `.ultragamestudio` separator must survive: no `UltraGameStudio.ultragamestudio` collapse.
    expect(html).not.toMatch(/UltraGameStudio\.ultragamestudio/);
    expect(html).toMatch(/UltraGameStudio\\\.ultragamestudio\\clipboard-images/);
  });

  it('caps rendered local file references in one message', () => {
    const B = String.fromCharCode(92);
    const maxVisibleFileRefs = MESSAGE_FILE_CHIP_LIMIT;
    const paths = Array.from(
      { length: maxVisibleFileRefs + 4 },
      (_, i) =>
        `E:${B}UltraGameStudio${B}.ultragamestudio${B}clipboard-images${B}pasted-${i}.png`,
    ).join('\n');

    const html = renderToStaticMarkup(
      createElement(MessageContent, {
        text: `本地文件：\n${paths}`,
        streaming: false,
        onOpenFile: () => {},
      }),
    );

    expect(html.match(/ai-file-chip-thumb/g)).toHaveLength(maxVisibleFileRefs);
    expect(html.match(/ai-file-chip-limit/g)).toHaveLength(1);
    // 折叠只降级装饰，不降级可点击性：交付物常常正是被折叠的那一批，所以每个
    // 引用都要保留完整路径文本，并渲染成可点击链接而不是被丢掉的死文本。
    for (let i = 0; i < maxVisibleFileRefs + 4; i += 1) {
      // 第 13 个位置让位给"已折叠后续文件引用"按钮，不渲染自己的路径。
      if (i === maxVisibleFileRefs) continue;
      expect(html).toContain(`pasted-${i}.png`);
    }
    expect(html.match(/ai-file-chip--folded/g)).toHaveLength(3);
    expect(html).toMatch(/已折叠后续文件引用|More file references folded/);
  });

  it('keeps backticked file names visible after file chip budget is exhausted', () => {
    const paths = Array.from(
      { length: MESSAGE_FILE_CHIP_LIMIT + 4 },
      (_, i) => `src/generated/file-${i}.ts`,
    ).join('\n');
    const html = renderToStaticMarkup(
      createElement(MessageContent, {
        text: [
          paths,
          '',
          '最终本地只剩这些待提交文件：',
          '- `Cargo.lock`：同步 app 版本到 `0.5.6`',
          '- `lib.rs`',
          '- `i18n.ts`',
          '- `ProjectFileTree.tsx`',
        ].join('\n'),
        streaming: false,
      }),
    );

    expect(html).toMatch(/Cargo\.lock/);
    expect(html).toMatch(/lib\.rs/);
    expect(html).toMatch(/i18n\.ts/);
    expect(html).toMatch(/ProjectFileTree\.tsx/);
    expect(html).toMatch(/ai-inline-code/);
  });

  it('expands folded file references in the message stream', async () => {
    const paths = Array.from(
      { length: MESSAGE_FILE_CHIP_LIMIT + 3 },
      (_, i) => `src/generated/file-${i}.ts`,
    ).join('\n');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          createElement(MessageContent, {
            text: `本地文件：\n${paths}`,
            streaming: false,
            onOpenFile: () => {},
          }),
        );
      });

      const decorated = () =>
        container.querySelectorAll('.ai-file-chip:not(.ai-file-chip--folded)');
      const folded = () => container.querySelectorAll('.ai-file-chip--folded');

      expect(decorated()).toHaveLength(MESSAGE_FILE_CHIP_LIMIT);
      expect(container.querySelector('.ai-file-chip-limit')).not.toBeNull();
      // 折叠项依然可点、文本依然可见，只是省掉了缩略图与存在性探测。
      expect(folded().length).toBeGreaterThan(0);
      expect(container.textContent).toContain(
        `file-${MESSAGE_FILE_CHIP_LIMIT + 2}.ts`,
      );

      await act(async () => {
        container.querySelector<HTMLButtonElement>('.ai-file-chip-limit')?.click();
      });

      expect(container.querySelector('.ai-file-chip-limit')).toBeNull();
      expect(folded()).toHaveLength(0);
      expect(decorated()).toHaveLength(MESSAGE_FILE_CHIP_LIMIT + 3);
      expect(container.textContent).toContain(
        `file-${MESSAGE_FILE_CHIP_LIMIT + 2}.ts`,
      );
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('renders highlighted code, table, and file chip', () => {
    const html = renderToStaticMarkup(
      createElement(MessageContent, { text: sample, streaming: false }),
    );
    expect(html).toMatch(/hljs-/); // syntax highlighting applied
    expect(html).toMatch(/<table/); // GFM table
    expect(html).toMatch(/ai-file-chip/); // inline file reference became a chip
    expect(html).not.toMatch(/ai-file-chip--interactive/); // no preview handler wired
    expect(html).toMatch(/JetBrains|ai-code/); // code block chrome rendered
    expect(html).toMatch(/example\.com/); // external link survived
    expect(html).toMatch(/Heading/);
  });

  it('renders HLSL fences with syntax highlighting', () => {
    const html = renderToStaticMarkup(
      createElement(MessageContent, {
        text: [
          '```hlsl',
          'float Dist = DistanceToNearestSurface(WorldPosition + Normal * Bias);',
          'float Mask = 1 - saturate(Dist / BlendWidth);',
          'float3 Result = lerp(BaseMaterial, BlendMaterial, Mask);',
          '```',
        ].join('\n'),
        streaming: false,
      }),
    );

    expect(html).toMatch(/language-hlsl/);
    expect(html).toMatch(/hljs-type/);
    expect(html).toMatch(/hljs-built_in|hljs-title/);
  });

  it('renders loose diff code as one code block instead of scattered markdown lists', () => {
    const html = renderToStaticMarkup(
      createElement(MessageContent, {
        text: [
          '-        });',
          '-        controller.close();',
          '-      },',
          '+        await waitFor(',
          '+          () => expect(done).toBe(true),',
        ].join('\n'),
        streaming: false,
      }),
    );

    // One code block, recognized as a diff and rendered as a folded code block
    // (no ai-code__folded bar) rather than parsed as markdown lists.
    expect(html.match(/class="ai-code group\/code/g)).toHaveLength(1);
    expect(html).not.toMatch(/ai-code__folded/);
    expect(html).toMatch(/controller\.close/);
    expect(html).not.toMatch(/<ul/);
  });

  it('unwraps markdown wrappers that contain nested fenced code', () => {
    const html = renderToStaticMarkup(
      createElement(MessageContent, {
        text: [
          '```markdown',
          '```ts',
          'const a = 1;',
          '```',
          '',
          '```css',
          '.a { color: red; }',
          '```',
          '```',
        ].join('\n'),
        streaming: false,
      }),
    );

    expect(html.match(/class="ai-code(?: ai-code--tiny)? group\/code/g)).toHaveLength(2);
    expect(html).toMatch(/language-ts/);
    expect(html).toMatch(/language-css/);
  });

  it('renders a reasoning block separately from the answer', () => {
    const html = renderToStaticMarkup(
      createElement(MessageContent, {
        text: '<think>let me plan</think>The final answer.',
        streaming: false,
      }),
    );
    expect(html).toMatch(/ai-reasoning/);
    expect(html).toMatch(/let me plan/);
    expect(html).toMatch(/The final answer/);
  });

  it('does not emit raw html (no rehype-raw)', () => {
    const html = renderToStaticMarkup(
      createElement(MessageContent, {
        text: 'before <img src=x onerror=alert(1)> after',
        streaming: false,
      }),
    );
    // The raw <img> must be escaped/stripped, not rendered as a live element.
    expect(html).not.toMatch(/<img[^>]*onerror/);
  });

  it('renders <details><summary> as a collapsible panel, not raw html', () => {
    const html = renderToStaticMarkup(
      createElement(MessageContent, {
        text:
          '<details><summary>已查到的线索（待 agent 汇总）</summary>\n' +
          '- 第一行线索\n' +
          '- 第二行线索\n' +
          '</details>',
        streaming: false,
      }),
    );
    // 不再显示转义源码。
    expect(html).not.toMatch(/&lt;details/);
    // 折叠面板 + summary 标题 + body 列表都被正常渲染。
    expect(html).toMatch(/<details/);
    expect(html).toMatch(/<summary/);
    expect(html).toMatch(/已查到的线索（待 agent 汇总）/);
    expect(html).toMatch(/<li/);
    expect(html).toMatch(/第一行线索/);
  });

  it('renders generated image markdown with data URLs in the chat stream', () => {
    const html = renderToStaticMarkup(
      createElement(MessageContent, {
        text:
          '✓ 图片生成完成\n\n' +
          '![生成图片 1](data:image/png;base64,iVBORw0KGgo=)',
        streaming: false,
      }),
    );

    expect(html).toMatch(/<img/);
    expect(html).toMatch(/class="ai-generated-image"/);
    expect(html).toMatch(/data:image\/png;base64,iVBORw0KGgo=/);
  });

  it('keeps pasted clipboard image paths as img src (urlTransform must not clear drive-letter src)', () => {
    const html = renderToStaticMarkup(
      createElement(MessageContent, {
        text:
          '![粘贴截图](E:\\UltraGameStudio\\.ultragamestudio\\clipboard-images\\pasted-1792774607400-5eceb5f08a25f101-0.jpg)',
        streaming: false,
      }),
    );
    expect(html).toMatch(/<img/);
    expect(html).toMatch(/class="ai-generated-image"/);
    // 修复前 defaultUrlTransform 把 `E:` 当非法协议清成空串，src 为空。
    expect(html).toMatch(/pasted-1792774607400-5eceb5f08a25f101-0\.jpg/);
    expect(html).not.toMatch(/src=""/);
  });

  it('routes HTTP markdown images to the in-app file preview', async () => {
    const calls: Array<{ path: string; basename: string }> = [];
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          createElement(MessageContent, {
            text: '![远程图片](https://cdn.example.com/previews/shot.png?token=1)',
            streaming: false,
            onOpenFile: (ref) => {
              calls.push(ref);
            },
          }),
        );
      });

      const image = container.querySelector<HTMLImageElement>('.ai-generated-image');
      expect(image).not.toBeNull();
      await act(async () => image!.click());

      expect(calls).toEqual([
        {
          path: 'https://cdn.example.com/previews/shot.png?token=1',
          basename: '远程图片',
          previewKind: 'image',
        },
      ]);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it('routes HTTP image links to the in-app file preview', async () => {
    const calls: Array<{ path: string; basename: string; previewKind?: 'image' }> = [];
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          createElement(MessageContent, {
            text: '[查看图片](https://cdn.example.com/previews/shot.png?token=1)',
            streaming: false,
            onOpenFile: (ref) => {
              calls.push(ref);
            },
          }),
        );
      });

      const trigger = container.querySelector<HTMLButtonElement>('button[title="在右侧预览"]');
      expect(trigger).not.toBeNull();
      await act(async () => trigger!.click());

      expect(calls).toEqual([
        {
          path: 'https://cdn.example.com/previews/shot.png?token=1',
          basename: '查看图片',
          previewKind: 'image',
        },
      ]);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it('renders generated audio markdown with playback controls', () => {
    const html = renderToStaticMarkup(
      createElement(MessageContent, {
        text:
          '✓ 音乐生成完成\n\n' +
          '[播放音频 1](https://example.com/generated.mp3)',
        streaming: false,
      }),
    );

    expect(html).toMatch(/ai-audio-player/);
    expect(html).toMatch(/播放音频 1/);
    expect(html).toMatch(/aria-label="(?:播放|Play)"/);
    expect(html).toMatch(/aria-label="(?:快进 10 秒|Forward 10s)"/);
    expect(html).toMatch(/aria-label="(?:结束|End)"/);
    expect(html).toMatch(/aria-label="(?:播放进度|Playback progress)"/);
  });

  it('renders generated 3D model links as inline viewports', () => {
    const html = renderToStaticMarkup(
      createElement(MessageContent, {
        text:
          '✓ 3D 模型生成完成\n\n' +
          '[预览 3D 模型 1](https://example.com/generated.glb)',
        streaming: false,
      }),
    );

    expect(html).toMatch(/ai-model-viewer/);
    expect(html).toMatch(/3D 模型视口/);
    expect(html).toMatch(/重置视角/);
    expect(html).toMatch(/正在加载模型/);
  });

  it('keeps generated 3D data URLs through markdown sanitization', () => {
    const html = renderToStaticMarkup(
      createElement(MessageContent, {
        text: '[预览 3D 模型 1](data:model/gltf-binary;base64,AAAA)',
        streaming: false,
      }),
    );

    expect(html).toMatch(/ai-model-viewer/);
    expect(html).toMatch(/data:model\/gltf-binary;base64,AAAA/);
  });

  it('renders signed 3D asset URLs as viewports when the label names a model', () => {
    const html = renderToStaticMarkup(
      createElement(MessageContent, {
        text: '[预览 3D 模型 1](https://cdn.example.com/assets/abc123?token=xyz)',
        streaming: false,
      }),
    );

    expect(html).toMatch(/ai-model-viewer/);
    expect(html).toMatch(/abc123\?token=xyz/);
  });

  it('renders ordinary docs links as links when class names contain obj/model fragments', () => {
    const url =
      'https://dev.epicgames.com/documentation/en-us/unreal-engine/python-api/class/SubobjectDataSubsystem';
    const html = renderToStaticMarkup(
      createElement(MessageContent, {
        text: `[${url}](${url})`,
        streaming: false,
      }),
    );

    expect(html).not.toMatch(/ai-model-viewer/);
    expect(html).toMatch(/dev\.epicgames\.com/);
  });

  it('does not render explicit image URLs as 3D viewports just because the label names a model', () => {
    const html = renderToStaticMarkup(
      createElement(MessageContent, {
        text: '[预览 3D 模型 6](https://assets.meshy.ai/tasks/output/preview.png?token=xyz)',
        streaming: false,
      }),
    );

    expect(html).not.toMatch(/ai-model-viewer/);
    expect(html).toMatch(/preview\.png\?token=xyz/);
  });

  it('renders downloaded local 3D model links as viewports', () => {
    const html = renderToStaticMarkup(
      createElement(MessageContent, {
        text: '[预览 3D 模型 1](file:///E:/UltraGameStudio/.ultragamestudio/model-assets/model.glb)',
        streaming: false,
      }),
    );

    expect(html).toMatch(/ai-model-viewer/);
    expect(html).toMatch(/model-assets/);
    expect(html).not.toMatch(/ai-file-chip/);
  });

  it('falls back to a normal link for unsupported remote 3D model formats', () => {
    const html = renderToStaticMarkup(
      createElement(MessageContent, {
        text: '[预览 3D 模型 5](https://assets.example.com/model.usdz)',
        streaming: false,
      }),
    );

    expect(html).not.toMatch(/ai-model-viewer/);
    expect(html).not.toMatch(/当前格式暂不支持内嵌预览/);
    expect(html).toMatch(/https:\/\/assets\.example\.com\/model\.usdz/);
  });

  it('falls back to a file chip for unsupported local 3D model formats', () => {
    const html = renderToStaticMarkup(
      createElement(MessageContent, {
        text: '[预览 3D 模型 5](file:///E:/UltraGameStudio/.ultragamestudio/model-assets/model.zip)',
        streaming: false,
        onOpenFile: () => {},
      }),
    );

    expect(html).not.toMatch(/ai-model-viewer/);
    expect(html).not.toMatch(/当前格式暂不支持内嵌预览/);
    expect(html).toMatch(/ai-file-chip--interactive/);
    expect(html).toMatch(/model-assets/);
  });

  it('renders requested default 3D animation controls in model previews', () => {
    const html = renderToStaticMarkup(
      createElement(MessageContent, {
        text:
          '✓ 3D 模型生成完成\n' +
          '骨骼：已按可绑骨资产请求骨骼绑定和 Idle、Walk、Run 预览动画\n\n' +
          '[预览 3D 模型 1](file:///E:/UltraGameStudio/.ultragamestudio/model-assets/model.glb)',
      }),
    );

    expect(html).toMatch(/aria-label="播放动画 Idle"/);
    expect(html).toMatch(/aria-label="播放动画 Walk"/);
    expect(html).toMatch(/aria-label="播放动画 Run"/);
  });

  it('renders sandbox markdown links with unicode local filenames as file chips', () => {
    const name = 'Moon亮晶分析和渲染整体架构.html';
    const html = renderToStaticMarkup(
      createElement(MessageContent, {
        text: `[${name}](sandbox:/mnt/data/${name})`,
        streaming: false,
        onOpenFile: () => {},
      }),
    );
    expect(html).toMatch(/ai-file-chip/);
    expect(html).toMatch(/ai-file-chip--interactive/);
    expect(html).toMatch(/Moon亮晶分析/);
  });

  it('shows relative file references as full workspace paths when cwd is known', () => {
    const html = renderToStaticMarkup(
      createElement(MessageContent, {
        text: 'Open `src/store/useStore.ts:42`.',
        streaming: false,
        cwd: 'E:\\UltraGameStudio',
        onOpenFile: () => {},
      }),
    );
    expect(html).toMatch(/E:\\UltraGameStudio\\src\\store\\useStore\.ts/);
    expect(html).toMatch(/:42/);
  });

  it('renders backticked Windows capture paths with spaces as interactive file chips', () => {
    const B = String.fromCharCode(92);
    const path = `E:${B}UltraGameStudio${B}.ultragamestudio${B}session-captures${B}session-2026-06-07-1432.png`;
    const html = renderToStaticMarkup(
      createElement(MessageContent, {
        text: `保存到（点击路径可预览）：\n- \`${path}\``,
        streaming: false,
        onOpenFile: () => {},
      }),
    );

    expect(html).toMatch(/ai-file-chip-thumb/);
    expect(html).toMatch(/UltraGameStudio/);
    expect(html).toMatch(/session-captures/);
  });

  it('renders a fenced Windows document path as a clickable file chip', () => {
    // 关键回归：AI 把生成的 Word/PDF/HTML 绝对路径包进一个无语言 fence 时，之前
    // 走 PlainTextBlock 渲染成不可点击的纯文本面板；必须仍是可点击的 FileChip。
    const B = String.fromCharCode(92);
    const path = `E:${B}gdc${B}gdc-dubbed-videos${B}6q10dLQSzn0_notes.docx`;
    const html = renderToStaticMarkup(
      createElement(MessageContent, {
        text: `Word 文件完整路径：\n\n\`\`\`\n${path}\n\`\`\``,
        streaming: false,
        onOpenFile: () => {},
      }),
    );

    expect(html).toMatch(/ai-file-chip/);
    expect(html).toMatch(/ai-file-chip--interactive/);
    expect(html).not.toMatch(/ai-plain-block/);
    expect(html).toMatch(/6q10dLQSzn0_notes\.docx/);
  });

  it('shows reveal and open-containing-folder actions for interactive file chips', async () => {
    const calls: Array<{
      path: string;
      reveal?: boolean;
      containing?: boolean;
    }> = [];
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          createElement(MessageContent, {
            text: 'Open `src/store/useStore.ts:42`.',
            streaming: false,
            onOpenFile: (ref, intent) => {
              calls.push({
                path: ref.path,
                reveal: intent?.reveal,
                containing: intent?.openContainingFolder,
              });
            },
          }),
        );
      });

      const chip = container.querySelector<HTMLButtonElement>('.ai-file-chip');
      expect(chip).not.toBeNull();
      const openMenu = async () => {
        await act(async () => {
          chip!.dispatchEvent(
            new MouseEvent('contextmenu', {
              bubbles: true,
              cancelable: true,
              clientX: 16,
              clientY: 18,
            }),
          );
        });
        return container.querySelectorAll<HTMLButtonElement>(
          '.ai-file-chip-menu [role="menuitem"]',
        );
      };

      let menuItems = await openMenu();
      // Menu order: copy path, preview in app, open containing folder, reveal in folder
      const containingItem = menuItems[2];
      expect(containingItem?.textContent).toContain('打开所在目录');
      await act(async () => {
        containingItem!.dispatchEvent(
          new MouseEvent('pointerdown', { bubbles: true, cancelable: true }),
        );
      });
      expect(container.querySelector('.ai-file-chip-menu')).not.toBeNull();
      await act(async () => {
        containingItem!.click();
      });
      expect(container.querySelector('.ai-file-chip-menu')).toBeNull();

      menuItems = await openMenu();
      const revealItem = menuItems[3];
      expect(revealItem?.textContent).toContain('在文件夹中显示');
      await act(async () => {
        revealItem!.click();
      });

      expect(calls).toEqual([
        { path: 'src/store/useStore.ts', containing: true },
        { path: 'src/store/useStore.ts', reveal: true },
      ]);
      expect(container.querySelector('.ai-file-chip-menu')).toBeNull();
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('renders legacy command progress lines as isolated tool cards', () => {
    const command = [
      `"C:\\Program Files\\PowerShell\\7\\pwsh.exe"`,
      `-Command`,
      `'p="""C:\\Users\\fengwei\\AppData\\Local\\npm-cache\\abc\\node_modules\\@larksuiteoapi\\lark-mcp\\dist\\mcp-tool\\tools\\zh"""; node "$p"'`,
    ].join(' ');
    const html = renderToStaticMarkup(
      createElement(MessageContent, {
        text: `图片还在。\n🔧 command_execution: ${command}\n继续检查。`,
        streaming: false,
      }),
    );
    expect(html).toMatch(/ai-tool-card/);
    expect(html).toMatch(/command_execution/);
    expect(html).toMatch(/p=&quot;&quot;&quot;C:\\Users/);
    expect(html).not.toMatch(/ai-file-chip/);
    expect(html).not.toMatch(/Program Files/);
  });

  it('extracts inline legacy command progress from prose paragraphs', () => {
    const command = [
      `"C:\\Program Files\\PowerShell\\7\\pwsh.exe"`,
      `-Command`,
      `'p="""C:\\Users\\fengwei\\AppData\\Local\\npm-cache\\abc\\node_modules\\@larksuiteoapi\\lark-mcp\\dist\\mcp-tool\\tools\\zh"""; node "$p"'`,
    ].join(' ');
    const html = renderToStaticMarkup(
      createElement(MessageContent, {
        text:
          `先替一张表。 🔧 command_execution: ${command} ` +
          `🔧 command_execution: rg -n replace_image docx_image\\upload_all\\media.xupload node_modules 继续检查。`,
        streaming: false,
      }),
    );
    const rendered = document.createElement('div');
    rendered.innerHTML = html;
    expect(rendered.querySelectorAll('.ai-tool-card')).toHaveLength(2);
    expect(html).toMatch(/先替一张表/);
    expect(html).not.toMatch(/🔧/);
    expect(html).not.toMatch(/ai-file-chip/);
    expect(html).not.toMatch(/Program Files/);
  });

  it('renders structured tool output with rich code chrome', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const text =
      'running' +
      encodeToolPatch({
        id: 'tool-1',
        name: 'Read',
        subject: 'app/src/example.ts',
        args: { file_path: 'app/src/example.ts' },
        status: 'done',
        result: 'const answer: number = 42;\nconsole.log(answer);',
      });

    try {
      await act(async () => {
        root.render(createElement(MessageContent, { text, streaming: false }));
      });
      await act(async () => {
        container.querySelector<HTMLButtonElement>('.ai-tool-toggle')?.click();
      });

      expect(container.querySelector('.ai-tool-panel.ai-code')).not.toBeNull();
      expect(container.textContent).toContain('typescript');
      expect(container.textContent).toContain('json');
      expect(container.querySelector('.hljs-keyword')).not.toBeNull();
      expect(container.querySelector('.ai-tool-panel > pre')).toBeNull();
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('renders Edit tool args as a red/green unified diff', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const text =
      'editing' +
      encodeToolPatch({
        id: 'tool-edit',
        name: 'Edit',
        subject: 'src/foo.ts',
        args: {
          file_path: 'src/foo.ts',
          old_string: 'const a = 1;\nconst b = 2;',
          new_string: 'const a = 10;\nconst c = 3;',
        },
        status: 'done',
        result: 'ok',
      });

    try {
      await act(async () => {
        root.render(createElement(MessageContent, { text, streaming: false }));
      });
      await act(async () => {
        container.querySelector<HTMLButtonElement>('.ai-tool-toggle')?.click();
      });

      // Diff body should be rendered with the diff language class so the
      // red/green line backgrounds activate via .ai-code--diff.
      const diffScroll = container.querySelector('.ai-code--diff');
      expect(diffScroll).not.toBeNull();
      const html = diffScroll!.innerHTML;
      expect(html).toContain('--- a/src/foo.ts');
      expect(html).toContain('+++ b/src/foo.ts');
      expect(html).toContain('@@ -1,2 +1,2 @@');
      expect(container.querySelectorAll('.hljs-deletion').length).toBeGreaterThanOrEqual(2);
      expect(container.querySelectorAll('.hljs-addition').length).toBeGreaterThanOrEqual(2);
      expect(container.textContent).toContain('const a = 1;');
      expect(container.textContent).toContain('const a = 10;');
      // The JSON args blob should NOT be rendered alongside the diff.
      expect(container.textContent).not.toContain('"old_string"');
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('renders Write tool args as a pure-addition diff', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const text =
      'writing' +
      encodeToolPatch({
        id: 'tool-write',
        name: 'Write',
        subject: 'src/new.ts',
        args: {
          file_path: 'src/new.ts',
          content: 'export const x = 1;\nexport const y = 2;',
        },
        status: 'done',
        result: 'ok',
      });

    try {
      await act(async () => {
        root.render(createElement(MessageContent, { text, streaming: false }));
      });
      await act(async () => {
        container.querySelector<HTMLButtonElement>('.ai-tool-toggle')?.click();
      });

      const diffScroll = container.querySelector('.ai-code--diff');
      expect(diffScroll).not.toBeNull();
      const html = diffScroll!.innerHTML;
      expect(html).toContain('--- a/src/new.ts');
      expect(html).toContain('+++ b/src/new.ts');
      expect(html).toContain('@@ -0,0 +1,2 @@');
      expect(container.querySelectorAll('.hljs-addition').length).toBeGreaterThanOrEqual(2);
      expect(container.querySelectorAll('.hljs-deletion').length).toBe(0);
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('renders info-less ASCII-diagram fences as plain folded text, not a guessed language', () => {
    // Regression for a real chat transcript: the model draws a plain ``` block
    // (no language tag) full of box-drawing arrows + Chinese prose to sketch a
    // state timeline. `rehype-highlight`'s `detect` heuristic used to guess a
    // random registered language (e.g. `javascript`) for this kind of
    // ambiguous content, which showed a nonsense language badge in the header
    // and painted the ASCII art with garish syntax-highlight colors.
    const html = renderToStaticMarkup(
      createElement(MessageContent, {
        text: [
          '```',
          '时间轴 ────────────────────────────────────────────────────────▶',
          '',
          '[Unknown]',
          '    │  第一次转换：告诉GPU"接下来当拷贝目标用"',
          '    ▼',
          'CopyDest ◀── 真身IDTexture 正在把数据拷进来',
          '```',
        ].join('\n'),
        streaming: false,
      }),
    );

    expect(html).not.toMatch(/language-(?!plaintext)[a-z]+/);
    expect(html).not.toMatch(/hljs-/);
    expect(html).toMatch(/ai-plain-block/); // plain-text fences render as lightweight text
    expect(html).not.toMatch(/ai-code__folded/); // not a code block anymore
  });
});
