/**
 * Parser registry — static, like the provider catalog. The default parser is
 * just the first data row; swapping default = editing data, not code.
 * @architect-owned shape; extend by adding rows.
 */

import type { Parser } from './types.js';
import { layoutVlmParser } from './layout-vlm/index.js';
import { doclingServeParser } from './docling-serve/index.js';

// docling-serve (SPIKE) is a data row like any other parser: inert unless the user passes
// `--parser docling-serve` + a base URL. Whether a document-native parser belongs in the
// default registry vs behind a flag/env is an OPEN QUESTION in docling-serve/PROPOSAL.md.
export const PARSERS: Parser[] = [layoutVlmParser, doclingServeParser];

export const DEFAULT_PARSER_ID = 'layout-vlm';

export function getParser(id: string): Parser | undefined {
  return PARSERS.find((p) => p.spec.id === id);
}
