/**
 * Pure extraction of canonical model fields from an OpenAI-compatible
 * `/v1/models` entry (the tier-2 "server discovery" tier). No I/O — kept
 * separate so it is trivially unit-testable.
 *
 * Ported from pi-llama-swap `lib/metadata.ts` (pi-llama-swap-port.md §2, in jj history), with the
 * modelspoke adaptations noted per function. Field mapping for
 * `meta.llamaswap`:
 *
 *   meta.llamaswap.reasoning          -> reasoning
 *   meta.llamaswap.thinkingLevelMap   -> thinkingLevelMap (canonical: null entries dropped)
 *   meta.llamaswap.compat             -> compat (verbatim, incl. chatTemplateKwargs $var)
 *   meta.llamaswap.maxTokens          -> maxTokens  (full chain: top-level
 *                                                  output_length / max_tokens,
 *                                                  then the meta.llamaswap
 *                                                  block, verbatim)
 *   capabilities.context (rendered on the wire as top-level context_length)
 *                                     -> contextWindow (full 11-slot
 *                                                  multi-convention chain
 *                                                  + sglang/vLLM max_model_len;
 *                                                  see extractContextWindow)
 *   architecture.input_modalities (rendered from capabilities.in)
 *                                     -> input
 *
 * For bare (non-llama-swap) servers every extractor degrades to `undefined`
 * ("discovery found nothing"), so the preset/default tiers fill in — with
 * per-field provenance — instead of inventing values.
 */

import type {
  CanonicalModelFields,
  Compat,
  DiscoveryModelInfo,
  ModelModality,
  ThinkingLevelMap,
} from "../types.js";
import type { LlamaSwapMeta, ModelCompat, OpenAIModelEntry } from "./types.js";
import { canonicalizeThinkingLevelMap, isPlainObject } from "../resolve/canonical.js";

/**
 * Coerces a value to a positive integer, or undefined if invalid (ported
 * verbatim from pi-llama-swap `context.ts`). Accepts positive integers and
 * all-digit strings; rejects ≤ 0, non-integers, and non-numeric strings.
 * Exported for reuse by the context probes (`./probe.js`).
 */
export function toPositiveInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const n = Number(value);
    return n > 0 ? n : undefined;
  }
  return undefined;
}

/** Returns `meta.llamaswap` if present and object-shaped, else undefined (ported verbatim). */
function getLlamaSwapMeta(entry: OpenAIModelEntry): Record<string, unknown> | undefined {
  const meta = entry.meta;
  if (!meta || typeof meta !== "object") return undefined;
  const ls = meta.llamaswap;
  if (ls && typeof ls === "object") return ls as Record<string, unknown>;
  return undefined;
}

/**
 * Resolves the display name: `meta.llamaswap.name` → top-level `name` →
 * undefined. Empty strings are treated as absent.
 *
 * ADAPTED from the port (which fell back to `id`): the fallback to `id` is
 * the consumer's job — `DiscoveryModelInfo.name` is only set when the
 * endpoint actually supplied a name (design: "Display name = discovery's
 * `name` when the endpoint supplies one, else the model `id`").
 */
export function extractName(entry: OpenAIModelEntry): string | undefined {
  const ls = getLlamaSwapMeta(entry);
  const fromMeta = ls ? ls.name : undefined;
  if (typeof fromMeta === "string" && fromMeta.length > 0) return fromMeta;
  if (typeof entry.name === "string" && entry.name.length > 0) return entry.name;
  return undefined;
}

/**
 * Resolves input modalities from `architecture.input_modalities`, adding
 * `"image"` when `capabilities.vision` is true but the modality list omits
 * it. Stable text-first order.
 *
 * ADAPTED from the port: the `["text","image"]` fallback default is DROPPED —
 * a missing-modalities result is reported as "discovered nothing" (undefined)
 * rather than inventing `image` (pi port note, jj history: keep the logic,
 * reconsider the default).
 */
