/**
 * Request-header assembly: deployment/route headers minus any
 * case-insensitive collision with the harness attribution headers, then
 * `attributionHeaders()` spread LAST so a route's headers can never
 * override attribution.
 *
 * This is the reference `requestHeaders(profile.headers)` pattern from
 * `dsh-llm-pi-ai` (docs/dsh-plugin-guidance.md §1.2): the merged object is
 * passed as the per-request `headers` option to pi-ai's `streamSimple`, where
 * it becomes the OpenAI SDK client's `defaultHeaders` (attached to every
 * request) and is the layer that wins over `Model.headers` and provider
 * defaults. `attributionHeaders()` currently contributes exactly one
 * lowercase header — `user-agent` — but the pattern future-proofs extra
 * attribution headers.
 *
 * modelspoke routes do not expose a per-route `headers` setting
 * (`ModelspokeRoute` carries none); `routeHeaders` exists so the precedence
 * contract is testable and a future headers field drops in unchanged.
 */

import { attributionHeaders } from "@deepseek-ai/dsh-llm";

/**
 * Merge route/deployment headers under the attribution headers.
 *
 * @param routeHeaders - Optional headers a route configured (none today).
 *   Entries whose name collides case-insensitively with an attribution
 *   header are dropped — attribution always wins.
 * @returns The per-request header object: route headers (collision-free)
 *   then `attributionHeaders()`.
 */
export function requestHeaders(routeHeaders?: Record<string, string>): Record<string, string> {
  const attribution = attributionHeaders();
  const reserved = new Set(Object.keys(attribution).map((name) => name.toLowerCase()));
  return {
    ...Object.fromEntries(
      Object.entries(routeHeaders ?? {}).filter(([name]) => !reserved.has(name.toLowerCase())),
    ),
    ...attribution,
  };
}
