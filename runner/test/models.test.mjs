import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveInvocation, supportedAdapters } from '../src/models.mjs';

test('supportedAdapters lists the known CLIs', () => {
  assert.deepEqual(supportedAdapters().sort(), ['claude', 'codex', 'gemini']);
});

test('client-supplied key overrides server env', () => {
  process.env.ANTHROPIC_API_KEY = 'server-key';
  const inv = resolveInvocation({
    adapter: 'claude',
    prompt: 'do it',
    apiKey: 'client-key',
  });
  assert.equal(inv.env.ANTHROPIC_API_KEY, 'client-key');
  assert.equal(inv.missingKey, false);
  assert.deepEqual(inv.args, ['-p', 'do it']);
  delete process.env.ANTHROPIC_API_KEY;
});

test('falls back to server env when client omits a key', () => {
  process.env.OPENAI_API_KEY = 'srv';
  const inv = resolveInvocation({ adapter: 'codex', prompt: 'hi', model: 'gpt' });
  assert.equal(inv.env.OPENAI_API_KEY, 'srv');
  assert.deepEqual(inv.args, ['exec', 'hi', '-m', 'gpt']);
  delete process.env.OPENAI_API_KEY;
});

test('missingKey true when neither client nor server provide a key', () => {
  delete process.env.GEMINI_API_KEY;
  const inv = resolveInvocation({ adapter: 'gemini', prompt: 'x' });
  assert.equal(inv.missingKey, true);
});
