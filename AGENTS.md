# Worker rules — okra CLI (m1-byok branch)

You are implementing milestone [M-BYOK] (issues #1–#6) under an architect who owns `DESIGN.md`
and the type seams in `src/core/`, `src/providers/types.ts`, `src/parsers/types.ts`. Read
`DESIGN.md` first. Your job: implementations + tests behind those contracts.

## Hard rules

1. **TDD, honestly.** For each unit in your assignment: write the failing test first, watch it
   fail (`pnpm vitest run <file>`), implement, watch it pass. Commit tests together with impl.
   The TDD map in DESIGN.md lists the tests per issue — treat it as the minimum, add more.
2. **Never edit the seam contracts silently.** Files marked `@architect-owned` in their header:
   if the contract blocks you, leave a `CONTRACT-FLAG:` note in your final summary instead of
   changing the type. Implementation stubs (`TODO(worker)`) inside those files are yours to fill.
3. **Dependency rules** from DESIGN.md ("The two seams") are law: parsers import core only;
   providers import core only; nothing outside `cloud/` imports `cloud/`; core imports nothing
   but node builtins.
4. **No network in tests.** undici `MockAgent` with `disableNetConnect()`. No live API calls,
   no keys in code or fixtures. Transports use global `fetch` only — no got/axios/SDK deps.
5. **No new runtime dependencies** without listing them + a one-line justification in your
   summary. Dev deps: undici (for MockAgent types) is pre-approved.
6. **Zero `*.okrapdf.com`** anywhere in `src/` outside `src/cloud/`.
7. Conventional, issue-tagged commits: `[M-BYOK] <what> (#<issue>)`. Small commits, each green.
8. Done = `pnpm build` + `pnpm test` green from a clean install (`pnpm i`). Say so explicitly
   in your summary, and list any test you skipped or weakened.

## Style

- TypeScript strict; ESM; match the existing repo idiom (commander command factories,
  `lib/output.ts` for printing, chalk for color).
- Errors are user-facing copy: name the exact env var / command that fixes the problem.
- Keep functions pure where the design says so (decode, resolution, pricing) — they're the
  golden-test surface.
