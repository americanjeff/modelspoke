import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  ModelspokeClientError,
  discoverModels,
  extractFromEntry,
  fetchModels,
  loadOverrides,
  resolveModel,
} from "../src/index.js";
import type { ResolvedModel } from "../src/index.js";

const FLAGSHIP_ID = "qwen3.8-27b-6000pro";
const FLAGSHIP_PRESET_SOURCE = "preset:qwen3.8-chat-template";

function fixturePath(name: string): string {
  return new URL(`./fixtures/${name}`, import.meta.url).pathname;
}
function loadFixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(fixturePath(name), "utf8")) as T;
}

/**
 * Expected resolved object — derived from the port's source-mapping table
 * (jj history; config/llama-swap.yaml `metadata` → dsh), in the canonical
 * pi-ai spelling:
 *
 *   contextWindow: 262144   (capabilities.context, rendered as context_length)
 *   maxTokens: 65536        (meta.llamaswap.maxTokens)
 *   reasoning: true         (meta.llamaswap.reasoning)
 *   input: [text, image]    (capabilities.in, rendered as architecture.input_modalities)
 *   thinkingLevelMap        (null/absent pi-ai levels dropped; off stays "low")
 *   compat                  (verbatim, incl. chatTemplateKwargs $var + preserve_thinking)
 */
const EXPECTED: ResolvedModel = {
  input: ["text", "image"],
  reasoning: true,
  contextWindow: 262144,
  maxTokens: 65536,
  thinkingLevelMap: { off: "low", low: "low", medium: "medium", xhigh: "xhigh" },
  compat: {
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
    thinkingFormat: "chat-template",
    chatTemplateKwargs: {
      enable_thinking: { "$var": "thinking.enabled" },
      reasoning_effort: { "$var": "thinking.effort", omitWhenOff: true },
      preserve_thinking: true,
    },
  },
};

const CANONICAL_FIELDS = [
  "input",
  "reasoning",
  "contextWindow",
  "maxTokens",
  "thinkingLevelMap",
  "compat",
] as const;

function assertEqualsExpected(resolved: ResolvedModel, label: string) {
  for (const field of CANONICAL_FIELDS) {
    expect(resolved[field], `${label}: field ${field}`).toEqual(EXPECTED[field]);
  }
  expect(resolved, `${label}: whole object`).toEqual(EXPECTED);
}

describe("golden oracle — qwen3.8-27b-6000pro", () => {
  const metaFixture = loadFixture<{ object: string; data: unknown[] }>("models-llamaswap-meta.json");
  const flagshipEntry = metaFixture.data.find((m) => (m as { id: string }).id === FLAGSHIP_ID) as
    | { id: string }
    | undefined;

  it("fixture: the recorded live llama-swap entry carries the full meta.llamaswap block", () => {
    expect(flagshipEntry).toBeDefined();
    const info = extractFromEntry(flagshipEntry!);
    expect(info.name).toBeUndefined(); // live entry has no top-level `name`
    expect(info.rawMeta).toBeDefined();
    expect(info.discoveredCanonical).toBeDefined();
  });

  it("(a) discovery-tier resolution equals the expected object (field by field)", () => {
    const info = extractFromEntry(flagshipEntry!);
    const { resolved, sources } = resolveModel({
      modelId: FLAGSHIP_ID,
      discovery: info,
    });
    assertEqualsExpected(resolved, "discovery tier");
    for (const field of CANONICAL_FIELDS) {
      expect(sources[field], `source of ${field}`).toBe("discovery");
    }
  });

  it("(b) preset-tier resolution (no discovery) equals the same object (field by field)", () => {
    const { resolved, sources } = resolveModel({ modelId: FLAGSHIP_ID });
    assertEqualsExpected(resolved, "preset tier");
    for (const field of CANONICAL_FIELDS) {
      expect(sources[field], `source of ${field}`).toBe(FLAGSHIP_PRESET_SOURCE);
    }
  });

  it("(a) and (b) agree: discovery and preset produce the SAME canonical object", () => {
    const viaDiscovery = resolveModel({
      modelId: FLAGSHIP_ID,
      discovery: extractFromEntry(flagshipEntry!),
    }).resolved;
    const viaPreset = resolveModel({ modelId: FLAGSHIP_ID }).resolved;
    expect(viaDiscovery).toEqual(viaPreset);
  });
});

