/**
 * modelspoke canonical contract — the shared shape every tier speaks.
 *
 * The canonical shape is pi-ai's `Model` fields, verbatim (docs/design.md,
 * "Shared core + the dsh adapter"). dsh bottoms out in
 * `@earendil-works/pi-ai`, so the core speaks pi-ai's vocabulary directly and
 * the dsh adapter translates.
 *
 * A preset (and an override entry) is preset identity plus a PARTIAL pi-ai
 * `Model`. A resolved model is the FULL canonical object: `input` is always
 * present (default `["text"]` — pi-ai's `Model.input` is required), `reasoning`
 * always present (default `false`), `compat` always present (default basic).
 * `contextWindow`/`maxTokens` are omitted when no tier supplied them; the
 * per-field source map marks them `"default"` in that case (the default tier
 * does not invent capacities — see design). `thinkingLevelMap` is omitted the
 * same way — EXCEPT the explicit-none (nothink) state, spelled PRESENT-EMPTY
 * (`{}`) on the resolved object: a tier-1 declaration that the endpoint's copy
 * has no selectable levels (co-occurs with `reasoning: false`; both fields
 * sourced `user`).
 *
 * `thinkingLevelMap` is pi-ai's RAW form: `null` marks a level unsupported,
 * non-null selectable. The CANONICAL SPELLING drops null entries — presets and
 * overrides simply omit unsupported levels; nulls are stripped at every
 * tier→canonical boundary (`canonicalizeThinkingLevelMap`).
 *
 * `compat` is pi-ai's `OpenAICompletionsCompat` verbatim. `thinkingFormat`
 * lives INSIDE `compat` (that is where pi-ai puts it); there is no top-level
 * `thinkingFormat`.
 *
 * Wire types for `GET /v1/models` (basic OpenAI shape + the llama-swap
 * `meta.llamaswap` extension) are re-exported below from `./discovery/types.js`
 * (the verbatim port of pi-llama-swap `lib/types.ts` — pi-llama-swap-port.md §1.3, in jj history).
 */

import type {
  OpenAICompletionsCompat,
  ThinkingLevelMap as PiThinkingLevelMap,
} from "@earendil-works/pi-ai";
import type { LlamaSwapMeta } from "./discovery/types.js";

export type {
  LlamaSwapMeta,
  ModelArchitecture,
  ModelCapabilities,
  ModelMeta,
  ModelStatus,
  OpenAIModelEntry,
  OpenAIModelsListResponse,
} from "./discovery/types.js";

/**
 * pi-ai's `Model.input` is `("text" | "image")[]`; the package exports no name
 * for the element type, so it is defined structurally here (noted per build
 * contract: structural local type when pi-ai exports none by name).
 */
export type ModelModality = "text" | "image";

/** pi-ai OpenAI-completions compat block, verbatim. */
export type Compat = OpenAICompletionsCompat;

/**
 * pi-ai raw thinking-level map: pi levels (`off` + minimal..max) →
 * provider/model-specific value, or `null` = level unsupported.
 */
export type ThinkingLevelMap = PiThinkingLevelMap;

/** The reasoning/capacity fields modelspoke resolves, per model. */
export interface CanonicalModelFields {
  /** Input modalities. Canonical order: text first. Always present on a resolved model. */
  input?: ModelModality[];
  /** Whether the model supports extended thinking. */
  reasoning?: boolean;
  /** Context window in tokens. */
  contextWindow?: number;
  /** Maximum output tokens. */
  maxTokens?: number;
  /**
   * Selectable levels only (canonical spelling — no null entries). On the
   * RESOLVED object: PRESENT-EMPTY (`{}`) is the explicit-none (nothink)
   * state — a tier-1 declaration that the endpoint's copy has no selectable
   * levels (it co-occurs with `reasoning: false` from the same declaration;
   * the value is inert downstream). ABSENT = no tier supplied levels.
   */
  thinkingLevelMap?: ThinkingLevelMap;
  /** OpenAI-completions compat (incl. `thinkingFormat` + `chatTemplateKwargs`). */
  compat?: Compat;
}

/** The fields the four-tier resolver merges, per field. */
export type CanonicalField = keyof CanonicalModelFields;

