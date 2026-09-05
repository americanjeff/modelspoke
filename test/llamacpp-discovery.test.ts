import { afterEach, describe, expect, it, vi } from "vitest";
import { makeChannelHandler } from "../src/dsh/channel.js";
import {
  fetchLlamacppProps,
  hasLlamaSwapProvenance,
  hasLlamacppGgufMeta,
  isLlamacppCatalogEntry,
  isLlamacppOwnedBy,
  llamacppBackend,
  llamacppOrigin,
  llamacppPropsToCanonical,
  llamacppRowsById,
} from "../src/discovery/llamacpp.js";
import type { LlamacppProps } from "../src/discovery/llamacpp.js";
import type { OpenAIModelEntry } from "../src/discovery/types.js";
import {
  apiKeyOf,
  assertExpect,
  fakeFetch,
  fixtureOf,
  signalOf,
  vectorOf,
  vectorsOf,
} from "./discovery-corpus.js";

/** The full `/props` shape (docs/provider-details.md §3.3) — a vision model whose template
 *  declares the reasoning-effort gate. */
const PROPS_FULL = fixtureOf<LlamacppProps>("llamacpp", "PROPS_FULL");

const PROPS_NO_VISION_NO_EFFORT = fixtureOf<LlamacppProps>("llamacpp", "PROPS_NO_VISION_NO_EFFORT");

/** A bare llama-server catalog entry (owned_by marker + GGUF meta). */
const LLAMACPP_OWNED_ENTRY = fixtureOf<OpenAIModelEntry>("llamacpp", "LLAMACPP_OWNED_ENTRY");

/** A bare-shape entry: no meta, no llama.cpp owned_by (pre-b3400 catalog). */
const BARE_ENTRY = fixtureOf<OpenAIModelEntry>("llamacpp", "BARE_ENTRY");

/**
 * A live llama-swap catalog entry (docs/provider-details.md §3.1 [verified-live]) — THE
 * FALSE-POSITIVE GUARD fixture: this surface must never claim the
 * llama.cpp backend.
 */
const LLAMA_SWAP_ENTRY = fixtureOf<OpenAIModelEntry>("llamacpp", "LLAMA_SWAP_ENTRY");

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("llamacppOrigin", () => {
  function run(id: string) {
    const v = vectorOf("llamacpp", id);
    expect(llamacppOrigin(v.input.base as string), v.id).toBe(v.expect.eq as string);
  }

  it("strips the trailing /v1 from a normalized route base", () => {
    run("origin/strips-trailing-v1");
    run("origin/strips-trailing-v1-slash");
    run("origin/strips-api-v1");
    run("origin/strips-only-one-v1");
  });

  it("defensively passes a base that does not end in /v1 through (slash-stripped)", () => {
    run("origin/no-v1-passthrough");
    run("origin/no-v1-slash-stripped");
  });
});

