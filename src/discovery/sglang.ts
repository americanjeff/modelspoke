/**
 * The SGLang native tier-2 discovery backend
 * (docs/provider-details.md §3.5 [verified-web];
 * the C1–C12 contract in docs/design.md, "The discovery backends").
 *
 * WHY: an SGLang provider's `/v1/models` is nearly bare for the canonical
 * extractor (id/created/owned_by; a `max_model_len` the default path does
 * not read — the probe-gated oracle slot, `./metadata.ts`
 * `extractContextWindow`), so reasoning/input resolve entirely from
 * preset/default. SGLang's native surface carries the tier-2 facts:
 * `GET /model_info` (the single-model catalog: `reasoning_parser`,
 * `has_image_understanding`, …) and `GET /server_info` (the resolved
 * `server_args` + the runtime-true
 * `internal_states[].memory_usage.token_capacity`).
 *
 * REGISTRY POSITION (C9): FIRST. SGLang serves a DEGRADED Ollama-compat
 * `/api/*` surface (`/api/show` hardcodes `capabilities:["completion"]` —
 * useless, docs/provider-details.md §3.5) and may answer `/api/version` with the Ollama
 * shape, so a route pointed at SGLang would otherwise be claimed by the
 * Ollama backend and receive those degraded Ollama rows. Probing SGLang's
 * authoritative `/model_info` BEFORE Ollama is what fixes that (a behavior
 * CHANGE for such routes: the fix, not a regression).
 *
 * SERVER-WIDE SCOPE (§5.3, documented limitation): every value mapped here
 * is a SERVER-wide fact (`reasoning_parser`, `has_image_understanding`,
 * `server_args.context_length`, `internal_states[0]…token_capacity`) and is
 * applied to EVERY catalog entry — single-model servers are the norm and
 * SGLang's OpenAI surface answers for the one served model. Per-model
 * divergence (a multi-worker gateway whose workers disagree) is OUT OF
 * SCOPE for v1, exactly like llama-server's router-mode default slot.
 *
 * SHAPE (the Ollama-discovery discipline): this module holds the probes + the pure
 * mappers and imports NOTHING from the channel; fetch is injectable and
 * every function is fail-soft — a network error, non-2xx response, or
 * malformed JSON degrades per field/row and detection degrades to a
 * verdict; NOTHING here ever throws into the channel (C6). The
 * `/model_info` body is fetched ONCE by `detect` and carried to
 * `metadataRows` through `facts.modelInfo` (C4-friendly: enrichment never
 * re-fetches it). `/server_info` is fetched only when ≥1 catalog entry
 * lacks a positive `max_model_len` (the contextWindow fallback chain's
 * last two steps need it) — one fetch, no alias fallback (the
 * `/get_server_info` alias is not probed: the chain failing just stops at
 * the entry value, §5.5). The route's apiKey rides EVERY fetch (C7 —
 * SGLang's `--api-key` protects ALL endpoints when set, docs/provider-details.md §3.5).
 *
 * Detection (§5.1, C10): `GET {origin}/model_info` — match = 200 with a
 * non-empty-string `model_path` or `served_model_name` (the verified
 * response shape's markers; a stricter non-empty-string gate keeps a
 * lookalike 200 from false-positiving). The deprecated alias
 * `GET {origin}/get_model_info` is tried ONCE, and ONLY when the new name
 * answered 404 (an old server may serve the alias alone). 404/405/401 (or
 * any other well-formed 4xx, or a 200 whose body lacks both markers) on
 * the probe(s) = DEFINITIVE non-match; 5xx / network / abort =
 * INCONCLUSIVE (not evidence — the channel's memo evicts and retries).
 * `ctx.entries` are deliberately UNUSED here (no free catalog signal
 * exists — SGLang's catalog is bare): unlike the catalog-first backends
 * (llama.cpp, vLLM) this detection is probe-only, one request in the common
 * case,
 * two only on the 404-alias path.
 *
 * Version skew (docs/provider-details.md §3.5): the last five `/model_info` fields
 * (`reasoning_parser` … `architectures`) are recent-main additions (issue
 * #16075) — every field is probed per-field (absent → omit), never
 * assumed. A 0.4.x-era body still matches detection (it carries
 * `model_path`/`served_model_name`) and maps nothing but the context
 * chain — the per-field probe discipline.
 */

