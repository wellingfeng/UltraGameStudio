import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { readFileSync } from 'node:fs';
var pkg = JSON.parse(readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'));
export default defineConfig({
    // Relative base so the built assets load correctly inside the Tauri webview.
    base: './',
    define: { __APP_VERSION__: JSON.stringify(pkg.version) },
    plugins: [react()],
    resolve: {
        alias: {
            '@': fileURLToPath(new URL('./src', import.meta.url)),
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
                '**/.omc/**',
                '**/*.fuc.json',
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
