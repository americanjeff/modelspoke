/**
 * modelspoke — per-route overrides: the dual-shape read, the effective
 * tier-1 merge, and the first-write fold.
 *
 * The reorg: the section's per-model configuration is PER PROVIDER —
 * `routes[].overrides: { <model-id>: <entry> }` (the yaml key stays
 * `routes:`; the UI calls entries "providers") — and the legacy top-level
 * `overrides:` map stays READABLE during the transition (read-compatible
 * dual shape: a section may carry top-level, per-route, or BOTH). The
 * per-field precedence of the tier-1 lookup is:
 *
 *   route-level entry > legacy top-level entry > discovery > preset > default
 *
 * (the four-tier ORDER is unchanged; only the tier-1 storage location moved,
 * and the legacy location remains a fallback until the first section write
 * FOLDS it — see {@link foldLegacyOverrides}).
 *
 * Entry shape: the EXACT top-level override entry shape (canonical fields +
 * optional display `name` + the preserved deep fields `input` / `reasoning` /
 * `compat`, byte-for-byte through every write).
 *
 * Two shape rules this module owns:
 *
 * - **PHANTOM INVERSE** ({@link stripEntryPhantoms} /
 *   {@link cleanRoutePhantoms}): the settings seam's schema-RESOLVED view
 *   materializes empty defaults — on every override entry (`input: []`,
 *   `thinkingLevelMap: {}`, `compat: { chatTemplateKwargs: {} }`) AND on
 *   every route (`models: []`, `overrides: {}`). Writing the resolved view
 *   back would pollute the stored form, so every writer normalizes first:
 *   the strip is the exact inverse of the materialization and recovers the
 *   stored bytes.
 * - **EXPLICIT NONE (the nothink state)**: `thinkingLevelMap: "none"` (the
 *   {@link NO_THINKING_LEVELS} sentinel) is the stored spelling for "this
 *   endpoint's copy of this model has no selectable thinking levels". It
 *   round-trips because (a) the schema-resolved
 *   view keeps the string as-is — an ABSENT map materializes to `{}`, so a
 *   `{}` store spelling would be indistinguishable from absent at the client
 *   read boundary — and (b) the phantom strip removes only the EMPTY OBJECT
 *   form. At the canonical boundary (src/resolve/canonical.ts) `"none"` maps
 *   to a PRESENT-EMPTY map, and the resolver expands that at the tier-1
 *   boundary: the declaration is "no reasoning dimension", so the user tier
 *   supplies `reasoning: false` and the field reports `user` (the dsh
 *   adapter then sees a plain non-reasoning model — zero new special cases
 *   in the pi-model builder, the effort machinery, or the wire `$var`
 *   bindings).
 *   A hand-edited empty OBJECT (`thinkingLevelMap: {}`) is NOT the explicit
 *   state — it stays a phantom and reads as unset.
 *
 * - **SERVED SET**: a route's `models` field is the route's
 *   SERVED SET — either an array of model entries (`{ name, id, …config }`;
 *   presence in the list IS the served state, the allow-list filter is
 *   retired) or absent/`[]` = FULL_CATALOG (serve the whole discovered
 *   catalog; per-wire-id config rides the route's `overrides` map). The
 *   LENIENT reader ({@link decodeRouteModels}) accepts the entry shape and
 *   the FULL_CATALOG spelling — never throws, malformed elements skipped;
 *   a legacy string allow-list is NOT a supported stored form and degrades
 *   to FULL_CATALOG. The BYTE-PRESERVING writer ({@link storeRoute}) writes
 *   the entries (phantom-stripped, no `overrides` key) for an explicit
 *   route, and keeps an untouched FULL_CATALOG route's stored
 *   `models`/`overrides` bytes exactly (the phantom inverse on the legacy
 *   map recovers the stored form).
 *
 * Framework-neutral: no react, no node-only deps, no dsh imports (the client
 * bundle inlines it; the runtime requires stay react + react/jsx-runtime).
 */

import { isPlainObject } from "./resolve/canonical.js";
import { normalizeOverrideEntry } from "./config/index.js";
import type { ModelEntry, ModelspokeRoute, OverrideEntry } from "./types.js";

