import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GAME_SKILL_RECOMMENDATION_SOURCE_ID,
  buildSkillInstallTextFromMarkdown,
  filterPluginStoreItems,
  loadPluginStoreCatalog,
  parseSkillFrontmatter,
  slugFromName,
  type PluginStoreItem,
} from './pluginStore';
import {
  __resetPluginStoreTranslationCacheForTests,
  shouldTranslatePluginDescription,
  translatePluginDescriptionCached,
} from './pluginStoreTranslation';

const item = (patch: Partial<PluginStoreItem>): PluginStoreItem => ({
  id: 'skill:test',
  name: 'playwright',
  title: 'Playwright',
  description: 'Browser testing skill',
  kind: 'skill',
  sourceId: 'openai-skills',
  sourceName: 'OpenAI Skills',
  installKind: 'skill',
  tags: ['browser', 'testing'],
  trust: 'official',
  ...patch,
});

describe('pluginStore', () => {
  afterEach(() => {
    __resetPluginStoreTranslationCacheForTests();
    vi.unstubAllGlobals();
  });

  it('parses skill frontmatter with folded descriptions', () => {
    expect(
      parseSkillFrontmatter(
        [
          '---',
          'name: playwright',
          'description: >',
          '  Browser automation',
          '  and test debugging',
          '---',
          '# Playwright',
        ].join('\n'),
        'fallback',
      ),
    ).toEqual({
      name: 'playwright',
      description: 'Browser automation and test debugging',
    });
  });

  it('falls back to first markdown heading when description is missing', () => {
    expect(
      parseSkillFrontmatter(['---', 'name: docs', '---', '# Documentation helper'].join('\n'), 'fallback'),
    ).toEqual({
      name: 'docs',
      description: 'Documentation helper',
    });
  });

  it('normalizes names into safe slugs', () => {
    expect(slugFromName('OpenAI Docs / API')).toBe('openai-docs-api');
    expect(slugFromName('  中文 Skill  ')).toBe('中文-skill');
  });

  it('filters by kind, source, and query terms', () => {
    const items = [
      item({ id: 'skill:playwright', title: 'Playwright' }),
      item({
        id: 'plugin:review',
        name: 'code-review',
        title: 'Code Review',
        kind: 'plugin',
        sourceId: 'claude-code-marketplace',
        sourceName: 'Claude Code Marketplace',
        description: 'PR review toolkit',
        installKind: 'pluginManifest',
        trust: 'official',
      }),
    ];

    expect(filterPluginStoreItems(items, 'review toolkit', 'plugin', 'claude-code-marketplace')).toHaveLength(1);
    expect(filterPluginStoreItems(items, 'browser', 'skill', 'all')).toHaveLength(1);
    expect(filterPluginStoreItems(items, 'missing', 'all', 'all')).toHaveLength(0);
  });

  it('loads curated game skill repositories into one recommendation source', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/UnrealXu/UnrealEngine5-Skills/')) {
        return new Response(
          JSON.stringify({
            tree: [
              { path: 'skills/ue5-cpp-gameplay/SKILL.md', type: 'blob' },
              { path: 'skills/README.md', type: 'blob' },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.includes('/quodsoler/unreal-engine-skills/')) {
        return new Response(
          JSON.stringify({
            tree: [{ path: 'skills/ue-gameplay-framework/SKILL.md', type: 'blob' }],
          }),
          { status: 200 },
        );
      }
      if (url.includes('/Besty0728/Unity-Skills/')) {
        return new Response(
          JSON.stringify({
            tree: [
              {
                path: 'SkillsForUnity/unity-skills~/skills/ui/SKILL.md',
                type: 'blob',
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.includes('/thedivergentai/gd-agentic-skills/')) {
        return new Response(
          JSON.stringify({
            tree: [{ path: 'skills/godot-master/SKILL.md', type: 'blob' }],
          }),
          { status: 200 },
        );
      }
      if (url.includes('/mrSutivu/Unreal-Engine-5-C-Expert-Skills/')) {
        return new Response(
          JSON.stringify({
            tree: [
              {
                path: 'skills/unreal-engine-5/actor-component-modularity.md',
                type: 'blob',
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response('not found', { status: 404, statusText: 'Not Found' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const catalog = await loadPluginStoreCatalog();
    const gameSkills = catalog.items.filter(
      (catalogItem) =>
        catalogItem.sourceId === GAME_SKILL_RECOMMENDATION_SOURCE_ID,
    );

    expect(new Set(gameSkills.map((catalogItem) => catalogItem.name))).toEqual(
      new Set([
        'actor-component-modularity',
        'godot-master',
        'ue-gameplay-framework',
        'ue5-cpp-gameplay',
        'ui',
      ]),
    );
    expect(gameSkills.every((catalogItem) => catalogItem.installKind === 'skill')).toBe(
      true,
    );
    expect(gameSkills.find((catalogItem) => catalogItem.name === 'ui')?.installUrl).toBe(
      'https://raw.githubusercontent.com/Besty0728/Unity-Skills/main/SkillsForUnity/unity-skills~/skills/ui/SKILL.md',
    );
    const ueMarkdownSkill = gameSkills.find(
      (catalogItem) => catalogItem.name === 'actor-component-modularity',
    );
    expect(ueMarkdownSkill?.installUrl).toBe(
      'https://raw.githubusercontent.com/mrSutivu/Unreal-Engine-5-C-Expert-Skills/main/skills/unreal-engine-5/actor-component-modularity.md',
    );
    expect(ueMarkdownSkill?.installTransform).toBe('wrapMarkdownAsSkill');
    expect(
      buildSkillInstallTextFromMarkdown(ueMarkdownSkill!, '# Actor Component Modularity'),
    ).toContain('Source: https://github.com/mrSutivu/Unreal-Engine-5-C-Expert-Skills/blob/main/skills/unreal-engine-5/actor-component-modularity.md');
  });

  it('decides whether plugin descriptions need locale translation', () => {
    expect(shouldTranslatePluginDescription('Build browser testing skill', 'zh-CN')).toBe(true);
    expect(shouldTranslatePluginDescription('构建浏览器测试技能', 'zh-CN')).toBe(false);
    expect(shouldTranslatePluginDescription('Build browser testing skill', 'en-US')).toBe(false);
    expect(shouldTranslatePluginDescription('构建浏览器测试技能', 'en-US')).toBe(true);
    expect(shouldTranslatePluginDescription('Build browser testing skill', 'fr-FR')).toBe(true);
  });

  it('caches translated plugin descriptions by item and locale', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify([[['构建浏览器测试技能', 'Build browser testing skill']]]), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      translatePluginDescriptionCached(
        'skill:playwright',
        'Build browser testing skill',
        'zh-CN',
      ),
    ).resolves.toBe('构建浏览器测试技能');
    await expect(
      translatePluginDescriptionCached(
        'skill:playwright',
        'Build browser testing skill',
        'zh-CN',
      ),
    ).resolves.toBe('构建浏览器测试技能');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
