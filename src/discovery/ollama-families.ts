/**
 * Decision 5 — the Ollama `thinkingLevelMap` family table (the
 * preset-tier map keyed on Ollama's own template identity).
 *
 * For Ollama's built-in engine families the renderer IS the template (the
 * per-template authoring rule is satisfied): the chat template lives in
 * Ollama's built-in engine keyed by family, not in the artifact (note §1.3
 * regime 2). Each entry below is authored from the Ollama renderer source
 * named in its provenance comment — never from memory — and cites the
 * section that verified it (docs/provider-details.md §3.2, live-verified
 * against Ollama 0.32.15 + the `ollama/ollama` Go source at `main`,
 * 2026-08-26).
 *
 * pi-ai map semantics (verified in the `@earendil-works/pi-ai` dist, note
 * §2.5): a `null` value = level UNSUPPORTED (pi-ai clamps a requested level
 * to the nearest supported one client-side); a string value = the wire value
 * sent as `reasoning_effort`; `off` is sent when no level is requested. Map
 * values are Ollama-compat effort strings; `off: "none"` is the off-switch
 * encoding.
 *
 * THE PARSER TRAP (decision 5, note §2.3/§5): Ollama's `ThinkValue` parser
 * accepts `low|medium|high|max` for EVERY thinking-capable model —
 * acceptance ≠ distinct behavior. A map is emitted ONLY from the per-family
 * renderer evidence below, never from the parser's uniform acceptance.
 *
 * The maps are emitted VERBATIM (pi-ai's raw form, nulls included): the
 * nulls are load-bearing on the wire (unsupported-level spelling, e.g.
 * gpt-oss's `off: null` — trace cannot be disabled). The resolver's
 * tier→canonical boundary drops null entries per the canonical spelling
 * (`canonicalizeThinkingLevelMap`); the wire row keeps the honest map.
 */

import type { ThinkingLevelMap } from "../types.js";

/**
 * gemma4 — boolean-only renderer. Provenance: `model/renderers/gemma4.go`
 * L27-51 — only `thinkValue.Bool()` is consulted (`hasThink := thinkValue !=
 * nil && thinkValue.Bool()`); every string level collapses to ON at the SAME
 * intensity (note §2.4). `medium` is `ThinkValue.String()`'s own rendering of
 * `true` — the honest "on" value. `xhigh`/`max` ride Ollama's compat clamp
 * (`xhigh→max`, `openai/openai.go` `thinkFromReasoningEffort`, note §2.4) and
 * land on the same plain-on rendering, hence `medium`. All-null on-levels is
 * FORBIDDEN here (decision 5): client-side clamping would land on `off` —
 * thinking off when the user asked for on.
 */
export const OLLAMA_GEMMA4_MAP: ThinkingLevelMap = {
  off: "none",
  low: "medium",
  medium: "medium",
  high: "medium",
  xhigh: "medium",
  max: "medium",
};

/**
 * deepseek3 — same shape as gemma4 (boolean-only, source-verified).
 * Provenance: `model/renderers/deepseek3.go` L25-29 —
 * `thinking := r.IsThinking && thinkValue.Bool()`; the R1-style renderer
 * (thinking split out at the think-close tag) consults only the boolean
 * (note §2.4).
 */
export const OLLAMA_DEEPSEEK3_MAP: ThinkingLevelMap = OLLAMA_GEMMA4_MAP;

/**
 * qwen3.5 / qwen3.8 — the graded `qwen35` renderer. Provenance:
 * `model/renderers/qwen35.go` L113-133 (`qwen38ReasoningInstructions`):
 * `low` → low-effort instruction text, `medium` → none, `high`/`max` → xhigh
 * instruction text (high == max), anything else → 400 (note §2.4).
 * `xhigh: "max"` mirrors Ollama's own compat clamp (`openai/openai.go`
 * `thinkFromReasoningEffort`, note §2.4); `minimal: null` — the compat layer
 * folds minimal into low and the renderer has no distinct minimal tier, so
 * pi-ai clamps it client-side (note §2.5).
 */
export const OLLAMA_QWEN35_MAP: ThinkingLevelMap = {
  off: "none",
  minimal: null,
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "max",
  max: "max",
};

/**
 * gpt-oss (harmony). Provenance: `harmony/harmonyparser.go` +
 * `server/routes.go` L428-433 (the `shouldUseHarmony` family
 * `gptoss`/`gpt-oss` heuristic, note §2.4): harmony's Reasoning field
 * understands `low`/`medium`/`high`; **`"max"` is silently mapped to
 * `"high"` server-side** (say so — `max: "high"`, never a fictitious stronger
 * level; `xhigh: "max"` rides the compat clamp into the same server-side
 * fold). `off: null` — booleans are ignored for harmony and the trace CANNOT
 * be disabled (docs, note §2.4/§5): never send anything for off.
 */
export const OLLAMA_GPT_OSS_MAP: ThinkingLevelMap = {
  off: null,
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "max",
  max: "high",
};

