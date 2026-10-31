import { beforeEach, describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({
  values: new Map<string, string>(),
  unreadable: new Set<string>(),
  getMany: vi.fn<(names: string[]) => Promise<Record<string, string>>>(),
  set: vi.fn<(name: string, value: string) => Promise<void>>(),
  delete: vi.fn<(name: string) => Promise<void>>(),
  invoke: vi.fn<(command: string, args: unknown) => Promise<string | null>>(),
  desktop: true,
}));

vi.mock('@/lib/tauri', () => ({
  isTauri: () => backend.desktop,
  secureSecretGetMany: backend.getMany,
  secureSecretSet: backend.set,
  secureSecretDelete: backend.delete,
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: backend.invoke }));

import * as secure from './secureStorage';

const primary = secure.PROVIDER_API_KEYS_SECRET;
const gateway = secure.GATEWAY_CHANNEL_API_KEYS_SECRET;

beforeEach(() => {
  vi.resetAllMocks();
  window.localStorage.clear();
  backend.values.clear();
  backend.unreadable.clear();
  backend.desktop = true;
  backend.getMany.mockImplementation(async (names) => {
    if (names.some((name) => backend.unreadable.has(name))) {
      throw new Error('fixture: missing credential chunk');
    }
    return Object.fromEntries(names.flatMap((name) => {
      const value = backend.values.get(name);
      return value === undefined ? [] : [[name, value]];
    }));
  });
  backend.set.mockImplementation(async (name, value) => {
    backend.values.set(name, value);
    backend.unreadable.delete(name);
  });
  backend.delete.mockImplementation(async (name) => { backend.values.delete(name); });
  backend.invoke.mockResolvedValue(null);
  secure.resetSecureStorageForTests();
});

