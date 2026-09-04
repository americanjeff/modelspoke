/**
 * The `preset-draft` authoring command (dev tool; NOT part of the plugin
 * bundle — it is outside src/ and no plugin entry imports it).
 *
 * design.md boundary: the tool DRAFTS; a human reviews and commits — it
 * NEVER writes under src/presets/ and never ships a preset. The draft is
 * self-checked against its own template, so it can never propose a
 * thinkingLevelMap value the template's raise-guard rejects; a GGUF repo's
 * ambiguous copies are flagged for human confirmation, never silently picked.
 *
 * Exit codes: 0 = draft written · 1 = fetch/derivation failure (no draft
 * written — a draft that cannot fetch is not a pass, like the drift checker) · 2 = usage.
 *
 * Zero new runtime dependencies (node:fetch, the same path the drift checker uses).
 *
 * `--template <file>` is OFFLINE mode: the template text is read from a
 * local file and no HF fetch happens (air-gapped authoring; the provenance
 * pin carries PENDING-PIN until a human records the real repo commit).
 *
 * Node >= 22.18 for flagless native TS stripping (or pass
 * --experimental-strip-types on Node 22.6-22.17).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildDraft,
  chooseGgufFile,
  contextWindowFromConfig,
  defaultDraftFileName,
  detectSpellings,
  DraftError,
  ggufFiles,
  hubMetadataFromApi,
  isGgufRepo,
  normalizeRepo,
  otherSpellings,
  pickSpelling,
  renderDraft,
  sha256Hex,
  type DraftInput,
  type TemplateSpelling,
} from "./preset-draft-core.ts";
import { GgufPrefixError, parseGgufKvPrefix, readPrefix } from "./gguf.ts";

/** A fetch problem: NOT a draftable result. A draft that cannot fetch is not a pass. */
export class FetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FetchError";
  }
}

const UA = "modelspoke-preset-draft/0.1";

/** The injectable seam: tests pass a fake; the default is node:fetch. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface RunEnv {
  fetchImpl?: FetchLike;
  writeImpl?: (filePath: string, content: string) => void;
  now?: () => string; // ISO timestamp (tests pin it)
  cwd?: string;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
}

export interface RunResult {
  code: number;
  outPath: string | null;
  content: string | null;
  messages: string[]; // stdout lines (report + the draft)
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function getJson(fetchImpl: FetchLike, url: string): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetchImpl(url, { headers: { "user-agent": UA } });
  } catch (e) {
    throw new FetchError(`${url}: network failure — ${errMsg(e)}`);
  }
  if (!res.ok) {
    throw new FetchError(
      `${url}: HTTP ${res.status} ${res.statusText}${res.status === 401 ? " (HF answers 401 — not 404 — for unknown AND gated repos; verify the repo id, or set HF_TOKEN for gated families)" : ""}`,
    );
  }
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch (e) {
    throw new FetchError(`${url}: response is not JSON — ${errMsg(e)}`);
  }
}

async function getText(fetchImpl: FetchLike, url: string): Promise<string> {
  let res: Response;
  try {
    res = await fetchImpl(url, { headers: { "user-agent": UA } });
  } catch (e) {
    throw new FetchError(`${url}: network failure — ${errMsg(e)}`);
  }
  if (!res.ok) {
    throw new FetchError(`${url}: HTTP ${res.status} ${res.statusText}`);
  }
  return res.text();
}

/**
 * Locate the deployment's local copy of a GGUF in the HF cache layout
 * (models--{org}--{name}/snapshots/<rev>/<file>) — newest revision wins.
 * The local file IS what llama-swap serves, so it is the authoritative
 * in-force copy; the hub fetch below is the fallback. (Same lookup the
 * drift checker performs — its copy is private to that CLI, so it is mirrored
 * here; the DERIVATION pipeline, in contrast, is shared, not duplicated.)
 */
function localGgufPath(repo: string, file: string): string | null {
  const slash = repo.indexOf("/");
  if (slash < 0) return null;
  const org = repo.slice(0, slash);
  const name = repo.slice(slash + 1);
  const bases = [
    process.env.HUGGINGFACE_HUB_CACHE,
    process.env.HF_HOME ? path.join(process.env.HF_HOME, "hub") : null,
    path.join(os.homedir(), ".cache", "huggingface", "hub"),
  ].filter((b): b is string => typeof b === "string" && b.length > 0);
  for (const base of bases) {
    const snapshots = path.join(base, `models--${org}--${name}`, "snapshots");
    if (!existsSync(snapshots)) continue;
    let best: { p: string; m: number } | null = null;
    for (const rev of readdirSync(snapshots, { withFileTypes: true })) {
      if (!rev.isDirectory()) continue;
      const p = path.join(snapshots, rev.name, file);
      if (!existsSync(p)) continue;
      const m = statSync(p).mtimeMs;
      if (!best || m > best.m) best = { p, m };
    }
    if (best) return best.p;
  }
  return null;
}

