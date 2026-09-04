/**
 * The LM Studio native `/api/v1/*` tier-2 discovery backend
 * (docs/provider-details.md §3.6 [verified-web]).
 *
 * WHY: an LM Studio provider's OpenAI-compat `/v1/models` is bare (docs show
 * no extra fields) — the generic extractor yields nothing. LM Studio's v1
 * REST surface (0.4.0+; the legacy v0 `/api/v0/*` generation carries NO
 * capabilities object at all) is the ONLY local server in the sweep that
 * publishes an enumerated reasoning-effort list over an API:
 * `capabilities.reasoning.allowed_options` (`("off"|"on"|"low"|"medium"|
 * "high")[]` + `default`) — plus `capabilities.vision` and the two-layer
 * context split (`loaded_instances[].config.context_length` as-loaded over
 * `max_context_length` model max — the JIT-default trap: a JIT-loaded model
 * may run at a small default ctx).
 *
 * Shape (the Ollama-discovery discipline — metadata path only): this module holds the
 * probe + the pure mappers and imports NOTHING from the channel; the channel
 * (src/dsh/channel.ts) is backend-agnostic (C2) — it probes the registry
 * and asks the matched backend's `metadataRows` to enrich the catalog rows.
 *
 * Detection (C10): `GET {origin}/api/v1/models` (origin = the normalized
 * route base minus the trailing `/v1` — {@link lmstudioOrigin}, the §3 twin
 * of the Ollama backend's `ollamaOrigin`). The route's apiKey rides the request (C7 — v1
 * API tokens are off by default, but when on, the key must be sent). Match =
 * 200 whose body is `{ models: [ { key: <string>, … } ] }` — an array with
 * at least one element carrying a string `key` (the LM Studio v1 list wraps
 * in `models`, unlike OpenAI's `data`; the keyed element is the dialect
 * marker, so an element-less `models` array cannot confirm it — a definitive
 * non-match, moot behaviorally: there is nothing to join either way).
 * 404/405 (pre-0.4.0 servers, v0-only) and 401 (a well-formed non-answer,
 * C10) are DEFINITIVE non-matches — those servers degrade to generic rows,
 * the accepted trade-off (v0 has no capabilities object anyway). Network
 * failure / 5xx / any other status / abort → INCONCLUSIVE (not evidence; the
 * channel's memo evicts and retries). `ctx.entries` carries no LM Studio
 * marker (the OpenAI surface is bare), so there is no catalog-first path —
 * the probe is the one request. Never throws.
 *
 * Enrichment (the SAME single response, zero extra fetches):
 * the DETECTION response is cached in the verdict's `facts` (key `models`,
 * the raw parsed element array) and {@link lmstudioBackend.metadataRows}
 * joins it by `key === entry.id` WITHOUT re-fetching — one fetch total for
 * detect + enrich through the channel. A `metadataRows` call whose `facts`
 * carries no usable cache (a direct call without a detect verdict — not the
 * channel's path) re-fetches the same URL ONCE, fail-soft. A catalog id with
 * no matching model element keeps its generic row (absent from `byId`); a
 * malformed per-model element cannot be joined (no string `key`) and stays
 * generic too.
 *
 * The locked mapping — per model element, fail-soft per field:
 *
 * - `reasoning: true` ⟺ `capabilities.reasoning` is an object with a
 *   non-empty `allowed_options` array (the server's own enumeration is the
 *   accept/reject gate — the same discipline as the Ollama backend's capability check).
 * - `thinkingLevelMap` ← built ONLY from `allowed_options`. The vocabulary
 *   is LM Studio's `("off"|"on"|"low"|"medium"|"high")[]`; the map is keyed
 *   in pi-ai's harness vocabulary (`off|minimal|low|medium|high|xhigh|max`),
 *   `null` marking a level the server does not list (pi-ai clamps
 *   client-side): 1:1 for `low`/`medium`/`high` when listed; `off: "off"`
 *   when `"off"` is listed; `"on"` is the model's default-on MARKER and maps
 *   to NO harness level (there is no harness level meaning "thinking on" —
 *   enabling falls back to the server default); every other harness level →
 *   `null` (explicitly, so pi-ai's `getSupportedThinkingLevels` excludes
 *   them). A map that supports no on-level (e.g. options `["off","on"]` only
 *   — the documented gemma-4 dialect) is emitted ANYWAY when `off` is
 *   present (the harness can disable thinking); an all-`null` map (no `off`,
 *   e.g. options `["on"]`) is forbidden (C5) and omitted. Unknown option
 *   strings are ignored, never mapped (never invent — C5).
 * - `contextWindow` ← `loaded_instances[0].config.context_length` (as-loaded,
 *   runtime-true) when a positive integer, else `max_context_length` (model
 *   max), through `toPositiveInt` (from `./metadata.js`); absent both →
 *   omitted.
 * - `input` ← `capabilities.vision === true` → `["text","image"]`;
 *   `false` → `["text"]`; absent → omitted.
 * - NEVER emitted (no canonical field exists — C5): `maxTokens`, `compat`,
 *   `trained_for_tool_use`, `quantization`, `architecture`, `params_string`,
 *   `publisher`, `display_name`, `size_bytes`, `format`, `state`.
 *
 * Fail-soft (C6): a failed/aborted/malformed enrichment fetch →
 * `{ byId: new Map() }` (all-generic); a well-formed element whose fields
 * all fail to map yields an `undefined` `byId` value ("enriched, nothing
 * found" — the row keeps no `discoveredCanonical`, C4). The backend NEVER
 * throws into the channel and never fails the endpoint.
 */

