import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { Context } from "@deepseek-ai/cordis";
import {
  discoverMetadataRow,
  installModelspokeChannel,
  makeChannelHandler,
  makeModelspokeFetchRoute,
} from "../src/dsh/channel.js";
import { ollamaBackend } from "../src/discovery/ollama.js";

const sectionWith = (routes: unknown[], overrides: Record<string, unknown> = {}) => ({
  routes,
  overrides,
});

/**
 * A cordis-shaped fake: `inject(names, cb)` fires the callback immediately
 * when every requested service is already provided, otherwise parks it and
 * fires it when `provide` completes the set (the inject-seam semantics the
 * 0.1.5 host gives plugins — the channel's only service seam).
 */
function fakeCtx(services: Record<string, unknown>) {
  const pending: Array<{
    names: string[];
    cb: (childCtx: { get: (name: string) => unknown }) => void;
  }> = [];
  const ctx = {
    get: (name: string) => services[name],
    on: (_name: string, _fn: (...args: unknown[]) => unknown, _options?: unknown) => {
      return () => undefined;
    },
    inject: (names: string[], cb: (childCtx: { get: (name: string) => unknown }) => void) => {
      if (names.every((n) => services[n] !== undefined)) {
        cb({ get: (n: string) => services[n] });
      } else {
        pending.push({ names, cb });
      }
    },
    provide: (name: string, value: unknown) => {
      services[name] = value;
      const still: typeof pending = [];
      for (const entry of pending) {
        if (entry.names.every((n) => services[n] !== undefined)) {
          entry.cb({ get: (n: string) => services[n] });
        } else {
          still.push(entry);
        }
      }
      pending.length = 0;
      pending.push(...still);
      return () => undefined;
    },
  };
  return { ctx: ctx as unknown as Context, services };
}

/** A fake Connection service recording the exact Fetch routes registered. */
function fakeConnection() {
  const registered: Array<{
    path: string;
    methods: readonly string[];
    requestBody: string;
    fetch: (request: Request) => Promise<Response>;
  }> = [];
  const connection = {
    fetch: {
      register: (route: {
        path: string;
        methods: readonly string[];
        requestBody: string;
        fetch: (request: Request) => Promise<Response>;
      }) => {
        registered.push(route);
        return () => Promise.resolve();
      },
    },
  };
  return { connection, registered };
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

describe("installModelspokeChannel (the inject seam)", () => {
  it("is a silent no-op while no connection service exists (headless)", () => {
    const { ctx } = fakeCtx({});
    const log: string[] = [];
    const { registered } = fakeConnection();
    installModelspokeChannel(ctx, { section: () => ({}), log: (line) => log.push(line) });
    // The inject fiber is parked; nothing is registered and nothing logged.
    expect(registered).toHaveLength(0);
    expect(log).toHaveLength(0);
  });

  it("registers the endpoint when the connection appears later, exactly once", () => {
    const { ctx, services } = fakeCtx({});
    const { connection, registered } = fakeConnection();
    const log: string[] = [];
    installModelspokeChannel(ctx, { section: () => ({}), log: (line) => log.push(line) });
    expect(registered).toHaveLength(0);
    (ctx as unknown as { provide: (n: string, v: unknown) => unknown }).provide("connection", connection);
    expect(registered).toHaveLength(1);
    expect(registered[0].path).toBe("/api/modelspoke");
    expect(registered[0].methods).toEqual(["POST"]);
    expect(registered[0].requestBody).toBe("buffered");
    expect(log).toEqual([
      "modelspoke: /api/modelspoke loopback endpoint registered (discoverMetadata)",
    ]);
    // A second provision of the same service re-arrives: the installed
    // guard keeps the registration singular.
    (ctx as unknown as { provide: (n: string, v: unknown) => unknown }).provide("connection", connection);
    expect(registered).toHaveLength(1);
  });

  it("registers immediately when the connection already exists at apply time", () => {
    const { connection, registered } = fakeConnection();
    const { ctx } = fakeCtx({ connection });
    installModelspokeChannel(ctx, { section: () => ({}), log: () => undefined });
    expect(registered).toHaveLength(1);
    expect(registered[0].path).toBe("/api/modelspoke");
  });

  it("logs a failed registration instead of throwing", () => {
    const failing = {
      fetch: {
        register: () => {
          throw new Error("boom");
        },
      },
    };
    const { ctx } = fakeCtx({ connection: failing });
    const log: string[] = [];
    expect(() =>
      installModelspokeChannel(ctx, { section: () => ({}), log: (line) => log.push(line) }),
    ).not.toThrow();
    expect(log).toEqual([
      "modelspoke: loopback endpoint registration failed: boom",
    ]);
  });
});

describe("makeModelspokeFetchRoute (the transport envelope)", () => {
  const post = (body: unknown, contentType = "application/json"): Request =>
    new Request("http://127.0.0.1:1/api/modelspoke", {
      method: "POST",
      headers: { "content-type": contentType },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  it("rejects a non-JSON content type with 415", async () => {
    const route = makeModelspokeFetchRoute({ section: () => ({}), log: () => undefined });
    const response = await route.fetch(post({ endpoint: "discoverMetadata", payload: {} }, "text/plain"));
    expect(response.status).toBe(415);
  });

  it("rejects a non-JSON body with 400", async () => {
    const route = makeModelspokeFetchRoute({ section: () => ({}), log: () => undefined });
    const response = await route.fetch(post("not json" as never));
    expect(response.status).toBe(400);
  });

  it("rejects a malformed envelope with 400", async () => {
    const route = makeModelspokeFetchRoute({ section: () => ({}), log: () => undefined });
    for (const body of [{}, { endpoint: 5, payload: {} }, { endpoint: "discoverMetadata" }]) {
      const response = await route.fetch(post(body));
      expect(response.status).toBe(400);
    }
  });

  it("round-trips the handler result as JSON 200 (business failures ride the slot)", async () => {
    const route = makeModelspokeFetchRoute({
      section: () => ({ routes: [], overrides: {} }),
      log: () => undefined,
    });
    // Unknown endpoint → the handler's closed bad-request, on a 200 body.
    const unknown = await route.fetch(post({ endpoint: "bogus", payload: {} }));
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toEqual({
      ok: false,
      error: { code: "bad-request", message: "unknown /modelspoke endpoint: bogus", details: { issues: [] } },
    });
    // Unknown provider → the handler's closed bad-request (no network).
    const unknownProvider = await route.fetch(
      post({ endpoint: "discoverMetadata", payload: { provider: "nope" } }),
    );
    expect(unknownProvider.status).toBe(200);
    const value = (await unknownProvider.json()) as { ok: boolean; error: { code: string } };
    expect(value.ok).toBe(false);
    expect(value.error.code).toBe("bad-request");
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
