import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SKILL_LEARNING_CONFIG } from '@/lib/skillLearningConfig';
import type { SkillEntry, SkillLearningConfig, SkillMutationResult, SkillReviewState } from '@/runtime/skills/types';
import Settings from './SkillLearningSettings';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

function skillEntry(overrides: Partial<SkillEntry> = {}): SkillEntry {
  return {
    skillId: 'skill-a', rootId: 'ugs-project', name: 'review-patterns', description: 'Reusable review rules',
    scope: 'project', source: 'UGS managed', relativePath: 'review-patterns', revision: 'v1', hash: 'hash-v1',
    readOnly: false, autoEditable: false, contentLocked: false, pinned: true, state: 'active', files: ['SKILL.md'],
    ...overrides,
  };
}

describe('SkillLearningSettings', () => {
  it('forwards the exact resultless source snapshot to the retry controller', async () => {
    const origin = { hostId:'local', workspaceId:'ws', sessionId:'s', turnId:'t', runId:'r' };
    const saved = { status:'failed' as const, origin, error:'SKILL_REVIEW_INTERRUPTED', resume:{ job:{ origin, userText:'saved user', finalAnswer:'saved final', evidence:[], loadedSkills:[], config:DEFAULT_SKILL_LEARNING_CONFIG }, selection:{ adapter:'codex', modelClass:'review' } } };
    const retry = vi.fn(async () => undefined);
    await act(async () => { root.render(<Settings config={DEFAULT_SKILL_LEARNING_CONFIG} onChange={vi.fn()} history={[saved]} onRetryState={retry} />); });
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="重新复盘"]');
    expect(button).not.toBeNull();
    await act(async () => { button!.click(); });
    expect(retry).toHaveBeenCalledExactlyOnceWith(saved);
  });
  it('does not offer resultless retry without a saved snapshot even when a state controller exists', async () => {
    const origin = { hostId: 'local', workspaceId: 'ws', sessionId: 's', turnId: 't', runId: 'r' };
    await act(async () => { root.render(<Settings config={DEFAULT_SKILL_LEARNING_CONFIG} onChange={vi.fn()} history={[{ status:'failed', origin, error:'SKILL_REVIEW_INTERRUPTED' }]} onRetryState={vi.fn()} />); });
    expect(container.querySelector('button[aria-label="重新复盘"]')).toBeNull();
    expect(container.textContent).toContain('缺少可恢复的证据快照');
  });
  it('keeps safety and policy explanations readable rather than using faint text', async () => {
    await act(async () => { root.render(<Settings config={DEFAULT_SKILL_LEARNING_CONFIG} onChange={vi.fn()} />); });
    expect(container.querySelector('.text-fg-faint')).toBeNull();
  });
  it('gives select and numeric controls a minimum keyboard/touch target height', async () => {
    await act(async () => { root.render(<Settings config={DEFAULT_SKILL_LEARNING_CONFIG} onChange={vi.fn()} />); });
    for (const control of container.querySelectorAll('select,input[type="number"]')) expect(control.className).toContain('min-h-11');
  });
  it('mounts an idle advisory entry without automatically archiving any package', async () => {
    vi.useFakeTimers();
    const onArchive = vi.fn();
    const config = { ...DEFAULT_SKILL_LEARNING_CONFIG, autoArchive: true };
    await act(async () => { root.render(<Settings config={config} onChange={vi.fn()} entries={[skillEntry({ pinned: false })]} lifecycleScopeKey="source-ws" onArchive={onArchive} />); });
    expect(container.querySelector('[data-lifecycle-skill-id]')).toBeNull();
    await act(async () => { vi.advanceTimersByTime(120000); });
    expect(container.querySelector('[data-lifecycle-skill-id="skill-a"]')?.textContent).toContain('首次观测');
    expect(container.textContent).toContain('尚无任务采用验证');
    expect(onArchive).not.toHaveBeenCalled();
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    vi.useRealTimers();
  });
  it('keeps failed, cancelled, noop and active history visible even when learning is off', async () => {
    const origin = { hostId: 'local', workspaceId: 'ws-history', sessionId: 's-history', turnId: 't', runId: 'r' };
    const history: SkillReviewState[] = (['queued', 'reading', 'proposing', 'applying', 'noop', 'failed', 'cancelled'] as const)
      .map((status) => ({ status, origin: { ...origin, runId: status }, error: status === 'failed' ? 'HTTP unavailable' : undefined }));
    await act(async () => { root.render(<Settings config={{ ...DEFAULT_SKILL_LEARNING_CONFIG, enabled: false, mode: 'off' }} onChange={vi.fn()} history={history} />); });
    expect(container.querySelectorAll('article')).toHaveLength(7);
    expect(container.textContent).toContain('HTTP unavailable');
    expect(container.textContent).toContain('s-history');
    expect(container.querySelector('button[aria-label="重新复盘"]')).toBeNull();
  });
  it('describes background automatic submission honestly for legacy auto-safe preferences', async () => {
    await act(async () => { root.render(<Settings config={DEFAULT_SKILL_LEARNING_CONFIG} onChange={vi.fn()} />); });
    expect(container.textContent).toContain('后台自动送审，不自动保存');
    expect(container.textContent).toContain('连续两次');
    expect(container.textContent).toContain('0.95');
    expect(container.querySelector('option[value="auto-safe"]')?.textContent).not.toContain('低风险自动保存');
  });
  it('configures the reviewer HTTP protocol separately from source-session execution', async () => {
    const onChange = vi.fn();
    const selection = { adapter: 'codex', modelClass: 'exact-review-model', providerId: 'review-provider', channelId: 'review-channel' };
    const config = { ...DEFAULT_SKILL_LEARNING_CONFIG, reviewSelection: selection };
    await act(async () => { root.render(<Settings config={config} onChange={onChange} locale="en-US" />); });
    const protocol = container.querySelector<HTMLSelectElement>('select[aria-label="Review HTTP protocol"]');
    expect(protocol).not.toBeNull();
    expect(Array.from(protocol!.options).map((option) => option.value)).toEqual(['', 'anthropic', 'openai-compatible']);
    expect(protocol!.value).toBe('');
    await act(async () => { protocol!.value = 'openai-compatible'; protocol!.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ ...config, reviewTransport: 'openai-compatible' });
    const configured = onChange.mock.calls[0][0] as SkillLearningConfig;
    await act(async () => { root.render(<Settings config={configured} onChange={onChange} locale="en-US" />); });
    expect(protocol!.value).toBe('openai-compatible');
    expect(container.textContent).toContain('does not change source-session CLI execution');
    await act(async () => { protocol!.value = ''; protocol!.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(onChange).toHaveBeenLastCalledWith(config);
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(window.localStorage.length).toBe(0);
  });

  it.each(['zh-CN', 'en-US'] as const)('labels auto-archive as recommendation-only in %s until a production scheduler exists', async (locale) => {
    await act(async () => { root.render(<Settings config={DEFAULT_SKILL_LEARNING_CONFIG} onChange={vi.fn()} locale={locale} />); });
    expect(container.textContent).toContain(locale === 'zh-CN'
      ? '当前仅生成归档建议，不会自动移动技能包'
      : 'Currently recommends archiving only; no skill packages are moved automatically');
    expect(container.textContent).not.toContain(locale === 'zh-CN'
      ? '自动归档（需主动开启）'
      : 'Automatic archiving (opt-in)');
  });

  it('retains the full review-model label in a tooltip when a narrow select clips its visible value', async () => {
    await act(async () => { root.render(<Settings config={DEFAULT_SKILL_LEARNING_CONFIG} onChange={vi.fn()} locale="en-US" />); });
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="Review model"]')!;
    expect(select.title).toBe('Use source-session model (still safety-gated)');
  });
  it('never enables a CLI or non-HTTP choice even if an old capability flag says safe', async () => {
    const onChange = vi.fn();
    await act(async () => { root.render(<Settings config={DEFAULT_SKILL_LEARNING_CONFIG} onChange={onChange} modelOptions={[
      { id: 'claimed-cli', label: 'CLI unavailable', selection: { adapter: 'codex', modelClass: 'default' }, transport: 'cli', safeForReview: true },
      { id: 'simulator', label: 'Simulator unavailable', selection: { adapter: 'codex', modelClass: 'default' }, transport: 'simulator' },
    ]} />); });
    const models = container.querySelector<HTMLSelectElement>('select[aria-label="复盘模型"]')!;
    expect(models.querySelector<HTMLOptionElement>('option[value="claimed-cli"]')?.disabled).toBe(true);
    expect(models.querySelector<HTMLOptionElement>('option[value="simulator"]')?.disabled).toBe(true);
    await act(async () => { models.value = 'claimed-cli'; models.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('binds each history action to its own frozen state even when batch ids overlap', async () => {
    const originA = { hostId: 'local', workspaceId: 'ws-a', sessionId: 'session-a', turnId: 'turn-a', runId: 'run-a' };
    const originB = { ...originA, workspaceId: 'ws-b', sessionId: 'session-b' };
    const pending = (origin: typeof originA): SkillMutationResult => ({ status: 'awaiting_approval', batchId: 'shared-batch', origin, lesson: origin.workspaceId, operationsApplied: 0, changes: [], riskReasons: [] });
    const a = { status: 'awaiting_approval' as const, origin: originA, result: pending(originA) };
    const b = { status: 'awaiting_approval' as const, origin: originB, result: pending(originB) };
    const onReviewAction = vi.fn(async (state: SkillReviewState) => ({ ...state.result!, status: 'applied' as const, operationsApplied: 1 }));
    await act(async () => { root.render(<Settings config={DEFAULT_SKILL_LEARNING_CONFIG} onChange={vi.fn()} history={[a, b]} onReviewAction={onReviewAction} />); });
    const approvals = container.querySelectorAll<HTMLButtonElement>('button[aria-label="批准修改"]');
    expect(approvals).toHaveLength(2);
    await act(async () => { approvals[1].click(); });
    expect(onReviewAction).toHaveBeenCalledExactlyOnceWith(b, 'approve');
    expect(container.querySelectorAll('article')[0].textContent).toContain('待批准');
    expect(container.querySelectorAll('article')[1].textContent).toContain('经验已保存');
  });

  it('offers auto-safe, approve-all and off using the completed-tool activity metric', async () => {
    const onChange = vi.fn();
    await act(async () => {
      root.render(<Settings config={DEFAULT_SKILL_LEARNING_CONFIG} onChange={onChange} />);
    });
    const mode = container.querySelector<HTMLSelectElement>('select[aria-label="写入模式"]');
    expect(mode).not.toBeNull();
    expect(Array.from(mode!.options).map((option) => option.value)).toEqual(['auto-safe', 'approve-all', 'off']);
    expect(mode!.value).toBe('auto-safe');
    expect(container.textContent).toContain('已完成工具活动');
    expect(container.textContent).toContain('不是 Hermes iteration');
    await act(async () => {
      mode!.value = 'approve-all';
      mode!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_SKILL_LEARNING_CONFIG, mode: 'approve-all' });
  });

  it('keeps configured learning preferences visible when the safe channel is unavailable', async () => {
    const onChange = vi.fn();
    await act(async () => {
      root.render(<Settings config={DEFAULT_SKILL_LEARNING_CONFIG} onChange={onChange}
        capability={{ available: false, reason: 'CLI 未通过安全能力核验' }} />);
    });
    expect(container.querySelector('[role="status"]')?.textContent).toContain('CLI 未通过安全能力核验');
    expect(container.textContent).toContain('当前通道不支持安全学习');
    const enabled = container.querySelector<HTMLInputElement>('input[aria-label="启用自动学习"]');
    expect(enabled?.checked).toBe(true);
    await act(async () => { enabled!.click(); });
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_SKILL_LEARNING_CONFIG, enabled: false });
    expect(container.textContent).toContain('关闭不删除历史');
    expect(container.textContent).toContain('不会降级到 full CLI');
  });

  it('edits bounded aggregate review budgets and leaves auto-archive opt-in', async () => {
    const onChange = vi.fn();
    await act(async () => { root.render(<Settings config={DEFAULT_SKILL_LEARNING_CONFIG} onChange={onChange} />); });
    const fields: Array<[string, keyof SkillLearningConfig, number, number]> = [
      ['已完成工具活动阈值', 'activityThreshold', 10, 20],
      ['冷却时间（毫秒）', 'cooldownMs', 60000, 120000],
      ['最大复盘轮数', 'maxRounds', 6, 8],
      ['累计输入上限（tokens）', 'maxInputTokens', 48000, 24000],
      ['累计输出上限（tokens）', 'maxOutputTokens', 6000, 4000],
      ['总超时（毫秒）', 'timeoutMs', 600000, 60000],
      ['闲置提醒（天）', 'staleAfterDays', 30, 45],
      ['归档阈值（天）', 'archiveAfterDays', 90, 120],
    ];
    for (const [label, field, expected, next] of fields) {
      const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
      expect(input, label).not.toBeNull();
      expect(input!.value).toBe(String(expected));
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      await act(async () => {
        setter.call(input, String(next));
        input!.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_SKILL_LEARNING_CONFIG, [field]: next });
    }
    const autoArchive = container.querySelector<HTMLInputElement>('input[aria-label="自动归档"]');
    expect(autoArchive?.checked).toBe(false);
    expect(container.textContent).toContain('累计预算');
    expect(container.textContent).toContain('不会永久删除');
    await act(async () => { autoArchive!.click(); });
    expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_SKILL_LEARNING_CONFIG, autoArchive: true });
  });

  it('selects a separate review model from supplied gateway metadata without exposing credentials', async () => {
    const onChange = vi.fn();
    const selection = { adapter: 'codex' as const, modelClass: 'default', providerId: 'provider-a', channelId: 'channel-a' };
    await act(async () => {
      root.render(<Settings config={DEFAULT_SKILL_LEARNING_CONFIG} onChange={onChange} modelOptions={[
        { id: 'review-a', label: 'Review API', selection, transport: 'openai-compatible' },
        { id: 'unsafe-cli', label: 'Unverified CLI', selection: { adapter: 'claude-code', modelClass: 'sonnet' }, transport: 'cli' },
      ]} />);
    });
    const models = container.querySelector<HTMLSelectElement>('select[aria-label="复盘模型"]');
    expect(models).not.toBeNull();
    expect(models!.value).toBe('');
    expect(models!.querySelector<HTMLOptionElement>('option[value="unsafe-cli"]')?.disabled).toBe(true);
    await act(async () => { models!.value = 'review-a'; models!.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_SKILL_LEARNING_CONFIG, reviewSelection: selection });
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(window.localStorage.length).toBe(0);
    expect(container.textContent).toContain('独立选择');
  });

  it('matches the explicit review model within a shared gateway channel', async () => {
    const selection = { adapter: 'codex', modelClass: 'default', providerId: 'provider-a', channelId: 'channel-a' };
    const modelOptions = [
      { id: 'model-a', label: 'Review A', selection: { ...selection, model: 'review-model-a' }, transport: 'openai-compatible' },
      { id: 'model-b', label: 'Review B', selection: { ...selection, model: 'review-model-b' }, transport: 'openai-compatible' },
    ];
    await act(async () => { root.render(<Settings config={{ ...DEFAULT_SKILL_LEARNING_CONFIG, reviewSelection: modelOptions[1].selection }} onChange={vi.fn()} modelOptions={modelOptions} />); });
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="复盘模型"]')!.value).toBe('model-b');
  });

  it('separates pin protection from the content lock when authorizing a managed skill', async () => {
    let complete!: (entry: SkillEntry) => void;
    const entry = skillEntry();
    const onPolicyChange = vi.fn(() => new Promise<SkillEntry>((resolve) => { complete = resolve; }));
    await act(async () => { root.render(<Settings config={DEFAULT_SKILL_LEARNING_CONFIG} onChange={vi.fn()} entries={[entry]} onPolicyChange={onPolicyChange} />); });
    const pinned = container.querySelector<HTMLInputElement>('input[aria-label="固定技能 review-patterns"]');
    const locked = container.querySelector<HTMLInputElement>('input[aria-label="锁定内容 review-patterns"]');
    const editable = container.querySelector<HTMLInputElement>('input[aria-label="允许自动编辑 review-patterns"]');
    expect(pinned?.checked).toBe(true);
    expect(locked?.checked).toBe(false);
    expect(editable?.checked).toBe(false);
    expect(editable?.disabled).toBe(false);
    expect(container.textContent).toContain('固定只防止自动归档，不禁止内容修补');
    await act(async () => { editable!.click(); });
    expect(onPolicyChange).toHaveBeenCalledExactlyOnceWith('skill-a', { autoEditable: true });
    expect(editable!.checked).toBe(false);
    expect(editable!.disabled).toBe(true);
    await act(async () => { complete({ ...entry, autoEditable: true }); });
    expect(editable!.checked).toBe(true);
    expect(pinned!.checked).toBe(true);
    expect(locked!.checked).toBe(false);
  });

  it('distinguishes same-name catalog entries by real scope, source and revision', async () => {
    const project = skillEntry({ revision: 'project-v2', source: 'Project-owned copy' });
    const global = skillEntry({ skillId: 'global-skill', rootId: 'ugs-global', scope: 'global', revision: 'global-v3', source: 'Global-owned copy' });
    await act(async () => { root.render(<Settings config={DEFAULT_SKILL_LEARNING_CONFIG} onChange={vi.fn()} entries={[project, global]} />); });
    const projectRow = container.querySelector('[data-skill-id="skill-a"]');
    const globalRow = container.querySelector('[data-skill-id="global-skill"]');
    expect(projectRow?.textContent).toContain('项目');
    expect(projectRow?.textContent).toContain('Project-owned copy');
    expect(projectRow?.textContent).toContain('project-v2');
    expect(globalRow?.textContent).toContain('全局');
    expect(globalRow?.textContent).toContain('Global-owned copy');
    expect(globalRow?.textContent).toContain('global-v3');
  });

  it('shows current catalog metadata after a same-id host revision update', async () => {
    const entry = skillEntry();
    const onPolicyChange = vi.fn(async () => ({ ...entry, autoEditable: true }));
    await act(async () => { root.render(<Settings config={DEFAULT_SKILL_LEARNING_CONFIG} onChange={vi.fn()} entries={[entry]} onPolicyChange={onPolicyChange} />); });
    await act(async () => { container.querySelector<HTMLInputElement>('input[aria-label="允许自动编辑 review-patterns"]')!.click(); });
    const updated = { ...entry, revision: 'v2', description: 'New host description', contentLocked: true };
    await act(async () => { root.render(<Settings config={DEFAULT_SKILL_LEARNING_CONFIG} onChange={vi.fn()} entries={[updated]} onPolicyChange={onPolicyChange} />); });
    expect(container.textContent).toContain('New host description');
    expect(container.querySelector<HTMLInputElement>('input[aria-label="锁定内容 review-patterns"]')!.checked).toBe(true);
    expect(container.querySelector<HTMLInputElement>('input[aria-label="允许自动编辑 review-patterns"]')!.disabled).toBe(true);
  });

  it('ignores a late permission result after a newer host catalog revision arrives', async () => {
    const entry = skillEntry();
    let complete!: (entry: SkillEntry) => void;
    const onPolicyChange = vi.fn(() => new Promise<SkillEntry>((resolve) => { complete = resolve; }));
    await act(async () => { root.render(<Settings config={DEFAULT_SKILL_LEARNING_CONFIG} onChange={vi.fn()} entries={[entry]} onPolicyChange={onPolicyChange} />); });
    await act(async () => { container.querySelector<HTMLInputElement>('input[aria-label="允许自动编辑 review-patterns"]')!.click(); });
    const updated = { ...entry, revision: 'v2', contentLocked: true, description: 'Current host revision' };
    await act(async () => { root.render(<Settings config={DEFAULT_SKILL_LEARNING_CONFIG} onChange={vi.fn()} entries={[updated]} onPolicyChange={onPolicyChange} />); });
    await act(async () => { complete({ ...entry, autoEditable: true }); });
    expect(container.textContent).toContain('Current host revision');
    expect(container.querySelector<HTMLInputElement>('input[aria-label="锁定内容 review-patterns"]')!.checked).toBe(true);
    expect(container.querySelector<HTMLInputElement>('input[aria-label="允许自动编辑 review-patterns"]')!.checked).toBe(false);
  });

  it('refuses a policy response for a different skill identity', async () => {
    const entry = skillEntry();
    const onPolicyChange = vi.fn(async () => ({ ...entry, skillId: 'wrong-skill', rootId: 'other-root', autoEditable: true }));
    await act(async () => { root.render(<Settings config={DEFAULT_SKILL_LEARNING_CONFIG} onChange={vi.fn()} entries={[entry]} onPolicyChange={onPolicyChange} />); });
    await act(async () => { container.querySelector<HTMLInputElement>('input[aria-label="允许自动编辑 review-patterns"]')!.click(); });
    expect(container.querySelector<HTMLInputElement>('input[aria-label="允许自动编辑 review-patterns"]')!.checked).toBe(false);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('技能来源不匹配');
  });

  it('leaves permission flags unchanged after a failed authorization request', async () => {
    const entry = skillEntry();
    const onPolicyChange = vi.fn().mockRejectedValue(new Error('授权写入失败'));
    await act(async () => { root.render(<Settings config={DEFAULT_SKILL_LEARNING_CONFIG} onChange={vi.fn()} entries={[entry]} onPolicyChange={onPolicyChange} />); });
    await act(async () => { container.querySelector<HTMLInputElement>('input[aria-label="允许自动编辑 review-patterns"]')!.click(); });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('授权写入失败');
    expect(container.querySelector<HTMLInputElement>('input[aria-label="允许自动编辑 review-patterns"]')!.checked).toBe(false);
  });

  it('disables editing controls for external roots and content-locked managed skills', async () => {
    const locked = skillEntry({ contentLocked: true });
    const external = skillEntry({ skillId: 'external-a', name: 'external-rules', scope: 'external', readOnly: true });
    await act(async () => { root.render(<Settings config={DEFAULT_SKILL_LEARNING_CONFIG} onChange={vi.fn()} entries={[locked, external]} onPolicyChange={vi.fn()} />); });
    expect(container.querySelector<HTMLInputElement>('input[aria-label="允许自动编辑 review-patterns"]')!.disabled).toBe(true);
    for (const input of container.querySelectorAll<HTMLInputElement>('input[aria-label$="external-rules"]')) {
      expect(input.disabled).toBe(true);
    }
  });

  it('waits for the host before archiving a whole skill package', async () => {
    const entry = skillEntry({ files: ['SKILL.md', 'references/checks.md'] });
    let complete!: (entry: SkillEntry) => void;
    const onArchive = vi.fn(() => new Promise<SkillEntry>((resolve) => { complete = resolve; }));
    await act(async () => { root.render(<Settings config={DEFAULT_SKILL_LEARNING_CONFIG} onChange={vi.fn()} entries={[entry]} onArchive={onArchive} />); });
    const archive = container.querySelector<HTMLButtonElement>('button[aria-label="归档技能 review-patterns"]');
    expect(archive).not.toBeNull();
    archive!.focus();
    expect(document.activeElement).toBe(archive);
    await act(async () => { archive!.click(); archive!.click(); });
    expect(onArchive).toHaveBeenCalledExactlyOnceWith('skill-a');
    expect(archive!.disabled).toBe(true);
    expect(container.querySelector('[data-skill-id="skill-a"] [role="status"]')?.textContent).toContain('正在归档');
    await act(async () => { complete({ ...entry, state: 'archived', revision: 'archived-v1' }); });
    expect(container.querySelector('[data-skill-id="skill-a"] [role="status"]')?.textContent).toContain('已归档');
    expect(container.querySelector('button[aria-label="归档技能 review-patterns"]')).toBeNull();
  });

  it('keeps an archived package recoverable after a failed restore and permits retry', async () => {
    const entry = skillEntry({ state: 'archived', files: ['SKILL.md', 'references/checks.md'] });
    const onRestore = vi.fn().mockRejectedValueOnce(new Error('恢复失败：文件被占用'))
      .mockResolvedValueOnce({ ...entry, state: 'active', revision: 'restored-v1' });
    await act(async () => { root.render(<Settings config={DEFAULT_SKILL_LEARNING_CONFIG} onChange={vi.fn()} entries={[entry]} onRestore={onRestore} />); });
    const restore = container.querySelector<HTMLButtonElement>('button[aria-label="恢复技能 review-patterns"]');
    expect(restore).not.toBeNull();
    await act(async () => { restore!.click(); });
    expect(container.querySelector('[data-skill-id="skill-a"] [role="alert"]')?.textContent).toContain('恢复失败：文件被占用');
    expect(container.querySelector('[data-skill-id="skill-a"] [role="status"]')?.textContent).toContain('已归档');
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="恢复技能 review-patterns"]')?.disabled).toBe(false);
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="恢复技能 review-patterns"]')!.click(); });
    expect(onRestore).toHaveBeenNthCalledWith(2, 'skill-a');
    expect(container.querySelector('[data-skill-id="skill-a"] [role="status"]')?.textContent).toContain('活跃');
    expect(container.querySelector('[data-skill-id="skill-a"] [role="alert"]')).toBeNull();
    expect(container.querySelector('button[aria-label="恢复技能 review-patterns"]')).toBeNull();
  });

  it('keeps frozen approval history available in off mode and displays host write failures on the original card', async () => {
    const pending: SkillMutationResult = {
      status: 'awaiting_approval', batchId: 'batch-old-project',
      origin: { hostId: 'local', workspaceId: 'source-project', sessionId: 'old-session', turnId: 'old-turn', runId: 'old-run' },
      lesson: '先验证再汇报', operationsApplied: 0,
      changes: [{ skillId: 'skill-a', name: 'verify-first', filePath: 'SKILL.md', before: 'before', after: 'after', beforeHash: 'old', afterHash: 'new' }],
      riskReasons: ['需要人工批准'],
    };
    const onApprove = vi.fn(async () => ({ ...pending, status: 'failed' as const, error: '原项目落盘失败' }));
    await act(async () => { root.render(<Settings config={{ ...DEFAULT_SKILL_LEARNING_CONFIG, enabled: false, mode: 'off' }} onChange={vi.fn()} history={[pending]} onApprove={onApprove} />); });
    expect(container.textContent).toContain('学习历史与审批');
    expect(container.textContent).toContain('source-project');
    expect(container.querySelector('details')?.textContent).toContain('before');
    const approve = container.querySelector<HTMLButtonElement>('button[aria-label="批准修改"]');
    expect(approve).not.toBeNull();
    await act(async () => { approve!.click(); });
    expect(onApprove).toHaveBeenCalledExactlyOnceWith('batch-old-project');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('原项目落盘失败');
    expect(container.textContent).toContain('学习失败');
    expect(container.textContent).not.toContain('经验已保存');
  });

  it('forwards fresh review retries from conflicted history without approving the stale batch', async () => {
    const result: SkillMutationResult = {
      status: 'conflicted', batchId: 'conflicted-history',
      origin: { hostId: 'local', workspaceId: 'source-project', sessionId: 's', turnId: 't', runId: 'r' },
      lesson: '重新读取后修补', operationsApplied: 0, changes: [], riskReasons: [], error: '版本已变化',
    };
    const onRetry = vi.fn(async () => ({ ...result, status: 'awaiting_approval' as const, batchId: 'fresh-history', error: undefined }));
    await act(async () => { root.render(<Settings config={DEFAULT_SKILL_LEARNING_CONFIG} onChange={vi.fn()} history={[result]} onRetry={onRetry} />); });
    const retry = container.querySelector<HTMLButtonElement>('button[aria-label="重新复盘"]');
    expect(retry).not.toBeNull();
    await act(async () => { retry!.click(); });
    expect(onRetry).toHaveBeenCalledExactlyOnceWith('conflicted-history');
    expect(container.querySelector('[role="status"]')?.textContent).toContain('待批准');
    expect(container.textContent).not.toContain('经验已保存');
  });

  it('retains rollback action when rendering rehydrated review states in history', async () => {
    const result: SkillMutationResult = {
      status: 'applied', batchId: 'rollback-history',
      origin: { hostId: 'local', workspaceId: 'source-project', sessionId: 's', turnId: 't', runId: 'r' },
      lesson: '恢复旧版本', operationsApplied: 1, changes: [], riskReasons: [], revision: 'restored-v1',
    };
    const history = JSON.parse(JSON.stringify([{ status: 'applied', origin: result.origin, result, action: 'rollback' }]));
    await act(async () => { root.render(<Settings config={DEFAULT_SKILL_LEARNING_CONFIG} onChange={vi.fn()} history={history} />); });
    expect(container.querySelector('[role="status"]')?.textContent).toContain('已撤销');
    expect(container.textContent).not.toContain('经验已保存');
    expect(container.textContent).toContain('restored-v1');
  });
});