export function extractInput(entry: OpenAIModelEntry): ModelModality[] | undefined {
  const raw = entry.architecture?.input_modalities;
  const set = new Set<ModelModality>();
  if (Array.isArray(raw)) {
    for (const m of raw) {
      if (m === "text" || m === "image") set.add(m);
    }
  }
  if (entry.capabilities?.vision === true) set.add("image");
  if (set.size === 0) return undefined;
  // A chat endpoint that takes any input takes text: seed it, so the result
  // never carries `image` without `text`.
  set.add("text");
  const out: ModelModality[] = [];
  if (set.has("text")) out.push("text");
  if (set.has("image")) out.push("image");
  return out;
}

/**
 * Resolves the reasoning flag: `true` only when
 * `meta.llamaswap.reasoning === true`; `undefined` otherwise.
 *
 * ADAPTED from the port (which defaulted `false`): "absent" and "false" are
 * different signals. `undefined` lets the preset tier still supply
 * `reasoning: true` for bare servers; the `false` default is owned by the
 * default tier (and reported as such in the source map).
 */
export function extractReasoning(entry: OpenAIModelEntry): boolean | undefined {
  const ls = getLlamaSwapMeta(entry);
  return ls?.reasoning === true ? true : undefined;
}

/**
 * Resolves the thinking-level map from `meta.llamaswap.thinkingLevelMap`,
 * canonicalized: `null` entries (pi-ai's "declared unsupported" spelling) are
 * dropped — the canonical form omits unsupported levels; `off: "low"` is
 * preserved (selectable; its value is moot under `omitWhenOff`).
 */
export function extractThinkingLevelMap(entry: OpenAIModelEntry): ThinkingLevelMap | undefined {
  const ls = getLlamaSwapMeta(entry);
  return canonicalizeThinkingLevelMap(ls?.thinkingLevelMap);
}

/**
 * Resolves the compat block from `meta.llamaswap.compat`, including
 * `chatTemplateKwargs` with `$var` placeholders. Passed through verbatim
 * (ported).
 */
export function extractCompat(entry: OpenAIModelEntry): ModelCompat | undefined {
  const ls = getLlamaSwapMeta(entry);
  const raw = ls?.compat;
  if (!raw || typeof raw !== "object") return undefined;
  return raw as ModelCompat;
}

/**
 * Resolves max output tokens via the full multi-convention chain (ported
 * verbatim from pi-llama-swap `context.ts` §3.2), first positive integer wins:
 *   1. top-level `output_length`
 *   2. top-level `max_tokens`
 *   3. `meta.llamaswap.maxTokens`
 *   4. `meta.llamaswap.output_length`
 *   5. `meta.llamaswap.max_tokens`
 *
 * Ported verbatim, oracle-verified before porting: docs/design.md ("Moved
 * from code").
 */
export function extractMaxTokens(entry: OpenAIModelEntry): number | undefined {
  const topLevel = toPositiveInt(entry.output_length) ?? toPositiveInt(entry.max_tokens);
  if (topLevel) return topLevel;
  const ls = getLlamaSwapMeta(entry);
  return (
    toPositiveInt(ls?.maxTokens) ??
    toPositiveInt(ls?.output_length) ??
    toPositiveInt(ls?.max_tokens)
  );
}

/**
 * Resolves the context window via the full multi-convention chain (ported
 * from pi-llama-swap `context.ts` §3.1), first positive integer wins:
 *   1.  top-level `context_length` (llama-swap renders `capabilities.context` here)
 *   2.  top-level `max_context_length` (legacy alias)
 *   3.  top-level `context_window` (legacy alias)
 *   4.  top-level `max_model_len` (sglang/vLLM convention — see ADAPTED note)
 *   5.  `meta.llamaswap.context_length`
 *   6.  `meta.llamaswap.context`
 *   7.  `meta.llamaswap.max_context`
 *   8.  `meta.llamaswap.max_context_length`
 *   9.  `meta.n_ctx` (llama-swap mirrors context length here as well)
 *   10. top-level `metadata.context_length` (lowercase `metadata` — legacy alias;
 *       llama-swap v250 renders `meta`, not `metadata`)
 *   11. top-level `metadata.context`
 *
 * ADAPTED from the port: pi's 10-step chain has no `max_model_len` slot;
 * modelspoke inserts it at position 4, but the slot is PROBE-GATED — it is
 * only consulted when `options.includeMaxModelLen` is true (the default
 * `extractFromEntry` path leaves it off; the opt-in bare-server/probe
 * wiring passes `{ includeMaxModelLen: true }` — the oracle behind the
 * gating: docs/design.md ("Moved from code")).
 * @param options - `includeMaxModelLen: true` enables the position-4 slot.
 */
