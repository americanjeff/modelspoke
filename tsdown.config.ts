/**
 * Client build face: bundles src/dsh/client.tsx into dist/dsh/client.js —
 * the dsh clientBundle closure-factory shape (research/plugin-ui-surface.md
 * §1.3; mirrors the in-repo SRC packages/client/tsdown.client.ts without the
 * workspace preset: plain tsdown, no CSS pipeline — the page uses inline
 * plain elements like B0).
 *
 * Library face: bundles src/lib.ts into dist/lib.js — the `modelspoke/lib`
 * stable core surface (docs/design.md, library face) as a single-file ESM artifact
 * (zero relative imports; `@earendil-works/pi-ai` is type-only in the core,
 * so the bundle has no runtime deps). dts stays false: the node half is pure
 * tsc output (shared dist/) — tsc already emits dist/lib.d.ts, which
 * package.json's exports["./lib"].types points at.
 *
 * The bundle hands itself to the web shell's module loader —
 * `window.__ModuleLoader__.load({ id, factory: (require) => { …CJS… } })` —
 * and the injected `require` resolves externals through the loader's module
 * table. Only baseline table rows may be required (EXTERNALS below, from
 * SRC packages/client/web/src/platform.ts); anything else MUST inline into
 * the bundle — a require() the table cannot answer is a guaranteed runtime
 * throw.
 *
 * The node half is pure tsc output (shared dist/), so clean stays off.
 */
import { isBuiltin } from "node:module";
import type { UserConfig } from "tsdown";

/** The row id the bundle registers under (== package name == Cordis row id). */
const ID = "modelspoke";

/** Baseline module-table rows a client bundle may require without declaring them. */
const EXTERNALS = new Set([
  "react",
  "react/jsx-runtime",
  "react-dom",
  "react-dom/client",
  "@deepseek-ai/cordis",
  "@deepseek-ai/dsh-client-ui-slots",
  "@deepseek-ai/dsh-client-ui-primitives",
  "@deepseek-ai/dsh-client-runtime/client",
  // B3: the ctx.connection.api surface (llm.discoverModels). The row is a
  // dynamic host bundle (the connection plugin is part of dsh's own web
  // composition), so the browser module table answers the require after
  // dsh.client.external names it.
  "@deepseek-ai/dsh-client-connection/client",
]);

export default [
  {
    name: "modelspoke/lib",
    entry: { lib: "src/lib.ts" },
    outDir: "dist",
    format: "esm",
    platform: "node",
    dts: false,
    sourcemap: true,
    clean: false,
    outputOptions: {
      entryFileNames: "lib.js",
    },
  },
  {
    name: "modelspoke/client",
    entry: { client: "src/dsh/client.tsx" },
    outDir: "dist/dsh",
    format: "cjs",
    platform: "browser",
    dts: false,
    sourcemap: true,
    clean: false,
    deps: {
      neverBundle: (specifier: string) => EXTERNALS.has(specifier),
      alwaysBundle: (specifier: string) =>
        !isBuiltin(specifier) && !EXTERNALS.has(specifier),
    },
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
    },
    outputOptions: {
      entryFileNames: "client.js",
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
      footer: "return module.exports; } });",
      intro: "var module = { exports: {} }; var exports = module.exports;",
    },
  },
] satisfies UserConfig[];
