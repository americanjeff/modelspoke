import { describe, expect, it } from "vitest";
import {
  canonicalizeThinkingLevelMap,
  DEFAULT_FIELDS,
  extractThinkingLevelMap,
  resolveModel,
} from "../src/index.js";
import type {
  CanonicalModelFields,
  DiscoveryModelInfo,
  OpenAIModelEntry,
  Preset,
} from "../src/index.js";
import { presetCatalog } from "../src/index.js";

const FLAGSHIP_ID = "qwen3.8-27b-6000pro";
const FLAGSHIP_PRESET_SOURCE = "preset:qwen3.8-chat-template";

function discoveryOf(canonical: CanonicalModelFields | undefined): DiscoveryModelInfo {
  return { id: FLAGSHIP_ID, discoveredCanonical: canonical };
}

/** A /v1/models entry carrying the LIVE 7-level raw thinkingLevelMap (incl. nulls). */
const rawMapEntry: OpenAIModelEntry = {
  id: FLAGSHIP_ID,
  object: "model",
  meta: {
    llamaswap: {
      type: "model",
      reasoning: true,
      thinkingLevelMap: {
        off: "low",
        minimal: null,
        low: "low",
        medium: "medium",
        high: null,
        xhigh: "xhigh",
        max: null,
      },
    },
  },
};

describe("per-field precedence (first non-empty wins per field)", () => {
  it("draws different fields from different tiers and reports the exact source map", () => {
    const { resolved, sources } = resolveModel({
      modelId: FLAGSHIP_ID,
      userOverride: { maxTokens: 1234 },
      discovery: discoveryOf({ input: ["text"], contextWindow: 999_999, reasoning: true }),
    });

    expect(resolved.maxTokens).toBe(1234);
    expect(resolved.input).toEqual(["text"]);
    expect(resolved.contextWindow).toBe(999_999);
    expect(resolved.reasoning).toBe(true);
    expect(resolved.thinkingLevelMap).toEqual({
      off: "low",
      low: "low",
      medium: "medium",
      xhigh: "xhigh",
    });
    expect(resolved.compat).toMatchObject({ thinkingFormat: "chat-template" });

    expect(sources).toEqual({
      input: "discovery",
      reasoning: "discovery",
      contextWindow: "discovery",
      maxTokens: "user",
      thinkingLevelMap: FLAGSHIP_PRESET_SOURCE,
      compat: FLAGSHIP_PRESET_SOURCE,
    });
  });

  it("user override beats discovery for the same field (a present false is a definitive answer)", () => {
    const { resolved, sources } = resolveModel({
      modelId: FLAGSHIP_ID,
      userOverride: { reasoning: false },
      discovery: discoveryOf({ reasoning: true, compat: { thinkingFormat: "chat-template" } }),
    });

    expect(resolved.reasoning).toBe(false);
    expect(sources.reasoning).toBe("user");
    expect(sources.compat).toBe("discovery");
    expect(sources.thinkingLevelMap).toBe(FLAGSHIP_PRESET_SOURCE);
  });

  it("discovery beats preset (the llama-swap flagship path)", () => {
    const { resolved, sources } = resolveModel({
      modelId: FLAGSHIP_ID,
      discovery: discoveryOf({
        reasoning: true,
        contextWindow: 262144,
        maxTokens: 32768,
        thinkingLevelMap: { off: "low", low: "low" },
      }),
    });

    expect(resolved.contextWindow).toBe(262144);
    expect(resolved.maxTokens).toBe(32768); // discovery value, not the preset's 65536
    expect(resolved.thinkingLevelMap).toEqual({ off: "low", low: "low" });
    expect(sources.maxTokens).toBe("discovery");
    expect(sources.thinkingLevelMap).toBe("discovery");
    expect(resolved.input).toEqual(["text", "image"]);
    expect(sources.input).toBe(FLAGSHIP_PRESET_SOURCE);
  });

  it("a field no tier supplies at all falls to the default tier", () => {
    const { resolved, sources } = resolveModel({
      modelId: "some-bare-model", // no preset match
      discovery: discoveryOf({ maxTokens: 4096 }),
    });
    expect(resolved.maxTokens).toBe(4096);
    expect(sources.maxTokens).toBe("discovery");
    expect(resolved.input).toEqual(["text"]);
    expect(sources.input).toBe("default");
    expect(resolved.contextWindow).toBeUndefined();
    expect(sources.contextWindow).toBe("default");
  });

  it("treats each whole field as one unit (no cross-tier merging)", () => {
    const { resolved, sources } = resolveModel({
      modelId: FLAGSHIP_ID,
      discovery: discoveryOf({ compat: { thinkingFormat: "chat-template" } }),
    });
    expect(resolved.compat).toEqual({ thinkingFormat: "chat-template" });
    expect(sources.compat).toBe("discovery");
  });

  it("ignores empty/absent tier fields when looking for a winner", () => {
    const { resolved, sources } = resolveModel({
      modelId: FLAGSHIP_ID,
      userOverride: { input: [], thinkingLevelMap: { minimal: null, high: null } },
    });
    expect(resolved.thinkingLevelMap).toEqual({
      off: "low",
      low: "low",
      medium: "medium",
      xhigh: "xhigh",
    });
    expect(sources.thinkingLevelMap).toBe(FLAGSHIP_PRESET_SOURCE);
    expect(resolved.input).toEqual(["text", "image"]);
    expect(sources.input).toBe(FLAGSHIP_PRESET_SOURCE);
  });
});

