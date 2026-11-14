import { beforeEach, describe, expect, it, vi } from 'vitest';
import { completeGatewayText } from './modelGateway';
import type { GatewayTextRequest } from './types';
import { readActiveAgentUsage, readAgentUsageHistory } from '@/lib/agentUsageHistory';
import {
  readUsageMeterSnapshot,
  sessionCachePercent,
} from '@/lib/usageMeter';

const mocks = vi.hoisted(() => ({
  aiEditViaCli: vi.fn(),
  completeAnthropic: vi.fn(),
  completeOpenAICompatible: vi.fn(),
  isTauri: vi.fn(),
  primeCliRuntime: vi.fn(),
  resolveCliInvocation: vi.fn(),
}));

vi.mock('@/lib/tauri', () => ({
  aiEditViaCli: mocks.aiEditViaCli,
  isTauri: mocks.isTauri,
}));

vi.mock('@/lib/cliConfig', () => ({
  primeCliRuntime: mocks.primeCliRuntime,
  resolveCliInvocation: mocks.resolveCliInvocation,
}));

vi.mock('./adapters/anthropic', () => ({
  completeAnthropic: mocks.completeAnthropic,
}));

vi.mock('./adapters/openaiCompatible', () => ({
  completeOpenAICompatible: mocks.completeOpenAICompatible,
}));

