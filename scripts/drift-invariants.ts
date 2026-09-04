/**
 * Pure, mechanical invariant extraction from jinja chat templates, and
 * the comparison of those invariants against a catalog `Preset`.
 *
 * This module is the re-derivation half of the drift checker
 * (scripts/preset-drift-check.ts). It is PURE: no I/O, no catalog import —
 * the catalog entry is passed in.
 *
 * Fail-loud: an unrecognized template shape THROWS DriftExtractError (the
 * checker reports it as drift — a contract copy that no longer matches the
 * known shape is stale by definition; the sha pin firing is the backstop for
 * shapes the patterns still "accept").
 *
 * Extraction scope and deliberate exclusions: docs/design.md ("Moved from
 * code").
 *
 * Executable under Node >= 22.18 native TS stripping (no flag) / Node 22.6-
 * 22.17 with --experimental-strip-types. No non-erasable syntax (erasable-
 * only: types, interfaces, const, classes with no parameter properties).
 */

import type { Preset } from "../src/types.ts";

type TriState = "true" | "false" | "undefined";

export type ThinkState = "think" | "nothink";

export type InvariantFamily = "qwen" | "gpt-oss";

/**
 * The enable_thinking truth table: which branch each input state lands in.
 * `null` = no generation gate of this family (gpt-oss has no
 * enable_thinking; the states are not defined).
 */
export interface EnableThinkingInvariant {
  /** The template reads the variable at all. */
  present: boolean;
  whenTrue: ThinkState | null;
  whenFalse: ThinkState | null;
  whenUndefined: ThinkState | null;
}

/** The reasoning_effort surface, as the template states it. */
export interface EffortInvariant {
  present: boolean;
  /** `reasoning_effort|default('xhigh')` / `set reasoning_effort = "medium"` — the literal, or null when absent. */
  default: string | null;
  /**
   * The raise-guard tuple (`not in (...)`), in template order. null = the
   * template does NOT validate the value (any string renders — gpt-oss; or a
   * novel qwen shape the checker then cannot verify, surfaced as a warning).
   */
  accepted: string[] | null;
  /** true = a raise_exception follows the tuple test (the "raises on anything else" half of the contract). */
  guarded: boolean;
  /** Pre-guard rewrites: `{ "high": "xhigh" }` = an `if effort == 'high' { set effort = 'xhigh' }` pair (qwen3.8 GGUF "Unsloth fixes"). */
  aliases: Record<string, string>;
}

export interface PreserveThinkingInvariant {
  present: boolean;
  /**
   * true = the keep-branch carries the `preserve_thinking is undefined`
   * disjunct (undefined PRESERVES prior thinking — qwen3.8); false = the
   * keep-branch requires `is true` (undefined STRIPS — qwen3.6, where
   * sending `true` is behaviorally required). null = variable absent.
   */
  undefinedPreserves: boolean | null;
}

export interface TemplateInvariants {
  family: InvariantFamily;
  enableThinking: EnableThinkingInvariant;
  effort: EffortInvariant;
  preserveThinking: PreserveThinkingInvariant;
  /** gpt-oss only: the template unconditionally renders "Reasoning: <effort>" into the system message (the analysis channel is always emitted — "off" is not a think-off). */
  rendersReasoningLine?: boolean;
}

/** Thrown when the template no longer matches the known dialect shape. */
export class DriftExtractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DriftExtractError";
  }
}

/** The Qwen dialect uses exactly these four atoms; anything else is a new shape -> fail loud. */
function evalAtomic(atom: string, s: TriState): boolean {
  const m = atom.trim().match(/^enable_thinking\s+is\s+(undefined|defined|true|false)$/);
  if (!m || !m[1]) {
    throw new DriftExtractError(`unrecognized enable_thinking test: "${atom.trim()}"`);
  }
  switch (m[1]) {
    case "undefined":
      return s === "undefined";
    case "defined":
      return s !== "undefined";
    case "true":
      return s === "true";
    case "false":
      return s === "false";
    default:
      throw new DriftExtractError(`unrecognized enable_thinking test: "${atom.trim()}"`);
  }
}

/**
 * Evaluate a flat `and`/`or` condition (the forms the four Qwen lineages
 * use: `is undefined or is true`, `is defined and is false`, `is defined
 * and is true`). No nesting/parens — a more complex condition is a new
 * shape -> fail loud.
 */
export function evalCondition(cond: string, s: TriState): boolean {
  const orParts = cond.split(/\s+or\s+/);
  return orParts.some((part) =>
    part
      .split(/\s+and\s+/)
      .every((atom) => evalAtomic(atom, s)),
  );
}

