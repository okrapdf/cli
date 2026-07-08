/**
 * Agentic Workspace Export
 *
 * Creates a structured workspace directory for AI agents to consume.
 * Outputs JSON manifest to stdout for piping to agents.
 */

import { mkdirSync, writeFileSync, copyFileSync, readFileSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { JobResults, TableResult } from '../../types.js';
import type { NormalizedBbox } from '../../lib/pdf-image.js';
import type { PdfImageRenderer } from '../../lib/pdf-image.js';

/**
 * Workspace manifest for agents
 */
export interface WorkspaceManifest {
  version: string;
  job_id: string;
  working_dir: string;
  source: {
    filename: string;
    pages: number;
    file_size_bytes?: number;
  };
  assets: {
    tables: {
      count: number;
      csv_files: string[];
      json_file: string;
    };
    entities?: {
      count: number;
      json_file: string;
    };
    text: {
      markdown: string;
      per_page: string[];
    };
    images?: {
      pages: string[];
      entities: string[];
    };
  };
  processing: {
    created_at: string;
    cli_version: string;
  };
}

/**
 * Options for workspace creation
 */
export interface WorkspaceOptions {
  /** Include page images and figure crops */
  includeImages?: boolean;
  /** Image scale factor (1-4) */
  scale?: number;
  /** Image format */
  imageFormat?: 'png' | 'jpg';
  /** PDF buffer for image rendering */
  pdfBuffer?: Buffer;
  /** Original PDF path to copy */
  pdfPath?: string;
}

function getCliVersion(): string {
  try {
    const currentDir = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(currentDir, '..', '..', 'package.json');
    const raw = readFileSync(pkgPath, 'utf8');
    return JSON.parse(raw).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export async function createAgenticWorkspace(
  outputDir: string,
  results: JobResults,
  options: WorkspaceOptions = {}
): Promise<WorkspaceManifest> {
  const dir = resolve(outputDir);
  const { includeImages = false, scale = 2, imageFormat = 'png' } = options;

  // Normalize results - handle both API formats
  // API returns: { results: { tables: [], text: [] } }
  // Type expects: { tables: [], pages: [] }
  const rawResults = results as any;
  const tables = results.tables || rawResults.results?.tables || [];
  const pages = results.pages || (rawResults.results?.text || []).map((t: any) => ({
    page_number: t.page,
    text: t.content,
    entities: [],
  }));

  const entities: Array<{ id?: string; type?: string; page?: number; title?: string | null; bbox?: NormalizedBbox }> =
    rawResults.entities || rawResults.results?.entities || [];

  // Create directory structure
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, 'tables'), { recursive: true });
  mkdirSync(join(dir, 'entities'), { recursive: true });
  mkdirSync(join(dir, 'text'), { recursive: true });
  if (includeImages) {
  mkdirSync(join(dir, 'pages'), { recursive: true });
  mkdirSync(join(dir, 'entities'), { recursive: true });

  }

  const manifest: WorkspaceManifest = {
    version: '1.0',
    job_id: results.job_id,
    working_dir: dir,
    source: {
      filename: results.filename,
      pages: results.total_pages,
    },
    assets: {
      tables: {
        count: tables.length,
        csv_files: [],
        json_file: 'tables/all_tables.json',
      },
      entities: {
        count: entities.length,
        json_file: 'entities/all_entities.json',
      },
      text: {
        markdown: 'text/full_text.md',
        per_page: [],
      },
    },
    processing: {
      created_at: new Date().toISOString(),
      cli_version: getCliVersion(),
    },
  };

  // Write tables as CSV and JSON
  const tablesJson: Array<{
    id: string;
    page: number;
    markdown: string;
    rows?: string[][];
  }> = [];

  for (let i = 0; i < tables.length; i++) {
    const table = tables[i];
    const csvFilename = `table_${String(i + 1).padStart(3, '0')}_p${table.page_number}.csv`;
    const csvPath = join(dir, 'tables', csvFilename);

    // Convert markdown table to CSV
    const csv = markdownTableToCsv(table.content_markdown);
    writeFileSync(csvPath, csv, 'utf-8');
    manifest.assets.tables.csv_files.push(`tables/${csvFilename}`);

    tablesJson.push({
      id: table.id,
      page: table.page_number,
      markdown: table.content_markdown,
      rows: parseMarkdownTableRows(table.content_markdown),
    });
  }

  // Write combined tables JSON
  writeFileSync(
    join(dir, 'tables', 'all_tables.json'),
    JSON.stringify(tablesJson, null, 2),
    'utf-8'
  );

  writeFileSync(
    join(dir, 'entities', 'all_entities.json'),
    JSON.stringify(entities, null, 2),
    'utf-8'
  );

  // Write text files
  const fullTextParts: string[] = [];

  for (const page of pages) {
    const pageFilename = `page_${String(page.page_number).padStart(3, '0')}.md`;
    const pagePath = join(dir, 'text', pageFilename);

    const pageContent = `# Page ${page.page_number}\n\n${page.text}`;
    writeFileSync(pagePath, pageContent, 'utf-8');
    manifest.assets.text.per_page.push(`text/${pageFilename}`);

    fullTextParts.push(`## Page ${page.page_number}\n\n${page.text}`);
  }

  // Write full text markdown
  const fullText = `# ${results.filename}\n\nExtracted text from ${results.total_pages} pages.\n\n---\n\n${fullTextParts.join('\n\n---\n\n')}`;
  writeFileSync(join(dir, 'text', 'full_text.md'), fullText, 'utf-8');

  if (includeImages && options.pdfBuffer) {
    const imageAssets = await renderWorkspaceImages(
      dir,
      options.pdfBuffer,
      results.total_pages,
      tables,
      entities,
      { scale, format: imageFormat }
    );
    manifest.assets.images = imageAssets;
  }

  // Write manifest
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf-8'
  );

  return manifest;
}

