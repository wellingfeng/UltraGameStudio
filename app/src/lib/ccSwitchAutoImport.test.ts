import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  importCcSwitchClaude: vi.fn(),
  importProviders: vi.fn(),
  isTauri: vi.fn(),
  listProviders: vi.fn(),
  loadGatewayConfig: vi.fn(),
  modelClassFromModelId: vi.fn(),
  patchConfig: vi.fn(),
  providerMetadataSignature: vi.fn(),
  saveGatewayConfig: vi.fn(),
  setActiveProviderId: vi.fn(),
  setActiveGatewaySelection: vi.fn(),
  isRemoteProfileActive: vi.fn(),
  flushRemoteProfileWrites: vi.fn(),
}));

vi.mock('@/lib/apiConfig', () => ({
  importProviders: mocks.importProviders,
  listProviders: mocks.listProviders,
  providerMetadataSignature: mocks.providerMetadataSignature,
  setActiveProviderId: mocks.setActiveProviderId,
}));

vi.mock('@/lib/gatewayConfig', () => ({
  loadGatewayConfig: mocks.loadGatewayConfig,
  modelClassFromModelId: mocks.modelClassFromModelId,
  saveGatewayConfig: mocks.saveGatewayConfig,
  setActiveGatewaySelection: mocks.setActiveGatewaySelection,
}));

vi.mock('@/lib/settingsProfile', () => ({
  isRemoteProfileActive: mocks.isRemoteProfileActive,
  flushRemoteProfileWrites: mocks.flushRemoteProfileWrites,
}));

vi.mock('@/lib/tauri', () => ({
  importCcSwitchClaude: mocks.importCcSwitchClaude,
  isTauri: mocks.isTauri,
}));

vi.mock('@/store/history/store', () => ({
  historyStore: {
    getConfig: mocks.getConfig,
    patchConfig: mocks.patchConfig,
  },
}));

import {
  importCcSwitchProviders,
  maybeRunCcSwitchAutoImportOnFirstRun,
} from '@/lib/ccSwitchAutoImport';

const ccSwitchProvider = {
  kind: 'anthropic',
  name: 'Claude Team',
  apiKey: 'sk-cc-switch',
  baseUrl: 'https://proxy.example/v1',
  transport: 'cli',
  model: 'claude-sonnet-4',
  ccId: 'cc_anthropic_team',
} as const;

beforeEach(() => {
  vi.restoreAllMocks();
  mocks.getConfig.mockReset();
  mocks.importCcSwitchClaude.mockReset();
  mocks.importProviders.mockReset();
  mocks.isTauri.mockReset();
  mocks.listProviders.mockReset();
  mocks.loadGatewayConfig.mockReset();
  mocks.modelClassFromModelId.mockReset();
  mocks.patchConfig.mockReset();
  mocks.providerMetadataSignature.mockReset();
  mocks.saveGatewayConfig.mockReset();
  mocks.setActiveProviderId.mockReset();
  mocks.setActiveGatewaySelection.mockReset();
  mocks.isRemoteProfileActive.mockReset();
  mocks.flushRemoteProfileWrites.mockReset();

  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);

  mocks.isTauri.mockReturnValue(true);
  mocks.isRemoteProfileActive.mockReturnValue(false);
  mocks.flushRemoteProfileWrites.mockResolvedValue([]);
  mocks.getConfig.mockResolvedValue({ schemaVersion: 1 });
  mocks.importCcSwitchClaude.mockResolvedValue({
    providers: [ccSwitchProvider],
    active: { anthropic: ccSwitchProvider.ccId },
  });
  mocks.importProviders.mockReturnValue({ imported: 1, skipped: 0 });
  mocks.listProviders.mockReturnValue([
    {
      id: 'p_cc_switch',
      kind: 'anthropic',
      name: 'Claude Team',
      apiKey: 'sk-cc-switch',
      baseUrl: 'https://proxy.example/v1',
      transport: 'cli',
      model: 'claude-sonnet-4',
    },
  ]);
  mocks.providerMetadataSignature.mockImplementation(
    (provider: {
      kind?: string;
      transport?: string;
      name: string;
      baseUrl: string;
      model?: string;
    }) =>
      [
        provider.kind ?? 'anthropic',
        provider.transport ?? 'direct',
        provider.name,
        provider.baseUrl.replace(/\/+$/, ''),
        provider.model ?? '',
      ].join('|'),
  );
  mocks.loadGatewayConfig.mockReturnValue({ version: 1, providers: [] });
  mocks.modelClassFromModelId.mockReturnValue('sonnet');
  mocks.patchConfig.mockImplementation(
    async (patch: Record<string, unknown>) => ({
      schemaVersion: 1,
      ...patch,
    }),
  );
});

