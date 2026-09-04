/**
 * The modelspoke dsh client's model-curation contract: the pure
 * rules behind the provider card's model list (the expanded card's
 * ADD/REMOVE row control — presence in the list IS the served set),
 * extracted so the semantics are unit-tested directly.
 *
 * Framework-neutral on purpose: NO react import, no DOM, no node-only deps.
 * The client bundle (src/dsh/client.tsx) imports these and tsdown inlines
 * the module (the bundle's runtime requires stay react + react/jsx-runtime);
 * the unit tests (test/curation.test.ts) import the module directly in a
 * node environment. client.tsx itself cannot be imported from a test (its
 * top-level react import is answered by the web shell's module table at
 * bundle runtime, not by this repo's node_modules).
 *
 * THE CONTRACT (settings iteration, "Curation (add/remove)"):
 *
 * The provider's model list is the route's SERVED SET (src/types.ts
 * `ModelEntry[]`), or FULL_CATALOG (`models: null` — serve the whole
 * fetched catalog, per-wire-id config in the route's legacy `overrides`
 * map). The card's row universe is the COMMITTED served set (or the
 * fetched catalog while FULL_CATALOG); the per-row `id` is editable via a
 * combobox over the FULL catalog (typed ids not in the catalog are legal);
 * `name` (the harness identity, unique within the provider) is the first
 * column and editable; `−` removes a row; **Add model** appends one.
 *
 * The ADD/REMOVE rules below are pure entry-list operations
 * ({@link addModelEntry} / {@link removeModelEntry} / {@link
 * renameModelEntry} / {@link updateModelEntry} / {@link
 * entryNameCollision}); the card drafts the ORDERED entry list and commits
 * it through the byte-preserving writer (src/overrides.ts
 * {@link storeRoute}).
 *
 * ROW ADDRESSING IS BY SLOT, NOT BY NAME: a row's `name` is a mutable label
 * that may transiently collide with a sibling's (typed mid-draft, or a
 * legacy / hand-edited committed duplicate), so rows are addressed by their
 * stable slot — a slot index for the entry-list ops, a {@link seedRowKeys}
 * token for the card's per-row draft state — never by name. A committed
 * duplicate is refused at write time (Apply gate: {@link
 * resolveNameCollision}; write gate: src/dsh/settings.ts
 * `assertServiceable`). Design + failure modes: docs/design.md "Settings
 * UI — row addressing".
 *
 * FULL_CATALOG → EXPLICIT materialization: the first EDIT of a
 * FULL_CATALOG route (remove a row, add a non-catalog id, or edit a row's
 * config) seeds the draft from the fetched catalog ({@link
 * seedCatalogEntries}: each `{ name: id, id, …legacyOverrides[id] }`, the
 * cosmetic legacy `name` dropped — the migration rule) and applies the
 * edit. A FULL_CATALOG route that is only viewed stays FULL_CATALOG: its
 * dirty baseline IS the catalog seed, so an unedited seed reads clean
 *
 * Dirty tracking (generalized): the per-provider draft is the entry
 * list (ordered) + the route fields; dirty = the entry list diverges from
 * the committed baseline (deep, phantom-tolerant, ORDER-SENSITIVE compare
 * — {@link entryListDirty}) OR a detail config draft OR a pending reset.
 *
 * The detail's per-model configuration surface is carried over
 * unchanged: the editable fields draft per-model config entries
 * ({@link ModelConfigDraft}) and commit through the {@link mergeModelConfig}
 * merge discipline onto the entry itself ({@link applyConfigDraftToEntry})
 * or the FULL_CATALOG legacy map ({@link cardModelOverrides}) — the
 * per-function docs carry the contract. The capability unification (the
 * "Reasoning effort" checkbox = the model HAS a reasoning-effort dimension
 * — effective `thinkingLevelMap` non-empty; OFF = the nothink sentinel) is
 * a detail-surface rendering of the same `nothink` / `tlRows` draft
 * fields.
 */

import { isPlainObject } from "../resolve/canonical.js";
import {
  NO_THINKING_LEVELS,
  compatForWrite,
  entryFromLegacyId,
  inputModalities,
  overrideEntryMeaningful,
  stripEntryPhantoms,
} from "../overrides.js";
import type { ModelEntry } from "../types.js";
// i18n — the status-dot detail text and the "preserved from settings.yaml"
// line are USER-FACING strings, so their WORDING comes from the locale bundle
// (./locales.js) while the CLASSIFICATION / SELECTION logic stays here (the
// single pure source). The caller threads the resolved locale in; the en
// output is byte-identical to the pre-i18n hard-coded text (test/locales.test.ts
// pins it). Framework-neutral: locales.js has no react / DOM.
import { modelCountLabel, t, type LocaleId, type StringKey, type TArgs } from "./locales.js";

/** One fetched-catalog row as the curation rules see it (discovery view). */
export interface CurationCatalogModel {
  /** The wire id (the combobox's value). */
  id: string;
  /** The endpoint-supplied display name (combobox adornment only). */
  name?: string;
}

/**
 * The provider's committed model state as the curation rules see it:
 *
 * - `models` — the route's committed SERVED set (the explicit entry list,
 *   or `null` = FULL_CATALOG);
 * - `legacyOverrides` — the route's committed per-wire-id config map
 *   (meaningful only while FULL_CATALOG — the seed's config source);
 * - `catalog` — the fetched `/v1/models` catalog (discovered order): the
 *   Add-model combobox's full listing AND the FULL_CATALOG row universe /
 *   materialization seed.
 */
export interface CurationRouteState {
  models: readonly ModelEntry[] | null;
  legacyOverrides?: Record<string, unknown>;
  catalog: readonly CurationCatalogModel[];
}

/**
 * FULL_CATALOG → EXPLICIT materialization SEED (the spec's seed rule):
 * one entry per fetched-catalog model, in discovered order, each
 * `{ name: id, id, …legacyOverrides[id] }` — the per-wire-id config the
 * route already committed (whole entry, byte-preserved; the old cosmetic
 * `name` field dropped — the migration rule: the harness name defaults to
 * the wire id, stable). Malformed (non-string/empty) catalog ids are
 * skipped, never thrown.
 *
 * This seed is the FULL_CATALOG route's DIRTY BASELINE: an unedited seed
 * reads clean (a viewed-only FULL_CATALOG route stays
 * FULL_CATALOG and writes nothing).
 */
