// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { MessageGateway, parseFeishuMessage, parseWeChatMessage, splitMessage, trustedWeChatBase, type GatewayConfig, type GatewayEvent } from './adapters';
import { defaultPlatformConfig } from '../../src/lib/messagePlatforms';

const config: GatewayConfig = { ...defaultPlatformConfig('feishu'), enabled: true, accountId: 'bot-id', allowedUsers: ['owner'], secret: 'secret', workspaceId: 'project' };
type FeishuEventInput = Parameters<typeof parseFeishuMessage>[1];
type FeishuMessageOverrides = Partial<NonNullable<FeishuEventInput['message']>>;
const event = (overrides: FeishuMessageOverrides = {}): FeishuEventInput => ({ sender: { sender_type: 'user', sender_id: { open_id: 'owner' } }, message: { message_id: 'm1', chat_id: 'c1', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text: '你好' }), ...overrides } });
describe('消息平台真实协议适配', () => {
  it('飞书名单关闭、忽略机器人与无关群提及', () => {
    expect(parseFeishuMessage(config, event())?.text).toBe('你好');
    expect(parseFeishuMessage({ ...config, allowedUsers: [] }, event())).toBeNull();
    expect(parseFeishuMessage(config, { ...event(), sender: { sender_type: 'app', sender_id: { open_id: 'owner' } } })).toBeNull();
    expect(parseFeishuMessage(config, event({ chat_type: 'group', mentions: [{ key: '@_user_1', id: { open_id: 'someone' } }] }))).toBeNull();
    expect(parseFeishuMessage(config, event({ chat_type: 'group', mentions: [{ key: '@_user_1', id: { open_id: 'bot-id' } }], content: JSON.stringify({ text: '@_user_1 帮我检查' }) }))?.text).toBe('帮我检查');
  });
  it('微信只处理用户文字并保留上下文令牌', () => {
    const message = { message_id: 123, message_type: 1, from_user_id: 'owner', context_token: 'context', item_list: [{ type: 1, text_item: { text: '你好' } }, { type: 2, image_item: {} }] };
    expect(parseWeChatMessage({ ...config, id: 'wechat' }, message)).toMatchObject({ messageId: '123', chatId: 'owner', text: '你好', contextToken: 'context' });
    expect(parseWeChatMessage(config, { ...message, message_type: 2 })).toBeNull();
    expect(parseWeChatMessage(config, { ...message, from_user_id: 'other' })).toBeNull();
  });
  it('按 UTF-8 字节拆分，中文和表情完整', () => {
    const text = '中文🙂\n'.repeat(1400);
    const chunks = splitMessage(text);
    expect(chunks.join('')).toBe(text);
    expect(chunks.every((chunk) => Buffer.byteLength(chunk) <= 3500)).toBe(true);
  });
  it('微信拒绝非腾讯域名和伪造域名', () => {
    expect(trustedWeChatBase('https://ilinkai.weixin.qq.com')).toBe('https://ilinkai.weixin.qq.com');
    for (const url of ['http://ilinkai.weixin.qq.com', 'https://evil.example', 'https://ilinkai.weixin.qq.com.evil.example', 'https://owner:secret@ilinkai.weixin.qq.com']) expect(() => trustedWeChatBase(url)).toThrow();
  });
  it('微信扫码认证读取腾讯字段，确认前不返回凭据', async () => {
    const http = vi.fn().mockResolvedValueOnce(Response.json({ qrcode: 'token', qrcode_img_content: 'https://example.test/qr' }))
      .mockResolvedValueOnce(Response.json({ status: 'scaned' }))
      .mockResolvedValueOnce(Response.json({ status: 'confirmed', bot_token: 'bot-secret', ilink_bot_id: 'account', ilink_user_id: 'owner', baseurl: 'https://ilinkai.weixin.qq.com' }));
    const gateway = new MessageGateway(() => {}, http as typeof fetch);
    const qr = await gateway.qr(); expect(qr.image).toMatch(/^data:image\/png;base64,/);
    expect(await gateway.checkQr(qr.qrcode)).toEqual({ status: 'scaned' });
    expect(await gateway.checkQr(qr.qrcode)).toMatchObject({ status: 'confirmed', secret: 'bot-secret', accountId: 'account', userId: 'owner' });
    await expect(gateway.checkQr('token')).rejects.toThrow('已失效');
  });
  it('长轮询去重、回传 context_token、停止后取消请求', async () => {
    const events: GatewayEvent[] = [];
    let received!: () => void;
    const messageReady = new Promise<void>((resolve) => { received = resolve; });
    const incoming = { message_id: 77, message_type: 1, from_user_id: 'owner', context_token: 'ct', item_list: [{ type: 1, text_item: { text: '开始' } }] };
    const sends: { msg: unknown }[] = []; let calls = 0;
    const http = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes('sendmessage')) { sends.push(JSON.parse(String(init?.body))); return Response.json({ ret: 0 }); }
      if (++calls === 1) return Response.json({ ret: 0, msgs: [incoming, incoming], get_updates_buf: 'cursor' });
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
    });
    const gateway = new MessageGateway((e) => { events.push(e); if (e.type === 'message') received(); }, http as typeof fetch);
    await gateway.connect({ ...config, id: 'wechat', baseUrl: 'https://ilinkai.weixin.qq.com' });
    await messageReady;
    expect(events.filter((e) => e.type === 'message')).toHaveLength(1);
    await gateway.send('wechat', { text: '完成', chatId: 'owner', contextToken: 'ct' });
    expect(sends[0].msg).toMatchObject({ to_user_id: 'owner', context_token: 'ct', message_type: 2, item_list: [{ type: 1, text_item: { text: '完成' } }] });
    await gateway.close(); expect(events.at(-1)).toMatchObject({ type: 'status', data: { state: 'stopped' } });
  });
  it('企业微信与钉钉发送真实负载，平台错误不报成功', async () => {
    const http = vi.fn().mockResolvedValueOnce(Response.json({ errcode: 0 })).mockResolvedValueOnce(Response.json({ errcode: 310000 }));
    const gateway = new MessageGateway(() => {}, http as typeof fetch);
    await gateway.connect({ ...config, id: 'wecom', secret: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test' });
    expect(await gateway.send('wecom', { text: '通知' })).toEqual({ sent: true });
    expect(JSON.parse(String(http.mock.calls[0][1]?.body))).toEqual({ msgtype: 'text', text: { content: '通知' } });
    await gateway.connect({ ...config, id: 'dingtalk', secret: 'https://oapi.dingtalk.com/robot/send?access_token=test', signingSecret: 'SECtest' });
    await expect(gateway.send('dingtalk', { text: '通知' })).rejects.toThrow('310000');
    expect(String(http.mock.calls[1][0])).toContain('sign=');
    await gateway.close();
  });
});
