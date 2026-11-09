import { describe, expect, it } from 'vitest';
import { createHandoffSnapshot, handoffContinuePrompt, handoffSummaryPrompt } from './sessionHandoff';
import type { Message } from '@/store/types';

describe('会话交接', () => {
  it('保留完整历史及交互元数据，并要求先汇总再继续', () => {
    const messages: Message[] = [
      { id: 'old', role: 'user', text: '早期目标', createdAt: 1 },
      { id: 'new', role: 'assistant', text: '最新进度', createdAt: 2, contextCompressed: true },
    ];
    const snapshot = JSON.parse(createHandoffSnapshot(messages, {
      workspaceId: 'ws', sessionId: 's1', title: '任务', cwd: 'E:/project',
    }));
    expect(snapshot.messages).toEqual(messages);
    expect(snapshot.source.sessionId).toBe('s1');
    const prompt = handoffSummaryPrompt('E:/project/历史.json', 'E:/project/交接.md');
    expect(prompt).toContain('分段读取');
    expect(prompt).toContain('测试方案及实际验证结果');
    expect(prompt).toContain('本轮只生成和核实交接文档');
    expect(prompt).toContain('在当前会话简要汇报进度、后续计划和文档路径');
    expect(prompt).toContain('E:/project/历史.json');
    expect(prompt).toContain('E:/project/交接.md');
    const continuation = handoffContinuePrompt('E:/project/交接.md');
    expect(continuation).toContain('E:/project/交接.md');
    expect(continuation).not.toContain('E:/project/历史.json');
  });
});
