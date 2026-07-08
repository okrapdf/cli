/**
 * Entity management commands
 *
 * Commands for working with extracted entities (tables, figures, footnotes, etc.)
 */

import { Command } from 'commander';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import chalk from 'chalk';
import { get, OkraApiError, EXIT_CODES } from '../lib/client.js';
import {
  formatOutput,
  formatStatus,
  success,
  error,
  info,
  warn,
} from '../../lib/output.js';
import { withSpinner } from '../../lib/progress.js';
import { getDefaultFormat, isJsonOutput } from '../../lib/config.js';
import type { OutputFormat, Job, BoundingBox } from '../../types.js';

// Entity response types (matching API)
interface EntityBbox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Entity {
  id: string;
  type: 'table' | 'figure' | 'footnote' | 'summary' | 'signature';
  title: string | null;
  page: number;
  schema?: string[];
  isComplete?: boolean;
  bbox?: EntityBbox;
}

interface EntitiesResponse {
  jobId: string;
  entities: Entity[];
  counts: {
    tables: number;
    figures: number;
    footnotes: number;
    summaries: number;
    signatures: number;
  };
  extractionStatus: string;
  totalPages?: number;
}

// Columns for entity table display
const ENTITY_COLUMNS = [
  { key: 'id', header: 'Entity ID', width: 25 },
  { key: 'type', header: 'Type', width: 12 },
  { key: 'page', header: 'Page', width: 6 },
  { key: 'title_fmt', header: 'Title', width: 40 },
  { key: 'has_bbox', header: 'BBox', width: 6 },
];

