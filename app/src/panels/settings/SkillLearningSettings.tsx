import { useEffect, useRef, useState } from 'react';
import type { Locale } from '@/lib/i18n';
import { getBackgroundSkillWriteMode, normalizeSkillLearningConfig } from '@/lib/skillLearningConfig';
import SkillLearningCard, { type SkillLearningCardProps } from '@/components/ai/SkillLearningCard';
import type { SkillEntry, SkillLearningConfig, SkillMutationResult, SkillReviewState } from '@/runtime/skills/types';
import { startSkillLifecycleAdvisory, type SkillLifecycleAdvice } from '@/lib/skillLifecycleDesktop';

/** Safe, non-secret projection of a GatewayRunOption. An option is not a capability proof. */
export interface SkillLearningModelOption {
  id: string;
  label: string;
  selection: NonNullable<SkillLearningConfig['reviewSelection']>;
  transport: string;
  /** Legacy capability metadata; never permits a CLI review route. */
  safeForReview?: boolean;
  /** A controller may fail closed for an unconfigured HTTP route. */
  unavailableReason?: string;
}

export interface SkillLearningSettingsProps {
  config: SkillLearningConfig;
  onChange: (config: SkillLearningConfig) => void;
  locale?: Locale;
  capability?: { available: boolean; reason?: string };
  modelOptions?: SkillLearningModelOption[];
  entries?: SkillEntry[];
  /** Exact controller-bound scope. Missing identity disables persistent idle evaluation. */
  lifecycleScopeKey?: string;
  lifecycleForegroundBusy?: boolean;
  lifecycleProtection?: (entry: SkillEntry) => { backgroundCreated?: boolean; cronReferenced?: boolean };
  onPolicyChange?: (skillId: string, policy: Partial<Pick<SkillEntry, 'autoEditable' | 'contentLocked' | 'pinned'>>) => Promise<SkillEntry>;
  onArchive?: (skillId: string) => Promise<SkillEntry>;
  onRestore?: (skillId: string) => Promise<SkillEntry>;
  /** Accept legacy host results as well as hydrated states, preserving action/error/phase. */
  history?: Array<SkillMutationResult | SkillReviewState>;
  onApprove?: SkillLearningCardProps['onApprove'];
  onReject?: SkillLearningCardProps['onReject'];
  onRollback?: SkillLearningCardProps['onRollback'];
  onRetry?: SkillLearningCardProps['onRetry'];
  onRetryState?: SkillLearningCardProps['onRetryState'];
  /** State-bound controller actions; ids alone do not identify a source session. */
  onReviewAction?: (state: SkillReviewState, action: 'approve' | 'reject' | 'rollback') => Promise<SkillMutationResult>;
}

const inputClass = 'min-h-11 min-w-0 w-full rounded-md border border-border bg-panel px-2.5 py-2 text-xs text-fg outline-none focus:border-accent';
const actionClass = 'min-h-11 rounded-md border border-border bg-panel px-3 py-1.5 text-xs text-fg-dim outline-none hover:border-accent hover:text-fg focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50';

const reviewOptionAvailable = (option: SkillLearningModelOption) => !option.unavailableReason
  && (option.transport === 'anthropic' || option.transport === 'openai-compatible');

