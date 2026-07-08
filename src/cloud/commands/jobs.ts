/**
 * Job management commands
 */

import { Command } from 'commander';
import { existsSync, statSync } from 'fs';
import { resolve, basename } from 'path';
import chalk from 'chalk';
import { get, post, del, uploadFile, OkraApiError, EXIT_CODES } from '../lib/client.js';
import {
  formatOutput,
  formatDate,
  formatStatus,
  success,
  error,
  info,
} from '../../lib/output.js';
import { withSpinner, pollWithProgress, sleep } from '../../lib/progress.js';
import { getDefaultFormat, isJsonOutput } from '../../lib/config.js';
import { openInBrowser, getJobWebUrl } from '../lib/browser.js';
import type { Job, CreateJobResponse, JobResults, JobResultsApiResponse, PaginatedResponse, SignedUrlResponse, OutputFormat, NormalizedJob } from '../../types.js';

/**
 * Normalize a job object to have consistent field names
 */
function normalizeJob(job: Job): NormalizedJob {
  return {
    id: job.id || job.job_id || '',
    status: job.status,
    file_name: job.file_name || job.filename || null,
    total_pages: job.total_pages,
    pages_completed: job.pages_completed,
    updated_at: job.updated_at || job.created_at || '',
    error: job.error,
  };
}

// Columns for job table display
const JOB_COLUMNS = [
  { key: 'id', header: 'Job ID', width: 38 },
  { key: 'file_name', header: 'File', width: 30 },
  { key: 'status_fmt', header: 'Status', width: 12 },
  { key: 'progress', header: 'Progress', width: 12 },
  { key: 'updated_at_fmt', header: 'Updated', width: 12 },
];

