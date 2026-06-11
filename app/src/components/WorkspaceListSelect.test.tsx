import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WorkspaceListSelect from '@/components/WorkspaceListSelect';
import type { WorkspaceSummary } from '@/store/history/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function makeWorkspace(
  overrides: Partial<WorkspaceSummary> & Pick<WorkspaceSummary, 'id'>,
): WorkspaceSummary {
  return {
    path: '',
    name: overrides.id,
    updatedAt: 0,
    sessionCount: 0,
    ...overrides,
  };
}

async function renderList(props: {
  workspaces: WorkspaceSummary[];
  activeWorkspaceId: string | null;
  onSelect?: (path: string) => void;
  onBrowseLocal?: () => void;
}): Promise<{ container: HTMLDivElement; cleanup: () => Promise<void> }> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  await act(async () => {
    root.render(
      <WorkspaceListSelect
        workspaces={props.workspaces}
        activeWorkspaceId={props.activeWorkspaceId}
        locale="zh-CN"
        onSelect={props.onSelect ?? vi.fn()}
        onBrowseLocal={props.onBrowseLocal ?? vi.fn()}
      />,
    );
  });

  return {
    container,
    cleanup: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

afterEach(() => {
  document.body.innerHTML = '';
});

async function openMenu(container: HTMLElement): Promise<void> {
  const trigger = container.querySelector('button[aria-haspopup="listbox"]');
  expect(trigger).toBeInstanceOf(HTMLButtonElement);
  await act(async () => {
    (trigger as HTMLButtonElement).click();
  });
}

describe('WorkspaceListSelect', () => {
  it('lists every workspace and switches via path on click', async () => {
    const onSelect = vi.fn();
    const view = await renderList({
      workspaces: [
        makeWorkspace({ id: 'a', name: 'Alpha', path: 'E:\Alpha' }),
        makeWorkspace({ id: 'b', name: 'Beta', path: 'E:\Beta' }),
      ],
      activeWorkspaceId: 'a',
      onSelect,
    });

    try {
      await openMenu(view.container);

      const options = Array.from(
        view.container.querySelectorAll('[role="option"]'),
      );
      expect(options).toHaveLength(2);

      const beta = options.find((item) =>
        item.textContent?.includes('Beta'),
      ) as HTMLButtonElement;
      await act(async () => {
        beta.click();
      });

      expect(onSelect).toHaveBeenCalledWith('E:\Beta');
    } finally {
      await view.cleanup();
    }
  });

  it('marks the active workspace as selected', async () => {
    const view = await renderList({
      workspaces: [
        makeWorkspace({ id: 'a', name: 'Alpha', path: 'E:\Alpha' }),
        makeWorkspace({ id: 'b', name: 'Beta', path: 'E:\Beta' }),
      ],
      activeWorkspaceId: 'b',
    });

    try {
      await openMenu(view.container);
      const selected = view.container.querySelector(
        '[role="option"][aria-selected="true"]',
      );
      expect(selected?.textContent).toContain('Beta');
    } finally {
      await view.cleanup();
    }
  });

  it('invokes onBrowseLocal from the browse-local action', async () => {
    const onBrowseLocal = vi.fn();
    const view = await renderList({
      workspaces: [],
      activeWorkspaceId: null,
      onBrowseLocal,
    });

    try {
      await openMenu(view.container);
      const browse = Array.from(
        view.container.querySelectorAll('button'),
      ).find((item) => item.textContent?.includes('浏览本地'));
      expect(browse).toBeInstanceOf(HTMLButtonElement);
      await act(async () => {
        (browse as HTMLButtonElement).click();
      });
      expect(onBrowseLocal).toHaveBeenCalledTimes(1);
    } finally {
      await view.cleanup();
    }
  });

  it('shows an empty state when there are no workspaces', async () => {
    const view = await renderList({
      workspaces: [],
      activeWorkspaceId: null,
    });

    try {
      await openMenu(view.container);
      expect(view.container.textContent).toContain('暂无工作区');
    } finally {
      await view.cleanup();
    }
  });
});
