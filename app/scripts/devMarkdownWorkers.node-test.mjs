import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { devMarkdownWorkers } from './devMarkdownWorkers.mjs';

const path = '/src/components/ai/lib/rendererMarkdown.worker.ts';
function fixture(options) {
  let middleware;
  const server = {
    config: { root: 'E:/UltraGameStudio/app', resolve: { alias: [] }, define: {}, logger: { error() {} } },
    watcher: new EventEmitter(),
    ws: { messages: [], send(value) { this.messages.push(value); } },
    middlewares: { use(value) { middleware = value; } },
  };
  const plugin = devMarkdownWorkers(options);
  plugin.configureServer(server);
  return {
    server,
    close() { plugin.closeBundle?.(); },
    request(url = `${path}?worker_file&type=module`, method = 'GET') {
      return new Promise((resolve, reject) => {
        const res = Object.assign(new EventEmitter(), { statusCode: 200, headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(body) { resolve({ status: this.statusCode, body, headers: this.headers }); } });
        Promise.resolve(middleware({ url, method }, res, () => resolve({ next: true }))).catch(reject);
      });
    },
  };
}
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

test('shares an in-flight build and cached result across timestamp query variations', async () => {
  let calls = 0;
  const gate = deferred();
  const f = fixture({ buildWorker: async () => { calls++; await gate.promise; return { code: 'export const fixture=1;', dependencies: [] }; } });
  const pending = [f.request(), f.request(`${path}?worker_file&type=module&t=1`), f.request(`${path}?worker_file&type=module&t=2`)];
  await new Promise(resolve => setImmediate(resolve));
  const observed = calls;
  gate.resolve();
  const results = await Promise.all(pending);
  assert.equal(observed, 1);
  assert.ok(results.every(result => result.status === 200));
  await f.request(`${path}?worker_file&type=module&t=3`);
  assert.equal(calls, 1);
});

test('invalidates cached graph after source changes and rejects stale pending output without overlapping builds', async () => {
  let calls = 0;
  const gate = deferred();
  const f = fixture({ buildWorker: async () => { calls++; if (calls === 1) await gate.promise; return { code: `export const fixture=${calls};`, dependencies: ['E:/UltraGameStudio/app/src/components/ai/lib/rendererMarkdown.ts'] }; } });
  const first = f.request();
  await new Promise(resolve => setImmediate(resolve));
  f.server.watcher.emit('all', 'change', 'E:/UltraGameStudio/app/src/components/ai/lib/rendererMarkdown.ts');
  const second = f.request();
  assert.equal(calls, 1);
  gate.resolve();
  assert.equal((await first).status, 500);
  const refreshed = await second;
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.body, 'export const fixture=2;');
  assert.equal(calls, 2);
  f.server.watcher.emit('all', 'change', 'E:/UltraGameStudio/app/src/components/ai/lib/rendererMarkdown.ts');
  assert.equal((await f.request()).body, 'export const fixture=3;');
  assert.ok(f.server.ws.messages.some(message => message.type === 'full-reload'));
});

test('times out visibly but retains admission until the real builder exits', async () => {
  let calls = 0;
  const gate = deferred();
  const f = fixture({ timeoutMs: 10, buildWorker: async () => { calls++; await gate.promise; return { code: 'export {};', dependencies: [] }; } });
  const first = f.request();
  await new Promise(resolve => setTimeout(resolve, 30));
  const second = f.request();
  await new Promise(resolve => setTimeout(resolve, 30));
  gate.resolve();
  assert.equal((await first).status, 500);
  assert.equal((await second).status, 500);
  assert.equal(calls, 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.request()).status, 200);
  assert.equal(calls, 2);
});

test('bounds waiting responses, cached code bytes and dependency metadata', async () => {
  const gate = deferred();
  let calls = 0;
  const f = fixture({ maxWaiters: 2, buildWorker: async () => { calls++; await gate.promise; return { code: 'export {};', dependencies: [] }; } });
  const pending = [f.request(), f.request(), f.request()];
  await new Promise(resolve => setImmediate(resolve));
  gate.resolve();
  const results = await Promise.all(pending);
  assert.equal(results.filter(result => result.status === 200).length, 2);
  assert.equal(calls, 1);
  for (const result of [{ code: 'x'.repeat(17), dependencies: [] }, { code: 'export {};', dependencies: ['a', 'b', 'c'] }]) {
    const limited = fixture({ maxCacheBytes: 16, maxDependencies: 2, buildWorker: async () => result });
    assert.equal((await limited.request()).status, 500);
    assert.equal((await limited.request()).status, 500);
  }
});

test('build errors remain visible and a later request can retry', async () => {
  let calls = 0;
  const f = fixture({ buildWorker: async () => { if (++calls === 1) throw new Error('fixture syntax error'); return { code: 'export {};', dependencies: [] }; } });
  const failed = await f.request();
  assert.equal(failed.status, 500);
  assert.match(failed.body, /UGS_DEV_WORKER_BUILD_FAILED/);
  assert.equal((await f.request()).status, 200);
});

test('only handles exact whitelisted worker URLs without duplicate or extra parameters', async () => {
  let calls = 0;
  const f = fixture({ buildWorker: async () => { calls++; return { code: 'export {};', dependencies: [] }; } });
  for (const url of [path, `${path}?worker_file&type=classic`, `${path}?worker_file&type=module&evil=1`, `${path}?worker_file&type=module&type=module`, `${path}?worker_file&type=module&t=../x`, `/src/components/ai/lib/../lib/rendererMarkdown.worker.ts?worker_file&type=module`, `/src/components/ai/lib/%72endererMarkdown.worker.ts?worker_file&type=module`]) {
    assert.equal((await f.request(url)).next, true, url);
  }
  assert.equal((await f.request(`${path}?worker_file&type=module`, 'POST')).next, true);
  assert.equal(calls, 0);
  assert.equal((await f.request('/src/components/ai/lib/referenceAnalysis.worker.ts?worker_file&type=module')).status, 200);
});

test('closing removes the watcher and refuses future worker builds', async () => {
  let calls = 0;
  const f = fixture({ buildWorker: async () => { calls++; return { code: 'export {};', dependencies: [] }; } });
  await f.request();
  f.close();
  assert.equal(f.server.watcher.listenerCount('all'), 0);
  assert.equal((await f.request()).status, 500);
  assert.equal(calls, 1);
});
