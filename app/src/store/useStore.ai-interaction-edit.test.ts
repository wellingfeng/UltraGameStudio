import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultBlueprint } from '@/core/defaultBlueprint';
import { EXEC, type IRGraph } from '@/core/ir';

const gatewayMocks = vi.hoisted(() => ({
  completeGatewayText: vi.fn(),
  resolveDirectGatewayRoute: vi.fn(),
}));

vi.mock('@/lib/modelGateway/modelGateway', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/modelGateway/modelGateway')
  >('@/lib/modelGateway/modelGateway');
  return {
    ...actual,
    completeGatewayText: gatewayMocks.completeGatewayText,
    resolveDirectGatewayRoute: gatewayMocks.resolveDirectGatewayRoute,
  };
});

import { useStore } from './useStore';

function cloneGraph(graph: IRGraph): IRGraph {
  return JSON.parse(JSON.stringify(graph)) as IRGraph;
}

function buildAnsweredGraph(): IRGraph {
  const base = defaultBlueprint('Style workflow');
  return {
    ...base,
    nodes: [
      base.nodes[0],
      {
        id: 'n_style_decision',
        type: 'agent',
        label: '落地 Pencil 与可切换风格',
        params: {
          prompt:
            '根据用户确认，同时落地 Pencil 默认设计以及多套可切换界面风格。',
        },
      },
      base.nodes[2],
    ],
    edges: [
      {
        id: 'e_start_style_decision',
        from: { node: 'n_start', port: 'exec_out' },
        to: { node: 'n_style_decision', port: 'exec_in' },
        kind: EXEC,
      },
      {
        id: 'e_style_decision_end',
        from: { node: 'n_style_decision', port: 'exec_out' },
        to: { node: 'n_end', port: 'exec_in' },
        kind: EXEC,
      },
    ],
  };
}

function resetStore(): void {
  window.localStorage.setItem('fuc_research_angles_max', '1');
  window.localStorage.setItem('fuc_nodegen_candidates_max', '1');
  window.localStorage.setItem('fuc_runtime_vote_samples_max', '1');
  window.localStorage.setItem('fuc_terminal_vote_samples_max', '1');
  useStore.setState({
    workflow: cloneGraph(defaultBlueprint('Current workflow')),
    selectedNodeId: null,
    mode: 'design',
    aiStreaming: false,
    aiEditingSessions: [],
    dirty: false,
    currentFilePath: null,
    messages: [],
    composerDraft: '',
    composerDrafts: {},
    activeSessionId: null,
    activeWorkspaceId: null,
    historyReady: false,
    sessions: [],
    sessionTree: {},
    runState: {},
    runOutputs: {},
    lastRunFailedNodeId: null,
  });
}

