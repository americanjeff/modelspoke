import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  buildDraft,
  CORE_JUDGMENT_IDS,
  defaultDraftFileName,
  detectFamily,
  detectSpellings,
  DraftError,
  ggufFiles,
  ggufFlagLines,
  chooseGgufFile,
  hubMetadataFromApi,
  isGgufRepo,
  normalizeRepo,
  otherSpellings,
  pickSpelling,
  renderDraft,
  sha256Hex,
  type DraftInput,
  type HubMetadata,
} from "../scripts/preset-draft-core.js";
import { runDraft, type FetchLike, type RunEnv } from "../scripts/preset-draft.js";
import { checkPresetInvariants } from "../scripts/drift-invariants.js";
import { presetCatalog } from "../src/index.js";
import type { Preset } from "../src/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "fixtures");
const fix = (name: string): string => readFileSync(path.join(FIXTURES, name), "utf8");

const t38Hub = fix("chat-template-qwen3.8-hub.jinja");
const t36Hub = fix("chat-template-qwen3.6-hub.jinja");
const t35Gguf = fix("chat-template-qwen3.5-gguf.jinja");
const tOss = fix("chat-template-gpt-oss.jinja");
const tNoXhigh = fix("chat-template-qwen-guard-no-xhigh.jinja");

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const NOW = "2026-08-25T00:00:00.000Z";

function baseInput(over: Partial<DraftInput>): DraftInput {
  return {
    repo: "Qwen/Qwen3.8-27B",
    match: "qwen3[._-]?8",
    kind: "hub",
    spelling: "chat_template.jinja",
    templateFile: "chat_template.jinja",
    templateText: t38Hub,
    headCommit: null,
    contextWindow: null,
    gguf: null,
    otherSpellings: [],
    familyOverride: null,
    fetchedAt: NOW,
    offline: false,
    ...over,
  };
}

const CATALOG = Object.fromEntries(presetCatalog.map((p) => [p.id, p])) as Record<string, Preset>;

/** The mechanically-derivable core of a catalog entry (the judgment fields — id, match, maxTokens, notes, input — excluded by design). */
function mechanicalCore(p: Preset): Record<string, unknown> {
  return {
    reasoning: p.reasoning,
    contextWindow: p.contextWindow,
    thinkingLevelMap: p.thinkingLevelMap,
    compat: p.compat,
  };
}

describe("normalizeRepo", () => {
  it("accepts org/name and HF URL forms, strips extra path segments", () => {
    expect(normalizeRepo("Qwen/Qwen3.8-27B")).toBe("Qwen/Qwen3.8-27B");
    expect(normalizeRepo("https://huggingface.co/Qwen/Qwen3.8-27B")).toBe("Qwen/Qwen3.8-27B");
    expect(normalizeRepo("https://huggingface.co/Qwen/Qwen3.8-27B/")).toBe("Qwen/Qwen3.8-27B");
    expect(normalizeRepo("https://huggingface.co/unsloth/Qwen3.8-27B-GGUF/resolve/main/x.gguf")).toBe(
      "unsloth/Qwen3.8-27B-GGUF",
    );
  });

  it("rejects non-HF hosts and non-org/name input", () => {
    expect(() => normalizeRepo("https://github.com/foo/bar")).toThrow(DraftError);
    expect(() => normalizeRepo("just-a-name")).toThrow(DraftError);
    expect(() => normalizeRepo("https://huggingface.co/bad segment/name")).toThrow(DraftError);
  });
});

