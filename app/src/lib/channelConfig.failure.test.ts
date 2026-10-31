import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  ready: true,
  disk: new Map<string, string>(),
  secrets: new Map<string, string>(),
  failedPath: '',
  invoke: vi.fn(),
  writeSecureRecord: vi.fn(),
}));

vi.mock('@/lib/tauri', () => ({ tauriAvailable: () => true }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: state.invoke }));
vi.mock('@/lib/secureStorage', () => ({
  PROVIDER_API_KEYS_SECRET: 'providers.apiKeys.v1',
  GATEWAY_CHANNEL_API_KEYS_SECRET: 'gateway.channelApiKeys.v1',
  secureStorageAvailable: () => state.ready,
  secureStorageAllowsInlineFallback: () => false,
  readSecureRecord: () => ({}),
  readSecureRecordValue: (record: string, key: string) => state.secrets.get(`${record}:${key}`) ?? '',
  setSecureRecordValue: vi.fn(),
  writeSecureRecord: state.writeSecureRecord,
  gatewayChannelSecretKey: (provider: string, channel: string) => JSON.stringify([provider, channel]),
}));
vi.mock('@/lib/settingsProfile', () => ({
  isRemoteProfileActive: () => false,
  readRemoteProfileRaw: () => null,
  writeRemoteProfileRaw: vi.fn(),
}));
vi.mock('@/lib/freeChannels', () => ({
  FREE_CHANNEL_PROVIDER_PREFIX: 'freecc:',
  freeChannelGatewayProviders: () => [],
}));

const providerPath = 'settings/providers.v1.json';
const gatewayPath = 'settings/modelGateway.v1.json';
const metadata = { id: 'p1', kind: 'codex', name: 'Dummy', baseUrl: 'https://example.test/v1' };

beforeEach(async () => {
  const api = await import('./apiConfig');
  const gateway = await import('./gatewayConfig');
  await api.flushApiConfigDiskWrites();
  await gateway.flushGatewayConfigDiskWrites();
  api.resetApiConfigStoreForTests();
  gateway.resetGatewayConfigStoreForTests();
  window.localStorage.clear();
  state.ready = true;
  state.failedPath = '';
  state.disk.clear();
  state.secrets.clear();
  state.invoke.mockReset();
  state.writeSecureRecord.mockClear();
  state.invoke.mockImplementation(async (command: string, args: Record<string, string>) => {
    if (command === 'history_read_json') {
      if (args.relPath === state.failedPath) throw new Error('disk temporarily unavailable');
      return state.disk.get(args.relPath) ?? null;
    }
    if (command === 'history_write_json') state.disk.set(args.relPath, args.json);
    return null;
  });
  // Concurrent dynamic imports can reach the SDK invoke wrapper as well as
  // the module double. Both routes must share the same isolated persistence.
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    configurable: true,
    value: { invoke: state.invoke },
  });
});

afterEach(() => {
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
});

function diskWrites() {
  return state.invoke.mock.calls.filter(([command]) => command === 'history_write_json');
}

