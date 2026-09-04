/**
 * Orphaned-override cleanup —
 * the pure contract in src/dsh/curation.ts behind the section's
 * top-level-overrides block: the entry CLASSIFICATION (orphaned vs
 * claimed — a provider route's own `routes[].overrides` entry shadows the
 * top-level one per field, so a claimed entry is NOT deletable from the
 * section bottom: deleting it changes behavior for every other route that
 * still inherits it) and the top-level DELETION merge (the key removed,
 * every other entry byte-preserved by reference — the deep `compat` `$var`
 * bindings travel untouched — the empty result signaled as the OMIT, the
 * section's omit-empty rule: the `overrides` key is unset, not `{}`).
 *
 * The rules live in a framework-neutral module (no react import) precisely
 * so this file can import them: client.tsx itself cannot be imported here
 * (its top-level react import is answered by the web shell's module table
 * at bundle runtime, not by this repo's node_modules). The block's DOM
 * behavior (the rows, the confirm-gated Delete, the top-level-half-only
 * section commit) is covered by the testenv E2E gates.
 */

import { describe, expect, it } from "vitest";
import { classifyTopOverrides, removeTopOverrideEntry } from "../src/dsh/curation.js";
import { t } from "../src/dsh/locales.js";

const route = (name: string, overrides?: Record<string, unknown>) =>
  overrides === undefined ? { name } : { name, overrides };

describe("classifyTopOverrides (orphaned vs claimed; dual-shape aware)", () => {
  it("an entry NO route carries its own entry for is orphaned (empty claiming)", () => {
    const rows = classifyTopOverrides(
      { "m1": { contextWindow: 8192 } },
      [route("a", { "other": {} }), route("b")],
    );
    expect(rows).toEqual([{ id: "m1", displayName: null, fields: ["contextWindow"], claiming: [] }]);
  });

  it("an entry a route carries its own entry for is CLAIMED by that provider", () => {
    const rows = classifyTopOverrides(
      { "m1": { maxTokens: 4096 } },
      [route("a", { "m1": { contextWindow: 8192 } }), route("b")],
    );
    expect(rows.map((r) => r.claiming)).toEqual([["a"]]);
  });

  it("MULTIPLE claimers are all named, in configuration (routes) order", () => {
    const rows = classifyTopOverrides(
      { "m1": { maxTokens: 4096 } },
      [
        route("second", { "m1": { contextWindow: 8192 } }),
        route("first", { "m1": { name: "First's copy" } }),
      ],
    );
    expect(rows.map((r) => r.claiming)).toEqual([["second", "first"]]);
  });

  it("dual shape: an entry present BOTH top-level and in a route's map is claimed (the route copy shadows it)", () => {
    const rows = classifyTopOverrides(
      { "m1": { contextWindow: 8192, maxTokens: 4096 } },
      [route("a", { "m1": { contextWindow: 16384 } })],
    );
    expect(rows.map((r) => r.claiming)).toEqual([["a"]]);
  });

  it("dual shape: a top-level-only id is orphaned while a route's-only id never appears (one row per TOP-level entry)", () => {
    const rows = classifyTopOverrides(
      { "top-only": { maxTokens: 1 } },
      [route("a", { "route-only": { maxTokens: 2 } })],
    );
    expect(rows.map((r) => r.id)).toEqual(["top-only"]);
    expect(rows.map((r) => r.claiming)).toEqual([[]]);
  });

  it("a route WITHOUT an overrides map, or with a map that lacks the id, claims nothing", () => {
    const rows = classifyTopOverrides(
      { "m1": { maxTokens: 1 } },
      [route("a"), route("b", { "m2": {} })],
    );
    expect(rows.map((r) => r.claiming)).toEqual([[]]);
  });

  it("a route's MALFORMED (non-object) entry for the id still claims (the `id in` survivor idiom — conservative: the Delete is offered only when NO route carries the id at all)", () => {
    const rows = classifyTopOverrides(
      { "m1": { maxTokens: 1 } },
      [route("a", { "m1": "garbage" })],
    );
    expect(rows.map((r) => r.claiming)).toEqual([["a"]]);
  });

  it("rows follow the TOP map's key order; an empty top map yields no rows", () => {
    const rows = classifyTopOverrides({ b: {}, a: {} }, [route("p", { b: {} })]);
    expect(rows.map((r) => r.id)).toEqual(["b", "a"]);
    expect(classifyTopOverrides({}, [route("p", { m: {} })])).toEqual([]);
  });

  it("the inputs are never mutated", () => {
    const top = { "m1": { contextWindow: 1 } };
    const routes = [route("a", { "m1": { maxTokens: 2 } })];
    classifyTopOverrides(top, routes);
    expect(top).toEqual({ "m1": { contextWindow: 1 } });
    expect(routes).toEqual([{ name: "a", overrides: { "m1": { maxTokens: 2 } } }]);
  });
});

