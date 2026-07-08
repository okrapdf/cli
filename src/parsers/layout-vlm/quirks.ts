/**
 * Model-family quirks owned by this parser module.
 *
 * bbox order is a fact about the MODEL, not the provider: gemini-through-openrouter
 * still emits y-first boxes. So the quirk table prefix-matches model ids (the id with
 * any provider namespace like 'google/' stripped is also checked), and the parser —
 * never the engine or provider — applies it. Overridable via settings.bboxOrder.
 */

export type BboxOrder = 'xyxy' | 'yxyx';

const YXYX_PREFIXES = ['gemini'];

export function bboxOrderFor(modelId: string): BboxOrder {
  const bare = modelId.includes('/') ? modelId.slice(modelId.lastIndexOf('/') + 1) : modelId;
  for (const prefix of YXYX_PREFIXES) {
    if (modelId.startsWith(prefix) || bare.startsWith(prefix)) return 'yxyx';
  }
  return 'xyxy';
}
