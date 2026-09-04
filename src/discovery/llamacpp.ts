/**
 * The llama.cpp llama-server `/props` tier-2 discovery backend
 * (docs/provider-details.md §3.3 [verified-web]).
 *
 * WHY: a bare llama-server's `/v1/models` is OpenAI-minimal, but since tag
 * b3400 (Mar 2024) every entry carries a GGUF **`meta`** object
 * (`{vocab_type, n_vocab, n_ctx, n_ctx_train, n_embd, n_params, size,
 * ftype}`) and the root `GET /props` endpoint answers the server's real
 * per-slot facts: `default_generation_settings.n_ctx` (the context window
 * AS CONFIGURED — the value that actually bounds generation),
 * `modalities.{vision,video,audio}`, and `chat_template_caps` (the
 * machine-readable jinja-template gate, incl.
 * `supports_reasoning_effort`). None of this reaches the generic extractor
 * today, so reasoning/input/contextWindow resolve entirely from
 * preset/default.
 *
 * ROUTER-MODE LIMITATION (accepted v1 trade-off, locked §4.2): in router
 * mode llama-server spawns per-model child servers keyed by `?model=`
 * query params — `/props` against the ROUTER answers for the DEFAULT slot
 * only. This backend applies the server-wide `/props` values to EVERY
 * catalog entry (per-model divergence via `?model=` is OUT OF SCOPE); the
 * per-entry `meta.n_ctx_train` fallback below is the only per-model fact.
 *
 * DETECTION (C10, catalog-first): the catalog is asked FIRST — a ZERO-fetch
 * match when ANY entry spells `owned_by === "llamacpp"` (the bare-server
 * catalog marker) or carries a `meta` object that is NOT a llama-swap
 * authored block (the GGUF meta shape). An explicit `owned_by ===
 * "llamacpp"` wins over the llama-swap exclusion (the catalog's own
 * provenance claim is the stronger signal; the live llama-swap surface
 * spells `owned_by: "llama-swap"`). The catalog is ALSO asked for the
 * DEFINITIVE-NO short-circuit: positive llama-swap provenance (ANY entry
 * rendering the authored `meta.llamaswap` block) identifies the origin as
 * the llama-swap ROUTER, whose surface is disjoint from llama.cpp's —
 * llama-swap does not serve `/props` (docs/provider-details.md §3.1 [verified-live]) —
 * so the verdict is a definitive no with ZERO fetches. That is the
 * FALSE-POSITIVE GUARD (the primary router must not match): a
 * proxied default-slot `/props` answer, were one ever to appear, must not
 * override the user's authored `meta.llamaswap` metadata with server-wide
 * values. Only a catalog with NEITHER signal (bare shapes) falls through
 * to the ONE probe: `GET {origin}/props` — 200 with a
 * `default_generation_settings` object ⇒ match; 404/405/401 ⇒ DEFINITIVE
 * no (C10's well-formed non-answers); a 200 with a non-props body (e.g.
 * KoboldCpp's `/props`, note §3.2 — no `default_generation_settings`) is
 * likewise a well-formed non-answer; network failure / abort / 5xx ⇒
 * INCONCLUSIVE (not evidence — the channel's memo evicts and retries).
 * `detect` NEVER throws and never invents: fail-soft per C6.
 *
 * (Deviation from the §4 letter — the provenance short-circuit skips the
 * probe for catalogs the catalog itself already identifies; the C10
 * discipline is kept. Why: docs/design.md ("Moved from code").)
 *
 * ONE PROPS FETCH TOTAL: when detection had to ask the server, the parsed
 * `/props` payload rides `facts` (C1) and `metadataRows` REUSES it — a
 * probe-matched route costs exactly one `/props` request end to end. A
 * catalog-first match starts with no payload and fetches once here. (The
 * cached payload is the server's FULL `/props` body and stays IN MEMORY
 * ONLY — it never reaches the wire; see the `chat_template` note below.)
 *
 * MAPPING (locked §4.3, per entry — the server-wide values apply to every
 * entry, the router-mode trade-off above):
 * - `contextWindow` ← `default_generation_settings.n_ctx` (AS CONFIGURED —
 *   the two-layer preference, model-max loses to the runtime bound) when a
 *   positive integer, else the entry's own `meta.n_ctx_train` (the GGUF
 *   model max — FETCH-FREE: it still applies when `/props` never answered,
 *   the C6 fail-soft rule), else omitted. Through `toPositiveInt`
 *   (`./metadata.js`). `meta.n_ctx` (the as-configured mirror llama-swap
 *   renders) is deliberately NOT in the chain — the generic extractor
 *   already owns that slot for generic rows, and this backend's chain is
 *   props-configured → train-max only.
 * - `input` ← `modalities.vision === true` → `["text","image"]`;
 *   `=== false` → `["text"]`; absent/other → omitted (per-field probe
 *   discipline).
 * - `compat.supportsReasoningEffort` ←
 *   `chat_template_caps.supports_reasoning_effort` — the EXACT boolean,
 *   BOTH true and false emitted. This is the ONE named C5 compat
 *   exception: a declared template gate (the server's own
 *   `to_map()` spelling), not an invented capability. A `caps` object
 *   without the key, or a non-boolean value, emits no compat (per-field
 *   degrade).
 * - `reasoning` ← `chat_template_caps.supports_reasoning_effort === true`
 *   ONLY. Absent caps (an old pre-caps server) ⇒ NO reasoning from the
 *   probe — today's behavior preserved; `false` never emitted (the default
 *   tier owns "no thinking").
 * - NEVER a `thinkingLevelMap`: no endpoint enumerates which effort levels
 *   a template accepts — the CLI's `--reasoning-effort` vocabulary visible
 *   inside `default_generation_settings.params` is launch config, not
 *   per-model capability; the boolean gate is the honest signal (note
 *   §3.1). NEVER `maxTokens` (C5 — undiscoverable).
 * - The raw jinja `chat_template` is CAPTURED-OUT-OF-SCOPE for v1: preset
 *   authoring is a separate future plan — this module does not ship it
 *   (no canonical field, no row, no note) and does not log it. It is
 *   declared on the wire type only so the response shape is complete.
 *
 * SHAPE (the ollama.ts discipline): this module holds the probe + the pure
 * mappers and imports nothing from the channel; `src/dsh/channel.ts` probes
 * {@link llamacppBackend} through the shared registry (C2) and builds the
 * rows through the pure seams below beside `discoverMetadataRow`. Fail-soft
 * everywhere (C6): every function is fetch-injectable and never throws — a
 * network error, abort, non-2xx, or malformed body degrades per field/row;
 * when `/props` fails entirely, the fetch-free `meta.n_ctx_train`
 * contextWindow STILL applies and every other entry keeps the generic row.
 */

