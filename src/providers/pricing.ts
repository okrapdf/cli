/**
 * Pricing — lives with providers (DESIGN.md "Pricing"). The Gemini per-model table +
 * `longestPrefixMatch` + `getPricing` are ported VERBATIM from the monorepo
 * `packages/parser-gemini/src/pricing.ts`. `computeCostUsd` is adapted to core
 * `TokenUsage` (no cache tokens). Unknown models → cost omitted, never guessed.
 *
 * providers/** may import core/** only (dependency rule 2).
 */

import type { TokenUsage } from '../core/blocks.js';

export type ModelPricing = { inputPerM: number; outputPerM: number };

/** USD per 1M tokens. Ported verbatim from monorepo parser-gemini pricing. */
export const GEMINI_PRICING_PER_M: Record<string, ModelPricing> = {
  'gemini-3-flash': { inputPerM: 0.5, outputPerM: 3.0 },
  'gemini-3.1-flash-lite': { inputPerM: 0.25, outputPerM: 1.5 },
  'gemini-2.5-flash': { inputPerM: 0.3, outputPerM: 2.5 },
  'gemini-2.5-flash-lite': { inputPerM: 0.1, outputPerM: 0.4 },
  'gemini-2.0-flash': { inputPerM: 0.1, outputPerM: 0.4 },
  'gemini-2.5-pro': { inputPerM: 1.25, outputPerM: 10.0 },
  'gemini-3.1-pro': { inputPerM: 2.0, outputPerM: 12.0 },
};

/** Ported verbatim: longest key that is a prefix of `model` wins. */
export function longestPrefixMatch<T>(model: string, table: Record<string, T>): T | null {
  let best: string | null = null;
  for (const prefix of Object.keys(table)) {
    if (!model.startsWith(prefix)) continue;
    if (best === null || prefix.length > best.length) best = prefix;
  }
  return best ? table[best] : null;
}

/** Ported verbatim: unknown model → zero pricing (kept for callers that want a number). */
export function getPricing(model: string): ModelPricing {
  return longestPrefixMatch(model, GEMINI_PRICING_PER_M) ?? { inputPerM: 0, outputPerM: 0 };
}

/**
 * Adapted to core TokenUsage: input tokens at inputPerM; output + thinking tokens at
 * outputPerM. There is no cache-token term (core TokenUsage has none). Unknown model →
 * zeros → 0 (use `costUsdOrUndefined` to keep it undefined instead).
 */
export function computeCostUsd(model: string, usage: TokenUsage): number {
  const { inputPerM, outputPerM } = getPricing(model);
  const inputCost = (usage.inputTokens * inputPerM) / 1_000_000;
  const outputCost = ((usage.outputTokens + usage.thinkingTokens) * outputPerM) / 1_000_000;
  return inputCost + outputCost;
}

/**
 * meta.costUsd source: a number for a priced model, `undefined` when the model has no
 * pricing entry (never guessed — DESIGN.md "Pricing", ParseRunMeta.costUsd contract).
 */
export function costUsdOrUndefined(model: string, usage: TokenUsage): number | undefined {
  if (longestPrefixMatch(model, GEMINI_PRICING_PER_M) === null) return undefined;
  return computeCostUsd(model, usage);
}
