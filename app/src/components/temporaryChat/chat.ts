import { Channel, invoke } from '@tauri-apps/api/core';
import type { ChatContext, ContextSource } from './context';

export type ChatModel = { providerId: string; model: string; label: string };
export type ChatTurn = { user: string; assistant: string; status: 'running' | 'done' | 'stopped' | 'error'; error?: string };
export type ChatEvent = { type: 'delta'; text: string } | { type: 'done' } | { type: 'error'; message: string };
export type ChatRequest = { requestId: string; providerId: string; model: string; messages: { role: string; content: string }[]; context?: { text: string; image?: { mime: string; base64: string } } };
export type ChatState = { models: ChatModel[]; selected: number; turns: ChatTurn[]; busy: boolean; status: string; error: string; reference?: { label: string; status: 'loading' | 'ready' | 'error'; note?: string } };
export interface ChatPort {
  models(): Promise<ChatModel[]>;
  start(request: ChatRequest, onEvent: (event: ChatEvent) => void): Promise<void>;
  cancel(requestId: string): Promise<void>;
}
const nativePort: ChatPort = {
  models: () => invoke('temporary_chat_models'),
  start: (request, onEvent) => {
    const channel = new Channel<ChatEvent>();
    channel.onmessage = onEvent;
    return invoke('temporary_chat_start', { request, onEvent: channel });
  },
  cancel: (requestId) => invoke('temporary_chat_cancel', { requestId }),
};

// Each panel owns one controller. Neither the store nor the general agent gateway is imported.
export class TemporaryChat {
  state: ChatState = { models: [], selected: 0, turns: [], busy: false, status: '正在读取渠道…', error: '' };
  private active?: { id: string; turn: ChatTurn; started: Promise<void> };
  private disposed = false;
  private loading = false;
  private context?: ChatContext;
  private referenceVersion = 0;
  constructor(private changed: (state: ChatState) => void, private port = nativePort, source?: ContextSource) {
    if (source) void this.loadContext(source);
  }
  private async loadContext(source: ContextSource) {
    const version = ++this.referenceVersion;
    this.state.reference = { label: source.label, status: 'loading' };
    this.publish();
    try {
      const context = await source.load();
      if (this.disposed || version !== this.referenceVersion) return;
      if (!context) { this.state.reference = undefined; this.publish(); return; }
      this.context = context;
      this.state.reference = { label: context.label, status: 'ready', note: context.note };
    } catch (error) {
      if (this.disposed || version !== this.referenceVersion) return;
      this.state.reference = { label: source.label, status: 'error', note: error instanceof Error ? error.message : String(error) };
    }
    this.publish();
  }
  removeContext() { if (this.state.busy) return; ++this.referenceVersion; this.context = undefined; this.state.reference = undefined; this.publish(); }
  publish() { if (!this.disposed) this.changed(structuredClone(this.state)); }
  async refresh() {
    if (this.state.busy || this.loading || this.disposed) return;
    this.loading = true;
    try {
      const previous = this.state.models[this.state.selected];
      const models = await this.port.models();
      if (this.disposed) return;
      this.state.models = models;
      this.state.selected = Math.max(0, models.findIndex(m => m.providerId === previous?.providerId && m.model === previous?.model));
      this.state.error = models.length ? '' : '没有可用渠道，请在设置中配置 API 地址、密钥和模型，再点刷新。';
      this.state.status = models.length ? '可以开始聊天' : '需要配置渠道';
    } catch (error) {
      if (!this.disposed) { this.state.error = typeof error === 'string' ? error : '无法读取渠道，请在桌面版中重试'; this.state.status = '渠道读取失败'; }
    } finally { this.loading = false; this.publish(); }
  }
  select(index: number) {
    if (this.state.busy || !Number.isInteger(index) || !this.state.models[index]) return;
    this.state.selected = index; this.state.error = ''; this.state.status = '可以开始聊天'; this.publish();
  }
  send(text: string, retry = false) {
    const model = this.state.models[this.state.selected];
    if (this.disposed || this.state.busy || (this.state.reference && this.state.reference.status !== 'ready') || !model || typeof text !== 'string' || !text.trim() || text.length > 20000) return;
    if (retry) this.state.turns.pop();
    const history = this.state.turns.filter(t => (t.status === 'done' || t.status === 'stopped') && t.assistant.trim());
    const messages = history.flatMap(t => [{ role: 'user', content: t.user }, { role: 'assistant', content: t.assistant }]);
    messages.push({ role: 'user', content: text.trim() });
    const turn: ChatTurn = { user: text.trim(), assistant: '', status: 'running' };
    this.state.turns.push(turn); this.state.busy = true; this.state.error = ''; this.state.status = '正在思考…';
    const id = crypto.randomUUID();
    const active = { id, turn, started: Promise.resolve() };
    this.active = active;
    this.publish();
    const context = this.context ? { text: this.context.text, image: this.context.image } : undefined;
    active.started = this.port.start({ requestId: id, providerId: model.providerId, model: model.model, messages, ...(context ? { context } : {}) }, event => {
      if (this.disposed || this.active !== active) return;
      if (event.type === 'delta') { turn.assistant += event.text; this.state.status = '正在回复…'; }
      else {
        this.active = undefined; this.state.busy = false;
        turn.status = event.type === 'done' ? 'done' : 'error';
        turn.error = event.type === 'error' ? event.message : undefined;
        this.state.status = event.type === 'done' ? '可以继续追问' : '发送失败，可重试';
      }
      this.publish();
    }).catch(error => {
      if (this.disposed || this.active !== active) return;
      this.active = undefined; this.state.busy = false; turn.status = 'error';
      turn.error = typeof error === 'string' ? error : '聊天请求失败，请重试';
      this.state.status = '发送失败，可重试'; this.publish();
    });
  }
  retry() {
    const turn = this.state.turns.at(-1);
    if (turn && (turn.status === 'error' || turn.status === 'stopped')) this.send(turn.user, true);
  }
  stop() {
    const active = this.active;
    if (!active) return;
    this.active = undefined; this.state.busy = false; active.turn.status = 'stopped';
    this.state.status = '已停止'; this.publish();
    // If stop/close raced IPC admission, cancel only after the backend registered it.
    void active.started.then(() => this.port.cancel(active.id)).catch(() => {});
  }
  dispose() { this.disposed = true; this.stop(); this.state.turns = []; }
}

export function handleChatAction(chat: TemporaryChat, data: unknown) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return;
  const action = data as Record<string, unknown>;
  if (action.scope !== 'ugs-temporary-chat' || typeof action.type !== 'string') return;
  switch (action.type) {
    case 'ready': chat.publish(); void chat.refresh(); break;
    case 'refresh': void chat.refresh(); break;
    case 'send': if (typeof action.text === 'string') chat.send(action.text); break;
    case 'stop': chat.stop(); break;
    case 'retry': chat.retry(); break;
    case 'select': if (typeof action.index === 'number') chat.select(action.index); break;
    case 'remove-context': chat.removeContext(); break;
  }
}
