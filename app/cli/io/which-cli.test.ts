import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { repairClaudeBunInstall } from './which-cli';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fuc-which-cli-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('repairClaudeBunInstall', () => {
  it('restores the newest renamed Bun Claude binary when the package bin is missing', () => {
    const binDir = join(
      dir,
      '.bun',
      'install',
      'global',
      'node_modules',
      '@anthropic-ai',
      'claude-code',
      'bin',
    );
    const older = join(binDir, 'claude.exe.old.1000');
    const newer = join(binDir, 'claude.exe.old.2000');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(older, 'old', 'utf8');
    writeFileSync(newer, 'new', 'utf8');
    const oldDate = new Date('2026-01-01T00:00:00Z');
    const newDate = new Date('2026-01-02T00:00:00Z');
    utimesSync(older, oldDate, oldDate);
    utimesSync(newer, newDate, newDate);

    expect(repairClaudeBunInstall(dir)).toBe(true);

    const restored = join(binDir, 'claude.exe');
    expect(existsSync(restored)).toBe(true);
    expect(readFileSync(restored, 'utf8')).toBe('new');
  });

  it('does nothing when the Bun package binary already exists', () => {
    const binDir = join(
      dir,
      '.bun',
      'install',
      'global',
      'node_modules',
      '@anthropic-ai',
      'claude-code',
      'bin',
    );
    const target = join(binDir, 'claude.exe');
    const old = join(binDir, 'claude.exe.old.2000');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(target, 'healthy', 'utf8');
    writeFileSync(old, 'old', 'utf8');

    expect(repairClaudeBunInstall(dir)).toBe(false);
    expect(readFileSync(target, 'utf8')).toBe('healthy');
  });
});