describe("fixture parsing — all three recorded /v1/models shapes", () => {
  it("llamaswap-meta: 13 models; per-model extraction is faithful", () => {
    const fixture = loadFixture<{ data: unknown[] }>("models-llamaswap-meta.json");
    expect(fixture.data).toHaveLength(13);

    const gemma = extractFromEntry(
      fixture.data.find((m) => (m as { id: string }).id === "gemma-4-E4B-it") as { id: string },
    );
    // gemma: text-only input discovered; NO reasoning/capacities (context: 0
    // is filtered, metadata: {} is empty) — the defaults own the rest.
    expect(gemma.discoveredCanonical).toEqual({ input: ["text"] });
    expect(
      resolveModel({ modelId: "gemma-4-E4B-it", discovery: gemma }).sources,
    ).toMatchObject({ reasoning: "default", contextWindow: "default", maxTokens: "default" });

    const qwen36 = extractFromEntry(
      fixture.data.find((m) => (m as { id: string }).id === "qwen3.6-27b-mtp") as { id: string },
    );
    // declares maxTokens + context but NO reasoning → reasoning stays default.
    expect(qwen36.discoveredCanonical).toEqual({
      input: ["text", "image"],
      contextWindow: 262144,
      maxTokens: 131072,
    });
  });

  it("bare: a plain basic-OpenAI entry advertises nothing → preset path (Tier 2b)", () => {
    const fixture = loadFixture<{ object: string; data: Array<{ id: string }> }>("models-bare.json");
    expect(fixture.object).toBe("list");
    expect(fixture.data).toHaveLength(1);
    const entry = fixture.data[0]!;
    expect(entry.id).toBe(FLAGSHIP_ID);

    // The bare sglang entry's only context signal is max_model_len — OUT of
    // the discovery chain by design (probe-gated), so discovery finds nothing.
    const info = extractFromEntry(entry);
    expect(info.discoveredCanonical).toBeUndefined();
    expect(info.rawMeta).toBeUndefined();

    const { resolved, sources } = resolveModel({ modelId: FLAGSHIP_ID, discovery: info });
    for (const field of CANONICAL_FIELDS) {
      expect(sources[field], `source of ${field}`).toBe(FLAGSHIP_PRESET_SOURCE);
    }
    assertEqualsExpected(resolved, "bare server → preset tier");
  });

  it("error: non-2xx and missing-data-array shapes surface ModelspokeClientError", async () => {
    const errorBody = loadFixture<Record<string, unknown>>("models-error.json");
    const calls: RequestInit[] = [];
    const fakeFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(init ?? {});
      const what = String(_url); // fetchModels appends `/models` to the base URL
      if (what.includes("/v1/404")) {
        return new Response(JSON.stringify(errorBody), { status: 404, statusText: "Not Found" });
      }
      if (what.includes("/v1/no-data")) {
        return new Response(JSON.stringify(errorBody), { status: 200 });
      }
      return new Response("{}", { status: 500, statusText: "Internal Server Error" });
    });
    vi.stubGlobal("fetch", fakeFetch);
    try {
      await expect(fetchModels("http://127.0.0.1:1/v1/404")).rejects.toMatchObject({
        name: "ModelspokeClientError",
        status: 404,
      });
      const err404 = await fetchModels("http://127.0.0.1:1/v1/404").catch((e) => e);
      expect(err404).toBeInstanceOf(ModelspokeClientError);
      expect(err404.message).toContain("404");
      expect(err404.message).toContain("The model 'nope' does not exist");

      await expect(fetchModels("http://127.0.0.1:1/v1/no-data")).rejects.toThrow(
        "Unexpected /v1/models response: missing data array",
      );
      await expect(fetchModels("http://127.0.0.1:1/v1/broken")).rejects.toThrow(
        "Server returned 500",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("error: Bearer header is sent only when a key is configured", async () => {
    const modelsFixture = loadFixture("models-llamaswap-meta.json");
    const okFetch = vi.fn(
      async () => new Response(JSON.stringify(modelsFixture), { status: 200 }),
    );
    vi.stubGlobal("fetch", okFetch);
    try {
      await fetchModels("http://127.0.0.1:1/v1");
      await fetchModels("http://127.0.0.1:1/v1", "secret-key");
      const [init1, init2] = okFetch.mock.calls.map((c) => c[1] as RequestInit);
      expect((init1?.headers as Record<string, string>)?.Authorization).toBeUndefined();
      expect((init2?.headers as Record<string, string>)?.Authorization).toBe("Bearer secret-key");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("discoverModels: normalizes the route baseURL and resolves the env key", async () => {
    const modelsFixture = loadFixture("models-llamaswap-meta.json");
    const okFetch = vi.fn(
      async () => new Response(JSON.stringify(modelsFixture), { status: 200 }),
    );
    vi.stubGlobal("fetch", okFetch);
    vi.stubEnv("MS_TEST_KEY", "dummy");
    try {
      const models = await discoverModels({ baseURL: "http://127.0.0.1:8080", apiKeyEnv: "MS_TEST_KEY" });
      expect(okFetch.mock.calls[0]?.[0]).toBe("http://127.0.0.1:8080/v1/models");
      expect((okFetch.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>)
        .toEqual({ Accept: "application/json", Authorization: "Bearer dummy" });
      expect(models).toHaveLength(13);
      expect(models.some((m) => m.id === FLAGSHIP_ID)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });
});
