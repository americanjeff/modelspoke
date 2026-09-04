import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { presetCatalog } from "../src/index.js";
import type { Preset } from "../src/index.js";
import {
  checkPresetInvariants,
  diffInvariants,
  DriftExtractError,
  extractGptOssInvariants,
  extractInvariants,
  extractQwenInvariants,
} from "../scripts/drift-invariants.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const fix = (name: string): string => readFileSync(path.join(FIXTURES, name), "utf8");

function preset(id: string): Preset {
  const p = presetCatalog.find((p) => p.id === id);
  expect(p, `preset ${id} in catalog`).toBeDefined();
  return p!;
}

const t38Hub = fix("chat-template-qwen3.8-hub.jinja");
const t38Gguf = fix("chat-template-qwen3.8-gguf.jinja");
const t36Hub = fix("chat-template-qwen3.6-hub.jinja");
const t36Gguf = fix("chat-template-qwen3.6-gguf.jinja");
const t35Hub = fix("chat-template-qwen3.5-hub.jinja");
const t35Gguf = fix("chat-template-qwen3.5-gguf.jinja");
const tOss = fix("chat-template-gpt-oss.jinja");

describe("qwen3.8 hub jinja (matching template)", () => {
  const inv = extractQwenInvariants(t38Hub);

  it("extracts the polarity table, effort tuple + default, and the preserve disjunct", () => {
    expect(inv).toEqual({
      family: "qwen",
      enableThinking: {
        present: true,
        whenTrue: "think",
        whenFalse: "nothink",
        whenUndefined: "think",
      },
      effort: {
        present: true,
        default: "xhigh",
        accepted: ["xhigh", "medium", "low"],
        guarded: true,
        aliases: {},
      },
      preserveThinking: { present: true, undefinedPreserves: true },
    });
  });

  it("passes against the catalog entry (no drift findings)", () => {
    const { findings, warnings } = checkPresetInvariants(inv, preset("qwen3.8-chat-template"));
    expect(findings).toEqual([]);
    expect(warnings).toEqual([]);
  });
});

describe("qwen3.8 GGUF-embedded copy (divergent alias)", () => {
  const inv = extractQwenInvariants(t38Gguf);

  it("extracts the 'high' -> 'xhigh' alias the 'Unsloth fixes' add before the raise-guard", () => {
    expect(inv.effort).toEqual({
      present: true,
      default: "xhigh",
      accepted: ["xhigh", "medium", "low"],
      guarded: true,
      aliases: { high: "xhigh" },
    });
  });

  it("still passes against the catalog entry (the catalog's values are valid for both copies)", () => {
    expect(checkPresetInvariants(inv, preset("qwen3.8-chat-template")).findings).toEqual([]);
  });

  it("diffInvariants vs the hub copy flags exactly the alias divergence", () => {
    const hub = extractQwenInvariants(t38Hub);
    const diffs = diffInvariants(hub, inv);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toBe('effort.aliases.high: undefined vs "xhigh"');
  });
});

describe("qwen3.6 (hub and GGUF copies)", () => {
  for (const [name, text] of [
    ["hub jinja", t36Hub],
    ["GGUF copy", t36Gguf],
  ] as const) {
    it(`${name}: no effort, strip-on-undefined preserve, same polarity as 3.8`, () => {
      const inv = extractQwenInvariants(text);
      expect(inv).toEqual({
        family: "qwen",
        enableThinking: {
          present: true,
          whenTrue: "think",
          whenFalse: "nothink",
          whenUndefined: "think",
        },
        effort: { present: false, default: null, accepted: null, guarded: false, aliases: {} },
        preserveThinking: { present: true, undefinedPreserves: false },
      });
    });

    it(`${name}: passes against the catalog entry`, () => {
      const inv = extractQwenInvariants(text);
      expect(checkPresetInvariants(inv, preset("qwen3.6-chat-template")).findings).toEqual([]);
    });
  }

  it("hub and GGUF copies are invariant-identical (no divergence)", () => {
    expect(diffInvariants(extractQwenInvariants(t36Hub), extractQwenInvariants(t36Gguf))).toEqual([]);
  });

  it("a catalog entry that STOPS sending preserve_thinking: true is a finding (silent multi-turn regression)", () => {
    const p = preset("qwen3.6-chat-template");
    const kwargs = { ...p.compat!.chatTemplateKwargs! } as Record<string, unknown>;
    delete kwargs["preserve_thinking"];
    const mutated: Preset = {
      ...p,
      compat: { ...p.compat!, chatTemplateKwargs: kwargs },
    };
    const { findings } = checkPresetInvariants(extractQwenInvariants(t36Gguf), mutated);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatch(/STRIPS prior-turn thinking/);
  });

  it("dropping preserve_thinking on 3.8 (undefined preserves) is only a warning", () => {
    const p = preset("qwen3.8-chat-template");
    const kwargs = { ...p.compat!.chatTemplateKwargs! } as Record<string, unknown>;
    delete kwargs["preserve_thinking"];
    const mutated: Preset = {
      ...p,
      compat: { ...p.compat!, chatTemplateKwargs: kwargs },
    };
    const { findings, warnings } = checkPresetInvariants(extractQwenInvariants(t38Hub), mutated);
    expect(findings).toEqual([]);
    expect(warnings.some((w) => w.includes("optional"))).toBe(true);
  });
});

