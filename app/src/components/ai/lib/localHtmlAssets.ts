import { convertFileSrc } from '@tauri-apps/api/core';

/**
 * Rewrites local file references inside an HTML document so they resolve inside
 * the sandboxed preview iframe. A sandbox iframe is an opaque origin and cannot
 * read the local filesystem, so Windows/UNC absolute paths and `file://` URLs
 * must be converted to the Tauri asset URL (`convertFileSrc`); relative paths
 * are resolved against `baseDir` first. Scheme URLs (http/https/data/blob) and
 * fragments are left untouched. Covers `src`, `srcset` and `href` attributes
 * plus CSS `url(...)`.
 */
export function rewriteLocalAssetsInHtml(html: string, baseDir: string): string {
  if (!html) return html;

  const rewriteUrl = (raw: string): string => {
    const value = raw.trim();
    if (!value) return raw;

    let path: string;
    if (/^file:\/\//i.test(value)) {
      try {
        const url = new URL(value);
        let p = decodeURIComponent(url.pathname);
        if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1); // /E:/a/b.png -> E:/a/b.png
        if (url.hostname) p = `//${url.hostname}${p}`; // UNC host
        path = p;
      } catch {
        return raw;
      }
    } else if (/^[A-Za-z]:[\\/]/.test(value)) {
      path = value; // Windows absolute path (drive letter).
    } else if (/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(value)) {
      return raw; // scheme URL, fragment, or protocol-relative URL.
    } else {
      path = value; // relative path, or POSIX absolute starting with '/'.
    }

    const isAbsolute =
      /^[A-Za-z]:[\\/]/.test(path) ||
      /^\\\\/.test(path) ||
      (/^\//.test(path) && !/^\/\//.test(path));
    if (!isAbsolute) {
      if (!baseDir) return raw;
      const sep = baseDir.includes('\\') ? '\\' : '/';
      const cleaned = path.replace(/^\.?[\\/]/, '').replace(/[\\/]/g, sep);
      path = `${baseDir}${sep}${cleaned}`;
    }

    return convertFileSrc(path);
  };

  const rewriteSrcset = (value: string): string => value.replace(/\S+/g, token => {
    const suffix = token.endsWith(',') ? ',' : '';
    const url = suffix ? token.slice(0, -1) : token;
    if (/^[\d.]+[wx]$/.test(url)) return token;
    return rewriteUrl(url) + suffix;
  });

  const attrRe =
    /\b(src|srcset|href)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  const cssUrlRe = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^"')]+))\s*\)/gi;

  const rewritten = html.replace(attrRe, (match, _attr, _quoted, dq, sq, bare) => {
    const raw = dq ?? sq ?? bare ?? '';
    if (!raw) return match;
    const next = _attr.toLowerCase() === 'srcset' ? rewriteSrcset(raw) : rewriteUrl(raw);
    return next === raw ? match : match.replace(raw, () => next);
  });

  return rewritten.replace(cssUrlRe, (match, dq, sq, bare) => {
    const raw = (dq ?? sq ?? bare ?? '').trim();
    if (!raw) return match;
    const next = rewriteUrl(raw);
    return next === raw ? match : `url("${next}")`;
  });
}


/** Resolve against the filesystem path hidden inside an encoded Tauri asset URL. */
export function resolveHtmlAssetUrl(relative: string, base: string): string {
  if (/^(?:https?:\/\/asset\.localhost\/|asset:\/\/localhost\/)/i.test(base)) {
    const path = decodeURIComponent(new URL(base).pathname.slice(1)).replace(/\\/g, '/');
    const resolved = new URL(relative, path.startsWith('/') ? `file://${path}` : `file:///${path}`);
    let target = decodeURIComponent(resolved.pathname).replace(/^\/([A-Za-z]:\/)/, '$1');
    if (resolved.hostname) target = `//${resolved.hostname}${target}`;
    return convertFileSrc(target) + resolved.search + resolved.hash;
  }
  return new URL(relative, base).href;
}

/** WebView2's opaque sandbox frames cannot route Tauri custom-protocol subresources.
 * Read local resources in the app origin and embed them without granting iframe IPC access. */
export async function embedLocalHtmlResources(doc: Document, signal: AbortSignal): Promise<void> {
  const localAsset = /^(?:https?:\/\/asset\.localhost\/|asset:\/\/localhost\/)/i;
  const pending = new Map<string, Promise<string>>();
  const embed = (url: string): Promise<string> => {
    if (!localAsset.test(url)) return Promise.resolve(url);
    let result = pending.get(url);
    if (!result) {
      result = (async () => {
        try {
          const response = await fetch(url, { signal, cache: 'no-store' });
          if (!response.ok) return url;
          const bytes = new Uint8Array(await response.arrayBuffer());
          let binary = '';
          for (let offset = 0; offset < bytes.length; offset += 32768) {
            binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
          }
          const mime = response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream';
          return `data:${mime};base64,${btoa(binary)}`;
        } catch (error) {
          if (signal.aborted) throw error;
          return url;
        }
      })();
      pending.set(url, result);
    }
    return result;
  };
  const embedCss = async (css: string): Promise<string> => {
    const urls = Array.from(css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^"')]+))\s*\)/gi));
    const replacements = await Promise.all(urls.map(async match => ({
      start: match.index!, length: match[0].length,
      value: `url("${await embed((match[1] ?? match[2] ?? match[3]).trim())}")`,
    })));
    for (const replacement of replacements.reverse()) {
      css = css.slice(0, replacement.start) + replacement.value + css.slice(replacement.start + replacement.length);
    }
    return css;
  };
  await Promise.all([
    ...Array.from(doc.querySelectorAll('img[src], input[type="image"][src], script[src], video[poster], link[rel~="icon"][href]')).map(async element => {
      const attr = element.hasAttribute('poster') ? 'poster' : element.tagName === 'LINK' ? 'href' : 'src';
      element.setAttribute(attr, await embed(element.getAttribute(attr) ?? ''));
    }),
    ...Array.from(doc.querySelectorAll('[srcset]')).map(async element => {
      let srcset = element.getAttribute('srcset') ?? '';
      const urls = Array.from(srcset.matchAll(/(?:https?:\/\/asset\.localhost\/|asset:\/\/localhost\/)[^\s,]+/gi));
      const values = await Promise.all(urls.map(match => embed(match[0])));
      for (let index = urls.length - 1; index >= 0; index--) {
        const match = urls[index];
        srcset = srcset.slice(0, match.index!) + values[index] + srcset.slice(match.index! + match[0].length);
      }
      element.setAttribute('srcset', srcset);
    }),
    ...Array.from(doc.querySelectorAll('style')).map(async style => {
      style.textContent = await embedCss(style.textContent ?? '');
    }),
    ...Array.from(doc.querySelectorAll('[style]')).map(async element => {
      element.setAttribute('style', await embedCss(element.getAttribute('style') ?? ''));
    }),
  ]);
}
