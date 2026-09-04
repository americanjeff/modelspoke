/**
 * The `preset-draft` authoring command: the PURE half (no I/O, no fetch).
 *
 * Takes the fetched template text + fetch-side facts and produces a DRAFT for
 * a human to review: (1) a DRAFT catalog entry in the exact `src/presets/
 * catalog.ts` shape, (2) the provenance manifest entry, and (3)
 * a checklist of the JUDGMENT items (pi-level alignment, degenerate forms,
 * maxTokens policy, README-only vocabulary) with the relevant template
 * excerpts alongside. design.md boundary: the tool DRAFTS; a human reviews
 * and commits — it never ships a preset.
 *
 * One pipeline, three consumers: invariant derivation is
 * IMPORTED from scripts/drift-invariants.ts, never re-implemented. The draft
 * is self-checked against its own template with `checkPresetInvariants` — so
 * it can NEVER propose a thinkingLevelMap value the template's raise-guard
 * rejects (docs/design.md's "never silently invent a level" invariant,
 * applied to authoring: the mechanical half is enforced, the judgment half
 * is marked, never guessed).
 *
 * The CLI half (scripts/preset-draft.ts) owns all networking (node:fetch —
 * the same zero-dependency path the drift checker uses) and injects the fetched facts
 * here. Everything in this file is unit-testable offline against the
 * committed fixtures.
 *
 * Node >= 22.18 native TS stripping (erasable syntax only).
 */

import { createHash } from "node:crypto";

import type { Preset } from "../src/types.ts";
import {
  checkPresetInvariants,
  describeInvariants,
  DriftExtractError,
  extractInvariants,
  type InvariantFamily,
  type TemplateInvariants,
} from "./drift-invariants.ts";

/** A condition that stops the draft (reported, exit 1 — no draft file). */
export class DraftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DraftError";
  }
}

/**
 * The THREE template spellings the repo probe tries (spike, "Where the
 * template lives"), in probe order — plus the two non-hub sources the CLI
 * can supply (the GGUF-embedded copy; a local file in offline mode).
 */
export const SPELLING_ORDER = ["chat_template.jinja", "chat_template.json", "api-embedded"] as const;
export type HubSpelling = (typeof SPELLING_ORDER)[number];
export type TemplateSpelling = HubSpelling | "gguf-embedded" | "local-file";

/** What the hub API metadata (GET /api/models/{repo}) tells us. */
export interface HubMetadata {
  /** Repo head commit (the `sha` field) — the pin candidate, never fetched by head. */
  sha: string | null;
  /** File names present in the repo (the `siblings[].rfilename` list). */
  siblings: string[];
  /** The embedded config block (config.json + tokenizer_config merge). */
  config: Record<string, unknown>;
  /** The API-embedded `tokenizer_config.chat_template` text, when present. */
  embeddedTemplate: string | null;
}

/**
 * Accept `org/name`, `https://huggingface.co/org/name`, with or without
 * trailing path segments. Returns the bare `org/name`. Throws on anything
 * else (a non-HF host is not a template source this tool speaks).
 */
export function normalizeRepo(input: string): string {
  const raw = input.trim();
  let pathname: string;
  if (/^https?:\/\//i.test(raw)) {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new DraftError(`repo '${input}' is neither a URL nor org/name`);
    }
    if (!/huggingface\.co$/i.test(u.hostname)) {
      throw new DraftError(`repo host '${u.hostname}' is not huggingface.co`);
    }
    pathname = u.pathname;
  } else {
    pathname = raw;
  }
  const parts = pathname.split("/").filter((p) => p.length > 0);
  if (parts.length < 2) {
    throw new DraftError(`repo '${input}' does not look like org/name`);
  }
  const [org, name] = [parts[0] as string, parts[1] as string];
  if (!/^[A-Za-z0-9_.-]+$/.test(org) || !/^[A-Za-z0-9_.-]+$/.test(name)) {
    throw new DraftError(`repo '${org}/${name}' has invalid path segments`);
  }
  return `${org}/${name}`;
}

export interface Spellings {
  jinja: boolean;
  json: boolean;
  apiEmbedded: boolean;
}

export function detectSpellings(meta: HubMetadata): Spellings {
  return {
    jinja: meta.siblings.includes("chat_template.jinja"),
    json: meta.siblings.includes("chat_template.json"),
    apiEmbedded: meta.embeddedTemplate !== null,
  };
}

export function pickSpelling(s: Spellings): HubSpelling | null {
  if (s.jinja) return "chat_template.jinja";
  if (s.json) return "chat_template.json";
  if (s.apiEmbedded) return "api-embedded";
  return null;
}

/** Spellings present besides the primary (informational — verify or pin). */
export function otherSpellings(s: Spellings, primary: HubSpelling): HubSpelling[] {
  const found: HubSpelling[] = [];
  if (s.jinja) found.push("chat_template.jinja");
  if (s.json) found.push("chat_template.json");
  if (s.apiEmbedded) found.push("api-embedded");
  return found.filter((f) => f !== primary);
}

