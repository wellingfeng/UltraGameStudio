import { useEffect } from 'react';
import { useStore } from '@/store/useStore';
import { tauriAvailable } from '@/lib/tauri';
import { connectMessagePlatform, getMessagePlatformSnapshot, listenMessagePlatforms, loadMessagePlatforms, requestMessagePlatform, type PlatformMessage } from '@/lib/messagePlatforms';
import { runMessagePlatformTurn } from '@/lib/messagePlatformTurns';
import { aiEditSnapshots } from '@/store/channelRegistry';

export function collectPlatformNotifications(since: number) {
  const messages = new Map<string, { workspaceId: string; sessionId: string; text: string }>();
  for (const channel of aiEditSnapshots.values()) {
    if (!channel.workspaceId || !channel.sessionId) continue;
    for (const message of channel.messages) {
      if (message.role !== 'assistant' || message.localOnly || !message.text.trim() || !message.completedAt || message.completedAt <= since) continue;
      messages.set(`${channel.workspaceId}/${channel.sessionId}/${message.id}`, { workspaceId: channel.workspaceId, sessionId: channel.sessionId, text: message.text });
    }
  }
  return messages;
}

const queues = new Map<string, Promise<void>>();
const seen = new Map<string, number>();
export function dispatchPlatformMessage(message: PlatformMessage) {
  const config = getMessagePlatformSnapshot().configs.find((c) => c.id === message.platform);
  if (!config?.enabled || (!config.allowAllUsers && !config.allowedUsers.includes(message.senderId))) return;
  const now = Date.now();
  for (const [key, at] of seen) if (now - at > 300000) seen.delete(key);
  const dedup = `${message.platform}/${message.messageId}`;
  if (seen.has(dedup)) return;
  seen.set(dedup, now);
  const key = JSON.stringify([message.platform, config.workspaceId, message.chatId, message.senderId]);
  const queued = (queues.get(key) ?? Promise.resolve()).then(async () => {
    const latest = getMessagePlatformSnapshot().configs.find((c) => c.id === message.platform);
    if (!latest?.enabled || latest.workspaceId !== config.workspaceId) return;
    try {
      const text = await runMessagePlatformTurn(latest, message);
      await requestMessagePlatform(message.platform, 'send', { ...message, text });
    } catch (error) {
      console.error('[message-platform] 会话处理或回复失败', message.platform, error);
      try { await requestMessagePlatform(message.platform, 'send', { ...message, text: `UGS 处理失败：${(error as Error).message}` }); }
      catch (sendError) { console.error('[message-platform] 错误通知发送失败', message.platform, sendError); }
    }
  }).finally(() => { if (queues.get(key) === queued) queues.delete(key); });
  queues.set(key, queued);
}
export default function MessagePlatformRunner() {
  const historyReady = useStore((s) => s.historyReady);
  useEffect(() => {
    if (!historyReady || !tauriAvailable()) return;
    let disposed = false; let unlisten: (() => void) | undefined;
    const startedAt = Date.now();
    const notified = new Set<string>();
    const notify = () => {
      for (const [key, message] of collectPlatformNotifications(startedAt)) {
        for (const config of getMessagePlatformSnapshot().configs) {
          if (!config.enabled || !config.notifyOnCompletion || !['wecom', 'dingtalk'].includes(config.id) || config.workspaceId !== message.workspaceId) continue;
          const deliveryKey = `${config.id}/${key}`;
          if (notified.has(deliveryKey)) continue;
          notified.add(deliveryKey);
          const state = useStore.getState();
          const title = state.sessionTree[message.workspaceId]?.find((s) => s.id === message.sessionId)?.title ?? '会话';
          void requestMessagePlatform(config.id, 'send', { text: `UGS · ${title}\n\n${message.text}` }).catch((error) => console.error('[message-platform] 完成通知发送失败', config.id, error));
        }
      }
    };
    const timer = window.setInterval(notify, 2000);
    void (async () => {
      await loadMessagePlatforms();
      const fn = await listenMessagePlatforms(dispatchPlatformMessage);
      if (disposed) { fn(); return; }
      unlisten = fn;
      for (const config of getMessagePlatformSnapshot().configs) {
        if (disposed) break;
        if (config.enabled) await connectMessagePlatform(config.id).catch((error) => console.error('[message-platform] 自动连接失败', config.id, error));
      }
    })().catch((error) => console.error('[message-platform] 初始化失败', error));
    return () => { disposed = true; unlisten?.(); window.clearInterval(timer); };
  }, [historyReady]);
  return null;
}
