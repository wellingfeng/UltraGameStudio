/**
 * html2canvas 1.4.1 ships a CSS color parser that predates CSS Color 4/5 — it
 * throws "Attempting to parse an unsupported color function" the moment it meets
 * an `oklab()`, `oklch()`, `color()` or `color-mix()` value. OpenWorkflow's theme
 * leans on `color-mix(in oklab, …)` throughout `global.css` (and a few inline
 * component styles), and modern Chromium serializes those into computed values
 * the library can't read, so any capture aborts immediately.
 *
 * `sanitizeClonedColors` runs inside html2canvas's `onclone` callback. It rewrites
 * the *cloned* document — which is what actually gets rasterized — so every color
 * the library will read is a plain sRGB `rgb()/rgba()` string. The live UI is
 * never touched.
 *
 * Three passes cover everything:
 *   1. Custom-property override on the clone's <html> (inline, so it beats any
 *      themed `:root[data-theme=…]` selector). This fixes the bulk of usage —
 *      including pseudo-elements like `.ai-tool-card::before`, which can't carry
 *      inline styles but do reference `var(--…)`.
 *   2. A stylesheet sweep for direct color functions in CSS rules, including
 *      pseudo-element selectors that don't flow through a normal element style.
 *   3. A per-element sweep for the handful of components that use
 *      `color-mix(in oklab, …)` directly in an inline style (e.g. card chrome,
 *      callouts, run-state glows) rather than through a variable.
 *
 * Conversion strategy (see {@link colorTokenToRgb}):
 *   a. Evaluate the color through the browser's own CSS engine via an off-screen
 *      probe element — this resolves `color-mix()` (the app already renders it, so
 *      support is guaranteed) to a concrete `oklab()`/`oklch()`/`rgb()` value.
 *   b. Convert that concrete value to sRGB with explicit color math, so the result
 *      never depends on whether <canvas> happens to support modern color
 *      functions (it often serializes them straight back, which was the bug in the
 *      first version of this module).
 */

/** CSS color properties worth rewriting on individual elements. */
const COLOR_PROPERTIES = [
  'color',
  'background',
  'background-color',
  'background-image',
  'border-color',
  'border-top',
  'border-top-color',
  'border-right',
  'border-right-color',
  'border-bottom',
  'border-bottom-color',
  'border-left',
  'border-left-color',
  'outline',
  'outline-color',
  'box-shadow',
  'text-shadow',
  'text-decoration-color',
  '-webkit-text-stroke-color',
  'column-rule-color',
  'fill',
  'stroke',
] as const;

/** Color functions html2canvas 1.4.1 cannot parse. */
const UNSUPPORTED_FN = /(oklab|oklch|color-mix|color)\(/i;

/** Function-token prefixes we balance and convert, longest first. */
const FN_PREFIXES = ['color-mix(', 'oklab(', 'oklch(', 'color('];

const conversionCache = new Map<string, string | null>();

let probeEl: HTMLElement | null | undefined;

/** Lazily create a hidden off-screen element used to resolve global colors. */
function getProbe(): HTMLElement | null {
  if (probeEl === undefined) {
    try {
      const el = document.createElement('div');
      el.style.cssText =
        'position:absolute!important;left:-9999px!important;top:-9999px!important;' +
        'width:0!important;height:0!important;pointer-events:none!important;';
      document.body.appendChild(el);
      probeEl = el;
    } catch {
      probeEl = null;
    }
  }
  return probeEl;
}

function createContextProbe(contextEl: Element): HTMLElement | null {
  const doc = contextEl.ownerDocument;
  const HTMLElementCtor = doc.defaultView?.HTMLElement;
  const parent =
    HTMLElementCtor && contextEl instanceof HTMLElementCtor
      ? contextEl
      : doc.body;
  if (!parent) return null;
  try {
    const el = doc.createElement('div');
    el.style.cssText =
      'position:absolute!important;left:-9999px!important;top:-9999px!important;' +
      'width:0!important;height:0!important;pointer-events:none!important;';
    parent.appendChild(el);
    return el;
  } catch {
    return null;
  }
}

function stylePropertyNames(style: CSSStyleDeclaration): string[] {
  const names: string[] = [];
  for (let i = 0; i < style.length; i += 1) {
    const prop =
      typeof style.item === 'function'
        ? style.item(i)
        : (style as unknown as Record<number, string>)[i];
    if (prop) names.push(prop);
  }
  return names;
}

/**
 * Resolve a single CSS color token through the browser's CSS engine, returning
 * whatever concrete value `getComputedStyle` reports (e.g. `oklab(…)` for a
 * `color-mix(in oklab, …)` input). Returns '' when the value is rejected as
 * invalid, or when no probe is available (e.g. jsdom) — callers then fall back to
 * parsing the original token directly.
 */
function resolveComputed(token: string, contextEl?: Element | null): string {
  const probe = contextEl ? createContextProbe(contextEl) : getProbe();
  if (!probe) return '';
  try {
    probe.style.backgroundColor = '';
    probe.style.backgroundColor = token;
    // An invalid value is ignored by the setter, leaving the property empty.
    if (!probe.style.backgroundColor) return '';
    const computed =
      probe.ownerDocument.defaultView?.getComputedStyle(probe).backgroundColor ??
      '';
    return computed || '';
  } catch {
    return '';
  } finally {
    if (contextEl) probe.remove();
  }
}

/** Parse a CSS number-or-percentage; percentages are scaled by `percentBase`. */
function numOrPct(raw: string, percentBase: number): number {
  const s = raw.trim();
  if (s.toLowerCase() === 'none') return 0;
  const value = s.endsWith('%')
    ? (parseFloat(s) / 100) * percentBase
    : parseFloat(s);
  return Number.isFinite(value) ? value : 0;
}

/** Parse a CSS hue angle (deg/grad/rad/turn or unitless degrees) to radians. */
function hueToRadians(raw: string): number {
  const s = raw.trim().toLowerCase();
  let deg: number;
  if (s.endsWith('grad')) deg = parseFloat(s) * 0.9;
  else if (s.endsWith('rad')) return parseFloat(s);
  else if (s.endsWith('turn')) deg = parseFloat(s) * 360;
  else deg = parseFloat(s); // 'deg' or unitless
  return (deg * Math.PI) / 180;
}

/** Linear-light sRGB channel → gamma-encoded sRGB, clamped to [0, 255]. */
function linearToByte(c: number): number {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(v * 255)));
}

