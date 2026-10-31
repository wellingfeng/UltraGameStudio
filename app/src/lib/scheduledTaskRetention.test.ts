import { describe, expect, it } from 'vitest';
import { retainScheduledTaskMessages } from './scheduledTaskRetention';
import { SCHEDULED_TASK_TEMPLATES, taskFromTemplate } from './scheduledTaskTemplates';
import type { Message } from '@/store/types';

const task = { ...taskFromTemplate(SCHEDULED_TASK_TEMPLATES[0], 'zh-CN'), reminderText: '周报', maxHistoryRuns: 2 };
const message = (id: string, role: Message['role'], text: string, scheduledTaskRun = false): Message => ({
  id, role, text, createdAt: Number(id.replace(/\D/g, '')) || 1, ...(scheduledTaskRun ? { scheduledTaskRun: true } : {}),
});

describe('定时任务记录保留', () => {
  it('按运行标记分组，保留运行内的追问与回复', () => {
    const messages = [
      message('u1', 'user', '旧提示词', true), message('a1', 'assistant', '第一份'),
      message('u2', 'user', '周报', true), message('a2', 'assistant', '第二份'),
      message('u3', 'user', '周报', false), message('a3', 'assistant', '第二份补充'),
      message('u4', 'user', '周报', true), message('a4', 'assistant', '第三份'),
    ];
    expect(retainScheduledTaskMessages(messages, task).map((item) => item.id)).toEqual(['u2', 'a2', 'u3', 'a3', 'u4', 'a4']);
    expect(retainScheduledTaskMessages(messages, { ...task, maxHistoryRuns: 1 }).map((item) => item.id)).toEqual(['u4', 'a4']);
    expect(retainScheduledTaskMessages(messages, { ...task, maxHistoryRuns: undefined })).toBe(messages);
  });

  it('兼容旧提示词、旧版重复运行和无用户消息的旧数据', () => {
    const messages = [
      message('u1', 'user', '早先提示词'), message('a1', 'assistant', '旧结果'),
      message('u2', 'user', '周报'), message('a2', 'assistant', '第二份'),
      message('u3', 'user', '追问'), message('a3', 'assistant', '补充'),
      message('u4', 'user', '周报', true), message('a4', 'assistant', '第三份'),
    ];
    expect(retainScheduledTaskMessages(messages, task).map((item) => item.id)).toEqual(['u2', 'a2', 'u3', 'a3', 'u4', 'a4']);
    const legacy = [message('a1', 'assistant', '旧结果'), message('u2', 'user', '周报', true), message('a2', 'assistant', '新结果')];
    expect(retainScheduledTaskMessages(legacy, { ...task, maxHistoryRuns: 1 }).map((item) => item.id)).toEqual(['u2', 'a2']);
    const unknownLegacy = [message('u1', 'user', '过去的提示词'), message('a1', 'assistant', '旧结果'), message('u2', 'user', '追问'), message('a2', 'assistant', '补充')];
    expect(retainScheduledTaskMessages(unknownLegacy, { ...task, maxHistoryRuns: 1 })).toBe(unknownLegacy);
    const repeatedLegacy = [...unknownLegacy, message('u3', 'user', '过去的提示词'), message('a3', 'assistant', '新结果')];
    expect(retainScheduledTaskMessages(repeatedLegacy, { ...task, maxHistoryRuns: 1 }).map((item) => item.id)).toEqual(['u3', 'a3']);
  });
});
