import {
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import * as YAML from "js-yaml";
import { chromium } from "playwright-core";

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const DSH_BIN = process.env.E2E_DSH || "dsh";
const LLSWAP_URL = process.env.E2E_LLSWAP_URL || "http://127.0.0.1:8080/v1";

// The shots ride on dsh's own web UI, so a dsh bump can change them — pin.
const DSH_VERSION = "0.1.1-rc.2";

const PROVIDER_NAME = "llama-swap";
const SCREENSHOT_DIR = path.join(REPO_ROOT, "docs", "screenshots");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, { timeout = 30000, interval = 250, what = "condition" } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    let value;
    try {
      value = await fn();
    } catch {
      value = false;
    }
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await sleep(interval);
  }
}

function findChrome() {
  if (process.env.E2E_CHROME) return process.env.E2E_CHROME;
  const cache = path.join(os.homedir(), ".cache", "ms-playwright");
  if (existsSync(cache)) {
    const builds = readdirSync(cache)
      .filter((d) => d.startsWith("chromium-") && !d.includes("headless"))
      .sort();
    for (let i = builds.length - 1; i >= 0; i--) {
      const p = path.join(cache, builds[i], "chrome-linux64", "chrome");
      if (existsSync(p)) return p;
    }
  }
  throw new Error("no chromium found: run `npx playwright install chromium` or set E2E_CHROME");
}

/** Scratch DSH_HOME — verbatim from e2e.test.mjs (web profile copy + re-link). */
function makeScratchHome(root) {
  const home = path.join(root, "home");
  mkdirSync(home, { recursive: true });

  const liveWeb = path.join(os.homedir(), ".dsh", "profiles", "web");
  const web = path.join(home, "profiles", "web");
  cpSync(liveWeb, web, { recursive: true });
  const wpkg = JSON.parse(readFileSync(path.join(web, "package.json"), "utf8"));
  for (const [name, spec] of Object.entries(wpkg.dependencies ?? {})) {
    if (typeof spec !== "string" || !spec.startsWith("link:")) continue;
    const linkDir = path.join(web, "node_modules", name);
    rmSync(linkDir, { recursive: true, force: true });
    symlinkSync(path.resolve(liveWeb, spec.slice(5)), linkDir);
  }
  return home;
}

/** Settings write that suppresses dsh's own onboarding hero. */
function writeSettings(home, doc) {
  writeFileSync(path.join(home, "settings.yaml"), YAML.dump(doc, { lineWidth: -1 }));
}

async function bootDshWeb(root, home) {
  const logPath = path.join(root, "dsh-web.log");
  const fd = openSync(logPath, "a");
  const proc = spawn(DSH_BIN, ["web", "--host", "127.0.0.1", "--port", "0", "--no-open"], {
    env: {
      ...process.env,
      DSH_HOME: home,
      DEEPSEEK_API_KEY: "shots-dummy", // stock route credential check at boot
    },
    stdio: ["ignore", fd, fd],
  });
  const url = await until(async () => {
    const m = readFileSync(logPath, "utf8").match(/dsh web: http:\/\/127\.0\.0\.1:(\d+)/);
    return m ? `http://127.0.0.1:${m[1]}` : undefined;
  }, { timeout: 60000, what: "dsh web URL banner" });
  return {
    url,
    stop: () => { try { proc.kill("SIGTERM"); } catch {} },
  };
}

async function openModelspoke(browser, url) {
  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    colorScheme: "dark",
  });
  const page = await context.newPage();
  page.on("dialog", (d) => d.accept());
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(4000);
  const later = page.getByRole("button", { name: "Configure later" });
  if (await later.count()) {
    await later.first().click();
    await page.waitForTimeout(1500);
  }
  const openSidebar = page.locator('[aria-label="Open sidebar"]');
  if (await openSidebar.count()) {
    await openSidebar.first().click();
    await page.waitForTimeout(800);
  }
  // Settings → Plugins → Plugin configuration (the first tab) → the
  // modelspoke card — the disclosure starts collapsed; expand it.
  await page.evaluate(() => {
    const els = [...document.querySelectorAll('button, a, [role="tab"]')];
    els.find((l) => (l.textContent || "").trim().toLowerCase() === "settings")?.click();
  });
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    const els = [...document.querySelectorAll('button, a, [role="tab"]')];
    els.find((l) => (l.textContent || "").trim().toLowerCase() === "plugins")?.click();
  });
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    const els = [...document.querySelectorAll('button, a, [role="tab"]')];
    els.find((l) => (l.textContent || "").trim().toLowerCase() === "plugin configuration")?.click();
  });
  await page.waitForTimeout(500);
  const card = page.locator('button[aria-expanded]', { hasText: "Modelspoke" });
  await until(async () => {
    const count = await card.count();
    if (count === 0) return false;
    if ((await card.first().getAttribute("aria-expanded")) === "true") return true;
    await card.first().click().catch(() => undefined);
    return false;
  }, { timeout: 20000, what: "the modelspoke card expanded" });
  await until(
    () => page.evaluate(() => document.body.innerText.includes("No providers yet")),
    { timeout: 20000, what: "modelspoke section (empty state)" },
  );
  return { context, page };
}

