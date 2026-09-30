# Changelog

Coarse and consumer-facing — the kind of thing a dsh user or a `./lib`
consumer can act on. Build-internal work (tests, comments, docs) does not
belong here.

## 0.3.2 — 2026-09-29

- **Fixed: deleting every model row no longer flips a provider to serving
  its whole catalog** — removing all rows and hitting Apply used to store
  the route with no `models:` list, which reads back as "serve the full
  catalog": the card re-populated with every model from the provider. An
  empty list is now a real, stored state (`models: "none"` — configured,
  serves nothing) and stays empty across reopens. Hand-edited `models: []`
  or absent `models:` still mean the full catalog, as before.
- **A new provider starts empty** — connecting a provider no longer
  immediately serves (and, after the first edit, routes) every model in
  its catalog. The new provider is configured but serves nothing until you
  add models; the catalog remains visible in the card to add from.
- **Fixed: tool calls silently broken on dsh 0.2.0-rc.2** — the host's
  pi-ai ≥0.87 (bundled with dsh 0.2.0-rc.2) reads request tools only from
  its new transcript context shape; modelspoke's envelope dropped the tool
  schemas from the wire, and the model answered with literal `<toolcall>`
  XML text instead of calling tools. modelspoke now folds its context
  through the host's shape when it is present — older hosts (dsh 0.1.7)
  are unaffected.

## 0.3.1 — 2026-09-27

- **Fixed: the session now gets the capabilities the provider card already
  showed** — the session's model resolution skipped the backend-registry
  scan the settings card runs, so a model like `glm-5.3-flash:cloud` on an
  Ollama route listed its full reasoning-effort map, image input, and 1M
  context window on the card while the session resolved the same model on
  defaults: no reasoning-effort control in the session, `read_image`
  refusing with "does not declare image input", and a silent 256K context
  fallback. Card and session resolve through the same discovery tier now
  (equally for SGLang / vLLM / LM Studio / llama.cpp routes). A thinking
  model the built-in tables don't cover simply offers no effort control —
  the server's own default thinking applies.
- **Fixed: "Off" actually turns thinking off on Ollama models** — selecting
  Off dispatched no effort at all, so the server default applied (`max`
  thinking on `glm-5.3-flash:cloud`); Off now sends the model's own off
  spelling (`reasoning_effort: "none"`).
- **The settings card is flat** — no expand/collapse, no boxed panel: the
  providers section renders directly on the plugin page, open on arrival.

## 0.3.0 — 2026-09-23

- **The host requirement is now dsh 0.1.7** (breaking) — modelspoke loads
  on dsh 0.1.7 and newer only (verified against 0.1.7-rc.1); dsh 0.1.5 and
  0.1.6 hosts are no longer supported. 0.1.7 removed the settings brand
  seam (the `installSettingsSection` / "Plugin configuration" card slot)
  modelspoke's editor used to ride, and rebuilt plugin configuration
  around the profile's Loader config.
- **The provider editor moved to the sidebar Plugins page** — dsh 0.1.7
  dropped the Settings → Plugins "Plugin configuration" area; the
  Modelspoke card now lives on the **Plugins** page in the sidebar: open
  the **modelspoke** row in the Installed group and the card renders on
  its bundle detail page. Same card, same flow (+ Add provider, model
  rows, thinking levels, Apply).
- **Your configuration lives in the profile's `cordis.patch.yml` now** —
  dsh 0.1.7 stores plugin config as an id-targeted entry in the active
  profile's `cordis.patch.yml` instead of the DSH_HOME-root
  `settings.yaml`. A `settings.yaml` left by an older dsh is imported once
  on first boot (sections mapped to the same-id entries, then the file
  renamed `settings.yaml.imported`), so an existing `modelspoke:` section
  migrates automatically; manual edits go in the profile's patch entry
  from now on.
