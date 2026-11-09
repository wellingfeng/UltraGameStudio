import { describe, expect, it } from 'vitest';
import katex from 'katex';
import { renderTemporaryChatMarkdown } from './markdown';
import { temporaryChatDocument } from './document';

const renderMath = (target: HTMLElement, formula: string, display: boolean) => {
  katex.render(formula, target, { output: 'mathml', displayMode: display, throwOnError: false, trust: false });
};

const html = (text: string) => {
  const host = document.createElement('div');
  host.append(renderTemporaryChatMarkdown(document, text, renderMath));
  return host;
};

describe('renderTemporaryChatMarkdown', () => {
  it('renders the screenshot formula inside a list instead of showing raw LaTeX', () => {
    const host = html(String.raw`- **自己写底层 View：** 在每次 View 改变大小的时候，必须自己写代码：
  $$\text{drawableSize} = \text{view.bounds.size} \times \text{view.contentScaleFactor}$$
  把算好的像素大小手动赋给 Metal 图层。`);
    expect(host.querySelector('li math')).not.toBeNull();
    expect(host.querySelector('li math')?.textContent).toContain('drawableSize');
    expect(host.querySelector('li')?.textContent).not.toContain('$$');
    expect(host.querySelector('li')?.textContent).toContain('把算好的像素大小手动赋给 Metal 图层。');
  });

  it('renders inline and multiline display math with common delimiters', () => {
    const host = html(String.raw`行内 $x^2$ 和 \(\frac{a}{b}\)。

$$
\sum_{i=1}^{n} x_i
$$

\[
E = mc^2
\]`);
    expect(host.querySelectorAll('.math-inline math')).toHaveLength(2);
    expect(host.querySelectorAll('.math-display math[display="block"]')).toHaveLength(2);
    expect(host.querySelector('mfrac')).not.toBeNull();
    expect(host.querySelector('munderover, msubsup')).not.toBeNull();
  });

  it('leaves code, prices, escaped delimiters and incomplete formulas as text', () => {
    const host = html('价格 $5 到 $10，转义 \\$x$ 和 \\$$a$$，未完成 $y\n\n`$z$`\n\n```tex\n$$x^2$$\n```');
    expect(host.querySelector('math')).toBeNull();
    expect(host.textContent).toContain('价格 $5 到 $10');
    expect(host.querySelector('p code')?.textContent).toBe('$z$');
    expect(host.querySelector('pre code')?.textContent).toBe('$$x^2$$');
  });

  it('does not allow formula commands to inject links or HTML', () => {
    const host = html(String.raw`$\href{javascript:alert(1)}{click}$ <img src=x onerror=alert(1)>`);
    expect(host.querySelector('a, img, script')).toBeNull();
  });

  it('renders headings, CJK bold, lists with continuation lines and rules', () => {
    const host = html([
      '### 1. 形象比喻：草稿纸与工作台',
      '',
      '把移动端 GPU 想象成**一张小工作台（片上 Tile 内存）**，把外部',
      '',
      '* **普通附件（普通纹理）：**',
      '  你在工作台上算账。',
      '* **Memoryless：**',
      '  它**根本不需要',
      '仓库。**',
      '',
      '---',
      '',
      '1. **省物理内存：**',
      '   系统根本不需要',
    ].join('\n'));
    expect(host.querySelector('h3')?.textContent).toBe('1. 形象比喻：草稿纸与工作台');
    expect(host.querySelector('p strong')?.textContent).toBe('一张小工作台（片上 Tile 内存）');
    const items = host.querySelectorAll('ul > li');
    expect(items).toHaveLength(2);
    expect(items[0].querySelector('strong')?.textContent).toBe('普通附件（普通纹理）：');
    expect(items[0].textContent).toContain('你在工作台上算账。');
    expect(items[1].querySelectorAll('strong')[1]?.innerHTML).toBe('根本不需要<br>仓库。');
    expect(host.querySelector('hr')).not.toBeNull();
    expect(host.querySelector('ol > li strong')?.textContent).toBe('省物理内存：');
    expect(host.textContent).not.toContain('**');
    expect(host.textContent).not.toContain('###');
  });

  it('renders nested lists, code, quotes and tables', () => {
    const host = html('- a\n  - b\n\n```ts\nconst x = `<b>`;\n```\n\n> 引用 `code`\n\n| A | B |\n| - | - |\n| 1 | **2** |');
    expect(host.querySelector('ul > li > ul > li')?.textContent).toBe('b');
    expect(host.querySelector('pre code')?.textContent).toBe('const x = `<b>`;');
    expect(host.querySelector('blockquote code')?.textContent).toBe('code');
    expect(host.querySelector('td strong')?.textContent).toBe('2');
  });

  it('keeps model HTML as plain text', () => {
    const host = html('<img src=x onerror=alert(1)> **<script>x</script>**');
    expect(host.querySelector('img,script')).toBeNull();
    expect(host.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('is injected as runnable code in the iframe document', () => {
    const source = temporaryChatDocument();
    const script = source.slice(source.indexOf('<script nonce'), source.lastIndexOf('</script>'));
    const body = script.slice(script.indexOf('>') + 1);
    expect(() => new Function(body)).not.toThrow();
    const render = new Function(`${body.slice(body.indexOf('const renderMarkdown='), body.indexOf('function markdownNode'))}; return renderMarkdown;`)();
    const host = document.createElement('div');
    host.append(render(document, '## 标题\n**粗体**'));
    expect(host.querySelector('h2')?.textContent).toBe('标题');
    expect(host.querySelector('strong')?.textContent).toBe('粗体');
  });
});
