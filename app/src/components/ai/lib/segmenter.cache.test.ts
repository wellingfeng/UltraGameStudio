import { describe, expect, it, vi } from 'vitest';
import { segmentMessage } from './segmenter';
import { encodeToolPatch } from './toolEvent';

// Identity is the renderer's observable memo boundary, not a mocked parser.
describe('segmentMessage sealed derivation', () => {
  it('does not decode closed native tool payloads again as answer text streams after them', () => {
    const text = encodeToolPatch({ id: 'cached-tool', name: 'Read', status: 'done', result: 'sealed result' }) + 'answer';
    segmentMessage(text, true);
    const decode = vi.spyOn(JSON, 'parse');
    try {
      const segments = segmentMessage(text + ' growing', true);
      expect(segments.find((segment) => segment.type === 'tools')).toMatchObject({ events: [{ id: 'cached-tool', status: 'done' }] });
      expect(segments.at(-1)).toMatchObject({ type: 'answer', text: 'answer growing' });
      expect(decode.mock.calls.filter(([input]) => input.includes('cached-tool'))).toHaveLength(0);
    } finally { decode.mockRestore(); }
  });
  it('reuses an unchanged revision without rebuilding completed reasoning and tools', () => {
    const text = '<think>sealed plan</think>cached answer';
    const first = segmentMessage(text, false);
    expect(segmentMessage(text, false)).toBe(first);
    expect(segmentMessage(text + ' revised', false)).not.toBe(first);
    expect(segmentMessage(text, true)).not.toBe(first);
  });
  it('decodes an oversized tool projection only once per render', () => {
    const text = 'x'.repeat(1_100_000) + encodeToolPatch({ id: 'oversized-once', name: 'Read', status: 'done', result: 'ok' });
    const decode = vi.spyOn(JSON, 'parse');
    try {
      const segments = segmentMessage(text, false);
      expect(segments.find((segment) => segment.type === 'tools')).toMatchObject({ events: [{ id: 'oversized-once' }] });
      expect(decode.mock.calls.filter(([input]) => input.includes('oversized-once'))).toHaveLength(1);
    } finally { decode.mockRestore(); }
  });
});
