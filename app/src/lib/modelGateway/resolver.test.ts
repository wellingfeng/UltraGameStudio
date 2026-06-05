import { afterEach, describe, expect, it } from 'vitest';
import type { IRGraph } from '@/core/ir';
import { setActiveGatewaySelection } from '@/lib/gatewayConfig';
import { PROVIDERS_STORAGE } from '@/lib/apiConfig';
import {
  FREE_CHANNEL_AUTO_ID,
  FREE_CHANNEL_AUTO_MODEL,
  FREE_CHANNEL_PROVIDER_PREFIX,
  setFreeChannelModel,
} from '@/lib/freeChannels';
import {
  resolveGatewayRoute,
  nodeGatewayOverride,
  mergeGatewaySelection,
  nodeParamsWithGatewayOverride,
  normalizeGatewayWorkflow,
  workflowDefaultGatewaySelection,
  workflowGatewaySelection,
} from './resolver';
import { resolveDirectGatewayRoute } from './modelGateway';

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
    window.localStorage.setItem(
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
    expect(route.model).toBe('custom-model');
  });

  it('uses a session model override without rewriting the provider default model', () => {
    window.localStorage.setItem(
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
    window.localStorage.setItem(
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

  it('uses system CLI defaults without provider env when systemDefault is selected', () => {
    window.localStorage.setItem(
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
    window.localStorage.setItem(
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
    window.localStorage.setItem(
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
    window.localStorage.setItem(
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
    window.localStorage.setItem('fuc_model_gateway_v1', JSON.stringify(config));

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
