import { afterEach, describe, expect, it, vi } from 'vitest';
import { simpleBlueprint } from '@/core/defaultBlueprint';
import { readStartUserInputs, setStartUserInputs } from '@/core/startInputs';
import { defaultComposer } from './sampleSessions';
import { getAiEditViewSource } from './channelRegistry';
const gateway = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock('@/lib/modelGateway/modelGateway', async (original) => ({
  ...await original<typeof import('@/lib/modelGateway/modelGateway')>(),
  resolveDirectGatewayRoute: () => ({ selection: { adapter: 'claude-code', modelClass: 'sonnet' }, adapter: 'claude-code', modelClass: 'sonnet', apiKey: 'test', model: 'sonnet', transport: 'anthropic', mode: 'direct', label: '测试模型', source: 'global' }),
  completeGatewayText: gateway.complete,
}));
import { historyStore, __resetHistorySessionCacheForTests } from './history/store';
import { __resetSimpleChatRuntimeForTests, clearScheduledTaskSession, createScheduledTaskSession, loadSessionTree, sessionFromRecord, sessionLiveStatus, useStore } from './useStore';
import { SCHEDULED_TASK_SCOPE } from '@/lib/scheduledTaskScope';
import { taskFromTemplate, SCHEDULED_TASK_TEMPLATES } from '@/lib/scheduledTaskTemplates';
const originalSendPrompt = useStore.getState().sendPrompt;

afterEach(() => {
  __resetSimpleChatRuntimeForTests();
  gateway.complete.mockReset();
  vi.restoreAllMocks();
  window.localStorage.clear();
  __resetHistorySessionCacheForTests();
  useStore.setState({ sendPrompt: originalSendPrompt, historyReady: false, sessions: [], sessionTree: {}, workspaces: [], activeWorkspaceId: null, activeSessionId: null, composerBySession: {} });
});

