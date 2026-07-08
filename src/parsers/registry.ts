/**
 * Parser registry — static, like the provider catalog. The default parser is
 * just the first data row; swapping default = editing data, not code.
 * @architect-owned shape; extend by adding rows.
 */

import type { Parser } from './types.js';
import { layoutVlmParser } from './layout-vlm/index.js';

export const PARSERS: Parser[] = [layoutVlmParser];

export const DEFAULT_PARSER_ID = 'layout-vlm';

export function getParser(id: string): Parser | undefined {
  return PARSERS.find((p) => p.spec.id === id);
}
