# Provider details — what each server exposes, and how it derives it

*Reference for the five tier-2 backends in `src/discovery/` (llamacpp, ollama,
lmstudio, sglang, vllm) and the llama-swap catalog tier. It carries the "why"
behind the shape gates and field mappings; the mechanics live in
[design.md](design.md) and the code.*

All live probes ran against one reference box (Ollama 0.32.15, llama-swap v250
fronting llama.cpp llama-server upstreams); per-provider version pins are in §4.

## 1. Why these five

A 2026-08-26 sweep of ~25 local servers, routers, proxies, and aggregators asked:
which expose capability metadata beyond bare `GET /v1/models`? Exactly five got
backends, in this ranked order:

1. **LM Studio** — the only local server in the sweep that publishes an enumerated
   per-model reasoning-effort list (`capabilities.reasoning.allowed_options`).
2. **llama.cpp llama-server** — upgrades the existing probe-only path and feeds
   preset authoring directly (`/props` raw jinja + `chat_template_caps`).
3. **SGLang** — the richest unauthenticated-by-default endpoint pair
   (`/model_info` + `/server_info`).
4. **vLLM** — a cheap add-on: the `max_model_len` catalog field (an already-
   implemented probe-gated slot) + `/tokenizer_info` template evidence.
5. **Ollama** — native `/api/*` surface (covered by its own investigation, §3.2).

Rejected, with the verdict that stuck:

| Provider | Verdict |
|---|---|
| LiteLLM proxy | Richest *router* surface (`/model_group/info`, `/model/info`), but its values are **declared** (price map / operator `model_info`), not measured from the backend — closer to authored metadata than runtime truth, and key-gated. Ranked behind the local servers; not a v1 backend. |
| KoboldCpp | Real surfaces (`/api/extra/version` caps, `/props` template) but zero reasoning metadata; effort is silently converted to a token budget. |
| LocalAI | Interesting `/v1/models/capabilities` + trained-max context, but a very new surface — wait for it to stabilize. |
| Lemonade | Good shape (labels + dual context, no auth), low priority. |
| TabbyAPI | Template + context, but only for the currently *loaded* model. |
| TGI | Maintenance mode; its numbers are deployment args, not model capability. |
| text-generation-webui | Nothing usable over the API — a backend would be pure overhead. |
| Jan, MLC LLM, GPT4All, mlx_lm.server, llamafile | Bare `/v1/models` (some barer than OpenAI itself); nothing to discover. |
| ExLlamaV2 / Aphrodite | Archived / pivoted; covered transitively. |
| sgl-model-gateway (ex-sgl-router) | Pure proxy to one worker; implement against the SGLang workers. |
| Docker Model Runner | Native response shapes undocumented. |
| one-api / new-api / Portkey / Helicone | No capability metadata found (accounting/pricing/observability surfaces). |
| OpenRouter | Cloud — out of scope for a local-first tool, **but the shape reference**: its `reasoning.supported_efforts` is the only per-model effort-level list found anywhere in the wild. |

Cross-cutting verdicts (these shape the whole codebase):

1. **Effort levels exist in exactly two places**: OpenRouter (cloud) and LM
   Studio (local). Everywhere else the vocabulary is a *static request Literal*
   (vLLM, SGLang — identical for every model), a *silent token-budget
   conversion* (KoboldCpp), or a *boolean template gate* (llama.cpp). A static
   parser vocabulary is never a per-model level list — the "never invent" rule
   applies to `thinkingLevelMap` for every backend except LM Studio.
2. **The raw jinja chat template is an HTTP commodity**: llama.cpp
   `/props.chat_template`, vLLM `/tokenizer_info`, SGLang `/server_info.chat_template`,
   KoboldCpp `/props`, TabbyAPI `/props` — five servers deliver the
   preset-authoring source of truth at runtime.
3. **Context is two-layer everywhere** (model max vs as-configured); only
   llama.cpp and Ollama expose both layers separately on the wire — vLLM and
   SGLang expose only the resolved value, which cannot tell a file-derived
   number from a launch-overridden one.
4. **`maxTokens` is undiscoverable from every local inference server** (only
   LiteLLM, declared, and OpenRouter, cloud). Keep it honestly undiscoverable.
