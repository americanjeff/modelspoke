/**
 * modelspoke dsh client — the i18n string bundle (the dsh per-package
 * typed `locales.ts` pattern).
 *
 * Scope (the Modelspoke settings section of the dsh web UI): EVERY
 * user-facing string the section renders — labels, buttons, tooltips,
 * aria-labels (they are user-facing for screen readers), placeholders,
 * the status-dot hover detail, the commit errors, and the read-only
 * "preserved from settings.yaml" line — plus the localized preset
 * (catalog) description accessor. The read_image tool view
 * (`tool.call.toolview`) is a separate surface (not the settings section)
 * and is intentionally NOT part of this bundle.
 *
 * FRAMEWORK-NEUTRAL ON PURPOSE: no react, no DOM. The browser-language
 * fallback reads `navigator.language` in the client (src/dsh/client.tsx)
 * and hands it here as a plain string, so this module compiles under the
 * node build's tsconfig (lib ES2022, no DOM) AND the client tsconfig
 * (lib ES2022 + DOM). tsdown inlines it into dist/dsh/client.js — the
 * bundle's runtime requires stay exactly react + react/jsx-runtime.
 *
 * EN IS THE SOURCE OF TRUTH: the `en` strings are the EXACT current UI
 * strings, extracted verbatim from client.tsx (a translation build, not a
 * copy rewrite) — "no locale set + browser en" renders byte-for-byte the
 * same text the section rendered before this module existed (en-identity
 * guarantee; test/locales.test.ts). The `zh` strings are best-effort
 * Simplified Chinese, REVIEWABLE (a human zh reviewer is the final word
 * before publish).
 *
 * INTERPOLATION: `t(locale, key, args)` substitutes `{name}` placeholders
 * with `String(args[name])`. Per-key zh strings may reorder the words
 * (normal for zh) but consume the SAME args. A placeholder absent from
 * `args` is left intact (defensive — a literal `{...}` is never silently
 * deleted).
 */

import { presetCatalog } from "../presets/catalog.js";

/** The two locale ids modelspoke ships (mirrors dsh's `LOCALE_IDS`). */
export type LocaleId = "en" | "zh";

/** The shipped locale ids (mirrors dsh's `LOCALE_IDS = ['zh','en']`). */
export const LOCALE_IDS = ["en", "zh"] as const;

/** Runtime guard: is this value a shipped locale id? */
export function isLocaleId(value: unknown): value is LocaleId {
  return value === "en" || value === "zh";
}

/**
 * The browser half of the resolution chain: a `navigator.language` (or any
 * BCP-47 language tag) maps to `zh` when it starts with `zh` (zh, zh-CN,
 * zh-TW, zh-Hant, …), else `en`. The host's own fallback, so behavior stays
 * consistent with dsh.
 */
export function localeFromBrowser(language: string | undefined): LocaleId {
  if (typeof language === "string" && language.trim().toLowerCase().startsWith("zh")) {
    return "zh";
  }
  return "en";
}

export interface LocaleResolutionInput {
  /** The bound `locale` namespace's `preference` field (raw — validated here). */
  preference?: unknown;
  /** The browser language (the client reads `navigator.language`). */
  browserLanguage?: string;
  /** `true` when `bind({ namespace: "locale" })` threw — browser-only. */
  bindFailed?: boolean;
}

/**
 * THE RESOLUTION CHAIN (mirroring the host):
 *
 *   1. the bound `locale.preference`, when it is a shipped locale id
 *      (`"zh"` | `"en"` — anything else is treated as ABSENT);
 *   2. else the browser language (starts with `zh` → `zh`, else `en`).
 *
 * When `bindFailed` the preference is IGNORED (the namespace was not
 * registered — a future host without dsh's locale plugin) and the browser
 * language alone decides. Pure: no DOM, no settings read — the client
 * supplies the facts. Live switching is the client's `subscribe` re-running
 * this (a preference change is a snapshot replacement).
 */
export function resolveLocale(input: LocaleResolutionInput): LocaleId {
  if (input.bindFailed === true) {
    return localeFromBrowser(input.browserLanguage);
  }
  if (isLocaleId(input.preference)) {
    return input.preference;
  }
  return localeFromBrowser(input.browserLanguage);
}

export interface LocaleBindAttempt<T> {
  /** The bound scope, or `null` when the bind threw. */
  scope: T | null;
  /** `true` when `bind` threw (namespace not registered). */
  bindFailed: boolean;
}

