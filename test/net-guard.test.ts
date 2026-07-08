/**
 * Proof tests for the no-cloud net guard (DESIGN.md #6). The global setup
 * (test/net-guard.ts) installs an undici MockAgent with disableNetConnect() as the
 * global dispatcher backing Node's `fetch`. These tests prove:
 *
 *   (a) the guard actually TRIPS — a request to a non-intercepted host (above all
 *       *.okrapdf.com) is rejected, not silently allowed; and
 *   (b) a full `okra parse` run contacts ONLY the chosen provider host: it succeeds
 *       with the provider intercept consumed and NO okrapdf.com intercept registered,
 *       so any cloud request would have thrown.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockAgent, getGlobalDispatcher } from 'undici';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runParse } from '../src/commands/parse.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/two-page.pdf', import.meta.url));
const PROVIDER_ORIGIN = 'https://fake-vlm.test';
const CANNED = '<div data-bbox="[10,20,30,40]" data-label="Text">hello world</div>';

const agent = () => getGlobalDispatcher() as MockAgent;
// No ambient credentials: force env + config empty so resolution is deterministic.
const noCreds = { env: {} as NodeJS.ProcessEnv, getProviderConfig: () => ({}) };

describe('net guard — seeded regression (the guard trips)', () => {
  it('rejects a fetch to api.okrapdf.com (non-intercepted host, disableNetConnect)', async () => {
    // Nothing is intercepted for this host → undici must refuse the connection.
    await expect(fetch('https://api.okrapdf.com/anything')).rejects.toThrow();
  });

  it('the rejection is the guard, not a real network error', async () => {
    const err = await fetch('https://api.okrapdf.com/v1/documents').then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    // fetch wraps the real reason as `cause`: undici's MockNotMatchedError, which names
    // the unmatched dispatch / disabled net connect (proving it's the guard, not DNS).
    const cause = (err as { cause?: Error }).cause;
    expect(String(cause?.message ?? err?.message)).toMatch(/not matched|connect|disabled|mock/i);
  });
});

describe('net guard — full okra parse touches ONLY the provider host', () => {
  let outDir: string;
  beforeEach(() => {
    outDir = mkdtempSync(join(tmpdir(), 'okra-netguard-'));
  });
  afterEach(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  it('parses 2 pages via the fake provider, with zero okrapdf.com requests', async () => {
    // Register ONLY the fake provider intercept (once per page). Deliberately register
    // NO okrapdf.com intercept: any cloud request during the run would throw here.
    agent()
      .get(PROVIDER_ORIGIN)
      .intercept({ path: '/v1/chat/completions', method: 'POST' })
      .reply(200, {
        choices: [{ message: { content: CANNED } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      })
      .times(2);

    const { envelope } = await runParse(
      FIXTURE,
      {
        provider: 'openai-compatible',
        model: 'test-model',
        apiKey: 'sk-test',
        baseUrl: `${PROVIDER_ORIGIN}/v1`,
        dpi: '72',
        out: outDir,
      },
      noCreds,
    );

    expect(envelope.meta.pageCount).toBe(2);
    expect(existsSync(join(outDir, 'doc.md'))).toBe(true);

    // The 2 provider intercepts were consumed exactly — nothing left dangling, and
    // (since no other host was intercepted) nothing else could have been contacted.
    expect(agent().pendingInterceptors()).toHaveLength(0);
    expect(() => agent().assertNoPendingInterceptors()).not.toThrow();
  });
});
