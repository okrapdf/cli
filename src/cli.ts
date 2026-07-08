/**
 * CLI setup and configuration
 *
 * Designed for both human users and AI coding agents.
 * - Predictable commands and flags
 * - Machine-readable JSON output (-o json)
 * - Composable with pipes (stdin/stdout)
 * - Environment variable configuration
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createDocsCommand } from './commands/docs.js';
import { createJobsCommand } from './commands/jobs.js';
import { createTablesCommand } from './commands/tables.js';
import { createEntitiesCommand } from './commands/entities.js';
import { createChatCommand } from './commands/chat.js';
import { createExtractCommand, createRunCommand } from './commands/shortcuts.js';
import { createProcessorsCommand } from './commands/processors.js';
import { createTemplatesCommand } from './commands/templates.js';
import { createLogsCommand } from './commands/logs.js';
import { createProvidersCommand, createAuthCommand } from './commands/providers.js';
import { createReviewCommand } from './commands/review.js';
import { OkraApiError, EXIT_CODES } from './lib/client.js';
import { error } from './lib/output.js';

const VERSION = readVersion();

function readVersion(): string {
  try {
    const currentDir = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(currentDir, '..', 'package.json');
    const raw = readFileSync(pkgPath, 'utf8');
    return JSON.parse(raw).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Create and configure the CLI program
 */
export function createProgram(): Command {
  const program = new Command();

  program
    .name('okra')
    .description('OkraPDF CLI - Extract tables and chat with PDF documents')
    .version(VERSION, '-v, --version', 'Output the version number')
    .option('-q, --quiet', 'Suppress non-essential output (ideal for piping)')
    .option('--json', 'Shorthand for -o json (machine-readable output)')
    .option('--no-color', 'Disable colored output');

  // Core commands
  program.addCommand(createAuthCommand());
  program.addCommand(createDocsCommand());
  program.addCommand(createJobsCommand());
  program.addCommand(createTablesCommand());
  program.addCommand(createEntitiesCommand());
  program.addCommand(createReviewCommand());
  program.addCommand(createChatCommand());

  // Shortcut commands (most common workflows)
  program.addCommand(createExtractCommand());
  program.addCommand(createRunCommand());

  // Introspection commands (vendor-agnostic architecture)
  program.addCommand(createProcessorsCommand());
  program.addCommand(createTemplatesCommand());
  program.addCommand(createLogsCommand());
  program.addCommand(createProvidersCommand());

  // Handle global --json flag
  program.hook('preAction', (thisCommand) => {
    const opts = thisCommand.opts();
    if (opts.json) {
      process.env.OKRA_OUTPUT_FORMAT = 'json';
    }
    if (opts.quiet) {
      process.env.OKRA_QUIET = '1';
    }
  });

  // Add examples to help
  program.addHelpText('after', `
${chalk.bold('Quick Start:')}

  ${chalk.dim('# Set API key (or use OKRA_API_KEY env var)')}
  $ export OKRA_API_KEY=okra_xxxx

  ${chalk.dim('# Extract tables from a PDF')}
  $ okra extract invoice.pdf

  ${chalk.dim('# Ask a question about a document')}
  $ okra run report.pdf "What is the total revenue?"

${chalk.bold('For AI Agents (Machine-Readable Output):')}

  ${chalk.dim('# Get tables as JSON (for building presentations, reports)')}
  $ okra extract document.pdf --json --quiet

  ${chalk.dim('# Get document list as JSON for processing')}
  $ okra docs list -o json | jq '.[].uuid'

  ${chalk.dim('# Extract with specific processor')}
  $ okra jobs create document.pdf -p gemini --wait -o json

  ${chalk.dim('# Pipe table data to other tools')}
  $ okra tables get <table-id> -o csv | csvkit ...

${chalk.bold('Common Workflows:')}

  ${chalk.dim('# Upload + extract + get results')}
  $ okra extract invoice.pdf -o json > results.json

  ${chalk.dim('# Use a template for structured extraction')}
  $ okra extract receipt.pdf --template receipt -o json

  ${chalk.dim('# Interactive document chat')}
  $ okra chat <document-uuid>

  ${chalk.dim('# List available processors')}
  $ okra processors list

  ${chalk.dim('# View job history')}
  $ okra logs

${chalk.bold('Review & Verification:')}

  ${chalk.dim('# Get verification status summary for a job')}
  $ okra review status <jobId>

  ${chalk.dim('# List pages with verification status')}
  $ okra review pages <jobId> --status pending

  ${chalk.dim('# List extracted tables for a job')}
  $ okra review tables <jobId>

  ${chalk.dim('# Open job review page in browser')}
  $ okra review open <jobId>

${chalk.bold('Entity Image Export:')}

  ${chalk.dim('# Export all entities as PNG images')}
  $ okra entities images <jobId>

  ${chalk.dim('# Export only tables as JPG with custom output dir')}
  $ okra entities images <jobId> -t tables -f jpg -o ./table-images

  ${chalk.dim('# List entities with bounding boxes')}
  $ okra entities list <jobId> --with-bbox

${chalk.bold('Environment Variables:')}

  OKRA_API_KEY        API key (required)
  OKRA_BASE_URL       Base URL (default: https://okrapdf.com)
  OKRA_OUTPUT_FORMAT  Default output: table, json, csv (default: table)
  OKRA_VLM            Default VLM model (e.g., google/gemini-2.5-flash-preview-09-2025)

${chalk.bold('More Information:')}

  Documentation: ${chalk.cyan('https://docs.okrapdf.com/cli')}
  API Reference: ${chalk.cyan('https://docs.okrapdf.com/api')}
  GitHub: ${chalk.cyan('https://github.com/steventsao/okrapdf')}
`);

  return program;
}

/**
 * Run the CLI with error handling
 */
export async function run(argv: string[] = process.argv): Promise<void> {
  const program = createProgram();

  try {
    await program.parseAsync(argv);
  } catch (err) {
    handleError(err);
  }
}

/**
 * Global error handler
 */
function handleError(err: unknown): never {
  if (err instanceof OkraApiError) {
    error(err.message);

    if (err.details) {
      console.error(chalk.dim(JSON.stringify(err.details, null, 2)));
    }

    process.exit(err.exitCode);
  }

  if (err instanceof Error) {
    // Check for common errors
    if (err.message.includes('ENOTFOUND') || err.message.includes('ECONNREFUSED')) {
      error('Unable to connect to OkraPDF. Check your internet connection.');
      process.exit(EXIT_CODES.GENERAL_ERROR);
    }

    if (err.message.includes('ETIMEDOUT')) {
      error('Request timed out. Try again later.');
      process.exit(EXIT_CODES.GENERAL_ERROR);
    }

    error(err.message);

    // Show stack trace in debug mode
    if (process.env.DEBUG) {
      console.error(err.stack);
    }

    process.exit(EXIT_CODES.GENERAL_ERROR);
  }

  error('An unexpected error occurred');
  process.exit(EXIT_CODES.GENERAL_ERROR);
}
