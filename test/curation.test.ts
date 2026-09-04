/**
 * The curation rules are tested here (not against client.tsx) because
 * client.tsx cannot be imported in node tests: its top-level react import
 * is answered by the web shell's module table at bundle runtime, not by
 * this repo's node_modules.
 */

import { describe, expect, it } from "vitest";
import type { ModelEntry } from "../src/types.js";
import {
  addModelEntry,
  applyConfigDraftToEntry,
  cardFieldsDirty,
  cardModelDirty,
  cardModelOverrides,
  cardTopOverridesAfterReset,
  catalogErrorDetail,
  catalogOkDetail,
  clockLabel,
  dedupeName,
  entryListDirty,
  entryNameCollision,
  nextFreeName,
  normalizeEntriesForWrite,
  removeModelEntry,
  renameModelEntry,
  resolveNameCollision,
  seedCatalogEntries,
  seedRowKeys,
  slotNormalizedEntries,
  updateModelEntry,
  type ModelConfigDraft,
  type ModelConfigSource,
} from "../src/dsh/curation.js";

const e = (name: string, id: string, config: Record<string, unknown> = {}): ModelEntry =>
  ({ name, id, ...config }) as ModelEntry;

const cd = (
  draft: Partial<ModelConfigDraft> = {},
  base: Partial<ModelConfigDraft> = {},
): ModelConfigDraft => ({
  contextWindow: "",
  maxTokens: "",
  nothink: false,
  tlRows: [],
  imageInput: false,
  reasoningEffort: false,
  base: {
    contextWindow: "",
    maxTokens: "",
    nothink: false,
    tlRows: [],
    imageInput: false,
    reasoningEffort: false,
    ...base,
  },
  ...draft,
}) as ModelConfigDraft;

const src = (existing: Record<string, unknown> | null): ModelConfigSource => ({
  existing,
  presetCompat: null,
});

describe("seedCatalogEntries (FULL_CATALOG → EXPLICIT materialization seed)", () => {
  it("seeds one entry per catalog model, in discovered order (name = wire id)", () => {
    expect(seedCatalogEntries([{ id: "a" }, { id: "b" }, { id: "c" }], undefined)).toEqual([
      e("a", "a"),
      e("b", "b"),
      e("c", "c"),
    ]);
    // Discovery display names are NOT the harness names (combobox adornment only).
    expect(seedCatalogEntries([{ id: "a", name: "Pretty A" }], undefined)).toEqual([e("a", "a")]);
  });

  it("carries the per-wire-id legacy config WHOLE, dropping the cosmetic name (the migration rule)", () => {
    expect(
      seedCatalogEntries([{ id: "a" }, { id: "b" }], {
        a: { name: "Pretty", contextWindow: 100 },
        b: { maxTokens: 5 },
      }),
    ).toEqual([
      e("a", "a", { contextWindow: 100 }),
      e("b", "b", { maxTokens: 5 }),
    ]);
  });

  it("skips malformed (non-string / empty) catalog ids, never throws", () => {
    expect(seedCatalogEntries([{ id: "" }, { id: "ok" } as never, "nope" as never], undefined)).toEqual([
      e("ok", "ok"),
    ]);
  });

  it("an empty catalog seeds an empty list (the server-down materialization)", () => {
    expect(seedCatalogEntries([], { a: { contextWindow: 1 } })).toEqual([]);
  });
});

describe("addModelEntry (ADD: append, pure)", () => {
  it("appends the new entry (a NEW array; the input is never mutated)", () => {
    const base = [e("A", "a")];
    const next = addModelEntry(base, e("B", "b"));
    expect(next).toEqual([e("A", "a"), e("B", "b")]);
    expect(next).not.toBe(base);
    expect(base).toEqual([e("A", "a")]);
  });

  it("allows DUPLICATE wire ids (variants: same id, distinct name/config)", () => {
    const next = addModelEntry([e("A", "a")], e("A-fast", "a", { maxTokens: 10 }));
    expect(next).toEqual([e("A", "a"), e("A-fast", "a", { maxTokens: 10 })]);
  });
});

