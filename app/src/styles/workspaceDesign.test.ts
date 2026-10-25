import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BUILTIN_STYLE_PRESETS } from '../lib/appearance';

const css = readFileSync('src/styles/global.css', 'utf8').replace(/\r\n/g, '\n');

function rule(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `Missing ${selector}`).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf('}', start) + 1);
}

describe('quiet professional workspace visual contracts', () => {
  it('uses type and whitespace rather than accent rails for answer headings', () => {
    const heading = rule('.ai-markdown h2,\n.ai-markdown h3');
    expect(heading).toContain('border-left: 0');
    expect(heading).toContain('padding: 0');
  });

  it('keeps an unfocused chat composer neutral and opaque', () => {
    const card = rule('.ugs-ai-input--chat');
    expect(card).toContain('background: var(--panel)');
    expect(card).toContain('border-color: var(--border)');
    expect(rule('.ugs-ai-input,\n.ugs-ai-input-card')).toContain('backdrop-filter: none');
    expect(rule('.ugs-ai-input-toolbar')).toContain('background: transparent');
  });

  it('provides a readable primary-button foreground in every theme', () => {
    const blocks = [...css.matchAll(/html\.ugs-style-([\w-]+)\s*\{([^}]+)\}/g)];
    expect(blocks).toHaveLength(BUILTIN_STYLE_PRESETS.length);
    const luminance = (hex: string) => {
      const channels = hex.slice(1).match(/../g)!.map((value) => parseInt(value, 16) / 255);
      const linear = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
      return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
    };
    for (const [, id, body] of blocks) {
      const accent = body.match(/--ugs-color-accent:\s*(#[\da-f]{6})/i)?.[1];
      const foreground = body.match(/--ugs-accent-contrast:\s*(#[\da-f]{6})/i)?.[1];
      expect(foreground, `${id} foreground`).toBeDefined();
      const values = [luminance(accent!), luminance(foreground!)].sort((a, b) => a - b);
      expect((values[1] + 0.05) / (values[0] + 0.05), id).toBeGreaterThanOrEqual(4.5);
    }
  });
});