type NumericConfigKey = 'activityThreshold' | 'cooldownMs' | 'maxRounds' | 'maxInputTokens' | 'maxOutputTokens' | 'timeoutMs' | 'staleAfterDays' | 'archiveAfterDays';
const numericFields: Array<{ key: NumericConfigKey; label: [string, string]; min: number; max: number }> = [
  { key: 'activityThreshold', label: ['已完成工具活动阈值', 'Completed tool activity threshold'], min: 1, max: 1000 },
  { key: 'cooldownMs', label: ['冷却时间（毫秒）', 'Cooldown (ms)'], min: 0, max: 86400000 },
  { key: 'maxRounds', label: ['最大复盘轮数', 'Maximum review rounds'], min: 1, max: 16 },
  { key: 'maxInputTokens', label: ['累计输入上限（tokens）', 'Aggregate input limit (tokens)'], min: 1000, max: 1000000 },
  { key: 'maxOutputTokens', label: ['累计输出上限（tokens）', 'Aggregate output limit (tokens)'], min: 100, max: 100000 },
  { key: 'timeoutMs', label: ['总超时（毫秒）', 'Total timeout (ms)'], min: 1000, max: 600000 },
  { key: 'staleAfterDays', label: ['闲置提醒（天）', 'Stale hint (days)'], min: 1, max: 3650 },
  { key: 'archiveAfterDays', label: ['归档阈值（天）', 'Archive threshold (days)'], min: 1, max: 3650 },
];

