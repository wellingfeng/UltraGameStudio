import { beforeEach, describe, expect, it, vi } from 'vitest';
import { completeGatewayText } from './modelGateway';
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
    expect(sessionCachePercent(snapshot)).toBeCloseTo(88, 5);
  });
});
