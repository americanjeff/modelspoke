/**
 * The core→host import boundary guard (docs/design.md, library face).
 *
 * The library surface (`src/lib.ts` → `modelspoke/lib`) re-exports the
 * framework-neutral core — `src/{discovery,resolve,presets,config,overrides,
 * types}` — and this test pins the dependency direction that surface
 * promises: those core modules never import from a host directory
 * (`src/dsh/`; the guard list still covers a future `src/pi/`) nor from the
 * dsh host packages (`@deepseek-ai/*` — cordis, dsh-llm, dsh-settings,
 * schemastery) or pi host packages (`@earendil-works/pi-coding-agent`, a bare
 * `pi`). The ONE sanctioned
 * external import is `@earendil-works/pi-ai` — the shared `compat` /
 * `thinkingLevelMap` vocabulary (docs/design.md), type-only in the core, and
 * explicitly allowed here.
 *
 * The direction currently holds by convention; the moment a third consumer
 * trusts it, it must hold by test.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

/** The core directories the ./lib barrel stands on (docs/design.md, library face). */
const CORE_DIRS = ["discovery", "resolve", "presets", "config"];
const CORE_FILES = ["overrides.ts", "types.ts"];

/** Host dirs a core module must never import from (relative specifiers resolving here). */
const HOST_DIRS = new Set(["dsh", "pi"]);

/** The shared vocabulary — the core's one sanctioned external import. */
const PI_AI = "@earendil-works/pi-ai";

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (entry.isFile() && entry.name.endsWith(".ts")) yield p;
  }
}

const coreFiles: string[] = [
  ...CORE_DIRS.flatMap((d) => [...walk(path.join(SRC, d))]),
  ...CORE_FILES.map((f) => path.join(SRC, f)),
];

/**
 * Strip comments so the specifier scan sees only code — prose may
 * legitimately say "dsh" or "pi" (this file's own docblock does). `//` not
 * preceded by `:` keeps `https://` URLs intact.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(?<!:)\/\/[^\n]*/g, " ");
}

/**
 * Import/export specifiers only: static `import … from` / `export … from`
 * (the from-clause of a multi-line statement sits on its own line),
 * side-effect `import "x"`, and dynamic `import("x")`. `(?<![\w.])` keeps
 * member calls like `Buffer.from("…")` out.
 */
const SPECIFIER_PATTERNS = [
  /(?<![\w.])from\s*["']([^"'\n]+)["']/g,
  /(?<![\w.])import\s*["']([^"'\n]+)["']/g,
  /(?<![\w.])import\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
] as const;

/**
 * Why the specifier breaks the core→host boundary, or null when it is
 * allowed. `fileRelSrc` is the importing file's path relative to `src/`.
 */
function boundaryViolation(specifier: string, fileRelSrc: string): string | null {
  if (specifier.startsWith(".")) {
    // Resolve against the importing file's directory (relative to src/):
    // `../dsh/…` must land in src/dsh/ regardless of the caller's depth.
    const resolved = path.posix.normalize(
      path.posix.join(path.posix.dirname(fileRelSrc), specifier),
    );
    const top = resolved.split("/")[0]!;
    if (HOST_DIRS.has(top)) {
      return `relative specifier "${specifier}" resolves into src/${top}/`;
    }
    return null;
  }
  if (specifier.startsWith("node:")) return null;
  // The sanctioned shared vocabulary (type-only in the core).
  if (specifier === PI_AI || specifier.startsWith(`${PI_AI}/`)) return null;
  // dsh host family: everything under @deepseek-ai (cordis, dsh-llm,
  // dsh-settings, schemastery, …) plus any other "dsh" spelling.
  if (specifier.startsWith("@deepseek-ai/") || specifier.includes("dsh")) {
    return `dsh host package import "${specifier}"`;
  }
  // pi host: the pi harness package, and any @earendil-works/pi-* other
  // than pi-ai (the vocabulary) — e.g. @earendil-works/pi-coding-agent.
  if (specifier === "pi" || specifier.startsWith("pi/")) {
    return `pi host package import "${specifier}"`;
  }
  if (specifier.startsWith("@earendil-works/pi-")) {
    return `pi host package import "${specifier}"`;
  }
  return null;
}

interface Violation {
  file: string;
  specifier: string;
  reason: string;
}

function scanCore(): Violation[] {
  const violations: Violation[] = [];
  for (const file of coreFiles) {
    const fileRelSrc = path.relative(SRC, file).split(path.sep).join("/");
    const code = stripComments(readFileSync(file, "utf8"));
    for (const pattern of SPECIFIER_PATTERNS) {
      for (const match of code.matchAll(pattern)) {
        const specifier = match[1]!;
        const reason = boundaryViolation(specifier, fileRelSrc);
        if (reason) violations.push({ file: `src/${fileRelSrc}`, specifier, reason });
      }
    }
  }
  return violations;
}

describe("core→host import boundary", () => {
  it("scans a real set of core modules (the guard must not pass vacuously)", () => {
    for (const dir of [...CORE_DIRS, "dsh"]) {
      expect(() => readdirSync(path.join(SRC, dir)), `src/${dir} exists`).not.toThrow();
    }
    const names = coreFiles.map((f) => path.relative(SRC, f).split(path.sep).join("/"));
    expect(names).toContain("types.ts");
    expect(names).toContain("overrides.ts");
    expect(names).toContain("discovery/backends.ts");
    expect(names).toContain("resolve/resolver.ts");
    expect(names).toContain("presets/catalog.ts");
    expect(names).toContain("config/index.ts");
    // The core is physically separate from the host — the walk must not
    // have crossed into src/dsh/ (or a future src/pi/).
    expect(names.every((n) => !n.startsWith("dsh/") && !n.startsWith("pi/"))).toBe(true);
  });

  it("flags what must never appear (guard semantics pinned)", () => {
    expect(boundaryViolation("../dsh/channel.js", "discovery/backends.ts")).toMatch(/src\/dsh\//);
    expect(boundaryViolation("./dsh/x.js", "overrides.ts")).toMatch(/src\/dsh\//);
    expect(boundaryViolation("../pi/config.js", "resolve/resolver.ts")).toMatch(/src\/pi\//);
    expect(boundaryViolation("@deepseek-ai/dsh-llm", "types.ts")).toMatch(/dsh host/);
    expect(boundaryViolation("@deepseek-ai/cordis", "types.ts")).toMatch(/dsh host/);
    expect(boundaryViolation("@earendil-works/pi-coding-agent", "types.ts")).toMatch(/pi host/);
    expect(boundaryViolation("pi/commands", "types.ts")).toMatch(/pi host/);
  });

  it("allows what the core legitimately imports", () => {
    expect(boundaryViolation("./types.js", "discovery/backends.ts")).toBeNull();
    expect(boundaryViolation("../types.js", "resolve/canonical.ts")).toBeNull();
    expect(boundaryViolation("../presets/match.js", "resolve/resolver.ts")).toBeNull();
    expect(boundaryViolation("@earendil-works/pi-ai", "resolve/canonical.ts")).toBeNull();
    expect(boundaryViolation("node:fs", "config/index.ts")).toBeNull();
  });

  it("the core never imports from a host dir or the host packages", () => {
    const violations = scanCore();
    expect(
      violations.map((v) => `${v.file}: ${v.reason}`),
      "core→host import violations",
    ).toEqual([]);
  });
});