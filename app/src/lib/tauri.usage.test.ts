import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { aiEditViaCli } from './tauri';

const ipc = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: ipc.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: ipc.listen }));

const original = Object.getOwnPropertyDescriptor(globalThis, 'isTauri');

beforeEach(() => {
  Object.defineProperty(globalThis, 'isTauri', { configurable: true, value: true });
  ipc.invoke.mockReset();
  ipc.listen.mockReset();
});

afterEach(() => {
  if (original) Object.defineProperty(globalThis, 'isTauri', original);
  else delete (globalThis as Record<string, unknown>).isTauri;
});

it('forwards terminal usage even after receiving a live snapshot', async () => {
  let onEvent!: (event: { payload: unknown }) => void;
  ipc.listen.mockImplementation(async (_name, callback) => { onEvent = callback; return () => {}; });
  ipc.invoke.mockImplementation(async () => {
    onEvent({ payload: { runId: 'claude-live', usage: { input_tokens: 10, output_tokens: 1 } } });
    return { text: 'done', usage: { input_tokens: 30, output_tokens: 12, total_cost_usd: 0.045 } };
  });
  const onUsage = vi.fn();
  await expect(aiEditViaCli('prompt', 'claude-code', { runId: 'claude-live', onUsage })).resolves.toBe('done');
  expect(onUsage).toHaveBeenCalledTimes(2);
  expect(onUsage).toHaveBeenLastCalledWith({ input_tokens: 30, output_tokens: 12, total_cost_usd: 0.045 });
});