import type { CanonicalModelFields, Compat } from "../types.js";
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
 * The llama-server `GET /props` response — the subset §4.3 consumes, with
 * unknown keys tolerated (the live body also carries `total_slots`,
 * `model_alias`, `model_path`, `bos_token`/`eos_token`, `build_info`,
 * `is_sleeping`, and — with `--jinja` + a tool-use template — a
 * `chat_template_tool_use` block, none read in v1). Fields are typed
 * `unknown` and narrowed fail-soft at use: any shape surprise degrades to
 * "field absent", never an error.
 */
export interface LlamacppProps {
  /**
   * The default slot's generation settings — consumed:
   * `default_generation_settings.n_ctx` (AS CONFIGURED). Its `params` sub-
   * object (launch flags like `reasoning_format`/`reasoning_budget`) is
   * launch config, NOT per-model capability — deliberately unread (§4.3).
   */
  default_generation_settings?: unknown;
  /** `{vision,video,audio}` — consumed: `vision` only (`audio`/`video` have no pi modality spelling). */
  modalities?: unknown;
  /**
   * The jinja template capability map (`common/jinja/caps.cpp to_map()`) —
   * consumed: `supports_reasoning_effort` ONLY (the exact boolean gate).
   * The other keys (`supports_tools`, `supports_preserve_reasoning`, …)
   * have no canonical consumer in v1.
   */
  chat_template_caps?: unknown;
  /**
   * The raw jinja chat template — deliberately UNREAD in v1 (preset
   * authoring is a separate future plan): never emitted, never logged.
   * Declared only so the wire shape is complete. When the detection probe's
   * payload rides `facts`, this key rides along in memory only.
   */
  chat_template?: unknown;
  [key: string]: unknown;
}

