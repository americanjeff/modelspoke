import { afterEach, describe, expect, it, vi } from "vitest";
import { makeChannelHandler } from "../src/dsh/channel.js";
import { toPositiveInt } from "../src/discovery/metadata.js";
import type { OpenAIModelEntry } from "../src/discovery/types.js";
import {
  vllmBackend,
  vllmDetect,
  vllmEntryMatches,
  vllmMetadataRows,
} from "../src/discovery/vllm.js";
import { assertExpect, fixtureOf, vectorOf } from "./discovery-corpus.js";

const VLLM_QWEN3 = fixtureOf<OpenAIModelEntry>("vllm", "VLLM_QWEN3");
const VLLM_OWNED_BY_ONLY = fixtureOf<OpenAIModelEntry>("vllm", "VLLM_OWNED_BY_ONLY");
const VLLM_MAX_MODEL_LEN_ONLY = fixtureOf<OpenAIModelEntry>("vllm", "VLLM_MAX_MODEL_LEN_ONLY");
const LLAMA_SWAP_CATALOG = fixtureOf<OpenAIModelEntry[]>("vllm", "LLAMA_SWAP_CATALOG");
const BARE_OPENAI_CATALOG = fixtureOf<OpenAIModelEntry[]>("vllm", "BARE_OPENAI_CATALOG");

describe("vllmEntryMatches (per-entry signatures)", () => {
  const run = (id: string) => {
    const v = vectorOf("vllm", id);
    expect(
      vllmEntryMatches(v.input.entry as unknown),
      v.id,
    ).toBe(v.expect.eq as boolean);
  };

  it("matches on owned_by 'vllm'", () => {
    run("entryMatches/owned-by");
  });

  it("matches on max_model_len regardless of owned_by (either signature suffices)", () => {
    run("entryMatches/max-model-len-alone");
  });

  it("neither signature → no match (owned_by is an EXACT string compare)", () => {
    run("entryMatches/neither-user");
    run("entryMatches/neither-bare");
    run("entryMatches/neither-vllm-swap");
    run("entryMatches/neither-uppercase");
  });

  it("the locked rule is spelled `max_model_len !== undefined` (a null value still matches)", () => {
    // No shape gate beyond the two signatures — only ENRICHMENT applies the
    // positive-integer gate (a null max_model_len matches but enriches
    // nothing).
    run("entryMatches/null-max-model-len-still-matches");
  });

  it("malformed entries never match (fail-soft C6 — never throws)", () => {
    run("entryMatches/malformed-null");
    run("entryMatches/malformed-undefined");
    run("entryMatches/malformed-number");
    run("entryMatches/malformed-string");
    run("entryMatches/malformed-array");
  });
});

describe("vllmDetect (catalog-level, §6.1 — pure, ZERO fetches)", () => {
  const run = (id: string) => {
    const v = vectorOf("vllm", id);
    expect(vllmDetect(v.input.entries as OpenAIModelEntry[]), v.id).toBe(v.expect.eq);
  };

  it("matches a catalog whose entries all carry owned_by 'vllm'", () => {
    run("detect/owned-by-catalog");
  });

  it("matches on the max_model_len signature alone", () => {
    run("detect/max-model-len-alone");
  });

  it("matches a mixed catalog: one vLLM entry among llama-swap/bare entries", () => {
    run("detect/mixed-llamaswap-plus-vllm");
    run("detect/mixed-bare-plus-vllm");
  });

  it("FALSE-POSITIVE GUARD: a llama-swap catalog (meta.llamaswap entries) never matches", () => {
    // The router-collision hazard: our primary router must not be claimed by any
    // backend. llama-swap renders context_length (never top-level
    // max_model_len) and owned_by "llama-swap" — no ModelCard signature.
    run("detect/llamaswap-guard");
  });

  it("FALSE-POSITIVE GUARD: a bare OpenAI catalog never matches", () => {
    run("detect/bare-guard");
  });

  it("an empty catalog never matches", () => {
    run("detect/empty-catalog");
  });

  it("never throws on a malformed catalog (fail-soft C6)", () => {
    run("detect/malformed-all-garbage");
    run("detect/malformed-mixed-one-match");
  });
});

