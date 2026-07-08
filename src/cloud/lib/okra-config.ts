/**
 * okra-cloud credentials (opt-in). Owns the OKRA_API_KEY / base-URL config for the
 * `okra cloud` connector — deliberately kept OUT of the shared src/lib/config.ts so
 * the core BYOK path (`okra parse`) has zero knowledge of okrapdf.com.
 *
 * Persists onto the SAME on-disk store as the shared config via the exported
 * `configStore`, so `okra cloud login` and BYOK `okra auth login` coexist.
 */

import { configStore, getDefaultFormat } from '../../lib/config.js';
import type { CliConfig } from '../../types.js';

const DEFAULT_BASE_URL = 'https://okrapdf.com';

/** Get the okra-cloud API key from environment or config. */
export function getApiKey(): string | undefined {
  return process.env.OKRA_API_KEY || configStore.get('api_key');
}

/** Persist the okra-cloud API key. */
export function setApiKey(key: string): void {
  configStore.set('api_key', key);
}

/** Remove the stored okra-cloud API key. */
export function clearApiKey(): void {
  configStore.delete('api_key');
}

/** Get the okra-cloud base URL (env > stored > default okrapdf.com). */
export function getBaseUrl(): string {
  return process.env.OKRA_BASE_URL || configStore.get('base_url') || DEFAULT_BASE_URL;
}

/** Persist a custom okra-cloud base URL (self-hosted). */
export function setBaseUrl(url: string): void {
  configStore.set('base_url', url);
}

/** True when an okra-cloud API key is available. */
export function isAuthenticated(): boolean {
  return !!getApiKey();
}

/** Aggregate okra-cloud config snapshot. */
export function getConfig(): CliConfig {
  return {
    api_key: getApiKey(),
    base_url: getBaseUrl(),
    default_format: getDefaultFormat(),
  } as CliConfig;
}
