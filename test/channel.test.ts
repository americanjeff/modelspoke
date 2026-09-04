import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { Context } from "@deepseek-ai/cordis";
import { settingsNamespace, SettingsConflictError } from "@deepseek-ai/dsh-settings";
import {
  BUILTIN_PI_AI_PROVIDER_NAMES,
  computeOnboardingFacts,
  discoverMetadataRow,
  installModelspokeChannel,
  isLocalBaseUrl,
  keySourceOf,
  makeChannelHandler,
  offeredProviders,
  registrableProviderNames,
} from "../src/dsh/channel.js";
import { ollamaBackend } from "../src/discovery/ollama.js";

const LLM_PI_AI = {
  providers: {
    "llama-swap": {
      displayName: "llama-swap",
      apiKeyEnv: "LLAMA_SWAP_API_KEY",
      api: "openai-completions",
      baseURL: "http://127.0.0.1:8080/v1",
      reasoning: "medium",
    },
  },
};

const sectionWith = (routes: unknown[], overrides: Record<string, unknown> = {}) => ({
  routes,
  overrides,
});

describe("computeOnboardingFacts", () => {
  const noRoutes = sectionWith([]);
  const oneRoute = sectionWith([{ name: "spoke", baseURL: "http://127.0.0.1:1/v1" }]);

  it("is not ready while the section has no routes", () => {
    expect(computeOnboardingFacts(noRoutes)).toEqual({ ready: false });
  });

  it("is ready when the section has a route", () => {
    expect(computeOnboardingFacts(oneRoute)).toEqual({ ready: true });
  });
});

const fakeCredentials = (source: string | undefined) => ({
  resolve: async (_ref: string) =>
    source === undefined ? undefined : { value: "secret", source },
});

describe("isLocalBaseUrl (the local-only offer filter)", () => {
  it("admits every loopback host spelling a WHATWG URL can carry", () => {
    expect(isLocalBaseUrl("http://127.0.0.1:8080/v1")).toBe(true);
    expect(isLocalBaseUrl("http://localhost:11434/v1")).toBe(true);
    expect(isLocalBaseUrl("http://[::1]:8080/v1")).toBe(true);
  });

  it("refuses remote hosts", () => {
    expect(isLocalBaseUrl("https://api.example.com/v1")).toBe(false);
    expect(isLocalBaseUrl("http://192.168.1.5:8080/v1")).toBe(false);
  });

  it("treats unparseable, empty, and missing values as non-local", () => {
    expect(isLocalBaseUrl("not a url")).toBe(false);
    expect(isLocalBaseUrl("")).toBe(false);
    expect(isLocalBaseUrl(undefined)).toBe(false);
    expect(isLocalBaseUrl(42)).toBe(false);
  });
});

describe("keySourceOf (the R5 credential-ref impedance)", () => {
  it("maps apiKeyEnv to env when no credentials service is mounted (the optimistic read)", async () => {
    await expect(keySourceOf({ apiKeyEnv: "K" }, undefined)).resolves.toEqual({
      kind: "env",
      envVar: "K",
    });
  });

  it("keeps env when the value resolves from the inherited environment layer", async () => {
    await expect(keySourceOf({ apiKeyEnv: "K" }, fakeCredentials("env"))).resolves.toEqual({
      kind: "env",
      envVar: "K",
    });
  });

  it("reports stored when the value sits in the credentials file store", async () => {
    await expect(keySourceOf({ apiKeyEnv: "K" }, fakeCredentials("file"))).resolves.toEqual({
      kind: "stored",
    });
  });

  it("reports stored for the .env fallback layers (modelspoke reads process.env only)", async () => {
    await expect(keySourceOf({ apiKeyEnv: "K" }, fakeCredentials("project-env"))).resolves.toEqual({
      kind: "stored",
    });
    await expect(keySourceOf({ apiKeyEnv: "K" }, fakeCredentials("user-env"))).resolves.toEqual({
      kind: "stored",
    });
  });

  it("stays env when the ref resolves nowhere (declared intent is env-sourced)", async () => {
    await expect(keySourceOf({ apiKeyEnv: "K" }, fakeCredentials(undefined))).resolves.toEqual({
      kind: "env",
      envVar: "K",
    });
  });

  it("stays env for a name outside the credential-ref grammar (nothing could be stored under it)", async () => {
    await expect(keySourceOf({ apiKeyEnv: "1BAD" }, fakeCredentials("file"))).resolves.toEqual({
      kind: "env",
      envVar: "1BAD",
    });
  });

  it("treats a throwing resolve as unresolvable (env, not an error)", async () => {
    const throwing = { resolve: async () => {
      throw new Error("boom");
    } };
    await expect(keySourceOf({ apiKeyEnv: "K" }, throwing)).resolves.toEqual({
      kind: "env",
      envVar: "K",
    });
  });

  it("reports stored for a literal apiKey value field (forward-compatible)", async () => {
    await expect(keySourceOf({ apiKey: "sk-abc" }, undefined)).resolves.toEqual({ kind: "stored" });
  });

  it("lets apiKeyEnv win over apiKey when both are present (the schema precedence)", async () => {
    await expect(keySourceOf({ apiKeyEnv: "K", apiKey: "sk-abc" }, undefined)).resolves.toEqual({
      kind: "env",
      envVar: "K",
    });
  });

  it("reports none when the entry names no key at all", async () => {
    await expect(keySourceOf({ displayName: "x", baseURL: "http://127.0.0.1:1/v1" }, undefined))
      .resolves.toEqual({ kind: "none" });
  });
});

