import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ensureWorkspaceChangesBaseline,
  listWorkspaceChanges,
  readWorkspaceChangesCache,
  type WorkspaceChanges,
} from './tauri';
import {
  SESSION_CHANGES_UPDATED_EVENT,
  refreshCachedSessionChanges,
  sessionChangesCacheKey,
} from './sessionChanges';

vi.mock('./tauri', () => ({
  ensureWorkspaceChangesBaseline: vi.fn(),
  listWorkspaceChanges: vi.fn(),
  readWorkspaceChangesCache: vi.fn(),
}));

const mockedEnsureWorkspaceChangesBaseline = vi.mocked(ensureWorkspaceChangesBaseline);
const mockedListWorkspaceChanges = vi.mocked(listWorkspaceChanges);
const mockedReadWorkspaceChangesCache = vi.mocked(readWorkspaceChangesCache);

beforeEach(() => {
  mockedEnsureWorkspaceChangesBaseline.mockReset();
  mockedListWorkspaceChanges.mockReset();
  mockedReadWorkspaceChangesCache.mockReset();
  window.localStorage.clear();
});

describe('sessionChangesCacheKey', () => {
  it('includes the cache algorithm version', () => {
    expect(sessionChangesCacheKey('ws1', 's1', 'E:\\MoonEngine')?.startsWith('v5:')).toBe(true);
  });

  it('scopes cache entries by root path', () => {
    expect(sessionChangesCacheKey('ws1', 's1', 'E:\\OpenWorkflows')).not.toBe(
      sessionChangesCacheKey('ws1', 's1', 'E:\\MoonEngine'),
    );
  });

  it('normalizes slashes and trailing separators', () => {
    expect(sessionChangesCacheKey('ws1', 's1', 'E:\\MoonEngine\\')).toBe(
      sessionChangesCacheKey('ws1', 's1', 'E:/MoonEngine'),
    );
  });
});

describe('refreshCachedSessionChanges', () => {
  it('does not block VCS refresh on filesystem baseline creation', async () => {
    const snapshot: WorkspaceChanges = {
      rootPath: 'E:/MoonEngine',
      generatedAtMs: 1,
      source: 'p4',
      files: [],
      truncated: false,
    };
    mockedListWorkspaceChanges.mockResolvedValue(snapshot);

    await expect(
      refreshCachedSessionChanges('E:\\MoonEngine', 'cache-key'),
    ).resolves.toBe(snapshot);

    expect(mockedEnsureWorkspaceChangesBaseline).not.toHaveBeenCalled();
    expect(mockedListWorkspaceChanges).toHaveBeenCalledWith(
      'E:\\MoonEngine',
      'cache-key',
      undefined,
    );
  });

  it('notifies same-window readers after writing the refreshed cache', async () => {
    const snapshot: WorkspaceChanges = {
      rootPath: 'E:/MoonEngine',
      generatedAtMs: 2,
      source: 'git',
      files: [],
      truncated: false,
    };
    mockedListWorkspaceChanges.mockResolvedValue(snapshot);
    const events: Array<{ cacheKey: string; rootPath: string }> = [];
    const listener = (event: Event) => {
      events.push((event as CustomEvent).detail);
    };
    window.addEventListener(SESSION_CHANGES_UPDATED_EVENT, listener);

    try {
      await refreshCachedSessionChanges('E:\\MoonEngine', 'cache-key');
    } finally {
      window.removeEventListener(SESSION_CHANGES_UPDATED_EVENT, listener);
    }

    expect(events).toEqual([{ cacheKey: 'cache-key', rootPath: 'E:/MoonEngine' }]);
  });
});
