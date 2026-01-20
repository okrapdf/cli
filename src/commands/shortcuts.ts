/**
 * Shortcut commands for common workflows
 *
 * These provide a simpler interface for the most common operations.
 * Designed to be agent-friendly with predictable JSON output.
 */

import { Command } from 'commander';
import { existsSync, statSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { resolve, basename, join } from 'path';
import chalk from 'chalk';
import { get, post, uploadFile, OkraApiError, EXIT_CODES, isAuthenticated, createAnonymousClient } from '../lib/client.js';
import { formatOutput, success, error, info } from '../lib/output.js';
import { withSpinner, pollWithProgress } from '../lib/progress.js';
import { getDefaultFormat, getDefaultOcr, getDefaultVlm } from '../lib/config.js';
import { resolveProcessor, getProcessor } from '../lib/processors.js';
import { loadTemplate } from '../lib/templates.js';
import { logJob, updateJobLog } from '../lib/logs.js';
import { createAgenticWorkspace, WorkspaceManifest } from '../lib/workspace.js';

/**
 * Format manifest with context for piping to AI agent CLIs
 */
function formatForAgent(manifest: WorkspaceManifest, userPrompt?: string): string {
  const task = typeof userPrompt === 'string' && userPrompt.length > 0
    ? userPrompt
    : 'Analyze the extracted PDF content and help me work with it.';

  const entityInfo = manifest.assets.images
    ? `\n- Entity images: ${manifest.assets.images.entities.length} cropped (figures, tables, charts)`
    : '';

  return `Extracted PDF: ${manifest.source.filename} (${manifest.source.pages} pages)
Working directory: ${manifest.working_dir}

Assets:
- Tables: ${manifest.assets.tables.count} as CSV (${manifest.assets.tables.csv_files.join(', ') || 'none'})
- Full text: ${manifest.assets.text.markdown}${entityInfo}

Task: ${task}

${JSON.stringify(manifest, null, 2)}`;
}

/**
 * Output manifest - with agent context if prompt provided
 */
function outputManifest(manifest: WorkspaceManifest, prompt?: string): void {
  if (prompt) {
    console.log(formatForAgent(manifest, prompt));
  } else {
    console.log(JSON.stringify(manifest, null, 2));
  }
}
import type {
  Job,
  JobResults,
  CreateJobResponse,
  SignedUrlResponse,
  ChatResponse,
  OutputFormat,
} from '../types.js';

type WaitStage = 'ocr' | 'entities' | 'index';

interface WorkflowNodeResponse {
  jobId: string;
  nodeId: string;
  latestExecution: {
    nodeId: string;
    executionStatus: 'pending' | 'running' | 'success' | 'error';
    progress?: { current: number; total?: number; unit?: string };
    outputSummary?: string;
    error?: { message: string };
  } | null;
}

interface EntitiesResponse {
  jobId: string;
  extractionStatus: 'not_started' | 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'paused';
  entities: Array<{
    id: string;
    type: string;
    title: string | null;
    page: number;
    bbox?: { x: number; y: number; width: number; height: number };
  }>;
  counts: { tables: number; figures: number; footnotes: number; summaries: number };
  totalPages?: number;
}

interface StageConfig {
  endpoint: (jobId: string) => string;
  isDone: (response: unknown) => boolean;
  isError?: (response: unknown) => boolean;
  getProgress?: (response: unknown) => { current: number; total?: number };
  label: string;
}

const STAGE_CONFIG: Record<WaitStage, StageConfig> = {
  ocr: {
    endpoint: (jobId) => `api/v1/jobs/${jobId}`,
    isDone: (r) => {
      const job = r as Job;
      return ['completed', 'failed', 'cancelled'].includes(job.status);
    },
    isError: (r) => {
      const job = r as Job;
      return ['failed', 'cancelled'].includes(job.status);
    },
    getProgress: (r) => {
      const job = r as Job;
      return { current: job.pages_completed || 0, total: job.total_pages ?? undefined };
    },
    label: 'OCR extraction',
  },
  entities: {
    endpoint: (jobId) => `api/ocr/jobs/${jobId}/entities`,
    isDone: (r) => {
      const resp = r as EntitiesResponse;
      return resp.extractionStatus === 'completed';
    },
    isError: (r) => {
      const resp = r as EntitiesResponse;
      return resp.extractionStatus === 'failed' || resp.extractionStatus === 'cancelled';
    },
    getProgress: (r) => {
      const resp = r as EntitiesResponse;
      return { current: resp.entities.length, total: resp.totalPages };
    },
    label: 'Entity extraction',
  },
  index: {
    endpoint: (jobId) => `api/ocr/jobs/${jobId}/workflow-node/metadata-index`,
    isDone: (r) => {
      const resp = r as WorkflowNodeResponse;
      return resp.latestExecution?.executionStatus === 'success';
    },
    isError: (r) => {
      const resp = r as WorkflowNodeResponse;
      return resp.latestExecution?.executionStatus === 'error';
    },
    label: 'Search indexing',
  },
};

/**
 * Create the 'extract' shortcut command
 * okra extract <file> - Upload, create job, wait, return results
 *
 * Agent-friendly: Use -o json --quiet for clean JSON output
 */
export function createExtractCommand(): Command {
  return new Command('extract')
    .description('Extract tables and text from a PDF (upload + process + wait)')
    .argument('<source>', 'PDF file path, URL, or document UUID')
    .option('-o, --output <format>', 'Output format (table, json, markdown)', getDefaultFormat())
    .option('-d, --output-dir <path>', 'Write agentic workspace to directory (outputs JSON manifest)')
    .option('--images', 'Include page images and figure crops in workspace (requires -d)')
    .option('--scale <n>', 'Image scale factor for rendering (1-4)', '2')
    .option('--processor <name>', 'Use specific processor (docai, gemini, qwen, llamaparse)')
    .option('-t, --template <name>', 'Use extraction template (invoice, receipt, financial-statement)')
    .option('--ocr <engine>', 'OCR engine (docai, tesseract, textract, azure-read)')
    .option('--vlm <model>', 'VLM model (e.g., google/gemini-2.5-flash-preview-09-2025)')
    .option('--tables-only', 'Only return extracted tables')
    .option('--text-only', 'Only return extracted text')
    .option('--timeout <seconds>', 'Job timeout in seconds (default: 600)', '600')
    .option('--wait-for <stage>', 'Wait for pipeline stage: ocr (default), entities, index')
    .option('-q, --quiet', 'Minimal output (just the results) - ideal for piping')
    .option('-p, --prompt <task>', 'Add task context for piping to agent CLIs (claude, aider, etc)')
    .action(async (source, options) => {
      let documentUuid: string;
      let fileName: string;
      let pdfBuffer: Buffer | undefined;

      const waitStage: WaitStage = options.waitFor
        ? (options.waitFor as WaitStage)
        : options.images
          ? 'entities'
          : 'ocr';

      if (waitStage !== 'ocr' && !options.quiet) {
        info(`Will wait for: ${STAGE_CONFIG[waitStage].label}`);
      }

      const ocrEngine = options.ocr || getDefaultOcr();
      const vlmModel = options.vlm || getDefaultVlm();

      if (!options.quiet) {
        if (ocrEngine) info(`OCR engine: ${ocrEngine}`);
        if (vlmModel) info(`VLM model: ${vlmModel}`);
      }

      // Resolve processor if specified (legacy flag, will be deprecated)
      let processorId: string | undefined;
      if (options.processor) {
        processorId = resolveProcessor(options.processor);
        const proc = getProcessor(processorId);
        if (!proc) {
          error(`Unknown processor: ${options.processor}`);
          console.log(chalk.dim('Run `okra processors list` to see available processors'));
          process.exit(EXIT_CODES.INVALID_ARGS);
        }
        if (!options.quiet) info(`Using processor: ${proc.name}`);
      }

      // Load template if specified
      let template: ReturnType<typeof loadTemplate>;
      if (options.template) {
        template = loadTemplate(options.template);
        if (!template) {
          error(`Unknown template: ${options.template}`);
          console.log(chalk.dim('Run `okra templates list` to see available templates'));
          process.exit(EXIT_CODES.INVALID_ARGS);
        }
        if (!options.quiet) info(`Using template: ${template.name}`);
        // Use template's preferred processor if not explicitly specified
        if (!processorId && template.processor) {
          processorId = template.processor;
        }
      }

      // Step 1: Handle source (file upload, URL, or existing UUID)
      if (source.match(/^[0-9a-f-]{36}$/i)) {
        // UUID - use existing document directly (skip upload)
        documentUuid = source;
        fileName = 'document.pdf';
        if (!options.quiet) info(`Using existing document: ${source}`);

        const jobPayload: Record<string, unknown> = { document_uuid: documentUuid };
        if (processorId) jobPayload.processor = processorId;
        if (ocrEngine) jobPayload.ocr_engine = ocrEngine;
        if (vlmModel) jobPayload.vlm_model = vlmModel;

        const createResponse = await withSpinner(
          'Creating extraction job',
          () => post<CreateJobResponse>('api/v1/extract', jobPayload)
        );

        const logEntry = logJob({
          job_id: createResponse.job_id,
          document_uuid: documentUuid,
          file_name: fileName,
          processor: processorId || 'default',
          template: options.template,
          status: 'running',
          started_at: new Date().toISOString(),
        });

        const startTime = Date.now();
        const timeoutMs = parseInt(options.timeout, 10) * 1000;
        const job = await waitForJob(createResponse.job_id, options.quiet, timeoutMs);

        updateJobLog(logEntry.id, {
          status: job.status,
          pages: job.total_pages || undefined,
          completed_at: new Date().toISOString(),
          duration_ms: Date.now() - startTime,
          error: job.error || undefined,
        });

        if (job.status === 'failed') {
          error(`Extraction failed: ${job.error || 'Unknown error'}`);
          process.exit(EXIT_CODES.JOB_FAILED);
        }

        if (waitStage !== 'ocr') {
          const nodeResult = await waitForStage<WorkflowNodeResponse>(
            createResponse.job_id,
            waitStage,
            options.quiet,
            timeoutMs
          );
          if (nodeResult.latestExecution?.executionStatus === 'error') {
            error(`${STAGE_CONFIG[waitStage].label} failed`);
            process.exit(EXIT_CODES.JOB_FAILED);
          }
        }

        const results = await getResults(createResponse.job_id);

        if (options.outputDir) {
          if (options.images) {
            const docInfo = await get<{ signed_url: string }>(`api/documents/${documentUuid}/download`);
            const got = (await import('got')).default;
            const pdfResponse = await got(docInfo.signed_url, { responseType: 'buffer' });
            pdfBuffer = pdfResponse.body;
          }

          if (!options.quiet) info('Creating agentic workspace...');
          const manifest = await createAgenticWorkspace(options.outputDir, results, {
            includeImages: options.images,
            scale: parseInt(options.scale, 10),
            pdfBuffer,
          });
          outputManifest(manifest, options.prompt);
        } else {
          outputResults(results, options, fileName, createResponse.job_id);
        }
        return;
      }

      if (source.startsWith('http://') || source.startsWith('https://')) {
        // URL source
        if (!options.quiet) info(`Processing URL: ${source}`);
        fileName = source.split('/').pop() || 'document.pdf';

        // Check if authenticated - if not, use anonymous endpoint
        if (!isAuthenticated()) {
          if (!options.quiet) {
            info('No authentication found - using anonymous mode (3 extracts/day)');
            info('Run `okra auth login` for unlimited access');
          }

          // Use anonymous public endpoint
          const results = await extractAnonymous(source, options.quiet);

          // Use agentic workspace if -d is specified
          if (options.outputDir) {
            if (options.images) {
              const got = (await import('got')).default;
              const pdfResponse = await got(source, { responseType: 'buffer' });
              pdfBuffer = pdfResponse.body;
            }

            if (!options.quiet) info('Creating agentic workspace...');
            const manifest = await createAgenticWorkspace(options.outputDir, results, {
              includeImages: options.images,
              scale: parseInt(options.scale, 10),
              pdfBuffer,
            });
            outputManifest(manifest, options.prompt);
          } else {
            outputResults(results, options, fileName, results.job_id);
          }
          return;
        }

        // Authenticated flow - create job directly
        const jobPayload: Record<string, unknown> = { url: source };
        if (processorId) jobPayload.processor = processorId;
        if (ocrEngine) jobPayload.ocr_engine = ocrEngine;
        if (vlmModel) jobPayload.vlm_model = vlmModel;

        const createResponse = await withSpinner(
          'Creating extraction job',
          () => post<CreateJobResponse>('api/v1/extract', jobPayload)
        );

        documentUuid = '';

        const logEntry = logJob({
          job_id: createResponse.job_id,
          file_name: fileName,
          processor: processorId || 'default',
          template: options.template,
          status: 'running',
          started_at: new Date().toISOString(),
        });

        // Wait for job
        const startTime = Date.now();
        const timeoutMs = parseInt(options.timeout, 10) * 1000;
        const job = await waitForJob(createResponse.job_id, options.quiet, timeoutMs);

        updateJobLog(logEntry.id, {
          status: job.status,
          pages: job.total_pages || undefined,
          completed_at: new Date().toISOString(),
          duration_ms: Date.now() - startTime,
          error: job.error || undefined,
        });

        if (job.status === 'failed') {
          error(`Extraction failed: ${job.error || 'Unknown error'}`);
          process.exit(EXIT_CODES.JOB_FAILED);
        }

        if (waitStage !== 'ocr') {
          const nodeResult = await waitForStage<WorkflowNodeResponse>(
            createResponse.job_id,
            waitStage,
            options.quiet,
            timeoutMs
          );
          if (nodeResult.latestExecution?.executionStatus === 'error') {
            error(`${STAGE_CONFIG[waitStage].label} failed`);
            process.exit(EXIT_CODES.JOB_FAILED);
          }
        }

        const results = await getResults(createResponse.job_id);

        if (options.outputDir) {
          if (options.images) {
            const got = (await import('got')).default;
            const pdfResponse = await got(source, { responseType: 'buffer' });
            pdfBuffer = pdfResponse.body;
          }

          if (!options.quiet) info('Creating agentic workspace...');
          const manifest = await createAgenticWorkspace(options.outputDir, results, {
            includeImages: options.images,
            scale: parseInt(options.scale, 10),
            pdfBuffer,
          });
          outputManifest(manifest, options.prompt);
        } else {
          outputResults(results, options, fileName, createResponse.job_id);
        }
        return;
      }

      // File source
      const filePath = resolve(source);

      if (!existsSync(filePath)) {
        error(`File not found: ${filePath}`);
        process.exit(EXIT_CODES.INVALID_ARGS);
      }

      if (!filePath.toLowerCase().endsWith('.pdf')) {
        error('Only PDF files are supported');
        process.exit(EXIT_CODES.INVALID_ARGS);
      }

      // File uploads require authentication
      if (!isAuthenticated()) {
        error('File uploads require authentication.');
        info('Run `okra auth login` to authenticate, or use a URL instead:');
        info('  npx @okrapdf/cli extract https://example.com/document.pdf');
        process.exit(EXIT_CODES.AUTH_ERROR);
      }

      fileName = basename(filePath);
      const fileSize = statSync(filePath).size;

      // Read PDF buffer if we need images for workspace
      if (options.outputDir && options.images) {
        pdfBuffer = readFileSync(filePath);
      }

      if (!options.quiet) info(`Processing: ${fileName}`);

      // Upload to GCS via signed URL (bypasses body size limits)
      const signedUrlResponse = await withSpinner(
        'Preparing upload',
        () => post<SignedUrlResponse>('api/v1/upload/signed-url', {
          fileName,
          contentType: 'application/pdf',
        })
      );

      await withSpinner(
        'Uploading to storage',
        () => uploadFile(signedUrlResponse.signedUrl, filePath, 'application/pdf')
      );

      const jobPayload: Record<string, unknown> = {
        gcs_path: signedUrlResponse.gcsPath,
        filename: fileName,
      };
      if (processorId) jobPayload.processor = processorId;
      if (ocrEngine) jobPayload.ocr_engine = ocrEngine;
      if (vlmModel) jobPayload.vlm_model = vlmModel;

      const createResponse = await withSpinner(
        'Creating extraction job',
        () => post<CreateJobResponse>('api/v1/extract', jobPayload)
      );

      documentUuid = '';

      // Log the job locally
      const logEntry = logJob({
        job_id: createResponse.job_id,
        document_uuid: documentUuid,
        file_name: fileName,
        processor: processorId || 'default',
        template: options.template,
        status: 'running',
        started_at: new Date().toISOString(),
      });

      // Step 4: Wait for completion
      const startTime = Date.now();
      const timeoutMs = parseInt(options.timeout, 10) * 1000;
      const job = await waitForJob(createResponse.job_id, options.quiet, timeoutMs);

      // Update local log
      updateJobLog(logEntry.id, {
        status: job.status,
        pages: job.total_pages || undefined,
        completed_at: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
        error: job.error || undefined,
      });

      if (job.status === 'failed') {
        error(`Extraction failed: ${job.error || 'Unknown error'}`);
        process.exit(EXIT_CODES.JOB_FAILED);
      }

        if (waitStage !== 'ocr') {
          const nodeResult = await waitForStage<WorkflowNodeResponse>(
            createResponse.job_id,
            waitStage,
            options.quiet,
            timeoutMs
          );
          if (nodeResult.latestExecution?.executionStatus === 'error') {
            error(`${STAGE_CONFIG[waitStage].label} failed`);
            process.exit(EXIT_CODES.JOB_FAILED);
          }
        }

      const results = await getResults(createResponse.job_id);

      if (options.outputDir) {
        if (!options.quiet) info('Creating agentic workspace...');

        const manifest = await createAgenticWorkspace(
          options.outputDir,
          results,
          {
            includeImages: options.images,
            scale: parseInt(options.scale, 10),
            pdfBuffer,
          }
        );

        // Output JSON manifest to stdout (for piping to agents)
        outputManifest(manifest, options.prompt);
      } else {
        outputResults(results, options, fileName, createResponse.job_id);
      }
    });
}

/**
 * Create the 'run' shortcut command
 * okra run <file> "<query>" - Upload, chat, return result
 */
export function createRunCommand(): Command {
  return new Command('run')
    .description('Ask a question about a PDF (upload + chat)')
    .argument('<source>', 'PDF file path, URL, or document UUID')
    .argument('<query>', 'Question to ask about the document')
    .option('-o, --output <format>', 'Output format (text, json)', 'text')
    .option('-q, --quiet', 'Minimal output (just the answer)')
    .action(async (source, query, options) => {
      let documentUuid: string;

      // Handle different source types
      if (source.match(/^[0-9a-f-]{36}$/i)) {
        // UUID - use directly
        documentUuid = source;
      } else if (source.startsWith('http://') || source.startsWith('https://')) {
        // URL - need to upload first
        error('URL sources not yet supported for chat. Upload the file first.');
        process.exit(EXIT_CODES.INVALID_ARGS);
      } else {
        // File - upload first
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

        if (!options.quiet) info(`Uploading: ${fileName}`);

        // Upload file via signed URL
        const signedUrlResponse = await withSpinner(
          'Uploading',
          async () => {
            const response = await post<SignedUrlResponse>('api/v1/upload/signed-url', {
              fileName,
              contentType: 'application/pdf',
            });

            await uploadFile(response.signedUrl, filePath, 'application/pdf');
            return response;
          }
        );

        // Use gcsPath as document identifier for chat
        documentUuid = signedUrlResponse.gcsPath;
      }

      // Send chat message
      if (!options.quiet) info(`Asking: ${query}`);

      const response = await withSpinner(
        'Thinking',
        () => post<ChatResponse>('api/v1/messages', {
          document_uuid: documentUuid,
          message: query,
        })
      );

      // Output result
      if (options.output === 'json') {
        console.log(formatOutput(response, 'json'));
      } else if (options.quiet) {
        console.log(response.message.content);
      } else {
        console.log();
        console.log(chalk.green('Answer:'));
        console.log(response.message.content);

        if (response.output_files && response.output_files.length > 0) {
          console.log();
          console.log(chalk.dim('Generated files:'));
          for (const file of response.output_files) {
            console.log(chalk.dim(`  - ${file.filename}`));
          }
        }
      }
    });
}

/**
 * Extract using anonymous public endpoint (rate limited 3/day per IP)
 */
async function extractAnonymous(url: string, quiet: boolean): Promise<JobResults> {
  const client = createAnonymousClient();

  const spinner = quiet ? null : (await import('ora')).default('Extracting (anonymous)...').start();

  try {
    const response = await client.post('api/public/cli/extract', {
      json: { url },
      responseType: 'json',
    });

    const data = response.body as any;

    if (data.error) {
      throw new OkraApiError('extraction_failed', data.error, response.statusCode);
    }

    spinner?.succeed('Extraction complete');

    // Show remaining extracts
    if (!quiet && data.remaining_extracts !== undefined) {
      info(`Remaining anonymous extracts today: ${data.remaining_extracts}`);
    }

    return {
      job_id: data.job_id,
      filename: data.filename,
      total_pages: data.total_pages,
      tables: data.tables || [],
      pages: data.pages || [],
    };
  } catch (err: any) {
    spinner?.fail('Extraction failed');

    // Handle rate limit specifically
    if (err.response?.statusCode === 429) {
      const body = err.response.body as any;
      error('Rate limit exceeded. Anonymous users can process 3 documents per day.');
      if (body?.resetAt) {
        info(`Limit resets at: ${body.resetAt}`);
      }
      info('Run `okra auth login` for unlimited access.');
      process.exit(EXIT_CODES.RATE_LIMITED);
    }

    throw err;
  }
}

async function waitForJob(jobId: string, quiet: boolean, timeoutMs: number = 600000): Promise<Job> {
  return pollWithProgress(
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
    {
      label: quiet ? '' : 'Extracting',
      interval: 2000,
      timeout: timeoutMs,
    }
  );
}

async function waitForStage<T>(
  jobId: string,
  stage: WaitStage,
  quiet: boolean,
  timeoutMs: number = 300000
): Promise<T> {
  const config = STAGE_CONFIG[stage];

  return pollWithProgress(
    async () => {
      const response = await get<T>(config.endpoint(jobId));
      if (config.isError?.(response)) {
        return {
          done: true,
          progress: 0,
          data: response,
        };
      }
      const done = config.isDone(response);
      const progress = config.getProgress?.(response) ?? { current: 0 };
      return {
        done,
        progress: progress.current,
        total: progress.total,
        data: response,
      };
    },
    {
      label: quiet ? '' : config.label,
      interval: 2000,
      timeout: timeoutMs,
    }
  );
}

async function getResults(jobId: string): Promise<JobResults> {
  const results = await get<JobResults>(`api/v1/jobs/${jobId}/results`);
  try {
    const entities = await get<EntitiesResponse>(`api/ocr/jobs/${jobId}/entities`, { type: 'all' });
    return { ...results, entities: entities.entities } as JobResults;
  } catch {
    return results;
  }
}

/**
 * Get file extension for output format
 */
function getExtension(format: string): string {
  switch (format) {
    case 'json': return 'json';
    case 'markdown': return 'md';
    case 'csv': return 'csv';
    default: return 'txt';
  }
}

/**
 * Output results based on options
 */
function outputResults(
  results: JobResults,
  options: { output?: string; outputDir?: string; tablesOnly?: boolean; textOnly?: boolean; quiet?: boolean },
  fileName?: string,
  jobId?: string
): void {
  // Determine output content based on format
  let content: string;
  const format = options.output || 'table';

  const tables = results.tables || [];
  const pages = results.pages || [];

  if (format === 'json') {
    content = formatOutput(results, 'json');
  } else if (options.tablesOnly) {
    if (tables.length === 0) {
      content = 'No tables extracted';
    } else {
      content = tables.map(t => t.content_markdown).join('\n\n');
    }
  } else if (options.textOnly) {
    content = pages.map(p => p.text).join('\n\n');
  } else if (format === 'markdown') {
    const parts: string[] = [];
    parts.push(`# Extraction Results\n`);
    parts.push(`- Pages: ${pages.length}`);
    parts.push(`- Tables: ${tables.length}\n`);
    if (tables.length > 0) {
      parts.push('## Tables\n');
      for (const table of tables) {
        parts.push(`### Page ${table.page_number}\n`);
        parts.push(table.content_markdown);
        parts.push('');
      }
    }
    content = parts.join('\n');
  } else {
    const parts: string[] = [];
    parts.push('Extraction Complete');
    parts.push('─'.repeat(50));
    if (jobId) parts.push(`Job ID: ${jobId}`);
    if (tables.length > 0) {
      parts.push('\nExtracted Tables:');
      for (const table of tables) {
        parts.push(`\n[Page ${table.page_number}]`);
        parts.push(table.content_markdown);
      }
    }
    content = parts.join('\n');
  }

  // Write to file or stdout
  if (options.outputDir) {
    // Ensure directory exists
    const outDir = resolve(options.outputDir);
    mkdirSync(outDir, { recursive: true });

    // Determine output filename
    const baseName = fileName ? fileName.replace(/\.pdf$/i, '') : 'results';
    const ext = getExtension(format);
    const outPath = join(outDir, `${baseName}.${ext}`);

    writeFileSync(outPath, content, 'utf-8');
    if (!options.quiet) {
      success(`Results written to ${outPath}`);
    }
  } else {
    // Stdout output with formatting for human-readable formats
    if (format === 'json' || options.tablesOnly || options.textOnly) {
      console.log(content);
    } else {
      if (!options.quiet) {
        console.log();
        console.log(chalk.bold('Extraction Complete'));
        console.log(chalk.dim('─'.repeat(50)));
        if (jobId) console.log(`Job ID: ${jobId}`);
      }

      if (tables.length > 0) {
        if (!options.quiet) console.log(chalk.bold('\nExtracted Tables:'));

        for (const table of tables) {
          console.log(chalk.cyan(`\n[Page ${table.page_number}]`));
          console.log(table.content_markdown);
        }
      }
    }
  }
}