describe("spelling probe (the three spellings + none found)", () => {
  const meta = (over: Partial<HubMetadata>): HubMetadata => ({
    sha: "a".repeat(40),
    siblings: [],
    config: {},
    embeddedTemplate: null,
    ...over,
  });

  it("spelling 1: chat_template.jinja file wins when present", () => {
    const s = detectSpellings(meta({ siblings: ["chat_template.jinja", "README.md"] }));
    expect(s).toEqual({ jinja: true, json: false, apiEmbedded: false });
    expect(pickSpelling(s)).toBe("chat_template.jinja");
    expect(otherSpellings(s, "chat_template.jinja")).toEqual([]);
  });

  it("spelling 2: chat_template.json (the gemma spelling) is probed next", () => {
    const s = detectSpellings(meta({ siblings: ["chat_template.json"] }));
    expect(pickSpelling(s)).toBe("chat_template.json");
  });

  it("spelling 3: API-embedded tokenizer_config.chat_template is the fallback", () => {
    const s = detectSpellings(meta({ embeddedTemplate: "{{ embedded }}" }));
    expect(pickSpelling(s)).toBe("api-embedded");
  });

  it("probe order: jinja > json > api-embedded; the others are reported", () => {
    const s = detectSpellings(meta({ siblings: ["chat_template.json", "chat_template.jinja"], embeddedTemplate: "x" }));
    expect(pickSpelling(s)).toBe("chat_template.jinja");
    expect(otherSpellings(s, "chat_template.jinja")).toEqual(["chat_template.json", "api-embedded"]);
  });

  it("none found: pickSpelling is null (the CLI reports all three spellings probed)", () => {
    expect(pickSpelling(detectSpellings(meta({})))).toBeNull();
  });

  it("hubMetadataFromApi extracts sha/siblings/embedded template (both nesting shapes)", () => {
    const m1 = hubMetadataFromApi({
      sha: "b".repeat(40),
      siblings: [{ rfilename: "chat_template.jinja" }, { rfilename: "config.json" }],
      config: { tokenizer_config: { chat_template: "E" }, max_position_embeddings: 262144 },
    });
    expect(m1.sha).toBe("b".repeat(40));
    expect(m1.siblings).toEqual(["chat_template.jinja", "config.json"]);
    expect(m1.embeddedTemplate).toBe("E");
    const m2 = hubMetadataFromApi({ config: { chat_template: "F" } });
    expect(m2.embeddedTemplate).toBe("F");
    expect(m2.siblings).toEqual([]);
  });
});

describe("GGUF ambiguity flagging", () => {
  it("isGgufRepo / ggufFiles detect quantization repos and their files", () => {
    expect(isGgufRepo("unsloth/Qwen3.8-27B-GGUF")).toBe(true);
    expect(isGgufRepo("Qwen/Qwen3.8-27B")).toBe(false);
    expect(ggufFiles(["a.gguf", "b.txt", "C-GGUF.gguf", "sub/d.gguf"])).toEqual(["C-GGUF.gguf", "a.gguf", "sub/d.gguf"]);
  });

  it("a single file is chosen without ambiguity; several are flagged", () => {
    expect(chooseGgufFile(["only.gguf"])).toEqual({ chosen: "only.gguf", ambiguous: false });
    expect(chooseGgufFile(["b.gguf", "a.gguf"])).toEqual({ chosen: "a.gguf", ambiguous: true });
    expect(chooseGgufFile(["b.gguf", "a.gguf"], "b.gguf")).toEqual({ chosen: "b.gguf", ambiguous: true });
    expect(() => chooseGgufFile(["a.gguf"], "nope.gguf")).toThrow(DraftError);
  });

  it("the flag names EVERY ambiguous copy and demands human confirmation — no silent pick", () => {
    const files = ["A-UD-Q8_K_XL.gguf", "A-UD-Q4_K_XL.gguf", "A-FP8.gguf"];
    const lines = ggufFlagLines(
      "QuantOrg/A-GGUF",
      { chosen: "A-UD-Q8_K_XL.gguf", ambiguous: true },
      files,
      "https://huggingface.co/Qwen/Qwen3.8-27B",
      false,
    );
    const joined = lines.join("\n");
    expect(joined).toMatch(/HUMAN CONFIRMATION REQUIRED/);
    expect(joined).toMatch(/does NOT search/);
    for (const f of files) expect(joined).toContain(f);
    expect(joined).toContain("base_model repo = https://huggingface.co/Qwen/Qwen3.8-27B");
    expect(joined).toMatch(/--file <name>/);
  });
});

describe("detectFamily / defaultDraftFileName", () => {
  it("routes on the family-defining knob", () => {
    expect(detectFamily(t38Hub)).toBe("qwen");
    expect(detectFamily(tOss)).toBe("gpt-oss");
    expect(detectFamily("{%- if add_generation_prompt %}\n{{- 'Assistant\\n' }}\n{%- endif %}\n")).toBe("none");
  });

  it("the draft file name sanitizes the --match pattern", () => {
    expect(defaultDraftFileName("qwen3[._-]?8")).toBe("preset-draft.qwen3-._-8.md");
    expect(defaultDraftFileName("gpt-oss")).toBe("preset-draft.gpt-oss.md");
    expect(defaultDraftFileName("[+")).toContain("preset-draft");
  });
});

