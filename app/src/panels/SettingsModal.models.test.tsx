import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultBlueprint } from '@/core/defaultBlueprint';
import {
  ACTIVE_PROVIDER_BY_KIND_STORAGE,
  PROVIDERS_STORAGE,
  type Provider,
} from '@/lib/apiConfig';
import {
  ACTIVE_GATEWAY_SELECTION_STORAGE,
  getActiveGatewaySelection,
  setActiveGatewaySelection,
} from '@/lib/gatewayConfig';
import { workflowDefaultGatewaySelection } from '@/lib/modelGateway/resolver';
import { installQuitFlushHandler } from '@/lib/quitFlush';
import { remoteProviderId } from '@/lib/remoteWorkspace';
import { defaultComposer } from '@/store/sampleSessions';
import { useStore } from '@/store/useStore';
import SettingsModal from './SettingsModal';

const tauriEventMocks = vi.hoisted(() => ({
  listen: vi.fn(async (event: string, handler: () => void) => {
    void event;
    void handler;
    return () => undefined;
  }),
}));

const tauriMocks = vi.hoisted(() => ({
  isTauri: vi.fn(() => true),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: tauriEventMocks.listen,
}));

vi.mock('@/lib/tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tauri')>();
  return {
    ...actual,
    isTauri: tauriMocks.isTauri,
  };
});