describe("canonical off handling (discovery→canonical boundary)", () => {
  it("preserves off: 'low' and drops null entries", () => {
    expect(extractThinkingLevelMap(rawMapEntry)).toEqual({
      off: "low",
      low: "low",
      medium: "medium",
      xhigh: "xhigh",
    });
  });

  it("canonicalizeThinkingLevelMap drops nulls, keeps order canonical (off first)", () => {
    expect(
      canonicalizeThinkingLevelMap({
        high: null,
        xhigh: "xhigh",
        off: "low",
        max: null,
        low: "low",
        minimal: null,
        medium: "medium",
      }),
    ).toEqual({ off: "low", low: "low", medium: "medium", xhigh: "xhigh" });
    expect(canonicalizeThinkingLevelMap({ minimal: null, high: null })).toBeUndefined();
    expect(canonicalizeThinkingLevelMap("nope")).toBeUndefined();
    expect(canonicalizeThinkingLevelMap(undefined)).toBeUndefined();
  });

  it("the resolver canonicalizes user-override nulls too", () => {
    const { resolved } = resolveModel({
      modelId: "some-bare-model",
      userOverride: {
        reasoning: true,
        thinkingLevelMap: { off: "low", minimal: null, low: "low", high: null, xhigh: "xhigh" },
      },
    });
    expect(resolved.thinkingLevelMap).toEqual({ off: "low", low: "low", xhigh: "xhigh" });
  });
});

describe("conservative guard (qwen3.8 preset vocabulary)", () => {
  it("the flagship preset offers ONLY off/low/medium/xhigh — never high/max", () => {
    const preset: Preset | undefined = presetCatalog.find(
      (p) => p.id === "qwen3.8-chat-template",
    );
    expect(preset).toBeDefined();
    const map = preset!.thinkingLevelMap;
    expect(map).toBeDefined();
    const levels = Object.keys(map!).sort();
    // Exactly the verified template vocabulary. The template RAISES on
    // anything else, so high/max must never appear — even as nulls.
    expect(levels).toEqual(["low", "medium", "off", "xhigh"]);
    expect(levels).not.toContain("high");
    expect(levels).not.toContain("max");
  });
});

describe("default tier shape", () => {
  it("an unlisted model with no discovery resolves to the default tier", () => {
    const { resolved, sources } = resolveModel({ modelId: "gemma-4-E4B-it" });

    expect(resolved).toEqual({
      input: ["text"],
      reasoning: false,
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
    });
    expect(resolved.contextWindow).toBeUndefined();
    expect(resolved.maxTokens).toBeUndefined();
    expect(resolved.thinkingLevelMap).toBeUndefined();

    expect(sources).toEqual({
      input: "default",
      reasoning: "default",
      contextWindow: "default",
      maxTokens: "default",
      thinkingLevelMap: "default",
      compat: "default",
    });
  });

  it("DEFAULT_FIELDS is the tier-4 contract", () => {
    expect(DEFAULT_FIELDS).toEqual({
      reasoning: false,
      input: ["text"],
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
    });
  });
});