describe("the C10 catalog gates", () => {
  function run(id: string, gate: (entry: OpenAIModelEntry) => boolean) {
    const v = vectorOf("llamacpp", id);
    expect(gate(v.input.entry as OpenAIModelEntry), v.id).toBe(v.expect.eq as boolean);
  }

  it("isLlamacppOwnedBy: exactly the owned_by === 'llamacpp' spelling", () => {
    run("gates/ownedBy-llamacpp", isLlamacppOwnedBy);
    run("gates/ownedBy-bare", isLlamacppOwnedBy);
    run("gates/ownedBy-llamaswap", isLlamacppOwnedBy);
    run("gates/ownedBy-gguf-only", isLlamacppOwnedBy);
  });

  it("hasLlamacppGgufMeta: a meta object EXCLUDING llama-swap's authored block", () => {
    run("gates/gguf-owned-entry", hasLlamacppGgufMeta);
    run("gates/gguf-meta-without-owned-by", hasLlamacppGgufMeta);
    // THE FALSE-POSITIVE GUARD: meta.llamaswap is llama-swap's authored
    // provenance, not the llama.cpp GGUF meta — even with the mirrored
    // meta.n_ctx beside it.
    run("gates/gguf-false-positive-guard", hasLlamacppGgufMeta);
    run("gates/gguf-llamaswap-block-only", hasLlamacppGgufMeta);
    run("gates/gguf-bare", hasLlamacppGgufMeta);
    run("gates/gguf-no-meta", hasLlamacppGgufMeta);
    run("gates/gguf-meta-array", hasLlamacppGgufMeta);
  });

  it("hasLlamacppGgufMeta: SHAPE-GATED — a bare meta with only n_ctx (llama-swap's live shape, 11/13 entries) never matches (docs/provider-details.md §3.1)", () => {
    // The [verified-live] v250 hazard: a top-level `meta` carrying only the
    // router-mode `n_ctx` key (issue #999 — llama.cpp router-mode's OWN
    // key) is NOT a GGUF meta.
    run("gates/gguf-shape-gate-nctx-only", hasLlamacppGgufMeta);
    run("gates/gguf-shape-gate-empty-meta", hasLlamacppGgufMeta);
    // A real GGUF meta matches on ANY core shape key, even beside n_ctx.
    run("gates/gguf-core-key-beside-nctx", hasLlamacppGgufMeta);
    run("gates/gguf-nvocab-only", hasLlamacppGgufMeta);
  });

  it("isLlamacppCatalogEntry: either half claims the origin", () => {
    run("gates/catalogEntry-owned", isLlamacppCatalogEntry);
    run("gates/catalogEntry-gguf", isLlamacppCatalogEntry);
    run("gates/catalogEntry-llamaswap", isLlamacppCatalogEntry);
    run("gates/catalogEntry-bare", isLlamacppCatalogEntry);
  });

  it("hasLlamaSwapProvenance: the authored meta.llamaswap block is the router's signature", () => {
    run("gates/provenance-llamaswap", hasLlamaSwapProvenance);
    run("gates/provenance-empty-block", hasLlamaSwapProvenance);
    run("gates/provenance-llamacpp-owned", hasLlamaSwapProvenance);
    run("gates/provenance-bare", hasLlamaSwapProvenance);
  });
});

describe("fetchLlamacppProps (GET {origin}/props)", () => {
  async function runOne(id: string) {
    const v = vectorOf("llamacpp", id);
    const { fetchImpl, calls } = fakeFetch(v.fetch);
    const probe = await fetchLlamacppProps(v.input.origin as string, {
      fetchImpl,
      ...apiKeyOf(v.input),
      signal: signalOf(v.input),
    });
    assertExpect(probe, v.expect, calls, v.id);
  }

  it("GETs {origin}/props and passes the shape gate with the parsed payload", async () => {
    await runOne("fetchProps/get-and-parse");
  });

  it("rides the route's apiKey (C7): Authorization Bearer when set", async () => {
    await runOne("fetchProps/c7-bearer");
  });

  it("404/405/401 are a DEFINITIVE non-match (C10's well-formed non-answers)", async () => {
    await runOne("fetchProps/404-definitive");
    await runOne("fetchProps/405-definitive");
    await runOne("fetchProps/401-definitive");
  });

  it("5xx / network failure / abort are INCONCLUSIVE (not evidence)", async () => {
    await runOne("fetchProps/5xx-inconclusive-500");
    await runOne("fetchProps/5xx-inconclusive-502");
    await runOne("fetchProps/5xx-inconclusive-503");
    await runOne("fetchProps/network-inconclusive");
    await runOne("fetchProps/abort-inconclusive");
  });

  it("a 200 with a NON-props body is a definitive non-match (KoboldCpp's /props, note §3.2)", async () => {
    await runOne("fetchProps/non-props-kobold-shape");
    await runOne("fetchProps/non-props-dgs-string");
    await runOne("fetchProps/non-props-dgs-null");
    await runOne("fetchProps/non-props-array");
    await runOne("fetchProps/non-props-string-body");
    await runOne("fetchProps/non-json-200-definitive");
  });

  it("never throws, even when the origin string is hostile", async () => {
    await runOne("fetchProps/hostile-origin-inconclusive");
  });
});

