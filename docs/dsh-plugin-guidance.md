# dsh plugin guidance — building modelspoke's host integration

*Reference for the dsh (DeepSeek Harness) integration in `src/dsh/`: the
adapter contract, the settings seam, and shipping a web UI. Behavior was
verified against dsh **0.1.1-rc.2**; the exact signatures are in the
npm-published dsh package (and its `@deepseek-ai/*` sub-packages) — consult
those `.d.ts` files, don't copy from this doc.*

## 1. Node half: registering an LLM adapter

### 1.1 Lifecycle

A dsh plugin is a Cordis plugin (`name` / `inject` / `Config` /
`apply(ctx, config)`); modelspoke's entry is `src/dsh/index.ts` with
`inject: ["llm"]`. The service is `ctx.llm: LlmRuntime`.

- **`registerAdapter(providers, adapter)`** → `AdapterRegistrationHandle`
  (a disposer function + `replace(providers)`). All-or-nothing: any provider
  that already has an adapter throws `LlmError DUPLICATE_ADAPTER`; route names
  only need to be non-empty; the registration is disposed with the fiber.
  `replace` validates the *whole* candidate set first (conflict, invalid name,
  bad metadata → throw, current routes untouched) and swaps in one
  synchronous section — no request observes a gap. An **empty array is legal
  in `replace` but not in the initial registration** (an empty route set stays
  unregistered). Once disposed, further calls throw `REGISTRATION_DISPOSED`.
- **`LlmAdapter` members**: `stream(options: GenerateOptions):
  AsyncIterable<StreamChunk>` is the **only required (abstract) method**;
  `providerInfo(provider)` (detached display metadata, id must equal the
  route), `providerRetryPolicy(provider)` (`undefined` = normal defaults),
  `listModels(provider)` (an **advisory** catalog — absence must never become
  request rejection), `resolveModel(provider, model, signal)`, and
  `prepareCall(provider, model, signal)` (binds exact-model metadata and the
  eventual dispatch to one generation, so a settings change in between can't
  mix one generation's capabilities with another's endpoint). The abstract
  class takes **no constructor parameters** — constructor options are a
  per-concrete-adapter pattern.
- **Model metadata shapes**: `LlmProviderInfo {id, name}`; `LlmModelInfo
  {provider, id, name, description?, inputModalities?}` (absent = unknown,
  explicit omission = negative capability); `LlmResolvedModelInfo` adds
  `context {contextWindow}`, `defaultMaxTokens?`, `reasoning {efforts[],
  defaultEffort?}` — the efforts list is *abstract*: the "off means send
  nothing" wire rule is a pi-ai-adapter configuration concern, not a dsh-llm
  one (see §1.4). `LlmConfigurableProvider {provider, displayName, settingsNs,
  settingsPath, declared?}` is the directory row (§1.5).
- **`StreamChunk` contract**: `block-start` / `text-delta` / `reasoning-delta`
  / `tool-call-delta` / `block-end` (carries the assembled block) / `usage` /
  `finish` — block indexes correlate interleaved deltas. **Emit a single
  `usage` chunk, then the terminal `finish`, then nothing.** Tool arguments
  remain **raw JSON strings** end to end. An adapter may throw;
  `LlmRuntime.stream()` normalizes the failure to a terminal `error`/`aborted`
  finish. `finish` carries a `FinishReason` (`stop | tool-calls | max-tokens |
  aborted | error`, the last two with an `LlmFailure {message, code, status?,
  providerRetryAfterMs?, requestId?}`) and an optional adapter-private
  `ReplayEnvelope`. `TokenUsage` is uncached-input / output / cache-read /
  cache-write / reasoning.
- **Optional interception**: the `llm/stream` waterfall event
  (`this: LlmRuntime`, `options`, `next() → AsyncIterable<StreamChunk>`) and
  the payload-free `llm/adapters-updated` event fired at each registration
  commit (including disposal).

### 1.2 Keys and the attribution-header contract

