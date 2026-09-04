# The discovery conformance corpus

The language-neutral fixture corpus for the five tier-2 discovery backends
(vllm, sglang, ollama, lmstudio, llamacpp — contract C1–C12 in
`docs/design.md`, "The discovery backends"). Every test vector for every backend — inputs, scripted
fake-fetch responses, and expected values — lives here as JSON.

**Provenance.** This corpus is the shared conformance contract consumed by the
Go port in the sibling repo **modelspoke-smith**: its replay runner loads
these files and drives its own backend implementations against the same
vectors this repo's test suites run. The TypeScript side loads the corpus
through the test-tree loader `test/discovery-corpus.ts` (the reference
interpreter; never imported from `src/`, never ships). Expected values were
extracted verbatim from the per-backend test suites and must stay
**byte-stable**: a change to any fixture or expected value is a deliberate
contract change and must be applied to both implementations in the same
change. Never "fix" a value that looks wrong in only one place — flag it and
change both sides or neither.

## Layout

```
contract/
  README.md                    ← this file (the format specification)
  fixtures/
    vllm.json      32 vectors   (catalog-only ModelCard backend)
    sglang.json    81 vectors   (serverInfo shape-gated enrich)
    ollama.json   102 vectors   (per-model /api/show + cap-4 batch)
    lmstudio.json  97 vectors   (native /api/v1/* + registry pins)
    llamacpp.json  93 vectors   (/props probe, GGUF shape gates)
```

Each file is a self-contained JSON document:

```json
{
  "corpus": "modelspoke-discovery-conformance",
  "formatVersion": 1,
  "backend": "<backend id>",
  "pins":    { "<name>": <scalar> },          // optional (lmstudio uses it)
  "fixtures": { "<NAME>": <shared data> },    // $ref targets
  "vectors":  [ <vector>, ... ]
}
```

- `corpus` — always the literal `"modelspoke-discovery-conformance"`.
- `formatVersion` — `1`. Bump when the vector shape itself changes (never
  silently: a bump means every consumer must be updated).
- `fixtures` — verbatim shared data (response bodies, catalog entries,
  lookup tables). Any string starting with `$` inside `vectors` (or inside a
  fixture) is a `$ref` into this map by name; refs resolve deeply and
  recursively, and a cycle is an error. Fixtures keep large payloads
  (a full `/props` body, an `/api/show` response) single-sourced.
- `pins` — optional named scalars/objects the backend pins (e.g. lmstudio's
  registry `backendId` / `ridesDirectlyAfter`).
- `vectors` — the ordered test vectors (see below).

## The vector record

```jsonc
{
  "id":    "<area>/<case>",        // unique within the file; kebab-case
  "op":    "<backend>.<operation>",// the dispatch key (see the op catalog)
  "suite": "optional suite name",  // documentation only
  "title": "optional one-line intent",
  "input": { ... },                // op-specific arguments (may $ref fixtures)
  "fetch": [ <FetchStep>, ... ],   // optional scripted fake-fetch script
  "expect": { ... }                // the expectation block (may $ref fixtures)
}
```

`$NAME` refs (a leading `$` on a string) are replaced by the fixture value
**before** the vector runs, deeply (objects/arrays too). Unknown names are a
load error, as are cycles. Everything must remain plain JSON — no comments,
no computed values, no ordering dependencies between vectors.

## The fetch script (`fetch`)

Each vector may carry an ordered list of steps; the fake fetch (TS) / stub
(Go) checks them **in order** against each request and answers with the
first matching step's reply. A request matching no step answers
`404` with body `"nope"`. Every call is recorded to a call log the
expectation blocks can assert against.

```jsonc
{
  "when": {                       // ALL provided fields must match; omitted = catch-all
    "pathSuffix": "/props",       // URL ends with this
    "url": "http://h:1/props",    // exact URL
    "method": "GET",              // case-insensitive
    "bodyJson": { "model": "m" }  // deep-equal against the parsed JSON body
  },
  "reply": {                      // exactly one of json/text; throw optional
    "json":   { ... },            // body = JSON.stringify(json), Content-Type application/json
    "text":   "{ not json",       // raw body
    "status": 404,                // default 200
    "throw":  "network"           // "network" → TypeError("fetch failed")
                                  // "abort"  → DOMException AbortError
  }
}
```

