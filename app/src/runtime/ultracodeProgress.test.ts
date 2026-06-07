import { describe, expect, it } from 'vitest';
import {
  decodeProgressEvents,
  emptyProgress,
  encodeProgressEvent,
  hasProgressSentinel,
  progressCounts,
  reduceProgress,
  type UltracodeProgressEvent,
} from './ultracodeProgress';

describe('ultracodeProgress encode/decode', () => {
  it('round-trips a single event through a sentinel block', () => {
    const event: UltracodeProgressEvent = {
      kind: 'harness_ready',
      totalNodes: 7,
      maxAgentCalls: 12,
      objective: '修复登录流程',
    };
    const encoded = encodeProgressEvent(event);
    expect(hasProgressSentinel(encoded)).toBe(true);
    const { text, events } = decodeProgressEvents(encoded);
    expect(events).toEqual([event]);
    expect(text.trim()).toBe('');
  });

  it('preserves surrounding prose and decodes events in order', () => {
    const text =
      'hello' +
      encodeProgressEvent({ kind: 'phase', phase: 'executing' }) +
      'world' +
      encodeProgressEvent({ kind: 'agent_calls', spent: 3 });
    const { text: cleaned, events } = decodeProgressEvents(text);
    expect(cleaned).toContain('hello');
    expect(cleaned).toContain('world');
    expect(cleaned).not.toContain('FUC_PROGRESS');
    expect(events).toEqual([
      { kind: 'phase', phase: 'executing' },
      { kind: 'agent_calls', spent: 3 },
    ]);
  });

  it('leaves an incomplete trailing sentinel verbatim for the next chunk', () => {
    const partial = 'tail<<FUC_PROGRESS>>{"kind":"agent_calls","spent":1';
    const { text, events } = decodeProgressEvents(partial);
    expect(events).toEqual([]);
    expect(text).toBe(partial);
  });

  it('drops malformed sentinel JSON silently', () => {
    const bad = '<<FUC_PROGRESS>>{not json}<<FUC_PROGRESS_END>>';
    const { events } = decodeProgressEvents(bad);
    expect(events).toEqual([]);
  });

  it('ignores unknown event kinds', () => {
    const unknown = '<<FUC_PROGRESS>>{"kind":"mystery"}<<FUC_PROGRESS_END>>';
    const { events } = decodeProgressEvents(unknown);
    expect(events).toEqual([]);
  });

  it('returns text unchanged when no sentinel present', () => {
    const { text, events } = decodeProgressEvents('plain log line');
    expect(text).toBe('plain log line');
    expect(events).toEqual([]);
  });
});

describe('reduceProgress', () => {
  it('builds a snapshot from a typical event sequence', () => {
    let p = emptyProgress();
    p = reduceProgress(p, [
      { kind: 'phase', phase: 'planning' },
      { kind: 'harness_ready', totalNodes: 3, maxAgentCalls: 12, objective: 'obj' },
      { kind: 'node', id: 'n_scope', label: '目标冻结', status: 'running' },
      { kind: 'agent_calls', spent: 1 },
    ]);
    expect(p.phase).toBe('executing'); // harness_ready promotes planning → executing
    expect(p.objective).toBe('obj');
    expect(p.totalNodes).toBe(3);
    expect(p.maxAgentCalls).toBe(12);
    expect(p.agentCalls).toBe(1);
    expect(p.nodes).toEqual([{ id: 'n_scope', label: '目标冻结', status: 'running' }]);
  });

  it('does not mutate the previous snapshot', () => {
    const prev = emptyProgress();
    const next = reduceProgress(prev, [{ kind: 'agent_calls', spent: 5 }]);
    expect(prev.agentCalls).toBe(0);
    expect(next.agentCalls).toBe(5);
  });

  it('keeps node status monotonic (no success → running demotion)', () => {
    let p = emptyProgress();
    p = reduceProgress(p, [{ kind: 'node', id: 'a', status: 'success' }]);
    p = reduceProgress(p, [{ kind: 'node', id: 'a', status: 'running' }]);
    expect(p.nodes[0].status).toBe('success');
  });

  it('never regresses agentCalls on a late lower value', () => {
    let p = emptyProgress();
    p = reduceProgress(p, [{ kind: 'agent_calls', spent: 4 }]);
    p = reduceProgress(p, [{ kind: 'agent_calls', spent: 2 }]);
    expect(p.agentCalls).toBe(4);
  });

  it('updates a node label when a later event supplies one', () => {
    let p = emptyProgress();
    p = reduceProgress(p, [{ kind: 'node', id: 'a', status: 'running' }]);
    expect(p.nodes[0].label).toBe('a');
    p = reduceProgress(p, [{ kind: 'node', id: 'a', label: 'Worker', status: 'success' }]);
    expect(p.nodes[0].label).toBe('Worker');
  });

  it('returns the same reference when there are no events', () => {
    const prev = emptyProgress();
    expect(reduceProgress(prev, [])).toBe(prev);
  });
});

describe('progressCounts', () => {
  it('counts completed/running/failed and derives percent from totalNodes', () => {
    let p = emptyProgress();
    p = reduceProgress(p, [
      { kind: 'harness_ready', totalNodes: 4, maxAgentCalls: 12, objective: 'o' },
      { kind: 'node', id: 'a', status: 'success' },
      { kind: 'node', id: 'b', status: 'success' },
      { kind: 'node', id: 'c', status: 'running' },
      { kind: 'node', id: 'd', status: 'error' },
    ]);
    const counts = progressCounts(p);
    expect(counts).toEqual({ completed: 2, running: 1, failed: 1, total: 4, percent: 50 });
  });

  it('falls back to node count when totalNodes is unknown', () => {
    let p = emptyProgress();
    p = reduceProgress(p, [{ kind: 'node', id: 'a', status: 'success' }]);
    expect(progressCounts(p).total).toBe(1);
    expect(progressCounts(p).percent).toBe(100);
  });
});
