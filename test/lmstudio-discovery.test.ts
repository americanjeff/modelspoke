import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import { makeChannelHandler } from "../src/dsh/channel.js";
import {
  discoveryBackends,
  ollamaBackend,
} from "../src/discovery/backends.js";
import {
  fetchLmStudioModels,
  lmStudioModelToCanonical,
  lmStudioModelsPayload,
  lmStudioThinkingLevelMap,
  lmstudioBackend,
  lmstudioOrigin,
} from "../src/discovery/lmstudio.js";
import type { LmStudioModel } from "../src/discovery/lmstudio.js";
import type { OpenAIModelEntry } from "../src/discovery/types.js";
import type { DiscoveryContext } from "../src/discovery/backends.js";
import {
  apiKeyOf,
  assertExpect,
  fakeFetch,
  fixtureOf,
  pinOf,
  signalOf,
  vectorOf,
  vectorsOf,
} from "./discovery-corpus.js";

const MODEL_GEMMA_TOGGLE = fixtureOf<LmStudioModel>("lmstudio", "MODEL_GEMMA_TOGGLE");
const MODEL_QWEN_GRADED = fixtureOf<LmStudioModel>("lmstudio", "MODEL_QWEN_GRADED");
const MODEL_EMBEDDINGS = fixtureOf<LmStudioModel>("lmstudio", "MODEL_EMBEDDINGS");
const V1_MODELS = fixtureOf<LmStudioModel[]>("lmstudio", "V1_MODELS");
const V1_LIST_BODY = fixtureOf<{ models: LmStudioModel[] }>("lmstudio", "V1_LIST_BODY");
const CATALOG_ENTRIES = fixtureOf<OpenAIModelEntry[]>("lmstudio", "CATALOG_ENTRIES");
const OFF_ONLY_TOGGLE_MAP = fixtureOf<Record<string, unknown>>("lmstudio", "OFF_ONLY_TOGGLE_MAP");
const FULL_GRADED_MAP = fixtureOf<Record<string, unknown>>("lmstudio", "FULL_GRADED_MAP");

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("lmStudioThinkingLevelMap (built ONLY from allowed_options)", () => {
  function run(id: string) {
    const v = vectorOf("lmstudio", id);
    const map = lmStudioThinkingLevelMap(v.input.allowedOptions as unknown);
    assertExpect(map, v.expect, [], v.id);
  }

  it("pins the documented toggle dialect [\"off\",\"on\"] verbatim (off present, no on-level — emitted anyway)", () => {
    // The gemma-4 docs shape: the harness can disable thinking; enabling
    // falls back to the server default. The all-null-forbidden rule (C5)
    // applies to on-levels, not to the off entry.
    run("levelMap/toggle-dialect");
  });

  it("pins the full graded vocabulary 1:1 (low/medium/high listed, the rest null)", () => {
    run("levelMap/graded-full");
    run("levelMap/graded-order-irrelevant");
  });

  it("lists exactly the enumerated levels — a partial list nulls the others", () => {
    run("levelMap/partial-off-high");
    run("levelMap/partial-on-low");
  });

  it("an on-level without off is emitted (graded, but thinking cannot be disabled)", () => {
    run("levelMap/no-off-graded");
  });

  it("never invents a level: unknown option strings are ignored", () => {
    run("levelMap/unknown-strings-ignored");
    run("levelMap/only-unknown-undefined");
  });

  it("an all-null map (no off entry, no on-level) is FORBIDDEN (C5) — undefined", () => {
    run("levelMap/all-null-on-only");
    run("levelMap/all-null-empty");
  });

  it("fail-soft: non-array and non-string options yield no map", () => {
    run("levelMap/non-array-undefined-input");
    run("levelMap/non-array-string");
    run("levelMap/non-array-number");
    run("levelMap/non-array-mixed-junk");
  });
});

