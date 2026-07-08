/**
 * BYOK provider commands — `okra providers` (list) and `okra auth` (login/status).
 * Replaces the old OpenRouter-only providers/vlm commands. Commands do the wiring
 * (dependency rule 5): they read the registry + config store, never a transport.
 *
 * Key values are NEVER printed — only ever a `****last4` mask.
 */

import { Command } from 'commander';
import enquirer from 'enquirer';
import { formatOutput, success, error, info } from '../lib/output.js';
import {
  getDefaultFormat,
  isJsonOutput,
  getProviderConfig,
  setProviderConfig,
  getConfigPath,
} from '../lib/config.js';
import { PROVIDERS, getProvider } from '../providers/registry.js';
import type { ProviderApi, ProviderSpec } from '../providers/types.js';

const { prompt } = enquirer;

// ---------------------------------------------------------------------------
// Pure, testable logic
// ---------------------------------------------------------------------------

/** Mask a secret to `****` + its last 4 chars. Never reveals the full key. */
export function maskKey(key: string): string {
  return `****${key.slice(-4)}`;
}

export interface ProviderStatusRow {
  id: string;
  displayName: string;
  api: ProviderApi;
  defaultModel: string;
  keyHint: string;
  configured: boolean;
  source: 'env' | 'config' | 'none';
  /** Which env var provided the key (when source === 'env'), else null. */
  envVar: string | null;
  /** `****last4`, or null when not configured. Never the raw key. */
  maskedKey: string | null;
}

function baseRow(spec: ProviderSpec) {
  return {
    id: spec.id,
    displayName: spec.displayName,
    api: spec.api,
    defaultModel: spec.defaultModel,
    keyHint: spec.keyHint,
  };
}

/**
 * Per-provider configured status, mirroring resolution precedence (env > config) for
 * where the key came from. Injectable env + config getter for tests.
 */
export function providerStatusRows(
  env: NodeJS.ProcessEnv = process.env,
  getCfg: (id: string) => { apiKey?: string; baseUrl?: string } = getProviderConfig,
): ProviderStatusRow[] {
  return PROVIDERS.map((spec) => {
    for (const envKey of spec.envKeys) {
      const v = env[envKey];
      if (v) {
        return {
          ...baseRow(spec),
          configured: true,
          source: 'env' as const,
          envVar: envKey,
          maskedKey: maskKey(v),
        };
      }
    }
    const cfg = getCfg(spec.id);
    if (cfg.apiKey) {
      return {
        ...baseRow(spec),
        configured: true,
        source: 'config' as const,
        envVar: null,
        maskedKey: maskKey(cfg.apiKey),
      };
    }
    return {
      ...baseRow(spec),
      configured: false,
      source: 'none' as const,
      envVar: null,
      maskedKey: null,
    };
  });
}

export interface AuthLoginResult {
  id: string;
  displayName: string;
  maskedKey: string;
  baseUrl?: string;
}

export interface AuthLoginDeps {
  getProvider: (id: string) => ProviderSpec | undefined;
  setProviderConfig: (id: string, v: { apiKey?: string; baseUrl?: string }) => void;
}

/**
 * Validate the provider id, persist the key (+ optional base URL) to the config store,
 * and return a masked confirmation. Throws (naming the valid ids) on an unknown provider.
 */
export function performAuthLogin(
  providerId: string,
  key: string,
  baseUrl: string | undefined,
  deps: AuthLoginDeps = { getProvider, setProviderConfig },
): AuthLoginResult {
  const spec = deps.getProvider(providerId);
  if (!spec) {
    throw new Error(
      `Unknown provider '${providerId}'. Valid providers: ${PROVIDERS.map((p) => p.id).join(', ')}. ` +
        `Run \`okra providers list\`.`,
    );
  }
  deps.setProviderConfig(spec.id, { apiKey: key, ...(baseUrl ? { baseUrl } : {}) });
  return {
    id: spec.id,
    displayName: spec.displayName,
    maskedKey: maskKey(key),
    ...(baseUrl ? { baseUrl } : {}),
  };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function printProviders(useJson: boolean): void {
  const rows = providerStatusRows();
  if (useJson) {
    console.log(formatOutput(rows, 'json'));
    return;
  }
  const tableRows = rows.map((r) => ({
    provider: r.id,
    name: r.displayName,
    status: r.configured
      ? `${r.source}${r.envVar ? ` (${r.envVar})` : ''} ${r.maskedKey}`
      : 'not configured',
    model: r.defaultModel || '-',
    hint: r.keyHint,
  }));
  console.log(formatOutput(tableRows, 'table'));
}

export function createProvidersCommand(): Command {
  // `list` is an optional positional rather than a subcommand: a subcommand with its own
  // `-o` would be shadowed by a parent `-o` of the same name (commander binds the flag to
  // the parent), silently ignoring `okra providers list -o json`. One command, one `-o`.
  return new Command('providers')
    .description('List BYOK model providers and their configured status')
    .argument('[action]', "'list' (default)", 'list')
    .option('-o, --output <format>', 'Output format (table, json)', getDefaultFormat())
    .action((action: string, options: { output?: string }) => {
      if (action && action !== 'list') {
        error(`Unknown subcommand '${action}'. Try \`okra providers\` or \`okra providers list\`.`);
        process.exit(2);
      }
      printProviders(options.output === 'json' || isJsonOutput());
    });
}

export function createAuthCommand(): Command {
  const auth = new Command('auth').description('Manage BYOK model-provider credentials');

  auth
    .command('login')
    .description('Store an API key for a model provider (bring your own key)')
    .argument('<provider>', `Provider id: ${PROVIDERS.map((p) => p.id).join(' | ')}`)
    .option('-k, --key <key>', 'API key (prompted securely if omitted)')
    .option('--base-url <url>', 'Base URL (required for openai-compatible endpoints)')
    .action(async (providerId: string, options: { key?: string; baseUrl?: string }) => {
      const spec = getProvider(providerId);
      if (!spec) {
        error(
          `Unknown provider '${providerId}'. Valid: ${PROVIDERS.map((p) => p.id).join(', ')}`,
        );
        process.exit(2);
      }

      let key = options.key;
      if (!key) {
        const resp = await prompt<{ key: string }>({
          type: 'password',
          name: 'key',
          message: `Enter the API key for ${spec.displayName}:`,
          validate: (v) => (v ? true : 'API key is required'),
        });
        key = resp.key;
      }

      const result = performAuthLogin(spec.id, key, options.baseUrl);
      if (isJsonOutput()) {
        console.log(formatOutput({ success: true, ...result }, 'json'));
      } else {
        success(`Saved ${result.displayName} key (${result.maskedKey})`);
        if (result.baseUrl) info(`Base URL: ${result.baseUrl}`);
        info(`Stored in ${getConfigPath()}`);
      }
    });

  auth
    .command('status')
    .description('Show configured providers and where each key comes from')
    .option('-o, --output <format>', 'Output format (table, json)', getDefaultFormat())
    .action((options: { output?: string }) => {
      const rows = providerStatusRows();
      if (options.output === 'json' || isJsonOutput()) {
        console.log(formatOutput(rows, 'json'));
        return;
      }
      const tableRows = rows.map((r) => ({
        provider: r.id,
        configured: r.configured,
        source: r.source,
        key: r.maskedKey ?? '-',
      }));
      console.log(formatOutput(tableRows, 'table'));
    });

  return auth;
}
