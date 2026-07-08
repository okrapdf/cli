/**
 * `okra cloud <cmd>` — the OPT-IN okra-cloud namespace. Everything under here talks
 * to okrapdf.com and needs an okraPDF account (OKRA_API_KEY). The core BYOK path
 * (`okra parse`) never imports anything from this directory — enforced by the
 * import-graph guard in src/arch.test.ts (nothing outside cloud/ imports cloud/,
 * except cli.ts's single registration import of this file).
 */

import { Command } from 'commander';
import { error } from '../lib/output.js';
import { getApiKey } from './lib/okra-config.js';
import { addCloudAuthCommands } from './commands/auth.js';
import { createDocsCommand } from './commands/docs.js';
import { createJobsCommand } from './commands/jobs.js';
import { createTablesCommand } from './commands/tables.js';
import { createEntitiesCommand } from './commands/entities.js';
import { createChatCommand } from './commands/chat.js';
import { createExtractCommand, createRunCommand } from './commands/shortcuts.js';
import { createProcessorsCommand } from './commands/processors.js';
import { createTemplatesCommand } from './commands/templates.js';
import { createLogsCommand } from './commands/logs.js';
import { createReviewCommand } from './commands/review.js';

/** Exit code used when `okra cloud` is invoked with no okra account configured. */
export const CLOUD_NO_ACCOUNT_EXIT = 3;

/**
 * The copy shown when `okra cloud` is run without an okraPDF account. Pure + exported
 * so it can be asserted directly. MUST name OKRA_API_KEY and state the surface is optional.
 */
export function cloudGateNotice(): string {
  return [
    'okra cloud is an optional connector to okrapdf.com — hosting, sharing and',
    'publishing that need an okraPDF account. Core parsing (`okra parse`) never uses it.',
    '',
    'No okra account credentials found. Set OKRA_API_KEY, or run `okra cloud login`.',
  ].join('\n');
}

/** True when an okra-cloud API key is available (env or config). Injectable for tests. */
export function cloudIsConfigured(hasKey: () => string | undefined = getApiKey): boolean {
  return !!hasKey();
}

/**
 * Build the `okra cloud` command with the flattened okra-account auth verbs
 * (login/logout/status/whoami/token) plus the legacy okra-cloud resource commands.
 */
export function createCloudCommand(): Command {
  const cloud = new Command('cloud')
    // `summary` shows in the ROOT command list (kept free of okrapdf.com / OKRA_API_KEY so
    // the BYOK root --help stays clean); the full `description` shows in `okra cloud --help`.
    .summary('Optional okraPDF cloud connector (account-gated; core `okra parse` never uses it)')
    .description(
      'okra cloud talks to okrapdf.com and is entirely optional. Hosting, sharing and ' +
        'publishing need an okraPDF account (OKRA_API_KEY). Core parsing (`okra parse`) never uses it.',
    );

  // Flattened okra-account auth: `okra cloud login`, `okra cloud status`, …
  addCloudAuthCommands(cloud);

  // Legacy okra-cloud resource + workflow commands (all require an okra account).
  cloud.addCommand(createDocsCommand());
  cloud.addCommand(createJobsCommand());
  cloud.addCommand(createTablesCommand());
  cloud.addCommand(createEntitiesCommand());
  cloud.addCommand(createReviewCommand());
  cloud.addCommand(createChatCommand());
  cloud.addCommand(createExtractCommand());
  cloud.addCommand(createRunCommand());
  cloud.addCommand(createProcessorsCommand());
  cloud.addCommand(createTemplatesCommand());
  cloud.addCommand(createLogsCommand());

  // OKRA_API_KEY is documented ONLY here (never in the BYOK root help).
  cloud.addHelpText(
    'after',
    `\nEnvironment:\n` +
      `  OKRA_API_KEY   okraPDF account API key (required for cloud commands)\n` +
      `  OKRA_BASE_URL  Custom base URL for a self-hosted okraPDF\n\n` +
      `The cloud connector is entirely optional. Core parsing (\`okra parse\`) is BYOK\n` +
      `and needs no okra account.`,
  );

  // Bare `okra cloud` (no subcommand): gate on the account so the optional/account-gated
  // nature is explicit. `okra cloud login` sets the key, so it is never blocked here.
  cloud.action(() => {
    if (!cloudIsConfigured()) {
      error(cloudGateNotice());
      process.exit(CLOUD_NO_ACCOUNT_EXIT);
    }
    cloud.outputHelp();
  });

  return cloud;
}
