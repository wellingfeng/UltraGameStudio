import { describe, expect, it } from 'vitest';

import { CAPTAIN_LOOP_GUIDANCE, UNIFIED_SYSTEM } from './anthropic';

/**
 * Captain-loop guidance — the generation-layer accuracy lever. These tests pin
 * that the guidance is present, names the concrete primitives the model must
 * emit, and is actually wired into the unified system prompt (a guidance string
 * defined but never injected would silently do nothing).
 */
describe('CAPTAIN_LOOP_GUIDANCE', () => {
  it('names the captain-loop primitives', () => {
    expect(CAPTAIN_LOOP_GUIDANCE).toContain('TASK_LEDGER');
    expect(CAPTAIN_LOOP_GUIDANCE).toContain('VERDICT');
    expect(CAPTAIN_LOOP_GUIDANCE).toContain('adversarial');
    expect(CAPTAIN_LOOP_GUIDANCE).toContain('workflow-manager');
    expect(CAPTAIN_LOOP_GUIDANCE).toContain('队长闭环');
  });

  it('scopes when to use it (complex) and when not (simple)', () => {
    // Mentions the gating signal and the "don't over-apply" guard.
    expect(CAPTAIN_LOOP_GUIDANCE).toMatch(/复杂|可拆|高风险/);
    expect(CAPTAIN_LOOP_GUIDANCE).toMatch(/简单|单步|低风险/);
  });

  it('is injected into UNIFIED_SYSTEM', () => {
    expect(UNIFIED_SYSTEM).toContain(CAPTAIN_LOOP_GUIDANCE);
  });
});
