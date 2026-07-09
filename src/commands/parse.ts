/**
 * `okra parse <pdf>` — the BYOK headline command (DESIGN.md #4). Wires the seams
 * (dependency rule 5): getParser → getProvider → resolveProvider (flag>env>config)
 * → createClient → core/parseDocument, then writes doc.md / blocks.json /
 * manifest.json and prints a machine-readable envelope (-o json) or a summary.
 *
 * The pure `runParse` returns the envelope + throws `ParseCommandError` (with an
 * exit code) instead of calling process.exit — so it is unit-testable end-to-end
 * against a mocked transport. The thin commander wrapper owns the spinner + exit.
 *
 * BYOK-only: no okra account, no okra cloud host. The pricing hook is passed in here
 * (the engine must never import providers/pricing — dependency rule 3).
 */
import { Command } from 'commander';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import chalk from 'chalk';
import ora from 'ora';
import { formatOutput, error, info } from '../lib/output.js';
import { getDefaultFormat, isJsonOutput, getProviderConfig } from '../lib/config.js';
import { PROVIDERS, getProvider, resolveProvider } from '../providers/registry.js';
import { createClient } from '../providers/client.js';
import { costUsdOrUndefined } from '../providers/pricing.js';
import { PARSERS, getParser, DEFAULT_PARSER_ID } from '../parsers/registry.js';
import { parseDocument } from '../core/engine.js';
import type { DocumentParse, ParseRunMeta, TokenUsage } from '../core/blocks.js';

/** Exit codes: 1 = runtime/resolution error, 2 = invalid arguments. */
export const PARSE_EXIT = { OK: 0, ERROR: 1, INVALID_ARGS: 2 } as const;

/** User-facing failure carrying the process exit code (the wrapper does the exit). */
export class ParseCommandError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number,
  ) {
    super(message);
    this.name = 'ParseCommandError';
  }
}

export interface ParseCliOptions {
  provider?: string;
  model?: string;
  parser?: string;
  out?: string;
  pages?: string;
  concurrency?: string;
  dpi?: string;
  apiKey?: string;
  baseUrl?: string;
  output?: string;
}

export interface RunParseDeps {
  env?: NodeJS.ProcessEnv;
  getProviderConfig?: (id: string) => { apiKey?: string; baseUrl?: string };
  onProgress?: (done: number, total: number) => void;
}

export interface ParsePageSummary {
  page: number;
  blockCount: number;
  usage?: TokenUsage;
}

/** manifest.json shape: run meta + per-page block/usage summary. */
export interface ParseManifest {
  meta: ParseRunMeta;
  pages: ParsePageSummary[];
}

/** `-o json` stdout envelope: meta + per-page block counts + where files landed. */
export interface ParseEnvelope {
  meta: ParseRunMeta;
  pages: { page: number; blockCount: number }[];
  outDir: string;
}

export interface RunParseResult {
  envelope: ParseEnvelope;
  manifest: ParseManifest;
  result: DocumentParse;
  outDir: string;
}

function parsePageRange(raw: string): { from: number; to: number } {
  const m = /^(\d+)(?:-(\d+))?$/.exec(raw.trim());
  if (!m) {
    throw new ParseCommandError(
      `Invalid --pages '${raw}'. Use a range A-B (e.g. 1-5) or a single page N.`,
      PARSE_EXIT.INVALID_ARGS,
    );
  }
  const from = Number.parseInt(m[1], 10);
  const to = m[2] ? Number.parseInt(m[2], 10) : from;
  if (from < 1 || to < from) {
    throw new ParseCommandError(
      `Invalid --pages '${raw}'. Expected 1 <= from <= to.`,
      PARSE_EXIT.INVALID_ARGS,
    );
  }
  return { from, to };
}

function parsePositiveInt(raw: string, flag: string): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || String(n) !== raw.trim() || n < 1) {
    throw new ParseCommandError(
      `Invalid ${flag} '${raw}'. Expected a positive integer.`,
      PARSE_EXIT.INVALID_ARGS,
    );
  }
  return n;
}

/**
 * Run a parse end-to-end and write the three artifacts. Returns the envelope +
 * manifest. Throws `ParseCommandError` (never exits) so it is fully testable.
 */
