import { build } from 'vite';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const workerPaths = [
  '/src/components/ai/lib/rendererMarkdown.worker.ts',
  '/src/components/ai/lib/referenceAnalysis.worker.ts',
];

async function bundleWorker(server, entry) {
  let dependencies = [];
  const result = await build({
    root: server.config.root, configFile: false, envFile: false,
    mode: 'development', logLevel: 'silent',
    define: { ...server.config.define, 'process.env.NODE_ENV': JSON.stringify('development') },
    resolve: { alias: server.config.resolve.alias },
    plugins: [{
      name: 'ugs-dev-worker-non-dom', enforce: 'pre',
      resolveId(source, importer) {
        if (source === 'decode-named-character-reference' || source === 'hast-util-from-html-isomorphic') {
          return fileURLToPath(import.meta.resolve(source));
        }
        // The old reference-only DOM decoder shim is unnecessary once both
        // workers select the real public non-DOM decoder. Never install a DOM.
        if (source === './referenceWorkerEntities' && importer === resolve(server.config.root, 'src/components/ai/lib/referenceAnalysis.worker.ts').replaceAll('\\', '/')) {
          return '\0ugs-dev-worker-no-legacy-dom';
        }
      },
      load(id) { if (id === '\0ugs-dev-worker-no-legacy-dom') return 'export {};'; },
      generateBundle() { dependencies = [...this.getModuleIds()].filter(id => !id.startsWith('\0')); },
    }],
    build: {
      write: false, minify: false, sourcemap: false,
      lib: { entry, formats: ['es'] },
      rolldownOptions: { output: { codeSplitting: false } },
    },
  });
  const output = Array.isArray(result) ? result[0].output : result.output;
  if (output.length !== 1 || output[0].type !== 'chunk') throw new Error('DEV_WORKER_EXPECTED_SINGLE_MODULE');
  return { code: output[0].code, dependencies };
}

