/**
 * Tier→canonical normalization. Every value that enters the canonical form
 * (user override, discovery, preset) passes through these so all tiers speak
 * the same canonical spelling:
 *
 * - `thinkingLevelMap` is canonicalized: `null` entries (pi-ai's "declared
 *   unsupported" spelling) are DROPPED — the canonical form simply omits
 *   unsupported levels. The `off` entry (spelled `off: "low"` — non-null so it
 *   stays selectable; its value is moot under `omitWhenOff`) is preserved.
 * - `input` is filtered to real modalities and ordered text-first.
 * - capacities are positive integers; booleans pass through (`reasoning: false`
 *   is a meaningful value — an explicit "this model does not reason").
 * - `compat` is passed through verbatim (pi-ai's `OpenAICompletionsCompat`).
 *
 * Lenient: invalid values are dropped, not errors (config validation with
 * helpful errors is deferred).
 */

import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type {
  CanonicalModelFields,
  Compat,
  ModelModality,
  ThinkingLevelMap,
} from "../types.js";

/**
 * The STORED spelling of the explicit "no thinking levels" (nothink) state —
 * `thinkingLevelMap: "none"` in a per-model override entry. A STRING on
 * purpose: the settings mirror's schema-resolved view materializes an ABSENT
 * map to `{}`, so an empty-object store spelling could never be told apart
 * from "unset" at the client read boundary; the string survives resolution
 * unchanged and is never a phantom. See {@link canonicalizeThinkingLevelMap}
 * and the resolver's tier-1 expansion (the declaration expands to
 * `reasoning: false` — "no reasoning dimension").
 */
export const NO_THINKING_LEVELS = "none";

/** pi levels the canonical form may carry; `off` first, then the effort levels. */
export const CANONICAL_LEVELS: readonly ModelThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

const MODALITY_ORDER: readonly ModelModality[] = ["text", "image"];

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * Canonicalize a pi-ai raw `thinkingLevelMap`: drop `null` entries (null =
 * "declared unsupported"; the canonical spelling omits the level instead of
 * spelling it null), keep non-null string values verbatim, order keys
 * canonically (`off` first). Returns `undefined` when nothing selectable
 * remains.
 *
 * EXPLICIT NONE (the nothink state): the stored sentinel `"none"` (the
 * {@link NO_THINKING_LEVELS} string — the schema's non-object alternative)
 * maps to a PRESENT-EMPTY map: the canonical marker for "no selectable
 * levels" (a meaningful tier value, consumed by the resolver's tier-1
 * expansion). The empty OBJECT form is NOT the marker — it is the
 * schema-resolved phantom and keeps canonicalizing to
 * `undefined` (= unset, falls through the chain). Any other string is
 * invalid and dropped.
 */
export function canonicalizeThinkingLevelMap(raw: unknown): ThinkingLevelMap | undefined {
  if (raw === NO_THINKING_LEVELS) return {};
  if (!isPlainObject(raw)) return undefined;
  const acc: Record<string, string> = {};
  for (const level of CANONICAL_LEVELS) {
    const value = raw[level];
    if (typeof value === "string" && value.length > 0) {
      acc[level] = value;
    }
    // `null` (unsupported) and absent levels are dropped; invalid values too.
  }
  // Tolerate non-standard level keys (forward-compat) after the canonical ones.
  for (const [level, value] of Object.entries(raw)) {
    if (acc[level] === undefined && value !== null && typeof value === "string" && value.length > 0) {
      acc[level] = value;
    }
  }
  return Object.keys(acc).length > 0 ? (acc as ThinkingLevelMap) : undefined;
}

/**
 * Canonicalize a partial canonical-fields object from any tier. Returns
 * `undefined` when no canonical field survives validation.
 */
export function canonicalizeFields(raw: unknown): CanonicalModelFields | undefined {
  if (!isPlainObject(raw)) return undefined;
  const out: CanonicalModelFields = {};

  if (Array.isArray(raw.input)) {
    const present = new Set<ModelModality>(
      raw.input.filter((m): m is ModelModality => m === "text" || m === "image"),
    );
    const ordered = MODALITY_ORDER.filter((m) => present.has(m));
    if (ordered.length > 0) out.input = ordered;
  }
  if (typeof raw.reasoning === "boolean") out.reasoning = raw.reasoning;
  if (isPositiveInt(raw.contextWindow)) out.contextWindow = raw.contextWindow;
  if (isPositiveInt(raw.maxTokens)) out.maxTokens = raw.maxTokens;

  const tlm = canonicalizeThinkingLevelMap(raw.thinkingLevelMap);
  // `!== undefined` (NOT truthy): a PRESENT-EMPTY map is the explicit-none
  // (nothink) marker and must survive canonicalization; only `undefined`
  // (absent / phantom-only / invalid) is dropped.
  if (tlm !== undefined) out.thinkingLevelMap = tlm;

  if (isPlainObject(raw.compat) && Object.keys(raw.compat).length > 0) {
    out.compat = raw.compat as unknown as Compat;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}