describe("draft emission — qwen3.8 (validated against the real catalog entry)", () => {
  const art = buildDraft(
    baseInput({
      headCommit: "1d4bf0f2ff6012fd82039f2fa52739d0dd7c60c0",
      contextWindow: { value: 262144, source: "test config.max_position_embeddings" },
    }),
  );
  const entry = art.entry!;
  const real = CATALOG["qwen3.8-chat-template"];

  it("derives the SAME mechanical core the human shipped (reasoning/contextWindow/thinkingLevelMap/compat)", () => {
    expect(mechanicalCore(entry)).toEqual(mechanicalCore(real));
    expect(entry.thinkingLevelMap).toEqual({ off: "low", low: "low", medium: "medium", xhigh: "xhigh" });
    expect(entry.compat?.chatTemplateKwargs).toEqual({
      enable_thinking: { "$var": "thinking.enabled" },
      reasoning_effort: { "$var": "thinking.effort", omitWhenOff: true },
      preserve_thinking: true,
    });
  });

  it("is a structurally valid Preset: every key a real Preset field, catalog key order for the shared prefix", () => {
    const allowed = new Set(["id", "match", "notes", "input", "reasoning", "contextWindow", "maxTokens", "thinkingLevelMap", "compat"]);
    for (const k of Object.keys(entry)) expect(allowed.has(k), `unexpected key ${k}`).toBe(true);
    expect(entry.id).toBe("qwen3.8-27b-chat-template"); // proposed from the repo name — human confirms
    expect(entry.match).toBe("qwen3[._-]?8");
    expect(entry.maxTokens).toBeUndefined(); // judgment field: deliberately absent
    expect(Object.keys(entry)).toEqual(["id", "match", "reasoning", "contextWindow", "thinkingLevelMap", "compat", "notes"]);
  });

  it("every derived field carries its derivation source", () => {
    const d = art.derivations;
    for (const field of [
      "id",
      "match",
      "reasoning",
      "input",
      "contextWindow",
      "maxTokens",
      "thinkingLevelMap",
      "compat.thinkingFormat",
      "compat.chatTemplateKwargs.enable_thinking",
      "compat.chatTemplateKwargs.reasoning_effort",
      "compat.chatTemplateKwargs.preserve_thinking",
    ]) {
      expect(typeof d[field], `derivation for ${field} is a string`).toBe("string");
      expect((d[field] ?? "").length, `derivation for ${field} is substantive`).toBeGreaterThan(5);
    }
    expect(d["thinkingLevelMap"]).toMatch(/raise-guard tuple: \(xhigh, medium, low\)/);
    expect(d["maxTokens"]).toMatch(/NOT derivable from the template/);
  });

  it("the provenance entry matches the manifest shape AND the real pin for this exact template text", () => {
    const prov = art.provenance!;
    expect(Object.keys(prov).sort()).toEqual(["contracts", "family", "presetId"]);
    expect(prov.family).toBe("qwen");
    const c = prov.contracts[0]!;
    expect(Object.keys(c).sort()).toEqual(["commit", "file", "kind", "note", "repo", "sha256"]);
    expect(c.kind).toBe("hub");
    expect(c.commit).toBe("1d4bf0f2ff6012fd82039f2fa52739d0dd7c60c0");
    // The fixture IS the pinned hub template: its sha must equal the manifest pin.
    const manifest = JSON.parse(readFileSync(path.join(HERE, "..", "src", "presets", "provenance.json"), "utf8")) as {
      entries: { presetId: string; contracts: { kind: string; repo: string; sha256: string }[] }[];
    };
    const pin = manifest.entries.find((e) => e.presetId === "qwen3.8-chat-template")!.contracts.find(
      (x) => x.kind === "hub" && x.repo === "Qwen/Qwen3.8-27B",
    )!;
    expect(sha256(t38Hub)).toBe(pin.sha256);
    expect(c.sha256).toBe(pin.sha256);
  });

  it("the judgment checklist is complete: all four items, each with facts + a HUMAN JUDGMENT marker", () => {
    expect(art.judgments.map((j) => j.id)).toEqual(expect.arrayContaining([...CORE_JUDGMENT_IDS]));
    for (const j of art.judgments) {
      expect(j.question.length).toBeGreaterThan(10);
      expect(j.mechanicalFacts.length).toBeGreaterThan(0);
      expect(j.proposed.length).toBeGreaterThan(0);
    }
    const rendered = renderDraft(art);
    const markers = rendered.match(/HUMAN JUDGMENT REQUIRED/g) ?? [];
    expect(markers.length).toBeGreaterThanOrEqual(CORE_JUDGMENT_IDS.length);
    expect(rendered).toContain("DRAFT catalog entry");
    expect(rendered).toContain(art.sha256);
  });

  it("the rendered draft embeds the entry + provenance as parseable JSON (the human copies from it)", () => {
    const blocks = (renderDraft(art).match(/```json\n([\s\S]*?)\n```/g) ?? []).map((b) => b.replace(/```json\n|\n```/g, ""));
    expect(blocks.length).toBe(2);
    expect(JSON.parse(blocks[0]!)).toEqual(entry);
    expect(JSON.parse(blocks[1]!)).toEqual(art.provenance);
  });
});

