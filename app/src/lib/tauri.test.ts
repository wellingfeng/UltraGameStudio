import { afterEach, describe, expect, it } from 'vitest';
import { executableExtensionOf, tauriAvailable } from './tauri';

const tauriGlobalKeys = ['isTauri', '__TAURI_INTERNALS__', '__TAURI__'] as const;
const originalTauriGlobals = new Map(
  tauriGlobalKeys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
);

function setTauriGlobal(key: (typeof tauriGlobalKeys)[number], value: unknown): void {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value,
  });
}

afterEach(() => {
  for (const key of tauriGlobalKeys) {
    const descriptor = originalTauriGlobals.get(key);
    if (descriptor) {
      Object.defineProperty(globalThis, key, descriptor);
    } else {
      delete (globalThis as Record<string, unknown>)[key];
    }
  }
});

describe('tauriAvailable', () => {
  it('detects the Tauri v2 isTauri global', () => {
    setTauriGlobal('isTauri', true);

    expect(tauriAvailable()).toBe(true);
  });

  it('detects injected Tauri IPC globals', () => {
    setTauriGlobal('__TAURI_INTERNALS__', {});
    expect(tauriAvailable()).toBe(true);

    delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
    setTauriGlobal('__TAURI__', {});
    expect(tauriAvailable()).toBe(true);
  });
});

describe('executableExtensionOf', () => {
  it('detects Windows drive-letter executable paths', () => {
    expect(executableExtensionOf('C:\\Temp\\evil.exe')).toBe('exe');
    expect(executableExtensionOf('D:\\Tools\\shortcut.lnk')).toBe('lnk');
  });

  it('strips query/hash and editor line hints without cutting the drive prefix', () => {
    expect(executableExtensionOf('C:\\Temp\\evil.exe?download=1')).toBe('exe');
    expect(executableExtensionOf('C:\\Temp\\shortcut.lnk#L12')).toBe('lnk');
    expect(executableExtensionOf('C:\\Temp\\script.ps1:12:3')).toBe('ps1');
  });

  it('ignores non-executable paths', () => {
    expect(executableExtensionOf('C:\\Temp\\notes.txt')).toBeNull();
  });
});
