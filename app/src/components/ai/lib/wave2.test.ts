import { describe, expect, it } from 'vitest';
import {
  encodeToolPatch,
  extractToolSentinels,
  mergeToolPatches,
  hasToolSentinel,
} from './toolEvent';
import { segmentMessage } from './segmenter';
import { normalizeMath } from './normalizeMath';
import { detectCallout, stripCalloutMarker } from './callout';
import { toolCategory, toolIconName } from './toolMeta';

describe('toolEvent sentinel codec', () => {
  it('round-trips a patch through encode/extract', () => {
    const block = encodeToolPatch({ id: 'a', name: 'Bash', status: 'running' });
    expect(hasToolSentinel(block)).toBe(true);
    const { text, patches } = extractToolSentinels(`before${block}after`);
    expect(text.replace(/\s/g, '')).toBe('beforeafter');
    expect(patches).toEqual([{ id: 'a', name: 'Bash', status: 'running' }]);
  });

  it('leaves an incomplete trailing sentinel in place', () => {
    const partial = 'text <<FUC_TOOL>>{"id":"x"';
    const { text, patches } = extractToolSentinels(partial);
    expect(patches).toEqual([]);
    expect(text).toContain('<<FUC_TOOL>>');
  });

  it('keeps a literal FUC_TOOL marker in prose instead of dropping it', () => {
    // The model wrote the token itself (e.g. explaining the protocol). Its body
    // isn't a valid patch, so it must survive as prose rather than be dropped.
    const { text, patches } = extractToolSentinels(
      '<<FUC_TOOL>>not json<<FUC_TOOL_END>>',
    );
    expect(patches).toEqual([]);
    expect(text).toContain('<<FUC_TOOL>>');
  });

  it('does not swallow real sentinels after a literal marker in prose', () => {
    // Regression: a literal `<<FUC_TOOL>>` written in the answer used to pair
    // with a genuine sentinel's `<<FUC_TOOL_END>>` downstream, treating the
    // whole span as one unparseable block — which JSON.parse dropped, silently
    // truncating the rendered message at the literal marker.
    const real = encodeToolPatch({ id: 'a', name: 'Bash', status: 'done' });
    const text = `prose mentioning <<FUC_TOOL>> then more prose${real}tail`;
    const { text: out, patches } = extractToolSentinels(text);
    expect(patches).toEqual([{ id: 'a', name: 'Bash', status: 'done' }]);
    expect(out).toContain('<<FUC_TOOL>>');
    expect(out).toContain('then more prose');
    expect(out).toContain('tail');
  });

  it('round-trips a result that contains the literal sentinel markers', () => {
    // Reading a file whose source mentions <<FUC_TOOL>> / <<FUC_TOOL_END>> must
    // not let those markers prematurely close the block and leak as prose.
    const result =
      'const OPEN = "<<FUC_TOOL>>";\nconst CLOSE = "<<FUC_TOOL_END>>";\n';
    const block = encodeToolPatch({ id: 'r', name: 'Read', status: 'done', result });
    const { text, patches } = extractToolSentinels(`before${block}after`);
    expect(text.replace(/\s/g, '')).toBe('beforeafter');
    expect(patches).toEqual([{ id: 'r', name: 'Read', status: 'done', result }]);
  });

  it('keeps a subject with sentinel markers from leaking', () => {
    const block = encodeToolPatch({
      id: 's',
      name: 'Grep',
      status: 'running',
      subject: '<<FUC_TOOL_END>>',
    });
    const { patches } = extractToolSentinels(block);
    expect(patches).toEqual([
      { id: 's', name: 'Grep', status: 'running', subject: '<<FUC_TOOL_END>>' },
    ]);
  });

  it('merges a running + done patch into one event by id', () => {
    const merged = mergeToolPatches([
      { id: 'a', name: 'Read', status: 'running', subject: 'x.ts' },
      { id: 'a', status: 'done', durationMs: 120, result: 'ok' },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      id: 'a',
      name: 'Read',
      status: 'done',
      durationMs: 120,
      result: 'ok',
      subject: 'x.ts',
    });
  });

  it('preserves first-seen order across ids', () => {
    const merged = mergeToolPatches([
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
      { id: 'a', status: 'done' },
    ]);
    expect(merged.map((e) => e.id)).toEqual(['a', 'b']);
  });
});

