import { describe, expect, it, vi } from 'vitest';
import { nativeSkillToolsForCwd } from './useStore';

const tools = (cwd?: string) => ({
  source: {
    hostId: 'local', workspaceId: 'ws', sessionId: 's', turnId: 'm', runId: 'm',
    ...(cwd ? { cwd } : {}),
  },
  config: { enabled: true, mode: 'auto-safe' as const },
});

describe('nativeSkillToolsForCwd', () => {
  it('keeps tools when the CLI runs in the source project (spelling-insensitive)', () => {
    const t = tools('E:\\UltraGameStudio');
    expect(nativeSkillToolsForCwd(t, 'E:\\UltraGameStudio')).toBe(t);
    expect(nativeSkillToolsForCwd(t, 'e:/ultragamestudio/')).toBe(t);
    expect(nativeSkillToolsForCwd(tools(), undefined)).toBeDefined();
  });

  it('drops only the tools when the session composer folder is another project', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = tools('E:\\UltraGameStudio');
    expect(nativeSkillToolsForCwd(t, 'E:\\project_moon_ue5\\MoonGame\\Client\\Game')).toBeUndefined();
    expect(nativeSkillToolsForCwd(t, undefined)).toBeUndefined();
    expect(nativeSkillToolsForCwd(undefined, 'E:\\UltraGameStudio')).toBeUndefined();
    warn.mockRestore();
  });
});
