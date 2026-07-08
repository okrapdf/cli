/**
 * BYOK provider/auth command logic — the pure, non-interactive surface (DESIGN.md #2).
 * Follows the jobs.test.ts / shortcuts.test.ts pattern: assert output shapes + error
 * exits, never drive enquirer/process.exit. Key values must NEVER be exposed (masked).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  maskKey,
  providerStatusRows,
  performAuthLogin,
  createProvidersCommand,
} from './providers.js';
import { PROVIDERS, getProvider } from '../providers/registry.js';

describe('maskKey', () => {
  it('shows only the last 4 chars behind ****', () => {
    expect(maskKey('gk_secret_abcd1234')).toBe('****1234');
  });
  it('never contains the original secret', () => {
    const secret = 'sk-supersecretvalue';
    expect(maskKey(secret)).not.toContain('supersecret');
  });
});

describe('providerStatusRows', () => {
  const emptyCfg = () => ({});

  it('has exactly one row per registry provider', () => {
    const rows = providerStatusRows({}, emptyCfg);
    expect(rows).toHaveLength(PROVIDERS.length);
    expect(rows.map((r) => r.id).sort()).toEqual(PROVIDERS.map((p) => p.id).sort());
  });

  it('reports env source with the matched env var name and a masked key', () => {
    const rows = providerStatusRows({ GEMINI_API_KEY: 'gk_live_1234' }, emptyCfg);
    const gemini = rows.find((r) => r.id === 'gemini')!;
    expect(gemini.configured).toBe(true);
    expect(gemini.source).toBe('env');
    expect(gemini.envVar).toBe('GEMINI_API_KEY');
    expect(gemini.maskedKey).toBe('****1234');
  });

  it('reports config source when no env key is set', () => {
    const rows = providerStatusRows({}, (id) =>
      id === 'nvidia' ? { apiKey: 'nv_abcd9999' } : {},
    );
    const nvidia = rows.find((r) => r.id === 'nvidia')!;
    expect(nvidia.configured).toBe(true);
    expect(nvidia.source).toBe('config');
    expect(nvidia.envVar).toBeNull();
    expect(nvidia.maskedKey).toBe('****9999');
  });

  it('reports "none" for an unconfigured provider', () => {
    const rows = providerStatusRows({}, emptyCfg);
    const openai = rows.find((r) => r.id === 'openai-compatible')!;
    expect(openai.configured).toBe(false);
    expect(openai.source).toBe('none');
    expect(openai.maskedKey).toBeNull();
  });

  it('prefers env over config for the same provider', () => {
    const rows = providerStatusRows({ GEMINI_API_KEY: 'env_key_0001' }, () => ({
      apiKey: 'cfg_key_0002',
    }));
    const gemini = rows.find((r) => r.id === 'gemini')!;
    expect(gemini.source).toBe('env');
    expect(gemini.maskedKey).toBe('****0001');
  });

  it('never leaks the raw key value anywhere in the rows', () => {
    const secret = 'gk_TOPSECRET_5678';
    const rows = providerStatusRows({ GEMINI_API_KEY: secret }, emptyCfg);
    expect(JSON.stringify(rows)).not.toContain('TOPSECRET');
  });
});

describe('performAuthLogin', () => {
  it('stores the key (+ base url) and returns a masked confirmation', () => {
    const setProviderConfig = vi.fn();
    const result = performAuthLogin('openai-compatible', 'sk_secret_4321', 'https://vllm.local/v1', {
      getProvider,
      setProviderConfig,
    });
    expect(setProviderConfig).toHaveBeenCalledWith('openai-compatible', {
      apiKey: 'sk_secret_4321',
      baseUrl: 'https://vllm.local/v1',
    });
    expect(result).toEqual({
      id: 'openai-compatible',
      displayName: getProvider('openai-compatible')!.displayName,
      maskedKey: '****4321',
      baseUrl: 'https://vllm.local/v1',
    });
  });

  it('omits base url when not provided', () => {
    const setProviderConfig = vi.fn();
    const result = performAuthLogin('gemini', 'gk_abcd0000', undefined, {
      getProvider,
      setProviderConfig,
    });
    expect(setProviderConfig).toHaveBeenCalledWith('gemini', { apiKey: 'gk_abcd0000' });
    expect(result.baseUrl).toBeUndefined();
    expect(result.maskedKey).toBe('****0000');
  });

  it('throws naming the valid providers on an unknown id (no store write)', () => {
    const setProviderConfig = vi.fn();
    expect(() =>
      performAuthLogin('claude', 'x', undefined, { getProvider, setProviderConfig }),
    ).toThrow(/Unknown provider 'claude'/);
    expect(() =>
      performAuthLogin('claude', 'x', undefined, { getProvider, setProviderConfig }),
    ).toThrow(/gemini/);
    expect(setProviderConfig).not.toHaveBeenCalled();
  });

  it('the returned confirmation never contains the raw key', () => {
    const result = performAuthLogin('gemini', 'gk_dontshowme_9090', undefined, {
      getProvider,
      setProviderConfig: vi.fn(),
    });
    expect(JSON.stringify(result)).not.toContain('dontshowme');
  });
});

// Regression lock: a `list` subcommand with its own `-o` was shadowed by the parent `-o`,
// so `okra providers list -o json` silently printed a table. Guard the JSON contract.
describe('createProvidersCommand -o json dispatch', () => {
  let logs: string[] = [];
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logs = [];
    spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(' '));
    });
    delete process.env.OKRA_OUTPUT_FORMAT;
  });
  afterEach(() => spy.mockRestore());

  const runArgs = async (...args: string[]): Promise<string> => {
    logs = [];
    await createProvidersCommand().parseAsync(['node', 'providers', ...args]);
    return logs.join('\n');
  };

  it('`providers list -o json` prints a JSON array (not a table)', async () => {
    const parsed = JSON.parse(await runArgs('list', '-o', 'json'));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(PROVIDERS.length);
  });

  it('`providers -o json` (alias, no subcommand) prints a JSON array', async () => {
    expect(Array.isArray(JSON.parse(await runArgs('-o', 'json')))).toBe(true);
  });

  it('`providers list` (no -o) prints a table, not JSON', async () => {
    const out = await runArgs('list');
    expect(() => JSON.parse(out)).toThrow();
  });
});
