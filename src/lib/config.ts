/**
 * Configuration management for okraPDF CLI (shared, cloud-agnostic).
 *
 * Owns the on-disk config store (`conf`), dotenv loading, the default output
 * format, and the BYOK per-provider credential store (providers.<id>). The
 * okra-cloud credentials (OKRA_API_KEY / base URL) live in cloud/lib/okra-config.ts
 * — this module has no knowledge of okrapdf.com and the core `okra parse` path
 * never touches the cloud.
 *
 * Config priority (highest to lowest):
 * 1. Environment variables
 * 2. .env / .env.local in current directory
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
    default_format: DEFAULT_FORMAT,
  } as CliConfig,
});

/**
 * The shared on-disk config store. Exported so the opt-in cloud layer
 * (cloud/lib/okra-config.ts) can persist okra-cloud credentials on the SAME
 * store without this module importing anything cloud-specific.
 */
export const configStore = config;

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
 * Check if JSON output is requested (via --json flag or OKRA_OUTPUT_FORMAT=json)
 */
export function isJsonOutput(): boolean {
  return getDefaultFormat() === 'json';
}
