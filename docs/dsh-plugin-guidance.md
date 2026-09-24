# dsh plugin guidance — building modelspoke's host integration

*Reference for the dsh (DeepSeek Harness) integration in `src/dsh/`: the
adapter contract, the settings seam, and shipping a web UI. Behavior was
verified against dsh **0.1.7-rc.1** (e2e + unit suite green against a live
0.1.7-rc.1 `dsh web`); the exact signatures are in the npm-published dsh
package (and its `@deepseek-ai/*` sub-packages) — consult those `.d.ts`
files, don't copy from this doc.*

*Version floor: the **node half loads on dsh 0.1.7 and newer only** —
0.1.5/0.1.6 hosts are no longer supported (the settings brand seam they
exposed was removed in 0.1.7; §3). The **client bundle targets the 0.1.7
web shell** (its `configForms` surface and module table, §2); it is built
and e2e-verified against 0.1.7-rc.1.*

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
- **`imageRequestPricing(provider, model)` (added in 0.1.2)**: advisory
  per-model image-input cost the token meter consults on estimation paths
  (a manual compact triggers a full re-estimation). The base class defaults
  to a no-op and the dispatcher calls it through an optional chain — a
  concrete adapter is safe *forward*, but inheriting the 0.1.1 base class
  (no such method) under a 0.1.2 host throws
  `imageRequestPricing is not a function` at estimation time. That version
  drift is the reason the dsh devDeps float with the host rather than pin.
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
  defers to pi-ai's own ambient discovery.
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
- **Settings reads go through the composed-config thunk** (`apply(ctx,
  config)` takes the live composed config — volatile fields as reference
  objects read with `.get()`, §3) — never cache a read value across
  operations; the schema refuses unserviceable writes *where they are written*
  (an invalid `settings.mutate` payload is rejected before persisting,
  naming the offending route and model).

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
  harness never stores it)}` — 0.1.2 dropped `signal` from the request
  object; the abort signal arrives as the callback's **second argument**:
  `discover(request, signal?)` (the 0.1.1 callback read `request.signal`).
  Result: rows of `{id, name?, contextWindow?, maxTokens?}` — the client
  half receives the same rows as `LlmDiscoveredModel[]` (§2.3).

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
    "inject": [ ... ],       // Cordis inject edges: the provider package rows
                             // whose services the bundle consumes (modelspoke:
                             // dsh-api-remotes, dsh-api-session-controller,
                             // dsh-client-connection, dsh-client-ui-renderer,
                             // dsh-client-ui-settings). Composition orders
                             // suppliers before consumers and guides factory
                             // arrival; cordis service-wait remains the
                             // activation authority — a missing provider shows
                             // up as a PENDING fiber at the settled sweep
    "immediately": false,    // true = stage-one boot prefetch; absent = lazy
    "external": []           // module-table requests beyond the implicit
                             // baseline. 0.1.2 baseline (PLATFORM_MODULES):
                             // react, react/jsx-runtime, react-dom,
                             // react-dom/client, cordis, dsh-client-store,
                             // dsh-client-ui-slots, dsh-client-ui-primitives.
                             // PRELOADED_CLIENT_EXTERNALS is empty (the 0.1.1
                             // preload of dsh-client-runtime/client is gone).
                             // modelspoke requires only react +
                             // react/jsx-runtime at runtime → []
  }
},
"exports": { "./client": "./dist/dsh/client.js", ... }   // REQUIRED once
                                                          // dsh.client exists
```

The browser bundle is the **built artifact** — the host hashes the file and
serves it as-is (no-cache, `/plugins/<id>/client.js`); sources are never
served.

