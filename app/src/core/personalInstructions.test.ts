import { describe, expect, it } from 'vitest';
import {
  defaultPersonalInstructionsByModel,
  ensureRequiredPersonalInstructions,
  personalInstructionsKey,
  personalInstructionsSample,
  selectionFromPersonalInstructionsKey,
  withPersonalInstructionsForSelection,
} from './personalInstructions';
import type { GatewaySelection } from './ir';

describe('personal instructions model buckets', () => {
  it('round-trips a selection through its storage key', () => {
    const selection: GatewaySelection = {
      adapter: 'gemini',
      modelClass: 'gemini-2.5-pro',
      providerId: 'provider with space',
      channelId: 'default/channel',
    };

    expect(selectionFromPersonalInstructionsKey(personalInstructionsKey(selection))).toEqual(
      selection,
    );
  });

  it('removes a bucket when saved instructions are blank', () => {
    const selection: GatewaySelection = {
      adapter: 'claude-code',
      modelClass: 'sonnet',
      systemDefault: true,
    };
    const saved = withPersonalInstructionsForSelection({}, selection, 'Use Chinese');

    expect(withPersonalInstructionsForSelection(saved, selection, '   ')).toEqual({});
  });

  it('adds the larkdoc rule to every model sample', () => {
    for (const adapter of ['claude-code', 'gemini', 'codex']) {
      expect(personalInstructionsSample({ adapter, modelClass: 'default' })).toContain(
        '使用 `larkdoc` skill；不要申请企业权限',
      );
    }
  });

  it('builds default buckets for core adapters', () => {
    const defaults = defaultPersonalInstructionsByModel();

    expect(
      defaults[
        personalInstructionsKey({ adapter: 'claude-code', modelClass: 'sonnet' })
      ],
    ).toContain('Claude Code Defaults');
    expect(
      defaults[
        personalInstructionsKey({
          adapter: 'codex',
          modelClass: 'default',
          systemDefault: true,
        })
      ],
    ).toContain('Codex Defaults');
    expect(
      defaults[
        personalInstructionsKey({
          adapter: 'gemini',
          modelClass: 'default',
          systemDefault: true,
        })
      ],
    ).toContain('Gemini Defaults');
  });

  it('uses provider profiles for free-channel defaults', () => {
    const geminiFreeChannel: GatewaySelection = {
      adapter: 'claude-code',
      modelClass: 'sonnet',
      providerId: 'freecc:gemini',
      channelId: 'default',
    };
    const openRouter: GatewaySelection = {
      adapter: 'claude-code',
      modelClass: 'sonnet',
      providerId: 'freecc:open_router',
      channelId: 'default',
    };
    const ollama: GatewaySelection = {
      adapter: 'claude-code',
      modelClass: 'sonnet',
      providerId: 'freecc:ollama',
      channelId: 'default',
    };

    expect(personalInstructionsSample(geminiFreeChannel)).toContain(
      'Gemini Defaults',
    );
    expect(personalInstructionsSample(openRouter)).toContain(
      'OpenAI-Compatible Coding Defaults',
    );
    expect(personalInstructionsSample(ollama)).toContain('Local Model Defaults');
  });

  it('adds the larkdoc rule when saving model-specific instructions', () => {
    const selection: GatewaySelection = {
      adapter: 'gemini',
      modelClass: 'default',
      systemDefault: true,
    };
    const saved = withPersonalInstructionsForSelection({}, selection, 'Use Chinese');

    expect(saved[personalInstructionsKey(selection)]).toContain('Use Chinese');
    expect(saved[personalInstructionsKey(selection)]).toContain(
      '使用 `larkdoc` skill；不要申请企业权限',
    );
  });

  it('does not duplicate an existing larkdoc rule', () => {
    const instructions =
      'Use Chinese\n\n- Use larkdoc skill for Lark Docs; do not request enterprise permission.';

    expect(ensureRequiredPersonalInstructions(instructions)).toBe(instructions);
  });

  it('adds the permission limit when larkdoc is mentioned without it', () => {
    const instructions = 'Use Chinese\n\n- Use larkdoc skill for Lark Docs.';

    expect(ensureRequiredPersonalInstructions(instructions)).toContain(
      '使用 `larkdoc` skill；不要申请企业权限',
    );
  });
});
