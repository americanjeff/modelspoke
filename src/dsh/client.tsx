/**
 * modelspoke — dsh client plugin (browser half): the `modelspoke:` settings
 * section (provider rows with route CRUD + per-model configuration) and the
 * onboarding first-run step.
 *
 * Dual-face counterpart of the node half (src/dsh/index.ts): the same Cordis
 * row contributes this browser bundle, which the web app's client scanner
 * picks up from `dsh.client` + the `./client` export
 * (docs/dsh-plugin-guidance.md §2).
 *
 * The section renders the `modelspoke:` routes as provider rows (name +
 * status dot + right-aligned Edit / Delete); Edit expands an inset card
 * carrying the provider fields (name — re-key editable: a rename writes the
 * new key at the entry's array slot and the provider's curation + per-model
 * configurations follow it — base URL, API key env, default effort) and the
 * model list, with a [Cancel] [Apply] footer and dirty tracking (both
 * buttons disabled while the draft equals the committed snapshot, enabled
 * on any unsaved change; Apply commits through the whole-section foldedCommit
 * path and re-disables once the commit is verified, with the draft re-based
 * onto the new key). The status dot is a component fed by
 * `state: { kind: "unknown" | "ok" | "error", detail? }` (last-fetch-only,
 * no polling: green "N models · last checked HH:MM" / red "<specific
 * failure> · HH:MM" / grey "Not checked yet — expand to fetch"). The
 * geometry is ported from dsh's ui-settings-models module CSS into inline
 * styles, colors resolved through the same `var(--dsw-alias-*)` tokens (the
 * section renders inside the settings dialog, where the dialog's theme
 * defines them); the focus states are JS-driven (the reference's input focus
 * = the brand-primary border with the outline suppressed, its button
 * focus-visible = the 2px border-l3 ring) — see {@link useFocusRing}. The
 * add-provider flow keeps its own [Cancel] [Next] footer (no committed state
 * to dirty-track against); its commit opens the new provider's card.
 *
 * The model list is the route's SERVED SET: an add/remove list of MODEL
 * ENTRIES (`{ name, id, …config, defaultEffort? }`) — `name` is the harness
 * identity (col 1, mono, editable, unique per provider; collisions refused
 * inline), `id` the wire id (col 2, an editable combobox over the FULL
 * fetched catalog — typing filters, an unlisted id may be typed directly),
 * the `>` chevron drops the per-model detail, `−` removes; presence in the
 * list IS the served state; duplicate ids are legal variants; an empty-id
 * row is discarded on Apply. Expanding a provider silently fetches its
 * catalog through `api.llm.discoverModels` (host side: the node half's
 * discovery callback, src/dsh/index.ts) and the node half's /modelspoke
 * channel `discoverMetadata` endpoint alongside it (cached per provider):
 * the detail seeds its display from committed ∪ discovered (committed wins
 * per field), and the discovery seed is DISPLAY-ONLY — the dirty baseline
 * and the commit merge key on the COMMITTED baseline (an untouched detail
 * commits nothing; a discovery value is never written as a user override).
 * A route is either an explicit entry list or FULL_CATALOG (`models: null`
 * — serve the whole discovered catalog, per-wire-id config in the route's
 * legacy `overrides` map); a FULL_CATALOG card seeds its rows from the
 * fetched catalog (curation.js `seedCatalogEntries`, name = id) and the
 * first entry-list edit MATERIALIZES the draft from that seed (the seed
 * becomes the dirty baseline — a viewed-only FULL_CATALOG route stays
 * FULL_CATALOG and commits nothing).
 *
 * The per-model detail (one open at a time): Context window / Max output
 * tokens, the Capabilities group (**Image input** + **Reasoning effort** —
 * ON = the model has a reasoning-effort dimension = the effective
 * `thinkingLevelMap` non-empty; OFF = the nothink sentinel), the
 * reasoning-effort map shown only while the capability is ON (**Harness** =
 * the map key / **Model** = the map value or "not supported"), the per-model
 * **Default effort** select (the empty option displays the built-in fallback
 * level), the read-only "preserved from settings.yaml" line (the deep compat
 * fields are NEVER editable — preserved through every save), and the
 * draft-scoped Reset (marks the entry for deletion in the PENDING commit;
 * nothing is written — the checkmark enables, Cancel discards, "Undo reset"
 * un-marks; on commit the entry is dropped from the provider's OWN map and
 * the legacy top level BEFORE the fold, the model staying active). Every
 * detail edit joins the CARD draft (`CardDraft.configDrafts` — lazily created
 * on the first edit with the committed/effective baseline, dirty by SEMANTIC
 * compare) and commits through the card's Apply. The card's dirty gate is
 * `cardModelDirty` OR'd with `cardFieldsDirty` — both PURE in ./curation.js
 * (unit-tested directly), along with the entry-list operations
 * (add/remove/rename/updateModelEntry, seedCatalogEntries, cardModelOverrides
 * — the FULL_CATALOG map commit —, applyConfigDraftToEntry — the
 * explicit-entry commit) over the shared dual-shape reader (../overrides.js
 * `decodeRouteModels`).
 *
 * Writes are whole-section commits (routes + folded top level as one unit,
 * `scope.set("routes", …)` / `scope.set|unset("overrides", …)`) with
 * post-settlement verification on BOTH halves (routeKey now carries the
 * provider's configurations). The merge discipline: whole entries pass
 * through (never a field-by-field reconstruction) — the written entry is
 * `{ …effectiveEntry, …displayedFields, …releasedFieldsRemoved }`, so
 * preserved fields survive byte-for-byte; `input` is declared explicitly on
 * every save (`["text"]` pins text-only), and `compat` is materialized WHOLE
 * — the resolver takes a tier's compat verbatim (whole-field units,
 * src/resolve/resolver.ts), so the writer materializes the deep template
 * fields (`thinkingFormat`, `chatTemplateKwargs`, …) alongside the
 * `supportsReasoningEffort` pin.
 *
 * The `settings.onboarding` first-run step: a loopback RPC to the node
 * half's `/modelspoke` channel (src/dsh/channel.ts) probes readiness
 * (`onboarding`) and, when the section is not ready, offers the
 * onboarding-v2 import — a LOCAL `llm-pi-ai` custom provider over
 * `provision` (pick list for several, direct form for one; the
 * `modelspoke-<source>` name default, the per-keySource key note, and the
 * live non-blocking collision warning — the server's `shadowing` response
 * field is the guaranteed backstop). The pure helpers live in
 * framework-neutral ./import.js (inlined by tsdown, unit-tested directly).
 * The step owns its modal chrome + `#root` inert while visible (slot
 * contract), renders null + completes itself whenever the channel says
 * nothing to offer, and adds NO runtime requires beyond react/jsx-runtime
 * (the call rides the injected `connection` service).
 *
 * Write settlement (verified against
 * packages/client/ui-settings/src/client/settings-scope.ts:110-158 of the
 * dsh checkout): `set` carries the latest known revision and, on rejection
 * (e.g. a concurrent-change revision conflict) or transport failure,
 * RELOADS the Host document and resolves anyway — it does not reject. So a
 * failed write is detected by re-deriving from the fresh snapshot after the
 * settlement and comparing it with the array we tried to write; on
 * divergence we surface an inline error and the list simply renders the
 * current Host state (no local divergence is possible — the list is always
 * derived from the snapshot). On success the returned view is folded back
 * into the shared describe mirror (settings-scope.ts:144-149), so the
 * snapshot re-derives from our own write immediately.
 *
 * Built by tsdown (tsdown.config.ts) into dist/dsh/client.js — the dsh
 * clientBundle closure-factory shape (window.__ModuleLoader__.load handoff);
 * the node half stays pure tsc output, and this file is excluded from it
 * (tsconfig.json "exclude" / tsconfig.client.json type-checks it).
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties, ReactNode } from "react";
import type { ClientContext } from "@deepseek-ai/dsh-client-runtime/client";
// The settled tool-call node types the read_image view renders over
// (ToolCallBlock = RunningToolCall | ToolResultNode; ToolResultNode.content
// carries the `[text envelope, image block]` result) plus the session
// standard-kit id and the sessions service face (the byte loader:
// `ISession.readAttachment`).
import type {
  ISession,
  ISessions,
  SessionId,
  SettingsScope,
  SettingsScopeSnapshot,
  ToolCallBlock,
  ToolResultNode,
} from "@deepseek-ai/dsh-client-runtime/client";
// Type-only: pulls the settings domain's SlotMap merge (the 'settings.section'
// entry) and the ctx.settingsScope context merge into this program.
import type {} from "@deepseek-ai/dsh-client-ui-settings/client";
// Type-only: the ctx.connection service surface (the `api.llm.discoverModels`
// request/response shapes — packages/client/connection contract,
// dsh-host-apiproxy llm.discoverModels). The service itself is provided by
// the host's own connection plugin (injected below); the bundle keeps no
// runtime reference to the module.
import type { ConnectionHandle, DiscoveredModelView } from "@deepseek-ai/dsh-client-connection/client";
// The pure onboarding-v2 helpers (name default + live collision check).
import { defaultImportRouteName, providerCollision } from "./import.js";
// The pure model-curation contract (the entry-list ops the card's
// commit writes, the semantic dirty equality, and the status-dot detail
// text).
import {
  addModelEntry,
  applyConfigDraftToEntry,
  cardFieldsDirty,
  cardModelDirty,
  cardModelOverrides,
  cardTopOverridesAfterReset,
  catalogErrorDetail,
  catalogOkDetail,
  clockLabel,
  classifyTopOverrides,
  configDraftReleasesEntry,
  dedupeName,
  modelConfigDraftDirty,
  normalizeEntriesForWrite,
  preservedSummary,
  removeModelEntry,
  removeTopOverrideEntry,
  renameModelEntry,
  resolveNameCollision,
  seedCatalogEntries,
  seedRowKeys,
  slotNormalizedEntries,
  updateModelEntry,
  type ModelConfigBaseline,
  type ModelConfigDraft,
  type ModelConfigSource,
  type TlRow,
} from "./curation.js";
// The dual-shape override core (src/overrides.ts) — the SAME
// phantom inverse, lenient readers (the `decodeRouteModels` served-set
// decode — entry array / FULL_CATALOG; a legacy string allow-list degrades
// to FULL_CATALOG), effective tier-1 merge, and pure first-write fold the
// node half's writers run.
import {
  NO_THINKING_LEVELS,
  cleanRoutePhantoms,
  decodeRouteModels,
  effectiveOverrideEntry,
  entryOverride,
  foldLegacyOverrides,
  stripEntryPhantoms,
  stripMapPhantoms,
  topLevelOverridesOf,
} from "../overrides.js";
// The in-memory model-entry contract (name = harness identity, id = wire
// id, defaultEffort = the per-model effort select). Type-only — the bundle
// keeps no runtime reference to the module.
import type { ModelEntry } from "../types.js";
// The matched preset's `compat` object is the whole-block
// materializer the card commit needs (compatForWrite's presetCompat
// — the deep template fields materialized next to the sre pin).
import { matchPreset } from "../presets/match.js";
// The pure read_image tool-view helpers (attachment-ref extraction from
// settled content, the envelope-text join, the caption, and the registration
// gating decision).
import {
  imageAttachmentRefs,
  imageCaption,
  shouldRegisterReadImageView,
  textBlocksOf,
  type ReadImageAttachmentRef,
} from "./toolview.js";
// i18n: the locale string bundle — the typed
// key set, the t() accessor, the resolution chain (preference → browser,
// fallback-defensive bind), and the localized preset (catalog) descriptions.
import {
  attemptLocaleBind,
  modelCountLabel,
  resolveLocale,
  t,
  type LocaleId,
} from "./locales.js";

/**
 * The host's keyed Tool-view slot contract, mirrored LOCALLY. The host
 * (dsh 0.1.1-rc.2) declares `tool.call.toolview` in
 * `@deepseek-ai/dsh-client-ui-tool/client` (packages/client/ui-tool/
 * src/client/contract/slots.ts:9-44): a `keyed` session-scope slot dispatched
 * by wire tool name, whose owner passes {@link ToolViewOwnerProps} and whose
 * unclaimed keys fall back to the host's generic tool row. We mirror that
 * contract here instead of importing the ui-tool client entry, because (a)
 * ui-tool is not a modelspoke dependency, and (b) its client d.ts pulls
 * `ui-conversation`/`ui-locale` type modules that are not linked in this
 * repo's node_modules — importing it would break `tsc -p tsconfig.client.json`
 * or force node_modules surgery. The mirror is EXACT against 0.1.1-rc.2; if
 * the host's `ToolCallOwnerProps` changes, this interface must follow.
 *
 * Registering a keyed entry for the (currently unclaimed) `read_image` name is
 * ADDITIVE for this tool and a takeover for a shipped one (the slot contract's
 * own words) — modelspoke owns only `read_image`, every other tool keeps its
 * host row.
 */
interface ToolViewOwnerProps {
  /** Tool call identity, stable across running and settled forms. */
  callId: string;
  /** Wire Tool name and keyed dispatch value. */
  toolName: string;
  /** Frozen running call or settled result node. */
  block: ToolCallBlock;
  /** Session workspace root for relative summaries. */
  cwd?: string | undefined;
  /** Host account home; POSIX home-rooted summaries display as `~`. */
  home?: string | undefined;
  /** Open a Tool argument path through the Host. */
  openFile: (path: string) => void;
  /** Inspect this call in the trajectory view when available. */
  inspect?: (() => void) | undefined;
}
declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface SlotMap {
    /** Mirrored from ui-tool client contract (see above). */
    "tool.call.toolview": { kind: "keyed"; scope: "session"; owner: ToolViewOwnerProps };
  }
}

export const name = "modelspoke";

/**
 * Required services: the slot registry, the settings-namespace binder, and
 * and the connection service — `ctx.get("connection")` yields the host's
 * wire client, whose `api.llm.discoverModels` interrogates a route's
 * endpoint (the same handler the node half registers —
 * `registerModelDiscovery` in src/dsh/index.ts). `settingsScope` serves both
 * the read path and
 * the writes: its `set(field, value)` is a single-top-level-field write
 * addressed as `path: [field]` over the settings seam's `settings.mutate`,
 * auto-fenced with the latest namespace revision
 * (docs/dsh-plugin-guidance.md §3).
 */
// The read_image view is why "sessions" is injected: it loads its image bytes through the
// host's session service (`sessions.binding(sessionId)?.session.readAttachment`
// — the same path the message-image renderer uses, packages/client/ui-
// conversation/src/client/service.ts resolveImage). The runtime provides the
// service (`reflect.provide('sessions', …)`, packages/client/runtime/src/
// client/sessions/service.ts:348); the typed accessor `ctx.sessions` comes
// from the runtime's Context merge (pulled in by the type import above).
export const inject = ["slots", "settingsScope", "connection", "sessions"];

/**
 * The exact namespace string the node half registers:
 * `settingsNamespace("modelspoke")` (src/dsh/index.ts, the `NS` const) is
 * identity —
 * dsh-settings validates the shape and returns the string unchanged — so the
 * wire section is `modelspoke:` and the scope binds the bare string.
 */
const NAMESPACE = "modelspoke";

/**
 * i18n — the host's durable `locale` settings namespace (dsh's locale
 * plugin): id `locale`, field `preference`, allowed values `['zh','en']`;
 * ABSENCE delegates to the browser. The client reads it through the SAME
 * `settingsScope.bind` the section uses for its own `modelspoke` namespace
 * (the bound scope's `getSnapshot().value` is `{ preference? }`, and its
 * `subscribe` fires on a language change — live switching, no reload).
 */
interface LocaleSection {
  preference?: "zh" | "en";
}

/** The stable empty snapshot the locale hook reads when the bind FAILED
 * (browser-only: no scope to subscribe to, so the locale never re-resolves
 * live). A module const keeps the reference stable for useSyncExternalStore. */
const EMPTY_LOCALE_SNAPSHOT: SettingsScopeSnapshot<LocaleSection> = {
  status: "unavailable",
  value: undefined,
  base: undefined,
  user: undefined,
  revision: undefined,
  writable: false,
  mode: "memory",
};

/** The client has no logger service (the node half's `ctx.logger` is not on
 * the client context), so the bind-failure notice is a guarded, ONE-TIME
 * console.warn (the "existing logger pattern if available" fallback). */
let localeBindWarningLogged = false;
function warnLocaleBindOnce(): void {
  if (localeBindWarningLogged) return;
  localeBindWarningLogged = true;
  if (typeof console !== "undefined" && typeof console.warn === "function") {
    console.warn(
      "[modelspoke] the `locale` settings namespace is not registered on this host — " +
        "using the browser language only (no live locale switching).",
    );
  }
}

/**
 * The canonical `defaultEffort` values: pi-ai's thinking levels
 * (`ThinkingLevel` = "minimal" | "low" | "medium" | "high" | "xhigh" |
 * "max") — the node half's `THINKING_LEVELS` (src/dsh/settings.ts) minus
 * "off", which is *thinking off*, not an effort. The route schema accepts a
 * free string (`defaultEffort: z.string()`), but the adapter CLAMPS any
 * committed value to the model's offered levels (pi parity — src/dsh/
 * adapter.ts), so the form constrains to the vocabulary. The empty form
 * value writes NO `defaultEffort` field (the optional-stays-absent shape
 * the node half's `routesOf` reads).
 */
const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * The canonical thinking-level vocabulary (mirror of the node half's
 * `THINKING_LEVELS`, src/dsh/settings.ts): "off" — thinking off, a
 * REQUESTABLE level, hence a legal `thinkingLevelMap` KEY — plus the six
 * effort levels. The map's VALUES are an accepted effort level or null
 * ("not supported"); the node write gate enforces the same two
 * vocabularies (key union over all seven, value `string | null`).
 */
const LEVELS = ["off", ...EFFORTS] as const;

/**
 * pi parity — the BUILT-IN effort a thinking model dispatches when neither
 * the host session nor the per-model entry names one: "medium" (pi's
 * session default, `DEFAULT_THINKING_LEVEL`), clamped to the row's offered
 * levels — the nearest offered level in `LEVELS` order (mirrors the
 * adapter's pi-ai `clampThinkingLevel`). The detail select's empty option
 * displays it (the determinable default).
 */
function builtInDefaultLevel(offered: readonly string[]): string {
  // No offered level at all (every row "not supported"): the runtime clamp
  // lands on "off" — nothing is sent.
  if (offered.length === 0) return "off";
  const fallback = "medium";
  if (offered.includes(fallback)) return fallback;
  const start = LEVELS.indexOf(fallback);
  for (let i = start; i < LEVELS.length; i++) {
    const level = LEVELS[i];
    if (level !== undefined && offered.includes(level)) return level;
  }
  for (let i = start - 1; i >= 0; i--) {
    const level = LEVELS[i];
    if (level !== undefined && offered.includes(level)) return level;
  }
  return fallback;
}

/**
 * One rendered provider row (display facts only; name is the provider
 * identity). The UI's "routes" are providers — one entry under the
 * yaml's `routes:` key — and each carries its per-model configurations
 * (`overrides`, the reorg of the section's top-level `overrides` map).
 */
interface RouteRow {
  name: string;
  baseURL: string;
  apiKeyEnv?: string;
  /** The provider's SERVED SET: the explicit ordered entry list
   * (`{ name, id, …config, defaultEffort? }` — presence in the list IS the
   * served state), or `null` = FULL_CATALOG (serve the whole discovered
   * catalog; per-wire-id config rides the legacy `overrides` map). Decoded
   * by the shared lenient dual-shape reader (the node half's `routesOf`
   * semantics); entries are phantom-stripped (the stored form — the
   * resolved view materializes the empty defaults). Carried through every
   * whole-array write (dropping it here would silently reset another
   * route's curation on an unrelated add/edit/delete). */
  models: ModelEntry[] | null;
  /** The provider's per-wire-id configuration entries (dual shape),
   * phantom-stripped (whole entries, as always); meaningful only while the
   * route is FULL_CATALOG (the first explicit write drops the stored key).
   * Absent/empty = none. Carried through every whole-array write — dropping
   * it would silently erase a provider's per-model customizations on an
   * unrelated route edit. */
  legacyOverrides?: Record<string, unknown>;
}

/** The inline ADD-provider form's draft (UI state only — never a routes
 * copy). The EDIT surface is the expanded provider card
 * ({@link CardDraft}, dirty-tracked against its committed snapshot) — the
 * add flow keeps its own Next/Cancel because there is no committed state
 * to dirty-track against. */
interface Draft {
  name: string;
  baseURL: string;
  apiKeyEnv: string;
}

/**
 * The expanded provider card's draft: the three provider fields
 * plus the COMMITTED snapshot they are compared against (dirty tracking
 * — the checkmark and Cancel stay disabled while the two are equal, enable
 * on any divergence). UI state only — never a routes copy; the model list
 * and every sibling entry stay snapshot-derived.
 *
 * `identity` is the committed key the card edits; the name field is
 * RE-KEY editable: a rename writes the new key at the entry's ARRAY SLOT
 * and the provider's curation + per-model configurations travel with it
 * (the fold carries the legacy top level as always).
 */
interface CardDraft {
  /** The committed key the card edits (a verified rename re-keys it). */
  identity: string;
  name: string;
  baseURL: string;
  apiKeyEnv: string;
  /** The three fields as committed — the dirty baseline + Cancel's revert target. */
  base: { name: string; baseURL: string; apiKeyEnv: string };
  /** The card's MODEL STATE: the draft entry list (ordered — the
   * served set). `null` = a FULL_CATALOG route that is NOT YET
   * MATERIALIZED: the rows are viewed from the fetched-catalog seed
   * (the card's universe) and the route stays FULL_CATALOG on commit.
   * The first entry-list edit (add / remove / rename / id re-key /
   * per-model default effort) MATERIALIZES the draft from that seed —
   * the route becomes EXPLICIT (src/dsh/curation.ts add/remove/rename/
   * updateModelEntry + seedCatalogEntries). UI state only — committed
   * through the card's Apply. */
  entries: ModelEntry[] | null;
  /** The entry list's dirty baseline (compared by the pure
   * {@link cardModelDirty}): the committed explicit list the card opened
   * on, or — for a materialized FULL_CATALOG draft — the SEED the
   * materialization started from (an unedited seed reads clean). `[]` for a
   * FULL_CATALOG draft that is not yet
   * materialized (unused while `entries` is null). */
  baseEntries: ModelEntry[];
  /** The per-model CONFIG drafts (the detail's
   * editable surface), keyed by the row's SLOT key (`rowKeys[i]` — a
   * colliding NAME must never share a draft between two rows; for a
   * FULL_CATALOG row the seed key is the wire id, name === id) — ONLY rows whose
   * detail the user has touched (a row with no draft shows its EFFECTIVE
   * committed ∪ discovered values and commits nothing). Each draft is
   * created LAZILY on the detail's first edit, seeded from the effective
   * baseline (the checkmark enables on divergence,
   * Cancel discards). Committed with the card through the saveOverride
   * merge discipline (src/dsh/curation.ts `mergeModelConfig` /
   * `cardModelOverrides` for the FULL_CATALOG map, `applyConfigDraftToEntry`
   * for an explicit entry). DISCOVERY-SEEDED VALUES ARE DISPLAY-ONLY:
   * the dirty baseline + commit merge key on the COMMITTED baseline
   * — an untouched detail commits nothing and a discovery value is
   * never written as a user override. */
  configDrafts: Record<string, ModelConfigDraft>;
  /** The row SLOT keys pending the draft-scoped
   * Reset (the detail's Reset action): at the card's commit the entry's
   * configuration is released — a FULL_CATALOG route drops the map entry, an
   * explicit route reduces its entry to the identity (`{ name, id }`) — and
   * the model STAYS served (presence in the list IS the served state; its
   * configuration resolves from discovery / preset / defaults again). A
   * pending key addresses the SLOT (a colliding name must never reset two
   * rows at once). Marks the card dirty; Cancel discards it. */
  pendingReset: string[];
  /** The row React keys for `entries` — stable per-slot tokens (from the
   * pure {@link seedRowKeys}), never the mutable draft name: unique per
   * slot, and never moved by an in-place edit. UI-only: never committed,
   * never part of the dirty check; they also address every per-row draft
   * state (`configDrafts`, `pendingReset`, the open detail). Design +
   * failure modes: docs/design.md "Settings UI — row addressing". `[]`
   * while `entries` is null (the unmaterialized universe's rows key by
   * their seed name at render — the same `seedRowKeys` derivation). */
  rowKeys: string[];
}