describe("lmStudioModelToCanonical (the locked §3.3 mapping)", () => {
  function run(id: string) {
    const v = vectorOf("lmstudio", id);
    const canonical = lmStudioModelToCanonical(v.input.model as LmStudioModel);
    assertExpect(canonical, v.expect, [], v.id);
  }

  it("maps the documented toggle model: reasoning + input + as-loaded ctx + the off-only map", () => {
    run("mapModel/toggle-full");
  });

  it("maps the graded model: 1:1 levels, [text] input (vision false), model-max ctx when not loaded", () => {
    run("mapModel/graded-full");
  });

  it("prefers the as-loaded context over the model max, and falls back when the loaded one is unusable", () => {
    run("mapModel/partial-loaded-ctx-wins");
    for (const v of vectorsOf("lmstudio", "lmstudio.mapModel")) {
      if (v.id.startsWith("mapModel/loaded-bad-")) run(v.id);
    }
    run("mapModel/ctx-absent-both-omitted");
  });

  it("coerces a digit-string context and drops non-positive/non-integer values (through toPositiveInt)", () => {
    run("mapModel/coerce-digit-string-max");
    for (const v of vectorsOf("lmstudio", "lmstudio.mapModel")) {
      if (v.id.startsWith("mapModel/coerce-bad-")) run(v.id);
    }
  });

  it("input: vision true → [text,image], false → [text], absent/non-boolean → omitted", () => {
    run("mapModel/vision-true");
    run("mapModel/vision-false");
    run("mapModel/vision-absent");
    run("mapModel/vision-non-boolean");
    run("mapModel/vision-no-capabilities");
  });

  it("reasoning requires capabilities.reasoning to be an object with a NON-EMPTY allowed_options array", () => {
    run("mapModel/reasoning-with-options");
    run("mapModel/reasoning-empty-options");
    for (const v of vectorsOf("lmstudio", "lmstudio.mapModel")) {
      if (v.id.startsWith("mapModel/reasoning-malformed-")) run(v.id);
    }
    run("mapModel/reasoning-embeddings-absent");
  });

  it("never emits maxTokens or compat (C5), however much the element carries", () => {
    run("mapModel/never-emits-decoys");
  });

  it("never emits display-only fields (no canonical field exists — C5)", () => {
    run("mapModel/never-emits-display-only");
  });

  it("an element with nothing usable maps to an EMPTY canonical (the byId value becomes undefined)", () => {
    run("mapModel/embeddings-empty-canonical");
    run("mapModel/garbage-shapes-empty");
  });
});

describe("lmstudioOrigin", () => {
  function run(id: string) {
    const v = vectorOf("lmstudio", id);
    expect(lmstudioOrigin(v.input.base as string), v.id).toBe(v.expect.eq as string);
  }

  it("strips the trailing /v1 from a normalized route base", () => {
    run("origin/strips-trailing-v1");
    run("origin/strips-trailing-v1-slash");
    run("origin/strips-only-one-v1");
  });

  it("defensively passes a base that does not end in /v1 through (slash-stripped)", () => {
    run("origin/no-v1-passes-through");
    run("origin/no-v1-slash-stripped");
  });
});

describe("fetchLmStudioModels (§3.1 detection, C7/C10)", () => {
  async function runOne(id: string) {
    const v = vectorOf("lmstudio", id);
    const { fetchImpl, calls } = fakeFetch(v.fetch);
    const probe = await fetchLmStudioModels(v.input.origin as string, {
      fetchImpl,
      ...apiKeyOf(v.input),
      signal: signalOf(v.input),
    });
    assertExpect(probe, v.expect, calls, v.id);
  }

  it("GETs {origin}/api/v1/models and accepts the wrapped keyed-models shape", async () => {
    await runOne("probeModels/get-and-parse");
  });

  it("sends the route's apiKey as a Bearer header when set (C7), none when absent", async () => {
    await runOne("probeModels/c7-bearer");
    await runOne("probeModels/c7-no-key");
  });

  it("rejects wrong shapes as a DEFINITIVE non-match (the wrap + keyed-element gate)", async () => {
    for (const v of vectorsOf("lmstudio", "lmstudio.probeModels")) {
      if (v.id.startsWith("probeModels/shape-")) await runOne(v.id);
    }
  });

  it("non-JSON 200 answers are a definitive non-match", async () => {
    await runOne("probeModels/non-json-200");
  });

  it("404/405 (pre-0.4.0 v0-only servers) and 401 are a DEFINITIVE non-match (C10)", async () => {
    await runOne("probeModels/401-definitive");
    await runOne("probeModels/404-definitive");
    await runOne("probeModels/405-definitive");
  });

  it("5xx and unlisted statuses are INCONCLUSIVE (no answer is not evidence)", async () => {
    await runOne("probeModels/5xx-inconclusive-500");
    await runOne("probeModels/5xx-inconclusive-502");
    await runOne("probeModels/5xx-inconclusive-503");
    await runOne("probeModels/unlisted-inconclusive-403");
    await runOne("probeModels/unlisted-inconclusive-418");
  });

  it("a network failure is an INCONCLUSIVE non-match (retriable)", async () => {
    await runOne("probeModels/network-inconclusive");
  });

  it("never throws, even when fetchImpl rejects with an abort", async () => {
    await runOne("probeModels/abort-inconclusive");
  });
});

