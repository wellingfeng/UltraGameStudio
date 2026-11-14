import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appendAgentUsage, startActiveAgentUsage, updateActiveAgentUsage, finishActiveAgentUsage } from '@/lib/agentUsageHistory';
import AgentUsage from './AgentUsage';

let host: HTMLDivElement;
let root: Root;
const now = new Date(2026, 10, 10, 12).getTime();
beforeEach(() => { localStorage.clear(); vi.useFakeTimers(); vi.setSystemTime(now); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); });

it('opens on hover, defaults to today, switches dates, reacts to new calls and closes on leave', async () => {
  const base = { application: 'codex', provider: '渠道', model: '模型', inputTokens: 100, outputTokens: 20, cachedInputTokens: 40, estimated: false };
  appendAgentUsage({ ...base, recordedAt: now - 86400000, model: '昨天模型' });
  appendAgentUsage({ ...base, recordedAt: now, costUsd: 0.045, elapsedMs: 5000, firstResponseMs: 1000 });
  await act(async () => root.render(<AgentUsage />));
  const wrapper = host.querySelector('.ugs-agent-usage')!;
  expect(host.querySelector('#ugs-agent-usage-panel')).toBeNull();
  await act(async () => wrapper.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
  expect(host.textContent).toContain('$0.0450');
  expect(host.textContent).toContain('≈4.0 tok/s');
  expect(host.textContent).not.toContain('昨天模型');
  const select = host.querySelector<HTMLSelectElement>('select')!;
  await act(async () => { select.value = '2026-11-09'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(host.textContent).toContain('昨天模型');
  await act(async () => { select.value = 'today'; select.dispatchEvent(new Event('change', { bubbles: true })); appendAgentUsage({ ...base, recordedAt: now + 1, model: '新模型', cachedInputTokens: 0, estimated: true }); });
  expect(host.textContent).toContain('新模型');
  expect(host.textContent).toContain('≈100');
  await act(async () => wrapper.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })));
  await act(async () => vi.advanceTimersByTime(180));
  expect(host.querySelector('#ugs-agent-usage-panel')).toBeNull();
  await act(async () => wrapper.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
  expect(host.querySelector<HTMLSelectElement>('select')!.value).toBe('today');
});

it('closes with Escape and returns focus to the trigger', async () => {
  await act(async () => root.render(<AgentUsage />));
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Agent 使用情况"]')!.focus());
  await act(async () => host.querySelector<HTMLSelectElement>('select')!.focus());
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(host.querySelector('#ugs-agent-usage-panel')).toBeNull();
  expect(document.activeElement?.getAttribute('aria-label')).toBe('Agent 使用情况');
});

it('shows active calls from all sessions without inventing token counts', async () => {
  appendAgentUsage({ recordedAt: now - 1000, application: 'codex', provider: 'Kuro', model: 'terra', inputTokens: 10, outputTokens: 2, cachedInputTokens: 0, estimated: false });
  await act(async () => root.render(<AgentUsage />));
  await act(async () => host.querySelector('.ugs-agent-usage')!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
  let id = '';
  await act(async () => { id = startActiveAgentUsage({ recordedAt: now, application: 'codex', provider: 'Kuro', model: 'astra' }); });
  const active = host.querySelector('tr[data-status="running"]')!;
  expect(active.textContent).toContain('astra');
  expect(active.textContent).toContain('进行中');
  expect(active.textContent).toContain('—');
  expect(host.textContent).toContain('全部会话');
  expect(host.textContent).toContain('terra');
  await act(async () => updateActiveAgentUsage(id, { inputTokens: 100, outputTokens: 20, cachedInputTokens: 30, hasUsage: true }));
  expect(active.textContent).toContain('70');
  expect(active.textContent).toContain('20');
  await act(async () => finishActiveAgentUsage(id));
  expect(host.querySelector('tr[data-status="running"]')).toBeNull();
});
