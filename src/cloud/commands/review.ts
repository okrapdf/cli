import { Command } from 'commander';
import chalk from 'chalk';
import { get, post, patch, OkraApiError, EXIT_CODES } from '../lib/client.js';
import { formatOutput, formatDate, success, error, info } from '../../lib/output.js';
import { withSpinner } from '../../lib/progress.js';
import { getDefaultFormat, isJsonOutput } from '../../lib/config.js';
import { openInBrowser, getJobWebUrl } from '../lib/browser.js';
import type { OutputFormat } from '../../types.js';
import { readFileSync, existsSync } from 'fs';

interface VerificationTree {
  jobId: string;
  documentId: string;
  totalPages: number;
  summary: {
    complete: number;
    partial: number;
    flagged: number;
    pending: number;
    empty: number;
    gap: number;
    resolved: number;
    stale: number;
  };
  pages: Array<{
    page: number;
    status: string;
    total: number;
    verified: number;
    pending: number;
    flagged: number;
    rejected: number;
    avgConfidence: number;
    hasOcr: boolean;
    ocrLineCount: number;
    hasCoverageGaps: boolean;
    uncoveredCount: number;
    resolution: string | null;
    classification: string | null;
    isStale: boolean;
  }>;
}

interface PageContent {
  jobId: string;
  pageNum: number;
  content: string;
  version: number;
  blocks?: Array<{
    text: string;
    bbox?: { x: number; y: number; width: number; height: number };
    confidence?: number;
  }>;
  dimension?: { width: number; height: number };
}

interface PageListItem {
  page: number;
  hasContent: boolean;
  version: number;
  updatedAt: string;
}

interface HistoryEntry {
  id: string;
  action: string;
  pageNumber: number | null;
  entityId: string | null;
  entityType: string | null;
  previousState: unknown;
  newState: unknown;
  triggeredBy: string;
  createdAt: string;
}

const PAGE_COLUMNS = [
  { key: 'page', header: 'Page', width: 6 },
  { key: 'status', header: 'Status', width: 12 },
  { key: 'resolution', header: 'Resolution', width: 12 },
  { key: 'ocrLineCount', header: 'OCR Lines', width: 10 },
  { key: 'hasOcr', header: 'Has OCR', width: 8 },
];

function formatStatus(status: string): string {
  switch (status) {
    case 'complete': return chalk.green(status);
    case 'partial': return chalk.yellow(status);
    case 'flagged': return chalk.red(status);
    case 'pending': return chalk.yellow(status);
    case 'gap': return chalk.magenta(status);
    case 'empty': return chalk.dim(status);
    default: return status;
  }
}

