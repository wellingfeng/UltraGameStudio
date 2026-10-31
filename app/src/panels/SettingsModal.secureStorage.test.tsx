import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultBlueprint } from '@/core/defaultBlueprint';
import { ACTIVE_PROVIDER_BY_KIND_STORAGE, PROVIDERS_STORAGE } from '@/lib/apiConfig';
import {
  flushSecureStorage,
  initializeSecureStorage,
  resetSecureStorageForTests,
} from '@/lib/secureStorage';
import { defaultComposer } from '@/store/sampleSessions';
import { useStore } from '@/store/useStore';
import SettingsModal from './SettingsModal';

const native = vi.hoisted(() => ({ records: new Map<string, string>(), failWrites: false }));
vi.mock('@/lib/tauri', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/tauri')>(),
  isTauri: () => true,
  // Metadata is isolated browser data; secrets use the native command seam.
  tauriAvailable: () => false,
  secureSecretGetMany: async (names: string[]) => Object.fromEntries(
    names.filter(name => native.records.has(name)).map(name => [name, native.records.get(name)]),
  ),
  secureSecretSet: async (name: string, value: string) => {
    if (native.failWrites) throw new Error('isolated native write failed');
    native.records.set(name, value);
  },
  secureSecretDelete: async (name: string) => {
    if (native.failWrites) throw new Error('isolated native delete failed');
    native.records.set(name, '');
  },
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => undefined) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let container: HTMLDivElement;

beforeEach(async () => {
  window.localStorage.clear();
  resetSecureStorageForTests();
  native.failWrites = false;
  native.records.clear();
  native.records.set('providers.apiKeys.v1', JSON.stringify({ p1: 'dummy-old' }));
  native.records.set('gateway.channelApiKeys.v1', JSON.stringify({ '["p1","default"]': 'dummy-old' }));
  await initializeSecureStorage();
  window.localStorage.setItem(PROVIDERS_STORAGE, JSON.stringify([{
    id: 'p1', kind: 'anthropic', name: 'Native fixture',
    baseUrl: 'https://example.test', model: 'claude-sonnet-4-5',
  }]));
  window.localStorage.setItem(ACTIVE_PROVIDER_BY_KIND_STORAGE, JSON.stringify({ anthropic: 'p1' }));
  useStore.setState({ locale: 'zh-CN', workflow: defaultBlueprint('Fixture'), composer: defaultComposer });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<SettingsModal onClose={vi.fn()} />));
  const tab = Array.from(container.querySelectorAll('button')).find(button => button.textContent?.trim() === '编程渠道');
  expect(tab).toBeInstanceOf(HTMLButtonElement);
  await act(async () => tab!.click());
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  container?.remove();
  resetSecureStorageForTests();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

async function editKey(): Promise<void> {
  const input = container.querySelector<HTMLInputElement>('input[type="password"]');
  expect(input?.value).toBe('dummy-old');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'dummy-new');
    input!.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('SettingsModal native secret integration (isolated command seam)', () => {
  it('persists an immediate key edit to native records, not inline metadata', async () => {
    await editKey();
    await act(async () => flushSecureStorage());
    expect(JSON.parse(native.records.get('providers.apiKeys.v1')!)).toEqual({ p1: 'dummy-new' });
    expect(JSON.parse(native.records.get('gateway.channelApiKeys.v1')!)['["p1","default"]']).toBe('dummy-new');
    const metadata = JSON.parse(window.localStorage.getItem(PROVIDERS_STORAGE)!);
    expect(metadata[0]).not.toHaveProperty('apiKey');
  });

  it('reports a native write failure instead of treating optimistic input as saved', async () => {
    native.failWrites = true;
    await editKey();
    await act(async () => {
      await expect(flushSecureStorage()).rejects.toThrow('安全存储写入失败');
    });
    expect(JSON.parse(native.records.get('providers.apiKeys.v1')!)).toEqual({ p1: 'dummy-old' });
    expect(container.textContent).toContain('无法保存渠道');
  });
});
