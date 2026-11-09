import { describe, expect, it } from 'vitest';
import { liveProse } from '@/core/interaction';
import { legacyXmlToolsToSentinels } from '@/components/ai/lib/legacyXmlTool';
import { IncrementalProtocolText } from './incrementalProtocolText';

const transform = (text: string) => legacyXmlToolsToSentinels(text, { streamingTail: true });

describe('incremental protocol text', () => {
  it.each([
    'early\n\n\n\nparagraph\nnext\n<invoke name="Read">\n</invoke>\nfinal\n',
    'prose\n\n\n\n<invoke name="Read">\n<parameter name="file_path">a.ts</parameter>\n</invoke>\nfinal\n',
    'prose\n<function_calls>\n\n<invoke name="Read">\n</invoke>\n</function_calls>\nfinal\n',
    'prose\n<invoke name="Read">\n</invoke>\ncount\nfinal\n',
  ])('matches authoritative XML whitespace and residue at every prefix: %s', (raw) => {
    const stream = new IncrementalProtocolText();
    let received = '';
    for (const char of raw) {
      received += char;
      stream.append(char);
      expect(stream.display(), JSON.stringify(received)).toBe(liveProse(transform(received), false));
    }
    expect(stream.raw).toBe(raw);
  });
  it('preserves case-insensitive XML wrapper boundaries accepted by the legacy converter', () => {
    const raw = '正文\n<FUNCTION_CALLS>\n<INVOKE name="Read">\n<PARAMETER name="file_path">a.ts</PARAMETER>\n</INVOKE>\n</FUNCTION_CALLS>\n最终正文\n';
    const stream = new IncrementalProtocolText();
    let received = '';
    for (const char of raw) {
      received += char;
      stream.append(char);
      expect(stream.display()).toBe(liveProse(transform(received), false));
    }
    expect(stream.raw).toBe(raw);
  });

  it('keeps a tolerant ask delimiter spanning newlines in the mutable tail', () => {
    const stream = new IncrementalProtocolText();
    let raw = '';
    for (const chunk of ['正文\n', '<<\n', '\n', ' UGS_ASK\n', ' >>\n{"prompt":"hidden"}\n']) {
      raw += chunk;
      stream.append(chunk);
      expect(stream.display()).toBe(liveProse(transform(raw), false));
    }
  });

  it('hides generation protocol JSON without changing the terminal raw content', () => {
    const stream = new IncrementalProtocolText();
    stream.append('正文\n<<UGS_GEN>>\n{"kind":"image"}\n<<UGS_GEN_END>>\n');
    expect(stream.display()).toBe('正文');
    expect(stream.raw).toContain('<<UGS_GEN>>\n{"kind":"image"}');
  });

  it('removes obsolete runtime heartbeat lines when real text follows', () => {
    const stream = new IncrementalProtocolText();
    let received = '';
    for (const chunk of ['正文\n', '⏳ 仍在运行…（已 1s）\n', '\n', '⏳ 仍在运行…（已 2s）\n', '继续正文', '\n下一段\n']) {
      received += chunk;
      stream.append(chunk);
      expect(stream.display()).toBe(liveProse(transform(received), false));
    }
  });

  it('bounds reparsing for a long unfenced single-line paragraph', () => {
    let parsed = 0;
    const stream = new IncrementalProtocolText((text) => { parsed += text.length; return transform(text); });
    let raw = '';
    for (let i = 0; i < 100; i += 1) {
      const chunk = '正文'.repeat(100);
      raw += chunk;
      stream.append(chunk);
      expect(stream.display()).toBe(raw);
    }
    stream.append('<invoke name="literal">');
    raw += '<invoke name="literal">';
    expect(stream.display()).toBe(raw);
    expect(parsed).toBeLessThan(raw.length * 10);
  });

  it('keeps protocol JSON hidden after its line is sealed without dropping raw input', () => {
    for (const marker of ['<<UGS_ASK>>', '<< UGS_ASK >>', '<<UGS_MEMORY>>', '<<UGS_RECALL>>']) {
      const stream = new IncrementalProtocolText();
      const chunks = ['正文\n\n', marker, '\n{"key":"私有协议"}\n', '结束\n', '后续\n'];
      let received = '';
      for (const chunk of chunks) {
        received += chunk;
        stream.append(chunk);
        expect(stream.display()).toBe(liveProse(transform(received), false));
      }
      expect(stream.raw).toBe(received);
    }
  });

  it('retains tool, think and XML boundaries across single-character chunks', () => {
    const raw = '正文\n<function_calls>\n<invoke name="Read">\n<parameter name="file_path">a.ts</parameter>\n</invoke>\n</function_calls>\n'
      + '<think>\n思考\n</think>\n'
      + '<<UGS_TOOL>>{"id":"t","name":"Read","result":"```\\n<invoke name=\\"fake\\">"}<<UGS_TOOL_END>>\n'
      + '```xml\n<invoke name="literal">\n</invoke>\n```\n最终正文';
    const stream = new IncrementalProtocolText();
    let received = '';
    for (const char of raw) {
      received += char;
      stream.append(char);
      expect(stream.display()).toBe(liveProse(transform(received), false));
    }
    expect(stream.raw).toBe(raw);
  });

  it('never reparses sealed prose as the stream grows', () => {
    let parsed = 0;
    const stream = new IncrementalProtocolText((text) => { parsed += text.length; return transform(text); });
    let raw = '';
    for (let i = 0; i < 100; i += 1) {
      const chunk = `${'正文'.repeat(100)}\n`;
      raw += chunk;
      stream.append(chunk);
      expect(stream.display()).toBe(liveProse(transform(raw), false));
    }
    expect(stream.raw).toBe(raw);
    expect(parsed).toBeLessThan(raw.length * 10);
  });
});