/**
 * The qwen3.8 fix — one row of the /modelspoke channel's
 * `discoverMetadata` response: the wire `id` (+ the endpoint-supplied
 * display `name` when it supplies one) and the model's DISCOVERED
 * canonical fields (`discoveredCanonical` — the discovery tier the
 * dsh catalog view does not carry: `input`, `reasoning`,
 * `thinkingLevelMap`, `compat`, …). The client caches these per provider
 * (re-fetched on every card expand) and seeds the model detail's
 * EFFECTIVE display from them (committed ∪ discovered, committed wins).
 */
interface DiscoveredMetadata {
  id: string;
  name?: string;
  discoveredCanonical?: Record<string, unknown>;
}

/** The expand-fetch catalog state for the OPEN card's provider
 * (the list area's loading / error / ready views). The row's status dot
 * keeps its own LAST-known state (no polling; the dot outlives the
 * card). */
interface CatalogState {
  /** The provider the fetch belongs to (stale resolutions are dropped). */
  route: string;
  status: "loading" | "error" | "ready";
  /** The inline failure (server down / status / malformed) — no write on error. */
  error?: string;
  /** The discovered catalog (discovered order), once fetched. */
  models: DiscoveredModelView[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Lenient route extraction mirroring the node half's `routesOf`
 * (src/dsh/settings.ts): keeps entries with a non-empty string `name` and
 * `baseURL`, passes the two optional strings through only when non-empty,
 * and skips malformed entries rather than throwing. The client cannot import
 * the node half's settings module (bundle purity + its schemastery import),
 * so the mirror lives here — but the SERVED-SET DECODE is the SHARED
 * lenient reader (`decodeRouteModels`, src/overrides.js: the entry shape, or
 * absent/`[]` = FULL_CATALOG; a legacy string allow-list degrades to
 * FULL_CATALOG), so the client and the node half decode the stored bytes
 * identically. This is what keeps every whole-array CRUD write
 * (add/edit/delete) from silently dropping a route's curation.
 *
 * Both decodes are NORMALIZED to the stored form here: explicit entries
 * pass through `stripEntryPhantoms` and the legacy map through
 * `stripMapPhantoms` (the schema-resolved view materializes the empty
 * defaults — the phantom inverse recovers the stored bytes), so a read
 * straight from the snapshot compares equal to the clean write the commit
 * verification runs against it.
 */
function routesOf(section: unknown): RouteRow[] {
  const raw = isPlainObject(section) ? section.routes : undefined;
  if (!Array.isArray(raw)) return [];
  const out: RouteRow[] = [];
  for (const entry of raw) {
    if (!isPlainObject(entry)) continue;
    const { name, baseURL, apiKeyEnv } = entry;
    if (typeof name !== "string" || name.length === 0) continue;
    if (typeof baseURL !== "string" || baseURL.length === 0) continue;
    const decoded = decodeRouteModels(entry);
    const models =
      decoded.models === null
        ? null
        : decoded.models.map(
            (e) => stripEntryPhantoms(e as unknown as Record<string, unknown>) as unknown as ModelEntry,
          );
    const legacyOverrides = stripMapPhantoms(decoded.legacyOverrides ?? {});
    out.push({
      name,
      baseURL,
      ...(typeof apiKeyEnv === "string" && apiKeyEnv.length > 0 ? { apiKeyEnv } : {}),
      models,
      ...(Object.keys(legacyOverrides).length > 0 ? { legacyOverrides } : {}),
    });
  }
  return out;
}

/**
 * Canonical per-route comparison key (field order fixed, optionals folded
 * to ""): decides whether the array we wrote is the array the scope now
 * reports after a `set` settlement. Both sides are decoded through the SAME
 * lenient reader, so a written explicit entry list, the settled
 * resolved view (phantom-materialized, then phantom-stripped), and FULL_CATALOG
 * (`models` absent / `[]` / null) all read as one canonical form; a legacy
 * string allow-list degrades to FULL_CATALOG. The legacy per-wire-id map rides the key in canonical form
 * under either spelling — the stored `overrides` key or the in-memory
 * `legacyOverrides` key. A write that dropped the served set (or a fold
 * that landed elsewhere) must read as a divergence, the same bug class the
 * allow-list fix closed.
 */
const routeKey = (raw: Record<string, unknown>): string => {
  const name = typeof raw.name === "string" ? raw.name : "";
  const baseURL = typeof raw.baseURL === "string" ? raw.baseURL : "";
  const apiKeyEnv = typeof raw.apiKeyEnv === "string" ? raw.apiKeyEnv : "";
  const decoded = decodeRouteModels({ ...raw, overrides: raw.overrides ?? raw.legacyOverrides });
  const models =
    decoded.models === null
      ? "\u0001full-catalog"
      : canonicalJson(
          decoded.models.map(
            (e) => stripEntryPhantoms(e as unknown as Record<string, unknown>) as unknown as ModelEntry,
          ),
        );
  const legacy = canonicalJson(stripMapPhantoms(decoded.legacyOverrides ?? {}));
  return [name, baseURL, apiKeyEnv, models, legacy].join("\u0000");
};
const sameRoutes = (a: readonly object[], b: readonly object[]): boolean =>
  a.length === b.length &&
  a.every((r, i) => {
    const other = b[i];
    return other !== undefined && routeKey(r as Record<string, unknown>) === routeKey(other as Record<string, unknown>);
  });

/**
 * Lenient extraction of the section's LEGACY top-level `overrides` map
 * (now one of the two tier-1 locations — the provider's own
 * `routes[].overrides` is the home, this is the pre-reorg / hand-edited
 * shape), WHOLE ENTRIES PASSED THROUGH, keyed by model id. Deliberately
 * NOT a field-by-field reconstruction: a write built from a per-field
 * mirror would silently strip `compat` (the deep template contract) and
 * every field the mirror does not name — the bug class (allow-list
 * dropped by a routes write that carried only the known fields). The
 * plain-object check is the only leniency: malformed non-object values are
 * skipped by the UI, never thrown on.
 */
function overridesOf(section: unknown): Record<string, unknown> {
  const raw = isPlainObject(section) ? section.overrides : undefined;
  return isPlainObject(raw) ? raw : {};
}

/**
 * The INVERSE of the settings mirror's default materialization. The
 * client's snapshot is the schema-RESOLVED section (dsh-settings
 * `resolve` = `schema(base + userLayer)`), and schemastery materializes
 * empty defaults for the object/dict/array schema fields: an entry
 * without `input` reads back as `input: []`, without `thinkingLevelMap`
 * as `thinkingLevelMap: {}`, without `compat` as
 * `compat: { chatTemplateKwargs: {} }`. Writing those back would pollute
 * settings.yaml with fields the user never wrote — the schema's
 * all-optional shape says empty = absent, so every entry the client
 * reads from the snapshot passes through this before it is written or
 * compared. (An explicit `input: []` canonicalizes to absent, the same
 * lenient treatment the `models` allow-list gets in {@link routesOf}.)
 */
// The resolved-view phantom inverse (input: [] / thinkingLevelMap: {} /
// compat: {chatTemplateKwargs: {}} strip, "none"-aware) lives ONCE in the
// framework-neutral core (../overrides.js stripMapPhantoms/stripEntryPhantoms)
// — the node half's channel writers run the same code.

/**
 * The section's LEGACY top-level `overrides` map, phantom-stripped (whole
 * entries, as always). The per-model home moved to `routes[].overrides`;
 * the top level is the pre-reorg / hand-edited location, still fully read
 * (route entries win per field — see effectiveOverrideEntry), and still
 * folded into the owning provider on the first section write.
 */
const topMapOf = (section: unknown): Record<string, unknown> =>
  stripMapPhantoms(topLevelOverridesOf(section));

/**
 * Canonical (recursive, key-sorted) serialization — the comparison key
 * for the post-settlement verification of a whole-object overrides write.
 * Unknown fields included: a settlement that dropped or mangled ANY field
 * of ANY entry reads as a divergence, exactly the `routeKey` discipline
 * applied to the overrides object.
 */
const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
};
// Both sides phantom-stripped: the settlement snapshot is the RESOLVED view
// (empty defaults materialized — see stripMapPhantoms), the written object
// is clean; comparing the normalized forms is the only stable comparison.
const sameOverrides = (a: Record<string, unknown>, b: Record<string, unknown>): boolean =>
  canonicalJson(stripMapPhantoms(a)) === canonicalJson(stripMapPhantoms(b));



/**
 * The onboarding step's modal chrome: a full-viewport overlay + a
 * centered card, plain elements like the rest of the page (no CSS
 * modules — the page is unthemed by design). The mask has no click
 * handler on purpose: an onboarding step blocks until ITS OWN buttons
 * resolve it (the shipped steps' posture — no escape-to-dismiss).
 */
const stepStyle = {
  overlay: {
    position: "fixed",
    inset: 0,
    zIndex: 1000,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  mask: { position: "absolute", inset: 0, backgroundColor: "rgba(0, 0, 0, 0.5)" },
  card: {
    position: "relative",
    maxWidth: 480,
    padding: 24,
    background: "#fff",
    color: "#222",
    border: "1px solid #888",
    borderRadius: 8,
  },
  title: { marginTop: 0, marginBottom: 8 },
  actions: { display: "flex", gap: 8, marginTop: 16 },
  secondary: { marginLeft: 0 },
  error: { color: "#b00020" },
  hint: { color: "#666", fontSize: "smaller" },
  field: { display: "block", margin: "8px 0" },
  row: { display: "flex", gap: 12, alignItems: "baseline", margin: "4px 0" },
  // The collision warning: visible, deliberately NON-BLOCKING (the owner
  // rule — taking over a name is a legitimate migrate-then-delete choice).
  warning: {
    color: "#5c4a00",
    background: "#fff8e1",
    border: "1px solid #c9a227",
    padding: "8px 12px",
    margin: "8px 0",
  },
} as const;

/**
 * The settings → Models mimic: the section shell, the row card,
 * the capsule controls, and the filled editor card, with the reference
 * module CSS's geometry (dsh packages/client/ui-settings-models/src/client/
 * ModelsSection.module.css) ported to inline styles. Colors resolve through
 * the SAME `var(--dsw-alias-*)` tokens the reference reads — this section
 * renders inside the settings dialog, where the dialog's theme defines
 * every token it uses (both themes) — so the port is token-for-token, with
 * no literal color. The module CSS's `:hover` / `:disabled` pseudo-states
 * are JS-driven in {@link MsButton} (inline styles cannot express
 * pseudo-classes).
 */
const ms = {
  section: {
    display: "flex",
    flexDirection: "column",
    gap: 12,
    maxWidth: 720,
    color: "var(--dsw-alias-label-primary)",
  },
  title: {
    margin: 0,
    fontSize: 16,
    lineHeight: "24px",
    fontWeight: 500,
    color: "var(--dsw-alias-label-primary)",
  },
  titleRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  titleIcon: {
    width: 18,
    height: 18,
    flexShrink: 0,
  },
  intro: {
    margin: 0,
    fontSize: 14,
    lineHeight: "22px",
    color: "var(--dsw-alias-label-tertiary)",
  },
  rows: {
    listStyle: "none",
    margin: "12px 0 0",
    padding: 0,
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  rowCard: {
    border: "1px solid var(--dsw-alias-border-l2)",
    borderRadius: 12,
    padding: "12px 14px",
    display: "flex",
    flexDirection: "column",
    gap: 12,
  },
  rowHead: { display: "flex", alignItems: "center", gap: 10 },
  rowIdentity: { display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0 },
  rowName: {
    fontSize: 14,
    lineHeight: "22px",
    fontWeight: 500,
    color: "var(--dsw-alias-label-primary)",
  },
  rowActions: { display: "inline-flex", alignItems: "center", gap: 4, marginLeft: "auto" },
  /** The capsule base the reference's .primaryButton/.secondaryButton/.
   *  .addButton share; the shape (dense h28 r14 / full h36 r18) and the
   *  variant color are composed per control in {@link MsButton}. */
  capsule: {
    boxSizing: "border-box",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    border: "none",
    font: "inherit",
    cursor: "pointer",
  },
  /** The expanded editor: a filled module on the panel (the reference's
   *  .editor / .addCard geometry). */
  editor: {
    borderRadius: 12,
    background: "var(--dsw-alias-bg-module-platform)",
    padding: "14px 16px",
    display: "flex",
    flexDirection: "column",
    gap: 14,
  },
  editorHeader: { display: "flex", alignItems: "baseline", gap: 8 },
  editorTitle: {
    fontSize: 14,
    lineHeight: "22px",
    fontWeight: 500,
    color: "var(--dsw-alias-label-primary)",
  },
  editorRoute: {
    fontSize: 12,
    lineHeight: "18px",
    color: "var(--dsw-alias-label-tertiary)",
  },
  field: { display: "flex", flexDirection: "column", gap: 6 },
  fieldLabel: {
    display: "inline-flex",
    alignItems: "center",
    gap: 10,
    fontSize: 12,
    lineHeight: "18px",
    fontWeight: 500,
    color: "var(--dsw-alias-label-secondary)",
  },
  input: {
    boxSizing: "border-box",
    width: "100%",
    height: 32,
    padding: "0 10px",
    border: "1px solid var(--dsw-alias-border-l2)",
    borderRadius: 8,
    font: "inherit",
    fontSize: 14,
    lineHeight: "22px",
    background: "var(--dsw-alias-bg-layer-1)",
    color: "var(--dsw-alias-label-primary)",
  },
  /** The select variant of the input: the native arrow replaced by the
   *  reference's 12px chevron data-URI (the #81858C literal is the caption
   *  gray shared by both themes — data-URI SVGs cannot resolve CSS
   *  variables, the same workaround the reference module uses). */
  selectInput: {
    appearance: "none",
    maxWidth: 240,
    padding: "0 32px 0 10px",
    cursor: "pointer",
    backgroundImage:
      "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")",
    backgroundRepeat: "no-repeat",
    backgroundPosition: "right 12px center",
    backgroundSize: "12px 12px",
  },
  editorActions: { display: "flex", justifyContent: "flex-end", gap: 8 },
  addActions: { display: "flex", flexWrap: "wrap", gap: 10 },
  /** The card's Models block (the fetched catalog, silent on expand):
   *  header + count hint, loading / error + retry / rows, the "Add
   *  model" pill + inline row. */
  modelsArea: {
    borderTop: "1px solid var(--dsw-alias-border-l2)",
    paddingTop: 12,
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  modelsHead: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
    flexWrap: "wrap",
  },
  modelsTitle: {
    fontSize: 12,
    lineHeight: "18px",
    fontWeight: 500,
    color: "var(--dsw-alias-label-secondary)",
  },
  modelsMeta: {
    margin: 0,
    fontSize: 12,
    lineHeight: "18px",
    color: "var(--dsw-alias-label-tertiary)",
  },
  modelList: {
    listStyle: "none",
    margin: 0,
    padding: 0,
    display: "flex",
    flexDirection: "column",
    gap: 2,
  },
  /** The card's model row: one inset pill (the spec's row grammar):
   *  [ name (col 1, mono, editable) ][ id (col 2, wire — combobox) ][ >
   *  chevron (config detail) ][ − remove ]. Presence in the list IS the
   *  served state — no active checkbox. */
  modelRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "5px 10px",
    borderRadius: 8,
    border: "1px solid var(--dsw-alias-border-l2)",
    background: "var(--dsw-alias-bg-layer-1)",
  },
  modelRowId: {
    flex: "1 1 auto",
    minWidth: 0,
    overflowWrap: "anywhere",
    fontSize: 13,
    lineHeight: "20px",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  },
  /** The row's col 1: the NAME (the harness identity — mono,
   *  editable; part of the card draft, committed on Apply, no blur-save). */
  modelRowNameField: {
    boxSizing: "border-box",
    flex: "1 1 auto",
    minWidth: 0,
    height: 28,
    padding: "0 8px",
    border: "1px solid var(--dsw-alias-border-l2)",
    borderRadius: 6,
    font: "inherit",
    fontSize: 13,
    lineHeight: "20px",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    background: "var(--dsw-alias-bg-layer-1)",
    color: "var(--dsw-alias-label-primary)",
  },
  /** The row's col 2: the WIRE-ID combobox input (mono — ids are
   *  machine strings; the listing overlay is ms.combo*). */
  rowIdInput: {
    boxSizing: "border-box",
    width: "100%",
    height: 28,
    padding: "0 8px",
    border: "1px solid var(--dsw-alias-border-l2)",
    borderRadius: 6,
    font: "inherit",
    fontSize: 13,
    lineHeight: "20px",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    background: "var(--dsw-alias-bg-layer-1)",
    color: "var(--dsw-alias-label-primary)",
  },
  comboWrap: { flex: "1 1 auto", minWidth: 0, position: "relative" },
  /** The combobox listing overlay: the StatusDot tooltip's
   *  positioned pattern (fixed — escapes the dialog's scroll clipping),
   *  left/top/width set inline from the input's rect. */
  comboList: {
    position: "fixed",
    zIndex: 100,
    margin: 0,
    padding: 2,
    listStyle: "none",
    borderRadius: 8,
    border: "1px solid var(--dsw-alias-border-l2)",
    background: "var(--dsw-alias-bg-module-platform)",
    boxShadow: "0 2px 8px rgba(0, 0, 0, 0.18)",
    maxHeight: 240,
    overflowY: "auto",
  },
  comboOption: {
    padding: "4px 8px",
    borderRadius: 6,
    cursor: "pointer",
    fontSize: 13,
    lineHeight: "20px",
    overflowWrap: "anywhere",
    color: "var(--dsw-alias-label-primary)",
  },
  comboOptionHot: { background: "var(--dsw-alias-interactive-bg-hover-solid)" },
  comboOptionId: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" },
  comboOptionMeta: { color: "var(--dsw-alias-label-tertiary)" },
  comboHint: {
    padding: "4px 8px",
    fontSize: 12,
    lineHeight: "18px",
    color: "var(--dsw-alias-label-tertiary)",
    cursor: "default",
  },
  /** The row container: the pill + the dropped-down detail block
   *  (the reference's row drops its detail INSIDE the row's own
   *  container). */
  modelItem: { display: "flex", flexDirection: "column", gap: 4 },
  /** The per-model detail block (the reference's expanded row):
   *  two-column Context window / Max output tokens, the Capabilities group
   *  (image input + reasoning effort), the Default-effort field, the
   *  thinking-level rows, the read-only "preserved from settings.yaml"
   *  line, Reset. */
  modelDetail: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    padding: "10px 12px",
    border: "1px solid var(--dsw-alias-border-l2)",
    borderRadius: 8,
    background: "var(--dsw-alias-bg-layer-1)",
  },
  modelDetailGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 },
  modelDetailField: { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 },
  modelDetailLabel: {
    fontSize: 12,
    lineHeight: "18px",
    color: "var(--dsw-alias-label-tertiary)",
  },
  /** The detail's checkbox rows (image input / reasoning
    *  effort): label + control in one row. */
  detailCheck: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 13,
    lineHeight: "20px",
    color: "var(--dsw-alias-label-primary)",
  },
  /** The detail's labeled group (the Capabilities group; the
   *  per-model Default-effort field): heading + stacked controls. */
  detailGroup: { display: "flex", flexDirection: "column", gap: 6 },
  detailGroupLabel: {
    fontSize: 12,
    lineHeight: "18px",
    fontWeight: 500,
    color: "var(--dsw-alias-label-secondary)",
  },
  /** The reasoning-effort map's column headings (Harness / Model)
   *  + one row (key select × value select + remove): the same 2-col
   *  grid (+ the remove column) so the headings and rows align. */
  mapHead: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr auto",
    gap: 6,
    alignItems: "center",
  },
  mapHeadCell: {
    fontSize: 12,
    lineHeight: "18px",
    fontWeight: 500,
    color: "var(--dsw-alias-label-tertiary)",
  },
  mapRow: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr auto",
    gap: 6,
    alignItems: "center",
  },
  /** The thinking-level row selects (the input's geometry, dense). */
  tlSelect: {
    boxSizing: "border-box",
    height: 28,
    padding: "0 8px",
    border: "1px solid var(--dsw-alias-border-l2)",
    borderRadius: 8,
    font: "inherit",
    fontSize: 12,
    lineHeight: "18px",
    background: "var(--dsw-alias-bg-layer-1)",
    color: "var(--dsw-alias-label-primary)",
  },
  /** The row's remove control (dense square, the chevron's look).
    *  The outline matches the other buttons / controls in the section
    *  (the `1px var(--dsw-alias-border-l2)` + r8 grammar the inputs and
    *  the secondary capsule share). */
  tlRemove: {
    boxSizing: "border-box",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 24,
    height: 24,
    border: "1px solid var(--dsw-alias-border-l2)",
    borderRadius: 8,
    background: "transparent",
    color: "var(--dsw-alias-label-secondary)",
    font: "inherit",
    fontSize: 12,
    lineHeight: "18px",
    cursor: "pointer",
  },
  /** The detail's per-model Default-effort select (the detail's
   *  column width, the select's chevron paint). */
  detailEffortSelect: {
    appearance: "none",
    maxWidth: 200,
    height: 28,
    padding: "0 32px 0 10px",
    cursor: "pointer",
    border: "1px solid var(--dsw-alias-border-l2)",
    borderRadius: 6,
    font: "inherit",
    fontSize: 13,
    lineHeight: "20px",
    backgroundImage:
      "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")",
    backgroundRepeat: "no-repeat",
    backgroundPosition: "right 10px center",
    backgroundSize: "12px 12px",
    background: "var(--dsw-alias-bg-layer-1)",
    color: "var(--dsw-alias-label-primary)",
    boxSizing: "border-box",
  },
  modelDetailHint: {
    fontSize: 12,
    lineHeight: "18px",
    color: "var(--dsw-alias-label-tertiary)",
  },
  modelDetailActions: { display: "flex", justifyContent: "flex-end", marginTop: 2 },
  retry: {
    padding: 0,
    border: "none",
    background: "none",
    font: "inherit",
    fontSize: 12,
    lineHeight: "18px",
    cursor: "pointer",
    color: "var(--dsw-alias-interactive-primary)",
    textDecoration: "underline",
  },
  dot: {
    boxSizing: "border-box",
    display: "inline-block",
    flex: "none",
    width: 8,
    height: 8,
    borderRadius: "50%",
  },
  /** The hover/focus tooltip plate: the dsh Tooltip primitive's own look
   *  (a tooltip-bg plate, white text, 3/7 padding, r8, 13/20),
   *  fixed-positioned below the dot so it escapes the dialog's scroll
   *  clipping. */
  tooltip: {
    position: "fixed",
    zIndex: 100,
    padding: "3px 7px",
    borderRadius: 8,
    background: "var(--dsw-alias-tooltip-bg)",
    color: "var(--dsw-static-neutral-bluish-00)",
    fontSize: 13,
    lineHeight: "20px",
    whiteSpace: "pre-line",
    maxWidth: "50vw",
    overflowWrap: "break-word",
    pointerEvents: "none",
  },
  error: {
    margin: 0,
    fontSize: 12,
    lineHeight: "18px",
    color: "var(--dsw-alias-state-error-primary)",
  },
  hint: {
    margin: 0,
    fontSize: 12,
    lineHeight: "18px",
    color: "var(--dsw-alias-label-tertiary)",
  },
  /** Orphaned-override cleanup — the top-level-overrides
   *  block at the section bottom (renders only while the top level is
   *  non-empty): heading + hint line, one modelRow-style pill per entry
   *  ([ID mono] [summary hint] [Delete | shadowed-by hint], wrapping). */
  topHead: { display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" },
  topTitle: {
    margin: 0,
    fontSize: 13,
    lineHeight: "20px",
    fontWeight: 500,
    color: "var(--dsw-alias-label-secondary)",
  },
  /** Repeated, not spread, because the object literal cannot reference
   *  `ms.modelRow` before `ms` is initialized. */
  topRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "5px 10px",
    borderRadius: 8,
    border: "1px solid var(--dsw-alias-border-l2)",
    background: "var(--dsw-alias-bg-layer-1)",
    flexWrap: "wrap",
  },
  topSummary: {
    flex: "0 1 auto",
    minWidth: 0,
    overflowWrap: "anywhere",
    fontSize: 12,
    lineHeight: "18px",
    color: "var(--dsw-alias-label-tertiary)",
  },
} as const;

