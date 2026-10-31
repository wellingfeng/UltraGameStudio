import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  secureSecretGetMany: vi.fn(async () => ({} as Record<string, string>)),
  secureSecretSet: vi.fn<(key: string, value: string) => Promise<void>>(),
  secureSecretDelete: vi.fn(async () => undefined),
}));

vi.mock('@/lib/tauri', () => ({
  isTauri: () => true,
  tauriAvailable: () => false,
  secureSecretGetMany: mocks.secureSecretGetMany,
  secureSecretSet: mocks.secureSecretSet,
  secureSecretDelete: mocks.secureSecretDelete,
}));

vi.mock('@/lib/settingsProfile', () => ({
  isRemoteProfileActive: () => false,
  readRemoteProfileRaw: () => null,
  writeRemoteProfileRaw: () => undefined,
}));

const PROVIDERS_KEY = 'ugs_providers';

function seedProviderList(ids: string[]): void {
  window.localStorage.setItem(
    PROVIDERS_KEY,
    JSON.stringify(
      ids.map((id) => ({
        id,
        kind: 'anthropic',
        name: id,
        baseUrl: 'https://example.test',
      })),
    ),
  );
}

function lastProvidersWrite(): Record<string, string> {
  const calls = mocks.secureSecretSet.mock.calls.filter(
    ([key]) => key === 'providers.apiKeys.v1',
  );
  expect(calls.length).toBeGreaterThan(0);
  return JSON.parse(calls[calls.length - 1][1]) as Record<string, string>;
}