describe("llamacppPropsToCanonical: contextWindow (the two-layer preference)", () => {
  function run(id: string) {
    const v = vectorOf("llamacpp", id);
    const props = (v.input.props ?? undefined) as LlamacppProps | undefined;
    const mapping = llamacppPropsToCanonical(props, v.input.entry as OpenAIModelEntry);
    assertExpect(mapping, v.expect, [], v.id);
  }

  it("prefers default_generation_settings.n_ctx (AS CONFIGURED) over meta.n_ctx_train", () => {
    // 4096 configured vs 131072 trained-max: the value that actually bounds
    // generation wins (the same two-layer split as LM Studio's loaded/max).
    run("map/ctx-prefers-configured");
  });

  it("falls to the entry's own meta.n_ctx_train when props n_ctx is absent/invalid", () => {
    run("map/ctx-falls-to-train");
    for (const v of vectorsOf("llamacpp", "llamacpp.propsToCanonical")) {
      if (v.id.startsWith("map/ctx-bad-")) run(v.id);
    }
    run("map/ctx-invalid-no-meta-omitted");
  });

  it("C6: a FAILED /props (undefined) still emits the fetch-free meta.n_ctx_train contextWindow", () => {
    run("map/c6-failed-props-emits-train-ctx");
    // No meta → nothing (the generic row passthrough owns the id).
    run("map/c6-failed-props-no-meta-nothing");
  });

  it("coerces digit strings and rejects non-integers through toPositiveInt", () => {
    run("map/coerce-digit-string-nctx");
    run("map/coerce-digit-string-train");
    run("map/coerce-float-train-invalid");
  });

  it("meta.n_ctx (the as-configured mirror) is NOT in the chain — only n_ctx_train", () => {
    // An entry whose meta carries only the configured mirror: without a
    // props answer the backend emits nothing (the generic extractor owns
    // that slot; the locked chain reads n_ctx_train only).
    run("map/mirror-only-not-in-chain");
  });
});

describe("llamacppPropsToCanonical: input (modalities.vision)", () => {
  function run(id: string) {
    const v = vectorOf("llamacpp", id);
    const props = (v.input.props ?? undefined) as LlamacppProps | undefined;
    const mapping = llamacppPropsToCanonical(props, v.input.entry as OpenAIModelEntry);
    assertExpect(mapping, v.expect, [], v.id);
  }

  it("vision true → ['text','image']; false → ['text']; absent → omitted", () => {
    run("map/input-vision-true");
    run("map/input-vision-false");
    run("map/input-absent-old-server");
    run("map/input-malformed-modalities");
  });

  it("a FAILED /props emits no input at all (the fallback is context-only)", () => {
    run("map/c6-failed-props-input-only-context");
  });
});

describe("llamacppPropsToCanonical: the caps boolean gate (the ONE C5 compat exception)", () => {
  function run(id: string) {
    const v = vectorOf("llamacpp", id);
    const props = (v.input.props ?? undefined) as LlamacppProps | undefined;
    const mapping = llamacppPropsToCanonical(props, v.input.entry as OpenAIModelEntry);
    assertExpect(mapping, v.expect, [], v.id);
  }

  it("supports_reasoning_effort true → compat true AND reasoning true", () => {
    run("map/caps-effort-true");
  });

  it("supports_reasoning_effort false → the EXACT false compat is emitted, NO reasoning field", () => {
    run("map/caps-effort-false-no-reasoning");
  });

  it("absent caps (an old server) → NO compat and NO reasoning (today's behavior preserved)", () => {
    run("map/caps-absent-old-server");
  });

  it("caps present but the gate missing/non-boolean → no compat, no reasoning (per-field degrade)", () => {
    run("map/caps-malformed-empty");
    run("map/caps-malformed-string");
    run("map/caps-malformed-number");
    run("map/caps-malformed-null");
  });
});

