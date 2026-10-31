import { afterEach, expect, it, vi } from 'vitest';
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('./tauri', () => ({ tauriAvailable: () => true }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
import { applyMemoryOp } from './memoryStore';
afterEach(() => invoke.mockReset());

it('uses native exact CAS and rejects an unconfirmed readback without history fallback', async () => {
  invoke.mockImplementation(async (command: string) => {
    if (command === 'history_read_json' || command === 'memory_read_json') return null;
    if (command === 'memory_compare_exchange_json') return 'not-the-requested-json';
    return undefined;
  });
  await expect(applyMemoryOp('user', { action: 'add', content: 'fact' })).rejects.toThrow(/readback/i);
  expect(invoke.mock.calls.some(([name]) => name === 'history_write_json')).toBe(false);
  expect(invoke.mock.calls.some(([name]) => name === 'memory_compare_exchange_json')).toBe(true);
});
