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
  /**
   * When EVERY page decodes 0 blocks, parseDocument rejects (the model almost certainly
   * doesn't fit the layout-block prompt — transport worked, output didn't) instead of
   * returning an empty-but-"successful" result. Set true to keep the empty result
   * (exposed as `okra parse --allow-empty`). Default false. (#13)
   *
   * Added per worker CONTRACT-NOTE (architect pre-approved exactly this field) — issue #13.
   */
  allowEmpty?: boolean;
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
      // parsePage presence is guaranteed by parseDocument()'s entry-point guard before
      // this per-page path runs (PROPOSAL(spike): parsePage is now optional on Parser).
      return await parser.parsePage!(input, ctx);
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

/**
 * PROPOSAL(spike): whole-document retry for document-native parsers. Mirrors
 * parsePageWithRetry but wraps the single parseDocument call; the failure names the
 * document (no page). Same retry currency (VlmHttpError 429/5xx via isRetryable).
 */
async function parseWholeDocumentWithRetry(
  parser: Parser,
  pdf: Uint8Array,
  ctx: ParserContext,
  retries: number,
): Promise<PageParse[]> {
  let attempt = 0;
  for (;;) {
    try {
      // presence guaranteed by parseDocument()'s entry-point dispatch below.
      return await parser.parseDocument!(pdf, ctx);
    } catch (err) {
      attempt++;
      if (!isRetryable(err) || attempt > retries) {
        const detail = err instanceof Error ? err.message : String(err);
        const status = err instanceof VlmHttpError ? err.status : undefined;
        throw new PageParseError(
          `Failed to parse document after ${attempt} ${attempt === 1 ? 'attempt' : 'attempts'}: ${detail}`,
          0, // whole-document failure — no single page
          attempt,
          status,
        );
      }
      const ceiling = BACKOFF_BASE_MS * 2 ** (attempt - 1);
      await sleep(ceiling + Math.random() * ceiling);
    }
  }
}

/**
 * Assemble decoded PageParse[] into a DocumentParse. Shared by BOTH the per-page pool and
 * the document-native path so the all-zero-blocks guard, usage summation, warnings, cost,
 * and meta are identical regardless of parser kind (PROPOSAL(spike)).
 */
function assembleDocument(
  pages: PageParse[],
  opts: ParseDocumentOptions,
  startedAt: number,
): DocumentParse {
  const total = pages.length;
  const blocks: LayoutBlock[] = pages.flatMap((p) => p.blocks);
  let usage = EMPTY_USAGE;
  for (const p of pages) usage = addUsage(usage, p.usage);
  const markdown = pages.map((p) => p.markdown).join('\n\n');

  const warnings: string[] = [];
  for (const p of pages) {
    if (p.blocks.length === 0) warnings.push(`page ${p.page}: 0 blocks decoded`);
  }

  // #13 — a run where EVERY page decoded 0 blocks is almost always a wrong/unsupported
  // model: the transport worked (the model answered) but its output didn't match the
  // layout-block format, so nothing decoded. Fail loudly instead of returning an
  // empty-but-"successful" result — unless the caller opted into empties (--allow-empty).
  // Partial zero-block pages stay warnings (above). `blocks` is the flat all-page list,
  // so blocks.length === 0 ⟺ every page decoded zero.
  if (total > 0 && blocks.length === 0 && !opts.allowEmpty) {
    const modelName = opts.model ?? '(default model)';
    throw new Error(
      `Parsed ${total} page${total === 1 ? '' : 's'} with model "${modelName}" but decoded 0 layout blocks total. ` +
        `The model responded (${usage.outputTokens} output tokens) — its output just didn't contain the expected ` +
        `layout blocks, so nothing decoded. Try a different --model or --provider (some vision models don't follow ` +
        `the layout-block prompt), or re-run with --allow-empty to keep the empty result.`,
    );
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

export async function parseDocument(
  pdf: Uint8Array,
  opts: ParseDocumentOptions,
): Promise<DocumentParse> {
  const startedAt = Date.now();
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const settings = { ...opts.parser.spec.defaults, ...(opts.settings ?? {}) };

  // PROPOSAL(spike): a parser must implement exactly one entry point.
  if (!opts.parser.parseDocument && !opts.parser.parsePage) {
    throw new Error(
      `Parser '${opts.parser.spec.id}' implements neither parseDocument nor parsePage — one is required.`,
    );
  }

  const ctx: ParserContext = {
    vlm: opts.vlm,
    model: opts.model,
    providerId: opts.providerId,
    httpBaseUrl: opts.httpBaseUrl,
    settings,
    signal: opts.signal,
  };

  // PROPOSAL(spike): DOCUMENT-NATIVE dispatch. When the parser implements parseDocument
  // (docling-serve, requires:'http'), hand it the whole PDF in ONE call and SKIP
  // rasterization + the per-page pool (rasterizing would waste docling's native text
  // layer). Retries wrap the single call; assembly is shared with the per-page path.
  if (opts.parser.parseDocument) {
    const pages = await parseWholeDocumentWithRetry(opts.parser, pdf, ctx, retries);
    opts.onProgress?.(pages.length, pages.length);
    return assembleDocument(pages, opts, startedAt);
  }

  // Per-page VLM path (unchanged).
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
  const inputs = await rasterizePages(pdf, { pages: opts.pages, dpi: opts.dpi });
  const total = inputs.length;

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

  return assembleDocument(results, opts, startedAt);
}
