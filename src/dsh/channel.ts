/**
 * modelspoke — dsh node half: the loopback RPC channel `/modelspoke`.
 *
 * The client↔server bridge for the discovered-catalog metadata: the
 * host Connection service is a
 * generic, bundle-open RPC-channel registry — `connection.rpc.handle`
 * registers one absolute channel prefix over the active web server, fenced
 * by `{ authority: "loopback" }` (403 off-loopback, the same fence as
 * `/api`). The browser half calls the same endpoint through
 * `ctx.connection.rpc.call` (src/dsh/client.tsx — the provider card's
 * model-detail seeding).
 *
 * Endpoints (channel `/modelspoke`; endpoint segments carry no hyphens —
 * the host pattern is /^[A-Za-z0-9_$.-]+$/):
 *
 * - `discoverMetadata` (payload `{ provider: string }`) →
 *     `{ ok: true, value: { models: Array<{ id: string; name?: string;
 *     discoveredCanonical?: CanonicalModelFields }> } }`
 *   The DISCOVERED catalog metadata for one route (the qwen3.8 fix): the
 *   dsh `llm.discoverModels` wire view carries only id/name/
 *   contextWindow/maxTokens (its schema strips the rest), so the DISCOVERED
 *   `thinkingLevelMap` / `input` / `reasoning` / `compat` reach the browser
 *   half here, where the model DETAIL seeds its EFFECTIVE display
 *   (committed ∪ discovered), enriched through the discovery-backend
 *   scan (the registry semantics: docs/design.md ("Moved from code");
 *   {@link handleDiscoverMetadata}).
 *
 * Errors are the closed RpcError union returned as the result slot (the
 * host's channel wrapper validates the result against the RpcResult
 * schema — a thrown handler becomes an opaque 500 whose body the client
 * discards, so business failures ride the result, never a throw):
 * missing/malformed inputs → `bad-request` (the message names what is
 * missing); everything unexpected (including a discovery fetch failure) →
 * `internal`.
 *
 * Activation-order safety: `connection` does not exist in tui/headless
 * profiles (no web server), so it must never be a static `inject`
 * dependency. The channel reads it lazily (`ctx.get("connection")` —
 * undefined while unprovided, cordis reflect `get`) and registers at the
 * first moment it appears: once at `apply`, plus a `{ global: true }`
 * listener on the `internal/service` event (emitted by `ctx.provide` for
 * service notifications from ANY fiber — cordis events.ts 'internal/
 * service', the loader's own activation-order idiom). When `connection`
 * never appears (headless) the channel is a silent no-op and the profile
 * boots exactly as before.
 */

import type { Context } from "@deepseek-ai/cordis";
import {
  discoveryBackends,
  type BackendVerdict,
  type DiscoveryBackend,
  type DiscoveryContext,
} from "../discovery/backends.js";
import { extractFromEntry, fetchModels } from "../discovery/index.js";
import { normalizeRouteBaseUrl } from "../discovery/url.js";
import type { OpenAIModelEntry } from "../discovery/types.js";
import type { CanonicalModelFields, ModelspokeRoute } from "../types.js";
import { routesOf } from "./settings.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}


/**
 * The wire result slot: the host validates the handler's return against
 * RpcResult (ok/value | ok/error with the closed error-code union), so the
 * channel speaks the same shape as `/api`.
 */
type RpcResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string; details: Record<string, unknown> } };

const badRequest = (message: string): RpcResult => ({
  ok: false,
  error: { code: "bad-request", message, details: { issues: [] } },
});
const internal = (message: string): RpcResult => ({
  ok: false,
  error: { code: "internal", message, details: {} },
});

// The qwen3.8 fix: the dsh `llm.discoverModels` wire view carries only
// id/name/contextWindow/maxTokens (its zod schema strips the rest), so the
// DISCOVERED `thinkingLevelMap` / `input` / `reasoning` / `compat` reach the
// browser half through THIS endpoint instead (module header). The mapping is
// a pure seam so the row contract is unit-tested without a live fetch.

/** One `discoverMetadata` response row: a discovered catalog model. */
export interface DiscoveredMetadataModel {
  /** The wire id (the `/v1/models` entry's `id`). */
  id: string;
  /** The endpoint-supplied display name (absent when the server supplied none). */
  name?: string;
  /**
   * The FULL canonical object actually discovered from this entry
   * (`input`, `reasoning`, `contextWindow`, `maxTokens`, `thinkingLevelMap`,
   * `compat` — the fields the server advertised). Absent when the server
   * advertised nothing (bare servers).
   */
  discoveredCanonical?: CanonicalModelFields;
}

/**
 * The `discoverMetadata` row mapping (the qwen3.8 fix): one raw `/v1/models`
 * entry → the wire row. Runs the tier-2 extractor ({@link extractFromEntry})
 * and projects to the wire contract (`id`, `name?`, `discoveredCanonical?`
 * — the full canonical object). The server-internal `rawMeta` diagnostic is
 * NOT sent. Pure (no I/O) so the row contract is unit-testable without a
 * live fetch — the handler is the thin I/O wrapper around this seam.
 *
 * This is the GENERIC provider row; an OLLAMA route's rows are built by the
 * Ollama seam `ollamaMetadataRows` (src/discovery/ollama.ts) instead, which
 * falls back to this mapping for rows whose `/api/show` failed (decision 9).
 */
