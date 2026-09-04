/**
 * The Ollama native `/api/*` tier-2 discovery backend (contract
 * C1–C12 in docs/design.md, "The discovery backends"; the Ollama-specific
 * rules — the dotted-version detection gate, per-model `/api/show`, the
 * curated family table, the `requires` version gate — live there and in
 * docs/provider-details.md §2).
 *
 * WHY: an Ollama provider's `/v1/models` is bare (id/created/owned_by only,
 * note §1.5) — the generic extractor yields nothing, so reasoning/input/
 * contextWindow resolve entirely from preset/default. Ollama's native
 * surface carries every tier-2 fact: per-model `capabilities` (the exact
 * accept/reject gate for the think params), GGUF `context_length`, and the
 * modelfile `PARSER` line that keys the family table.
 *
 * Shape (decision 10 — metadata path only): this module holds the probe +
 * the pure mappers and imports NOTHING from the channel; `src/dsh/channel.ts`
 * detects Ollama once per route (memoized with the entries cache) and, when
 * the origin is Ollama, fetches one `POST /api/show {"model": <wire id>}`
 * per model (concurrency cap 4, the handler's signal aborts the batch) and
 * builds the rows through the pure seam {@link ollamaMetadataRows} beside
 * `discoverMetadataRow`. The generic path stays for non-Ollama providers and
 * for rows whose show failed (decision 9). The runtime resolver and the pi
 * surface are untouched.
 *
 * Fail-soft discipline (decision 9, the probe.ts rule): every function is
 * fetch-injectable and never throws — a network error, non-2xx response, or
 * malformed JSON degrades per field/row exactly as decided, and detection
 * failure silently falls back to the generic path. `maxTokens` is NEVER
 * emitted (undiscoverable on Ollama — no output-limit metadata, note §4.1)
 * and neither is `compat` (pi-ai's detected default for openai-completions
 * is already `supportsReasoningEffort: true`). `/api/ps` and modelfile
 * `num_ctx` are OUT of scope for v1 (decision 3 — refinements; the GGUF max
 * is the reported `contextWindow`).
 */

import type { CanonicalModelFields } from "../types.js";
import type {
  BackendRows,
  BackendVerdict,
  DiscoveryBackend,
  DiscoveryContext,
} from "./backends.js";
import { isPlainObject } from "../resolve/canonical.js";
import { extractFromEntry, extractName, toPositiveInt } from "./metadata.js";
import type { OpenAIModelEntry } from "./types.js";
import { ollamaThinkingLevelMapFor } from "./ollama-families.js";

/**
 * `POST /api/show` response — the subset decision 3 consumes, with unknown
 * keys tolerated (the live response also carries `license`, `parameters`,
 * `template`, `tensors`, `modified_at`, which v1 does not read). Fields are
 * typed `unknown` and narrowed fail-soft at use: any shape surprise degrades
 * to "field absent", never an error.
 */
export interface OllamaShowResponse {
  /** `capabilities: string[]` — the authoritative capability list (note §1.3). */
  capabilities?: unknown;
  /** GGUF KV dump keyed `"<family>.<key>"` (note §1.3). */
  model_info?: unknown;
  /** Consumed: `family` (decision 4), `remote_host` (cloud provenance, decision 2). */
  details?: unknown;
  /** The modelfile text — consumed: the `PARSER <name>` line (decision 5). */
  modelfile?: unknown;
  /** Minimum server version for the model's renderer/parser (decision 7). */
  requires?: unknown;
  /**
   * v2 note, deliberately UNUSED in v1 (decision 8): regime-3 hf.co pulls
   * carry the one real jinja template `/api/show` exposes (note §1.3) —
   * preset-matching territory (decision 12).
   */
  template?: unknown;
  [key: string]: unknown;
}

/** Injectable fetch options (the probe.ts discipline, decision 9). */
export interface OllamaFetchOptions {
  /** Injectable fetch (defaults to `globalThis.fetch` — stubbed in tests). */
  fetchImpl?: typeof fetch;
  /** Caller's abort signal (decision 3: the handler's signal aborts the batch). */
  signal?: AbortSignal;
}

