import { invoke } from '@tauri-apps/api/core';
import { tauriAvailable } from '@/lib/tauri';
import type { ChatTurn } from './chat';

export type ChatSession = { id: string; title: string; updatedAt: number; turns: ChatTurn[]; scrollTop?: number };
type Running = { stop: () => void };

const PREFIX = 'ultragamestudio.temporaryChat.sessions.v1:';
const shared = new Map<string, ChatSessions>();

function newSession(): ChatSession {
  return { id: crypto.randomUUID(), title: '新会话', updatedAt: Date.now(), turns: [] };
}

function storageFailure(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `随手聊历史保存失败：${detail || '未知错误'}`;
}

async function historyPath(key: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return `temporary-chat/${Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')}.json`;
}

// Conversation text and reading position are stored; snapshots and model credentials stay out of history.
export class ChatSessions {
  sessions: ChatSession[] = [];
  selectedId = '';
  storageError = '';
  loading = false;
  readonly ready: Promise<void>;
  readonly running = new Map<string, Running>();
  private listeners = new Set<() => void>();
  private canWrite = true;
  private desktop = false;
  private relPath = '';
  private legacyRaw: string | null = null;
  private writes: Promise<void> = Promise.resolve();
  private writeVersion = 0;
  private unsaved = false;
  private scrollSaveTimer?: ReturnType<typeof setTimeout>;

  constructor(private key?: string) {
    this.sessions.push(newSession());
    this.selectedId = this.sessions[0].id;
    this.desktop = !!key && tauriAvailable();
    if (this.desktop && key) {
      this.loading = true;
      this.ready = this.loadDesktop(key).finally(() => { this.loading = false; this.emit(); });
    } else {
      if (key) {
        try {
          const raw = localStorage.getItem(PREFIX + encodeURIComponent(key));
          if (raw) this.restore(raw);
        } catch { this.protectHistory(); }
      }
      this.ready = Promise.resolve();
    }
  }

  private restore(raw: string) {
    const data = JSON.parse(raw) as { sessions?: ChatSession[]; selectedId?: string };
    if (!Array.isArray(data.sessions)) throw new Error('会话格式无效');
    const sessions = data.sessions.filter(s => s && typeof s.id === 'string' && typeof s.title === 'string' && Array.isArray(s.turns))
      .map(s => ({ ...s, scrollTop: typeof s.scrollTop === 'number' && Number.isFinite(s.scrollTop) && s.scrollTop >= 0 ? s.scrollTop : undefined,
        turns: s.turns.filter(t => t && typeof t.user === 'string' && typeof t.assistant === 'string')
        .map(t => ({ ...t, status: t.status === 'running' ? 'stopped' as const : t.status })) }));
    this.sessions = sessions.length ? sessions : [newSession()];
    this.selectedId = typeof data.selectedId === 'string' && this.sessions.some(s => s.id === data.selectedId)
      ? data.selectedId : this.sessions[0].id;
  }

  private protectHistory() {
    this.canWrite = false;
    this.storageError = '无法读取随手聊历史，已停止写入以保护原记录。';
  }

  private async loadDesktop(key: string) {
    try {
      this.relPath = await historyPath(key);
      const raw = await invoke<string | null>('history_read_json', { relPath: this.relPath });
      if (raw != null) {
        this.restore(raw);
        return;
      }
      const legacy = localStorage.getItem(PREFIX + encodeURIComponent(key));
      if (legacy != null) {
        this.restore(legacy);
        this.legacyRaw = legacy;
        await this.saveDesktop();
      }
    } catch { this.protectHistory(); }
  }

  private saveDesktop(): Promise<void> {
    const version = ++this.writeVersion;
    this.unsaved = true;
    // Rust's JSON parser rejects unpaired UTF-16 surrogates in streamed text.
    const json = JSON.stringify({ sessions: this.sessions, selectedId: this.selectedId }, (_key, value) =>
      typeof value === 'string' ? value.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD') : value);
    this.writes = this.writes.then(async () => {
      try {
        await invoke('history_write_json', { relPath: this.relPath, json });
        if (this.legacyRaw != null && this.key) {
          try {
            const legacyKey = PREFIX + encodeURIComponent(this.key);
            if (localStorage.getItem(legacyKey) === this.legacyRaw) localStorage.removeItem(legacyKey);
          } catch { /* The disk copy is already safe. */ }
          this.legacyRaw = null;
        }
        if (version === this.writeVersion && !this.scrollSaveTimer) { this.unsaved = false; this.storageError = ''; }
      } catch (error) { this.storageError = storageFailure(error); }
      this.emit();
    });
    return this.writes;
  }

  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private emit() { this.listeners.forEach(listener => listener()); }
  notify(save = false) {
    if (save && this.key && this.canWrite && !this.loading) {
      if (this.scrollSaveTimer) { clearTimeout(this.scrollSaveTimer); this.scrollSaveTimer = undefined; }
      if (this.desktop) void this.saveDesktop();
      else {
        try {
          localStorage.setItem(PREFIX + encodeURIComponent(this.key), JSON.stringify({ sessions: this.sessions, selectedId: this.selectedId }));
          this.unsaved = false; this.storageError = '';
        } catch (error) {
          this.storageError = error instanceof DOMException && error.name === 'QuotaExceededError'
            ? '随手聊历史保存失败：浏览器本地存储已满。' : storageFailure(error);
        }
      }
    }
    this.emit();
  }
  async flush() { await this.ready; if (this.scrollSaveTimer) this.notify(true); await this.writes; }
  hasUnsavedChanges() { return this.unsaved; }
  setScrollPosition(id: string, position: number) {
    if (this.loading || !Number.isFinite(position) || position < 0) return;
    const session = this.sessions.find(s => s.id === id);
    if (!session || session.scrollTop === position) return;
    session.scrollTop = position;
    if (!this.key || !this.canWrite) return;
    this.unsaved = true;
    if (this.scrollSaveTimer) clearTimeout(this.scrollSaveTimer);
    this.scrollSaveTimer = setTimeout(() => { this.scrollSaveTimer = undefined; this.notify(true); }, 500);
  }
  select(id: string) {
    if (this.loading || !this.sessions.some(s => s.id === id)) return;
    this.selectedId = id;
    this.notify(true);
  }
  create(): string {
    if (this.loading) return this.selectedId;
    const session = newSession();
    this.sessions.unshift(session);
    this.selectedId = session.id;
    this.notify(true);
    return session.id;
  }
  delete(id: string) {
    if (this.loading || !this.sessions.some(s => s.id === id)) return;
    this.running.get(id)?.stop();
    this.sessions = this.sessions.filter(s => s.id !== id);
    if (!this.sessions.length) this.sessions.push(newSession());
    if (this.selectedId === id) this.selectedId = this.sessions[0].id;
    this.notify(true);
  }
}

export function chatSessions(key?: string): ChatSessions {
  if (!key) return new ChatSessions();
  let group = shared.get(key);
  if (!group) { group = new ChatSessions(key); shared.set(key, group); }
  return group;
}

export async function flushTemporaryChatSessions(): Promise<void> {
  const groups = [...shared.values()];
  await Promise.all(groups.map(async group => {
    await group.ready;
    if (group.running.size || group.hasUnsavedChanges()) group.notify(true);
    await group.flush();
  }));
  if (groups.some(group => group.hasUnsavedChanges())) throw new Error('随手聊历史尚未保存');
}