describe("llamacppPropsToCanonical: the never-emits (C5 + the jinja capture-out-of-scope)", () => {
  function run(id: string) {
    const v = vectorOf("llamacpp", id);
    const props = (v.input.props ?? undefined) as LlamacppProps | undefined;
    const mapping = llamacppPropsToCanonical(props, v.input.entry as OpenAIModelEntry);
    assertExpect(mapping, v.expect, [], v.id);
  }

  it("never emits maxTokens or thinkingLevelMap, however much /props carries", () => {
    run("map/never-emits-maxTokens-thinkingLevelMap");
  });

  it("the raw jinja chat_template is never propagated (capture-out-of-scope, §4.3)", () => {
    run("map/jinja-never-propagated");
  });
});

describe("llamacppRowsById", () => {
  function run(id: string) {
    const v = vectorOf("llamacpp", id);
    const props = (v.input.props ?? undefined) as LlamacppProps | undefined;
    const byId = llamacppRowsById(v.input.entries as OpenAIModelEntry[], props);
    assertExpect(byId, v.expect, [], v.id);
  }

  it("props answered: EVERY entry is enriched (router mode — server-wide values)", () => {
    run("rows/props-answered-server-wide");
  });

  it("props with no usable fields: bare entries are enriched-nothing (undefined values)", () => {
    run("rows/minimal-props-bare-undefined");
  });

  it("props failed: only the fetch-free meta.n_ctx_train fallback applies", () => {
    run("rows/props-failed-train-fallback-only");
  });

  it("an entry with only the as-configured mirror (no n_ctx_train) keeps the generic row when props failed", () => {
    run("rows/mirror-only-absent");
  });

  it("an empty catalog resolves an empty map", () => {
    run("rows/empty-catalog");
  });
});

describe("llamacppBackend.detect — the catalog-first ZERO-fetch matches", () => {
  async function runOne(id: string) {
    const v = vectorOf("llamacpp", id);
    const { fetchImpl, calls } = fakeFetch(v.fetch);
    const verdict = await llamacppBackend.detect({
      baseUrl: v.input.baseUrl as string,
      entries: v.input.entries as OpenAIModelEntry[],
      ...apiKeyOf(v.input),
      fetchImpl,
    });
    assertExpect(verdict, v.expect, calls, v.id);
  }

  it("matches on owned_by === 'llamacpp' without any fetch", async () => {
    await runOne("detectVerdict/catalog-owned-by-zero-fetch");
  });

  it("matches on a GGUF meta object (non-llama-swap) without any fetch", async () => {
    await runOne("detectVerdict/catalog-gguf-zero-fetch");
  });

  it("FALSE-POSITIVE GUARD: a llama-swap catalog (meta.llamaswap) is a ZERO-fetch definitive no", async () => {
    // Zero-fetch definitive no (docs/provider-details.md §3.1): llama-swap serves no /props, and a
    // proxied props answer must never override the authored meta.llamaswap.
    await runOne("detectVerdict/llamaswap-guard-zero-fetch");
  });

  it("FALSE-POSITIVE GUARD (shape gate): a bare n_ctx-only meta (llama-swap's [verified-live] 11/13 entries) does NOT catalog-match — it falls through to the probe, never a zero-fetch claim (docs/provider-details.md §3.1)", async () => {
    await runOne("detectVerdict/shape-gate-bare-nctx-probes");
  });

  it("FALSE-POSITIVE GUARD: the mixed live shape (bare n_ctx meta + a meta.llamaswap entry) is a ZERO-fetch definitive no", async () => {
    // The actual v250 catalog: 13/13 top-level meta, 11/13 n_ctx, every
    // entry with the llamaswap block — the provenance short-circuit settles
    // the origin before any meta half is consulted.
    await runOne("detectVerdict/llamaswap-mixed-shape-guard");
  });

  it("FALSE-POSITIVE GUARD: the llama-swap verdict is definitive even when /props would be unreachable", async () => {
    // The short-circuit settles the origin WITHOUT the probe, so an
    // unreachable /props cannot turn the verdict inconclusive (which would
    // re-probe on every call): llama-swap is a definitive no, memoized.
    await runOne("detectVerdict/llamaswap-definitive-unreachable-props");
  });
});

