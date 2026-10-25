import { tauriAvailable } from './tauri';

export type MessagePlatformId = 'feishu' | 'wechat' | 'wecom' | 'dingtalk';
export interface MessagePlatformConfig {
  id: MessagePlatformId;
  enabled: boolean;
  appId: string;
  accountId: string;
  baseUrl: string;
  allowedUsers: string[];
  allowAllUsers: boolean;
  groupMentionOnly: boolean;
  workspaceId: string;
  notifyOnCompletion: boolean;
  hasSecret?: boolean;
}
export interface PlatformStatus { id: MessagePlatformId; state: 'stopped' | 'connecting' | 'connected' | 'error'; detail?: string }
export interface PlatformMessage {
  platform: MessagePlatformId;
  messageId: string;
  chatId: string;
  senderId: string;
  text: string;
  contextToken?: string;
}
export const MESSAGE_PLATFORMS = [
  { id: 'feishu', name: '飞书', short: '飞', color: '#4c8dff', mode: '双向对话', description: '通过应用机器人，在飞书私信或群聊中使用 UGS。', guide: 'https://open.feishu.cn/document/server-docs/im-v1/message/events/receive' },
  { id: 'wechat', name: '微信', short: '微', color: '#32c96a', mode: '双向对话', description: '手机微信扫码连接 iLink 机器人，私信即可使用 UGS。', guide: 'https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/messaging/weixin.md' },
  { id: 'wecom', name: '企业微信', short: '企', color: '#49a5ff', mode: '群通知', description: '通过企业微信群机器人，将通知发送到指定群聊。', guide: 'https://developer.work.weixin.qq.com/document/path/91770' },
  { id: 'dingtalk', name: '钉钉', short: '钉', color: '#3a97ff', mode: '群通知', description: '通过钉钉自定义机器人，将通知发送到指定群聊。', guide: 'https://open.dingtalk.com/document/robots/custom-robot-access' },
] as const;
export const defaultPlatformConfig = (id: MessagePlatformId): MessagePlatformConfig => ({
  id, enabled: false, appId: '', accountId: '', baseUrl: 'https://ilinkai.weixin.qq.com',
  allowedUsers: [], allowAllUsers: false, groupMentionOnly: true, workspaceId: '', notifyOnCompletion: false,
});

interface Snapshot { configs: MessagePlatformConfig[]; statuses: Partial<Record<MessagePlatformId, PlatformStatus>>; loaded: boolean }
let snapshot: Snapshot = { configs: MESSAGE_PLATFORMS.map((p) => defaultPlatformConfig(p.id)), statuses: {}, loaded: false };
const subscribers = new Set<() => void>();
export const getMessagePlatformSnapshot = () => snapshot;
export const subscribeMessagePlatforms = (fn: () => void) => { subscribers.add(fn); return () => { subscribers.delete(fn); }; };
function update(patch: Partial<Snapshot>) { snapshot = { ...snapshot, ...patch }; subscribers.forEach((fn) => fn()); }
export async function platformInvoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!tauriAvailable()) throw new Error('消息连接需要 UGS 桌面版。');
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, args);
}
let loading: Promise<void> | undefined;
export function loadMessagePlatforms(): Promise<void> {
  if (!loading) loading = platformInvoke<MessagePlatformConfig[]>('message_platform_load').then((configs) => update({ configs, loaded: true })).catch((error) => { loading = undefined; throw error; });
  return loading;
}
export async function saveMessagePlatform(config: MessagePlatformConfig, secret?: string) {
  const saved = await platformInvoke<MessagePlatformConfig>('message_platform_save', { config, secret: secret?.trim() || null });
  update({ configs: snapshot.configs.map((c) => c.id === saved.id ? saved : c) });
  return saved;
}
export const requestMessagePlatform = <T = unknown>(id: MessagePlatformId, method: string, params: Record<string, unknown> = {}) => platformInvoke<T>('message_platform_request', { id, method, params });
export async function connectMessagePlatform(id: MessagePlatformId) { await requestMessagePlatform(id, 'connect'); }
export async function stopMessagePlatform(id: MessagePlatformId) { await requestMessagePlatform(id, 'disconnect'); }
export async function listenMessagePlatforms(onMessage: (message: PlatformMessage) => void) {
  const { listen } = await import('@tauri-apps/api/event');
  const unlisten = await listen<{ type: string; data: PlatformStatus | PlatformMessage }>('message-platform-event', ({ payload }) => {
    if (payload.type === 'status') {
      const status = payload.data as PlatformStatus;
      update({ statuses: { ...snapshot.statuses, [status.id]: status } });
    } else if (payload.type === 'message') onMessage(payload.data as PlatformMessage);
  });
  const statuses = await platformInvoke<Partial<Record<MessagePlatformId, PlatformStatus>>>('message_platform_status');
  update({ statuses });
  return unlisten;
}
