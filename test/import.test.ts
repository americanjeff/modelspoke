/**
 * Onboarding-v2 pure helpers (src/dsh/import.js) — the client-side
 * import logic that is testable without a DOM: the name default (shadowing
 * is opt-in, not the default) and the live collision check behind the
 * form's non-blocking warning.
 *
 * The helpers live in a framework-neutral module (no react import) precisely
 * so this file can import them: client.tsx itself cannot be imported here
 * (its top-level react import is answered by the web shell's module table at
 * bundle runtime, not by this repo's node_modules). The onboarding step's
 * DOM behavior (offer layering, pick list, warning render, provision call)
 * is covered by the testenv CDP E2E gates (cdp-b7.mjs, Gates A–C).
 */

import { describe, expect, it } from "vitest";
import { defaultImportRouteName, providerCollision } from "../src/dsh/import.js";

describe("defaultImportRouteName", () => {
  it("prefixes the source provider name with modelspoke- (the shadowing-opt-in default)", () => {
    expect(defaultImportRouteName("llama-swap")).toBe("modelspoke-llama-swap");
  });

  it("works for an arbitrary custom provider key", () => {
    expect(defaultImportRouteName("demo-local")).toBe("modelspoke-demo-local");
  });

  it("is a pure prefix — never sanitizes (the name stays editable; the server validates)", () => {
    expect(defaultImportRouteName("deepseek")).toBe("modelspoke-deepseek");
  });
});

describe("providerCollision", () => {
  const providerNames = ["ollama", "llama-swap", "deepseek", "openrouter"];

  it("reports no collision for a clear name", () => {
    expect(providerCollision("modelspoke-demo-local", providerNames, ["spoke-live"])).toBeNull();
  });

  it("collides with a registrable provider name (pi-ai key or built-in)", () => {
    expect(providerCollision("ollama", providerNames, [])).toBe("ollama");
    expect(providerCollision("deepseek", providerNames, [])).toBe("deepseek");
  });

  it("collides with a CURRENT route name absent from the probe-time set", () => {
    expect(providerCollision("spoke-live", [], ["spoke-live"])).toBe("spoke-live");
  });

  it("trims the typed name before checking (the form trims before sending)", () => {
    expect(providerCollision("  ollama  ", providerNames, [])).toBe("ollama");
  });

  it("reports no collision for an empty or blank name (a validation error, not a warning)", () => {
    expect(providerCollision("", providerNames, ["a"])).toBeNull();
    expect(providerCollision("   ", providerNames, ["a"])).toBeNull();
  });

  it("is an exact match — no substring or case folding", () => {
    expect(providerCollision("ollama-extra", providerNames, [])).toBeNull();
    expect(providerCollision("OLLAMA", providerNames, [])).toBeNull();
  });
});
