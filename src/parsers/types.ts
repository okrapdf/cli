/**
 * Parser contract — the docling-swappable seam. A parser encapsulates prompts,
 * settings, and decode logic behind one interface; the default (layout-vlm) is a
 * peer of any future parser (docling-serve, text-layer), not privileged core.
 * @architect-owned — see DESIGN.md "Seam 2 — Parsers".
 *
 * Kept intentionally smaller than the monorepo `@okrapdf/parser-sdk` Parser
 * (no hooks/async-jobs/export) but conceptually compatible so a later
 * convergence is a widening, not a rewrite.
 */

import type { PageParse } from '../core/blocks.js';
import type { VlmClient, VlmImage } from '../core/vlm.js';

export type ParserRequires = 'vlm' | 'http' | 'none';

export interface ParserSpec {
  /** e.g. 'layout-vlm' (default), 'docling-serve', 'text-layer'. */
  id: string;
  displayName: string;
  version: string;
  /** What the engine must inject: a VlmClient, an HTTP base URL, or nothing. */
  requires: ParserRequires;
  /** Parser-owned settings + defaults (encapsulated; overridable via --parser-setting/config). */
  defaults: Record<string, unknown>;
}

export interface ParserContext {
  /** Injected when spec.requires === 'vlm'. */
  vlm?: VlmClient;
  /** Resolved model id (for prompt-variant quirks + reporting). */
  model?: string;
  /** Provider id, for reporting only — parsers must not branch on it (branch on model). */
  providerId?: string;
  /** Injected when spec.requires === 'http'. */
  httpBaseUrl?: string;
  /** spec.defaults merged with user overrides. */
  settings: Record<string, unknown>;
  signal?: AbortSignal;
  log?: (msg: string) => void;
}

/** One rasterized page. */
export interface PageInput extends VlmImage {
  /** 1-indexed page number. */
  page: number;
}

export interface Parser {
  spec: ParserSpec;
  // PROPOSAL(spike): a parser implements EXACTLY ONE of these two entry points.
  //
  //  - parsePage: the per-rasterized-page path VLM parsers use (default: layout-vlm).
  //  - parseDocument: the document-native path (requires:'http', e.g. docling-serve).
  //    The whole PDF is handed over in one call; the engine PREFERS it and SKIPS
  //    rasterization (rasterizing first would waste docling's native text layer).
  //
  // Both are optional so a document-native parser needn't carry a dead parsePage stub
  // (see DESIGN.md: parser = prompts/settings/decode behind one interface). The change
  // is purely additive — every existing parser already satisfies it — and the engine
  // throws a clear programmer-error if a parser supplies NEITHER. A future revision may
  // tighten this to a discriminated union keyed on `spec.requires`.
  parsePage?(input: PageInput, ctx: ParserContext): Promise<PageParse>;
  parseDocument?(pdf: Uint8Array, ctx: ParserContext): Promise<PageParse[]>;
}

/**
 * Author a Parser with type inference (flue defineAgent / parser-sdk defineParser analog).
 *
 * PROPOSAL(spike): generic over the concrete literal so a parser keeps its precise shape
 * (a VLM parser's `parsePage` stays non-optional at its definition/call sites; a
 * document-native parser exposes `parseDocument`). Behavior is unchanged — it still just
 * returns `def`.
 */
export function defineParser<T extends Parser>(def: T): T {
  return def;
}