describe('secure storage initialization recovery', () => {
  it('shares the pending initialization promise and does not let concurrent callers return early', async () => {
    let release!: (value: Record<string, string>) => void;
    backend.getMany.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const first = secure.initializeSecureStorage();
    const second = secure.initializeSecureStorage();
    let secondFinished = false;
    void second.then(() => { secondFinished = true; });
    await Promise.resolve();
    const returnedEarly = secondFinished;
    const shared = first === second;
    release({ [primary]: JSON.stringify({ p1: 'fixture-key' }) });
    await Promise.all([first, second]);

    expect(returnedEarly).toBe(false);
    expect(shared).toBe(true);
    expect(backend.getMany).toHaveBeenCalledOnce();
    expect(secure.readSecureRecord(primary)).toEqual({ p1: 'fixture-key' });
  });

  it('retries a failed initialization and refreshes a previously unreadable secret', async () => {
    backend.unreadable.add(primary);
    await secure.initializeSecureStorage();
    expect(secure.secureStorageAvailable()).toBe(false);
    backend.unreadable.clear();
    backend.values.set(primary, JSON.stringify({ p1: 'fixture-retried' }));

    await secure.initializeSecureStorage();

    expect(secure.secureStorageAvailable()).toBe(true);
    expect(secure.readSecureRecord(primary)).toEqual({ p1: 'fixture-retried' });
  });

  it('isolates a broken primary after a batch read fails without losing healthy secrets', async () => {
    backend.unreadable.add(primary);
    backend.values.set(gateway, JSON.stringify({ '["configured","default"]': 'fixture-key' }));
    backend.values.set(secure.REMOTE_RUNNER_CONNECTION_SECRET, JSON.stringify({ token: 'fixture-runner' }));

    await secure.initializeSecureStorage();

    expect(secure.readSecureRecord(gateway)).toEqual({ '["configured","default"]': 'fixture-key' });
    expect(secure.readSecureRecord(secure.REMOTE_RUNNER_CONNECTION_SECRET)).toEqual({ token: 'fixture-runner' });
    expect(secure.secureStorageAvailable()).toBe(false);
    expect(backend.getMany.mock.calls.filter(([names]) => names.length === 1)).toHaveLength(6);
    expect(backend.set).not.toHaveBeenCalled();
  });

  it('awaits the shared initialization before an awaited save can return', async () => {
    let release!: (value: Record<string, string>) => void;
    backend.getMany.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const init = secure.initializeSecureStorage();
    let saveFinished = false;
    const save = secure.writeSecureRecordAwaited(primary, { p1: 'fixture-new' });
    void save.then(() => { saveFinished = true; });
    await Promise.resolve();
    const returnedEarly = saveFinished;
    const wroteEarly = backend.set.mock.calls.length;
    release({ [primary]: JSON.stringify({ p1: 'fixture-old' }) });
    await Promise.all([init, save]);

    expect(returnedEarly).toBe(false);
    expect(wroteEarly).toBe(0);
    expect(backend.values.get(primary)).toBe(JSON.stringify({ p1: 'fixture-new' }));
    expect(secure.readSecureRecord(primary)).toEqual({ p1: 'fixture-new' });
  });

  it('rejects unsafe desktop writes and flushes without mutating the failed record cache', async () => {
    backend.unreadable.add(primary);
    await secure.initializeSecureStorage();

    expect(() => secure.writeSecureRecord(primary, { p1: 'fixture-new' })).toThrow(/安全存储.*读取失败/);
    expect(() => secure.writeSecureSecret(primary, 'fixture-new')).toThrow(/安全存储.*读取失败/);
    expect(() => secure.setSecureRecordValue(primary, 'p1', '')).toThrow(/安全存储.*读取失败/);
    await expect(secure.writeSecureRecordAwaited(primary, {})).rejects.toThrow(/安全存储.*读取失败/);
    await expect(secure.flushSecureStorage()).rejects.toThrow(/安全存储.*读取失败/);
    expect(secure.readSecureRecord(primary)).toEqual({});
    expect(backend.set).not.toHaveBeenCalled();
    expect(backend.delete).not.toHaveBeenCalled();
  });

  it('allows a healthy record to persist independently while another record remains unreadable', async () => {
    backend.unreadable.add(primary);
    backend.values.set(gateway, JSON.stringify({ '["p1","default"]': 'fixture-old' }));
    await secure.initializeSecureStorage();

    await secure.writeSecureRecordAwaited(gateway, { '["p1","default"]': 'fixture-new' });

    expect(backend.values.get(gateway)).toBe(JSON.stringify({ '["p1","default"]': 'fixture-new' }));
    expect(secure.secureStorageAvailable()).toBe(false);
  });

  it.each([
    ['save', 'batch'], ['delete', 'batch'], ['save', 'isolated'], ['delete', 'isolated'],
  ] as const)('drains a pending healthy %s before an %s retry and a later merged save', async (operation, readMode) => {
    const firstKey = secure.gatewayChannelSecretKey('p1', 'default');
    const keptKey = secure.gatewayChannelSecretKey('kept', 'default');
    const laterKey = secure.gatewayChannelSecretKey('later', 'default');
    backend.unreadable.add(primary);
    backend.values.set(gateway, JSON.stringify({ [firstKey]: 'fixture-old', [keptKey]: 'fixture-kept' }));
    await secure.initializeSecureStorage();
    backend.getMany.mockClear();

    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    if (operation === 'save') {
      backend.set.mockImplementationOnce(async (name, value) => {
        await writeGate;
        backend.values.set(name, value);
      });
      secure.setSecureRecordValue(gateway, firstKey, 'fixture-intermediate');
      secure.setSecureRecordValue(gateway, firstKey, 'fixture-new');
    } else {
      backend.delete.mockImplementationOnce(async (name) => {
        await writeGate;
        backend.values.set(name, ''); // Native deletes produce an explicit tombstone.
      });
      secure.writeSecureRecord(gateway, {});
    }
    const optimistic = operation === 'save'
      ? { [firstKey]: 'fixture-new', [keptKey]: 'fixture-kept' }
      : {};
    expect(secure.readSecureRecord(gateway)).toEqual(optimistic);
    if (readMode === 'batch') {
      backend.unreadable.clear();
      window.localStorage.setItem('ugs_model_gateway_v1', JSON.stringify({ providers: [
        { id: 'p1', channels: [{ id: 'default', apiKey: 'fixture-stale-inline' }] },
      ] }));
    }
    backend.values.set(primary, '{"p1":"fixture-primary-retried"}');

    const retry = secure.initializeSecureStorage();
    let retryFinished = false;
    void retry.then(() => { retryFinished = true; });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const readsBeforeWriteFinished = backend.getMany.mock.calls.length;
    const cacheWhileWritePending = secure.readSecureRecord(gateway);
    const returnedEarly = retryFinished;
    releaseWrite();
    await retry;
    const expected = { ...secure.readSecureRecord(gateway), [laterKey]: 'fixture-later' };
    await secure.writeSecureRecordAwaited(gateway, expected);
    if (readMode === 'batch') await secure.flushSecureStorage();
    else await expect(secure.flushSecureStorage()).rejects.toThrow(/安全存储.*读取失败/);

    expect(cacheWhileWritePending).toEqual(optimistic);
    expect(readsBeforeWriteFinished).toBe(0);
    expect(returnedEarly).toBe(false);
    expect(expected).toEqual({ ...optimistic, [laterKey]: 'fixture-later' });
    expect(secure.readSecureRecord(gateway)).toEqual(expected);
    expect(backend.values.get(gateway)).toBe(JSON.stringify(expected));
    secure.resetSecureStorageForTests();
    await secure.initializeSecureStorage();
    expect(secure.readSecureRecord(gateway)).toEqual(expected);
  });

  it('rejects synchronous desktop writes before initialization even for an empty no-op', () => {
    expect(() => secure.writeSecureRecord(primary, {})).toThrow(/安全存储.*初始化/);
    expect(secure.readSecureRecord(primary)).toEqual({});
    expect(backend.set).not.toHaveBeenCalled();
  });

  it.each(['save', 'delete'] as const)('gates a healthy %s after the retry read begins until its snapshot is loaded', async (operation) => {
    const firstKey = secure.gatewayChannelSecretKey('p1', 'default');
    const keptKey = secure.gatewayChannelSecretKey('kept', 'default');
    const laterKey = secure.gatewayChannelSecretKey('later', 'default');
    const committed = { [firstKey]: 'fixture-old', [keptKey]: 'fixture-kept' };
    backend.unreadable.add(primary);
    backend.values.set(gateway, JSON.stringify(committed));
    await secure.initializeSecureStorage();
    backend.unreadable.clear();
    backend.values.set(primary, '{"p1":"fixture-primary-retried"}');
    const snapshot = Object.fromEntries(backend.values);
    let releaseRead!: () => void;
    backend.getMany.mockImplementationOnce(() => new Promise((resolve) => {
      releaseRead = () => resolve(snapshot);
    }));
    const retry = secure.initializeSecureStorage();
    await vi.waitFor(() => expect(releaseRead).toBeTypeOf('function'));
    const next = operation === 'save'
      ? { [firstKey]: 'fixture-new', [keptKey]: 'fixture-kept' }
      : {};
    expect(() => secure.writeSecureRecord(gateway, next)).toThrow(/安全存储.*初始化/);
    const awaitedWrite = secure.writeSecureRecordAwaited(gateway, next);
    let writeFinished = false;
    void awaitedWrite.then(() => { writeFinished = true; });
    await Promise.resolve();
    const returnedEarly = writeFinished;
    const cacheDuringRead = secure.readSecureRecord(gateway);
    const writesDuringRead = backend.set.mock.calls.length + backend.delete.mock.calls.length;
    releaseRead();
    await Promise.all([retry, awaitedWrite]);
    secure.setSecureRecordValue(gateway, laterKey, 'fixture-later');
    await secure.flushSecureStorage();

    expect(returnedEarly).toBe(false);
    expect(writesDuringRead).toBe(0);
    expect(cacheDuringRead).toEqual(committed);
    const expected = { ...next, [laterKey]: 'fixture-later' };
    expect(secure.readSecureRecord(gateway)).toEqual(expected);
    expect(backend.values.get(gateway)).toBe(JSON.stringify(expected));
    secure.resetSecureStorageForTests();
    await secure.initializeSecureStorage();
    expect(secure.readSecureRecord(gateway)).toEqual(expected);
  });

  it('preserves the optimistic cache and fallback when a pending healthy write fails during retry', async () => {
    backend.unreadable.add(primary);
    backend.values.set(gateway, '{"channel":"fixture-old"}');
    await secure.initializeSecureStorage();
    const legacy = '[{"id":"p1","apiKey":"fixture-legacy"}]';
    window.localStorage.setItem('ugs_providers', legacy);
    let failWrite!: () => void;
    backend.set.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      failWrite = () => reject(new Error('fixture: pending write rejected'));
    }));
    secure.setSecureRecordValue(gateway, 'channel', 'fixture-new');
    backend.getMany.mockClear();
    backend.unreadable.clear();
    backend.values.set(primary, '{"p1":"fixture-authoritative"}');
    const retry = secure.initializeSecureStorage();
    failWrite();
    await retry;

    expect(secure.readSecureRecord(gateway)).toEqual({ channel: 'fixture-new' });
    expect(backend.getMany).not.toHaveBeenCalled();
    expect(window.localStorage.getItem('ugs_providers')).toBe(legacy);
    expect(secure.secureStorageAvailable()).toBe(false);
    await expect(secure.flushSecureStorage()).rejects.toThrow(/安全存储写入失败/);
    await secure.writeSecureRecordAwaited(gateway, { channel: 'fixture-new' });
    await secure.initializeSecureStorage();
    await secure.flushSecureStorage();
    expect(backend.values.get(gateway)).toBe('{"channel":"fixture-new"}');
    expect(secure.readSecureRecord(primary)).toEqual({ p1: 'fixture-authoritative' });
    expect(window.localStorage.getItem('ugs_providers')).toBe('[{"id":"p1"}]');
  });

  it('migrates a genuinely missing primary on retry and holds healthy writes until verification finishes', async () => {
    const firstKey = secure.gatewayChannelSecretKey('p1', 'default');
    backend.unreadable.add(primary);
    backend.values.set(gateway, JSON.stringify({ [firstKey]: 'fixture-old' }));
    await secure.initializeSecureStorage();
    const providerInline = '[{"id":"legacy","apiKey":"fixture-legacy"}]';
    window.localStorage.setItem('ugs_providers', providerInline);
    const inline = JSON.stringify({ providers: [
      { id: 'p1', channels: [{ id: 'default', apiKey: 'fixture-stale-inline' }] },
      { id: 'legacy', channels: [{ id: 'default', apiKey: 'fixture-legacy' }] },
    ] });
    window.localStorage.setItem('ugs_model_gateway_v1', inline);
    let releasePendingWrite!: () => void;
    const pendingGate = new Promise<void>((resolve) => { releasePendingWrite = resolve; });
    backend.set.mockImplementationOnce(async (name, value) => {
      await pendingGate;
      backend.values.set(name, value);
    });
    secure.setSecureRecordValue(gateway, firstKey, 'fixture-new');
    backend.unreadable.clear();
    const getMany = backend.getMany.getMockImplementation()!;
    let releaseVerification!: () => void;
    backend.getMany.mockImplementation((names) => {
      if (names.length === 1 && names[0] === primary && !releaseVerification) {
        const readback = Object.fromEntries(backend.values);
        return new Promise((resolve) => { releaseVerification = () => resolve(readback); });
      }
      return getMany(names);
    });
    const retry = secure.initializeSecureStorage();
    releasePendingWrite();
    await vi.waitFor(() => expect(releaseVerification).toBeTypeOf('function'));
    const migrated = { [firstKey]: 'fixture-new' };
    const migrationCache = secure.readSecureRecord(gateway);
    const primaryDuringVerification = secure.readSecureRecord(primary);
    const fallbackDuringVerification = window.localStorage.getItem('ugs_providers');
    const gatewayFallbackDuringVerification = window.localStorage.getItem('ugs_model_gateway_v1');
    let syncError: unknown;
    try { secure.setSecureRecordValue(gateway, firstKey, 'fixture-later'); }
    catch (error) { syncError = error; }
    const later = { ...migrated, [firstKey]: 'fixture-later' };
    const awaitedWrite = secure.writeSecureRecordAwaited(gateway, later);
    releaseVerification();
    await Promise.all([retry, awaitedWrite]);
    await secure.flushSecureStorage();

    expect(migrationCache).toEqual(migrated);
    expect(primaryDuringVerification).toEqual({ legacy: 'fixture-legacy' });
    expect(fallbackDuringVerification).toBe(providerInline);
    expect(gatewayFallbackDuringVerification).toBe(inline);
    expect(String(syncError)).toMatch(/安全存储.*初始化/);
    expect(backend.set.mock.calls.map(([name, value]) => [name, JSON.parse(value)])).toEqual([
      [gateway, migrated], [primary, { legacy: 'fixture-legacy' }], [gateway, later],
    ]);
    expect(secure.readSecureRecord(gateway)).toEqual(later);
    expect(backend.values.get(gateway)).toBe(JSON.stringify(later));
    expect(window.localStorage.getItem('ugs_model_gateway_v1')).not.toContain('apiKey');
    secure.resetSecureStorageForTests();
    await secure.initializeSecureStorage();
    expect(secure.readSecureRecord(gateway)).toEqual(later);
  });

  it('keeps non-Tauri memory writes and no-op flush behavior unchanged', async () => {
    backend.desktop = false;
    secure.writeSecureRecord(primary, { p1: 'fixture-browser' });
    await secure.writeSecureRecordAwaited(gateway, { channel: 'fixture-browser' });
    await secure.flushSecureStorage();
    expect(secure.readSecureRecord(primary)).toEqual({ p1: 'fixture-browser' });
    expect(secure.secureStorageAvailable()).toBe(false);
    expect(backend.getMany).not.toHaveBeenCalled();
    expect(backend.set).not.toHaveBeenCalled();
  });

  it('refuses complete but older default mirrors when the newer primary cannot be read', async () => {
    const secondId = 'provider:quote"2';
    backend.unreadable.add(primary);
    backend.invoke.mockResolvedValue(JSON.stringify([{ id: 'p1' }, { id: secondId }]));
    const newerPrimary = JSON.stringify({ p1: 'fixture-newer-first', [secondId]: 'fixture-newer-second' });
    backend.values.set(primary, newerPrimary);
    backend.values.set(gateway, JSON.stringify({
      [secure.gatewayChannelSecretKey('p1', 'default')]: 'fixture-first',
      [secure.gatewayChannelSecretKey(secondId, 'default')]: 'fixture-second',
      [secure.gatewayChannelSecretKey('p1', 'alternate')]: 'fixture-wrong-channel',
      [secure.gatewayChannelSecretKey('not-configured', 'default')]: 'fixture-not-configured',
    }));
    const legacy = JSON.stringify([{ id: 'p1', apiKey: 'fixture-manual-fallback' }, { id: secondId }]);
    window.localStorage.setItem('ugs_providers', legacy);

    await secure.initializeSecureStorage();

    expect(backend.values.get(primary)).toBe(newerPrimary);
    expect(secure.readSecureRecord(primary)).toEqual({});
    expect(secure.secureStorageAvailable()).toBe(false);
    expect(secure.secureStorageReadFailed(primary)).toBe(true);
    expect(secure.readSecureRecordValue(gateway, secure.gatewayChannelSecretKey(secondId, 'default'))).toBe('fixture-second');
    await expect(secure.flushSecureStorage()).rejects.toThrow(/安全存储.*读取失败/);
    expect(backend.set).not.toHaveBeenCalled();
    expect(backend.delete).not.toHaveBeenCalled();
    expect(backend.invoke).not.toHaveBeenCalled();
    expect(window.localStorage.getItem('ugs_providers')).toBe(legacy);

    secure.resetSecureStorageForTests();
    await secure.initializeSecureStorage();
    expect(backend.values.get(primary)).toBe(newerPrimary);
    expect(secure.secureStorageReadFailed(primary)).toBe(true);
    expect(backend.set).not.toHaveBeenCalled();
    expect(window.localStorage.getItem('ugs_providers')).toBe(legacy);
  });

  it('does not strip the legacy fallback when a migration write cannot be read back', async () => {
    const legacy = JSON.stringify([{ id: 'p1', apiKey: 'fixture-legacy' }]);
    window.localStorage.setItem('ugs_providers', legacy);
    backend.set.mockResolvedValue(undefined); // Native write resolves, but the read proves nothing persisted.

    await secure.initializeSecureStorage();

    expect(window.localStorage.getItem('ugs_providers')).toBe(legacy);
    expect(secure.secureStorageAvailable()).toBe(false);
    expect(secure.secureStorageReadFailed(primary)).toBe(true);
    expect(secure.readSecureRecord(primary)).toEqual({});
    await expect(secure.flushSecureStorage()).rejects.toThrow(/安全存储.*读取失败/);
  });

  it('refuses a partial mirror even when another non-default channel has the missing provider key', async () => {
    backend.unreadable.add(primary);
    backend.invoke.mockResolvedValue(JSON.stringify([{ id: 'p1' }, { id: 'p2' }]));
    backend.values.set(gateway, JSON.stringify({
      '["p1","default"]': 'fixture-first',
      '["p2","alternate"]': 'fixture-not-default',
    }));
    const legacy = JSON.stringify([{ id: 'p1', apiKey: 'fixture-fallback' }]);
    window.localStorage.setItem('ugs_providers', legacy);

    await secure.initializeSecureStorage();

    expect(secure.secureStorageReadFailed(primary)).toBe(true);
    expect(secure.secureStorageReadFailed(gateway)).toBe(false);
    expect(secure.readSecureRecord(gateway)).toEqual({
      '["p1","default"]': 'fixture-first', '["p2","alternate"]': 'fixture-not-default',
    });
    expect(secure.readSecureRecord(primary)).toEqual({});
    expect(backend.set).not.toHaveBeenCalled();
    expect(window.localStorage.getItem('ugs_providers')).toBe(legacy);
  });

  it.each([
    ['empty configured list', '[]'],
    ['malformed configured list', '{broken'],
    ['missing stable ID', '[{"id":"p1"},{"name":"p2"}]'],
    ['duplicate stable IDs', '[{"id":"p1"},{"id":"p1"}]'],
  ])('refuses recovery with %s rather than guessing configured IDs', async (_description, metadata) => {
    backend.unreadable.add(primary);
    backend.invoke.mockResolvedValue(metadata);
    backend.values.set(gateway, JSON.stringify({ '["p1","default"]': 'fixture-mirror' }));
    window.localStorage.setItem('ugs_providers', '[{"id":"p1"}]');
    await secure.initializeSecureStorage();
    expect(secure.secureStorageReadFailed(primary)).toBe(true);
    expect(backend.set).not.toHaveBeenCalled();
  });

  it('refuses a stale localStorage subset when the authoritative metadata read fails', async () => {
    backend.unreadable.add(primary);
    backend.invoke.mockRejectedValue(new Error('fixture: metadata unreadable'));
    backend.values.set(gateway, JSON.stringify({ '["p1","default"]': 'fixture-mirror' }));
    window.localStorage.setItem('ugs_providers', '[{"id":"p1"}]');
    await secure.initializeSecureStorage();
    expect(secure.secureStorageReadFailed(primary)).toBe(true);
    expect(backend.set).not.toHaveBeenCalled();
  });

  it('does not treat stable localStorage IDs as proof that a default mirror is current', async () => {
    backend.unreadable.add(primary);
    window.localStorage.setItem('ugs_providers', '[{"id":"legacy-id"}]');
    backend.values.set(gateway, JSON.stringify({ '["legacy-id","default"]': 'fixture-mirror' }));
    await secure.initializeSecureStorage();
    expect(secure.secureStorageAvailable()).toBe(false);
    expect(secure.secureStorageReadFailed(primary)).toBe(true);
    expect(secure.readSecureRecord(primary)).toEqual({});
    expect(backend.set).not.toHaveBeenCalled();
  });

  it.each(['save', 'delete'] as const)('does not overwrite a concurrent native %s after the failed primary read begins', async (operation) => {
    backend.unreadable.add(primary);
    const legacy = JSON.stringify([{ id: 'p1', apiKey: 'fixture-fallback' }]);
    window.localStorage.setItem('ugs_providers', legacy);
    backend.values.set(gateway, JSON.stringify({ '["p1","default"]': 'fixture-mirror' }));
    const getMany = backend.getMany.getMockImplementation()!;
    let failRead!: () => void;
    backend.getMany.mockImplementation((names) => {
      if (names.length === 1 && names[0] === primary && !failRead) {
        return new Promise((_resolve, reject) => {
          failRead = () => reject(new Error('fixture: primary read failed'));
        });
      }
      return getMany(names);
    });
    const init = secure.initializeSecureStorage();
    await vi.waitFor(() => expect(failRead).toBeTypeOf('function'));
    const concurrentValue = operation === 'save' ? '{"p1":"fixture-concurrent-new"}' : '';
    backend.values.set(primary, concurrentValue);
    failRead();
    await init;

    expect(backend.values.get(primary)).toBe(concurrentValue);
    expect(secure.secureStorageAvailable()).toBe(false);
    expect(secure.secureStorageReadFailed(primary)).toBe(true);
    expect(secure.readSecureRecord(primary)).toEqual({});
    expect(secure.readSecureRecord(gateway)).toEqual({ '["p1","default"]': 'fixture-mirror' });
    expect(window.localStorage.getItem('ugs_providers')).toBe(legacy);
    expect(backend.set).not.toHaveBeenCalled();
    expect(backend.delete).not.toHaveBeenCalled();
  });

  it('does not recover primary if the gateway mirror also failed to read', async () => {
    backend.unreadable.add(primary);
    backend.unreadable.add(gateway);
    backend.invoke.mockResolvedValue('[{"id":"p1"}]');
    await secure.initializeSecureStorage();
    expect(secure.secureStorageReadFailed(primary)).toBe(true);
    expect(secure.secureStorageReadFailed(gateway)).toBe(true);
    expect(backend.set).not.toHaveBeenCalled();
  });

  it('never restores a successfully absent primary from a stale default mirror', async () => {
    window.localStorage.setItem('ugs_providers', '[{"id":"p1"}]');
    backend.values.set(gateway, JSON.stringify({ '["p1","default"]': 'fixture-stale' }));
    await secure.initializeSecureStorage();
    expect(secure.secureStorageReadFailed(primary)).toBe(false);
    expect(secure.readSecureRecord(primary)).toEqual({});
    expect(secure.secureStorageAvailable()).toBe(true);
    expect(backend.set).not.toHaveBeenCalled();
    expect(backend.invoke).not.toHaveBeenCalled();
  });

  it('does not revive a deleted primary on fresh initialization while its old default mirror remains', async () => {
    window.localStorage.setItem('ugs_providers', '[{"id":"p1"}]');
    backend.values.set(primary, JSON.stringify({ p1: 'fixture-primary' }));
    backend.values.set(gateway, JSON.stringify({ '["p1","default"]': 'fixture-stale' }));
    await secure.initializeSecureStorage();
    await secure.writeSecureRecordAwaited(primary, {});
    expect(backend.delete).toHaveBeenCalledWith(primary);
    secure.resetSecureStorageForTests();
    await secure.initializeSecureStorage();
    expect(secure.readSecureRecord(primary)).toEqual({});
    expect(secure.secureStorageAvailable()).toBe(true);
    expect(backend.set).not.toHaveBeenCalled();
  });

  it.each(['clear key', 'delete provider'] as const)('does not resurrect a partial provider deletion after %s when the quit mirror survives quota failure', async (operation) => {
    const providers = [
      { id: 'p1', kind: 'anthropic', name: 'Deleted', baseUrl: '' },
      { id: 'p2', kind: 'anthropic', name: 'Kept', baseUrl: '' },
    ];
    window.localStorage.setItem('ugs_providers', JSON.stringify(providers));
    backend.values.set(primary, JSON.stringify({ p1: 'fixture-deleted', p2: 'fixture-kept' }));
    await secure.initializeSecureStorage();
    secure.flushSecretsToLocalStorageFallback();
    const staleMirror = window.localStorage.getItem('ugs_providers');
    expect(staleMirror).toContain('fixture-deleted');
    const quota = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('fixture: quota full', 'QuotaExceededError');
    });
    try {
      secure.setSecureRecordValue(primary, 'p1', '');
      const remainingProviders = operation === 'delete provider' ? providers.slice(1) : providers;
      expect(() => window.localStorage.setItem('ugs_providers', JSON.stringify(remainingProviders))).toThrow('fixture: quota full');
      secure.flushSecretsToLocalStorageFallback();
      await secure.flushSecureStorage();
      expect(backend.values.get(primary)).toBe('{"p2":"fixture-kept"}');
      backend.set.mockClear();
      secure.resetSecureStorageForTests();
      await secure.initializeSecureStorage();
      await secure.flushSecureStorage();

      expect(secure.readSecureRecord(primary)).toEqual({ p2: 'fixture-kept' });
      expect(backend.values.get(primary)).toBe('{"p2":"fixture-kept"}');
      expect(backend.set).not.toHaveBeenCalled();
      expect(window.localStorage.getItem('ugs_providers')).toBe(staleMirror);
    } finally {
      quota.mockRestore();
    }
    secure.resetSecureStorageForTests();
    await secure.initializeSecureStorage();
    expect(secure.readSecureRecord(primary)).toEqual({ p2: 'fixture-kept' });
    expect(window.localStorage.getItem('ugs_providers')).not.toContain('apiKey');
  });

  it('does not resurrect the exact default gateway deletion while an alternate survives quota failure', async () => {
    const defaultKey = secure.gatewayChannelSecretKey('p1', 'default');
    const alternateKey = secure.gatewayChannelSecretKey('p1', 'alternate');
    const config = { providers: [{ id: 'p1', channels: [
      { id: 'default' }, { id: 'alternate' },
    ] }] };
    window.localStorage.setItem('ugs_model_gateway_v1', JSON.stringify(config));
    backend.values.set(gateway, JSON.stringify({ [defaultKey]: 'fixture-deleted', [alternateKey]: 'fixture-kept' }));
    await secure.initializeSecureStorage();
    secure.flushSecretsToLocalStorageFallback();
    const staleMirror = window.localStorage.getItem('ugs_model_gateway_v1');
    expect(staleMirror).toContain('fixture-deleted');
    const quota = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('fixture: quota full', 'QuotaExceededError');
    });
    try {
      secure.setSecureRecordValue(gateway, defaultKey, '');
      secure.flushSecretsToLocalStorageFallback();
      await secure.flushSecureStorage();
      expect(backend.values.get(gateway)).toBe(JSON.stringify({ [alternateKey]: 'fixture-kept' }));
      backend.set.mockClear();
      secure.resetSecureStorageForTests();
      await secure.initializeSecureStorage();
      await secure.flushSecureStorage();

      expect(secure.readSecureRecord(gateway)).toEqual({ [alternateKey]: 'fixture-kept' });
      expect(backend.values.get(gateway)).toBe(JSON.stringify({ [alternateKey]: 'fixture-kept' }));
      expect(backend.set).not.toHaveBeenCalled();
      expect(backend.delete).not.toHaveBeenCalled();
      expect(window.localStorage.getItem('ugs_model_gateway_v1')).toBe(staleMirror);
    } finally {
      quota.mockRestore();
    }
    secure.resetSecureStorageForTests();
    await secure.initializeSecureStorage();
    expect(secure.readSecureRecord(gateway)).toEqual({ [alternateKey]: 'fixture-kept' });
    expect(window.localStorage.getItem('ugs_model_gateway_v1')).not.toContain('apiKey');
  });

  it('does not rewrite healthy secrets or replace a conflicting primary with an older mirror', async () => {
    window.localStorage.setItem('ugs_providers', '[{"id":"p1","apiKey":"fixture-old-inline"}]');
    backend.values.set(primary, JSON.stringify({ p1: 'fixture-authoritative', orphan: 'fixture-orphan' }));
    backend.values.set(gateway, JSON.stringify({ '["p1","default"]': 'fixture-old-mirror' }));
    await secure.initializeSecureStorage();
    expect(secure.readSecureRecord(primary)).toEqual({ p1: 'fixture-authoritative', orphan: 'fixture-orphan' });
    expect(secure.secureStorageAvailable()).toBe(true);
    expect(backend.set).not.toHaveBeenCalled();
    expect(backend.delete).not.toHaveBeenCalled();
    expect(window.localStorage.getItem('ugs_providers')).toBe('[{"id":"p1"}]');
  });

  it('rejects synchronous writes while failed-primary initialization is still reading', async () => {
    backend.unreadable.add(primary);
    backend.values.set(gateway, JSON.stringify({ '["p1","default"]': 'fixture-mirror' }));
    const getMany = backend.getMany.getMockImplementation()!;
    let failRead!: () => void;
    backend.getMany.mockImplementation((names) => {
      if (names.length === 1 && names[0] === primary && !failRead) {
        return new Promise((_resolve, reject) => {
          failRead = () => reject(new Error('fixture: primary read failed'));
        });
      }
      return getMany(names);
    });
    const init = secure.initializeSecureStorage();
    await vi.waitFor(() => expect(failRead).toBeTypeOf('function'));
    let writeError: unknown;
    try {
      secure.writeSecureRecord(gateway, { '["p1","default"]': 'fixture-unsafe-edit' });
    } catch (error) { writeError = error; }
    failRead();
    await init;
    expect(writeError).toBeInstanceOf(Error);
    expect(String(writeError)).toMatch(/安全存储.*初始化/);
    expect(secure.secureStorageReadFailed(primary)).toBe(true);
    expect(secure.readSecureRecord(primary)).toEqual({});
  });

  it.each([
    'ugs_free_channel_keys_v1',
    'owf_free_channel_keys_v1',
    'ultragamestudio.free_channel_keys_v1',
    'ultragamestudio.freeChannels.keys',
  ].flatMap((storageKey) => [
    [storageKey, '{"kept":"fixture-newer"}'],
    [storageKey, '{}'],
  ]))('keeps the existing native free-key record authoritative over stale %s fallback (%s)', async (storageKey, nativeValue) => {
    const name = secure.FREE_CHANNEL_API_KEYS_SECRET;
    backend.values.set(name, nativeValue);
    window.localStorage.setItem(storageKey, '{"kept":"fixture-stale","deleted":"fixture-deleted"}');

    await secure.initializeSecureStorage();
    await secure.flushSecureStorage();

    expect(secure.readSecureRecord(name)).toEqual(JSON.parse(nativeValue));
    expect(backend.values.get(name)).toBe(nativeValue);
    expect(secure.secureStorageAvailable()).toBe(true);
    expect(backend.set).not.toHaveBeenCalled();
    expect(backend.delete).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(storageKey)).toBeNull();
    secure.resetSecureStorageForTests();
    await secure.initializeSecureStorage();
    expect(secure.readSecureRecord(name)).toEqual(JSON.parse(nativeValue));
    expect(backend.set).not.toHaveBeenCalled();
  });

  it('does not roll a healthy native proxy token back to a different stale quit fallback', async () => {
    const name = secure.FREE_PROXY_TOKEN_SECRET;
    backend.values.set(name, 'fixture-newer-token');
    window.localStorage.setItem('ugs_free_proxy_token_v1', 'fixture-stale-token');

    await secure.initializeSecureStorage();
    await secure.flushSecureStorage();

    expect(secure.readSecureSecret(name)).toBe('fixture-newer-token');
    expect(backend.values.get(name)).toBe('fixture-newer-token');
    expect(secure.secureStorageAvailable()).toBe(true);
    expect(backend.set).not.toHaveBeenCalled();
    expect(backend.delete).not.toHaveBeenCalled();
    expect(window.localStorage.getItem('ugs_free_proxy_token_v1')).toBeNull();
    secure.resetSecureStorageForTests();
    await secure.initializeSecureStorage();
    expect(secure.readSecureSecret(name)).toBe('fixture-newer-token');
    expect(backend.set).not.toHaveBeenCalled();
  });

  it('does not rewrite a healthy proxy token from the identical quit fallback', async () => {
    backend.values.set(secure.FREE_PROXY_TOKEN_SECRET, 'fixture-proxy');
    window.localStorage.setItem('ugs_free_proxy_token_v1', 'fixture-proxy');
    await secure.initializeSecureStorage();
    expect(secure.secureStorageAvailable()).toBe(true);
    expect(backend.set).not.toHaveBeenCalled();
    expect(window.localStorage.getItem('ugs_free_proxy_token_v1')).toBeNull();
  });

  it('does not revive a primary tombstone from stale inline provider secrets on fresh boot', async () => {
    backend.values.set(primary, ''); // IPC distinguishes explicit deletion from an omitted/missing entry.
    backend.values.set(gateway, JSON.stringify({ '["p1","default"]': 'fixture-stale-default' }));
    window.localStorage.setItem('ugs_providers', '[{"id":"p1","apiKey":"fixture-stale-inline"}]');

    await secure.initializeSecureStorage();

    expect(secure.readSecureRecord(primary)).toEqual({});
    expect(secure.secureStorageReadFailed(primary)).toBe(false);
    expect(secure.secureStorageAvailable()).toBe(true);
    expect(backend.values.get(primary)).toBe('');
    expect(backend.set).not.toHaveBeenCalled();
    expect(backend.delete).not.toHaveBeenCalled();
    expect(window.localStorage.getItem('ugs_providers')).toBe('[{"id":"p1"}]');

    secure.resetSecureStorageForTests();
    await secure.initializeSecureStorage();
    expect(secure.readSecureRecord(primary)).toEqual({});
    expect(backend.set).not.toHaveBeenCalled();
  });

  it.each([
    [gateway, 'ugs_model_gateway_v1', '{"version":1,"providers":[{"id":"p1","channels":[{"id":"default","apiKey":"fixture-stale"}]}]}'],
    [secure.FREE_CHANNEL_API_KEYS_SECRET, 'ugs_free_channel_keys_v1', '{"p1":"fixture-stale"}'],
    [secure.FREE_PROXY_TOKEN_SECRET, 'ugs_free_proxy_token_v1', 'fixture-stale'],
  ])('does not migrate stale inline data over the %s tombstone', async (name, storageKey, legacy) => {
    backend.values.set(name, '');
    window.localStorage.setItem(storageKey, legacy);
    await secure.initializeSecureStorage();
    expect(secure.readSecureSecret(name)).toBe('');
    expect(secure.secureStorageAvailable()).toBe(true);
    expect(backend.values.get(name)).toBe('');
    expect(backend.set).not.toHaveBeenCalled();
  });

  it.each([
    [primary, 'ugs_providers', '[{"id":"p1","apiKey":"fixture-stale"}]'],
    [gateway, 'ugs_model_gateway_v1', '{"providers":[{"id":"p1","channels":[{"id":"default","apiKey":"fixture-stale"}]}]}'],
  ])('does not treat an own existing empty JSON %s record as missing', async (name, storageKey, inline) => {
    backend.values.set(name, '{}');
    window.localStorage.setItem(storageKey, inline);
    await secure.initializeSecureStorage();
    await secure.flushSecureStorage();
    expect(secure.readSecureRecord(name)).toEqual({});
    expect(backend.values.get(name)).toBe('{}');
    expect(backend.set).not.toHaveBeenCalled();
    expect(backend.delete).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(storageKey)).not.toContain('apiKey');
  });

  it.each([primary, gateway, secure.FREE_CHANNEL_API_KEYS_SECRET, secure.FREE_PROXY_TOKEN_SECRET])('keeps every inline recovery source untouched when %s cannot be read', async (name) => {
    const sources = {
      ugs_providers: '[{"id":"p1","apiKey":"fixture-provider"}]',
      ugs_model_gateway_v1: '{"providers":[{"id":"p1","channels":[{"id":"default","apiKey":"fixture-gateway"}]}]}',
      ugs_free_channel_keys_v1: '{"free":"fixture-free"}',
      owf_free_channel_keys_v1: '{"legacy":"fixture-legacy-free"}',
      ugs_free_proxy_token_v1: 'fixture-proxy',
    };
    for (const [key, value] of Object.entries(sources)) window.localStorage.setItem(key, value);
    backend.unreadable.add(name);

    await secure.initializeSecureStorage();
    await expect(secure.flushSecureStorage()).rejects.toThrow(/安全存储.*读取失败/);

    expect(secure.secureStorageReadFailed(name)).toBe(true);
    expect(secure.secureStorageAvailable()).toBe(false);
    expect(backend.set).not.toHaveBeenCalled();
    expect(backend.delete).not.toHaveBeenCalled();
    for (const [key, value] of Object.entries(sources)) expect(window.localStorage.getItem(key)).toBe(value);
  });

  it.each([
    [gateway, 'ugs_model_gateway_v1', '{"providers":[{"id":"p1","channels":[{"id":"default","apiKey":"fixture-first"}]}]}', JSON.stringify({ '["p1","default"]': 'fixture-first' })],
    [secure.FREE_CHANNEL_API_KEYS_SECRET, 'ugs_free_channel_keys_v1', '{"free":"fixture-first"}', '{"free":"fixture-first"}'],
    [secure.FREE_PROXY_TOKEN_SECRET, 'ugs_free_proxy_token_v1', 'fixture-first', 'fixture-first'],
  ])('still imports %s only when its native logical record is omitted and verifies before stripping', async (name, storageKey, inline, expectedValue) => {
    window.localStorage.setItem(storageKey, inline);
    if (name === secure.FREE_CHANNEL_API_KEYS_SECRET) {
      window.localStorage.setItem('owf_free_channel_keys_v1', '{"legacy":"fixture-legacy-first"}');
      expectedValue = '{"free":"fixture-first","legacy":"fixture-legacy-first"}';
    }

    await secure.initializeSecureStorage();
    await secure.flushSecureStorage();

    expect(secure.readSecureSecret(name)).toBe(expectedValue);
    expect(backend.values.get(name)).toBe(expectedValue);
    expect(backend.set.mock.calls).toEqual([[name, expectedValue]]);
    expect(backend.getMany.mock.calls.at(-1)).toEqual([[name]]);
    expect(secure.secureStorageAvailable()).toBe(true);
    if (name === gateway) expect(window.localStorage.getItem(storageKey)).not.toContain('apiKey');
    else expect(window.localStorage.getItem(storageKey)).toBeNull();
    expect(window.localStorage.getItem('owf_free_channel_keys_v1')).toBeNull();
    secure.resetSecureStorageForTests();
    await secure.initializeSecureStorage();
    expect(secure.readSecureSecret(name)).toBe(expectedValue);
    expect(backend.set).toHaveBeenCalledOnce();
  });

  it.each([
    [gateway, 'ugs_model_gateway_v1', '{"providers":[{"id":"p1","channels":[{"id":"default","apiKey":"fixture-first"}]}]}'],
    [secure.FREE_CHANNEL_API_KEYS_SECRET, 'ugs_free_channel_keys_v1', '{"free":"fixture-first"}'],
    [secure.FREE_PROXY_TOKEN_SECRET, 'ugs_free_proxy_token_v1', 'fixture-first'],
  ])('preserves the %s migration source when a resolved native write fails readback', async (name, storageKey, inline) => {
    window.localStorage.setItem(storageKey, inline);
    backend.set.mockResolvedValue(undefined);

    await secure.initializeSecureStorage();

    expect(window.localStorage.getItem(storageKey)).toBe(inline);
    expect(secure.readSecureSecret(name)).toBe('');
    expect(secure.secureStorageAvailable()).toBe(false);
    expect(secure.secureStorageReadFailed(name)).toBe(true);
    expect(backend.values.has(name)).toBe(false);
    expect(backend.getMany.mock.calls.at(-1)).toEqual([[name]]);
    await expect(secure.flushSecureStorage()).rejects.toThrow(/安全存储.*读取失败/);
  });

  it('still migrates and verifies first-time legacy keys when the native primary entry is genuinely missing', async () => {
    window.localStorage.setItem('ugs_providers', '[{"id":"p1","apiKey":"fixture-first-migration"}]');
    await secure.initializeSecureStorage();
    expect(secure.readSecureRecord(primary)).toEqual({ p1: 'fixture-first-migration' });
    expect(secure.secureStorageAvailable()).toBe(true);
    expect(backend.set.mock.calls).toEqual([[primary, '{"p1":"fixture-first-migration"}']]);
    expect(backend.getMany.mock.calls.at(-1)).toEqual([[primary]]);
    expect(window.localStorage.getItem('ugs_providers')).toBe('[{"id":"p1"}]');
  });
});
