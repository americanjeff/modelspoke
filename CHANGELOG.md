# Changelog

Coarse and consumer-facing — the kind of thing a dsh user or a `./lib`
consumer can act on. Build-internal work (tests, comments, docs) does not
belong here.

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