import type { CanonicalModelFields, ThinkingLevelMap } from "../types.js";
import type {
  BackendRows,
  BackendVerdict,
  DiscoveryBackend,
  DiscoveryContext,
} from "./backends.js";
import { isPlainObject } from "../resolve/canonical.js";
import { toPositiveInt } from "./metadata.js";
import type { OpenAIModelEntry } from "./types.js";

/**
 * The LM Studio v1 model-list element — the subset this backend consumes,
 * with unknown keys tolerated (the live response also carries `size_bytes`,
 * `format`, `state`, `id`, which v1 does not read). Fields are typed
 * `unknown` and narrowed fail-soft at use: any shape surprise degrades to
 * "field absent", never an error.
 */
export interface LmStudioModel {
  /** The wire identity — joined against the `/v1/models` entry's `id`. */
  key?: unknown;
  /** Consumed: `capabilities.{vision, reasoning.allowed_options}` (§3.3). */
  capabilities?: unknown;
  /** Consumed: `loaded_instances[0].config.context_length` (as-loaded ctx). */
  loaded_instances?: unknown;
  /** Consumed: the model-max context fallback (§3.3). */
  max_context_length?: unknown;
  /** Deliberately UNREAD (display-only, no canonical field — C5): publisher,
   *  display_name, architecture, quantization, params_string, state. */
  [key: string]: unknown;
}

/** Injectable fetch options (the probe.ts / Ollama-discovery discipline). */
export interface LmStudioFetchOptions {
  /** Injectable fetch (defaults to `globalThis.fetch` — stubbed in tests). */
  fetchImpl?: typeof fetch;
  /** Caller's abort signal (the handler's signal aborts the probe). */
  signal?: AbortSignal;
  /** Bearer key sent when set (C7 — v1 API tokens, off by default). */
  apiKey?: string;
}

/**
 * The LM Studio backend-detection probe result (C10). A
 * definitive verdict distinguishes "not LM Studio" from "no answer" so the
 * channel's memo can retry the latter without re-probing the former.
 */
export interface LmStudioModelsProbe {
  /** The answer passed the v1 shape gate (`{models:[{key,…}]}`). */
  isLmStudio: boolean;
  /** The RAW parsed model elements of a matching answer (the facts cache). */
  models?: unknown[];
  /**
   * The probe got NO answer (network failure / abort / 5xx / an unlisted
   * status): the "not LM Studio" verdict is INCONCLUSIVE and the caller may
   * retry. A well-formed answer of any other kind (404/405/401, a non-JSON
   * 200, a wrong shape) is definitive.
   */
  inconclusive?: boolean;
}

