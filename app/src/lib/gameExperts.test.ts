import { describe, expect, it } from 'vitest';
import {
  CCGS_GAME_EXPERT_IDS,
  DEFAULT_GAME_EXPERT_SETTINGS,
  GAME_EXPERTS,
  buildGameExpertPrompt,
  gameExpertMenuEntries,
  gameExpertSlashCommand,
  getGameExpertCatalog,
  normalizeGameExpertSettings,
  parseGameExpertCommand,
  resolveGameExpertPath,
  selectGameExperts,
} from './gameExperts';

describe('game expert routing', () => {
  it('includes every CCGS agent in the selectable expert pool', () => {
    const ids = new Set(GAME_EXPERTS.map((expert) => expert.id));

    for (const id of CCGS_GAME_EXPERT_IDS) {
      expect(ids.has(id)).toBe(true);
    }
  });

  it('upgrades the legacy default pool to the expanded catalog', () => {
    const settings = normalizeGameExpertSettings({
      enabled: true,
      engine: 'auto',
      mode: 'standard',
      maxExperts: 3,
      enabledExpertIds: [
        'technical-director',
        'game-designer',
        'gameplay-programmer',
        'unity-specialist',
        'unreal-specialist',
        'godot-specialist',
        'ui-programmer',
        'ux-designer',
        'ai-programmer',
        'network-programmer',
        'performance-analyst',
        'qa-tester',
        'tools-programmer',
        'audio-designer',
        'visual-effects-artist',
        'save-systems-engineer',
      ],
    });

    expect(settings.enabledExpertIds).toEqual(
      GAME_EXPERTS.map((expert) => expert.id),
    );
  });

  it('stays silent while disabled', () => {
    expect(
      buildGameExpertPrompt(
        'Unity 里做近战格挡和伤害判定',
        DEFAULT_GAME_EXPERT_SETTINGS,
      ),
    ).toBe('');
  });

  it('routes Unity combat work to engine and gameplay experts', () => {
    const settings = normalizeGameExpertSettings({
      ...DEFAULT_GAME_EXPERT_SETTINGS,
      enabled: true,
      maxExperts: 4,
    });

    const ids = selectGameExperts(
      'Unity 里做一个近战 combat parry damage 系统',
      settings,
    ).map((expert) => expert.id);

    expect(ids).toContain('unity-specialist');
    expect(ids).toContain('gameplay-programmer');
    expect(ids).toContain('game-designer');
    expect(ids.length).toBeLessThanOrEqual(4);
  });

  it('does not auto-route when settings are disabled', () => {
    const settings = normalizeGameExpertSettings({
      ...DEFAULT_GAME_EXPERT_SETTINGS,
      enabled: false,
    });
    expect(selectGameExperts('Unity 里做一个 combat 系统', settings)).toEqual([]);
  });

  it('force routes even when disabled and prompt lacks game keywords', () => {
    const settings = normalizeGameExpertSettings({
      ...DEFAULT_GAME_EXPERT_SETTINGS,
      enabled: false,
    });
    // No game keywords at all, experts disabled — force (explicit /game) must
    // still produce a result via the leadership/design score floor.
    const ids = selectGameExperts('随便聊聊', settings, { force: true }).map(
      (expert) => expert.id,
    );
    expect(ids.length).toBeGreaterThan(0);
    expect(ids).toContain('technical-director');
  });

  it('ignores disabled experts during routing', () => {
    const settings = normalizeGameExpertSettings({
      ...DEFAULT_GAME_EXPERT_SETTINGS,
      enabled: true,
      engine: 'unity',
      enabledExpertIds: ['gameplay-programmer'],
    });

    const ids = selectGameExperts('做一个玩家技能系统', settings).map(
      (expert) => expert.id,
    );

    expect(ids).toEqual(['gameplay-programmer']);
  });

  it('routes to custom experts from project settings', () => {
    const settings = normalizeGameExpertSettings({
      ...DEFAULT_GAME_EXPERT_SETTINGS,
      enabled: true,
      maxExperts: 2,
      customExperts: [
        {
          id: 'boss-pattern-designer',
          name: 'Boss Pattern Designer',
          group: 'Design',
          summary: 'Boss phases and attack patterns',
          role: '设计 Boss 阶段、攻击节奏和反制窗口。',
          triggers: ['boss', 'phase', 'pattern', '首领'],
          guidance: ['先定义阶段目标、读招反馈和失误惩罚'],
          boundaries: ['不只堆技能数量'],
          defaultRank: 1,
        },
      ],
      enabledExpertIds: ['boss-pattern-designer'],
    });

    const prompt = buildGameExpertPrompt('设计一个 boss phase pattern', settings);

    expect(prompt).toContain('Boss Pattern Designer');
    expect(prompt).toContain('设计 Boss 阶段');
  });

  it('hides deleted built-in experts from the catalog and router', () => {
    const settings = normalizeGameExpertSettings({
      ...DEFAULT_GAME_EXPERT_SETTINGS,
      enabled: true,
      engine: 'unity',
      deletedExpertIds: ['unity-specialist'],
      enabledExpertIds: ['unity-specialist', 'gameplay-programmer'],
    });

    const catalogIds = getGameExpertCatalog(settings).map((expert) => expert.id);
    const routedIds = selectGameExperts('Unity 做玩家 combat damage', settings).map(
      (expert) => expert.id,
    );

    expect(catalogIds).not.toContain('unity-specialist');
    expect(routedIds).not.toContain('unity-specialist');
    expect(routedIds).toContain('gameplay-programmer');
  });

  it('lets custom definitions override built-in expert content', () => {
    const settings = normalizeGameExpertSettings({
      ...DEFAULT_GAME_EXPERT_SETTINGS,
      enabled: true,
      maxExperts: 1,
      customExperts: [
        {
          id: 'game-designer',
          name: 'Project Game Designer',
          group: 'Design',
          summary: 'Project-specific rules',
          role: '只按本项目的轻 Roguelite 规则做取舍。',
          triggers: ['roguelite'],
          guidance: ['优先验证单局循环'],
          boundaries: ['不引入重 RPG 数值膨胀'],
          defaultRank: 1,
        },
      ],
      enabledExpertIds: ['game-designer'],
    });

    const prompt = buildGameExpertPrompt('roguelite progression design', settings);

    expect(prompt).toContain('Project Game Designer');
    expect(prompt).toContain('轻 Roguelite');
  });
});