/**
 * The capsule control the Models mimic uses (the reference's
 * .secondaryButton / .dangerButton / .primaryButton / .addButton): dense
 * (h28 r14, 12/18) on the rows, full (h36 r18, 14/22) in the card footers,
 * and the full-width dashed slot for the add button. The module CSS's
 * `:hover:not(:disabled)` is JS-driven (inline styles cannot express a
 * pseudo-class) and applied only to enabled controls; the disabled look
 * (opacity 0.4, default cursor) mirrors its `:disabled` rule.
 */
function MsButton(props: {
  variant: "secondary" | "danger" | "primary" | "add";
  /** The row's dense capsule; full size otherwise (the add slot ignores it). */
  dense?: boolean;
  disabled?: boolean;
  ariaLabel?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  const [hover, setHover] = useState(false);
  const { variant, disabled } = props;
  // The shape first (the add button is the full-width dashed slot, never
  // dense), then the variant's color/border, then the JS-driven hover.
  const shape =
    variant === "add"
      ? {
          flex: "1 1 0",
          minWidth: 180,
          gap: 6,
          height: 44,
          padding: "0 14px",
          borderRadius: 12,
          fontSize: 14,
          lineHeight: "22px",
        }
      : props.dense
        ? { height: 28, padding: "0 10px", borderRadius: 14, fontSize: 12, lineHeight: "18px" }
        : { height: 36, padding: "0 14px", borderRadius: 18, fontSize: 14, lineHeight: "22px" };
  const paint =
    variant === "primary"
      ? { background: "var(--dsw-alias-button-primary-fill)", color: "var(--dsw-alias-label-primary-foreground)" }
      : variant === "danger"
        ? { background: "transparent", color: "var(--dsw-alias-state-error-primary)" }
        : { background: "transparent", color: "var(--dsw-alias-label-primary)" };
  // The outline the secondary capsule carries, extended to danger so no
  // button in the section is bare text (primary is filled, add is dashed).
  const outline =
    variant === "secondary" || variant === "danger"
      ? { border: "1px solid var(--dsw-alias-border-l2)" }
      : {};
  const dashed = variant === "add"
      ? { border: "1px dashed var(--dsw-alias-border-l3)" }
      : {};
  const hoverBackground =
    variant === "primary"
      ? "var(--dsw-alias-button-primary-hover)"
      : variant === "danger"
        ? "var(--dsw-alias-interactive-bg-hover-danger)"
        : variant === "add"
          ? "var(--dsw-alias-interactive-bg-hover)"
          : "var(--dsw-alias-interactive-bg-hover-solid)";
  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={props.ariaLabel}
      onClick={props.onClick}
      onMouseEnter={() => {
        if (!disabled) setHover(true);
      }}
      onMouseLeave={() => setHover(false)}
      style={{
        ...ms.capsule,
        ...shape,
        ...paint,
        ...outline,
        ...dashed,
        background: hover ? hoverBackground : paint.background,
        ...(disabled ? { opacity: 0.4, cursor: "default" } : {}),
      }}
    >
      {props.children}
    </button>
  );
}

/**
 * The focus states the reference module CSS ports (inline styles
 * cannot express the pseudo-class — the same JS-driven workaround the
 * {@link MsButton} / {@link MsChevron} hover uses): the reference's input
 * focus is `border-color: var(--dsw-alias-brand-primary)` with the outline
 * suppressed, and its button `:focus-visible` is the 2px
 * `var(--dsw-alias-border-l3)` ring. The hook cannot distinguish
 * focus-visible from focus (any focus paints the ring — the state that
 * matters for the a11y pass is keyboard focus, which always fires it).
 */
const FOCUS_BORDER = "var(--dsw-alias-brand-primary)";
const FOCUS_RING = "0 0 0 2px var(--dsw-alias-border-l3)";

function useFocusRing(): { focused: boolean; bind: { onFocus: () => void; onBlur: () => void } } {
  const [focused, setFocused] = useState(false);
  return { focused, bind: { onFocus: () => setFocused(true), onBlur: () => setFocused(false) } };
}

/** The input/select focus paint (the reference's input `:focus` rule). */
const focusStyle = (focused: boolean): CSSProperties =>
  focused ? { borderColor: FOCUS_BORDER, outline: "none" } : {};

/** The button-like focus paint (the reference's `:focus-visible` ring). */
const ringStyle = (focused: boolean): CSSProperties => (focused ? { boxShadow: FOCUS_RING } : {});

/** The modelspoke mark (assets/logo/bubble-wheel-hollow.svg geometry), 64x64
 *  viewBox, currentColor — inherits the section's label-primary color. */
function MsWheelMark(props: { style?: CSSProperties }) {
  return (
    <svg
      viewBox="0 0 64 64"
      fill="none"
      stroke="currentColor"
      strokeWidth={6}
      strokeLinecap="round"
      aria-hidden="true"
      style={props.style}
    >
      <circle cx={32} cy={32} r={21} />
      <line x1={35.3} y1={26.4} x2={40.3} y2={17.7} />
      <line x1={35.3} y1={37.6} x2={41} y2={47.6} />
      <line x1={25.5} y1={32} x2={15.5} y2={32} />
      <path d="M46.1 45.4 L36.5 50.9 L48 59.7 Z" fill="currentColor" stroke="none" />
      <circle cx={32} cy={32} r={4.5} fill="none" strokeWidth={3} />
    </svg>
  );
}

/**
 * The section's text input (the shared inline style + the focus
 * border). `ariaLabel` is REQUIRED: the section's inputs are
 * label-less-by-design (the labels sit beside them in the card / detail),
 * so assistive tech gets the name here (a flagged a11y gap).
 */
function MsText(props: {
  style?: CSSProperties;
  ariaLabel: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  inputMode?: "numeric";
}) {
  const { focused, bind } = useFocusRing();
  return (
    <input
      style={{ ...(props.style ?? ms.input), ...focusStyle(focused) }}
      aria-label={props.ariaLabel}
      value={props.value}
      placeholder={props.placeholder}
      disabled={props.disabled}
      inputMode={props.inputMode}
      onChange={(e) => props.onChange(e.target.value)}
      onFocus={bind.onFocus}
      onBlur={bind.onBlur}
    />
  );
}

/**
 * The section's select (same focus paint; the card's default
 * effort keeps the reference's chevron data-URI via `style`).
 */
