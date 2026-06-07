/**
 * esbuild bundler for the `fuc` CLI. Bundles cli/bin/fuc.ts (and its whole
 * import graph — cli/*, src/core/*, src/runtime/*, src/lib/*) into a single
 * self-contained ESM file at cli/dist/fuc.mjs.
 *
 *   - platform=node, format=esm, target=node20
 *   - packages=external  (commander/chalk/@babel/* resolved from node_modules
 *     at runtime; the bin is run from inside the repo so they are present)
 *   - alias `@` -> src   (so `@/lib/id` etc. resolve)
 *   - shebang banner so the bin is directly executable
 *
 * Run: `npm run cli:build`.
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

// Build timestamp (ISO, second precision) baked into the bundle so a running
// `fuc` can report how old it is. This is the staleness guard for the
// "edited source but ran a stale dist" failure mode — `ultracode` compares
// this against the newest mtime of its own source tree and warns when the
// dist predates the source.
const __FUC_BUILD_TIME__ = new Date().toISOString().replace(/\.\d+Z$/, 'Z');

await build({
  entryPoints: [join(here, 'bin', 'fuc.ts')],
  outfile: join(here, 'dist', 'fuc.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  packages: 'external',
  sourcemap: false,
  // The entry (cli/bin/fuc.ts) already carries `#!/usr/bin/env node`, which
  // esbuild preserves as the bundle's first line — so no extra banner here
  // (a banner would produce a duplicate shebang and break ESM parsing).
  alias: { '@': join(root, 'src') },
  define: {
    __FUC_CLI_VERSION__: JSON.stringify(pkg.version),
    __APP_VERSION__: JSON.stringify(pkg.version),
    __FUC_BUILD_TIME__: JSON.stringify(__FUC_BUILD_TIME__),
  },
  logLevel: 'info',
});

console.log(`Built cli/dist/fuc.mjs (build time ${__FUC_BUILD_TIME__})`);
