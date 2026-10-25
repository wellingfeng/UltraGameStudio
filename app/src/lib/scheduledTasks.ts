import type { ScheduledTaskConfig, ScheduledTaskWeekday } from '@/store/types';

type CronField = { values: Set<number>; wildcard: boolean };
export type ParsedCron = [CronField, CronField, CronField, CronField, CronField];
const cronCache = new Map<string, ParsedCron>();
const formatterCache = new Map<string, Intl.DateTimeFormat>();

/** Standard five-field cron, including lists, ranges, steps and weekday/month names. */
export function parseCron(expression: string): ParsedCron {
  const normalized = expression.trim().toUpperCase().replace(/\s+/g, ' ');
  const cached = cronCache.get(normalized);
  if (cached) return cached;
  const fields = normalized.split(' ');
  if (fields.length !== 5) throw new Error('cron.fields');
  const bounds = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
  const names = [[], [], [], ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'], ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']];
  const result = fields.map((field, index): CronField => {
    const [min, max] = bounds[index];
    const number = (value: string) => {
      const named = names[index].indexOf(value);
      const n = named >= 0 ? named + min : /^\d+$/.test(value) ? Number(value) : NaN;
      if (!Number.isInteger(n) || n < min || n > max) throw new Error('cron.range');
      return n;
    };
    const values = new Set<number>();
    for (const term of field.split(',')) {
      const segments = term.split('/');
      if (segments.length > 2) throw new Error('cron.step');
      const [range, stepText] = segments;
      const step = stepText === undefined ? 1 : /^\d+$/.test(stepText) ? Number(stepText) : NaN;
      if (!Number.isInteger(step) || step < 1 || step > max - min + 1) throw new Error('cron.step');
      let start: number;
      let end: number;
      if (range === '*') { start = min; end = max; }
      else {
        const pair = range.split('-');
        if (pair.length > 2) throw new Error('cron.range');
        start = number(pair[0]);
        end = pair.length === 2 ? number(pair[1]) : stepText !== undefined ? max : start;
      }
      if (end < start) throw new Error('cron.range');
      for (let n = start; n <= end; n += step) values.add(index === 4 && n === 7 ? 0 : n);
    }
    return { values, wildcard: field.startsWith('*') };
  }) as ParsedCron;
  if (cronCache.size >= 128) cronCache.clear();
  cronCache.set(normalized, result);
  return result;
}

export function validTimeZone(timeZone: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone }).format(); return true; }
  catch { return false; }
}

export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
}

function clockParts(date: Date, timeZone?: string) {
  if (!timeZone) return { minute: date.getMinutes(), hour: date.getHours(), day: date.getDate(), month: date.getMonth() + 1, weekday: date.getDay() };
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', minute: '2-digit', hour: '2-digit', day: '2-digit', month: '2-digit', weekday: 'short' });
    formatterCache.set(timeZone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return { minute: Number(parts.minute), hour: Number(parts.hour), day: Number(parts.day), month: Number(parts.month), weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday) };
}

function matchesDay(cron: ParsedCron, parts: ReturnType<typeof clockParts>): boolean {
  const dom = cron[2].values.has(parts.day);
  const dow = cron[4].values.has(parts.weekday);
  return cron[2].wildcard || cron[4].wildcard ? dom && dow : dom || dow;
}

export function cronMatches(expression: string, date: Date, timeZone?: string): boolean {
  const cron = parseCron(expression);
  const parts = clockParts(date, timeZone);
  return cron[0].values.has(parts.minute) && cron[1].values.has(parts.hour) && cron[3].values.has(parts.month) && matchesDay(cron, parts);
}

function matchesTask(task: ScheduledTaskConfig, date: Date): boolean {
  if (task.cronExpression) return cronMatches(task.cronExpression, date, task.timeZone);
  const parts = clockParts(date, task.timeZone);
  return task.weekdays.includes(parts.weekday as ScheduledTaskWeekday) && parts.hour === task.hour && parts.minute === task.minute;
}

/** Latest missed occurrence only: resume from sleep without replaying a backlog. */
export function scheduledTaskOccurrence(task: ScheduledTaskConfig, now: Date, since: number): number | null {
  if (!task.enabled) return null;
  const after = Math.max(since, task.lastRunAt ?? 0, task.updatedAt - 1);
  if (task.onceAt !== undefined) return task.onceAt > (task.lastRunAt ?? 0) && task.onceAt >= task.updatedAt && task.onceAt <= now.getTime() ? task.onceAt : null;
  const second = task.cronExpression ? 0 : task.second;
  let timestamp = Math.floor(now.getTime() / 60000) * 60000 + second * 1000;
  if (timestamp > now.getTime()) timestamp -= 60000;
  const lower = Math.max(after, now.getTime() - 24 * 60 * 60 * 1000);
  for (; timestamp > lower; timestamp -= 60000) {
    if (matchesTask(task, new Date(timestamp))) return timestamp;
  }
  return null;
}

export function nextScheduledTaskRun(task: ScheduledTaskConfig, after = new Date()): Date | null {
  if (!task.enabled) return null;
  const start = Math.max(after.getTime(), task.lastRunAt ?? 0);
  if (task.onceAt !== undefined) return task.onceAt > start ? new Date(task.onceAt) : null;
  const cron = task.cronExpression ? parseCron(task.cronExpression) : null;
  const second = cron ? 0 : task.second;
  let timestamp = Math.floor(start / 60000) * 60000 + second * 1000;
  if (timestamp <= start) timestamp += 60000;
  const limit = start + 5 * 366 * 24 * 60 * 60 * 1000;
  while (timestamp < limit) {
    const date = new Date(timestamp);
    const parts = clockParts(date, task.timeZone);
    if (cron ? cron[3].values.has(parts.month) && matchesDay(cron, parts) && cron[1].values.has(parts.hour) && cron[0].values.has(parts.minute) : matchesTask(task, date)) return date;
    // Skip the remainder of an hour only when its day/hour cannot match.
    const wrongHour = cron ? !cron[3].values.has(parts.month) || !matchesDay(cron, parts) || !cron[1].values.has(parts.hour) : !task.weekdays.includes(parts.weekday as ScheduledTaskWeekday) || parts.hour !== task.hour;
    timestamp += (wrongHour ? 60 - parts.minute : 1) * 60000;
  }
  return null;
}
