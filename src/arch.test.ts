/**
 * Import-graph guard (DESIGN.md #6, "The two seams"). Statically walks every
 * non-test source file under src/, extracts its import/export specifiers with a
 * small regex resolver (no new deps), and enforces the dependency rules:
 *
 *   - parsers/**   → core/** + parsers-internal + node/npm only (NEVER providers, commands, cloud)
 *   - providers/** → core/** + providers-internal + node/npm only
 *   - core/**      → core/** only, with EXACTLY these sanctioned exceptions:
 *                      • core/rasterize.ts → lib/pdf-image.ts (runtime rasterization path)
 *                      • core/engine.ts, core/rasterize.ts → parsers/types.ts as `import type` ONLY
 *   - nothing outside cloud/** imports cloud/** — except cli.ts's single
 *     registration import of cloud/index.ts.
 *
 * Plus the no-cloud string guard: zero 'okrapdf.com' in shipped (non-test) source
 * outside src/cloud/**.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { posix } from 'node:path';

const SRC_DIR = fileURLToPath(new URL('.', import.meta.url)); // → <repo>/src/

/** All .ts files under src/, as posix paths relative to src/ (e.g. 'core/engine.ts'). */
function allTsFiles(): string[] {
  return readdirSync(SRC_DIR, { recursive: true })
    .map((p) => String(p).split(/[\\/]/).join('/'))
    .filter((p) => p.endsWith('.ts'));
}

const isTest = (rel: string): boolean => rel.endsWith('.test.ts');

/** Top-level zone of a src-relative path. */
function zoneOf(rel: string): string {
  const seg = rel.split('/')[0];
  return ['core', 'providers', 'parsers', 'cloud', 'commands', 'lib'].includes(seg) ? seg : 'root';
}

/** Resolve a relative import specifier (`.js`) to a src-relative `.ts` path. */
function resolveRel(fromRel: string, spec: string): string {
  const joined = posix.normalize(posix.join(posix.dirname(fromRel), spec));
  return joined.replace(/\.js$/, '.ts');
}

interface Imp {
  spec: string;
  typeOnly: boolean;
}

/**
 * Extract every static + dynamic import specifier. Static imports are anchored to
 * line start (so prose/JSDoc `* import …` and `// import …` are ignored) and may
 * span multiple lines up to `from '…'` (stops at `;`, so side-effect imports without
 * `from` don't over-match). `import type …` is flagged; `{ type X }` inline is not.
 */
function extractImports(content: string): Imp[] {
  const out: Imp[] = [];
  const staticRe = /^[ \t]*(?:import|export)\s+(type\s+)?[^;]*?\bfrom\s*['"]([^'"]+)['"]/gm;
  let m: RegExpExecArray | null;
  while ((m = staticRe.exec(content)) !== null) {
    out.push({ spec: m[2], typeOnly: Boolean(m[1]) });
  }
  const dynRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = dynRe.exec(content)) !== null) {
    out.push({ spec: m[1], typeOnly: false });
  }
  return out;
}

const files = allTsFiles();
const sourceFiles = files.filter((f) => !isTest(f));

describe('import-graph dependency rules (the two seams)', () => {
  it('parsers/ and providers/ import only core/ + their own zone', () => {
    const violations: string[] = [];
    for (const file of sourceFiles) {
      const z = zoneOf(file);
      if (z !== 'parsers' && z !== 'providers') continue;
      for (const { spec } of extractImports(readFileSync(SRC_DIR + file, 'utf8'))) {
        if (!spec.startsWith('.')) continue; // node/npm — unrestricted
        const tz = zoneOf(resolveRel(file, spec));
        if (tz !== z && tz !== 'core') {
          violations.push(`${file} imports ${resolveRel(file, spec)} (zone ${tz}); ${z}/ may import only core/ + ${z}-internal`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('core/ imports only core/, save the sanctioned rasterize + type-only parser exceptions', () => {
    const violations: string[] = [];
    for (const file of sourceFiles) {
      if (zoneOf(file) !== 'core') continue;
      for (const { spec, typeOnly } of extractImports(readFileSync(SRC_DIR + file, 'utf8'))) {
        if (!spec.startsWith('.')) continue;
        const target = resolveRel(file, spec);
        if (zoneOf(target) === 'core') continue;
        if (file === 'core/rasterize.ts' && target === 'lib/pdf-image.ts') continue; // runtime rasterization
        if (
          (file === 'core/engine.ts' || file === 'core/rasterize.ts') &&
          target === 'parsers/types.ts'
        ) {
          if (!typeOnly) violations.push(`${file} imports ${target} but MUST be \`import type\``);
          continue;
        }
        violations.push(`${file} imports ${target} — core/ may import only core/ + the 3 sanctioned exceptions`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('nothing outside cloud/ imports cloud/ (except cli.ts → cloud/index.ts)', () => {
    const violations: string[] = [];
    for (const file of sourceFiles) {
      if (zoneOf(file) === 'cloud') continue;
      for (const { spec } of extractImports(readFileSync(SRC_DIR + file, 'utf8'))) {
        if (!spec.startsWith('.')) continue;
        const target = resolveRel(file, spec);
        if (zoneOf(target) !== 'cloud') continue;
        const allowed = file === 'cli.ts' && target === 'cloud/index.ts';
        if (!allowed) {
          violations.push(`${file} imports cloud module ${target} — only cli.ts may import cloud/index.ts`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('sanity: the walk actually found the seam files', () => {
    // Guard against a broken walk silently passing every rule above.
    expect(sourceFiles).toContain('core/engine.ts');
    expect(sourceFiles).toContain('parsers/layout-vlm/index.ts');
    expect(sourceFiles).toContain('providers/registry.ts');
    expect(sourceFiles).toContain('cloud/index.ts');
    expect(sourceFiles.length).toBeGreaterThan(20);
  });
});

describe('no-cloud string guard', () => {
  it('has zero okra host references in shipped (non-test) source outside src/cloud/', () => {
    // Build the needle by parts so THIS test file never contains the literal.
    const needle = ['okrapdf', 'com'].join('.');
    const offenders = sourceFiles
      .filter((f) => zoneOf(f) !== 'cloud')
      .filter((f) => readFileSync(SRC_DIR + f, 'utf8').includes(needle));
    expect(offenders).toEqual([]);
  });
});
