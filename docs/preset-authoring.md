# Authoring a model preset

[README](../README.md) · [README.zh](../README.zh.md) · [design.md](design.md) · [usage](usage.md)

A preset is **the contract between a model *template*'s jinja chat template
and the request**: "this template exposes `enable_thinking` +
`reasoning_effort` kwargs accepting exactly these values." The server only
has to pass `chat_template_kwargs` through to the template — which
llama-server (`--jinja`), vLLM, and sglang all do — so one verified template
covers every deployment that serves it.

## When you need one

When a model runs on an endpoint with no capability discovery of its own
(llama-server, a raw vLLM/sglang port, an Ollama model without extensions),
the preset tier fills the fields discovery can't — the thinking-level map,
the `compat` template bindings, context window, max output tokens. If the
server already serves the field (llama-swap `metadata`, Ollama extensions),
discovery wins and the preset is not needed for that field.

## The rules

- **Per-template, never a generic family catch-all.** Model families are
  empirically non-uniform: inside the Qwen line alone, one template
  `raise`s on an unlisted effort value, a sibling has no effort vocabulary
  at all, and the `preserve_thinking` default *flips* between the two. A
  family-wide preset would 400 on one member and silently no-op on another.
- **Conservative.** Assert only levels the template is known to accept.
  The three failure modes of a wrong preset: a mid-turn 400 (template
  raises), a silent no-op (template ignores the kwarg), or a silent
  multi-turn regression (a `preserve_thinking` default flips).
- **Authored from the template in the model artifact** — `chat_template.jinja`
  in the HF repo, or the `tokenizer.chat_template` embedded in the GGUF —
  **never from docs or memory.** The README's marketing copy is not a
  template; the first design example written from memory got three things
  wrong.
- **Overridable.** A user-set value beats the preset, per field, always.
- **Attributed.** The resolved source map reports `preset:<id>`, so every
  value a preset supplies is auditable.

## The workflow

Two dev tools do the mechanical work; a human does the judgment. Both are
plain Node scripts (zero runtime deps, Node native TS, `Node >= 22.18`):

```
npm run preset-draft   # node scripts/preset-draft.ts
npm run drift-check    # node scripts/preset-drift-check.ts
```

### 1. Locate the template in the artifact

Find the exact `chat_template.jinja` (HF hub repo) and/or the GGUF file the
deployment actually serves (its embedded `tokenizer.chat_template` is what
llama-server renders). Hub and GGUF copies can diverge — they are different
artifacts and both are legitimate contract sources; the provenance entry
pins every copy the preset must stay valid against.

### 2. Run the draft tool

```
node scripts/preset-draft.ts <org/name | https://huggingface.co/org/name> \
  --match <pattern>            # the model-id regex the entry should match
```

Options: `--out <path>` (default `preset-draft.<pattern>.md` in the cwd),
`--family qwen|gpt-oss` (force the invariant family; default auto-detect),
`--template <local-file>` + `--context-window <n>` (offline mode: template
from a local file, no HF fetch), `--file <gguf-name>` (which GGUF to read).

Exit codes: `0` = draft written; `1` = a fetch or derivation failed (no
draft — a draft that cannot fetch is not a pass); `2` = usage error.

The draft file contains:

- a **DRAFT catalog entry** in the exact `src/presets/catalog.ts` shape,
- the **provenance manifest entry** with the template repo(s) pinned
  (hub copy **by commit** — never branch head — and GGUF copy **by repo
  file**, because a re-quantization re-uploads the file and the embedded
  template sha is the contract) and `sha256` of the exact template text,
- a **JUDGMENT checklist** with the relevant template excerpts alongside.

Fields the tool can never guess stay on the checklist: `input` is **never**
template-derived (a template can prove text-only, but not vision), and
`maxTokens` is always **deployment-derived** (a property of how you run the
model, not of the template).

### 3. Review the judgment items

Walk the checklist against the excerpts. The standing items:

- **Pi-level alignment** — do the harness levels offered (the
  `thinkingLevelMap` keys) line up with what the wire actually sends?
- **Degenerate forms** — an on/off-only template gets the degenerate map
  `{ "off": "low", low: "low" }` and **no** `reasoning_effort` key at all
  (the template ignores it — don't send it); an inverted `enable_thinking`
  polarity (undefined = no-think) is a trap for `omitWhenOff`.
- **MaxTokens policy** — pick a deployment-justified cap; on sglang,
  `input + max_tokens > ctx` 400s (no clamp), so keep it well under
  ctx/2 unless the deployment proves headroom.
- **README-only vocabulary** — an effort vocabulary that appears only in the
  model card's prose, not in the template, is *not* template-verified: the
  conservative assertion is the documented set, and note in `notes` that the
  template does not validate the value.
- **Identity and placement** — the `match` pattern (unanchored,
  case-insensitive — `unsloth/Qwen3.8-27B-GGUF` must match
  `qwen3[._-]?8`) and where the entry goes in the catalog (below).

### 4. Commit the entry

Copy the reviewed entry into `src/presets/catalog.ts` and the provenance
entry into `src/presets/provenance.json` (fill any `PENDING-PIN` commits).
The `notes` field carries the human-readable rationale — the evidence
summary, the verdict reasoning — so a future reader knows *why* each value
is what it is.

### 5. Protect it with the drift checker

```
npm run drift-check
```

For every provenance entry it: fetches each pinned copy (hub **by commit**,
GGUF **by repo file**, local HF cache first — the cache *is* the deployment
artifact — else a bounded read of the GGUF + metadata parse), sha256s the
exact template text and diffs against the pin, and re-derives the mechanical
invariants (the `enable_thinking` polarity, the effort tuple from the
raise-guard including alias rewrites, the `preserve_thinking` disjunct) and
diffs them against the catalog. Cross-copy differences (hub jinja vs
GGUF-embedded) are reported as **informational divergences, never drift** —
the catalog must be valid against every copy, and the invariant re-derivation
proves that per copy.

Exit codes: `0` = all fetched, all shas match, no invariant findings; `1` =
drift **or** a fetch that couldn't complete (a check that can't fetch is not
a pass — reported as such, distinct from drift); `2` = usage/manifest
error. `--manifest <path>` runs against an alternate manifest (scratch
copies — the repo manifest is never edited to test detection).

