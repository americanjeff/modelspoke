/**
 * Unit tests for the core's wire-facing reasoning state — the BUG-001/
 * BUG-002 shim (src/resolve/wire.ts): `wireReasoning` (which pi-ai
 * request-builder gate the model opens) and `wireThinkingLevelMap` (the RAW
 * level map the wire model carries).
 *
 * The contract under test: the DECLARED dimension is untouched — these
 * decide the WIRE model only; the shim opens the wire gate for EXACTLY one
 * shape (explicit nothink + a declared chat-template kwarg block); the
 * shim's level map is asserted against the REAL pi-ai
 * `getSupportedThinkingLevels`, not a mirror.
 */

import { describe, expect, it } from "vitest";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { wireReasoning, wireThinkingLevelMap } from "../src/resolve/wire.js";
import type { ResolvedModel } from "../src/types.js";

const CHAT_TEMPLATE_KWARGS = {
  enable_thinking: { $var: "thinking.enabled" },
  preserve_thinking: true,
};

function resolved(partial: Partial<ResolvedModel> = {}): ResolvedModel {
  return { input: ["text"], reasoning: false, compat: {}, ...partial } as ResolvedModel;
}

describe("wireReasoning — the wire gate vs the declared dimension", () => {
  it("a reasoning model is reasoning on the wire (unchanged, nothink irrelevant)", () => {
    const on = resolved({ reasoning: true });
    expect(wireReasoning(on, false)).toBe(true);
    expect(wireReasoning(on, true)).toBe(true);
  });

  it("a plain non-reasoning model stays closed (unchanged)", () => {
    expect(wireReasoning(resolved(), false)).toBe(false);
    expect(wireReasoning(resolved({ compat: { thinkingFormat: "chat-template", chatTemplateKwargs: CHAT_TEMPLATE_KWARGS } }), false)).toBe(false);
  });

  it("nothink + declared chat-template kwargs OPENS the gate (the shim case)", () => {
    const nothink = resolved({
      thinkingLevelMap: {},
      compat: { thinkingFormat: "chat-template", chatTemplateKwargs: CHAT_TEMPLATE_KWARGS },
    });
    expect(wireReasoning(nothink, true)).toBe(true);
    // the marker is the gate — without it the same shape is closed
    expect(wireReasoning(nothink, false)).toBe(false);
  });

  it("nothink WITHOUT declared kwargs stays closed (never invent a wire parameter)", () => {
    expect(wireReasoning(resolved({ thinkingLevelMap: {} }), true)).toBe(false);
    expect(
      wireReasoning(resolved({ thinkingLevelMap: {}, compat: { thinkingFormat: "chat-template" } }), true),
    ).toBe(false);
    expect(
      wireReasoning(resolved({ thinkingLevelMap: {}, compat: { thinkingFormat: "chat-template", chatTemplateKwargs: {} } }), true),
    ).toBe(false);
    expect(
      wireReasoning(resolved({ thinkingLevelMap: {}, compat: { chatTemplateKwargs: CHAT_TEMPLATE_KWARGS } }), true),
    ).toBe(false);
  });

  it("nothink under another thinkingFormat stays closed (conservative scope)", () => {
    for (const thinkingFormat of ["qwen", "deepseek", "openrouter", "string-thinking"] as const) {
      expect(
        wireReasoning(
          resolved({ thinkingLevelMap: {}, compat: { thinkingFormat, chatTemplateKwargs: CHAT_TEMPLATE_KWARGS } }),
          true,
        ),
      ).toBe(false);
    }
  });
});

describe("wireThinkingLevelMap — the RAW level map the wire model carries", () => {
  it("a reasoning model: absent→null, offered levels verbatim, offered off ABSENT (unchanged)", () => {
    const map = wireThinkingLevelMap(
      resolved({ reasoning: true, thinkingLevelMap: { off: "low", low: "low", medium: "medium", xhigh: "xhigh" } }),
    );
    expect(map).toEqual({ low: "low", medium: "medium", xhigh: "xhigh", minimal: null, high: null, max: null });
    expect(map).not.toHaveProperty("off");
  });

  it("a plain non-reasoning model carries no level map (unchanged)", () => {
    expect(wireThinkingLevelMap(resolved(), false)).toBeUndefined();
    expect(wireThinkingLevelMap(resolved(), true)).toBeUndefined();
  });

  it("the shim case: reasoning wire model, every non-`off` level pinned, off ABSENT", () => {
    const map = wireThinkingLevelMap(
      resolved({
        thinkingLevelMap: {},
        compat: { thinkingFormat: "chat-template", chatTemplateKwargs: CHAT_TEMPLATE_KWARGS },
      }),
      true,
    );
    expect(map).toEqual({ minimal: null, low: null, medium: null, high: null, xhigh: null, max: null });
    expect(map).not.toHaveProperty("off");
    // and without the marker the same shape carries no map at all
    expect(
      wireThinkingLevelMap(
        resolved({
          thinkingLevelMap: {},
          compat: { thinkingFormat: "chat-template", chatTemplateKwargs: CHAT_TEMPLATE_KWARGS },
        }),
        false,
      ),
    ).toBeUndefined();
  });

  it("the shim's map offers exactly [\"off\"] through pi-ai's own level resolution", () => {
    const map = wireThinkingLevelMap(
      resolved({
        thinkingLevelMap: {},
        compat: { thinkingFormat: "chat-template", chatTemplateKwargs: CHAT_TEMPLATE_KWARGS },
      }),
      true,
    );
    expect(getSupportedThinkingLevels({ reasoning: true, thinkingLevelMap: map } as never)).toEqual(["off"]);
  });
});
