import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import Sidebar from '@/panels/Sidebar';
import { historyStore } from '@/store/history/store';
import { applyPromptTitle, chatWorkflow, updateAiEditSessionSummary, useStore } from '@/store/useStore';
import type { AiEditChannel } from '@/store/channelTypes';

const workspaceId = 'order-workspace';
const a = { id: 'order-a', workspaceId, title: '会话甲', createdAt: 1, updatedAt: 500, lastUserMessageAt: 200, isWorkflow: false };
const b = { id: 'order-b', workspaceId, title: '会话乙', createdAt: 1, updatedAt: 400, lastUserMessageAt: 100, isWorkflow: false };
let root: Root | undefined;

function order(container: HTMLElement) {
  return [...container.querySelectorAll('button')].map((button) => button.textContent ?? '')
    .filter((text) => text.includes('会话甲') || text.includes('会话乙'))
    .map((text) => text.includes('会话甲') ? '甲' : '乙');
}

async function setup(first = a, second = b) {
  window.localStorage.clear();
  const workspace = { id: workspaceId, path: 'E:/order-test', name: '排序测试', updatedAt: 500, sessionCount: 2 };
  useStore.setState({
    historyReady: true, activeWorkspaceId: workspaceId, selectedWorkspaceId: workspaceId,
    activeSessionId: first.id, workspaces: [workspace], sessions: [first, second],
    sessionTree: { [workspaceId]: [first, second] }, messages: [], composerDraft: '', composerDrafts: {},
    chattingSessions: [{ workspaceId, sessionId: first.id }, { workspaceId, sessionId: second.id }],
    runningSessions: [], aiEditingSessions: [], waitingInputSessions: [], jobSessions: [],
  });
  vi.spyOn(historyStore, 'patchConfig').mockResolvedValue({} as never);
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<Sidebar />));
  return container;
}

async function clickSession(container: HTMLElement, title: string) {
  const button = [...container.querySelectorAll('button')].find((item) => item.textContent?.includes(title));
  expect(button).toBeTruthy();
  await act(async () => { button!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); });
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

it('keeps two running sessions in place when selecting a session with a newer stream clock', async () => {
  const at = (minute: number) => new Date(2026, 10, 16, 12, minute, 0).getTime();
  const first = { ...a, lastUserMessageAt: at(8), updatedAt: at(8) };
  const second = { ...b, lastUserMessageAt: at(7), updatedAt: at(7) };
  vi.spyOn(historyStore, 'getSession').mockResolvedValue({
    ...second,
    messages: [{ id: 'u', role: 'user', text: '开始', createdAt: at(7) },
      { id: 'stream', role: 'assistant', createdAt: at(7), text: '⏱ 12:07:00 → 12:09:00 · 耗时 2m\n⟳ 生成中…' }],
  });
  const container = await setup(first, second);
  expect(order(container)).toEqual(['甲', '乙']);
  await clickSession(container, '会话乙');
  await vi.waitFor(() => expect(useStore.getState().activeSessionId).toBe(b.id));
  expect(order(container)).toEqual(['甲', '乙']);
  expect(useStore.getState().sessionTree[workspaceId].find((item) => item.id === b.id)?.updatedAt).toBe(at(7));
});

it('keeps equal timestamps stable when selecting and when the backing array is reordered', async () => {
  const sameB = { ...b, lastUserMessageAt: a.lastUserMessageAt, updatedAt: a.updatedAt };
  vi.spyOn(historyStore, 'getSession').mockResolvedValue({ ...sameB, messages: [] });
  const container = await setup(a, sameB);
  expect(order(container)).toEqual(['甲', '乙']);
  await clickSession(container, '会话乙');
  await vi.waitFor(() => expect(useStore.getState().activeSessionId).toBe(b.id));
  expect(order(container)).toEqual(['甲', '乙']);
  await act(async () => useStore.setState({ sessions: [sameB, a], sessionTree: { [workspaceId]: [sameB, a] } }));
  expect(order(container)).toEqual(['甲', '乙']);
});

