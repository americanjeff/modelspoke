/**
 * modelspoke: settings read.
 *
 * Pure functions only — NO dsh imports. The dsh host adapter wires the
 * live settings object into `loadOverrides`; this module just normalizes.
 *
 * The plugin-owned settings namespace (dsh: `modelspoke:` in
 * `~/.dsh/settings.yaml`) holds:
 * - `routes` — `{ name, baseURL, apiKeyEnv?, models?,
 *   overrides? }[]` — a route (the UI's "provider") carries its PER-ROUTE
 *   model overrides in `overrides` (exact model id → the override entry
 *   — tier 1 for the models that route serves, per field over the legacy
 *   top-level map).
 * - `overrides` — the LEGACY top-level map (exact model id → canonical entry
 *   + optional `name`), still readable during the transition (dual shape;
 *   the first section write folds it into the owning route's map —
 *   src/overrides.ts).
 */

import type {
  ModelspokeSettings,
  OverrideEntry,
} from "../types.js";
import { canonicalizeFields, isPlainObject } from "../resolve/canonical.js";

/**
 * Reads + normalizes the `modelspoke:` overrides from a (parsed) dsh
 * settings object. Accepts either the FULL settings object
 * (`{ modelspoke: { overrides: … } }`) or the namespace object itself
 * (`{ overrides: … }`).
 *
 * Pure; lenient — entries/fields with invalid values are dropped,
 * not errors (config validation with helpful errors is deferred).
 * `name` (display cosmetics) is kept on the entry; canonical fields are
 * normalized to the canonical spelling (null thinkingLevelMap entries
 * dropped, input ordered text-first, capacities positive integers).
 */
export function loadOverrides(settingsObject: unknown): Record<string, OverrideEntry> {
  const ns = asNamespace(settingsObject);
  const raw = ns?.overrides;
  const out: Record<string, OverrideEntry> = {};
  if (!isPlainObject(raw)) return out;
  for (const [modelId, entryRaw] of Object.entries(raw)) {
    if (modelId.length === 0) continue;
    const entry = normalizeOverrideEntry(entryRaw);
    if (entry) out[modelId] = entry;
  }
  return out;
}

/**
 * Accepts the full dsh settings object or the `modelspoke:` namespace object
 * itself; returns the namespace (or undefined).
 */
function asNamespace(settingsObject: unknown): ModelspokeSettings | undefined {
  if (!isPlainObject(settingsObject)) return undefined;
  if ("modelspoke" in settingsObject) {
    const inner = settingsObject.modelspoke;
    return isPlainObject(inner) ? (inner as unknown as ModelspokeSettings) : undefined;
  }
  if ("overrides" in settingsObject || "routes" in settingsObject) {
    return settingsObject as unknown as ModelspokeSettings;
  }
  return undefined;
}

/**
 * Normalizes one override entry (canonical fields + optional display name).
 * Exported: the per-route tier-1 lookup normalizes the merged
 * (route-level + legacy) raw entry through this same boundary — one
 * canonicalization, one lenient-drop posture.
 */
export function normalizeOverrideEntry(raw: unknown): OverrideEntry | undefined {
  if (!isPlainObject(raw)) return undefined;
  const fields = canonicalizeFields(raw);
  const name = typeof raw.name === "string" && raw.name.length > 0 ? raw.name : undefined;
  if (!fields && !name) return undefined;
  const entry: OverrideEntry = { ...(fields ?? {}) };
  if (name) entry.name = name;
  return entry;
}
