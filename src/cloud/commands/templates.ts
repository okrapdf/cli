/**
 * Template management commands
 *
 * Create, list, and use extraction templates.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import {
  listTemplates,
  loadTemplate,
  saveTemplate,
  deleteTemplate,
  formatTemplateInfo,
  getTemplatesDir,
  BUILTIN_TEMPLATES,
  Template,
} from '../lib/templates.js';
import { formatOutput, success, error, info } from '../../lib/output.js';
import { getDefaultFormat, isJsonOutput } from '../../lib/config.js';
import type { OutputFormat } from '../../types.js';

export function createTemplatesCommand(): Command {
  const templates = new Command('templates')
    .description('Manage extraction templates');

  // templates list
  templates
    .command('list')
    .alias('ls')
    .description('List available templates')
    .option('-o, --output <format>', 'Output format (table, json)', getDefaultFormat())
    .option('-b, --builtin', 'Show only built-in templates')
    .option('-c, --custom', 'Show only custom templates')
    .action((options) => {
      let tpls = listTemplates();
      const useJson = options.output === 'json' || isJsonOutput();

      if (options.builtin) {
        tpls = tpls.filter(t => t.builtin);
      } else if (options.custom) {
        tpls = tpls.filter(t => !t.builtin);
      }

      if (useJson) {
        console.log(formatOutput(tpls, 'json'));
        return;
      }

      if (tpls.length === 0) {
        console.log(chalk.dim('No templates found'));
        return;
      }

      console.log(chalk.bold('\nAvailable Templates\n'));

      for (const tpl of tpls) {
        const badge = tpl.builtin ? chalk.gray(' (builtin)') : chalk.green(' (custom)');
        const processor = tpl.processor ? chalk.dim(` [${tpl.processor}]`) : '';
        console.log(`  ${chalk.cyan(tpl.id.padEnd(20))} ${tpl.name}${badge}${processor}`);
        console.log(`  ${''.padEnd(20)} ${chalk.dim(tpl.description)}`);
        console.log();
      }

      console.log(chalk.dim(`Templates directory: ${getTemplatesDir()}`));
      console.log();
    });

  // templates show <id>
  templates
    .command('show <id>')
    .description('Show template details')
    .option('-o, --output <format>', 'Output format (text, json)', 'text')
    .action((id, options) => {
      const useJson = options.output === 'json' || isJsonOutput();
      const tpl = loadTemplate(id);

      if (!tpl) {
        error(`Template not found: ${id}`);
        console.log(chalk.dim('Run `okra templates list` to see available templates'));
        process.exit(1);
      }

      if (useJson) {
        console.log(formatOutput(tpl, 'json'));
        return;
      }

      console.log();
      console.log(formatTemplateInfo(tpl));
      console.log();
    });

  // templates create
  templates
    .command('create <id>')
    .description('Create a new custom template')
    .option('-n, --name <name>', 'Template name')
    .option('-d, --description <desc>', 'Template description')
    .option('--processor <processor>', 'Preferred processor')
    .option('--from <template>', 'Base on existing template')
    .option('-o, --output <format>', 'Output format (table, json)', 'table')
    .action(async (id, options) => {
      const useJson = options.output === 'json' || isJsonOutput();

      // Check if template already exists
      const existing = loadTemplate(id);
      if (existing && existing.builtin) {
        if (useJson) {
          console.log(formatOutput({ success: false, error: `Cannot override built-in template: ${id}` }, 'json'));
        } else {
          error(`Cannot override built-in template: ${id}`);
        }
        process.exit(1);
      }

      let template: Template;

      if (options.from) {
        // Base on existing template
        const base = loadTemplate(options.from);
        if (!base) {
          if (useJson) {
            console.log(formatOutput({ success: false, error: `Base template not found: ${options.from}` }, 'json'));
          } else {
            error(`Base template not found: ${options.from}`);
          }
          process.exit(1);
        }
        template = {
          ...base,
          id,
          name: options.name || `${base.name} (copy)`,
          description: options.description || base.description,
          builtin: false,
        };
      } else {
        // Create new empty template
        template = {
          id,
          name: options.name || id,
          description: options.description || `Custom template: ${id}`,
          documentType: 'custom',
          processor: options.processor,
          fields: [],
          builtin: false,
        };
      }

      if (options.processor) {
        template.processor = options.processor;
      }

      saveTemplate(template);

      if (useJson) {
        console.log(formatOutput({
          success: true,
          template: { id, name: template.name, path: `${getTemplatesDir()}/${id}.json` },
        }, 'json'));
      } else {
        success(`Template created: ${id}`);
        info(`Edit at: ${getTemplatesDir()}/${id}.json`);
      }
    });

  // templates edit <id>
  templates
    .command('edit <id>')
    .description('Open template in editor')
    .action(async (id) => {
      const tpl = loadTemplate(id);

      if (tpl?.builtin) {
        error('Cannot edit built-in template. Use `okra templates create --from` to create a copy.');
        process.exit(1);
      }

      if (!tpl) {
        error(`Template not found: ${id}`);
        process.exit(1);
      }

      const path = `${getTemplatesDir()}/${id}.json`;
      const editor = process.env.EDITOR || 'vi';

      console.log(chalk.dim(`Opening ${path} in ${editor}...`));

      const { spawn } = await import('child_process');
      const child = spawn(editor, [path], { stdio: 'inherit' });

      child.on('exit', (code) => {
        if (code === 0) {
          success('Template saved');
        }
        process.exit(code || 0);
      });
    });

  // templates delete <id>
  templates
    .command('delete <id>')
    .alias('rm')
    .description('Delete a custom template')
    .option('-f, --force', 'Skip confirmation')
    .option('-o, --output <format>', 'Output format (table, json)', 'table')
    .action(async (id, options) => {
      const useJson = options.output === 'json' || isJsonOutput();
      const tpl = loadTemplate(id);

      if (!tpl) {
        if (useJson) {
          console.log(formatOutput({ success: false, error: `Template not found: ${id}` }, 'json'));
        } else {
          error(`Template not found: ${id}`);
        }
        process.exit(1);
      }

      if (tpl.builtin) {
        if (useJson) {
          console.log(formatOutput({ success: false, error: 'Cannot delete built-in template' }, 'json'));
        } else {
          error('Cannot delete built-in template');
        }
        process.exit(1);
      }

      if (!options.force && !useJson) {
        const { prompt } = await import('enquirer');
        const response = await prompt<{ confirm: boolean }>({
          type: 'confirm',
          name: 'confirm',
          message: `Delete template "${id}"?`,
          initial: false,
        });

        if (!response.confirm) {
          console.log('Cancelled');
          return;
        }
      }

      if (deleteTemplate(id)) {
        if (useJson) {
          console.log(formatOutput({ success: true, id, message: 'Template deleted' }, 'json'));
        } else {
          success(`Template deleted: ${id}`);
        }
      } else {
        if (useJson) {
          console.log(formatOutput({ success: false, error: 'Failed to delete template' }, 'json'));
        } else {
          error('Failed to delete template');
        }
      }
    });

  // templates path
  templates
    .command('path')
    .description('Show templates directory path')
    .option('-o, --output <format>', 'Output format (table, json)', 'table')
    .action((options) => {
      const useJson = options.output === 'json' || isJsonOutput();
      const path = getTemplatesDir();

      if (useJson) {
        console.log(formatOutput({ path }, 'json'));
      } else {
        console.log(path);
      }
    });

  // Default action - same as list
  templates
    .option('-o, --output <format>', 'Output format (table, json)', getDefaultFormat())
    .action((options) => {
      const useJson = options.output === 'json' || isJsonOutput();
      const tpls = listTemplates();

      if (useJson) {
        console.log(formatOutput(tpls, 'json'));
        return;
      }

      console.log(chalk.bold('\nAvailable Templates\n'));

      for (const tpl of tpls) {
        const badge = tpl.builtin ? chalk.gray(' (builtin)') : chalk.green(' (custom)');
        console.log(`  ${chalk.cyan(tpl.id.padEnd(20))} ${tpl.name}${badge}`);
      }

      console.log();
      console.log(chalk.dim('Use `okra templates show <id>` for details'));
      console.log();
    });

  return templates;
}
