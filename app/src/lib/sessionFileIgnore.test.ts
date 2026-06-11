import { describe, expect, it } from 'vitest';
import {
  buildSessionIgnorePredicate,
  relativizePath,
  sessionIgnoreRootFromContents,
} from './sessionFileIgnore';

describe('relativizePath', () => {
  it('returns relative paths unchanged (minus ./)', () => {
    expect(relativizePath('src/app.ts', 'C:/proj')).toBe('src/app.ts');
    expect(relativizePath('./src/app.ts', 'C:/proj')).toBe('src/app.ts');
  });

  it('relativises an absolute path under the root', () => {
    expect(relativizePath('C:/proj/src/app.ts', 'C:/proj')).toBe('src/app.ts');
    expect(relativizePath('C:\\proj\\Saved\\x.log', 'C:/proj')).toBe('Saved/x.log');
  });

  it('is case-insensitive on the root prefix but keeps original case', () => {
    expect(relativizePath('C:/Proj/Src/App.tsx', 'c:/proj')).toBe('Src/App.tsx');
  });

  it('returns null for an absolute path outside the root', () => {
    expect(relativizePath('D:/other/x.ts', 'C:/proj')).toBeNull();
  });

  it('returns empty string when the path equals the root', () => {
    expect(relativizePath('C:/proj', 'C:/proj')).toBe('');
  });
});

describe('buildSessionIgnorePredicate', () => {
  it('hides nothing with no roots', () => {
    const isIgnored = buildSessionIgnorePredicate([]);
    expect(isIgnored('anything')).toBe(false);
  });

  it('hides files matched under their owning root', () => {
    const root = sessionIgnoreRootFromContents('C:/proj', [
      'Saved/\nIntermediate/\n*.tmp',
    ]);
    const isIgnored = buildSessionIgnorePredicate([root]);
    expect(isIgnored('C:/proj/Saved/log.txt')).toBe(true);
    expect(isIgnored('C:/proj/Intermediate/x.o')).toBe(true);
    expect(isIgnored('C:/proj/scratch.tmp')).toBe(true);
    expect(isIgnored('C:/proj/Source/a.cpp')).toBe(false);
  });

  it('applies a relative path against every root', () => {
    const root = sessionIgnoreRootFromContents('C:/proj', ['*.log']);
    const isIgnored = buildSessionIgnorePredicate([root]);
    expect(isIgnored('debug.log')).toBe(true);
    expect(isIgnored('debug.ts')).toBe(false);
  });

  it('ignores roots a path does not belong to', () => {
    const a = sessionIgnoreRootFromContents('C:/a', ['*.log']);
    const b = sessionIgnoreRootFromContents('C:/b', ['*.bin']);
    const isIgnored = buildSessionIgnorePredicate([a, b]);
    // Absolute under C:/a — only a's rules apply.
    expect(isIgnored('C:/a/x.log')).toBe(true);
    expect(isIgnored('C:/a/x.bin')).toBe(false);
    expect(isIgnored('C:/b/x.bin')).toBe(true);
  });

  it('merges multiple ignore-file contents for one root', () => {
    const root = sessionIgnoreRootFromContents('C:/proj', [
      '*.log', // .gitignore
      'Binaries/', // .p4ignore
      '', // empty .svnignore is skipped
    ]);
    const isIgnored = buildSessionIgnorePredicate([root]);
    expect(isIgnored('C:/proj/a.log')).toBe(true);
    expect(isIgnored('C:/proj/Binaries/x.dll')).toBe(true);
    expect(isIgnored('C:/proj/Source/a.cpp')).toBe(false);
  });
});
