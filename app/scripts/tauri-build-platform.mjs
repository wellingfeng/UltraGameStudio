#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const bundleByPlatform = {
  win32: 'nsis',
  darwin: 'app,dmg',
  linux: 'deb,appimage',
};

const bundles = bundleByPlatform[process.platform];
if (!bundles) {
  console.error(`Unsupported platform for Tauri packaging: ${process.platform}`);
  process.exit(1);
}

const env = { ...process.env };
if (process.platform === 'win32' && !env.RUSTUP_TOOLCHAIN) {
  env.RUSTUP_TOOLCHAIN = 'stable-x86_64-pc-windows-msvc';
}

const result = spawnSync('tauri', ['build', '--bundles', bundles], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env,
});

process.exit(result.status ?? 1);
