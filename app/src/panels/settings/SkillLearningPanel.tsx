import { useEffect, useMemo, useRef, useState } from 'react';
import type { Locale } from '@/lib/i18n';
import { loadSkillLearningConfig, normalizeSkillLearningConfig, onSkillLearningConfigChanged, saveSkillLearningConfig } from '@/lib/skillLearningConfig';
import { createSkillHost, readPersistedSkillSourceSession, type SkillControlHost } from '@/lib/skills';
import { tauriAvailable } from '@/lib/tauri';
import { getRemoteWorkspace, isRemoteWorkspacePath, remoteWorkspaceIdFromPath, RunnerClient } from '@/lib/remoteWorkspace';
import { REMOTE_SKILL_HOST_ID } from '@ugs/protocol';
import { createRemoteSkillControlHost } from '@/lib/remoteSkillLearning';
import { historyStore } from '@/store/history/store';
import type { SessionRecord, SessionSummary } from '@/store/history/types';
import { retryPersistedSkillLearning, useStore } from '@/store/useStore';
import type { Message } from '@/store/types';
import { listGatewayRunOptions } from '@/lib/modelGateway/resolver';
import { resolveSkillReviewGatewayRoute } from '@/lib/modelGateway/skillReviewGateway';
import type { SkillEntry, SkillLearningConfig, SkillLearningMode, SkillOrigin, SkillReviewState } from '@/runtime/skills/types';
import SkillLearningSettings, { type SkillLearningModelOption } from './SkillLearningSettings';

export interface SkillLearningPanelProps {
  scope: 'global' | 'workspace';
  locale?: Locale;
  workspaceId?: string;
  /** History workspace identity differs from the remote:// config id. */
  workspacePath?: string;
  /** Remote settings must never write the local/global runtime scope. */
  remote?: boolean;
  initialWorkspaceLearning?: SkillLearningConfig;
  onWorkspaceLearningChange?: (config: SkillLearningConfig) => void;
}

type FrozenSkillReviewState = SkillReviewState & { mode?: SkillLearningMode };
type LearningMessage = Message;
interface SourceReview {
  origin: SkillOrigin;
  messageId: string;
  state?: FrozenSkillReviewState;
}

const originFields = ['hostId', 'workspaceId', 'sessionId', 'turnId', 'runId'] as const;
const originKey = (origin: SkillOrigin) => JSON.stringify([...originFields.map((key) => origin[key]), origin.cwd ?? null]);
const sameOrigin = (left: SkillOrigin, right: SkillOrigin) => originKey(left) === originKey(right);
// A reviewer owns a fresh run, but must retain the exact source location.
const sameSourceOrigin = (left: SkillOrigin, right: SkillOrigin) =>
  [left, right].every((origin) => originFields.every((key) => typeof origin[key] === 'string' && !!origin[key]))
  && (['hostId', 'workspaceId', 'sessionId', 'turnId', 'cwd'] as const).every((key) => left[key] === right[key]);

/** All live owners count, even when their session is not the selected view. */
function useLifecycleForegroundBusy() {
  return useStore((s) => s.aiStreaming || s.aiEditingSessions.length > 0 || s.chattingSessions.length > 0
    || s.runningSessions.length > 0 || s.jobSessions.length > 0);
}

/** Resolve reviewer HTTP capability separately from the source execution transport. */
function reviewModelOptions(reviewTransport: SkillLearningConfig['reviewTransport'], zh: boolean): SkillLearningModelOption[] {
  return listGatewayRunOptions().map((option) => {
    const eligible = !option.selection.systemDefault && (option.transport === 'anthropic'
      || option.transport === 'openai-compatible' || option.transport === 'cli');
    const route = eligible ? resolveSkillReviewGatewayRoute(option.selection, reviewTransport) : null;
    return {
      id: option.id, label: option.label, transport: route?.transport ?? option.transport,
      selection: { adapter: option.selection.adapter, modelClass: option.selection.modelClass,
        ...(option.selection.providerId ? { providerId: option.selection.providerId } : {}),
        ...(option.selection.channelId ? { channelId: option.selection.channelId } : {}),
        ...(option.selection.modelOverride ? { model: option.selection.modelOverride } : {}) },
      ...(route ? {} : { unavailableReason: zh
        ? '需要明确的供应商、通道、模型及可用的 completion HTTP 协议；不会启动 CLI'
        : 'A specific provider, channel, model and usable completion HTTP protocol are required; CLI is never started' }),
    };
  });
}

/** Only persisted message metadata supplies turn/run identity. Settings never mint an execution. */
function sourceReviews(record: SessionRecord): SourceReview[] {
  const reviews = new Map<string, SourceReview>();
  for (const message of record.messages as LearningMessage[]) {
    const state = message.skillLearning;
    const origin = state?.origin ?? message.skillContext?.origin;
    if (!origin || originFields.some((key) => typeof origin[key] !== 'string' || !origin[key])
      || origin.hostId !== 'local' || origin.workspaceId !== record.workspaceId || origin.sessionId !== record.id
      || state?.sourceSession !== undefined || message.skillContext?.sourceSession !== undefined
      || origin.cwd?.startsWith('remote://')) continue;
    reviews.set(originKey(origin), { origin: { ...origin }, messageId: message.id, ...(state ? { state } : {}) });
  }
  return [...reviews.values()];
}

