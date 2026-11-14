import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import MemorySettings from './MemorySettings';
import { applyMemoryOp, loadMemory } from '@/lib/memoryStore';
import { listPendingMemoryWrites, queuePendingMemoryWrites, resolvePendingMemoryWrites } from '@/lib/memoryPending';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  window.localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

const flush = () => act(async () => { await Promise.resolve(); });

describe('MemorySettings', () => {
  it('keeps review diagnostics in the background while showing pending proposals', async () => {
    const { loadMemoryReviewJournal, saveMemoryReviewJournal } = await import('@/lib/memoryConfig');
    const source = { hostId: 'desktop', namespaceId: 'local', workspaceId: 'original-A', sessionId: 'saved-session',
      turnId: 'saved-user', sourceMessageId: 'saved-user', runId: 'original-run', cwd: 'E:/original' };
    const jobs = (['reading', 'applied', 'awaiting_approval', 'noop', 'failed', 'cancelled'] as const).map((phase) => ({
      id: phase, source, phase, appliedOps: phase === 'applied' ? 2 : 0, queuedOps: phase === 'awaiting_approval' ? 3 : 0,
      updatedAt: 1000, usage: { calls: 1, inputTokens: 23, estimated: true },
      ...(phase === 'failed' ? { error: 'provider unavailable', recordingError: 'audit unavailable' } : {}),
    }));
    await saveMemoryReviewJournal(null, { version: 1, scheduler: { consumed: [], attempted: [], lastCompleted: [] }, jobs });
    await queuePendingMemoryWrites([{ target: 'user', operations: [{ action: 'add', content: 'pending fact' }] }], 'review');
    await act(async () => { root.render(<MemorySettings locale="zh-CN" workspaceId="current-B" />); });
    await flush();
    expect(container.querySelector('[aria-label="记忆复盘诊断"]')).toBeNull();
    expect(container.textContent).not.toContain('刷新诊断');
    expect(container.textContent).not.toContain('saved-session');
    expect(container.textContent).not.toContain('provider unavailable');
    expect(container.textContent).toContain('pending fact');
    expect(Array.from(container.querySelectorAll('button')).some((button) => button.title === '通过')).toBe(true);
    const reject = Array.from(container.querySelectorAll('button')).find((button) => button.title === '拒绝');
    expect(reject).toBeTruthy();
    await act(async () => { reject!.click(); });
    await flush();
    expect(await listPendingMemoryWrites()).toEqual([]);
    expect(await loadMemory('user')).toEqual([]);
    expect((await loadMemoryReviewJournal()).value.jobs).toEqual(jobs);
  });

  it('uses hidden journal scopes to find receipts from another workspace', async () => {
    const { saveMemoryReviewJournal } = await import('@/lib/memoryConfig');
    await queuePendingMemoryWrites([{ target: 'memory', operations: [{ action: 'add', content: 'saved fact' }] }], 'review', 'original-A');
    const [batch] = await listPendingMemoryWrites();
    await resolvePendingMemoryWrites([batch.id], 'approve');
    const source = { hostId: 'desktop', namespaceId: 'local', workspaceId: 'original-A', sessionId: 'saved-session',
      turnId: 'saved-user', sourceMessageId: 'saved-user', runId: 'original-run' };
    await saveMemoryReviewJournal(null, { version: 1, scheduler: { consumed: [], attempted: [], lastCompleted: [] },
      jobs: [{ id: 'applied', source, phase: 'applied', appliedOps: 1, queuedOps: 0, updatedAt: 1000 }] });
    await act(async () => { root.render(<MemorySettings locale="zh-CN" workspaceId="current-B" />); });
    await flush();
    const transactions = container.querySelector('[aria-label="记忆事务与撤销"]');
    expect(transactions?.textContent).toContain('原项目：original-A');
    expect(transactions?.textContent).toContain('预览撤销');
    expect(container.querySelector('[aria-label="记忆复盘诊断"]')).toBeNull();
  });

  it('exposes undo only from fresh target receipts and restores the original batch scope', async () => {
    await applyMemoryOp('memory', { action: 'add', content: 'original fact' }, 'A');
    await queuePendingMemoryWrites([{ target: 'memory', operations: [{ action: 'replace', oldText: 'original fact', content: 'updated fact' }] }], 'review', 'A');
    await act(async () => { root.render(<MemorySettings locale="zh-CN" workspaceId="B" />); });
    await flush();
    await act(async () => { Array.from(container.querySelectorAll('button')).find((button) => button.title === '通过')!.click(); });
    await flush();
    const undo = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '预览撤销');
    expect(undo).toBeTruthy();
    await act(async () => { undo!.click(); });
    expect(container.textContent).toContain('original fact');
    expect(container.textContent).toContain('updated fact');
    await act(async () => { Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '确认 CAS 撤销')!.click(); });
    await flush();
    expect((await loadMemory('memory', 'A')).map((entry) => entry.text)).toEqual(['original fact']);
    expect(await loadMemory('memory', 'B')).toEqual([]);
    expect(container.textContent).toContain('已撤销');
  });

  it('requires an explicit persisted original source selection before staging a legacy batch', async () => {
    const { historyStore } = await import('@/store/history/store');
    vi.spyOn(historyStore, 'listWorkspaces').mockResolvedValue([{ id: 'A', name: 'Original A' }] as Awaited<ReturnType<typeof historyStore.listWorkspaces>>);
    vi.spyOn(historyStore, 'listSessions').mockResolvedValue([{ id: 's', title: 'Saved source' }] as Awaited<ReturnType<typeof historyStore.listSessions>>);
    localStorage.setItem('ultragamestudio.memory.v1:memories/pending.json', JSON.stringify({ version: 1, writes: [{ id: 'legacy', target: 'memory', op: { action: 'add', content: 'legacy diff' }, source: 'review', proposedAt: 1000 }] }));
    localStorage.setItem('ultragamestudio.history.v1:workspaces/A/sessions/s.json', JSON.stringify({ id: 's', workspaceId: 'A', messages: [{ id: 'u', role: 'user', text: 'actual saved user message' }] }));
    await act(async () => { root.render(<MemorySettings locale="zh-CN" workspaceId="B" />); });
    await flush();
    const open = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '确认旧提案原来源');
    expect(open).toBeTruthy();
    await act(async () => { open!.click(); });
    const choose = async (label: string, value: string) => act(async () => { const select = container.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement; select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await choose('原项目', 'A'); await flush();
    await choose('原会话', 's'); await flush();
    await choose('原用户消息', 'u'); await flush();
    await act(async () => { Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '读取原来源与当前 base')!.click(); });
    await flush();
    expect(container.textContent).toContain('actual saved user message');
    const confirm = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '确认完整来源、作用域与 diff（仅重建提案）')!;
    expect(confirm.disabled).toBe(true);
    await act(async () => { (container.querySelector('input[aria-label="确认完整旧提案"]') as HTMLInputElement).click(); });
    await act(async () => { confirm.click(); }); await flush();
    const { listPendingMemoryWrites } = await import('@/lib/memoryPending');
    const [rebuilt] = await listPendingMemoryWrites();
    expect(rebuilt.workspaceId).toBe('A');
    expect(rebuilt.status).toBe('awaiting_approval');
    expect(await loadMemory('memory', 'A')).toEqual([]);
    expect(await loadMemory('memory', 'B')).toEqual([]);
  });

  it('renders existing user and workspace-scoped memory entries', async () => {
    await applyMemoryOp('user', { action: 'add', content: '称呼小王' });
    await applyMemoryOp('memory', { action: 'add', content: '引擎=Unity' }, 'ws-a');

    await act(async () => {
      root.render(<MemorySettings locale="zh-CN" workspaceId="ws-a" />);
    });
    await flush();

    expect(container.textContent).toContain('长期记忆');
    expect(container.textContent).toContain('称呼小王');
    expect(container.textContent).toContain('引擎=Unity');
    expect(container.textContent).toContain('更新于');
  });

  it('does not show another workspace memory', async () => {
    await applyMemoryOp('memory', { action: 'add', content: '引擎=Godot' }, 'ws-b');

    await act(async () => {
      root.render(<MemorySettings locale="zh-CN" workspaceId="ws-a" />);
    });
    await flush();

    expect(container.textContent).not.toContain('引擎=Godot');
  });

  it('shows the original workspace and every operation of one approval batch', async () => {
    await applyMemoryOp('memory', { action: 'add', content: 'old note' }, 'workspace-A');
    await queuePendingMemoryWrites([{ target: 'memory', operations: [
      { action: 'remove', oldText: 'old note' }, { action: 'add', content: 'new note' },
    ] }], 'review', 'workspace-A');
    await act(async () => { root.render(<MemorySettings locale="zh-CN" workspaceId="workspace-B" />); });
    await flush();
    expect(container.textContent).toContain('workspace-A');
    expect(container.textContent).toContain('old note');
    expect(container.textContent).toContain('new note');
  });

  it('retains the batch and surfaces the real write error after failed approval', async () => {
    await queuePendingMemoryWrites([{ target: 'user', operations: [{ action: 'add', content: 'pending fact' }] }], 'review');
    await act(async () => { root.render(<MemorySettings locale="zh-CN" workspaceId="B" />); });
    await flush();
    const original = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (key.endsWith('user.json')) throw new Error('disk quota exhausted');
      original.call(this, key, value);
    });
    const approve = Array.from(container.querySelectorAll('button')).find((button) => button.title === '通过');
    expect(approve).toBeTruthy();
    await act(async () => { approve!.click(); });
    await flush();
    expect(container.textContent).toContain('disk quota exhausted');
    expect(container.textContent).toContain('pending fact');
    expect(await loadMemory('user')).toEqual([]);
  });

  it('explains a changed target and retains the proposal for review', async () => {
    await applyMemoryOp('user', { action: 'add', content: 'original target' });
    await queuePendingMemoryWrites([{ target: 'user', operations: [{ action: 'remove', oldText: 'target' }] }], 'review');
    await applyMemoryOp('user', { action: 'replace', oldText: 'target', content: 'changed target' });
    await act(async () => { root.render(<MemorySettings locale="zh-CN" workspaceId="B" />); });
    await flush();
    await act(async () => { Array.from(container.querySelectorAll('button')).find((button) => button.title === '通过')!.click(); });
    await flush();
    expect(container.textContent).toContain('待删除或替换的记忆已变化：target');
    expect(container.textContent).toContain('提案未写入');
    expect(await listPendingMemoryWrites()).toHaveLength(1);
    expect((await loadMemory('user')).map((entry) => entry.text)).toEqual(['changed target']);
  });

  it('adds a user entry through the input', async () => {
    await act(async () => {
      root.render(<MemorySettings locale="zh-CN" workspaceId={null} />);
    });
    await flush();

    const input = container.querySelector<HTMLInputElement>('input[type="text"]');
    expect(input).toBeTruthy();
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )!.set!;
    await act(async () => {
      nativeSetter.call(input, '偏好简体中文');
      input!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();

    const buttons = Array.from(container.querySelectorAll('button'));
    const addBtn = buttons.find((b) => b.textContent?.includes('添加'));
    expect(addBtn).toBeTruthy();
    await act(async () => {
      addBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect((await loadMemory('user')).map((e) => e.text)).toContain('偏好简体中文');
  });
});
