import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ProjectSettingsModal from './ProjectSettingsModal';
import { DEFAULT_GAME_EXPERT_SETTINGS } from '@/lib/gameExperts';
import {
  remoteWorkspacePath,
} from '@/lib/remoteWorkspace';
import {
  blueprintModeInstall,
  blueprintModeStatus,
  blueprintModeUninstall,
  listWorkspaceDirectory,
  probeProjectLspServer,
  scanProjectEnvironment,
  tauriAvailable,
  type ProjectEnvironmentScan,
} from '@/lib/tauri';
import type { WorkspaceSummary } from '@/store/history/types';
import { historyStore } from '@/store/history/store';
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
    installSkillFromText: vi.fn(),
    installSkillFromUrl: vi.fn(),
    uninstallSkill: vi.fn(),
    listWorkspaceDirectory: vi.fn(),
    blueprintModeStatus: vi.fn(),
    blueprintModeInstall: vi.fn(),
    blueprintModeUninstall: vi.fn(),
    tauriAvailable: vi.fn(() => false),
    scanProjectEnvironment: vi.fn(),
    unityMcpSetupProject: vi.fn(),
    godotMcpSetupProject: vi.fn(),
    cocosMcpSetupProject: vi.fn(),
    ueMcpEnsureBinary: vi.fn(),
    ueMcpSetupProject: vi.fn(),
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

function unityScan(): ProjectEnvironmentScan {
  return {
    rootPath: workspace.path,
    scannedAtMs: 1,
    engine: {
      engine: 'unity',
      label: 'Unity',
      confidence: 0.94,
      version: '2022.3.62f1',
      markers: ['Packages/manifest.json', 'ProjectSettings/'],
    },
    skillRoots: [],
    suggestedMcpServers: [
      {
        id: 'unity-mcp',
        label: 'Unity MCP',
        description: 'MCP for Unity',
        transport: 'stdio',
        command: 'uvx',
        args: ['--from', 'mcpforunityserver', 'mcp-for-unity', '--transport', 'stdio'],
        env: {},
        url: null,
        available: true,
        availabilityNote: 'ok',
        requiresUserApproval: true,
      },
    ],
  };
}

