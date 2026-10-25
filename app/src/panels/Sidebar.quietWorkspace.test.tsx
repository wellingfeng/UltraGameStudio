import { readFileSync } from 'node:fs';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@/store/types';
import type { WorkspaceSummary } from '@/store/history/types';

type SessionKey = { workspaceId: string | null; sessionId: string | null };
type SidebarState = {
  locale: 'zh-CN' | 'en-US';
  assetCenterEnabled: boolean;
  sessions: Session[];
  workspaces: WorkspaceSummary[];
  sessionTree: Record<string, Session[]>;
  activeWorkspaceId: string | null;
  selectedWorkspaceId: string | null;
  activeSessionId: string | null;
  historyReady: boolean;
  composerDraft: string;
  composerDrafts: Record<string, string>;
  runningSessions: SessionKey[];
  runningSessionProgress: Record<string, { percent: number }>;
  aiEditingSessions: SessionKey[];
  chattingSessions: SessionKey[];
  waitingInputSessions: SessionKey[];
  jobSessions: SessionKey[];
  jobSessionProgress: Record<string, { percent: number }>;
  newSession: ReturnType<typeof vi.fn>;
  setWorkspace: ReturnType<typeof vi.fn>;
  selectSession: ReturnType<typeof vi.fn>;
  deleteSession: ReturnType<typeof vi.fn>;
  deleteWorkspaceHistory: ReturnType<typeof vi.fn>;
  renameWorkflowSession: ReturnType<typeof vi.fn>;
  setWorkflowFavoriteSession: ReturnType<typeof vi.fn>;
  setWorkflowScheduledTaskSession: ReturnType<typeof vi.fn>;
};

let state: SidebarState;
vi.mock('@/store/useStore', () => {
  const sessionLiveStatus = (key: SessionKey, live: SidebarState) => {
    const matches = (item: SessionKey) =>
      item.workspaceId === key.workspaceId && item.sessionId === key.sessionId;
    if (live.waitingInputSessions.some(matches)) return 'waiting';
    if (live.runningSessions.some(matches) || live.chattingSessions.some(matches)) return 'running';
    if (live.aiEditingSessions.some(matches)) return 'aiEditing';
    return null;
  };
  return {
    useStore: Object.assign(
      <T,>(selector: (current: SidebarState) => T) => selector(state),
      { getState: () => state },
    ),
    sessionLiveStatus,
    workflowSessionKeyId: (key: SessionKey) => `${key.workspaceId ?? ''}::${key.sessionId ?? ''}`,
    workflowDeleteProtectionReason: (session: Session, workspaceId: string | null, live: SidebarState) =>
      sessionLiveStatus({ workspaceId, sessionId: session.id }, live),
  };
});
vi.mock('@/lib/tauri', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/tauri')>(),
  tauriAvailable: () => false,
  scanProjectEnvironment: vi.fn(async () => null),
  openWorkspaceDirectory: vi.fn(async () => true),
}));
vi.mock('@/lib/sessionIndex', () => ({ searchSessionIdsIndexed: vi.fn(async () => new Set<string>()) }));
vi.mock('./SettingsModal', () => ({ default: () => <div role="dialog">Settings panel</div> }));
vi.mock('./DownloadsModal', () => ({ default: () => <div role="dialog">Asset panel</div> }));

import Sidebar from './Sidebar';

const workspace: WorkspaceSummary = {
  id: 'quiet_workspace', name: '项目工作区', path: 'E:/Projects/Quiet',
  updatedAt: 1_700_000_000_000, sessionCount: 1, lastActiveSessionId: 'quiet_session',
};
const session = {
  id: 'quiet_session', title: '检查工作区', preview: '次要预览文字',
  createdAt: 1_700_000_000_000, isWorkflow: true,
} as Session;
let root: Root | undefined;
let container: HTMLDivElement;

