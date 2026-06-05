import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import MessageContent from './MessageContent';

/**
 * Integration smoke test: render a representative AI message through the real
 * react-markdown + remark-gfm + rehype-highlight pipeline and assert the rich
 * output appears (highlighted code, GFM table, file chip, reasoning block).
 * Guards the load-bearing assumption that the pre/code overrides and language
 * detection work under react-markdown v9.
 */
describe('MessageContent integration', () => {
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

  it('shows a reveal-in-folder menu for interactive file chips', async () => {
    const calls: Array<{ path: string; reveal?: boolean }> = [];
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
              calls.push({ path: ref.path, reveal: intent?.reveal });
            },
          }),
        );
      });

      const chip = container.querySelector<HTMLButtonElement>('.ai-file-chip');
      expect(chip).not.toBeNull();
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

      const menuItem = container.querySelector<HTMLButtonElement>(
        '.ai-file-chip-menu [role="menuitem"]',
      );
      expect(menuItem?.textContent).toContain('在文件夹中显示');
      await act(async () => {
        menuItem!.dispatchEvent(
          new MouseEvent('pointerdown', { bubbles: true, cancelable: true }),
        );
      });
      expect(container.querySelector('.ai-file-chip-menu')).not.toBeNull();
      await act(async () => {
        menuItem!.click();
      });

      expect(calls).toEqual([{ path: 'src/store/useStore.ts', reveal: true }]);
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
    expect(html.match(/ai-tool-card/g)).toHaveLength(2);
    expect(html).toMatch(/先替一张表/);
    expect(html).not.toMatch(/🔧/);
    expect(html).not.toMatch(/ai-file-chip/);
    expect(html).not.toMatch(/Program Files/);
  });
});
