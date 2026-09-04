/**
 * The plugin-owned `modelspoke:` settings namespace.
 *
 * Contents (the core contract, src/types.ts; per-route reorg; served-set
 * rework):
 *   routes:    [{ name, baseURL, apiKeyEnv?,
 *                models?: <entry[]>?,                   // the SERVED SET:
 *                                                        //  { name, id,
 *                                                        //  …config,
 *                                                        //  defaultEffort? }[]
 *                                                        //  (presence =
 *                                                        //  served);  absent
 *                                                        //  / [] =
 *                                                        //  FULL_CATALOG,
 *                overrides?: { "<wire id>": <entry> }?  // per-wire-id
 *                //  config — meaningful only while the route is
 *                //  FULL_CATALOG (dropped on the first explicit write)]
 *                }]  // providers
 *   overrides: { "<exact model id>": <canonical entry (+ optional name)> }
 *               — the LEGACY top-level location, still readable during the
 *               transition (dual shape; per-field a route's `overrides`
 *               entry wins; the first section write folds it in —
 *               src/overrides.ts).
 *
 * The schemastery schema below is the WRITE gate: it is registered with the
 * settings seam via `installSettingsSection`, so an invalid section is
 * refused where it is written (it accepts the entry-array `models` shape
 * only — a legacy string allow-list is refused; the writer emits the form
 * the in-memory state needs). Read-side extraction ({@link routesOf}) is
 * lenient (skips malformed entries, never throws) — the same posture as the
 * core's `loadOverrides`: invalid values dropped, validation with helpful
 * errors deferred.
 */

import z from "@deepseek-ai/schemastery";
import { normalizeOverrideEntry } from "../config/index.js";
import { decodeRouteModels, effectiveOverrideEntry } from "../overrides.js";
import type { ModelspokeRoute, OverrideEntry } from "../types.js";

/** pi-ai thinking levels; the keys a `thinkingLevelMap` may carry. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** The `thinkingFormat` values pi-ai's OpenAI-completions compat accepts. */
export const THINKING_FORMATS = [
  "openai",
  "openrouter",
  "deepseek",
  "together",
  "baseten",
  "zai",
  "qwen",
  "chat-template",
  "qwen-chat-template",
  "string-thinking",
  "ant-ling",
] as const;

/** `chat_template_kwargs` value: literal, or a pi-controlled `$var` binding. */
const chatTemplateKwarg = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.const(null),
  z.object({
    $var: z.union(["thinking.enabled", "thinking.effort"]).required(),
    omitWhenOff: z.boolean(),
  }),
]);

/**
 * One override entry: canonical fields (all optional — a name-only entry is
 * legal) + display cosmetics. `thinkingLevelMap` is the canonical map OR the
 * `"none"` sentinel — the stored EXPLICIT-NONE (nothink) state: "this
 * endpoint's copy of this model has no selectable thinking levels". The
 * sentinel is a STRING on purpose: the schema-resolved view materializes an
 * ABSENT map to `{}`, so an empty-object store spelling could never be told
 * apart from "unset" at the client read boundary; `"none"` survives
 * resolution unchanged and is never a phantom (src/overrides.ts). The
 * resolver expands it at the tier-1 boundary to `reasoning: false` (a model
 * that serves without a reasoning dimension). `compat` is pi-ai's
 * OpenAICompletionsCompat,
 * all fields optional. The 0.84-only fields are deliberately NOT accepted —
 * `supportsThinkingTokenBudget`, `chatTemplateArgs`, `supportsFinishReason`
 * (present in pi-ai 0.84.2, this package's dev/test dependency, absent from
 * 0.82.1 which dsh bundles): modelspoke targets the pi-ai 0.82 field subset
 * (version-skew rule) and never sets a field a bundled 0.82.1 would not know.
 */
/**
 * The canonical fields every entry shape carries (all optional — a
 * name-only override entry is legal; for a model entry the identity
 * `name` / `id` make the entry meaningful). Shared by the override entry
 * (the legacy top-level / FULL_CATALOG map value) and the model entry
 * (the explicit `models` element) so the two shapes' validation stays one
 * definition.
 */
