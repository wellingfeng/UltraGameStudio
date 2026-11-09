import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { readFileSync } from 'node:fs';
import { devMarkdownWorkers } from './scripts/devMarkdownWorkers.mjs';

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'),
);

export default defineConfig({
  // Relative base so the built assets load correctly inside the Tauri webview.
  base: './',
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [react(), devMarkdownWorkers()],
  worker: {
    plugins: () => [{
      name: 'ugs-worker-non-dom-markdown',
      enforce: 'pre',
      resolveId(source) {
        // Select public non-DOM exports only for worker bundles; the entity
        // decoder and KaTeX HTML-to-HAST adapter otherwise touch DOM globals.
        // The normal page retains Vite's browser decoder and export conditions.
        if (source === 'decode-named-character-reference' || source === 'hast-util-from-html-isomorphic') {
          return fileURLToPath(import.meta.resolve(source));
        }
      },
    }],
  },
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        'temporary-chat': fileURLToPath(new URL('./temporary-chat.html', import.meta.url)),
      },
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@ugs/protocol': fileURLToPath(
        new URL('../packages/protocol/index.ts', import.meta.url),
      ),
    },
  },
  // Tauri expects a fixed dev port and a stable host.
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      // Don't reload the dev server when the app writes its OWN output
      // (autosaved workflows, run state, build artifacts). This avoids spurious
      // HMR reloads that would interrupt a running workflow during self-dev.
      // (Editing source under src/ still reloads — to self-edit the source, run
      // a packaged build as the runner; see SELF-DEV.md.)
      ignored: [
        '**/.ultragamestudio/**',
        '**/*.ugs.json',
        '**/src-tauri/target/**',
        '**/dist/**',
      ],
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/setupTests.ts'],
    globals: true,
  },
});
