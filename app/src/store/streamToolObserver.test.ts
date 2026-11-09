import { describe, expect, it } from 'vitest';
import { encodeToolPatch } from '@/components/ai/lib/toolEvent';
import { StreamToolObserver } from './streamToolObserver';

describe('synchronous critical tool observer', () => {
  it('observes each completion once even when delimiters span single-character deltas', () => {
    const observer = new StreamToolObserver();
    const patches = [
      { id: 'one', name: 'ugs_context_compaction', status: 'done' as const },
      { id: 'two', name: 'Read', status: 'done' as const, result: 'x'.repeat(10_000) },
    ];
    const observed = [];
    for (const char of `正文${patches.map(encodeToolPatch).join('')}后续正文`) observed.push(...observer.append(char));
    expect(observed).toEqual(patches);
    expect(observer.append('普通流')).toEqual([]);
  });

  it('does not fabricate a completed event for an incomplete or invalid sentinel', () => {
    const observer = new StreamToolObserver();
    expect(observer.append('<<UGS_TOOL>>{"name":"Read"')).toEqual([]);
    // A closed JSON body without the required event identity is still invalid.
    expect(observer.append('}<<UGS_TOOL_END>>')).toEqual([]);
    expect(observer.append('<<UGS_TOOL>>invalid<<UGS_TOOL_END>>')).toEqual([]);
  });
});
