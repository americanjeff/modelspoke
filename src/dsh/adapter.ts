/**
 * The modelspoke dsh host adapter — a RAW `LlmAdapter` subclass (NOT
 * `PiAiAdapter`: dynamic user-chosen routes don't fit its static `profiles()`
 * hook). The per-method contracts (listModels / resolveModel / prepareCall /
 * stream) are the docblocks on the methods below.
 *
 * Attribution (hard contract): EVERY provider HTTP request carries
 * `attributionHeaders()` via the per-request `headers` option — the layer
 * that wins over `Model.headers` and provider defaults (docs/dsh-plugin-guidance.md
 * §1.2; proven by test/wire-capture.test.ts).
 * Bearer auth only when the route's `apiKeyEnv` resolves non-empty; keyless
 * routes ride pi-ai's `authorization: null` header suppression (the OpenAI
 * SDK treats an explicitly nulled header as "deliberately omitted") over a
 * sentinel api key, so NO Authorization header goes out.
 */

import {
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
} from "@deepseek-ai/dsh-llm";
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  PreparedAdapterCall,
  StreamChunk,
} from "@deepseek-ai/dsh-llm";
import type { Model as PiModel, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import { discoverModels } from "../discovery/index.js";
import { normalizeRouteBaseUrl } from "../discovery/url.js";
import { resolveModel } from "../resolve/index.js";
import type {
  DiscoveryModelInfo,
  FieldSource,
  FieldSourceMap,
  ModelspokeRoute,
  OverrideEntry,
  ResolvedModel,
  ResolutionResult,
} from "../types.js";
import { entryOverride } from "../overrides.js";
import { toPiContext } from "./context.js";
import type { AttachmentReader } from "./context.js";
import { toStreamChunks } from "./events.js";
import { requestHeaders } from "./headers.js";
import {
  buildPiModel,
  FALLBACK_CONTEXT_WINDOW,
  FALLBACK_MAX_TOKENS,
  FALLBACK_THINKING_LEVEL,
  offeredLevels,
} from "./pi-model.js";
import { toReplayEnvelope } from "./replay.js";
import { defaultEffortForRoute, overrideForRoute, routesOf } from "./settings.js";

/** The reportable fields, in canonical order (log line + description). */
const REPORT_FIELDS = [
  "input",
  "reasoning",
  "contextWindow",
  "maxTokens",
  "thinkingLevelMap",
  "compat",
] as const;

/**
 * One frozen prepareCall generation: everything a dispatch needs, captured
 * together. A settings change after prepareCall returns cannot mix into a
 * dispatch on this generation.
 */
interface Generation {
  provider: string;
  route: ModelspokeRoute;
  baseUrl: string;
  displayName: string;
  resolved: ResolvedModel;
  sources: FieldSourceMap;
  /** The pi-ai Model built from this generation's resolution + route. */
  piModel: PiModel<"openai-completions">;
  /** Per-model default effort (clamped to the offered levels; pi parity). */
  defaultEffort?: ModelThinkingLevel;
}

export interface ModelspokeAdapterOptions {
  /**
   * Read the live `modelspoke:` settings section — the resolved settings-scope
   * value while a settings service is attached, the composition entry
   * otherwise. Called once per operation (never cached across operations).
   */
  settings: () => unknown;
  /** Sink for the resolve-time metadata-source log line (contract). */
  log?: (line: string) => void;
  /**
   * Read the live durable attachment store (host `ctx.get("attachments")`) —
   * called once per dispatch, never cached: a store mounted after adapter
   * construction is picked up without re-registration. Undefined when the
   * host has no attachment service; image blocks then project to
   * deterministic placeholder text instead of sending (guard invariant).
   */
  resolveAttachments?: () => AttachmentReader | undefined;
}

/**
 * pi-ai's own sentinel for "auth rides on the headers, not the key" — used as
 * the placeholder api key on keyless routes (see the module docblock).
 */
const KEYLESS_SENTINEL = "unused";

export class ModelspokeAdapter extends LlmAdapter {
  private readonly settings: () => unknown;
  private readonly log: (line: string) => void;
  private readonly resolveAttachments?: () => AttachmentReader | undefined;
  private readonly discovery = new Map<string, Promise<DiscoveryModelInfo[]>>();

  constructor(options: ModelspokeAdapterOptions) {
    super();
    this.settings = options.settings;
    this.log = options.log ?? (() => {});
    this.resolveAttachments = options.resolveAttachments;
  }

  private routeOf(provider: string): ModelspokeRoute {
    const route = routesOf(this.settings()).find((r) => r.name === provider);
    if (!route) {
      throw new LlmError(`modelspoke: no route registered for provider "${provider}"`, "NO_ADAPTER");
    }
    return route;
  }

  override providerInfo(provider: string): LlmProviderInfo {
    const route = this.routeOf(provider);
    return { id: provider, name: route.name };
  }

  /**
   * Memoized `/v1/models` per route identity (baseURL + key env). A failed
   * fetch is evicted so the next call retries; the memoized promise outlives
   * any single caller's signal by design.
   */
  private discover(route: ModelspokeRoute, signal?: AbortSignal): Promise<DiscoveryModelInfo[]> {
    const key = `${normalizeRouteBaseUrl(route.baseURL)}\u0000${route.apiKeyEnv ?? ""}`;
    let promise = this.discovery.get(key);
    if (!promise) {
      promise = discoverModels(route, signal).catch((error) => {
        this.discovery.delete(key);
        throw error;
      });
      this.discovery.set(key, promise);
    }
    return promise;
  }

  /**
   * The full four-tier resolution for one WIRE id on one route, with the
   * caller-supplied tier-1 override (an EXPLICIT entry's own config, or
   * the FULL_CATALOG dual-shape legacy read — see {@link identify}). A
   * discovery failure degrades (logged) to the remaining tiers — absence is
   * never rejection; preset/default still answer.
   */
  private async resolveFor(
    route: ModelspokeRoute,
    modelId: string,
    userOverride: OverrideEntry | undefined,
    signal?: AbortSignal,
  ): Promise<ResolutionResult & { discovery?: DiscoveryModelInfo; fallbacks: string[] }> {
    let discovery: DiscoveryModelInfo | undefined;
    try {
      const models = await this.discover(route, signal);
      discovery = models.find((m) => m.id === modelId);
    } catch (error) {
      this.log(
        `modelspoke: discovery unavailable for route "${route.name}" (${error instanceof Error ? error.message : String(error)}); resolving from override/preset/default tiers`,
      );
    }
    const { resolved, sources, nothink } = resolveModel({
      modelId,
      userOverride,
      discovery,
    });
    // Invented-capacity report (metadataSource contract): when the pi-ai
    // Model MUST carry a number the resolver left omitted, say which
    // fallback landed.
    const fallbacks: string[] = [];
    if (resolved.contextWindow === undefined) {
      fallbacks.push(`contextWindow: default (fallback ${FALLBACK_CONTEXT_WINDOW})`);
    }
    if (resolved.maxTokens === undefined) {
      fallbacks.push(`maxTokens: default (fallback ${FALLBACK_MAX_TOKENS})`);
    }
    return nothink ? { resolved, sources, nothink: true, discovery, fallbacks } : { resolved, sources, discovery, fallbacks };
  }

  /**
   * The metadataSource reporting contract: one resolve-time log line with
   * per-field source detail (from the resolver's source map) + invented-
   * capacity fallbacks + the nothink marker when tier 1 declared explicit
   * none (the model serves without a reasoning dimension — the per-field
   * sources above show `user` for the declaration's fields).
   */
  private reportSources(
    provider: string,
    modelId: string,
    sources: FieldSourceMap,
    fallbacks: string[],
    nothink = false,
  ): void {
    const detail = REPORT_FIELDS.map((field) => `${field}: ${sources[field] as FieldSource}`).join(" ");
    const extra = fallbacks.length > 0 ? ` ${fallbacks.join("; ")}` : "";
    const nothinkNote = nothink ? " [nothink — user override cleared this model's thinking levels]" : "";
    this.log(`modelspoke: resolved ${provider}/${modelId} — ${detail}${extra}${nothinkNote}`);
  }

  /**
   * The model `description` suffix (contract): `field: source` pairs for
   * every NON-default field — the default tier supplied nothing, so it has
   * nothing to report. Empty when every field is default-sourced.
   */
  private descriptionSuffix(sources: FieldSourceMap): string {
    const parts = REPORT_FIELDS.filter((field) => sources[field] !== "default").map(
      (field) => `${field}: ${sources[field]}`,
    );
    return parts.length > 0 ? ` [modelspoke ${parts.join(", ")}]` : "";
  }

  /**
   * The identity model: the served identity for one (route, requested
   * model):
   *
   * - EXPLICIT route: `model` is the entry NAME (the harness identity) — the
   *   entry is looked up by `name`; not found → NO_MODEL (the route's served
   *   set is closed). `harnessId = entry.name`, `wireId = entry.id` (the
   *   dispatch id + discovery index), tier 1 = the entry's own config, and
   *   the entry's `defaultEffort` (when set) is the model's default effort.
   *   The display is the entry name (the harness identity is the display).
   * - FULL_CATALOG route: `model` is the WIRE id (harness id = wire id,
   *   stable); tier 1 = the dual-shape legacy read (the route's legacy map
   *   PER FIELD over the legacy top-level map — `overrideForRoute`).
   */
  private identify(route: ModelspokeRoute, model: string): {
    harnessId: string;
    wireId: string;
    override: OverrideEntry | undefined;
    display?: string;
    perModelEffort?: string;
  } {
    if (route.models === null) {
      return {
        harnessId: model,
        wireId: model,
        override: overrideForRoute(this.settings(), route.name, model),
        // FULL_CATALOG home for the per-model default: the per-route
        // override entry's dsh-only field (raw - normalization strips it).
        perModelEffort: defaultEffortForRoute(this.settings(), route.name, model),
      };
    }
    const entry = route.models.find((e) => e.name === model);
    if (entry === undefined) {
      throw new LlmError(
        `modelspoke: route "${route.name}" serves no model named "${model}"`,
        "NO_MODEL",
      );
    }
    return {
      harnessId: entry.name,
      wireId: entry.id,
      override: entryOverride(entry),
      display: entry.name,
      perModelEffort:
        typeof entry.defaultEffort === "string" && entry.defaultEffort.length > 0
          ? entry.defaultEffort
          : undefined,
    };
  }

  /** Build the LlmResolvedModelInfo the runtime validates + the pi-ai Model. */
  private toInfo(
    provider: string,
    route: ModelspokeRoute,
    identity: {
      harnessId: string;
      wireId: string;
      override: OverrideEntry | undefined;
      display?: string;
      perModelEffort?: string;
    },
    resolution: ResolutionResult & { discovery?: DiscoveryModelInfo },
  ): { info: LlmResolvedModelInfo; piModel: PiModel<"openai-completions"> } {
    const { resolved, sources, discovery } = resolution;
    // Display: the forced entry name (EXPLICIT) → the legacy cosmetic name
    // (FULL_CATALOG) → the discovery-supplied name → the wire id.
    const name =
      identity.display ?? identity.override?.name ?? discovery?.name ?? identity.wireId;
    // The nothink marker rides to the WIRE model (the BUG-001/002 shim —
    // src/resolve/wire.ts); the DECLARED dimension below (info.reasoning,
    // the effort machinery) stays keyed on resolved.reasoning.
    const piModel = buildPiModel(identity.wireId, resolved, name, route, resolution.nothink === true);
    const info: LlmResolvedModelInfo = {
      provider,
      // The dsh-llm runtime validates `resolved.id === model` — the
      // requested model is the harness identity (entry name / wire id).
      id: identity.harnessId,
      name,
      description: `${name}${this.descriptionSuffix(sources)}`,
      inputModalities: [...resolved.input],
      // The pi-ai Model needs a number; report the invented value through the
      // source contract (log line) — here the runtime's context manager just
      // needs the window.
      context: { contextWindow: resolved.contextWindow ?? FALLBACK_CONTEXT_WINDOW },
      // The resolved maxTokens doubles as the per-request output default
      // (the preset's notes pin it under ctx/2 for no-clamp servers); omit
      // when no tier supplied one so the provider default applies.
      ...(resolved.maxTokens !== undefined ? { defaultMaxTokens: resolved.maxTokens } : {}),
    };
    if (resolved.reasoning) {
      const levels = offeredLevels(piModel);
      // Pi parity: every thinking model carries a determinable default
      // - the per-model `defaultEffort` (explicit entry or per-route
      // override) wins, else the built-in fallback (pi's session
      // default). Both are clamped to the offered levels (pi-ai's
      // `clampThinkingLevel`); a clamp landing on "off" is omitted.
      const perModel = identity.perModelEffort;
      const fallback = clampThinkingLevel(
        piModel,
        (perModel ?? FALLBACK_THINKING_LEVEL) as ModelThinkingLevel,
      );
      info.reasoning = {
        efforts: levels.map((level) => ({
          id: ReasoningEffortId(level),
          name: level.charAt(0).toUpperCase() + level.slice(1),
        })),
        ...(fallback === "off" ? {} : { defaultEffort: ReasoningEffortId(fallback) }),
      };
    }
    return { info, piModel };
  }

  /**
   * Advisory catalog: the route's SERVED SET — EXPLICIT: one row per
   * `models` entry (`info.id = entry.name` — the harness identity; an entry
   * whose wire id the endpoint does not currently serve is still offered);
   * FULL_CATALOG: one row per DISCOVERED catalog model (harness id = wire
   * id, stable). Each row resolved through the full four-tier chain on its
   * WIRE id so it carries the source-suffix description. A discovery
   * failure rejects (the catalog is genuinely unavailable).
   */
  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const route = this.routeOf(provider);
    const models = await this.discover(route); // rejects when the catalog is unavailable
    const byWire = new Map(models.map((m) => [m.id, m]));
    if (route.models === null) {
      // FULL_CATALOG: one row per DISCOVERED catalog model (harness id =
      // wire id, stable); tier 1 is the dual-shape legacy read.
      return models.map((info) => {
        const override = overrideForRoute(this.settings(), route.name, info.id);
        const { resolved, sources } = resolveModel({
          modelId: info.id,
          userOverride: override,
          discovery: info,
        });
        const name = override?.name ?? info.name ?? info.id;
        return {
          provider,
          id: info.id,
          name,
          description: `${name}${this.descriptionSuffix(sources)}`,
          inputModalities: [...resolved.input],
        };
      });
    }
    // EXPLICIT: one row per ENTRY (presence in the list IS the served set —
    // an entry whose wire id the endpoint does not currently serve is still
    // offered; the resolver degrades to the remaining tiers). `info.id` is
    // the entry NAME (the harness identity the selector keys on).
    return route.models.map((entry) => {
      const override = entryOverride(entry);
      const discovery = byWire.get(entry.id);
      const { resolved, sources } = resolveModel({
        modelId: entry.id,
        userOverride: override,
        discovery,
      });
      const name = entry.name;
      return {
        provider,
        id: entry.name,
        name,
        description: `${name}${this.descriptionSuffix(sources)}`,
        inputModalities: [...resolved.input],
      };
    });
  }

  /**
   * Authoritative for one (provider, model): `model` is the entry NAME on
   * an EXPLICIT route (entry not found → NO_MODEL) and the WIRE id on a
   * FULL_CATALOG route (any id: the resolver runs even for ids discovery
   * didn't list); a discovery failure degrades to the remaining tiers
   * (preset/default) rather than rejecting. `info.id` equals the requested
   * `model` (the `normalizeModelInfo` contract), while the built pi-ai
   * Model carries the WIRE id (`piModel.id`) — that is what is dispatched.
   */
  override async resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const route = this.routeOf(provider);
    const identity = this.identify(route, model);
    const resolution = await this.resolveFor(route, identity.wireId, identity.override, signal);
    const { info } = this.toInfo(provider, route, identity, resolution);
    this.reportSources(provider, identity.harnessId, resolution.sources, resolution.fallbacks, resolution.nothink === true);
    return info;
  }

  /**
   * The generation freeze (spec): resolution + route facts + the built pi-ai
   * Model are captured in ONE generation; `prepared.stream` dispatches from
   * that generation alone.
   */
  override async prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<PreparedAdapterCall> {
    const route = this.routeOf(provider);
    const identity = this.identify(route, model);
    const resolution = await this.resolveFor(route, identity.wireId, identity.override, signal);
    const { info, piModel } = this.toInfo(provider, route, identity, resolution);
    const generation: Generation = {
      provider,
      route,
      baseUrl: normalizeRouteBaseUrl(route.baseURL),
      displayName: info.name,
      resolved: resolution.resolved,
      sources: resolution.sources,
      piModel,
      ...info.reasoning?.defaultEffort === undefined
        ? {}
        : { defaultEffort: String(info.reasoning.defaultEffort) as ModelThinkingLevel },
    };
    this.reportSources(provider, identity.harnessId, resolution.sources, resolution.fallbacks, resolution.nothink === true);
    return {
      model: info,
      stream: (options) => this.streamGeneration(options, generation),
    };
  }

  /**
   * The abstract entry point: one prepareCall + dispatch on its generation.
   * (The LlmRuntime's own stream path calls `prepareCall` directly; this
   * keeps direct `adapter.stream(options)` use — e.g. the Tier-2 driver —
   * on the same generation-frozen path.)
   */
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const prepared = await this.prepareCall(options.provider, options.model, options.signal);
    yield* prepared.stream(options);
  }

  /**
   * Dispatch one call on one frozen generation.
   *
   * Effort: pi-parity chain - `options.reasoningEffort` when the caller
   * named one (the runtime has already materialized the model default
   * there), else the generation's captured default, else the built-in
   * fallback (`FALLBACK_THINKING_LEVEL`). The result is clamped to the
   * model's offered levels (pi-ai's `clampThinkingLevel`); a result of
   * `off` means no effort is sent.
   */
  private async *streamGeneration(
    options: GenerateOptions,
    generation: Generation,
  ): AsyncIterable<StreamChunk> {
    if (options.stop !== undefined) {
      throw new LlmError("modelspoke does not support GenerateOptions.stop", "UNSUPPORTED_OPTION");
    }
    const effort = this.resolveEffort(options, generation);
    const apiKey = generation.route.apiKeyEnv
      ? process.env[generation.route.apiKeyEnv] || undefined
      : undefined;

    // Abort plumbing: our controller dies when the consumer stops iterating
    // (or when the stream completes), cancelling the in-flight HTTP request;
    // the caller's signal aborts it from the other side.
    const consumer = new AbortController();
    const upstream =
      options.signal === undefined ? consumer.signal : AbortSignal.any([options.signal, consumer.signal]);

    // The context conversion resolves image blocks against the live
    // attachment store (read per dispatch) — or projects undeliverable
    // images to deterministic placeholder text. It never rejects on durable
    // history content (guard invariant: a throw on persisted content kills
    // the thread).
    const context = await toPiContext(options, {
      attachments: this.resolveAttachments?.(),
      signal: upstream,
      log: this.log,
    });

    // Dispatch on the CAPTURED pi-ai Model (generation freeze) — never a
    // rebuild from live settings.
    const piModel = generation.piModel;
    const piStream = openAICompletionsApi().streamSimple(piModel, context, {
      // Bearer ONLY when the route's key env resolves non-empty; otherwise
      // the sentinel key + nulled Authorization header send NO auth header
      // (see module docblock).
      ...(apiKey === undefined ? { apiKey: KEYLESS_SENTINEL } : { apiKey }),
      // `off` is carried as an OMITTED reasoning option (pi-ai's type
      // excludes it); omission is wire-equivalent to explicit off in every
      // thinkingFormat (the kwarg $var bindings key off the request's
      // effective effort, which is absent for off).
      ...(effort === undefined || effort === "off" ? {} : { reasoning: effort }),
      ...options.temperature === undefined ? {} : { temperature: options.temperature },
      ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
      ...options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) },
      signal: upstream,
      // The harness owns retry (dsh-llm-retry); pi-ai must not retry.
      maxRetries: 0,
      // Attribution + (keyless) auth suppression — the winning header layer.
      headers: {
        ...requestHeaders(),
        ...(apiKey === undefined ? { authorization: null } : {}),
      },
    });

    try {
      yield* toStreamChunks(piStream, piModel.contextWindow, toReplayEnvelope);
    } finally {
      consumer.abort();
    }
  }

  /**
   * Resolve the effective effort for one dispatch (pi parity).
   *
   * Chain: `options.reasoningEffort` > the generation's captured per-model
   * default > `FALLBACK_THINKING_LEVEL` (pi's session default). The result
   * is clamped to the model's offered levels (pi-ai's `clampThinkingLevel`
   * - nearest offered level, walking outward in canonical order), so an
   * out-of-list or off-vocabulary level degrades instead of rejecting;
   * `off` means no effort is sent. modelspoke itself never throws
   * UNSUPPORTED_REASONING_EFFORT - the dsh-llm layer still validates
   * caller-supplied efforts against `info.reasoning.efforts`.
   */
  private resolveEffort(
    options: GenerateOptions,
    generation: Generation,
  ): ModelThinkingLevel | undefined {
    const requested =
      options.reasoningEffort !== undefined
        ? String(options.reasoningEffort)
        : (generation.defaultEffort ?? FALLBACK_THINKING_LEVEL);
    const clamped = clampThinkingLevel(generation.piModel,
      requested as ModelThinkingLevel,
    );
    return clamped === "off" ? undefined : clamped;
  }
}