describe("removeModelEntry (REMOVE: delete the row at its slot index, pure)", () => {
  it("deletes the row at the index, keeps list order, a NEW array", () => {
    const base = [e("A", "a"), e("B", "b"), e("C", "c")];
    const next = removeModelEntry(base, 1);
    expect(next).toEqual([e("A", "a"), e("C", "c")]);
    expect(next).not.toBe(base);
    expect(base).toHaveLength(3);
  });

  it("addresses the SLOT, not the name (a duplicate-named sibling is untouched)", () => {
    const base = [e("A", "a"), e("A", "a-2")];
    expect(removeModelEntry(base, 0)).toEqual([e("A", "a-2")]);
    expect(removeModelEntry(base, 1)).toEqual([e("A", "a")]);
  });

  it("an out-of-range index is a no-op (a copy)", () => {
    const base = [e("A", "a")];
    const next = removeModelEntry(base, 7);
    expect(next).toEqual([e("A", "a")]);
    expect(next).not.toBe(base);
  });
});

describe("renameModelEntry (EDIT name: the slot re-key)", () => {
  it("re-keys the row at the index (every other row untouched, list order kept)", () => {
    const base = [e("A", "a"), e("B", "b")];
    expect(renameModelEntry(base, 0, "A-prime")).toEqual([e("A-prime", "a"), e("B", "b")]);
  });

  it("a SIBLING collision is not refused (the draft may carry a transient duplicate — the Apply gate blocks it)", () => {
    const base = [e("A", "a"), e("B", "b")];
    expect(renameModelEntry(base, 1, "A")).toEqual([e("A", "a"), e("A", "b")]);
  });

  it("an empty target or an unchanged name is a no-op (a copy)", () => {
    const base = [e("A", "a")];
    const noop = renameModelEntry(base, 0, "");
    expect(noop).toEqual(base);
    expect(noop).not.toBe(base);
    const same = renameModelEntry(base, 0, "A");
    expect(same).toEqual(base);
    expect(same).not.toBe(base);
  });

  it("an out-of-range index is a no-op (a copy)", () => {
    const base = [e("A", "a")];
    const next = renameModelEntry(base, 3, "New");
    expect(next).toEqual([e("A", "a")]);
    expect(next).not.toBe(base);
  });
});

describe("updateModelEntry (EDIT id / config: the slot entry mutation, name locked)", () => {
  it("patches the row at the index (a copy of that row; others untouched)", () => {
    const base = [e("A", "a"), e("B", "b", { maxTokens: 5 })];
    expect(updateModelEntry(base, 0, { id: "a-2" })).toEqual([e("A", "a-2"), e("B", "b", { maxTokens: 5 })]);
    expect(
      updateModelEntry(base, 1, { contextWindow: 100, defaultEffort: "high" }),
    ).toEqual([e("A", "a"), e("B", "b", { maxTokens: 5, contextWindow: 100, defaultEffort: "high" })]);
  });

  it("the harness name is LOCKED (a patch carrying name does not re-key — that is renameModelEntry)", () => {
    const base = [e("A", "a")];
    expect(updateModelEntry(base, 0, { id: "a-2", name: "Tried-to-rename" as never })).toEqual([
      e("A", "a-2"),
    ]);
  });

  it("an out-of-range index is a no-op (a copy)", () => {
    const base = [e("A", "a")];
    const next = updateModelEntry(base, 3, { id: "nope" });
    expect(next).toEqual([e("A", "a")]);
    expect(next).not.toBe(base);
  });
});

describe("entryNameCollision (the unique-within-provider check)", () => {
  const entries = [e("A", "a"), e("B", "b")];
  it("collides on an existing name; not on a fresh one", () => {
    expect(entryNameCollision(entries, "A")).toBe(true);
    expect(entryNameCollision(entries, "C")).toBe(false);
  });

  it("excludes the row being edited (a re-key onto itself is clean)", () => {
    expect(entryNameCollision(entries, "A", 0)).toBe(false);
    expect(entryNameCollision(entries, "B", 0)).toBe(true);
  });

  it("an empty name never collides (empty rows are discarded, not committed)", () => {
    expect(entryNameCollision(entries, "")).toBe(false);
  });
});

