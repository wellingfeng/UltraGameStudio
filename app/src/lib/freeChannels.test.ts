import { afterEach, describe, expect, it } from 'vitest';
import {
  FREE_CHANNELS,
  FREE_CHANNEL_AUTO_ID,
  FREE_CHANNEL_AUTO_MODEL,
  FREE_CHANNEL_PROVIDER_PREFIX,
  applyFreeChannelEnvKeys,
  exportFreeChannelsConfig,
  freeChannelGatewayProviders,
  freeChannelReady,
  freeChannelSelection,
  getCachedFreeProxyPort,
  getFreeChannelFallbackModels,
  getFreeChannelKey,
  getFreeChannelModel,
  getFreeChannelModelOverride,
  getFreeChannelRouteModel,
  importFreeChannelsConfig,
  isFreeChannelSelection,
  setFreeChannelKey,
  setFreeChannelModel,
} from '@/lib/freeChannels';

afterEach(() => {
  window.localStorage.clear();
});

describe('free channel selection encoding', () => {
  it('round-trips a selection through isFreeChannelSelection', () => {
    const sel = freeChannelSelection('groq', 'opus');
    expect(sel.adapter).toBe('claude-code');
    expect(sel.modelClass).toBe('opus');
    expect(sel.providerId).toBe(`${FREE_CHANNEL_PROVIDER_PREFIX}groq`);
    expect(isFreeChannelSelection(sel)).toBe('groq');
  });

  it('defaults the auto channel to Auto without sending Auto as an upstream model', () => {
    const sel = freeChannelSelection(FREE_CHANNEL_AUTO_ID);

    expect(sel.modelClass).toBe(FREE_CHANNEL_AUTO_MODEL);
    expect(getFreeChannelModel(FREE_CHANNEL_AUTO_ID)).toBe(FREE_CHANNEL_AUTO_MODEL);
    expect(getFreeChannelRouteModel(FREE_CHANNEL_AUTO_ID)).toBe('');

    expect(setFreeChannelModel(FREE_CHANNEL_AUTO_ID, 'z-ai/glm-5.1')).toBe(true);
    expect(getFreeChannelModel(FREE_CHANNEL_AUTO_ID)).toBe('z-ai/glm-5.1');
    expect(getFreeChannelRouteModel(FREE_CHANNEL_AUTO_ID)).toBe('z-ai/glm-5.1');

    expect(setFreeChannelModel(FREE_CHANNEL_AUTO_ID, FREE_CHANNEL_AUTO_MODEL)).toBe(true);
    expect(getFreeChannelModelOverride(FREE_CHANNEL_AUTO_ID)).toBe('');
    expect(getFreeChannelRouteModel(FREE_CHANNEL_AUTO_ID)).toBe('');
  });

  it('returns null for non-free and unknown selections', () => {
    expect(isFreeChannelSelection({ adapter: 'claude-code', modelClass: 'sonnet' })).toBeNull();
    expect(
      isFreeChannelSelection({
        adapter: 'claude-code',
        modelClass: 'sonnet',
        providerId: `${FREE_CHANNEL_PROVIDER_PREFIX}does_not_exist`,
      }),
    ).toBeNull();
    expect(isFreeChannelSelection(undefined)).toBeNull();
  });
});

describe('freeChannelReady', () => {
  it('requires an explicit model for local channels', () => {
    const local = FREE_CHANNELS.find((c) => c.local);
    expect(local).toBeDefined();
    expect(freeChannelReady(local!.id)).toBe(false);
    setFreeChannelModel(local!.id, 'local-model');
    expect(freeChannelReady(local!.id)).toBe(true);
  });

  it('requires a key for non-local channels', () => {
    const remote = FREE_CHANNELS.find((c) => !c.local && c.needsKey)!;
    expect(freeChannelReady(remote.id)).toBe(false);
    setFreeChannelKey(remote.id, 'sk-test-123');
    expect(freeChannelReady(remote.id)).toBe(true);
    setFreeChannelKey(remote.id, '');
    expect(freeChannelReady(remote.id)).toBe(false);
  });

  it('allows keyless remote channels', () => {
    expect(freeChannelReady('llm7')).toBe(true);
    expect(freeChannelReady('kilo')).toBe(true);
  });

  it('enables auto when at least one concrete free channel is ready', () => {
    expect(freeChannelReady(FREE_CHANNEL_AUTO_ID)).toBe(true);
  });
});

describe('applyFreeChannelEnvKeys', () => {
  it('imports known remote-channel keys without overwriting saved values', () => {
    setFreeChannelKey('groq', 'saved-groq');
    const imported = applyFreeChannelEnvKeys({
      groq: 'env-groq',
      open_router: 'env-openrouter',
      ollama: 'ignored-local',
      unknown: 'ignored',
    });

    expect(imported).toEqual(['open_router']);
    expect(getFreeChannelKey('groq')).toBe('saved-groq');
    expect(getFreeChannelKey('open_router')).toBe('env-openrouter');
    expect(getFreeChannelKey('ollama')).toBe('');
  });

  it('broadcasts at most once when importing multiple auto-config keys', () => {
    let events = 0;
    const onChanged = () => {
      events += 1;
    };
    window.addEventListener('fuc:gateway-config-changed', onChanged);

    try {
      const imported = applyFreeChannelEnvKeys({
        groq: 'env-groq',
        open_router: 'env-openrouter',
      });

      expect([...imported].sort()).toEqual(['groq', 'open_router'].sort());
      expect(events).toBe(1);
    } finally {
      window.removeEventListener('fuc:gateway-config-changed', onChanged);
    }
  });
});

