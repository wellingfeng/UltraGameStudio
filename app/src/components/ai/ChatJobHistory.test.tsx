import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import type { BackgroundJobDetail } from '@/lib/chatTasks';
import ChatJobHistory from './ChatJobHistory';

it('shows completed historical job evidence and its actual log without claiming a full conversation', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const job: BackgroundJobDetail = { manifest: { schema: 1, id: 'job', sessionId: 's', workspaceId: 'w',
    label: '安卓 MDSC 基线复现', startedAt: 10_000, progressFile: 'E:/project/test.log', done: {} },
    status: 'success', percent: null, progressTail: '真实日志尾部', probedAt: 20_000 };
  try {
    await act(async () => root.render(<ChatJobHistory jobs={[job]} locale="zh-CN" />));
    expect(container.textContent).toContain('会话后台任务记录 · 1 项');
    await act(async () => {
      const details = container.querySelector('details')!;
      details.open = true;
      details.dispatchEvent(new Event('toggle'));
    });
    expect(container.textContent).toContain('不代表完整对话记录');
    await act(async () => {
      const details = container.querySelectorAll('details')[1];
      details.open = true;
      details.dispatchEvent(new Event('toggle'));
    });
    expect(container.textContent).toContain('真实日志尾部');
    expect(container.textContent).toContain('test.log');
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
