import { afterEach, describe, expect, it, vi } from "vitest";
import { makeChannelHandler } from "../src/dsh/channel.js";
import type { DiscoveryBackend } from "../src/discovery/backends.js";
import { ollamaBackend } from "../src/discovery/ollama.js";
import {
  fetchSglangServerInfo,
  probeSglangModelInfo,
  sglangBackend,
  sglangModelInfoToCanonical,
  sglangRowsById,
  sglangServerInfoContextWindow,
} from "../src/discovery/sglang.js";
import type {
  SglangModelInfoResponse,
  SglangServerInfoResponse,
} from "../src/discovery/sglang.js";
import type { OpenAIModelEntry } from "../src/discovery/types.js";
import {
  apiKeyOf,
  assertExpect,
  fakeFetch,
  fixtureOf,
  signalOf,
  vectorOf,
  vectorsOf,
  type Vector,
} from "./discovery-corpus.js";

const MODEL_INFO_FULL = fixtureOf<SglangModelInfoResponse>("sglang", "MODEL_INFO_FULL");
const MODEL_INFO_04X = fixtureOf<SglangModelInfoResponse>("sglang", "MODEL_INFO_04X");
const SERVER_INFO = fixtureOf<SglangServerInfoResponse>("sglang", "SERVER_INFO");
const ENTRIES = fixtureOf<OpenAIModelEntry[]>("sglang", "ENTRIES");

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("sglangModelInfoToCanonical (the locked §5.3 mapping)", () => {
  const runOne = (id: string) => {
    const v = vectorOf("sglang", id);
    const canonical = sglangModelInfoToCanonical(
      v.input.entry as OpenAIModelEntry,
      v.input.modelInfo as SglangModelInfoResponse,
      v.input.serverInfo as SglangServerInfoResponse | undefined,
    );
    assertExpect(canonical, v.expect, [], v.id);
  };

  it("maps the full recent-main model_info: reasoning + vision input + the entry's own ctx", () => {
    runOne("mapModelInfo/full-recent-main");
  });

  it("a 0.4.x-era model_info (no reasoning_parser / has_image_understanding) maps only the context chain", () => {
    runOne("mapModelInfo/04x-era-context-chain-only");
  });

  it("has_image_understanding === false → [text] (explicitly text-only, not omitted)", () => {
    runOne("mapModelInfo/image-false-text-only");
  });

  it("has_image_understanding absent or non-boolean → input omitted (probe discipline)", () => {
    runOne("mapModelInfo/image-absent-omitted");
    runOne("mapModelInfo/image-garbage-string-omitted");
  });

  it("reasoning ← reasoning_parser only when a NON-EMPTY string (empty / non-string → omitted)", () => {
    for (const v of vectorsOf("sglang", "sglang.mapModelInfo")) {
      if (v.id.startsWith("mapModelInfo/parser-bad-")) runOne(v.id);
    }
    runOne("mapModelInfo/parser-name-alone-reasoning-only");
  });

  it("the contextWindow 3-step chain: entry max_model_len → server_args.context_length → token_capacity", () => {
    runOne("mapModelInfo/chain-entry-wins");
    runOne("mapModelInfo/chain-server-args");
    runOne("mapModelInfo/chain-token-capacity");
    runOne("mapModelInfo/chain-no-server-info-omits");
  });

  it("a non-positive / garbage entry max_model_len falls through to the server-wide steps", () => {
    for (const v of vectorsOf("sglang", "sglang.mapModelInfo")) {
      if (v.id.startsWith("mapModelInfo/entry-ctx-bad-")) runOne(v.id);
    }
  });

  it("coerces digit-string context values through toPositiveInt", () => {
    runOne("mapModelInfo/coerce-args-digit-string");
    runOne("mapModelInfo/coerce-entry-digit-string");
    runOne("mapModelInfo/coerce-token-capacity-digit-string");
  });

  it("NEVER emits maxTokens / compat / thinkingLevelMap however much the surface carries (C5)", () => {
    runOne("mapModelInfo/never-emits-c5");
  });

  it("an entry that maps to nothing yields undefined (C4's enriched-with-nothing spelling)", () => {
    runOne("mapModelInfo/04x-entry-with-ctx");
    runOne("mapModelInfo/04x-entry-maps-nothing");
  });

  it("fail-soft: malformed server_info shapes degrade per field, never throw", () => {
    for (const v of vectorsOf("sglang", "sglang.mapModelInfo")) {
      if (v.id.startsWith("mapModelInfo/serverinfo-")) runOne(v.id);
    }
  });
});

