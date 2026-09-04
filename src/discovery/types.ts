/**
 * Wire types for OpenAI-compatible `GET /v1/models` responses, with the
 * llama-swap extensions.
 *
 * Ported from pi-llama-swap `lib/types.ts` (pi-llama-swap-port.md §1.3, in
 * jj history — the parked pi notes were removed with the research
 * consolidation; the port is verbatim), with two omissions for modelspoke:
 * - `LlamaSwapConfig` dropped — modelspoke routes are configured per user in
 *   the `modelspoke:` settings namespace (`ModelspokeRoute` in `src/types.ts`).
 * - `RefreshResult` dropped — host-adapter territory.
 *
 * The pi-ai type aliases are kept verbatim: `@earendil-works/pi-ai` is the
 * shared vocabulary dsh bottoms out in. The index signatures
 * (`[key: string]: unknown`) keep every type forward-compatible: unknown
 * keys pass through untouched.
 */

import type {
  OpenAICompletionsCompat,
  ThinkingLevelMap as PiThinkingLevelMap,
} from "@earendil-works/pi-ai";

/**
 * Compat block authored in llama-swap `metadata:` and rendered under
 * `meta.llamaswap.compat`. The authored shape matches pi's
 * `OpenAICompletionsCompat` (the openai-completions API this provider uses),
 * including `chatTemplateKwargs` with `$var` placeholders — passed through
 * verbatim.
 */
export type ModelCompat = OpenAICompletionsCompat;

/**
 * pi thinking-level map: pi levels (`off` + minimal..max) mapped to
 * provider/model-specific values; `null` marks a level as unsupported.
 */
export type ThinkingLevelMap = PiThinkingLevelMap;

/** `capabilities:` block from llama-swap PR #842, rendered at top level. */
export interface ModelCapabilities {
  function_calling?: boolean;
  vision?: boolean;
  [key: string]: unknown;
}

/** `architecture:` block rendered by llama-swap. */
export interface ModelArchitecture {
  input_modalities?: string[];
  output_modalities?: string[];
  modality?: string;
}

/** `status:` block rendered by llama-swap (`unloaded`/`loaded`/...). */
export interface ModelStatus {
  value?: string;
}

/** `meta.llamaswap` block — the authored `metadata:` rendered under `meta.llamaswap`. */
export interface LlamaSwapMeta {
  /** Always `"model"`. */
  type?: string;
  /** Display name override (falls back to top-level `name`, then `id`). */
  name?: string;
  /** Whether the model supports extended thinking. */
  reasoning?: boolean;
  /** Maximum output tokens. */
  maxTokens?: number;
  /** pi thinking-level → model-specific value map. */
  thinkingLevelMap?: ThinkingLevelMap;
  /** OpenAI-completions compatibility settings. */
  compat?: ModelCompat;
  /** Forward-compat: unknown metadata keys pass through untouched. */
  [key: string]: unknown;
}

/** `meta:` block from `/v1/models`. */
export interface ModelMeta {
  llamaswap?: LlamaSwapMeta;
  /** llama-swap also mirrors context length here as `n_ctx`. */
  n_ctx?: number;
  [key: string]: unknown;
}

/** OpenAI-compatible model entry from GET /v1/models, with llama-swap extensions. */
export interface OpenAIModelEntry {
  id: string;
  name?: string;
  /** Top-level context length (llama-swap PR #842 `capabilities.context`). */
  context_length?: number;
  /** Legacy aliases some upstreams report. */
  max_context_length?: number;
  context_window?: number;
  /** sglang/vLLM convention (bare-server context length). */
  max_model_len?: number;
  output_length?: number;
  max_tokens?: number;
  /** `capabilities:` block. */
  capabilities?: ModelCapabilities;
  /** `supported_parameters` list (e.g. `["tools","tool_choice"]`). */
  supported_parameters?: string[];
  /** `architecture:` block. */
  architecture?: ModelArchitecture;
  /** `meta:` block (holds `llamaswap` metadata). */
  meta?: ModelMeta;
  /** `status:` block (`unloaded` means no backend launched by discovery). */
  status?: ModelStatus;
  /** Forward-compat: unknown keys pass through. */
  [key: string]: unknown;
}

/** OpenAI-compatible models list response. */
export interface OpenAIModelsListResponse {
  object?: string;
  data: OpenAIModelEntry[];
}
