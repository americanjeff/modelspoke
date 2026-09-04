import { describe, expect, it } from "vitest";
import { matchPreset, presetCatalog } from "../src/index.js";
import type { Preset } from "../src/index.js";

describe("shipped catalog", () => {
  it("ships exactly four presets in catalog order (flagship first, unchanged)", () => {
    expect(presetCatalog.map((p) => p.id)).toEqual([
      "qwen3.8-chat-template",
      "qwen3.6-chat-template",
      "qwen3.5-chat-template",
      "gpt-oss-120b-chat-template",
    ]);
    expect(presetCatalog[0]!.id).toBe("qwen3.8-chat-template");
    expect(presetCatalog[0]!.match).toBe("qwen3[._-]?8");
  });

  it("flagship pinned: qwen3.8-27b-6000pro → qwen3.8-chat-template", () => {
    expect(matchPreset("qwen3.8-27b-6000pro")?.id).toBe("qwen3.8-chat-template");
  });
});

describe("case-insensitive substring", () => {
  it("matches a repo-qualified GGUF id with mixed case", () => {
    expect(matchPreset("unsloth/Qwen3.8-27B-GGUF")?.id).toBe("qwen3.8-chat-template");
  });

  it("matches an all-uppercase id", () => {
    expect(matchPreset("QWEN3.8-27B")?.id).toBe("qwen3.8-chat-template");
  });

  it("covers the family spellings: dot, underscore, hyphen, none", () => {
    for (const id of [
      "qwen3.8-27b-6000pro",
      "qwen3_8-27b",
      "qwen3-8-27b",
      "qwen38-27b",
      "my-local/Qwen3.8-FP8",
    ]) {
      expect(matchPreset(id)?.id, id).toBe("qwen3.8-chat-template");
    }
  });

  it("does not match families with no preset", () => {
    // gpt-oss and qwen3.6 are in the catalog (see the collision
    // table below), so they DO match; the genuinely-unchanged no-preset ids
    // are the ones that fall to the default tier.
    expect(matchPreset("qwen3-coder-next")).toBeUndefined();
    expect(matchPreset("gemma-4-E4B-it")).toBeUndefined();
    expect(matchPreset("laguna-s-2.1")).toBeUndefined();
    // NB: unanchored substring semantics — a hypothetical `qwen3.85` id WOULD
    // match the flagship pattern; that is exactly why a future
    // `qwen3.85-...` preset is listed BEFORE it (catalog order is the
    // contract, no specificity scoring).
  });
});

/**
 * The full collision table: every live id from
 * `test/fixtures/models-llamaswap-meta.json` (13) plus the two prospective
 * spellings → the expected shipped preset id, or `null` when no preset matches
 * (the id falls to the default tier). This is the per-id proof that the four
 * patterns are mutually exclusive and no live id changes tier.
 */
describe("collision table — every live id → preset id or no preset", () => {
  const table: Array<[string, string | null]> = [
    ["gemma-4-E4B-it", null],
    ["gemma-4-E4B-it-XL", null],
    ["gpt-oss-120b", "gpt-oss-120b-chat-template"],
    ["laguna-s-2.1", null],
    ["laguna-s-2.1-nothink", null],
    ["qwen3-coder-next", null],
    ["qwen3.6-27b-mtp", "qwen3.6-chat-template"],
    ["qwen3.6-27b-mtp-nothink", "qwen3.6-chat-template"],
    ["qwen3.6-35b-mtp", "qwen3.6-chat-template"],
    ["qwen3.6-40B-Deckard-mtp", "qwen3.6-chat-template"],
    ["qwen3.8-27b-6000pro", "qwen3.8-chat-template"],
    ["qwen3.8-27b-mtp", "qwen3.8-chat-template"],
    ["qwen3.8-27b-mtp-nothink", "qwen3.8-chat-template"],
    ["qwen3.6-35b-a3b-mtp", "qwen3.6-chat-template"],
    ["qwen3.5-4b", "qwen3.5-chat-template"],
  ];

  it("matches the expected preset for every live + prospective id", () => {
    for (const [id, expected] of table) {
      expect(matchPreset(id)?.id ?? null, id).toBe(expected);
    }
  });
});

describe("catalog order (injected test-only catalog — shipped catalog untouched)", () => {
  const general: Preset = { id: "test-general", match: "qwen", reasoning: false };
  const specific: Preset = { id: "test-specific", match: "qwen3.8", reasoning: true };

  it("first-listed entry wins even when a later entry is more specific", () => {
    // Order IS the contract: no specificity scoring. The general entry is
    // listed first, so it must win for a qwen3.8 id.
    expect(matchPreset("qwen3.8-27b-6000pro", [general, specific])?.id).toBe("test-general");
  });

  it("reordering the catalog changes the winner (proving order is the contract)", () => {
    expect(matchPreset("qwen3.8-27b-6000pro", [specific, general])?.id).toBe("test-specific");
  });

  it("non-matching ids fall through the whole catalog", () => {
    expect(matchPreset("llama-3-70b", [general, specific])).toBeUndefined();
  });
});
