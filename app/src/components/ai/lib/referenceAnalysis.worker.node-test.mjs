// Exact current production entry + public Vite development HTTP worker tests.
// Only owned port0/threads/fixtures; no DOM supplied, no application launched.
import assert from 'node:assert/strict';
import { createServer as httpServer } from 'node:http';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { runInThisContext } from 'node:vm';
if (!isMainThread) {
  globalThis.self = globalThis; globalThis.postMessage = value => parentPort.postMessage(value);
  assert.equal(typeof document, 'undefined'); assert.equal(typeof window, 'undefined');
  runInThisContext(await readFile(workerData.path, 'utf8'), { filename: workerData.path });
  parentPort.postMessage({ initialized: true, document: typeof document, window: typeof window });
  parentPort.on('message', data => self.onmessage({ data }));
} else {
  const app = fileURLToPath(new URL('../../../../', import.meta.url));
  assert.ok(process.argv[2], 'explicit owned scratch directory required');
  const scratch = resolve(process.argv[2]); assert.ok(!scratch.startsWith(resolve(app))); await mkdir(scratch, { recursive: true });
  const { build, createServer } = await import(pathToFileURL(join(app, 'node_modules/vite/dist/node/index.js')).href);
  const { default: config } = await import(pathToFileURL(join(app, 'vite.config.ts')).href);
  const result = { passed: false, production: [], development: [], cleanup: false, gates: 'full build is concurrent checkpoint, not product gate; decoder shim only, no supplied DOM' };
  const workers = new Set(); let vite, http;
  async function request(worker, value) {
    return await new Promise((resolveReply, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error('OWN_THREAD_TIMEOUT')); }, 20000);
      function cleanup() { clearTimeout(timer); worker.off('message', message); worker.off('error', error); }
      function message(value) { if (value.initialized) { worker.init = value; return; } cleanup(); resolveReply(value); }
      function error(error) { cleanup(); reject(error); }
      worker.on('message', message); worker.on('error', error); worker.postMessage(value);
    });
  }
  const source = { url: 'https://example.com/docs', title: 'Docs', toolCallId: 'fixture' };
  async function verify(worker) {
    const cases = [];
    const invalid = [null, undefined, { id: '1', text: 'text', sources: [source] }, { id: 2, text: 42, sources: [source] },
      { id: 3, text: 'text', sources: [null] }, { id: 4, text: 'text', sources: [{ ...source, extra: 1n }] },
      { id: 5, text: 'text', sources: [{ ...source, title: 'x'.repeat(4 * 1024 * 1024) }] },
      { id: 6, text: '\u0000'.repeat(800000), sources: [source] },
      { id: 7, text: '[' + 'x'.repeat(4097) + '](https://example.com/docs)', sources: [{ ...source, title: source.url }] },
      { id: 8, text: 'text', sources: Array.from({ length: 100 }, () => ({ ...source, title: 'x'.repeat(3000) })) },
      { id: 9, text: 'text', sources: [{ ...source, url: 'javascript:alert(1)' }] }];
    for (let index = 0; index < invalid.length; index++) {
      const response = await request(worker, invalid[index]);
      assert.deepEqual(response, { id: typeof invalid[index]?.id === 'number' ? invalid[index].id : 0, error: 'REFERENCE_ANALYSIS_FAILED' });
      assert.ok(Buffer.byteLength(JSON.stringify(response)) <= 256 * 1024); cases.push({ name: 'malformed-or-budget-' + index, passed: true });
    }
    const other = { ...source, url: 'https://example.com/other', title: 'Other' };
    const text = '<think>[Hidden](https://example.com/docs)</think>[Other][ref] [Docs](https://example.com/docs#api) [download](https://example.com/other) `[Code](https://example.com/docs)` ![Image](https://example.com/docs)\n\n```md\n[Code](https://example.com/docs)\n```\n\n[ref]: https://example.com/other';
    assert.deepEqual(await request(worker, { id: 20, text, sources: [source, other] }), { id: 20, references: [{ ...other, number: 1 }, { ...source, number: 2 }] });
    cases.push({ name: 'first-use-definitions-exclusions', passed: true });
    const entity = await request(worker, { id: 21, text: '[Docs &amp; &CounterClockwiseContourIntegral;](https://example.com/docs)', sources: [{ ...source, title: source.url }] });
    assert.equal(entity.references[0].title, 'Docs & ∳'); cases.push({ name: 'safe-entities', passed: true });
    return { cases, initialization: worker.init };
  }
  try {
    const before = performance.now();
    await build({ ...config, root: app, configFile: false, envFile: false, cacheDir: join(scratch, 'build-cache'), logLevel: 'warn', build: { ...config.build, outDir: join(scratch, 'fresh-full-app-build'), emptyOutDir: true } });
    result.buildMs = performance.now() - before;
    const assets = join(scratch, 'fresh-full-app-build/assets'); const matches = (await readdir(assets)).filter(name => name.startsWith('referenceAnalysis.worker-') && name.endsWith('.js')); assert.equal(matches.length, 1);
    const path = join(assets, matches[0]); const bytes = await readFile(path); const worker = new Worker(new URL(import.meta.url), { workerData: { path } }); workers.add(worker);
    try { result.production.push({ path, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, ...await verify(worker) }); }
    finally { await worker.terminate(); workers.delete(worker); }
    const loader = join(scratch, 'http-loader.mjs'), bootstrap = join(scratch, 'http-worker.mjs');
    await writeFile(loader, `export async function resolve(s,c,n){if(s.startsWith('http://'))return{url:s,shortCircuit:true};if(c.parentURL?.startsWith('http://')&&(s.startsWith('/')||s.startsWith('.')))return{url:new URL(s,c.parentURL).href,shortCircuit:true};return n(s,c);}export async function load(u,c,n){if(!u.startsWith('http://'))return n(u,c);const r=await fetch(u);if(!r.ok)throw new Error('HTTP_MODULE_'+r.status);return{format:'module',source:await r.text(),shortCircuit:true};}`);
    await writeFile(bootstrap, `import assert from 'node:assert/strict';import{parentPort,workerData}from'node:worker_threads';globalThis.self=globalThis;globalThis.postMessage=x=>parentPort.postMessage(x);assert.equal(typeof document,'undefined');assert.equal(typeof window,'undefined');await import(workerData.url);parentPort.postMessage({initialized:true,document:typeof document,window:typeof window});parentPort.on('message',data=>self.onmessage({data}));`);
    vite = await createServer({ ...config, root: app, configFile: false, envFile: false, cacheDir: join(scratch, 'dev-cache'), server: { middlewareMode: true, watch: null, hmr: false, ws: false }, optimizeDeps: { noDiscovery: true, include: [] } });
    http = httpServer(vite.middlewares); await new Promise(resolveListen => http.listen(0, '127.0.0.1', resolveListen)); result.port = http.address().port; assert.notEqual(result.port, 5173);
    const url = 'http://127.0.0.1:' + result.port + '/src/components/ai/lib/referenceAnalysis.worker.ts?worker_file&type=module'; const response = await fetch(url); assert.equal(response.status, 200);
    const devBytes = Buffer.from(await response.text()); const devPath = join(scratch, 'referenceAnalysis-actual-http.js'); await writeFile(devPath, devBytes);
    const devWorker = new Worker(pathToFileURL(bootstrap), { workerData: { url }, execArgv: ['--experimental-loader', pathToFileURL(loader).href] }); workers.add(devWorker);
    try { result.development.push({ url, path: devPath, sha256: createHash('sha256').update(devBytes).digest('hex'), bytes: devBytes.length, ...await verify(devWorker) }); }
    finally { await devWorker.terminate(); workers.delete(devWorker); }
    result.passed = true;
  } catch (error) { result.error = error.stack; process.exitCode = 1; }
  finally {
    for (const worker of workers) await worker.terminate(); if (http) await new Promise(resolveClose => http.close(resolveClose)); if (vite) await vite.close(); result.cleanup = true;
    await writeFile(join(scratch, 'actual-workers.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
  }
}