export async function runParse(
  pdfPath: string,
  options: ParseCliOptions,
  deps: RunParseDeps = {},
): Promise<RunParseResult> {
  const env = deps.env ?? process.env;
  const readCfg = deps.getProviderConfig ?? getProviderConfig;

  // 1. input file
  const filePath = resolve(pdfPath);
  if (!existsSync(filePath)) {
    throw new ParseCommandError(`File not found: ${filePath}`, PARSE_EXIT.INVALID_ARGS);
  }

  // 2. parser (default: layout-vlm)
  const parserId = options.parser ?? DEFAULT_PARSER_ID;
  const parser = getParser(parserId);
  if (!parser) {
    throw new ParseCommandError(
      `Unknown parser '${parserId}'. Available: ${PARSERS.map((p) => p.spec.id).join(', ')}.`,
      PARSE_EXIT.INVALID_ARGS,
    );
  }

  // 3. provider (default: gemini)
  const providerId = options.provider ?? 'gemini';
  const provider = getProvider(providerId);
  if (!provider) {
    throw new ParseCommandError(
      `Unknown provider '${providerId}'. Valid: ${PROVIDERS.map((p) => p.id).join(', ')}. ` +
        'Run `okra providers list`.',
      PARSE_EXIT.INVALID_ARGS,
    );
  }

  // 4. validate arg SHAPES before resolving the key (#16). A bad --pages/--concurrency/--dpi
  //    is an argument error (INVALID_ARGS, exit 2) and must surface as such even when no
  //    provider key is present — otherwise the missing-key error (exit 1) masks it.
  const pages = options.pages ? parsePageRange(options.pages) : undefined;
  const concurrency = options.concurrency
    ? parsePositiveInt(options.concurrency, '--concurrency')
    : undefined;
  const dpi = options.dpi ? parsePositiveInt(options.dpi, '--dpi') : undefined;

  // 5. resolve key + base URL (flag > env > config). Resolution errors are user-facing
  //    (name the exact env var / `okra auth login`) — surface them verbatim.
  let resolved;
  try {
    resolved = resolveProvider(provider, {
      flagKey: options.apiKey,
      flagBaseUrl: options.baseUrl,
      env,
      config: readCfg(providerId),
    });
  } catch (err) {
    throw new ParseCommandError(err instanceof Error ? err.message : String(err), PARSE_EXIT.ERROR);
  }

  // 6. model (default: provider default)
  const model = options.model || provider.defaultModel;
  if (!model) {
    throw new ParseCommandError(
      `No model for provider '${providerId}'. Pass --model <id>.`,
      PARSE_EXIT.INVALID_ARGS,
    );
  }

  const client = createClient(resolved);
  const pdf = new Uint8Array(readFileSync(filePath));

  const result = await parseDocument(pdf, {
    parser,
    vlm: client,
    model,
    providerId,
    pages,
    concurrency,
    dpi,
    // pass the pricing hook from providers/ (the engine never imports it).
    pricing: costUsdOrUndefined,
    signal: undefined,
    onProgress: deps.onProgress,
  });

  // 6. write artifacts under <out>/ (default ./<pdf-basename>.okra/)
  const base = basename(filePath).replace(/\.pdf$/i, '');
  const outDir = options.out ? resolve(options.out) : resolve(process.cwd(), `${base}.okra`);
  mkdirSync(outDir, { recursive: true });

  const manifest: ParseManifest = {
    meta: result.meta,
    pages: result.pages.map((p) => ({ page: p.page, blockCount: p.blocks.length, usage: p.usage })),
  };

  writeFileSync(join(outDir, 'doc.md'), result.markdown, 'utf8');
  writeFileSync(join(outDir, 'blocks.json'), JSON.stringify(result.blocks, null, 2), 'utf8');
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  const envelope: ParseEnvelope = {
    meta: result.meta,
    pages: result.pages.map((p) => ({ page: p.page, blockCount: p.blocks.length })),
    outDir,
  };

  return { envelope, manifest, result, outDir };
}

function printSummary(envelope: ParseEnvelope): void {
  const { meta } = envelope;
  const totalBlocks = envelope.pages.reduce((sum, p) => sum + p.blockCount, 0);
  console.log();
  console.log(chalk.bold('Parse complete'));
  console.log(chalk.dim('─'.repeat(44)));
  console.log(`${chalk.dim('Parser:  ')} ${meta.parserId}`);
  console.log(`${chalk.dim('Provider:')} ${meta.providerId ?? '-'}`);
  console.log(`${chalk.dim('Model:   ')} ${meta.model ?? '-'}`);
  console.log(`${chalk.dim('Pages:   ')} ${meta.pageCount}`);
  console.log(`${chalk.dim('Blocks:  ')} ${totalBlocks}`);
  if (meta.costUsd !== undefined) console.log(`${chalk.dim('Cost:    ')} $${meta.costUsd.toFixed(4)}`);
  console.log(`${chalk.dim('Duration:')} ${(meta.durationMs / 1000).toFixed(1)}s`);
  console.log(`${chalk.dim('Output:  ')} ${envelope.outDir}`);
  for (const w of meta.warnings) info(w);
}

export function createParseCommand(): Command {
  return new Command('parse')
    .description('Parse a PDF to markdown + layout blocks with your own model key (BYOK)')
    .argument('<pdf>', 'Path to a PDF file')
    .option('--provider <id>', `Model provider (${PROVIDERS.map((p) => p.id).join(' | ')})`, 'gemini')
    .option('--model <id>', 'Model id (default: the provider default)')
    .option('--parser <id>', 'Parser to use', DEFAULT_PARSER_ID)
    .option('--out <dir>', 'Output directory (default: ./<pdf-basename>.okra/)')
    .option('--pages <range>', 'Page range, e.g. 1-5 (default: all pages)')
    .option('--concurrency <n>', 'Max pages parsed in parallel (default: 4)')
    .option('--dpi <n>', 'Rasterization DPI (default: 175)')
    .option('--api-key <key>', 'Provider API key (overrides env / config)')
    .option('--base-url <url>', 'Provider base URL (required for openai-compatible)')
    .option('-o, --output <format>', 'Output format (table, json)', getDefaultFormat())
    .action(async (pdf: string, options: ParseCliOptions) => {
      const useJson = options.output === 'json' || isJsonOutput();
      const spinner = useJson ? null : ora({ text: 'Parsing…' });
      spinner?.start();
      try {
        const { envelope } = await runParse(pdf, options, {
          onProgress: (done, total) => {
            if (spinner) spinner.text = `Parsing page ${done}/${total}…`;
          },
        });
        spinner?.succeed(
          `Parsed ${envelope.meta.pageCount} page${envelope.meta.pageCount === 1 ? '' : 's'} → ${envelope.outDir}`,
        );
        if (useJson) {
          console.log(formatOutput(envelope, 'json'));
        } else {
          printSummary(envelope);
        }
      } catch (err) {
        spinner?.stop();
        if (err instanceof ParseCommandError) {
          error(err.message);
          process.exit(err.exitCode);
        }
        error(err instanceof Error ? err.message : String(err));
        process.exit(PARSE_EXIT.ERROR);
      }
    });
}
