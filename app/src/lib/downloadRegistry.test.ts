import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetAssetsForTest,
  clearFinishedAssets,
  getAssets,
  linkKnownManagedAssetsFromMessageText,
  linkLocalAssetToMessage,
  linkManagedAssetsFromMessageText,
  managedAssetPathsFromText,
  markAssetDone,
  markAssetFailed,
  markDownloadDone,
  markDownloadFailed,
  mergeCachedAssetsFromDisk,
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

  it('keeps conversation jump metadata on entries', () => {
    registerAsset({
      kind: 'image',
      source: 'generated',
      title: 'frame.png',
      sessionId: 's_1',
      workspaceId: 'w_1',
      messageId: 'm_1',
    });
    const entry = getAssets()[0];
    expect(entry.sessionId).toBe('s_1');
    expect(entry.workspaceId).toBe('w_1');
    expect(entry.messageId).toBe('m_1');
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

  it('drops oversized inline previews on persist but keeps them in memory', () => {
    // A multi-MB base64 data URL would blow the localStorage quota and make the
    // whole history fail to persist; it must be stripped on persist while a
    // disk-backed localPath remains so it can be rebuilt on reload.
    const bigPreview = `data:image/png;base64,${'A'.repeat(200_000)}`;
    const id = registerAsset({
      kind: 'image',
      source: 'generated',
      title: 'big.png',
      previewUrl: bigPreview,
    });
    markAssetDone(id, { localPath: '/ws/big.png' });

    // In-memory copy keeps the inline preview for the current session.
    expect(getAssets()[0].previewUrl).toBe(bigPreview);

    // Persisted copy drops it but retains the localPath to rebuild from.
    const raw = window.localStorage.getItem('freeultracode.assets.v1');
    const parsed = JSON.parse(raw as string) as Array<{
      previewUrl?: string;
      localPath?: string;
    }>;
    expect(parsed[0].previewUrl).toBeUndefined();
    expect(parsed[0].localPath).toBe('/ws/big.png');
  });

  it('keeps small inline previews when persisting', () => {
    const smallPreview = 'data:image/png;base64,AAAA';
    const id = registerAsset({
      kind: 'image',
      source: 'generated',
      title: 'small.png',
      previewUrl: smallPreview,
    });
    markAssetDone(id, { localPath: '/ws/small.png' });
    const raw = window.localStorage.getItem('freeultracode.assets.v1');
    const parsed = JSON.parse(raw as string) as Array<{ previewUrl?: string }>;
    expect(parsed[0].previewUrl).toBe(smallPreview);
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

  it('hydrates persisted entries newest first by terminal time', () => {
    window.localStorage.setItem(
      'freeultracode.assets.v1',
      JSON.stringify([
        {
          id: 'old',
          title: 'old.png',
          kind: 'image',
          source: 'generated',
          origin: 'local',
          status: 'success',
          startedAt: 100,
          finishedAt: 200,
        },
        {
          id: 'new',
          title: 'new.png',
          kind: 'image',
          source: 'generated',
          origin: 'local',
          status: 'success',
          startedAt: 100,
          finishedAt: 300,
        },
      ]),
    );

    expect(getAssets().map((entry) => entry.title)).toEqual(['new.png', 'old.png']);
  });

  it('merges disk cached assets and sorts newest first', () => {
    mergeCachedAssetsFromDisk([
      {
        kind: 'image',
        source: 'generated',
        title: 'old.png',
        localPath: 'E:\\OpenWorkflows\\.freeultracode\\clipboard-images\\old.png',
        sizeBytes: 10,
        createdAtMs: 100,
        modifiedAtMs: 200,
      },
      {
        kind: 'image',
        source: 'generated',
        title: 'new.png',
        localPath: 'E:\\OpenWorkflows\\.freeultracode\\clipboard-images\\new.png',
        sizeBytes: 20,
        createdAtMs: 100,
        modifiedAtMs: 300,
      },
    ]);

    const list = getAssets();
    expect(list.map((entry) => entry.title)).toEqual(['new.png', 'old.png']);
    expect(list[0].status).toBe('success');
    expect(list[0].localPath).toMatch(/new\.png$/);
  });

  it('does not duplicate disk cached assets already in the registry', () => {
    const id = registerAsset({
      kind: 'image',
      source: 'generated',
      title: 'shot.png',
      status: 'success',
      localPath: 'E:\\OpenWorkflows\\.freeultracode\\clipboard-images\\shot.png',
      sizeBytes: 1,
    });
    markAssetDone(id);

    mergeCachedAssetsFromDisk([
      {
        kind: 'image',
        source: 'generated',
        title: 'shot.png',
        localPath: 'E:/OpenWorkflows/.freeultracode/clipboard-images/shot.png',
        sizeBytes: 2,
        createdAtMs: 100,
        modifiedAtMs: 300,
      },
    ]);

    const list = getAssets();
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe('shot.png');
    expect(list[0].sizeBytes).toBe(1);
  });

  it('extracts managed asset paths from message text', () => {
    const path =
      'E:\\OpenWorkflows\\.freeultracode\\clipboard-images\\pasted-1.png';
    expect(managedAssetPathsFromText(`看这个 ${path}`)).toEqual([path]);
  });

  it('stops managed asset paths at the file extension before prose punctuation', () => {
    const path =
      'E:\\OpenWorkflows\\.freeultracode\\clipboard-images\\pasted-1.png';
    const other =
      'E:\\OpenWorkflows\\.freeultracode\\clipboard-images\\pasted-2.png';
    expect(
      managedAssetPathsFromText(
        `看这个 ${path}，好像重复了；还有${other}, sprite模式应该能跳转`,
      ),
    ).toEqual([path, other]);
  });

  it('links an existing disk asset to its source message', () => {
    mergeCachedAssetsFromDisk([
      {
        kind: 'image',
        source: 'generated',
        title: 'shot.png',
        localPath: 'E:\\OpenWorkflows\\.freeultracode\\clipboard-images\\shot.png',
        sizeBytes: 2,
        createdAtMs: 100,
        modifiedAtMs: 300,
      },
    ]);

    linkLocalAssetToMessage({
      localPath: 'file:///E:/OpenWorkflows/.freeultracode/clipboard-images/shot.png',
      sessionId: 's_1',
      workspaceId: 'w_1',
      messageId: 'm_1',
    });

    const list = getAssets();
    expect(list).toHaveLength(1);
    expect(list[0].sessionId).toBe('s_1');
    expect(list[0].workspaceId).toBe('w_1');
    expect(list[0].messageId).toBe('m_1');
  });

  it('links a punctuated managed path to the existing disk asset instead of duplicating it', () => {
    const path =
      'E:\\OpenWorkflows\\.freeultracode\\clipboard-images\\shot.png';
    mergeCachedAssetsFromDisk([
      {
        kind: 'image',
        source: 'generated',
        title: 'shot.png',
        localPath: path,
        sizeBytes: 2,
        createdAtMs: 100,
        modifiedAtMs: 300,
      },
    ]);

    linkManagedAssetsFromMessageText({
      text: `${path}，这是 AI/MCP 生成的图`,
      sessionId: 's_2',
      workspaceId: 'w_2',
      messageId: 'm_2',
    });

    const list = getAssets();
    expect(list).toHaveLength(1);
    expect(list[0].localPath).toBe(path);
    expect(list[0].sessionId).toBe('s_2');
    expect(list[0].messageId).toBe('m_2');
  });

  it('registers managed asset paths from a message when disk scan has not run', () => {
    linkManagedAssetsFromMessageText({
      text: 'E:\\OpenWorkflows\\.freeultracode\\clipboard-images\\shot.png',
      sessionId: 's_2',
      workspaceId: 'w_2',
      messageId: 'm_2',
    });

    const entry = getAssets()[0];
    expect(entry.kind).toBe('image');
    expect(entry.status).toBe('success');
    expect(entry.sessionId).toBe('s_2');
    expect(entry.messageId).toBe('m_2');
  });

  it('links only known managed assets from history messages', () => {
    mergeCachedAssetsFromDisk([
      {
        kind: 'image',
        source: 'generated',
        title: 'known.png',
        localPath: 'E:\\OpenWorkflows\\.freeultracode\\clipboard-images\\known.png',
        sizeBytes: 2,
        createdAtMs: 100,
        modifiedAtMs: 300,
      },
    ]);

    linkKnownManagedAssetsFromMessageText({
      text: [
        'E:\\OpenWorkflows\\.freeultracode\\clipboard-images\\known.png',
        'E:\\OpenWorkflows\\.freeultracode\\clipboard-images\\missing.png',
      ].join('\n'),
      sessionId: 's_3',
      workspaceId: 'w_3',
      messageId: 'm_3',
    });

    const list = getAssets();
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe('known.png');
    expect(list[0].sessionId).toBe('s_3');
    expect(list[0].messageId).toBe('m_3');
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