describe('channel configuration failure safety', () => {
  it('keeps a healthy selection deletion authoritative during an unrelated hydration retry', async () => {
    const selectionPath = 'settings/activeGatewaySelection.v1.json';
    state.disk.set(selectionPath, JSON.stringify({
      adapter: 'codex', modelClass: 'test-model', providerId: 'p1', channelId: 'default',
    }));
    state.failedPath = gatewayPath;
    const gateway = await import('./gatewayConfig');
    await gateway.initializeGatewayConfigStore();
    expect(gateway.hasExplicitGatewayPin()).toBe(true);
    let releaseWrite!: () => void;
    const blockedWrite = new Promise<void>(resolve => { releaseWrite = resolve; });
    state.invoke.mockImplementation(async (command: string, args: Record<string, string>) => {
      if (command === 'history_read_json') {
        if (args.relPath === gatewayPath) throw new Error('gateway config unreadable');
        return state.disk.get(args.relPath) ?? null;
      }
      if (command === 'history_write_json') {
        if (args.relPath === selectionPath) await blockedWrite;
        state.disk.set(args.relPath, args.json);
      }
      return null;
    });
    gateway.clearActiveGatewaySelection();
    try {
      await gateway.initializeGatewayConfigStore();
    } finally {
      releaseWrite();
      await gateway.flushGatewayConfigDiskWrites();
    }
    expect(gateway.hasExplicitGatewayPin()).toBe(false);
    expect(state.disk.get(selectionPath)).toBe('null');
  });

  it('keeps the healthy provider list authoritative when selection reading fails and the local mirror is full', async () => {
    const second = { ...metadata, id: 'p2', name: 'Second' };
    state.disk.set(providerPath, JSON.stringify([metadata, second]));
    window.localStorage.setItem('ugs_providers', JSON.stringify([metadata]));
    state.failedPath = 'settings/activeProviderByKind.v1.json';
    const mirror = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exhausted', 'QuotaExceededError');
    });
    try {
      const api = await import('./apiConfig');
      await api.initializeApiConfigStore();
      expect(api.listProviders().map(provider => provider.id)).toEqual(['p1', 'p2']);
      api.updateProvider('p1', { name: 'Edited' });
      await api.flushApiConfigDiskWrites();
      expect(JSON.parse(state.disk.get(providerPath)!).map((provider: { id: string }) => provider.id)).toEqual(['p1', 'p2']);
    } finally {
      mirror.mockRestore();
    }
  });

  it('does not reload a healthy provider list over an edit while retrying an unrelated failed selection', async () => {
    state.disk.set(providerPath, JSON.stringify([metadata]));
    state.failedPath = 'settings/activeProviderByKind.v1.json';
    const api = await import('./apiConfig');
    await api.initializeApiConfigStore();
    let releaseWrite!: () => void;
    const blockedWrite = new Promise<void>(resolve => { releaseWrite = resolve; });
    state.invoke.mockImplementation(async (command: string, args: Record<string, string>) => {
      if (command === 'history_read_json') return state.disk.get(args.relPath) ?? null;
      if (command === 'history_write_json') {
        if (args.relPath === providerPath) await blockedWrite;
        state.disk.set(args.relPath, args.json);
      }
      return null;
    });
    api.updateProvider('p1', { name: 'Newest edit' });
    try {
      await api.initializeApiConfigStore();
    } finally {
      releaseWrite();
      await api.flushApiConfigDiskWrites();
    }
    expect(api.listProviders()[0].name).toBe('Newest edit');
    expect(diskWrites().filter(([, args]) => args.relPath === providerPath).map(([, args]) => JSON.parse(args.json)[0].name)).toContain('Newest edit');
    expect(JSON.parse(state.disk.get(providerPath)!)[0].name).toBe('Newest edit');
  });

  it('does not reload healthy gateway configuration over an edit while retrying an unrelated failed selection', async () => {
    const first = { id: 'p1', kind: 'codex' as const, adapter: 'codex' as const, name: 'First', channels: [{
      id: 'default', name: 'Default', route: { transport: 'cli' as const },
    }] };
    state.disk.set(gatewayPath, JSON.stringify({ version: 1, providers: [first] }));
    state.failedPath = 'settings/activeGatewaySelection.v1.json';
    const gateway = await import('./gatewayConfig');
    await gateway.initializeGatewayConfigStore();
    let releaseWrite!: () => void;
    const blockedWrite = new Promise<void>(resolve => { releaseWrite = resolve; });
    state.invoke.mockImplementation(async (command: string, args: Record<string, string>) => {
      if (command === 'history_read_json') return state.disk.get(args.relPath) ?? null;
      if (command === 'history_write_json') {
        if (args.relPath === gatewayPath) await blockedWrite;
        state.disk.set(args.relPath, args.json);
      }
      return null;
    });
    const config = gateway.loadGatewayConfig();
    config.providers[0].name = 'Newest edit';
    gateway.saveGatewayConfig(config);
    try {
      await gateway.initializeGatewayConfigStore();
    } finally {
      releaseWrite();
      await gateway.flushGatewayConfigDiskWrites();
    }
    expect(gateway.loadGatewayConfig().providers[0].name).toBe('Newest edit');
    expect(diskWrites().filter(([, args]) => args.relPath === gatewayPath).map(([, args]) => JSON.parse(args.json).providers[0].name)).toContain('Newest edit');
    expect(JSON.parse(state.disk.get(gatewayPath)!).providers[0].name).toBe('Newest edit');
  });

  it('keeps healthy gateway configuration authoritative when selection reading fails and the local mirror is full', async () => {
    const first = { id: 'p1', kind: 'codex' as const, adapter: 'codex' as const, name: 'First', channels: [{
      id: 'default', name: 'Default', route: { transport: 'cli' as const },
    }] };
    const second = { ...first, id: 'p2', name: 'Second' };
    state.disk.set(gatewayPath, JSON.stringify({ version: 1, providers: [first, second] }));
    window.localStorage.setItem('ugs_model_gateway_v1', JSON.stringify({ version: 1, providers: [first] }));
    state.failedPath = 'settings/activeGatewaySelection.v1.json';
    const mirror = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exhausted', 'QuotaExceededError');
    });
    try {
      const gateway = await import('./gatewayConfig');
      await gateway.initializeGatewayConfigStore();
      const config = gateway.loadGatewayConfig();
      expect(config.providers.map(provider => provider.id)).toEqual(['p1', 'p2']);
      config.providers[0].name = 'Edited';
      gateway.saveGatewayConfig(config);
      await gateway.flushGatewayConfigDiskWrites();
      expect(JSON.parse(state.disk.get(gatewayPath)!).providers.map((provider: { id: string }) => provider.id)).toEqual(['p1', 'p2']);
    } finally {
      mirror.mockRestore();
    }
  });

  it('still displays healthy credential records when another secret made overall initialization fail', async () => {
    state.ready = false;
    state.secrets.set('providers.apiKeys.v1:p1', 'dummy-healthy-provider');
    state.secrets.set('gateway.channelApiKeys.v1:["p1","default"]', 'dummy-healthy-gateway');
    state.disk.set(providerPath, JSON.stringify([metadata]));
    state.disk.set(gatewayPath, JSON.stringify({ version: 1, providers: [{
      id: 'p1', kind: 'codex', adapter: 'codex', name: 'Dummy', channels: [{
        id: 'default', name: 'Default', route: { transport: 'cli' },
      }],
    }] }));
    const api = await import('./apiConfig');
    const gateway = await import('./gatewayConfig');
    await api.initializeApiConfigStore();
    await gateway.initializeGatewayConfigStore();
    expect(api.listProviders()[0].apiKey).toBe('dummy-healthy-provider');
    expect(gateway.loadGatewayConfig().providers[0].channels[0].apiKey).toBe('dummy-healthy-gateway');
  });

  it('keeps the provider recovery mirror and refuses credential saves when secure loading failed', async () => {
    state.ready = false;
    const fallback = JSON.stringify([{ ...metadata, apiKey: 'dummy-recovery-key' }]);
    window.localStorage.setItem('ugs_providers', fallback);
    state.disk.set(providerPath, JSON.stringify([metadata]));
    const api = await import('./apiConfig');
    await api.initializeApiConfigStore();
    expect(window.localStorage.getItem('ugs_providers')).toBe(fallback);
    expect(() => api.updateProvider('p1', { apiKey: 'dummy-new-key' })).toThrow();
    await api.flushApiConfigDiskWrites();
    expect(state.disk.get(providerPath)).not.toContain('dummy-');
    expect(state.writeSecureRecord).not.toHaveBeenCalled();
  });

  it('keeps the gateway recovery mirror and skips startup synchronization on secure failure', async () => {
    state.ready = false;
    const fallback = JSON.stringify({ version: 1, providers: [{
      id: 'p1', kind: 'codex', adapter: 'codex', name: 'Dummy', channels: [{
        id: 'default', name: 'Default', apiKey: 'dummy-recovery-key', route: { transport: 'cli' },
      }],
    }] });
    window.localStorage.setItem('ugs_model_gateway_v1', fallback);
    state.disk.set(gatewayPath, JSON.stringify({ version: 1, providers: [] }));
    state.disk.set(providerPath, JSON.stringify([metadata]));
    const api = await import('./apiConfig');
    const gateway = await import('./gatewayConfig');
    await gateway.initializeGatewayConfigStore();
    await api.initializeApiConfigStore();
    expect(window.localStorage.getItem('ugs_model_gateway_v1')).toBe(fallback);
    api.syncGatewayFromProviders();
    await gateway.flushGatewayConfigDiskWrites();
    expect(diskWrites()).toEqual([]);
    expect(() => gateway.saveGatewayConfig({ version: 1, providers: [] })).toThrow();
  });

  it('does not migrate inline recovery keys into ordinary disk JSON on secure failure', async () => {
    state.ready = false;
    window.localStorage.setItem('ugs_providers', JSON.stringify([{ ...metadata, apiKey: 'dummy-recovery-key' }]));
    const api = await import('./apiConfig');
    await api.initializeApiConfigStore();
    api.listProviders();
    await api.flushApiConfigDiskWrites();
    expect(diskWrites()).toEqual([]);
    expect(state.disk.has(providerPath)).toBe(false);
  });

  it('does not overwrite providers with an empty migration after a disk read error and can retry', async () => {
    state.disk.set(providerPath, JSON.stringify([metadata]));
    state.failedPath = providerPath;
    const api = await import('./apiConfig');
    await api.initializeApiConfigStore();
    expect(api.listProviders()).toEqual([]);
    await api.flushApiConfigDiskWrites();
    expect(diskWrites()).toEqual([]);
    expect(JSON.parse(state.disk.get(providerPath)!)).toEqual([metadata]);
    state.failedPath = '';
    await api.initializeApiConfigStore();
    expect(api.listProviders().map(p => p.id)).toEqual(['p1']);
  });

  it('retries gateway hydration after a disk read failure', async () => {
    state.disk.set('settings/activeGatewaySelection.v1.json', JSON.stringify({
      adapter: 'codex', modelClass: 'dummy-model', providerId: 'p1', channelId: 'default',
    }));
    state.failedPath = gatewayPath;
    const gateway = await import('./gatewayConfig');
    await gateway.initializeGatewayConfigStore();
    state.failedPath = '';
    await gateway.initializeGatewayConfigStore();
    expect(gateway.getActiveGatewaySelection().modelClass).toBe('dummy-model');
  });
});
