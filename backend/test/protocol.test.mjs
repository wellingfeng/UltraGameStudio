import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REMOTE_RUNNER_API_PATHS,
  REMOTE_RUNNER_SSE_EVENTS,
  RunnerClient,
  matchRemoteRunnerAccountPath,
  matchRemoteRunnerJobArtifactsPath,
  matchRemoteRunnerJobCancelPath,
  matchRemoteRunnerJobPath,
  matchRemoteRunnerJobStreamPath,
  matchRemoteRunnerProjectFilesPath,
  matchRemoteRunnerProjectEnvironmentPath,
  matchRemoteRunnerProjectEnvironmentInstallPath,
  matchRemoteRunnerProjectPath,
  remoteRunnerApiUrl,
} from '../../packages/protocol/index.js';

test('protocol route constants and matchers stay symmetric', () => {
  assert.equal(remoteRunnerApiUrl('https://runner.test/', REMOTE_RUNNER_API_PATHS.health), 'https://runner.test/health');
  assert.equal(matchRemoteRunnerProjectPath('/projects/proj%201'), 'proj 1');
  assert.equal(matchRemoteRunnerProjectFilesPath('/projects/proj%201/files'), 'proj 1');
  assert.equal(
    matchRemoteRunnerProjectEnvironmentPath('/projects/proj%201/environment'),
    'proj 1',
  );
  assert.equal(
    matchRemoteRunnerProjectEnvironmentInstallPath(
      '/projects/proj%201/environment/install',
    ),
    'proj 1',
  );
  // The plain environment matcher must not also swallow the install sub-path.
  assert.equal(
    matchRemoteRunnerProjectEnvironmentPath('/projects/proj%201/environment/install'),
    null,
  );
  assert.equal(matchRemoteRunnerJobPath('/jobs/job%201'), 'job 1');
  assert.equal(matchRemoteRunnerJobArtifactsPath('/jobs/job%201/artifacts'), 'job 1');
  assert.equal(matchRemoteRunnerJobCancelPath('/jobs/job%201/cancel'), 'job 1');
  assert.equal(matchRemoteRunnerJobStreamPath('/jobs/job%201/stream'), 'job 1');
  assert.equal(matchRemoteRunnerAccountPath('/accounts/account%201'), 'account 1');
  assert.equal(matchRemoteRunnerJobPath('/jobs/job_1/stream'), null);
  assert.equal(matchRemoteRunnerJobPath('/jobs/job%2F1'), null);
  assert.deepEqual(Object.values(REMOTE_RUNNER_SSE_EVENTS), ['log', 'message', 'status', 'result']);
});

test('RunnerClient uses shared route constants', async () => {
  const calls = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET' });
    return new Response(JSON.stringify({ ok: true, jobs: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    await new RunnerClient('https://runner.test/', 'tok').jobs();
    assert.deepEqual(calls, [{ url: 'https://runner.test/jobs', method: 'GET' }]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('RunnerClient streams structured remote messages', async () => {
  const previousFetch = globalThis.fetch;
  const messages = [];
  const statuses = [];
  globalThis.fetch = async () => {
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              [
                'event: message',
                'data: {"at":1,"role":"assistant","kind":"delta","text":"远程回答"}',
                '',
                'event: status',
                'data: "done"',
                '',
                '',
              ].join('\n'),
            ),
          );
          controller.close();
        },
      }),
      { status: 200 },
    );
  };
  try {
    new RunnerClient('https://runner.test/', 'tok').streamJob('job_1', {
      onMessage: (message) => messages.push(message),
      onStatus: (status) => statuses.push(status),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(messages, [
      { at: 1, role: 'assistant', kind: 'delta', text: '远程回答' },
    ]);
    assert.deepEqual(statuses, ['done']);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
