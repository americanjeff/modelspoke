/**
 * modelspoke — public API (framework-neutral core).
 *
 * Shared core for coding agents (dsh): discover models from
 * any OpenAI-compatible `/v1/models`, and resolve per-model reasoning
 * metadata through the four-tier chain (user override > server discovery >
 * built-in preset > default) with a per-field source map.
 *
 * The dsh host adapter is a thin shim over this core in `src/dsh/` —
 * it is NOT re-exported here.
 */

// Canonical contract (types; wire shapes re-exported from discovery/types.js)
export type {
  CanonicalField,
  CanonicalModelFields,
  Compat,
  DiscoveryModelInfo,
  FieldSource,
  FieldSourceMap,
  LlamaSwapMeta,
  ModelArchitecture,
  ModelCapabilities,
  ModelMeta,
  ModelModality,
  ModelspokeRoute,
  ModelspokeSettings,
  ModelStatus,
  OpenAIModelEntry,
  OpenAIModelsListResponse,
  OverrideEntry,
  Preset,
  ResolvedModel,
  ResolutionResult,
  ThinkingLevelMap,
} from "./types.js";

// Discovery (tier 2) — ported /v1/models spine + meta.llamaswap extractors
export {
  ModelspokeClientError,
  discoverModels,
  extractCompat,
  extractContextWindow,
  extractFromEntry,
  extractInput,
  extractMaxTokens,
  extractName,
  extractReasoning,
  extractThinkingLevelMap,
  extractToolCalling,
  fetchModels,
  normalizeBasePath,
  normalizeRouteBaseUrl,
} from "./discovery/index.js";

// Served set (src/overrides.ts) — the lenient reader (entry array /
// FULL_CATALOG; a legacy string allow-list degrades to FULL_CATALOG), the
// entry tier-1 helper, and the byte-preserving route writer
export {
  decodeRouteModels,
  entryFromLegacyId,
  entryOverride,
  normalizeModelEntry,
  storeRoute,
} from "./overrides.js";
export type { DecodedRouteModels } from "./overrides.js";

// Presets (tier 3) — ordered catalog + matching
export { matchPreset, presetCatalog } from "./presets/index.js";

// Resolve — the four-tier resolver + canonicalization
export {
  CANONICAL_LEVELS,
  DEFAULT_FIELDS,
  canonicalizeFields,
  canonicalizeThinkingLevelMap,
  isPlainObject,
  resolveModel,
} from "./resolve/index.js";
export type { ResolveInput } from "./resolve/index.js";

// Config — modelspoke: settings read (pure)
export { loadOverrides } from "./config/index.js";
