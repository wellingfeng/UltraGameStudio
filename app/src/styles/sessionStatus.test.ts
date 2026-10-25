import { readFileSync } from 'node:fs';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

const css = postcss.parse(readFileSync('src/styles/global.css', 'utf8'));

function declarations(selector: string): string {
  const values: string[] = [];
  css.walkRules(selector, (rule) => { values.push(rule.toString()); });
  expect(values.length, `Missing ${selector}`).toBeGreaterThan(0);
  return values.join('\n');
}

describe('session selection and activity', () => {
  it('uses the shared selection style and keeps live activity on both horizontal edges', () => {
    expect(declarations('.ugs-sidebar-session')).toContain('position: relative');
    const selectionRules: string[] = [];
    css.walkRules((rule) => {
      if (rule.selector.includes('.ugs-sidebar-session--selected')) selectionRules.push(rule.toString());
    });
    expect(selectionRules).toEqual([]);
    const light = declarations('.ugs-sidebar-session--live::after');
    expect(light).toContain('inset: 0');
    expect(light).toContain('250% 1px, 250% 1px, 100% 1px, 100% 1px');
    expect(light).toContain('background-position: 0% 0, 0% 100%, 0 0, 0 100%');
    expect(light).toContain('background-repeat: no-repeat');
    expect(light).toContain('pointer-events: none');
    expect(light).toContain('var(--ugs-session-light-duration, 2.6s) ease-in-out infinite');
    expect(light).not.toContain('conic-gradient(');
    expect(light).not.toContain('blur(');

    let reducedMotion = '';
    css.walkAtRules('media', (media) => {
      if (media.params === '(prefers-reduced-motion: reduce)') {
        media.walkRules('.ugs-sidebar-session--live::after', (rule) => {
          reducedMotion += rule.toString();
        });
      }
    });
    expect(reducedMotion).toContain('animation: none');
    expect(reducedMotion).toContain('background-size: 100% 1px, 100% 1px');
    expect(reducedMotion).toContain('background-position: 0 0, 0 100%');
    expect(reducedMotion).not.toContain('display: none');
  });
});