/**
 * The probe statuses that are a DEFINITIVE non-match (C10): 404/405 (a
 * pre-0.4.0 server — v0 surface only, no `/api/v1/*`) and 401 (auth-gated —
 * a well-formed non-answer). Anything else that is not a 2xx (5xx, 403,
 * redirects, …) is treated as NO ANSWER (inconclusive, retriable): the plan
 * locks only these three as definitive and a denial wall is not evidence
 * about the dialect behind it.
 */
const DEFINITIVE_NON_MATCH_STATUSES: readonly number[] = [401, 404, 405];

/**
 * The LM Studio v1 list shape gate: the body must be an object
 * whose `models` is an array with at least one element that is an object
 * carrying a string `key` (the wrap in `models` — not OpenAI's `data` — plus
 * the keyed element is the dialect marker). Returns the RAW element array
 * (unvalidated beyond the gate — per-element narrowing stays fail-soft at
 * use), or `undefined` when the shape does not match.
 */
export function lmStudioModelsPayload(payload: unknown): unknown[] | undefined {
  if (!isPlainObject(payload) || !Array.isArray(payload.models)) return undefined;
  const elements = payload.models as unknown[];
  const hasKeyedElement = elements.some(
    (element) => isPlainObject(element) && typeof element.key === "string",
  );
  return hasKeyedElement ? elements : undefined;
}

/**
 * Strips the trailing `/v1` from an ALREADY-NORMALIZED route base
 * (`normalizeRouteBaseUrl` output) to get the server ORIGIN the native
 * `/api/v1/*` endpoints hang off — the exact twin of the Ollama backend's
 * `ollamaOrigin` (kept a separate named helper so each backend stays
 * self-contained): `http://host:1234/v1` → `http://host:1234`.
 */
export function lmstudioOrigin(routeBase: string): string {
  const base = routeBase.replace(/\/$/, "");
  return base.endsWith("/v1") ? base.slice(0, -3) : base;
}

/**
 * Probes `GET {origin}/api/v1/models` for the LM Studio backend.
 * Never throws: any failure resolves a non-matching verdict (`inconclusive`
 * when no answer arrived at all — a failed probe is not evidence against LM
 * Studio), so detection failure silently falls back to the generic path.
 *
 * @param origin - Server origin WITHOUT the `/v1` suffix (see
 *   {@link lmstudioOrigin}).
 */
export async function fetchLmStudioModels(
  origin: string,
  options: LmStudioFetchOptions = {},
): Promise<LmStudioModelsProbe> {
  const { fetchImpl = globalThis.fetch, signal, apiKey } = options;
  const url = `${origin.replace(/\/$/, "")}/api/v1/models`;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiKey !== undefined) headers.Authorization = `Bearer ${apiKey}`;
  let response: Response;
  try {
    response = await fetchImpl(url, { method: "GET", headers, signal });
  } catch {
    // No answer at all (network failure / abort) — an INCONCLUSIVE verdict:
    // the caller may retry (evicting the memo), a failed probe is not
    // evidence of "not LM Studio" (C6: silent generic fallback).
    return { isLmStudio: false, inconclusive: true };
  }
  if (!response || !response.ok) {
    // A server that ANSWERED with a locked status is definitive (C10);
    // anything else (5xx, unlisted statuses) is no evidence — retriable.
    const status = response?.status;
    if (status !== undefined && DEFINITIVE_NON_MATCH_STATUSES.includes(status)) {
      return { isLmStudio: false };
    }
    return { isLmStudio: false, inconclusive: true };
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    // A 200 with a non-JSON body ANSWERED on this endpoint — definitive
    // (only LM Studio serves this route; its answer is not the v1 shape).
    return { isLmStudio: false };
  }
  const models = lmStudioModelsPayload(payload);
  if (models === undefined) {
    return { isLmStudio: false };
  }
  return { isLmStudio: true, models };
}

