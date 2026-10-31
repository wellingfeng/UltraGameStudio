import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  secureSecretGetMany: vi.fn(async () => ({} as Record<string, string>)),
  secureSecretSet: vi.fn<(key: string, value: string) => Promise<void>>(),
  secureSecretDelete: vi.fn<(key: string) => Promise<void>>(async () => undefined),
}));

vi.mock('@/lib/tauri', () => ({
  isTauri: () => true,
  secureSecretGetMany: mocks.secureSecretGetMany,
  secureSecretSet: mocks.secureSecretSet,
  secureSecretDelete: mocks.secureSecretDelete,
}));

describe('secure storage persistence', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.secureSecretSet.mockResolvedValue(undefined);
    const secure = await import('@/lib/secureStorage');
    secure.resetSecureStorageForTests();
    await secure.initializeSecureStorage();
  });

  it('serializes rapid writes to the same key so the newest value wins', async () => {
    const secure = await import('@/lib/secureStorage');
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    mocks.secureSecretSet
      .mockImplementationOnce(async () => firstGate)
      .mockResolvedValueOnce(undefined);

    secure.writeSecureSecret('rapid.secret', 'first');
    secure.writeSecureSecret('rapid.secret', 'second');
    secure.writeSecureSecret('rapid.secret', 'third');

    await vi.waitFor(() => expect(mocks.secureSecretSet).toHaveBeenCalledTimes(1));
    releaseFirst();
    await secure.flushSecureStorage();

    expect(mocks.secureSecretSet.mock.calls).toEqual([
      ['rapid.secret', 'first'],
      ['rapid.secret', 'third'],
    ]);
  });

  it.each([
    ['save', 'success'], ['save', 'failure'],
    ['delete', 'success'], ['delete', 'failure'],
  ] as const)('awaits an identical optimistic %s through delayed native %s', async (operation, completion) => {
    const secure = await import('@/lib/secureStorage');
    const name = secure.PROVIDER_API_KEYS_SECRET;
    const previous = '{"p1":"fixture-old"}';
    await secure.writeSecureRecordAwaited(name, { p1: 'fixture-old' });
    mocks.secureSecretSet.mockClear();
    let durableValue = previous;
    const record: Record<string, string> = operation === 'save' ? { p1: 'fixture-new' } : {};
    const serialized = operation === 'save' ? '{"p1":"fixture-new"}' : '';
    const nativeError = new Error('fixture: delayed durable failure');
    let releaseWrite!: () => void;
    const delayedWrite = new Promise<void>((resolve, reject) => {
      releaseWrite = () => {
        if (completion === 'failure') reject(nativeError);
        else {
          durableValue = serialized;
          resolve();
        }
      };
    });
    if (operation === 'save') mocks.secureSecretSet.mockImplementationOnce(() => delayedWrite);
    else mocks.secureSecretDelete.mockImplementationOnce(() => delayedWrite);
    expect(secure.writeSecureRecord(name, record)).toBe(true);
    let saveFinished = false;
    const awaitedSave = secure.writeSecureRecordAwaited(name, record);
    const outcome = awaitedSave.then(
      () => { saveFinished = true; return { error: null }; },
      (error: unknown) => { saveFinished = true; return { error }; },
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const returnedEarly = saveFinished;
    const durableBeforeCompletion = durableValue;
    releaseWrite();
    const result = await outcome;
    if (completion === 'failure') {
      await expect(secure.flushSecureStorage()).rejects.toThrow('fixture: delayed durable failure');
      expect(result.error).toBe(nativeError);
      expect(durableValue).toBe(previous);
    } else {
      await secure.flushSecureStorage();
      expect(result.error).toBeNull();
      expect(durableValue).toBe(serialized);
    }

    expect(returnedEarly).toBe(false);
    expect(durableBeforeCompletion).toBe(previous);
    expect(secure.readSecureRecord(name)).toEqual(record);
    const nativeWrite = operation === 'save' ? mocks.secureSecretSet : mocks.secureSecretDelete;
    expect(nativeWrite).toHaveBeenCalledOnce();
  });

  it('surfaces a durable write failure from flushSecureStorage', async () => {
    const secure = await import('@/lib/secureStorage');
    mocks.secureSecretSet.mockRejectedValueOnce(new Error('credential too large'));

    secure.writeSecureSecret('failed.secret', 'value');

    await expect(secure.flushSecureStorage()).rejects.toThrow(
      '安全存储写入失败 (failed.secret)',
    );
  });
});