/** Per-model canonical mapping options. */
export interface OllamaShowMappingOptions {
  /** The dotted server version from `/api/version` (the decision-7 gate half). */
  serverVersion?: string;
}

/** The decision-3 show-batch concurrency cap. */
export const OLLAMA_SHOW_CONCURRENCY = 4;

/**
 * The Ollama `/api/version` answer shape: a dotted numeric version
 * (`{"version":"0.32.15"}`, note §1.1 — at least two numeric segments, the
 * observed Ollama spelling). Anything else ⇒ not Ollama (decision 1).
 */
const DOTTED_VERSION_SHAPE = /^\d+\.\d+(?:\.\d+)*$/;

/**
 * Strips the trailing `/v1` from an ALREADY-NORMALIZED route base
 * (`normalizeRouteBaseUrl` output — the same normalization the adapter's
 * `discover` runs) to get the server ORIGIN the native `/api/*` endpoints
 * hang off (decision 1). A base that does not end in `/v1` (defensive —
 * `normalizeRouteBaseUrl` always appends it) is returned without a trailing
 * slash, so `http://host:11434/v1` → `http://host:11434`.
 */
export function ollamaOrigin(routeBase: string): string {
  const base = routeBase.replace(/\/$/, "");
  return base.endsWith("/v1") ? base.slice(0, -3) : base;
}

/**
 * The Ollama backend-detection probe result (decision 1). A definitive
 * verdict distinguishes "not Ollama" from "no answer" so the channel's memo
 * can retry the latter without re-probing the former.
 */
export interface OllamaVersionProbe {
  /** `GET {origin}/api/version` answered `{"version":"<dotted>"}` ⇒ Ollama. */
  isOllama: boolean;
  /** The dotted server version, kept for the `requires` gate (decision 7). */
  version?: string;
  /**
   * The probe got NO answer (network failure / abort): the "not Ollama"
   * verdict is INCONCLUSIVE and the caller may retry. A response of any
   * status is definitive — only Ollama serves this endpoint's shape.
   */
  inconclusive?: boolean;
}

/**
 * Probes `GET {origin}/api/version` for the Ollama backend (decision 1).
 * Never throws: any failure resolves a non-Ollama verdict (`inconclusive`
 * when no answer arrived at all — a failed probe is not evidence against
 * Ollama), so detection failure silently falls back to the generic path.
 *
 * @param origin - Server origin WITHOUT the `/v1` suffix (see
 *   {@link ollamaOrigin}).
 */
export async function probeOllamaVersion(
  origin: string,
  options: OllamaFetchOptions = {},
): Promise<OllamaVersionProbe> {
  const { fetchImpl = globalThis.fetch, signal } = options;
  const url = `${origin.replace(/\/$/, "")}/api/version`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal,
    });
  } catch {
    // No answer at all (network failure / abort) — an INCONCLUSIVE verdict:
    // the caller may retry (evicting the memo), a failed probe is not
    // evidence of "not Ollama" (decision 9: silent generic fallback).
    return { isOllama: false, inconclusive: true };
  }
  // A server that ANSWERED is definitive evidence about the backend: only
  // Ollama serves `{"version":"<dotted>"}` here, so any other response
  // (non-2xx, non-JSON, wrong shape — including a malformed fetchImpl result)
  // settles the route as not-Ollama.
  if (!response || !response.ok) {
    return { isOllama: false };
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { isOllama: false };
  }
  const version = isPlainObject(payload) ? payload.version : undefined;
  if (typeof version !== "string" || !DOTTED_VERSION_SHAPE.test(version)) {
    return { isOllama: false };
  }
  return { isOllama: true, version };
}

/**
 * Fetches one model's native metadata: `POST {origin}/api/show` with
 * `{"model": <wire id>}` (decision 3 — the wire id is the catalog/wire
 * identity, unchanged per decision 2). Unknown model → HTTP 404 (note
 * §1.3). Never throws: a network error, non-2xx response, or non-object
 * body resolves `undefined` (the row then falls back to the generic path,
 * decision 9).
 */
