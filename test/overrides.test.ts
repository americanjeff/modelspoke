import { describe, expect, it } from "vitest";
import {
  NO_THINKING_LEVELS,
  cleanRoutePhantoms,
  compatForWrite,
  decodeRouteModels,
  effectiveOverrideEntry,
  entryFromLegacyId,
  entryOverride,
  foldLegacyOverrides,
  inputModalities,
  mergedOverrideEntry,
  normalizeModelEntry,
  overrideEntryMeaningful,
  routeOverridesOf,
  storeRoute,
  stripEntryPhantoms,
  stripMapPhantoms,
  topLevelOverridesOf,
} from "../src/overrides.js";
import {
  canonicalizeFields,
  canonicalizeThinkingLevelMap,
  resolveModel,
} from "../src/resolve/index.js";
import {
  ModelspokeConfigSchema,
  assertServiceable,
  overrideForRoute,
  routesOf,
} from "../src/dsh/settings.js";
import { normalizeOverrideEntry } from "../src/config/index.js";

describe("stripEntryPhantoms (the resolved-view materialization inverse)", () => {
  it("strips exactly the materialized empties and nothing else", () => {
    expect(
      stripEntryPhantoms({
        input: [],
        thinkingLevelMap: {},
        compat: { chatTemplateKwargs: {} },
        contextWindow: 262144,
        name: "keep",
      }),
    ).toEqual({ contextWindow: 262144, name: "keep" });
  });

  it("keeps a real empty compat that carries another field (chatTemplateKwargs strip only when empty)", () => {
    expect(stripEntryPhantoms({ compat: { chatTemplateKwargs: {}, thinkingFormat: "chat-template" } }))
      .toEqual({ compat: { thinkingFormat: "chat-template" } });
  });

  it("NEVER strips the explicit-none sentinel (a string, not a phantom)", () => {
    expect(stripEntryPhantoms({ input: [], thinkingLevelMap: NO_THINKING_LEVELS })).toEqual({
      thinkingLevelMap: "none",
    });
  });

  it("keeps a non-empty thinkingLevelMap verbatim (incl. an explicit off row)", () => {
    expect(stripEntryPhantoms({ thinkingLevelMap: { off: "low", minimal: null } })).toEqual({
      thinkingLevelMap: { off: "low", minimal: null },
    });
  });
});

describe("stripMapPhantoms / topLevelOverridesOf / routeOverridesOf (lenient readers)", () => {
  it("drops phantom-only entries; keeps real ones whole", () => {
    expect(
      stripMapPhantoms({
        "a": { input: [], thinkingLevelMap: {}, compat: { chatTemplateKwargs: {} } },
        "b": { contextWindow: 100 },
      }),
    ).toEqual({ b: { contextWindow: 100 } });
  });

  it("never throws on malformed input ({} for every shape)", () => {
    expect(stripMapPhantoms(undefined)).toEqual({});
    expect(stripMapPhantoms(null as unknown as Record<string, unknown>)).toEqual({});
    expect(topLevelOverridesOf(undefined)).toEqual({});
    expect(topLevelOverridesOf({ overrides: "nope" })).toEqual({});
    expect(routeOverridesOf(undefined, "r")).toEqual({});
    expect(routeOverridesOf({ routes: ["nope"] }, "r")).toEqual({});
    expect(routeOverridesOf({ routes: [{ name: "r", overrides: "nope" }] }, "r")).toEqual({});
  });

  it("routeOverridesOf finds the NAMED route's map (first match on name)", () => {
    const section = {
      routes: [
        { name: "a", overrides: { "m1": {} } },
        { name: "b", overrides: { "m2": { contextWindow: 1 } } },
      ],
    };
    expect(routeOverridesOf(section, "b")).toEqual({ m2: { contextWindow: 1 } });
    expect(routeOverridesOf(section, "c")).toEqual({});
  });
});

describe("cleanRoutePhantoms (writers' route normalization)", () => {
  it("drops materialized models: [] and overrides: {} but keeps real values", () => {
    expect(
      cleanRoutePhantoms({
        name: "a",
        baseURL: "http://x/v1",
        models: [],
        overrides: {},
        defaultEffort: "medium",
      }),
    ).toEqual({ name: "a", baseURL: "http://x/v1", defaultEffort: "medium" });
  });

  it("phantom-strips the entries of a NON-EMPTY route overrides map (the nested phantom invariant)", () => {
    expect(
      cleanRoutePhantoms({
        name: "a",
        overrides: { "m1": { input: [], contextWindow: 5, thinkingLevelMap: {} } },
      }),
    ).toEqual({ name: "a", overrides: { m1: { contextWindow: 5 } } });
  });

  it("keeps the 'none' sentinel inside a route map (explicit none is not a phantom)", () => {
    expect(cleanRoutePhantoms({ name: "a", overrides: { m1: { thinkingLevelMap: "none" } } })).toEqual({
      name: "a",
      overrides: { m1: { thinkingLevelMap: "none" } },
    });
  });
});

describe("inputModalities (always explicit, never the [] phantom)", () => {
  it("image support ON → [text, image] (canonical order: text first)", () => {
    expect(inputModalities(true)).toEqual(["text", "image"]);
  });

  it("image support OFF → [text] (text-only is PINNED, not released)", () => {
    expect(inputModalities(false)).toEqual(["text"]);
  });

  it("NEVER [] (an empty array canonicalizes to absent — the phantom)", () => {
    expect(inputModalities(false).length).toBeGreaterThan(0);
  });
});