describe("sglangServerInfoContextWindow (server_args → token_capacity)", () => {
  const runOne = (id: string) => {
    const v = vectorOf("sglang", id);
    const contextWindow = sglangServerInfoContextWindow(
      v.input.serverInfo as SglangServerInfoResponse | undefined,
    );
    assertExpect(contextWindow, v.expect, [], v.id);
  };

  it("prefers server_args.context_length over the runtime token_capacity", () => {
    runOne("serverInfoCtx/prefers-server-args");
  });

  it("falls back to internal_states[0].memory_usage.token_capacity (the runtime-true last resort)", () => {
    runOne("serverInfoCtx/falls-back-token-capacity");
  });

  it("tolerates malformed shapes at every level (fail-soft → undefined)", () => {
    for (const v of vectorsOf("sglang", "sglang.serverInfoContextWindow")) {
      if (v.id.startsWith("serverInfoCtx/malformed-")) {
        const contextWindow = sglangServerInfoContextWindow(
          v.input.serverInfo as SglangServerInfoResponse | undefined,
        );
        assertExpect(contextWindow, v.expect, [], v.id);
      }
    }
  });
});

describe("probeSglangModelInfo (§5.1 detection)", () => {
  const runOne = async (id: string) => {
    const v = vectorOf("sglang", id);
    const { fetchImpl, calls } = fakeFetch(v.fetch);
    const probe = await probeSglangModelInfo(v.input.origin as string, {
      fetchImpl,
      ...apiKeyOf(v.input),
      signal: signalOf(v.input),
    });
    assertExpect(probe, v.expect, calls, v.id);
  };

  it("answers match for the SGLang shape on the NEW name (url + one fetch)", async () => {
    await runOne("probe/new-name-match");
  });

  it("matches on served_model_name alone (model_path absent) and on either marker being non-empty", async () => {
    await runOne("probe/served-name-only");
    await runOne("probe/model-path-only");
  });

  it("rejects a 200 without both markers as a DEFINITIVE no — the llama-swap/OpenAI lookalike guard (§8)", async () => {
    for (const v of vectorsOf("sglang", "sglang.probeModelInfo")) {
      if (v.id.startsWith("probe/lookalike-")) await runOne(v.id);
    }
  });

  it("a 200 with malformed JSON is a definitive no", async () => {
    await runOne("probe/non-json-200");
  });

  it("the deprecated alias is tried ONCE, and ONLY after a 404 of the new name (§5.1)", async () => {
    await runOne("probe/alias-fallback");
  });

  it("an alias match caches the ALIAS body (the facts.modelInfo source for old servers)", async () => {
    await runOne("probe/alias-body-cached");
  });

  it("404 on BOTH names → definitive no (exactly two probes)", async () => {
    await runOne("probe/404-both-names");
  });

  it("a 200-wrong-shape from the alias (after a 404) is still a definitive no", async () => {
    await runOne("probe/alias-wrong-shape-200");
  });

  it("405 / 401 on the new name → definitive no WITHOUT trying the alias (C10)", async () => {
    await runOne("probe/405-definitive-no-alias");
    await runOne("probe/401-definitive-no-alias");
  });

  it("5xx on the new name → INCONCLUSIVE (no alias attempt, retriable)", async () => {
    await runOne("probe/5xx-new-name-inconclusive");
  });

  it("5xx on the alias (after a 404 on the new name) → INCONCLUSIVE", async () => {
    await runOne("probe/5xx-alias-inconclusive");
  });

  it("a network failure is an INCONCLUSIVE not-SGLang (retriable)", async () => {
    await runOne("probe/network-failure-inconclusive");
  });

  it("never throws, even when fetchImpl rejects with an abort", async () => {
    await runOne("probe/abort-inconclusive");
  });

  it("C7: the route's apiKey rides the probe as a Bearer header (—api-key protects ALL endpoints)", async () => {
    await runOne("probe/c7-bearer-header");
    await runOne("probe/c7-no-key-no-header");
  });
});

