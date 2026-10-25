import { useLayoutEffect, useState } from 'react';

// Sandboxed documents have their own CSS scope. Copy the resolved app palette.
function readPreviewTheme(): string {
  const style = getComputedStyle(document.documentElement);
  const defaults: Record<string, string> = {
    '--bg': '#0d1117', '--panel-2': '#21262d', '--fg': '#e6edf3',
    '--fg-dim': '#8b949e', '--fg-faint': '#6e7681', '--border': '#30363d',
    '--border-soft': '#262c34', '--accent': '#7c8cff',
    '--ugs-font-family': 'system-ui,-apple-system,"Segoe UI",sans-serif',
  };
  const variables = Object.entries(defaults).map(([name, fallback]) =>
    `${name}:${style.getPropertyValue(name).trim() || fallback};`,
  ).join('');
  const scheme = style.colorScheme === 'light' ? 'light' : 'dark';
  return `:root{color-scheme:${scheme};${variables}}`;
}

export function usePreviewTheme(): string {
  const [theme, setTheme] = useState(readPreviewTheme);
  useLayoutEffect(() => {
    const update = () => setTheme(readPreviewTheme());
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-ugs-style', 'class', 'style'],
    });
    return () => observer.disconnect();
  }, []);
  return theme;
}

/** Adapt CSS paint declarations; leave layout, URLs and SVG artwork intact. */
export function adaptPreviewCss(css: string, dark: boolean, palette: Record<string, string> = {}): string {
  const resolve = (token: string): number[] => {
    const probe = document.createElement('span');
    probe.style.color = palette[token] ?? '#e6edf3';
    const serialized = probe.style.color;
    if (serialized === 'white') return [255, 255, 255];
    if (serialized === 'black') return [0, 0, 0];
    const parts = serialized.match(/[\d.]+/g)?.slice(0, 3).map(Number);
    return parts?.length === 3 ? parts : [230, 237, 243];
  };
  // Hide strings/comments first so declaration-looking text and data URLs survive.
  const literals: string[] = [];
  const protectedCss = css.replace(/\/\*[\s\S]*?\*\/|url\((?:[^)'"\\]|\\.|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')*\)|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/gi,
    value => `___UGS_LITERAL_${literals.push(value) - 1}___`);
  const adapted = protectedCss.replace(
    /(^|[;{])(\s*)(color|background(?:-color)?|border(?:-(?:top|right|bottom|left))?(?:-color)?|outline(?:-color)?|box-shadow|text-shadow)(\s*:\s*)([^;}]+)/gi,
    (_match, prefix, space, property: string, colon, value: string) => {
      const background = property.toLowerCase().startsWith('background');
      const text = property.toLowerCase() === 'color';
      const next = value.replace(/#[\da-f]{3,8}\b|rgba?\([^)]*\)|\b(?:white|black|gr[ae]y|silver)\b/gi, color => {
        let rgb: number[];
        let alpha = 1;
        if (color.startsWith('#')) {
          let hex = color.slice(1);
          if (hex.length === 3 || hex.length === 4) hex = [...hex].map(c => c + c).join('');
          if (hex.length !== 6 && hex.length !== 8) return color;
          rgb = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16));
          if (hex.length === 8) alpha = parseInt(hex.slice(6), 16) / 255;
        } else if (color.toLowerCase().startsWith('rgb')) {
          const parts = color.slice(color.indexOf('(') + 1, -1).trim().split(/\s*[,/]\s*|\s+/);
          rgb = parts.slice(0, 3).map(v => parseFloat(v) * (v.endsWith('%') ? 2.55 : 1));
          if (parts[3]) alpha = parseFloat(parts[3]) / (parts[3].endsWith('%') ? 100 : 1);
        } else {
          const channel = { white: 255, black: 0, gray: 128, grey: 128, silver: 192 }[color.toLowerCase()];
          rgb = [channel!, channel!, channel!];
        }
        if (alpha === 0 || rgb.some(v => !Number.isFinite(v))) return color;
        const low = Math.min(...rgb), high = Math.max(...rgb);
        const neutral = high - low <= 24 || low >= 230;
        if (!neutral) {
          // Keep emphasis hues while lifting their contrast on dark paper.
          const foreground = resolve('--fg');
          return text && dark ? `rgba(${rgb.map((v, i) => Math.round(v * 0.65 + foreground[i] * 0.35)).join(',')},${alpha})` : color;
        }
        const token = background
          ? (low > 245 || high < 40 ? '--bg' : '--panel-2')
          : text ? (low > 80 && high < 200 ? '--fg-dim' : '--fg') : '--border';
        return alpha < 1 ? `rgba(${resolve(token).join(',')},${alpha})` : `var(${token})`;
      });
      return `${prefix}${space}${property}${colon}${next}`;
    },
  );
  return adapted.replace(/___UGS_LITERAL_(\d+)___/g, (_match, index) => literals[Number(index)]);
}

export function themePreviewHtml(html: string, theme: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const dark = theme.includes('color-scheme:dark;');
  const palette = Object.fromEntries(Array.from(theme.matchAll(/(--[\w-]+):([^;]+);/g), match => [match[1], match[2]]));
  doc.querySelectorAll('style').forEach(style => {
    if (!style.closest('svg')) style.textContent = adaptPreviewCss(style.textContent ?? '', dark, palette);
  });
  doc.querySelectorAll<HTMLElement>('[style]').forEach(el => {
    if (!el.closest('svg')) el.setAttribute('style', adaptPreviewCss(el.getAttribute('style') ?? '', dark, palette));
  });
  doc.querySelectorAll('[bgcolor], [color]').forEach(el => {
    if (el.closest('svg')) return;
    for (const [attr, property] of [['bgcolor', 'background-color'], ['color', 'color']]) {
      const value = el.getAttribute(attr);
      if (value) {
        el.setAttribute('style', `${el.getAttribute('style') ?? ''};${adaptPreviewCss(`${property}:${value}`, dark, palette)}`);
        el.removeAttribute(attr);
      }
    }
  });
  const defaults = doc.createElement('style');
  defaults.textContent = `${theme}html,body{background:var(--bg);color:var(--fg);color-scheme:${dark ? 'dark' : 'light'};}body{font-family:var(--ugs-font-family);}a{color:var(--accent);}table,td,th,hr{border-color:var(--border);}th,pre,code{background-color:var(--panel-2);}`;
  // Defaults precede author CSS so geometry and deliberate accents still win.
  doc.head.prepend(defaults);
  const paletteStyle = doc.createElement('style');
  paletteStyle.textContent = theme;
  doc.head.append(paletteStyle);
  return `<!doctype html>${doc.documentElement.outerHTML}`;
}