/** Injectable fetch options (the probe.ts discipline, C7). */
export interface LlamacppFetchOptions {
  /** Injectable fetch (defaults to `globalThis.fetch` — stubbed in tests). */
  fetchImpl?: typeof fetch;
  /** Caller's abort signal (the handler's signal aborts the probe). */
  signal?: AbortSignal;
  /** The route's Bearer key when resolved (C7 — rides every fetch). */
  apiKey?: string;
}

/**
 * The `/props` probe result. A definitive verdict distinguishes "not a
 * llama-server props surface" from "no answer" so the channel's memo can
 * retry the latter without re-probing the former (C2/C10).
 */
export interface LlamacppPropsProbe {
  /** The parsed payload when the shape gate passed (a props-answering origin). */
  props?: LlamacppProps;
  /**
   * The probe got NO usable answer (network failure / abort / 5xx / an
   * unlisted status): the "not llama.cpp" verdict is INCONCLUSIVE and the
   * caller may retry. A well-formed answer of any other kind (404/405/401,
   * a 200 with a non-props body) is definitive.
   */
  inconclusive?: boolean;
}

/**
 * Strips the trailing `/v1` from an ALREADY-NORMALIZED route base
 * (`normalizeRouteBaseUrl` output) to get the server ORIGIN the root-level
 * `/props` endpoint hangs off — the same seam as `ollamaOrigin` (kept
 * module-local so each backend stays self-contained).
 * `http://host:8080/v1` → `http://host:8080`.
 */
export function llamacppOrigin(routeBase: string): string {
  const base = routeBase.replace(/\/$/, "");
  return base.endsWith("/v1") ? base.slice(0, -3) : base;
}

/**
 * The C10 catalog-first gate, half 1: the entry claims
 * `owned_by === "llamacpp"` — the bare llama-server `/v1/models` marker
 * (docs/provider-details.md §3.3 fixture). An explicit claim always matches (see the
 * llama-swap carve-out note in the module header).
 */
export function isLlamacppOwnedBy(entry: OpenAIModelEntry): boolean {
  return entry.owned_by === "llamacpp";
}

/**
 * The core GGUF shape fields (docs/provider-details.md §3.1, [verified-live]):
 * a real GGUF meta carries at least one of these; llama-swap's authored
 * `meta` block carries `meta.n_ctx` only (router-mode's own key, issue #999 —
 * disambiguates nothing). The gate requires at least one of these, so a
 * bare `n_ctx`-only meta (llama-swap's 11/13 entries) never matches.
 */
const GGUF_SHAPE_KEYS = ["n_vocab", "n_ctx_train", "n_embd", "n_params", "size", "vocab_type"] as const;

/**
 * The C10 catalog-first gate, half 2 (SHAPE-GATED — see
 * {@link GGUF_SHAPE_KEYS}): the entry carries a `meta` object of the GGUF
 * shape (b3400+) that is NOT a llama-swap authored block. The core shape
 * fields are stable across releases (the meta GREW around them, 6 → 8
 * fields), so the gate does not un-recognize older/newer servers; the
 * `llamaswap`-key exclusion stays as defense-in-depth.
 */
export function hasLlamacppGgufMeta(entry: OpenAIModelEntry): boolean {
  const meta = entry.meta;
  if (!isPlainObject(meta) || "llamaswap" in meta) return false;
  return GGUF_SHAPE_KEYS.some((key) => key in meta);
}

/** The full detection gate: any entry matching either half claims the origin. */
export function isLlamacppCatalogEntry(entry: OpenAIModelEntry): boolean {
  return isLlamacppOwnedBy(entry) || hasLlamacppGgufMeta(entry);
}