export function createEntitiesCommand(): Command {
  const entities = new Command('entities')
    .description('Manage extracted entities (tables, figures, footnotes)');

  // entities list
  entities
    .command('list <jobId>')
    .alias('ls')
    .description('List entities from a job')
    .option('-o, --output <format>', 'Output format (table, json, csv)', getDefaultFormat())
    .option('-t, --type <type>', 'Filter by type (tables, figures, footnotes, summaries, signatures, all)', 'all')
    .option('-p, --page <n>', 'Filter by page number')
    .option('--with-bbox', 'Only show entities with bounding boxes')
    .action(async (jobId, options) => {
      const params: Record<string, string> = {
        type: options.type,
      };

      const response = await withSpinner(
        'Fetching entities',
        () => get<EntitiesResponse>(`api/ocr/jobs/${jobId}/entities`, params)
      );

      let entities = response.entities;

      // Filter by page if specified
      if (options.page) {
        const pageNum = parseInt(options.page, 10);
        entities = entities.filter(e => e.page === pageNum);
      }

      // Filter by bbox if specified
      if (options.withBbox) {
        entities = entities.filter(e => e.bbox != null);
      }

      if (entities.length === 0) {
        console.log(chalk.dim('No entities found'));
        return;
      }

      // Format for display
      const formatted = entities.map(entity => ({
        ...entity,
        title_fmt: truncate(entity.title || '-', 40),
        has_bbox: entity.bbox ? chalk.green('Yes') : chalk.dim('No'),
      }));

      console.log(formatOutput(formatted, options.output as OutputFormat, ENTITY_COLUMNS));

      // Show counts summary
      if (!isJsonOutput() && options.output !== 'json') {
        console.log(chalk.dim(`\nTotal: ${entities.length} entities`));
        console.log(chalk.dim(`Status: ${formatStatus(response.extractionStatus)}`));
      }
    });

  // entities images
  entities
    .command('images <jobId>')
    .description('Export entities as cropped images from the PDF')
    .option('-o, --out <dir>', 'Output directory', './entity-images')
    .option('-f, --format <format>', 'Image format (png, jpg)', 'png')
    .option('-t, --type <type>', 'Filter by entity type (tables, figures, all)', 'all')
    .option('-p, --page <n>', 'Filter by page number')
    .option('-q, --quality <n>', 'JPEG quality (1-100)', '90')
    .option('-s, --scale <n>', 'Scale factor for rendering (1-4)', '2')
    .option('--padding <n>', 'Padding around crop region in pixels', '10')
    .option('--output-format <format>', 'Result output format (table, json)', 'table')
    .action(async (jobId, options) => {
      const useJson = options.outputFormat === 'json' || isJsonOutput();
      const format = options.format.toLowerCase() as 'png' | 'jpg';

      if (format !== 'png' && format !== 'jpg') {
        if (useJson) {
          console.log(formatOutput({ success: false, error: 'Invalid format. Use: png or jpg' }, 'json'));
        } else {
          error('Invalid format. Use: png or jpg');
        }
        process.exit(EXIT_CODES.INVALID_ARGS);
      }

      // Fetch entities
      const entitiesResponse = await withSpinner(
        'Fetching entities',
        () => get<EntitiesResponse>(`api/ocr/jobs/${jobId}/entities`, { type: options.type })
      );

      let entities = entitiesResponse.entities.filter(e => e.bbox != null);

      // Filter by page if specified
      if (options.page) {
        const pageNum = parseInt(options.page, 10);
        entities = entities.filter(e => e.page === pageNum);
      }

      if (entities.length === 0) {
        if (useJson) {
          console.log(formatOutput({
            success: true,
            job_id: jobId,
            message: 'No entities with bounding boxes found',
            exported: 0,
          }, 'json'));
        } else {
          warn('No entities with bounding boxes found');
        }
        return;
      }

      info(`Found ${entities.length} entities with bounding boxes`);

      // Get job info to find the document
      const job = await withSpinner(
        'Fetching job info',
        () => get<Job>(`api/v1/jobs/${jobId}`)
      );

      if (!job.document_uuid) {
        if (useJson) {
          console.log(formatOutput({ success: false, error: 'Job has no associated document' }, 'json'));
        } else {
          error('Job has no associated document');
        }
        process.exit(EXIT_CODES.GENERAL_ERROR);
      }

      // Get document download URL
      const docInfo = await withSpinner(
        'Getting document URL',
        () => get<{ signed_url: string }>(`api/documents/${job.document_uuid}/download`)
      );

      // Download PDF
      const { downloadFile: downloadToBuffer } = await import('../lib/client.js');
      const got = (await import('got')).default;

      info('Downloading PDF...');
      const pdfResponse = await got(docInfo.signed_url, { responseType: 'buffer' });
      const pdfBuffer = pdfResponse.body;

      // Import the PDF image renderer
      const { PdfImageRenderer } = await import('../../lib/pdf-image.js');

      // Create output directory
      const outDir = resolve(options.out);
      if (!existsSync(outDir)) {
        mkdirSync(outDir, { recursive: true });
      }

      // Render and export each entity
      const renderer = await PdfImageRenderer.fromBuffer(pdfBuffer);
      const exported: { entity_id: string; file: string; page: number; type: string }[] = [];
      const errors: { entity_id: string; error: string }[] = [];

      const renderOptions = {
        format,
        quality: parseInt(options.quality, 10),
        scale: parseFloat(options.scale),
        padding: parseInt(options.padding, 10),
      };

      console.log(chalk.dim(`Exporting ${entities.length} entities to ${outDir}...`));

      for (const entity of entities) {
        try {
          const result = await renderer.renderRegion(entity.page, entity.bbox!, renderOptions);

          // Generate filename
          const safeTitle = (entity.title || 'untitled')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .slice(0, 30);
          const filename = `${entity.type}-p${entity.page}-${safeTitle}.${format}`;
          const filepath = join(outDir, filename);

          writeFileSync(filepath, result.buffer);
          exported.push({
            entity_id: entity.id,
            file: filepath,
            page: entity.page,
            type: entity.type,
          });

          if (!useJson) {
            console.log(chalk.green('  ✓'), chalk.dim(`${entity.type} p${entity.page}:`), filename);
          }
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : 'Unknown error';
          errors.push({ entity_id: entity.id, error: errorMsg });

          if (!useJson) {
            console.log(chalk.red('  ✗'), chalk.dim(`${entity.type} p${entity.page}:`), errorMsg);
          }
        }
      }

      renderer.close();

      // Output results
      if (useJson) {
        console.log(formatOutput({
          success: errors.length === 0,
          job_id: jobId,
          output_dir: outDir,
          format,
          exported: exported.length,
          errors: errors.length,
          files: exported,
          error_details: errors.length > 0 ? errors : undefined,
        }, 'json'));
      } else {
        console.log();
        if (exported.length > 0) {
          success(`Exported ${exported.length} images to: ${outDir}`);
        }
        if (errors.length > 0) {
          warn(`${errors.length} entities failed to export`);
        }
      }
    });

  // entities count
  entities
    .command('count <jobId>')
    .description('Get entity counts for a job')
    .option('-o, --output <format>', 'Output format (table, json)', getDefaultFormat())
    .action(async (jobId, options) => {
      const response = await withSpinner(
        'Fetching entity counts',
        () => get<EntitiesResponse>(`api/ocr/jobs/${jobId}/entities`)
      );

      if (options.output === 'json') {
        console.log(formatOutput({
          job_id: jobId,
          counts: response.counts,
          extraction_status: response.extractionStatus,
          total_pages: response.totalPages,
        }, 'json'));
      } else {
        console.log(chalk.bold('\nEntity Counts'));
        console.log(chalk.dim('─'.repeat(30)));
        console.log(chalk.bold('Tables:'), response.counts.tables);
        console.log(chalk.bold('Figures:'), response.counts.figures);
        console.log(chalk.bold('Footnotes:'), response.counts.footnotes);
        console.log(chalk.bold('Summaries:'), response.counts.summaries);
        console.log(chalk.bold('Signatures:'), response.counts.signatures);
        console.log();
        console.log(chalk.dim(`Status: ${response.extractionStatus}`));
        if (response.totalPages) {
          console.log(chalk.dim(`Total pages: ${response.totalPages}`));
        }
      }
    });

  return entities;
}

/**
 * Truncate string with ellipsis
 */
function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 3) + '...';
}