/** The stored spelling of the explicit "no thinking levels" (nothink) state. */
export const NO_THINKING_LEVELS = "none";

/**
 * The INVERSE of the settings mirror's per-entry default materialization
 * (the client's `stripPhantomDefaults`, lifted into the core so the node
 * writers and the client share ONE implementation). The schema-resolved view
 * materializes `input: []` / `thinkingLevelMap: {}` /
 * `compat: { chatTemplateKwargs: {} }` on entries that don't carry them;
 * writing those back would pollute settings.yaml with fields the user never
 * wrote, so every write/compare path passes entries through this first.
 * (An explicit `input: []` canonicalizes to absent — the documented rule.)
 *
 * The `thinkingLevelMap: "none"` sentinel is a STRING — a meaningful stored
 * state (explicit none), never a phantom: only the empty OBJECT form is
 * stripped.
 */
export function stripEntryPhantoms(entry: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...entry };
  if (Array.isArray(out.input) && out.input.length === 0) delete out.input;
  if (isPlainObject(out.thinkingLevelMap) && Object.keys(out.thinkingLevelMap).length === 0) {
    delete out.thinkingLevelMap;
  }
  if (isPlainObject(out.compat)) {
    const compat: Record<string, unknown> = { ...(out.compat as Record<string, unknown>) };
    const ctk = compat.chatTemplateKwargs;
    if (isPlainObject(ctk) && Object.keys(ctk).length === 0) delete compat.chatTemplateKwargs;
    if (Object.keys(compat).length === 0) delete out.compat;
    else out.compat = compat;
  }
  return out;
}

/**
 * Strip entry phantoms across a raw override map (whole entries; malformed
 * non-object values pass through, never thrown on). Entries that normalize to
 * nothing are dropped.
 */
export function stripMapPhantoms(map: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!isPlainObject(map)) return out;
  for (const [modelId, raw] of Object.entries(map)) {
    if (modelId.length === 0) continue;
    if (!isPlainObject(raw)) {
      out[modelId] = raw; // malformed non-object: pass through (lenient)
      continue;
    }
    const stripped = stripEntryPhantoms(raw);
    // An entry that normalizes to NOTHING is a phantom materialization (or a
    // hand-edited no-op) — it carries no user state, so it is dropped (the
    // the `input: []` canonicalizes-to-absent rule, at entry level).
    if (Object.keys(stripped).length > 0) out[modelId] = stripped;
  }
  return out;
}

/** The legacy top-level `overrides` map, raw ({} when absent/malformed). */
export function topLevelOverridesOf(section: unknown): Record<string, unknown> {
  return isPlainObject(section) && isPlainObject(section.overrides) ? section.overrides : {};
}

/** The named route's `routes[].overrides` map, raw ({} when absent). */
export function routeOverridesOf(section: unknown, routeName: string): Record<string, unknown> {
  const routes = isPlainObject(section) ? section.routes : undefined;
  if (!Array.isArray(routes)) return {};
  for (const raw of routes) {
    if (!isPlainObject(raw) || raw.name !== routeName) continue;
    return isPlainObject(raw.overrides) ? raw.overrides : {};
  }
  return {};
}

/**
 * The EFFECTIVE tier-1 entry for one (route, model id) — the per-field
 * route-wins merge of the route-level entry over the legacy top-level entry
 * (a field present on the route entry — after phantom strip — replaces the
 * legacy field; fields only on the legacy entry fill in). Both absent (or
 * phantom-only) → undefined. Never throws.
 *
 * A canonical field is ONE unit (the resolver's whole-field rule) — the
 * entry-key spread is therefore the per-field merge: `compat` merges as a
 * block, not deep.
 */
