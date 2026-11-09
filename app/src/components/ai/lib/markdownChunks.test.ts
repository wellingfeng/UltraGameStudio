import { describe, expect, it, vi } from 'vitest';
import { createMarkdownChunks } from './markdownChunks';

const parseWork = vi.hoisted(() => ({ chars: 0, calls: 0 }));
vi.mock('unified', async (load) => {
  const real = await load<typeof import('unified')>();
  return { ...real, unified: (...args: Parameters<typeof real.unified>) => {
    const processor = real.unified(...args);
    const parse = processor.parse;
    processor.parse = function(this: typeof processor, file) {
      parseWork.chars += String(file).length;
      parseWork.calls += 1;
      return parse.call(this, file);
    } as typeof processor.parse;
    return processor;
  } };
});

const prefix = 'A completed **paragraph**.\n\n'.repeat(200);
describe('Markdown chunk boundaries', () => {
  it.each([
    ['single paragraph', 'ordinary prose '.repeat(7000)],
    ['unclosed fence', '```ts\n' + 'const value = 1;\n'.repeat(7000)],
  ])('amortizes real boundary-parser work for a growing %s', (_name, initial) => {
    const chunks = createMarkdownChunks();
    chunks(initial, true);
    parseWork.chars = 0;
    parseWork.calls = 0;
    let text = initial;
    for (let i = 0; i < 60; i += 1) {
      text += ' delta';
      expect(chunks(text, true).map((part) => part.text).join('')).toBe(text);
    }
    expect(parseWork.chars).toBeLessThan(text.length * 2);
    expect(chunks(text, false)).toEqual([{ key: 0, text, live: false }]);
  });
  it.each([
    ['single paragraph', 'ordinary prose '.repeat(300)],
    ['unclosed fence', '```ts\n' + 'const value = 1;\n'.repeat(300)],
  ])('keeps cumulative discovery linear while a %s doubles repeatedly', (_name, initial) => {
    const chunks = createMarkdownChunks();
    parseWork.chars = 0;
    parseWork.calls = 0;
    let text = initial;
    chunks(text, true);
    for (let i = 0; i < 60; i += 1) {
      text += ' ordinary delta '.repeat(128);
      expect(chunks(text, true).map((part) => part.text).join('')).toBe(text);
    }
    expect(parseWork.calls).toBeGreaterThan(1);
    expect(parseWork.chars).toBeLessThan(text.length * 3);
    expect(chunks('replacement\n\n'.repeat(400), true).length).toBeGreaterThan(1);
  });
  it('keeps markdown-wrapper fences in one normalization document', () => {
    const chunks = createMarkdownChunks();
    const text = prefix + '```markdown\n```ts\nconst n = 1;\n```\n\nprose\n\nnext\n\n```';
    expect(chunks(text, true)).toEqual([{ key: 0, text, live: true }]);
  });
  it('does not isolate section-grouping thematic breaks into independent documents', () => {
    const chunks = createMarkdownChunks();
    const text = prefix + '* * *\n\nSection one\n\nSection two\n\nTail';
    expect(chunks(text, true)).toEqual([{ key: 0, text, live: true }]);
  });
  it.each([
    ['open fence', '```ts\nconst a = 1;\n\nconst b = 2;'],
    ['table', '| a | b |\n| --- | --- |\n| one | two |'],
    ['open HTML', '<details>\n<summary>title</summary>\n\nbody'],
    ['open math', '$$\nx + y\n\nz'],
    ['reference definition', '[guide][ref]\n\n[ref]: https://example.com'],
    ['partial tag', '<thi'],
  ])('keeps %s intact and returns the original full revision at completion', (_name, tail) => {
    const chunks = createMarkdownChunks();
    const text = prefix + tail;
    const live = chunks(text, true);
    expect(live.map((part) => part.text).join('')).toBe(text);
    expect(live.at(-1)?.text).toContain(tail);
    const revised = chunks(text + ' more', true);
    expect(revised.map((part) => part.text).join('')).toBe(text + ' more');
    expect(chunks(text + ' more', false)).toEqual([{ key: 0, text: text + ' more', live: false }]);
  });

  it('drops previously sealed blocks for a non-append revision', () => {
    const chunks = createMarkdownChunks();
    chunks(prefix + 'tail', true);
    expect(chunks('replacement', true)).toEqual([{ key: 0, text: 'replacement', live: true }]);
  });
});