export async function ollamaShow(
  origin: string,
  model: string,
  options: OllamaFetchOptions = {},
): Promise<OllamaShowResponse | undefined> {
  const { fetchImpl = globalThis.fetch, signal } = options;
  const url = `${origin.replace(/\/$/, "")}/api/show`;
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ model }),
      signal,
    });
    if (!response.ok) {
      return undefined;
    }
    const payload: unknown = await response.json();
    return isPlainObject(payload) ? (payload as OllamaShowResponse) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Fetches `/api/show` for every model id with a concurrency cap of 4
 * (decision 3). Failures are per-model (the id is simply absent from the
 * result — the row falls back to the generic path); the caller's `signal`
 * aborts the batch (no new fetches are issued once aborted; in-flight ones
 * settle fail-soft). Never throws.
 */
export async function ollamaShowBatch(
  origin: string,
  models: readonly string[],
  options: OllamaFetchOptions = {},
): Promise<Map<string, OllamaShowResponse>> {
  const shows = new Map<string, OllamaShowResponse>();
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (options.signal?.aborted) return;
      const index = cursor;
      cursor += 1;
      if (index >= models.length) return;
      const model = models[index] as string;
      const show = await ollamaShow(origin, model, options);
      if (show !== undefined) shows.set(model, show);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(OLLAMA_SHOW_CONCURRENCY, models.length) }, worker),
  );
  return shows;
}

/** Parses a dotted-numeric version, or undefined when it is not one. */
function parseDotted(version: string): number[] | undefined {
  const trimmed = version.trim();
  if (!/^\d+(?:\.\d+)*$/.test(trimmed)) return undefined;
  return trimmed.split(".").map((segment) => Number.parseInt(segment, 10));
}

/**
 * The decision-7 version gate: `true` when the SERVER is older than the
 * model's `requires` (dotted-numeric compare, missing segments = 0). Either
 * side missing or unparseable → no gate (no evidence of skew; the gate skips
 * engine-behavior evidence, so it only fires on a positive comparison).
 */
export function isVersionGated(requires: unknown, serverVersion: unknown): boolean {
  if (typeof requires !== "string" || typeof serverVersion !== "string") return false;
  const needed = parseDotted(requires);
  const running = parseDotted(serverVersion);
  if (needed === undefined || running === undefined) return false;
  const width = Math.max(needed.length, running.length);
  for (let index = 0; index < width; index += 1) {
    const need = needed[index] ?? 0;
    const have = running[index] ?? 0;
    if (need !== have) return have < need;
  }
  return false;
}

