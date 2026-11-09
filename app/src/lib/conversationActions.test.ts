import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  tauriAvailable: vi.fn(() => true),
  save: vi.fn(),
  writeTextFile: vi.fn(),
}));

vi.mock('@/lib/tauri', () => ({ tauriAvailable: mocks.tauriAvailable }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: mocks.save }));
vi.mock('@tauri-apps/plugin-fs', () => ({ writeTextFile: mocks.writeTextFile }));

import { copyConversationText, exportConversationText } from './conversationActions';

afterEach(() => {
  vi.restoreAllMocks();
  mocks.save.mockReset();
  mocks.writeTextFile.mockReset();
});

describe('会话复制和导出', () => {
  it('复制完整文本到剪贴板', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    try {
      await copyConversationText('## 用户\n\n问题');
      expect(writeText).toHaveBeenCalledWith('## 用户\n\n问题');
    } finally { vi.unstubAllGlobals(); }
  });

  it('以安全的会话标题保存 Markdown', async () => {
    mocks.save.mockResolvedValue('E:/result.md');
    mocks.writeTextFile.mockResolvedValue(undefined);
    expect(await exportConversationText('内容', '会话/标题')).toBe(true);
    expect(mocks.save).toHaveBeenCalledWith({
      defaultPath: '会话_标题.md',
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    expect(mocks.writeTextFile).toHaveBeenCalledWith('E:/result.md', '内容');
  });

  it('取消保存时不写入文件', async () => {
    mocks.save.mockResolvedValue(null);
    expect(await exportConversationText('内容', '会话')).toBe(false);
    expect(mocks.writeTextFile).not.toHaveBeenCalled();
  });
});