describe('legacy free channel storage recovery', () => {
  it('restores keys from the old owf storage namespace', () => {
    window.localStorage.setItem(
      'owf_free_channel_keys_v1',
      JSON.stringify({
        groq: 'legacy-groq',
        open_router: 'legacy-openrouter',
        unknown: 'ignored',
      }),
    );

    expect(getFreeChannelKey('groq')).toBe('legacy-groq');
    expect(getFreeChannelKey('open_router')).toBe('legacy-openrouter');
    expect(
      JSON.parse(
        window.localStorage.getItem('fuc_free_channel_keys_v1') ?? '{}',
      ),
    ).toMatchObject({
      groq: 'legacy-groq',
      open_router: 'legacy-openrouter',
    });
  });

  it('keeps current free channel keys when old storage also exists', () => {
    setFreeChannelKey('groq', 'current-groq');
    window.localStorage.setItem(
      'owf_free_channel_keys_v1',
      JSON.stringify({
        groq: 'legacy-groq',
        deepseek: 'legacy-deepseek',
      }),
    );

    expect(getFreeChannelKey('groq')).toBe('current-groq');
    expect(getFreeChannelKey('deepseek')).toBe('legacy-deepseek');
  });
});

describe('free channel change broadcasts', () => {
  it('skips redundant storage writes and gateway refresh events', () => {
    let events = 0;
    const onChanged = () => {
      events += 1;
    };
    window.addEventListener('fuc:gateway-config-changed', onChanged);

    try {
      expect(setFreeChannelKey('groq', 'sk-test-123')).toBe(true);
      expect(setFreeChannelKey('groq', 'sk-test-123')).toBe(false);
      expect(setFreeChannelModel('groq', 'custom-model')).toBe(true);
      expect(setFreeChannelModel('groq', 'custom-model')).toBe(false);

      expect(events).toBe(2);
    } finally {
      window.removeEventListener('fuc:gateway-config-changed', onChanged);
    }
  });
});

describe('model override', () => {
  it('exposes the raw override separately from the resolved default', () => {
    const channel = FREE_CHANNELS.find((c) => c.defaultModel)!;
    expect(getFreeChannelModelOverride(channel.id)).toBe('');
    // With no override, getFreeChannelModel falls back to the default.
    expect(getFreeChannelModel(channel.id)).toBe(channel.defaultModel);
    setFreeChannelModel(channel.id, 'custom-model-x');
    expect(getFreeChannelModelOverride(channel.id)).toBe('custom-model-x');
    expect(getFreeChannelModel(channel.id)).toBe('custom-model-x');
  });

  it('normalizes bare OpenRouter GLM model overrides to provider-qualified lowercase ids', () => {
    setFreeChannelModel('open_router', 'GLM-4.6');
    expect(getFreeChannelModelOverride('open_router')).toBe('GLM-4.6');
    expect(getFreeChannelModel('open_router')).toBe('z-ai/glm-4.6');
  });

  it('normalizes known provider-specific bare model aliases', () => {
    setFreeChannelModel('nvidia_nim', 'nemotron-3-super-120b-a12b');
    expect(getFreeChannelModel('nvidia_nim')).toBe(
      'nvidia/nemotron-3-super-120b-a12b',
    );

    setFreeChannelModel('fireworks', 'llama-v3p3-70b-instruct');
    expect(getFreeChannelModel('fireworks')).toBe(
      'accounts/fireworks/models/llama-v3p3-70b-instruct',
    );
  });

  it('returns de-duplicated fallback models after the active model', () => {
    expect(getFreeChannelFallbackModels('open_router')).toEqual([
      'openai/gpt-5.4-codex',
      'openai/gpt-5.4',
      'openai/gpt-5.2',
      'openai/gpt-5-nano',
      'anthropic/claude-fable-5',
      'anthropic/claude-opus-4.7',
      'google/gemini-3.5-flash',
      'google/gemini-3.1-pro',
      'google/gemini-3.1-flash',
      'moonshotai/kimi-k2.6',
      'moonshotai/kimi-k2-thinking',
      'qwen/qwen3.6-coder',
      'qwen/qwen3.6-235b-a22b',
      'qwen/qwen3.5-27b',
      'qwen/qwen-flash',
      'minimax/minimax-m2.7',
      'minimax/minimax-m2.5',
      'z-ai/glm-5.1',
      'z-ai/glm-4.7',
      'z-ai/glm-4.5-air:free',
    ]);
    setFreeChannelModel('open_router', 'glm-5.1');
    expect(getFreeChannelModel('open_router')).toBe('z-ai/glm-5.1');
    expect(getFreeChannelFallbackModels('open_router')).toContain('z-ai/glm-4.6');
    expect(getFreeChannelFallbackModels('open_router')).not.toContain(
      'z-ai/glm-5.1',
    );
  });
});

