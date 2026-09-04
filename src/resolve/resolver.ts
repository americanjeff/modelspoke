/**
 * The four-tier reasoning-metadata resolver (docs/design.md,
 * "Tiered reasoning-metadata resolution"):
 *
 *   1. user override (exact model id, modelspoke: settings namespace)
 *   2. server discovery (meta.llamaswap.* — llama-swap only)
 *   3. built-in preset (catalog-ordered first match on the model id)
 *   4. default (non-reasoning, basic compat)
 *
 * Precedence is FIRST NON-EMPTY WINS PER FIELD — each whole field
 * (`input`, `reasoning`, `contextWindow`, `maxTokens`, `thinkingLevelMap`,
 * `compat`) is one unit: one model can draw different fields from different
 * tiers. The per-field source map (`user | discovery | preset:<id> | default`)
 * is part of the contract — a wrong tier is diagnosable only if the user can
 * see which tier supplied the config.
 *
 * Notes:
 * - A present `reasoning: false` counts as non-empty (it is a definitive
 *   answer — the user-override escape hatch for "the preset is wrong for my
 *   quant"). An absent field (undefined) falls through to the next tier.
 * - The default tier does NOT invent capacities: `contextWindow`/`maxTokens`/
 *   `thinkingLevelMap` are omitted from the resolved object when no tier
 *   supplied them, and their source is reported as `default`.
 * - Whole-field units are never merged: a tier's `compat` is taken verbatim,
 *   not merged over the default compat.
 * - EXPLICIT NONE (nothink): a tier-1 entry that declares
 *   `thinkingLevelMap: "none"` (the stored sentinel — the nothink qwen-copies
 *   case: same model id, an endpoint copy with no reasoning-effort
 *   dimension) canonicalizes to a PRESENT-EMPTY map — which is why the
 *   resolver's input contract is a CANONICALIZED entry (the dsh adapter runs
 *   `normalizeOverrideEntry` first): a present-EMPTY map on the input is
 *   exactly the sentinel's canonical form, while a hand-edited stored `{}`
 *   canonicalizes to ABSENT and can never be confused with it. At the
 *   tier-1 boundary the declaration EXPANDS to `reasoning: false` with the
 *   thinkingLevelMap field removed from the tier: the declaration is "this endpoint's copy
 *   has no reasoning dimension", so every downstream consumer (the pi-model
 *   builder, the effort machinery, the wire `$var` bindings) sees
 *   a plain non-reasoning model — zero new special cases. After the per-field
 *   loop the field is PINNED back onto the resolved object as the
 *   present-EMPTY map with source `user`, so the source map is honest (the
 *   user's declaration supplied it, not discovery/preset) and the resolved
 *   shape carries the explicit-none state distinct from "no tier supplied"
 *   (absent). The result's `nothink` marker surfaces it for the resolve-log
 *   line. Discovery/preset tiers never carry the sentinel (it is user
 *   vocabulary, not a wire format), so the expansion is tier-1-only.
 */

import type {
  CanonicalField,
  CanonicalModelFields,
  DiscoveryModelInfo,
  FieldSource,
  FieldSourceMap,
  OverrideEntry,
  ResolvedModel,
  ResolutionResult,
} from "../types.js";
import { matchPreset } from "../presets/match.js";
import { NO_THINKING_LEVELS, canonicalizeFields, isPlainObject } from "./canonical.js";

/** Tier-4 (default) values. */
export const DEFAULT_FIELDS: Readonly<CanonicalModelFields> = {
  reasoning: false,
  input: ["text"],
  compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
};

const CANONICAL_FIELDS: readonly CanonicalField[] = [
  "input",
  "reasoning",
  "contextWindow",
  "maxTokens",
  "thinkingLevelMap",
  "compat",
];

export interface ResolveInput {
  /** The exact model id being resolved. */
  modelId: string;
  /** Tier 1 — the user override for this exact id (absent → no user tier). */
  userOverride?: OverrideEntry;
  /** Tier 2 — the discovery result for this model (absent/empty → no discovery tier). */
  discovery?: DiscoveryModelInfo;
}

interface Tier {
  source: FieldSource;
  fields: CanonicalModelFields;
}

