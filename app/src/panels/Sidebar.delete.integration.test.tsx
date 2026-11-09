import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { historyStore } from '@/store/history/store';
import { useStore } from '@/store/useStore';
import Sidebar from './Sidebar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

it('removes a newly created empty session from the sidebar before its deletion finishes', async () => {
  await historyStore.ready();
  const workspace = await historyStore.resolveWorkspaceByPath('E:\\sidebar-delete-integration');
  useStore.setState({
    locale: 'zh-CN',
    historyReady: true,
    workspaces: [workspace],
    activeWorkspaceId: workspace.id,
    selectedWorkspaceId: workspace.id,
    activeSessionId: null,
    sessions: [],
    sessionTree: { [workspace.id]: [] },
  });
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  let releaseDelete!: () => void;
  const deletionGate = new Promise<void>((resolve) => { releaseDelete = resolve; });
  const deleteSession = historyStore.deleteSession.bind(historyStore);
  let deletion: Promise<void> | undefined;
  vi.spyOn(historyStore, 'deleteSession').mockImplementation((...args) => {
    deletion = deletionGate.then(() => deleteSession(...args));
    return deletion;
  });

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(<Sidebar />); });
    const newButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('新建会话'));
    expect(newButton).toBeDefined();
    await act(async () => { newButton!.click(); });
    const sessionId = useStore.getState().activeSessionId!;
    const sessionButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('新会话'));
    expect(sessionButton).toBeDefined();
    await act(async () => {
      sessionButton!.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: 120, clientY: 140,
      }));
    });
    const deleteButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === '删除');
    expect(deleteButton).toBeDefined();
    await act(async () => { deleteButton!.click(); });
    expect(container.textContent).not.toContain('新会话');
    expect(useStore.getState().activeSessionId).toBeNull();

    releaseDelete();
    await act(async () => { await deletion; await historyStore.flush(); });
    expect(await historyStore.getSessionForGeneration(workspace.id, sessionId)).toBeNull();
  } finally {
    releaseDelete();
    await deletion;
    await act(async () => { root.unmount(); });
    container.remove();
    await historyStore.flush();
  }
});
