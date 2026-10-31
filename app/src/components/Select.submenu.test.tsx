import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Select from '@/components/Select';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = '';
});

describe('Select 二级菜单', () => {
  it('按模型展示不同档位，选择时同时提交模型与档位', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onChange = vi.fn();
    const onSubChange = vi.fn();
    await act(async () => {
      root.render(
        <Select
          title="模型"
          options={[{ id: 'first', label: '模型一' }, { id: 'second', label: '模型二' }, { id: 'plain', label: '无思考' }]}
          value="first"
          onChange={onChange}
          getSubOptions={(model) => model === 'plain' ? [] : [{ id: model === 'first' ? 'low' : 'high', label: model === 'first' ? '低' : '高' }]}
          subTitle="思考深度"
          subValue="low"
          onSubChange={onSubChange}
          triggerSuffix="低"
        />,
      );
    });
    try {
      const trigger = container.querySelector<HTMLButtonElement>('button[title="模型"]');
      expect(trigger?.textContent).toContain('低');
      await act(async () => { trigger?.click(); });
      const models = container.querySelectorAll<HTMLButtonElement>('[role="option"]');
      expect(models[0].textContent).toContain('低');
      await act(async () => { models[0].click(); });
      expect(document.querySelector('[role="menuitemradio"]')?.getAttribute('aria-checked')).toBe('true');
      await act(async () => { models[1].click(); });
      const level = document.querySelector<HTMLButtonElement>('[role="menuitemradio"]');
      expect(level?.textContent).toContain('高');
      expect(level?.getAttribute('aria-checked')).toBe('false');
      await act(async () => { level?.click(); });
      expect(onSubChange).toHaveBeenCalledWith('second', 'high');
      expect(onChange).not.toHaveBeenCalled();
      expect(document.querySelector('[role="menu"]')).toBeNull();
      await act(async () => { trigger?.click(); });
      await act(async () => { container.querySelectorAll<HTMLButtonElement>('[role="option"]')[2].click(); });
      expect(onChange).toHaveBeenCalledWith('plain');
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  });
});