/** Format sRGB bytes + alpha as an html2canvas-friendly rgb()/rgba() string. */
function formatRgb(r: number, g: number, b: number, a: number): string {
  if (a >= 1) return `rgb(${r}, ${g}, ${b})`;
  return `rgba(${r}, ${g}, ${b}, ${Math.round(a * 1000) / 1000})`;
}

/** Split the inner args of a color function on commas/spaces, isolating alpha. */
function splitColorArgs(inner: string): { parts: string[]; alpha: number } {
  let alpha = 1;
  let body = inner;
  const slash = inner.indexOf('/');
  if (slash >= 0) {
    alpha = numOrPct(inner.slice(slash + 1), 1);
    body = inner.slice(0, slash);
  }
  const parts = body
    .trim()
    .split(/[\s,]+/)
    .filter((p) => p.length > 0);
  return { parts, alpha: Number.isFinite(alpha) ? alpha : 1 };
}

/** Convert OKLab L,a,b (+alpha) to an sRGB rgb()/rgba() string. */
function oklabToRgb(L: number, a: number, b: number, alpha: number): string {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bl = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  return formatRgb(linearToByte(r), linearToByte(g), linearToByte(bl), alpha);
}

/**
 * Convert a single concrete CSS color value to an sRGB rgb()/rgba() string,
 * handling `oklab()`, `oklch()`, `color(srgb …)`, `color(srgb-linear …)`, and
 * already-sRGB forms (rgb/rgba/hex). Returns null when the form is unrecognized.
 */
function concreteToRgb(value: string): string | null {
  const v = value.trim();
  const lower = v.toLowerCase();

  // Already sRGB / something html2canvas can read — keep as-is.
  if (
    lower.startsWith('rgb(') ||
    lower.startsWith('rgba(') ||
    lower.startsWith('#') ||
    lower === 'transparent'
  ) {
    return v;
  }

  const fnMatch = /^([a-z-]+)\((.*)\)$/i.exec(v);
  if (!fnMatch) return null;
  const fn = fnMatch[1].toLowerCase();
  const inner = fnMatch[2];

  if (fn === 'oklab') {
    const { parts, alpha } = splitColorArgs(inner);
    if (parts.length < 3) return null;
    const L = numOrPct(parts[0], 1);
    const a = numOrPct(parts[1], 0.4);
    const b = numOrPct(parts[2], 0.4);
    return oklabToRgb(L, a, b, alpha);
  }

  if (fn === 'oklch') {
    const { parts, alpha } = splitColorArgs(inner);
    if (parts.length < 3) return null;
    const L = numOrPct(parts[0], 1);
    const C = numOrPct(parts[1], 0.4);
    const h = hueToRadians(parts[2]);
    return oklabToRgb(L, C * Math.cos(h), C * Math.sin(h), alpha);
  }

  if (fn === 'color') {
    const { parts, alpha } = splitColorArgs(inner);
    // parts[0] is the colorspace keyword (e.g. 'srgb', 'srgb-linear').
    const space = parts[0]?.toLowerCase();
    const ch = parts.slice(1).map((p) => numOrPct(p, 1));
    if (ch.length < 3) return null;
    if (space === 'srgb') {
      return formatRgb(
        Math.max(0, Math.min(255, Math.round(ch[0] * 255))),
        Math.max(0, Math.min(255, Math.round(ch[1] * 255))),
        Math.max(0, Math.min(255, Math.round(ch[2] * 255))),
        alpha,
      );
    }
    if (space === 'srgb-linear') {
      return formatRgb(
        linearToByte(ch[0]),
        linearToByte(ch[1]),
        linearToByte(ch[2]),
        alpha,
      );
    }
    return null;
  }

  return null;
}

