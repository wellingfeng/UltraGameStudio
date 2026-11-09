import { afterEach, describe, expect, it, vi } from 'vitest';
import { characterEntities } from 'character-entities';

afterEach(() => vi.unstubAllGlobals());
describe('reference worker non-DOM named entity compatibility', () => {
  it('matches the authoritative package entity table for every known name and rejects unknowns', async () => {
    vi.stubGlobal('document', undefined);
    await import('./referenceWorkerEntities');
    const element = document.createElement('i');
    for (const [name, value] of Object.entries(characterEntities)) {
      element.innerHTML = `&${name};`;
      expect(element.textContent, name).toBe(value);
    }
    for (const unknown of ['notit', 'unknown', 'constructor', '__proto__']) {
      element.innerHTML = `&${unknown};`;
      expect(element.textContent).toBe(`&${unknown};`);
    }
    expect(() => document.createElement('div')).toThrow('REFERENCE_WORKER_UNEXPECTED_DOM_ACCESS');
  });
});
