import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MESH_LIBRARY_SETTINGS,
  MESH_LIBRARIES,
  loadMeshLibrarySettings,
  looksLikeMeshSearchRequest,
  meshLibraryReady,
  meshLibraryUsability,
  meshLibraryUsable,
  meshLibrarySearchUrl,
  meshLibraryById,
  normalizeMeshLibrarySettings,
  saveMeshLibrarySettings,
  searchMeshLibraries,
  stripMeshSearchCommand,
} from './meshLibrary';

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('mesh-search command parsing', () => {
  it('detects /mesh-search variants', () => {
    expect(looksLikeMeshSearchRequest('/mesh-search 宝箱')).toBe(true);
    expect(looksLikeMeshSearchRequest('/搜索模型 chest')).toBe(true);
    expect(looksLikeMeshSearchRequest('修复类型错误')).toBe(false);
  });

  it('strips the command prefix', () => {
    expect(stripMeshSearchCommand('/mesh-search low poly chest')).toBe('low poly chest');
    expect(stripMeshSearchCommand('/找模型 龙')).toBe('龙');
  });
});

describe('mesh library settings', () => {
  it('normalizes unknown ids and clamps the limit', () => {
    const normalized = normalizeMeshLibrarySettings({
      enabledIds: ['polyhaven', 'nope'],
      apiKeys: { 'poly-pizza': '  key  ', bogus: 'x' },
      perLibraryLimit: 999,
      autoDownload: false,
    });
    expect(normalized.enabledIds).toEqual(['polyhaven']);
    expect(normalized.apiKeys).toEqual({ 'poly-pizza': 'key' });
    expect(normalized.perLibraryLimit).toBe(24);
    expect(normalized.autoDownload).toBe(false);
  });

  it('round-trips through localStorage', () => {
    saveMeshLibrarySettings({
      ...DEFAULT_MESH_LIBRARY_SETTINGS,
      enabledIds: ['sketchfab'],
      apiKeys: { sketchfab: 'token' },
    });
    const loaded = loadMeshLibrarySettings();
    expect(loaded.enabledIds).toEqual(['sketchfab']);
    expect(loaded.apiKeys.sketchfab).toBe('token');
  });

  it('reports readiness based on required keys', () => {
    expect(meshLibraryReady('polyhaven', DEFAULT_MESH_LIBRARY_SETTINGS)).toBe(true);
    expect(meshLibraryReady('poly-pizza', DEFAULT_MESH_LIBRARY_SETTINGS)).toBe(false);
    expect(
      meshLibraryReady('poly-pizza', {
        ...DEFAULT_MESH_LIBRARY_SETTINGS,
        apiKeys: { 'poly-pizza': 'k' },
      }),
    ).toBe(true);
  });

  it('classifies usability for the 已启用 tab', () => {
    // public-api: usable with no key.
    expect(meshLibraryUsability('polyhaven', DEFAULT_MESH_LIBRARY_SETTINGS)).toBe('usable');
    expect(meshLibraryUsable('polyhaven', DEFAULT_MESH_LIBRARY_SETTINGS)).toBe(true);
    // api-key without key: not usable yet.
    expect(meshLibraryUsability('poly-pizza', DEFAULT_MESH_LIBRARY_SETTINGS)).toBe('needs-key');
    expect(meshLibraryUsable('poly-pizza', DEFAULT_MESH_LIBRARY_SETTINGS)).toBe(false);
    // api-key with key: usable.
    const withKey = { ...DEFAULT_MESH_LIBRARY_SETTINGS, apiKeys: { 'poly-pizza': 'k' } };
    expect(meshLibraryUsability('poly-pizza', withKey)).toBe('usable');
    expect(meshLibraryUsable('poly-pizza', withKey)).toBe(true);
    // sketchfab searches without a key, so it is usable out of the box.
    expect(meshLibraryUsability('sketchfab', DEFAULT_MESH_LIBRARY_SETTINGS)).toBe('usable');
    // link-out libraries can only deep-link, never count as usable.
    expect(meshLibraryUsability('fab', DEFAULT_MESH_LIBRARY_SETTINGS)).toBe('link-only');
    expect(meshLibraryUsable('fab', DEFAULT_MESH_LIBRARY_SETTINGS)).toBe(false);
  });

  it('builds deep-link search urls', () => {
    const fab = meshLibraryById('fab')!;
    expect(meshLibrarySearchUrl(fab, 'low poly chest')).toBe(
      'https://www.fab.com/search?q=low%20poly%20chest',
    );
  });

  it('every library has a usable search url template', () => {
    for (const library of MESH_LIBRARIES) {
      // Most templates interpolate the query; a few browse-only libraries
      // (e.g. Quaternius) deep-link to a static catalog page instead.
      expect(library.searchUrlTemplate).toMatch(/^https?:\/\//);
    }
  });
});

describe('searchMeshLibraries', () => {
  it('returns empty for blank query without network calls', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const result = await searchMeshLibraries('   ', DEFAULT_MESH_LIBRARY_SETTINGS);
    expect(result.items).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('produces link-outs for marketplace libraries and api results for public ones', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('api.polyhaven.com')) {
        return new Response(
          JSON.stringify({
            chest_a: { name: 'Treasure Chest', categories: ['props'], authors: { Jane: 'a' } },
            sofa: { name: 'Sofa', categories: ['furniture'] },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error('unexpected fetch');
    });

    const result = await searchMeshLibraries('chest', {
      ...DEFAULT_MESH_LIBRARY_SETTINGS,
      enabledIds: ['polyhaven', 'fab'],
    });
    expect(result.items.some((item) => item.title === 'Treasure Chest')).toBe(true);
    expect(result.items.some((item) => item.title === 'Sofa')).toBe(false);
    expect(result.linkOuts.some((link) => link.libraryId === 'fab')).toBe(true);
  });

  it('captures per-library errors as link-out fallbacks', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('boom'));
    const result = await searchMeshLibraries('dragon', {
      ...DEFAULT_MESH_LIBRARY_SETTINGS,
      enabledIds: ['polyhaven'],
    });
    expect(result.errors).toHaveLength(1);
    expect(result.linkOuts.some((link) => link.libraryId === 'polyhaven')).toBe(true);
  });
});