/**
 * The FALLBACK-DEFENSIVE bind seam: `bind` is injectable so the failure
 * path is unit-tested without a host. A throwing bind (namespace not
 * registered — e.g. a future host without dsh's locale plugin) yields
 * `{ scope: null, bindFailed: true }` and the caller uses browser-only.
 * The catch swallows the throw on purpose (the section must still render);
 * the client logs once at the call site.
 */
export function attemptLocaleBind<T>(bind: () => T): LocaleBindAttempt<T> {
  try {
    return { scope: bind(), bindFailed: false };
  } catch {
    return { scope: null, bindFailed: true };
  }
}

/** One key's localized forms. The `satisfies` below enforces, at compile
 * time, that EVERY key carries BOTH `en` and `zh` (no missing, no extra) —
 * the key-completeness contract (test/locales.test.ts walks it at runtime
 * as well). */
interface LocalizedString {
  readonly en: string;
  readonly zh: string;
}

/**
 * The Modelspoke section's user-facing strings, en (verbatim from
 * client.tsx) + zh (best-effort, reviewable). `{name}` marks an
 * interpolation arg (see {@link t}).
 */
const STRINGS = {
  intro: {
    en: "Enter your providers' base URLs to use models from your local OpenAI-compatible servers.",
    zh: "填写各提供方的基础 URL，即可使用你本地 OpenAI 兼容服务器上的模型。",
  },
  loadingProviders: {
    en: "Loading providers…",
    zh: "正在加载提供方…",
  },
  settingsUnavailable: {
    en: "Settings are not available in this session.",
    zh: "本会话中设置不可用。",
  },
  emptyProviders: {
    en: "No providers yet — add your first one below.",
    zh: "还没有提供方 — 在下方添加第一个。",
  },
  emptyProvidersHint: {
    en: "The `modelspoke:` section of settings.yaml remains editable by hand (a provider is one entry under `routes:`); this list reflects it live.",
    zh: "settings.yaml 中的 `modelspoke:` 段落仍可手动编辑（一个提供方是 `routes:` 下的一条）；此列表实时反映它。",
  },
  saveFailed: {
    en: "Save failed — the settings changed in the meantime or the write was refused. The list below shows the current state.",
    zh: "保存失败 — 期间设置已变化，或写入被拒绝。下方列表显示当前状态。",
  },

  edit: {
    en: "Edit",
    zh: "编辑",
  },
  delete: {
    en: "Delete",
    zh: "删除",
  },
  ariaEditProvider: {
    en: "Edit provider {name}",
    zh: "编辑提供方 {name}",
  },
  ariaDeleteProvider: {
    en: "Delete provider {name}",
    zh: "删除提供方 {name}",
  },
  confirmDeleteProvider: {
    en: "Delete provider \"{name}\"? Its per-model configurations move to the top-level overrides (or are dropped when a surviving provider claims the same model).",
    zh: "删除提供方 \"{name}\"？其每模型配置将移至顶层 overrides（若存活的提供方声明了同一模型，则被丢弃）。",
  },

  labelName: {
    en: "Name",
    zh: "名称",
  },
  ariaProviderName: {
    en: "Provider name",
    zh: "提供方名称",
  },
  hintProviderKey: {
    en: "the provider key — renaming writes the new key; the provider's models and per-model configurations follow it",
    zh: "提供方键 — 重命名会写入新键；该提供方的模型与每模型配置随之迁移",
  },
  labelBaseUrl: {
    en: "Base URL",
    zh: "基础 URL",
  },
  ariaBaseUrl: {
    en: "Base URL",
    zh: "基础 URL",
  },
  labelApiKeyEnv: {
    en: "API key env var name",
    zh: "API 密钥环境变量名",
  },
  hintApiKeyOptional: {
    en: "(optional — the variable's value is never stored)",
    zh: "（可选 — 变量的值不会被存储）",
  },
  ariaApiKeyEnv: {
    en: "API key env var name",
    zh: "API 密钥环境变量名",
  },
  phApiKeyEnv: {
    en: "e.g. LLAMA_SWAP_API_KEY",
    zh: "例如 LLAMA_SWAP_API_KEY",
  },
  labelDefaultEffort: {
    en: "Default effort",
    zh: "默认推理强度",
  },
  cancel: {
    en: "Cancel",
    zh: "取消",
  },
  saving: {
    en: "Saving…",
    zh: "保存中…",
  },
  apply: {
    en: "Apply",
    zh: "应用",
  },
  ariaApplyProvider: {
    en: "Apply provider",
    zh: "应用提供方",
  },
  add: {
    en: "Add",
    zh: "添加",
  },
  /** The add-provider form's primary button (the "Next" flow: the commit
    *  opens the new provider's card on its fetched catalog). */
  next: {
    en: "Next",
    zh: "下一步",
  },
  addProvider: {
    en: "+ Add provider",
    zh: "+ 添加提供方",
  },
  addProviderTitle: {
    en: "Add provider",
    zh: "添加提供方",
  },

  labelModels: {
    en: "Models",
    zh: "模型",
  },
  countFetching: {
    en: "fetching the catalog…",
    zh: "正在获取目录…",
  },
  countConfigured: {
    en: "{count} configured",
    zh: "{count} 个已配置",
  },
  fetchingCatalog: {
    en: "Fetching the provider's catalog…",
    zh: "正在获取提供方的目录…",
  },
  catalogFetchError: {
    en: "Couldn't reach the server — showing configured models only.",
    zh: "无法连接服务器 — 仅显示已配置的模型。",
  },
  retry: {
    en: "Retry",
    zh: "重试",
  },
  addModel: {
    en: "Add model",
    zh: "添加模型",
  },
  phNewModelId: {
    en: "the exact model id (for ids the server doesn't list)",
    zh: "精确的模型 id（用于服务器未列出的 id）",
  },
  comboNoCatalog: {
    en: "no catalog to list — type the id directly",
    zh: "目录暂不可用 — 可直接输入 id",
  },
  comboNoMatch: {
    en: "no catalog match — the typed id will be used as-is",
    zh: "目录中无匹配 — 将直接使用所输入的 id",
  },

  ariaHideDetails: {
    en: "Hide details for {id}",
    zh: "收起 {id} 的详情",
  },
  ariaShowDetails: {
    en: "Show details for {id}",
    zh: "展开 {id} 的详情",
  },
  ariaModelNameFor: {
    en: "Model name for {id}",
    zh: "模型 {id} 的名称",
  },
  ariaModelIdFor: {
    en: "Model wire id for {id}",
    zh: "模型 {id} 的 wire id",
  },
  ariaRemoveModel: {
    en: "Remove model {id}",
    zh: "移除模型 {id}",
  },

  labelContextWindow: {
    en: "Context window",
    zh: "上下文窗口",
  },
  ariaContextWindowFor: {
    en: "Context window for {id}",
    zh: "{id} 的上下文窗口",
  },
  phUnsetResolves: {
    en: "unset — resolves at runtime",
    zh: "未设置 — 运行时解析",
  },
  labelMaxTokens: {
    en: "Max output tokens",
    zh: "最大输出 tokens",
  },
  ariaMaxTokensFor: {
    en: "Max output tokens for {id}",
    zh: "{id} 的最大输出 tokens",
  },
  ariaThinkingLevelRow: {
    en: "Thinking level for {id} (row {row})",
    zh: "{id} 的思考级别（第 {row} 行）",
  },
  ariaAcceptedLevel: {
    en: "Accepted level for {level} of {id}",
    zh: "{id} 的 {level} 的接受级别",
  },
  notSupported: {
    en: "not supported",
    zh: "不支持",
  },
  ariaRemoveRow: {
    en: "Remove the {level} row for {id}",
    zh: "移除 {id} 的 {level} 行",
  },
  titleRemoveRow: {
    en: "Remove the {level} row",
    zh: "移除 {level} 行",
  },
  addLevelRow: {
    en: "Add level row",
    zh: "添加级别行",
  },
  ariaAddLevelRow: {
    en: "Add a thinking level row for {id}",
    zh: "为 {id} 添加一行思考级别",
  },
  ariaImageInputFor: {
    en: "Image input for {id}",
    zh: "{id} 支持图像输入",
  },
  imageInputLabel: {
    en: "Image input",
    zh: "支持图像输入",
  },
  ariaReasoningEffortFor: {
    en: "Reasoning effort for {id}",
    zh: "{id} 支持推理强度",
  },
  reasoningEffortLabel: {
    en: "Reasoning effort",
    zh: "支持推理强度",
  },
  capabilitiesLabel: {
    en: "Capabilities",
    zh: "能力",
  },
  harnessColumn: {
    en: "Harness",
    zh: "Harness",
  },
  modelColumn: {
    en: "Model",
    zh: "模型",
  },
  effortBuiltInDefault: {
    en: "default ({level})",
    zh: "默认（{level}）",
  },
  ariaDefaultEffortFor: {
    en: "Default effort for {id}",
    zh: "{id} 的默认推理强度",
  },
  preservedLine: {
    en: "Preserved from settings.yaml (read-only): {summary}",
    zh: "保留自 settings.yaml（只读）：{summary}",
  },
  resetPendingNote: {
    en: "The entry will be deleted on save — the model stays active and its configuration resolves from server discovery / presets / defaults again.",
    zh: "保存时将删除该条目 — 模型保持激活，其配置重新从服务器发现 / 预设 / 默认值解析。",
  },
  reset: {
    en: "Reset",
    zh: "重置",
  },
  undoReset: {
    en: "Undo reset",
    zh: "撤销重置",
  },
  ariaResetFor: {
    en: "Reset {id}",
    zh: "重置 {id}",
  },
  ariaUndoResetFor: {
    en: "Undo reset for {id}",
    zh: "撤销 {id} 的重置",
  },

  dotUnknown: {
    en: "Not checked yet — expand to fetch",
    zh: "尚未检查 — 展开以获取",
  },
  dotOkDefault: {
    en: "Catalog check passed",
    zh: "目录检查通过",
  },
  dotErrorDefault: {
    en: "Catalog check failed",
    zh: "目录检查失败",
  },
  /** Success detail: "18 models · last checked 14:02" (countLabel = the
   *  locale's "N model(s)" phrase; the plural is English-only). */
  dotOk: {
    en: "{countLabel} · last checked {at}",
    zh: "{countLabel} · 最后检查 {at}",
  },
  /** Failure variants — the SPECIFIC problem + the `HH:MM` suffix. The
   *  `status` arg is the raw HTTP status text (a technical value, kept). */
  dotErrorUnreachable: {
    en: "Server unreachable (connection refused) · {at}",
    zh: "无法连接服务器（连接被拒绝） · {at}",
  },
  dotErrorUnauthorized: {
    en: "401 Unauthorized — set {apiKeyEnv} · {at}",
    zh: "401 未授权 — 请设置 {apiKeyEnv} · {at}",
  },
  dotErrorUnauthorizedNoKey: {
    en: "401 Unauthorized from /v1/models · {at}",
    zh: "401 未授权，来自 /v1/models · {at}",
  },
  dotErrorStatus: {
    en: "{status} from /v1/models · {at}",
    zh: "{status}（来自 /v1/models） · {at}",
  },
  dotErrorMalformedJson: {
    en: "Malformed response: invalid JSON from /v1/models · {at}",
    zh: "响应格式错误：/v1/models 返回了无效 JSON · {at}",
  },
  dotErrorMalformedShape: {
    en: "Malformed response: expected array, got object · {at}",
    zh: "响应格式错误：期望数组，得到对象 · {at}",
  },
  /** The unrecognized-message fallthrough: the raw message is kept verbatim
   *  in BOTH locales (it is a server/harness message, not modelspoke copy). */
  dotErrorRaw: {
    en: "{message} · {at}",
    zh: "{message} · {at}",
  },
  /** The RPC's error message was absent (a rare edge): the generic detail. */
  dotErrorUnknown: {
    en: "unknown error",
    zh: "未知错误",
  },

  preservedReasoningOn: {
    en: "reasoning: on",
    zh: "reasoning：开",
  },
  preservedReasoningOff: {
    en: "reasoning: off",
    zh: "reasoning：关",
  },
  preservedDeepFields: {
    en: "deep template fields present ({keys}) — edit in settings.yaml",
    zh: "存在深层模板字段（{keys}）— 请在 settings.yaml 中编辑",
  },

  errProviderGone: {
    en: "The provider this card edits no longer exists.",
    zh: "该卡片正在编辑的提供方已不存在。",
  },
  errProviderNameRequired: {
    en: "A provider name is required.",
    zh: "提供方名称为必填项。",
  },
  errNameCollision: {
    en: "\"{name}\" is already used by another model in this provider — model names must be unique.",
    zh: "\"{name}\" 已被本提供方中的另一个模型使用 — 模型名称必须唯一。",
  },
  nameCollisionHint: {
    en: "Duplicate name \"{name}\".",
    zh: "名称\"{name}\"重复。",
  },
  nameCollisionFix: {
    en: "Rename to \"{suggested}\"",
    zh: "重命名为\"{suggested}\"",
  },
  errBaseUrlRequired: {
    en: "A base URL is required.",
    zh: "基础 URL 为必填项。",
  },
  errProviderExists: {
    en: "A provider named \"{name}\" already exists — the name is the provider identity and must be unique.",
    zh: "名为 \"{name}\" 的提供方已存在 — 名称即提供方标识，必须唯一。",
  },
  errContextWindow: {
    en: "Context window for \"{id}\" must be a positive whole number of tokens, or left empty to release the field.",
    zh: "\"{id}\" 的上下文窗口必须是正整数 token 数，或留空以释放该字段。",
  },
  errMaxTokens: {
    en: "Max output tokens for \"{id}\" must be a positive whole number of tokens, or left empty to release the field.",
    zh: "\"{id}\" 的最大输出 tokens 必须是正整数 token 数，或留空以释放该字段。",
  },
  errDuplicateTlKey: {
    en: "Duplicate key \"{key}\" in the thinking level map for \"{id}\" — remove one of the rows.",
    zh: "\"{id}\" 的思考级别映射中存在重复 key \"{key}\" — 请移除其中一行。",
  },
  errDuplicateTlKeyInline: {
    en: "Duplicate key \"{key}\" in the thinking level map — a row already uses it.",
    zh: "思考级别映射中存在重复 key \"{key}\" — 已有一行在使用。",
  },
  topOverridesHeading: {
    en: "Top-level overrides",
    zh: "顶层 overrides",
  },
  topOverridesHint: {
    en: "These entries still apply at resolution — every provider without its own entry for the model inherits them.",
    zh: "这些条目在解析时仍然生效 — 没有为该模型配置自有条目的提供方都会继承它们。",
  },
  /** The claimed row's hint: `names` = the claiming provider names,
   *  pre-joined by the caller (the join separator is the locale's). */
  topOverrideShadowed: {
    en: "shadowed by {names} — it still applies to every other provider",
    zh: "被 {names} 遮蔽 — 对其它提供方仍生效",
  },
  ariaDeleteTopOverride: {
    en: "Delete orphaned override {id}",
    zh: "删除未被提供方声明的顶层 override {id}",
  },
  confirmDeleteTopOverride: {
    en: "Delete the top-level override \"{id}\"? No provider has its own entry for it, so the model's configuration resolves from server discovery / presets / defaults again.",
    zh: "删除顶层 override \"{id}\"？没有任何提供方为它配置了自有条目，删除后该模型的配置重新从服务器发现 / 预设 / 默认值解析。",
  },

  /** The Plugins-page card's disclosure header (ModelspokeCard in
   *  client.tsx) — name + description, the in-box card chrome pattern. */
  pluginCardTitle: {
    en: "Modelspoke",
    zh: "Modelspoke",
  },
  pluginCardDescription: {
    en: "Local OpenAI-compatible model servers — providers, models, and per-model configuration.",
    zh: "本地 OpenAI 兼容模型服务器 — 提供方、模型与逐模型配置。",
  },
} satisfies Record<string, LocalizedString>;

