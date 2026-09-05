# Changelog

Coarse and consumer-facing — the kind of thing a dsh user or a `./lib`
consumer can act on. Build-internal work (tests, comments, docs) does not
belong here.

## Unreleased

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
