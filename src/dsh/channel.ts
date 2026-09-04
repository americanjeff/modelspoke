/**
 * modelspoke — dsh node half: the loopback RPC channel `/modelspoke`.
 *
 * The client↔server bridge for onboarding (the readiness probe + the
 * local-provider import) and the discovered-catalog metadata: the
 * host Connection service is a
 * generic, bundle-open RPC-channel registry — `connection.rpc.handle`
 * registers one absolute channel prefix over the active web server, fenced
 * by `{ authority: "loopback" }` (403 off-loopback, the same fence as
 * `/api`). The browser half calls the same endpoints through
 * `ctx.connection.rpc.call` (src/dsh/client.tsx — the onboarding step).
 *
 * Endpoints (channel `/modelspoke`; endpoint segments carry no hyphens —
 * the host pattern is /^[A-Za-z0-9_$.-]+$/):
 *
 * - `onboarding` (payload `{}`) →
 *     `{ ok: true, value: { ready, providers, providerNames } }`
 *   `ready` — the `modelspoke:` section has ≥1 route. `providers` — the
 *   OFFER candidates for the onboarding v2 import (local `llm-pi-ai`
 *   providers as `{ name, baseURL, keySource }`; the keySource
 *   classification rationale: docs/design.md ("Moved from code")).
 *   `providerNames` — the FULL registrable provider-name set for the
 *   client's collision warning: ALL `llm-pi-ai.providers` keys (local or
 *   not) ∪ the current modelspoke route names ∪ the built-in pi-ai catalog
 *   ids (BUILTIN_PI_AI_PROVIDER_NAMES — the distro's bundled catalog,
 *   schema-spiked, not a runtime import).
 *
 * - `provision` (payload `{ name, baseURL, apiKeyEnv? }`) →
 *     `{ ok: true, value: { added: 0 | 1, shadowing? } }`
 *   One existing dsh custom provider → one modelspoke route (full rules:
 *   {@link handleProvision}).
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
 * missing); a fenced write that lost its race → `settings-conflict`;
 * everything unexpected → `internal`.
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
  settingsNamespace,
  SettingsConflictError,
  type SettingsProvider,
} from "@deepseek-ai/dsh-settings";
import {
  discoveryBackends,
  type BackendVerdict,
  type DiscoveryBackend,
  type DiscoveryContext,
} from "../discovery/backends.js";
import { extractFromEntry, fetchModels } from "../discovery/index.js";
import { normalizeRouteBaseUrl } from "../discovery/url.js";
import type { OpenAIModelEntry } from "../discovery/types.js";
import {
  cleanRoutePhantoms,
  foldLegacyOverrides,
  stripMapPhantoms,
  topLevelOverridesOf,
} from "../overrides.js";
import type { CanonicalModelFields, ModelspokeRoute } from "../types.js";
import { renderReadImagesOf, routesOf } from "./settings.js";

const NS = settingsNamespace("modelspoke");
const LLM_PI_AI_NS = settingsNamespace("llm-pi-ai");

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The `onboarding` readiness facts (see module header for the contract). */
export interface OnboardingFacts {
  ready: boolean;
}

/**
 * Pure readiness computation. `section` is the current resolved
 * `modelspoke:` section — ready when it carries ≥1 route (the section page
 * is already usable).
 */
export function computeOnboardingFacts(section: unknown): OnboardingFacts {
  return { ready: routesOf(section).length > 0 };
}

// The custom-provider import: an existing dsh custom provider
// (`llm-pi-ai.providers.*`) becomes a modelspoke route. The pure seams below
// are unit-tested over fake inputs (test/channel.test.ts); the handlers wire
// them to the settings seam + the host credentials service.

