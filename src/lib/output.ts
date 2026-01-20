/**
 * Output formatters for different output modes
 */

import Table from 'cli-table3';
import chalk from 'chalk';
import type { OutputFormat } from '../types.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TableRow = Record<string, any>;

/**
 * Format data based on the output format
 */
export function formatOutput(
  data: unknown,
  format: OutputFormat,
  columns?: { key: string; header: string; width?: number }[]
): string {
  switch (format) {
    case 'json':
      return formatJson(data);
    case 'jsonl':
      return formatJsonl(data);
    case 'csv':
      return formatCsv(data as TableRow | TableRow[], columns);
    case 'markdown':
      return formatMarkdown(data as TableRow | TableRow[], columns);
    case 'table':
    default:
      return formatTable(data as TableRow | TableRow[], columns);
  }
}

/**
 * Format as JSON
 */
export function formatJson<T>(data: T): string {
  return JSON.stringify(data, null, 2);
}

/**
 * Format as JSON Lines
 */
export function formatJsonl<T>(data: T): string {
  if (Array.isArray(data)) {
    return data.map(item => JSON.stringify(item)).join('\n');
  }
  return JSON.stringify(data);
}

/**
 * Format as CSV
 */
export function formatCsv<T extends TableRow | TableRow[]>(
  data: T,
  columns?: { key: string; header: string }[]
): string {
  const items = Array.isArray(data) ? data : [data];
  if (items.length === 0) return '';

  // Determine columns from first item if not provided
  const cols = columns || Object.keys(items[0]).map(key => ({ key, header: key }));

  // Header row
  const header = cols.map(c => escapeCsvField(c.header)).join(',');

  // Data rows
  const rows = items.map(item =>
    cols.map(c => escapeCsvField(String(item[c.key] ?? ''))).join(',')
  );

  return [header, ...rows].join('\n');
}

/**
 * Escape a CSV field
 */
function escapeCsvField(field: string): string {
  if (field.includes(',') || field.includes('"') || field.includes('\n')) {
    return `"${field.replace(/"/g, '""')}"`;
  }
  return field;
}

/**
 * Format as CLI table
 */
export function formatTable<T extends TableRow | TableRow[]>(
  data: T,
  columns?: { key: string; header: string; width?: number }[]
): string {
  const items = Array.isArray(data) ? data : [data];
  if (items.length === 0) return chalk.dim('No results');

  // Determine columns from first item if not provided
  const cols = columns || Object.keys(items[0]).map(key => ({ key, header: key, width: undefined }));

  const table = new Table({
    head: cols.map(c => chalk.bold(c.header)),
    colWidths: cols.map(c => c.width ?? null),
    style: {
      head: ['cyan'],
      border: ['gray'],
    },
  });

  for (const item of items) {
    table.push(cols.map(c => formatValue(item[c.key])));
  }

  return table.toString();
}

/**
 * Format as Markdown table
 */
export function formatMarkdown<T extends TableRow | TableRow[]>(
  data: T,
  columns?: { key: string; header: string }[]
): string {
  const items = Array.isArray(data) ? data : [data];
  if (items.length === 0) return '_No results_';

  // Determine columns from first item if not provided
  const cols = columns || Object.keys(items[0]).map(key => ({ key, header: key }));

  // Header row
  const header = `| ${cols.map(c => c.header).join(' | ')} |`;
  const separator = `| ${cols.map(() => '---').join(' | ')} |`;

  // Data rows
  const rows = items.map(item =>
    `| ${cols.map(c => escapeMarkdown(String(item[c.key] ?? ''))).join(' | ')} |`
  );

  return [header, separator, ...rows].join('\n');
}

/**
 * Escape markdown special characters
 */
function escapeMarkdown(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/**
 * Format a single value for table display
 */
function formatValue(value: unknown): string {
  if (value === null || value === undefined) {
    return chalk.dim('-');
  }

  if (typeof value === 'boolean') {
    return value ? chalk.green('Yes') : chalk.red('No');
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === 'object') {
    return JSON.stringify(value);
  }

  return String(value);
}

/**
 * Print a success message
 */
export function success(message: string): void {
  console.log(chalk.green('✓'), message);
}

/**
 * Print an error message
 */
export function error(message: string): void {
  console.error(chalk.red('✗'), message);
}

/**
 * Print a warning message
 */
export function warn(message: string): void {
  console.warn(chalk.yellow('!'), message);
}

/**
 * Print an info message
 */
export function info(message: string): void {
  console.log(chalk.blue('ℹ'), message);
}

/**
 * Format file size in human readable format
 */
export function formatFileSize(bytes: number | null): string {
  if (bytes === null) return '-';

  const units = ['B', 'KB', 'MB', 'GB'];
  let unitIndex = 0;
  let size = bytes;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(1)} ${units[unitIndex]}`;
}

/**
 * Format a date in relative or absolute format
 */
export function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    if (diffHours === 0) {
      const diffMins = Math.floor(diffMs / (1000 * 60));
      return `${diffMins}m ago`;
    }
    return `${diffHours}h ago`;
  }

  if (diffDays < 7) {
    return `${diffDays}d ago`;
  }

  return date.toLocaleDateString();
}

/**
 * Format job status with color
 */
export function formatStatus(status: string): string {
  switch (status) {
    case 'completed':
      return chalk.green(status);
    case 'running':
    case 'pending':
      return chalk.blue(status);
    case 'queued':
      return chalk.yellow(status);
    case 'failed':
    case 'cancelled':
      return chalk.red(status);
    default:
      return status;
  }
}
