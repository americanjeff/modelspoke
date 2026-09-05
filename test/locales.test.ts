/** Locale bundle (src/dsh/locales.ts); EN identity asserts against independently-hardcoded originals, not locales.ts's own values, so extraction typos are caught. */

import { describe, expect, it } from "vitest";
import {
  attemptLocaleBind,
  isLocaleId,
  LOCALE_IDS,
  localeFromBrowser,
  modelCountLabel,
  presetDescription,
  PRESET_ZH,
  presetZhIds,
  resolveLocale,
  stringKeys,
  t,
} from "../src/dsh/locales.js";
import { presetCatalog } from "../src/presets/catalog.js";

describe("key completeness (every key carries BOTH en and zh, non-empty)", () => {
  it("the bundle is non-trivial", () => {
    expect(stringKeys().length).toBeGreaterThanOrEqual(80);
  });

  it("every key resolves to a non-empty string in BOTH locales", () => {
    const keys = stringKeys();
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) {
      expect(t("en", key), `en missing/empty for ${key}`).not.toHaveLength(0);
      expect(t("zh", key), `zh missing/empty for ${key}`).not.toHaveLength(0);
    }
  });

  it("LOCALE_IDS is exactly the two shipped locales", () => {
    expect([...LOCALE_IDS].sort()).toEqual(["en", "zh"]);
  });

  it("isLocaleId accepts only the two ids", () => {
    expect(isLocaleId("en")).toBe(true);
    expect(isLocaleId("zh")).toBe(true);
    expect(isLocaleId("ja")).toBe(false);
    expect(isLocaleId("")).toBe(false);
    expect(isLocaleId(undefined)).toBe(false);
  });
});

describe("t() interpolation (the existing semantics, exact)", () => {
  it("substitutes every {name} arg", () => {
    expect(t("en", "ariaEditProvider", { name: "my-srv" })).toBe("Edit provider my-srv");
    expect(t("en", "ariaThinkingLevelRow", { id: "m1", row: 2 })).toBe(
      "Thinking level for m1 (row 2)",
    );
  });

  it("stringifies numeric args", () => {
    expect(t("en", "countConfigured", { count: 3 })).toBe("3 configured");
  });

  it("leaves a placeholder INTACT when its arg is absent (defensive — never deletes a literal)", () => {
    expect(t("en", "dotOk", {})).toBe("{countLabel} · last checked {at}");
  });

  it("returns the template verbatim when no args are given", () => {
    expect(t("en", "cancel")).toBe("Cancel");
    expect(t("zh", "cancel")).toBe("取消");
  });
});

