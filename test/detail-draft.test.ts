import { describe, expect, it } from "vitest";
import {
  cardModelOverrides,
  cardTopOverridesAfterReset,
  configDraftReleasesEntry,
  mergeModelConfig,
  modelConfigDraftDirty,
  modelConfigDraftsDirty,
  preservedSummary,
  type ModelConfigBaseline,
  type ModelConfigDraft,
  type ModelConfigSource,
  type TlRow,
} from "../src/dsh/curation.js";

const cd = (
  fields: Partial<ModelConfigBaseline>,
  base?: Partial<ModelConfigBaseline>,
): ModelConfigDraft => {
  const baseFields: ModelConfigBaseline = {
    contextWindow: "",
    maxTokens: "",
    nothink: false,
    tlRows: [],
    imageInput: false,
    reasoningEffort: false,
    ...base,
  };
  return { ...baseFields, ...fields, base: baseFields };
};

describe("modelConfigDraftDirty (the semantic dirty compare against the baseline)", () => {
  it("is clean when every field equals the baseline", () => {
    expect(
      modelConfigDraftDirty(
        cd({ contextWindow: "1024", nothink: true, imageInput: true }, { contextWindow: "1024", nothink: true, imageInput: true }),
      ),
    ).toBe(false);
    expect(modelConfigDraftDirty(cd({}))).toBe(false);
  });

  it("is dirty on a single field divergence (each control)", () => {
    const clean = cd({});
    expect(modelConfigDraftDirty({ ...clean, contextWindow: "1" })).toBe(true);
    expect(modelConfigDraftDirty({ ...clean, maxTokens: "1" })).toBe(true);
    expect(modelConfigDraftDirty({ ...clean, nothink: true })).toBe(true);
    expect(modelConfigDraftDirty({ ...clean, tlRows: [{ key: "off", value: "" }] })).toBe(true);
    expect(modelConfigDraftDirty({ ...clean, imageInput: true })).toBe(true);
    expect(modelConfigDraftDirty({ ...clean, reasoningEffort: true })).toBe(true);
  });

  it("the token fields compare as NUMBERS — a re-type of the same value reads clean (no phantom dirty)", () => {
    const b = { contextWindow: "262144", maxTokens: "32768" };
    expect(modelConfigDraftDirty(cd({ contextWindow: "262144", maxTokens: "32768" }, b))).toBe(false);
    expect(modelConfigDraftDirty(cd({ contextWindow: " 262144 " }, { contextWindow: "262144" }))).toBe(false);
    expect(modelConfigDraftDirty(cd({ maxTokens: "32768.0" }, { maxTokens: "32768" }))).toBe(false);
    expect(modelConfigDraftDirty(cd({ contextWindow: "1e4" }, { contextWindow: "10000" }))).toBe(false);
    expect(modelConfigDraftDirty(cd({ contextWindow: "262145" }, { contextWindow: "262144" }))).toBe(true);
    // Empty releases a set field (and a set value fills an empty one):
    expect(modelConfigDraftDirty(cd({ contextWindow: "" }, { contextWindow: "100" }))).toBe(true);
    expect(modelConfigDraftDirty(cd({ contextWindow: "0" }, {}))).toBe(true);
    expect(modelConfigDraftDirty(cd({ contextWindow: "" }, {}))).toBe(false);
    // Unparseable values never equal a number (they stay dirty — the commit validates them):
    expect(modelConfigDraftDirty(cd({ contextWindow: "abc" }, { contextWindow: "100" }))).toBe(true);
  });

  it("the thinking-level rows compare as a MAP — row order is UI state, not content", () => {
    const rows: TlRow[] = [
      { key: "high", value: "low" },
      { key: "off", value: "" },
    ];
    const reversed: TlRow[] = [
      { key: "off", value: "" },
      { key: "high", value: "low" },
    ];
    expect(modelConfigDraftDirty(cd({ tlRows: reversed }, { tlRows: rows }))).toBe(false);
    expect(modelConfigDraftDirty(cd({ tlRows: [{ key: "high", value: "high" }] }, { tlRows: rows }))).toBe(true);
    expect(modelConfigDraftDirty(cd({ tlRows: [{ key: "off", value: "" }] }, { tlRows: rows }))).toBe(true);
    expect(modelConfigDraftDirty(cd({ tlRows: rows }, { tlRows: [] }))).toBe(true);
    expect(modelConfigDraftDirty(cd({ tlRows: [] }, { tlRows: rows }))).toBe(true);
  });

  it("the booleans compare strictly (nothink / image input / reasoning effort)", () => {
    expect(modelConfigDraftDirty(cd({ nothink: true }, { nothink: false }))).toBe(true);
    expect(modelConfigDraftDirty(cd({ imageInput: true }, { imageInput: false }))).toBe(true);
    expect(modelConfigDraftDirty(cd({ reasoningEffort: true }, { reasoningEffort: false }))).toBe(true);
  });
});