export function mergedOverrideEntry(
  legacyMap: Record<string, unknown> | undefined,
  routeMap: Record<string, unknown> | undefined,
  modelId: string,
): Record<string, unknown> | undefined {
  const legacyRaw = isPlainObject(legacyMap) ? legacyMap[modelId] : undefined;
  const routeRaw = isPlainObject(routeMap) ? routeMap[modelId] : undefined;
  const legacy = isPlainObject(legacyRaw) ? stripEntryPhantoms(legacyRaw) : undefined;
  const route = isPlainObject(routeRaw) ? stripEntryPhantoms(routeRaw) : undefined;
  if (legacy === undefined && route === undefined) return undefined;
  const merged = { ...legacy, ...route };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/** Section-level convenience for {@link mergedOverrideEntry} (dual-shape read). */
export function effectiveOverrideEntry(
  section: unknown,
  routeName: string,
  modelId: string,
): Record<string, unknown> | undefined {
  return mergedOverrideEntry(topLevelOverridesOf(section), routeOverridesOf(section, routeName), modelId);
}

/**
 * Strip the resolved-view phantoms from ONE route entry before a write:
 *
 * - `models: null` and `models: []` are materializations (absent in the
 *   stored form — the lenient readers treat both as FULL_CATALOG), so the
 *   writer drops the key; a NON-EMPTY `models` array gets each entry
 *   element phantom-stripped (the nested phantom invariant — the materialized
 *   `input: []` / `thinkingLevelMap: {}` / empty `compat` recover the
 *   stored form); old-shape string elements pass through untouched.
 * - an empty `overrides` map is a materialization (dropped); a non-empty
 *   map gets its ENTRIES phantom-stripped (the nested phantom invariant).
 *
 * Real values pass through untouched.
 */
export function cleanRoutePhantoms(route: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...route };
  if (out.models === null || (Array.isArray(out.models) && out.models.length === 0)) {
    delete out.models;
  } else if (Array.isArray(out.models)) {
    out.models = out.models.map((el) => (isPlainObject(el) ? stripEntryPhantoms(el) : el));
  }
  if (isPlainObject(out.overrides)) {
    const stripped = stripMapPhantoms(out.overrides as Record<string, unknown>);
    if (Object.keys(stripped).length === 0) delete out.overrides;
    else out.overrides = stripped;
  }
  return out;
}

/**
 * Normalize one RAW `models` element (NEW shape) into a ModelEntry: a plain
 * object carrying a non-empty string `id`. The entry is WHOLE (spread —
 * preserved deep fields travel byte-identically); a missing/blank `name`
 * DEFAULTS TO THE WIRE `id` (harness-id stability: existing sessions keep
 * their key). Malformed (non-object, empty `id`) → `undefined` (skipped,
 * never thrown).
 */
export function normalizeModelEntry(raw: unknown): ModelEntry | undefined {
  if (!isPlainObject(raw)) return undefined;
  const id = raw.id;
  if (typeof id !== "string" || id.length === 0) return undefined;
  const name = typeof raw.name === "string" && raw.name.length > 0 ? raw.name : id;
  // The schema-RESOLVED section materializes empty defaults (input: [],
  // compat: {chatTemplateKwargs: {}}) on every entry; strip them so a
  // {name, id}-only entry reads as "no user configuration" downstream.
  const stripped = stripEntryPhantoms(raw);
  const entry: Record<string, unknown> = { ...stripped };
  entry.name = name;
  entry.id = id;
  return entry as unknown as ModelEntry;
}

/**
 * Build a seed entry for a wire id: `name === id` (harness-id stability) +
 * the id's committed config from the route's `overrides` map, WHOLE — EXCEPT
 * the old cosmetic `name` field, which is DROPPED (subsumed by the entry
 * `name`; cosmetic, re-settable). Used by the FULL_CATALOG → explicit
 * materialization SEED ({@link seedCatalogEntries}). A malformed
 * (non-object) config entry reads as empty.
 */
export function entryFromLegacyId(id: string, legacy: Record<string, unknown> | undefined): ModelEntry {
  const raw = legacy !== undefined && isPlainObject(legacy[id]) ? (legacy[id] as Record<string, unknown>) : {};
  const entry: Record<string, unknown> = { ...raw };
  delete entry.name;
  entry.name = id;
  entry.id = id;
  return entry as unknown as ModelEntry;
}

/** The decoded served set of one raw route (see {@link decodeRouteModels}). */
export interface DecodedRouteModels {
  /** The EXPLICIT served set — or `null` = FULL_CATALOG. */
  models: ModelEntry[] | null;
  /** The route's legacy `overrides` map — set ONLY for FULL_CATALOG routes. */
  legacyOverrides?: Record<string, unknown>;
}

