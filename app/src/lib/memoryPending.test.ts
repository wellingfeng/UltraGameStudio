import { beforeEach, describe, expect, it } from 'vitest';

import {
  applyMemoryOp,
  loadMemory,
} from './memoryStore';
import {
  listPendingMemoryWrites,
  parseTriageVerdict,
  queuePendingMemoryWrites,
  resolvePendingMemoryWrites,
  triagePendingMemoryWrites,
} from './memoryPending';

beforeEach(async () => {
  window.localStorage.clear();
  // Start each test with an empty queue.
  const pending = await listPendingMemoryWrites();
  if (pending.length) {
    await resolvePendingMemoryWrites(
      pending.map((p) => p.id),
      'reject',
    );
  }
  await applyMemoryOp('user', { action: 'add', content: '已有条目' });
});

describe('memoryPending queue', () => {
  it('queues one complete batch per target and lists it oldest-first', async () => {
    const added = await queuePendingMemoryWrites(
      [
        {
          target: 'user',
          operations: [
            { action: 'add', content: '第一条' },
            { action: 'add', content: '第二条' },
          ],
        },
      ],
      'review',
    );
    expect(added).toBe(2);
    const list = await listPendingMemoryWrites();
    expect(list).toHaveLength(1);
    expect(list[0].operations.map((op) => op.content)).toEqual(['第一条', '第二条']);
    expect(list[0].op.content).toBe('第一条');
    expect(list[0].source).toBe('review');
    expect(list[0].target).toBe('user');
  });

  it('does not queue the identical pending op twice', async () => {
    await queuePendingMemoryWrites([{ target: 'user', operations: [{ action: 'add', content: '重复提案' }] }], 'review');
    const again = await queuePendingMemoryWrites([{ target: 'user', operations: [{ action: 'add', content: '重复提案' }] }], 'review');
    expect(again).toBe(0);
    expect(await listPendingMemoryWrites()).toHaveLength(1);
  });

  it('approval applies the op through the normal store gates', async () => {
    await queuePendingMemoryWrites([{ target: 'user', operations: [{ action: 'add', content: '批准后入库' }] }], 'refresh');
    const list = await listPendingMemoryWrites();
    const res = await resolvePendingMemoryWrites(
      list.map((p) => p.id),
      'approve',
    );
    expect(res.resolvedIds).toHaveLength(1);
    const texts = (await loadMemory('user')).map((e) => e.text);
    expect(texts).toContain('批准后入库');
    expect(await listPendingMemoryWrites()).toHaveLength(0);
  });

  it('approved-but-rejected-by-store ops (duplicate) still leave the queue', async () => {
    await queuePendingMemoryWrites([{ target: 'user', operations: [{ action: 'add', content: '已有条目' }] }], 'review');
    const list = await listPendingMemoryWrites();
    const res = await resolvePendingMemoryWrites(list.map((p) => p.id), 'approve');
    expect(res.resolvedIds).toHaveLength(1);
    // duplicate add is skipped by the store; queue is drained either way
    expect(await listPendingMemoryWrites()).toHaveLength(0);
    expect((await loadMemory('user')).map((e) => e.text)).toEqual(['已有条目']);
  });

  it('reject removes without applying', async () => {
    await queuePendingMemoryWrites([{ target: 'user', operations: [{ action: 'add', content: '拒绝这条' }] }], 'review');
    const list = await listPendingMemoryWrites();
    await resolvePendingMemoryWrites(list.map((p) => p.id), 'reject');
    expect((await loadMemory('user')).map((e) => e.text)).toEqual(['已有条目']);
    expect(await listPendingMemoryWrites()).toHaveLength(0);
  });

  it('unknown ids are ignored', async () => {
    const res = await resolvePendingMemoryWrites(['nope'], 'approve');
    expect(res.resolvedIds).toHaveLength(0);
  });
});