describe("seedRowKeys (unique per-slot row keys, UI-only)", () => {
  it("unique names pass through UNCHANGED (materialization remounts nothing)", () => {
    expect(seedRowKeys(["a", "b", "c"])).toEqual(["a", "b", "c"]);
  });

  it("duplicate names: the first keeps it, the later get -2/-3 (never a fused slot)", () => {
    expect(seedRowKeys(["qwen", "qwen", "qwen"])).toEqual(["qwen", "qwen-2", "qwen-3"]);
  });

  it("blank names get a row-N slot token", () => {
    expect(seedRowKeys(["", "b"])).toEqual(["row-0", "b"]);
  });

  it("a blank name's token never collides with a real name", () => {
    expect(seedRowKeys(["", "row-0"])).toEqual(["row-0", "row-0-2"]);
  });

  it("an empty list yields an empty list", () => {
    expect(seedRowKeys([])).toEqual([]);
  });
});

describe("normalizeEntriesForWrite / slotNormalizedEntries (the committed form)", () => {
  it("discards empty-id rows (the Apply discard) and defaults a blank name to the id", () => {
    expect(normalizeEntriesForWrite([e("A", "a"), { name: "", id: "x" } as ModelEntry, { name: "", id: "" } as ModelEntry])).toEqual([
      e("A", "a"),
      e("x", "x"),
    ]);
  });

  it("trims the wire id; an unchanged entry keeps its reference (identity fast path)", () => {
    const row = e("A", "a");
    // A NEW array is always returned, but an UNCHANGED entry keeps its
    // reference (the identity fast path — the dirty check relies on this).
    const unchanged = normalizeEntriesForWrite([row]);
    expect(unchanged[0]).toBe(row);
    const padded = { name: "A", id: " a " } as ModelEntry;
    expect(normalizeEntriesForWrite([padded])).toEqual([e("A", "a")]);
  });

  it("slotNormalizedEntries keeps discarded rows as null slots (slot order preserved)", () => {
    expect(slotNormalizedEntries([e("A", "a"), { name: "", id: "" } as ModelEntry, e("B", "b")])).toEqual([
      e("A", "a"),
      null,
      e("B", "b"),
    ]);
  });
});

describe("nextFreeName (the smallest base-n free against the list's normalized names)", () => {
  it("offers -2 when free", () => {
    expect(nextFreeName([e("A", "a")], "A")).toBe("A-2");
  });

  it("chains past a taken suffix (a pre-existing sibling A-2 → A-3)", () => {
    expect(nextFreeName([e("A", "a"), e("A-2", "a2")], "A")).toBe("A-3");
    expect(nextFreeName([e("A", "a"), e("A-2", "a2"), e("A-3", "a3")], "A")).toBe("A-4");
  });

  it("a blank-named row is taken BY ITS ID (the normalized-name rule)", () => {
    expect(nextFreeName([{ name: "", id: "A-2" } as ModelEntry], "A")).toBe("A-3");
  });
});

describe("dedupeName (the auto-fill's free-or-suffixed rule)", () => {
  it("returns the candidate UNCHANGED when free", () => {
    expect(dedupeName([e("B", "b")], "A")).toBe("A");
  });

  it("suffices when the candidate is taken (the Add-model auto-fill)", () => {
    expect(dedupeName([e("A", "a")], "A")).toBe("A-2");
    expect(dedupeName([e("A", "a"), e("A-2", "a2")], "A")).toBe("A-3");
  });

  it("ignores the row being filled (its current name is being replaced)", () => {
    expect(dedupeName([e("B", "b"), e("A", "a")], "A", 1)).toBe("A");
    expect(dedupeName([e("A", "a"), e("B", "b")], "A", 1)).toBe("A-2");
  });

  it("a blank-named sibling is taken by its id (the normalized rule)", () => {
    expect(dedupeName([{ name: "", id: "A" } as ModelEntry], "A")).toBe("A-2");
  });

  it("an empty candidate stays empty (an open Add row)", () => {
    expect(dedupeName([e("A", "a")], "")).toBe("");
  });

  it("never mutates the list", () => {
    const entries = [e("A", "a")];
    dedupeName(entries, "A");
    expect(entries).toEqual([e("A", "a")]);
  });
});

