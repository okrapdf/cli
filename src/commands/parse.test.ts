/**
 * `okra parse` end-to-end (DESIGN.md #4): real rasterize of the 2-page fixture +
 * an openai-compatible provider pointed at a MockAgent-intercepted fake base URL.
 * Asserts the three written artifacts, the JSON envelope, the -o json stdout
 * contract (NO markdown dump), and the exit codes for the four failure modes.
 * All network is trapped by the global net-guard MockAgent.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MockAgent, getGlobalDispatcher } from 'undici';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runParse, createParseCommand, PARSE_EXIT } from './parse.js';

const FIXTURE = fileURLToPath(new URL('../../test/fixtures/two-page.pdf', import.meta.url));
const ORIGIN = 'https://fake-vlm.test';
const BASE = `${ORIGIN}/v1`;
const CANNED = '<div data-bbox="[10,20,30,40]" data-label="Text">hello world</div>';

const agent = () => getGlobalDispatcher() as MockAgent;

function interceptChat(): void {
  agent()
    .get(ORIGIN)
    .intercept({ path: '/v1/chat/completions', method: 'POST' })
    .reply(200, {
      choices: [{ message: { content: CANNED } }],
      usage: { prompt_tokens: 100, completion_tokens: 40 },
    })
    .persist();
}

let outDir: string;
beforeEach(() => {
  outDir = mkdtempSync(join(tmpdir(), 'okra-parse-'));
});
afterEach(() => {
  rmSync(outDir, { recursive: true, force: true });
});

// No ambient credentials: force env + config empty so resolution is deterministic.
const noCreds = { env: {} as NodeJS.ProcessEnv, getProviderConfig: () => ({}) };
const okOpts = () => ({
  provider: 'openai-compatible',
  model: 'test-model',
  apiKey: 'sk-test',
  baseUrl: BASE,
  dpi: '72',
  out: outDir,
});

describe('runParse — happy path (openai-compatible + mocked transport)', () => {
  it('writes doc.md, blocks.json and manifest.json with the decoded content', async () => {
    interceptChat();
    const { envelope, manifest } = await runParse(FIXTURE, okOpts(), noCreds);

    expect(existsSync(join(outDir, 'doc.md'))).toBe(true);
    expect(existsSync(join(outDir, 'blocks.json'))).toBe(true);
    expect(existsSync(join(outDir, 'manifest.json'))).toBe(true);

    // doc.md = per-page markdown joined by blank lines (one block per page)
    expect(readFileSync(join(outDir, 'doc.md'), 'utf8')).toBe('hello world\n\nhello world');

    // blocks.json parses to all blocks, in (page, reading-order) order
    const blocks = JSON.parse(readFileSync(join(outDir, 'blocks.json'), 'utf8'));
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ label: 'Text', bbox: [10, 20, 30, 40], text: 'hello world', page: 1 });
    expect(blocks[1].page).toBe(2);

    // manifest = meta + per-page {page, blockCount, usage}
    const m = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8'));
    expect(m.meta.pageCount).toBe(2);
    expect(m.pages).toEqual([
      { page: 1, blockCount: 1, usage: { inputTokens: 100, outputTokens: 40, thinkingTokens: 0 } },
      { page: 2, blockCount: 1, usage: { inputTokens: 100, outputTokens: 40, thinkingTokens: 0 } },
    ]);

    // envelope shape
    expect(envelope.pages).toEqual([
      { page: 1, blockCount: 1 },
      { page: 2, blockCount: 1 },
    ]);
    expect(envelope.outDir).toBe(outDir);
    expect(envelope.meta.model).toBe('test-model');
    expect(envelope.meta.providerId).toBe('openai-compatible');
    // usage summed across pages
    expect(manifest.meta).toBe(envelope.meta);
  });

  it('omits costUsd from the manifest for an unpriced model (never 0)', async () => {
    interceptChat();
    await runParse(FIXTURE, okOpts(), noCreds);
    const m = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8'));
    expect('costUsd' in m.meta).toBe(false);
  });

  it('honors --pages to restrict which pages are parsed', async () => {
    interceptChat();
    const { envelope } = await runParse(FIXTURE, { ...okOpts(), pages: '2-2' }, noCreds);
    expect(envelope.pages).toEqual([{ page: 2, blockCount: 1 }]);
    expect(envelope.meta.pageCount).toBe(1);
  });
});

describe('runParse — failure modes + exit codes', () => {
  it('missing file → INVALID_ARGS', async () => {
    await expect(runParse('/no/such/file.pdf', okOpts(), noCreds)).rejects.toMatchObject({
      exitCode: PARSE_EXIT.INVALID_ARGS,
      message: expect.stringMatching(/File not found/),
    });
  });

  it('unknown provider → INVALID_ARGS', async () => {
    await expect(runParse(FIXTURE, { ...okOpts(), provider: 'claude' }, noCreds)).rejects.toMatchObject({
      exitCode: PARSE_EXIT.INVALID_ARGS,
      message: expect.stringMatching(/Unknown provider 'claude'/),
    });
  });

  it('unknown parser → INVALID_ARGS', async () => {
    await expect(runParse(FIXTURE, { ...okOpts(), parser: 'docling' }, noCreds)).rejects.toMatchObject({
      exitCode: PARSE_EXIT.INVALID_ARGS,
      message: expect.stringMatching(/Unknown parser 'docling'/),
    });
  });

  it('missing key → ERROR, naming the env var and `okra auth login`', async () => {
    await expect(
      runParse(FIXTURE, { provider: 'gemini', dpi: '72', out: outDir }, noCreds),
    ).rejects.toMatchObject({
      exitCode: PARSE_EXIT.ERROR,
      message: expect.stringMatching(/GEMINI_API_KEY/),
    });
  });

  it('rejects a malformed --pages with INVALID_ARGS', async () => {
    await expect(runParse(FIXTURE, { ...okOpts(), pages: 'abc' }, noCreds)).rejects.toMatchObject({
      exitCode: PARSE_EXIT.INVALID_ARGS,
    });
  });

  // #16 — arg-shape validation runs BEFORE key resolution, so a bad flag fails with
  // INVALID_ARGS (exit 2) even when no provider key is present (which would be exit 1).
  it('validates --pages shape before key resolution (bad pages + no key → INVALID_ARGS, not missing-key)', async () => {
    await expect(
      runParse(FIXTURE, { provider: 'gemini', pages: 'x-y', out: outDir }, noCreds),
    ).rejects.toMatchObject({
      exitCode: PARSE_EXIT.INVALID_ARGS,
      message: expect.stringMatching(/--pages/),
    });
  });

  it('validates --concurrency shape before key resolution (no key present)', async () => {
    await expect(
      runParse(FIXTURE, { provider: 'gemini', concurrency: '0', out: outDir }, noCreds),
    ).rejects.toMatchObject({
      exitCode: PARSE_EXIT.INVALID_ARGS,
      message: expect.stringMatching(/--concurrency/),
    });
  });

  it('validates --dpi shape before key resolution (no key present)', async () => {
    await expect(
      runParse(FIXTURE, { provider: 'gemini', dpi: 'abc', out: outDir }, noCreds),
    ).rejects.toMatchObject({
      exitCode: PARSE_EXIT.INVALID_ARGS,
      message: expect.stringMatching(/--dpi/),
    });
  });

  // #15 — a provider 400 (bad key) surfaces as: attempts actually made (not "retries"),
  // the provider's own body snippet, and an actionable auth hint. Exit 1.
  // Own origin so the happy-path 200 `.persist()` intercept (same file) can't shadow it.
  it('surfaces a provider 400 with attempts + body snippet + auth hint (exit 1)', async () => {
    const ORIGIN_400 = 'https://fake-vlm-badkey.test';
    agent()
      .get(ORIGIN_400)
      .intercept({ path: '/v1/chat/completions', method: 'POST' })
      .reply(400, 'Invalid API key provided')
      .persist();
    const err = (await runParse(
      FIXTURE,
      { ...okOpts(), baseUrl: `${ORIGIN_400}/v1` },
      noCreds,
    ).catch((e) => e)) as {
      exitCode?: number;
      message: string;
    };
    expect(err.exitCode).toBe(PARSE_EXIT.ERROR);
    expect(err.message).toContain('after 1 attempt'); // attempts actually made, not the setting
    expect(err.message).not.toMatch(/after \d+ retries/); // the old lie is gone
    expect(err.message).toContain('Invalid API key provided'); // provider body snippet
    expect(err.message).toContain('OPENAI_API_KEY'); // env-var hint
    expect(err.message).toContain('okra auth login openai-compatible'); // command hint
  });
});

describe('createParseCommand — -o json stdout envelope', () => {
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

  it('prints ONLY the JSON envelope (no markdown dump) and writes the files', async () => {
    interceptChat();
    await createParseCommand().parseAsync([
      'node', 'parse', FIXTURE,
      '--provider', 'openai-compatible',
      '--model', 'test-model',
      '--api-key', 'sk-test',
      '--base-url', BASE,
      '--dpi', '72',
      '--out', outDir,
      '-o', 'json',
    ]);

    const stdout = logs.join('\n');
    const parsed = JSON.parse(stdout);
    expect(parsed.outDir).toBe(outDir);
    expect(parsed.meta.pageCount).toBe(2);
    expect(Array.isArray(parsed.pages)).toBe(true);
    // NO markdown dump on stdout — the body only lives in doc.md on disk
    expect(stdout).not.toContain('hello world');
    expect(existsSync(join(outDir, 'doc.md'))).toBe(true);
  });
});
