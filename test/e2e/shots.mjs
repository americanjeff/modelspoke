/**
 * Docs screenshots for the 0.1.7 UI — the Modelspoke card on the sidebar
 * Plugins page's bundle detail, and a model's open detail inside the card's
 * provider editor. The shots ride on dsh's own web UI, so a dsh bump can
 * change them — pinned via the shared DSH_VERSION guard.
 *
 * Usage: node test/e2e/shots.mjs (build modelspoke first — dist/ must exist).
 * Env: E2E_DSH, E2E_CHROME, E2E_LLSWAP_URL (a local llama-swap for a rich
 * catalog; falls back to the e2e fake swap when unreachable).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { chromium } from "playwright-core";
import {
  DSH_VERSION,
  until,
  findChrome,
  startFakeSwap,
  makeScratchHome,
  bootDshWeb,
  openModelspoke,
  ui,
  typeInput,
} from "./e2e.test.mjs";

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const SCREENSHOT_DIR = path.join(REPO_ROOT, "docs", "screenshots");
const PROVIDER_NAME = "llama-swap";
const LLSWAP_URL = process.env.E2E_LLSWAP_URL || "http://127.0.0.1:8080/v1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const dshVersion = execFileSync(process.env.E2E_DSH || "dsh", ["--version"], {
    encoding: "utf8",
  }).trim();
  if (dshVersion !== DSH_VERSION) {
    throw new Error(`dsh version mismatch: ${dshVersion} (shots pinned to ${DSH_VERSION})`);
  }
  if (!existsSync(path.join(REPO_ROOT, "dist", "dsh", "index.js"))) {
    throw new Error("modelspoke is not built (dist/) — run the build first");
  }
  const chrome = findChrome();

  const root = path.join(os.tmpdir(), `modelspoke-shots-${randomBytes(4).toString("hex")}`);
  mkdirSync(root, { recursive: true });
  const home = makeScratchHome(root);

  // The live llama-swap (real model names, rich metadata) when reachable,
  // else the e2e fake swap (deterministic, three models).
  let swap = null;
  let catalog = await fetch(`${LLSWAP_URL}/models`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  let baseUrl;
  if (catalog?.data?.length) {
    baseUrl = LLSWAP_URL;
    console.log(`live llama-swap: ${LLSWAP_URL} (${catalog.data.length} models)`);
  } else {
    swap = await startFakeSwap(root);
    baseUrl = swap.baseUrl;
    catalog = await fetch(`${baseUrl}/models`).then((r) => r.json());
    console.log(`live llama-swap unreachable — fake swap: ${baseUrl} (${catalog.data.length} models)`);
  }
  // The detail shot: a model with a thinkingLevelMap (rich detail:
  // context/maxTokens + thinking rows).
  const flagship =
    catalog.data.find((m) => m.id === "fake-flagship")?.id ??
    catalog.data.find((m) => m.meta?.llamaswap?.thinkingLevelMap)?.id ??
    catalog.data[0].id;
  console.log(`detail shot on ${flagship}`);

  const web = await bootDshWeb(root, home);
  console.log(`dsh web: ${web.url}`);

  const browser = await chromium.launch({ headless: true, executablePath: chrome });
  try {
    const s = await openModelspoke(browser, web.url);
    const u = ui(s.page);
    await u.addProvider.click();
    await until(() => u.inputName.count(), { what: "add-provider form" });
    await typeInput(s.page, u.inputName, PROVIDER_NAME);
    await typeInput(s.page, u.inputBaseUrl, baseUrl);
    await u.next.click();
    await until(() => u.edit(PROVIDER_NAME).count(), { what: "provider row" });
    await until(async () => /models · last checked/.test(await u.rowDotAria(PROVIDER_NAME)), {
      timeout: 30000,
      what: "catalog fetch (green dot)",
    });
    await sleep(1500);
    // Frame the shot at the card's disclosure header (where the settings
    // live) rather than the provider row — the editor below is tall, and a
    // row-anchored scroll pushes the card header out of the pane.
    await s.page.evaluate(() => {
      const card = [...document.querySelectorAll("button[aria-expanded]")]
        .find((b) => b.getAttribute("aria-expanded") === "true" && (b.textContent || "").includes("Modelspoke"));
      card?.scrollIntoView({ block: "start" });
    });
    await sleep(500);
    const p1 = path.join(SCREENSHOT_DIR, "modelspoke-01-section.png");
    await s.page.screenshot({ path: p1 });
    console.log(`shot 1 → ${p1}`);

    await u.detail(flagship).click();
    await until(() => u.contextWindow(flagship).count(), { what: "model detail" });
    await sleep(1000);
    const p2 = path.join(SCREENSHOT_DIR, "modelspoke-02-detail.png");
    await s.page.screenshot({ path: p2 });
    console.log(`shot 2 → ${p2}`);

    console.log("done — inspect the shots before committing");
  } finally {
    await browser.close().catch(() => {});
    web.stop();
    swap?.stop();
    await sleep(800);
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`fatal: ${err.message}`);
  process.exit(1);
});
