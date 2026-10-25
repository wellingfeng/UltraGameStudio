import { afterEach, describe, expect, it, vi } from 'vitest';
import { simpleBlueprint } from '@/core/defaultBlueprint';
import { defaultComposer } from './sampleSessions';
import { getAiEditViewSource } from './channelRegistry';
const gateway = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock('@/lib/modelGateway/modelGateway', async (original) => ({
  ...await original<typeof import('@/lib/modelGateway/modelGateway')>(),
  resolveDirectGatewayRoute: () => ({ selection: { adapter: 'claude-code', modelClass: 'sonnet' }, adapter: 'claude-code', modelClass: 'sonnet', apiKey: 'test', model: 'sonnet', transport: 'anthropic', mode: 'direct', label: '测试模型', source: 'global' }),
  completeGatewayText: gateway.complete,
}));
import { historyStore, __resetHistorySessionCacheForTests } from './history/store';
import { __resetSimpleChatRuntimeForTests, createScheduledTaskSession, loadSessionTree, sessionFromRecord, sessionLiveStatus, useStore } from './useStore';
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
});
