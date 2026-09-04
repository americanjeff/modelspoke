/**
 * The vLLM catalog-only tier-2 discovery backend
 * (the cheapest of the four: zero probes, zero per-model calls).
 *
 * WHY: a vLLM server's `/v1/models` is ALMOST bare — each ModelCard entry
 * carries the two context-bearing signatures `owned_by: "vllm"` and
 * `max_model_len` (docs/provider-details.md §3.4; the `permission[]` array
 * is a third, redundant marker) — but no capability surface beyond it:
 * `reasoning_effort` is a static request literal that no endpoint
 * enumerates into levels, and there is no vision field. So this backend
 * NEVER fetches: detection is a
 * PURE function of the already-fetched catalog entries (C10's free tier) and
 * enrichment reads the same entries — zero probes, zero per-model calls.
 *
 * Shape (the Ollama-discovery discipline): pure seams + the {@link vllmBackend} wrapper on
 * the shared contract (src/discovery/backends.ts); imports NOTHING from the
 * channel. `detect` always resolves a DEFINITIVE verdict — with no probe
 * there is no network failure to be inconclusive about, so the channel's
 * memo simply pins the verdict for the handler's lifetime. `metadataRows`
 * puts the FULL canonical object per enriched id — exactly
 * `{ contextWindow }`, nothing else (C5) — and leaves an entry whose
 * `max_model_len` is absent or not a positive integer ABSENT from `byId`, so
 * the channel keeps that id's generic row untouched (C4). The field is the
 * the `extractFromEntry` position-4 `includeMaxModelLen` slot's input — no
 * caller enables that slot today (the oracle-frozen default path stays off);
 * this backend is its first consumer and emits what the slot would have,
 * without touching `metadata.ts`.
 *
 * OUT OF SCOPE (locked, §6.4): `/tokenizer_info` — the jinja chat template
 * is preset-authoring territory (a future plan; shipping it here is a
 * different feature); `/server_info` — dev-gated behind
 * `VLLM_SERVER_DEV_MODE`, never a dependency. Fail-soft discipline (C6):
 * nothing here can throw — both methods are pure computations over the
 * entries, and a malformed catalog element degrades to "no signal" /
 * "absent from byId" (the generic row), never an error.
 */

import type { CanonicalModelFields } from "../types.js";
import type {
  BackendRows,
  BackendVerdict,
  DiscoveryBackend,
  DiscoveryContext,
} from "./backends.js";
import { toPositiveInt } from "./metadata.js";
import type { OpenAIModelEntry } from "./types.js";

/**
 * Fail-soft entry narrowing (C6): `/v1/models` entries are untrusted wire
 * data — a malformed element (`null`, a bare string, a number) degrades to
 * "no entry" instead of throwing into the channel.
 */
function asEntry(value: unknown): OpenAIModelEntry | undefined {
  return typeof value === "object" && value !== null ? (value as OpenAIModelEntry) : undefined;
}

/**
 * The vLLM ModelCard signatures (§6.1), per entry: `owned_by === "vllm"` OR
 * `max_model_len` present. The locked rule is spelled `max_model_len !==
 * undefined` — there is no shape gate beyond the two signatures (an entry
 * whose `max_model_len` is `null` still matches; only ENRICHMENT applies the
 * positive-integer gate). Either signature alone suffices.
 */
export function vllmEntryMatches(entry: unknown): boolean {
  const card = asEntry(entry);
  if (card === undefined) return false;
  return card.owned_by === "vllm" || card.max_model_len !== undefined;
}

/**
 * Pure detection over the already-fetched catalog (§6.1): match when ANY
 * entry carries a vLLM ModelCard signature. ZERO fetches, never throws, and
 * the verdict is always DEFINITIVE — "no signature seen" is a well-formed
 * non-match, not an inconclusive.
 */
export function vllmDetect(entries: readonly OpenAIModelEntry[]): boolean {
  return entries.some((entry) => vllmEntryMatches(entry));
}

/**
 * Pure enrichment seam (§6.2): the `byId` map the channel consumes (C4) —
 * per entry, `max_model_len` → `contextWindow` through
 * `toPositiveInt` (positive integers and all-digit strings; anything else —
 * 0, negatives, floats, non-numeric — degrades to ABSENT). That single field
 * is the ENTIRE canonical object (C5: vLLM publishes no reasoning/vision
 * surface, so never `reasoning`/`input`/`thinkingLevelMap`/`compat`/
 * `maxTokens`); an entry without a positive `max_model_len` is absent from
 * the map and keeps its generic row. Zero fetches; never throws; order
 * irrelevant (a map).
 */
export function vllmMetadataRows(
  entries: readonly OpenAIModelEntry[],
): Map<string, CanonicalModelFields | undefined> {
  const byId = new Map<string, CanonicalModelFields | undefined>();
  for (const raw of entries) {
    const entry = asEntry(raw);
    if (entry === undefined) continue;
    const contextWindow = toPositiveInt(entry.max_model_len);
    if (contextWindow !== undefined) byId.set(entry.id, { contextWindow });
  }
  return byId;
}

/**
 * The vLLM backend (registry order: fourth in C9's locked
 * `[sglang, ollama, lmstudio, vllm, llamacpp]`). Catalog-only: `detect`
 * never fetches and is never inconclusive; `metadataRows` never fetches.
 * The route's apiKey (C7) is moot — there is nothing to authenticate.
 */
export const vllmBackend: DiscoveryBackend = {
  id: "vllm",
  detect(ctx: DiscoveryContext): Promise<BackendVerdict> {
    // §6.1 — a pure function of the already-fetched entries: no probe exists
    // in this backend, so every verdict is DEFINITIVE (never `inconclusive`,
    // no `facts` to carry — enrichment reads the entries themselves).
    return Promise.resolve({ match: vllmDetect(ctx.entries) });
  },
  async metadataRows(
    entries: readonly OpenAIModelEntry[],
    _ctx: DiscoveryContext,
    _facts: Record<string, unknown> | undefined,
  ): Promise<BackendRows> {
    // §6.2 — ZERO fetches: `max_model_len` → `contextWindow`, and that is
    // the entire enrichment (C5). Entries without a positive
    // `max_model_len` stay ABSENT from `byId` — the channel keeps their
    // generic row (C4). No `notes` (nothing to report).
    return { byId: vllmMetadataRows(entries) };
  },
};