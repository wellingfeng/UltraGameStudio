import { afterEach, describe, expect, it } from 'vitest';
import { defaultComposer } from '@/store/sampleSessions';
import { personalInstructionsKey } from '@/core/personalInstructions';
import {
  loadComposer,
  loadPersonalInstructions,
  loadPersonalInstructionsByModel,
  saveComposer,
  savePersonalInstructions,
  savePersonalInstructionsByModel,
} from '@/lib/composerStorage';

const COMPOSER_KEY = 'freeultracode.composer.v1';
const PERSONAL_INSTRUCTIONS_BY_MODEL_KEY =
  'freeultracode.personalInstructionsByModel.v1';

afterEach(() => {
  window.localStorage.clear();
});

describe('composer workspace history persistence', () => {
  it('deduplicates persisted workspace paths by normalized path', () => {
    window.localStorage.setItem(
      COMPOSER_KEY,
      JSON.stringify({
        composer: defaultComposer,
        workspaceHistory: [
          'E:\\Game',
          'e:/Game/',
          'E:\\FreeUltraCode',
          'E:\\Game\\',
        ],
      }),
    );

    expect(loadComposer()?.workspaceHistory).toEqual([
      'E:\\Game',
      'E:\\FreeUltraCode',
    ]);
  });

  it('saves workspace history without normalized duplicates', () => {
    saveComposer({
      composer: defaultComposer,
      composerBySession: {},
      workspaceHistory: ['E:\\Game', 'e:/Game/', 'E:\\FreeUltraCode'],
    });

    const raw = window.localStorage.getItem(COMPOSER_KEY);
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!).workspaceHistory).toEqual([
      'E:\\Game',
      'E:\\FreeUltraCode',
    ]);
  });
});

describe('personal instructions persistence', () => {
  it('round-trips personal instructions from localStorage', () => {
    savePersonalInstructions('# Personal Defaults\n\n- 默认中文');

    expect(loadPersonalInstructions()).toBe('# Personal Defaults\n\n- 默认中文');
  });

  it('seeds default instructions when model config is missing', () => {
    const claude = { adapter: 'claude-code', modelClass: 'sonnet' };
    const gemini = {
      adapter: 'gemini',
      modelClass: 'default',
      systemDefault: true,
    };
    const openRouter = {
      adapter: 'claude-code',
      modelClass: 'sonnet',
      providerId: 'freecc:open_router',
      channelId: 'default',
    };
    const loaded = loadPersonalInstructionsByModel(claude, [
      claude,
      gemini,
      openRouter,
    ]);

    expect(loaded[personalInstructionsKey(claude)]).toContain(
      'Claude Code Defaults',
    );
    expect(loaded[personalInstructionsKey(gemini)]).toContain('Gemini Defaults');
    expect(loaded[personalInstructionsKey(openRouter)]).toContain(
      'OpenAI-Compatible Coding Defaults',
    );

    const persisted = JSON.parse(
      window.localStorage.getItem(PERSONAL_INSTRUCTIONS_BY_MODEL_KEY) ?? '{}',
    ) as Record<string, string>;
    expect(persisted[personalInstructionsKey(gemini)]).toContain(
      'Gemini Defaults',
    );
  });

  it('keeps an explicit empty per-model config empty', () => {
    const selection = { adapter: 'gemini', modelClass: 'default' };
    window.localStorage.setItem(PERSONAL_INSTRUCTIONS_BY_MODEL_KEY, '{}');

    expect(loadPersonalInstructionsByModel(selection, [selection])).toEqual({});
  });

  it('round-trips personal instructions per model', () => {
    const claude = { adapter: 'claude-code', modelClass: 'sonnet' };
    const gemini = { adapter: 'gemini', modelClass: 'default' };
    savePersonalInstructionsByModel({
      [personalInstructionsKey(claude)]: 'Claude defaults',
      [personalInstructionsKey(gemini)]: 'Gemini defaults',
    });

    const loaded = loadPersonalInstructionsByModel();
    expect(loaded[personalInstructionsKey(claude)]).toContain('Claude defaults');
    expect(loaded[personalInstructionsKey(gemini)]).toContain('Gemini defaults');
    expect(loaded[personalInstructionsKey(claude)]).toContain(
      '使用 `larkdoc` skill；不要申请企业权限',
    );
    expect(loaded[personalInstructionsKey(gemini)]).toContain(
      '使用 `larkdoc` skill；不要申请企业权限',
    );
  });

  it('migrates the legacy single value into the selected model bucket', () => {
    const selection = {
      adapter: 'gemini',
      modelClass: 'default',
      systemDefault: true,
    };
    savePersonalInstructions('Legacy defaults');

    const loaded = loadPersonalInstructionsByModel(selection);
    expect(loaded[personalInstructionsKey(selection)]).toContain('Legacy defaults');
    expect(loaded[personalInstructionsKey(selection)]).toContain(
      '使用 `larkdoc` skill；不要申请企业权限',
    );
  });
});
