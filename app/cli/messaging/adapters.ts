import * as lark from '@larksuiteoapi/node-sdk';
import { randomBytes, randomUUID, createHmac } from 'node:crypto';
import QRCode from 'qrcode';
import type { MessagePlatformConfig, MessagePlatformId, PlatformMessage, PlatformStatus } from '../../src/lib/messagePlatforms';

export type GatewayConfig = MessagePlatformConfig & { secret: string; signingSecret?: string };
export type GatewayEvent = { type: 'message'; data: PlatformMessage } | { type: 'status'; data: PlatformStatus };
interface FeishuEvent {
  sender?: { sender_type?: string; sender_id?: { open_id?: string } };
  message?: { message_id: string; chat_id: string; chat_type?: string; message_type?: string; content: string; mentions?: { key: string; id?: { open_id?: string } }[] };
}
interface WeChatInbound {
  message_id?: string | number; message_type?: number; from_user_id?: string; context_token?: string;
  item_list?: { type?: number; text_item?: { text?: string } }[];
}
interface WeChatResponse {
  ret?: number; errcode?: number; qrcode?: string; qrcode_img_content?: string; status?: string; redirect_host?: string;
  bot_token?: string; ilink_bot_id?: string; ilink_user_id?: string; baseurl?: string;
  msgs?: WeChatInbound[]; get_updates_buf?: string;
}
export interface SendParams { text: string; chatId?: string; messageId?: string; contextToken?: string }
export const allowedSender = (config: MessagePlatformConfig, sender: string) => config.allowAllUsers || config.allowedUsers.includes(sender);
export function splitMessage(text: string, maxBytes = 3500): string[] {
  const chunks: string[] = []; let chunk = ''; let bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char);
    if (bytes + size > maxBytes) { chunks.push(chunk); chunk = ''; bytes = 0; }
    chunk += char; bytes += size;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}
export function parseFeishuMessage(config: MessagePlatformConfig, event: FeishuEvent): PlatformMessage | null {
  const message = event.message;
  const sender = event.sender?.sender_id?.open_id;
  if (!message || event.sender?.sender_type !== 'user' || !sender || !allowedSender(config, sender)) return null;
  if (message.chat_type === 'group' && config.groupMentionOnly && !message.mentions?.some((m) => m.id?.open_id === config.accountId)) return null;
  if (message.message_type !== 'text') return null;
  let text: string;
  try { text = JSON.parse(message.content).text; } catch { return null; }
  if (typeof text !== 'string') return null;
  for (const mention of message.mentions ?? []) text = text.replaceAll(mention.key, '');
  text = text.trim();
  if (!text || !message.message_id || !message.chat_id) return null;
  return { platform: 'feishu', senderId: sender, messageId: message.message_id, chatId: message.chat_id, text };
}
export function parseWeChatMessage(config: MessagePlatformConfig, message: WeChatInbound): PlatformMessage | null {
  const sender = message.from_user_id;
  if (message.message_type !== 1 || !sender || !allowedSender(config, sender)) return null;
  const text = (message.item_list ?? []).filter((i) => i.type === 1).map((i) => i.text_item?.text ?? '').join('\n').trim();
  if (!text || message.message_id == null) return null;
  return { platform: 'wechat', messageId: String(message.message_id), senderId: sender, chatId: sender, text, contextToken: message.context_token };
}
export function trustedWeChatBase(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !(url.hostname === 'ilinkai.weixin.qq.com' || url.hostname.endsWith('.ilinkai.weixin.qq.com'))) throw new Error('微信服务地址必须是腾讯 iLink HTTPS 域名。');
  return url.origin;
}
export function webhookPayload(id: 'wecom' | 'dingtalk', text: string) {
  return id === 'wecom' ? { msgtype: 'text', text: { content: text } } : { msgtype: 'text', text: { content: text } };
}

