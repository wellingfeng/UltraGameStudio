import { sessionLiveStatus, useStore } from '@/store/useStore';
import { getAiEditViewSource } from '@/store/channelRegistry';
import { historyStore } from '@/store/history/store';
import type { Message } from '@/store/types';
import type { MessagePlatformConfig, PlatformMessage } from './messagePlatforms';

export async function messagePlatformSessionId(message: PlatformMessage, workspaceId: string): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify([message.platform, workspaceId, message.chatId, message.senderId]));
  const hash = await crypto.subtle.digest('SHA-256', data);
  return `ses_im_${Array.from(new Uint8Array(hash)).map((byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 40)}`;
}
export function platformReplyText(messages: Message[], previousIds: Set<string>): string {
  const fresh = messages.filter((m) => m.role === 'assistant' && !m.localOnly && !previousIds.has(m.id));
  return fresh.map((m) => {
    const interaction = m.interaction;
    const prompt = interaction && 'prompt' in interaction ? String(interaction.prompt) : '';
    const options = interaction && 'options' in interaction && Array.isArray(interaction.options)
      ? interaction.options.map((o: unknown) => typeof o === 'string' ? o : (o as { label?: string }).label ?? '').filter(Boolean).join(' / ') : '';
    return [m.text, prompt, options].filter(Boolean).join('\n');
  }).filter(Boolean).join('\n\n');
}
export async function runMessagePlatformTurn(config: MessagePlatformConfig, message: PlatformMessage): Promise<string> {
  if (!config.enabled || (!config.allowAllUsers && !config.allowedUsers.includes(message.senderId))) throw new Error('此用户未获准调用 UGS。');
  const state = useStore.getState();
  if (!state.historyReady || !state.workspaces.some((w) => w.id === config.workspaceId)) throw new Error('消息使用的项目尚未就绪。');
  const sessionId = await messagePlatformSessionId(message, config.workspaceId);
  const key = { workspaceId: config.workspaceId, sessionId };
  let record = await historyStore.getSession(config.workspaceId, sessionId);
  if (!record) {
    record = await historyStore.createSession({ workspaceId: config.workspaceId, id: sessionId, title: `${config.id === 'feishu' ? '飞书' : '微信'} · ${message.senderId}`, isWorkflow: false, messages: [] });
    const session = { id: record.id, workspaceId: config.workspaceId, title: record.title, createdAt: record.createdAt, updatedAt: record.updatedAt, isWorkflow: false, messageCount: 0 };
    useStore.setState((s) => ({ sessions: s.activeWorkspaceId === config.workspaceId ? [session, ...s.sessions] : s.sessions,
      sessionTree: { ...s.sessionTree, [config.workspaceId]: [session, ...(s.sessionTree[config.workspaceId] ?? [])] } }));
  }
  const base = getAiEditViewSource(key.workspaceId, key.sessionId)?.messages ?? record.messages;
  const previousIds = new Set(base.map((m) => m.id));
  if (!useStore.getState().sendPrompt(message.text, { locale: 'zh-CN', externalSession: { ...key, messages: base } })) throw new Error('模型未接受消息，请检查项目模型配置。');
  // Wait for this conversation only. A clarification is relayed and the next message can answer it.
  let status = sessionLiveStatus(key, useStore.getState());
  while (status && status !== 'waiting') {
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    status = sessionLiveStatus(key, useStore.getState());
  }
  const source = getAiEditViewSource(key.workspaceId, key.sessionId);
  const messages = source?.messages ?? (await historyStore.getSession(key.workspaceId, key.sessionId))?.messages ?? [];
  return platformReplyText(messages, previousIds) || '本轮处理结束，未产生文字回复。请在 UGS 中查看会话。';
}
