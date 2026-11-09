import { expect, it } from 'vitest';
import { encodeToolPatch } from '@/components/ai/lib/toolEvent';
import { stripEphemeralToolEvents } from './ephemeralToolEvents';

it('removes runtime status updates while preserving prose and persistent tool events', () => {
  const temporary = encodeToolPatch({ id: 'heartbeat', name: '运行状态', ephemeral: true });
  const durable = encodeToolPatch({ id: 'tool', name: 'read', status: 'done', result: '完整结果' });
  const text = `前文${temporary}中间${durable}后文${temporary}未闭合 <<UGS_TOOL>>{"ephemeral":true`;
  expect(stripEphemeralToolEvents(text)).toBe(`前文\n\n中间${durable}后文\n\n未闭合 <<UGS_TOOL>>{"ephemeral":true`);
});
