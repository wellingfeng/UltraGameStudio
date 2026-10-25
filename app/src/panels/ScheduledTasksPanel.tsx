import { useEffect, useMemo, useRef, useState } from 'react';
import { AlarmClock, ArrowLeft, Pause, Pencil, Play, Plus, Rocket, Search, Zap } from 'lucide-react';
import { createScheduledTaskSession, sessionLiveStatus, useStore } from '@/store/useStore';
import { collectScheduledSessions, type ScheduledSession } from '@/lib/scheduledTaskSessions';
import { isRtlLocale, type Locale } from '@/lib/i18n';
import { scheduleText } from '@/lib/scheduledTaskI18n';
import { nextScheduledTaskRun } from '@/lib/scheduledTasks';
import { SCHEDULED_TASK_TEMPLATES, taskFromTemplate, templateName } from '@/lib/scheduledTaskTemplates';
import type { Message, ScheduledTaskConfig } from '@/store/types';
import { historyStore } from '@/store/history/store';
import { getAiEditViewSource } from '@/store/channelRegistry';
import { workflowSessionKeyId } from '@/store/sessionKey';
import MessageContent from '@/components/ai/MessageContent';
import { MessageArtifacts } from '@/components/ai/GeneratedArtifactsCard';
import FilePreviewDrawer from '@/components/ai/FilePreviewDrawer';
import type { OpenFileFn } from '@/components/ai/FileChip';
import { parentDirectoryPath, type FileRef } from '@/components/ai/lib/filePath';
import { openLocalPath } from '@/lib/tauri';
import ScheduledTaskDialog from './ScheduledTaskDialog';
import './ScheduledTasksPanel.css';

const entryKey = ({ session, workspaceId }: ScheduledSession) => `${workspaceId ?? ''}/${session.id}`;

