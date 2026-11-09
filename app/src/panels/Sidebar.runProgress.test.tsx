import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

type SessionKey = {
  workspaceId: string | null;
  sessionId: string | null;
};

type MockSession = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt?: number;
  preview?: string;
  isWorkflow: boolean;
  simple?: boolean;
  favorite?: boolean;
  pinned?: boolean;
  scheduledTask?: {
    enabled: boolean;
    reminderText: string;
    hour: number;
    minute: number;
    second: number;
    weekdays: (0 | 1 | 2 | 3 | 4 | 5 | 6)[];
    repeat: boolean;
    remindOnRun: boolean;
    updatedAt: number;
    lastRunAt?: number;
  };
  runStatus?: 'success' | 'error' | 'interrupted';
  contextCompressed?: boolean;
};

type MockWorkspace = {
  id: string;
  path: string;
  name: string;
  updatedAt: number;
  sessionCount: number;
  lastActiveSessionId: string | null;
  metadata?: Record<string, unknown>;
};

type MockStoreState = {
  locale: 'zh-CN' | 'en-US';
  mode: 'design' | 'running';
  sessions: MockSession[];
  historyReady: boolean;
  workspaces: MockWorkspace[];
  sessionTree: Record<string, MockSession[]>;
  activeWorkspaceId: string | null;
  selectedWorkspaceId: string | null;
  activeSessionId: string | null;
  composerDraft: string;
  composerDrafts: Record<string, string>;
  runningSessions: SessionKey[];
  runningSessionProgress: Record<
    string,
    { completed: number; incomplete: number; percent: number | null }
  >;
  aiEditingSessions: SessionKey[];
  chattingSessions: SessionKey[];
  jobSessions: SessionKey[];
  jobSessionProgress: Record<
    string,
    { completed: number; incomplete: number; percent: number | null }
  >;
  newWorkflow: () => void;
  newSession: () => void;
  exportWorkflowSession: (
    sessionId: string,
    workspaceId: string | null,
    title?: string,
  ) => void;
  importWorkflowToWorkspace: (workspaceId: string, title?: string) => void;
  setWorkspace: (path: string) => void;
  selectSession: (sessionId: string, workspaceId?: string) => void;
  deleteSession: (sessionId: string, workspaceId?: string) => void;
  deleteWorkspaceHistory: (workspaceId: string) => void;
  renameWorkflowSession: (
    sessionId: string,
    workspaceId: string | null,
    name: string,
  ) => Promise<void>;
  setSessionPinned: (sessionId: string, workspaceId: string | null, pinned: boolean) => Promise<void>;
  setWorkflowFavoriteSession: (
    sessionId: string,
    workspaceId: string | null,
    favorite: boolean,
  ) => Promise<void>;
  setWorkflowScheduledTaskSession: (
    sessionId: string,
    workspaceId: string | null,
    scheduledTask: MockSession['scheduledTask'] | null,
  ) => Promise<void>;
  runScheduledTaskSession: (
    sessionId: string,
    workspaceId: string | null,
    scheduledTask: NonNullable<MockSession['scheduledTask']>,
  ) => Promise<void>;
  setWorkflow: () => void;
  markSaved: () => void;
};

let mockState: MockStoreState;
const conversationMocks = vi.hoisted(() => ({
  read: vi.fn(),
  copy: vi.fn(),
  export: vi.fn(),
}));

vi.mock('@/lib/conversationActions', () => ({
  copyConversationText: conversationMocks.copy,
  exportConversationText: conversationMocks.export,
}));

vi.mock('@/store/useStore', () => {
  const useStore = Object.assign(
    vi.fn((selector: (state: MockStoreState) => unknown) =>
      selector(mockState),
    ),
    { getState: () => mockState },
  );

  const sessionLiveStatus = (
    sessionKey: SessionKey,
    liveState: Pick<MockStoreState, 'runningSessions' | 'aiEditingSessions'> &
      Partial<Pick<MockStoreState, 'chattingSessions'>>,
  ) => {
    const isMatch = (item: SessionKey) =>
      item.workspaceId === sessionKey.workspaceId &&
      item.sessionId === sessionKey.sessionId;
    if (liveState.runningSessions.some(isMatch)) return 'running';
    if ((liveState.chattingSessions ?? []).some(isMatch)) return 'running';
    if (liveState.aiEditingSessions.some(isMatch)) return 'aiEditing';
    return null;
  };

  return {
    isActiveAiEditingSession: (
      state: Pick<
        MockStoreState,
        'activeWorkspaceId' | 'activeSessionId' | 'aiEditingSessions'
      >,
    ) =>
      state.aiEditingSessions.some(
        (item) =>
          item.workspaceId === state.activeWorkspaceId &&
          item.sessionId === state.activeSessionId,
      ),
    isWorkflowReadOnly: (state: Pick<MockStoreState, 'mode'>) =>
      state.mode === 'running',
    sessionLiveStatus,
    getSessionConversationMessages: conversationMocks.read,
    useStore,
    workflowDeleteProtectionReason: (
      session: Pick<MockSession, 'id'>,
      workspaceId: string | null | undefined,
      liveState: Pick<MockStoreState, 'runningSessions' | 'aiEditingSessions'> &
        Partial<Pick<MockStoreState, 'chattingSessions'>>,
    ) => {
      return sessionLiveStatus(
        { workspaceId: workspaceId ?? null, sessionId: session.id },
        liveState,
      );
    },
    workflowSessionKeyId: (sessionKey: SessionKey) =>
      `${sessionKey.workspaceId ?? ''}::${sessionKey.sessionId ?? ''}`,
  };
});

vi.mock('@/lib/useResizableWidth', () => ({
  useResizableWidth: () => ({
    width: 240,
    onResizeStart: vi.fn(),
  }),
}));

vi.mock('@/lib/persist', () => ({
  openWorkflow: vi.fn(async () => null),
}));

vi.mock('./SettingsModal', () => ({
  default: () => null,
}));

vi.mock('@/lib/tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tauri')>();
  return {
    ...actual,
    openWorkspaceDirectory: vi.fn(async () => true),
    scanProjectEnvironment: vi.fn(async () => {
      throw new Error('NO_BACKEND');
    }),
  };
});

import { openWorkspaceDirectory } from '@/lib/tauri';
import Sidebar from './Sidebar';

const WORKSPACE: MockWorkspace = {
  id: 'ws_test',
  path: 'E:\\UltraGameStudio',
  name: 'UltraGameStudio',
  updatedAt: 1_700_000_000_000,
  sessionCount: 1,
  lastActiveSessionId: 's_workflow',
};

const SESSION: MockSession = {
  id: 's_workflow',
  title: 'Workflow run',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  preview: 'preview',
  isWorkflow: true,
};

const SESSION_KEY: SessionKey = {
  workspaceId: WORKSPACE.id,
  sessionId: SESSION.id,
};

function resetSidebarStore(): void {
  mockState = {
    locale: 'zh-CN',
    mode: 'design',
    sessions: [SESSION],
    historyReady: true,
    workspaces: [WORKSPACE],
    sessionTree: { [WORKSPACE.id]: [SESSION] },
    activeWorkspaceId: WORKSPACE.id,
    selectedWorkspaceId: null,
    activeSessionId: SESSION.id,
    composerDraft: '',
    composerDrafts: {},
    runningSessions: [],
    runningSessionProgress: {},
    aiEditingSessions: [],
    chattingSessions: [],
    jobSessions: [],
    jobSessionProgress: {},
    newWorkflow: vi.fn(),
    newSession: vi.fn(),
    exportWorkflowSession: vi.fn(),
    importWorkflowToWorkspace: vi.fn(),
    setWorkspace: vi.fn(),
    selectSession: vi.fn(),
    deleteSession: vi.fn(),
    deleteWorkspaceHistory: vi.fn(),
    renameWorkflowSession: vi.fn(async () => undefined),
    setSessionPinned: vi.fn(async () => undefined),
    setWorkflowFavoriteSession: vi.fn(async () => undefined),
    setWorkflowScheduledTaskSession: vi.fn(async () => undefined),
    runScheduledTaskSession: vi.fn(async () => undefined),
    setWorkflow: vi.fn(),
    markSaved: vi.fn(),
  };
}

async function renderSidebar(): Promise<{
  container: HTMLDivElement;
  rerender: () => Promise<void>;
  cleanup: () => Promise<void>;
}> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  const rerender = async () => {
    await act(async () => {
      root.render(<Sidebar />);
    });
  };

  await rerender();

  return {
    container,
    rerender,
    cleanup: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe('session context compression marker', () => {
  it('keeps compression visible beside the running status and after completion', async () => {
    resetSidebarStore();
    const session = { ...SESSION, contextCompressed: true };
    mockState.sessions = [session];
    mockState.sessionTree = { [WORKSPACE.id]: [session] };
    mockState.chattingSessions = [SESSION_KEY];
    const view = await renderSidebar();
    try {
      expect(view.container.querySelector('[data-context-compressed="true"]')?.getAttribute('title')).toBe('上下文已压缩');
      expect(view.container.querySelector('[data-status="running"]')).not.toBeNull();
      mockState.chattingSessions = [];
      mockState.sessions = [{ ...session, runStatus: 'success' }];
      mockState.sessionTree = { [WORKSPACE.id]: mockState.sessions };
      await view.rerender();
      expect(view.container.querySelector('[data-context-compressed="true"]')).not.toBeNull();
      expect(view.container.querySelector('[data-status="success"]')).not.toBeNull();
    } finally { await view.cleanup(); }
  });
  it('omits the marker for an uncompressed session', async () => {
    resetSidebarStore();
    const view = await renderSidebar();
    try { expect(view.container.querySelector('[data-context-compressed]')).toBeNull(); }
    finally { await view.cleanup(); }
  });
});

function runningDot(
  container: HTMLElement,
  percent: number,
): HTMLElement | null {
  return container.querySelector(
    `[data-status="running"][title="正在运行，进度 ${percent}%"]`,
  );
}

function statusDot(
  container: HTMLElement,
  status:
    | 'none'
    | 'thinking'
    | 'unrun'
    | 'running'
    | 'draft'
    | 'success'
    | 'interrupted'
    | 'failed',
): HTMLElement | null {
  return container.querySelector(`[data-status="${status}"]`);
}

function statusIndicator(dot: HTMLElement | null): HTMLElement | null {
  return dot?.querySelector<HTMLElement>('.ugs-status-indicator') ?? null;
}

function newSessionButton(container: HTMLElement): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((item) =>
    item.textContent?.includes('新建会话'),
  );
  expect(button).toBeInstanceOf(HTMLButtonElement);
  return button as HTMLButtonElement;
}

function historySearchInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector('input[aria-label="搜索会话"]');
  expect(input).toBeInstanceOf(HTMLInputElement);
  return input as HTMLInputElement;
}

function queryHistorySearchInput(container: HTMLElement): HTMLInputElement | null {
  return container.querySelector('input[aria-label="搜索会话"]');
}