describe("draft emission — the other families, validated against the real catalog entries", () => {
  it("qwen3.6 (no effort, preserve REQUIRED): the same mechanical core as shipped", () => {
    const art = buildDraft(
      baseInput({ repo: "Qwen/Qwen3.6-27B-FP8", match: "qwen3[._-]?6", templateText: t36Hub, contextWindow: { value: 262144, source: "test" } }),
    );
    expect(mechanicalCore(art.entry!)).toEqual(mechanicalCore(CATALOG["qwen3.6-chat-template"]));
    expect(art.entry!.compat?.chatTemplateKwargs).toEqual({
      enable_thinking: { "$var": "thinking.enabled" },
      preserve_thinking: true,
    });
    // preserve_thinking is behaviorally REQUIRED on 3.6 (undefined strips) — the derivation must say so
    expect(art.derivations["compat.chatTemplateKwargs.preserve_thinking"]).toMatch(/REQUIRED/);
  });

  it("qwen3.5 GGUF (inverted polarity, no preserve, no input in the catalog): matches the shipped core", () => {
    const art = buildDraft(
      baseInput({
        repo: "unsloth/Qwen3.5-4B-GGUF",
        match: "qwen3[._-]?5",
        kind: "local",
        spelling: "local-file",
        offline: true,
        templateText: t35Gguf,
        contextWindow: { value: 262144, source: "test" },
      }),
    );
    expect(mechanicalCore(art.entry!)).toEqual(mechanicalCore(CATALOG["qwen3.5-chat-template"]));
    expect(art.entry!.input).toBeUndefined(); // never derived from the template alone
    // the inverted polarity is REPORTED, not hidden
    expect(art.derivations["compat.chatTemplateKwargs.enable_thinking"]).toMatch(/undefined→nothink/);
  });

  it("gpt-oss (README-only vocabulary): proposes off=template-default only, exact compat kwargs", () => {
    const art = buildDraft(baseInput({ repo: "openai/gpt-oss-120b", match: "gpt-oss", templateText: tOss }));
    const e = art.entry!;
    expect(e.thinkingLevelMap).toEqual({ off: "medium" });
    expect(e.compat).toEqual(CATALOG["gpt-oss-120b-chat-template"].compat);
    expect(e.input).toBeUndefined();
    const readme = art.judgments.find((j) => j.id === "readme-vocabulary")!;
    expect(readme.question).toMatch(/README/);
    expect(readme.mechanicalFacts.join(" ")).toMatch(/NO validation/i);
  });
});

describe("no-surface verdict (Qwen3-Coder-Next precedent)", () => {
  it("a template with no knobs yields entry: null + an explicit no-preset verdict, not a guess", () => {
    const art = buildDraft(baseInput({ templateText: "{%- if add_generation_prompt %}\n{{- 'Assistant\\n' }}\n{%- endif %}\n" }));
    expect(art.family).toBe("none");
    expect(art.entry).toBeNull();
    expect(art.provenance).toBeNull();
    expect(art.derivations["verdict"]).toMatch(/default tier/);
    expect(art.judgments.map((j) => j.id)).toEqual(expect.arrayContaining([...CORE_JUDGMENT_IDS]));
    const rendered = renderDraft(art);
    expect(rendered).toMatch(/do NOT author a catalog entry/i);
    expect(rendered).toMatch(/HUMAN JUDGMENT REQUIRED/);
  });
});

