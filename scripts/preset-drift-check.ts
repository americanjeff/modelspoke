/**
 * The build-time preset drift checker (dev tool; NOT part of the plugin
 * bundle — it is outside src/ and no plugin entry imports it).
 *
 * For each entry of the provenance manifest (src/presets/provenance.json):
 * fetch every pinned contract copy — hub copies BY COMMIT (the pin is the
 * contract; branch head is never fetched), GGUF copies by repo file (local
 * HF cache first — that IS the deployment artifact — else a bounded
 * Range-prefix read + KV parse) — sha256 the EXACT template text against the
 * pinned sha, and re-derive the mechanical invariants
 * (scripts/drift-invariants.ts) against the catalog entry. Cross-copy
 * differences (hub jinja vs GGUF-embedded) are reported as INFORMATIONAL
 * divergences, never as drift — the catalog must be valid against every
 * copy, which the per-copy check proves.
 *
 * Exit codes: 0 = all artifacts fetched, all shas match, no invariant
 * findings. 1 = drift (sha mismatch / invariant finding / extraction
 * failure) OR a fetch failure (a drift check that cannot fetch is not a
 * pass — reported as such, distinct from drift). 2 = usage/manifest error.
 *
 * The tool NEVER writes or suggests preset content: on drift a human re-runs
 * the preset authoring pass (docs/preset-authoring.md) against the new
 * template.
 *
 * Run: npm run drift-check  (or node scripts/preset-drift-check.ts)
 * Requires Node >= 22.18 for flagless native TS stripping (or pass
 * --experimental-strip-types on Node 22.6-22.17). --manifest <path> points
 * the run at an alternate manifest (scratch copies — the repo manifest is
 * never edited to test detection).
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { presetCatalog } from "../src/presets/catalog.ts";
import {
  checkPresetInvariants,
  describeInvariants,
  diffInvariants,
  DriftExtractError,
  extractInvariants,
  type InvariantFamily,
  type TemplateInvariants,
} from "./drift-invariants.ts";
import {
  ggufChatTemplate,
  GgufPrefixError,
  readPrefix,
} from "./gguf.ts";

interface ManifestHubCopy {
  kind: "hub";
  repo: string;
  commit: string;
  file: string;
  sha256: string;
  note?: string;
}
interface ManifestGgufCopy {
  kind: "gguf";
  repo: string;
  file: string;
  sha256: string;
  note?: string;
}
type ManifestCopy = ManifestHubCopy | ManifestGgufCopy;
interface ManifestEntry {
  presetId: string;
  family: InvariantFamily;
  contracts: ManifestCopy[];
  notes?: string;
}
interface Manifest {
  version: number;
  description?: string;
  entries: ManifestEntry[];
}

/** A fetch problem: NOT drift. A drift check that cannot fetch is not a pass. */
class FetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FetchError";
  }
}

const UA = "modelspoke-preset-drift-check/0.1";

