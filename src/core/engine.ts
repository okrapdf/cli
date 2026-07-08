/**
 * parseDocument — the integration point: rasterize → parser (with injected client) → assemble.
 * @architect-owned contract; implementation is worker's (TDD per DESIGN.md #4).
 *
 * The engine knows about Parsers and the VlmClient interface — never about concrete
 * providers or transports (those are wired by the command layer and passed in).
 */

import type { DocumentParse } from './blocks.js';
import type { VlmClient } from './vlm.js';
// NOTE(worker): Parser/PageInput types live in ../parsers/types.js. Importing a TYPE from
// parsers/ into core is a one-way type-only exception to keep this signature honest;
// runtime imports remain forbidden (dependency rules). Use `import type`.
import type { Parser } from '../parsers/types.js';

export interface ParseDocumentOptions {
  parser: Parser;
  /** Injected when parser.spec.requires === 'vlm'. */
  vlm?: VlmClient;
  model?: string;
  providerId?: string;
  /** For parsers with requires === 'http'. */
  httpBaseUrl?: string;
  /** Merged over parser.spec.defaults. */
  settings?: Record<string, unknown>;
  /** 1-indexed inclusive page selection, e.g. { from: 1, to: 5 }. Omit = all pages. */
  pages?: { from: number; to: number };
  /** Bounded parallelism over pages. Default 4. */
  concurrency?: number;
  /** Retries per page on VlmHttpError 429/5xx with exponential backoff. Default 2. */
  retries?: number;
  /** Rasterization DPI. Default 175. */
  dpi?: number;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

/**
 * Contract (worker: each clause has a test):
 * - rasterizes via lib/pdf-image.ts (mupdf), pages in `pages` range only
 * - runs parser.parsePage under `concurrency` bound; page order in result is ascending
 *   regardless of completion order
 * - retry policy: VlmHttpError with status 429 or >=500 → retry up to `retries` with
 *   exponential backoff + jitter; other errors fail the page immediately
 * - a failed page (after retries) fails the whole run with a message naming the page
 * - usage = sum of page usages; meta.costUsd via providers/pricing when model is priced,
 *   else undefined; meta.warnings collects per-page anomalies (0 blocks decoded, etc.)
 */
export function parseDocument(
  _pdf: Uint8Array,
  _opts: ParseDocumentOptions,
): Promise<DocumentParse> {
  throw new Error('TODO(worker): implement per contract above — tests first');
}
