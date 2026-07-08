# @okrapdf/cli

Parse PDFs into **layout-aware markdown + 0–1000 bbox blocks** with **your own** model
key — Gemini, NVIDIA, or any OpenAI-compatible endpoint. **No account. No okra API. Your
keys only.**

[![CI](https://github.com/okrapdf/cli/actions/workflows/ci.yml/badge.svg)](https://github.com/okrapdf/cli/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> **Status — v0.17.x, the BYOK re-baseline. Pre-1.0: the surface may still change.**
> The version on npm (**0.16.x**) is still the *legacy* okra-cloud CLI published from
> the okraPDF monorepo — do not confuse the two. Until the npm handover lands
> (tracked in [steventsao/okra#615](https://github.com/steventsao/okra/issues/615)),
> install from a [GitHub release](https://github.com/okrapdf/cli/releases) or source.

## What it is

`okra parse doc.pdf` rasterizes each page, sends the page images to the model provider
**you** choose, and writes:

- **`doc.md`** — whole-document markdown (per-page markdown joined with blank lines)
- **`blocks.json`** — every layout block with a `[x1,y1,x2,y2]` bounding box in
  normalized **0–1000, top-left origin** coordinates
- **`manifest.json`** — run metadata (provider, model, page count, token usage, cost,
  durations, warnings)

The layout prompts are the ParseBench-lineage VLM prompts (see [NOTICE](#notice)). The
parser is a swappable seam — layout-VLM is just the default.

## Install

**One-liner (macOS/Linux)** — installs the release tarball via npm (no account, no sudo):

```bash
curl -fsSL https://raw.githubusercontent.com/okrapdf/cli/main/install.sh | bash
```

Pin a specific release by setting `OKRA_INSTALL_VERSION` (e.g. `OKRA_INSTALL_VERSION=v0.17.0`).

**npm (release tarball)** — the same install, by hand:

```bash
# From the GitHub release (recommended until the npm handover — see Status above)
npm i -g https://github.com/okrapdf/cli/releases/latest/download/okrapdf-cli.tgz
```

> `npm i -g @okrapdf/cli` currently installs **0.16.x, the legacy okra-cloud CLI** — not
> this. Use the release tarball above until the npm handover lands.

Node ≥ 22. `mupdf` (page rasterization) and `sharp` (image encoding) are bundled.

## 30-second quickstart (BYOK)

```bash
# 1. Bring your own key — a free Gemini key works: https://aistudio.google.com/apikey
export GEMINI_API_KEY=...

# 2. Parse
okra parse document.pdf

# 3. Read the three artifacts (default output dir: ./document.okra/)
cat document.okra/doc.md               # markdown
jq '.[0]' document.okra/blocks.json    # first layout block (0-1000 bbox)
jq '.meta' document.okra/manifest.json # run metadata
```

Machine-readable envelope (no markdown on stdout — the body stays in `doc.md`):

```bash
okra parse document.pdf -o json | jq '.meta.pageCount'
```

Useful flags: `--provider`, `--model`, `--pages 1-5`, `--concurrency N`, `--dpi N`,
`--out <dir>`, `--api-key`, `--base-url`. See `okra parse --help`.

## No okra account. No okra API. Your keys only.

- **What leaves your machine:** the **rendered page images** go to the **one provider
  you chose** (Gemini / NVIDIA / your OpenAI-compatible endpoint) — and nothing else.
- **No calls to okrapdf.com** on the parse path. This is **CI-enforced**: an undici
  `disableNetConnect()` net-guard fails the test suite if any code contacts a host other
  than the chosen provider, plus a static import-graph guard keeps the cloud connector
  out of the core path (see
  [`test/net-guard.test.ts`](test/net-guard.test.ts) and [`src/arch.test.ts`](src/arch.test.ts)).
- **Zero telemetry.** The CLI phones home to nobody.

## Providers

A provider is a data row in [`src/providers/registry.ts`](src/providers/registry.ts) —
catalog entry + auth resolution + transport dialect. Key resolution precedence is
**flag > env var > config store** (`okra auth login <id>`), never a network lookup.

| Provider | Env var(s) | Default model | Key |
|---|---|---|---|
| `gemini` | `GEMINI_API_KEY` / `GOOGLE_API_KEY` | `gemini-3-flash-preview` | Free key at https://aistudio.google.com/apikey |
| `nvidia` | `NVIDIA_API_KEY` | `nvidia/llama-3.1-nemotron-nano-vl-8b-v1` | Free dev tier at https://build.nvidia.com |
| `openrouter` | `OPENROUTER_API_KEY` | `google/gemini-3-flash-preview` | https://openrouter.ai/keys |
| `openai-compatible` | `OPENAI_API_KEY` + `OPENAI_BASE_URL` | *(pass `--model`)* | Any vLLM / Ollama / OpenAI-shaped endpoint |

```bash
# Store a key instead of exporting it, then list configured providers
okra auth login gemini
okra providers
```

### NVIDIA NIM

```bash
export NVIDIA_API_KEY=...
okra parse doc.pdf --provider nvidia
```

### Any OpenAI-compatible endpoint (vLLM / Ollama / …)

```bash
export OPENAI_BASE_URL=http://localhost:8000/v1
export OPENAI_API_KEY=...            # some local servers accept any non-empty value
okra parse doc.pdf --provider openai-compatible --model your-vlm-model
```

## Parsers

The parser is a swappable seam behind one interface
([`src/parsers/types.ts`](src/parsers/types.ts)). Today's default is **`layout-vlm`**
(ParseBench prompts + a VLM). A `docling-serve` parser (`requires: 'http'`) or a
`text-layer` parser (`requires: 'none'`) can drop in without touching the engine —
contributions welcome. See [`DESIGN.md`](DESIGN.md) → "Seam 2".

```bash
okra parse doc.pdf --parser layout-vlm   # the default
```

## Output schema

`okra parse` writes three files under `--out` (default `./<pdf-basename>.okra/`):

**`doc.md`** — whole-document markdown (per-page markdown joined by blank lines).

**`blocks.json`** — an array of `LayoutBlock`:

```jsonc
{
  "label": "Section-header",       // Caption | Footnote | Formula | List-item |
                                    // Page-footer | Page-header | Picture |
                                    // Section-header | Table | Text | Title | <string>
  "bbox": [120, 84, 880, 132],     // [x1,y1,x2,y2], normalized 0-1000, TOP-LEFT origin
  "text": "Consolidated Balance Sheet",
  "page": 1                         // 1-indexed
}
```

**`manifest.json`** — `{ meta, pages }`:

```jsonc
{
  "meta": {
    "parserId": "layout-vlm",
    "providerId": "gemini",
    "model": "gemini-3-flash-preview",
    "pageCount": 12,
    "durationMs": 8423,
    "costUsd": 0.0031,              // omitted entirely when the model is unpriced (never guessed)
    "warnings": []
  },
  "pages": [
    { "page": 1, "blockCount": 9,
      "usage": { "inputTokens": 1024, "outputTokens": 256, "thinkingTokens": 0 } }
  ]
}
```

## `okra cloud` — optional connector

`okra cloud` is a **separate, opt-in** connector to the okraPDF cloud (hosting, sharing,
publishing, managed extraction). It talks to okrapdf.com and needs an **okraPDF account**
(`OKRA_API_KEY`). The core parse path never uses it — `okra parse` is BYOK and needs no
account. Run `okra cloud --help` if you want it.

## NOTICE

The `layout-vlm` parser's prompts derive from **[ParseBench](https://github.com/run-llama/parsebench)**
(run-llama, MIT), vendored via the okraPDF monorepo's `packages/parser-gemini`. See the
header of [`src/parsers/layout-vlm/prompts.ts`](src/parsers/layout-vlm/prompts.ts) for
attribution. This project is MIT licensed — see [LICENSE](LICENSE).

## Development

```bash
pnpm i
pnpm build      # tsc
pnpm test       # vitest (net-killed: no live network in tests)
```

TDD is the workflow — write the failing test first. The architecture (the two seams:
Providers and Parsers) and its dependency rules are in [`DESIGN.md`](DESIGN.md), and are
enforced by [`src/arch.test.ts`](src/arch.test.ts). CI runs `pnpm build && pnpm test` on
Node 22 + 24 ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

## License

MIT — see [LICENSE](LICENSE).
