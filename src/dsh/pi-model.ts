/**
 * Build the pi-ai `Model` object on top of a core `ResolvedModel` + route
 * facts.
 *
 * The core `ResolvedModel` has no `id`/`name`/`api`/`provider`/`baseUrl`/
 * `cost` (the core/host handoff) — those are route facts this module
 * supplies. Two fields the core may legitimately OMIT (the default tier
 * does not invent capacities) are REQUIRED numbers on pi-ai's `Model`:
 *
 * - `contextWindow` → falls back to {@link FALLBACK_CONTEXT_WINDOW}
 * - `maxTokens` → falls back to {@link FALLBACK_MAX_TOKENS}
 *
 * The fallback values are INVENTED (no tier supplied them) — the caller
 * surfaces that through the metadataSource contract: the per-field source map
 * already reports those fields as `"default"`, and the resolve-time log line
 * (adapter.ts) prints the actual fallback numbers when a field fell back.
 * The fallbacks mirror dsh-llm-pi-ai's route defaults (262144 / 32768) so a
 * modelspoke route behaves like a hand-written llm-pi-ai route with no
 * per-model capacities.
 *
 * `thinkingLevelMap` translation (canonical → pi-ai raw) and the wire
 * `reasoning` flag are the CORE's (src/resolve/wire.ts
 * `wireThinkingLevelMap` / `wireReasoning`): unsupported levels are pinned
 * `null` (pi-ai reads an ABSENT key as "supported" for the base levels);
 * an OFFERED `off` keeps its wire value verbatim — pi-ai sends it as the
 * off switch when no level is requested (the Ollama family tables'
 * `off: "none"` off-switch spelling; the reference dsh-llm-pi-ai adapter's
 * "an off with a value sends that value" semantics) — while a NOT-offered
 * off is pinned `null` (off unsupported). Under a chat-template kwarg path
 * the value is moot (the format branch resolves off through the `$var`
 * bindings, and the effort kwarg's `omitWhenOff` drops it before any map
 * lookup). Spelling rules: docs/design.md ("The wire shim").
 *
 * `compat` fall-through (dsh-llm-pi-ai parity): the resolved object's
 * `compat` is ALWAYS present — the default tier supplies a conservative
 * block when no other tier did. The wire model must not carry that
 * default-sourced block as if it were a declaration: an explicit
 * `supportsReasoningEffort: false` would close pi-ai's OpenAI-style
 * `reasoning_effort` emission for discovered thinking models that emit no
 * compat of their own (the Ollama family tables target exactly that
 * parameter). So when the SOURCE of the resolved compat is the default
 * tier (the caller passes `sources.compat` — {@link buildPiModel}
 * `compatSource`), the wire model carries NO `compat` key and pi-ai's own
 * detection applies (a generic openai-completions origin detects
 * `supportsReasoningEffort: true` — the behavior the discovery backends'
 * "no compat emitted" docblocks assume). A compat a tier actually supplied
 * (user / discovery / preset) is carried verbatim.
 *
 * The dsh host's application of the core wire helpers, including the
 * nothink shim presentation (the DECLARED dimension stays off here:
 * `info.reasoning` is keyed on `resolved.reasoning`, and `resolveEffort`
 * clamps any explicit effort on it to `off`). Design: docs/design.md
 * ("The wire shim (nothink models, BUG-001/002)").
 */

import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { Model, ModelCost, ModelThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { normalizeRouteBaseUrl } from "../discovery/url.js";
import { wireReasoning, wireThinkingLevelMap } from "../resolve/wire.js";
import type { FieldSource, ModelspokeRoute, ResolvedModel } from "../types.js";

/** pi-ai's local no-cost constant: every modelspoke model is free. */
export const NO_COST: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** Documented fallback for a resolved model with no `contextWindow` tier. */
export const FALLBACK_CONTEXT_WINDOW = 262144;

/** Documented fallback for a resolved model with no `maxTokens` tier. */
export const FALLBACK_MAX_TOKENS = 32768;

/**
 * The NO-SOURCE effort fallback (pi parity): pi's session thinking level
 * defaults to "medium" (pi-coding-agent's `DEFAULT_THINKING_LEVEL`) — a
 * thinking model never dispatches without an effort. The dsh adapter
 * clamps the value to the model's offered levels (pi-ai's
 * `clampThinkingLevel` rule) before dispatch.
 */
export const FALLBACK_THINKING_LEVEL: ModelThinkingLevel = "medium";

/**
 * The canonical selectable set re-spelled as pi-ai's RAW thinkingLevelMap:
 * unsupported levels (incl. a not-offered `off`) pinned to `null`, the
 * offered levels — `off` included — kept verbatim (pi-ai sends the offered
 * off value as the off switch when no level is requested). `undefined` for
 * non-reasoning models (pi-ai then offers only `off`).
 */
export function piThinkingLevelMap(resolved: ResolvedModel, nothink = false): ThinkingLevelMap | undefined {
  // The re-spelling (incl. the BUG-001/002 shim case) is the core's.
  return wireThinkingLevelMap(resolved, nothink);
}

/**
 * Build the full pi-ai `Model` for one resolved model on one route.
 *
 * @param id - Exact model id.
 * @param resolved - The four-tier resolution result.
 * @param displayName - Display name (discovery `name` / override `name` / id);
 *   carried on the pi-ai model for diagnostics only.
 * @param nothink - The resolution's explicit-none marker (the nothink sentinel).
 *   Drives the BUG-001/002 wire shim — see the module doc: the wire model
 *   may present as reasoning (opening pi-ai's gated kwarg emission) while
 *   the declared dimension stays off.
 * @param compatSource - The SOURCE of `resolved.compat` (the resolver's
 *   `sources.compat`). `"default"` — no tier supplied a compat block: the
 *   wire model carries NO `compat` key, so pi-ai's own detection applies
 *   (module doc — the dsh-llm-pi-ai fall-through parity). Any other source
 *   carries the block verbatim. Defaults to `"default"` (a caller without
 *   source info gets the detection fall-through, never an invented
 *   declaration).
 */
export function buildPiModel(
  id: string,
  resolved: ResolvedModel,
  displayName: string,
  route: ModelspokeRoute,
  nothink = false,
  compatSource: FieldSource = "default",
): Model<"openai-completions"> {
  const thinkingLevelMap = wireThinkingLevelMap(resolved, nothink);
  return {
    id,
    name: displayName,
    api: "openai-completions",
    provider: route.name,
    baseUrl: normalizeRouteBaseUrl(route.baseURL),
    // WIRE reasoning (the request-builder gate) — not the declared
    // dimension; the shim case diverges (module doc).
    reasoning: wireReasoning(resolved, nothink),
    input: [...resolved.input],
    cost: NO_COST,
    contextWindow: resolved.contextWindow ?? FALLBACK_CONTEXT_WINDOW,
    maxTokens: resolved.maxTokens ?? FALLBACK_MAX_TOKENS,
    ...thinkingLevelMap === undefined ? {} : { thinkingLevelMap },
    // The compat fall-through (module doc): a default-sourced block is the
    // resolver's conservative filler, not a declaration — omit it so
    // pi-ai's own detection applies.
    ...compatSource === "default" ? {} : { compat: { ...resolved.compat } },
  };
}

/**
 * The selectable levels, in pi-ai's canonical level order — the same set the
 * wire will accept and the set the adapter reports as `reasoning.efforts`.
 */
export function offeredLevels(model: Model<"openai-completions">): ModelThinkingLevel[] {
  return getSupportedThinkingLevels(model);
}
