import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import RemoteWorkspaceDialog from '@/components/RemoteWorkspaceDialog';
import {
  ACTIVE_PROVIDER_BY_KIND_STORAGE,
  PROVIDERS_STORAGE,
  getActiveProvider,
  getActiveProviderId,
  listProviders,
  syncGatewayFromProviders,
} from '@/lib/apiConfig';
import { loadGatewayConfig } from '@/lib/gatewayConfig';
import { saveComposer } from '@/lib/composerStorage';
import {
  REMOTE_WORKSPACE_STORAGE_KEY,
  RunnerClient,
  getRemoteWorkspace,
  loadRemoteWorkspaces,
  saveRemoteWorkspace,
} from '@/lib/remoteWorkspace';
import { historyStore } from '@/store/history/store';
import { useStore } from '@/store/useStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('云端项目退役', () => {
  it('阻断旧配置读取、新建项目及 Runner 请求，保留原始配置', () => {
    const raw = JSON.stringify([{
      id: 'retired', label: '旧云端项目', serverUrl: 'https://runner.example',
      adapter: 'claude', useOwnModelKey: false, createdAt: 1, updatedAt: 1,
    }]);
    window.localStorage.setItem(REMOTE_WORKSPACE_STORAGE_KEY, raw);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(loadRemoteWorkspaces()).toEqual([]);
    expect(getRemoteWorkspace('retired')).toBeNull();
    expect(() => saveRemoteWorkspace({ label: '新项目', serverUrl: 'https://runner.example' }))
      .toThrow('云端项目功能已停止支持');
    expect(() => new RunnerClient('https://runner.example', 'test-token'))
      .toThrow('云端项目功能已停止支持');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(REMOTE_WORKSPACE_STORAGE_KEY)).toBe(raw);
  });

  it('不挂载旧对话框，不执行自动连接', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(<RemoteWorkspaceDialog locale="zh-CN" onClose={vi.fn()} onSaved={vi.fn()} />);
      });
      expect(container.innerHTML).toBe('');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
    }
  });

  it('隐藏旧历史项目，本地新增和重命名仍保留云端历史记录', async () => {
    await historyStore.ready();
    const remote = await historyStore.resolveWorkspaceByPath('remote://retired');
    const oldSession = await historyStore.createSession({ workspaceId: remote.id, isWorkflow: false, title: '旧历史' });
    const local = await historyStore.resolveWorkspaceByPath('E:\\LocalProject');
    await historyStore.renameWorkspace(local.id, '本地项目');
    const visible = await historyStore.listWorkspaces();
    expect(visible.some((workspace) => workspace.id === remote.id)).toBe(false);
    expect(visible.some((workspace) => workspace.id === local.id && workspace.name === '本地项目')).toBe(true);
    expect((await historyStore.getWorkspace(remote.id))?.path).toBe('remote://retired');
    expect((await historyStore.getSession(remote.id, oldSession.id))?.title).toBe('旧历史');
  });

  it('隐藏云端渠道，旧默认回退到本地渠道并清除网关中的云端镜像', () => {
    const remoteId = 'remote-runner:retired:account';
    const raw = JSON.stringify([
      { id: remoteId, kind: 'anthropic', name: '云端', apiKey: 'remote-runner', baseUrl: 'https://runner.example' },
      { id: 'local', kind: 'anthropic', name: '本地', apiKey: 'test-local', baseUrl: '' },
    ]);
    window.localStorage.setItem(PROVIDERS_STORAGE, raw);
    window.localStorage.setItem(ACTIVE_PROVIDER_BY_KIND_STORAGE, JSON.stringify({ anthropic: remoteId }));
    expect(listProviders().map((provider) => provider.id)).toEqual(['local']);
    expect(getActiveProviderId()).toBe('local');
    expect(getActiveProvider()?.id).toBe('local');
    syncGatewayFromProviders();
    expect(loadGatewayConfig().providers.some((provider) => provider.id === remoteId)).toBe(false);
    expect(JSON.parse(window.localStorage.getItem(PROVIDERS_STORAGE) ?? '[]').some(
      (provider: { id: string }) => provider.id === remoteId,
    )).toBe(true);
  });

  it('拒绝从旧路径切换项目或添加目录，不改写当前本地项目', () => {
    const composer = { ...useStore.getState().composer, workspace: 'E:\\LocalProject', workspaceFolders: [] };
    useStore.setState({ composer, historyReady: false });
    useStore.getState().setWorkspace('remote://retired');
    useStore.getState().addWorkspaceFolder('remote://retired');
    expect(useStore.getState().composer).toEqual(composer);
  });

  it('启动时跳过旧云端项目，恢复本地项目且保留旧记录', async () => {
    await historyStore.ready();
    const remote = await historyStore.resolveWorkspaceByPath('remote://last-active-retired');
    const local = await historyStore.resolveWorkspaceByPath('E:\\StartupLocal');
    await historyStore.patchConfig({ lastActiveWorkspaceId: remote.id });
    saveComposer({
      composer: { ...useStore.getState().composer, workspace: remote.path },
      workspaceHistory: [remote.path, local.path],
    });
    useStore.setState({ historyReady: false });
    useStore.getState().initHistory();
    await vi.waitFor(() => expect(useStore.getState().historyReady).toBe(true));
    expect(useStore.getState().historyError).toBeNull();
    expect(useStore.getState().activeWorkspaceId).toBe(local.id);
    expect(useStore.getState().composer.workspace).toBe(local.path);
    expect((await historyStore.getWorkspace(remote.id))?.path).toBe(remote.path);
  });
});
