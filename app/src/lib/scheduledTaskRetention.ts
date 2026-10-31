import type { Message, ScheduledTaskConfig } from '@/store/types';

export function retainScheduledTaskMessages(messages: Message[], task: ScheduledTaskConfig): Message[] {
  const limit = task.maxHistoryRuns;
  if (!Number.isSafeInteger(limit) || !limit || limit < 1) return messages;

  const starts: number[] = [];
  const firstMarkedRun = messages.findIndex((message) => message.role === 'user' && message.scheduledTaskRun);
  const legacyMessages = firstMarkedRun < 0 ? messages : messages.slice(0, firstMarkedRun);
  const legacyCounts = new Map<string, number>();
  for (const message of legacyMessages) {
    const text = message.text.trim();
    if (message.role === 'user' && text) legacyCounts.set(text, (legacyCounts.get(text) ?? 0) + 1);
  }
  const prompt = task.reminderText.trim();
  const legacyStarts = legacyCounts.has(prompt)
    ? new Set([prompt])
    : new Set([...legacyCounts].filter(([, count]) => count > 1).map(([text]) => text));
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const legacy = firstMarkedRun < 0 || index < firstMarkedRun;
    if (message.role === 'user' && (message.scheduledTaskRun || (legacy && legacyStarts.has(message.text.trim())))) {
      starts.push(index);
    }
  }
  if (starts.length && starts[0] > 0) starts.unshift(0);
  return starts.length > limit ? messages.slice(starts[starts.length - limit]) : messages;
}
