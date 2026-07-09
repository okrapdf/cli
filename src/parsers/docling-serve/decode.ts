/**
 * Decode a DoclingDocument (docling-serve `document.json_content`) into okra's
 * per-page PageParse[]. Pure functions — the golden-test surface, mirroring
 * `layout-vlm/decode.ts`.
 *
 * SPIKE — sample for owner approval (see PROPOSAL.md). API shapes are sourced from
 * the docling-project docs (2026-07-08), NOT verified against a live docling-serve
 * instance. Pre-merge gate: run docling-serve against a real PDF and diff this decode.
 *
 * Reading order comes from walking `body.children[]` (RefItems `{ $ref: "#/texts/0" }`);
 * groups nest and are resolved recursively. Flat item arrays (`texts`, `tables`,
 * `pictures`) hold the actual DocItems. The deprecated `furniture` subtree is ignored.
 *
 * We reuse `canonicalLabel` + `itemsToMarkdown` from the layout-vlm parser (same zone).
 * Whether those shared label/markdown utilities should move to core is an OPEN QUESTION
 * in PROPOSAL.md (they are the natural cross-parser seam).
 */

import type { Bbox, LayoutBlock, PageParse } from '../../core/blocks.js';
import { canonicalLabel } from '../layout-vlm/prompts.js';
import { itemsToMarkdown, type RawBlock } from '../layout-vlm/decode.js';

/** docling BoundingBox: l/r are x (left/right); t/b are y whose meaning depends on origin. */
export type CoordOrigin = 'BOTTOMLEFT' | 'TOPLEFT';
export interface DoclingBbox {
  l: number;
  t: number;
  r: number;
  b: number;
  /** docling's native default is BOTTOMLEFT; any non-'TOPLEFT' value is treated as such. */
  coord_origin?: CoordOrigin | string;
}

export interface DoclingProv {
  page_no: number;
  bbox: DoclingBbox;
  charspan?: [number, number];
}

export interface DoclingRef {
  $ref: string;
}

export interface DoclingTableCell {
  text?: string;
  start_row_offset_idx?: number;
  end_row_offset_idx?: number;
  start_col_offset_idx?: number;
  end_col_offset_idx?: number;
}

export interface DoclingTableData {
  num_rows?: number;
  num_cols?: number;
  /** The canonical serialized form: a flat list carrying row/col offsets. */
  table_cells?: DoclingTableCell[];
  /** Alternative computed 2-D form some exports include. */
  grid?: DoclingTableCell[][];
}

export interface DoclingItem {
  self_ref?: string;
  label?: string;
  text?: string;
  prov?: DoclingProv[];
  /** tables only. */
  data?: DoclingTableData;
  /** groups (and some items) reference their children by $ref. */
  children?: DoclingRef[];
}

export interface DoclingPage {
  size?: { width?: number; height?: number };
}

export interface DoclingDocument {
  body?: { children?: DoclingRef[] };
  texts?: DoclingItem[];
  tables?: DoclingItem[];
  pictures?: DoclingItem[];
  groups?: DoclingItem[];
  /** keyed by page-number STRING → page metadata (incl. size in PDF points). */
  pages?: Record<string, DoclingPage>;
}

/** Fallback page size (US Letter points) used only when a page omits its size. */
const DEFAULT_PAGE_WIDTH = 612;
const DEFAULT_PAGE_HEIGHT = 792;

/** Which flat arrays a $ref can resolve into. `groups` are containers (recursed, not emitted). */
const REF_ARRAYS = new Set(['texts', 'tables', 'pictures', 'groups']);

const clamp0to1000 = (n: number): number => Math.max(0, Math.min(1000, n));

/**
 * The ONE origin-flip + normalize function. Converts a docling bbox (PDF points, either
 * coordinate origin) to okra's [x1,y1,x2,y2] normalized 0-1000, top-left origin.
 *
 * X is origin-independent. For Y:
 *  - TOPLEFT: t/b already measured from the top; top edge = min(t,b).
 *  - BOTTOMLEFT (docling native, and the default for any unknown origin): y grows upward,
 *    so flip each coordinate via (H - y). The top edge becomes min(H-t, H-b).
 * min/max makes the result robust to either raw ordering of t/b (or l/r), and guarantees
 * the returned rectangle has y1 < y2 (top above bottom) and x1 < x2.
 */
export function doclingBboxToNormalized(
  bbox: DoclingBbox,
  pageWidth: number,
  pageHeight: number,
): Bbox {
  const W = pageWidth > 0 ? pageWidth : DEFAULT_PAGE_WIDTH;
  const H = pageHeight > 0 ? pageHeight : DEFAULT_PAGE_HEIGHT;
  const { l, t, r, b } = bbox;

  const xLeft = Math.min(l, r);
  const xRight = Math.max(l, r);

  let yTop: number;
  let yBottom: number;
  if (bbox.coord_origin === 'TOPLEFT') {
    yTop = Math.min(t, b);
    yBottom = Math.max(t, b);
  } else {
    // BOTTOMLEFT (and any unrecognized origin — docling defaults to bottom-left).
    const flippedT = H - t;
    const flippedB = H - b;
    yTop = Math.min(flippedT, flippedB);
    yBottom = Math.max(flippedT, flippedB);
  }

  const sx = (v: number): number => clamp0to1000(Math.round((v / W) * 1000));
  const sy = (v: number): number => clamp0to1000(Math.round((v / H) * 1000));
  return [sx(xLeft), sy(yTop), sx(xRight), sy(yBottom)];
}