export function seedCatalogEntries(
  catalog: readonly CurationCatalogModel[],
  legacyOverrides: Record<string, unknown> | undefined,
): ModelEntry[] {
  const entries: ModelEntry[] = [];
  for (const model of catalog) {
    if (typeof model.id !== "string" || model.id.length === 0) continue;
    entries.push(entryFromLegacyId(model.id, legacyOverrides));
  }
  return entries;
}

/**
 * **ADD** — append the new entry to the draft list (pure; a NEW array). The
 * UI appends a blank row (`{ name: "", id: "" }`): an open row with no id
 * ships nothing (discarded at commit — {@link normalizeEntriesForWrite})
 * and reads clean, so a bare Add never dirties the card. Duplicate
 * WIRE ids are legal (variants: same `id`, distinct `name` / config); the
 * id auto-fill ({@link dedupeName}) gives a fresh row a FREE name for its
 * picked id, so the Add → pick-id flow never lands in a collision; a name
 * the user TYPES later is collision-checked at the Apply gate
 * ({@link resolveNameCollision}), not at append time (refusing mid-typing
 * would block the repair path).
 */
export function addModelEntry(entries: readonly ModelEntry[], entry: ModelEntry): ModelEntry[] {
  return [...entries, entry];
}

/**
 * **REMOVE** — delete the row at `index` (pure; list order kept). The SLOT is
 * the address, not the name: a row's name is a mutable label that may
 * transiently collide with a sibling's (a typed collision, or a legacy
 * committed duplicate), and name-keyed removal would delete EVERY same-named
 * row (the "locked rows" bug). Out-of-range index is a no-op (a copy).
 */
export function removeModelEntry(entries: readonly ModelEntry[], index: number): ModelEntry[] {
  if (index < 0 || index >= entries.length) return [...entries];
  return entries.filter((_, i) => i !== index);
}

/**
 * **EDIT name** — re-key the row at `index` to `to` (pure; every other row
 * untouched, list order kept). `to` empty, out-of-range index, or
 * `to === the row's current name` → a copy with no change.
 *
 * A collision with a SIBLING's name is NOT refused here: the draft may carry
 * a transient duplicate (the user is mid-typing, or repairing a committed
 * duplicate) — the UI surfaces it and the Apply gate blocks the commit until
 * it is resolved ({@link resolveNameCollision}). Refusing the edit at
 * keystroke time would make a committed duplicate un-repairable: every
 * keystroke toward a free name except the final one is a collision. Only the
 * TARGETED SLOT is touched — never every row that shares the old name.
 */
export function renameModelEntry(
  entries: readonly ModelEntry[],
  index: number,
  to: string,
): ModelEntry[] {
  const current = entries[index];
  if (current === undefined || to.length === 0 || to === current.name) return [...entries];
  return entries.map((entry, i) => (i === index ? { ...entry, name: to } : entry));
}

/**
 * **EDIT id / config** — mutate the row at `index`, overlaying the patch's
 * fields (the wire `id`, the canonical config fields, `defaultEffort`). The
 * row's harness `name` is LOCKED here (a name edit is a re-key — {@link
 * renameModelEntry}); a patch carrying `name` is ignored for identity
 * purposes. Out-of-range index is a no-op (a copy). Pure; only the targeted
 * row is copied.
 */
export function updateModelEntry(
  entries: readonly ModelEntry[],
  index: number,
  patch: Partial<ModelEntry>,
): ModelEntry[] {
  const current = entries[index];
  if (current === undefined) return [...entries];
  const { name: _ignored, ...rest } = patch;
  return entries.map((entry, i) =>
    i === index ? { ...entry, ...rest, name: entry.name } : entry,
  );
}

/**
 * The `name` UNIQUE-WITHIN-PROVIDER check (the UI surfaces a collision
 * inline): `true` when a row other than the one at `excludeIndex` (the row
 * being edited) already carries `name`. An empty `name` never collides
 * (empty rows are discarded, not committed).
 */
export function entryNameCollision(
  entries: readonly ModelEntry[],
  name: string,
  excludeIndex?: number,
): boolean {
  if (name.length === 0) return false;
  return entries.some((entry, i) => i !== excludeIndex && entry.name === name);
}

// Row addressing is by slot, not by name (module header; docs/design.md
// "Settings UI — row addressing") — commit-time name uniqueness is the
// separate gate ({@link resolveNameCollision}; src/dsh/settings.ts
// `assertServiceable`).

/**
 * One row's NORMALIZED name (the reader/writer rule, src/overrides.ts
 * `normalizeModelEntry`): a blank `name` reads as the wire `id` (the
 * harness identity falls back to the id). Empty when both are empty — such a
 * row is discarded at write and can never be the subject of a name
 * collision.
 */
function rowNameOf(entry: ModelEntry): string {
  const name = typeof entry.name === "string" ? entry.name : "";
  if (name.trim().length > 0) return name;
  return typeof entry.id === "string" ? entry.id.trim() : "";
}

/**
 * THE COMMITTED form of the draft list (the same discipline the readers
 * apply): the empty-`id` rows DISCARDED (an open Add row with no id picked
 * yet ships nothing) and a blank `name` DEFAULTED TO THE WIRE ID (the
 * reader's name rule — `name === id` when no name is supplied). Key order
 * inside an entry is untouched; an unchanged entry keeps its reference.
 */
export function normalizeEntriesForWrite(entries: readonly ModelEntry[]): ModelEntry[] {
  const out: ModelEntry[] = [];
  for (const e of entries) {
    const id = typeof e.id === "string" ? e.id.trim() : "";
    if (id.length === 0) continue;
    const name = typeof e.name === "string" && e.name.trim().length > 0 ? e.name : id;
    out.push(name === e.name && id === e.id ? e : { ...e, name, id });
  }
  return out;
}

