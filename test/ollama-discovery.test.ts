import { afterEach, describe, expect, it, vi } from "vitest";
import { makeChannelHandler } from "../src/dsh/channel.js";
import {
  isVersionGated as gateOf,
  ollamaMetadataRows,
  ollamaModelfileParser,
  ollamaOrigin,
  ollamaShow,
  ollamaShowBatch,
  ollamaShowToCanonical,
  ollamaThinkingLevelMapFor,
  OLLAMA_CLOUD_DEEPSEEK_MAP,
  OLLAMA_CLOUD_GLM_MAP,
  OLLAMA_DEEPSEEK3_MAP,
  OLLAMA_GEMMA4_MAP,
  OLLAMA_GPT_OSS_MAP,
  OLLAMA_QWEN35_MAP,
  probeOllamaVersion,
} from "../src/discovery/index.js";
import { ollamaBackend } from "../src/discovery/ollama.js";
import type { OllamaShowResponse } from "../src/discovery/index.js";
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

/** gemma4:e4b — local GGUF, regime 2: placeholder template, PARSER gemma4. */
const SHOW_GEMMA4_E4B = fixtureOf<OllamaShowResponse>("ollama", "SHOW_GEMMA4_E4B");

/** qwen3-coder-200k:latest — local GGUF, PARSER qwen3-coder (NOT in the table). */
const SHOW_QWEN3CODER = fixtureOf<OllamaShowResponse>("ollama", "SHOW_QWEN3CODER");

/** glm-5.2:cloud — stub manifest: no modelfile/template/parameters/license. */
const SHOW_GLM_CLOUD = fixtureOf<OllamaShowResponse>("ollama", "SHOW_GLM_CLOUD");

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("ollama-families: the decision-5 table (pinned verbatim)", () => {
  it("pins gemma4 (boolean-only renderer, all on-levels → the same intensity)", () => {
    expect(OLLAMA_GEMMA4_MAP).toEqual(fixtureOf("ollama", "GEMMA4_MAP"));
  });

  it("pins deepseek3 (same shape as gemma4 — boolean-only, source-verified)", () => {
    expect(OLLAMA_DEEPSEEK3_MAP).toEqual(fixtureOf("ollama", "DEEPSEEK3_MAP"));
  });

  it("pins qwen3.5/qwen3.8 (the graded qwen35 renderer; xhigh→max mirrors the compat clamp)", () => {
    expect(OLLAMA_QWEN35_MAP).toEqual(fixtureOf("ollama", "QWEN35_MAP"));
  });

  it("pins gpt-oss (harmony: trace cannot be disabled, max folds to high server-side)", () => {
    expect(OLLAMA_GPT_OSS_MAP).toEqual(fixtureOf("ollama", "GPT_OSS_MAP"));
  });

  it("pins cloud glm* (the live-verified glm-5.2:cloud config, note §2.5)", () => {
    expect(OLLAMA_CLOUD_GLM_MAP).toEqual(fixtureOf("ollama", "CLOUD_GLM_MAP"));
  });

  it("pins cloud deepseek* (all-null: even think:false is silently ignored, note §2.1)", () => {
    expect(OLLAMA_CLOUD_DEEPSEEK_MAP).toEqual(fixtureOf("ollama", "CLOUD_DEEPSEEK_MAP"));
  });
});