describe('game expert asset channel awareness', () => {
  const enabledSettings = normalizeGameExpertSettings({
    ...DEFAULT_GAME_EXPERT_SETTINGS,
    enabled: true,
    maxExperts: 5,
  });

  it('omits channel guidance when no channels argument is passed', () => {
    const prompt = buildGameExpertPrompt(
      '设计游戏的 UI 界面和图标',
      enabledSettings,
    );
    expect(prompt).not.toContain('可用素材渠道');
  });

  it('omits channel guidance when all channels are unavailable', () => {
    const prompt = buildGameExpertPrompt(
      '设计游戏的 UI 界面和图标',
      enabledSettings,
      { image: false, music: false, threeD: false },
    );
    expect(prompt).not.toContain('可用素材渠道');
  });

  it('recommends the image channel for visual/UI work when ready', () => {
    const prompt = buildGameExpertPrompt(
      'Unity 里做一个背包菜单 UI 界面和图标',
      enabledSettings,
      { image: true, music: false, threeD: false },
    );
    expect(prompt).toContain('可用素材渠道');
    expect(prompt).toContain('/image');
    expect(prompt).not.toContain('/music');
  });

  it('recommends the music channel for audio work when ready', () => {
    const prompt = buildGameExpertPrompt(
      '给游戏战斗场景做 BGM 和音效设计',
      enabledSettings,
      { image: false, music: true, threeD: false },
    );
    expect(prompt).toContain('/music');
  });

  it('recommends the 3D channel for asset/level work when ready', () => {
    const prompt = buildGameExpertPrompt(
      '做角色和道具的 3D 模型与贴图 technical art shader 管线 material',
      enabledSettings,
      { image: false, music: false, threeD: true },
    );
    expect(prompt).toContain('/mesh-mode-start');
  });

  it('only surfaces channels relevant to the selected experts', () => {
    // A pure netcode task should not route to audio experts, so even if the
    // music channel is ready it should not be advertised.
    const prompt = buildGameExpertPrompt(
      '做多人游戏的 netcode 同步和回滚预测',
      enabledSettings,
      { image: false, music: true, threeD: false },
    );
    expect(prompt).not.toContain('/music');
  });
});