describe("offeredProviders (the local-only offer candidates)", () => {
  const section = {
    providers: {
      local: { displayName: "local", apiKeyEnv: "K", baseURL: "http://127.0.0.1:8080/v1" },
      loopback: { baseURL: "http://localhost:11434/v1" },
      remote: { apiKeyEnv: "R", baseURL: "https://api.example.com/v1" },
      unparseable: { baseURL: "not a url" },
      noUrl: { displayName: "no-url" },
      notAnObject: 42,
    },
  };

  it("offers only the local entries, in configuration order, with their key sources", async () => {
    await expect(offeredProviders(section, undefined)).resolves.toEqual([
      { name: "local", baseURL: "http://127.0.0.1:8080/v1", keySource: { kind: "env", envVar: "K" } },
      { name: "loopback", baseURL: "http://localhost:11434/v1", keySource: { kind: "none" } },
    ]);
  });

  it("degrades to empty (never throws) for a missing/malformed section", async () => {
    await expect(offeredProviders(undefined, undefined)).resolves.toEqual([]);
    await expect(offeredProviders({ providers: "nope" }, undefined)).resolves.toEqual([]);
    await expect(offeredProviders({ noProviders: true }, undefined)).resolves.toEqual([]);
  });
});

describe("registrableProviderNames (the collision set)", () => {
  it("unions pi-ai keys (local or not) ∪ route names ∪ built-ins, deduplicated in input order", () => {
    expect(
      registrableProviderNames(["ollama", "deepseek"], ["spoke-live", "deepseek"], ["deepseek", "openai"]),
    ).toEqual(["ollama", "deepseek", "spoke-live", "openai"]);
  });

  it("defaults the built-in set to the distro's catalog", () => {
    const names = registrableProviderNames(["ollama"], []);
    expect(names).toEqual(["ollama", ...BUILTIN_PI_AI_PROVIDER_NAMES]);
  });

  it("filters blank names", () => {
    expect(registrableProviderNames(["", "a"], ["b"], [])).toEqual(["a", "b"]);
  });
});

function fakeSettings(opts: {
  llmPiAi?: unknown;
  section?: unknown;
  revision?: number;
  replace?: (ns: string, section: object, expectedRevision?: number) => Promise<void>;
}) {
  const writes: Array<{ ns: string; section: object; expectedRevision?: number }> = [];
  const replace =
    opts.replace ??
    ((ns: string, section: object, expectedRevision?: number) => {
      writes.push({ ns, section, expectedRevision });
      return Promise.resolve();
    });
  const provider = {
    get(ns: string): unknown {
      if (ns === settingsNamespace("llm-pi-ai")) return opts.llmPiAi;
      return undefined;
    },
    describe() {
      return [{ ns: settingsNamespace("modelspoke"), revision: opts.revision ?? 7 }];
    },
    replace(ns: string, section: object, expectedRevision?: number) {
      return replace(ns, section, expectedRevision);
    },
  };
  return { provider: provider as never, writes };
}

function fakeCtx(services: Record<string, unknown>) {
  const listeners: Array<{ name: string; fn: (...args: unknown[]) => unknown; options?: unknown }> =
    [];
  const ctx = {
    get: (name: string) => services[name],
    on: (name: string, fn: (...args: unknown[]) => unknown, options?: unknown) => {
      listeners.push({ name, fn, options });
      return () => undefined;
    },
  };
  return { ctx: ctx as unknown as Context, listeners, services };
}