function MsSelect(props: {
  style?: CSSProperties;
  ariaLabel: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  const { focused, bind } = useFocusRing();
  return (
    <select
      style={{ ...ms.input, ...(props.style ?? {}), ...focusStyle(focused) }}
      aria-label={props.ariaLabel}
      value={props.value}
      disabled={props.disabled}
      onChange={(e) => props.onChange(e.target.value)}
      onFocus={bind.onFocus}
      onBlur={bind.onBlur}
    >
      {props.children}
    </select>
  );
}

/** A small icon-ish button (the detail's tl-row remove) with the
 *  reference's button focus-visible ring. */
function MsIconButton(props: {
  style?: CSSProperties;
  ariaLabel: string;
  title?: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  const { focused, bind } = useFocusRing();
  return (
    <button
      type="button"
      aria-label={props.ariaLabel}
      title={props.title}
      disabled={props.disabled}
      onClick={props.onClick}
      onFocus={bind.onFocus}
      onBlur={bind.onBlur}
      style={{
        ...ms.tlRemove,
        ...(props.style ?? {}),
        ...ringStyle(focused),
        ...(props.disabled ? { opacity: 0.4, cursor: "default" } : {}),
      }}
    >
      {props.children}
    </button>
  );
}

/**
 * The model row's plain chevron (the reference's ">" control;
 * NO badge): drops the row's detail block inside the row's own
 * container, one open at a time. The module-CSS `:hover` is JS-driven
 * (inline styles cannot express a pseudo-class), the 90° rotation is the
 * open state, and the disabled look mirrors the reference's `:disabled`
 * rule (disabled while the card saves). The focus-visible ring is the
 * same port.
 */
function MsChevron(props: {
  open: boolean;
  disabled?: boolean;
  ariaLabel: string;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  const { focused, bind } = useFocusRing();
  const { open, disabled } = props;
  return (
    <button
      type="button"
      aria-label={props.ariaLabel}
      aria-expanded={open}
      disabled={disabled}
      onClick={props.onClick}
      onMouseEnter={() => {
        if (!disabled) setHover(true);
      }}
      onMouseLeave={() => setHover(false)}
      onFocus={bind.onFocus}
      onBlur={bind.onBlur}
      style={{
        boxSizing: "border-box",
        flex: "none",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 24,
        height: 24,
        // The outline the other buttons / controls in the section carry
        // (the `1px var(--dsw-alias-border-l2)` + r8 grammar).
        border: "1px solid var(--dsw-alias-border-l2)",
        borderRadius: 8,
        background: hover && !disabled ? "var(--dsw-alias-interactive-bg-hover-solid)" : "transparent",
        color: "var(--dsw-alias-label-secondary)",
        cursor: disabled ? "default" : "pointer",
        ...ringStyle(focused),
        ...(disabled ? { opacity: 0.4 } : {}),
      }}
    >
      <span
        style={{
          display: "inline-block",
          fontSize: 13,
          lineHeight: "18px",
          transform: open ? "rotate(90deg)" : "none",
          transition: "transform 120ms ease",
        }}
      >
        ›
      </span>
    </button>
  );
}

/**
 * The detail's field patches (the editable surface): the fields
 * the detail's controls draft (the thinking-level rows get their own
 * handlers — the row editor refuses duplicate keys inline).
 */
type ConfigPatch = Partial<
  Pick<ModelConfigDraft, "contextWindow" | "maxTokens" | "nothink" | "imageInput" | "reasoningEffort">
>;

/**
 * The model row's dropped-down detail block (the
 * reference's expanded row) — the EDITABLE per-model configuration
 * surface (the ONLY deep-edit surface). Layout (the detail order):
 * 1) Context window / Max output tokens (two columns); 2) the
 * Capabilities group — the **Image input** + **Reasoning effort**
 * checkboxes ("Reasoning effort" = the model HAS a reasoning-effort
 * dimension: the EFFECTIVE thinkingLevelMap non-empty; OFF = the nothink
 * sentinel — the old verbose nothink checkbox is gone); 3) the
 * reasoning-effort map (the thinkingLevelMap rows) — shown ONLY while the
 * capability is ON, two columns of drop-downs with the **Harness** (the
 * map key) / **Model** (the map value, or "not supported") headings, `+`
 * after the last row, `−` at the right of each row (the verbose
 * "Thinking level map" label + hint are dropped); 4) the per-model
 * **Default effort** select (the entry's `defaultEffort` — shown only
 * while the reasoning capability is ON; empty = the built-in fallback);
 * 5) the read-only "preserved from
 * settings.yaml" line (the deep compat fields are NEVER editable — they
 * are preserved through every save by the write discipline); 6) Reset
 * (bottom-right, draft-scoped).
 *
 * The controls show the draft's values once the draft exists (the first
 * edit creates it — the client seeds it from the EFFECTIVE committed ∪
 * discovered baseline) and the baseline's while it
 * doesn't (a detail the user never touches commits nothing — the
 * discovery seed is display-only, never committed as user overrides).
 * While a pending Reset owns the entry the controls disable — the commit
 * releases the entry's configuration (editing it would re-create it) —
 * and the button reads "Undo reset". Reset is offered when the row has a
 * COMMITTED configuration, carries a draft, or is already pending.
 * Every control is aria-labelled and carries the reference's focus paint
 * (the `:focus` border / `:focus-visible` ring — JS-driven, inline styles
 * cannot express the pseudo-classes).
 */
function ModelDetail(props: {
  /** The row's display label (the name, or the id for a still-nameless row) — the aria arg. */
  id: string;
  /** i18n — the live locale (the section's useModelspokeLocale result). */
  locale: LocaleId;
  /** The detail's config draft (once the user has touched a control). */
  draft: ModelConfigDraft | undefined;
  /** The EFFECTIVE (committed ∪ discovered) values the controls show
   * while no draft exists (committed wins per field — the qwen3.8 fix: a
   * discovered thinkingLevelMap renders the Reasoning-effort capability
   * ON + its map rows with no committed override). */
  baseline: ModelConfigBaseline;
  /** The row's COMMITTED tier-1 entry minus the identity fields (the
   * preserved-line source; an identity-only entry preserves nothing). */
  effective: Record<string, unknown> | null;
  /** The row's per-model default effort (the entry field; `""` =
   * provider default). */
  defaultEffort: string;
  resetPending: boolean;
  saving: boolean;
  onPatch: (patch: ConfigPatch) => void;
  /** The Reasoning-effort capability toggle (ON = the model has a
   * reasoning-effort dimension; OFF = the nothink sentinel). */
  onReasoning: (on: boolean) => void;
  onDefaultEffort: (value: string) => void;
  onTl: (index: number, field: "key" | "value", value: string) => void;
  onTlAdd: () => void;
  onTlRemove: (index: number) => void;
  onReset: () => void;
}) {
  const d = props.draft ?? props.baseline;
  const disabled = props.saving || props.resetPending;
  const preserved = preservedSummary(props.locale, props.effective);
  // "Reasoning effort" = the model HAS a reasoning-effort dimension:
  // the effective thinkingLevelMap is non-empty (the nothink sentinel or an
  // empty map = OFF). The old verbose nothink checkbox is gone — it is this
  // capability, off.
  const reasoningOn = !d.nothink && d.tlRows.length > 0;
  return (
    <div style={ms.modelDetail}>
      <div style={ms.modelDetailGrid}>
        <div style={ms.modelDetailField}>
          <span style={ms.modelDetailLabel}>{t(props.locale, "labelContextWindow")}</span>
          <MsText
            ariaLabel={t(props.locale, "ariaContextWindowFor", { id: props.id })}
            inputMode="numeric"
            placeholder={t(props.locale, "phUnsetResolves")}
            value={d.contextWindow}
            disabled={disabled}
            onChange={(value) => props.onPatch({ contextWindow: value })}
          />
        </div>
        <div style={ms.modelDetailField}>
          <span style={ms.modelDetailLabel}>{t(props.locale, "labelMaxTokens")}</span>
          <MsText
            ariaLabel={t(props.locale, "ariaMaxTokensFor", { id: props.id })}
            inputMode="numeric"
            placeholder={t(props.locale, "phUnsetResolves")}
            value={d.maxTokens}
            disabled={disabled}
            onChange={(value) => props.onPatch({ maxTokens: value })}
          />
        </div>
      </div>
      {/* The Capabilities group: the two capability checkboxes. */}
      <div style={ms.detailGroup}>
        <span style={ms.detailGroupLabel}>{t(props.locale, "capabilitiesLabel")}</span>
        <label style={ms.detailCheck}>
          <input
            type="checkbox"
            checked={d.imageInput}
            disabled={disabled}
            aria-label={t(props.locale, "ariaImageInputFor", { id: props.id })}
            onChange={(e) => props.onPatch({ imageInput: e.target.checked })}
          />
          <span>{t(props.locale, "imageInputLabel")}</span>
        </label>
        <label style={ms.detailCheck}>
          <input
            type="checkbox"
            checked={reasoningOn}
            disabled={disabled}
            aria-label={t(props.locale, "ariaReasoningEffortFor", { id: props.id })}
            onChange={(e) => props.onReasoning(e.target.checked)}
          />
          <span>{t(props.locale, "reasoningEffortLabel")}</span>
        </label>
      </div>
      {/* The reasoning-effort map (the thinkingLevelMap rows): shown
          ONLY while the capability is ON. Two columns of drop-downs with
          the Harness / Model headings — the Harness column is the map KEY
          (the level the user picks, includes "off"), the Model column the
          map VALUE (the level the model accepts) or "not supported"
          (null). `+` after the last row adds a row, `−` at the right of
          each row removes it. */}
      {reasoningOn ? (
        <div style={ms.detailGroup}>
          <div style={ms.mapHead} aria-hidden="true">
            <span style={ms.mapHeadCell}>{t(props.locale, "harnessColumn")}</span>
            <span style={ms.mapHeadCell}>{t(props.locale, "modelColumn")}</span>
            <span style={ms.mapHeadCell} />
          </div>
          {d.tlRows.map((row, index) => (
            <div key={`${row.key}-${index}`} style={ms.mapRow}>
              <MsSelect
                style={ms.tlSelect}
                ariaLabel={t(props.locale, "ariaThinkingLevelRow", { id: props.id, row: index + 1 })}
                value={row.key}
                disabled={disabled}
                onChange={(value) => props.onTl(index, "key", value)}
              >
                {LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
              </MsSelect>
              <MsSelect
                style={ms.tlSelect}
                ariaLabel={t(props.locale, "ariaAcceptedLevel", { level: row.key, id: props.id })}
                value={row.value}
                disabled={disabled}
                onChange={(value) => props.onTl(index, "value", value)}
              >
                <option value="">{t(props.locale, "notSupported")}</option>
                {EFFORTS.map((level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
              </MsSelect>
              <MsIconButton
                ariaLabel={t(props.locale, "ariaRemoveRow", { level: row.key, id: props.id })}
                title={t(props.locale, "titleRemoveRow", { level: row.key })}
                disabled={disabled}
                onClick={() => props.onTlRemove(index)}
              >
                −
              </MsIconButton>
            </div>
          ))}
          <div style={ms.mapRow}>
            <MsIconButton
              ariaLabel={t(props.locale, "ariaAddLevelRow", { id: props.id })}
              title={t(props.locale, "addLevelRow")}
              disabled={disabled}
              onClick={props.onTlAdd}
            >
              +
            </MsIconButton>
            <span />
            <span />
          </div>
        </div>
      ) : null}
      {/* The per-model Default effort (the entry's `defaultEffort`;
          additive). Shown only while the Reasoning-effort capability is ON
          (pi parity: a non-reasoning model has no effort dimension — any
          effort on it clamps to off). `""` = no per-model default: the
          empty option DISPLAYS the determinable default — the built-in
          fallback (pi's session default `medium`, clamped to this model's
          offered levels). */}
      {reasoningOn ? (
        <div style={ms.detailGroup}>
          <span style={ms.detailGroupLabel}>{t(props.locale, "labelDefaultEffort")}</span>
          <MsSelect
            style={ms.detailEffortSelect}
            ariaLabel={t(props.locale, "ariaDefaultEffortFor", { id: props.id })}
            value={props.defaultEffort}
            disabled={disabled}
            onChange={(value) => props.onDefaultEffort(value)}
          >
            <option value="">
              {t(props.locale, "effortBuiltInDefault", {
                level: builtInDefaultLevel(
                  // Offered = rows with a non-empty value ("not supported"
                  // rows are null-mapped and not offered — parity with the
                  // adapter offeredLevels).
                  d.tlRows.filter((row) => row.value !== "").map((row) => row.key),
                ),
              })}
            </option>
            {EFFORTS.map((effort) => (
              <option key={effort} value={effort}>
                {effort}
              </option>
            ))}
          </MsSelect>
        </div>
      ) : null}
      {preserved !== null && (
        <p style={ms.modelDetailHint}>{t(props.locale, "preservedLine", { summary: preserved })}</p>
      )}
      {props.resetPending ? (
        <span style={ms.modelDetailHint}>{t(props.locale, "resetPendingNote")}</span>
      ) : null}
      <div style={ms.modelDetailActions}>
        {(props.effective !== null && Object.keys(props.effective).length > 0) ||
        props.draft !== undefined ||
        props.resetPending ? (
          <MsButton
            dense
            variant="secondary"
            disabled={props.saving}
            ariaLabel={
              props.resetPending
                ? t(props.locale, "ariaUndoResetFor", { id: props.id })
                : t(props.locale, "ariaResetFor", { id: props.id })
            }
            onClick={props.onReset}
          >
            {props.resetPending ? t(props.locale, "undoReset") : t(props.locale, "reset")}
          </MsButton>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The row's WIRE-ID combobox (the spec's id picker): a text input
 * that opens the FULL catalog listing on focus/click (the fetched
 * DiscoveredModelView rows — `name (id)` when the endpoint supplies a
 * name, else `id`), FILTERS on typing (case-insensitive substring over id
 * and name), and accepts a typed id that is not in the listing (the
 * free-text posture — the id is what the endpoint recognizes, the catalog
 * is advisory: an unlisted match shows the "used as-is" hint). Picking a
 * row sets the input's value; typing sets it on the fly (the draft's id
 * is the single state — the input is controlled by it). Keyboard:
 * ArrowUp/Down move the highlight, Enter picks it, Escape closes. The
 * listing is a FIXED-positioned overlay below the input (the StatusDot
 * tooltip's pattern — it escapes the dialog's scroll clipping); it closes
 * on pick / blur / Escape.
 */
function MsCombobox(props: {
  ariaLabel: string;
  locale: LocaleId;
  value: string;
  placeholder?: string;
  options: readonly { id: string; name?: string }[];
  disabled?: boolean;
  autoFocus?: boolean;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);
  const { focused, bind } = useFocusRing();
  const query = props.value.trim().toLowerCase();
  const filtered = props.options.filter(
    (o) =>
      query.length === 0 ||
      o.id.toLowerCase().includes(query) ||
      (o.name ?? "").toLowerCase().includes(query),
  );
  const hi = Math.min(highlight, Math.max(0, filtered.length - 1));
  const showList = open && pos !== null && !props.disabled;
  const openList = (el: HTMLInputElement): void => {
    const rect = el.getBoundingClientRect();
    setPos({ left: rect.left, top: rect.bottom + 4, width: rect.width });
    setOpen(true);
  };
  const pick = (id: string): void => {
    props.onChange(id);
    setOpen(false);
    setPos(null);
  };
  return (
    <div style={ms.comboWrap}>
      <input
        style={{ ...ms.rowIdInput, ...focusStyle(focused) }}
        aria-label={props.ariaLabel}
        role="combobox"
        aria-expanded={showList}
        aria-autocomplete="list"
        value={props.value}
        placeholder={props.placeholder}
        disabled={props.disabled}
        autoFocus={props.autoFocus}
        onChange={(e) => {
          props.onChange(e.target.value);
          setOpen(true);
          if (pos === null) openList(e.currentTarget);
        }}
        onFocus={(e) => {
          bind.onFocus();
          setHighlight(0);
          e.currentTarget.select();
          openList(e.currentTarget);
        }}
        onBlur={() => {
          bind.onBlur();
          setOpen(false);
          setPos(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setHighlight(Math.min(hi + 1, Math.max(0, filtered.length - 1)));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHighlight(Math.max(0, hi - 1));
          } else if (e.key === "Enter") {
            if (showList && filtered[hi] !== undefined) {
              e.preventDefault();
              pick(filtered[hi].id);
            }
          } else if (e.key === "Escape") {
            setOpen(false);
            setPos(null);
          }
        }}
      />
      {showList ? (
        <ul
          role="listbox"
          aria-label={props.ariaLabel}
          style={{ ...ms.comboList, left: pos.left, top: pos.top, width: pos.width }}
        >
          {filtered.length === 0 ? (
            <li style={ms.comboHint} aria-disabled="true">
              {props.options.length === 0
                ? t(props.locale, "comboNoCatalog")
                : t(props.locale, "comboNoMatch")}
            </li>
          ) : (
            filtered.map((o, i) => (
              <li
                key={o.id}
                role="option"
                aria-selected={i === hi}
                style={{ ...ms.comboOption, ...(i === hi ? ms.comboOptionHot : {}) }}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => pick(o.id)}
              >
                <span style={ms.comboOptionId}>
                  {o.name !== undefined && o.name !== "" ? o.name : o.id}
                </span>
                {o.name !== undefined && o.name !== "" ? (
                  <span style={ms.comboOptionMeta}> ({o.id})</span>
                ) : null}
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * The card's model row (the spec's row grammar):
 * `[ name (col 1, mono, editable) ][ id (col 2, wire — combobox) ][ >
 * chevron (config detail) ][ − remove ]` in one inset pill, with the
 * dropped-down detail inside the row's own container (one open at a time
 * — the card owns the single `cardDetailId`, keyed by the row's SLOT key,
 * never its mutable name (a name may transiently collide with a sibling).
 * Presence in the list IS the served state — there is no active
 * checkbox; the chevron is always enabled (every row is served).
 */
function ModelRow(props: {
  locale: LocaleId;
  /** The row's entry (the draft's once materialized, else the seed's). */
  entry: ModelEntry;
  detailOpen: boolean;
  saving: boolean;
  resetPending: boolean;
  /** The row's name collides with another row's — refused inline (the
   * red border; the Apply gate blocks the commit). */
  nameInCollision: boolean;
  /** The fetched catalog is ready (the combobox's options are populated). */
  catalogReady: boolean;
  options: readonly { id: string; name?: string }[];
  configDraft: ModelConfigDraft | undefined;
  baseline: ModelConfigBaseline;
  effective: Record<string, unknown> | null;
  defaultEffort: string;
  onName: (name: string) => void;
  onId: (id: string) => void;
  onDefaultEffort: (value: string) => void;
  onRemove: () => void;
  onToggleDetail: () => void;
  onConfigPatch: (patch: ConfigPatch) => void;
  onReasoning: (on: boolean) => void;
  onTl: (index: number, field: "key" | "value", value: string) => void;
  onTlAdd: () => void;
  onTlRemove: (index: number) => void;
  onReset: () => void;
}) {
  const { entry } = props;
  const label = entry.name !== "" ? entry.name : entry.id;
  return (
    <li style={ms.modelItem}>
      <div style={ms.modelRow}>
        {/* Col 1: the NAME (the harness identity — mono, editable; a
            cleared name defaults to the id at commit; a collision is
            refused inline: the red border + the Apply gate). */}
        <MsText
          style={{
            ...ms.modelRowNameField,
            ...(props.nameInCollision ? { borderColor: "var(--dsw-alias-state-error-primary)" } : {}),
          }}
          ariaLabel={t(props.locale, "ariaModelNameFor", { id: label })}
          placeholder={entry.id}
          value={entry.name}
          disabled={props.saving || props.resetPending}
          onChange={props.onName}
        />
        {/* Col 2: the WIRE ID (the combobox — the FULL catalog listing on
            focus, filter on typing, an unlisted id typed directly). */}
        <MsCombobox
          ariaLabel={t(props.locale, "ariaModelIdFor", { id: label })}
          locale={props.locale}
          value={entry.id}
          placeholder={t(props.locale, "phNewModelId")}
          options={props.catalogReady ? props.options : []}
          disabled={props.saving}
          autoFocus={entry.name === "" && entry.id === ""}
          onChange={props.onId}
        />
        {/* The chevron — drops the detail INSIDE the row's own container,
            one open at a time (plain, no badge). */}
        <MsChevron
          open={props.detailOpen}
          disabled={props.saving}
          ariaLabel={
            props.detailOpen
              ? t(props.locale, "ariaHideDetails", { id: label })
              : t(props.locale, "ariaShowDetails", { id: label })
          }
          onClick={props.onToggleDetail}
        />
        {/* The `−` — removes the entry (presence in the list IS the
            served state). */}
        <MsIconButton
          ariaLabel={t(props.locale, "ariaRemoveModel", { id: label })}
          title={t(props.locale, "ariaRemoveModel", { id: label })}
          disabled={props.saving}
          onClick={props.onRemove}
        >
          −
        </MsIconButton>
      </div>
      {props.detailOpen ? (
        <ModelDetail
          id={label}
          locale={props.locale}
          draft={props.configDraft}
          baseline={props.baseline}
          effective={props.effective}
          defaultEffort={props.defaultEffort}
          resetPending={props.resetPending}
          saving={props.saving}
          onPatch={props.onConfigPatch}
          onReasoning={props.onReasoning}
          onDefaultEffort={props.onDefaultEffort}
          onTl={props.onTl}
          onTlAdd={props.onTlAdd}
          onTlRemove={props.onTlRemove}
          onReset={props.onReset}
        />
      ) : null}
    </li>
  );
}

/**
 * The provider row's status dot + hover/focus tooltip.
 * The dot shows the LAST known catalog-fetch state: grey (unknown — not
 * fetched yet), green (the last fetch succeeded), red (the last fetch
 * failed). `state.detail` overrides the kind's default tooltip text — the
 * card's silent catalog fetch feeds the live strings ("N models · last
 * checked 14:02", "400 Bad Request from /v1/models · 14:05").
 *
 * The tooltip is a positioned element (the dsh Tooltip primitive's plate
 * look), shown on mouseenter AND keyboard focus — never a `title`
 * attribute — so assistive tech also receives the state through the
 * anchor's aria-label.
 */
interface StatusDotState {
  kind: "unknown" | "ok" | "error";
  /** The tooltip's detail text; the card's silent fetch feeds the live string. Defaults per kind. */
  detail?: string;
}

/** The dot's default tooltip per kind — localized (the live detail
 * arrives pre-localized through `state.detail`). */
function statusDotDefaultText(locale: LocaleId, kind: StatusDotState["kind"]): string {
  return kind === "unknown"
    ? t(locale, "dotUnknown")
    : kind === "ok"
      ? t(locale, "dotOkDefault")
      : t(locale, "dotErrorDefault");
}

function StatusDot({ state, locale }: { state: StatusDotState; locale: LocaleId }) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const text = state.detail ?? statusDotDefaultText(locale, state.kind);
  const show = (el: Element): void => {
    const rect = el.getBoundingClientRect();
    setPos({ left: rect.left + rect.width / 2, top: rect.bottom + 8 });
  };
  const color =
    state.kind === "ok"
      ? "var(--dsw-alias-state-success-primary)"
      : state.kind === "error"
        ? "var(--dsw-alias-state-error-primary)"
        : "var(--dsw-alias-label-dimmed)";
  return (
    <span
      role="img"
      aria-label={text}
      tabIndex={0}
      onMouseEnter={(e) => show(e.currentTarget)}
      onMouseLeave={() => setPos(null)}
      onFocus={(e) => show(e.currentTarget)}
      onBlur={() => setPos(null)}
      style={{ display: "inline-flex", flex: "none" }}
    >
      <span style={{ ...ms.dot, background: color }} />
      {pos !== null && (
        <span
          aria-hidden="true"
          style={{
            ...ms.tooltip,
            left: pos.left,
            top: pos.top,
            transform: "translateX(-50%)",
          }}
        >
          {text}
        </span>
      )}
    </span>
  );
}


/** Register the Modelspoke section once the shell declares the slot. */
export function apply(ctx: ClientContext): void {
  // One bound scope per plugin activation. The shared describe mirror (owned
  // by the ui-settings base) is the single settings.describe reader; it
  // reloads on the forwarded settings/document-updated event and
  // connection/reset, so every bound scope re-derives and its subscribers
  // fire for settings changes made anywhere — this tab, another tab, or an
  // out-of-band process writing the document (docs/dsh-plugin-guidance.md
  // §3). Reads ride that mirror; writes below settle into it (fold-back on
  // success, reload on failure), so the scope snapshot is always current
  // when a write settles.
  const scope = ctx.settingsScope.bind({ namespace: NAMESPACE });
  // Capture stable callables once (useSyncExternalStore resubscribes when
  // the subscribe function identity changes).
  const subscribe = (listener: () => void) => scope.subscribe(listener);
  const getSnapshot = () => scope.getSnapshot();

  // i18n — bind the host's `locale` namespace for the live preference.
  // FALLBACK-DEFENSIVE: the bind is injectable through attemptLocaleBind so a
  // host WITHOUT the locale plugin (namespace not registered → bind throws)
  // degrades to browser-only instead of crashing the section; the failure is
  // logged once. The `locale` scope is a SECOND, read-only bind alongside the
  // `modelspoke` scope — binding adds no wire read (it derives from the shared
  // describe mirror) and activation never blocks on it.
  const localeAttempt = attemptLocaleBind(
    (): SettingsScope<LocaleSection> => ctx.settingsScope.bind<LocaleSection>({ namespace: "locale" }),
  );
  const localeScope = localeAttempt.scope;
  const localeBindFailed = localeAttempt.bindFailed;
  if (localeBindFailed) warnLocaleBindOnce();
  // Stable callables for the locale's useSyncExternalStore. The unbound case
  // yields a no-op subscribe + the stable empty snapshot (browser-only, no
  // live re-resolution).
  const localeSubscribe = (listener: () => void) =>
    localeScope !== null ? localeScope.subscribe(listener) : () => undefined;
  const localeGetSnapshot = (): SettingsScopeSnapshot<LocaleSection> =>
    localeScope !== null ? localeScope.getSnapshot() : EMPTY_LOCALE_SNAPSHOT;

  /**
   * i18n — the LIVE locale for the section / onboarding: the bound
   * `locale.preference` (re-resolved on every snapshot change — a language
   * switch is a snapshot replacement that re-renders the section without a
   * reload), else the browser language (`navigator.language`), else (a failed
   * bind) the browser language alone. Pure resolution in locales.js; the
   * navigator read stays here (the DOM half).
   */
  const useModelspokeLocale = (): LocaleId => {
    const localeSnapshot = useSyncExternalStore(localeSubscribe, localeGetSnapshot);
    return resolveLocale({
      preference: localeSnapshot.value?.preference,
      browserLanguage: typeof navigator !== "undefined" ? navigator.language : undefined,
      bindFailed: localeBindFailed,
    });
  };

  // The host's wire client (the connection service is injected above, so
  // it is provided before this apply runs). `api.llm.discoverModels` routes
  // to the node half's registered discovery callback (`registerModelDiscovery`
  // in src/dsh/index.ts)
  // — the SAME interrogation the node adapter answers, so the card's silent
  // fetch sees the real endpoint catalog.
  const connection = ctx.get("connection") as ConnectionHandle;
  const api = connection.api;

  /**
   * The Modelspoke settings page: loading / unavailable / empty / routes
   * states over the live scope snapshot, plus route CRUD.
   */
  const ModelspokeSection = () => {
    const snapshot = useSyncExternalStore(subscribe, getSnapshot);
    // i18n — the live locale (preference → browser; live via subscribe).
    const locale = useModelspokeLocale();
    // The async catalog-fetch continuation resolves its detail text with
    // the locale CURRENT at settlement (not at fetch start): a language
    // switch mid-fetch lands on the right locale. A "latest value" ref.
    const localeRef = useRef<LocaleId>(locale);
    localeRef.current = locale;
    const [draft, setDraft] = useState<Draft | null>(null);
    const [formError, setFormError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    // The inline write error is paired with the snapshot it was raised on:
    // any snapshot replacement (our own write settling, an out-of-band
    // change, a recovery reload) invalidates it automatically.
    const [writeError, setWriteError] = useState<string | null>(null);
    const [writeErrorSnap, setWriteErrorSnap] = useState<unknown>(null);
    // The one open provider card: the three-field draft + its committed
    // baseline, the draft `models` entry list (the model rows' curation
    // state) + the "Add model" inline row, and the per-model config drafts
    // (the detail's editable surface).
    const [card, setCard] = useState<CardDraft | null>(null);
    // The open card's expand-fetch catalog (the list area's loading /
    // error / ready views) — the `api.llm.discoverModels` RPC (the node
    // half's registered discovery callback — real catalog, no local copy;
    // silent: no button, no dialog).
    const [catalog, setCatalog] = useState<CatalogState | null>(null);
    // The qwen3.8 fix: the per-provider DISCOVERED metadata cache
    // (route name → wire id → the discovered canonical fields), from the
    // /modelspoke channel's `discoverMetadata` fetch — re-fetched on every
    // card expand, keyed per provider (a later card's fetch for the same
    // provider simply replaces the entry). Display-only input to the
    // detail's effective baseline (never committed).
    const [metaByRoute, setMetaByRoute] = useState<Record<string, Record<string, DiscoveredMetadata>>>({});
    // The open card's per-model detail — the ROW NAME (the
    // harness identity) whose chevron is expanded (one open at a time;
    // null = all collapsed). Card-local UI state (never committed); reset
    // on every expand.
    const [cardDetailId, setCardDetailId] = useState<string | null>(null);
    // The "Next" flow: the provider name a VERIFIED add commit asks to
    // expand into its open card (the add form and the provider section are
    // separate elements — the form commits the route, then the new row's
    // card opens on it and its silent fetch lists the served models).
    // Consumed by the effect after `openCard` (null = nothing pending).
    const [expandAfterAdd, setExpandAfterAdd] = useState<string | null>(null);
    // The per-provider LAST-known catalog-fetch state feeding
    // the row's status dot (last-fetch-only — no polling; a collapsed row
    // shows last-known, the tooltip timestamp makes staleness explicit).
    const [dotStates, setDotStates] = useState<Record<string, StatusDotState>>({});
    // The latest catalog-fetch generation: a stale resolution (its card
    // collapsed, a newer fetch superseded it) still updates its dot but
    // must not clobber the list area a newer fetch owns.
    const catalogSeq = useRef(0);
    // The monotonic counter behind the `new-` row-key tokens —
    // unique within (and across) card drafts, so an added row's key can
    // never collide with a seed / committed name or a sibling's token.
    const newRowKeySeq = useRef(0);
    const newRowKey = (): string => `new-${newRowKeySeq.current++}`;

    // The card's provider vanished from the snapshot while the card was
    // open (an out-of-band delete/rename in another tab): collapse it — the
    // draft would have no committed snapshot to write against. (Our own
    // verified re-key lands in the same render batch as the rebase in
    // saveCard, so it never reads as a vanish.)
    useEffect(() => {
      if (card === null) return;
      if (!routesOf(snapshot.value).some((r) => r.name === card.identity)) setCard(null);
    }, [card, snapshot]);

    /**
     * Whole-section write: the FINAL routes array and the FINAL
     * top-level `overrides` map, written and verified as one unit.
     * FIRST-WRITE-FOLDS is applied by the CALLERS, who run the pure
     * {@link foldLegacyOverrides} on the current snapshot and hand the
     * result here (explicit halves keep every caller's intent visible:
     * add/edit/curation pass the plain fold; a delete adds the deleted
     * provider's unclaimed entries to the leftover; a clear removes its id
     * from the top map BEFORE the fold). Ownership rules (src/overrides.ts):
     * single route → everything folds; multi-route → a curated `models:`
     * entry claims its ids, first claimant wins, unclaimed entries stay put.
     *
     * The top level: an empty `topFinal` drops the key via `scope.unset`
     * when the section still carries it (the fold consumed everything —
     * never leave an empty map behind); a non-empty one is a plain
     * single-top-level-field set. Settlement: both writes are
     * revision-fenced by the seam; verification re-derives from the fresh
     * snapshot and compares BOTH halves — routes via {@link routeKey} (which
     * now carries `overrides` in canonical form, so a write that dropped a
     * provider's configurations reads as a divergence) and the top level via
     * the normalized canonical compare ({@link sameOverrides}; the settlement
     * view is schema-resolved and materializes empty defaults the clean
     * write omits). On divergence the writeError surfaces and the UI
     * re-derives from the snapshot (no local copy exists).
     */
    /**
     * The in-memory route ({@link RouteRow}: `models: ModelEntry[] |
     * null`, `legacyOverrides`) → the STORED-shape route object the fold
     * and the phantom-inverse writer consume (`models` key omitted while
     * FULL_CATALOG; `legacyOverrides` → the stored `overrides` key). The
     * node half's `storeRoute` keeps the stored form byte-for-byte; this
     * mapping is the client's equivalent at the commit boundary.
     */
    const toStoredRoute = (r: RouteRow): Record<string, unknown> => ({
      name: r.name,
      baseURL: r.baseURL,
      ...(r.apiKeyEnv !== undefined ? { apiKeyEnv: r.apiKeyEnv } : {}),
      ...(r.models === null ? {} : { models: r.models }),
      ...(r.legacyOverrides !== undefined ? { overrides: r.legacyOverrides } : {}),
    });

    const commit = async (
      finalRoutes: Record<string, unknown>[],
      topFinal: Record<string, unknown>,
    ): Promise<boolean> => {
      setSaving(true);
      try {
        // The section still carries a top-level key (any content) → an empty
        // topFinal must UNSET it (never leave an empty map in the yaml).
        const hasTopKey = Object.keys(topLevelOverridesOf(snapshot.value)).length > 0;
        // The fold's routes are the STORED-shape objects (the phantom
        // inverse — an explicit entry list stripped, a FULL_CATALOG route's
        // `models` key dropped, the legacy `overrides` map stripped or
        // dropped).
        const routes = finalRoutes.map((raw) =>
          isPlainObject(raw) ? cleanRoutePhantoms(raw) : raw,
        );
        await scope.set("routes", routes);
        if (Object.keys(topFinal).length > 0) {
          await scope.set("overrides", topFinal);
        } else if (hasTopKey) {
          // The fold (or a delete/clear) consumed every legacy entry — drop
          // the key rather than leaving an empty map behind.
          await scope.unset("overrides");
        }
        const now = scope.getSnapshot();
        const okRoutes = sameRoutes(routesOf(now.value), routes);
        const okTop = sameOverrides(topMapOf(now.value), topFinal);
        if (okRoutes && okTop) {
          setWriteError(null);
          setFormError(null);
          setDraft(null);
          return true;
        }
        setWriteError(t(locale, "saveFailed"));
        setWriteErrorSnap(now);
        return false;
      } finally {
        setSaving(false);
      }
    };

    /**
     * The one-line fold every routes-write caller runs: the CURRENT
     * snapshot's legacy top level (phantom-stripped) folded over
     * `nextRoutes` — the fold's routes + leftover are the commit's halves.
     */
    const foldedCommit = async (nextRoutes: RouteRow[]): Promise<boolean> => {
      const fold = foldLegacyOverrides({
        routes: nextRoutes.map(toStoredRoute),
        overrides: topMapOf(snapshot.value),
      });
      return commit(fold.routes as Record<string, unknown>[], fold.leftover);
    };

    /**
     * Orphaned-override cleanup — the section commit adapted
     * to the TOP-LEVEL HALF ONLY (the `overrides` key): the write is the
     * existing single-top-level-field `scope.set` — or the `scope.unset`
     * when the result is empty (the section's omit-empty rule: the last
     * entry's delete drops the key rather than leaving an empty map
     * behind), revision-fenced by the seam exactly as {@link commit}'s
     * writes are. The routes half is NEVER written (byte-preserved — the
     * whole-array routes write every other path runs is deliberately NOT
     * reused: a delete of one top-level key must not re-serialize the
     * routes array it does not change, and the open card / add-form draft
     * states are left alone — `commit`'s success-time `setDraft(null)`
     * close is intentionally omitted here too). Read-back verification is
     * the same two-half discipline: the top level must match what we
     * wrote ({@link sameOverrides} — the settlement view is schema-
     * resolved and materializes the empty defaults a clean write omits)
     * AND the routes half must be UNCHANGED from the pre-commit snapshot
     * ({@link sameRoutes} — this commit never touches it, so any
     * divergence means the write settled into a document we did not read).
     * On divergence the writeError surfaces and the UI re-derives from the
     * snapshot (no local copy exists).
     */
    const commitTopOverrides = async (topFinal: Record<string, unknown>): Promise<boolean> => {
      const routesBefore = routesOf(snapshot.value);
      setSaving(true);
      try {
        const hasTopKey = Object.keys(topLevelOverridesOf(snapshot.value)).length > 0;
        if (Object.keys(topFinal).length > 0) {
          await scope.set("overrides", topFinal);
        } else if (hasTopKey) {
          await scope.unset("overrides");
        }
        const now = scope.getSnapshot();
        const okTop = sameOverrides(topMapOf(now.value), topFinal);
        const okRoutes = sameRoutes(routesOf(now.value), routesBefore);
        if (okTop && okRoutes) {
          setWriteError(null);
          return true;
        }
        setWriteError(t(locale, "saveFailed"));
        setWriteErrorSnap(now);
        return false;
      } finally {
        setSaving(false);
      }
    };

    /**
     * The card's SILENT catalog fetch on expand — no fetch button, no
     * selection dialog. Calls `api.llm.discoverModels` (the node half's
     * registered discovery callback — real catalog, no local copy). On
     * success the row's dot goes green with "N models · last checked
     * HH:MM" and the fetched catalog feeds the count hint and the
     * FULL_CATALOG seed (viewed-only rows); on failure the list area shows
     * the one-line error + retry (configured models still listed) and the
     * dot goes red with the SPECIFIC problem. No write ever happens
     * here — fetch is read-only; curation writes commit through the card's
     * checkmark.
     *
     * `apiKeyEnv` is the provider's COMMITTED key env (the discovery RPC
     * reads the current settings, not the card draft) — it only feeds the
     * 401 tooltip variant ("401 Unauthorized — set <ENV>").
     */
    const fetchCatalog = (routeName: string, apiKeyEnv: string | undefined): void => {
      const seq = ++catalogSeq.current;
      setCatalog({ route: routeName, status: "loading", models: [] });
      void (async (): Promise<void> => {
        let models: DiscoveredModelView[] | null = null;
        let message: string | null = null;
        try {
          const response = await api.llm.discoverModels({
            settingsNs: NAMESPACE,
            provider: routeName,
          });
          // Narrow before the state updates: property-access narrowing does
          // not cross the closure boundary.
          const result = response.result;
          if (!result.ok) message = result.error.message;
          else models = result.value.models;
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }
        const at = clockLabel(new Date());
        setDotStates((prev) => ({
          ...prev,
          [routeName]:
            models !== null
              ? { kind: "ok", detail: catalogOkDetail(localeRef.current, models.length, at) }
              : {
                  kind: "error",
                  detail: catalogErrorDetail(
                    localeRef.current,
                    message ?? t(localeRef.current, "dotErrorUnknown"),
                    apiKeyEnv,
                    at,
                  ),
                },
        }));
        // A superseded fetch (its card collapsed + re-expanded, or another
        // card's fetch started) still just reported its dot — it must not
        // clobber the list area the newer fetch owns.
        if (seq !== catalogSeq.current) return;
        if (models !== null) {
          setCatalog({ route: routeName, status: "ready", models });
        } else {
          setCatalog({ route: routeName, status: "error", error: message ?? "The model fetch failed.", models: [] });
        }
      })();
    };

    /**
     * The qwen3.8 fix — the DISCOVERED-METADATA fetch, alongside the
     * catalog fetch on every card expand: a loopback RPC to the node
     * half's /modelspoke channel (the same `connection.rpc.call` pattern
     * the onboarding step uses):
     * `discoverMetadata { provider }` → `{ models: [{ id, name?,
     * discoveredCanonical? }] }` — the per-wire-id DISCOVERED canonical
     * fields (the discovery tier the dsh catalog view does not carry:
     * `input`, `reasoning`, `thinkingLevelMap`, `compat`, …). The result
     * is cached per provider ({@link DiscoveredMetadata} keyed by wire id)
     * and re-fetched on each expand; the model detail seeds its EFFECTIVE
     * display from it (committed ∪ discovered, committed wins).
     *
     * DEGRADATION (the spec's closed-error contract): an unknown provider,
     * a fetch failure, or a malformed result leaves the provider with no
     * metadata — the details then seed from the COMMITTED baseline only
     * (treated like the catalog-fetch failure state: no error surface, no
     * blocking).
     */
    const fetchMetadata = (routeName: string): void => {
      void (async (): Promise<void> => {
        try {
          const result = await connection.rpc.call("/modelspoke", "discoverMetadata", {
            provider: routeName,
          });
          if (result.ok !== true) return;
          const value = result.value;
          if (!isPlainObject(value) || !Array.isArray(value.models)) return;
          const byId: Record<string, DiscoveredMetadata> = {};
          for (const raw of value.models as readonly unknown[]) {
            if (!isPlainObject(raw)) continue;
            const id = typeof raw.id === "string" ? raw.id : "";
            if (id.length === 0) continue;
            byId[id] = {
              id,
              ...(typeof raw.name === "string" && raw.name.length > 0 ? { name: raw.name } : {}),
              ...(isPlainObject(raw.discoveredCanonical)
                ? { discoveredCanonical: raw.discoveredCanonical }
                : {}),
            };
          }
          setMetaByRoute((prev) => ({ ...prev, [routeName]: byId }));
        } catch {
          // The endpoint is absent / the fetch failed: the details seed
          // from the committed baseline only (the degradation above).
        }
      })();
    };

    const openAdd = (): void => {
      if (saving || card !== null || draft !== null) return;
      setFormError(null);
      setWriteError(null);
      setCard(null);
      setDraft({ name: "", baseURL: "", apiKeyEnv: "" });
    };

    /**
     * The card's EXPAND mechanics (shared by the Edit toggle and the
     * "Next" flow): the three-field draft opens on the committed snapshot
     * — the dirty baseline (checkmark/Cancel disabled until a
     * field diverges from it) — and the model state + the silent
     * catalog/metadata fetches. GUARD-FREE: callers own the preconditions
     * (openCard's single-draft guards; the post-add effect's verified-
     * settle + fresh-snapshot check).
     */
    const expandCard = (route: RouteRow): void => {
      setFormError(null);
      setWriteError(null);
      setCardDetailId(null);
      const base = {
        name: route.name,
        baseURL: route.baseURL,
        apiKeyEnv: route.apiKeyEnv ?? "",
      };
      // The model state opens on the committed SERVED SET — an
      // explicit route's entry list (the dirty baseline: an unedited
      // list reads clean), or null = FULL_CATALOG (the rows are viewed
      // from the fetched-catalog seed; the first entry-list edit
      // MATERIALIZES the draft from that seed — the seed becomes the
      // baseline, so a viewed-only FULL_CATALOG route stays FULL_CATALOG
      // and commits nothing).
      // The per-model drafts open EMPTY (a row with no draft shows its
      // EFFECTIVE committed ∪ discovered values; the first edit creates
      // the draft seeded from that effective baseline)
      // and nothing is pending a reset.
      setCard({
        identity: route.name,
        ...base,
        base,
        entries: route.models !== null ? [...route.models] : null,
        baseEntries: route.models !== null ? route.models : [],
        // Unique per-slot keys (seedRowKeys — a committed duplicate
        // name would otherwise yield duplicate React keys).
        rowKeys: route.models !== null ? seedRowKeys(route.models.map((e) => e.name)) : [],
        configDrafts: {},
        pendingReset: [],
      });
      // The SILENT fetch on expand: the list area shows loading until it
      // settles; a fetch is due on EVERY expand (no polling between
      // expands). The discovered metadata rides along (the detail's
      // effective display seeds from it).
      setCatalog({ route: route.name, status: "loading", models: [] });
      fetchCatalog(route.name, route.apiKeyEnv);
      fetchMetadata(route.name);
    };

    /**
     * The row's Edit: EXPAND the provider into its inset card
     * (the reference's Edit → editor-card grammar); Edit again collapses
     * it (the draft is discarded, the reference's toggle behavior).
     * Single-draft discipline: the other surfaces' buttons are disabled
     * while a card is open, and this guard requires none to be open.
     */
    const openCard = (route: RouteRow): void => {
      if (saving || draft !== null) return;
      // Toggle: Edit again collapses — the draft (incl. the model
      // state) is discarded, no write. The catalog/dot states keep the
      // LAST-known fetch (collapsing does not erase the last check).
      if (card !== null && card.identity === route.name) {
        setCard(null);
        setCardDetailId(null);
        return;
      }
      if (card !== null) return; // a different card owns the single draft
      expandCard(route);
    };

    // The "Next" flow's continuation: a VERIFIED add commit flags the new
    // provider's name here; the flag is consumed on the render where the
    // fresh snapshot carries the route (the verified settlement
    // re-derives the snapshot from the write, so it always does — a
    // route never found means an out-of-band delete raced the settle,
    // which gives up silently: the write verified, the list just shows
    // its state). expandCard's silent fetches then populate the new
    // card's model list with the freshly served catalog.
    useEffect(() => {
      if (expandAfterAdd === null) return;
      const route = routesOf(snapshot.value).find((r) => r.name === expandAfterAdd);
      setExpandAfterAdd(null);
      if (route !== undefined) expandCard(route);
    }, [expandAfterAdd, snapshot]);

    /**
     * Edit one of the card's three fields — the draft diverges from the
     * committed snapshot and the checkmark/Cancel enable.
     */
    const cardPatch = (
      patch: Partial<Pick<CardDraft, "name" | "baseURL" | "apiKeyEnv">>,
    ): void => {
      setCard((c) => (c === null ? c : { ...c, ...patch }));
      if (formError !== null) setFormError(null);
    };

    /** The card's row universe for a FULL_CATALOG provider: the
     * fetched catalog (only a READY catalog for this card counts) or —
     * while the catalog is loading/errored — the configured wire ids (the
     * legacy map's keys). Either way the seed is the PURE rule (src/dsh/
     * curation.ts `seedCatalogEntries`): each `{ name: id, id,
     * …legacyOverrides[id] }` (the cosmetic legacy `name` dropped — the
     * migration rule). It feeds the FULL_CATALOG draft's row DISPLAY and
     * is the MATERIALIZATION SEED for the first entry-list edit. */
    const fullCatalogUniverse = (identity: string, route: RouteRow): ModelEntry[] => {
      const ready = catalog !== null && catalog.route === identity && catalog.status === "ready";
      const rows = ready
        ? catalog.models
        : Object.keys(route.legacyOverrides ?? {}).map((id) => ({ id }));
      return seedCatalogEntries(rows, route.legacyOverrides);
    };

    /** The card's current entry list: the draft list, or the
     * FULL_CATALOG universe (a not-yet-materialized draft). Null when the
     * card or its provider is gone. */
    const cardEntriesNow = (): ModelEntry[] | null => {
      const c = card;
      if (c === null) return null;
      if (c.entries !== null) return c.entries;
      const route = routesOf(snapshot.value).find((r) => r.name === c.identity);
      return route === undefined ? null : fullCatalogUniverse(c.identity, route);
    };

    /** The slot keys for the card's CURRENT row list: the draft's
     * `rowKeys` once materialized, else the seed derivation over the
     * FULL_CATALOG universe — the SAME `seedRowKeys` rule the card seeded
     * with at open / materialization (so the address is identical on both
     * sides of a materialization and nothing remounts). Always unique:
     * duplicated seed names are suffixed `-2`, `-3`, … by the pure rule. */
    const rowKeysFor = (c: CardDraft, entries: ModelEntry[]): string[] =>
      c.entries !== null ? c.rowKeys : seedRowKeys(entries.map((e) => e.name));

    /** Address a row by its SLOT key: the row's entry and index in
     * the card's current row list (the draft list, or the FULL_CATALOG
     * universe while unmaterialized). Null when the card is closed, its
     * provider is gone, or the key is stale (the slot was removed). The
     * row's NAME is deliberately NOT the address — it is a mutable label
     * that may collide with a sibling's, and name-keyed addressing is what
     * fused two same-named rows (the "locked rows" bug). */
    const slotOf = (rowKey: string): { entries: ModelEntry[]; entry: ModelEntry; index: number } | null => {
      const c = card;
      if (c === null) return null;
      const entries = cardEntriesNow();
      if (entries === null) return null;
      const index = rowKeysFor(c, entries).indexOf(rowKey);
      const entry = index >= 0 ? entries[index] : undefined;
      return entry !== undefined ? { entries, entry, index } : null;
    };

    /**
     * The dashed "Add model" slot (bottom of the list): appends an
     * empty row (the pure `addModelEntry`). The new row's id is an open
     * combobox (auto-focused — the row is mounted empty) and its name
     * auto-fills from the picked id — DEDUPLICATED (`dedupeName`: a taken
     * name gets the same `name-2` suffix the one-click fix offers), so the
     * Add → pick-id flow never lands in a collision; an open row with no
     * id is discarded on Apply (it never dirties the card — the dirty
     * check runs over the committed form). A not-yet-materialized FULL_CATALOG draft
     * MATERIALIZES first (seeded from the current universe — the seed
     * becomes the dirty baseline, so an unedited seed reads clean). The
     * appended row gets a FRESH `new-` row-key
     * token (the seed rows keep their names as keys).
     */
    const cardAddModel = (): void => {
      const key = newRowKey();
      setCard((c) => {
        if (c === null) return c;
        if (c.entries !== null) {
          return {
            ...c,
            entries: addModelEntry(c.entries, { name: "", id: "" }),
            rowKeys: [...c.rowKeys, key],
          };
        }
        const route = routesOf(snapshot.value).find((r) => r.name === c.identity);
        if (route === undefined) return c;
        const seed = fullCatalogUniverse(c.identity, route);
        return {
          ...c,
          entries: addModelEntry(seed, { name: "", id: "" }),
          baseEntries: seed,
          // The seed's slot keys (unique — the same seedRowKeys
          // derivation the unmaterialized view renders with), + the fresh token.
          rowKeys: [...seedRowKeys(seed.map((e) => e.name)), key],
        };
      });
      if (formError !== null) setFormError(null);
    };

    /** The row's `−`: the pure slot delete (`removeModelEntry` at the
     * slot's index) — presence in the list IS the served state. A
     * not-yet-materialized FULL_CATALOG draft MATERIALIZES first (seeded
     * from the current universe — the discipline above). The
     * deleted slot's row-key is spliced with it (the surviving rows' keys
     * are untouched — no row remounts, open details keep their state).
     * The delete also drops the slot's per-row draft state (a
     * config draft / pending reset keyed by the slot must not outlive the
     * row and land on the commit of a model that is no longer served). */
    const cardRemoveModel = (rowKey: string): void => {
      setCard((c) => {
        if (c === null) return c;
        if (c.entries !== null) {
          const index = c.rowKeys.indexOf(rowKey);
          if (index === -1) return c;
          const { configDrafts } = dropRowKey(c.configDrafts, rowKey);
          return {
            ...c,
            entries: removeModelEntry(c.entries, index),
            rowKeys: c.rowKeys.filter((_, i) => i !== index),
            configDrafts,
            pendingReset: c.pendingReset.filter((k) => k !== rowKey),
          };
        }
        const route = routesOf(snapshot.value).find((r) => r.name === c.identity);
        if (route === undefined) return c;
        const seed = fullCatalogUniverse(c.identity, route);
        const index = seedRowKeys(seed.map((e) => e.name)).indexOf(rowKey);
        if (index === -1) return c;
        const { configDrafts } = dropRowKey(c.configDrafts, rowKey);
        return {
          ...c,
          entries: removeModelEntry(seed, index),
          baseEntries: seed,
          rowKeys: seedRowKeys(seed.map((e) => e.name)).filter((_, i) => i !== index),
          configDrafts,
          pendingReset: c.pendingReset.filter((k) => k !== rowKey),
        };
      });
      if (cardDetailId === rowKey) setCardDetailId(null);
      if (formError !== null) setFormError(null);
    };

    /** One row's per-row draft state: the config draft keyed by
     * the slot (undefined when the row was never detailed). */
    const dropRowKey = (
      configDrafts: Record<string, ModelConfigDraft>,
      rowKey: string,
    ): { configDrafts: Record<string, ModelConfigDraft> } => {
      if (configDrafts[rowKey] === undefined) return { configDrafts };
      const next = { ...configDrafts };
      delete next[rowKey];
      return { configDrafts: next };
    };

    /** The row's NAME (the harness identity — col 1, mono,
     * editable): the pure slot re-key (`renameModelEntry` — only this slot
     * is touched). A collision with a sibling's name is NOT refused at edit
     * time: it is surfaced (the red border on every colliding row) and
     * refused at the Apply gate, with the one-click fix (the error line's
     * "Rename to …" — `resolveNameCollision`). A cleared name defaults to
     * the row's wire id (the reader's name rule — name === id when no name
     * is supplied). The row is addressed by its SLOT key, so a
     * colliding name can never fuse two rows — the open detail + config
     * draft ride on the slot and survive the rename (no re-key needed). */
    const cardModelNamePatch = (rowKey: string, rawName: string): void => {
      const c = card;
      const slot = slotOf(rowKey);
      if (c === null || slot === null) return;
      const row = slot.entry;
      const to = rawName.length === 0 ? row.id : rawName;
      if (to.length === 0 || to === row.name) return;
      setCard({
        ...c,
        entries: renameModelEntry(slot.entries, slot.index, to),
        // A materializing edit keys the seed rows by their
        // (pre-edit) names; an already-materialized draft keeps its
        // rowKeys (an in-place edit never moves a slot's key).
        ...(c.entries === null
          ? { baseEntries: slot.entries, rowKeys: seedRowKeys(slot.entries.map((e) => e.name)) }
          : {}),
      });
      if (formError !== null) setFormError(null);
    };

    /** The fetched display name for a wire id (the catalog, READY
     * only), or undefined (the combobox shows the id as-is). */
    const catalogNameOf = (id: string): string | undefined => {
      if (catalog === null || catalog.status !== "ready") return undefined;
      return catalog.models.find((m) => m.id === id)?.name;
    };

    /** The row's WIRE ID (col 2, the combobox — a pick from the
     * FULL catalog listing, or a typed id not in it: the id is what the
     * endpoint recognizes, the catalog is advisory): the pure slot entry
     * mutation (`updateModelEntry` — the name is LOCKED here except the
     * AUTO-FILL). The name auto-fills from the picked id (the fetched
     * display name when the catalog supplies one, else the id) while the
     * name is still the auto value (empty, the previous id, or the previous
     * catalog display name); a manually edited name is never clobbered.
     * The auto-fill NEVER creates a collision — the candidate is
     * passed through `dedupeName`, so a fresh Add-model row picking an
     * id whose name is already used gets the suffixed name (the same
     * `name-2` pattern as the one-click fix) instead of landing in the
     * error state. A manually typed collision is a different story: it is
     * surfaced and gated at Apply, not silently renamed. */
    const cardModelIdPatch = (rowKey: string, rawId: string): void => {
      const c = card;
      const slot = slotOf(rowKey);
      if (c === null || slot === null) return;
      const row = slot.entry;
      if (rawId === row.id) return;
      const oldAuto =
        row.name === "" ||
        row.name === row.id ||
        (catalogNameOf(row.id) ?? row.id) === row.name;
      const toName =
        oldAuto && rawId.length > 0
          ? dedupeName(slot.entries, catalogNameOf(rawId) ?? rawId, slot.index)
          : row.name;
      let next = updateModelEntry(slot.entries, slot.index, { id: rawId });
      if (toName !== row.name) next = renameModelEntry(next, slot.index, toName);
      setCard({
        ...c,
        entries: next,
        // A materializing edit keys the seed rows by their
        // (pre-edit) names; an already-materialized draft keeps its
        // rowKeys (an in-place edit never moves a slot's key).
        ...(c.entries === null
          ? { baseEntries: slot.entries, rowKeys: seedRowKeys(slot.entries.map((e) => e.name)) }
          : {}),
      });
      if (formError !== null) setFormError(null);
    };

    /** The per-model DEFAULT EFFORT select (the detail): a NEW
     * entry-level field (`ModelEntry.defaultEffort` — the model's default
     * effort). `""` = no default (the field is omitted from the written
     * entry; the server's native default applies). Like a name/id edit, this is an ENTRY edit: a
     * FULL_CATALOG draft materializes. */
    const cardModelEffortPatch = (rowKey: string, value: string): void => {
      const c = card;
      const slot = slotOf(rowKey);
      if (c === null || slot === null) return;
      const row = slot.entry;
      const current = typeof row.defaultEffort === "string" ? row.defaultEffort : "";
      if (value === current) return;
      setCard({
        ...c,
        entries: updateModelEntry(
          slot.entries,
          slot.index,
          value === "" ? { defaultEffort: undefined } : { defaultEffort: value },
        ),
        // A materializing edit keys the seed rows by their
        // (pre-edit) names; an already-materialized draft keeps its
        // rowKeys (an in-place edit never moves a slot's key).
        ...(c.entries === null
          ? { baseEntries: slot.entries, rowKeys: seedRowKeys(slot.entries.map((e) => e.name)) }
          : {}),
      });
      if (formError !== null) setFormError(null);
    };

    /** The row's chevron: expand/collapse THIS row's detail
     * block (one open at a time). Every row is served (presence in the
     * list IS the served state) — the chevron is always enabled; the
     * caller enforces the single-draft surfaces (saving / an open
     * configuration form). */
    const cardToggleDetail = (id: string): void => {
      setCardDetailId((cur) => (cur === id ? null : id));
    };

    /** The detail's draft-scoped Reset: mark this row's entry
     * for release in the PENDING card commit (nothing is written on the
     * click — Apply enables, Cancel discards). At commit the row's
     * configuration is released — a FULL_CATALOG route drops the map
     * entry, an explicit route reduces its entry to the identity
     * (`{ name, id }`) — and the model STAYS served (its configuration
     * resolves from discovery / preset / defaults again). Clicking again
     * (the button reads "Undo reset") un-marks it. Offered when the row
     * has a COMMITTED configuration entry, carries a detail draft
     * (resetting then discards the uncommitted edits), or is already
     * pending. A reset also wins over that row's drafts: the commit skips
     * its merges. The argument is the row's SLOT key (not its
     * name), so resetting one of several same-named rows only affects that
     * slot. */
    const cardResetModel = (rowKey: string): void => {
      setCard((c) => {
        if (c === null) return c;
        const pending = c.pendingReset.includes(rowKey)
          ? c.pendingReset.filter((x) => x !== rowKey)
          : [...c.pendingReset, rowKey];
        return { ...c, pendingReset: pending };
      });
      if (formError !== null) setFormError(null);
    };

    /** The qwen3.8 fix — the DISCOVERED canonical fields for one
     * wire id (the per-provider cache from {@link fetchMetadata}), or
     * null when none was fetched (the degradation: the detail seeds from
     * the committed baseline only). DISPLAY INPUT ONLY — never a commit
     * source). */
    const discoveredOf = (routeName: string, wireId: string): Record<string, unknown> | null => {
      const meta = metaByRoute[routeName]?.[wireId]?.discoveredCanonical;
      return isPlainObject(meta) ? meta : null;
    };

    /** The row's COMMITTED tier-1 entry (the dirty baseline, the
     * merge base, the preserved line): an explicit route's committed
     * entry (by the row's name — the card opened on the committed list;
     * the reference match covers a row whose name moved under a draft),
     * or the dual-shape effective map entry (a FULL_CATALOG route: its
     * own per-wire-id map wins over the legacy top level). NEVER the
     * draft, never the discovery. */
    const committedSourceOf = (c: CardDraft, route: RouteRow, row: ModelEntry): Record<string, unknown> | null => {
      let committed: unknown;
      if (route.models !== null) {
        committed =
          c.baseEntries.find((b) => b === row) ?? c.baseEntries.find((b) => b.name === row.name);
      } else {
        committed = effectiveOverrideEntry(snapshot.value, c.identity, row.id);
      }
      return isPlainObject(committed) ? committed : null;
    };

    /**
     * The detail's baseline: the EFFECTIVE (committed ∪ discovered)
     * values — for each exposed field the committed (tier-1) value wins;
     * when absent, the DISCOVERED value from that wire id's
     * `discoveredCanonical` (the qwen3.8 fix: a discovered
     * `thinkingLevelMap` renders the Reasoning-effort capability ON + its
     * map rows with NO committed override). The DISCOVERY seed is
     * DISPLAY-ONLY: it is the first-edit SEED of the draft (so an
     * unedited discovery-seeded field reads clean) and the COMMIT merge
     * keys on the committed baseline only (an untouched detail commits
     * nothing; a discovery value is never written as a user override).
     * A level key outside the known vocabulary is coerced to "off" (the
     * selects cannot offer it — the discipline the retired form applied).
     */
    const effectiveBaselineOf = (
      routeName: string,
      wireId: string,
      committed: Record<string, unknown> | null,
    ): ModelConfigBaseline => {
      const discovered = discoveredOf(routeName, wireId);
      const tokenOf = (key: "contextWindow" | "maxTokens"): string => {
        const c = committed !== null ? committed[key] : undefined;
        if (typeof c === "number") return String(c);
        const d = discovered !== null ? discovered[key] : undefined;
        return typeof d === "number" ? String(d) : "";
      };
      const rowsOf = (map: Record<string, unknown>): TlRow[] =>
        Object.entries(map).map(([key, value]) => ({
          key: (LEVELS as readonly string[]).includes(key) ? key : "off",
          value: typeof value === "string" && value.length > 0 ? value : "",
        }));
      const cMap = committed !== null ? committed.thinkingLevelMap : undefined;
      let nothink = false;
      let tlRows: TlRow[] = [];
      if (cMap === NO_THINKING_LEVELS) {
        nothink = true;
      } else if (isPlainObject(cMap) && Object.keys(cMap).length > 0) {
        tlRows = rowsOf(cMap);
      } else {
        const dMap = discovered !== null ? discovered.thinkingLevelMap : undefined;
        if (dMap === NO_THINKING_LEVELS) nothink = true; // defensive: discovery sends maps, not the sentinel
        else if (isPlainObject(dMap) && Object.keys(dMap).length > 0) tlRows = rowsOf(dMap);
      }
      const inputOf = (): boolean => {
        const c = committed !== null ? committed.input : undefined;
        if (Array.isArray(c)) return (c as readonly unknown[]).includes("image");
        const d = discovered !== null ? discovered.input : undefined;
        return Array.isArray(d) && (d as readonly unknown[]).includes("image");
      };
      const effortOf = (): boolean => {
        const c =
          committed !== null && isPlainObject(committed.compat)
            ? committed.compat.supportsReasoningEffort
            : undefined;
        if (typeof c === "boolean") return c;
        const d =
          discovered !== null && isPlainObject(discovered.compat)
            ? discovered.compat.supportsReasoningEffort
            : undefined;
        return d === true;
      };
      return {
        contextWindow: tokenOf("contextWindow"),
        maxTokens: tokenOf("maxTokens"),
        nothink,
        tlRows,
        imageInput: inputOf(),
        reasoningEffort: effortOf(),
      };
    };

    /** The row's DISPLAYED config state: the draft (once created)
     * or the effective baseline. The detail renders from this; the
     * reasoning-toggle + row editor decide against it. The draft
     * lookup is by the row's SLOT key (a colliding name must never share a
     * draft between two rows). */
    const displayedConfigOf = (
      c: CardDraft,
      route: RouteRow,
      row: ModelEntry,
      rowKey: string,
    ): ModelConfigDraft | ModelConfigBaseline => {
      const existing = c.configDrafts[rowKey];
      if (existing !== undefined) return existing;
      return effectiveBaselineOf(c.identity, row.id, committedSourceOf(c, route, row));
    };

    /** The draft for the row with slot key `rowKey` — the existing one, or
     * a fresh draft seeded from the EFFECTIVE baseline (committed ∪
     * discovered, with the baseline as its `base` — the
     * checkmark enables on divergence, Cancel discards the draft, and an
     * unedited discovery-seeded field never reads dirty). The
     * slot (not the name) addresses the row, so two same-named rows keep
     * independent drafts. */
    const configDraftOf = (c: CardDraft, rowKey: string): ModelConfigDraft => {
      const existing = c.configDrafts[rowKey];
      if (existing !== undefined) return existing;
      const route = routesOf(snapshot.value).find((r) => r.name === c.identity);
      const entries = c.entries !== null ? c.entries : route === undefined ? [] : fullCatalogUniverse(c.identity, route);
      const row = entries[rowKeysFor(c, entries).indexOf(rowKey)];
      const base =
        route === undefined || row === undefined
          ? {
              contextWindow: "",
              maxTokens: "",
              nothink: false,
              tlRows: [] as TlRow[],
              imageInput: false,
              reasoningEffort: false,
            }
          : effectiveBaselineOf(c.identity, row.id, committedSourceOf(c, route, row));
      return { ...base, base };
    };

    const cardModelConfigPatch = (rowKey: string, patch: ConfigPatch): void => {
      setCard((c) => {
        if (c === null) return c;
        return {
          ...c,
          configDrafts: { ...c.configDrafts, [rowKey]: { ...configDraftOf(c, rowKey), ...patch } },
        };
      });
      if (formError !== null) setFormError(null);
    };

    /** The detail's "Reasoning effort" checkbox (the capability
     * unification): ON = the model HAS a reasoning-effort dimension (the
     * effective `thinkingLevelMap` non-empty), OFF = the nothink sentinel
     * (`thinkingLevelMap: "none"` — the old verbose nothink checkbox is
     * gone; it is "Reasoning effort" off). Checking lifts the sentinel;
     * checking while no row exists seeds the first row (the map's
     * starter, so the dimension has at least one level); unchecking
     * writes the sentinel (the rows stay held, re-shown by re-checking).
     * The field commits through the draft like any other (an edited
     * discovery-seeded map writes an EXPLICIT override for that field —
     * never the discovery's values wholesale). */
    const cardReasoningToggle = (rowKey: string, on: boolean): void => {
      const c = card;
      if (c === null) return;
      const route = routesOf(snapshot.value).find((r) => r.name === c.identity);
      if (route === undefined) return;
      const entries = c.entries !== null ? c.entries : fullCatalogUniverse(c.identity, route);
      const row = entries[rowKeysFor(c, entries).indexOf(rowKey)];
      if (row === undefined) return;
      const d = displayedConfigOf(c, route, row, rowKey);
      if (on) {
        if (d.tlRows.length === 0) {
          // No rows: lifting the sentinel (if set) alone would leave the
          // capability OFF again (rows empty) — seed the starter row in
          // the same move so the checkbox stays ON.
          cardModelConfigPatch(rowKey, { nothink: false });
          cardModelTlAdd(rowKey);
        } else if (d.nothink) {
          // Lifting the sentinel re-shows the rows the OFF toggle held.
          cardModelConfigPatch(rowKey, { nothink: false });
        }
        // already ON with rows: nothing to do
      } else {
        if (d.nothink) return; // already OFF
        cardModelConfigPatch(rowKey, { nothink: true });
      }
    };

    /** The detail's reasoning-effort map row editor (the retired
     * form's discipline, kept): a key change that would duplicate an
     * existing row's key is refused inline (the map's keys are unique). */
    const cardModelTl = (
      rowKey: string,
      index: number,
      field: "key" | "value",
      value: string,
    ): void => {
      if (card === null) return;
      const route = routesOf(snapshot.value).find((r) => r.name === card.identity);
      if (route === undefined) return;
      const entries = card.entries !== null ? card.entries : fullCatalogUniverse(card.identity, route);
      const row = entries[rowKeysFor(card, entries).indexOf(rowKey)];
      if (row === undefined) return;
      const baseRows = displayedConfigOf(card, route, row, rowKey).tlRows;
      if (field === "key") {
        const taken = baseRows.some((row2, i) => i !== index && row2.key === value);
        if (taken) {
          setFormError(t(locale, "errDuplicateTlKeyInline", { key: value }));
          return;
        }
      }
      setCard((c) => {
        if (c === null) return c;
        const draft = configDraftOf(c, rowKey);
        const tlRows = draft.tlRows.map((row2, i) => (i === index ? { ...row2, [field]: value } : row2));
        return { ...c, configDrafts: { ...c.configDrafts, [rowKey]: { ...draft, tlRows } } };
      });
      if (formError !== null) setFormError(null);
    };

    const cardModelTlAdd = (rowKey: string): void => {
      setCard((c) => {
        if (c === null) return c;
        const draft = configDraftOf(c, rowKey);
        return {
          ...c,
          configDrafts: {
            ...c.configDrafts,
            [rowKey]: { ...draft, tlRows: [...draft.tlRows, { key: "off", value: "" }] },
          },
        };
      });
      if (formError !== null) setFormError(null);
    };

    const cardModelTlRemove = (rowKey: string, index: number): void => {
      setCard((c) => {
        if (c === null) return c;
        const existing = c.configDrafts[rowKey];
        if (existing === undefined) return c; // nothing to remove without a draft
        return {
          ...c,
          configDrafts: {
            ...c.configDrafts,
            [rowKey]: { ...existing, tlRows: existing.tlRows.filter((_, i) => i !== index) },
          },
        };
      });
      if (formError !== null) setFormError(null);
    };

    /**
     * Cancel (enabled only while dirty): reverts the draft to the
     * committed snapshot and collapses the card (no write).
     */
    const cancelCard = (): void => {
      if (card === null) return;
      setCard(null);
      setFormError(null);
    };

    /**
     * The collision error line's one-click fix: apply the pure
     * {@link resolveNameCollision} to the draft entry list — the FIRST
     * occurrence keeps the name, the LATER occurrences take the suffixed
     * names (`nextFreeName`, smallest `name-n` free). The slots (rowKeys)
     * are UNTOUCHED — no row remounts, an open detail stays on its row;
     * the red border clears and Apply enables as the names become unique.
     */
    const cardFixNameCollision = (): void => {
      setCard((c) => {
        if (c === null || c.entries === null) return c;
        const fix = resolveNameCollision(c.entries);
        if (fix === null || fix.renamed.length === 0) return c;
        return { ...c, entries: fix.entries };
      });
      if (formError !== null) setFormError(null);
    };

    /**
     * Apply: ONE section commit of the WHOLE card — the four
     * provider fields + the model entry list — through the EXISTING
     * whole-section path (the slot-preserving replace: a provider rename
     * RE-KEYS, the provider's curation + per-model configurations travel
     * with it; the fold handles the legacy top level as always). The
     * draft list commits in its COMMITTED form (the empty-id rows
     * discarded, the blank name defaulted to the id — the readers' rule)
     * and a duplicate name blocks the commit inline (the harness
     * identity is unique per provider). The dual shape: a
     * not-yet-materialized FULL_CATALOG draft (entries still null)
     * commits NO `models` key (the route stays FULL_CATALOG) and its
     * per-wire-id config drafts merge into the route's legacy map
     * (curation.js `cardModelOverrides` — phantom-stripped, omitted when
     * empty); a materialized / explicit draft commits the entry list
     * (the `models` key; the route's legacy map is dropped — the first
     * explicit write already carried it into the seed) where each
     * pending reset reduces its entry to the identity `{ name, id }`
     * (the row STAYS served) and each DIRTY config draft merges onto its
     * entry through the saveOverride discipline (curation.js
     * `applyConfigDraftToEntry` — the entry's name/id preserved, the
     * entry's committed fields byte-preserved, release-to-chain on
     * cleared fields, the phantom guard; a pending reset wins over that
     * row's drafts). Discovery values are NEVER commit sources (the
     * effective display seeds the draft; the merge keys on the COMMITTED
     * baseline). The dirty drafts' token fields are validated before
     * commit (a positive whole number of tokens, or empty to release).
     * On a verified commit the draft re-bases onto what we wrote (the
     * verified snapshot, authoritative) — clean, so Apply and Cancel
     * re-disable and the card stays open under the new key; on a failed
     * one the writeError surfaces, the list re-derives from the
     * snapshot, and the draft stays as-is (still dirty → still enabled).
     */
    const saveCard = async (): Promise<void> => {
      const c = card;
      if (c === null || saving || snapshot.status !== "ready") return;
      const routes = routesOf(snapshot.value);
      const target = routes.find((r) => r.name === c.identity);
      if (target === undefined) {
        setFormError(t(locale, "errProviderGone"));
        return;
      }
      // The node's validation (src/dsh/settings.ts): non-empty name +
      // baseURL; a rename must not shadow a sibling (the name is the route
      // key — the node's assertServiceable refuses duplicates too).
      if (c.name.length === 0) {
        setFormError(t(locale, "errProviderNameRequired"));
        return;
      }
      if (c.baseURL.length === 0) {
        setFormError(t(locale, "errBaseUrlRequired"));
        return;
      }
      if (c.name !== c.identity && routes.some((r) => r.name === c.name)) {
        setFormError(t(locale, "errProviderExists", { name: c.name }));
        return;
      }
      // The dirty config drafts' token fields validate before commit
      // (the retired form's rule, per model: a positive whole number of
      // tokens, or left empty to release the field).
      const validToken = (raw: string): boolean => {
        const v = Number(raw.trim());
        return raw.trim() === "" || (Number.isInteger(v) && v > 0);
      };
      // A draft's key is the row's SLOT — the display name for
      // error lines resolves the slot to the row (the slot key itself is a
      // UI token, not something to show). FULL_CATALOG slots key by their
      // seed name, which IS the wire id (the seed's name === id rule).
      const displayOf = (key: string): string => {
        if (c.entries === null) return key;
        const row = c.entries[c.rowKeys.indexOf(key)];
        if (row === undefined) return key;
        return row.name.length > 0 ? row.name : row.id;
      };
      for (const [rowKey, d] of Object.entries(c.configDrafts)) {
        if (!modelConfigDraftDirty(d)) continue;
        if (!validToken(d.contextWindow)) {
          setFormError(t(locale, "errContextWindow", { id: displayOf(rowKey) }));
          return;
        }
        if (!validToken(d.maxTokens)) {
          setFormError(t(locale, "errMaxTokens", { id: displayOf(rowKey) }));
          return;
        }
        // The row editor refuses duplicate keys inline, but the commit
        // re-checks (the map is written from these rows).
        const seen = new Set<string>();
        for (const row of d.tlRows) {
          if (seen.has(row.key)) {
            setFormError(t(locale, "errDuplicateTlKey", { key: row.key, id: displayOf(rowKey) }));
            return;
          }
          seen.add(row.key);
        }
      }
      // The model rows join this single commit. Resolve the
      // draft entry list to its COMMITTED form (the pure discipline the
      // readers apply: the empty-id rows discarded — the spec's Apply
      // discard — a blank name defaulted to the wire id, the reader's
      // name rule). Null = a FULL_CATALOG draft that was never
      // materialized (viewed only, or config drafts only) — the route
      // STAYS FULL_CATALOG.
      const list = c.entries === null ? null : normalizeEntriesForWrite(c.entries);
      // The name-uniqueness gate (the identity model: name is unique
      // within the provider; duplicate wire ids are legal — variants).
      // The SAME pure computation the UI shows — a duplicate
      // blocks the commit (defense in depth behind the disabled Apply
      // button, in case state changed under the gate).
      const collision = c.entries !== null ? resolveNameCollision(c.entries) : null;
      if (collision !== null) {
        const first = collision.renamed[0];
        if (first !== undefined) {
          setFormError(t(locale, "errNameCollision", { name: first.from }));
          return;
        }
      }
      // The per-model drafts join this SAME single commit (the pure
      // resolution, src/dsh/curation.ts): each DIRTY draft merges through
      // the saveOverride merge discipline — the FULL_CATALOG route's
      // per-wire-id map (`cardModelOverrides`: the pending resets delete
      // their entries, then each dirty config draft merges), the explicit
      // route's entries (`applyConfigDraftToEntry`: the pending resets
      // reduce their entry to the identity FIRST — the row STAYS served —
      // then each dirty config draft merges onto its entry; a reset wins
      // over a row's drafts). The config merges key on the model's
      // COMMITTED tier-1 entry as the merge base (NEVER the discovery —
      // the discipline) + the matched preset's compat object (the
      // whole-block materializer; the preset matches the WIRE id). The
      // resets + releases also drop their ids from the LEGACY top level
      // — BEFORE the fold (a reset entry removed after the fold would be
      // re-folded into a provider's map and come back to life) — so this
      // commit folds its OWN top-level half.
      const configSources: Record<string, ModelConfigSource> = {};
      // The RELEASED ids — the dirty config drafts whose merge yields no
      // entry (every field cleared): they join the pending resets for
      // the LEGACY top-level half (a legacy entry left in place would be
      // re-folded on this very commit and undo the release).
      const released: string[] = [];
      // The draft list commits in SLOT order (a discarded empty-id
      // row keeps its slot as `null`), so a config draft / a pending reset
      // keyed by a row key resolves to EXACTLY the entry its row writes —
      // a stale key (the row was removed) lands nothing instead of falling
      // back to a name match. FULL_CATALOG slots key by their seed name,
      // which IS the wire id (the seed's name === id rule), so the FC path
      // keeps working on the keys as-is.
      const slots = c.entries === null ? null : slotNormalizedEntries(c.entries);
      const slotToList: Record<number, number> = {};
      if (slots !== null) {
        let li = 0;
        for (let i = 0; i < slots.length; i++) {
          if (slots[i] !== null) slotToList[i] = li++;
        }
      }
      const slotWireId = (key: string): string | null => {
        if (c.entries === null) return key; // FULL_CATALOG: the slot key IS the wire id
        const si = c.rowKeys.indexOf(key);
        const slot = si >= 0 && slots !== null ? slots[si] ?? null : null;
        return slot !== null ? slot.id : null;
      };
      for (const [rowKey, d] of Object.entries(c.configDrafts)) {
        if (!modelConfigDraftDirty(d) || c.pendingReset.includes(rowKey)) continue;
        const wireId = slotWireId(rowKey);
        if (wireId === null) continue; // stale slot — its row was removed
        const committed =
          c.entries === null
            ? effectiveOverrideEntry(snapshot.value, c.identity, wireId)
            : (c.baseEntries.find((b) => b.name === displayOf(rowKey)) ??
               c.baseEntries.find((b) => b.id === wireId) ??
               null);
        const preset = matchPreset(wireId) ?? null;
        const source: ModelConfigSource = {
          existing: isPlainObject(committed) ? committed : null,
          presetCompat: preset !== null && isPlainObject(preset.compat) ? preset.compat : null,
        };
        configSources[rowKey] = source;
        if (configDraftReleasesEntry(d, source, undefined)) released.push(wireId);
      }
      let modelsField: ModelEntry[] | null;
      let legacyFinal: Record<string, unknown> | undefined;
      if (list === null) {
        // FULL_CATALOG: the per-wire-id map commit (the stored `models`
        // key is not written — the phantom inverse drops it; the map is
        // written phantom-stripped, omitted when empty).
        modelsField = null;
        legacyFinal = cardModelOverrides(target.legacyOverrides, c.configDrafts, c.pendingReset, configSources);
      } else {
        // EXPLICIT (committed explicit or materialized): the pending
        // resets reduce their entries to the identity (presence in the
        // list IS the served state — the row stays), then each dirty
        // config draft merges onto its entry (the entry's name/id are
        // preserved — the pure applyConfigDraftToEntry). The route does
        // NOT carry an `overrides` key: the config lives in the entries
        // (the first explicit write drops the stored key — the seed
        // already carried the legacy map's config into the entries).
        // A reset / draft addresses its row by SLOT; the slot's
        // written list position is the only address that stays right when
        // two rows share a name (name-keyed merges fused same-named rows).
        let entries = list;
        const listIndex = (rowKey: string): number => {
          const si = c.rowKeys.indexOf(rowKey);
          return si >= 0 ? (slotToList[si] ?? -1) : -1;
        };
        const resetIndexes = new Set(
          c.pendingReset.map(listIndex).filter((i) => i >= 0),
        );
        if (resetIndexes.size > 0) {
          entries = entries.map((e, i) =>
            resetIndexes.has(i) ? ({ name: e.name, id: e.id } as ModelEntry) : e,
          );
        }
        for (const [rowKey, d] of Object.entries(c.configDrafts)) {
          if (!modelConfigDraftDirty(d) || c.pendingReset.includes(rowKey)) continue;
          const li = listIndex(rowKey);
          if (li < 0) continue; // stale slot — its row was removed
          const presetCompat = configSources[rowKey]?.presetCompat ?? null;
          entries = entries.map((e, i) =>
            i === li
              ? applyConfigDraftToEntry(e as unknown as Record<string, unknown>, d, presetCompat)
              : e,
          );
        }
        modelsField = entries;
      }
      // The top-level half drops by WIRE id (the top map is keyed by wire
      // id). The drafts' keys are SLOTS — the slot's written wire
      // id, not its name (a renamed / id-edited row's id differs from the
      // harness name; the old name-based wireOf wrote the wrong key).
      const pendingWireIds: string[] = [];
      for (const key of c.pendingReset) {
        const wireId = slotWireId(key);
        if (wireId !== null) pendingWireIds.push(wireId);
      }
      const topFinal = cardTopOverridesAfterReset(
        topMapOf(snapshot.value),
        [...pendingWireIds, ...released],
      );
      const entry: RouteRow = {
        name: c.name,
        baseURL: c.baseURL,
        ...(c.apiKeyEnv !== "" ? { apiKeyEnv: c.apiKeyEnv } : {}),
        models: modelsField,
        ...(modelsField === null && legacyFinal !== undefined && Object.keys(legacyFinal).length > 0
          ? { legacyOverrides: legacyFinal }
          : {}),
      };
      const nextRoutes = routes.map((r) => (r.name === c.identity ? entry : r)).map(toStoredRoute);
      const fold = foldLegacyOverrides({ routes: nextRoutes, overrides: topFinal });
      if (await commit(fold.routes as Record<string, unknown>[], fold.leftover)) {
        const base = {
          name: entry.name,
          baseURL: entry.baseURL,
          apiKeyEnv: entry.apiKeyEnv ?? "",
        };
        // Re-base the model state onto what we WROTE (the verified
        // snapshot is authoritative) — clean, Apply re-disables. The
        // per-model drafts re-base too: the committed entries (freshly
        // re-derived by the rows / detail) are the new baselines.
        const fresh = routesOf(scope.getSnapshot().value).find((r) => r.name === entry.name);
        const freshModels = fresh !== undefined ? fresh.models : null;
        setCard({
          identity: entry.name,
          ...base,
          base,
          entries: freshModels !== null ? [...freshModels] : null,
          baseEntries: freshModels !== null ? freshModels : [],
          // Re-seed the slot keys from the verified rows (unique
          // names keep their names — nothing remounts; a committed
          // duplicate would get its -2/-3 keys, never a fused row).
          rowKeys: freshModels !== null ? seedRowKeys(freshModels.map((e) => e.name)) : [],
          configDrafts: {},
          pendingReset: [],
        });
      }
    };

    const remove = (route: RouteRow): void => {
      if (saving) return;
      if (!window.confirm(t(locale, "confirmDeleteProvider", { name: route.name }))) return;
      setFormError(null);
      setWriteError(null);
      setDraft(null);
      setCard(null);
      setCatalog(null);
      const nextRoutes = routesOf(snapshot.value).filter((r) => r.name !== route.name);
      // The deleted provider's per-model entries must not be
      // silently erased — the ones no surviving provider claims ride the
      // fold's leftover to the top level (they stay read-compatible
      // there); the ones a survivor already carries are shadowed by it.
      // (a FULL_CATALOG provider's per-wire-id config map is the
      // claimable content — an explicit provider's config lives in the
      // entries that go away WITH the route; no other route inherits it,
      // so a survivor "claims" a wire id by serving it in its own list or
      // carrying its own map entry for it.)
      const survivors: Record<string, unknown> = {};
      for (const [id, entry] of Object.entries(route.legacyOverrides ?? {})) {
        if (
          !nextRoutes.some(
            (r) =>
              (r.legacyOverrides !== undefined && id in r.legacyOverrides) ||
              (r.models !== null && r.models.some((e) => e.id === id)),
          )
        ) {
          survivors[id] = entry;
        }
      }
      const fold = foldLegacyOverrides({
        routes: nextRoutes.map(toStoredRoute),
        overrides: topMapOf(snapshot.value),
      });
      void commit(fold.routes as Record<string, unknown>[], { ...fold.leftover, ...survivors });
    };

    /**
     * Orphaned-override cleanup — the confirm-gated delete
     * of ONE legacy top-level `overrides` entry (the section's block
     * offers it ONLY for orphaned rows — the pure classification
     * `classifyTopOverrides`: no provider route carries its own entry for
     * the id, so the deletion removes the entry from resolution for every
     * provider at once; a claimed row carries the shadowed-by hint
     * instead — deleting it would change behavior for every other route
     * that still inherits it, a route-scoped judgment the provider card
     * is the right place for). The confirm is the section's existing
     * pattern (the Delete provider's `window.confirm`), and the write is
     * the top-level-half-only section commit ({@link commitTopOverrides})
     * of the deletion merge (the pure `removeTopOverrideEntry` — the key
     * removed, every other entry byte-preserved, the empty result the
     * omit-empty signal the commit turns into a `scope.unset`).
     */
    const deleteTopOverride = (modelId: string): void => {
      if (saving) return;
      // The row renders from the snapshot; a vanished entry (an out-of-
      // band change) is a no-op, never a write.
      const top = topMapOf(snapshot.value);
      if (!(modelId in top)) return;
      if (!window.confirm(t(locale, "confirmDeleteTopOverride", { id: modelId }))) return;
      setFormError(null);
      setWriteError(null);
      void commitTopOverrides(removeTopOverrideEntry(top, modelId) ?? {});
    };

    /**
     * Commit the ADD form: the node's validation (non-empty name + baseURL;
     * unique name, the route key — the node write gate
     * `assertServiceable` refuses duplicates too), then an appending
     * whole-section commit. The add flow is the ONLY survivor of
     * the old add/edit form — the edit path is the expanded card
     * (saveCard), which owns the re-key semantics.
     */
    const submitProvider = (): void => {
      if (saving || draft === null || snapshot.status !== "ready") return;
      const routes = routesOf(snapshot.value);
      if (draft.name.length === 0) {
        setFormError(t(locale, "errProviderNameRequired"));
        return;
      }
      if (draft.baseURL.length === 0) {
        setFormError(t(locale, "errBaseUrlRequired"));
        return;
      }
      if (routes.some((r) => r.name === draft.name)) {
        setFormError(t(locale, "errProviderExists", { name: draft.name }));
        return;
      }
      const entry: RouteRow = {
        name: draft.name,
        baseURL: draft.baseURL,
        ...(draft.apiKeyEnv !== "" ? { apiKeyEnv: draft.apiKeyEnv } : {}),
        // A new provider serves the FULL catalog (no served-set
        // field; the first curation edit writes one).
        models: null,
      };
      // The "Next" flow: on a VERIFIED commit the add form closes and the
      // new provider's OWN section opens on it (the expandAfterAdd flag —
      // consumed by the post-openCard effect once the fresh snapshot
      // carries the route). A failed/failed-to-verify commit leaves the
      // form open (its error inline) — nothing is flagged.
      void foldedCommit([...routes, entry]).then((ok) => {
        if (ok) setExpandAfterAdd(entry.name);
      });
    };

    const draftPatch = (patch: Partial<Draft>): void => {
      if (draft === null) return;
      setDraft({ ...draft, ...patch });
      if (formError !== null) setFormError(null);
    };

    return (
      <div style={ms.section}>
        <div style={ms.titleRow}>
          <MsWheelMark style={ms.titleIcon} />
          <h2 style={ms.title}>modelspoke</h2>
        </div>
        <p style={ms.intro}>{t(locale, "intro")}</p>
        {snapshot.status === "loading" && <p>{t(locale, "loadingProviders")}</p>}
        {snapshot.status === "unavailable" && <p>{t(locale, "settingsUnavailable")}</p>}
        {snapshot.status === "ready" &&
          (() => {
            const routes = routesOf(snapshot.value);
            const topMap = topMapOf(snapshot.value);
            const error =
              writeError !== null && writeErrorSnap === snapshot ? writeError : null;
            // The card's dirty flag (the Apply/Cancel gate) — the
            // route fields OR the model state: the entry list
            // diverges from the committed baseline (deep, phantom-
            // tolerant, ORDER-sensitive compare over the COMMITTED form —
            // the empty-id rows discarded, the blank name defaulted; a
            // not-yet-materialized FULL_CATALOG draft has no list
            // changes), a detail config draft, or a pending draft-scoped
            // Reset — all the pure gates in src/dsh/curation.ts.
            const cardDraftEntries =
              card !== null && card.entries !== null
                ? normalizeEntriesForWrite(card.entries)
                : null;
            // The collision + its one-click fix are the SAME pure
            // computation (resolveNameCollision over the RAW draft — its
            // normalized-name rule also catches a cleared name defaulting
            // into a sibling's name). The Apply gate and the red border
            // key off it; the footer button offers renamed[0].to.
            const cardCollisionFix =
              card !== null && card.entries !== null ? resolveNameCollision(card.entries) : null;
            const cardFirstRename =
              cardCollisionFix !== null ? cardCollisionFix.renamed[0] : undefined;
            const cardNameCollision =
              cardFirstRename !== undefined ? cardFirstRename.from : null;
            const cardIsDirty =
              card !== null
                ? cardFieldsDirty(card, card.base) ||
                  cardModelDirty({
                    draftEntries: cardDraftEntries,
                    baseEntries: card.baseEntries,
                    configDrafts: card.configDrafts,
                    pendingReset: card.pendingReset,
                  })
                : false;
            // Single-draft discipline: while an open surface (the
            // card, the add form) is open, the rest of the section is
            // read-only. Delete stays live (confirm-gated; it clears
            // whatever is open, as today).
            const surfaceOpen = card !== null || draft !== null;
            return (
              <>
                {error !== null && <p style={ms.error}>{error}</p>}
                {routes.length === 0 && (
                  <p>
                    {t(locale, "emptyProviders")}{" "}
                    <span style={ms.hint}>{t(locale, "emptyProvidersHint")}</span>
                  </p>
                )}
                <ul style={ms.rows}>
                  {routes.map((route) => {
                    // The provider's CONFIGURED models — an explicit
                    // route's entries carrying configuration (the config
                    // lives in the entries), or a FULL_CATALOG route's
                    // per-wire-id map (its own map ∪ the legacy top level
                    // — a top-level entry resolves on EVERY provider until
                    // the fold moves it).
                    const configuredCount =
                      route.models !== null
                        ? route.models.filter((e) => entryOverride(e) !== undefined).length
                        : new Set<string>([
                            ...Object.keys(route.legacyOverrides ?? {}),
                            ...Object.keys(topMap),
                          ]).size;
                    const cardOpen = card !== null && card.identity === route.name;
                    // The card's model list facts. The
                    // catalog is the list area's data; a loading fetch
                    // shows one skeleton line, an error shows the
                    // one-liner + retry and still lists the configured
                    // rows (the FULL_CATALOG seed falls back to the
                    // configured ids while the catalog is unavailable).
                    const cardCatalog =
                      cardOpen && catalog !== null && catalog.route === route.name ? catalog : null;
                    const cardCatalogReady = cardCatalog !== null && cardCatalog.status === "ready";
                    // The card's row universe — the draft entry list
                    // (explicit or materialized), or the FULL_CATALOG
                    // seed (viewed-only draft: fetched catalog ∪ legacy
                    // config, name = id — the pure seedCatalogEntries).
                    const cardRows: ModelEntry[] =
                      cardOpen && card !== null
                        ? card.entries !== null
                          ? card.entries
                          : fullCatalogUniverse(route.name, route)
                        : [];
                    // The per-slot row keys — the materialized draft's
                    // own `rowKeys`, or the unmaterialized universe's
                    // seedRowKeys derivation (the SAME keys the materializing
                    // edit will carry — materialization remounts nothing).
                    // Every per-row state (open detail, pending reset, config
                    // draft) and every row operation is addressed by this key,
                    // NEVER by the row's (mutable, possibly colliding) name.
                    const cardRowKeys =
                      cardOpen && card !== null ? rowKeysFor(card, cardRows) : [];
                    const cardCountHint =
                      cardCatalog === null || cardCatalog.status === "loading"
                        ? t(locale, "countFetching")
                        : cardCatalog.status === "error"
                          ? t(locale, "countConfigured", { count: configuredCount })
                          : [
                              modelCountLabel(locale, cardCatalog.models.length),
                              ...(configuredCount > 0
                                ? [t(locale, "countConfigured", { count: configuredCount })]
                                : []),
                            ].join(" · ");
                    return (
                      <li key={route.name} style={ms.rowCard}>
                        <div style={ms.rowHead}>
                          <span style={ms.rowIdentity}>
                            <span style={ms.rowName}>{route.name}</span>
                            <StatusDot state={dotStates[route.name] ?? { kind: "unknown" }} locale={locale} />
                          </span>
                          <span style={ms.rowActions}>
                            <MsButton
                              dense
                              variant="secondary"
                              ariaLabel={t(locale, "ariaEditProvider", { name: route.name })}
                              disabled={saving || draft !== null || (card !== null && !cardOpen)}
                              onClick={() => openCard(route)}
                            >
                              {t(locale, "edit")}
                            </MsButton>
                            <MsButton
                              dense
                              variant="danger"
                              ariaLabel={t(locale, "ariaDeleteProvider", { name: route.name })}
                              disabled={saving}
                              onClick={() => remove(route)}
                            >
                              {t(locale, "delete")}
                            </MsButton>
                          </span>
                        </div>
                        {cardOpen && card !== null ? (
                          <div style={ms.editor}>
                            <div style={ms.editorHeader}>
                              <span style={ms.editorTitle}>{card.base.name}</span>
                              {card.name !== card.base.name && card.name.trim() !== "" ? (
                                <span style={ms.editorRoute}>{card.name}</span>
                              ) : null}
                            </div>
                            <div style={ms.field}>
                              <span style={ms.fieldLabel}>{t(locale, "labelName")}</span>
                              <MsText
                                ariaLabel={t(locale, "ariaProviderName")}
                                value={card.name}
                                disabled={saving}
                                onChange={(value) => cardPatch({ name: value })}
                              />
                              <span style={ms.hint}>{t(locale, "hintProviderKey")}</span>
                            </div>
                            <div style={ms.field}>
                              <span style={ms.fieldLabel}>{t(locale, "labelBaseUrl")}</span>
                              <MsText
                                ariaLabel={t(locale, "ariaBaseUrl")}
                                value={card.baseURL}
                                disabled={saving}
                                onChange={(value) => cardPatch({ baseURL: value })}
                              />
                            </div>
                            <div style={ms.field}>
                              <span style={ms.fieldLabel}>
                                {t(locale, "labelApiKeyEnv")}
                                <span style={ms.hint}>{t(locale, "hintApiKeyOptional")}</span>
                              </span>
                              <MsText
                                ariaLabel={t(locale, "ariaApiKeyEnv")}
                                placeholder={t(locale, "phApiKeyEnv")}
                                value={card.apiKeyEnv}
                                disabled={saving}
                                onChange={(value) => cardPatch({ apiKeyEnv: value })}
                              />
                            </div>
                            {/* The card's MODEL LIST (the
                                fetched catalog, silent on expand): header
                                + count hint, loading / error + retry, the
                                entry rows ([name][id combobox][>][−])
                                + the dashed "Add model" slot, all part of
                                the card draft (single commit). */}
                            <div style={ms.modelsArea}>
                              <div style={ms.modelsHead}>
                                <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                                  <span style={ms.modelsTitle}>{t(locale, "labelModels")}</span>
                                  <span style={ms.modelsMeta}>{cardCountHint}</span>
                                </span>
                              </div>
                              {cardCatalog === null || cardCatalog.status === "loading" ? (
                                <p style={ms.hint}>{t(locale, "fetchingCatalog")}</p>
                              ) : null}
                              {cardCatalog !== null && cardCatalog.status === "error" ? (
                                <p style={ms.error}>
                                  {t(locale, "catalogFetchError")}{" "}
                                  <button
                                    type="button"
                                    style={ms.retry}
                                    onClick={() => fetchCatalog(route.name, route.apiKeyEnv)}
                                  >
                                    {t(locale, "retry")}
                                  </button>
                                </p>
                              ) : null}
                              {(cardCatalog === null || cardCatalog.status !== "loading") &&
                              cardRows.length > 0 ? (
                                <ul style={ms.modelList}>
                                  {cardRows.map((row, index) => {
                                    const rowName = row.name;
                                    // The row's STABLE slot key (the fallback
                                    // only fires if the rowKeys invariant is
                                    // ever violated — a warning, not a crash).
                                    const rowKey =
                                      cardRowKeys[index] ?? (rowName !== "" ? rowName : `new-${index}`);
                                    const detailOpen = cardDetailId === rowKey;
                                    const resetPending = card.pendingReset.includes(rowKey);
                                    // The row's COMMITTED tier-1
                                    // configuration (the detail's dirty
                                    // baseline + merge base + preserved
                                    // line — never the draft, never the
                                    // discovery).
                                    const committed = committedSourceOf(card, route, row);
                                    // The "preserved from settings.yaml"
                                    // line source — the committed entry
                                    // MINUS the identity fields (name / id /
                                    // defaultEffort are not "deep template
                                    // fields" — an explicit entry's `name`
                                    // is the harness identity; a map entry's
                                    // is cosmetic and phantom-stripped at
                                    // read); an identity-only committed
                                    // entry preserves nothing.
                                    const effective =
                                      committed !== null
                                        ? Object.fromEntries(
                                            Object.entries(committed).filter(
                                              ([key]) =>
                                                key !== "id" && key !== "defaultEffort" && key !== "name",
                                            ),
                                          )
                                        : null;
                                    return (
                                      <ModelRow
                                        key={rowKey}
                                        locale={locale}
                                        entry={row}
                                        detailOpen={detailOpen}
                                        saving={saving}
                                        resetPending={resetPending}
                                        nameInCollision={cardNameCollision !== null && cardNameCollision === rowName}
                                        catalogReady={cardCatalogReady && cardCatalog !== null}
                                        options={cardCatalogReady && cardCatalog !== null ? cardCatalog.models : []}
                                        configDraft={card.configDrafts[rowKey]}
                                        baseline={effectiveBaselineOf(route.name, row.id, committed)}
                                        effective={effective}
                                        defaultEffort={typeof row.defaultEffort === "string" ? row.defaultEffort : ""}
                                        onName={(name) => cardModelNamePatch(rowKey, name)}
                                        onId={(id) => cardModelIdPatch(rowKey, id)}
                                        onDefaultEffort={(value) => cardModelEffortPatch(rowKey, value)}
                                        onRemove={() => cardRemoveModel(rowKey)}
                                        onToggleDetail={() => cardToggleDetail(rowKey)}
                                        onConfigPatch={(patch) => cardModelConfigPatch(rowKey, patch)}
                                        onReasoning={(on) => cardReasoningToggle(rowKey, on)}
                                        onTl={(index2, field, value) => cardModelTl(rowKey, index2, field, value)}
                                        onTlAdd={() => cardModelTlAdd(rowKey)}
                                        onTlRemove={(index2) => cardModelTlRemove(rowKey, index2)}
                                        onReset={() => cardResetModel(rowKey)}
                                      />
                                    );
                                  })}
                                </ul>
                              ) : null}
                              {/* The dashed Add-model slot (bottom):
                                  appends an empty row (the pure
                                  addModelEntry — presence in the list IS
                                  the served state). */}
                              <MsButton variant="add" disabled={saving} onClick={cardAddModel}>
                                {t(locale, "addModel")}
                              </MsButton>
                            </div>
                            {/* The name-collision error line + the
                                one-click fix. Apply stays disabled until the
                                names are unique; the button renames the LATER
                                occurrences (the first keeps the name) — the
                                slots (rowKeys) are untouched, so no row
                                remounts. */}
                            {cardCollisionFix !== null && cardFirstRename !== undefined ? (
                              <p style={ms.error}>
                                {t(locale, "nameCollisionHint", { name: cardFirstRename.from })}{" "}
                                <button
                                  type="button"
                                  style={ms.retry}
                                  onClick={cardFixNameCollision}
                                >
                                  {t(locale, "nameCollisionFix", { suggested: cardFirstRename.to })}
                                </button>
                              </p>
                            ) : null}
                            {formError !== null && <p style={ms.error}>{formError}</p>}
                            <div style={ms.editorActions}>
                              <MsButton
                                variant="secondary"
                                disabled={saving || !cardIsDirty}
                                onClick={cancelCard}
                              >
                                {t(locale, "cancel")}
                              </MsButton>
                              <MsButton
                                variant="primary"
                                ariaLabel={t(locale, "ariaApplyProvider")}
                                disabled={saving || !cardIsDirty || cardNameCollision !== null}
                                onClick={() => {
                                  void saveCard();
                                }}
                              >
                                {saving ? t(locale, "saving") : t(locale, "apply")}
                              </MsButton>
                            </div>
                          </div>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
                {/* Orphaned-override cleanup: the legacy top-level
                    `overrides` block (pure classification: curation.ts
                    `classifyTopOverrides`). */}
                {Object.keys(topMap).length > 0 ? (
                  <section
                    aria-labelledby="modelspoke-top-overrides"
                    style={{ display: "flex", flexDirection: "column", gap: 8 }}
                  >
                    <div style={ms.topHead}>
                      <h3 id="modelspoke-top-overrides" style={ms.topTitle}>
                        {t(locale, "topOverridesHeading")}
                      </h3>
                      <span style={ms.hint}>{t(locale, "topOverridesHint")}</span>
                    </div>
                    <ul style={ms.modelList}>
                      {classifyTopOverrides(
                        topMap,
                        routes.map((r) => ({
                          name: r.name,
                          // Claim mapping: a route carries its own
                          // entry for a wire id via its per-wire-id map
                          // (FULL_CATALOG) or by SERVING the id in its
                          // explicit entry list (the fold would merge a
                          // top-level entry into that route's entry).
                          overrides:
                            r.models !== null
                              ? Object.fromEntries(r.models.map((e) => [e.id, {} as unknown]))
                              : r.legacyOverrides,
                        })),
                      ).map((row) => {
                        const summary = [
                          ...(row.displayName !== null ? [row.displayName] : []),
                          ...(row.fields.length > 0 ? [row.fields.join(" · ")] : []),
                        ].join(" · ");
                        const claimed = row.claiming.length > 0;
                        return (
                          <li key={row.id} style={ms.topRow}>
                            <code style={ms.modelRowId}>{row.id}</code>
                            {summary !== "" ? <span style={ms.topSummary}>{summary}</span> : null}
                            {claimed ? (
                              <span style={ms.topSummary}>
                                {t(locale, "topOverrideShadowed", {
                                  names: row.claiming.join(locale === "zh" ? "、" : ", "),
                                })}
                              </span>
                            ) : (
                              <MsButton
                                dense
                                variant="danger"
                                ariaLabel={t(locale, "ariaDeleteTopOverride", { id: row.id })}
                                disabled={saving}
                                onClick={() => deleteTopOverride(row.id)}
                              >
                                {t(locale, "delete")}
                              </MsButton>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                ) : null}
                {/* The dashed add slot (the reference's .addButton
                    geometry) opens the EXISTING add form — same fields and
                    save/cancel semantics (no committed state to
                    dirty-track against, so it keeps its own Save). */}
                <div style={ms.addActions}>
                  <MsButton
                    variant="add"
                    disabled={saving || surfaceOpen}
                    onClick={openAdd}
                  >
                    {t(locale, "addProvider")}
                  </MsButton>
                </div>
                {draft !== null ? (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      submitProvider();
                    }}
                    style={ms.editor}
                  >
                    <div style={ms.editorHeader}>
                      <span style={ms.editorTitle}>{t(locale, "addProviderTitle")}</span>
                    </div>
                    <div style={ms.field}>
                      <span style={ms.fieldLabel}>{t(locale, "labelName")}</span>
                      <MsText
                        ariaLabel={t(locale, "ariaProviderName")}
                        value={draft.name}
                        disabled={saving}
                        onChange={(value) => draftPatch({ name: value })}
                      />
                    </div>
                    <div style={ms.field}>
                      <span style={ms.fieldLabel}>{t(locale, "labelBaseUrl")}</span>
                      <MsText
                        ariaLabel={t(locale, "ariaBaseUrl")}
                        value={draft.baseURL}
                        disabled={saving}
                        onChange={(value) => draftPatch({ baseURL: value })}
                      />
                    </div>
                    <div style={ms.field}>
                      <span style={ms.fieldLabel}>
                        {t(locale, "labelApiKeyEnv")}
                        <span style={ms.hint}>{t(locale, "hintApiKeyOptional")}</span>
                      </span>
                      <MsText
                        ariaLabel={t(locale, "ariaApiKeyEnv")}
                        placeholder={t(locale, "phApiKeyEnv")}
                        value={draft.apiKeyEnv}
                        disabled={saving}
                        onChange={(value) => draftPatch({ apiKeyEnv: value })}
                      />
                    </div>
                    {formError !== null && <p style={ms.error}>{formError}</p>}
                    <div style={ms.editorActions}>
                      <MsButton
                        variant="secondary"
                        disabled={saving}
                        onClick={() => {
                          setDraft(null);
                          setFormError(null);
                        }}
                      >
                        {t(locale, "cancel")}
                      </MsButton>
                      <MsButton
                        variant="primary"
                        disabled={saving}
                        onClick={submitProvider}
                      >
                        {saving ? t(locale, "saving") : t(locale, "next")}
                      </MsButton>
                    </div>
                  </form>
                ) : null}
              </>
            );
          })()}
      </div>
    );
  };

  ctx.slots.inject("settings.section", () =>
    ctx.slots.register({
      name: "settings.section",
      id: "modelspoke",
      order: 20,
      label: () => "modelspoke",
    }, ModelspokeSection),
  );

  // The first-run step in the shell's ordered `settings.onboarding` chain
  // (contract: ui-settings slots.ts 'settings.onboarding' — the shell mounts
  // exactly one step at a time and hands the active registrant
  // `{ stepId, complete, openSection }`). After the shipped steps
  // (welcome-notice order -100, deepseek-official order 0) this step takes
  // order 100. It probes the node half's `/modelspoke` channel
  // (`onboarding`) and layers its offers, FIRST MATCH WINS:
  //   1. `ready` (≥1 route) → complete silently (the section page is
  //      already usable);
  //   2. ≥1 local `llm-pi-ai` provider (the onboarding-v2 offer —
  //      "don't make me retype the URL") → a pick list when several
  //      candidates, a direct form for one: name (default
  //      `modelspoke-<source provider name>`, editable) + baseURL
  //      (prefilled, editable) + the key note, and a live NON-BLOCKING
  //      collision warning while the name sits in the registrable set
  //      (server backstop: `provision` reports `shadowing` in the
  //      response);
  //   3. nothing else → complete silently (the section's Add-route form
  //      stays the manual path).
  // Any other readiness — channel error, unreachable (off-loopback
  // browser, non-web profile) — completes the step silently so the chain
  // is never stranded. Success views hand off with
  // `openSection("modelspoke")`. The step owns its modal chrome + `#root`
  // inert while visible (slot contract) and adds NO runtime requires
  // beyond react/jsx-runtime (the calls ride the injected `connection`
  // service; the pure helpers come from ./import.js, inlined by tsdown).
  type OfferedProvider = {
    name: string;
    baseURL: string;
    keySource:
      | { kind: "env"; envVar: string }
      | { kind: "stored" }
      | { kind: "none" };
  };
  type StepPhase =
    | { kind: "checking" }
    | {
        kind: "offer-provider";
        /** null = the pick list is showing (several candidates). */
        source: OfferedProvider | null;
        name: string;
        baseURL: string;
        importing: boolean;
        error: string | null;
      }
    | { kind: "done-provider"; routeName: string; sourceName: string; shadowing: string | null };

  /** The form's key note: per the candidate's `keySource` — env → the
   *  name maps 1:1 to the route's `apiKeyEnv`; stored → the value sits in a
   *  layer the route cannot read (modelspoke reads `process.env` only), so
   *  the import omits `apiKeyEnv` and says so; none → no note. */
  const KeyNote = ({ source, locale }: { source: OfferedProvider; locale: LocaleId }) => {
    if (source.keySource.kind === "env") {
      return (
        <p style={stepStyle.hint}>
          {t(locale, "obKeyEnvStart")}{" "}
          <code>{source.keySource.envVar}</code>{" "}
          {t(locale, "obKeyEnvMid")}{" "}
          <code>apiKeyEnv</code>
          {t(locale, "obKeyEnvEnd")}
        </p>
      );
    }
    if (source.keySource.kind === "stored") {
      return (
        <p style={stepStyle.hint}>
          {t(locale, "obKeyStoredStart")}{" "}
          <code>apiKeyEnv</code>{" "}
          {t(locale, "obKeyStoredEnd")}
        </p>
      );
    }
    return null;
  };

  /** The collision warning: the same text in the live form (inline,
   *  non-blocking) and the success view (the server-reported `shadowing`). */
  const CollisionWarning = ({ colliding, locale }: { colliding: string; locale: LocaleId }) => (
    <p style={stepStyle.warning} role="alert">
      {t(locale, "obCollisionStart")}{" "}
      <code>{colliding}</code>{" "}
      {t(locale, "obCollisionEnd")}
    </p>
  );

  const ModelspokeOnboardingStep = (owner: {
    stepId: string;
    complete: () => void;
    openSection: (id: string) => void;
  }) => {
    const [step, setStep] = useState<StepPhase>({ kind: "checking" });
    // i18n — the live locale (preference → browser; live via subscribe).
    const locale = useModelspokeLocale();
    // The probe-time offer set: the candidates the pick list renders
    // and the registrable names the live collision warning checks.
    const [providerOffers, setProviderOffers] = useState<OfferedProvider[]>([]);
    const [providerNames, setProviderNames] = useState<string[]>([]);
    // The step completes itself EXACTLY once (the shell tracks completion by
    // id; a double complete() is harmless but the guard keeps the intent).
    const finished = useRef(false);
    const finish = (): void => {
      if (finished.current) return;
      finished.current = true;
      owner.complete();
    };

    // Readiness probe on mount: the channel answers with the node half's
    // current facts (src/dsh/channel.ts `onboarding`) and the offers are
    // layered per the module note above. A result the step does not render
    // for completes the chain immediately (the DeepSeek step's
    // `complete()`-on-unready precedent).
    useEffect(() => {
      let cancelled = false;
      connection
        .rpc.call("/modelspoke", "onboarding", {})
        .then((result) => {
          if (cancelled) return;
          if (result.ok !== true) {
            finish();
            return;
          }
          const facts = result.value as
            | {
                ready?: boolean;
                providers?: OfferedProvider[];
                providerNames?: string[];
              }
            | undefined;
          if (facts === undefined || facts.ready === true) {
            finish();
            return;
          }
          // Layer 3 — the custom-provider offer (the server already
          // filtered to local candidates).
          const providers = Array.isArray(facts.providers) ? facts.providers : [];
          const names = Array.isArray(facts.providerNames) ? facts.providerNames : [];
          if (providers.length === 0) {
            finish();
            return;
          }
          setProviderOffers(providers);
          setProviderNames(names);
          const single = providers.length === 1 ? providers[0] : undefined;
          if (single !== undefined) {
            setStep({
              kind: "offer-provider",
              source: single,
              name: defaultImportRouteName(single.name),
              baseURL: single.baseURL,
              importing: false,
              error: null,
            });
          } else {
            setStep({
              kind: "offer-provider",
              source: null,
              name: "",
              baseURL: "",
              importing: false,
              error: null,
            });
          }
        })
        .catch(() => {
          if (!cancelled) finish();
        });
      return () => {
        cancelled = true;
      };
    }, []);

    // The contract: the step owns its modal chrome AND `#root` inert — but
    // only while VISIBLE. While the readiness probe is in flight (the
    // "checking" phase) the step renders null and must block nothing, so
    // the inert is gated on visibility, not on being the active step.
    const visible = step.kind !== "checking";
    useEffect(() => {
      if (!visible) return;
      const appRoot = document.getElementById("root");
      if (appRoot === null) return;
      const previous = appRoot.inert;
      appRoot.inert = true;
      return () => {
        appRoot.inert = previous;
      };
    }, [visible]);

    if (!visible) return null;

    const pick = (source: OfferedProvider): void => {
      setStep({
        kind: "offer-provider",
        source,
        name: defaultImportRouteName(source.name),
        baseURL: source.baseURL,
        importing: false,
        error: null,
      });
    };

    const patchForm = (patch: { name?: string; baseURL?: string }): void => {
      setStep((s) =>
        s.kind === "offer-provider" && s.source !== null ? { ...s, ...patch, error: null } : s,
      );
    };

    const runProvision = async (): Promise<void> => {
      if (step.kind !== "offer-provider" || step.source === null) return;
      const name = step.name.trim();
      const baseURL = step.baseURL.trim();
      const source = step.source;
      if (name.length === 0) {
        setStep({ ...step, error: t(locale, "errProviderNameRequired") });
        return;
      }
      if (name.includes("/")) {
        setStep({ ...step, error: t(locale, "errProviderNameSlash") });
        return;
      }
      if (baseURL.length === 0) {
        setStep({ ...step, error: t(locale, "errBaseUrlRequired") });
        return;
      }
      setStep({ ...step, importing: true, error: null });
      try {
        // The key mapping: an env-sourced candidate carries its env-var
        // name as the route's `apiKeyEnv`; stored/none candidates import
        // WITHOUT it (the value is never copied — the note says how to set
        // auth manually when the server needs it).
        const payload: Record<string, string> = { name, baseURL };
        if (source.keySource.kind === "env") payload.apiKeyEnv = source.keySource.envVar;
        const result = await connection.rpc.call("/modelspoke", "provision", payload);
        if (result.ok !== true) {
          const message =
            result.ok === false ? result.error.message : t(locale, "importRequestFailed");
          setStep((s) => (s.kind === "offer-provider" ? { ...s, importing: false, error: message } : s));
          return;
        }
        const value = result.value as { shadowing?: string } | undefined;
        setStep({
          kind: "done-provider",
          routeName: name,
          sourceName: source.name,
          shadowing: value?.shadowing ?? null,
        });
      } catch (error) {
        setStep((s) =>
          s.kind === "offer-provider"
            ? { ...s, importing: false, error: error instanceof Error ? error.message : String(error) }
            : s,
        );
      }
    };

    const handoff = (): void => {
      owner.openSection("modelspoke");
      finish();
    };

    // The live collision warning (non-blocking): the name as typed
    // (trimmed) against the registrable set — the probe-time
    // `providerNames` (pi-ai keys ∪ route names ∪ built-ins, server-
    // computed) unioned with the CURRENT route names from the live
    // snapshot (a route added in another tab after the probe still warns).
    const routeNames = routesOf(scope.getSnapshot().value).map((r) => r.name);
    const collision =
      step.kind === "offer-provider" && step.source !== null
        ? providerCollision(step.name, providerNames, routeNames)
        : null;

    // Portaled to document.body (the dsh core OnboardingModal's contract):
    // the step makes #root inert while visible, so a dialog rendered inside
    // #root would be inert itself — its buttons unclickable and its inputs
    // unfocusable. Outside the inert root the mask keeps the app blocked
    // while the card stays interactive.
    return createPortal(
      <div style={stepStyle.overlay}>
        <div style={stepStyle.mask} aria-hidden="true" />
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="modelspoke-onboarding-title"
          style={stepStyle.card}
        >
          <h2 id="modelspoke-onboarding-title" style={stepStyle.title}>
            {t(locale, "obTitle")}
          </h2>
           {step.kind === "offer-provider" ? (
            step.source === null ? (
              // The pick list (several local providers): name + baseURL per
              // row, then the form for the chosen one.
              <>
                <p>
                  {t(locale, "obFoundProviders", { count: providerOffers.length })}
                </p>
                <ul style={{ margin: "8px 0", paddingLeft: 20 }}>
                  {providerOffers.map((p) => (
                    <li key={p.name} style={stepStyle.row}>
                      <span>
                        <strong>{p.name}</strong> — <code>{p.baseURL}</code>
                      </span>
                      <button disabled={step.importing} onClick={() => pick(p)}>
                        {t(locale, "select")}
                      </button>
                    </li>
                  ))}
                </ul>
                {step.error !== null && (
                  <p style={stepStyle.error} role="alert">
                    {step.error}
                  </p>
                )}
                <div style={stepStyle.actions}>
                  <button disabled={step.importing} onClick={finish} style={stepStyle.secondary}>
                    {t(locale, "setUpLater")}
                  </button>
                </div>
              </>
            ) : (
              // The import form (single candidate, or the picked one).
              <>
                {providerOffers.length === 1 ? (
                  <p>{t(locale, "obFoundSingle")}</p>
                ) : (
                  <p>
                    {t(locale, "obImportProviderStart")}{" "}
                    <code>{step.source.name}</code>{" "}
                    {t(locale, "obImportProviderEnd")}
                  </p>
                )}
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void runProvision();
                  }}
                  style={{ marginTop: 4 }}
                >
                  <label style={stepStyle.field}>
                    {t(locale, "labelName")}
                    <br />
                    <input
                      value={step.name}
                      disabled={step.importing}
                      onChange={(e) => patchForm({ name: e.target.value })}
                    />
                  </label>
                  <label style={stepStyle.field}>
                    {t(locale, "labelBaseUrl")}
                    <br />
                    <input
                      value={step.baseURL}
                      disabled={step.importing}
                      onChange={(e) => patchForm({ baseURL: e.target.value })}
                    />
                  </label>
                  <KeyNote source={step.source} locale={locale} />
                  {collision !== null && <CollisionWarning colliding={collision} locale={locale} />}
                  {step.error !== null && (
                    <p style={stepStyle.error} role="alert">
                      {step.error}
                    </p>
                  )}
                  <div style={stepStyle.actions}>
                    <button type="submit" disabled={step.importing}>
                      {step.importing ? t(locale, "importing") : t(locale, "import")}
                    </button>
                    <button
                      type="button"
                      disabled={step.importing}
                      onClick={finish}
                      style={stepStyle.secondary}
                    >
                      {t(locale, "setUpLater")}
                    </button>
                  </div>
                </form>
              </>
            )
          ) : (
            // done-provider: the success view.
            <>
              <p>
                {t(locale, "obDoneProviderStart")}{" "}
                <code>{step.sourceName}</code>{" "}
                {t(locale, "obDoneProviderMid")}{" "}
                <code>{step.routeName}</code>
                {t(locale, "obDoneProviderEnd")}
              </p>
              {step.shadowing !== null && <CollisionWarning colliding={step.shadowing} locale={locale} />}
              <p style={stepStyle.hint}>{t(locale, "obDoneProviderHint")}</p>
              <div style={stepStyle.actions}>
                <button onClick={handoff}>{t(locale, "openModelspoke")}</button>
                <button onClick={finish} style={stepStyle.secondary}>
                  {t(locale, "done")}
                </button>
              </div>
            </>
          )}
        </div>
      </div>,
      document.body,
    );
  };

  ctx.slots.inject("settings.onboarding", () =>
    ctx.slots.register({
      name: "settings.onboarding",
      id: "modelspoke-import",
      order: 100,
    }, ModelspokeOnboardingStep),
  );

  // tool view
  //
  // The host renders every tool call through the keyed `tool.call.toolview`
  // slot; an UNCLAIMED key (read_image is absent from the host's TOOL_VARIANTS
  // table, ui-tool tool-call-model.ts:38-60) falls back to the generic card,
  // which `JSON.stringify`s every non-text content block
  // (ui-tool tool-call-model.ts:108-118) — so read_image's image block renders
  // as a JSON blob. This view claims the `read_image` key (gated by the
  // `renderReadImages` section flag, default ON) and renders the settled
  // result's image refs as bounded <img>s alongside the envelope text.
  //
  // Gating is a REGISTRATION gate (owner rule): `renderReadImages: false`
  // deregisters the keyed entry so the host's own row owns the call — no
  // double render, no dead view shadowing an upstream fix. The entry is
  // established inside the slot declaration's lifetime (slots.inject) and
  // re-synced live on every settings snapshot change (the shared describe
  // mirror reloads on settings/document-updated, so an out-of-band settings.yaml
  // edit deregisters/registers without a page reload). `slots.register` returns
  // an idempotent disposer — the deregistration mechanism (ui-slots store.ts).
  const sessions = ctx.sessions as ISessions | undefined;

  const readImageStyle: Record<string, CSSProperties> = {
    row: { margin: "2px 0", fontSize: 13, lineHeight: 1.4 },
    header: { display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" },
    title: { fontWeight: 600 },
    path: { fontSize: 12, opacity: 0.8, wordBreak: "break-all" },
    running: { fontSize: 12, opacity: 0.6, fontStyle: "italic" },
    envelope: {
      margin: "6px 0",
      padding: "6px 8px",
      fontSize: 12,
      whiteSpace: "pre-wrap",
      wordBreak: "break-word",
      background: "rgba(127,127,127,0.1)",
      borderRadius: 6,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    },
    imageList: { display: "flex", flexWrap: "wrap", gap: 10, margin: "6px 0" },
    figure: { margin: 0 },
    // The host's ≤240px rule is a MESSAGE-side thumbnail (an image beside
    // message text). A tool-result image IS the row's subject, so it fits the
    // row's available width instead of a fixed thumbnail box: standard
    // replaced-element behavior — natural size when small (width/height auto,
    // never upscaled), fills the column for large images (max-width 100%), and
    // a 600px height cap for very tall ones. Aspect kept (object-fit contain —
    // a tool result has no crop-to-fit intent).
    img: {
      display: "block",
      maxWidth: "100%",
      maxHeight: 600,
      width: "auto",
      height: "auto",
      objectFit: "contain",
      borderRadius: 6,
    },
    caption: { fontSize: 11, opacity: 0.7, marginTop: 2 },
    imageStatus: { fontSize: 12, opacity: 0.7, fontStyle: "italic" },
  };

  /** The settled (or running) call's file path from its JSON arguments. */
  const readImagePath = (block: ToolCallBlock): string | undefined => {
    const argsRaw = "kind" in block ? block.call?.argsRaw ?? undefined : block.argsRaw;
    if (typeof argsRaw !== "string" || argsRaw === "") return undefined;
    try {
      const parsed = JSON.parse(argsRaw) as Record<string, unknown>;
      const p = parsed.file_path ?? parsed.path;
      return typeof p === "string" && p !== "" ? p : undefined;
    } catch {
      return undefined;
    }
  };

  /** One content-addressed image ref, loaded through the session service. */
  const ReadImageFigure = ({ image, sessionId }: { image: ReadImageAttachmentRef; sessionId: SessionId }) => {
    const [url, setUrl] = useState<string | null>(null);
    const [failed, setFailed] = useState(false);
    useEffect(() => {
      let live = true;
      let objectUrl: string | null = null;
      setUrl(null);
      setFailed(false);
      const load = async (): Promise<void> => {
        let session: ISession | undefined;
        try {
          session = sessions?.binding(sessionId)?.session;
        } catch {
          session = undefined;
        }
        if (session === undefined) {
          if (live) setFailed(true);
          return;
        }
        try {
          const result = await session.readAttachment(
            image.attachmentId as Parameters<ISession["readAttachment"]>[0],
          );
          if (!live) return;
          if (result.ok !== true) {
            setFailed(true);
            return;
          }
          const bytes = result.value.data;
          const buffer = new ArrayBuffer(bytes.byteLength);
          new Uint8Array(buffer).set(bytes);
          objectUrl = URL.createObjectURL(
            new Blob([buffer], { type: image.mediaType ?? "image/png" }),
          );
          setUrl(objectUrl);
        } catch {
          if (live) setFailed(true);
        }
      };
      void load();
      return () => {
        live = false;
        if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
      };
    }, [image.attachmentId, sessionId]);
    const caption = imageCaption(image);
    if (failed) {
      return (
        <div style={readImageStyle.imageStatus}>
          {caption} — image unavailable (the envelope text above carries the metadata)
        </div>
      );
    }
    if (url === null) {
      return <div style={readImageStyle.imageStatus}>{caption} — loading…</div>;
    }
    return (
      <figure style={readImageStyle.figure}>
        <img src={url} alt={caption} style={readImageStyle.img} />
        <figcaption style={readImageStyle.caption}>{caption}</figcaption>
      </figure>
    );
  };

  /** The claimed read_image row: standard row look + envelope + images. */
  const ReadImageView = ({ block, sessionId }: { block: ToolCallBlock; sessionId: SessionId }) => {
    const settled = "kind" in block ? (block as ToolResultNode) : null;
    const content = settled?.content ?? [];
    const images = imageAttachmentRefs(content);
    const envelope = settled === null ? "" : textBlocksOf(content);
    const path = readImagePath(block);
    const running = settled === null;
    return (
      <div style={readImageStyle.row} data-modelspoke-read-image="row">
        <div style={readImageStyle.header}>
          <span style={readImageStyle.title}>read_image</span>
          {path !== undefined ? <code style={readImageStyle.path}>{path}</code> : null}
          {running ? <span style={readImageStyle.running}>reading…</span> : null}
        </div>
        {envelope !== "" ? <pre style={readImageStyle.envelope}>{envelope}</pre> : null}
        {images.length > 0 ? (
          <div style={readImageStyle.imageList}>
            {images.map((image, index) => (
              <ReadImageFigure
                key={`${image.attachmentId}:${index}`}
                image={image}
                sessionId={sessionId}
              />
            ))}
          </div>
        ) : null}
      </div>
    );
  };

  ctx.slots.inject("tool.call.toolview", () => {
    let disposeEntry: (() => void) | null = null;
    const sync = (): void => {
      const want = shouldRegisterReadImageView(scope.getSnapshot().value);
      if (want && disposeEntry === null) {
        disposeEntry = ctx.slots.register(
          { name: "tool.call.toolview", key: "read_image", registrant: "modelspoke" },
          ReadImageView,
        );
      } else if (!want && disposeEntry !== null) {
        disposeEntry();
        disposeEntry = null;
      }
    };
    const unsubscribe = scope.subscribe(sync);
    sync();
    return () => {
      unsubscribe();
      if (disposeEntry !== null) {
        disposeEntry();
        disposeEntry = null;
      }
    };
  });
}
