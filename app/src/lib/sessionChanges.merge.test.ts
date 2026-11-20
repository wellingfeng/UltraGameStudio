import { describe, expect, it } from 'vitest';
import { encodeToolPatch } from '@/components/ai/lib/toolEvent';
import { collectSessionEditedFiles, collectSessionFileChanges, collectTurnFileChanges } from './turnFileChanges';
import type { WorkspaceChanges } from './tauri';
import type { Message } from '@/store/types';

const snapshot: WorkspaceChanges = {
  rootPath: 'F:/Client/Game', generatedAtMs: 10, source: 'snapshot', truncated: false,
  files: [
    { path: 'src/a.ts', status: 'modified', binary: false, truncated: false,
      lines: [{ kind: 'added', content: 'new' }, { kind: 'deleted', content: 'old' }] },
    { path: 'other.ts', status: 'modified', binary: false, truncated: false,
      lines: [{ kind: 'added', content: 'unrelated' }] },
  ],
};
const nativeMessage: Message = { id: 'native', role: 'assistant', createdAt: 1,
  text: encodeToolPatch({ id: 'edit', name: 'Edit', status: 'done', fileChanges: [
    { path: 'src/a.ts', added: 5, deleted: 3 },
  ] }) };

describe('session file summaries', () => {
  it('keeps native edits instead of adding unrelated diff files', () => {
    const result = collectTurnFileChanges([nativeMessage], snapshot, snapshot.rootPath)!;
    expect(result.source).toBe('agent');
    expect(result.files).toEqual([{ path: 'src/a.ts', added: 5, deleted: 3 }]);
  });

  it('includes the saved per-turn Bash fallback alongside native edits', () => {
    const bashMessage: Message = { id: 'shell', role: 'assistant', createdAt: 3,
      text: encodeToolPatch({ id: 'bash', name: 'Bash', status: 'done',
        args: { command: 'modify file' } }) };
    const shellSnapshot = { ...snapshot, files: [snapshot.files[1]] };
    bashMessage.fileChanges = collectTurnFileChanges([bashMessage], shellSnapshot, snapshot.rootPath);
    const messages: Message[] = [
      { id: 'u1', role: 'user', text: 'edit', createdAt: 0 }, nativeMessage,
      { id: 'u2', role: 'user', text: 'shell', createdAt: 2 }, bashMessage,
    ];
    const summary = collectSessionFileChanges(messages, snapshot.rootPath)!;
    const sidebar = collectSessionEditedFiles(messages, snapshot.rootPath);
    expect(summary.files.map((file) => file.path)).toEqual([
      'F:/Client/Game/src/a.ts', 'F:/Client/Game/other.ts',
    ]);
    expect(sidebar.map((file) => file.path)).toEqual(summary.files.map((file) => file.path));
    expect(summary.files[1]).toMatchObject({ added: 1, deleted: 0 });
  });
});
