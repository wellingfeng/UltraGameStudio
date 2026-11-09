import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GatewaySelection } from '@/core/ir';
import type { ResolvedGatewayRoute } from '@/lib/modelGateway/types';

const mocks = vi.hoisted(() => ({
  providers: vi.fn(),
  refreshProvider: vi.fn(),
  catalog: vi.fn(),
  zcodeCatalog: vi.fn(),
  cli: vi.fn(),
}));
vi.mock('@/lib/apiConfig', () => ({ listProviders: mocks.providers }));
vi.mock('@/lib/modelGateway/modelGateway', () => ({ resolveCliGatewayRoute: mocks.cli }));
vi.mock('@/lib/tauri', () => ({ listCodexModels: mocks.catalog, listZcodeModels: mocks.zcodeCatalog }));
vi.mock('@/lib/modelLists', () => ({
  providerModelCacheKey: () => 'provider',
  freeChannelModelCacheKey: () => 'free',
  editableModelOptions: (_key: string, models: string[]) => models,
  refreshProviderModels: mocks.refreshProvider,
  refreshFreeChannelModels: vi.fn(),
}));
vi.mock('@/lib/freeChannels', () => ({ FREE_CHANNELS: [], FREE_CHANNEL_AUTO_ID: 'auto', isFreeChannelSelection: () => false }));

import { resolveHandoffSelection, strongestHandoffModel } from './sessionHandoffModel';

const original: GatewaySelection = { adapter: 'codex', modelClass: 'default', modelOverride: 'gpt-6.1-terra', thinkingLevel: 'high', providerId: 'p', channelId: 'default' };
const route = { adapter: 'codex', transport: 'cli', providerId: 'p', model: 'gpt-6.1-terra', baseUrl: 'https://example.test' } as ResolvedGatewayRoute;

beforeEach(() => {
  mocks.providers.mockReturnValue([{ id: 'p', kind: 'codex', apiKey: '', baseUrl: 'https://example.test', model: 'gpt-6.1-terra' }]);
  mocks.cli.mockResolvedValue({ cliCommand: 'codex' });
  mocks.catalog.mockResolvedValue([
    { id: 'gpt-6-astra', description: 'Frontier intelligence for demanding work', reasoningEfforts: ['low', 'high', 'max', 'ultra'], reasoningEffortDescriptions: { ultra: 'Maximum reasoning with automatic task delegation' } },
    { id: 'gpt-6.1-terra', description: 'balanced', reasoningEfforts: ['low', 'high'] },
  ]);
  mocks.refreshProvider.mockResolvedValue({ source: 'remote', models: ['gpt-6-astra', 'gpt-99-pro'], availableModels: ['gpt-6.1-terra', 'gpt-6-astra', 'claude-opus-99', 'gpt-image-99'] });
});

