import { beforeEach, describe, expect, it, vi } from 'vitest';

import { applyMemoryOp, loadMemory, setMemoryImportance, setMemoryLimits } from './memoryStore';
import { DEFAULT_MEMORY_LIMITS } from './memoryStore';
import { AUTOTAG_SYSTEM, autotagMemoryEntries } from './memoryAutotag';

// In the test env tauriAvailable() is false, so memoryStore falls back to
// localStorage (same pattern as memoryStore.test.ts). Seed the 'user' store
// with legacy entries that carry NO importance tier.
const USER_KEY = 'ultragamestudio.memory.v1:memories/user.json';

function seedUserStore(entries: { text: string; importance?: string }[]): void {
  window.localStorage.setItem(
    USER_KEY,
    JSON.stringify({ version: 2, entries }),
  );
}

beforeEach(() => {
  window.localStorage.clear();
  setMemoryLimits(DEFAULT_MEMORY_LIMITS);
});

describe('autotagMemoryEntries', () => {
  it.each([
    '{"tags":[{"n":1,"importance":"must"}]}',
    '{"tags":[{"n":1,"importance":"must"},{"n":2,"importance":"minor","root":"C:/"}]}',
    '{"tags":[{"n":1,"importance":"must"},{"n":1,"importance":"minor"}]}',
  ])('rejects an incomplete or malformed tagging payload in full: %s', async (raw) => {
    seedUserStore([{ text: 'first' }, { text: 'second' }]);
    const result = await autotagMemoryEntries({ target: 'user', invokeModel: async () => raw });
    expect(result.tagged).toBe(0);
    expect((await loadMemory('user')).every((entry) => !entry.importance)).toBe(true);
  });

  it('does not overwrite a manual tier changed while the model was running', async () => {
    seedUserStore([{ text: 'stable fact' }]);
    const result = await autotagMemoryEntries({ target: 'user', invokeModel: async () => {
      await setMemoryImportance('user', 'stable fact', 'must');
      return '{"tags":[{"n":1,"importance":"minor"}]}';
    } });
    expect(result.tagged).toBe(0);
    expect((await loadMemory('user'))[0].importance).toBe('must');
  });

  it('tags untagged entries and leaves tagged ones alone', async () => {
    seedUserStore([
      { text: '用户偏好深色主题', importance: 'minor' },
      { text: '项目引擎是 Unreal 5' },
      { text: '禁止执行 p4 submit' },
    ]);
    const invoke = vi.fn().mockResolvedValue(
      JSON.stringify({
        tags: [
          { n: 1, importance: 'important' },
          { n: 2, importance: 'must' },
        ],
      }),
    );

    const res = await autotagMemoryEntries({
      target: 'user',
      invokeModel: invoke,
    });

    // Only the 2 untagged entries were candidates; the pre-set 'minor' won.
    expect(res.candidates).toBe(2);
    expect(res.tagged).toBe(2);
    expect(invoke).toHaveBeenCalledTimes(1);

    const entries = await loadMemory('user');
    expect(entries.find((e) => e.text === '用户偏好深色主题')?.importance).toBe('minor');
    expect(entries.find((e) => e.text === '项目引擎是 Unreal 5')?.importance).toBe(
      'important',
    );
    expect(entries.find((e) => e.text === '禁止执行 p4 submit')?.importance).toBe('must');
  });

  it('accepts chinese tiers and tolerant JSON wrapping', async () => {
    seedUserStore([{ text: '工作区路径 E:\\UGS' }, { text: '喜欢简洁回复' }]);
    const invoke = vi
      .fn()
      .mockResolvedValue('好的，评级如下：\n```json\n{"tags":[{"n":1,"importance":"必须"},{"n":2,"importance":"不重要"}]}\n```');

    const res = await autotagMemoryEntries({ target: 'user', invokeModel: invoke });
    expect(res.tagged).toBe(2);
    const entries = await loadMemory('user');
    expect(entries.find((e) => e.text === '工作区路径 E:\\UGS')?.importance).toBe('must');
    expect(entries.find((e) => e.text === '喜欢简洁回复')?.importance).toBe('minor');
  });

  it('is a no-op when every entry already has a tier', async () => {
    await applyMemoryOp('user', { action: 'add', content: '已有标记', importance: 'must' });
    const invoke = vi.fn();
    const res = await autotagMemoryEntries({ target: 'user', invokeModel: invoke });
    expect(res).toEqual({ candidates: 0, tagged: 0 });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('survives a failed batch and still tags the others', async () => {
    seedUserStore([
      ...Array.from({ length: 4 }, (_, i) => ({ text: `条目${i + 1}` })),
    ]);
    let call = 0;
    const invoke = vi.fn().mockImplementation(async (system: string) => {
      expect(system).toBe(AUTOTAG_SYSTEM);
      call += 1;
      if (call === 1) throw new Error('gateway down');
      return '{"tags":[{"n":1,"importance":"must"},{"n":2,"importance":"minor"}]}';
    });

    // batchSize 2 → batch 1 (entries 1-2) fails, batch 2 (entries 3-4) tags.
    const res = await autotagMemoryEntries({
      target: 'user',
      invokeModel: invoke,
      batchSize: 2,
    });
    expect(res.candidates).toBe(4);
    expect(res.tagged).toBe(2);
    const entries = await loadMemory('user');
    expect(entries.find((e) => e.text === '条目3')?.importance).toBe('must');
    expect(entries.find((e) => e.text === '条目4')?.importance).toBe('minor');
    expect(entries.find((e) => e.text === '条目1')?.importance).toBeUndefined();
  });
});