beforeEach(() => {
  window.localStorage.clear();
  state = {
    locale: 'zh-CN', assetCenterEnabled: true, sessions: [session],
    workspaces: [workspace], sessionTree: { [workspace.id]: [session] },
    activeWorkspaceId: workspace.id, selectedWorkspaceId: workspace.id,
    activeSessionId: session.id, historyReady: true,
    composerDraft: '', composerDrafts: {}, runningSessions: [], runningSessionProgress: {},
    aiEditingSessions: [], chattingSessions: [], waitingInputSessions: [],
    jobSessions: [], jobSessionProgress: {}, newSession: vi.fn(), setWorkspace: vi.fn(),
    selectSession: vi.fn(), deleteSession: vi.fn(), deleteWorkspaceHistory: vi.fn(),
    renameWorkflowSession: vi.fn(async () => undefined),
    setWorkflowFavoriteSession: vi.fn(async () => undefined),
    setWorkflowScheduledTaskSession: vi.fn(async () => undefined),
  };
  container = document.createElement('div');
  document.body.appendChild(container);
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container.remove();
  window.localStorage.clear();
  vi.restoreAllMocks();
});
async function renderSidebar() {
  root ??= createRoot(container);
  await act(async () => root!.render(<Sidebar projectScoped />));
}
function button(text: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.includes(text));
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}
async function click(element: HTMLElement) {
  await act(async () => element.click());
}

describe('Sidebar quiet workspace', () => {
  it('keeps owned navigation and metadata above tiny 9–10px sizes', async () => {
    const source = readFileSync('src/panels/Sidebar.tsx', 'utf8');
    expect(/text-\[(?:9|10)px\]/.test(source)).toBe(false);
    await renderSidebar();
    expect(container.querySelector('[role="tab"]')).toBeNull();
    expect(container.querySelector('input[type="search"]')?.className).toContain('text-[13px]');
    expect(button(session.title).textContent).not.toContain(session.preview);
    const metadata = button(session.title).querySelector<HTMLElement>('.ugs-sidebar-meta');
    expect(metadata?.title).toContain(session.preview);
    expect(metadata?.className).toContain('text-[11px]');
    expect(metadata?.className).not.toContain('font-mono');
  });

  it('marks the selected session without changing selection actions', async () => {
    await renderSidebar();
    const row = button(session.title);
    expect(row.classList.contains('ugs-sidebar-session')).toBe(true);
    expect(row.classList.contains('ugs-sidebar-session--selected')).toBe(true);
    expect(row.classList.contains('border')).toBe(false);
    expect(row.className).toContain('bg-panel-2');
    expect(row.className).not.toContain('shadow-[inset_2px_0_0_var(--accent)]');
    expect(row.getAttribute('aria-current')).toBe('true');
    await click(row);
    expect(state.selectSession).toHaveBeenCalledWith(session.id, workspace.id);
    await click(button('新建会话'));
    expect(state.newSession).toHaveBeenCalledTimes(1);
  });

  it('keeps workspace group controls unboxed and actionable', async () => {
    await renderSidebar();
    const header = button(workspace.name).parentElement!;
    expect(header.classList.contains('ugs-sidebar-workspace')).toBe(true);
    expect(header.classList.contains('border')).toBe(false);
    const collapse = container.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
    const more = container.querySelector<HTMLButtonElement>('button[aria-label="更多工作区操作"]')!;
    for (const control of [collapse, more]) {
      expect(control.classList.contains('ugs-control--icon')).toBe(true);
      expect(control.classList.contains('border')).toBe(false);
    }
    await click(button(workspace.name));
    expect(state.setWorkspace).toHaveBeenCalledWith(workspace.path);
    await click(collapse);
    expect(button(workspace.name)).toBeTruthy();
    expect(container.textContent).not.toContain(session.title);
    await click(collapse);
    expect(button(session.title)).toBeTruthy();
    await click(more);
    expect(container.textContent).toContain('项目设置');
    expect(container.textContent).toContain('从历史中移除');
  });
});

