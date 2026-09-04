/**
 * The discovery conformance-corpus loader (contract/ — the shareable,
 * language-neutral fixture corpus for the five tier-2 discovery backends).
 *
 * The corpus (contract/fixtures/<backend>.json) is
 * the SINGLE SOURCE OF TRUTH for every discovery-backend test vector: the
 * five test files load their inputs, fetch scripts, and expected values
 * from it, and the sibling Go port (modelspoke-smith) replays the same
 * vectors against its own implementation. See contract/README.md for the
 * vector format specification.
 *
 * This module is test-tree-only infrastructure: it is never imported from
 * src/ and never ships.
 */

import { readFileSync } from "node:fs";
import { expect } from "vitest";

/** One scripted fake-fetch rule (the ordered request/response steps). */
export interface FetchStep {
  /** Request matcher — ALL provided fields must match; omitted = catch-all. */
  when?: {
    /** The call URL string must end with this suffix. */
    pathSuffix?: string;
    /** Exact URL match. */
    url?: string;
    /** Uppercased HTTP method equality. */
    method?: string;
    bodyJson?: unknown;
  };
  /** The scripted reply (exactly one of json/text/throw). */
  reply?: {
    /** JSON body (the fake stringifies it; Content-Type application/json). */
    json?: unknown;
    /** Raw body text (e.g. "{ not json"). */
    text?: string;
    /** HTTP status (default 200). */
    status?: number;
    /** "network" → TypeError("fetch failed"); "abort" → DOMException AbortError. */
    throw?: "network" | "abort";
  };
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  bodyJson: unknown;
  signal: AbortSignal | undefined | null;
}

interface CorpusFile {
  corpus: string;
  formatVersion: number;
  backend: string;
  fixtures: Record<string, unknown>;
  pins?: Record<string, unknown>;
  vectors: VectorRecord[];
}

/** One test vector as stored in the corpus (before $ref resolution). */
interface VectorRecord {
  id: string;
  op: string;
  suite?: string;
  title?: string;
  input?: Record<string, unknown>;
  fetch?: FetchStep[];
  expect?: Record<string, unknown>;
}

/** A resolved vector: "$NAME" references replaced with the fixture values. */
export interface Vector {
  id: string;
  op: string;
  suite?: string;
  title?: string;
  input: Record<string, unknown>;
  fetch: FetchStep[];
  expect: Record<string, unknown>;
}

const cache = new Map<string, CorpusFile>();

function loadCorpus(name: string): CorpusFile {
  let corpus = cache.get(name);
  if (corpus === undefined) {
    const raw = readFileSync(
      new URL(`../contract/fixtures/${name}.json`, import.meta.url),
      "utf8",
    );
    corpus = JSON.parse(raw) as CorpusFile;
    cache.set(name, corpus);
  }
  return corpus;
}

function resolveRef(corpus: CorpusFile, value: unknown, seen: Set<string>): unknown {
  if (typeof value === "string") {
    if (!value.startsWith("$")) return value;
    const name = value.slice(1);
    if (!Object.prototype.hasOwnProperty.call(corpus.fixtures, name)) {
      throw new Error(`corpus ${corpus.backend}: unknown $ref "${value}"`);
    }
    if (seen.has(name)) throw new Error(`corpus ${corpus.backend}: $ref cycle at "${name}"`);
    return resolveRef(corpus, corpus.fixtures[name], new Set([...seen, name]));
  }
  if (Array.isArray(value)) return value.map((element) => resolveRef(corpus, element, seen));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, element] of Object.entries(value)) out[key] = resolveRef(corpus, element, seen);
    return out;
  }
  return value;
}

export function vectorsOf(backend: string, op?: string): Vector[] {
  const corpus = loadCorpus(backend);
  return corpus.vectors
    .filter((vector) => op === undefined || vector.op === op)
    .map((vector) => ({
      ...vector,
      input: resolveRef(corpus, vector.input ?? {}, new Set()) as Record<string, unknown>,
      fetch: resolveRef(corpus, vector.fetch ?? [], new Set()) as FetchStep[],
      expect: resolveRef(corpus, vector.expect ?? {}, new Set()) as Record<string, unknown>,
    }));
}

/** The single vector with exactly this id (throws when absent). */
export function vectorOf(backend: string, id: string): Vector {
  const found = vectorsOf(backend).find((vector) => vector.id === id);
  if (found === undefined) throw new Error(`corpus ${backend}: no vector "${id}"`);
  return found;
}

export function fixtureOf<T = unknown>(backend: string, name: string): T {
  const corpus = loadCorpus(backend);
  if (!Object.prototype.hasOwnProperty.call(corpus.fixtures, name)) {
    throw new Error(`corpus ${backend}: no fixture "${name}"`);
  }
  return resolveRef(corpus, `$${name}`, new Set()) as T;
}