describe('交接模型选择', () => {
  it('读取实时渠道列表及 Codex 目录，最高档仅用于本次交接', async () => {
    const result = await resolveHandoffSelection(original, route, '', 'E:/project');
    expect(result).toEqual({ ...original, modelOverride: 'gpt-6-astra', thinkingLevel: 'max' });
    expect(original).toMatchObject({ modelOverride: 'gpt-6.1-terra', thinkingLevel: 'high' });
  });

  it('新版本自动进入排序；不选择其他厂商、媒体模型或过期缓存', async () => {
    mocks.refreshProvider.mockResolvedValue({ source: 'remote', models: ['gpt-99-pro'], availableModels: ['gpt-7-pro', 'claude-opus-99', 'gpt-image-99'] });
    expect((await resolveHandoffSelection(original, route, '', 'E:/project')).modelOverride).toBe('gpt-7-pro');
    expect(strongestHandoffModel(['claude-opus-5', 'claude-opus-6', 'claude-sonnet-6'], 'claude-sonnet-5', 'claude-code')).toBe('claude-opus-6');
    expect(strongestHandoffModel(['qwen3.7-plus', 'qwen3.8-max'], 'qwen3.7-plus', 'claude-code')).toBe('qwen3.8-max');
  });

  it('用户声明的档位优先于目录，非推理模型不发送档位', async () => {
    expect((await resolveHandoffSelection(original, route, 'gpt-6-astra=low,high,max', 'E:/project')).thinkingLevel).toBe('max');
  });

  it('渠道没有匹配模型时明确失败，不转到其他渠道', async () => {
    mocks.refreshProvider.mockResolvedValue({ source: 'remote', availableModels: ['claude-opus-99'] });
    await expect(resolveHandoffSelection(original, route, '', 'E:/project')).rejects.toThrow('无法从当前渠道确定可用的交接模型');
  });

  it('系统 Codex 使用自身目录，不依赖会话默认模型', async () => {
    mocks.providers.mockReturnValue([]);
    const selection = { adapter: 'codex', modelClass: 'default', systemDefault: true } as GatewaySelection;
    const result = await resolveHandoffSelection(selection, { ...route, providerId: undefined, model: undefined }, '', 'E:/project');
    expect(result).toMatchObject({ modelOverride: 'gpt-6-astra', thinkingLevel: 'max', systemDefault: true });
  });

  it('从目录描述排除自动委派模式，但继续接受未来的新思考档', async () => {
    mocks.catalog.mockResolvedValue([
      { id: 'gpt-6-astra', description: 'frontier', reasoningEfforts: ['high', 'next-depth', 'future-mode'], reasoningEffortDescriptions: { 'next-depth': 'Greater reasoning depth', 'future-mode': 'Multi-agent task delegation' } },
    ]);
    expect((await resolveHandoffSelection(original, route, '', 'E:/project')).thinkingLevel).toBe('next-depth');
  });

  it('ZCode 交集使用实际注册的模型和它自己的最高思考档', async () => {
    mocks.providers.mockReturnValue([{ id: 'p', kind: 'zcode', apiKey: '', baseUrl: 'https://example.test', model: 'glm-5.3-flash' }]);
    mocks.refreshProvider.mockResolvedValue({ source: 'remote', availableModels: ['glm-5.3-flash', 'glm-5.3', 'glm-6-pro'] });
    mocks.zcodeCatalog.mockResolvedValue([
      { id: 'glm-5.3', providerId: 'zai', description: '', reasoningEfforts: ['low', 'high', 'max'] },
      { id: 'glm-5.3-flash', providerId: 'zai', description: '', reasoningEfforts: ['disabled', 'enabled'] },
    ]);
    const selection = { ...original, adapter: 'zcode', modelOverride: 'glm-5.3-flash' };
    const result = await resolveHandoffSelection(selection, { ...route, adapter: 'zcode', model: 'glm-5.3-flash' }, '', 'E:/project');
    expect(result).toMatchObject({ modelOverride: 'zai/glm-5.3', thinkingLevel: 'max' });
  });

  it('Gemini 新代模型选择支持的最高思考档，旧模型不注入不支持的参数', async () => {
    mocks.providers.mockReturnValue([{ id: 'p', kind: 'gemini', apiKey: '', baseUrl: 'https://example.test', model: 'gemini-3.5-flash' }]);
    mocks.refreshProvider.mockResolvedValue({ source: 'remote', availableModels: ['gemini-3.5-flash', 'gemini-3.7-pro'] });
    const selection = { ...original, adapter: 'gemini', modelOverride: 'gemini-3.5-flash' };
    const geminiRoute = { ...route, adapter: 'gemini', model: 'gemini-3.5-flash' } as ResolvedGatewayRoute;
    expect(await resolveHandoffSelection(selection, geminiRoute, '', 'E:/project')).toMatchObject({ modelOverride: 'gemini-3.7-pro', thinkingLevel: 'high' });
    mocks.refreshProvider.mockResolvedValue({ source: 'remote', availableModels: ['gemini-2.5-pro'] });
    expect((await resolveHandoffSelection({ ...selection, modelOverride: 'gemini-2.5-pro' }, geminiRoute, '', 'E:/project')).thinkingLevel).toBeUndefined();
  });
});
