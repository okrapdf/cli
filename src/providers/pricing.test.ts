/**
 * Pricing golden tests — ported table + prefix matching + cost adapter (DESIGN.md #2).
 */
import { describe, it, expect } from 'vitest';
import type { TokenUsage } from '../core/blocks.js';
import {
  GEMINI_PRICING_PER_M,
  longestPrefixMatch,
  getPricing,
  computeCostUsd,
  costUsdOrUndefined,
} from './pricing.js';

const M = 1_000_000;
const usage = (i: number, o: number, t = 0): TokenUsage => ({
  inputTokens: i,
  outputTokens: o,
  thinkingTokens: t,
});

describe('pricing', () => {
  describe('longestPrefixMatch', () => {
    it('prefers the longest matching prefix', () => {
      // 'gemini-2.5-flash-lite' must beat the shorter 'gemini-2.5-flash'
      expect(longestPrefixMatch('gemini-2.5-flash-lite', GEMINI_PRICING_PER_M)).toEqual({
        inputPerM: 0.1,
        outputPerM: 0.4,
      });
      expect(longestPrefixMatch('gemini-2.5-flash', GEMINI_PRICING_PER_M)).toEqual({
        inputPerM: 0.3,
        outputPerM: 2.5,
      });
    });

    it('matches on prefix for versioned / preview model ids', () => {
      expect(longestPrefixMatch('gemini-3-flash-preview', GEMINI_PRICING_PER_M)).toEqual({
        inputPerM: 0.5,
        outputPerM: 3.0,
      });
      expect(longestPrefixMatch('gemini-2.5-flash-preview-09-2025', GEMINI_PRICING_PER_M)).toEqual({
        inputPerM: 0.3,
        outputPerM: 2.5,
      });
    });

    it('returns null when nothing matches', () => {
      expect(longestPrefixMatch('qwen/qwen3-vl-235b-a22b-instruct', GEMINI_PRICING_PER_M)).toBeNull();
    });
  });

  describe('getPricing', () => {
    it('returns the table entry for a known model', () => {
      expect(getPricing('gemini-3.1-pro')).toEqual({ inputPerM: 2.0, outputPerM: 12.0 });
    });
    it('returns zeros for an unknown model', () => {
      expect(getPricing('gpt-4o')).toEqual({ inputPerM: 0, outputPerM: 0 });
    });
  });

  describe('computeCostUsd', () => {
    it('sums input + (output + thinking) at per-model rates', () => {
      // gemini-3-flash: input 0.5/M, output 3.0/M
      expect(computeCostUsd('gemini-3-flash', usage(M, M, 0))).toBeCloseTo(0.5 + 3.0, 10);
    });
    it('bills thinking tokens at the output rate', () => {
      expect(computeCostUsd('gemini-3-flash', usage(0, 0, M))).toBeCloseTo(3.0, 10);
    });
    it('returns 0 for an unknown model (zeros pricing)', () => {
      expect(computeCostUsd('gpt-4o', usage(M, M, M))).toBe(0);
    });
  });

  describe('costUsdOrUndefined', () => {
    it('returns a number for a priced model', () => {
      expect(costUsdOrUndefined('gemini-2.5-flash', usage(M, 0))).toBeCloseTo(0.3, 10);
    });
    it('returns undefined for an unpriced model (never guessed)', () => {
      expect(
        costUsdOrUndefined('qwen/qwen3-vl-235b-a22b-instruct', usage(M, M, M)),
      ).toBeUndefined();
    });
  });
});