describe("compatForWrite (the whole-block rule: deep fields materialized verbatim)", () => {
  const PRESET_DEEP = {
    supportsDeveloperRole: false,
    thinkingFormat: "chat-template" as const,
    chatTemplateKwargs: {
      enable_thinking: { $var: "thinking.enabled" },
      reasoning_effort: { $var: "thinking.effort", omitWhenOff: true },
      preserve_thinking: true,
    },
  };
  const PRESET_COMPAT = { ...PRESET_DEEP, supportsReasoningEffort: false };

  it("no entry compat + no preset + effort OFF → undefined (release the field; {} would be a phantom)", () => {
    expect(compatForWrite({}, null, false)).toBeUndefined();
    expect(compatForWrite(null, undefined, false)).toBeUndefined();
    expect(compatForWrite(undefined, undefined, false)).toBeUndefined();
  });

  it("no entry compat + no preset + effort ON → exactly { supportsReasoningEffort: true }", () => {
    expect(compatForWrite({}, null, true)).toEqual({ supportsReasoningEffort: true });
    expect(compatForWrite({ input: ["text"] }, undefined, true)).toEqual({ supportsReasoningEffort: true });
  });

  it("an existing compat's deep fields survive VERBATIM next to the pin ($var objects byte-identical, no re-serialization)", () => {
    const kwargs = {
      enable_thinking: { $var: "thinking.enabled" },
      reasoning_effort: { $var: "thinking.effort", omitWhenOff: true },
      preserve_thinking: true,
    };
    const entry = { compat: { ...PRESET_DEEP, chatTemplateKwargs: kwargs, supportsReasoningEffort: false } };
    const out = compatForWrite(entry, null, true);
    expect(out).toEqual({ ...PRESET_DEEP, chatTemplateKwargs: kwargs, supportsReasoningEffort: true });
    expect((out as Record<string, unknown>).chatTemplateKwargs).toBe(kwargs);
    expect(Object.keys(out as Record<string, unknown>).sort()).toEqual([
      "chatTemplateKwargs",
      "supportsDeveloperRole",
      "supportsReasoningEffort",
      "thinkingFormat",
    ]);
  });

  it("effort OFF still PINS explicit false when deep fields are present (a lower tier's true must not leak through)", () => {
    const entry = { compat: { thinkingFormat: "qwen", supportsReasoningEffort: true } };
    expect(compatForWrite(entry, null, false)).toEqual({ thinkingFormat: "qwen", supportsReasoningEffort: false });
  });

  it("an entry compat carrying ONLY supportsReasoningEffort is a no-deep block: OFF releases, ON pins alone", () => {
    expect(compatForWrite({ compat: { supportsReasoningEffort: true } }, null, false)).toBeUndefined();
    expect(compatForWrite({ compat: { supportsReasoningEffort: false } }, null, true)).toEqual({ supportsReasoningEffort: true });
  });

  it("empty base + preset deep block → the PRESET's deep fields are materialized (the displayed value was seeded from it)", () => {
    const out = compatForWrite({}, PRESET_COMPAT as unknown as Record<string, unknown>, true);
    expect(out).toEqual({ ...PRESET_DEEP, supportsReasoningEffort: true });
    // Deep fields come from the preset verbatim (incl. its own false); only the
    // supportsReasoningEffort pin takes the form's value, not the preset's false.
    expect((out as Record<string, unknown>).supportsDeveloperRole).toBe(false);
    expect((out as Record<string, unknown>).supportsReasoningEffort).toBe(true);
  });

  it("empty base + preset carrying ONLY supportsReasoningEffort → behaves as no preset (OFF releases, ON pins alone)", () => {
    const sreOnly = { supportsReasoningEffort: false };
    expect(compatForWrite({}, sreOnly as unknown as Record<string, unknown>, false)).toBeUndefined();
    expect(compatForWrite({}, sreOnly as unknown as Record<string, unknown>, true)).toEqual({ supportsReasoningEffort: true });
  });

  it("a NON-EMPTY entry compat wins over the preset (the user's block is the base; the preset only fills when base is empty)", () => {
    const out = compatForWrite(
      { compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, thinkingFormat: "chat-template", chatTemplateKwargs: { preserve_thinking: true } } },
      PRESET_COMPAT as unknown as Record<string, unknown>,
      true,
    );
    expect(out).toEqual({
      supportsDeveloperRole: false,
      thinkingFormat: "chat-template",
      chatTemplateKwargs: { preserve_thinking: true },
      supportsReasoningEffort: true,
    });
  });

  it("malformed compat values read as absent (lenient, never throws)", () => {
    expect(compatForWrite({ compat: "nope" }, null, false)).toBeUndefined();
    expect(compatForWrite({ compat: ["nope"] }, null, false)).toBeUndefined();
    expect(compatForWrite({ compat: null }, "nope" as unknown as Record<string, unknown>, true)).toEqual({
      supportsReasoningEffort: true,
    });
  });
});

describe("overrideEntryMeaningful (the empty-entry guard — input is written every save, so key-count is dead)", () => {
  const BASE = {
    name: "",
    contextWindow: "",
    maxTokens: "",
    tlRowCount: 0,
    nothink: false,
    compat: undefined,
    imageInputToggled: false,
  };

  it("an untouched draft (everything released, modality at its displayed default) is NOT meaningful", () => {
    expect(overrideEntryMeaningful(BASE)).toBe(false);
  });

  it("each meaningful field alone makes the draft meaningful", () => {
    expect(overrideEntryMeaningful({ ...BASE, name: "My model" })).toBe(true);
    expect(overrideEntryMeaningful({ ...BASE, contextWindow: "1000" })).toBe(true);
    expect(overrideEntryMeaningful({ ...BASE, maxTokens: "100" })).toBe(true);
    expect(overrideEntryMeaningful({ ...BASE, tlRowCount: 1 })).toBe(true);
    expect(overrideEntryMeaningful({ ...BASE, nothink: true })).toBe(true);
    expect(overrideEntryMeaningful({ ...BASE, compat: { supportsReasoningEffort: true } })).toBe(true);
    expect(overrideEntryMeaningful({ ...BASE, imageInputToggled: true })).toBe(true);
  });

  it("blank (whitespace) text fields do not count; an undefined compat does not count", () => {
    expect(overrideEntryMeaningful({ ...BASE, name: "   ", contextWindow: "  ", maxTokens: " " })).toBe(false);
    expect(overrideEntryMeaningful({ ...BASE, compat: undefined })).toBe(false);
  });
});