describe("fetchSglangServerInfo (the one optional enrichment fetch)", () => {
  const runOne = async (id: string) => {
    const v = vectorOf("sglang", id);
    const { fetchImpl, calls } = fakeFetch(v.fetch);
    const info = await fetchSglangServerInfo(v.input.origin as string, {
      fetchImpl,
      ...apiKeyOf(v.input),
      signal: signalOf(v.input),
    });
    assertExpect(info, v.expect, calls, v.id);
  };

  it("GETs {origin}/server_info and returns the parsed object", async () => {
    await runOne("serverInfo/get-and-parse");
  });

  it("C7: the apiKey rides it; no /get_server_info alias is probed (one fetch, fail-soft stop)", async () => {
    await runOne("serverInfo/c7-bearer-no-alias");
  });

  it("non-2xx / network failure / non-object body → undefined (never throws)", async () => {
    await runOne("serverInfo/5xx-fail-soft");
    await runOne("serverInfo/network-fail-soft");
    await runOne("serverInfo/broken-json-fail-soft");
    await runOne("serverInfo/array-body-fail-soft");
  });
});

describe("sglangRowsById (server-wide facts across entries, C4 replacement)", () => {
  const runOne = (id: string) => {
    const v = vectorOf("sglang", id);
    const byId = sglangRowsById(
      v.input.entries as OpenAIModelEntry[],
      v.input.modelInfo as SglangModelInfoResponse,
      v.input.serverInfo as SglangServerInfoResponse | undefined,
    );
    assertExpect(byId, v.expect, [], v.id);
  };

  it("applies the server-wide facts to EVERY entry; the entry's own max_model_len wins per entry", () => {
    runOne("rowsById/server-wide-across-entries");
  });

  it("every entry id is present even when nothing maps (undefined = enriched, nothing found)", () => {
    runOne("rowsById/enriched-nothing-undefined-values");
  });
});

describe("sglangBackend.metadataRows (the C4 facts contract over the fetch log)", () => {
  const runOne = async (id: string) => {
    const v = vectorOf("sglang", id);
    const { fetchImpl, calls } = fakeFetch(v.fetch);
    const rows = await sglangBackend.metadataRows(
      v.input.entries as OpenAIModelEntry[],
      {
        baseUrl: v.input.baseUrl as string,
        ...(apiKeyOf(v.input)),
        fetchImpl,
      },
      v.input.facts as Record<string, unknown> | undefined,
    );
    assertExpect(rows, v.expect, calls, v.id);
  };

  it("NEVER re-fetches /model_info — detection's facts carry the body (C4, fetch call log)", async () => {
    await runOne("enrich/never-refetch-model-info");
  });

  it("fetches /server_info ONLY when ≥1 entry lacks a positive max_model_len", async () => {
    await runOne("enrich/server-info-not-needed-silent");
    await runOne("enrich/server-info-needed-once");
  });

  it("a /server_info failure stops the chain at the entry value; reasoning/input still map (§5.5)", async () => {
    await runOne("enrich/server-info-failure-stops-chain");
  });

  it("missing/malformed facts.modelInfo → ALL-GENERIC (empty byId, zero fetches)", async () => {
    for (const v of vectorsOf("sglang", "sglang.enrich")) {
      if (v.id.startsWith("enrich/facts-")) {
        const { fetchImpl, calls } = fakeFetch(v.fetch);
        const rows = await sglangBackend.metadataRows(
          v.input.entries as OpenAIModelEntry[],
          { baseUrl: v.input.baseUrl as string, fetchImpl },
          v.input.facts as Record<string, unknown> | undefined,
        );
        assertExpect(rows, v.expect, calls, v.id);
      }
    }
  });

  it("the ctx apiKey rides the /server_info fetch (C7)", async () => {
    await runOne("enrich/c7-api-key-rides");
  });
});

const SGLANG_SECTION = {
  routes: [{ name: "sglang", baseURL: "http://127.0.0.1:30000/v1", models: null }],
  overrides: {},
};