/** The typed key set (compile-time: a misspelled key is a type error). */
export type StringKey = keyof typeof STRINGS;

/** Every string key, for the runtime completeness walk (test). */
export function stringKeys(): StringKey[] {
  return Object.keys(STRINGS) as StringKey[];
}

/** The t() accessor's interpolation args (typed: string or number values). */
export type TArgs = Record<string, string | number>;

/**
 * The typed accessor: `t(locale, key, ...args)` → the localized string with
 * `{name}` placeholders substituted from `args` (see the module header for
 * the interpolation contract). A placeholder absent from `args` is left
 * intact (defensive). No runtime requires (inlined by tsdown).
 */
export function t(locale: LocaleId, key: StringKey, args?: TArgs): string {
  const template = STRINGS[key][locale];
  if (args === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (match: string, name: string): string => {
    if (name === undefined || !(name in args)) return match;
    const value = args[name];
    return value === undefined ? "" : String(value);
  });
}

// descriptions
//
// The preset description strings that surface in model
// selection. The EN source of truth is the shared catalog's `notes`
// (src/presets/catalog.ts) — read, NOT copied, so the catalog stays the
// single source. The client bundle keeps ONLY the zh, keyed by preset id.
// A preset id with no zh falls back to the en (never blank for a catalog
// preset — every entry carries `notes`).

