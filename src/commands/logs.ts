/**
 * Log management commands
 *
 * View local job history and usage stats.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import {
  getJobLogs,
  getChatLogs,
  getJobStats,
  clearLogs,
  exportLogs,
  formatJobLog,
  getLogsDir,
} from '../lib/logs.js';
import { formatOutput, success, info } from '../lib/output.js';
import { getDefaultFormat, isJsonOutput } from '../lib/config.js';
import type { OutputFormat } from '../types.js';

export function createLogsCommand(): Command {
  const logs = new Command('logs')
    .description('View local job history and stats');

  // logs list (default)
  logs
    .command('list')
    .alias('ls')
    .description('List recent jobs')
    .option('-o, --output <format>', 'Output format (table, json)', getDefaultFormat())
    .option('-n, --limit <n>', 'Number of entries to show', '20')
    .option('-s, --status <status>', 'Filter by status')
    .option('--processor <processor>', 'Filter by processor')
    .option('-q, --search <query>', 'Search by filename or ID')
    .action((options) => {
      const entries = getJobLogs({
        limit: parseInt(options.limit),
        status: options.status,
        processor: options.processor,
        search: options.search,
      });

      if (options.output === 'json') {
        console.log(formatOutput(entries, 'json'));
        return;
      }

      if (entries.length === 0) {
        console.log(chalk.dim('No jobs in history'));
        return;
      }

      console.log(chalk.bold('\nRecent Jobs\n'));
      console.log(chalk.dim('Timestamp           | Status     | Processor  | Time   | File'));
      console.log(chalk.dim('─'.repeat(80)));

      for (const entry of entries) {
        const statusColor =
          entry.status === 'completed' ? chalk.green :
          entry.status === 'failed' ? chalk.red :
          chalk.yellow;

        const duration = entry.duration_ms
          ? `${(entry.duration_ms / 1000).toFixed(1)}s`
          : '-';

        console.log(
          `${entry.started_at.slice(0, 19)} | ` +
          `${statusColor(entry.status.padEnd(10))} | ` +
          `${entry.processor.padEnd(10)} | ` +
          `${duration.padStart(6)} | ` +
          `${entry.file_name || entry.job_id}`
        );
      }

      console.log();
    });

  // logs stats
  logs
    .command('stats')
    .description('Show usage statistics')
    .option('-o, --output <format>', 'Output format (table, json)', getDefaultFormat())
    .action((options) => {
      const stats = getJobStats();

      if (options.output === 'json') {
        console.log(formatOutput(stats, 'json'));
        return;
      }

      console.log(chalk.bold('\nUsage Statistics\n'));
      console.log(chalk.bold('Total Jobs:'), stats.total);
      console.log(chalk.bold('Completed:'), chalk.green(stats.completed));
      console.log(chalk.bold('Failed:'), chalk.red(stats.failed));
      console.log(chalk.bold('Total Pages:'), stats.totalPages);
      console.log(chalk.bold('Avg Duration:'), stats.avgDuration > 0 ? `${(stats.avgDuration / 1000).toFixed(1)}s` : '-');

      if (Object.keys(stats.byProcessor).length > 0) {
        console.log(chalk.bold('\nBy Processor:'));
        for (const [processor, count] of Object.entries(stats.byProcessor)) {
          console.log(`  ${processor}: ${count}`);
        }
      }

      console.log();
    });

  // logs chat
  logs
    .command('chat')
    .description('List recent chat messages')
    .option('-o, --output <format>', 'Output format (table, json)', getDefaultFormat())
    .option('-n, --limit <n>', 'Number of entries', '20')
    .option('-d, --document <uuid>', 'Filter by document')
    .option('-q, --search <query>', 'Search messages')
    .action((options) => {
      const entries = getChatLogs({
        limit: parseInt(options.limit),
        documentUuid: options.document,
        search: options.search,
      });

      if (options.output === 'json') {
        console.log(formatOutput(entries, 'json'));
        return;
      }

      if (entries.length === 0) {
        console.log(chalk.dim('No chat history'));
        return;
      }

      console.log(chalk.bold('\nRecent Chats\n'));

      for (const entry of entries) {
        console.log(chalk.dim(entry.timestamp.slice(0, 19)));
        console.log(chalk.cyan('Q:'), truncate(entry.message, 60));
        console.log(chalk.green('A:'), truncate(entry.response, 60));
        console.log();
      }
    });

  // logs export
  logs
    .command('export')
    .description('Export logs to JSON')
    .option('-o, --out <file>', 'Output file path')
    .action(async (options) => {
      const json = exportLogs();

      if (options.out) {
        const { writeFileSync } = await import('fs');
        writeFileSync(options.out, json, 'utf-8');
        success(`Exported to: ${options.out}`);
      } else {
        console.log(json);
      }
    });

  // logs clear
  logs
    .command('clear')
    .description('Clear log history')
    .option('-f, --force', 'Skip confirmation')
    .option('--jobs', 'Clear only job logs')
    .option('--chats', 'Clear only chat logs')
    .option('-o, --output <format>', 'Output format (table, json)', 'table')
    .action(async (options) => {
      const useJson = options.output === 'json' || isJsonOutput();

      if (!options.force && !useJson) {
        const { prompt } = await import('enquirer');
        const response = await prompt<{ confirm: boolean }>({
          type: 'confirm',
          name: 'confirm',
          message: 'Clear all logs?',
          initial: false,
        });

        if (!response.confirm) {
          console.log('Cancelled');
          return;
        }
      }

      const type = options.jobs ? 'jobs' : options.chats ? 'chats' : undefined;
      clearLogs(type);

      if (useJson) {
        console.log(formatOutput({ success: true, message: 'Logs cleared', type: type || 'all' }, 'json'));
      } else {
        success('Logs cleared');
      }
    });

  // logs path
  logs
    .command('path')
    .description('Show logs directory path')
    .option('-o, --output <format>', 'Output format (table, json)', 'table')
    .action((options) => {
      const useJson = options.output === 'json' || isJsonOutput();
      const path = getLogsDir();

      if (useJson) {
        console.log(formatOutput({ path }, 'json'));
      } else {
        console.log(path);
      }
    });

  // Default action - same as list
  logs
    .option('-o, --output <format>', 'Output format (table, json)', getDefaultFormat())
    .action((options) => {
      const useJson = options.output === 'json' || isJsonOutput();
      const entries = getJobLogs({ limit: 10 });

      if (useJson) {
        console.log(formatOutput(entries, 'json'));
        return;
      }

      if (entries.length === 0) {
        console.log(chalk.dim('No jobs in history'));
        console.log(chalk.dim('Run `okra extract` or `okra jobs create` to get started'));
        return;
      }

      console.log(chalk.bold('\nRecent Jobs\n'));

      for (const entry of entries) {
        const statusColor =
          entry.status === 'completed' ? chalk.green :
          entry.status === 'failed' ? chalk.red :
          chalk.yellow;

        console.log(`${chalk.dim(entry.started_at.slice(0, 10))} ${statusColor(entry.status.padEnd(10))} ${entry.file_name || entry.job_id}`);
      }

      console.log();
      console.log(chalk.dim('Use `okra logs list -o json` for full details'));
      console.log();
    });

  return logs;
}

function truncate(str: string, len: number): string {
  if (str.length <= len) return str;
  return str.slice(0, len - 3) + '...';
}
