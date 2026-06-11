import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadMcpRegistryServers,
  MCP_CATALOG,
  rankMcpServers,
  type McpServerDefinition,
} from './mcpCatalog';

const registryServer = (
  patch: Partial<McpServerDefinition>,
): McpServerDefinition => ({
  id: 'registry:test',
  title: 'Test MCP',
  category: 'cloud',
  description: 'Remote MCP server',
  transport: 'streamable-http',
  command: '',
  args: [],
  env: {},
  install: '远程 MCP',
  sourceUrl: 'https://example.com/mcp',
  connectionUrl: 'https://example.com/mcp',
  tags: ['mcp', 'registry'],
  recommendationPriority: 20,
  trust: 'registry',
  installable: false,
  ...patch,
});

describe('mcpCatalog', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads only the latest MCP Registry version for each server name', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            servers: [
              {
                server: {
                  name: 'example.com/docs',
                  title: 'Docs MCP',
                  description: 'Old docs server',
                  version: '1.0.0',
                  remotes: [{ type: 'streamable-http', url: 'https://old.example.com/mcp' }],
                },
                _meta: {
                  'io.modelcontextprotocol.registry/official': { isLatest: false },
                },
              },
              {
                server: {
                  name: 'example.com/docs',
                  title: 'Docs MCP',
                  description: 'New docs server',
                  version: '2.0.0',
                  remotes: [{ type: 'streamable-http', url: 'https://new.example.com/mcp' }],
                },
                _meta: {
                  'io.modelcontextprotocol.registry/official': { isLatest: true },
                },
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );

    const servers = await loadMcpRegistryServers();

    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({
      title: 'Docs MCP',
      version: '2.0.0',
      connectionUrl: 'https://new.example.com/mcp',
      installable: false,
    });
  });

  it('merges registry MCP entries into the MCP catalog without duplicate local entries', () => {
    const ranked = rankMcpServers('', [
      registryServer({
        id: 'registry:filesystem',
        title: 'Filesystem',
        sourceUrl: 'https://registry.example.com/filesystem',
      }),
      registryServer({
        id: 'registry:abmeter',
        title: 'ABMeter',
        sourceUrl: 'https://abmeter.ai',
        connectionUrl: 'https://mcp.abmeter.ai',
      }),
    ]);

    expect(ranked.filter((server) => server.title === 'Filesystem')).toHaveLength(1);
    expect(ranked.some((server) => server.id === 'registry:abmeter')).toBe(true);
  });

  it('keeps distinct registry servers with the same generic title', () => {
    const ranked = rankMcpServers('generic', [
      registryServer({
        id: 'registry:generic-one',
        registryName: 'vendor.one/generic',
        title: 'Generic MCP Server',
        sourceUrl: 'https://one.example.com',
        connectionUrl: 'https://one.example.com/mcp',
        tags: ['generic'],
      }),
      registryServer({
        id: 'registry:generic-two',
        registryName: 'vendor.two/generic',
        title: 'Generic MCP Server',
        sourceUrl: 'https://two.example.com',
        connectionUrl: 'https://two.example.com/mcp',
        tags: ['generic'],
      }),
    ]);

    expect(ranked.filter((server) => server.title === 'Generic MCP Server')).toHaveLength(2);
  });

  it('ships game-engine MCP servers in the catalog', () => {
    const gameServers = MCP_CATALOG.filter((server) => server.category === 'game');
    const ids = gameServers.map((server) => server.id);
    expect(ids).toEqual(
      expect.arrayContaining(['blender-mcp', 'unity-mcp', 'unreal-mcp', 'godot-mcp']),
    );
    // Engine MCP servers touch the user's editor, so they require approval.
    expect(gameServers.every((server) => server.requiresUserApproval === true)).toBe(true);
  });

  it('surfaces game MCP servers via free-text search', () => {
    const ranked = rankMcpServers('unity');
    expect(ranked[0]?.id).toBe('unity-mcp');
  });
});