describe('hierarchical slash resolution', () => {
  const settings = normalizeGameExpertSettings({
    ...DEFAULT_GAME_EXPERT_SETTINGS,
    enabled: true,
  });

  it('resolves a full root → group → expert path (zh-CN)', () => {
    const res = resolveGameExpertPath('游戏专家/编程/引擎程序', settings);
    expect(res?.kind).toBe('expert');
    expect(res?.expertIds).toEqual(['engine-programmer']);
  });

  it('resolves a direct leaf without the root (zh-CN)', () => {
    const res = resolveGameExpertPath('引擎程序', settings);
    expect(res?.kind).toBe('expert');
    expect(res?.expertIds).toEqual(['engine-programmer']);
  });

  it('resolves the same expert by English name (locale-agnostic)', () => {
    const res = resolveGameExpertPath('Engine Programmer', settings);
    expect(res?.expertIds).toEqual(['engine-programmer']);
  });

  it('resolves a group to all its members', () => {
    const res = resolveGameExpertPath('编程', settings);
    expect(res?.kind).toBe('group');
    if (res?.kind === 'group') {
      expect(res.group).toBe('Programming');
    }
    expect(res?.expertIds).toContain('engine-programmer');
    expect((res?.expertIds.length ?? 0)).toBeGreaterThan(1);
  });

  it('a deeper expert overrides a shallower group in the path', () => {
    const res = resolveGameExpertPath('编程/引擎程序', settings);
    expect(res?.kind).toBe('expert');
    expect(res?.expertIds).toEqual(['engine-programmer']);
  });

  it('a bare root resolves to nothing (whole-team routing)', () => {
    expect(resolveGameExpertPath('游戏专家', settings)).toBeNull();
    expect(resolveGameExpertPath('game', settings)).toBeNull();
  });

  it('resolves even when settings are disabled (explicit opt-in)', () => {
    const off = normalizeGameExpertSettings({
      ...DEFAULT_GAME_EXPERT_SETTINGS,
      enabled: false,
    });
    expect(resolveGameExpertPath('引擎程序', off)?.expertIds).toEqual([
      'engine-programmer',
    ]);
  });
});

describe('parseGameExpertCommand', () => {
  const settings = normalizeGameExpertSettings({
    ...DEFAULT_GAME_EXPERT_SETTINGS,
    enabled: true,
  });

  it('parses a root command with a task as whole-team routing', () => {
    const cmd = parseGameExpertCommand('/游戏专家 设计一个3D飞机大战', settings);
    expect(cmd).not.toBeNull();
    expect(cmd?.expertIds).toEqual([]);
    expect(cmd?.task).toBe('设计一个3D飞机大战');
  });

  it('parses a drilled path and pins the resolved expert', () => {
    const cmd = parseGameExpertCommand(
      '/游戏专家/编程/引擎程序 优化渲染管线',
      settings,
    );
    expect(cmd?.expertIds).toEqual(['engine-programmer']);
    expect(cmd?.task).toBe('优化渲染管线');
  });

  it('parses a direct leaf command', () => {
    const cmd = parseGameExpertCommand('/引擎程序 优化渲染', settings);
    expect(cmd?.expertIds).toEqual(['engine-programmer']);
    expect(cmd?.task).toBe('优化渲染');
  });

  it('returns null for unrelated slash commands', () => {
    expect(parseGameExpertCommand('/plan 做个计划', settings)).toBeNull();
    expect(parseGameExpertCommand('普通问题', settings)).toBeNull();
  });

  it('does not treat UE asset paths under /Game as a game-expert command', () => {
    expect(
      parseGameExpertCommand(
        '/Game/Cinematics/LS_CamPullback50m2，这个打开失效了，你修复下',
        settings,
      ),
    ).toBeNull();
    expect(
      parseGameExpertCommand('/Game/Maps/Main 打开后黑屏', settings),
    ).toBeNull();
  });
});