/** A named corpus pin (e.g. the lmstudio registry pins). */
export function pinOf<T = unknown>(backend: string, name: string): T {
  const corpus = loadCorpus(backend);
  const value = corpus.pins?.[name];
  if (value === undefined) throw new Error(`corpus ${backend}: no pin pins.${name}`);
  return value as T;
}

function headersOf(init: RequestInit | undefined): Record<string, string> {
  const raw = init?.headers as Record<string, unknown> | undefined;
  const out: Record<string, string> = {};
  if (raw !== undefined && typeof raw === "object" && raw !== null) {
    for (const [key, value] of Object.entries(raw)) out[key] = String(value);
  }
  return out;
}

function stepMatches(
  step: FetchStep,
  call: { url: string; method: string; bodyJson: unknown },
): boolean {
  const when = step.when;
  if (when === undefined) return true;
  if (when.pathSuffix !== undefined && !call.url.endsWith(when.pathSuffix)) return false;
  if (when.url !== undefined && call.url !== when.url) return false;
  if (when.method !== undefined && call.method !== when.method.toUpperCase()) return false;
  if (
    when.bodyJson !== undefined &&
    JSON.stringify(call.bodyJson) !== JSON.stringify(when.bodyJson)
  ) {
    return false;
  }
  return true;
}

/**
 * Builds a test fetchImpl from a vector's fetch-script steps: the recorded
 * call log rides along for the expectation asserts. An unmatched request
 * answers 404 "nope" (the channel-stub default).
 */
