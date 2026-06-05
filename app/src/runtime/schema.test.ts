/**
 * Tests for the runtime schema-enforcement module + its integration into
 * `runAgentWithInteraction`. These import ONLY `@/runtime` (no store / React /
 * Tauri) — proving the schema behaviour is part of the pure run engine.
 *
 * Covers: JSON extraction (fenced / inline / none), JSON-Schema-lite and
 * example-object validation, the schema instruction text, shape resolution, and
 * an integration test where a fake gateway returns illegal JSON first then legal
 * JSON, asserting exactly one schema retry + a normalized final result.
 */
import { describe, expect, it } from 'vitest';
import {
  describeSchema,
  extractJson,
  resolveSchemaShape,
  validateAgainstSchema,
  runAgentWithInteraction,
  type RunCallbacks,
  type RunContext,
  type RunGateway,
  type SpawnCliAgentOpts,
} from '@/runtime';
import { personalInstructionsKey } from '@/core/personalInstructions';

/* ------------------------------------------------------------------ extractJson */

describe('extractJson', () => {
  it('extracts a fenced ```json block', () => {
    const text = '这是结果：\n```json\n{ "a": 1, "b": "x" }\n```\n完。';
    const out = extractJson(text);
    expect(out).not.toBeNull();
    expect(out!.value).toEqual({ a: 1, b: 'x' });
    expect(JSON.parse(out!.json)).toEqual({ a: 1, b: 'x' });
  });

  it('extracts an inline balanced {…} span', () => {
    const text = '前言 {"ok": true, "n": 2} 后语';
    const out = extractJson(text);
    expect(out).not.toBeNull();
    expect(out!.value).toEqual({ ok: true, n: 2 });
  });

  it('returns null when there is no JSON', () => {
    expect(extractJson('就是一段普通的中文说明，没有任何 JSON。')).toBeNull();
  });
});

/* ----------------------------------------------------- validateAgainstSchema */

describe('validateAgainstSchema (JSON-Schema style)', () => {
  const schema = {
    type: 'object',
    required: ['name', 'count'],
    properties: {
      name: { type: 'string' },
      count: { type: 'number' },
      mode: { type: 'string', enum: ['a', 'b'] },
    },
  };

  it('passes a fully valid object', () => {
    const r = validateAgainstSchema({ name: 'x', count: 3, mode: 'a' }, schema);
    expect(r.ok).toBe(true);
    expect(r.problems).toEqual([]);
  });

  it('fails when a required field is missing', () => {
    const r = validateAgainstSchema({ name: 'x' }, schema);
    expect(r.ok).toBe(false);
    expect(r.problems.some((p) => p.includes('count'))).toBe(true);
  });

  it('fails on a wrong field type', () => {
    const r = validateAgainstSchema({ name: 'x', count: 'not-a-number' }, schema);
    expect(r.ok).toBe(false);
    expect(r.problems.some((p) => p.includes('count'))).toBe(true);
  });

  it('fails on an out-of-enum value', () => {
    const r = validateAgainstSchema({ name: 'x', count: 1, mode: 'z' }, schema);
    expect(r.ok).toBe(false);
  });
});

describe('validateAgainstSchema (example-object style)', () => {
  const example = { real: true, confidence: 0, tags: ['x'] };

  it('passes an object with all example keys + compatible types', () => {
    const r = validateAgainstSchema(
      { real: false, confidence: 0.9, tags: ['a', 'b'] },
      example,
    );
    expect(r.ok).toBe(true);
  });

  it('fails when a key from the example is missing', () => {
    const r = validateAgainstSchema({ real: true, confidence: 1 }, example);
    expect(r.ok).toBe(false);
    expect(r.problems.some((p) => p.includes('tags'))).toBe(true);
  });

  it('allows any value when shape is undefined', () => {
    expect(validateAgainstSchema('anything', undefined)).toEqual({
      ok: true,
      problems: [],
    });
  });
});

/* --------------------------------------------------- describeSchema / resolve */

describe('describeSchema', () => {
  it('embeds the schema source verbatim', () => {
    const source = '{ real: true, confidence: 0 }';
    const out = describeSchema('VERDICT', source);
    expect(out).toContain('VERDICT');
    expect(out).toContain(source);
  });
});

describe('resolveSchemaShape', () => {
  it('resolves a literal source into a JS value', () => {
    const r = resolveSchemaShape('VERDICT', {
      schemaDefs: { VERDICT: '{ real: true, confidence: 0 }' },
    });
    expect(r).toBeDefined();
    expect(r!.name).toBe('VERDICT');
    expect(r!.source).toBe('{ real: true, confidence: 0 }');
    expect(r!.shape).toEqual({ real: true, confidence: 0 });
  });

  it('returns undefined when there is no schemaDefs entry', () => {
    expect(resolveSchemaShape('VERDICT', undefined)).toBeUndefined();
    expect(resolveSchemaShape('VERDICT', { schemaDefs: {} })).toBeUndefined();
  });

  it('returns the source but undefined shape for non-literal sources', () => {
    const r = resolveSchemaShape('X', { schemaDefs: { X: 'someFn()' } });
    expect(r).toBeDefined();
    expect(r!.shape).toBeUndefined();
    expect(r!.source).toBe('someFn()');
  });
});

/* --------------------------------------------------------- integration: retry */

