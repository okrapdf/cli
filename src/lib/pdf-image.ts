/**
 * PDF to Image utilities for CLI
 *
 * Uses mupdf for PDF rendering and sharp for image processing.
 * This module is self-contained and doesn't depend on any APIs.
 */

import type SharpType from 'sharp';

// Dynamic imports for optional dependencies
let mupdfModule: typeof import('mupdf') | null = null;
let sharpFn: typeof SharpType | null = null;

async function getMupdf() {
  if (!mupdfModule) {
    try {
      mupdfModule = await import('mupdf');
    } catch {
      throw new Error(
        'mupdf is required for image export. Install it with: npm install mupdf'
      );
    }
  }
  return mupdfModule;
}

async function getSharp(): Promise<typeof SharpType> {
  if (!sharpFn) {
    try {
      const mod = await import('sharp');
      // Handle both ESM default export and CJS module.exports
      sharpFn = (mod.default || mod) as typeof SharpType;
    } catch {
      throw new Error(
        'sharp is required for image export. Install it with: npm install sharp'
      );
    }
  }
  return sharpFn;
}

/**
 * Bounding box in normalized coordinates (0-1)
 */
export interface NormalizedBbox {
  /** x position (0-1, left edge) */
  x: number;
  /** y position (0-1, top edge) */
  y: number;
  /** width (0-1) */
  width: number;
  /** height (0-1) */
  height: number;
}

/**
 * Alternative bbox format (xmin/ymin/xmax/ymax)
 */
export interface MinMaxBbox {
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
}

export type BboxFormat = NormalizedBbox | MinMaxBbox;

/**
 * Image export options
 */
export interface ImageExportOptions {
  /** Output format: 'png' or 'jpg' */
  format: 'png' | 'jpg';
  /** JPEG quality (1-100), only used for jpg format. Default: 90 */
  quality?: number;
  /** Scale factor for rendering. Higher = better quality but larger file. Default: 2 */
  scale?: number;
  /** Padding around the crop region in pixels. Default: 0 */
  padding?: number;
}

/**
 * Result of rendering a page region
 */
export interface RenderedImage {
  /** Image data as Buffer */
  buffer: Buffer;
  /** Image width in pixels */
  width: number;
  /** Image height in pixels */
  height: number;
  /** Format used */
  format: 'png' | 'jpg';
}

/**
 * Normalize bbox to x/y/width/height format
 */
function normalizeBbox(bbox: BboxFormat): NormalizedBbox {
  if ('xmin' in bbox) {
    return {
      x: bbox.xmin,
      y: bbox.ymin,
      width: bbox.xmax - bbox.xmin,
      height: bbox.ymax - bbox.ymin,
    };
  }
  return bbox;
}

/**
 * Cached page render result (PNG format for lossless cropping)
 */
interface CachedPage {
  buffer: Buffer;
  width: number;
  height: number;
}

/**
 * PDF Image Renderer
 *
 * Renders PDF pages to images and crops regions based on bounding boxes.
 * Includes page caching to avoid redundant renders when extracting multiple
 * regions from the same page.
 */
export class PdfImageRenderer {
  private document: any; // mupdf.Document
  private pdfBuffer: Buffer;
  /** Cache key: `${pageNumber}-${scale}` */
  private pageCache: Map<string, CachedPage> = new Map();

  private constructor(pdfBuffer: Buffer, document: any) {
    this.pdfBuffer = pdfBuffer;
    this.document = document;
  }

  /**
   * Create a renderer from a PDF buffer
   */
  static async fromBuffer(pdfBuffer: Buffer): Promise<PdfImageRenderer> {
    const mupdf = await getMupdf();
    const document = mupdf.Document.openDocument(pdfBuffer, 'application/pdf');
    return new PdfImageRenderer(pdfBuffer, document);
  }

  /**
   * Create a renderer from a PDF file path
   */
  static async fromFile(filePath: string): Promise<PdfImageRenderer> {
    const fs = await import('fs/promises');
    const buffer = await fs.readFile(filePath);
    return PdfImageRenderer.fromBuffer(buffer);
  }

  /**
   * Get the number of pages in the PDF
   */
  getPageCount(): number {
    return this.document.countPages();
  }