export default function SkillLearningPanel(props: SkillLearningPanelProps) {
  return props.remote ? <RemoteSkillLearningPanel {...props} /> : <LocalSkillLearningPanel {...props} />;
}

interface RemoteBinding { readonly client: RunnerClient; readonly projectId: string; readonly serverUrl: string }

function RemoteSkillLearningPanel({ scope, locale = 'zh-CN', workspaceId, workspacePath }: SkillLearningPanelProps) {
  const zh = locale === 'zh-CN';
  const [binding, setBinding] = useState<RemoteBinding>();
  const bindingRef = useRef(binding);
  bindingRef.current = binding;
  const [config, setConfig] = useState<SkillLearningConfig>();
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const unavailable = zh
    ? '远程技能学习尚未连接。远程配置保持独立，不会修改本地配置或技能文件。'
    : 'Remote skill learning is not connected. Remote preferences remain independent; no local configuration or skill files are changed.';
  useEffect(() => {
    let cancelled = false;
    setBinding(undefined); setConfig(undefined); setStatus(''); setError(''); setSaving(false);
    if (scope !== 'workspace' || !workspaceId) return;
    void (async () => {
      const path = workspacePath ?? (await historyStore.getWorkspace(workspaceId))?.path;
      if (!path || !isRemoteWorkspacePath(path)) return;
      const remoteId = remoteWorkspaceIdFromPath(path);
      const remote = getRemoteWorkspace(remoteId);
      if (!remote?.projectId) return;
      const client = await RunnerClient.fromWorkspaceAsync(remoteId);
      if (!client) return;
      const serverUrl = client.serverUrl;
      const project = await client.getProject(remote.projectId);
      if (!project.id) throw new Error('REMOTE_SKILL_PROJECT_REQUIRED');
      const loaded = normalizeSkillLearningConfig(await client.getProjectSkillConfig(project.id));
      if (client.serverUrl !== serverUrl) throw new Error('REMOTE_SKILL_SERVER_MISMATCH');
      if (cancelled) return;
      setBinding(Object.freeze({ client, projectId: project.id, serverUrl })); setConfig(loaded);
    })().catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { cancelled = true; bindingRef.current = undefined; };
  }, [scope, workspaceId, workspacePath]);
  const save = async (value: SkillLearningConfig) => {
    const control = binding;
    if (!control || inFlight.current) return;
    inFlight.current = true; setSaving(true); setStatus(''); setError('');
    try {
      if (control.client.serverUrl !== control.serverUrl) throw new Error('REMOTE_SKILL_SERVER_MISMATCH');
      const requested = normalizeSkillLearningConfig(value);
      const saved = normalizeSkillLearningConfig(await control.client.saveProjectSkillConfig(control.projectId, requested));
      const actual = normalizeSkillLearningConfig(await control.client.getProjectSkillConfig(control.projectId));
      if (JSON.stringify(actual) !== JSON.stringify(saved) || JSON.stringify(actual) !== JSON.stringify(requested)) throw new Error('SKILL_REMOTE_CONFIG_SAVE_UNCONFIRMED');
      if (bindingRef.current === control) { setConfig(actual); setStatus(zh ? '已保存到远程服务器' : 'Saved on remote server'); }
    } catch (cause) {
      if (bindingRef.current === control) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      inFlight.current = false;
      if (bindingRef.current === control) setSaving(false);
    }
  };
  return <div className="min-w-0 space-y-3" data-skill-learning-scope="remote">
    <p className="break-words text-xs leading-relaxed text-fg-faint">{zh
      ? '远程项目偏好由服务器保存；不会写入本地学习配置或项目元数据。'
      : 'Remote project preferences are saved by the server; local learning settings and project metadata are untouched.'}</p>
    {!config ? <section className="min-w-0 rounded-lg border border-border bg-panel p-3">
      <h3 className="text-sm font-semibold text-fg">{zh ? '自动学习技能' : 'Automatic skill learning'}</h3>
      <p role="status" className="mt-2 break-words text-xs leading-relaxed text-fg-faint">{unavailable}</p>
    </section> : <RemoteSkillSourceControls key={JSON.stringify([workspaceId, workspacePath, binding?.client.serverUrl, binding?.projectId])} workspaceId={workspaceId} binding={binding} config={config} locale={locale} saving={saving} onChange={(value) => void save(value)} />}
    {saving && <p role="status" className="text-xs text-fg-dim">{zh ? '正在保存远程偏好' : 'Saving remote preferences'}</p>}
    {status && <p role="status" className="text-xs text-fg-dim">{status}</p>}
    {error && <p role="alert" className="break-words text-xs text-status-error">{error}</p>}
  </div>;
}

