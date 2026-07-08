/**
 * rasterizePages — the engine's page-image source. A thin wrapper over the
 * self-contained lib/pdf-image.ts (mupdf wasm + sharp), producing the PageInput
 * shape parsers consume. DESIGN.md #4: the engine rasterizes via lib/pdf-image.ts.
 *
 * PageInput is a parser type; importing it as a TYPE ONLY mirrors the sanctioned
 * one-way exception used in engine.ts (no runtime import of parsers/ from core/).
 */
import type { PageInput } from '../parsers/types.js';
import { PdfImageRenderer } from '../lib/pdf-image.js';

/** PDF user-space unit is 1/72 inch, so scale = dpi / 72. */
const PDF_POINTS_PER_INCH = 72;

/** Default rasterization density (DESIGN.md ParseDocumentOptions.dpi default). */
export const DEFAULT_DPI = 175;

export interface RasterizeOptions {
  /** 1-indexed inclusive page selection. Omit → all pages. Clamped to the doc. */
  pages?: { from: number; to: number };
  /** Rasterization density. Default 175. */
  dpi?: number;
}

/**
 * Render selected PDF pages to PNG page images (1-indexed, ascending).
 * Bytes only touch mupdf/sharp here — never the network.
 */
export async function rasterizePages(
  pdf: Uint8Array,
  opts: RasterizeOptions = {},
): Promise<PageInput[]> {
  const dpi = opts.dpi ?? DEFAULT_DPI;
  const scale = dpi / PDF_POINTS_PER_INCH;

  // fromBuffer wants a Buffer; a Buffer is already a Uint8Array, so wrap-if-needed
  // without copying when the caller already handed us one.
  const buffer = Buffer.isBuffer(pdf) ? pdf : Buffer.from(pdf.buffer, pdf.byteOffset, pdf.byteLength);
  const renderer = await PdfImageRenderer.fromBuffer(buffer);
  try {
    const pageCount = renderer.getPageCount();
    const from = Math.max(1, opts.pages?.from ?? 1);
    const to = Math.min(pageCount, opts.pages?.to ?? pageCount);

    const out: PageInput[] = [];
    for (let page = from; page <= to; page++) {
      const rendered = await renderer.renderPage(page, { format: 'png', scale });
      out.push({ page, png: rendered.buffer, width: rendered.width, height: rendered.height });
    }
    return out;
  } finally {
    renderer.close();
  }
}