describe("ollamaThinkingLevelMapFor (parser → family → cloud lookup)", () => {
  function run(id: string) {
    const v = vectorOf("ollama", id);
    const map = ollamaThinkingLevelMapFor(v.input as { parser?: string; family?: string; isCloud: boolean });
    assertExpect(map, v.expect, [], v.id);
  }

  it("keys the modelfile PARSER name", () => {
    run("familyLookup/parser-gemma4");
    run("familyLookup/parser-deepseek3");
    run("familyLookup/parser-qwen35");
    run("familyLookup/parser-qwen38");
    run("familyLookup/parser-gpt-oss");
    // §2.4 spells the harmony family heuristic both ways.
    run("familyLookup/parser-gptoss-spelled-both-ways");
  });

  it("falls back to details.family when the modelfile has no PARSER line", () => {
    run("familyLookup/family-fallback-gemma4");
    run("familyLookup/family-fallback-gptoss");
    run("familyLookup/family-fallback-gpt-oss");
  });

  it("prefers the parser over the family", () => {
    run("familyLookup/parser-over-family");
  });

  it("omits the map for unknown parsers/families (incl. every legacy Go-template family)", () => {
    run("familyLookup/unknown-qwen3-coder");
    run("familyLookup/unknown-kimi");
    run("familyLookup/unknown-llama");
    run("familyLookup/unknown-gemma3");
    run("familyLookup/unknown-absent");
  });

  it("keys the cloud entries on cloud provenance + family prefix", () => {
    run("familyLookup/cloud-glm");
    run("familyLookup/cloud-glm52");
    run("familyLookup/cloud-glm5-next");
    run("familyLookup/cloud-deepseek4");
    run("familyLookup/cloud-deepseek-prefix");
  });

  it("omits the map for unlisted cloud families — the local table does NOT leak into cloud", () => {
    // qwen3.5:cloud: family matches the LOCAL graded entry, but cloud models
    // render server-side — only the cloud entries are consulted (decision 5).
    run("familyLookup/cloud-unlisted-local-family");
    run("familyLookup/cloud-unlisted-parser-wins-not");
    run("familyLookup/cloud-unlisted-kimi-k3");
    run("familyLookup/cloud-unlisted-minimax");
    run("familyLookup/cloud-absent-family");
  });
});

describe("ollamaShowToCanonical (decision 4)", () => {
  function run(id: string) {
    const v = vectorOf("ollama", id);
    const mapping = ollamaShowToCanonical(
      v.input.id as string,
      v.input.show as OllamaShowResponse,
      v.input.serverVersion !== undefined ? { serverVersion: v.input.serverVersion as string } : undefined,
    );
    assertExpect(mapping, v.expect, [], v.id);
  }

  it("maps the full local thinking model (gemma4:e4b shape): reasoning + input + ctx + family map", () => {
    run("showToCanonical/full-local-thinking");
  });

  it("never emits maxTokens or compat (decision 4), however much the show carries", () => {
    run("showToCanonical/never-emits-decoys");
  });

  it("a non-thinking model (no thinking capability) carries no reasoning flag and no map", () => {
    run("showToCanonical/non-thinking");
  });

  it("no vision ⇒ no input field (absent, not [text])", () => {
    run("showToCanonical/no-vision-no-input");
  });

  it("coerces a digit-string context_length and drops non-positive/non-integer values", () => {
    run("showToCanonical/coerce-digit-string-ctx");
    for (const v of vectorsOf("ollama", "ollama.showToCanonical")) {
      if (v.id.startsWith("showToCanonical/coerce-bad-")) run(v.id);
    }
  });

  it("a model that spells no family gets no contextWindow (no invented prefix matching)", () => {
    run("showToCanonical/no-family-no-ctx");
  });

  it("fail-soft: missing/malformed capabilities, details, and model_info degrade per field", () => {
    run("showToCanonical/fail-soft-empty-show");
    run("showToCanonical/fail-soft-string-capabilities");
    run("showToCanonical/fail-soft-junk-degrades-per-field");
  });

  it("parses the modelfile PARSER line (case-insensitive, tolerant of surrounding lines)", () => {
    for (const v of vectorsOf("ollama", "ollama.modelfileParser")) {
      assertExpect(ollamaModelfileParser(v.input.show as OllamaShowResponse), v.expect, [], v.id);
    }
  });

  it("emits the family map only for thinking-capable models (the server's own think gate)", () => {
    // A gemma4-family model whose capabilities lack thinking (the
    // gemma4-no-thinking parser shape, note §2.4): the server would 400 the
    // think params, so no level map is emitted even though the family is known.
    run("showToCanonical/think-gate-no-map");
  });
});