/**
 * Decode one RAW route's `models` / `overrides` into the in-memory served
 * set (the lenient reader — never throws):
 *
 * - `models` is an array carrying at least one PLAIN OBJECT with a string
 *   `id` → **EXPLICIT**: `models` = the entries in list order (each
 *   normalized — a missing `name` defaults to the `id`; non-object elements
 *   skipped). `legacyOverrides` ABSENT — the entries carry the config, and
 *   the stored `overrides` key is dropped on the first explicit write.
 * - else (no `models` / empty / every element malformed) → **FULL_CATALOG**:
 *   `models: null`, `legacyOverrides` = the route's `overrides` map (raw
 *   pass-through; absent/empty/malformed = absent).
 *
 * A legacy string allow-list (`models: ["id", …]`) is NOT a supported
 * stored form: it degrades to FULL_CATALOG (the allow-list is ignored, the
 * whole endpoint catalog is served). Recreate the route in the entry form
 * to serve a specific set. A hand-edited mixed array (objects AND strings)
 * reads as EXPLICIT (the string elements are skipped as malformed).
 */
export function decodeRouteModels(route: Record<string, unknown>): DecodedRouteModels {
  const raw = route ?? {};
  const legacy =
    isPlainObject(raw.overrides) && Object.keys(raw.overrides).length > 0
      ? (raw.overrides as Record<string, unknown>)
      : undefined;
  const modelsRaw = raw.models;
  if (!Array.isArray(modelsRaw) || modelsRaw.length === 0) {
    return { models: null, ...(legacy === undefined ? {} : { legacyOverrides: legacy }) };
  }
  const isEntryElement = (el: unknown): boolean =>
    isPlainObject(el) && typeof (el as Record<string, unknown>).id === "string";
  if (modelsRaw.some(isEntryElement)) {
    const entries: ModelEntry[] = [];
    for (const el of modelsRaw) {
      const entry = normalizeModelEntry(el);
      if (entry !== undefined) entries.push(entry);
    }
    return { models: entries };
  }
  // No entry elements (a legacy string allow-list, or every element
  // malformed): degrade to FULL_CATALOG (lenient, never throws).
  return { models: null, ...(legacy === undefined ? {} : { legacyOverrides: legacy }) };
}

/**
 * The EXPLICIT entry's tier-1 override: the entry's canonical fields,
 * normalized through the core's canonical boundary (the identity fields
 * `name` / `id` and the dsh-only `defaultEffort` are stripped first — they
 * are identity, not configuration). A `{ name, id }`-only entry →
 * `undefined` (no user configuration: the chain resolves from
 * discovery/preset/default). Lenient: a malformed entry reads as absent,
 * never throws.
 */
export function entryOverride(
  entry: ModelEntry | Record<string, unknown> | undefined,
): OverrideEntry | undefined {
  if (!isPlainObject(entry)) return undefined;
  const { name, id, defaultEffort, ...rest } = entry;
  return normalizeOverrideEntry(rest);
}

// The two canonical fields the override form EXPOSES beyond the original
// four (name / contextWindow / maxTokens / thinkingLevelMap): `input`
// (image-input support) and `compat.supportsReasoningEffort` (reasoning-
// effort support). Both are pure functions of (effective entry, preset,
// checkbox state) so the client's save path and the unit tests share one
// implementation — the same posture as every other shape rule in this file.

/**
 * The `input` field for a form save: `["text", "image"]` when image input is
 * supported, `["text"]` otherwise. NEVER `[]` — an empty array is a schema
 * phantom that canonicalizes to ABSENT (see
 * {@link stripEntryPhantoms}), which would release the field back down the
 * chain instead of pinning text-only. Canonical order: text first
 * (src/types.ts).
 */
export function inputModalities(imageInput: boolean): string[] {
  return imageInput ? ["text", "image"] : ["text"];
}