describe('maybeRunCcSwitchAutoImportOnFirstRun', () => {
  it('imports cc-switch providers on first startup and records the one-shot marker', async () => {
    await maybeRunCcSwitchAutoImportOnFirstRun();

    expect(mocks.getConfig).toHaveBeenCalledTimes(1);
    expect(mocks.patchConfig).toHaveBeenCalledTimes(2);
    expect(mocks.patchConfig).toHaveBeenNthCalledWith(1, {
      ccSwitchAutoImport: expect.objectContaining({
        version: 1,
        status: 'failed',
        reason: expect.stringContaining('started'),
      }),
    });
    expect(mocks.importProviders).toHaveBeenCalledWith(
      [
        {
          kind: 'anthropic',
          name: 'Claude Team',
          apiKey: 'sk-cc-switch',
          baseUrl: 'https://proxy.example/v1',
          transport: 'cli',
          model: 'claude-sonnet-4',
        },
      ],
      undefined,
      { collapseTransport: true },
    );
    expect(mocks.saveGatewayConfig).toHaveBeenCalledWith({
      version: 1,
      providers: [
        expect.objectContaining({
          id: 'p_cc_switch',
          adapter: 'claude-code',
          channels: [
            expect.objectContaining({
              route: expect.objectContaining({ transport: 'cli' }),
            }),
          ],
        }),
      ],
    });
    expect(mocks.patchConfig).toHaveBeenNthCalledWith(2, {
      ccSwitchAutoImport: expect.objectContaining({
        version: 1,
        status: 'imported',
        importedCount: 1,
      }),
    });
  });

  it('promotes the active cc-switch Claude provider into the gateway selector on manual import', async () => {
    const outcome = await importCcSwitchProviders({ promoteActiveAnthropic: true });

    expect(outcome.status).toBe('imported');
    expect(mocks.setActiveProviderId).toHaveBeenCalledWith('p_cc_switch');
    expect(mocks.setActiveGatewaySelection).toHaveBeenCalledWith({
      adapter: 'claude-code',
      modelClass: 'sonnet',
      providerId: 'p_cc_switch',
      channelId: 'default',
    });
  });

  it('verifies remote sync when a remote profile is active and fails loudly when it does not land', async () => {
    mocks.isRemoteProfileActive.mockReturnValue(true);
    mocks.flushRemoteProfileWrites.mockResolvedValue([
      { relPath: 'settings/providers.v1.json', ok: false, error: 'unauthorized' },
    ]);

    const outcome = await importCcSwitchProviders({ promoteActiveAnthropic: true });

    expect(outcome.status).toBe('failed');
    expect(outcome.reason).toContain('REMOTE_SYNC_FAILED');
    expect(outcome.reason).toContain('unauthorized');
    // The local import work still ran; only the remote-sync verification failed.
    expect(mocks.importProviders).toHaveBeenCalled();
  });

  it('reports success when a remote profile is active and the remote sync lands', async () => {
    mocks.isRemoteProfileActive.mockReturnValue(true);
    mocks.flushRemoteProfileWrites.mockResolvedValue([
      { relPath: 'settings/providers.v1.json', ok: true },
    ]);

    const outcome = await importCcSwitchProviders({ promoteActiveAnthropic: true });

    expect(outcome.status).toBe('imported');
    expect(mocks.flushRemoteProfileWrites).toHaveBeenCalled();
  });

  it('does not block local-profile imports on remote-sync verification', async () => {
    mocks.isRemoteProfileActive.mockReturnValue(false);

    const outcome = await importCcSwitchProviders({ promoteActiveAnthropic: true });

    expect(outcome.status).toBe('imported');
    expect(mocks.flushRemoteProfileWrites).not.toHaveBeenCalled();
  });

  it('records cc-switch parsing failures without throwing or importing providers', async () => {
    mocks.importCcSwitchClaude.mockRejectedValue(
      new SyntaxError('Unexpected token in cc-switch data'),
    );

    await expect(maybeRunCcSwitchAutoImportOnFirstRun()).resolves.toBeUndefined();

    expect(mocks.importProviders).not.toHaveBeenCalled();
    expect(mocks.patchConfig).toHaveBeenCalledTimes(2);
    expect(mocks.patchConfig).toHaveBeenNthCalledWith(2, {
      ccSwitchAutoImport: expect.objectContaining({
        version: 1,
        status: 'failed',
        importedCount: 0,
        reason: expect.stringContaining('Unexpected token'),
      }),
    });
  });

  it('swallows history write failures after import so startup keeps running', async () => {
    mocks.patchConfig
      .mockResolvedValueOnce({
        schemaVersion: 1,
        ccSwitchAutoImport: {
          version: 1,
          attemptedAt: '2026-05-31T00:00:00.000Z',
          status: 'failed',
        },
      })
      .mockRejectedValueOnce(new Error('disk full'));

    await expect(maybeRunCcSwitchAutoImportOnFirstRun()).resolves.toBeUndefined();

    expect(mocks.importCcSwitchClaude).toHaveBeenCalledTimes(1);
    expect(mocks.importProviders).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        '[cc-switch:auto-import] failed: unexpected startup import failure',
      ),
      'disk full',
    );
  });

  it('skips later startups once the auto-import marker exists', async () => {
    mocks.getConfig.mockResolvedValue({
      schemaVersion: 1,
      ccSwitchAutoImport: {
        version: 1,
        attemptedAt: '2026-05-31T00:00:00.000Z',
        status: 'imported',
        importedCount: 1,
      },
    });

    await maybeRunCcSwitchAutoImportOnFirstRun();

    expect(mocks.patchConfig).not.toHaveBeenCalled();
    expect(mocks.importCcSwitchClaude).not.toHaveBeenCalled();
    expect(mocks.importProviders).not.toHaveBeenCalled();
  });
});
