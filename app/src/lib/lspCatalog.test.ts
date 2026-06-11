import { describe, expect, it } from 'vitest';
import {
  detectProjectLanguagesFromPaths,
  fallbackLanguageScanForEngine,
  installCommandText,
  recommendedLspServerIds,
  rankLspServers,
} from './lspCatalog';

describe('lsp catalog language detection', () => {
  it('detects mixed Unreal C++ and C# projects', () => {
    const languages = detectProjectLanguagesFromPaths(
      [
        'Source/Game/Game.cpp',
        'Source/Game/Game.h',
        'Source/Game.Target.cs',
        'Plugins/Tools/Tools.Build.cs',
      ],
      'unreal',
    );

    expect(languages.map((item) => item.id)).toContain('cpp');
    expect(languages.map((item) => item.id)).toContain('csharp');
    expect(recommendedLspServerIds(languages)).toEqual(
      expect.arrayContaining(['clangd', 'csharp-ls']),
    );
  });

  it('ranks detected language servers before unrelated servers', () => {
    const languages = detectProjectLanguagesFromPaths(['app/main.py']);
    const ranked = rankLspServers(languages);

    expect(ranked[0].id).toBe('pyright');
    expect(ranked[0].recommendationScore).toBeGreaterThan(0);
    expect(ranked.find((item) => item.id === 'clangd')?.recommendationScore).toBe(0);
  });

  it('supports search across server names and tags', () => {
    const languages = detectProjectLanguagesFromPaths(['src/main.rs']);
    const results = rankLspServers(languages, 'typescript');

    expect(results.map((item) => item.id)).toContain('typescript-language-server');
    expect(results.every((item) => item.title.toLowerCase().includes('typescript') || item.tags.includes('typescript'))).toBe(true);
  });

  it('falls back to engine markers when workspace files cannot be scanned', () => {
    const scan = fallbackLanguageScanForEngine('unity');

    expect(scan.languages).toEqual([
      expect.objectContaining({ id: 'csharp', markerCount: 1 }),
    ]);
  });

  it('exposes structured one-click install commands for package-managed LSPs', () => {
    const [pyright] = rankLspServers(detectProjectLanguagesFromPaths(['app/main.py']));

    expect(pyright.id).toBe('pyright');
    expect(pyright.installCommands?.[0]).toEqual(
      expect.objectContaining({
        command: 'npm',
        args: ['install', '-g', 'pyright'],
      }),
    );
    expect(installCommandText(pyright.installCommands![0])).toBe('npm install -g pyright');
  });

  it('offers shader language servers for game/graphics work', () => {
    const languages = detectProjectLanguagesFromPaths([
      'Shaders/Lit.hlsl',
      'Shaders/Compute.wgsl',
      'Shaders/Post.glsl',
    ]);
    const ranked = rankLspServers(languages, 'shader');
    const ids = ranked.map((server) => server.id);
    expect(ids).toEqual(
      expect.arrayContaining(['glsl-analyzer', 'wgsl-analyzer', 'shader-language-server']),
    );
  });
});