describe("lmStudioModelsPayload (the shape gate, unit-tested)", () => {
  function run(id: string) {
    const v = vectorOf("lmstudio", id);
    const payload = lmStudioModelsPayload(v.input.payload);
    assertExpect(payload, v.expect, [], v.id);
  }

  it("returns the raw element array only for the wrapped keyed shape", () => {
    run("payload/wrapped-keyed-shape");
    run("payload/mixed-elements-pass-through");
    run("payloadGate/empty-models-array");
    run("payloadGate/openai-wrapper-undefined");
    run("payloadGate/null-payload");
  });
});

describe("lmstudioBackend.detect (verdict mapping)", () => {
  async function runOne(id: string) {
    const v = vectorOf("lmstudio", id);
    const { fetchImpl, calls } = fakeFetch(v.fetch);
    const verdict = await lmstudioBackend.detect({
      baseUrl: v.input.baseUrl as string,
      entries: v.input.entries as OpenAIModelEntry[],
      ...apiKeyOf(v.input),
      fetchImpl,
    });
    assertExpect(verdict, v.expect, calls, v.id);
  }

  it("a matching shape → match with the parsed elements as facts (the §3.2 cache)", async () => {
    await runOne("detectVerdict/match-with-facts");
  });

  it("a definitive non-match (404/405/401/wrong shape) → { match: false }", async () => {
    await runOne("detectVerdict/404-definitive");
    await runOne("detectVerdict/wrong-shape-definitive");
  });

  it("a network failure / abort → { match: false, inconclusive: true }", async () => {
    await runOne("detectVerdict/network-inconclusive");
  });

  it("the route's apiKey rides the detection probe (C7)", async () => {
    await runOne("detectVerdict/c7-bearer");
  });
});

describe("lmstudioBackend.metadataRows (the §3.2 same-response join)", () => {
  async function runOne(id: string): Promise<void> {
    const v = vectorOf("lmstudio", id);
    const { fetchImpl, calls } = fakeFetch(v.fetch);
    const rows = await lmstudioBackend.metadataRows(
      v.input.entries as OpenAIModelEntry[],
      {
        baseUrl: v.input.baseUrl as string,
        entries: v.input.entries as OpenAIModelEntry[],
        ...apiKeyOf(v.input),
        fetchImpl,
      },
      v.input.facts as Record<string, unknown> | undefined,
    );
    assertExpect(rows, v.expect, calls, v.id);
  }

  it("joins by key === entry.id with ZERO extra fetches when the facts cache rides)", async () => {
    await runOne("enrich/join-facts-cache-zero-fetches");
  });

  it("a catalog id with no matching model element stays ABSENT (the generic row survives)", async () => {
    await runOne("enrich/no-matching-element-absent");
  });

  it("a malformed element cannot be joined — that id stays generic", async () => {
    await runOne("enrich/malformed-element-stays-generic");
  });

  it("without a facts cache it re-fetches the same URL ONCE (the defensive direct-call path)", async () => {
    await runOne("enrich/refetch-once-without-facts");
  });

  it("fail-soft: a failed/aborted re-fetch (or a non-matching answer) → { byId: new Map() }, never throws", async () => {
    await runOne("enrich/fail-soft-network");
    await runOne("enrich/fail-soft-404");
    await runOne("enrich/fail-soft-empty-models");
  });

  it("the re-fetch honors the caller's signal and apiKey (C7)", async () => {
    const controller = new AbortController();
    const v = vectorOf("lmstudio", "enrich/refetch-signal-and-key");
    const { fetchImpl, calls } = fakeFetch(v.fetch);
    await lmstudioBackend.metadataRows(
      v.input.entries as OpenAIModelEntry[],
      {
        baseUrl: v.input.baseUrl as string,
        ...apiKeyOf(v.input),
        signal: controller.signal,
        fetchImpl,
      },
      undefined,
    );
    assertExpect(undefined, v.expect, calls, v.id);
  });
});

const LMSTUDIO_SECTION = {
  routes: [{ name: "lmstudio", baseURL: "http://127.0.0.1:1234/v1", models: null }],
  overrides: {},
};

/** A minimal fake Context (the channel handler only ctx.get()s services). */
function fakeCtx(): Context {
  return { get: () => undefined, on: () => () => undefined } as unknown as Context;
}

/** ORDER MATTERS: the v1 probe URL (`/api/v1/models`) also ends with `/models` — the v1 check must come first. */
function stubLmStudioFetch(config: {
  v1Models?: () => Response;
  catalog?: () => Response;
}) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/api/v1/models")) {
      return config.v1Models ? config.v1Models() : new Response("nope", { status: 404 });
    }
    if (url.endsWith("/models")) {
      return config.catalog ? config.catalog() : new Response("nope", { status: 404 });
    }
    return new Response("nope", { status: 404 });
  });
}

