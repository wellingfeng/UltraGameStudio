import { afterEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  invoke: vi.fn(),
  channels: [] as Array<{ onmessage?: (message: null) => void }>,
}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: native.invoke,
  Channel: class {
    onmessage?: (message: null) => void;
    constructor() { native.channels.push(this); }
  },
}));

import { updateCli } from './tauri';

afterEach(() => {
  delete (globalThis as { isTauri?: boolean }).isTauri;
  native.invoke.mockReset();
  native.channels.length = 0;
});

describe('CLI update Tauri bridge', () => {
  it('passes a start channel to the backend and reports when work starts', async () => {
    (globalThis as { isTauri?: boolean }).isTauri = true;
    native.invoke.mockResolvedValue('完成');
    const onStarted = vi.fn();
    const result = updateCli('codex', onStarted);
    await expect(result).resolves.toBe('完成');
    expect(native.invoke).toHaveBeenCalledWith('update_cli', {
      adapter: 'codex',
      onStarted: native.channels[0],
    });
    expect(onStarted).not.toHaveBeenCalled();
    native.channels[0].onmessage?.(null);
    expect(onStarted).toHaveBeenCalledOnce();
  });
});