describe('pinned expert selection', () => {
  it('returns exactly the pinned experts, bypassing keyword scoring', () => {
    const settings = normalizeGameExpertSettings({
      ...DEFAULT_GAME_EXPERT_SETTINGS,
      enabled: true,
    });
    const ids = selectGameExperts('随便什么文本', settings, {
      pinnedExpertIds: ['engine-programmer'],
    }).map((e) => e.id);
    expect(ids).toEqual(['engine-programmer']);
  });

  it('pinning bypasses the disabled gate', () => {
    const settings = normalizeGameExpertSettings({
      ...DEFAULT_GAME_EXPERT_SETTINGS,
      enabled: false,
    });
    const ids = selectGameExperts('x', settings, {
      pinnedExpertIds: ['engine-programmer'],
    }).map((e) => e.id);
    expect(ids).toEqual(['engine-programmer']);
  });
});

describe('gameExpertMenuEntries round-trip', () => {
  it('every menu entry insertText parses back to a game command', () => {
    const settings = normalizeGameExpertSettings({
      ...DEFAULT_GAME_EXPERT_SETTINGS,
      enabled: true,
    });
    const entries = gameExpertMenuEntries(settings, 'zh-CN');
    expect(entries.length).toBeGreaterThan(1);
    for (const entry of entries) {
      const cmd = parseGameExpertCommand(`${entry.insertText}做点东西`, settings);
      expect(cmd, `entry ${entry.name} should parse`).not.toBeNull();
    }
  });

  it('is empty when experts are disabled', () => {
    const off = normalizeGameExpertSettings({
      ...DEFAULT_GAME_EXPERT_SETTINGS,
      enabled: false,
    });
    expect(gameExpertMenuEntries(off, 'zh-CN')).toEqual([]);
  });
});

describe('gameExpertSlashCommand', () => {
  const settings = normalizeGameExpertSettings({
    ...DEFAULT_GAME_EXPERT_SETTINGS,
    enabled: true,
  });

  it('gives every built-in expert a stable single-token command that pins it', () => {
    for (const expert of GAME_EXPERTS) {
      const command = gameExpertSlashCommand(expert);
      // Single token: no whitespace, so the command parser never truncates it.
      expect(command).toBe(`/${expert.id}`);
      expect(command).not.toMatch(/\s/);
      const cmd = parseGameExpertCommand(`${command} 优化一下`, settings);
      expect(cmd, `${command} should resolve`).not.toBeNull();
      expect(cmd?.expertIds).toEqual([expert.id]);
      expect(cmd?.task).toBe('优化一下');
    }
  });

  it('resolves the command even for experts toggled off in settings', () => {
    const off = normalizeGameExpertSettings({
      ...DEFAULT_GAME_EXPERT_SETTINGS,
      enabled: true,
      enabledExpertIds: [],
    });
    const command = gameExpertSlashCommand(GAME_EXPERTS[0]);
    const cmd = parseGameExpertCommand(`${command} 任务`, off);
    expect(cmd?.expertIds).toEqual([GAME_EXPERTS[0].id]);
  });
});

describe('per-expert menu entries pin a single expert', () => {
  it('each expert entry round-trips to exactly that expert', () => {
    const settings = normalizeGameExpertSettings({
      ...DEFAULT_GAME_EXPERT_SETTINGS,
      enabled: true,
    });
    const entries = gameExpertMenuEntries(settings, 'zh-CN');
    const expertEntries = entries.filter((entry) =>
      entry.id.startsWith('game-expert:expert:'),
    );
    expect(expertEntries.length).toBe(GAME_EXPERTS.length);
    for (const entry of expertEntries) {
      const expectedId = entry.id.slice('game-expert:expert:'.length);
      const cmd = parseGameExpertCommand(`${entry.insertText}做点东西`, settings);
      expect(cmd?.expertIds, `entry ${entry.name}`).toEqual([expectedId]);
    }
  });
});