describe('Sidebar live session treatment', () => {
  it.each([
    ['grouped', 'running'],
    ['grouped', 'thinking'],
    ['flat', 'running'],
    ['flat', 'thinking'],
  ] as const)('keeps a %s %s session luminous independently of selection', async (layout, tone) => {
    const workspaceId = layout === 'grouped' ? workspace.id : null;
    if (layout === 'flat') {
      state.workspaces = [];
      state.sessionTree = {};
      state.activeWorkspaceId = null;
      state.selectedWorkspaceId = null;
    }
    state.activeSessionId = null;
    const key = { workspaceId, sessionId: session.id };
    if (tone === 'running') state.runningSessions = [key];
    else state.aiEditingSessions = [key];
    root = createRoot(container);
    const render = () => act(async () => root!.render(<Sidebar />));
    await render();

    const row = button(session.title);
    expect(row.classList.contains('ugs-sidebar-session--live')).toBe(true);
    expect(row.getAttribute('aria-current')).toBeNull();
    expect(row.querySelector(`[data-status="${tone}"]`)).not.toBeNull();

    state.activeSessionId = session.id;
    await render();
    expect(row.classList.contains('ugs-sidebar-session--live')).toBe(true);
    expect(row.getAttribute('aria-current')).toBe('true');

    state.runningSessions = [];
    state.aiEditingSessions = [];
    await render();
    expect(row.classList.contains('ugs-sidebar-session--live')).toBe(false);
    expect(row.getAttribute('aria-current')).toBe('true');
  });

  it.each([
    ['running', '正在运行，进度未知'],
    ['thinking', 'AI 思考中'],
    ['waiting', '等待输入'],
    ['failed', '已失败'],
    ['interrupted', '已中断'],
  ] as const)('puts the %s state before stale preview text', async (tone, label) => {
    const key = { workspaceId: workspace.id, sessionId: session.id };
    if (tone === 'running') state.runningSessions = [key];
    if (tone === 'thinking') state.aiEditingSessions = [key];
    if (tone === 'waiting') state.waitingInputSessions = [key];
    if (tone === 'failed' || tone === 'interrupted') {
      const ended = { ...session, runStatus: tone === 'failed' ? 'error' : 'interrupted' } as Session;
      state.sessions = [ended];
      state.sessionTree = { [workspace.id]: [ended] };
    }
    await renderSidebar();
    const metadata = button(session.title).querySelector<HTMLElement>('.ugs-sidebar-meta')!;
    expect(metadata.getAttribute('title')).toContain(label);
    expect(button(session.title).querySelector('[data-status]')?.getAttribute('aria-label')).toBe(label);
    expect(metadata.textContent).not.toContain(session.preview);
    expect(metadata.getAttribute('title')).toContain(session.preview);
    expect(button(session.title).classList.contains('ugs-sidebar-session--live')).toBe(tone === 'running' || tone === 'thinking');
  });

  it('shows only real running progress and retains the full description', async () => {
    state.runningSessions = [{ workspaceId: workspace.id, sessionId: session.id }];
    state.runningSessionProgress = { [`${workspace.id}::${session.id}`]: { percent: 42 } };
    await renderSidebar();
    const metadata = button(session.title).querySelector<HTMLElement>('.ugs-sidebar-meta')!;
    expect(metadata.textContent).toContain('42%');
    expect(metadata.getAttribute('title')).toContain('正在运行，进度 42%');
    state.runningSessionProgress = {};
    await renderSidebar();
    expect(metadata.getAttribute('title')).toContain('正在运行');
    expect(metadata.textContent).not.toContain('%');
  });

  it.each(['grouped', 'flat'] as const)('keeps legacy timing in the %s tooltip without a second line', async (layout) => {
    const preview = '⏱ 13:49:59 → 13:52:19 · 耗时 2m 20s\n完成阴影根因分析';
    const completed = { ...session, preview, runStatus: 'success' } as Session;
    state.sessions = [completed];
    state.sessionTree = { [workspace.id]: [completed] };
    if (layout === 'flat') {
      state.workspaces = [];
      state.sessionTree = {};
      state.activeWorkspaceId = null;
      state.selectedWorkspaceId = null;
      root = createRoot(container);
      await act(async () => root!.render(<Sidebar />));
    } else await renderSidebar();
    const metadata = button(session.title).querySelector<HTMLElement>('.ugs-sidebar-meta')!;
    expect(metadata.textContent).not.toContain('耗时');
    expect(metadata.textContent).not.toContain('13:49:59 → 13:52:19');
    expect(metadata.getAttribute('title')).toContain(preview);
    expect(button(session.title).querySelector('[title="检查工作区"]')).not.toBeNull();
  });

  it('stops the light while a running session is parked on user input', async () => {
    const key = { workspaceId: workspace.id, sessionId: session.id };
    state.runningSessions = [key];
    state.waitingInputSessions = [key];
    await renderSidebar();
    const row = button(session.title);
    expect(row.classList.contains('ugs-sidebar-session--live')).toBe(false);
    expect(row.querySelector('[data-status="waiting"]')).not.toBeNull();
    expect(row.querySelector('.ugs-sidebar-meta')?.getAttribute('title')).toContain('等待输入');
    state.waitingInputSessions = [];
    await renderSidebar();
    expect(row.classList.contains('ugs-sidebar-session--live')).toBe(true);
  });
});