describe("modelConfigDraftsDirty (the card-level any gate)", () => {
  it("trips on ANY dirty draft and stays clean when every draft matches its baseline", () => {
    expect(modelConfigDraftsDirty({})).toBe(false);
    expect(modelConfigDraftsDirty({ a: cd({}), b: cd({ contextWindow: "100" }, { contextWindow: "100" }) })).toBe(false);
    expect(modelConfigDraftsDirty({ a: cd({}), b: cd({ contextWindow: "100" }) })).toBe(true);
  });
});

const src = (existing: Record<string, unknown> | null, presetCompat: Record<string, unknown> | null = null): ModelConfigSource => ({
  existing,
  presetCompat,
});

describe("mergeModelConfig (the saveOverride discipline, ported whole)", () => {
  it("CREATES the entry from an absent effective entry when the draft carries content", () => {
    expect(mergeModelConfig(null, cd({ contextWindow: "100" }), undefined, null)).toEqual({
      contextWindow: 100,
      input: ["text"],
    });
  });

  it("does NOT create a phantom entry from an absent entry when nothing is meaningful (the text-only input pin is the default, not state)", () => {
    expect(mergeModelConfig(null, cd({}), undefined, null)).toBeUndefined();
    expect(mergeModelConfig(null, cd({ imageInput: true }), undefined, null)).toEqual({
      input: ["text", "image"],
    });
    expect(mergeModelConfig(null, cd({ nothink: true }), undefined, null)).toEqual({
      thinkingLevelMap: "none",
      input: ["text"],
    });
    expect(mergeModelConfig(null, cd({ reasoningEffort: true }), undefined, null)).toEqual({
      compat: { supportsReasoningEffort: true },
      input: ["text"],
    });
  });

  it("UPDATES the effective entry, BYTE-PRESERVING every untouched field (deep fields ride by reference — never a field-by-field reconstruction)", () => {
    const ctk = { enable_thinking: { $var: "effort" } };
    const existing = {
      name: "X",
      contextWindow: 500,
      reasoning: true,
      compat: { supportsReasoningEffort: true, thinkingFormat: "extra_body", chatTemplateKwargs: ctk },
      mystery: "keep me",
    };
    const out = mergeModelConfig(existing, cd({ contextWindow: "1000" }, { contextWindow: "500" }), undefined, null);
    expect(out).toEqual({
      name: "X",
      contextWindow: 1000,
      reasoning: true,
      compat: {
        supportsReasoningEffort: false,
        thinkingFormat: "extra_body",
        chatTemplateKwargs: ctk,
      },
      mystery: "keep me",
      input: ["text"],
    });
    expect(out?.compat).not.toBe(existing.compat);
    expect(out?.compat && (out.compat as Record<string, unknown>).chatTemplateKwargs).toBe(ctk);
    expect(existing.contextWindow).toBe(500);
  });

  it("RELEASES cleared fields back down the chain (the field is deleted, not zeroed)", () => {
    const existing = { contextWindow: 500, maxTokens: 100, thinkingLevelMap: { off: "high" } };
    const out = mergeModelConfig(
      existing,
      cd(
        { maxTokens: "", tlRows: [] },
        { contextWindow: "500", maxTokens: "100", tlRows: [{ key: "off", value: "high" }] },
      ),
      undefined,
      null,
    );
    expect(out).toEqual({ contextWindow: 500, input: ["text"] });
  });

  it("releasing EVERY field of a configured entry DROPS it (the Reset's effect — the release-to-chain semantics)", () => {
    expect(
      mergeModelConfig({ contextWindow: 500 }, cd({ contextWindow: "" }, { contextWindow: "500" }), undefined, null),
    ).toBeUndefined();
    expect(
      mergeModelConfig({ input: ["text", "image"] }, cd({ imageInput: false }, { imageInput: true }), undefined, null),
    ).toBeUndefined();
  });

  it("the `input` field is declared EXPLICITLY on every merge (the read_image capability mirror: text-only pins text-only)", () => {
    expect(mergeModelConfig(null, cd({ contextWindow: "100" }), undefined, null)?.input).toEqual(["text"]);
    expect(mergeModelConfig(null, cd({ contextWindow: "100", imageInput: true }), undefined, null)?.input).toEqual([
      "text",
      "image",
    ]);
    expect(mergeModelConfig({ contextWindow: 100 }, cd({ contextWindow: "100", imageInput: true }, { contextWindow: "100" }), undefined, null)?.input).toEqual([
      "text",
      "image",
    ]);
  });

  it("the nothink checkbox writes the `none` SENTINEL (replacing any rows); no rows + no nothink releases the field", () => {
    const withRows = { thinkingLevelMap: { off: "high" } };
    expect(mergeModelConfig(withRows, cd({ nothink: true }, { tlRows: [{ key: "off", value: "high" }] }), undefined, null)).toEqual({
      thinkingLevelMap: "none",
      input: ["text"],
    });
    // …and the rows write the map ("" → null):
    expect(
      mergeModelConfig(null, cd({ tlRows: [{ key: "off", value: "" }, { key: "high", value: "low" }] }), undefined, null),
    ).toEqual({ thinkingLevelMap: { off: null, high: "low" }, input: ["text"] });
    // …and clearing the rows of an otherwise-empty entry DROPS it (the
    // release — the only surviving content would be the text-only pin,
    // which is the default, not state):
    expect(
      mergeModelConfig(withRows, cd({ tlRows: [] }, { tlRows: [{ key: "off", value: "high" }] }), undefined, null),
    ).toBeUndefined();
  });

  it("the `name` field is merged ONLY when the display-name draft is dirty (undefined = the name is not touched)", () => {
    const existing = { name: "Old", contextWindow: 100 };
    expect(mergeModelConfig(existing, cd({}, { contextWindow: "100" }), undefined, null)?.name).toBe("Old");
    expect(mergeModelConfig(existing, cd({}, { contextWindow: "100" }), "", null)).toEqual({
      contextWindow: 100,
      input: ["text"],
    });
    expect(mergeModelConfig(existing, cd({}, { contextWindow: "100" }), "New", null)?.name).toBe("New");
    expect(mergeModelConfig(null, cd({}), "Fresh", null)).toEqual({ name: "Fresh", input: ["text"] });
  });

  it("the `compat` block follows the WHOLE-BLOCK rule (deep template fields materialized next to the pin)", () => {
    expect(
      mergeModelConfig(
        { compat: { supportsReasoningEffort: true, thinkingFormat: "extra_body" } },
        cd({ reasoningEffort: false }, { reasoningEffort: true }),
        undefined,
        null,
      ),
    ).toEqual({ compat: { supportsReasoningEffort: false, thinkingFormat: "extra_body" }, input: ["text"] });
    expect(
      mergeModelConfig(
        { compat: { supportsReasoningEffort: true } },
        cd({ reasoningEffort: false }, { reasoningEffort: true }),
        undefined,
        null,
      ),
    ).toBeUndefined();
    expect(
      mergeModelConfig(null, cd({ reasoningEffort: true }), undefined, { thinkingFormat: "extra_body" }),
    ).toEqual({ compat: { supportsReasoningEffort: true, thinkingFormat: "extra_body" }, input: ["text"] });
    expect(
      mergeModelConfig(null, cd({}), undefined, { thinkingFormat: "extra_body" }),
    ).toEqual({ compat: { supportsReasoningEffort: false, thinkingFormat: "extra_body" }, input: ["text"] });
    expect(mergeModelConfig(null, cd({ contextWindow: "100" }), undefined, null)).toEqual({
      contextWindow: 100,
      input: ["text"],
    });
  });

  it("never mutates its inputs", () => {
    const existing = { contextWindow: 500, compat: { supportsReasoningEffort: true } };
    const before = JSON.stringify(existing);
    mergeModelConfig(existing, cd({}, { contextWindow: "500", reasoningEffort: true }), undefined, null);
    expect(JSON.stringify(existing)).toBe(before);
  });
});

