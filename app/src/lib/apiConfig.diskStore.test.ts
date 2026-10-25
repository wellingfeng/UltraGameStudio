import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Simulated durable disk + OS keychain backing the Tauri commands.
const disk = new Map<string, string>();
const keychain = new Map<string, string>();

vi.mock('@/lib/tauri', () => ({
  isTauri: () => true,
  tauriAvailable: () => true,
  secureSecretGetMany: async (keys: string[]) => {
    const out: Record<string, string> = {};
    for (const k of keys) {
      const v = keychain.get(k);
      if (v) out[k] = v;
    }
    return out;
  },
  secureSecretSet: async (k: string, v: string) => {
    keychain.set(k, v);
  },
  secureSecretDelete: async (k: string) => {
    keychain.delete(k);
  },
}));

// A single, stable invoke implementation so concurrent write-behind calls never
// race on a half-initialized module namespace.
const invoke = vi.fn(async (cmd: string, args: Record<string, unknown>) => {
  if (cmd === 'history_read_json') return disk.get(args.relPath as string) ?? null;
  if (cmd === 'history_write_json') {
    disk.set(args.relPath as string, args.json as string);
    return undefined;
  }
  return null;
});
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

async function flushWrites() {
  // Drain the per-key write-behind promise chain, which awaits a dynamic import
  // of the Tauri invoke binding before each disk write.
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

describe('apiConfig disk-backed provider store (Tauri)', () => {
  beforeEach(async () => {
    window.localStorage.clear();
    disk.clear();
    keychain.clear();
    const secure = await import('@/lib/secureStorage');
    const api = await import('@/lib/apiConfig');
    secure.resetSecureStorageForTests();
    api.resetApiConfigStoreForTests();
    await secure.initializeSecureStorage();
    await api.initializeApiConfigStore();
  });

  afterEach(() => {
    window.localStorage.clear();
    disk.clear();
    keychain.clear();
  });

  it('persists a new channel to disk even when localStorage is full', async () => {
    const api = await import('@/lib/apiConfig');
    const created = api.addProvider({
      kind: 'anthropic',
      name: 'linxi',
      apiKey: 'sk-secret',
      baseUrl: 'https://k48.shenggainbang.cn',
      transport: 'direct',
    });
    expect(api.listProviders().some((p) => p.id === created.id)).toBe(true);
    await flushWrites();

    const stored = disk.get('settings/providers.v1.json');
    expect(stored).toBeTruthy();
    expect(JSON.parse(stored!)).toEqual([
      expect.objectContaining({ id: created.id, name: 'linxi' }),
    ]);
  });

  it('reloads providers from disk after a fresh boot (localStorage cleared)', async () => {
    const secure = await import('@/lib/secureStorage');
    const api = await import('@/lib/apiConfig');
    api.addProvider({
      kind: 'anthropic',
      name: 'linxi',
      apiKey: 'sk-secret',
      baseUrl: 'https://k48.shenggainbang.cn',
      transport: 'direct',
    });
    await flushWrites();

    // Reboot: drop the localStorage mirror + in-memory caches, re-hydrate.
    window.localStorage.clear();
    secure.resetSecureStorageForTests();
    api.resetApiConfigStoreForTests();
    await secure.initializeSecureStorage();
    await api.initializeApiConfigStore();

    const reloaded = api.listProviders();
    expect(reloaded.length).toBe(1);
    expect(reloaded[0].name).toBe('linxi');
    expect(reloaded[0].apiKey).toBe('sk-secret');
  });

  it('keeps an edited key on restart when an older quit fallback survives in localStorage', async () => {
    const secure = await import('@/lib/secureStorage');
    const api = await import('@/lib/apiConfig');
    const provider = api.addProvider({
      kind: 'codex', name: 'KuroCodeX', apiKey: 'old-key',
      baseUrl: 'https://example.test/v1', transport: 'cli',
    });
    await secure.flushSecureStorage();
    await api.flushApiConfigDiskWrites();
    secure.flushSecretsToLocalStorageFallback();

    // WebView's mirror can stay stale (quota/write failure or another instance's
    // beforeunload). The durable keychain write nevertheless succeeds.
    const mirrorWrite = vi.spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => { throw new DOMException('Quota exceeded', 'QuotaExceededError'); });
    try {
      api.updateProvider(provider.id, { apiKey: 'new-key' });
      await secure.flushSecureStorage();
      await api.flushApiConfigDiskWrites();
      secure.flushSecretsToLocalStorageFallback();
    } finally {
      mirrorWrite.mockRestore();
    }
    expect(JSON.parse(keychain.get(secure.PROVIDER_API_KEYS_SECRET)!)[provider.id]).toBe('new-key');

    secure.resetSecureStorageForTests();
    api.resetApiConfigStoreForTests();
    await secure.initializeSecureStorage();
    await api.initializeApiConfigStore();
    expect(api.listProviders().find((p) => p.id === provider.id)?.apiKey).toBe('new-key');
    expect(secure.readSecureRecord(secure.GATEWAY_CHANNEL_API_KEYS_SECRET)[
      secure.gatewayChannelSecretKey(provider.id, 'default')
    ]).toBe('new-key');
    expect(JSON.parse(window.localStorage.getItem('ugs_providers')!)[0].apiKey).toBeUndefined();
  });

  it('still migrates a legacy inline key when the keychain has no saved key', async () => {
    const secure = await import('@/lib/secureStorage');
    const api = await import('@/lib/apiConfig');
    window.localStorage.setItem('ugs_providers', JSON.stringify([{
      id: 'legacy-provider', kind: 'codex', name: 'Legacy',
      apiKey: 'legacy-key', baseUrl: 'https://example.test/v1', transport: 'cli',
    }]));
    secure.resetSecureStorageForTests();
    api.resetApiConfigStoreForTests();
    await secure.initializeSecureStorage();
    await api.initializeApiConfigStore();
    expect(api.listProviders()[0].apiKey).toBe('legacy-key');
    expect(secure.readSecureRecord(secure.PROVIDER_API_KEYS_SECRET)['legacy-provider']).toBe('legacy-key');
  });
});
