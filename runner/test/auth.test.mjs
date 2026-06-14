import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeAuthorizer, extractBearer, safeEqual } from '../src/auth.mjs';

test('extractBearer pulls the token out of the header', () => {
  assert.equal(extractBearer('Bearer abc123'), 'abc123');
  assert.equal(extractBearer('bearer   spaced  '), 'spaced');
  assert.equal(extractBearer('Basic abc'), '');
  assert.equal(extractBearer(undefined), '');
});

test('safeEqual is correct for equal and unequal strings', () => {
  assert.equal(safeEqual('secret', 'secret'), true);
  assert.equal(safeEqual('secret', 'secre'), false);
  assert.equal(safeEqual('secret', 'wrongg'), false);
});

test('authorizer fails closed when no token configured', () => {
  const auth = makeAuthorizer('');
  assert.equal(auth.configured, false);
  assert.equal(auth.check('Bearer anything'), false);
});

test('authorizer accepts only the configured token', () => {
  const auth = makeAuthorizer('  topsecret ');
  assert.equal(auth.configured, true);
  assert.equal(auth.check('Bearer topsecret'), true);
  assert.equal(auth.check('Bearer nope'), false);
  assert.equal(auth.check(undefined), false);
});