// These DOM tests verify editing and the synchronous browser/quit fallback.
// The Tauri flag above enables native event/UI paths, not a working key store.
// Native durability and rejection are tested at the secure-storage seam.
vi.mock('@/lib/secureStorage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/secureStorage')>();
  return {
    ...actual,
    secureStorageAvailable: () => false,
    secureStorageAllowsInlineFallback: () => true,
    flushSecureStorage: vi.fn(async () => undefined),
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

async function renderSettingsModal(): Promise<{
  container: HTMLDivElement;
  onClose: ReturnType<typeof vi.fn>;
  cleanup: () => Promise<void>;
}> {
  const onClose = vi.fn();
  useStore.setState({
    locale: 'zh-CN',
    workflow: defaultBlueprint('Current workflow'),
    composer: defaultComposer,
  });

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  await act(async () => {
    root.render(<SettingsModal onClose={onClose} />);
  });

  return {
    container,
    onClose,
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

function findButtonContaining(
  container: HTMLElement,
  text: string,
): HTMLButtonElement {
  const button = Array.from(
    container.querySelectorAll<HTMLButtonElement>('button'),
  ).find((item) => item.textContent?.includes(text));
  expect(button).toBeInstanceOf(HTMLButtonElement);
  return button!;
}

function modelListInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>(
    'input[placeholder="搜索或输入自定义模型名…"]',
  );
  expect(input).toBeInstanceOf(HTMLInputElement);
  return input!;
}

async function setInputValue(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function addModel(container: HTMLElement, model: string): Promise<void> {
  const input = modelListInput(container);
  await setInputValue(input, model);
  const row = input.parentElement;
  const button = row?.querySelector<HTMLButtonElement>('button');
  expect(button).toBeInstanceOf(HTMLButtonElement);
  await act(async () => {
    button?.click();
  });
}

async function clickDeleteModel(
  container: HTMLElement,
  model: string,
): Promise<void> {
  const label = modelListInput(container).closest('label');
  const item = Array.from(label?.querySelectorAll<HTMLLIElement>('li') ?? []).find(
    (candidate) =>
      candidate
        .querySelector<HTMLButtonElement>('button')
        ?.textContent?.replace(/^●\s*/u, '')
        .trim()
        .toLowerCase() === model.toLowerCase(),
  );
  expect(item).toBeInstanceOf(HTMLLIElement);
  const button = item?.querySelectorAll<HTMLButtonElement>('button')[1];
  expect(button).toBeInstanceOf(HTMLButtonElement);
  await act(async () => {
    button?.click();
  });
}

function optionLabels(container: HTMLElement): string[] {
  const label = modelListInput(container).closest('label');
  const labels = Array.from(label?.querySelectorAll<HTMLLIElement>('li') ?? []).map(
    (item) =>
      item
        .querySelector<HTMLButtonElement>('button')
        ?.textContent?.replace(/^●\s*/u, '')
        .trim() ?? '',
  );
  const add = modelListInput(container).parentElement?.querySelector('button');
  if (add) labels.push(add.textContent?.trim() ?? '');
  return labels;
}

function selectedModelLabel(container: HTMLElement): string {
  const label = modelListInput(container).closest('label');
  const selected = Array.from(
    label?.querySelectorAll<HTMLButtonElement>('li > button:first-child') ?? [],
  ).find((button) => button.textContent?.trim().startsWith('●'));
  expect(selected).toBeInstanceOf(HTMLButtonElement);
  return selected!.textContent!.replace(/^●\s*/u, '').trim();
}

function providerCardForModelPicker(container: HTMLElement): HTMLElement {
  let current = modelListInput(container).parentElement;
  while (current) {
    if (
      current.classList.contains('rounded-lg') &&
      current.classList.contains('bg-bg-alt')
    ) {
      return current;
    }
    current = current.parentElement;
  }
  throw new Error('Provider card not found');
}

function channelSelectTrigger(container: HTMLElement): HTMLButtonElement {
  const label = Array.from(container.querySelectorAll<HTMLLabelElement>('label')).find(
    (item) =>
      Array.from(item.querySelectorAll('span')).some(
        (span) => span.textContent?.trim() === '渠道',
      ),
  );
  expect(label).toBeInstanceOf(HTMLLabelElement);
  const button = label?.querySelector<HTMLButtonElement>(
    'div.relative > button[type="button"]',
  );
  expect(button).toBeInstanceOf(HTMLButtonElement);
  return button!;
}

afterEach(() => {
  window.localStorage.clear();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  tauriMocks.isTauri.mockReturnValue(true);
});

describe('SettingsModal programming model selection', () => {
  it.each([false, true])(
    'autosaves default thinking depth across reopening settings (provider: %s)',
    async (withProvider) => {
      const provider: Provider = {
        id: 'provider-thinking',
        kind: 'codex',
        name: 'Codex 测试渠道',
        apiKey: '',
        baseUrl: '',
        transport: 'cli',
        model: 'gpt-6',
      };
      if (withProvider) {
        window.localStorage.setItem(PROVIDERS_STORAGE, JSON.stringify([provider]));
      }
      setActiveGatewaySelection({
        adapter: 'codex',
        modelClass: 'gpt-6',
        ...(withProvider
          ? { providerId: provider.id, channelId: 'default' }
          : { systemDefault: true }),
      });

      const thinkingTrigger = (container: HTMLElement) => {
        const label = Array.from(container.querySelectorAll('label')).find(
          (item) => Array.from(item.querySelectorAll('span')).some(
            (span) => span.textContent?.trim() === '思考深度',
          ),
        );
        const button = label?.querySelector<HTMLButtonElement>('button');
        expect(button).toBeInstanceOf(HTMLButtonElement);
        return button!;
      };

      for (const level of [
        { label: '极高', id: 'xhigh' },
        { label: '高', id: 'high' },
        { label: '默认', id: undefined },
      ]) {
        const view = await renderSettingsModal();
        try {
          await clickButtonByText(view.container, '编程渠道');
          await act(async () => thinkingTrigger(view.container).click());
          const option = Array.from(
            document.querySelectorAll<HTMLButtonElement>('button[role="option"]'),
          ).find((button) => {
            const label = button.querySelectorAll('span')[1]?.textContent ?? '';
            return level.id ? label === level.label : label.startsWith('默认');
          });
          expect(option).toBeInstanceOf(HTMLButtonElement);
          await act(async () => option!.click());
          expect(getActiveGatewaySelection().thinkingLevel).toBe(level.id);
        } finally {
          await view.cleanup();
        }

        const reopened = await renderSettingsModal();
        try {
          await clickButtonByText(reopened.container, '编程渠道');
          expect(thinkingTrigger(reopened.container).textContent).toContain(level.label);
          expect(getActiveGatewaySelection().thinkingLevel).toBe(level.id);
        } finally {
          await reopened.cleanup();
        }
      }
    },
  );

  it('keeps the modal open when the backdrop is clicked', async () => {
    const view = await renderSettingsModal();

    try {
      const backdrop = view.container.firstElementChild as HTMLDivElement;
      await act(async () => {
        backdrop.click();
      });

      expect(view.onClose).not.toHaveBeenCalled();

      const dialog = view.container.querySelector<HTMLElement>(
        '[aria-labelledby="settings-title"]',
      );
      const closeButton = dialog?.querySelector<HTMLButtonElement>(
        'button[aria-label="关闭"]',
      );
      expect(closeButton).toBeInstanceOf(HTMLButtonElement);

      await act(async () => {
        closeButton?.click();
      });

      expect(view.onClose).toHaveBeenCalledTimes(1);
    } finally {
      await view.cleanup();
    }
  });

  it('renders the general settings tab without requiring a global save action', async () => {
    const view = await renderSettingsModal();

    try {
      expect(view.container.textContent).toContain('通用设置');
      expect(view.container.textContent).toContain('界面语言');
      expect(view.container.textContent).toContain('提示词自动翻译');
      expect(view.container.textContent).not.toContain('配置已同步');
    } finally {
      await view.cleanup();
    }
  });

  it('adds and deletes manual default-channel models without duplicates', async () => {
    const provider: Provider = {
      id: 'provider-glm5',
      kind: 'anthropic',
      name: 'GLM5',
      apiKey: 'sk-test',
      baseUrl: 'https://node-hk.sssaicode.com',
      model: 'glm-5',
    };
    window.localStorage.setItem(PROVIDERS_STORAGE, JSON.stringify([provider]));
    window.localStorage.setItem(
      ACTIVE_PROVIDER_BY_KIND_STORAGE,
      JSON.stringify({ anthropic: provider.id }),
    );

    const view = await renderSettingsModal();

    try {
      await clickButtonByText(view.container, '编程渠道');

      expect(providerCardForModelPicker(view.container).className).not.toContain(
        'overflow-hidden',
      );
      expect(optionLabels(view.container)).toEqual(['glm-5', '选中/添加']);

      await addModel(view.container, 'glm-5.2');

      expect(selectedModelLabel(view.container)).toBe('glm-5.2');
      expect(optionLabels(view.container)).toEqual([
        'glm-5.2',
        'glm-5',
        '选中/添加',
      ]);

      await addModel(view.container, ' GLM-5.2 ');

      const finalLabels = optionLabels(view.container);
      expect(
        finalLabels.filter((label) => label.toLowerCase() === 'glm-5.2'),
      ).toHaveLength(1);
      expect(finalLabels.at(-1)).toBe('选中/添加');

      await addModel(view.container, 'glm-5.3');

      expect(selectedModelLabel(view.container)).toBe('glm-5.3');
      expect(optionLabels(view.container)).toEqual([
        'glm-5.3',
        'glm-5.2',
        'glm-5',
        '选中/添加',
      ]);

      const storedProviders = JSON.parse(
        window.localStorage.getItem(PROVIDERS_STORAGE) ?? '[]',
      ) as Provider[];
      expect(storedProviders[0].models).toEqual([
        'glm-5.3',
        'glm-5.2',
        'glm-5',
      ]);

      await clickDeleteModel(view.container, 'glm-5.2');

      expect(optionLabels(view.container)).toEqual([
        'glm-5.3',
        'glm-5',
        '选中/添加',
      ]);

      await clickDeleteModel(view.container, 'glm-5.3');

      expect(selectedModelLabel(view.container)).toBe('glm-5');
      expect(optionLabels(view.container)).toEqual(['glm-5', '选中/添加']);
    } finally {
      await view.cleanup();
    }
  });

  it('filters the model list while typing in the model input', async () => {
    const provider: Provider = {
      id: 'provider-glm5',
      kind: 'anthropic',
      name: 'GLM5',
      apiKey: 'sk-test',
      baseUrl: 'https://node-hk.sssaicode.com',
      model: 'glm-5',
      models: ['glm-5.1', 'glm-5.2', 'glm-5.3'],
    };
    window.localStorage.setItem(PROVIDERS_STORAGE, JSON.stringify([provider]));
    window.localStorage.setItem(
      ACTIVE_PROVIDER_BY_KIND_STORAGE,
      JSON.stringify({ anthropic: provider.id }),
    );

    const view = await renderSettingsModal();

    try {
      await clickButtonByText(view.container, '编程渠道');

      expect(optionLabels(view.container)).toEqual([
        'glm-5',
        'glm-5.1',
        'glm-5.2',
        'glm-5.3',
        '选中/添加',
      ]);

      const input = modelListInput(view.container);
      await setInputValue(input, '5.2');

      expect(optionLabels(view.container)).toEqual(['glm-5.2', '选中/添加']);

      await setInputValue(input, 'glm');

      expect(optionLabels(view.container)).toEqual([
        'glm-5',
        'glm-5.1',
        'glm-5.2',
        'glm-5.3',
        '选中/添加',
      ]);

      await setInputValue(input, '');

      expect(optionLabels(view.container)).toEqual([
        'glm-5',
        'glm-5.1',
        'glm-5.2',
        'glm-5.3',
        '选中/添加',
      ]);
    } finally {
      await view.cleanup();
    }
  });

  it('renames a programming channel by clicking its title', async () => {
    const provider: Provider = {
      id: 'provider-codex',
      kind: 'codex',
      name: 'Codex',
      apiKey: 'token',
      baseUrl: 'https://codex.example/v1',
      transport: 'cli',
      model: 'gpt-5.5',
    };
    window.localStorage.setItem(PROVIDERS_STORAGE, JSON.stringify([provider]));

    const view = await renderSettingsModal();

    try {
      await clickButtonByText(view.container, '编程渠道');

      const nameButton = Array.from(
        view.container.querySelectorAll<HTMLButtonElement>(
          'button[aria-label^="编辑渠道"]',
        ),
      ).find((button) => button.textContent?.trim() === 'Codex');
      expect(nameButton).toBeInstanceOf(HTMLButtonElement);

      await act(async () => {
        nameButton?.click();
      });

      const input = view.container.querySelector<HTMLInputElement>(
        'input[aria-label="渠道名称"]',
      );
      expect(input).toBeInstanceOf(HTMLInputElement);

      await setInputValue(input!, 'Codex 备用');
      await act(async () => {
        input!.focus();
        input!.blur();
      });

      const storedProviders = JSON.parse(
        window.localStorage.getItem(PROVIDERS_STORAGE) ?? '[]',
      ) as Provider[];
      expect(storedProviders[0].name).toBe('Codex 备用');
      expect(view.container.textContent).toContain('Codex 备用');
    } finally {
      await view.cleanup();
    }
  });

  it('persists an in-place API key edit when the modal unmounts without blurring the field', async () => {
    const provider: Provider = {
      id: 'provider-k1',
      kind: 'anthropic',
      name: 'Claude A',
      apiKey: 'sk-old',
      baseUrl: 'https://api.example.com/v1',
      model: 'claude-sonnet-4-5',
    };
    window.localStorage.setItem(PROVIDERS_STORAGE, JSON.stringify([provider]));
    window.localStorage.setItem(
      ACTIVE_PROVIDER_BY_KIND_STORAGE,
      JSON.stringify({ anthropic: provider.id }),
    );

    const view = await renderSettingsModal();

    try {
      await clickButtonByText(view.container, '编程渠道');

      // 卡片上的 API Key 输入框（密码框）。输入后刻意不失焦，直接卸载设置
      // —— 等价于按 Esc 关闭 / 切换 tab / 托盘退出前组件被销毁的场景。
      const keyInput = view.container.querySelector<HTMLInputElement>(
        'input[type="password"]',
      );
      expect(keyInput).toBeInstanceOf(HTMLInputElement);
      await setInputValue(keyInput!, 'sk-new-value');
    } finally {
      await view.cleanup();
    }

    const storedProviders = JSON.parse(
      window.localStorage.getItem(PROVIDERS_STORAGE) ?? '[]',
    ) as Provider[];
    expect(storedProviders.find((p) => p.id === provider.id)?.apiKey).toBe(
      'sk-new-value',
    );
  });

  it('persists a DeepSeek Harness API key immediately on input', async () => {
    const provider: Provider = {
      id: 'provider-deepseek-immediate',
      kind: 'deepseek-harness',
      name: 'MyDeepSeekHarness',
      apiKey: '',
      baseUrl: 'https://api.deepseek.com',
      transport: 'cli',
      model: 'deepseek-v4-pro',
    };
    window.localStorage.setItem(PROVIDERS_STORAGE, JSON.stringify([provider]));
    window.localStorage.setItem(
      ACTIVE_PROVIDER_BY_KIND_STORAGE,
      JSON.stringify({ 'deepseek-harness': provider.id }),
    );

    const view = await renderSettingsModal();

    try {
      await clickButtonByText(view.container, '编程渠道');
      const keyInput = view.container.querySelector<HTMLInputElement>(
        'input[type="password"]',
      );
      expect(keyInput).toBeInstanceOf(HTMLInputElement);

      await setInputValue(keyInput!, 'sk-deepseek-immediate');

      const storedProviders = JSON.parse(
        window.localStorage.getItem(PROVIDERS_STORAGE) ?? '[]',
      ) as Provider[];
      expect(storedProviders.find((p) => p.id === provider.id)?.apiKey).toBe(
        'sk-deepseek-immediate',
      );
    } finally {
      await view.cleanup();
    }
  });

  it('keeps an immediate API key edit durable before the tray quit flush', async () => {
    const provider: Provider = {
      id: 'provider-tray-quit',
      kind: 'zcode',
      name: 'ZCode/GLM',
      apiKey: 'sk-old',
      baseUrl: 'https://ai-gateway.example.com',
      model: 'glm-5.3',
    };
    window.localStorage.setItem(PROVIDERS_STORAGE, JSON.stringify([provider]));
    window.localStorage.setItem(
      ACTIVE_PROVIDER_BY_KIND_STORAGE,
      JSON.stringify({ zcode: provider.id }),
    );

    const view = await renderSettingsModal();

    try {
      await clickButtonByText(view.container, '编程渠道');
      const keyInput = view.container.querySelector<HTMLInputElement>(
        'input[type="password"]',
      );
      expect(keyInput).toBeInstanceOf(HTMLInputElement);
      await setInputValue(keyInput!, 'sk-tray-new');

      const storedProviders = JSON.parse(
        window.localStorage.getItem(PROVIDERS_STORAGE) ?? '[]',
      ) as Provider[];
      expect(storedProviders.find((p) => p.id === provider.id)?.apiKey).toBe(
        'sk-tray-new',
      );
    } finally {
      await view.cleanup();
    }
  });

  it('keeps an immediate API key edit durable on beforeunload', async () => {
    const provider: Provider = {
      id: 'provider-beforeunload',
      kind: 'zcode',
      name: 'ZCode/GLM',
      apiKey: 'sk-old',
      baseUrl: 'https://ai-gateway.example.com',
      model: 'glm-5.3',
    };
    window.localStorage.setItem(PROVIDERS_STORAGE, JSON.stringify([provider]));
    window.localStorage.setItem(
      ACTIVE_PROVIDER_BY_KIND_STORAGE,
      JSON.stringify({ zcode: provider.id }),
    );

    await installQuitFlushHandler();
    const view = await renderSettingsModal();

    try {
      await clickButtonByText(view.container, '编程渠道');
      const keyInput = view.container.querySelector<HTMLInputElement>(
        'input[type="password"]',
      );
      expect(keyInput).toBeInstanceOf(HTMLInputElement);
      await setInputValue(keyInput!, 'sk-beforeunload-new');

      window.dispatchEvent(new Event('beforeunload'));

      const storedProviders = JSON.parse(
        window.localStorage.getItem(PROVIDERS_STORAGE) ?? '[]',
      ) as Provider[];
      expect(storedProviders.find((p) => p.id === provider.id)?.apiKey).toBe(
        'sk-beforeunload-new',
      );
    } finally {
      await view.cleanup();
    }
  });

  it('keeps an immediate API key edit durable when the tray quit event fires', async () => {
    const provider: Provider = {
      id: 'provider-tray-event',
      kind: 'zcode',
      name: 'ZCode/GLM',
      apiKey: 'sk-old',
      baseUrl: 'https://ai-gateway.example.com',
      model: 'glm-5.3',
    };
    window.localStorage.setItem(PROVIDERS_STORAGE, JSON.stringify([provider]));
    window.localStorage.setItem(
      ACTIVE_PROVIDER_BY_KIND_STORAGE,
      JSON.stringify({ zcode: provider.id }),
    );

    await installQuitFlushHandler();
    const view = await renderSettingsModal();

    try {
      await clickButtonByText(view.container, '编程渠道');
      const keyInput = view.container.querySelector<HTMLInputElement>(
        'input[type="password"]',
      );
      expect(keyInput).toBeInstanceOf(HTMLInputElement);
      await setInputValue(keyInput!, 'sk-tray-event-new');

      const listener = tauriEventMocks.listen.mock.calls.find(
        ([event]) => event === 'ugs:before-quit',
      )?.[1] as (() => void) | undefined;
      expect(listener).toBeTypeOf('function');
      listener?.();

      const storedProviders = JSON.parse(
        window.localStorage.getItem(PROVIDERS_STORAGE) ?? '[]',
      ) as Provider[];
      expect(storedProviders.find((p) => p.id === provider.id)?.apiKey).toBe(
        'sk-tray-event-new',
      );
    } finally {
      await view.cleanup();
    }
  });

  it('switches the Settings default channel while a workflow is running without rebinding the active session', async () => {
    const providers: Provider[] = [
      {
        id: 'provider-packy',
        kind: 'anthropic',
        name: 'PackyCode',
        apiKey: 'sk-packy',
        baseUrl: 'https://packy.example/v1',
        transport: 'cli',
        model: 'packy-code',
      },
      {
        id: 'provider-sss',
        kind: 'anthropic',
        name: 'SSSAiCode',
        apiKey: 'sk-sss',
        baseUrl: 'https://sss.example/v1',
        transport: 'cli',
        model: 'claude-opus-4-8',
      },
    ];
    window.localStorage.setItem(PROVIDERS_STORAGE, JSON.stringify(providers));
    window.localStorage.setItem(
      ACTIVE_PROVIDER_BY_KIND_STORAGE,
      JSON.stringify({ anthropic: 'provider-packy' }),
    );

    const view = await renderSettingsModal();

    try {
      useStore.setState({ mode: 'running' });
      await clickButtonByText(view.container, '编程渠道');

      await act(async () => {
        findButtonContaining(view.container, 'PackyCode').click();
      });
      await act(async () => {
        findButtonContaining(view.container, 'SSSAiCode').click();
      });

      expect(findButtonContaining(view.container, 'SSSAiCode')).toBeTruthy();
      expect(
        JSON.parse(window.localStorage.getItem(ACTIVE_GATEWAY_SELECTION_STORAGE)!),
      ).toEqual({
        adapter: 'claude-code',
        modelClass: 'claude-opus-4-8',
        providerId: 'provider-sss',
        channelId: 'default',
      });
      expect(workflowDefaultGatewaySelection(useStore.getState().workflow)).toEqual({
        adapter: 'claude-code',
        modelClass: 'sonnet',
      });
    } finally {
      await view.cleanup();
    }
  });

  it('moves the closed channel selector display to the newly picked default while running', async () => {
    const providers: Provider[] = [
      {
        id: 'provider-packy',
        kind: 'anthropic',
        name: 'PackyCode',
        apiKey: 'sk-packy',
        baseUrl: 'https://packy.example/v1',
        transport: 'cli',
        model: 'packy-code',
      },
      {
        id: 'provider-deepseek',
        kind: 'anthropic',
        name: 'DeepSeek',
        apiKey: 'sk-deepseek',
        baseUrl: 'https://deepseek.example/v1',
        transport: 'cli',
        model: 'deepseek-v4-pro',
      },
    ];
    window.localStorage.setItem(PROVIDERS_STORAGE, JSON.stringify(providers));
    window.localStorage.setItem(
      ACTIVE_PROVIDER_BY_KIND_STORAGE,
      JSON.stringify({ anthropic: 'provider-packy' }),
    );

    const view = await renderSettingsModal();

    try {
      useStore.setState({ mode: 'running' });
      await clickButtonByText(view.container, '编程渠道');

      // The closed channel selector is the trigger that opens the listbox.
      const trigger = () =>
        view.container.querySelector<HTMLButtonElement>(
          'div.relative > button[type="button"]',
        )!;

      // Open, then pick DeepSeek.
      await act(async () => {
        trigger().click();
      });
      await act(async () => {
        const option = Array.from(
          view.container.querySelectorAll<HTMLButtonElement>(
            'button[role="option"]',
          ),
        ).find((item) => item.textContent?.includes('DeepSeek'));
        expect(option).toBeInstanceOf(HTMLButtonElement);
        option!.click();
      });

      // Listbox closed, and the trigger now shows DeepSeek (selection moved).
      expect(
        view.container.querySelector('button[role="option"]'),
      ).toBeNull();
      expect(trigger().textContent).toContain('DeepSeek');
      expect(trigger().textContent).not.toContain('PackyCode');
    } finally {
      await view.cleanup();
    }
  });

  it('hides remote runner providers and dedupes identical local providers in the default selector', async () => {
    const providers: Provider[] = [
      {
        id: 'provider-deepseek-direct',
        kind: 'anthropic',
        name: 'DeepSeek',
        apiKey: 'sk-old',
        baseUrl: 'https://deepseek.example/v1/',
        model: 'deepseek-v4-pro',
      },
      {
        id: 'provider-deepseek-cli',
        kind: 'anthropic',
        name: 'DeepSeek',
        apiKey: 'sk-new',
        baseUrl: 'https://deepseek.example/v1',
        transport: 'cli',
        model: 'deepseek-v4-pro',
      },
      {
        id: remoteProviderId('rw_remote', 'deepseek'),
        kind: 'anthropic',
        name: '本地服务器测试1 · DeepSeek',
        apiKey: 'remote-runner',
        baseUrl: 'https://runner.example',
        transport: 'cli',
        model: 'deepseek-v4-pro',
      },
    ];
    window.localStorage.setItem(PROVIDERS_STORAGE, JSON.stringify(providers));

    const view = await renderSettingsModal();

    try {
      await clickButtonByText(view.container, '编程渠道');

      expect(view.container.textContent).not.toContain('本地服务器测试1 · DeepSeek');

      await act(async () => {
        channelSelectTrigger(view.container).click();
      });

      const optionTexts = Array.from(
        view.container.querySelectorAll<HTMLButtonElement>('button[role="option"]'),
      ).map((button) => button.textContent ?? '');
      expect(
        optionTexts.filter(
          (text) =>
            text.includes('DeepSeek') &&
            text.includes('Claude Code · 默认渠道'),
        ),
      ).toHaveLength(1);
      expect(optionTexts.some((text) => text.includes('本地服务器测试1'))).toBe(
        false,
      );
    } finally {
      await view.cleanup();
    }
  });

  it('filters the channel list as the search box is typed and restores it when cleared', async () => {
    const providers: Provider[] = [
      {
        id: 'provider-claude-a',
        kind: 'anthropic',
        name: 'Claude A',
        apiKey: 'sk-a',
        baseUrl: 'https://claude-a.example/v1',
        model: 'claude-sonnet',
      },
      {
        id: 'provider-codex-a',
        kind: 'codex',
        name: 'Codex A',
        apiKey: 'token',
        baseUrl: 'https://codex-a.example/v1',
        model: 'gpt-5',
      },
    ];
    window.localStorage.setItem(PROVIDERS_STORAGE, JSON.stringify(providers));

    const view = await renderSettingsModal();

    try {
      await clickButtonByText(view.container, '编程渠道');

      const channelCard = (name: string) =>
        view.container.querySelector<HTMLButtonElement>(
          `button[aria-label="编辑渠道: ${name}"]`,
        );
      expect(channelCard('Claude A')).toBeInstanceOf(HTMLButtonElement);
      expect(channelCard('Codex A')).toBeInstanceOf(HTMLButtonElement);

      const search = view.container.querySelector<HTMLInputElement>(
        'input[aria-label="搜索渠道名称、类型、URL、模型…"]',
      );
      expect(search).toBeInstanceOf(HTMLInputElement);

      // Typing keeps only matching channels.
      await setInputValue(search!, 'codex');
      expect(channelCard('Codex A')).toBeInstanceOf(HTMLButtonElement);
      expect(channelCard('Claude A')).toBeNull();

      // Matching also works against the base URL / model.
      await setInputValue(search!, 'claude-sonnet');
      expect(channelCard('Claude A')).toBeInstanceOf(HTMLButtonElement);
      expect(channelCard('Codex A')).toBeNull();

      // Clearing the search restores the full list.
      const clear = view.container.querySelector<HTMLButtonElement>(
        'button[aria-label="清除搜索"]',
      );
      expect(clear).toBeInstanceOf(HTMLButtonElement);
      await act(async () => {
        clear?.click();
      });
      expect(channelCard('Claude A')).toBeInstanceOf(HTMLButtonElement);
      expect(channelCard('Codex A')).toBeInstanceOf(HTMLButtonElement);
    } finally {
      await view.cleanup();
    }
  });

  it('shows a no-match state when the search query matches nothing', async () => {
    const providers: Provider[] = [
      {
        id: 'provider-claude-a',
        kind: 'anthropic',
        name: 'Claude A',
        apiKey: 'sk-a',
        baseUrl: 'https://claude-a.example/v1',
        model: 'claude-sonnet',
      },
    ];
    window.localStorage.setItem(PROVIDERS_STORAGE, JSON.stringify(providers));

    const view = await renderSettingsModal();

    try {
      await clickButtonByText(view.container, '编程渠道');

      const search = view.container.querySelector<HTMLInputElement>(
        'input[aria-label="搜索渠道名称、类型、URL、模型…"]',
      );
      await setInputValue(search!, 'zzz-no-match');

      expect(view.container.textContent).toContain('没有匹配的渠道');
      expect(
        view.container.querySelector('button[aria-label="编辑渠道: Claude A"]'),
      ).toBeNull();
    } finally {
      await view.cleanup();
    }
  });
});
