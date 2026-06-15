import { describe, expect, it } from 'vitest';
import {
  emptyProjectSettings,
  gameFeatureDefaultsForEngine,
  mergeRecommendedMcpServers,
  PREFERRED_UNREAL_MCP_SERVER_ID,
  preferUnrealMcpServer,
  projectSettingsFromMetadata,
  settingsWithDetectedGameFeatures,
  uiDesignDefaultsForEngine,
} from './projectSettings';
import type { ProjectEngineKind, ProjectEnvironmentScan } from './tauri';

function scanForEngine(
  engine: ProjectEngineKind,
): Pick<ProjectEnvironmentScan, 'engine'> {
  return {
    engine: {
      engine,
      label:
        engine === 'unity'
          ? 'Unity'
          : engine === 'unreal'
            ? 'Unreal Engine'
            : engine === 'godot'
              ? 'Godot'
              : engine === 'cocos'
                ? 'Cocos'
                : '未识别',
      confidence: engine === 'unknown' ? 0 : 0.95,
      markers: [],
    },
  };
}

describe('project settings game features', () => {
  it('keeps game-related features off by default', () => {
    expect(emptyProjectSettings().gameFeatures).toEqual({
      isGameProject: false,
      meshGeneration: false,
      rigging: false,
      capturePerf: false,
      gameExperts: false,
      gameExpertEngine: 'auto',
    });
    expect(emptyProjectSettings().mcp).toEqual({
      enabled: false,
      servers: [],
    });
    expect(emptyProjectSettings().lsp).toEqual({
      enabled: false,
      servers: [],
    });
    expect(emptyProjectSettings().uiDesign).toEqual({
      enabled: false,
      mode: 'commercial',
      defaultChannelId: 'figma',
    });
    expect(gameFeatureDefaultsForEngine('unknown')).toEqual(
      emptyProjectSettings().gameFeatures,
    );
    expect(uiDesignDefaultsForEngine('unknown')).toEqual(
      emptyProjectSettings().uiDesign,
    );
  });

  it('turns on Mesh, rigging, and game experts for detected game engines', () => {
    const settings = settingsWithDetectedGameFeatures(
      emptyProjectSettings(),
      scanForEngine('unity'),
    );

    expect(settings.engine).toBe('unity');
    expect(settings.gameFeatures).toEqual({
      isGameProject: true,
      meshGeneration: true,
      rigging: true,
      capturePerf: true,
      gameExperts: true,
      gameExpertEngine: 'unity',
    });
    expect(settings.uiDesign).toEqual({
      enabled: true,
      mode: 'commercial',
      defaultChannelId: 'figma',
    });
  });

  it('turns on game project tabs for detected Cocos projects', () => {
    const settings = settingsWithDetectedGameFeatures(
      emptyProjectSettings(),
      scanForEngine('cocos'),
    );

    expect(settings.engine).toBe('cocos');
    expect(settings.gameFeatures).toEqual({
      isGameProject: true,
      meshGeneration: true,
      rigging: true,
      capturePerf: true,
      gameExperts: true,
      gameExpertEngine: 'auto',
    });
    expect(settings.uiDesign).toEqual({
      enabled: true,
      mode: 'commercial',
      defaultChannelId: 'figma',
    });
  });

  it('turns game-related features off for non-game projects', () => {
    const current = {
      ...emptyProjectSettings(),
      gameFeatures: gameFeatureDefaultsForEngine('unreal'),
    };

    const settings = settingsWithDetectedGameFeatures(
      current,
      scanForEngine('unknown'),
    );

    expect(settings.engine).toBe('unknown');
    expect(settings.gameFeatures).toEqual(emptyProjectSettings().gameFeatures);
    expect(settings.uiDesign).toEqual(emptyProjectSettings().uiDesign);
  });

  it('preserves manual project settings when auto detection is disabled', () => {
    const current = {
      ...emptyProjectSettings(),
      automation: {
        ...emptyProjectSettings().automation,
        autoDetect: false,
      },
      gameFeatures: {
        isGameProject: true,
        meshGeneration: true,
        rigging: false,
        capturePerf: true,
        gameExperts: true,
        gameExpertEngine: 'godot' as const,
      },
    };

    const settings = settingsWithDetectedGameFeatures(
      current,
      scanForEngine('unknown'),
    );

    expect(settings).toEqual(current);
  });

  it('normalizes persisted game feature settings', () => {
    const settings = projectSettingsFromMetadata({
      projectSettings: {
        gameFeatures: {
          isGameProject: true,
          meshGeneration: true,
          rigging: true,
          capturePerf: true,
          gameExperts: true,
          gameExpertEngine: 'unreal',
        },
      },
    });

    expect(settings.gameFeatures).toEqual({
      isGameProject: true,
      meshGeneration: true,
      rigging: true,
      capturePerf: true,
      gameExperts: true,
      gameExpertEngine: 'unreal',
    });
  });

  it('keeps an explicitly disabled game project switch off', () => {
    const settings = projectSettingsFromMetadata({
      projectSettings: {
        gameFeatures: {
          isGameProject: false,
          meshGeneration: true,
          rigging: true,
          capturePerf: true,
          gameExperts: true,
          gameExpertEngine: 'unreal',
        },
      },
    });

    expect(settings.gameFeatures).toEqual({
      isGameProject: false,
      meshGeneration: false,
      rigging: false,
      capturePerf: false,
      gameExperts: false,
      gameExpertEngine: 'unreal',
    });
  });

  it('normalizes persisted UI design channel settings', () => {
    const settings = projectSettingsFromMetadata({
      projectSettings: {
        uiDesign: {
          enabled: true,
          mode: 'free-open',
          defaultChannelId: 'figma',
        },
      },
    });

    // The default UI channel is project-wide and independent of the viewed
    // category tab (mode), so a commercial channel stays selected even when the
    // free-open tab is active.
    expect(settings.uiDesign).toEqual({
      enabled: true,
      mode: 'free-open',
      defaultChannelId: 'figma',
    });
  });

  it('normalizes persisted LSP settings', () => {
    const settings = projectSettingsFromMetadata({
      projectSettings: {
        lsp: {
          enabled: true,
          servers: [
            {
              id: 'clangd',
              enabled: true,
              command: 'clangd',
              args: ['--background-index'],
              lastProbe: {
                serverId: 'clangd',
                ok: true,
                status: 'available',
                message: 'ok',
                checkedAtMs: 1,
              },
            },
            { id: '', enabled: true },
          ],
        },
      },
    });

    expect(settings.lsp.servers).toEqual([
      {
        id: 'clangd',
        enabled: true,
        source: 'catalog',
        command: 'clangd',
        args: ['--background-index'],
        lastProbe: {
          serverId: 'clangd',
          ok: true,
          status: 'available',
          message: 'ok',
          checkedAtMs: 1,
        },
      },
    ]);
  });

  it('only enables MCP/LSP by default when legacy metadata has configured servers', () => {
    const empty = projectSettingsFromMetadata({ projectSettings: {} });
    expect(empty.mcp.enabled).toBe(false);
    expect(empty.lsp.enabled).toBe(false);

    const legacy = projectSettingsFromMetadata({
      projectSettings: {
        mcp: {
          servers: [
            {
              id: 'custom-mcp',
              label: 'Custom MCP',
              enabled: true,
              args: [],
              env: {},
            },
          ],
        },
        lsp: {
          servers: [{ id: 'clangd', enabled: true, args: [] }],
        },
      },
    });
    expect(legacy.mcp.enabled).toBe(true);
    expect(legacy.lsp.enabled).toBe(true);

    const explicitlyDisabled = projectSettingsFromMetadata({
      projectSettings: {
        mcp: {
          enabled: false,
          servers: [{ id: 'custom-mcp', label: 'Custom MCP', enabled: true }],
        },
        lsp: {
          enabled: false,
          servers: [{ id: 'clangd', enabled: true }],
        },
      },
    });
    expect(explicitlyDisabled.mcp.enabled).toBe(false);
    expect(explicitlyDisabled.lsp.enabled).toBe(false);
  });

  it('prefers ue-mcp-for-all-versions over older Unreal MCP servers', () => {
    const current = {
      ...emptyProjectSettings(),
      mcp: {
        enabled: true,
        servers: [
          {
            id: 'unreal-mcp',
            label: 'Unreal Engine MCP',
            description: 'Built-in Unreal editor MCP',
            source: 'custom' as const,
            enabled: true,
            transport: 'stdio',
            command: 'unreal-mcp',
            args: [],
            env: {},
          },
          {
            id: 'filesystem',
            label: 'Filesystem',
            source: 'custom' as const,
            enabled: true,
            transport: 'stdio',
            command: 'mcp-server-filesystem',
            args: ['{workspace}'],
            env: {},
          },
        ],
      },
    };

    const next = preferUnrealMcpServer(current, {
      id: PREFERRED_UNREAL_MCP_SERVER_ID,
      label: 'Unreal MCP (全版本)',
      source: 'suggested',
      enabled: true,
      transport: 'stdio',
      command: 'C:\\tools\\ue-mcp-for-all-versions.exe',
      args: [],
      env: {},
    });

    expect(next.mcp.servers[0].id).toBe(PREFERRED_UNREAL_MCP_SERVER_ID);
    expect(next.mcp.servers.find((server) => server.id === 'unreal-mcp')?.enabled).toBe(false);
    expect(next.mcp.servers.find((server) => server.id === 'filesystem')?.enabled).toBe(true);
  });

  it('applies the same Unreal MCP preference when merging recommendations', () => {
    const current = {
      ...emptyProjectSettings(),
      mcp: {
        enabled: true,
        servers: [
          {
            id: 'unreal',
            label: 'UE MCP',
            source: 'custom' as const,
            enabled: true,
            transport: 'stdio',
            command: 'ue-mcp',
            args: [],
            env: {},
          },
        ],
      },
    };
    const scan: ProjectEnvironmentScan = {
      rootPath: 'E:\\Game',
      scannedAtMs: 1,
      skillRoots: [],
      engine: scanForEngine('unreal').engine,
      suggestedMcpServers: [
        {
          id: PREFERRED_UNREAL_MCP_SERVER_ID,
          label: 'Unreal MCP (全版本)',
          description: '版本无关的 Unreal RemoteControl MCP',
          transport: 'stdio',
          command: 'C:\\tools\\ue-mcp-for-all-versions.exe',
          args: [],
          env: {},
          url: null,
          available: true,
          availabilityNote: 'ok',
          requiresUserApproval: true,
        },
      ],
    };

    const next = mergeRecommendedMcpServers(current, scan);

    expect(next.mcp.servers.map((server) => [server.id, server.enabled])).toEqual([
      [PREFERRED_UNREAL_MCP_SERVER_ID, true],
      ['unreal', false],
    ]);
  });

  it('adds the Unity MCP recommendation for Unity projects', () => {
    const scan: ProjectEnvironmentScan = {
      rootPath: 'E:\\Game',
      scannedAtMs: 1,
      skillRoots: [],
      engine: scanForEngine('unity').engine,
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
        {
          id: PREFERRED_UNREAL_MCP_SERVER_ID,
          label: 'Unreal MCP (全版本)',
          description: '版本无关的 Unreal RemoteControl MCP',
          transport: 'stdio',
          command: 'ue-mcp-for-all-versions',
          args: [],
          env: {},
          url: null,
          available: false,
          availabilityNote: 'missing',
          requiresUserApproval: true,
        },
        {
          id: 'godot-mcp',
          label: 'Godot MCP',
          description: 'wellingfeng Godot MCP',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@coding-solo/godot-mcp'],
          env: { GODOT_PATH: '' },
          url: null,
          available: true,
          availabilityNote: 'ok',
          requiresUserApproval: true,
        },
        {
          id: 'cocos-mcp-server',
          label: 'Cocos MCP',
          description: 'wellingfeng Cocos MCP',
          transport: 'streamable-http',
          command: 'npx',
          args: ['-y', 'mcp-remote', 'http://localhost:3000/mcp'],
          env: {},
          url: 'http://localhost:3000/mcp',
          available: true,
          availabilityNote: 'ok',
          requiresUserApproval: true,
        },
      ],
    };

    const next = mergeRecommendedMcpServers(emptyProjectSettings(), scan);

    expect(next.engine).toBe('unity');
    expect(next.mcp.enabled).toBe(true);
    expect(next.mcp.servers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'unity-mcp',
          command: 'uvx',
          args: ['--from', 'mcpforunityserver', 'mcp-for-unity', '--transport', 'stdio'],
          enabled: true,
          requiresUserApproval: true,
        }),
        expect.objectContaining({
          id: PREFERRED_UNREAL_MCP_SERVER_ID,
          enabled: true,
          requiresUserApproval: true,
        }),
        expect.objectContaining({
          id: 'godot-mcp',
          command: 'npx',
          args: ['-y', '@coding-solo/godot-mcp'],
          env: { GODOT_PATH: '' },
        }),
        expect.objectContaining({
          id: 'cocos-mcp-server',
          transport: 'streamable-http',
          url: 'http://localhost:3000/mcp',
        }),
      ]),
    );
  });

  it('adds the wellingfeng Godot MCP recommendation for Godot projects', () => {
    const scan: ProjectEnvironmentScan = {
      rootPath: 'E:\\Game',
      scannedAtMs: 1,
      skillRoots: [],
      engine: scanForEngine('godot').engine,
      suggestedMcpServers: [
        {
          id: 'godot-mcp',
          label: 'Godot MCP',
          description: 'wellingfeng Godot MCP',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@coding-solo/godot-mcp'],
          env: {},
          url: null,
          available: true,
          availabilityNote: 'ok',
          requiresUserApproval: true,
        },
      ],
    };

    const next = mergeRecommendedMcpServers(emptyProjectSettings(), scan);

    expect(next.engine).toBe('godot');
    expect(next.mcp.enabled).toBe(true);
    expect(next.mcp.servers).toEqual([
      expect.objectContaining({
        id: 'godot-mcp',
        command: 'npx',
        args: ['-y', '@coding-solo/godot-mcp'],
        enabled: true,
        requiresUserApproval: true,
      }),
    ]);
  });
});