export class MessageGateway {
  private connections = new Map<MessagePlatformId, { config: GatewayConfig; abort: AbortController; ws?: lark.WSClient; client?: lark.Client }>();
  private seen = new Map<string, number>();
  private qrBase = new Map<string, string>();
  constructor(private emit: (event: GatewayEvent) => void, private http: typeof fetch = fetch) {}
  private status(id: MessagePlatformId, state: PlatformStatus['state'], detail?: string) { this.emit({ type: 'status', data: { id, state, detail } }); }
  private deliver(message: PlatformMessage | null) {
    if (!message) return;
    const now = Date.now();
    for (const [key, at] of this.seen) if (now - at > 300000) this.seen.delete(key);
    const key = `${message.platform}/${message.messageId}`;
    if (this.seen.has(key)) return;
    this.seen.set(key, now); this.emit({ type: 'message', data: message });
  }
  private async wechatApi(base: string, endpoint: string, token?: string, payload?: Record<string, unknown>, signal?: AbortSignal) {
    const body = payload === undefined ? undefined : JSON.stringify({ ...payload, base_info: { channel_version: '2.2.0' } });
    const response = await this.http(`${trustedWeChatBase(base)}/${endpoint}`, {
      method: body ? 'POST' : 'GET', body,
      headers: { 'Content-Type': 'application/json', 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': '131584',
        ...(body ? { AuthorizationType: 'ilink_bot_token', 'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64') } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(40000)]) : AbortSignal.timeout(40000),
    });
    if (!response.ok) throw new Error(`微信接口返回 HTTP ${response.status}`);
    const data = await response.json() as WeChatResponse;
    if ((data.ret ?? 0) !== 0 || (data.errcode ?? 0) !== 0) throw new Error(`微信接口错误 ${data.errcode ?? data.ret}`);
    return data;
  }
  async qr() {
    const data = await this.wechatApi('https://ilinkai.weixin.qq.com', 'ilink/bot/get_bot_qrcode?bot_type=3');
    if (!data.qrcode || !data.qrcode_img_content) throw new Error('微信未返回有效登录二维码。');
    this.qrBase.clear(); this.qrBase.set(data.qrcode, 'https://ilinkai.weixin.qq.com');
    return { qrcode: data.qrcode, image: await QRCode.toDataURL(data.qrcode_img_content, { width: 240, margin: 2 }), url: data.qrcode_img_content };
  }
  async checkQr(qrcode: string) {
    const base = this.qrBase.get(qrcode);
    if (!base) throw new Error('二维码已失效，请刷新。');
    const data = await this.wechatApi(base, `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`);
    if (data.status === 'scaned' && data.redirect_host) this.qrBase.set(qrcode, trustedWeChatBase(`https://${data.redirect_host}`));
    if (data.status === 'confirmed') {
      if (!data.bot_token || !data.ilink_bot_id || !data.ilink_user_id) throw new Error('微信登录凭据不完整。');
      this.qrBase.delete(qrcode);
      return { status: 'confirmed', secret: data.bot_token, accountId: data.ilink_bot_id, userId: data.ilink_user_id, baseUrl: trustedWeChatBase(data.baseurl || base) };
    }
    if (data.status === 'expired') this.qrBase.delete(qrcode);
    return { status: data.status };
  }
  async disconnect(id: MessagePlatformId) {
    const connection = this.connections.get(id);
    connection?.abort.abort(); connection?.ws?.close({ force: true }); this.connections.delete(id);
    this.status(id, 'stopped');
  }
  async connect(config: GatewayConfig) {
    await this.disconnect(config.id);
    this.status(config.id, 'connecting');
    const connection: { config: GatewayConfig; abort: AbortController; ws?: lark.WSClient; client?: lark.Client } = { config: { ...config }, abort: new AbortController() };
    this.connections.set(config.id, connection);
    try {
      if (!config.secret) throw new Error('请先配置平台凭据。');
      if (config.id === 'feishu') {
        if (!config.appId) throw new Error('请填写飞书 App ID。');
        const logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {} };
        connection.client = new lark.Client({ appId: config.appId, appSecret: config.secret, logger });
        const bot = await connection.client.request({ method: 'GET', url: '/open-apis/bot/v3/info/' }) as { code?: number; bot?: { open_id?: string } };
        if (connection.abort.signal.aborted) return;
        if (bot.code !== 0 || !bot.bot?.open_id) throw new Error(`飞书机器人认证失败（${bot.code ?? '未知错误'}）。`);
        connection.config.accountId = bot.bot.open_id;
        connection.ws = new lark.WSClient({ appId: config.appId, appSecret: config.secret, logger, autoReconnect: true,
          onReady: () => { if (!connection.abort.signal.aborted) this.status('feishu', 'connected', '飞书长连接已建立'); },
          onReconnecting: () => { if (!connection.abort.signal.aborted) this.status('feishu', 'connecting', '飞书连接中断，正在重连'); },
          onReconnected: () => { if (!connection.abort.signal.aborted) this.status('feishu', 'connected', '飞书长连接已恢复'); },
          onError: () => { if (!connection.abort.signal.aborted) this.status('feishu', 'error', '飞书长连接失败，请检查网络和应用事件配置。'); },
        });
        await connection.ws.start({ eventDispatcher: new lark.EventDispatcher({}).register({ 'im.message.receive_v1': (event) => { if (!connection.abort.signal.aborted) this.deliver(parseFeishuMessage(connection.config, event)); } }) });
      } else if (config.id === 'wechat') {
        if (!config.accountId) throw new Error('请先扫码登录微信。');
        trustedWeChatBase(config.baseUrl);
        // Mark connected only after the first successful getupdates response.
        void this.pollWeChat(connection);
        return;
      } else {
        const url = new URL(config.secret);
        const host = config.id === 'wecom' ? 'qyapi.weixin.qq.com' : 'oapi.dingtalk.com';
        const path = config.id === 'wecom' ? '/cgi-bin/webhook/send' : '/robot/send';
        if (url.protocol !== 'https:' || url.hostname !== host || url.pathname !== path || url.username || url.password) throw new Error('群机器人 Webhook 地址不正确。');
      }
      if (connection.abort.signal.aborted) return;
      if (config.id !== 'feishu') this.status(config.id, 'connected', '地址已校验，发送测试可验证权限。');
    } catch (error) {
      connection.abort.abort(); connection.ws?.close({ force: true }); this.connections.delete(config.id);
      this.status(config.id, 'error', error instanceof Error ? error.message : '连接失败'); throw error;
    }
  }
  private async pollWeChat(connection: { config: GatewayConfig; abort: AbortController }) {
    const { config, abort } = connection;
    let buffer = ''; let failures = 0;
    while (!abort.signal.aborted) {
      try {
        const data = await this.wechatApi(config.baseUrl, 'ilink/bot/getupdates', config.secret, { get_updates_buf: buffer }, abort.signal);
        if (abort.signal.aborted) break;
        failures = 0; this.status('wechat', 'connected', '微信长轮询已连接');
        for (const message of data.msgs ?? []) this.deliver(parseWeChatMessage(config, message));
        buffer = data.get_updates_buf ?? buffer;
      } catch (error) {
        if (abort.signal.aborted) break;
        if ((error as Error).name === 'TimeoutError') continue; // Empty long poll is normal.
        this.status('wechat', 'error', `${(error as Error).message}；正在重连`);
        await new Promise<void>((resolve) => {
          const finish = () => { clearTimeout(timer); abort.signal.removeEventListener('abort', finish); resolve(); };
          const timer = setTimeout(finish, Math.min(30000, 2000 * 2 ** Math.min(failures++, 4)));
          abort.signal.addEventListener('abort', finish, { once: true });
        });
      }
    }
  }
  async send(id: MessagePlatformId, params: SendParams) {
    const connection = this.connections.get(id);
    if (!connection || connection.abort.signal.aborted) throw new Error('消息平台尚未连接。');
    if (!params.text?.trim()) throw new Error('消息内容不能为空。');
    for (const text of splitMessage(params.text, id === 'feishu' ? 18000 : 3500)) {
      if (id === 'feishu') {
        if (!params.messageId) throw new Error('飞书测试需要先收到一条消息。');
        const result = await connection.client!.im.message.reply({ path: { message_id: params.messageId }, data: { msg_type: 'text', content: JSON.stringify({ text }) } });
        if (result.code !== 0) throw new Error(`飞书发送失败（${result.code}）。`);
      } else if (id === 'wechat') {
        if (!params.chatId) throw new Error('微信回复缺少会话 ID。');
        await this.wechatApi(connection.config.baseUrl, 'ilink/bot/sendmessage', connection.config.secret, { msg: { from_user_id: '', to_user_id: params.chatId, client_id: `ugs-${randomUUID()}`, message_type: 2, message_state: 2, context_token: params.contextToken, item_list: [{ type: 1, text_item: { text } }] } }, connection.abort.signal);
      } else {
        const url = new URL(connection.config.secret);
        if (id === 'dingtalk' && connection.config.signingSecret) {
          const timestamp = Date.now();
          url.searchParams.set('timestamp', String(timestamp));
          url.searchParams.set('sign', createHmac('sha256', connection.config.signingSecret).update(`${timestamp}\n${connection.config.signingSecret}`).digest('base64'));
        }
        const response = await this.http(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(webhookPayload(id, text)), signal: AbortSignal.any([connection.abort.signal, AbortSignal.timeout(15000)]) });
        if (!response.ok) throw new Error(`群通知发送失败（HTTP ${response.status}）。`);
        const result = await response.json() as { errcode?: number };
        if (result.errcode !== 0) throw new Error(`群通知发送失败（${result.errcode ?? '未知错误'}）。`);
      }
    }
    return { sent: true };
  }
  async close() { for (const id of [...this.connections.keys()]) await this.disconnect(id); }
}
