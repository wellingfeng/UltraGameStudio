import { useMemo, useState } from 'react';
import { Save, Trash2, X } from 'lucide-react';
import type {
  ScheduledTaskConfig,
  ScheduledTaskWeekday,
} from '@/store/types';
import { DEFAULT_LOCALE, LANGUAGE_SELECT_OPTIONS, localizeSelectOption, t, type Locale } from '@/lib/i18n';
import { nextScheduledTaskRun, parseCron, systemTimeZone, validTimeZone } from '@/lib/scheduledTasks';
import { scheduleText } from '@/lib/scheduledTaskI18n';
import './ScheduledTasksPanel.css';

interface ScheduledTaskDialogProps {
  locale: Locale;
  title: string;
  initialTask?: ScheduledTaskConfig;
  onSave: (task: ScheduledTaskConfig) => Promise<void> | void;
  onDelete: () => Promise<void> | void;
  onClose: () => void;
  canDelete?: boolean;
}

const WEEKDAY_ORDER: ScheduledTaskWeekday[] = [1, 2, 3, 4, 5, 6, 0];

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function defaultTask(title: string): ScheduledTaskConfig {
  const now = new Date();
  return {
    enabled: true,
    reminderText: title,
    hour: now.getHours(),
    minute: now.getMinutes(),
    second: 0,
    weekdays: WEEKDAY_ORDER,
    repeat: true,
    remindOnRun: true,
    updatedAt: Date.now(),
  };
}

function weekdayLabel(locale: Locale, weekday: ScheduledTaskWeekday): string {
  if (locale !== 'zh-CN' && locale !== 'en-US') return new Intl.DateTimeFormat(locale, { weekday: 'narrow' }).format(new Date(2023, 0, 1 + weekday));
  if (weekday === 1) return t(locale, 'schedule.weekdayMon');
  if (weekday === 2) return t(locale, 'schedule.weekdayTue');
  if (weekday === 3) return t(locale, 'schedule.weekdayWed');
  if (weekday === 4) return t(locale, 'schedule.weekdayThu');
  if (weekday === 5) return t(locale, 'schedule.weekdayFri');
  if (weekday === 6) return t(locale, 'schedule.weekdaySat');
  return t(locale, 'schedule.weekdaySun');
}