const canonicalFields = {
  input: z.array(z.union(["text", "image"])),
  reasoning: z.boolean(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  thinkingLevelMap: z.union([
    z.const("none"), // explicit none (the nothink state) — see the entry docblock
    z.dict(z.union([z.string(), z.const(null)]), z.union([...THINKING_LEVELS])),
  ]),
  compat: z.object({
    supportsStore: z.boolean(),
    supportsDeveloperRole: z.boolean(),
    supportsReasoningEffort: z.boolean(),
    supportsUsageInStreaming: z.boolean(),
    maxTokensField: z.union(["max_completion_tokens", "max_tokens"]),
    requiresToolResultName: z.boolean(),
    requiresAssistantAfterToolResult: z.boolean(),
    requiresThinkingAsText: z.boolean(),
    requiresReasoningContentOnAssistantMessages: z.boolean(),
    thinkingFormat: z.union([...THINKING_FORMATS]),
    chatTemplateKwargs: z.dict(chatTemplateKwarg),
    zaiToolStream: z.boolean(),
    supportsOpenAIGrammarTools: z.boolean(),
    supportsStrictMode: z.boolean(),
    cacheControlFormat: z.union(["anthropic"]),
    sendSessionAffinityHeaders: z.boolean(),
    deferredToolsMode: z.union(["kimi"]),
    supportsLongCacheRetention: z.boolean(),
  }),
};

const overrideEntry = z.object({
  name: z.string(),
  ...canonicalFields,
});

/**
 * One model entry (the EXPLICIT `models` element): the harness identity
 * (`name`, required — unique within the provider) + the wire `id` (required)
 * + the per-model default effort (dsh-only, optional) + the canonical
 * fields. A legacy string allow-list is not an accepted element.
 */
const modelEntry = z.object({
  name: z.string().min(1).required(),
  id: z.string().min(1).required(),
  defaultEffort: z.string(),
  ...canonicalFields,
});

/** One modelspoke route (the UI's "provider"): user-chosen key + endpoint facts. */
const route = z.object({
  name: z.string().min(1).required(),
  baseURL: z.string().min(1).required(),
  apiKeyEnv: z.string(),
  // The route's SERVED SET: an array of model entries
  // ({ name, id, …config } — presence = served). Absent / [] = FULL_CATALOG
  // (serve the whole discovered catalog). A legacy string allow-list is NOT
  // a supported stored form — this gate refuses it (the lenient reader
  // degrades one to FULL_CATALOG if it ever reaches the in-memory path).
  models: z.array(modelEntry),
  // Per-route model overrides: exact WIRE id → the override entry
  // (the EXACT top-level entry shape). Meaningful only while the route is
  // FULL_CATALOG (tier 1 for the catalog models, per field over the legacy
  // top-level `overrides` map — dual-shape read; the first section write
  // folds the legacy map in — src/overrides.ts). The EXPLICIT writer drops
  // the key (the config lives in the entries). NO `.default()`: absent
  // stays absent in the write gate. (The schema RESOLVED view still
  // materializes an empty dict — `overrides: {}` — on every route; the
  // phantom inverse (cleanRoutePhantoms) strips it before any
  // whole-section write, exactly like `models: []`.)
  overrides: z.dict(overrideEntry),
});

/**
 * The `modelspoke:` section schema (settings-seam write gate). Annotated with
 * the global schemastery instance type (the schema's inferred generic type is
 * not nameable in the emitted declaration — it would reference pnpm store
 * paths).
 */
export const ModelspokeConfigSchema: Schemastery<any, any> = z.object({
  routes: z.array(route).default([]),
  overrides: z.dict(overrideEntry).default({}),
  // Client-side presentation flag — does the web GUI render the
  // read_image tool's image, or fall back to the host's generic row? The node
  // half never reads it (it gates a client registration, not a server
  // behavior), but the schema must NAME it so (a) the write gate accepts a
  // section carrying it and (b) the whole-section `replace` writes below do
  // not silently strip it (see {@link renderReadImagesOf}). Optional: an
  // absent key is the lenient "absent" state the reader maps to the default
  // (render on). No `.default()` — a materialized default would pollute
  // settings.yaml on every whole-section write with a field the user never
  // wrote (the stripPhantomDefaults bug class).
  renderReadImages: z.boolean(),
});

/**
 * The section shape as the settings seam hands it over (schema defaults
 * materialize the two containers).
 */
export interface ModelspokeSection {
  routes: readonly unknown[];
  overrides: Record<string, unknown>;
}

/**
 * One entry's effective harness name (the SAME rule the reader applies —
 * src/overrides.ts `normalizeModelEntry`): a blank `name` reads as the wire
 * `id` (trimmed); `null` when neither is a non-empty string (such a row is
 * discarded at read and can never collide).
 */
function effectiveModelName(entry: unknown): string | null {
  const e = entry as { name?: unknown; id?: unknown } | undefined;
  const name = typeof e?.name === "string" ? e.name : "";
  const id = typeof e?.id === "string" ? e.id : "";
  if (name.trim().length > 0) return name;
  if (id.trim().length > 0) return id.trim();
  return null;
}

/**
 * Cross-field validation for the settings seam — refused where written
 * (every writer, hand-edit included, passes through the same gate):
 * - duplicate ROUTE names (the route key is the dsh provider NAME — two
 *   providers with one name would collide at `registerAdapter`);
 * - duplicate MODEL names within one route's `models` list — the entry's
 *   `name` is the harness identity (the adapter's by-name lookup, `id:
 *   entry.name` in `listModels`); two rows with one effective name make the
 *   second row unreachable and the first ambiguous. Effective name = the
 *   reader's rule (blank `name` → the wire `id`). Duplicate WIRE ids remain
 *   legal (variants) when their names differ.
 */
export function assertServiceable(value: unknown): void {
  const section = value as { routes?: readonly unknown[] } | undefined;
  const routes = section?.routes;
  if (!Array.isArray(routes)) return;
  const seen = new Set<string>();
  for (const raw of routes) {
    const name = (raw as { name?: unknown } | undefined)?.name;
    if (typeof name !== "string") continue;
    if (seen.has(name)) {
      throw new Error(`modelspoke: duplicate route name "${name}" in modelspoke.routes`);
    }
    seen.add(name);
    const models = (raw as { models?: unknown } | undefined)?.models;
    if (!Array.isArray(models)) continue;
    const seenModels = new Set<string>();
    for (const entry of models) {
      const mname = effectiveModelName(entry);
      if (mname === null) continue;
      if (seenModels.has(mname)) {
        throw new Error(
          `modelspoke: duplicate model name "${mname}" in route "${name}" models — model names must be unique per provider`,
        );
      }
      seenModels.add(mname);
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Lenient route extraction from a (parsed) section: keeps entries with a
 * non-empty string `name` and `baseURL`; optional string fields pass through
 * only when non-empty. The route's served set is decoded by the shared
 * LENIENT reader (src/overrides.ts {@link decodeRouteModels}): the entry
 * array, or absent/empty/malformed = FULL_CATALOG (`models: null` + the
 * route's raw `overrides` map as `legacyOverrides`); a legacy string
 * allow-list degrades to FULL_CATALOG. Never throws — malformed elements
 * are skipped.
 */
export function routesOf(section: unknown): ModelspokeRoute[] {
  const raw = isPlainObject(section) ? section.routes : undefined;
  if (!Array.isArray(raw)) return [];
  const out: ModelspokeRoute[] = [];
  for (const entry of raw) {
    if (!isPlainObject(entry)) continue;
    const { name, baseURL, apiKeyEnv } = entry as Record<string, unknown>;
    if (typeof name !== "string" || name.length === 0) continue;
    if (typeof baseURL !== "string" || baseURL.length === 0) continue;
    const decoded = decodeRouteModels(entry as Record<string, unknown>);
    out.push({
      name,
      baseURL,
      ...(typeof apiKeyEnv === "string" && apiKeyEnv.length > 0 ? { apiKeyEnv } : {}),
      models: decoded.models,
      ...(decoded.legacyOverrides === undefined ? {} : { legacyOverrides: decoded.legacyOverrides }),
    });
  }
  return out;
}

/**
 * The EFFECTIVE tier-1 override for one (route, exact model id) — the
 * dual-shape read: the route's own `overrides` entry wins PER FIELD over the
 * legacy top-level `overrides` entry (src/overrides.ts
 * {@link effectiveOverrideEntry}), then normalized through the core's
 * `normalizeOverrideEntry` (canonical spelling + display name; lenient-drop
 * posture, never throws). Both locations absent (or phantom-only) →
 * undefined (no tier-1 for this model on this route).
 */
export function overrideForRoute(section: unknown, routeName: string, modelId: string): OverrideEntry | undefined {
  const merged = effectiveOverrideEntry(section, routeName, modelId);
  return merged === undefined ? undefined : normalizeOverrideEntry(merged);
}

/**
 * The dsh-only per-model `defaultEffort` for one (route, exact model id),
 * read from the RAW dual-shape merged entry (the per-route `overrides`
 * home, else the legacy top-level entry) BEFORE normalization — the
 * normalized entry strips it. Empty / non-string → undefined (no
 * per-model default). This is the FULL_CATALOG home for the per-model
 * default effort (EXPLICIT entries carry their own field on the entry
 * itself).
 */
export function defaultEffortForRoute(
  section: unknown,
  routeName: string,
  modelId: string,
): string | undefined {
  const merged = effectiveOverrideEntry(section, routeName, modelId);
  const raw = merged === undefined ? undefined : merged.defaultEffort;
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

/**
 * The raw `renderReadImages` boolean as stored, or undefined when absent or
 * malformed (the lenient reader's contract: never throws, never coerces).
 * This is the mirror-carry helper: the whole-section `replace` writer
 * (provision) passes the value through byte-for-byte, so a
 * section carrying `renderReadImages: false` survives an unrelated import
 * (see the callers in src/dsh/channel.ts). The node half interprets it for
 * nothing — it is a client-side presentation flag.
 */
export function renderReadImagesOf(section: unknown): boolean | undefined {
  const raw = isPlainObject(section) ? section.renderReadImages : undefined;
  return typeof raw === "boolean" ? raw : undefined;
}
