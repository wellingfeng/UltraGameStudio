import { afterEach, describe, expect, it } from 'vitest';
import { composerPatchForSession, defaultSessionComposer } from './useStore';
import type { WorkflowSessionKey } from './useStore';
import { chatWorkflow } from './useStore';
import {
  ACTIVE_GATEWAY_SELECTION_STORAGE,
  getExplicitActiveGatewaySelection,
} from '@/lib/gatewayConfig';
import { remoteProviderId } from '@/lib/remoteWorkspace';
import type { SessionComposerSettings } from './types';

const REMOTE_PROVIDER = remoteProviderId('ws-remote-1', 'acct-1');

function localComposer() {
  return defaultSessionComposer('E:\LocalProject');
}

function leakedRemoteSnapshot(): SessionComposerSettings {
  return {
    composer: localComposer(),
    gatewaySelection: {
      adapter: 'claude-code',
      modelClass: 'sonnet',
      providerId: REMOTE_PROVIDER,
      channelId: 'default',
    },
  };
}

function baseState() {
  return {
    activeWorkspaceId: null,
    activeSessionId: 's_prev',
    composer: localComposer(),
    composerBySession: {},
    workflow: chatWorkflow('prev', 'zh-CN'),
  };
}

describe('local workspace gateway selection sanitization', () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it('strips a leaked remote-runner provider when switching to a local session', () => {
    // Simulate the previous remote session having pinned a remote provider globally.
    window.localStorage.setItem(
      ACTIVE_GATEWAY_SELECTION_STORAGE,
      JSON.stringify({
        adapter: 'claude-code',
        modelClass: 'sonnet',
        providerId: REMOTE_PROVIDER,
        channelId: 'default',
      }),
    );

    const sessionKey: WorkflowSessionKey = {
      workspaceId: 'ws-local',
      sessionId: 's_local',
    };
    const state = {
      ...baseState(),
      composerBySession: {
        [`ws-local::s_local`]: leakedRemoteSnapshot(),
      },
    };

    const patch = composerPatchForSession(
      state,
      sessionKey,
      chatWorkflow('local', 'zh-CN'),
      localComposer(),
    );

    const selection = patch.workflow.meta.gateway?.defaults;
    expect(selection?.providerId).not.toBe(REMOTE_PROVIDER);
    // The stale global pin must be repaired too so runs/new sessions stop leaking.
    expect(getExplicitActiveGatewaySelection()?.providerId).not.toBe(
      REMOTE_PROVIDER,
    );
  });

  it('leaves a clean local selection untouched', () => {
    const sessionKey: WorkflowSessionKey = {
      workspaceId: 'ws-local',
      sessionId: 's_local',
    };
    const cleanSnapshot: SessionComposerSettings = {
      composer: localComposer(),
      gatewaySelection: { adapter: 'codex', modelClass: 'gpt-5.5' },
    };
    const state = {
      ...baseState(),
      composerBySession: { [`ws-local::s_local`]: cleanSnapshot },
    };

    const patch = composerPatchForSession(
      state,
      sessionKey,
      chatWorkflow('local', 'zh-CN'),
      localComposer(),
    );

    expect(patch.workflow.meta.gateway?.defaults).toMatchObject({
      adapter: 'codex',
      modelClass: 'gpt-5.5',
    });
  });
});
