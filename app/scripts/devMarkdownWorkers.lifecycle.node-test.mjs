import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { devMarkdownWorkers } from './devMarkdownWorkers.mjs';
const path = '/src/components/ai/lib/rendererMarkdown.worker.ts';
const changed = 'E:/UltraGameStudio/app/src/components/ai/lib/rendererMarkdown.ts';
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture(options) {
  let middleware;
  const server = { config: { root: 'E:/UltraGameStudio/app', resolve: { alias: [] }, define: {}, logger: { error() {} } }, watcher: new EventEmitter(), ws: { send() {} }, middlewares: { use(value) { middleware = value; } } };
  const plugin = devMarkdownWorkers(options); plugin.configureServer(server);
  return { server, close: () => plugin.closeBundle(), request(url = `${path}?worker_file&type=module`) {
    let response;
    const promise = new Promise((resolve, reject) => {
      response = Object.assign(new EventEmitter(), { statusCode: 200, setHeader() {}, end(body) { resolve({ status: this.statusCode, body }); } });
      Promise.resolve(middleware({ url, method: 'GET' }, response, () => resolve({ next: true }))).catch(reject);
    });
    return { promise, response };
  } };
}
test('disconnect and per-HTTP deadlines release waiters without releasing the actual builder slot', async () => {
  const gate = deferred(); let calls = 0, active = 0;
  const f = fixture({ timeoutMs: 30, maxWaiters: 1, buildWorker: async () => {
    calls++; active++; try { await gate.promise; return { code: 'export {};', dependencies: [changed] }; } finally { active--; }
  } });
  try {
    const disconnected = f.request(); await tick(); disconnected.response.emit('close');
    assert.equal(disconnected.response.listenerCount('close'), 0);
    const old = f.request(); await tick(); assert.equal((await f.request().promise).status, 503);
    f.server.watcher.emit('all', 'change', changed); assert.equal((await old.promise).status, 500);
    const refreshed = f.request();
    const expired = await refreshed.promise; assert.equal(expired.status, 500);
    assert.equal(refreshed.response.listenerCount('close'), 0); assert.equal(calls, 1); assert.equal(active, 1);
    for (let i = 0; i < 20; i++) assert.equal((await f.request().promise).status, 500);
    assert.equal(calls, 1); assert.equal(active, 1);
    gate.resolve(); await tick(); assert.equal((await f.request().promise).status, 200); assert.equal(calls, 2);
  } finally { gate.resolve(); f.close(); }
});
test('two worker slots bound 64 default HTTP waiters and 66 owned timers across repeated changes', async () => {
  const set = globalThis.setTimeout, clear = globalThis.clearTimeout, timers = new Set();
  globalThis.setTimeout = (fn, ms, ...args) => { const handle = set(() => { timers.delete(handle); fn(...args); }, ms); timers.add(handle); return handle; };
  globalThis.clearTimeout = handle => { timers.delete(handle); clear(handle); };
  const gate = deferred(); let calls = 0, active = 0, maxActive = 0;
  const entries = [path, '/src/components/ai/lib/referenceAnalysis.worker.ts'];
  const f = fixture({ timeoutMs: 5000, buildWorker: async () => { calls++; active++; maxActive = Math.max(maxActive, active); try { await gate.promise; return { code: 'export {};', dependencies: [changed] }; } finally { active--; } } });
  let pending = [];
  try {
    for (let round = 0; round < 20; round++) {
      pending = entries.flatMap(entry => Array.from({ length: 32 }, () => f.request(`${entry}?worker_file&type=module`)));
      await tick(); assert.equal(calls, 2); assert.equal(active, 2); assert.equal(timers.size, 66);
      for (const entry of entries) assert.equal((await f.request(`${entry}?worker_file&type=module`).promise).status, 503);
      assert.equal(timers.size, 66);
      f.server.watcher.emit('all', 'change', changed);
      assert.ok((await Promise.all(pending.map(p => p.promise))).every(r => r.status === 500));
      assert.ok(pending.every(p => p.response.listenerCount('close') === 0)); assert.equal(timers.size, 2);
    }
    f.close(); assert.equal(timers.size, 0); assert.equal(active, 2); assert.equal(maxActive, 2);
    gate.resolve(); await tick(); assert.equal(active, 0); assert.equal(calls, 2); assert.equal(timers.size, 0);
  } finally { gate.resolve(); f.close(); for (const timer of timers) clear(timer); globalThis.setTimeout = set; globalThis.clearTimeout = clear; }
});
test('close before the admitted build callback runs never invokes a builder', async () => {
  let calls = 0;
  const f = fixture({ buildWorker: async () => { calls++; return { code: 'export {};', dependencies: [] }; } });
  const pending = f.request(); f.close();
  assert.equal((await pending.promise).status, 500); await tick(); assert.equal(calls, 0);
});
test('close settles all pending responses and clears owned timers/listeners before builders retire', async () => {
  const set = globalThis.setTimeout, clear = globalThis.clearTimeout;
  const timers = new Set();
  globalThis.setTimeout = (fn, ms, ...args) => {
    const handle = set(() => { timers.delete(handle); fn(...args); }, ms); timers.add(handle); return handle;
  };
  globalThis.clearTimeout = handle => { timers.delete(handle); clear(handle); };
  const gate = deferred(); let calls = 0, active = 0;
  const f = fixture({ timeoutMs: 1000, buildWorker: async () => {
    calls++; active++; try { await gate.promise; return { code: 'export {};', dependencies: [changed] }; } finally { active--; }
  } });
  try {
    const old = f.request(); await tick(); f.server.watcher.emit('all', 'change', changed);
    const refresh = f.request(); await tick();
    let oldSettled = false, refreshSettled = false;
    old.promise.then(() => { oldSettled = true; }); refresh.promise.then(() => { refreshSettled = true; });
    f.close(); await tick();
    assert.equal(oldSettled, true); assert.equal(refreshSettled, true);
    assert.equal((await old.promise).status, 500); assert.equal((await refresh.promise).status, 500);
    assert.equal(timers.size, 0); assert.equal(old.response.listenerCount('close'), 0);
    assert.equal(refresh.response.listenerCount('close'), 0); assert.equal(f.server.watcher.listenerCount('all'), 0);
    assert.equal(active, 1); assert.equal((await f.request().promise).status, 500); assert.equal(calls, 1);
    gate.resolve(); await tick(); assert.equal(active, 0); assert.equal(timers.size, 0);
  } finally {
    gate.resolve(); f.close(); for (const handle of timers) clear(handle);
    globalThis.setTimeout = set; globalThis.clearTimeout = clear;
  }
});
test('reload first request waits for stale builder retirement and serves current generation automatically', async () => {
  const gates = [deferred(), deferred()]; let calls = 0, active = 0, maxActive = 0;
  const f = fixture({ timeoutMs: 1000, buildWorker: async () => {
    const call = ++calls; active++; maxActive = Math.max(maxActive, active);
    try { if (call <= 2) await gates[call - 1].promise; return { code: `export const generation=${call};`, dependencies: [changed] }; } finally { active--; }
  } });
  try {
    const old = f.request(); await tick();
    f.server.watcher.emit('all', 'change', changed);
    const refreshed = f.request(); await tick(); assert.equal(calls, 1);
    gates[0].resolve(); const stale = await old.promise; await tick();
    gates[1].resolve(); const current = await refreshed.promise;
    assert.equal(stale.status, 500); assert.equal(current.status, 200);
    assert.equal(current.body, 'export const generation=2;'); assert.equal(calls, 2); assert.equal(maxActive, 1);
  } finally { gates.forEach(g => g.resolve()); f.close(); }
});
