import { afterEach, describe, expect, it } from 'vitest';
import type { IRGraph } from '@/core/ir';
import { setActiveGatewaySelection } from '@/lib/gatewayConfig';
import { PROVIDERS_STORAGE, syncGatewayFromProviders } from '@/lib/apiConfig';
import {
  FREE_CHANNEL_AUTO_ID,
  FREE_CHANNEL_AUTO_MODEL,
  FREE_CHANNEL_PROVIDER_PREFIX,
  setFreeChannelModel,
} from '@/lib/freeChannels';
import {
  resolveGatewayRoute,
  gatewayRouteEnv,
  nodeGatewayOverride,
  mergeGatewaySelection,
  nodeParamsWithGatewayOverride,
  normalizeGatewayWorkflow,
  workflowDefaultGatewaySelection,
  workflowGatewaySelection,
} from './resolver';
import { resolveDirectGatewayRoute } from './modelGateway';

function setTestStorage(key: string, value: string): void {
  window.localStorage.setItem(key, value);
  if (key === PROVIDERS_STORAGE) syncGatewayFromProviders();
}

function buildWorkflow(nodes: IRGraph['nodes']): IRGraph {
  return {
    version: 1,
    meta: { name: 'legacy workflow', adapter: 'claude-code' },
    nodes,
    edges: [],
  };
}

afterEach(() => {
  window.localStorage.clear();
});