- **API keys are credential references, resolved per call.** A profile's
  `apiKeyEnv` is a *reference* (an env-var name with role
  `credential-ref`), resolved per request through
  `ctx.credentials.resolve(ref)` — resolution is per call and **must not be
  cached across operations**. A named reference that misses throws
  `LlmError MISSING_CREDENTIAL` (no fallback); a profile with no `apiKeyEnv`
  defers to pi-ai's own ambient discovery. modelspoke's `keySource`
  classification (env-reference vs keyless vs other, for onboarding
  candidates) is modelspoke-side on top of this: `src/dsh/channel.ts`
  (`keySourceOf`).
- **Attribution is mandatory.** The `LlmAdapter` docstring requires that
  *every* provider HTTP request include the harness attribution headers.
  `attributionHeaders()` is a **free function exported by
  `@deepseek-ai/dsh-llm`** (module `/attribution`) — *not* a member of
  `LlmAdapter` — and today returns exactly one lowercase header:
  `user-agent: deepseek-harness/<version> (+https://github.com/deepseek-ai/deepseek-harness)`.
- **The injection point (pi-ai path): the per-request `headers` option of
  `Models.streamSimple`.** Header precedence, lowest to highest:
  `Model.headers` (static per-model) → provider/session defaults →
  **`options.headers` last (wins)**; a `null` value suppresses a same-named
  default header. The merged result becomes the OpenAI SDK client's
  `defaultHeaders`, attached to every request. The reference pattern
  (embodied in `src/dsh/headers.ts`): take the route's configured headers,
  drop any entry that collides *case-insensitively* with an attribution
  header, then spread `attributionHeaders()` **last** — so a user's
  `headers` setting can never override attribution, and the pattern
  future-proofs extra attribution headers.
- **Proving it**: a wire-capture test — point a route at a local mock
  OpenAI-completions server and assert the request's `user-agent` equals
  `attributionHeaders()['user-agent']` regardless of route headers, with the
  route's own custom headers present. In-process alternatives: the pi-ai
  `onPayload` (request body pre-send) / `onResponse` (status + response
  headers) options.

### 1.3 Event mapping — pi-ai events → `StreamChunk`

| pi-ai event | harness chunk |
|---|---|
| `start` | (skipped) |
| `text_start` | `block-start` (blockType `text`) |
| `text_delta` | `text-delta` |
| `text_end` | `block-end` (assembled text block) |
| `thinking_start` / `thinking_delta` / `thinking_end` | `block-start` (`reasoning`) / `reasoning-delta` / `block-end` |
| `toolcall_start` | capture `id`/`name` from the partial message, then `block-start` (`tool-call`) |
| `toolcall_delta` | `tool-call-delta` (`argumentsDelta` is the raw delta) |
| `toolcall_end` | `block-end` with **`arguments: JSON.stringify(event.toolCall.arguments)`** — pi-ai delivers parsed objects; dsh wants raw JSON strings |
| `done` | `usage` (mapped) **then** `finish` (mapped reason + `ReplayEnvelope`); return |
| `error` | `usage` (mapped) **then** `finish` (mapped reason, no replay state); return |

A source stream that ends with neither `done` nor `error` is a protocol
violation → `LlmError STREAM_CLOSED`. Usage mapping folds reasoning tokens
into output (pi-ai's convention) and omits cache fields when zero. Stop
reasons: context overflow (pi-ai's overflow check or an error message
matching the context-window-exceeded pattern) → `error` with code
`CONTEXT_WINDOW_EXCEEDED`; `stop` → `stop` **unless the response has zero
content blocks, in which case it is an `EMPTY_RESPONSE` error**; `length` →
`max-tokens`; `toolUse` → `tool-calls`; `aborted` → `aborted`; `error` →
classified machine code (401/403 → `AUTH`, 429 → `RATE_LIMIT`, 400/413 →
`INVALID_REQUEST`, 5xx → `SERVER`, plus `TIMEOUT`, `TRANSPORT`, else
`PI_AI_ERROR`). The `ReplayEnvelope` (`response` + index-aligned `blocks[]`)
is adapter-private lossless-JSON state for replaying the response; if
`blocks[]` length mismatches the emitted block count the whole envelope is
discarded — and the harness only hands `replayState` back on the request path
when the *same adapter instance* owns both the historical provider and the
target provider.

### 1.4 Gotchas

- **`maxRetries: 0` in the pi-ai options** — the harness owns retry
  (dsh-llm-retry); pi-ai must not retry.
- **`GenerateOptions.stop` is unsupported** by the pi-ai adapter →
  `LlmError UNSUPPORTED_OPTION`.
- **Unsupported explicit efforts are refused, not clamped**: an effort outside
  the model's supported set throws `UNSUPPORTED_REASONING_EFFORT` instead of
  pi-ai's silent client-side clamp (a deliberate deviation).
- **`thinkingLevelMap` semantics are asymmetric** (pi-ai): `null` = that
  level unsupported; an **absent** key = supported for the five base levels
  (`off|minimal|low|medium|high`) but **unsupported** for `xhigh`/`max`
  unless explicitly mapped; a string value = the wire spelling dispatched for
  that level. So a dsh `reasoningEfforts` map must pin undeclared levels to
  `null` explicitly.
- **`off` is special**: a declared `off:` with *no value* means "supported,
  send nothing" — it is translated to an **absent** `off` key in the map (any
  other level may not leave its value empty; `off` with a string value sends
  that string, e.g. `off: "none"`).
