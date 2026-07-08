# okra CLI — BYOK architecture ([M-BYOK] milestone 1)

Design authority for milestone [M-BYOK](https://github.com/okrapdf/cli/milestone/1), issues #1–#6.
Contracts here are owned by the architect session; implementations + tests are the worker's.
If an implementation forces a contract change, flag it in the PR notes — don't silently edit the seams.

## Outcome

`npm i -g @okrapdf/cli` + `GEMINI_API_KEY` (or `NVIDIA_API_KEY`, or any OpenAI-compatible endpoint)
→ `okra parse doc.pdf` produces markdown + layout blocks with 0-1000 bboxes.
No okra account. Zero requests to `*.okrapdf.com` in the core path. Cloud = opt-in namespace.

## The two seams

Everything hangs off two swap points, both dependency-inverted through `src/core/`:

```
commands/  ─►  core/engine  ─►  Parser (seam 2)  ─►  VlmClient (seam 1)
                    │                │                     ▲
                    ▼                ▼                     │ implements
               core/blocks      parsers/layout-vlm    providers/* (registry + transports)
               (canonical         (DEFAULT parser:
                contract)          ParseBench prompts,
                                   swappable like docling)
```

**Dependency rules (enforced by test in issue #6):**
1. `parsers/**` may import `core/**` only — never `providers/**`, never `commands/**`. A parser
   receives its `VlmClient` injected via `ParserContext`; it declares `requires: 'vlm'` and stays
   ignorant of which provider satisfied it (flue-style inversion).
2. `providers/**` may import `core/**` only. Providers implement `core/vlm.ts`'s `VlmClient`.
3. `core/**` imports nothing outside `core/` (and node builtins).
4. Nothing outside `cloud/**` may import `cloud/**` (the legacy okra-cloud client + commands).
5. `commands/**` + `core/engine.ts` do the wiring: resolve provider → create client → inject into parser.

## Seam 1 — Providers (opencode model)

A provider = **catalog entry + auth resolution + transport dialect**. Static data table in
`providers/registry.ts`, exactly like opencode's provider list: adding a provider is a data row,
not a class.

- `gemini` — dialect `gemini` (native `generateContent` REST), keys `GEMINI_API_KEY` | `GOOGLE_API_KEY`
- `nvidia` — dialect `openai-chat`, base `https://integrate.api.nvidia.com/v1`, key `NVIDIA_API_KEY`
- `openrouter` — dialect `openai-chat`, base `https://openrouter.ai/api/v1`, key `OPENROUTER_API_KEY`
  (preset proving "openai-compatible presets are one data row"; also serves legacy v0.2.x users)
- `openai-compatible` — dialect `openai-chat`, base URL **required** from config/flag/env
  (`OPENAI_BASE_URL`), key `OPENAI_API_KEY`. vLLM / Ollama / anything.

**Two transports only** (`providers/transports/gemini.ts`, `providers/transports/openai-chat.ts`),
implementing `VlmClient` over global `fetch` (Node ≥ 20). No `got`, no SDK deps in core — raw
fetch keeps the no-cloud guard airtight and the bundle small.

**Key resolution precedence** (issue #2): CLI flag > env var > config store
(`~/.config/okrapdf/config.json` via existing `conf` setup, new `providers.<id>.api_key` /
`providers.<id>.base_url` keys). Missing key errors MUST name the exact env var and the
`okra auth login <id>` alternative. Never a network lookup.

**Pricing** lives with providers (`providers/pricing.ts`): the Gemini per-model table +
`longestPrefixMatch` ported from monorepo `packages/parser-gemini/src/pricing.ts`. Unknown models
→ cost omitted (never guessed).

## Seam 2 — Parsers (docling-swappable; default = ParseBench prompts)

A parser = **prompts + settings + decode logic** behind one interface. The ParseBench-derived
VLM layout parser (`parsers/layout-vlm/`) is the **default**, but it is a peer, not the core:
a future `docling-serve` parser (`requires: 'http'`) or `text-layer` parser (`requires: 'none'`)
drops in without touching the engine.

`parsers/layout-vlm/` encapsulates (issue #3):
- `prompts.ts` — vendored verbatim from monorepo `packages/parser-gemini/src/prompts.ts`
  (ParseBench `google.py` lineage, MIT — attribution in header + README NOTICE):
  `SYSTEM_PROMPT_LAYOUT`, `USER_PROMPT_LAYOUT`, `*_GEMINI` variants (y-first bbox order),
  `LABEL_MAP` + `canonicalLabel`.
- `decode.ts` — `parseLayoutBlocks` (dual-order attr regex + dedupe), `swapGeminiBbox`,
  `itemsToMarkdown`, `bboxToNormalized`. Vendored from `packages/parser-gemini/src/bbox.ts`.
- `quirks.ts` — **model-family** quirk resolution: `bboxOrderFor(modelId)` prefix-matches
  `gemini` → `'yxyx'`, default `'xyxy'`. The quirk is a fact about the model, NOT the provider
  (gemini-through-openrouter still emits y-first), which is why it lives inside the parser
  module, overridable via `settings.bboxOrder`.
- `index.ts` — `defineParser({...})`: pick prompt variant by bbox order → `ctx.vlm.complete()`
  → decode blocks → swap if `yxyx` → canonical labels → `PageParse`.

## Canonical output contract (`core/blocks.ts`)

- `Bbox = [x1, y1, x2, y2]`, normalized **0-1000**, top-left origin (ParseBench-native; what the
  prompts emit). Interop with okra box-JSON (`{x,y,w,h}` 0-1) via `bboxToNormalized` — both
  shapes explicit, no implicit unit mixing.
- `LayoutBlock { label, bbox, text, page }`, labels canonicalized to the 11-category set
  (Caption, Footnote, Formula, List-item, Page-footer, Page-header, Picture, Section-header,
  Table, Text, Title) with open string escape hatch.
- `PageParse { page, markdown, blocks, usage? }` → `DocumentParse { markdown, pages, blocks, usage, meta }`.

## Engine + command (issue #4)

`core/engine.ts` `parseDocument(pdf, opts)`: rasterize pages (existing `lib/pdf-image.ts` —
mupdf wasm + sharp, already self-contained) → bounded-concurrency pool (default 4) over
`parser.parsePage` → retry w/ exponential backoff on 429/5xx (default 2 retries) → assemble
doc markdown (pages joined `\n\n`), summed usage, cost via pricing.

CLI: `okra parse <pdf> [--provider gemini|nvidia|openrouter|openai-compatible] [--model <id>]
[--parser layout-vlm] [--out <dir>] [--pages 1-5] [--concurrency N] [-o json]`
Writes `<out>/doc.md`, `<out>/blocks.json`, `<out>/manifest.json` (run metadata: provider, model,
parser, usage, cost, durations, page count). `-o json` prints the manifest+result envelope to stdout.

## Cloud demotion (issue #5)

Legacy v0.2.11 surface (docs/jobs/tables/entities/chat/processors/templates/logs/review +
`lib/client.ts`) moves wholesale under `src/cloud/` and mounts as `okra cloud <cmd>`, clearly
labeled opt-in. Old `okra auth` (okra key) → `okra cloud login`. New top-level `okra auth login
<provider>` is BYOK-only. Core error copy never mentions okra API keys.

## Toolchain (issue #1)

Keep: commander, chalk, ora, conf, vitest, tsc build. Change: version → `0.17.0-dev.0`
(npm 0.16.x is the monorepo thin-bin; DO NOT publish from this branch), engines node `>=20`,
pnpm with `packageManager` field, `mupdf` + `sharp` promoted to hard dependencies (parse is the
headline feature). Drop from core: `got`, `form-data`, `ws` (they live on only as `cloud/` deps
until cloud is extracted). CI: GitHub Actions `pnpm build && pnpm test` on PR.

## No-cloud guard (issue #6)

Vitest setup installs an undici `MockAgent` with `disableNetConnect()` as the global dispatcher
(backs Node's `fetch`): tests intercept provider hosts explicitly; ANY request to a
non-intercepted host — above all `*.okrapdf.com` — fails the suite. Plus a static
import-graph test enforcing the dependency rules above (rule 4 especially). Plus a seeded
red-test proving the guard actually trips.

## TDD map (issue → tests first)

| Issue | Tests to write BEFORE impl |
|---|---|
| #2 providers | resolution precedence (flag>env>config); missing-key error names env var; registry lookup; transport request-shape goldens (gemini `generateContent` body; openai-chat body w/ data-URI images) against MockAgent; usage mapping |
| #3 layout-vlm | decode goldens: fixture model outputs (xyxy + yxyx + data-page variants, malformed-bbox skip, dual attr order); canonicalLabel table; bboxOrderFor; parsePage against fake VlmClient |
| #4 engine | fake parser + fake client: concurrency bound respected, retry/backoff on 429 then success, page order stable, usage/cost summation; CLI `parse` e2e with mocked transport writing all 3 artifacts |
| #5 cloud | core commands run with ONLY `GEMINI_API_KEY` set + empty config (no okra prompt); `okra cloud` gated with explicit copy; import-graph rule 4 |
| #6 guard | net-guard trips on seeded okrapdf.com call; full parse e2e emits zero non-provider requests |

## Non-goals (this milestone)

nemotron-parse bespoke response mapping (NVIDIA rides openai-chat VLM models first; bespoke
mapping = follow-up in #3 only if the response schema is verified against the live NIM API);
multipage-prompt mode; publish to npm; extract/invoice prompts; MCP.
