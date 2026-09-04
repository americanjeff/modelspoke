# llama-swap with modelspoke — setups and background

[README](../README.md) · [README.zh](../README.zh.md) · [design.md](design.md)

A minimal llama-swap setup and how the two projects' model definitions
interact — the rest of the llama-swap config schema is documented by
llama-swap itself.

## What llama-swap is

llama-swap ([github.com/mostlygeek/llama-swap](https://github.com/mostlygeek/llama-swap))
is a small, dependency-free Go program that sits in front of your local model
servers and presents **one stable, OpenAI- (and Anthropic-) compatible
endpoint** — by default `http://127.0.0.1:8080/v1` — no matter how many
models you actually run. You declare every model in one `llama-swap.yaml` —
the command that starts its backend, an optional `ttl` for idle unloading,
and optional `capabilities` / `metadata` blocks describing what the model can
do; when a request names a model whose backend is not serving, llama-swap
stops the current backend, launches the right one, and forwards the request
(the "swap"). The project's [README](https://github.com/mostlygeek/llama-swap)
and `config.example.yaml` document the full config schema — `cmd`/`cmdStop`
backends, `ttl`, `routing` concurrency rules, `macros`, `env`, `aliases`,
`filters`, `profiles`, `peers` — so this doc covers only the minimal setup
and how modelspoke reads the endpoint.

Two facts make it modelspoke's first-class router. Because the endpoint never
changes, every agent, CLI tool, and UI configures llama-swap **once** — one
base URL, and models are addressed by their configured IDs; adding, removing,
or re-tuning a model is a `llama-swap.yaml` edit and a restart, nothing in
any agent's config changes. And llama-swap publishes its knowledge through
the OpenAI `/v1/models` surface: each entry carries `architecture`,
`capabilities`, `supported_parameters`, `status` (`loaded`/`unloaded`), and a
`meta.llamaswap` block echoing the config's per-model `metadata:` — so
clients can introspect what each model accepts instead of guessing.

`cmd` / `cmdStop` / `env` are never exposed by `/v1/models` — only
`capabilities` + `metadata` (rendered as `meta.llamaswap`) — so serving over
the wire leaks no secrets. Keep secrets in the service environment (an
`${env.YOUR_HF_TOKEN}` macro), never in the yaml.

## Simple setup

A minimal, real-shape `llama-swap.yaml` — the two fields a beginner actually
needs (`cmd`), plus `capabilities` / `metadata` so clients like modelspoke
can introspect the models:

```yaml
models:
  # The key is the model ID agents request in `model:`.
  qwen3-coder:
    # ${PORT} is auto-assigned by llama-swap (starts at 5800 by default).
    cmd: |
      llama-server --host 127.0.0.1 --port ${PORT}
      --hf-repo unsloth/Qwen3-Coder-Next-GGUF:UD-Q6_K_XL
      --jinja --cont-batching --flash-attn on
      --ctx-size 262144 --parallel 1
    ttl: 3600            # unload after 1h idle (seconds); 0 = never
    capabilities:
      in: [text]
      out: [text]
      tools: true
      context: 262144
    metadata:
      maxTokens: 131072

  gemma-mini:
    cmd: |
      llama-server --host 127.0.0.1 --port ${PORT}
      --hf-repo unsloth/gemma-4-E4B-it-GGUF:Q4_K_M
      --jinja --cont-batching --flash-attn on
    ttl: 1800
    capabilities:
      in: [text]
      out: [text]
```

Everything else in llama-swap's config is optional and added one step at a
time (`healthCheckTimeout`, `logToStdout`, `macros`, `env`, `cmdStop`,
`proxy`, `aliases`, `filters`, `routing`, `peers`, `profiles` — see the
project's `config.example.yaml`). Run it (`llama-swap --config
llama-swap.yaml --listen 127.0.0.1:8080`), and the one-line endpoint every
agent points at is `http://127.0.0.1:8080/v1` (model id in the request's
`model` field). In dsh: one provider, `baseURL: http://127.0.0.1:8080/v1` —
done.

## What the endpoint actually serves

A live `GET /v1/models` entry for a thinking + vision model (the shape every
model matches):

```json
{
  "id": "qwen3.8-27b-6000pro",
  "owned_by": "llama-swap",
  "architecture": {
    "input_modalities": ["text", "image"],
    "modality": "text+image->text",
    "output_modalities": ["text"]
  },
  "capabilities": { "function_calling": true, "vision": true },
  "supported_parameters": ["tools", "tool_choice"],
  "context_length": 262144,
  "meta": {
    "llamaswap": {
      "type": "model",
      "reasoning": true,
      "maxTokens": 65536,
      "thinkingLevelMap": {
        "off": "low", "minimal": null, "low": "low",
        "medium": "medium", "high": null, "xhigh": "xhigh", "max": null
      },
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false,
        "thinkingFormat": "chat-template",
        "chatTemplateKwargs": {
          "enable_thinking": { "$var": "thinking.enabled" },
          "reasoning_effort": { "$var": "thinking.effort", "omitWhenOff": true },
          "preserve_thinking": true
        }
      }
    },
    "n_ctx": 262144
  },
  "status": { "value": "loaded" }
}
```

The yaml→wire mapping: `capabilities.in` → `architecture.input_modalities`
(+ the derived `modality` string, and `capabilities.vision: true`);
`capabilities.context` → top-level `context_length` **and** mirrored as
`meta.n_ctx`; `capabilities.tools` → `capabilities.function_calling` +
`supported_parameters: [tools, tool_choice]`; the whole `metadata:` block →
`meta.llamaswap` (plus `type: "model"`). `cmd` / `cmdStop` / `env` never
appear on the wire.

## What modelspoke reads from it

modelspoke's discovery tier (tier 2 of the
[four-tier chain](usage.md#the-resolution-chain))
maps each `/v1/models` entry through these exact fields:

| Canonical field | Read from (priority order) |
|---|---|
| `name` | `meta.llamaswap.name` → top-level `name` (else the model `id`) |
| `input` | `architecture.input_modalities` (text/image), `image` added when `capabilities.vision: true` |
| `reasoning` | `true` **only** when `meta.llamaswap.reasoning === true`; absent → the preset tier decides |
| `thinkingLevelMap` | `meta.llamaswap.thinkingLevelMap` (`null` = "declared unsupported", dropped) |
| `compat` | `meta.llamaswap.compat` **verbatim**, including `chatTemplateKwargs` `$var` bindings |
| `maxTokens` | `output_length` → `max_tokens` → `meta.llamaswap.maxTokens` → nested variants |
| `contextWindow` | `context_length` → `max_context_length` → `context_window` → `max_model_len` (opt-in probe) → `meta.llamaswap.*` variants → `meta.n_ctx` → nested `metadata` variants |

Because a fully declared model's on-wire entry carries `context_length`,
`meta.n_ctx`, `meta.llamaswap.maxTokens`, `reasoning: true`, the full
`thinkingLevelMap`, and the full `compat` block, **all of its reasoning
metadata resolves at tier 2 from the live endpoint alone** — which is the
"one model definition flows to both layers" claim, verifiable with a single
`curl -H "Authorization: Bearer $KEY" http://127.0.0.1:8080/v1/models`.

For models discovery can't see (bare servers that advertise nothing),
write a per-model override in the Modelspoke section with the field mapping
from the table above — the DISCOVERY tier is the single source of per-model
metadata, and where discovery sees nothing the override supplies the field.
(An earlier first-use import seeded these entries straight from
`llama-swap.yaml`; that deep path is retired — the router renders the yaml
metadata into the wire for every model, so it was redundant with discovery.)

The `thinkingFormat: "chat-template"` + `$var` mechanics above are the shared
`@earendil-works/pi-ai` vocabulary — the same strings modelspoke passes
through verbatim — so a thinking model's knobs work in dsh and pi identically,
configured once in `llama-swap.yaml`.