/**
 * Positive llama-swap PROVENANCE: the entry renders the authored
 * `meta.llamaswap` block — the llama-swap router's own wire signature
 * (docs/provider-details.md §3.1 [verified-live]). This is the DEFINITIVE-NO half of the
 * false-positive guard: a catalog carrying it belongs to llama-swap, which
 * does not serve `/props`, so detection settles the origin as not-llama.cpp
 * with ZERO fetches instead of probing (see the module header — the
 * flagged §4-letter deviation).
 */
export function hasLlamaSwapProvenance(entry: OpenAIModelEntry): boolean {
  const meta = entry.meta;
  return isPlainObject(meta) && "llamaswap" in meta;
}

/**
 * Fetches `{origin}/props` and applies the C10 shape gate. Never throws:
 * any failure resolves a non-match verdict (`inconclusive` when no usable
 * answer arrived — a failed probe is not evidence against llama.cpp), so
 * detection failure silently falls back to the generic path.
 *
 * Status handling (C10): 404/405/401 = a well-formed non-answer
 * (DEFINITIVE no); 5xx, a network failure, and an abort = INCONCLUSIVE;
 * any other non-2xx status is treated as inconclusive too (unlisted =
 * not clean evidence — the conservative reading). A 2xx whose body is not
 * the props shape (including non-JSON and e.g. KoboldCpp's
 * `{chat_template, n_ctx, modalities}` props, note §3.2) is definitive:
 * the server ANSWERED on `/props` with something else.
 *
 * @param origin - Server origin WITHOUT the `/v1` suffix (see
 *   {@link llamacppOrigin}).
 */
export async function fetchLlamacppProps(
  origin: string,
  options: LlamacppFetchOptions = {},
): Promise<LlamacppPropsProbe> {
  const { fetchImpl = globalThis.fetch, signal, apiKey } = options;
  const url = `${origin.replace(/\/$/, "")}/props`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...(apiKey !== undefined ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      signal,
    });
  } catch {
    // No answer at all (network failure / abort) — an INCONCLUSIVE verdict:
    // the caller may retry (evicting the memo), a failed probe is not
    // evidence of "not llama.cpp" (C6: silent generic fallback).
    return { inconclusive: true };
  }
  if (!response || !response.ok) {
    // A server that ANSWERED with one of C10's listed statuses is definitive
    // evidence that this origin does not serve the llama-server props shape.
    const status = response?.status;
    if (status === 404 || status === 405 || status === 401) {
      return {};
    }
    // 5xx and unlisted statuses: no clean evidence either way — retriable.
    return { inconclusive: true };
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return {}; // answered, not the props shape — definitive
  }
  if (!isPlainObject(payload) || !isPlainObject(payload.default_generation_settings)) {
    return {}; // a well-formed non-answer (e.g. KoboldCpp's /props) — definitive
  }
  return { props: payload as LlamacppProps };
}

/** The entry's GGUF `meta` object (fail-soft: non-object → undefined). */
function ggufMetaOf(entry: OpenAIModelEntry): Record<string, unknown> | undefined {
  return isPlainObject(entry.meta) ? (entry.meta as Record<string, unknown>) : undefined;
}

/** The props `default_generation_settings` object (fail-soft: non-object → empty). */
function defaultGenerationSettingsOf(props: LlamacppProps): Record<string, unknown> {
  return isPlainObject(props.default_generation_settings)
    ? (props.default_generation_settings as Record<string, unknown>)
    : {};
}

/** The props `modalities` object (fail-soft: non-object → empty). */
function modalitiesOf(props: LlamacppProps): Record<string, unknown> {
  return isPlainObject(props.modalities) ? (props.modalities as Record<string, unknown>) : {};
}

/**
 * The props `chat_template_caps` object, or undefined when absent/malformed
 * (an OLD server without caps — the "no reasoning from the probe" case).
 */
function chatTemplateCapsOf(
  props: LlamacppProps | undefined,
): Record<string, unknown> | undefined {
  return props !== undefined && isPlainObject(props.chat_template_caps)
    ? (props.chat_template_caps as Record<string, unknown>)
    : undefined;
}

