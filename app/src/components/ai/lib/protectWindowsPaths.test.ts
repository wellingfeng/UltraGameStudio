import { describe, it, expect } from 'vitest';
import { protectWindowsPaths } from './protectWindowsPaths';

// Build backslash-bearing strings without fighting source-escaping noise.
const B = String.fromCharCode(92);
const winPath = `E:${B}OpenWorkflow${B}.omc${B}clipboard-images${B}shot.png`;

describe('protectWindowsPaths', () => {
  it('returns input unchanged when there is no backslash', () => {
    const md = 'see .omc/clipboard-images/shot.png here';
    expect(protectWindowsPaths(md)).toBe(md);
  });

  it('doubles backslashes in a drive-letter path so CommonMark restores them', () => {
    const out = protectWindowsPaths(`see ${winPath} here`);
    // every single backslash should now be a pair
    expect(out).toBe(`see ${winPath.replace(/\\/g, '\\\\')} here`);
    // and CommonMark's escape collapse (modelled as \\ -> \) brings it back
    expect(out.replace(/\\\\/g, '\\')).toContain(winPath);
  });

  it('protects UNC paths', () => {
    const unc = `${B}${B}server${B}share${B}file.png`;
    const out = protectWindowsPaths(`open ${unc} now`);
    expect(out.replace(/\\\\/g, '\\')).toContain(unc);
  });

  it('leaves backslashes inside fenced code untouched', () => {
    const md = ['```', winPath, '```'].join('\n');
    expect(protectWindowsPaths(md)).toBe(md);
  });

  it('leaves backslashes inside inline code untouched', () => {
    const md = `run \`${winPath}\` now`;
    expect(protectWindowsPaths(md)).toBe(md);
  });

  it('protects a path token that ends a sentence with .omc segment', () => {
    const out = protectWindowsPaths(`图片 ${winPath} 完成`);
    expect(out.replace(/\\\\/g, '\\')).toContain(winPath);
  });
});
