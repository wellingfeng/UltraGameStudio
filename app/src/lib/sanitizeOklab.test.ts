import { describe, expect, it } from 'vitest';
import {
  colorTokenToRgb,
  convertColorTokens,
  sanitizeClonedColors,
} from './sanitizeOklab';

/**
 * In jsdom there is no CSS color engine, so `resolveComputed` returns '' and the
 * converter falls back to parsing the raw token with explicit color math. That
 * lets us assert the oklab/oklch → sRGB conversion directly. `color-mix(…)` can't
 * be evaluated without a real engine, so those are exercised in the browser; here
 * we focus on the math and the structural token-walking.
 *
 * Expected RGB values below were computed from the standard OKLab→linear-sRGB
 * matrix (same constants the implementation uses).
 */
describe('colorTokenToRgb', () => {
  it('converts oklab white to rgb(255, 255, 255)', () => {
    expect(colorTokenToRgb('oklab(1 0 0)')).toBe('rgb(255, 255, 255)');
  });

  it('converts oklab black to rgb(0, 0, 0)', () => {
    expect(colorTokenToRgb('oklab(0 0 0)')).toBe('rgb(0, 0, 0)');
  });

  it('preserves alpha via the slash syntax', () => {
    expect(colorTokenToRgb('oklab(1 0 0 / 0.5)')).toBe('rgba(255, 255, 255, 0.5)');
  });

  it('converts an oklch token (white) to rgb(255, 255, 255)', () => {
    expect(colorTokenToRgb('oklch(1 0 0)')).toBe('rgb(255, 255, 255)');
  });

  it('produces a mid-gray for oklab(0.5 0 0)', () => {
    // L=0.5 is a neutral gray: linear-light 0.125 → sRGB byte 99 (verified
    // against the OKLab→linear-sRGB matrix + gamma encoding).
    expect(colorTokenToRgb('oklab(0.5 0 0)')).toBe('rgb(99, 99, 99)');
  });

  it('passes through already-sRGB rgb() values unchanged', () => {
    expect(colorTokenToRgb('rgb(10, 20, 30)')).toBe('rgb(10, 20, 30)');
  });

  it('converts color(srgb …) to bytes', () => {
    expect(colorTokenToRgb('color(srgb 1 0 0)')).toBe('rgb(255, 0, 0)');
  });

  it('returns null for an unrecognized form', () => {
    expect(colorTokenToRgb('not-a-color(1 2 3)')).toBeNull();
  });
});

describe('convertColorTokens', () => {
  it('returns the input untouched when no unsupported function is present', () => {
    const value = 'rgba(10, 20, 30, 0.5)';
    expect(convertColorTokens(value)).toBe(value);
  });

  it('rewrites a bare oklab token embedded in a gradient, preserving structure', () => {
    const input = 'linear-gradient(180deg, oklab(1 0 0) 0%, oklab(0 0 0) 100%)';
    expect(convertColorTokens(input)).toBe(
      'linear-gradient(180deg, rgb(255, 255, 255) 0%, rgb(0, 0, 0) 100%)',
    );
  });

  it('walks multiple tokens in a box-shadow list', () => {
    const input = '0 0 4px oklab(1 0 0), inset 0 0 2px oklab(0 0 0)';
    expect(convertColorTokens(input)).toBe(
      '0 0 4px rgb(255, 255, 255), inset 0 0 2px rgb(0, 0, 0)',
    );
  });

  it('captures a nested color-mix() token whole (balanced parens)', () => {
    // jsdom can't resolve color-mix(), so the token is left in place — but the
    // walker must still consume the entire balanced token without corrupting the
    // surrounding string.
    const input =
      'color-mix(in oklab, color-mix(in oklab, red 50%, blue) 30%, white) solid';
    // Unresolvable here → unchanged, proving the walker didn't split mid-token.
    expect(convertColorTokens(input)).toBe(input);
  });

  it('leaves a token in place when it cannot be resolved', () => {
    const input = 'color-mix(in oklab, red 50%, blue)';
    expect(convertColorTokens(input)).toBe(input);
  });
});

describe('sanitizeClonedColors', () => {
  it('rewrites unsupported inline colors on html2canvas-parsed properties', () => {
    document.body.innerHTML =
      '<div id="target" style="' +
      'background: linear-gradient(180deg, oklab(1 0 0), oklab(0 0 0));' +
      'text-shadow: 0 0 4px oklab(1 0 0);' +
      '-webkit-text-stroke-color: oklab(0 0 0);' +
      '"></div>';

    sanitizeClonedColors(document);

    const style = document.getElementById('target')!.style;
    expect(style.getPropertyValue('background')).not.toContain('oklab(');
    expect(style.getPropertyValue('text-shadow')).not.toContain('oklab(');
    expect(style.getPropertyValue('-webkit-text-stroke-color')).not.toContain(
      'oklab(',
    );
  });

  it('rewrites unsupported colors inside cloned stylesheet rules', () => {
    const styleEl = document.createElement('style');
    styleEl.textContent =
      '.capture::before {' +
      'background: linear-gradient(180deg, oklab(1 0 0), oklab(0 0 0));' +
      'text-shadow: 0 0 4px oklab(1 0 0);' +
      '}';
    document.head.appendChild(styleEl);

    sanitizeClonedColors(document);

    const rule = styleEl.sheet!.cssRules[0] as CSSStyleRule;
    expect(rule.style.getPropertyValue('background')).not.toContain('oklab(');
    expect(rule.style.getPropertyValue('text-shadow')).not.toContain('oklab(');

    styleEl.remove();
  });
});