describe("ollamaShowToCanonical: cloud vs local (decision 2/5/6)", () => {
  function run(id: string) {
    const v = vectorOf("ollama", id);
    const mapping = ollamaShowToCanonical(
      v.input.id as string,
      v.input.show as OllamaShowResponse,
      v.input.serverVersion !== undefined ? { serverVersion: v.input.serverVersion as string } : undefined,
    );
    assertExpect(mapping, v.expect, [], v.id);
  }

  it("cloud glm (id suffix :cloud): cloud table + capabilities + context", () => {
    run("showToCanonical/cloud-glm-suffix");
  });

  it("cloud provenance via details.remote_host (no :cloud suffix) also keys the cloud table", () => {
    run("showToCanonical/cloud-remote-host-provenance");
  });

  it("cloud deepseek: the all-null map + reasoning true", () => {
    run("showToCanonical/cloud-deepseek-all-null");
  });

  it("an unlisted cloud family gets no map (even when the family matches a local entry)", () => {
    run("showToCanonical/cloud-unlisted-family");
  });

  it("a '-cloud' id suffix is NOT cloud provenance (only ':cloud' is)", () => {
    // gemma4:31b-cloud is locally re-manifested (no remote_host, no modelfile):
    // the FAMILY fallback applies, not the cloud table.
    run("showToCanonical/dash-cloud-suffix-is-local");
  });
});

describe("ollamaShowToCanonical: the decision-7 version gate", () => {
  function run(id: string) {
    const v = vectorOf("ollama", id);
    const mapping = ollamaShowToCanonical(
      v.input.id as string,
      v.input.show as OllamaShowResponse,
      v.input.serverVersion !== undefined ? { serverVersion: v.input.serverVersion as string } : undefined,
    );
    assertExpect(mapping, v.expect, [], v.id);
  }

  it("server < requires: capability fields ride, the family map is skipped, gated is set", () => {
    run("showToCanonical/gate-below-requires");
  });

  it("server ≥ requires (or no requires): the map rides and gated is unset", () => {
    run("showToCanonical/gate-at-or-above");
    run("showToCanonical/gate-no-requires");
  });
});

describe("isVersionGated (dotted-numeric compare)", () => {
  function run(id: string) {
    const v = vectorOf("ollama", id);
    expect(gateOf(v.input.requires, v.input.serverVersion), v.id).toBe(v.expect.eq as boolean);
  }

  it("gates only when the server is strictly below requires", () => {
    run("versionGate/below-server");
    run("versionGate/equal");
    run("versionGate/patch-above");
    run("versionGate/below-patch");
    run("versionGate/below-patch-2");
    run("versionGate/below-segment-2"); // 9 < 32 on segment 2? 0==0, 9<32 → gated
    run("versionGate/major-above-server");
    run("versionGate/server-major-above");
    run("versionGate/missing-segments-are-zero");
  });

  it("no gate without a parseable pair (no evidence of skew)", () => {
    run("versionGate/no-requires");
    run("versionGate/no-server-version");
    run("versionGate/non-numeric-requires");
    run("versionGate/non-numeric-server");
    run("versionGate/number-requires");
    run("versionGate/empty-requires");
  });
});

