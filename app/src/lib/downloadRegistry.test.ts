import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetAssetsForTest,
  clearFinishedAssets,
  getAssets,
  markAssetDone,
  markAssetFailed,
  markDownloadDone,
  markDownloadFailed,
  registerAsset,
  removeAsset,
  startDownload,
  subscribeAssets,
  trackAsset,
  trackDownload,
} from './downloadRegistry';

afterEach(() => {
  __resetAssetsForTest();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('asset registry', () => {
  it('registers a pending entry, newest first', () => {
    registerAsset({ kind: 'mesh', source: 'downloaded', title: 'a.glb' });
    registerAsset({ kind: 'image', source: 'generated', title: 'b.png' });
    const list = getAssets();
    expect(list).toHaveLength(2);
    expect(list[0].title).toBe('b.png');
    expect(list[0].status).toBe('pending');
  });

  it('derives a title from a remote url when none is given', () => {
    registerAsset({
      kind: 'mesh',
      source: 'downloaded',
      remoteUrl: 'https://cdn.test/models/chest.glb?token=1',
    });
    expect(getAssets()[0].title).toBe('chest.glb');
  });

  it('infers origin: remote when a url is present, local otherwise', () => {
    registerAsset({ kind: 'image', source: 'generated', title: 'local.png' });
    registerAsset({
      kind: 'mesh',
      source: 'downloaded',
      remoteUrl: 'https://cdn.test/x.glb',
    });
    const [remote, local] = getAssets();
    expect(remote.origin).toBe('remote');
    expect(local.origin).toBe('local');
  });

  it('records a finished asset in one shot via terminal status', () => {
    registerAsset({
      kind: 'skill',
      source: 'installed',
      title: 'my-skill',
      status: 'success',
      localPath: '/skills/my-skill',
    });
    const entry = getAssets()[0];
    expect(entry.status).toBe('success');
    expect(entry.finishedAt).toBeGreaterThan(0);
  });

  it('marks a pending asset done with path, preview and size', () => {
    const id = registerAsset({ kind: 'image', source: 'generated' });
    markAssetDone(id, {
      localPath: '/ws/x.png',
      previewUrl: 'data:image/png;base64,AA',
      sizeBytes: 2048,
    });
    const entry = getAssets()[0];
    expect(entry.status).toBe('success');
    expect(entry.localPath).toBe('/ws/x.png');
    expect(entry.previewUrl).toBe('data:image/png;base64,AA');
    expect(entry.sizeBytes).toBe(2048);
  });

  it('marks an asset failed with an error message', () => {
    const id = registerAsset({ kind: 'image', source: 'generated' });
    markAssetFailed(id, 'network down');
    const entry = getAssets()[0];
    expect(entry.status).toBe('error');
    expect(entry.error).toBe('network down');
  });

  it('notifies subscribers on change', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeAssets(listener);
    const id = registerAsset({ kind: 'image', source: 'generated' });
    markAssetDone(id);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    registerAsset({ kind: 'image', source: 'generated' });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('removes a single entry and clears finished ones', () => {
    const a = registerAsset({ kind: 'mesh', source: 'downloaded' });
    const b = registerAsset({ kind: 'mesh', source: 'downloaded' });
    markAssetDone(a);
    removeAsset(b);
    expect(getAssets()).toHaveLength(1);
    clearFinishedAssets();
    expect(getAssets()).toHaveLength(0);
  });

  it('keeps pending entries when clearing finished', () => {
    const a = registerAsset({ kind: 'mesh', source: 'downloaded', title: 'a.glb' });
    registerAsset({ kind: 'mesh', source: 'downloaded', title: 'b.glb' });
    markAssetDone(a);
    clearFinishedAssets();
    const list = getAssets();
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe('b.glb');
    expect(list[0].status).toBe('pending');
  });

  it('persists terminal entries to localStorage', () => {
    const id = registerAsset({ kind: 'image', source: 'generated', title: 'a.png' });
    markAssetDone(id, { localPath: '/ws/a.png' });
    const raw = window.localStorage.getItem('freeultracode.assets.v1');
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw as string) as Array<{ title: string }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0].title).toBe('a.png');
  });

  it('does not persist pending entries', () => {
    registerAsset({ kind: 'image', source: 'generated', title: 'a.png' });
    const raw = window.localStorage.getItem('freeultracode.assets.v1');
    const parsed = raw ? (JSON.parse(raw) as unknown[]) : [];
    expect(parsed).toHaveLength(0);
  });

  it('migrates legacy downloads.v1 history into assets.v1', () => {
    window.localStorage.setItem(
      'freeultracode.downloads.v1',
      JSON.stringify([
        {
          id: 'dl-1',
          fileName: 'old.glb',
          kind: 'model',
          status: 'success',
          path: '/ws/old.glb',
          startedAt: 1,
          finishedAt: 2,
        },
      ]),
    );
    const list = getAssets();
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe('old.glb');
    expect(list[0].kind).toBe('mesh');
    expect(list[0].source).toBe('downloaded');
    expect(list[0].localPath).toBe('/ws/old.glb');
    // Legacy key is consumed after migration.
    expect(window.localStorage.getItem('freeultracode.downloads.v1')).toBeNull();
    expect(window.localStorage.getItem('freeultracode.assets.v1')).toBeTruthy();
  });

  describe('trackAsset', () => {
    it('marks success and returns the resolved value', async () => {
      const result = await trackAsset(
        { kind: 'mesh', source: 'downloaded', title: 'a.glb' },
        async () => ({ localPath: '/ws/a.glb', sizeBytes: 10 }),
        (value) => value,
      );
      expect(result.localPath).toBe('/ws/a.glb');
      const entry = getAssets()[0];
      expect(entry.status).toBe('success');
      expect(entry.localPath).toBe('/ws/a.glb');
    });

    it('marks failure and rethrows', async () => {
      await expect(
        trackAsset({ kind: 'mesh', source: 'downloaded', title: 'a.glb' }, async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect(getAssets()[0].status).toBe('error');
    });
  });

  describe('legacy download wrappers', () => {
    it('startDownload maps onto a downloaded asset', () => {
      const id = startDownload({ fileName: 'x.glb', kind: 'model' });
      markDownloadDone(id, { path: '/ws/x.glb', sizeBytes: 2048 });
      const entry = getAssets()[0];
      expect(entry.kind).toBe('mesh');
      expect(entry.source).toBe('downloaded');
      expect(entry.title).toBe('x.glb');
      expect(entry.localPath).toBe('/ws/x.glb');
      expect(entry.status).toBe('success');
    });

    it('markDownloadFailed maps onto a failed asset', () => {
      const id = startDownload({ fileName: 'x.glb' });
      markDownloadFailed(id, 'network down');
      const entry = getAssets()[0];
      expect(entry.status).toBe('error');
      expect(entry.error).toBe('network down');
    });

    it('trackDownload still works end to end', async () => {
      const value = await trackDownload(
        { fileName: 'a.glb' },
        async () => ({ path: '/ws/a.glb', sizeBytes: 10 }),
        (v) => v,
      );
      expect(value.path).toBe('/ws/a.glb');
      expect(getAssets()[0].status).toBe('success');
    });
  });
});