describe("qwen3.5 (inverted polarity in the GGUF copy)", () => {
  it("GGUF copy: UNDEFINED enable_thinking = nothink (the load-bearing fact)", () => {
    const inv = extractQwenInvariants(t35Gguf);
    expect(inv.enableThinking).toEqual({
      present: true,
      whenTrue: "think",
      whenFalse: "nothink",
      whenUndefined: "nothink",
    });
    expect(inv.effort.present).toBe(false);
    expect(inv.preserveThinking).toEqual({ present: false, undefinedPreserves: null });
  });

  it("GGUF copy: the explicit-boolean contract holds, so the catalog entry passes", () => {
    expect(checkPresetInvariants(extractQwenInvariants(t35Gguf), preset("qwen3.5-chat-template")).findings).toEqual([]);
  });

  it("hub copy: UNDEFINED enable_thinking = think (official polarity)", () => {
    const inv = extractQwenInvariants(t35Hub);
    expect(inv.enableThinking.whenUndefined).toBe("think");
  });

  it("hub copy also passes the catalog checks (values valid against both copies)", () => {
    expect(checkPresetInvariants(extractQwenInvariants(t35Hub), preset("qwen3.5-chat-template")).findings).toEqual([]);
  });

  it("cross-copy divergence is exactly the undefined state", () => {
    const diffs = diffInvariants(extractQwenInvariants(t35Gguf), extractQwenInvariants(t35Hub));
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toBe('enableThinking.whenUndefined: "nothink" vs "think"');
  });
});

describe("effort tuple changed (raise-guard detection)", () => {
  it("a template whose guard no longer accepts xhigh is a finding", () => {
    const mutated = t38Hub.replace("('xhigh', 'medium', 'low')", "('high', 'medium', 'low')");
    expect(mutated).not.toBe(t38Hub);
    const inv = extractQwenInvariants(mutated);
    expect(inv.effort.accepted).toEqual(["high", "medium", "low"]);
    const { findings } = checkPresetInvariants(inv, preset("qwen3.8-chat-template"));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatch(/xhigh.*raise-guard tuple \(high, medium, low\).*400/);
  });

  it("the GGUF alias rescues 'high' when the hub copy raises on it (alias resolution)", () => {
    const hubMut = t38Hub.replace("('xhigh', 'medium', 'low')", "('xhigh', 'medium')");
    const ggufMut = t38Gguf.replace("('xhigh', 'medium', 'low')", "('xhigh', 'medium')");
    const hubInv = extractQwenInvariants(hubMut);
    const ggufInv = extractQwenInvariants(ggufMut);
    const p = preset("qwen3.8-chat-template");
    expect(checkPresetInvariants(hubInv, p).findings).toHaveLength(1);
    expect(checkPresetInvariants(ggufInv, p).findings).toHaveLength(1);
    expect(checkPresetInvariants(hubInv, p).findings[0]).toMatch(/low/);
  });

  it("a guard tuple with an EXTRA alias-only value still passes (conservative direction)", () => {
    // The real-world qwen3.8 GGUF case: hub tuple is the contract, the gguf
    // adds 'high' as an alias — catalog values {low,medium,xhigh} remain valid.
    expect(checkPresetInvariants(extractQwenInvariants(t38Gguf), preset("qwen3.8-chat-template")).findings).toEqual([]);
  });
});

describe("polarity flip", () => {
  it("flipping the nothink gate to 'is true' is caught (off -> think AND on -> nothink)", () => {
    const mutated = t38Hub.replace(
      "enable_thinking is defined and enable_thinking is false",
      "enable_thinking is defined and enable_thinking is true",
    );
    expect(mutated).not.toBe(t38Hub);
    const inv = extractQwenInvariants(mutated);
    expect(inv.enableThinking.whenTrue).toBe("nothink");
    expect(inv.enableThinking.whenFalse).toBe("think");
    const { findings } = checkPresetInvariants(inv, preset("qwen3.8-chat-template"));
    expect(findings).toHaveLength(2);
    expect(findings.some((f) => f.includes("off state") && f.includes("nothink — must be nothink") || (f.includes("off state")))).toBe(true);
    expect(findings.some((f) => f.includes("enable_thinking=true lands in nothink"))).toBe(true);
  });

  it("the 3.5 GGUF shape (think only when explicitly true) is a distinct table", () => {
    const inv = extractQwenInvariants(t35Gguf);
    expect([inv.enableThinking.whenTrue, inv.enableThinking.whenFalse, inv.enableThinking.whenUndefined]).toEqual([
      "think",
      "nothink",
      "nothink",
    ]);
  });
});

