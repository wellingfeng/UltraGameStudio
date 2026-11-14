import { afterEach, expect, it, vi } from 'vitest';
import { beginSessionHandoff, finishSessionHandoff, useSessionHandoffStatus } from './sessionHandoffStatus';

afterEach(() => {
  useSessionHandoffStatus.setState({ bySession: {} });
  vi.useRealTimers();
});

it('旧完成提示的计时器不会清除同一会话的新交接', () => {
  vi.useFakeTimers();
  expect(beginSessionHandoff('workspace::session', '准备')).toBe(true);
  expect(beginSessionHandoff('workspace::session', '重复')).toBe(false);
  finishSessionHandoff('workspace::session', { kind: 'done', text: '完成' });
  vi.advanceTimersByTime(3000);
  expect(beginSessionHandoff('workspace::session', '再次准备')).toBe(true);
  vi.advanceTimersByTime(1000);
  expect(useSessionHandoffStatus.getState().bySession['workspace::session']).toEqual({ kind: 'busy', text: '再次准备' });
  finishSessionHandoff('workspace::session', { kind: 'error', text: '失败' });
  vi.advanceTimersByTime(4000);
  expect(useSessionHandoffStatus.getState().bySession['workspace::session']).toBeUndefined();
});
