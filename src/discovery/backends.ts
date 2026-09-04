/**
 * The discovery-backend seam (contract C1–C12, docs/design.md
 * "The discovery backends"):
 * the shared contract for the tier-2 DISCOVERY BACKENDS — server dialects
 * (Ollama, SGLang, LM Studio, llama.cpp llama-server, vLLM, …) that expose
 * capability metadata beyond a bare OpenAI `/v1/models` (plus, eventually,
 * richer routers).
 *
 * The channel (src/dsh/channel.ts `handleDiscoverMetadata`) is backend-
 * AGNOSTIC: it fetches the `/v1/models` catalog once, probes the registry
 * ({@link discoveryBackends}) in order until the first DEFINITIVE match
 * (detection memoized per route identity × backend — the Ollama-discovery discipline),
 * and asks the matched backend to ENRICH the catalog rows. No match, or a
 * backend that degrades (fail-soft — C6), keeps the generic
 * `discoverMetadataRow` rows as-is. The endpoint fails
 * ONLY when the catalog fetch failed.
 *
 * The contract (locked):
 *
 * - **C2** — detection verdicts distinguish a DEFINITIVE no (a well-formed
 *   non-match: the shape gate saw the answer and it is not this dialect —
 *   memoized for the handler's lifetime) from INCONCLUSIVE (network
 *   failure / abort: not evidence — the memo evicts and the next call
 *   retries). A definitive non-match never stops the scan (one origin
 *   serves one server, but "not Ollama" is not "not vLLM"); the first
 *   match owns the enrichment.
 * - **C4** — the wire row contract is INVARIANT: a backend's
 *   {@link BackendRows.byId} entry REPLACES the row's `discoveredCanonical`
 *   (FULL replacement — exactly the Ollama backend's semantics; the backend owns what it
 *   emits, including which entry-derived fields to fold in). `byId.has(id)`
 *   = the backend enriched that row (even with an `undefined` value =
 *   "enriched, nothing found" — the row keeps no `discoveredCanonical`);
 *   absent = the generic row passes through untouched. The row's `name`
 *   always comes from the catalog entry (the generic row's).
 * - **C5** — what no backend may emit (v1): never `maxTokens`; never
 *   `compat` (single named exception: llama-server's
 *   `compat.supportsReasoningEffort` boolean gate — a declared template
 *   fact, not an invented capability); a `thinkingLevelMap` may only list
 *   levels the server itself enumerates (1:1 with its vocabulary),
 *   `null` for unlisted levels (pi-ai clamps client-side), and NO map at
 *   all when the server cannot enumerate levels; an all-null-for-on-levels
 *   map is forbidden.
 * - **C6** — fail-soft everywhere: a backend NEVER throws into the channel
 *   and NEVER fails the endpoint; detection degrades to a verdict
 *   (inconclusive on network, definitive-no on a well-formed non-match);
 *   enrichment degrades per-model (the affected ids keep generic rows).
 * - **C7** — the route's apiKey (resolved by the channel) rides every fetch
 *   the backend makes (the unguarded-endpoint exceptions are documented per
 *   backend in the plan).
 * - **C10** — detection may use {@link DiscoveryContext.entries} (free
 *   catalog signals) BEFORE any fetch; a fetch-based probe is ONE request;
 *   404/405/401 on the probe = DEFINITIVE non-match; 5xx / network /
 *   abort = INCONCLUSIVE.
 */
import type { CanonicalModelFields } from "../types.js";
import type { OpenAIModelEntry } from "./types.js";
import { sglangBackend } from "./sglang.js";
import { ollamaBackend } from "./ollama.js";
import { lmstudioBackend } from "./lmstudio.js";
import { vllmBackend } from "./vllm.js";
import { llamacppBackend } from "./llamacpp.js";

// The registry's member backends, re-exported from the registry's single
// surface (pinned-registry tests import their backends from here).
export { sglangBackend, ollamaBackend, lmstudioBackend, vllmBackend, llamacppBackend };

/** Everything a backend may consult (no raw route object — the channel
 *  resolves the env key and normalizes the base URL first). */
export interface DiscoveryContext {
  /** Normalized OpenAI base URL (ends in `/v1`). */
  baseUrl: string;
  /** Bearer key resolved from the route's apiKeyEnv (absent = no key). */
  apiKey?: string;
  /** The handler's abort signal (the backend must honor it). */
  signal?: AbortSignal;
  /**
   * The already-fetched `/v1/models` entries — FREE detection signals
   * (owned_by, entry-shape markers). Always present; a backend may decide
   * from it without any fetch.
   */
  entries: readonly OpenAIModelEntry[];
  /** Injectable fetch for tests (the Ollama `fetchImpl` discipline). */
  fetchImpl?: typeof fetch;
}

/** One backend's detection verdict for the route's origin (C2/C10). */
export interface BackendVerdict {
  /** Does this origin serve this backend? Meaningful only when not inconclusive. */
  match: boolean;
  /** Network failure / abort: NOT evidence — the channel's memo evicts and retries. */
  inconclusive?: boolean;
  /** Backend-specific detection facts carried to `metadataRows` (e.g. Ollama's version). */
  facts?: Record<string, unknown>;
}

/** One backend's enrichment output (C4). */
export interface BackendRows {
  /**
   * Per-wire-id FULL canonical object for that row. `has(id)` = enriched
   * (even with an `undefined` value); absent = the channel keeps the
   * generic row as-is.
   */
  byId: Map<string, CanonicalModelFields | undefined>;
  /** Note message-bodies; the channel logs each under the route line. */
  notes?: readonly string[];
}

/** The tier-2 discovery backend (C1). */
export interface DiscoveryBackend {
  /** Stable id (the detection memo key, logs). */
  id: string;
  /** Detect whether the route's origin serves this backend (C10). Never throws. */
  detect(ctx: DiscoveryContext): Promise<BackendVerdict>;
  /**
   * Enrich the catalog rows for this origin (C4/C5/C6). Called only after a
   * DEFINITIVE match. Never throws; per-model failures keep the generic row.
   */
  metadataRows(
    entries: readonly OpenAIModelEntry[],
    ctx: DiscoveryContext,
    facts: Record<string, unknown> | undefined,
  ): Promise<BackendRows>;
}

/**
 * THE registry (C9 — the order is LOCKED): SGLang first (it serves
 * an Ollama-compat surface that could shadow real Ollama detection — its
 * authoritative surface is probed first), Ollama second (incumbent), then
 * the free (catalog-derived) detections. Adding a backend = one import +
 * one array entry, at its locked position.
 */
export const discoveryBackends: readonly DiscoveryBackend[] = [sglangBackend, ollamaBackend, lmstudioBackend, vllmBackend, llamacppBackend];
