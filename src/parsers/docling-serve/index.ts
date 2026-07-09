/**
 * docling-serve — a DOCUMENT-NATIVE parser (requires:'http'). Unlike the VLM parsers,
 * it takes the whole PDF and posts it to a running docling-serve instance, then decodes
 * the returned DoclingDocument. It implements `parseDocument` (not `parsePage`); the
 * engine PREFERS parseDocument and SKIPS rasterization (see PROPOSAL(spike) in
 * core/engine.ts + parsers/types.ts).
 *
 * SPIKE — sample for owner approval (see PROPOSAL.md). The HTTP shape below is sourced
 * from the docling-project docs (2026-07-08), NOT verified against a live server.
 *
 * Transport = global fetch only (no new deps), same as the VLM transports. On a non-2xx
 * (or a network error) it throws the core `VlmHttpError` — the retry currency the engine
 * keys on (429/5xx retried). (`VlmHttpError` is VLM-named but is really "the transport
 * error the engine retries on"; a rename is noted as an OPEN QUESTION in PROPOSAL.md.)
 */

import { defineParser, type ParserContext } from '../types.js';
import type { PageParse } from '../../core/blocks.js';
import { VlmHttpError } from '../../core/vlm.js';
import { decodeDoclingDocument, type DoclingDocument } from './decode.js';

/** Stable /v1 HTTP surface of docling-serve. */
const CONVERT_PATH = '/v1/convert/source';
const DEFAULT_TIMEOUT_MS = 120000;

interface DoclingConvertResponse {
  document?: { json_content?: DoclingDocument };
  status?: string;
  processing_time?: number;
  errors?: unknown[];
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

/** A short, single-line snippet of an error body for user-facing messages. */
function snippet(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (!trimmed) return '';
  return `: ${trimmed.slice(0, 200)}`;
}

function errorsSnippet(errors: unknown[] | undefined): string {
  if (!Array.isArray(errors) || errors.length === 0) return '';
  const parts = errors.map((e) => (typeof e === 'string' ? e : JSON.stringify(e)));
  return ` — errors: ${parts.join('; ').slice(0, 300)}`;
}

export const doclingServeParser = defineParser({
  spec: {
    id: 'docling-serve',
    displayName: 'docling-serve (document-native)',
    version: '0.1.0-spike',
    requires: 'http',
    defaults: { timeoutMs: DEFAULT_TIMEOUT_MS },
  },

  async parseDocument(pdf: Uint8Array, ctx: ParserContext): Promise<PageParse[]> {
    const baseUrl = (ctx.httpBaseUrl ?? '').replace(/\/+$/, '');
    if (!baseUrl) {
      // Programmer error: the command layer must supply a base URL for requires:'http' parsers.
      throw new Error(
        'docling-serve parser requires an HTTP base URL (ctx.httpBaseUrl) but none was injected. ' +
          'Pass --base-url <url> (or set DOCLING_SERVE_URL) — e.g. http://localhost:5001.',
      );
    }

    const base64 = Buffer.from(pdf).toString('base64');
    const body = JSON.stringify({
      options: { to_formats: ['json'] },
      file_sources: [{ base64_string: base64, filename: 'doc.pdf' }],
    });

    const timeoutMs =
      typeof ctx.settings.timeoutMs === 'number' ? ctx.settings.timeoutMs : DEFAULT_TIMEOUT_MS;
    const signal = ctx.signal
      ? AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs);

    const url = `${baseUrl}${CONVERT_PATH}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body,
        signal,
      });
    } catch (err) {
      // Network failure / timeout → retryable-shaped transport error (503) so the engine
      // retry policy can re-attempt a transient docling-serve hiccup.
      const detail = err instanceof Error ? err.message : String(err);
      throw new VlmHttpError(`docling-serve request to ${url} failed: ${detail}`, 503);
    }

    if (!res.ok) {
      const text = await safeText(res);
      throw new VlmHttpError(
        `docling-serve ${CONVERT_PATH} failed with HTTP ${res.status}${snippet(text)}`,
        res.status,
        text,
      );
    }

    const json = (await res.json()) as DoclingConvertResponse;
    if (json.status !== 'success') {
      // partial_success / skipped / failure all treated as failures in this sample —
      // whether partial_success should be decoded is an OPEN QUESTION in PROPOSAL.md.
      throw new Error(
        `docling-serve returned status "${json.status ?? 'unknown'}" (expected "success")` +
          errorsSnippet(json.errors) +
          '. Only a fully successful conversion is decoded in this spike.',
      );
    }

    const docJson = json.document?.json_content;
    if (!docJson) {
      throw new Error(
        'docling-serve reported status "success" but the response had no document.json_content — ' +
          'ensure options.to_formats includes "json".',
      );
    }

    return decodeDoclingDocument(docJson);
  },
});
