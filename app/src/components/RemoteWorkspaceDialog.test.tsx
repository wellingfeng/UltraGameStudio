import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RemoteWorkspaceDialog from './RemoteWorkspaceDialog';
import {
  saveRemoteRunnerConnection,
  saveRemoteWorkspace,
} from '@/lib/remoteWorkspace';
import { resetSecureStorageForTests } from '@/lib/secureStorage';
import { CLOUD_PROJECTS_ENABLED } from '@/lib/cloudProjects';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  window.localStorage.clear();
  resetSecureStorageForTests();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.localStorage.clear();
  resetSecureStorageForTests();
  vi.restoreAllMocks();
});

describe.runIf(CLOUD_PROJECTS_ENABLED)('RemoteWorkspaceDialog', () => {
  it('keeps server URL and access token out of the project form by default', () => {
    saveRemoteRunnerConnection(
      { serverUrl: 'https://runner.test:8787' },
      { token: 'runner-token' },
    );
    const existing = saveRemoteWorkspace({
      label: '云端游戏项目',
      serverUrl: 'https://runner.test:8787',
      projectId: 'proj_game',
      repoUrl: 'https://github.com/me/game.git',
      adapter: 'codex',
    });

    act(() => {
      root.render(
        <RemoteWorkspaceDialog
          locale="zh-CN"
          existing={existing}
          onClose={vi.fn()}
          onSaved={vi.fn()}
        />,
      );
    });

    expect(container.textContent).toContain('云端服务连接');
    expect(container.textContent).toContain('已配置');
    expect(container.textContent).toContain('项目仓库地址');
    expect(container.textContent).not.toContain('服务器地址');
    expect(container.textContent).not.toContain('访问 Token');
  });

  it('gates a new cloud project behind email identity verification', () => {
    act(() => {
      root.render(
        <RemoteWorkspaceDialog
          locale="zh-CN"
          onClose={vi.fn()}
          onSaved={vi.fn()}
        />,
      );
    });

    // 新建云端项目时先显示身份门禁，而不是项目表单。
    expect(container.textContent).toContain('验证身份');
    expect(container.textContent).toContain('云端服务地址');
    // 项目表单（仓库地址、保存）此时不应出现。
    expect(container.textContent).not.toContain('项目仓库地址');
    const saveButton = [...container.querySelectorAll('button')].find(
      (node) => node.textContent === '保存',
    );
    expect(saveButton).toBeFalsy();
    // 门禁阶段提供邮箱登录/注册入口。
    const loginButton = [...container.querySelectorAll('button')].find(
      (node) => node.textContent === '登录',
    );
    expect(loginButton).toBeTruthy();
  });

  it('shows the project form with the assigned account once an email session exists', () => {
    saveRemoteRunnerConnection(
      { serverUrl: 'https://runner.test:8787' },
      {
        token: 'runner-token',
        refreshToken: 'refresh-token',
        userEmail: 'player@example.com',
      },
    );

    act(() => {
      root.render(
        <RemoteWorkspaceDialog
          locale="zh-CN"
          onClose={vi.fn()}
          onSaved={vi.fn()}
        />,
      );
    });

    // 已有邮箱登录态时直接进入项目表单。
    expect(container.textContent).toContain('项目仓库地址');
    expect(container.textContent).not.toContain('验证身份');
  });

  it('drops the project-level default model field', () => {
    saveRemoteRunnerConnection(
      { serverUrl: 'https://runner.test:8787' },
      { token: 'runner-token' },
    );
    const existing = saveRemoteWorkspace({
      label: '云端游戏项目',
      serverUrl: 'https://runner.test:8787',
      projectId: 'proj_game',
      repoUrl: 'https://github.com/me/game.git',
      adapter: 'codex',
    });

    act(() => {
      root.render(
        <RemoteWorkspaceDialog
          locale="zh-CN"
          existing={existing}
          onClose={vi.fn()}
          onSaved={vi.fn()}
        />,
      );
    });

    // 模型不再由项目级配置，运行时跟随所选服务器账号。
    expect(container.textContent).not.toContain('默认模型');
    // 「默认 Agent」仍在，并给出说明。
    expect(container.textContent).toContain('默认 Agent');
    expect(container.textContent).toContain('模型随所选账号自动匹配');
  });
});