describe("effectiveOverrideEntry (the per-field route-wins dual-shape read)", () => {
  const LEGACY = { m: { name: "legacy", contextWindow: 100, maxTokens: 200, compat: { thinkingFormat: "chat-template" } } };
  const ROUTE = { m: { contextWindow: 999, thinkingLevelMap: { off: "low" } } };

  it("route entry wins PER FIELD; the legacy entry fills the rest", () => {
    expect(mergedOverrideEntry(LEGACY as Record<string, unknown>, ROUTE as Record<string, unknown>, "m")).toEqual({
      name: "legacy",
      contextWindow: 999,
      maxTokens: 200,
      compat: { thinkingFormat: "chat-template" }, // legacy fills (whole block — one unit)
      thinkingLevelMap: { off: "low" },
    });
  });

  it("the explicit-none route entry beats the legacy levels (the nothink decision wins)", () => {
    const legacy = { m: { thinkingLevelMap: { off: "low", medium: "medium" } } };
    const route = { m: { thinkingLevelMap: "none" } };
    expect(mergedOverrideEntry(legacy as Record<string, unknown>, route as Record<string, unknown>, "m"))
      .toEqual({ thinkingLevelMap: "none" });
  });

  it("legacy-only and route-only each resolve alone; both absent → undefined", () => {
    expect(mergedOverrideEntry(LEGACY as Record<string, unknown>, {}, "m")).toEqual(LEGACY.m);
    expect(mergedOverrideEntry({}, ROUTE as Record<string, unknown>, "m")).toEqual(ROUTE.m);
    expect(mergedOverrideEntry({}, {}, "m")).toBeUndefined();
    expect(mergedOverrideEntry(undefined, undefined, "m")).toBeUndefined();
  });

  it("a phantom-only entry resolves to nothing (the phantom invariant carried into the merge)", () => {
    expect(
      mergedOverrideEntry(
        { m: { input: [], thinkingLevelMap: {}, compat: { chatTemplateKwargs: {} } } },
        {},
        "m",
      ),
    ).toBeUndefined();
  });

  it("reads the dual shape from a SECTION (top-level + per-route, or one shape alone)", () => {
    const both = {
      routes: [{ name: "r", overrides: ROUTE as unknown }],
      overrides: LEGACY as unknown,
    };
    expect(effectiveOverrideEntry(both, "r", "m")).toEqual({
      name: "legacy",
      contextWindow: 999,
      maxTokens: 200,
      compat: { thinkingFormat: "chat-template" },
      thinkingLevelMap: { off: "low" },
    });
    // The legacy entry resolves on EVERY route (the pre-fold read semantics:
    // a top-level entry was global).
    expect(effectiveOverrideEntry(both, "other-route", "m")).toEqual(LEGACY.m);
    expect(effectiveOverrideEntry({ overrides: LEGACY as unknown }, "r", "m")).toEqual(LEGACY.m);
  });
});

describe("foldLegacyOverrides (first-write-folds, values byte-preserved)", () => {
  const ENTRY = { contextWindow: 262144, maxTokens: 65536, name: "kept" };

  it("single route: EVERY legacy entry folds into it; empty leftover → the key is dropped", () => {
    const { routes, leftover, folded } = foldLegacyOverrides({
      routes: [{ name: "spoke-live", baseURL: "http://127.0.0.1:8080/v1" }],
      overrides: { "m1": ENTRY, "m2": { maxTokens: 1 } },
    });
    expect(folded).toBe(2);
    expect(leftover).toEqual({});
    const route = routes[0] as Record<string, unknown>;
    expect(route.overrides).toEqual({ "m1": ENTRY, "m2": { maxTokens: 1 } });
  });

  it("byte preservation: resolved-view materialized phantoms fold back to the STORED form", () => {
    // The settings seam hands writers the schema-RESOLVED section: the stored
    // { contextWindow: 262144 } entry arrives with materialized empties.
    const { routes, leftover } = foldLegacyOverrides({
      routes: [{ name: "r", baseURL: "http://x/v1" }],
      overrides: { m: { contextWindow: 262144, input: [], thinkingLevelMap: {}, compat: { chatTemplateKwargs: {} } } },
    });
    expect(leftover).toEqual({});
    expect((routes[0] as Record<string, unknown>).overrides).toEqual({ m: { contextWindow: 262144 } });
  });

  it("the explicit-none entry folds as the string (never re-phantomed)", () => {
    const { routes, leftover } = foldLegacyOverrides({
      routes: [{ name: "r", baseURL: "http://x/v1" }],
      overrides: { m: { thinkingLevelMap: "none", contextWindow: 128000 } },
    });
    expect(leftover).toEqual({});
    expect((routes[0] as Record<string, unknown>).overrides).toEqual({
      m: { thinkingLevelMap: "none", contextWindow: 128000 },
    });
  });

  it("per-field route-wins where the route already carries the id", () => {
    const { routes, leftover } = foldLegacyOverrides({
      routes: [{ name: "r", baseURL: "http://x/v1", overrides: { m: { contextWindow: 1, maxTokens: 9 } } }],
      overrides: { m: { contextWindow: 2, name: "legacy" } },
    });
    expect(leftover).toEqual({});
    expect((routes[0] as Record<string, unknown>).overrides).toEqual({
      m: { contextWindow: 1, maxTokens: 9, name: "legacy" },
    });
  });

  it("multi-route: a curated-list claim folds the entry into the claiming route", () => {
    const { routes, leftover, folded } = foldLegacyOverrides({
      routes: [
        { name: "alpha", baseURL: "http://x/v1" },
        { name: "beta", baseURL: "http://y/v1", models: ["claimed"] },
      ],
      overrides: { claimed: { contextWindow: 1 } },
    });
    expect(folded).toBe(1);
    expect(leftover).toEqual({});
    const beta = routes[1] as Record<string, unknown>;
    const alpha = routes[0] as Record<string, unknown>;
    expect(beta.overrides).toEqual({ claimed: { contextWindow: 1 } });
    expect(alpha.overrides).toBeUndefined();
  });

  it("multi-route, MULTIPLE claimants: the FIRST claimant in configuration order wins (documented choice)", () => {
    const { routes, leftover } = foldLegacyOverrides({
      routes: [
        { name: "first", baseURL: "http://x/v1", models: ["dup"] },
        { name: "second", baseURL: "http://y/v1", models: ["dup"] },
      ],
      overrides: { dup: { contextWindow: 1 } },
    });
    expect(leftover).toEqual({});
    expect((routes[0] as Record<string, unknown>).overrides).toEqual({ dup: { contextWindow: 1 } });
    expect((routes[1] as Record<string, unknown>).overrides).toBeUndefined();
  });

  it("multi-route, NO claimant: the entry stays in the leftover (the key is kept)", () => {
    const { leftover, folded } = foldLegacyOverrides({
      routes: [
        { name: "alpha", baseURL: "http://x/v1" },
        { name: "beta", baseURL: "http://y/v1" },
      ],
      overrides: { unclaimed: { contextWindow: 1 } },
    });
    expect(folded).toBe(0);
    expect(leftover).toEqual({ unclaimed: { contextWindow: 1 } });
  });

  it("a route with a curated list does NOT claim ids outside it; an uncurated route claims nothing", () => {
    const { leftover, folded } = foldLegacyOverrides({
      routes: [
        { name: "alpha", baseURL: "http://x/v1", models: ["only-this"] },
        { name: "beta", baseURL: "http://y/v1" },
      ],
      overrides: { "only-this": { a: 1 }, "someone-else": { b: 2 } },
    });
    expect(folded).toBe(1);
    expect(leftover).toEqual({ "someone-else": { b: 2 } });
  });

  it("no routes: nothing folds, everything is leftover (the key is kept)", () => {
    const { leftover, folded, routes } = foldLegacyOverrides({
      routes: [],
      overrides: { m: { contextWindow: 1 } },
    });
    expect(folded).toBe(0);
    expect(routes).toEqual([]);
    expect(leftover).toEqual({ m: { contextWindow: 1 } });
  });

  it("no legacy entries: routes pass through clean, nothing to fold", () => {
    const { routes, leftover, folded } = foldLegacyOverrides({
      routes: [
        { name: "r", baseURL: "http://x/v1", models: [], overrides: {} }, // resolved-view phantoms
      ],
    });
    expect(folded).toBe(0);
    expect(leftover).toEqual({});
    expect(routes).toEqual([{ name: "r", baseURL: "http://x/v1" }]);
  });

  it("malformed routes pass through (the fold never drops data) and don't count toward the ownership rules", () => {
    const { routes, leftover, folded } = foldLegacyOverrides({
      routes: [{ name: "r", baseURL: "http://x/v1" }, "junk"],
      overrides: { ok: { contextWindow: 1 } },
    });
    // One VALID route → the single-route rule applies (the junk entry is
    // invisible to it); the junk itself rides through untouched.
    expect(folded).toBe(1);
    expect(leftover).toEqual({});
    expect(routes).toEqual([{ name: "r", baseURL: "http://x/v1", overrides: { ok: { contextWindow: 1 } } }, "junk"]);
  });
});