/**
 * A bundled preset: identity + partial pi-ai `Model`.
 *
 * `match` is tested against the model id as an UNANCHORED, case-insensitive
 * regular expression — for literal patterns this is exactly a
 * case-insensitive substring test; the regex form is what lets
 * `qwen3[._-]?8` cover the Qwen3.8 family spellings (`.`, `_`, `-`, none).
 *
 * Presets carry NO display name: a family-level preset would give every
 * matching model the same picker name. Display name = discovery's `name` when
 * the endpoint supplies one, else the model `id`; per-model cosmetics are an
 * override entry's job (`OverrideEntry.name`).
 */
export interface Preset extends CanonicalModelFields {
  /** Stable preset id; reported as `preset:<id>` in the per-field source map. */
  id: string;
  /** Case-insensitive unanchored regex matched against the model id. */
  match: string;
  /** Authoring provenance / rationale (template verified, effort vocabulary…). */
  notes?: string;
}

/**
 * A user override entry: canonical fields + optional display `name`.
 * Keyed by EXACT model id in the `modelspoke:` settings namespace — no
 * pattern matching.
 */
export interface OverrideEntry extends CanonicalModelFields {
  /** Display-name cosmetics only; never resolved into the canonical object. */
  name?: string;
  /**
   * Per-model default effort (dsh-only) — the per-route override home for
   * FULL_CATALOG routes (EXPLICIT entries carry their own field). Stripped
   * at the canonical boundary; read RAW by the dsh adapter.
   */
  defaultEffort?: string;
}

/**
 * One served model of an EXPLICIT route (`name` is the harness
 * identity, `id` the wire id).
 *
 * - `name` — the harness model key: what the dsh model selector keys on,
 *   what `resolveModel` receives, and the per-model config's key. UNIQUE
 *   within the provider (the UI enforces; a collision is refused inline).
 *   A missing/blank `name` DEFAULTS TO THE WIRE `id` (harness-id stability:
 *   existing sessions reference models by the wire id, which stays the key).
 * - `id` — the WIRE id the endpoint recognizes: sent on the request, and
 *   the key discovery + presets match on (resolution indexes discovery by
 *   it). DUPLICATES ARE ALLOWED (variants): the same wire id under
 *   different `name`s offers the same model with different option sets —
 *   each variant resolves independently.
 * - `defaultEffort` — per-model default reasoning effort (dsh-only):
 *   the model's default when the host names no effort — second in the
 *   pi-parity chain after the per-request effort, clamped to the model's
 *   offered levels (pi-ai's `clampThinkingLevel`). The pi host has no
 *   such field and ignores it.
 *
 * Canonical fields are optional (a `{ name, id }` entry serves the wire id
 * with no user configuration — presence in the list IS the served state).
 * The in-memory entry passes through RAW (whole object, never a
 * field-by-field reconstruction): canonicalization happens at the
 * tier→canonical boundary, the phantom inverse at the writers
 * (src/overrides.ts).
 */
export interface ModelEntry extends CanonicalModelFields {
  /** Harness identity; unique within the provider; also the display. */
  name: string;
  /** Wire id (sent to the provider; discovery/preset match key). */
  id: string;
  /** Per-model default effort (dsh-only; second in the pi-parity chain, clamped to the offered levels). */
  defaultEffort?: string;
}

/**
 * Which tier supplied a field: `user` (tier 1), `discovery` (tier 2,
 * `meta.llamaswap`), `preset:<id>` (tier 3, bundled catalog), `default`
 * (tier 4).
 */
export type FieldSource = "user" | "discovery" | `preset:${string}` | "default";

/** Per-field source map — the attribution contract (log line + description suffix). */
export type FieldSourceMap = Record<CanonicalField, FieldSource>;

/**
 * The resolved model: full canonical object. `input`/`reasoning`/`compat` are
 * always present (defaults: `["text"]`, `false`, basic compat); the rest are
 * present only when a tier supplied them.
 */
export interface ResolvedModel extends CanonicalModelFields {
  input: ModelModality[];
  reasoning: boolean;
  compat: Compat;
}

export interface ResolutionResult {
  resolved: ResolvedModel;
  /** Which tier supplied each field (`user` | `discovery` | `preset:<id>` | `default`). */
  sources: FieldSourceMap;
  /**
   * `true` when tier 1 declared EXPLICIT NONE (`thinkingLevelMap:
   * "none"` — the nothink case): the model serves without a reasoning
   * dimension (`reasoning: false`, no levels — both fields sourced `user`).
   * Absent/false = ordinary resolution (the resolve log reports the marker).
   */
  nothink?: boolean;
}