describe('completeGatewayText', () => {
  beforeEach(() => {
    window.localStorage.clear();
    mocks.aiEditViaCli.mockReset();
    mocks.completeAnthropic.mockReset();
    mocks.completeOpenAICompatible.mockReset();
    mocks.isTauri.mockReset();
    mocks.primeCliRuntime.mockReset();
    mocks.resolveCliInvocation.mockReset();

    mocks.isTauri.mockReturnValue(true);
    mocks.primeCliRuntime.mockResolvedValue({ candidates: [] });
    mocks.resolveCliInvocation.mockResolvedValue({
      adapter: 'claude-code',
      command: 'claude',
      status: 'ready',
      source: 'system',
    });
    mocks.aiEditViaCli.mockResolvedValue('cli fallback');
  });

  it('tracks concurrent direct calls independently and removes failed calls', async () => {
    const pending: Array<{ resolve: (value: string) => void; reject: (error: Error) => void; request: GatewayTextRequest }> = [];
    mocks.completeOpenAICompatible.mockImplementation((request) => new Promise<string>((resolve, reject) => pending.push({ resolve, reject, request })));
    const route = (model: string) => ({
      selection: { adapter: 'codex' as const, modelClass: model }, adapter: 'codex' as const,
      modelClass: model, model, transport: 'openai-compatible' as const, mode: 'direct' as const,
      baseUrl: 'http://localhost:1234', label: model, source: 'global' as const,
    });
    const first = completeGatewayText({ route: route('terra'), system: '', userContent: 'one' });
    const second = completeGatewayText({ route: route('astra'), system: '', userContent: 'two' });
    expect(readActiveAgentUsage().map((row) => row.model).sort()).toEqual(['astra', 'terra']);
    pending[1].request.onUsage?.({ inputTokens: 123, outputTokens: 45 });
    expect(readActiveAgentUsage().find((row) => row.model === 'astra')).toMatchObject({ hasUsage: true, inputTokens: 123, outputTokens: 45 });
    pending[0].reject(new Error('stopped'));
    await expect(first).rejects.toThrow('stopped');
    expect(readActiveAgentUsage().map((row) => row.model)).toEqual(['astra']);
    pending[1].resolve('done');
    await expect(second).resolves.toBe('done');
    expect(readActiveAgentUsage()).toEqual([]);
    expect(readAgentUsageHistory()).toEqual([expect.objectContaining({ model: 'astra', inputTokens: 123, outputTokens: 45 })]);
  });

  it('forwards scoped skill authority and abort signal through ordinary direct-to-CLI fallback', async () => {
    mocks.completeAnthropic.mockRejectedValue(new TypeError('Failed to fetch'));
    const signal = new AbortController().signal;
    const source = { hostId: 'local', workspaceId: 'workspace-a', sessionId: 'session-a',
      turnId: 'source-main', runId: 'source-main', cwd: 'E:/frozen-project' };
    const skillTools = { source, config: { enabled: true, mode: 'auto-safe' as const }, ready: Promise.resolve() };
    await completeGatewayText({
      route: { selection: { adapter: 'claude-code', modelClass: 'sonnet' }, adapter: 'claude-code', modelClass: 'sonnet', model: 'local-model', transport: 'anthropic', mode: 'direct', baseUrl: 'http://localhost:1234', label: 'Local', source: 'global' },
      system: 'Task rules', userContent: 'Verify.', runId: 'child: exact/a', cwd: source.cwd, signal,
      ...{ skillTools },
    });
    expect(mocks.aiEditViaCli).toHaveBeenCalledWith('Task rules\n\nVerify.', 'claude-code',
      expect.objectContaining({ skillTools, signal, runId: 'child: exact/a' }));
  });

  it('preserves native tool evidence when an ordinary direct request falls back to CLI', async () => {
    mocks.completeAnthropic.mockRejectedValue(new TypeError('Failed to fetch'));
    const event = { runId: 'gateway-native', toolCallId: 'check-a', toolName: 'Bash', phase: 'end' as const, provenance: 'native-tool' as const, exitCode: 0, status: 'success' as const, args: { command: 'npm test' } };
    const onToolEvent = vi.fn();
    mocks.aiEditViaCli.mockImplementation(async (_prompt, _adapter, options) => {
      options.onTool?.(event);
      return 'Observed.';
    });
    await completeGatewayText({
      route: { selection: { adapter: 'claude-code', modelClass: 'sonnet' }, adapter: 'claude-code', modelClass: 'sonnet', model: 'test-model', transport: 'anthropic', mode: 'direct', baseUrl: 'http://localhost:1234', label: 'Local', source: 'global' },
      system: 'Task rules', userContent: 'Verify.', runId: event.runId,
      ...{ onToolEvent },
    });
    expect(onToolEvent).toHaveBeenCalledExactlyOnceWith(event);
    expect(mocks.aiEditViaCli.mock.calls[0][2].runId).toBe(event.runId);
  });

  it('falls back to Claude Code CLI when browser-direct Anthropic fetch fails', async () => {
    mocks.completeAnthropic.mockRejectedValue(new TypeError('Failed to fetch'));

    const route = {
      selection: {
        adapter: 'claude-code' as const,
        modelClass: 'sonnet' as const,
        providerId: 'relay_provider',
        channelId: 'default',
      },
      adapter: 'claude-code' as const,
      modelClass: 'sonnet' as const,
      model: 'kimi-for-coding',
      providerId: 'relay_provider',
      channelId: 'default',
      transport: 'anthropic' as const,
      mode: 'direct' as const,
      apiKey: 'sk-imported',
      baseUrl: 'https://api.kimi.com/coding/',
      label: 'Claude Code · Kimi',
      source: 'global' as const,
      env: {
        ANTHROPIC_API_KEY: 'sk-imported',
        ANTHROPIC_AUTH_TOKEN: 'sk-imported',
        ANTHROPIC_BASE_URL: 'https://api.kimi.com/coding/',
        ANTHROPIC_MODEL: 'kimi-for-coding',
      },
    };

    await expect(
      completeGatewayText({
        route,
        system: 'system prompt',
        userContent: 'user prompt',
      }),
    ).resolves.toBe('cli fallback');

    expect(mocks.aiEditViaCli).toHaveBeenCalledWith(
      'system prompt\n\nuser prompt',
      'claude-code',
      expect.objectContaining({
        cliCommand: 'claude',
        env: route.env,
        model: 'kimi-for-coding',
        permission: 'full',
      }),
    );
  });

  it('uses browser-direct Anthropic for keyless localhost routes', async () => {
    mocks.completeAnthropic.mockResolvedValue('local answer');

    const route = {
      selection: {
        adapter: 'claude-code' as const,
        modelClass: 'sonnet' as const,
        providerId: 'local_anthropic',
        channelId: 'default',
      },
      adapter: 'claude-code' as const,
      modelClass: 'sonnet' as const,
      model: 'gemini-3-flash',
      providerId: 'local_anthropic',
      channelId: 'default',
      transport: 'anthropic' as const,
      mode: 'direct' as const,
      apiKey: '',
      baseUrl: 'http://127.0.0.1:8045',
      label: 'Claude Code · Local Antigravity',
      source: 'global' as const,
    };

    await expect(
      completeGatewayText({
        route,
        system: 'system prompt',
        userContent: 'user prompt',
      }),
    ).resolves.toBe('local answer');

    expect(mocks.completeAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({ route }),
    );
    expect(mocks.aiEditViaCli).not.toHaveBeenCalled();
  });

  it('uses browser-direct OpenAI-compatible for keyless localhost routes', async () => {
    mocks.completeOpenAICompatible.mockResolvedValue('local openai answer');

    const route = {
      selection: {
        adapter: 'codex' as const,
        modelClass: 'gpt-oss' as const,
        providerId: 'local_openai',
        channelId: 'default',
      },
      adapter: 'codex' as const,
      modelClass: 'gpt-oss' as const,
      model: 'gpt-oss',
      providerId: 'local_openai',
      channelId: 'default',
      transport: 'openai-compatible' as const,
      mode: 'direct' as const,
      apiKey: '',
      baseUrl: 'http://localhost:1234/v1',
      label: 'Codex · Local OpenAI-compatible',
      source: 'global' as const,
    };

    await expect(
      completeGatewayText({
        route,
        system: 'system prompt',
        userContent: 'user prompt',
      }),
    ).resolves.toBe('local openai answer');

    expect(mocks.completeOpenAICompatible).toHaveBeenCalledWith(
      expect.objectContaining({ route }),
    );
    expect(mocks.aiEditViaCli).not.toHaveBeenCalled();
  });

  it('falls back to Codex CLI when a relay only supports Responses', async () => {
    mocks.completeOpenAICompatible.mockRejectedValue(
      new Error(
        'HTTP 400: {"error":{"code":"protocol_not_supported","message":"模型不支持 chat completions 协议"}}',
      ),
    );
    mocks.resolveCliInvocation.mockResolvedValue({
      adapter: 'codex',
      command: 'codex',
      status: 'ready',
      source: 'system',
    });

    const route = {
      selection: {
        adapter: 'codex' as const,
        modelClass: 'gpt-5.6-sol' as const,
        providerId: 'packy',
        channelId: 'default',
      },
      adapter: 'codex' as const,
      modelClass: 'gpt-5.6-sol' as const,
      model: 'gpt-5.6-sol',
      providerId: 'packy',
      channelId: 'default',
      transport: 'openai-compatible' as const,
      mode: 'direct' as const,
      apiKey: 'sk-relay',
      baseUrl: 'https://www.packyapi.com/v1',
      label: 'Codex · packy',
      source: 'global' as const,
      env: {
        OPENAI_API_KEY: 'sk-relay',
        OPENAI_BASE_URL: 'https://www.packyapi.com/v1',
      },
    };

    await expect(
      completeGatewayText({ route, system: 'system prompt', userContent: 'user prompt' }),
    ).resolves.toBe('cli fallback');
    expect(mocks.aiEditViaCli).toHaveBeenCalledWith(
      'system prompt\n\nuser prompt',
      'codex',
      expect.objectContaining({ cliCommand: 'codex', model: 'gpt-5.6-sol' }),
    );
  });

  it('records Anthropic-style CLI cache usage through the generic CLI parser', async () => {
    mocks.aiEditViaCli.mockImplementation(async (_prompt, _adapter, opts) => {
      opts.onUsage?.({
        input_tokens: 120,
        output_tokens: 40,
        cache_read_input_tokens: 800,
        cache_creation_input_tokens: 80,
      });
      return 'cli answer';
    });

    await completeGatewayText({
      route: {
        selection: { adapter: 'claude-code', modelClass: 'sonnet' },
        adapter: 'claude-code',
        modelClass: 'sonnet',
        model: 'sonnet',
        transport: 'cli',
        mode: 'cli',
        label: 'Claude Code',
        source: 'fallback',
      },
      system: 'system prompt',
      userContent: 'user prompt',
      usageContext: { workspaceId: 'w1', sessionId: 's1' },
    });

    const snapshot = readUsageMeterSnapshot({
      workspaceId: 'w1',
      sessionId: 's1',
    });
    expect(snapshot.totals.inputTokens).toBe(1000);
    expect(snapshot.totals.outputTokens).toBe(40);
    expect(snapshot.totals.totalTokens).toBe(1040);
    expect(sessionCachePercent(snapshot)).toBeCloseTo(80, 5);
  });
});