/**
 * Narrows a `facts`-carried `/props` payload back through the shape gate
 * (defensive — the payload only ever round-trips in-process, but the seam
 * re-validates so a caller cannot inject a malformed shape).
 */
function propsFromFacts(facts: Record<string, unknown> | undefined): LlamacppProps | undefined {
  const props = facts?.props;
  if (!isPlainObject(props) || !isPlainObject(props.default_generation_settings)) {
    return undefined;
  }
  return props as LlamacppProps;
}

/** The pure per-entry mapping result ({@link llamacppPropsToCanonical}). */
export interface LlamacppCanonicalMapping {
  /** The discovered canonical fields (absent when nothing usable was advertised). */
  discoveredCanonical?: CanonicalModelFields;
}

/**
 * Pure mapper: one `/props` payload (undefined = the fetch never answered —
 * the C6 fail-soft path) + one catalog entry → the discovered canonical
 * fields, fail-soft per field — an absent field simply falls through to
 * tier 3/4:
 *
 * - `contextWindow` = `default_generation_settings.n_ctx` (AS CONFIGURED)
 *   when `props` answered with a positive integer, else the entry's own
 *   `meta.n_ctx_train` (the GGUF model max — FETCH-FREE, so it applies even
 *   when `/props` failed), else omitted. Through `toPositiveInt`. (The
 *   `meta.n_ctx` as-configured mirror is deliberately not consulted — see
 *   the module header.)
 * - `input` = `["text","image"]` ⟺ `modalities.vision === true`;
 *   `["text"]` ⟺ `=== false`; absent ⟺ the field is absent (read only
 *   when `props` answered).
 * - `compat.supportsReasoningEffort` = the EXACT
 *   `chat_template_caps.supports_reasoning_effort` boolean — both true and
 *   false emitted (the single named C5 exception: a declared template
 *   gate). Caps present without the key (or a non-boolean value) ⇒ no
 *   compat.
 * - `reasoning` = `true` ONLY when `supports_reasoning_effort === true`;
 *   never `false` (the default tier owns "no thinking"), and ABSENT
 *   entirely when caps are absent (an old server ⇒ no reasoning from the
 *   probe — today's behavior preserved).
 * - NEVER `thinkingLevelMap` (no endpoint enumerates levels), NEVER
 *   `maxTokens` (C5), and the raw jinja `chat_template` is never read.
 *
 * Never throws.
 */
export function llamacppPropsToCanonical(
  props: LlamacppProps | undefined,
  entry: OpenAIModelEntry,
): LlamacppCanonicalMapping {
  const canonical: CanonicalModelFields = {};

  // The locked two-layer context chain: as-configured (props) → model-max
  // (the entry's own GGUF meta — no fetch needed, so it survives a failed
  // /props) → omit.
  const configuredCtx =
    props === undefined
      ? undefined
      : toPositiveInt(defaultGenerationSettingsOf(props).n_ctx);
  const contextWindow = configuredCtx ?? toPositiveInt(ggufMetaOf(entry)?.n_ctx_train);
  if (contextWindow !== undefined) canonical.contextWindow = contextWindow;

  if (props !== undefined) {
    const vision = modalitiesOf(props).vision;
    if (vision === true) canonical.input = ["text", "image"];
    else if (vision === false) canonical.input = ["text"];
  }

  const caps = chatTemplateCapsOf(props);
  if (caps !== undefined) {
    const effort = caps.supports_reasoning_effort;
    if (typeof effort === "boolean") {
      // The ONE C5 compat exception — a declared boolean gate, both
      // polarities emitted verbatim.
      canonical.compat = { supportsReasoningEffort: effort } satisfies Compat;
    }
    if (effort === true) canonical.reasoning = true;
  }

  return Object.keys(canonical).length > 0 ? { discoveredCanonical: canonical } : {};
}