/**
 * The `compat` field for a form save — or `undefined` when the writer must
 * OMIT the key entirely (the field releases back down the resolution chain;
 * an empty `{}` would be a phantom).
 *
 * WHOLE-BLOCK RULE (src/resolve/resolver.ts, "Whole-field units are never
 * merged: a tier's `compat` is taken verbatim, not merged over the default
 * compat"): a tier's compat REPLACES the lower tier's entire block. A
 * partial compat write (`{ supportsReasoningEffort: true }` alone) would
 * drop the lower tier's `thinkingFormat` / `chatTemplateKwargs` and other
 * deep template fields → mid-turn 400s. The writer must therefore
 * MATERIALIZE the deep fields next to the one the form edits:
 *
 * - base = the EXISTING entry's `compat` minus its `supportsReasoningEffort`
 *   key — when it is a plain object with keys remaining. Values are copied
 *   VERBATIM (shallow copy — the `chatTemplateKwargs` `{$var: …}` objects
 *   must survive byte-identically, never re-serialized);
 * - if base is empty and `presetCompat` has keys other than
 *   `supportsReasoningEffort` → base = that preset block minus the key
 *   (same verbatim rule) — the form's displayed value was seeded from the
 *   preset, so the materialized write keeps the preset's template contract;
 * - return `undefined` IF AND ONLY IF base is empty AND
 *   `supportsReasoningEffort === false` (nothing user-owned in the block —
 *   release it back down the chain);
 * - otherwise return `{ …base, supportsReasoningEffort }`. An explicit
 *   `false` PINS false: the user tier takes the field verbatim, so without
 *   the pin a lower tier (e.g. the preset) saying `true` would leak through
 *   a write whose only intent was "I turned it off".
 *
 * Lenient: malformed `existingEntry`/`presetCompat` (non-object) read as
 * absent — never throws.
 *
 * @param existingEntry the WHOLE effective entry, phantom-stripped (the
 *   dual-shape tier-1 merge, {@link effectiveOverrideEntry}).
 * @param presetCompat the matched preset's `compat` object, or null.
 * @param supportsReasoningEffort the form's reasoning-effort checkbox.
 */
export function compatForWrite(
  existingEntry: Record<string, unknown> | null | undefined,
  presetCompat: Record<string, unknown> | null | undefined,
  supportsReasoningEffort: boolean,
): Record<string, unknown> | undefined {
  const pickDeep = (source: unknown): Record<string, unknown> | undefined => {
    if (!isPlainObject(source)) return undefined;
    const deep: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(source)) {
      if (key !== "supportsReasoningEffort") deep[key] = value; // verbatim
    }
    return Object.keys(deep).length > 0 ? deep : undefined;
  };
  const existingCompat = isPlainObject(existingEntry) ? existingEntry.compat : undefined;
  const base = pickDeep(existingCompat) ?? pickDeep(presetCompat);
  if (base === undefined && supportsReasoningEffort === false) return undefined;
  return { ...(base ?? {}), supportsReasoningEffort };
}

/**
 * The inputs to the empty-entry guard, as a plain object (the rule is pure,
 * so it is unit-testable outside the client). Every field is the form's
 * DISPLAYED state at save time — not the effective entry.
 */
export interface OverrideDraftFacts {
  /** The displayed name (empty = released). */
  name: string;
  /** The displayed context window (empty = released). */
  contextWindow: string;
  /** The displayed max output tokens (empty = released). */
  maxTokens: string;
  /** The displayed thinking-level row count (0 = released). */
  tlRowCount: number;
  /** The nothink checkbox (`thinkingLevelMap: "none"` sentinel). */
  nothink: boolean;
  /**
   * The MATERIALIZED compat ({@link compatForWrite}'s result). `undefined`
   * = the field is released (omitted from the written entry).
   */
  compat: Record<string, unknown> | undefined;
  /**
   * Whether the user TOGGLED the image-input checkbox away from its
   * displayed default at open time (`d.imageInput !==
   * d.imageInputSeeded`). `input` is written on EVERY save (it has no
   * "released" state — see {@link inputModalities}), so an un-toggled
   * checkbox is a no-op write and must not count as content.
   */
  imageInputToggled: boolean;
}

/**
 * Whether a form save carries ANYTHING meaningful (the empty-entry guard).
 * `Object.keys(entry).length === 0` can no longer be the test — `input` is
 * now written on every save — so the guard is a pure function of the
 * displayed fields: name / contextWindow / maxTokens non-empty, a thinking-
 * level row, the nothink sentinel, a materialized compat, or a user toggle
 * of the modality off its displayed default.
 */
