/**
 * Cloud copy guard (#14). The cloud auth verb is `okra cloud login`; the top-level
 * `okra auth login <provider>` is BYOK-only and never touches an okra account. No
 * user-facing (runtime) string under src/cloud/** may misdirect cloud users at the
 * BYOK `okra auth login`. Architecture COMMENTS that contrast the two surfaces are
 * fine, so the scan ignores comment lines and checks executable source only.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CLOUD_DIR = fileURLToPath(new URL('.', import.meta.url)); // → <repo>/src/cloud/

function cloudSourceFiles(): string[] {
  return readdirSync(CLOUD_DIR, { recursive: true })
    .map((p) => String(p).split(/[\\/]/).join('/'))
    .filter((p) => p.endsWith('.ts') && !p.endsWith('.test.ts'));
}

/** Drop whole-line comments (JSDoc `*`, block `/*` … `*/`, line `//`) so only runtime copy is scanned. */
function stripCommentLines(src: string): string {
  return src
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !(t.startsWith('*') || t.startsWith('//') || t.startsWith('/*') || t.startsWith('*/'));
    })
    .join('\n');
}

describe('cloud copy (#14) — cloud commands say `okra cloud login`, not BYOK `okra auth login`', () => {
  it('no runtime string under src/cloud/** directs users at `okra auth login`', () => {
    const offenders: string[] = [];
    for (const rel of cloudSourceFiles()) {
      const runtime = stripCommentLines(readFileSync(CLOUD_DIR + rel, 'utf8'));
      if (runtime.includes('okra auth login')) offenders.push('cloud/' + rel);
    }
    expect(offenders).toEqual([]);
  });

  it('the not-authenticated copy in cloud/lib/client.ts names `okra cloud login`', () => {
    const src = readFileSync(CLOUD_DIR + 'lib/client.ts', 'utf8');
    expect(src).toContain('okra cloud login');
    expect(src).not.toContain('okra auth login');
  });

  it('sanity: the walk actually found the cloud source files', () => {
    const found = cloudSourceFiles();
    expect(found).toContain('lib/client.ts');
    expect(found).toContain('commands/shortcuts.ts');
    expect(found.length).toBeGreaterThan(10);
  });
});
