/**
 * Canonical parse output contract.
 * @architect-owned — see DESIGN.md "Canonical output contract". Implementations elsewhere.
 *
 * Every parser, regardless of backend (VLM, docling-serve, text-layer), emits these shapes.
 */

/** The 11-category ParseBench/DocLayNet-style label set, with open escape hatch. */
export type BlockLabel =
  | 'Caption'
  | 'Footnote'
  | 'Formula'
  | 'List-item'
  | 'Page-footer'
  | 'Page-header'
  | 'Picture'
  | 'Section-header'
  | 'Table'
  | 'Text'
  | 'Title'
  | (string & {});

/**
 * [x1, y1, x2, y2] in normalized 0-1000 coordinates, top-left origin.
 * x horizontal (left=0, right=1000), y vertical (top=0, bottom=1000).
 * This is the ParseBench-native shape the prompts request. For okra box-JSON
 * ({x,y,w,h} in 0-1) convert explicitly via `bboxToNormalized` — never mix units implicitly.
 */
export type Bbox = [number, number, number, number];

export interface LayoutBlock {
  label: BlockLabel;
  bbox: Bbox;
  text: string;
  /** 1-indexed page number. */
  page: number;
}

export interface PageParse {
  /** 1-indexed. */
  page: number;
  /** Markdown for this page (block texts in reading order, headings/formulas formatted). */
  markdown: string;
  blocks: LayoutBlock[];
  usage?: TokenUsage;
}

export interface DocumentParse {
  /** Whole-document markdown: page markdowns joined with blank lines. */
  markdown: string;
  pages: PageParse[];
  /** All blocks across pages, in (page, reading-order) order. */
  blocks: LayoutBlock[];
  usage: TokenUsage;
  meta: ParseRunMeta;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** Model thinking/reasoning tokens when the provider reports them. */
  thinkingTokens: number;
}

export const EMPTY_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0, thinkingTokens: 0 };

export function addUsage(a: TokenUsage, b: TokenUsage | undefined): TokenUsage {
  if (!b) return a;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    thinkingTokens: a.thinkingTokens + b.thinkingTokens,
  };
}

/** Run metadata — becomes manifest.json. */
export interface ParseRunMeta {
  parserId: string;
  providerId?: string;
  model?: string;
  pageCount: number;
  durationMs: number;
  /** Omitted (undefined) when pricing for the model is unknown — never guessed. */
  costUsd?: number;
  warnings: string[];
}