describe("property: the draft never proposes a level the template's raise-guard rejects", () => {
  it("fixture whose guard EXCLUDES xhigh: no xhigh key, no xhigh value, off = closest selectable", () => {
    const art = buildDraft(baseInput({ templateText: tNoXhigh, contextWindow: { value: 32768, source: "test" } }));
    const map = art.entry!.thinkingLevelMap!;
    expect(Object.keys(map)).not.toContain("xhigh");
    for (const v of Object.values(map)) expect(v).not.toBe("xhigh");
    expect(map).toEqual({ off: "low", high: "high", medium: "medium", low: "low" });
    expect(art.derivations["thinkingLevelMap"]).toMatch(/\(high, medium, low\)/);
  });

  it("holds across every committed fixture: every proposed map value is in the template's accepted set (aliases resolved)", () => {
    for (const [name, text] of [
      ["qwen3.8-hub", t38Hub],
      ["qwen3.6-hub", t36Hub],
      ["no-xhigh", tNoXhigh],
    ] as const) {
      const art = buildDraft(baseInput({ templateText: text }));
      const map = art.entry!.thinkingLevelMap!;
      const accepted = art.invariants!.effort.accepted;
      const aliases = art.invariants!.effort.aliases;
      if (accepted !== null) {
        for (const [level, value] of Object.entries(map)) {
          const resolved = aliases[value] ?? value;
          expect(accepted.includes(resolved), `${name}: level '${level}' -> '${value}' must be in the guard tuple ${accepted}`).toBe(true);
        }
      }
    }
  });

  it("a self-check failure is a loud DRAFT-FAIL, never a shipped invalid draft", () => {
    // Corrupt the draft after construction: the very act the property forbids
    // is exactly what checkPresetInvariants (reused from the preset drift checker) flags.
    const art = buildDraft(baseInput({ templateText: tNoXhigh }));
    const bad: Preset = { ...art.entry!, thinkingLevelMap: { ...art.entry!.thinkingLevelMap!, xhigh: "xhigh" } };
    expect(checkPresetInvariants(art.invariants!, bad).findings).toHaveLength(1);
  });
});

function fakeFetch(routes: Record<string, () => Response>): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const f: FetchLike = async (url: string) => {
    calls.push(url);
    const r = routes[url];
    if (!r) throw new Error(`fake fetch: unexpected URL ${url}`);
    return r();
  };
  return { fetch: f, calls };
}

function jsonRoute(body: unknown): () => Response {
  return () => new Response(JSON.stringify(body), { status: 200 });
}

function textRoute(body: string): () => Response {
  return () => new Response(body, { status: 200 });
}

function presetsSnapshot(): Map<string, { mtime: number; content: string }> {
  const dir = path.join(HERE, "..", "src", "presets");
  const out = new Map<string, { mtime: number; content: string }>();
  for (const name of readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    const st = statSync(p);
    if (!st.isFile()) continue;
    out.set(name, { mtime: st.mtimeMs, content: readFileSync(p, "utf8") });
  }
  return out;
}

function quietEnv(over: Partial<RunEnv> = {}): RunEnv {
  return { stdout: () => {}, stderr: () => {}, now: () => NOW, ...over };
}

