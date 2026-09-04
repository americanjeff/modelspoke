/**
 * The dsh adapter's identity model (src/dsh/adapter.ts):
 *
 * - listModels is the route's SERVED SET: one row per EXPLICIT entry
 *   (id = the entry NAME — the harness identity; an entry whose wire id the
 *   endpoint does not currently serve is still offered), or one row per
 *   DISCOVERED catalog model on a FULL_CATALOG route;
 * - resolveModel takes the harness identity (entry name / wire id) and
 *   dispatches on the WIRE id (unknown entry name → NO_MODEL; the FULL_CATALOG
 *   served set is open);
 * - the entry's own config is tier 1 (beats discovery);
 * - effort is pi-parity: the per-model `defaultEffort` (explicit entry or
 *   FULL_CATALOG per-route entry) wins over the built-in fallback
 *   (medium), clamped to the offered levels; non-reasoning models never
 *   materialize one.
 *
 * The wire payload itself is covered by wire-capture.test.ts.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { LlmError } from "@deepseek-ai/dsh-llm";
import { ModelspokeAdapter } from "../src/dsh/adapter.js";
import type { ModelspokeAdapterOptions } from "../src/dsh/adapter.js";

const FLAGSHIP = "qwen3.8-27b-6000pro";
const GEMMA = "gemma-4-E4B-it";
const CATALOG = [FLAGSHIP, GEMMA, "extra-1"];

let server: http.Server;
let baseUrl = "";

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          data: CATALOG.map((id) => ({ id, object: "model" })),
        }),
      );
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

/** A modelspoke adapter over the mock route; the raw route record is the STORED form. */
function makeAdapter(route: Record<string, unknown>): ModelspokeAdapter {
  const options: ModelspokeAdapterOptions = {
    settings: () => ({
      routes: [{ name: "ms", baseURL: baseUrl, ...route }],
      overrides: {},
    }),
    log: () => {},
  };
  return new ModelspokeAdapter(options);
}

describe("listModels — the served set", () => {
  it("EXPLICIT: one row per entry, id = the entry NAME (a variant keeps both names; a typed unknown wire id is still offered)", async () => {
    const adapter = makeAdapter({
      models: [
        { name: "A", id: FLAGSHIP },
        { name: "A-fast", id: FLAGSHIP, maxTokens: 10 }, // variant: same wire id
        { name: "G", id: GEMMA },
        { name: "ghost", id: "not-in-catalog" },
      ],
    });
    const models = await adapter.listModels("ms");
    expect(models.map((m) => m.id)).toEqual(["A", "A-fast", "G", "ghost"]);
    expect(models.map((m) => m.name)).toEqual(["A", "A-fast", "G", "ghost"]);
    expect(models).toHaveLength(4);
    for (const model of models) {
      expect(model.provider).toBe("ms");
    }
  });

  it("EXPLICIT: the catalog's other models are NOT offered (the served set is closed)", async () => {
    const adapter = makeAdapter({ models: [{ name: "A", id: FLAGSHIP }] });
    const models = await adapter.listModels("ms");
    expect(models.map((m) => m.id)).toEqual(["A"]);
  });

  it("FULL_CATALOG: one row per discovered model (id = wire id; the legacy cosmetic name applies)", async () => {
    const adapter = makeAdapter({
      overrides: { [GEMMA]: { name: "Gemma 4" } },
    });
    const models = await adapter.listModels("ms");
    expect(models.map((m) => m.id)).toEqual(CATALOG);
    const gemma = models.find((m) => m.id === GEMMA)!;
    expect(gemma.name).toBe("Gemma 4");
    const flagship = models.find((m) => m.id === FLAGSHIP)!;
    expect(flagship.name).toBe(FLAGSHIP); // no name anywhere → the id
  });

  it("a legacy string allow-list route degrades to FULL_CATALOG (serves the whole catalog)", async () => {
    const adapter = makeAdapter({ models: [FLAGSHIP] });
    const models = await adapter.listModels("ms");
    expect(models.map((m) => m.id)).toEqual(CATALOG);
  });
});