export function discoverMetadataRow(entry: OpenAIModelEntry): DiscoveredMetadataModel {
  const info = extractFromEntry(entry);
  return {
    id: info.id,
    ...(info.name !== undefined ? { name: info.name } : {}),
    ...(info.discoveredCanonical !== undefined ? { discoveredCanonical: info.discoveredCanonical } : {}),
  };
}

/** Structural view of the host Connection service (node half; the full
 *  type lives in dsh-client-connection, which the node half does not import). */
interface HostConnectionLike {
  rpc: {
    handle(
      channel: string,
      handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<RpcResult>,
      options: { authority: "loopback" | "trusted-host" },
    ): unknown;
  };
}

export interface ChannelDeps {
  /** The node half's current resolved `modelspoke:` section thunk. */
  section: () => unknown;
  log: (line: string) => void;
  /**
   * The discovery backend registry (C3): defaults to
   * {@link discoveryBackends}; tests pin a subset (e.g. the Ollama backend
   * alone) to keep fetch-count assertions stable as the registry grows.
   */
  backends?: readonly DiscoveryBackend[];
}

/**
 * Register the `/modelspoke` loopback channel when (and only when) the
 * host Connection service is present: a silent no-op in tui/headless
 * profiles, idempotent across activation orders (module header).
 */
