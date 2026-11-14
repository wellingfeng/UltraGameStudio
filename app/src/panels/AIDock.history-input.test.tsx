import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { simpleBlueprint } from '@/core/defaultBlueprint';
import { defaultComposer, samplePromptGroups } from '@/store/sampleSessions';
import { useStore } from '@/store/useStore';
import AIDock from './AIDock';

const revise = useStore.getState().reviseChatMessage;
afterEach(() => useStore.setState({ messages: [], queuedChatMessageIds: [], reviseChatMessage: revise }));

async function view() {
  useStore.setState({
    mode: 'design', workflow: simpleBlueprint('输入悬浮与修订'), selectedNodeId: null,
    composer: defaultComposer, composerDraft: '', composerDrafts: {}, locale: 'zh-CN',
    promptGroups: samplePromptGroups, queuedChatMessageIds: [], activeWorkspaceId: null,
    activeSessionId: 'sticky-test', workspaceHistory: [], aiStreaming: false,
    aiEditingSessions: [], chattingSessions: [], blockedSendTip: null,
    messages: [
      { id: 'u1', role: 'user', text: '第一轮输入 `E:/photo.png`', createdAt: 1 },
      { id: 'a1', role: 'assistant', text: '第一轮回答', createdAt: 2 },
      { id: 'u2', role: 'user', text: '第二轮输入 `E:/photo.png`', createdAt: 3 },
      { id: 'a2', role: 'assistant', text: '第二轮回答', createdAt: 4 },
    ],
  });
  const container = document.createElement('div'); document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<AIDock layout="chat" />));
  const stream = container.querySelector<HTMLElement>('.ugs-ai-return-stream')!;
  Object.defineProperties(stream, { scrollHeight: { value: 1600, configurable: true }, clientHeight: { value: 400, configurable: true } });
  stream.getBoundingClientRect = () => ({ top: 100, bottom: 500, height: 400, width: 600, left: 0, right: 600, x: 0, y: 100, toJSON() {} });
  for (const [index, row] of [...container.querySelectorAll<HTMLElement>('[data-ugs-message-row]')].entries()) {
    row.getBoundingClientRect = () => ({ top: 110 + index * 200 - stream.scrollTop, bottom: 250 + index * 200 - stream.scrollTop,
      height: 140, width: 600, left: 0, right: 600, x: 0, y: 0, toJSON() {} });
  }
  const scroll = async (top: number) => act(async () => { stream.scrollTop = top; stream.dispatchEvent(new Event('scroll')); });
  const cleanup = async () => { await act(async () => root.unmount()); container.remove(); };
  return { container, scroll, cleanup };
}

it('does not require the user to open a tool catalogue from the chat composer', async () => {
  const v = await view();
  try {
    expect(v.container.querySelector('[aria-label="查看当前会话工具目录"]')).toBeNull();
    expect(v.container.querySelector('[aria-label="工具目录"]')).toBeNull();
  } finally { await v.cleanup(); }
});

it('hides superseded inputs in the stream, sticky prompt and topic navigation after reload', async () => {
  const v = await view();
  try {
    await act(async () => useStore.setState((state) => ({ messages: JSON.parse(JSON.stringify([
      ...state.messages, { id: 'u1-edited', role: 'user', text: '第一轮修订 `E:/photo.png`', createdAt: 5, replacesMessageId: 'u1' },
    ])) })));
    expect(v.container.textContent).not.toContain('第一轮输入 `E:/photo.png`');
    expect(v.container.textContent).toContain('第一轮修订');
    expect(v.container.textContent).toContain('第一轮回答');
    expect(v.container.querySelectorAll('[data-ugs-message-row]')).toHaveLength(4);
    await v.scroll(250);
    expect(v.container.querySelector('[data-ugs-sticky-prompt]')?.getAttribute('data-ugs-sticky-prompt')).toBe('u1-edited');
  } finally { await v.cleanup(); }
});

