/**
 * First-boot log hint — unit tests (node side) for the pure decision
 * (src/dsh/boot-hint.ts `firstBootHint`).
 *
 * The once-per-boot / no-onChange-relog discipline lives in the `apply`
 * call site (src/dsh/index.ts: `settleHint` guards a `hintSettled` flag and
 * is invoked from the settings onChange — the first onChange settles, every
 * later one is a no-op) and is proven at boot in the testenv smoke gates.
 */

import { describe, expect, it } from "vitest";
import { firstBootHint } from "../src/dsh/boot-hint.js";

describe("firstBootHint", () => {
  it("returns the hint line when the section has zero routes (fresh install)", () => {
    const hint = firstBootHint({ routes: [], overrides: {} });
    expect(hint).not.toBeNull();
  });

  it("returns the hint for an absent section (schema defaults apply)", () => {
    expect(firstBootHint(undefined)).not.toBeNull();
    expect(firstBootHint(null)).not.toBeNull();
    expect(firstBootHint({})).not.toBeNull();
  });

  it("returns null when one route exists", () => {
    expect(
      firstBootHint({
        routes: [{ name: "spoke-live", baseURL: "http://127.0.0.1:8080/v1" }],
        overrides: {},
      }),
    ).toBeNull();
  });

  it("returns null when multiple routes exist", () => {
    expect(
      firstBootHint({
        routes: [
          { name: "a", baseURL: "http://127.0.0.1:8080/v1" },
          { name: "b", baseURL: "http://127.0.0.1:11434/v1" },
        ],
        overrides: {},
      }),
    ).toBeNull();
  });

  it("returns the hint when the only route fails lenient extraction (no serviceable route)", () => {
    // routesOf keeps entries with a non-empty name AND baseURL; anything
    // else is skipped — the dormant state is about serviceable routes.
    expect(
      firstBootHint({
        routes: [{ baseURL: "http://127.0.0.1:8080/v1" }],
        overrides: {},
      }),
    ).not.toBeNull();
    expect(
      firstBootHint({
        routes: [{ name: "spoke" }],
        overrides: {},
      }),
    ).not.toBeNull();
  });

  it("returns the hint for a malformed section (lenient, never throws)", () => {
    expect(firstBootHint("not an object")).not.toBeNull();
    expect(firstBootHint([1, 2, 3])).not.toBeNull();
    expect(firstBootHint({ routes: "nope" })).not.toBeNull();
  });

  it("keeps the hint a single line (no newlines)", () => {
    const hint = firstBootHint({ routes: [], overrides: {} });
    expect(hint).not.toBeNull();
    expect(hint).not.toContain("\n");
  });

  it("points at both fix locations (settings.yaml section, the Plugins-page card)", () => {
    const hint = firstBootHint(undefined) as string;
    expect(hint).toContain("`modelspoke:` section");
    expect(hint).toContain("settings.yaml");
    expect(hint).toContain("Modelspoke");
    expect(hint).toContain("Plugins settings");
  });

  it("speaks providers, not routes (the yaml key stays routes:)", () => {
    const hint = firstBootHint(undefined) as string;
    expect(hint).toContain("0 providers");
    expect(hint).not.toContain("0 routes");
    expect(hint).toContain("one entry under `routes:`");
  });

  it("carries the existing log-line style (modelspoke: prefix)", () => {
    const hint = firstBootHint({ routes: [], overrides: {} }) as string;
    expect(hint.startsWith("modelspoke: ")).toBe(true);
  });
});