describe("llamacppBackend.detect — the ONE probe (bare-shape catalogs)", () => {
  async function runOne(id: string) {
    const v = vectorOf("llamacpp", id);
    const { fetchImpl, calls } = fakeFetch(v.fetch);
    const verdict = await llamacppBackend.detect({
      baseUrl: v.input.baseUrl as string,
      entries: v.input.entries as OpenAIModelEntry[],
      ...apiKeyOf(v.input),
      fetchImpl,
    });
    assertExpect(verdict, v.expect, calls, v.id);
  }

  it("matches on the /props shape and caches the payload in facts (the reuse contract)", async () => {
    await runOne("detectVerdict/probe-match-caches-facts");
  });

  it("404/405/401 → a DEFINITIVE non-match", async () => {
    await runOne("detectVerdict/404-definitive");
    await runOne("detectVerdict/405-definitive");
    await runOne("detectVerdict/401-definitive");
  });

  it("5xx / network / abort → INCONCLUSIVE (retriable)", async () => {
    await runOne("detectVerdict/5xx-inconclusive");
    await runOne("detectVerdict/network-inconclusive");
  });

  it("a 200 non-props body (KoboldCpp's /props) → a definitive non-match", async () => {
    await runOne("detectVerdict/non-props-200-definitive");
  });

  it("the probe rides the route's apiKey (C7)", async () => {
    await runOne("detectVerdict/c7-bearer");
  });
});

const LLAMACPP_SECTION = {
  routes: [{ name: "llamacpp", baseURL: "http://127.0.0.1:8080/v1", models: null }],
  overrides: {},
};

function stubLlamacppFetch(config: {
  props?: () => Response;
  models?: () => Response;
}) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/props")) {
      return config.props ? config.props() : new Response("nope", { status: 404 });
    }
    if (url.endsWith("/models")) {
      return config.models ? config.models() : new Response("nope", { status: 404 });
    }
    return new Response("nope", { status: 404 });
  });
}

type WireResult = {
  ok: boolean;
  value?: { models: Array<{ id: string; name?: string; discoveredCanonical?: unknown }> };
  error?: { code: string; message: string };
};

