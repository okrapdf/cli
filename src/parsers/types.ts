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
  parsePage(input: PageInput, ctx: ParserContext): Promise<PageParse>;
}

/** Author a Parser with type inference (flue defineAgent / parser-sdk defineParser analog). */
export function defineParser(def: Parser): Parser {
  return def;
}