/**
 * The built-in pi-ai catalog provider ids THIS dsh distro ships — the
 * third leg of the collision set (schema spike, 2026-08-24): dsh 0.1.1-
 * rc.2 bundles @earendil-works/pi-ai 0.82.1, whose generated catalog
 * (`dist/providers/all.js` `builtinProviders().map(p => p.id)`) yields
 * exactly these 38 ids, and dsh-llm-pi-ai keys its catalog index by them
 * (`catalogProviders()` — a route naming one is a catalog route whose
 * endpoint/protocol/catalog the profile overrides field by field). A
 * modelspoke route named after any of them lands in that family's shadow
 * (the all-or-nothing registration finding).
 *
 * Hardcoded, not a runtime import, for two reasons: (1) the collision set
 * must track the DSH-BUNDLED catalog, and this repo's own pi-ai (0.84.2)
 * carries a DIFFERENT generated catalog — importing from the repo dep would
 * silently drift; (2) it keeps the node half's runtime dependency graph
 * unchanged. Re-derive when the distro's pi-ai moves: `node -e
 * "import('<dsh>/node_modules/@earendil-works/pi-ai/dist/providers/all.js').then(m=>console.log(m.builtinProviders().map(p=>p.id).join(' ')))"`.
 */
export const BUILTIN_PI_AI_PROVIDER_NAMES: readonly string[] = [
  "amazon-bedrock",
  "ant-ling",
  "anthropic",
  "azure-openai-responses",
  "cerebras",
  "cloudflare-ai-gateway",
  "cloudflare-workers-ai",
  "deepseek",
  "fireworks",
  "github-copilot",
  "google",
  "google-vertex",
  "groq",
  "huggingface",
  "kimi-coding",
  "minimax",
  "minimax-cn",
  "mistral",
  "moonshotai",
  "moonshotai-cn",
  "nvidia",
  "openai",
  "openai-codex",
  "opencode",
  "opencode-go",
  "openrouter",
  "qwen-token-plan",
  "qwen-token-plan-cn",
  "radius",
  "together",
  "vercel-ai-gateway",
  "xai",
  "xiaomi",
  "xiaomi-token-plan-ams",
  "xiaomi-token-plan-cn",
  "xiaomi-token-plan-sgp",
  "zai",
  "zai-coding-cn",
];

/**
 * The loopback host spellings a WHATWG URL can carry: `127.0.0.1`,
 * `localhost`, and `[::1]` (the bracketed form — a bare `::1` never parses:
 * `new URL("http://::1:8080")` throws, so the bare spelling can only reach
 * the unparseable branch).
 */
const LOOPBACK_HOSTS: readonly string[] = ["127.0.0.1", "localhost", "[::1]"];

/**
 * The local-only offer filter: does the value parse as a URL whose host is
 * loopback? Unparseable, empty, missing, or remote → not an offer candidate
 * (a remote OpenAI-compatible provider is not a modelspoke candidate —
 * modelspoke exists to point at LOCAL servers).
 */
export function isLocalBaseUrl(baseURL: unknown): boolean {
  if (typeof baseURL !== "string" || baseURL.length === 0) return false;
  let url: URL;
  try {
    url = new URL(baseURL);
  } catch {
    return false;
  }
  return (LOOPBACK_HOSTS as readonly string[]).includes(url.hostname);
}

/**
 * How an offer candidate's key is sourced (the R5 credential-ref impedance,
 * decided server-side because only the node half can see the credentials
 * layers): the distro's profile key field is the credential REF (an
 * env-var name, `apiKeyEnv: z.string().role("credential-ref")` — the schema
 * spike, dsh-llm-pi-ai `profile`), and the VALUE behind that name may sit in
 * any of the credentials-local layers (inherited environment — the only one
 * modelspoke's `process.env` read can see — over the `$DSH_HOME/.credentials.yaml`
 * file store the Models page writes, over `.env` fallbacks).
 */
export type ProviderKeySource =
  | { kind: "env"; envVar: string }
  | { kind: "stored" }
  | { kind: "none" };

/** Structural view of the host credentials service (node half; the full
 *  abstract class lives in dsh-credentials, which the node half does not
 *  import). */
interface HostCredentialsLike {
  resolve(ref: string): Promise<{ value: string; source: string } | undefined>;
}

