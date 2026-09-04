/**
 * Minimal GGUF header parser: the magic/version/tensor-count/kv-count
 * header plus the KEY-VALUE section only. The KV section is BEFORE any tensor
 * data, so a bounded prefix read (Range fetch / partial file read) is enough
 * to reach `tokenizer.chat_template` — this is the only thing the drift
 * checker needs from a multi-GB deployment artifact.
 *
 * Arrays are SKIPPED (not materialized) — the KV section of a 27B-class file
 * is ~11-13 MB, most of it tokenizer.merges (a u64 array). If the prefix
 * runs out mid-KV-section, GgufPrefixError is thrown so the caller can fetch
 * a larger prefix.
 *
 * Pure over a Uint8Array — unit-testable with a synthetic header
 * (only readPrefix touches the filesystem).
 *
 * Wire-format reference: docs/design.md ("Moved from code").
 */

import { closeSync, fstatSync, openSync, readSync } from "node:fs";

const GGUF_MAGIC = 0x46554747; // "GGUF" as u32 LE
const CHUNK = 256 * 1024 * 1024; // read cap: well past the largest known KV section (~13 MB)

/** The KV section extends beyond the supplied prefix — fetch/read more. */
export class GgufPrefixError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GgufPrefixError";
  }
}

export interface GgufHeader {
  version: number;
  tensorCount: number;
  kvCount: number;
  /** Offsets end of the KV section (tensor data follows after alignment). */
  kvEnd: number;
  /** Scalar + string fields. Arrays are skipped (present as true placeholders). */
  fields: Map<string, string | number | boolean>;
}

class Reader {
  private o: number;
  private dv: DataView;
  private len: number;
  constructor(dv: DataView, len: number) {
    this.dv = dv;
    this.len = len;
    this.o = 0;
  }

  private need(n: number): void {
    if (this.o + n > this.len) {
      throw new GgufPrefixError(`prefix ends at byte ${this.len}, KV section needs ${this.o + n}`);
    }
  }

  u32(): number {
    this.need(4);
    const v = this.dv.getUint32(this.o, true);
    this.o += 4;
    return v;
  }

  u64(): number {
    this.need(8);
    const v = Number(this.dv.getBigUint64(this.o, true));
    this.o += 8;
    return v;
  }

  i64(): number {
    this.need(8);
    const v = Number(this.dv.getBigInt64(this.o, true));
    this.o += 8;
    return v;
  }

  u16(): number {
    this.need(2);
    const v = this.dv.getUint16(this.o, true);
    this.o += 2;
    return v;
  }

  i16(): number {
    this.need(2);
    const v = this.dv.getInt16(this.o, true);
    this.o += 2;
    return v;
  }

  i32(): number {
    this.need(4);
    const v = this.dv.getInt32(this.o, true);
    this.o += 4;
    return v;
  }

  f32(): number {
    this.need(4);
    const v = this.dv.getFloat32(this.o, true);
    this.o += 4;
    return v;
  }

  f64(): number {
    this.need(8);
    const v = this.dv.getFloat64(this.o, true);
    this.o += 8;
    return v;
  }

  string(): string {
    const len = this.u64();
    this.need(len);
    const s = new TextDecoder("utf-8").decode(new Uint8Array(this.dv.buffer, this.dv.byteOffset + this.o, len));
    this.o += len;
    return s;
  }

  u8(): number {
    this.need(1);
    const v = this.dv.getUint8(this.o);
    this.o += 1;
    return v;
  }

  raw(n: number): void {
    this.need(n);
    this.o += n;
  }

  end(): number {
    return this.o;
  }
}

const SCALAR_ELEM_SIZE: Record<number, number> = {
  0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8, 14: 4,
};

/**
 * Parse the header + KV section from a (prefix of) a GGUF file.
 * @throws GgufPrefixError when the prefix is shorter than the KV section.
 * @throws Error on a non-GGUF file, unsupported version, or an unknown KV type.
 */
export function parseGgufKvPrefix(buf: Uint8Array): GgufHeader {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const r = new Reader(dv, buf.byteLength);

  const magic = r.u32();
  if (magic !== GGUF_MAGIC) {
    throw new Error(`not a GGUF file (magic 0x${magic.toString(16)})`);
  }
  const version = r.u32();
  if (version !== 2 && version !== 3) {
    throw new Error(`unsupported GGUF version ${version}`);
  }
  const tensorCount = r.u64();
  const kvCount = r.u64();

  const fields = new Map<string, string | number | boolean>();
  for (let i = 0; i < kvCount; i++) {
    const key = r.string();
    const vtype = r.u32();
    switch (vtype) {
      case 0:
      case 1:
      case 7:
        fields.set(key, r.u8() !== 0);
        break;
      case 2:
        fields.set(key, r.u16());
        break;
      case 3:
        fields.set(key, r.i16());
        break;
      case 4:
        fields.set(key, r.u32());
        break;
      case 5:
        fields.set(key, r.i32());
        break;
      case 6:
        fields.set(key, r.f32());
        break;
      case 8:
        fields.set(key, r.string());
        break;
      case 9: {
        const etype = r.u32();
        const count = r.u64();
        const sz = SCALAR_ELEM_SIZE[etype];
        if (sz !== undefined) {
          r.raw(sz * count);
        } else if (etype === 8) {
          for (let k = 0; k < count; k++) r.string();
        } else {
          throw new Error(`unsupported array element type ${etype} in KV "${key}"`);
        }
        fields.set(key, true); // placeholder: array skipped
        break;
      }
      case 10:
        fields.set(key, r.u64());
        break;
      case 11:
        fields.set(key, r.i64());
        break;
      case 12:
        fields.set(key, r.f64());
        break;
      case 13: {
        const count = r.u64();
        for (let k = 0; k < count; k++) r.string();
        fields.set(key, true);
        break;
      }
      case 14: {
        const count = r.u64();
        r.raw(4 * count);
        fields.set(key, true);
        break;
      }
      default:
        throw new Error(`unknown KV value type ${vtype} for "${key}" — format change?`);
    }
  }

  return { version, tensorCount, kvCount, kvEnd: r.end(), fields };
}

/**
 * Read `tokenizer.chat_template` from a (prefix of) a GGUF file.
 * @throws GgufPrefixError when more of the file is needed.
 */
export function ggufChatTemplate(buf: Uint8Array): string {
  const h = parseGgufKvPrefix(buf);
  const t = h.fields.get("tokenizer.chat_template");
  if (typeof t !== "string") {
    throw new Error("KV section parsed but tokenizer.chat_template is missing");
  }
  return t;
}

export function readPrefix(filePath: string, cap: number = CHUNK): Uint8Array {
  const fd = openSync(filePath, "r");
  try {
    const st = fstatSync(fd);
    const n = Math.min(cap, st.size);
    const buf = new Uint8Array(n);
    let off = 0;
    while (off < n) {
      const got = readSync(fd, buf, off, n - off, off);
      if (got === 0) break;
      off += got;
    }
    return off < n ? buf.subarray(0, off) : buf;
  } finally {
    closeSync(fd);
  }
}