describe("discoverMetadata channel handler — the llama.cpp branch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const makeHandler = (log: (line: string) => void = () => undefined) =>
    makeChannelHandler({
      section: () => LLAMACPP_SECTION,
      log,
      backends: [llamacppBackend], // PINNED (C3) — the registry order is the owner's
    });
  const call = (handler: ReturnType<typeof makeHandler>) =>
    handler("discoverMetadata", { provider: "llamacpp" }, new AbortController().signal) as Promise<WireResult>;

  it("a llama.cpp catalog: detection is zero-fetch, ONE /props enriches every entry", async () => {
    const fetchImpl = stubLlamacppFetch({
      props: () => json(PROPS_FULL),
      models: () => json({ object: "list", data: [LLAMACPP_OWNED_ENTRY, BARE_ENTRY] }),
    });
    vi.stubGlobal("fetch", fetchImpl);
    const result = await call(makeHandler());
    expect(result.ok).toBe(true);
    const models = result.value?.models ?? [];
    expect(models).toEqual([
      {
        id: "Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf",
        discoveredCanonical: {
          contextWindow: 4096, // AS CONFIGURED, not the 131072 train-max
          input: ["text", "image"],
          compat: { supportsReasoningEffort: true },
          reasoning: true,
        },
      },
      // The bare entry rides the server-wide values too (the accepted v1
      // router-mode trade-off — /props answers for the default slot).
      {
        id: "gemma-4-E4B-it",
        discoveredCanonical: {
          contextWindow: 4096,
          input: ["text", "image"],
          compat: { supportsReasoningEffort: true },
          reasoning: true,
        },
      },
    ]);
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/props"))).toHaveLength(1);
  });

  it("a bare catalog probes /props ONCE and reuses the payload across calls (facts cache)", async () => {
    const fetchImpl = stubLlamacppFetch({
      props: () => json(PROPS_NO_VISION_NO_EFFORT),
      models: () => json({ object: "list", data: [BARE_ENTRY] }),
    });
    vi.stubGlobal("fetch", fetchImpl);
    const handler = makeHandler();
    for (let index = 0; index < 2; index += 1) {
      const result = await call(handler);
      expect(result.ok).toBe(true);
      expect(result.value?.models).toEqual([
        {
          id: "gemma-4-E4B-it",
          // The bare entry rides the server-wide values (router mode): the
          // vision-false modality and the declared-false effort gate.
          discoveredCanonical: {
            contextWindow: 8192,
            input: ["text"],
            compat: { supportsReasoningEffort: false },
          },
        },
      ]);
    }
    // Call 1: detection probe (cached into facts) reused by the enrichment.
    // Call 2: the definitive detection (with its facts) is memoized. One
    // total /props fetch for the route's lifetime.
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/props"))).toHaveLength(1);
  });

  it("a catalog-first match fetches /props once PER call (no payload cached in facts)", async () => {
    const fetchImpl = stubLlamacppFetch({
      props: () => json(PROPS_FULL),
      models: () => json({ object: "list", data: [LLAMACPP_OWNED_ENTRY] }),
    });
    vi.stubGlobal("fetch", fetchImpl);
    const handler = makeHandler();
    await call(handler);
    await call(handler);
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/props"))).toHaveLength(2);
  });

  it("a definitive 404 detection is memoized: generic rows, ONE /props across two calls", async () => {
    const fetchImpl = stubLlamacppFetch({
      props: () => new Response("nope", { status: 404 }),
      models: () => json({ object: "list", data: [BARE_ENTRY] }),
    });
    vi.stubGlobal("fetch", fetchImpl);
    const handler = makeHandler();
    for (let index = 0; index < 2; index += 1) {
      const result = await call(handler);
      expect(result.ok).toBe(true);
      expect(result.value?.models).toEqual([{ id: "gemma-4-E4B-it" }]);
    }
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/props"))).toHaveLength(1);
  });

  it("an INCONCLUSIVE detection retries on the next call (never fails the endpoint)", async () => {
    const fetchImpl = stubLlamacppFetch({
      props: () => {
        throw new TypeError("fetch failed");
      },
      models: () => json({ object: "list", data: [BARE_ENTRY] }),
    });
    vi.stubGlobal("fetch", fetchImpl);
    const handler = makeHandler();
    for (let index = 0; index < 2; index += 1) {
      const result = await call(handler);
      expect(result.ok).toBe(true);
      expect(result.value?.models).toEqual([{ id: "gemma-4-E4B-it" }]);
    }
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/props"))).toHaveLength(2);
  });

  it("C6: /props failing after a catalog-first match still emits the meta.n_ctx_train contextWindow", async () => {
    const fetchImpl = stubLlamacppFetch({
      props: () => {
        throw new TypeError("fetch failed");
      },
      models: () => json({ object: "list", data: [LLAMACPP_OWNED_ENTRY, BARE_ENTRY] }),
    });
    vi.stubGlobal("fetch", fetchImpl);
    const result = await call(makeHandler());
    expect(result.ok).toBe(true);
    const models = result.value?.models ?? [];
    // 131072 is the fetch-free meta.n_ctx_train fallback (props failed).
    expect(models[0]).toEqual({
      id: "Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf",
      discoveredCanonical: { contextWindow: 131072 },
    });
    expect(models[1]).toEqual({ id: "gemma-4-E4B-it" });
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/props"))).toHaveLength(1);
  });

  it("FALSE-POSITIVE GUARD end to end: a llama-swap route keeps its generic rows (zero probes)", async () => {
    const fetchImpl = stubLlamacppFetch({
      props: () => json(PROPS_FULL), // must NEVER be reached
      models: () => json({ object: "list", data: [LLAMA_SWAP_ENTRY] }),
    });
    vi.stubGlobal("fetch", fetchImpl);
    const result = await call(makeHandler());
    expect(result.ok).toBe(true);
    expect(result.value?.models).toEqual([
      {
        id: "gemma-4-E4B-it",
        // The generic mapping of the authored llama-swap entry:
        // meta.llamaswap.reasoning, the top-level context_length, and the
        // architecture.input_modalities — byte-identical to before the llama.cpp backend.
        discoveredCanonical: { input: ["text"], reasoning: true, contextWindow: 4096 },
      },
    ]);
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/props"))).toHaveLength(0);
  });
});

