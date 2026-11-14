import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CliVersionStatus } from '@/lib/tauri';

vi.mock('@/lib/tauri', () => ({
  isTauri: () => true,
  checkCliUpdates: vi.fn(),
  updateCli: vi.fn(),
}));

import { checkCliUpdates, updateCli } from '@/lib/tauri';
import {
  getCliUpdateSnapshot,
  markCliUpdatesSeen,
  refreshCliUpdateStatus,
  startCliUpdate,
} from './cliUpdateStatus';

const mockCheckCliUpdates = vi.mocked(checkCliUpdates);
const mockUpdateCli = vi.mocked(updateCli);

function statusFixture(
  overrides: Partial<CliVersionStatus> = {},
): CliVersionStatus {
  return {
    adapter: 'claude-code',
    label: 'Claude Code',
    executablePath: 'C:/claude.exe',
    installedVersion: '2.1.197',
    latestVersion: '2.1.202',
    updateAvailable: true,
    checkedAtMs: Date.now(),
    ...overrides,
  };
}

afterEach(() => {
  window.localStorage.clear();
  mockCheckCliUpdates.mockReset();
  mockUpdateCli.mockReset();
});

describe('cliUpdateStatus red-dot badge', () => {
  it('reports hasUnseenUpdate when a CLI has a pending update', async () => {
    mockCheckCliUpdates.mockResolvedValue([statusFixture()]);

    const snapshot = await refreshCliUpdateStatus();

    expect(snapshot.hasUnseenUpdate).toBe(true);
    expect(getCliUpdateSnapshot().hasUnseenUpdate).toBe(true);
  });

  it('clears the badge once the update has been marked as seen', async () => {
    mockCheckCliUpdates.mockResolvedValue([statusFixture()]);
    await refreshCliUpdateStatus();
    expect(getCliUpdateSnapshot().hasUnseenUpdate).toBe(true);

    markCliUpdatesSeen(getCliUpdateSnapshot().statuses);

    expect(getCliUpdateSnapshot().hasUnseenUpdate).toBe(false);
  });

  it('re-shows the badge when an even newer version appears after being dismissed', async () => {
    mockCheckCliUpdates.mockResolvedValue([statusFixture({ latestVersion: '2.1.202' })]);
    await refreshCliUpdateStatus();
    markCliUpdatesSeen(getCliUpdateSnapshot().statuses);
    expect(getCliUpdateSnapshot().hasUnseenUpdate).toBe(false);

    mockCheckCliUpdates.mockResolvedValue([
      statusFixture({ installedVersion: '2.1.197', latestVersion: '2.1.210' }),
    ]);
    const snapshot = await refreshCliUpdateStatus();

    expect(snapshot.hasUnseenUpdate).toBe(true);
  });

  it('does not flag the badge when every CLI is already up to date', async () => {
    mockCheckCliUpdates.mockResolvedValue([
      statusFixture({ updateAvailable: false, latestVersion: '2.1.197' }),
    ]);

    const snapshot = await refreshCliUpdateStatus();

    expect(snapshot.hasUnseenUpdate).toBe(false);
  });
});

describe('CLI update queue', () => {
  it('keeps later clicks queued until the backend actually starts each update', async () => {
    const jobs = new Map<string, { start: () => void; resolve: (value: string) => void }>();
    mockCheckCliUpdates.mockResolvedValue([]);
    mockUpdateCli.mockImplementation((adapter, onStarted) => new Promise((resolve) => {
      jobs.set(adapter, { start: () => onStarted?.(), resolve });
    }));

    const first = startCliUpdate('claude-code');
    const second = startCliUpdate('codex');
    expect(startCliUpdate('codex')).toBe(second);
    expect(mockUpdateCli).toHaveBeenCalledTimes(2);
    expect(getCliUpdateSnapshot().queuedAdapters).toEqual(['claude-code', 'codex']);
    expect(getCliUpdateSnapshot().updatingAdapters).toEqual([]);

    jobs.get('claude-code')!.start();
    expect(getCliUpdateSnapshot().updatingAdapters).toEqual(['claude-code']);
    expect(getCliUpdateSnapshot().queuedAdapters).toEqual(['codex']);
    jobs.get('claude-code')!.resolve('first complete');
    expect(await first).toEqual({ ok: true, detail: 'first complete' });
    expect(getCliUpdateSnapshot().queuedAdapters).toEqual(['codex']);

    jobs.get('codex')!.start();
    expect(getCliUpdateSnapshot().updatingAdapters).toEqual(['codex']);
    expect(getCliUpdateSnapshot().queuedAdapters).toEqual([]);
    jobs.get('codex')!.resolve('second complete');
    expect(await second).toEqual({ ok: true, detail: 'second complete' });
    expect(getCliUpdateSnapshot().updatingAdapters).toEqual([]);
  });

  it('checks again if a queued update finishes while an older check is in flight', async () => {
    const jobs = new Map<string, { start: () => void; resolve: (value: string) => void }>();
    let finishOldCheck!: (value: CliVersionStatus[]) => void;
    mockCheckCliUpdates
      .mockImplementationOnce(() => new Promise((resolve) => { finishOldCheck = resolve; }))
      .mockResolvedValueOnce([statusFixture({ installedVersion: '2.1.202', updateAvailable: false })]);
    mockUpdateCli.mockImplementation((adapter, onStarted) => new Promise((resolve) => {
      jobs.set(adapter, { start: () => onStarted?.(), resolve });
    }));

    const first = startCliUpdate('claude-code');
    const second = startCliUpdate('codex');
    jobs.get('claude-code')!.start();
    jobs.get('claude-code')!.resolve('first complete');
    await Promise.resolve();
    expect(mockCheckCliUpdates).toHaveBeenCalledTimes(1);
    jobs.get('codex')!.start();
    jobs.get('codex')!.resolve('second complete');
    await Promise.resolve();
    finishOldCheck([statusFixture()]);
    await Promise.all([first, second]);
    expect(mockCheckCliUpdates).toHaveBeenCalledTimes(2);
    expect(getCliUpdateSnapshot().statuses[0].updateAvailable).toBe(false);
  });

  it('keeps later queued jobs and individual errors when an update fails', async () => {
    const jobs = new Map<string, { start: () => void; resolve: (value: string) => void; reject: (reason: string) => void }>();
    mockCheckCliUpdates.mockResolvedValue([]);
    mockUpdateCli.mockImplementation((adapter, onStarted) => new Promise((resolve, reject) => {
      jobs.set(adapter, { start: () => onStarted?.(), resolve, reject });
    }));

    const first = startCliUpdate('claude-code');
    const second = startCliUpdate('codex');
    jobs.get('claude-code')!.start();
    jobs.get('claude-code')!.reject('安装失败');
    expect(await first).toEqual({ ok: false, detail: '安装失败' });
    expect(getCliUpdateSnapshot().updateMessages['claude-code'].detail).toBe('安装失败');
    expect(getCliUpdateSnapshot().queuedAdapters).toEqual(['codex']);
    jobs.get('codex')!.start();
    jobs.get('codex')!.resolve('second complete');
    expect(await second).toEqual({ ok: true, detail: 'second complete' });
    expect(getCliUpdateSnapshot().updateMessages['claude-code'].detail).toBe('安装失败');
  });
});
