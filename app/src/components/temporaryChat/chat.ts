import { Channel, invoke } from '@tauri-apps/api/core';
import type { ChatContext, ContextSource } from './context';
import { chatSessions, type ChatSession, type ChatSessions } from './sessions';

export type ChatModel = { providerId: string; model: string; label: string };
export type ChatTurn = { user: string; assistant: string; status: 'running' | 'done' | 'stopped' | 'error'; error?: string };
export type ChatEvent = { type: 'delta'; text: string } | { type: 'done' } | { type: 'error'; message: string };
export type ChatRequest = { requestId: string; providerId: string; model: string; messages: { role: string; content: string }[]; context?: { text: string; image?: { mime: string; base64: string } } };
export type ChatState = {
  models: ChatModel[]; selected: number; turns: ChatTurn[]; busy: boolean; status: string; error: string;
  sessions: Pick<ChatSession, 'id' | 'title' | 'updatedAt'>[]; sessionId: string; scrollTop?: number; storageError: string; historyLoading: boolean;
  reference?: { label: string; status: 'loading' | 'ready' | 'error'; note?: string };
};
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

type Active = { id: string; group: ChatSessions; session: ChatSession; turn: ChatTurn; started: Promise<void> };

export class TemporaryChat {
  state: ChatState = { models: [], selected: 0, turns: [], busy: false, status: '正在读取渠道…', error: '', sessions: [], sessionId: '', storageError: '', historyLoading: false };
  private group: ChatSessions;
  private unsubscribe: () => void;
  private sourceKey?: string;
  private active = new Set<Active>();
  private disposed = false;
  private loading = false;
  private context?: ChatContext;
  private referenceVersion = 0;

  constructor(private changed: (state: ChatState) => void, private port = nativePort, source?: ContextSource) {
    this.sourceKey = source?.key;
    this.group = chatSessions(source?.key);
    this.state.sessionId = this.group.selectedId;
    this.unsubscribe = this.group.subscribe(() => this.sync());
    this.sync();
    if (source) void this.loadContext(source);
  }

  setSource(source?: ContextSource) {
    if (source?.key === this.sourceKey && source?.key) return;
    this.unsubscribe();
    this.sourceKey = source?.key;
    this.group = chatSessions(source?.key);
    this.state.sessionId = this.group.selectedId;
    this.unsubscribe = this.group.subscribe(() => this.sync());
    ++this.referenceVersion;
    this.context = undefined;
    this.state.reference = undefined;
    this.sync();
    if (source) void this.loadContext(source);
  }

  private sync() {
    const group = this.group;
    let session = group.sessions.find(s => s.id === this.state.sessionId);
    if (!session) { session = group.sessions.find(s => s.id === group.selectedId) ?? group.sessions[0]; this.state.sessionId = session.id; }
    this.state.sessions = group.sessions.map(({ id, title, updatedAt }) => ({ id, title, updatedAt }));
    this.state.turns = session.turns;
    this.state.scrollTop = session.scrollTop;
    this.state.busy = group.running.has(session.id);
    this.state.storageError = group.storageError;
    this.state.historyLoading = group.loading;
    const last = session.turns.at(-1);
    if (group.loading) this.state.status = '正在读取随手聊历史…';
    else if (this.state.busy) this.state.status = last?.assistant ? '正在回复…' : '正在思考…';
    else if (last?.status === 'stopped') this.state.status = '已停止';
    else if (last?.status === 'error') this.state.status = '发送失败，可重试';
    else if (this.state.models.length) this.state.status = last ? '可以继续追问' : '可以开始聊天';
    this.publish();
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
    } finally { this.loading = false; this.sync(); }
  }
  select(index: number) {
    if (this.state.busy || !Number.isInteger(index) || !this.state.models[index]) return;
    this.state.selected = index; this.state.error = ''; this.state.status = '可以开始聊天'; this.publish();
  }
  selectSession(id: string) {
    if (!this.group.sessions.some(s => s.id === id)) return;
    this.state.sessionId = id;
    this.group.select(id);
  }
  newSession() {
    const id = this.group.create();
    this.state.sessionId = id;
    this.sync();
  }
  deleteSession(id: string) { this.group.delete(id); }
  setScrollPosition(id: string, position: number) { this.group.setScrollPosition(id, position); }
  send(text: string, retry = false) {
    const model = this.state.models[this.state.selected];
    const group = this.group;
    const session = group.sessions.find(s => s.id === this.state.sessionId);
    if (this.disposed || group.loading || !session || group.running.has(session.id) || (this.state.reference && this.state.reference.status !== 'ready') || !model || typeof text !== 'string' || !text.trim() || text.length > 20000) return;
    if (retry) session.turns.pop();
    const history = session.turns.filter(t => (t.status === 'done' || t.status === 'stopped') && t.assistant.trim());
    const messages = history.flatMap(t => [{ role: 'user', content: t.user }, { role: 'assistant', content: t.assistant }]);
    messages.push({ role: 'user', content: text.trim() });
    const turn: ChatTurn = { user: text.trim(), assistant: '', status: 'running' };
    session.turns.push(turn);
    if (session.title === '新会话' && session.turns.length === 1) session.title = text.trim().replace(/\s+/g, ' ').slice(0, 40);
    session.updatedAt = Date.now();
    const active: Active = { id: crypto.randomUUID(), group, session, turn, started: Promise.resolve() };
    const stop = () => this.stopActive(active);
    this.active.add(active);
    group.running.set(session.id, { stop });
    group.notify(true);
    const context = this.context ? { text: this.context.text, image: this.context.image } : undefined;
    active.started = this.port.start({ requestId: active.id, providerId: model.providerId, model: model.model, messages, ...(context ? { context } : {}) }, event => {
      if (!this.active.has(active)) return;
      if (event.type === 'delta') { turn.assistant += event.text; group.notify(); }
      else {
        this.active.delete(active); group.running.delete(session.id);
        turn.status = event.type === 'done' ? 'done' : 'error';
        turn.error = event.type === 'error' ? event.message : undefined;
        session.updatedAt = Date.now(); group.notify(true);
      }
    }).catch(error => {
      if (!this.active.has(active)) return;
      this.active.delete(active); group.running.delete(session.id); turn.status = 'error';
      turn.error = typeof error === 'string' ? error : '聊天请求失败，请重试';
      session.updatedAt = Date.now(); group.notify(true);
    });
  }
  retry() {
    const turn = this.state.turns.at(-1);
    if (turn && (turn.status === 'error' || turn.status === 'stopped')) this.send(turn.user, true);
  }
  private stopActive(active: Active) {
    if (!this.active.delete(active)) return;
    active.group.running.delete(active.session.id); active.turn.status = 'stopped';
    active.session.updatedAt = Date.now(); active.group.notify(true);
    // Cancel only after IPC admission, including when the owner window closes.
    void active.started.then(() => this.port.cancel(active.id)).catch(() => {});
  }
  stop() { this.group.running.get(this.state.sessionId)?.stop(); }
  dispose() {
    this.disposed = true;
    this.unsubscribe();
    for (const active of this.active) this.stopActive(active);
  }
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
    case 'new-session': chat.newSession(); break;
    case 'select-session': if (typeof action.id === 'string') chat.selectSession(action.id); break;
    case 'scroll': if (typeof action.id === 'string' && typeof action.position === 'number') chat.setScrollPosition(action.id, action.position); break;
    case 'delete-session': if (typeof action.id === 'string') chat.deleteSession(action.id); break;
    case 'remove-context': chat.removeContext(); break;
  }
}