describe('free channel JSON import/export', () => {
  it('round-trips saved keys and model overrides', () => {
    setFreeChannelKey('groq', 'sk-groq');
    setFreeChannelModel('ollama', 'llama3.3');

    const exported = exportFreeChannelsConfig();
    window.localStorage.clear();
    const result = importFreeChannelsConfig(exported);

    expect(result).toEqual({ keys: 1, models: 1, skipped: 0 });
    expect(getFreeChannelKey('groq')).toBe('sk-groq');
    expect(getFreeChannelModelOverride('ollama')).toBe('llama3.3');
  });

  it('skips unknown free channel ids on import', () => {
    const result = importFreeChannelsConfig({
      keys: { groq: 'sk-groq', unknown: 'sk-unknown' },
      models: { ollama: 'llama3.3', missing: 'ignored' },
    });

    expect(result).toEqual({ keys: 1, models: 1, skipped: 2 });
    expect(getFreeChannelKey('groq')).toBe('sk-groq');
    expect(getFreeChannelModelOverride('ollama')).toBe('llama3.3');
  });
});

describe('channel catalog', () => {
  it('routes OpenRouter through the OpenAI-compatible endpoint', () => {
    const channel = FREE_CHANNELS.find((c) => c.id === 'open_router');
    expect(channel).toMatchObject({
      transport: 'openai',
      upstreamBaseUrl: 'https://openrouter.ai/api/v1',
      defaultModel: 'z-ai/glm-4.6',
    });
  });

  it('includes smoke-tested keyless coding channels', () => {
    expect(FREE_CHANNELS.find((c) => c.id === FREE_CHANNEL_AUTO_ID)).toMatchObject({
      transport: 'auto',
      needsKey: false,
    });
    expect(FREE_CHANNELS.find((c) => c.id === 'llm7')).toMatchObject({
      transport: 'openai',
      upstreamBaseUrl: 'https://api.llm7.io/v1',
      defaultModel: 'codestral-latest',
      fallbackModels: ['qwen3-235b'],
      needsKey: false,
    });
    expect(FREE_CHANNELS.find((c) => c.id === 'kilo')).toMatchObject({
      transport: 'openai',
      upstreamBaseUrl: 'https://api.kilo.ai/api/gateway/v1',
      defaultModel: 'poolside/laguna-xs.2:free',
      needsKey: false,
    });
  });

  it('includes official OpenAI-compatible free/trial coding channels', () => {
    expect(FREE_CHANNELS.find((c) => c.id === 'github_models')).toMatchObject({
      transport: 'openai',
      upstreamBaseUrl: 'https://models.github.ai/inference',
      defaultModel: 'openai/gpt-4.1-mini',
      needsKey: true,
    });
    expect(FREE_CHANNELS.find((c) => c.id === 'huggingface_router')).toMatchObject({
      transport: 'openai',
      upstreamBaseUrl: 'https://router.huggingface.co/v1',
      defaultModel: 'deepseek-ai/DeepSeek-V4-Pro',
      needsKey: true,
    });
    expect(FREE_CHANNELS.find((c) => c.id === 'sambanova')).toMatchObject({
      transport: 'openai',
      upstreamBaseUrl: 'https://api.sambanova.ai/v1',
      defaultModel: 'DeepSeek-V3.1',
      needsKey: true,
    });
    expect(FREE_CHANNELS.find((c) => c.id === 'together')).toMatchObject({
      transport: 'openai',
      upstreamBaseUrl: 'https://api.together.xyz/v1',
      defaultModel: 'Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8',
      needsKey: true,
    });
  });
});

describe('freeChannelGatewayProviders', () => {
  it('drops cached proxy ports outside the free proxy range', () => {
    window.localStorage.setItem('fuc_free_proxy_port_v1', String(8766 - 1));

    expect(getCachedFreeProxyPort()).toBe(8766);
    expect(window.localStorage.getItem('fuc_free_proxy_port_v1')).toBeNull();
  });

  it('builds a CLI claude-code provider per channel pointed at the local proxy', () => {
    window.localStorage.setItem('fuc_free_proxy_token_v1', 'local-token-123');
    const providers = freeChannelGatewayProviders();
    expect(providers).toHaveLength(FREE_CHANNELS.length);
    for (const provider of providers) {
      expect(provider.id.startsWith(FREE_CHANNEL_PROVIDER_PREFIX)).toBe(true);
      expect(provider.adapter).toBe('claude-code');
      const channel = provider.channels[0];
      expect(channel.route.transport).toBe('cli');
      expect(channel.apiKey).toBe('local-token-123');
      const id = provider.id.slice(FREE_CHANNEL_PROVIDER_PREFIX.length);
      expect(channel.route.baseUrl).toContain(`/ch/${id}`);
      expect(channel.route.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/ch\//);
      const source = FREE_CHANNELS.find((item) => item.id === id)!;
      expect(provider.name).toBe(source.label);
    }
  });
});
