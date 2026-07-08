/**
 * Deterministic generator for test/fixtures/two-page.pdf — a tiny (<1KB), valid,
 * 2-page PDF with real text. No network, no binaries: the PDF bytes (incl. a
 * correct cross-reference table) are assembled by hand so rasterize/command tests
 * have a self-contained mupdf-openable fixture.
 *
 * Regenerate with: node test/fixtures/make-fixtures.mjs
 * Kept ASCII-only so string length == byte length (accurate xref offsets).
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PAGE = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
  '/Resources << /Font << /F1 7 0 R >> >> /Contents %C 0 R >>';

const stream1 = 'BT /F1 24 Tf 72 700 Td (Hello page one) Tj ET\n';
const stream2 = 'BT /F1 24 Tf 72 700 Td (Hello page two) Tj ET\n';

const objects = [
  null, // index 0 unused (PDF objects are 1-indexed)
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
  PAGE.replace('%C', '4'),
  `<< /Length ${stream1.length} >>\nstream\n${stream1}endstream`,
  PAGE.replace('%C', '6'),
  `<< /Length ${stream2.length} >>\nstream\n${stream2}endstream`,
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
];

let body = '%PDF-1.4\n';
const offsets = [];
for (let i = 1; i < objects.length; i++) {
  offsets[i] = Buffer.byteLength(body, 'latin1');
  body += `${i} 0 obj\n${objects[i]}\nendobj\n`;
}

const xrefStart = Buffer.byteLength(body, 'latin1');
const count = objects.length; // 8 (obj 0..7)
let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
for (let i = 1; i < objects.length; i++) {
  xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
}
const trailer = `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

const pdf = Buffer.from(body + xref + trailer, 'latin1');
const outPath = join(dirname(fileURLToPath(import.meta.url)), 'two-page.pdf');
writeFileSync(outPath, pdf);
console.log(`Wrote ${outPath} (${pdf.length} bytes, ${count - 1} objects, 2 pages)`);