export function installModelspokeChannel(ctx: Context, deps: ChannelDeps): void {
  let installed = false;
  const install = (): void => {
    if (installed) return;
    const connection = ctx.get("connection") as HostConnectionLike | undefined;
    if (connection === undefined) return;
    try {
      connection.rpc.handle(
        "/modelspoke",
        makeChannelHandler(deps),
        { authority: "loopback" },
      );
      installed = true;
      deps.log("modelspoke: /modelspoke loopback RPC channel registered (discoverMetadata)");
    } catch (error) {
      deps.log(
        `modelspoke: RPC channel registration failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  install();
  // `connection` may be provided after this plugin's apply ran — the
  // { global: true } listener receives service notifications from any fiber.
  ctx.on(
    "internal/service",
    (name: string) => {
      if (name === "connection") install();
    },
    { global: true },
  );
}

/** The channel handler over the single endpoint (see module header). */
export function makeChannelHandler(
  deps: ChannelDeps,
): (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<RpcResult> {
  // Memoized `/v1/models` per route identity (baseURL + key env) — the SAME
  // discipline as the adapter's `discover` (src/dsh/adapter.ts): a failed
  // fetch is evicted so the next call retries; the memoized promise outlives
  // any single caller's signal by design. Scoped to THIS channel install
  // (one handler per install — a fresh install gets a fresh cache).
  const discovery = new Map<string, Promise<OpenAIModelEntry[]>>();
  const discoverEntries = (
    route: ModelspokeRoute,
    signal?: AbortSignal,
  ): Promise<OpenAIModelEntry[]> => {
    const baseUrl = normalizeRouteBaseUrl(route.baseURL);
    const key = `${baseUrl}\u0000${route.apiKeyEnv ?? ""}`;
    let promise = discovery.get(key);
    if (!promise) {
      const apiKey = route.apiKeyEnv
        ? process.env[route.apiKeyEnv] || undefined
        : undefined;
      promise = fetchModels(baseUrl, apiKey, signal).catch((error) => {
        discovery.delete(key);
        throw error;
      });
      discovery.set(key, promise);
    }
    return promise;
  };

  // (C2): the backend registry scan — each backend's detection,
  // memoized per route identity × backend (the SAME `${baseUrl}\u0000${apiKeyEnv}`
  // key as the entries cache, extended with the backend id) — one probe per
  // backend per route fetch identity, not per call. A DEFINITIVE verdict
  // (match or a well-formed non-match) is kept for the handler's lifetime;
  // an INCONCLUSIVE probe (network error / abort) is evicted so the next
  // call retries — no answer is not evidence (C2/C10). The scan stops at
  // the FIRST match (a definitive non-match keeps scanning — "not Ollama"
  // is not "not vLLM"); no match → `undefined` (the generic rows).
  const detections = new Map<string, Promise<BackendVerdict>>();
  const detectBackend = async (
    route: ModelspokeRoute,
    entries: readonly OpenAIModelEntry[],
    signal?: AbortSignal,
  ): Promise<{ backend: DiscoveryBackend; facts: Record<string, unknown> | undefined } | undefined> => {
    const baseUrl = normalizeRouteBaseUrl(route.baseURL);
    const apiKey = route.apiKeyEnv ? process.env[route.apiKeyEnv] || undefined : undefined;
    for (const backend of deps.backends ?? discoveryBackends) {
      const key = `${baseUrl}\u0000${route.apiKeyEnv ?? ""}\u0000${backend.id}`;
      let verdict = detections.get(key);
      if (!verdict) {
        const dctx: DiscoveryContext = { baseUrl, ...(apiKey !== undefined ? { apiKey } : {}), ...(signal !== undefined ? { signal } : {}), entries };
        verdict = backend.detect(dctx).then((v) => {
          if (v.inconclusive) detections.delete(key);
          return v;
        });
        detections.set(key, verdict);
      }
      const v = await verdict;
      if (v.inconclusive) continue;
      if (v.match) return { backend, facts: v.facts };
      // definitive non-match: keep scanning the registry (C2).
    }
    return undefined;
  };

  return async (endpoint, payload, signal) => {
    if (endpoint === "discoverMetadata")
      return handleDiscoverMetadata(deps, payload, signal, discoverEntries, detectBackend);
    return badRequest(`unknown /modelspoke endpoint: ${endpoint}`);
  };
}

/**
 * `discoverMetadata` (the qwen3.8 fix) — the route's DISCOVERED catalog
 * metadata (module header). The route is looked up by `provider`; an unknown
 * provider is a closed `bad-request` (on the result slot, never a throw).
 * The fetch rides the memoize-per-route-identity seam ({@link makeChannelHandler}
 * `discoverEntries`); a fetch failure is a closed `internal` (the client
 * treats it like its catalog-fetch failure and seeds the detail from the
 * committed baseline only).
 *
 * (C2): the route is scanned against the DISCOVERY BACKEND REGISTRY —
 * the first DEFINITIVE match owns the enrichment (detection memoized per
 * route identity × backend by the caller); the backend's `byId` REPLACES
 * `discoveredCanonical` per enriched id (the registry's FULL-replacement semantics — C2),
 * an id it left un-enriched keeps the generic row, and its `notes` bodies
 * are logged under the route line. No match — or a backend that degrades
 * (backends are fail-soft, C6) — keeps the generic rows as-is.
 */
async function handleDiscoverMetadata(
  deps: ChannelDeps,
  payload: unknown,
  signal: AbortSignal | undefined,
  discoverEntries: (route: ModelspokeRoute, signal?: AbortSignal) => Promise<OpenAIModelEntry[]>,
  detectBackend: (
    route: ModelspokeRoute,
    entries: readonly OpenAIModelEntry[],
    signal?: AbortSignal,
  ) => Promise<{ backend: DiscoveryBackend; facts: Record<string, unknown> | undefined } | undefined>,
): Promise<RpcResult> {
  if (!isPlainObject(payload) || typeof payload.provider !== "string" || payload.provider.length === 0) {
    return badRequest("discoverMetadata: the payload must be { provider: <route name> }");
  }
  const provider = payload.provider;
  const route = routesOf(deps.section()).find((r) => r.name === provider);
  if (route === undefined) {
    return badRequest(`discoverMetadata: no modelspoke route named "${provider}"`);
  }
  let entries: OpenAIModelEntry[];
  try {
    entries = await discoverEntries(route, signal);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.log(`modelspoke: discoverMetadata for route "${provider}" failed: ${message}`);
    return internal(`discoverMetadata: ${message}`);
  }

  // The registry scan. No backend claims the origin (or every verdict
  // was inconclusive) → the generic rows; the endpoint fails only if
  // /v1/models failed above (the invariant — decision 9).
  const hit = await detectBackend(route, entries, signal);
  let models: DiscoveredMetadataModel[];
  if (hit === undefined) {
    models = entries.map(discoverMetadataRow);
  } else {
    const baseUrl = normalizeRouteBaseUrl(route.baseURL);
    const apiKey = route.apiKeyEnv ? process.env[route.apiKeyEnv] || undefined : undefined;
    const ectx: DiscoveryContext = {
      baseUrl,
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...(signal !== undefined ? { signal } : {}),
      entries,
    };
    let byId: Map<string, CanonicalModelFields | undefined> = new Map();
    let notes: readonly string[] | undefined;
    try {
      const rows = await hit.backend.metadataRows(entries, ectx, hit.facts);
      byId = rows.byId;
      notes = rows.notes;
    } catch (error) {
      // A backend NEVER throws (C6) — belt and braces: degrade to the
      // generic rows rather than fail the endpoint.
      deps.log(
        `modelspoke: discoverMetadata for route "${provider}": backend "${hit.backend.id}" failed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    models = entries.map((entry) => {
      const generic = discoverMetadataRow(entry);
      if (!byId.has(entry.id)) return generic;
      const enriched = byId.get(entry.id);
      return {
        id: entry.id,
        ...(generic.name !== undefined ? { name: generic.name } : {}),
        ...(enriched !== undefined ? { discoveredCanonical: enriched } : {}),
      };
    });
    for (const note of notes ?? []) {
      deps.log(`modelspoke: discoverMetadata for route "${provider}": ${note}`);
    }
  }
  deps.log(`modelspoke: discoverMetadata for route "${provider}": ${models.length} models`);
  return { ok: true, value: { models } };
}