import type { CanonicalModelFields } from "../types.js";
import type {
  BackendRows,
  BackendVerdict,
  DiscoveryBackend,
  DiscoveryContext,
} from "./backends.js";
import { isPlainObject } from "../resolve/canonical.js";
import { toPositiveInt } from "./metadata.js";
import type { OpenAIModelEntry } from "./types.js";
import { ollamaOrigin } from "./ollama.js";

/**
 * `GET /model_info` response — the subset §5.3 consumes, with unknown keys
 * tolerated (the live response also carries `tokenizer_path`,
 * `is_generation`, `weight_version`, `load_format`, `tool_call_parser`,
 * `has_audio_understanding`, `model_type`, `architectures`, which v1 does
 * not read). Fields are typed `unknown` and narrowed fail-soft at use: any
 * shape surprise degrades to "field absent", never an error.
 */
export interface SglangModelInfoResponse {
  /** Absolute model path on the server — detection gate half 1 (§5.1). */
  model_path?: unknown;
  /** The served model name — detection gate half 2 (§5.1). */
  served_model_name?: unknown;
  /**
   * The server-wide reasoning parser name (e.g. `"deepseek-r1"`).
   * Consumed: non-empty ⇒ `reasoning: true` (§5.3). The NAME itself is
   * NEVER emitted (no `thinkingLevelMap`, no `compat` — C5: the parser
   * vocabulary is preset-authoring input for a future plan).
   */
  reasoning_parser?: unknown;
  /**
   * `true` ⇒ `input: ["text","image"]`; `false` ⇒ `["text"]`; ABSENT
   * (0.4.x-era server, issue #16075) ⇒ the field is omitted (per-field
   * probe discipline — never invent a modality the server didn't state).
   */
  has_image_understanding?: unknown;
  /**
   * Deliberately UNUSED in v1: `has_audio_understanding` has no pi
   * modality spelling (`ModelModality` is `"text" | "image"`) — ignored,
   * exactly like Ollama's `audio` capability.
   */
  has_audio_understanding?: unknown;
  /**
   * `tool_call_parser` + `model_type` + `architectures`: tolerated, UNREAD
   * — compat keying is preset-authoring territory (future plan, §5.3).
   */
  [key: string]: unknown;
}

/**
 * `GET /server_info` response — resolved `server_args` +
 * `internal_states[]` (docs/provider-details.md §3.5). Consumed: `server_args.context_length`
 * and `internal_states[0].memory_usage.token_capacity`, the last two steps
 * of the contextWindow chain. The raw jinja `chat_template` /
 * `hf_chat_template_name` / `default_chat_template_kwargs` are
 * CAPTURED-OUT-OF-SCOPE (preset authoring, future plan — not shipped, not
 * logged), like llama-server's `chat_template`.
 */
export interface SglangServerInfoResponse {
  /** The resolved launch arguments (consumed: `context_length`). */
  server_args?: unknown;
  /** Runtime scheduler states (consumed: `[0].memory_usage.token_capacity`). */
  internal_states?: unknown;
  [key: string]: unknown;
}

/** Injectable fetch options (the probe.ts / Ollama-discovery discipline). */
export interface SglangFetchOptions {
  /** Injectable fetch (defaults to `globalThis.fetch` — stubbed in tests). */
  fetchImpl?: typeof fetch;
  /** Caller's abort signal (the handler's signal aborts the probes). */
  signal?: AbortSignal;
  /**
   * Bearer key for the route (C7): SGLang's `--api-key` protects ALL
   * endpoints when set (only `/health*`/`/metrics` are exempt), so the key
   * rides `/model_info`, `/get_model_info`, AND `/server_info`.
   */
  apiKey?: string;
}

/** One HTTP GET answer, shaped for the C10 verdict rules. */
interface SglangAnswer {
  /** The HTTP status (any status = a well-formed answer about the endpoint). */
  status: number;
  /** 2xx (the `Response.ok` spelling). */
  ok: boolean;
  /** The parsed JSON body; `undefined` when the body was not JSON. */
  body?: unknown;
}