describe("en identity: t('en', …) is the EXACT original client.tsx string", () => {
  const cases: Array<[string, Record<string, string | number> | undefined, string]> = [
    [
      "intro",
      undefined,
      "Enter your providers' base URLs to use models from your local OpenAI-compatible servers.",
    ],
    ["loadingProviders", undefined, "Loading providers…"],
    ["settingsUnavailable", undefined, "Settings are not available in this session."],
    ["emptyProviders", undefined, "No providers yet — add your first one below."],
    [
      "emptyProvidersHint",
      undefined,
      "The `modelspoke:` section of settings.yaml remains editable by hand (a provider is one entry under `routes:`); this list reflects it live.",
    ],
    [
      "saveFailed",
      undefined,
      "Save failed — the settings changed in the meantime or the write was refused. The list below shows the current state.",
    ],
    ["ariaEditProvider", { name: "p" }, "Edit provider p"],
    ["ariaDeleteProvider", { name: "p" }, "Delete provider p"],
    [
      "confirmDeleteProvider",
      { name: "p" },
      'Delete provider "p"? Its per-model configurations move to the top-level overrides (or are dropped when a surviving provider claims the same model).',
    ],
    [
      "hintProviderKey",
      undefined,
      "the provider key — renaming writes the new key; the provider's models and per-model configurations follow it",
    ],
    ["hintApiKeyOptional", undefined, "(optional — the variable's value is never stored)"],
    ["phNewModelId", undefined, "the exact model id (for ids the server doesn't list)"],
    [
      "fetchingCatalog",
      undefined,
      "Fetching the provider's catalog…",
    ],
    [
      "catalogFetchError",
      undefined,
      "Couldn't reach the server — showing configured models only.",
    ],
    [
      "errProviderExists",
      { name: "p" },
      'A provider named "p" already exists — the name is the provider identity and must be unique.',
    ],
    [
      "errContextWindow",
      { id: "m1" },
      'Context window for "m1" must be a positive whole number of tokens, or left empty to release the field.',
    ],
    [
      "resetPendingNote",
      undefined,
      "The entry will be deleted on save — the model stays active and its configuration resolves from server discovery / presets / defaults again.",
    ],
    [
      "preservedLine",
      { summary: "reasoning: on" },
      "Preserved from settings.yaml (read-only): reasoning: on",
    ],
    ["dotUnknown", undefined, "Not checked yet — expand to fetch"],
    ["dotOkDefault", undefined, "Catalog check passed"],
    ["dotErrorDefault", undefined, "Catalog check failed"],
    // Also pinned independently in curation.test.ts.
    ["dotOk", { countLabel: "18 models", at: "14:02" }, "18 models · last checked 14:02"],
    ["dotOk", { countLabel: "1 model", at: "09:05" }, "1 model · last checked 09:05"],
    ["dotErrorUnreachable", { at: "13:58" }, "Server unreachable (connection refused) · 13:58"],
    [
      "dotErrorUnauthorized",
      { apiKeyEnv: "LLAMA_SWAP_API_KEY", at: "14:05" },
      "401 Unauthorized — set LLAMA_SWAP_API_KEY · 14:05",
    ],
    [
      "dotErrorUnauthorizedNoKey",
      { at: "14:05" },
      "401 Unauthorized from /v1/models · 14:05",
    ],
    ["dotErrorStatus", { status: "400 Bad Request", at: "14:05" }, "400 Bad Request from /v1/models · 14:05"],
    [
      "dotErrorMalformedJson",
      { at: "14:10" },
      "Malformed response: invalid JSON from /v1/models · 14:10",
    ],
    [
      "dotErrorMalformedShape",
      { at: "14:10" },
      "Malformed response: expected array, got object · 14:10",
    ],
    ["dotErrorRaw", { message: "boom", at: "14:11" }, "boom · 14:11"],
    ["preservedReasoningOn", undefined, "reasoning: on"],
    ["preservedReasoningOff", undefined, "reasoning: off"],
    [
      "preservedDeepFields",
      { keys: "mystery, compat" },
      "deep template fields present (mystery, compat) — edit in settings.yaml",
    ],
    [
      "pluginCardDescription",
      undefined,
      "Local OpenAI-compatible model servers — providers, models, and per-model configuration.",
    ],
  ];

  for (const [key, args, expected] of cases) {
    it(`en ${key}${args ? ` ${JSON.stringify(args)}` : ""}`, () => {
      expect(t("en", key, args)).toBe(expected);
    });
  }
});

describe("resolveLocale (the resolution chain: preference → browser)", () => {
  it("a bound 'zh' preference wins over the browser", () => {
    expect(resolveLocale({ preference: "zh", browserLanguage: "en-US" })).toBe("zh");
  });

  it("a bound 'en' preference wins over the browser", () => {
    expect(resolveLocale({ preference: "en", browserLanguage: "zh-CN" })).toBe("en");
  });

  it("ABSENCE (no preference) delegates to the browser", () => {
    expect(resolveLocale({ preference: undefined, browserLanguage: "zh-CN" })).toBe("zh");
    expect(resolveLocale({ browserLanguage: "en-US" })).toBe("en");
    expect(resolveLocale({ browserLanguage: "de-DE" })).toBe("en");
  });

  it("a NON-locale preference value is treated as absent (validated)", () => {
    expect(resolveLocale({ preference: "ja", browserLanguage: "zh-CN" })).toBe("zh");
    expect(resolveLocale({ preference: "", browserLanguage: "en-US" })).toBe("en");
    expect(resolveLocale({ preference: null, browserLanguage: "zh-TW" })).toBe("zh");
  });

  it("no preference + no browser language defaults to 'en'", () => {
    expect(resolveLocale({})).toBe("en");
  });

  // A throwing bind means the namespace was not registered — the preference
  // is IGNORED and the browser language alone decides.
  it("bind-failure IGNORES the preference (browser-only)", () => {
    expect(resolveLocale({ bindFailed: true, preference: "zh", browserLanguage: "en-US" })).toBe("en");
    expect(resolveLocale({ bindFailed: true, preference: "en", browserLanguage: "zh-CN" })).toBe("zh");
    expect(resolveLocale({ bindFailed: true, browserLanguage: "zh-TW" })).toBe("zh");
    expect(resolveLocale({ bindFailed: true, browserLanguage: "fr" })).toBe("en");
  });

  it("the happy + failure paths compose through attemptLocaleBind (the injectable bind)", () => {
    const happy = attemptLocaleBind(() => "scope" as const);
    expect(happy).toEqual({ scope: "scope", bindFailed: false });
    expect(resolveLocale({ bindFailed: happy.bindFailed, preference: "zh", browserLanguage: "en-US" })).toBe("zh");

    const failed = attemptLocaleBind(() => {
      throw new Error("namespace 'locale' not registered");
    });
    expect(failed).toEqual({ scope: null, bindFailed: true });
    expect(resolveLocale({ bindFailed: failed.bindFailed, preference: "zh", browserLanguage: "en-US" })).toBe("en");
    expect(resolveLocale({ bindFailed: failed.bindFailed, preference: "zh", browserLanguage: "zh-CN" })).toBe("zh");
  });
});

