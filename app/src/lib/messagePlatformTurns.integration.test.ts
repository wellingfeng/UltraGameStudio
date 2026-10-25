import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { simpleBlueprint } from '@/core/defaultBlueprint';
import { defaultComposer } from '@/store/sampleSessions';
const mocks = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock('@/lib/tauri', async (original) => ({ ...await original<typeof import('@/lib/tauri')>(), isTauri: () => false, tauriAvailable: () => false }));
vi.mock('@/lib/modelGateway/modelGateway', async (original) => ({
  ...await original<typeof import('@/lib/modelGateway/modelGateway')>(),
  resolveDirectGatewayRoute: () => ({ selection: { adapter: 'claude-code', modelClass: 'sonnet' }, adapter: 'claude-code', modelClass: 'sonnet', apiKey: 'test', model: 'sonnet', transport: 'anthropic', mode: 'direct', label: '测试模型', source: 'global' }),
  completeGatewayText: mocks.complete,
}));
import { __resetSimpleChatRuntimeForTests, useStore } from '@/store/useStore';
import { historyStore } from '@/store/history/store';
import { getAiEditViewSource } from '@/store/channelRegistry';
import { defaultPlatformConfig, type PlatformMessage } from './messagePlatforms';
import { messagePlatformSessionId, platformReplyText, runMessagePlatformTurn } from './messagePlatformTurns';

beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto);
  window.localStorage.clear();
  await historyStore.ready();
  mocks.complete.mockResolvedValue('测试回复');
});
afterEach(() => { __resetSimpleChatRuntimeForTests(); vi.unstubAllGlobals(); vi.restoreAllMocks(); mocks.complete.mockReset(); });
const message: PlatformMessage = { platform: 'feishu', messageId: 'm1', chatId: 'chat', senderId: 'owner', text: '检查工程' };
describe('外部消息使用真实 UGS 会话与模型入口', () => {
  it('会话 ID 稳定，并隔离平台、项目、群聊和发送者', async () => {
    const id = await messagePlatformSessionId(message, 'ws');
    expect(await messagePlatformSessionId({ ...message, messageId: 'm2' }, 'ws')).toBe(id);
    expect(new Set(await Promise.all([
      messagePlatformSessionId(message, 'ws'), messagePlatformSessionId(message, 'ws2'),
      messagePlatformSessionId({ ...message, platform: 'wechat' }, 'ws'),
      messagePlatformSessionId({ ...message, chatId: 'other' }, 'ws'),
      messagePlatformSessionId({ ...message, senderId: 'other' }, 'ws'),
    ]))).toHaveProperty('size', 5);
  });
  it('新建独立会话、回复模型结果，当前项目和气泡保持原状', async () => {
    const active = await historyStore.resolveWorkspaceByPath('E:/active-project');
    const target = await historyStore.resolveWorkspaceByPath('E:/message-project');
    const foreground = [{ id: 'fg', role: 'user' as const, text: '当前会话内容', createdAt: 1 }];
    useStore.setState({ locale: 'zh-CN', historyReady: true, workspaces: [active, target], activeWorkspaceId: active.id, activeSessionId: 'foreground',
      workflow: simpleBlueprint('当前会话'), composer: { ...defaultComposer, workspace: active.path }, composerBySession: {}, messages: foreground,
      sessions: [], sessionTree: { [active.id]: [], [target.id]: [] }, mode: 'design', aiEditingSessions: [], runningSessions: [], chattingSessions: [], waitingInputSessions: [], jobSessions: [] });
    const config = { ...defaultPlatformConfig('feishu'), enabled: true, allowedUsers: ['owner'], workspaceId: target.id };
    const reply = await runMessagePlatformTurn(config, message);
    expect(reply).toContain('测试回复');
    expect(useStore.getState().activeWorkspaceId).toBe(active.id);
    expect(useStore.getState().activeSessionId).toBe('foreground');
    expect(useStore.getState().messages).toEqual(foreground);
    expect(useStore.getState().composer.workspace).toBe(active.path);
    const sessionId = await messagePlatformSessionId(message, target.id);
    expect(useStore.getState().sessionTree[target.id].some((s) => s.id === sessionId)).toBe(true);
    expect(getAiEditViewSource(target.id, sessionId)?.messages.some((m) => m.text === '检查工程')).toBe(true);
    await runMessagePlatformTurn(config, { ...message, messageId: 'm2', text: '继续检查' });
    const history = getAiEditViewSource(target.id, sessionId)!.messages;
    expect(history.filter((m) => m.role === 'user').map((m) => m.text)).toEqual(['检查工程', '继续检查']);
    expect(useStore.getState().messages).toEqual(foreground);
  }, 15000);
  it('未授权的消息在调用模型前拒绝', async () => {
    await expect(runMessagePlatformTurn({ ...defaultPlatformConfig('feishu'), enabled: true, allowedUsers: [] }, message)).rejects.toThrow('未获准');
    expect(mocks.complete).not.toHaveBeenCalled();
  });
  it('回复只包含本轮助手内容，过滤本地卡片和旧消息', () => {
    expect(platformReplyText([
      { id: 'old', role: 'assistant', text: '旧回复', createdAt: 1 },
      { id: 'user', role: 'user', text: '用户输入', createdAt: 2 },
      { id: 'card', role: 'assistant', text: '本地技能卡', localOnly: true, createdAt: 3 },
      { id: 'new', role: 'assistant', text: '本轮回复', createdAt: 4 },
    ], new Set(['old']))).toBe('本轮回复');
  });
});