/**
 * `GET {origin}/model_info` / `GET {origin}/server_info` — one JSON GET
 * with the C7 auth header. Never throws: a network failure / abort
 * resolves `undefined` (NO answer — the C10 inconclusive case); a response
 * of ANY status resolves the answer (a malformed fetchImpl result — no
 * `Response` at all — also degrades to `undefined`: nothing usable was
 * observed). A 2xx with an unparseable body resolves `{ ok: true, body:
 * undefined }` — the shape gate then fails it (a 200 answer that isn't
 * SGLang's shape is DEFINITIVE evidence of not-SGLang, the
 * answered-is-definitive rule).
 */
async function sglangGetJson(
  url: string,
  options: SglangFetchOptions,
): Promise<SglangAnswer | undefined> {
  const { fetchImpl = globalThis.fetch, signal, apiKey } = options;
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...(apiKey !== undefined ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      signal,
    });
    if (!response) return undefined;
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    return { status: response.status, ok: response.ok, body };
  } catch {
    // No answer at all (network failure / abort) — never evidence (C10).
    return undefined;
  }
}

/**
 * The `model_info` shape gate (§5.1): a JSON object carrying a
 * non-empty-string `model_path` OR `served_model_name`. Anything else
 * (non-object, both markers absent/empty/non-string) → `undefined` — a
 * lookalike 200 (e.g. an OpenAI models-list wrapper on a proxying origin)
 * is a definitive non-match, never a match.
 */
function asModelInfo(payload: unknown): SglangModelInfoResponse | undefined {
  if (!isPlainObject(payload)) return undefined;
  const modelPath = payload.model_path;
  const servedModelName = payload.served_model_name;
  const hasPath = typeof modelPath === "string" && modelPath.length > 0;
  const hasServed = typeof servedModelName === "string" && servedModelName.length > 0;
  return hasPath || hasServed ? (payload as SglangModelInfoResponse) : undefined;
}

/**
 * The SGLang backend-detection probe result (§5.1). A definitive verdict
 * distinguishes "not SGLang" from "no answer" so the channel's memo can
 * retry the latter without re-probing the former.
 */
export interface SglangDetectionProbe {
  /** `GET {origin}/model_info` (or the alias) answered the SGLang shape. */
  isSglang: boolean;
  /**
   * The probe got NO usable answer (network failure / abort / 5xx): NOT
   * evidence — the caller may retry. A response of any other status is
   * definitive (only SGLang serves this endpoint's shape).
   */
  inconclusive?: boolean;
  /** The matched `/model_info` body (cached into `facts.modelInfo` — C4). */
  modelInfo?: SglangModelInfoResponse;
}

/**
 * Probes `GET {origin}/model_info` for the SGLang backend (§5.1). The
 * deprecated alias `GET {origin}/get_model_info` is tried ONCE, and ONLY
 * when the new name answered 404 (an old SGLang serves only the alias; any
 * other non-match — 405, 401, a wrong-shape 200 — is already definitive).
 * Never throws: any failure resolves a non-SGLang verdict (`inconclusive`
 * when no usable answer arrived — a failed probe is not evidence against
 * SGLang), so detection failure silently falls back to the generic path.
 *
 * @param origin - Server origin WITHOUT the `/v1` suffix (the same
 *   normalization as Ollama's, `{@link ollamaOrigin}` — shared seam).
 */
export async function probeSglangModelInfo(
  origin: string,
  options: SglangFetchOptions = {},
): Promise<SglangDetectionProbe> {
  const base = origin.replace(/\/$/, "");
  const primary = await sglangGetJson(`${base}/model_info`, options);
  if (primary === undefined || primary.status >= 500) {
    // No answer (network/abort) or a server error: INCONCLUSIVE — the
    // caller may retry (C10; the alias is NOT tried: a 5xx from the new
    // name is not a 404, and one retryable probe is one retryable probe).
    return { isSglang: false, inconclusive: true };
  }
  if (primary.ok) {
    const modelInfo = asModelInfo(primary.body);
    return modelInfo !== undefined
      ? { isSglang: true, modelInfo }
      : { isSglang: false };
  }
  // A well-formed non-answer from the new name. The alias fallback fires
  // ONLY on a 404 ("if (and only if) the new name 404s", §5.1): an old
  // SGLang that never had /model_info. 405/401/anything else is definitive.
  if (primary.status !== 404) return { isSglang: false };
  const alias = await sglangGetJson(`${base}/get_model_info`, options);
  if (alias === undefined || alias.status >= 500) {
    return { isSglang: false, inconclusive: true };
  }
  if (alias.ok) {
    const modelInfo = asModelInfo(alias.body);
    return modelInfo !== undefined
      ? { isSglang: true, modelInfo }
      : { isSglang: false };
  }
  // 404/405/401/… on BOTH names: a well-formed non-answer — DEFINITIVE no
  // (C10). This is also the llama-swap router guard: a proxying origin
  // serves neither name, so it can never false-positive this backend.
  return { isSglang: false };
}