- **Image input needs both declarations and the attachment service**: a
  request containing an image whose model doesn't declare `image` input, or a
  deployment without the durable attachment service, is
  `UNSUPPORTED_CONTENT`. Image payloads are bounded per route
  (`maxRequestImageBytes`, default 20 MiB; pixel/bytes budgets).
- **Snapshot pattern**: rebuild the pi-ai `Models` collection only when the
  profile set changes (memoized by identity); in-flight streams keep their old
  collection — `Models.streamSimple()` is lazy and resolves the provider when
  the stream is first consumed.
- **`ReasoningEffortId` is opaque**: dsh core never validates it against a
  fixed enum; pi-ai-based adapters brand the seven thinking-level strings
  (`off|minimal|low|medium|high|xhigh|max`).
- **Settings reads go through the `current()` thunk** (from
  `installSettingsSection`) — never cache the resolved value across
  operations; `validate` refuses unserviceable writes *where they are written*
  (`settings.mutate` answers `settings-rejected` naming the offending route
  and model).

### 1.5 Dynamic (user-chosen) route keys — SPIKE 1: yes

A plugin can declare **any user-chosen route keys**; there is no whitelist —
route keys just need to be non-empty strings. The mechanism:

- **`registerConfigurableProviders(entries)`** → `DirectoryRegistrationHandle`
  (disposer + atomic `replace(entries)`; same validate-first/swap semantics as
  the adapter handle; duplicate key across registrations →
  `DUPLICATE_DIRECTORY`). A directory entry only *names* a route key and its
  settings address (`settingsNs` + `settingsPath`); `listConfigurableProviders()`
  returns every declared provider, **registered or dormant**.
- **Activation = profile + registration**: a route key is live when (a) the
  plugin's settings section has a profile under that key **and** (b) the
  adapter registration includes the route. Configuration surfaces merge the
  directory with the live registry to show every provider with its
  live/dormant state.
- **Reference pattern** (the in-box `llm-pi-ai` adapter does exactly this):
  derive `entries` = installed-catalog keys ∪ user-declared keys (hand-declared
  routes get `declared: true`, `settingsPath: ["providers", <key>]`); on every
  committed settings change, deep-compare the derived facts with the last
  committed ones and — on change — `directory.replace(entries)` and
  `registration.replace([...routes])`, each in its own try/catch so a failed
  swap keeps the previous state. The *minimum* interop, if you skip the
  directory entirely: re-register your adapter routes from your own settings on
  each `onChange` — that alone makes user routes stream; the directory +
  discovery entries are what give configuration surfaces an address to
  render/edit each route.
- **`registerModelDiscovery(settingsNs, discover)`**: offer to interrogate
  provider endpoints **on behalf of your settings namespace** (the namespace
  is the key because a provider being *added* has no route to name yet).
  **One registration per namespace** (a second throws `DUPLICATE_DISCOVERY`).
  Request: `{provider?, baseURL?, api?, apiKey? (one-shot credential — the
  harness never stores it), signal?}`; result: rows of `{id, name?,
  contextWindow?, maxTokens?}`.

