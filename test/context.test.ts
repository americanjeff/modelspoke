/**
 * Multi-convention chains (context, max-tokens) for
 * `extractContextWindow` / `extractMaxTokens`.
 *
 * NOTE on `max_model_len` (probe-gated adaptation): the frozen oracle
 * (`test/oracle.test.ts`, "bare" test) records a live bare-sglang entry whose
 * ONLY context signal is `max_model_len: 262144` and asserts it "advertises
 * nothing" at discovery time (all preset). So the default chain leaves the
 * position-4 slot OFF; the slot is exercised here with
 * `{ includeMaxModelLen: true }` (the opt-in bare-server/probe wiring).
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  extractContextWindow,
  extractFromEntry,
  extractMaxTokens,
} from "../src/discovery/index.js";
import type { OpenAIModelEntry } from "../src/discovery/index.js";

function entry(partial: Record<string, unknown>): OpenAIModelEntry {
  return { id: "test-model", ...partial } as OpenAIModelEntry;
}

describe("extractContextWindow — each convention slot in isolation", () => {
  it("1: top-level context_length", () => {
    expect(extractContextWindow(entry({ context_length: 1000 }))).toBe(1000);
  });
  it("2: top-level max_context_length", () => {
    expect(extractContextWindow(entry({ max_context_length: 2000 }))).toBe(2000);
  });
  it("3: top-level context_window", () => {
    expect(extractContextWindow(entry({ context_window: 3000 }))).toBe(3000);
  });
  it("4: top-level max_model_len — ONLY with includeMaxModelLen (probe-gated)", () => {
    const e = entry({ max_model_len: 4000 });
    expect(extractContextWindow(e, { includeMaxModelLen: true })).toBe(4000);
    expect(extractContextWindow(e)).toBeUndefined();
  });
  it("5: meta.llamaswap.context_length", () => {
    expect(
      extractContextWindow(entry({ meta: { llamaswap: { context_length: 5000 } } })),
    ).toBe(5000);
  });
  it("6: meta.llamaswap.context", () => {
    expect(extractContextWindow(entry({ meta: { llamaswap: { context: 6000 } } }))).toBe(6000);
  });
  it("7: meta.llamaswap.max_context", () => {
    expect(
      extractContextWindow(entry({ meta: { llamaswap: { max_context: 7000 } } })),
    ).toBe(7000);
  });
  it("8: meta.llamaswap.max_context_length", () => {
    expect(
      extractContextWindow(entry({ meta: { llamaswap: { max_context_length: 8000 } } })),
    ).toBe(8000);
  });
  it("9: meta.n_ctx", () => {
    expect(extractContextWindow(entry({ meta: { n_ctx: 9000 } }))).toBe(9000);
  });
  it("10: top-level metadata.context_length (lowercase metadata legacy)", () => {
    expect(extractContextWindow(entry({ metadata: { context_length: 10000 } }))).toBe(10000);
  });
  it("11: top-level metadata.context (lowercase metadata legacy)", () => {
    expect(extractContextWindow(entry({ metadata: { context: 11000 } }))).toBe(11000);
  });
});

describe("extractContextWindow — precedence", () => {
  it("top-level context_length beats max_model_len (flag on)", () => {
    const e = entry({ context_length: 1, max_model_len: 2 });
    expect(extractContextWindow(e, { includeMaxModelLen: true })).toBe(1);
  });
  it("top-level context_length beats meta.n_ctx", () => {
    expect(extractContextWindow(entry({ context_length: 1, meta: { n_ctx: 2 } }))).toBe(1);
  });
  it("max_model_len beats meta.llamaswap.context_length (flag on)", () => {
    const e = entry({
      max_model_len: 4000,
      meta: { llamaswap: { context_length: 5000 } },
    });
    expect(extractContextWindow(e, { includeMaxModelLen: true })).toBe(4000);
  });
  it("max_model_len beats meta.n_ctx (flag on)", () => {
    const e = entry({ max_model_len: 4000, meta: { n_ctx: 9000 } });
    expect(extractContextWindow(e, { includeMaxModelLen: true })).toBe(4000);
  });
  it("meta.llamaswap.context_length beats meta.n_ctx", () => {
    const e = entry({ meta: { llamaswap: { context_length: 5000 }, n_ctx: 9000 } });
    expect(extractContextWindow(e)).toBe(5000);
  });
  it("meta.llamaswap block beats lowercase metadata block", () => {
    const e = entry({
      meta: { llamaswap: { context_length: 5000 } },
      metadata: { context_length: 10000 },
    });
    expect(extractContextWindow(e)).toBe(5000);
  });
  it("top-level context_window beats max_model_len (flag on)", () => {
    const e = entry({ context_window: 3000, max_model_len: 4000 });
    expect(extractContextWindow(e, { includeMaxModelLen: true })).toBe(3000);
  });
  it("top-level aliases order: context_length > max_context_length > context_window", () => {
    expect(
      extractContextWindow(
        entry({ context_length: 1, max_context_length: 2, context_window: 3 }),
      ),
    ).toBe(1);
    expect(
      extractContextWindow(entry({ max_context_length: 2, context_window: 3 })),
    ).toBe(2);
    expect(extractContextWindow(entry({ context_window: 3 }))).toBe(3);
  });
});

describe("extractContextWindow — invalid values fall through to the next slot", () => {
  it("0 at slot 1 falls through", () => {
    expect(extractContextWindow(entry({ context_length: 0, context_window: 3000 }))).toBe(3000);
  });
  it("negative at slot 1 falls through", () => {
    expect(extractContextWindow(entry({ context_length: -5, max_context_length: 2000 }))).toBe(
      2000,
    );
  });
  it("non-integer number falls through", () => {
    expect(extractContextWindow(entry({ context_length: 12.5, context_window: 3000 }))).toBe(
      3000,
    );
  });
  it("non-digit string falls through", () => {
    expect(extractContextWindow(entry({ context_length: "12.5", context_window: 3000 }))).toBe(
      3000,
    );
    expect(extractContextWindow(entry({ context_length: "abc", context_window: 3000 }))).toBe(
      3000,
    );
  });
  it("0 at slot 1 falls through to max_model_len (flag on)", () => {
    expect(
      extractContextWindow(entry({ context_length: 0, max_model_len: 4000 }), {
        includeMaxModelLen: true,
      }),
    ).toBe(4000);
  });
  it("invalid max_model_len (flag on) falls through to meta.llamaswap", () => {
    expect(
      extractContextWindow(
        entry({ max_model_len: 0, meta: { llamaswap: { context_length: 5000 } } }),
        { includeMaxModelLen: true },
      ),
    ).toBe(5000);
  });
  it("all-digit string is accepted", () => {
    expect(extractContextWindow(entry({ context_length: "262144" }))).toBe(262144);
  });
  it("no source at all → undefined (flag off and on)", () => {
    expect(extractContextWindow(entry({}))).toBeUndefined();
    expect(extractContextWindow(entry({}), { includeMaxModelLen: true })).toBeUndefined();
  });
  it("non-object metadata block is ignored (no throw)", () => {
    expect(extractContextWindow(entry({ metadata: "nope" }))).toBeUndefined();
    expect(extractContextWindow(entry({ metadata: ["nope"] }))).toBeUndefined();
  });
});

describe("extractMaxTokens — each convention slot in isolation", () => {
  it("1: top-level output_length", () => {
    expect(extractMaxTokens(entry({ output_length: 64 }))).toBe(64);
  });
  it("2: top-level max_tokens", () => {
    expect(extractMaxTokens(entry({ max_tokens: 128 }))).toBe(128);
  });
  it("3: meta.llamaswap.maxTokens", () => {
    expect(extractMaxTokens(entry({ meta: { llamaswap: { maxTokens: 256 } } }))).toBe(256);
  });
  it("4: meta.llamaswap.output_length", () => {
    expect(extractMaxTokens(entry({ meta: { llamaswap: { output_length: 512 } } }))).toBe(512);
  });
  it("5: meta.llamaswap.max_tokens", () => {
    expect(extractMaxTokens(entry({ meta: { llamaswap: { max_tokens: 1024 } } }))).toBe(1024);
  });
});

describe("extractMaxTokens — precedence and invalid values", () => {
  it("output_length > max_tokens > llamaswap.maxTokens > llamaswap.output_length > llamaswap.max_tokens", () => {
    const e = entry({
      output_length: 64,
      max_tokens: 128,
      meta: { llamaswap: { maxTokens: 256, output_length: 512, max_tokens: 1024 } },
    });
    expect(extractMaxTokens(e)).toBe(64);
  });
  it("top-level max_tokens beats meta.llamaswap.maxTokens", () => {
    expect(
      extractMaxTokens(entry({ max_tokens: 128, meta: { llamaswap: { maxTokens: 256 } } })),
    ).toBe(128);
  });
  it("meta.llamaswap.maxTokens beats meta.llamaswap.output_length", () => {
    expect(
      extractMaxTokens(
        entry({ meta: { llamaswap: { maxTokens: 256, output_length: 512, max_tokens: 1024 } } }),
      ),
    ).toBe(256);
  });
  it("meta.llamaswap.output_length beats meta.llamaswap.max_tokens", () => {
    expect(
      extractMaxTokens(entry({ meta: { llamaswap: { output_length: 512, max_tokens: 1024 } } })),
    ).toBe(512);
  });
  it("0 at slot 1 falls through", () => {
    expect(extractMaxTokens(entry({ output_length: 0, max_tokens: 128 }))).toBe(128);
  });
  it("non-digit string at slot 1 falls through", () => {
    expect(extractMaxTokens(entry({ output_length: "x", max_tokens: 128 }))).toBe(128);
  });
  it("non-integer number falls through to meta.llamaswap.maxTokens", () => {
    expect(extractMaxTokens(entry({ max_tokens: 1.5, meta: { llamaswap: { maxTokens: 256 } } }))).toBe(
      256,
    );
  });
  it("negative falls through", () => {
    expect(extractMaxTokens(entry({ output_length: -1, meta: { llamaswap: { maxTokens: 256 } } }))).toBe(
      256,
    );
  });
  it("all-digit string is accepted", () => {
    expect(extractMaxTokens(entry({ max_tokens: "128" }))).toBe(128);
  });
  it("no source at all → undefined", () => {
    expect(extractMaxTokens(entry({}))).toBeUndefined();
  });
});

describe("extractFromEntry — recorded flagship fixture (regression guard)", () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL("./fixtures/models-llamaswap-meta.json", import.meta.url).pathname,
      "utf8",
    ),
  ) as { data: OpenAIModelEntry[] };
  const flagship = fixture.data.find((m) => m.id === "qwen3.8-27b-6000pro")!;

  it("still yields contextWindow 262144 + maxTokens 65536", () => {
    const info = extractFromEntry(flagship);
    expect(info.discoveredCanonical?.contextWindow).toBe(262144);
    expect(info.discoveredCanonical?.maxTokens).toBe(65536);
  });
});