describe("resolveNameCollision (the one-click fix: first keeps, later get suffixed)", () => {
  it("null when no name collides", () => {
    expect(resolveNameCollision([e("A", "a"), e("B", "b")])).toBeNull();
  });

  it("renames the LATER occurrence only (the first keeps the name; order kept; input unmutated)", () => {
    const base = [e("A", "a"), e("B", "b"), e("A", "a-2")];
    const fix = resolveNameCollision(base);
    expect(fix).not.toBeNull();
    expect(fix!.entries).toEqual([e("A", "a"), e("B", "b"), e("A-2", "a-2")]);
    expect(fix!.renamed).toEqual([{ from: "A", to: "A-2" }]);
    expect(base).toEqual([e("A", "a"), e("B", "b"), e("A", "a-2")]);
  });

  it("a three-way duplicate yields two renames (-2, -3)", () => {
    const fix = resolveNameCollision([e("A", "a"), e("A", "x"), e("A", "y")]);
    expect(fix!.entries.map((x) => x.name)).toEqual(["A", "A-2", "A-3"]);
    expect(fix!.renamed).toEqual([
      { from: "A", to: "A-2" },
      { from: "A", to: "A-3" },
    ]);
  });

  it("a suffix is chosen against the list AS RENAMED (a pre-existing sibling A-2 → A-3)", () => {
    const fix = resolveNameCollision([e("A", "a"), e("A-2", "a2"), e("A", "a-3")]);
    expect(fix!.entries.map((x) => x.name)).toEqual(["A", "A-2", "A-3"]);
    expect(fix!.renamed).toEqual([{ from: "A", to: "A-3" }]);
  });

  it("a collision via the blank-name→id default is detected (first occurrence keeps its row, later suffixed)", () => {
    const fix = resolveNameCollision([{ name: "", id: "A" } as ModelEntry, e("A", "a")]);
    expect(fix).not.toBeNull();
    expect(fix!.entries.map((x) => x.name)).toEqual(["", "A-2"]);
    expect(resolveNameCollision(fix!.entries)).toBeNull();
  });

  it("two rows with blank name AND blank id never collide (they are discarded at write)", () => {
    expect(
      resolveNameCollision([{ name: "", id: "" } as ModelEntry, { name: "", id: "" } as ModelEntry]),
    ).toBeNull();
  });

  it("one call clears every collision of the FIRST colliding name (a second, distinct collision stays)", () => {
    const fix = resolveNameCollision([e("A", "a"), e("A", "x"), e("B", "b"), e("B", "y")]);
    expect(fix!.entries.map((x) => x.name)).toEqual(["A", "A-2", "B", "B"]);
    expect(resolveNameCollision(fix!.entries)!.renamed).toEqual([{ from: "B", to: "B-2" }]);
  });
});