const handlerCtx = (provider: unknown) =>
  fakeCtx({ settings: provider }).ctx;

describe("channel handler (fake settings seam)", () => {
  it("onboarding reports the readiness facts + the v2 offer set", async () => {
    const { provider } = fakeSettings({ llmPiAi: LLM_PI_AI });
    const handler = makeChannelHandler(handlerCtx(provider), {
      section: () => sectionWith([]),
      log: () => undefined,
    });
    const result = await handler("onboarding", {}, new AbortController().signal);
    expect(result).toEqual({
      ok: true,
      value: {
        ready: false,
        providers: [
          {
            name: "llama-swap",
            baseURL: "http://127.0.0.1:8080/v1",
            keySource: { kind: "env", envVar: "LLAMA_SWAP_API_KEY" },
          },
        ],
        providerNames: ["llama-swap", ...BUILTIN_PI_AI_PROVIDER_NAMES],
      },
    });
  });

  it("onboarding filters offers to local providers and carries the full name set (incl. non-local keys)", async () => {
    const llm = {
      providers: {
        local: { apiKeyEnv: "K", baseURL: "http://127.0.0.1:8080/v1" },
        remote: { apiKeyEnv: "R", baseURL: "https://api.example.com/v1" },
        unparseable: { baseURL: "not a url" },
        noUrl: { displayName: "no-url" },
      },
    };
    const { provider } = fakeSettings({ llmPiAi: llm });
    const handler = makeChannelHandler(handlerCtx(provider), {
      section: () => sectionWith([{ name: "spoke-live", baseURL: "http://127.0.0.1:8080/v1" }]),
      log: () => undefined,
    });
    const result = (await handler("onboarding", {}, new AbortController().signal)) as {
      ok: boolean;
      value?: Record<string, unknown>;
    };
    expect(result.ok).toBe(true);
    expect(result.value?.ready).toBe(true);
    expect(result.value?.providers).toEqual([
      { name: "local", baseURL: "http://127.0.0.1:8080/v1", keySource: { kind: "env", envVar: "K" } },
    ]);
    expect(result.value?.providerNames).toEqual([
      "local",
      "remote",
      "unparseable",
      "noUrl",
      "spoke-live",
      ...BUILTIN_PI_AI_PROVIDER_NAMES,
    ]);
  });

  it("onboarding classifies a stored-key candidate as stored (credentials service mounted)", async () => {
    const { provider } = fakeSettings({ llmPiAi: LLM_PI_AI });
    const ctx = fakeCtx({ settings: provider, credentials: fakeCredentials("file") }).ctx;
    const handler = makeChannelHandler(ctx, {
      section: () => sectionWith([]),
      log: () => undefined,
    });
    const result = (await handler("onboarding", {}, new AbortController().signal)) as {
      ok: boolean;
      value?: { providers?: Array<{ keySource: unknown }> };
    };
    expect(result.ok).toBe(true);
    expect(result.value?.providers).toEqual([
      {
        name: "llama-swap",
        baseURL: "http://127.0.0.1:8080/v1",
        keySource: { kind: "stored" },
      },
    ]);
  });

  it("answers an unknown endpoint with bad-request", async () => {
    const { provider } = fakeSettings({ llmPiAi: LLM_PI_AI });
    const handler = makeChannelHandler(handlerCtx(provider), {
      section: () => sectionWith([]),
      log: () => undefined,
    });
    const result = (await handler("bogusEndpoint", {}, new AbortController().signal)) as {
      ok: boolean;
      error?: { code: string };
    };
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("bad-request");
  });
});

const SIGNAL = new AbortController().signal;

const PROVISION_SECTION = sectionWith(
  [{ name: "spoke-live", baseURL: "http://127.0.0.1:8080/v1", apiKeyEnv: "LLAMA_SWAP_API_KEY" }],
  { "qwen3.8-27b-6000pro": { name: "qwen3.8-27b", contextWindow: 262144 } },
);

const provisionHandler = (provider: unknown, section: unknown = PROVISION_SECTION) =>
  makeChannelHandler(handlerCtx(provider), {
    section: () => section,
    log: () => undefined,
  });