/** Non-empty string field of the `details` block (fail-soft). */
function detailString(show: OllamaShowResponse, key: string): string | undefined {
  if (!isPlainObject(show.details)) return undefined;
  const value = (show.details as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** String values of the `capabilities` list (fail-soft: non-array → empty). */
function capabilitiesOf(show: OllamaShowResponse): Set<string> {
  return new Set(
    Array.isArray(show.capabilities)
      ? show.capabilities.filter((value): value is string => typeof value === "string")
      : [],
  );
}

/** The `model_info` KV dump (fail-soft: non-object → undefined). */
function modelInfoOf(show: OllamaShowResponse): Record<string, unknown> | undefined {
  return isPlainObject(show.model_info) ? (show.model_info as Record<string, unknown>) : undefined;
}

/** The modelfile `PARSER <name>` directive (note §1.3), fail-soft. */
export function ollamaModelfileParser(show: OllamaShowResponse): string | undefined {
  if (typeof show.modelfile !== "string") return undefined;
  return /^\s*PARSER\s+(\S+)\s*$/im.exec(show.modelfile)?.[1];
}

/**
 * Cloud provenance (decision 2): `details.remote_host` present (the
 * `/api/tags` provenance shape) or a `:cloud` id suffix. On live 0.32.15 the
 * cloud `/api/show` response carries NO `remote_host` (only
 * `details`/`model_info`/`capabilities`/`modified_at`), so the id suffix is
 * the operative signal there.
 */
function isCloudModel(id: string, show: OllamaShowResponse): boolean {
  return detailString(show, "remote_host") !== undefined || id.endsWith(":cloud");
}

/** The pure per-model mapping result ({@link ollamaShowToCanonical}). */
export interface OllamaCanonicalMapping {
  /** The discovered canonical fields (absent when nothing usable was advertised). */
  discoveredCanonical?: CanonicalModelFields;
  /** Decision 7: the server is older than the model's `requires`. */
  gated?: boolean;
}

/**
 * Pure mapper: one wire id + one `/api/show` payload → the discovered
 * canonical fields (decision 4), fail-soft per field — an absent field
 * simply falls through to tier 3/4:
 *
 * - `reasoning: true` ⟺ `capabilities` ∋ `"thinking"` — the exact
 *   accept/reject gate for the think params (both directions live-verified,
 *   note §2.1); otherwise the field is ABSENT (never `false` here).
 * - `input: ["text","image"]` ⟺ `capabilities` ∋ `"vision"` — from
 *   `/api/show` ONLY (tags under-reports embedded vision/audio towers, note
 *   §1.2/§2.4); no vision ⇒ the field is absent. `audio` has no pi modality
 *   spelling (note §4.1) and is ignored.
 * - `contextWindow` = `model_info["<family>.context_length"]` with
 *   `<family>` = `details.family` (positive-int coercion); a model that
 *   spells no family gets no context — no invented prefix matching.
 * - `thinkingLevelMap` = the family table (decision 5,
 *   `./ollama-families.js`) — keyed on the modelfile `PARSER` line with the
 *   `details.family` fallback, cloud entries on cloud provenance; NEVER from
 *   the parser's uniform acceptance. The map is emitted only for
 *   thinking-capable models (the capability list is the server's own think
 *   gate, note §2.1 — a non-thinking model accepts nothing to map) and only
 *   when the server is not below the model's `requires` (decision 7:
 *   capability fields survive, the engine-behavior map does not, one caller
 *   log line).
 *
 * `maxTokens` / `compat` are NEVER emitted (decision 4 — undiscoverable /
 * already pi-ai's detected default). Never throws.
 */
export function ollamaShowToCanonical(
  id: string,
  show: OllamaShowResponse,
  options?: OllamaShowMappingOptions,
): OllamaCanonicalMapping {
  const canonical: CanonicalModelFields = {};
  const capabilities = capabilitiesOf(show);

  if (capabilities.has("thinking")) canonical.reasoning = true;
  if (capabilities.has("vision")) canonical.input = ["text", "image"];

  const family = detailString(show, "family");
  if (family !== undefined) {
    const contextWindow = toPositiveInt(modelInfoOf(show)?.[`${family}.context_length`]);
    if (contextWindow !== undefined) canonical.contextWindow = contextWindow;
  }

  const gated = isVersionGated(show.requires, options?.serverVersion);
  if (!gated && capabilities.has("thinking")) {
    const thinkingLevelMap = ollamaThinkingLevelMapFor({
      parser: ollamaModelfileParser(show),
      family,
      isCloud: isCloudModel(id, show),
    });
    if (thinkingLevelMap !== undefined) canonical.thinkingLevelMap = thinkingLevelMap;
  }

  return {
    ...(Object.keys(canonical).length > 0 ? { discoveredCanonical: canonical } : {}),
    ...(gated ? { gated: true } : {}),
  };
}

/**
 * One `discoverMetadata` row. Structurally the channel's
 * `DiscoveredMetadataModel` — defined HERE (not imported) so this module
 * stays free of channel imports (decision 10).
 */
export interface OllamaMetadataRow {
  /** The wire id (the `/v1/models` entry's `id`). */
  id: string;
  /** The endpoint-supplied display name (absent when the server supplied none). */
  name?: string;
  /** The full canonical object discovered for this id (absent when none). */
  discoveredCanonical?: CanonicalModelFields;
}

/** The pure seam's result: the wire rows plus the decision-7 gated ids. */
export interface OllamaRowsResult {
  /** The rows, in entry order. */
  rows: OllamaMetadataRow[];
  /**
   * Ids whose family map the `requires` gate skipped (decision 7 — the
   * caller logs ONE line naming them).
   */
  gated: string[];
}

/**
 * Pure seam beside `discoverMetadataRow` (decision 10): the discovered
 * catalog rows for an OLLAMA route — one `/api/show` payload per entry
 * (`shows`, the successful subset of the batch) mapped through
 * {@link ollamaShowToCanonical}. An entry whose show FAILED (absent from
 * `shows`) falls back to the generic mapping — its
 * `extractFromEntry`-based row, the projection `discoverMetadataRow`
 * performs, re-implemented here to keep the channel import out — and the
 * rest of the batch is unaffected (decision 9). Pure (no I/O, never
 * throws); order follows the entries.
 */
export function ollamaMetadataRows(
  entries: readonly OpenAIModelEntry[],
  shows: ReadonlyMap<string, OllamaShowResponse>,
  options?: OllamaShowMappingOptions,
): OllamaRowsResult {
  const rows: OllamaMetadataRow[] = [];
  const gated: string[] = [];
  for (const entry of entries) {
    const show = shows.get(entry.id);
    if (show === undefined) {
      const info = extractFromEntry(entry);
      rows.push({
        id: info.id,
        ...(info.name !== undefined ? { name: info.name } : {}),
        ...(info.discoveredCanonical !== undefined
          ? { discoveredCanonical: info.discoveredCanonical }
          : {}),
      });
      continue;
    }
    const mapping = ollamaShowToCanonical(entry.id, show, options);
    if (mapping.gated) gated.push(entry.id);
    const name = extractName(entry);
    rows.push({
      id: entry.id,
      ...(name !== undefined ? { name } : {}),
      ...(mapping.discoveredCanonical !== undefined
        ? { discoveredCanonical: mapping.discoveredCanonical }
        : {}),
    });
  }
  return { rows, gated };
}

/** The Ollama backend (registry order: second — SGLang probes first, C9). */
export const ollamaBackend: DiscoveryBackend = {
  id: "ollama",
  detect(ctx: DiscoveryContext): Promise<BackendVerdict> {
    // Defense-in-depth (docs/provider-details.md §3.1,
    // [verified-live] against v250): the llama-swap router answers Ollama's
    // own /api/version PATH with its build info — `{"version":"v250",…}`.
    // "v250" fails the dotted-version shape gate today (definitive no), a
    // one-character-class near-miss: if llama-swap ever dotted that value
    // the probe would false-positive on every router route. The router's
    // AUTHORED catalog settles the origin as not-Ollama with zero fetches
    // (llama-swap never routes /api/show, so there is no Ollama surface
    // behind the router to discover).
    if (
      ctx.entries.some(
        (entry) =>
          (isPlainObject(entry.meta) && "llamaswap" in entry.meta) ||
          entry.owned_by === "llama-swap",
      )
    ) {
      return Promise.resolve({ match: false });
    }
    return probeOllamaVersion(ollamaOrigin(ctx.baseUrl), {
      signal: ctx.signal,
      fetchImpl: ctx.fetchImpl,
    }).then((probe) => {
      if (probe.inconclusive) return { match: false, inconclusive: true };
      if (!probe.isOllama) return { match: false };
      return {
        match: true,
        facts: probe.version !== undefined ? { version: probe.version } : {},
      };
    });
  },
  async metadataRows(
    entries: readonly OpenAIModelEntry[],
    ctx: DiscoveryContext,
    facts: Record<string, unknown> | undefined,
  ): Promise<BackendRows> {
    const serverVersion =
      typeof facts?.version === "string" ? facts.version : undefined;
    const shows = await ollamaShowBatch(
      ollamaOrigin(ctx.baseUrl),
      entries.map((entry) => entry.id),
      { signal: ctx.signal, fetchImpl: ctx.fetchImpl },
    );
    const { rows, gated } = ollamaMetadataRows(entries, shows, {
      serverVersion,
    });
    // C4: `byId` carries the FULL canonical for the rows whose show
    // SUCCEEDED (rows follow entry order); a failed show is ABSENT — the
    // channel keeps that id's generic row as-is (decision 9).
    const byId = new Map<string, CanonicalModelFields | undefined>();
    rows.forEach((row, index) => {
      const entry = entries[index];
      if (entry !== undefined && shows.has(entry.id)) {
        byId.set(entry.id, row.discoveredCanonical);
      }
    });
    const notes =
      gated.length > 0 && serverVersion !== undefined
        ? [
            `server ${serverVersion} is older than ${gated.length} model(s)' requires; ` +
              `thinkingLevelMap skipped for: ${gated.join(", ")}`,
          ]
        : undefined;
    return { byId, ...(notes !== undefined ? { notes } : {}) };
  },
};