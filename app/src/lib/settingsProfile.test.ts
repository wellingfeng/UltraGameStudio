import { afterEach, describe, expect, it, vi } from 'vitest';

const remoteMocks = vi.hoisted(() => ({
  writeUserSetting: vi.fn(),
  getRemoteWorkspace: vi.fn(() => ({ id: 'ws-1' })),
  resolveRemoteRunnerConnection: vi.fn(() => ({
    serverUrl: 'http://runner',
    token: 'tok',
  })),
}));

vi.mock('@/lib/remoteWorkspace', () => ({
  getRemoteWorkspace: remoteMocks.getRemoteWorkspace,
  resolveRemoteRunnerConnection: remoteMocks.resolveRemoteRunnerConnection,
  RunnerClient: class {
    writeUserSetting(relPath: string, json: string) {
      return remoteMocks.writeUserSetting(relPath, json);
    }
  },
}));
import {
  addProvider,
  deleteProvider,
  listProviders,
  PROVIDERS_STORAGE,
  resetApiConfigStoreForTests,
  type Provider,
} from './apiConfig';
import {
  REMOTE_PROFILE_PREFIX,
  flushRemoteProfileWrites,
  isRemoteProfileActive,
  resetSettingsProfileForTests,
  setActiveSettingsProfileSync,
  writeRemoteProfileRaw,
} from './settingsProfile';

const REMOTE_PROFILE = `${REMOTE_PROFILE_PREFIX}ws-1`;

function seedLocal(entries: unknown[]): void {
  window.localStorage.setItem(PROVIDERS_STORAGE, JSON.stringify(entries));
}

afterEach(() => {
  window.localStorage.clear();
  resetApiConfigStoreForTests();
  resetSettingsProfileForTests();
});

describe('settings profile channel overlay', () => {
  it('isolates ordinary providers per profile while keeping remote-runner local', () => {
    // Local store: one ordinary provider + one remote-runner execution provider.
    seedLocal([
      { id: 'p_local', kind: 'anthropic', name: 'Local Claude', apiKey: 'sk-local', baseUrl: '' },
      { id: 'remote-runner:ws-1:acct', kind: 'anthropic', name: 'Runner', apiKey: 'remote-runner', baseUrl: '' },
    ]);

    // Switch to the remote profile: ordinary providers come from the (empty)
    // remote KV, but the remote-runner execution provider is still visible.
    setActiveSettingsProfileSync(REMOTE_PROFILE);
    expect(isRemoteProfileActive()).toBe(true);
    let ids = listProviders().map((p) => p.id);
    expect(ids).toContain('remote-runner:ws-1:acct');
    expect(ids).not.toContain('p_local');

    // Add a provider while on the remote profile.
    const added = addProvider({
      kind: 'anthropic',
      name: 'Remote Claude',
      apiKey: 'sk-remote',
      baseUrl: '',
    } as Omit<Provider, 'id'>);
    ids = listProviders().map((p) => p.id);
    expect(ids).toContain(added.id);

    // Back to local: the remote-only provider must not leak into local.
    setActiveSettingsProfileSync('local');
    ids = listProviders().map((p) => p.id);
    expect(ids).toContain('p_local');
    expect(ids).not.toContain(added.id);

    // Remote profile again: remote provider persisted in the synchronous cache.
    setActiveSettingsProfileSync(REMOTE_PROFILE);
    ids = listProviders().map((p) => p.id);
    expect(ids).toContain(added.id);
    expect(ids).not.toContain('p_local');

    // Cleanup remote-scoped edit.
    deleteProvider(added.id);
    expect(listProviders().map((p) => p.id)).not.toContain(added.id);
  });

  it('keeps API keys inline for remote-profile providers', () => {
    setActiveSettingsProfileSync(REMOTE_PROFILE);
    const added = addProvider({
      kind: 'codex',
      name: 'Remote Codex',
      apiKey: 'sk-inline-123',
      baseUrl: '',
    } as Omit<Provider, 'id'>);
    const found = listProviders().find((p) => p.id === added.id);
    expect(found?.apiKey).toBe('sk-inline-123');
  });
});

describe('flushRemoteProfileWrites', () => {
  afterEach(() => {
    remoteMocks.writeUserSetting.mockReset();
    remoteMocks.writeUserSetting.mockResolvedValue(undefined);
    resetSettingsProfileForTests();
  });

  it('resolves ok when the write-behind remote write lands', async () => {
    remoteMocks.writeUserSetting.mockResolvedValue(undefined);
    setActiveSettingsProfileSync(REMOTE_PROFILE);
    writeRemoteProfileRaw('settings/providers.v1.json', '[]');
    const results = await flushRemoteProfileWrites();
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ relPath: 'settings/providers.v1.json', ok: true });
  });

  it('reports the failure when the remote write rejects', async () => {
    remoteMocks.writeUserSetting.mockRejectedValue(new Error('unauthorized'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    setActiveSettingsProfileSync(REMOTE_PROFILE);
    writeRemoteProfileRaw('settings/providers.v1.json', '[]');
    const results = await flushRemoteProfileWrites();
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(false);
    expect(results[0].error).toContain('unauthorized');
  });

  it('returns [] when nothing is pending', async () => {
    expect(await flushRemoteProfileWrites()).toEqual([]);
  });
});
