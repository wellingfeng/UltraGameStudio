import { describe, expect, it, vi } from 'vitest';
import { collectTurnFileChanges } from './turnFileChanges';
import { encodeToolPatch } from '@/components/ai/lib/toolEvent';
import type { Message } from '@/store/types';

describe('confirmed file-change derivation revisions', () => {
  it('does not re-decode completed edits while prose grows in the same live message', () => {
    const tool = encodeToolPatch({ id: 'live-edit-cached', name: 'Edit', status: 'done',
      args: { file_path: 'src/live.ts', old_string: 'old', new_string: 'new' } });
    const message: Message = { id: 'live-files', role: 'assistant', text: tool + 'answer', createdAt: 1 };
    collectTurnFileChanges([message], null, 'E:/Game');
    const decode = vi.spyOn(JSON, 'parse');
    try {
      expect(collectTurnFileChanges([{ ...message, text: tool + 'answer grows' }], null, 'E:/Game')?.files)
        .toEqual([{ path: 'src/live.ts', status: undefined, added: 1, deleted: 1 }]);
      expect(decode.mock.calls.filter(([input]) => typeof input === 'string' && input.includes('live-edit-cached'))).toHaveLength(0);
    } finally { decode.mockRestore(); }
  });
  it('reuses confirmed native edits while aggregating a new live message array', () => {
    const old: Message = { id: 'old-files', role: 'assistant', createdAt: 1,
      text: encodeToolPatch({ id: 'old-edit-cached', name: 'Edit', status: 'done',
        args: { file_path: 'src/old.ts', old_string: 'old', new_string: 'new' } }) };
    const tail: Message = { id: 'tail-files', role: 'assistant', createdAt: 2, text: 'tail' };
    collectTurnFileChanges([old, tail], null, 'E:/Game');
    const decode = vi.spyOn(JSON, 'parse');
    try {
      const changes = collectTurnFileChanges([old, { ...tail, text: 'tail appended' }], null, 'E:/Game');
      expect(changes?.files).toEqual([{ path: 'src/old.ts', status: undefined, added: 1, deleted: 1 }]);
      expect(decode.mock.calls.filter(([input]) => input.includes('old-edit-cached'))).toHaveLength(0);
    } finally { decode.mockRestore(); }
  });
  it('reuses one immutable message revision across new render arrays', () => {
    const message: Message = { id: 'cached-files', role: 'assistant', createdAt: 1,
      text: encodeToolPatch({ id: 'write', name: 'Edit', status: 'done',
        args: { file_path: 'src/cache.ts', old_string: 'old', new_string: 'new' } }) };
    const first = collectTurnFileChanges([message], null, 'E:/Game');
    expect(first?.files[0]).toMatchObject({ added: 1, deleted: 1 });
    expect(collectTurnFileChanges([message], null, 'E:/Game')).toBe(first);
    const revision = { ...message, text: encodeToolPatch({ id: 'write', name: 'Edit', status: 'done',
      args: { file_path: 'src/cache.ts', old_string: 'old', new_string: 'one\ntwo' } }) };
    expect(collectTurnFileChanges([revision], null, 'E:/Game')?.files[0].added).toBe(2);
  });
});