/**
 * Per-model discovery output (the advisory catalog entry and the tier-2 input
 * to the resolver).
 */
export interface DiscoveryModelInfo {
  id: string;
  /**
   * Display name the endpoint supplied (`meta.llamaswap.name` → top-level
   * `name`). `undefined` when the server supplied none — the consumer falls
   * back to `id` (presets carry no display names).
   */
  name?: string;
  /**
   * Canonical fields actually discovered from this entry. `undefined` when the
   * server advertised nothing (bare llama-server/vLLM/sglang entries) — the
   * resolver then falls through to preset/default per field.
   */
  discoveredCanonical?: CanonicalModelFields;
  /** Raw `meta.llamaswap` block, for diagnostics/logging. */
  rawMeta?: LlamaSwapMeta;
}

/**
 * A modelspoke route — the UI's "provider" (what the settings page calls
 * a provider IS one entry of the `routes:` array; the yaml key stays
 * `routes:`). The route carries NO default effort — the reasoning default is
 * per model (an EXPLICIT entry's own `defaultEffort`); nothing set = the
 * server's native default.
 *
 * `models`: the route's SERVED SET, normalized by the lenient reader
 * (src/overrides.ts `decodeRouteModels`):
 * - `models: ModelEntry[]` (possibly empty) — the EXPLICIT served set: one
 *   entry per `{ name, id, …config }`. Presence in the list IS the served
 *   state (the allow-list filter is retired — there is no longer a
 *   "filter on the catalog" state to express; an entry may name a wire id
 *   the endpoint does not currently serve, and it is offered anyway).
 * - `models: null` — FULL_CATALOG: serve the whole discovered endpoint
 *   catalog. `legacyOverrides` then carries the per-wire-id config (the old
 *   `routes[].overrides` map, passed through raw).
 *
 * A legacy string allow-list (`models` of ids) is NOT a supported stored
 * form: the reader degrades it to FULL_CATALOG, and the write gate refuses
 * it. Harness-id stability: a hand-added entry's `name` defaults to the wire
 * `id` (existing sessions keep their key).
 */
export interface ModelspokeRoute {
  /** User-chosen route key (the migration keeps the name `llama-swap`). */
  name: string;
  /** OpenAI API base URL; normalized to end in `/v1`. */
  baseURL: string;
  /** Env var name holding the Bearer key; Bearer sent only when set. */
  apiKeyEnv?: string;
  /**
   * The route's served set: the EXPLICIT entry list, or `null` =
   * FULL_CATALOG (serve the whole endpoint catalog). The lenient reader
   * always sets it (array or null); the two writers keep the stored shape
   * byte-stable (src/overrides.ts `storeRoute`).
   */
  models: ModelEntry[] | null;
  /**
   * The per-wire-id config map (stored under the route's `overrides` key)
   * exact wire id → the override entry (canonical fields + optional
   * cosmetic `name` + preserved deep fields). Meaningful ONLY when
   * `models === null` (FULL_CATALOG): tier 1 of the four-tier chain for
   * the catalog models, PER FIELD over the legacy top-level `overrides`
   * map (route wins; the legacy map stays a read-compatible fallback until
   * the first section write folds it in — src/overrides.ts). Raw by
   * design: the reader passes the map through (never a field-by-field
   * reconstruction); canonicalization happens at the tier→canonical
   * boundary. For EXPLICIT routes the per-model config lives IN THE
   * ENTRIES and this map is not consulted.
   */
  legacyOverrides?: Record<string, unknown>;
}

/**
 * The plugin-owned `modelspoke:` settings namespace: the `modelspoke:`
 * section of `~/.dsh/settings.yaml`.
 *
 * DUAL SHAPE: per-model configuration lives PER ROUTE —
 * `routes[].overrides` (see {@link ModelspokeRoute.legacyOverrides}) — and the
 * top-level `overrides` map is the LEGACY location, still readable during
 * the transition (a section may carry both; per-field the route entry wins;
 * the first section write folds the top level into the owning route's map
 * and stops writing the key — src/overrides.ts).
 */
export interface ModelspokeSettings {
  routes?: ModelspokeRoute[];
  /** LEGACY per-model override location — see the module docblock. */
  overrides?: Record<string, OverrideEntry>;
}
