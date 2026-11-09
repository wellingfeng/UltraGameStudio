// Run explicitly with --out <new owned scratch directory>; no repo cache/output.
import assert from 'node:assert/strict';
import { Worker as NodeWorker } from 'node:worker_threads';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const { build } = createRequire(import.meta.url)('esbuild');
const args = process.argv.slice(2);
const outArg = args[args.indexOf('--out') + 1];
assert.ok(args.includes('--out') && outArg && path.isAbsolute(outArg), 'explicit absolute scratch output required');
const out = path.resolve(outArg);
assert.ok(out.replaceAll('\\', '/').toLowerCase().startsWith('c:/users/fengwei/appdata/local/hermes/cache/scratch/ugs-responsiveness/'), 'owned scratch only');
const source = path.dirname(fileURLToPath(import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const artifacts = [];
for (const name of ['serialization', 'serialization.worker']) {
  const entry = path.join(source, name + '.ts');
  const outfile = path.join(out, name + '.mjs');
  const result = await build({ entryPoints: [entry], bundle: true, platform: 'browser', format: 'esm', outfile, metafile: true });
  const inputs = {};
  for (const input of Object.keys(result.metafile.inputs)) inputs[input] = hash(await readFile(path.resolve(input)));
  artifacts.push({ entry, outfile, source_sha256: hash(await readFile(entry)), bundle_sha256: hash(await readFile(outfile)), inputs });
}
await writeFile(path.join(out, 'build.json'), JSON.stringify(artifacts, null, 2), { flag: 'wx' });
await writeFile(path.join(out, 'thread-bootstrap.mjs'), `
import { parentPort, workerData } from 'node:worker_threads';
let ready=false;const backlog=[];let getterCalls=0;
const owner=workerData.shadow==='array'?Array.prototype:workerData.shadow==='object'?Object.prototype:null;
const old=owner?Object.getOwnPropertyDescriptor(owner,'17'):undefined;
function restore(){if(owner){if(old)Object.defineProperty(owner,'17',old);else Reflect.deleteProperty(owner,'17');}}
globalThis.postMessage=data=>parentPort.postMessage(data);
function dispatch(data){const event=new MessageEvent('message',{data});try {
if(owner)Object.defineProperty(owner,'17',{configurable:true,enumerable:false,get(){getterCalls++;return 'unsafe';}});
globalThis.onmessage(event);
}finally{restore();parentPort.postMessage({observation:true,getterCalls,nativeRequestEvent:true});}}
parentPort.on('message',data=>ready?dispatch(data):backlog.push(data));
await import('./serialization.worker.mjs');ready=true;for(const data of backlog)dispatch(data);
`, { flag: 'wx' });
const priorWorker = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
const cases = [];
let nonce = 0;
async function run(name, { fallback = false, shadow = null, own = true } = {}) {
  const instances = [], observations = [], replyData = [];
  let nativeReplyEvents = 0, getterCalls = 0, written, actual, error;
  let observed;
  const observation = new Promise(resolve => { observed = resolve; });
  const value = Array(18);
  if (own) Object.defineProperty(value, '17', { value: 'own', configurable: true, enumerable: false });
  const before = Object.getOwnPropertyDescriptors(value);
  const expected = JSON.stringify(value, null, 2);
  const owner = shadow === 'array' ? Array.prototype : shadow === 'object' ? Object.prototype : null;
  const old = owner ? Object.getOwnPropertyDescriptor(owner, '17') : undefined;
  const restore = () => { if (owner) { if (old) Object.defineProperty(owner, '17', old); else Reflect.deleteProperty(owner, '17'); } };
  class RealWorker {
    constructor() {
      this.thread = new NodeWorker(pathToFileURL(path.join(out, 'thread-bootstrap.mjs')), { workerData: { shadow } });
      instances.push(this);
      this.thread.on('message', data => {
        if (data.observation) { observations.push(data); observed(); return; }
        const event = new MessageEvent('message', { data });
        nativeReplyEvents++; replyData.push(event.data); this.onmessage?.(event);
      });
      this.thread.on('error', e => { observed(); this.onerror?.(e); });
      this.thread.on('messageerror', e => { observed(); this.onmessageerror?.(e); });
    }
    postMessage(data) { this.thread.postMessage(data); }
    terminate() { return this.thread.terminate(); }
  }
  const { serializeHistory } = await import(pathToFileURL(path.join(out, 'serialization.mjs')).href + '?case=' + (++nonce));
  try {
    Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: fallback ? undefined : RealWorker });
    if (owner) Object.defineProperty(owner, '17', { configurable: true, enumerable: false, get() { getterCalls++; return 'unsafe'; } });
    const pending = serializeHistory(value, { onSerialized: async json => { written = json; } });
    restore();
    actual = await pending;
    if (!fallback) await observation;
  } catch (e) { error = String(e); }
  finally {
    restore();
    if (priorWorker) Object.defineProperty(globalThis, 'Worker', priorWorker); else delete globalThis.Worker;
    await Promise.all(instances.map(w => w.terminate()));
  }
  const witnesses = { returned: actual ?? null, written: written ?? null, write_utf8_hex: written === undefined ? null : Buffer.from(written).toString('hex') };
  const record = { name, fallback, shadow, expected, ...witnesses, error: error ?? null, expected_utf8_hex: Buffer.from(expected).toString('hex'), getterCalls, nativeReplyEvents, threads: instances.length, observations, replyData };
  try {
    assert.equal(error, undefined, 'actual caller must resolve');
    assert.deepEqual(witnesses, { returned: expected, written: expected, write_utf8_hex: Buffer.from(expected).toString('hex') }, 'return AND callback UTF8 asserted OUTSIDE callback');
    assert.deepEqual(Object.getOwnPropertyDescriptors(value), before, 'original input unchanged');
    assert.equal(getterCalls, 0);
    if (!fallback) { assert.equal(instances.length, 1); assert.equal(nativeReplyEvents, 1); assert.equal(observations.length, 1); assert.equal(observations[0].getterCalls, 0); assert.equal(observations[0].nativeRequestEvent, true); assert.equal(replyData[0].json, expected); }
    record.passed = true;
  } catch (e) { record.passed = false; record.assertion = String(e); }
  cases.push(record);
}
await run('actual caller nonenumerable own17');
if (!args.includes('--only-own17')) {
  await run('actual caller true holes', { own: false });
  await run('actual caller own shadow Array.prototype getter', { shadow: 'array' });
  await run('actual caller own shadow Object.prototype getter', { shadow: 'object' });
  await run('fallback own17', { fallback: true });
  await run('fallback own shadow Array.prototype getter', { fallback: true, shadow: 'array' });
  await run('fallback own shadow Object.prototype getter', { fallback: true, shadow: 'object' });
}
const result = { passed: cases.every(x => x.passed), total: cases.length, pass_count: cases.filter(x => x.passed).length, fail_count: cases.filter(x => !x.passed).length, actualThreads: true, productionIO: false, cases };
await writeFile(path.join(out, 'result.json'), JSON.stringify(result, null, 2), { flag: 'wx' });
console.log(JSON.stringify(result));
process.exitCode = result.passed ? 0 : 1;
