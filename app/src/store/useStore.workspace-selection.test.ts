import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultBlueprint } from '@/core/defaultBlueprint';
import { useStore } from './useStore';
import { historyStore } from './history/store';
import type { Session } from './types';

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  description: string,
): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function summaryFor(workspaceId: string, id: string, title: string): Session {
  const now = Date.now();
  return {
    id,
    workspaceId,
    title,
    createdAt: now,
    updatedAt: now,
    isWorkflow: false,
    messageCount: 0,
  };
}

describe('top workspace switcher selection (selectedWorkspaceId)', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it('does not follow a session click into another workspace', async () => {
    await historyStore.ready();
    const wsA = await historyStore.resolveWorkspaceByPath('E:\test_project_ue53');
    const wsB = await historyStore.resolveWorkspaceByPath('E:\OpenWorkflow');

    const sessionB = await historyStore.createSession({
      workspaceId: wsB.id,
      isWorkflow: false,
      messages: [],
      title: 'OpenWorkflow chat',
    });

    useStore.setState({
      historyReady: true,
      activeWorkspaceId: wsA.id,
      selectedWorkspaceId: wsA.id,
      activeSessionId: null,
      workspaces: [wsA, wsB],
      sessions: [],
      sessionTree: {
        [wsA.id]: [],
        [wsB.id]: [summaryFor(wsB.id, sessionB.id, sessionB.title)],
      },
      workflow: defaultBlueprint('Current workflow'),
      locale: 'zh-CN',
    });

    // Click a session that lives in workspace B while A is the pinned workspace.
    useStore.getState().selectSession(sessionB.id, wsB.id);

    await waitFor(
      () => useStore.getState().activeSessionId === sessionB.id,
      'session B activation',
    );

    const state = useStore.getState();
    // The active view follows the clicked session...
    expect(state.activeWorkspaceId).toBe(wsB.id);
    expect(state.activeSessionId).toBe(sessionB.id);
    // ...but the top switcher's pinned workspace stays put.
    expect(state.selectedWorkspaceId).toBe(wsA.id);
  });

  it('updates the pinned workspace only when switched explicitly', async () => {
    await historyStore.ready();
    const wsA = await historyStore.resolveWorkspaceByPath('E:\test_project_ue53');
    const wsB = await historyStore.resolveWorkspaceByPath('E:\OpenWorkflow');
    const sessionB = await historyStore.createSession({
      workspaceId: wsB.id,
      isWorkflow: false,
      messages: [],
      title: 'OpenWorkflow chat',
    });

    useStore.setState({
      historyReady: true,
      activeWorkspaceId: wsA.id,
      selectedWorkspaceId: wsA.id,
      activeSessionId: null,
      workspaces: [wsA, wsB],
      sessions: [],
      sessionTree: {
        [wsA.id]: [],
        [wsB.id]: [summaryFor(wsB.id, sessionB.id, sessionB.title)],
      },
      workflow: defaultBlueprint('Current workflow'),
      locale: 'zh-CN',
    });

    useStore.getState().setWorkspace(wsB.path);

    await waitFor(
      () => useStore.getState().selectedWorkspaceId === wsB.id,
      'explicit workspace selection',
    );

    const state = useStore.getState();
    expect(state.activeWorkspaceId).toBe(wsB.id);
    expect(state.selectedWorkspaceId).toBe(wsB.id);
  });
});
