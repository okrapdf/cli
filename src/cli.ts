/**
 * CLI setup and configuration.
 *
 * BYOK-first: `okra parse` uses your own model-provider key (Gemini / NVIDIA /
 * OpenAI-compatible) and never touches an okra account. The optional okra-cloud
 * connector lives entirely under `okra cloud` (see ./cloud/index.ts) — this is the
 * ONLY module that imports from src/cloud/, and only its single registration.
 *
 * Designed for both human users and AI coding agents:
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
import { createParseCommand } from './commands/parse.js';
import { createProvidersCommand, createAuthCommand } from './commands/providers.js';
import { createCloudCommand } from './cloud/index.js';
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
    .description(
      'Parse PDFs with your own Gemini/NVIDIA/OpenAI-compatible key — layout-aware markdown + 0-1000 bbox blocks. No account required.',
    )
    .version(VERSION, '-v, --version', 'Output the version number')
    .option('-q, --quiet', 'Suppress non-essential output (ideal for piping)')
    .option('--json', 'Shorthand for -o json (machine-readable output)')
    .option('--no-color', 'Disable colored output');

  // Core (BYOK) commands — no okra account, no okra cloud.
  program.addCommand(createParseCommand()); // headline: parse a PDF with your own key
  program.addCommand(createAuthCommand()); // BYOK: store a model-provider key
  program.addCommand(createProvidersCommand()); // list providers + configured status

  // Opt-in okra-cloud connector (account-gated; the core parse path never uses it).
  program.addCommand(createCloudCommand());

  // Handle global --json / --quiet flags
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
${chalk.bold('Quick start (BYOK — bring your own key):')}

  ${chalk.dim('# Free Gemini key at https://aistudio.google.com/apikey')}
  $ export GEMINI_API_KEY=...
  $ okra parse document.pdf

  ${chalk.dim('# Writes ./document.okra/ : doc.md, blocks.json (0-1000 bbox), manifest.json')}
  $ okra parse document.pdf -o json

${chalk.bold('Other providers:')}

  ${chalk.dim('# NVIDIA NIM (free dev tier at https://build.nvidia.com)')}
  $ export NVIDIA_API_KEY=... && okra parse doc.pdf --provider nvidia

  ${chalk.dim('# Any OpenAI-compatible endpoint (vLLM / Ollama / …)')}
  $ export OPENAI_BASE_URL=http://localhost:8000/v1 OPENAI_API_KEY=...
  $ okra parse doc.pdf --provider openai-compatible

  ${chalk.dim('# Store a key instead of exporting it, then list providers')}
  $ okra auth login gemini
  $ okra providers

${chalk.bold('Environment variables:')}

  GEMINI_API_KEY / GOOGLE_API_KEY    Google Gemini (AI Studio) key
  NVIDIA_API_KEY                     NVIDIA NIM key
  OPENROUTER_API_KEY                 OpenRouter key
  OPENAI_BASE_URL + OPENAI_API_KEY   Any OpenAI-compatible endpoint (vLLM / Ollama)
  OKRA_OUTPUT_FORMAT                 Default output: table | json

${chalk.bold('Optional okra cloud connector:')}

  ${chalk.dim('# Hosting / sharing / publishing need an okraPDF account')}
  $ okra cloud --help
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
 * Global error handler. Decoupled from the cloud layer: any error carrying a numeric
 * `exitCode` (cloud's OkraApiError, parse's ParseCommandError) is honored via duck
 * typing — cli.ts imports nothing from src/cloud/ beyond the command registration.
 */
function handleError(err: unknown): never {
  if (
    err &&
    typeof err === 'object' &&
    'exitCode' in err &&
    typeof (err as { exitCode: unknown }).exitCode === 'number'
  ) {
    const e = err as { message?: string; exitCode: number; details?: unknown };
    error(e.message || 'Command failed');
    if (e.details) {
      console.error(chalk.dim(JSON.stringify(e.details, null, 2)));
    }
    process.exit(e.exitCode);
  }

  if (err instanceof Error) {
    if (err.message.includes('ENOTFOUND') || err.message.includes('ECONNREFUSED')) {
      error('Unable to connect. Check your internet connection.');
      process.exit(1);
    }

    if (err.message.includes('ETIMEDOUT')) {
      error('Request timed out. Try again later.');
      process.exit(1);
    }

    error(err.message);

    // Show stack trace in debug mode
    if (process.env.DEBUG) {
      console.error(err.stack);
    }

    process.exit(1);
  }

  error('An unexpected error occurred');
  process.exit(1);
}
