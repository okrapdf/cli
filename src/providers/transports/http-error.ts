/**
 * Shared non-2xx → VlmHttpError construction for the transports (#15). Keeps the raw
 * `body` on the error (unchanged) AND folds a trimmed, single-line snippet of it into
 * the human-facing message, so the CLI shows the provider's own explanation (a bad key,
 * a quota message, …) instead of a bare "HTTP 400".
 *
 * providers/** may import core/** only (dependency rule 2); this is providers-internal.
 */

import { VlmHttpError } from '../../core/vlm.js';

/** Collapse a response body to a single-line, ≤`max`-char snippet for error messages. */
export function bodySnippet(body: string | undefined, max = 200): string {
  if (!body) return '';
  const oneLine = body.replace(/\s+/g, ' ').trim();
  if (!oneLine) return '';
  return oneLine.length > max ? oneLine.slice(0, max - 1) + '…' : oneLine;
}

/** Build a VlmHttpError whose message includes a trimmed body snippet when one is present. */
export function vlmHttpError(
  baseMessage: string,
  status: number,
  body: string | undefined,
): VlmHttpError {
  const snippet = bodySnippet(body);
  return new VlmHttpError(snippet ? `${baseMessage}: ${snippet}` : baseMessage, status, body);
}
