import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ProjectSettingsModal from './ProjectSettingsModal';
import { DEFAULT_GAME_EXPERT_SETTINGS } from '@/lib/gameExperts';
import {
  probeProjectLspServer,
  scanProjectEnvironment,
  tauriAvailable,
  type ProjectEnvironmentScan,
} from '@/lib/tauri';
import type { WorkspaceSummary } from '@/store/history/types';
import { useStore } from '@/store/useStore';

vi.mock('@/lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tauri')>(
    '@/lib/tauri',
  );
  return {
    ...actual,
    openLocalPath: vi.fn(),
    openExternal: vi.fn(),
    probeProjectMcpServer: vi.fn(),
    probeProjectLspServer: vi.fn(),
    skillInstallTargets: vi.fn(async () => []),
    tauriAvailable: vi.fn(() => false),
    scanProjectEnvironment: vi.fn(),
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const workspace: WorkspaceSummary = {
  id: 'w_test_project_ue53',
  path: 'E:\\uug_mcp\\ue-mcp-for-all-versions\\test_project_ue53',
  name: 'test_project_ue53',
  updatedAt: 1,
  sessionCount: 0,
};

function unrealScan(): ProjectEnvironmentScan {
  return {
    rootPath: workspace.path,
    scannedAtMs: 1,
    engine: {
      engine: 'unreal',
      label: 'Unreal Engine',
      confidence: 0.95,
      markers: ['uproject'],
    },
    skillRoots: [],
    suggestedMcpServers: [],
  };
}

function unknownScan(): ProjectEnvironmentScan {
  return {
    rootPath: workspace.path,
    scannedAtMs: 1,
    engine: {
      engine: 'unknown',
      label: '未识别',
      confidence: 0,
      markers: [],
    },
    skillRoots: [],
    suggestedMcpServers: [],
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function renderProjectSettingsModal(
  scan: ProjectEnvironmentScan = unrealScan(),
  targetWorkspace: WorkspaceSummary = workspace,
): Promise<{
  container: HTMLDivElement;
  cleanup: () => Promise<void>;
}> {
  vi.mocked(tauriAvailable).mockReturnValue(false);
  vi.mocked(scanProjectEnvironment).mockResolvedValue(scan);
  useStore.setState({
    gameExpertSettings: DEFAULT_GAME_EXPERT_SETTINGS,
  });

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  await act(async () => {
    root.render(<ProjectSettingsModal workspace={targetWorkspace} onClose={vi.fn()} />);
  });
  await settle();

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
  window.localStorage.clear();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('ProjectSettingsModal game project tabs', () => {
  it('splits game project capabilities into Mesh, rigging, expert, and command tabs', async () => {
    const view = await renderProjectSettingsModal();

    try {
      const tabText = Array.from(
        view.container.querySelectorAll('nav [role="tab"]'),
      ).map((tab) => tab.textContent?.trim());

      expect(tabText).toEqual([
        '概览',
        'Mesh 渠道',
        '模型库',
        '绑定渠道',
        '游戏专家',
        '命令',
        'MCP',
        'LSP',
        'Skills',
        '权限/自动化',
      ]);
      expect(tabText).not.toContain('游戏功能');
    } finally {
      await view.cleanup();
    }
  });

  it('hides all game capability tabs for non-game projects', async () => {
    const view = await renderProjectSettingsModal(unknownScan());

    try {
      const tabText = Array.from(
        view.container.querySelectorAll('nav [role="tab"]'),
      ).map((tab) => tab.textContent?.trim());

      expect(tabText).toEqual([
        '概览',
        'MCP',
        'LSP',
        'Skills',
        '权限/自动化',
      ]);
      expect(tabText).not.toContain('Mesh 渠道');
      expect(tabText).not.toContain('绑定渠道');
      expect(tabText).not.toContain('游戏专家');
      expect(tabText).not.toContain('命令');
    } finally {
      await view.cleanup();
    }
  });

  it('summarizes empty project skill roots without showing paths', async () => {
    const scan: ProjectEnvironmentScan = {
      ...unknownScan(),
      skillRoots: [
        {
          id: 'codex',
          label: 'Codex 项目 Skill',
          path: 'E:\\OpenWorkflows\\.codex\\skills',
          exists: false,
          skillCount: 0,
          skills: [],
        },
        {
          id: 'agents',
          label: 'Agents 项目 Skill',
          path: 'E:\\OpenWorkflows\\.agents\\skills',
          exists: false,
          skillCount: 0,
          skills: [],
        },
        {
          id: 'claude',
          label: 'Claude 项目 Skill',
          path: 'E:\\OpenWorkflows\\.claude\\skills',
          exists: false,
          skillCount: 0,
          skills: [],
        },
      ],
    };
    const view = await renderProjectSettingsModal(scan, {
      ...workspace,
      path: 'E:\\OpenWorkflows',
      name: 'OpenWorkflows',
    });

    try {
      const skillsTab = Array.from(
        view.container.querySelectorAll('nav [role="tab"]'),
      ).find((tab) => tab.textContent?.trim() === 'Skills');

      await act(async () => {
        (skillsTab as HTMLButtonElement).click();
      });

      expect(view.container.textContent).toContain(
        '项目中 Codex Skill 数目是 0',
      );
      expect(view.container.textContent).toContain(
        '项目中 Agents Skill 数目是 0',
      );
      expect(view.container.textContent).toContain(
        '项目中 Claude Skill 数目是 0',
      );
      expect(view.container.textContent).not.toContain('.codex\\skills');
      expect(view.container.textContent).not.toContain('.agents\\skills');
      expect(view.container.textContent).not.toContain('.claude\\skills');
    } finally {
      await view.cleanup();
    }
  });

  it('renders game slash commands under the project command tab', async () => {
    const view = await renderProjectSettingsModal();

    try {
      const commandTab = Array.from(
        view.container.querySelectorAll('nav [role="tab"]'),
      ).find((tab) => tab.textContent?.trim() === '命令');

      await act(async () => {
        (commandTab as HTMLButtonElement).click();
      });

      const commandNames = Array.from(view.container.querySelectorAll('code')).map(
        (item) => item.textContent?.trim(),
      );
      expect(commandNames).toEqual([
        '/game',
        '/mesh-mode-start',
        '/mesh-mode-end',
        '/mesh-search',
      ]);
    } finally {
      await view.cleanup();
    }
  });

  it('renders recommended LSP servers under the LSP tab', async () => {
    const view = await renderProjectSettingsModal();

    try {
      const lspTab = Array.from(
        view.container.querySelectorAll('nav [role="tab"]'),
      ).find((tab) => tab.textContent?.trim() === 'LSP');

      await act(async () => {
        (lspTab as HTMLButtonElement).click();
      });

      const registrySubTab = Array.from(
        view.container.querySelectorAll('button'),
      ).find((button) => button.textContent?.trim().startsWith('仓库'));
      await act(async () => {
        (registrySubTab as HTMLButtonElement).click();
      });

      expect(view.container.textContent).toContain('clangd');
      expect(view.container.textContent).toContain('推荐');
      expect(view.container.textContent).toContain('一键安装');
    } finally {
      await view.cleanup();
    }
  });

  it('keeps MCP and LSP project switches off for unconfigured projects', async () => {
    const view = await renderProjectSettingsModal(unknownScan());

    try {
      const mcpTab = Array.from(
        view.container.querySelectorAll('nav [role="tab"]'),
      ).find((tab) => tab.textContent?.trim() === 'MCP');

      await act(async () => {
        (mcpTab as HTMLButtonElement).click();
      });

      const mcpSwitch = view.container.querySelector(
        'input[type="checkbox"]',
      ) as HTMLInputElement | null;
      expect(mcpSwitch?.checked).toBe(false);

      const lspTab = Array.from(
        view.container.querySelectorAll('nav [role="tab"]'),
      ).find((tab) => tab.textContent?.trim() === 'LSP');

      await act(async () => {
        (lspTab as HTMLButtonElement).click();
      });

      const lspSwitch = view.container.querySelector(
        'input[type="checkbox"]',
      ) as HTMLInputElement | null;
      expect(lspSwitch?.checked).toBe(false);
      expect(view.container.textContent).toMatch(/已启用\s*0/);
    } finally {
      await view.cleanup();
    }
  });

  it('shows zero effective LSP servers when the project LSP switch is off', async () => {
    const configuredWorkspace: WorkspaceSummary = {
      ...workspace,
      metadata: {
        projectSettings: {
          lsp: {
            enabled: false,
            servers: [{ id: 'clangd', enabled: true, args: [] }],
          },
        },
      },
    };
    const view = await renderProjectSettingsModal(unrealScan(), configuredWorkspace);

    try {
      const lspTab = Array.from(
        view.container.querySelectorAll('nav [role="tab"]'),
      ).find((tab) => tab.textContent?.trim() === 'LSP');

      await act(async () => {
        (lspTab as HTMLButtonElement).click();
      });

      expect(view.container.textContent).toMatch(/已启用\s*0/);
      const checkboxes = Array.from(
        view.container.querySelectorAll('input[type="checkbox"]'),
      ) as HTMLInputElement[];
      expect(checkboxes.every((checkbox) => !checkbox.checked)).toBe(true);
    } finally {
      await view.cleanup();
    }
  });

  it('auto-detects available recommended LSP commands without enabling them', async () => {
    const view = await renderProjectSettingsModal();

    try {
      vi.mocked(tauriAvailable).mockReturnValue(true);
      vi.mocked(probeProjectLspServer).mockResolvedValue({
        serverId: 'clangd',
        ok: true,
        status: 'available',
        message: '命令可用：C:\\Program Files\\LLVM\\bin\\clangd.exe',
        resolvedCommand: 'C:\\Program Files\\LLVM\\bin\\clangd.exe',
        checkedAtMs: 1,
      });

      const lspTab = Array.from(
        view.container.querySelectorAll('nav [role="tab"]'),
      ).find((tab) => tab.textContent?.trim() === 'LSP');

      await act(async () => {
        (lspTab as HTMLButtonElement).click();
      });
      await settle();

      const registrySubTab = Array.from(
        view.container.querySelectorAll('button'),
      ).find((button) => button.textContent?.trim().startsWith('仓库'));
      await act(async () => {
        (registrySubTab as HTMLButtonElement).click();
      });
      await settle();

      expect(probeProjectLspServer).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'clangd',
          command: 'clangd',
        }),
      );
      expect(view.container.textContent).toContain('命令可用');
      expect(view.container.textContent).toContain('已安装');
    } finally {
      await view.cleanup();
    }
  });
});
