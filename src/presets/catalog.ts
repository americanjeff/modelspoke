/**
 * The bundled preset catalog.
 *
 * A preset is the contract between a model *template*'s jinja chat template
 * and the request — per-template, never a generic family catch-all
 * (docs/design.md, "The preset catalog"). Presets assert only known-good
 * effort vocabularies (conservative): a wrong preset causes mid-turn 400s,
 * silent no-ops, or silent multi-turn regressions.
 *
 * ORDER IS THE CONTRACT: most-specific entries first; matching is
 * catalog-ordered first match with no specificity scoring.
 *
 * Every entry is derived from the verified template in the model artifact —
 * the `chat_template.jinja` (HF repo) and/or the GGUF `tokenizer.chat_template`
 * — authoring source of truth is the template in the model artifact, never
 * docs or memory. The flagship entry's JSON is verbatim from the design doc's
 * "Canonical preset entry"; the other three are verbatim from the authoring
 * pass (docs/preset-authoring.md; full verification evidence in jj history —
 * `v0.2-presets.md` §1/§2/§4). Catalog order is most-specific-first; the
 * patterns are mutually exclusive on every live id.
 */

import type { Preset } from "../types.js";

export const presetCatalog: readonly Preset[] = [
  {
    id: "qwen3.8-chat-template",
    match: "qwen3[._-]?8",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 262144,
    maxTokens: 65536,
    thinkingLevelMap: { "off": "low", low: "low", medium: "medium", xhigh: "xhigh" },
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      thinkingFormat: "chat-template",
      chatTemplateKwargs: {
        enable_thinking: { "$var": "thinking.enabled" },
        reasoning_effort: { "$var": "thinking.effort", omitWhenOff: true },
        preserve_thinking: true,
      },
    },
    notes:
      "Qwen3.8 template (chat_template.jinja verified 2026-08): effort xhigh/medium/low only — template raises on anything else. preserve_thinking pins multi-turn thinking replay (undefined would preserve too; explicit defends against a template revision flipping the default). maxTokens well under ctx/2: sglang 400s (no clamp) when input+max_tokens > ctx.",
  },
  {
    id: "qwen3.6-chat-template",
    match: "qwen3[._-]?6",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 262144,
    maxTokens: 65536,
    thinkingLevelMap: { "off": "low", low: "low" },
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      thinkingFormat: "chat-template",
      chatTemplateKwargs: {
        enable_thinking: { "$var": "thinking.enabled" },
        preserve_thinking: true,
      },
    },
    notes:
      "Qwen3.6 template (27B-MTP + 35B-A3B-MTP GGUFs byte-identical, sha256 55d49314…ea0c 2026-08; HF chat_template.jinja ×3 identical e84f32a2…74259): NO effort vocabulary — zero reasoning_effort occurrences, so no effort kwarg is sent and the map is the degenerate on/off form {off, low}. enable_thinking same polarity as 3.8 (undefined/true = think; line 152/149 is defined-false only). preserve_thinking: true behaviorally REQUIRED — line 103/100 strips prior-turn thinking when undefined (no `is undefined` disjunct, unlike 3.8 line 116); only post-last-query thinking is kept either way. contextWindow from qwen35(.moe).context_length GGUF keys (262144, both variants); maxTokens 65536 conservative under ctx/2 for sglang (no clamp: input+max_tokens > ctx 400s). One preset for both sizes: same template, so the same contract.",
  },
  {
    id: "qwen3.5-chat-template",
    match: "qwen3[._-]?5",
    reasoning: true,
    contextWindow: 262144,
    thinkingLevelMap: { "off": "low", low: "low" },
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      thinkingFormat: "chat-template",
      chatTemplateKwargs: {
        enable_thinking: { "$var": "thinking.enabled" },
      },
    },
    notes:
      "Qwen3.5-4B GGUF template (sha256 7f0e5290…ed67, 2026-08): INVERTED enable_thinking polarity vs 3.6/3.8 — line 150 is `defined and is true` for the think branch, so UNDEFINED enable_thinking = nothink; the {$var: 'thinking.enabled'} binding is safe only because the harness sends the boolean and NEVER omits it — do not add omitWhenOff or make the off-state omit this kwarg. Degenerate on/off form {off, low}: zero reasoning_effort/effort occurrences, no effort kwarg sent. No preserve_thinking variable (zero occurrences) — line 100 keeps thinking only after the last user query; nothing to send. contextWindow from qwen35.context_length GGUF key (262144); maxTokens deliberately absent (no local 3.5 deployment to justify a cap). input deliberately absent (no artifact states vision for the 4B). Authored from the only local 3.5 artifact — see open questions on larger 3.5 checkpoints.",
  },
  {
    id: "gpt-oss-120b-chat-template",
    match: "gpt-oss",
    reasoning: true,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 65536,
    thinkingLevelMap: { "off": "medium", low: "low", medium: "medium", high: "high" },
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      thinkingFormat: "chat-template",
      chatTemplateKwargs: {
        reasoning_effort: { "$var": "thinking.effort", omitWhenOff: true },
      },
    },
    notes:
      "gpt-oss-120b GGUF template (MXFP4 gguf, sha256 a4c9919c…146, 2026-08): reasoning surface is reasoning_effort ONLY — zero enable_thinking/preserve_thinking; template always emits an analysis channel and line 203-206 renders 'Reasoning: <effort>' into the system message, defaulting to 'medium' when the kwarg is absent. Template does NOT validate the value (no raise on effort), so the conservative asserted vocabulary is the documented {low, medium, high} — worst case for an unlisted value is a model-behavior risk, never a 400. off => 'medium' + omitWhenOff: omitting the kwarg lets the template's own medium default apply (no invented 'off' level exists); off is the closest-to-minimal-reasoning state the template supports, not a true think-off. contextWindow from gpt-oss.context_length GGUF key (131072); maxTokens 65536 matches the proven llama-swap deployment value (ctx/2). input text-only per template (string content only).",
  },
];