describe("ollamaOrigin", () => {
  function run(id: string) {
    const v = vectorOf("ollama", id);
    expect(ollamaOrigin(v.input.base as string), v.id).toBe(v.expect.eq as string);
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

describe("probeOllamaVersion (decision 1 detection)", () => {
  async function runOne(id: string) {
    const v = vectorOf("ollama", id);
    const { fetchImpl, calls } = fakeFetch(v.fetch);
    const probe = await probeOllamaVersion(v.input.origin as string, {
      fetchImpl,
      ...apiKeyOf(v.input),
      signal: signalOf(v.input),
    });
    assertExpect(probe, v.expect, calls, v.id);
  }

  it("answers isOllama with the dotted version for the Ollama shape", async () => {
    await runOne("probeVersion/get-and-parse");
  });

  it("keeps multi-segment versions verbatim (the decision-7 gate half)", async () => {
    await runOne("probeVersion/multi-segment-verbatim");
  });

  it("rejects wrong version shapes as not-Ollama (definitive)", async () => {
    for (const v of vectorsOf("ollama", "ollama.probeVersion")) {
      if (v.id.startsWith("probeVersion/shape-")) await runOne(v.id);
    }
  });

  it("non-2xx and non-JSON answers are a definitive not-Ollama", async () => {
    await runOne("probeVersion/404-definitive");
    await runOne("probeVersion/non-json-200-definitive");
  });

  it("a network failure is an INCONCLUSIVE not-Ollama (retriable)", async () => {
    await runOne("probeVersion/network-inconclusive");
  });

  it("never throws, even when fetchImpl rejects with an abort", async () => {
    await runOne("probeVersion/abort-inconclusive");
  });
});

describe("ollamaShow (POST /api/show per model)", () => {
  async function runOne(id: string) {
    const v = vectorOf("ollama", id);
    const { fetchImpl, calls } = fakeFetch(v.fetch);
    const show = await ollamaShow(v.input.origin as string, v.input.id as string, { fetchImpl });
    assertExpect(show, v.expect, calls, v.id);
  }

  it("POSTs {\"model\": <wire id>} to {origin}/api/show and returns the parsed object", async () => {
    await runOne("show/post-and-parse");
  });

  it("404 (unknown model, note §1.3) → undefined", async () => {
    await runOne("show/404-undefined");
  });

  it("network error / malformed JSON / non-object body → undefined (never throws)", async () => {
    await runOne("show/network-undefined");
    await runOne("show/broken-json-undefined");
    await runOne("show/array-body-undefined");
    await runOne("show/string-body-undefined");
  });
});

describe("ollamaShowBatch (cap 4 + signal, decision 3)", () => {
  it("caps in-flight shows at 4 and fetches every id", async () => {
    // Inline, not a JSON vector: cap-4 is measured via an in-process
    // concurrency counter (timers + shared state; see contract/README.md, gaps).
    let inflight = 0;
    let maxInflight = 0;
    const fetchImpl = vi.fn(async () => {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inflight -= 1;
      return json({ capabilities: ["completion"], details: { family: "gemma4" } });
    });
    const ids = Array.from({ length: 9 }, (_, i) => `m${i}`);
    const shows = await ollamaShowBatch("http://127.0.0.1:11434", ids, { fetchImpl });
    expect(maxInflight).toBe(4);
    expect(fetchImpl).toHaveBeenCalledTimes(9);
    expect(shows.size).toBe(9);
    expect(shows.get("m8")).toBeDefined();
  });

  it("a failed show only omits that id (per-model fail-soft)", async () => {
    const v = vectorOf("ollama", "showBatch/fail-soft-omits-failed");
    const { fetchImpl, calls } = fakeFetch(v.fetch);
    const shows = await ollamaShowBatch(v.input.origin as string, v.input.ids as string[], { fetchImpl });
    assertExpect(shows, v.expect, calls, v.id);
  });

  it("stops issuing shows once the signal aborts (and never throws)", async () => {
    // Inline, not a JSON vector: the abort lands mid-batch through an
    // in-process AbortController the fake flips (recorded as a corpus gap).
    const controller = new AbortController();
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      const { model } = JSON.parse(String(init?.body)) as { model: string };
      seen.push(model);
      if (seen.length === 2) controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 1));
      return json({ capabilities: [] });
    });
    const ids = ["a", "b", "c", "d", "e", "f"];
    const shows = await ollamaShowBatch("http://h:1", ids, { fetchImpl, signal: controller.signal });
    // The batch stops within the cap-4 in-flight window: at most the shows
    // already issued run to completion; nothing new is issued after the abort.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.length).toBeLessThan(ids.length);
    expect(seen).not.toContain("e");
    expect(seen).not.toContain("f");
    expect(shows.size).toBe(seen.length);
  });

  it("an empty id list resolves an empty map", async () => {
    const v = vectorOf("ollama", "showBatch/empty-ids-empty-map");
    const { fetchImpl, calls } = fakeFetch(v.fetch);
    const shows = await ollamaShowBatch(v.input.origin as string, v.input.ids as string[], { fetchImpl });
    assertExpect(shows, v.expect, calls, v.id);
  });
});