describe("vllmBackend.detect (the contract wrapper — DEFINITIVE, no probe)", () => {
  const run = async (id: string) => {
    const v = vectorOf("vllm", id);
    const { fetchImpl, calls } = { fetchImpl: vi.fn(), calls: [] };
    const verdict = await vllmBackend.detect({
      baseUrl: v.input.baseUrl as string,
      entries: v.input.entries as OpenAIModelEntry[],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    assertExpect(verdict, v.expect, calls, v.id);
    expect((verdict as { inconclusive?: unknown }).inconclusive, v.id).toBeUndefined();
    expect(fetchImpl, v.id).not.toHaveBeenCalled();
  };

  it("resolves { match: true } for a vLLM-shaped catalog — and NEVER fetches", async () => {
    await run("detectVerdict/match-true-never-fetches");
  });

  it("resolves { match: false } for the false-positive surfaces — DEFINITIVE, never inconclusive", async () => {
    await run("detectVerdict/llamaswap-definitive-no");
    await run("detectVerdict/bare-definitive-no");
    await run("detectVerdict/empty-catalog-definitive-no");
  });
});

describe("vllmMetadataRows (pure seam)", () => {
  const run = (id: string) => {
    const v = vectorOf("vllm", id);
    const byId = vllmMetadataRows(v.input.entries as unknown as OpenAIModelEntry[]);
    assertExpect(byId, v.expect, [], v.id);
  };

  it("maps a positive max_model_len to contextWindow — the FULL canonical object", () => {
    run("rows/positive-maps-fully");
  });

  it("coerces all-digit-string max_model_len through toPositiveInt", () => {
    run("rows/digit-string-coerced");
  });

  it("a non-numeric / non-positive / absent max_model_len is ABSENT from byId (generic row)", () => {
    run("rows/bad-values-absent");
  });

  it("mixed entries: only positive max_model_len ids enrich; the rest keep generic rows", () => {
    run("rows/mixed-catalog");
  });

  it("C5 pin: the canonical object carries ONLY contextWindow — never the decoy fields", () => {
    run("rows/c5-pin-single-field");
  });

  it("never throws on a malformed catalog (fail-soft C6)", () => {
    run("rows/malformed-garbage");
  });

  it("vllmBackend.metadataRows returns the byId map with no notes — and NEVER fetches", async () => {
    const v = vectorOf("vllm", "enrich/byId-no-notes-never-fetches");
    const fetchImpl = vi.fn();
    const rows = await vllmBackend.metadataRows(
      v.input.entries as unknown as OpenAIModelEntry[],
      { baseUrl: v.input.baseUrl as string, entries: VLLM_QWEN3, fetchImpl: fetchImpl as unknown as typeof fetch },
      undefined,
    );
    assertExpect(rows, v.expect, [], v.id);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

const VLLM_SECTION = {
  routes: [{ name: "vllm", baseURL: "http://127.0.0.1:8000/v1", models: null }],
  overrides: {},
};

/** A vLLM-shaped catalog: two enriched ids + one alias with no
 *  max_model_len (keeps its generic row). */
const VLLM_CHANNEL_CATALOG: OpenAIModelEntry[] = fixtureOf<OpenAIModelEntry[]>(
  "vllm",
  "VLLM_CHANNEL_CATALOG",
);

/** A stub fetch for /models only — the sole endpoint a vLLM channel run may hit (everything else 404s). */
function stubVllmFetch(config: { models?: () => Response }) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/models")) {
      return config.models ? config.models() : new Response("nope", { status: 404 });
    }
    return new Response("nope", { status: 404 });
  });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

type WireResult = {
  ok: boolean;
  value?: { models: Array<{ id: string; name?: string; discoveredCanonical?: unknown }> };
  error?: { code: string; message: string };
};

describe("discoverMetadata channel handler — the vLLM branch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // C3: the backends list is PINNED to the vLLM backend alone — the fetch
  // count assertions stay stable as the registry grows.
  const makeHandler = (log: (line: string) => void = () => undefined) =>
    makeChannelHandler({
      section: () => VLLM_SECTION,
      log,
      backends: [vllmBackend],
    });
  const call = (handler: ReturnType<typeof makeHandler>) =>
    handler("discoverMetadata", { provider: "vllm" }, new AbortController().signal) as Promise<WireResult>;

  it("a vLLM route enriches contextWindow from the catalog with ZERO backend fetches", async () => {
    const fetchImpl = stubVllmFetch({
      models: () => json({ object: "list", data: VLLM_CHANNEL_CATALOG }),
    });
    vi.stubGlobal("fetch", fetchImpl);
    const result = await call(makeHandler());
    expect(result.ok).toBe(true);
    // FULL-replacement rows: the enriched ids carry exactly
    // { contextWindow }; the id without a positive max_model_len keeps its
    // generic row (C4).
    expect(result.value?.models).toEqual([
      { id: "Qwen/Qwen3-8B", discoveredCanonical: { contextWindow: 40960 } },
      { id: "meta-llama/Llama-3.1-8B-Instruct", discoveredCanonical: { contextWindow: 131072 } },
      { id: "my-alias" },
    ]);
    // The fetch call log: ONLY the /v1/models catalog call exists —
    // detection and enrichment never fetch (§6.1/§6.2).
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("http://127.0.0.1:8000/v1/models");
  });

  it("a bare OpenAI catalog keeps the generic rows (channel-level false-positive guard)", async () => {
    const fetchImpl = stubVllmFetch({
      models: () => json({ object: "list", data: BARE_OPENAI_CATALOG }),
    });
    vi.stubGlobal("fetch", fetchImpl);
    const result = await call(makeHandler());
    expect(result.ok).toBe(true);
    expect(result.value?.models).toEqual([
      { id: "gpt-4o" },
      { id: "text-embedding-3-small" },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("a llama-swap catalog keeps the generic rows (channel-level false-positive guard)", async () => {
    const fetchImpl = stubVllmFetch({
      models: () => json({ object: "list", data: LLAMA_SWAP_CATALOG }),
    });
    vi.stubGlobal("fetch", fetchImpl);
    const result = await call(makeHandler());
    expect(result.ok).toBe(true);
    // The generic mapping still applies (llama-swap meta extraction) —
    // but the vLLM backend claimed nothing.
    expect(result.value?.models).toEqual([
      { id: "gemma4:e4b", discoveredCanonical: { reasoning: true, contextWindow: 131072 } },
      {
        id: "qwen3.8",
        discoveredCanonical: { reasoning: true, maxTokens: 65536, contextWindow: 262144 },
      },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("two calls: still exactly one /models fetch (the entries memo; detection adds nothing)", async () => {
    const fetchImpl = stubVllmFetch({
      models: () => json({ object: "list", data: VLLM_CHANNEL_CATALOG }),
    });
    vi.stubGlobal("fetch", fetchImpl);
    const handler = makeHandler();
    await call(handler);
    await call(handler);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("a failing /models fetch still fails the endpoint (the C2 invariant — backends never the cause)", async () => {
    const fetchImpl = stubVllmFetch({ models: () => new Response("nope", { status: 500 }) });
    vi.stubGlobal("fetch", fetchImpl);
    const result = await call(makeHandler());
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("internal");
  });
});

const LIVE_BASE = "http://localhost:8000/v1";
const LIVE_PROBE_TIMEOUT_MS = 2_500;

const liveCatalog: OpenAIModelEntry[] | undefined = await fetch(`${LIVE_BASE}/models`, {
  headers: { Accept: "application/json" },
  signal: AbortSignal.timeout(LIVE_PROBE_TIMEOUT_MS),
})
  .then(async (response) => {
    if (!response.ok) return undefined;
    const payload = (await response.json()) as { data?: OpenAIModelEntry[] };
    return Array.isArray(payload.data) ? payload.data : undefined;
  })
  .catch(() => undefined);

/** Double gate: the probe answered AND the catalog carries a vLLM
 *  ModelCard signature (a non-vLLM server squatting on :8000 skips, like
 *  llama.cpp's owned_by gate). */
const liveVllmCatalog: OpenAIModelEntry[] | undefined =
  liveCatalog !== undefined && vllmDetect(liveCatalog) ? liveCatalog : undefined;

describe.skipIf(liveCatalog === undefined)("Live E2E — a vLLM-shaped catalog on :8000", () => {
  it("detects vLLM from the live catalog", () => {
    expect(vllmDetect(liveCatalog as OpenAIModelEntry[])).toBe(true);
  });

  it("flows max_model_len into contextWindow for the live entries that carry it", () => {
    const entries = liveCatalog as OpenAIModelEntry[];
    const carriers = entries.filter((entry) => entry.max_model_len !== undefined);
    expect(carriers.length).toBeGreaterThan(0);
    const byId = vllmMetadataRows(entries);
    for (const entry of carriers) {
      const expected = toPositiveInt(entry.max_model_len);
      if (expected === undefined) continue; // non-positive → generic row
      expect(byId.get(entry.id)).toEqual({ contextWindow: expected });
    }
    for (const entry of entries) {
      if (toPositiveInt(entry.max_model_len) === undefined) {
        expect(byId.has(entry.id)).toBe(false);
      }
    }
  });
});