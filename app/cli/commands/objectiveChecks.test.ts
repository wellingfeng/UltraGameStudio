import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runObjectiveChecks } from './objectiveChecks';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fuc-objchecks-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('runObjectiveChecks', () => {
  it('returns null ground truth when there are no checks', async () => {
    const report = await runObjectiveChecks([], dir, { allowCommands: false });
    expect(report.passed).toBeNull();
    expect(report.ranCount).toBe(0);
    expect(report.skippedCount).toBe(0);
    expect(report.hasSkippedCommands).toBe(false);
  });

  it('passes file-exists when the path exists and fails when it does not', async () => {
    writeFileSync(join(dir, 'present.txt'), 'hi', 'utf8');
    const report = await runObjectiveChecks(
      [
        { kind: 'file-exists', path: 'present.txt' },
        { kind: 'file-exists', path: 'missing.txt' },
      ],
      dir,
      { allowCommands: false },
    );
    expect(report.results[0].status).toBe('pass');
    expect(report.results[1].status).toBe('fail');
    expect(report.passed).toBe(false);
    expect(report.failedCount).toBe(1);
  });

  it('checks file-contains as deterministic evidence verification', async () => {
    writeFileSync(join(dir, 'code.ts'), 'export function foo() {}', 'utf8');
    const report = await runObjectiveChecks(
      [
        { kind: 'file-contains', path: 'code.ts', contains: 'export function foo' },
        { kind: 'file-contains', path: 'code.ts', contains: 'not present here' },
      ],
      dir,
      { allowCommands: false },
    );
    expect(report.results[0].status).toBe('pass');
    expect(report.results[1].status).toBe('fail');
    expect(report.passed).toBe(false);
  });

  it('skips command checks unless commands are allowed', async () => {
    const report = await runObjectiveChecks(
      [{ kind: 'command', command: 'node -e "process.exit(0)"' }],
      dir,
      { allowCommands: false },
    );
    expect(report.results[0].status).toBe('skipped');
    expect(report.ranCount).toBe(0);
    expect(report.skippedCount).toBe(1);
    expect(report.hasSkippedCommands).toBe(true);
    expect(report.passed).toBeNull(); // nothing ran → no signal
  });

  it('marks command-skipped reports as incomplete even when file checks pass', async () => {
    writeFileSync(join(dir, 'present.txt'), 'hi', 'utf8');
    const report = await runObjectiveChecks(
      [
        { kind: 'file-exists', path: 'present.txt' },
        { kind: 'command', command: 'node -e "process.exit(0)"' },
      ],
      dir,
      { allowCommands: false },
    );
    expect(report.ranCount).toBe(1);
    expect(report.skippedCount).toBe(1);
    expect(report.failedCount).toBe(0);
    expect(report.hasSkippedCommands).toBe(true);
    expect(report.passed).toBe(true);
  });

  it('runs command checks when allowed and reports exit code', async () => {
    const report = await runObjectiveChecks(
      [
        { kind: 'command', command: 'node -e "process.exit(0)"' },
        { kind: 'command', command: 'node -e "process.exit(3)"' },
      ],
      dir,
      { allowCommands: true },
    );
    expect(report.results[0].status).toBe('pass');
    expect(report.results[1].status).toBe('fail');
    expect(report.passed).toBe(false);
  });

  it('rejects paths that escape the working directory', async () => {
    const report = await runObjectiveChecks(
      [{ kind: 'file-exists', path: '../../etc/passwd' }],
      dir,
      { allowCommands: false },
    );
    expect(report.results[0].status).toBe('fail');
    expect(report.results[0].detail).toContain('超出工作目录');
  });

  it('accepts Windows extended-length absolute paths inside the working directory', async () => {
    if (process.platform !== 'win32') return;
    writeFileSync(join(dir, 'present.txt'), 'hi', 'utf8');
    const extended = `\\\\?\\${join(dir, 'present.txt')}`;
    const report = await runObjectiveChecks(
      [{ kind: 'file-exists', path: extended }],
      dir,
      { allowCommands: false },
    );
    expect(report.results[0].status).toBe('pass');
  });

  it('normalizes backslashes in relative paths for macOS/Linux portability', async () => {
    mkdirSync(join(dir, 'nested'));
    writeFileSync(join(dir, 'nested', 'present.txt'), 'hi', 'utf8');
    const report = await runObjectiveChecks(
      [{ kind: 'file-exists', path: 'nested\\present.txt' }],
      dir,
      { allowCommands: false },
    );
    expect(report.results[0].status).toBe('pass');
  });

  it('rejects Windows drive paths on non-Windows hosts', async () => {
    if (process.platform === 'win32') return;
    const report = await runObjectiveChecks(
      [{ kind: 'file-exists', path: 'E:\\OpenWorkflow\\artifact.md' }],
      dir,
      { allowCommands: false },
    );
    expect(report.results[0].status).toBe('fail');
    expect(report.results[0].detail).toContain('路径超出工作目录');
  });

  it('reports passed=true only when all run checks pass', async () => {
    writeFileSync(join(dir, 'a.txt'), 'x', 'utf8');
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'b.txt'), 'y', 'utf8');
    const report = await runObjectiveChecks(
      [
        { kind: 'file-exists', path: 'a.txt' },
        { kind: 'file-exists', path: 'sub/b.txt' },
      ],
      dir,
      { allowCommands: false },
    );
    expect(report.passed).toBe(true);
    expect(report.ranCount).toBe(2);
    expect(report.skippedCount).toBe(0);
  });
});
