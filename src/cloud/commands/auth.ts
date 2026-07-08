/**
 * okra-cloud auth — flattened onto the `okra cloud` command as
 * `okra cloud login | logout | whoami | token | status`. This is the OPT-IN okra
 * account login (OKRA_API_KEY), entirely separate from the top-level BYOK
 * `okra auth login <provider>` (model-provider keys). Core parsing never uses it.
 */

import { Command } from 'commander';
import enquirer from 'enquirer';
const { prompt } = enquirer;
import chalk from 'chalk';
import { getConfigPath, isJsonOutput } from '../../lib/config.js';
import {
  getApiKey,
  setApiKey,
  clearApiKey,
  isAuthenticated,
  getBaseUrl,
} from '../lib/okra-config.js';
import { get, OkraApiError } from '../lib/client.js';
import { success, error, info, formatOutput } from '../../lib/output.js';
import type { UserInfo } from '../../types.js';

/**
 * Register the okra-cloud auth verbs directly on the `cloud` command, so they read
 * as `okra cloud login` etc. (not `okra cloud auth login`).
 */
export function addCloudAuthCommands(cloud: Command): void {
  // okra cloud login
  cloud
    .command('login')
    .description('Authenticate with your okraPDF account (OKRA_API_KEY)')
    .option('-k, --key <key>', 'API key (or set OKRA_API_KEY env var)')
    .action(async (options) => {
      try {
        let apiKey = options.key;

        if (!apiKey) {
          // Interactive prompt
          console.log(chalk.bold('\nokraPDF cloud login\n'));
          console.log('Get your API key from: ' + chalk.cyan('https://okrapdf.com/settings/api-keys'));
          console.log();

          const response = await prompt<{ key: string }>({
            type: 'password',
            name: 'key',
            message: 'Enter your API key:',
            validate: (value) => {
              if (!value) return 'API key is required';
              if (!value.startsWith('okra_')) return 'API key should start with "okra_"';
              return true;
            },
          });

          apiKey = response.key;
        }

        // Validate the key by making a test request
        const tempKey = getApiKey();
        setApiKey(apiKey);

        try {
          const user = await get<UserInfo>('api/auth/me');
          if (isJsonOutput()) {
            console.log(formatOutput({ success: true, user, config_path: getConfigPath() }, 'json'));
          } else {
            success(`Authenticated as ${chalk.bold(user.email)}`);
            info(`Config saved to: ${getConfigPath()}`);
          }
        } catch (err) {
          // Restore previous key if validation failed
          if (tempKey) {
            setApiKey(tempKey);
          } else {
            clearApiKey();
          }

          if (err instanceof OkraApiError && err.statusCode === 401) {
            error('Invalid API key');
            process.exit(3);
          }
          throw err;
        }
      } catch (err) {
        if (err instanceof Error && err.message.includes('cancelled')) {
          console.log('\nLogin cancelled');
          process.exit(0);
        }
        throw err;
      }
    });

  // okra cloud logout
  cloud
    .command('logout')
    .description('Remove stored okraPDF cloud credentials')
    .action(() => {
      if (!isAuthenticated()) {
        if (isJsonOutput()) {
          console.log(formatOutput({ success: true, message: 'Not logged in' }, 'json'));
        } else {
          info('Not logged in');
        }
        return;
      }

      clearApiKey();
      if (isJsonOutput()) {
        console.log(formatOutput({ success: true, message: 'Logged out successfully' }, 'json'));
      } else {
        success('Logged out successfully');
      }
    });

  // okra cloud whoami
  cloud
    .command('whoami')
    .description('Show the current authenticated okraPDF cloud user')
    .option('-o, --output <format>', 'Output format (table, json)', 'table')
    .action(async (options) => {
      if (!isAuthenticated()) {
        if (options.output === 'json' || isJsonOutput()) {
          console.log(formatOutput({ error: 'Not logged in' }, 'json'));
        } else {
          error('Not logged in. Run `okra cloud login` first.');
        }
        process.exit(3);
      }

      try {
        const user = await get<UserInfo>('api/auth/me');
        if (options.output === 'json' || isJsonOutput()) {
          console.log(formatOutput({ ...user, api_url: getBaseUrl() }, 'json'));
        } else {
          console.log(chalk.bold('Email:'), user.email);
          if (user.name) {
            console.log(chalk.bold('Name:'), user.name);
          }
          console.log(chalk.bold('User ID:'), user.id);
          console.log(chalk.bold('API URL:'), getBaseUrl());
        }
      } catch (err) {
        if (err instanceof OkraApiError && err.statusCode === 401) {
          if (options.output === 'json' || isJsonOutput()) {
            console.log(formatOutput({ error: 'Session expired' }, 'json'));
          } else {
            error('Session expired. Run `okra cloud login` again.');
          }
          process.exit(3);
        }
        throw err;
      }
    });

  // okra cloud token
  cloud
    .command('token')
    .description('Print the current okraPDF cloud API token (for piping)')
    .action(() => {
      const key = getApiKey();
      if (!key) {
        process.stderr.write('Not logged in\n');
        process.exit(3);
      }
      // Print only the token for easy piping
      process.stdout.write(key);
    });

  // okra cloud status
  cloud
    .command('status')
    .description('Check okraPDF cloud authentication status')
    .option('-o, --output <format>', 'Output format (table, json)', 'table')
    .action(async (options) => {
      const key = getApiKey();
      const useJson = options.output === 'json' || isJsonOutput();

      if (!key) {
        if (useJson) {
          console.log(formatOutput({ authenticated: false, message: 'Not authenticated' }, 'json'));
        } else {
          console.log(chalk.yellow('Status:'), 'Not authenticated');
          console.log(chalk.dim('Run `okra cloud login` to authenticate'));
        }
        return;
      }

      const maskedKey = key.substring(0, 12) + '...' + key.substring(key.length - 4);

      // Try to verify the key
      try {
        const user = await get<UserInfo>('api/auth/me');
        if (useJson) {
          console.log(formatOutput({
            authenticated: true,
            status: 'valid',
            api_key_masked: maskedKey,
            api_url: getBaseUrl(),
            config_path: getConfigPath(),
            user: { id: user.id, email: user.email, name: user.name },
          }, 'json'));
        } else {
          console.log(chalk.bold('API Key:'), maskedKey);
          console.log(chalk.bold('API URL:'), getBaseUrl());
          console.log(chalk.bold('Config:'), getConfigPath());
          console.log(chalk.green('Status:'), 'Authenticated');
          console.log(chalk.bold('User:'), user.email);
        }
      } catch (err) {
        if (err instanceof OkraApiError && err.statusCode === 401) {
          if (useJson) {
            console.log(formatOutput({
              authenticated: false,
              status: 'invalid',
              api_key_masked: maskedKey,
              api_url: getBaseUrl(),
              config_path: getConfigPath(),
              error: 'Invalid or expired key',
            }, 'json'));
          } else {
            console.log(chalk.bold('API Key:'), maskedKey);
            console.log(chalk.bold('API URL:'), getBaseUrl());
            console.log(chalk.bold('Config:'), getConfigPath());
            console.log(chalk.red('Status:'), 'Invalid or expired key');
          }
        } else {
          if (useJson) {
            console.log(formatOutput({
              authenticated: true,
              status: 'unknown',
              api_key_masked: maskedKey,
              api_url: getBaseUrl(),
              config_path: getConfigPath(),
              error: 'Unable to verify (network error)',
            }, 'json'));
          } else {
            console.log(chalk.bold('API Key:'), maskedKey);
            console.log(chalk.bold('API URL:'), getBaseUrl());
            console.log(chalk.bold('Config:'), getConfigPath());
            console.log(chalk.yellow('Status:'), 'Unable to verify (network error)');
          }
        }
      }
    });
}