function stubSglangFetch(config: {
  modelInfo?: (url: string) => Response;
  alias?: (url: string) => Response;
  serverInfo?: (url: string) => Response;
  models?: () => Response;
}) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/model_info")) {
      return config.modelInfo ? config.modelInfo(url) : new Response("nope", { status: 404 });
    }
    if (url.endsWith("/get_model_info")) {
      return config.alias ? config.alias(url) : new Response("nope", { status: 404 });
    }
    if (url.endsWith("/server_info")) {
      return config.serverInfo ? config.serverInfo(url) : new Response("nope", { status: 404 });
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

describe("discoverMetadata channel handler — the SGLang branch (pinned backends)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  const makeHandler = (
    log: (line: string) => void = () => undefined,
    backends: readonly DiscoveryBackend[] = [sglangBackend],
  ) => makeChannelHandler({ section: () => SGLANG_SECTION, log, backends });
  const call = (handler: ReturnType<typeof makeHandler>) =>
    handler("discoverMetadata", { provider: "sglang" }, new AbortController().signal) as Promise<WireResult>;

  it("an SGLang route builds its rows through the CACHED /model_info facts + one /server_info", async () => {
    const fetchImpl = stubSglangFetch({
      modelInfo: () => json(MODEL_INFO_FULL),
      serverInfo: () => json(SERVER_INFO),
      models: () => json({ object: "list", data: ENTRIES }),
    });
    vi.stubGlobal("fetch", fetchImpl);
    const result = await call(makeHandler());
    expect(result.ok).toBe(true);
    expect(result.value?.models).toEqual([
      {
        id: "qwen2.5-vl-7b",
        discoveredCanonical: {
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 32768,
        },
      },
      {
        id: "qwen25-7b-instruct",
        discoveredCanonical: {
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 262144,
        },
      },
    ]);
    const urls = fetchImpl.mock.calls.map(([url]) => String(url));
    // /model_info exactly once: detection only — metadataRows reads the facts, never re-fetches (C4).
    expect(urls.filter((u) => u.endsWith("/model_info"))).toHaveLength(1);
    // /server_info once: only the entry lacking max_model_len needed it.
    expect(urls.filter((u) => u.endsWith("/server_info"))).toHaveLength(1);
    expect(urls.some((u) => u.endsWith("/get_model_info"))).toBe(false);
  });

  it("the alias fallback works end-to-end and the ALIAS body is cached too (old servers)", async () => {
    const fetchImpl = stubSglangFetch({
      modelInfo: () => new Response("nope", { status: 404 }),
      alias: () => json(MODEL_INFO_FULL),
      serverInfo: () => json(SERVER_INFO),
      models: () => json({ object: "list", data: ENTRIES }),
    });
    vi.stubGlobal("fetch", fetchImpl);
    const result = await call(makeHandler());
    expect(result.ok).toBe(true);
    expect(result.value?.models?.[0]?.discoveredCanonical).toBeDefined();
    const urls = fetchImpl.mock.calls.map(([url]) => String(url));
    expect(urls.filter((u) => u.endsWith("/model_info"))).toHaveLength(1);
    // The alias answered detection ONCE and was cached — enrichment never
    // re-fetches either name (C4).
    expect(urls.filter((u) => u.endsWith("/get_model_info"))).toHaveLength(1);
    expect(urls.filter((u) => u.endsWith("/server_info"))).toHaveLength(1);
  });

  it("memoizes a DEFINITIVE detection per route: two calls, one /model_info (enrichment is per call)", async () => {
    const fetchImpl = stubSglangFetch({
      modelInfo: () => json(MODEL_INFO_FULL),
      serverInfo: () => json(SERVER_INFO),
      models: () => json({ object: "list", data: ENTRIES }),
    });
    vi.stubGlobal("fetch", fetchImpl);
    const handler = makeHandler();
    await call(handler);
    await call(handler);
    const urls = fetchImpl.mock.calls.map(([url]) => String(url));
    expect(urls.filter((u) => u.endsWith("/models"))).toHaveLength(1);
    expect(urls.filter((u) => u.endsWith("/model_info"))).toHaveLength(1);
    // metadataRows is NOT memoized (the same discipline as Ollama's show
    // batch): the second call re-runs the /server_info enrichment.
    expect(urls.filter((u) => u.endsWith("/server_info"))).toHaveLength(2);

    const negative = stubSglangFetch({
      models: () => json({ object: "list", data: ENTRIES }),
    });
    vi.stubGlobal("fetch", negative);
    const handler2 = makeHandler();
    await call(handler2);
    await call(handler2);
    expect(
      negative.mock.calls.filter(([url]) => String(url).endsWith("/model_info")),
    ).toHaveLength(1);
    expect(
      negative.mock.calls.filter(([url]) => String(url).endsWith("/get_model_info")),
    ).toHaveLength(1);
  });

  it("a non-SGLang origin keeps the generic rows and never fetches /server_info", async () => {
    const fetchImpl = stubSglangFetch({
      models: () => json({ object: "list", data: ENTRIES }),
    });
    vi.stubGlobal("fetch", fetchImpl);
    const result = await call(makeHandler());
    expect(result.ok).toBe(true);
    expect(result.value?.models).toEqual([
      { id: "qwen2.5-vl-7b" },
      { id: "qwen25-7b-instruct" },
    ]);
    const urls = fetchImpl.mock.calls.map(([url]) => String(url));
    expect(urls.some((u) => u.endsWith("/server_info"))).toBe(false);
    // Both names were probed once (the alias after the 404 — definitive no).
    expect(urls.filter((u) => u.endsWith("/model_info"))).toHaveLength(1);
    expect(urls.filter((u) => u.endsWith("/get_model_info"))).toHaveLength(1);
  });

  it("an INCONCLUSIVE /model_info probe silently keeps the generic path (never fails the endpoint)", async () => {
    const fetchImpl = stubSglangFetch({
      modelInfo: () => {
        throw new TypeError("fetch failed");
      },
      models: () => json({ object: "list", data: ENTRIES }),
    });
    vi.stubGlobal("fetch", fetchImpl);
    const result = await call(makeHandler());
    expect(result.ok).toBe(true);
    expect(result.value?.models).toEqual([{ id: "qwen2.5-vl-7b" }, { id: "qwen25-7b-instruct" }]);
    expect(
      fetchImpl.mock.calls.some(([url]) => String(url).endsWith("/server_info")),
    ).toBe(false);
  });

  it("a 0.4.x-era SGLang server maps only what it spells (no invented input/reasoning)", async () => {
    const fetchImpl = stubSglangFetch({
      modelInfo: () => json(MODEL_INFO_04X),
      serverInfo: () => json(SERVER_INFO),
      models: () => json({ object: "list", data: ENTRIES }),
    });
    vi.stubGlobal("fetch", fetchImpl);
    const result = await call(makeHandler());
    expect(result.ok).toBe(true);
    expect(result.value?.models).toEqual([
      { id: "qwen2.5-vl-7b", discoveredCanonical: { contextWindow: 32768 } },
      { id: "qwen25-7b-instruct", discoveredCanonical: { contextWindow: 262144 } },
    ]);
  });

  it("the route's apiKeyEnv rides every SGLang fetch (C7, end-to-end)", async () => {
    vi.stubEnv("SGLANG_API_KEY", "sekrit");
    const section = {
      routes: [
        {
          name: "sglang",
          baseURL: "http://127.0.0.1:30000/v1",
          apiKeyEnv: "SGLANG_API_KEY",
          models: null,
        },
      ],
      overrides: {},
    };
    const seenAuth: Array<string | undefined> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/models")) {
        return json({ object: "list", data: ENTRIES });
      }
      seenAuth.push((init?.headers as Record<string, string> | undefined)?.Authorization);
      if (url.endsWith("/model_info")) return json(MODEL_INFO_FULL);
      return json(SERVER_INFO);
    });
    vi.stubGlobal("fetch", fetchImpl);
    const handler = makeChannelHandler({
      section: () => section,
      log: () => undefined,
      backends: [sglangBackend],
    });
    const result = await handler(
      "discoverMetadata",
      { provider: "sglang" },
      new AbortController().signal,
    ) as WireResult;
    expect(result.ok).toBe(true);
    expect(seenAuth).toEqual(["Bearer sekrit", "Bearer sekrit"]);
  });

  it("C9: SGLang is probed BEFORE Ollama — a SGLang origin is claimed by SGLang, not the Ollama shim (§5.8)", async () => {
    // The C9 pair: an SGLang server that ALSO answers /api/version (Ollama-compat surface)
    // must be enriched by SGLang — pre-seam it got degraded Ollama-shaped rows (regression fix).
    const fetchImpl = stubSglangFetch({
      modelInfo: () => json(MODEL_INFO_FULL),
      serverInfo: () => json(SERVER_INFO),
      models: () => json({ object: "list", data: ENTRIES }),
    });
    vi.stubGlobal("fetch", fetchImpl);
    const result = await call(
      makeHandler(() => undefined, [sglangBackend, ollamaBackend]),
    );
    expect(result.ok).toBe(true);
    const models = result.value?.models ?? [];
    // SGLang-shaped rows (parser-derived reasoning, NO thinkingLevelMap —
    // never the Ollama family table).
    expect(models[0]).toEqual({
      id: "qwen2.5-vl-7b",
      discoveredCanonical: {
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 32768,
      },
    });
    expect(
      models.every((m) => "thinkingLevelMap" in (m.discoveredCanonical as object)) === false,
    ).toBe(true);
    const urls = fetchImpl.mock.calls.map(([url]) => String(url));
    expect(urls.some((u) => u.endsWith("/api/version"))).toBe(false);
    expect(urls.some((u) => u.endsWith("/api/show"))).toBe(false);
  });
});