describe("entryListDirty (deep, phantom-tolerant, ORDER-SENSITIVE)", () => {
  it("the same list in the same order is clean (even with different references)", () => {
    const a = [e("A", "a", { contextWindow: 100 })];
    expect(entryListDirty(a, a)).toBe(false);
    expect(entryListDirty([e("A", "a", { contextWindow: 100 })], a)).toBe(false);
  });

  it("phantom materialization on EITHER side reads clean (the resolved-view inverse)", () => {
    const committed = e("A", "a", { contextWindow: 100, input: [], thinkingLevelMap: {}, compat: { chatTemplateKwargs: {} } });
    const draft = e("A", "a", { contextWindow: 100 });
    expect(entryListDirty([draft], [committed])).toBe(false);
    expect(entryListDirty([committed], [draft])).toBe(false);
  });

  it("key ORDER inside an entry is irrelevant (deep compare, canonical JSON)", () => {
    const a = [e("A", "a", { contextWindow: 100, maxTokens: 5 })];
    const b = [e("A", "a", { maxTokens: 5, contextWindow: 100 })];
    expect(entryListDirty(a, b)).toBe(false);
  });

  it("any divergence is dirty: length, add, remove, reorder, name, id, config, defaultEffort", () => {
    const base = [e("A", "a"), e("B", "b")];
    expect(entryListDirty([e("A", "a")], base)).toBe(true);
    expect(entryListDirty([...base, e("C", "c")], base)).toBe(true);
    expect(entryListDirty([e("A", "a")], base)).toBe(true);
    expect(entryListDirty([e("B", "b"), e("A", "a")], base)).toBe(true);
    expect(entryListDirty([e("A2", "a"), e("B", "b")], base)).toBe(true);
    expect(entryListDirty([e("A", "a-2"), e("B", "b")], base)).toBe(true);
    expect(entryListDirty([e("A", "a", { contextWindow: 9 }), e("B", "b")], base)).toBe(true);
    expect(
      entryListDirty([e("A", "a", { defaultEffort: "high" }), e("B", "b")], base),
    ).toBe(true);
  });

  it("a FULL_CATALOG baseline is the catalog seed (an unedited seed reads clean)", () => {
    const catalog = [{ id: "a" }, { id: "b" }];
    const legacy = { a: { contextWindow: 100 } };
    const base = seedCatalogEntries(catalog, legacy);
    expect(entryListDirty(seedCatalogEntries(catalog, legacy), base)).toBe(false);
    expect(entryListDirty(removeModelEntry(base, 1), base)).toBe(true);
  });
});

describe("clockLabel / catalogOkDetail (A3: green 'N models · last checked HH:MM')", () => {
  it("formats local 24h HH:MM zero-padded", () => {
    expect(clockLabel(new Date(2026, 7, 25, 14, 2))).toBe("14:02");
    expect(clockLabel(new Date(2026, 7, 25, 9, 5))).toBe("09:05");
    expect(clockLabel(new Date(2026, 7, 25, 0, 0))).toBe("00:00");
  });

  it("the success detail is 'N models · last checked HH:MM' (singular at one)", () => {
    expect(catalogOkDetail("en", 18, "14:02")).toBe("18 models · last checked 14:02");
    expect(catalogOkDetail("en", 1, "09:05")).toBe("1 model · last checked 09:05");
    expect(catalogOkDetail("en", 0, "13:00")).toBe("0 models · last checked 13:00");
  });

  it("the zh success detail uses the zh count phrase + '最后检查'", () => {
    expect(catalogOkDetail("zh", 18, "14:02")).toBe("18 个模型 · 最后检查 14:02");
    expect(catalogOkDetail("zh", 1, "09:05")).toBe("1 个模型 · 最后检查 09:05");
  });
});