Embodied in `src/dsh/index.ts` (adapter + directory + discovery registration,
`onChange` re-registration) and `src/dsh/settings.ts` (schema + write gate).

## 2. Client half: shipping a web UI

### 2.1 The dual-face package

A dsh plugin is a Cordis plugin; the web surface adds a second face — a
browser bundle. **One package, one Cordis row, two faces**: the node-half
`apply` plus a browser bundle the host scans into the client boot graph and
serves over HTTP. There is **no client field in the bundle-patch YAML** —
server and client halves share one row. The declaration is a `dsh.client`
object in the package's `package.json`:

```jsonc
"dsh": {
  "bundle": { "patch": "./dsh.cordis.yml" },   // server row (existing)
  "client": {
    "platform": "web",       // REQUIRED — must be the literal 'web'
    "inject": [ ... ],       // INFORMATIONAL only (preflight display, HMR
                             // diffing) — NOT a runtime gate
    "immediately": false,    // true = stage-one boot prefetch; absent = lazy
    "external": [ ... ]      // module-table requests beyond the implicit
                             // baseline (react, react-dom, cordis,
                             // dsh-client-ui-slots, dsh-client-ui-primitives)
  }
},
"exports": { "./client": "./dist/dsh/client.js", ... }   // REQUIRED once
                                                          // dsh.client exists
```

The browser bundle is the **built artifact** — the host hashes the file and
serves it as-is (no-cache, `/plugins/<id>/client.js`); sources are never
served.

**The scanner's row-name precondition (the one structural blocker).** The
client scanner resolves the package by the *row name*:
`require.resolve('<name>/package.json')` anchored at the profile config-tree
directory. Consequences:

- the Cordis row `name` must be the **bare package name** — a subpath name
  (e.g. `modelspoke/dist/dsh/index.js`) is invisible to the scanner;