function sessionButton(
  container: HTMLElement,
  title: string,
): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((item) =>
    item.textContent?.includes(title),
  );
  expect(button).toBeInstanceOf(HTMLButtonElement);
  return button as HTMLButtonElement;
}

function workspaceButton(
  container: HTMLElement,
  title: string,
): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find(
    (item) =>
      item.getAttribute('aria-haspopup') !== 'listbox' &&
      item.textContent?.includes(title),
  );
  expect(button).toBeInstanceOf(HTMLButtonElement);
  return button as HTMLButtonElement;
}

function workspaceMoreButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector(
    'button[aria-label="更多工作区操作"]',
  );
  expect(button).toBeInstanceOf(HTMLButtonElement);
  return button as HTMLButtonElement;
}

function sessionTitleOrder(container: HTMLElement, titles: string[]): string[] {
  return Array.from(container.querySelectorAll('button'))
    .map((button) =>
      titles.find((title) => button.textContent?.includes(title)),
    )
    .filter((title): title is string => title !== undefined);
}

function expectTextBefore(
  container: HTMLElement,
  before: string,
  after: string,
): void {
  const text = container.textContent ?? '';
  const beforeIndex = text.indexOf(before);
  const afterIndex = text.indexOf(after);
  expect(beforeIndex).toBeGreaterThanOrEqual(0);
  expect(afterIndex).toBeGreaterThanOrEqual(0);
  expect(beforeIndex).toBeLessThan(afterIndex);
}

async function openSessionContextMenu(
  button: HTMLButtonElement,
): Promise<void> {
  await act(async () => {
    button.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 120,
        clientY: 140,
      }),
    );
  });
}

async function openWorkspaceContextMenu(
  button: HTMLButtonElement,
): Promise<void> {
  await act(async () => {
    button.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 88,
        clientY: 108,
      }),
    );
  });
}

async function clickButton(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function contextMenuDeleteButton(container: HTMLElement): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find(
    (item) => item.textContent?.includes('删除'),
  );
  expect(button).toBeInstanceOf(HTMLButtonElement);
  return button as HTMLButtonElement;
}

function queryContextMenuExportButton(
  container: HTMLElement,
): HTMLButtonElement | null {
  return (
    (Array.from(container.querySelectorAll('button')).find((item) =>
      item.textContent?.includes('导出 Workflow 到文件'),
    ) as HTMLButtonElement | undefined) ?? null
  );
}

function contextMenuFavoriteButton(container: HTMLElement): HTMLButtonElement {
  const button = Array.from(
    container.querySelectorAll('button:not([role="tab"])'),
  ).find(
    (item) =>
      item.textContent?.trim() === '添加到自动化' ||
      item.textContent?.trim() === '从自动化移除',
  );
  expect(button).toBeInstanceOf(HTMLButtonElement);
  return button as HTMLButtonElement;
}

function contextMenuScheduleButton(container: HTMLElement): HTMLButtonElement {
  const button = Array.from(
    container.querySelectorAll('button:not([role="tab"])'),
  ).find((item) => item.textContent?.trim() === '设置定时运行');
  expect(button).toBeInstanceOf(HTMLButtonElement);
  return button as HTMLButtonElement;
}

async function flushAsyncWork(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function waitForNoSearchResults(container: HTMLElement): Promise<void> {
  await vi.waitFor(async () => {
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 20));
    });
    expect(container.textContent).toContain('没有找到匹配的会话');
  });
}