function remoteSourceReviews(record: SessionRecord, projectId: string, serverUrl: string): SourceReview[] {
  const reviews = new Map<string, SourceReview>();
  for (const message of record.messages) {
    const state = message.skillLearning;
    const origin = state?.origin ?? message.skillContext?.origin;
    const locator = state?.sourceSession ?? message.skillContext?.sourceSession;
    if (!origin || origin.hostId !== REMOTE_SKILL_HOST_ID || origin.workspaceId !== projectId || origin.sessionId !== record.id
      || originFields.some((key) => typeof origin[key] !== 'string' || !origin[key])
      || Object.keys(origin).some((key) => !originFields.includes(key as typeof originFields[number]))
      || !locator || locator.workspaceId !== record.workspaceId || locator.sessionId !== record.id || locator.serverUrl !== serverUrl
      || (state?.result && !sameOrigin(state.origin, state.result.origin))) continue;
    reviews.set(originKey(origin), { origin: { ...origin }, messageId: message.id, ...(state ? { state } : {}) });
  }
  return [...reviews.values()];
}

function RemoteSkillSourceControls({ workspaceId, binding, config, locale, saving, onChange }: {
  workspaceId?: string;
  binding?: RemoteBinding;
  config: SkillLearningConfig;
  locale: Locale;
  saving: boolean;
  onChange: (config: SkillLearningConfig) => void;
}) {
  const zh = locale === 'zh-CN';
  const lifecycleForegroundBusy = useLifecycleForegroundBusy();
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const activeSessionId = useStore((s) => s.activeSessionId);
  const learningRevision = useStore((s) => s.messages.map((m) => m.skillLearning ? JSON.stringify([m.id, m.skillLearning]) : m.skillContext ? JSON.stringify([m.id, m.skillContext]) : '').join('|'));
  const [sessionId, setSessionId] = useState('');
  const [sessions, setSessions] = useState<Array<Pick<SessionSummary, 'id' | 'title'>>>([]);
  const [record, setRecord] = useState<SessionRecord>();
  const [selectedOrigin, setSelectedOrigin] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [entries, setEntries] = useState<SkillEntry[]>([]);
  const [history, setHistory] = useState<SkillReviewState[]>([]);
  const [controller, setController] = useState<{ host: SkillControlHost; source: SourceReview }>();
  const controllerRef = useRef(controller); controllerRef.current = controller;
  const [reason, setReason] = useState('');
  const reviews = useMemo(() => record && binding ? remoteSourceReviews(record, binding.projectId, binding.serverUrl) : [], [record, binding]);
  const source = reviews.find((review) => originKey(review.origin) === selectedOrigin) ?? reviews.at(-1);
  useEffect(() => {
    let cancelled = false;
    setRecord(undefined); setController(undefined); setEntries([]); setHistory([]);
    setReason(zh ? '远程治理需要已保存的真实来源及执行服务器；不会为设置创建任务。' : 'Remote controls require a saved source and its execution server; settings never create a task.');
    if (!workspaceId || !binding) return;
    void (async () => {
      const listed = await historyStore.listSessions(workspaceId);
      const selected = sessionId || (activeWorkspaceId === workspaceId ? activeSessionId : undefined) || listed[0]?.id;
      if (!selected) { if (!cancelled) setSessions(listed); return; }
      const saved = await historyStore.getSession(workspaceId, selected);
      if (cancelled) return;
      if (!saved || saved.workspaceId !== workspaceId || saved.id !== selected) { setSessions(listed); return; }
      setSessions(listed.some((item) => item.id === saved.id) ? listed : [{ id: saved.id, title: saved.title }, ...listed]);
      setRecord(saved);
      setReason(remoteSourceReviews(saved, binding.projectId, binding.serverUrl).length ? '' : (zh
        ? '此会话缺少匹配的远程来源、持久化位置或执行服务器。控制已禁用，不会改写来源。'
        : 'This session has no matching remote origin, saved locator or execution server. Controls are disabled; the source is never rewritten.'));
    })().catch((cause) => { if (!cancelled) setReason(cause instanceof Error ? cause.message : String(cause)); });
    return () => { cancelled = true; controllerRef.current = undefined; };
  }, [workspaceId, binding, sessionId, activeWorkspaceId, activeSessionId, learningRevision, refresh, zh]);
  useEffect(() => {
    let cancelled = false;
    setController(undefined); setEntries([]); setHistory([]);
    if (!source || !binding) return;
    if (binding.client.serverUrl !== binding.serverUrl) { setReason('REMOTE_SKILL_SERVER_MISMATCH'); return; }
    const host = createRemoteSkillControlHost({ client: binding.client, projectId: binding.projectId, origin: source.origin, mode: source.state?.mode ?? 'off' });
    void Promise.all([host.list(), host.history()]).then(([catalog, saved]) => {
      if (cancelled) return;
      const records = new Map<string, SkillReviewState>();
      for (const result of saved.results) {
        if (!sameOrigin(result.origin, source.origin)) continue;
        const card = record?.messages.find((message) => message.skillLearning?.result?.batchId === result.batchId
          && sameOrigin(message.skillLearning.origin, result.origin))?.skillLearning;
        records.set(result.batchId, { ...card, status: result.status, origin: { ...result.origin }, result, error: result.error });
      }
      if (source.state && !records.has(source.state.result?.batchId ?? '')) records.set(source.state.result?.batchId ?? source.messageId, source.state);
      setEntries(catalog.entries); setHistory([...records.values()]); setController({ host, source }); setReason('');
    }).catch((cause) => { if (!cancelled) setReason(cause instanceof Error ? cause.message : String(cause)); });
    return () => { cancelled = true; controllerRef.current = undefined; void host.revoke?.(); };
  }, [source, binding, record]);
  const mutate = async (skillId: string, action: 'policy' | 'archive' | 'restore', policy?: Partial<Pick<SkillEntry, 'autoEditable' | 'contentLocked' | 'pinned'>>) => {
    const control = controller;
    const previous = entries.find((entry) => entry.skillId === skillId);
    if (!control || !previous) throw new Error('SKILL_CONTROL_UNAVAILABLE');
    if (!binding || binding.client.serverUrl !== binding.serverUrl) throw new Error('REMOTE_SKILL_SERVER_MISMATCH');
    const changed = action === 'policy' ? await control.host.setPolicy(skillId, policy ?? {}) : action === 'archive' ? await control.host.archive(skillId) : await control.host.restore(skillId);
    if (changed.skillId !== previous.skillId || changed.rootId !== previous.rootId || changed.scope !== previous.scope) throw new Error('SKILL_IDENTITY_MISMATCH');
    const catalog = await control.host.list();
    const actual = catalog.entries.find((entry) => entry.skillId === skillId && entry.rootId === previous.rootId && entry.scope === previous.scope);
    if (!actual || (['revision', 'hash', 'state', 'autoEditable', 'contentLocked', 'pinned'] as const).some((key) => actual[key] !== changed[key])) throw new Error('SKILL_MUTATION_UNCONFIRMED');
    if (controllerRef.current === control) setEntries(catalog.entries);
    return actual;
  };
  const reviewAction = async (state: SkillReviewState, action: 'approve' | 'reject' | 'rollback') => {
    const control = controller;
    const message = record?.messages.find((candidate) => candidate.skillLearning?.result?.batchId === state.result?.batchId && !!candidate.skillLearning && sameOrigin(candidate.skillLearning.origin, state.origin));
    const actionId = action === 'rollback' ? state.result?.rollbackId : state.result?.batchId;
    const locator = message?.skillLearning?.sourceSession;
    if (!control || !record || !message || !actionId || !locator || !binding || locator.serverUrl !== binding.serverUrl
      || locator.workspaceId !== record.workspaceId || locator.sessionId !== record.id || !sameOrigin(state.origin, control.source.origin)) throw new Error('SKILL_REVIEW_MESSAGE_REQUIRED');
    if (binding.client.serverUrl !== binding.serverUrl) throw new Error('REMOTE_SKILL_SERVER_MISMATCH');
    const actions = useStore.getState();
    const result = await actions.reviewSkillLearningAction(state, action, actionId);
    if (!sameOrigin(result.origin, state.origin) || (action !== 'rollback' && result.batchId !== state.result?.batchId)) throw new Error('SKILL_RESULT_ORIGIN_MISMATCH');
    const next = { ...state, status: result.status, action, result, error: result.error };
    await actions.updateSkillLearningState(message.id, next);
    const saved = (await historyStore.getSession(locator.workspaceId, locator.sessionId))?.messages.find((candidate) => candidate.id === message.id)?.skillLearning;
    if (!saved || !sameOrigin(saved.origin, state.origin) || saved.status !== next.status || saved.action !== action
      || JSON.stringify(saved.sourceSession) !== JSON.stringify(locator) || JSON.stringify(saved.result) !== JSON.stringify(result)) throw new Error('SKILL_HISTORY_SAVE_UNCONFIRMED');
    if (controllerRef.current === control) setHistory((current) => current.map((item) => item === state ? saved : item));
    return result;
  };
  return <div className="min-w-0 space-y-3">
    {sessions.length > 0 && <label className="block min-w-0 space-y-1 text-xs text-fg-dim"><span>{zh ? '来源会话' : 'Source session'}</span>
      <select aria-label={zh ? '来源会话' : 'Source session'} value={record?.id ?? sessionId} className="w-full min-w-0 rounded-md border border-border bg-panel px-2.5 py-2 text-xs text-fg" onChange={(event) => { setSessionId(event.currentTarget.value); setSelectedOrigin(''); }}>
        {sessions.map((session) => <option key={session.id} value={session.id}>{session.title || session.id}</option>)}
      </select></label>}
    {reviews.length > 0 && <label className="block min-w-0 space-y-1 text-xs text-fg-dim"><span>{zh ? '冻结的任务来源' : 'Frozen task origin'}</span>
      <select aria-label={zh ? '冻结的任务来源' : 'Frozen task origin'} value={source ? originKey(source.origin) : ''} className="w-full min-w-0 rounded-md border border-border bg-panel px-2.5 py-2 text-xs text-fg" onChange={(event) => setSelectedOrigin(event.currentTarget.value)}>
        {reviews.map((review) => <option key={originKey(review.origin)} value={originKey(review.origin)}>{review.state?.result?.lesson || review.origin.turnId} · {review.origin.runId}</option>)}
      </select></label>}
    {reason && <p role="status" className="break-words text-xs text-fg-faint">{reason}</p>}
    <p role="status" className="break-words text-xs text-fg-dim">{zh
      ? '远程空闲评估不可用：缺少服务器认证的服务器/租户命名空间，不借用本地或路径作用域。此远程宿主尚不支持从已保存快照重试。'
      : 'Remote idle evaluation unavailable: authenticated server/tenant namespace missing; local or path scopes are never borrowed. Retry from a saved snapshot is unavailable on this remote host.'}</p>
    <fieldset disabled={saving} className="min-w-0"><SkillLearningSettings config={config} locale={locale} entries={entries} history={history} onChange={onChange}
      lifecycleScopeKey={undefined} lifecycleForegroundBusy={lifecycleForegroundBusy} lifecycleProtection={() => ({})}
      onRetryState={undefined}
      onPolicyChange={controller ? (id, policy) => mutate(id, 'policy', policy) : undefined}
      onArchive={controller ? (id) => mutate(id, 'archive') : undefined}
      onRestore={controller ? (id) => mutate(id, 'restore') : undefined}
      onReviewAction={controller ? reviewAction : undefined} /></fieldset>
    {controller && <button type="button" className="min-h-11 rounded-md border border-border bg-panel px-3 text-xs text-fg-dim hover:border-accent" onClick={() => setRefresh((value) => value + 1)}>{zh ? '刷新目录与历史' : 'Refresh catalog and history'}</button>}
  </div>;
}