/** The credential-ref grammar (dsh-credentials `REF_PATTERN`). */
const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Classify one provider entry's key. Precedence:
 * - `apiKeyEnv` (a credential REF): resolved through the credentials
 *   service when one is mounted — source layer `"env"` (inherited process
 *   environment) stays `env` (the name maps 1:1 to the route's
 *   `apiKeyEnv`); any other supplying layer (`"file"` = the credentials
 *   store, `"project-env"` / `"user-env"` = the `.env` fallbacks) is
 *   `stored` (modelspoke reads `process.env` only — a copied value is the
 *   green-dot-but-401 state, so the value is NEVER copied into a route).
 *   No service, an unresolvable name, or a name outside the ref grammar →
 *   the optimistic `env` read (the declared intent is env-sourced; nothing
 *   observed says otherwise).
 * - `apiKey` (a literal value field — ABSENT from this distro's profile
 *   schema; the Models card stores typed values through the credentials
 *   service instead): `stored`, kept for forward compatibility.
 * - neither: `none`.
 */
export async function keySourceOf(
  entry: Record<string, unknown>,
  credentials: HostCredentialsLike | undefined,
): Promise<ProviderKeySource> {
  const apiKeyEnv =
    typeof entry.apiKeyEnv === "string" && entry.apiKeyEnv.length > 0
      ? entry.apiKeyEnv
      : undefined;
  if (apiKeyEnv !== undefined) {
    if (credentials !== undefined && CREDENTIAL_REF_PATTERN.test(apiKeyEnv)) {
      try {
        const hit = await credentials.resolve(apiKeyEnv);
        if (hit !== undefined) {
          return hit.source === "env"
            ? { kind: "env", envVar: apiKeyEnv }
            : { kind: "stored" };
        }
      } catch {
        // An unresolvable ref reads as "not set" in dsh-credentials' own
        // semantics — the declared intent is env-sourced.
      }
    }
    return { kind: "env", envVar: apiKeyEnv };
  }
  if (typeof entry.apiKey === "string" && entry.apiKey.length > 0) {
    return { kind: "stored" };
  }
  return { kind: "none" };
}

/** One onboarding-v2 offer candidate (a local `llm-pi-ai` provider). */
export interface OfferedProvider {
  /** The provider key (the `llm-pi-ai.providers` dict key). */
  name: string;
  baseURL: string;
  keySource: ProviderKeySource;
}

/**
 * The offer candidates: every `llm-pi-ai.providers.*` entry whose `baseURL`
 * is loopback-local, in configuration order (entries without a parseable
 * local base URL are skipped, not errored — the offer degrades, never
 * hard-fails).
 */
export async function offeredProviders(
  llmPiAiSection: unknown,
  credentials: HostCredentialsLike | undefined,
): Promise<OfferedProvider[]> {
  const providers = isPlainObject(llmPiAiSection) ? llmPiAiSection.providers : undefined;
  if (!isPlainObject(providers)) return [];
  const out: OfferedProvider[] = [];
  for (const [name, raw] of Object.entries(providers)) {
    if (!isPlainObject(raw)) continue;
    if (!isLocalBaseUrl(raw.baseURL)) continue;
    out.push({ name, baseURL: String(raw.baseURL), keySource: await keySourceOf(raw, credentials) });
  }
  return out;
}

/**
 * The full registrable provider-name set for collision checking: ALL
 * `llm-pi-ai.providers` keys (local or not — a remote provider still
 * registers under its name) ∪ the current modelspoke route names ∪ the
 * built-in catalog ids. Deduplicated, input order preserved (pi-ai keys
 * first, then routes, then built-ins).
 */
