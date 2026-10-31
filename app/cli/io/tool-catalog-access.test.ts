// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { toolCatalogGuidance } from './tool-catalog-access';

describe('automatic agent catalogue access', () => {
  it('advertises a read-only query only for a valid injected session, preserving native tool ownership', () => {
    const env = { UGS_TOOLS_CLI: 'C:/UGS/cli/ugs.mjs', UGS_TOOL_CATALOG_SCOPE: JSON.stringify({
      workspaceId: 'w', sessionId: 's', agentId: 'codex', providerId: 'p', channelId: 'c', model: 'm',
    }) };
    const windows = toolCatalogGuidance(env, true);
    expect(windows).toContain('node "$env:UGS_TOOLS_CLI" tools search');
    expect(windows).toContain('tools inspect');
    expect(windows).toContain('当前 Agent 原生');
    expect(windows).toContain('缓存证据');
    expect(windows).not.toContain('--session');
    expect(toolCatalogGuidance(env, false)).toContain('node "$UGS_TOOLS_CLI" tools search');
    expect(toolCatalogGuidance({})).toBe('');
    expect(toolCatalogGuidance({ ...env, UGS_TOOL_CATALOG_SCOPE: '{}' })).toBe('');
  });
});
