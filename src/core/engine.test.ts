/**
 * parseDocument against a FAKE parser + fake client, with rasterize mocked out
 * (engine tests never rasterize — DESIGN.md #4). Covers every contract clause:
 * concurrency ceiling, retry/backoff on 429/5xx, page-order stability, usage/cost
 * math, per-page warnings, meta, settings merge, context injection, progress.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('./rasterize.js', () => ({ rasterizePages: vi.fn() }));

import { parseDocument } from './engine.js';
import { rasterizePages } from './rasterize.js';
import { VlmHttpError } from './vlm.js';
import type { VlmClient } from './vlm.js';
import type { LayoutBlock, TokenUsage, PageParse } from './blocks.js';
import type { Parser, ParserContext, PageInput } from '../parsers/types.js';

const mockRaster = vi.mocked(rasterizePages);
const PDF = new Uint8Array([37, 80, 68, 70]); // dummy; rasterize is mocked

const U: TokenUsage = { inputTokens: 1, outputTokens: 1, thinkingTokens: 0 };
const dummyVlm: VlmClient = {
  async complete() {
    throw new Error('fake parser must not call the injected client');
  },
};

function pageInputs(n: number): PageInput[] {
  return Array.from({ length: n }, (_, i) => ({
    page: i + 1,
    png: Uint8Array.from([i]),
    width: 1,
    height: 1,
  }));
}

function blk(page: number): LayoutBlock {
  return { label: 'Text', bbox: [0, 0, 1, 1], text: `t${page}`, page };
}

function fakeParser(
  parsePage: (input: PageInput, ctx: ParserContext) => Promise<PageParse>,
  specOverrides: Partial<Parser['spec']> = {},
): Parser {
  return {
    spec: { id: 'fake', displayName: 'Fake', version: '0.0.0', requires: 'vlm', defaults: {}, ...specOverrides },
    parsePage,
  };
}

afterEach(() => {
  vi.useRealTimers();
  mockRaster.mockReset();
});

describe('parseDocument — concurrency', () => {
  it('never runs more than `concurrency` pages simultaneously', async () => {
    mockRaster.mockResolvedValue(pageInputs(9));
    let inFlight = 0;
    let maxInFlight = 0;
    const parser = fakeParser(async (input) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { page: input.page, markdown: `p${input.page}`, blocks: [blk(input.page)], usage: U };
    });
    const res = await parseDocument(PDF, { parser, vlm: dummyVlm, model: 'm', concurrency: 3 });
    expect(maxInFlight).toBe(3);
    expect(res.pages).toHaveLength(9);
  });

  it('defaults to a concurrency of 4', async () => {
    mockRaster.mockResolvedValue(pageInputs(8));
    let inFlight = 0;
    let maxInFlight = 0;
    const parser = fakeParser(async (input) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { page: input.page, markdown: '', blocks: [blk(input.page)], usage: U };
    });
    await parseDocument(PDF, { parser, vlm: dummyVlm, model: 'm' });
    expect(maxInFlight).toBe(4);
  });
});

describe('parseDocument — retry policy', () => {
  it('retries a 429 with backoff, then succeeds', async () => {
    mockRaster.mockResolvedValue(pageInputs(1));
    let attempts = 0;
    const parser = fakeParser(async (input) => {
      attempts++;
      if (attempts === 1) throw new VlmHttpError('rate limited', 429);
      return { page: input.page, markdown: 'ok', blocks: [blk(1)], usage: U };
    });
    vi.useFakeTimers();
    const p = parseDocument(PDF, { parser, vlm: dummyVlm, model: 'm', retries: 2 });
    await vi.runAllTimersAsync();
    const res = await p;
    expect(attempts).toBe(2);
    expect(res.pages[0].markdown).toBe('ok');
  });

  it('retries a 500 up to `retries` times, then fails the run naming the page', async () => {
    mockRaster.mockResolvedValue(pageInputs(3));
    let attemptsForPage2 = 0;
    const parser = fakeParser(async (input) => {
      if (input.page === 2) {
        attemptsForPage2++;
        throw new VlmHttpError('upstream boom', 500);
      }
      return { page: input.page, markdown: 'ok', blocks: [blk(input.page)], usage: U };
    });
    vi.useFakeTimers();
    const p = parseDocument(PDF, { parser, vlm: dummyVlm, model: 'm', retries: 2, concurrency: 1 });
    const settled = p.catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = (await settled) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/page 2/);
    expect(attemptsForPage2).toBe(3); // 1 initial + 2 retries
  });

  it('does not retry a non-retryable 4xx (fails immediately)', async () => {
    mockRaster.mockResolvedValue(pageInputs(1));
    let attempts = 0;
    const parser = fakeParser(async () => {
      attempts++;
      throw new VlmHttpError('bad request', 400);
    });
    await expect(
      parseDocument(PDF, { parser, vlm: dummyVlm, model: 'm', retries: 3 }),
    ).rejects.toThrow(/page 1/);
    expect(attempts).toBe(1);
  });

  it('does not retry a generic (non-Http) error', async () => {
    mockRaster.mockResolvedValue(pageInputs(1));
    let attempts = 0;
    const parser = fakeParser(async () => {
      attempts++;
      throw new Error('kaboom');
    });
    await expect(
      parseDocument(PDF, { parser, vlm: dummyVlm, model: 'm', retries: 3 }),
    ).rejects.toThrow(/page 1/);
    expect(attempts).toBe(1);
  });

  // #15 — the failure message must state the attempts ACTUALLY made, not the retries setting.
  it('reports "after 1 attempt" for a non-retryable 400 (retries setting is 3, but only 1 try)', async () => {
    mockRaster.mockResolvedValue(pageInputs(1));
    const parser = fakeParser(async () => {
      throw new VlmHttpError('bad request', 400);
    });
    const err = (await parseDocument(PDF, { parser, vlm: dummyVlm, model: 'm', retries: 3 }).catch(
      (e: unknown) => e,
    )) as Error;
    expect(err.message).toMatch(/after 1 attempt\b/);
    expect(err.message).not.toMatch(/retries/); // the old "after N retries" lie is gone
  });

  it('reports "after 3 attempts" after a 500 exhausts 2 retries (1 initial + 2)', async () => {
    mockRaster.mockResolvedValue(pageInputs(1));
    const parser = fakeParser(async () => {
      throw new VlmHttpError('upstream boom', 500);
    });
    vi.useFakeTimers();
    const p = parseDocument(PDF, { parser, vlm: dummyVlm, model: 'm', retries: 2 });
    const settled = p.catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = (await settled) as Error;
    expect(err.message).toMatch(/after 3 attempts\b/);
  });

  it('preserves the underlying transport error message (incl. body snippet) in the page failure', async () => {
    mockRaster.mockResolvedValue(pageInputs(1));
    const parser = fakeParser(async () => {
      throw new VlmHttpError('nvidia chat/completions failed with HTTP 400: API key not valid', 400);
    });
    const err = (await parseDocument(PDF, { parser, vlm: dummyVlm, model: 'm', retries: 2 }).catch(
      (e: unknown) => e,
    )) as Error;
    expect(err.message).toContain('API key not valid');
    expect(err.message).toMatch(/after 1 attempt/);
  });
});

describe('parseDocument — assembly', () => {
  it('returns pages ascending regardless of completion order', async () => {
    mockRaster.mockResolvedValue(pageInputs(5));
    const delays: Record<number, number> = { 1: 25, 2: 5, 3: 20, 4: 1, 5: 15 };
    const parser = fakeParser(async (input) => {
      await new Promise((r) => setTimeout(r, delays[input.page]));
      return { page: input.page, markdown: `p${input.page}`, blocks: [blk(input.page)], usage: U };
    });
    const res = await parseDocument(PDF, { parser, vlm: dummyVlm, model: 'm', concurrency: 5 });
    expect(res.pages.map((p) => p.page)).toEqual([1, 2, 3, 4, 5]);
    expect(res.blocks.map((b) => b.page)).toEqual([1, 2, 3, 4, 5]);
    expect(res.markdown).toBe('p1\n\np2\n\np3\n\np4\n\np5');
  });

  it('flattens blocks across pages in (page, reading-order) order', async () => {
    mockRaster.mockResolvedValue(pageInputs(2));
    const parser = fakeParser(async (input) => ({
      page: input.page,
      markdown: 'x',
      blocks: [
        { label: 'Title', bbox: [0, 0, 1, 1], text: `${input.page}-a`, page: input.page },
        { label: 'Text', bbox: [0, 0, 1, 1], text: `${input.page}-b`, page: input.page },
      ],
      usage: U,
    }));
    const res = await parseDocument(PDF, { parser, vlm: dummyVlm, model: 'm', concurrency: 2 });
    expect(res.blocks.map((b) => b.text)).toEqual(['1-a', '1-b', '2-a', '2-b']);
  });

  it('sums usage and computes cost via the injected pricing hook', async () => {
    mockRaster.mockResolvedValue(pageInputs(3));
    const parser = fakeParser(async (input) => ({
      page: input.page,
      markdown: 'x',
      blocks: [blk(input.page)],
      usage: { inputTokens: 10, outputTokens: 5, thinkingTokens: 1 },
    }));
    const pricing = vi.fn((_model: string, usage: TokenUsage) => usage.inputTokens * 0.01);
    const res = await parseDocument(PDF, { parser, vlm: dummyVlm, model: 'priced', pricing });
    expect(res.usage).toEqual({ inputTokens: 30, outputTokens: 15, thinkingTokens: 3 });
    expect(pricing).toHaveBeenCalledWith('priced', { inputTokens: 30, outputTokens: 15, thinkingTokens: 3 });
    expect(res.meta.costUsd).toBeCloseTo(0.3);
  });

  it('leaves costUsd undefined when pricing returns undefined (never 0)', async () => {
    mockRaster.mockResolvedValue(pageInputs(1));
    const parser = fakeParser(async (input) => ({ page: input.page, markdown: 'x', blocks: [blk(1)], usage: U }));
    const res = await parseDocument(PDF, {
      parser,
      vlm: dummyVlm,
      model: 'unknown',
      pricing: vi.fn(() => undefined),
    });
    expect(res.meta.costUsd).toBeUndefined();
  });

  it('leaves costUsd undefined when no pricing hook is passed', async () => {
    mockRaster.mockResolvedValue(pageInputs(1));
    const parser = fakeParser(async (input) => ({ page: input.page, markdown: 'x', blocks: [blk(1)], usage: U }));
    const res = await parseDocument(PDF, { parser, vlm: dummyVlm, model: 'm' });
    expect(res.meta.costUsd).toBeUndefined();
  });

  it('collects a per-page warning for pages that decode zero blocks', async () => {
    mockRaster.mockResolvedValue(pageInputs(3));
    const parser = fakeParser(async (input) => ({
      page: input.page,
      markdown: input.page === 2 ? '' : 'x',
      blocks: input.page === 2 ? [] : [blk(input.page)],
      usage: U,
    }));
    const res = await parseDocument(PDF, { parser, vlm: dummyVlm, model: 'm' });
    expect(res.meta.warnings).toContain('page 2: 0 blocks decoded');
    expect(res.meta.warnings).toHaveLength(1);
  });

  it('reports run meta: parserId, providerId, model, pageCount, durationMs', async () => {
    mockRaster.mockResolvedValue(pageInputs(2));
    const parser = fakeParser(
      async (input) => ({ page: input.page, markdown: 'x', blocks: [blk(input.page)], usage: U }),
      { id: 'fake-parser' },
    );
    const res = await parseDocument(PDF, { parser, vlm: dummyVlm, model: 'mmm', providerId: 'prov' });
    expect(res.meta.parserId).toBe('fake-parser');
    expect(res.meta.providerId).toBe('prov');
    expect(res.meta.model).toBe('mmm');
    expect(res.meta.pageCount).toBe(2);
    expect(typeof res.meta.durationMs).toBe('number');
    expect(res.meta.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('parseDocument — all-zero-blocks guard (#13)', () => {
  const zeroUsage: TokenUsage = { inputTokens: 5, outputTokens: 12, thinkingTokens: 0 };
  const zeroParser = (): Parser =>
    fakeParser(async (input) => ({ page: input.page, markdown: '', blocks: [], usage: zeroUsage }));

  it('rejects when EVERY page decodes 0 blocks — names the model, output tokens, and --allow-empty', async () => {
    mockRaster.mockResolvedValue(pageInputs(3));
    const err = (await parseDocument(PDF, {
      parser: zeroParser(),
      vlm: dummyVlm,
      model: 'nemo-vl',
    }).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('nemo-vl');
    expect(err.message).toMatch(/0 (layout )?blocks/i);
    expect(err.message).toContain('--allow-empty');
    // proof the model DID answer: the summed output-token count (3 × 12 = 36) is surfaced.
    expect(err.message).toContain('36');
  });

  it('does NOT reject when only some pages are zero (partial → warning only)', async () => {
    mockRaster.mockResolvedValue(pageInputs(3));
    const parser = fakeParser(async (input) => ({
      page: input.page,
      markdown: input.page === 2 ? '' : 'x',
      blocks: input.page === 2 ? [] : [blk(input.page)],
      usage: U,
    }));
    const res = await parseDocument(PDF, { parser, vlm: dummyVlm, model: 'm' });
    expect(res.meta.warnings).toContain('page 2: 0 blocks decoded');
    expect(res.pages).toHaveLength(3);
  });

  it('allowEmpty=true returns the empty-but-successful result (old behavior)', async () => {
    mockRaster.mockResolvedValue(pageInputs(2));
    const res = await parseDocument(PDF, {
      parser: zeroParser(),
      vlm: dummyVlm,
      model: 'nemo-vl',
      allowEmpty: true,
    });
    expect(res.pages).toHaveLength(2);
    expect(res.blocks).toHaveLength(0);
    expect(res.meta.warnings).toHaveLength(2); // both pages warned, but no throw
  });

  it('does not trip the guard on a normal run (blocks present)', async () => {
    mockRaster.mockResolvedValue(pageInputs(2));
    const parser = fakeParser(async (input) => ({
      page: input.page,
      markdown: 'x',
      blocks: [blk(input.page)],
      usage: U,
    }));
    const res = await parseDocument(PDF, { parser, vlm: dummyVlm, model: 'm' });
    expect(res.blocks).toHaveLength(2);
  });
});

describe('parseDocument — wiring', () => {
  it('forwards pages + dpi to rasterize and merges settings over parser defaults', async () => {
    mockRaster.mockResolvedValue(pageInputs(2));
    let seenSettings: Record<string, unknown> | undefined;
    const parser = fakeParser(
      async (input, ctx) => {
        seenSettings = ctx.settings;
        return { page: input.page, markdown: 'x', blocks: [blk(input.page)], usage: U };
      },
      { defaults: { bboxOrder: 'auto', k: 1 } },
    );
    await parseDocument(PDF, {
      parser,
      vlm: dummyVlm,
      model: 'm',
      pages: { from: 2, to: 4 },
      dpi: 100,
      settings: { k: 2, extra: 'y' },
    });
    expect(mockRaster).toHaveBeenCalledWith(PDF, { pages: { from: 2, to: 4 }, dpi: 100 });
    expect(seenSettings).toEqual({ bboxOrder: 'auto', k: 2, extra: 'y' });
  });

  it('injects vlm / model / providerId / signal into the parser context', async () => {
    mockRaster.mockResolvedValue(pageInputs(1));
    const controller = new AbortController();
    let seen: ParserContext | undefined;
    const parser = fakeParser(async (input, ctx) => {
      seen = ctx;
      return { page: input.page, markdown: 'x', blocks: [blk(1)], usage: U };
    });
    await parseDocument(PDF, {
      parser,
      vlm: dummyVlm,
      model: 'mm',
      providerId: 'pp',
      signal: controller.signal,
    });
    expect(seen?.vlm).toBe(dummyVlm);
    expect(seen?.model).toBe('mm');
    expect(seen?.providerId).toBe('pp');
    expect(seen?.signal).toBe(controller.signal);
  });

  it('reports progress as each page completes', async () => {
    mockRaster.mockResolvedValue(pageInputs(3));
    const parser = fakeParser(async (input) => ({
      page: input.page,
      markdown: 'x',
      blocks: [blk(input.page)],
      usage: U,
    }));
    const progress: Array<[number, number]> = [];
    await parseDocument(PDF, {
      parser,
      vlm: dummyVlm,
      model: 'm',
      concurrency: 1,
      onProgress: (d, t) => progress.push([d, t]),
    });
    expect(progress).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });
});