export function overrideEntryMeaningful(facts: OverrideDraftFacts): boolean {
  return (
    facts.name.trim() !== "" ||
    facts.contextWindow.trim() !== "" ||
    facts.maxTokens.trim() !== "" ||
    facts.tlRowCount > 0 ||
    facts.nothink === true ||
    facts.compat !== undefined ||
    facts.imageInputToggled === true
  );
}

export interface FoldResult {
  /**
   * The routes array with the folded entries merged into each owning route's
   * `overrides` map; every route passes through {@link cleanRoutePhantoms}
   * (a malformed non-object route passes through as-is — the fold never
   * drops data).
   */
  routes: unknown[];
  /**
   * The entries that keep their top-level home. The fold keeps the top-level
   * `overrides:` key while this is non-empty; an empty leftover means the
   * writer stops writing the key (the migration is complete).
   */
  leftover: Record<string, unknown>;
  /** How many entries left the top level (folded into a route's map). */
  folded: number;
}

/**
 * The first-write fold (PURE): moves the legacy top-level `overrides` into
 * the owning route's `routes[].overrides` — values byte-preserved (whole
 * entries, phantom-stripped — the exact inverse of the resolved-view
 * materialization, so the recovered form is the stored form) — per-field
 * route-wins where the route already carries the id.
 *
 * Ownership rules (multi-route sections):
 * - EXACTLY ONE route: EVERY entry folds into it. Single-route sections are
 *   the common case (the testenv is one); while only one route exists the
 *   entry's effective resolution is route-independent anyway, so nothing is
 *   lost by the move.
 * - Otherwise an entry's owning route is the route that OFFERS the model id —
 *   claimed = the id appears in that route's `models:` allow-list. The
 *   curated list is the only pre-discovery evidence of what a route serves;
 *   an uncurated route offers its full catalog and thus claims nothing
 *   specifically. Exactly one claimant → that route. MULTIPLE claimants →
 *   the FIRST claimant in configuration order (deterministic; the legacy
 *   entry resolved on every route before the fold, and the first route is
 *   the home a single-route section would have had — a documented choice,
 *   test-gated). NO claimant → the entry STAYS in `leftover`: it still
 *   resolves on every route, and guessing a home for it would be lossy.
 * - NO routes: nothing folds; every entry is leftover (the key is kept).
 */
/** The route elements that ARE model entries (the new shape). */
function entryElementsOf(route: Record<string, unknown>): Record<string, unknown>[] {
  const models = route.models;
  if (!Array.isArray(models)) return [];
  return models.filter(
    (el): el is Record<string, unknown> =>
      isPlainObject(el) && typeof (el as Record<string, unknown>).id === "string",
  );
}

/**
 * Does this raw route SPECIFICALLY claim the wire id (the fold's ownership
 * probe)? A FULL_CATALOG route (no/empty `models`) serves its whole catalog
 * and claims nothing specifically (the reorg rule, unchanged). An explicit
 * route claims the ids its entries carry — OLD-shape string allow-list
 * elements and NEW-shape entry `id`s alike.
 */
function routeClaimsRoute(route: Record<string, unknown>, modelId: string): boolean {
  const models = route.models;
  if (!Array.isArray(models) || models.length === 0) return false;
  if (entryElementsOf(route).some((el) => el.id === modelId)) return true;
  return models.includes(modelId);
}

/**
 * Fold ONE legacy top-level entry into its owning raw route; returns
 * `false` when the entry is NOT representable there (an EXPLICIT route
 * whose entries carry no matching wire id — writing it would change the
 * route's served set, so the entry stays in the leftover):
 *
 * - NEW-shape route (entry elements present): merge into EVERY matching
 *   entry (same wire id — the variant case), per-field ENTRY-WINS, the
 *   entry's `name` / `id` identity untouchable, and the legacy entry's
 *   cosmetic `name` DROPPED (the migration rule: subsumed by the entry's
 *   harness `name`).
 * - otherwise (FULL_CATALOG, or the OLD string-allow-list shape): the
 *   route's `overrides` map, per-field ROUTE-WINS (the reorg rule — for the
 *   old shape the reader absorbs that map into the migrated entries, so
 *   the fold is exactly the entry config the read produces).
 */