**Dev-time versioning (the 0.1.7 line).** The dsh client packages are
dev-only *type inputs* — the shipped profile supplies the runtime
identities, so the browser never loads modelspoke's `node_modules`. The
`devDependencies` therefore float on a **dist-tag** rather than a version
range: dist-tags are the only cross-prerelease-series float (a range like
`^0.1.1-rc.2` never matches `0.1.2-rc.1` under semver prerelease rules, and
`*` excludes prereleases); the lockfile pins whatever the tag resolved to
until you `pnpm update`. (The 0.1.2-era wrinkle — published peer ranges
shaped for the previous line dragging a stale sub-tree into the typecheck
program, worked around with a `pnpm-workspace.yaml` override table — is
gone: the 0.1.5+ family publishes with self-consistent peer ranges, so the
plain resolve is the consistent set and the override table was dropped.)

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
| `plugins.bundle.config` | The bundle's configuration on the sidebar **Plugins** page's bundle-detail view, **keyed by the bundle's package name** | **modelspoke's editor home (0.1.7)** — *explicitly designed for plugins shipped outside the dsh repo*; the page renders the entry between the bundle's description and its rows, gated by the plugin's own registration (modelspoke gates through `configForms.whileServed` on its namespace, so a deployment that does not serve the section shows no trace). `view: 'page'` is for forms with their own save controls; modelspoke renders inline. |
| `plugins.row.config` | A **Configure** control on one row's page, keyed `<package name>#<row id>` | The per-row successor of the settings-card rows; modelspoke keeps row editing inside its bundle card instead. |
| `settings.section` | A new row in the Settings nav opening a full page | The full-page section home (the in-box sections' choice); the nav is auto-projected from the section ledger — zero shell edits. modelspoke moved its surface into the plugin card above. |
| `settings.plugins.tab`, `settings.general.item`, `settings.trigger/header/action/close`, `shell.overlay`, `sidebar.footer.action` | Tabs / rows / chrome / overlays | Open but less fitting; Settings (0.1.7) is the **read-only** "Built-in plugins" inventory — configuration moved to the sidebar Plugins page, the supported home. |

### 2.3 The loopback endpoint bridge (client ↔ its own server code)

The big question — can a plugin's *browser* code invoke its *own*
server-side logic? **Yes — as an exact Fetch route under the host's
authenticated `/api` transport** (verified on 0.1.5-rc.2 — modelspoke's
`discoverMetadata` e2e rides it):

```
host (dsh process, server apply):
  ctx.inject(['connection'], (cc) =>       // 0.1.5: the service is visible
    cc.get('connection').fetch.register({  //   through the inject seam only
      path: '/api/modelspoke',             //   (a cross-fiber ctx.get
      methods: ['POST'],                   //   does not see it)
      requestBody: 'buffered',
      fetch: async (req) => …Response…
    })                                     // fence + browser auth are applied
                                           //   by the /api route BEFORE the
                                           //   bridge dispatches
browser (client apply):
  fetch('/api/modelspoke', { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint: 'discoverMetadata', payload: {…} }) })
```

Why a Fetch route and not a logical RPC channel: on 0.1.5-rc.2
`connection.rpc.handle` **throws for all third-party callers** — the host
registers the channel's physical route through a `webServer` property read
on a fiber that never injects it ("cannot get property 'webServer' without
inject"; dsh bug list BUG-025) — and `rpc.intercept('/api', …)` is
single-tenant (the API gateway occupies it). `fetch.register` needs
neither: it only fills the host's own route map, and the shared `/api`
handler serves exact Fetch routes before the gateway fallback dispatch.

Properties that make this the right tool: **authenticated for free** (the
route rides the `/api` prefix route, which applies the Host/Origin fence +
the 303-token browser cookie — reachable only from the authenticated
browser origin); **lifecycle-safe** (the registration is a fiber effect —
the route disappears with the composition).

Server-side availability gotcha: `connection` is a sibling service that
exists **only in the web composition**. Never add it to the plugin's static
`inject` (the plugin must still boot dormant in tui/headless profiles) —
register through `ctx.inject(['connection'], …)` so the registration rides
a child fiber that waits for the service (a silent no-op when it never
appears), guarded idempotently. The route PATH is the full absolute path
the browser requests — the 0.1.5-rc.2 dispatch keys its route map by
`new URL(request.url).pathname`, so the type-docstring's "path below /api"
convention does not hold in practice (verified empirically: only the full
`/api/…` key matches).

**The shared remote surface** (typed `ctx.remote`) is callable from any
client bundle and covers the rest. 0.1.2 removed the 0.1.1
`ctx.connection.api.<ns>` client — `ConnectionHandle.api` is gone with the
connection reorg — in favor of a **namespaced remote client**:
`ctx.remote.llm.discoverModels(settingsNs, request, signal?)` (the same
request shape as §1.5; the host dispatches straight into the plugin's
registered discovery callback — the same call the in-repo Models page makes;
keyed on the **settings namespace**, not a route, because the row being
configured may not exist as a live route yet),
`ctx.remote.llm.listConfigurableProviders` / `listProviders`,
`ctx.remote.settings.*` (describe/update/replace/mutate — `mutate` =
`{ns, ops: [{op:'set'|'unset', path, value?}], expectedRevision?}`; every
response carries the namespace's new **redacted** view with a monotonic
`revision`), `ctx.remote.credentials.*`. Every call resolves to a
`RemoteResult<T>` envelope — `{ok: true, value}` / `{ok: false, error}`
(`error.message` is the display string) — not a raw value. The whole
configuration plane is **loopback-pinned** — a non-loopback (LAN) browser
simply gets no durable settings. For reads + simple writes, the ergonomic
client face is `ctx.settingsScope.bind({namespace})` — snapshot/subscribe
plus revision-fenced `set`/`unset` (single top-level field per write; use
`settings.mutate` for nested paths).

**Forwarded events** are a hard-coded allowlist, subscribed in 0.1.2 on the
remote client — `ctx.remote.$on('settings/document-updated', …)` (the 0.1.1
subscription point was the connection face): `settings/document-updated`,
`llm/adapters-updated`, `credentials/reference-updated`, plus session/
agent-preset rows — enough for live updates (route CRUD made anywhere →
document event → scope re-derives; adapter registry changes →
adapters-updated). modelspoke's client doesn't even need the allowlist: its
live re-sync rides the `settingsScope` binder's own `subscribe` (a scope
snapshot changes on the same document update), so no `$on` appears in
`client.tsx`. Genuinely closed (and **not needed**): no bundle-defined
method in the remote map, no bundle-defined forwarded events, no strict
generated `Remote` for third-party packages — the generic channel + the
existing methods + the existing events cover the full editor.

Embodied in `src/dsh/client.tsx` (the client half; e2e-verified against a
live 0.1.2-rc.1 `dsh web` instance).

## 3. Settings writes — the seam

**The settings brand seam is gone as of 0.1.7.** The 0.1.2→0.1.6 line
(0.1.1's free function `installSettingsSection(…)` became a method on the
settings service reached through the scoped `ctx.inject(['settings'], …)`
with plain lowercase-hyphenated namespace strings) was removed: a plugin
now declares a `Config` schema, and the LOADER composes bundle patch →
profile patch → schema defaults, validating the entry's `config:` against
the schema at the write site. The composed config is readable at
`apply(ctx, config)` time. Schema fields marked `.volatile()` (modelspoke:
`routes`) arrive as LIVE REFS — a web-card save commits in place into the
running ref and emits the loader-side event `loader/volatile-update`
(absent from cordis's Context Events map, so the subscribe takes a generic
cast at that boundary); the plugin listens and re-runs its registration
glue — adapter/directory registration re-derived from the new section, no
re-apply, no re-registration of discovery (once per namespace).
`deepEqualJson` is a local copy in `src/dsh/compat.ts` (no dsh-settings
value import). All writes are browser-driven: the card reads through
`configForms.get(NS)` (snapshot + subscribe, re-derived on the shared
describe mirror) and writes through `configForms.set(field, value)` — a
single-top-level-field write over the settings seam's `settings.mutate`,
auto-fenced with the latest namespace revision — and the card's
registration is gated through `configForms.whileServed` so it shows only
while the Host serves the namespace (§2.2). The node half holds no
settings service and writes nothing.

Write paths (0.1.7): the browser half's `configForms.set(field, value)`
is a single-top-level-field `settings.mutate` write addressed as
`path: [field]` — the path-addressed form is the right tool when the
caller holds a *redacted* view. Writes validate before persisting, are
serialized per-namespace, and emit `settings/updated` (resolved value
changed) and `settings/document-updated` (raw section changed); volatile
fields additionally emit `loader/volatile-update`, which re-runs the
node half's registration glue.

**The fence is per-call.** Each read of a namespace returns a `revision`;
passing it back as `expectedRevision` makes the write reject if the section
changed in the meantime — a lost fence raises `SettingsConflictError`
(code `SETTINGS_CONFLICT`) and the write is *not applied*; without
`expectedRevision`, a concurrent write is simply overwritten (re-read and
retry is the pattern).

**Out-of-band document edits take the same path.** The document is the
active profile's `cordis.patch.yml` — a top-level YAML array of
id-targeted loader patch entries (the plugin's own entry carries its
`config:`; `!!js` expressions allowed). The file is watched and hot-reloaded
(write-settle debounce); every write re-reads the document under the profile
**writer lock** and persists it atomically (tmp + rename), replacing the
entry's `config:` node in a document-level parse/edit (comments elsewhere in
the file survive; a replaced subtree does not). A hand edit in an editor
publishes through the same seam as an in-plugin write — there is no second
code path to keep in sync. For the full contract (descriptor shape, conflict
semantics, the config-editor lifecycle): the `dsh-settings` /
`dsh-config-editor` type docblocks in the npm package, and modelspoke's own
docblocks in `src/dsh/settings.ts`.

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
a latent bug — re-verified on 0.1.2-rc.1: `ui-tool`'s `tool-call-model.ts`
still stringifies non-text blocks in the generic card). The image-rendering
machinery — bounded `<img>` + lightbox,
loaded on demand via the session's attachment reader — already exists, but is
keyed to *message* content only: a tool result's image block is never handed
to it.

