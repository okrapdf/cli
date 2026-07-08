/**
 * Provider config store — getProviderConfig / setProviderConfig under providers.<id>.
 * Isolated from the real user config via the OKRA_CONFIG_DIR override (Conf `cwd`),
 * following the vi.resetModules + dynamic-import pattern of config.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const originalEnv = process.env;
let dir: string;

describe('provider config store', () => {
  beforeEach(() => {
    vi.resetModules();
    dir = mkdtempSync(join(tmpdir(), 'okra-cfg-'));
    process.env = { ...originalEnv, OKRA_CONFIG_DIR: dir };
  });

  afterEach(() => {
    process.env = originalEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  it('isolates the store into OKRA_CONFIG_DIR (never the real user config)', async () => {
    const { getConfigPath } = await import('./config.js');
    expect(getConfigPath().startsWith(dir)).toBe(true);
  });

  it('returns {} for a provider with no stored config', async () => {
    const { getProviderConfig } = await import('./config.js');
    expect(getProviderConfig('gemini')).toEqual({});
  });

  it('stores and reads back an api key under providers.<id>', async () => {
    const { setProviderConfig, getProviderConfig } = await import('./config.js');
    setProviderConfig('gemini', { apiKey: 'gk_1' });
    expect(getProviderConfig('gemini')).toEqual({ apiKey: 'gk_1' });
  });

  it('stores base url alongside key and merges partial updates', async () => {
    const { setProviderConfig, getProviderConfig } = await import('./config.js');
    setProviderConfig('openai-compatible', { apiKey: 'sk_1', baseUrl: 'https://vllm.local/v1' });
    expect(getProviderConfig('openai-compatible')).toEqual({
      apiKey: 'sk_1',
      baseUrl: 'https://vllm.local/v1',
    });
    // partial update: change only the key; base url must persist
    setProviderConfig('openai-compatible', { apiKey: 'sk_2' });
    expect(getProviderConfig('openai-compatible')).toEqual({
      apiKey: 'sk_2',
      baseUrl: 'https://vllm.local/v1',
    });
  });

  it('keeps providers isolated from one another', async () => {
    const { setProviderConfig, getProviderConfig } = await import('./config.js');
    setProviderConfig('gemini', { apiKey: 'gk' });
    setProviderConfig('nvidia', { apiKey: 'nv' });
    expect(getProviderConfig('gemini')).toEqual({ apiKey: 'gk' });
    expect(getProviderConfig('nvidia')).toEqual({ apiKey: 'nv' });
  });

  it('persists with snake_case api_key / base_url under providers.<id> on disk', async () => {
    const { setProviderConfig, getConfigPath } = await import('./config.js');
    setProviderConfig('gemini', { apiKey: 'gk', baseUrl: 'https://x/v1' });
    const raw = JSON.parse(readFileSync(getConfigPath(), 'utf8'));
    expect(raw.providers.gemini).toEqual({ api_key: 'gk', base_url: 'https://x/v1' });
  });
});
