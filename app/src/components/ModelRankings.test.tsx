import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const state = {
    intelligence: { entries: [{ name: 'Alpha', creator: 'A', score: 59, pricing: { inputUsd: 2, outputUsd: 8 } }, { name: 'Beta', creator: 'B', score: 58, pricing: null as { inputUsd: number | null; outputUsd: number | null } | null }], fetchedAt: 1793613600000, loading: false, error: false },
  };
  return { state, refresh: vi.fn(async () => {}), start: vi.fn(), stop: vi.fn(), openExternal: vi.fn() };
});
vi.mock('@/lib/modelRankings', () => ({
  INTELLIGENCE_SOURCE: 'https://artificialanalysis.ai/leaderboards/models',
  modelRankings: { getState: () => mocks.state, subscribe: () => () => {}, refresh: mocks.refresh, start: mocks.start, stop: mocks.stop },
}));
vi.mock('@/lib/tauri', () => ({ openExternal: mocks.openExternal }));
import ModelRankings from './ModelRankings';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); mocks.state.intelligence.loading = false; host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); });

it('opens on hover, keeps the panel interactive and collapses after leaving', async () => {
  await act(async () => root.render(<ModelRankings />));
  const trigger = host.querySelector<HTMLButtonElement>('[aria-label="模型榜单"]')!;
  expect(trigger.textContent).toBe('');
  expect(trigger.querySelector('svg')).not.toBeNull();
  expect(host.querySelector('#ugs-model-rankings-panel')).toBeNull();
  await act(async () => host.querySelector('.ugs-model-rankings')!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
  expect(host.querySelector('#ugs-model-rankings-panel')?.textContent).toContain('Alpha');
  expect(host.querySelector('#ugs-model-rankings-panel')?.textContent).toContain('59');
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="立即刷新模型榜单"]')!.click());
  expect(mocks.refresh).toHaveBeenCalledTimes(1);
  await act(async () => host.querySelector('.ugs-model-rankings')!.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })));
  await act(async () => vi.advanceTimersByTime(180));
  expect(host.querySelector('#ugs-model-rankings-panel')).toBeNull();
  expect(mocks.start).toHaveBeenCalled();
});

it('keeps the refresh button focused during loading and ignores repeated clicks', async () => {
  await act(async () => root.render(<ModelRankings />));
  const wrapper = host.querySelector('.ugs-model-rankings')!;
  await act(async () => wrapper.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
  const refresh = host.querySelector<HTMLButtonElement>('[aria-label="立即刷新模型榜单"]')!;
  await act(async () => refresh.focus());
  await act(async () => {
    mocks.state.intelligence.loading = true;
    root.render(<ModelRankings />);
  });
  expect(refresh.disabled).toBe(false);
  expect(refresh.getAttribute('aria-disabled')).toBe('true');
  expect(document.activeElement).toBe(refresh);
  await act(async () => refresh.click());
  expect(mocks.refresh).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTime(180));
  expect(host.querySelector('#ugs-model-rankings-panel')).not.toBeNull();
  await act(async () => wrapper.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })));
  await act(async () => vi.advanceTimersByTime(180));
  expect(host.querySelector('#ugs-model-rankings-panel')).toBeNull();
});

it('shows one intelligence ranking with input and output prices and keeps rank when searching', async () => {
  await act(async () => root.render(<ModelRankings />));
  await act(async () => host.querySelector('.ugs-model-rankings')!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
  expect(host.querySelector('[role="tablist"]')).toBeNull();
  let rows = host.querySelectorAll('.ugs-model-rankings-row');
  expect(rows[0].textContent).toContain('Alpha');
  expect(rows[0].querySelector('.ugs-model-rankings-price')?.getAttribute('aria-label')).toBe('输入 $2，输出 $8，美元 / 百万 Token');
  expect(rows[1].querySelector('.ugs-model-rankings-price')?.getAttribute('aria-label')).toBe('输入 —，输出 —，美元 / 百万 Token');
  const input = host.querySelector<HTMLInputElement>('input')!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, 'Beta');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  rows = host.querySelectorAll('.ugs-model-rankings-row');
  expect(rows).toHaveLength(1);
  expect(rows[0].textContent).toContain('02');
  expect(rows[0].textContent).toContain('58');
  await act(async () => host.querySelector<HTMLButtonElement>('.ugs-model-rankings-meta button')!.click());
  expect(mocks.openExternal).toHaveBeenCalledWith('https://artificialanalysis.ai/leaderboards/models');
});

it('closes with Escape while returning keyboard focus to the trigger', async () => {
  await act(async () => root.render(<ModelRankings />));
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="模型榜单"]')!.focus());
  await act(async () => host.querySelector<HTMLInputElement>('input')!.focus());
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(host.querySelector('#ugs-model-rankings-panel')).toBeNull();
  expect(document.activeElement?.getAttribute('aria-label')).toBe('模型榜单');
});