- `main` must be the plugin entry (the in-repo dual-face pattern is
  "whose main IS its plugin entry" — a package whose `main` is a pure library
  with no `apply` won't work);
- introducing an `exports` map **closes all other subpaths** — keep explicit
  subpath exports for anything still imported as `modelspoke/<subpath>` (the
  pi host and the tests);
- package metadata (including the "not a client package" verdict) is cached
  per name for the **process life** → the first client-row pickup needs a
  restart; bundle *content* changes after that are HMR-only (the HMR
  receiver stat-polls each row's bundle and reloads just that plugin via the
  `/plugins/events` SSE — rewriting the dist client bundle is all that's
  needed).

### 2.2 The slots the UI occupies

The web app is a **slot composition, not a URL router** — there is no
"register your own route/page" API; every surface is a slot
(`ctx.slots.register`, and `ctx.slots.inject('<slot>', …)` to register into a
slot declared at runtime). All slots below are declared by shipped,
always-mounted client packages, so they're open to any loaded client bundle.
For modelspoke the relevant ones:

| Slot | Renders as | Notes |
|---|---|---|
| `settings.section` | A new row in the Settings nav opening a full page | The **recommended editor home**; the nav is auto-projected from the section ledger — zero shell edits. |
| `settings.onboarding` | Ordered first-run modal steps | Owner gets `{ stepId, complete, openSection }`. |
| `settings.plugin.item` | A card inside Settings → Plugins → Configurable, **keyed by settings namespace** | *Explicitly designed for plugins shipped outside the dsh repo*; the tab enumerates every namespace the host exposes in `settings.describe` and dispatches one card per namespace — a plugin that registers a namespace + a card under that key appears automatically. |
| `settings.plugins.tab`, `settings.general.item`, `settings.trigger/header/action/close`, `shell.overlay`, `sidebar.footer.action` | Tabs / rows / chrome / overlays | Open but less fitting; there is **no third-party top-level nav seat** — Settings is the supported home. |

### 2.3 The loopback RPC-channel bridge (client ↔ its own server code)

The big question — can a plugin's *browser* code invoke its *own*
server-side logic? **Yes: the Connection package ships a generic,
bundle-open RPC-channel registry** (verified shipped in rc.2):

```
host (dsh process, server apply):
  ctx.get('connection')?.rpc.handle(
    '/modelspoke',                          // channel: /^\/[A-Za-z0-9._~-]+$/;
    async (endpoint, payload, signal) => {…},// '/api' is reserved
    { authority: 'loopback' }               // trust fence: loopback only
  )                                         // ⇒ HTTP route /modelspoke/<endpoint>,
                                            //   403 for off-loopback origins
browser (client apply):
  ctx.get('connection').rpc.call('/modelspoke', 'firstUseImport', {})
```

Properties that make this the right tool: **bundle-open by design** (any
plugin registers one absolute channel prefix + trust policy — cross-package
use is the intended pattern); **trust-fenced for free** (`authority:
'loopback'` applies the same fence as `/api`; `trusted-host` accepts the
deployment's trusted hosts); **lifecycle-safe** (the registration is a fiber
effect — the channel disappears with the composition). Endpoint segment
grammar is `[A-Za-z0-9_$.-]` — **no hyphens** (`firstUseImport`, not
`first-use-import`).

Server-side availability gotcha: `connection` is a sibling service that
exists **only in the web composition**. Never add it to the plugin's static
`inject` (the plugin must still boot dormant in tui/headless profiles) — read
`ctx.get('connection')` at apply time and additionally subscribe to the
`internal/service` event (`{ global: true }`) so the channel registers
whichever order the two fibers activate, guarded idempotently.

**The shared `/api` surface** (typed `ctx.connection.api`) is callable from
any client bundle and covers the rest: `settings.describe/update/replace/mutate`
(`mutate` = `{ns, ops: [{op:'set'|'unset', path, value?}], expectedRevision?}`;
every response carries the namespace's new **redacted** view with a monotonic
`revision`), `llm.discoverModels` (the host dispatches straight into the
plugin's registered discovery callback — the same call the in-repo Models page
makes), `llm.providers`/`llm.models`, `credentials.*`. The whole configuration
plane is **loopback-pinned** — a non-loopback (LAN) browser simply gets no
durable settings. For reads + simple writes, the ergonomic client face is
`ctx.settingsScope.bind({namespace})` — snapshot/subscribe plus
revision-fenced `set`/`unset` (single top-level field per write; use
`settings.mutate` for nested paths).

**Forwarded events** a client may `$on` are a hard-coded allowlist:
`settings/document-updated`, `llm/adapters-updated`,
`credentials/reference-updated`, plus session/agent-preset rows — enough for
live updates (route CRUD made anywhere → document event → scope re-derives;
adapter registry changes → adapters-updated). Genuinely closed (and **not
needed**): no bundle-defined method in the shared `/api` map, no
bundle-defined forwarded events, no strict generated `Remote` for third-party
packages — the generic channel + the existing methods + the existing events
cover the full editor.

Embodied in `src/dsh/client.tsx` (the client half; E2E-verified in the
testenv web profile).

## 3. Settings writes — the seam

The canonical consumer wiring is **`installSettingsSection(ctx, ns, schema,
entry, hooks)`**: while a settings service exists, register the plugin's
namespace with the composition entry as the `base` layer and hand the plugin a
`current()` source thunk; when the service goes away (disposal, provider
reload), fall back to the entry so the plugin keeps working exactly as
composed. Hooks: `setSource` (source swapped at attach/detach), `onChange`
(re-derive registration facts — this is where route re-registration happens),
`validate` (refuse unserviceable writes at the write site).

Write paths from inside the plugin: `ctx.settings.update(NS, patch)` (merge),
`ctx.settings.replace(NS, section)` (wholesale; `replace({})` resets to
base+defaults), `ctx.settings.mutate(NS, [{op, path, value?}, …])`
(path-addressed edits — the right tool when the caller holds a *redacted*
view). All three validate before persisting, are serialized per-namespace, and
emit `settings/updated` (resolved value changed) and `settings/document-updated`
(raw section changed); the plugin's `onChange` then re-registers.

**The fence is per-call.** Each read of a namespace returns a `revision`;
passing it back as `expectedRevision` makes the write reject if the section
changed in the meantime — a lost fence raises `SettingsConflictError`
(code `SETTINGS_CONFLICT`) and the write is *not applied*; without
`expectedRevision`, a concurrent write is simply overwritten (re-read and
retry is the pattern).

**Out-of-band document edits take the same path.** The file provider (one
YAML document under the harness home — `settings.yaml`, see
`testenv/baseline/settings.yaml` for the reference shape) is watched and
hot-reloaded (write-settle debounce); every write re-reads the document under
a **cross-process writer lock** and patches it as a **comment-preserving
leaf-level diff**. A hand edit in an editor publishes through the same seam as
an in-plugin write — there is no second code path to keep in sync. For the
full contract (descriptor shape, conflict semantics, redaction, file-provider
behavior): the `dsh-settings` / `dsh-settings-file` type docblocks in the npm
package, and modelspoke's own docblocks in `src/dsh/settings.ts`.

## 4. Tool views: rendering `read_image` results

### Problem statement

The `read_image` tool logs its result as `[text envelope, image block]`,
where the image block is a **content-addressed reference**
(`{ type: 'image', attachment: <ref> }`) — never base64. The model side
consumes these refs (the LLM context builder walks image refs *inside tool
results*), so the model sees the image. But the web GUI's generic tool card
flattens every non-text content block with `JSON.stringify`, so a human
looking at the same turn sees a **JSON blob instead of the picture** — a
human who can't see the image can't verify the model's claim about it. This
stringify behavior is deliberate and pinned by a test (a behavior change, not
a latent bug). The image-rendering machinery — bounded `<img>` + lightbox,
loaded on demand via the session's attachment reader — already exists, but is
keyed to *message* content only: a tool result's image block is never handed
to it.

### Technical solution (the 3-step host fix)

1. **Thread the image loader into the tool view.** The tool tree already
   *receives* the message-image renderer on its owner props but never
   forwards it into the keyed `tool.call.toolview` owner — add it to the
   owner props and pass it through.
2. **Render image content blocks in the row.** Either in the generic tool
   card for every settled result, or — matching the existing per-tool views —
   as a keyed `read_image` tool view. The `tool.call.toolview` slot is open,
   keyed by tool name, session-scoped, and its key domain is explicitly
   third-party: an unclaimed key falls back to the generic card.
3. **Skip image blocks in the text derivation** so the expanded text body is
   the envelope only (the image renders as an image, not a stringified ref);
   update the pinned test to the new shape.

### The shipped plugin-side workaround (modelspoke, zero dsh changes)

`src/dsh/toolview.ts` (pure helpers) + `src/dsh/client.tsx` (the gated keyed
tool view), E2E-verified in the testenv web profile: register a keyed
`read_image` tool view (the key is unclaimed — additive); load the bytes via
the injected `sessions` service (attachment reader → object URL, revoked on
unmount); render a bounded `<img>` + envelope text + caption; **fall back to
the text line on any load failure**; and **gate the registration itself** on
an opt-out setting, deregistering live when disabled so the host row owns the
call (no dead view shadowing a future host fix). This proves the extension
point works end-to-end without a host change and is the concrete shape a
host-owned version of steps 1–3 would absorb.

### Relationship to dsh issue #3998

Complementary, not conflicting. #3998 proposes surfacing **MCP `meta.images`**
— base64 payloads that ride the wire with *no durable storage identity*; for
that path, base64-in-meta is the right mechanism. The `read_image` image
already has a content-addressed durable identity, with the bytes stored,
validated, and downscaled on disk at write time (admission caps) — re-basing
them to meta-base64 would bloat every logged/replayed turn with a redundant
copy. Both paths touch the generic card's content-block rendering, so they
should be unified in one pass (a single "render image-bearing blocks" step,
with the text derivation skipping both) rather than landed as two overlapping
patches.

## 5. What dsh does not offer today

- **No plugin-registered settings-layout surface (the S2/S3 gap).** The
  Models page's per-namespace layout is a hardcoded string switch — no
  registry, no metadata lookup, no plugin-visible hook — so a plugin's
  namespace renders only the built-in *hint* inside the Models dialog, and
  nothing more. A plugin-owned per-row editor would require the roadmap's S2
  layout registry / S3 plugin-registered layouts. Until then, the supported
  pattern is what modelspoke ships: own the full surface as a
  `settings.section` page (plus onboarding and a keyed plugin card) and
  read/write the namespace through the settings seam (§3).