/**
 * The think-branch open literal, file text (literal backslash-n):
 * `{{- ' think>\n' }}` — a quoted ` think>` immediately followed by exactly
 * one `\n` and the closing quote. The nothink sentinel is
 * `{{- ' think>\n\n\n' }}`: several `\n` before the quote, so it can never
 * match this pattern (a quote must follow ` think>\n`). All four Qwen
 * lineages (3.5/3.6/3.8, hub and GGUF copies) use this token.
 */
const THINK_OPEN_RE = /'<think>\\n'\s*\}\}/;

interface Gate {
  line: number; // 1-based
  cond: string;
  thenEmitsThink: boolean;
  hasElse: boolean;
  elseEmitsThink: boolean;
}

/** `{%- if cond %}` (dash/whitespace variants, any indentation) — the generation gates. */
const IF_LINE_RE = /^\s*\{%-?\s*if\s+(.+?)\s*%\}$/;
const ELSE_LINE_RE = /^\s*\{%-?\s*else\s*%\}$/;
const ELIF_LINE_RE = /^\s*\{%-?\s*elif\s+/;
const DEPTH_OPEN_RE = /^\s*\{%-?\s*(if|for)\b/;
const DEPTH_CLOSE_RE = /^\s*\{%-?\s*(endif|endfor)\b/;

/** Branch text is collected with if/for depth tracking so nested blocks (the effort pre-pass, the message loop) cannot leak into a branch's classification. */
function findGates(lines: string[]): Gate[] {
  const gates: Gate[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = (lines[i] ?? "").match(IF_LINE_RE);
    if (!m || !m[1] || !m[1].includes("enable_thinking")) continue;
    let depth = 0;
    let side: "then" | "else" | null = "then";
    let thenText = "";
    let elseText = "";
    let hasElse = false;
    let closed = false;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j] ?? "";
      if (DEPTH_CLOSE_RE.test(l)) {
        if (depth === 0) {
          closed = true;
          break;
        }
        depth--;
      } else if (DEPTH_OPEN_RE.test(l)) {
        depth++;
      } else if (side !== null && depth === 0) {
        if (ELSE_LINE_RE.test(l)) {
          hasElse = true;
          side = "else";
        } else if (ELIF_LINE_RE.test(l)) {
          throw new DriftExtractError(
            `enable_thinking gate at line ${i + 1} uses elif — new shape, re-author: ${l.trim()}`,
          );
        }
      }
      if (side === "then") thenText += l + "\n";
      else if (side === "else") elseText += l + "\n";
    }
    if (!closed) {
      throw new DriftExtractError(`enable_thinking gate at line ${i + 1} is not closed`);
    }
    gates.push({
      line: i + 1,
      cond: m[1],
      thenEmitsThink: THINK_OPEN_RE.test(thenText),
      hasElse,
      elseEmitsThink: hasElse && THINK_OPEN_RE.test(elseText),
    });
  }
  return gates;
}

function gateTable(gates: Gate[]): {
  whenTrue: ThinkState;
  whenFalse: ThinkState;
  whenUndefined: ThinkState;
} {
  const table: Record<TriState, ThinkState> = { true: "nothink", false: "nothink", undefined: "nothink" };
  for (const s of ["true", "false", "undefined"] as const) {
    const thinks = gates.some((g) => {
      const chosenElse = !evalCondition(g.cond, s) && g.hasElse;
      const emits = evalCondition(g.cond, s) ? g.thenEmitsThink : chosenElse ? g.elseEmitsThink : false;
      return emits;
    });
    table[s] = thinks ? "think" : "nothink";
  }
  return { whenTrue: table.true, whenFalse: table.false, whenUndefined: table.undefined };
}

function extractQwenEffort(lines: string[], text: string): EffortInvariant {
  if (!/\breasoning_effort\b/.test(text)) {
    return { present: false, default: null, accepted: null, guarded: false, aliases: {} };
  }
  const dm = text.match(/reasoning_effort\s*\|\s*default\(\s*(['"])([A-Za-z0-9_]+)\1\s*\)/);
  const def = dm ? (dm[2] as string) : null;

  let accepted: string[] | null = null;
  let guarded = false;
  const am = text.match(/(?:resolved_)?reasoning_effort\s+not in\s*\(([^)]*)\)/);
  if (am) {
    accepted = [...(am[1] ?? "").matchAll(/(['"])([A-Za-z0-9_]+)\1/g)].map((m) => m[2] as string);
    // Anchor on the effort guard: non-effort guards use the same "not in (" idiom, so a bare first-match reads the wrong guard body.
    const li = lines.findIndex((l) => /(?:resolved_)?reasoning_effort\s+not in\s*\(/.test(l));
    guarded = lines.slice(li + 1, li + 4).some((l) => /raise_exception/.test(l));
  }

  // Pre-guard alias rewrites: `if resolved_reasoning_effort == 'high'`
  // followed (within 3 lines) by `set resolved_reasoning_effort = 'xhigh'`.
  const aliases: Record<string, string> = {};
  const aliasIfRe =
    /^\s*\{%-?\s*if\s+(?:resolved_)?reasoning_effort\s*==\s*(['"])([A-Za-z0-9_]+)\1\s*%\}\s*$/;
  const aliasSetRe =
    /^\s*\{%-?\s*set\s+(?:resolved_)?reasoning_effort\s*=\s*(['"])([A-Za-z0-9_]+)\1\s*%\}\s*$/;
  for (let i = 0; i < lines.length; i++) {
    const cm = (lines[i] ?? "").match(aliasIfRe);
    if (!cm) continue;
    const src = cm[2];
    if (!src) continue;
    for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
      const dst = (lines[j] ?? "").match(aliasSetRe)?.[2];
      if (dst) {
        aliases[src] = dst;
        break;
      }
    }
  }

  return { present: true, default: def, accepted, guarded, aliases };
}

function extractQwenPreserve(lines: string[], text: string): PreserveThinkingInvariant {
  if (!/\bpreserve_thinking\b/.test(text)) {
    return { present: false, undefinedPreserves: null };
  }
  const keep = lines.find(
    (l) => l.includes("preserve_thinking") && l.includes("loop.index0 > ns.last_query_index"),
  );
  if (!keep) {
    throw new DriftExtractError(
      "preserve_thinking present but the keep-branch condition (loop.index0 > ns.last_query_index) was not found — template shape changed",
    );
  }
  return {
    present: true,
    undefinedPreserves: /preserve_thinking\s+is\s+undefined/.test(keep),
  };
}

function extractGptOssEffort(lines: string[], text: string): EffortInvariant {
  if (!/\breasoning_effort\b/.test(text)) {
    return { present: false, default: null, accepted: null, guarded: false, aliases: {} };
  }
  if (/reasoning_effort\s+not in/.test(text) || /raise_exception[^%\n]*effort/.test(text)) {
    throw new DriftExtractError(
      "gpt-oss template now VALIDATES reasoning_effort (a raise/guard appeared) — the human-authored {low,medium,high} vocabulary is no longer safe to assert; re-author",
    );
  }
  let def: string | null = null;
  const di = lines.findIndex((l) => /reasoning_effort\s+is not defined/.test(l));
  if (di >= 0) {
    const sm = lines
      .slice(di + 1, di + 4)
      .find((l) => /^\s*\{%-?\s*set\s+reasoning_effort\s*=\s*(['"])([A-Za-z0-9_]+)\1/.exec(l));
    if (sm) {
      const m = sm.match(/^\s*\{%-?\s*set\s+reasoning_effort\s*=\s*(['"])([A-Za-z0-9_]+)\1/);
      def = m?.[2] ?? null;
    }
  }
  return { present: true, default: def, accepted: null, guarded: false, aliases: {} };
}

export function extractQwenInvariants(text: string): TemplateInvariants {
  const lines = text.split("\n");
  const gates = findGates(lines);
  if (gates.length === 0) {
    throw new DriftExtractError("no enable_thinking generation gate found — template shape changed");
  }
  return {
    family: "qwen",
    enableThinking: {
      present: /\benable_thinking\b/.test(text),
      ...gateTable(gates),
    },
    effort: extractQwenEffort(lines, text),
    preserveThinking: extractQwenPreserve(lines, text),
  };
}

export function extractGptOssInvariants(text: string): TemplateInvariants {
  return {
    family: "gpt-oss",
    enableThinking: {
      present: /\benable_thinking\b/.test(text),
      whenTrue: null,
      whenFalse: null,
      whenUndefined: null,
    },
    effort: extractGptOssEffort(text.split("\n"), text),
    preserveThinking: { present: /\bpreserve_thinking\b/.test(text), undefinedPreserves: null },
    rendersReasoningLine: /"Reasoning: "\s*\+\s*reasoning_effort/.test(text),
  };
}

export function extractInvariants(family: InvariantFamily, text: string): TemplateInvariants {
  switch (family) {
    case "qwen":
      return extractQwenInvariants(text);
    case "gpt-oss":
      return extractGptOssInvariants(text);
  }
}

export interface CheckResult {
  /** Contract violations: the catalog entry is no longer valid for this template. Each is a human-readable line. Non-empty => drift. */
  findings: string[];
  /** True-but-not-contract facts worth printing (unverifiable-by-construction values, copy divergences the human should know). */
  warnings: string[];
}

interface VarBinding {
  $var: string;
  omitWhenOff?: boolean;
}

function bindingOf(kwargs: Record<string, unknown>, name: string): VarBinding | null {
  const v = kwargs[name];
  if (v !== null && typeof v === "object" && "$var" in (v as Record<string, unknown>)) {
    return v as unknown as VarBinding;
  }
  return null;
}

/**
 * Compare a template's invariants against the catalog entry that was
 * authored from it. Pure; returns findings (drift) + warnings (print only).
 */
export function checkPresetInvariants(inv: TemplateInvariants, preset: Preset): CheckResult {
  const findings: string[] = [];
  const warnings: string[] = [];
  const kwargs: Record<string, unknown> = preset.compat?.chatTemplateKwargs ?? {};
  const map: Record<string, string> = (preset.thinkingLevelMap ?? {}) as Record<string, string>;

  for (const [name, present] of [
    ["enable_thinking", inv.enableThinking.present],
    ["reasoning_effort", inv.effort.present],
  ] as const) {
    if (name in kwargs && !present) {
      findings.push(`sends ${name} but the template never reads it (silent no-op)`);
    } else if (!(name in kwargs) && present) {
      findings.push(`template reads ${name} but the preset never sends it`);
    }
  }

  const sendsPreserve = "preserve_thinking" in kwargs;
  if (sendsPreserve && !inv.preserveThinking.present) {
    findings.push("sends preserve_thinking but the template never reads it (silent no-op)");
  } else if (!sendsPreserve && inv.preserveThinking.present) {
    if (inv.preserveThinking.undefinedPreserves === false) {
      findings.push(
        "template STRIPS prior-turn thinking when preserve_thinking is undefined — the preset must send preserve_thinking: true (silent multi-turn regression)",
      );
    } else {
      warnings.push(
        "template preserves prior thinking when undefined — an explicit preserve_thinking: true pin is optional (defensive)",
      );
    }
  }
  if (sendsPreserve && inv.preserveThinking.present && kwargs.preserve_thinking !== true) {
    findings.push("preserve_thinking must be the literal true (the only meaningful value)");
  }

  if (preset.reasoning !== true) {
    findings.push("template has a reasoning surface but preset.reasoning is not true");
  }
  if (preset.compat?.thinkingFormat !== "chat-template") {
    findings.push(
      `thinkingFormat '${preset.compat?.thinkingFormat}' — this family's template dialect is chat-template kwargs only`,
    );
  }

  if (inv.family === "qwen") {
    const et = inv.enableThinking;
    if (et.present) {
      const b = bindingOf(kwargs, "enable_thinking");
      if (b && b.$var !== "thinking.enabled") {
        findings.push(`enable_thinking binds {$var: "${b.$var}"}, not "thinking.enabled"`);
      }
      // The off state: the binding sends false unless it omits — the resulting
      // state MUST be nothink, and the on state MUST be think (the explicit-
      // boolean contract the whole entry rests on).
      const offViaOmit = b?.omitWhenOff === true;
      const offState = offViaOmit ? et.whenUndefined : et.whenFalse;
      if (offState !== "nothink") {
        findings.push(
          `off state (${offViaOmit ? "kwarg omitted -> undefined" : "enable_thinking=false"}) lands in ${offState} — must be nothink (polarity flip)`,
        );
      }
      if (et.whenTrue !== "think") {
        findings.push("enable_thinking=true lands in nothink — must be think (polarity flip)");
      }
    }

    if (inv.effort.present) {
      const e = inv.effort;
      const b = bindingOf(kwargs, "reasoning_effort");
      if (b && b.$var !== "thinking.effort") {
        findings.push(`reasoning_effort binds {$var: "${b.$var}"}, not "thinking.effort"`);
      }
      const resolve = (v: string): string => e.aliases[v] ?? v;
      for (const [level, value] of Object.entries(map)) {
        if (level === "off") {
          // off either omits the kwarg (template default applies, and the
          // effort lines sit inside the think branch the off state never
          // reaches) or sends map.off — the latter must be acceptable.
          if (!b?.omitWhenOff && e.accepted && !e.accepted.includes(resolve(value))) {
            findings.push(
              `off sends effort '${value}' which the template's raise-guard rejects (${e.accepted.join(", ")})`,
            );
          }
          continue;
        }
        if (e.accepted && !e.accepted.includes(resolve(value))) {
          findings.push(
            `thinkingLevelMap.${level}='${value}' is not in the template's raise-guard tuple (${e.accepted.join(", ")}) — the template raises -> mid-turn 400`,
          );
        } else if (!e.accepted) {
          warnings.push(
            `thinkingLevelMap.${level}='${value}': template reads effort with NO validation tuple — value cannot be mechanically verified`,
          );
        }
      }
      if (e.present && !e.accepted && e.default !== null) {
        warnings.push(
          `template reads effort (default '${e.default}') with no raise-guard — the effort vocabulary is no longer mechanically verifiable`,
        );
      }
    }
  }

  if (inv.family === "gpt-oss") {
    if (inv.effort.present) {
      const b = bindingOf(kwargs, "reasoning_effort");
      if (b && b.$var !== "thinking.effort") {
        findings.push(`reasoning_effort binds {$var: "${b.$var}"}, not "thinking.effort"`);
      }
      if (inv.effort.default === null) {
        findings.push(
          "gpt-oss template no longer has a mechanical effort default — the off-state mapping cannot be verified",
        );
      } else if (map.off !== undefined && map.off !== inv.effort.default) {
        findings.push(
          `thinkingLevelMap.off='${map.off}' must equal the template's default '${inv.effort.default}' (off omits the kwarg -> the template's own default applies)`,
        );
      }
      for (const [level, value] of Object.entries(map)) {
        if (level === "off") continue;
        warnings.push(
          `thinkingLevelMap.${level}='${value}': the template does NOT validate the effort value (no 400 possible) — the {low,medium,high} vocabulary is human-authored (repo README), not mechanically asserted`,
        );
      }
    }
    if (inv.rendersReasoningLine !== true) {
      findings.push(
        "the unconditional 'Reasoning: <effort>' render line is gone — the always-emitted analysis-channel contract changed",
      );
    }
  }

  return { findings, warnings };
}

/**
 * Field-level diff between two invariant records of DIFFERENT contract copies
 * of the same entry (e.g. hub jinja vs GGUF-embedded). Returns dotted paths
 * with per-copy values. Divergence between copies is NOT drift — the catalog
 * must be valid against every copy, which checkPresetInvariants already
 * proves per copy — but the human authoring the next revision must see it
 * (the qwen3.8 'high'-alias case, the qwen3.5 undefined-polarity case).
 */
export function diffInvariants(a: TemplateInvariants, b: TemplateInvariants): string[] {
  const out: string[] = [];
  const walk = (x: unknown, y: unknown, path: string): void => {
    const xo = x !== null && typeof x === "object";
    const yo = y !== null && typeof y === "object";
    if (!xo || !yo || Array.isArray(x) !== Array.isArray(y)) {
      const xs = JSON.stringify(x);
      const ys = JSON.stringify(y);
      if (xs !== ys) out.push(`${path || "(root)"}: ${xs} vs ${ys}`);
      return;
    }
    const rx = x as Record<string, unknown>;
    const ry = y as Record<string, unknown>;
    const keys = new Set([...Object.keys(rx), ...Object.keys(ry)]);
    for (const k of keys) {
      // Both-absent is not a diff (e.g. qwen records omit the optional rendersReasoningLine); absent-vs-value still reports.
      const xa = k in rx ? rx[k] : undefined;
      const ya = k in ry ? ry[k] : undefined;
      if (xa === undefined && ya === undefined) continue;
      walk(xa, ya, path ? `${path}.${k}` : k);
    }
  };
  walk(a, b, "");
  return out;
}

export function describeInvariants(inv: TemplateInvariants): string {
  const et = inv.enableThinking;
  const etStr = et.present
    ? `enable_thinking ${et.whenTrue}/${et.whenFalse}/${et.whenUndefined}`
    : "enable_thinking absent";
  const e = inv.effort;
  const eStr = e.present
    ? `effort default=${e.default ?? "-"} accepted=${e.accepted ? `[${e.accepted.join(",")}]` : "no-validation"} guard=${e.guarded ? "raise" : "none"} aliases=${JSON.stringify(e.aliases)}`
    : "effort absent";
  const p = inv.preserveThinking;
  const pStr = p.present
    ? `preserve_thinking undefined->${p.undefinedPreserves ? "preserve" : "strip"}`
    : "preserve_thinking absent";
  const parts = [etStr, eStr, pStr];
  if (inv.family === "gpt-oss") {
    parts.push(`analysis_channel=${inv.rendersReasoningLine ? "unconditional" : "gone"}`);
  }
  return parts.join(" | ");
}