describe('model gateway compatibility', () => {
  it('reads legacy params.model as a node model override', () => {
    expect(nodeGatewayOverride({ model: 'haiku' })).toEqual({
      modelClass: 'haiku',
    });
  });

  it('writes node overrides with the legacy model alias preserved', () => {
    expect(
      nodeParamsWithGatewayOverride(
        { prompt: 'a', model: 'sonnet' },
        {
          modelClass: 'opus',
          providerId: 'prov_1',
          channelId: 'chan_1',
        },
      ),
    ).toEqual({
      prompt: 'a',
      model: 'opus',
      gateway: {
        modelClass: 'opus',
        providerId: 'prov_1',
        channelId: 'chan_1',
      },
    });
  });

  it('removes node override fields when inheriting the global selection', () => {
    expect(
      nodeParamsWithGatewayOverride(
        {
          prompt: 'a',
          model: 'haiku',
          gateway: { modelClass: 'haiku', providerId: 'prov_1' },
        },
        null,
      ),
    ).toEqual({
      prompt: 'a',
    });
  });

  it('keeps provider-less channel overrides provider-less in the merged selection', () => {
    expect(
      mergeGatewaySelection(
        {
          adapter: 'claude-code',
          modelClass: 'sonnet',
          providerId: 'prov_1',
          channelId: 'chan_1',
        },
        {
          modelClass: 'haiku',
          channelId: 'cli_2',
        },
      ),
    ).toEqual({
      adapter: 'claude-code',
      modelClass: 'haiku',
      channelId: 'cli_2',
    });
  });

  it('uses the explicit global run selection before workflow defaults', () => {
    setActiveGatewaySelection({ adapter: 'codex', modelClass: 'opus' });
    const workflow = buildWorkflow([]);
    workflow.meta.gateway = {
      defaults: { adapter: 'claude-code', modelClass: 'haiku' },
    };

    expect(workflowGatewaySelection(workflow)).toEqual({
      adapter: 'codex',
      modelClass: 'opus',
    });
  });

  it('prefers workflow defaults when resolving the workflow-default selection', () => {
    setActiveGatewaySelection({ adapter: 'codex', modelClass: 'opus' });
    const workflow = buildWorkflow([]);
    workflow.meta.gateway = {
      defaults: { adapter: 'claude-code', modelClass: 'haiku' },
    };

    expect(workflowDefaultGatewaySelection(workflow)).toEqual({
      adapter: 'claude-code',
      modelClass: 'haiku',
    });
  });

  it('falls back to the current global selection when a workflow has no defaults', () => {
    setActiveGatewaySelection({ adapter: 'gemini', modelClass: 'haiku' });
    const workflow = buildWorkflow([]);
    delete workflow.meta.adapter;

    expect(workflowDefaultGatewaySelection(workflow)).toEqual({
      adapter: 'gemini',
      modelClass: 'haiku',
    });
  });

  it('resolves a route from workflow defaults before the current global selection', () => {
    setActiveGatewaySelection({ adapter: 'codex', modelClass: 'opus' });
    const workflow = buildWorkflow([]);
    workflow.meta.gateway = {
      defaults: { adapter: 'claude-code', modelClass: 'haiku' },
    };

    const route = resolveGatewayRoute(workflow);

    expect(route.selection).toEqual({
      adapter: 'claude-code',
      modelClass: 'haiku',
    });
  });

  it('keeps selected CLI channel ids on fallback routes', () => {
    const workflow = buildWorkflow([]);
    workflow.meta.gateway = {
      defaults: {
        adapter: 'codex',
        modelClass: 'opus',
        channelId: 'cli_custom_codex',
      },
    };

    const route = resolveGatewayRoute(workflow);

    expect(route.transport).toBe('cli');
    expect(route.channelId).toBe('cli_custom_codex');
    expect(route.selection.channelId).toBe('cli_custom_codex');
  });

  it('routes cc-switch imported Claude-compatible providers through the local CLI', () => {
    setTestStorage(
      PROVIDERS_STORAGE,
      JSON.stringify([
        {
          id: 'relay_provider',
          kind: 'anthropic',
          transport: 'cli',
          name: 'Claude Code Import',
          apiKey: 'sk-imported',
          baseUrl: 'https://relay.example/v1/',
          model: 'custom-model',
        },
      ]),
    );
    const selection = {
      adapter: 'claude-code',
      modelClass: 'opus',
      providerId: 'relay_provider',
      channelId: 'default',
    };

    expect(resolveDirectGatewayRoute(selection)).toBeNull();

    const workflow = buildWorkflow([]);
    workflow.meta.gateway = { defaults: selection };
    const route = resolveGatewayRoute(workflow);

    // Credentials + base url route through the local CLI, and the imported
    // channel model is preserved as ANTHROPIC_MODEL so the relay can select the
    // cc-switch channel. The Rust launcher filters it out of the `--model` flag
    // when it is not a genuine claude-* id.
    expect(route.env).toMatchObject({
      ANTHROPIC_API_KEY: 'sk-imported',
      ANTHROPIC_AUTH_TOKEN: 'sk-imported',
      ANTHROPIC_BASE_URL: 'https://relay.example/v1/',
      ANTHROPIC_MODEL: 'custom-model',
    });
    expect(route.env).not.toHaveProperty('UGS_CLAUDE_BARE');
    expect(route.model).toBe('custom-model');
  });

  it('resolves keyless localhost Anthropic-compatible providers as direct routes', () => {
    setTestStorage(
      PROVIDERS_STORAGE,
      JSON.stringify([
        {
          id: 'local_anthropic',
          kind: 'anthropic',
          transport: 'direct',
          name: 'Local Antigravity',
          apiKey: '',
          baseUrl: 'http://127.0.0.1:8045',
          model: 'gemini-3-flash',
        },
      ]),
    );

    const selection = {
      adapter: 'claude-code' as const,
      modelClass: 'sonnet' as const,
      providerId: 'local_anthropic',
      channelId: 'default',
    };

    const direct = resolveDirectGatewayRoute(selection);

    expect(direct).toMatchObject({
      transport: 'anthropic',
      mode: 'direct',
      baseUrl: 'http://127.0.0.1:8045',
      model: 'gemini-3-flash',
    });
    expect(direct?.apiKey).toBe('');
  });

  it('resolves codex/gemini custom providers as OpenAI-compatible direct routes', () => {
    setTestStorage(
      PROVIDERS_STORAGE,
      JSON.stringify([
        {
          id: 'openai_relay',
          kind: 'codex',
          transport: 'direct',
          name: 'OpenAI-compatible relay',
          apiKey: 'sk-openai',
          baseUrl: 'https://relay.example/v1',
          model: 'gpt-5.5',
        },
      ]),
    );

    const selection = {
      adapter: 'codex' as const,
      modelClass: 'gpt-5.5',
      providerId: 'openai_relay',
      channelId: 'default',
    };

    const direct = resolveDirectGatewayRoute(selection);

    expect(direct).toMatchObject({
      transport: 'openai-compatible',
      mode: 'direct',
      baseUrl: 'https://relay.example/v1',
      model: 'gpt-5.5',
    });
    expect(direct?.env).toMatchObject({
      OPENAI_API_KEY: 'sk-openai',
      OPENAI_BASE_URL: 'https://relay.example/v1',
      OPENAI_MODEL: 'gpt-5.5',
    });
  });

  it('uses the selected Codex session model instead of the provider default', () => {
    setTestStorage(
      PROVIDERS_STORAGE,
      JSON.stringify([
        {
          id: 'relay_provider',
          kind: 'codex',
          transport: 'direct',
          name: 'RelayAI',
          apiKey: 'sk-example',
          baseUrl: 'https://relay.example/v1',
          model: 'gpt-5.5',
          models: ['gpt-5.6-sol'],
        },
      ]),
    );
    const workflow = buildWorkflow([]);
    workflow.meta.gateway = {
      defaults: {
        adapter: 'codex',
        modelClass: 'gpt-5.6-sol',
        providerId: 'relay_provider',
        channelId: 'default',
      },
    };

    const route = resolveGatewayRoute(workflow);

    expect(route.model).toBe('gpt-5.6-sol');
    expect(route.env).toMatchObject({
      OPENAI_MODEL: 'gpt-5.6-sol',
    });
  });

  it('uses a session model override without rewriting the provider default model', () => {
    setTestStorage(
      PROVIDERS_STORAGE,
      JSON.stringify([
        {
          id: 'relay_provider',
          kind: 'anthropic',
          transport: 'cli',
          name: 'Relay',
          apiKey: 'sk-relay',
          baseUrl: 'https://relay.example/v1/',
          model: 'provider-default-model',
        },
      ]),
    );
    const workflow = buildWorkflow([]);
    workflow.meta.gateway = {
      defaults: {
        adapter: 'claude-code',
        modelClass: 'session-only-model',
        modelOverride: 'session-only-model',
        providerId: 'relay_provider',
        channelId: 'default',
      },
    };

    const route = resolveGatewayRoute(workflow);

    expect(route.model).toBe('session-only-model');
    expect(route.env).toMatchObject({ ANTHROPIC_MODEL: 'session-only-model' });
    expect(JSON.parse(window.localStorage.getItem(PROVIDERS_STORAGE)!)[0].model).toBe(
      'provider-default-model',
    );
  });

  it('normalizes known provider bare model ids before exporting CLI env', () => {
    setTestStorage(
      PROVIDERS_STORAGE,
      JSON.stringify([
        {
          id: 'nvidia_provider',
          kind: 'anthropic',
          transport: 'cli',
          name: 'NVIDIA Import',
          apiKey: 'nvapi-test',
          baseUrl: 'https://integrate.api.nvidia.com/v1',
          model: 'nemotron-3-super-120b-a12b',
        },
      ]),
    );

    const workflow = buildWorkflow([]);
    workflow.meta.gateway = {
      defaults: {
        adapter: 'claude-code',
        modelClass: 'sonnet',
        providerId: 'nvidia_provider',
        channelId: 'default',
      },
    };

    const route = resolveGatewayRoute(workflow);

    expect(route.model).toBe('nvidia/nemotron-3-super-120b-a12b');
    expect(route.env).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://integrate.api.nvidia.com/v1',
      ANTHROPIC_MODEL: 'nvidia/nemotron-3-super-120b-a12b',
    });
  });

  it('exports Gemini CLI env even when the selected channel is direct-compatible', () => {
    expect(
      gatewayRouteEnv({
        adapter: 'gemini',
        transport: 'openai-compatible',
        apiKey: 'gemini-key',
        baseUrl: 'https://generativelanguage.googleapis.com',
        model: 'gemini-2.5-pro',
      }),
    ).toMatchObject({
      GEMINI_API_KEY: 'gemini-key',
      GOOGLE_API_KEY: 'gemini-key',
      GOOGLE_GEMINI_BASE_URL: 'https://generativelanguage.googleapis.com',
    });
  });

  it('exports deepseek-harness CLI env including the third-party base url', () => {
    expect(
      gatewayRouteEnv({
        adapter: 'deepseek-harness',
        transport: 'cli',
        apiKey: 'ds-key',
        baseUrl: 'https://relay.example',
        model: 'deepseek-ai/DeepSeek-V3',
      }),
    ).toMatchObject({
      DEEPSEEK_API_KEY: 'ds-key',
      DEEPSEEK_BASE_URL: 'https://relay.example',
    });
  });

  it('exports deepseek-harness env when a direct channel falls back to CLI', () => {
    expect(
      gatewayRouteEnv({
        adapter: 'deepseek-harness',
        transport: 'openai-compatible',
        apiKey: 'ds-key',
        baseUrl: 'https://relay.example',
        model: 'deepseek-v4-pro',
      }),
    ).toMatchObject({
      DEEPSEEK_API_KEY: 'ds-key',
      DEEPSEEK_BASE_URL: 'https://relay.example',
      UGS_DSH_MODEL: 'deepseek-v4-pro',
    });
  });

  it('omits deepseek-harness env when neither key nor base url is set', () => {
    expect(
      gatewayRouteEnv({
        adapter: 'deepseek-harness',
        transport: 'cli',
        apiKey: undefined,
        baseUrl: undefined,
        model: undefined,
      }),
    ).toBeUndefined();
  });

  it('exports zcode CLI env so the host can sync them into ~/.zcode/cli/config.json', () => {
    expect(
      gatewayRouteEnv({
        adapter: 'zcode',
        transport: 'cli',
        apiKey: 'zcode-key',
        baseUrl: 'https://api.z.ai/api/anthropic',
        model: 'glm-5.3',
      }),
    ).toMatchObject({
      ZCODE_API_KEY: 'zcode-key',
      ZCODE_BASE_URL: 'https://api.z.ai/api/anthropic',
      ZCODE_MODEL: 'glm-5.3',
    });
  });

  it('omits zcode env when the channel carries no key/base url/model', () => {
    expect(
      gatewayRouteEnv({
        adapter: 'zcode',
        transport: 'cli',
        apiKey: undefined,
        baseUrl: undefined,
        model: undefined,
      }),
    ).toBeUndefined();
  });

  it('exports kimi CLI env (KIMI_MODEL_API_KEY + KIMI_MODEL_NAME) so key-only auth works', () => {
    expect(
      gatewayRouteEnv({
        adapter: 'kimi',
        transport: 'cli',
        apiKey: 'sk-moonshot',
        baseUrl: 'https://api.moonshot.cn/v1',
        model: 'kimi-k2',
      }),
    ).toMatchObject({
      KIMI_MODEL_API_KEY: 'sk-moonshot',
      KIMI_MODEL_NAME: 'kimi-k2',
      KIMI_MODEL_BASE_URL: 'https://api.moonshot.cn/v1',
    });
  });

  it('omits kimi env when the channel has a key but no model (env overlay needs both)', () => {
    expect(
      gatewayRouteEnv({
        adapter: 'kimi',
        transport: 'cli',
        apiKey: 'sk-moonshot',
        baseUrl: undefined,
        model: undefined,
      }),
    ).toBeUndefined();
  });

  it('omits kimi env when the channel has no key+model (falls back to login)', () => {
    expect(
      gatewayRouteEnv({
        adapter: 'kimi',
        transport: 'cli',
        apiKey: undefined,
        baseUrl: undefined,
        model: undefined,
      }),
    ).toBeUndefined();
  });

  it('exports grok CLI env (XAI_API_KEY only; model rides --model)', () => {
    expect(
      gatewayRouteEnv({
        adapter: 'grok',
        transport: 'cli',
        apiKey: 'xai-secret',
        baseUrl: undefined,
        model: 'grok-4.6',
      }),
    ).toMatchObject({
      XAI_API_KEY: 'xai-secret',
    });
  });

  it('omits grok env when the channel carries no key', () => {
    expect(
      gatewayRouteEnv({
        adapter: 'grok',
        transport: 'cli',
        apiKey: undefined,
        baseUrl: undefined,
        model: undefined,
      }),
    ).toBeUndefined();
  });

  it('uses system CLI defaults without provider env when systemDefault is selected', () => {
    setTestStorage(
      PROVIDERS_STORAGE,
      JSON.stringify([
        {
          id: 'relay_provider',
          kind: 'anthropic',
          transport: 'cli',
          name: 'Claude Code Import',
          apiKey: 'sk-imported',
          baseUrl: 'https://relay.example/v1/',
          model: 'custom-model',
        },
      ]),
    );

    const workflow = buildWorkflow([]);
    workflow.meta.gateway = {
      defaults: {
        adapter: 'claude-code',
        modelClass: 'default',
        systemDefault: true,
      },
    };
    const route = resolveGatewayRoute(workflow);

    expect(route.transport).toBe('cli');
    expect(route.providerId).toBeUndefined();
    expect(route.channelId).toBeUndefined();
    expect(route.env).toBeUndefined();
    expect(route.model).toBeUndefined();
  });

  it('does not resolve stale unconfigured free-channel selections', () => {
    const workflow = buildWorkflow([]);
    workflow.meta.gateway = {
      defaults: {
        adapter: 'claude-code',
        modelClass: 'sonnet',
        providerId: `${FREE_CHANNEL_PROVIDER_PREFIX}ollama`,
        channelId: 'default',
      },
    };

    const route = resolveGatewayRoute(workflow);

    expect(route.transport).toBe('cli');
    expect(route.baseUrl).toBeUndefined();
    expect(route.env).toBeUndefined();
  });

  it('treats Free Auto as no fixed model, including legacy tier selections', () => {
    const workflow = buildWorkflow([]);
    workflow.meta.gateway = {
      defaults: {
        adapter: 'claude-code',
        modelClass: 'opus',
        providerId: `${FREE_CHANNEL_PROVIDER_PREFIX}${FREE_CHANNEL_AUTO_ID}`,
        channelId: 'default',
      },
    };

    const route = resolveGatewayRoute(workflow);

    expect(route.providerId).toBe(`${FREE_CHANNEL_PROVIDER_PREFIX}${FREE_CHANNEL_AUTO_ID}`);
    expect(route.model).toBeUndefined();
    expect(route.env).toMatchObject({
      ANTHROPIC_BASE_URL: expect.stringContaining('/ch/auto'),
      UGS_CLAUDE_BARE: '1',
    });
    expect(route.env).not.toHaveProperty('ANTHROPIC_MODEL');
  });

  it('uses an explicit Free Auto model override when one is selected', () => {
    const workflow = buildWorkflow([]);
    workflow.meta.gateway = {
      defaults: {
        adapter: 'claude-code',
        modelClass: FREE_CHANNEL_AUTO_MODEL,
        modelOverride: 'z-ai/glm-5.1',
        providerId: `${FREE_CHANNEL_PROVIDER_PREFIX}${FREE_CHANNEL_AUTO_ID}`,
        channelId: 'default',
      },
    };

    const route = resolveGatewayRoute(workflow);

    expect(route.model).toBe('z-ai/glm-5.1');
    expect(route.env).toMatchObject({ ANTHROPIC_MODEL: 'z-ai/glm-5.1' });
  });

  it('uses a configured Free Auto model from Settings', () => {
    setFreeChannelModel(FREE_CHANNEL_AUTO_ID, 'z-ai/glm-4.6');
    const workflow = buildWorkflow([]);
    workflow.meta.gateway = {
      defaults: {
        adapter: 'claude-code',
        modelClass: FREE_CHANNEL_AUTO_MODEL,
        providerId: `${FREE_CHANNEL_PROVIDER_PREFIX}${FREE_CHANNEL_AUTO_ID}`,
        channelId: 'default',
      },
    };

    const route = resolveGatewayRoute(workflow);

    expect(route.model).toBe('z-ai/glm-4.6');
    expect(route.env).toMatchObject({ ANTHROPIC_MODEL: 'z-ai/glm-4.6' });
  });

  it('prefers cli-backed Claude providers over stale browser-direct defaults', () => {
    setTestStorage(
      PROVIDERS_STORAGE,
      JSON.stringify([
        {
          id: 'stale_direct',
          kind: 'anthropic',
          name: 'Kimi Imported Before Transport',
          apiKey: 'sk-old',
          baseUrl: 'https://api.kimi.com/coding/',
          model: 'kimi-for-coding',
        },
        {
          id: 'cc_switch_cli',
          kind: 'anthropic',
          transport: 'cli',
          name: 'Kimi Imported From cc-switch',
          apiKey: 'sk-new',
          baseUrl: 'https://api.kimi.com/coding/',
          model: 'kimi-for-coding',
        },
      ]),
    );

    const workflow = buildWorkflow([]);
    const selection = workflowGatewaySelection(workflow);
    expect(selection.providerId).toBe('cc_switch_cli');

    const route = resolveGatewayRoute(workflow);
    expect(route.providerId).toBe('cc_switch_cli');
    expect(route.transport).toBe('cli');
    // The selected cc-switch route label must be exported as ANTHROPIC_MODEL;
    // the Rust launcher still avoids passing it as a CLI --model flag.
    expect(route.env).toMatchObject({
      ANTHROPIC_AUTH_TOKEN: 'sk-new',
      ANTHROPIC_BASE_URL: 'https://api.kimi.com/coding/',
      ANTHROPIC_MODEL: 'kimi-for-coding',
    });
    expect(route.model).toBe('kimi-for-coding');
  });

  it('exports non-claude cc-switch labels as ANTHROPIC_MODEL for claude-code', () => {
    setTestStorage(
      PROVIDERS_STORAGE,
      JSON.stringify([
        {
          id: 'kimi_cli',
          kind: 'anthropic',
          transport: 'cli',
          name: 'Kimi Relay',
          apiKey: 'sk-kimi',
          baseUrl: 'https://api.kimi.com/coding/',
          model: 'kimi-for-coding',
        },
      ]),
    );
    const workflow = buildWorkflow([]);
    workflow.meta.gateway = {
      defaults: {
        adapter: 'claude-code',
        modelClass: 'sonnet',
        providerId: 'kimi_cli',
        channelId: 'default',
      },
    };

    const route = resolveGatewayRoute(workflow);
    expect(route.model).toBe('kimi-for-coding');
    expect(route.env).toMatchObject({ ANTHROPIC_MODEL: 'kimi-for-coding' });
  });

  it('passes a genuine claude-* channel model through for claude-code', () => {
    setTestStorage(
      PROVIDERS_STORAGE,
      JSON.stringify([
        {
          id: 'claude_relay',
          kind: 'anthropic',
          transport: 'cli',
          name: 'Claude Relay',
          apiKey: 'sk-relay',
          baseUrl: 'https://relay.example/v1/',
          model: 'claude-opus-4-8',
        },
      ]),
    );
    const workflow = buildWorkflow([]);
    workflow.meta.gateway = {
      defaults: {
        adapter: 'claude-code',
        modelClass: 'opus',
        providerId: 'claude_relay',
        channelId: 'default',
      },
    };

    const route = resolveGatewayRoute(workflow);
    expect(route.model).toBe('claude-opus-4-8');
    expect(route.env).toMatchObject({ ANTHROPIC_MODEL: 'claude-opus-4-8' });
  });

  it('maps bare Claude tiers to concrete direct Anthropic model ids when no model is pinned', () => {
    setTestStorage(
      PROVIDERS_STORAGE,
      JSON.stringify([
        {
          id: 'anthropic_direct',
          kind: 'anthropic',
          transport: 'direct',
          name: 'Anthropic',
          apiKey: 'sk-test',
          baseUrl: '',
        },
      ]),
    );
    const workflow = buildWorkflow([]);
    workflow.meta.gateway = {
      defaults: {
        adapter: 'claude-code',
        modelClass: 'haiku',
        providerId: 'anthropic_direct',
        channelId: 'default',
      },
    };

    const route = resolveGatewayRoute(workflow);
    expect(route.transport).toBe('anthropic');
    expect(route.model).toBe('claude-haiku-4-5-20251001');
  });

  it('passes a litellm per-tier model id through for claude-code', () => {
    const config = {
      version: 1,
      providers: [
        {
          id: 'litellm',
          kind: 'anthropic',
          name: 'LiteLLM Relay',
          adapter: 'claude-code',
          channels: [
            {
              id: 'default',
              name: 'Default',
              apiKey: 'sk-litellm',
              baseUrl: 'https://litellm.example/v1/',
              model: 'kimi-for-coding',
              models: undefined,
              route: {
                transport: 'cli',
                baseUrl: 'https://litellm.example/v1/',
                model: 'kimi-for-coding',
                models: { opus: 'claude-opus-4-8', sonnet: 'claude-sonnet-4-6' },
              },
            },
          ],
        },
      ],
    };
    setTestStorage('ugs_model_gateway_v1', JSON.stringify(config));

    const workflow = buildWorkflow([]);
    workflow.meta.gateway = {
      defaults: {
        adapter: 'claude-code',
        modelClass: 'opus',
        providerId: 'litellm',
        channelId: 'default',
      },
    };

    const route = resolveGatewayRoute(workflow);
    // Per-tier map wins even though channel.model is a junk label.
    expect(route.model).toBe('claude-opus-4-8');
  });

  it('passes third-party gateway native gemini ids through unchanged', () => {
    const config = {
      version: 1,
      providers: [
        {
          id: 'example_gemini',
          kind: 'gemini',
          name: 'ExampleGemini',
          adapter: 'gemini',
          channels: [
            {
              id: 'default',
              name: 'gemini-3.8-flash',
              apiKey: 'example-test',
              baseUrl: 'https://gateway.example.com',
              model: 'gemini-3.8-flash',
              models: undefined,
              route: {
                transport: 'cli',
                baseUrl: 'https://gateway.example.com',
                model: 'gemini-3.8-flash',
                models: undefined,
              },
            },
          ],
        },
      ],
    };
    setTestStorage('ugs_model_gateway_v1', JSON.stringify(config));

    const workflow = buildWorkflow([]);
    workflow.meta.gateway = {
      defaults: {
        adapter: 'gemini',
        modelClass: 'gemini-3.8-flash',
        providerId: 'example_gemini',
        channelId: 'default',
      },
    };

    const route = resolveGatewayRoute(workflow);

    // 网关注册的原生 gemini ID 原样透传，用户选什么发什么。
    expect(route.model).toBe('gemini-3.8-flash');
    expect(route.env).toMatchObject({
      GOOGLE_GEMINI_BASE_URL: 'https://gateway.example.com',
    });
  });

  it('passes third-party gateway gemini-3.7-flash through unchanged', () => {
    const config = {
      version: 1,
      providers: [
        {
          id: 'example_gemini',
          kind: 'gemini',
          name: 'ExampleGemini',
          adapter: 'gemini',
          channels: [
            {
              id: 'default',
              name: 'gemini-3.7-flash',
              apiKey: 'example-test',
              baseUrl: 'https://gateway.example.com',
              model: 'gemini-3.7-flash',
              models: undefined,
              route: {
                transport: 'cli',
                baseUrl: 'https://gateway.example.com',
                model: 'gemini-3.7-flash',
                models: undefined,
              },
            },
          ],
        },
      ],
    };
    setTestStorage('ugs_model_gateway_v1', JSON.stringify(config));

    const workflow = buildWorkflow([]);
    workflow.meta.gateway = {
      defaults: {
        adapter: 'gemini',
        modelClass: 'gemini-3.7-flash',
        providerId: 'example_gemini',
        channelId: 'default',
      },
    };

    const route = resolveGatewayRoute(workflow);

    expect(route.model).toBe('gemini-3.7-flash');
  });

  it('keeps non-sonnet legacy node models while migrating sonnet to inherit global', () => {
    const workflow = buildWorkflow([
      {
        id: 'n1',
        type: 'agent',
        label: 'Default model',
        params: { prompt: 'a', model: 'sonnet' },
      },
      {
        id: 'n2',
        type: 'agent',
        label: 'Explicit override',
        params: { prompt: 'b', model: 'haiku' },
      },
      {
        id: 'n3',
        type: 'agent',
        label: 'Gateway override',
        params: { prompt: 'c', model: 'sonnet', gateway: { modelClass: 'opus' } },
      },
    ]);

    const migrated = normalizeGatewayWorkflow(workflow, 'sonnet');

    expect(migrated.meta.gateway?.defaults?.modelClass).toBe('sonnet');
    expect(migrated.nodes[0].params).not.toHaveProperty('model');
    expect(migrated.nodes[1].params.model).toBe('haiku');
    expect(migrated.nodes[2].params.model).toBe('sonnet');
    expect(migrated.nodes[2].params.gateway).toEqual({ modelClass: 'opus' });
  });
});

