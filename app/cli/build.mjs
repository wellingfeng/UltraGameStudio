/**
 * esbuild bundler for the `ugs` CLI. Bundles cli/bin/ugs.ts (and its whole
 * import graph — cli/*, src/core/*, src/runtime/*, src/lib/*) into a single
 * self-contained ESM file at cli/dist/ugs.mjs.
 *
 *   - platform=node, format=esm, target=node20
 *   - third-party deps (commander/chalk/@babel/*) are BUNDLED in. The shipped
 *     app carries ONLY cli/dist/ugs.mjs as a Tauri resource — there is no
 *     node_modules next to it at the install location (e.g.
 *     %LOCALAPPDATA%\UltraGameStudio\cli), so leaving them `external` caused
 *     `ERR_MODULE_NOT_FOUND: Cannot find package 'commander'` at runtime for
 *     installed users. Bundling makes the dist self-contained. Node builtins
 *     (node:*) are kept external automatically for platform=node.
 *   - alias `@` -> src   (so `@/lib/id` etc. resolve)
 *   - shebang banner so the bin is directly executable
 *
 * Run: `npm run cli:build`.
 */
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, rmSync, readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const distDir = join(here, 'dist');

mkdirSync(distDir, { recursive: true });
for (const staleFile of ['fu' + 'c.mjs']) {
  rmSync(join(distDir, staleFile), { force: true });
}

// Build timestamp (ISO, second precision) baked into the bundle so a running
// `ugs` can report how old it is. This is the staleness guard for the
// "edited source but ran a stale dist" failure mode — `studio` compares
// this against the newest mtime of its own source tree and warns when the
// dist predates the source.
const __UGS_BUILD_TIME__ = new Date().toISOString().replace(/\.\d+Z$/, 'Z');

await build({
  entryPoints: [join(here, 'bin', 'ugs.ts')],
  outfile: join(distDir, 'ugs.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  // Bundle third-party deps into the output so the shipped ugs.mjs is
  // self-contained (no node_modules at the install location). Node builtins
  // stay external automatically because platform is 'node'.
  packages: 'bundle',
  sourcemap: false,
  // The entry (cli/bin/ugs.ts) already carries `#!/usr/bin/env node`, which
  // esbuild hoists to the first line of the output. We add a createRequire
  // shim AFTER it: bundled CJS deps (commander/chalk/@babel) call
  // `require('events')` etc. internally, and esbuild's ESM `__require` shim
  // throws ("Dynamic require of ... is not supported") for those. Defining a
  // real `require` via node:module makes those builtin requires work in the
  // ESM output.
  banner: {
    js: "import { createRequire as __ugsCreateRequire } from 'node:module'; const require = __ugsCreateRequire(import.meta.url);",
  },
  // `yaml` is imported by backend/src/workspace-skill-service.mjs, which the
  // CLI bundles directly. backend is a sibling of app, so Node's upward
  // node_modules walk from backend/ never reaches app/node_modules — on
  // clean checkouts (Linux/macOS CI) the bare specifier fails to resolve.
  // Pin it to this package's own copy to keep the bundle deterministic.
  alias: { '@': join(root, 'src'), yaml: require.resolve('yaml') },
  define: {
    __UGS_CLI_VERSION__: JSON.stringify(pkg.version),
    __APP_VERSION__: JSON.stringify(pkg.version),
    __UGS_BUILD_TIME__: JSON.stringify(__UGS_BUILD_TIME__),
  },
  logLevel: 'info',
});

console.log(`Built cli/dist/ugs.mjs (build time ${__UGS_BUILD_TIME__})`);

await build({
  entryPoints: [join(here, 'messaging', 'main.ts')],
  outfile: join(distDir, 'ugs-messaging.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  packages: 'bundle',
  banner: { js: "import { createRequire as __ugsCreateRequire } from 'node:module'; import { fileURLToPath as __ugsFileURLToPath } from 'node:url'; import { dirname as __ugsDirname } from 'node:path'; const require = __ugsCreateRequire(import.meta.url); const __filename = __ugsFileURLToPath(import.meta.url); const __dirname = __ugsDirname(__filename);" },
  logLevel: 'info',
});