The fake always answers with `Content-Type: application/json` (regardless of
payload) — implementations must not depend on any other response header.
Call recording happens before matching, so a call that matches no step (or
throws) still counts toward `fetchCount`/`calls` expectations.

Conventions: `input.signal: "preaborted"` means the caller passes an
already-aborted `AbortSignal`; `input.apiKey` (when present) rides the
request as `Authorization: Bearer <key>` (C7) and is checked via the
`calls` block.

## The expectation interpreter (`expect`)

Blocks are all optional; a vector asserts exactly what its block spells —
nothing more. `null` as a target value means "the value at this path must be
absent or `undefined`" (in the JSON rendering these are the same thing; that
is the intended semantics for key-absence pins). Deep equality otherwise.

| block | semantics |
|---|---|
| `eq` | the whole result deep-equals the value (`null` ⇒ result is undefined) |
| `defined` | the result itself is defined |
| `fields` | map of `"dotted.path" → value`; value `null` ⇒ path is undefined/absent; `{ "falsy": true }` ⇒ falsy; `{ "defined": true }` ⇒ defined |
| `jsonNotContains` | array of substrings that must not appear in `JSON.stringify(result)` |
| `urls` | exact ordered list of recorded call URLs |
| `fetchCount` | exact number of recorded fetch calls |
| `neverSuffixes` | URL suffixes with ZERO recorded calls |
| `suffixCounts` | `[{ "suffix": "...", "count": N }]` exact per-suffix counts |
| `calls` | ordered per-call matchers: `index?`, `url`, `urlSuffix`, `method`, `headers` (subset match), `notHeaders` (header must be absent), `bodyJson` (deep-equal), `signal: "given"` (a signal was passed) |
| `byId` | `[{ "id": …, "canonical": <deep value or null> }]` — the id must be PRESENT in the `byId` map; `canonical: null` ⇒ the map value is present-but-undefined; otherwise deep-equal. Accepts a raw `Map` or a `{ byId: Map }` wrapper |
| `byIdFields` | `{ "<id>": { "<dotted path>": value } }` — per-field asserts inside one map value |
| `byIdAbsent` | ids that must NOT be in the map |
| `byIdSize` | exact map size |
| `byIdKeys` | the SORTED key list |
| `rows` | deep-equal on `result.rows` (or the result itself when it is the array) |
| `gated` | deep-equal on `result.gated` |
| `notes` | deep-equal on `result.notes` |

The canonical reference implementation of all of this is
`test/discovery-corpus.ts` (`assertExpect` + `fakeFetch`) — the Go replay
runner implements the same semantics against these JSON files.

## The op catalog

An `op` is an opaque dispatch key; a replay runner maps each to its function
call with the vector's `input` as the argument record (key names match the
TS parameter shapes):