/** Controlled configuration surface; its owner chooses global or project persistence. */
export default function SkillLearningSettings({ config, onChange, locale = 'zh-CN', capability, modelOptions = [], entries = [], lifecycleScopeKey, lifecycleForegroundBusy, lifecycleProtection, onPolicyChange, onArchive, onRestore, history = [], onApprove, onReject, onRollback, onRetry, onRetryState, onReviewAction }: SkillLearningSettingsProps) {
  const zh = locale === 'zh-CN';
  const latest = useRef({ entries, config, lifecycleForegroundBusy, lifecycleProtection });
  latest.current = { entries, config, lifecycleForegroundBusy, lifecycleProtection };
  const [advice, setAdvice] = useState<SkillLifecycleAdvice[]>([]);
  const [adviceError, setAdviceError] = useState('');
  useEffect(() => {
    setAdvice([]);
    setAdviceError('');
    if (!lifecycleScopeKey) return;
    return startSkillLifecycleAdvisory({ scopeKey: lifecycleScopeKey,
      getEntries: () => latest.current.entries, getConfig: () => latest.current.config,
      isForegroundBusy: () => latest.current.lifecycleForegroundBusy === true,
      getProtection: entry => latest.current.lifecycleProtection?.(entry) ?? {},
      onResult: setAdvice, onError: error => setAdviceError(String(error)),
    });
  }, [lifecycleScopeKey]);
  const selectedModel = modelOptions.find((option) =>
    option.selection.adapter === config.reviewSelection?.adapter
    && option.selection.modelClass === config.reviewSelection?.modelClass
    && option.selection.providerId === config.reviewSelection?.providerId
    && option.selection.channelId === config.reviewSelection?.channelId
    && option.selection.model === config.reviewSelection?.model)?.id;
  return (
    <section className="ugs-skill-learning-settings min-w-0 space-y-3 rounded-lg border border-border bg-panel p-3">
      <h3 className="text-sm font-semibold text-fg">{zh ? '自动学习技能' : 'Automatic skill learning'}</h3>
      <p className="text-xs leading-relaxed text-fg-dim">
        {zh ? '任务结束后复盘真实证据，优先修补已有技能。活动阈值使用已完成工具活动，不是 Hermes iteration。'
          : 'Review real evidence after a task, repairing existing skills first. The threshold counts completed tool activity, not Hermes iterations.'}
      </p>
      <p data-background-write-mode={getBackgroundSkillWriteMode(config)} className="text-xs leading-relaxed text-fg-dim">
        {zh ? '后台自动送审，不自动保存。相同一般规则需在不同任务中连续两次出现，且相似度至少 0.95；首次仅记录候选。下方写入模式保留显式命令的偏好，不放宽后台审批。'
          : 'Background reviews submit for approval, never auto-save. The same general rule must recur in two consecutive distinct tasks with similarity at least 0.95; the first observation records a candidate only. Write mode retains explicit-command preferences, not background write authority.'}
      </p>
      {capability && !capability.available && (
        <p role="status" className="rounded-md border border-status-warning/40 bg-status-warning/5 p-2 text-xs text-fg">
          {zh ? '当前通道不支持安全学习' : 'The current channel does not support safe learning'}
          {capability.reason && <>：{capability.reason}</>}
        </p>
      )}
      <label className="flex min-h-11 items-center gap-2 text-xs text-fg">
        <input type="checkbox" aria-label={zh ? '启用自动学习' : 'Enable automatic learning'}
          checked={config.enabled} className="h-4 w-4 accent-accent"
          onChange={(event) => onChange(normalizeSkillLearningConfig({ ...config, enabled: event.currentTarget.checked }))} />
        {zh ? '启用自动学习' : 'Enable automatic learning'}
      </label>
      <p className="text-xs leading-relaxed text-fg-dim">
        {zh ? '关闭不删除历史，仍可查看 diff、审批和撤销。通道不安全时不会降级到 full CLI。'
          : 'Turning learning off keeps history, diffs, approvals and rollback available. Unsafe channels never fall back to a full-permission CLI.'}
      </p>
      <label className="block space-y-1 text-xs text-fg-dim">
        <span>{zh ? '写入模式' : 'Write mode'}</span>
        <select
          aria-label={zh ? '写入模式' : 'Write mode'}
          className={inputClass}
          value={config.mode}
          onChange={(event) => onChange(normalizeSkillLearningConfig({ ...config, mode: event.currentTarget.value }))}
        >
          <option value="auto-safe">{zh ? '显式命令低风险模式（后台仍送审）' : 'Explicit-command low-risk mode (background approval required)'}</option>
          <option value="approve-all">{zh ? '所有修改需批准' : 'Approve every change'}</option>
          <option value="off">{zh ? '关闭学习' : 'Off'}</option>
        </select>
      </label>
      <label className="block min-w-0 space-y-1 text-xs text-fg-dim">
        <span>{zh ? '复盘模型' : 'Review model'}</span>
        <select aria-label={zh ? '复盘模型' : 'Review model'} className={inputClass}
          title={modelOptions.find((option) => option.id === selectedModel)?.label ?? (config.reviewSelection
            ? `${config.reviewSelection.adapter} · ${config.reviewSelection.model ?? config.reviewSelection.modelClass}`
            : zh ? '沿用来源会话模型（仍需安全核验）' : 'Use source-session model (still safety-gated)')}
          value={selectedModel ?? (config.reviewSelection ? '__current__' : '')}
          onChange={(event) => {
            const option = modelOptions.find((candidate) => candidate.id === event.currentTarget.value);
            if (option && !reviewOptionAvailable(option)) return;
            if (event.currentTarget.value && !option) return;
            onChange(normalizeSkillLearningConfig({ ...config, reviewSelection: option?.selection }));
          }}>
          <option value="">{zh ? '沿用来源会话模型（仍需安全核验）' : 'Use source-session model (still safety-gated)'}</option>
          {!selectedModel && config.reviewSelection && <option value="__current__">{config.reviewSelection.adapter} · {config.reviewSelection.model ?? config.reviewSelection.modelClass}</option>}
          {modelOptions.map((option) => <option key={option.id} value={option.id}
            disabled={!reviewOptionAvailable(option)}>
            {option.label}{!reviewOptionAvailable(option) ? ` (${option.unavailableReason || (zh ? '仅支持 completion HTTP' : 'completion HTTP only')})` : ''}
          </option>)}
        </select>
      </label>
      <p className="text-xs leading-relaxed text-fg-dim">
        {zh ? '复盘模型可独立选择，不改变主会话模型；这里只保存模型和通道标识，不保存凭据。'
          : 'The review model is independent of the main conversation. Only model and channel identifiers are stored here, never credentials.'}
      </p>
      <label className="block min-w-0 space-y-1 text-xs text-fg-dim">
        <span>{zh ? '复盘 HTTP 协议' : 'Review HTTP protocol'}</span>
        <select aria-label={zh ? '复盘 HTTP 协议' : 'Review HTTP protocol'} className={inputClass}
          value={config.reviewTransport ?? ''}
          onChange={(event) => onChange(normalizeSkillLearningConfig({ ...config, reviewTransport: event.currentTarget.value || undefined }))}>
          <option value="">{zh ? '自动匹配来源渠道的 API 协议' : 'Use configured HTTP channel'}</option>
          <option value="anthropic">Anthropic Messages</option>
          <option value="openai-compatible">OpenAI-compatible Chat Completions</option>
        </select>
      </label>
      <p className="text-xs leading-relaxed text-fg-dim">
        {zh ? '复盘沿用明确选定的供应商、模型和 API 地址，独立发送文本请求；主会话仍走原 CLI。特殊接口可手动指定协议。系统默认 CLI 需另选复盘模型。'
          : 'An explicit protocol sends review-only HTTP requests to the selected channel’s existing API endpoint; it does not change source-session CLI execution. A specific provider, channel and model are required; system CLI and simulator routes are never used.'}
      </p>
      <p className="text-xs leading-relaxed text-fg-dim">
        {zh ? '以下为每次复盘的累计预算，包含所有模型调用；小模型不保证更便宜，用量未知不会记为零。'
          : 'These aggregate budgets cover every model call in one review. Smaller models are not guaranteed cheaper; unknown usage is not zero.'}
      </p>
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        {numericFields.map((field) => (
          <label key={field.key} className="block min-w-0 space-y-1 text-xs text-fg-dim">
            <span>{field.label[zh ? 0 : 1]}</span>
            <input type="number" inputMode="numeric" aria-label={field.label[zh ? 0 : 1]}
              className={inputClass} min={field.min} max={field.max} step={1} value={config[field.key]}
              onChange={(event) => {
                const value = event.currentTarget.valueAsNumber;
                if (Number.isFinite(value)) onChange(normalizeSkillLearningConfig({ ...config, [field.key]: value }));
              }} />
          </label>
        ))}
      </div>
      <label className="flex min-h-11 items-center gap-2 text-xs text-fg">
        <input type="checkbox" aria-label={zh ? '自动归档' : 'Automatic archiving'} checked={config.autoArchive}
          className="h-4 w-4 accent-accent" onChange={(event) => onChange(normalizeSkillLearningConfig({ ...config, autoArchive: event.currentTarget.checked }))} />
        {zh ? '启用自动归档建议（仅建议）' : 'Enable automatic archive recommendations (suggestions only)'}
      </label>
      <p className="text-xs leading-relaxed text-fg-dim">
        {zh ? '当前仅生成归档建议，不会自动移动技能包。手动归档保留整个技能包，可恢复，不会永久删除；固定技能不参与自动归档建议。'
          : 'Currently recommends archiving only; no skill packages are moved automatically. Manual archiving preserves the whole package and can be undone; it never permanently deletes skills. Pinned skills are excluded from automatic archive recommendations.'}
      </p>
      <div className="min-w-0 space-y-2 border-t border-border pt-3">
        <h4 className="text-xs font-semibold text-fg">{zh ? '空闲维护建议' : 'Idle maintenance advice'}</h4>
        <p className="text-xs leading-relaxed text-fg-dim">{zh ? '设置页连续空闲 2 分钟后检查已加载目录，每小时最多一次；不调用模型，不移动或删除文件。未使用不等于无价值。' : 'Checks the loaded catalog after two minutes of UI idle, at most once per hour. No model calls, file moves or deletion. Lack of use is not lack of value.'}</p>
        {!lifecycleScopeKey && <p className="text-xs text-fg-dim">{zh ? '等待来源作用域，尚未评估。' : 'Waiting for source scope; not evaluated.'}</p>}
        {adviceError && <p role="alert" className="text-xs text-fg">{zh ? '维护建议读取失败，未覆盖观测记录：' : 'Advice unavailable; observation records unchanged: '}{adviceError}</p>}
        <ul className="space-y-2 text-xs text-fg-dim">{advice.filter(item => entries.some(entry => entry.skillId === item.entry.skillId && entry.rootId === item.entry.rootId && entry.revision === item.entry.revision)).map(item => <li key={`${item.entry.rootId}:${item.entry.skillId}`} data-lifecycle-skill-id={item.entry.skillId} className="break-words [overflow-wrap:anywhere]">
          <span className="font-medium text-fg">{item.entry.name}</span> · {item.reason === 'first-observation' ? (zh ? '首次观测，开始计时' : 'First observation; aging starts now') : item.state === 'stale' ? (zh ? '闲置提醒，仅建议查看' : 'Idle hint; consider reviewing') : item.state === 'archived' ? (zh ? '已归档，可手动恢复' : 'Archived; manual restore available') : (zh ? '观测中' : 'Observing')}
          {' · '}{item.usedWithEvidence ? (zh ? '有任务采用验证' : 'Task adoption verified') : (zh ? '尚无任务采用验证' : 'No verified task adoption')}
          {item.shouldArchive && <> · {zh ? '可考虑手动归档（未执行）' : 'Consider manual archiving (not executed)'}</>}
          <span className="block font-mono">{item.entry.scope} · {item.entry.source} · {item.entry.revision}</span>
        </li>)}</ul>
      </div>
      <div className="min-w-0 space-y-2 border-t border-border pt-3">
        <h4 className="text-xs font-semibold text-fg">{zh ? '技能自动编辑授权' : 'Skill editing authorization'}</h4>
        <p className="text-xs leading-relaxed text-fg-dim">
          {zh ? '固定只防止自动归档，不禁止内容修补；锁定内容才禁止自动编辑。外部库只读，导入副本需明确授权。'
            : 'Pinning protects against automatic archiving, not content repairs. The content lock prevents automatic editing. External roots are read-only; imported copies require explicit authorization.'}
        </p>
        {entries.map((entry) => <SkillPolicyRow key={entry.skillId} entry={entry} zh={zh} onPolicyChange={onPolicyChange} onArchive={onArchive} onRestore={onRestore} />)}
        {entries.length === 0 && <p className="text-xs text-fg-dim">{zh ? '暂无技能目录数据' : 'No skill catalog data'}</p>}
      </div>
      <div className="min-w-0 space-y-2 border-t border-border pt-3">
        <h4 className="text-xs font-semibold text-fg">{zh ? '学习历史与审批' : 'Learning history and approvals'}</h4>
        {history.map((record) => {
          const state: SkillReviewState = 'batchId' in record
            ? { status: record.status, origin: record.origin, result: record }
            : record;
          const origin = state.origin;
          return <SkillLearningCard key={JSON.stringify([origin.hostId, origin.workspaceId, origin.sessionId, origin.turnId, origin.runId, state.result?.batchId])}
            state={state} surface="history" locale={locale}
            onApprove={onReviewAction ? () => onReviewAction(state, 'approve') : onApprove}
            onReject={onReviewAction ? () => onReviewAction(state, 'reject') : onReject}
            onRollback={onReviewAction ? () => onReviewAction(state, 'rollback') : onRollback}
            onRetry={onRetry} onRetryState={onRetryState} />;
        })}
        {history.length === 0 && <p className="text-xs text-fg-dim">{zh ? '暂无学习记录' : 'No learning records'}</p>}
      </div>
    </section>
  );
}

