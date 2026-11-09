import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

export const MIN_PREVIEW_ZOOM = 0.25;
export const MAX_PREVIEW_ZOOM = 4;

export function zoomFromWheel(scale: number, delta: number, mode = 0, pageHeight = 800): number {
  const pixels = delta * (mode === 1 ? 16 : mode === 2 ? pageHeight : 1);
  return Math.min(MAX_PREVIEW_ZOOM, Math.max(MIN_PREVIEW_ZOOM, scale * Math.exp(-pixels * 0.002)));
}

export function usePreviewZoom(identity: string) {
  const [zoom, setZoom] = useState(1);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  useEffect(() => setZoom(1), [identity]);
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow || event.data?.type !== 'ugs-preview-zoom') return;
      const value = Number(event.data.value);
      if (Number.isFinite(value)) setZoom(Math.min(MAX_PREVIEW_ZOOM, Math.max(MIN_PREVIEW_ZOOM, value)));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const updateZoom = useCallback((value: number) => {
    const bounded = Math.min(MAX_PREVIEW_ZOOM, Math.max(MIN_PREVIEW_ZOOM, value));
    setZoom(bounded);
    frameRef.current?.contentWindow?.postMessage({ type: 'ugs-preview-set-zoom', value: bounded }, '*');
  }, []);
  const onFrameLoad = useCallback(() => {
    frameRef.current?.contentWindow?.postMessage({ type: 'ugs-preview-set-zoom', value: zoomRef.current }, '*');
  }, []);
  return { zoom, setZoom: updateZoom, frameRef, onFrameLoad };
}

export function useCtrlWheelZoom(ref: RefObject<HTMLElement>, zoom: number, onZoom: (value: number) => void, identity?: string) {
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      onZoom(zoomFromWheel(zoom, event.deltaY, event.deltaMode, element.clientHeight));
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [ref, zoom, onZoom, identity]);
}

// The iframe has an opaque origin. Its own script handles wheel and image clicks;
// the parent only exchanges zoom values with the exact frame it owns.
const FRAME_INTERACTIONS = String.raw`(() => {
  let zoom = 1;
  let lightbox = null;
  const applyZoom = (value, notify) => {
    zoom = Math.min(4, Math.max(0.25, value));
    document.documentElement.style.zoom = String(zoom);
    if (lightbox) lightbox.style.zoom = String(1 / zoom);
    if (notify) parent.postMessage({ type: 'ugs-preview-zoom', value: zoom }, '*');
  };
  window.addEventListener('message', event => {
    if (event.source !== parent || event.data?.type !== 'ugs-preview-set-zoom') return;
    const value = Number(event.data.value);
    if (Number.isFinite(value)) applyZoom(value, false);
  });
  document.addEventListener('wheel', event => {
    if (!event.ctrlKey || lightbox) return;
    event.preventDefault();
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? innerHeight : 1);
    applyZoom(zoom * Math.exp(-delta * 0.002), true);
  }, { capture: true, passive: false });
  document.addEventListener('click', event => {
    const image = event.target instanceof Element ? event.target.closest('img') : null;
    if (!image || !image.currentSrc || image.closest('button,input,select,textarea,[role="button"]') || lightbox) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const host = document.createElement('div');
    host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;display:block!important;zoom:' + (1 / zoom) + '!important';
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = '<style>:host{font:13px system-ui,sans-serif}.backdrop{position:fixed;inset:0;background:rgba(0,0,0,.92);display:flex;flex-direction:column;color:white}.bar{display:flex;align-items:center;gap:12px;padding:10px 14px;background:#20242a}.bar span{flex:1}.bar button{border:0;background:#3b424c;color:white;border-radius:4px;padding:5px 11px;cursor:pointer}.view{flex:1;min-height:0;overflow:hidden;display:flex;align-items:center;justify-content:center;cursor:grab;touch-action:none}.view.dragging{cursor:grabbing}img{display:block;max-width:calc(100% - 32px);max-height:calc(100% - 32px);object-fit:contain;user-select:none}</style><div class="backdrop"><div class="bar"><span>滚轮缩放 · 拖动查看 · 点击空白或 Esc 关闭</span><button type="button" aria-label="关闭图片查看">关闭</button></div><div class="view"><img alt="放大查看"></div></div>';
    const view = shadow.querySelector('.view');
    const enlarged = shadow.querySelector('img');
    enlarged.src = image.currentSrc;
    enlarged.alt = image.alt || '放大查看';
    let scale = 1, x = 0, y = 0, drag = null;
    const paint = () => { enlarged.style.transform = 'translate(' + x + 'px,' + y + 'px) scale(' + scale + ')'; };
    const close = () => { host.remove(); lightbox = null; document.removeEventListener('keydown', onKey, true); };
    const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); } };
    shadow.querySelector('button').addEventListener('click', close);
    shadow.querySelector('.bar').addEventListener('click', e => { if (!e.target.closest('button')) close(); });
    view.addEventListener('wheel', e => {
      e.preventDefault(); e.stopPropagation();
      const bounds = view.getBoundingClientRect();
      const px = e.clientX - bounds.left - bounds.width / 2, py = e.clientY - bounds.top - bounds.height / 2;
      const delta = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? bounds.height : 1);
      const next = Math.max(.1, Math.min(16, scale * Math.exp(-delta * .002)));
      const ratio = next / scale; x = px - (px - x) * ratio; y = py - (py - y) * ratio; scale = next; paint();
    }, { passive: false });
    view.addEventListener('pointerdown', e => { if (e.button !== 0) return; e.preventDefault(); view.setPointerCapture(e.pointerId); drag = { id: e.pointerId, x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY, outside: e.target === view, moved: false }; view.classList.add('dragging'); });
    view.addEventListener('pointermove', e => { if (!drag || drag.id !== e.pointerId) return; x += e.clientX - drag.x; y += e.clientY - drag.y; drag.moved ||= Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > 4; drag.x = e.clientX; drag.y = e.clientY; paint(); });
    const endDrag = () => { drag = null; view.classList.remove('dragging'); };
    view.addEventListener('pointerup', e => { if (!drag || drag.id !== e.pointerId) return; const dismiss = drag.outside && !drag.moved && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) <= 4; endDrag(); if (dismiss) close(); });
    view.addEventListener('pointercancel', endDrag); view.addEventListener('lostpointercapture', endDrag);
    document.addEventListener('keydown', onKey, true);
    lightbox = host;
    document.documentElement.append(host);
    shadow.querySelector('button').focus();
  }, true);
})();`;

export function withPreviewInteractions(html: string, scriptNonce?: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const script = doc.createElement('script');
  script.textContent = FRAME_INTERACTIONS;
  // Install before author scripts so Ctrl-wheel is handled even in interactive reports.
  doc.head.prepend(script);
  if (scriptNonce) {
    script.setAttribute('nonce', scriptNonce);
    const policy = doc.createElement('meta');
    policy.httpEquiv = 'Content-Security-Policy';
    policy.content = `script-src 'nonce-${scriptNonce}'`;
    doc.head.prepend(policy);
  }
  return `<!doctype html>${doc.documentElement.outerHTML}`;
}