5. **The `capabilities` key is shape-polysemous**: object (`{function_calling,
   vision}` — llama-swap), string array (Ollama, LocalAI, Lemonade `labels`),
   nested object with sub-objects (LM Studio). Shared extractors dispatch on
   shape; the `meta` key collides the same way (llama.cpp GGUF dump vs
   llama-swap authored block — dispatch on inner keys).

## 2. Capability provenance — where each value comes from

Legend for every wire field the backends consume:

- **(a) MODEL-FILE fact** — read from the artifact (GGUF header KV, HF
  `config.json`, tokenizer files). Stable across runs, servers, and app versions.
- **(b) TEMPLATE fact** — derived by analyzing the model's chat template
  (jinja or Go, embedded in the artifact or, for Ollama regime-2 families, in
  the server binary). Stable per template revision; also analyzer-versioned.
- **(c) LAUNCH/RUNTIME state** — command-line flags, memory profiling, JIT load
  config, or loaded state. The same model legitimately reports different values;
  includes *active-surface* fields (a capability the artifact has but the current
  config does not expose — e.g. vision without `--mmproj` — reported as absent).
- **(d) APP-CURATED** — knowledge hardcoded in the serving app (family tables,
  per-model databases, renderer registries). Changes with the *server* version,
  not the model.

Per-provider field classes (the condensed version; the full per-wire-field table
is in the provenance note):

| Backend | (a) file | (b) template | (c) launch/runtime | (d) app-curated |
|---|---|---|---|---|
| llamacpp | `meta.{n_ctx_train, n_vocab, n_embd, n_params, size, ftype, vocab_type}` | `chat_template_caps.*` (dynamic probe, below) | `props.n_ctx`, `meta.n_ctx`, `modalities.*` (gated by a) | raw `chat_template` mix per resolution path |
| vllm | `max_model_len` (default derivation) | — none on the catalog path | `max_model_len` when overridden / `-1` auto-fit | `owned_by`, `permission[]` scaffold |
| sglang | `context_length` default, `has_image_understanding` subconfig half | opt-in `auto` parser rule-match | `reasoning_parser`/`tool_call_parser` (launch), `token_capacity` | parser *choice lists*, arch whitelist |
| lmstudio | `max_context_length` [inferred], display fields | `trained_for_tool_use` hybrid [inferred] | loaded `context_length` (JIT) | **`allowed_options`/`default`** (the crown jewel), `vision` corrections |
| ollama | `model_info.*` (GGUF KV verbatim), vision/audio/embedding caps | `thinking`/`tools` caps for regime 1/3 | `/api/ps` context | `requires`, regime-2 parser flags (drift with server version) |

Two structural findings:

- **Only llama.cpp and Ollama expose the two context layers separately**
  (`props.n_ctx` vs `meta.n_ctx_train`; `/api/ps` vs `model_info`). Prefer the
  two-layer source when reachable.
- **(b) facts drift on TWO axes**: the template revision *and* the analyzer
  (the server binary). A server upgrade can change derived caps for an
  unchanged model — persist (b) facts keyed to template revision *and* provider.

**llama.cpp's `chat_template_caps` is dynamic execution probing, not static
analysis.** The code refutes the AST-scanning hypothesis: llama.cpp compiles the
model's jinja template, then repeatedly *executes it* with synthetic probe
fixtures (`messages`, `tools`, `bos_token`, …) under instrumented jinja values
that record `.used`/`.ops`, plus marker strings in the rendered output.
`supports_reasoning_effort` is produced by binding `reasoning_effort`
(and `reasoning_strength`) and re-probing whether the template consumes them —
a conformance test. It is arguably *stronger* evidence than a static scan (it
proves actual consumption, not textual presence), but it is still
analyzer-versioned, and the probe fixtures are llama.cpp's own assumptions.
It is the only machine-readable per-template reasoning gate any of the five
publish.

### Trust verdicts: what may be persisted as a per-model declaration

- **(a) MODEL-FILE facts: persist.** Context ceilings, arch, tensor counts —
  stable across restarts, GPU changes, app updates. Caveat: vLLM/SGLang wire
  values can carry a launch override you cannot detect from the wire; a
  single-layer resolved value persists as "true as last probed".