type WireResult = {
  ok: boolean;
  value?: { models: Array<{ id: string; name?: string; discoveredCanonical?: unknown }> };
  error?: { code: string; message: string };
};

describe("discoverMetadata channel handler — the LM Studio branch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // C3: the backends list is PINNED to this backend alone — the fetch-count
  // assertions here stay stable as the registry grows.
  const makeHandler = (log: (line: string) => void = () => undefined) =>
    makeChannelHandler(fakeCtx(), {
      section: () => LMSTUDIO_SECTION,
      log,
      backends: [lmstudioBackend],
    });
  const call = (handler: ReturnType<typeof makeHandler>) =>
    handler("discoverMetadata", { provider: "lmstudio" }, new AbortController().signal) as Promise<WireResult>;

  it("an LM Studio route enriches through ONE /api/v1/models fetch total (detect + enrich share the response)", async () => {
    const fetchImpl = stubLmStudioFetch({
      v1Models: () => json(V1_LIST_BODY),
      catalog: () => json({ object: "list", data: CATALOG_ENTRIES }),
    });
    vi.stubGlobal("fetch", fetchImpl);
    const result = await call(makeHandler());
    expect(result.ok).toBe(true);
    const models = result.value?.models ?? [];
    expect(models).toEqual([
      {
        id: "google/gemma-4-26b-a4b",
        discoveredCanonical: {
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 4096,
          thinkingLevelMap: OFF_ONLY_TOGGLE_MAP,
        },
      },
      {
        id: "qwen/qwen3.8-27b",
        discoveredCanonical: {
          reasoning: true,
          input: ["text"],
          contextWindow: 262144,
          thinkingLevelMap: FULL_GRADED_MAP,
        },
      },
      { id: "text-embedding-nomic-embed" }, // enriched, nothing found → no canonical
    ]);
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/api/v1/models"))).toHaveLength(1);
    // /api/v1/models (the probe) ALSO ends in /v1/models — exclude it, so
    // this counts the CATALOG fetch only.
    expect(
      fetchImpl.mock.calls.filter(
        ([url]) => String(url).endsWith("/v1/models") && !String(url).endsWith("/api/v1/models"),
      ),
    ).toHaveLength(1);
  });

  it("memoizes the DEFINITIVE detection per route: two calls, one /api/v1/models probe", async () => {
    const fetchImpl = stubLmStudioFetch({
      v1Models: () => json(V1_LIST_BODY),
      catalog: () => json({ object: "list", data: CATALOG_ENTRIES }),
    });
    vi.stubGlobal("fetch", fetchImpl);
    const handler = makeHandler();
    await call(handler);
    await call(handler);
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/api/v1/models"))).toHaveLength(1);
    // /api/v1/models (the probe) ALSO ends in /v1/models — exclude it, so
    // this counts the CATALOG fetch only.
    expect(
      fetchImpl.mock.calls.filter(
        ([url]) => String(url).endsWith("/v1/models") && !String(url).endsWith("/api/v1/models"),
      ),
    ).toHaveLength(1);
  });

  it("a non-LM-Studio origin (404 on the v1 probe) keeps the generic rows, definitively memoized", async () => {
    const fetchImpl = stubLmStudioFetch({
      catalog: () => json({ object: "list", data: CATALOG_ENTRIES }),
    });
    vi.stubGlobal("fetch", fetchImpl);
    const handler = makeHandler();
    const result = await call(handler);
    expect(result.ok).toBe(true);
    expect(result.value?.models).toEqual(CATALOG_ENTRIES.map((entry) => ({ id: entry.id })));
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/api/v1/models"))).toHaveLength(1);
    await call(handler);
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/api/v1/models"))).toHaveLength(1);
  });

  it("an INCONCLUSIVE v1 probe is retried on the next call (never fails the endpoint)", async () => {
    const fetchImpl = stubLmStudioFetch({
      v1Models: () => {
        throw new TypeError("fetch failed");
      },
      catalog: () => json({ object: "list", data: CATALOG_ENTRIES }),
    });
    vi.stubGlobal("fetch", fetchImpl);
    const handler = makeHandler();
    const first = await call(handler);
    expect(first.ok).toBe(true);
    expect(first.value?.models).toEqual(CATALOG_ENTRIES.map((entry) => ({ id: entry.id })));
    await call(handler);
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/api/v1/models"))).toHaveLength(2);
  });

  it("a malformed element keeps that id generic; the joined ids are unaffected", async () => {
    const fetchImpl = stubLmStudioFetch({
      v1Models: () => json({ models: [MODEL_GEMMA_TOGGLE, { key: 42 }, "broken"] }),
      catalog: () => json({ object: "list", data: CATALOG_ENTRIES }),
    });
    vi.stubGlobal("fetch", fetchImpl);
    const result = await call(makeHandler());
    expect(result.ok).toBe(true);
    const models = result.value?.models ?? [];
    expect(models[0]?.discoveredCanonical).toBeDefined();
    expect(models[1]).toEqual({ id: "qwen/qwen3.8-27b" });
    expect(models[2]).toEqual({ id: "text-embedding-nomic-embed" });
  });

  it("an enriched-but-nothing element REPLACES the generic canonical with nothing (C4 full replacement)", async () => {
    // The catalog entry carries a generic context_length; the joined v1
    // element carries nothing usable → the row must keep NO canonical.
    const entries: OpenAIModelEntry[] = [
      { id: "text-embedding-nomic-embed", object: "model", created: 1, context_length: 8192, owned_by: "lmstudio" },
    ];
    const fetchImpl = stubLmStudioFetch({
      v1Models: () => json({ models: [MODEL_EMBEDDINGS] }),
      catalog: () => json({ object: "list", data: entries }),
    });
    vi.stubGlobal("fetch", fetchImpl);
    const result = await call(makeHandler());
    expect(result.ok).toBe(true);
    expect(result.value?.models).toEqual([{ id: "text-embedding-nomic-embed" }]);
  });
});