async function changeInputValue(
  input: HTMLInputElement,
  value: string,
): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set;

  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function changeTextAreaValue(
  textarea: HTMLTextAreaElement,
  value: string,
): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    'value',
  )?.set;

  await act(async () => {
    setter?.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function pressInputKey(
  input: HTMLInputElement,
  key: string,
): Promise<void> {
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

afterEach(() => {
  conversationMocks.read.mockReset();
  conversationMocks.copy.mockReset();
  conversationMocks.export.mockReset();
  vi.mocked(openWorkspaceDirectory).mockReset();
  vi.mocked(openWorkspaceDirectory).mockResolvedValue(true);
  window.localStorage.clear();
  document.body.innerHTML = '';
  resetSidebarStore();
});

describe('会话右键复制和导出', () => {
  const messages = [
    { id: 'u', role: 'user', text: '目标问题', createdAt: 1 },
    { id: 'a', role: 'assistant', text: '目标回答', createdAt: 2 },
    { id: 'local', role: 'system', text: '本地提示', createdAt: 3, localOnly: true },
  ];

  it('复制右键会话的内容，不切换当前会话', async () => {
    resetSidebarStore();
    mockState.activeSessionId = 'another-session';
    conversationMocks.read.mockResolvedValue(messages);
    conversationMocks.copy.mockResolvedValue(undefined);
    const view = await renderSidebar();
    try {
      await openSessionContextMenu(sessionButton(view.container, SESSION.title));
      await clickButton(sessionButton(view.container, '复制会话'));
      expect(conversationMocks.read).toHaveBeenCalledWith(WORKSPACE.id, SESSION.id);
      expect(conversationMocks.copy).toHaveBeenCalledWith('## 用户\n\n目标问题\n\n---\n\n## 助手\n\n目标回答');
      expect(mockState.selectSession).not.toHaveBeenCalled();
      expect(view.container.textContent).toContain('已复制会话');
      expect(view.container.textContent).toContain('拷贝会话位置');
    } finally { await view.cleanup(); }
  });

  it('导出右键会话内容并使用对应标题，取消保存不显示成功', async () => {
    resetSidebarStore();
    mockState.activeSessionId = 'another-session';
    conversationMocks.read.mockResolvedValue(messages);
    conversationMocks.export.mockResolvedValue(false);
    const view = await renderSidebar();
    try {
      await openSessionContextMenu(sessionButton(view.container, SESSION.title));
      await clickButton(sessionButton(view.container, '导出会话'));
      expect(conversationMocks.read).toHaveBeenCalledWith(WORKSPACE.id, SESSION.id);
      expect(conversationMocks.export).toHaveBeenCalledWith('## 用户\n\n目标问题\n\n---\n\n## 助手\n\n目标回答', SESSION.title);
      expect(mockState.selectSession).not.toHaveBeenCalled();
      expect(view.container.textContent).not.toContain('会话已导出');
    } finally { await view.cleanup(); }
  });

  it('空会话提示错误，不操作剪贴板', async () => {
    resetSidebarStore();
    conversationMocks.read.mockResolvedValue([{ ...messages[2] }]);
    const view = await renderSidebar();
    try {
      await openSessionContextMenu(sessionButton(view.container, SESSION.title));
      await clickButton(sessionButton(view.container, '复制会话'));
      expect(view.container.textContent).toContain('当前会话为空');
      expect(conversationMocks.copy).not.toHaveBeenCalled();
    } finally { await view.cleanup(); }
  });
});

describe('Sidebar workflow rename', () => {
  async function startRename(container: HTMLElement): Promise<HTMLInputElement> {
    await openSessionContextMenu(sessionButton(container, SESSION.title));
    const renameButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('重命名'),
    );
    expect(renameButton).toBeInstanceOf(HTMLButtonElement);

    await clickButton(renameButton as HTMLButtonElement);

    const input = container.querySelector('input[aria-label="重命名"]');
    expect(input).toBeInstanceOf(HTMLInputElement);
    return input as HTMLInputElement;
  }

  it('shows Rename for chat sessions', async () => {
    resetSidebarStore();
    const chatSession = {
      ...SESSION,
      id: 's_chat',
      title: 'Chat run',
      isWorkflow: false,
    };
    mockState.sessionTree = {
      [WORKSPACE.id]: [chatSession],
    };
    mockState.sessions = [chatSession];

    const view = await renderSidebar();

    try {
      await openSessionContextMenu(sessionButton(view.container, 'Chat run'));

      expect(view.container.textContent).toContain('删除');
      expect(view.container.textContent).toContain('重命名');
      expect(queryContextMenuExportButton(view.container)).toBeNull();
    } finally {
      await view.cleanup();
    }
  });

  it('does not show a session kind badge for chat sessions', async () => {
    resetSidebarStore();
    const chatSession = {
      ...SESSION,
      id: 's_chat',
      title: 'Research chat',
      isWorkflow: false,
    };
    mockState.sessionTree = {
      [WORKSPACE.id]: [chatSession],
    };
    mockState.sessions = [chatSession];
    mockState.activeSessionId = chatSession.id;

    const view = await renderSidebar();

    try {
      const button = sessionButton(view.container, 'Research chat');

      expect(button.textContent).not.toContain('CHAT');
      expect(button.textContent).not.toContain('WF');
    } finally {
      await view.cleanup();
    }
  });

  it('does not show workflow export from session context menus', async () => {
    resetSidebarStore();
    const view = await renderSidebar();

    try {
      await openSessionContextMenu(sessionButton(view.container, SESSION.title));

      expect(queryContextMenuExportButton(view.container)).toBeNull();
      expect(mockState.exportWorkflowSession).not.toHaveBeenCalled();
    } finally {
      await view.cleanup();
    }
  });

  it('opens a workspace folder from the workspace context menu', async () => {
    resetSidebarStore();
    const view = await renderSidebar();

    try {
      await openWorkspaceContextMenu(workspaceButton(view.container, WORKSPACE.name));

      const openButton = Array.from(view.container.querySelectorAll('button')).find(
        (button) => button.textContent?.includes('打开工作区目录'),
      );
      expect(openButton).toBeInstanceOf(HTMLButtonElement);

      await clickButton(openButton as HTMLButtonElement);

      expect(openWorkspaceDirectory).toHaveBeenCalledWith(WORKSPACE.path);
      expect(view.container.textContent).not.toContain('打开工作区目录');
    } finally {
      await view.cleanup();
    }
  });

  it('opens a selected additional workspace folder from the workspace context menu', async () => {
    resetSidebarStore();
    mockState.workspaces = [
      {
        ...WORKSPACE,
        metadata: {
          projectSettings: {
            folders: ['E:\\UnrealEngine', 'E:\\SharedDepot'],
          },
        },
      },
    ];
    const view = await renderSidebar();

    try {
      await openWorkspaceContextMenu(workspaceButton(view.container, WORKSPACE.name));

      const directoryButtons = Array.from(
        view.container.querySelectorAll('button'),
      ).filter((button) =>
        button.textContent?.includes('打开工作区目录'),
      );
      expect(directoryButtons).toHaveLength(3);
      expect(view.container.textContent).toContain(WORKSPACE.path);
      expect(view.container.textContent).toContain('E:\\UnrealEngine');
      expect(view.container.textContent).toContain('E:\\SharedDepot');

      const extraFolderButton = directoryButtons.find(
        (button) =>
          button.getAttribute('aria-label') ===
          '打开工作区目录: E:\\SharedDepot',
      );
      expect(extraFolderButton).toBeInstanceOf(HTMLButtonElement);

      await clickButton(extraFolderButton as HTMLButtonElement);

      expect(openWorkspaceDirectory).toHaveBeenCalledWith('E:\\SharedDepot');
      expect(view.container.textContent).not.toContain('打开工作区目录');
    } finally {
      await view.cleanup();
    }
  });

  it('opens workspace actions from the more button', async () => {
    resetSidebarStore();
    const view = await renderSidebar();

    try {
      await clickButton(workspaceMoreButton(view.container));

      expect(view.container.textContent).toContain('打开工作区目录');
      expect(view.container.textContent).toContain('项目设置');
      expect(view.container.textContent).toContain('从历史中移除');
    } finally {
      await view.cleanup();
    }
  });

  it('shows two workspace folders and collapses additional ones in the workspace row', async () => {
    resetSidebarStore();
    mockState.workspaces = [
      {
        ...WORKSPACE,
        metadata: {
          projectSettings: {
            folders: ['E:\\UnrealEngine', 'E:\\SharedDepot'],
          },
        },
      },
    ];
    const view = await renderSidebar();

    try {
      const button = workspaceButton(view.container, WORKSPACE.name);

      expect(button.textContent).toContain(WORKSPACE.path);
      expect(button.textContent).toContain('E:\\UnrealEngine');
      expect(button.textContent).toContain('...');
      expect(button.textContent).not.toContain('E:\\SharedDepot');
      expect(button.getAttribute('title')).toBe(
        `${WORKSPACE.path}\nE:\\UnrealEngine\nE:\\SharedDepot`,
      );
    } finally {
      await view.cleanup();
    }
  });

  it('does not add an ellipsis when a workspace row has exactly two folders', async () => {
    resetSidebarStore();
    mockState.workspaces = [
      {
        ...WORKSPACE,
        metadata: {
          projectSettings: {
            folders: ['E:\\UnrealEngine'],
          },
        },
      },
    ];
    const view = await renderSidebar();

    try {
      const button = workspaceButton(view.container, WORKSPACE.name);

      expect(button.textContent).toContain(WORKSPACE.path);
      expect(button.textContent).toContain('E:\\UnrealEngine');
      expect(button.textContent).not.toContain('...');
    } finally {
      await view.cleanup();
    }
  });

  it('asks for confirmation before removing a workspace history entry', async () => {
    resetSidebarStore();
    const view = await renderSidebar();

    try {
      await clickButton(workspaceMoreButton(view.container));
      const removeButton = Array.from(
        view.container.querySelectorAll('button'),
      ).find((button) => button.textContent?.includes('从历史中移除'));
      expect(removeButton).toBeInstanceOf(HTMLButtonElement);

      await clickButton(removeButton as HTMLButtonElement);

      expect(mockState.deleteWorkspaceHistory).not.toHaveBeenCalled();
      const dialog = view.container.querySelector('[role="dialog"]');
      expect(dialog).not.toBeNull();
      expect(dialog?.textContent).toContain(
        '不会删除原始项目文件或目录',
      );
      const confirmButton = Array.from(
        view.container.querySelectorAll('button'),
      ).find((button) => button.textContent?.trim() === '移除');
      expect(confirmButton).toBeInstanceOf(HTMLButtonElement);

      await clickButton(confirmButton as HTMLButtonElement);

      expect(mockState.deleteWorkspaceHistory).toHaveBeenCalledWith(
        WORKSPACE.id,
      );
    } finally {
      await view.cleanup();
    }
  });

  it('disables workspace history removal while a workspace session is live', async () => {
    resetSidebarStore();
    mockState.chattingSessions = [SESSION_KEY];
    const view = await renderSidebar();

    try {
      await clickButton(workspaceMoreButton(view.container));
      const removeButton = Array.from(
        view.container.querySelectorAll('button'),
      ).find((button) => button.textContent?.includes('从历史中移除'));
      expect(removeButton).toBeInstanceOf(HTMLButtonElement);

      expect((removeButton as HTMLButtonElement).disabled).toBe(true);
      expect(removeButton).toHaveProperty(
        'title',
        '该工作区有正在运行或编辑的会话，暂不能移除',
      );
    } finally {
      await view.cleanup();
    }
  });

  it('shows a fallback message when the desktop file browser cannot open', async () => {
    resetSidebarStore();
    vi.mocked(openWorkspaceDirectory).mockResolvedValueOnce(false);
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    const view = await renderSidebar();

    try {
      await openWorkspaceContextMenu(workspaceButton(view.container, WORKSPACE.name));
      const openButton = Array.from(view.container.querySelectorAll('button')).find(
        (button) => button.textContent?.includes('打开工作区目录'),
      );
      expect(openButton).toBeInstanceOf(HTMLButtonElement);

      await clickButton(openButton as HTMLButtonElement);
      await act(async () => {
        await Promise.resolve();
      });

      expect(alertSpy).toHaveBeenCalledWith(
        '当前环境不能打开系统文件浏览器。请使用桌面端。',
      );
    } finally {
      alertSpy.mockRestore();
      await view.cleanup();
    }
  });

  it.each([false, true])('toggles pin from the context menu (pinned=%s)', async (pinned) => {
    resetSidebarStore();
    const session = { ...SESSION, pinned };
    mockState.sessions = [session];
    mockState.sessionTree = { [WORKSPACE.id]: [session] };
    const view = await renderSidebar();
    try {
      await openSessionContextMenu(sessionButton(view.container, SESSION.title));
      await clickButton(sessionButton(view.container, pinned ? '取消置顶' : '置顶'));
      expect(mockState.setSessionPinned).toHaveBeenCalledWith(SESSION.id, WORKSPACE.id, !pinned);
      expect(view.container.querySelector('[aria-label="已置顶"]') !== null).toBe(pinned);
    } finally { await view.cleanup(); }
  });

  it.each([true, false])('keeps pinned sessions above live, unread, draft and recent sessions (grouped=%s)', async (grouped) => {
    resetSidebarStore();
    const pinned = { ...SESSION, id: 's_pin', title: '旧置顶', pinned: true, updatedAt: 1 };
    const running = { ...SESSION, id: 's_run', title: '运行会话', updatedAt: 2 };
    const editing = { ...SESSION, id: 's_edit', title: '编辑会话', updatedAt: 3 };
    const unread = { ...SESSION, id: 's_unread', title: '未读完成', runStatus: 'success' as const, unreadCompletion: true, updatedAt: 4 };
    const draft = { ...SESSION, id: 's_draft', title: '草稿会话', updatedAt: 5 };
    const recent = { ...SESSION, id: 's_recent', title: '最新会话', updatedAt: 6 };
    mockState.sessions = [recent, draft, unread, editing, running, pinned];
    mockState.sessionTree = { [WORKSPACE.id]: mockState.sessions };
    mockState.workspaces = grouped ? [{ ...WORKSPACE, sessionCount: 6 }] : [];
    mockState.runningSessions = [{ workspaceId: grouped ? WORKSPACE.id : null, sessionId: running.id }];
    mockState.aiEditingSessions = [{ workspaceId: grouped ? WORKSPACE.id : null, sessionId: editing.id }];
    mockState.composerDrafts = { [`${grouped ? WORKSPACE.id : '__none__'}::${draft.id}`]: '草稿' };
    const view = await renderSidebar();
    try {
      const titles = mockState.sessions.map((session) => session.title);
      expect(sessionTitleOrder(view.container, titles)[0]).toBe(pinned.title);
      mockState.sessions = mockState.sessions.map((session) => ({ ...session, pinned: false }));
      mockState.sessionTree = { [WORKSPACE.id]: mockState.sessions };
      await view.rerender();
      expect(sessionTitleOrder(view.container, titles)[0]).toBe(editing.title);
    } finally { await view.cleanup(); }
  });

  it('promotes a workspace with pinned sessions above selected and running workspaces', async () => {
    resetSidebarStore();
    const pinned = { ...SESSION, id: 's_pin_other', title: '跨工作区置顶', pinned: true, updatedAt: 1 };
    const otherWorkspace = { ...WORKSPACE, id: 'w_pinned_other', name: '置顶工作区', path: 'E:/PinTest', updatedAt: 1 };
    mockState.workspaces = [WORKSPACE, otherWorkspace];
    mockState.sessionTree = { [WORKSPACE.id]: [SESSION], [otherWorkspace.id]: [pinned] };
    mockState.selectedWorkspaceId = WORKSPACE.id;
    mockState.runningSessions = [SESSION_KEY];
    const view = await renderSidebar();
    try {
      expectTextBefore(view.container, pinned.title, SESSION.title);
      await openSessionContextMenu(sessionButton(view.container, pinned.title));
      await clickButton(sessionButton(view.container, '取消置顶'));
      expect(mockState.setSessionPinned).toHaveBeenCalledWith(pinned.id, otherWorkspace.id, false);
    } finally { await view.cleanup(); }
  });

  it('favorites workflow sessions from the context menu', async () => {
    resetSidebarStore();
    const view = await renderSidebar();

    try {
      await openSessionContextMenu(sessionButton(view.container, SESSION.title));

      const favoriteButton = contextMenuFavoriteButton(view.container);
      expect(favoriteButton.textContent).toContain('添加到自动化');

      await clickButton(favoriteButton);

      expect(mockState.setWorkflowFavoriteSession).toHaveBeenCalledWith(
        SESSION.id,
        WORKSPACE.id,
        true,
      );
    } finally {
      await view.cleanup();
    }
  });

  it('unfavorites already favorited workflow sessions from the context menu', async () => {
    resetSidebarStore();
    const favoriteSession = {
      ...SESSION,
      favorite: true,
    };
    mockState.sessionTree = {
      [WORKSPACE.id]: [favoriteSession],
    };
    mockState.sessions = [favoriteSession];

    const view = await renderSidebar();

    try {
      await openSessionContextMenu(sessionButton(view.container, SESSION.title));

      const favoriteButton = contextMenuFavoriteButton(view.container);
      expect(favoriteButton.textContent).toContain('从自动化移除');

      await clickButton(favoriteButton);

      expect(mockState.setWorkflowFavoriteSession).toHaveBeenCalledWith(
        SESSION.id,
        WORKSPACE.id,
        false,
      );
    } finally {
      await view.cleanup();
    }
  });

  it('configures a scheduled task for favorite sessions from the context menu', async () => {
    resetSidebarStore();
    const favoriteSession = {
      ...SESSION,
      favorite: true,
    };
    mockState.sessionTree = {
      [WORKSPACE.id]: [favoriteSession],
    };
    mockState.sessions = [favoriteSession];

    const view = await renderSidebar();

    try {
      await openSessionContextMenu(sessionButton(view.container, SESSION.title));
      await clickButton(contextMenuScheduleButton(view.container));

      expect(view.container.textContent).toContain('自动化定时运行');
      const textarea = view.container.querySelector('textarea');
      expect(textarea).toBeInstanceOf(HTMLTextAreaElement);
      await changeTextAreaValue(
        textarea as HTMLTextAreaElement,
        '每周五10点执行写周报任务',
      );

      const saveButton = Array.from(view.container.querySelectorAll('button')).find(
        (button) => button.textContent?.trim() === '保存',
      );
      expect(saveButton).toBeInstanceOf(HTMLButtonElement);
      await clickButton(saveButton as HTMLButtonElement);
      await flushAsyncWork();

      expect(mockState.setWorkflowScheduledTaskSession).toHaveBeenCalledWith(
        SESSION.id,
        WORKSPACE.id,
        expect.objectContaining({
          enabled: true,
          reminderText: '每周五10点执行写周报任务',
          weekdays: [1, 2, 3, 4, 5, 6, 0],
          repeat: true,
          remindOnRun: true,
        }),
      );
    } finally {
      await view.cleanup();
    }
  });

  it('favorites chat sessions from the context menu', async () => {
    resetSidebarStore();
    const chatSession = {
      ...SESSION,
      id: 's_chat',
      title: 'Research chat',
      isWorkflow: false,
    };
    mockState.sessionTree = {
      [WORKSPACE.id]: [chatSession],
    };
    mockState.sessions = [chatSession];

    const view = await renderSidebar();

    try {
      await openSessionContextMenu(sessionButton(view.container, 'Research chat'));

      const favoriteButton = contextMenuFavoriteButton(view.container);
      expect(favoriteButton.textContent).toContain('添加到自动化');

      await clickButton(favoriteButton);

      expect(mockState.setWorkflowFavoriteSession).toHaveBeenCalledWith(
        chatSession.id,
        WORKSPACE.id,
        true,
      );
    } finally {
      await view.cleanup();
    }
  });

  it('shows all history sessions directly without history or automation tabs', async () => {
    resetSidebarStore();
    const favoriteSession = {
      ...SESSION,
      favorite: true,
      title: 'Favorite Workflow',
    };
    const plainWorkflow = {
      ...SESSION,
      id: 's_plain',
      title: 'Plain Workflow',
    };
    const favoriteChat = {
      ...SESSION,
      id: 's_chat',
      title: 'Favorite Chat',
      isWorkflow: false,
      favorite: true,
    };
    mockState.sessionTree = {
      [WORKSPACE.id]: [favoriteSession, plainWorkflow, favoriteChat],
    };
    mockState.sessions = [favoriteSession, plainWorkflow, favoriteChat];
    mockState.workspaces = [{ ...WORKSPACE, sessionCount: 3 }];

    const view = await renderSidebar();

    try {
      expect(view.container.querySelector('[role="tablist"]')).toBeNull();
      expect(view.container.querySelector('[role="tab"]')).toBeNull();

      expect(view.container.textContent).toContain('Favorite Workflow');
      expect(view.container.textContent).toContain('Plain Workflow');
      expect(view.container.textContent).toContain('Favorite Chat');
    } finally {
      await view.cleanup();
    }
  });

  it('hides workflow export for simple workflow chat sessions', async () => {
    resetSidebarStore();
    const simpleSession = {
      ...SESSION,
      id: 's_simple',
      title: 'Simple chat',
      simple: true,
    };
    mockState.sessionTree = {
      [WORKSPACE.id]: [simpleSession],
    };
    mockState.sessions = [simpleSession];
    mockState.activeSessionId = simpleSession.id;

    const view = await renderSidebar();

    try {
      await openSessionContextMenu(sessionButton(view.container, 'Simple chat'));

      expect(view.container.textContent).toContain('删除');
      expect(queryContextMenuExportButton(view.container)).toBeNull();
      expect(mockState.exportWorkflowSession).not.toHaveBeenCalled();
    } finally {
      await view.cleanup();
    }
  });

  it('saves a trimmed workflow name from the context menu', async () => {
    resetSidebarStore();
    const view = await renderSidebar();

    try {
      const input = await startRename(view.container);
      await changeInputValue(input, '  Renamed Workflow  ');

      const saveButton = Array.from(view.container.querySelectorAll('button')).find(
        (button) => button.textContent?.trim() === '保存',
      );
      expect(saveButton).toBeInstanceOf(HTMLButtonElement);

      await clickButton(saveButton as HTMLButtonElement);
      await flushAsyncWork();

      expect(mockState.renameWorkflowSession).toHaveBeenCalledWith(
        SESSION.id,
        WORKSPACE.id,
        'Renamed Workflow',
      );
      expect(
        view.container.querySelector('input[aria-label="重命名"]'),
      ).toBeNull();
    } finally {
      await view.cleanup();
    }
  });

  it('selects the current session name when rename starts', async () => {
    resetSidebarStore();
    const view = await renderSidebar();

    try {
      const input = await startRename(view.container);

      expect(input.value).toBe(SESSION.title);
      expect(input.selectionStart).toBe(0);
      expect(input.selectionEnd).toBe(SESSION.title.length);
    } finally {
      await view.cleanup();
    }
  });

  it('saves a trimmed chat session name from the context menu', async () => {
    resetSidebarStore();
    const chatSession = {
      ...SESSION,
      id: 's_chat',
      title: 'Research chat',
      isWorkflow: false,
    };
    mockState.sessionTree = {
      [WORKSPACE.id]: [chatSession],
    };
    mockState.sessions = [chatSession];
    mockState.activeSessionId = chatSession.id;

    const view = await renderSidebar();

    try {
      await openSessionContextMenu(sessionButton(view.container, 'Research chat'));
      const renameButton = Array.from(
        view.container.querySelectorAll('button'),
      ).find((button) => button.textContent?.includes('重命名'));
      expect(renameButton).toBeInstanceOf(HTMLButtonElement);

      await clickButton(renameButton as HTMLButtonElement);

      const input = view.container.querySelector('input[aria-label="重命名"]');
      expect(input).toBeInstanceOf(HTMLInputElement);
      await changeInputValue(input as HTMLInputElement, '  Renamed Chat  ');

      const saveButton = Array.from(view.container.querySelectorAll('button')).find(
        (button) => button.textContent?.trim() === '保存',
      );
      expect(saveButton).toBeInstanceOf(HTMLButtonElement);

      await clickButton(saveButton as HTMLButtonElement);
      await flushAsyncWork();

      expect(mockState.renameWorkflowSession).toHaveBeenCalledWith(
        chatSession.id,
        WORKSPACE.id,
        'Renamed Chat',
      );
    } finally {
      await view.cleanup();
    }
  });

  it('cancels rename without saving the draft', async () => {
    resetSidebarStore();
    const view = await renderSidebar();

    try {
      const input = await startRename(view.container);
      await changeInputValue(input, 'Draft Name');

      const cancelButton = Array.from(view.container.querySelectorAll('button')).find(
        (button) => button.textContent?.trim() === '取消',
      );
      expect(cancelButton).toBeInstanceOf(HTMLButtonElement);

      await clickButton(cancelButton as HTMLButtonElement);

      expect(mockState.renameWorkflowSession).not.toHaveBeenCalled();
      expect(view.container.textContent).toContain(SESSION.title);
      expect(
        view.container.querySelector('input[aria-label="重命名"]'),
      ).toBeNull();
    } finally {
      await view.cleanup();
    }
  });

  it('clears inline rename state when the same session is deleted from the context menu', async () => {
    resetSidebarStore();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const view = await renderSidebar();

    try {
      const input = await startRename(view.container);
      await changeInputValue(input, 'Draft Name');

      const renameRow = input.closest('div');
      expect(renameRow).toBeInstanceOf(HTMLDivElement);
      await act(async () => {
        renameRow?.dispatchEvent(
          new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: 120,
            clientY: 140,
          }),
        );
      });

      await clickButton(contextMenuDeleteButton(view.container));

      expect(mockState.deleteSession).toHaveBeenCalledWith(
        SESSION.id,
        WORKSPACE.id,
      );
      expect(
        view.container.querySelector('input[aria-label="重命名"]'),
      ).toBeNull();
      expect(view.container.textContent).toContain(SESSION.title);
    } finally {
      confirmSpy.mockRestore();
      await view.cleanup();
    }
  });

  it('rejects an empty workflow name', async () => {
    resetSidebarStore();
    const view = await renderSidebar();

    try {
      const input = await startRename(view.container);
      await changeInputValue(input, '   ');
      await pressInputKey(input, 'Enter');

      expect(view.container.textContent).toContain('名称不能为空');
      expect(mockState.renameWorkflowSession).not.toHaveBeenCalled();
      expect(
        view.container.querySelector('input[aria-label="重命名"]'),
      ).toBe(input);
    } finally {
      await view.cleanup();
    }
  });

  it('rejects duplicate session names in the same workspace list', async () => {
    resetSidebarStore();
    const existingSession = {
      ...SESSION,
      id: 's_existing',
      title: 'Existing Workflow',
    };
    mockState.sessionTree = {
      [WORKSPACE.id]: [SESSION, existingSession],
    };
    mockState.sessions = [SESSION, existingSession];
    mockState.workspaces = [{ ...WORKSPACE, sessionCount: 2 }];

    const view = await renderSidebar();

    try {
      const input = await startRename(view.container);
      await changeInputValue(input, 'Existing Workflow');
      await pressInputKey(input, 'Enter');

      expect(view.container.textContent).toContain(
        '同一历史列表中已存在同名会话',
      );
      expect(mockState.renameWorkflowSession).not.toHaveBeenCalled();
    } finally {
      await view.cleanup();
    }
  });
});

