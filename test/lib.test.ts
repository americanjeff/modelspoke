/**
 * The `modelspoke/lib` barrel smoke test (docs/design.md, library face): the
 * stable library surface exports what the README promises — the
 * five-backend registry in its locked C9 order, the canonicalization
 * helpers, and the four-tier resolver — plus a minimal end-to-end.
 */

import { describe, expect, it } from "vitest";
import {
  CANONICAL_LEVELS,
  NO_THINKING_LEVELS,
  canonicalizeFields,
  canonicalizeThinkingLevelMap,
  discoveryBackends,
  llamacppBackend,
  lmstudioBackend,
  ollamaBackend,
  resolveModel,
  sglangBackend,
  vllmBackend,
} from "../src/lib.js";
import type {
  DiscoveryBackend,
  DiscoveryContext,
  ResolveInput,
  ResolutionResult,
} from "../src/lib.js";

describe("modelspoke/lib barrel", () => {
  it("exposes the tiered-resolver entry point as a function", () => {
    expect(typeof resolveModel).toBe("function");
    const input: ResolveInput = { modelId: "some-model" };
    expect(typeof input.modelId).toBe("string");
  });

  it("exposes the registry in its locked C9 order, members identical to the registry", () => {
    // C9 (docs/design.md): the order is LOCKED — SGLang first (it serves
    // an Ollama-compat surface), then the free (catalog-derived) detections.
    expect(discoveryBackends.map((b) => b.id)).toEqual([
      "sglang",
      "ollama",
      "lmstudio",
      "vllm",
      "llamacpp",
    ]);
    const registry: readonly DiscoveryBackend[] = discoveryBackends;
    expect(registry[0]).toBe(sglangBackend);
    expect(registry[1]).toBe(ollamaBackend);
    expect(registry[2]).toBe(lmstudioBackend);
    expect(registry[3]).toBe(vllmBackend);
    expect(registry[4]).toBe(llamacppBackend);
  });

  it("exposes the canonicalization helpers (NO_THINKING_LEVELS is the 'none' sentinel)", () => {
    expect(NO_THINKING_LEVELS).toBe("none");
    expect(typeof canonicalizeFields).toBe("function");
    expect(typeof canonicalizeThinkingLevelMap).toBe("function");
    expect(CANONICAL_LEVELS[0]).toBe("off");
    expect(CANONICAL_LEVELS).toContain("high");
  });

  it("canonicalizes a small raw object at the tier→canonical boundary", () => {
    expect(
      canonicalizeFields({
        input: ["image", "text", "audio"], // audio is not a canonical modality
        reasoning: true,
        contextWindow: 131_072,
        thinkingLevelMap: { off: "low", high: null, medium: "medium" },
      }),
    ).toEqual({
      input: ["text", "image"],
      reasoning: true,
      contextWindow: 131_072,
      thinkingLevelMap: { off: "low", medium: "medium" },
    });
  });

  it("resolves an unknown id through the default tier: honest all-default source map, no invented fields", () => {
    const result: ResolutionResult = resolveModel({ modelId: "some-model" });
    // No tier supplied capacities or levels — they are OMITTED from the
    // resolved object, not invented (the conservative default-tier rule).
    expect(result.resolved).toEqual({
      input: ["text"],
      reasoning: false,
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
    });
    expect(result.sources).toEqual({
      input: "default",
      reasoning: "default",
      contextWindow: "default",
      maxTokens: "default",
      thinkingLevelMap: "default",
      compat: "default",
    });
    expect(result.nothink).toBeUndefined();
  });
});