function foldEntryIntoRoute(
  route: Record<string, unknown>,
  modelId: string,
  rawEntry: unknown,
): boolean {
  const legacy = isPlainObject(rawEntry) ? { ...stripEntryPhantoms(rawEntry) } : rawEntry;
  const entryElements = entryElementsOf(route);
  const matching = entryElements.filter((el) => el.id === modelId);
  if (entryElements.length > 0 && matching.length === 0) {
    // An EXPLICIT route whose entries carry no matching wire id: the entry
    // is not representable without CHANGING THE SERVED SET (never invent an
    // entry here) — it stays in the leftover.
    return false;
  }
  if (matching.length > 0) {
    const models = route.models as unknown[];
    route.models = models.map((el) => {
      if (!matching.includes(el as Record<string, unknown>)) return el;
      const stripped = stripEntryPhantoms(el as Record<string, unknown>);
      if (isPlainObject(legacy)) {
        for (const [key, value] of Object.entries(legacy)) {
          if (key === "name" || key === "id") continue; // identity untouchable
          if (stripped[key] !== undefined) continue; // per-field entry-wins
          stripped[key] = value;
        }
      }
      return stripped;
    });
    return true;
  }
  const existing = isPlainObject(route.overrides)
    ? { ...(route.overrides as Record<string, unknown>) }
    : {};
  const existingEntry = isPlainObject(existing[modelId])
    ? stripEntryPhantoms(existing[modelId])
    : undefined;
  // Per-field route-wins: the route's existing entry is the superior copy.
  // The legacy cosmetic `name` is kept here (the old shape's overrides map
  // is the cosmetic-home; the reader drops it when it migrates to entries).
  const merged = { ...(legacy as Record<string, unknown>), ...(existingEntry ?? {}) };
  if (Object.keys(merged).length > 0) existing[modelId] = merged;
  route.overrides = existing;
  return true;
}

export function foldLegacyOverrides(section: unknown): FoldResult {
  const rawRoutes = isPlainObject(section) && Array.isArray(section.routes) ? section.routes : [];
  const routes = rawRoutes.map((raw) => (isPlainObject(raw) ? cleanRoutePhantoms(raw) : raw));
  // Malformed (non-object) routes pass through untouched but do NOT count
  // toward the ownership rules — the lenient readers skip them anyway.
  const valid: Array<{ index: number; route: Record<string, unknown> }> = [];
  routes.forEach((raw, index) => {
    if (isPlainObject(raw)) valid.push({ index, route: raw });
  });
  const top = stripMapPhantoms(topLevelOverridesOf(section));
  const leftover: Record<string, unknown> = {};
  let folded = 0;

  const claimantIndexes = (modelId: string): number[] =>
    valid
      .filter(({ route }) => routeClaimsRoute(route, modelId))
      .map(({ index }) => index);

  for (const [modelId, entry] of Object.entries(top)) {
    let target: number | undefined;
    if (valid.length === 1) {
      const only = valid[0];
      if (only !== undefined) target = only.index;
    } else {
      const claimants = claimantIndexes(modelId);
      if (claimants.length >= 1) target = claimants[0];
    }
    if (target === undefined) {
      leftover[modelId] = entry;
      continue;
    }
    const route = routes[target] as Record<string, unknown>;
    if (!foldEntryIntoRoute(route, modelId, entry)) {
      // The single-route rule named this route, but the entry is not
      // representable in its EXPLICIT served set — it stays in the leftover
      // (still resolves on FULL_CATALOG routes; guessing an entry would
      // change the served set).
      leftover[modelId] = entry;
      continue;
    }
    folded += 1;
  }
  return { routes, leftover, folded };
}