export function createJobsCommand(): Command {
  const jobs = new Command('jobs')
    .description('Manage extraction jobs');

  // jobs list
  jobs
    .command('list')
    .alias('ls')
    .description('List all jobs')
    .option('-o, --output <format>', 'Output format (table, json, csv)', getDefaultFormat())
    .option('-s, --status <status>', 'Filter by status')
    .option('-l, --limit <n>', 'Limit results', '20')
    .option('-p, --page <n>', 'Page number', '1')
    .action(async (options) => {
      const params: Record<string, string> = {
        limit: options.limit,
        page: options.page,
      };

      if (options.status) {
        params.status = options.status;
      }

      const response = await withSpinner(
        'Fetching jobs',
        () => get<PaginatedResponse<Job>>('api/v1/jobs', params)
      );

      if (response.items.length === 0) {
        console.log(chalk.dim('No jobs found'));
        return;
      }

      // Normalize and format for display
      const formatted = response.items.map(job => {
        const normalized = normalizeJob(job);
        return {
          ...normalized,
          status_fmt: formatStatus(normalized.status),
          progress: normalized.total_pages
            ? `${normalized.pages_completed || 0}/${normalized.total_pages}`
            : '-',
          updated_at_fmt: formatDate(normalized.updated_at),
        };
      });

      console.log(formatOutput(formatted, options.output as OutputFormat, JOB_COLUMNS));

      // Show pagination info
      const { pagination } = response;
      if (pagination.totalPages > 1) {
        console.log(chalk.dim(`\nPage ${pagination.page} of ${pagination.totalPages} (${pagination.total} total)`));
      }
    });

  // jobs create
  jobs
    .command('create <source>')
    .description('Create an extraction job from file path, URL, or document UUID')
    .option('-w, --wait', 'Wait for job completion')
    .option('-o, --output <format>', 'Output format (table, json)', getDefaultFormat())
    .option('--webhook <url>', 'Webhook URL for completion notification')
    .action(async (source, options) => {
      let jobRequest: Record<string, unknown>;

      // Determine source type
      if (source.startsWith('http://') || source.startsWith('https://')) {
        // URL source
        jobRequest = { url: source };
      } else if (source.match(/^[0-9a-f-]{36}$/i)) {
        // UUID source (existing document)
        jobRequest = { document_uuid: source };
      } else {
        // File path source
        const filePath = resolve(source);

        if (!existsSync(filePath)) {
          error(`File not found: ${filePath}`);
          process.exit(EXIT_CODES.INVALID_ARGS);
        }

        if (!filePath.toLowerCase().endsWith('.pdf')) {
          error('Only PDF files are supported');
          process.exit(EXIT_CODES.INVALID_ARGS);
        }

        const fileName = basename(filePath);
        const fileSize = statSync(filePath).size;

        // Upload file first via signed URL
        const signedUrlResponse = await withSpinner(
          'Preparing upload',
          () => post<SignedUrlResponse>('api/v1/upload/signed-url', {
            fileName,
            contentType: 'application/pdf',
          })
        );

        await withSpinner(
          `Uploading ${fileName}`,
          () => uploadFile(signedUrlResponse.signedUrl, filePath, 'application/pdf')
        );

        jobRequest = {
          gcs_path: signedUrlResponse.gcsPath,
          file_name: fileName,
        };
      }

      if (options.webhook) {
        jobRequest.webhook_url = options.webhook;
      }

      // Create the job
      const createResponse = await withSpinner(
        'Creating extraction job',
        () => post<CreateJobResponse>('api/v1/extract', jobRequest)
      );

      const jobId = createResponse.job_id;
      info(`Job created: ${jobId}`);

      if (options.wait) {
        // Poll for completion
        const result = await pollWithProgress(
          async () => {
            const job = await get<Job>(`api/v1/jobs/${jobId}`);
            const done = job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled';
            return {
              done,
              progress: job.pages_completed || 0,
              total: job.total_pages || undefined,
              data: job,
            };
          },
          { label: 'Extracting', interval: 2000, timeout: 600000 }
        );

        if (result.status === 'failed') {
          error(`Job failed: ${result.error || 'Unknown error'}`);
          process.exit(EXIT_CODES.JOB_FAILED);
        }

        if (result.status === 'cancelled') {
          error('Job was cancelled');
          process.exit(EXIT_CODES.JOB_FAILED);
        }

        success('Extraction complete');

        // Fetch results
        const results = await get<JobResults>(`api/v1/jobs/${jobId}/results`);

        if (options.output === 'json') {
          console.log(formatOutput(results, 'json'));
        } else {
          console.log(chalk.bold(`\nExtracted ${results.tables.length} tables from ${results.pages.length} pages`));
          console.log(chalk.dim(`Run 'okra jobs results ${jobId}' to see full results`));
        }
      } else {
        // Non-waiting mode
        if (options.output === 'json') {
          console.log(formatOutput(createResponse, 'json'));
        } else {
          console.log(chalk.dim(`Poll status: okra jobs get ${jobId}`));
          console.log(chalk.dim(`Wait for completion: okra jobs wait ${jobId}`));
        }
      }
    });

  // jobs get
  jobs
    .command('get <jobId>')
    .alias('status')
    .description('Get job status and details')
    .option('-o, --output <format>', 'Output format (table, json)', getDefaultFormat())
    .option('-w, --web', 'Open job in browser')
    .action(async (jobId, options) => {
      if (options.web) {
        const url = getJobWebUrl(jobId);
        console.error(`Opening ${url} in your browser.`);
        await openInBrowser(url);
        return;
      }

      try {
        const job = await withSpinner(
          'Fetching job',
          () => get<Job>(`api/v1/jobs/${jobId}`)
        );

        if (options.output === 'json') {
          console.log(formatOutput(job, 'json'));
        } else {
          console.log(chalk.bold('Job Details'));
          console.log(chalk.dim('─'.repeat(50)));
          console.log(chalk.bold('Job ID:'), job.id);
          console.log(chalk.bold('Status:'), formatStatus(job.status));
          console.log(chalk.bold('File:'), job.file_name || '-');
          if (job.total_pages) {
            console.log(chalk.bold('Progress:'), `${job.pages_completed || 0}/${job.total_pages} pages`);
          }
          console.log(chalk.bold('Created:'), job.inserted_at ? new Date(job.inserted_at).toLocaleString() : '-');
          console.log(chalk.bold('Updated:'), new Date(job.updated_at).toLocaleString());
          if (job.error) {
            console.log(chalk.bold('Error:'), chalk.red(job.error));
          }
          if (job.document_uuid) {
            console.log(chalk.bold('Document:'), job.document_uuid);
          }
        }
      } catch (err) {
        if (err instanceof OkraApiError && err.statusCode === 404) {
          error(`Job not found: ${jobId}`);
          process.exit(EXIT_CODES.NOT_FOUND);
        }
        throw err;
      }
    });

  // jobs wait
  jobs
    .command('wait <jobId>')
    .description('Wait for job completion')
    .option('-t, --timeout <seconds>', 'Timeout in seconds', '600')
    .option('-o, --output <format>', 'Output format (table, json)', getDefaultFormat())
    .action(async (jobId, options) => {
      const timeout = parseInt(options.timeout) * 1000;

      const result = await pollWithProgress(
        async () => {
          const job = await get<Job>(`api/v1/jobs/${jobId}`);
          const done = job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled';
          return {
            done,
            progress: job.pages_completed || 0,
            total: job.total_pages || undefined,
            data: job,
          };
        },
        { label: 'Waiting', interval: 2000, timeout }
      );

      if (result.status === 'failed') {
        error(`Job failed: ${result.error || 'Unknown error'}`);
        process.exit(EXIT_CODES.JOB_FAILED);
      }

      if (result.status === 'cancelled') {
        error('Job was cancelled');
        process.exit(EXIT_CODES.JOB_FAILED);
      }

      success('Job completed');

      if (options.output === 'json') {
        console.log(formatOutput(result, 'json'));
      }
    });

  // jobs cancel
  jobs
    .command('cancel <jobId>')
    .description('Cancel a running job')
    .option('-o, --output <format>', 'Output format (table, json)', 'table')
    .action(async (jobId, options) => {
      const useJson = options.output === 'json' || isJsonOutput();
      try {
        await withSpinner(
          'Cancelling job',
          () => del(`api/ocr/jobs/${jobId}`)
        );

        if (useJson) {
          console.log(formatOutput({ success: true, job_id: jobId, message: 'Job cancelled' }, 'json'));
        } else {
          success(`Job cancelled: ${jobId}`);
        }
      } catch (err) {
        if (err instanceof OkraApiError && err.statusCode === 404) {
          if (useJson) {
            console.log(formatOutput({ success: false, job_id: jobId, error: 'Job not found' }, 'json'));
          } else {
            error(`Job not found: ${jobId}`);
          }
          process.exit(EXIT_CODES.NOT_FOUND);
        }
        throw err;
      }
    });

  // jobs results
  jobs
    .command('results <jobId>')
    .description('Get extraction results')
    .option('-o, --output <format>', 'Output format (table, json, markdown)', getDefaultFormat())
    .option('--tables-only', 'Only show tables')
    .option('--text-only', 'Only show extracted text')
    .action(async (jobId, options) => {
      try {
        const apiResponse = await withSpinner(
          'Fetching results',
          () => get<JobResultsApiResponse>(`api/v1/jobs/${jobId}/results`)
        );

        const results: JobResults = {
          job_id: apiResponse.job_id,
          filename: apiResponse.filename,
          total_pages: apiResponse.total_pages,
          tables: apiResponse.results?.tables || [],
          pages: (apiResponse.results?.text || []).map(t => ({
            page_number: t.page,
            text: t.content,
            entities: [],
          })),
        };

        if (options.output === 'json') {
          console.log(formatOutput(results, 'json'));
          return;
        }

        // Tables only
        if (options.tablesOnly) {
          if (results.tables.length === 0) {
            console.log(chalk.dim('No tables extracted'));
            return;
          }

          for (const table of results.tables) {
            console.log(chalk.bold(`\nPage ${table.page_number} - Table`));
            console.log(chalk.dim('─'.repeat(50)));
            console.log(table.content_markdown);
          }
          return;
        }

        // Text only
        if (options.textOnly) {
          for (const page of results.pages) {
            console.log(chalk.bold(`\n--- Page ${page.page_number} ---`));
            console.log(page.text);
          }
          return;
        }

        // Full results summary
        console.log(chalk.bold('\nExtraction Results'));
        console.log(chalk.dim('─'.repeat(50)));
        console.log(chalk.bold('Job ID:'), results.job_id);
        console.log(chalk.bold('File:'), results.filename);
        console.log(chalk.bold('Pages:'), results.pages.length);
        console.log(chalk.bold('Tables:'), results.tables.length);

        if (results.tables.length > 0) {
          console.log(chalk.bold('\nExtracted Tables:'));
          for (const table of results.tables) {
            console.log(chalk.cyan(`\n[Page ${table.page_number}]`));
            console.log(table.content_markdown);
          }
        }
      } catch (err) {
        if (err instanceof OkraApiError && err.statusCode === 404) {
          error(`Job not found: ${jobId}`);
          process.exit(EXIT_CODES.NOT_FOUND);
        }
        throw err;
      }
    });

  // jobs export
  jobs
    .command('export <jobId>')
    .description('Export results to a file')
    .option('-f, --format <format>', 'Export format (docx, xlsx, zip)', 'xlsx')
    .option('-o, --out <path>', 'Output file path')
    .option('--output-format <format>', 'Result output format (table, json)', 'table')
    .action(async (jobId, options) => {
      const format = options.format;
      const validFormats = ['docx', 'xlsx', 'zip'];
      const useJson = options.outputFormat === 'json' || isJsonOutput();

      if (!validFormats.includes(format)) {
        if (useJson) {
          console.log(formatOutput({ success: false, error: `Invalid format. Choose from: ${validFormats.join(', ')}` }, 'json'));
        } else {
          error(`Invalid format. Choose from: ${validFormats.join(', ')}`);
        }
        process.exit(EXIT_CODES.INVALID_ARGS);
      }

      const outputPath = options.out || `${jobId}.${format}`;

      if (format === 'zip') {
        const result = await withSpinner(
          'Generating export',
          () => get<{ url: string }>(`api/ocr/jobs/${jobId}/export/zip`)
        );

        const { downloadFile } = await import('../lib/client.js');
        await withSpinner(
          `Downloading ${outputPath}`,
          () => downloadFile(result.url, outputPath)
        );
      } else {
        const endpoint = format === 'xlsx' ? 'excel' : format;
        const { downloadFromApi } = await import('../lib/client.js');
        await withSpinner(
          `Exporting ${format}`,
          () => downloadFromApi(`api/ocr/jobs/${jobId}/export/${endpoint}`, outputPath)
        );
      }

      if (useJson) {
        console.log(formatOutput({
          success: true,
          job_id: jobId,
          format,
          output_path: outputPath,
        }, 'json'));
      } else {
        success(`Exported to: ${outputPath}`);
      }
    });

  return jobs;
}