const LIVE_ORIGIN = "http://localhost:30000";
const LIVE_PROBE_TIMEOUT_MS = 2_500;

/** Skipped cleanly unless localhost:30000 answers /model_info with the
 *  SGLang shape; the suite is never red without the server. */
const liveModelInfo: SglangModelInfoResponse | undefined = await probeSglangModelInfo(LIVE_ORIGIN, {
  signal: AbortSignal.timeout(LIVE_PROBE_TIMEOUT_MS),
})
  .then((probe) => (probe.isSglang ? probe.modelInfo : undefined))
  .catch(() => undefined);

describe.skipIf(liveModelInfo === undefined)("Live E2E — detection (read-only)", () => {
  it("the local server answers /model_info with the SGLang gate markers", () => {
    const modelPath = liveModelInfo?.model_path;
    const served = liveModelInfo?.served_model_name;
    const hasMarker =
      (typeof modelPath === "string" && modelPath.length > 0) ||
      (typeof served === "string" && served.length > 0);
    expect(hasMarker).toBe(true);
  });
});

describe.skipIf(liveModelInfo === undefined)("Live E2E — the real catalog maps (read-only)", () => {
  it("enriches /v1/models through the backend without ever emitting the C5-forbidden fields", async () => {
    const response = await fetch(`${LIVE_ORIGIN}/v1/models`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    expect(response.ok).toBe(true);
    const payload = (await response.json()) as { data?: OpenAIModelEntry[] };
    const entries = payload.data ?? [];
    expect(entries.length).toBeGreaterThan(0);
    const rows = await sglangBackend.metadataRows(
      entries,
      { baseUrl: `${LIVE_ORIGIN}/v1`, signal: AbortSignal.timeout(10_000) },
      { modelInfo: liveModelInfo as SglangModelInfoResponse },
    );
    expect(rows.byId.size).toBe(entries.length);
    for (const canonical of rows.byId.values()) {
      if (canonical === undefined) continue;
      expect("maxTokens" in (canonical as object)).toBe(false);
      expect("compat" in (canonical as object)).toBe(false);
      expect("thinkingLevelMap" in (canonical as object)).toBe(false);
      if (canonical.contextWindow !== undefined) {
        expect(canonical.contextWindow).toBeGreaterThan(0);
        expect(Number.isInteger(canonical.contextWindow)).toBe(true);
      }
      if (canonical.input !== undefined) {
        expect(canonical.input[0]).toBe("text");
      }
    }
  });
});