function SkillPolicyRow({ entry, zh, onPolicyChange, onArchive, onRestore }: {
  entry: SkillEntry;
  zh: boolean;
  onPolicyChange: SkillLearningSettingsProps['onPolicyChange'];
  onArchive: SkillLearningSettingsProps['onArchive'];
  onRestore: SkillLearningSettingsProps['onRestore'];
}) {
  const [resolved, setResolved] = useState<SkillEntry>();
  const [busy, setBusy] = useState<'policy' | 'archive' | 'restore' | null>(null);
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const generation = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    generation.current += 1;
    setResolved(undefined);
    setError('');
  }, [entry]);
  const current = resolved ?? entry;
  const mutate = async (action: 'policy' | 'archive' | 'restore', request: () => Promise<SkillEntry>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(action);
    setError('');
    const startedGeneration = generation.current;
    try {
      const next = await request();
      if (!mounted.current || generation.current !== startedGeneration) return;
      if (next.skillId !== current.skillId || next.rootId !== current.rootId || next.scope !== current.scope) {
        throw new Error(zh ? '技能来源不匹配，未更新授权' : 'Skill identity mismatch; authorization was not updated');
      }
      setResolved(next);
    } catch (cause) {
      if (mounted.current && generation.current === startedGeneration) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(null);
    }
  };
  return (
    <section data-skill-id={current.skillId} className="min-w-0 space-y-2 rounded-md border border-border p-2">
      <p className="break-words text-xs font-medium text-fg">{current.name}</p>
      <p className="break-words text-[11px] text-fg-dim">{current.description}</p>
      <p className="break-words text-[11px] text-fg-dim">
        {current.scope === 'project' ? (zh ? '项目' : 'Project') : current.scope === 'global' ? (zh ? '全局' : 'Global') : (zh ? '外部只读' : 'External; read-only')}
        {' · '}{current.source}
      </p>
      <p className="break-all font-mono text-[10px] text-fg-dim">{current.revision}</p>
      <p role="status" className="text-[11px] text-fg-dim">
        {busy === 'archive' ? (zh ? '正在归档' : 'Archiving')
          : busy === 'restore' ? (zh ? '正在恢复技能' : 'Restoring skill')
          : busy === 'policy' ? (zh ? '正在更新授权' : 'Updating authorization')
          : current.state === 'archived' ? (zh ? '已归档' : 'Archived')
          : current.state === 'stale' ? (zh ? '闲置待复核' : 'Stale; review suggested') : (zh ? '活跃' : 'Active')}
      </p>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {(['pinned', 'contentLocked', 'autoEditable'] as const).map((key) => {
          const label = key === 'pinned' ? (zh ? '固定技能' : 'Pin skill')
            : key === 'contentLocked' ? (zh ? '锁定内容' : 'Lock content') : (zh ? '允许自动编辑' : 'Allow automatic editing');
          return <label key={key} className="flex min-h-11 items-center gap-2 text-xs text-fg-dim">
            <input type="checkbox" aria-label={`${label} ${current.name}`} checked={current[key]}
              className="h-4 w-4 accent-accent" disabled={!onPolicyChange || busy !== null || current.readOnly || current.scope === 'external' || (key === 'autoEditable' && current.contentLocked)}
              onChange={(event) => {
                const value = event.currentTarget.checked;
                if (onPolicyChange) void mutate('policy', () => onPolicyChange(current.skillId, { [key]: value }));
              }} />
            {label}
          </label>;
        })}
      </div>
      {current.state !== 'archived' && onArchive && <button type="button" aria-label={`${zh ? '归档技能' : 'Archive skill'} ${current.name}`}
        className={actionClass} disabled={busy !== null || current.readOnly || current.scope === 'external'}
        onClick={() => void mutate('archive', () => onArchive(current.skillId))}>
        {zh ? '归档技能' : 'Archive skill'}
      </button>}
      {current.state === 'archived' && onRestore && <button type="button" aria-label={`${zh ? '恢复技能' : 'Restore skill'} ${current.name}`}
        className={actionClass} disabled={busy !== null || current.readOnly || current.scope === 'external'}
        onClick={() => void mutate('restore', () => onRestore(current.skillId))}>
        {zh ? '恢复技能' : 'Restore skill'}
      </button>}
      {error && <p role="alert" className="break-words text-xs text-status-error">{error}</p>}
    </section>
  );
}