describe("ModelspokeConfigSchema — dual shape + the nothink sentinel", () => {
  it("accepts the legacy top-level shape (unchanged)", () => {
    const resolved = ModelspokeConfigSchema({
      routes: [{ name: "r", baseURL: "http://x/v1" }],
      overrides: { m: { contextWindow: 1 } },
    });
    expect((resolved.routes as Record<string, unknown>[])[0].name).toBe("r");
    expect((resolved.overrides as Record<string, unknown>).m).toBeDefined();
  });

  it("accepts per-route routes[].overrides with the exact entry shape", () => {
    const resolved = ModelspokeConfigSchema({
      routes: [
        {
          name: "r",
          baseURL: "http://x/v1",
          overrides: {
            m: { contextWindow: 1, thinkingLevelMap: { off: "low", medium: "medium" } },
          },
        },
      ],
    });
    const route = (resolved.routes as Record<string, unknown>)[0];
    // The resolved view materializes the empty defaults on the nested entry
    // too (input: [] / compat: {chatTemplateKwargs: {}}) — the phantom
    // inverse strips them at the writers.
    expect((route.overrides as Record<string, unknown>).m).toEqual({
      contextWindow: 1,
      thinkingLevelMap: { off: "low", medium: "medium" },
      input: [],
      compat: { chatTemplateKwargs: {} },
    });
  });

  it("accepts the explicit-none sentinel on BOTH shapes", () => {
    const nested = ModelspokeConfigSchema({
      routes: [{ name: "r", baseURL: "http://x/v1", overrides: { m: { thinkingLevelMap: "none" } } }],
    });
    expect((nested.routes as Record<string, unknown>)[0]).toMatchObject({
      overrides: { m: { thinkingLevelMap: "none" } },
    });
    const top = ModelspokeConfigSchema({ overrides: { m: { thinkingLevelMap: "none" } } });
    expect((top.overrides as Record<string, unknown>).m).toMatchObject({ thinkingLevelMap: "none" });
  });

  it("rejects an invalid thinkingLevelMap value (bad level key / non-sentinel string)", () => {
    expect(() =>
      ModelspokeConfigSchema({
        routes: [{ name: "r", baseURL: "http://x/v1", overrides: { m: { thinkingLevelMap: { wibbly: "x" } } } }],
      }),
    ).toThrow();
    expect(() =>
      ModelspokeConfigSchema({
        routes: [{ name: "r", baseURL: "http://x/v1", overrides: { m: { thinkingLevelMap: "all" } } } ],
      }),
    ).toThrow();
  });

  it("refuses a legacy string allow-list `models` (the entry array is the only accepted shape)", () => {
    expect(() =>
      ModelspokeConfigSchema({
        routes: [{ name: "r", baseURL: "http://x/v1", models: ["a", "b"] }],
      }),
    ).toThrow();
    const resolved = ModelspokeConfigSchema({
      routes: [{ name: "r", baseURL: "http://x/v1", models: [{ name: "a", id: "a" }] }],
    });
    expect((resolved.routes as Record<string, unknown>)[0]).toBeDefined();
  });

  it("routesOf carries the per-route map through as legacyOverrides (non-empty plain object only; FULL_CATALOG)", () => {
    const section = ModelspokeConfigSchema({
      routes: [
        { name: "r", baseURL: "http://x/v1", overrides: { m: { contextWindow: 1 } } },
        { name: "s", baseURL: "http://y/v1" },
      ],
    });
    const routes = routesOf(section);
    // The union-typed thinkingLevelMap gets no materialized default (schemastery
    // skips union fields), so an absent map stays absent — unlike the dict fields.
    expect(routes[0].models).toBeNull();
    expect(routes[0].legacyOverrides).toEqual({ m: { contextWindow: 1, input: [], compat: { chatTemplateKwargs: {} } } });
    expect(routes[1].models).toBeNull();
    expect(routes[1].legacyOverrides).toBeUndefined();
  });

  it("overrideForRoute: per-route wins over legacy; legacy alone still resolves (dual shape)", () => {
    const both = {
      routes: [{ name: "r", baseURL: "http://x/v1", overrides: { m: { contextWindow: 999 } } }],
      overrides: { m: { contextWindow: 111, name: "legacy" } },
    };
    expect(overrideForRoute(both, "r", "m")).toEqual({ contextWindow: 999, name: "legacy" });
    expect(overrideForRoute(both, "other", "m")).toEqual({ contextWindow: 111, name: "legacy" });
    expect(overrideForRoute(both, "r", "absent")).toBeUndefined();
  });
});