/** Fetch a hub file BY COMMIT (never branch head — the pin is the contract). */
async function fetchHubFile(repo: string, commit: string, file: string): Promise<string> {
  const url = `https://huggingface.co/${repo}/resolve/${commit}/${file}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { "user-agent": UA } });
  } catch (e) {
    throw new FetchError(`${url}: network failure — ${e instanceof Error ? e.message : String(e)}`);
  }
  // Note: HF answers 401 (not 404) for unknown repos AND for gated files —
  // either way this is a fetch failure, reported as such (spike, endpoint
  // behavior).
  if (!res.ok) {
    throw new FetchError(`${url}: HTTP ${res.status} ${res.statusText}`);
  }
  return res.text();
}

/**
 * Locate the deployment's local copy of a GGUF in the HF cache layout
 * (models--{org}--{name}/snapshots/<rev>/<file>) — newest revision wins.
 * The local file IS what llama-swap serves, so it is the authoritative
 * in-force copy; the HF fetch below is the fallback for machines without
 * the cache.
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

/**
 * Fetch a GGUF-embedded template from the hub: bounded Range prefixes,
 * growing until the KV section parses (it sits before any tensor data —
 * ~11-13 MB in for the pinned files).
 */
async function fetchGgufTemplate(repo: string, file: string): Promise<string> {
  const url = `https://huggingface.co/${repo}/resolve/main/${file}`;
  for (const mb of GGUF_RANGE_MB) {
    let res: Response;
    try {
      res = await fetch(url, { headers: { "user-agent": UA, range: `bytes=0-${mb * 1024 * 1024 - 1}` } });
    } catch (e) {
      throw new FetchError(`${url}: network failure — ${e instanceof Error ? e.message : String(e)}`);
    }
    if (res.status === 416) {
      // File smaller than the requested range: take the whole file.
      try {
        res = await fetch(url, { headers: { "user-agent": UA } });
      } catch (e) {
        throw new FetchError(`${url}: network failure — ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (!res.ok) {
      throw new FetchError(`${url}: HTTP ${res.status} ${res.statusText}`);
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    try {
      return ggufChatTemplate(buf);
    } catch (e) {
      if (e instanceof GgufPrefixError && buf.byteLength === mb * 1024 * 1024) continue;
      throw e; // non-prefix parse error (bad magic, unknown type) — surfaced by caller
    }
  }
  throw new FetchError(`${url}: KV section exceeds the ${GGUF_RANGE_MB[GGUF_RANGE_MB.length - 1]} MB prefix cap`);
}

interface LoadedCopy {
  copy: ManifestCopy;
  text: string;
  sha256: string;
  source: string; // where the template text came from (for the report)
}

async function loadCopy(copy: ManifestCopy): Promise<LoadedCopy> {
  if (copy.kind === "hub") {
    const text = await fetchHubFile(copy.repo, copy.commit, copy.file);
    return {
      copy,
      text,
      sha256: sha256(text),
      source: `huggingface.co/${copy.repo}/resolve/${copy.commit}/${copy.file}`,
    };
  }
  const local = localGgufPath(copy.repo, copy.file);
  if (local) {
    const buf = readPrefix(local);
    const text = ggufChatTemplate(buf);
    return {
      copy,
      text,
      sha256: sha256(text),
      source: `local HF cache: ${local}`,
    };
  }
  const text = await fetchGgufTemplate(copy.repo, copy.file);
  return { copy, text, sha256: sha256(text), source: `huggingface.co/${copy.repo}/resolve/main/${copy.file} (KV-prefix fetch)` };
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function shortSha(sha: string): string {
  return `${sha.slice(0, 12)}…`;
}

function copyLabel(c: ManifestCopy): string {
  return c.kind === "hub"
    ? `hub  ${c.repo}@${c.commit.slice(0, 8)} ${c.file}`
    : `gguf ${c.repo} ${c.file}`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const mi = args.indexOf("--manifest");
  const manifestArg = args[mi + 1];
  const manifestPath =
    mi >= 0 && typeof manifestArg === "string" && manifestArg.length > 0
      ? path.resolve(manifestArg)
      : path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "presets", "provenance.json");

  if (!existsSync(manifestPath)) {
    console.error(`drift-check: manifest not found: ${manifestPath}`);
    process.exit(2);
  }
  let manifest: Manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
  } catch (e) {
    console.error(`drift-check: manifest is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
  if (!Array.isArray(manifest.entries) || manifest.entries.length === 0) {
    console.error("drift-check: manifest has no entries");
    process.exit(2);
  }

  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major === 22 && (minor ?? 0) < 18) {
    console.error(
      `drift-check: Node ${process.versions.node} needs the --experimental-strip-types flag (or upgrade to Node >= 22.18).`,
    );
    process.exit(2);
  }

  let driftFound = false;
  let fetchFailed = false;

  console.log("modelspoke preset drift check");
  console.log(`manifest: ${manifestPath} (${manifest.entries.length} entries)`);
  console.log("");

  for (const entry of manifest.entries) {
    const preset = presetCatalog.find((p) => p.id === entry.presetId);
    if (!preset) {
      console.error(`[${entry.presetId}] manifest references a preset that is not in the catalog — manifest/catalog out of sync`);
      driftFound = true;
      continue;
    }
    console.log(`[${entry.presetId}] family=${entry.family} (${entry.contracts.length} contract copies)`);

    const loaded: LoadedCopy[] = [];
    const invs: { label: string; inv: TemplateInvariants }[] = [];
    let entryDrift = false;
    let entryFetchFail = false;

    for (const copy of entry.contracts) {
      let lc: LoadedCopy;
      try {
        lc = await loadCopy(copy);
      } catch (e) {
        if (e instanceof FetchError) {
          console.log(`  FETCH-FAIL (not drift)  ${copyLabel(copy)}\n      ${e.message}`);
          entryFetchFail = true;
        } else {
          console.log(`  PARSE-FAIL (not drift)  ${copyLabel(copy)}\n      ${e instanceof Error ? e.message : String(e)}`);
          entryFetchFail = true;
        }
        continue;
      }
      loaded.push(lc);

      const shaOk = lc.sha256 === copy.sha256;
      const status = shaOk ? "ok" : "DRIFT";
      console.log(`  ${status}  ${copyLabel(copy)}`);
      console.log(`      sha256 ${shortSha(lc.sha256)} (pinned ${shortSha(copy.sha256)}) — ${lc.source}`);
      if (!shaOk) {
        entryDrift = true;
        console.log(`      DRIFT: fetched template does not match the pinned sha256`);
      }

      try {
        const inv = extractInvariants(entry.family, lc.text);
        invs.push({ label: copyLabel(copy), inv });
        console.log(`      ${describeInvariants(inv)}`);
        const { findings, warnings } = checkPresetInvariants(inv, preset);
        for (const w of warnings) console.log(`      note: ${w}`);
        for (const f of findings) {
          entryDrift = true;
          console.log(`      DRIFT: ${f}`);
        }
      } catch (e) {
        if (e instanceof DriftExtractError) {
          entryDrift = true;
          console.log(`      DRIFT: invariant extraction failed — ${e.message}`);
        } else {
          throw e;
        }
      }
    }

    // Cross-copy divergence: informational only (the per-copy checks above
    // already proved the catalog is valid against EVERY copy).
    const base = invs[0];
    if (base) {
      for (let i = 1; i < invs.length; i++) {
        const cur = invs[i];
        if (!cur) continue;
        const diffs = diffInvariants(base.inv, cur.inv);
        if (diffs.length > 0) {
          console.log(`  DIVERGENCE (informational, not drift) — pinned copies of this entry differ:`);
          for (const d of diffs) {
            const [field, rest] = splitOnce(d, ": ");
            console.log(
              `      ${field}: ${base.label}=${rest?.split(" vs ")[0] ?? "-"} | ${cur.label}=${rest?.split(" vs ")[1] ?? rest}`,
            );
          }
          console.log(
            `      (the catalog's values are valid against every copy; a human re-authoring this entry must account for the divergence — see the manifest notes)`,
          );
        }
      }
    }

    if (entryDrift) {
      console.log(`  => ${entry.presetId}: DRIFT`);
      driftFound = true;
    } else if (entryFetchFail) {
      console.log(`  => ${entry.presetId}: INCOMPLETE (fetch failed — not a pass)`);
      fetchFailed = true;
    } else {
      console.log(`  => ${entry.presetId}: OK (${loaded.length}/${entry.contracts.length} copies verified)`);
    }
    console.log("");
  }

  if (driftFound) {
    console.error("DRIFT CHECK FAILED: the catalog no longer matches its pinned artifacts. Re-run the preset authoring pass (docs/preset-authoring.md) against the offending template(s); the tool does not write presets.");
    process.exit(1);
  }
  if (fetchFailed) {
    console.error("DRIFT CHECK INCOMPLETE: fetch failures above are not drift, but a drift check that cannot fetch is not a pass. Retry (network/rate-limit), then re-run.");
    process.exit(1);
  }
  console.log(`DRIFT CHECK PASSED: ${manifest.entries.length}/${manifest.entries.length} entries verified.`);
  process.exit(0);
}

function splitOnce(s: string, sep: string): [string, string | undefined] {
  const i = s.indexOf(sep);
  return i < 0 ? [s, undefined] : [s.slice(0, i), s.slice(i + sep.length)];
}

main().catch((e) => {
  console.error(`drift-check: unexpected error — ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exit(1);
});