describe("provision (custom-provider import)", () => {
  it("adds the route (normalized baseURL + apiKeyEnv), preserves the current routes and overrides, fenced on the revision", async () => {
    const { provider, writes } = fakeSettings({ llmPiAi: LLM_PI_AI, revision: 9 });
    const handler = provisionHandler(provider);
    const result = (await handler(
      "provision",
      { name: "modelspoke-demo-local", baseURL: "http://127.0.0.1:8080/v1", apiKeyEnv: "LLAMA_SWAP_API_KEY" },
      SIGNAL,
    )) as { ok: boolean; value?: Record<string, unknown>; error?: { code: string } };
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ added: 1 });
    expect(writes).toHaveLength(1);
    expect(writes[0].ns).toBe(settingsNamespace("modelspoke"));
    expect(writes[0].expectedRevision).toBe(9);
    expect(writes[0].section).toEqual({
      routes: [
        { name: "spoke-live", baseURL: "http://127.0.0.1:8080/v1", apiKeyEnv: "LLAMA_SWAP_API_KEY" },
        { name: "modelspoke-demo-local", baseURL: "http://127.0.0.1:8080/v1", apiKeyEnv: "LLAMA_SWAP_API_KEY" },
      ],
      overrides: { "qwen3.8-27b-6000pro": { name: "qwen3.8-27b", contextWindow: 262144 } },
    });
  });

  it("carries renderReadImages: false through the provisioned write (the read_image mirror)", async () => {
    const { provider, writes } = fakeSettings({ llmPiAi: LLM_PI_AI, revision: 9 });
    const handler = provisionHandler(provider, { ...PROVISION_SECTION, renderReadImages: false });
    const result = (await handler(
      "provision",
      { name: "spoke-x", baseURL: "http://127.0.0.1:1/v1" },
      SIGNAL,
    )) as { ok: boolean };
    expect(result.ok).toBe(true);
    expect(writes).toHaveLength(1);
    expect((writes[0].section as { renderReadImages?: boolean }).renderReadImages).toBe(false);
  });

  it("omits renderReadImages from the provisioned write when the section has none (absent stays absent)", async () => {
    const { provider, writes } = fakeSettings({ llmPiAi: LLM_PI_AI, revision: 9 });
    const handler = provisionHandler(provider);
    const result = (await handler(
      "provision",
      { name: "spoke-x", baseURL: "http://127.0.0.1:1/v1" },
      SIGNAL,
    )) as { ok: boolean };
    expect(result.ok).toBe(true);
    expect("renderReadImages" in (writes[0].section as object)).toBe(false);
  });

  it("first-write-folds: a provision over a zero-route legacy section folds everything into the new route", async () => {
    const { provider, writes } = fakeSettings({ llmPiAi: LLM_PI_AI, revision: 4 });
    const handler = makeChannelHandler(handlerCtx(provider), {
      section: () =>
        sectionWith([], { "legacy-model-1": { contextWindow: 111 }, "legacy-model-2": { maxTokens: 222 } }),
      log: () => undefined,
    });
    const result = (await handler(
      "provision",
      { name: "spoke-new", baseURL: "http://127.0.0.1:8080/v1" },
      SIGNAL,
    )) as { ok: boolean; value?: Record<string, unknown> };
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ added: 1 });
    const section = writes[0].section as { routes: unknown[]; overrides?: Record<string, unknown> };
    expect(section.overrides).toBeUndefined();
    expect(section.routes).toHaveLength(1);
    const route = section.routes[0] as Record<string, unknown>;
    expect(route.name).toBe("spoke-new");
    expect(route.overrides).toEqual({
      "legacy-model-1": { contextWindow: 111 },
      "legacy-model-2": { maxTokens: 222 },
    });
  });

  it("normalizes the baseURL before storing (no /v1 → /v1 appended)", async () => {
    const { provider, writes } = fakeSettings({ llmPiAi: LLM_PI_AI });
    const handler = provisionHandler(provider);
    const result = (await handler(
      "provision",
      { name: "spoke-bare", baseURL: "http://127.0.0.1:9091" },
      SIGNAL,
    )) as { ok: boolean };
    expect(result.ok).toBe(true);
    const routes = (writes[0].section as { routes: unknown[] }).routes;
    expect(routes[routes.length - 1]).toEqual({ name: "spoke-bare", baseURL: "http://127.0.0.1:9091/v1" });
  });

  it("omits apiKeyEnv from the written route when the payload has none (stored/none key candidates)", async () => {
    const { provider, writes } = fakeSettings({ llmPiAi: LLM_PI_AI });
    const handler = provisionHandler(provider);
    const result = (await handler("provision", { name: "spoke-nokey", baseURL: "http://127.0.0.1:1/v1" }, SIGNAL)) as {
      ok: boolean;
    };
    expect(result.ok).toBe(true);
    const routes = (writes[0].section as { routes: unknown[] }).routes;
    expect(routes[routes.length - 1]).toEqual({ name: "spoke-nokey", baseURL: "http://127.0.0.1:1/v1" });
  });

  it("is an idempotent no-op for a same-named route with the same NORMALIZED baseURL (added 0, no write)", async () => {
    const { provider, writes } = fakeSettings({ llmPiAi: LLM_PI_AI });
    const handler = provisionHandler(provider);
    const result = (await handler(
      "provision",
      { name: "spoke-live", baseURL: "http://127.0.0.1:8080/v1" },
      SIGNAL,
    )) as { ok: boolean; value?: Record<string, unknown> };
    expect(result.ok).toBe(true);
    expect(result.value?.added).toBe(0);
    expect(writes).toHaveLength(0);
  });

  it("rejects a same-named route with a different baseURL (reconcile by hand)", async () => {
    const { provider, writes } = fakeSettings({ llmPiAi: LLM_PI_AI });
    const handler = provisionHandler(provider);
    const result = (await handler(
      "provision",
      { name: "spoke-live", baseURL: "http://127.0.0.1:9999/v1" },
      SIGNAL,
    )) as { ok: boolean; error?: { code: string; message: string } };
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("bad-request");
    expect(result.error?.message).toContain("spoke-live");
    expect(result.error?.message).toContain("different baseURL");
    expect(writes).toHaveLength(0);
  });

  it("rejects a blank name", async () => {
    const { provider } = fakeSettings({ llmPiAi: LLM_PI_AI });
    const handler = provisionHandler(provider);
    const result = (await handler(
      "provision",
      { name: "", baseURL: "http://127.0.0.1:1/v1" },
      SIGNAL,
    )) as { ok: boolean; error?: { code: string } };
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("bad-request");
  });

  it("rejects a name containing a slash (the route name is the provider key)", async () => {
    const { provider } = fakeSettings({ llmPiAi: LLM_PI_AI });
    const handler = provisionHandler(provider);
    const result = (await handler(
      "provision",
      { name: "a/b", baseURL: "http://127.0.0.1:1/v1" },
      SIGNAL,
    )) as { ok: boolean; error?: { code: string; message: string } };
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("bad-request");
    expect(result.error?.message).toContain("slash");
  });

  it("maps shape violations to bad-request naming the field", async () => {
    const { provider } = fakeSettings({ llmPiAi: LLM_PI_AI });
    const handler = provisionHandler(provider);
    let result = (await handler("provision", { name: 42, baseURL: "http://127.0.0.1:1/v1" }, SIGNAL)) as {
      ok: boolean;
      error?: { code: string; message: string };
    };
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("bad-request");
    expect(result.error?.message).toContain("name");
    result = (await handler("provision", { name: "x" }, SIGNAL)) as {
      ok: boolean;
      error?: { code: string; message: string };
    };
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("bad-request");
    expect(result.error?.message).toContain("baseURL");
    result = (await handler("provision", { name: "x", baseURL: "not a url" }, SIGNAL)) as {
      ok: boolean;
      error?: { code: string; message: string };
    };
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("bad-request");
    expect(result.error?.message).toContain("baseURL");
    result = (await handler(
      "provision",
      { name: "x", baseURL: "http://127.0.0.1:1/v1", apiKeyEnv: 7 },
      SIGNAL,
    )) as { ok: boolean; error?: { code: string; message: string } };
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("bad-request");
    expect(result.error?.message).toContain("apiKeyEnv");
  });

  it("maps a non-object payload to bad-request (and ignores unknown extra fields, lenient as the rest of the channel)", async () => {
    const { provider, writes } = fakeSettings({ llmPiAi: LLM_PI_AI });
    const handler = provisionHandler(provider);
    const result = (await handler("provision", "nope", SIGNAL)) as {
      ok: boolean;
      error?: { code: string };
    };
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("bad-request");
    const ok = (await handler(
      "provision",
      { name: "spoke-extra", baseURL: "http://127.0.0.1:1/v1", whatever: true },
      SIGNAL,
    )) as { ok: boolean };
    expect(ok.ok).toBe(true);
    expect(writes).toHaveLength(1);
  });

  it("reports shadowing when the name collides with a pi-ai provider key (and still adds)", async () => {
    const { provider, writes } = fakeSettings({ llmPiAi: LLM_PI_AI });
    const handler = provisionHandler(provider);
    const result = (await handler(
      "provision",
      { name: "llama-swap", baseURL: "http://127.0.0.1:8080/v1" },
      SIGNAL,
    )) as { ok: boolean; value?: Record<string, unknown> };
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ added: 1, shadowing: "llama-swap" });
    expect(writes).toHaveLength(1);
  });

  it("reports shadowing when the name collides with a built-in catalog id", async () => {
    const { provider } = fakeSettings({ llmPiAi: { providers: {} } });
    const handler = provisionHandler(provider, sectionWith([]));
    const result = (await handler(
      "provision",
      { name: "deepseek", baseURL: "http://127.0.0.1:1/v1" },
      SIGNAL,
    )) as { ok: boolean; value?: Record<string, unknown> };
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ added: 1, shadowing: "deepseek" });
  });

  it("does not report shadowing for a clean name", async () => {
    const { provider } = fakeSettings({ llmPiAi: LLM_PI_AI });
    const handler = provisionHandler(provider);
    const result = (await handler(
      "provision",
      { name: "modelspoke-demo-local", baseURL: "http://127.0.0.1:8080/v1" },
      SIGNAL,
    )) as { ok: boolean; value?: Record<string, unknown> };
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ added: 1 });
  });

  it("reports shadowing on the idempotent no-op too (the shadowed state exists either way)", async () => {
    const { provider, writes } = fakeSettings({ llmPiAi: LLM_PI_AI });
    const section = sectionWith([{ name: "llama-swap", baseURL: "http://127.0.0.1:8080/v1" }]);
    const handler = provisionHandler(provider, section);
    const result = (await handler(
      "provision",
      { name: "llama-swap", baseURL: "http://127.0.0.1:8080/v1" },
      SIGNAL,
    )) as { ok: boolean; value?: Record<string, unknown> };
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ added: 0, shadowing: "llama-swap" });
    expect(writes).toHaveLength(0);
  });

  it("maps a revision conflict to settings-conflict with the details", async () => {
    const { provider } = fakeSettings({
      llmPiAi: LLM_PI_AI,
      replace: () =>
        Promise.reject(new SettingsConflictError(settingsNamespace("modelspoke"), 5, 6)),
    });
    const handler = provisionHandler(provider);
    const result = (await handler(
      "provision",
      { name: "modelspoke-demo-local", baseURL: "http://127.0.0.1:8080/v1" },
      SIGNAL,
    )) as { ok: boolean; error?: { code: string; details: Record<string, unknown> } };
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("settings-conflict");
    expect(result.error?.details).toEqual({
      ns: settingsNamespace("modelspoke"),
      expected: 5,
      actual: 6,
    });
  });

  it("maps an absent settings service to internal", async () => {
    const handler = makeChannelHandler(fakeCtx({}).ctx, {
      section: () => sectionWith([]),
      log: () => undefined,
    });
    const result = (await handler(
      "provision",
      { name: "x", baseURL: "http://127.0.0.1:1/v1" },
      SIGNAL,
    )) as { ok: boolean; error?: { code: string } };
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("internal");
  });
});