describe("novel template shapes fail loud (DriftExtractError, not a silent pass)", () => {
  it("an unrecognized gate condition throws", () => {
    const mutated = t38Hub.replace(
      "enable_thinking is undefined or enable_thinking is true",
      "enable_thinking == 1",
    );
    expect(() => extractQwenInvariants(mutated)).toThrow(DriftExtractError);
  });

  it("a gpt-oss template that starts VALIDATING effort throws (vocabulary no longer human-safe)", () => {
    const mutated = tOss.replace(
      '{%- if reasoning_effort is not defined %}',
      '{%- if reasoning_effort not in (\'low\', \'medium\', \'high\') %}\n        {{- raise_exception(\'bad effort\' ~ reasoning_effort) }}\n    {%- elif reasoning_effort is not defined %}',
    );
    expect(() => extractGptOssInvariants(mutated)).toThrow(DriftExtractError);
  });
});

describe("gpt-oss-120b (matching template)", () => {
  const inv = extractInvariants("gpt-oss", tOss);

  it("extracts effort-only surface: default medium, NO validation, unconditional analysis channel", () => {
    expect(inv).toEqual({
      family: "gpt-oss",
      enableThinking: { present: false, whenTrue: null, whenFalse: null, whenUndefined: null },
      effort: { present: true, default: "medium", accepted: null, guarded: false, aliases: {} },
      preserveThinking: { present: false, undefinedPreserves: null },
      rendersReasoningLine: true,
    });
  });

  it("passes against the catalog entry; the vocabulary is reported as human-authored (warnings only)", () => {
    const { findings, warnings } = checkPresetInvariants(inv, preset("gpt-oss-120b-chat-template"));
    expect(findings).toEqual([]);
    expect(warnings).toHaveLength(3); // low, medium, high
    expect(warnings.every((w) => w.includes("human-authored"))).toBe(true);
  });

  it("a changed default ('medium' -> 'low') is a finding: the off mapping must track the template default", () => {
    const mutated = tOss.replace('set reasoning_effort = "medium"', 'set reasoning_effort = "low"');
    expect(mutated).not.toBe(tOss);
    const inv2 = extractGptOssInvariants(mutated);
    expect(inv2.effort.default).toBe("low");
    const { findings } = checkPresetInvariants(inv2, preset("gpt-oss-120b-chat-template"));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatch(/off='medium' must equal the template's default 'low'/);
  });

  it("a template that gains enable_thinking is a finding (the preset would leave the knob un-driven)", () => {
    const mutated = tOss + "\n{%- if enable_thinking %}\n    {%- endif %}\n";
    const inv2 = extractGptOssInvariants(mutated);
    expect(inv2.enableThinking.present).toBe(true);
    const { findings } = checkPresetInvariants(inv2, preset("gpt-oss-120b-chat-template"));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatch(/template reads enable_thinking but the preset never sends it/);
  });

  it("the unconditional Reasoning: line is load-bearing: removing it is a finding", () => {
    const mutated = tOss.replace('{{- "Reasoning: " + reasoning_effort + "\\n\\n" }}', "{{- 'noop' }}");
    expect(mutated).not.toBe(tOss);
    const inv2 = extractGptOssInvariants(mutated);
    expect(inv2.rendersReasoningLine).toBe(false);
    const { findings } = checkPresetInvariants(inv2, preset("gpt-oss-120b-chat-template"));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatch(/analysis-channel contract changed/);
  });
});

describe("extractInvariants dispatch", () => {
  it("routes by family", () => {
    expect(extractInvariants("qwen", t38Hub)).toEqual(extractQwenInvariants(t38Hub));
    expect(extractInvariants("gpt-oss", tOss)).toEqual(extractGptOssInvariants(tOss));
  });

  it("diffInvariants is symmetric in content (order only)", () => {
    const a = extractQwenInvariants(t35Gguf);
    const b = extractQwenInvariants(t35Hub);
    const ab = diffInvariants(a, b);
    const ba = diffInvariants(b, a);
    expect(ba.map((d) => d.replace(/: ".*" vs ".*"/, ": X vs Y"))).toEqual(
      ab.map((d) => d.replace(/: ".*" vs ".*"/, ": X vs Y")),
    );
  });
});