/**
 * THE SLOT-ALIGNED committed form: {@link normalizeEntriesForWrite} with the
 * discarded rows preserved as `null` slots, so the card commit can map a
 * draft slot (a config draft / a pending reset keyed by row key) back to the
 * written entry — or `null`, when that row was discarded (empty id) and its
 * draft/reset simply does not land.
 */
export function slotNormalizedEntries(entries: readonly ModelEntry[]): (ModelEntry | null)[] {
  return entries.map((e) => {
    const id = typeof e.id === "string" ? e.id.trim() : "";
    if (id.length === 0) return null;
    const name = typeof e.name === "string" && e.name.trim().length > 0 ? e.name : id;
    return name === e.name && id === e.id ? e : { ...e, name, id };
  });
}

/**
 * Unique per-slot row keys for a draft row list (UI-only — never committed,
 * never part of the dirty check). Each key starts from the row's name at
 * seed time (card open / FULL_CATALOG materialization): when names are
 * unique (the common case) the key IS the name — so the unmaterialized
 * view, which keys its rows by their seed names, remounts NOTHING when the
 * first edit materializes the draft (the seed's {@link seedRowKeys} matches
 * the render keys exactly). The first occurrence of a duplicated name keeps
 * it; later occurrences get `-2`, `-3`, … until free; blank names get a
 * `row-N` slot token. The purpose is twofold:
 *
 * - React row keys stay UNIQUE even when a committed (legacy / hand-edited)
 *   route carries duplicate names — duplicated keys corrupt reconciliation
 *   and fuse the rows;
 * - every per-row draft state (config draft, pending reset, open detail)
 *   and every row operation addresses the key, so a colliding name cannot
 *   fuse two rows (the "locked rows" bug).
 *
 * Added rows get a FRESH `new-N` token (client-side) instead, so an add can
 * never collide with a name-keyed slot either.
 */
export function seedRowKeys(names: readonly string[]): string[] {
  const used = new Set<string>();
  return names.map((name, i) => {
    const base = name !== "" ? name : `row-${i}`;
    let key = base;
    let n = 2;
    while (used.has(key)) key = `${base}-${n++}`;
    used.add(key);
    return key;
  });
}

/**
 * The next free suffixed name for a colliding `base`: the smallest `n >= 2`
 * with `base-n` free against the list's normalized names (a blank-named row
 * is taken by its id). The UI's "Rename to …" offer.
 */
export function nextFreeName(entries: readonly ModelEntry[], base: string): string {
  const taken = new Set<string>();
  for (const entry of entries) {
    const n = rowNameOf(entry);
    if (n.length > 0) taken.add(n);
  }
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/**
 * The "free or suffixed" rule (the AUTO-FILL name for a row picking a wire
 * id): return `base` unchanged when it is FREE, else the smallest suffixed
 * name `base-2`, `base-3`, … that is free. "Free" is checked against the
 * EFFECTIVE names of the OTHER rows (a blank-named row is taken by its id;
 * the row at `excludeIndex` — the one being filled — is ignored, since its
 * current name is being replaced). So a fresh Add-model row that picks an
 * id whose name is already used gets the suffixed name instead of landing
 * in a collision. Pure: reads the list, never mutates.
 */
export function dedupeName(
  entries: readonly ModelEntry[],
  base: string,
  excludeIndex?: number,
): string {
  if (base.length === 0) return base;
  const taken = new Set<string>();
  entries.forEach((entry, i) => {
    if (i === excludeIndex) return;
    const n = rowNameOf(entry);
    if (n.length > 0) taken.add(n);
  });
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/** One collision rename: the former name and its replacement. */
export interface NameCollisionRename {
  /** The colliding name (every renamed row carried it). */
  from: string;
  /** The row's replacement name. */
  to: string;
}

/**
 * THE one-click name-collision fix (pure): find the FIRST normalized name
 * carried by two or more rows and rename the LATER occurrences — the first
 * occurrence keeps the name, the second gets {@link nextFreeName} (`-2`),
 * the third `-3`, and so on, each chosen against the list AS RENAMED (so a
 * pre-existing sibling `A-2` is skipped, not overwritten). List order is
 * kept, every other row is untouched, the input is never mutated.
 *
 * `renamed[0].to` is the suggestion the UI's "Rename to …" button shows; one
 * call clears every collision of the FIRST colliding name (a three-way
 * duplicate yields two renames). `null` when no name collides (rows whose
 * normalized name is empty never collide — they are discarded at write).
 */
export function resolveNameCollision(
  entries: readonly ModelEntry[],
): { entries: ModelEntry[]; renamed: NameCollisionRename[] } | null {
  const firstIndex = new Map<string, number>();
  let target: string | null = null;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry === undefined) continue;
    const name = rowNameOf(entry);
    if (name.length === 0) continue;
    if (firstIndex.has(name)) {
      if (target === null) target = name;
    } else {
      firstIndex.set(name, i);
    }
  }
  if (target === null) return null;
  const first = firstIndex.get(target);
  const out = [...entries];
  const renamed: NameCollisionRename[] = [];
  for (let i = 0; i < out.length; i++) {
    const entry = out[i];
    if (entry === undefined || i === first || rowNameOf(entry) !== target) continue;
    const to = nextFreeName(out, target);
    out[i] = { ...entry, name: to };
    renamed.push({ from: target, to });
  }
  return { entries: out, renamed };
}

/**
 * Canonical (key-order-insensitive) JSON of one draft/committed entry —
 * the deep-compare key: the phantom materialization (the resolved view's
 * `input: []` / `thinkingLevelMap: {}` / empty `compat.chatTemplateKwargs`)
 * is stripped from BOTH sides first, so an unedited draft seeded from the
 * committed (or the catalog seed) reads clean however the materialization
 * landed.
 */
function canonicalEntryJson(entry: Record<string, unknown>): string {
  const stripped = stripEntryPhantoms(entry);
  return JSON.stringify(stripped, (_key, value) =>
    isPlainObject(value)
      ? Object.keys(value)
          .sort()
          .reduce<Record<string, unknown>>((acc, k) => {
            acc[k] = value[k];
            return acc;
          }, {})
      : value,
  );
}