it('preserves a newer in-memory send when the selected disk record is stale', async () => {
  const { lastUserMessageAt: _timestamp, ...stale } = b;
  vi.spyOn(historyStore, 'getSession').mockResolvedValue({
    ...stale, messages: [{ id: 'old', role: 'user', text: '旧消息', createdAt: 50 }],
  });
  const container = await setup();
  await clickSession(container, '会话乙');
  await vi.waitFor(() => expect(useStore.getState().activeSessionId).toBe(b.id));
  expect(useStore.getState().sessionTree[workspaceId].find((item) => item.id === b.id)?.lastUserMessageAt).toBe(100);
  expect(order(container)).toEqual(['甲', '乙']);
});

it('preserves a newer send when an older rename completes asynchronously', async () => {
  const record = { ...a, messages: [{ id: 'old', role: 'user' as const, text: '旧消息', createdAt: 200 }] };
  vi.spyOn(historyStore, 'getSession').mockResolvedValue(record);
  let finishRename!: (value: typeof record) => void;
  const pendingRename = new Promise<typeof record>((resolve) => { finishRename = resolve; });
  const update = vi.spyOn(historyStore, 'updateSession').mockReturnValue(pendingRename);
  const container = await setup();
  const rename = useStore.getState().renameWorkflowSession(a.id, workspaceId, '新标题');
  await vi.waitFor(() => expect(update).toHaveBeenCalled());
  await act(async () => {
    const state = useStore.getState();
    useStore.setState(applyPromptTitle(state, '新消息', 800));
  });
  await act(async () => { finishRename({ ...record, title: '新标题' }); await rename; });
  expect(useStore.getState().sessionTree[workspaceId].find((item) => item.id === a.id)?.lastUserMessageAt).toBe(800);
  expect(container.textContent).toContain('新标题');
});

it('keeps groups stable on session open/run and moves an explicitly selected workspace first', async () => {
  const otherWorkspace = { id: 'order-other', path: 'E:/order-other', name: '另一工作区', updatedAt: 400, sessionCount: 1 };
  const other = { ...b, workspaceId: otherWorkspace.id };
  vi.spyOn(historyStore, 'getSession').mockResolvedValue({
    ...other, messages: [{ id: 'u', role: 'user', text: '旧消息', createdAt: 100 }],
  });
  const container = await setup();
  await act(async () => useStore.setState((state) => ({
    workspaces: [...state.workspaces, otherWorkspace], sessions: [a],
    sessionTree: { [workspaceId]: [a], [otherWorkspace.id]: [other] },
    chattingSessions: [],
  })));
  expect(order(container)).toEqual(['甲', '乙']);
  await clickSession(container, '会话乙');
  await vi.waitFor(() => expect(useStore.getState().activeSessionId).toBe(b.id));
  // Opening a session in another workspace keeps the switcher selection.
  expect(useStore.getState().selectedWorkspaceId).toBe(workspaceId);
  await act(async () => useStore.setState({
    chattingSessions: [{ workspaceId: otherWorkspace.id, sessionId: b.id }],
  }));
  expect(order(container)).toEqual(['甲', '乙']);
  // An explicit workspace switch moves that group to the top.
  await act(async () => useStore.setState({ selectedWorkspaceId: otherWorkspace.id }));
  expect(order(container)).toEqual(['乙', '甲']);
});

it('ignores background summaries, unread status and draft changes but prioritizes live sessions', async () => {
  const container = await setup();
  const channel: AiEditChannel = {
    key: 'order-channel', sessionKey: `${workspaceId}::${b.id}`, workspaceId, sessionId: b.id,
    workflow: chatWorkflow('会话乙', 'zh-CN'), messages: [], chat: true,
    workflowSession: false, cliRunIds: new Set(), abortController: new AbortController(),
  };
  vi.spyOn(Date, 'now').mockReturnValue(900);
  await act(async () => updateAiEditSessionSummary(channel));
  expect(order(container)).toEqual(['甲', '乙']);
  await act(async () => useStore.setState((state) => ({
    chattingSessions: [{ workspaceId, sessionId: b.id }],
    composerDrafts: { [`${workspaceId}::${b.id}`]: '未发送草稿' },
    sessionTree: { [workspaceId]: state.sessionTree[workspaceId].map((s) => s.id === b.id ? { ...s, runStatus: 'success', unreadCompletion: true } : s) },
  })));
  expect(order(container)).toEqual(['乙', '甲']);
});