The tool **never writes or suggests preset content.** On drift, a human
re-runs this workflow against the new template. Invariants that are not
mechanically extractable — the level→value cross-vocabulary mapping, a
prose-documented vocabulary, the maxTokens policy — are deliberately not
asserted by the tool; they are the human items from step 3.

## Worked example — `gpt-oss-120b`

Artifact: the MXFP4 GGUF (`gpt-oss.context_length: 131072`; embedded
template sha256 `a4c9919c…146`, 16714 chars). Token counts in the template:
`reasoning_effort` 4×, `enable_thinking` 0×, `preserve_thinking` 0×.

- **Thinking surface = `reasoning_effort` only.** The template always emits
  an analysis channel; lines 203–206 render `Reasoning: <effort>` into the
  system message and **default to `"medium"` when the kwarg is absent** —
  absence is a meaningful state, so the off-state can omit the kwarg
  (`reasoning_effort: { "$var": "thinking.effort", omitWhenOff: true }` with
  the map's `"off": "medium"` keeping the two behaviors consistent).
- **Vocabulary `{low, medium, high}` — verified by enumeration, not memory.**
  The template performs no value validation (the four `raise_exception`s are
  message-format guards), so the conservative assertion is the documented
  triple; an unlisted value worst-case lands in the `Reasoning:` line — a
  model-behavior risk, never a 400.
- **`compat`:** `thinkingFormat: "chat-template"` with the single
  `reasoning_effort` binding — the same dialect as the qwen presets.
- **Capacities:** `contextWindow: 131072` from the GGUF key (agrees with the
  live deployment); `maxTokens: 65536` = the proven deployment value (ctx/2);
  `input: ["text"]` — the template's message loop renders string content
  only.

## When the verdict is "no preset"

The Qwen3-Coder-Next GGUF template references no `enable_thinking` and no
effort kwarg at all — the default tier (no thinking dimension, no bindings)
is simply correct for it. The correct outcome is a **recorded decision to
add nothing**, with the evidence (zero occurrence counts, the template
excerpts) written down, so a later reader doesn't re-litigate it. Not every
model earns an entry.

The precedent is Qwen3-Coder-Next (template verified 2026-08 from the
GGUF-embedded copy: zero `enable_thinking`, `reasoning_effort`, and
`preserve_thinking` occurrences). A preset for it would claim a per-template
contract that does not exist — every `chat_template_kwargs` sent would be a
silent ignored-kwarg no-op (jinja ignores undeclared variables), exactly the
failure mode presets exist to prevent — so the default tier is the correct
resolution.

## Adding a new model family, end to end

1. **Template in the artifact** — hub `chat_template.jinja` and/or the
   GGUF-embedded copy of the deployment(s) that matter; note every copy you
   pin.
2. **`preset-draft`** with a `match` pattern that is (a) specific enough not
   to swallow neighboring ids and (b) unanchored + case-insensitive so the
   deployment's wire ids (org-prefixed GGUF names, `-nothink` copies, …)
   still match.
3. **Review the judgment items** (step 3 above); decide the degenerate form,
   the maxTokens policy, the input declaration.
4. **Placement in the catalog** — catalog order *is* the matching contract:
   first match wins, most-specific entries listed first, and the `match`
   patterns must stay mutually exclusive on every live id (the existing
   entries pin this in unit tests).
5. **Provenance** — pin every artifact copy (hub by commit, GGUF by repo
   file) with the sha of the exact template text.
6. **`drift-check` green**, then the full test suite (the catalog unit tests
   and the oracle assert the resolution behavior for the shipped families).
7. **zh description** — a new preset id with a `notes` string gets a zh
   counterpart in `PRESET_ZH` in `src/dsh/locales.ts` (the catalog
   descriptions are localized; zh-absent falls back to en, never blank).

## Known open questions

- **Larger Qwen3.5 checkpoints.** The `qwen3.5-chat-template` entry was
  verified against a single 4B GGUF template (inverted `enable_thinking`
  polarity: undefined = nothink). Its binding is safe only because the
  binding **never omits `enable_thinking`**. A larger 3.5 checkpoint (27B/35B
  GGUF or HF repo) with a different template — e.g. 3.8-style polarity —
  would break the entry: re-verify against that artifact and split the
  `match` if the family diverges before fronting it.
- **`qwen3.6-40B-Deckard-mtp` (the PiehSoft 40B fine-tune).** The 3.6
  preset's `match` covers it by family spelling, but its embedded template
  was never read (a 40B non-MTP architecture may carry a different template).
  If it 400s or silently no-ops, verify its GGUF template first — then split
  the preset or add a more-specific catalog entry before it.
- **HF API error shape.** Unknown Hugging Face repos answer **401, not 404**
  (probed 2026-08-25) — error handling and any negative-caching around repo
  lookups must treat 401 as "unknown", not "auth required".
- **Gemma 3/4.** The gemma-3/4 repos showed **zero thinking surface** in the
  model card/templates at probe time (2026-08-25) — re-verify before
  authoring any gemma preset.