/** The zh preset descriptions, keyed by preset id (best-effort, reviewable). */
export const PRESET_ZH: Readonly<Record<string, string>> = {
  "qwen3.8-chat-template":
    "Qwen3.8 模板（chat_template.jinja 已于 2026-08 验证）：effort 仅支持 xhigh/medium/low——模板对其他取值会 raise。preserve_thinking 固定多轮思考回放行为（undefined 时同样会保留；显式设置可防御模板修订翻转默认值）。maxTokens 远低于 ctx/2：当 input+max_tokens > ctx 时 sglang 返回 400（无 clamp）。",
  "qwen3.6-chat-template":
    "Qwen3.6 模板（27B-MTP 与 35B-A3B-MTP 的 GGUF 字节一致，sha256 55d49314…ea0c，2026-08；HF chat_template.jinja ×3 相同，e84f32a2…74259）：无 effort 词表——reasoning_effort 出现次数为零，因此不发送 effort kwarg，映射为退化的 on/off 形式 {off, low}。enable_thinking 与 3.8 极性相同（undefined/true = 思考；line 152/149 仅在 defined-false 时命中）。preserve_thinking：行为上必须为 true——undefined 时 line 103/100 会剥离之前轮次的思考（没有 `is undefined` 析取项，与 3.8 的 line 116 不同）；无论哪种情况，都只保留最后一次 query 之后的思考。contextWindow 取自 qwen35(.moe).context_length GGUF 键（262144，两个变体均如此）；maxTokens 65536 相对 ctx/2 保守（面向 sglang，无 clamp：input+max_tokens > ctx 会 400）。两个尺寸共用一个预设：模板相同，故契约相同。",
  "qwen3.5-chat-template":
    "Qwen3.5-4B GGUF 模板（sha256 7f0e5290…ed67，2026-08）：enable_thinking 极性与 3.6/3.8 相反——line 150 的思考分支条件为 `defined and is true`，因此 UNDEFINED 的 enable_thinking = 无思考级别（nothink）；{$var: 'thinking.enabled'} 绑定之所以安全，仅因为 harness 始终发送布尔值且绝不省略——不要添加 omitWhenOff，也不要让 off 状态省略该 kwarg。退化的 on/off 形式 {off, low}：reasoning_effort/effort 出现次数为零，不发送 effort kwarg。无 preserve_thinking 变量（出现次数为零）——line 100 仅保留最后一个用户 query 之后的思考；无可发送内容。contextWindow 取自 qwen35.context_length GGUF 键（262144）；maxTokens 有意缺省（无本地 3.5 部署可支撑该上限）。input 有意缺省（没有任何 artifact 声明 4B 具备 vision）。基于唯一的本地 3.5 artifact 编写——更大 3.5 checkpoint 见未决问题。",
  "gpt-oss-120b-chat-template":
    "gpt-oss-120b GGUF 模板（MXFP4 gguf，sha256 a4c9919c…146，2026-08）：推理面仅有 reasoning_effort——enable_thinking/preserve_thinking 出现次数为零；模板始终输出 analysis 通道，line 203-206 将 'Reasoning: <effort>' 渲染进系统消息，kwarg 缺失时默认为 'medium'。模板不校验取值（effort 不会 raise），因此保守声明的词表为文档化的 {low, medium, high}——未列出取值的最坏后果是模型行为风险，绝不会 400。off => 'medium' + omitWhenOff：省略该 kwarg 让模板自身的 medium 默认值生效（并不存在杜撰的 'off' 级别）；off 是该模板支持的最接近最小推理的状态，而非真正的思考关闭。contextWindow 取自 gpt-oss.context_length GGUF 键（131072）；maxTokens 65536 与经验证的 llama-swap 部署值一致（ctx/2）。按模板 input 仅支持文本（content 仅 string）。",
};

/**
 * The localized preset (catalog) description: `zh` → the keyed zh string
 * (when present and non-empty), else the EN source of truth — the shared
 * catalog's `notes` (read, unchanged). Never blank for a catalog preset.
 */
export function presetDescription(locale: LocaleId, presetId: string): string {
  if (locale === "zh") {
    const zh = PRESET_ZH[presetId];
    if (zh !== undefined && zh !== "") return zh;
  }
  const preset = presetCatalog.find((entry) => entry.id === presetId);
  return preset?.notes ?? "";
}

/** Every preset id that has a zh description (the completeness test walks
 * the catalog against this). */
export function presetZhIds(): string[] {
  return Object.keys(PRESET_ZH);
}

/** The locale's "N model(s)" count phrase (the plural is English-only; zh has
 * no plural): "18 models" / "1 model" / "18 个模型". Shared by the status dot
 * detail (curation) and the card's model-list count hint (client). */
export function modelCountLabel(locale: LocaleId, count: number): string {
  return locale === "en" ? `${count} ${count === 1 ? "model" : "models"}` : `${count} 个模型`;
}