/**
 * Cloud, family `glm*` — the owner's working glm-5.2:cloud config,
 * live-verified 2026-08-26 (note §2.5): `reasoning_effort: "none"` → NO
 * reasoning field, clean answer (the off switch IS honored for this cloud
 * family); the graded vocabulary accepted and honored as "on". `xhigh: null`
 * → pi-ai clamps xhigh→max client-side (the raw string never reaches
 * Ollama). Cloud renderers are server-side (ollama.com) — this entry rests
 * on the live probe, not renderer source.
 */
export const OLLAMA_CLOUD_GLM_MAP: ThinkingLevelMap = {
  off: "none",
  minimal: null,
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: null,
  max: "max",
};

/**
 * Cloud, family `deepseek*` — all levels unsupported. Live-verified
 * 2026-08-26: deepseek-v4-flash:cloud silently IGNORES even `think:false`
 * (note §2.1) — nothing is controllable; claiming any level would invent.
 * `reasoning: true` still rides the `thinking` capability (decision 4); the
 * all-null map is pi-ai's "no selectable levels" spelling. NOTE: the
 * resolver's tier→canonical boundary drops null entries, so this map falls
 * away at resolution time while `reasoning: true` survives — the honest wire
 * row is what carries the all-null declaration.
 */
export const OLLAMA_CLOUD_DEEPSEEK_MAP: ThinkingLevelMap = {
  off: null,
  minimal: null,
  low: null,
  medium: null,
  high: null,
  xhigh: null,
  max: null,
};

/**
 * Local parser-name keys (the modelfile `PARSER <name>` directive, note
 * §1.3/§2.4). The parser name is the template identity for built-in-engine
 * families — Ollama's own thinking detection keys the same names
 * (`model/parsers/parsers.go` `ParserForName`, note §2.4).
 *
 * `gptoss` is accepted beside `gpt-oss`: note §2.4 spells the harmony family
 * heuristic both ways, and the reference server had no gpt-oss pull to read
 * an actual `PARSER` line from.
 */
const PARSER_MAPS: Readonly<Record<string, ThinkingLevelMap>> = {
  gemma4: OLLAMA_GEMMA4_MAP,
  deepseek3: OLLAMA_DEEPSEEK3_MAP,
  "qwen3.5": OLLAMA_QWEN35_MAP,
  "qwen3.8": OLLAMA_QWEN35_MAP,
  "gpt-oss": OLLAMA_GPT_OSS_MAP,
  gptoss: OLLAMA_GPT_OSS_MAP,
};

/**
 * Family fallback (decision 5: `details.family` when the modelfile has no
 * `PARSER` line — e.g. locally re-manifested models with no modelfile, note
 * §5.6). Same keys as the parser table; `gptoss`/`gpt-oss` are both accepted
 * (note §2.4: "model family `gptoss`/`gpt-oss`").
 */
const FAMILY_MAPS: Readonly<Record<string, ThinkingLevelMap>> = PARSER_MAPS;

/**
 * Cloud entries (decision 5): keyed on CLOUD PROVENANCE (decision 2 —
 * `details.remote_host` present or a `:cloud` id suffix) + a family prefix,
 * not on the parser (cloud models have no modelfile by design — stub
 * manifests, server-side rendering, note §1.3 regime 1/§5). Cloud families
 * NOT listed here (kimi, minimax, qwen, …) fall to unknown → the map is
 * omitted — even when the family string matches a local entry (a cloud
 * qwen3.5 is rendered server-side; the local qwen35 renderer says nothing
 * about what ollama.com runs).
 */
const CLOUD_FAMILY_MAPS: ReadonlyArray<{ prefix: string; map: ThinkingLevelMap }> = [
  { prefix: "glm", map: OLLAMA_CLOUD_GLM_MAP },
  { prefix: "deepseek", map: OLLAMA_CLOUD_DEEPSEEK_MAP },
];

/** The lookup key for {@link ollamaThinkingLevelMapFor} (decision 5). */
export interface OllamaFamilyKey {
  /** The modelfile `PARSER <name>` directive (absent for cloud/stub models). */
  parser?: string;
  /** The `details.family` string (absent/empty on some cloud models). */
  family?: string;
  /** Cloud provenance (decision 2): `details.remote_host` or a `:cloud` suffix. */
  isCloud: boolean;
}

/**
 * Resolves the family-table `thinkingLevelMap` for one model (decision 5):
 * cloud models key on the cloud entries alone (family prefix `glm*` /
 * `deepseek*`); local models key on the modelfile `PARSER <name>` directive
 * first, falling back to `details.family`. UNKNOWN parser/family — including
 * every legacy Go-template family and every unlisted cloud family — yields
 * `undefined` (the map is omitted; `reasoning` is unaffected). Never throws;
 * absent/empty keys simply miss.
 */
export function ollamaThinkingLevelMapFor(key: OllamaFamilyKey): ThinkingLevelMap | undefined {
  if (key.isCloud) {
    const family = key.family ?? "";
    return CLOUD_FAMILY_MAPS.find((cloud) => family.startsWith(cloud.prefix))?.map;
  }
  if (key.parser !== undefined && PARSER_MAPS[key.parser] !== undefined) {
    return PARSER_MAPS[key.parser];
  }
  if (key.family !== undefined && FAMILY_MAPS[key.family] !== undefined) {
    return FAMILY_MAPS[key.family];
  }
  return undefined;
}