describe("resolveModel — the harness-identity dispatch", () => {
  it("EXPLICIT: the entry NAME resolves (id = name; the wire id drives discovery and tier 1)", async () => {
    const adapter = makeAdapter({
      models: [{ name: "A", id: FLAGSHIP, contextWindow: 12345 }],
    });
    const info = await adapter.resolveModel("ms", "A");
    expect(info.id).toBe("A");
    expect(info.name).toBe("A");
    expect(info.context?.contextWindow).toBe(12345);
  });

  it("EXPLICIT: an unknown entry name is a NO_MODEL rejection (the served set is closed)", async () => {
    const adapter = makeAdapter({ models: [{ name: "A", id: FLAGSHIP }] });
    await expect(adapter.resolveModel("ms", "nope")).rejects.toMatchObject({
      code: "NO_MODEL",
    });
    // The wire id of a served entry is NOT a requestable identity either
    // (only the harness name is — the wire id is dispatch plumbing).
    await expect(adapter.resolveModel("ms", FLAGSHIP)).rejects.toMatchObject({
      code: "NO_MODEL",
    });
  });

  it("FULL_CATALOG: the WIRE id is the identity (open set — an unknown id degrades, never rejects)", async () => {
    const adapter = makeAdapter({});
    const known = await adapter.resolveModel("ms", FLAGSHIP);
    expect(known.id).toBe(FLAGSHIP);
    const unknown = await adapter.resolveModel("ms", "not-in-catalog");
    expect(unknown.id).toBe("not-in-catalog");
  });
});

describe("defaultEffort — the determinable per-model default (pi parity)", () => {
  it("the entry's effort applies to that model; the others get the built-in fallback", async () => {
    // The flagship offers off/low/medium/xhigh — "xhigh" is offered, and
    // the built-in fallback "medium" is offered too.
    const adapter = makeAdapter({
      models: [
        { name: "A", id: FLAGSHIP, defaultEffort: "xhigh" },
        { name: "B", id: FLAGSHIP },
      ],
    });
    const a = await adapter.resolveModel("ms", "A");
    const b = await adapter.resolveModel("ms", "B");
    expect(a.reasoning?.defaultEffort).toBe("xhigh");
    expect(b.reasoning?.defaultEffort).toBe("medium"); // the pi fallback
    // The offered levels are the model's (both entries share the wire id).
    expect(a.reasoning?.efforts.map((l) => l.id)).toEqual(b.reasoning?.efforts.map((l) => l.id));
  });

  it("an effort the model does not offer clamps to the nearest offered (pi rule)", async () => {
    // "high" is null-mapped by the flagship's preset (not offered); pi's
    // clamp walks outward in canonical order — the nearest offered level
    // one step up is "xhigh".
    const adapter = makeAdapter({
      models: [{ name: "A", id: FLAGSHIP, defaultEffort: "high" }],
    });
    const info = await adapter.resolveModel("ms", "A");
    expect(info.reasoning?.defaultEffort).toBe("xhigh");
  });

  it("an off-vocabulary effort clamps to the lowest offered level (pi rule)", async () => {
    // "xlow" is not a canonical level: pi's clampThinkingLevel falls back
    // to the lowest offered level — the flagship's map offers `off`, so
    // the default clamps to "off" and is omitted.
    const adapter = makeAdapter({
      models: [{ name: "A", id: FLAGSHIP, defaultEffort: "xlow" }],
    });
    const info = await adapter.resolveModel("ms", "A");
    expect(info.reasoning?.defaultEffort).toBeUndefined();
    expect(info.reasoning?.efforts.map((l) => l.id)).not.toContain("xlow");
  });

  it("a non-reasoning model never materializes a default effort", async () => {
    const adapter = makeAdapter({
      models: [{ name: "G", id: GEMMA, defaultEffort: "high" }],
    });
    const info = await adapter.resolveModel("ms", "G");
    expect(info.reasoning).toBeUndefined();
  });

  it("FULL_CATALOG: the fallback materializes; a per-route defaultEffort wins", async () => {
    const adapter = makeAdapter({});
    const info = await adapter.resolveModel("ms", FLAGSHIP);
    expect(info.reasoning?.defaultEffort).toBe("medium"); // the pi fallback
    // The per-route override entry carries the dsh-only field (the
    // FULL_CATALOG home for the per-model default).
    const overridden = makeAdapter({
      overrides: { [FLAGSHIP]: { defaultEffort: "xhigh" } },
    });
    const info2 = await overridden.resolveModel("ms", FLAGSHIP);
    expect(info2.reasoning?.defaultEffort).toBe("xhigh");
  });
});

describe("LlmError contract", () => {
  it("NO_MODEL is a LlmError (the runtime's taxonomy)", async () => {
    const adapter = makeAdapter({ models: [{ name: "A", id: FLAGSHIP }] });
    const error: unknown = await adapter
      .resolveModel("ms", "nope")
      .then(
        () => {
          throw new Error("expected a rejection");
        },
        (err) => err,
      );
    expect(error).toBeInstanceOf(LlmError);
    expect((error as LlmError).code).toBe("NO_MODEL");
  });
});
