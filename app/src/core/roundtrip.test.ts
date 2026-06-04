import { describe, expect, it } from 'vitest';

import { roundtrip, roundtripAll } from './roundtrip';
import { roundtripFixtures } from './fixtures';

/**
 * Suite-wide round-trip guard. Previously the per-fixture round-trip behaviour
 * was only exercised piecemeal by feature-specific tests (composite, consensus,
 * captainBlueprint) and via the dev-console `roundtripAll()` — which no test
 * actually ran. That gap let an emitter change silently break the F2 pipeline
 * fixture. This pins EVERY fixture (F1–F9) so any future emitter/parser change
 * that regresses round-trip for any node kind fails CI immediately.
 */
describe('roundtrip suite (all fixtures)', () => {
  it.each(roundtripFixtures.map((f) => [f.name, f.ir] as const))(
    'preserves structure and is idempotent: %s',
    (_name, ir) => {
      const r = roundtrip(ir);
      expect(r.diffs).toEqual([]);
      expect(r.ok).toBe(true);
      expect(r.idempotent).toBe(true);
    },
  );

  it('roundtripAll() reports all fixtures ok', () => {
    const suite = roundtripAll();
    const failed = suite.results.filter((x) => !x.ok || !x.idempotent);
    expect(failed.map((f) => f.name)).toEqual([]);
    expect(suite.ok).toBe(true);
  });
});
