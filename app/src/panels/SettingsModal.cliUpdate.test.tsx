import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { defaultBlueprint } from '@/core/defaultBlueprint';
import { refreshCliUpdateStatus } from '@/lib/cliUpdateStatus';
import type { CliVersionStatus } from '@/lib/tauri';
import { defaultComposer } from '@/store/sampleSessions';
import { useStore } from '@/store/useStore';
import SettingsModal from './SettingsModal';

const native = vi.hoisted(() => ({
  jobs: new Map<string, { start: () => void; resolve: (detail: string) => void; reject: (error: string) => void }>(),
  holdCheck: false,
  extraStatuses: [] as CliVersionStatus[],
  requests: [] as string[],
  releaseCheck: undefined as (() => void) | undefined,
}));
vi.mock('@/lib/tauri', async (original) => ({
  ...await original<typeof import('@/lib/tauri')>(),
  isTauri: () => true,
  tauriAvailable: () => false,
  checkCliUpdates: async () => {
    const statuses = ['claude-code', 'codex'].map((adapter) => ({
      adapter,
      label: adapter === 'codex' ? 'Codex' : 'Claude Code',
      installedVersion: '1.0',
      latestVersion: '2.0',
      updateAvailable: true,
      checkedAtMs: Date.now(),
    }));
    if (native.holdCheck) await new Promise<void>((resolve) => { native.releaseCheck = resolve; });
    return [...statuses, ...native.extraStatuses];
  },
  updateCli: (adapter: string, onStarted: () => void) => new Promise<string>((resolve, reject) => {
    native.requests.push(adapter);
    native.jobs.set(adapter, { start: onStarted, resolve, reject });
  }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('settings CLI update queue', () => {
  it('accepts multiple clicks and retains queued state after closing settings', async () => {
    useStore.setState({ locale: 'zh-CN', workflow: defaultBlueprint('Fixture'), composer: defaultComposer });
    const container = document.createElement('div');
    document.body.appendChild(container);
    let root = createRoot(container);
    const render = async () => act(async () => { root.render(<SettingsModal onClose={vi.fn()} />); });
    const row = (name: string) => Array.from(container.querySelectorAll('div.flex.flex-wrap'))
      .find((element) => element.textContent?.includes(name) && element.querySelector('button'))!;
    try {
      await render();
      expect(row('Claude Code')).toBeDefined();
      expect(row('Codex')).toBeDefined();
      await act(async () => {
        row('Claude Code').querySelector('button')!.click();
        row('Codex').querySelector('button')!.click();
        native.jobs.get('claude-code')!.start();
      });
      expect(row('Claude Code').textContent).toContain('更新中…');
      expect(row('Codex').textContent).toContain('排队中…');
      expect(row('Codex').querySelector('button')!.disabled).toBe(true);

      await act(async () => root.unmount());
      root = createRoot(container);
      await render();
      expect(row('Claude Code').textContent).toContain('更新中…');
      expect(row('Codex').textContent).toContain('排队中…');

      await act(async () => {
        native.jobs.get('claude-code')!.reject('测试更新失败');
        await Promise.resolve();
        native.jobs.get('codex')!.start();
      });
      expect(row('Claude Code').textContent).toContain('更新失败：测试更新失败');
      expect(row('Codex').textContent).toContain('更新中…');
      native.holdCheck = true;
      await act(async () => { native.jobs.get('codex')!.resolve('完成'); });
      expect(native.releaseCheck).toBeTypeOf('function');
      expect(row('Claude Code').textContent).toContain('更新失败：测试更新失败');
      expect(row('Codex').textContent).not.toContain('排队中…');
      expect(row('Claude Code').querySelector('button')!.disabled).toBe(false);
      await act(async () => { native.releaseCheck!(); });
    } finally {
      await act(async () => root.unmount());
      container.remove();
      window.localStorage.clear();
    }
  });

  it('queues every available update without installing or duplicating other CLIs', async () => {
    native.holdCheck = false;
    native.jobs.clear();
    native.requests = [];
    native.extraStatuses = [
      { adapter: 'gemini', label: 'Gemini CLI', installedVersion: '2.0', latestVersion: '2.0', updateAvailable: false, checkedAtMs: Date.now() },
      { adapter: 'kimi', label: 'Kimi Code', installedVersion: null, latestVersion: '2.0', installable: true, updateAvailable: false, checkedAtMs: Date.now() },
      { adapter: 'grok', label: 'Grok', installedVersion: '1.0', latestVersion: '2.0', updateAvailable: true, checkedAtMs: Date.now() },
    ];
    await act(async () => { await refreshCliUpdateStatus(); });
    useStore.setState({ locale: 'zh-CN', workflow: defaultBlueprint('Fixture'), composer: defaultComposer });
    const container = document.createElement('div');
    document.body.appendChild(container);
    let root = createRoot(container);
    const render = async () => act(async () => { root.render(<SettingsModal onClose={vi.fn()} />); });
    const row = (name: string) => Array.from(container.querySelectorAll('div.flex.flex-wrap'))
      .find((element) => element.textContent?.includes(name) && element.querySelector('button'))!;
    const button = (name: string) => Array.from(container.querySelectorAll('button'))
      .find((element) => element.textContent?.trim() === name)!;
    try {
      await render();
      await act(async () => {
        row('Claude Code').querySelector('button')!.click();
        native.jobs.get('claude-code')!.start();
      });
      native.holdCheck = true;
      await act(async () => { button('重新检测').click(); });
      expect(button('全部更新').disabled).toBe(false);
      await act(async () => { button('全部更新').click(); });
      expect(native.requests).toEqual(['claude-code', 'codex', 'grok']);
      expect(row('Claude Code').textContent).toContain('更新中…');
      expect(row('Codex').textContent).toContain('排队中…');
      expect(row('Grok').textContent).toContain('排队中…');
      expect(button('全部更新').disabled).toBe(true);
      expect(native.jobs.has('gemini')).toBe(false);
      expect(native.jobs.has('kimi')).toBe(false);

      await act(async () => root.unmount());
      root = createRoot(container);
      await render();
      expect(row('Grok').textContent).toContain('排队中…');
      await act(async () => {
        native.jobs.get('codex')!.start();
        native.jobs.get('codex')!.reject('测试失败');
        await Promise.resolve();
      });
      expect(row('Codex').textContent).toContain('更新失败：测试失败');
      expect(button('全部更新').disabled).toBe(false);
      await act(async () => { button('全部更新').click(); });
      expect(native.requests).toEqual(['claude-code', 'codex', 'grok', 'codex']);
      expect(button('全部更新').disabled).toBe(true);
      await act(async () => { native.releaseCheck!(); });
      await act(async () => {
        for (const adapter of ['claude-code', 'codex', 'grok']) native.jobs.get(adapter)!.reject('测试结束');
        await Promise.resolve();
      });
    } finally {
      await act(async () => root.unmount());
      container.remove();
      native.holdCheck = false;
      native.extraStatuses = [];
      window.localStorage.clear();
    }
  });
});
