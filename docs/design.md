# modelspoke — design

## Problem

Local OpenAI-compatible model servers (llama-swap, llama-server, vLLM, sglang,
Ollama, LM Studio) serve `GET /v1/models`, but with two gaps that force
per-model hand-configuration in every coding agent that connects to them:

1. **No reasoning-effort discovery.** `/v1/models` from vLLM/sglang/
   llama-server/TGI/LM Studio is the basic OpenAI shape (`{id, object, ...}`)
   with no reasoning metadata. There is no standard field for "this model
   reasons" or "it accepts effort levels none/low/medium/xhigh." OpenRouter
   advertises a `reasoning` capability flag and `supported_parameters` (the
   HF-Chat convention), but that's capability, not an effort-level map.
   llama-swap invented `meta.llamaswap.{reasoning,thinkingLevelMap,compat}` to
   push authored metadata into the discovery response — but that's
   llama-swap-only, and only the `pi-llama-swap` extension consumed it. dsh and
   every other agent saw nothing.
2. **Runtime-control dialects vary.** Local servers mostly reject the OpenAI
   top-level `reasoning_effort` parameter (pi-ai explicitly lists Ollama, vLLM,
   and SGLang as needing `supportsReasoningEffort: false`). Instead they drive
   thinking through the chat template: `chat_template_kwargs.enable_thinking` +
   `reasoning_effort` (Qwen3 family), Ollama's `think` field, etc. pi-ai
   already abstracts these via the `thinkingFormat` enum (`chat-template`,
   `qwen`, `qwen-chat-template`, `openai`, `openrouter`, …), but a client still
   has to be *told* which dialect and which effort vocabulary a given model
   uses — out of band, because the server doesn't say.

A third, user-facing gap followed from the first: **no local-vision
declaration.** dsh's `read_image` tool refuses at execution time unless the
routed model declares image input, and the stock custom-provider UI exposes no
modality field — a stock route can never declare image input, so local vision
models were unreadable through the user surface (verified A/B,
`testenv/evidence-vision.md`).

## Goal

One plugin that, for any local OpenAI-compatible server, discovers models and
supplies reasoning-effort metadata automatically — using built-in presets for
known model families, server discovery where available (llama-swap metadata
*and* each server's native discovery API), and user overrides where needed —
so users get working thinking control and local vision with zero per-model
config for common cases, manageable from the dsh web UI or a pi config file.

## Non-goals

- Not a model launcher or GPU manager (llama-swap already owns that).
- Not a generic LLM provider SDK — modelspoke delegates wire dispatch to
  `@earendil-works/pi-ai`.
- Not a catalog refresh into agent settings — modelspoke owns its provider
  routes and resolves dynamically (dsh's `LlmAdapter.listModels()` is async by
  design).
- No probing of model endpoints to discover accepted effort levels (real
  requests that can 400 mid-conversation — bad risk/reward).
- The Ollama `think`-field *preset* dimension (server-family presets keyed on
  the serving stack) remains out of scope — Ollama's *discovery* is in (the
  Ollama backend, below); the preset dimension is a v1.0 candidate if demand
  shows.
- Image request-budget/offload: the v0.1.1 send path ships images but does no
  context-budget management.

## Architecture

### Tiered reasoning-metadata resolution (four tiers)

For each served model, resolve
`{ input, reasoning, thinkingLevelMap, compat, maxTokens?, contextWindow? }`
by precedence — first non-empty wins **per field**:

1. **User override** — from the plugin-owned `modelspoke:` settings namespace
   (see User config). The escape hatch for "the preset is wrong for my quant"
   or "I don't own the server config." Dual shape, one tier:
   `routes[].overrides` (the home — the provider's own per-model
   configurations, keyed by wire id) and the legacy top-level `overrides:`
   map; per field the route's own entry wins over the top-level one, and the
   first web-UI write folds the legacy map into the routes (below).
2. **Server discovery** — the route's `/v1/models` catalog enriched by the
   tier-2 backends (below): llama-swap's `meta.llamaswap.*` for proxied
   catalogs, plus each server's native discovery surface (SGLang `/model_info`,
   Ollama `/api/show`, LM Studio `/api/v1/models`, vLLM catalog facts,
   llama.cpp `/props`).
3. **Built-in preset** — matched by model-id pattern against a bundled
   catalog (below). Fills the gap for servers that disclose nothing.
4. **Default** — non-reasoning, basic compat (`supportsDeveloperRole: false`,
   `supportsReasoningEffort: false` for local servers), `input: ["text"]`.
   The default tier invents no capacities: `contextWindow`/`maxTokens` are
   omitted when no tier supplied them.

