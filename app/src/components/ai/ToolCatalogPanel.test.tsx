import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolCatalogPanel } from './ToolCatalogPanel';
import { catalogScope, describeCapabilities, projectCatalog } from '@/lib/tools/catalog';
import type { ToolCatalogPort, ToolCatalogSnapshot } from '@/lib/tools/types';

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
afterEach(async () => { if (root) await act(async () => root.unmount()); container?.remove(); });
const scope = catalogScope('w', 'a', { adapter: 'codex' });
function snapshot(sessionId: string, name: string): ToolCatalogSnapshot {
  const value = projectCatalog({ ...scope, sessionId }, [{ id: 's', label: 's', source: 'custom', enabled: true, transport: 'stdio', args: [], env: {},
    lastProbe: { serverId: 's', ok: true, status: 'connected', message: '测试发现', checkedAtMs: 1, catalogCoverage: 'full', tools: [{ name, inputSchema: { type: 'object' } }] } }], true);
  return value;
}
describe('tool catalog panel', () => {
  it('renders real schema and cache status without permission switches', async () => {
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    await act(async () => root.render(<ToolCatalogPanel scope={scope} snapshot={snapshot('a', 'lookup')} mode="project" />));
    expect(container.textContent).toContain('仅上次发现');
    expect(container.textContent).toContain('未验证当前连接');
    expect(container.textContent).toContain('暴露方式未知');
    expect(container.querySelector('pre')?.textContent).toContain('object');
    expect(container.querySelector('input[type=checkbox]')).toBeNull();
  });
  it('drops an old pending response after switching sessions', async () => {
    let resolveA!: (s: ToolCatalogSnapshot) => void;
    const listCatalog = vi.fn().mockImplementationOnce(() => new Promise(r => { resolveA = r; })).mockResolvedValueOnce(snapshot('b', 'b_tool'));
    const port: ToolCatalogPort = { describeCapabilities, listCatalog };
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    await act(async () => root.render(<ToolCatalogPanel scope={scope} port={port} />));
    await act(async () => root.render(<ToolCatalogPanel scope={{ ...scope, sessionId: 'b' }} port={port} />));
    await act(async () => resolveA(snapshot('a', 'a_tool')));
    expect(container.textContent).toContain('b_tool');
    expect(container.textContent).not.toContain('a_tool');
  });
});
