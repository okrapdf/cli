/**
 * Unknown-command did-you-mean (#18). v0.2.x top-level commands that moved under
 * `okra cloud` get a `did you mean: okra cloud <sub>?` hint; a genuinely unknown name
 * gets commander's native error and no hint. Exit stays 1 in both cases.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createProgram, cloudSuggestionFor } from './cli.js';

describe('cloudSuggestionFor (#18) — moved-command map', () => {
  it('maps moved cloud resource commands to their `okra cloud <sub>` home', () => {
    expect(cloudSuggestionFor('docs')).toBe('docs');
    expect(cloudSuggestionFor('jobs')).toBe('jobs');
    expect(cloudSuggestionFor('tables')).toBe('tables');
    expect(cloudSuggestionFor('entities')).toBe('entities');
    expect(cloudSuggestionFor('chat')).toBe('chat');
    expect(cloudSuggestionFor('extract')).toBe('extract');
    expect(cloudSuggestionFor('run')).toBe('run');
    expect(cloudSuggestionFor('processors')).toBe('processors');
    expect(cloudSuggestionFor('templates')).toBe('templates');
    expect(cloudSuggestionFor('logs')).toBe('logs');
    expect(cloudSuggestionFor('review')).toBe('review');
  });

  it('special-cases auth → login (old okra-cloud `okra auth login` is now `okra cloud login`)', () => {
    expect(cloudSuggestionFor('auth')).toBe('login');
  });

  it('returns undefined for a genuinely unknown or a still-valid top-level command', () => {
    expect(cloudSuggestionFor('frobnicate')).toBeUndefined();
    expect(cloudSuggestionFor('parse')).toBeUndefined();
    expect(cloudSuggestionFor('providers')).toBeUndefined();
  });
});

describe('createProgram (#18) — unknown-command handling end to end', () => {
  afterEach(() => vi.restoreAllMocks());

  async function runUnknown(cmd: string): Promise<{ printed: string; exit: number | undefined }> {
    const errs: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      errs.push(a.map(String).join(' '));
    });
    let exitCode: number | undefined;
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCode = code ?? 0;
      throw new Error(`EXIT:${code}`);
    }) as never);
    try {
      await createProgram().parseAsync(['node', 'okra', cmd]);
    } catch (e) {
      if (!(e instanceof Error && e.message.startsWith('EXIT:'))) throw e;
    }
    return { printed: errs.join('\n'), exit: exitCode };
  }

  it('`okra docs` → native unknown-command error + `did you mean: okra cloud docs?` + exit 1', async () => {
    const { printed, exit } = await runUnknown('docs');
    expect(printed).toContain("unknown command 'docs'");
    expect(printed).toContain('did you mean: okra cloud docs?');
    expect(exit).toBe(1);
  });

  it('`okra frobnicate` → native unknown-command error, NO did-you-mean, exit 1', async () => {
    const { printed, exit } = await runUnknown('frobnicate');
    expect(printed).toContain("unknown command 'frobnicate'");
    expect(printed).not.toContain('did you mean');
    expect(exit).toBe(1);
  });
});
