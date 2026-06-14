import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SettingsModal from './SettingsModal';
import { defaultBlueprint } from '@/core/defaultBlueprint';
import { DEFAULT_GAME_EXPERT_SETTINGS } from '@/lib/gameExperts';
import { defaultComposer } from '@/store/sampleSessions';
import { useStore } from '@/store/useStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

async function renderSettingsModal(): Promise<{
  container: HTMLDivElement;
  cleanup: () => Promise<void>;
}> {
  useStore.setState({
    locale: 'zh-CN',
    workflow: defaultBlueprint('Current workflow'),
    composer: defaultComposer,
    gameExpertSettings: DEFAULT_GAME_EXPERT_SETTINGS,
  });

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  await act(async () => {
    root.render(<SettingsModal onClose={vi.fn()} />);
  });

  return {
    container,
    cleanup: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

async function clickButtonByText(container: HTMLElement, text: string): Promise<void> {
  const button = Array.from(
    container.querySelectorAll<HTMLButtonElement>('button'),
  ).find((item) => item.textContent?.trim() === text);
  expect(button).toBeInstanceOf(HTMLButtonElement);
  await act(async () => {
    button?.click();
  });
}

async function pasteInput(input: HTMLInputElement, text: string): Promise<void> {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: {
      getData: (type: string) =>
        type === 'text/plain' || type === 'text' ? text : '',
    },
  });
  await act(async () => {
    input.dispatchEvent(event);
  });
}

afterEach(() => {
  window.localStorage.clear();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('SettingsModal game feature navigation', () => {
  it('does not show project-scoped game feature tabs in global settings', async () => {
    const view = await renderSettingsModal();

    try {
      const tabText = Array.from(
        view.container.querySelectorAll('nav [role="tab"]'),
      ).map((tab) => tab.textContent?.trim());

      expect(tabText).not.toContain('Mesh 渠道');
      expect(tabText).not.toContain('骨骼绑定');
      expect(tabText).not.toContain('游戏专家');
      expect(
        Array.from(view.container.querySelectorAll('button')).some(
          (button) => button.textContent?.trim() === '游戏专家',
        ),
      ).toBe(false);
    } finally {
      await view.cleanup();
    }
  });

  it('pastes video provider API keys into password inputs', async () => {
    const view = await renderSettingsModal();

    try {
      await clickButtonByText(view.container, '视频渠道');
      await clickButtonByText(view.container, '免费 / 本地渠道');

      const input = view.container.querySelector<HTMLInputElement>(
        'input[placeholder="r8_..."]',
      );
      expect(input).toBeInstanceOf(HTMLInputElement);

      await pasteInput(input!, 'r8_test_video_key');

      const saved = JSON.parse(
        window.localStorage.getItem('freeultracode.videoGeneration.v1') ?? '{}',
      );
      expect(saved.providerKeys['replicate-video']).toBe('r8_test_video_key');
    } finally {
      await view.cleanup();
    }
  });

  it('pastes speech provider API keys into password inputs', async () => {
    const view = await renderSettingsModal();

    try {
      await clickButtonByText(view.container, '语音渠道');

      const input = view.container.querySelector<HTMLInputElement>(
        'input[placeholder="xi-..."]',
      );
      expect(input).toBeInstanceOf(HTMLInputElement);

      await pasteInput(input!, 'xi_test_speech_key');

      const saved = JSON.parse(
        window.localStorage.getItem('freeultracode.speechGeneration.v1') ?? '{}',
      );
      expect(saved.providerKeys.elevenlabs).toBe('xi_test_speech_key');
    } finally {
      await view.cleanup();
    }
  });
});