- **Tool-role messages are first-class** (internal) — the request context
  now emits `role: "tool"` results through the host's
  `createToolResultMessage` (dsh 0.1.7's shape) instead of the legacy
  folding, with the system prompt split per the new host contract.

## 0.2.0 — 2026-09-11

- **The host requirement is now dsh 0.1.5** (breaking) — modelspoke loads on
  dsh 0.1.5 and newer only (verified against 0.1.5-rc.2); dsh 0.1.1 and 0.1.2
  hosts are no longer supported.
- **The custom `read_image` view is retired** — dsh 0.1.5 ships its own
  `read_image` row (read-family chrome, collapsed-by-default card,
  session-authorized image loader, PTC-nested coverage) that modelspoke's
  earlier view only shadowed. The `renderReadImages` setting is gone: if you
  ever set it, delete that line from your `modelspoke:` section.
- **The loopback metadata bridge is a plain HTTP endpoint now** (internal) —
  the model-detail metadata (context window, max tokens, image input,
  thinking levels) no longer rides the host's logical RPC channel
  (`connection.rpc.handle`); on dsh 0.1.5 that API throws for third-party
  plugins (the host reads `webServer` on a fiber that never injects it —
  tracked on the dsh bug list as BUG-025). It now rides an exact Fetch
  route under the host's authenticated `/api` transport
  (`POST /api/modelspoke`), same reachability, no correlation machinery.
- **Fixed: deleting a model row in the card and re-adding the same model
  resurrected the deleted row's saved settings** — the re-added row is a
  fresh row, but the card's committed-configuration lookup keyed the
  deleted row's settings (for example a stale `input: [text]` that
  out-shadowed the live discovery's image-input support) onto the re-add by
  name / wire id. A within-session removal now blocks that re-association:
  the re-added row seeds from discovery as if it were never configured, and
  an edited re-add commits a fresh entry instead of re-minting the deleted
  row's settings.

## 0.1.4 — 2026-09-06

- **The web UI now works under dsh 0.1.2** — the browser half (the
  Modelspoke settings card and its model rows) was built against the dsh
  0.1.1 web shell and did not load under dsh 0.1.2. It is rebuilt against
  the 0.1.2 shell (verified against a live 0.1.2-rc.1 `dsh web` with the
  e2e suite); the node half still loads on both 0.1.1 and 0.1.2.

## 0.1.3 — 2026-09-05

- **Works under a dsh 0.1.2 host** — modelspoke now loads and serves its routes
  on dsh 0.1.2 (the `dsh-llm`/`dsh-settings` API changes that made it fail to
  load after a dsh update are now handled); 0.1.1 is still supported.

## 0.1.2 — 2026-09-05

- **The install is a single command with no pnpm build-script approval** —
  modelspoke no longer pulls its own pi-ai copy into the profile; it uses the
  one its dsh installation ships (tested span 0.82.1–0.84.x).
- **The settings UI moved to the Plugins settings page** — the standalone
  "modelspoke" settings section is replaced by an expandable **Modelspoke**
  card in Settings → Plugins → Plugin configuration; expand the card, then
  **+ Add provider**. (README setup step 3 updated.)
- **The first-run "Use your local models" import step is gone** — its
  trigger was too narrow to be worth keeping. To migrate a hand-written
  `llm-pi-ai` block, add the modelspoke route manually (same name/base URL;
  the block shadows a same-named route until you delete it), then delete the
  block.

## 0.1.1 — 2026-09-04

- **`./lib` core hardening** — `discoverModels` no longer crashes in a
  browser bundle (accepts a caller-resolved `apiKey`; the `apiKeyEnv` read
  degrades to "no key" without `process.env`); non-object `/v1/models`
  elements degrade to a bare row instead of throwing; server error bodies
  are read with a cap; `extractInput` never reports `image` without `text`;
  `matchPreset` tolerates a malformed pattern in a caller-supplied catalog;
  the `resolveModel` tier-1 precondition (pre-canonicalized override) is
  documented.
- A model loaded into the router (e.g. llama-swap) after the last
  `/v1/models` fetch now shows up in dsh within a minute, without a
  process restart (discovery memo TTL).
- A route `models` list whose elements are all malformed (e.g. an empty
  `id`) now degrades to the full catalog, instead of serving an explicit
  empty set.

## 0.1.0 — 2026-09-04

- First public release: llama-swap catalog discovery + five server backends
  (SGLang, Ollama, LM Studio, VLLM, llama.cpp), tiered metadata resolution
  (override → preset → discovered → default), four built-in presets with a
  drift checker, the dsh settings UI, and the framework-neutral `./lib`
  export.
