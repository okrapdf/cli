/**
 * Table extraction commands
 */

import { Command } from 'commander';
import { writeFileSync } from 'fs';
import chalk from 'chalk';
import { get, OkraApiError, EXIT_CODES } from '../lib/client.js';
import {
  formatOutput,
  success,
  error,
} from '../lib/output.js';
import { withSpinner } from '../lib/progress.js';
import { getDefaultFormat, isJsonOutput } from '../lib/config.js';
import type { Table, PaginatedResponse, OutputFormat } from '../types.js';

// Columns for table list display
const TABLE_COLUMNS = [
  { key: 'id', header: 'Table ID', width: 38 },
  { key: 'page_number', header: 'Page', width: 6 },
  { key: 'processor_type', header: 'Source', width: 10 },
  { key: 'confidence_fmt', header: 'Confidence', width: 12 },
  { key: 'preview', header: 'Preview', width: 40 },
];

export function createTablesCommand(): Command {
  const tables = new Command('tables')
    .description('Manage extracted tables');

  // tables list
  tables
    .command('list <documentUuid>')
    .alias('ls')
    .description('List tables from a document')
    .option('-o, --output <format>', 'Output format (table, json, csv)', getDefaultFormat())
    .option('-p, --page <n>', 'Filter by page number')
    .action(async (documentUuid, options) => {
      const params: Record<string, string> = {};

      if (options.page) {
        params.page_number = options.page;
      }

      const response = await withSpinner(
        'Fetching tables',
        () => get<PaginatedResponse<Table> | Table[]>(`api/extractions/${documentUuid}`, params)
      );

      // Handle both array and paginated responses
      const items = Array.isArray(response) ? response : response.items;

      if (items.length === 0) {
        console.log(chalk.dim('No tables found'));
        return;
      }

      // Format for display
      const formatted = items.map(table => ({
        ...table,
        confidence_fmt: table.confidence !== null
          ? `${(table.confidence * 100).toFixed(0)}%`
          : '-',
        preview: truncate(table.content_markdown.replace(/\n/g, ' '), 40),
      }));

      console.log(formatOutput(formatted, options.output as OutputFormat, TABLE_COLUMNS));
    });

  // tables get
  tables
    .command('get <tableId>')
    .description('Get table content')
    .option('-o, --output <format>', 'Output format (markdown, json)', 'markdown')
    .action(async (tableId, options) => {
      try {
        const table = await withSpinner(
          'Fetching table',
          () => get<Table>(`api/extractions/tables/${tableId}`)
        );

        if (options.output === 'json') {
          console.log(formatOutput(table, 'json'));
        } else {
          // Default: markdown output
          console.log(chalk.bold(`Table (Page ${table.page_number})`));
          console.log(chalk.dim('─'.repeat(50)));
          console.log(table.content_markdown);
          console.log();
          console.log(chalk.dim(`ID: ${table.id}`));
          console.log(chalk.dim(`Source: ${table.processor_type}`));
          if (table.confidence !== null) {
            console.log(chalk.dim(`Confidence: ${(table.confidence * 100).toFixed(1)}%`));
          }
        }
      } catch (err) {
        if (err instanceof OkraApiError && err.statusCode === 404) {
          error(`Table not found: ${tableId}`);
          process.exit(EXIT_CODES.NOT_FOUND);
        }
        throw err;
      }
    });

  // tables export
  tables
    .command('export <tableId>')
    .description('Export table to a file')
    .option('-f, --format <format>', 'Export format (csv, json, xlsx, markdown)', 'csv')
    .option('-o, --out <path>', 'Output file path')
    .option('--output-format <format>', 'Result output format (table, json)', 'table')
    .action(async (tableId, options) => {
      const useJsonResult = options.outputFormat === 'json' || isJsonOutput();

      try {
        const table = await withSpinner(
          'Fetching table',
          () => get<Table>(`api/extractions/tables/${tableId}`)
        );

        const format = options.format;
        let content: string;
        let ext: string;

        switch (format) {
          case 'json':
            content = JSON.stringify(table, null, 2);
            ext = 'json';
            break;

          case 'csv':
            content = markdownTableToCsv(table.content_markdown);
            ext = 'csv';
            break;

          case 'markdown':
          case 'md':
            content = table.content_markdown;
            ext = 'md';
            break;

          case 'xlsx':
            if (useJsonResult) {
              console.log(formatOutput({ success: false, error: 'XLSX export not yet implemented. Use CSV or JSON.' }, 'json'));
            } else {
              error('XLSX export not yet implemented. Use CSV or JSON.');
            }
            process.exit(EXIT_CODES.INVALID_ARGS);
            return;

          default:
            if (useJsonResult) {
              console.log(formatOutput({ success: false, error: `Invalid format: ${format}. Use: csv, json, markdown` }, 'json'));
            } else {
              error(`Invalid format: ${format}. Use: csv, json, markdown`);
            }
            process.exit(EXIT_CODES.INVALID_ARGS);
            return;
        }

        const outputPath = options.out || `table-${tableId.slice(0, 8)}.${ext}`;
        writeFileSync(outputPath, content, 'utf-8');

        if (useJsonResult) {
          console.log(formatOutput({
            success: true,
            table_id: tableId,
            format,
            output_path: outputPath,
          }, 'json'));
        } else {
          success(`Exported to: ${outputPath}`);
        }
      } catch (err) {
        if (err instanceof OkraApiError && err.statusCode === 404) {
          if (useJsonResult) {
            console.log(formatOutput({ success: false, error: `Table not found: ${tableId}` }, 'json'));
          } else {
            error(`Table not found: ${tableId}`);
          }
          process.exit(EXIT_CODES.NOT_FOUND);
        }
        throw err;
      }
    });

  // tables search
  tables
    .command('search <documentUuid> <query>')
    .description('Search within extracted tables')
    .option('-o, --output <format>', 'Output format (table, json)', getDefaultFormat())
    .action(async (documentUuid, query, options) => {
      const response = await withSpinner(
        'Searching tables',
        () => get<{ results: Table[] }>(`api/extractions/${documentUuid}/search`, { q: query })
      );

      if (response.results.length === 0) {
        console.log(chalk.dim('No matching tables found'));
        return;
      }

      // Format for display
      const formatted = response.results.map(table => ({
        ...table,
        confidence_fmt: table.confidence !== null
          ? `${(table.confidence * 100).toFixed(0)}%`
          : '-',
        preview: truncate(table.content_markdown.replace(/\n/g, ' '), 40),
      }));

      console.log(formatOutput(formatted, options.output as OutputFormat, TABLE_COLUMNS));
    });

  return tables;
}

/**
 * Truncate string with ellipsis
 */
function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 3) + '...';
}

/**
 * Convert markdown table to CSV
 */
function markdownTableToCsv(markdown: string): string {
  const lines = markdown.trim().split('\n');
  const csvLines: string[] = [];

  for (const line of lines) {
    // Skip separator lines (like |---|---|)
    if (line.match(/^\|[\s-:|]+\|$/)) continue;

    // Parse table row
    if (line.startsWith('|') && line.endsWith('|')) {
      const cells = line
        .slice(1, -1) // Remove leading/trailing pipes
        .split('|')
        .map(cell => cell.trim());

      // Escape CSV fields
      const escapedCells = cells.map(cell => {
        if (cell.includes(',') || cell.includes('"') || cell.includes('\n')) {
          return `"${cell.replace(/"/g, '""')}"`;
        }
        return cell;
      });

      csvLines.push(escapedCells.join(','));
    }
  }

  return csvLines.join('\n');
}
