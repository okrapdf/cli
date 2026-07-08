/**
 * rasterizePages against the checked-in tiny 2-page fixture (DESIGN.md #4 TDD map).
 * Real mupdf + sharp — no network (net-guard is inert here). Low dpi keeps it fast.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { rasterizePages } from './rasterize.js';

const fixture = new Uint8Array(
  readFileSync(fileURLToPath(new URL('../../test/fixtures/two-page.pdf', import.meta.url))),
);

describe('rasterizePages', () => {
  it('rasterizes all pages by default, 1-indexed and ascending', async () => {
    const pages = await rasterizePages(fixture, { dpi: 72 });
    expect(pages).toHaveLength(2);
    expect(pages.map((p) => p.page)).toEqual([1, 2]);
  });

  it('emits PNG bytes carrying the PNG magic header', async () => {
    const [p] = await rasterizePages(fixture, { dpi: 72 });
    expect(Array.from(p.png.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it('selects a 1-indexed inclusive page range', async () => {
    const pages = await rasterizePages(fixture, { pages: { from: 2, to: 2 }, dpi: 72 });
    expect(pages).toHaveLength(1);
    expect(pages[0].page).toBe(2);
  });

  it('clamps an over-wide range down to the available pages', async () => {
    const pages = await rasterizePages(fixture, { pages: { from: 1, to: 99 }, dpi: 72 });
    expect(pages.map((p) => p.page)).toEqual([1, 2]);
  });

  it('renders sensible pixel dimensions for the dpi (612x792pt page at 72dpi ≈ 612x792px)', async () => {
    const [p] = await rasterizePages(fixture, { dpi: 72 });
    expect(p.width).toBeGreaterThanOrEqual(610);
    expect(p.width).toBeLessThanOrEqual(614);
    expect(p.height).toBeGreaterThanOrEqual(790);
    expect(p.height).toBeLessThanOrEqual(794);
  });

  it('scales pixel dimensions with dpi', async () => {
    const [lo] = await rasterizePages(fixture, { dpi: 72 });
    const [hi] = await rasterizePages(fixture, { dpi: 144 });
    expect(hi.width).toBeGreaterThan(lo.width * 1.8);
    expect(hi.height).toBeGreaterThan(lo.height * 1.8);
  });
});
