/**
 * Golden tests locking the vendored pure decode surface (DESIGN.md #3 TDD map).
 * Lineage: ParseBench `_layout_utils.py` (MIT) → parser-gemini `bbox.ts` → here.
 * These characterize the exact decode behavior so a future re-vendor can't drift silently.
 */
import { describe, it, expect } from 'vitest';
import {
  parseLayoutBlocks,
  swapGeminiBbox,
  itemsToMarkdown,
  bboxToNormalized,
  type RawBlock,
} from './decode.js';

describe('parseLayoutBlocks', () => {
  it('decodes a bbox-first attribute order', () => {
    const out = parseLayoutBlocks('<div data-bbox="[10, 20, 30, 40]" data-label="Text">hello</div>');
    expect(out).toEqual([{ bbox: [10, 20, 30, 40], label: 'Text', text: 'hello' }]);
  });

  it('decodes a label-first attribute order', () => {
    const out = parseLayoutBlocks('<div data-label="Title" data-bbox="[1, 2, 3, 4]">Doc</div>');
    expect(out).toEqual([{ bbox: [1, 2, 3, 4], label: 'Title', text: 'Doc' }]);
  });

  it('tolerates extra attributes around the data-* pair', () => {
    const out = parseLayoutBlocks(
      '<div class="node" id="n1" data-bbox="[1,2,3,4]" data-label="Text" style="x">hi</div>',
    );
    expect(out).toEqual([{ bbox: [1, 2, 3, 4], label: 'Text', text: 'hi' }]);
  });

  it('captures data-page when present', () => {
    const out = parseLayoutBlocks('<div data-bbox="[1,2,3,4]" data-label="Text" data-page="3">hi</div>');
    expect(out[0].page).toBe(3);
  });

  it('leaves page undefined when data-page is absent', () => {
    const out = parseLayoutBlocks('<div data-bbox="[1,2,3,4]" data-label="Text">hi</div>');
    expect(out[0].page).toBeUndefined();
    expect('page' in out[0]).toBe(false);
  });

  it('skips a non-JSON bbox', () => {
    expect(parseLayoutBlocks('<div data-bbox="[1 2 3 4]" data-label="Text">x</div>')).toEqual([]);
  });

  it('skips a wrong-arity bbox (3 or 5 numbers)', () => {
    expect(parseLayoutBlocks('<div data-bbox="[1,2,3]" data-label="Text">x</div>')).toEqual([]);
    expect(parseLayoutBlocks('<div data-bbox="[1,2,3,4,5]" data-label="Text">x</div>')).toEqual([]);
  });

  it('skips a non-numeric bbox', () => {
    expect(parseLayoutBlocks('<div data-bbox="[1, null, 3, 4]" data-label="Text">x</div>')).toEqual([]);
  });

  it('keeps valid blocks and drops only the malformed one', () => {
    const out = parseLayoutBlocks(
      '<div data-bbox="[1,2,3,4]" data-label="Text">good</div>' +
        '<div data-bbox="[bad]" data-label="Text">bad</div>' +
        '<div data-bbox="[5,6,7,8]" data-label="Title">also good</div>',
    );
    expect(out.map((b) => b.text)).toEqual(['good', 'also good']);
  });

  it('preserves document order across mixed attribute orders', () => {
    const out = parseLayoutBlocks(
      '<div data-bbox="[1,1,2,2]" data-label="Title">First</div>\n' +
        '<div data-label="Text" data-bbox="[3,3,4,4]">Second</div>\n' +
        '<div data-bbox="[5,5,6,6]" data-label="Text">Third</div>',
    );
    expect(out.map((b) => b.text)).toEqual(['First', 'Second', 'Third']);
    expect(out.map((b) => b.label)).toEqual(['Title', 'Text', 'Text']);
  });

  it('preserves and trims inner HTML (tags kept, surrounding whitespace stripped)', () => {
    const out = parseLayoutBlocks(
      '<div data-bbox="[1,2,3,4]" data-label="Text">  <b>bold</b> and <i>it</i>  </div>',
    );
    expect(out[0].text).toBe('<b>bold</b> and <i>it</i>');
  });

  it('preserves table HTML verbatim', () => {
    const table = '<table><tr><td>a</td><td>b</td></tr></table>';
    const out = parseLayoutBlocks(`<div data-bbox="[1,2,3,4]" data-label="Table">${table}</div>`);
    expect(out[0].text).toBe(table);
    expect(out[0].label).toBe('Table');
  });

  it('returns nothing for content with no wrappers', () => {
    expect(parseLayoutBlocks('just some plain markdown, no divs')).toEqual([]);
  });
});

