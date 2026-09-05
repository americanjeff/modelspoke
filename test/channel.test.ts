import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { Context } from "@deepseek-ai/cordis";
import {
  discoverMetadataRow,
  installModelspokeChannel,
  makeChannelHandler,
} from "../src/dsh/channel.js";
import { ollamaBackend } from "../src/discovery/ollama.js";

const sectionWith = (routes: unknown[], overrides: Record<string, unknown> = {}) => ({
  routes,
  overrides,
});

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

describe("channel handler (unknown endpoint)", () => {
  it("answers an unknown endpoint with bad-request", async () => {
    const handler = makeChannelHandler({
      section: () => sectionWith([]),
      log: () => undefined,
    });
    const result = (await handler(
      "bogusEndpoint",
      {},
      new AbortController().signal,
    )) as { ok: boolean; error?: { code: string } };
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("bad-request");
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
    makeChannelHandler({
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
