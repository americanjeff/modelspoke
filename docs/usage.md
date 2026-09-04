# Using modelspoke

[README](../README.md) · [README.zh](../README.zh.md) · [design.md](design.md) · [llama-swap setup](llama-swap-setup.md)

The install steps in the README get you a working provider; this page covers
what to do after that — how a model's settings actually resolve, what each
field in the UI does, and what the config file looks like when you edit it by
hand.

## The resolution chain

Every capability field for a model — context window, max output tokens, image
input, the thinking levels — is resolved independently, from the most
specific source down to the least:

1. **Your configuration** — a value you set in the per-model detail, or an
   entry in an `overrides:` block.
2. **Server discovery** — values read live from the endpoint's
   `GET /v1/models` (llama-swap serves them from its
   `llama-swap.yaml` `metadata` blocks; Ollama from its extensions). Re-fetched
   whenever you expand a provider or model, so the UI always reflects the
   server's current state.
3. **Bundled preset** — the matching entry in the preset catalog (see
   [preset-authoring.md](preset-authoring.md)) when your model id matches its
   `match` pattern and the server didn't provide the field.
4. **Built-in default** — the conservative fallback (no thinking dimension,
   text-only input, no declared limits).

First non-empty value wins, per field. Two practical consequences:

- **Clearing a field is a release, not a delete.** Empty out a detail field
  and that field falls back to the next tier down — e.g. clear the context
  window you typed and discovery (or the preset) takes over again.
- **A preset never beats you.** If you set a value, it wins over both
  discovery and the preset, on that field only.

The full mechanics — including how the resolved source is reported per field —
are in [design.md](design.md), "Tiered reasoning-metadata resolution".

## The provider card

Each provider is one row (name + status dot + Edit / Delete) and, when
expanded, an in-place card:

- **Name** — the provider's identity key. Renaming it carries its models and
  overrides with it.
- **Base URL** — the OpenAI-compatible endpoint, e.g.
  `http://127.0.0.1:8080/v1`.
- **API key env var name** — the *name* of the environment variable that
  holds the key. modelspoke only ever reads `process.env`; the key's *value*
  is never stored in `settings.yaml`. Omit it for keyless local servers — no
  auth header is sent in that case.
- **Status dot** — green: the last catalog fetch succeeded. Red: the fetch
  failed (hover for the reason). Grey: never checked yet.

**The model list is the curation.** A model is addressable by the agent only
while it is in the provider's model list. Each row is `[display name][wire
id][chevron][−]`:

- The **display name** (editable) is the model's identity in the agent —
  leave it blank and it defaults to the wire id.
- The **wire id** (combobox) is the model id that goes on the wire; it is
  populated from the fetched catalog but typeable, so you can reference a
  model the server hasn't served yet. Duplicate wire ids are allowed as named
  variants.
- The **chevron** opens the per-model detail (below).
- **−** removes the model from the served set.

**Apply** commits everything you changed in the card — provider fields, the
served set, per-model edits — as one atomic write; **Cancel** reverts to the
last committed state. A card you only viewed writes nothing.

## The per-model detail

The chevron opens the editable configuration for one model. Every field you
leave untouched stays seeded from the effective value (the resolution chain
applied) and is never committed as-is — only fields you actually change are
written:

- **Context window** — the model's context size in tokens.
- **Max output tokens** — the per-response output cap.
- **Image input** — declares the model accepts images. This is the gate the
  agent's `read_image` tool checks before offering a model vision; unchecking
  it turns vision off for that model.
- **Reasoning effort** — declares the model has a thinking dimension.
  **Unchecked is the "nothink" sentinel**, not just "off" (below).
- **Thinking level map** — one row per selectable level: the level the UI
  offers (left) and the value the model actually accepts (right). Add or
  remove rows to match what the template takes. A wrong entry here is the
  main way to break a model: templates either raise on an unlisted value
  (mid-turn 400) or silently ignore it (your "effort" setting does nothing).
- **Default effort** — the level used when the agent doesn't pick one. An
  effort the model doesn't offer is refused, never silently clamped.

The deep template-contract fields (`compat`: `thinkingFormat`, the
`chatTemplateKwargs` `$var` bindings) are deliberately **not** in the UI:
they are read-only, hand-edited in `settings.yaml`, and preserved
byte-for-byte through every UI write — a partial write there would replace
the template's thinking bindings and break the model mid-conversation.

**Reset** (on the detail) drops that model's configuration back to the lower
tiers; the model stays in the served list.

## Nothink models

Some endpoint copies of a model have no selectable thinking levels — the
classic case is a nothink GGUF copy running side-by-side with the reasoning
build under the same wire id. In the detail, **unchecking "Reasoning effort"**
declares exactly that (the nothink sentinel): the model offers no thinking
dimension at all, and any effort requested on it is clamped to off — nothing
is sent, because there is no knob for it to land on.

This is different from a model whose *level map* contains an `off` row: that
model is still a reasoning model, you've just given it a way to think less.

## Images

When a model declares **Image input**, two things work that stock dsh custom
providers cannot:

- The agent's `read_image` tool passes its capability gate on that model, so
  image tool results reach the wire.
- Images you paste into the composer cross the wire as `image_url` parts.

In the web UI, `read_image` results render as a real inline image (with the
tool's text) by default; the `renderReadImages` setting in the `modelspoke:`
section switches that off, at which point dsh's generic tool rendering owns
the row again.

**Known limitation.** There is no request-budget management yet: on a very
long thread, `input + max_tokens` can exceed the model's context and the
server 400s (sglang doesn't clamp). Keeping the per-model max output tokens
sensibly under half the context window is the workaround; a proper budget +
offload pass is planned.

## The settings file

Everything the UI writes lives in the `modelspoke:` section of
`~/.dsh/settings.yaml`, and you can hand-edit it the same way — dsh watches
the file and changes apply live:

```yaml
modelspoke:
  routes:
    - name: llama-swap              # provider key (unique)
      baseURL: http://127.0.0.1:8080/v1
      apiKeyEnv: LLAMA_SWAP_API_KEY # optional — the variable's name, not its value
      models:                       # the served set; presence = served
        - name: qwen3.8-27b         # harness identity (what the agent names it)
          id: qwen3.8-27b-6000pro   # wire id (what goes on the wire)
          defaultEffort: medium     # optional
          contextWindow: 262144     # any of the canonical fields, when you set them
          maxTokens: 65536
          input: [text, image]
          thinkingLevelMap:         # the harness-level → model-value map
            off: low
            low: low
            medium: medium
            xhigh: xhigh
      overrides:                    # per-route, exact wire id → field values
        qwen3.8-27b-mtp: { contextWindow: 32768 }
  overrides:                        # legacy top-level shape — still read;
    some-wire-id: { maxTokens: 4096 }  # same-id entries on a route win per field
  renderReadImages: true            # inline read_image rendering (web UI only)
```

A provider with no `models:` list serves its **full catalog** as discovered;
the first edit to such a provider (removing a row, adding a model, changing a
field) materializes the list from the fetched catalog and then applies the
edit. Untouched providers round-trip byte-for-byte.

## What applies live, what needs a restart

- **Content changes** — anything in `settings.yaml`, including the whole
  `modelspoke:` section — are watched and apply live.
- **(Un)installing the package** — dsh caches package metadata for the
  process life, so one restart after adding or removing modelspoke from your
  profile. Nothing else needs a restart.
- **tui/headless profiles** — the settings page and onboarding step are web
  surfaces; in tui/headless the plugin serves models exactly the same way and
  the `settings.yaml` section (plus a first-boot log hint while no provider
  exists) is the interface.