it('shares the history editor with the pinned input, preserves file refs and cancels without sending', async () => {
  const v = await view();
  const send = vi.fn(() => true);
  useStore.setState({ reviseChatMessage: send });
  try {
    await v.scroll(250);
    await act(async () => v.container.querySelector<HTMLButtonElement>('[data-ugs-sticky-prompt] [aria-label="编辑当前输入"]')!.click());
    expect(v.container.querySelector<HTMLTextAreaElement>('[aria-label="编辑用户输入"]')?.value).toContain('`E:/photo.png`');
    expect(v.container.querySelectorAll('[aria-label="编辑用户输入"]')).toHaveLength(1);
    await act(async () => v.container.querySelector<HTMLButtonElement>('button[aria-label="取消"]')!.click());
    expect(v.container.querySelector('[aria-label="编辑用户输入"]')).toBeNull();
    expect(send).not.toHaveBeenCalled();
    await v.scroll(0);
    await act(async () => v.container.querySelector<HTMLButtonElement>('[data-ugs-message-row] [aria-label="编辑历史输入"]')!.click());
    const editor = v.container.querySelector<HTMLTextAreaElement>('[aria-label="编辑用户输入"]')!;
    await act(async () => editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })));
    expect(send).toHaveBeenCalledWith('u2', '第二轮输入 `E:/photo.png`');
  } finally { await v.cleanup(); }
});

it('clears the pinned prompt and editor when switching sessions', async () => {
  const v = await view();
  try {
    await v.scroll(500);
    await act(async () => v.container.querySelector<HTMLButtonElement>('[data-ugs-sticky-prompt] [aria-label="编辑当前输入"]')!.click());
    await act(async () => useStore.setState({ activeSessionId: 'other-session', messages: [] }));
    expect(v.container.querySelector('[data-ugs-sticky-prompt]')).toBeNull();
    expect(v.container.querySelector('[aria-label="编辑用户输入"]')).toBeNull();
  } finally { await v.cleanup(); }
});

it('opens the editor from pinned prompt text without scrolling and resends the changed input', async () => {
  const v = await view();
  const send = vi.fn(() => true);
  useStore.setState({ reviseChatMessage: send });
  try {
    await v.scroll(250);
    const stream = v.container.querySelector<HTMLElement>('.ugs-ai-return-stream')!;
    const before = stream.scrollTop;
    const pinned = v.container.querySelector<HTMLElement>('[data-ugs-sticky-prompt]')!;
    expect(pinned.textContent).not.toContain('当前输入');
    expect(pinned.querySelectorAll('button')).toHaveLength(1);
    expect(pinned.querySelector('[aria-label="定位原始输入"]')).toBeNull();
    expect(pinned.querySelector('[aria-label="编辑历史输入"]')).toBeNull();
    await act(async () => v.container.querySelector<HTMLButtonElement>('[data-ugs-sticky-prompt] [aria-label="编辑当前输入"]')!.click());
    expect(stream.scrollTop).toBe(before);
    expect(pinned.querySelector('[aria-label="编辑当前输入"]')).toBeNull();
    const editor = v.container.querySelector<HTMLTextAreaElement>('[aria-label="编辑用户输入"]')!;
    expect(editor.value).toBe('第二轮输入 `E:/photo.png`');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(editor, '修订输入 `E:/photo.png`');
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => v.container.querySelector<HTMLButtonElement>('button[aria-label="保存并重新发送"]')!.click());
    expect(send).toHaveBeenCalledExactlyOnceWith('u2', '修订输入 `E:/photo.png`');
    expect(v.container.querySelector('[aria-label="编辑用户输入"]')).toBeNull();
  } finally { await v.cleanup(); }
});

it('always pins the latest user input regardless of scroll and prevents older edits', async () => {
  const v = await view();
  try {
    for (const top of [0, 250, 500, 250, 0]) {
      await v.scroll(top);
      expect(v.container.querySelector('[data-ugs-sticky-prompt]')?.getAttribute('data-ugs-sticky-prompt')).toBe('u2');
    }
    const rows = [...v.container.querySelectorAll<HTMLElement>('[data-ugs-message-row]')];
    expect(rows[0].querySelector('[aria-label="编辑历史输入"]')).toBeNull();
    expect(rows[2].querySelector('[aria-label="编辑历史输入"]')).not.toBeNull();
  } finally { await v.cleanup(); }
});

it('pins a newer queued input and edits that queue entry', async () => {
  const v = await view();
  const update = vi.fn(() => true);
  const original = useStore.getState().updateQueuedChatMessage;
  try {
    await act(async () => useStore.setState((state) => ({
      messages: [...state.messages, { id: 'u3', role: 'user', text: '排队的新输入', createdAt: 5 }],
      queuedChatMessageIds: ['u3'], updateQueuedChatMessage: update,
    })));
    expect(v.container.querySelector('[data-ugs-sticky-prompt]')?.getAttribute('data-ugs-sticky-prompt')).toBe('u3');
    await act(async () => v.container.querySelector<HTMLButtonElement>('[data-ugs-sticky-prompt] [aria-label="编辑当前输入"]')!.click());
    expect(v.container.querySelector<HTMLTextAreaElement>('[aria-label="编辑用户输入"]')?.value).toBe('排队的新输入');
    await act(async () => v.container.querySelector<HTMLButtonElement>('button[aria-label="保存"]')!.click());
    expect(update).toHaveBeenCalledExactlyOnceWith('u3', '排队的新输入');
  } finally { await act(async () => useStore.setState({ updateQueuedChatMessage: original })); await v.cleanup(); }
});