describe("cardModelOverrides with config drafts (create / update / release / the reset wins)", () => {
  const committed = {
    a: { name: "A", contextWindow: 100 },
    b: { contextWindow: 200 },
  };
  const sources = (over: Record<string, ModelConfigSource> = {}): Record<string, ModelConfigSource> => ({
    a: src(committed.a as Record<string, unknown>),
    b: src(committed.b as Record<string, unknown>),
    ...over,
  });

  it("creates an entry for a model with no committed entry", () => {
    const out = cardModelOverrides(committed, { n: cd({ contextWindow: "42" }) }, [], sources({ n: src(null) }));
    expect(out).toEqual({ ...committed, n: { contextWindow: 42, input: ["text"] } });
  });

  it("updates a committed entry byte-preserving (other entries untouched)", () => {
    const out = cardModelOverrides(committed, { a: cd({ contextWindow: "999" }, { contextWindow: "100" }) }, [], sources());
    expect(out).toEqual({
      a: { name: "A", contextWindow: 999, input: ["text"] },
      b: { contextWindow: 200 },
    });
  });

  it("releases a cleared entry (the id is dropped from the provider's map; other entries survive)", () => {
    const out = cardModelOverrides(committed, { b: cd({ contextWindow: "" }, { contextWindow: "200" }) }, [], sources());
    expect(out).toEqual({ a: { name: "A", contextWindow: 100 } });
  });

  it("a CLEAN config draft is a no-op (the entry passes through byte-identically, by reference)", () => {
    const out = cardModelOverrides(committed, { a: cd({}, { contextWindow: "100" }) }, [], sources());
    expect(out).toEqual(committed);
    expect(out.a).toBe(committed.a);
  });

  it("the RESET wins over a dirty config draft for the same model (the entry is deleted, not re-created by the merge)", () => {
    const out = cardModelOverrides(committed, { a: cd({ contextWindow: "1" }, { contextWindow: "100" }) }, ["a"], sources());
    expect(out).toEqual({ b: { contextWindow: 200 } });
  });

  it("a dirty config draft WITHOUT a seeded source reads as a fresh entry (the caller invariant — the client seeds every dirty id)", () => {
    const out = cardModelOverrides(committed, { n: cd({ contextWindow: "42" }) }, [], {});
    expect(out.n).toEqual({ contextWindow: 42, input: ["text"] });
  });

  it("never mutates the committed map or the sources", () => {
    const before = JSON.stringify(committed);
    cardModelOverrides(committed, { a: cd({ contextWindow: "1" }, { contextWindow: "100" }) }, [], sources());
    expect(JSON.stringify(committed)).toBe(before);
  });
});