describe("canonical boundary — the 'none' sentinel", () => {
  it("canonicalizeThinkingLevelMap: 'none' → present-empty map; {} object → undefined (phantom)", () => {
    expect(canonicalizeThinkingLevelMap("none")).toEqual({});
    expect(canonicalizeThinkingLevelMap({})).toBeUndefined();
    expect(canonicalizeThinkingLevelMap({ off: "low" })).toEqual({ off: "low" });
    expect(canonicalizeThinkingLevelMap("all")).toBeUndefined();
    expect(canonicalizeThinkingLevelMap(null)).toBeUndefined();
  });

  it("canonicalizeFields keeps the present-EMPTY marker (the 'none' path) but not the phantom", () => {
    expect(canonicalizeFields({ thinkingLevelMap: "none" })).toEqual({ thinkingLevelMap: {} });
    expect(canonicalizeFields({ thinkingLevelMap: {} })).toBeUndefined();
  });
});

describe("resolveModel — the tier-1 explicit-none expansion (the nothink case)", () => {
  const LEVELS = { off: "low", low: "low", medium: "medium", xhigh: "xhigh" };
  // A qwen3.8-shaped id: the preset qwen3.8-chat-template supplies
  // reasoning: true + levels + the chat-template compat.

  it("declares 'none' → the model serves WITHOUT a reasoning dimension, both fields sourced user + the nothink marker", () => {
    const { resolved, sources, nothink } = resolveModel({
      modelId: "qwen3.8-27b-6000pro",
      userOverride: { thinkingLevelMap: "none", contextWindow: 32768 },
    });
    expect(nothink).toBe(true);
    expect(resolved.reasoning).toBe(false);
    expect(resolved.thinkingLevelMap).toEqual({});
    expect(sources.reasoning).toBe("user");
    expect(sources.thinkingLevelMap).toBe("user");
    expect(sources.contextWindow).toBe("user");
    expect(resolved.contextWindow).toBe(32768);
    expect(resolved.thinkingLevelMap).not.toEqual(LEVELS);
  });

  it("beats DISCOVERY levels too (endpoint truth yields to the user's declaration)", () => {
    const { resolved, sources, nothink } = resolveModel({
      modelId: "qwen3.8-27b-6000pro",
      userOverride: { thinkingLevelMap: "none" },
      discovery: { id: "qwen3.8-27b-6000pro", discoveredCanonical: { reasoning: true, thinkingLevelMap: LEVELS } },
    });
    expect(nothink).toBe(true);
    expect(resolved.reasoning).toBe(false);
    expect(resolved.thinkingLevelMap).toEqual({});
    expect(sources.thinkingLevelMap).toBe("user");
    expect(sources.reasoning).toBe("user");
  });

  it("an explicit 'none' wins over an explicit reasoning: true in the SAME entry (the declaration is stronger)", () => {
    const { resolved, nothink } = resolveModel({
      modelId: "qwen3.8-27b-6000pro",
      userOverride: { thinkingLevelMap: "none", reasoning: true },
    });
    expect(nothink).toBe(true);
    expect(resolved.reasoning).toBe(false);
  });

  it("an explicit LEVELS entry keeps the model reasoning (no expansion)", () => {
    const { resolved, nothink } = resolveModel({
      modelId: "qwen3.8-27b-6000pro",
      userOverride: { thinkingLevelMap: { off: "low" } },
    });
    expect(nothink).toBeUndefined();
    expect(resolved.reasoning).toBe(true);
    expect(resolved.thinkingLevelMap).toEqual({ off: "low" });
    expect(resolved.thinkingLevelMap !== undefined).toBe(true);
  });

  it("resolver boundary contract: a present-EMPTY map on the (canonicalized) input IS the sentinel's canonical form → expansion", () => {
    // Both hosts canonicalize before calling, so a present-empty map here is only
    // the sentinel's canonical form (a stored {} is already absent — see below).
    const { resolved, nothink } = resolveModel({
      modelId: "qwen3.8-27b-6000pro",
      userOverride: { thinkingLevelMap: {} },
    });
    expect(nothink).toBe(true);
    expect(resolved.reasoning).toBe(false);
  });

  it("a STORED {} object never reaches the resolver as {}: normalizeOverrideEntry canonicalizes it to absent (the phantom invariant, at its real layer)", () => {
    const normalized = normalizeOverrideEntry({ thinkingLevelMap: {}, contextWindow: 123 });
    expect(normalized).toBeDefined();
    expect(normalized.thinkingLevelMap).toBeUndefined();
    const { resolved, sources, nothink } = resolveModel({
      modelId: "qwen3.8-27b-6000pro",
      userOverride: normalized,
    });
    expect(nothink).toBeUndefined();
    expect(resolved.reasoning).toBe(true);
    expect(sources.thinkingLevelMap).toBe("preset:qwen3.8-chat-template");
  });

  it("the same stored {} through the dsh section read path (overrideForRoute) stays a phantom", () => {
    const section = {
      routes: [{ name: "r", baseURL: "http://x/v1", overrides: { "nothink-model": { thinkingLevelMap: "none" } } }],
      overrides: { "phantom-model": { thinkingLevelMap: {}, contextWindow: 44 } },
    };
    const nothinkEntry = overrideForRoute(section, "r", "nothink-model");
    expect(nothinkEntry?.thinkingLevelMap).toEqual({});
    const phantomEntry = overrideForRoute(section, "r", "phantom-model");
    expect(phantomEntry?.thinkingLevelMap).toBeUndefined();
    expect(phantomEntry?.contextWindow).toBe(44);
  });

  it("an entry with ONLY 'none' still counts as a tier-1 entry (nothing else to drop)", () => {
    const { resolved, sources } = resolveModel({ modelId: "bare-model", userOverride: { thinkingLevelMap: "none" } });
    expect(resolved.reasoning).toBe(false);
    expect(sources.reasoning).toBe("user");
    expect(resolved.input).toEqual(["text"]);
  });

  it("the ordinary resolution is unchanged (no nothink marker, absent stays absent)", () => {
    const { resolved, sources, nothink } = resolveModel({ modelId: "qwen3.8-27b-6000pro" });
    expect(nothink).toBeUndefined();
    expect(resolved.reasoning).toBe(true);
    expect(resolved.thinkingLevelMap).toEqual(LEVELS);
    expect(sources.thinkingLevelMap).toBe("preset:qwen3.8-chat-template");
    const bare = resolveModel({ modelId: "gemma-4-E4B-it" });
    expect(bare.nothink).toBeUndefined();
    expect(bare.resolved.thinkingLevelMap).toBeUndefined();
  });
});