const GGUF_RANGE_MB = [16, 32, 64, 128, 256];

async function fetchGgufPrefix(fetchImpl: FetchLike, repo: string, file: string): Promise<Uint8Array> {
  const url = `https://huggingface.co/${repo}/resolve/main/${file}`;
  for (const mb of GGUF_RANGE_MB) {
    let res: Response;
    try {
      res = await fetchImpl(url, { headers: { "user-agent": UA, range: `bytes=0-${mb * 1024 * 1024 - 1}` } });
    } catch (e) {
      throw new FetchError(`${url}: network failure — ${errMsg(e)}`);
    }
    if (res.status === 416) {
      try {
        res = await fetchImpl(url, { headers: { "user-agent": UA } });
      } catch (e) {
        throw new FetchError(`${url}: network failure — ${errMsg(e)}`);
      }
    }
    if (!res.ok) {
      throw new FetchError(`${url}: HTTP ${res.status} ${res.statusText}`);
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    try {
      parseGgufKvPrefix(buf); // validates the KV section is complete within the prefix
      return buf;
    } catch (e) {
      const isPrefix = e instanceof Error && e.name === "GgufPrefixError";
      if (isPrefix && buf.byteLength === mb * 1024 * 1024) continue; // grow
      throw new FetchError(`${url}: GGUF parse failure — ${errMsg(e)}`);
    }
  }
  throw new FetchError(`${url}: KV section exceeds the ${GGUF_RANGE_MB[GGUF_RANGE_MB.length - 1]} MB prefix cap`);
}

interface ParsedArgs {
  repo: string;
  match: string;
  out?: string;
  family?: string;
  templateFile?: string;
  ggufFile?: string;
  contextWindow?: number;
}

function parseArgs(args: string[]): { parsed: ParsedArgs | null; errors: string[] } {
  const errors: string[] = [];
  const parsed: ParsedArgs = { repo: "", match: "" };
  const take = (i: number, name: string): [string, number] | null => {
    const v = args[i + 1];
    if (v === undefined || v.startsWith("--")) {
      errors.push(`${name} needs a value`);
      return null;
    }
    return [v, i + 2];
  };
  let i = 0;
  while (i < args.length) {
    const a = args[i] ?? "";
    if (a === "--match") {
      const r = take(i, "--match");
      if (r) { parsed.match = r[0]; i = r[1]; continue; }
      i++; continue;
    }
    if (a === "--out") {
      const r = take(i, "--out");
      if (r) { parsed.out = r[0]; i = r[1]; continue; }
      i++; continue;
    }
    if (a === "--family") {
      const r = take(i, "--family");
      if (r) { parsed.family = r[0]; i = r[1]; continue; }
      i++; continue;
    }
    if (a === "--template") {
      const r = take(i, "--template");
      if (r) { parsed.templateFile = r[0]; i = r[1]; continue; }
      i++; continue;
    }
    if (a === "--file") {
      const r = take(i, "--file");
      if (r) { parsed.ggufFile = r[0]; i = r[1]; continue; }
      i++; continue;
    }
    if (a === "--context-window") {
      const r = take(i, "--context-window");
      if (r) {
        const n = Number(r[0]);
        if (!Number.isInteger(n) || n <= 0) errors.push(`--context-window '${r[0]}' is not a positive integer`);
        parsed.contextWindow = n;
        i = r[1];
        continue;
      }
      i++; continue;
    }
    if (a.startsWith("--")) {
      errors.push(`unknown option: ${a}`);
      i++;
      continue;
    }
    if (parsed.repo === "") {
      parsed.repo = a;
    } else {
      errors.push(`unexpected argument: ${a}`);
    }
    i++;
  }
  if (parsed.repo === "") errors.push("missing <repo> (org/name or https://huggingface.co/org/name)");
  if (parsed.match === "") errors.push("missing --match <pattern> (the model-id regex the entry should match)");
  else {
    try {
      new RegExp(parsed.match);
    } catch (e) {
      errors.push(`--match '${parsed.match}' is not a valid regular expression: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (parsed.family !== undefined && parsed.family !== "qwen" && parsed.family !== "gpt-oss") {
    errors.push(`--family must be 'qwen' or 'gpt-oss' (got '${parsed.family}')`);
  }
  return { parsed: errors.length > 0 ? null : parsed, errors };
}

function usage(): string {
  return [
    "usage: preset-draft <org/name | https://huggingface.co/org/name> --match <pattern> [options]",
    "  --out <path>            draft file (default: preset-draft.<pattern>.md in the cwd)",
    "  --family qwen|gpt-oss   force the invariant family (default: auto-detect from the template)",
    "  --template <local-file> OFFLINE mode: template text from a local file, no HF fetch",
    "  --file <gguf-name>      GGUF repo: which .gguf file to read (default: the sole file, else first — flagged)",
    "  --context-window <n>    offline mode: assert the context window from deployment knowledge",
  ].join("\n");
}

async function draftFromRepo(parsed: ParsedArgs, fetchImpl: FetchLike, now: () => string): Promise<{ input: DraftInput; source: string }> {
  const repo = normalizeRepo(parsed.repo);
  const meta = hubMetadataFromApi(await getJson(fetchImpl, `https://huggingface.co/api/models/${repo}`));

  // GGUF repo: the embedded copy is the in-force one (llama-server --jinja).
  if (isGgufRepo(repo) || parsed.ggufFile !== undefined) {
    const files = ggufFiles(meta.siblings);
    const choice = chooseGgufFile(files, parsed.ggufFile);
    const local = localGgufPath(repo, choice.chosen);
    let buf: Uint8Array;
    let source: string;
    if (local) {
      // Capped read: the KV section precedes the multi-GB tensor data, which is never needed (gguf.ts).
      buf = readPrefix(local);
      source = `local HF cache: ${local}`;
    } else {
      buf = await fetchGgufPrefix(fetchImpl, repo, choice.chosen);
      source = `huggingface.co/${repo}/resolve/main/${choice.chosen} (KV-prefix fetch)`;
    }
    let fields: Map<string, string | number | boolean>;
    try {
      fields = parseGgufKvPrefix(buf).fields;
    } catch (e) {
      // The local read is capped: an incomplete KV section (a file mid-download, or one beyond the cap) is a clean FETCH-FAIL, not a crash.
      if (e instanceof GgufPrefixError) throw new FetchError(`${repo}/${choice.chosen}: ${errMsg(e)}`);
      throw e;
    }
    const template = fields.get("tokenizer.chat_template");
    if (typeof template !== "string") {
      throw new FetchError(`${repo}/${choice.chosen}: no tokenizer.chat_template KV in the GGUF metadata`);
    }
    let contextWindow: { value: number; source: string } | null = null;
    for (const [k, v] of fields) {
      if (k.endsWith(".context_length") && (typeof v === "string" || typeof v === "number") && Number(v) > 0) {
        contextWindow = { value: Number(v), source: `GGUF key ${k} = ${v}` };
        break;
      }
    }
    const baseModelRepo =
      typeof fields.get("general.base_model.0.repo_url") === "string"
        ? (fields.get("general.base_model.0.repo_url") as string)
        : null;
    const gguf = { files, chosen: choice.chosen, ambiguous: choice.ambiguous || files.length > 1, baseModelRepo };
    return {
      input: {
        repo,
        match: parsed.match,
        kind: "gguf" as const,
        spelling: "gguf-embedded" as TemplateSpelling,
        templateFile: choice.chosen,
        templateText: template,
        headCommit: null,
        contextWindow,
        gguf,
        otherSpellings: [] as TemplateSpelling[],
        familyOverride: parsed.family === "qwen" ? ("qwen" as const) : parsed.family === "gpt-oss" ? ("gpt-oss" as const) : null,
        fetchedAt: now(),
        offline: false,
      },
      source,
    };
  }

  const spellings = detectSpellings(meta);
  const primary = pickSpelling(spellings);
  if (primary === null) {
    throw new FetchError(
      `${repo}: no template found in any of the three spellings (chat_template.jinja file, chat_template.json file, API-embedded tokenizer_config.chat_template) — this repo does not carry a chat template the tool can draft from`,
    );
  }
  let text: string;
  let templateFile: string;
  let source: string;
  if (primary === "api-embedded") {
    text = meta.embeddedTemplate as string;
    templateFile = "chat_template (API-embedded, tokenizer_config.chat_template)";
    source = `huggingface.co/api/models/${repo} (embedded config block)`;
  } else {
    text = await getText(fetchImpl, `https://huggingface.co/${repo}/resolve/main/${primary}`);
    templateFile = primary;
    source = `huggingface.co/${repo}/resolve/main/${primary}`;
  }
  return {
    input: {
      repo,
      match: parsed.match,
      kind: "hub" as const,
      spelling: primary,
      templateFile,
      templateText: text,
      headCommit: meta.sha,
      contextWindow: contextWindowFromConfig(meta.config),
      gguf: null,
      otherSpellings: otherSpellings(spellings, primary),
      familyOverride: parsed.family === "qwen" ? ("qwen" as const) : parsed.family === "gpt-oss" ? ("gpt-oss" as const) : null,
      fetchedAt: now(),
      offline: false,
    },
    source,
  };
}

async function draftFromLocalFile(parsed: ParsedArgs, now: () => string): Promise<{ input: DraftInput; source: string }> {
  const repo = normalizeRepo(parsed.repo);
  const p = path.resolve(parsed.templateFile as string);
  if (!existsSync(p)) throw new DraftError(`--template file not found: ${p}`);
  const text = readFileSync(p, "utf8");
  return {
    input: {
      repo,
      match: parsed.match,
      kind: "local" as const,
      spelling: "local-file" as TemplateSpelling,
      templateFile: path.basename(p),
      templateText: text,
      headCommit: null,
      contextWindow:
        parsed.contextWindow !== undefined
          ? { value: parsed.contextWindow, source: `--context-window ${parsed.contextWindow} (human-asserted, offline mode)` }
          : null,
      gguf: null,
      otherSpellings: [] as TemplateSpelling[],
      familyOverride: parsed.family === "qwen" ? ("qwen" as const) : parsed.family === "gpt-oss" ? ("gpt-oss" as const) : null,
      fetchedAt: now(),
      offline: true,
    },
    source: `local file: ${p}`,
  };
}

/** The whole run, with every I/O seam injectable (tests run this offline). */
export async function runDraft(args: string[], env: RunEnv = {}): Promise<RunResult> {
  const stdout = env.stdout ?? ((s: string) => process.stdout.write(`${s}\n`));
  const stderr = env.stderr ?? ((s: string) => process.stderr.write(`${s}\n`));
  const fetchImpl = env.fetchImpl ?? fetch;
  const writeImpl = env.writeImpl ?? ((p, c) => {
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, c, "utf8");
  });
  const cwd = env.cwd ?? process.cwd();
  const now = env.now ?? (() => new Date().toISOString());
  const messages: string[] = [];
  const say = (s: string) => {
    messages.push(s);
    stdout(s);
  };

  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major === 22 && (minor ?? 0) < 18) {
    stderr(`preset-draft: Node ${process.versions.node} needs the --experimental-strip-types flag (or upgrade to Node >= 22.18).`);
    return { code: 2, outPath: null, content: null, messages };
  }

  const { parsed, errors } = parseArgs(args);
  if (errors.length > 0 || parsed === null) {
    for (const e of errors) stderr(`preset-draft: ${e}`);
    stderr(usage());
    return { code: 2, outPath: null, content: null, messages };
  }

  say("modelspoke preset draft");
  say(`repo: ${parsed.repo}  match: ${parsed.match}${parsed.templateFile ? "  (OFFLINE mode: --template)" : ""}`);

  let input: DraftInput;
  let source: string;
  try {
    const r = parsed.templateFile ? await draftFromLocalFile(parsed, now) : await draftFromRepo(parsed, fetchImpl, now);
    input = r.input;
    source = r.source;
  } catch (e) {
    if (e instanceof FetchError) {
      stderr(`FETCH-FAIL (not a draft): ${e.message}`);
      stderr("A draft that cannot fetch is not a pass — retry (network/rate-limit, HF_TOKEN for gated repos) or use --template <local-file> for offline mode.");
      return { code: 1, outPath: null, content: null, messages };
    }
    if (e instanceof DraftError) {
      stderr(`DRAFT-FAIL: ${e.message}`);
      return { code: 1, outPath: null, content: null, messages };
    }
    throw e;
  }

  say(`template source: ${source}`);
  say(`template sha256: ${sha256Hex(input.templateText)}`);
  say("");

  let content: string;
  try {
    const artifact = buildDraft(input);
    content = renderDraft(artifact);
  } catch (e) {
    if (e instanceof DraftError) {
      stderr(`DRAFT-FAIL: ${e.message}`);
      return { code: 1, outPath: null, content: null, messages };
    }
    throw e;
  }

  const outPath = path.resolve(cwd, parsed.out ?? defaultDraftFileName(parsed.match));
  const existed = existsSync(outPath);
  writeImpl(outPath, content);
  stdout(content);
  stdout("");
  say(`draft written: ${outPath}${existed ? " (overwrote an existing draft)" : ""}`);
  say("NEXT: a human reviews the judgment items, then copies the entry into src/presets/catalog.ts + the provenance entry into src/presets/provenance.json and commits. The tool never writes presets.");
  return { code: 0, outPath, content, messages };
}

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  runDraft(process.argv.slice(2)).then((r) => {
    process.exit(r.code);
  });
}
