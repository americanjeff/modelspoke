/**
 * Drift-checker unit tests for the minimal GGUF KV-section prefix parser
 * (scripts/gguf.ts) — the part that lets the drift checker read
 * `tokenizer.chat_template` out of a multi-GB deployment artifact from a
 * bounded prefix (no tensor-table parsing, which is what breaks the python
 * `gguf` lib on the MXFP4 file). Synthetic headers only — the real files are
 * exercised by the live drift check, not the offline suite.
 */

import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";

import { GgufPrefixError, ggufChatTemplate, parseGgufKvPrefix } from "../scripts/gguf.js";

// Synthetic GGUF writer (v3: u64 string lengths, no padding).

const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const u64 = (n: number): Buffer => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const str = (s: string): Buffer =>
  Buffer.concat([u64(Buffer.byteLength(s, "utf8")), Buffer.from(s, "utf8")]);

function encVal(v: unknown): { type: number; buf: Buffer } {
  if (typeof v === "string") return { type: 8, buf: str(v) };
  if (typeof v === "boolean") return { type: 7, buf: Buffer.from([v ? 1 : 0]) };
  if (typeof v === "number") return { type: 4, buf: u32(Math.floor(v)) };
  if (Array.isArray(v)) {
    if (v.every((x) => typeof x === "string")) {
      return { type: 13, buf: Buffer.concat([u64(v.length), ...(v as string[]).map(str)]) };
    }
    if (v.every((x) => typeof x === "number")) {
      return { type: 9, buf: Buffer.concat([u32(10), u64(v.length), ...(v as number[]).map(u64)]) }; // u64 array
    }
  }
  throw new Error("unsupported synthetic value");
}

function buildGguf(kvs: [string, unknown][]): Buffer {
  const parts = [
    Buffer.from("GGUF"),
    u32(3), // version
    u64(1), // tensor_count (irrelevant to the KV section)
    u64(kvs.length),
  ];
  for (const [k, v] of kvs) {
    const { type, buf } = encVal(v);
    parts.push(str(k), u32(type), buf);
  }
  return Buffer.concat(parts);
}

describe("parseGgufKvPrefix (synthetic v3 headers)", () => {
  it("parses strings, scalars, and skips arrays", () => {
    const buf = buildGguf([
      ["general.architecture", "qwen35"],
      ["general.aligned", true],
      ["qwen35.block_count", 32],
      ["tokenizer.chat_template", "HELLO\nTEMPLATE"],
      ["tokenizer.ggml.tok_type", [1, 1, 2, 3, 1]],
      ["tokenizer.ggml.merges", [11, 22, 33]],
      ["tokenizer.ggml.scores", ["a", "b"]],
    ]);
    const h = parseGgufKvPrefix(new Uint8Array(buf));
    expect(h.version).toBe(3);
    expect(h.kvCount).toBe(7);
    expect(h.tensorCount).toBe(1);
    expect(h.fields.get("general.architecture")).toBe("qwen35");
    expect(h.fields.get("general.aligned")).toBe(true);
    expect(h.fields.get("qwen35.block_count")).toBe(32); // scalar materialized (the authoring pipeline reads numeric KVs like *.context_length)
    expect(h.fields.get("tokenizer.chat_template")).toBe("HELLO\nTEMPLATE");
    expect(h.fields.get("tokenizer.ggml.tok_type")).toBe(true); // array skipped
    expect(h.fields.get("tokenizer.ggml.merges")).toBe(true);
    expect(h.fields.get("tokenizer.ggml.scores")).toBe(true);
    // kvEnd must be exactly the end of the KV section (tensor data follows).
    expect(h.kvEnd).toBe(buf.byteLength);
  });

  it("decodes string KVs from a sliced (nonzero byteOffset) buffer", () => {
    const payload = buildGguf([
      ["general.architecture", "qwen35"],
      ["tokenizer.chat_template", "OFFSET-STRING"],
    ]);
    // The payload starts mid-buffer, so string() must add the DataView's
    // byteOffset or it decodes the padding bytes instead.
    const padded = new Uint8Array(payload.byteLength + 7).fill(0xab);
    padded.set(payload, 7);
    const view = padded.subarray(7);
    expect(view.byteOffset).toBe(7);
    const h = parseGgufKvPrefix(view);
    expect(h.fields.get("general.architecture")).toBe("qwen35");
    expect(ggufChatTemplate(view)).toBe("OFFSET-STRING");
  });

  it("ggufChatTemplate extracts the template string", () => {
    const buf = buildGguf([
      ["general.architecture", "gpt-oss"],
      ["tokenizer.chat_template", "  - \"reasoning_effort\": defaults to \"medium\".\n"],
    ]);
    expect(ggufChatTemplate(new Uint8Array(buf))).toBe(
      '  - "reasoning_effort": defaults to "medium".\n',
    );
  });

  it("throws GgufPrefixError when the prefix ends mid-KV-section (grow and retry)", () => {
    const buf = buildGguf([
      ["general.architecture", "qwen35"],
      ["tokenizer.chat_template", "X".repeat(512)],
    ]);
    // Cut inside the second value: the parser must ask for more bytes.
    const cut = buf.byteLength - 16;
    expect(() => parseGgufKvPrefix(new Uint8Array(buf.subarray(0, cut)))).toThrow(GgufPrefixError);
    expect(ggufChatTemplate(new Uint8Array(buf))).toBe("X".repeat(512));
  });

  it("rejects a non-GGUF file", () => {
    expect(() => parseGgufKvPrefix(new Uint8Array(Buffer.from("not a gguf at all!")))).toThrow(/not a GGUF/);
  });

  it("rejects an unknown version", () => {
    const buf = buildGguf([["a", "b"]]);
    buf.writeUInt32LE(99, 4);
    expect(() => parseGgufKvPrefix(new Uint8Array(buf))).toThrow(/unsupported GGUF version/);
  });
});
