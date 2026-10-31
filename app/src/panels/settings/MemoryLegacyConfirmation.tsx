import { useState } from 'react';
import { historyStore } from '@/store/history/store';
import { readPersistedSkillSourceSession } from '@/lib/skills';
import { preparePendingMemoryConfirmation, confirmPendingMemorySource, type PendingMemoryConfirmationPreview } from '@/lib/memoryPending';
import type { Message } from '@/store/types';

const control = 'min-h-11 max-w-full rounded border border-border bg-bg px-3 text-xs text-fg-dim focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40';
export default function MemoryLegacyConfirmation({ id, onConfirmed }: { id: string; onConfirmed: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [workspaces, setWorkspaces] = useState<{ id: string; name: string }[]>([]);
  const [sessions, setSessions] = useState<{ id: string; title: string }[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [sourceMessageId, setSourceMessageId] = useState('');
  const [preview, setPreview] = useState<PendingMemoryConfirmationPreview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await action(); } catch (error) { setError(String(error)); }
    finally { setBusy(false); }
  };
  const reset = () => { setPreview(null); setConfirmed(false); };
  return <div className="min-w-0 space-y-2 text-xs">
    <button type="button" className={control} disabled={busy} onClick={() => void run(async () => { setWorkspaces(await historyStore.listWorkspaces()); setOpen(true); })}>确认旧提案原来源</button>
    {error && <p role="alert" className="break-all text-status-error">{error}</p>}
    {open && <div className="min-w-0 space-y-2">
      <p className="text-status-warning">旧来源未知，不推断当前项目。请选择真实保存的原项目、原会话和原用户消息；此操作仅重建安全提案，不证明旧记录来源，也不直接写记忆。</p>
      <label className="block space-y-1">原项目<select aria-label="原项目" className={`${control} block w-full`} value={workspaceId} disabled={busy} onChange={(event) => {
        const value = event.target.value; setWorkspaceId(value); setSessionId(''); setSourceMessageId(''); setSessions([]); setMessages([]); reset();
        if (value) void run(async () => { setSessions(await historyStore.listSessions(value)); });
      }}><option value="">选择原项目</option>{workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name} · {workspace.id}</option>)}</select></label>
      <label className="block space-y-1">原会话<select aria-label="原会话" className={`${control} block w-full`} value={sessionId} disabled={busy || !workspaceId} onChange={(event) => {
        const value = event.target.value; setSessionId(value); setSourceMessageId(''); setMessages([]); reset();
        if (value) void run(async () => { const record = await readPersistedSkillSourceSession(workspaceId, value); if (!record || record.workspaceId !== workspaceId || (record.sessionId ?? record.id) !== value || record.deletedAt) throw new Error('来源会话未持久保存'); setMessages(record.messages.filter((message) => message.role === 'user')); });
      }}><option value="">选择原会话</option>{sessions.map((session) => <option key={session.id} value={session.id}>{session.title} · {session.id}</option>)}</select></label>
      <label className="block space-y-1">原用户消息<select aria-label="原用户消息" className={`${control} block w-full`} value={sourceMessageId} disabled={busy || !sessionId} onChange={(event) => { setSourceMessageId(event.target.value); reset(); }}><option value="">选择原用户消息</option>{messages.map((message) => <option key={message.id} value={message.id}>{message.id} · {message.text}</option>)}</select></label>
      <button type="button" className={control} disabled={busy || !sourceMessageId} onClick={() => void run(async () => { setPreview(await preparePendingMemoryConfirmation(id, { workspaceId, sessionId, sourceMessageId })); setConfirmed(false); })}>读取原来源与当前 base</button>
      {preview && <div role="group" aria-label="旧提案完整确认" className="min-w-0 space-y-2">
        <p className="break-all text-fg">目标：{preview.base.target} · 原作用域：{preview.base.workspaceId ?? '全局用户画像'} · base：{preview.base.revision ?? '无 revision（按完整字节 CAS）'}</p>
        <pre className="whitespace-pre-wrap break-all text-fg-dim">{JSON.stringify(preview.source, null, 2)}</pre>
        <p className="text-fg-faint">当前完整 base</p><pre className="whitespace-pre-wrap break-all text-fg-dim">{JSON.stringify(preview.base.entries, null, 2)}</pre>
        <p className="text-fg-faint">完整批次 diff（不是单条预览）</p><pre className="whitespace-pre-wrap break-all text-fg-dim">{JSON.stringify(preview.batch.operations, null, 2)}</pre>
        <label className="flex min-h-11 items-start gap-2 py-3 text-fg"><input aria-label="确认完整旧提案" type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />我确认原来源、原作用域、当前完整 base 与整个批次 diff，重建后仍需审批。</label>
        <button type="button" className={control} disabled={!confirmed || busy} onClick={() => void run(async () => { await confirmPendingMemorySource(preview, confirmed); await onConfirmed(); setPreview(null); setOpen(false); })}>确认完整来源、作用域与 diff（仅重建提案）</button>
      </div>}
    </div>}
  </div>;
}
