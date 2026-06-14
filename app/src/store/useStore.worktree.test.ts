import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tauriMocks = vi.hoisted(() => ({
  isTauri: vi.fn(() => true),
  tauriAvailable: vi.fn(() => true),
  prepareIsolatedWorkspace: vi.fn(),
}));

vi.mock('@/lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tauri')>(
    '@/lib/tauri',
  );
  return {
    ...actual,
    isTauri: tauriMocks.isTauri,
    tauriAvailable: tauriMocks.tauriAvailable,
    prepareIsolatedWorkspace: tauriMocks.prepareIsolatedWorkspace,
  };
});

import { useStore } from './useStore';
import { defaultComposer } from './sampleSessions';
import type { Message } from './types';

function setComposerState(patch: Partial<typeof defaultComposer>): void {
  useStore.setState({
    composer: { ...defaultComposer, ...patch },
    messages: [],
    activeSessionId: 's-test',
    activeWorkspaceId: null,
    composerBySession: {},
  });
}

describe('ensureSessionStartupWorkspace', () => {
  beforeEach(() => {
    tauriMocks.isTauri.mockReturnValue(true);
    tauriMocks.tauriAvailable.mockReturnValue(true);
    tauriMocks.prepareIsolatedWorkspace.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('no-ops in local startup mode', async () => {
    setComposerState({ startupMode: 'local', workspace: 'E:/repo' });
    await useStore.getState().ensureSessionStartupWorkspace();
    expect(tauriMocks.prepareIsolatedWorkspace).not.toHaveBeenCalled();
    expect(useStore.getState().composer.workspace).toBe('E:/repo');
  });

  it('prepares an isolated workspace and repoints cwd in worktree mode', async () => {
    setComposerState({ startupMode: 'worktree', workspace: 'E:/repo' });
    tauriMocks.prepareIsolatedWorkspace.mockResolvedValue({
      path: 'E:/repo/.worktree/s-test',
      kind: 'worktree',
      branch: 'ow/session-s-test',
    });
    await useStore.getState().ensureSessionStartupWorkspace();
    expect(tauriMocks.prepareIsolatedWorkspace).toHaveBeenCalledWith(
      'E:/repo',
      's-test',
    );
    expect(useStore.getState().composer.workspace).toBe(
      'E:/repo/.worktree/s-test',
    );
  });

  it('does not repoint once the conversation has started', async () => {
    setComposerState({ startupMode: 'worktree', workspace: 'E:/repo' });
    useStore.setState({
      messages: [
        {
          id: 'm1',
          role: 'user',
          text: 'hi',
          createdAt: Date.now(),
        } satisfies Message,
      ],
    });
    await useStore.getState().ensureSessionStartupWorkspace();
    expect(tauriMocks.prepareIsolatedWorkspace).not.toHaveBeenCalled();
    expect(useStore.getState().composer.workspace).toBe('E:/repo');
  });

  it('falls back to the original workspace on backend failure', async () => {
    setComposerState({ startupMode: 'worktree', workspace: 'E:/repo' });
    tauriMocks.prepareIsolatedWorkspace.mockRejectedValue(
      new Error('git failed'),
    );
    await useStore.getState().ensureSessionStartupWorkspace();
    expect(useStore.getState().composer.workspace).toBe('E:/repo');
  });

  it('no-ops when running on web (no backend)', async () => {
    tauriMocks.isTauri.mockReturnValue(false);
    setComposerState({ startupMode: 'worktree', workspace: 'E:/repo' });
    await useStore.getState().ensureSessionStartupWorkspace();
    expect(tauriMocks.prepareIsolatedWorkspace).not.toHaveBeenCalled();
  });
});
