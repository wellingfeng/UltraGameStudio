import { afterEach, describe, expect, it } from 'vitest';
import {
  ACTIVE_PROVIDER_BY_KIND_STORAGE,
  ACTIVE_PROVIDER_STORAGE,
  PROVIDERS_STORAGE,
  addProvider,
  exportDefaultChannelsConfig,
  getActiveProvider,
  getActiveProviderId,
  getProviderRuntimeInfo,
  importDefaultChannelsConfig,
  importProviders,
  listProviders,
  readApiKey,
  readBaseUrl,
  type Provider,
} from './apiConfig';

function seedProviders(entries: unknown[], activeId?: string): void {
  window.localStorage.setItem(PROVIDERS_STORAGE, JSON.stringify(entries));
  if (activeId === undefined) {
    window.localStorage.removeItem(ACTIVE_PROVIDER_STORAGE);
    return;
  }
  window.localStorage.setItem(ACTIVE_PROVIDER_STORAGE, activeId);
}

afterEach(() => {
  window.localStorage.clear();
});

describe('apiConfig provider compatibility', () => {
  it('falls back to the first stored provider when active id is missing', () => {
    seedProviders([
      {
        id: 'p_1',
        kind: 'anthropic',
        name: 'Primary',
        apiKey: '  sk-test-primary  ',
        baseUrl: 'https://proxy.example/v1/',
      },
      {
        id: 'p_2',
        kind: 'anthropic',
        name: 'Secondary',
        apiKey: 'sk-test-secondary',
        baseUrl: '',
      },
    ]);

    expect(getActiveProviderId()).toBe('p_1');
    expect(getActiveProvider()?.id).toBe('p_1');
    expect(readApiKey()).toBe('sk-test-primary');
    expect(readBaseUrl()).toBe('https://proxy.example/v1/');
  });

  it('normalizes legacy stored records and ignores dangling active ids', () => {
    seedProviders(
      [
        {
          id: 'legacy_1',
          adapter: 'claude-code',
          name: 'Claude',
          apiKey: 'legacy-key',
          baseUrl: 'https://api.anthropic.com',
        },
      ],
      'missing-id',
    );

    expect(getActiveProviderId()).toBe('legacy_1');
    expect(readApiKey()).toBe('legacy-key');
    expect(readBaseUrl()).toBe('https://api.anthropic.com');
    expect(listProviders()[0]).toMatchObject({
      id: 'legacy_1',
      kind: 'anthropic',
      name: 'Claude',
    } satisfies Partial<Provider>);
  });

  it('keeps the resolved active provider stable when adding after a missing active id', () => {
    seedProviders([
      {
        id: 'p_1',
        kind: 'anthropic',
        name: 'Primary',
        apiKey: 'sk-test-primary',
        baseUrl: '',
      },
    ]);

    addProvider({
      kind: 'anthropic',
      name: 'Secondary',
      apiKey: 'sk-test-secondary',
      baseUrl: '',
    });

    expect(getActiveProviderId()).toBe('p_1');
  });

  it('skips duplicate imports without overwriting user-edited provider details', () => {
    seedProviders(
      [
        {
          id: 'p_1',
          kind: 'anthropic',
          name: 'Claude',
          apiKey: 'manual-key',
          baseUrl: 'https://proxy.example/v1',
          model: 'claude-sonnet-4',
        },
      ],
      'p_1',
    );

    const result = importProviders([
      {
        kind: 'anthropic',
        name: 'Claude',
        apiKey: 'cc-switch-key',
        baseUrl: 'https://proxy.example/v1/',
        model: 'claude-sonnet-4',
      },
    ]);

    expect(result).toEqual({ imported: 0, skipped: 1 });
    expect(listProviders()).toHaveLength(1);
    expect(listProviders()[0]).toMatchObject({
      id: 'p_1',
      apiKey: 'manual-key',
      baseUrl: 'https://proxy.example/v1',
    });
    expect(readApiKey()).toBe('manual-key');
  });

  it('keeps direct and cli-backed providers distinct even when their metadata matches', () => {
    seedProviders([
      {
        id: 'p_1',
        kind: 'anthropic',
        name: 'Claude',
        apiKey: 'manual-key',
        baseUrl: 'https://relay.example/v1',
        model: 'custom-model',
      },
    ]);

    const result = importProviders([
      {
        kind: 'anthropic',
        name: 'Claude',
        apiKey: 'imported-key',
        baseUrl: 'https://relay.example/v1',
        transport: 'cli',
        model: 'custom-model',
      },
    ]);

    expect(result).toEqual({ imported: 1, skipped: 0 });
    expect(listProviders()).toHaveLength(2);
  });

  it('collapses a stale direct entry into the cli import instead of duplicating (cc-switch)', () => {
    seedProviders(
      [
        {
          id: 'p_stale_direct',
          kind: 'anthropic',
          name: 'Kimi',
          apiKey: 'sk-old',
          baseUrl: 'https://api.kimi.com/coding/',
          model: 'kimi-for-coding',
        },
      ],
      'p_stale_direct',
    );

    const result = importProviders(
      [
        {
          kind: 'anthropic',
          name: 'Kimi',
          apiKey: 'sk-new',
          baseUrl: 'https://api.kimi.com/coding/',
          transport: 'cli',
          model: 'kimi-for-coding',
        },
      ],
      undefined,
      { collapseTransport: true },
    );

    // No duplicate: the stale direct entry is upgraded to the cli runtime.
    expect(result).toEqual({ imported: 0, skipped: 1 });
    const providers = listProviders();
    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({
      id: 'p_stale_direct',
      transport: 'cli',
      apiKey: 'sk-new',
    });
    // The active pointer still resolves to the surviving (upgraded) entry.
    expect(getActiveProviderId()).toBe('p_stale_direct');
  });

  it('folds away a pre-existing direct+cli duplicate pair on re-import (cc-switch)', () => {
    seedProviders([
      {
        id: 'p_direct',
        kind: 'anthropic',
        name: 'Kimi',
        apiKey: 'sk-direct',
        baseUrl: 'https://api.kimi.com/coding/',
        model: 'kimi-for-coding',
      },
      {
        id: 'p_cli',
        kind: 'anthropic',
        transport: 'cli',
        name: 'Kimi',
        apiKey: 'sk-cli',
        baseUrl: 'https://api.kimi.com/coding/',
        model: 'kimi-for-coding',
      },
    ]);

    const result = importProviders(
      [
        {
          kind: 'anthropic',
          name: 'Kimi',
          apiKey: 'sk-new',
          baseUrl: 'https://api.kimi.com/coding/',
          transport: 'cli',
          model: 'kimi-for-coding',
        },
      ],
      undefined,
      { collapseTransport: true },
    );

    // The two stale copies collapse to one cli-backed entry.
    expect(result).toEqual({ imported: 0, skipped: 1 });
    const providers = listProviders();
    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({ id: 'p_cli', transport: 'cli' });
  });

  it('prefers a cli-backed anthropic provider when no explicit active id is stored', () => {
    seedProviders([
      {
        id: 'p_direct',
        kind: 'anthropic',
        name: 'Claude Direct',
        apiKey: 'direct-key',
        baseUrl: 'https://api.anthropic.com',
      },
      {
        id: 'p_cli',
        kind: 'anthropic',
        transport: 'cli',
        name: 'Claude CLI',
        apiKey: 'cli-key',
        baseUrl: 'https://relay.example/v1',
      },
    ]);

    expect(getActiveProviderId()).toBe('p_cli');
    expect(getActiveProvider()?.id).toBe('p_cli');
  });

  it('treats cc-switch imported Claude providers as CLI-backed runtime entries', () => {
    const provider = {
      kind: 'anthropic',
      apiKey: 'sk-imported',
      baseUrl: 'https://relay.example/v1/',
      transport: 'cli',
    } as const;

    expect(
      getProviderRuntimeInfo(provider, { canUseCliFallback: true }),
    ).toMatchObject({
      status: 'cli',
      baseUrlHost: 'relay.example',
    });
    expect(
      getProviderRuntimeInfo(provider, { canUseCliFallback: false }).status,
    ).toBe('unavailable');
  });

  it('does not expose CLI-backed Claude providers through browser-direct API readers', () => {
    seedProviders(
      [
        {
          id: 'p_1',
          kind: 'anthropic',
          transport: 'cli',
          name: 'Claude Code Import',
          apiKey: 'sk-imported',
          baseUrl: 'https://relay.example/v1',
        },
      ],
      'p_1',
    );

    expect(readApiKey()).toBe('');
    expect(readBaseUrl()).toBe('');
  });

  it('exports and imports default channel JSON with active ids', () => {
    seedProviders([
      {
        id: 'p_anthropic',
        kind: 'anthropic',
        name: 'Claude Relay',
        apiKey: 'sk-claude',
        baseUrl: 'https://relay.example/v1',
      },
      {
        id: 'p_codex',
        kind: 'codex',
        transport: 'cli',
        name: 'Codex CLI',
        apiKey: '',
        baseUrl: '',
      },
    ]);
    window.localStorage.setItem(
      ACTIVE_PROVIDER_BY_KIND_STORAGE,
      JSON.stringify({ anthropic: 'p_anthropic', codex: 'p_codex' }),
    );

    const exported = exportDefaultChannelsConfig();
    window.localStorage.clear();
    const result = importDefaultChannelsConfig(exported);

    expect(result).toEqual({ imported: 2, updated: 0, skipped: 0 });
    expect(listProviders()).toHaveLength(2);
    expect(getActiveProviderId('anthropic')).toBe('p_anthropic');
    expect(getActiveProviderId('codex')).toBe('p_codex');
  });

  it('updates matching providers when importing default channel JSON', () => {
    seedProviders(
      [
        {
          id: 'p_1',
          kind: 'anthropic',
          name: 'Claude',
          apiKey: 'old-key',
          baseUrl: '',
        },
      ],
      'p_1',
    );

    const result = importDefaultChannelsConfig({
      providers: [
        {
          id: 'p_1',
          kind: 'anthropic',
          name: 'Claude',
          apiKey: 'new-key',
          baseUrl: '',
        },
      ],
      activeProviderIds: { anthropic: 'p_1' },
    });

    expect(result).toEqual({ imported: 0, updated: 1, skipped: 0 });
    expect(readApiKey()).toBe('new-key');
  });
});
