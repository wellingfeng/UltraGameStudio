import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import config from '../vite.config.ts';

const scratch = process.argv[2];
assert.ok(scratch, 'Pass an isolated scratch directory');
await mkdir(scratch, { recursive: true });
const loader = `${scratch}/http-loader.mjs`;
const bootstrap = `${scratch}/worker-bootstrap.mjs`;
await writeFile(loader, `export async function resolve(specifier, context, next) {
  if (specifier.startsWith('http://')) return { url: specifier, shortCircuit: true };
  if (context.parentURL?.startsWith('http://') && (specifier.startsWith('/') || specifier.startsWith('.'))) return { url: new URL(specifier, context.parentURL).href, shortCircuit: true };
  return next(specifier, context);
}
export async function load(url, context, next) {
  if (!url.startsWith('http://')) return next(url, context);
  const response = await fetch(url);
  if (!response.ok) throw new Error('HTTP_WORKER_MODULE_' + response.status + ': ' + await response.text());
  return { format: 'module', source: await response.text(), shortCircuit: true };
}
`);
await writeFile(bootstrap, `import assert from 'node:assert/strict';
import { parentPort, workerData } from 'node:worker_threads';
globalThis.self = globalThis;
globalThis.postMessage = value => parentPort.postMessage(value);
assert.equal(typeof document, 'undefined');
assert.equal(typeof window, 'undefined');
await import(workerData.url);
assert.equal(typeof self.onmessage, 'function');
parentPort.on('message', data => self.onmessage({ data }));
`);
const server = await createServer({
  ...config, root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, envFile: false,
  cacheDir: `${scratch}/vite-cache`,
  server: { middlewareMode: true, watch: null, hmr: false, ws: false },
  optimizeDeps: { noDiscovery: true, include: ['extend', 'debug'], exclude: ['decode-named-character-reference', 'hast-util-from-html-isomorphic', 'katex', 'unified', 'remark-parse', 'remark-gfm', 'remark-breaks', 'remark-math', 'remark-rehype', 'rehype-katex'] },
});
const http = createHttpServer(server.middlewares);
try {
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${http.address().port}`;
  async function probe(name, request) {
    const url = `${origin}/src/components/ai/lib/${name}.worker.ts?worker_file&type=module`;
    const response = await fetch(url);
    assert.equal(response.status, 200, await response.text());
    const worker = new Worker(new URL(`file:///${bootstrap.replaceAll('\\', '/')}`), {
      workerData: { url }, execArgv: ['--experimental-loader', new URL(`file:///${loader.replaceAll('\\', '/')}`).href],
    });
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Full development worker response timed out')), 20000);
        worker.once('error', error => { clearTimeout(timer); reject(error); });
        worker.once('message', value => { clearTimeout(timer); resolve(value); });
        worker.postMessage(request);
      });
    } finally { await worker.terminate(); }
  }
  const renderer = await probe('rendererMarkdown', { revision: 7, text: '**bold &amp; &CounterClockwiseContourIntegral;**\n\n$x+y$\n\n---\n\n[Docs](https://example.com/docs)', streaming: true });
  assert.equal(renderer.revision, 7);
  assert.equal(renderer.error, undefined);
  assert.equal(renderer.result.tree.type, 'root');
  const tree = JSON.stringify(renderer.result.tree);
  assert.ok(tree.includes('katex'));
  assert.ok(tree.includes('bold & ∳'));
  const reference = await probe('referenceAnalysis', { id: 8, text: '[Docs &amp;](https://example.com/docs)', sources: [{ url: 'https://example.com/docs', title: 'Verified docs', toolCallId: 'fixture-web' }] });
  assert.equal(reference.id, 8);
  assert.equal(reference.error, undefined);
  assert.equal(reference.references.length, 1);
  assert.equal(reference.references[0].url, 'https://example.com/docs');
  const resolutions = [];
  for (const dependency of ['decode-named-character-reference', 'hast-util-from-html-isomorphic']) {
    const result = await server.environments.client.pluginContainer.resolveId(dependency, fileURLToPath(new URL('../src/components/ai/lib/rendererMarkdown.ts', import.meta.url)));
    resolutions.push({ dependency, id: result.id });
  }
  console.log(JSON.stringify({ mainResolutionCheckpoint: resolutions }));
  assert.ok(resolutions[0].id.split('?')[0].endsWith('index.dom.js'));
  assert.ok(resolutions[1].id.split('?')[0].endsWith('lib/browser.js'));
  console.log(JSON.stringify({ passed: true, renderer: { hast: true, math: true, entities: true }, reference: { verified: true }, mainBrowserResolutions: resolutions, transport: 'Actual Vite serve HTTP responses, complete ES module graph in real Node worker_threads; no synthetic DOM/parser', browserWebView: 'not exercised' }, null, 2));
} finally {
  await new Promise(resolve => http.close(resolve));
  await server.close();
}
