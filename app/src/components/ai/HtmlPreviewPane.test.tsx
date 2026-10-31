import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import HtmlPreviewPane from './HtmlPreviewPane';
import type { LocalFilePreview } from '@/lib/tauri';

vi.mock('@tauri-apps/api/core', () => ({ convertFileSrc: (path: string) => `http://asset.localhost/${encodeURIComponent(path)}` }));

describe('HTML theme preview', () => {
  let container: HTMLDivElement, root: Root, oldStyle: string | null;
  const file: LocalFilePreview = { path: 'E:/docs/page.html', fileName: 'page.html', kind: 'text', mime: 'text/html', sizeBytes: 2000000, truncated: true, text: '<p>截断片段</p>', streamPath: 'E:/docs/page.html' };
  beforeEach(() => {
    oldStyle = document.documentElement.getAttribute('style');
    document.documentElement.style.cssText = '--bg:#191919;--fg:#d4d4d4;color-scheme:dark';
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals();
    if (oldStyle === null) document.documentElement.removeAttribute('style');
    else document.documentElement.setAttribute('style', oldStyle);
  });
  it('uses full HTML, adapts author CSS and updates the theme without another file read', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('<style>body{background:#fff;color:#1c1c1e;max-width:900px}h2{border-left:5px solid #2f54eb}a{color:#0000ff}pre{background:url(image.svg#fff);box-shadow:0 0 4px rgba(0,0,0,0.2)}</style><p style="color:black">完整正文</p><img src="figure.png"><svg><rect fill="#fff" style="color:black"/></svg><script>window.parent.invalid=true</script>'));
    vi.stubGlobal('fetch', fetch);
    await act(async () => root.render(createElement(HtmlPreviewPane, { file })));
    const iframe = container.querySelector('iframe')!;
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts');
    expect(iframe.srcdoc).toContain('完整正文');
    expect(iframe.srcdoc).not.toContain('截断片段');
    expect(iframe.srcdoc).toContain('background:var(--bg)');
    expect(iframe.srcdoc).toContain('color:var(--fg)');
    expect(iframe.srcdoc).toContain('max-width:900px');
    expect(iframe.srcdoc).toContain('5px solid #2f54eb');
    expect(iframe.srcdoc).toContain('a{color:rgba(74,74,240,1)}');
    expect(iframe.srcdoc).not.toContain('color-mix');
    expect(iframe.srcdoc).toContain(encodeURIComponent('image.svg#fff'));
    expect(iframe.srcdoc).toContain(encodeURIComponent('E:/docs/figure.png'));
    expect(iframe.srcdoc).toContain('fill="#fff" style="color:black"');
    await act(async () => { document.documentElement.style.cssText = '--bg:#f6f7f9;--fg:#202124;color-scheme:light'; });
    expect(iframe.srcdoc).toContain('--bg:#f6f7f9;');
    expect(iframe.srcdoc).toContain('color-scheme:light;');
    expect(iframe.srcdoc).toContain('a{color:#0000ff}');
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('themes linked stylesheets and keeps their relative images', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response('<link rel="stylesheet" href="css/site.css"><p>正文</p>')).mockResolvedValueOnce(new Response('body{color:black;background:white} .banner{background:url("figure.png")}')).mockResolvedValueOnce(new Response('image-bytes', { headers: { 'content-type': 'image/png' } }));
    vi.stubGlobal('fetch', fetch);
    await act(async () => root.render(createElement(HtmlPreviewPane, { file })));
    const html = container.querySelector('iframe')!.srcdoc;
    expect(html).toContain('color:var(--fg);background:var(--bg)');
    expect(html).toContain('url("data:image/png;base64,');
    expect(fetch.mock.calls[2][0]).toContain(encodeURIComponent('E:/docs/css/figure.png'));
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('embeds local images, CSS images and scripts for opaque WebView2 frames, and deduplicates resources', async () => {
    const source = '<img src="figure.svg" srcset="figure.svg 1x"><style>.banner{background:url(figure.svg)}</style><script src="controls.js"></script><img src="https://example.com/remote.png">';
    const fetch = vi.fn(async (url: string) => url.includes('controls.js')
      ? new Response('window.ready=true', { headers: { 'content-type': 'application/javascript' } })
      : url.includes('figure.svg') ? new Response('<svg xmlns="http://www.w3.org/2000/svg"/>', { headers: { 'content-type': 'image/svg+xml' } })
      : new Response(source));
    vi.stubGlobal('fetch', fetch);
    await act(async () => root.render(createElement(HtmlPreviewPane, { file })));
    const html = container.querySelector('iframe')!.srcdoc;
    expect(html).toContain('data:image/svg+xml;base64,');
    expect(html).toContain('data:application/javascript;base64,');
    expect(html).toContain('https://example.com/remote.png');
    expect(fetch).toHaveBeenCalledTimes(3);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="查看 HTML 源码"]')!.click());
    expect(container.querySelector('pre')?.textContent).toBe(source);
  });
  it('switches to complete original source and back without reloading the iframe', async () => {
    const original = '<!doctype html><style>body{color:black}</style><button onclick="this.textContent=42">交互按钮</button>';
    const fetch = vi.fn().mockResolvedValue(new Response(original));
    vi.stubGlobal('fetch', fetch);
    await act(async () => root.render(createElement(HtmlPreviewPane, { file })));
    const iframe = container.querySelector('iframe')!;
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="查看 HTML 源码"]')!.click());
    expect(container.querySelector('pre')?.textContent).toBe(original);
    expect(iframe.hidden).toBe(true);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="显示 HTML 预览"]')!.click());
    expect(container.querySelector('iframe')).toBe(iframe);
    expect(iframe.hidden).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('refreshes the full document from disk', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response('<p>旧内容</p>')).mockResolvedValueOnce(new Response('<p>更新内容</p>'));
    vi.stubGlobal('fetch', fetch);
    await act(async () => root.render(createElement(HtmlPreviewPane, { file })));
    expect(container.querySelector('iframe')!.srcdoc).toContain('旧内容');
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="刷新 HTML 预览"]')!.click());
    expect(container.querySelector('iframe')!.srcdoc).toContain('更新内容');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][1].cache).toBe('no-store');
  });
  it('changes only the preview zoom and accepts messages only from its iframe', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<p>正文</p>')));
    await act(async () => root.render(createElement(HtmlPreviewPane, { file })));
    const frame = container.querySelector('iframe')!;
    const original = frame.srcdoc;
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="放大预览"]')!.click());
    expect(container.querySelector('output')?.textContent).toBe('120%');
    expect(frame.srcdoc).toBe(original);
    await act(async () => window.dispatchEvent(new MessageEvent('message', { source: window, data: { type: 'ugs-preview-zoom', value: 3 } })));
    expect(container.querySelector('output')?.textContent).toBe('120%');
    await act(async () => window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { type: 'ugs-preview-zoom', value: 1.5 } })));
    expect(container.querySelector('output')?.textContent).toBe('150%');
  });
  it('shows file loading failures instead of an empty preview', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })));
    await act(async () => root.render(createElement(HtmlPreviewPane, { file })));
    expect(container.textContent).toContain('无法预览：HTTP 404');
  });
});