describe("ollamaMetadataRows (the seam beside discoverMetadataRow)", () => {
  function run(id: string) {
    const v = vectorOf("ollama", id);
    const shows = new Map(Object.entries(v.input.shows as Record<string, OllamaShowResponse>));
    const { rows, gated } = ollamaMetadataRows(
      v.input.entries as OpenAIModelEntry[],
      shows,
      v.input.serverVersion !== undefined ? { serverVersion: v.input.serverVersion as string } : undefined,
    );
    assertExpect({ rows, gated }, v.expect, [], v.id);
  }

  it("maps shown entries through the Ollama mapper, in entry order, no rawMeta/no name", () => {
    run("metadataRows/entry-order-full");
  });

  it("a row whose show failed keeps the GENERIC mapping; the batch is unaffected (decision 9)", () => {
    run("metadataRows/failed-show-generic-fallback");
  });

  it("the generic fallback really runs extractFromEntry (a llama-swap-meta entry maps generically)", () => {
    run("metadataRows/generic-fallback-llamaswap-meta");
  });

  it("collects the gated ids for the one-line decision-7 log", () => {
    run("metadataRows/gated-ids");
  });
});

const OLLAMA_SECTION = {
  routes: [{ name: "ollama", baseURL: "http://127.0.0.1:11434/v1", models: null }],
  overrides: {},
};

const BARE_ENTRIES: OpenAIModelEntry[] = fixtureOf("ollama", "ENTRIES");

const SHOWS: Record<string, OllamaShowResponse> = {
  "gemma4:e4b": SHOW_GEMMA4_E4B,
  "qwen3-coder-200k:latest": SHOW_QWEN3CODER,
  "glm-5.2:cloud": SHOW_GLM_CLOUD,
};