describe("classifyTopOverrides row facts (the compact summary inputs)", () => {
  it("a display name is surfaced as `displayName` and `name` is excluded from the field list", () => {
    const rows = classifyTopOverrides(
      { "m1": { name: "My display", contextWindow: 8192, input: ["text", "image"] } },
      [],
    );
    expect(rows.map((r) => r.displayName)).toEqual(["My display"]);
    expect(rows.map((r) => r.fields)).toEqual([["contextWindow", "input"]]);
  });

  it("the field list is the entry's SET field names in ENTRY order (minus `name`)", () => {
    const rows = classifyTopOverrides(
      { "m1": { maxTokens: 4096, input: ["text"], contextWindow: 8192, compat: {} } },
      [],
    );
    expect(rows.map((r) => r.fields)).toEqual([["maxTokens", "input", "contextWindow", "compat"]]);
  });

  it("no name (or a whitespace name) → displayName null; a name-only entry → empty field list", () => {
    const rows = classifyTopOverrides(
      { "a": { contextWindow: 1 }, "b": { name: "   " }, "c": { name: "Only a name" } },
      [],
    );
    expect(rows.map((r) => r.displayName)).toEqual([null, null, "Only a name"]);
    expect(rows.map((r) => r.fields)).toEqual([["contextWindow"], [], []]);
  });

  it("a malformed (non-object) entry reads as no name + no fields (never throws; the row still renders its id)", () => {
    const rows = classifyTopOverrides({ "m1": "garbage" }, [route("a", { "m1": "x" })]);
    expect(rows.map((r) => r.displayName)).toEqual([null]);
    expect(rows.map((r) => r.fields)).toEqual([[]]);
  });
});

describe("removeTopOverrideEntry (the top-level-half deletion merge)", () => {
  it("removes EXACTLY the key — every other entry survives BY REFERENCE (a $var compat field is byte-preserved, never re-serialized)", () => {
    const varBinding = { thinking: { $var: "thinking.enabled" } };
    const compatEntry = {
      contextWindow: 8192,
      compat: { supportsReasoningEffort: true, chatTemplateKwargs: { thinking: varBinding } },
    };
    const committed = {
      keep1: compatEntry,
      keep2: { maxTokens: 4096, name: "Kept" },
      drop: { contextWindow: 1 },
    };
    const result = removeTopOverrideEntry(committed, "drop");
    expect(result).toBeDefined();
    const out = result as Record<string, unknown>;
    expect("drop" in out).toBe(false);
    // Reference identity — the surviving entries are never re-created.
    expect(out["keep1"]).toBe(compatEntry);
    expect(out["keep2"]).toBe(committed["keep2"]);
    // …so the $var binding is byte-identical (the same object, the same bytes).
    expect(JSON.stringify(out["keep1"])).toBe(JSON.stringify(compatEntry));
    expect((out["keep1"] as Record<string, any>).compat.chatTemplateKwargs.thinking).toBe(varBinding);
    // The result is a NEW map (the input is never mutated — the key is still there).
    expect(out).not.toBe(committed);
    expect("drop" in committed).toBe(true);
  });

  it("empty-after-delete → the key is OMITTED (undefined), never an empty {}", () => {
    expect(removeTopOverrideEntry({ only: { contextWindow: 1 } }, "only")).toBeUndefined();
    expect(removeTopOverrideEntry({}, "absent")).toBeUndefined();
  });

  it("deleting an ABSENT id is a no-op: a new map, the same entries by reference", () => {
    const entry = { contextWindow: 1 };
    const committed = { keep: entry };
    const out = removeTopOverrideEntry(committed, "absent") as Record<string, unknown>;
    expect(out).not.toBe(committed);
    expect(out["keep"]).toBe(entry);
  });

  it("the routes half is untouched by reference: the merge takes only the top map, and the commit's final section composes the UNWRITTEN snapshot routes alongside the new top map", () => {
    // The client's commitTopOverrides never writes the routes half — the
    // final section is the snapshot's routes (the same array, unwritten)
    // over the merged top-level half. Model that composition here: the
    // merge cannot reach the routes, so their identity survives verbatim.
    const routes = [{ name: "a", overrides: { m: { contextWindow: 1 } } }];
    const top = { drop: { contextWindow: 2 }, keep: { maxTokens: 3 } };
    const merged = removeTopOverrideEntry(top, "drop") as Record<string, unknown>;
    const finalSection = { routes, overrides: merged };
    expect(finalSection.routes).toBe(routes); // byte-preserved, same reference
    expect("drop" in merged).toBe(false);
    expect(merged["keep"]).toBe(top["keep"]);
  });
});

// i18n wiring: the completeness walk in locales.test.ts covers en+zh
// presence; these pin the interpolation the block renders.

describe("the block's i18n keys (en + zh, the interpolation the block renders)", () => {
  it("heading + hint render in both locales", () => {
    expect(t("en", "topOverridesHeading")).toBe("Top-level overrides");
    expect(t("zh", "topOverridesHeading")).toBe("顶层 overrides");
    expect(t("en", "topOverridesHint")).not.toHaveLength(0);
    expect(t("zh", "topOverridesHint")).not.toHaveLength(0);
  });

  it("the shadowed-by hint interpolates the (caller-joined) claimant names in both locales", () => {
    expect(t("en", "topOverrideShadowed", { names: "a, b" })).toBe(
      "shadowed by a, b — it still applies to every other provider",
    );
    expect(t("zh", "topOverrideShadowed", { names: "a、b" })).toBe("被 a、b 遮蔽 — 对其它提供方仍生效");
  });

  it("the aria-label and the confirm interpolate the model id in both locales", () => {
    expect(t("en", "ariaDeleteTopOverride", { id: "m1" })).toBe("Delete orphaned override m1");
    expect(t("zh", "ariaDeleteTopOverride", { id: "m1" })).toBe("删除未被提供方声明的顶层 override m1");
    expect(t("en", "confirmDeleteTopOverride", { id: "m1" })).toBe(
      'Delete the top-level override "m1"? No provider has its own entry for it, so the model\'s configuration resolves from server discovery / presets / defaults again.',
    );
    expect(t("zh", "confirmDeleteTopOverride", { id: "m1" })).toBe(
      '删除顶层 override "m1"？没有任何提供方为它配置了自有条目，删除后该模型的配置重新从服务器发现 / 预设 / 默认值解析。',
    );
  });
});
