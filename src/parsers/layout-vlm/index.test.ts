/**
 * layoutVlmParser.parsePage against a fake VlmClient (DESIGN.md #3 TDD map).
 * Asserts prompt-variant selection (gemini vs qwen vs namespaced-gemini), the
 * conditional gemini bbox swap, label canonicalization, authoritative page number,
 * markdown, usage passthrough, settings overrides, signal passthrough, and the
 * missing-client programmer error. No network — the fake never touches fetch.
 */
import { describe, it, expect } from 'vitest';
import { layoutVlmParser } from './index.js';
import {
  SYSTEM_PROMPT_LAYOUT,
  USER_PROMPT_LAYOUT,
  SYSTEM_PROMPT_LAYOUT_GEMINI,
  USER_PROMPT_LAYOUT_GEMINI,
} from './prompts.js';
import type { VlmClient, VlmRequest } from '../../core/vlm.js';
import type { ParserContext, PageInput } from '../types.js';
import type { TokenUsage } from '../../core/blocks.js';

const USAGE: TokenUsage = { inputTokens: 5, outputTokens: 7, thinkingTokens: 0 };

function fakeClient(cannedText: string, usage: TokenUsage = USAGE) {
  const calls: { req: VlmRequest; signal?: AbortSignal }[] = [];
  const client: VlmClient = {
    async complete(req, signal) {
      calls.push({ req, signal });
      return { text: cannedText, usage };
    },
  };
  return { client, calls };
}

const DEFAULTS = layoutVlmParser.spec.defaults;
const input: PageInput = { page: 1, png: Uint8Array.from([1, 2, 3, 4]), width: 100, height: 200 };

function ctx(model: string, client: VlmClient, extra: Record<string, unknown> = {}): ParserContext {
  return { vlm: client, model, providerId: 'test', settings: { ...DEFAULTS, ...extra } };
}