export function extractContextWindow(
  entry: OpenAIModelEntry,
  options?: { includeMaxModelLen?: boolean },
): number | undefined {
  const topLevel =
    toPositiveInt(entry.context_length) ??
    toPositiveInt(entry.max_context_length) ??
    toPositiveInt(entry.context_window);
  if (topLevel) return topLevel;

  if (options?.includeMaxModelLen) {
    const maxModelLen = toPositiveInt(entry.max_model_len);
    if (maxModelLen) return maxModelLen;
  }

  const ls = getLlamaSwapMeta(entry);
  const fromLs =
    toPositiveInt(ls?.context_length) ??
    toPositiveInt(ls?.context) ??
    toPositiveInt(ls?.max_context) ??
    toPositiveInt(ls?.max_context_length);
  if (fromLs) return fromLs;

  const meta = entry.meta;
  if (meta && typeof meta === "object") {
    const fromMeta = toPositiveInt((meta as Record<string, unknown>).n_ctx);
    if (fromMeta) return fromMeta;
  }

  const metadata = entry.metadata;
  if (metadata && typeof metadata === "object") {
    const md = metadata as Record<string, unknown>;
    const fromMd = toPositiveInt(md.context_length) ?? toPositiveInt(md.context);
    if (fromMd) return fromMd;
  }

  return undefined;
}

/**
 * Whether the model advertises tool/function calling. Informational only —
 * no canonical field consumes it (kept from the port for probe diagnostics).
 */
export function extractToolCalling(entry: OpenAIModelEntry): boolean {
  if (entry.capabilities?.function_calling === true) return true;
  const params = entry.supported_parameters;
  if (Array.isArray(params) && params.includes("tools")) return true;
  return false;
}

/**
 * Pure extraction of one `/v1/models` entry into the discovery contract
 * shape (`DiscoveryModelInfo`). `discoveredCanonical` is omitted when the
 * server advertised no canonical fields at all (bare servers).
 */
export function extractFromEntry(entry: OpenAIModelEntry): DiscoveryModelInfo {
  // Untrusted /v1/models data: a non-object element degrades to a bare row
  // (a string element keeps its value as the id) — the same posture the
  // backends apply to their surfaces.
  const raw: unknown = entry;
  if (!isPlainObject(raw)) {
    return {
      id: typeof raw === "string" && raw.length > 0 ? raw : "",
      discoveredCanonical: undefined,
      rawMeta: undefined,
    };
  }
  const discovered: CanonicalModelFields = {};

  const input = extractInput(entry);
  if (input) discovered.input = input;
  const reasoning = extractReasoning(entry);
  if (reasoning !== undefined) discovered.reasoning = reasoning;
  const thinkingLevelMap = extractThinkingLevelMap(entry);
  if (thinkingLevelMap) discovered.thinkingLevelMap = thinkingLevelMap;
  const compat = extractCompat(entry);
  if (compat) discovered.compat = compat as Compat;
  const maxTokens = extractMaxTokens(entry);
  if (maxTokens !== undefined) discovered.maxTokens = maxTokens;
  const contextWindow = extractContextWindow(entry);
  if (contextWindow !== undefined) discovered.contextWindow = contextWindow;

  const meta = entry.meta;
  const rawMeta =
    meta && typeof meta === "object" && isPlainObject(meta.llamaswap)
      ? (meta.llamaswap as LlamaSwapMeta)
      : undefined;

  return {
    id: entry.id,
    name: extractName(entry),
    discoveredCanonical:
      Object.keys(discovered).length > 0 ? discovered : undefined,
    rawMeta,
  };
}
