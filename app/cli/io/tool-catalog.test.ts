// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureToolCatalog } from './tool-catalog';
import { catalogScope } from '../../src/lib/tools/catalog';
import { readToolCatalog } from '../commands/tools';

describe('Node native catalogue capture', () => {
  it('writes authentic init/observed evidence; a finished old run cannot overwrite a new run', () => {
    const home = mkdtempSync(join(tmpdir(), 'ugs-native-tools-'));
    try {
      const scope = catalogScope('w', 's', { adapter: 'claude-code', providerId: 'p', channelId: 'c', modelClass: 'sonnet' });
      const env = { UGS_HOME: home, UGS_TOOL_CATALOG_SCOPE: JSON.stringify(scope) };
      const first = captureToolCatalog(env, 'claude-code', 'sonnet', 'one')!;
      first.init({ type: 'system', subtype: 'init', tools: ['Read', 'Bash'] });
      first.observe({ toolName: 'Read', phase: 'end' });
      expect(readToolCatalog(scope, home)?.tools).toHaveLength(2);
      expect(readToolCatalog(scope, home)?.tools[0].inputSchema).toBeUndefined();
      expect(readToolCatalog(scope, home)?.tools[0].permission).toBe('agent-managed');
      const second = captureToolCatalog(env, 'claude-code', 'sonnet', 'two')!;
      first.finish();
      expect(readToolCatalog(scope, home)?.runId).toBe('two');
      second.observe({ toolName: 'lookup', phase: 'begin' }); second.finish();
      expect(readToolCatalog(scope, home)?.tools[0].discovery).toBe('observed');
      expect(readToolCatalog({ ...scope, channelId: 'other' }, home)).toBeNull();
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
