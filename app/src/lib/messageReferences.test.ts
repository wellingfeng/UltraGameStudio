import { describe, expect, it } from 'vitest';
import { collectMessageReferences, mergeReferenceSources, referenceKey, sourcesFromTool, withMessageReferences } from './messageReferences';
import { encodeToolPatch } from '@/components/ai/lib/toolEvent';

const source = { url: 'https://example.com/docs', title: '接口文档', toolCallId: 'search' };
const event = { toolCallId: 'search', toolName: 'web_search', phase: 'end' as const, status: 'success' as const,
  result: JSON.stringify({ results: [{ url: source.url, title: source.title }, { url: 'https://example.com/unused', title: '未引用' }] }) };

describe('verified message references', () => {
  it('extracts structured and MCP text results, ignores failed and unrelated tools', () => {
    expect(sourcesFromTool(event)).toHaveLength(2);
    expect(sourcesFromTool({ ...event, result: JSON.stringify({ content: [{ type: 'text', text: '[接口文档](https://example.com/docs)' }] }) })).toEqual([source]);
    expect(sourcesFromTool({ ...event, status: 'error' })).toEqual([]);
    expect(sourcesFromTool({ ...event, toolName: 'exec_command' })).toEqual([]);
    expect(sourcesFromTool({ ...event, toolName: 'WebFetch', args: { url: source.url }, result: '页面正文' })).toEqual([{ ...source, title: source.url }]);
  });
  it('deduplicates tracking and anchors but preserves meaningful queries and original links', () => {
    expect(mergeReferenceSources([source], [{ ...source, url: `${source.url}?utm_source=test#api` }])).toEqual([source]);
    expect(referenceKey(`${source.url}?version=2`)).not.toBe(referenceKey(source.url));
    for (const url of ['javascript:alert(1)', 'file:///private', 'https://user:password@example.com']) expect(referenceKey(url)).toBeNull();
  });
  it('numbers actual answer citations by first use, excluding reasoning, code, images and unused sources', () => {
    const sources = sourcesFromTool(event);
    const text = '<think>[推理](https://example.com/unused)</think>结论 [9](https://example.com/docs#api)。再次 [2](https://example.com/docs?utm_source=x)。'
      + '\n`[片段](https://example.com/unused)`\n\n```md\n[示例](https://example.com/unused)\n```\n'
      + '![图片](https://example.com/unused)\n[未证实](https://unverified.example.com)';
    expect(collectMessageReferences(text, sources)).toEqual([{ ...source, number: 1 }]);
  });
  it('resolves Markdown reference definitions and survives JSON roundtrip without tool output', () => {
    const message = withMessageReferences({ id: 'reply', role: 'assistant', createdAt: 1,
      text: '结论 [资料][api]\n\n[api]: https://example.com/docs', referenceSources: [source] });
    expect(JSON.parse(JSON.stringify(message)).references).toEqual([{ ...source, number: 1 }]);
  });
  it('preserves download and media links as ordinary links, including repeated cited URLs', () => {
    const media = { ...source, url: 'https://example.com/photo.png' };
    expect(collectMessageReferences('[下载文档](https://example.com/docs) [图片](https://example.com/photo.png)', [source, media])).toEqual([]);
  });
  it('reconstructs legacy tools, never accepts synthetic success or leaks partial stream citations', () => {
    const patch = { id: 'search', name: 'web_search', status: 'done' as const, result: event.result };
    const text = encodeToolPatch(patch) + '结论 [1](https://example.com/docs)';
    expect(withMessageReferences({ id: 'a', role: 'assistant', text, createdAt: 1 }).references).toEqual([{ ...source, number: 1 }]);
    expect(withMessageReferences({ id: 'a', role: 'assistant', text: encodeToolPatch({ ...patch, provenance: 'ui-synthetic' }) + '结论 [1](https://example.com/docs)', createdAt: 1 }).references).toBeUndefined();
    expect(withMessageReferences({ id: 'a', role: 'assistant', text: encodeToolPatch({ ...patch, evidenceStatus: 'unknown' }) + '结论 [1](https://example.com/docs)', createdAt: 1 }).references).toBeUndefined();
    expect(collectMessageReferences('结论 [1](https://example.com/do', [source], true)).toEqual([]);
  });
});
