// Moon Begin: bundle PDF.js resources needed by non-embedded fonts and CJK CMaps.
const resources = {
  cMapUrl: import.meta.glob<string>('/node_modules/pdfjs-dist/cmaps/*.bcmap', { eager: true, query: '?url', import: 'default' }),
  standardFontDataUrl: import.meta.glob<string>('/node_modules/pdfjs-dist/standard_fonts/*.{pfb,ttf}', { eager: true, query: '?url', import: 'default' }),
  wasmUrl: import.meta.glob<string>('/node_modules/pdfjs-dist/wasm/*.{wasm,js}', { eager: true, query: '?url', import: 'default' }),
};

class PdfBinaryDataFactory {
  async fetch({ kind, filename }: { kind: keyof typeof resources; filename: string }): Promise<Uint8Array> {
    const entries = resources[kind];
    const url = entries && Object.entries(entries).find(([path]) => path.endsWith(`/${filename}`))?.[1];
    if (!url) throw new Error(`PDF 资源不可用：${filename}`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`PDF 资源加载失败：${filename}`);
    return new Uint8Array(await response.arrayBuffer());
  }
}

export const PDF_DOCUMENT_OPTIONS = { useWorkerFetch: false, BinaryDataFactory: PdfBinaryDataFactory };
// Moon End