describe('layoutVlmParser.parsePage', () => {
  it('uses the *_GEMINI prompts and swaps bboxes for a native gemini model', async () => {
    const { client, calls } = fakeClient('<div data-bbox="[100,200,300,400]" data-label="Text">hello</div>');
    const res = await layoutVlmParser.parsePage(input, ctx('gemini-3-flash', client));

    expect(calls[0].req.system).toBe(SYSTEM_PROMPT_LAYOUT_GEMINI);
    expect(calls[0].req.user).toBe(USER_PROMPT_LAYOUT_GEMINI);
    // canned [y_min,x_min,y_max,x_max] = [100,200,300,400] -> swapped to [x,y,x,y]
    expect(res.blocks[0].bbox).toEqual([200, 100, 400, 300]);
    expect(res.blocks[0].label).toBe('Text');
    expect(res.blocks[0].page).toBe(1);
    expect(res.page).toBe(1);
    expect(res.markdown).toBe('hello');
    expect(res.usage).toEqual(USAGE);
  });

  it('sends the model, exactly one image, and the tuned generation params', async () => {
    const { client, calls } = fakeClient('<div data-bbox="[1,2,3,4]" data-label="Text">x</div>');
    await layoutVlmParser.parsePage(input, ctx('gemini-3-flash', client));
    expect(calls[0].req.model).toBe('gemini-3-flash');
    expect(calls[0].req.images).toHaveLength(1);
    expect(calls[0].req.images[0]).toMatchObject({ width: 100, height: 200 });
    expect(calls[0].req.maxOutputTokens).toBe(8192);
    expect(calls[0].req.temperature).toBe(0);
  });

  it('uses the base prompts and does NOT swap for a non-gemini (qwen) model', async () => {
    const { client, calls } = fakeClient('<div data-bbox="[10,20,30,40]" data-label="Section-header">Sec</div>');
    const res = await layoutVlmParser.parsePage(input, ctx('qwen/qwen3-vl-235b-a22b-instruct', client));

    expect(calls[0].req.system).toBe(SYSTEM_PROMPT_LAYOUT);
    expect(calls[0].req.user).toBe(USER_PROMPT_LAYOUT);
    expect(res.blocks[0].bbox).toEqual([10, 20, 30, 40]); // untouched
    expect(res.blocks[0].label).toBe('Section-header');
    expect(res.markdown).toBe('## Sec');
  });

  it('treats a provider-namespaced gemini id (google/…) as y-first (gemini prompts + swap)', async () => {
    const { client, calls } = fakeClient('<div data-bbox="[1,2,3,4]" data-label="Title">T</div>');
    const res = await layoutVlmParser.parsePage(input, ctx('google/gemini-3-flash-preview', client));
    expect(calls[0].req.system).toBe(SYSTEM_PROMPT_LAYOUT_GEMINI);
    expect(res.blocks[0].bbox).toEqual([2, 1, 4, 3]);
    expect(res.markdown).toBe('# T');
  });

  it('canonicalizes labels (underscore + alias variants)', async () => {
    const { client } = fakeClient('<div data-bbox="[1,2,3,4]" data-label="section_header">S</div>');
    const res = await layoutVlmParser.parsePage(input, ctx('qwen/x', client));
    expect(res.blocks[0].label).toBe('Section-header');
  });

  it('uses the authoritative PageInput.page, ignoring any data-page in the output', async () => {
    const { client } = fakeClient('<div data-bbox="[1,2,3,4]" data-label="Text" data-page="99">x</div>');
    const res = await layoutVlmParser.parsePage(
      { page: 7, png: Uint8Array.from([9]), width: 1, height: 1 },
      ctx('qwen/x', client),
    );
    expect(res.page).toBe(7);
    expect(res.blocks[0].page).toBe(7);
  });

  it('honors a forced settings.bboxOrder=xyxy even on a gemini model', async () => {
    const { client, calls } = fakeClient('<div data-bbox="[1,2,3,4]" data-label="Text">x</div>');
    const res = await layoutVlmParser.parsePage(input, ctx('gemini-3-flash', client, { bboxOrder: 'xyxy' }));
    expect(calls[0].req.system).toBe(SYSTEM_PROMPT_LAYOUT); // base, not GEMINI
    expect(res.blocks[0].bbox).toEqual([1, 2, 3, 4]); // not swapped
  });

  it('honors a forced settings.bboxOrder=yxyx on a non-gemini model', async () => {
    const { client, calls } = fakeClient('<div data-bbox="[1,2,3,4]" data-label="Text">x</div>');
    const res = await layoutVlmParser.parsePage(input, ctx('qwen/x', client, { bboxOrder: 'yxyx' }));
    expect(calls[0].req.system).toBe(SYSTEM_PROMPT_LAYOUT_GEMINI);
    expect(res.blocks[0].bbox).toEqual([2, 1, 4, 3]); // swapped
  });

  it('passes settings.maxOutputTokens / temperature overrides to the client', async () => {
    const { client, calls } = fakeClient('<div data-bbox="[1,2,3,4]" data-label="Text">x</div>');
    await layoutVlmParser.parsePage(input, ctx('qwen/x', client, { maxOutputTokens: 1234, temperature: 0.7 }));
    expect(calls[0].req.maxOutputTokens).toBe(1234);
    expect(calls[0].req.temperature).toBe(0.7);
  });

  it('forwards the abort signal to the client', async () => {
    const controller = new AbortController();
    const { client, calls } = fakeClient('<div data-bbox="[1,2,3,4]" data-label="Text">x</div>');
    await layoutVlmParser.parsePage(input, {
      ...ctx('qwen/x', client),
      signal: controller.signal,
    });
    expect(calls[0].signal).toBe(controller.signal);
  });

  it('yields zero blocks and empty markdown when the model returns no wrappers', async () => {
    const { client } = fakeClient('sorry, I could not parse this page');
    const res = await layoutVlmParser.parsePage(input, ctx('qwen/x', client));
    expect(res.blocks).toEqual([]);
    expect(res.markdown).toBe('');
  });

  it('throws a programmer-error when ctx.vlm is missing (engine wiring bug)', async () => {
    await expect(
      layoutVlmParser.parsePage(input, { settings: { ...DEFAULTS } } as ParserContext),
    ).rejects.toThrow(/vlm/i);
  });
});