function stubOllamaFetch(config: {
  version?: (url: string) => Response;
  show?: (model: string) => Response;
  models?: () => Response;
}) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/version")) {
      return config.version ? config.version(url) : new Response("nope", { status: 404 });
    }
    if (url.endsWith("/api/show")) {
      const { model } = JSON.parse(String(init?.body)) as { model: string };
      return config.show ? config.show(model) : new Response("nope", { status: 404 });
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

describe("discoverMetadata channel handler — the Ollama branch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const makeHandler = (log: (line: string) => void = () => undefined) =>
    makeChannelHandler({ section: () => OLLAMA_SECTION, log });
  const call = (handler: ReturnType<typeof makeHandler>) =>
    handler("discoverMetadata", { provider: "ollama" }, new AbortController().signal) as Promise<WireResult>;

  it("an Ollama route builds its rows through /api/show (one POST per id)", async () => {
    const fetchImpl = stubOllamaFetch({
      version: () => json({ version: "0.32.15" }),
      show: (model) => (SHOWS[model] ? json(SHOWS[model] as OllamaShowResponse) : json({}, 404)),
      models: () => json({ object: "list", data: BARE_ENTRIES }),
    });
    vi.stubGlobal("fetch", fetchImpl);
    const result = await call(makeHandler());
    expect(result.ok).toBe(true);
    const models = result.value?.models ?? [];
    expect(models).toHaveLength(3);
    expect(models[0]).toEqual({
      id: "gemma4:e4b",
      discoveredCanonical: {
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 131072,
        thinkingLevelMap: {
          off: "none",
          low: "medium",
          medium: "medium",
          high: "medium",
          xhigh: "medium",
          max: "medium",
        },
      },
    });
    expect(models[1]).toEqual({
      id: "qwen3-coder-200k:latest",
      discoveredCanonical: { contextWindow: 262144 },
    });
    expect(models[2]).toEqual({
      id: "glm-5.2:cloud",
      discoveredCanonical: {
        reasoning: true,
        contextWindow: 1048576,
        thinkingLevelMap: OLLAMA_CLOUD_GLM_MAP,
      },
    });
    const showCalls = fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/api/show"));
    expect(showCalls).toHaveLength(3);
  });

  it("a non-Ollama origin keeps the generic rows and never calls /api/show", async () => {
    const fetchImpl = stubOllamaFetch({
      version: () => new Response("nope", { status: 404 }),
      models: () => json({ object: "list", data: BARE_ENTRIES }),
    });
    vi.stubGlobal("fetch", fetchImpl);
    const result = await call(makeHandler());
    expect(result.ok).toBe(true);
    expect(result.value?.models).toEqual([
      { id: "gemma4:e4b" },
      { id: "qwen3-coder-200k:latest" },
      { id: "glm-5.2:cloud" },
    ]);
    expect(fetchImpl.mock.calls.some(([url]) => String(url).endsWith("/api/show"))).toBe(false);
  });

  it("an inconclusive /api/version probe silently keeps the generic path (never fails the endpoint)", async () => {
    const fetchImpl = stubOllamaFetch({
      version: () => {
        throw new TypeError("fetch failed");
      },
      models: () => json({ object: "list", data: BARE_ENTRIES }),
      show: () => json(SHOWS["gemma4:e4b"] as OllamaShowResponse),
    });
    vi.stubGlobal("fetch", fetchImpl);
    const result = await call(makeHandler());
    expect(result.ok).toBe(true);
    expect(result.value?.models).toEqual([{ id: "gemma4:e4b" }, { id: "qwen3-coder-200k:latest" }, { id: "glm-5.2:cloud" }]);
    expect(fetchImpl.mock.calls.some(([url]) => String(url).endsWith("/api/show"))).toBe(false);
  });

  it("memoizes a DEFINITIVE detection per route: two calls, one /api/version (Ollama or not)", async () => {
    const fetchImpl = stubOllamaFetch({
      version: () => json({ version: "0.32.15" }),
      show: (model) => (SHOWS[model] ? json(SHOWS[model] as OllamaShowResponse) : json({}, 404)),
      models: () => json({ object: "list", data: BARE_ENTRIES }),
    });
    vi.stubGlobal("fetch", fetchImpl);
    const handler = makeHandler();
    await call(handler);
    await call(handler);
    const versionCalls = fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/api/version"));
    expect(versionCalls).toHaveLength(1);

    const negative = stubOllamaFetch({
      version: () => json({ version: "nope" }),
      models: () => json({ object: "list", data: BARE_ENTRIES }),
    });
    vi.stubGlobal("fetch", negative);
    const handler2 = makeHandler();
    await call(handler2);
    await call(handler2);
    expect(
      negative.mock.calls.filter(([url]) => String(url).endsWith("/api/version")),
    ).toHaveLength(1);
  });

  it("an INCONCLUSIVE detection is retried on the next call (no answer ≠ not Ollama)", async () => {
    const fetchImpl = stubOllamaFetch({
      version: () => {
        throw new TypeError("fetch failed");
      },
      models: () => json({ object: "list", data: BARE_ENTRIES }),
    });
    vi.stubGlobal("fetch", fetchImpl);
    const handler = makeHandler();
    await call(handler);
    await call(handler);
    expect(
      fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/api/version")),
    ).toHaveLength(2);
  });

  it("a model whose show failed keeps the generic row; the batch is unaffected (decision 9)", async () => {
    const fetchImpl = stubOllamaFetch({
      version: () => json({ version: "0.32.15" }),
      show: (model) => (model === "qwen3-coder-200k:latest" ? json({}, 500) : json(SHOWS[model] as OllamaShowResponse)),
      models: () => json({ object: "list", data: BARE_ENTRIES }),
    });
    vi.stubGlobal("fetch", fetchImpl);
    const result = await call(makeHandler());
    expect(result.ok).toBe(true);
    const models = result.value?.models ?? [];
    expect(models[0]?.discoveredCanonical?.contextWindow).toBe(131072);
    expect(models[1]).toEqual({ id: "qwen3-coder-200k:latest" });
    expect(models[2]?.discoveredCanonical).toBeDefined();
  });

  it("the decision-7 gate skips the family map and logs exactly one line", async () => {
    const logs: string[] = [];
    const fetchImpl = stubOllamaFetch({
      version: () => json({ version: "0.15.5" }),
      show: (model) => (SHOWS[model] ? json(SHOWS[model] as OllamaShowResponse) : json({}, 404)),
      models: () => json({ object: "list", data: BARE_ENTRIES }),
    });
    vi.stubGlobal("fetch", fetchImpl);
    const result = await call(makeHandler((line) => logs.push(line)));
    expect(result.ok).toBe(true);
    const models = result.value?.models ?? [];
    // gemma4 requires 0.20.0 > server 0.15.5 → gated: capabilities yes, map no.
    expect(models[0]?.discoveredCanonical).toEqual({
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 131072,
    });
    // glm-5.2:cloud carries no requires → its cloud map still rides.
    expect(models[2]?.discoveredCanonical?.thinkingLevelMap).toEqual(OLLAMA_CLOUD_GLM_MAP);
    expect(logs.filter((line) => line.includes("thinkingLevelMap skipped"))).toHaveLength(1);
    expect(logs.find((line) => line.includes("thinkingLevelMap skipped"))).toContain("gemma4:e4b");
  });
});