/**
 * Fetches `GET {origin}/server_info` (§5.2 — the ONE extra enrichment
 * fetch, issued only by the caller that first checked it is needed).
 * Fail-soft: a network error, abort, non-2xx, or non-object body resolves
 * `undefined` — the contextWindow chain simply stops at the entry value
 * (§5.5), nothing else is affected. The `/get_server_info` alias is NOT
 * probed (one fetch total for this endpoint; see the module header).
 */
export async function fetchSglangServerInfo(
  origin: string,
  options: SglangFetchOptions = {},
): Promise<SglangServerInfoResponse | undefined> {
  const answer = await sglangGetJson(
    `${origin.replace(/\/$/, "")}/server_info`,
    options,
  );
  if (answer === undefined || !answer.ok) return undefined;
  return isPlainObject(answer.body) ? (answer.body as SglangServerInfoResponse) : undefined;
}

/**
 * The contextWindow fallback steps 2-3 (§5.3): `server_args.context_length`
 * first, then `internal_states[0].memory_usage.token_capacity` (the
 * runtime-true `max_total_num_tokens` — last resort), each through
 * `toPositiveInt`, first positive wins; else `undefined`. Pure, fail-soft
 * per level: any malformed shape degrades to "step absent", never an error.
 */
export function sglangServerInfoContextWindow(
  serverInfo: SglangServerInfoResponse | undefined,
): number | undefined {
  if (serverInfo === undefined) return undefined;
  const serverArgs = isPlainObject(serverInfo.server_args)
    ? serverInfo.server_args
    : undefined;
  const fromArgs = serverArgs !== undefined ? toPositiveInt(serverArgs.context_length) : undefined;
  if (fromArgs !== undefined) return fromArgs;
  const states = Array.isArray(serverInfo.internal_states)
    ? serverInfo.internal_states
    : undefined;
  const state = states?.[0];
  if (isPlainObject(state)) {
    const usage = isPlainObject(state.memory_usage) ? state.memory_usage : undefined;
    const capacity = usage !== undefined ? toPositiveInt(usage.token_capacity) : undefined;
    if (capacity !== undefined) return capacity;
  }
  return undefined;
}

/**
 * Pure mapper: one `/v1/models` entry + the server-wide facts → the
 * discovered canonical fields (§5.3), fail-soft per field — an absent
 * field simply falls through to tier 3/4:
 *
 * - `reasoning: true` ⟺ `reasoning_parser` is a non-empty string (the
 *   server-wide flag; absent/empty ⇒ the field is ABSENT — never `false`).
 * - `input` ⟺ `has_image_understanding`: `true` → `["text","image"]`,
 *   `false` → `["text"]`, ABSENT (0.4.x-era) → omitted. The canonical
 *   order is text-first (`CanonicalModelFields.input`).
 * - `contextWindow` — the three-step chain, first positive integer wins
 *   (through `toPositiveInt`): (1) the ENTRY's `max_model_len` (free —
 *   the catalog already carried it, no fetch), (2) the server-wide
 *   `server_args.context_length`, (3) the runtime-true
 *   `internal_states[0].memory_usage.token_capacity`. An entry that
 *   carries its own positive `max_model_len` never consults the
 *   server-wide steps; when `serverInfo` is `undefined` (not needed, or
 *   the fetch failed — §5.5) the chain simply stops at the entry value.
 * - NEVER `thinkingLevelMap` / `compat` / `maxTokens` (C5, §5.3 — the
 *   `ReasoningEffortTier` literal is static per model, the parser names +
 *   `default_chat_template_kwargs` are preset-authoring input for a
 *   future plan, and output limits are undiscoverable here).
 *
 * Returns `undefined` when nothing usable was advertised (the row keeps
 * NO `discoveredCanonical` — C4's "enriched, nothing found" spelling).
 * Never throws.
 */