describe("localeFromBrowser (the browser half: zh* → zh, else en)", () => {
  it("maps every zh variant to zh", () => {
    for (const lang of ["zh", "zh-CN", "zh-TW", "zh-Hant", "ZH-cn", " zh "]) {
      expect(localeFromBrowser(lang), lang).toBe("zh");
    }
  });

  it("maps everything else (and nothing) to en", () => {
    for (const lang of ["en", "en-US", "de", "fr-FR", "ja", "", undefined]) {
      expect(localeFromBrowser(lang), String(lang)).toBe("en");
    }
  });
});

describe("modelCountLabel (the 'N model(s)' phrase; plural is en-only)", () => {
  it("english plural / singular / zero", () => {
    expect(modelCountLabel("en", 18)).toBe("18 models");
    expect(modelCountLabel("en", 1)).toBe("1 model");
    expect(modelCountLabel("en", 0)).toBe("0 models");
  });

  it("chinese has no plural", () => {
    expect(modelCountLabel("zh", 18)).toBe("18 个模型");
    expect(modelCountLabel("zh", 1)).toBe("1 个模型");
  });
});

describe("presetDescription (zh keyed by id; en = the catalog's notes; never blank)", () => {
  const qwen38 = presetCatalog.find((p) => p.id === "qwen3.8-chat-template");

  it("every catalog preset carries a zh description (no id is zh-less)", () => {
    for (const preset of presetCatalog) {
      expect(PRESET_ZH[preset.id], `no zh for ${preset.id}`).toBeTruthy();
    }
    expect(new Set(presetZhIds()).size).toBe(presetZhIds().length);
    for (const id of presetZhIds()) {
      expect(presetCatalog.some((p) => p.id === id), `stray zh id ${id}`).toBe(true);
    }
  });

  it("en returns the CATALOG's notes verbatim (the source of truth, unchanged)", () => {
    expect(presetDescription("en", "qwen3.8-chat-template")).toBe(qwen38?.notes);
    expect(presetDescription("en", "qwen3.8-chat-template")).not.toBe(
      presetDescription("zh", "qwen3.8-chat-template"),
    );
  });

  it("zh returns the keyed zh string", () => {
    expect(presetDescription("zh", "qwen3.8-chat-template")).toBe(PRESET_ZH["qwen3.8-chat-template"]);
  });

  it("zh FALLS BACK to the en (catalog notes) when a preset id has no zh — never blank for a catalog preset", () => {
    // Every catalog preset has zh, so the zh-absent fallback can't be hit
    // directly; assert en equals the notes and neither locale yields "".
    for (const preset of presetCatalog) {
      expect(presetDescription("en", preset.id)).toBe(preset.notes);
      expect(presetDescription("zh", preset.id)).not.toHaveLength(0);
      expect(presetDescription("en", preset.id)).not.toHaveLength(0);
    }
  });

  it("an unknown (non-catalog) id yields '' (there is no en to fall back to)", () => {
    expect(presetDescription("en", "no-such-preset")).toBe("");
    expect(presetDescription("zh", "no-such-preset")).toBe("");
  });
});

describe("zh spot-checks (best-effort; a human zh reviewer is final)", () => {
  const zh = (key: Parameters<typeof t>[1], args?: Record<string, string | number>): string =>
    t("zh", key, args);

  it("renders zh for representative keys (not en, not blank)", () => {
    expect(zh("cancel")).toBe("取消");
    expect(zh("labelContextWindow")).toBe("上下文窗口");
    expect(zh("labelMaxTokens")).toBe("最大输出 tokens");
    expect(zh("imageInputLabel")).toBe("支持图像输入");
    expect(zh("reasoningEffortLabel")).toBe("支持推理强度");
    expect(zh("dotOkDefault")).toBe("目录检查通过");
    expect(zh("dotErrorDefault")).toBe("目录检查失败");
  });

  it("zh A3 ok detail uses the zh count phrase + '最后检查'", () => {
    expect(zh("dotOk", { countLabel: "18 个模型", at: "14:02" })).toBe("18 个模型 · 最后检查 14:02");
  });

  it("zh preserved parts", () => {
    expect(zh("preservedReasoningOn")).toBe("reasoning：开");
    expect(zh("preservedReasoningOff")).toBe("reasoning：关");
    expect(zh("preservedDeepFields", { keys: "mystery" })).toBe(
      "存在深层模板字段（mystery）— 请在 settings.yaml 中编辑",
    );
  });
});
