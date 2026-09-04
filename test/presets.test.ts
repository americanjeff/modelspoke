/**
 * Conservative-guard asserts for the presets (the authoring pass in
 * docs/preset-authoring.md). A wrong preset causes mid-turn 400s, silent
 * no-ops, or silent multi-turn regressions — so each new entry pins the
 * exact thinkingLevelMap, the exact chatTemplateKwargs set (and their
 * ABSENCE where the template has no such variable), thinkingFormat, input,
 * and capacities.
 */

import { describe, expect, it } from "vitest";
import { presetCatalog } from "../src/index.js";
import type { Preset } from "../src/index.js";

function preset(id: string): Preset {
  const p = presetCatalog.find((p) => p.id === id);
  expect(p, `preset ${id} in catalog`).toBeDefined();
  return p!;
}

describe("catalog order (the contract)", () => {
  it("ships the four presets in catalog order", () => {
    expect(presetCatalog.map((p) => p.id)).toEqual([
      "qwen3.8-chat-template",
      "qwen3.6-chat-template",
      "qwen3.5-chat-template",
      "gpt-oss-120b-chat-template",
    ]);
  });
});

describe("qwen3.6-chat-template — conservative guard", () => {
  it("degenerate on/off map exactly {off, low}", () => {
    expect(preset("qwen3.6-chat-template").thinkingLevelMap).toEqual({
      off: "low",
      low: "low",
    });
  });

  it("has NO reasoning_effort kwarg but DOES carry preserve_thinking: true", () => {
    const kwargs = preset("qwen3.6-chat-template").compat!.chatTemplateKwargs!;
    expect(kwargs).not.toHaveProperty("reasoning_effort");
    expect(kwargs).toHaveProperty("preserve_thinking", true);
  });

  it("chat-template thinkingFormat, [text,image] input, ctx 262144, maxTokens 65536", () => {
    const p = preset("qwen3.6-chat-template");
    expect(p.compat!.thinkingFormat).toBe("chat-template");
    expect(p.input).toEqual(["text", "image"]);
    expect(p.contextWindow).toBe(262144);
    expect(p.maxTokens).toBe(65536);
  });
});

describe("qwen3.5-chat-template — conservative guard", () => {
  it("degenerate on/off map exactly {off, low}", () => {
    expect(preset("qwen3.5-chat-template").thinkingLevelMap).toEqual({
      off: "low",
      low: "low",
    });
  });

  it("has NO preserve_thinking and NO reasoning_effort kwarg", () => {
    const kwargs = preset("qwen3.5-chat-template").compat!.chatTemplateKwargs!;
    expect(kwargs).not.toHaveProperty("preserve_thinking");
    expect(kwargs).not.toHaveProperty("reasoning_effort");
  });

  it("chat-template thinkingFormat, input ABSENT, ctx 262144, maxTokens ABSENT", () => {
    const p = preset("qwen3.5-chat-template");
    expect(p.compat!.thinkingFormat).toBe("chat-template");
    expect(p.input).toBeUndefined();
    expect(p.contextWindow).toBe(262144);
    expect(p.maxTokens).toBeUndefined();
  });
});

describe("gpt-oss-120b-chat-template — conservative guard", () => {
  it("effort map exactly {off:medium, low, medium, high}", () => {
    expect(preset("gpt-oss-120b-chat-template").thinkingLevelMap).toEqual({
      off: "medium",
      low: "low",
      medium: "medium",
      high: "high",
    });
  });

  it("reasoning_effort binds thinking.effort with omitWhenOff; NO enable_thinking key", () => {
    const kwargs = preset("gpt-oss-120b-chat-template").compat!.chatTemplateKwargs!;
    expect(kwargs).toEqual({
      reasoning_effort: { "$var": "thinking.effort", omitWhenOff: true },
    });
    expect(kwargs).not.toHaveProperty("enable_thinking");
  });

  it("chat-template thinkingFormat, [text] input, ctx 131072, maxTokens 65536", () => {
    const p = preset("gpt-oss-120b-chat-template");
    expect(p.compat!.thinkingFormat).toBe("chat-template");
    expect(p.input).toEqual(["text"]);
    expect(p.contextWindow).toBe(131072);
    expect(p.maxTokens).toBe(65536);
  });
});