export function sglangModelInfoToCanonical(
  entry: OpenAIModelEntry,
  modelInfo: SglangModelInfoResponse,
  serverInfo?: SglangServerInfoResponse,
): CanonicalModelFields | undefined {
  const canonical: CanonicalModelFields = {};

  const parser = modelInfo.reasoning_parser;
  if (typeof parser === "string" && parser.length > 0) canonical.reasoning = true;

  // Strict boolean probes: a non-boolean (or absent) value is "no signal"
  // (per-field probe discipline) — omit, never guess.
  if (modelInfo.has_image_understanding === true) canonical.input = ["text", "image"];
  else if (modelInfo.has_image_understanding === false) canonical.input = ["text"];

  const contextWindow =
    toPositiveInt(entry.max_model_len) ??
    sglangServerInfoContextWindow(serverInfo);
  if (contextWindow !== undefined) canonical.contextWindow = contextWindow;

  return Object.keys(canonical).length > 0 ? canonical : undefined;
}

/**
 * Pure seam beside `discoverMetadataRow` (§5.3): the discovered rows for an
 * SGLANG route — the SERVER-WIDE facts applied to EVERY entry (single-model
 * servers are the norm; per-model divergence is out of scope, module
 * header). C4 FULL-replacement semantics: the matched backend enriches
 * every row, so EVERY entry id is present in the result — an entry whose
 * mapping found nothing maps to `undefined` ("enriched, nothing found" —
 * the row keeps no `discoveredCanonical`). Pure (no I/O, never throws).
 */
export function sglangRowsById(
  entries: readonly OpenAIModelEntry[],
  modelInfo: SglangModelInfoResponse,
  serverInfo?: SglangServerInfoResponse,
): Map<string, CanonicalModelFields | undefined> {
  const byId = new Map<string, CanonicalModelFields | undefined>();
  for (const entry of entries) {
    byId.set(entry.id, sglangModelInfoToCanonical(entry, modelInfo, serverInfo));
  }
  return byId;
}

/** The SGLang backend (registry order: FIRST — C9). */
export const sglangBackend: DiscoveryBackend = {
  id: "sglang",
  detect(ctx: DiscoveryContext): Promise<BackendVerdict> {
    return probeSglangModelInfo(ollamaOrigin(ctx.baseUrl), {
      apiKey: ctx.apiKey,
      signal: ctx.signal,
      fetchImpl: ctx.fetchImpl,
    }).then((probe) => {
      if (probe.inconclusive) return { match: false, inconclusive: true };
      if (!probe.isSglang) return { match: false };
      // C4: the matched body is CACHED into facts — metadataRows reads it
      // and never re-fetches /model_info.
      return { match: true, facts: { modelInfo: probe.modelInfo } };
    });
  },
  async metadataRows(
    entries: readonly OpenAIModelEntry[],
    ctx: DiscoveryContext,
    facts: Record<string, unknown> | undefined,
  ): Promise<BackendRows> {
    // §5.5: /model_info malformed → ALL-GENERIC. (Detection would have
    // failed first, so this path is reachable only via a malformed shape
    // that slipped past the gate or a caller that dropped the facts.)
    const modelInfo =
      facts !== undefined && isPlainObject(facts.modelInfo)
        ? (facts.modelInfo as SglangModelInfoResponse)
        : undefined;
    if (modelInfo === undefined) return { byId: new Map() };
    // The one OPTIONAL enrichment fetch (§5.2): /server_info is fetched
    // ONLY when ≥1 entry lacks a positive max_model_len — the last two
    // steps of its contextWindow chain need it. Entries that carry their
    // own positive value never cost a fetch.
    const needsServerInfo = entries.some(
      (entry) => toPositiveInt(entry.max_model_len) === undefined,
    );
    const serverInfo = needsServerInfo
      ? await fetchSglangServerInfo(ollamaOrigin(ctx.baseUrl), {
          apiKey: ctx.apiKey,
          signal: ctx.signal,
          fetchImpl: ctx.fetchImpl,
        })
      : undefined;
    // C4: the matched backend enriches EVERY entry — each id is present
    // (an undefined value = "enriched, nothing found": the row keeps no
    // discoveredCanonical); the wire row's `name` stays the catalog's.
    return { byId: sglangRowsById(entries, modelInfo, serverInfo) };
  },
};