it('closes a stale editor as soon as a newer input arrives', async () => {
  const v = await view();
  const send = vi.fn(() => true);
  await act(async () => useStore.setState({ reviseChatMessage: send }));
  try {
    await act(async () => v.container.querySelector<HTMLButtonElement>('[data-ugs-sticky-prompt] [aria-label="编辑当前输入"]')!.click());
    expect(v.container.querySelector('[aria-label="编辑用户输入"]')).not.toBeNull();
    await act(async () => useStore.setState((state) => ({ messages: [
      ...state.messages, { id: 'u3', role: 'user', text: '后续输入', createdAt: 5 },
    ] })));
    expect(v.container.querySelector('[aria-label="编辑用户输入"]')).toBeNull();
    expect(v.container.querySelector('[data-ugs-sticky-prompt]')?.getAttribute('data-ugs-sticky-prompt')).toBe('u3');
    expect(send).not.toHaveBeenCalled();
    await act(async () => v.container.querySelector<HTMLButtonElement>('[data-ugs-sticky-prompt] [aria-label="编辑当前输入"]')!.click());
    await act(async () => v.container.querySelector<HTMLButtonElement>('button[aria-label="保存并重新发送"]')!.click());
    expect(send).toHaveBeenCalledExactlyOnceWith('u3', '后续输入');
  } finally { await v.cleanup(); }
});

it('uses send time when an interjection is displayed before older turns', async () => {
  const v = await view();
  try {
    await act(async () => useStore.setState((state) => ({ messages: [
      ...state.messages, { id: 'u3', role: 'user', text: '最后插话', createdAt: 5, interjected: true, interjectedReplyId: 'a1' },
    ] })));
    const rows = [...v.container.querySelectorAll<HTMLElement>('[data-ugs-message-row]')];
    expect(rows.findIndex((row) => row.textContent?.includes('最后插话'))).toBeLessThan(rows.findIndex((row) => row.textContent?.includes('第二轮输入')));
    expect(v.container.querySelector('[data-ugs-sticky-prompt]')?.getAttribute('data-ugs-sticky-prompt')).toBe('u3');
  } finally { await v.cleanup(); }
});

it('does not expose an editor on older queued inputs', async () => {
  const v = await view();
  try {
    await act(async () => useStore.setState((state) => ({ messages: [
      ...state.messages, { id: 'u3', role: 'user', text: '旧排队输入', createdAt: 5 },
      { id: 'u4', role: 'user', text: '新排队输入', createdAt: 6 },
    ], queuedChatMessageIds: ['u3', 'u4'] })));
    const rows = [...v.container.querySelectorAll<HTMLElement>('[data-ugs-message-row]')];
    const old = rows.find((row) => row.textContent?.includes('旧排队输入'))!;
    const latest = rows.find((row) => row.textContent?.includes('新排队输入'))!;
    expect(old.querySelector('[aria-label="编辑"]')).toBeNull();
    expect(latest.querySelector('[aria-label="编辑"]')).not.toBeNull();
    expect(v.container.querySelector('[data-ugs-sticky-prompt]')?.getAttribute('data-ugs-sticky-prompt')).toBe('u4');
  } finally { await v.cleanup(); }
});

it('shows a later local command without allowing an older message to be edited', async () => {
  const v = await view();
  try {
    await act(async () => useStore.setState((state) => ({ messages: [
      ...state.messages, { id: 'command', role: 'user', text: '/learn 本地指令', createdAt: 5, localOnly: true },
    ] })));
    expect(v.container.querySelector('[data-ugs-sticky-prompt]')?.getAttribute('data-ugs-sticky-prompt')).toBe('command');
    expect(v.container.querySelector<HTMLButtonElement>('[data-ugs-sticky-prompt] [aria-label="编辑当前输入"]')?.disabled).toBe(true);
    expect(v.container.querySelector('[aria-label="编辑历史输入"]')).toBeNull();
  } finally { await v.cleanup(); }
});