describe("runDraft — hub repo end-to-end (fake fetch, real file write)", () => {
  const REPO = "Qwen/Qwen3.8-27B";
  const HEAD = "1d4bf0f2ff6012fd82039f2fa52739d0dd7c60c0";

  it("probes the spelling, writes the draft to the output path, and touches NOTHING under src/presets", async () => {
    const { fetch, calls } = fakeFetch({
      [`https://huggingface.co/api/models/${REPO}`]: jsonRoute({
        sha: HEAD,
        siblings: [{ rfilename: "chat_template.jinja" }, { rfilename: "config.json" }],
        config: { max_position_embeddings: 262144, tokenizer_config: { chat_template: t38Hub } },
      }),
      [`https://huggingface.co/${REPO}/resolve/main/chat_template.jinja`]: textRoute(t38Hub),
    });
    const tmp = mkdtempSync(path.join(os.tmpdir(), "preset-draft-"));
    const before = presetsSnapshot();
    const res = await runDraft([REPO, "--match", "qwen3[._-]?8"], quietEnv({ fetchImpl: fetch, cwd: tmp }));
    const after = presetsSnapshot();

    expect(res.code).toBe(0);
    expect(res.outPath).toBe(path.join(tmp, "preset-draft.qwen3-._-8.md"));
    const written = readFileSync(res.outPath!, "utf8");
    expect(written).toBe(res.content!);
    expect(written).toContain(`Template sha256: \`${sha256(t38Hub)}\``);
    expect(written).toContain("DRAFT catalog entry");
    // probe took the jinja file spelling (even though the API also embedded the template)
    expect(calls).toEqual([
      `https://huggingface.co/api/models/${REPO}`,
      `https://huggingface.co/${REPO}/resolve/main/chat_template.jinja`,
    ]);
    expect(written).toContain("repo config.max_position_embeddings = 262144");
    // the boundary: src/presets byte- and mtime-identical
    expect([...after.entries()]).toEqual([...before.entries()]);
  });

  it("fetch failure is its own class: exit 1, FETCH-FAIL, no draft file", async () => {
    const { fetch } = fakeFetch({});
    const stderr: string[] = [];
    const written: string[] = [];
    const tmp = mkdtempSync(path.join(os.tmpdir(), "preset-draft-"));
    const res = await runDraft(["Qwen/Qwen3.8-27B", "--match", "q8"], quietEnv({
      fetchImpl: fetch,
      cwd: tmp,
      stderr: (s) => stderr.push(s),
      writeImpl: (p) => written.push(p),
    }));
    expect(res.code).toBe(1);
    expect(res.outPath).toBeNull();
    expect(written).toEqual([]);
    expect(stderr.join("\n")).toMatch(/FETCH-FAIL \(not a draft\)/);
  });

  it("no template in any of the three spellings: exit 1 naming all three", async () => {
    const { fetch } = fakeFetch({
      [`https://huggingface.co/api/models/Example/Plain`]: jsonRoute({
        sha: "c".repeat(40),
        siblings: [{ rfilename: "config.json" }],
        config: {},
      }),
    });
    const stderr: string[] = [];
    const res = await runDraft(["Example/Plain", "--match", "plain"], quietEnv({
      fetchImpl: fetch,
      cwd: mkdtempSync(path.join(os.tmpdir(), "preset-draft-")),
      stderr: (s) => stderr.push(s),
    }));
    expect(res.code).toBe(1);
    const msg = stderr.join("\n");
    expect(msg).toMatch(/chat_template\.jinja file/);
    expect(msg).toMatch(/chat_template\.json file/);
    expect(msg).toMatch(/API-embedded/);
  });

  it("the api-embedded spelling works when no file spelling exists", async () => {
    const { fetch } = fakeFetch({
      [`https://huggingface.co/api/models/Example/Embedded`]: jsonRoute({
        sha: "d".repeat(40),
        siblings: [{ rfilename: "config.json" }],
        config: { max_position_embeddings: 32768, tokenizer_config: { chat_template: tNoXhigh } },
      }),
    });
    const tmp = mkdtempSync(path.join(os.tmpdir(), "preset-draft-"));
    const res = await runDraft(["Example/Embedded", "--match", "emb"], quietEnv({ fetchImpl: fetch, cwd: tmp }));
    expect(res.code).toBe(0);
    expect(res.content!).toContain("api-embedded");
    expect(res.content!).toContain("repo config.max_position_embeddings = 32768");
  });

  it("usage errors exit 2 with the usage text; an invalid --match regex is a usage error", async () => {
    const stderr1: string[] = [];
    const r1 = await runDraft(["Some/Repo"], quietEnv({ stderr: (s) => stderr1.push(s) }));
    expect(r1.code).toBe(2);
    expect(stderr1.join("\n")).toMatch(/missing --match/);

    const stderr2: string[] = [];
    const r2 = await runDraft(["Some/Repo", "--match", "qwen3["], quietEnv({ stderr: (s) => stderr2.push(s) }));
    expect(r2.code).toBe(2);
    expect(stderr2.join("\n")).toMatch(/not a valid regular expression/);
  });
});

// Synthetic GGUF writer; same v3 shape as test/gguf.test.ts.

