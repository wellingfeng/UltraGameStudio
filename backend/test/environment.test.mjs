import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectEnvironment,
  ensureGitReadyForSync,
} from '../src/environment.mjs';

test('detectEnvironment reports the required tools with stable shape', async () => {
  const report = await detectEnvironment();
  assert.equal(typeof report.platform, 'string');
  assert.equal(typeof report.checkedAt, 'number');
  assert.equal(typeof report.ready, 'boolean');
  assert.equal(typeof report.gitReady, 'boolean');
  assert.ok(Array.isArray(report.tools));
  assert.deepEqual(
    report.tools.map((t) => t.id),
    ['git', 'git-lfs', 'node', 'python', 'ffmpeg', 'curl', 'unzip'],
  );
  for (const tool of report.tools) {
    assert.equal(typeof tool.label, 'string');
    assert.equal(typeof tool.installed, 'boolean');
    assert.equal(typeof tool.installable, 'boolean');
  }
  // The test host has git, so gitReady must reflect that and gate sync open.
  const gitTool = report.tools.find((t) => t.id === 'git');
  assert.equal(report.gitReady, gitTool.installed);
});

test('ensureGitReadyForSync resolves when git is present on the host', async () => {
  // CI/dev hosts have git on PATH; the gate should not throw there.
  await assert.doesNotReject(ensureGitReadyForSync());
});