describe("normalizeModelEntry / entryFromLegacyId (dual-shape element readers)", () => {
  it("new shape: a missing/blank name defaults to the wire id; the entry is WHOLE", () => {
    expect(normalizeModelEntry({ id: "a" })).toEqual({ name: "a", id: "a" });
    expect(normalizeModelEntry({ id: "a", name: "" })).toEqual({ name: "a", id: "a" });
    expect(
      normalizeModelEntry({ id: "a", name: "A", contextWindow: 100, defaultEffort: "high" }),
    ).toEqual({ name: "A", id: "a", contextWindow: 100, defaultEffort: "high" });
    const deep = { id: "a", compat: { chatTemplateKwargs: { k: { $var: "thinking.effort", omitWhenOff: true } } } };
    expect(normalizeModelEntry(deep)).toEqual({
      name: "a",
      id: "a",
      compat: deep.compat,
    });
  });

  it("new shape: malformed elements read as undefined (never thrown)", () => {
    expect(normalizeModelEntry(undefined)).toBeUndefined();
    expect(normalizeModelEntry("a")).toBeUndefined();
    expect(normalizeModelEntry({})).toBeUndefined();
    expect(normalizeModelEntry({ id: "" })).toBeUndefined();
    expect(normalizeModelEntry({ id: 42 })).toBeUndefined();
  });

  it("schema-resolved phantoms are stripped (the empty compat must not override the preset's)", () => {
    const resolved = {
      name: "qwen3.8-27b-6000pro",
      id: "qwen3.8-27b-6000pro",
      input: [],
      compat: { chatTemplateKwargs: {} },
    };
    expect(normalizeModelEntry(resolved)).toEqual({ name: "qwen3.8-27b-6000pro", id: "qwen3.8-27b-6000pro" });
    expect(entryOverride(normalizeModelEntry(resolved))).toBeUndefined();
    // A REAL compat survives the strip (only the empty-object shape is a phantom).
    const real = {
      id: "a",
      input: [],
      compat: { chatTemplateKwargs: {}, thinkingFormat: "chat-template" },
    };
    expect(normalizeModelEntry(real)).toEqual({
      name: "a",
      id: "a",
      compat: { thinkingFormat: "chat-template" },
    });
    // The explicit-none empty thinkingLevelMap is state, not a phantom — kept.
    expect(normalizeModelEntry({ id: "a", thinkingLevelMap: NO_THINKING_LEVELS })).toEqual({
      name: "a",
      id: "a",
      thinkingLevelMap: NO_THINKING_LEVELS,
    });
  });

  it("REGRESSION (live 2026-08-26): the schema-resolved section resolves a bare entry through the PRESET compat, not the materialized phantom", () => {
    const resolved = ModelspokeConfigSchema({
      routes: [
        {
          name: "llama-swap",
          baseURL: "http://localhost:8080/v1",
          models: [{ name: "qwen3.8-27b-6000pro", id: "qwen3.8-27b-6000pro" }],
        },
      ],
    });
    const [route] = routesOf(resolved);
    const entry = route.models![0]!;
    expect(resolved.routes[0]!.models[0]).toMatchObject({
      input: [],
      compat: { chatTemplateKwargs: {} },
    });
    expect(entryOverride(entry)).toBeUndefined();
    const { resolved: model, sources } = resolveModel({
      modelId: entry.id,
      userOverride: entryOverride(entry),
      discovery: undefined,
    });
    expect(sources.compat).toBe("preset:qwen3.8-chat-template");
    expect(model.compat).toMatchObject({
      thinkingFormat: "chat-template",
      supportsReasoningEffort: false,
      supportsDeveloperRole: false,
    });
    expect(model.compat?.chatTemplateKwargs).toMatchObject({
      enable_thinking: { $var: "thinking.enabled" },
      reasoning_effort: { $var: "thinking.effort", omitWhenOff: true },
      preserve_thinking: true,
    });
  });

  it("old shape: name === id + the id's legacy config, WHOLE minus the cosmetic name", () => {
    expect(entryFromLegacyId("m", undefined)).toEqual({ name: "m", id: "m" });
    expect(entryFromLegacyId("m", { m: { contextWindow: 1 } })).toEqual({
      name: "m",
      id: "m",
      contextWindow: 1,
    });
    expect(entryFromLegacyId("m", { m: { name: "Pretty", maxTokens: 5 } })).toEqual({
      name: "m",
      id: "m",
      maxTokens: 5,
    });
    expect(entryFromLegacyId("m", { m: "nope" })).toEqual({ name: "m", id: "m" });
  });
});

