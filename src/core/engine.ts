/**
 * parseDocument — the integration point: rasterize → parser (with injected client) → assemble.
 * @architect-owned contract; implementation is worker's (TDD per DESIGN.md #4).
 *
 * The engine knows about Parsers and the VlmClient interface — never about concrete
 * providers or transports (those are wired by the command layer and passed in).
 */

import type { DocumentParse, TokenUsage, PageParse, ParseRunMeta, LayoutBlock } from './blocks.js';
import { addUsage, EMPTY_USAGE } from './blocks.js';
import type { VlmClient } from './vlm.js';
import { VlmHttpError } from './vlm.js';
// NOTE(worker): Parser/PageInput/ParserContext types live in ../parsers/types.js. Importing a
// TYPE from parsers/ into core is a one-way type-only exception to keep this signature honest;
// runtime imports of parsers/ remain forbidden (dependency rules). Use `import type`.
import type { Parser, ParserContext, PageInput } from '../parsers/types.js';
// rasterize is core-internal (it wraps lib/pdf-image.ts, the sanctioned rasterization path);
// core→core runtime imports are allowed.
import { rasterizePages } from './rasterize.js';

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
  /**
   * Cost hook. The engine must NOT import providers/pricing at runtime (dependency
   * rule 3: core imports nothing outside core). The command layer passes
   * `providers/pricing.costUsdOrUndefined`; returns `undefined` for an unpriced model
   * (never guessed, never 0-for-unknown → meta.costUsd omitted).
   *
   * Added per worker CONTRACT-NOTE (architect pre-approved exactly this field) — DESIGN.md #4.
   */
  pricing?: (model: string, usage: TokenUsage) => number | undefined;
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
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_RETRIES = 2;
const BACKOFF_BASE_MS = 250;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Retry only transient VLM failures: 429 (rate limit) and 5xx (upstream). */
function isRetryable(err: unknown): boolean {
  return err instanceof VlmHttpError && (err.status === 429 || err.status >= 500);
}

/**
 * A page that failed after all attempts. Carries the count of attempts ACTUALLY made
 * (#15 — the message must not claim retries that never ran) and the underlying HTTP
 * status, so the command layer can add an auth hint for 400/401/403.
 */
export class PageParseError extends Error {
  constructor(
    message: string,
    readonly page: number,
    /** Attempts actually made (1 = failed on the first try, no retries). */
    readonly attempts: number,
    /** Underlying transport HTTP status, when the failure was a VlmHttpError. */
    readonly status?: number,
  ) {
    super(message);
    this.name = 'PageParseError';
  }
}

async function parsePageWithRetry(
  parser: Parser,
  input: PageInput,
  ctx: ParserContext,
  retries: number,
): Promise<PageParse> {
  let attempt = 0;
  for (;;) {
    try {
      return await parser.parsePage(input, ctx);
    } catch (err) {
      attempt++; // count the try we just made
      if (!isRetryable(err) || attempt > retries) {
        // Report the attempts actually made — never the `retries` setting (the old bug:
        // a non-retryable 400 ran once but the message claimed "after N retries").
        const detail = err instanceof Error ? err.message : String(err);
        const status = err instanceof VlmHttpError ? err.status : undefined;
        throw new PageParseError(
          `Failed to parse page ${input.page} after ${attempt} ${attempt === 1 ? 'attempt' : 'attempts'}: ${detail}`,
          input.page,
          attempt,
          status,
        );
      }
      // exponential backoff with full jitter: rand(0, base·2^(attempt-1)).
      const ceiling = BACKOFF_BASE_MS * 2 ** (attempt - 1);
      await sleep(ceiling + Math.random() * ceiling);
    }
  }
}

export async function parseDocument(
  pdf: Uint8Array,
  opts: ParseDocumentOptions,
): Promise<DocumentParse> {
  const startedAt = Date.now();
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const settings = { ...opts.parser.spec.defaults, ...(opts.settings ?? {}) };

  const inputs = await rasterizePages(pdf, { pages: opts.pages, dpi: opts.dpi });
  const total = inputs.length;

  const ctx: ParserContext = {
    vlm: opts.vlm,
    model: opts.model,
    providerId: opts.providerId,
    httpBaseUrl: opts.httpBaseUrl,
    settings,
    signal: opts.signal,
  };

  // Bounded worker pool: at most `concurrency` runners, each pulling the next page
  // index until exhausted. Results land by index → ascending order regardless of
  // completion order. First failure stops new work and rejects the whole run.
  const results: PageParse[] = new Array(total);
  let done = 0;
  let cursor = 0;
  let firstError: unknown;

  const runner = async (): Promise<void> => {
    while (firstError === undefined) {
      const idx = cursor++;
      if (idx >= total) return;
      const input = inputs[idx];
      try {
        results[idx] = await parsePageWithRetry(opts.parser, input, ctx, retries);
        done++;
        opts.onProgress?.(done, total);
      } catch (err) {
        // parsePageWithRetry already composed a page-naming message with the attempts
        // actually made + the underlying status; keep the first failure verbatim.
        if (firstError === undefined) firstError = err;
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, () => runner()));
  if (firstError !== undefined) throw firstError;

  const pages = results;
  const blocks: LayoutBlock[] = pages.flatMap((p) => p.blocks);
  let usage = EMPTY_USAGE;
  for (const p of pages) usage = addUsage(usage, p.usage);
  const markdown = pages.map((p) => p.markdown).join('\n\n');

  const warnings: string[] = [];
  for (const p of pages) {
    if (p.blocks.length === 0) warnings.push(`page ${p.page}: 0 blocks decoded`);
  }

  // Cost via the injected hook only — the engine never imports providers/pricing.
  // undefined for an unpriced model (never guessed, never 0-for-unknown).
  const costUsd =
    opts.pricing && opts.model !== undefined ? opts.pricing(opts.model, usage) : undefined;

  const meta: ParseRunMeta = {
    parserId: opts.parser.spec.id,
    providerId: opts.providerId,
    model: opts.model,
    pageCount: total,
    durationMs: Date.now() - startedAt,
    costUsd,
    warnings,
  };

  return { markdown, pages, blocks, usage, meta };
}