| backend | op | input shape | result asserted |
|---|---|---|---|
| vllm | `vllm.entryMatches` | `{ entry }` | boolean |
| vllm | `vllm.detect` | `{ baseUrl, entries, apiKey? }` + fetch script | detect verdict + fetch discipline |
| vllm | `vllm.detectVerdict` | same, probe-path verdicts | verdict fields |
| vllm | `vllm.rows` | `{ entries }` | byId map (pure rows) |
| vllm | `vllm.enrich` | `{ entries, baseUrl, facts? }` + fetch script | byId + notes + fetches |
| sglang | `sglang.mapModelInfo` / `sglang.serverInfoContextWindow` | model-info objects | mapping object |
| sglang | `sglang.probeModelInfo` / `sglang.fetchServerInfo` | `{ origin, … }` + fetch script | probe/mapping results |
| sglang | `sglang.rowsById` / `sglang.enrich` | entries (+facts/baseUrl) | byId rows seam |
| ollama | `ollama.familyLookup` | `{ parser?, family?, isCloud }` | map or absent |
| ollama | `ollama.modelfileParser` | `{ show }` | parser string or absent |
| ollama | `ollama.showToCanonical` | `{ id, show, serverVersion? }` | `{ discoveredCanonical, gated }` |
| ollama | `ollama.versionGate` | `{ requires, serverVersion }` | boolean |
| ollama | `ollama.origin` / `ollama.probeVersion` / `ollama.show` / `ollama.showBatch` | origin-scoped inputs + fetch scripts | per-op results (map results use `byIdSize`/`byIdKeys`) |
| ollama | `ollama.metadataRows` | `{ entries, shows, serverVersion? }` | `{ rows, gated }` |
| ollama | `ollama.detect` | `{ baseUrl, entries }` + fetch script | detect verdict |
| lmstudio | `lmstudio.thinkingLevelMap` / `mapModel` / `origin` / `probeModels` / `payloadGate` / `detect` / `enrich` | as in `test/lmstudio-discovery.test.ts` | ditto |
| llamacpp | `llamacpp.origin` | `{ base }` | origin string |
| llamacpp | `llamacpp.isOwnedBy` / `hasGgufMeta` / `isCatalogEntry` / `hasLlamaSwapProvenance` | `{ entry }` | boolean |
| llamacpp | `llamacpp.fetchProps` | `{ origin, apiKey?, signal? }` + fetch script | `{ props?, inconclusive? }` |
| llamacpp | `llamacpp.propsToCanonical` | `{ props (null ⇒ undefined), entry }` | `{ discoveredCanonical }` |
| llamacpp | `llamacpp.rowsById` | `{ entries, props (null ⇒ undefined) }` | byId map |
| llamacpp | `llamacpp.detect` | `{ baseUrl, entries, apiKey? }` + fetch script | verdict (+`facts`) |

Conventions shared by every backend file:

- `input.signal: "preaborted"` — the caller passed an already-aborted
  `AbortSignal` (the C6 abort discipline).
- `input.apiKey` rides as the C7 Bearer header; its presence/absence is
  asserted through `expect.calls[].headers` / `notHeaders`.
- A `null` inside an op input where the TS signature is optional
  (e.g. `llamacpp.propsToCanonical` `props`, `llamacpp.rowsById` `props`)
  means the argument is `undefined`/absent.

## How to add a vector

1. Add the vector to the backend's `contract/fixtures/<backend>.json`
   (unique `id`, an existing `op` — introducing a new op means updating the
   op catalog above and BOTH replay runners).
2. Reference it from the backend's test file (`vectorOf(id)` for explicit
   cases or a `vectorsOf(backend, op)` prefix filter for a family of cases).
   The TS loader fails loudly on unknown `$ref`s, `$ref` cycles, duplicate
   ids, and missing vectors — run the suite; it is the validator.
3. Never edit an expected value without a deliberate reason: these files are
   the conformance contract for modelspoke-smith. A corpus change that is
   not mirrored in the Go runner (or vice versa) is a bug.

## Gaps — what deliberately stays in the TypeScript tests

Some behaviors are not expressible as JSON vectors and remain inline in the
TS suites (the Go port covers them with its own unit tests):

- **Timers / in-process concurrency**: the ollama cap-4 in-flight batch
  discipline and the abort-mid-batch test (measured through a concurrency
  counter and an in-process `AbortController`).
- **In-process handler state**: the channel-handler branches (detection
  memos, per-call probe reuse via `facts`, log lines) — they depend on
  `makeChannelHandler` and `vi.stubGlobal`; the corpora supply their
  fixtures.
- **Live E2E suites**: all five backends end with an optional, double-gated
  live probe against the local server (real network, skipped cleanly).

## Provenance of the data itself

The fixtures are recorded wire shapes, not inventions: the Ollama `/api/*`
bodies were live-derived from the reference server (Ollama 0.32.15,
2026-08-26, docs/provider-details.md §3.2), the LM Studio shapes from the
documented `/api/v1/*` responses (docs/provider-details.md §3.6), the
sglang shapes from the live server-info endpoint (docs/provider-details.md
§3.5), the vLLM shapes from its ModelCard schema (docs/provider-details.md
§3.4), and the llama.cpp shapes from llama.cpp tools/server
`server-context.cpp` / `server-models.cpp` (docs/provider-details.md §3.3,
2026-08-26). Where a fixture
represents a false-positive guard (the llama-swap catalogs), the exact
live-observed shape is pinned — these are the correctness-critical vectors.