/**
 * Pure import-logic helpers for the dsh onboarding v2 step — the
 * custom-provider → modelspoke-route import.
 *
 * Framework-neutral on purpose: NO react import, no DOM, no node-only deps.
 * The client bundle (src/dsh/client.tsx) imports these and tsdown inlines the
 * module (the bundle's runtime requires stay react + react/jsx-runtime), and
 * the unit tests (test/import.test.ts) import the module directly in a node
 * environment. This is also why the helpers live in their own module rather
 * than at the top of client.tsx: the client file cannot be imported from a
 * test (its top-level react import is not installed in this repo's
 * node_modules — the bundle's require is answered by the web shell's module
 * table at runtime, not by the repo).
 */

/**
 * The client-side DEFAULT route name for an imported provider (owner rule
 * 2026-08-24: make shadowing opt-in, not the default — source `llama-swap`
 * imports as `modelspoke-llama-swap`). The name stays EDITABLE in the form;
 * the server NEVER applies a prefix (`provision` takes the name as given).
 */
export function defaultImportRouteName(sourceProviderName: string): string {
  return `modelspoke-${sourceProviderName}`;
}

/**
 * The live collision check behind the form's non-blocking warning: does
 * the chosen route name keep another provider serving under the same name?
 * The registrable set is the server-computed `providerNames` (all
 * `llm-pi-ai` provider keys — local or not — ∪ existing modelspoke route
 * names ∪ the built-in pi-ai catalog ids, src/dsh/channel.ts) UNIONED with
 * the CURRENT route names re-read from the live settings snapshot (fresher
 * than the probe-time facts — a route added in another tab after the probe
 * still warns). Returns the colliding name, or null when the name is clear.
 * An empty (or blank) name reports no collision: the empty-name case is a
 * validation error, not a shadowing warning.
 */
export function providerCollision(
  name: string,
  providerNames: readonly string[],
  routeNames: readonly string[],
): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return null;
  for (const candidate of providerNames) {
    if (candidate === trimmed) return candidate;
  }
  for (const candidate of routeNames) {
    if (candidate === trimmed) return candidate;
  }
  return null;
}
