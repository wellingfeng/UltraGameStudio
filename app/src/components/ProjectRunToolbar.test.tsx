import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { resolveCliGatewayRoute, resolveDirectGatewayRoute, completeGatewayText } from '@/lib/modelGateway/modelGateway';
import { useStore } from '@/store/useStore';
import ProjectRunToolbar from './ProjectRunToolbar';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@/lib/tauri', () => ({ tauriAvailable: () => true }));
vi.mock('@/store/useStore', () => ({ useStore: Object.assign(vi.fn(), { getState: vi.fn() }) }));
vi.mock('@/lib/modelGateway/resolver', () => ({ workflowDefaultGatewaySelection: () => ({ adapter: 'codex', modelClass: 'default' }) }));
vi.mock('@/lib/modelGateway/modelGateway', () => ({
  completeGatewayText: vi.fn(),
  resolveCliGatewayRoute: vi.fn(),
  resolveDirectGatewayRoute: vi.fn(),
}));

const workspace = 'E:/Game';
const idleStatus = { build: false, cancelBuild: false, notice: '', error: '' };
const projectInfo = { engine: 'unreal', installed: true, debugger: true, attach: true };
const pausedStatus = {
  ...idleStatus,
  debugger: { phase: 'paused', frames: [], variables: [] },
};

describe('项目运行与调试快捷键', () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    vi.mocked(useStore.getState).mockReturnValue({ composer: { model: 'default' } } as ReturnType<typeof useStore.getState>);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.resetAllMocks();
  });

  async function render(path = workspace, project = projectInfo, status = idleStatus) {
    vi.mocked(useStore).mockReturnValue(path);
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === 'project_run_info') return project;
      if (command === 'project_run_save_profile') return { ...project, profile: (args as { profile: string }).profile };
      return status;
    });
    await act(async () => root.render(<ProjectRunToolbar />));
  }

  async function pressF5(options: KeyboardEventInit = {}) {
    const event = new KeyboardEvent('keydown', { key: 'F5', bubbles: true, cancelable: true, ...options });
    await act(async () => host.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
  }

  function actions() {
    return vi.mocked(invoke).mock.calls.filter(([command]) => command === 'project_run_action').map(([, args]) => args);
  }

  it('默认从 F5 启动编辑器 C++ 调试，跳过长按与刷新组合键', async () => {
    await render();
    await pressF5({ repeat: true });
    await pressF5({ ctrlKey: true });
    await pressF5({ shiftKey: true });
    await pressF5();
    expect(actions()).toEqual([{ workspace, action: 'debugEditor' }]);
  });

  it('使用选中的调试配置，暂停时继续', async () => {
    await render();
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="运行配置"]')!.click());
    const select = host.querySelector('select')!;
    await act(async () => {
      select.value = 'debugGame';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    vi.mocked(invoke).mockResolvedValue(pausedStatus);
    await pressF5();
    await pressF5();
    expect(actions()).toEqual([{ workspace, action: 'debugGame' }, { workspace, action: 'continue' }]);
  });

  it('配置面板保留编译、PIE 和附加入口，移除说明、断点和日志', async () => {
    await render(workspace, { ...projectInfo, attach: false });
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="运行配置"]')!.click());
    const panel = host.querySelector('section[aria-label="运行配置"]')!;
    expect(Array.from(panel.querySelectorAll('button')).map((button) => button.textContent?.trim()))
      .toEqual(['编译', '开始 PIE', '附加调试']);
    expect(panel.querySelector('details, pre')).toBeNull();
    expect(panel.textContent).not.toMatch(/LLVM|断点|运行日志/);
  });

  it('编辑器退出失败时提供自动配置入口', async () => {
    await render(workspace, projectInfo, { ...idleStatus, error: '编辑器退出，退出码 3' });
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="运行配置"]')!.click());
    const panel = host.querySelector('section[aria-label="运行配置"]')!;
    expect(panel.textContent).toContain('编辑器退出，退出码 3');
    expect(panel.textContent).not.toContain('就绪');
    expect(panel.textContent).toContain('自动配置');
  });

  it('未配置编程 AI 时提示用户，避免提交配置', async () => {
    vi.mocked(resolveCliGatewayRoute).mockRejectedValue(new Error('missing'));
    await render(workspace, { ...projectInfo, debugger: false, attach: false });
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="运行配置"]')!.click());
    const button = Array.from(host.querySelectorAll('button')).find((item) => item.textContent === '自动配置')!;
    await act(async () => button.click());
    expect(host.textContent).toContain('请先在设置中配置可用的编程 AI');
    expect(vi.mocked(invoke).mock.calls.some(([name]) => name === 'project_run_apply_setup')).toBe(false);
  });

  it('Unity 编辑器已安装时先验证 C# 调试连接', async () => {
    const unity = { ...projectInfo, engine: 'unity', editor: 'C:/Unity/Unity.exe' };
    await render(workspace, unity);
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="运行配置"]')!.click());
    const panel = host.querySelector('section[aria-label="运行配置"]')!;
    expect(panel.textContent).toContain('按 F5 验证 Unity C# 调试连接。');
    expect(panel.textContent).toContain('自动配置');
    expect(panel.textContent).not.toContain('就绪');
    await pressF5();
    expect(actions()).toEqual([{ workspace, action: 'debugEditor' }]);
  });

  it('调用默认编程模型，按当前项目提交并刷新调试配置', async () => {
    const editor = 'C:/Godot/Godot.exe';
    const godot = { ...projectInfo, engine: 'godot', debugger: false, attach: false, installed: false };
    const ready = { ...godot, debugger: true, installed: true, profile: 'debugGame' };
    const setup = { engine: 'godot', project: 'project.godot', profiles: ['debugGame'], editors: [editor], adapters: [] };
    const selection = { profile: 'debugGame', editor, adapter: null };
    const route = { adapter: 'codex', model: 'configured-default', transport: 'cli', cliCommand: 'codex' } as Awaited<ReturnType<typeof resolveCliGatewayRoute>>;
    vi.mocked(resolveDirectGatewayRoute).mockReturnValue(null);
    vi.mocked(resolveCliGatewayRoute).mockResolvedValue(route);
    vi.mocked(completeGatewayText).mockResolvedValue(JSON.stringify(selection));
    await render(workspace, godot);
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="运行配置"]')!.click());
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'project_run_setup') return setup;
      if (command === 'project_run_apply_setup') return ready;
      return idleStatus;
    });
    const button = Array.from(host.querySelectorAll('button')).find((item) => item.textContent === '自动配置')!;
    await act(async () => button.click());
    expect(completeGatewayText).toHaveBeenCalledWith(expect.objectContaining({ route, cwd: workspace }));
    expect(invoke).toHaveBeenCalledWith('project_run_apply_setup', { workspace, selection });
    expect(host.textContent).toContain('就绪');
    expect(host.textContent).not.toContain('自动配置');
    await pressF5();
    expect(actions()).toEqual([{ workspace, action: 'debugGame' }]);
  });

  it.each([
    { path: '', project: projectInfo, status: idleStatus },
    { path: 'https://example.test/project', project: projectInfo, status: idleStatus },
    { path: workspace, project: { ...projectInfo, engine: 'unknown' }, status: idleStatus },
    { path: workspace, project: { ...projectInfo, debugger: false, attach: false }, status: idleStatus },
    { path: workspace, project: projectInfo, status: { ...idleStatus, build: true } },
  ])('无可用调试动作时仍拦截 F5（%#）', async ({ path, project, status }) => {
    await render(path, project, status);
    await pressF5();
    expect(actions()).toEqual([]);
  });
});
