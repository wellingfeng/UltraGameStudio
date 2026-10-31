import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { historyStore } from '@/store/history/store';
import { sessionFromRecord, useStore } from '@/store/useStore';
import { SCHEDULED_TASK_SCOPE } from '@/lib/scheduledTaskScope';
import { SCHEDULED_TASK_TEMPLATES, taskFromTemplate } from '@/lib/scheduledTaskTemplates';
import ScheduledTasksPanel from './ScheduledTasksPanel';
import type { Message } from '@/store/types';
import { openLocalPath } from '@/lib/tauri';

vi.mock('@/components/ai/MessageContent', () => ({ default: ({ text }: { text: string }) => <div>{text}</div> }));
vi.mock('@/components/ai/FilePreviewDrawer', () => ({ default: ({ refData, cwd, overlayContainerRef, onClose }: { refData: { path: string } | null; cwd?: string; overlayContainerRef?: { current: HTMLElement | null }; onClose: () => void }) => refData ? <aside data-preview-path={refData.path} data-preview-cwd={cwd} data-preview-host={overlayContainerRef?.current?.className}><button onClick={onClose}>关闭预览</button></aside> : null }));
vi.mock('@/lib/tauri', async (original) => ({ ...await original<typeof import('@/lib/tauri')>(), openLocalPath: vi.fn().mockResolvedValue(true) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let container: HTMLDivElement;
const originalRunTask = useStore.getState().runScheduledTaskSession;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined; container?.remove(); vi.restoreAllMocks(); window.localStorage.clear();
  useStore.setState({ runScheduledTaskSession: originalRunTask, sessions: [], sessionTree: {}, composerBySession: {}, workspaces: [], activeWorkspaceId: null, activeSessionId: null });
});
async function render(messages?: Message[], executionPath?: string) {
  const entries = [];
  for (const [id, name] of [['weekly', '周报汇总'], ['morning', '每日简报']]) {
    entries.push(sessionFromRecord(await historyStore.createSession({
      workspaceId: SCHEDULED_TASK_SCOPE, id, title: name, isWorkflow: false,
      meta: { scheduledTask: { ...taskFromTemplate(SCHEDULED_TASK_TEMPLATES[0], 'zh-CN'), name, reminderText: `${name}完整提示词\n第二行必须显示` }, scheduledTaskExecutionPath: executionPath },
      messages: id === 'weekly' && messages ? messages : [{ id: `${id}-answer`, role: 'assistant', text: `${name}真实历史结果`, createdAt: 1 }],
    })));
  }
  useStore.setState({ historyReady: true, sessions: [], sessionTree: { [SCHEDULED_TASK_SCOPE]: entries }, activeWorkspaceId: 'project', activeSessionId: 'current', composerBySession: {} });
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  const close = vi.fn();
  await act(async () => root!.render(<ScheduledTasksPanel locale="zh-CN" onClose={close} />));
  return close;
}
async function click(text: string) {
  const button = [...container.querySelectorAll('button')].find((element) => element.textContent?.trim() === text);
  expect(button).toBeTruthy(); await act(async () => button!.click());
}
describe('定时任务页面', () => {
  it('历史回复显示产出物，支持预览、定位；用户输入与工具日志不冒充产出', async () => {
    await render([
      { id: 'input', role: 'user', text: '[参考文件](E:/inputs/参考.docx)', createdAt: 1 },
      { id: 'answer', role: 'assistant', text: '<think>[中间文件](E:/temp/中间.docx)</think>\n✅ [下载工作周报（Word）](.ultragamestudio/docs/dev/weekly-reports/工作周报.docx)', createdAt: 2 },
    ], 'E:/TaskWorkspace');
    const card = container.querySelector('[data-ugs-generated-artifacts]');
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain('工作周报.docx');
    expect(card?.textContent).not.toContain('参考.docx');
    expect(card?.textContent).not.toContain('中间.docx');
    await click('DOCX工作周报.docx下载工作周报（Word）');
    expect(container.querySelector('[data-preview-path]')?.getAttribute('data-preview-path')).toBe('.ultragamestudio/docs/dev/weekly-reports/工作周报.docx');
    expect(container.querySelector('[data-preview-cwd]')?.getAttribute('data-preview-cwd')).toBe('E:/TaskWorkspace');
    expect(container.querySelector('[data-preview-host]')?.getAttribute('data-preview-host')).toBe('scheduled-tasks-main');
    await act(async () => (container.querySelector('button[aria-label="在文件夹中显示：工作周报.docx"]') as HTMLButtonElement).click());
    expect(openLocalPath).toHaveBeenCalledWith('.ultragamestudio/docs/dev/weekly-reports/工作周报.docx', { cwd: 'E:/TaskWorkspace', reveal: true });
    expect(useStore.getState().activeSessionId).toBe('current');
    await click('每日简报');
    expect(container.querySelector('[data-ugs-generated-artifacts]')).toBeNull();
    expect(container.querySelector('[data-preview-path]')).toBeNull();
    await click('周报汇总');
    expect(container.querySelector('[data-ugs-generated-artifacts]')).not.toBeNull();
  });

  it('左侧选任务，右侧显示完整提示词与历史；切换不进入项目会话', async () => {
    const close = await render();
    expect(container.querySelector('nav')?.textContent).toContain('周报汇总');
    expect(container.querySelector('main')?.textContent).toContain('周报汇总完整提示词');
    expect(container.querySelector('main')?.textContent).toContain('第二行必须显示');
    expect(container.querySelector('main')?.textContent).toContain('周报汇总真实历史结果');
    await click('每日简报');
    expect(container.querySelector('main')?.textContent).toContain('每日简报真实历史结果');
    expect(container.querySelector('main')?.textContent).not.toContain('周报汇总真实历史结果');
    expect(useStore.getState().activeSessionId).toBe('current');
    expect(close).not.toHaveBeenCalled();
  });
  it('立即运行留在任务页面，结果不跳回普通会话', async () => {
    const close = await render();
    const run = vi.spyOn(useStore.getState(), 'runScheduledTaskSession').mockResolvedValue();
    await click('立即运行');
    expect(run).toHaveBeenCalledWith('weekly', SCHEDULED_TASK_SCOPE, expect.objectContaining({ enabled: true }));
    expect(useStore.getState().activeWorkspaceId).toBe('project');
    expect(close).not.toHaveBeenCalled();
    expect((await historyStore.getSession(SCHEDULED_TASK_SCOPE, 'weekly'))?.meta?.scheduledTask?.lastRunAt).toBeGreaterThan(0);
  });
});
