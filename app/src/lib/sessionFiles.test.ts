import { describe, expect, it } from 'vitest';
import { extractSessionFiles } from './sessionFiles';
import { encodeToolPatch } from '@/components/ai/lib/toolEvent';
import type { Message } from '@/store/types';

function assistant(id: string, createdAt: number, body: string): Message {
  return { id, role: 'assistant', text: body, createdAt };
}

function user(id: string, createdAt: number, text: string): Message {
  return { id, role: 'user', text, createdAt };
}

function toolBlock(
  id: string,
  name: string,
  extra: Record<string, unknown>,
): string {
  return encodeToolPatch({ id, name, status: 'done', ...extra });
}

describe('extractSessionFiles', () => {
  it('returns [] for pure chat with no tool activity', () => {
    const messages: Message[] = [
      user('u1', 1, 'hi'),
      assistant('a1', 2, 'hello, no tools here'),
    ];
    expect(extractSessionFiles(messages)).toEqual([]);
  });

  it('extracts a read file from structured args', () => {
    const messages: Message[] = [
      assistant(
        'a1',
        100,
        `looking now${toolBlock('t1', 'Read', { args: { file_path: 'app/src/App.tsx' } })}`,
      ),
    ];
    const files = extractSessionFiles(messages);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      path: 'app/src/App.tsx',
      basename: 'App.tsx',
      action: 'read',
      touchCount: 1,
      lastTouchedAt: 100,
    });
  });

  it('classifies edit/write tools as edited and read as read', () => {
    const messages: Message[] = [
      assistant(
        'a1',
        10,
        toolBlock('r', 'Read', { args: { file_path: 'a.ts' } }) +
          toolBlock('w', 'Write', { args: { file_path: 'b.ts' } }),
      ),
    ];
    const files = extractSessionFiles(messages);
    const byBase = Object.fromEntries(files.map((f) => [f.basename, f.action]));
    expect(byBase['a.ts']).toBe('read');
    expect(byBase['b.ts']).toBe('edited');
  });

  it('escalates a file from read to edited and merges touch count', () => {
    const messages: Message[] = [
      assistant('a1', 10, toolBlock('r', 'Read', { args: { file_path: 'src/x.ts' } })),
      assistant('a2', 20, toolBlock('e', 'Edit', { args: { file_path: 'src/x.ts' } })),
    ];
    const files = extractSessionFiles(messages);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      action: 'edited',
      touchCount: 2,
      lastTouchedAt: 20,
    });
  });

  it('dedupes across path separator and case differences', () => {
    const messages: Message[] = [
      assistant('a1', 10, toolBlock('r', 'Read', { args: { file_path: 'Src/App.tsx' } })),
      assistant('a2', 20, toolBlock('r2', 'Read', { args: { file_path: 'src\\app.tsx' } })),
    ];
    const files = extractSessionFiles(messages);
    expect(files).toHaveLength(1);
    expect(files[0].touchCount).toBe(2);
    // Keeps the latest verbatim spelling.
    expect(files[0].path).toBe('src\\app.tsx');
  });

  it('falls back to subject path for file tools without args', () => {
    const messages: Message[] = [
      assistant('a1', 10, toolBlock('r', 'Read', { subject: 'app/src/store/useStore.ts' })),
    ];
    const files = extractSessionFiles(messages);
    expect(files).toHaveLength(1);
    expect(files[0].basename).toBe('useStore.ts');
  });

  it('ignores shell/search tools (Bash, Grep) entirely', () => {
    const messages: Message[] = [
      assistant(
        'a1',
        10,
        toolBlock('b', 'Bash', { subject: 'ls app/src' }) +
          toolBlock('g', 'Grep', { subject: 'app/src/foo.ts' }),
      ),
    ];
    expect(extractSessionFiles(messages)).toEqual([]);
  });

  it('sorts most-recently-touched first', () => {
    const messages: Message[] = [
      assistant('a1', 10, toolBlock('r', 'Read', { args: { file_path: 'old.ts' } })),
      assistant('a2', 50, toolBlock('r2', 'Read', { args: { file_path: 'new.ts' } })),
    ];
    const files = extractSessionFiles(messages);
    expect(files.map((f) => f.basename)).toEqual(['new.ts', 'old.ts']);
  });

  it('drops files rejected by the isIgnored predicate', () => {
    const messages: Message[] = [
      assistant('a1', 10, toolBlock('r', 'Read', { args: { file_path: 'src/app.ts' } })),
      assistant('a2', 20, toolBlock('r2', 'Read', { args: { file_path: 'Saved/log.txt' } })),
      assistant('a3', 30, toolBlock('w', 'Write', { args: { file_path: 'Intermediate/x.o' } })),
    ];
    const isIgnored = (path: string) =>
      /^(saved|intermediate)\//i.test(path.replace(/\\/g, '/'));
    const files = extractSessionFiles(messages, { isIgnored });
    expect(files.map((f) => f.path)).toEqual(['src/app.ts']);
  });
});