  /**
   * Get a cached page render, or render and cache it.
   * Always renders as PNG for lossless cropping operations.
   */
  private async getCachedPage(pageNumber: number, scale: number): Promise<CachedPage> {
    const cacheKey = `${pageNumber}-${scale}`;
    const cached = this.pageCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const sharp = await getSharp();

    // mupdf uses 0-based page index
    const pageIndex = pageNumber - 1;
    if (pageIndex < 0 || pageIndex >= this.getPageCount()) {
      throw new Error(`Invalid page number: ${pageNumber}. PDF has ${this.getPageCount()} pages.`);
    }

    const page = this.document.loadPage(pageIndex);
    const bounds = page.getBounds();
    const pageWidth = bounds[2] - bounds[0];
    const pageHeight = bounds[3] - bounds[1];

    // Render at scaled resolution
    const pixmap = page.toPixmap(
      [scale, 0, 0, scale, 0, 0], // transformation matrix for scaling
      mupdfModule!.ColorSpace.DeviceRGB,
      false, // no alpha
      true   // annotations
    );

    const pngData = pixmap.asPNG();
    const buffer = Buffer.from(pngData);
    const metadata = await sharp(buffer).metadata();

    const result: CachedPage = {
      buffer,
      width: metadata.width || Math.round(pageWidth * scale),
      height: metadata.height || Math.round(pageHeight * scale),
    };

    this.pageCache.set(cacheKey, result);
    return result;
  }

  /**
   * Render a full page to an image
   */
  async renderPage(
    pageNumber: number,
    options: Partial<ImageExportOptions> = {}
  ): Promise<RenderedImage> {
    const { format = 'png', quality = 90, scale = 2 } = options;
    const sharp = await getSharp();

    const cached = await this.getCachedPage(pageNumber, scale);

    // Convert to desired format
    let pipeline = sharp(cached.buffer);
    if (format === 'jpg') {
      pipeline = pipeline.jpeg({ quality });
    } else {
      pipeline = pipeline.png();
    }

    const buffer = await pipeline.toBuffer();

    return {
      buffer,
      width: cached.width,
      height: cached.height,
      format,
    };
  }

  /**
   * Render a cropped region from a page
   */
  async renderRegion(
    pageNumber: number,
    bbox: BboxFormat,
    options: Partial<ImageExportOptions> = {}
  ): Promise<RenderedImage> {
    const { format = 'png', quality = 90, scale = 2, padding = 0 } = options;
    const sharp = await getSharp();
    const normalizedBbox = normalizeBbox(bbox);

    // Get cached page render (or render and cache)
    const fullPage = await this.getCachedPage(pageNumber, scale);

    // Calculate crop coordinates in pixels
    const cropX = Math.max(0, Math.floor(normalizedBbox.x * fullPage.width) - padding);
    const cropY = Math.max(0, Math.floor(normalizedBbox.y * fullPage.height) - padding);
    const cropWidth = Math.min(
      fullPage.width - cropX,
      Math.ceil(normalizedBbox.width * fullPage.width) + padding * 2
    );
    const cropHeight = Math.min(
      fullPage.height - cropY,
      Math.ceil(normalizedBbox.height * fullPage.height) + padding * 2
    );

    // Crop the region
    let pipeline = sharp(fullPage.buffer).extract({
      left: cropX,
      top: cropY,
      width: cropWidth,
      height: cropHeight,
    });

    // Convert to desired format
    if (format === 'jpg') {
      pipeline = pipeline.jpeg({ quality });
    } else {
      pipeline = pipeline.png();
    }

    const buffer = await pipeline.toBuffer();
    const metadata = await sharp(buffer).metadata();

    return {
      buffer,
      width: metadata.width || cropWidth,
      height: metadata.height || cropHeight,
      format,
    };
  }

  /**
   * Clear the page cache to free memory
   */
  clearCache(): void {
    this.pageCache.clear();
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { pages: number; estimatedBytes: number } {
    let estimatedBytes = 0;
    for (const page of this.pageCache.values()) {
      estimatedBytes += page.buffer.length;
    }
    return {
      pages: this.pageCache.size,
      estimatedBytes,
    };
  }

  /**
   * Close the document and free resources
   */
  close(): void {
    // Clear the page cache
    this.pageCache.clear();
    // mupdf handles cleanup automatically via garbage collection
    // but we can help by clearing references
    this.document = null;
  }
}

/**
 * Convenience function to render a region from a PDF file
 */
export async function renderPdfRegion(
  pdfPath: string,
  pageNumber: number,
  bbox: BboxFormat,
  options: Partial<ImageExportOptions> = {}
): Promise<RenderedImage> {
  const renderer = await PdfImageRenderer.fromFile(pdfPath);
  try {
    return await renderer.renderRegion(pageNumber, bbox, options);
  } finally {
    renderer.close();
  }
}

/**
 * Convenience function to render a region from a PDF buffer
 */
export async function renderPdfRegionFromBuffer(
  pdfBuffer: Buffer,
  pageNumber: number,
  bbox: BboxFormat,
  options: Partial<ImageExportOptions> = {}
): Promise<RenderedImage> {
  const renderer = await PdfImageRenderer.fromBuffer(pdfBuffer);
  try {
    return await renderer.renderRegion(pageNumber, bbox, options);
  } finally {
    renderer.close();
  }
}
