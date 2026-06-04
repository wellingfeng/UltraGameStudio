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
};

type MockWorkspace = {
  id: string;
  path: string;
  name: string;
  updatedAt: number;
  sessionCount: number;
  lastActiveSessionId: string | null;
};

type MockStoreState = {
  locale: 'zh-CN' | 'en-US';
  mode: 'design' | 'running';
  sessions: MockSession[];
  historyReady: boolean;
  workspaces: MockWorkspace[];
  sessionTree: Record<string, MockSession[]>;
  activeWorkspaceId: string | null;
  activeSessionId: string | null;
  runningSessions: SessionKey[];
  runningSessionProgress: Record<
    string,
    { completed: number; incomplete: number; percent: number | null }
  >;
  aiEditingSessions: SessionKey[];
  chattingSessions: SessionKey[];
  newWorkflow: () => void;
  newSession: () => void;
  exportWorkflowSession: (
    sessionId: string,
    workspaceId: string | null,
    title?: string,
  ) => void;
  importWorkflowToWorkspace: (workspaceId: string, title?: string) => void;
  selectSession: (sessionId: string, workspaceId?: string) => void;
  deleteSession: (sessionId: string, workspaceId?: string) => void;
  renameWorkflowSession: (
    sessionId: string,
    workspaceId: string | null,
    name: string,
  ) => Promise<void>;
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
    useStore,
    workflowDeleteProtectionReason: (
      session: Pick<MockSession, 'id' | 'isWorkflow'>,
      workspaceId: string | null | undefined,
      liveState: Pick<MockStoreState, 'runningSessions' | 'aiEditingSessions'> &
        Partial<Pick<MockStoreState, 'chattingSessions'>>,
    ) => {
      if (!session.isWorkflow) return null;
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

import Sidebar from './Sidebar';

const WORKSPACE: MockWorkspace = {
  id: 'ws_test',
  path: 'E:\\FreeUltraCode',
  name: 'FreeUltraCode',
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
    activeSessionId: SESSION.id,
    runningSessions: [],
    runningSessionProgress: {},
    aiEditingSessions: [],
    chattingSessions: [],
    newWorkflow: vi.fn(),
    newSession: vi.fn(),
    exportWorkflowSession: vi.fn(),
    importWorkflowToWorkspace: vi.fn(),
    selectSession: vi.fn(),
    deleteSession: vi.fn(),
    renameWorkflowSession: vi.fn(async () => undefined),
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
  status: 'none' | 'thinking' | 'unrun' | 'running' | 'success' | 'failed',
): HTMLElement | null {
  return container.querySelector(`[data-status="${status}"]`);
}

function statusIndicator(dot: HTMLElement | null): HTMLElement | null {
  return dot?.querySelector<HTMLElement>('.fuc-status-indicator') ?? null;
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
      item.textContent?.trim() === '收藏' ||
      item.textContent?.trim() === '取消收藏',
  );
  expect(button).toBeInstanceOf(HTMLButtonElement);
  return button as HTMLButtonElement;
}

function contextMenuScheduleButton(container: HTMLElement): HTMLButtonElement {
  const button = Array.from(
    container.querySelectorAll('button:not([role="tab"])'),
  ).find((item) => item.textContent?.trim() === '定时执行');
  expect(button).toBeInstanceOf(HTMLButtonElement);
  return button as HTMLButtonElement;
}

function tabButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(
    container.querySelectorAll('button[role="tab"]'),
  ).find((item) => item.textContent?.includes(label));
  expect(button).toBeInstanceOf(HTMLButtonElement);
  return button as HTMLButtonElement;
}