describe("configDraftReleasesEntry (the legacy top-level half must drop the id before the fold)", () => {
  it("true when the merge yields nothing (every field cleared — the fold would re-create a left-behind legacy entry)", () => {
    expect(
      configDraftReleasesEntry(
        cd({ contextWindow: "" }, { contextWindow: "100" }),
        src({ contextWindow: 100 }),
        undefined,
      ),
    ).toBe(true);
    expect(configDraftReleasesEntry(cd({ imageInput: false }, { imageInput: true }), src({ input: ["text", "image"] }), undefined)).toBe(true);
  });

  it("false when the merge keeps the entry (a cleared field plus surviving content)", () => {
    expect(
      configDraftReleasesEntry(
        cd({ contextWindow: "" }, { contextWindow: "100" }),
        src({ contextWindow: 100, name: "A" }),
        undefined,
      ),
    ).toBe(false);
  });

  it("a dirty display name keeps the otherwise-empty entry alive (the release decision sees it)", () => {
    expect(configDraftReleasesEntry(cd({}), src(null), "Fresh")).toBe(false);
    expect(configDraftReleasesEntry(cd({}), src(null), undefined)).toBe(true);
    expect(configDraftReleasesEntry(cd({}), src(null), "")).toBe(true);
  });

  it("the reasoning-effort pin is surviving content (unchecking it on an sre-only entry still releases)", () => {
    expect(configDraftReleasesEntry(cd({ reasoningEffort: false }, { reasoningEffort: true }), src({ compat: { supportsReasoningEffort: true } }), undefined)).toBe(true);
    expect(configDraftReleasesEntry(cd({ reasoningEffort: true }), src(null), undefined)).toBe(false);
  });
});