const LIVE_ORIGIN = "http://localhost:11434";
const LIVE_PROBE_TIMEOUT_MS = 2_500;

/** Skipped cleanly unless localhost:11434 answers /api/version (Ollama
 * 0.32.15 runs on this machine); the suite is never red without it. */
const liveVersion: string | undefined = await probeOllamaVersion(LIVE_ORIGIN, {
  signal: AbortSignal.timeout(LIVE_PROBE_TIMEOUT_MS),
})
  .then((probe) => (probe.isOllama ? probe.version : undefined))
  .catch(() => undefined);

const liveTags: string[] =
  liveVersion === undefined
    ? []
    : await fetch(`${LIVE_ORIGIN}/api/tags`, { signal: AbortSignal.timeout(LIVE_PROBE_TIMEOUT_MS) })
        .then(async (response) => {
          if (!response.ok) return [];
          const payload = (await response.json()) as { models?: Array<{ name?: string }> };
          return (payload.models ?? [])
            .map((entry) => entry.name ?? "")
            .filter((name) => name.length > 0);
        })
        .catch(() => []);

const liveGemma4 = liveTags.find((name) => /^gemma4:[^/]+$/.test(name) && !name.endsWith("-cloud"));
const liveGlmCloud = liveTags.find((name) => name.startsWith("glm-") && name.endsWith(":cloud"));
const liveDeepseekCloud = liveTags.find(
  (name) => name.startsWith("deepseek-") && name.endsWith(":cloud"),
);

describe.skipIf(liveVersion === undefined)("Live E2E — detection", () => {
  it("the local server answers /api/version with a dotted version", () => {
    expect(liveVersion).toMatch(/^\d+\.\d+/);
  });
});