async function flushAsyncWork(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
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
  window.localStorage.clear();
  document.body.innerHTML = '';
  resetSidebarStore();
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

  it('favorites workflow sessions from the context menu', async () => {
    resetSidebarStore();
    const view = await renderSidebar();

    try {
      await openSessionContextMenu(sessionButton(view.container, SESSION.title));

      const favoriteButton = contextMenuFavoriteButton(view.container);
      expect(favoriteButton.textContent).toContain('收藏');

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
      expect(favoriteButton.textContent).toContain('取消收藏');

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

      expect(view.container.textContent).toContain('定时执行任务');
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
      expect(favoriteButton.textContent).toContain('收藏');

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

  it('shows all favorited sessions in the favorites tab', async () => {
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
      await clickButton(tabButton(view.container, '收藏夹'));

      expect(view.container.textContent).toContain('Favorite Workflow');
      expect(view.container.textContent).not.toContain('Plain Workflow');
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

describe('Sidebar running progress dot', () => {
  it('keeps the running indicator green and spinning while progress changes', async () => {
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
      expect(zeroSpinner?.classList.contains('fuc-status-spinner')).toBe(true);
      expect(zeroSpinner?.style.getPropertyValue('--fuc-status-color')).toBe(
        'var(--status-success)',
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
      expect(completeSpinner?.classList.contains('fuc-status-spinner')).toBe(true);
      expect(completeSpinner?.style.getPropertyValue('--fuc-status-color')).toBe(
        'var(--status-success)',
      );
      expect(statusDot(view.container, 'success')).toBeNull();
    } finally {
      await view.cleanup();
    }
  });

  it('renders unrun workflow sessions as a static blue dot', async () => {
    resetSidebarStore();
    const view = await renderSidebar();

    try {
      const dot = statusDot(view.container, 'unrun');
      expect(dot).not.toBeNull();
      expect(dot?.getAttribute('title')).toBe('未运行');
      const indicator = statusIndicator(dot);
      expect(indicator).not.toBeNull();
      expect(indicator?.classList.contains('fuc-status-spinner')).toBe(false);
      expect(indicator?.style.getPropertyValue('--fuc-status-color')).toBe(
        'var(--status-ai-edit)',
      );
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
      expect(emptySlot?.classList.contains('fuc-status-slot')).toBe(true);
      expect(statusIndicator(emptySlot as HTMLElement)).toBeNull();
    } finally {
      await view.cleanup();
    }
  });

  it('renders an in-flight chat session as a green running spinner', async () => {
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
      expect(indicator?.classList.contains('fuc-status-spinner')).toBe(true);
      expect(indicator?.style.getPropertyValue('--fuc-status-color')).toBe(
        'var(--status-success)',
      );
      expect(statusDot(view.container, 'thinking')).toBeNull();
    } finally {
      await view.cleanup();
    }
  });

  it.each([
    ['success', 'success', '已完成', 'var(--status-success)'],
    ['error', 'failed', '已失败', 'var(--status-error)'],
    ['interrupted', 'failed', '已失败', 'var(--status-error)'],
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
        expect(indicator?.classList.contains('fuc-status-spinner')).toBe(false);
        expect(indicator?.style.getPropertyValue('--fuc-status-color')).toBe(
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
        expect(indicator?.classList.contains('fuc-status-spinner')).toBe(false);
        expect(indicator?.style.getPropertyValue('--fuc-status-color')).toBe(
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

  it('renders a blue spinning indicator while AI is thinking', async () => {
    resetSidebarStore();
    mockState.aiEditingSessions = [SESSION_KEY];

    const view = await renderSidebar();

    try {
      const dot = statusDot(view.container, 'thinking');
      expect(dot).not.toBeNull();
      expect(dot?.getAttribute('title')).toBe('AI 思考中');
      const indicator = statusIndicator(dot);
      expect(indicator).not.toBeNull();
      expect(indicator?.classList.contains('fuc-status-spinner')).toBe(true);
      expect(indicator?.style.getPropertyValue('--fuc-status-color')).toBe(
        'var(--status-ai-edit)',
      );
    } finally {
      await view.cleanup();
    }
  });
});

describe('Sidebar delete protection', () => {
  it.each([
    ['running', '运行中的蓝图不能删除'],
    ['aiEditing', 'AI 正在优化蓝图，暂不能删除'],
  ] as const)(
    'disables deleting protected %s workflow sessions',
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
    ['running', '运行中的蓝图不能删除'],
    ['aiEditing', 'AI 正在优化蓝图，暂不能删除'],
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
  it('orders workspace sessions by live state before timestamp', async () => {
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
      runningSession.title,
      thinkingSession.title,
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

  it('orders flat fallback sessions by live state before timestamp', async () => {
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
      runningSession.title,
      thinkingSession.title,
      recentSession.title,
    ];
    mockState.workspaces = [];
    mockState.sessionTree = {};
    mockState.sessions = [recentSession, thinkingSession, runningSession];
    mockState.activeWorkspaceId = null;
    mockState.activeSessionId = recentSession.id;
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

  it('shows an empty favorites state when there are no sessions', async () => {
    resetSidebarStore();
    mockState.sessions = [];
    mockState.workspaces = [];
    mockState.sessionTree = {};
    mockState.activeWorkspaceId = null;
    mockState.activeSessionId = null;

    const view = await renderSidebar();

    try {
      await clickButton(tabButton(view.container, '收藏夹'));

      expect(queryHistorySearchInput(view.container)).toBeNull();
      expect(view.container.textContent).toContain('暂无收藏的会话');
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

      expect(view.container.textContent).toContain('没有找到匹配的会话');
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
      expect(view.container.textContent).toContain('没有找到匹配的会话');
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
      expect(view.container.textContent).toContain('没有找到匹配的会话');
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

    try {
      expect(view.container.textContent).toContain('Bulk Session 5');
      expect(visibleBulkSessionButtons()).toHaveLength(5);
      expect(view.container.textContent).not.toContain('Bulk Session 6');
      expect(view.container.textContent).not.toContain('Bulk Session 25');
      expect(view.container.textContent).toContain('加载更多');

      await changeInputValue(historySearchInput(view.container), 'bulk');

      expect(view.container.textContent).toContain('Bulk Session 25');
      expect(view.container.textContent).not.toContain('加载更多');

      const clearButton = view.container.querySelector(
        'button[aria-label="清除搜索"]',
      );
      expect(clearButton).toBeInstanceOf(HTMLButtonElement);
      await clickButton(clearButton as HTMLButtonElement);

      expect(visibleBulkSessionButtons()).toHaveLength(5);
      expect(view.container.textContent).not.toContain('Bulk Session 6');
      expect(view.container.textContent).not.toContain('Bulk Session 25');
      expect(view.container.textContent).toContain('加载更多');
    } finally {
      await view.cleanup();
    }
  });

  it('loads workspace history in pages of five', async () => {
    resetSidebarStore();
    const manySessions = Array.from({ length: 12 }, (_, index) => ({
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

    try {
      expect(visiblePagedSessionButtons()).toHaveLength(5);
      expect(visiblePagedSessionTitles()).toContain('Paged Session 5');
      expect(visiblePagedSessionTitles()).not.toContain('Paged Session 6');

      await clickButton(loadMoreButton());

      expect(visiblePagedSessionButtons()).toHaveLength(10);
      expect(visiblePagedSessionTitles()).toContain('Paged Session 10');
      expect(visiblePagedSessionTitles()).not.toContain('Paged Session 11');
      expect(view.container.textContent).toContain('加载更多');
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