describe("installModelspokeChannel (lazy connection)", () => {
  it("is a silent no-op while no connection service exists (headless)", () => {
    const { ctx, listeners } = fakeCtx({});
    installModelspokeChannel(ctx, { section: () => ({}), log: () => undefined });
    // No registration happened, but the activation listener is armed.
    expect(listeners).toHaveLength(1);
    expect(listeners[0].name).toBe("internal/service");
    expect(listeners[0].options).toEqual({ global: true });
  });

  it("registers the loopback channel when the connection appears later, exactly once", () => {
    const handles: Array<{ channel: string; options: unknown }> = [];
    const connection = {
      rpc: {
        handle: (channel: string, _h: unknown, options: unknown) => {
          handles.push({ channel, options });
          return () => Promise.resolve();
        },
      },
    };
    const { ctx, listeners, services } = fakeCtx({});
    installModelspokeChannel(ctx, { section: () => ({}), log: () => undefined });
    expect(handles).toHaveLength(0);
    for (const listener of listeners) {
      if (listener.name === "internal/service") {
        services["connection"] = connection;
        listener.fn("connection", connection);
      }
    }
    expect(handles).toHaveLength(1);
    expect(handles[0].channel).toBe("/modelspoke");
    expect(handles[0].options).toEqual({ authority: "loopback" });
    for (const listener of listeners) {
      if (listener.name === "internal/service") listener.fn("connection", connection);
    }
    expect(handles).toHaveLength(1);
    for (const listener of listeners) {
      if (listener.name === "internal/service") listener.fn("settings", {});
    }
    expect(handles).toHaveLength(1);
  });

  it("registers immediately when the connection already exists at apply time", () => {
    const handles: Array<{ channel: string }> = [];
    const connection = {
      rpc: {
        handle: (channel: string, _h: unknown, _options: unknown) => {
          handles.push({ channel });
          return () => Promise.resolve();
        },
      },
    };
    const { ctx } = fakeCtx({ connection });
    installModelspokeChannel(ctx, { section: () => ({}), log: () => undefined });
    expect(handles).toEqual([{ channel: "/modelspoke" }]);
  });
});

