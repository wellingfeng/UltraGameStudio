import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authenticatedUrl, redact } from '../src/git.mjs';

test('authenticatedUrl injects token for https', () => {
  const url = authenticatedUrl('https://github.com/me/repo.git', 'tok');
  assert.equal(url, 'https://x-access-token:tok@github.com/me/repo.git');
});

test('authenticatedUrl leaves ssh urls alone', () => {
  assert.equal(
    authenticatedUrl('git@github.com:me/repo.git', 'tok'),
    'git@github.com:me/repo.git',
  );
});

test('redact strips embedded credentials', () => {
  assert.equal(
    redact('cloning https://x-access-token:secret@github.com/me/repo'),
    'cloning https://***@github.com/me/repo',
  );
});