/**
 * Render page images and figure crops
 */
async function renderWorkspaceImages(
  dir: string,
  pdfBuffer: Buffer,
  totalPages: number,
  tables: TableResult[],
  entities: Array<{ id?: string; type?: string; page?: number; title?: string | null; bbox?: NormalizedBbox }>,
  options: { scale: number; format: 'png' | 'jpg' }
): Promise<{ pages: string[]; entities: string[] }> {
  const { PdfImageRenderer } = await import('../../lib/pdf-image.js');
  const renderer = await PdfImageRenderer.fromBuffer(pdfBuffer);

  const pageImages: string[] = [];
  const entityImages: string[] = [];

  const slugify = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);

  try {
    // Render full page images
    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      const filename = `page_${String(pageNum).padStart(3, '0')}.${options.format}`;
      const image = await renderer.renderPage(pageNum, {
        format: options.format,
        scale: options.scale,
      });
      writeFileSync(join(dir, 'pages', filename), image.buffer);
      pageImages.push(`pages/${filename}`);
    }

    let figureIndex = 1;
    for (const table of tables) {
      if (table.bbox) {
        const filename = `table_${String(figureIndex).padStart(3, '0')}_p${table.page_number}.${options.format}`;
        const image = await renderer.renderRegion(table.page_number, table.bbox, {
          format: options.format,
          scale: options.scale,
          padding: 10,
        });
        writeFileSync(join(dir, 'entities', filename), image.buffer);
        entityImages.push(`entities/${filename}`);
        figureIndex++;
      }
    }

    for (const entity of entities) {
      if (!entity?.bbox || typeof entity.page !== 'number') continue;
      const typeLabel = entity.type ? slugify(entity.type) : 'entity';
      const titleLabel = entity.title ? slugify(entity.title) : null;
      const filename = `${typeLabel}_${String(figureIndex).padStart(3, '0')}_p${entity.page}${titleLabel ? `_${titleLabel}` : ''}.${options.format}`;
      const image = await renderer.renderRegion(entity.page, entity.bbox, {
        format: options.format,
        scale: options.scale,
        padding: 10,
      });
      writeFileSync(join(dir, 'entities', filename), image.buffer);
      entityImages.push(`entities/${filename}`);
      figureIndex++;
    }
  } finally {
    renderer.close();
  }

  return { pages: pageImages, entities: entityImages };
}

/**
 * Convert markdown table to CSV
 */
function markdownTableToCsv(markdown: string): string {
  const lines = markdown.trim().split('\n');
  const csvLines: string[] = [];

  for (const line of lines) {
    // Skip separator lines (|---|---|)
    if (line.match(/^\|[\s-:|]+\|$/)) continue;

    // Parse table row
    if (line.startsWith('|') && line.endsWith('|')) {
      const cells = line
        .slice(1, -1) // Remove leading/trailing |
        .split('|')
        .map(cell => {
          const trimmed = cell.trim();
          // Escape quotes and wrap in quotes if contains comma/quote/newline
          if (trimmed.includes(',') || trimmed.includes('"') || trimmed.includes('\n')) {
            return `"${trimmed.replace(/"/g, '""')}"`;
          }
          return trimmed;
        });
      csvLines.push(cells.join(','));
    }
  }

  return csvLines.join('\n');
}

/**
 * Parse markdown table into rows array
 */
function parseMarkdownTableRows(markdown: string): string[][] {
  const lines = markdown.trim().split('\n');
  const rows: string[][] = [];

  for (const line of lines) {
    if (line.match(/^\|[\s-:|]+\|$/)) continue;

    if (line.startsWith('|') && line.endsWith('|')) {
      const cells = line
        .slice(1, -1)
        .split('|')
        .map(cell => cell.trim());
      rows.push(cells);
    }
  }

  return rows;
}
