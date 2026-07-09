/**
 * Decode model output (markdown with <div data-bbox data-label> wrappers) into blocks.
 *
 * Lineage: run-llama/ParseBench `_layout_utils.py` (MIT) → okra monorepo
 * `packages/parser-gemini/src/bbox.ts` → here. Pure functions — the golden-test surface.
 *
 * RawBlock.page is optional here (only multipage prompts emit data-page); the parser
 * fills the authoritative page number from PageInput when mapping to core LayoutBlock.
 *
 * DELIBERATE DEVIATION from the vendored source (#17): `itemsToMarkdown` strips a leading
 * markdown heading marker (`#{1,6}\s+`) from Title/Section-header block text before adding
 * its own `#`/`##` prefix. Some models emit a heading already pre-hashed inside the block
 * text; the upstream code prefixed unconditionally, producing a double `# # Foo`. Formula
 * text is kept verbatim (never stripped); plain Text blocks are untouched.
 */

export type RawBlock = {
  bbox: [number, number, number, number];
  label: string;
  text: string;
  page?: number;
};

const BBOX_FIRST = new RegExp(
  String.raw`<div\s+[^>]*?data-bbox=["'](\[[^\]]+\])["'][^>]*?data-label=["']([^"']+)["'][^>]*?>([\s\S]*?)<\/div>`,
  'gi',
);
const LABEL_FIRST = new RegExp(
  String.raw`<div\s+[^>]*?data-label=["']([^"']+)["'][^>]*?data-bbox=["'](\[[^\]]+\])["'][^>]*?>([\s\S]*?)<\/div>`,
  'gi',
);
const DATA_PAGE = /data-page=["'](\d+)["']/i;

function tryParseBbox(raw: string): [number, number, number, number] | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      Array.isArray(parsed) &&
      parsed.length === 4 &&
      parsed.every((n) => typeof n === 'number' && Number.isFinite(n))
    ) {
      return parsed as [number, number, number, number];
    }
  } catch {
    /* ignored; fall through */
  }
  return null;
}

function stripInnerHtml(text: string): string {
  return text.trim();
}

export function parseLayoutBlocks(content: string): RawBlock[] {
  type RawMatch = { pos: number; bboxStr: string; label: string; text: string; openTag: string };
  const rawMatches: RawMatch[] = [];

  for (const match of content.matchAll(BBOX_FIRST)) {
    rawMatches.push({
      pos: match.index ?? 0,
      bboxStr: match[1],
      label: match[2],
      text: match[3],
      openTag: match[0].slice(0, match[0].indexOf('>') + 1),
    });
  }
  for (const match of content.matchAll(LABEL_FIRST)) {
    rawMatches.push({
      pos: match.index ?? 0,
      bboxStr: match[2],
      label: match[1],
      text: match[3],
      openTag: match[0].slice(0, match[0].indexOf('>') + 1),
    });
  }

  rawMatches.sort((a, b) => a.pos - b.pos);

  const seen = new Set<number>();
  const blocks: RawBlock[] = [];
  for (const m of rawMatches) {
    if (seen.has(m.pos)) continue;
    seen.add(m.pos);
    const bbox = tryParseBbox(m.bboxStr);
    if (!bbox) continue;
    const pageMatch = DATA_PAGE.exec(m.openTag);
    const page = pageMatch ? Number.parseInt(pageMatch[1], 10) : undefined;
    blocks.push({
      bbox,
      label: m.label,
      text: stripInnerHtml(m.text),
      ...(page && page > 0 ? { page } : {}),
    });
  }
  return blocks;
}

/** Gemini models natively emit [y_min, x_min, y_max, x_max]; swap back to x-first. */
export function swapGeminiBbox(blocks: RawBlock[]): RawBlock[] {
  return blocks.map((b) => {
    if (b.bbox.length !== 4) return b;
    const [yMin, xMin, yMax, xMax] = b.bbox;
    return { ...b, bbox: [xMin, yMin, xMax, yMax] };
  });
}

/**
 * Strip a single leading markdown heading marker (`#{1,6}` + whitespace) so heading
 * block text that already arrives pre-hashed isn't prefixed a second time (#17).
 * Only applied to heading labels; mid-text hashes and non-heading blocks are untouched.
 */
function stripLeadingHeadingMarker(text: string): string {
  return text.replace(/^#{1,6}\s+/, '');
}

/** Reading-order markdown from blocks (Title → #, Section-header → ##, Formula → $$). */
export function itemsToMarkdown(blocks: RawBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    const label = block.label.toLowerCase();
    const text = block.text;
    if (!text) continue;
    if (label === 'title') parts.push(`# ${stripLeadingHeadingMarker(text)}`);
    else if (label === 'section-header' || label === 'section_header')
      parts.push(`## ${stripLeadingHeadingMarker(text)}`);
    else if (label === 'formula') parts.push(`$$\n${text}\n$$`);
    else parts.push(text);
  }
  return parts.join('\n\n');
}

/** Convert 0-1000 [x1,y1,x2,y2] to okra box-JSON {x,y,w,h} in 0-1 (top-left origin). */
export function bboxToNormalized(bbox: [number, number, number, number]): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  const [x1, y1, x2, y2] = bbox;
  const x = Math.max(0, Math.min(x1, x2)) / 1000;
  const y = Math.max(0, Math.min(y1, y2)) / 1000;
  const w = Math.max(0, Math.abs(x2 - x1)) / 1000;
  const h = Math.max(0, Math.abs(y2 - y1)) / 1000;
  return { x, y, w, h };
}