describe("catalogErrorDetail (A3: red '<specific failure> · HH:MM')", () => {
  it("maps the node's network-failure message to the spec's unreachable wording", () => {
    expect(
      catalogErrorDetail(
        "en",
        "Cannot reach server at http://127.0.0.1:8080/v1/models: fetch failed",
        undefined,
        "13:58",
      ),
    ).toBe("Server unreachable (connection refused) · 13:58");
  });

  it("maps 401 to the spec wording naming the provider's committed apiKeyEnv", () => {
    expect(
      catalogErrorDetail(
        "en",
        'Server returned 401 Unauthorized: {"error":"invalid key"} Check the route\'s apiKeyEnv.',
        "LLAMA_SWAP_API_KEY",
        "14:05",
      ),
    ).toBe("401 Unauthorized — set LLAMA_SWAP_API_KEY · 14:05");
    expect(catalogErrorDetail("en", "Server returned 401 Unauthorized", undefined, "14:05")).toBe(
      "401 Unauthorized from /v1/models · 14:05",
    );
  });

  it("maps a status failure to '<status text> from /v1/models' (body/hint stripped)", () => {
    expect(
      catalogErrorDetail("en", "Server returned 400 Bad Request: malformed request", undefined, "14:05"),
    ).toBe("400 Bad Request from /v1/models · 14:05");
    expect(catalogErrorDetail("en", "Server returned 503 Service Unavailable", undefined, "14:06")).toBe(
      "503 Service Unavailable from /v1/models · 14:06",
    );
  });

  it("maps the malformed-response messages to the spec's malformed wording", () => {
    expect(catalogErrorDetail("en", "Invalid JSON from server /v1/models", undefined, "14:10")).toBe(
      "Malformed response: invalid JSON from /v1/models · 14:10",
    );
    expect(
      catalogErrorDetail("en", "Unexpected /v1/models response: missing data array", undefined, "14:10"),
    ).toBe("Malformed response: expected array, got object · 14:10");
  });

  it("falls through unknown messages verbatim (the dot never renders an empty detail)", () => {
    expect(
      catalogErrorDetail(
        "en",
        "modelspoke: no route to interrogate for model discovery (the `modelspoke:` section has no matching route)",
        undefined,
        "14:11",
      ),
    ).toBe(
      "modelspoke: no route to interrogate for model discovery (the `modelspoke:` section has no matching route) · 14:11",
    );
  });

  it("the zh variants render the zh wording (the raw message stays verbatim)", () => {
    expect(catalogErrorDetail("zh", "Cannot reach server at http://x/v1/models: fetch failed", undefined, "13:58")).toBe(
      "无法连接服务器（连接被拒绝） · 13:58",
    );
    expect(
      catalogErrorDetail("zh", 'Server returned 401 Unauthorized: {"error":"invalid key"}', "LLAMA_SWAP_API_KEY", "14:05"),
    ).toBe("401 未授权 — 请设置 LLAMA_SWAP_API_KEY · 14:05");
    expect(catalogErrorDetail("zh", "Server returned 401 Unauthorized", undefined, "14:05")).toBe(
      "401 未授权，来自 /v1/models · 14:05",
    );
    expect(catalogErrorDetail("zh", "Server returned 400 Bad Request: malformed request", undefined, "14:05")).toBe(
      "400 Bad Request（来自 /v1/models） · 14:05",
    );
    // The unrecognized message is kept VERBATIM in zh too (it's a server/harness
    // message, not modelspoke copy).
    expect(catalogErrorDetail("zh", "boom", undefined, "14:11")).toBe("boom · 14:11");
  });
});

describe("cardFieldsDirty (the three route fields)", () => {
  const base = { name: "p", baseURL: "http://x/v1", apiKeyEnv: "" };
  it("clean when all three match", () => {
    expect(cardFieldsDirty({ ...base }, base)).toBe(false);
  });
  it("dirty on any single field divergence", () => {
    expect(cardFieldsDirty({ ...base, name: "q" }, base)).toBe(true);
    expect(cardFieldsDirty({ ...base, baseURL: "http://y/v1" }, base)).toBe(true);
    expect(cardFieldsDirty({ ...base, apiKeyEnv: "KEY" }, base)).toBe(true);
  });
});