describe("the registry entry (two lines in backends.ts)", () => {
  it("lmstudio rides DIRECTLY AFTER ollama (the locked relative order, C9)", () => {
    const ollamaAt = discoveryBackends.indexOf(ollamaBackend);
    const lmstudioAt = discoveryBackends.indexOf(lmstudioBackend);
    expect(ollamaAt).toBeGreaterThanOrEqual(0);
    expect(lmstudioAt).toBe(ollamaAt + 1);
  });

  it("the backend id is 'lmstudio' (the detection memo key)", () => {
    expect(lmstudioBackend.id).toBe(pinOf("lmstudio", "backendId"));
  });
});

const LIVE_ORIGIN = "http://localhost:1234";
const LIVE_PROBE_TIMEOUT_MS = 2_500;

/** Skipped cleanly unless localhost:1234 answers /api/v1/models with the v1
 *  shape (LM Studio 0.4.0+); the suite is never red without it. */
const liveModels: unknown[] | undefined = await fetchLmStudioModels(LIVE_ORIGIN, {
  signal: AbortSignal.timeout(LIVE_PROBE_TIMEOUT_MS),
})
  .then((probe) => (probe.isLmStudio ? probe.models : undefined))
  .catch(() => undefined);

describe.skipIf(liveModels === undefined)("Live E2E — real LM Studio (read-only)", () => {
  it("the local server answers /api/v1/models with the wrapped keyed shape", () => {
    expect(liveModels?.length).toBeGreaterThan(0);
  });

  it("enriches the served catalog fail-soft from the SAME response (no maxTokens/compat ever)", async () => {
    const keys = (liveModels as unknown[])
      .map((element) => (typeof element === "object" && element !== null && "key" in element ? (element as { key: unknown }).key : undefined))
      .filter((key): key is string => typeof key === "string");
    const entries: OpenAIModelEntry[] = keys.map((id) => ({
      id,
      object: "model",
      created: 0,
      owned_by: "lmstudio",
    }));
    const { byId } = await lmstudioBackend.metadataRows(
      entries,
      { baseUrl: `${LIVE_ORIGIN}/v1`, entries },
      { models: liveModels as unknown[] },
    );
    expect(byId.size).toBe(keys.length);
    for (const [id, canonical] of byId) {
      expect(keys).toContain(id);
      if (canonical === undefined) continue;
      expect("maxTokens" in canonical).toBe(false);
      expect("compat" in canonical).toBe(false);
      if (canonical.contextWindow !== undefined) {
        expect(Number.isInteger(canonical.contextWindow)).toBe(true);
        expect(canonical.contextWindow).toBeGreaterThan(0);
      }
      if (canonical.input !== undefined) {
        // This backend spells input exactly two ways.
        expect([["text", "image"], ["text"]]).toContainEqual(canonical.input);
      }
      if (canonical.reasoning === true) {
        // The map rides whenever the enumerated options yield a usable one.
        if (canonical.thinkingLevelMap !== undefined) {
          expect(Object.values(canonical.thinkingLevelMap).some((v) => v !== null)).toBe(true);
        }
      }
    }
  });
});