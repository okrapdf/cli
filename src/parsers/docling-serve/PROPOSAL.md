# PROPOSAL — docling-serve as a parser component in okra (SPIKE)

**Status: sample for owner approval. Do not merge. Nothing here is milestoned yet.**

This spike shows, in working code, what "docling as a component in okra" looks like: the
[docling-serve](https://github.com/docling-project/docling-serve) HTTP converter sitting behind
the existing `Parser` seam, so `okra parse` can produce the *same* bbox-cited block graph from
docling's native text-layer parse that it produces from the VLM parsers today. It exists so the
**shape** can be approved before it becomes milestone work.

## Why docling-as-a-component (positioning)

okra's parse seam is deliberately backend-agnostic (`DESIGN.md` → "Seam 2 — Parsers": a parser is
*prompts + settings + decode behind one interface*, and docling was named as the motivating
swap-in). docling is the strongest open document parser for **born-digital PDFs with a real text
layer** — it reads structure directly instead of re-OCRing a rasterized image, which is faster and
avoids VLM hallucination on clean text. Making it a *peer parser* (not a fork, not a rewrite) means:

- one CLI, one output contract (`blocks.json` / `doc.md` / `manifest.json`), many engines;
- users pick the right tool per document (`--parser docling-serve` for clean PDFs, the VLM parser
  for scans/figures) without learning a second tool;
- it composes with everything downstream (citations, diff, publish) for free.

The catch — and the reason this is a spike, not a PR — is that docling is **document-native** while
our `Parser` interface is **per-page-image** (`parsePage(PageInput{png})`). Rasterizing first to
feed a per-page loop would throw away exactly the text-layer strength we want docling for. So the
seam has to widen by one optional method. That widening is the thing to approve.

## The CLI sample (exact, working)

```bash
# 1. run docling-serve locally (its Docker image exposes the /v1 HTTP API on :5001)
#    e.g.  docker run --rm -p 5001:5001 <docling-serve image>

# 2. parse a born-digital PDF through docling, into okra's standard artifacts
okra parse report.pdf --parser docling-serve --base-url http://localhost:5001 --out report.okra
#   → report.okra/doc.md  report.okra/blocks.json  report.okra/manifest.json
#   (manifest.meta.parserId = "docling-serve"; no model/provider on this path)

# DOCLING_SERVE_URL works instead of --base-url:
DOCLING_SERVE_URL=http://localhost:5001 okra parse report.pdf --parser docling-serve
```

No model provider, no VLM key — a document-native parser needs only the base URL.

## Illustrative future-JSX (ILLUSTRATION ONLY — not implemented in this spike)

The same parser id would drop straight into the authoring layer the roadmap points at, e.g.:

```tsx
// illustration only — no code behind this in this PR
<Parse parser="docling-serve" baseUrl={env.DOCLING_SERVE_URL} />
<Diff a={<Parse parser="layout-vlm" model="gemini-3-flash" />}
      b={<Parse parser="docling-serve" />} />   // engine-vs-engine agreement on the same doc
```

That `<Diff>` (docling text-layer vs VLM, same PDF, same block contract) is the payoff of keeping
one output contract across engines — it's the "missing verb" the self-host framing wants.

## Seam-widening diff summary (the two @architect-owned files)

Both edits are marked `// PROPOSAL(spike):` in-source. Purely additive — every existing parser and
all 340 baseline tests keep passing.

- **`src/parsers/types.ts`** — `Parser.parsePage` becomes **optional** and a
  `parseDocument?(pdf: Uint8Array, ctx: ParserContext): Promise<PageParse[]>` is **added**; a parser
  implements *exactly one*. `defineParser` is made generic (`<T extends Parser>`) so concrete
  parsers keep their precise literal type (a VLM parser's `parsePage` stays non-optional at its
  call sites). Doc comment: *"document-native parsers implement parseDocument; the engine prefers
  it and skips rasterization."*
