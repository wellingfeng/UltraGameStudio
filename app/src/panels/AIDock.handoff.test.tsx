import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { simpleBlueprint } from '@/core/defaultBlueprint';
import { defaultComposer } from '@/store/sampleSessions';
import { useSessionHandoffStatus } from '@/store/sessionHandoffStatus';
import { useStore } from '@/store/useStore';
import AIDock from './AIDock';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const messages = [
  { id: 'user', role: 'user' as const, text: '用户目标', createdAt: 1 },
  { id: 'assistant', role: 'assistant' as const, text: '会话已中断', createdAt: 2 },
];

let root: Root | undefined;
let container: HTMLDivElement | undefined;
const originalHandoff = useStore.getState().continueSessionWithHandoff;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  useStore.setState({ continueSessionWithHandoff: originalHandoff });
  useSessionHandoffStatus.setState({ bySession: {} });
});

function handoffButton(): HTMLButtonElement {
  const button = container?.querySelector<HTMLButtonElement>('button[aria-label="汇总并生成续开发提示语"]');
  if (!button) throw new Error('找不到交接按钮');
  return button;
}

it('隔离不同会话的交接进度、按钮和完成提示', async () => {
  const completions = new Map<string, (result: { thinkingLevel?: string }) => void>();
  const handoff = vi.fn(() => {
    const { activeWorkspaceId, activeSessionId } = useStore.getState();
    const key = `${activeWorkspaceId}/${activeSessionId}`;
    return new Promise<{ thinkingLevel?: string }>((resolve) => completions.set(key, resolve));
  });
  useStore.setState({
    mode: 'design', workflow: simpleBlueprint('交接测试'), locale: 'zh-CN', messages,
    activeWorkspaceId: 'workspace-a', activeSessionId: 'session-a', workspaceHistory: [],
    composer: defaultComposer, aiStreaming: false, aiEditingSessions: [], chattingSessions: [],
    jobSessions: [], waitingInputSessions: [], continueSessionWithHandoff: handoff,
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root?.render(<AIDock layout="chat" />));

  await act(async () => handoffButton().click());
  expect(container.textContent).toContain('正在汇总会话并生成交接文档');
  expect(handoffButton().disabled).toBe(true);

  await act(async () => root?.unmount());
  root = createRoot(container);
  await act(async () => root?.render(<AIDock layout="chat" />));
  expect(container.textContent).toContain('正在汇总会话并生成交接文档');
  expect(handoffButton().disabled).toBe(true);

  await act(async () => useStore.setState({ activeSessionId: 'session-b', messages }));
  expect(container.textContent).not.toContain('正在汇总会话并生成交接文档');
  expect(handoffButton().disabled).toBe(false);
  await act(async () => handoffButton().click());
  expect(handoff).toHaveBeenCalledTimes(2);
  expect(handoffButton().disabled).toBe(true);

  await act(async () => completions.get('workspace-a/session-a')?.({ thinkingLevel: 'ultra' }));
  expect(container.textContent).toContain('正在汇总会话并生成交接文档');
  expect(container.textContent).not.toContain('交接文档和续开发提示语已生成');
  expect(handoffButton().disabled).toBe(true);

  await act(async () => useStore.setState({ activeSessionId: 'session-a', messages }));
  expect(container.textContent).toContain('交接文档和续开发提示语已生成');
  expect(handoffButton().disabled).toBe(false);

  await act(async () => useStore.setState({ activeWorkspaceId: 'workspace-b', messages }));
  expect(container.textContent).not.toContain('交接文档和续开发提示语已生成');
  expect(handoffButton().disabled).toBe(false);

  await act(async () => completions.get('workspace-a/session-b')?.({ thinkingLevel: 'ultra' }));
  expect(container.textContent).not.toContain('交接文档和续开发提示语已生成');
  await act(async () => useStore.setState({ activeWorkspaceId: 'workspace-a', activeSessionId: 'session-b', messages }));
  expect(container.textContent).toContain('交接文档和续开发提示语已生成');
  expect(handoffButton().disabled).toBe(false);
});

it('交接失败只显示在来源会话，并恢复按钮', async () => {
  let reject!: (error: Error) => void;
  const handoff = vi.fn(() => new Promise<{ thinkingLevel?: string }>((_resolve, rejectPromise) => { reject = rejectPromise; }));
  useStore.setState({
    mode: 'design', workflow: simpleBlueprint('交接测试'), locale: 'zh-CN', messages,
    activeWorkspaceId: 'workspace-a', activeSessionId: 'session-a', workspaceHistory: [],
    composer: defaultComposer, aiStreaming: false, aiEditingSessions: [], chattingSessions: [],
    jobSessions: [], waitingInputSessions: [], continueSessionWithHandoff: handoff,
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root?.render(<AIDock layout="chat" />));
  await act(async () => handoffButton().click());
  await act(async () => useStore.setState({ activeSessionId: 'session-b', messages }));
  await act(async () => reject(new Error('测试失败')));
  expect(container.textContent).not.toContain('会话汇总失败');
  expect(handoffButton().disabled).toBe(false);
  await act(async () => useStore.setState({ activeSessionId: 'session-a', messages }));
  expect(container.textContent).toContain('会话汇总失败: 测试失败');
  expect(handoffButton().disabled).toBe(false);
});