describe('thinking level env plumb-through', () => {
  it('exports UGS_THINKING_LEVEL and the wire plan for a supported channel', () => {
    const env = gatewayRouteEnv({
      transport: 'cli',
      adapter: 'deepseek-harness',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash-vision-exp',
      thinkingLevel: 'max',
    });
    expect(env?.UGS_THINKING_LEVEL).toBe('max');
    const plan = JSON.parse(env!.UGS_THINKING_PLAN) as {
      channel: string;
      wire: string | null;
      thinkingFormat: string | null;
    };
    expect(plan.channel).toBe('dsh-deepseek-native');
    expect(plan.wire).toBe('max');
  });

  it('drops a level the current channel does not support', () => {
    // `xhigh` 是 claude-code 的档位，deepseek-harness 的 native 路由没有它。
    const env = gatewayRouteEnv({
      transport: 'cli',
      adapter: 'deepseek-harness',
      baseUrl: 'https://api.deepseek.com',
      thinkingLevel: 'xhigh',
    });
    expect(env?.UGS_THINKING_LEVEL).toBeUndefined();

    // 没有已验证思考通道的 CLI 适配器不臆造档位。
    expect(
      gatewayRouteEnv({
        transport: 'cli',
        adapter: 'kimi',
        thinkingLevel: 'high',
      })?.UGS_THINKING_LEVEL,
    ).toBeUndefined();
  });

  it('keeps levels on a third-party gateway (pi-ai route)', () => {
    const env = gatewayRouteEnv({
      transport: 'cli',
      adapter: 'deepseek-harness',
      baseUrl: 'https://ai-gateway.example.com',
      model: 'deepseek-v4-pro',
      thinkingLevel: 'max',
    });
    expect(env?.UGS_THINKING_LEVEL).toBe('max');
    const plan = JSON.parse(env!.UGS_THINKING_PLAN) as {
      channel: string;
      thinkingFormat: string | null;
      efforts: Record<string, string | null>;
    };
    // 第三方网关这一档由 Rust 侧写进 pi-ai 的 reasoningEfforts + compat，
    // 走标准字段而非 DeepSeek 私有字段。
    expect(plan.channel).toBe('dsh-pi-ai');
    expect(plan.thinkingFormat).toBe('deepseek');
    expect(plan.efforts.off).toBeNull();
  });

  it('keeps levels on HTTP-direct transports', () => {
    const direct = gatewayRouteEnv({
      transport: 'openai-compatible',
      adapter: 'deepseek-harness',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-pro',
      thinkingLevel: 'max',
    });
    expect(direct?.UGS_THINKING_LEVEL).toBe('max');
    const plan = JSON.parse(direct!.UGS_THINKING_PLAN) as { channel: string };
    expect(plan.channel).toBe('http-openai');
  });

  it('passes codex and claude-code native levels through untouched', () => {
    expect(
      gatewayRouteEnv({
        transport: 'cli',
        adapter: 'codex',
        thinkingLevel: 'xhigh',
      })?.UGS_THINKING_LEVEL,
    ).toBe('xhigh');
    expect(
      gatewayRouteEnv({
        transport: 'cli',
        adapter: 'claude-code',
        thinkingLevel: 'xhigh',
      })?.UGS_THINKING_LEVEL,
    ).toBe('xhigh');
  });
});
