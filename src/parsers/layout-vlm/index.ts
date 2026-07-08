/**
 * layout-vlm — the DEFAULT parser: ParseBench prompts + any vision model.
 * A peer of future parsers (docling-serve, text-layer), not privileged core.
 *
 * @architect-owned spec + algorithm; parsePage body is worker's (TDD per DESIGN.md #3).
 */

import { defineParser } from '../types.js';

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
  async parsePage(_input, _ctx) {
    throw new Error('TODO(worker): implement per algorithm above — tests first');
  },
});
