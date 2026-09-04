/**
 * URL normalization for modelspoke routes.
 *
 * Ported/reduced from pi-llama-swap `lib/url.ts` (pi-llama-swap-port.md §1.2, in jj history). Kept:
 * `normalizeBasePath` (a route base path always ends in `/v1`). Dropped:
 * `defaultConfig`/`mergeConfig` (modelspoke routes come from the `modelspoke:`
 * settings namespace), `buildServerOrigin`/`parseUrlArg`/`parsePortArg`
 * (llama-swap root endpoints and command-arg parsing — the `/running` path is
 * OUT of scope for the port: it leaks the live HF token).
 *
 * Runtime surface: global `URL` only.
 */

const DEFAULT_BASE_PATH = "/v1";

/**
 * Normalizes a URL pathname into an OpenAI API base path ending in `/v1`.
 * @returns Normalized base path (leading slash, no trailing slash).
 */
export function normalizeBasePath(pathname: string): string {
  if (!pathname || pathname === "/") {
    return DEFAULT_BASE_PATH;
  }
  const trimmed = pathname.replace(/\/$/, "");
  if (trimmed.endsWith("/v1")) {
    return trimmed;
  }
  return `${trimmed}/v1`;
}

/**
 * Normalizes a user-configured route `baseURL`: parses it, keeps scheme/host/
 * port, and ensures the path ends in `/v1` (appending when absent).
 * @param baseURL - Route base URL (e.g. `http://127.0.0.1:8080/v1` or
 *   `http://127.0.0.1:8080`).
 * @returns Normalized base URL without trailing slash.
 * @throws {Error} When the URL is not parseable or has no host.
 */
export function normalizeRouteBaseUrl(baseURL: string): string {
  let url: URL;
  try {
    url = new URL(baseURL);
  } catch {
    throw new Error(`Invalid route baseURL: ${baseURL}`);
  }
  if (!url.hostname) {
    throw new Error(`Invalid route baseURL (no host): ${baseURL}`);
  }
  url.pathname = normalizeBasePath(url.pathname);
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}