describe("cardModelDirty (the model gate: entry list ∪ config drafts ∪ pending resets)", () => {
  const baseEntries = [e("A", "a"), e("B", "b")];
  const clean = {
    draftEntries: null as readonly ModelEntry[] | null,
    baseEntries: baseEntries as readonly ModelEntry[],
    configDrafts: {} as Record<string, ModelConfigDraft>,
    pendingReset: [] as string[],
  };

  it("is clean when the model state equals the committed snapshot in every dimension", () => {
    expect(cardModelDirty(clean)).toBe(false);
    expect(cardModelDirty({ ...clean, draftEntries: [e("A", "a"), e("B", "b")] })).toBe(false);
  });

  it("an entry-list divergence is dirty (add / remove / rename / reorder)", () => {
    expect(cardModelDirty({ ...clean, draftEntries: [e("A", "a")] })).toBe(true);
    expect(cardModelDirty({ ...clean, draftEntries: [...baseEntries, e("C", "c")] })).toBe(true);
    expect(cardModelDirty({ ...clean, draftEntries: [e("B", "b"), e("A", "a")] })).toBe(true);
    expect(cardModelDirty({ ...clean, draftEntries: [e("A2", "a"), e("B", "b")] })).toBe(true);
  });

  it("a materialized-but-untouched FULL_CATALOG seed reads clean (the A1 discipline)", () => {
    const catalog = [{ id: "a" }, { id: "b" }];
    const legacy = { a: { contextWindow: 100 } };
    expect(
      cardModelDirty({
        ...clean,
        draftEntries: seedCatalogEntries(catalog, legacy),
        baseEntries: seedCatalogEntries(catalog, legacy),
      }),
    ).toBe(false);
    expect(
      cardModelDirty({
        ...clean,
        draftEntries: removeModelEntry(seedCatalogEntries(catalog, legacy), 1),
        baseEntries: seedCatalogEntries(catalog, legacy),
      }),
    ).toBe(true);
  });

  it("a detail config draft is dirty (and a non-dirty one is not — see detail-draft.test.ts for the field-level rules)", () => {
    const dirty: ModelConfigDraft = {
      contextWindow: "1024",
      maxTokens: "",
      nothink: false,
      tlRows: [],
      imageInput: false,
      reasoningEffort: false,
      base: { contextWindow: "", maxTokens: "", nothink: false, tlRows: [], imageInput: false, reasoningEffort: false },
    };
    const cleanC: ModelConfigDraft = { ...dirty, contextWindow: "" };
    expect(cardModelDirty({ ...clean, configDrafts: { a: dirty } })).toBe(true);
    expect(cardModelDirty({ ...clean, configDrafts: { a: cleanC } })).toBe(false);
  });

  it("a pending reset is dirty (even with nothing else touched)", () => {
    expect(cardModelDirty({ ...clean, pendingReset: ["a"] })).toBe(true);
  });
});

describe("applyConfigDraftToEntry (the detail config commit onto one EXPLICIT entry)", () => {
  it("merges the draft's fields into the entry, identity preserved over the merge", () => {
    const out = applyConfigDraftToEntry(e("A", "a", { contextWindow: 100 }), cd({ contextWindow: "200" }, { contextWindow: "100" }), null);
    expect(out).toEqual(e("A", "a", { contextWindow: 200, input: ["text"] }));
  });

  it("the wire id is NEVER touched by the config draft (an id edit is updateModelEntry)", () => {
    const out = applyConfigDraftToEntry(e("A", "a"), cd({ contextWindow: "1" }), null);
    expect(out).toMatchObject({ name: "A", id: "a", contextWindow: 1 });
  });

  it("a FULL RELEASE keeps the identity (the entry still SERVES its wire id — never dropped like a map entry)", () => {
    const out = applyConfigDraftToEntry(e("A", "a", { contextWindow: 100 }), cd({ contextWindow: "" }, { contextWindow: "100" }), null);
    expect(out).toEqual(e("A", "a"));
    expect(
      applyConfigDraftToEntry(e("A", "a"), cd({ contextWindow: "" }, { contextWindow: "" }), null),
    ).toEqual(e("A", "a"));
  });

  it("a dirty nothink draft writes the sentinel; clearing it releases back to the chain", () => {
    const on = applyConfigDraftToEntry(e("A", "a"), cd({ nothink: true }, { nothink: false }), null);
    expect(on.thinkingLevelMap).toBe("none");
    const off = applyConfigDraftToEntry(e("A", "a", { thinkingLevelMap: "none" }), cd({ nothink: false }, { nothink: true }), null);
    expect(off.thinkingLevelMap).toBeUndefined();
  });

  it("byte-preserves the entry's deep fields (a compat block with $var bindings survives)", () => {
    const entry = e("A", "a", {
      compat: { supportsReasoningEffort: true, chatTemplateKwargs: { k: { $var: "thinking.effort", omitWhenOff: true } } },
    });
    const out = applyConfigDraftToEntry(
      entry,
      cd({ contextWindow: "5", reasoningEffort: true }, { reasoningEffort: true }),
      null,
    );
    expect(out).toMatchObject({
      name: "A",
      id: "a",
      contextWindow: 5,
      compat: { supportsReasoningEffort: true, chatTemplateKwargs: { k: { $var: "thinking.effort", omitWhenOff: true } } },
    });
  });

  it("never mutates the input entry (pure)", () => {
    const entry = e("A", "a", { contextWindow: 100 });
    const before = JSON.stringify(entry);
    applyConfigDraftToEntry(entry, cd({ contextWindow: "1" }, { contextWindow: "100" }), null);
    expect(JSON.stringify(entry)).toBe(before);
  });
});