it('moves a session only when a new user message is sent', async () => {
  const container = await setup();
  await act(async () => {
    useStore.setState({ activeSessionId: b.id });
    const state = useStore.getState();
    useStore.setState(applyPromptTitle(state, '新消息', 800));
  });
  expect(order(container)).toEqual(['乙', '甲']);
});

it.each([true, false])('keeps live sessions together across clicks and status changes (grouped=%s)', async (grouped) => {
  const running = { ...a, lastUserMessageAt: 300 };
  const completed = { ...a, id: 'order-completed', title: '会话完成', lastUserMessageAt: 200, runStatus: 'success' as const };
  const olderRunning = { ...b, lastUserMessageAt: 100 };
  const sessionWorkspace = grouped ? workspaceId : null;
  vi.spyOn(historyStore, 'getSession').mockResolvedValue({
    ...olderRunning,
    messages: [{ id: 'u', role: 'user', text: '开始', createdAt: 100 }],
  });
  const container = await setup(running, olderRunning);
  const titles = () => [...container.querySelectorAll('button')]
    .map((button) => button.textContent ?? '')
    .filter((text) => ['会话甲', '会话乙', '会话完成'].some((title) => text.includes(title)))
    .map((text) => ['会话甲', '会话乙', '会话完成'].find((title) => text.includes(title)));

  await act(async () => useStore.setState({
    workspaces: grouped ? [{ id: workspaceId, path: 'E:/order-test', name: '排序测试', updatedAt: 500, sessionCount: 3 }] : [],
    activeWorkspaceId: sessionWorkspace,
    selectedWorkspaceId: sessionWorkspace,
    sessions: [running, completed, olderRunning],
    sessionTree: grouped ? { [workspaceId]: [running, completed, olderRunning] } : {},
    chattingSessions: [
      { workspaceId: sessionWorkspace, sessionId: running.id },
      { workspaceId: sessionWorkspace, sessionId: olderRunning.id },
    ],
  }));
  expect(titles()).toEqual(['会话甲', '会话乙', '会话完成']);

  await clickSession(container, '会话乙');
  await vi.waitFor(() => expect(useStore.getState().activeSessionId).toBe(olderRunning.id));
  expect(titles()).toEqual(['会话甲', '会话乙', '会话完成']);

  await act(async () => useStore.setState({
    chattingSessions: [{ workspaceId: sessionWorkspace, sessionId: running.id }],
  }));
  expect(titles()).toEqual(['会话甲', '会话完成', '会话乙']);
  await act(async () => useStore.setState({
    chattingSessions: [
      { workspaceId: sessionWorkspace, sessionId: running.id },
      { workspaceId: sessionWorkspace, sessionId: olderRunning.id },
    ],
  }));
  expect(titles()).toEqual(['会话甲', '会话乙', '会话完成']);
});

it.each(['runningSessions', 'chattingSessions', 'aiEditingSessions', 'waitingInputSessions', 'jobSessions'] as const)(
  'prioritizes %s over an idle pinned session',
  async (liveField) => {
    const idlePinned = { ...a, pinned: true };
    const container = await setup(idlePinned, b);
    await act(async () => useStore.setState({
      chattingSessions: [], runningSessions: [], aiEditingSessions: [], waitingInputSessions: [], jobSessions: [],
      [liveField]: [{ workspaceId, sessionId: b.id }],
    }));
    expect(order(container)).toEqual(['乙', '甲']);
  },
);

it('keeps a pinned session ahead of newer sessions within the same live group', async () => {
  const olderPinned = { ...b, pinned: true };
  const container = await setup(a, olderPinned);
  expect(order(container)).toEqual(['乙', '甲']);
  await act(async () => useStore.setState({ chattingSessions: [] }));
  expect(order(container)).toEqual(['乙', '甲']);
});
