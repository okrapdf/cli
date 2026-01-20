import { Command } from 'commander';
import chalk from 'chalk';
import { formatOutput } from '../lib/output.js';
import { getDefaultVlm, isJsonOutput, getDefaultFormat } from '../lib/config.js';

const VLM_MODELS = [
  { model: 'qwen/qwen3-vl-235b-a22b-instruct', description: 'Qwen3 VL 235B - fast, accurate', default: true },
  { model: 'google/gemini-2.5-flash-preview-09-2025', description: 'Gemini 2.5 Flash Preview', default: false },
  { model: 'google/gemini-3-flash-preview', description: 'Gemini 3 Flash Preview', default: false },
];

export function createProvidersCommand(): Command {
  return new Command('providers')
    .description('Provider management (OpenRouter only for now)')
    .option('-o, --output <format>', 'Output format (table, json)', getDefaultFormat())
    .action((options) => {
      const useJson = options.output === 'json' || isJsonOutput();

      if (useJson) {
        console.log(formatOutput({
          provider: 'openrouter',
          description: 'Currently using OpenRouter for all VLM requests.',
          models: VLM_MODELS,
        }, 'json'));
        return;
      }

      console.log(chalk.dim('Currently using OpenRouter for all VLM requests.'));
      console.log(chalk.dim('Use `okra vlm list` to see available models.'));
    });
}

export function createVlmCommand(): Command {
  const cmd = new Command('vlm')
    .description('Manage Vision Language Models');

  cmd
    .command('list')
    .description('List available VLM models')
    .option('-o, --output <format>', 'Output format (table, json)', 'table')
    .action((options) => {
      const currentVlm = getDefaultVlm();
      const useJson = options.output === 'json' || isJsonOutput();

      if (useJson) {
        console.log(formatOutput(VLM_MODELS, 'json'));
        return;
      }

      console.log(chalk.bold('\nAvailable VLM Models (via OpenRouter)\n'));
      console.log(chalk.dim('Model'.padEnd(45) + 'Description'));
      console.log(chalk.dim('─'.repeat(75)));

      for (const m of VLM_MODELS) {
        const isCurrent = currentVlm === m.model;
        const isDefault = m.default && !currentVlm;
        const status = isCurrent ? ' ● current' : isDefault ? ' (default)' : '';
        const model = isCurrent ? chalk.cyan(m.model.padEnd(45)) : m.model.padEnd(45);
        console.log(`${model}${m.description}${chalk.dim(status)}`);
      }

      console.log(chalk.dim('\nSet default: okra config set vlm <model>'));
      console.log(chalk.dim('Per-request:  okra extract file.pdf --vlm google/gemini-2.5-flash-preview-09-2025\n'));
    });

  return cmd;
}
