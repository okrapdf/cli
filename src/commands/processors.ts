/**
 * Processor management commands
 *
 * List and manage OCR/extraction processors (vendor-agnostic).
 */

import { Command } from 'commander';
import chalk from 'chalk';
import {
  listProcessors,
  getProcessor,
  resolveProcessor,
  formatProcessorList,
  PROCESSOR_ALIASES,
} from '../lib/processors.js';
import { formatOutput } from '../lib/output.js';
import { getDefaultFormat, isJsonOutput } from '../lib/config.js';
import type { OutputFormat } from '../types.js';

export function createProcessorsCommand(): Command {
  const processors = new Command('processors')
    .alias('models')
    .description('List and manage extraction processors');

  // processors list
  processors
    .command('list')
    .alias('ls')
    .description('List available processors')
    .option('-o, --output <format>', 'Output format (table, json)', getDefaultFormat())
    .action((options) => {
      const procs = listProcessors();
      const useJson = options.output === 'json' || isJsonOutput();

      if (useJson) {
        console.log(formatOutput(procs, 'json'));
        return;
      }

      console.log(chalk.bold('\nAvailable Processors\n'));
      console.log(formatProcessorList());
      console.log();
    });

  // processors show <id>
  processors
    .command('show <id>')
    .description('Show processor details')
    .option('-o, --output <format>', 'Output format (table, json)', getDefaultFormat())
    .action((id, options) => {
      const useJson = options.output === 'json' || isJsonOutput();
      const resolved = resolveProcessor(id);
      const proc = getProcessor(resolved);

      if (!proc) {
        if (useJson) {
          console.log(formatOutput({ error: `Unknown processor: ${id}` }, 'json'));
        } else {
          console.error(chalk.red(`Unknown processor: ${id}`));
          console.log(chalk.dim('Run `okra processors list` to see available processors'));
        }
        process.exit(1);
      }

      // Show aliases
      const aliases = Object.entries(PROCESSOR_ALIASES)
        .filter(([_, v]) => v === proc.id)
        .map(([k]) => k);

      if (useJson) {
        console.log(formatOutput({
          ...proc,
          aliases,
        }, 'json'));
        return;
      }

      console.log(chalk.bold('\nProcessor Details\n'));
      console.log(chalk.bold('ID:'), proc.id);
      console.log(chalk.bold('Name:'), proc.name);
      console.log(chalk.bold('Description:'), proc.description);
      console.log(chalk.bold('API Endpoint:'), proc.apiEndpoint);
      if (proc.requiresKey) {
        console.log(chalk.bold('Requires:'), `${proc.requiresKey} API key`);
      }

      if (aliases.length > 0) {
        console.log(chalk.bold('Aliases:'), aliases.join(', '));
      }

      console.log();
    });

  // processors aliases
  processors
    .command('aliases')
    .description('List processor aliases')
    .option('-o, --output <format>', 'Output format (table, json)', getDefaultFormat())
    .action((options) => {
      const aliases = Object.entries(PROCESSOR_ALIASES).map(([alias, target]) => ({
        alias,
        processor: target,
      }));
      const useJson = options.output === 'json' || isJsonOutput();

      if (useJson) {
        console.log(formatOutput(aliases, 'json'));
        return;
      }

      console.log(chalk.bold('\nProcessor Aliases\n'));
      for (const { alias, processor } of aliases) {
        console.log(`  ${chalk.cyan(alias.padEnd(12))} → ${processor}`);
      }
      console.log();
    });

  // Default action (no subcommand) - same as list
  processors
    .option('-o, --output <format>', 'Output format (table, json)', getDefaultFormat())
    .action((options) => {
      const procs = listProcessors();
      const useJson = options.output === 'json' || isJsonOutput();

      if (useJson) {
        console.log(formatOutput(procs, 'json'));
        return;
      }

      console.log(chalk.bold('\nAvailable Processors\n'));
      console.log(formatProcessorList());
      console.log();
      console.log(chalk.dim('Use `okra processors show <id>` for details'));
      console.log();
    });

  return processors;
}
