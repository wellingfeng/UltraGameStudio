import { describe, expect, it } from 'vitest';
import { buildIgnoreMatcher, type IgnoreSource } from './ignoreRules';

function matcher(content: string, baseDir = '') {
  const sources: IgnoreSource[] = [{ baseDir, content }];
  return buildIgnoreMatcher(sources);
}

describe('buildIgnoreMatcher', () => {
  it('never ignores when there are no rules', () => {
    const isIgnored = buildIgnoreMatcher([]);
    expect(isIgnored('anything/at/all.ts')).toBe(false);
  });

  it('skips blank lines and comments', () => {
    const isIgnored = matcher('\n# a comment\n   \n*.log\n');
    expect(isIgnored('debug.log')).toBe(true);
    expect(isIgnored('debug.txt')).toBe(false);
  });

  it('matches an extension glob at any depth', () => {
    const isIgnored = matcher('*.log');
    expect(isIgnored('a.log')).toBe(true);
    expect(isIgnored('deep/nested/dir/a.log')).toBe(true);
    expect(isIgnored('a.logger')).toBe(false);
  });

  it('matches a bare name (directory) and everything beneath it', () => {
    const isIgnored = matcher('node_modules');
    expect(isIgnored('node_modules')).toBe(true);
    expect(isIgnored('node_modules/react/index.js')).toBe(true);
    expect(isIgnored('app/node_modules/x.js')).toBe(true);
    expect(isIgnored('src/app.ts')).toBe(false);
  });

  it('anchors a leading-slash pattern to the root', () => {
    const isIgnored = matcher('/build');
    expect(isIgnored('build/out.js')).toBe(true);
    expect(isIgnored('src/build/out.js')).toBe(false);
  });

  it('anchors a pattern that contains an interior slash', () => {
    const isIgnored = matcher('src/generated');
    expect(isIgnored('src/generated/file.ts')).toBe(true);
    expect(isIgnored('app/src/generated/file.ts')).toBe(false);
  });

  it('honours directory-only trailing slash for nested paths', () => {
    const isIgnored = matcher('dist/');
    expect(isIgnored('dist/bundle.js')).toBe(true);
    expect(isIgnored('packages/x/dist/bundle.js')).toBe(true);
  });

  it('supports ** spanning segments', () => {
    const isIgnored = matcher('logs/**/*.txt');
    expect(isIgnored('logs/a.txt')).toBe(true);
    expect(isIgnored('logs/2024/06/a.txt')).toBe(true);
    expect(isIgnored('logs/a.csv')).toBe(false);
  });

  it('supports ? and character classes', () => {
    const isIgnored = matcher('file?.[ot]mp');
    expect(isIgnored('file1.tmp')).toBe(true);
    expect(isIgnored('fileA.omp')).toBe(true);
    expect(isIgnored('file12.tmp')).toBe(false);
  });

  it('lets a later negation rescue an ignored path', () => {
    const isIgnored = matcher('*.log\n!keep.log');
    expect(isIgnored('debug.log')).toBe(true);
    expect(isIgnored('keep.log')).toBe(false);
  });

  it('is case-insensitive for Windows-friendly matching', () => {
    const isIgnored = matcher('*.LOG');
    expect(isIgnored('Debug.Log')).toBe(true);
  });

  it('normalises backslash separators before matching', () => {
    const isIgnored = matcher('node_modules');
    expect(isIgnored('app\\node_modules\\x.js')).toBe(true);
  });

  it('applies a nested ignore file only under its base directory', () => {
    const isIgnored = buildIgnoreMatcher([
      { baseDir: 'packages/app', content: 'dist/\n*.local' },
    ]);
    expect(isIgnored('packages/app/dist/x.js')).toBe(true);
    expect(isIgnored('packages/app/config.local')).toBe(true);
    expect(isIgnored('dist/x.js')).toBe(false);
    expect(isIgnored('packages/other/config.local')).toBe(false);
  });

  it('combines multiple ignore sources', () => {
    const isIgnored = buildIgnoreMatcher([
      { baseDir: '', content: '*.tmp' },
      { baseDir: '', content: 'Saved/\nIntermediate/' },
    ]);
    expect(isIgnored('a.tmp')).toBe(true);
    expect(isIgnored('Saved/foo.bin')).toBe(true);
    expect(isIgnored('Intermediate/Build/x.o')).toBe(true);
    expect(isIgnored('Source/a.cpp')).toBe(false);
  });
});