/**
 * Pure vocabulary mapper: LM Studio's `allowed_options` array →
 * the pi-ai harness `thinkingLevelMap`, built ONLY from what the server
 * itself enumerates. The harness vocabulary is `off|minimal|low|medium|high|
 * xhigh|max`; `null` marks a level the server does not list (pi-ai clamps
 * client-side — an explicit null, not an absent key, so the level is
 * honestly "unsupported" rather than inherited):
 *
 * - `low`/`medium`/`high` → 1:1 when listed;
 * - `off` → `"off"` when `"off"` is listed;
 * - `"on"` is the model's default-on MARKER and maps to NO harness level
 *   (there is no harness level meaning "thinking on"; enabling falls back to
 *   the server default) — it contributes no entry;
 * - every other harness level → `null`;
 * - unknown option strings are ignored, never mapped (C5 — never invent).
 *
 * A map whose every entry is `null` is FORBIDDEN (C5 — a map must support at
 * least one level or be omitted), with ONE sanctioned exception: when `off`
 * is listed, the map is emitted even with no on-level (e.g. the documented
 * `["off","on"]` toggle dialect — the harness can disable thinking; enabling
 * falls back to the server default). So: options `["on"]` (or `[]`, or
 * garbage) → `undefined`; options `["off","on"]` → the off-only map.
 */
export function lmStudioThinkingLevelMap(allowedOptions: unknown): ThinkingLevelMap | undefined {
  if (!Array.isArray(allowedOptions)) return undefined;
  const listed = new Set(
    allowedOptions.filter((option): option is string => typeof option === "string"),
  );
  const map: ThinkingLevelMap = {
    off: listed.has("off") ? "off" : null,
    minimal: null,
    low: listed.has("low") ? "low" : null,
    medium: listed.has("medium") ? "medium" : null,
    high: listed.has("high") ? "high" : null,
    xhigh: null,
    max: null,
  };
  const usable = Object.values(map).some((value) => value !== null);
  return usable ? map : undefined;
}

/**
 * Pure mapper: one v1 model element → the discovered canonical fields,
 * fail-soft per field — an absent field simply falls through to
 * tier 3/4:
 *
 * - `reasoning: true` ⟺ `capabilities.reasoning` is an object with a
 *   non-empty `allowed_options` array; otherwise the field is ABSENT (never
 *   `false` here — the default tier owns that).
 * - `thinkingLevelMap` ← {@link lmStudioThinkingLevelMap} over
 *   `allowed_options` (the ONLY source — never invented). Emitted whenever
 *   the options yield a usable map (the reasoning gate above already
 *   required a non-empty list).
 * - `input` ← `capabilities.vision` strictly `true` → `["text","image"]`,
 *   strictly `false` → `["text"]`, absent/neither → omitted.
 * - `contextWindow` ← `loaded_instances[0].config.context_length` (as-loaded,
 *   runtime-true — the JIT-default trap) when a positive integer, else
 *   `max_context_length` (model max), through `toPositiveInt`; absent both →
 *   omitted.
 *
 * `maxTokens` / `compat` are NEVER emitted (C5 — undiscoverable / pi-ai's
 * detected default), and neither is anything display-only
 * (`trained_for_tool_use`, `quantization`, `architecture`, `params_string`,
 * `publisher`, `display_name` — no canonical field exists). Never throws.
 */
export function lmStudioModelToCanonical(model: LmStudioModel): CanonicalModelFields {
  const canonical: CanonicalModelFields = {};
  const capabilities = isPlainObject(model.capabilities) ? model.capabilities : undefined;

  const reasoning = capabilities?.reasoning;
  if (
    isPlainObject(reasoning) &&
    Array.isArray(reasoning.allowed_options) &&
    reasoning.allowed_options.length > 0
  ) {
    canonical.reasoning = true;
    const thinkingLevelMap = lmStudioThinkingLevelMap(reasoning.allowed_options);
    if (thinkingLevelMap !== undefined) canonical.thinkingLevelMap = thinkingLevelMap;
  }

  if (capabilities?.vision === true) canonical.input = ["text", "image"];
  else if (capabilities?.vision === false) canonical.input = ["text"];

  const loadedInstance = Array.isArray(model.loaded_instances)
    ? model.loaded_instances[0]
    : undefined;
  const loadedConfig =
    isPlainObject(loadedInstance) && isPlainObject(loadedInstance.config)
      ? loadedInstance.config
      : undefined;
  const contextWindow =
    (loadedConfig !== undefined ? toPositiveInt(loadedConfig.context_length) : undefined) ??
    toPositiveInt(model.max_context_length);
  if (contextWindow !== undefined) canonical.contextWindow = contextWindow;

  return canonical;
}