function loadMetaFixture(): { object: string; data: Array<Record<string, unknown>> } {
  return JSON.parse(
    readFileSync(new URL("./fixtures/models-llamaswap-meta.json", import.meta.url), "utf8"),
  );
}
function fixtureEntry(id: string): Record<string, unknown> {
  const entry = loadMetaFixture().data.find((m) => m.id === id);
  if (!entry) throw new Error(`fixture has no ${id}`);
  return entry;
}
function loadBareFixture(): { object: string; data: Array<Record<string, unknown>> } {
  return JSON.parse(
    readFileSync(new URL("./fixtures/models-bare.json", import.meta.url), "utf8"),
  );
}

describe("discoverMetadataRow (the raw-entry → wire-row mapping, the qwen3.8 fix)", () => {
  it("a full llama-swap entry maps to id + the FULL discoveredCanonical (no name, no rawMeta)", () => {
    const entry = fixtureEntry("qwen3.8-27b-6000pro") as {
      meta: { llamaswap: { compat: Record<string, unknown> } };
    };
    const row = discoverMetadataRow(entry as never);
    expect(row.id).toBe("qwen3.8-27b-6000pro");
    expect("name" in row).toBe(false);
    expect("rawMeta" in row).toBe(false);
    expect(row.discoveredCanonical).toEqual({
      input: ["text", "image"],
      reasoning: true,
      // canonical: null (unsupported) levels dropped; `off` preserved.
      thinkingLevelMap: { off: "low", low: "low", medium: "medium", xhigh: "xhigh" },
      compat: entry.meta.llamaswap.compat,
      maxTokens: 65536,
      contextWindow: 262144,
    });
  });

  it("an entry that advertises only a modality maps to a partial discoveredCanonical", () => {
    const row = discoverMetadataRow(fixtureEntry("gemma-4-E4B-it") as never);
    expect(row).toEqual({ id: "gemma-4-E4B-it", discoveredCanonical: { input: ["text"] } });
  });

  it("an endpoint-supplied name (meta.llamaswap.name) rides the row", () => {
    const row = discoverMetadataRow({
      id: "named",
      name: "Top-level name",
      meta: { llamaswap: { name: "Meta name" } },
    } as never);
    // meta.llamaswap.name wins over the top-level name (extractName's order).
    expect(row).toEqual({ id: "named", name: "Meta name" });
    expect("discoveredCanonical" in row).toBe(false);
  });

  it("a bare server entry (no canonical signal) maps to the id alone (discoveredCanonical absent)", () => {
    const row = discoverMetadataRow(loadBareFixture().data[0] as never);
    expect(row).toEqual({ id: "qwen3.8-27b-6000pro" });
  });
});