- **`src/core/engine.ts`** — when `opts.parser.parseDocument` exists, the engine calls it **once**
  (no `rasterizePages`, no page pool; retries wrap the single call) and feeds the result into a
  shared `assembleDocument()` — the all-zero-blocks guard, usage summation, warnings, cost, and meta
  are **identical** to the per-page path. A guard rejects a parser that implements neither entry
  point. The per-page VLM path is otherwise untouched.

Non-seam wiring (not contract changes): a registry row in `parsers/registry.ts` (the sanctioned
"extend by adding a row" mechanism) and the `--parser docling-serve` base-URL path in
`commands/parse.ts`.

## Mapping: DoclingDocument → okra contract

| DoclingDocument | okra `LayoutBlock` | how |
|---|---|---|
| reading order | block order | walk `body.children[]` RefItems (`{$ref:"#/texts/0"}`), recurse into `groups`, ignore `furniture` |
| `texts[].text` | `text` | verbatim |
| `tables[].data` | `text` | cells joined `\|`-per-row, `\n`-per-row (see open question c) |
| `pictures[]` | `Picture` block | empty text, still a block |
| `label` (snake_case) | `BlockLabel` | `canonicalLabel` (reused): `section_header`→`Section-header`, `list_item`→`List-item`, … unknowns (`code`, `paragraph`, `document_index`) **passed through verbatim** |
| `prov[0].bbox {l,t,r,b,coord_origin}` (PDF points) | `[x1,y1,x2,y2]` 0-1000 top-left | one pure fn `doclingBboxToNormalized` |
| `pages["N"].size` | (normalization basis) | scale each coord by page W/H × 1000 |

**bbox origin flip** (the one place correctness is subtle, exhaustively unit-tested):
`x1=min(l,r)`, `x2=max(l,r)`. For **BOTTOMLEFT** (docling native): `y_top=H−t`, `y_bottom=H−b`,
then min/max so `y_top<y_bottom`. For **TOPLEFT**: `y` used as-is. Result clamped to `[0,1000]`.

## Open questions for approval

- **(a) Contract widening — yes/no?** Approve making `parsePage` optional + adding
  `parseDocument?` (engine prefers it, skips rasterization). This is the load-bearing decision;
  everything else follows. A stricter alternative is a discriminated union keyed on `spec.requires`.
- **(b) Base-URL delivery.** This spike reuses `--base-url` (falling back to `DOCLING_SERVE_URL`).
  Alternatives: a dedicated `--docling-url` flag, or a `parsers.docling-serve.base_url` config key
  (mirroring the provider config store). Pick one.
- **(c) Table → text rule.** The spike joins cells (` | ` per row). Options: keep join, emit HTML
  (`<table>` like the VLM prompt asks for), or GFM markdown tables. Merged-cell spans are currently
  duplicated across offsets — needs a rule.
- **(d) Fixture is schema-sourced, NOT live-verified.** `test/fixtures/docling-document.json` was
  hand-built from the docling-project docs (2026-07-08), not captured from a running server.
  **Pre-merge gate:** run docling-serve (Docker on the Mac mini) against a real PDF, capture its
  `document.json_content`, and diff the decode against this fixture — reconcile any field-name or
  origin drift before this becomes milestone work.
- **(e) Default registry vs behind a flag.** Should `docling-serve` ship in the default `PARSERS`
  list (selectable but inert without a base URL, as here), or stay behind an opt-in
  flag/env/build so `okra parse` never advertises a parser most users can't run?

### Also flagged for the owner (schema uncertainties to live-verify — item d)

- Table serialization: assumed `data.table_cells[]` with `start_row_offset_idx`/`start_col_offset_idx`
  (with a `data.grid[][]` fallback). Confirm which the live JSON actually carries.
- `coord_origin`: assumed values `BOTTOMLEFT` (default) / `TOPLEFT`; unknown → treated as BOTTOMLEFT.
- Multi-`prov` / cross-page items: the spike uses `prov[0]` only and skips prov-less items.
- `partial_success` status is treated as a failure (not decoded) — may want to decode it.
- `VlmHttpError` is reused as the engine's retry currency for a non-VLM HTTP parser; a rename to a
  neutral `TransportHttpError` would read better if this ships.