/**
 * Convert one CSS color *token* (a bare color or a single color function such as
 * `color-mix(in oklab, …)`) to an sRGB rgb()/rgba() string. Returns null when the
 * token can't be resolved, so callers leave it untouched. Memoized.
 */
export function colorTokenToRgb(
  token: string,
  contextEl?: Element | null,
): string | null {
  const cacheable = !contextEl && !/var\(|currentcolor/i.test(token);
  if (cacheable) {
    const cached = conversionCache.get(token);
    if (cached !== undefined) return cached;
  }

  // 1. Let the CSS engine evaluate color-mix()/var-free tokens to a concrete
  //    color. Falls back to the raw token (e.g. in jsdom, or for plain oklab()).
  const resolved = resolveComputed(token, contextEl);
  const candidate = resolved || token;

  // 2. Convert the concrete value to sRGB with explicit math.
  let result = concreteToRgb(candidate);
  if (result === null && resolved && resolved !== token) {
    // The resolved form was unrecognized but the original might be directly
    // parseable (e.g. a bare oklab() the engine echoed back differently).
    result = concreteToRgb(token);
  }

  if (cacheable) conversionCache.set(token, result);
  return result;
}

/**
 * Replace every unsupported color-function token inside a CSS value (which may
 * be a bare color, a gradient, or a box-shadow list) with its sRGB equivalent,
 * leaving the surrounding structure intact. Returns the original string when
 * nothing needed changing.
 */
export function convertColorTokens(
  value: string,
  contextEl?: Element | null,
): string {
  if (!value || !UNSUPPORTED_FN.test(value)) return value;

  const lower = value.toLowerCase();
  let out = '';
  let i = 0;
  while (i < value.length) {
    const prefix = FN_PREFIXES.find((fn) => lower.startsWith(fn, i));
    if (!prefix) {
      out += value[i];
      i += 1;
      continue;
    }
    // Walk to the matching close paren so nested color-mix() is captured whole.
    let depth = 0;
    let j = i;
    for (; j < value.length; j += 1) {
      const ch = value[j];
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0) {
          j += 1;
          break;
        }
      }
    }
    const token = value.slice(i, j);
    const rgb = colorTokenToRgb(token, contextEl);
    out += rgb ?? token;
    i = j;
  }
  return out;
}

/** Override CSS custom properties on the clone root with sRGB-resolved values. */
function overrideRootVariables(doc: Document): void {
  const root = doc.documentElement;
  if (!root) return;
  // Read variable values from the *live* document — it is fully laid out, so its
  // computed custom-property values already have inner var() refs substituted.
  const live = getComputedStyle(document.documentElement);
  for (let i = 0; i < live.length; i += 1) {
    const prop = live[i];
    if (!prop.startsWith('--')) continue;
    const raw = live.getPropertyValue(prop);
    if (!UNSUPPORTED_FN.test(raw)) continue;
    const converted = convertColorTokens(raw, document.documentElement);
    if (converted !== raw) {
      // Inline on <html> beats any stylesheet :root / themed selector.
      root.style.setProperty(prop, converted);
    }
  }
}

/** Rewrite direct (non-variable) color-mix/oklab usage on individual elements. */
function overrideElementColors(doc: Document): void {
  const view = doc.defaultView;
  if (!view) return;
  const elements = doc.querySelectorAll<HTMLElement>('*');
  elements.forEach((el) => {
    let computed: CSSStyleDeclaration;
    try {
      computed = view.getComputedStyle(el);
    } catch {
      return;
    }
    for (const prop of COLOR_PROPERTIES) {
      const value = computed.getPropertyValue(prop);
      if (!value || !UNSUPPORTED_FN.test(value)) continue;
      const converted = convertColorTokens(value, el);
      if (converted !== value) {
        el.style.setProperty(prop, converted);
      }
    }
  });
}

/** Rewrite direct color functions inside cloned stylesheet rules. */
function overrideStylesheetColors(doc: Document): void {
  for (const sheet of Array.from(doc.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of Array.from(rules)) {
      if (!('style' in rule)) continue;
      const style = (rule as CSSStyleRule).style;
      for (const prop of stylePropertyNames(style)) {
        const value = style.getPropertyValue(prop);
        if (!value || !UNSUPPORTED_FN.test(value)) continue;
        const converted = convertColorTokens(value, doc.documentElement);
        if (converted !== value) {
          style.setProperty(prop, converted, style.getPropertyPriority(prop));
        }
      }
    }
  }
}

/**
 * Make a cloned document safe to feed to html2canvas by converting all
 * oklab/oklch/color-mix colors to sRGB. Best-effort: failures are swallowed so a
 * single bad value can never abort the whole capture.
 */
export function sanitizeClonedColors(doc: Document): void {
  try {
    overrideRootVariables(doc);
  } catch {
    /* ignore — fall through to per-element pass */
  }
  try {
    overrideStylesheetColors(doc);
  } catch {
    /* ignore — fall through to per-element pass */
  }
  try {
    overrideElementColors(doc);
  } catch {
    /* ignore — capture proceeds with whatever was converted */
  }
}
