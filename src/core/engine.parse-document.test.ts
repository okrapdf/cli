/**
 * PROPOSAL(spike): engine dispatch for DOCUMENT-NATIVE parsers (parser.parseDocument).
 * Proves the whole-document path SKIPS rasterization + the per-page pool, reuses the
 * shared assembly (all-zero guard, usage, warnings, meta), and retries the single call.
 * rasterize is mocked so a stray call is observable (it must never be invoked here).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('./rasterize.js', () => ({ rasterizePages: vi.fn() }));

import { parseDocument } from './engine.js';
import { rasterizePages } from './rasterize.js';
import { VlmHttpError } from './vlm.js';
import type { LayoutBlock, PageParse, TokenUsage } from './blocks.js';
import type { Parser, ParserContext } from '../parsers/types.js';

const mockRaster = vi.mocked(rasterizePages);
const PDF = new Uint8Array([37, 80, 68, 70]);

function blk(page: number, text = `t${page}`): LayoutBlock {
  return { label: 'Text', bbox: [0, 0, 1, 1], text, page };
}

/** A document-native fake parser: implements parseDocument, and a parsePage that MUST NOT run. */
function fakeDocParser(
  parseDocument: (pdf: Uint8Array, ctx: ParserContext) => Promise<PageParse[]>,
  specOverrides: Partial<Parser['spec']> = {},
): Parser {
  return {
    spec: { id: 'fake-doc', displayName: 'FakeDoc', version: '0', requires: 'http', defaults: {}, ...specOverrides },
    parsePage: async () => {
      throw new Error('parsePage must not be called for a parseDocument parser');
    },
    parseDocument,
  };
}

afterEach(() => {
  vi.useRealTimers();
  mockRaster.mockReset();
});

describe('parseDocument — document-native dispatch', () => {
  it('prefers parseDocument, skips rasterization, and assembles the returned pages', async () => {
    const parser = fakeDocParser(
      async () => [
        { page: 1, markdown: 'p1', blocks: [blk(1)] },
        { page: 2, markdown: 'p2', blocks: [blk(2, 'x'), blk(2, 'y')] },
      ],
      { id: 'docling-fake' },
    );
    const res = await parseDocument(PDF, { parser, httpBaseUrl: 'http://docling.test', providerId: 'docling' });

    expect(mockRaster).not.toHaveBeenCalled();
    expect(res.pages.map((p) => p.page)).toEqual([1, 2]);
    expect(res.blocks.map((b) => b.text)).toEqual(['t1', 'x', 'y']);
    expect(res.markdown).toBe('p1\n\np2');
    expect(res.meta.parserId).toBe('docling-fake');
    expect(res.meta.pageCount).toBe(2);
  });

  it('injects httpBaseUrl + settings into the parser context', async () => {
    let seen: ParserContext | undefined;
    const parser = fakeDocParser(
      async (_pdf, c) => {
        seen = c;
        return [{ page: 1, markdown: 'x', blocks: [blk(1)] }];
      },
      { defaults: { timeoutMs: 5000 } },
    );
    await parseDocument(PDF, { parser, httpBaseUrl: 'http://d.test', settings: { extra: 1 } });
    expect(seen?.httpBaseUrl).toBe('http://d.test');
    expect(seen?.settings).toEqual({ timeoutMs: 5000, extra: 1 });
  });

  it('reports progress as complete (done === total) after the single call', async () => {
    const parser = fakeDocParser(async () => [
      { page: 1, markdown: 'a', blocks: [blk(1)] },
      { page: 2, markdown: 'b', blocks: [blk(2)] },
    ]);
    const progress: Array<[number, number]> = [];
    await parseDocument(PDF, { parser, httpBaseUrl: 'http://d.test', onProgress: (d, t) => progress.push([d, t]) });
    expect(progress).toEqual([[2, 2]]);
  });

  it('applies the all-zero-blocks guard on the document path (rejects, names --allow-empty)', async () => {
    const parser = fakeDocParser(async () => [
      { page: 1, markdown: '', blocks: [] },
      { page: 2, markdown: '', blocks: [] },
    ]);
    const err = (await parseDocument(PDF, { parser, httpBaseUrl: 'http://d.test', model: 'docling' }).catch(
      (e: unknown) => e,
    )) as Error;
    expect(err.message).toMatch(/0 (layout )?blocks/i);
    expect(err.message).toContain('--allow-empty');
    expect(mockRaster).not.toHaveBeenCalled();
  });

  it('allowEmpty=true keeps the empty-but-successful result', async () => {
    const parser = fakeDocParser(async () => [{ page: 1, markdown: '', blocks: [] }]);
    const res = await parseDocument(PDF, { parser, httpBaseUrl: 'http://d.test', allowEmpty: true });
    expect(res.blocks).toHaveLength(0);
    expect(res.meta.warnings).toContain('page 1: 0 blocks decoded');
  });

  it('retries the single call on a 500, then succeeds (retry wraps parseDocument)', async () => {
    let attempts = 0;
    const parser = fakeDocParser(async () => {
      attempts++;
      if (attempts === 1) throw new VlmHttpError('docling upstream boom', 500);
      return [{ page: 1, markdown: 'ok', blocks: [blk(1)] }];
    });
    vi.useFakeTimers();
    const p = parseDocument(PDF, { parser, httpBaseUrl: 'http://d.test', retries: 2 });
    await vi.runAllTimersAsync();
    const res = await p;
    expect(attempts).toBe(2);
    expect(res.pages[0].markdown).toBe('ok');
  });

  it('fails the run naming the document after retries are exhausted', async () => {
    const parser = fakeDocParser(async () => {
      throw new VlmHttpError('still boom', 500);
    });
    vi.useFakeTimers();
    const p = parseDocument(PDF, { parser, httpBaseUrl: 'http://d.test', retries: 1 });
    const settled = p.catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = (await settled) as Error;
    expect(err.message).toMatch(/parse document after 2 attempts/);
  });

  it('throws when a parser implements NEITHER parseDocument nor parsePage', async () => {
    const broken = {
      spec: { id: 'broken', displayName: 'Broken', version: '0', requires: 'none', defaults: {} },
    } as Parser;
    await expect(parseDocument(PDF, { parser: broken })).rejects.toThrow(/neither parseDocument nor parsePage/);
    expect(mockRaster).not.toHaveBeenCalled();
  });
});
