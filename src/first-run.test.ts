/**
 * Zero-account first run (DESIGN.md #5): with ONLY a BYOK provider key and an empty
 * okra config, `okra parse` must work end-to-end with no okra-account prompt or error,
 * the root help must be BYOK-first (no OKRA_API_KEY, no okrapdf.com), and `okra cloud`
 * without an account must fail with copy that names OKRA_API_KEY and says it is optional.
 *
 * Reuses the runParse + MockAgent idiom from commands/parse.test.ts. All network is
 * trapped by the global net-guard (undici MockAgent, disableNetConnect).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MockAgent, getGlobalDispatcher } from 'undici';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runParse } from './commands/parse.js';
import { createProgram } from './cli.js';
import { cloudGateNotice, cloudIsConfigured } from './cloud/index.js';

const FIXTURE = fileURLToPath(new URL('../test/fixtures/two-page.pdf', import.meta.url));
const GEMINI_ORIGIN = 'https://generativelanguage.googleapis.com';
const CANNED = '<div data-bbox="[10,20,30,40]" data-label="Text">hello world</div>';

const agent = () => getGlobalDispatcher() as MockAgent;

function interceptGemini(): void {
  agent()
    .get(GEMINI_ORIGIN)
    .intercept({ path: '/v1beta/models/gemini-3-flash:generateContent', method: 'POST' })
    .reply(200, {
      candidates: [{ content: { parts: [{ text: CANNED }] } }],
      usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 20 },
    })
    .persist();
}

let outDir: string;
beforeEach(() => {
  outDir = mkdtempSync(join(tmpdir(), 'okra-firstrun-'));
});
afterEach(() => {
  rmSync(outDir, { recursive: true, force: true });
});

describe('zero-account first run — okra parse (BYOK, only GEMINI_API_KEY)', () => {
  it('resolves + parses with ONLY GEMINI_API_KEY and an empty config — no okra prompt/error', async () => {
    interceptGemini();
    // Env allowlist: exactly one BYOK key, nothing okra. Empty config store.
    const deps = {
      env: { GEMINI_API_KEY: 'gk-test' } as NodeJS.ProcessEnv,
      getProviderConfig: () => ({}),
    };

    const { envelope } = await runParse(
      FIXTURE,
      { provider: 'gemini', model: 'gemini-3-flash', dpi: '72', out: outDir },
      deps,
    );

    // Reached the transport (mocked) and wrote artifacts → no okra-key gate on the core path.
    expect(envelope.meta.providerId).toBe('gemini');
    expect(envelope.meta.pageCount).toBe(2);
    expect(existsSync(join(outDir, 'doc.md'))).toBe(true);
    expect(existsSync(join(outDir, 'blocks.json'))).toBe(true);
    expect(existsSync(join(outDir, 'manifest.json'))).toBe(true);
  });

  it('missing provider key error names the provider env var, NEVER OKRA_API_KEY / "okra API key"', async () => {
    let err: Error | undefined;
    try {
      await runParse(
        FIXTURE,
        { provider: 'gemini', dpi: '72', out: outDir },
        { env: {} as NodeJS.ProcessEnv, getProviderConfig: () => ({}) },
      );
    } catch (e) {
      err = e as Error;
    }

    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toMatch(/GEMINI_API_KEY/);
    // Core-verb errors must never leak okra-account vocabulary.
    expect(err!.message).not.toContain('OKRA_API_KEY');
    expect(err!.message).not.toContain('okra API key');
  });
});

describe('zero-account first run — root help is BYOK-first', () => {
  it('root --help has no OKRA_API_KEY and no okrapdf.com, and documents the BYOK env vars', () => {
    const program = createProgram();
    let help = '';
    program.configureOutput({ writeOut: (s) => (help += s), writeErr: (s) => (help += s) });
    program.outputHelp();

    // The two forbidden strings (OKRA_API_KEY is documented ONLY under `okra cloud --help`).
    expect(help).not.toContain('OKRA_API_KEY (required)');
    expect(help).not.toContain('OKRA_API_KEY');
    expect(help).not.toContain('okrapdf.com');

    // BYOK provider env vars ARE documented at the root.
    expect(help).toContain('GEMINI_API_KEY');
    expect(help).toContain('NVIDIA_API_KEY');
    expect(help).toContain('OPENROUTER_API_KEY');
    expect(help).toContain('OPENAI_BASE_URL');
    expect(help).toContain('OPENAI_API_KEY');
    // and the core verb is present
    expect(help).toContain('parse');
  });
});

describe('zero-account first run — `okra cloud` is optional + account-gated', () => {
  it('the gate copy names OKRA_API_KEY and says the surface is optional', () => {
    const notice = cloudGateNotice();
    expect(notice).toContain('OKRA_API_KEY');
    expect(notice.toLowerCase()).toContain('optional');
  });

  it('cloudIsConfigured reflects the presence of an okra key', () => {
    expect(cloudIsConfigured(() => undefined)).toBe(false);
    expect(cloudIsConfigured(() => 'okra_live_123')).toBe(true);
  });

  it('bare `okra cloud` with no account errors (exit 3) with copy naming OKRA_API_KEY + optional', async () => {
    // Isolate the config store into an empty temp dir + ensure no ambient okra key,
    // then dynamically import the cloud command so it reads the fresh (empty) store.
    vi.resetModules();
    const dir = mkdtempSync(join(tmpdir(), 'okra-noacct-'));
    const prevEnv = process.env;
    process.env = { ...prevEnv, OKRA_CONFIG_DIR: dir };
    delete process.env.OKRA_API_KEY;

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const { createCloudCommand } = await import('./cloud/index.js');
      await expect(createCloudCommand().parseAsync(['node', 'cloud'])).rejects.toThrow('EXIT:3');

      const printed = errSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
      expect(printed).toContain('OKRA_API_KEY');
      expect(printed.toLowerCase()).toContain('optional');
    } finally {
      exitSpy.mockRestore();
      errSpy.mockRestore();
      process.env = prevEnv;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
