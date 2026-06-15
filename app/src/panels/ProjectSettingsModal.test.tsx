import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ProjectSettingsModal from './ProjectSettingsModal';
import { DEFAULT_GAME_EXPERT_SETTINGS } from '@/lib/gameExperts';
import {
  installSkillFromUrl,
  openExternal,
  probeProjectLspServer,
  scanProjectEnvironment,
  skillInstallTargets,
  tauriAvailable,
  uninstallSkill,
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
  cleanup: () => Promise<void>;
}> {
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
  it('splits game project capabilities into Mesh, rigging, capture/perf, expert, and command tabs', async () => {
    const view = await renderProjectSettingsModal();

    try {
      const tabText = Array.from(
        view.container.querySelectorAll('nav [role="tab"]'),
      ).map((tab) => tab.textContent?.trim());

      expect(tabText).toEqual([
        '概览',
        'Mesh 渠道',
        '在线模型库',
        'Sprite',
        'UI 渠道',
        '绑定渠道',
        '抓帧/性能',
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
      expect(tabText).not.toContain('Sprite');
      expect(tabText).not.toContain('UI 渠道');
      expect(tabText).not.toContain('绑定渠道');
      expect(tabText).not.toContain('抓帧/性能');
      expect(tabText).not.toContain('游戏专家');
      expect(tabText).not.toContain('命令');
    } finally {
      await view.cleanup();
    }
  });

  it('shows capture/performance skills with versions', async () => {
    const view = await renderProjectSettingsModal();

    try {
      const captureTab = Array.from(
        view.container.querySelectorAll('nav [role="tab"]'),
      ).find((tab) => tab.textContent?.trim() === '抓帧/性能');

      await act(async () => {
        (captureTab as HTMLButtonElement).click();
      });
      await settle();

      expect(view.container.textContent).toContain('RenderDoc GPU Debug');
      expect(view.container.textContent).toContain('Nsight Graphics CLI');
      expect(view.container.textContent).toContain('v0.2.0');
      expect(view.container.textContent).toContain('SmartPerfetto');
      expect(view.container.textContent).toContain('v1.0.33');
      expect(view.container.textContent).toContain('Android App Memory Analysis');
      expect(view.container.textContent).toContain('v1.1.0');
      expect(view.container.textContent).toContain('Unity Performance Workflow');
      expect(view.container.textContent).toContain('mcpmarket');
    } finally {
      await view.cleanup();
    }
  });

  it('can install and uninstall capture/performance skills', async () => {
    vi.mocked(skillInstallTargets).mockResolvedValue([
      {
        id: 'project-codex',
        label: 'Codex 项目 Skill',
        path: 'E:\\OpenWorkflows\\.codex\\skills',
        exists: true,
        skillCount: 1,
        skills: ['renderdoc-gpu-debug'],
        isDefault: true,
        scope: 'project',
      },
    ]);
    vi.mocked(installSkillFromUrl).mockResolvedValue({
      name: 'renderdoc-gpu-debug',
      slug: 'renderdoc-gpu-debug',
      targetId: 'project-codex',
      path: 'E:\\OpenWorkflows\\.codex\\skills\\renderdoc-gpu-debug',
      skillFile: 'E:\\OpenWorkflows\\.codex\\skills\\renderdoc-gpu-debug\\SKILL.md',
      sourceUrl: 'https://github.com/rudybear/renderdoc-skill',
      overwritten: true,
    });
    vi.mocked(uninstallSkill).mockResolvedValue({
      targetId: 'project-codex',
      slug: 'renderdoc-gpu-debug',
      path: 'E:\\OpenWorkflows\\.codex\\skills\\renderdoc-gpu-debug',
      removed: true,
    });

    const view = await renderProjectSettingsModal();

    try {
      vi.mocked(tauriAvailable).mockReturnValue(true);
      const captureTab = Array.from(
        view.container.querySelectorAll('nav [role="tab"]'),
      ).find((tab) => tab.textContent?.trim() === '抓帧/性能');

      await act(async () => {
        (captureTab as HTMLButtonElement).click();
      });
      await settle();

      const updateButton = Array.from(
        view.container.querySelectorAll<HTMLButtonElement>('button'),
      ).find((button) => button.textContent?.trim() === '更新');
      const uninstallButton = Array.from(
        view.container.querySelectorAll<HTMLButtonElement>('button'),
      ).find((button) => button.textContent?.trim() === '卸载');

      await act(async () => {
        updateButton?.click();
      });
      await settle();

      expect(installSkillFromUrl).toHaveBeenCalledWith(
        expect.objectContaining({
          slug: 'renderdoc-gpu-debug',
          targetId: 'project-codex',
          overwrite: true,
        }),
      );

      await act(async () => {
        uninstallButton?.click();
      });
      await settle();

      expect(uninstallSkill).toHaveBeenCalledWith({
        targetId: 'project-codex',
        slug: 'renderdoc-gpu-debug',
        projectRoot: workspace.path,
      });
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
        '/ui-mode-start',
        '/ui-mode-end',
      ]);
    } finally {
      await view.cleanup();
    }
  });

  it('renders Sprite project settings as parameters and flow only', async () => {
    const resolved = await historyStore.resolveWorkspaceByPath(workspace.path);
    const view = await renderProjectSettingsModal(unrealScan(), {
      id: resolved.id,
      path: resolved.path,
      name: resolved.name,
      updatedAt: resolved.updatedAt,
      sessionCount: resolved.sessionCount,
      metadata: resolved.metadata,
    });

    try {
      const spriteTab = Array.from(
        view.container.querySelectorAll('nav [role="tab"]'),
      ).find((tab) => tab.textContent?.trim() === 'Sprite');

      await act(async () => {
        (spriteTab as HTMLButtonElement).click();
      });

      expect(view.container.textContent).toContain('Sprite 动画');
      expect(view.container.textContent).toContain('/sprite-mode-start');
      expect(view.container.textContent).toContain('设计流程');
      expect(view.container.textContent).toContain('复用生图路由');
      expect(view.container.textContent).toContain('套 Sprite 协议');
      expect(view.container.textContent).toContain('本地后处理');
      expect(view.container.textContent).toContain('质检并导出');
      expect(view.container.textContent).toContain('Sheet 网格');
      expect(view.container.textContent).not.toContain('默认 Sprite 渠道');
      expect(view.container.textContent).not.toContain('商用渠道');
      expect(view.container.textContent).not.toContain('本地开源渠道');

      const enableSwitch = Array.from(
        view.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
      ).find((input) =>
        input.closest('label')?.textContent?.includes('启用 Sprite 模式'),
      );
      expect(enableSwitch).toBeInstanceOf(HTMLInputElement);
      await act(async () => {
        enableSwitch?.click();
      });

      const providerOption = Array.from(
        view.container.querySelectorAll<HTMLSelectElement>('select'),
      ).some((select) =>
        Array.from(select.options).some((option) =>
          ['ludo-sprite', 'local-comfyui-sprite'].includes(option.value),
        ),
      );
      expect(providerOption).toBe(false);

      const save = Array.from(
        view.container.querySelectorAll<HTMLButtonElement>('button'),
      ).find((button) => button.textContent?.includes('保存'));
      expect(save).toBeInstanceOf(HTMLButtonElement);
      await act(async () => {
        save?.click();
      });
      await settle();

      const saved = JSON.parse(
        window.localStorage.getItem('freeultracode.spriteGeneration.v1') ?? '{}',
      );
      expect(saved.enabled).toBe(true);
      expect(saved.preferredProviderId).toBe('ludo-sprite');
    } finally {
      await view.cleanup();
    }
  });

  it('renders UI design channels and syncs the default open-source channel on save', async () => {
    const resolved = await historyStore.resolveWorkspaceByPath(workspace.path);
    const view = await renderProjectSettingsModal(unrealScan(), {
      id: resolved.id,
      path: resolved.path,
      name: resolved.name,
      updatedAt: resolved.updatedAt,
      sessionCount: resolved.sessionCount,
      metadata: resolved.metadata,
    });

    try {
      const uiTab = Array.from(
        view.container.querySelectorAll('nav [role="tab"]'),
      ).find((tab) => tab.textContent?.trim() === 'UI 渠道');

      await act(async () => {
        (uiTab as HTMLButtonElement).click();
      });

      expect(view.container.textContent).toContain('UI 渠道');
      expect(view.container.textContent).toContain('Figma');
      expect(view.container.textContent).toContain('Adobe Photoshop');
      expect(view.container.textContent).toContain('Figma 下载');
      expect(view.container.textContent).toContain('Photoshop 下载');
      expect(view.container.textContent).not.toContain('Figma Token');
      expect(view.container.textContent).not.toContain('Base URL');
      expect(view.container.textContent).not.toContain('本地命令 / 工具路径');

      const figmaDownload = Array.from(
        view.container.querySelectorAll<HTMLButtonElement>('button'),
      ).find((button) => button.textContent?.trim() === 'Figma 下载');
      await act(async () => {
        figmaDownload?.click();
      });
      expect(openExternal).toHaveBeenCalledWith('https://www.figma.com/downloads/');

      const photoshopDownload = Array.from(
        view.container.querySelectorAll<HTMLButtonElement>('button'),
      ).find((button) => button.textContent?.trim() === 'Photoshop 下载');
      await act(async () => {
        photoshopDownload?.click();
      });
      expect(openExternal).toHaveBeenCalledWith(
        'https://www.adobe.com/products/photoshop/free-trial-download.html',
      );

      const freeOpen = Array.from(
        view.container.querySelectorAll<HTMLButtonElement>('button'),
      ).find((button) => button.textContent?.trim() === '免费开源渠道');
      expect(freeOpen).toBeInstanceOf(HTMLButtonElement);
      await act(async () => {
        freeOpen?.click();
      });

      expect(view.container.textContent).toContain('Pencil');
      expect(view.container.textContent).toContain('Penpot');
      expect(view.container.textContent).toContain('Pencil 下载');
      expect(view.container.textContent).toContain('Penpot Web');
      expect(view.container.textContent).toContain('GIMP 下载');
      expect(view.container.textContent).toContain('Inkscape 下载');
      expect(view.container.textContent).not.toContain('Base URL');
      expect(view.container.textContent).not.toContain('Penpot Token');
      expect(view.container.textContent).not.toContain('本地命令 / 工具路径');

      const pencilDownload = Array.from(
        view.container.querySelectorAll<HTMLButtonElement>('button'),
      ).find((button) => button.textContent?.trim() === 'Pencil 下载');
      await act(async () => {
        pencilDownload?.click();
      });
      expect(openExternal).toHaveBeenCalledWith('https://www.pencil.dev/downloads');

      const defaultSelect = view.container.querySelector(
        'select',
      ) as HTMLSelectElement | null;
      expect(defaultSelect).toBeInstanceOf(HTMLSelectElement);
      await act(async () => {
        if (!defaultSelect) return;
        defaultSelect.value = 'penpot';
        defaultSelect.dispatchEvent(new Event('change', { bubbles: true }));
      });

      const save = Array.from(
        view.container.querySelectorAll<HTMLButtonElement>('button'),
      ).find((button) => button.textContent?.includes('保存'));
      expect(save).toBeInstanceOf(HTMLButtonElement);
      await act(async () => {
        save?.click();
      });
      await settle();

      const saved = JSON.parse(
        window.localStorage.getItem('freeultracode.uiDesignChannels.v1') ?? '{}',
      );
      expect(saved.enabled).toBe(true);
      expect(saved.preferredChannelId).toBe('penpot');
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

  it('shows game capability tabs for detected Cocos projects', async () => {
    const view = await renderProjectSettingsModal(cocosScan());

    try {
      const tabText = Array.from(
        view.container.querySelectorAll('nav [role="tab"]'),
      ).map((tab) => tab.textContent?.trim());

      expect(tabText).toContain('Mesh 渠道');
      expect(tabText).toContain('UI 渠道');
      expect(tabText).toContain('在线模型库');
      expect(tabText).toContain('绑定渠道');
      expect(tabText).toContain('抓帧/性能');
      expect(tabText).toContain('游戏专家');
      expect(tabText).toContain('命令');
      expect(view.container.textContent).toContain('游戏项目：开启');
    } finally {
      await view.cleanup();
    }
  });

  it('lets users manually enable game capability tabs for unrecognized engines', async () => {
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

      expect(tabText).toContain('Mesh 渠道');
      expect(tabText).toContain('UI 渠道');
      expect(tabText).toContain('在线模型库');
      expect(tabText).toContain('绑定渠道');
      expect(tabText).toContain('抓帧/性能');
      expect(tabText).toContain('游戏专家');
      expect(tabText).toContain('命令');
    } finally {
      await view.cleanup();
    }
  });

  it('shows one-click Unity MCP setup for Unity projects', async () => {
    const view = await renderProjectSettingsModal(unityScan());

    try {
      const mcpTab = Array.from(
        view.container.querySelectorAll('nav [role="tab"]'),
      ).find((tab) => tab.textContent?.trim() === 'MCP');

      await act(async () => {
        (mcpTab as HTMLButtonElement).click();
      });

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
    const view = await renderProjectSettingsModal(unknownScan());

    try {
      const mcpTab = Array.from(
        view.container.querySelectorAll('nav [role="tab"]'),
      ).find((tab) => tab.textContent?.trim() === 'MCP');

      await act(async () => {
        (mcpTab as HTMLButtonElement).click();
      });

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