const LIVE_ORIGIN = "http://localhost:8080";
const LIVE_PROBE_TIMEOUT_MS = 2_500;

/**
 * Gate A — the catalog at the conventional bare-llama-server port must
 * actually show `owned_by === "llamacpp"`. On THIS machine :8080 is
 * llama-swap (its entries spell `owned_by: "llama-swap"`), so the gate
 * fails and the suite skips — the false-positive guard fixture above pins
 * that surface instead.
 */
const liveCatalogOwnedByLlamacpp: boolean = await fetch(`${LIVE_ORIGIN}/v1/models`, {
  headers: { Accept: "application/json" },
  signal: AbortSignal.timeout(LIVE_PROBE_TIMEOUT_MS),
})
  .then(async (response) => {
    if (!response.ok) return false;
    const payload = (await response.json()) as { data?: OpenAIModelEntry[] };
    return (payload.data ?? []).some((entry) => entry.owned_by === "llamacpp");
  })
  .catch(() => false);

/**
 * Gate B — `/props` must answer the props shape (both gates together make
 * the E2E run ONLY against a real bare llama-server).
 */
const liveProps: LlamacppProps | undefined = liveCatalogOwnedByLlamacpp
  ? await fetchLlamacppProps(LIVE_ORIGIN, { signal: AbortSignal.timeout(LIVE_PROBE_TIMEOUT_MS) })
      .then((probe) => probe.props)
      .catch(() => undefined)
  : undefined;

describe.skipIf(liveProps === undefined)("Live E2E — a real bare llama-server (double-gated)", () => {
  it("gate A: the catalog really carries owned_by llamacpp", () => {
    expect(liveCatalogOwnedByLlamacpp).toBe(true);
  });

  it("gate B + read-only enrichment: /props maps through the locked chain, no out-of-scope keys", async () => {
    const probe = await fetchLlamacppProps(LIVE_ORIGIN, { signal: AbortSignal.timeout(10_000) });
    expect(probe.props).toBeDefined();
    const { discoveredCanonical } = llamacppPropsToCanonical(probe.props, LLAMACPP_OWNED_ENTRY);
    if (discoveredCanonical?.contextWindow !== undefined) {
      expect(discoveredCanonical.contextWindow).toBeGreaterThan(0);
      expect(Number.isInteger(discoveredCanonical.contextWindow)).toBe(true);
    }
    if (discoveredCanonical?.compat !== undefined) {
      expect(typeof discoveredCanonical.compat.supportsReasoningEffort).toBe("boolean");
    }
    expect("maxTokens" in (discoveredCanonical as object)).toBe(false);
    expect("thinkingLevelMap" in (discoveredCanonical as object)).toBe(false);
    expect(JSON.stringify(discoveredCanonical)).not.toContain("chat_template");
    expect(JSON.stringify(discoveredCanonical)).not.toContain("jinja");
  });
});