const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const u64 = (n: number): Buffer => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const gstr = (s: string): Buffer => Buffer.concat([u64(Buffer.byteLength(s, "utf8")), Buffer.from(s, "utf8")]);
function buildGguf(kvs: [string, string | number | boolean][]): Buffer {
  const parts: Buffer[] = [Buffer.from("GGUF"), u32(3), u64(1), u64(kvs.length)];
  for (const [k, v] of kvs) {
    if (typeof v === "string") parts.push(gstr(k), u32(8), gstr(v));
    else if (typeof v === "boolean") parts.push(gstr(k), u32(7), Buffer.from([v ? 1 : 0]));
    else parts.push(gstr(k), u32(4), u32(v));
  }
  return Buffer.concat(parts);
}

describe("runDraft — GGUF repo (fake fetch of a synthetic GGUF)", () => {
  const REPO = "QuantOrg/FakeModel-GGUF";
  // The tool's default choice is the sort-first file — the routes must serve THAT one.
  const GGUF_SELECTED = "FakeModel-UD-Q4_K_XL.gguf";
  const GGUF_OTHER = "FakeModel-UD-Q8_K_XL.gguf";
  const buf = buildGguf([
    ["general.architecture", "qwen35"],
    ["general.base_model.0.repo_url", "https://huggingface.co/Qwen/Qwen3.8-27B"],
    ["qwen35.context_length", 262144],
    ["tokenizer.chat_template", t38Hub],
  ]);

  function ggufRoutes(file: string): Record<string, () => Response> {
    return {
      [`https://huggingface.co/api/models/${REPO}`]: jsonRoute({
        sha: "e".repeat(40),
        siblings: [{ rfilename: GGUF_SELECTED }, { rfilename: GGUF_OTHER }, { rfilename: "README.md" }],
        config: {},
      }),
      [`https://huggingface.co/${REPO}/resolve/main/${file}`]: () => new Response(new Uint8Array(buf), { status: 200 }),
    };
  }

  it("reads the GGUF-embedded template, derives contextWindow from the KV, and FLAGS the ambiguous copies", async () => {
    const { fetch } = fakeFetch(ggufRoutes(GGUF_SELECTED));
    const tmp = mkdtempSync(path.join(os.tmpdir(), "preset-draft-"));
    const res = await runDraft([REPO, "--match", "fakemodel"], quietEnv({ fetchImpl: fetch, cwd: tmp }));
    expect(res.code).toBe(0);
    const c = res.content!;
    expect(c).toMatch(/GGUF AMBIGUITY/);
    expect(c).toContain(GGUF_SELECTED);
    expect(c).toContain(GGUF_OTHER);
    expect(c).toMatch(/HUMAN CONFIRMATION REQUIRED/);
    expect(c).toContain("base_model repo = https://huggingface.co/Qwen/Qwen3.8-27B");
    expect(c).toContain("GGUF key qwen35.context_length = 262144");
    expect(c).toContain('"contextWindow": 262144');
    // the provenance contract is kind gguf with NO commit key (the manifest shape)
    const blocks = (c.match(/```json\n([\s\S]*?)\n```/g) ?? []).map((b) => b.replace(/```json\n|\n```/g, ""));
    const prov = JSON.parse(blocks[1]!) as { contracts: { kind: string; commit?: unknown }[] };
    expect(prov.contracts[0]!.kind).toBe("gguf");
    expect(prov.contracts[0]!.commit).toBeUndefined();
  });

  it("--file picks an explicit GGUF file (and names a bad one)", async () => {
    const { fetch } = fakeFetch(ggufRoutes(GGUF_OTHER));
    const tmp = mkdtempSync(path.join(os.tmpdir(), "preset-draft-"));
    const res = await runDraft([REPO, "--match", "fm", "--file", GGUF_OTHER], quietEnv({ fetchImpl: fetch, cwd: tmp }));
    expect(res.code).toBe(0);
    expect(res.content!).toContain(`/ ${GGUF_OTHER}`);

    const stderr: string[] = [];
    const { fetch: f2 } = fakeFetch(ggufRoutes(GGUF_OTHER));
    const r2 = await runDraft([REPO, "--match", "fm", "--file", "nope.gguf"], quietEnv({
      fetchImpl: f2,
      cwd: tmp,
      stderr: (s) => stderr.push(s),
    }));
    expect(r2.code).toBe(1);
    expect(stderr.join("\n")).toMatch(/not a \.gguf file in the repo/);
  });
});

