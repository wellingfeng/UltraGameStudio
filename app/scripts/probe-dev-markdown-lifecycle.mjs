import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { createServer } from 'vite';
import ts from 'typescript';
import { devMarkdownWorkers } from './devMarkdownWorkers.mjs';
const out = resolve(process.argv[2] ?? '');
assert.ok(process.argv[2], 'Pass a NEW owned scratch directory');
await mkdir(out, { recursive: true });
const app = fileURLToPath(new URL('..', import.meta.url));
const path = '/src/components/ai/lib/rendererMarkdown.worker.ts?worker_file&type=module';
const delay = ms => new Promise(r => setTimeout(r, ms));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function until(fn, message, ms = 5000) { const start = Date.now(); while (!fn()) { if (Date.now() - start > ms) throw new Error(message); await delay(5); } }
const options = (root, cacheDir, plugins, watch = null) => ({ root, cacheDir, configFile: false, envFile: false, logLevel: 'silent', plugins, server: { middlewareMode: true, hmr: false, ws: false, watch }, optimizeDeps: { noDiscovery: true, include: [] } });
async function listen(vite, handler) {
  const http = createHttpServer(handler ?? vite.middlewares);
  await new Promise(r => http.listen(0, '127.0.0.1', r));
  return { http, origin: `http://127.0.0.1:${http.address().port}` };
}
async function close(http, vite) { http?.closeAllConnections(); if (http) await new Promise(r => http.close(r)); await vite.close(); }
// Fresh actual helper build of the exact CURRENT entry, never a prior review artifact.
const sourceVite = await createServer(options(app, `${out}/source-cache`, [devMarkdownWorkers()]));
let sourceHttp, code;
try {
  const endpoint = await listen(sourceVite); sourceHttp = endpoint.http;
  const response = await fetch(endpoint.origin + path); assert.equal(response.status, 200);
  code = await response.text(); await writeFile(`${out}/current-renderer-served.mjs`, code);
} finally { await close(sourceHttp, sourceVite); }
const queueSource = await readFile(`${app}/src/components/ai/lib/rendererMarkdownQueue.ts`, 'utf8');
await writeFile(`${out}/queue-exact.mjs`, ts.transpileModule(queueSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
const { createRendererMarkdownQueue } = await import(pathToFileURL(`${out}/queue-exact.mjs`));
await writeFile(`${out}/loader.mjs`, `export async function resolve(s,c,n){if(s.startsWith('http://'))return {url:s,shortCircuit:true};if(c.parentURL?.startsWith('http://')&&(s.startsWith('/')||s.startsWith('.')))return {url:new URL(s,c.parentURL).href,shortCircuit:true};return n(s,c)}
export async function load(u,c,n){if(!u.startsWith('http://'))return n(u,c);const r=await fetch(u);if(!r.ok)throw new Error('HTTP_'+r.status);return {format:'module',source:await r.text(),shortCircuit:true}}`);
await writeFile(`${out}/bootstrap.mjs`, `import assert from 'node:assert/strict';import {parentPort,workerData} from 'node:worker_threads';
const globals=()=>({document:typeof document,window:typeof window,DOMParser:typeof DOMParser});const before=globals();assert.deepEqual(before,{document:'undefined',window:'undefined',DOMParser:'undefined'});
globalThis.self=globalThis;globalThis.postMessage=v=>parentPort.postMessage(v);await import(workerData.url);const after=globals();assert.deepEqual(after,before);assert.equal(typeof self.onmessage,'function');parentPort.on('message',data=>self.onmessage({data}));parentPort.postMessage({lifecycleReady:true,before,after,generation:globalThis.__lifecycleGeneration});`);
const root = `${out}/watcher-root`, changed = `${root}/src/components/ai/lib/rendererMarkdown.ts`;
await mkdir(`${root}/src/components/ai/lib`, { recursive: true });
await writeFile(changed, 'export const fixtureVersion=1;');
await writeFile(`${root}/src/components/ai/lib/rendererMarkdown.worker.ts`, 'export {};');
const gate = deferred(), began = deferred(), reloaded = deferred();
let calls = 0, active = 0, maxActive = 0, requests = 0, queueFailed = 0, commits = 0, lastSource;
const trace = [], workers = [], statuses = [], globals = [];
const stamp = (event, data = {}) => trace.push({ event, at: Date.now(), ...data });
const plugin = devMarkdownWorkers({ timeoutMs: 5000, buildWorker: async () => {
  const generation = ++calls; active++; maxActive = Math.max(maxActive, active); began.resolve(); stamp('builder-start', { generation });
  try { if (generation === 1) await gate.promise; return { code: code + `\nglobalThis.__lifecycleGeneration=${generation};`, dependencies: [changed] }; }
  finally { active--; stamp('builder-retired', { generation }); }
} });
const vite = await createServer(options(root, `${out}/watch-cache`, [plugin], { ignoreInitial: true }));
let http, queue;
try {
  const endpoint = await listen(vite, (req, res) => { requests++; stamp('http', { request: requests }); res.on('finish', () => statuses.push(res.statusCode)); vite.middlewares(req, res); }); http = endpoint.http;
  const url = endpoint.origin + path;
  await until(() => Object.values(vite.watcher.getWatched()).some(names => names.includes('rendererMarkdown.ts')), 'actual filesystem watcher not ready');
  vite.ws.send = value => {
    stamp('ws-send', value);
    if (value.type !== 'full-reload' || value.path !== '*') return;
    assert.equal(queue, undefined, 'this single filesystem change must reload once');
    queue = createRendererMarkdownQueue((request, result) => { commits++; lastSource = result.source; stamp('commit', { revision: request.revision }); }, () => { queueFailed++; }, () => {
      const w = new Worker(pathToFileURL(`${out}/bootstrap.mjs`), { workerData: { url }, execArgv: ['--experimental-loader', pathToFileURL(`${out}/loader.mjs`).href] }); workers.push(w);
      const bridge = { onmessage: null, onerror: null, onmessageerror: null, postMessage: data => w.postMessage(data), terminate: () => { void w.terminate(); } };
      w.on('message', data => { if (data.lifecycleReady) globals.push(data); else bridge.onmessage?.({ data }); });
      w.on('error', error => { stamp('worker-error', { message: error.message }); bridge.onerror?.(error); }); return bridge;
    }, 5000);
    queue.submit('**fresh &amp;**\n\n$x+y$\n\n' + 'prose '.repeat(900), true); reloaded.resolve();
  };
  const old = fetch(url).then(async r => ({ status: r.status, body: await r.text() }));
  await began.promise; await writeFile(changed, 'export const fixtureVersion=2;'); await reloaded.promise;
  await until(() => requests === 2, 'automatic reload did not perform its own first HTTP Worker GET');
  assert.equal(calls, 1); assert.equal(active, 1);
  gate.resolve(); const stale = await old; assert.equal(stale.status, 500);
  await until(() => commits === 1 || queueFailed > 0, 'no automatic current queue result'); assert.equal(queueFailed, 0);
  let finalText;
  for (let i = 0; i < 60; i++) { finalText = 'prose '.repeat(900) + ' delta ' + i; queue.submit(finalText, true); }
  await until(() => lastSource === finalText || queueFailed > 0, 'queue did not commit latest source after 60 deltas');
  assert.equal(queueFailed, 0); assert.equal(calls, 2); assert.equal(requests, 2); assert.equal(maxActive, 1);
  assert.deepEqual(statuses.sort(), [200, 500]); assert.equal(globals.length, 1); assert.equal(globals[0].generation, 2);
  const recovery = { passed: true, calls, requests, maxActive, queueFailed, commits, staleStatus: stale.status, statuses, globals, manualThirdRequest: false };
  // Actual Vite close while a real admitted builder is still blocked.
  const closeGate = deferred(), closeBegan = deferred(); let closeActive = 0, closeCalls = 0;
  const closePlugin = devMarkdownWorkers({ timeoutMs: 5000, buildWorker: async () => {
    closeCalls++; closeActive++; closeBegan.resolve(); try { await closeGate.promise; return { code, dependencies: [] }; } finally { closeActive--; }
  } });
  const closeVite = await createServer(options(root, `${out}/close-cache`, [closePlugin])); let closeHttp;
  const responseRefs = [];
  try {
    const closedEndpoint = await listen(closeVite, (req, res) => { responseRefs.push({ res, baseline: res.listenerCount('close') }); closeVite.middlewares(req, res); }); closeHttp = closedEndpoint.http;
    const closePaths = [path, '/src/components/ai/lib/referenceAnalysis.worker.ts?worker_file&type=module'];
    const pending = closePaths.flatMap(entry => Array.from({ length: 32 }, () => fetch(closedEndpoint.origin + entry).then(async r => ({ status: r.status, body: await r.text() }))));
    await closeBegan.promise;
    await until(() => responseRefs.length === 64 && closeCalls === 2, '64 real HTTP waiters/two builder slots were not admitted');
    assert.ok(responseRefs.every(({ res, baseline }) => res.listenerCount('close') === baseline + 1));
    for (const entry of closePaths) { const busy = await fetch(closedEndpoint.origin + entry); assert.equal(busy.status, 503); await busy.text(); }
    await closeVite.close();
    const results = await Promise.race([Promise.all(pending), delay(200).then(() => { throw new Error('close did not settle 64 HTTP waiters before real builder retirement'); })]);
    assert.ok(results.every(result => result.status === 500)); assert.equal(closeActive, 2); assert.equal(closeCalls, 2);
    assert.ok(responseRefs.every(({ res, baseline }) => res.listenerCount('close') === baseline)); assert.equal(closeVite.watcher.listenerCount('all'), 0);
    closeGate.resolve(); await until(() => closeActive === 0, 'closed builders did not retire');
    recovery.close = { pendingStatus: 500, settledBeforeRetirement: true, callbacksRemoved: true, watcherListeners: 0, realBuilders: closeCalls, realPendingHTTP: 64, perWorkerLimit: 32, overflowHTTP503: 2 };
  } finally { closeGate.resolve(); await close(closeHttp, closeVite); }
  const result = { passed: true, recovery, freshBundleSha256: createHash('sha256').update(code).digest('hex'), queueSourceSha256: createHash('sha256').update(queueSource).digest('hex'), trace, limits: 'Real scratch filesystem watcher; ws.send observer creates new exact queue + actual HTTP Node worker. Fresh exact production entry built by real helper. Builder latency injected; generation marker appended only in scratch test HTTP code. No WebView/UGS/QA operations.' };
  await writeFile(`${out}/lifecycle.json`, JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
} finally { gate.resolve(); queue?.dispose(); await Promise.all(workers.map(w => w.terminate())); await close(http, vite); }