export function createReviewCommand(): Command {
  const review = new Command('review')
    .description('Review job verification status and page content');

  review
    .command('status <jobId>')
    .description('Get verification status summary for a job')
    .option('-o, --output <format>', 'Output format (table, json)', getDefaultFormat())
    .option('-w, --web', 'Open job review page in browser')
    .action(async (jobId, options) => {
      if (options.web) {
        const url = `${getJobWebUrl(jobId)}/review`;
        console.error(`Opening ${url} in your browser.`);
        await openInBrowser(url);
        return;
      }

      const tree = await withSpinner(
        'Fetching verification status',
        () => get<VerificationTree>(`api/ocr/jobs/${jobId}/verification-tree`)
      );

      if (options.output === 'json') {
        console.log(formatOutput(tree, 'json'));
        return;
      }

      console.log(chalk.bold('Verification Status'));
      console.log(chalk.dim('─'.repeat(50)));
      console.log(chalk.bold('Job:'), jobId);
      console.log(chalk.bold('Total Pages:'), tree.totalPages);
      console.log();
      console.log(chalk.bold('Summary:'));
      console.log(`  ${chalk.green('Complete:')} ${tree.summary.complete}`);
      console.log(`  ${chalk.yellow('Pending:')} ${tree.summary.pending}`);
      console.log(`  ${chalk.red('Flagged:')} ${tree.summary.flagged}`);
      console.log(`  ${chalk.magenta('Gap:')} ${tree.summary.gap}`);
      console.log(`  ${chalk.blue('Resolved:')} ${tree.summary.resolved}`);
      if (tree.summary.stale > 0) {
        console.log(`  ${chalk.dim('Stale:')} ${tree.summary.stale}`);
      }
    });

  review
    .command('pages <jobId>')
    .description('List pages with verification status')
    .option('-o, --output <format>', 'Output format (table, json)', getDefaultFormat())
    .option('-s, --status <status>', 'Filter by status (complete, pending, flagged, gap)')
    .action(async (jobId, options) => {
      const tree = await withSpinner(
        'Fetching pages',
        () => get<VerificationTree>(`api/ocr/jobs/${jobId}/verification-tree`)
      );

      let pages = tree.pages;
      if (options.status) {
        pages = pages.filter(p => p.status === options.status);
      }

      if (pages.length === 0) {
        console.log(chalk.dim('No pages found'));
        return;
      }

      if (options.output === 'json') {
        console.log(formatOutput(pages, 'json'));
        return;
      }

      const formatted = pages.map(p => ({
        ...p,
        status: formatStatus(p.status),
        resolution: p.resolution || chalk.dim('-'),
        hasOcr: p.hasOcr ? chalk.green('✓') : chalk.dim('✗'),
      }));

      console.log(formatOutput(formatted, 'table', PAGE_COLUMNS));
      console.log(chalk.dim(`\n${pages.length} pages`));
    });

  review
    .command('page <jobId> <pageNum>')
    .description('Get page content (markdown and OCR blocks)')
    .option('-o, --output <format>', 'Output format (markdown, json)', 'markdown')
    .option('--ocr', 'Show OCR blocks instead of markdown')
    .option('--raw', 'Output raw content without formatting')
    .action(async (jobId, pageNum, options) => {
      const page = await withSpinner(
        'Fetching page content',
        () => get<PageContent>(`api/ocr/jobs/${jobId}/pages/${pageNum}`)
      );

      if (options.output === 'json') {
        console.log(formatOutput(page, 'json'));
        return;
      }

      if (options.ocr) {
        if (!page.blocks || page.blocks.length === 0) {
          console.log(chalk.dim('No OCR blocks available'));
          return;
        }

        if (options.raw) {
          for (const block of page.blocks) {
            console.log(block.text);
          }
          return;
        }

        console.log(chalk.bold(`OCR Blocks - Page ${pageNum}`));
        console.log(chalk.dim('─'.repeat(50)));
        for (let i = 0; i < page.blocks.length; i++) {
          const block = page.blocks[i];
          const conf = block.confidence !== undefined ? ` (${(block.confidence * 100).toFixed(0)}%)` : '';
          console.log(chalk.cyan(`[${i + 1}]${conf}`), block.text);
        }
        console.log(chalk.dim(`\n${page.blocks.length} blocks`));
        return;
      }

      if (options.raw) {
        console.log(page.content);
        return;
      }

      console.log(chalk.bold(`Page ${pageNum} Content`));
      console.log(chalk.dim('─'.repeat(50)));
      console.log(page.content);
      console.log();
      console.log(chalk.dim(`Version: ${page.version}`));
      if (page.dimension) {
        console.log(chalk.dim(`Dimension: ${page.dimension.width}x${page.dimension.height}`));
      }
      if (page.blocks) {
        console.log(chalk.dim(`OCR Blocks: ${page.blocks.length}`));
      }
    });

  review
    .command('resolve <jobId> <pageNum>')
    .description('Mark a page as reviewed')
    .option('-r, --resolution <type>', 'Resolution type (reviewed, skipped, flagged)', 'reviewed')
    .option('-n, --note <text>', 'Add a note to the resolution')
    .option('-o, --output <format>', 'Output format (table, json)', 'table')
    .action(async (jobId, pageNum, options) => {
      const useJson = options.output === 'json' || isJsonOutput();
      try {
        await withSpinner(
          `Resolving page ${pageNum}`,
          () => post(`api/ocr/jobs/${jobId}/pages/${pageNum}/resolve`, {
            resolution: options.resolution,
            note: options.note,
          })
        );
        if (useJson) {
          console.log(formatOutput({
            success: true,
            job_id: jobId,
            page: parseInt(pageNum),
            resolution: options.resolution,
          }, 'json'));
        } else {
          success(`Page ${pageNum} marked as ${options.resolution}`);
        }
      } catch (err) {
        if (err instanceof OkraApiError) {
          if (useJson) {
            console.log(formatOutput({ success: false, error: err.message }, 'json'));
          } else {
            error(err.message);
          }
          process.exit(err.exitCode);
        }
        throw err;
      }
    });

  review
    .command('history <jobId>')
    .description('Get verification audit trail')
    .option('-o, --output <format>', 'Output format (table, json)', getDefaultFormat())
    .option('-l, --limit <n>', 'Limit results', '20')
    .option('-p, --page <n>', 'Filter by page number')
    .action(async (jobId, options) => {
      const params: Record<string, string> = { limit: options.limit };
      if (options.page) params.page = options.page;

      const response = await withSpinner(
        'Fetching history',
        () => get<{ history: HistoryEntry[] }>(`api/ocr/jobs/${jobId}/history`, params)
      );

      if (response.history.length === 0) {
        console.log(chalk.dim('No history found'));
        return;
      }

      if (options.output === 'json') {
        console.log(formatOutput(response.history, 'json'));
        return;
      }

      console.log(chalk.bold('Verification History'));
      console.log(chalk.dim('─'.repeat(60)));
      for (const entry of response.history) {
        const page = entry.pageNumber ? `Page ${entry.pageNumber}` : '';
        const entity = entry.entityType ? `${entry.entityType}` : '';
        const target = [page, entity].filter(Boolean).join(' - ') || 'Job';
        console.log(
          chalk.dim(formatDate(entry.createdAt)),
          chalk.cyan(entry.action),
          chalk.white(target),
          chalk.dim(`by ${entry.triggeredBy}`)
        );
      }
    });

  review
    .command('entities <jobId>')
    .description('List extracted entities (tables, figures, footnotes)')
    .option('-o, --output <format>', 'Output format (table, json)', getDefaultFormat())
    .option('-t, --type <type>', 'Filter by type (tables, figures, footnotes, all)', 'all')
    .option('-p, --page <n>', 'Filter by page number')
    .action(async (jobId, options) => {
      try {
        const params: Record<string, string> = { type: options.type };
        if (options.page) params.page = options.page;

        const response = await withSpinner(
          'Fetching entities',
          () => get<{ entities: Array<{ id: string; type: string; page: number; title?: string; bbox?: object }>, counts: { tables: number; figures: number; footnotes: number } }>(`api/ocr/jobs/${jobId}/entities`, params)
        );

        if (options.output === 'json') {
          console.log(formatOutput(response, 'json'));
          return;
        }

        console.log(chalk.bold('Entities'));
        console.log(chalk.dim('─'.repeat(50)));
        console.log(`Tables: ${response.counts.tables}`);
        console.log(`Figures: ${response.counts.figures}`);
        console.log(`Footnotes: ${response.counts.footnotes}`);

        if (response.entities.length > 0) {
          console.log();
          for (const e of response.entities) {
            const title = e.title ? ` - ${e.title.slice(0, 40)}${e.title.length > 40 ? '...' : ''}` : '';
            console.log(`  Page ${e.page}: ${chalk.cyan(e.type)}${title}`);
          }
        }
      } catch (err) {
        if (err instanceof OkraApiError) {
          error(err.message);
          process.exit(err.exitCode);
        }
        throw err;
      }
    });

  review
    .command('tables <jobId>')
    .description('List extracted tables with verification status')
    .option('-o, --output <format>', 'Output format (table, json)', getDefaultFormat())
    .option('-p, --page <n>', 'Filter by page number')
    .action(async (jobId, options) => {
      const params: Record<string, string> = { type: 'tables' };
      if (options.page) params.page = options.page;

      const response = await withSpinner(
        'Fetching tables',
        () => get<{
          entities: Array<{ id: string; type: string; title: string | null; page: number; schema?: string[]; isComplete?: boolean }>;
          counts: { tables: number };
        }>(`api/ocr/jobs/${jobId}/entities`, params)
      );

      const tables = response.entities.filter(e => e.type === 'table');

      if (tables.length === 0) {
        console.log(chalk.dim('No tables found'));
        return;
      }

      if (options.output === 'json') {
        console.log(formatOutput(tables, 'json'));
        return;
      }

      const COLS = [
        { key: 'id_short', header: 'ID', width: 14 },
        { key: 'page', header: 'Page', width: 6 },
        { key: 'complete', header: 'Complete', width: 10 },
        { key: 'preview', header: 'Title', width: 40 },
      ];

      const formatted = tables.map(t => ({
        ...t,
        id_short: t.id,
        complete: t.isComplete ? chalk.green('✓') : chalk.yellow('partial'),
        preview: (t.title || '(untitled)').slice(0, 40) + ((t.title?.length || 0) > 40 ? '...' : ''),
      }));

      console.log(formatOutput(formatted, 'table', COLS));
      console.log(chalk.dim(`\n${tables.length} tables`));
    });

  review
    .command('open <jobId>')
    .description('Open job review page in browser')
    .action(async (jobId) => {
      const url = `${getJobWebUrl(jobId)}/review`;
      console.error(`Opening ${url} in your browser.`);
      await openInBrowser(url);
    });

  review
    .command('save <jobId> <pageNum>')
    .description('Save/update page markdown content')
    .option('-f, --file <path>', 'Read content from file')
    .option('-c, --content <text>', 'Content to save (use - for stdin)')
    .option('-o, --output <format>', 'Output format (table, json)', 'table')
    .action(async (jobId, pageNum, options) => {
      const useJson = options.output === 'json' || isJsonOutput();
      let content: string;

      if (options.file) {
        if (!existsSync(options.file)) {
          if (useJson) {
            console.log(formatOutput({ success: false, error: `File not found: ${options.file}` }, 'json'));
          } else {
            error(`File not found: ${options.file}`);
          }
          process.exit(EXIT_CODES.INVALID_ARGS);
        }
        content = readFileSync(options.file, 'utf-8');
      } else if (options.content) {
        if (options.content === '-') {
          const chunks: Buffer[] = [];
          for await (const chunk of process.stdin) {
            chunks.push(chunk);
          }
          content = Buffer.concat(chunks).toString('utf-8');
        } else {
          content = options.content;
        }
      } else {
        if (useJson) {
          console.log(formatOutput({ success: false, error: 'Either --file or --content is required' }, 'json'));
        } else {
          error('Either --file or --content is required');
        }
        process.exit(EXIT_CODES.INVALID_ARGS);
      }

      try {
        const result = await withSpinner(
          `Saving page ${pageNum}`,
          () => patch<{ version: number }>(`api/ocr/jobs/${jobId}/pages/${pageNum}`, { content })
        );
        if (useJson) {
          console.log(formatOutput({
            success: true,
            job_id: jobId,
            page: parseInt(pageNum),
            version: result.version,
          }, 'json'));
        } else {
          success(`Page ${pageNum} saved (version ${result.version})`);
        }
      } catch (err) {
        if (err instanceof OkraApiError) {
          if (useJson) {
            console.log(formatOutput({ success: false, error: err.message }, 'json'));
          } else {
            error(err.message);
          }
          process.exit(err.exitCode);
        }
        throw err;
      }
    });

  review
    .command('versions <jobId> <pageNum>')
    .description('List page content versions')
    .option('-o, --output <format>', 'Output format (table, json)', getDefaultFormat())
    .action(async (jobId, pageNum, options) => {
      const response = await withSpinner(
        'Fetching versions',
        () => get<{ versions: Array<{ version: number; createdAt: string; createdBy: string }> }>(`api/ocr/jobs/${jobId}/pages/${pageNum}/versions`)
      );

      if (response.versions.length === 0) {
        console.log(chalk.dim('No versions found'));
        return;
      }

      if (options.output === 'json') {
        console.log(formatOutput(response.versions, 'json'));
        return;
      }

      console.log(chalk.bold(`Page ${pageNum} Versions`));
      console.log(chalk.dim('─'.repeat(50)));
      for (const v of response.versions) {
        console.log(`  v${v.version} - ${formatDate(v.createdAt)} by ${v.createdBy}`);
      }
    });

  review
    .command('version <jobId> <pageNum> <version>')
    .description('Get specific version of page content')
    .option('-o, --output <format>', 'Output format (markdown, json)', 'markdown')
    .option('--raw', 'Output raw content without formatting')
    .action(async (jobId, pageNum, version, options) => {
      const page = await withSpinner(
        `Fetching version ${version}`,
        () => get<PageContent>(`api/ocr/jobs/${jobId}/pages/${pageNum}/versions/${version}`)
      );

      if (options.output === 'json') {
        console.log(formatOutput(page, 'json'));
        return;
      }

      if (options.raw) {
        console.log(page.content);
        return;
      }

      console.log(chalk.bold(`Page ${pageNum} - Version ${version}`));
      console.log(chalk.dim('─'.repeat(50)));
      console.log(page.content);
    });

  review
    .command('diff <jobId> <pageNum>')
    .description('Show diff between current and previous version')
    .option('--from <v>', 'Compare from version')
    .option('--to <v>', 'Compare to version')
    .option('-o, --output <format>', 'Output format (table, json)', 'table')
    .action(async (jobId, pageNum, options) => {
      const useJson = options.output === 'json' || isJsonOutput();
      const current = await get<PageContent>(`api/ocr/jobs/${jobId}/pages/${pageNum}`);

      let previousVersion = (current.version || 1) - 1;
      if (options.from) previousVersion = parseInt(options.from);

      if (previousVersion < 1) {
        if (useJson) {
          console.log(formatOutput({
            job_id: jobId,
            page: parseInt(pageNum),
            current_version: current.version,
            previous_version: null,
            message: 'No previous version to compare',
            changes: [],
          }, 'json'));
        } else {
          console.log(chalk.dim('No previous version to compare'));
        }
        return;
      }

      const previous = await get<PageContent>(`api/ocr/jobs/${jobId}/pages/${pageNum}/versions/${previousVersion}`);

      const currentLines = current.content.split('\n');
      const previousLines = previous.content.split('\n');

      const changes: Array<{ line: number; type: 'removed' | 'added'; content: string }> = [];

      for (let i = 0; i < Math.max(currentLines.length, previousLines.length); i++) {
        const curr = currentLines[i] ?? '';
        const prev = previousLines[i] ?? '';
        if (curr !== prev) {
          if (prev) changes.push({ line: i + 1, type: 'removed', content: prev });
          if (curr) changes.push({ line: i + 1, type: 'added', content: curr });
        }
      }

      if (useJson) {
        console.log(formatOutput({
          job_id: jobId,
          page: parseInt(pageNum),
          from_version: previousVersion,
          to_version: current.version,
          changes,
        }, 'json'));
        return;
      }

      console.log(chalk.bold(`Diff: v${previousVersion} → v${current.version}`));
      console.log(chalk.dim('─'.repeat(50)));

      for (const change of changes) {
        if (change.type === 'removed') {
          console.log(chalk.red(`- ${change.content}`));
        } else {
          console.log(chalk.green(`+ ${change.content}`));
        }
      }
    });

  return review;
}
