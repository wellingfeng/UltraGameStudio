import { describe, expect, it, vi } from 'vitest';
import { cleanMessageText } from './messageText';
import { encodeToolPatch } from './toolEvent';

describe('search text derivations', () => {
  it('does not decode the same sealed tool JSON again for a new search query', () => {
    const text = 'searchable' + encodeToolPatch({ id: 'search-cache-tool', name: 'Read', status: 'done', result: 'not searchable' });
    const first = cleanMessageText(text);
    const decode = vi.spyOn(JSON, 'parse');
    try {
      expect(cleanMessageText(text)).toBe(first);
      expect(decode.mock.calls.filter(([input]) => input.includes('search-cache-tool'))).toHaveLength(0);
      expect(cleanMessageText(text + ' appended')).toContain('appended');
      expect(cleanMessageText(text + ' appended')).not.toContain('not searchable');
    } finally { decode.mockRestore(); }
  });
});