/** Resolve a RefItem `$ref` (`#/texts/0`) to its flat-array entry. */
export function resolveRef(
  doc: DoclingDocument,
  ref: string,
): { kind: string; item: DoclingItem; key: string } | null {
  const m = /^#\/([a-zA-Z_]+)\/(\d+)$/.exec(ref);
  if (!m) return null;
  const kind = m[1];
  if (!REF_ARRAYS.has(kind)) return null;
  const idx = Number.parseInt(m[2], 10);
  const arr = (doc as Record<string, unknown>)[kind];
  if (!Array.isArray(arr)) return null;
  const item = arr[idx] as DoclingItem | undefined;
  if (!item) return null;
  return { kind, item, key: `${kind}/${idx}` };
}

/**
 * Walk `body.children[]` in reading order, resolving refs recursively. Groups emit
 * nothing themselves — their children are spliced in place. texts/tables/pictures are
 * the emitted leaves. A `seen` set guards against ref cycles / shared (DAG) children,
 * and a depth cap guards pathological nesting. `furniture` is never entered.
 */
export function walkReadingOrder(doc: DoclingDocument): DoclingItem[] {
  const out: DoclingItem[] = [];
  const seen = new Set<string>();

  const visit = (refs: DoclingRef[] | undefined, depth: number): void => {
    if (!refs || depth > 50) return;
    for (const ref of refs) {
      if (!ref || typeof ref.$ref !== 'string') continue;
      const resolved = resolveRef(doc, ref.$ref);
      if (!resolved || seen.has(resolved.key)) continue;
      seen.add(resolved.key);
      if (resolved.kind === 'groups') {
        visit(resolved.item.children, depth + 1);
      } else {
        out.push(resolved.item);
      }
    }
  };

  visit(doc.body?.children, 0);
  return out;
}

/**
 * Table → plain text for THIS sample: cells joined row-wise with ` | `, rows with `\n`.
 * Prefers the serialized `table_cells` (grouping by row offset, ordering by col offset);
 * falls back to a 2-D `grid`. HTML/markdown table reconstruction (and merged-cell span
 * handling) is left as an OPEN QUESTION in PROPOSAL.md.
 */
export function tableToText(data: DoclingTableData | undefined): string {
  const cells = data?.table_cells;
  if (Array.isArray(cells) && cells.length > 0) {
    const rows = new Map<number, { col: number; text: string }[]>();
    for (const c of cells) {
      const row = c.start_row_offset_idx ?? 0;
      const col = c.start_col_offset_idx ?? 0;
      const text = (c.text ?? '').trim();
      if (!rows.has(row)) rows.set(row, []);
      rows.get(row)!.push({ col, text });
    }
    return [...rows.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, cs]) => cs.sort((a, b) => a.col - b.col).map((c) => c.text).join(' | '))
      .join('\n');
  }

  const grid = data?.grid;
  if (Array.isArray(grid) && grid.length > 0) {
    return grid
      .map((row) => (Array.isArray(row) ? row.map((c) => (c?.text ?? '').trim()).join(' | ') : ''))
      .join('\n');
  }

  return '';
}

function pageSizeFor(doc: DoclingDocument, page: number): { width: number; height: number } {
  const size = doc.pages?.[String(page)]?.size;
  const w = size?.width;
  const h = size?.height;
  return {
    width: typeof w === 'number' && w > 0 ? w : DEFAULT_PAGE_WIDTH,
    height: typeof h === 'number' && h > 0 ? h : DEFAULT_PAGE_HEIGHT,
  };
}

/**
 * Decode a DoclingDocument into per-page PageParse[], pages ascending. Blocks within a
 * page are in reading order (the body-walk order filtered to that page). Items with no
 * placeable prov are skipped (an OPEN QUESTION: multi-prov / cross-page spans). Per-page
 * markdown comes from the reused `itemsToMarkdown`. `usage` is omitted — docling reports
 * no token usage.
 */
export function decodeDoclingDocument(doc: DoclingDocument): PageParse[] {
  const items = walkReadingOrder(doc);

  const perPage = new Map<number, RawBlock[]>();
  const pageOrder: number[] = [];

  for (const item of items) {
    const prov = item.prov?.[0];
    if (!prov || typeof prov.page_no !== 'number') continue;
    const page = prov.page_no;
    const { width, height } = pageSizeFor(doc, page);

    const rawLabel = item.label ?? 'text';
    const label = canonicalLabel(rawLabel);
    const text = rawLabel === 'table' ? tableToText(item.data) : item.text ?? '';
    const bbox = doclingBboxToNormalized(prov.bbox, width, height);

    if (!perPage.has(page)) {
      perPage.set(page, []);
      pageOrder.push(page);
    }
    perPage.get(page)!.push({ bbox, label, text, page });
  }

  pageOrder.sort((a, b) => a - b);

  return pageOrder.map((page) => {
    const raws = perPage.get(page)!;
    const blocks: LayoutBlock[] = raws.map((r) => ({
      label: r.label,
      bbox: r.bbox as Bbox,
      text: r.text,
      page,
    }));
    const markdown = itemsToMarkdown(raws);
    return { page, markdown, blocks };
  });
}