/** A repo whose NAME says GGUF (quantization repo: a different artifact per file). */
export function isGgufRepo(repo: string): boolean {
  const slash = repo.indexOf("/");
  const name = slash < 0 ? repo : (repo.slice(slash + 1) ?? "");
  return /gguf/i.test(name);
}

export function ggufFiles(siblings: string[]): string[] {
  return siblings.filter((f) => /\.gguf$/i.test(f)).sort();
}

export interface GgufChoice {
  chosen: string;
  /** true = more than one candidate existed (or an explicit choice among many). */
  ambiguous: boolean;
}

/**
 * Which .gguf file to read. The tool NEVER guesses silently: with several
 * candidates it picks the first (sort order) as a DEFAULT ONLY, and the
 * caller must surface the flag + offer `--file <name>` to override.
 */
export function chooseGgufFile(files: string[], explicit?: string): GgufChoice {
  if (explicit !== undefined) {
    if (!files.includes(explicit)) {
      throw new DraftError(`--file '${explicit}' is not a .gguf file in the repo (candidates: ${files.join(", ")})`);
    }
    return { chosen: explicit, ambiguous: files.length > 1 };
  }
  if (files.length === 0) throw new DraftError("no .gguf files in the repo (siblings list)");
  const sorted = [...files].sort();
  if (sorted.length === 1) return { chosen: sorted[0] as string, ambiguous: false };
  return { chosen: sorted[0] as string, ambiguous: true };
}

/**
 * The prominent flag block for a GGUF repo: names the ambiguous copies and
 * says, per the spike, the HUMAN confirms which repo+file is the deployment
 * one (the in-force template for llama-server `--jinja`). Never a silent
 * pick.
 */
export function ggufFlagLines(
  repo: string,
  choice: GgufChoice,
  files: string[],
  baseModelRepo: string | null,
  offline: boolean,
): string[] {
  const lines: string[] = [
    "⚠ GGUF AMBIGUITY — HUMAN CONFIRMATION REQUIRED (spike: search-ambiguity finding)",
    "  A GGUF repo's embedded template is the deployment's in-force copy, and it is per-FILE:",
    "  re-quantizations re-upload the file (new sha, possibly a different template), and",
    "  quantizer/fine-tune repos of the same base model (unsloth vs bartowski, UD vs",
    "  vanilla) are separate artifacts with separate templates. The tool does NOT search",
    "  or pick — this draft was derived from:",
    `      ${repo} / ${choice.chosen}`,
  ];
  if (files.length > 1) {
    lines.push(
      `  Other GGUF copies in THIS repo (${files.length} total) — confirm none of these is the`,
      "  deployment file, or re-run with --file <name>:",
      ...files.filter((f) => f !== choice.chosen).map((f) => `      - ${f}`),
    );
  } else if (!offline) {
    lines.push("  (this repo carries a single .gguf file — the ambiguity is cross-REPO: the");
    lines.push("  base model's other quantizations are equally plausible deployment copies)");
  }
  if (baseModelRepo) {
    lines.push(`  The GGUF header's own provenance says: base_model repo = ${baseModelRepo} —`);
    lines.push("  pin BOTH copies (hub jinja + this GGUF) in the manifest; they have already");
    lines.push("  been verified divergent for qwen3.5/3.6/3.8 (the drift check catches either moving).");
  }
  lines.push(
    "  BEFORE COMMITTING: confirm which repo+file the deployment actually serves (the",
    "  llama-swap yaml names it), then pin THAT copy — do not trust this default choice.",
  );
  return lines;
}

/**
 * Which extraction family the template belongs to. Detection is by the knob
 * the family is defined over (the drift checker's dialects); a template with neither knob
 * has no template-driven thinking surface (the Qwen3-Coder-Next verdict).
 */
export function detectFamily(text: string): InvariantFamily | "none" {
  if (/\benable_thinking\b/.test(text)) return "qwen";
  if (/\breasoning_effort\b/.test(text)) return "gpt-oss";
  return "none";
}

/**
 * Line citations for the derivation sources (display only — the VALUES come
 * from the imported drift-invariants derivation; these only point at WHICH line produced
 * each fact, per the tier-reporting invariant applied to authoring).
 */
function firstLine(text: string, pred: (line: string) => boolean): string | null {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] ?? "";
    if (pred(l)) return `L${i + 1}: ${l.trim()}`;
  }
  return null;
}

function countOccurrences(text: string, token: string): number {
  let n = 0;
  let i = text.indexOf(token);
  while (i >= 0) {
    n++;
    i = text.indexOf(token, i + token.length);
  }
  return n;
}

/**
 * Extract the HubMetadata facts from the /api/models/{repo} body (the spike
 * verified the shape: `sha` = head commit, `siblings[].rfilename` = file
 * list, `config` block embeds `tokenizer_config.chat_template` for most
 * repos). Pure — the CLI does the fetch.
 */