/**
 * The detection-cached model elements: `facts.models` — the RAW
 * element array {@link lmstudioBackend.detect} put there. Anything else
 * (absent facts, a non-array) → `undefined` (the caller re-fetches once,
 * fail-soft).
 */
function cachedModelsOf(facts: Record<string, unknown> | undefined): unknown[] | undefined {
  return facts !== undefined && Array.isArray(facts.models) ? (facts.models as unknown[]) : undefined;
}

/**
 * The LM Studio backend (registry order: directly after Ollama — the third
 * slot of C9's locked order).
 *
 * detect: the {@link fetchLmStudioModels} probe; a match carries the parsed
 * element array in `facts.models` so metadataRows re-uses the SAME single
 * response (one fetch total for detect + enrich). metadataRows:
 * join `key === entry.id`; a joined element maps through
 * {@link lmStudioModelToCanonical} — a non-empty canonical REPLACES the
 * row's `discoveredCanonical` (C4 FULL replacement), an empty one sets
 * `undefined` ("enriched, nothing found"), and an unjoined/malformed id is
 * ABSENT (the channel keeps the generic row). No notes (nothing gated to
 * report — the plan locks no LM Studio log line). Never throws (C6): a
 * failed enrichment fetch degrades to `{ byId: new Map() }` (all-generic).
 */
export const lmstudioBackend: DiscoveryBackend = {
  id: "lmstudio",
  async detect(ctx: DiscoveryContext): Promise<BackendVerdict> {
    const probe = await fetchLmStudioModels(lmstudioOrigin(ctx.baseUrl), {
      signal: ctx.signal,
      fetchImpl: ctx.fetchImpl,
      ...(ctx.apiKey !== undefined ? { apiKey: ctx.apiKey } : {}),
    });
    if (probe.inconclusive) return { match: false, inconclusive: true };
    if (!probe.isLmStudio) return { match: false };
    return {
      match: true,
      // The SAME single response rides to metadataRows: the raw
      // elements as detected, unvalidated beyond the shape gate.
      facts: { models: probe.models ?? [] },
    };
  },
  async metadataRows(
    entries: readonly OpenAIModelEntry[],
    ctx: DiscoveryContext,
    facts: Record<string, unknown> | undefined,
  ): Promise<BackendRows> {
    // The detection response cache first (zero extra fetches);
    // a metadataRows call WITHOUT a detect verdict (a direct call — never
    // the channel's path) re-fetches the same URL once, fail-soft.
    let models = cachedModelsOf(facts);
    if (models === undefined) {
      const probe = await fetchLmStudioModels(lmstudioOrigin(ctx.baseUrl), {
        signal: ctx.signal,
        fetchImpl: ctx.fetchImpl,
        ...(ctx.apiKey !== undefined ? { apiKey: ctx.apiKey } : {}),
      });
      models = probe.isLmStudio ? probe.models : undefined;
    }
    const byId = new Map<string, CanonicalModelFields | undefined>();
    if (models === undefined) {
      // C6: the fetch failed/aborted or the answer was not the v1 shape —
      // every row stays generic; the enrichment never throws.
      return { byId };
    }
    // Join by `key === entry.id`; elements without a string key (malformed)
    // cannot be joined and stay generic.
    const byKey = new Map<string, LmStudioModel>();
    for (const element of models) {
      if (isPlainObject(element) && typeof element.key === "string") {
        byKey.set(element.key, element as LmStudioModel);
      }
    }
    for (const entry of entries) {
      const element = byKey.get(entry.id);
      if (element === undefined) continue; // no matching model element → generic row
      const canonical = lmStudioModelToCanonical(element);
      byId.set(entry.id, Object.keys(canonical).length > 0 ? canonical : undefined);
    }
    return { byId };
  },
};