describe("runDraft — GGUF repo via the LOCAL HF cache (truncated file: KV prefix only)", () => {
  const REPO = "QuantOrg/FakeModel-GGUF";
  const GGUF_SELECTED = "FakeModel-UD-Q4_K_XL.gguf";
  const GGUF_OTHER = "FakeModel-UD-Q8_K_XL.gguf";

  it("takes the local branch (capped prefix read) and derives the same fields as the hub-fetch path", async () => {
    // HF cache layout under a temp dir; localGgufPath resolves it via HUGGINGFACE_HUB_CACHE.
    const cache = mkdtempSync(path.join(os.tmpdir(), "preset-draft-hfcache-"));
    const snap = path.join(cache, `models--QuantOrg--FakeModel-GGUF`, "snapshots", "test-rev");
    mkdirSync(snap, { recursive: true });
    // File content = the KV section only (a real file's tensor data follows it; the read must never need it).
    writeFileSync(
      path.join(snap, GGUF_SELECTED),
      buildGguf([
        ["general.architecture", "qwen35"],
        ["general.base_model.0.repo_url", "https://huggingface.co/Qwen/Qwen3.8-27B"],
        ["qwen35.context_length", 262144],
        ["tokenizer.chat_template", t38Hub],
      ]),
    );

    const savedCache = process.env.HUGGINGFACE_HUB_CACHE;
    process.env.HUGGINGFACE_HUB_CACHE = cache;
    try {
      // Only the API metadata URL is routed: a resolve fetch would throw in fakeFetch.
      const { fetch, calls } = fakeFetch({
        [`https://huggingface.co/api/models/${REPO}`]: jsonRoute({
          sha: "e".repeat(40),
          siblings: [{ rfilename: GGUF_SELECTED }, { rfilename: GGUF_OTHER }, { rfilename: "README.md" }],
          config: {},
        }),
      });
      const tmp = mkdtempSync(path.join(os.tmpdir(), "preset-draft-"));
      const res = await runDraft([REPO, "--match", "fakemodel"], quietEnv({ fetchImpl: fetch, cwd: tmp }));
      expect(res.code).toBe(0);
      expect(calls).toEqual([`https://huggingface.co/api/models/${REPO}`]);
      expect(res.messages.join("\n")).toMatch(/template source: local HF cache: /);
      const c = res.content!;
      expect(c).toContain(`Template sha256: \`${sha256(t38Hub)}\``);
      expect(c).toContain("GGUF key qwen35.context_length = 262144");
      expect(c).toContain('"contextWindow": 262144');
      expect(c).toContain("base_model repo = https://huggingface.co/Qwen/Qwen3.8-27B");
      const blocks = (c.match(/```json\n([\s\S]*?)\n```/g) ?? []).map((b) => b.replace(/```json\n|\n```/g, ""));
      const prov = JSON.parse(blocks[1]!) as { contracts: { kind: string }[] };
      expect(prov.contracts[0]!.kind).toBe("gguf");
    } finally {
      if (savedCache === undefined) delete process.env.HUGGINGFACE_HUB_CACHE;
      else process.env.HUGGINGFACE_HUB_CACHE = savedCache;
      rmSync(cache, { recursive: true, force: true });
    }
  });
});

describe("runDraft — offline mode (--template <local-file>)", () => {
  it("zero network calls; the provenance pin carries PENDING-PIN; --context-window is honored", async () => {
    const { fetch } = fakeFetch({});
    const tmp = mkdtempSync(path.join(os.tmpdir(), "preset-draft-"));
    const res = await runDraft(
      ["Qwen/Qwen3.8-27B", "--match", "qwen3[._-]?8", "--template", path.join(FIXTURES, "chat-template-qwen3.8-hub.jinja"), "--context-window", "262144"],
      quietEnv({ fetchImpl: fetch, cwd: tmp }),
    );
    expect(res.code).toBe(0);
    const c = res.content!;
    expect(c).toContain('"commit": "PENDING-PIN"');
    expect(c).toContain("--context-window 262144 (human-asserted, offline mode)");
    expect(c).toContain(sha256(t38Hub));
    expect(c).toContain('"contextWindow": 262144');
  });
});