/** Per-field "non-empty" test (first non-empty wins per field). */
function isNonEmpty(field: CanonicalField, value: unknown): boolean {
  switch (field) {
    case "input":
      return Array.isArray(value) && value.length > 0;
    case "reasoning":
      return typeof value === "boolean";
    case "contextWindow":
    case "maxTokens":
      return typeof value === "number" && Number.isInteger(value) && value > 0;
    case "thinkingLevelMap":
    case "compat":
      return isPlainObject(value) && Object.keys(value).length > 0;
  }
}

/**
 * Resolve one model through the four tiers. Pure — no I/O; discovery input is
 * passed in (the host adapter fetches it) so the same resolution runs for ids
 * discovery didn't list (adapters may accept unlisted ids).
 *
 * **Precondition (tier 1):** `userOverride` must be pre-canonicalized with
 * `normalizeOverrideEntry` first (both dsh hosts do). The explicit-none
 * detection runs on the PRE-canonicalized form: a raw
 * `{ thinkingLevelMap: {} }` from a direct caller is NOT a nothink
 * declaration (stored empty objects canonicalize to absent) and would
 * misresolve. Other fields carry no such sharp edge — every tier is
 * defensively re-canonicalized.
 */
export function resolveModel(input: ResolveInput): ResolutionResult {
  const tiers: Tier[] = [];
  let nothink = false;

  if (input.userOverride !== undefined) {
    // EXPLICIT NONE detection: the nothink declaration arrives as EITHER
    // the stored `"none"` sentinel (direct callers / the yaml spelling) or its
    // canonicalized form — a PRESENT-EMPTY map. Both hosts run
    // `normalizeOverrideEntry` first, which maps `"none"` → present-empty `{}`
    // while a hand-edited stored `{}` canonicalizes to ABSENT (the
    // resolved-view phantom invariant — a stored empty object is NOT the
    // declaration). Detection
    // runs on the input BEFORE the defensive re-canonicalization below —
    // re-canonicalizing a present-empty map strips it (empty maps canonicalize
    // to absent), which is the double-canonicalization bug the live gate
    // caught.
    const rawTlm = isPlainObject(input.userOverride) ? input.userOverride.thinkingLevelMap : undefined;
    const explicitNone =
      rawTlm === NO_THINKING_LEVELS ||
      (isPlainObject(rawTlm) && Object.keys(rawTlm).length === 0);
    const userFields = canonicalizeFields(input.userOverride) ?? {};
    if (explicitNone) {
      // Expand to reasoning: false and drop the field from the tier (a plain
      // non-reasoning model downstream — zero special cases in the pi-model
      // builders). The pin after the per-field loop restores the field's
      // source + value on the RESOLVED object (see the module docblock).
      nothink = true;
      delete userFields.thinkingLevelMap;
      userFields.reasoning = false;
    }
    tiers.push({ source: "user", fields: userFields });
  }

  const discovered = input.discovery?.discoveredCanonical;
  if (discovered !== undefined) {
    tiers.push({ source: "discovery", fields: canonicalizeFields(discovered) ?? {} });
  }

  const preset = matchPreset(input.modelId);
  if (preset) {
    tiers.push({ source: `preset:${preset.id}`, fields: canonicalizeFields(preset) ?? {} });
  }

  tiers.push({ source: "default", fields: DEFAULT_FIELDS });

  const resolved: ResolvedModel = { input: [], reasoning: false, compat: {} };
  const sources: FieldSourceMap = {
    input: "default",
    reasoning: "default",
    contextWindow: "default",
    maxTokens: "default",
    thinkingLevelMap: "default",
    compat: "default",
  };

  for (const field of CANONICAL_FIELDS) {
    for (const tier of tiers) {
      const value = tier.fields[field];
      if (isNonEmpty(field, value)) {
        (resolved as Record<CanonicalField, unknown>)[field] = value;
        sources[field] = tier.source;
        break;
      }
    }
  }

  // EXPLICIT NONE pin: the declaration owns the field — the resolved model
  // carries the present-EMPTY map (the explicit-none state, inert downstream
  // because reasoning is false: the pi-model builders never spell levels for
  // non-reasoning models) and reports `user` as its source, regardless of
  // what discovery/preset would have supplied.
  if (nothink) {
    resolved.thinkingLevelMap = {};
    sources.thinkingLevelMap = "user";
  }

  return nothink ? { resolved, sources, nothink: true } : { resolved, sources };
}
