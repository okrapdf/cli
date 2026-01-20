/**
 * Document management commands
 */

import { Command } from 'commander';
import { createReadStream, statSync, existsSync } from 'fs';
import { basename, resolve } from 'path';
import chalk from 'chalk';
import { get, post, del, uploadFile, downloadFile, OkraApiError, EXIT_CODES } from '../lib/client.js';
import {
  formatOutput,
  formatFileSize,
  formatDate,
  success,
  error,
} from '../lib/output.js';
import { withSpinner } from '../lib/progress.js';
import { getDefaultFormat, isJsonOutput } from '../lib/config.js';

import type { Document, PaginatedResponse, SignedUrlResponse, OutputFormat } from '../types.js';

// Columns for document table display
const DOC_COLUMNS = [
  { key: 'uuid', header: 'ID', width: 38 },
  { key: 'file_name', header: 'Name', width: 40 },
  { key: 'file_size_fmt', header: 'Size', width: 10 },
  { key: 'upload_date_fmt', header: 'Uploaded', width: 12 },
  { key: 'tables_count', header: 'Tables', width: 8 },
];

export function createDocsCommand(): Command {
  const docs = new Command('docs')
    .alias('documents')
    .description('Manage documents');

  // docs list
  docs
    .command('list')
    .alias('ls')
    .description('List all documents')
    .option('-o, --output <format>', 'Output format (table, json, csv)', getDefaultFormat())
    .option('-l, --limit <n>', 'Limit results', '20')
    .option('-p, --page <n>', 'Page number', '1')
    .action(async (options) => {
      const response = await withSpinner(
        'Fetching documents',
        () => get<PaginatedResponse<Document>>('api/documents', {
          limit: options.limit,
          page: options.page,
        })
      );

      if (response.items.length === 0) {
        console.log(chalk.dim('No documents found'));
        return;
      }

      const formatted = response.items.map(doc => ({
        ...doc,
        file_size_fmt: formatFileSize(doc.file_size),
        upload_date_fmt: formatDate(doc.upload_date),
        tables_count: doc.tables_count ?? 0,
      }));

      console.log(formatOutput(formatted, options.output as OutputFormat, DOC_COLUMNS));

      const { pagination } = response;
      if (pagination.totalPages > 1) {
        console.log(chalk.dim(`\nPage ${pagination.page} of ${pagination.totalPages} (${pagination.total} total)`));
      }
    });

  // docs get
  docs
    .command('get <uuid>')
    .description('Get document details')
    .option('-o, --output <format>', 'Output format (table, json)', getDefaultFormat())
    .action(async (uuid, options) => {
      try {
        const doc = await withSpinner(
          'Fetching document',
          () => get<Document>(`api/library/document`, { uuid })
        );

        if (options.output === 'json') {
          console.log(formatOutput(doc, 'json'));
        } else {
          console.log(chalk.bold('Document Details'));
          console.log(chalk.dim('─'.repeat(50)));
          console.log(chalk.bold('UUID:'), doc.uuid);
          console.log(chalk.bold('Name:'), doc.file_name);
          console.log(chalk.bold('Size:'), formatFileSize(doc.file_size));
          console.log(chalk.bold('Type:'), doc.document_type);
          console.log(chalk.bold('Uploaded:'), new Date(doc.upload_date).toLocaleString());
          if (doc.tables_count !== undefined) {
            console.log(chalk.bold('Tables:'), doc.tables_count);
          }
        }
      } catch (err) {
        if (err instanceof OkraApiError && err.statusCode === 404) {
          error(`Document not found: ${uuid}`);
          process.exit(EXIT_CODES.NOT_FOUND);
        }
        throw err;
      }
    });

  // docs download
  docs
    .command('download <uuid>')
    .description('Download original PDF')
    .option('-o, --out <path>', 'Output file path')
    .option('--format <format>', 'Output format for result (table, json)', 'table')
    .action(async (uuid, options) => {
      const useJson = options.format === 'json' || isJsonOutput();

      // Get document details
      const doc = await withSpinner(
        'Fetching document info',
        () => get<Document>(`api/library/document`, { uuid })
      );

      // Get download URL
      const downloadInfo = await withSpinner(
        'Getting download URL',
        () => get<{ url: string }>('api/library/file', { uuid })
      );

      // Determine output path
      const outputPath = options.out || doc.file_name;

      // Download file
      await withSpinner(
        `Downloading to ${outputPath}`,
        () => downloadFile(downloadInfo.url, outputPath)
      );

      if (useJson) {
        console.log(formatOutput({
          success: true,
          uuid,
          file_name: doc.file_name,
          output_path: outputPath,
        }, 'json'));
      } else {
        success(`Downloaded: ${outputPath}`);
      }
    });

  // docs delete
  docs
    .command('delete <uuid>')
    .alias('rm')
    .description('Delete a document')
    .option('-f, --force', 'Skip confirmation')
    .option('-o, --output <format>', 'Output format (table, json)', 'table')
    .action(async (uuid, options) => {
      const useJson = options.output === 'json' || isJsonOutput();

      if (!options.force && !useJson) {
        const { prompt } = await import('enquirer');
        const response = await prompt<{ confirm: boolean }>({
          type: 'confirm',
          name: 'confirm',
          message: `Are you sure you want to delete document ${uuid}?`,
          initial: false,
        });

        if (!response.confirm) {
          console.log('Cancelled');
          return;
        }
      }

      try {
        await withSpinner(
          'Deleting document',
          () => del(`api/library/delete?uuid=${uuid}`)
        );

        if (useJson) {
          console.log(formatOutput({ success: true, uuid, message: 'Document deleted' }, 'json'));
        } else {
          success(`Document deleted: ${uuid}`);
        }
      } catch (err) {
        if (err instanceof OkraApiError && err.statusCode === 404) {
          if (useJson) {
            console.log(formatOutput({ success: false, uuid, error: 'Document not found' }, 'json'));
          } else {
            error(`Document not found: ${uuid}`);
          }
          process.exit(EXIT_CODES.NOT_FOUND);
        }
        throw err;
      }
    });

  return docs;
}