describe('segmentMessage tool segments', () => {
  it('splits a tool sentinel into a tools segment in order', () => {
    const text =
      'before' +
      encodeToolPatch({ id: 'a', name: 'Bash', status: 'running' }) +
      encodeToolPatch({ id: 'a', status: 'done', durationMs: 5 }) +
      'after';
    const segs = segmentMessage(text);
    expect(segs.map((s) => s.type)).toEqual(['answer', 'tools', 'answer']);
    const tools = segs.find((s) => s.type === 'tools');
    if (tools && tools.type === 'tools') {
      expect(tools.events).toHaveLength(1);
      expect(tools.events[0]).toMatchObject({ id: 'a', status: 'done', durationMs: 5 });
    }
  });

  it('interleaves reasoning, tools, and answer', () => {
    const text =
      '<think>plan</think>' +
      'doing' +
      encodeToolPatch({ id: 't1', name: 'Read', status: 'done' });
    const segs = segmentMessage(text);
    expect(segs.map((s) => s.type)).toEqual(['reasoning', 'answer', 'tools']);
  });

  it('renders a single card when prose sits between running and done', () => {
    const text =
      'start' +
      encodeToolPatch({ id: 'x', name: 'Bash', status: 'running' }) +
      'thinking about it' +
      encodeToolPatch({ id: 'x', status: 'done', durationMs: 9 }) +
      'finished';
    const segs = segmentMessage(text);
    // Exactly one tools segment with one event (no duplicate card).
    const toolsSegs = segs.filter((s) => s.type === 'tools');
    expect(toolsSegs).toHaveLength(1);
    if (toolsSegs[0].type === 'tools') {
      expect(toolsSegs[0].events).toHaveLength(1);
      expect(toolsSegs[0].events[0]).toMatchObject({ id: 'x', status: 'done', durationMs: 9 });
    }
  });

  it('renders a single card when reasoning sits between running and done', () => {
    const text =
      encodeToolPatch({ id: 'y', name: 'Bash', status: 'running' }) +
      '<think>analysing</think>' +
      encodeToolPatch({ id: 'y', status: 'done' });
    const segs = segmentMessage(text);
    expect(segs.filter((s) => s.type === 'tools')).toHaveLength(1);
  });

  it('keeps a done status when a late running patch arrives (monotonic)', () => {
    const merged = mergeToolPatches([
      { id: 'a', name: 'X', status: 'done', durationMs: 5 },
      { id: 'a', status: 'running' },
    ]);
    expect(merged[0].status).toBe('done');
  });

  it('leaves plain text untouched (no tools)', () => {
    expect(segmentMessage('just prose')).toEqual([{ type: 'answer', text: 'just prose' }]);
  });

  it('does not leak prose when a tool result embeds sentinel markers', () => {
    // Mirrors the real bug: reading a source file that contains the literal
    // <<FUC_TOOL>> / <<FUC_TOOL_END>> strings used to truncate the JSON payload
    // and spill the file body into the answer with escaped \n / \t.
    const result =
      'export const TOOL_OPEN = "<<FUC_TOOL>>";\n' +
      'export const TOOL_CLOSE = "<<FUC_TOOL_END>>";\n';
    const text =
      'Let me read the file.' +
      encodeToolPatch({ id: 'a', name: 'Read', status: 'running', subject: 'toolEvent.ts' }) +
      encodeToolPatch({ id: 'a', status: 'done', durationMs: 12, result }) +
      'Here is what I found.';
    const segs = segmentMessage(text);
    expect(segs.map((s) => s.type)).toEqual(['answer', 'tools', 'answer']);
    const tools = segs.find((s) => s.type === 'tools');
    expect(tools && tools.type === 'tools' && tools.events[0].result).toBe(result);
    // No raw sentinel marker or escaped file body bleeds into the answers.
    for (const s of segs) {
      if (s.type === 'answer') {
        expect(s.text).not.toContain('FUC_TOOL');
        expect(s.text).not.toContain('TOOL_OPEN');
      }
    }
  });
});

describe('normalizeMath', () => {
  it('rewrites \\( \\) to $ $', () => {
    expect(normalizeMath('a \\(x+1\\) b')).toBe('a $x+1$ b');
  });
  it('rewrites \\[ \\] to $$ $$', () => {
    expect(normalizeMath('\\[E=mc^2\\]')).toBe('$$E=mc^2$$');
  });
  it('leaves text without latex delimiters untouched', () => {
    expect(normalizeMath('no math here')).toBe('no math here');
  });
  it('escapes bare currency dollars so single-$ math does not eat prose', () => {
    expect(normalizeMath('I have $5 and $10 left')).toBe(
      'I have \\$5 and \\$10 left',
    );
  });
  it('does not escape a $ that is not followed by a digit', () => {
    expect(normalizeMath('cost is $x dollars')).toBe('cost is $x dollars');
  });
  it('does not rewrite inside inline code', () => {
    expect(normalizeMath('`\\(x\\)`')).toBe('`\\(x\\)`');
  });
});

describe('callout detection', () => {
  it('detects [!NOTE]', () => {
    expect(detectCallout('[!NOTE] hello')).toBe('note');
    expect(detectCallout('[!warning] x')).toBe('warning');
    expect(detectCallout('just text')).toBeNull();
  });
  it('strips the marker', () => {
    expect(stripCalloutMarker('[!TIP] body')).toBe('body');
  });
});

describe('toolMeta', () => {
  it('categorises common tools', () => {
    expect(toolCategory('edit_file')).toBe('write');
    expect(toolCategory('read_file')).toBe('read');
    expect(toolCategory('Bash')).toBe('exec');
    expect(toolCategory('grep')).toBe('search');
    expect(toolCategory('command_execution')).toBe('exec');
    expect(toolCategory('file_change')).toBe('write');
    expect(toolCategory('free_proxy')).toBe('web');
    expect(toolCategory('mystery')).toBe('other');
  });
  it('maps to icons', () => {
    expect(toolIconName('Bash')).toBe('SquareTerminal');
    expect(toolIconName('free_proxy')).toBe('Globe');
    expect(toolIconName('unknown')).toBe('Wrench');
  });
});