### The fix landed in the host

dsh 0.1.5 ships its own `read_image` row — read-family chrome,
collapsed-by-default card, session-authorized image loader — that renders
the tool result's image block natively; the generic card no longer flattens
tool-result images into a JSON blob. The three-step shape above (thread the
loader, render the block, skip it in the text derivation) is what the
in-tree row amounts to. Issue #3998 (surfacing **MCP `meta.images`** —
base64 payloads with no durable storage identity) remains a separate,
complementary path: the `read_image` image already has a
content-addressed durable identity, so re-basing it to meta-base64 would
bloat every logged/replayed turn with a redundant copy; the two paths
should be unified in one "render image-bearing blocks" pass rather than
landed as two overlapping patches.

### The retired plugin-side workaround

Before 0.2.0, modelspoke shipped a zero-dsh-change workaround for this
gap: a keyed `read_image` tool view (pure helpers in `src/dsh/toolview.ts`
+ the gated registration in `src/dsh/client.tsx`), E2E-verified in the
testenv web profile — bytes loaded through the injected `sessions` service
(attachment reader → object URL, revoked on unmount), a bounded `<img>` +
envelope text + caption, a text-line fallback on any load failure, and the
registration itself gated on the opt-out `renderReadImages` setting so
disabling handed the call back to the host. Once the host's row landed, the
view only shadowed it: the view AND the setting were retired in modelspoke
0.2.0 (`src/dsh/toolview.ts` is gone, `renderReadImages` is no longer a
field). The lesson for other plugins stands: claim an unclaimed
`tool.call.toolview` key only while the gap is real, and gate the
registration so the host row can take the call back cleanly.

## 5. What dsh 0.1.7 does not offer (anymore)

- **The Settings-dialog plugin-configuration surface is gone.** 0.1.7's
  Settings is the **read-only** "Built-in plugins" inventory; third-party
  configuration lives on the sidebar Plugins page's bundle detail
  (`plugins.bundle.config`, §2.2). The 0.1.5/0.1.6 `settings.plugin.item`
  slot and the `installSettingsSection` seam that modelspoke's 0.1.5 card
  rode do not exist in 0.1.7 — ports from the older line must re-home the
  surface (exactly what modelspoke 0.3.0 did).