describe('Sidebar running progress indicator', () => {
  it('keeps the blue activity indicator and border live while real progress changes', async () => {
    resetSidebarStore();
    mockState.runningSessions = [SESSION_KEY];
    mockState.runningSessionProgress = {
      [WORKSPACE.id + '::' + SESSION.id]: {
        completed: 0,
        incomplete: 2,
        percent: 0,
      },
    };

    const view = await renderSidebar();

    try {
      const zeroDot = runningDot(view.container, 0);
      expect(zeroDot).not.toBeNull();
      const zeroSpinner = statusIndicator(zeroDot);
      expect(zeroSpinner).not.toBeNull();
      expect(zeroSpinner?.classList.contains('ugs-status-spinner')).toBe(false);
      expect(zeroSpinner?.querySelector('.lucide-loader-circle')).not.toBeNull();
      expect(sessionButton(view.container, SESSION.title).classList.contains('ugs-sidebar-session--live')).toBe(true);
      expect(zeroSpinner?.style.getPropertyValue('--ugs-status-color')).toBe(
        'var(--status-ai-edit)',
      );

      mockState.runningSessionProgress = {
        [WORKSPACE.id + '::' + SESSION.id]: {
          completed: 2,
          incomplete: 0,
          percent: 100,
        },
      };
      await view.rerender();

      const completeDot = runningDot(view.container, 100);
      expect(completeDot).not.toBeNull();
      expect(completeDot?.getAttribute('title')).toBe('正在运行，进度 100%');
      const completeSpinner = statusIndicator(completeDot);
      expect(completeSpinner).not.toBeNull();
      expect(completeSpinner?.classList.contains('ugs-status-spinner')).toBe(false);
      expect(completeSpinner?.style.getPropertyValue('--ugs-status-color')).toBe(
        'var(--status-ai-edit)',
      );
      expect(statusDot(view.container, 'success')).toBeNull();
    } finally {
      await view.cleanup();
    }
  });

  it('renders unrun workflow sessions as a quiet hollow circle', async () => {
    resetSidebarStore();
    const view = await renderSidebar();

    try {
      const dot = statusDot(view.container, 'unrun');
      expect(dot).not.toBeNull();
      expect(dot?.getAttribute('title')).toBe('未运行');
      const indicator = statusIndicator(dot);
      expect(indicator).not.toBeNull();
      expect(indicator?.classList.contains('ugs-status-spinner')).toBe(false);
      expect(indicator?.querySelector('.lucide-circle')).not.toBeNull();
      expect(indicator?.style.getPropertyValue('--ugs-status-color')).toBe(
        'var(--fg-faint)',
      );
    } finally {
      await view.cleanup();
    }
  });

  it('renders a session with an unsent draft as a static pencil', async () => {
    resetSidebarStore();
    // Idle session (not the active one) that still holds composer text.
    mockState.activeSessionId = null;
    mockState.composerDrafts = {
      [`${WORKSPACE.id}::${SESSION.id}`]: 'unsent text',
    };

    const view = await renderSidebar();

    try {
      const dot = statusDot(view.container, 'draft');
      expect(dot).not.toBeNull();
      expect(dot?.getAttribute('title')).toBe('有未发送草稿');
      const indicator = statusIndicator(dot);
      expect(indicator).not.toBeNull();
      // Draft is a static marker, never a spinner.
      expect(indicator?.classList.contains('ugs-status-spinner')).toBe(false);
      expect(indicator?.querySelector('.lucide-pencil')).not.toBeNull();
      expect(indicator?.style.getPropertyValue('--ugs-status-color')).toBe(
        'var(--status-draft)',
      );
    } finally {
      await view.cleanup();
    }
  });

  it('keeps the live running treatment over a draft when a session is both', async () => {
    resetSidebarStore();
    // Active session that is running AND has live composer text: running wins.
    mockState.composerDraft = 'unsent text';
    mockState.runningSessions = [SESSION_KEY];

    const view = await renderSidebar();

    try {
      expect(statusDot(view.container, 'draft')).toBeNull();
      const dot = statusDot(view.container, 'running');
      expect(dot).not.toBeNull();
      const indicator = statusIndicator(dot);
      expect(indicator?.classList.contains('ugs-status-spinner')).toBe(false);
      expect(sessionButton(view.container, SESSION.title).classList.contains('ugs-sidebar-session--live')).toBe(true);
    } finally {
      await view.cleanup();
    }
  });

  it('reserves a fixed status slot when a chat session has no status', async () => {
    resetSidebarStore();
    mockState.sessionTree = {
      [WORKSPACE.id]: [{ ...SESSION, isWorkflow: false }],
    };
    mockState.sessions = [{ ...SESSION, isWorkflow: false }];

    const view = await renderSidebar();

    try {
      const button = Array.from(view.container.querySelectorAll('button')).find(
        (item) => item.textContent?.includes(SESSION.title),
      );
      expect(button).toBeInstanceOf(HTMLButtonElement);
      const emptySlot = (button as HTMLButtonElement).querySelector(
        '[data-status="none"]',
      );
      expect(emptySlot).not.toBeNull();
      expect(emptySlot?.classList.contains('ugs-status-slot')).toBe(true);
      expect(statusIndicator(emptySlot as HTMLElement)).toBeNull();
    } finally {
      await view.cleanup();
    }
  });

  it('renders an in-flight chat session with the same blue activity treatment', async () => {
    resetSidebarStore();
    const chatSession = { ...SESSION, isWorkflow: false };
    mockState.sessionTree = {
      [WORKSPACE.id]: [chatSession],
    };
    mockState.sessions = [chatSession];
    mockState.chattingSessions = [SESSION_KEY];

    const view = await renderSidebar();

    try {
      const dot = statusDot(view.container, 'running');
      expect(dot).not.toBeNull();
      expect(dot?.getAttribute('title')).toBe('正在运行，进度未知');
      const indicator = statusIndicator(dot);
      expect(indicator).not.toBeNull();
      expect(indicator?.classList.contains('ugs-status-spinner')).toBe(false);
      expect(indicator?.querySelector('.lucide-loader-circle')).not.toBeNull();
      expect(indicator?.style.getPropertyValue('--ugs-status-color')).toBe(
        'var(--status-ai-edit)',
      );
      expect(statusDot(view.container, 'thinking')).toBeNull();
    } finally {
      await view.cleanup();
    }
  });

  it.each([
    ['success', 'success', '已完成', 'var(--status-success)'],
    ['error', 'failed', '已失败', 'var(--status-error)'],
    ['interrupted', 'interrupted', '已中断', 'var(--fg-dim)'],
  ] as const)(
    'renders the %s terminal status indicator',
    async (status, tone, label, color) => {
      resetSidebarStore();
      mockState.sessionTree = {
        [WORKSPACE.id]: [{ ...SESSION, runStatus: status }],
      };
      mockState.sessions = [{ ...SESSION, runStatus: status }];

      const view = await renderSidebar();

      try {
        const dot = statusDot(view.container, tone);
        expect(dot).not.toBeNull();
        expect(dot?.getAttribute('title')).toBe(label);
        const indicator = statusIndicator(dot);
        expect(indicator).not.toBeNull();
        expect(indicator?.classList.contains('ugs-status-spinner')).toBe(false);
        expect(indicator?.style.getPropertyValue('--ugs-status-color')).toBe(
          color,
        );
      } finally {
        await view.cleanup();
      }
    },
  );

  it.each([
    ['success', 'success', '已完成', 'var(--status-success)'],
    ['error', 'failed', '已失败', 'var(--status-error)'],
  ] as const)(
    'renders a chat session with %s as the terminal status indicator',
    async (status, tone, label, color) => {
      resetSidebarStore();
      const chatSession = { ...SESSION, isWorkflow: false, runStatus: status };
      mockState.sessionTree = {
        [WORKSPACE.id]: [chatSession],
      };
      mockState.sessions = [chatSession];

      const view = await renderSidebar();

      try {
        const dot = statusDot(view.container, tone);
        expect(dot).not.toBeNull();
        expect(dot?.getAttribute('title')).toBe(label);
        const indicator = statusIndicator(dot);
        expect(indicator).not.toBeNull();
        expect(indicator?.classList.contains('ugs-status-spinner')).toBe(false);
        expect(indicator?.style.getPropertyValue('--ugs-status-color')).toBe(
          color,
        );
      } finally {
        await view.cleanup();
      }
    },
  );

  it('keeps the new session action enabled while the active session is running', async () => {
    resetSidebarStore();
    mockState.mode = 'running';
    mockState.runningSessions = [SESSION_KEY];

    const view = await renderSidebar();

    try {
      const button = newSessionButton(view.container);
      expect(button.disabled).toBe(false);

      await act(async () => {
        button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(mockState.newSession).toHaveBeenCalledTimes(1);
    } finally {
      await view.cleanup();
    }
  });

  it('keeps the new session action enabled during an active AI edit', async () => {
    resetSidebarStore();
    mockState.aiEditingSessions = [SESSION_KEY];

    const view = await renderSidebar();

    try {
      const button = newSessionButton(view.container);
      expect(button.disabled).toBe(false);

      await act(async () => {
        button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(mockState.newSession).toHaveBeenCalledTimes(1);
    } finally {
      await view.cleanup();
    }
  });

  it('creates a chat session from the secondary top action', async () => {
    resetSidebarStore();

    const view = await renderSidebar();

    try {
      const button = newSessionButton(view.container);

      await act(async () => {
        button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(mockState.newSession).toHaveBeenCalledTimes(1);
    } finally {
      await view.cleanup();
    }
  });

  it('renders a static blue thinking icon with a live border', async () => {
    resetSidebarStore();
    mockState.aiEditingSessions = [SESSION_KEY];

    const view = await renderSidebar();

    try {
      const dot = statusDot(view.container, 'thinking');
      expect(dot).not.toBeNull();
      expect(dot?.getAttribute('title')).toBe('AI 思考中');
      const indicator = statusIndicator(dot);
      expect(indicator).not.toBeNull();
      expect(indicator?.classList.contains('ugs-status-spinner')).toBe(false);
      expect(indicator?.querySelector('.lucide-sparkles')).not.toBeNull();
      expect(sessionButton(view.container, SESSION.title).classList.contains('ugs-sidebar-session--live')).toBe(true);
      expect(indicator?.style.getPropertyValue('--ugs-status-color')).toBe(
        'var(--status-ai-edit)',
      );
    } finally {
      await view.cleanup();
    }
  });
});

describe('Sidebar delete protection', () => {
  it.each([
    ['running', '运行中的会话不能删除'],
    ['aiEditing', 'AI 正在处理，暂不能删除'],
  ] as const)(
    'disables deleting protected %s sessions',
    async (reason, label) => {
      resetSidebarStore();
      if (reason === 'running') {
        mockState.runningSessions = [SESSION_KEY];
      } else {
        mockState.aiEditingSessions = [SESSION_KEY];
      }

      const view = await renderSidebar();

      try {
        await openSessionContextMenu(
          sessionButton(view.container, SESSION.title),
        );

        const deleteButton = contextMenuDeleteButton(view.container);
        expect(deleteButton.disabled).toBe(true);
        expect(deleteButton.getAttribute('title')).toBe(label);
      } finally {
        await view.cleanup();
      }
    },
  );

  it.each([
    ['running', '运行中的会话不能删除'],
    ['aiEditing', 'AI 正在处理，暂不能删除'],
  ] as const)(
    'rechecks %s protection when delete is clicked from a stale menu',
    async (reason, label) => {
      resetSidebarStore();
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      const alertSpy = vi
        .spyOn(window, 'alert')
        .mockImplementation(() => undefined);
      const view = await renderSidebar();

      try {
        await openSessionContextMenu(
          sessionButton(view.container, SESSION.title),
        );

        const deleteButton = contextMenuDeleteButton(view.container);
        expect(deleteButton.disabled).toBe(false);

        if (reason === 'running') {
          mockState.runningSessions = [SESSION_KEY];
        } else {
          mockState.aiEditingSessions = [SESSION_KEY];
        }
        await clickButton(deleteButton);

        expect(alertSpy).toHaveBeenCalledWith(label);
        expect(confirmSpy).not.toHaveBeenCalled();
        expect(mockState.deleteSession).not.toHaveBeenCalled();
      } finally {
        confirmSpy.mockRestore();
        alertSpy.mockRestore();
        await view.cleanup();
      }
    },
  );
});

describe('Sidebar live session ordering', () => {
  it('orders running and AI-editing workspace sessions by timestamp within the live tier', async () => {
    resetSidebarStore();
    const runningSession = {
      ...SESSION,
      id: 's_running_old',
      title: 'Running old',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    };
    const thinkingSession = {
      ...SESSION,
      id: 's_thinking_mid',
      title: 'Thinking mid',
      createdAt: 1_700_000_100_000,
      updatedAt: 1_700_000_100_000,
    };
    const recentSession = {
      ...SESSION,
      id: 's_recent_idle',
      title: 'Recent idle',
      createdAt: 1_700_000_200_000,
      updatedAt: 1_700_000_200_000,
    };
    const titles = [
      thinkingSession.title,
      runningSession.title,
      recentSession.title,
    ];
    mockState.sessionTree = {
      [WORKSPACE.id]: [recentSession, thinkingSession, runningSession],
    };
    mockState.sessions = [recentSession, thinkingSession, runningSession];
    mockState.workspaces = [{ ...WORKSPACE, sessionCount: 3 }];
    mockState.runningSessions = [
      { workspaceId: WORKSPACE.id, sessionId: runningSession.id },
    ];
    mockState.aiEditingSessions = [
      { workspaceId: WORKSPACE.id, sessionId: thinkingSession.id },
    ];

    const view = await renderSidebar();

    try {
      expect(sessionTitleOrder(view.container, titles)).toEqual(titles);
    } finally {
      await view.cleanup();
    }
  });

  it('does not promote an active completed workspace session above newer completed sessions', async () => {
    resetSidebarStore();
    const activeSession = {
      ...SESSION,
      id: 's_active_old',
      title: 'Active old',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    };
    const recentSession = {
      ...SESSION,
      id: 's_recent_done',
      title: 'Recent done',
      createdAt: 1_700_000_200_000,
      updatedAt: 1_700_000_200_000,
    };
    const titles = [recentSession.title, activeSession.title];
    mockState.sessionTree = {
      [WORKSPACE.id]: [recentSession, activeSession],
    };
    mockState.sessions = [recentSession, activeSession];
    mockState.workspaces = [{ ...WORKSPACE, sessionCount: 2 }];
    mockState.activeWorkspaceId = WORKSPACE.id;
    mockState.activeSessionId = activeSession.id;

    const view = await renderSidebar();

    try {
      expect(sessionTitleOrder(view.container, titles)).toEqual(titles);
    } finally {
      await view.cleanup();
    }
  });

  it('promotes workspace groups with live sessions and keeps groups together', async () => {
    resetSidebarStore();
    const liveWorkspace = {
      ...WORKSPACE,
      id: 'ws_live',
      name: 'Live Workspace',
      path: 'E:\\LiveWorkspace',
      updatedAt: 1_700_000_000_000,
      sessionCount: 1,
      lastActiveSessionId: 's_live_old',
    };
    const recentWorkspace = {
      ...WORKSPACE,
      id: 'ws_recent',
      name: 'Recent Workspace',
      path: 'E:\\RecentWorkspace',
      updatedAt: 1_700_000_300_000,
      sessionCount: 1,
      lastActiveSessionId: 's_recent_new',
    };
    const liveSession = {
      ...SESSION,
      id: 's_live_old',
      title: 'Running build',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    };
    const recentSession = {
      ...SESSION,
      id: 's_recent_new',
      title: 'Recent build',
      createdAt: 1_700_000_300_000,
      updatedAt: 1_700_000_300_000,
    };
    mockState.workspaces = [recentWorkspace, liveWorkspace];
    mockState.sessionTree = {
      [recentWorkspace.id]: [recentSession],
      [liveWorkspace.id]: [liveSession],
    };
    mockState.sessions = [recentSession, liveSession];
    mockState.activeWorkspaceId = liveWorkspace.id;
    mockState.activeSessionId = liveSession.id;
    mockState.runningSessions = [
      { workspaceId: liveWorkspace.id, sessionId: liveSession.id },
    ];

    const view = await renderSidebar();

    try {
      expectTextBefore(view.container, liveWorkspace.name, recentWorkspace.name);
      expectTextBefore(view.container, liveWorkspace.name, liveSession.title);
      expectTextBefore(view.container, liveSession.title, recentWorkspace.name);
      expectTextBefore(view.container, recentWorkspace.name, recentSession.title);
    } finally {
      await view.cleanup();
    }
  });

  it('pins the selected workspace group above newer idle groups', async () => {
    resetSidebarStore();
    const selectedOlderWorkspace = {
      ...WORKSPACE,
      id: 'ws_selected_older',
      name: 'Selected Older Workspace',
      path: 'E:\\SelectedOlderWorkspace',
      updatedAt: 1_700_000_300_000,
      sessionCount: 1,
      lastActiveSessionId: 's_selected_older',
    };
    const newerWorkspace = {
      ...WORKSPACE,
      id: 'ws_newer',
      name: 'Newer Workspace',
      path: 'E:\\NewerWorkspace',
      updatedAt: 1_700_000_100_000,
      sessionCount: 1,
      lastActiveSessionId: 's_newer',
    };
    const selectedOlderSession = {
      ...SESSION,
      id: 's_selected_older',
      title: 'Selected older session',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    };
    const newerSession = {
      ...SESSION,
      id: 's_newer',
      title: 'Newer session',
      createdAt: 1_700_000_200_000,
      updatedAt: 1_700_000_200_000,
    };
    mockState.workspaces = [selectedOlderWorkspace, newerWorkspace];
    mockState.sessionTree = {
      [selectedOlderWorkspace.id]: [selectedOlderSession],
      [newerWorkspace.id]: [newerSession],
    };
    mockState.sessions = [selectedOlderSession, newerSession];
    mockState.activeWorkspaceId = newerWorkspace.id;
    mockState.selectedWorkspaceId = selectedOlderWorkspace.id;
    mockState.activeSessionId = newerSession.id;

    const view = await renderSidebar();

    try {
      expect(
        sessionTitleOrder(view.container, [
          selectedOlderSession.title,
          newerSession.title,
        ]),
      ).toEqual([selectedOlderSession.title, newerSession.title]);
    } finally {
      await view.cleanup();
    }
  });

  it('orders flat fallback running and AI-editing sessions by timestamp within the live tier', async () => {
    resetSidebarStore();
    const runningSession = {
      ...SESSION,
      id: 's_flat_running_old',
      title: 'Flat running old',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    };
    const thinkingSession = {
      ...SESSION,
      id: 's_flat_thinking_mid',
      title: 'Flat thinking mid',
      createdAt: 1_700_000_100_000,
      updatedAt: 1_700_000_100_000,
    };
    const recentSession = {
      ...SESSION,
      id: 's_flat_recent_idle',
      title: 'Flat recent idle',
      createdAt: 1_700_000_200_000,
      updatedAt: 1_700_000_200_000,
    };
    const titles = [
      thinkingSession.title,
      runningSession.title,
      recentSession.title,
    ];
    mockState.workspaces = [];
    mockState.sessionTree = {};
    mockState.sessions = [recentSession, thinkingSession, runningSession];
    mockState.activeWorkspaceId = null;
    mockState.activeSessionId = null;
    mockState.runningSessions = [
      { workspaceId: null, sessionId: runningSession.id },
    ];
    mockState.aiEditingSessions = [
      { workspaceId: null, sessionId: thinkingSession.id },
    ];

    const view = await renderSidebar();

    try {
      expect(sessionTitleOrder(view.container, titles)).toEqual(titles);
    } finally {
      await view.cleanup();
    }
  });

  it('promotes sessions with an unsent composer draft above idle ones', async () => {
    resetSidebarStore();
    const draftSession = {
      ...SESSION,
      id: 's_draft_old',
      title: 'Drafted old',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    };
    const recentSession = {
      ...SESSION,
      id: 's_recent_idle',
      title: 'Recent idle',
      createdAt: 1_700_000_200_000,
      updatedAt: 1_700_000_200_000,
    };
    // Drafted (older) should float above the more recent idle session.
    const titles = [draftSession.title, recentSession.title];
    mockState.sessionTree = {
      [WORKSPACE.id]: [recentSession, draftSession],
    };
    mockState.sessions = [recentSession, draftSession];
    mockState.workspaces = [{ ...WORKSPACE, sessionCount: 2 }];
    mockState.activeSessionId = null;
    mockState.composerDrafts = {
      [`${WORKSPACE.id}::${draftSession.id}`]: 'unsent text',
    };

    const view = await renderSidebar();

    try {
      expect(sessionTitleOrder(view.container, titles)).toEqual(titles);
    } finally {
      await view.cleanup();
    }
  });

  it('promotes the active session only when its live composer has text', async () => {
    resetSidebarStore();
    const activeDraftSession = {
      ...SESSION,
      id: 's_active_draft_old',
      title: 'Active draft old',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    };
    const recentSession = {
      ...SESSION,
      id: 's_recent_idle',
      title: 'Recent idle',
      createdAt: 1_700_000_200_000,
      updatedAt: 1_700_000_200_000,
    };
    const titles = [activeDraftSession.title, recentSession.title];
    mockState.sessionTree = {
      [WORKSPACE.id]: [recentSession, activeDraftSession],
    };
    mockState.sessions = [recentSession, activeDraftSession];
    mockState.workspaces = [{ ...WORKSPACE, sessionCount: 2 }];
    mockState.activeWorkspaceId = WORKSPACE.id;
    mockState.activeSessionId = activeDraftSession.id;
    mockState.composerDraft = 'unsent text';

    const view = await renderSidebar();

    try {
      expect(sessionTitleOrder(view.container, titles)).toEqual(titles);
    } finally {
      await view.cleanup();
    }
  });

  it('keeps running sessions above drafted-but-idle ones', async () => {
    resetSidebarStore();
    const runningSession = {
      ...SESSION,
      id: 's_running_old',
      title: 'Running old',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    };
    const draftSession = {
      ...SESSION,
      id: 's_draft_new',
      title: 'Drafted new',
      createdAt: 1_700_000_200_000,
      updatedAt: 1_700_000_200_000,
    };
    // Running outranks a draft even though the draft is more recent.
    const titles = [runningSession.title, draftSession.title];
    mockState.sessionTree = {
      [WORKSPACE.id]: [draftSession, runningSession],
    };
    mockState.sessions = [draftSession, runningSession];
    mockState.workspaces = [{ ...WORKSPACE, sessionCount: 2 }];
    mockState.activeSessionId = runningSession.id;
    mockState.runningSessions = [
      { workspaceId: WORKSPACE.id, sessionId: runningSession.id },
    ];
    mockState.composerDrafts = {
      [`${WORKSPACE.id}::${draftSession.id}`]: 'unsent text',
    };

    const view = await renderSidebar();

    try {
      expect(sessionTitleOrder(view.container, titles)).toEqual(titles);
    } finally {
      await view.cleanup();
    }
  });
});

describe('Sidebar session search', () => {
  it('renders an enabled search field after history is ready', async () => {
    resetSidebarStore();
    const view = await renderSidebar();

    try {
      const input = historySearchInput(view.container);
      expect(input.disabled).toBe(false);
      expect(input.placeholder).toBe('搜索会话');
    } finally {
      await view.cleanup();
    }
  });

  it('shows an empty history state without rendering the search field', async () => {
    resetSidebarStore();
    mockState.sessions = [];
    mockState.workspaces = [];
    mockState.sessionTree = {};
    mockState.activeWorkspaceId = null;
    mockState.activeSessionId = null;

    const view = await renderSidebar();

    try {
      expect(
        view.container.querySelector('input[aria-label="搜索会话"]'),
      ).toBeNull();
      expect(view.container.textContent).toContain('暂无会话');
      expect(view.container.textContent).toContain('新建会话');
    } finally {
      await view.cleanup();
    }
  });

  it('shows the history empty state without tabs when there are no sessions', async () => {
    resetSidebarStore();
    mockState.sessions = [];
    mockState.workspaces = [];
    mockState.sessionTree = {};
    mockState.activeWorkspaceId = null;
    mockState.activeSessionId = null;

    const view = await renderSidebar();

    try {
      expect(view.container.querySelector('[role="tablist"]')).toBeNull();
      expect(view.container.querySelector('[role="tab"]')).toBeNull();

      expect(queryHistorySearchInput(view.container)).toBeNull();
      expect(view.container.textContent).toContain('暂无会话');
    } finally {
      await view.cleanup();
    }
  });

  it('shows a loading state before history is ready', async () => {
    resetSidebarStore();
    mockState.historyReady = false;
    mockState.workspaces = [];
    mockState.sessionTree = {};
    mockState.sessions = [];

    const view = await renderSidebar();

    try {
      const input = historySearchInput(view.container);
      expect(input.disabled).toBe(true);
      expect(input.placeholder).toBe('加载历史记录…');
      expect(view.container.textContent).toContain('加载历史记录…');
      expect(view.container.textContent).not.toContain('暂无会话');
    } finally {
      await view.cleanup();
    }
  });

  it('shows an empty history state without search when history is ready and empty', async () => {
    resetSidebarStore();
    mockState.workspaces = [{ ...WORKSPACE, sessionCount: 0 }];
    mockState.sessionTree = { [WORKSPACE.id]: [] };
    mockState.sessions = [];
    mockState.activeSessionId = null;

    const view = await renderSidebar();

    try {
      expect(queryHistorySearchInput(view.container)).toBeNull();
      expect(view.container.textContent).toContain('暂无会话');
    } finally {
      await view.cleanup();
    }
  });

  it('filters sessions by title with trimmed case-insensitive input', async () => {
    resetSidebarStore();
    const deploySession = {
      ...SESSION,
      id: 's_deploy',
      title: 'Deploy Pipeline',
      preview: 'release notes',
    };
    mockState.sessionTree = {
      [WORKSPACE.id]: [SESSION, deploySession],
    };
    mockState.sessions = [SESSION, deploySession];
    mockState.workspaces = [{ ...WORKSPACE, sessionCount: 2 }];

    const view = await renderSidebar();

    try {
      await changeInputValue(historySearchInput(view.container), '  deploy  ');

      expect(view.container.textContent).toContain('Deploy Pipeline');
      expect(view.container.textContent).not.toContain('Workflow run');

      const clearButton = view.container.querySelector(
        'button[aria-label="清除搜索"]',
      );
      expect(clearButton).toBeInstanceOf(HTMLButtonElement);
      await clickButton(clearButton as HTMLButtonElement);

      expect(view.container.textContent).toContain('Deploy Pipeline');
      expect(view.container.textContent).toContain('Workflow run');
    } finally {
      await view.cleanup();
    }
  });

  it('filters sessions by preview text', async () => {
    resetSidebarStore();
    const previewSession = {
      ...SESSION,
      id: 's_preview',
      title: 'Research chat',
      preview: 'contains needle text',
      isWorkflow: false,
    };
    mockState.sessionTree = {
      [WORKSPACE.id]: [SESSION, previewSession],
    };
    mockState.sessions = [SESSION, previewSession];
    mockState.workspaces = [{ ...WORKSPACE, sessionCount: 2 }];

    const view = await renderSidebar();

    try {
      await changeInputValue(historySearchInput(view.container), 'needle');

      expect(view.container.textContent).toContain('Research chat');
      expect(view.container.textContent).not.toContain('Workflow run');
    } finally {
      await view.cleanup();
    }
  });

  it('shows a no-results state and clears back to the full list', async () => {
    resetSidebarStore();
    const view = await renderSidebar();

    try {
      await changeInputValue(historySearchInput(view.container), 'missing');

      await waitForNoSearchResults(view.container);
      expect(view.container.textContent).not.toContain('Workflow run');

      const clearButton = Array.from(
        view.container.querySelectorAll('button'),
      ).find((button) => button.textContent?.includes('清除搜索'));
      expect(clearButton).toBeInstanceOf(HTMLButtonElement);

      await act(async () => {
        clearButton?.dispatchEvent(
          new MouseEvent('click', { bubbles: true }),
        );
      });

      expect(view.container.textContent).toContain('Workflow run');
      expect(view.container.textContent).not.toContain('没有找到匹配的会话');
    } finally {
      await view.cleanup();
    }
  });

  it('updates filtered results after a matching session is deleted', async () => {
    resetSidebarStore();
    const deploySession = {
      ...SESSION,
      id: 's_deploy',
      title: 'Deploy Pipeline',
      preview: 'release notes',
    };
    const reviewSession = {
      ...SESSION,
      id: 's_review',
      title: 'Review Notes',
      preview: 'nonmatching history item',
    };
    mockState.sessionTree = {
      [WORKSPACE.id]: [deploySession, reviewSession],
    };
    mockState.sessions = [deploySession, reviewSession];
    mockState.workspaces = [{ ...WORKSPACE, sessionCount: 2 }];
    mockState.activeSessionId = deploySession.id;
    mockState.deleteSession = vi.fn((sessionId) => {
      const nextSessions = mockState.sessions.filter(
        (session) => session.id !== sessionId,
      );
      mockState.sessions = nextSessions;
      mockState.sessionTree = { [WORKSPACE.id]: nextSessions };
      mockState.workspaces = [
        { ...WORKSPACE, sessionCount: nextSessions.length },
      ];
    });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    const view = await renderSidebar();

    try {
      await changeInputValue(historySearchInput(view.container), 'deploy');
      await openSessionContextMenu(sessionButton(view.container, 'Deploy Pipeline'));

      expect(view.container.textContent).toContain('重命名');
      const deleteButton = Array.from(
        view.container.querySelectorAll('button'),
      ).find((button) => button.textContent?.includes('删除'));
      expect(deleteButton).toBeInstanceOf(HTMLButtonElement);

      await clickButton(deleteButton as HTMLButtonElement);
      await view.rerender();

      expect(mockState.deleteSession).toHaveBeenCalledWith(
        deploySession.id,
        WORKSPACE.id,
      );
      await waitForNoSearchResults(view.container);
      expect(view.container.textContent).not.toContain('Deploy Pipeline');
      expect(view.container.textContent).not.toContain('Review Notes');
    } finally {
      confirmSpy.mockRestore();
      await view.cleanup();
    }
  });

  it('updates filtered results after a matching session is renamed outside the query', async () => {
    resetSidebarStore();
    const draftSession = {
      ...SESSION,
      id: 's_draft',
      title: 'Draft Workflow',
      preview: 'planning notes',
    };
    const archiveSession = {
      ...SESSION,
      id: 's_archive',
      title: 'Archive Workflow',
      preview: 'reference notes',
    };
    mockState.sessionTree = {
      [WORKSPACE.id]: [draftSession, archiveSession],
    };
    mockState.sessions = [draftSession, archiveSession];
    mockState.workspaces = [{ ...WORKSPACE, sessionCount: 2 }];
    mockState.activeSessionId = draftSession.id;
    mockState.renameWorkflowSession = vi.fn(async (sessionId, workspaceId, name) => {
      expect(workspaceId).toBe(WORKSPACE.id);
      const nextSessions = mockState.sessions.map((session) =>
        session.id === sessionId ? { ...session, title: name } : session,
      );
      mockState.sessions = nextSessions;
      mockState.sessionTree = { [WORKSPACE.id]: nextSessions };
    });

    const view = await renderSidebar();

    try {
      await changeInputValue(historySearchInput(view.container), 'draft');
      await openSessionContextMenu(sessionButton(view.container, 'Draft Workflow'));

      const renameButton = Array.from(
        view.container.querySelectorAll('button'),
      ).find((button) => button.textContent?.includes('重命名'));
      expect(renameButton).toBeInstanceOf(HTMLButtonElement);
      await clickButton(renameButton as HTMLButtonElement);

      const input = view.container.querySelector('input[aria-label="重命名"]');
      expect(input).toBeInstanceOf(HTMLInputElement);
      await changeInputValue(input as HTMLInputElement, 'Published Workflow');

      const saveButton = Array.from(
        view.container.querySelectorAll('button'),
      ).find((button) => button.textContent?.trim() === '保存');
      expect(saveButton).toBeInstanceOf(HTMLButtonElement);
      await clickButton(saveButton as HTMLButtonElement);
      await flushAsyncWork();
      await view.rerender();

      expect(mockState.renameWorkflowSession).toHaveBeenCalledWith(
        draftSession.id,
        WORKSPACE.id,
        'Published Workflow',
      );
      await waitForNoSearchResults(view.container);
      expect(view.container.textContent).not.toContain('Draft Workflow');
      expect(view.container.textContent).not.toContain('Archive Workflow');
    } finally {
      await view.cleanup();
    }
  });

  it('clears on Escape, then blurs on Escape when already empty', async () => {
    resetSidebarStore();
    const view = await renderSidebar();

    try {
      const input = historySearchInput(view.container);
      input.focus();
      expect(document.activeElement).toBe(input);

      await changeInputValue(input, 'workflow');
      await pressInputKey(input, 'Escape');
      expect(input.value).toBe('');

      await pressInputKey(input, 'Escape');
      expect(document.activeElement).not.toBe(input);
    } finally {
      await view.cleanup();
    }
  });

  it('opens the first matching workspace session on Enter', async () => {
    resetSidebarStore();
    const deploySession = {
      ...SESSION,
      id: 's_deploy',
      title: 'Deploy Pipeline',
    };
    mockState.sessionTree = {
      [WORKSPACE.id]: [SESSION, deploySession],
    };
    mockState.sessions = [SESSION, deploySession];
    mockState.workspaces = [{ ...WORKSPACE, sessionCount: 2 }];

    const view = await renderSidebar();

    try {
      const input = historySearchInput(view.container);
      await changeInputValue(input, 'deploy');
      await pressInputKey(input, 'Enter');

      expect(mockState.selectSession).toHaveBeenCalledWith(
        's_deploy',
        WORKSPACE.id,
      );
    } finally {
      await view.cleanup();
    }
  });

  it('filters flat fallback sessions and selects the first match without a workspace', async () => {
    resetSidebarStore();
    const flatMatch = {
      ...SESSION,
      id: 's_flat_match',
      title: 'Flat Session',
      preview: 'fallback needle',
      isWorkflow: false,
    };
    const flatOther = {
      ...SESSION,
      id: 's_flat_other',
      title: 'Other Flat',
      preview: 'different text',
      isWorkflow: false,
    };
    mockState.workspaces = [];
    mockState.sessionTree = {};
    mockState.sessions = [flatMatch, flatOther];
    mockState.activeWorkspaceId = null;
    mockState.activeSessionId = flatMatch.id;

    const view = await renderSidebar();

    try {
      const input = historySearchInput(view.container);
      await changeInputValue(input, 'fallback needle');

      expect(view.container.textContent).toContain('Flat Session');
      expect(view.container.textContent).not.toContain('Other Flat');

      await pressInputKey(input, 'Enter');

      expect(mockState.selectSession).toHaveBeenCalledWith(
        's_flat_match',
        undefined,
      );
    } finally {
      await view.cleanup();
    }
  });

  it('shows all matching workspace sessions while searching and restores pagination when cleared', async () => {
    resetSidebarStore();
    const manySessions = Array.from({ length: 25 }, (_, index) => ({
      ...SESSION,
      id: `s_bulk_${index}`,
      title: `Bulk Session ${index + 1}`,
    }));
    mockState.sessionTree = { [WORKSPACE.id]: manySessions };
    mockState.sessions = manySessions;
    mockState.workspaces = [{ ...WORKSPACE, sessionCount: manySessions.length }];

    const view = await renderSidebar();
    const visibleBulkSessionButtons = () =>
      Array.from(view.container.querySelectorAll('button')).filter((button) =>
        button.textContent?.includes('Bulk Session'),
      );

    const visibleBulkSessionTitles = () =>
      Array.from(view.container.querySelectorAll('span'))
        .map((span) => span.textContent ?? '')
        .filter((text) => text.startsWith('Bulk Session'));

    try {
      expect(visibleBulkSessionTitles()).toContain('Bulk Session 10');
      expect(visibleBulkSessionButtons()).toHaveLength(10);
      expect(visibleBulkSessionTitles()).not.toContain('Bulk Session 11');
      expect(visibleBulkSessionTitles()).not.toContain('Bulk Session 25');
      expect(view.container.textContent).toContain('加载更多');

      await changeInputValue(historySearchInput(view.container), 'bulk');

      expect(visibleBulkSessionTitles()).toContain('Bulk Session 25');
      expect(view.container.textContent).not.toContain('加载更多');

      const clearButton = view.container.querySelector(
        'button[aria-label="清除搜索"]',
      );
      expect(clearButton).toBeInstanceOf(HTMLButtonElement);
      await clickButton(clearButton as HTMLButtonElement);

      expect(visibleBulkSessionButtons()).toHaveLength(10);
      expect(visibleBulkSessionTitles()).not.toContain('Bulk Session 11');
      expect(visibleBulkSessionTitles()).not.toContain('Bulk Session 25');
      expect(view.container.textContent).toContain('加载更多');
    } finally {
      await view.cleanup();
    }
  });

  it('selects a workspace from the header and toggles only from the chevron', async () => {
    resetSidebarStore();
    const toggleSessions = [
      { ...SESSION, id: 's_toggle_1', title: 'Workspace Toggle 1' },
      { ...SESSION, id: 's_toggle_2', title: 'Workspace Toggle 2' },
    ];
    mockState.sessionTree = { [WORKSPACE.id]: toggleSessions };
    mockState.sessions = toggleSessions;
    mockState.workspaces = [
      { ...WORKSPACE, sessionCount: toggleSessions.length },
    ];

    const view = await renderSidebar();
    const workspaceHeader = () => {
      const button = Array.from(view.container.querySelectorAll('button')).find(
        (item) =>
          item.getAttribute('aria-haspopup') !== 'listbox' &&
          item.textContent?.includes(WORKSPACE.name),
      );
      expect(button).toBeInstanceOf(HTMLButtonElement);
      return button as HTMLButtonElement;
    };
    const workspaceToggle = () => {
      const button = view.container.querySelector(
        'button[aria-label="收起工作区会话"], button[aria-label="展开工作区会话"]',
      );
      expect(button).toBeInstanceOf(HTMLButtonElement);
      return button as HTMLButtonElement;
    };

    try {
      expect(workspaceToggle().getAttribute('aria-expanded')).toBe('true');
      expect(view.container.textContent).toContain('Workspace Toggle 1');
      expect(view.container.textContent).toContain('Workspace Toggle 2');

      await clickButton(workspaceHeader());

      expect(mockState.setWorkspace).toHaveBeenCalledWith(WORKSPACE.path);
      expect(workspaceToggle().getAttribute('aria-expanded')).toBe('true');
      expect(view.container.textContent).toContain('Workspace Toggle 1');
      expect(view.container.textContent).toContain('Workspace Toggle 2');

      await clickButton(workspaceToggle());

      expect(workspaceToggle().getAttribute('aria-expanded')).toBe('false');
      expect(view.container.textContent).not.toContain('Workspace Toggle 1');
      expect(view.container.textContent).not.toContain('Workspace Toggle 2');
      expect(mockState.selectSession).not.toHaveBeenCalled();

      await clickButton(workspaceToggle());

      expect(workspaceToggle().getAttribute('aria-expanded')).toBe('true');
      expect(view.container.textContent).toContain('Workspace Toggle 1');
      expect(view.container.textContent).toContain('Workspace Toggle 2');
    } finally {
      await view.cleanup();
    }
  });

  it('loads workspace history in pages of ten', async () => {
    resetSidebarStore();
    const manySessions = Array.from({ length: 25 }, (_, index) => ({
      ...SESSION,
      id: `s_page_${index}`,
      title: `Paged Session ${index + 1}`,
    }));
    mockState.sessionTree = { [WORKSPACE.id]: manySessions };
    mockState.sessions = manySessions;
    mockState.workspaces = [{ ...WORKSPACE, sessionCount: manySessions.length }];

    const view = await renderSidebar();
    const visiblePagedSessionButtons = () =>
      Array.from(view.container.querySelectorAll('button')).filter((button) =>
        button.textContent?.includes('Paged Session'),
      );
    const visiblePagedSessionTitles = () =>
      Array.from(view.container.querySelectorAll('span'))
        .map((span) => span.textContent ?? '')
        .filter((text) => text.startsWith('Paged Session'));
    const loadMoreButton = () => {
      const button = Array.from(view.container.querySelectorAll('button')).find(
        (item) => item.textContent?.trim() === '加载更多',
      );
      expect(button).toBeInstanceOf(HTMLButtonElement);
      return button as HTMLButtonElement;
    };
    const collapseButton = () => {
      const button = Array.from(view.container.querySelectorAll('button')).find(
        (item) => item.textContent?.trim() === '收起',
      );
      expect(button).toBeInstanceOf(HTMLButtonElement);
      return button as HTMLButtonElement;
    };

    try {
      expect(visiblePagedSessionButtons()).toHaveLength(10);
      expect(visiblePagedSessionTitles()).toContain('Paged Session 10');
      expect(visiblePagedSessionTitles()).not.toContain('Paged Session 11');
      expect(view.container.textContent).not.toContain('收起');

      await clickButton(loadMoreButton());

      expect(visiblePagedSessionButtons()).toHaveLength(20);
      expect(visiblePagedSessionTitles()).toContain('Paged Session 20');
      expect(visiblePagedSessionTitles()).not.toContain('Paged Session 21');
      expect(view.container.textContent).toContain('收起');
      expect(view.container.textContent).toContain('加载更多');

      await clickButton(collapseButton());

      expect(visiblePagedSessionButtons()).toHaveLength(10);
      expect(visiblePagedSessionTitles()).toContain('Paged Session 10');
      expect(visiblePagedSessionTitles()).not.toContain('Paged Session 11');
      expect(view.container.textContent).not.toContain('收起');
      expect(view.container.textContent).toContain('加载更多');
    } finally {
      await view.cleanup();
    }
  });

  it('collapses flat fallback history in pages of ten', async () => {
    resetSidebarStore();
    const manySessions = Array.from({ length: 25 }, (_, index) => ({
      ...SESSION,
      id: `s_flat_page_${index}`,
      title: `Flat Paged Session ${index + 1}`,
      isWorkflow: false,
    }));
    mockState.workspaces = [];
    mockState.sessionTree = {};
    mockState.sessions = manySessions;
    mockState.activeWorkspaceId = null;
    mockState.activeSessionId = manySessions[0].id;

    const view = await renderSidebar();
    const visibleFlatSessionButtons = () =>
      Array.from(view.container.querySelectorAll('button')).filter((button) =>
        button.textContent?.includes('Flat Paged Session'),
      );
    const visibleFlatSessionTitles = () =>
      Array.from(view.container.querySelectorAll('span'))
        .map((span) => span.textContent ?? '')
        .filter((text) => text.startsWith('Flat Paged Session'));
    const loadMoreButton = () => {
      const button = Array.from(view.container.querySelectorAll('button')).find(
        (item) => item.textContent?.trim() === '加载更多',
      );
      expect(button).toBeInstanceOf(HTMLButtonElement);
      return button as HTMLButtonElement;
    };
    const collapseButton = () => {
      const button = Array.from(view.container.querySelectorAll('button')).find(
        (item) => item.textContent?.trim() === '收起',
      );
      expect(button).toBeInstanceOf(HTMLButtonElement);
      return button as HTMLButtonElement;
    };

    try {
      expect(visibleFlatSessionButtons()).toHaveLength(10);
      expect(visibleFlatSessionTitles()).toContain('Flat Paged Session 10');
      expect(visibleFlatSessionTitles()).not.toContain('Flat Paged Session 11');

      await clickButton(loadMoreButton());

      expect(visibleFlatSessionButtons()).toHaveLength(20);
      expect(visibleFlatSessionTitles()).toContain('Flat Paged Session 20');
      expect(visibleFlatSessionTitles()).not.toContain('Flat Paged Session 21');

      await clickButton(collapseButton());

      expect(visibleFlatSessionButtons()).toHaveLength(10);
      expect(visibleFlatSessionTitles()).toContain('Flat Paged Session 10');
      expect(visibleFlatSessionTitles()).not.toContain('Flat Paged Session 11');
    } finally {
      await view.cleanup();
    }
  });

  it('keeps live running status visible while filtered', async () => {
    resetSidebarStore();
    mockState.runningSessions = [SESSION_KEY];
    mockState.runningSessionProgress = {
      [WORKSPACE.id + '::' + SESSION.id]: {
        completed: 1,
        incomplete: 1,
        percent: 50,
      },
    };

    const view = await renderSidebar();

    try {
      await changeInputValue(historySearchInput(view.container), 'workflow');

      expect(runningDot(view.container, 50)).not.toBeNull();
      expect(view.container.textContent).toContain('Workflow run');
    } finally {
      await view.cleanup();
    }
  });
});