describe('apiConfig secure record merge semantics', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mocks.secureSecretSet.mockResolvedValue(undefined);
    mocks.secureSecretGetMany.mockResolvedValue({
      'providers.apiKeys.v1': JSON.stringify({ p1: 'k1', p2: 'k2' }),
    });
    const secure = await import('@/lib/secureStorage');
    secure.resetSecureStorageForTests();
    await secure.initializeSecureStorage();
  });

  it('keeps tokens of providers not touched by an unrelated save', async () => {
    // p_orphan exists only in the keychain record (removed from the list by
    // means other than deleteProvider, e.g. a hand-edited providers.json).
    // A save of the remaining list must NOT wipe it — that wipe was the
    // 2026-10 token-loss bug.
    mocks.secureSecretGetMany.mockResolvedValue({
      'providers.apiKeys.v1': JSON.stringify({ p1: 'k1', p_orphan: 'k-orphan' }),
    });
    const secure = await import('@/lib/secureStorage');
    secure.resetSecureStorageForTests();
    await secure.initializeSecureStorage();

    seedProviderList(['p1']);
    const { updateProvider } = await import('@/lib/apiConfig');
    updateProvider('p1', { name: 'p1-renamed' });
    await secure.flushSecureStorage();

    // The merged record still holds the orphan key — either nothing was
    // written (idempotent, no-op save) or the write carried it.
    const record = secure.readSecureRecord('providers.apiKeys.v1');
    expect(record).toEqual({ p1: 'k1', p_orphan: 'k-orphan' });
    const calls = mocks.secureSecretSet.mock.calls.filter(
      ([key]) => key === 'providers.apiKeys.v1',
    );
    for (const [, value] of calls) {
      expect(JSON.parse(value)).toEqual({ p1: 'k1', p_orphan: 'k-orphan' });
    }
  });

  it('does not re-import an individually cleared provider key from stale inline metadata', async () => {
    mocks.secureSecretGetMany.mockResolvedValue({
      'providers.apiKeys.v1': JSON.stringify({ p2: 'k2' }),
      'gateway.channelApiKeys.v1': JSON.stringify({ '["p2","default"]': 'k2' }),
    });
    const secure = await import('@/lib/secureStorage');
    secure.resetSecureStorageForTests();
    await secure.initializeSecureStorage();
    window.localStorage.setItem(PROVIDERS_KEY, JSON.stringify([
      { id: 'p1', kind: 'anthropic', name: 'p1', apiKey: 'dummy-cleared', baseUrl: 'https://example.test' },
      { id: 'p2', kind: 'anthropic', name: 'p2', baseUrl: 'https://example.test' },
    ]));
    const api = await import('@/lib/apiConfig');
    expect(api.listProviders().find(provider => provider.id === 'p1')?.apiKey).toBe('');
    api.updateProvider('p2', { name: 'Edited' });
    await secure.flushSecureStorage();
    expect(secure.readSecureRecord('providers.apiKeys.v1')).toEqual({ p2: 'k2' });
  });

  it('does not re-import a cleared entry from a record first created during the current session', async () => {
    mocks.secureSecretGetMany.mockResolvedValue({});
    const secure = await import('@/lib/secureStorage');
    secure.resetSecureStorageForTests();
    await secure.initializeSecureStorage();
    await secure.writeSecureRecordAwaited('providers.apiKeys.v1', { p1: 'new-p1', p2: 'k2' });
    await secure.writeSecureRecordAwaited('gateway.channelApiKeys.v1', { '["p1","default"]': 'new-p1', '["p2","default"]': 'k2' });
    seedProviderList(['p1', 'p2']);
    secure.flushSecretsToLocalStorageFallback();
    const mirror = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exhausted', 'QuotaExceededError');
    });
    try {
      const api = await import('@/lib/apiConfig');
      api.updateProvider('p1', { apiKey: '' });
      await secure.flushSecureStorage();
      expect(api.listProviders().find(provider => provider.id === 'p1')?.apiKey).toBe('');
      await secure.flushSecureStorage();
      expect(secure.readSecureRecord('providers.apiKeys.v1')).toEqual({ p2: 'k2' });
    } finally {
      mirror.mockRestore();
    }
  });

  it('does not re-import an individually cleared gateway key from stale inline metadata', async () => {
    mocks.secureSecretGetMany.mockResolvedValue({
      'providers.apiKeys.v1': JSON.stringify({ p2: 'k2' }),
      'gateway.channelApiKeys.v1': JSON.stringify({ '["p2","default"]': 'k2' }),
    });
    const secure = await import('@/lib/secureStorage');
    secure.resetSecureStorageForTests();
    await secure.initializeSecureStorage();
    window.localStorage.setItem('ugs_model_gateway_v1', JSON.stringify({ version: 1, providers: [{
      id: 'p1', kind: 'anthropic', adapter: 'claude-code', name: 'p1', channels: [{
        id: 'default', name: 'Default', apiKey: 'dummy-cleared', route: { transport: 'cli' },
      }],
    }] }));
    const gateway = await import('@/lib/gatewayConfig');
    const config = gateway.loadGatewayConfig();
    expect(config.providers[0].channels[0].apiKey || '').toBe('');
    gateway.saveGatewayConfig(config);
    await secure.flushSecureStorage();
    const record = secure.readSecureRecord('gateway.channelApiKeys.v1');
    expect(record['["p2","default"]']).toBe('k2');
    expect(record).not.toHaveProperty('["p1","default"]');
    expect(Object.values(record)).not.toContain('dummy-cleared');
  });

  it('updateProvider with an empty apiKey clears exactly that token', async () => {
    seedProviderList(['p1', 'p2']);
    const secure = await import('@/lib/secureStorage');
    const { updateProvider } = await import('@/lib/apiConfig');
    updateProvider('p1', { apiKey: '' });
    await secure.flushSecureStorage();

    expect(lastProvidersWrite()).toEqual({ p2: 'k2' });
  });

  it('deleteProvider removes the deleted provider token only', async () => {
    seedProviderList(['p1', 'p2']);
    const secure = await import('@/lib/secureStorage');
    const { deleteProvider } = await import('@/lib/apiConfig');
    deleteProvider('p2');
    await secure.flushSecureStorage();

    expect(lastProvidersWrite()).toEqual({ p1: 'k1' });
  });

  it('clearing a provider also clears its exact default gateway recovery mirror', async () => {
    seedProviderList(['p1', 'p2']);
    mocks.secureSecretGetMany.mockResolvedValue({
      'providers.apiKeys.v1': JSON.stringify({ p1: 'k1', p2: 'k2' }),
      'gateway.channelApiKeys.v1': JSON.stringify({
        '["p1","default"]': 'k1',
        '["p2","default"]': 'k2',
        '["p1","other"]': 'other-key',
      }),
    });
    const secure = await import('@/lib/secureStorage');
    secure.resetSecureStorageForTests();
    await secure.initializeSecureStorage();
    const { updateProvider } = await import('@/lib/apiConfig');
    updateProvider('p1', { apiKey: '' });
    await secure.flushSecureStorage();

    expect(secure.readSecureRecord('gateway.channelApiKeys.v1')).toEqual({
      '["p2","default"]': 'k2',
      '["p1","other"]': 'other-key',
    });
  });
});