export function registrableProviderNames(
  piAiProviderKeys: readonly string[],
  routeNames: readonly string[],
  builtInNames: readonly string[] = BUILTIN_PI_AI_PROVIDER_NAMES,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of [...piAiProviderKeys, ...routeNames, ...builtInNames]) {
    if (name.length > 0 && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/** The `onboarding` response: the readiness facts + the v2 offer set. */
export interface OnboardingResponse extends OnboardingFacts {
  providers: OfferedProvider[];
  providerNames: string[];
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
        makeChannelHandler(ctx, deps),
        { authority: "loopback" },
      );
      installed = true;
      deps.log("modelspoke: /modelspoke loopback RPC channel registered (onboarding, provision, discoverMetadata)");
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

/** The channel handler over the three endpoints (see module header). */
export function makeChannelHandler(
  ctx: Context,
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
    if (endpoint === "onboarding") return handleOnboarding(ctx, deps);
    if (endpoint === "provision") return handleProvision(ctx, deps, payload);
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

/** `onboarding` → readiness facts + the v2 offer set (never hard-fails). */
async function handleOnboarding(ctx: Context, deps: ChannelDeps): Promise<RpcResult> {
  const settings = ctx.get("settings") as SettingsProvider | undefined;
  const llmPiAiSection =
    settings === undefined ? undefined : settings.get(LLM_PI_AI_NS);

  const facts = computeOnboardingFacts(deps.section());

  // The onboarding v2 offer set (local-only candidates + the full
  // registrable name set). Degrades to empty offers, never hard-fails.
  const credentials = ctx.get("credentials") as HostCredentialsLike | undefined;
  const providers = await offeredProviders(llmPiAiSection, credentials);
  const providersObj = isPlainObject(llmPiAiSection) ? llmPiAiSection.providers : undefined;
  const piKeys = isPlainObject(providersObj) ? Object.keys(providersObj) : [];
  const routeNames = routesOf(deps.section()).map((route) => route.name);
  const providerNames = registrableProviderNames(piKeys, routeNames);

  deps.log(
    `modelspoke: onboarding readiness: ready=${String(facts.ready)} ` +
      `llm-pi-ai=${llmPiAiSection === undefined ? "unregistered" : "read"} ` +
      `offers=${providers.map((p) => p.name).join(",") || "none"} providerNames=${providerNames.length}`,
  );
  return { ok: true, value: { ...facts, providers, providerNames } };
}

/**
 * `provision` — one existing dsh custom provider → one modelspoke
 * route. The name is taken EXACTLY as given (no server-side prefix — the
 * `modelspoke-` default is the client's), validated non-empty and slash-free
 * (the route name is the dsh provider key; a slash is the credential-key
 * separator), and the baseURL is normalized on the way in (the stored form
 * is the normalized one, so idempotency compares normalized forms). The
 * same-name rules: identical normalized baseURL →
 * idempotent no-op (`added: 0`, nothing written); different → `bad-request`
 * (reconcile by hand — the import never rewrites an existing route). The
 * shadowing REPORT (not a refusal): a name colliding with a `llm-pi-ai`
 * provider key or a built-in catalog id would leave the other family's
 * provider owning the name (the all-or-nothing registration finding),
 * so the response carries `shadowing: <name>` and the UI decides.
 */
async function handleProvision(
  ctx: Context,
  deps: ChannelDeps,
  payload: unknown,
): Promise<RpcResult> {
  const settings = ctx.get("settings") as SettingsProvider | undefined;
  if (settings === undefined) {
    return internal("the settings service is unavailable; cannot persist the route");
  }
  if (!isPlainObject(payload)) {
    return badRequest("provision: the payload must be an object of the form { name, baseURL, apiKeyEnv? }");
  }
  const { name, baseURL, apiKeyEnv } = payload as Record<string, unknown>;
  if (typeof name !== "string" || name.length === 0) {
    return badRequest("provision: name must be a non-empty string");
  }
  if (name.includes("/")) {
    return badRequest(
      `provision: the route name "${name}" must not contain a slash (it is the provider key)`,
    );
  }
  if (typeof baseURL !== "string" || baseURL.length === 0) {
    return badRequest("provision: baseURL must be a non-empty string");
  }
  let normalized: string;
  try {
    normalized = normalizeRouteBaseUrl(baseURL);
  } catch (error) {
    return badRequest(`provision: ${error instanceof Error ? error.message : String(error)}`);
  }
  let keyEnv: string | undefined;
  if (apiKeyEnv !== undefined) {
    if (typeof apiKeyEnv !== "string" || apiKeyEnv.length === 0) {
      return badRequest("provision: apiKeyEnv must be a non-empty string when present");
    }
    keyEnv = apiKeyEnv;
  }

  const sectionValue = deps.section();
  const current = isPlainObject(sectionValue) ? sectionValue : {};
  const currentRoutes = Array.isArray(current.routes) ? (current.routes as unknown[]) : [];
  // The legacy top-level map (phantom-stripped) folds into the owning
  // route's map on this first section write (see foldLegacyOverrides); the
  // write carries the key only while unclaimed entries remain.
  const currentTop = stripMapPhantoms(topLevelOverridesOf(sectionValue));
  const existing = currentRoutes.find(
    (raw) => isPlainObject(raw) && raw.name === name,
  ) as Record<string, unknown> | undefined;

  // The shadowing report (computed before the no-op return — the state it
  // describes exists whether or not this call writes anything).
  const llmPiAiSection = settings.get(LLM_PI_AI_NS);
  const piProviders = isPlainObject(llmPiAiSection) ? llmPiAiSection.providers : undefined;
  const shadowing =
    (isPlainObject(piProviders) && name in piProviders) ||
    (BUILTIN_PI_AI_PROVIDER_NAMES as readonly string[]).includes(name)
      ? name
      : undefined;

  if (existing !== undefined) {
    let sameBase = false;
    if (typeof existing.baseURL === "string" && existing.baseURL.length > 0) {
      try {
        sameBase = normalizeRouteBaseUrl(existing.baseURL) === normalized;
      } catch {
        sameBase = false; // an unparseable stored baseURL is not the same endpoint
      }
    }
    if (sameBase) {
      deps.log(`modelspoke: provision no-op — route "${name}" already present with the same baseURL`);
      return { ok: true, value: { added: 0, ...(shadowing !== undefined ? { shadowing } : {}) } };
    }
    return badRequest(
      `a modelspoke route named "${name}" already exists with a different baseURL (${String(existing.baseURL)} vs ${normalized}); reconcile it in the Modelspoke section first`,
    );
  }

  const routeEntry: Record<string, unknown> = {
    name,
    baseURL: normalized,
    ...(keyEnv !== undefined ? { apiKeyEnv: keyEnv } : {}),
  };
  const nextRoutes = [
    ...currentRoutes.map((raw) => (isPlainObject(raw) ? cleanRoutePhantoms(raw) : raw)),
    routeEntry,
  ];
  // First-write fold: legacy top-level → the owning route's map (a
  // zero-route section folds everything into the new route — it is then the
  // single route; a multi-route section folds per the curated-list claims).
  const { routes: foldedRoutes, leftover, folded: foldedOverrides } = foldLegacyOverrides({
    routes: nextRoutes,
    overrides: currentTop,
  });
  // Mirror carry: the whole-section replace must not strip the
  // client-owned `renderReadImages` flag — pass it through when present.
  const renderReadImages = renderReadImagesOf(sectionValue);

  // Revision-fenced replace of the WHOLE section; the legacy overrides map
  // folds (above) and stops being written once fully folded.
  const revision = settings
    .describe()
    .find((descriptor) => descriptor.ns === NS)?.revision;
  if (revision === undefined) {
    return internal(`the modelspoke settings namespace is not registered: ${NS}`);
  }
  try {
    await settings.replace(
      NS,
      {
        routes: foldedRoutes,
        ...(Object.keys(leftover).length > 0 ? { overrides: leftover } : {}),
        ...(renderReadImages === undefined ? {} : { renderReadImages }),
      },
      revision,
    );
  } catch (error) {
    if (error instanceof SettingsConflictError) {
      return {
        ok: false,
        error: {
          code: "settings-conflict",
          message: error.message,
          details: { ns: NS, expected: error.expected, actual: error.actual },
        },
      };
    }
    return internal(`persisting the provisioned route failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  deps.log(
    `modelspoke: provisioned provider "${name}" → ${normalized}` +
      `${keyEnv !== undefined ? ` (key env ${keyEnv})` : ""}` +
      `${shadowing !== undefined ? ` [shadows existing provider "${shadowing}"]` : ""}` +
      `${foldedOverrides > 0 ? ` (${foldedOverrides} legacy overrides folded)` : ""} ` +
      `(revision ${revision} → fenced)`,
  );
  return { ok: true, value: { added: 1, ...(shadowing !== undefined ? { shadowing } : {}) } };
}
