import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MainSurfaceProvider, useMainSurface } from './MainSurface';
import WorkspaceMainSurface from './WorkspaceMainSurface';
import { TitleBarActions, TitleBarContent, TitleBarLayout } from './TitleBar';

vi.mock('@/store/useStore', () => ({ useStore: (selector: (s: { locale: string; assetCenterEnabled: boolean }) => unknown) => selector({ locale: 'zh-CN', assetCenterEnabled: true }) }));
vi.mock('@/panels/DownloadsModal', () => ({ default: ({ onClose }: { onClose: () => void }) => <section data-ugs-artifacts><button onClick={onClose}>返回对话</button></section> }));
vi.mock('@/panels/ScheduledTasksPanel', () => ({ default: ({ onClose }: { onClose: () => void }) => <section data-ugs-scheduled-tasks><button onClick={onClose}>返回对话</button></section> }));
vi.mock('@/lib/tauri', () => ({ tauriAvailable: () => false }));
vi.mock('@/panels/AIDock', () => ({ default: () => <><TitleBarContent enabled><span>原会话标题</span><TitleBarActions /></TitleBarContent><textarea defaultValue="未发送的草稿" /></> }));
vi.mock('@/panels/MessagePlatformsPanel', () => ({ default: ({ onClose }: { onClose: () => void }) => <section data-ugs-message-platforms><button onClick={onClose}>返回对话</button></section> }));

let root: Root;
let container: HTMLDivElement;
afterEach(async () => { if (root) await act(async () => root.unmount()); container?.remove(); });
function Navigation() {
  const { setSurface } = useMainSurface();
  return <><button onClick={() => setSurface('message-platforms')}>消息平台</button><button onClick={() => setSurface('scheduled-tasks')}>定时任务</button><button onClick={() => setSurface('artifacts')}>产出物</button></>;
}
async function render(sessionKey = 'first') {
  if (!container) { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); }
  await act(async () => root.render(<MainSurfaceProvider sessionKey={sessionKey}><TitleBarLayout><Navigation /><main><WorkspaceMainSurface /></main></TitleBarLayout></MainSurfaceProvider>));
}
describe.each(['message-platforms', 'scheduled-tasks', 'artifacts'] as const)('主信息流 %s 导航', (surface) => {
  const navigationLabel = surface === 'message-platforms' ? '消息平台' : surface === 'scheduled-tasks' ? '定时任务' : '产出物';
  const panelSelector = `[data-ugs-${surface}]`;
  it('在主区域切换平台设置，隐藏聊天标题，返回时保留原草稿节点', async () => {
    container = undefined as unknown as HTMLDivElement;
    await render();
    expect(container.querySelector('.ugs-titlebar-global-actions .ugs-agent-usage')).not.toBeNull();
    const draft = container.querySelector('textarea')!;
    draft.value = '继续编辑的草稿';
    await act(async () => Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === navigationLabel)!.click());
    expect(container.querySelector(`main ${panelSelector}`)).not.toBeNull();
    expect(container.querySelector('[data-ugs-chat-surface]')?.hasAttribute('hidden')).toBe(true);
    expect(container.querySelector('.ugs-titlebar-content')?.textContent).not.toContain('原会话标题');
    expect(container.querySelectorAll('.ugs-agent-usage')).toHaveLength(1);
    expect(container.querySelectorAll('.ugs-model-rankings')).toHaveLength(1);
    expect(container.querySelector('.ugs-titlebar > .ugs-agent-usage')).not.toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>(`${panelSelector} button`)!.click());
    expect(container.querySelector('textarea')).toBe(draft);
    expect(draft.value).toBe('继续编辑的草稿');
    expect(container.querySelector('[data-ugs-chat-surface]')?.hasAttribute('hidden')).toBe(false);
    expect(container.querySelector('.ugs-titlebar-content')?.textContent).toContain('原会话标题');
    expect(container.querySelector('.ugs-titlebar-global-actions .ugs-agent-usage')).not.toBeNull();
    expect(container.querySelectorAll('.ugs-agent-usage')).toHaveLength(1);
  });
  it('切换会话时自动回到聊天', async () => {
    container = undefined as unknown as HTMLDivElement;
    await render();
    await act(async () => Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === navigationLabel)!.click());
    await render('second');
    expect(container.querySelector(panelSelector)).toBeNull();
    expect(container.querySelector('[data-ugs-chat-surface]')?.hasAttribute('hidden')).toBe(false);
  });
});