describe("decodeRouteModels (the dual-shape lenient reader)", () => {
  it("new shape: entry array → entries in order (name defaults to id; non-object elements skipped)", () => {
    expect(
      decodeRouteModels({
        models: [{ id: "a", name: "A", contextWindow: 1 }, { id: "b" }, "junk", 42],
      }),
    ).toEqual({
      models: [
        { name: "A", id: "a", contextWindow: 1 },
        { name: "b", id: "b" },
      ],
    });
  });

  it("legacy string allow-list degrades to FULL_CATALOG (allow-list ignored, the overrides map is kept)", () => {
    expect(
      decodeRouteModels({ models: ["a", "b"], overrides: { b: { name: "Pretty", maxTokens: 5 } } }),
    ).toEqual({
      models: null,
      legacyOverrides: { b: { name: "Pretty", maxTokens: 5 } },
    });
  });

  it("no entry element → FULL_CATALOG (a string allow-list or all-malformed array degrades; the overrides map is kept)", () => {
    expect(decodeRouteModels({ models: ["a", null, 3, { name: "no-id" }] })).toEqual({
      models: null,
    });
    expect(decodeRouteModels({ models: [null, 3, { name: "no-id" }], overrides: { m: { contextWindow: 1 } } })).toEqual({
      models: null,
      legacyOverrides: { m: { contextWindow: 1 } },
    });
  });

  it("FULL_CATALOG: absent / empty models → models null + the raw overrides map as legacyOverrides", () => {
    expect(decodeRouteModels({})).toEqual({ models: null });
    expect(decodeRouteModels({ models: [] })).toEqual({ models: null });
    expect(decodeRouteModels({ models: "junk" })).toEqual({ models: null });
    expect(decodeRouteModels({ models: [], overrides: { m: { contextWindow: 1 } } })).toEqual({
      models: null,
      legacyOverrides: { m: { contextWindow: 1 } },
    });
    expect(decodeRouteModels({ overrides: {} })).toEqual({ models: null });
    expect(decodeRouteModels({ overrides: "junk" })).toEqual({ models: null });
  });

  it("new shape: no legacyOverrides (the entries carry the config)", () => {
    expect("legacyOverrides" in decodeRouteModels({ models: [{ id: "a" }] })).toBe(false);
  });

  it("all-malformed elements (empty id / non-object) degrade to FULL_CATALOG, not an explicit empty set", () => {
    expect(decodeRouteModels({ models: [{ id: "" }] })).toEqual({ models: null });
    expect(decodeRouteModels({ models: [{ id: "" }, "junk", 42] })).toEqual({ models: null });
    expect(
      decodeRouteModels({ models: [{ id: "" }], overrides: { m: { contextWindow: 1 } } }),
    ).toEqual({ models: null, legacyOverrides: { m: { contextWindow: 1 } } });
  });
});

describe("entryOverride (the entry's tier-1)", () => {
  it("strips the identity fields and canonicalizes the rest", () => {
    expect(
      entryOverride({ name: "A", id: "a", defaultEffort: "high", contextWindow: 100, input: ["image", "text"] }),
    ).toEqual({ contextWindow: 100, input: ["text", "image"] });
  });

  it("a {name, id}-only entry reads as no user config", () => {
    expect(entryOverride({ name: "A", id: "a" })).toBeUndefined();
    expect(entryOverride(undefined)).toBeUndefined();
    expect(entryOverride("junk")).toBeUndefined();
  });

  it("preserves the nothink sentinel through canonicalization (present-empty map)", () => {
    expect(entryOverride({ name: "A", id: "a", thinkingLevelMap: "none" })).toEqual({
      thinkingLevelMap: {},
    });
  });
});

describe("storeRoute (the byte-preserving route writer)", () => {
  it("explicit: writes the entries (identity leading, phantom-stripped) and NO overrides key", () => {
    const stored = storeRoute(
      {
        name: "r",
        baseURL: "http://x/v1",
        models: [
          { name: "A", id: "a", defaultEffort: "high", input: [], thinkingLevelMap: {}, contextWindow: 100 } as never,
          { name: "B", id: "b" } as never,
        ],
      },
      { name: "old", baseURL: "http://old/v1", overrides: { a: { contextWindow: 9 } }, unknownKey: "keep" },
    );
    expect(stored).toEqual({
      name: "r",
      baseURL: "http://x/v1",
      unknownKey: "keep",
      models: [
        { name: "A", id: "a", defaultEffort: "high", contextWindow: 100 },
        { name: "B", id: "b" },
      ],
    });
    expect("overrides" in stored).toBe(false);
  });

  it("explicit: an entry with an empty name or id is skipped; an empty set collapses to FULL_CATALOG (no models key)", () => {
    const stored = storeRoute(
      { name: "r", baseURL: "http://x/v1", models: [{ name: "", id: "a" }, { name: "B", id: "" }] as never },
      null,
    );
    expect(stored).toEqual({ name: "r", baseURL: "http://x/v1" });
  });

  it("explicit: a cleared apiKeyEnv deletes the committed key; a stale route-level defaultEffort (field removed) is deleted", () => {
    const stored = storeRoute(
      { name: "r", baseURL: "http://x/v1", models: [{ name: "A", id: "a" }] },
      { name: "r", baseURL: "http://x/v1", apiKeyEnv: "K", defaultEffort: "high" },
    );
    expect("apiKeyEnv" in stored).toBe(false);
    expect("defaultEffort" in stored).toBe(false);
  });

  it("FULL_CATALOG: an untouched route round-trips its EXACT stored bytes (models + overrides byte-for-byte)", () => {
    const committed = {
      name: "r",
      baseURL: "http://x/v1",
      apiKeyEnv: "K",
      overrides: {
        m: { contextWindow: 1, compat: { chatTemplateKwargs: { k: { $var: "thinking.effort", omitWhenOff: true } } } },
        n: { thinkingLevelMap: "none" },
      },
    };
    const stored = storeRoute(
      { name: "r", baseURL: "http://x/v1", apiKeyEnv: "K", models: null, legacyOverrides: committed.overrides },
      committed,
    );
    expect(stored).toEqual(committed);
    expect(Object.keys(stored)).toEqual(Object.keys(committed));
  });

  it("FULL_CATALOG: the committed `models: []` (the no-filter spelling) stays byte-identical", () => {
    const committed = { name: "r", baseURL: "http://x/v1", models: [] };
    const stored = storeRoute({ name: "r", baseURL: "http://x/v1", models: null }, committed);
    expect(stored).toEqual({ name: "r", baseURL: "http://x/v1", models: [] });
  });

  it("FULL_CATALOG: the phantom inverse strips the resolved-view materialization from the legacy map", () => {
    const committed = {
      name: "r",
      baseURL: "http://x/v1",
      overrides: { m: { contextWindow: 1, input: [], thinkingLevelMap: {}, compat: { chatTemplateKwargs: {} } } },
    };
    const stored = storeRoute(
      { name: "r", baseURL: "http://x/v1", models: null, legacyOverrides: committed.overrides },
      committed,
    );
    expect(stored.overrides).toEqual({ m: { contextWindow: 1 } });
  });

  it("FULL_CATALOG: a cleared legacy map drops the overrides key (never an empty {})", () => {
    const stored = storeRoute(
      { name: "r", baseURL: "http://x/v1", models: null, legacyOverrides: {} },
      { name: "r", baseURL: "http://x/v1", overrides: { m: { contextWindow: 1 } } },
    );
    expect("overrides" in stored).toBe(false);
  });

  it("never mutates its inputs (pure)", () => {
    const route = { name: "r", baseURL: "http://x/v1", models: [{ name: "A", id: "a", contextWindow: 1 }] } as never;
    const committed = { name: "old", baseURL: "http://y/v1", overrides: { a: { contextWindow: 9 } } };
    storeRoute(route, committed);
    expect(committed).toEqual({ name: "old", baseURL: "http://y/v1", overrides: { a: { contextWindow: 9 } } });
  });
});