/**
 * THE DIRTY CHECK (generalized): the draft entry list (ordered) vs the
 * committed baseline entry list — dirty when the lengths differ or any
 * position's entries diverge (deep, phantom-tolerant via
 * {@link canonicalEntryJson}; ORDER-SENSITIVE — the row order is the user's
 * list state). A FULL_CATALOG baseline compares against its fetched-catalog
 * seed ({@link seedCatalogEntries}), so an unedited seed reads clean.
 */
export function entryListDirty(
  draft: readonly ModelEntry[],
  base: readonly ModelEntry[],
): boolean {
  if (draft.length !== base.length) return true;
  for (let i = 0; i < draft.length; i++) {
    const a = draft[i];
    const b = base[i];
    if (a === undefined || b === undefined) return true;
    if (
      canonicalEntryJson(a as unknown as Record<string, unknown>) !==
      canonicalEntryJson(b as unknown as Record<string, unknown>)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The status dot's wall-clock label: local 24h `HH:MM` (the spec's
 * "last checked 14:02" / "… · 14:05" suffixes).
 */
export function clockLabel(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** The success tooltip: "18 models · last checked 14:02". The count
 * noun is English-only plural (zh has no plural); the wording is the locale
 * bundle's `dotOk` (en byte-identical to the pre-i18n text). */
export function catalogOkDetail(locale: LocaleId, count: number, at: string): string {
  return t(locale, "dotOk", { countLabel: modelCountLabel(locale, count), at });
}

/**
 * The failure tooltip: the SPECIFIC problem from the discovery RPC's
 * error message, mapped onto the spec's wording, with the `HH:MM` suffix
 * (the timestamp is what makes a stale dot explicit):
 *
 * - "400 Bad Request from /v1/models · 14:05" (the node's `Server
 *   returned <status> <statusText>` message, body/hint stripped);
 * - "401 Unauthorized — set LLAMA_SWAP_API_KEY" (the 401 variant carries
 *   the provider's committed `apiKeyEnv`; no env var set → the plain
 *   status-text form);
 * - "Server unreachable (connection refused) · 13:58" (the node's
 *   `Cannot reach server` message — the client cannot distinguish
 *   refused from other network causes; the node surfaces the fetch
 *   failure as `fetch failed`);
 * - "Malformed response: …" (the node's invalid-JSON / missing-data-array
 *   messages).
 *
 * Anything unrecognized falls through as the raw message + suffix —
 * the dot must never render an empty detail.
 */
export function catalogErrorDetail(
  locale: LocaleId,
  message: string,
  apiKeyEnv: string | undefined,
  at: string,
): string {
  const m = message.trim();
  let key: StringKey;
  let args: TArgs;
  if (m.startsWith("Cannot reach server")) {
    key = "dotErrorUnreachable";
    args = { at };
  } else if (m.startsWith("Server returned 401")) {
    if (apiKeyEnv !== undefined && apiKeyEnv !== "") {
      key = "dotErrorUnauthorized";
      args = { apiKeyEnv, at };
    } else {
      key = "dotErrorUnauthorizedNoKey";
      args = { at };
    }
  } else {
    const status = m.match(/^Server returned (\d{3} [A-Za-z ]+)/);
    if (status !== null && status[1] !== undefined) {
      key = "dotErrorStatus";
      args = { status: status[1].trimEnd(), at };
    } else if (m.startsWith("Invalid JSON")) {
      key = "dotErrorMalformedJson";
      args = { at };
    } else if (m.startsWith("Unexpected /v1/models response")) {
      key = "dotErrorMalformedShape";
      args = { at };
    } else {
      key = "dotErrorRaw";
      args = { message: m, at };
    }
  }
  return t(locale, key, args);
}

// The per-model draft state the provider card's Apply commits: the
// row's `name` / `id` (the entry's identity — drafted on the entry list
// itself, {@link renameModelEntry} / {@link updateModelEntry}) and the
// draft-scoped Reset (the entry's configuration is released at the card's
// commit — nothing earlier — and the row stays served). The card's dirty
// gate is generalized to this draft state below.

/** The card's three route fields, as drafted and as committed. */
export interface CardFieldsDraft {
  name: string;
  baseURL: string;
  apiKeyEnv: string;
}

/**
 * The card's ROUTE-FIELD dirty gate (generalized): any of the three
 * provider fields diverges from the committed snapshot. (The card's checkmark
 * enables when this ORs the model-state gate, {@link cardModelDirty}.)
 */
export function cardFieldsDirty(draft: CardFieldsDraft, base: CardFieldsDraft): boolean {
  return (
    draft.name !== base.name ||
    draft.baseURL !== base.baseURL ||
    draft.apiKeyEnv !== base.apiKeyEnv
  );
}

/**
 * THE card dirty gate: the Apply button enables on the route fields
 * ({@link cardFieldsDirty}) OR the model state —
 *
 * - the draft entry list diverges from the committed baseline (deep,
 *   phantom-tolerant, ORDER-SENSITIVE — {@link entryListDirty}: a row
 *   add / remove / reorder / name-or-id-or-config edit reads dirty; the
 *   same list in the same order reads clean);
 * - ANY per-model config draft is dirty ({@link modelConfigDraftsDirty});
 * - ANY draft-scoped Reset is pending.
 *
 * A FULL_CATALOG route whose draft is not yet materialized
 * (`draftEntries === null`) has no entry-list change; when it IS
 * materialized (the first edit seeds it — {@link seedCatalogEntries}),
 * its baseline is that seed, so an unedited seed reads clean. (The
 * add-row state is gone — "Add model" appends
 * straight to the draft list; a pending row IS a divergent list.) Pure:
 * same inputs, same verdict.
 */
export function cardModelDirty(input: {
  /** The draft entry list — or `null` (a FULL_CATALOG route not yet materialized). */
  draftEntries: readonly ModelEntry[] | null;
  /** The baseline: the committed explicit list, or the catalog seed for a FULL_CATALOG baseline. */
  baseEntries: readonly ModelEntry[];
  configDrafts: Record<string, ModelConfigDraft>;
  pendingReset: readonly string[];
}): boolean {
  if (input.draftEntries !== null && entryListDirty(input.draftEntries, input.baseEntries)) return true;
  if (modelConfigDraftsDirty(input.configDrafts)) return true;
  if (input.pendingReset.length > 0) return true;
  return false;
}

/**
 * The detail config commit onto ONE EXPLICIT entry: the draft's
 * fields merged through the saveOverride discipline ({@link
 * mergeModelConfig} — entry as merge base, byte-preserved deep fields,
 * release-to-chain on cleared fields, explicit `input`, whole-block
 * `compat`, phantom guard) with the entry's IDENTITY
 * (`name` / `id` / `defaultEffort`) preserved over the merge.
 *
 * UNLIKE the map-level merge, a FULL RELEASE does not drop the entry:
 * an entry that normalizes to no configuration STILL SERVES its wire id
 * (presence in the list IS the served state) — the result is the
 * identity-only entry `{ name, id, …defaultEffort }`. Pure: a NEW entry,
 * the input is never mutated.
 */
export function applyConfigDraftToEntry(
  entry: Record<string, unknown> | null | undefined,
  draft: ModelConfigDraft,
  presetCompat: Record<string, unknown> | null,
): ModelEntry {
  const raw = isPlainObject(entry) ? entry : {};
  const name = typeof raw.name === "string" ? raw.name : "";
  const id = typeof raw.id === "string" ? raw.id : "";
  const merged = mergeModelConfig(raw, draft, undefined, presetCompat);
  if (merged !== undefined) {
    const out: Record<string, unknown> = { ...merged };
    out.name = name;
    out.id = id;
    if (typeof raw.defaultEffort === "string" && raw.defaultEffort.length > 0) {
      out.defaultEffort = raw.defaultEffort;
    }
    // The entry-world release: the merge's own phantom guard reads the
    // cosmetic `name` as content, but an EXPLICIT entry's harness name is
    // IDENTITY — a release must not let the identity keep a config-less
    // entry alive with its default `input: ["text"]` pin. If the merged
    // config (identity blanked) normalizes to nothing, the entry reduces
    // to its identity (+ defaultEffort) only — the entry-world equivalent
    // of the map entry being dropped.
    if (!entryMeaningful(out, "")) {
      const identity: Record<string, unknown> = { name, id };
      if (typeof raw.defaultEffort === "string" && raw.defaultEffort.length > 0) {
        identity.defaultEffort = raw.defaultEffort;
      }
      return identity as unknown as ModelEntry;
    }
    return out as unknown as ModelEntry;
  }
  // The merge released outright (a nameless malformed entry): identity only.
  const out: Record<string, unknown> = { name, id };
  if (typeof raw.defaultEffort === "string" && raw.defaultEffort.length > 0) {
    out.defaultEffort = raw.defaultEffort;
  }
  return out as unknown as ModelEntry;
}

/**
 * The card commit's per-map resolution for a FULL_CATALOG route:
 * apply the card's draft state to the route's committed `overrides` map
 * (the legacy per-wire-id config — whole entries pass through, never a
 * field-by-field reconstruction):
 *
 * 1. the PENDING RESETS delete their entries first (the row STAYS served
 *    — the FULL_CATALOG served set is the whole catalog; only the
 *    per-wire-id configuration is released, back to discovery/preset/
 *    defaults);
 * 2. then each DIRTY detail CONFIG draft merges its fields
 *    ({@link mergeModelConfig} — the saveOverride discipline).
 *
 * (An EXPLICIT route's config drafts commit onto the ENTRIES via
 * {@link applyConfigDraftToEntry} — this map-level function is the
 * FULL_CATALOG half.) A model pending a reset is reset, not merged (the
 * reset wins over the draft; the deletion is not undone by a re-created
 * entry). Clean (non-dirty) drafts are a no-op: a card whose only model
 * state is untouched draft fields writes the map byte-identically. Pure:
 * returns a NEW map, the input is never mutated.
 */
export function cardModelOverrides(
  committed: Record<string, unknown> | undefined,
  configDrafts: Record<string, ModelConfigDraft>,
  pendingReset: readonly string[],
  configSources: Record<string, ModelConfigSource>,
): Record<string, unknown> {
  let map: Record<string, unknown> = { ...(committed ?? {}) };
  for (const id of pendingReset) delete map[id];
  for (const [id, draft] of Object.entries(configDrafts)) {
    if (!modelConfigDraftDirty(draft) || pendingReset.includes(id)) continue;
    const source = configSources[id];
    const entry = mergeModelConfig(
      source !== undefined ? source.existing : null,
      draft,
      undefined,
      source !== undefined ? source.presetCompat : null,
    );
    if (entry === undefined) delete map[id];
    else map[id] = entry;
  }
  return map;
}

/**
 * The card commit's top-level half after the pending resets: the
 * section's legacy `overrides` map with the reset ids removed. The
 * removal must happen BEFORE the first-write fold (the per-row Reset's
 * existing discipline): a reset entry removed after the fold would be
 * re-folded into a provider's map and come back to life. Ownership:
 * the legacy top level sits under the `modelspoke:` section, so it is
 * modelspoke-owned too. Pure: returns a NEW map, the input is never
 * mutated; ids the map does not carry are a no-op.
 */
export function cardTopOverridesAfterReset(
  committed: Record<string, unknown>,
  pendingReset: readonly string[],
): Record<string, unknown> {
  const map: Record<string, unknown> = { ...committed };
  for (const id of pendingReset) delete map[id];
  return map;
}

// ("Model detail (chevron expanded)")
// makes the per-model detail the EDITABLE per-model configuration surface
// (the only one — the per-row Edit form and the Select-models picker are
// retired). The detail's controls (context window / max output tokens /
// the Capabilities group — the image-input flag + the reasoning-effort
// DIMENSION (unification: ON = the model has a `thinkingLevelMap`
// dimension; OFF = the nothink sentinel, the separate nothink checkbox is
// removed) — the Harness/Model map rows (shown only while the dimension is
// ON) / the per-model Default effort) draft the entry's fields in place —
// lazily seeded from the model's committed/effective baseline on the first
// edit — and the card's Apply commits them through the SAME saveOverride
// merge discipline
// the per-model form used: the whole EFFECTIVE entry as the merge base
// (byte-preservation by reference), the exposed fields replaced, the
// released fields deleted (release-to-chain), `input` declared explicitly
// on every write (the read_image capability mirror), `compat`
// materialized whole (the resolver's whole-block rule), and the phantom
// guard dropping entries that normalize to nothing. The draft state and
// the commit merge below are that surface's pure half.

/**
 * One `thinkingLevelMap` row (the detail's level × effort row editor).
 * `key` = a requestable level (incl. "off"); `value` = the level the model
 * accepts, or `""` for "not supported" (written as `null`).
 */
export interface TlRow {
  key: string;
  value: string;
}

/**
 * The committed/effective baseline of a detail config draft: the
 * field values seeded from the model's EFFECTIVE tier-1 entry (the
 * dual-shape merge, phantom-stripped) when the draft is first created
 * (lazily, on the detail's first edit). The preset is deliberately NOT
 * part of the baseline — a runtime tier, not committed state: a draft
 * seeded from it would read dirty on an untouched field and commit the
 * preset's values as the user's.
 */
export interface ModelConfigBaseline {
  /** `""` = the entry carries no contextWindow (released / unset). */
  contextWindow: string;
  /** `""` = the entry carries no maxTokens (released / unset). */
  maxTokens: string;
  /** The explicit `none` (nothink) declaration. */
  nothink: boolean;
  /** The entry's `thinkingLevelMap` rows (empty while nothink / unset). */
  tlRows: TlRow[];
  /** `input` declares image. */
  imageInput: boolean;
  /** `compat.supportsReasoningEffort` is `true` (absent / false = unset). */
  reasoningEffort: boolean;
}

/**
 * One model's detail config draft: the field set the detail exposes
 * (mirroring the retired OverrideDraft's editable fields), plus the
 * baseline it is dirty-tracked against (the card's
 * checkmark enables on divergence from it, Cancel discards the draft).
 * The client creates the draft LAZILY on the detail's first edit; a model
 * with no draft shows its committed effective values and commits nothing.
 */
export interface ModelConfigDraft extends ModelConfigBaseline {
  /** The committed/effective values at first edit — the dirty baseline. */
  base: ModelConfigBaseline;
}

/**
 * Semantic number equality for the two token fields: equal when both trim
 * to the same string, or both parse to the SAME integral number (a
 * re-typed "262144" or a "1024" / "1024.0" pair reads clean — the dirty
 * check must not keep the checkmark enabled on a no-op re-type). An empty
 * value equals only an empty value (clearing a field is a release —
 * always a change from a set one); an unparseable value equals nothing
 * (it stays dirty until corrected — the commit validates it).
 */
function sameTokenField(a: string, b: string): boolean {
  const ta = a.trim();
  const tb = b.trim();
  if (ta === tb) return true;
  if (ta === "" || tb === "") return false;
  const na = Number(ta);
  const nb = Number(tb);
  return Number.isInteger(na) && Number.isInteger(nb) && na === nb;
}

/**
 * The thinking-level rows compared as a MAP — row order is UI state, not
 * content (the stored field is an object): equal key set, each key's value
 * equal ("not supported" normalizes across the "" / null spellings).
 */
function sameTlRows(a: readonly TlRow[], b: readonly TlRow[]): boolean {
  const norm = (rows: readonly TlRow[]): Map<string, string | null> =>
    new Map(rows.map((row) => [row.key, row.value === "" ? null : row.value]));
  const am = norm(a);
  const bm = norm(b);
  if (am.size !== bm.size) return false;
  for (const [key, value] of am) {
    if (!bm.has(key) || bm.get(key) !== value) return false;
  }
  return true;
}

/**
 * The config draft's dirty gate: any detail field diverging from the
 * seeded baseline (same discipline as {@link entryListDirty}: semantic
 * compare, so a no-op re-type re-disables the checkmark).
 */
export function modelConfigDraftDirty(draft: ModelConfigDraft): boolean {
  return (
    !sameTokenField(draft.contextWindow, draft.base.contextWindow) ||
    !sameTokenField(draft.maxTokens, draft.base.maxTokens) ||
    draft.nothink !== draft.base.nothink ||
    !sameTlRows(draft.tlRows, draft.base.tlRows) ||
    draft.imageInput !== draft.base.imageInput ||
    draft.reasoningEffort !== draft.base.reasoningEffort
  );
}

/** Any of the card's config drafts is dirty. */
export function modelConfigDraftsDirty(
  configDrafts: Record<string, ModelConfigDraft>,
): boolean {
  return Object.values(configDrafts).some(modelConfigDraftDirty);
}

/**
 * The commit-time source of one model's config merge: the model's
 * EFFECTIVE tier-1 entry (the dual-shape merge, phantom-stripped — the
 * merge base, the retired form's `existing`) and the matched preset's
 * `compat` object (the whole-block materializer, the form's
 * `presetCompat`). The client seeds this for EVERY id with a dirty
 * config draft (a dirty id without a source reads as a fresh entry —
 * the caller invariant the unit tests exercise).
 */
export interface ModelConfigSource {
  existing: Record<string, unknown> | null;
  presetCompat: Record<string, unknown> | null;
}

/**
 * The detail's config commit merge (THE saveOverride discipline,
 * ported whole): merge the draft's fields into the model's EFFECTIVE
 * tier-1 entry, byte-preserving:
 *
 * - the entry starts as a shallow copy of the WHOLE effective entry —
 *   every preserved field (`reasoning`, the deep `compat` block incl.
 *   the `chatTemplateKwargs` `$var` bindings, any schema-unnamed field)
 *   survives by reference (never a field-by-field reconstruction);
 * - the exposed fields are replaced with the draft's values; a CLEARED
 *   field is DELETED (released back down the resolution chain —
 *   discovery can still beat the preset at runtime for it);
 * - `name` is merged ONLY when `name` is defined (the model's
 *   display-name draft is dirty); `undefined` = the name field is not
 *   touched by this merge;
 * - `nothink` writes the `thinkingLevelMap: "none"` sentinel; rows write
 *   the map (`""` → `null`); no rows release the field;
 * - `input` is declared EXPLICITLY on every merge (`inputModalities` —
 *   `["text"]` pins text-only, the read_image capability mirror; `[]` is
 *   never written);
 * - `compat` follows the WHOLE-BLOCK rule (`compatForWrite` — the deep
 *   template fields materialized next to the explicit pin; `undefined` =
 *   the key is omitted, the field released);
 * - the PHANTOM GUARD: a merged entry that normalizes to nothing (the
 *   saveOverride empty-entry rule, read over the WRITTEN entry — the
 *   form's guard was read over the form's displayed state, the same
 *   shape once the entry IS the draft) is returned as `undefined`: the
 *   caller DROPS the entry. Clearing every field of a configured model
 *   is thus a full release to the chain (the Reset's effect) — the
 *   entry's only surviving content would be the text-only `input`
 *   declaration, which is the default, not state.
 *
 * Caller invariants (the client validates before commit): non-empty
 * `contextWindow` / `maxTokens` parse to positive whole numbers, and the
 * `tlRows` keys are unique (the detail's row editor refuses duplicates
 * inline). Pure: the inputs are never mutated.
 */
export function mergeModelConfig(
  existing: Record<string, unknown> | null,
  draft: ModelConfigDraft,
  name: string | undefined,
  presetCompat: Record<string, unknown> | null,
): Record<string, unknown> | undefined {
  const entry: Record<string, unknown> = { ...(existing ?? {}) };
  if (name !== undefined) {
    if (name !== "") entry.name = name;
    else delete entry.name;
  }
  const contextWindow = draft.contextWindow.trim();
  if (contextWindow !== "") entry.contextWindow = Number(contextWindow);
  else delete entry.contextWindow;
  const maxTokens = draft.maxTokens.trim();
  if (maxTokens !== "") entry.maxTokens = Number(maxTokens);
  else delete entry.maxTokens;
  if (draft.nothink) {
    entry.thinkingLevelMap = NO_THINKING_LEVELS;
  } else if (draft.tlRows.length > 0) {
    entry.thinkingLevelMap = Object.fromEntries(
      draft.tlRows.map((row) => [row.key, row.value === "" ? null : row.value] as [string, string | null]),
    );
  } else {
    delete entry.thinkingLevelMap;
  }
  entry.input = inputModalities(draft.imageInput);
  const compat = compatForWrite(existing, presetCompat, draft.reasoningEffort);
  if (compat === undefined) delete entry.compat;
  else entry.compat = compat;
  return mergedEntryMeaningful(entry) ? entry : undefined;
}

/**
 * Whether the detail's config commit merge RELEASES the model's
 * entry ({@link mergeModelConfig} returning `undefined` — the phantom
 * guard). The caller must then drop the id from BOTH override maps — the
 * provider's own AND the legacy top level, BEFORE the fold (the
 * pending-reset discipline: a legacy entry left in place is re-folded
 * into a provider's map and comes back to life, silently undoing the
 * user's release). `name` carries the dirty display-name draft's value
 * when one exists (a dirty name keeps an otherwise-empty entry alive).
 */
export function configDraftReleasesEntry(
  draft: ModelConfigDraft,
  source: ModelConfigSource | undefined,
  name: string | undefined,
): boolean {
  return (
    mergeModelConfig(
      source !== undefined ? source.existing : null,
      draft,
      name,
      source !== undefined ? source.presetCompat : null,
    ) === undefined
  );
}

/**
 * The saveOverride `overrideEntryMeaningful` empty-entry rule, read over a
 * WRITTEN entry (every fact is the entry's own field, and the image-input
 * fact is the written `input` pin — an image declaration is real state, a
 * text-only one is the default and counts for nothing). `name` is the
 * harness identity fact: a MAP entry (no identity) reads it from the
 * cosmetic `name` field; an EXPLICIT entry's harness name is IDENTITY, not
 * configuration, so it is passed as `""` when testing the entry's CONFIG
 * ({@link applyConfigDraftToEntry}'s release rule).
 */
function entryMeaningful(entry: Record<string, unknown>, name: string): boolean {
  return overrideEntryMeaningful({
    name,
    contextWindow: typeof entry.contextWindow === "number" ? String(entry.contextWindow) : "",
    maxTokens: typeof entry.maxTokens === "number" ? String(entry.maxTokens) : "",
    tlRowCount: isPlainObject(entry.thinkingLevelMap)
      ? Object.keys(entry.thinkingLevelMap).length
      : 0,
    nothink: entry.thinkingLevelMap === NO_THINKING_LEVELS,
    compat: isPlainObject(entry.compat) ? (entry.compat as Record<string, unknown>) : undefined,
    imageInputToggled:
      Array.isArray(entry.input) && (entry.input as readonly unknown[]).includes("image"),
  });
}

/** The map-entry form: the cosmetic `name` counts as content. */
function mergedEntryMeaningful(entry: Record<string, unknown>): boolean {
  return entryMeaningful(entry, typeof entry.name === "string" ? entry.name : "");
}

/**
 * The detail's "preserved from settings.yaml" line (moved here from
 * the client: the detail is the surface it feeds, and the pure module is
 * the unit-tested home). The compact read-only summary of the entry's
 * fields the detail does NOT expose as controls: `reasoning` (named), the
 * deep `compat` block — `supportsDeveloperRole`, `thinkingFormat`,
 * `chatTemplateKwargs`, … — listed only when it carries keys other than
 * `supportsReasoningEffort` (an sre-only compat is fully form-managed),
 * plus any field the schema does not name. The four editable fields,
 * `input` (the image-input checkbox) and `reasoning` are excluded above;
 * the `supportsReasoningEffort` pin (the reasoning-effort checkbox) is
 * excluded in the deep-compat test. Null entry / nothing to show → null.
 */
const EDITABLE_FIELDS = ["name", "contextWindow", "maxTokens", "thinkingLevelMap"] as const;

export function preservedSummary(
  locale: LocaleId,
  entry: Record<string, unknown> | null,
): string | null {
  if (entry === null) return null;
  const parts: string[] = [];
  if (typeof entry.reasoning === "boolean") {
    parts.push(t(locale, entry.reasoning ? "preservedReasoningOn" : "preservedReasoningOff"));
  }
  const compat = isPlainObject(entry.compat) ? entry.compat : undefined;
  const deepCompat =
    compat !== undefined && Object.keys(compat).some((key) => key !== "supportsReasoningEffort");
  const deep = Object.keys(entry).filter(
    (key) =>
      !(EDITABLE_FIELDS as readonly string[]).includes(key) &&
      key !== "input" &&
      key !== "reasoning" &&
      (key !== "compat" || deepCompat),
  );
  if (deep.length > 0) {
    parts.push(t(locale, "preservedDeepFields", { keys: deep.join(", ") }));
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

// Roadmap item "Orphaned-override cleanup": deleting a provider route
// folds its UNCLAIMED per-model overrides to the section's legacy
// top-level `overrides` map (src/overrides.ts — the delete's survivor
// rule), and the resolver's tier-1 read (effectiveOverrideEntry: route
// entry over legacy top level, per-field route-wins) still reads the top
// level on EVERY route. Before this the top level had no user-facing
// removal path — the entries accumulated forever (the vision E2E cleanup
// had to restore them from a snapshot). The section's "top-level
// overrides" block (rendered only while the map is non-empty) is the
// removal path; these two rules are its pure half:
//
// - {@link classifyTopOverrides} — one row per top-level entry, with the
//   claiming providers: a top-level entry is CLAIMED when at least one
//   provider route carries its OWN entry for the id (`routes[].overrides`
//   — for that route the top-level entry is shadowed, per-field route-
//   wins), ORPHANED when none does. Only an orphaned row is deletable:
//   deleting a CLAIMED entry changes behavior for every OTHER route that
//   still inherits it, which is a route-scoped judgment the provider
//   card (the per-model detail's Reset) is the right place for — the
//   claimed row names its claimant(s) instead of offering the Delete.
// - {@link removeTopOverrideEntry} — the commit's top-level half merge
//   (the saveOverride discipline at map level): the key removed, every
//   OTHER entry byte-preserved by reference (never a field-by-field
//   reconstruction — the deep `compat` `$var` bindings travel
//   untouched), the empty result signaled as `undefined` = OMIT the
//   `overrides` key (the section's omit-empty rule — never leave an
//   empty map behind). The routes half is not this function's input: the
//   client's top-level-only commit passes the snapshot's routes through
//   unwritten (byte-preserved), so the deletion cannot disturb it.

/**
 * One row of the section's top-level-overrides block: the entry's id, its
 * display `name` (when the entry carries a non-empty string one —
 * rendered beside the id), the entry's SET field names minus `name`
 * (entry order — the row's compact summary; the detail's
 * {@link preservedSummary} fact list is the per-model surface's and too
 * long here), and the CLAIMING provider names (configuration order —
 * empty = orphaned, the deletable rows).
 */
export interface TopOverrideRow {
  /** The top-level entry's model id. */
  id: string;
  /** The entry's display name (absent/empty entry `name` → null). */
  displayName: string | null;
  /** The entry's set field names, entry order, `name` excluded. */
  fields: string[];
  /** The providers with their OWN entry for the id (empty = orphaned). */
  claiming: string[];
}

/**
 * THE CLASSIFICATION (PURE): one {@link TopOverrideRow} per top-level
 * entry, in the map's key order. An entry is claimed when at least one
 * route carries its own entry for the id — `id in` the route's
 * phantom-stripped `overrides` map (the delete-provider survivor rule's
 * own claim idiom: a route's own entry, even a malformed one, makes the
 * top-level entry's fate a route-scoped judgment — conservative: the
 * Delete is offered only when NO route carries the id at all).
 * Dual-shape aware by construction: an entry that exists BOTH top-level
 * and in a route's map is claimed (the route copy shadows it there), and
 * a top-level-only entry is orphaned exactly when no route map carries
 * the id. Lenient: a malformed (non-object) top-level entry yields a row
 * with `displayName` null and no fields (it still renders — the id + the
 * Delete, when orphaned). Pure: the inputs are never mutated.
 */
export function classifyTopOverrides(
  top: Record<string, unknown>,
  routes: ReadonlyArray<{ name: string; overrides?: Record<string, unknown> }>,
): TopOverrideRow[] {
  return Object.entries(top).map(([id, entry]) => {
    const claiming: string[] = [];
    for (const route of routes) {
      if (route.overrides !== undefined && id in route.overrides) claiming.push(route.name);
    }
    const e = isPlainObject(entry) ? entry : null;
    const displayName =
      e !== null && typeof e.name === "string" && e.name.trim() !== "" ? e.name : null;
    const fields = e !== null ? Object.keys(e).filter((key) => key !== "name") : [];
    return { id, displayName, fields, claiming };
  });
}

/**
 * THE TOP-LEVEL DELETION MERGE (PURE): the section commit's top-level
 * half after the user deletes ONE orphaned entry — the committed
 * `overrides` map with `modelId` removed:
 *
 * - EVERY OTHER entry is preserved BY REFERENCE (the map is shallow-
 *   copied, the surviving entries are never re-created — a deep `compat`
 *   block with `chatTemplateKwargs` `$var` bindings survives
 *   byte-identically, never a field-by-field reconstruction);
 * - the input is never mutated;
 * - the result is `undefined` (= OMIT the `overrides` key — the
 *   section's omit-empty rule, the `scope.unset` the writer runs) when
 *   the deletion empties the map: never an empty `{}`;
 * - deleting an id the map does not carry is a no-op (a new map, the
 *   same entries — a defensive guard against a stale row; from an empty
 *   map it is `undefined`, the same omit signal).
 */
export function removeTopOverrideEntry(
  committed: Record<string, unknown>,
  modelId: string,
): Record<string, unknown> | undefined {
  const map: Record<string, unknown> = { ...committed };
  delete map[modelId];
  return Object.keys(map).length > 0 ? map : undefined;
}