/**
 * Pure rows seam beside `discoverMetadataRow`: the per-id FULL canonical
 * objects for a LLAMA-SERVER route (C4's `byId` — the channel REPLACES each
 * enriched row's `discoveredCanonical` with this value, FULL-replacement
 * semantics).
 *
 * - `props` answered (any shape — the fetch is server-wide): EVERY entry is
 *   enriched — the router-mode trade-off (server-wide values apply to every
 *   entry). An entry whose mapped canonical is empty sets `undefined` =
 *   "enriched, nothing found" (the row keeps no discoveredCanonical, even
 *   where the generic extractor would have found something — the backend
 *   owns the row once `/props` answered).
 * - `props` undefined (fetch failed/aborted — C6): only the FETCH-FREE
 *   fallback applies — an entry with a usable `meta.n_ctx_train` gets
 *   `{ contextWindow }`; every other id stays ABSENT from the map so the
 *   channel keeps its generic row as-is.
 *
 * Pure (no I/O, never throws); order irrelevant (a Map keyed by id).
 */
export function llamacppRowsById(
  entries: readonly OpenAIModelEntry[],
  props: LlamacppProps | undefined,
): Map<string, CanonicalModelFields | undefined> {
  const byId = new Map<string, CanonicalModelFields | undefined>();
  for (const entry of entries) {
    const { discoveredCanonical } = llamacppPropsToCanonical(props, entry);
    if (props !== undefined) {
      byId.set(entry.id, discoveredCanonical);
    } else if (discoveredCanonical !== undefined) {
      byId.set(entry.id, discoveredCanonical);
    }
    // else: the id stays ABSENT — the channel keeps the generic row (C4/C6).
  }
  return byId;
}

/**
 * The llama.cpp llama-server backend (registry position: last — its
 * detection is catalog-first/free, order cosmetic per C9).
 */
export const llamacppBackend: DiscoveryBackend = {
  id: "llamacpp",
  detect(ctx: DiscoveryContext): Promise<BackendVerdict> {
    // C10, catalog-first: a ZERO-fetch match when any entry carries a
    // llama.cpp marker. No probe is spent on an origin the catalog already
    // identifies.
    if (ctx.entries.some(isLlamacppCatalogEntry)) {
      return Promise.resolve({ match: true, facts: {} });
    }
    // The FALSE-POSITIVE GUARD, zero-fetch definitive no: a catalog with
    // llama-swap provenance belongs to the llama-swap router, which does
    // not serve /props — probing would be a wasted fetch at best and a
    // false claim at worst (module header). An explicit owned_by ===
    // "llamacpp" already won above.
    if (ctx.entries.some(hasLlamaSwapProvenance)) {
      return Promise.resolve({ match: false });
    }
    // Bare-shape catalog: ONE probe. A probe-matched verdict caches the
    // parsed payload in `facts` so metadataRows reuses it — one total
    // /props fetch per route (see the module header).
    return fetchLlamacppProps(llamacppOrigin(ctx.baseUrl), {
      signal: ctx.signal,
      fetchImpl: ctx.fetchImpl,
      ...(ctx.apiKey !== undefined ? { apiKey: ctx.apiKey } : {}),
    }).then((probe) => {
      if (probe.inconclusive) return { match: false, inconclusive: true };
      if (probe.props === undefined) return { match: false };
      return { match: true, facts: { props: probe.props } };
    });
  },
  async metadataRows(
    entries: readonly OpenAIModelEntry[],
    ctx: DiscoveryContext,
    facts: Record<string, unknown> | undefined,
  ): Promise<BackendRows> {
    // ONE props fetch total: reuse the detection probe's payload when it is
    // here (the probe-matched path); a catalog-first match starts without
    // one and fetches exactly once. A failed/aborted fetch resolves
    // `undefined` — llamacppRowsById then applies the fetch-free
    // meta.n_ctx_train fallback only (C6), never throwing.
    let props = propsFromFacts(facts);
    if (props === undefined) {
      const probe = await fetchLlamacppProps(llamacppOrigin(ctx.baseUrl), {
        signal: ctx.signal,
        fetchImpl: ctx.fetchImpl,
        ...(ctx.apiKey !== undefined ? { apiKey: ctx.apiKey } : {}),
      });
      props = probe.props;
    }
    const byId = llamacppRowsById(entries, props);
    return { byId };
  },
};