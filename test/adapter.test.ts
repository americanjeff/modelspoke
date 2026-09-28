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
 *   (medium), clamped to the offered levels; an explicit value is always
 *   reported — including "off" (off-by-default, the dimension stays
 *   offered) — while a fallback clamp landing on "off" stays omitted;
 *   non-reasoning models never materialize one.
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
/** Every request path the mock saw — the registry-scan probe assertions. */
const hits: string[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits.push(req.url ?? "");
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

  it("an off-vocabulary effort clamps to the lowest offered level (pi rule) and reports it", async () => {
    // "xlow" is not a canonical level: pi's clampThinkingLevel falls back
    // to the lowest offered level — the flagship's map offers `off`, so
    // the default clamps to "off". An explicit value is always reported
    // (the dispatch clamps to off too — nothing is sent — so the reported
    // default matches what the call actually does).
    const adapter = makeAdapter({
      models: [{ name: "A", id: FLAGSHIP, defaultEffort: "xlow" }],
    });
    const info = await adapter.resolveModel("ms", "A");
    expect(info.reasoning?.defaultEffort).toBe("off");
    expect(info.reasoning?.efforts.map((l) => l.id)).not.toContain("xlow");
  });

  it("an explicit off default reports off (off-by-default: the dimension stays offered)", async () => {
    const adapter = makeAdapter({
      models: [{ name: "A", id: FLAGSHIP, defaultEffort: "off" }],
    });
    const info = await adapter.resolveModel("ms", "A");
    expect(info.reasoning?.defaultEffort).toBe("off");
    // The dimension STAYS — the nothink sentinel (the checkbox's state) is
    // the no-dimension state, never a default.
    expect(info.reasoning?.efforts.map((l) => l.id)).toEqual(["off", "low", "medium", "xhigh"]);
  });

  it("the built-in fallback landing on off stays omitted (a level-less model offers off alone)", async () => {
    // The entry's tier-1 map offers ONLY off (the degenerate on/off form
    // the qwen3.5/3.6 presets use); with no per-model default the
    // built-in "medium" clamps to the lone offered level, off — and a
    // fallback landing on off is not an effort to pin, so it is omitted
    // (the dispatch clamps to off anyway — nothing is sent).
    const adapter = makeAdapter({
      models: [{ name: "A", id: FLAGSHIP, thinkingLevelMap: { off: "low" } }],
    });
    const info = await adapter.resolveModel("ms", "A");
    expect(info.reasoning?.defaultEffort).toBeUndefined();
    expect(info.reasoning?.efforts.map((l) => l.id)).toEqual(["off"]);
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
    // An explicit "off" per-route default wins too (off-by-default).
    const offDefault = makeAdapter({
      overrides: { [FLAGSHIP]: { defaultEffort: "off" } },
    });
    const info3 = await offDefault.resolveModel("ms", FLAGSHIP);
    expect(info3.reasoning?.defaultEffort).toBe("off");
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

describe("backend registry scan — the runtime tier-2 enrichment (the session agrees with the card)", () => {
  const GLM = "glm-5.3-flash:cloud";
  const KIMI = "kimi-k3:cloud";

  let ollamaServer: http.Server;
  let ollamaBaseUrl = "";

  beforeAll(async () => {
    // A live Ollama's bare `/v1/models` shape (id/object only) + the native
    // surface: a dotted /api/version and one /api/show per model — the cloud
    // glm family (family `glm5_next`, vision, the glm family table) and an
    // UNLISTED cloud family (thinking capability, no family-table entry).
    ollamaServer = http.createServer((req, res) => {
      if (req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [GLM, KIMI].map((id) => ({ id, object: "model" })) }));
        return;
      }
      if (req.url === "/api/version") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ version: "0.34.4" }));
        return;
      }
      if (req.url === "/api/show" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          const { model } = JSON.parse(body) as { model: string };
          const show =
            model === GLM
              ? {
                  capabilities: ["completion", "thinking", "tools", "vision"],
                  details: { format: "", family: "glm5_next", parameter_size: "130B", quantization_level: "BF16" },
                  model_info: { "glm5_next.context_length": 1048576 },
                  modified_at: "2026-08-13T08:00:00-07:00",
                }
              : {
                  capabilities: ["completion", "tools", "thinking"],
                  details: { format: "", family: "kimi3", parameter_size: "100B", quantization_level: "FP8" },
                  model_info: { "kimi3.context_length": 131072 },
                  modified_at: "2026-08-13T08:00:00-07:00",
                };
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(show));
        });
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
    await new Promise<void>((resolve) => ollamaServer.listen(0, "127.0.0.1", resolve));
    ollamaBaseUrl = `http://127.0.0.1:${(ollamaServer.address() as AddressInfo).port}/v1`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      ollamaServer.close((err) => (err ? reject(err) : resolve())),
    );
  });

  function makeOllamaAdapter(route: Record<string, unknown>): ModelspokeAdapter {
    return new ModelspokeAdapter({
      settings: () => ({
        routes: [{ name: "ollama", baseURL: ollamaBaseUrl, ...route }],
        overrides: {},
      }),
      log: () => {},
    });
  }

  it("an Ollama route: the /api/show enrichment reaches resolveModel (the effort control the card already shows)", async () => {
    const adapter = makeOllamaAdapter({ models: [{ name: "glm", id: GLM }] });
    const info = await adapter.resolveModel("ollama", "glm");
    expect(info.inputModalities).toEqual(["text", "image"]); // the vision capability
    expect(info.context?.contextWindow).toBe(1048576); // the family context_length
    // The cloud glm family table (null entries canonicalized away): the
    // offered levels, in pi-ai's canonical order.
    expect(info.reasoning?.efforts.map((l) => l.id)).toEqual(["off", "low", "medium", "high", "max"]);
    expect(info.reasoning?.efforts.map((l) => l.name)).toEqual(["Off", "Low", "Medium", "High", "Max"]);
    expect(info.reasoning?.defaultEffort).toBe("medium"); // the built-in fallback, offered
    // The source contract names the discovery tier for every enriched field.
    expect(info.description).toContain("reasoning: discovery");
    expect(info.description).toContain("thinkingLevelMap: discovery");
    expect(info.description).toContain("input: discovery");
    expect(info.description).toContain("contextWindow: discovery");
  });

  it("a thinking model the family tables don't cover: NO dimension (a zero-level dimension is not expressible)", async () => {
    const adapter = makeOllamaAdapter({ models: [{ name: "kimi", id: KIMI }] });
    const info = await adapter.resolveModel("ollama", "kimi");
    expect(info.reasoning).toBeUndefined(); // zero selectable levels → no dimension, no throw
    expect(info.inputModalities).toEqual(["text"]); // no vision capability
    expect(info.context?.contextWindow).toBe(131072); // the discovered context still applies
  });
});

describe("backend registry scan — a bare catalog (every probe 404s: definitive non-match)", () => {
  it("the registry scans (the probes fire) and the generic rows hold (C6/C10: no match, no crash)", async () => {
    const adapter = makeAdapter({ models: [{ name: "G", id: GEMMA }] });
    const before = hits.length;
    const info = await adapter.resolveModel("ms", "G");
    expect(info.reasoning).toBeUndefined(); // no preset, no backend claim → the default tier
    expect(info.context?.contextWindow).toBe(262144); // the fallback (no tier supplied)
    const fresh = hits.slice(before);
    // The scan consulted the registry in locked order — these probes 404ed
    // (C10: a definitive non-match each) and the pass degraded to generic.
    expect(fresh).toContain("/model_info"); // sglang
    expect(fresh).toContain("/api/version"); // ollama
    expect(fresh).toContain("/api/v1/models"); // lmstudio
    expect(fresh).toContain("/props"); // llamacpp
  });
});
