/**
 * layout-vlm — the DEFAULT parser: ParseBench prompts + any vision model.
 * A peer of future parsers (docling-serve, text-layer), not privileged core.
 *
 * @architect-owned spec + algorithm; parsePage body is worker's (TDD per DESIGN.md #3).
 */

import { defineParser } from '../types.js';
import type { LayoutBlock } from '../../core/blocks.js';
import { bboxOrderFor, type BboxOrder } from './quirks.js';
import {
  SYSTEM_PROMPT_LAYOUT,
  USER_PROMPT_LAYOUT,
  SYSTEM_PROMPT_LAYOUT_GEMINI,
  USER_PROMPT_LAYOUT_GEMINI,
  canonicalLabel,
} from './prompts.js';
import { parseLayoutBlocks, swapGeminiBbox, itemsToMarkdown } from './decode.js';

export const layoutVlmParser = defineParser({
  spec: {
    id: 'layout-vlm',
    displayName: 'Layout VLM (ParseBench prompts)',
    version: '1.0.0',
    requires: 'vlm',
    defaults: {
      /** 'auto' resolves via quirks.bboxOrderFor(model); or force 'xyxy' | 'yxyx'. */
      bboxOrder: 'auto',
      maxOutputTokens: 8192,
      temperature: 0,
    },
  },
  // Algorithm (worker: implement exactly; each step has a test):
  //   1. order = settings.bboxOrder === 'auto' ? bboxOrderFor(ctx.model) : settings.bboxOrder
  //   2. prompts = order === 'yxyx' ? *_GEMINI variants : base variants
  //   3. res = await ctx.vlm.complete({ model, system, user, images: [input], maxOutputTokens, temperature }, ctx.signal)
  //   4. raw = parseLayoutBlocks(res.text); if order === 'yxyx' → swapGeminiBbox(raw)
  //   5. blocks = raw.map(b → { label: canonicalLabel(b.label), bbox, text, page: input.page })
  //      (data-page from single-page prompts is ignored; PageInput.page is authoritative)
  //   6. markdown = itemsToMarkdown(raw)
  //   7. return { page: input.page, markdown, blocks, usage: res.usage }
  // Errors: missing ctx.vlm → throw with copy pointing at engine wiring (programmer error).
  async parsePage(input, ctx) {
    if (!ctx.vlm) {
      // Programmer error: the engine must inject a VlmClient for requires:'vlm' parsers.
      throw new Error(
        "layout-vlm parser requires a VlmClient (ctx.vlm) but none was injected. " +
          "This is an engine-wiring bug: parseDocument must inject a VlmClient for parsers " +
          "whose spec.requires === 'vlm'.",
      );
    }

    const model = ctx.model ?? '';

    // 1. bbox order: explicit 'xyxy'/'yxyx' wins; 'auto' (and anything else) → model quirk.
    const setting = ctx.settings.bboxOrder;
    const order: BboxOrder = setting === 'xyxy' || setting === 'yxyx' ? setting : bboxOrderFor(model);

    // 2. prompt variant — y-first (gemini) models get the *_GEMINI wording.
    const system = order === 'yxyx' ? SYSTEM_PROMPT_LAYOUT_GEMINI : SYSTEM_PROMPT_LAYOUT;
    const user = order === 'yxyx' ? USER_PROMPT_LAYOUT_GEMINI : USER_PROMPT_LAYOUT;

    const maxOutputTokens =
      typeof ctx.settings.maxOutputTokens === 'number' ? ctx.settings.maxOutputTokens : undefined;
    const temperature =
      typeof ctx.settings.temperature === 'number' ? ctx.settings.temperature : undefined;

    // 3. one page image → the injected client (provider-agnostic).
    const res = await ctx.vlm.complete(
      { model, system, user, images: [input], maxOutputTokens, temperature },
      ctx.signal,
    );

    // 4. decode wrappers; swap y-first boxes back to x-first when applicable.
    const decoded = parseLayoutBlocks(res.text);
    const raw = order === 'yxyx' ? swapGeminiBbox(decoded) : decoded;

    // 5. canonical blocks — PageInput.page is authoritative (data-page from the model is ignored).
    const blocks: LayoutBlock[] = raw.map((b) => ({
      label: canonicalLabel(b.label),
      bbox: b.bbox,
      text: b.text,
      page: input.page,
    }));

    // 6. reading-order markdown (headings/formulas formatted, empty text dropped).
    const markdown = itemsToMarkdown(raw);

    // 7. assemble the page parse.
    return { page: input.page, markdown, blocks, usage: res.usage };
  },
});