describe.skipIf(liveGemma4 === undefined)("Live E2E — a real local thinking model", () => {
  it("maps /api/show for a gemma4-family model (capabilities + ctx + family map)", async () => {
    const id = liveGemma4 as string;
    const show = await ollamaShow(LIVE_ORIGIN, id, { signal: AbortSignal.timeout(10_000) });
    expect(show).toBeDefined();
    const { discoveredCanonical } = ollamaShowToCanonical(id, show as OllamaShowResponse, {
      serverVersion: liveVersion,
    });
    expect(discoveredCanonical?.reasoning).toBe(true);
    expect(discoveredCanonical?.contextWindow).toBeGreaterThan(0);
    expect(Number.isInteger(discoveredCanonical?.contextWindow)).toBe(true);
    // The family map rides exactly when the server's own gate does (PARSER
    // gemma4 + server ≥ requires); pin its VALUES otherwise.
    const parser = ollamaModelfileParser(show as OllamaShowResponse);
    if (parser === "gemma4" && !gateOf((show as OllamaShowResponse).requires, liveVersion)) {
      expect(discoveredCanonical?.thinkingLevelMap).toEqual(fixtureOf("ollama", "GEMMA4_MAP"));
    }
    expect("maxTokens" in (discoveredCanonical as object)).toBe(false);
    expect("compat" in (discoveredCanonical as object)).toBe(false);
  });
});

describe.skipIf(liveGlmCloud === undefined)("Live E2E — a real cloud glm model", () => {
  it("maps /api/show to the cloud glm family table + capabilities + context", async () => {
    const id = liveGlmCloud as string;
    const show = await ollamaShow(LIVE_ORIGIN, id, { signal: AbortSignal.timeout(10_000) });
    expect(show).toBeDefined();
    const { discoveredCanonical } = ollamaShowToCanonical(id, show as OllamaShowResponse, {
      serverVersion: liveVersion,
    });
    expect(discoveredCanonical?.reasoning).toBe(true);
    expect(discoveredCanonical?.thinkingLevelMap).toEqual(fixtureOf("ollama", "CLOUD_GLM_MAP"));
    expect(discoveredCanonical?.contextWindow).toBeGreaterThan(0);
    expect("maxTokens" in (discoveredCanonical as object)).toBe(false);
    expect("compat" in (discoveredCanonical as object)).toBe(false);
  });
});

describe("ollamaBackend.detect — the llama-swap near-miss guard (docs/provider-details.md §3.1)", () => {
  async function runOne(id: string): Promise<void> {
    const v = vectorOf("ollama", id);
    const { fetchImpl, calls } = fakeFetch(v.fetch);
    const verdict = await ollamaBackend.detect({
      baseUrl: v.input.baseUrl as string,
      entries: v.input.entries as OpenAIModelEntry[],
      fetchImpl,
    });
    assertExpect(verdict, v.expect, calls, v.id);
  }

  it("a meta.llamaswap entry settles the origin as not-Ollama with ZERO fetches (even though the server answers the dotted Ollama shape)", async () => {
    await runOne("detect/guard-meta-llamaswap-zero-fetches");
  });

  it("an owned_by === 'llama-swap' entry settles the origin the same way (no meta block needed)", async () => {
    await runOne("detect/guard-owned-by-llama-swap");
  });

  it("a bare catalog (no router signature) still probes — a real Ollama answer matches (the guard does not suppress real detections)", async () => {
    await runOne("detect/bare-catalog-still-probes-and-matches");
  });
});

describe.skipIf(liveDeepseekCloud === undefined)("Live E2E — a real cloud deepseek model", () => {
  it("maps /api/show to the all-null cloud deepseek map + reasoning true", async () => {
    const id = liveDeepseekCloud as string;
    const show = await ollamaShow(LIVE_ORIGIN, id, { signal: AbortSignal.timeout(10_000) });
    expect(show).toBeDefined();
    const { discoveredCanonical } = ollamaShowToCanonical(id, show as OllamaShowResponse, {
      serverVersion: liveVersion,
    });
    expect(discoveredCanonical?.reasoning).toBe(true);
    expect(discoveredCanonical?.thinkingLevelMap).toEqual(OLLAMA_CLOUD_DEEPSEEK_MAP);
    expect("maxTokens" in (discoveredCanonical as object)).toBe(false);
    expect("compat" in (discoveredCanonical as object)).toBe(false);
  });
});