/** A fake gateway that always spawns the CLI and runs `respond`. */
function fakeGateway(
  respond: (prompt: string, opts: SpawnCliAgentOpts) => Promise<string>,
): RunGateway {
  return {
    resolveDirectRoute: () => null,
    resolveCliRoute: async () => ({ adapter: 'claude-code', cliCommand: 'claude' }),
    completeText: async () => ({ text: '', adapter: 'claude-code' }),
    spawnCliAgent: (prompt, _adapter, opts) => respond(prompt, opts),
    applyOverride: (s) => s,
    recordCall: () => {},
    timeoutPolicy: () => ({ timeoutSeconds: 600, idleTimeoutSeconds: 180 }),
    effectiveConcurrency: (n) => n,
    effectiveConsensusSamples: (n) => n,
    nodeGatewayOverride: () => undefined,
    modelClassFromModelId: () => 'sonnet',
  };
}

function fakeCallbacks(log: string[]): RunCallbacks {
  return {
    onNodeStart: () => {},
    onNodeSuccess: () => {},
    onNodeFailure: () => {},
    onLog: (text) => log.push(text),
    beginStream: () => ({ append: () => {}, finalize: () => {}, fail: () => {} }),
    isCancelled: () => false,
    promptInteraction: async () => null,
  };
}

function fakeCtx(gateway: RunGateway): RunContext {
  return {
    selection: { adapter: 'claude-code', modelClass: 'sonnet' },
    concurrency: 4,
    maxRetries: 2,
    consensusSamples: 3,
    gateway,
  };
}

describe('runAgentWithInteraction + schema enforcement', () => {
  it('injects personal instructions into the executed prompt', async () => {
    let seenPrompt = '';
    const gw = fakeGateway(async (prompt) => {
      seenPrompt = prompt;
      return 'ok';
    });

    await runAgentWithInteraction({
      context: {
        ...fakeCtx(gw),
        personalInstructions: '# Personal Defaults\n\n- 默认使用中文',
      },
      callbacks: fakeCallbacks([]),
      head: '【test】\n',
      label: 'test',
      basePrompt: 'do it',
      selection: { adapter: 'claude-code', modelClass: 'sonnet' },
      cli: {},
    });

    expect(seenPrompt).toContain('【用户个人默认指令（低优先级）】');
    expect(seenPrompt).toContain('- 默认使用中文');
  });

  it('skips app personal instructions for the Codex adapter', async () => {
    let seenPrompt = '';
    const gw = fakeGateway(async (prompt) => {
      seenPrompt = prompt;
      return 'ok';
    });

    await runAgentWithInteraction({
      context: {
        ...fakeCtx(gw),
        selection: { adapter: 'codex', modelClass: 'default' },
        personalInstructions: '# Personal Defaults\n\n- 默认使用中文',
      },
      callbacks: fakeCallbacks([]),
      head: '【test】\n',
      label: 'test',
      basePrompt: 'do it',
      selection: { adapter: 'codex', modelClass: 'default' },
      cli: {},
    });

    expect(seenPrompt).not.toContain('【用户个人默认指令（低优先级）】');
    expect(seenPrompt).not.toContain('- 默认使用中文');
  });

  it('selects personal instructions by the executed model selection', async () => {
    let seenPrompt = '';
    const gw = fakeGateway(async (prompt) => {
      seenPrompt = prompt;
      return 'ok';
    });
    const claudeSelection = { adapter: 'claude-code', modelClass: 'sonnet' };
    const geminiSelection = { adapter: 'gemini', modelClass: 'default' };

    await runAgentWithInteraction({
      context: {
        ...fakeCtx(gw),
        personalInstructionsByModel: {
          [personalInstructionsKey(claudeSelection)]: 'Claude-only defaults',
          [personalInstructionsKey(geminiSelection)]: 'Gemini-only defaults',
        },
      },
      callbacks: fakeCallbacks([]),
      head: '【test】\n',
      label: 'test',
      basePrompt: 'do it',
      selection: geminiSelection,
      cli: {},
    });

    expect(seenPrompt).toContain('Gemini-only defaults');
    expect(seenPrompt).not.toContain('Claude-only defaults');
  });

  it('retries once on invalid JSON then returns normalized JSON', async () => {
    const shape = { name: '', count: 0 };
    let calls = 0;
    const gw = fakeGateway(async () => {
      calls += 1;
      // First attempt: missing the required `count` key.
      if (calls === 1) return '```json\n{ "name": "x" }\n```';
      // Second attempt: a valid (if messy) object.
      return '好的，这是结果：\n```json\n{ "name": "y", "count": 5 }\n```';
    });
    const log: string[] = [];

    const result = await runAgentWithInteraction({
      context: fakeCtx(gw),
      callbacks: fakeCallbacks(log),
      head: '【test】\n',
      label: 'test',
      basePrompt: 'do it',
      selection: { adapter: 'claude-code', modelClass: 'sonnet' },
      cli: {},
      schema: {
        instruction: describeSchema('SHAPE', JSON.stringify(shape)),
        validate: (text) => {
          const extracted = extractJson(text);
          if (!extracted) return { ok: false, problems: ['未在输出中找到 JSON'] };
          const { ok, problems } = validateAgainstSchema(extracted.value, shape);
          return { ok, problems, normalized: extracted.json };
        },
      },
    });

    // Exactly one schema retry occurred (two total model calls).
    expect(calls).toBe(2);
    // The final result is the normalized JSON from the second, valid output.
    expect(JSON.parse(result)).toEqual({ name: 'y', count: 5 });
  });
});
