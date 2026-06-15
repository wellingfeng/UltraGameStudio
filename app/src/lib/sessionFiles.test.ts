import { describe, expect, it } from 'vitest';
import {
  buildSessionFileTree,
  countSessionFileChanges,
  extractSessionFiles,
  mergeSessionFilesWithWorkspaceChanges,
  type SessionFileEntry,
  type SessionFileTreeNode,
} from './sessionFiles';
import { encodeToolPatch } from '@/components/ai/lib/toolEvent';
import type { Message } from '@/store/types';
import type { WorkspaceChanges } from './tauri';

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

function sessionFile(path: string, action: SessionFileEntry['action'] = 'read'): SessionFileEntry {
  const basename = path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? path;
  return {
    path,
    basename,
    action,
    touchCount: 1,
    lastTouchedAt: 1,
  };
}

function treeOutline(nodes: SessionFileTreeNode[]): unknown[] {
  return nodes.map((node) => {
    if (node.type === 'file') return `${node.name}:${node.entry.action}`;
    return [node.name, node.fileCount, treeOutline(node.children)];
  });
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

  it('extracts codex file_change paths from nested structured args', () => {
    const messages: Message[] = [
      assistant(
        'a1',
        10,
        toolBlock('fc', 'file_change', {
          subject: 'completed',
          args: {
            changes: [
              { path: 'app/src/lib/sessionFiles.ts', status: 'modified' },
              { file_path: 'app/src/panels/ProjectFileTree.tsx' },
            ],
          },
        }),
      ),
    ];

    const files = extractSessionFiles(messages);

    expect(files.map((f) => [f.path, f.action])).toEqual([
      ['app/src/lib/sessionFiles.ts', 'edited'],
      ['app/src/panels/ProjectFileTree.tsx', 'edited'],
    ]);
  });

  it('extracts file_change paths from patch-style results', () => {
    const messages: Message[] = [
      assistant(
        'a1',
        10,
        toolBlock('fc', 'file_change', {
          subject: 'completed',
          result: [
            '*** Begin Patch',
            '*** Update File: app/src/lib/sessionFiles.ts',
            '*** Add File: app/src/lib/newSessionFile.ts',
            '*** End Patch',
          ].join('\n'),
        }),
      ),
    ];

    const files = extractSessionFiles(messages);

    expect(files.map((f) => [f.path, f.action])).toEqual([
      ['app/src/lib/sessionFiles.ts', 'edited'],
      ['app/src/lib/newSessionFile.ts', 'edited'],
    ]);
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

  it('decorates only files edited by this session with persisted workspace changes', () => {
    const activity = extractSessionFiles([
      assistant('a1', 10, toolBlock('r', 'Read', { args: { file_path: 'src/read-only.ts' } })),
      assistant('a2', 20, toolBlock('e', 'Edit', { args: { file_path: 'src/app.ts' } })),
      assistant('a3', 30, toolBlock('w', 'Write', { args: { file_path: 'src/new.ts' } })),
    ]);
    const changes: WorkspaceChanges = {
      rootPath: 'E:/OpenWorkflows',
      generatedAtMs: 50,
      source: 'git',
      truncated: false,
      files: [
        { path: 'src/read-only.ts', oldPath: null, status: 'modified', binary: false, truncated: false, lines: [] },
        { path: 'src/app.ts', oldPath: null, status: 'modified', binary: false, truncated: false, lines: [] },
        { path: 'src/new.ts', oldPath: null, status: 'added', binary: false, truncated: false, lines: [] },
        { path: 'src/unrelated.ts', oldPath: null, status: 'modified', binary: false, truncated: false, lines: [] },
      ],
    };

    const files = mergeSessionFilesWithWorkspaceChanges(activity, changes);

    expect(files.map((f) => [f.path, f.action, f.changeStatus])).toEqual([
      ['src/new.ts', 'edited', 'added'],
      ['src/app.ts', 'edited', 'modified'],
      ['src/read-only.ts', 'read', undefined],
    ]);
    expect(countSessionFileChanges(files)).toEqual({
      added: 1,
      modified: 1,
      deleted: 0,
      renamed: 0,
    });
  });

  it('adds persisted snapshot changes as edited session files', () => {
    const changes: WorkspaceChanges = {
      rootPath: 'E:/OpenWorkflows',
      generatedAtMs: 50,
      source: 'snapshot',
      truncated: false,
      files: [
        { path: 'src/app.ts', oldPath: null, status: 'modified', binary: false, truncated: false, lines: [] },
        { path: 'src/new.ts', oldPath: null, status: 'added', binary: false, truncated: false, lines: [] },
      ],
    };

    const files = mergeSessionFilesWithWorkspaceChanges([], changes);

    expect(files.map((f) => [f.path, f.action, f.changeStatus])).toEqual([
      ['src/app.ts', 'edited', 'modified'],
      ['src/new.ts', 'edited', 'added'],
    ]);
  });

  it('builds session files into a nested path tree', () => {
    const tree = buildSessionFileTree([
      sessionFile('E:\\Game\\Config\\Default.ini'),
      sessionFile('E:/Game/Source/Main.cs', 'edited'),
      sessionFile('relative/tool.ts'),
    ]);

    expect(treeOutline(tree)).toEqual([
      [
        'E:/',
        2,
        [
          [
            'Game',
            2,
            [
              ['Config', 1, ['Default.ini:read']],
              ['Source', 1, ['Main.cs:edited']],
            ],
          ],
        ],
      ],
      ['relative', 1, ['tool.ts:read']],
    ]);
  });
});
