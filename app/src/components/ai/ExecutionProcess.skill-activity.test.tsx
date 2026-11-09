import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import MessageContent from './MessageContent';
import { encodeToolPatch } from './lib/toolEvent';
import { useStore } from '@/store/useStore';

it('shows a named skill only after an actual successful skill invocation or read', async () => {
  useStore.setState({ locale: 'zh-CN' });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = async (text: string) => {
    await act(async () => { root.render(<MessageContent text={text} streaming />); });
    return container.querySelector('[data-ugs-skill-activity]')?.textContent ?? '';
  };
  const invocation = { id: 'skill-1', name: 'Skill', args: { skill: 'diagnose' }, provenance: 'native-tool' as const };
  const started = encodeToolPatch({ ...invocation, status: 'running' });
  try {
    expect(await render(started)).toBe('');
    expect(await render(started + encodeToolPatch({ id: 'skill-1', status: 'error', evidenceStatus: 'error' }))).toBe('');
    const complete = started + encodeToolPatch({ id: 'skill-1', status: 'done', evidenceStatus: 'success', provenance: 'native-tool' });
    expect(await render(complete)).toBe('使用技能：diagnose');
    const read = encodeToolPatch({ id: 'skill-2', name: 'Read', args: { file_path: 'C:\\Users\\u\\.codex\\skills\\imagegen\\SKILL.md' }, status: 'done', evidenceStatus: 'success', provenance: 'native-tool' });
    expect(await render(read)).toBe('读取技能：imagegen');
    const command = encodeToolPatch({ id: 'skill-3', name: 'commandExecution', args: { command: `"C:\\Program Files\\PowerShell\\pwsh.exe" -Command "Get-Content -Raw 'C:\\Users\\u\\.agents\\skills\\diagnose\\SKILL.md'"` }, status: 'done', evidenceStatus: 'success', provenance: 'native-tool' });
    expect(await render(command)).toBe('读取技能：diagnose');
    const search = encodeToolPatch({ id: 'search', name: 'commandExecution', args: { command: 'rg -n SKILL.md app/src' }, status: 'done', evidenceStatus: 'success', provenance: 'native-tool' });
    expect(await render(search)).toBe('');
    const view = encodeToolPatch({ id: 'view', name: 'mcp__ugs_skills__skill_view', args: { skillId: 'opaque-id' }, result: JSON.stringify({ entry: { name: 'documents' } }), status: 'done', evidenceStatus: 'success', provenance: 'native-tool' });
    expect(await render(view)).toBe('读取技能：documents');
    const fake = encodeToolPatch({ ...invocation, status: 'done', evidenceStatus: 'success', provenance: 'ui-synthetic' });
    expect(await render(fake)).toBe('');
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});