// The BYTE-PRESERVING route writer (the card-commit's per-route half; the
// whole-section glue — the legacy top-level fold + the `renderReadImages`
// mirror carry — stays with the section writers, src/dsh/channel.ts):
//
// - **EXPLICIT** route (`models: ModelEntry[]`): write `models` = the
//   entries — `name` / `id` (and a non-empty `defaultEffort`) leading, the
//   rest phantom-stripped (the resolved-view materialization inverse — the
//   materialized `input: []` / `thinkingLevelMap: {}` / empty `compat`
//   recover the stored form; the `"none"` sentinel is a string and never a
//   phantom). NO `overrides` key is written — the per-model config lives in
//   the entries, and the route's legacy map (if any) is DROPPED from the
//   stored form on the first explicit write (the reader would never
//   consult it for an explicit route). An explicit entry that carries no
//   non-empty `name` AND `id` is skipped (the lenient posture — the UI
//   discards empty-id rows before committing).
// - **FULL_CATALOG** route (`models: null`): preserve the OLD shape
//   BYTE-FOR-BYTE — the committed `models` key (absent / `[]` / anything
//   malformed) is left AS-IS (untouched, so an untouched FULL_CATALOG
//   route round-trips its exact stored bytes), and the route's `overrides`
//   map passes through WHOLE (phantom-stripped — the materialization
//   inverse recovers the stored form — never a field-by-field
//   reconstruction).
//
// The route FIELDS (`name` / `baseURL` / `apiKeyEnv`) come from the IN-MEMORY
// route (the card's draft): `apiKeyEnv` is written only when non-empty,
// deleted when the draft cleared it. A stale ROUTE-level `defaultEffort`
// (the field was removed — effort is per-model now) is deleted from the
// stored form on the first write so pre-removal yamls converge. ANY OTHER
// committed key (schema-unnamed) passes through untouched (whole-route
// spread, never a reconstruction). Pure: returns a NEW object; the inputs
// are never mutated.
export function storeRoute(
  route: ModelspokeRoute,
  committed: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(committed ?? {}) };
  out.name = route.name;
  out.baseURL = route.baseURL;
  if (typeof route.apiKeyEnv === "string" && route.apiKeyEnv.length > 0) out.apiKeyEnv = route.apiKeyEnv;
  else delete out.apiKeyEnv;
  delete out.defaultEffort; // stale route-level key (field removed) — converge

  if (route.models === null) {
    // FULL_CATALOG: the committed `models` key is NOT touched (absent stays
    // absent, `[]` stays `[]` — exact stored bytes). The legacy map passes
    // through whole; the draft's `legacyOverrides` (untouched = the
    // committed map) is the source when present.
    const source = route.legacyOverrides !== undefined ? route.legacyOverrides : out.overrides;
    if (isPlainObject(source)) {
      const stripped = stripMapPhantoms(source);
      if (Object.keys(stripped).length > 0) out.overrides = stripped;
      else delete out.overrides;
    } else {
      delete out.overrides;
    }
    return out;
  }

  // EXPLICIT: one written entry per served model. An explicit EMPTY set
  // collapses to the FULL_CATALOG stored form (no `models` key): the stored
  // grammar has no "serve nothing" spelling — `models: []` reads back as
  // FULL_CATALOG (the "empty ≡ full" discipline, preserved: a written
  // form must re-read to the state it was written from).
  if (route.models.length === 0) {
    delete out.models;
    delete out.overrides;
    return out;
  }

  const models: Record<string, unknown>[] = [];
  for (const raw of route.models) {
    if (!isPlainObject(raw)) continue; // malformed element: skipped (lenient)
    const name = typeof raw.name === "string" ? raw.name : "";
    const id = typeof raw.id === "string" ? raw.id : "";
    if (name.length === 0 || id.length === 0) continue; // empty rows are discarded
    const written: Record<string, unknown> = { name, id };
    if (typeof raw.defaultEffort === "string" && raw.defaultEffort.length > 0) {
      written.defaultEffort = raw.defaultEffort;
    }
    const stripped = stripEntryPhantoms(raw);
    for (const [key, value] of Object.entries(stripped)) {
      if (key === "name" || key === "id" || key === "defaultEffort") continue;
      written[key] = value;
    }
    models.push(written);
  }
  if (models.length === 0) {
    // The written set is empty (all rows discarded) — the same collapse as
    // an explicitly empty set: the stored grammar has no "serve nothing"
    // spelling, `models: []` reads back as FULL_CATALOG.
    delete out.models;
    delete out.overrides;
    return out;
  }
  out.models = models;
  delete out.overrides;
  return out;
}