describe("discoverMetadata handler (the thin I/O wrapper)", () => {
  const DM_SECTION = {
    routes: [{ name: "ms", baseURL: "http://127.0.0.1:9999/v1" }],
    overrides: {},
  };
  const signal = () => new AbortController().signal;
  const dmHandler = (section: unknown = DM_SECTION) =>
    makeChannelHandler(fakeCtx({}).ctx, {
      section: () => section,
      log: () => undefined,
      // Pinned to the Ollama backend alone: any other registered backend
      // adds probe traffic to the fetch-count assertions below.
      backends: [ollamaBackend],
    });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("an unknown provider is a closed bad-request (on the result slot, never a throw)", async () => {
    const handler = dmHandler();
    const result = await handler("discoverMetadata", { provider: "nope" }, signal());
    expect(result).toEqual({
      ok: false,
      error: {
        code: "bad-request",
        message: 'discoverMetadata: no modelspoke route named "nope"',
        details: { issues: [] },
      },
    });
  });

  it("a malformed payload is a closed bad-request", async () => {
    const handler = dmHandler();
    for (const payload of [undefined, {}, { provider: "" }, { provider: 5 }, []]) {
      const result = await handler("discoverMetadata", payload, signal());
      expect(result.ok).toBe(false);
      expect((result as { error: { code: string } }).error.code).toBe("bad-request");
    }
  });

  it("returns the mapped rows (fetch → extractFromEntry → row; rawMeta stripped, order kept)", async () => {
    const flagship = fixtureEntry("qwen3.8-27b-6000pro");
    const gemma = fixtureEntry("gemma-4-E4B-it");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        modelsList([flagship, gemma]),
      ),
    );
    const handler = dmHandler();
    const result = (await handler("discoverMetadata", { provider: "ms" }, signal())) as {
      ok: boolean;
      value: { models: Array<Record<string, unknown>> };
    };
    expect(result.ok).toBe(true);
    expect(result.value.models).toEqual([
      discoverMetadataRow(flagship as never),
      discoverMetadataRow(gemma as never),
    ]);
    expect(Object.keys(result.value.models[0]!)).toEqual(["id", "discoveredCanonical"]);
  });

  it("memoizes per route identity: two calls fetch once", async () => {
    const fetchMock = vi.fn(async () => modelsList([fixtureEntry("gemma-4-E4B-it")]));
    vi.stubGlobal("fetch", fetchMock);
    const handler = dmHandler();
    await handler("discoverMetadata", { provider: "ms" }, signal());
    await handler("discoverMetadata", { provider: "ms" }, signal());
    // Per docs/provider-details.md §3.1 the fixture's meta.llamaswap
    // settles the Ollama origin as not-Ollama with ZERO fetches — the /models fetch below is the entries memo.
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls.filter((u) => u.endsWith("/models"))).toHaveLength(1);
    expect(urls.filter((u) => u.endsWith("/api/version"))).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("evicts on failure: a failed fetch is retried on the next call (and reports internal)", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => {
        throw new Error("ECONNREFUSED");
      })
      // retry succeeds; near-miss guard settles not-Ollama with ZERO fetches ⇒ generic rows
      .mockImplementationOnce(async () => modelsList([fixtureEntry("gemma-4-E4B-it")]))
      .mockImplementation(async () => modelsList([fixtureEntry("gemma-4-E4B-it")]));
    vi.stubGlobal("fetch", fetchMock);
    const handler = dmHandler();

    const first = (await handler("discoverMetadata", { provider: "ms" }, signal())) as {
      ok: boolean;
      error: { code: string; message: string };
    };
    expect(first.ok).toBe(false);
    expect(first.error.code).toBe("internal");
    expect(first.error.message).toContain("Cannot reach server");

    const second = (await handler("discoverMetadata", { provider: "ms" }, signal())) as {
      ok: boolean;
    };
    expect(second.ok).toBe(true);
    expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/models"))).toHaveLength(2);
  });

  it("evicts on a non-2xx response and reports internal (the 401 hint rides the message)", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => ({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        text: async () => "denied",
      }))
      // retry succeeds; near-miss guard settles not-Ollama with ZERO fetches ⇒ generic rows
      .mockImplementationOnce(async () => modelsList([fixtureEntry("gemma-4-E4B-it")]))
      .mockImplementation(async () => modelsList([fixtureEntry("gemma-4-E4B-it")]));
    vi.stubGlobal("fetch", fetchMock);
    const handler = dmHandler();

    const first = (await handler("discoverMetadata", { provider: "ms" }, signal())) as {
      ok: boolean;
      error: { code: string; message: string };
    };
    expect(first.ok).toBe(false);
    expect(first.error.code).toBe("internal");
    expect(first.error.message).toContain("401 Unauthorized");
    expect(first.error.message).toContain("Check the route's apiKeyEnv.");

    const second = (await handler("discoverMetadata", { provider: "ms" }, signal())) as {
      ok: boolean;
    };
    expect(second.ok).toBe(true);
    expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/models"))).toHaveLength(2);
  });
});

function modelsList(data: unknown[]) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({ object: "list", data }),
    text: async () => JSON.stringify({ object: "list", data }),
  } as unknown as Response;
}