describe('memoryPending AI triage', () => {
  it('retains the entire queue when the screened revision changes while the model runs', async () => {
    await queuePendingMemoryWrites([{ target: 'user', operations: [{ action: 'add', content: 'first' }] }], 'review');
    const [screened] = await listPendingMemoryWrites();
    const verdict = await triagePendingMemoryWrites(async () => {
      await queuePendingMemoryWrites([{ target: 'user', operations: [{ action: 'add', content: 'concurrent' }] }], 'review');
      return JSON.stringify({ drop: [screened.id], keep: [] });
    });
    expect(verdict.verdictOk).toBe(false);
    expect(verdict.dropped).toBe(0);
    expect(await listPendingMemoryWrites()).toHaveLength(2);
  });

  it('screens every operation and the original workspace of each complete batch', async () => {
    await queuePendingMemoryWrites([{ target: 'memory', operations: [
      { action: 'remove', oldText: 'old project rule' }, { action: 'add', content: 'replacement project rule' },
    ] }], 'review', 'original-A');
    let observed = '';
    await triagePendingMemoryWrites(async (_system, prompt) => {
      observed = prompt;
      const writes = await listPendingMemoryWrites();
      return JSON.stringify({ drop: [], keep: writes.map((write) => write.id) });
    });
    expect(observed).toContain('old project rule');
    expect(observed).toContain('replacement project rule');
    expect(observed).toContain('original-A');
  });

  it('rejects the ids the model drops, keeps the rest queued', async () => {
    for (const content of ['用户偏好简短直接的回复', '今天网络超时了一次', '用户用 Unreal 做项目']) {
      await queuePendingMemoryWrites([{ target: 'user', operations: [{ action: 'add', content }] }], 'review');
    }
    const queued = await listPendingMemoryWrites();
    const dropId = queued[1].id; // the transient network error
    const keepIds = [queued[0].id, queued[2].id];
    const res = await triagePendingMemoryWrites(async () =>
      JSON.stringify({ drop: [dropId], keep: keepIds }),
    );
    expect(res).toEqual({ total: 3, dropped: 1, kept: 2, verdictOk: true });
    const after = await listPendingMemoryWrites();
    expect(after.map((p) => p.id).sort()).toEqual(keepIds.slice().sort());
    // dropped one was rejected (removed), NOT applied to the store
    expect((await loadMemory('user')).map((e) => e.text)).toEqual(['已有条目']);
  });

  it('drops nothing when the verdict omits/duplicates ids or is unparseable', async () => {
    for (const content of ['事实A', '事实B']) {
      await queuePendingMemoryWrites([{ target: 'user', operations: [{ action: 'add', content }] }], 'review');
    }
    const queued = await listPendingMemoryWrites();
    const [a, b] = queued.map((p) => p.id);

    // duplicate id in both buckets → distrust
    let res = await triagePendingMemoryWrites(async () =>
      JSON.stringify({ drop: [a], keep: [a, b] }),
    );
    expect(res.verdictOk).toBe(false);
    expect(res.dropped).toBe(0);

    // unparseable → distrust
    res = await triagePendingMemoryWrites(async () => 'not json at all');
    expect(res.verdictOk).toBe(false);
    expect(res.dropped).toBe(0);

    // model call throws → distrust
    res = await triagePendingMemoryWrites(async () => {
      throw new Error('gateway down');
    });
    expect(res.verdictOk).toBe(false);
    expect(res.dropped).toBe(0);

    // nothing was dropped; both still queued
    expect(await listPendingMemoryWrites()).toHaveLength(2);
  });

  it.each([
    '{"drop":["a"],"keep":[]}',
    '{"drop":["a"],"keep":["b",3]}',
    '{"drop":["a"],"keep":["b"],"root":"C:/"}',
    '{"drop":["a","a"],"keep":["b"]}',
    '{"drop":["a"],"keep":["a","b"]}',
  ])('rejects incomplete or malformed exact-ID verdicts: %s', (raw) => {
    expect(parseTriageVerdict(raw, new Set(['a', 'b']))).toBeNull();
  });

  it('parseTriageVerdict accepts a fenced json block', () => {
    const ids = new Set(['x1', 'x2']);
    expect(parseTriageVerdict('```json\n{"drop":["x1"],"keep":["x2"]}\n```', ids)).toEqual({
      drop: ['x1'],
      keep: ['x2'],
    });
    expect(parseTriageVerdict('{"drop":["x3"],"keep":["x1"]}', ids)).toBeNull(); // unknown id
  });

  it('returns zeroed counts on an empty queue', async () => {
    const res = await triagePendingMemoryWrites(async () => '{"drop":[],"keep":[]}');
    expect(res).toEqual({ total: 0, dropped: 0, kept: 0, verdictOk: true });
  });
});