describe('定时任务独立归属', () => {
  it('创建任务不进入当前项目，不切换当前会话，重载后仍可发现', async () => {
    const workspace = await historyStore.resolveWorkspaceByPath('E:/project');
    useStore.setState({ historyReady: true, workspaces: [workspace], activeWorkspaceId: workspace.id, activeSessionId: 'current', sessions: [], sessionTree: {} });
    const key = await createScheduledTaskSession(taskFromTemplate(SCHEDULED_TASK_TEMPLATES[0], 'zh-CN'));
    expect(key.workspaceId).toBe(SCHEDULED_TASK_SCOPE);
    expect(useStore.getState().sessions).toEqual([]);
    expect(useStore.getState().activeSessionId).toBe('current');
    expect(await historyStore.listSessions(workspace.id)).toEqual([]);
    expect((await loadSessionTree(await historyStore.listWorkspaces()))[SCHEDULED_TASK_SCOPE]).toHaveLength(1);
    expect(window.localStorage.getItem(`ultragamestudio.history.v1:scheduled-tasks/sessions/${key.sessionId}.json`)).not.toBeNull();
  });

  it('旧任务迁入全局目录，保留提示词、消息与排程；重复迁移不复制', async () => {
    const workspace = await historyStore.resolveWorkspaceByPath('E:/legacy');
    const task = taskFromTemplate(SCHEDULED_TASK_TEMPLATES[0], 'zh-CN');
    const record = await historyStore.createSession({ workspaceId: workspace.id, id: 'legacy-task', title: '周报汇总', isWorkflow: false, messages: [{ id: 'answer', role: 'assistant', text: '已生成周报', createdAt: 1 }], meta: { scheduledTask: task } });
    await historyStore.ready();
    await historyStore.ready();
    expect(await historyStore.listSessions(workspace.id)).toEqual([]);
    expect(await historyStore.getSession(SCHEDULED_TASK_SCOPE, record.id)).toMatchObject({ title: record.title, messages: record.messages, meta: { scheduledTask: task } });
    expect(await historyStore.listSessions(SCHEDULED_TASK_SCOPE)).toHaveLength(1);
    expect((await historyStore.listWorkspaces()).some((item) => item.id === SCHEDULED_TASK_SCOPE)).toBe(false);
  });

  it('触发任务直接派发到任务会话，保留用户当前项目与会话', async () => {
    const task = taskFromTemplate(SCHEDULED_TASK_TEMPLATES[0], 'zh-CN');
    const record = await historyStore.createSession({ workspaceId: SCHEDULED_TASK_SCOPE, isWorkflow: false, meta: { scheduledTask: task } });
    useStore.setState({ historyReady: true, activeWorkspaceId: 'project', activeSessionId: 'current', sessionTree: { [SCHEDULED_TASK_SCOPE]: [sessionFromRecord(record)] } });
    const send = vi.spyOn(useStore.getState(), 'sendPrompt').mockReturnValue(true);
    await useStore.getState().runScheduledTaskSession(record.id, SCHEDULED_TASK_SCOPE, task);
    expect(send).toHaveBeenCalledWith(task.reminderText, expect.objectContaining({ externalSession: { workspaceId: SCHEDULED_TASK_SCOPE, sessionId: record.id, messages: [] } }));
    expect(useStore.getState().activeWorkspaceId).toBe('project');
    expect(useStore.getState().activeSessionId).toBe('current');
  });

  it('删除任务从任务列表与全局目录移除，不产生普通项目会话', async () => {
    useStore.setState({ historyReady: true, sessions: [], sessionTree: {}, activeWorkspaceId: 'project' });
    const key = await createScheduledTaskSession(taskFromTemplate(SCHEDULED_TASK_TEMPLATES[0], 'zh-CN'));
    await useStore.getState().setWorkflowScheduledTaskSession(key.sessionId!, key.workspaceId, null);
    expect(await historyStore.listSessions(SCHEDULED_TASK_SCOPE)).toEqual([]);
    expect(useStore.getState().sessionTree[SCHEDULED_TASK_SCOPE]).toEqual([]);
    expect(useStore.getState().sessions).toEqual([]);
  });

  it('运行中的任务禁止删除，避免结果写回重建已删任务', async () => {
    useStore.setState({ historyReady: true, sessions: [], sessionTree: {}, activeWorkspaceId: 'project', chattingSessions: [] });
    const key = await createScheduledTaskSession(taskFromTemplate(SCHEDULED_TASK_TEMPLATES[0], 'zh-CN'));
    useStore.setState({ chattingSessions: [key] });
    await expect(useStore.getState().setWorkflowScheduledTaskSession(key.sessionId!, key.workspaceId, null)).rejects.toThrow();
    expect(await historyStore.getSession(SCHEDULED_TASK_SCOPE, key.sessionId!)).not.toBeNull();
    useStore.setState({ chattingSessions: [] });
  });

  it('通过真实模型入口连续运行两次，结果持久化；收藏的旧任务不清空历史', async () => {
    gateway.complete.mockResolvedValue('任务执行结果');
    const task = taskFromTemplate(SCHEDULED_TASK_TEMPLATES[0], 'zh-CN');
    const record = await historyStore.createSession({ workspaceId: SCHEDULED_TASK_SCOPE, isWorkflow: false, meta: { scheduledTask: task, favorite: true }, messages: [] });
    const foreground = [{ id: 'foreground', role: 'user' as const, text: '当前会话', createdAt: 1 }];
    useStore.setState({ historyReady: true, activeWorkspaceId: 'project', activeSessionId: 'current', workspaces: [],
      workflow: simpleBlueprint('当前会话'), composer: { ...defaultComposer, workspace: 'E:/original-execution' }, composerBySession: {
        [`${SCHEDULED_TASK_SCOPE}::${record.id}`]: { composer: { ...defaultComposer, workspace: 'E:/task-execution' }, gatewaySelection: { adapter: 'claude-code', modelClass: 'sonnet' } },
      }, messages: foreground, sessions: [], sessionTree: { [SCHEDULED_TASK_SCOPE]: [sessionFromRecord(record)] },
      aiEditingSessions: [], runningSessions: [], chattingSessions: [], waitingInputSessions: [], jobSessions: [] });
    const key = { workspaceId: SCHEDULED_TASK_SCOPE, sessionId: record.id };
    for (let index = 0; index < 2; index++) {
      await useStore.getState().runScheduledTaskSession(record.id, SCHEDULED_TASK_SCOPE, task);
      await vi.waitFor(() => expect(sessionLiveStatus(key, useStore.getState())).toBeNull());
    }
    expect(getAiEditViewSource(SCHEDULED_TASK_SCOPE, record.id)?.messages.filter((message) => message.role === 'assistant').map((message) => message.text)).toEqual([expect.stringContaining('任务执行结果'), expect.stringContaining('任务执行结果')]);
    await vi.waitFor(async () => expect((await historyStore.getSession(SCHEDULED_TASK_SCOPE, record.id))?.messages.filter((message) => message.role === 'assistant' && message.text.includes('任务执行结果'))).toHaveLength(2));
    expect(gateway.complete.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(useStore.getState().messages).toEqual(foreground);
    expect(useStore.getState().activeSessionId).toBe('current');
    expect(useStore.getState().composer.workspace).toBe('E:/original-execution');
  });

  it('清空持久化内容与内存快照，旧写入不能恢复，下一次运行从空会话开始', async () => {
    gateway.complete.mockResolvedValue('旧运行结果');
    const task = taskFromTemplate(SCHEDULED_TASK_TEMPLATES[0], 'zh-CN');
    const record = await historyStore.createSession({ workspaceId: SCHEDULED_TASK_SCOPE, isWorkflow: false, meta: { scheduledTask: task }, messages: [] });
    const foreground = [{ id: 'foreground', role: 'user' as const, text: '当前会话', createdAt: 1 }];
    useStore.setState({ historyReady: true, activeWorkspaceId: 'project', activeSessionId: 'current', workflow: simpleBlueprint('当前会话'), composer: defaultComposer, messages: foreground, sessions: [], sessionTree: { [SCHEDULED_TASK_SCOPE]: [sessionFromRecord(record)] }, composerBySession: {}, aiEditingSessions: [], runningSessions: [], chattingSessions: [], waitingInputSessions: [], jobSessions: [] });
    const key = { workspaceId: SCHEDULED_TASK_SCOPE, sessionId: record.id };
    await useStore.getState().runScheduledTaskSession(record.id, SCHEDULED_TASK_SCOPE, task);
    await vi.waitFor(async () => {
      expect(sessionLiveStatus(key, useStore.getState())).toBeNull();
      expect((await historyStore.getSession(SCHEDULED_TASK_SCOPE, record.id))?.messages.length).toBeGreaterThan(0);
    });
    const oldMessages = [...(getAiEditViewSource(SCHEDULED_TASK_SCOPE, record.id)?.messages ?? [])];
    expect(oldMessages.some((message) => message.text.includes('旧运行结果'))).toBe(true);
    await clearScheduledTaskSession(SCHEDULED_TASK_SCOPE, record.id);
    expect((await historyStore.getSession(SCHEDULED_TASK_SCOPE, record.id))?.messages).toEqual([]);
    expect(getAiEditViewSource(SCHEDULED_TASK_SCOPE, record.id)?.messages).toEqual([]);
    expect(useStore.getState().messages).toEqual(foreground);
    await historyStore.updateSession(SCHEDULED_TASK_SCOPE, record.id, { messages: oldMessages, mergeMessages: true });
    expect((await historyStore.getSession(SCHEDULED_TASK_SCOPE, record.id))?.messages).toEqual([]);
    __resetHistorySessionCacheForTests();
    expect((await historyStore.getSession(SCHEDULED_TASK_SCOPE, record.id))?.messages).toEqual([]);
    const send = vi.spyOn(useStore.getState(), 'sendPrompt').mockReturnValue(true);
    await useStore.getState().runScheduledTaskSession(record.id, SCHEDULED_TASK_SCOPE, task);
    expect(send).toHaveBeenCalledWith(task.reminderText, expect.objectContaining({ externalSession: expect.objectContaining({ messages: [] }) }));
    expect((await historyStore.getSession(SCHEDULED_TASK_SCOPE, record.id))?.meta?.scheduledTask).toEqual(task);
  });

  it('清空旧任务的会话输入，保留排程配置', async () => {
    const task = taskFromTemplate(SCHEDULED_TASK_TEMPLATES[0], 'zh-CN');
    const workflow = setStartUserInputs(simpleBlueprint('旧任务'), ['之前的会话输入']);
    const record = await historyStore.createSession({ workspaceId: SCHEDULED_TASK_SCOPE, isWorkflow: true, workflow, meta: { scheduledTask: task, contextCompressed: true }, messages: [{ id: 'old', role: 'user', text: '之前的会话输入', createdAt: 1 }] });
    useStore.setState({ historyReady: true, activeWorkspaceId: 'project', activeSessionId: 'current', sessionTree: { [SCHEDULED_TASK_SCOPE]: [sessionFromRecord(record)] }, aiEditingSessions: [], runningSessions: [], chattingSessions: [], waitingInputSessions: [], jobSessions: [] });
    await clearScheduledTaskSession(SCHEDULED_TASK_SCOPE, record.id);
    const saved = await historyStore.getSession(SCHEDULED_TASK_SCOPE, record.id);
    expect(saved?.messages).toEqual([]);
    expect(readStartUserInputs(saved?.workflow?.nodes.find((node) => node.type === 'start')?.params)).toEqual([]);
    expect(saved?.meta?.scheduledTask).toEqual(task);
    expect(saved?.meta?.contextCompressed).toBe(false);
  });

  it('备份清理失败时仍更新会话，并明确报告已清空', async () => {
    const task = taskFromTemplate(SCHEDULED_TASK_TEMPLATES[0], 'zh-CN');
    const record = await historyStore.createSession({ workspaceId: SCHEDULED_TASK_SCOPE, isWorkflow: false, meta: { scheduledTask: task }, messages: [{ id: 'old', role: 'assistant', text: '旧记录', createdAt: 1 }] });
    useStore.setState({ locale: 'zh-CN', historyReady: true, activeWorkspaceId: 'project', activeSessionId: 'current', sessionTree: { [SCHEDULED_TASK_SCOPE]: [sessionFromRecord(record)] }, aiEditingSessions: [], runningSessions: [], chattingSessions: [], waitingInputSessions: [], jobSessions: [] });
    const originalClear = historyStore.clearScheduledTaskHistory.bind(historyStore);
    vi.spyOn(historyStore, 'clearScheduledTaskHistory').mockImplementation(async (...args) => ({ ...await originalClear(...args), backupError: 'disk error' }));
    await expect(clearScheduledTaskSession(SCHEDULED_TASK_SCOPE, record.id)).rejects.toThrow('会话已清空，但历史备份清理失败');
    expect((await historyStore.getSession(SCHEDULED_TASK_SCOPE, record.id))?.messages).toEqual([]);
    expect(useStore.getState().sessionTree[SCHEDULED_TASK_SCOPE][0].messageCount).toBe(0);
  });

  it('运行中禁止清空，等待清空完成后才派发同一任务', async () => {
    const task = taskFromTemplate(SCHEDULED_TASK_TEMPLATES[0], 'zh-CN');
    const record = await historyStore.createSession({ workspaceId: SCHEDULED_TASK_SCOPE, isWorkflow: false, meta: { scheduledTask: task }, messages: [{ id: 'old', role: 'assistant', text: '旧记录', createdAt: 1 }] });
    const key = { workspaceId: SCHEDULED_TASK_SCOPE, sessionId: record.id };
    useStore.setState({ historyReady: true, activeWorkspaceId: 'project', activeSessionId: 'current', sessionTree: { [SCHEDULED_TASK_SCOPE]: [sessionFromRecord(record)] }, aiEditingSessions: [], runningSessions: [], chattingSessions: [key], waitingInputSessions: [], jobSessions: [] });
    await expect(clearScheduledTaskSession(SCHEDULED_TASK_SCOPE, record.id)).rejects.toThrow();
    expect((await historyStore.getSession(SCHEDULED_TASK_SCOPE, record.id))?.messages).toHaveLength(1);
    useStore.setState({ chattingSessions: [] });
    const originalClear = historyStore.clearScheduledTaskHistory.bind(historyStore);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(historyStore, 'clearScheduledTaskHistory').mockImplementation(async (...args) => { await gate; return originalClear(...args); });
    const send = vi.spyOn(useStore.getState(), 'sendPrompt').mockReturnValue(true);
    const clearing = clearScheduledTaskSession(SCHEDULED_TASK_SCOPE, record.id);
    const running = useStore.getState().runScheduledTaskSession(record.id, SCHEDULED_TASK_SCOPE, task);
    expect(send).not.toHaveBeenCalled();
    release();
    await Promise.all([clearing, running]);
    expect(send).toHaveBeenCalledWith(task.reminderText, expect.objectContaining({ externalSession: expect.objectContaining({ messages: [] }) }));
  });

  it('保存保留次数时清理旧记录，迟到的合并写入不能恢复它们', async () => {
    const task = { ...taskFromTemplate(SCHEDULED_TASK_TEMPLATES[0], 'zh-CN'), maxHistoryRuns: 1 };
    const messages = [
      { id: 'old-user', role: 'user' as const, text: task.reminderText, scheduledTaskRun: true, createdAt: 1 },
      { id: 'old-answer', role: 'assistant' as const, text: '旧周报', createdAt: 2 },
      { id: 'new-user', role: 'user' as const, text: task.reminderText, scheduledTaskRun: true, createdAt: 3 },
      { id: 'new-answer', role: 'assistant' as const, text: '新周报', createdAt: 4 },
    ];
    const record = await historyStore.createSession({ workspaceId: SCHEDULED_TASK_SCOPE, isWorkflow: false, messages, meta: { scheduledTask: { ...task, maxHistoryRuns: undefined } } });
    useStore.setState({ historyReady: true, activeWorkspaceId: SCHEDULED_TASK_SCOPE, activeSessionId: record.id, messages, sessions: [], sessionTree: { [SCHEDULED_TASK_SCOPE]: [sessionFromRecord(record)] }, aiEditingSessions: [], chattingSessions: [], runningSessions: [], waitingInputSessions: [], jobSessions: [] });
    await useStore.getState().setWorkflowScheduledTaskSession(record.id, SCHEDULED_TASK_SCOPE, task);
    expect(useStore.getState().messages.map((message) => message.id)).toEqual(['new-user', 'new-answer']);
    expect((await historyStore.getSession(SCHEDULED_TASK_SCOPE, record.id))?.messages.map((message) => message.id)).toEqual(['new-user', 'new-answer']);
    await historyStore.updateSession(SCHEDULED_TASK_SCOPE, record.id, { messages, mergeMessages: true });
    expect((await historyStore.getSession(SCHEDULED_TASK_SCOPE, record.id))?.messages.map((message) => message.id)).toEqual(['new-user', 'new-answer']);
    await historyStore.updateSession(SCHEDULED_TASK_SCOPE, record.id, { messages });
    expect((await historyStore.getSession(SCHEDULED_TASK_SCOPE, record.id))?.messages.map((message) => message.id)).toEqual(['new-user', 'new-answer']);
    expect((await historyStore.getSession(SCHEDULED_TASK_SCOPE, record.id))?.meta?.scheduledTask?.maxHistoryRuns).toBe(1);
  });

  it('连续运行只保留最近一次，其他会话不受影响', async () => {
    const task = { ...taskFromTemplate(SCHEDULED_TASK_TEMPLATES[0], 'zh-CN'), maxHistoryRuns: 1 };
    const record = await historyStore.createSession({ workspaceId: SCHEDULED_TASK_SCOPE, isWorkflow: false, meta: { scheduledTask: task } });
    const foreground = [{ id: 'foreground', role: 'user' as const, text: '当前会话', createdAt: 1 }];
    useStore.setState({ historyReady: true, activeWorkspaceId: 'project', activeSessionId: 'current', workspaces: [], workflow: simpleBlueprint('当前会话'), composer: defaultComposer, messages: foreground, sessions: [], sessionTree: { [SCHEDULED_TASK_SCOPE]: [sessionFromRecord(record)] }, composerBySession: {}, aiEditingSessions: [], runningSessions: [], chattingSessions: [], waitingInputSessions: [], jobSessions: [] });
    const key = { workspaceId: SCHEDULED_TASK_SCOPE, sessionId: record.id };
    for (const answer of ['第一份周报', '第二份周报', '第三份周报']) {
      gateway.complete.mockResolvedValue(answer);
      await useStore.getState().runScheduledTaskSession(record.id, SCHEDULED_TASK_SCOPE, task);
      await vi.waitFor(async () => {
        const saved = await historyStore.getSession(SCHEDULED_TASK_SCOPE, record.id);
        expect(sessionLiveStatus(key, useStore.getState())).toBeNull();
        expect(saved?.messages.filter((message) => message.scheduledTaskRun)).toHaveLength(1);
        expect(saved?.messages.filter((message) => message.role === 'assistant').map((message) => message.text).join()).toContain(answer);
        expect(saved?.messages.filter((message) => message.role === 'assistant')).toHaveLength(1);
      });
    }
    const snapshot = getAiEditViewSource(SCHEDULED_TASK_SCOPE, record.id);
    expect(snapshot?.messages.filter((message) => message.scheduledTaskRun)).toHaveLength(1);
    expect(snapshot?.messages.map((message) => message.text).join()).not.toContain('第一份周报');
    expect(snapshot?.messages.map((message) => message.text).join()).not.toContain('第二份周报');
    expect(useStore.getState().messages).toEqual(foreground);
  });

  it('运行中启用限制时保留旧记录，等当前运行结束再清理', async () => {
    let finish!: (answer: string) => void;
    gateway.complete.mockImplementation(() => new Promise<string>((resolve) => { finish = resolve; }));
    const originalTask = taskFromTemplate(SCHEDULED_TASK_TEMPLATES[0], 'zh-CN');
    const oldMessages = [
      { id: 'old-user', role: 'user' as const, text: originalTask.reminderText, scheduledTaskRun: true, createdAt: 1 },
      { id: 'old-answer', role: 'assistant' as const, text: '上一份周报', createdAt: 2 },
    ];
    const record = await historyStore.createSession({ workspaceId: SCHEDULED_TASK_SCOPE, isWorkflow: false, messages: oldMessages, meta: { scheduledTask: originalTask } });
    useStore.setState({ historyReady: true, activeWorkspaceId: 'project', activeSessionId: 'current', workspaces: [], workflow: simpleBlueprint('当前会话'), composer: defaultComposer, messages: [], sessions: [], sessionTree: { [SCHEDULED_TASK_SCOPE]: [sessionFromRecord(record)] }, composerBySession: {}, aiEditingSessions: [], runningSessions: [], chattingSessions: [], waitingInputSessions: [], jobSessions: [] });
    const key = { workspaceId: SCHEDULED_TASK_SCOPE, sessionId: record.id };
    await useStore.getState().runScheduledTaskSession(record.id, SCHEDULED_TASK_SCOPE, originalTask);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    await useStore.getState().setWorkflowScheduledTaskSession(record.id, SCHEDULED_TASK_SCOPE, { ...originalTask, maxHistoryRuns: 1 });
    expect(sessionLiveStatus(key, useStore.getState())).not.toBeNull();
    expect((await historyStore.getSession(SCHEDULED_TASK_SCOPE, record.id))?.messages.map((message) => message.text).join()).toContain('上一份周报');
    finish('最新周报');
    await vi.waitFor(async () => {
      const saved = await historyStore.getSession(SCHEDULED_TASK_SCOPE, record.id);
      expect(sessionLiveStatus(key, useStore.getState())).toBeNull();
      expect(saved?.messages.map((message) => message.text).join()).toContain('最新周报');
      expect(saved?.messages.map((message) => message.text).join()).not.toContain('上一份周报');
    });
  });

  it('后台任务结束后执行之前延期的清理', async () => {
    const task = { ...taskFromTemplate(SCHEDULED_TASK_TEMPLATES[0], 'zh-CN'), maxHistoryRuns: 1 };
    const messages = [
      { id: 'old-user', role: 'user' as const, text: task.reminderText, scheduledTaskRun: true, createdAt: 1 },
      { id: 'old-answer', role: 'assistant' as const, text: '上一份', createdAt: 2 },
      { id: 'new-user', role: 'user' as const, text: task.reminderText, scheduledTaskRun: true, createdAt: 3 },
      { id: 'new-answer', role: 'assistant' as const, text: '最新一份', createdAt: 4 },
    ];
    const record = await historyStore.createSession({ workspaceId: SCHEDULED_TASK_SCOPE, isWorkflow: false, messages, meta: { scheduledTask: task } });
    const key = { workspaceId: SCHEDULED_TASK_SCOPE, sessionId: record.id };
    useStore.setState({ historyReady: true, activeWorkspaceId: 'project', activeSessionId: 'current', sessions: [], sessionTree: { [SCHEDULED_TASK_SCOPE]: [sessionFromRecord(record)] }, aiEditingSessions: [], chattingSessions: [], runningSessions: [], waitingInputSessions: [], jobSessions: [key] });
    await useStore.getState().setWorkflowScheduledTaskSession(record.id, SCHEDULED_TASK_SCOPE, task);
    expect((await historyStore.getSession(SCHEDULED_TASK_SCOPE, record.id))?.messages).toHaveLength(4);
    useStore.getState().setBackgroundJobState([], {});
    await vi.waitFor(async () => expect((await historyStore.getSession(SCHEDULED_TASK_SCOPE, record.id))?.messages.map((message) => message.id)).toEqual(['new-user', 'new-answer']));
  });
});
