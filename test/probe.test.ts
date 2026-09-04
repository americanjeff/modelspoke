import { describe, expect, it, vi } from "vitest";
import {
  probeLlamaServerProps,
  probeLlamaSwapRunning,
} from "../src/discovery/index.js";

function stubFetch(routes: Array<{ match: string; respond: (url: string) => Response }>) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    for (const r of routes) {
      if (url.includes(r.match)) {
        return r.respond(url);
      }
    }
    return new Response("not found", { status: 404 });
  });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("probeLlamaServerProps", () => {
  it("success: reads default_generation_settings.n_ctx", async () => {
    const fetchImpl = stubFetch([
      { match: "/props", respond: () => json({ default_generation_settings: { n_ctx: 8192 } }) },
    ]);
    await expect(probeLlamaServerProps("http://127.0.0.1:5802", fetchImpl)).resolves.toBe(8192);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://127.0.0.1:5802/props");
  });

  it("trailing slash on baseURL is normalized", async () => {
    const fetchImpl = stubFetch([
      { match: "/props", respond: () => json({ default_generation_settings: { n_ctx: 8192 } }) },
    ]);
    await expect(probeLlamaServerProps("http://127.0.0.1:5802/", fetchImpl)).resolves.toBe(8192);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://127.0.0.1:5802/props");
  });

  it("n_ctx as all-digit string is coerced", async () => {
    const fetchImpl = stubFetch([
      { match: "/props", respond: () => json({ default_generation_settings: { n_ctx: "8192" } }) },
    ]);
    await expect(probeLlamaServerProps("http://127.0.0.1:5802", fetchImpl)).resolves.toBe(8192);
  });

  it("404 → undefined", async () => {
    const fetchImpl = stubFetch([{ match: "/props", respond: () => json({}, 404) }]);
    await expect(probeLlamaServerProps("http://127.0.0.1:5802", fetchImpl)).resolves.toBeUndefined();
  });

  it("malformed JSON → undefined (never throws)", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("{ not json", { status: 200 }),
    );
    await expect(probeLlamaServerProps("http://127.0.0.1:5802", fetchImpl)).resolves.toBeUndefined();
  });

  it("network error → undefined (never throws)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(probeLlamaServerProps("http://127.0.0.1:5802", fetchImpl)).resolves.toBeUndefined();
  });

  it("missing default_generation_settings → undefined", async () => {
    const fetchImpl = stubFetch([{ match: "/props", respond: () => json({ other: 1 }) }]);
    await expect(probeLlamaServerProps("http://127.0.0.1:5802", fetchImpl)).resolves.toBeUndefined();
  });

  it("n_ctx 0 / non-integer → undefined", async () => {
    const fetchImpl = stubFetch([
      { match: "/props", respond: () => json({ default_generation_settings: { n_ctx: 0 } }) },
    ]);
    await expect(probeLlamaServerProps("http://127.0.0.1:5802", fetchImpl)).resolves.toBeUndefined();
    const fetchImpl2 = stubFetch([
      {
        match: "/props",
        respond: () => json({ default_generation_settings: { n_ctx: 8.5 } }),
      },
    ]);
    await expect(probeLlamaServerProps("http://127.0.0.1:5802", fetchImpl2)).resolves.toBeUndefined();
  });
});

describe("probeLlamaSwapRunning", () => {
  it("fetches the root /running endpoint (no /v1 prefix)", async () => {
    const fetchImpl = stubFetch([{ match: "/running", respond: () => json({ running: [] }) }]);
    await probeLlamaSwapRunning("http://127.0.0.1:8080/", fetchImpl);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://127.0.0.1:8080/running");
  });

  it("proxy entries: sub-probes {proxy}/props and maps model → context", async () => {
    const fetchImpl = stubFetch([
      {
        match: "/running",
        respond: () =>
          json({
            running: [
              {
                model: "model-a",
                proxy: "http://127.0.0.1:5802",
                state: "ready",
                cmd: "llama-server -e HF_TOKEN=hf_secret", // must be IGNORED, never parsed
              },
              { model: "model-b", state: "ready" }, // no proxy → skipped (cmd-parse dropped)
            ],
          }),
      },
      {
        match: "127.0.0.1:5802/props",
        respond: () => json({ default_generation_settings: { n_ctx: 4096 } }),
      },
    ]);
    const result = await probeLlamaSwapRunning("http://127.0.0.1:8080", fetchImpl);
    expect(result).toBeDefined();
    expect(result!.get("model-a")).toBe(4096);
    expect(result!.has("model-b")).toBe(false);
    expect(result!.size).toBe(1);
  });

  it("entry whose /props sub-probe 404s is skipped (no usable context)", async () => {
    const fetchImpl = stubFetch([
      {
        match: "/running",
        respond: () => json({ running: [{ model: "model-a", proxy: "http://127.0.0.1:5802" }] }),
      },
      { match: "/props", respond: () => json({}, 404) },
    ]);
    const result = await probeLlamaSwapRunning("http://127.0.0.1:8080", fetchImpl);
    expect(result).toBeDefined();
    expect(result!.size).toBe(0);
  });

  it("non-2xx /running → undefined", async () => {
    const fetchImpl = stubFetch([{ match: "/running", respond: () => json({}, 500) }]);
    await expect(probeLlamaSwapRunning("http://127.0.0.1:8080", fetchImpl)).resolves.toBeUndefined();
  });

  it("malformed /running JSON → undefined (never throws)", async () => {
    const fetchImpl = vi.fn(async () => new Response("{ broken", { status: 200 }));
    await expect(probeLlamaSwapRunning("http://127.0.0.1:8080", fetchImpl)).resolves.toBeUndefined();
  });

  it("network error → undefined (never throws)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(probeLlamaSwapRunning("http://127.0.0.1:8080", fetchImpl)).resolves.toBeUndefined();
  });

  it("empty running list → empty map", async () => {
    const fetchImpl = stubFetch([{ match: "/running", respond: () => json({ running: [] }) }]);
    const result = await probeLlamaSwapRunning("http://127.0.0.1:8080", fetchImpl);
    expect(result).toBeDefined();
    expect(result!.size).toBe(0);
  });

  it("missing running key → empty map", async () => {
    const fetchImpl = stubFetch([{ match: "/running", respond: () => json({}) }]);
    const result = await probeLlamaSwapRunning("http://127.0.0.1:8080", fetchImpl);
    expect(result).toBeDefined();
    expect(result!.size).toBe(0);
  });
});