Resolution is per-field, so one model can draw different fields from different
tiers. The resolver records a **per-field source map** internally
(`user | discovery | preset:<id> | default`). It is surfaced two ways (dsh's
model types have no metadata slot, so there is no first-class field): a
resolve-time **log line** with per-field detail, and a one-glance **suffix on
the model `description`** (e.g. `reasoning: preset:qwen3.8-chat-template`).
The settings UI renders the same tiers per field in the per-model detail
("your configuration" → "server discovery" → "preset" → "resolves at
runtime"). A wrong tier is diagnosable only if the user can see which tier
supplied the config — the reporting is part of the contract, not a nicety.
(One ops caveat: this dsh distro has
no node-side sink for plugin log lines, so the log line is invisible in
headless/web until dsh ships a log exporter — the description suffix and the
UI tier labels are the user-visible channels.)

**Context-window resolution** is a multi-convention fallback chain
(`extractContextWindow`, 11 slots — the port of pi-llama-swap
`lib/context.ts` plus sglang/vLLM `max_model_len`): `meta.llamaswap` →
`capabilities.context` / top-level `context_length` aliases → … →
`max_model_len` (that slot is **probe-gated** — enabled only for backends that
fetch it, so the default path advertises exactly the catalog). The
max-tokens chain mirrors the llama-swap port (top-level `output_length` /
`max_tokens`, then the `meta.llamaswap` block). The opt-in probes
(`src/discovery/probe.ts`: llama-server `/props`, llama-swap `/running`) exist
for future bare-server wiring; the `cmd`-parse fallback was deliberately
dropped (cmd strings can disagree with `/v1/models`, and llama-swap's
`/running` `cmd` leaks the live Hugging Face token).

### The discovery backends (tier 2)

`GET /v1/models` is the generic spine for every route. On top of it, a
**backend registry** (`src/discovery/backends.ts`; contract C1–C12,
summarized below) probes for a server-specific discovery
surface and enriches the catalog rows with facts the generic shape can't
carry. The registry order is LOCKED — **SGLang first** (it serves an
Ollama-compatible surface that could shadow real Ollama detection), **Ollama
second** (the incumbent), then the catalog-only detections:

```
[sglang, ollama, lmstudio, vllm, llamacpp]
```

The contract every backend obeys (C1–C12; the code comments cite these ids):

- **C1 — The interface.** Every backend implements `DiscoveryBackend`
  (`src/discovery/backends.ts`): `detect(ctx)` returns a verdict,
  `metadataRows(entries, ctx, facts)` returns per-wire-id FULL canonical rows.
  `DiscoveryContext` carries the baseUrl, the Bearer key, an `AbortSignal`,
  the already-fetched `/v1/models` entries (free detection signals), and an
  injectable fetch for tests.
- **C2 — Channel integration.** The channel probes the registry in order,
  memoized per route identity × backend, until the FIRST definitive
  `match: true` (a definitive non-match never stops the scan — "not Ollama"
  is not "not vLLM"); the matched backend FULL-REPLACES the rows it covers,
  and rows it doesn't cover keep the generic extraction.
- **C3 — Testability.** `ChannelDeps` takes an optional `backends` list
  (default = the shipped registry), so channel-branch tests pin their own
  backend lists and each backend's suite is self-contained.
- **C4 — Wire contract invariant.** The metadata wire model and the client
  half are untouched by every backend; enrichment never re-fetches a surface
  its `detect` already fetched (the facts ride the verdict).
- **C5 — What no backend may emit.** Never `maxTokens` (undiscoverable by
  design). Never `compat` (the one exception: llama.cpp's exact
  `chat_template_caps.supports_reasoning_effort` boolean). Never an invented
  `thinkingLevelMap`: a map may only list levels the server itself enumerates
  (1:1; the only local server that enumerates is LM Studio's
  `allowed_options`), an unlisted level is `null` (pi-ai clamps client-side),
  a backend that cannot enumerate levels emits NO map at all, and an all-null
  map is forbidden (clamping would land on `off` — thinking off when the user
  asked for on).
- **C6 — Fail-soft everywhere.** Any backend error (fetch failure, abort,
  malformed shape) degrades: detection → `inconclusive` for network/abort
  (NOT evidence — the memo evicts and retries) or a definitive non-match for
  a well-formed negative answer; enrichment → the affected model keeps its
  generic row, the rest of the batch is unaffected. A backend never throws
  into the channel, never fails the endpoint, never blocks on a slow probe
  (the handler's signal aborts).
- **C7 — Auth.** The route's Bearer key (resolved from `apiKeyEnv`) rides
  every fetch a backend makes.
- **C8 — Concurrency.** Per-model fetches: cap 4 (the Ollama `/api/show`
  batch); single-response servers: one fetch total.
- **C9 — Registry order (locked).** `[sglang, ollama, lmstudio, vllm,
  llamacpp]`. SGLang first: it serves a degraded Ollama-compatible `/api/*`
  surface and may answer `/api/version` with the Ollama shape — its
  authoritative `/model_info` must be probed before Ollama can claim it.
  Ollama second (the incumbent); the last two are catalog-derived, zero-fetch
  detections.
- **C10 — Detection discipline.** Detection may use the free `ctx.entries`
  signals before any fetch; a fetch-based probe is exactly ONE request; HTTP
  404/405/401 on the probe = DEFINITIVE non-match; 5xx / network / abort =
  INCONCLUSIVE. Each backend's probe endpoint + response-shape gate is locked
  (per-backend table below).
- **C11 — File map.** One `src/discovery/<backend>.ts` (+ optional lookup
  table file), one `test/<backend>-discovery.test.ts`, exactly two lines in
  `backends.ts` (import + registry entry) — no other shared file is touched
  by a backend.
- **C12 — Tests per backend.** Fixture-driven, no live dependency: the pure
  mapper + rows builder unit-tested, detection yes/no shapes, the channel
  branch over a pinned backends list; optional live E2E
  `describe.skipIf`-gated on a short-timeout probe, read-only endpoints only.
  The shared fixture corpus lives in `contract/`.

**Router-collision guards** — llama-swap itself is a router, and it answers
Ollama's `/api/version` *path* with its own build info (`{"version":"v250"}`)
and emits a top-level `meta`. The Ollama backend settles router-authored
catalogs (`meta.llamaswap` / `owned_by: "llama-swap"`) as NOT-Ollama with
zero fetches, and the llama.cpp GGUF-meta gate is SHAPE-GATED on the core
GGUF fields (`n_vocab`/`n_ctx_train`/`n_embd`/`n_params`/`size`/
`vocab_type`) so a bare `n_ctx`-only `meta` can't claim it. The primary
router must never be mistaken for a backend.

Per-backend facts (all live-verified; docs/provider-details.md records how
each server derives what it exposes):

| Backend | Surface | Contributes |
|---|---|---|
| SGLang | `GET /model_info` | `reasoning_parser` → `reasoning`; strict-boolean `has_image_understanding` → `input`; 3-step `contextWindow` chain (entry `max_model_len` → `server_args.context_length` → `token_capacity`) |
| Ollama | `GET /api/version` (dotted-version gate) + `POST /api/show` per model | `capabilities ∋ thinking` → `reasoning`; `capabilities ∋ vision` → `input` (from `/api/show` only — `/api/tags` under-reports); `model_info.<family>.context_length` → `contextWindow`; curated family table (modelfile `PARSER` → `details.family`) → `thinkingLevelMap` |
| LM Studio | `GET /api/v1/models` | `allowed_options` → `thinkingLevelMap` (1:1; `off` listed ⇒ `off`, the `"on"` default-on marker maps to no harness level, unlisted ⇒ null); loaded-then-max `contextWindow`; vision → `input` |
| vLLM | catalog only (zero fetches) | `owned_by: "vllm"` / `max_model_len` signature → `max_model_len` → `contextWindow` |
| llama.cpp | `GET /props` (cached, one fetch) | as-configured `n_ctx` (fallback `meta.n_ctx_train`) → `contextWindow`; `modalities.vision` → `input`; `chat_template_caps.supports_reasoning_effort` → `compat.supportsReasoningEffort` (the single C5 compat exception) |

The channel (`src/dsh/channel.ts` `discoverMetadata`) scans the registry in
order; the first DEFINITIVE match owns the enrichment, and rows the backend
doesn't cover keep the generic extraction (`meta.llamaswap` + basic OpenAI
fields + the context chain). The dsh host consumes the same canonical fields
through the same resolver — discovery is host-neutral.

Ollama additionally version-gates the family table: `/api/show` returns
`requires` (the minimum server version for the model's renderer/parser); when
the server is older, the backend still emits reasoning/input/contextWindow
but SKIPS the family-table map (the engine behavior the table describes is
not what that server runs) and logs one line.

### Shared core + the dsh adapter

The core is framework-neutral (`src/{discovery,resolve,presets,config,
overrides,types}`):

- `discovery/` — the `/v1/models` client, the tier-2 extractors
  (`metadata.ts` — the verbatim pi-llama-swap port with modelspoke
  adaptations), the backend registry + the five backends, and the opt-in
  probes.
- `presets/` — the bundled catalog + `matchPreset(modelId)` + the provenance
  sidecar (`provenance.json`).
- `resolve/` — the four-tier resolver with per-field merge and source map
  (`resolver.ts`), the canonical-boundary helpers (`canonical.ts`), and the
  wire-facing reasoning shim (`wire.ts`, below).
- `overrides.ts` — the dual-shape tier-1 readers, the first-write fold, and
  the phantom-default inverse (pure, host-agnostic).
- `types.ts` — the canonical contract (below).

**The canonical shape is pi-ai's `Model` fields, verbatim.** Both hosts bottom
out in `@earendil-works/pi-ai`, so the core speaks pi-ai's vocabulary directly
and each adapter translates. A preset (and an override entry) is preset
identity — `id`, `match`, `notes?` — plus a partial pi-ai `Model`:

- `input?: ModelModality[]` — default `["text"]`; pi-ai's `Model.input` is
  required, so the resolver must always produce one.
- `reasoning?: boolean`
- `contextWindow?: number`
- `maxTokens?: number`
- `thinkingLevelMap?` — pi-ai's raw form: `null` marks a level unsupported,
  non-null selectable. Canonical spelling DROPS null entries (they're stripped
  at every tier→canonical boundary); the `off` entry is spelled
  `off: "low"` canonically (non-null so it's selectable; its value is moot
  under `omitWhenOff`). On the RESOLVED object, present-empty `{}` is the
  explicit-none (nothink) state — see User config.
- `compat?` — pi-ai's `OpenAICompletionsCompat` verbatim. `thinkingFormat`
  lives **inside** `compat` (that's where pi-ai puts it); there is no
  top-level `thinkingFormat`.

Presets carry **no display name** (a family-level preset would give every
matching model the same picker name). Display name = discovery's `name` when
the endpoint supplies one, else the wire id; per-model cosmetics are an
override entry's job.

**Model identity.** A per-model entry has TWO ids:
`name` — the
**harness identity** (what the model selector keys on, what per-model config
is stored under; required, unique within a provider) — and `id` — the **wire
id** (what is sent to the provider; editable, chosen from the discovered
catalog or typed). Duplicate wire ids with different names are legal
(variants of the same endpoint model — the nothink copy is the standing
example). On a route with an explicit served set, the offered rows are the
entries' `name`s; on a full-catalog route, the harness id IS the wire id. The
resolver always runs on the **wire id**; the built pi-ai Model carries the
wire id; that is what dispatches.

Host adapters are thin shims:

- **dsh adapter** — a raw `LlmAdapter` subclass (NOT `PiAiAdapter`: dynamic
  user-chosen routes don't fit its static `profiles()` hook). The plugin
  declares a configurable-provider entry via
  `ctx.llm.registerConfigurableProviders` — one directory entry per route
  (per-route `settingsPath` + credential dot) — and owns the `modelspoke:`
  settings namespace in dsh settings. Users create routes there (the UI
  speaks "providers"; the yaml key keeps its historical name) and the plugin
  activates them via `registerAdapter`. `ctx.llm.registerModelDiscovery`
  offers the settings surface the raw `/v1/models` interrogation when a user
  adds a route (deliberately unfiltered — the picker must see the raw endpoint
  catalog; only the two OFFER sites apply the served set).

  - `listModels` — advisory catalog: the route's **served set** (below), each
    row resolved through the full four-tier chain on its wire id so it carries
    the source-suffix description. A discovery failure rejects (the catalog is
    genuinely unavailable).
  - `resolveModel` — authoritative for one (provider, model): the entry `name`
    on an explicit route (not found → NO_MODEL), the wire id on a
    full-catalog route (any id — the resolver runs even for ids discovery
    didn't list; a discovery failure degrades to the remaining tiers rather
    than rejecting). `info.id` equals the requested model (the
    `normalizeModelInfo` contract); the built pi-ai Model carries the wire id.
  - `prepareCall` — the **generation freeze**: route facts (baseURL, key env)
    + the resolution + the built pi-ai Model are captured in one generation so
    a settings change between preparation and dispatch cannot mix one
    generation's capabilities with another's endpoint. A mid-session route
    edit takes effect next session, never mid-turn.
  - `stream` — pi-ai `streamSimple` (the openai-completions api, direct) with
    events translated to dsh `StreamChunk` (usage before the terminal finish,
    nothing after; tool arguments remain raw JSON strings; terminal
    error/aborted for pi-ai error events).
  - **Effort resolution is pi parity.** The effective effort per dispatch:
    the per-request effort (the host's materialized session effort) > the
    per-model `defaultEffort` (explicit entry, or the per-route override's on
    FULL_CATALOG) > the built-in fallback `medium` (pi's session default). The
    result is clamped to the model's offered levels (pi-ai's
    `clampThinkingLevel` — nearest offered level, walking outward in canonical
    order): a thinking model never dispatches without an effort, an
    out-of-list or off-vocabulary level degrades instead of rejecting, and a
    clamp landing on `off` sends no effort at all. modelspoke never throws
    `UNSUPPORTED_REASONING_EFFORT` (the dsh-llm layer still validates
    caller-supplied efforts against the offered set).
  - **Attribution headers are a hard contract:** every provider HTTP request
    carries `attributionHeaders()` via the per-request `headers` option (the
    layer that wins over `Model.headers` and provider defaults); a wire-capture
    test proves it. Bearer auth only when the route's `apiKeyEnv` resolves
    non-empty — keyless routes ride pi-ai's `authorization: null` suppression
    so NO Authorization header goes out.
  - `ReplayEnvelope` = the pi-ai `AssistantMessage` serialized,
    response-level.
  - **Image handling** — see the Image handling section.

- **pi adapter — PARKED (removed from the 0.1.0 package, 2026-09-01).**
  Code-complete, and its activation check passed on 2026-09-01
  (`pi -e <dir> --list-models` under pi 0.84.2 against a live llama-swap —
  15 models listed under provider `modelspoke`), but the owner removed it
  from the package: shipping an alpha host in the same package as the dsh
  plugin is a liability until building the pi host is a deliberate decision.

### The wire shim (nothink models, BUG-001/002)

pi-ai's openai-completions request builder gates EVERY thinking-format branch
— including the only `chat_template_kwargs` emission — on `model.reasoning`
(BUG-002, upstream, still present in the newest pi-ai; deliberately not filed
— the project's triage is not receptive to outside reports). A nothink entry
(the explicit-none sentinel) resolves to `reasoning: false`, so the gate is
closed and the request carries zero thinking control — on a template whose
DEFAULT is thinking ON (Qwen3.8), "send no control" means "think"
(BUG-001, observed live).

The sanctioned divergence (`src/resolve/wire.ts`, the dsh adapter consumes it):
`reasoning` has two separable roles — the **dimension** (what the UI offers;
owned by `resolved.reasoning` — a nothink model offers no dimension; an
explicit effort on it clamps to `off` and sends nothing, pi parity) and the
**wire role** (which pi-ai
branches may fire). `wireReasoning` opens the wire role for exactly one shape:
an EXPLICIT nothink entry whose resolved compat declares a `chat-template`
`chatTemplateKwargs` block (the author wired the template's thinking state
into the wire, so "no thinking" can only be expressed by SENDING the explicit
off that the `{$var: thinking.enabled}` binding resolves to with no effort —
`enable_thinking: false`, live-verified on the wire). No declared kwargs ⇒ no
wire intent ⇒ unchanged (never silently invent a wire parameter); no other
`thinkingFormat` is touched. `wireThinkingLevelMap` re-spells the canonical
map as the raw pi-ai wire form (absent → pinned `null`, offered `off` → key
absent, others verbatim) plus the shim case: the wire model is reasoning but
offers no selectable level, so pi-ai's supported levels are exactly
`["off"]` — the nothink presentation carried on an open wire gate.

### Image handling

**Declaration.** `input: ["text", "image"]` is a resolvable canonical field
(user > discovery > preset > default). dsh's `read_image` tool
(`@deepseek-ai/dsh-tool-fs`) self-gates at execution on the resolved route's
declared modalities — so the declaration is the whole capability surface:
presets pre-declare it, discovery supplies it (vision capabilities), the UI's
per-model "Image input" checkbox pins it. The stock custom-provider UI has no
modality field, so stock routes can never pass the gate — verified A/B that
this is the differentiator at the user surface (live A/B evidence —
`testenv/evidence-vision.md`, local-only).

**Send path (v0.1.1).** dsh's durable history keeps image blocks (composer
paste, `read_image` tool results) as content-addressed
`ImageAttachmentRef`s. Per dispatch, `toPiContext` (now async) resolves
durable bytes through the attachment store (the adapter passes
`resolveAttachments: () => ctx.get("attachments")` — read per dispatch, so the
plugin boots fine without the store) and projects:

- user image blocks → base64 `ImageContent` (crosses the wire as an
  `image_url` data-URL part);
- tool-result image blocks → the tool slot keeps its text, the images are
  lifted into a synthesized `user` message (pi-ai's openai-completions wire
  shape, verified in both the dsh-bundled 0.82.1 and the 0.84.2 dev
  dependency); an image-only result lifts the text to `"(see attached image)"`.

**Guard invariant: `toPiContext` never hard-fails a turn on durable history
content.** A throw on persisted content is always a thread-killer (the block
can't be deleted, so the thread is permanently dead — this WAS the v0.1.1 bug:
a pre-fix poisoned thread died on every subsequent turn). Undeliverable
images project to DETERMINISTIC placeholder text: store unmounted → no-store
placeholder; per-image read failure → per-attachment placeholder + one log
line (a lost attachment kills one image, not the thread); assistant-side
image → placeholder (pi-ai's `AssistantMessage` has no image member — a
defensive invariant, no current chat adapter produces them). A live ABORT
mid-read still propagates (cancellation, not a history defect).
Already-poisoned threads recover on their next turn — no migration.

**Deferred:** per-route image request budget + offload
(`offloadRequestImagesWithPolicy` — the `LlmRuntime` does no offloading
itself; the reference adapter does it in its own `toPiContext`). Budget the
whole request, not just image bytes: the 400
`CONTEXT_WINDOW_EXCEEDED` interaction (`input + max_tokens > ctx`, sglang
doesn't clamp) was observed on TEXT-ONLY long history.

**Chat rendering.** The web GUI's generic tool card JSON-stringified
image blocks (upstream gap in dsh). The
plugin ships a keyed `tool.call.toolview` view for `read_image` (envelope text
+ rendered inline image from the durable store) gated by the
`renderReadImages` setting (default on): off → the view deregisters entirely
and the host's own rendering owns the row. When upstream ships the host fix,
flip the flag, delete the view — one key, zero migration.

### One package, three faces

A single npm package declares all host manifest fields in `package.json`:

```json
{
  "main": "./dist/dsh/index.js",
  "dsh": {
    "bundle": { "patch": "./dsh.cordis.yml" },
    "client": { "platform": "web", "inject": [ … ], "external": [ … ] }
  },
  "exports": {
    ".": "./dist/dsh/index.js",
    "./client": "./dist/dsh/client.js",
    "./lib": "./dist/lib.js",
    "./package.json": "./package.json",
    "./dist/*": "./dist/*"
  }
}
```

- **dsh node half** (`.` / `dsh.bundle.patch`) — the Cordis plugin: adapter,
  settings namespace, the loopback RPC channel, the boot hint.
- **dsh client half** (`./client` + `dsh.client`) — the web UI bundle (below).
  The host scanner auto-detects the bare package name and serves the bundle at
  `/plugins/modelspoke/client.js`; package metadata is cached per name for
  process life, so ONE dsh restart switches on a repackage (HMR-only for
  content changes after).
- **library face** (`./lib`) — the framework-neutral core as a stable library
  surface (`src/lib.ts` barrel): the C1–C12 discovery contract + the five
  backends, the canonical types, and `resolveModel`. Deliberately NOT exported:
  anything from `src/dsh/` (the channel orchestration is
  dsh-shaped — a library consumer brings its own) and a preset-lookup API
  (grow per consumer need). Pre-1.0 semver: breaking changes allowed; this is
  the declared boundary, everything below it is internal — enforced by a
  boundary-guard test (`test/lib-boundary.test.ts`: the core never imports
  from the host dirs or host packages). First consumer: modelspoke-smith
  (sibling repo).

Install is per-agent (each agent owns its plugin directory). Host-adapter
dependencies (`@deepseek-ai/dsh-llm`/`dsh-settings`/`cordis`/`schemastery`)
are optional peers so a library-only install doesn't force the dsh host
deps.

### User config (decision)

Per-agent, plugin-owned settings namespace — the dsh-native location for
per-agent state: a `modelspoke:` section in `~/.dsh/settings.yaml` (the pi
adapter reads the same section shape as JSON). Contents:

```yamlc
modelspoke:
  routes:            # the UI's "providers"
    - name: llama-swap        # user-chosen provider key (unique, identity)
      baseURL: http://127.0.0.1:8080/v1
      apiKeyEnv: LLAMA_SWAP_API_KEY   # optional; the VALUE is never stored —
                                      # the route reads process.env only
      # The route's SERVED SET: one entry per model it serves.
      # Presence in the list = served. Absent / [] = FULL_CATALOG.
      models:
        - name: qwen3.8-27b   # harness identity (selector key, config key)
          id: qwen3.8-27b-6000pro   # wire id (what dispatches)
          defaultEffort: medium     # per-model, optional (dsh only)
          # …plus the canonical fields when the user configures them:
          # name-cosmetics already covered; contextWindow, maxTokens,
          # input, reasoning, thinkingLevelMap, compat
      # Per-route override map — meaningful while FULL_CATALOG:
      # exact WIRE id → the canonical entry (same shape as a top-level
      # override entry). On an explicit route the config lives ON the
      # entry above instead.
      overrides:
        qwen3.8-27b-mtp: { contextWindow: 32768 }
  overrides:          # LEGACY top-level shape (pre-reorg, hand-edits, the pi
    # set-context-length command). Still fully read; a same-id entry on the
    # route itself wins per field. Folded on first web-UI write.
  renderReadImages: true   # the read_image view's client presentation flag (node never reads it)
```

- **routes** — `{ name, baseURL, apiKeyEnv?, models?, overrides? }[]`. `name`
  is the user-chosen provider key. There is NO provider-level `defaultEffort`
  (removed 2026-08-26 — effort is per-model only; a provider default is a
  silent behavior that varies per model).
- **The served set** (`models`) — entries as above: `name` (harness identity,
  required, unique within the provider), `id` (wire id, required), optional
  `defaultEffort` (the model's default effort — second in the pi-parity chain
  after the per-request effort, clamped to the offered levels; on FULL_CATALOG
  routes the field lives on the model's per-route override entry), plus
  canonical fields when configured.
  Duplicate wire ids are legal (named variants); a missing `name` normalizes
  to the `id` (harness-id stability across the model-identity migration). Absent/`[]` =
  FULL_CATALOG (serve the whole discovered catalog, harness id = wire id);
  the first EDIT of a FULL_CATALOG route (remove a row, add a non-catalog id,
  or edit a row's config) materializes it to EXPLICIT — `models` seeded from
  the fetched catalog (each `{name: id, id, …legacy per-wire-id config}`),
  then the edit applied — while a FULL_CATALOG route that is only viewed
  stays FULL_CATALOG and writes nothing. The writer is byte-preserving: an
  untouched route round-trips its exact stored bytes. A legacy string
  allow-list is not a
  supported stored form (the lenient reader degrades one to FULL_CATALOG).
- **overrides (dual shape)** — exact wire-id → canonical entry (per-field
  merge with lower tiers; a per-model `name` for display cosmetics).
  `routes[].overrides` is the HOME; top-level `overrides:` is LEGACY.
  Per field: route-level entry > legacy top-level > discovery > preset >
  default — the tier order is unchanged, only tier 1 gained a second
  location.
- **First-write fold** — any web-UI section write over a section that still
  carries legacy top-level entries first folds them: one provider →
  everything moves into it; several providers → an id in exactly one
  provider's served set folds there, an id in several folds to the first
  claimant in configuration order, everything else stays top-level. Values
  are byte-preserved (whole entries; the schema's resolved-view materialized
  **phantoms** are inverse-stripped first — `stripPhantomDefaults` /
  `cleanRoutePhantoms`, the exact inverse of schemastery's empty-default
  materialization); the top-level key is dropped when nothing remains.
  Mechanical, silent, lossless; existing customizations never become
  invisible.
- **nothink (explicit none)** — `thinkingLevelMap: none` (a STRING sentinel,
  never a map — the schema-resolved view materializes an absent map to `{}`,
  so only a string survives resolution as meaningful) declares "this endpoint
  copy has no selectable thinking levels" — the nothink qwen-copy-on-
  llama-server case (same wire id as the reasoning build, smaller context).
  The resolver EXPANDS it at the tier-1 boundary to `reasoning: false` + a
  present-empty level map, both sourced `user` (the dsh adapter then sees a
  plain non-reasoning model — zero special cases in the pi-model builder); the
  resolve log line ends with a `[nothink …]` marker. An empty MAP
  (`thinkingLevelMap: {}`) is NOT this state — it stays a phantom and reads
  as unset. The wire shim above makes the declaration actually work on
  think-by-default templates. Caveat: a nothink model accepts NO effort —
  any `reasoningEffort` on it clamps to `off` (pi parity — nothing is sent;
  the effort has no model to materialize on).

**First-use import.** A hand-written `llm-pi-ai` `llama-swap` block (like any
other custom provider) is imported through the single path below — the deep
config-import path is retired:

- **v1 (the onboarding step)** — an existing dsh **custom provider** → a
  modelspoke route. Offered when modelspoke has zero routes AND there is ≥1
  `llm-pi-ai.providers.*` entry with a LOCAL (loopback) baseURL — any name
  (the literal-`llama-swap` keying was a historical artifact of an early
  migration, not a product anchor). Default route name
  `modelspoke-<source>` (shadowing is opt-in, not the default); editable — a
  hand-written llama-swap block migrates with id continuity when the route is
  renamed onto the block's own key. A
  chosen name colliding with the full registrable set (all `llm-pi-ai`
  provider keys ∪ existing modelspoke route names ∪ the built-in pi-ai
  catalog ids — computed server-side) shows a non-blocking inline warning:
  the existing provider stays active and SHADOWS the route until removed
  (the batch registration is all-or-nothing). Key handling (the credential-
  ref impedance): env-sourced entry key → mapped to `apiKeyEnv`; value-stored
  (`.credentials.yaml`) → the route imports WITHOUT `apiKeyEnv` + an explicit
  UI note — the value is NEVER copied (modelspoke reads `process.env` only; a
  copied value is the green-dot-but-401 state). Server-side
  `provision` endpoint: explicit `{name, baseURL, apiKeyEnv?}`, idempotent
  (same name + same normalized baseURL = no-op; different baseURL = hard
  error), existing overrides never overwritten. Post-import: a cleanup pointer
  ("you can remove the source provider whenever — Settings → Models"); no
  server-side removal endpoint in v1 (cross-namespace WRITE is unverified).
- **Deep config-import path — RETIRED** — the hand-written
  `llm-pi-ai` `llama-swap` block + `config/llama-swap.yaml` (read from
  `$LLAMA_SWAP_CONFIG`, default `~/.pi/agent/llama-swap.yaml`) used to yield a
  route + FULL canonical override entries seeded into the route's own
  `overrides` map. llama-swap renders the yaml metadata into `meta.llamaswap`
  for every model regardless of load state, so the seeded values ≡ the live
  DISCOVERY-tier values (oracle-asserted) — the seed was redundant with what
  discovery already provides through the same route, and the dependency-free
  yaml parser was pure maintenance. The path is removed from the tree (no
  parser, no `firstUseImport` endpoint); a hand-written block now imports
  through the v1 path above, and per-model metadata resolves from discovery.

Both persist through the settings seam's revision-fenced whole-section
`replace` (`SETTINGS_CONFLICT` → the wire's `settings-conflict` code).

### The client UI (dual-face plugin)

The web UI is a **dual-face Cordis plugin** (`dsh.client` declaration + the
`exports["./client"]` bundle, react + jsx-runtime as the only runtime
requires) — a standalone-plugin constraint that held end to end: ZERO dsh
changes across the whole client build.
It is an editor for the `modelspoke:`
section, reachable through the open settings slots any loaded client plugin
can register into (the web app has no URL router — slots ARE the entry
surface):

- **`settings.section`** (id `modelspoke`, nav label "modelspoke") — the
  editor's home.
- **`settings.onboarding`** — the first-run step: import an existing local
  custom provider / the legacy llama-swap block, or Add-route manually.
- Wiring: route/override writes via `settings.mutate` + `settingsScope`
  (whole-array / whole-field sets with `expectedRevision` fencing and
  post-settlement read-back verification); live updates via the scope's
  `subscribe`; curation and per-model discovery facts via the
  `discoverModels` / `discoverMetadata` surfaces. All server reads that need
  cross-namespace settings or local files ride the **`/modelspoke` loopback
  RPC channel** (`ctx.connection.rpc.handle`, `{authority: "loopback"}` —
  the host's generic, bundle-open channel registry; the connection is read
  LAZILY — web profiles only, never a static inject — so the channel is a
  silent no-op in tui/headless): `onboarding` (readiness + the v1 offer set +
  the collision-name set), `provision` (the v1 import), `discoverMetadata`
   (per-route discovered catalog facts).

The section (the settings>Models mimic, and the settings iteration). The look is
copied from dsh's own Settings → Models screen (markup/CSS reference:
`packages/client/ui-settings-models/src/client/` in the dsh source checkout —
`ModelsSection.tsx`, `CustomProviderCard.tsx`, `ProviderEditor.tsx`,
`ModelListEditor.tsx`, `EditorFooter.tsx`): the module-CSS geometry ported
into the bundle's inline styles on the same `var(--dsw-alias-*)` design
tokens, which resolve at runtime inside the same settings dialog.

- **Provider rows** — `name` + a live status dot (green/red/never-checked,
  hover detail) + Edit / Delete (confirm-gated). Edit expands an in-place
  inset card: name (re-key editable — a rename carries the provider's models
  + overrides), Base URL, API key env, then the **model list** (the
  add/remove list — presence in the list IS served): fetched silently on
  expand, one row per model `[name][wire id][chevron][−]` — `name` is the
  harness identity (editable mono text, cleared name defaults to the id at
  commit, collisions refused inline and gate Apply, one-click rename fix),
  `id` is a combobox over the full fetched catalog (typeable, duplicate wire
  ids allowed as named variants). A single draft per section: the card's
  **Apply** button commits all pending fields (route + served set + per-model
  edits) through one fenced whole-section write — dirty = draft ≠ committed
  baseline, and a FULL_CATALOG baseline compares against its fetched-catalog
  seed, so an unedited seed reads clean and a viewed-only route writes
  nothing; Cancel reverts (and collapses).
- **Per-model detail** (the chevron) — the EDITABLE configuration surface:
  context window, max output tokens, a Capabilities group ("Image input",
  "Reasoning effort" — OFF = the nothink sentinel), the reasoning-effort map
  below it (harness level × model value rows, +/− buttons), and a per-model
  Default-effort select. Every untouched field is seeded from the effective
  entry (preset shown as the seed, never committed as a preset value —
  semantic dirty tracking, phantom-free writes). Deep `compat` fields
  (thinkingFormat, `chatTemplateKwargs` `$var` blocks) stay hand-edited YAML:
  read-only in the UI, PRESERVED byte-for-byte in every write (a partial
  compat write would replace the lower tier's entire block and drop the
  template bindings → mid-turn 400s). A draft-scoped Reset drops the entry
  (the model stays served).
- **Top-level overrides block** — renders only when the legacy map is
  non-empty: one row per entry with either **Delete** (orphaned — no route
  claims it) or a shadowed-by hint (claimed — deleting would change every
  other provider that inherits it; the provider card owns that judgment).
- **i18n** — the entire section + onboarding in en/zh (`src/dsh/locales.ts`,
  147 typed keys; locale resolution mirrors the host: dsh's durable
  `locale.preference` → browser, live via subscribe, fail-open to browser-
  only on a bind failure). The catalog `description` strings are localized
  too. Docs pair: `README.zh.md` + `docs/llama-swap-setup.zh.md` (human zh
  review is the pre-publish gate).
- **Boot hint** — a one-line log hint at first boot when zero routes exist
  (a fresh install is otherwise silent; settled on the first settings
  onChange, fired at most once).

### The preset catalog

A preset is **the contract between a model *template*'s jinja chat template
and the request.** It says: "this template exposes `enable_thinking` +
`reasoning_effort` kwargs accepting these values." The server only has to pass
`chat_template_kwargs` through to the template — which llama-server
(`--jinja`), vLLM, and sglang all do.

**Presets are per-template, never generic family catch-alls.** The Qwen family
is empirically non-uniform (verified from the templates in the model
artifacts, 2026-08):

| Template | effort levels | `preserve_thinking` when undefined | Preset |
|---|---|---|---|
| Qwen3.8 (FP8 + mtp GGUF) | `xhigh`/`medium`/`low` — template **raises** on anything else | preserves | `qwen3.8-chat-template` |
| Qwen3.6 (27B + 35B-A3B, identical) | none — no `reasoning_effort` in the template; on/off only | **strips** — `true` is behaviorally required | `qwen3.6-chat-template` |
| Qwen3.5 (4B GGUF) | none | variable doesn't exist | `qwen3.5-chat-template` |
| Qwen3-Coder-Next (GGUF) | none — no `enable_thinking` reference | variable doesn't exist | **NO preset** — the default tier is simply correct |
| gpt-oss-120b | `high`/`medium`/`low` (+ `off` = no effort sent, NOT think-off) | n/a — no `enable_thinking` | `gpt-oss-120b-chat-template` |

A family-wide generic preset would produce two silent failure modes on top of
the known hard one:

1. **Hard 400** — 3.8's template `raise_exception`s on an unsupported effort
   value; a preset asserting `high`/`max` 400s mid-conversation.
2. **Silent no-op** — 3.6/3.5 templates never reference `reasoning_effort`, so
   jinja ignores the kwarg; a generic preset carrying 3.8's effort map lets a
   user "pick" `xhigh` on a 3.6 model and the model thinks at whatever
   default. No error, no effect, broken trust.
3. **Silent quality regression** — the `preserve_thinking` default *flips*
   between 3.8 (undefined preserves) and 3.6 (undefined strips); omitting the
   kwarg silently strips all prior thinking on 3.6.

The degenerate on/off-only form needs no type change: canonical
`thinkingLevelMap: { off: "low", low: "low" }` (exactly two selectable levels;
`low` is a label for "thinking on" — its mapped value is never dispatched
since no effort kwarg exists), `reasoning: true`, `enable_thinking` bound,
**no** `reasoning_effort` key (a 3.6/3.5 template ignores it — we don't send
it).

Design rules:

- **Conservative.** Only include levels the template is known to accept — a
  wrong preset → 400 / silent no-op / silent regression (above).
- **Per-template.** One preset per verified template contract.
- **Overridable.** User override beats preset, always (per field).
- **Attributed.** The per-field source map reports `preset:<id>`.
- **No probing.** (Non-goal, above.)
- **Authoring source of truth = the template in the model artifact** —
  `chat_template.jinja` / `config.json` in the HF repo; GGUF metadata —
  never docs or memory (the pre-fix design example was written from memory
  and got three things wrong).

**Matching:** catalog-ordered first match, most-specific entries listed first;
the `match` pattern is an unanchored case-insensitive regex (so
`unsloth/Qwen3.8-27B-GGUF` matches). The curated catalog order *is* the
contract — no specificity scoring. A unit test pins the flagship id to
`qwen3.8-chat-template`. The catalog is the genuinely portable artifact: pure
data in pi-ai's vocabulary (no host code); it is versioned with the package.

**Provenance + tooling (drift-checker + the preset-draft build).** Each
catalog entry carries a provenance
sidecar (`src/presets/provenance.json`: template repo + pinned commit for the
HUB jinja AND the deployment GGUF copy, sha-verified). Two npm scripts (zero
runtime deps, Node native TS):

- `npm run drift-check` — fetches the pinned templates, byte-checks the shas,
  and re-derives the mechanical invariants (the `enable_thinking` polarity,
  the effort tuple from the raise-guard incl. alias rewrites, the
  `preserve_thinking` disjunct) against the catalog; exits non-zero on drift
  (or on a fetch that can't complete — a check that can't fetch is not a
  pass). It never writes a preset (a human re-runs the authoring pass).
- `npm run preset-draft` — given a repo + match pattern, probes the template
  spellings, re-derives the invariants, and emits a DRAFT catalog entry +
  provenance entry + a checklist of the JUDGMENT items with template
  excerpts alongside (pi-level alignment, degenerate forms, maxTokens policy,
  README-only vocabulary, identity-and-placement). Never-guessed fields stay
  on the checklist (`input` is NEVER template-derived; `maxTokens` is always
  deployment-derived). The draft self-checks against its own template before
  emission. The tool never ships a preset — a human reviews and commits.

Why build-time and not runtime: HF model cards are NOT a feasible runtime
preset source (the feasibility analysis is in the "Moved from code"
drift-invariants subsection below) — three contract-critical things are
unfetchable at runtime
(the local-id→repo edge; the GGUF in-force
template copy; the semantic mapping no template states). The user-facing HF
search option is a v2 candidate (suggest-only, human-approved). The
headline finding also motivates pinning BOTH copies: **hub and GGUF templates
diverge for real** (first live finding: the official `Qwen/Qwen3.5-4B` hub
template differs in `enable_thinking` polarity from the unsloth GGUF the entry
was authored from — the catalog is valid against both; the drift-check flags
it informationally).

### Server-family dimension (deferred)

The `chat-template` dialect is uniform across llama-server/vLLM/sglang, so
model-pattern presets are server-agnostic for those three. Ollama is the
outlier (its own `think` field) — its *discovery* is in (the Ollama backend's
curated family table supplies the effort map for known Ollama families), but
a `server` match dimension for *presets* is deferred until Ollama support
shows demand (v1.0 candidate).

## How it's validated

- **Core (dsh adapter + resolution + the Qwen3.8 preset)** — live-validated
  in the isolated `testenv/` home (multi-turn with tool calls at off/low/
  medium/xhigh through llama-swap + the preset path on bare llama-server;
  evidence in `testenv/evidence-live.md`, local-only). The **golden oracle
  test** — the resolved flagship equals the hand-written `llama-swap` block
  field-by-field — is the done-criterion as a permanent CI test. A permanent
  smoke gate (`testenv/run.sh "Reply with exactly the word: smoke-ok"` must
  end `completed` with provider `spoke-live`) runs after any change to the
  adapter's settings/registration wiring — glue bugs are invisible to unit
  tests (the NO_ADAPTER incident that established it).
- **Image send path + the guard invariant (above)** — live-verified end to
  end, including a pre-fix-poisoned thread recovering across a process
  restart.
- **Presets + context chain** — the preset set (4 entries, artifact-verified)
  + the context-chain port.
- **Discovery backends** — the five-backend registry, each with a conformance
  suite; the shared fixture corpus lives in `contract/` (the language-neutral
  contract for the modelspoke-smith Go port).
- **`./lib` export** — the framework-neutral core as a library surface (see
  the library-face entry above).
- **Standalone client UI** — zero dsh changes, every screen gate-verified in
  testenv (screenshots under `testenv/dsh-home/shot-*.png`, local-only).
- **Onboarding** — the custom-provider import.
- **Release-grade coverage** — the hermetic e2e journey suite
  (`test/e2e/e2e.test.mjs`, journeys J1, J2, J3, J4, J5-wire, J10, J11).
- **Bugs** — all bugs found pre-0.1.0 are fixed; the standing external
  dependency is the pi-ai `model.reasoning` gate (BUG-002), worked around by
  the wire shim (see the "The wire shim" section above). The pre-0.1.0 bug
  list was a local-only file, never part of the published tree.

### Day-1 spikes (all resolved — the facts that shaped the design)

1. **Dynamic route keys: YES.** The provider directory API is set-based with
   atomic `replace()`; the reference adapter re-derives its entries from
   whatever keys the user's settings section declares and swaps them on every
   committed change. Constraints: re-register the whole set on change; initial
   registration cannot be empty; `registerModelDiscovery` is one per
   namespace. (docs/dsh-plugin-guidance.md §1.5.)
2. **Attribution headers through pi-ai: the per-request `headers` option.**
   pi-ai merges `Model.headers` → provider defaults → options last (wins);
   `attributionHeaders()` (a `@deepseek-ai/dsh-llm` module export every
   adapter must honor) spreads last, and a `null` value suppresses a
   same-named default — a user's route headers can never override
   attribution. Proven by the wire-capture test. (docs/dsh-plugin-guidance.md §1.2.)
3. **Isolated test environment.** All manual validation runs against a dsh
   home separate from the live `~/.dsh` (`$DSH_HOME` → `testenv/dsh-home`;
   scripts in `testenv/` — `setup.sh` provisions the headless profile + a
   baseline copy of the live settings, `run.sh` drives one-shot turns,
   `add-plugin.sh` links the built package in). Verified: zero writes to
   `~/.dsh` across a full boot + turn; live model servers are shared by
   design (routes needing a key use a dummy env value). The live install that
   runs the dev session is never a test target.

## Decisions

| Question | Decision |
|---|---|
| Route naming | User-chosen route keys via `registerConfigurableProviders`. The UI speaks "providers"; the yaml key keeps its historical name (`routes:`). |
| Model identity | `name` = the harness identity (selector key, per-model config key; unique within a provider); `id` = the wire id (editable, catalog-combobox or typed; duplicates allowed as named variants). The resolver runs on the wire id; dispatch carries the wire id. |
| Default effort | Per-model only (`models[].defaultEffort`; on FULL_CATALOG routes the field lives on the model's per-route override entry). The provider-level `defaultEffort` was removed (a provider default is a silent behavior that varies per model). **Runtime resolution is pi parity**: per-request effort > per-model default > the built-in fallback `medium` (pi's `DEFAULT_THINKING_LEVEL`), then clamped to the model's offered levels (pi-ai's `clampThinkingLevel` - nearest offered level, walking outward). A thinking model never dispatches without an effort; a non-thinking resolution clamps to `off` (nothing sent); modelspoke never rejects an effort - it clamps. |
| Override config | Per-agent, plugin-owned namespace; DUAL SHAPE — `routes[].overrides` is the home, top-level `overrides:` is legacy-but-read; per field the route's entry wins; the first web-UI write folds the legacy map in (mechanical, silent, lossless, phantom-inverse-stripped). |
| Served set | Per-route `models` entries: presence = served; absent/`[]` = full catalog. (Promoted from the "12 extra models" annoyance found during testing.) |
| nothink | `thinkingLevelMap: "none"` string sentinel → the resolver expands to `reasoning: false` + present-empty map, both sourced `user`; the wire shim (BUG-001/002) makes it send the explicit `enable_thinking: false` on think-by-default templates. |
| Images | The real send path (attachment-store resolve per dispatch → base64 `ImageContent` / lifted tool-result images) + the guard invariant: `toPiContext` never hard-fails a turn on durable history content — undeliverable images project to deterministic placeholders. Request budget + offload deferred (budget the whole request, not just images). |
| Tier-2 discovery | A backend registry — SGLang, Ollama, LM Studio, vLLM, llama.cpp — under the C1–C12 contract: definitive detection (memoized; inconclusive = retry), fail-soft per field/model, NEVER invent (no `thinkingLevelMap` except LM Studio's 1:1 `allowed_options`; no `compat` except llama.cpp's exact `supports_reasoning_effort` boolean; no `maxTokens` from anywhere), router-collision guards so llama-swap never matches a backend. |
| `metadataSource` surfacing | Resolve-time log line (per-field) + model `description` suffix + the UI's per-field tier labels. (The dsh distro has no node-side plugin log sink — tracked upstream.) |
| Presets | Per-template, conservative, overridable, attributed. Four entries (3.8 / 3.6 / 3.5 / gpt-oss); Qwen3-Coder-Next = NO preset (the default tier is correct for it). Provenance-pinned (hub AND GGUF copies) + `drift-check` / `preset-draft` tooling; the tool drafts, a human commits. |
| First-use import | v1 = an existing dsh custom provider → a route (any name, local-only, `modelspoke-<source>` default, shadowing warned non-blocking, key refs never copied — env maps to `apiKeyEnv`, stored values never leave dsh). The deep config-import path (block + llama-swap.yaml seed) is retired — its seeded values were identical to the live discovery values. Cross-host (pi) import deferred (pi build parked — see the pi adapter row). |
| Client UI | A dual-face Cordis plugin — standalone, zero dsh changes. `settings.section` + `settings.onboarding` entry points; the `/modelspoke` loopback RPC channel for cross-namespace reads + the import endpoints (connection read lazily — a silent no-op without a web profile). |
| Package faces | `.` = the dsh plugin entry (Option A repackage); `./client` = the web bundle; `./lib` = the framework-neutral core (stability boundary, pre-1.0). The host deps are optional peers. |
| pi adapter | **Parked (owner decision, 2026-09-01): removed from the 0.1.0 package.** Code-complete, and the `pi -e` activation check passed before removal (pi 0.84.2, live llama-swap — 15 models listed). Revive on an explicit build decision. |
| Matching | Catalog-ordered first match, most-specific first, unanchored case-insensitive regex. |
| Test environment | Isolated `$DSH_HOME` = `testenv/dsh-home`; the live `~/.dsh` is never a test target. |

## Moved from code (comment cleanup 2026-09-02)

### scripts/drift-invariants.ts — extraction scope and deliberate exclusions

Per the template-extraction feasibility table ("Template -> metadata feasibility"; this subsection carries it), the mechanical extraction covers: qwen — enable_thinking gate polarity (the exact truth table over true/false/undefined), the accepted-effort tuple from the raise-guard + its default, pre-guard alias rewrites (the qwen3.8 GGUF 'high'->'xhigh' case), and the preserve_thinking keep-branch disjunct (does UNDEFINED preserve or strip); gpt-oss — reasoning_effort presence, the default literal, the ABSENCE of value validation (its {low,medium,high} vocabulary is README prose, not template — deliberately NOT asserted), and the unconditional "Reasoning: " render line.

What it deliberately does NOT do: the level->value cross-vocabulary mapping (off->low / off->medium are choices, not parsing), gpt-oss's vocabulary, maxTokens policy. Those stay human-authored in the catalog; the checker only proves the mechanical invariants are still true.

### scripts/gguf.ts — GGUF wire format and verification notes

Verified 2026-09 against the five pinned files (all version=3), cross-checked with the system `gguf` 0.17.x python lib, which reads the same KVs but crashes on the MXFP4 tensor TABLES — the prefix parser never reaches those.

magic "GGUF" (u32 LE), version (u32), tensor_count (u64), kv_count (u64). KV: key = u64 length + utf-8 bytes (no null, no padding — v2/v3 style), value_type (u32), value. Types: 0 u8, 1 i8, 2 u16, 3 i16, 4 u32, 5 i32, 6 f32, 7 bool, 8 string (u64 len + bytes), 9 array (u32 elem_type + u64 count), 10 u64, 11 i64, 12 f64, 13 string array (u64 count), 14 f32 array (u64 count).

### scripts/preset-draft.ts — the authoring pipeline

The tool: (1) probes which of the three template spellings the repo uses (`chat_template.jinja` file → `chat_template.json` file → API-embedded `tokenizer_config.chat_template`), or, for a GGUF repo, reads the GGUF-embedded `tokenizer.chat_template` (the bounded Range-prefix KV parse — the deployment's in-force copy for llama-server --jinja); (2) on a GGUF repo, emits a PROMINENT flag naming the ambiguous GGUF copies for human confirmation — it never silently picks the deployment artifact; (3) re-derives the mechanical invariants via the drift-invariants pipeline (imported, not duplicated — one pipeline, three consumers: protect / author / suggest) and self-checks the draft against its own template; (4) emits, to STDOUT and a DRAFT artifact file (default `preset-draft.<pattern>.md` in the cwd — a file the HUMAN copies from), the DRAFT catalog entry + the provenance manifest entry + the JUDGMENT-item checklist with template excerpts.

### scripts/preset-draft-core.ts — input modalities are never derived from the template

The draft NEVER derives `input` from the template alone. The qwen3.5 lesson is the binding precedent: structural image guards are inherited family structure, not modality evidence — the 3.5 entry omits `input` despite carrying them. So the draft omits `input` and reports the branch evidence; the human asserts `['text','image']` only if the artifact or deployment states the model is multimodal.

### test/overrides.test.ts — phantom compat strip (the live sglang 400, 2026-08-26)

The schemastery schema materializes phantom defaults on every resolved entry — `input: []` and `compat: { chatTemplateKwargs: {} }` even when the stored form is a bare `{ name, id }`. Without the strip, entryOverride extracts the phantom compat as a NON-EMPTY user-tier override (isNonEmpty counts the chatTemplateKwargs key) which wins over discovery/preset — dropping thinkingFormat / supportsReasoningEffort / supportsDeveloperRole → top-level reasoning_effort + developer-role pass-through → sglang 400 "Unexpected message role." (live 2026-08-26).

### test/overrides.test.ts — the section → resolution pin (the live regression chain)

dsh hands the adapter the schema-RESOLVED section; before the normalizeModelEntry phantom strip, the materialized `compat: { chatTemplateKwargs: {} }` became the tier-1 user compat (isNonEmpty counts the chatTemplateKwargs key) and beat the qwen3.8 preset — dropping thinkingFormat / supportsReasoningEffort / supportsDeveloperRole. pi-ai then sent a top-level reasoning_effort and a developer-role message → sglang 400 "Unexpected message role." The test pins the exact section → resolution path the live adapter runs.

### Settings UI — row addressing: slot keys, not names

Two live failures (both fixed pre-0.1.0) forced the row-identity model:

1. **Rows keyed on the live draft name.** The card's React rows were keyed on
   each row's current `name`; a keystroke in the name field changed the key,
   remounted the row, and dropped input focus after exactly one character —
   a new name could not be typed in one pass.
2. **Renaming a row to an existing name.** Every per-row surface addressed
   rows by name (`find(e => e.name === key)`): rename row A to row B's name
   and the two rows fused — every further edit (name, id, config) applied to
   both, and a delete removed both. A committed (legacy / hand-edited)
   duplicate was un-repairable for the same reason: every keystroke toward a
   free name except the final one is itself a collision.

The design: a row's identity is its SLOT. The card derives stable per-slot
row keys at open / materialization (`seedRowKeys`: unique names pass through
as-is — the key IS the name in the common case, so materialization remounts
nothing — duplicated names get `-2`, `-3`, …; an added row gets a fresh
token) and never moves a key on an in-place edit. The pure curation ops
(`removeModelEntry` / `renameModelEntry` / `updateModelEntry`) take a slot
index; every per-row draft state (config drafts, pending resets, the open
detail, the React row key) keys on the slot, so a typed collision can never
fuse two rows. A typed collision is surfaced (a red border on every
colliding row + an error line) with a one-click fix that renames the LATER
occurrences to the next free `name-n` (`resolveNameCollision`: the first
occurrence keeps the name, later ones are suffixed) — instead of being
merged. Two commit gates keep committed names unique: the card's Apply gate
blocks while a collision exists, and the node-side write gate
(`assertServiceable`, src/dsh/settings.ts) refuses a duplicate effective
name no matter which writer produced it — the harness identity is unique
per provider, and dispatch looks the entry up by name.

Contract: the row keys are UI-only — never committed, never part of the
dirty check; the wire schema is unchanged. Names may transiently collide
within a draft; a committed duplicate effective name is refused at write
time.

### src/discovery/metadata.ts — oracle verification of the ported value chains

The maxTokens chain is ported verbatim from pi-llama-swap `context.ts` §3.2,
and the verbatim pi order was checked against the frozen oracle BEFORE
porting: no recorded fixture entry carries a top-level `output_length` /
`max_tokens` (or a `meta.llamaswap.output_length` / `.max_tokens` alias), so
the flagship's `maxTokens: 65536` resolves from `meta.llamaswap.maxTokens`
exactly as the oracle expects — no oracle-mandated adaptation was needed.

The contextWindow chain's one adaptation (the probe-gated `max_model_len`
slot, position 4) has the same provenance: the frozen oracle
(`test/oracle.test.ts`, "bare" test) records a live bare-sglang entry whose
ONLY context signal is `max_model_len: 262144` and asserts that such an
entry "advertises nothing" at discovery time (every canonical field falls to
the preset tier). Enabling the slot on the default path would flip that
oracle from green to red — which is why the default `extractFromEntry` path
leaves it off and only the opt-in bare-server/probe wiring passes
`{ includeMaxModelLen: true }`.

### src/discovery/llamacpp.ts — the provenance short-circuit deviation

Deviation from the C4 letter, flagged for the owner: the locked text reads
"otherwise ONE probe" — the llama-swap provenance short-circuit skips that
probe for catalogs the catalog itself already identifies. The C10
discipline (catalog-first, at most ONE fetch) is kept; this only avoids a
fetch the catalog proves futile, and it is what keeps the pre-existing
channel fetch-count contract green without touching test/channel.test.ts (C3).

### src/dsh/channel.ts — keySource classification and the backend scan

`keySource` (on `onboarding` offer candidates) exists for the R5
credential-ref impedance: modelspoke can never read the VALUE of a key — at
most it can classify the family an entry's key belongs to. An entry naming
an `apiKeyEnv` whose value resolves from the inherited process environment
is `{ kind: "env", envVar }` (and so is an `apiKeyEnv` that does not resolve
when no credentials service is mounted — the optimistic read, deliberate:
the import only needs the family, the UI degrades from there); `{ kind:
"stored" }` is a key sitting in a layer modelspoke cannot read (the
`$DSH_HOME/.credentials.yaml` file store or a `.env` fallback, resolved
through the host `ctx.credentials` service — the Models page's typed-key
path) or a literal `apiKey` value field; `{ kind: "none" }` names no key at
all.

The discovery-backend registry scan (`discoverMetadata`): the route is
probed against src/discovery/backends.ts (SGLang, Ollama, LM Studio,
llama.cpp llama-server, vLLM — locked order); each backend's detection is
memoized per route identity × backend (inconclusive verdicts evict and
retry), the scan stops at the first DEFINITIVE match, and the matched
backend's `metadataRows` REPLACES `discoveredCanonical` per enriched id
(the registry's FULL-replacement semantics — ids left un-enriched keep the generic
row). No match — or a backend that degrades (backends are fail-soft, C6) —
keeps the generic rows as-is; the endpoint fails only when the `/v1/models`
fetch failed.

### test/e2e/ — suite structure, run prerequisites, uncovered manual journeys

A hermetic pass through the plugin's real surface against a TEST INSTANCE of
llama-swap fronting FAKE models — deliberately separate from `pnpm test`
(vitest): the unit suites stay hermetic; the e2e needs a browser, the dsh
CLI, and the llama-swap binary. Structure: one plain .mjs runner (`node
test/e2e/e2e.test.mjs` or `pnpm e2e`), a scratch root in tmpdir — a scratch
`DSH_HOME` (a copy of the live `~/.dsh/profiles/web` + a freshly
auto-initialized headless profile with modelspoke attached as a repo
symlink) and the fake llama-swap on free ports with its own generated
config (settings.yaml written per phase) — a pinned dsh (the `DSH_VERSION`
constant; the selectors ride on dsh's own web UI, so a dsh bump breaks them
silently — the runner fails loud at the boundary), playwright-core driving
`dsh web`, and headless one-shot turns. Nothing touches the live `~/.dsh`
home or the live llama-swap; on failure the scratch root is kept for
inspection (plus a repo-root `e2e-failure.png`, gitignored). `E2E_DSH` /
`E2E_LLAMA_SWAP` override the binaries; chromium comes from `E2E_CHROME` or
the newest `~/.cache/ms-playwright` build. modelspoke must be BUILT
(dist/).

The test instance is the real router, fake models: llama-swap (the real
binary) serves the router surface (the synthesized /v1/models catalog with
`meta.llamaswap`, health gating, request proxying); each "model" is
fake-model-server.mjs — it loads nothing, answers the health check and a
canned /v1/chat/completions (fixed "PONG" sentinel), and appends every
request to a JSONL log so the suite asserts the WIRE facts
(`chat_template_kwargs`, the attribution user-agent, the Bearer key)
without a real model. The llama-swap config's metadata blocks are the
per-model discovery source, so four-tier resolution is exercised end to
end: llama-swap.yaml → /v1/models meta → discovery tier → resolve → wire.
The fake (llama-swap + fake-model-server) is NOT under test — llama-swap
(the router) and modelspoke (discovery + resolve + wire) are.

Journeys: J1 fresh install → first provider; J2 onboarding import from a
local custom provider (env key — the value is never copied); J3 provider
import of the hand-written llama-swap block (renamed onto the block's key;
shadowing → all-or-nothing registration refusal); J4 provider card curation
(detail edit, cancel, row removal, apply); J5 per-effort wire shape
(off/low/medium/xhigh → `chat_template_kwargs`, headless turns); J10
zero-route boot hint + dead port (error surface, no settings write); J11
live-provider discovery against real local servers (catalog only, zero
inference — each candidate is probed first and SKIPPED when unreachable, so
the suite stays green without them).

Manual / real-model journeys NOT covered: J6 (vision), J7 (real servers),
J8 (pi), J9 (i18n), the J5 nothink row, the J10 thread-killer and the
web-context adapter rejection.

shots.mjs regenerates the README screenshots (`docs/screenshots/`) against
the CURRENT UI — the same harness, but the provider points at the LIVE
llama-swap (read-only: catalog GET only, no inference) so the shots show a
realistic catalog + real discovery values; `E2E_LLSWAP_URL` sets the base
URL.