describe('swapGeminiBbox', () => {
  it('swaps [y_min, x_min, y_max, x_max] to [x_min, y_min, x_max, y_max]', () => {
    const out = swapGeminiBbox([{ bbox: [100, 200, 300, 400], label: 'X', text: 't' }]);
    expect(out[0].bbox).toEqual([200, 100, 400, 300]);
  });

  it('is its own inverse (double swap === identity)', () => {
    const original: RawBlock[] = [{ bbox: [12, 34, 56, 78], label: 'Text', text: 'a' }];
    const twice = swapGeminiBbox(swapGeminiBbox(original));
    expect(twice[0].bbox).toEqual(original[0].bbox);
  });

  it('leaves a malformed (non-4) bbox untouched', () => {
    const out = swapGeminiBbox([{ bbox: [1, 2] as unknown as RawBlock['bbox'], label: 'X', text: 't' }]);
    expect(out[0].bbox).toEqual([1, 2]);
  });

  it('preserves label, text and page while swapping', () => {
    const out = swapGeminiBbox([{ bbox: [1, 2, 3, 4], label: 'Title', text: 'z', page: 2 }]);
    expect(out[0]).toEqual({ bbox: [2, 1, 4, 3], label: 'Title', text: 'z', page: 2 });
  });
});

describe('itemsToMarkdown', () => {
  it('maps Title -> #, Section-header -> ##, Formula -> $$ and drops empty text', () => {
    const md = itemsToMarkdown([
      { bbox: [0, 0, 0, 0], label: 'Title', text: 'Doc Title' },
      { bbox: [0, 0, 0, 0], label: 'Section-header', text: 'Section A' },
      { bbox: [0, 0, 0, 0], label: 'Formula', text: 'E=mc^2' },
      { bbox: [0, 0, 0, 0], label: 'Text', text: 'Body text' },
      { bbox: [0, 0, 0, 0], label: 'Text', text: '' },
    ]);
    expect(md).toBe('# Doc Title\n\n## Section A\n\n$$\nE=mc^2\n$$\n\nBody text');
  });

  it('treats the section_header underscore variant as a level-2 heading', () => {
    expect(itemsToMarkdown([{ bbox: [0, 0, 0, 0], label: 'section_header', text: 'S' }])).toBe('## S');
  });

  it('is case-insensitive on the label', () => {
    expect(itemsToMarkdown([{ bbox: [0, 0, 0, 0], label: 'TITLE', text: 'T' }])).toBe('# T');
  });

  it('returns an empty string when every block is empty', () => {
    expect(itemsToMarkdown([{ bbox: [0, 0, 0, 0], label: 'Text', text: '' }])).toBe('');
  });
});

describe('bboxToNormalized', () => {
  it('converts 0-1000 [x1,y1,x2,y2] to 0-1 {x,y,w,h}', () => {
    const n = bboxToNormalized([500, 250, 1000, 750]);
    expect(n.x).toBeCloseTo(0.5);
    expect(n.y).toBeCloseTo(0.25);
    expect(n.w).toBeCloseTo(0.5);
    expect(n.h).toBeCloseTo(0.5);
  });

  it('normalizes inverted coordinates via min + abs', () => {
    const n = bboxToNormalized([1000, 750, 500, 250]);
    expect(n.x).toBeCloseTo(0.5);
    expect(n.y).toBeCloseTo(0.25);
    expect(n.w).toBeCloseTo(0.5);
    expect(n.h).toBeCloseTo(0.5);
  });

  it('clamps negative origins to 0 while keeping the true width/height', () => {
    const n = bboxToNormalized([-100, -50, 200, 150]);
    expect(n.x).toBe(0);
    expect(n.y).toBe(0);
    expect(n.w).toBeCloseTo(0.3);
    expect(n.h).toBeCloseTo(0.2);
  });
});