describe("cardModelOverrides (the FULL_CATALOG map commit: resets first, then config merges)", () => {
  const committed = {
    a: { name: "A", contextWindow: 100 },
    b: { name: "B" },
    c: { maxTokens: 200 },
  };

  it("passes an untouched provider map through byte-identically (clean drafts, no resets)", () => {
    const out = cardModelOverrides(committed, {}, [], {});
    expect(out).toEqual(committed);
    expect(out).not.toBe(committed);
    expect(cardModelOverrides(undefined, {}, [], {})).toEqual({});
  });

  it("a pending RESET deletes the entry; every other entry survives byte-for-byte (the row stays served)", () => {
    expect(cardModelOverrides(committed, {}, ["a"], {})).toEqual({ b: { name: "B" }, c: { maxTokens: 200 } });
    // A reset of an id absent from this map is a no-op: the top-level half owns that entry.
    expect(cardModelOverrides(committed, {}, ["zzz"], {})).toEqual(committed);
  });

  it("the RESET WINS over a dirty config draft for the same model (the entry is deleted, not re-created by the merge)", () => {
    const out = cardModelOverrides(
      committed,
      { a: cd({ contextWindow: "1" }, { contextWindow: "100" }) },
      ["a"],
      { a: src(committed.a as Record<string, unknown>) },
    );
    expect(out).toEqual({ b: { name: "B" }, c: { maxTokens: 200 } });
  });

  it("a dirty config draft merges onto the seeded source (unseeded fields pass through the merge)", () => {
    // The draft's current values are the seeded committed values; only
    // contextWindow changed.
    const out = cardModelOverrides(
      committed,
      { c: cd({ contextWindow: "7", maxTokens: "200" }, { maxTokens: "200" }) },
      [],
      { c: src(committed.c as Record<string, unknown>) },
    );
    expect(out.c).toEqual({ maxTokens: 200, contextWindow: 7, input: ["text"] });
  });

  it("never mutates the committed map", () => {
    const before = JSON.stringify(committed);
    cardModelOverrides(committed, { a: cd({ contextWindow: "1" }, { contextWindow: "100" }) }, ["c"], {
      a: src(committed.a as Record<string, unknown>),
    });
    expect(JSON.stringify(committed)).toBe(before);
  });
});

describe("cardTopOverridesAfterReset (the legacy top-level half: reset ids removed BEFORE the fold)", () => {
  it("removes the reset ids and keeps everything else (a new object, input unmutated)", () => {
    const committed = { a: { name: "A" }, b: { contextWindow: 100 }, c: { maxTokens: 5 } };
    const out = cardTopOverridesAfterReset(committed, ["a", "c"]);
    expect(out).toEqual({ b: { contextWindow: 100 } });
    expect(out).not.toBe(committed);
    expect(committed).toEqual({ a: { name: "A" }, b: { contextWindow: 100 }, c: { maxTokens: 5 } });
  });

  it("ids the map does not carry are a no-op (the entry lives on the provider's own map)", () => {
    expect(cardTopOverridesAfterReset({}, ["m"])).toEqual({});
    expect(cardTopOverridesAfterReset({ a: { name: "A" } }, [])).toEqual({ a: { name: "A" } });
  });

  it("an all-reset map empties (the commit's unset path drops the key)", () => {
    expect(cardTopOverridesAfterReset({ a: { name: "A" } }, ["a"])).toEqual({});
  });
});