- **(b) TEMPLATE facts: persist, keyed to template revision + deriving
  provider (with version).** The highest-value reasoning facts —
  `chat_template_caps.supports_reasoning_effort` is the standout.
- **(c) LAUNCH/RUNTIME: never persist.** `token_capacity` (re-profiled every
  start), LM Studio loaded context (app default drift), llama.cpp `props.n_ctx`,
  any single-layer `max_model_len` — persisting one machine's momentary state
  into shared config is a lie.
- **(d) APP-CURATED: persist only as advisory metadata with a
  provider-version stamp.** LM Studio `allowed_options` is the riskiest
  valuable field (per-identity app database, changes across releases, can
  diverge from request-time acceptance). SGLang/Ollama parser names are compact
  keys into provider-internal tables — compat hints, never wire semantics.
- **Modality/vision fields: NEVER persist as per-model declarations** — they are
  the active surface of the (model, provider, config) triple. Per provider:
  llama.cpp `vision:true` requires the projector *actually loaded* (same GGUF
  without `--mmproj` reports false — false is not evidence the model can't
  see); SGLang's `--enable-multimodal` flips the advertised flag for an
  unchanged model; LM Studio's field can be `true` while every vision request
  500s (issue #2223); vLLM exposes no modality field at all; only Ollama's
  vision is a per-model-entry fact (the projector is part of the manifest
  entry). Modality is re-discovered per run, period.

## 3. Per-provider detail

### 3.1 llama-swap (router) — pin: v250, build 2026-08-14, commit `60226b6`

Probed live 2026-08-26; source-verified against `main` `8a32e05` (2026-08-24) —
no discovery-surface drift between the probed build and main.

**Router projection: the catalog is 100% config-authored.** Every `/v1/models`
entry is synthesized from the llama-swap config with `owned_by` **hardcoded**
to `"llama-swap"` on all entries — upstream `owned_by` is never echoed, and
upstream `max_model_len` never survives (it is absent from every entry). No
code path fetches, parses, or translates an upstream response into the
catalog; an "upstream" is just `cmd` + `proxy` + a readiness check. What IS
authored: `meta.llamaswap` (the `metadata:` block, 13/13 entries on the
reference box), rendered `capabilities`/`architecture`/`supported_parameters`/
`context_length` from the `capabilities:` authoring block, `meta.n_ctx`
mirroring authored context (11/13 there), aliases, and synthetic `peers`
/`selectors` records (peer federation carries `nil` metadata — authored data
does not survive a llama-swap→llama-swap hop).

**Forwarding model.** Only `GET /props?model=<id>` is whitelisted for
discovery (shipped for pi's `/props` probe); a *bare* `GET /props` (no id)
returns HTTP 404 with `{"error":"no model id could be identified","src":"llama-swap"}`
— it never reaches the upstream, so it can never trigger a load.
`/upstream/<model_id>/<path>` is the universal passthrough to the upstream's
entire native surface, **at the cost of a swap**: an unloaded model loads on
request unless the path matches `upstream.ignorePaths` (default: static-file
extensions + `/ws` + `/api/jobs` — discovery paths are *not* covered; with
ignorePaths, an unloaded model gets 409 instead). Everything else 404s with
plain-text `404 page not found` (the plain-text vs JSON-404 distinction is
itself the tell: llama-swap's own router 404s are text; proxy-recognized paths
fail with `src:"llama-swap"` JSON).

**The v250 near-miss (why the Ollama gate is a dotted-version shape check).**
llama-swap serves `GET /api/version` — its own build-info endpoint — with a
top-level `version` string. On v250 the value is `"v250"`, which **fails the
Ollama `DOTTED_VERSION_SHAPE` gate (`/^\d+\.\d+(?:\.\d+)*$/`,
`src/discovery/ollama.ts`) by exactly one character class** — no dot, so
definitive non-match. Any future llama-swap release that versions as
dotted-semver (or a user's fork) would flip this into a live false-positive.
Guard in code: the Ollama backend's catalog negative — any entry with
`meta.llamaswap` or `owned_by: "llama-swap"` rejects the match without fetching.

**The collision guards (why the llama.cpp gate is a shape check, not a
presence check).** llama-swap entries carry a top-level `meta` object on every
row, and `meta.n_ctx` on most. A gate implemented as "has a `meta` object" (or
"has `meta.n_ctx`" — which is llama.cpp router-mode's *own* key) would
false-positive on every llama-swap route. The shipped rule: match
`owned_by === "llamacpp"` OR (`meta` is an object AND at least one of
`n_vocab`, `n_ctx_train`, `n_embd`, `n_params`, `size`, `vocab_type` is a
positive integer) — none of which llama-swap emits. Fixture: the
reference-box catalog is the negative fixture in the test suite.

**Param-less safety rule.** The llama.cpp backend's `/props` probe must stay
*param-less*: adding `?model=<id>` through the router is whitelisted and would
load the model. The bare-GET 404 is the safety — never "fix" it. (modelspoke's
separate opt-in probe reaches upstream `/props` of *already-running* models via
llama-swap's `/running` per-process `proxy` URLs — no swap risk; note the
`cmd` field on `/running` rows can embed an HF token and is never parsed out
for display — `src/discovery/probe.ts`.)

**The `metadata:` key is `meta.llamaswap` (nested).** The `llamaswap_meta`
top-level spelling is a plan-document artifact from issue #264; it is not in
shipped code (v250 or main), and the UI is pinned to the nested key. The
extractor keeps an "accept both spellings" guard as cheap insurance.

Embodied in `src/discovery/metadata.ts` (catalog tier), `src/discovery/probe.ts`
(opt-in running-model probe), and the `contract/fixtures` + `test/fixtures`
llama-swap vectors.

### 3.2 Ollama — pin: 0.32.15 (live probes 2026-08-26), source `main` tree `39f7f915` (2026-08-27)

**Surface.** `GET /api/version` (dotted version — the identity gate),
`GET /api/tags` (model list + summary), `POST /api/show` (per-model, the
authoritative capability source), `GET /api/ps` (loaded models + effective
context). `GET /v1/models` and `/v1/models/{model}` are **bare**
(id/created/`owned_by` only) — the native `/api/*` is where the data is.

**`/api/tags` vs `/api/show` disagree — and the mechanism is known.** For the
same model on the same server, tags reported e.g. `["completion","tools","thinking"]`
while show reported `["completion","vision","audio","tools","thinking"]`.
Source: the two run *different* derivation chains — `/api/show` runs the full
chain (GGUF `vision.block_count`/`audio.block_count` reads, projector files,
template analysis, built-in parser flags, family rules, per-arch filter);
`/api/tags` runs a lighter summary that adds vision **only** for separate
projector files and does *not* read the GGUF tower KVs. Embedded-tower models
under-report on tags. Design rule (embodied in `src/discovery/ollama.ts`):
capabilities come from `/api/show` per model; tags is the id list only.

**Three template regimes** (from `/api/show`):

1. **Cloud models** (`<name>:cloud`): empty template, no modelfile/tensors —
   the template is unreachable from the server. `remote_host` presence is the
   "is cloud" marker; manifests are ~300-byte stubs with no registry entry.
2. **Built-in-engine families** (local GGUF, recent families): template is the
   13-byte placeholder `{{ .Prompt }}`; the modelfile carries
   `RENDERER <family>` + `PARSER <family>`. **The chat template lives in
   Ollama's binary**, keyed by family.
3. **hf.co GGUF pulls with embedded jinja**: the real template is exposed —
   the one regime where the artifact's jinja arrives at runtime. (Older models
   may still carry Go templates.)

**Version gate (why `requires` exists).** Each model entry carries `requires`
— the minimum Ollama version whose binary has the named renderer/parser
(authored upstream in the library's config blob; e.g. gemma4 → 0.20.0,
qwen3.8 → 0.32.12). The server does **not** semver-enforce it — it is
display-only; enforcement is behavioral (an unknown renderer name is a render
error, so old binaries fail or fall back). Because regime-2 templates live in
the binary, a family's thinking/tools behavior **drifts with the server
version, not the model file** — the family table is valid only when
`server version ≥ requires`, which is exactly the gate `src/discovery/ollama.ts`
compares via `GET /api/version`.

**The `think` parameter — vocabulary, clamps, and per-family behavior.**
Native `think` accepts `true | false | "low" | "medium" | "high" | "max"`
(the server's own 400 error enumerates this set). OpenAI-compat
`reasoning_effort` accepts `"none"|"minimal"|"low"|"medium"|"high"|"max"|"xhigh"|"ultra"`,
clamped into the native vocabulary by the compat layer: `minimal`→`low`,
`xhigh`/`ultra`→`max` — **clamped, not rejected** (a client's `xhigh` arrives
as Ollama `max`). What each level *does* is a renderer property, not a parser
guarantee:

| Family (renderer) | Level behavior |
|---|---|
| gemma4, deepseek3 (R1-style) | **Boolean-only** — every string level collapses to on/off; `ThinkValue.String()` renders plain `true` as `"medium"` (the honest "on" value). |
| qwen3.5 / qwen3.8 | **Graded** — `low` → low-effort instruction, `medium` → none, `high`==`max` → xhigh instruction; anything else → 400. |
| gpt-oss (harmony) | **Levels only** — booleans ignored, `"max"` silently mapped to `"high"`, and the trace **cannot be disabled** (`off: null` semantics; never emit `off: "none"` for it). |
| legacy / other Go-template families | Template-dependent (template in the artifact). |

The **never-invent trap**: the parser accepts all four string levels for
*every* thinking-capable model (the 400 only fires for non-thinking models),
so acceptance ≠ distinct behavior. A discovered map may report the capability;
only renderer/doc evidence may report distinct levels. `src/discovery/ollama-families.ts`
is that family table, keyed on the `parser`/`renderer` name (from the registry
ConfigV2) — the "template in the artifact" for regime-2 families is Ollama's
renderer, and the table must be revisited per Ollama release.

**The static surface behind the family table.** For library models the Ollama
OCI registry (`registry.ollama.ai` — plain OCI, no HTML, no auth) is the
static provenance path: the manifest's config blob is Ollama's **ConfigV2**
JSON (the source's `types/model/config.go` struct) carrying family, param
size, quant, and — the family table's key — `renderer` + `parser` and the
`requires` gate; the local model's `/api/show` digest matches the manifest
layer digest, so local-id→registry resolution is digest-verified, not
guessed. A `Range: bytes=0-…` fetch of the model layer reads
`tokenizer.chat_template` + `general.*` KVs from the canonical artifact —
template-in-artifact without weights (the KV section can sit ~13 MB in).
Unnamespaced ids default to `library`; `hf.co/…` ids are the HF repo
pointer; `:cloud` and renamed/`ollama create`-d models have no registry
entry — fail closed to the `/api/show` family. Ollama 0.32.15, 2026-08-26.

**Cloud models are behaviorally probeable but unsourceable.** Rendering
happens server-side (ollama.com) — no renderer source exists. Live:
`deepseek-v4-flash:cloud` **ignored `think:false` entirely** (thinking
always-on; the silent-no-op class); `glm-5.2:cloud` honored `reasoning_effort:"none"`
(clean off) and accepted the graded vocabulary. So cloud entries need
per-family rows, not a blanket "all levels null"; unprobed cloud families
discover the `thinking` flag and omit the map. Cloud models also retire on a
published schedule — their metadata ages out.

**The `thinking` capability flag is the exact gate**: capabilities ∋ `thinking`
⟺ the `think`/`reasoning_effort` request is accepted (200 vs 400, verified
both directions — the server's own handler gates on the same list). A
thinking-capable model with `think` unset **defaults to thinking on**.

**Context is three-layer**: GGUF `<family>.context_length` in `/api/show`
`model_info` (the model max — reliable for local GGUFs; cloud models expose it
too), modelfile `num_ctx` (visible in `/api/show` `parameters`), and
`/api/ps` `context_length` (the effective value *while loaded* — a runtime
override signal, not the static answer). `details.context_length` on tags is
present on many models but absent on others — fallback only. `maxTokens` is
undiscoverable (no output-limit metadata anywhere in the surface).

Embodied in `src/discovery/ollama.ts`, `src/discovery/ollama-families.ts`,
`contract/fixtures/ollama.json`.

### 3.3 llama.cpp llama-server — pin: source `master`, pass of 2026-08-27

`/v1/models` entries have carried a `meta` object since tag b3400 (Mar 2024);
current master has 8 fields (`vocab_type, n_vocab, n_ctx, n_ctx_train,
n_embd, n_params, size, ftype`) — pre-b3400 servers have no `meta`, so probe
per-field and fail soft. All are verbatim GGUF header facts **(a)** *except*
`meta.n_ctx`, which is the launch-resolved slot context **(c)** — the only
non-file key in the catalog. The GGUF `general.name`/`general.architecture`
strings are **not** in `meta` (community patch unmerged) — don't expect them.
llamafile bundles llama.cpp of unknown vintage — treat as "llama.cpp, degrade
gracefully."

`GET /props` (the full shape, far richer than the probe's `n_ctx` read):

- `default_generation_settings.n_ctx` — **(c) hard**: `--ctx-size` launch
  config resolved through a memory-fit computation (default 0 = trained
  context, then the fit machinery *reduces* it until projected memory hits the
  target, floored at 4096×streams; `--parallel` changes it again). The same
  model reports different values per process.
- `modalities.{vision,video,audio}` — **(c) gated by (a)**: the flags come from
  the multimodal context, which exists only if a projector was loaded at
  launch (`--mmproj*`). A vision-tower GGUF without the flag reports
  `vision:false`; the flag tests the *projector actually loaded*, not the
  architecture.
- `chat_template` — the *resolved* jinja (override > GGUF KV > built-in CHATML
  fallback, plus two hardcoded pre-parse patches) — the preset-authoring
  source of truth, delivered at runtime.
- `chat_template_caps.{supports_tools, supports_tool_calls,
  supports_parallel_tool_calls, supports_typed_content, supports_system_role,
  supports_string_content, supports_preserve_reasoning, supports_reasoning_effort,
  supports_object_arguments}` — **(b) via dynamic execution probing** (§2).
  Map `supports_reasoning_effort` to `compat.supportsReasoningEffort` — a
  **boolean gate only**; no endpoint enumerates which effort levels a template
  accepts (the CLI's `--reasoning-effort` vocabulary lives only in
  `default_generation_settings.params` — launch config, never a per-model
  enumeration).
- Also: `total_slots`, `model_alias`, `model_path`, `bos/eos_token`,
  `build_info`, `is_sleeping`. No `/v1/props`, no `/v1/models/{model}`;
  router mode uses `?model=` query params with per-model child servers.

Mapping: `meta.n_ctx_train` → contextWindow **ceiling**; `props.n_ctx` →
as-configured (the value that actually bounds generation);
`modalities.vision` → input; the raw `chat_template` → preset tier. No
maxTokens anywhere. Embodied in `src/discovery/llamacpp.ts`,
`src/discovery/probe.ts` (opt-in `n_ctx`), `contract/fixtures/llamacpp.json`.

### 3.4 vLLM — pin: source `main` (post-restructure), pass of 2026-08-27

`GET /v1/models` is **not bare**: every ModelCard carries `max_model_len`,
`root`, `parent` (LoRA), `permission[]` (hardcoded static scaffold — no
capability content; fresh UUID/timestamp per card).

`max_model_len` derivation (one value, resolved at engine init): the
**minimum over all present** `config.json` context keys
(`max_position_embeddings`, `n_positions`, `max_seq_len`, `seq_length`,
`model_max_length`, `max_target_positions`, `max_sequence_length`,
`max_seq_length`, `seq_len`) — not a precedence order; YaRN rope scaling
multiplies the derived max (`original_max_position_embeddings` reset first);
a missing key set falls back to 2048 with a warning. `--max-model-len`
overrides are *verified against* the derived value (larger → `ValueError`
unless the override env var is set) and an explicit value that doesn't fit KV
cache **errors, it does not cap** — only `-1`/`auto` binary-searches the
largest context that fits GPU memory (machine-dependent, mutates the config
in place). Net: **(a) by default, (c) when overridden — and the wire cannot
tell which**, so a persisted value is "true as last probed."

There is **no template analysis anywhere in the catalog path** — no
reasoning, tool, or vision probing. The template is dumped verbatim by
`GET /tokenizer_info` (tokenizer `init_kwargs` + the rendered jinja
`chat_template`) — the preset-authoring commodity, served **unguarded** even
when `VLLM_API_KEY` is set (auth guards only the `/v1`, `/v2`, `/inference`,
`/cohere` prefixes). `GET /server_info` (full config incl. the
`--reasoning-parser`) is dev-gated (`VLLM_SERVER_DEV_MODE=1`) — not a
discovery dependency.

Modality: multimodal is ON by default; it is *disabled* by
`--language-model-only` or `--limit-mm-per-prompt {"image": 0}` (there is no
`--disable-multimodal` flag) — but the ModelCard has **no modality field at
all**, so `/v1/models` cannot say whether the (model, config) pair accepts
images. vLLM modality is discoverable only by trying; nothing to persist.

Effort: a static request Literal (`none|minimal|low|medium|high|xhigh|max`),
identical for every model; `--reasoning-parser` is one server-wide flag.
Mapping: `max_model_len` → contextWindow (the probe-gated slot);
`/tokenizer_info` → template evidence. Embodied in
`src/discovery/vllm.ts`, `contract/fixtures/vllm.json`.

### 3.5 SGLang — pin: source `main`, pass of 2026-08-27

Single-model server (per-server facts = per-model facts).
`GET /model_info` (deprecated alias `/get_model_info` still served — target
the new name, keep the alias as fallback): `model_path`, `served_model_name`,
`reasoning_parser`, `tool_call_parser`, `has_image_understanding`,
`has_audio_understanding`, `model_type`, `architectures` (the last five are
recent-main additions — older 0.4.x responses lack them; probe per-field).
`GET /server_info`: the resolved `server_args` (`context_length`,
`enable_multimodal`, `chat_template`, `default_chat_template_kwargs`, …) plus
`internal_states[].memory_usage.token_capacity`.

- **`reasoning_parser` / `tool_call_parser`** — **(c) launch config** with
  **(d) curated choice lists**: the CLI choices are generated from hardcoded
  family→detector maps; an unknown value means the server never starts. The
  one template-derived path is opt-in: `--*-parser auto` runs *static*
  rule-matching over the template text (`REASONING_PARSER_RULES`) and adopts
  the suggestion. `/model_info` reports the resolved launch config verbatim.
- **`has_image_understanding`** — a hybrid: curated `multimodal_model_archs`
  list (~100 entries) × `config.json` vision-subconfig presence, **gated by
  the tri-state `--enable-multimodal` launch flag** (+ a hardcoded
  `mm_disabled_models` list). `--enable-multimodal false` flips the wire
  value to false for an unchanged vision-capable model; `true` re-enables a
  list casualty.
- **`context_length`** — **(a) by default**: ordered-key derivation from
  `config.json` (`max_sequence_length`, `seq_length`, `max_seq_len`,
  `model_max_length`, `max_position_embeddings`) × rope factor, fallback
  2048; a larger flag value errors unless the override env var is set.
  `/v1/models` `max_model_len` reports the same resolved value (LoRA cards:
  `None`).
- **`token_capacity`** — **(c), the least stable number any of the five
  expose**: `(currently-free GPU memory − slack − mm reservation) ÷ per-token
  KV cell`, profiled at pool allocation. It is the only *runtime-true*
  context number, and it changes run-to-run.
- **Effort**: `ReasoningEffortTier` is a module-level Literal identical for
  every model; no parser carries a level vocabulary. Per-model effort
  semantics that *do* exist are hand-written serving-layer branches (e.g.
  kimi_k3 accepts only `low`/`high`/`max`), **invisible to any API** — never
  present the static Literal as a discovered level list.
- Auth: `--api-key` guards **all** endpoints when set (health/metrics exempt)
  — the opposite of vLLM's unguarded extras. SGLang's Ollama-compat
  `/api/show` hardcodes `capabilities: ["completion"]` — **do not point the
  Ollama backend at it**.

Mapping: `reasoning_parser` non-empty → reasoning; `has_image_understanding`
→ input; context from `/v1/models.max_model_len` / `server_args.context_length`
/ `token_capacity`; parser names + `default_chat_template_kwargs` → compat
keying. Embodied in `src/discovery/sglang.ts`, `contract/fixtures/sglang.json`.

### 3.6 LM Studio — pin: docs/changelog pass of 2026-08-27 (REST v1 is 0.4.0+; v0 is 0.3.6+)

`GET /api/v1/models` carries, per model: `capabilities.reasoning.{allowed_options,
default}` — **the only local enumerated per-model effort list found in the
entire sweep**, plus `capabilities.{vision, trained_for_tool_use}`,
`max_context_length` (model max) and `loaded_instances[].config.context_length`
(as loaded), quantization/arch/size (display). Optional API-token auth, off
by default. The OpenAI-compat `/v1/models` stays bare; the legacy
`/api/v0/models` (≤0.3.6) has **no** reasoning object — degraded fallback only.

- **Mapping `allowed_options` — map, never invent.** The documented vocabulary
  is `("off"|"on"|"low"|"medium"|"high")[]` + `default`, and the dialect
  differs from the harness levels: `on` is a *toggle*, not a level; there is
  no `minimal`/`xhigh`/`max`. A correct map is `off→off`, `on→default`,
  listed levels 1:1, everything else unsupported. The field is **absent when
  no reasoning config is exposed** — absence is a real signal.
- **Provenance is (d) APP-CURATED, on the balance of evidence** — and this is
  the one provider where the crown jewel is *least* stable. The server core
  is closed source (the JS SDK is a pure relay). The evidence: a keyed-lookup
  failure mode (a Qwen3.5-4B GGUF, across multiple publishers' quants, is not
  detected as reasoning while the architecturally identical 8B is — issue
  #1613; generic template parsing cannot explain a same-family 4B-vs-8B
  split); the Hub catalog curates exactly these fields per model; changelogs
  ship effort support *by model name*; and the advertised list can diverge
  from request-time acceptance (observed: `["off","on"]` advertised, literals
  rejected). Persist it only as advisory, stamped with the LM Studio version,
  or re-derive per run.
- **Context two-layer + JIT trap**: `max_context_length` (values
  value-match the GGUF training-context KV; mechanism [inferred] — the core
  is closed) vs the loaded instance's `context_length`, whose default is
  *app state* (a global default that drifted 4096 → 8k between releases,
  per-model overrides on top). A JIT-loaded model may run at a small default
  ctx — prefer `max_context_length` for the ceiling, never treat the loaded
  value as the model max.
- **`capabilities.vision`** is a file/curated hybrid, publicly undecidable,
  and issue #2223 shows `vision: true` while *all* vision requests 500 —
  treat it as model-derived but health-contaminated, never as proof of the
  active surface.

Embodied in `src/discovery/lmstudio.ts`, `contract/fixtures/lmstudio.json`.

## 4. Version provenance

| Provider | Verified against | When |
|---|---|---|
| Ollama | live **0.32.15** (all wire probes) + source `main` tree `39f7f915` | 2026-08-26 / 27 |
| llama-swap | live **v250** (build 2026-08-14, commit `60226b6`) + source `main` `8a32e05` (clone 2026-08-24) | 2026-08-26 |
| llama.cpp | source `master` (`common/`, `src/`, `tools/server/`, `common/jinja/caps.cpp`) | 2026-08-27 |
| vLLM | source `main` (post-restructure `entrypoints/`) | 2026-08-27 |
| SGLang | source `main` (`python/sglang/srt/entrypoints/http_server.py`, `server_args.py`) | 2026-08-27 |
| LM Studio | docs + changelog + issue pass (server core closed source) | 2026-08-27 |

All provider evidence comes from `main` unless pinned above; version-gated
behaviors cited from release notes were not individually re-probed on pinned
versions. Re-probe on any provider upgrade — the llama-swap five-gate probe
is the baseline (re-run it against a live llama-swap); a route-table grep is
a 30-second skew check.