function LocalSkillLearningPanel({ scope, locale = 'zh-CN', workspaceId, initialWorkspaceLearning, onWorkspaceLearningChange }: SkillLearningPanelProps) {
  const zh = locale === 'zh-CN';
  const id = scope === 'workspace' ? workspaceId : undefined;
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const activeSessionId = useStore((s) => s.activeSessionId);
  // Streaming prose is irrelevant. Reload only when learning metadata changes.
  const learningRevision = useStore((s) => (s.messages as LearningMessage[]).map((m) =>
    m.skillLearning ? JSON.stringify([m.id, m.skillLearning.origin, m.skillLearning.status, m.skillLearning.result?.batchId])
      : m.skillContext ? JSON.stringify([m.id, m.skillContext.origin]) : '').join('|'));
  const sourceWorkspaceId = scope === 'workspace' ? workspaceId : activeWorkspaceId;
  // Native historyRootPath is the host-owned storage namespace, not the task cwd.
  const historyRootPath = useStore((s) => s.historyRootPath);
  const lifecycleForegroundBusy = useLifecycleForegroundBusy();
  const [config, setConfig] = useState(() => loadSkillLearningConfig(id));
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [sourceReason, setSourceReason] = useState('');
  const [sessionChoice, setSessionChoice] = useState<{ workspaceId: string; sessionId: string }>();
  const sessionId = sessionChoice && sessionChoice.workspaceId === sourceWorkspaceId ? sessionChoice.sessionId : '';
  const [sessions, setSessions] = useState<Array<Pick<SessionSummary, 'id' | 'title'>>>([]);
  const [record, setRecord] = useState<SessionRecord>();
  const [selectedOrigin, setSelectedOrigin] = useState('');
  const [refreshRevision, setRefreshRevision] = useState(0);
  const [modelRevision, setModelRevision] = useState(0);
  const [entries, setEntries] = useState<SkillEntry[]>([]);
  const [history, setHistory] = useState<SkillReviewState[]>([]);
  const [controller, setController] = useState<{ host: SkillControlHost; source: SourceReview }>();
  const controllerRef = useRef(controller);
  controllerRef.current = controller;
  const reviews = useMemo(() => record ? sourceReviews(record) : [], [record]);
  const source = reviews.find((review) => originKey(review.origin) === selectedOrigin) ?? reviews.at(-1);
  const modelOptions = useMemo(() => reviewModelOptions(config.reviewTransport, zh), [config.reviewTransport, modelRevision, zh]);
  const scopedEntries = entries.filter((entry) => entry.scope === 'external' || entry.scope === (scope === 'global' ? 'global' : 'project'));
  // The catalog contract exposes no trusted creation or cron metadata. Unknown stays unknown.
  const lifecycleProtection = () => ({});
  const effectiveSelection = config.reviewSelection ? { ...config.reviewSelection, modelOverride: config.reviewSelection.model }
    : record?.workflow?.meta.gateway?.defaults;
  const capability = {
    available: !!effectiveSelection && resolveSkillReviewGatewayRoute(effectiveSelection, config.reviewTransport) !== null,
    reason: zh ? '需要已配置的 completion-only HTTP 模型；CLI 和模拟通道不可用。' : 'A configured completion-only HTTP model is required. CLI and simulator routes are unavailable.',
  };

  useEffect(() => {
    const refresh = () => setModelRevision((revision) => revision + 1);
    window.addEventListener('ugs:gateway-config-changed', refresh);
    window.addEventListener('storage', refresh);
    return () => { window.removeEventListener('ugs:gateway-config-changed', refresh); window.removeEventListener('storage', refresh); };
  }, []);

  useEffect(() => {
    // One-time migration from project metadata. Existing runtime overrides win.
    if (id && initialWorkspaceLearning && window.localStorage.getItem(`ultragamestudio.skillLearningConfig.v1.workspace.${encodeURIComponent(id)}`) === null) {
      try { saveSkillLearningConfig(normalizeSkillLearningConfig(initialWorkspaceLearning), id); }
      catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    }
    setConfig(loadSkillLearningConfig(id));
    return onSkillLearningConfigChanged(setConfig, id);
  }, [id, initialWorkspaceLearning]);

  useEffect(() => {
    let cancelled = false;
    setRecord(undefined); setController(undefined); setEntries([]); setHistory([]);
    const missingSource = zh
      ? '技能目录和历史需要已有的真实来源会话；不会为设置创建会话。'
      : 'Skill catalog and history require an existing source session; settings never create one.';
    setSourceReason(missingSource);
    if (!sourceWorkspaceId || !tauriAvailable()) { setSessions([]); return; }
    void (async () => {
      const listed = await historyStore.listSessions(sourceWorkspaceId).catch(() => []);
      const selectedSessionId = sessionId || (activeWorkspaceId === sourceWorkspaceId ? activeSessionId : undefined) || listed[0]?.id;
      if (!selectedSessionId) { if (!cancelled) setSessions(listed); return; }
      const persisted = await historyStore.getSession(sourceWorkspaceId, selectedSessionId);
      if (cancelled) return;
      if (!persisted || persisted.workspaceId !== sourceWorkspaceId || persisted.id !== selectedSessionId) {
        setSourceReason(missingSource); setSessions(listed); return;
      }
      setSessions(listed.some((session) => session.id === persisted.id) ? listed : [{ id: persisted.id, title: persisted.title }, ...listed]);
      setRecord(persisted);
      setSourceReason(sourceReviews(persisted).length ? '' : (zh
        ? '此会话尚无已保存的技能来源元数据；先完成一次真实任务或显式学习。'
        : 'This session has no saved skill origin metadata yet. Complete a real task or explicit learning first.'));
    })().catch((cause) => { if (!cancelled) setSourceReason(cause instanceof Error ? cause.message : String(cause)); });
    return () => { cancelled = true; };
  }, [sourceWorkspaceId, activeWorkspaceId, activeSessionId, sessionId, learningRevision, refreshRevision, zh]);

  useEffect(() => {
    let cancelled = false;
    setController(undefined); setEntries([]); setHistory([]);
    if (!source) return;
    const host = createSkillHost({ origin: source.origin, mode: source.state?.mode ?? loadSkillLearningConfig(source.origin.workspaceId).mode, actor: 'user', evidence: [] });
    void Promise.all([host.list(), host.history()]).then(([catalog, savedHistory]) => {
      if (cancelled) return;
      setEntries(catalog.entries);
      const records = new Map<string, SkillReviewState>();
      for (const result of savedHistory.results) {
        if (!sameOrigin(result.origin, source.origin)) continue;
        const saved = (record?.messages as LearningMessage[] | undefined)?.find((message) =>
          message.skillLearning?.result?.batchId === result.batchId && sameOrigin(message.skillLearning.origin, result.origin))?.skillLearning;
        records.set(result.batchId, { ...saved, status: result.status, origin: { ...result.origin }, result, error: result.error });
      }
      if (source.state && !records.has(source.state.result?.batchId ?? '')) records.set(source.state.result?.batchId ?? source.messageId, source.state);
      setHistory([...records.values()]);
      setController({ host, source }); setSourceReason('');
    }).catch((cause) => { if (!cancelled) setSourceReason(cause instanceof Error ? cause.message : String(cause)); });
    return () => { cancelled = true; };
  }, [source, record]);

  const mutateEntry = async (skillId: string, action: 'policy' | 'archive' | 'restore', policy?: Partial<Pick<SkillEntry, 'autoEditable' | 'contentLocked' | 'pinned'>>) => {
    const control = controller;
    const previous = entries.find((entry) => entry.skillId === skillId);
    if (!control || !previous) throw new Error('SKILL_CONTROL_UNAVAILABLE');
    const changed = action === 'policy' ? await control.host.setPolicy(skillId, policy ?? {})
      : action === 'archive' ? await control.host.archive(skillId) : await control.host.restore(skillId);
    if (changed.skillId !== previous.skillId || changed.rootId !== previous.rootId || changed.scope !== previous.scope) {
      throw new Error('SKILL_IDENTITY_MISMATCH');
    }
    const catalog = await control.host.list();
    const actual = catalog.entries.find((entry) => entry.skillId === skillId && entry.rootId === previous.rootId && entry.scope === previous.scope);
    if (!actual || (['revision', 'hash', 'state', 'autoEditable', 'contentLocked', 'pinned'] as const).some((key) => actual[key] !== changed[key])) {
      throw new Error('SKILL_MUTATION_UNCONFIRMED');
    }
    if (controllerRef.current === control) setEntries(catalog.entries);
    return actual;
  };

  const reviewAction = async (state: SkillReviewState, action: 'approve' | 'reject' | 'rollback') => {
    const control = controller;
    const message = (record?.messages as LearningMessage[] | undefined)?.find((candidate) =>
      !!candidate.skillLearning && candidate.skillLearning.result?.batchId === state.result?.batchId && sameOrigin(candidate.skillLearning.origin, state.origin));
    const actionId = action === 'rollback' ? state.result?.rollbackId : state.result?.batchId;
    if (!control || !message || !actionId || !sameOrigin(state.origin, control.source.origin)) throw new Error('SKILL_REVIEW_MESSAGE_REQUIRED');
    const actions = useStore.getState();
    const result = await actions.reviewSkillLearningAction(state, action, actionId);
    if (!sameOrigin(result.origin, state.origin) || (action !== 'rollback' && result.batchId !== state.result?.batchId)) throw new Error('SKILL_RESULT_ORIGIN_MISMATCH');
    const next = { ...state, status: result.status, action, result, error: result.error };
    await actions.updateSkillLearningState(message.id, next);
    const persisted = await historyStore.getSession(state.origin.workspaceId, state.origin.sessionId);
    const saved = (persisted?.messages as LearningMessage[] | undefined)?.find((candidate) => candidate.id === message.id)?.skillLearning;
    if (!saved || !sameOrigin(saved.origin, state.origin) || saved.status !== next.status || saved.action !== action
      || JSON.stringify(saved.result) !== JSON.stringify(result)) throw new Error('SKILL_HISTORY_SAVE_UNCONFIRMED');
    if (controllerRef.current === control) {
      setHistory((current) => current.map((item) => item === state ? saved : item));
    }
    return result;
  };

  const retryReview = async (state: SkillReviewState): Promise<void> => {
    const control = controller;
    const frozen = structuredClone(state);
    setError('');
    try {
      if (!control || !frozen.resume || frozen.origin.hostId !== 'local' || frozen.sourceSession
        || !sameSourceOrigin(frozen.resume.job.origin, frozen.origin)
        || !sameOrigin(frozen.origin, control.source.origin)) throw new Error('SKILL_REVIEW_SOURCE_UNAVAILABLE');
      const { workspaceId: sourceWorkspace, sessionId: sourceSession } = frozen.origin;
      const before = await readPersistedSkillSourceSession(sourceWorkspace, sourceSession);
      const saved = before?.messages.find((message) => message.id === control.source.messageId)?.skillLearning;
      if (before?.workspaceId !== sourceWorkspace || before.id !== sourceSession || !saved || saved.sourceSession
        || !sameOrigin(saved.origin, frozen.origin) || JSON.stringify(saved) !== JSON.stringify(frozen)) throw new Error('SKILL_REVIEW_MESSAGE_REQUIRED');
      const previousState = JSON.stringify(saved);
      // resumeSkillLearningReview retains the source snapshot and selection,
      // changing only explicit admission and these current policy overrides.
      const currentConfig = loadSkillLearningConfig(sourceWorkspace);
      const job = frozen.resume.job;
      const retryResume = { ...frozen.resume, job: { ...job, explicit: true, config: {
        ...job.config, enabled: currentConfig.enabled, mode: currentConfig.mode === 'off' ? 'off' : job.config.mode,
        reviewSelection: currentConfig.reviewSelection ?? job.config.reviewSelection,
        reviewTransport: currentConfig.reviewTransport ?? job.config.reviewTransport,
      } } };
      await retryPersistedSkillLearning(frozen);
      const after = await readPersistedSkillSourceSession(sourceWorkspace, sourceSession);
      const originalNextMessage = after?.messages.find((message) => message.id === control.source.messageId);
      const originalNext = originalNextMessage?.skillLearning;
      // The retry controller may update the frozen card or persist a fresh review
      // run. Only a new card for this exact captured source can replace it.
      const freshReviews = after?.messages.filter((message) => !before!.messages.some((old) => old.id === message.id)
        && message.id === `skill-learning:${message.skillLearning?.origin.runId}`
        && message.skillLearning && sameSourceOrigin(message.skillLearning.origin, frozen.origin)) ?? [];
      if (freshReviews.length > 1) throw new Error('SKILL_HISTORY_SAVE_UNCONFIRMED');
      const nextMessage = originalNext && JSON.stringify(originalNext) !== previousState ? originalNextMessage
        : freshReviews[0] ?? originalNextMessage;
      const next = nextMessage?.skillLearning;
      if (after?.workspaceId !== sourceWorkspace || after.id !== sourceSession || !next || next.sourceSession
        || !sameSourceOrigin(next.origin, frozen.origin) || next.mode !== frozen.mode
        || (JSON.stringify(next.resume) !== JSON.stringify(frozen.resume) && JSON.stringify(next.resume) !== JSON.stringify(retryResume))
        || next.result && !sameOrigin(next.result.origin, next.origin)) throw new Error('SKILL_HISTORY_SAVE_UNCONFIRMED');
      if (JSON.stringify(next) === previousState) throw new Error('SKILL_RETRY_STATE_UNCONFIRMED');
      // Cache is only the expected write payload, never proof of durability.
      const acknowledged = (await historyStore.getSession(sourceWorkspace, sourceSession))?.messages
        .find((message) => message.id === nextMessage!.id)?.skillLearning;
      if (!acknowledged || JSON.stringify(acknowledged) !== JSON.stringify(next)) throw new Error('SKILL_HISTORY_SAVE_UNCONFIRMED');
      if (controllerRef.current === control) {
        setRecord(after);
        setHistory((current) => current.map((item) => item === state ? next : item));
      }
    } catch (cause) {
      // Keep persistence failures visible even if a metadata reload remounts the card.
      setError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    }
  };

  return <div className="min-w-0 space-y-3" data-skill-learning-scope={scope}>
    <p className="text-xs leading-relaxed text-fg-faint">{scope === 'global'
      ? (zh ? '全局偏好即时保存；项目覆盖不会修改全局配置。' : 'Global preferences save immediately. Project overrides do not change them.')
      : (zh ? '此项目的学习配置即时保存到运行时工作区覆盖。' : 'Learning preferences save immediately to this workspace runtime override.')}</p>
    {sessions.length > 0 && <label className="block min-w-0 space-y-1 text-xs text-fg-dim">
      <span>{zh ? '来源会话' : 'Source session'}</span>
      <select aria-label={zh ? '来源会话' : 'Source session'} value={record?.id ?? sessionId} className="w-full min-w-0 rounded-md border border-border bg-panel px-2.5 py-2 text-xs text-fg"
        onChange={(event) => { if (sourceWorkspaceId) setSessionChoice({ workspaceId: sourceWorkspaceId, sessionId: event.currentTarget.value }); setSelectedOrigin(''); }}>
        {sessions.map((session) => <option key={session.id} value={session.id}>{session.title || session.id}</option>)}
      </select>
    </label>}
    {reviews.length > 0 && <label className="block min-w-0 space-y-1 text-xs text-fg-dim">
      <span>{zh ? '冻结的任务来源' : 'Frozen task origin'}</span>
      <select aria-label={zh ? '冻结的任务来源' : 'Frozen task origin'} value={source ? originKey(source.origin) : ''} className="w-full min-w-0 rounded-md border border-border bg-panel px-2.5 py-2 text-xs text-fg"
        onChange={(event) => setSelectedOrigin(event.currentTarget.value)}>
        {reviews.map((review) => <option key={originKey(review.origin)} value={originKey(review.origin)}>{review.state?.result?.lesson || review.origin.turnId} · {review.origin.runId}</option>)}
      </select>
    </label>}
    {sourceReason && <p role="status" className="break-words text-xs text-fg-faint">{sourceReason}</p>}
    {controller && <p role="status" className="break-words text-xs text-fg-dim">{zh
      ? '宿主尚未提供创建与定时任务来源信息；归档建议不可用，仅提供观测提醒。'
      : 'Host creation and cron provenance unavailable; archive recommendations are disabled. Observation hints only.'}</p>}
    <SkillLearningSettings config={config} locale={locale} modelOptions={modelOptions} capability={capability} entries={scopedEntries} history={history}
      lifecycleProtection={lifecycleProtection}
      lifecycleForegroundBusy={lifecycleForegroundBusy}
      lifecycleScopeKey={controller && tauriAvailable() && historyRootPath
        ? JSON.stringify(scope === 'workspace' ? ['local', historyRootPath, 'workspace', controller.source.origin.workspaceId] : ['local', historyRootPath, 'global']) : undefined}
      onPolicyChange={controller ? (skillId, policy) => mutateEntry(skillId, 'policy', policy) : undefined}
      onArchive={controller ? (skillId) => mutateEntry(skillId, 'archive') : undefined}
      onRestore={controller ? (skillId) => mutateEntry(skillId, 'restore') : undefined}
      onReviewAction={controller ? reviewAction : undefined}
      onRetryState={controller && controller.source.state?.resume
        && sameSourceOrigin(controller.source.state.resume.job.origin, controller.source.origin) ? retryReview : undefined}
      onChange={(value) => {
      try {
        if (scope === 'workspace' && !id) throw new Error('SKILL_WORKSPACE_REQUIRED');
        const saved = saveSkillLearningConfig(normalizeSkillLearningConfig(value), id);
        const actual = loadSkillLearningConfig(id);
        if (JSON.stringify(actual) !== JSON.stringify(saved)) throw new Error('SKILL_CONFIG_SAVE_UNCONFIRMED');
        if (scope === 'workspace') onWorkspaceLearningChange?.(actual);
        setConfig(actual); setError(''); setStatus(zh ? '已保存' : 'Saved');
      } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setStatus(''); }
    }} />
    {controller && <button type="button" className="min-h-11 rounded-md border border-border bg-panel px-3 text-xs text-fg-dim hover:border-accent" onClick={() => setRefreshRevision((revision) => revision + 1)}>{zh ? '刷新目录与历史' : 'Refresh catalog and history'}</button>}
    {status && <p role="status" className="text-xs text-fg-dim">{status}</p>}
    {error && <p role="alert" className="break-words text-xs text-status-error">{error}</p>}
  </div>;
}

