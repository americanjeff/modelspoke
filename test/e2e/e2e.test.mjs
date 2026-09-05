import { execFileSync, spawn } from "node:child_process";
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
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import * as YAML from "js-yaml";
import { chromium } from "playwright-core";

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const DSH_BIN = process.env.E2E_DSH || "dsh";
const LLSWAP_BIN = process.env.E2E_LLAMA_SWAP || "llama-swap";

// The e2e selectors ride on dsh's own web UI, so a dsh bump can break them
// silently — fail loud at the boundary (filestab's same guard).
const DSH_VERSION = "0.1.1-rc.2";

// The agent loop's system prompt opens with this — the discriminator for
// the MAIN turn's request in the fake backend's log (the session-title
// call carries a different, shorter system prompt).
const AGENT_PROMPT_MARK = "You are an AI agent";

let assertions = 0;
function ok(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
  assertions++;
}
function eq(actual, expected, msg) {
  ok(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}
function match(value, re, msg) {
  ok(
    typeof value === "string" && re.test(value),
    `${msg}: expected ${re} to match ${JSON.stringify(String(value).slice(0, 200))}`,
  );
}
function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until fn() is truthy or the timeout elapses. */
async function until(fn, { timeout = 20000, interval = 250, what = "condition" } = {}) {
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

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function deadPort() {
  // Residual race: the port can be claimed after the probe (the dsh web server draws from the same ephemeral pool) — the retry loop re-probes, so the window is one cycle.
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = await freePort();
    await sleep(50);
    const open = await new Promise((resolve) => {
      const sock = net.connect({ port, host: "127.0.0.1" });
      sock.on("connect", () => {
        sock.destroy();
        resolve(true);
      });
      sock.on("error", () => resolve(false));
    });
    if (!open) return port;
  }
  throw new Error("could not find a closed port for the dead-port journey");
}

/**
 * Probes a just-spawned llama-swap: "up" once /v1/models answers, "dead" if
 * the process exits first (the bind-failure signal), "pending" when the
 * window elapses (the caller then applies the full wait).
 */
async function probeStartup(baseUrl, proc, window = 8000) {
  const up = until(async () => (await fetch(`${baseUrl}/models`)).ok, {
    timeout: window,
    interval: 200,
    what: "fake llama-swap probe",
  })
    .then(() => "up")
    .catch(() => "pending");
  const dead = new Promise((resolve) => proc.once("exit", () => resolve("dead")));
  const windowElapsed = sleep(window).then(() => "pending");
  return Promise.race([up, dead, windowElapsed]);
}

function fakeLlamaSwapYaml({ startPort, logsDir }) {
  const fake = (model) =>
    `  ${model}:
    cmd: node ${path.join(REPO_ROOT, "test", "e2e", "fake-model-server.mjs")} \${PORT}
    env: ["LLS_FAKE_MODEL=${model}", "LLS_FAKE_LOG=${path.join(logsDir, `${model}.jsonl`)}"]
    ttl: 0
`;
  return `startPort: ${startPort}
healthCheckTimeout: 30
logToStdout: "proxy"
models:
${fake("fake-flagship")}    capabilities:
      in: [text, image]
      out: [text]
      tools: true
      context: 8192
    metadata:
      reasoning: true
      maxTokens: 2048
      thinkingLevelMap:
        off: "low"
        low: "low"
        medium: "medium"
        xhigh: "xhigh"
      compat:
        supportsDeveloperRole: false
        supportsReasoningEffort: false
        thinkingFormat: chat-template
        chatTemplateKwargs:
          enable_thinking:
            $var: thinking.enabled
          reasoning_effort:
            $var: thinking.effort
            omitWhenOff: true
          preserve_thinking: true
${fake("fake-text")}    capabilities:
      in: [text]
      out: [text]
      tools: true
      context: 4096
    metadata:
      maxTokens: 1024
${fake("fake-mini")}    capabilities:
      in: [text]
      out: [text]
`;
}

/** The fake backend's JSONL request log for one model (newest last). */
function readBackendLog(logsDir, model) {
  const file = path.join(logsDir, `${model}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/**
 * Spawn the real llama-swap against the fake backends; wait for /v1/models.
 * freePort→close→re-bind is a TOCTOU — the dsh web server draws from the same
 * ephemeral pool (--port 0) — so a stolen port makes llama-swap exit on bind;
 * probeStartup detects that and the loop retries once with a fresh port.
 */
async function startFakeSwap(root) {
  const logsDir = path.join(root, "backend-logs");
  mkdirSync(logsDir, { recursive: true });
  const logPath = path.join(root, "llama-swap.log");
  let proc;
  let listenPort;
  let baseUrl;
  let lsYaml;
  let logFd;
  for (let attempt = 1; attempt <= 2; attempt++) {
    listenPort = await freePort();
    const startPort = await freePort();
    lsYaml = path.join(root, "llama-swap.yaml");
    writeFileSync(lsYaml, fakeLlamaSwapYaml({ startPort, logsDir }));
    logFd = openSync(logPath, "a");
    proc = spawn(LLSWAP_BIN, ["--config", lsYaml, "--listen", `127.0.0.1:${listenPort}`], {
      stdio: ["ignore", logFd, logFd],
      detached: true,
    });
    proc.unref();
    baseUrl = `http://127.0.0.1:${listenPort}/v1`;
    const outcome = await probeStartup(baseUrl, proc);
    if (outcome !== "dead") break;
    try {
      process.kill(-proc.pid, "SIGTERM");
    } catch {
      try {
        proc.kill("SIGTERM");
      } catch {}
    }
    if (attempt === 1) {
      console.log(`  fake llama-swap exited on :${listenPort} before answering (port likely stolen in the freePort window) — retrying with a fresh port`);
      continue;
    }
    throw new Error(`fake llama-swap exited before /v1/models answered, twice (log: ${logPath})`);
  }
  await until(
    async () => (await fetch(`${baseUrl}/models`)).ok,
    { timeout: 30000, what: "fake llama-swap /v1/models" },
  );
  return {
    listenPort,
    baseUrl,
    lsYaml,
    logFd,
    stop: () => {
      try {
        process.kill(-proc.pid, "SIGTERM");
      } catch {
        try {
          proc.kill("SIGTERM");
        } catch {}
      }
    },
    /** The fake backend's JSONL request log for one model (newest last). */
    readBackendLog: (model) => readBackendLog(logsDir, model),
    mainTurnRequest: (model) => {
      const entries = readBackendLog(logsDir, model);
      const hits = entries.filter((e) =>
        JSON.stringify(e.body?.messages ?? []).includes(AGENT_PROMPT_MARK),
      );
      return hits.at(-1);
    },
  };
}

/**
 * The copied web profile's `link:` deps are relative symlinks that break on
 * copy; the loop below re-links each against its live target.
 */
function makeScratchHome(root) {
  const home = path.join(root, "home");
  mkdirSync(home, { recursive: true });

  // `--dump-config` auto-inits the headless profile (and the shared
  // profiles/node_modules tree) under this DSH_HOME.
  execFileSync(DSH_BIN, ["--profile", "headless", "--dump-config"], {
    env: { ...process.env, DSH_HOME: home },
    stdio: "ignore",
  });

  // Hand-made node_modules symlink instead of a pnpm link: no store write.
  const headlessPkg = path.join(home, "profiles", "headless", "package.json");
  const hpkg = JSON.parse(readFileSync(headlessPkg, "utf8"));
  hpkg.dependencies = { ...(hpkg.dependencies ?? {}), modelspoke: `link:${REPO_ROOT}` };
  hpkg.dsh = hpkg.dsh ?? {};
  hpkg.dsh.profile = hpkg.dsh.profile ?? {};
  const bundles = hpkg.dsh.profile.bundles ?? [];
  if (!bundles.includes("modelspoke")) bundles.push("modelspoke");
  hpkg.dsh.profile.bundles = bundles;
  writeFileSync(headlessPkg, JSON.stringify(hpkg, null, 2) + "\n");
  mkdirSync(path.join(home, "profiles", "headless", "node_modules"), { recursive: true });
  symlinkSync(REPO_ROOT, path.join(home, "profiles", "headless", "node_modules", "modelspoke"));

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

/**
 * One-shot headless boots have no other node-side sink, so the suite mounts
 * this throwaway plugin to capture structured log lines to GATE_SINK_FILE.
 */
function installLogSink(root) {
  const mjs = path.join(root, "gate-log-sink.mjs");
  writeFileSync(
    mjs,
    [
      'import { appendFileSync } from "node:fs";',
      'export const name = "gate-log-sink";',
      "export function apply(ctx) {",
      "  const file = process.env.GATE_SINK_FILE;",
      "  if (file === undefined || file.length === 0) return;",
      "  ctx.logger.exporter({",
      '    export: (m) => appendFileSync(file, `${m.name} ${m.type} ${m.args.join(" ")}\\n`),',
      "  });",
      "}",
      "",
    ].join("\n"),
  );
  const yml = path.join(root, "gate-log-sink.yml");
  writeFileSync(
    yml,
    `- insert:
  - id: gate-log-sink
    name: ${JSON.stringify(mjs)}
`,
  );
  return { yml };
}

async function bootDshWeb(root, home) {
  const logPath = path.join(root, "dsh-web.log");
  const fd = openSync(logPath, "a");
  const proc = spawn(DSH_BIN, ["web", "--host", "127.0.0.1", "--port", "0", "--no-open"], {
    env: {
      ...process.env,
      DSH_HOME: home,
      // The stock deepseek-official route validates its credential at boot;
      // a dummy keeps the boot alive — the e2e never calls deepseek.
      DEEPSEEK_API_KEY: "e2e-dummy",
    },
    stdio: ["ignore", fd, fd],
  });
  const url = await until(async () => {
    const m = readFileSync(logPath, "utf8").match(/dsh web: http:\/\/127\.0\.0\.1:(\d+)/);
    return m ? `http://127.0.0.1:${m[1]}` : undefined;
  }, { timeout: 60000, what: "dsh web URL banner" });
  return {
    url,
    logPath,
    stop: () => {
      try {
        proc.kill("SIGTERM");
      } catch {}
    },
  };
}

/**
 * One headless turn (E1): a fresh session, no resume. The scratch headless
 * profile carries modelspoke; $DSH_HOME isolates everything. When `sink` is
 * given, the logger sink overlay is mounted and the sink lines returned.
 */
function headlessTurn(root, home, task, { sink, env = {} } = {}) {
  const sinkFile = sink ? path.join(root, `sink-${randomBytes(3).toString("hex")}.log`) : undefined;
  const args = ["--profile", "headless"];
  if (sink) args.push("--patch", sink.yml);
  args.push(task);
  const out = execFileSync(DSH_BIN, args, {
    env: {
      ...process.env,
      DSH_HOME: home,
      DEEPSEEK_API_KEY: "e2e-dummy",
      ...(sinkFile ? { GATE_SINK_FILE: sinkFile } : {}),
      ...env,
    },
    encoding: "utf8",
    timeout: 120000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const sinkLines =
    sinkFile && existsSync(sinkFile)
      ? readFileSync(sinkFile, "utf8").split("\n").filter(Boolean)
      : [];
  return { out, sinkLines };
}

const settingsPath = (home) => path.join(home, "settings.yaml");
function writeSettings(home, doc) {
  writeFileSync(settingsPath(home), YAML.dump(doc, { lineWidth: -1 }));
}
function readSettings(home) {
  return YAML.load(readFileSync(settingsPath(home), "utf8")) ?? {};
}
function settingsText(home) {
  return readFileSync(settingsPath(home), "utf8");
}

function baseSettings() {
  return { "ui-onboarding": { welcomeNoticeVersion: "2026-08-13.1" } };
}

function handWrittenBlock(baseURL) {
  return {
    displayName: "llama-swap",
    apiKeyEnv: "LLAMA_SWAP_API_KEY",
    api: "openai-completions",
    baseURL,
    models: [
      {
        id: "fake-flagship",
        name: "Fake Flagship",
        contextWindow: 8192,
        maxTokens: 2048,
        // The J3 persona hand-mirrors the model's reasoning support from
        // llama-swap.yaml metadata; without it dsh core refuses ANY
        // explicit effort on the model (UNSUPPORTED_REASONING_EFFORT) and
        // the shadowed turn could never serve the default model's medium.
        reasoningEfforts: { low: "low", medium: "medium", xhigh: "xhigh" },
      },
    ],
  };
}

async function openModelspoke(browser, url) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("dialog", (d) => d.accept()); // window.confirm on provider delete
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
    () =>
      page.evaluate(() => {
        const text = document.body.innerText;
        return (
          text.includes("No providers yet") ||
          text.includes("modelspoke") && !!document.querySelector('[aria-label^="Edit provider"]')
        );
      }),
    { timeout: 20000, what: "modelspoke section content" },
  );
  return { context, page, pageErrors };
}

/** The modelspoke section's locators (pinned against dsh 0.1.1-rc.2). */
function ui(page) {
  // The row's li is the NEAREST li ancestor of its Edit button — a broader
  // `li:has(...)` also matches the Plugins-page plugin card (the whole
  // section sits inside one card li), whose first status dot belongs to
  // the FIRST row, not the one addressed.
  const row = (name) =>
    page.getByRole("button", { name: `Edit provider ${name}` }).locator("xpath=ancestor::li[1]");
  return {
    addProvider: page.getByRole("button", { name: "+ Add provider" }),
    emptyState: page.getByText("No providers yet"),
    row,
    rowDotAria: async (name) => {
      const dot = row(name).locator('span[role="img"]').first();
      return (await dot.getAttribute("aria-label")) ?? "";
    },
    edit: (name) => page.getByRole("button", { name: `Edit provider ${name}` }),
    del: (name) => page.getByRole("button", { name: `Delete provider ${name}` }),
    inputName: page.getByLabel("Provider name"),
    inputBaseUrl: page.getByLabel("Base URL"),
    inputKeyEnv: page.getByLabel("API key env var name"),
    next: page.getByRole("button", { name: "Next", exact: true }),
    apply: page.getByRole("button", { name: "Apply provider" }),
    cancel: page.getByRole("button", { name: "Cancel", exact: true }),
    addModel: page.getByRole("button", { name: "Add model" }),
    modelRow: (id) => page.locator("li", { has: page.getByRole("button", { name: `Remove model ${id}` }) }),
    modelIdInput: (id) => page.getByLabel(`Model wire id for ${id}`),
    removeModel: (id) => page.getByRole("button", { name: `Remove model ${id}` }),
    detail: (id) => page.getByRole("button", { name: `Show details for ${id}` }),
    detailOpen: (id) => page.getByRole("button", { name: `Hide details for ${id}` }),
    contextWindow: (id) => page.getByLabel(`Context window for ${id}`),
    maxTokens: (id) => page.getByLabel(`Max output tokens for ${id}`),
    imageInput: (id) => page.getByLabel(`Image input for ${id}`),
    reasoningEffort: (id) => page.getByLabel(`Reasoning effort for ${id}`),
    defaultEffort: (id) => page.getByLabel(`Default effort for ${id}`),
    thinkRow: (id, n) => page.getByLabel(`Thinking level for ${id} (row ${n})`),
    thinkAccepted: (harness, id) => page.getByLabel(`Accepted level for ${harness} of ${id}`),
    reset: (id) => page.getByRole("button", { name: `Reset ${id}` }),
    undoReset: (id) => page.getByRole("button", { name: `Undo reset for ${id}` }),
    catalogError: page.getByText("Couldn't reach the server — showing configured models only."),
    retry: page.getByRole("button", { name: "Retry", exact: true }),
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

async function j1_firstProvider(root, home, page, swap) {
  const u = ui(page);
  ok(await u.emptyState.count() > 0, "J1: empty state shows");
  ok(await u.addProvider.count() > 0, "J1: '+ Add provider' shows");

  await u.addProvider.click();
  await until(() => u.inputName.count(), { what: "add-provider form" });
  await typeInput(page, u.inputName, "fake-swap");
  await typeInput(page, u.inputBaseUrl, swap.baseUrl);
  await u.next.click();

  await until(() => u.edit("fake-swap").count(), { what: "fake-swap row" });
  await until(async () => /3 models · last checked \d{2}:\d{2}/.test(await u.rowDotAria("fake-swap")), {
    timeout: 30000,
    what: "catalog fetch (green dot)",
  });

  for (const id of ["fake-flagship", "fake-text", "fake-mini"]) {
    ok(await u.modelRow(id).count() > 0, `J1: catalog row for ${id}`);
    eq(await u.modelIdInput(id).inputValue(), id, `J1: row ${id} carries the wire id`);
  }

  // The flagship's detail: the DISCOVERY-tier values (from meta.llamaswap —
  // not from any user input).
  await u.detail("fake-flagship").click();
  await until(() => u.contextWindow("fake-flagship").count(), { what: "flagship detail" });
  eq(await u.contextWindow("fake-flagship").inputValue(), "8192", "J1: contextWindow from discovery (8192)");
  eq(await u.maxTokens("fake-flagship").inputValue(), "2048", "J1: maxTokens from discovery (2048)");
  ok(await u.imageInput("fake-flagship").isChecked(), "J1: image input checked (discovery)");
  ok(await u.reasoningEffort("fake-flagship").isChecked(), "J1: reasoning effort checked (discovery)");
  eq(await u.thinkRow("fake-flagship", 1).inputValue(), "off", "J1: think row 1 harness = off");
  eq(await u.thinkAccepted("off", "fake-flagship").inputValue(), "low", "J1: off → low");
  eq(await u.thinkRow("fake-flagship", 2).inputValue(), "low", "J1: think row 2 harness = low");
  eq(await u.thinkAccepted("low", "fake-flagship").inputValue(), "low", "J1: low → low");
  eq(await u.thinkRow("fake-flagship", 3).inputValue(), "medium", "J1: think row 3 harness = medium");
  eq(await u.thinkAccepted("medium", "fake-flagship").inputValue(), "medium", "J1: medium → medium");
  eq(await u.thinkRow("fake-flagship", 4).inputValue(), "xhigh", "J1: think row 4 harness = xhigh");
  eq(await u.thinkAccepted("xhigh", "fake-flagship").inputValue(), "xhigh", "J1: xhigh → xhigh");
  eq(await u.defaultEffort("fake-flagship").inputValue(), "", "J1: default effort starts at 'provider default'");

  await u.defaultEffort("fake-flagship").selectOption({ value: "medium" });
  await u.apply.click();
  await until(async () => {
    const route = readSettings(home).modelspoke?.routes?.find((r) => r.name === "fake-swap");
    return route?.models?.some((m) => m.id === "fake-flagship" && m.defaultEffort === "medium") === true;
  }, { timeout: 30000, what: "apply commit → settings.yaml" });

  const route = readSettings(home).modelspoke.routes.find((r) => r.name === "fake-swap");
  eq(route.baseURL, swap.baseUrl, "J1: route baseURL written as entered");
  ok(!route.apiKeyEnv, "J1: no key env written (the field was left empty)");
  eq(route.models.length, 3, "J1: the catalog materialized to an explicit 3-model list");
  for (const other of ["fake-text", "fake-mini"]) {
    const entry = route.models.find((m) => m.id === other);
    ok(!("defaultEffort" in entry), `J1: ${other} has no defaultEffort in YAML`);
  }
}

/**
 * J10 (a) — the zero-route boot hint. A headless boot whose `modelspoke:`
 * section carries zero routes logs EXACTLY ONE hint line; the default model
 * (a hand-written pi-ai block on the fake swap) keeps the boot + turn alive.
 */
async function j10_bootHint(root, home, swap) {
  const saved = readSettings(home);
  const doc = baseSettings();
  doc["llm-pi-ai"] = { providers: { "llama-swap": handWrittenBlock(swap.baseUrl) } };
  doc["agent-default-model"] = { provider: "llama-swap", model: "fake-flagship" };
  writeSettings(home, doc);
  const sink = installLogSink(root);
  const { out, sinkLines } = headlessTurn(root, home, "Reply with exactly the word: PONG", {
    sink,
    // The block declares apiKeyEnv; the llm-pi-ai route validates it at boot.
    env: { LLAMA_SWAP_API_KEY: "e2e-dummy" },
  });
  ok(out.includes("PONG"), "J10: the zero-route boot still serves (hand-written block)");
  const hints = sinkLines.filter((l) => l.includes("modelspoke: active with 0 providers"));
  eq(hints.length, 1, "J10: the zero-route boot hint fires exactly once");
  writeSettings(home, saved);
}

/**
 * J5 (wire) — per-effort wire shape on the fake backend's request log: the
 * $var chatTemplateKwargs resolve per the flagship's thinkingLevelMap
 * (off→low, low→low, medium→medium, xhigh→xhigh). The `off` key makes off
 * selectable; its value is never sent (omitWhenOff).
 */
async function j5_wireLadder(root, home, swap) {
  const base = readSettings(home);
  const cases = [
    { effort: "off", think: false, wire: undefined },
    { effort: "low", think: true, wire: "low" },
    { effort: "medium", think: true, wire: "medium" },
    { effort: "xhigh", think: true, wire: "xhigh" },
  ];
  for (const c of cases) {
    const doc = { ...base };
    doc["agent-default-model"] = {
      provider: "fake-swap",
      model: "fake-flagship",
      reasoningEffort: c.effort,
    };
    writeSettings(home, doc);
    const before = swap.readBackendLog("fake-flagship").length;
    const { out } = headlessTurn(root, home, "Reply with exactly the word: PONG");
    ok(out.includes("PONG"), `J5(${c.effort}): headless turn got the fake's PONG`);
    const req = swap.mainTurnRequest("fake-flagship");
    ok(req !== undefined && swap.readBackendLog("fake-flagship").length > before, `J5(${c.effort}): the fake backend saw the turn`);
    eq(req.body.model, "fake-flagship", `J5(${c.effort}): wire model id`);
    const kwargs = req.body.chat_template_kwargs ?? {};
    eq(kwargs.enable_thinking, c.think, `J5(${c.effort}): enable_thinking === ${c.think}`);
    eq(kwargs.reasoning_effort, c.wire, `J5(${c.effort}): reasoning_effort wire shape`);
    eq(kwargs.preserve_thinking, true, `J5(${c.effort}): preserve_thinking passthrough`);
    match(req.headers["user-agent"] ?? "", /^deepseek-harness\/\d/, `J5(${c.effort}): the attribution user-agent rides the request`);
  }
}

/**
 * Open the provider card if it isn't already — Edit TOGGLES (Apply keeps
 * the card open, Cancel closes it), so every step normalizes state first.
 * "Add model" exists only on the expanded card.
 */
async function ensureCardOpen(page, u, name) {
  if ((await u.addModel.count()) === 0) await u.edit(name).click();
  try {
    await until(async () => (await u.addModel.count()) > 0, { what: `card open (${name})` });
  } catch (err) {
    const dump = await page.evaluate(() =>
      [...document.querySelectorAll("button")]
        .map((b) => `${(b.textContent || "").trim().slice(0, 40)}|aria=${b.getAttribute("aria-label")}|dis=${b.disabled}`)
        .join("\n"),
    );
    const html = await page.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find(
        (x) => (x.textContent || "").trim() === "Add model",
      );
      return b ? b.outerHTML.slice(0, 400) : "(no button with text 'Add model')";
    });
    const c1 = await page.getByRole("button", { name: "Add model" }).count();
    throw new Error(
      `${err.message}\n--- addModel.count()=${c1}\n--- Add model html: ${html}\n--- button dump ---\n${dump}`,
    );
  }
}

async function j4_curation(home, page) {
  const u = ui(page);
  const name = "fake-swap";
  // A fresh context lands on the section with the card collapsed.
  await until(() => u.edit(name).count(), { what: "fake-swap row" });

  const shaBefore = sha256(settingsText(home));

  await ensureCardOpen(page, u, name);
  await u.detail("fake-flagship").click();
  await until(() => u.contextWindow("fake-flagship").count(), { what: "detail" });
  await typeInput(page, u.contextWindow("fake-flagship"), "12345");
  await page.waitForTimeout(300);
  await u.cancel.click();
  await page.waitForTimeout(500);
  eq(sha256(settingsText(home)), shaBefore, "J4: cancel leaves settings.yaml byte-identical");

  await ensureCardOpen(page, u, name); // the card closed on cancel
  await until(() => u.modelRow("fake-mini").count(), { what: "the fake-mini row" });
  await u.removeModel("fake-mini").click();
  await u.apply.click();
  await until(async () => {
    const r = readSettings(home).modelspoke?.routes?.find((x) => x.name === name);
    return Array.isArray(r?.models) && r.models.length === 2;
  }, { timeout: 30000, what: "YAML allow-list = 2 models" });
  let route = readSettings(home).modelspoke.routes.find((r) => r.name === name);
  eq(route.models.map((m) => m.id).sort(), ["fake-flagship", "fake-text"], "J4: allow-list = the other two ids");

  // Enter selects the filtered row; the name auto-fills.
  await ensureCardOpen(page, u, name);
  await u.addModel.click();
  const newIdInput = page.locator('input[aria-label^="Model wire id for"]').last();
  await until(() => newIdInput.count(), { what: "the added row's id input" });
  await typeInput(page, newIdInput, "fake-mini");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  await u.apply.click();
  await until(async () => {
    const r = readSettings(home).modelspoke?.routes?.find((x) => x.name === name);
    return Array.isArray(r?.models) && r.models.length === 3;
  }, { timeout: 30000, what: "YAML allow-list = 3 models again" });
  route = readSettings(home).modelspoke.routes.find((r) => r.name === name);
  eq(
    route.models.map((m) => m.id).sort(),
    ["fake-flagship", "fake-mini", "fake-text"],
    "J4: the added model is back on the list",
  );

  await u.detail("fake-flagship").click();
  await until(() => u.contextWindow("fake-flagship").count(), { what: "detail (edit)" });
  await typeInput(page, u.contextWindow("fake-flagship"), "9000");
  await u.apply.click();
  await until(async () => {
    const r = readSettings(home).modelspoke?.routes?.find((x) => x.name === name);
    return r?.models?.find((m) => m.id === "fake-flagship")?.contextWindow === 9000;
  }, { timeout: 30000, what: "YAML contextWindow = 9000" });
  let entry = readSettings(home).modelspoke.routes.find((r) => r.name === name).models.find((m) => m.id === "fake-flagship");
  // Commit rewrites the entry as the EFFECTIVE (committed ∪ discovered)
  // snapshot (client.tsx effectiveBaselineOf); the $var compat block is never copied from discovery.
  eq(entry.maxTokens, 2048, "J4: the effective maxTokens materializes into the entry (effective-snapshot commit)");
  eq(entry.thinkingLevelMap, { off: "low", low: "low", medium: "medium", xhigh: "xhigh" }, "J4: the effective thinking map materializes");
  ok(entry.input?.includes("image") === true, "J4: the effective image input materializes");
  ok(!("compat" in entry), "J4: the deep $var compat block stays discovered (never copied from discovery)");
  eq(entry.defaultEffort, "medium", "J4: the committed defaultEffort survives the edit");

  // Re-open the detail if the last Apply collapsed it.
  const showDetails = u.detail("fake-flagship");
  if ((await showDetails.count()) > 0) await showDetails.click();
  await until(async () => (await u.detailOpen("fake-flagship").count()) > 0, { what: "flagship detail open for reset" });
  ok(await u.reset("fake-flagship").count() > 0, "J4: reset offers for a configured model");
  await u.reset("fake-flagship").click();
  await until(() => u.undoReset("fake-flagship").count(), { what: "reset armed" });
  await u.apply.click();
  await until(async () => {
    const r = readSettings(home).modelspoke?.routes?.find((x) => x.name === name);
    const e = r?.models?.find((m) => m.id === "fake-flagship");
    return e !== undefined && !("contextWindow" in e) && !("defaultEffort" in e);
  }, { timeout: 30000, what: "YAML flagship entry back to identity-only" });
}

/**
 * J10 (b) — a dead port: the row's red dot + the card's one-line error +
 * Retry, and the failed fetch writes nothing to settings.yaml.
 */
async function j10_deadPort(home, page) {
  const u = ui(page);
  const port = await deadPort();
  // The previous phase's card may still be open; Add provider is disabled
  // while a card is open, so close it (Edit toggles).
  if ((await u.addModel.count()) > 0) {
    await u.edit("fake-swap").click();
    await until(async () => (await u.addModel.count()) === 0, { what: "card closed" });
  }
  await u.addProvider.click();
  await until(() => u.inputName.count(), { what: "add-provider form (dead)" });
  await typeInput(page, u.inputName, "dead");
  await typeInput(page, u.inputBaseUrl, `http://127.0.0.1:${port}/v1`);
  await u.next.click();
  await until(() => u.edit("dead").count(), { what: "dead provider row" });
  await until(async () => /Server unreachable \(connection refused\) · \d{2}:\d{2}/.test(await u.rowDotAria("dead")), {
    timeout: 30000,
    what: "dead-port red dot",
  });
  ok(await u.catalogError.count() > 0, "J10: the card shows the one-line catalog error");
  ok(await u.retry.count() > 0, "J10: Retry is present");
  const doc = readSettings(home);
  const dead = doc.modelspoke.routes.find((r) => r.name === "dead");
  ok(dead !== undefined, "J10: the dead route exists (the Add committed)");
  ok(!("models" in dead), "J10: the failed fetch wrote no models list");
  ok(doc.modelspoke.routes.some((r) => r.name === "fake-swap"), "J10: the live route untouched");
  await u.del("dead").click();
  await until(async () => (await u.edit("dead").count()) === 0, { what: "dead provider deleted" });
  ok(readSettings(home).modelspoke.routes.every((r) => r.name !== "dead"), "J10: the dead route is gone from YAML");
}


/**
 * J11 — live-provider discovery against REAL local servers (catalog only,
 * zero inference). Each candidate is probed from this process first; an
 * unreachable candidate is SKIPPED (logged, not failed) so the suite stays
 * green on a machine without the server. A reachable candidate gets a
 * temporary modelspoke route through the real UI: discovery must settle to
 * the green dot "N model(s) · last checked HH:MM" with N ≥ 1, and the card
 * must list exactly N model rows. The route is deleted again afterwards so
 * the scratch home ends in its pre-J11 state.
 *
 * The ports are this machine's conventions (edit freely); the skip-on-probe
 * is what keeps the journey portable. Four candidates are standing machine
 * servers; the other two (live-lmstudio, live-vllm) are TEST-ONLY disposable
 * servers managed by ./live-providers.sh in this directory (up/down/status).
 */
const LIVE_CANDIDATES = [
  // probe = the endpoint that backend's detection actually needs to answer.
  { name: "live-ollama", baseURL: "http://127.0.0.1:11434/v1", probe: "http://127.0.0.1:11434/api/version" },
  { name: "live-llama-swap", baseURL: "http://127.0.0.1:8080/v1", probe: "http://127.0.0.1:8080/v1/models" },
  { name: "live-sglang", baseURL: "http://127.0.0.1:8888/v1", probe: "http://127.0.0.1:8888/v1/models" },
  { name: "live-llamacpp", baseURL: "http://127.0.0.1:25000/v1", probe: "http://127.0.0.1:25000/v1/models" },
  { name: "live-lmstudio", baseURL: "http://127.0.0.1:1234/v1", probe: "http://127.0.0.1:1234/v1/models" },
  { name: "live-vllm", baseURL: "http://127.0.0.1:8000/v1", probe: "http://127.0.0.1:8000/v1/models" },
];

/** True when the probe URL answers at all (any status = a live server). */
async function probeReachable(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return res.status > 0;
  } catch {
    return false;
  }
}

async function j11_liveDiscovery(page) {
  const u = ui(page);
  let found = 0;
  const skipped = [];
  for (const c of LIVE_CANDIDATES) {
    if (!(await probeReachable(c.probe))) {
      skipped.push(c.name);
      console.log(`  J11: skip ${c.name} (unreachable: ${c.probe})`);
      continue;
    }
    // + Add provider is disabled while a card is open — the previous
    // candidate's route was deleted (below), so no card can be open here.
    await u.addProvider.click();
    await until(() => u.inputName.count(), { what: `${c.name}: add-provider form` });
    await typeInput(page, u.inputName, c.name);
    await typeInput(page, u.inputBaseUrl, c.baseURL);
    await u.next.click();
    await until(() => u.edit(c.name).count(), { what: `${c.name}: provider row` });

    // Wait for discovery to SETTLE: the green dot "N model(s) · last
    // checked HH:MM", or a failure dot (the server died mid-run → skip,
    // not fail — the probe just said it was up a moment ago).
    let n = -1;
    let failed = false;
    for (let i = 0; i < 45 && n < 0 && !failed; i++) {
      const aria = await u.rowDotAria(c.name);
      const m = aria.match(/(\d+) models? · last checked \d{2}:\d{2}/);
      if (m) n = Number(m[1]);
      else if (/unreachable|Bad Request|failed|error/i.test(aria)) failed = true;
      else await sleep(1000);
    }
    if (n < 0 || failed) {
      skipped.push(c.name);
      console.log(`  J11: skip ${c.name} (discovery did not settle${failed ? " — dot reported an error" : ""})`);
      await u.del(c.name).click();
      await until(async () => (await u.edit(c.name).count()) === 0, { what: `${c.name}: row removed` });
      continue;
    }
    found++;
    ok(n >= 1, `J11: ${c.name} discovery reports ${n} model(s)`);
    // Count the per-row buttons, not the rows: only this card is open, so
    // every "Remove model" button is a row of the live provider — and an
    // `li:has(...)` count would over-count the card li wrapping the rows.
    const rows = await page.getByRole("button", { name: /^Remove model / }).count();
    eq(rows, n, `J11: ${c.name} card lists ${n} model row(s)`);
    await u.del(c.name).click();
    await until(async () => (await u.edit(c.name).count()) === 0, { what: `${c.name}: row removed` });
  }
  console.log(`  J11: ${found} live provider(s) discovered, ${skipped.length} skipped${skipped.length ? ` (${skipped.join(", ")})` : ""}`);
  // On a machine with none of the servers up, this is an all-skip no-op —
  // still green. The value is the reachable candidates.
  ok(true, `J11: live discovery sweep (${found} ok, ${skipped.length} skipped)`);
}

async function main() {
  const dshVersion = execFileSync(DSH_BIN, ["--version"], { encoding: "utf8" }).trim();
  eq(dshVersion, DSH_VERSION, "the dsh version pin (the e2e selectors ride on it)");
  const llswapVersion = execFileSync(LLSWAP_BIN, ["--version"], { encoding: "utf8" }).trim();
  ok(llswapVersion.length > 0, "llama-swap --version");
  const chrome = findChrome();
  ok(existsSync(chrome), "the chromium executable exists");
  ok(existsSync(path.join(REPO_ROOT, "dist", "dsh", "index.js")), "modelspoke is built (dist/)");

  const root = path.join(os.tmpdir(), `modelspoke-e2e-${randomBytes(4).toString("hex")}`);
  mkdirSync(root, { recursive: true });
  console.log(`e2e root: ${root}`);

  const swap = await startFakeSwap(root);
  console.log(`fake llama-swap: ${swap.baseUrl}`);

  const home = makeScratchHome(root);
  const web = await bootDshWeb(root, home);
  console.log(`dsh web: ${web.url}`);

  writeSettings(home, baseSettings());

  const browser = await chromium.launch({ headless: true, executablePath: chrome });
  let pass = true;
  let failurePage = null;
  try {
    let s = await openModelspoke(browser, web.url);
    console.log("── J1: fresh install → first provider");
    await j1_firstProvider(root, home, s.page, swap);
    await s.context.close();

    console.log("── J10: zero-route boot hint (headless)");
    await j10_bootHint(root, home, swap);

    console.log("── J5: per-effort wire shape (headless)");
    await j5_wireLadder(root, home, swap);

    s = await openModelspoke(browser, web.url);
    console.log("── J4: provider card curation");
    await j4_curation(home, s.page);
    console.log("── J10: dead port");
    await j10_deadPort(home, s.page);
    await s.context.close();

    console.log("── J11: live-provider discovery (catalog only, skip if unreachable)");
    s = await openModelspoke(browser, web.url);
    await j11_liveDiscovery(s.page);
    await s.context.close();

    ok(true, "all journeys completed");
  } catch (err) {
    pass = false;
    const shot = path.join(REPO_ROOT, "e2e-failure.png");
    try {
      const pages = browser.contexts().flatMap((c) => c.pages());
      const page = pages.at(-1);
      if (page) await page.screenshot({ path: shot, fullPage: true });
    } catch {}
    console.error(`\nFAIL after ${assertions} assertions: ${err.message}`);
    console.error(String(err.stack ?? "").split("\n").slice(0, 12).join("\n"));
    if (existsSync(shot)) console.error(`failure screenshot: ${shot}`);
    for (const name of ["settings.yaml"]) {
      const p = path.join(home, name);
      if (existsSync(p)) console.error(`\n--- ${name} (at failure) ---\n${readFileSync(p, "utf8")}`);
    }
    for (const log of [web.logPath, path.join(root, "llama-swap.log")]) {
      if (existsSync(log)) console.error(`\n--- ${path.basename(log)} (tail) ---\n${readFileSync(log, "utf8").split("\n").slice(-40).join("\n")}`);
    }
    process.exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
    web.stop();
    swap.stop();
    await sleep(800);
    if (pass) rmSync(root, { recursive: true, force: true });
    else console.error(`scratch root kept for inspection: ${root}`);
  }

  if (pass) console.log(`\npass — ${assertions} assertions, all green`);
}

main().catch((err) => {
  console.error(`fatal: ${err.message}`);
  console.error(String(err.stack ?? "").split("\n").slice(0, 12).join("\n"));
  process.exit(1);
});