export default function ScheduledTaskDialog({
  locale,
  title,
  initialTask,
  onSave,
  onDelete,
  onClose,
  canDelete = Boolean(initialTask),
}: ScheduledTaskDialogProps) {
  const seed = useMemo(
    () => initialTask ?? defaultTask(title),
    [initialTask, title],
  );
  const [enabled, setEnabled] = useState(seed.enabled);
  const [name, setName] = useState(seed.name ?? title);
  const [kind, setKind] = useState<'weekly' | 'cron' | 'once'>(seed.onceAt !== undefined ? 'once' : seed.cronExpression ? 'cron' : 'weekly');
  const [cronExpression, setCronExpression] = useState(seed.cronExpression ?? '0 9 * * *');
  const [timeZone, setTimeZone] = useState(seed.timeZone ?? systemTimeZone());
  const [promptLocale, setPromptLocale] = useState(seed.promptLocale ?? DEFAULT_LOCALE);
  const [onceDate, setOnceDate] = useState(() => {
    const date = new Date(seed.onceAt ?? Date.now() + 3600000);
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  });
  const [reminderText, setReminderText] = useState(seed.reminderText);
  const [hour, setHour] = useState(seed.hour);
  const [minute, setMinute] = useState(seed.minute);
  const [second, setSecond] = useState(seed.second);
  const [weekdays, setWeekdays] = useState<ScheduledTaskWeekday[]>(
    seed.weekdays,
  );
  const [repeat, setRepeat] = useState(seed.repeat);
  const [remindOnRun, setRemindOnRun] = useState(seed.remindOnRun);
  const [limitHistory, setLimitHistory] = useState(seed.maxHistoryRuns !== undefined);
  const [historyRuns, setHistoryRuns] = useState(String(seed.maxHistoryRuns ?? 1));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const preview = useMemo(() => {
    try {
      if (!validTimeZone(timeZone)) return null;
      return nextScheduledTaskRun({ ...seed, enabled: true, hour, minute, second, weekdays, cronExpression: kind === 'cron' ? cronExpression : undefined, onceAt: kind === 'once' ? new Date(onceDate).getTime() : undefined, timeZone });
    } catch { return null; }
  }, [seed, hour, minute, second, weekdays, cronExpression, onceDate, timeZone, kind]);

  const toggleWeekday = (weekday: ScheduledTaskWeekday) => {
    setWeekdays((current) =>
      current.includes(weekday)
        ? current.filter((item) => item !== weekday)
        : WEEKDAY_ORDER.filter((item) => [...current, weekday].includes(item)),
    );
    setError(null);
  };

  const save = async () => {
    const text = reminderText.trim();
    if (!name.trim()) { setError(scheduleText(locale, 'requiredName')); return; }
    if (!text) {
      setError(scheduleText(locale, 'requiredPrompt'));
      return;
    }
    if (kind === 'weekly' && weekdays.length === 0) {
      setError(scheduleText(locale, 'requiredWeekday'));
      return;
    }
    if (!validTimeZone(timeZone)) { setError(scheduleText(locale, 'invalidZone')); return; }
    if (kind === 'cron') {
      try { parseCron(cronExpression); }
      catch { setError(scheduleText(locale, 'invalidCron')); return; }
    }
    if (kind === 'once' && (!Number.isFinite(new Date(onceDate).getTime()) || new Date(onceDate).getTime() <= Date.now())) { setError(scheduleText(locale, 'invalidDate')); return; }
    if (limitHistory && (!Number.isSafeInteger(Number(historyRuns)) || Number(historyRuns) < 1)) { setError(scheduleText(locale, 'invalidHistoryRuns')); return; }
    if (enabled && !preview) { setError(scheduleText(locale, 'noNext')); return; }

    setSaving(true);
    setError(null);
    try {
      await onSave({
        name: name.trim(),
        templateId: seed.templateId,
        cronExpression: kind === 'cron' ? cronExpression.trim() : undefined,
        onceAt: kind === 'once' ? new Date(onceDate).getTime() : undefined,
        timeZone: kind === 'once' ? systemTimeZone() : timeZone.trim(),
        promptLocale,
        ...(limitHistory ? { maxHistoryRuns: Number(historyRuns) } : {}),
        enabled,
        reminderText: text,
        hour: clampInt(hour, 0, 23),
        minute: clampInt(minute, 0, 59),
        second: clampInt(second, 0, 59),
        weekdays: weekdays.length ? weekdays : WEEKDAY_ORDER,
        repeat: kind === 'once' ? false : repeat,
        remindOnRun,
        updatedAt: Date.now(),
        ...(seed.lastRunAt ? { lastRunAt: seed.lastRunAt } : {}),
      });
      onClose();
    } catch {
      setError(scheduleText(locale, 'saveError'));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setSaving(true);
    setError(null);
    try {
      await onDelete();
      onClose();
    } catch {
      setError(scheduleText(locale, 'saveError'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4">
      <button
        type="button"
        aria-label={t(locale, 'common.close')}
        className="absolute inset-0 cursor-default"
        onClick={onClose}
      />
      <section role="dialog" aria-modal="true" aria-label={scheduleText(locale, 'edit')} className="scheduled-task-editor relative flex max-h-[90vh] w-full max-w-xl flex-col overflow-hidden rounded-lg border border-border bg-panel shadow-2xl">
        <header className="flex items-center gap-3 border-b border-border-soft px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-semibold text-fg">
              {locale === 'zh-CN' || locale === 'en-US' ? t(locale, 'schedule.title') : scheduleText(locale, 'title')}
            </h2>
            <p className="truncate text-xs text-fg-faint">{title}</p>
          </div>
          <button
            type="button"
            aria-label={t(locale, 'common.close')}
            onClick={onClose}
            className="rounded p-1.5 text-fg-faint transition-colors hover:bg-border-soft hover:text-fg"
          >
            <X size={16} />
          </button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
          <label className="flex flex-col gap-1.5 text-sm text-fg-dim">
            {scheduleText(locale, 'name')}
            <input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} className="rounded-md border border-border bg-bg px-3 py-2 text-fg outline-none focus:border-accent" />
          </label>
          <label className="flex items-center justify-between gap-3 rounded-md border border-border-soft px-3 py-2">
            <span className="text-sm text-fg">{scheduleText(locale, 'enabled')}</span>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="h-4 w-4 accent-accent"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm text-fg-dim">
              {scheduleText(locale, 'prompt')}
            </span>
            <textarea
              value={reminderText}
              onChange={(e) => {
                setReminderText(e.target.value);
                setError(null);
              }}
              rows={4}
              maxLength={12000}
              placeholder={scheduleText(locale, 'prompt')}
              className="resize-none rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg outline-none transition-colors placeholder:text-fg-faint focus:border-accent"
            />
          </label>

          <label className="flex flex-col gap-1.5 text-sm text-fg-dim">
            {scheduleText(locale, 'kind')}
            <select aria-label={scheduleText(locale, 'kind')} value={kind} onChange={(e) => { setKind(e.target.value as typeof kind); setError(null); }} className="rounded-md border border-border bg-bg px-3 py-2 text-fg">
              {(['weekly', 'once', 'cron'] as const).map((value) => <option key={value} value={value}>{scheduleText(locale, value)}</option>)}
            </select>
          </label>
          {kind === 'cron' && <label className="flex flex-col gap-1.5 text-sm text-fg-dim">
            {scheduleText(locale, 'cron')}
            <input aria-label={scheduleText(locale, 'cron')} value={cronExpression} onChange={(e) => { setCronExpression(e.target.value); setError(null); }} dir="ltr" className="rounded-md border border-border bg-bg px-3 py-2 font-mono text-fg outline-none focus:border-accent" />
            <span className="text-xs text-fg-faint">{scheduleText(locale, 'cronHint')}</span>
          </label>}
          {kind === 'once' && <label className="flex flex-col gap-1.5 text-sm text-fg-dim">
            {scheduleText(locale, 'once')} · {systemTimeZone()}
            <input type="datetime-local" value={onceDate} onChange={(e) => { setOnceDate(e.target.value); setError(null); }} className="rounded-md border border-border bg-bg px-3 py-2 text-fg" />
          </label>}
          {kind === 'weekly' && <>
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm text-fg-dim">
              {scheduleText(locale, 'time')}
            </legend>
            <div className="grid grid-cols-3 gap-2">
              <NumberField
                label={scheduleText(locale, 'hour')}
                max={23}
                value={hour}
                onChange={setHour}
              />
              <NumberField
                label={scheduleText(locale, 'minute')}
                max={59}
                value={minute}
                onChange={setMinute}
              />
              <NumberField
                label={scheduleText(locale, 'second')}
                max={59}
                value={second}
                onChange={setSecond}
              />
            </div>
          </fieldset>

          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm text-fg-dim">
              {scheduleText(locale, 'weekdays')}
            </legend>
            <div className="grid grid-cols-7 gap-1.5">
              {WEEKDAY_ORDER.map((weekday) => {
                const selected = weekdays.includes(weekday);
                return (
                  <button
                    key={weekday}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => toggleWeekday(weekday)}
                    className={
                      'rounded-md border px-0 py-2 text-xs transition-colors ' +
                      (selected
                        ? 'border-accent bg-accent/20 text-accent'
                        : 'border-border bg-bg text-fg-faint hover:border-accent/70 hover:text-fg')
                    }
                  >
                    {weekdayLabel(locale, weekday)}
                  </button>
                );
              })}
            </div>
          </fieldset>
          </>}

          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1.5 text-sm text-fg-dim">
              {scheduleText(locale, 'timeZone')}
              <input value={timeZone} disabled={kind === 'once'} list="scheduled-task-zones" onChange={(e) => { setTimeZone(e.target.value); setError(null); }} className="min-w-0 rounded-md border border-border bg-bg px-2 py-2 text-xs text-fg" />
              <datalist id="scheduled-task-zones">{[systemTimeZone(), 'Asia/Shanghai', 'UTC', 'Asia/Tokyo', 'America/New_York', 'Europe/London'].filter((zone, index, list) => list.indexOf(zone) === index).map((zone) => <option key={zone} value={zone} />)}</datalist>
            </label>
            <label className="flex flex-col gap-1.5 text-sm text-fg-dim">
              {scheduleText(locale, 'outputLanguage')}
              <select value={promptLocale} onChange={(e) => setPromptLocale(e.target.value as Locale)} className="min-w-0 rounded-md border border-border bg-bg px-2 py-2 text-xs text-fg">
                {LANGUAGE_SELECT_OPTIONS.map((option) => <option key={option.id} value={option.id}>{localizeSelectOption(option, locale).label}</option>)}
              </select>
            </label>
          </div>
          <p className="rounded-md border border-accent/30 bg-accent/10 px-3 py-2 text-xs text-fg-dim">
            {scheduleText(locale, 'next')}：{preview ? preview.toLocaleString(locale, { timeZone: kind === 'once' ? systemTimeZone() : timeZone }) : '—'}
          </p>

          {kind !== 'once' && <label className="flex items-center justify-between gap-3 rounded-md border border-border-soft px-3 py-2">
            <span className="text-sm text-fg">{scheduleText(locale, 'repeat')}</span>
            <input
              type="checkbox"
              checked={repeat}
              onChange={(e) => setRepeat(e.target.checked)}
              className="h-4 w-4 accent-accent"
            />
          </label>}

          <label className="flex items-center justify-between gap-3 rounded-md border border-border-soft px-3 py-2">
            <span className="text-sm text-fg">
              {scheduleText(locale, 'reminder')}
            </span>
            <input
              type="checkbox"
              checked={remindOnRun}
              onChange={(e) => setRemindOnRun(e.target.checked)}
              className="h-4 w-4 accent-accent"
            />
          </label>

          <div className="flex flex-col gap-2 rounded-md border border-border-soft px-3 py-2">
            <label className="flex items-center justify-between gap-3">
              <span className="text-sm text-fg">{scheduleText(locale, 'limitHistory')}</span>
              <input type="checkbox" checked={limitHistory} onChange={(event) => { setLimitHistory(event.target.checked); setError(null); }} className="h-4 w-4 accent-accent" />
            </label>
            {limitHistory && <>
              <label className="flex items-center justify-between gap-3 text-sm text-fg-dim">
                {scheduleText(locale, 'historyRuns')}
                <input type="number" min={1} step={1} value={historyRuns} onChange={(event) => { setHistoryRuns(event.target.value); setError(null); }} className="w-24 rounded-md border border-border bg-bg px-2 py-1 text-fg" />
              </label>
              <p className="text-xs text-fg-faint">{scheduleText(locale, 'historyHint')}</p>
            </>}
          </div>

          {error && <p className="text-sm text-status-error">{error}</p>}
        </div>

        <footer className="flex items-center justify-between gap-2 border-t border-border-soft px-4 py-3">
          <button
            type="button"
            disabled={!canDelete || saving}
            onClick={remove}
            className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm text-fg-dim transition-colors hover:border-status-error/70 hover:text-status-error disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Trash2 size={14} />
            <span>{scheduleText(locale, 'delete')}</span>
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={saving}
              onClick={onClose}
              className="rounded-md border border-border px-3 py-2 text-sm text-fg-dim transition-colors hover:border-accent hover:text-accent disabled:cursor-wait disabled:opacity-60"
            >
              {t(locale, 'common.cancel')}
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => void save()}
            className="scheduled-task-primary disabled:cursor-wait disabled:opacity-60"
            >
              <Save size={14} />
              <span>{t(locale, 'common.save')}</span>
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}

function NumberField({
  label,
  max,
  value,
  onChange,
}: {
  label: string;
  max: number;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-fg-faint">{label}</span>
      <input
        type="number"
        min={0}
        max={max}
        step={1}
        value={value}
        onChange={(e) => onChange(clampInt(Number(e.target.value), 0, max))}
        className="rounded-md border border-border bg-bg px-2 py-2 text-center font-mono text-sm text-fg outline-none transition-colors focus:border-accent"
      />
    </label>
  );
}