async function waitFor(
  condition: () => boolean,
  description: string,
): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for ${description}\n` +
          `gatewayCalls=${gatewayMocks.completeGatewayText.mock.calls.length}\n` +
          `messages=${JSON.stringify(useStore.getState().messages, null, 2)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

afterEach(() => {
  gatewayMocks.completeGatewayText.mockReset();
  gatewayMocks.resolveDirectGatewayRoute.mockReset();
  resetStore();
  window.localStorage.clear();
});

describe('AI edit interactions', () => {
  it('continues after a select answer and commits the returned IRGraph', async () => {
    resetStore();
    gatewayMocks.resolveDirectGatewayRoute.mockReturnValue({
      selection: { adapter: 'claude-code', modelClass: 'sonnet' },
      adapter: 'claude-code',
      apiKey: 'test-key',
      model: 'sonnet',
      transport: 'anthropic',
    });
    const requests: Array<{ userContent: string }> = [];
    gatewayMocks.completeGatewayText.mockImplementation(async (request) => {
      requests.push({ userContent: String(request.userContent) });
      if (requests.length === 1) {
        return [
          '<<FUC_ASK>>',
          JSON.stringify({
            type: 'select',
            prompt: '默认只落地 Pencil，还是同时落地多套可切换风格？',
            options: ['只落地 Pencil', '同时落地 Pencil 及多套可切换风格'],
            multi: false,
          }),
          '<<FUC_ASK_END>>',
        ].join('\n');
      }
      return `已根据你的回答更新蓝图。\n\n\`\`\`json\n${JSON.stringify(
        buildAnsweredGraph(),
      )}\n\`\`\``;
    });

    useStore
      .getState()
      .sendPrompt(
        '在动手改图前，先用交互（select / input）向我确认蓝图中最关键的一个含糊或缺失决策；我回答后，必须立刻把回答写入 workflow 蓝图并输出更新后的 IRGraph。',
      );

    await waitFor(() =>
      useStore.getState().messages.some((message) => message.interaction),
      'the interaction message',
    );
    const interactionMessage = useStore
      .getState()
      .messages.find((message) => message.interaction);
    expect(interactionMessage).toBeTruthy();

    useStore.getState().answerInteraction(interactionMessage!.id, {
      kind: 'select',
      values: ['同时落地 Pencil 及多套可切换风格'],
    });

    await waitFor(() =>
      useStore
        .getState()
        .workflow.nodes.some((node) => node.id === 'n_style_decision'),
      'the committed answered blueprint',
    );

    expect(gatewayMocks.completeGatewayText).toHaveBeenCalledTimes(2);
    expect(requests[1].userContent).toContain(
      '用户的回答：同时落地 Pencil 及多套可切换风格',
    );
    const start = useStore
      .getState()
      .workflow.nodes.find((node) => node.id === 'n_start');
    expect(start?.params.userInputs).toContain(
      'Question: 默认只落地 Pencil，还是同时落地多套可切换风格？\nAnswer: 同时落地 Pencil 及多套可切换风格',
    );
    expect(useStore.getState().aiStreaming).toBe(false);
  });

  it('lets session switching continue while the original AI edit finishes in the background', async () => {
    resetStore();
    useStore.setState({
      activeSessionId: 's_main',
      activeWorkspaceId: null,
    });
    gatewayMocks.resolveDirectGatewayRoute.mockReturnValue({
      selection: { adapter: 'claude-code', modelClass: 'sonnet' },
      adapter: 'claude-code',
      apiKey: 'test-key',
      model: 'sonnet',
      transport: 'anthropic',
    });

    let resolveReply!: (value: string) => void;
    gatewayMocks.completeGatewayText.mockImplementation(async () => {
      return await new Promise<string>((resolve) => {
        resolveReply = resolve;
      });
    });

    useStore
      .getState()
      .sendPrompt('把这个 workflow 改成更完整的三步流程。');

    await waitFor(() => useStore.getState().aiStreaming, 'AI streaming to start');

    useStore.getState().selectSession('s_other');
    expect(useStore.getState().activeSessionId).toBe('s_other');

    resolveReply(`已根据你的回答更新蓝图。\n\n\`\`\`json\n${JSON.stringify(
      buildAnsweredGraph(),
    )}\n\`\`\``);

    await waitFor(
      () =>
        !useStore.getState().aiStreaming &&
        !useStore
          .getState()
          .workflow.nodes.some((node) => node.id === 'n_style_decision'),
      'the background AI edit to finish without affecting the switched view',
    );

    expect(useStore.getState().activeSessionId).toBe('s_other');
    expect(
      useStore.getState().workflow.nodes.some((node) => node.id === 'n_style_decision'),
    ).toBe(false);

    useStore.getState().selectSession('s_main');

    await waitFor(
      () =>
        useStore
          .getState()
          .workflow.nodes.some((node) => node.id === 'n_style_decision'),
      'the committed answered blueprint when switching back',
    );

    expect(useStore.getState().activeSessionId).toBe('s_main');
    expect(useStore.getState().aiStreaming).toBe(false);
  });

  // [dynamic-only refactor] newWorkflow 蓝图创建已停用（改为 no-op）；此旧用例
  // 依赖创建第二个可视化 workflow 会话，保留源码但跳过以便日后恢复蓝图入口。
  it.skip('starts a new workflow AI edit while another workflow is still generating', async () => {
    resetStore();
    useStore.setState({
      activeSessionId: 's_main',
      activeWorkspaceId: null,
    });
    gatewayMocks.resolveDirectGatewayRoute.mockReturnValue({
      selection: { adapter: 'claude-code', modelClass: 'sonnet' },
      adapter: 'claude-code',
      apiKey: 'test-key',
      model: 'sonnet',
      transport: 'anthropic',
    });

    const resolvers: Array<(value: string) => void> = [];
    gatewayMocks.completeGatewayText.mockImplementation(async () => {
      return await new Promise<string>((resolve) => {
        resolvers.push(resolve);
      });
    });

    const reply = `已更新蓝图。\n\n\`\`\`json\n${JSON.stringify(
      buildAnsweredGraph(),
    )}\n\`\`\``;

    try {
      useStore.getState().sendPrompt('先优化第一个 workflow。');

      await waitFor(
        () => resolvers.length === 1 && useStore.getState().aiStreaming,
        'the first workflow AI edit to start',
      );

      useStore.getState().newWorkflow();

      await waitFor(
        () => useStore.getState().activeSessionId !== 's_main',
        'the new workflow session to become active',
      );
      const secondSessionId = useStore.getState().activeSessionId;

      useStore.getState().sendPrompt('再优化这个新的 workflow。');

      await waitFor(
        () =>
          resolvers.length === 2 &&
          useStore
            .getState()
            .aiEditingSessions.some(
              (session) => session.sessionId === secondSessionId,
            ),
        'the second workflow AI edit to start',
      );

      expect(gatewayMocks.completeGatewayText).toHaveBeenCalledTimes(2);
    } finally {
      for (const resolve of resolvers) resolve(reply);
      await waitFor(
        () => !useStore.getState().aiStreaming,
        'all workflow AI edits to finish',
      );
    }
  });
});