export function hubMetadataFromApi(body: Record<string, unknown>): HubMetadata {
  const siblings = Array.isArray(body["siblings"])
    ? (body["siblings"] as Array<Record<string, unknown>>)
        .map((s) => (typeof s["rfilename"] === "string" ? (s["rfilename"] as string) : ""))
        .filter((f) => f.length > 0)
    : [];
  const config = (typeof body["config"] === "object" && body["config"] !== null ? body["config"] : {}) as Record<string, unknown>;
  const tc = (typeof config["tokenizer_config"] === "object" && config["tokenizer_config"] !== null ? config["tokenizer_config"] : {}) as Record<string, unknown>;
  const embedded =
    typeof config["chat_template"] === "string"
      ? (config["chat_template"] as string)
      : typeof tc["chat_template"] === "string"
        ? (tc["chat_template"] as string)
        : null;
  return {
    sha: typeof body["sha"] === "string" ? (body["sha"] as string) : null,
    siblings,
    config,
    embeddedTemplate: embedded,
  };
}

export function contextWindowFromConfig(config: Record<string, unknown>): { value: number; source: string } | null {
  const v = config["max_position_embeddings"];
  if (typeof v === "number" && Number.isFinite(v) && v > 0) {
    return { value: v, source: `repo config.max_position_embeddings = ${v}` };
  }
  return null;
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export function defaultDraftFileName(pattern: string): string {
  const safe = pattern.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
  return `preset-draft.${safe.length > 0 ? safe : "pattern"}.md`;
}

export interface DraftInput {
  repo: string;
  match: string;
  kind: "hub" | "gguf" | "local";
  spelling: TemplateSpelling;
  /** The artifact the template text came from (file name / 'chat_template (API-embedded)' / local path). */
  templateFile: string;
  templateText: string;
  /** Repo head commit at fetch time (hub) — null in offline mode. */
  headCommit: string | null;
  contextWindow: { value: number; source: string } | null;
  gguf: { files: string[]; chosen: string; ambiguous: boolean; baseModelRepo: string | null } | null;
  otherSpellings: TemplateSpelling[];
  familyOverride: InvariantFamily | null;
  fetchedAt: string;
  offline: boolean;
}

export const CORE_JUDGMENT_IDS = [
  "pi-level-alignment",
  "degenerate-forms",
  "maxtokens-policy",
  "readme-vocabulary",
] as const;
export type JudgmentId = (typeof CORE_JUDGMENT_IDS)[number] | "identity-and-placement" | "gguf-deployment-copy";

export interface JudgmentItem {
  id: JudgmentId;
  question: string;
  /** Derived facts, each with its template line ref where applicable. */
  mechanicalFacts: string[];
  /** Verbatim template excerpt(s) the judgment turns on. */
  excerpt?: string;
  /** What the draft pre-fills for this item (or 'absent — human decides'). */
  proposed: string;
}

export interface DraftProvenanceContract {
  kind: "hub" | "gguf";
  repo: string;
  /** Hub copies only — the manifest pins by commit, never branch head. */
  commit?: string;
  file: string;
  sha256: string;
  note: string;
}

export interface DraftArtifact {
  repo: string;
  match: string;
  kind: DraftInput["kind"];
  spelling: TemplateSpelling;
  templateFile: string;
  sha256: string;
  family: InvariantFamily | "none";
  invariants: TemplateInvariants | null;
  /** null = no-preset verdict (no template-driven thinking surface). */
  entry: Preset | null;
  /** Dotted field path -> derivation source (the tier-reporting invariant). */
  derivations: Record<string, string>;
  /** Provenance manifest entry shape (src/presets/provenance.json), or null on a no-preset verdict. */
  provenance: { presetId: string; family: string; contracts: DraftProvenanceContract[] } | null;
  judgments: JudgmentItem[];
  /** Prominent flag lines (GGUF ambiguity etc.) — rendered at the top. */
  flags: string[];
  warnings: string[];
  fetchedAt: string;
}

/** pi level ladder order (used for the mechanical 'closest selectable' off proposal). */
const PI_LEVELS = ["low", "medium", "high", "xhigh"] as const;

interface LevelMapResult {
  map: Record<string, string>;
  facts: string[];
  excerpt: string | null;
}

function buildLevelMap(inv: TemplateInvariants, text: string): LevelMapResult {
  const e = inv.effort;
  if (inv.family === "qwen") {
    if (!e.present) {
      return {
        map: { off: "low", low: "low" },
        facts: [
          "template reads NO reasoning_effort (0 occurrences) — degenerate on/off form {off, low}, the catalog convention for the no-effort Qwen lineages (3.5/3.6)",
          "the mapped value is INERT: no effort kwarg is dispatched, so the value can be anything the ladder names — the form, not the value, is the contract",
        ],
        excerpt: null,
      };
    }
    const accepted = e.accepted ?? [];
    if (accepted.length === 0) {
      throw new DraftError("the template reads reasoning_effort with no extractable raise-guard tuple — cannot propose a safe map (human authors it)");
    }
    const map: Record<string, string> = {};
    const minAccepted = PI_LEVELS.find((v) => accepted.includes(v)) ?? (accepted[0] as string);
    map["off"] = minAccepted;
    for (const L of PI_LEVELS) {
      if (accepted.includes(L)) map[L] = L;
    }
    const guardLine = firstLine(text, (l) => l.includes("not in (") && l.includes("reasoning_effort"));
    const defaultLine = firstLine(text, (l) => /reasoning_effort\s*\|\s*default\(/.test(l) || /set\s+(?:resolved_)?reasoning_effort\s*=/.test(l));
    const facts: string[] = [
      `raise-guard tuple: (${accepted.join(", ")})${guardLine ? ` — ${guardLine}` : ""} (values outside it make the template raise → mid-turn 400)`,
      `template default: '${e.default}'${defaultLine ? ` — ${defaultLine}` : ""}`,
      `off proposed as '${minAccepted}' = the closest selectable level. The template has NO 'off' level — the cross-vocabulary choice is JUDGMENT (spike feasibility item 1), pre-filled here, never asserted`,
    ];
    for (const [src, dst] of Object.entries(e.aliases)) {
      facts.push(
        `pre-guard alias '${src}' -> '${dst}' in this copy — NOT proposed as a level (the stricter copy is the authoring contract; the hub copy raises on '${src}'). If the deployment serves THIS copy, the human may add it`,
      );
    }
    return { map, facts, excerpt: guardLine ?? defaultLine };
  }
  // gpt-oss: the vocabulary is README prose, NOT template — propose off only.
  if (e.default === null) {
    throw new DraftError("gpt-oss template has no mechanical effort default — the off mapping cannot be proposed (human authors it)");
  }
  const defaultLine = firstLine(text, (l) => /set\s+reasoning_effort\s*=/.test(l));
  const map: Record<string, string> = { off: e.default };
  return {
    map,
    facts: [
      `template default: '${e.default}'${defaultLine ? ` — ${defaultLine}` : ""}`,
      "template does NOT validate the effort value (no raise-guard) — the {low, medium, high} vocabulary lives in the repo README (prose), not the template (spike): the draft proposes off ONLY; the human confirms the README and adds the levels",
      "off omits the kwarg (omitWhenOff) → the template's own default applies — the closest-to-off state the template supports",
    ],
    excerpt: defaultLine,
  };
}

/** The no-surface verdict (Qwen3-Coder-Next precedent: default tier is correct). */
function verdictDraft(input: DraftInput, sha: string, warnings: string[]): DraftArtifact {
  const counts = [
    `enable_thinking occurrences: ${countOccurrences(input.templateText, "enable_thinking")}`,
    `reasoning_effort occurrences: ${countOccurrences(input.templateText, "reasoning_effort")}`,
    `preserve_thinking occurrences: ${countOccurrences(input.templateText, "preserve_thinking")}`,
  ];
  const judgments: JudgmentItem[] = CORE_JUDGMENT_IDS.map((id) => ({
    id,
    question:
      id === "degenerate-forms"
        ? "Confirm the NO-PRESET verdict: the model truly has no template-driven thinking surface. Absence of tokens ≠ no reasoning (spike) — check the model config / README for a thinking_budget-style or system-prompt-baked surface before accepting."
        : "N/A — no template-driven thinking surface to map (no knobs exist to align, off to degenerate, or cap against).",
    mechanicalFacts: counts,
    proposed: "absent — no catalog entry is proposed; the default tier (reasoning: false, no map, basic compat) is the correct resolution for this template",
  }));
  return {
    repo: input.repo,
    match: input.match,
    kind: input.kind,
    spelling: input.spelling,
    templateFile: input.templateFile,
    sha256: sha,
    family: "none",
    invariants: null,
    entry: null,
    derivations: {
      verdict:
        "no template-driven thinking surface (zero enable_thinking / reasoning_effort / preserve_thinking) — per the Qwen3-Coder-Next precedent (docs/preset-authoring.md, 'When the verdict is no preset'), a preset would claim a per-template contract that does not exist and every kwarg it sent would be a silent no-op; the default tier is the correct resolution",
      ...(input.contextWindow
        ? {
            "contextWindow (noted)": `${input.contextWindow.source} — could support a capacity-only entry if the team wants one (the authoring pass: defensible, optional)`,
          }
        : {}),
    },
    provenance: null,
    judgments,
    flags: input.gguf ? ggufFlagLines(input.repo, input.gguf, input.gguf.files, input.gguf.baseModelRepo, input.offline) : [],
    warnings,
    fetchedAt: input.fetchedAt,
  };
}

/**
 * Build the draft from fetched facts. Throws DraftError when the template
 * shape is unrecognized or the self-check fails — a draft the tool cannot
 * vouch for mechanically is not written.
 */
export function buildDraft(input: DraftInput): DraftArtifact {
  let re: RegExp;
  try {
    re = new RegExp(input.match);
  } catch (e) {
    throw new DraftError(`--match '${input.match}' is not a valid regular expression: ${e instanceof Error ? e.message : String(e)}`);
  }
  void re;

  const text = input.templateText;
  const sha = sha256Hex(text);
  const family = input.familyOverride ?? detectFamily(text);

  const warnings: string[] = [];
  if (input.kind === "hub" && !input.offline) {
    warnings.push(
      "if the deployment serves a GGUF quantization (llama-server --jinja), the GGUF-embedded copy may DIVERGE from this hub template (verified for qwen3.5/3.6/3.8) — run preset-draft on the GGUF repo too and pin both copies (the drift check catches either moving)",
    );
  }
  if (input.otherSpellings.length > 0) {
    warnings.push(
      `other template spellings present in the repo: ${input.otherSpellings.join(", ")} — verify they are identical to the primary or pin them explicitly (the drift checker can pin multiple copies per entry)`,
    );
  }

  if (family === "none") {
    return verdictDraft(input, sha, warnings);
  }

  let inv: TemplateInvariants;
  try {
    inv = extractInvariants(family, text);
  } catch (e) {
    if (e instanceof DriftExtractError) {
      throw new DraftError(
        `template shape not recognized for family '${family}': ${e.message} — the known dialects changed or this is a new family; re-author by hand from the template (the tool does not guess)`,
      );
    }
    throw e;
  }

  const knobs: string[] = [];
  if (inv.enableThinking.present) knobs.push("enable_thinking");
  if (inv.effort.present) knobs.push("reasoning_effort");
  if (inv.preserveThinking.present) knobs.push("preserve_thinking");

  const { map, facts: mapFacts, excerpt: mapExcerpt } = buildLevelMap(inv, text);

  // chatTemplateKwargs: exactly the knobs the template reads — a kwarg the template never reads is a silent no-op (the failure class presets prevent).
  const kwargs: NonNullable<NonNullable<Preset["compat"]>["chatTemplateKwargs"]> = {};
  const deriv: Record<string, string> = {};
  const knobLine = (token: string): string | null =>
    firstLine(text, (l) => l.includes(token) && (l.includes("if") || l.includes("set") || l.includes("default")));

  if (inv.enableThinking.present) {
    kwargs["enable_thinking"] = { "$var": "thinking.enabled" };
    deriv["compat.chatTemplateKwargs.enable_thinking"] = `template reads enable_thinking — ${knobLine("enable_thinking") ?? "gate line not located"}; explicit boolean, NO omitWhenOff (the qwen3.5 undefined-state lesson: omitting flips the state) — polarity table: true→${inv.enableThinking.whenTrue}, false→${inv.enableThinking.whenFalse}, undefined→${inv.enableThinking.whenUndefined}`;
  }
  if (inv.effort.present) {
    if (inv.effort.default !== null) {
      kwargs["reasoning_effort"] = { "$var": "thinking.effort", omitWhenOff: true };
      deriv["compat.chatTemplateKwargs.reasoning_effort"] = `template reads reasoning_effort with default '${inv.effort.default}' — ${knobLine("reasoning_effort") ?? "default line not located"}; omitWhenOff: the off state omits the kwarg so the template's own default applies`;
    } else {
      kwargs["reasoning_effort"] = { "$var": "thinking.effort" };
      warnings.push("no mechanical effort default found in the template — omitWhenOff NOT proposed; the human must verify what the off state sends");
    }
  }
  if (inv.preserveThinking.present) {
    kwargs["preserve_thinking"] = true;
    const keepLine = firstLine(text, (l) => l.includes("preserve_thinking") && l.includes("last_query_index"));
    deriv["compat.chatTemplateKwargs.preserve_thinking"] = `template reads preserve_thinking — keep-branch ${keepLine ?? "not located"}; undefined ${inv.preserveThinking.undefinedPreserves ? "PRESERVES (the explicit pin is defensive)" : "STRIPS prior-turn thinking (the literal true is behaviorally REQUIRED — silent multi-turn regression otherwise)"}`;
  }

  const imageLine = firstLine(text, (l) => l.includes("image_url") || l.includes("'image' in item") || l.includes("cannot contain images"));

  const repoName = input.repo.includes("/") ? (input.repo.slice(input.repo.indexOf("/") + 1) ?? input.repo) : input.repo;
  const entryId = `${repoName.toLowerCase()}-chat-template`;

  const entry: Preset = {
    id: entryId,
    match: input.match,
    reasoning: true,
  };
  if (input.contextWindow) entry.contextWindow = input.contextWindow.value;
  entry.thinkingLevelMap = { ...map };
  entry.compat = {
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
    thinkingFormat: "chat-template",
    chatTemplateKwargs: kwargs,
  };
  entry.notes = `DRAFT (${input.fetchedAt}) — ${family} template, ${input.spelling} copy of ${input.repo}/${input.templateFile} (sha256 ${sha.slice(0, 12)}…): ${describeInvariants(inv)}. Thinking surface: ${knobs.join(", ") || "none"}. Judgment items (pi-level alignment, degenerate forms, maxTokens, README vocabulary) confirmed by a human before this entry may be committed — the tool drafted, the human ships.`;

  deriv["id"] = `proposed from the repo name — HUMAN confirms (identity-and-placement); reported as preset:<id> in the source map`;
  deriv["match"] = `from --match '${input.match}' — HUMAN confirms (unanchored case-insensitive regex on the model id); check collisions against the existing catalog patterns`;
  deriv["reasoning"] = `template reads ${knobs.join(", ")} — a reasoning surface exists${knobLine("enable_thinking") || knobLine("reasoning_effort") ? ` (e.g. ${knobLine("enable_thinking") ?? knobLine("reasoning_effort")})` : ""}`;
  deriv["input"] =
    "ABSENT (deliberate) — modalities are never derived from the template alone (qwen3.5 precedent: structural image guards are inherited family structure, not modality evidence). " +
    (imageLine
      ? `This template DOES carry image-content branching (${imageLine}) — HUMAN adds input: ['text','image'] only if the artifact/deployment states the model is multimodal (the 3.8/3.6 entries did, from deployment evidence). `
      : "This template has no image-content branch. ") +
    "Resolver default is ['text'] when omitted";
  deriv["contextWindow"] = input.contextWindow
    ? `${input.contextWindow.source}`
    : "ABSENT — not fetched (offline mode or the config block lacked max_position_embeddings); human supplies it from the deployment (GGUF *.context_length key or server n_ctx)";
  deriv["maxTokens"] =
    "ABSENT (deliberate) — NOT derivable from the template (spike feasibility item 4): the catalog's caps are deployment-derived (sglang 400s with no clamp when input+max_tokens > ctx). See the maxtokens-policy judgment item";
  deriv["thinkingLevelMap"] = `${mapFacts.join("; ")}`;
  deriv["compat.thinkingFormat"] = `the '${family}' dialect is chat-template kwargs only (drift-invariants family dispatch — the same dialect llama-server --jinja / sglang / vLLM forward)`;
  deriv["compat.supportsDeveloperRole"] = "catalog convention (all four existing entries: false)";
  deriv["compat.supportsReasoningEffort"] = "catalog convention (effort is driven through chatTemplateKwargs, not the native pi-ai path)";
  deriv["notes"] = "drafted summary — the human polishes the rationale (line numbers, deployment context) before commit";

  const { findings, warnings: selfWarnings } = checkPresetInvariants(inv, entry);
  if (findings.length > 0) {
    throw new DraftError(
      `draft self-check FAILED against its own template (a draft may never assert what the template rejects): ${findings.join(" | ")}`,
    );
  }
  warnings.push(...selfWarnings);

  const contract: DraftProvenanceContract =
    input.kind === "gguf"
      ? {
          kind: "gguf",
          repo: input.repo,
          file: input.templateFile,
          sha256: sha,
          note: `DRAFT pin — GGUF-embedded tokenizer.chat_template of ${input.repo}/${input.templateFile}${input.gguf?.baseModelRepo ? `; GGUF header base_model repo: ${input.gguf.baseModelRepo}` : ""}. Human: confirm this is the deployment copy (see the GGUF flag), then commit — the drift checker (npm run drift-check) verifies it on every run`,
        }
      : {
          kind: "hub",
          repo: input.repo,
          commit: input.headCommit ?? "PENDING-PIN",
          file: input.templateFile,
          sha256: sha,
          note: `DRAFT pin — spelling ${input.spelling}${input.headCommit ? `; commit = repo head at fetch time (the manifest pins BY COMMIT, never branch head — re-verify the template still matches this commit before pinning)` : "; OFFLINE: record the real repo file + commit that carries this exact template text before pinning"}. Human: confirm, then commit`,
        };
  const provenance = { presetId: entry.id, family, contracts: [contract] };

  const et = inv.enableThinking;
  const etTable = et.present
    ? `enable_thinking truth table: true→${et.whenTrue}, false→${et.whenFalse}, undefined→${et.whenUndefined}`
    : "no enable_thinking gate in the template";
  const judgments: JudgmentItem[] = [
    {
      id: "pi-level-alignment",
      question:
        "Confirm the pi-level → template-value mapping — in particular what 'off' MEANS on this template. The template has no 'off' level; the off→value entry is a cross-vocabulary CHOICE, not a parse (spike feasibility item 1).",
      mechanicalFacts: mapFacts,
      excerpt: mapExcerpt ?? undefined,
      proposed: JSON.stringify(map),
    },
    {
      id: "degenerate-forms",
      question:
        inv.family === "gpt-oss"
          ? "Confirm the degenerate 'off': the template ALWAYS emits the analysis channel (the 'Reasoning: <effort>' line is unconditional) — off is closest-to-minimal, NOT a think-off. Does the deployment's UX accept that?"
          : "Confirm the off state: the mapped off value is the closest selectable level (or inert, for a no-effort template) — is that the intended off semantics for this model?",
      mechanicalFacts:
        inv.family === "gpt-oss"
          ? [
              `the 'Reasoning: <effort>' render line — ${firstLine(text, (l) => l.includes('"Reasoning: "')) ?? "line not located"} (unconditional — 'off' is not a think-off)`,
              `off omits the kwarg → the template's own default '${inv.effort.default}' applies`,
            ]
          : [
              etTable,
              inv.effort.present
                ? "off omits the effort kwarg (omitWhenOff) — the template default applies in the off state; the raise-guard is never reached by the off value"
                : "no effort kwarg exists — the off mapping's value is inert (only the on/off distinction is dispatched)",
            ],
      excerpt:
        inv.family === "gpt-oss"
          ? (firstLine(text, (l) => l.includes('"Reasoning: "')) ?? undefined)
          : (firstLine(text, (l) => l.includes("enable_thinking") && l.includes("if")) ?? undefined),
      proposed: `off: ${JSON.stringify(map["off"] ?? null)} (see pi-level-alignment)`,
    },
    {
      id: "maxtokens-policy",
      question:
        "Set the output cap. The template cannot supply maxTokens (spike feasibility item 4) — it is DEPLOYMENT-derived: sglang 400s with no clamp when input+max_tokens > ctx, hence the catalog's ctx/2-headroom convention (65536 for 262144 ctx).",
      mechanicalFacts: [
        input.contextWindow ? `contextWindow: ${input.contextWindow.value} — ${input.contextWindow.source}` : "contextWindow: not fetched (offline) — the cap decision needs it",
        "catalog convention: 65536 for 262144-ctx deployments; a per-deployment override can raise it later (the resolver merges per field)",
      ],
      proposed: "ABSENT from the draft — human decides per deployment (omit = no capacity asserted, the qwen3.5 conservative choice)",
    },
    {
      id: "readme-vocabulary",
      question:
        inv.family === "gpt-oss"
          ? "The effort vocabulary ({low, medium, high}) is repo README PROSE, not template — the template validates nothing, so any string renders. Confirm the vocabulary against the README and add the levels to thinkingLevelMap. Worst case for an unlisted value: a model-behavior risk, never a 400."
          : "N/A — this family's vocabulary IS the raise-guard tuple (mechanically pinned and re-checked by the drift checker on every run); no README prose is involved.",
      mechanicalFacts:
        inv.family === "gpt-oss"
          ? [
              "template performs NO validation of reasoning_effort (no raise/in on the value — the only raise_exceptions are message-format guards)",
              firstLine(text, (l) => l.includes("reasoning_effort") && l.includes("defaults to")) ?? "docstring line not located",
            ]
          : [
              firstLine(text, (l) => l.includes("not in (") && l.includes("reasoning_effort")) ?? "raise-guard line not located",
              "The drift checker (npm run drift-check) re-asserts this tuple against the pinned copies on every run",
            ],
      excerpt:
        inv.family === "gpt-oss"
          ? (firstLine(text, (l) => l.includes("reasoning_effort") && l.includes("defaults to")) ?? undefined)
          : (firstLine(text, (l) => l.includes("not in (") && l.includes("reasoning_effort")) ?? undefined),
      proposed:
        inv.family === "gpt-oss"
          ? `draft proposes off only (${JSON.stringify(map)}); human adds the README-documented levels`
          : "nothing to confirm beyond the guard tuple (already mechanically pinned)",
    },
    {
      id: "identity-and-placement",
      question:
        "Confirm the entry id, the match pattern, and the catalog POSITION. Order is the contract: most-specific-first, first-match-wins, unanchored case-insensitive regex. Check collisions against the existing patterns (qwen3[._-]?8, qwen3[._-]?6, qwen3[._-]?5, gpt-oss).",
      mechanicalFacts: [
        `the pattern ${JSON.stringify(input.match)} matches, e.g.: ${["example-" + input.match].join(", ")}`,
        "a draft entry does not take effect until a human appends it to src/presets/catalog.ts at the reviewed position",
      ],
      proposed: `id: ${entryId}, match: ${JSON.stringify(input.match)}`,
    },
    ...(input.gguf
      ? [
          {
            id: "gguf-deployment-copy" as const,
            question:
              "Confirm the deployment actually serves this GGUF repo+file — it is the in-force template for llama-server --jinja, and re-quantizations re-upload the file. If a different file/repo is served, re-run against it.",
            mechanicalFacts: [
              `derived from ${input.repo} / ${input.gguf.chosen}`,
              ...(input.gguf.baseModelRepo ? [`GGUF header base_model repo: ${input.gguf.baseModelRepo}`] : []),
            ],
            proposed: `pin ${input.repo}/${input.gguf.chosen} (confirm first)`,
          },
        ]
      : []),
  ];

  return {
    repo: input.repo,
    match: input.match,
    kind: input.kind,
    spelling: input.spelling,
    templateFile: input.templateFile,
    sha256: sha,
    family,
    invariants: inv,
    entry,
    derivations: deriv,
    provenance,
    judgments,
    flags: input.gguf
      ? ggufFlagLines(input.repo, input.gguf, input.gguf.files, input.gguf.baseModelRepo, input.offline)
      : [],
    warnings,
    fetchedAt: input.fetchedAt,
  };
}

export function renderDraft(a: DraftArtifact): string {
  const out: string[] = [];
  out.push(`# PRESET DRAFT — ${a.repo} (match: ${a.match})`);
  out.push("");
  out.push(`Generated ${a.fetchedAt} by \`scripts/preset-draft.ts\` from the ${a.spelling} template copy \`${a.templateFile}\`.`);
  out.push(`Template sha256: \`${a.sha256}\``);
  if (a.invariants) out.push(`Mechanical invariants (drift-invariants pipeline): ${describeInvariants(a.invariants)}`);
  out.push("");
  out.push(
    "> **DRAFT ONLY — the tool never ships a preset.** A human reviews every judgment item below, confirms or corrects the values, then copies the entry into `src/presets/catalog.ts` and the provenance entry into `src/presets/provenance.json` and commits. The drift checker (`npm run drift-check`) then protects the entry.",
  );
  out.push("");

  out.push("## Flags (confirm before anything else)");
  out.push("");
  if (a.flags.length > 0) {
    out.push(...a.flags);
  } else {
    out.push("(none)");
  }
  out.push("");

  if (a.entry === null) {
    out.push("## 1. VERDICT: do NOT author a catalog entry");
    out.push("");
    out.push("The template has no template-driven thinking surface (no `enable_thinking`, no `reasoning_effort`). Per the Qwen3-Coder-Next precedent (docs/preset-authoring.md, 'When the verdict is no preset'), any entry would claim a per-template contract that does not exist, and every kwarg it sent would be a silent no-op. The default tier is the correct resolution.");
    out.push("");
    out.push("**HUMAN JUDGMENT REQUIRED** — confirm the model truly has no thinking surface (absence of tokens ≠ no reasoning; check the model config / README). If a surface exists that the template cannot drive, it is a different dialect case — author by hand.");
    out.push("");
    out.push("### Derivation notes");
    out.push("");
    for (const [field, src] of Object.entries(a.derivations)) out.push(`- **${field}** ← ${src}`);
    out.push("");
  } else {
    out.push("## 1. DRAFT catalog entry (exact `src/presets/catalog.ts` shape)");
    out.push("");
    out.push("Every field carries its derivation source below; the JUDGMENT fields are pre-filled with the mechanical proposal and marked in the checklist.");
    out.push("");
    out.push("```json");
    out.push(JSON.stringify(a.entry, null, 2));
    out.push("```");
    out.push("");
    out.push("### Derivation sources (the tier-reporting invariant, applied to authoring)");
    out.push("");
    for (const [field, src] of Object.entries(a.derivations)) out.push(`- **${field}** ← ${src}`);
    out.push("");

    out.push("## 2. Provenance manifest entry (append to `src/presets/provenance.json`)");
    out.push("");
    out.push("```json");
    out.push(JSON.stringify(a.provenance, null, 2));
    out.push("```");
    out.push("");
  }

  out.push(`## ${a.entry === null ? "2" : "3"}. JUDGMENT checklist (HUMAN confirms each — the tool never guesses these)`);
  out.push("");
  a.judgments.forEach((j, i) => {
    out.push(`### [ ] ${i + 1}. ${j.id} — **HUMAN JUDGMENT REQUIRED**`);
    out.push("");
    out.push(j.question);
    out.push("");
    out.push("Mechanical facts (derived, with template line refs):");
    for (const f of j.mechanicalFacts) out.push(`- ${f}`);
    if (j.excerpt) {
      out.push("");
      out.push("Template excerpt:");
      out.push("```");
      out.push(j.excerpt);
      out.push("```");
    }
    out.push("");
    out.push(`Proposed (pre-filled, confirm or correct): \`${j.proposed}\``);
    out.push("");
  });

  if (a.warnings.length > 0) {
    out.push("## Warnings");
    out.push("");
    for (const w of a.warnings) out.push(`- ${w}`);
    out.push("");
  }

  out.push("## Next steps (human)");
  out.push("");
  if (a.entry === null) {
    out.push("1. Confirm the no-preset verdict (judgment item 1 / degenerate-forms).");
    out.push("2. If confirmed: nothing to commit — the default tier covers this model. Record the decision in the commit message if it should stay visible.");
  } else {
    out.push("1. Confirm (or correct) each checklist item above.");
    out.push("2. Copy the entry into `src/presets/catalog.ts` at the reviewed position (order is the contract) and the provenance entry into `src/presets/provenance.json` (fill `PENDING-PIN` commits if any).");
    out.push("3. Run `npm run drift-check` — the drift checker now protects the entry.");
  }
  out.push("");
  return out.join("\n");
}
