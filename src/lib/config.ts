/**
 * Configuration management for OkraPDF CLI
 * 
 * Config priority (highest to lowest):
 * 1. Environment variables (OKRA_API_KEY, OKRA_BASE_URL)
 * 2. .env file in current directory
 * 3. .okra file in current directory
 * 4. ~/.okra file in home directory
 * 5. Config store (~/.config/okrapdf/config.json)
 */

import Conf from 'conf';
import { config as dotenvConfig } from 'dotenv';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type {
  CliConfig,
  OutputFormat,
  OcrEngine,
  VlmModel,
  ProviderConfigEntry,
} from '../types.js';

const DEFAULT_BASE_URL = 'https://okrapdf.com';
const DEFAULT_FORMAT: OutputFormat = 'table';

// Load .env files in priority order (first found wins via dotenv behavior)
// Mirrors Next.js convention: .env.local for secrets, .env for defaults
const envFiles = [
  join(process.cwd(), '.env.local'),
  join(process.cwd(), '.env'),
  join(process.cwd(), '.okra'),
  join(homedir(), '.okra'),
];

for (const envFile of envFiles) {
  if (existsSync(envFile)) {
    // quiet: true — dotenv v17 otherwise prints promotional "tips" to STDOUT at load,
    // which corrupts every `-o json` command's machine-readable output.
    dotenvConfig({ path: envFile, quiet: true });
  }
}

// Create config store. OKRA_CONFIG_DIR overrides the storage directory (Conf `cwd`) —
// used by tests to isolate from the real user config; harmless in production if unset.
const config = new Conf<CliConfig>({
  projectName: 'okrapdf',
  ...(process.env.OKRA_CONFIG_DIR ? { cwd: process.env.OKRA_CONFIG_DIR } : {}),
  defaults: {
    base_url: DEFAULT_BASE_URL,
    default_format: DEFAULT_FORMAT,
  },
});

/**
 * Get the API key from environment or config
 */
export function getApiKey(): string | undefined {
  return process.env.OKRA_API_KEY || config.get('api_key');
}

/**
 * Set the API key in config
 */
export function setApiKey(key: string): void {
  config.set('api_key', key);
}

/**
 * Remove the API key from config
 */
export function clearApiKey(): void {
  config.delete('api_key');
}

/**
 * Get the base URL from environment or config
 */
export function getBaseUrl(): string {
  return process.env.OKRA_BASE_URL || config.get('base_url') || DEFAULT_BASE_URL;
}

/**
 * Set the base URL in config
 */
export function setBaseUrl(url: string): void {
  config.set('base_url', url);
}

/**
 * Get the default output format
 */
export function getDefaultFormat(): OutputFormat {
  const envFormat = process.env.OKRA_OUTPUT_FORMAT as OutputFormat | undefined;
  return envFormat || config.get('default_format') || DEFAULT_FORMAT;
}

/**
 * Set the default output format
 */
export function setDefaultFormat(format: OutputFormat): void {
  config.set('default_format', format);
}

export function getDefaultOcr(): OcrEngine | undefined {
  const envOcr = process.env.OKRA_OCR as OcrEngine | undefined;
  return envOcr || config.get('default_ocr');
}

export function setDefaultOcr(ocr: OcrEngine): void {
  config.set('default_ocr', ocr);
}

export function getDefaultVlm(): VlmModel | undefined {
  const envVlm = process.env.OKRA_VLM;
  return envVlm || config.get('default_vlm');
}

export function setDefaultVlm(vlm: VlmModel): void {
  config.set('default_vlm', vlm);
}

/**
 * Get a BYOK provider's stored config (api key + base URL), keyed by provider id.
 * Stored under `providers.<id>` with snake_case keys; returns {} when absent.
 */
export function getProviderConfig(id: string): { apiKey?: string; baseUrl?: string } {
  const providers = config.get('providers') as Record<string, ProviderConfigEntry> | undefined;
  const entry = providers?.[id];
  if (!entry) return {};
  const out: { apiKey?: string; baseUrl?: string } = {};
  if (entry.api_key !== undefined) out.apiKey = entry.api_key;
  if (entry.base_url !== undefined) out.baseUrl = entry.base_url;
  return out;
}

/**
 * Merge a BYOK provider's api key / base URL into `providers.<id>`.
 * Only the fields provided are updated (partial merge); others persist.
 */
export function setProviderConfig(
  id: string,
  { apiKey, baseUrl }: { apiKey?: string; baseUrl?: string },
): void {
  const providers = { ...(config.get('providers') as Record<string, ProviderConfigEntry> | undefined) };
  const entry: ProviderConfigEntry = { ...(providers[id] ?? {}) };
  if (apiKey !== undefined) entry.api_key = apiKey;
  if (baseUrl !== undefined) entry.base_url = baseUrl;
  providers[id] = entry;
  config.set('providers', providers);
}

/**
 * Get all config values
 */
export function getConfig(): CliConfig {
  return {
    api_key: getApiKey(),
    base_url: getBaseUrl(),
    default_format: getDefaultFormat(),
    default_ocr: getDefaultOcr(),
    default_vlm: getDefaultVlm(),
  };
}

/**
 * Get the config file path
 */
export function getConfigPath(): string {
  return config.path;
}

/**
 * Reset config to defaults
 */
export function resetConfig(): void {
  config.clear();
}

/**
 * Check if authenticated
 */
export function isAuthenticated(): boolean {
  return !!getApiKey();
}

/**
 * Check if JSON output is requested (via --json flag or OKRA_OUTPUT_FORMAT=json)
 */
export function isJsonOutput(): boolean {
  return getDefaultFormat() === 'json';
}
