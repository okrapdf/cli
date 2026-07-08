/**
 * Layout-parsing prompts — vendored so the CLI has zero okra-cloud dependency.
 *
 * Lineage: run-llama/ParseBench `google.py` (MIT) → okra monorepo
 * `packages/parser-gemini/src/prompts.ts` → here, verbatim. See README NOTICE.
 *
 * These prompts ARE the parser's behavior: they request markdown with each layout
 * element wrapped in <div data-bbox data-label> using normalized 0-1000 coordinates.
 * The `_GEMINI` variants request [y_min, x_min, y_max, x_max] order because Gemini
 * models natively emit y-first boxes (see quirks.ts); decode swaps them back.
 */

export const SYSTEM_PROMPT_LAYOUT =
  'You are a document parser. Your task is to convert ' +
  'document images to clean, well-structured markdown.' +
  '\n\nGuidelines:\n' +
  '- Preserve the document structure ' +
  '(headings, paragraphs, lists, tables)\n' +
  '- Convert tables to HTML format ' +
  '(<table>, <tr>, <th>, <td>)\n' +
  '- For existing tables in the document: use colspan ' +
  'and rowspan attributes to preserve merged cells ' +
  'and hierarchical headers\n' +
  '- For charts/graphs being converted to tables: use ' +
  'flat combined column headers (e.g., ' +
  '"Primary 2015" not separate rows) so each data ' +
  "cell's row contains all its labels\n" +
  '- Describe images/figures briefly in square brackets ' +
  'like [Figure: description]\n' +
  '- Preserve any code blocks with appropriate syntax ' +
  'highlighting\n' +
  '- Maintain reading order (left-to-right, ' +
  'top-to-bottom for Western documents)\n' +
  '- Do not add commentary or explanations ' +
  '- only output the parsed content' +
  '\n\n' +
  'Additionally, wrap each layout element in a <div> tag with:\n' +
  '- data-bbox="[x1, y1, x2, y2]" — bounding box in normalized 0-1000 ' +
  'coordinates where x is horizontal (left edge = 0, right edge = 1000) ' +
  'and y is vertical (top = 0, bottom = 1000). ' +
  'x1,y1 is the top-left corner and x2,y2 is the bottom-right corner.\n' +
  '- data-label="<category>" — one of: Caption, Footnote, Formula, ' +
  'List-item, Page-footer, Page-header, Picture, Section-header, ' +
  'Table, Text, Title\n\n' +
  'Place elements in reading order. Every piece of content must be ' +
  'inside exactly one <div> wrapper.';

export const USER_PROMPT_LAYOUT =
  'Parse this document page and output its content as ' +
  'clean markdown, with each layout element wrapped in a ' +
  '<div data-bbox="[x1,y1,x2,y2]" data-label="Category"> tag. ' +
  'Use HTML tables for any tabular data. ' +
  'For charts/graphs, use flat combined column headers. ' +
  'Output ONLY the parsed content with div wrappers, ' +
  'no explanations.';

export const SYSTEM_PROMPT_LAYOUT_GEMINI = SYSTEM_PROMPT_LAYOUT.replace(
  '"[x1, y1, x2, y2]" — bounding box in normalized 0-1000 ' +
    'coordinates where x is horizontal (left edge = 0, right edge = 1000) ' +
    'and y is vertical (top = 0, bottom = 1000). ' +
    'x1,y1 is the top-left corner and x2,y2 is the bottom-right corner.',
  '"[y_min, x_min, y_max, x_max]" — bounding box in normalized 0-1000 ' +
    'coordinates where x is horizontal (left edge = 0, right edge = 1000) ' +
    'and y is vertical (top = 0, bottom = 1000). ' +
    'The order is [y_min, x_min, y_max, x_max].',
);

export const USER_PROMPT_LAYOUT_GEMINI = USER_PROMPT_LAYOUT.replace(
  '[x1,y1,x2,y2]',
  '[y_min,x_min,y_max,x_max]',
);

export const LABEL_MAP: Record<string, string> = {
  caption: 'Caption',
  footnote: 'Footnote',
  formula: 'Formula',
  'list-item': 'List-item',
  list_item: 'List-item',
  'page-footer': 'Page-footer',
  page_footer: 'Page-footer',
  'page-header': 'Page-header',
  page_header: 'Page-header',
  picture: 'Picture',
  figure: 'Picture',
  'section-header': 'Section-header',
  section_header: 'Section-header',
  table: 'Table',
  text: 'Text',
  title: 'Title',
};

export function canonicalLabel(raw: string): string {
  return LABEL_MAP[raw.toLowerCase()] ?? raw;
}
