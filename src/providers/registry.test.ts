/**
 * resolveProvider — precedence (flag > env > config), per-provider resolution,
 * and user-facing error copy (DESIGN.md #2 TDD map).
 */
import { describe, it, expect } from 'vitest';
import { getProvider, resolveProvider, PROVIDERS } from './registry.js';
import type { ResolveInputs } from './types.js';

const spec = (id: string) => {
  const s = getProvider(id);
  if (!s) throw new Error(`test setup: no provider ${id}`);
  return s;
};

const inputs = (over: Partial<ResolveInputs> = {}): ResolveInputs => ({
  env: {},
  config: {},
  ...over,
});

describe('resolveProvider', () => {
  describe('key precedence: flag > env > config', () => {
    it('uses the flag key over env and config', () => {
      const r = resolveProvider(
        spec('gemini'),
        inputs({ flagKey: 'flag-key', env: { GEMINI_API_KEY: 'env-key' }, config: { apiKey: 'cfg-key' } }),
      );
      expect(r.apiKey).toBe('flag-key');
      expect(r.keySource).toBe('flag');
    });

    it('uses env over config when no flag', () => {
      const r = resolveProvider(
        spec('gemini'),
        inputs({ env: { GEMINI_API_KEY: 'env-key' }, config: { apiKey: 'cfg-key' } }),
      );
      expect(r.apiKey).toBe('env-key');
      expect(r.keySource).toBe('env');
    });

    it('falls back to config when neither flag nor env present', () => {
      const r = resolveProvider(spec('gemini'), inputs({ config: { apiKey: 'cfg-key' } }));
      expect(r.apiKey).toBe('cfg-key');
      expect(r.keySource).toBe('config');
    });
  });

  describe('env key order', () => {
    it('checks envKeys in declared order (GEMINI_API_KEY first)', () => {
      const r = resolveProvider(
        spec('gemini'),
        inputs({ env: { GEMINI_API_KEY: 'primary', GOOGLE_API_KEY: 'secondary' } }),
      );
      expect(r.apiKey).toBe('primary');
    });

    it('falls through to the second env key (GOOGLE_API_KEY)', () => {
      const r = resolveProvider(spec('gemini'), inputs({ env: { GOOGLE_API_KEY: 'secondary' } }));
      expect(r.apiKey).toBe('secondary');
      expect(r.keySource).toBe('env');
    });

    it('treats an empty-string env value as unset', () => {
      const r = resolveProvider(
        spec('gemini'),
        inputs({ env: { GEMINI_API_KEY: '', GOOGLE_API_KEY: 'secondary' } }),
      );
      expect(r.apiKey).toBe('secondary');
    });
  });

  describe('base URL resolution', () => {
    it('defaults to the spec base URL for gemini', () => {
      const r = resolveProvider(spec('gemini'), inputs({ env: { GEMINI_API_KEY: 'k' } }));
      expect(r.baseUrl).toBe('https://generativelanguage.googleapis.com');
    });

    it('config base URL overrides the spec default', () => {
      const r = resolveProvider(
        spec('gemini'),
        inputs({ env: { GEMINI_API_KEY: 'k' }, config: { baseUrl: 'https://proxy.example/v1' } }),
      );
      expect(r.baseUrl).toBe('https://proxy.example/v1');
    });

    it('flag base URL overrides env and config', () => {
      const r = resolveProvider(
        spec('openai-compatible'),
        inputs({
          flagBaseUrl: 'https://flag.example/v1',
          env: { OPENAI_API_KEY: 'k', OPENAI_BASE_URL: 'https://env.example/v1' },
          config: { baseUrl: 'https://cfg.example/v1' },
        }),
      );
      expect(r.baseUrl).toBe('https://flag.example/v1');
    });

    it('openai-compatible reads the base URL from OPENAI_BASE_URL env', () => {
      const r = resolveProvider(
        spec('openai-compatible'),
        inputs({ env: { OPENAI_API_KEY: 'k', OPENAI_BASE_URL: 'https://env.example/v1' } }),
      );
      expect(r.baseUrl).toBe('https://env.example/v1');
    });
  });

  describe('per-provider resolution', () => {
    it('nvidia resolves from NVIDIA_API_KEY with its default base URL', () => {
      const r = resolveProvider(spec('nvidia'), inputs({ env: { NVIDIA_API_KEY: 'nv' } }));
      expect(r.apiKey).toBe('nv');
      expect(r.baseUrl).toBe('https://integrate.api.nvidia.com/v1');
      expect(r.spec.api).toBe('openai-chat');
    });

    it('openrouter resolves from OPENROUTER_API_KEY with its default base URL', () => {
      const r = resolveProvider(spec('openrouter'), inputs({ env: { OPENROUTER_API_KEY: 'or' } }));
      expect(r.apiKey).toBe('or');
      expect(r.baseUrl).toBe('https://openrouter.ai/api/v1');
    });
  });

  describe('missing-key error copy', () => {
    it('names the first env var and the `okra auth login <id>` fix (gemini)', () => {
      expect(() => resolveProvider(spec('gemini'), inputs())).toThrow(/GEMINI_API_KEY/);
      expect(() => resolveProvider(spec('gemini'), inputs())).toThrow(/okra auth login gemini/);
    });

    it('names NVIDIA_API_KEY for nvidia', () => {
      expect(() => resolveProvider(spec('nvidia'), inputs())).toThrow(/NVIDIA_API_KEY/);
      expect(() => resolveProvider(spec('nvidia'), inputs())).toThrow(/okra auth login nvidia/);
    });
  });

  describe('openai-compatible missing base URL error copy', () => {
    it('names --base-url, OPENAI_BASE_URL, and `okra auth login openai-compatible`', () => {
      const run = () =>
        resolveProvider(spec('openai-compatible'), inputs({ env: { OPENAI_API_KEY: 'k' } }));
      expect(run).toThrow(/--base-url/);
      expect(run).toThrow(/OPENAI_BASE_URL/);
      expect(run).toThrow(/okra auth login openai-compatible/);
    });

    it('still reports the missing key first when neither key nor base URL is present', () => {
      expect(() => resolveProvider(spec('openai-compatible'), inputs())).toThrow(/OPENAI_API_KEY/);
    });
  });

  it('every registry provider has a first env key named in its missing-key error', () => {
    for (const s of PROVIDERS) {
      expect(() => resolveProvider(s, inputs())).toThrow(new RegExp(s.envKeys[0]));
    }
  });
});
