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
});