/** The modelspoke section's locators (pinned against dsh 0.1.1-rc.2). */
function ui(page) {
  return {
    addProvider: page.getByRole("button", { name: "+ Add provider" }),
    inputName: page.getByLabel("Provider name"),
    inputBaseUrl: page.getByLabel("Base URL"),
    next: page.getByRole("button", { name: "Next", exact: true }),
    // The row's li is the NEAREST li ancestor of its Edit button (the whole
    // section sits inside the plugin card's li — a li:has() match would hit
    // the card and read the first row's dot).
    row: (name) =>
      page.getByRole("button", { name: `Edit provider ${name}` }).locator("xpath=ancestor::li[1]"),
    rowDotAria: async (name) => {
      const dot = row(name).locator('span[role="img"]').first();
      return (await dot.getAttribute("aria-label")) ?? "";
    },
    // exact: the live catalog carries prefix-collision ids (…-dflash2, …-nothink)
    detail: (id) =>
      page.getByRole("button", { name: `Show details for ${id}`, exact: true }),
    contextWindow: (id) => page.getByLabel(`Context window for ${id}`, { exact: true }),
  };
}

async function typeInput(page, locator, value) {
  await locator.evaluate(
    (el, v) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    },
    value,
  );
}

async function main() {
  const dshVersion = execFileSync(DSH_BIN, ["--version"], { encoding: "utf8" }).trim();
  if (dshVersion !== DSH_VERSION) throw new Error(`dsh version mismatch: ${dshVersion}`);
  if (!existsSync(path.join(REPO_ROOT, "dist", "dsh", "index.js"))) {
    throw new Error("modelspoke is not built (dist/) — run the build first");
  }
  const chrome = findChrome();

  const catalog = await fetch(`${LLSWAP_URL}/models`).then((r) => r.json()).catch(() => null);
  if (!catalog?.data?.length) throw new Error(`llama-swap not reachable at ${LLSWAP_URL}`);
  // The detail shot: a model whose llama-swap metadata carries a
  // thinkingLevelMap (rich detail: context/maxTokens + thinking rows).
  const flagship =
    catalog.data.find((m) => m.meta?.llamaswap?.thinkingLevelMap)?.id ?? catalog.data[0].id;
  console.log(`live llama-swap: ${LLSWAP_URL} (${catalog.data.length} models); detail on ${flagship}`);

  const root = path.join(os.tmpdir(), `modelspoke-shots-${randomBytes(4).toString("hex")}`);
  mkdirSync(root, { recursive: true });
  const home = makeScratchHome(root);
  writeSettings(home, { "ui-onboarding": { welcomeNoticeVersion: "2026-08-13.1" } });
  const web = await bootDshWeb(root, home);
  console.log(`dsh web: ${web.url}`);

  const browser = await chromium.launch({ headless: true, executablePath: chrome });
  try {
    const s = await openModelspoke(browser, web.url);
    const u = ui(s.page);
    await u.addProvider.click();
    await until(() => u.inputName.count(), { what: "add-provider form" });
    await typeInput(s.page, u.inputName, PROVIDER_NAME);
    await typeInput(s.page, u.inputBaseUrl, LLSWAP_URL);
    await u.next.click();

    const row = u.row(PROVIDER_NAME);
    await until(async () => {
      const aria = await u.rowDotAria(PROVIDER_NAME);
      return /models · last checked/.test(aria);
    }, { timeout: 30000, what: "catalog fetch (green dot)" });
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
    await sleep(800);
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`fatal: ${err.message}`);
  process.exit(1);
});
