/**
 * Wire-facing reasoning state (the BUG-001/BUG-002 shim) — the SINGLE
 * sanctioned divergence between a model's DECLARED reasoning dimension and
 * the pi-ai Model the host shims hand to the request builder.
 *
 * Background. pi-ai's openai-completions request builder gates EVERY
 * thinking-format branch — including the ONLY `chat_template_kwargs`
 * emission — on `model.reasoning`. A nothink entry (the explicit-none
 * sentinel — "this endpoint's copy has no selectable reasoning dimension")
 * resolves to `reasoning: false`, so the gate is closed and the request
 * carries ZERO thinking control. On a chat template whose DEFAULT is
 * thinking ON (e.g. Qwen3.8 — `enable_thinking` undefined/true = think),
 * "send no control" means "think": the declaration silently does nothing
 * (BUG-001). The gate is upstream (BUG-002) and is still present in the
 * newest pi-ai release — this module is the modelspoke-side workaround.
 *
 * The two roles of `reasoning` are separable:
 *
 * - the DIMENSION role — what the host offers the user (effort levels, the
 *   thinking toggle). Owned by the host shims, keyed on
 *   `resolved.reasoning`: UNCHANGED. A nothink entry offers no dimension:
 *   on dsh, an explicitly named effort is still refused by the dsh-llm
 *   layer (there is no dimension to materialize on); in modelspoke's own
 *   effort resolution the level clamps to `off` (nothing sent).
 * - the WIRE role — which pi-ai request-builder branches may fire
 *   (`model.reasoning` on the pi-ai Model). Decided here.
 *
 * `wireReasoning` opens the wire role for exactly ONE shape: an EXPLICIT
 * nothink entry whose resolved `compat` declares a `chat-template`
 * `chatTemplateKwargs` block — the entry/preset author wired the template's
 * thinking state into the wire (a `{$var: thinking.enabled}` binding), so
 * "no thinking" can only be expressed by SENDING the explicit off that the
 * binding resolves to when no effort is present (`false`). No declared
 * kwargs ⇒ no wire intent ⇒ unchanged (never silently invent a wire
 * parameter). No other `thinkingFormat` is touched: their off spellings are
 * per-format, the verified defect is the chat-template kwarg path, and the
 * convention is conservative by default.
 *
 * `wireThinkingLevelMap` re-spells the canonical (SELECTABLE-ONLY)
 * `thinkingLevelMap` as the RAW pi-ai form the wire model carries —
 * extracted from the two host shims' mirrored `piThinkingLevelMap` (the
 * "future option: extract to core" flagged in their docblocks):
 *
 *   absent from the resolved map -> pinned `null`  (declared unsupported)
 *   offered `off`                -> key stays ABSENT ("supported, sends nothing")
 *   other offered levels         -> wire value verbatim
 *
 * plus the shim case (shim ACTIVE only): the wire model IS reasoning
 * (`model.reasoning: true`) but offers no selectable level — every
 * non-`off` level pinned `null`, `off` ABSENT — so
 * pi-ai's `getSupportedThinkingLevels` yields exactly `["off"]`: the nothink
 * presentation the hosts already showed for `reasoning: false` ("off
 * offered, sends nothing"), carried on a model whose wire gate is open. A
 * dispatched `off` is wire-equivalent to no effort (pi-ai maps it to
 * `reasoningEffort: undefined`), so the kwarg binding still resolves to the
 * explicit off.
 */

import { CANONICAL_LEVELS, isPlainObject } from "./canonical.js";
import type { ResolvedModel, ThinkingLevelMap } from "../types.js";

/**
 * Whether the wire model the host hands to pi-ai must present as REASONING.
 *
 * The declared dimension (`resolved.reasoning`) is the answer for the UI;
 * this is the answer for the request builder. True whenever the model is
 * genuinely reasoning, OR the shim case applies (explicit nothink + a
 * declared chat-template kwarg block — see the module doc). Pure; no
 * host-specific input.
 *
 * @param nothink - The resolution's explicit-none marker
 *   (`ResolutionResult.nothink === true` — the nothink sentinel, distinct from
 *   "no tier supplied").
 */
export function wireReasoning(resolved: ResolvedModel, nothink = false): boolean {
  if (resolved.reasoning) return true;
  if (!nothink) return false;
  const compat = resolved.compat;
  return (
    compat?.thinkingFormat === "chat-template" &&
    isPlainObject(compat?.chatTemplateKwargs) &&
    Object.keys(compat.chatTemplateKwargs).length > 0
  );
}

/**
 * The RAW pi-ai `thinkingLevelMap` the wire model carries (see the module
 * doc for the re-spelling rules + the shim case). `undefined` = the wire
 * model carries no `thinkingLevelMap` key at all (a plain non-reasoning
 * model with no wire intent).
 *
 * @param nothink - as in {@link wireReasoning}.
 */
export function wireThinkingLevelMap(
  resolved: ResolvedModel,
  nothink = false,
): ThinkingLevelMap | undefined {
  if (resolved.reasoning) {
    const map: ThinkingLevelMap = {};
    for (const level of CANONICAL_LEVELS) {
      const wire = resolved.thinkingLevelMap?.[level];
      if (wire === undefined) {
        map[level] = null; // not offered by any tier ⇒ unsupported
      } else if (level !== "off") {
        map[level] = wire; // wire spelling dispatched for that level
      }
      // offered off ⇒ key stays ABSENT: "supported, send nothing"
    }
    return map;
  }
  if (wireReasoning(resolved, nothink)) {
    // Shim active: a reasoning wire model with ZERO selectable levels.
    const map: ThinkingLevelMap = {};
    for (const level of CANONICAL_LEVELS) {
      if (level !== "off") map[level] = null;
    }
    return map;
  }
  return undefined;
}
