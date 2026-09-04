/**
 * HTTP client for OpenAI-compatible `GET /v1/models`.
 *
 * Ported from pi-llama-swap `lib/client.ts` (pi-llama-swap-port.md §1.1, in jj history, verbatim),
 * with the llama-swap naming generalized to "server" (porting note).
 *
 * Port exclusions (binding): NO `/running` fetch, NO `cmd`
 * parsing — those are llama-swap-only paths, and `/running` on
 * 0.0.0.0:8080 leaks the live HF token unauthenticated.
 *
 * Runtime surface: global `fetch` (Node ≥ 18), global `Response`,
 * `AbortSignal`. Dependency-free.
 */

import type { OpenAIModelEntry, OpenAIModelsListResponse } from "./types.js";

/** Error thrown when a model-server request fails. */
export class ModelspokeClientError extends Error {
  /** HTTP status when the server responded with an error. */
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "ModelspokeClientError";
    this.status = status;
  }
}

/**
 * Fetches the model list from an OpenAI-compatible server
 * (`GET {baseUrl}/models`).
 *
 * No built-in timeout: a hung request lives as long as the server does
 * unless the caller passes an `AbortSignal` (the dsh host always does — the
 * route's signal aborts the fetch).
 *
 * @param baseUrl - OpenAI API base URL ending in `/v1`.
 * @returns Array of model entries from the `data` field.
 * @throws {ModelspokeClientError} On network or non-2xx responses.
 */
export async function fetchModels(
  baseUrl: string,
  apiKey?: string,
  signal?: AbortSignal,
): Promise<OpenAIModelEntry[]> {
  const url = `${baseUrl.replace(/\/$/, "")}/models`;
  const headers: Record<string, string> = {
    Accept: "application/json",
  };

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  let response: Response;
  try {
    response = await fetch(url, { method: "GET", headers, signal });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ModelspokeClientError(`Cannot reach server at ${url}: ${msg}`);
  }

  if (!response.ok) {
    const body = await readCappedBody(response, ERROR_BODY_CAP);
    const hint = response.status === 401 ? " Check the route's apiKeyEnv." : "";
    throw new ModelspokeClientError(
      `Server returned ${response.status} ${response.statusText}${body ? `: ${body}` : ""}${hint}`,
      response.status,
    );
  }

  let payload: OpenAIModelsListResponse;
  try {
    payload = (await response.json()) as OpenAIModelsListResponse;
  } catch {
    throw new ModelspokeClientError("Invalid JSON from server /v1/models");
  }

  if (!Array.isArray(payload.data)) {
    throw new ModelspokeClientError("Unexpected /v1/models response: missing data array");
  }

  return payload.data;
}

/** How much of an error body to read into the error message. */
const ERROR_BODY_CAP = 512;

/**
 * Read up to `cap` characters of a response body WITHOUT buffering the whole
 * thing (a broken server can return a huge error body; the previous
 * `response.text()` read it all before slicing).
 */
async function readCappedBody(response: Response, cap: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let out = "";
  let received = 0;
  try {
    while (received < cap) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
      received += value.length;
    }
    if (received >= cap) void reader.cancel().catch(() => {});
  } catch {
    // A read failure just shortens the error hint.
  }
  return out.slice(0, cap);
}