describe("foldLegacyOverrides — entry-route rules", () => {
  it("new shape: the legacy entry merges into the matching entry (per-field entry-wins, identity untouchable, cosmetic name dropped)", () => {
    const { routes, leftover, folded } = foldLegacyOverrides({
      routes: [
        { name: "r", baseURL: "http://x/v1", models: [{ name: "A", id: "m", contextWindow: 100 }, { name: "B", id: "n" }] },
      ],
      overrides: { m: { contextWindow: 111, maxTokens: 222, name: "legacy-cosmetic" }, ghost: { contextWindow: 3 } },
    });
    expect(folded).toBe(1);
    expect(leftover).toEqual({ ghost: { contextWindow: 3 } }); // the explicit route does not serve "ghost"
    const [route] = routes as Array<Record<string, unknown>>;
    const [a, b] = route.models as Array<Record<string, unknown>>;
    expect(a).toEqual({ name: "A", id: "m", contextWindow: 100, maxTokens: 222 });
    expect(b).toEqual({ name: "B", id: "n" });
  });

  it("new shape: a variant (two entries, same wire id) merges into BOTH", () => {
    const { routes, leftover, folded } = foldLegacyOverrides({
      routes: [
        { name: "r", baseURL: "http://x/v1", models: [{ name: "A", id: "m" }, { name: "B", id: "m", maxTokens: 5 }] },
      ],
      overrides: { m: { contextWindow: 111 } },
    });
    expect(folded).toBe(1);
    expect(leftover).toEqual({});
    const [route] = routes as Array<Record<string, unknown>>;
    const [a, b] = route.models as Array<Record<string, unknown>>;
    expect(a).toEqual({ name: "A", id: "m", contextWindow: 111 });
    expect(b).toEqual({ name: "B", id: "m", maxTokens: 5, contextWindow: 111 });
  });

  it("old string shape: the legacy entry folds into the route's overrides map (the reader absorbs it into the migrated entry)", () => {
    const { routes, leftover, folded } = foldLegacyOverrides({
      routes: [{ name: "r", baseURL: "http://x/v1", models: ["m"] }],
      overrides: { m: { contextWindow: 111 } },
    });
    expect(folded).toBe(1);
    expect(leftover).toEqual({});
    const [route] = routes as Array<Record<string, unknown>>;
    expect(route.overrides).toEqual({ m: { contextWindow: 111 } });
  });

  it("multi-route: an entry route claims the ids its entries carry; FULL_CATALOG routes claim nothing specifically", () => {
    const { routes, leftover, folded } = foldLegacyOverrides({
      routes: [
        { name: "r1", baseURL: "http://x/v1" },
        { name: "r2", baseURL: "http://y/v1", models: [{ id: "m" }] },
      ],
      overrides: { m: { contextWindow: 1 } },
    });
    expect(folded).toBe(1);
    expect(leftover).toEqual({});
    const [r1, r2] = routes as Array<Record<string, unknown>>;
    expect(r1.overrides).toBeUndefined();
    // The fold does NOT materialize the stored form's missing `name`
    // (byte-preservation — the reader defaults name to the id on read).
    expect((r2.models as Array<Record<string, unknown>>)[0]).toEqual({ id: "m", contextWindow: 1 });
  });
});

describe("cleanRoutePhantoms — entry arrays", () => {
  it("strips models: null / [] (the materializations) and phantom-strips entry elements", () => {
    expect(cleanRoutePhantoms({ name: "r", models: null })).toEqual({ name: "r" });
    expect(cleanRoutePhantoms({ name: "r", models: [] })).toEqual({ name: "r" });
    expect(
      cleanRoutePhantoms({
        name: "r",
        models: [{ name: "A", id: "a", input: [], thinkingLevelMap: {}, contextWindow: 1 }],
      }),
    ).toEqual({ name: "r", models: [{ name: "A", id: "a", contextWindow: 1 }] });
  });

  it("keeps the nothink sentinel and the old string elements untouched", () => {
    expect(
      cleanRoutePhantoms({ name: "r", models: [{ name: "A", id: "a", thinkingLevelMap: "none" }] }),
    ).toEqual({ name: "r", models: [{ name: "A", id: "a", thinkingLevelMap: "none" }] });
    expect(cleanRoutePhantoms({ name: "r", models: ["a", "b"] })).toEqual({ name: "r", models: ["a", "b"] });
  });
});

describe("assertServiceable (the settings-seam write gate)", () => {
  const route = (name: string, models?: unknown) => ({ name, baseURL: "http://x", models });

  it("accepts a well-formed section (unique route + model names)", () => {
    expect(() =>
      assertServiceable({ routes: [route("p1", [{ name: "A", id: "a" }, { name: "B", id: "b" }])] }),
    ).not.toThrow();
  });

  it("refuses duplicate ROUTE names", () => {
    expect(() => assertServiceable({ routes: [route("p1"), route("p1")] })).toThrow(
      /duplicate route name "p1"/,
    );
  });

  it("refuses duplicate MODEL names within one route", () => {
    expect(() =>
      assertServiceable({ routes: [route("p1", [{ name: "A", id: "a" }, { name: "A", id: "b" }])] }),
    ).toThrow(/duplicate model name "A" in route "p1"/);
  });

  it("refuses a blank-name row whose id duplicates a sibling's name (reader rule: blank name reads as id)", () => {
    expect(() =>
      assertServiceable({ routes: [route("p1", [{ name: "", id: "A" }, { name: "A", id: "b" }])] }),
    ).toThrow(/duplicate model name "A" in route "p1"/);
  });

  it("allows duplicate wire ids with distinct names (variants are legal)", () => {
    expect(() =>
      assertServiceable({ routes: [route("p1", [{ name: "A", id: "a" }, { name: "A-fast", id: "a" }])] }),
    ).not.toThrow();
  });

  it("tolerates non-string route names, non-array models, and blank/invalid entries", () => {
    expect(() =>
      assertServiceable({
        routes: [
          { name: 42, models: "not-an-array" },
          route("p1", [{ name: "", id: "" }, "not-an-object", { id: "a" }]),
        ],
      }),
    ).not.toThrow();
  });
});