function TaskResults({ entry, locale }: { entry: ScheduledSession; locale: Locale }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [live, setLive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [historyCwd, setHistoryCwd] = useState<string | undefined>();
  const [preview, setPreview] = useState<{ ref: FileRef; cwd?: string } | null>(null);
  const composer = useStore((s) => s.composerBySession[workflowSessionKeyId({ workspaceId: entry.workspaceId, sessionId: entry.session.id })]?.composer);
  useEffect(() => {
    let cancelled = false;
    let loading = false;
    const refresh = async () => {
      if (loading) return;
      loading = true;
      try {
        const source = getAiEditViewSource(entry.workspaceId, entry.session.id);
        const record = source ? null : entry.workspaceId ? await historyStore.getSession(entry.workspaceId, entry.session.id) : null;
        if (cancelled) return;
        setMessages(source?.messages ?? record?.messages ?? []);
        const executionPath = record?.meta?.scheduledTaskExecutionPath;
        setHistoryCwd(source?.workspaceRootPath ?? (typeof executionPath === 'string' ? executionPath : undefined)
          ?? useStore.getState().workspaces.find((workspace) => workspace.id === entry.workspaceId)?.path);
        setLive(Boolean(sessionLiveStatus({ workspaceId: entry.workspaceId, sessionId: entry.session.id }, useStore.getState())));
        setError(null);
      } catch (reason) { if (!cancelled) setError(String(reason)); }
      finally { loading = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [entry.workspaceId, entry.session.id]);
  const visible = messages.filter((message) => !message.localOnly);
  const cwd = composer?.workspace || historyCwd;
  const fileOpener = (messageCwd?: string): OpenFileFn => (ref, intent) => {
    if (intent?.reveal) {
      void openLocalPath(ref.path, { cwd: messageCwd, reveal: true });
    } else if (intent?.openContainingFolder) {
      const parent = parentDirectoryPath(ref.path) || messageCwd;
      if (parent) void openLocalPath(parent, { cwd: messageCwd });
    } else {
      setPreview({ ref, cwd: messageCwd });
    }
  };
  return <section aria-label={scheduleText(locale, 'history')} className="scheduled-task-results">
    <h3 className="scheduled-task-label">{scheduleText(locale, 'history')}{live && <span className="ms-2 text-accent">{scheduleText(locale, 'busy')}</span>}</h3>
    {error && <p role="alert" className="text-xs text-status-error">{error}</p>}
    {!visible.length && !error && <p className="text-xs text-fg-faint">{scheduleText(locale, 'noRuns')}</p>}
    <div className="space-y-4">{visible.map((message, index) => {
      const messageCwd = message.fileChanges?.rootPath ?? cwd;
      const onOpenFile = fileOpener(messageCwd);
      return <article key={message.id} className="scheduled-task-result">
        <p className="mb-2 text-[11px] text-fg-faint">{new Date(message.createdAt).toLocaleString(locale)} · {scheduleText(locale, message.role === 'user' ? 'prompt' : 'history')}</p>
        <MessageContent text={message.text} cwd={messageCwd} onOpenFile={onOpenFile} streaming={live && index === visible.length - 1 && message.role === 'assistant'} showActions />
        {message.role === 'assistant' && <MessageArtifacts text={message.text} cwd={messageCwd} onOpenFile={onOpenFile} />}
      </article>;
    })}</div>
    <FilePreviewDrawer refData={preview?.ref ?? null} cwd={preview?.cwd} onClose={() => setPreview(null)} />
  </section>;
}

export default function ScheduledTasksPanel({ locale, onClose }: { locale: Locale; onClose: () => void }) {
  const panel = useRef<HTMLElement>(null);
  const sessions = useStore((s) => s.sessions);
  const sessionTree = useStore((s) => s.sessionTree);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const [query, setQuery] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ task: ScheduledTaskConfig; target?: ScheduledSession } | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  const tasks = useMemo(() => collectScheduledSessions(sessions, sessionTree, activeWorkspaceId), [sessions, sessionTree, activeWorkspaceId]);
  const search = query.trim().toLocaleLowerCase(locale);
  const shown = tasks.filter(({ session, scheduledTask }) => `${scheduledTask.name ?? session.title} ${scheduledTask.reminderText}`.toLocaleLowerCase(locale).includes(search));
  const templates = SCHEDULED_TASK_TEMPLATES.filter((template) => templateName(template, locale).toLocaleLowerCase(locale).includes(search));
  const selected = shown.find((entry) => entryKey(entry) === selectedKey) ?? shown[0];

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    const element = panel.current;
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && !draft && !pending) onClose();
    };
    element?.addEventListener('keydown', keydown);
    return () => element?.removeEventListener('keydown', keydown);
  }, [draft, onClose, pending]);
  useEffect(() => { panel.current?.focus(); }, []);

  const action = async (id: string, callback: () => Promise<void>) => {
    setPending(id);
    setError(null);
    try { await callback(); }
    catch (reason) { setError(`${scheduleText(locale, 'failed')}：${String(reason)}`); }
    finally { setPending(null); }
  };
  const save = async (task: ScheduledTaskConfig) => {
    if (!draft?.target) {
      const key = await createScheduledTaskSession(task);
      setQuery(''); setSelectedKey(`${key.workspaceId ?? ''}/${key.sessionId}`); return;
    }
    const { session, workspaceId } = draft.target;
    await useStore.getState().setWorkflowScheduledTaskSession(session.id, workspaceId, task);
  };
  const run = async ({ session, workspaceId, scheduledTask }: ScheduledSession) => {
    const state = useStore.getState();
    if (sessionLiveStatus({ sessionId: session.id, workspaceId }, state)) throw new Error(scheduleText(locale, 'busy'));
    await state.runScheduledTaskSession(session.id, workspaceId, { ...scheduledTask, enabled: true });
    // Running now does not consume a future one-time occurrence or disable its schedule.
    const current = useStore.getState();
    const latest = collectScheduledSessions(current.sessions, current.sessionTree, current.activeWorkspaceId).find((entry) => entry.session.id === session.id && entry.workspaceId === workspaceId)?.scheduledTask;
    if (latest?.updatedAt !== scheduledTask.updatedAt) return;
    await current.setWorkflowScheduledTaskSession(session.id, workspaceId, { ...latest, lastRunAt: Date.now(), lastError: undefined, updatedAt: Date.now() });
  };
  const toggle = async ({ session, workspaceId, scheduledTask }: ScheduledSession) => {
    if (!scheduledTask.enabled && scheduledTask.onceAt !== undefined && scheduledTask.onceAt <= Date.now()) {
      setDraft({ task: { ...scheduledTask, enabled: true }, target: { session, workspaceId, scheduledTask } });
      return;
    }
    await useStore.getState().setWorkflowScheduledTaskSession(session.id, workspaceId, { ...scheduledTask, enabled: !scheduledTask.enabled, updatedAt: Date.now() });
  };
  const dateLabel = (timestamp: number | Date, timeZone?: string) => new Date(timestamp).toLocaleString(locale, { timeZone, dateStyle: 'medium', timeStyle: 'short' });

  return <>
    <section ref={panel} tabIndex={-1} aria-label={scheduleText(locale, 'title')} data-ugs-scheduled-tasks dir={isRtlLocale(locale) ? 'rtl' : 'ltr'} className="scheduled-tasks-page">
      <header className="scheduled-tasks-header">
        <div>
          <h2>{scheduleText(locale, 'title')}</h2>
          <p>{tasks.length} · {scheduleText(locale, 'title')}</p>
        </div>
        <button type="button" onClick={onClose} disabled={pending !== null} aria-label={scheduleText(locale, 'returnToChat')} className="scheduled-task-text-button"><ArrowLeft size={14} />{scheduleText(locale, 'returnToChat')}</button>
      </header>
      <div className="scheduled-tasks-body">
        <nav aria-label={scheduleText(locale, 'title')} className="scheduled-tasks-sidebar">
          <label className="scheduled-task-search">
            <Search size={14} className="pointer-events-none absolute start-2.5 top-2.5 text-fg-faint" />
            <input type="search" aria-label={scheduleText(locale, 'search')} placeholder={scheduleText(locale, 'search')} value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            <div className="scheduled-task-list">
              {shown.map((entry) => <button key={entryKey(entry)} type="button" aria-pressed={selected === entry} title={entry.scheduledTask.name ?? entry.session.title} onClick={() => { setSelectedKey(entryKey(entry)); setError(null); }} className="scheduled-task-nav-item">
                <span className={`scheduled-task-dot ${entry.scheduledTask.enabled ? 'is-enabled' : ''}`} /><span className="truncate">{entry.scheduledTask.name ?? entry.session.title}</span>
              </button>)}
              <button type="button" title={scheduleText(locale, 'create')} aria-label={scheduleText(locale, 'create')} onClick={() => setDraft({ task: taskFromTemplate(SCHEDULED_TASK_TEMPLATES[4], locale) })} className="scheduled-task-add"><Plus size={15} /></button>
            </div>
            <div role="group" aria-label={scheduleText(locale, 'templates')}>
              <p className="scheduled-task-label px-2">{scheduleText(locale, 'templates')}</p>
              {templates.map((template) => <button key={template.id} type="button" onClick={() => { setError(null); setDraft({ task: taskFromTemplate(template, locale) }); }} className="scheduled-task-nav-item"><Rocket size={13} className="shrink-0 text-fg-faint" />{templateName(template, locale)}</button>)}
            </div>
          </div>
        </nav>
        <main className="scheduled-tasks-main">
          <div className="scheduled-tasks-content">
            {error && <p role="alert" className="mb-4 text-sm text-status-error">{error}</p>}
            {shown.length === 0 ? <div className="flex min-h-[280px] h-full flex-col items-center justify-center gap-3 text-center">
              <div className="p-4 text-fg-faint"><AlarmClock size={28} /></div>
              <h3 className="mt-2 text-sm font-semibold text-fg">{scheduleText(locale, search ? 'noResults' : 'empty')}</h3>
              <p className="max-w-sm text-xs leading-6 text-fg-faint">{scheduleText(locale, 'hint')}</p>
              <button type="button" onClick={() => setDraft({ task: taskFromTemplate(SCHEDULED_TASK_TEMPLATES[4], locale) })} className="scheduled-task-primary"><Plus size={14} />{scheduleText(locale, 'create')}</button>
            </div> : <div className="grid gap-3">
              {(selected ? [selected] : []).map((entry) => {
                const { session, scheduledTask: task, workspaceId } = entry;
                const key = `${workspaceId ?? ''}/${session.id}`;
                let next: Date | null = null;
                try { next = nextScheduledTaskRun(task, now); } catch { /* Invalid legacy data remains editable. */ }
                return <article key={key} className="scheduled-task-detail">
                  <div className="scheduled-task-detail-header">
                    <div className="scheduled-task-heading">
                      <h3>{task.name ?? session.title}</h3>
                      <span className="scheduled-task-status">{scheduleText(locale, task.enabled ? 'enabled' : 'paused')}</span>
                    </div>
                    <div className="scheduled-task-actions">
                      <button type="button" disabled={pending !== null} aria-label={scheduleText(locale, 'edit')} title={scheduleText(locale, 'edit')} onClick={() => setDraft({ task, target: entry })} className="scheduled-task-icon-button"><Pencil size={14} /></button>
                      <button type="button" disabled={pending !== null} onClick={() => void action(key, () => toggle(entry))} className="scheduled-task-text-button">{task.enabled ? <Pause size={13} /> : <Play size={13} />}{scheduleText(locale, task.enabled ? 'pause' : 'resume')}</button>
                      <button type="button" disabled={pending !== null} onClick={() => void action(key, () => run(entry))} className="scheduled-task-primary"><Zap size={13} />{scheduleText(locale, 'run')}</button>
                    </div>
                  </div>
                  <dl className="scheduled-task-metadata">
                    <dt className="text-fg-faint">{scheduleText(locale, task.onceAt !== undefined ? 'once' : task.cronExpression ? 'cron' : 'weekly')}</dt><dd className="font-mono">{task.cronExpression ?? (task.onceAt !== undefined ? dateLabel(task.onceAt, task.timeZone) : `${task.weekdays.join(', ')} · ${task.hour.toString().padStart(2, '0')}:${task.minute.toString().padStart(2, '0')}:${task.second.toString().padStart(2, '0')}`)}</dd>
                    <dt className="text-fg-faint">{scheduleText(locale, 'last')}</dt><dd>{task.lastRunAt ? dateLabel(task.lastRunAt, task.timeZone) : '—'}</dd>
                    <dt className="text-fg-faint">{scheduleText(locale, 'next')}</dt><dd>{task.enabled ? next ? dateLabel(next, task.timeZone) : '—' : scheduleText(locale, 'paused')}</dd>
                    <dt className="text-fg-faint">{scheduleText(locale, 'timeZone')}</dt><dd>{task.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone}</dd>
                  </dl>
                  <h3 className="scheduled-task-label">{scheduleText(locale, 'prompt')}</h3>
                  <p className="scheduled-task-prompt">{task.reminderText}</p>
                  {task.lastError && <p className="mb-3 break-words text-xs text-status-error">{task.lastError}</p>}
                  <TaskResults key={key} entry={entry} locale={locale} />
                </article>;
              })}
            </div>}
          </div>
          <footer className="scheduled-tasks-footer">{scheduleText(locale, 'availability')}</footer>
        </main>
      </div>
    </section>
    {draft && <ScheduledTaskDialog key={`${draft.target?.session.id ?? 'new'}/${draft.task.templateId ?? ''}`} locale={locale} title={draft.task.name ?? draft.target?.session.title ?? scheduleText(locale, 'create')} initialTask={draft.task} canDelete={Boolean(draft.target)} onClose={() => setDraft(null)} onSave={save} onDelete={async () => { if (draft.target) await useStore.getState().setWorkflowScheduledTaskSession(draft.target.session.id, draft.target.workspaceId, null); }} />}
  </>;
}
