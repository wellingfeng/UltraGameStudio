import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SCHEDULED_TASK_TEMPLATES, taskFromTemplate } from '@/lib/scheduledTaskTemplates';
import ScheduledTaskDialog from './ScheduledTaskDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let container: HTMLDivElement;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  container?.remove();
});

describe('定时任务保留设置', () => {
  it('默认不限次数，启用后可保存最近一次并显示清理说明', async () => {
    const task = taskFromTemplate(SCHEDULED_TASK_TEMPLATES[0], 'zh-CN');
    const save = vi.fn().mockResolvedValue(undefined);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root!.render(<ScheduledTaskDialog locale="zh-CN" title="周报" initialTask={task} onSave={save} onDelete={() => {}} onClose={() => {}} />));
    const label = [...container.querySelectorAll('label')].find((item) => item.textContent?.includes('限制保留记录'))!;
    const checkbox = label.querySelector('input')!;
    expect(checkbox.checked).toBe(false);
    await act(async () => checkbox.click());
    expect(container.textContent).toContain('已生成的文件不会删除');
    expect(container.querySelector<HTMLInputElement>('input[type="number"][min="1"]')?.value).toBe('1');
    const button = [...container.querySelectorAll('button')].find((item) => item.textContent?.trim() === '保存')!;
    await act(async () => button.click());
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ maxHistoryRuns: 1 }));
  });

  it('重新打开时恢复保留次数，且拒绝无效输入', async () => {
    const task = { ...taskFromTemplate(SCHEDULED_TASK_TEMPLATES[0], 'zh-CN'), maxHistoryRuns: 2 };
    const save = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root!.render(<ScheduledTaskDialog locale="zh-CN" title="周报" initialTask={task} onSave={save} onDelete={() => {}} onClose={() => {}} />));
    const input = container.querySelector<HTMLInputElement>('input[type="number"][min="1"]')!;
    expect(input.value).toBe('2');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '0');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const button = [...container.querySelectorAll('button')].find((item) => item.textContent?.trim() === '保存')!;
    await act(async () => button.click());
    expect(save).not.toHaveBeenCalled();
    expect(container.textContent).toContain('保留次数必须是大于 0 的整数');
  });

  it('关闭限制后保存为不限次数', async () => {
    const task = { ...taskFromTemplate(SCHEDULED_TASK_TEMPLATES[0], 'zh-CN'), maxHistoryRuns: 2 };
    const save = vi.fn().mockResolvedValue(undefined);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root!.render(<ScheduledTaskDialog locale="zh-CN" title="周报" initialTask={task} onSave={save} onDelete={() => {}} onClose={() => {}} />));
    const label = [...container.querySelectorAll('label')].find((item) => item.textContent?.includes('限制保留记录'))!;
    await act(async () => label.querySelector('input')!.click());
    const button = [...container.querySelectorAll('button')].find((item) => item.textContent?.trim() === '保存')!;
    await act(async () => button.click());
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0][0]).not.toHaveProperty('maxHistoryRuns');
  });
});