describe("preservedSummary (the detail's 'preserved from settings.yaml' line)", () => {
  it("null entry / nothing to show → null", () => {
    expect(preservedSummary("en", null)).toBeNull();
    expect(preservedSummary("en", {})).toBeNull();
    expect(preservedSummary("en", { name: "A", contextWindow: 100, maxTokens: 5, thinkingLevelMap: { off: "high" } })).toBeNull();
    expect(preservedSummary("en", { input: ["text", "image"] })).toBeNull();
    expect(preservedSummary("en", { compat: { supportsReasoningEffort: true } })).toBeNull();
  });

  it("names the `reasoning` field", () => {
    expect(preservedSummary("en", { reasoning: true })).toBe("reasoning: on");
    expect(preservedSummary("en", { reasoning: false })).toBe("reasoning: off");
  });

  it("lists the DEEP compat fields (the block is shown only when it carries keys other than the pin)", () => {
    expect(
      preservedSummary("en", {
        compat: { supportsDeveloperRole: true, thinkingFormat: "extra_body", chatTemplateKwargs: { a: 1 } },
      }),
    ).toBe("deep template fields present (compat) — edit in settings.yaml");
    expect(preservedSummary("en", { compat: { supportsReasoningEffort: false } })).toBeNull();
  });

  it("lists any field the schema does not name", () => {
    expect(preservedSummary("en", { mystery: "x" })).toBe("deep template fields present (mystery) — edit in settings.yaml");
  });

  it("joins the parts with ' · '", () => {
    expect(
      preservedSummary("en", { reasoning: true, mystery: "x", compat: { thinkingFormat: "extra_body" } }),
    ).toBe("reasoning: on · deep template fields present (mystery, compat) — edit in settings.yaml");
  });

  it("the zh parts render the zh wording (field names stay verbatim)", () => {
    expect(preservedSummary("zh", { reasoning: true })).toBe("reasoning：开");
    expect(preservedSummary("zh", { reasoning: false })).toBe("reasoning：关");
    expect(preservedSummary("zh", { mystery: "x" })).toBe("存在深层模板字段（mystery）— 请在 settings.yaml 中编辑");
    expect(
      preservedSummary("zh", { reasoning: true, mystery: "x", compat: { thinkingFormat: "extra_body" } }),
    ).toBe("reasoning：开 · 存在深层模板字段（mystery, compat）— 请在 settings.yaml 中编辑");
  });
});

describe("cardTopOverridesAfterReset with the released ids (the fold-undo guard)", () => {
  // The card commit folds its OWN top-level half; a released id left in
  // that half would be re-folded into a provider's map and come back to
  // life — so the client passes [...pendingReset, ...released].
  it("removes BOTH the pending resets and the released ids", () => {
    const out = cardTopOverridesAfterReset(
      { a: { contextWindow: 1 }, b: { contextWindow: 2 }, c: { name: "C" } },
      ["a", "b"],
    );
    expect(out).toEqual({ c: { name: "C" } });
  });
});
