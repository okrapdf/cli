/**
 * Progress indicators and spinners
 */

import ora, { type Ora } from 'ora';
import chalk from 'chalk';

/**
 * Create a spinner
 */
export function createSpinner(text: string): Ora {
  return ora({
    text,
    spinner: 'dots',
  });
}

/**
 * Run an async operation with a spinner
 */
export async function withSpinner<T>(
  text: string,
  operation: () => Promise<T>,
  successText?: string
): Promise<T> {
  const spinner = createSpinner(text);
  spinner.start();

  try {
    const result = await operation();
    spinner.succeed(successText || text);
    return result;
  } catch (error) {
    spinner.fail();
    throw error;
  }
}

/**
 * Simple progress bar
 */
export class ProgressBar {
  private current = 0;
  private total: number;
  private width: number;
  private label: string;

  constructor(total: number, label = 'Progress', width = 30) {
    this.total = total;
    this.width = width;
    this.label = label;
  }

  update(current: number): void {
    this.current = current;
    this.render();
  }

  increment(amount = 1): void {
    this.current = Math.min(this.current + amount, this.total);
    this.render();
  }

  private render(): void {
    const percent = this.total > 0 ? this.current / this.total : 0;
    const filled = Math.round(this.width * percent);
    const empty = this.width - filled;

    const bar = chalk.green('█'.repeat(filled)) + chalk.gray('░'.repeat(empty));
    const percentStr = (percent * 100).toFixed(0).padStart(3);

    process.stdout.write(`\r${this.label}: ${bar} ${percentStr}% (${this.current}/${this.total})`);
  }

  complete(): void {
    this.current = this.total;
    this.render();
    console.log(); // New line after completion
  }
}

/**
 * Poll a job until completion with progress
 */
export async function pollWithProgress<T>(
  pollFn: () => Promise<{ done: boolean; progress?: number; total?: number; data: T }>,
  options: {
    interval?: number;
    timeout?: number;
    label?: string;
  } = {}
): Promise<T> {
  const { interval = 2000, timeout = 300000, label = 'Processing' } = options;

  const startTime = Date.now();
  const spinner = createSpinner(label);
  spinner.start();

  let lastProgress = 0;
  let lastTotal = 0;

  while (true) {
    const elapsed = Date.now() - startTime;
    if (elapsed > timeout) {
      spinner.fail('Timeout waiting for completion');
      throw new Error('Operation timed out');
    }

    const result = await pollFn();

    if (result.progress !== undefined && result.total !== undefined) {
      lastProgress = result.progress;
      lastTotal = result.total;
      const percent = lastTotal > 0 ? Math.round((lastProgress / lastTotal) * 100) : 0;
      spinner.text = `${label}: ${percent}% (${lastProgress}/${lastTotal} pages)`;
    }

    if (result.done) {
      spinner.succeed(`${label}: Complete`);
      return result.data;
    }

    await sleep(interval);
  }
}

/**
 * Sleep helper
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
