/**
 * modelspoke — the stable LIBRARY surface (`modelspoke/lib`).
 *
 * The framework-neutral core, packaged for consumers that embed discovery +
 * resolution under their own orchestration (modelspoke-smith first). This
 * file is a BARREL only: it owns no logic and
 * re-exports from the core modules (`src/{discovery,resolve,types}`).
 *
 * STABILITY BOUNDARY (pre-1.0 semver: breaking changes are allowed; this is
 * the declared boundary — everything below it is internal and may change):
 *
 * - the C1–C12 discovery contract (docs/design.md, "The discovery backends"): the
 *   {@link DiscoveryBackend} seam + {@link DiscoveryContext}, the locked C9
 *   registry order, the C4 wire-row replacement semantics, the C5
 *   never-invent rules, and the C6 fail-soft discipline;
 * - the tiered-resolution contract: user override > server discovery >
 *   preset > default, first non-empty wins PER FIELD, with the per-field
 *   source map ({@link resolveModel});
 * - the canonical types (src/types.ts — the pi-ai vocabulary).
 *
 * Deliberately NOT exported here:
 *
 * - anything from `src/dsh/` — the channel orchestration
 *   (src/dsh/channel.ts) is dsh-shaped; a library consumer brings its own
 *   orchestration and drives the backends + resolver directly;
 * - a preset-lookup API — keep the barrel minimal and grow it per consumer
 *   need (the barrel stays minimal).
 *
 * `@earendil-works/pi-ai` types (the `compat` / `thinkingLevelMap` shared
 * vocabulary) surface transitively through these types — that is expected:
 * it IS the shared vocabulary (docs/design.md), not a host dependency.
 */

// Canonical contract (src/types.ts — the shared shape every tier speaks)
export type {
  CanonicalField,
  CanonicalModelFields,
  Compat,
  DiscoveryModelInfo,
  FieldSource,
  FieldSourceMap,
  ModelModality,
  OverrideEntry,
  ResolvedModel,
  ResolutionResult,
  ThinkingLevelMap,
} from "./types.js";

// Discovery (tier 2) — the backend seam + the locked registry and its
// member backends (re-exported from the registry's single surface)
export type { DiscoveryBackend, DiscoveryContext } from "./discovery/backends.js";
export {
  discoveryBackends,
  llamacppBackend,
  lmstudioBackend,
  ollamaBackend,
  sglangBackend,
  vllmBackend,
} from "./discovery/backends.js";

// Resolution — the four-tier resolver entry point
export type { ResolveInput } from "./resolve/resolver.js";
export { resolveModel } from "./resolve/resolver.js";

// Canonicalization — the tier→canonical boundary helpers
export {
  CANONICAL_LEVELS,
  NO_THINKING_LEVELS,
  canonicalizeFields,
  canonicalizeThinkingLevelMap,
} from "./resolve/canonical.js";
