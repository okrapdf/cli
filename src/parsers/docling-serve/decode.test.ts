/**
 * docling-serve decode goldens (SPIKE). Pure, offline. Covers the bbox origin-flip +
 * normalize (both origins, exhaustively), ref resolution, the reading-order walk
 * (group recursion, furniture ignored, cycle guard), the table cell-join rule, and a
 * full golden against the hand-built `test/fixtures/docling-document.json` fixture
 * (nested group refs, a table, unknown-label passthrough, BOTTOMLEFT bboxes).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  doclingBboxToNormalized,
  resolveRef,
  walkReadingOrder,
  tableToText,
  decodeDoclingDocument,
  type DoclingDocument,
} from './decode.js';

const FIXTURE = fileURLToPath(new URL('../../../test/fixtures/docling-document.json', import.meta.url));
const fixture = (): DoclingDocument => JSON.parse(readFileSync(FIXTURE, 'utf8')) as DoclingDocument;

describe('doclingBboxToNormalized — origin flip + normalize', () => {
  it('BOTTOMLEFT: flips Y via (H - y) and scales to 0-1000 top-left', () => {
    // 600x800 page; l/r=60/540 → x 100/900; t/b=760/720 (top higher up) → 50/100 top-left.
    expect(
      doclingBboxToNormalized({ l: 60, t: 760, r: 540, b: 720, coord_origin: 'BOTTOMLEFT' }, 600, 800),
    ).toEqual([100, 50, 900, 100]);
  });

  it('TOPLEFT: keeps Y as-is (top edge = min(t,b)) and scales', () => {
    expect(
      doclingBboxToNormalized({ l: 60, t: 40, r: 540, b: 80, coord_origin: 'TOPLEFT' }, 600, 800),
    ).toEqual([100, 50, 900, 100]);
  });

  it('the SAME visual rectangle maps identically from either origin', () => {
    // top-left rect: x[100,300], y[100,200] from the top, on a 1000x1000 page.
    const topLeft = doclingBboxToNormalized(
      { l: 100, t: 100, r: 300, b: 200, coord_origin: 'TOPLEFT' },
      1000,
      1000,
    );
    // same rect, bottom-left origin: top edge 100-from-top = 900-from-bottom, bottom = 800.
    const bottomLeft = doclingBboxToNormalized(
      { l: 100, t: 900, r: 300, b: 800, coord_origin: 'BOTTOMLEFT' },
      1000,
      1000,
    );
    expect(topLeft).toEqual([100, 100, 300, 200]);
    expect(bottomLeft).toEqual([100, 100, 300, 200]);
  });

  it('always returns an ordered rectangle (x1<x2, y1<y2) for both origins', () => {
    const bl = doclingBboxToNormalized({ l: 10, t: 700, r: 200, b: 600, coord_origin: 'BOTTOMLEFT' }, 1000, 1000);
    const tl = doclingBboxToNormalized({ l: 10, t: 300, r: 200, b: 400, coord_origin: 'TOPLEFT' }, 1000, 1000);
    for (const [x1, y1, x2, y2] of [bl, tl]) {
      expect(x1).toBeLessThan(x2);
      expect(y1).toBeLessThan(y2);
    }
  });

  it('is robust to reversed t/b or l/r inputs (min/max normalizes them)', () => {
    // b>t in a claimed BOTTOMLEFT, and r<l — still yields the same ordered box.
    expect(
      doclingBboxToNormalized({ l: 300, t: 600, r: 100, b: 700, coord_origin: 'BOTTOMLEFT' }, 1000, 1000),
    ).toEqual([100, 300, 300, 400]);
  });

  it('treats an unknown / missing coord_origin as BOTTOMLEFT (docling default)', () => {
    const unknown = doclingBboxToNormalized({ l: 100, t: 900, r: 300, b: 800 }, 1000, 1000);
    const explicit = doclingBboxToNormalized(
      { l: 100, t: 900, r: 300, b: 800, coord_origin: 'BOTTOMLEFT' },
      1000,
      1000,
    );
    expect(unknown).toEqual(explicit);
  });

  it('clamps coordinates that fall outside the page to [0,1000]', () => {
    const box = doclingBboxToNormalized({ l: -50, t: 2000, r: 1200, b: 500, coord_origin: 'TOPLEFT' }, 1000, 1000);
    for (const v of box) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1000);
    }
    expect(box).toEqual([0, 500, 1000, 1000]);
  });

  it('falls back to Letter dims when a page size is non-positive (no divide-by-zero)', () => {
    const box = doclingBboxToNormalized({ l: 306, t: 396, r: 306, b: 396, coord_origin: 'TOPLEFT' }, 0, 0);
    // 306/612=0.5 → 500; 396/792=0.5 → 500.
    expect(box).toEqual([500, 500, 500, 500]);
  });
});

describe('resolveRef', () => {
  const doc: DoclingDocument = {
    texts: [{ label: 'text', text: 'a' }],
    groups: [{ label: 'list', children: [] }],
  };
  it('resolves a valid ref into its flat array', () => {
    expect(resolveRef(doc, '#/texts/0')?.item.text).toBe('a');
    expect(resolveRef(doc, '#/texts/0')?.key).toBe('texts/0');
    expect(resolveRef(doc, '#/groups/0')?.kind).toBe('groups');
  });
  it('returns null for a malformed ref, an out-of-range index, or an unknown array', () => {
    expect(resolveRef(doc, 'texts/0')).toBeNull();
    expect(resolveRef(doc, '#/texts/9')).toBeNull();
    expect(resolveRef(doc, '#/furniture/0')).toBeNull();
  });
});

describe('walkReadingOrder', () => {
  it('flattens body.children in order, splicing group children in place', () => {
    const doc: DoclingDocument = {
      body: {
        children: [{ $ref: '#/texts/0' }, { $ref: '#/groups/0' }, { $ref: '#/texts/3' }],
      },
      groups: [{ label: 'list', children: [{ $ref: '#/texts/1' }, { $ref: '#/texts/2' }] }],
      texts: [
        { label: 'title', text: 't0' },
        { label: 'list_item', text: 't1' },
        { label: 'list_item', text: 't2' },
        { label: 'text', text: 't3' },
      ],
    };
    expect(walkReadingOrder(doc).map((i) => i.text)).toEqual(['t0', 't1', 't2', 't3']);
  });

  it('never enters furniture (only body.children is walked)', () => {
    const doc: DoclingDocument = {
      body: { children: [{ $ref: '#/texts/0' }] },
      texts: [{ label: 'text', text: 'body' }, { label: 'page_footer', text: 'furniture' }],
    };
    // texts/1 is only reachable via a furniture subtree, which we never walk.
    expect(walkReadingOrder(doc).map((i) => i.text)).toEqual(['body']);
  });

  it('guards against a group ref cycle (visits each ref once)', () => {
    const doc: DoclingDocument = {
      body: { children: [{ $ref: '#/groups/0' }] },
      groups: [{ label: 'list', children: [{ $ref: '#/texts/0' }, { $ref: '#/groups/0' }] }],
      texts: [{ label: 'text', text: 'once' }],
    };
    expect(walkReadingOrder(doc).map((i) => i.text)).toEqual(['once']);
  });
});

describe('tableToText', () => {
  it('joins table_cells row-wise with " | ", rows with newlines, ordered by offsets', () => {
    expect(
      tableToText({
        num_rows: 2,
        num_cols: 2,
        table_cells: [
          { text: 'Value', start_row_offset_idx: 0, start_col_offset_idx: 1 },
          { text: 'Metric', start_row_offset_idx: 0, start_col_offset_idx: 0 },
          { text: '$1.2M', start_row_offset_idx: 1, start_col_offset_idx: 1 },
          { text: 'Revenue', start_row_offset_idx: 1, start_col_offset_idx: 0 },
        ],
      }),
    ).toBe('Metric | Value\nRevenue | $1.2M');
  });

  it('falls back to a 2-D grid when table_cells is absent', () => {
    expect(
      tableToText({ grid: [[{ text: 'A' }, { text: 'B' }], [{ text: 'C' }, { text: 'D' }]] }),
    ).toBe('A | B\nC | D');
  });

  it('returns empty string for an empty / missing table', () => {
    expect(tableToText(undefined)).toBe('');
    expect(tableToText({})).toBe('');
  });
});

describe('decodeDoclingDocument — fixture golden', () => {
  it('splits into 2 pages, ascending', () => {
    const pages = decodeDoclingDocument(fixture());
    expect(pages.map((p) => p.page)).toEqual([1, 2]);
  });

  it('page 1 blocks are in reading order with group list-items spliced in', () => {
    const [p1] = decodeDoclingDocument(fixture());
    expect(p1.blocks.map((b) => b.label)).toEqual([
      'Title',
      'Section-header',
      'Text',
      'List-item',
      'List-item',
      'Table',
    ]);
    expect(p1.blocks.map((b) => b.text)).toEqual([
      'Quarterly Report 2025',
      'Overview',
      'This report summarizes fiscal year 2025.',
      'First item',
      'Second item',
      'Metric | Value\nRevenue | $1.2M',
    ]);
  });

  it('page 2 keeps the unknown "code" label verbatim (passthrough) and picture stays a block', () => {
    const [, p2] = decodeDoclingDocument(fixture());
    expect(p2.blocks.map((b) => b.label)).toEqual([
      'Page-header',
      'Picture',
      'Caption',
      'code',
      'Footnote',
    ]);
    // picture carries empty text but is still a layout block.
    expect(p2.blocks[1]).toMatchObject({ label: 'Picture', text: '' });
  });

  it('never emits the furniture subtree item', () => {
    const all = decodeDoclingDocument(fixture()).flatMap((p) => p.blocks);
    expect(all.some((b) => b.text.includes('FURNITURE_SHOULD_NOT_APPEAR'))).toBe(false);
  });

  it('flips BOTTOMLEFT bboxes to normalized top-left 0-1000', () => {
    const [p1, p2] = decodeDoclingDocument(fixture());
    expect(p1.blocks[0].bbox).toEqual([100, 50, 900, 100]); // title
    expect(p1.blocks[5].bbox).toEqual([100, 575, 900, 750]); // table
    expect(p2.blocks[4].bbox).toEqual([100, 650, 900, 675]); // footnote
  });

  it('renders per-page markdown via the reused itemsToMarkdown (headings, skipped empties)', () => {
    const [p1, p2] = decodeDoclingDocument(fixture());
    expect(p1.markdown).toBe(
      '# Quarterly Report 2025\n\n' +
        '## Overview\n\n' +
        'This report summarizes fiscal year 2025.\n\n' +
        'First item\n\n' +
        'Second item\n\n' +
        'Metric | Value\nRevenue | $1.2M',
    );
    // the empty-text picture produces no markdown line.
    expect(p2.markdown).toBe(
      'Confidential\n\n' + 'Figure 1: Revenue by quarter\n\n' + "print('hi')\n\n" + '1 See appendix',
    );
  });

  it('omits per-page token usage (docling reports none)', () => {
    const [p1] = decodeDoclingDocument(fixture());
    expect(p1.usage).toBeUndefined();
  });
});