export function devMarkdownWorkers({ buildWorker = bundleWorker, timeoutMs = 30_000, maxWaiters = 32, maxCacheBytes = 8 * 1024 * 1024, maxDependencies = 2048 } = {}) {
  let dispose = () => {};
  return {
    name: 'ugs-dev-markdown-workers', apply: 'serve',
    closeBundle() { dispose(); },
    configureServer(server) {
      let closed = false;
      const states = new Map(workerPaths.map(path => [path, { result: null, pending: null, generation: 0, waiters: new Set() }]));
      const onChange = (_event, changed) => {
        const file = changed.replaceAll('\\', '/');
        let reload = false;
        for (const state of states.values()) {
          if (state.pending || state.result?.dependencies.includes(file) || file.startsWith(`${server.config.root.replaceAll('\\', '/')}/src/`)) {
            reload ||= Boolean(state.pending || state.result);
            state.generation++;
            state.result = null;
            for (const waiter of [...state.waiters]) waiter.finish(new Error('DEV_WORKER_BUILD_INVALIDATED'));
          }
        }
        if (reload) server.ws.send({ type: 'full-reload', path: '*' });
      };
      server.watcher.on('all', onChange);
      dispose = () => {
        if (closed) return;
        closed = true;
        server.watcher.off('all', onChange);
        for (const state of states.values()) {
          state.generation++; state.result = null;
          // Closing HTTP is not cancellation of the actual builder. Retain
          // its admission slot, but release every response and owned timer.
          if (state.pending) { state.pending.expired = true; clearTimeout(state.pending.timer); }
          for (const waiter of [...state.waiters]) waiter.finish(new Error('DEV_WORKER_SERVER_CLOSED'));
        }
      };
      function startBuild(state, path) {
        const pending = { generation: state.generation, expired: false, timer: undefined };
        state.pending = pending;
        pending.timer = setTimeout(() => {
          pending.expired = true;
          for (const waiter of [...state.waiters]) {
            if (waiter.generation === pending.generation) waiter.finish(new Error('DEV_WORKER_BUILD_TIMEOUT'));
          }
        }, timeoutMs);
        const operation = Promise.resolve().then(() => {
          if (closed) throw new Error('DEV_WORKER_SERVER_CLOSED');
          return buildWorker(server, resolve(server.config.root, `.${path}`));
        })
          .then(result => {
            if (pending.expired) throw new Error('DEV_WORKER_BUILD_TIMEOUT');
            if (closed) throw new Error('DEV_WORKER_SERVER_CLOSED');
            if (pending.generation !== state.generation) throw new Error('DEV_WORKER_BUILD_INVALIDATED');
            if (Buffer.byteLength(result.code, 'utf8') > maxCacheBytes) throw new Error('DEV_WORKER_CODE_BUDGET');
            if (result.dependencies.length > maxDependencies) throw new Error('DEV_WORKER_DEPENDENCY_BUDGET');
            state.result = result;
          });
        const retire = error => {
          clearTimeout(pending.timer);
          // Only real settlement releases this slot. A fresh generation's
          // admitted HTTP waiter can now start its build without a third GET.
          state.pending = null;
          for (const waiter of [...state.waiters]) {
            if (error && waiter.generation === pending.generation) waiter.finish(error);
            else advance(state, path, waiter);
          }
        };
        operation.then(() => retire(), retire);
      }
      function advance(state, path, waiter) {
        if (closed) return waiter.finish(new Error('DEV_WORKER_SERVER_CLOSED'));
        if (waiter.generation !== state.generation) return waiter.finish(new Error('DEV_WORKER_BUILD_INVALIDATED'));
        if (state.result) return waiter.finish(null, state.result);
        if (!state.pending) startBuild(state, path);
        if (state.pending.generation === waiter.generation && state.pending.expired) waiter.finish(new Error('DEV_WORKER_BUILD_TIMEOUT'));
      }
      // A pre-middleware serves ONLY the two original worker_file URLs. Its
      // independent build graph never touches the main browser module cache.
      server.middlewares.use(async (req, res, next) => {
        const [path, query = ''] = (req.url ?? '').split('?');
        const params = new URLSearchParams(query);
        if (req.method !== 'GET' || query.length > 256 || !workerPaths.includes(path)
          || params.getAll('worker_file').length !== 1 || params.get('worker_file') !== ''
          || params.getAll('type').length !== 1 || params.get('type') !== 'module'
          || [...params.keys()].some(key => !['worker_file', 'type', 't'].includes(key))
          || params.getAll('t').length > 1 || (params.has('t') && !/^\d{1,20}$/.test(params.get('t')))) return next();
        const state = states.get(path);
        if (state.waiters.size >= maxWaiters) {
          res.statusCode = 503;
          res.setHeader('Content-Type', 'text/javascript');
          res.end('throw new Error("UGS_DEV_WORKER_BUSY");');
          return;
        }
        let settled = false;
        let timer;
        const onClose = () => waiter.finish(null, null, true);
        const waiter = {
          generation: state.generation,
          finish(error, result, disconnected = false) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            res.off?.('close', onClose);
            state.waiters.delete(waiter);
            if (disconnected || res.destroyed || res.writableEnded) return;
            res.setHeader('Content-Type', 'text/javascript');
            if (error) {
              server.config.logger.error(`[ugs-dev-markdown-workers] ${error instanceof Error ? error.message : String(error)}`);
              res.statusCode = 500;
              res.end('throw new Error("UGS_DEV_WORKER_BUILD_FAILED");');
            } else {
              res.setHeader('Cache-Control', 'no-store');
              res.end(result.code);
            }
          },
        };
        // HTTP deadlines and disconnects release only waiter ownership; they
        // cannot free a builder slot or accumulate callbacks on its Promise.
        state.waiters.add(waiter);
        res.on?.('close', onClose);
        timer = setTimeout(() => waiter.finish(new Error('DEV_WORKER_HTTP_TIMEOUT')), timeoutMs);
        advance(state, path, waiter);
      });
    },
  };
}