function cocosScan(): ProjectEnvironmentScan {
  return {
    rootPath: workspace.path,
    scannedAtMs: 1,
    engine: {
      engine: 'cocos',
      label: 'Cocos',
      confidence: 0.86,
      markers: ['project.json', 'assets/'],
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
  onClose: ReturnType<typeof vi.fn>;
  cleanup: () => Promise<void>;
}> {
  const onClose = vi.fn();
  vi.mocked(tauriAvailable).mockReturnValue(false);
  vi.mocked(scanProjectEnvironment).mockResolvedValue(scan);
  useStore.setState({
    locale: 'zh-CN',
    gameExpertSettings: DEFAULT_GAME_EXPERT_SETTINGS,
  });

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  await act(async () => {
    root.render(<ProjectSettingsModal workspace={targetWorkspace} onClose={onClose} />);
  });
  await settle();

  return {
    container,
    onClose,
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

// The MCP / LSP / Skills tabs were migrated to the global Settings modal, which
// renders ProjectSettingsModal in embedded single-tab mode. These helpers render
// that exact embedded content so the migrated behavior stays covered here.
async function renderEmbeddedProjectTab(
  embedTab: 'mcp' | 'lsp' | 'skills',
  scan: ProjectEnvironmentScan = unrealScan(),
  targetWorkspace: WorkspaceSummary = workspace,
  tauri = false,
): Promise<{
  container: HTMLDivElement;
  cleanup: () => Promise<void>;
}> {
  vi.mocked(tauriAvailable).mockReturnValue(tauri);
  vi.mocked(scanProjectEnvironment).mockResolvedValue(scan);
  useStore.setState({
    locale: 'zh-CN',
    gameExpertSettings: DEFAULT_GAME_EXPERT_SETTINGS,
  });

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  await act(async () => {
    root.render(
      <ProjectSettingsModal
        workspace={targetWorkspace}
        embedTab={embedTab}
        onClose={() => undefined}
      />,
    );
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

describe('ProjectSettingsModal game project tabs', () => {
  it('keeps the modal open when the backdrop is clicked', async () => {
    const view = await renderProjectSettingsModal();

    try {
      const backdrop = view.container.firstElementChild as HTMLDivElement;
      await act(async () => {
        backdrop.click();
      });

      expect(view.onClose).not.toHaveBeenCalled();

      const dialog = view.container.querySelector<HTMLElement>(
        '[aria-labelledby="project-settings-title"]',
      );
      const closeButton = dialog?.querySelector<HTMLButtonElement>(
        'button[aria-label="关闭"]',
      );
      expect(closeButton).toBeInstanceOf(HTMLButtonElement);

      await act(async () => {
        closeButton?.click();
      });

      expect(view.onClose).toHaveBeenCalledTimes(1);
    } finally {
      await view.cleanup();
    }
  });

  it('shows only project-scoped game tools for Unreal projects', async () => {
    const view = await renderProjectSettingsModal();

    try {
      const tabText = Array.from(
        view.container.querySelectorAll('nav [role="tab"]'),
      ).map((tab) => tab.textContent?.trim());

      expect(tabText).toEqual([
        '概览',
        '知识库',
        '技能学习',
        '蓝图',
        '权限/自动化',
      ]);
      expect(tabText).not.toContain('游戏功能');
      expect(tabText).not.toContain('MCP');
      expect(tabText).not.toContain('LSP');
      expect(tabText).not.toContain('Skills');
    } finally {
      await view.cleanup();
    }
  });

  it('detects installed BlueprintMode and exposes update/uninstall actions', async () => {
    vi.mocked(blueprintModeStatus).mockResolvedValue({
      ok: true,
      sourceUrl: 'https://github.com/wellingfeng/ue-blueprint-mode',
      targetDir: `${workspace.path}\\Plugins\\BlueprintMode`,
      exists: true,
      installed: true,
      upluginPath: `${workspace.path}\\Plugins\\BlueprintMode\\BlueprintMode.uplugin`,
      versionName: '0.1.0',
      notes: ['已检测到 BlueprintMode 插件。'],
      warnings: [],
      error: null,
    });
    vi.mocked(blueprintModeInstall).mockResolvedValue({
      ok: true,
      sourceUrl: 'https://github.com/wellingfeng/ue-blueprint-mode',
      targetDir: `${workspace.path}\\Plugins\\BlueprintMode`,
      filesCopied: 3,
      replacedExisting: true,
      notes: ['已从 GitHub 下载并安装 3 个文件。'],
      warnings: [],
      error: null,
    });
    vi.mocked(blueprintModeUninstall).mockResolvedValue({
      ok: true,
      targetDir: `${workspace.path}\\Plugins\\BlueprintMode`,
      removed: true,
      notes: ['已卸载 BlueprintMode 插件。'],
      warnings: [],
      error: null,
    });

    const view = await renderProjectSettingsModal();

    try {
      vi.mocked(tauriAvailable).mockReturnValue(true);
      const blueprintTab = Array.from(
        view.container.querySelectorAll('nav [role="tab"]'),
      ).find((tab) => tab.textContent?.trim() === '蓝图');

      await act(async () => {
        (blueprintTab as HTMLButtonElement).click();
      });
      await settle();

      expect(blueprintModeStatus).toHaveBeenCalledWith({
        rootPath: workspace.path,
        targetDir: null,
      });
      expect(view.container.textContent).toContain('已安装');
      expect(view.container.textContent).toContain('更新 BlueprintMode');
      expect(view.container.textContent).toContain('卸载 BlueprintMode');

      const updateButton = Array.from(
        view.container.querySelectorAll<HTMLButtonElement>('button'),
      ).find((button) => button.textContent?.trim() === '更新 BlueprintMode');
      await act(async () => {
        updateButton?.click();
      });
      await settle();
      expect(blueprintModeInstall).toHaveBeenCalledWith({
        rootPath: workspace.path,
        targetDir: null,
        overwrite: true,
      });

      const uninstallButton = Array.from(
        view.container.querySelectorAll<HTMLButtonElement>('button'),
      ).find((button) => button.textContent?.trim() === '卸载 BlueprintMode');
      await act(async () => {
        uninstallButton?.click();
      });
      await settle();
      expect(blueprintModeUninstall).toHaveBeenCalledWith({
        rootPath: workspace.path,
        targetDir: null,
      });
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
        '知识库',
        '技能学习',
        '权限/自动化',
      ]);
      expect(tabText).not.toContain('Mesh 渠道');
      expect(tabText).not.toContain('Sprite');
      expect(tabText).not.toContain('UI 渠道');
      expect(tabText).not.toContain('绑定渠道');
      expect(tabText).not.toContain('抓帧/性能');
      expect(tabText).not.toContain('游戏专家');
      expect(tabText).not.toContain('蓝图');
      expect(tabText).not.toContain('命令');
      expect(tabText).not.toContain('MCP');
      expect(tabText).not.toContain('LSP');
      expect(tabText).not.toContain('Skills');
    } finally {
      await view.cleanup();
    }
  });

  it('does not open retired cloud settings or probe their environment', async () => {
    const previousScanCalls = vi.mocked(scanProjectEnvironment).mock.calls.length;
    const view = await renderProjectSettingsModal(unknownScan(), {
      id: 'w_remote', path: remoteWorkspacePath('rw_project'),
      name: '旧云端项目', updatedAt: 1, sessionCount: 0,
    });
    try {
      expect(vi.mocked(scanProjectEnvironment).mock.calls).toHaveLength(previousScanCalls);
      expect(view.container.innerHTML).toBe('');
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
          path: 'E:\\UltraGameStudio\\.codex\\skills',
          exists: false,
          skillCount: 0,
          skills: [],
        },
        {
          id: 'agents',
          label: 'Agents 项目 Skill',
          path: 'E:\\UltraGameStudio\\.agents\\skills',
          exists: false,
          skillCount: 0,
          skills: [],
        },
        {
          id: 'claude',
          label: 'Claude 项目 Skill',
          path: 'E:\\UltraGameStudio\\.claude\\skills',
          exists: false,
          skillCount: 0,
          skills: [],
        },
      ],
    };
    const view = await renderEmbeddedProjectTab('skills', scan, {
      ...workspace,
      path: 'E:\\UltraGameStudio',
      name: 'UltraGameStudio',
    });

    try {
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

  it('does not scan workspace languages for embedded MCP or Skills tabs', async () => {
    vi.mocked(listWorkspaceDirectory).mockClear();
    vi.mocked(listWorkspaceDirectory).mockResolvedValue({
      rootPath: workspace.path,
      relativePath: '',
      entries: [],
      truncated: false,
      totalEntries: 0,
    });

    const mcpView = await renderEmbeddedProjectTab('mcp', unrealScan(), workspace, true);
    try {
      expect(listWorkspaceDirectory).not.toHaveBeenCalled();
    } finally {
      await mcpView.cleanup();
    }

    const skillsView = await renderEmbeddedProjectTab(
      'skills',
      unrealScan(),
      workspace,
      true,
    );
    try {
      expect(listWorkspaceDirectory).not.toHaveBeenCalled();
    } finally {
      await skillsView.cleanup();
    }
  });

  it('runs workspace language scan only when the embedded LSP tab is active', async () => {
    const lspWorkspace: WorkspaceSummary = { ...workspace, id: 'w_lsp_scan' };
    vi.spyOn(historyStore, 'getWorkspace').mockResolvedValue(null);
    vi.mocked(listWorkspaceDirectory).mockClear();
    vi.mocked(probeProjectLspServer).mockResolvedValue({
      serverId: 'test',
      ok: false,
      status: 'missing',
      message: '未检测',
      resolvedCommand: null,
      checkedAtMs: 1,
    });
    vi.mocked(listWorkspaceDirectory).mockResolvedValue({
      rootPath: lspWorkspace.path,
      relativePath: '',
      entries: [
        {
          relativePath: 'Source/Game.cpp',
          path: `${lspWorkspace.path}\\Source\\Game.cpp`,
          hidden: false,
          sizeBytes: 100,
          modifiedAtMs: null,
          kind: 'file',
          name: 'Game.cpp',
        },
      ],
      truncated: false,
      totalEntries: 1,
    });

    const view = await renderEmbeddedProjectTab('lsp', unrealScan(), lspWorkspace, true);

    try {
      await settle();
      expect(listWorkspaceDirectory).toHaveBeenCalledTimes(1);
      expect(view.container.textContent).toContain('C / C++');
    } finally {
      await view.cleanup();
    }
  });

  it('switches embedded tool tabs without rerunning project detection', async () => {
    const rerenderWorkspace: WorkspaceSummary = { ...workspace, id: 'w_embed_rerender' };
    vi.mocked(scanProjectEnvironment).mockClear();
    vi.mocked(tauriAvailable).mockReturnValue(false);
    vi.mocked(scanProjectEnvironment).mockResolvedValue(unrealScan());
    useStore.setState({
      locale: 'zh-CN',
      gameExpertSettings: DEFAULT_GAME_EXPERT_SETTINGS,
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          <ProjectSettingsModal
            workspace={rerenderWorkspace}
            embedTab="mcp"
            onClose={() => undefined}
          />,
        );
      });
      await settle();
      expect(scanProjectEnvironment).toHaveBeenCalledTimes(1);
      expect(container.textContent).toContain('游戏 MCP 候选');

      await act(async () => {
        root.render(
          <ProjectSettingsModal
            workspace={rerenderWorkspace}
            embedTab="lsp"
            onClose={() => undefined}
          />,
        );
      });
      await settle();

      expect(scanProjectEnvironment).toHaveBeenCalledTimes(1);
      expect(container.textContent).toContain('Language Server Protocol');
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('renders recommended LSP servers under the LSP tab', async () => {
    const view = await renderEmbeddedProjectTab('lsp');

    try {
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
    const mcpView = await renderEmbeddedProjectTab('mcp', unknownScan());

    try {
      const mcpSwitch = mcpView.container.querySelector(
        'input[type="checkbox"]',
      ) as HTMLInputElement | null;
      expect(mcpSwitch?.checked).toBe(false);
    } finally {
      await mcpView.cleanup();
    }

    const lspView = await renderEmbeddedProjectTab('lsp', unknownScan());

    try {
      const lspSwitch = lspView.container.querySelector(
        'input[type="checkbox"]',
      ) as HTMLInputElement | null;
      expect(lspSwitch?.checked).toBe(false);
      expect(lspView.container.textContent).toMatch(/已启用\s*0/);
    } finally {
      await lspView.cleanup();
    }
  });

  it('shows only project-scoped game tools for detected Cocos projects', async () => {
    const view = await renderProjectSettingsModal(cocosScan());

    try {
      const tabText = Array.from(
        view.container.querySelectorAll('nav [role="tab"]'),
      ).map((tab) => tab.textContent?.trim());

      expect(tabText).not.toContain('Mesh 渠道');
      expect(tabText).not.toContain('UI 渠道');
      expect(tabText).not.toContain('在线模型库');
      expect(tabText).not.toContain('绑定渠道');
      expect(tabText).not.toContain('抓帧性能');
      expect(tabText).not.toContain('游戏专家');
      expect(tabText).not.toContain('命令');
      expect(tabText).not.toContain('蓝图');
      expect(view.container.textContent).toContain('游戏项目：开启');
    } finally {
      await view.cleanup();
    }
  });

  it('lets users manually enable project-scoped game tools for unrecognized engines', async () => {
    const view = await renderProjectSettingsModal(unknownScan());

    try {
      expect(
        Array.from(view.container.querySelectorAll('nav [role="tab"]')).map((tab) =>
          tab.textContent?.trim(),
        ),
      ).not.toContain('Mesh 渠道');

      const gameProjectSwitch = Array.from(
        view.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
      ).find((input) =>
        input.closest('label')?.textContent?.includes('这是游戏项目'),
      );
      expect(gameProjectSwitch).toBeInstanceOf(HTMLInputElement);
      await act(async () => {
        gameProjectSwitch?.click();
      });

      const tabText = Array.from(
        view.container.querySelectorAll('nav [role="tab"]'),
      ).map((tab) => tab.textContent?.trim());

      expect(tabText).not.toContain('Mesh 渠道');
      expect(tabText).not.toContain('UI 渠道');
      expect(tabText).not.toContain('在线模型库');
      expect(tabText).not.toContain('绑定渠道');
      expect(tabText).not.toContain('抓帧性能');
      expect(tabText).not.toContain('游戏专家');
      expect(tabText).not.toContain('命令');
      expect(tabText).not.toContain('蓝图');
    } finally {
      await view.cleanup();
    }
  });

  it('shows one-click Unity MCP setup for Unity projects', async () => {
    const view = await renderEmbeddedProjectTab('mcp', unityScan());

    try {
      expect(view.container.textContent).toContain('Unity MCP');
      expect(view.container.textContent).toContain(
        'Packages/manifest.json',
      );
      expect(view.container.textContent).toContain('.mcp.json');
    } finally {
      await view.cleanup();
    }
  });

  it('always shows all game MCP candidates even when the project engine is unknown', async () => {
    const view = await renderEmbeddedProjectTab('mcp', unknownScan());

    try {
      expect(view.container.textContent).toContain('游戏 MCP 候选');
      expect(view.container.textContent).toContain('Unity MCP');
      expect(view.container.textContent).toContain('Unreal MCP');
      expect(view.container.textContent).toContain('Godot MCP');
      expect(view.container.textContent).toContain('Cocos MCP');
      expect(view.container.textContent).toContain(
        'uvx --from mcpforunityserver mcp-for-unity --transport stdio',
      );
      expect(view.container.textContent).toContain(
        'https://github.com/wellingfeng/unity-mcp',
      );
      expect(view.container.textContent).toContain('ue-mcp-for-all-versions.exe');
      expect(view.container.textContent).toContain(
        'https://github.com/wellingfeng/ue-mcp-for-all-versions',
      );
      expect(view.container.textContent).toContain(
        '是否安装由用户自己决定',
      );
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
    const view = await renderEmbeddedProjectTab(
      'lsp',
      unrealScan(),
      configuredWorkspace,
    );

    try {
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
    vi.mocked(tauriAvailable).mockReturnValue(true);
    vi.mocked(probeProjectLspServer).mockResolvedValue({
      serverId: 'clangd',
      ok: true,
      status: 'available',
      message: '命令可用：C:\\Program Files\\LLVM\\bin\\clangd.exe',
      resolvedCommand: 'C:\\Program Files\\LLVM\\bin\\clangd.exe',
      checkedAtMs: 1,
    });
    const view = await renderEmbeddedProjectTab('lsp');

    try {
      // The probe effect skips while Tauri is unavailable. Switch to the registry
      // sub-tab, enable Tauri, then change the LSP search query (an effect
      // dependency) to re-run availability probes — mirroring the former
      // tab-switch trigger before the migration.
      const registrySubTab = Array.from(
        view.container.querySelectorAll('button'),
      ).find((button) => button.textContent?.trim().startsWith('仓库'));
      await act(async () => {
        (registrySubTab as HTMLButtonElement).click();
      });
      await settle();

      vi.mocked(tauriAvailable).mockReturnValue(true);
      const searchInput = view.container.querySelector(
        'input[placeholder*="搜索语言"]',
      ) as HTMLInputElement | null;
      await act(async () => {
        if (searchInput) {
          const setter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype,
            'value',
          )?.set;
          setter?.call(searchInput, 'clang');
          searchInput.dispatchEvent(new Event('input', { bubbles: true }));
        }
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


describe('ProjectSettingsModal tool catalogue', () => {
  it('renders cached MCP schemas through the shared directory component', async () => {
    const configured: WorkspaceSummary = { ...workspace, metadata: { projectSettings: {
      mcp: { enabled: true, servers: [{ id: 'fixture', label: '目录测试服务', source: 'custom', enabled: true,
        transport: 'stdio', args: [], env: {}, lastProbe: { serverId: 'fixture', ok: true, status: 'connected',
          message: '分页发现完成', checkedAtMs: 10, catalogCoverage: 'full', tools: [
            { name: 'fixture_lookup', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
          ] } }] },
    } } };
    const view = await renderEmbeddedProjectTab('mcp', unknownScan(), configured);
    try {
      expect(view.container.textContent).toContain('查看项目发现工具');
      expect(view.container.textContent).toContain('fixture_lookup');
      expect(view.container.textContent).toContain('仅上次发现');
      expect(view.container.querySelector('pre')?.textContent).toContain('query');
    } finally { await view.cleanup(); }
  });
});