export function fakeFetch(steps: FetchStep[] | undefined): {
  fetchImpl: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const script = steps ?? [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = headersOf(init);
    const body = typeof init?.body === "string" ? init.body : null;
    let bodyJson: unknown = null;
    if (body !== null) {
      try {
        bodyJson = JSON.parse(body);
      } catch {
        bodyJson = undefined;
      }
    }
    calls.push({ url, method, headers, body, bodyJson, signal: init?.signal });
    for (const step of script) {
      if (!stepMatches(step, { url, method, bodyJson })) continue;
      const reply = step.reply ?? {};
      if (reply.throw === "network") throw new TypeError("fetch failed");
      if (reply.throw === "abort") throw new DOMException("Aborted", "AbortError");
      const status = reply.status ?? 200;
      const payload = reply.json !== undefined ? JSON.stringify(reply.json) : (reply.text ?? "");
      return new Response(payload, {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("nope", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** An already-aborted signal (the C6 abort cases spell input.signal "preaborted"). */
export function signalOf(input: Record<string, unknown>): AbortSignal | undefined {
  if (input.signal !== "preaborted") return undefined;
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}

export function apiKeyOf(input: Record<string, unknown>): { apiKey?: string } {
  return typeof input.apiKey === "string" ? { apiKey: input.apiKey } : {};
}

/** Dotted-path getter (returns undefined when any hop is absent). */
function at(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const key of path.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function expectEq(actual: unknown, expected: unknown, label: string): void {
  if (expected === null) {
    expect(actual, label).toBeUndefined();
    return;
  }
  expect(actual, label).toEqual(expected);
}

/**
 * Asserts an op result (and its fetch-call log) against a vector's
 * expectation block. Supported blocks (all optional, all documented in
 * contract/README.md):
 * - eq — whole-result deep-equal (JSON null ⇒ the result must be undefined)
 * - fields — { "dotted.path": value | {falsy}|{defined} | null } per-field asserts
 * - fetchCount — exact number of fetch calls
 * - neverSuffixes — URL suffixes with zero recorded calls
 * - suffixCounts — [{ suffix, count }] exact per-suffix call counts
 * - calls — ordered per-call matchers (url / urlSuffix / method / headers
 *   subset / notHeaders / bodyJson / signal: "given")
 * - byId / byIdFields / byIdAbsent / byIdSize / byIdKeys — Map<string, canonical|null>
 *   (byIdKeys asserts the SORTED key set; byIdSize the exact size)
 * - rows / gated / notes / jsonNotContains
 */
export function assertExpect(
  result: unknown,
  exp: Record<string, unknown> | undefined,
  calls: RecordedCall[] = [],
  label = "",
): void {
  const prefix = label.length > 0 ? `${label}: ` : "";
  if (exp === undefined) return;
  if ("eq" in exp) expectEq(result, exp.eq, prefix);
  if ("defined" in exp) expect(result, `${prefix}result defined`).toBeDefined();
  const fields = exp.fields as Record<string, unknown> | undefined;
  if (fields !== undefined) {
    for (const [path, wanted] of Object.entries(fields)) {
      const actual = at(result, path);
      if (wanted !== null && typeof wanted === "object" && "falsy" in (wanted as object)) {
        expect(actual, `${prefix}${path}`).toBeFalsy();
      } else if (wanted !== null && typeof wanted === "object" && "defined" in (wanted as object)) {
        expect(actual, `${prefix}${path}`).toBeDefined();
      } else {
        expectEq(actual, wanted, `${prefix}${path}`);
      }
    }
  }
  const jsonNot = exp.jsonNotContains as string[] | undefined;
  if (jsonNot !== undefined) {
    const rendered = JSON.stringify(result);
    for (const needle of jsonNot) expect(rendered, prefix).not.toContain(needle);
  }
  if ("urls" in exp) {
    expect(calls.map((call) => call.url), `${prefix}urls`).toEqual(exp.urls);
  }
  if ("fetchCount" in exp) expect(calls.length, `${prefix}fetchCount`).toBe(exp.fetchCount);
  for (const suffix of (exp.neverSuffixes as string[] | undefined) ?? []) {
    expect(
      calls.filter((call) => call.url.endsWith(suffix)),
      `${prefix}neverSuffixes ${suffix}`,
    ).toHaveLength(0);
  }
  for (const { suffix, count } of
    (exp.suffixCounts as Array<{ suffix: string; count: number }> | undefined) ?? []
  ) {
    expect(
      calls.filter((call) => call.url.endsWith(suffix)),
      `${prefix}suffix ${suffix}`,
    ).toHaveLength(count);
  }
  const callExpects = (exp.calls as Array<Record<string, unknown>> | undefined) ?? [];
  callExpects.forEach((wanted, index) => {
    const callIndex = typeof wanted.index === "number" ? wanted.index : index;
    const call = calls[callIndex];
    expect(call, `${prefix}call ${callIndex} recorded`).toBeDefined();
    if (call === undefined) return;
    if (wanted.url !== undefined) expect(call.url, `${prefix}url`).toBe(wanted.url);
    if (wanted.urlSuffix !== undefined) {
      expect(
        call.url.endsWith(wanted.urlSuffix as string),
        `${prefix}urlSuffix ${wanted.urlSuffix}`,
      ).toBe(true);
    }
    if (wanted.method !== undefined) expect(call.method, `${prefix}method`).toBe(wanted.method);
    if (wanted.headers !== undefined) {
      expect(call.headers, `${prefix}headers`).toMatchObject(wanted.headers as object);
    }
    for (const header of (wanted.notHeaders as string[] | undefined) ?? []) {
      expect(call.headers[header], `${prefix}no ${header} header`).toBeUndefined();
    }
    if (wanted.bodyJson !== undefined) {
      expect(call.bodyJson, `${prefix}body`).toEqual(wanted.bodyJson);
    }
    if (wanted.signal === "given") {
      expect(call.signal, `${prefix}signal rides`).toBeDefined();
    }
  });
  const byId = exp.byId as Array<Record<string, unknown>> | undefined;
  const byIdFields = exp.byIdFields as Record<string, Record<string, unknown>> | undefined;
  const byIdBlocks =
    byId !== undefined || exp.byIdFields !== undefined || exp.byIdAbsent !== undefined ||
    "byIdSize" in exp || "byIdKeys" in exp;
  if (byIdBlocks) {
    // Both op spellings: a raw Map (pure rows seams) or BackendRows {byId}.
    const raw = result as { byId?: Map<string, unknown> };
    const map =
      raw !== null &&
      typeof raw === "object" &&
      typeof (raw as { byId?: unknown }).byId?.has === "function"
        ? (raw.byId as Map<string, unknown>)
        : (result as Map<string, unknown>);
    for (const entry of byId ?? []) {
      expect(map.has(entry.id as string), `${prefix}byId has ${entry.id}`).toBe(true);
      if ("canonical" in entry) expectEq(map.get(entry.id as string), entry.canonical, `${prefix}byId ${entry.id}`);
    }
    if (byIdFields !== undefined) {
      for (const [id, fields] of Object.entries(byIdFields)) {
        const value = map.get(id);
        for (const [path, wanted] of Object.entries(fields)) {
          if (wanted !== null && typeof wanted === "object" && "defined" in (wanted as object)) {
            expect(at(value, path), `${prefix}byId ${id}.${path}`).toBeDefined();
          } else {
            expectEq(at(value, path), wanted, `${prefix}byId ${id}.${path}`);
          }
        }
      }
    }
    for (const id of (exp.byIdAbsent as string[] | undefined) ?? []) {
      expect(map.has(id), `${prefix}byId absent ${id}`).toBe(false);
    }
    if ("byIdSize" in exp) expect(map.size, `${prefix}byIdSize`).toBe(exp.byIdSize);
    if ("byIdKeys" in exp) {
      expect([...map.keys()].sort(), `${prefix}byIdKeys`).toEqual(exp.byIdKeys);
    }
  }
  if ("rows" in exp) expectEq((result as { rows?: unknown }).rows ?? result, exp.rows, `${prefix}rows`);
  if ("gated" in exp) expectEq((result as { gated?: unknown }).gated ?? result, exp.gated, `${prefix}gated`);
  if ("notes" in exp) expectEq((result as { notes?: unknown }).notes, exp.notes, `${prefix}notes`);
}